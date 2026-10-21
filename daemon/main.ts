import { hostname } from 'node:os';
import { Schema } from 'effect';
import { type DaemonToRelay, type PanelFrame, type PiEntry, RelayToDaemon, type Sidebar } from '../shared/protocol';
import { applyInput, captureScreen } from './browser';
import { readScreen, readSidebar, sendKey, sendText } from './cmux';
import { loadConfig } from './config';
import { openTail, piLinks, readNew, sessionFile, type Tail } from './pi';

const SIDEBAR_EVERY_MS = 2000;
const PANEL_EVERY_MS = 700;
const TEXT_LINES = 120;
const MAX_BACKOFF_MS = 30_000;
const VERSION = '0.0.1';

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(RelayToDaemon));

type Watch = { readonly surfaceId: string; kind: 'pi' | 'text' | 'screen'; tail: Tail | null; sessionId: string | null; lastText: string; capturing: boolean; stopped: boolean };

const config = await loadConfig();
const watches = new Map<string, Watch>();
let socket: WebSocket | null = null;
let lastSidebar = '';
let sidebar: Sidebar | null = null;
let backoff = 1000;

const log = (...parts: ReadonlyArray<unknown>) => console.log(new Date().toISOString(), ...parts);

const send = (message: DaemonToRelay) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
};

const surfaceOf = (surfaceId: string) => sidebar?.workspaces.flatMap((workspace) => workspace.surfaces).find((surface) => surface.id === surfaceId) ?? null;

const frame = (value: PanelFrame) => send({ _tag: 'Frame', frame: value });

const startWatch = async (surfaceId: string): Promise<Watch> => {
  const surface = surfaceOf(surfaceId);
  const watch: Watch = { surfaceId, kind: surface?.pi ? 'pi' : surface?.kind === 'browser' ? 'screen' : 'text', tail: null, sessionId: surface?.pi?.sessionId ?? null, lastText: '', capturing: false, stopped: false };

  if (watch.kind === 'pi' && watch.sessionId) {
    const path = await sessionFile(watch.sessionId);

    if (path) {
      const opened = await openTail(path);
      watch.tail = opened.tail;
      frame({ _tag: 'Pi', surfaceId, sessionId: watch.sessionId, status: surface?.pi?.status ?? 'unknown', entries: [...opened.entries], reset: true });

      return watch;
    }
    watch.kind = 'text';
  }

  return watch;
};

const SCREEN_IDLE_MS = 150;

const streamScreen = async (watch: Watch) => {
  if (watch.capturing) return;
  watch.capturing = true;

  try {
    while (!watch.stopped && socket?.readyState === WebSocket.OPEN) {
      const screen = await captureScreen(watch.surfaceId).catch((error) => {
        log('screen failed', watch.surfaceId, error instanceof Error ? error.message.slice(0, 160) : error);

        return null;
      });

      if (screen && screen.digest !== watch.lastText) {
        watch.lastText = screen.digest;
        frame({ _tag: 'Screen', surfaceId: watch.surfaceId, image: screen.image, width: screen.width, height: screen.height, url: screen.url, title: screen.title, at: Date.now() });
      }
      await Bun.sleep(screen ? SCREEN_IDLE_MS : 2000);
    }
  } finally {
    watch.capturing = false;
  }
};

const pollWatch = async (watch: Watch) => {
  const surface = surfaceOf(watch.surfaceId);

  if (sidebar && !surface) return frame({ _tag: 'Gone', surfaceId: watch.surfaceId, reason: 'this panel was closed on your Mac' });

  if (watch.kind === 'text' && surface?.kind === 'browser') watch.kind = 'screen';

  if (watch.kind === 'screen') {
    void streamScreen(watch);

    return;
  }

  if (watch.kind === 'pi' && watch.tail) {
    const entries: ReadonlyArray<PiEntry> = await readNew(watch.tail);

    if (entries.length > 0) frame({ _tag: 'Pi', surfaceId: watch.surfaceId, sessionId: watch.sessionId ?? '', status: surface?.pi?.status ?? 'unknown', entries: [...entries], reset: false });

    return;
  }
  const text = await readScreen(watch.surfaceId, TEXT_LINES).catch(() => null);

  if (text === null || text === watch.lastText) return;
  watch.lastText = text;
  frame({ _tag: 'Text', surfaceId: watch.surfaceId, text });
};

