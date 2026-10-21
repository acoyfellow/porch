import { hostname } from 'node:os';
import { Schema } from 'effect';
import { type DaemonToRelay, type PanelFrame, type PiEntry, RelayToDaemon, type Sidebar, type Surface } from '../shared/protocol';
import { applyInput, captureScreen, type PinnedViewport, pinViewport, resetViewport, UnstableFrame } from './browser';
import { readScreen, readSidebar, sendKey, sendText } from './cmux';
import { loadConfig } from './config';
import { fileInfo, isStreamable, readChunk } from './files';
import { openTail, piLinks, readNew, sessionFile, type Tail } from './pi';

const SIDEBAR_EVERY_MS = 2000;
const PANEL_EVERY_MS = 700;
const TEXT_LINES = 120;
const MAX_BACKOFF_MS = 30_000;
const VERSION = '0.0.1';

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(RelayToDaemon));

type WatchKind = 'pi' | 'text' | 'screen' | 'file' | 'unsupported';

type Watch = { readonly surfaceId: string; kind: WatchKind; tail: Tail | null; sessionId: string | null; lastText: string; capturing: boolean; stopped: boolean; viewport: PinnedViewport | null; pinned: string; everPinned: boolean };

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

const kindOfSurface = (surface: Surface | null): WatchKind => {
  if (surface?.pi) return 'pi';

  if (surface?.kind === 'browser') return 'screen';

  if (surface?.kind === 'file') return 'file';

  if (surface?.kind === 'terminal' || surface === null) return 'text';

  return 'unsupported';
};

const sendFileFrame = async (watch: Watch, surface: Surface | null) => {
  const path = surface?.filePath;

  if (!path) return frame({ _tag: 'Unsupported', surfaceId: watch.surfaceId, reason: 'cmux did not report a file path for this panel' });
  const info = await fileInfo(path).catch(() => null);

  if (!info) return frame({ _tag: 'Unsupported', surfaceId: watch.surfaceId, reason: `${surface?.title ?? 'this file'} is no longer on your Mac` });

  if (!isStreamable(info.mime)) return frame({ _tag: 'Unsupported', surfaceId: watch.surfaceId, reason: `${info.name} (${info.mime}) cannot be shown on your phone yet` });
  frame({ _tag: 'File', surfaceId: watch.surfaceId, name: info.name, mime: info.mime, size: info.size, mediaUrl: `/api/media?surface=${encodeURIComponent(watch.surfaceId)}` });
};

const FORCED_REFRESH_MS = 1500;
let lastForcedRefresh = 0;

const knownSurface = async (surfaceId: string): Promise<Surface | null> => {
  const cached = surfaceOf(surfaceId);

  if (cached) return cached;

  if (Date.now() - lastForcedRefresh < FORCED_REFRESH_MS) return null;
  lastForcedRefresh = Date.now();
  await refreshSidebar().catch(() => undefined);

  return surfaceOf(surfaceId);
};

const startWatch = async (surfaceId: string, viewport: PinnedViewport | null): Promise<Watch> => {
  const surface = await knownSurface(surfaceId);
  const watch: Watch = { surfaceId, kind: kindOfSurface(surface), tail: null, sessionId: surface?.pi?.sessionId ?? null, lastText: '', capturing: false, stopped: false, viewport, pinned: '', everPinned: false };

  if (watch.kind === 'file') {
    await sendFileFrame(watch, surface);

    return watch;
  }

  if (watch.kind === 'unsupported') {
    frame({ _tag: 'Unsupported', surfaceId, reason: `${surface?.title || 'This panel'} is a ${surface?.kind ?? 'panel'} that porch cannot show yet` });

    return watch;
  }

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
      if (sidebar && !surfaceOf(watch.surfaceId)) {
        frame({ _tag: 'Gone', surfaceId: watch.surfaceId, reason: 'this panel was closed on your Mac' });
        watch.stopped = true;
        break;
      }
      const pinKey = watch.viewport ? `${watch.viewport.width}x${watch.viewport.height}` : '';

      if (watch.viewport && watch.pinned !== pinKey) {
        await pinViewport(watch.surfaceId, watch.viewport).catch((error) => log('pin failed', watch.surfaceId, error instanceof Error ? error.message.slice(0, 160) : error));
        watch.pinned = pinKey;
        watch.everPinned = true;
      }
      const screen = await captureScreen(watch.surfaceId, watch.viewport).catch((error) => {
        if (!(error instanceof UnstableFrame)) log('screen failed', watch.surfaceId, error instanceof Error ? error.message.slice(0, 160) : error);

        return error instanceof UnstableFrame ? 'unstable' : null;
      });

      if (screen === 'unstable') {
        watch.pinned = '';
        await Bun.sleep(SCREEN_IDLE_MS);
        continue;
      }

      if (screen && screen.digest !== watch.lastText) {
        watch.lastText = screen.digest;
        frame({ _tag: 'Screen', surfaceId: watch.surfaceId, image: screen.image, width: screen.width, height: screen.height, url: screen.url, title: screen.title, at: Date.now() });
      }
      await Bun.sleep(screen ? SCREEN_IDLE_MS : 2000);
    }
  } finally {
    watch.capturing = false;

    if (watch.stopped && watch.everPinned) await resetViewport(watch.surfaceId).catch(() => undefined);
  }
};

