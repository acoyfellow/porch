import { DurableObject } from 'cloudflare:workers';
import { parseRange } from './range';
import { Schema } from 'effect';
import { AllowedKey, BrowserInput, DaemonToRelay, MAX_SEND_LENGTH, type PanelFrame, PhoneToRelay, type RelayToDaemon, type RelayToPhone, type Sidebar } from '../shared/protocol';

const DAEMON_TAG = 'daemon';
const PHONE_TAG = 'phone';
const PUBLISHERS_KEY = 'rtc-publishers';
const SIDEBAR_KEY = 'sidebar';
const MACHINE_KEY = 'machine';
const SEND_TIMEOUT_MS = 10_000;
const HTTP_WATCH_MS = 120_000;

type PhoneAttachment = { readonly role: 'phone'; readonly open: string | null; readonly viewport?: { readonly width: number; readonly height: number }; readonly readOnly?: boolean };

type MachineRecord = { readonly machine: string; readonly seenAt: number };

const MEDIA_TIMEOUT_MS = 15_000;
const ACTION_SETTLE_MS = 400;

type MediaChunk = Extract<DaemonToRelay, { readonly _tag: 'MediaChunk' }>;

const decodeDaemon = Schema.decodeUnknownOption(Schema.fromJsonString(DaemonToRelay));
const decodePhone = Schema.decodeUnknownOption(Schema.fromJsonString(PhoneToRelay));

const phoneViewport = (socket: WebSocket) => (socket.deserializeAttachment() as PhoneAttachment | null)?.viewport ?? null;

const phoneOpen = (socket: WebSocket): string | null => {
  const attachment = socket.deserializeAttachment() as PhoneAttachment | null;

  return attachment?.open ?? null;
};

export class Relay extends DurableObject {
  private readonly pendingSends = new Map<string, (result: { ok: boolean; reason: string | null }) => void>();
  private readonly frames = new Map<string, PanelFrame>();
  private readonly httpWatch = new Map<string, number>();
  private readonly frameTimes = new Map<string, number>();
  private readonly actionTimes = new Map<string, number>();
  private closing: WebSocket | null = null;
  private async rtcOwner(sessionId: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(`rtc-owner:${sessionId}`);
  }

  private async publisherMap(): Promise<Map<string, { readonly sessionId: string; readonly trackName: string; readonly at: number }>> {
    return new Map(Object.entries((await this.ctx.storage.get<Record<string, { sessionId: string; trackName: string; at: number }>>(PUBLISHERS_KEY)) ?? {}));
  }

  private async savePublishers(publishers: Map<string, { readonly sessionId: string; readonly trackName: string; readonly at: number }>): Promise<void> {
    const tracks = Object.fromEntries(publishers);
    await this.ctx.storage.put(PUBLISHERS_KEY, tracks);
    this.broadcast({ _tag: 'Tracks', tracks });
  }

  private async rtcClaim(request: Request): Promise<Response> {
    const body = (await request.json()) as { sessionId?: string; owner?: string };

    if (!body.sessionId || !body.owner) return new Response('bad request', { status: 400 });
    await this.ctx.storage.put(`rtc-owner:${body.sessionId}`, body.owner);

    return Response.json({ ok: true });
  }

  private async rtcPublish(request: Request): Promise<Response> {
    const body = (await request.json()) as { surfaceId?: string; sessionId?: string; trackName?: string };

    if (!body.surfaceId || !body.sessionId || !body.trackName) return new Response('bad request', { status: 400 });
    const publishers = await this.publisherMap();
    publishers.set(body.surfaceId, { sessionId: body.sessionId, trackName: body.trackName, at: Date.now() });
    await this.ctx.storage.put(`rtc-owner:${body.sessionId}`, 'producer');
    await this.savePublishers(publishers);

    return Response.json({ ok: true });
  }

  private async rtcUnpublish(request: Request): Promise<Response> {
    const body = (await request.json()) as { sessionId?: string };

    const publishers = await this.publisherMap();

    for (const [surfaceId, each] of publishers) if (each.sessionId === body.sessionId) publishers.delete(surfaceId);
    await this.savePublishers(publishers);

    return Response.json({ ok: true });
  }

  private markAction(surfaceId: string) {
    this.actionTimes.set(surfaceId, Date.now() + ACTION_SETTLE_MS);
  }
  private readonly pendingMedia = new Map<string, (chunk: MediaChunk | null) => void>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/daemon') return this.accept(DAEMON_TAG, null);