const setWatches = async (surfaceIds: ReadonlyArray<string>, refresh: ReadonlyArray<string>) => {
  for (const [id, watch] of [...watches]) {
    if (surfaceIds.includes(id)) continue;
    watch.stopped = true;
    watches.delete(id);
  }

  for (const id of surfaceIds) if (!watches.has(id)) watches.set(id, await startWatch(id));

  for (const id of refresh) {
    const watch = watches.get(id);

    if (watch) watch.lastText = '';
  }
};

const inputQueues = new Map<string, Promise<void>>();

const inOrder = (surfaceId: string, task: () => Promise<void>): Promise<void> => {
  const next = (inputQueues.get(surfaceId) ?? Promise.resolve()).then(task).catch((error) => log('browser input failed', error instanceof Error ? error.message.slice(0, 160) : error));
  inputQueues.set(surfaceId, next);

  return next;
};

const onMessage = async (raw: string) => {
  const decoded = decode(raw);

  if (decoded._tag === 'None') return;
  const message = decoded.value;

  if (message._tag === 'Watch') return setWatches(message.surfaceIds, message.refresh ?? []);

  if (message._tag === 'Browser') {
    if (surfaceOf(message.surfaceId)?.kind === 'browser') void inOrder(message.surfaceId, () => applyInput(message.surfaceId, message.input));
    const watch = watches.get(message.surfaceId);

    if (watch) watch.lastText = '';

    return;
  }

  if (message._tag === 'Key') {
    if (surfaceOf(message.surfaceId)) await sendKey(message.surfaceId, message.key).catch((error) => log('key failed', error));

    return;
  }

  if (!surfaceOf(message.surfaceId)) return send({ _tag: 'Sent', requestId: message.requestId, ok: false, reason: 'no such panel on your Mac' });

  try {
    await sendText(message.surfaceId, message.text, message.submit);
    log('sent', message.surfaceId, message.text.length, 'chars');
    send({ _tag: 'Sent', requestId: message.requestId, ok: true, reason: null });
  } catch (error) {
    send({ _tag: 'Sent', requestId: message.requestId, ok: false, reason: error instanceof Error ? error.message.slice(0, 200) : 'send failed' });
  }
};

const pushSidebar = async () => {
  const next = await readSidebar(await piLinks());
  sidebar = next;
  const key = JSON.stringify({ ...next, at: 0 });

  if (key === lastSidebar) return;
  lastSidebar = key;
  send({ _tag: 'Sidebar', sidebar: next });
};

const connect = () => {
  const url = new URL('/daemon', config.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const next = new WebSocket(url, { headers: { 'cf-access-client-id': config.clientId, 'cf-access-client-secret': config.clientSecret } } as never);
  socket = next;
  next.addEventListener('open', () => {
    backoff = 1000;
    lastSidebar = '';
    log('connected', config.origin);
    send({ _tag: 'Hello', machine: hostname(), version: VERSION });
    void pushSidebar();
  });
  next.addEventListener('message', (event) => void onMessage(String(event.data)));
  next.addEventListener('close', (event) => {
    log('disconnected', event.code, event.reason, `retry in ${backoff}ms`);
    for (const watch of watches.values()) watch.stopped = true;
    watches.clear();
    setTimeout(connect, backoff);
    backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
  });
  next.addEventListener('error', () => next.close());
};

const every = (ms: number, task: () => Promise<unknown>) => {
  let running = false;
  setInterval(() => {
    if (running || socket?.readyState !== WebSocket.OPEN) return;
    running = true;
    task()
      .catch((error) => log('task failed', error instanceof Error ? error.message : error))
      .finally(() => {
        running = false;
      });
  }, ms);
};

every(SIDEBAR_EVERY_MS, pushSidebar);
every(PANEL_EVERY_MS, () => Promise.all([...watches.values()].map(pollWatch)));
connect();
