import { DurableObject } from 'cloudflare:workers';
import { Schema } from 'effect';
import { DaemonToRelay, MAX_SEND_LENGTH, type PanelFrame, PhoneToRelay, type RelayToDaemon, type RelayToPhone, type Sidebar } from '../shared/protocol';

const DAEMON_TAG = 'daemon';
const PHONE_TAG = 'phone';
const SIDEBAR_KEY = 'sidebar';
const MACHINE_KEY = 'machine';
const SEND_TIMEOUT_MS = 10_000;
const HTTP_WATCH_MS = 120_000;

type PhoneAttachment = { readonly role: 'phone'; readonly open: string | null };

type MachineRecord = { readonly machine: string; readonly seenAt: number };

const decodeDaemon = Schema.decodeUnknownOption(Schema.fromJsonString(DaemonToRelay));
const decodePhone = Schema.decodeUnknownOption(Schema.fromJsonString(PhoneToRelay));

const phoneOpen = (socket: WebSocket): string | null => {
  const attachment = socket.deserializeAttachment() as PhoneAttachment | null;

  return attachment?.open ?? null;
};

export class Relay extends DurableObject {
  private readonly pendingSends = new Map<string, (result: { ok: boolean; reason: string | null }) => void>();
  private readonly frames = new Map<string, PanelFrame>();
  private readonly httpWatch = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/daemon') return this.accept(DAEMON_TAG, null);

    if (url.pathname === '/phone') return this.accept(PHONE_TAG, { role: 'phone', open: null });

    if (url.pathname === '/sidebar') return Response.json((await this.ctx.storage.get<Sidebar>(SIDEBAR_KEY)) ?? null);

    if (url.pathname === '/machine') return Response.json(this.machineState(await this.ctx.storage.get<MachineRecord>(MACHINE_KEY)));

    if (url.pathname === '/send' && request.method === 'POST') return this.sendFromHttp(request);

    if (url.pathname === '/frame') return this.frameFromHttp(url);

    if (url.pathname === '/key' && request.method === 'POST') return this.keyFromHttp(request);