    if (url.pathname === '/phone') return this.accept(PHONE_TAG, { role: 'phone', open: null });

    if (url.pathname === '/phone-watch') return this.accept(PHONE_TAG, { role: 'phone', open: null, readOnly: true });

    if (url.pathname === '/sidebar') return Response.json((await this.ctx.storage.get<Sidebar>(SIDEBAR_KEY)) ?? null);

    if (url.pathname === '/machine') return Response.json(this.machineState(await this.ctx.storage.get<MachineRecord>(MACHINE_KEY)));

    if (url.pathname === '/send' && request.method === 'POST') return this.sendFromHttp(request);

    if (url.pathname === '/frame') return this.frameFromHttp(url);

    if (url.pathname === '/key' && request.method === 'POST') return this.keyFromHttp(request);

    if (url.pathname === '/browser' && request.method === 'POST') return this.browserFromHttp(request);

    if (url.pathname === '/media') return this.mediaFromHttp(request, url);

    if (url.pathname === '/rtc/claim' && request.method === 'POST') return this.rtcClaim(request);

    if (url.pathname === '/rtc/owns') return Response.json({ owns: (await this.rtcOwner(url.searchParams.get('session') ?? '')) === url.searchParams.get('owner') });

    if (url.pathname === '/rtc/producers') return Response.json({ sessions: [...(await this.publisherMap()).values()].map((each) => each.sessionId) });

    if (url.pathname === '/rtc/publish' && request.method === 'POST') return this.rtcPublish(request);

    if (url.pathname === '/rtc/unpublish' && request.method === 'POST') return this.rtcUnpublish(request);

    if (url.pathname === '/focus' && request.method === 'POST') {
      const body = (await request.json()) as { surfaceId?: string };

      return body.surfaceId && this.toDaemon({ _tag: 'Focus', surfaceId: body.surfaceId }) ? Response.json({ ok: true }) : Response.json({ ok: false }, { status: 503 });
    }

    if (url.pathname === '/rtc/tracks') return Response.json({ tracks: Object.fromEntries(await this.publisherMap()) });

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
    this.toPhone(socket, { _tag: 'Tracks', tracks: Object.fromEntries(await this.publisherMap()) });
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

  private livePhones(): ReadonlyArray<WebSocket> {
    return this.ctx.getWebSockets(PHONE_TAG).filter((phone) => phone !== this.closing && phone.readyState === WebSocket.READY_STATE_OPEN);
  }

  private watched(extra: ReadonlyArray<string> = []): ReadonlyArray<string> {
    const open = this.livePhones().flatMap((phone) => {
      const surface = phoneOpen(phone);

      return surface ? [surface] : [];
    });

    const now = Date.now();
    const polled = [...this.httpWatch].flatMap(([surface, until]) => (until > now ? [surface] : []));

    return [...new Set([...open, ...polled, ...extra])];
  }

  private rewatch(extra: ReadonlyArray<string> = [], refresh: ReadonlyArray<string> = []) {
    const viewports = this.livePhones().flatMap((phone) => {
      const surfaceId = phoneOpen(phone);
      const viewport = phoneViewport(phone);

      return surfaceId && viewport ? [{ surfaceId, width: viewport.width, height: viewport.height }] : [];
    });
    this.toDaemon({ _tag: 'Watch', surfaceIds: [...this.watched(extra)], refresh: [...refresh], viewports });
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
        this.frameTimes.set(message.frame.surfaceId, Date.now());
        this.broadcast({ _tag: 'Frame', frame: message.frame }, message.frame.surfaceId);

        return;
      case 'MediaChunk':
        this.pendingMedia.get(message.requestId)?.(message);
        this.pendingMedia.delete(message.requestId);

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
      const changed = phoneOpen(socket) !== message.surfaceId;
      const readOnly = (socket.deserializeAttachment() as PhoneAttachment | null)?.readOnly === true;
      socket.serializeAttachment({ role: 'phone', open: message.surfaceId, ...(message.viewport ? { viewport: message.viewport } : {}), ...(readOnly ? { readOnly } : {}) } satisfies PhoneAttachment);
      this.rewatch([], changed && message.surfaceId ? [message.surfaceId] : []);
      const cached = message.surfaceId ? this.frames.get(message.surfaceId) : undefined;

      if (cached) this.toPhone(socket, { _tag: 'Frame', frame: cached });

      return;
    }