const pollWatch = async (watch: Watch) => {
  const surface = await knownSurface(watch.surfaceId);

  if (sidebar && !surface) return frame({ _tag: 'Gone', surfaceId: watch.surfaceId, reason: 'this panel was closed on your Mac' });

  if (watch.kind === 'text' && surface && kindOfSurface(surface) !== 'text') {
    watch.kind = kindOfSurface(surface);

    if (watch.kind === 'file') return sendFileFrame(watch, surface);
  }

  if (watch.kind === 'file' || watch.kind === 'unsupported') return;

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

type ViewportRequest = { readonly surfaceId: string; readonly width: number; readonly height: number };

const stopWatch = (watch: Watch) => {
  watch.stopped = true;

  if (watch.kind === 'screen' && watch.everPinned && !watch.capturing) void resetViewport(watch.surfaceId).catch(() => undefined);
};

const setWatches = async (surfaceIds: ReadonlyArray<string>, refresh: ReadonlyArray<string>, viewports: ReadonlyArray<ViewportRequest>) => {
  const viewportOf = (id: string): PinnedViewport | null => {
    const found = viewports.find((each) => each.surfaceId === id);

    return found ? { width: found.width, height: found.height } : null;
  };

  for (const [id, watch] of [...watches]) {
    if (surfaceIds.includes(id)) continue;
    stopWatch(watch);
    watches.delete(id);
  }

  for (const id of surfaceIds) {
    const existing = watches.get(id);

    if (!existing) {
      watches.set(id, await startWatch(id, viewportOf(id)));
      continue;
    }
    const viewport = viewportOf(id);

    if (viewport && (existing.viewport?.width !== viewport.width || existing.viewport?.height !== viewport.height)) existing.viewport = viewport;
  }

  for (const id of refresh) {
    const watch = watches.get(id);

    if (!watch) continue;
    watch.lastText = '';

    if (watch.kind === 'file') void sendFileFrame(watch, surfaceOf(id));

    if (watch.kind === 'unsupported') frame({ _tag: 'Unsupported', surfaceId: id, reason: 'porch cannot show this panel yet' });
  }
};

const MEDIA_CHUNK_LIMIT = 1024 * 1024;

const serveMedia = async (requestId: string, surfaceId: string, start: number, end: number | null) => {
  const path = surfaceOf(surfaceId)?.filePath;
  const fail = () => send({ _tag: 'MediaChunk', requestId, ok: false, start: 0, end: 0, total: 0, mime: '', data: '' });

  if (!path) return fail();

  try {
    const info = await fileInfo(path);

    if (!isStreamable(info.mime)) return fail();
    const chunk = await readChunk(path, start, end === null ? Math.min(info.size - 1, start + MEDIA_CHUNK_LIMIT - 1) : end);
    send({ _tag: 'MediaChunk', requestId, ok: true, start: chunk.start, end: chunk.end, total: chunk.total, mime: info.mime, data: Buffer.from(chunk.bytes).toString('base64') });
  } catch {
    fail();
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

  if (message._tag === 'Watch') return setWatches(message.surfaceIds, message.refresh ?? [], message.viewports ?? []);

  if (message._tag === 'MediaRequest') return serveMedia(message.requestId, message.surfaceId, message.start, message.end);

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

const refreshSidebar = async () => {
  sidebar = await readSidebar(await piLinks());

  return sidebar;
};

const pushSidebar = async () => {
  const next = await refreshSidebar();
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
    for (const watch of watches.values()) stopWatch(watch);
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
