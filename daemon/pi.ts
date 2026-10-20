import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PiEntry } from '../shared/protocol';
import type { PiLink } from './cmux';

const HOOK_STORE = process.env.PORCH_CMUX_PI_STORE ?? join(homedir(), '.cmuxterm', 'pi-hook-sessions.json');
const SESSIONS_DIR = process.env.PORCH_PI_SESSIONS ?? join(homedir(), '.pi', 'agent', 'sessions');
const MAX_TEXT = 4000;
export const INITIAL_ENTRIES = 60;
const TAIL_BYTES = 2 * 1024 * 1024;

type HookSession = { readonly sessionId?: string; readonly surfaceId?: string; readonly runtimeStatus?: string; readonly updatedAt?: number };

export const piLinks = async (): Promise<ReadonlyMap<string, PiLink>> => {
  try {
    const store = JSON.parse(await readFile(HOOK_STORE, 'utf8')) as { readonly sessions?: Record<string, HookSession> };
    const latest = new Map<string, HookSession>();

    for (const session of Object.values(store.sessions ?? {})) {
      if (!session.surfaceId || !session.sessionId) continue;
      const key = session.surfaceId.toUpperCase();
      const seen = latest.get(key);

      if (!seen || (session.updatedAt ?? 0) > (seen.updatedAt ?? 0)) latest.set(key, session);
    }

    const links = await Promise.all([...latest].map(async ([surface, session]) => [surface, { sessionId: session.sessionId ?? '', status: await observedStatus(session) }] as const));

    return new Map(links);
  } catch {
    return new Map();
  }
};

const ACTIVE_WINDOW_MS = 60_000;

const observedStatus = async (session: HookSession): Promise<string> => {
  const reported = session.runtimeStatus ?? 'unknown';

  if (reported !== 'running') return reported;

  const path = session.sessionId ? await sessionFile(session.sessionId) : null;
  const modified = path ? await stat(path).then((info) => info.mtimeMs).catch(() => 0) : 0;

  return Date.now() - modified < ACTIVE_WINDOW_MS ? 'running' : 'idle';
};

const fileCache = new Map<string, string>();

export const sessionFile = async (sessionId: string): Promise<string | null> => {
  const cached = fileCache.get(sessionId);

  if (cached) return cached;

  for (const dir of await readdir(SESSIONS_DIR).catch(() => [] as string[])) {
    const names = await readdir(join(SESSIONS_DIR, dir)).catch(() => [] as string[]);
    const match = names.find((name) => name.endsWith(`_${sessionId}.jsonl`));

    if (match) {
      const path = join(SESSIONS_DIR, dir, match);
      fileCache.set(sessionId, path);

      return path;
    }
  }

  return null;
};

type Part = { readonly type?: string; readonly text?: string; readonly name?: string; readonly arguments?: unknown };

type Line = {
  readonly type?: string;
  readonly id?: string;
  readonly timestamp?: string;
  readonly message?: { readonly role?: string; readonly content?: string | ReadonlyArray<Part>; readonly toolName?: string };
  readonly summary?: string;
};

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

const argsPreview = (args: unknown): string => {
  if (args === undefined) return '';
  const text = typeof args === 'string' ? args : JSON.stringify(args);

  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

export const entriesOf = (line: Line): ReadonlyArray<PiEntry> => {
  const at = line.timestamp ?? null;
  const id = line.id ?? '';

  if (line.type === 'compaction') return [{ id, role: 'notice', text: 'context compacted', tool: null, at }];

  if (line.type !== 'message' || !line.message) return [];
  const { role = 'unknown', content } = line.message;

  if (typeof content === 'string') return content.trim() ? [{ id, role, text: clip(content), tool: null, at }] : [];
  const parts = content ?? [];

  if (role === 'toolResult') {
    const text = parts.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');

    return [{ id, role, text: clip(text), tool: line.message.toolName ?? null, at }];
  }

  return parts.flatMap((part, index): ReadonlyArray<PiEntry> => {
    const partId = `${id}:${index}`;

    if (part.type === 'text' && part.text?.trim()) return [{ id: partId, role, text: clip(part.text), tool: null, at }];

    if (part.type === 'toolCall') return [{ id: partId, role: 'toolCall', text: argsPreview(part.arguments), tool: part.name ?? null, at }];

    return [];
  });
};

export const parseLines = (chunk: string): ReadonlyArray<PiEntry> =>
  chunk.split('\n').flatMap((raw) => {
    if (!raw.trim()) return [];

    try {
      return entriesOf(JSON.parse(raw));
    } catch {
      return [];
    }
  });

export type Tail = { readonly path: string; offset: number };

export const openTail = async (path: string): Promise<{ readonly tail: Tail; readonly entries: ReadonlyArray<PiEntry> }> => {
  const size = (await stat(path)).size;
  const start = Math.max(0, size - TAIL_BYTES);
  const handle = await open(path, 'r');
  const buffer = Buffer.alloc(size - start);
  await handle.read(buffer, 0, buffer.length, start);
  await handle.close();
  const text = buffer.toString('utf8');
  const body = start === 0 ? text : text.slice(text.indexOf('\n') + 1);

  return { tail: { path, offset: size }, entries: parseLines(body).slice(-INITIAL_ENTRIES) };
};

export const readNew = async (tail: Tail): Promise<ReadonlyArray<PiEntry>> => {
  const size = (await stat(tail.path)).size;

  if (size <= tail.offset) return [];
  const handle = await open(tail.path, 'r');
  const buffer = Buffer.alloc(size - tail.offset);
  await handle.read(buffer, 0, buffer.length, tail.offset);
  await handle.close();
  const text = buffer.toString('utf8');
  const complete = text.lastIndexOf('\n');

  if (complete < 0) return [];
  tail.offset += Buffer.byteLength(text.slice(0, complete + 1));

  return parseLines(text.slice(0, complete + 1));
};