    if ((socket.deserializeAttachment() as PhoneAttachment | null)?.readOnly) return;

    if (message._tag === 'Browser') {
      this.toDaemon({ _tag: 'Browser', surfaceId: message.surfaceId, input: message.input });

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

    this.markAction(body.surfaceId);

    if (!this.toDaemon({ _tag: 'Send', requestId, surfaceId: body.surfaceId, text: body.text, submit: body.submit ?? true })) return Response.json({ ok: false, reason: 'your Mac is offline' }, { status: 503 });

    return Response.json(await result);
  }

  private async keyFromHttp(request: Request): Promise<Response> {
    const body = (await request.json()) as { surfaceId?: string; key?: string };

    const key = Schema.decodeUnknownOption(AllowedKey)(body.key);

    if (typeof body.surfaceId !== 'string' || key._tag === 'None') return Response.json({ ok: false, reason: 'bad request' }, { status: 400 });

    this.markAction(body.surfaceId);

    return this.toDaemon({ _tag: 'Key', surfaceId: body.surfaceId, key: key.value }) ? Response.json({ ok: true }) : Response.json({ ok: false, reason: 'your Mac is offline' }, { status: 503 });
  }

  private async browserFromHttp(request: Request): Promise<Response> {
    const body = (await request.json()) as { surfaceId?: unknown; input?: unknown };
    const input = Schema.decodeUnknownOption(BrowserInput)(body.input);

    if (typeof body.surfaceId !== 'string' || input._tag === 'None') return Response.json({ ok: false, reason: 'bad request' }, { status: 400 });

    this.markAction(body.surfaceId);

    return this.toDaemon({ _tag: 'Browser', surfaceId: body.surfaceId, input: input.value }) ? Response.json({ ok: true }) : Response.json({ ok: false, reason: 'your Mac is offline' }, { status: 503 });
  }

  private async mediaFromHttp(request: Request, url: URL): Promise<Response> {
    const surfaceId = url.searchParams.get('surface');

    if (!surfaceId) return new Response('surface is required', { status: 400 });
    const range = parseRange(request.headers.get('range'));
    const requestId = crypto.randomUUID();
    const chunk = new Promise<MediaChunk | null>((resolve) => {
      this.pendingMedia.set(requestId, resolve);
      setTimeout(() => resolve(null), MEDIA_TIMEOUT_MS);
    });

    if (!this.toDaemon({ _tag: 'MediaRequest', requestId, surfaceId, start: range?.start ?? 0, end: range?.end ?? null })) return new Response('your Mac is offline', { status: 503 });
    const result = await chunk;
    this.pendingMedia.delete(requestId);

    if (!result || !result.ok) return new Response('file not available', { status: 404 });
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    const headers = { 'content-type': result.mime, 'accept-ranges': 'bytes', 'content-length': String(bytes.length), 'cache-control': 'private, max-age=60' };

    if (!range && result.end === result.total - 1) return new Response(bytes, { status: 200, headers });

    return new Response(bytes, { status: 206, headers: { ...headers, 'content-range': `bytes ${result.start}-${result.end}/${result.total}` } });
  }

  private async frameFromHttp(url: URL): Promise<Response> {
    const surfaceId = url.searchParams.get('surface');

    if (!surfaceId) return Response.json({ frame: null }, { status: 400 });
    const wait = Number(url.searchParams.get('wait') ?? '0');
    const requested = Number(url.searchParams.get('after') ?? '0');
    const newerThan = url.searchParams.get('sinceAction') ? Math.max(requested, this.actionTimes.get(surfaceId) ?? 0) : requested;

    this.httpWatch.set(surfaceId, Date.now() + HTTP_WATCH_MS);
    this.rewatch([], newerThan > 0 ? [surfaceId] : []);
    const deadline = Date.now() + Math.min(wait, 15_000);
    const fresh = () => (this.frameTimes.get(surfaceId) ?? 0) > newerThan;

    while (!fresh() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));

    return Response.json({ frame: this.frames.get(surfaceId) ?? null });
  }

  async webSocketClose(socket: WebSocket) {
    if (this.ctx.getTags(socket).includes(DAEMON_TAG)) {
      const record = await this.ctx.storage.get<MachineRecord>(MACHINE_KEY);
      this.broadcast({ _tag: 'Machine', ...this.machineState(record), online: false });

      return;
    }
    this.closing = socket;

    try {
      this.rewatch();
    } finally {
      this.closing = null;
    }
  }
}
