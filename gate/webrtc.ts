import { execFileSync } from 'node:child_process';
import { chromium, type Page } from 'playwright-core';
import { mcpCredentials } from './credentials';

const origin = process.argv[2] ?? 'https://pi.coey.dev';
const credentials = mcpCredentials();

if (!credentials) throw new Error('no MCP credentials in the porch-mcp keychain item');
const auth = { 'cf-access-client-id': credentials.clientId, 'cf-access-client-secret': credentials.clientSecret };
const cmux = (args: ReadonlyArray<string>) => execFileSync('cmux', [...args], { encoding: 'utf8', timeout: 20_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);
const created = (output: string) => /([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/u.exec(output)?.[1] ?? null;

const workspaceId = (JSON.parse(cmux(['rpc', 'window.list', '{}'])) as { windows: Array<{ visible?: boolean; selected_workspace_id?: string }> }).windows.find((each) => each.visible)?.selected_workspace_id ?? '';

const api = async (path: string, body: unknown) => {
  const response = await fetch(new URL(path, origin), { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  return response.json() as Promise<unknown>;
};

const mcp = (name: string, args: Record<string, unknown>) =>
  fetch(new URL('/mcp', origin), {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  }).then((response) => response.text());

type Probe = { readonly connected: boolean; readonly fps: number; readonly width: number; readonly height: number; readonly state: string };

const installSampler = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const scope = window as unknown as { porchSample: () => Uint8ClampedArray | null; porchDiff: (a: Uint8ClampedArray, b: Uint8ClampedArray) => number };
    scope.porchSample = () => {
      const video = document.querySelector<HTMLVideoElement>('#live-video');

      if (!video || !context || video.videoWidth === 0) return null;
      canvas.width = 320;
      canvas.height = Math.round((320 * video.videoHeight) / video.videoWidth);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);

      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    scope.porchDiff = (a, b) => {
      let changed = 0;

      for (let index = 0; index < Math.min(a.length, b.length); index += 4) if (Math.abs((a[index] ?? 0) - (b[index] ?? 0)) + Math.abs((a[index + 1] ?? 0) - (b[index + 1] ?? 0)) > 60) changed += 1;

      return changed / (a.length / 4);
    };
  });

const measure = (page: Page, seconds: number): Promise<Probe> =>
  page.evaluate(async (window_seconds) => {
    const peers = (window as unknown as { porchPeers?: Array<RTCPeerConnection> }).porchPeers ?? [];
    const peer = peers.at(-1);
    const video = document.querySelector<HTMLVideoElement>('#live-video');
    const state = document.querySelector('#live-state')?.getAttribute('data-state') ?? 'none';

    if (!peer || !video) return { connected: false, fps: 0, width: 0, height: 0, state };
    const decoded = async () => {
      let frames = 0;
      (await peer.getStats()).forEach((report: { type: string; kind?: string; framesDecoded?: number }) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') frames = report.framesDecoded ?? 0;
      });

      return frames;
    };
    const before = await decoded();
    await new Promise((resolve) => setTimeout(resolve, window_seconds * 1000));
    const after = await decoded();

    return { connected: peer.connectionState === 'connected', fps: (after - before) / window_seconds, width: video.videoWidth, height: video.videoHeight, state };
  }, seconds);

const changedAfter = async (page: Page, act: () => Promise<unknown>): Promise<{ readonly quietBefore: number; readonly latencyMs: number | null; readonly peak: number }> => {
  const quiet = await page.evaluate(async () => {
    const scope = window as unknown as { porchSample: () => Uint8ClampedArray | null; porchDiff: (a: Uint8ClampedArray, b: Uint8ClampedArray) => number };
    const first = scope.porchSample();
    let worst = 0;

    for (let step = 0; step < 10; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = scope.porchSample();

      if (first && next) worst = Math.max(worst, scope.porchDiff(first, next));
    }

    return worst;
  });
  await page.evaluate(() => {
    const scope = window as unknown as { porchSample: () => Uint8ClampedArray | null; porchBaseline: Uint8ClampedArray | null };
    scope.porchBaseline = scope.porchSample();
  });
  const startedAt = Date.now();
  await act();
  const watched = await page.evaluate(
    async ({ threshold, sentAt }) => {
      const scope = window as unknown as { porchSample: () => Uint8ClampedArray | null; porchDiff: (a: Uint8ClampedArray, b: Uint8ClampedArray) => number; porchBaseline: Uint8ClampedArray | null };
      let peak = 0;

      while (Date.now() - sentAt < 4000) {
        const now = scope.porchSample();

        if (now && scope.porchBaseline) {
          const diff = scope.porchDiff(scope.porchBaseline, now);
          peak = Math.max(peak, diff);

          if (diff > threshold) return { at: Date.now(), peak };
        }
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      return { at: null, peak };
    },
    { threshold: Math.max(0.004, quiet * 3), sentAt: startedAt },
  );

  return { quietBefore: quiet, latencyMs: watched.at === null ? null : watched.at - startedAt, peak: watched.peak };
};

const surfaces: Array<string> = [];
const browser = await chromium.launch({ executablePath: process.env.PORCH_CHROMIUM ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, args: ['--autoplay-policy=no-user-gesture-required'] });

const nonceText = () => `porch-${Math.random().toString(36).slice(2, 10).toUpperCase()}-LIVE-CAMERA-CHECK`;

const panes: ReadonlyArray<{ readonly label: string; readonly create: () => Promise<string>; readonly input: (surfaceId: string) => Promise<unknown> }> = [
  {
    label: 'terminal',
    create: async () => created(cmux(['new-pane', '--type', 'terminal', '--direction', 'right', '--workspace', workspaceId, '--focus', 'false', '--id-format', 'uuids'])) ?? '',
    input: (surfaceId) => mcp('send_text', { surfaceId, text: `echo ${nonceText()} && printf '%.0s#' {1..400}` }),
  },
  {
    label: 'pi',
    create: async () => created(cmux(['new-pane', '--type', 'terminal', '--direction', 'down', '--workspace', workspaceId, '--focus', 'false', '--command', 'pi --no-session', '--id-format', 'uuids'])) ?? '',
    input: (surfaceId) => mcp('send_text', { surfaceId, text: `${nonceText()} ${'typed from the phone '.repeat(6)}`, submit: false }),
  },
  {
    label: 'browser',
    create: async () => created(cmux(['new-pane', '--type', 'browser', '--direction', 'down', '--workspace', workspaceId, '--url', 'https://en.wikipedia.org/wiki/Porch', '--focus', 'false', '--id-format', 'uuids'])) ?? '',
    input: (surfaceId) => mcp('browser_input', { surfaceId, input: { _tag: 'Navigate', url: 'https://en.wikipedia.org/wiki/Veranda' } }),
  },
];

try {
  for (const pane of panes) {
    const surfaceId = (await pane.create()).toUpperCase();

    if (!surfaceId) {
      check(`${pane.label}: pane created`, false, 'cmux did not return a surface id');
      continue;
    }
    surfaces.push(surfaceId);
  }
  await sleep(9000);

  for (const [index, pane] of panes.entries()) {
    const surfaceId = surfaces[index];

    if (!surfaceId) continue;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, extraHTTPHeaders: auth });
    await context.addInitScript(() => {
      const Original = window.RTCPeerConnection;
      const peers: Array<RTCPeerConnection> = [];
      (window as unknown as { porchPeers: Array<RTCPeerConnection> }).porchPeers = peers;
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          super(config);
          peers.push(this);
        }
      } as typeof RTCPeerConnection;
    });
    const page = await context.newPage();
    await page.goto(new URL(`/w/${encodeURIComponent(workspaceId)}/s/${encodeURIComponent(surfaceId)}`, origin).toString());
    const playing = await page.waitForFunction(() => document.querySelector('#live-state')?.getAttribute('data-state') === 'live', undefined, { timeout: 30_000 }).then(() => true, () => false);
    const state = await page.evaluate(() => `${document.querySelector('#live-state')?.textContent ?? 'no live bar'} ${document.querySelector('#live-absent') ? 'absent' : ''}`);
    check(`${pane.label}: live video plays`, playing, state);

    if (!playing) {
      await context.close();
      continue;
    }
    const probe = await measure(page, 10);
    check(`${pane.label}: peer connected`, probe.connected, `${probe.width}x${probe.height}`);
    check(`${pane.label}: ≥10 fps over 10s`, probe.fps >= 10, `${probe.fps.toFixed(1)} fps`);
    await installSampler(page);
    const reaction = await changedAfter(page, () => pane.input(surfaceId));
    check(`${pane.label}: input visible within 1.5s`, reaction.latencyMs !== null && reaction.latencyMs <= 1500, `latency ${reaction.latencyMs ?? 'none'}ms, quiet ${reaction.quietBefore.toFixed(4)}, peak ${reaction.peak.toFixed(4)}`);
    await context.close();
  }

  const selectedWorkspace = () => (JSON.parse(cmux(['rpc', 'window.list', '{}'])) as { windows: Array<{ visible?: boolean; selected_workspace_id?: string }> }).windows.find((each) => each.visible)?.selected_workspace_id ?? '';
  const background = (JSON.parse(cmux(['rpc', 'mobile.workspace.list', '{}'])) as { workspaces: Array<{ id: string; surfaces?: Array<{ surface_id?: string; kind?: string }> }> }).workspaces.find((each) => each.id !== workspaceId && each.surfaces?.some((surface) => surface.kind === 'terminal'));
  const backgroundSurface = background?.surfaces?.find((surface) => surface.kind === 'terminal')?.surface_id ?? '';

  if (background && backgroundSurface) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: auth });
    const page = await context.newPage();
    await page.goto(new URL(`/w/${encodeURIComponent(background.id)}/s/${encodeURIComponent(backgroundSurface)}`, origin).toString());
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline && selectedWorkspace() !== background.id) await sleep(250);
    const focused = selectedWorkspace() === background.id;
    const playing = await page.waitForFunction(() => document.querySelector('#live-state')?.getAttribute('data-state') === 'live', undefined, { timeout: 20_000 }).then(() => true, () => false);
    const detail = await page.evaluate(() => `${document.querySelector('#live-state')?.textContent ?? ''} ${document.body.innerText.includes('Bringing') ? 'waiting-for-track' : ''}`);
    check('opening a background pane brings it to the front and plays live', focused && playing, `focused ${focused}, live ${playing}, ${detail}`);
    await context.close();
    cmux(['rpc', 'workspace.select', JSON.stringify({ workspace_id: workspaceId })]);
  } else check('opening a background pane brings it to the front and plays live', false, 'no background terminal found');
} finally {
  await browser.close();

  for (const surfaceId of surfaces) {
    try {
      cmux(['close-surface', '--workspace', workspaceId, '--surface', surfaceId]);
    } catch {
      results.push([`cleanup ${surfaceId}`, false, 'close-surface failed']);
    }
  }
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\nwebrtc gate: ${results.length}/${results.length} passed` : `\nwebrtc gate: ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