    return new Response('not found', { status: 404 });
  }

  private accept(tag: string, attachment: PhoneAttachment | null): Response {
    if (tag === DAEMON_TAG) for (const old of this.ctx.getWebSockets(DAEMON_TAG)) old.close(4000, 'replaced');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [tag]);

    if (attachment) server.serializeAttachment(attachment);

    if (tag === PHONE_TAG) void this.greetPhone(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  private machineState(record: MachineRecord | undefined) {
    return { online: this.ctx.getWebSockets(DAEMON_TAG).length > 0, machine: record?.machine ?? null, seenAt: record?.seenAt ?? null };
  }

  private async greetPhone(socket: WebSocket) {
    const record = await this.ctx.storage.get<MachineRecord>(MACHINE_KEY);
    const sidebar = await this.ctx.storage.get<Sidebar>(SIDEBAR_KEY);
    this.toPhone(socket, { _tag: 'Machine', ...this.machineState(record) });

    if (sidebar) this.toPhone(socket, { _tag: 'Sidebar', sidebar });
  }

  private toPhone(socket: WebSocket, message: RelayToPhone) {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      return;
    }
  }

  private toDaemon(message: RelayToDaemon): boolean {
    const [daemon] = this.ctx.getWebSockets(DAEMON_TAG);

    if (!daemon) return false;
    daemon.send(JSON.stringify(message));

    return true;
  }

  private broadcast(message: RelayToPhone, onlySurface: string | null = null) {
    for (const phone of this.ctx.getWebSockets(PHONE_TAG)) if (onlySurface === null || phoneOpen(phone) === onlySurface) this.toPhone(phone, message);
  }

  private watched(extra: ReadonlyArray<string> = []): ReadonlyArray<string> {
    const open = this.ctx.getWebSockets(PHONE_TAG).flatMap((phone) => {
      const surface = phoneOpen(phone);

      return surface ? [surface] : [];
    });

    const now = Date.now();
    const polled = [...this.httpWatch].flatMap(([surface, until]) => (until > now ? [surface] : []));

    return [...new Set([...open, ...polled, ...extra])];
  }

  private rewatch(extra: ReadonlyArray<string> = []) {
    this.toDaemon({ _tag: 'Watch', surfaceIds: [...this.watched(extra)] });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string') return;

    if (this.ctx.getTags(socket).includes(DAEMON_TAG)) return this.fromDaemon(raw);

    return this.fromPhone(socket, raw);
  }

  private async fromDaemon(raw: string) {
    const decoded = decodeDaemon(raw);

    if (decoded._tag === 'None') return;
    const message = decoded.value;

    switch (message._tag) {
      case 'Hello': {
        const record = { machine: message.machine, seenAt: Date.now() };
        await this.ctx.storage.put(MACHINE_KEY, record);
        this.broadcast({ _tag: 'Machine', ...this.machineState(record) });
        this.rewatch();

        return;
      }
      case 'Sidebar':
        await this.ctx.storage.put(SIDEBAR_KEY, message.sidebar);
        this.broadcast({ _tag: 'Sidebar', sidebar: message.sidebar });

        return;
      case 'Frame':
        this.frames.set(message.frame.surfaceId, message.frame);
        this.broadcast({ _tag: 'Frame', frame: message.frame }, message.frame.surfaceId);

        return;
      case 'Sent':
        this.pendingSends.get(message.requestId)?.({ ok: message.ok, reason: message.reason });
        this.pendingSends.delete(message.requestId);
        this.broadcast({ _tag: 'Sent', requestId: message.requestId, ok: message.ok, reason: message.reason });

        return;
    }
  }

  private fromPhone(socket: WebSocket, raw: string) {
    const decoded = decodePhone(raw);

    if (decoded._tag === 'None') return;
    const message = decoded.value;

    if (message._tag === 'Open') {
      socket.serializeAttachment({ role: 'phone', open: message.surfaceId } satisfies PhoneAttachment);
      this.rewatch();
      const cached = message.surfaceId ? this.frames.get(message.surfaceId) : undefined;

      if (cached) this.toPhone(socket, { _tag: 'Frame', frame: cached });

      return;
    }

    if (message.text.length > MAX_SEND_LENGTH) return this.toPhone(socket, { _tag: 'Sent', requestId: message.requestId, ok: false, reason: 'message too long' });

    if (!this.toDaemon({ _tag: 'Send', requestId: message.requestId, surfaceId: message.surfaceId, text: message.text, submit: message.submit })) this.toPhone(socket, { _tag: 'Sent', requestId: message.requestId, ok: false, reason: 'your Mac is offline' });
  }

  private async sendFromHttp(request: Request): Promise<Response> {
    const body = (await request.json()) as { surfaceId?: string; text?: string; submit?: boolean };

    if (typeof body.surfaceId !== 'string' || typeof body.text !== 'string' || body.text.length > MAX_SEND_LENGTH) return Response.json({ ok: false, reason: 'bad request' }, { status: 400 });
    const requestId = crypto.randomUUID();
    const result = new Promise<{ ok: boolean; reason: string | null }>((resolve) => {
      this.pendingSends.set(requestId, resolve);
      setTimeout(() => resolve({ ok: false, reason: 'timed out waiting for your Mac' }), SEND_TIMEOUT_MS);
    });

    if (!this.toDaemon({ _tag: 'Send', requestId, surfaceId: body.surfaceId, text: body.text, submit: body.submit ?? true })) return Response.json({ ok: false, reason: 'your Mac is offline' }, { status: 503 });

    return Response.json(await result);
  }

  private async keyFromHttp(request: Request): Promise<Response> {
    const body = (await request.json()) as { surfaceId?: string; key?: string };

    if (typeof body.surfaceId !== 'string' || body.key !== 'Escape') return Response.json({ ok: false, reason: 'bad request' }, { status: 400 });

    return this.toDaemon({ _tag: 'Key', surfaceId: body.surfaceId, key: body.key }) ? Response.json({ ok: true }) : Response.json({ ok: false, reason: 'your Mac is offline' }, { status: 503 });
  }

  private async frameFromHttp(url: URL): Promise<Response> {
    const surfaceId = url.searchParams.get('surface');

    if (!surfaceId) return Response.json({ frame: null }, { status: 400 });
    const after = Number(url.searchParams.get('wait') ?? '0');

    const known = this.httpWatch.has(surfaceId);
    this.httpWatch.set(surfaceId, Date.now() + HTTP_WATCH_MS);

    if (!known) this.rewatch();
    const deadline = Date.now() + Math.min(after, 15_000);

    while (!this.frames.has(surfaceId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));

    return Response.json({ frame: this.frames.get(surfaceId) ?? null });
  }

  async webSocketClose(socket: WebSocket) {
    if (this.ctx.getTags(socket).includes(DAEMON_TAG)) {
      const record = await this.ctx.storage.get<MachineRecord>(MACHINE_KEY);
      this.broadcast({ _tag: 'Machine', ...this.machineState(record), online: false });

      return;
    }
    this.rewatch();
  }
}
