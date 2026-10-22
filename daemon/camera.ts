import type { Subprocess } from 'bun';
import type { WhipProxy } from './whip';

export type PaneRect = { readonly surfaceId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number };

type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

type RawPane = { readonly selected_surface_id?: string; readonly pixel_frame?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } };

type RawWindow = { readonly id: string; readonly visible?: boolean; readonly selected_workspace_id?: string };

const SCALE = 2;

const run = async (command: ReadonlyArray<string>): Promise<string> => {
  const child = Bun.spawn([...command], { stdout: 'pipe', stderr: 'ignore' });

  return (await new Response(child.stdout).text()).trim();
};

const windowOrigin = async (): Promise<{ readonly x: number; readonly y: number } | null> => {
  const output = await run(['osascript', '-e', 'tell application "System Events" to tell (first process whose bundle identifier contains "cmux") to get position of window 1']);
  const [x, y] = output.split(',').map((part) => Number(part.trim()));

  return Number.isFinite(x) && Number.isFinite(y) ? { x: x ?? 0, y: y ?? 0 } : null;
};

let screenDevice: string | null = null;

const captureDevice = async (): Promise<string> => {
  if (screenDevice) return screenDevice;
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { stdout: 'ignore', stderr: 'pipe' });
  const listing = await new Response(child.stderr).text();
  screenDevice = /\[(\d+)\] Capture screen 0/u.exec(listing)?.[1] ?? '3';

  return screenDevice;
};

export const visiblePanes = async (rpc: Rpc): Promise<ReadonlyArray<PaneRect>> => {
  const windows = ((await rpc('window.list', {})) as { readonly windows?: ReadonlyArray<RawWindow> }).windows ?? [];
  const shown = windows.find((window) => window.visible && window.selected_workspace_id);
  const origin = shown ? await windowOrigin() : null;

  if (!shown?.selected_workspace_id || !origin) return [];
  const panes = ((await rpc('pane.list', { workspace_id: shown.selected_workspace_id })) as { readonly panes?: ReadonlyArray<RawPane> }).panes ?? [];

  return panes.flatMap((pane) =>
    pane.selected_surface_id && pane.pixel_frame
      ? [{ surfaceId: pane.selected_surface_id.toUpperCase(), x: origin.x + pane.pixel_frame.x, y: origin.y + pane.pixel_frame.y, width: pane.pixel_frame.width, height: pane.pixel_frame.height }]
      : [],
  );
};

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

const cropOf = (pane: PaneRect) => `crop=${even(pane.width * SCALE)}:${even(pane.height * SCALE)}:${pane.x * SCALE}:${pane.y * SCALE},scale=-2:'min(1080,ih)',format=yuv420p`;

export const ffmpegArgs = (device: string, panes: ReadonlyArray<PaneRect>, target: (surfaceId: string) => string): ReadonlyArray<string> => [
  'ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostats',
  '-use_wallclock_as_timestamps', '1',
  '-f', 'avfoundation', '-capture_cursor', '1', '-framerate', '30', '-pixel_format', 'nv12', '-i', `${device}:none`,
  '-filter_complex', `[0:v]split=${panes.length}${panes.map((_, index) => `[in${index}]`).join('')};${panes.map((pane, index) => `[in${index}]${cropOf(pane)}[out${index}]`).join(';')}`,
  ...panes.flatMap((pane, index) => [
    '-map', `[out${index}]`, '-fps_mode', 'cfr', '-r', '30',
    '-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'baseline', '-bf', '0', '-g', '30', '-b:v', '3M',
    '-f', 'whip', target(pane.surfaceId),
  ]),
];

const layoutKey = (panes: ReadonlyArray<PaneRect>) => panes.map((pane) => `${pane.surfaceId}@${pane.x},${pane.y},${pane.width},${pane.height}`).sort().join('|');

type Running = { readonly key: string; readonly child: Subprocess; readonly surfaceIds: ReadonlyArray<string> };

export type Camera = { readonly sync: () => Promise<ReadonlyArray<string>>; readonly stop: () => void };

export const startCamera = (rpc: Rpc, proxy: WhipProxy, log: (line: string) => void): Camera => {
  let running: Running | null = null;
  let failedAt = 0;

  const halt = () => {
    const current = running;
    running = null;

    if (!current) return;
    current.child.kill('SIGKILL');

    for (const surfaceId of current.surfaceIds) void proxy.unpublish(surfaceId);
  };

  const launch = async (panes: ReadonlyArray<PaneRect>) => {
    const child = Bun.spawn([...ffmpegArgs(await captureDevice(), panes, proxy.url)], { stdout: 'ignore', stderr: 'pipe' });
    const entry: Running = { key: layoutKey(panes), child, surfaceIds: panes.map((pane) => pane.surfaceId) };
    running = entry;
    void new Response(child.stderr).text().then(async (stderr) => {
      await child.exited;

      if (running !== entry) return;
      halt();
      failedAt = Date.now();
      log(`camera exited ${child.exitCode}: ${stderr.split('\n').filter((line) => line && !line.includes('NSKVO') && !line.includes('Configuration of video device')).slice(-2).join(' | ')}`);
    });
  };

  return {
    sync: async () => {
      const panes = await visiblePanes(rpc).catch(() => []);
      const key = layoutKey(panes);

      if (running?.key === key) return running.surfaceIds;
      halt();

      if (panes.length === 0 || Date.now() - failedAt < 5000) return [];
      await launch(panes);

      return panes.map((pane) => pane.surfaceId);
    },
    stop: halt,
  };
};
