import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Group, Sidebar, Surface, SurfaceKind, Workspace } from '../shared/protocol';

const run = promisify(execFile);

const CMUX = process.env.PORCH_CMUX_BIN ?? 'cmux';
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

export type PiLink = { readonly sessionId: string; readonly status: string };

export const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
  const { stdout } = await run(CMUX, ['rpc', method, JSON.stringify(params)], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' });

  return JSON.parse(stdout);
};

type RawSurface = { readonly surface_id?: string; readonly title?: string; readonly kind?: string; readonly is_focused?: boolean };

type RawWorkspace = {
  readonly id?: string;
  readonly title?: string;
  readonly custom_color?: string | null;
  readonly is_pinned?: boolean;
  readonly has_unread?: boolean;
  readonly is_selected?: boolean;
  readonly preview?: string | null;
  readonly last_activity_at?: number | null;
  readonly current_directory?: string | null;
  readonly group_id?: string | null;
  readonly surfaces?: ReadonlyArray<RawSurface>;
};

type RawGroup = {
  readonly id?: string;
  readonly name?: string;
  readonly is_pinned?: boolean;
  readonly is_collapsed?: boolean;
  readonly icon_symbol?: string | null;
  readonly member_workspace_ids?: ReadonlyArray<string>;
};

export type RawSidebar = { readonly workspaces?: ReadonlyArray<RawWorkspace>; readonly groups?: ReadonlyArray<RawGroup> };

const KINDS: ReadonlyMap<string, SurfaceKind> = new Map([
  ['terminal', 'terminal'],
  ['browser', 'browser'],
  ['markdown', 'markdown'],
  ['filePreview', 'file'],
  ['file', 'file'],
]);

const kindOf = (raw: string | undefined): SurfaceKind => (raw ? (KINDS.get(raw) ?? 'other') : 'other');

const surfaceOf = (raw: RawSurface, pi: ReadonlyMap<string, PiLink>): Surface => {
  const id = raw.surface_id ?? '';

  return { id, title: raw.title ?? '', kind: kindOf(raw.kind), focused: raw.is_focused === true, pi: pi.get(id.toUpperCase()) ?? null };
};

const workspaceOf = (raw: RawWorkspace, pi: ReadonlyMap<string, PiLink>): Workspace => ({
  id: raw.id ?? '',
  title: raw.title ?? '',
  pinned: raw.is_pinned === true,
  color: raw.custom_color ?? null,
  unread: raw.has_unread === true,
  selected: raw.is_selected === true,
  preview: raw.preview ?? null,
  lastActivityAt: raw.last_activity_at ?? null,
  cwd: raw.current_directory ?? null,
  groupId: raw.group_id ?? null,
  surfaces: (raw.surfaces ?? []).map((surface) => surfaceOf(surface, pi)),
});

const groupOf = (raw: RawGroup): Group => ({
  id: raw.id ?? '',
  name: raw.name ?? '',
  pinned: raw.is_pinned === true,
  collapsed: raw.is_collapsed === true,
  icon: raw.icon_symbol ?? null,
  members: [...(raw.member_workspace_ids ?? [])],
});

export const sidebarOf = (raw: RawSidebar, pi: ReadonlyMap<string, PiLink>, at: number): Sidebar => ({
  at,
  groups: (raw.groups ?? []).map(groupOf),
  workspaces: (raw.workspaces ?? []).map((workspace) => workspaceOf(workspace, pi)),
});

export const readSidebar = async (pi: ReadonlyMap<string, PiLink>): Promise<Sidebar> => sidebarOf((await rpc('mobile.workspace.list', {})) as RawSidebar, pi, Date.now());

export const readScreen = async (surfaceId: string, lines: number): Promise<string> => {
  const { stdout } = await run(CMUX, ['read-screen', '--surface', surfaceId, '--lines', String(lines)], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' });

  return stdout;
};

export const sendText = async (surfaceId: string, text: string, submit: boolean): Promise<void> => {
  await run(CMUX, ['send', '--surface', surfaceId, '--', text], { timeout: TIMEOUT_MS, encoding: 'utf8' });

  if (submit) await run(CMUX, ['send-key', '--surface', surfaceId, 'Enter'], { timeout: TIMEOUT_MS, encoding: 'utf8' });
};

export const sendKey = async (surfaceId: string, key: 'Escape'): Promise<void> => {
  await run(CMUX, ['send-key', '--surface', surfaceId, key], { timeout: TIMEOUT_MS, encoding: 'utf8' });
};
