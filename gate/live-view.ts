import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const origin = process.argv[2] ?? 'http://127.0.0.1:8790';
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)/u.test(origin);
const clientId = process.env.PORCH_MCP_CLIENT_ID;
const clientSecret = process.env.PORCH_MCP_CLIENT_SECRET;

if (!isLocal && (!clientId || !clientSecret)) throw new Error('set PORCH_MCP_CLIENT_ID and PORCH_MCP_CLIENT_SECRET to test a deployed origin');

const auth: Record<string, string> = isLocal ? { 'x-porch-dev-caller': 'mcp' } : { 'cf-access-client-id': clientId ?? '', 'cf-access-client-secret': clientSecret ?? '' };
const wsAuth: Record<string, string> = isLocal ? {} : auth;

const cmux = (args: ReadonlyArray<string>) => execFileSync('cmux', [...args], { encoding: 'utf8', timeout: 20_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const results: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail: string) => results.push([name, ok, detail]);

type Frame = { readonly _tag: string; readonly surfaceId: string; readonly width?: number; readonly height?: number; readonly image?: string; readonly mime?: string; readonly mediaUrl?: string; readonly reason?: string };

const phone = async (surfaceId: string, viewport: { width: number; height: number } | null, onFrame: (frame: Frame) => void) => {
  const url = new URL('/phone', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url, { headers: { ...wsAuth, ...(isLocal ? {} : {}) } } as never);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('phone socket failed')));
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { _tag: string; frame?: Frame };

    if (message._tag === 'Frame' && message.frame?.surfaceId === surfaceId) onFrame(message.frame);
  });
  socket.send(JSON.stringify({ _tag: 'Open', surfaceId, ...(viewport ? { viewport } : {}) }));

  return socket;
};

const created = (output: string) => /OK ([0-9A-F-]{36})/u.exec(output)?.[1] ?? null;
const pageSize = (surfaceId: string) => (JSON.parse(cmux(['rpc', 'browser.eval', JSON.stringify({ surface_id: surfaceId, script: '[innerWidth, innerHeight]' })])) as { value: [number, number] }).value;

const surfaces: Array<string> = [];

try {
  const browser = created(cmux(['new-surface', '--type', 'browser', '--url', 'https://en.wikipedia.org/wiki/Porch', '--focus', 'false', '--id-format', 'uuids']));

  if (!browser) throw new Error('could not create scratch browser');
  surfaces.push(browser);
  await sleep(4000);
  const before = pageSize(browser);
  const viewport = { width: 390, height: 724 };
  const frames: Array<Frame> = [];
  const socket = await phone(browser, viewport, (frame) => frame._tag === 'Screen' && frames.push(frame));
  const deadline = Date.now() + 45_000;

  while (frames.length < 10 && Date.now() < deadline) {
    await sleep(700);
    cmux(['rpc', 'browser.eval', JSON.stringify({ surface_id: browser, script: `scrollBy(0, ${frames.length % 2 ? -120 : 120}); 1` })]);
  }
  const sizes = new Set(frames.map((frame) => `${frame.width}x${frame.height}`));
  const imageSizes = new Set(
    await Promise.all(frames.map(async (frame) => {
      const meta = await sharp(Buffer.from((frame.image ?? '').split(',')[1] ?? '', 'base64')).metadata();

      return `${meta.width}x${meta.height}`;
    })),
  );
  check('10 browser frames, one page size, matching the phone', frames.length >= 10 && sizes.size === 1 && sizes.has('390x724'), `${frames.length} frames, page ${[...sizes].join(',')}`);
  check('every frame image has the same pixel size', frames.length >= 10 && imageSizes.size === 1, [...imageSizes].join(','));
  socket.close();
  await sleep(4000);
  const after = pageSize(browser);
  check('viewport resets to the Mac pane after the phone leaves', after[0] === before[0] && after[1] === before[1], `before ${before.join('x')} after ${after.join('x')}`);

  const dir = mkdtempSync(join(tmpdir(), 'porch-gate-'));
  const png = join(dir, 'gate.png');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#f59e0b' } }).png().toFile(png);
  const mp4 = join(dir, 'gate.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=orange:s=160x120:d=2', '-pix_fmt', 'yuv420p', mp4]);
  const txt = join(dir, 'gate.unknownext');
  writeFileSync(txt, 'porch');

  for (const [path, mime] of [[png, 'image/png'], [mp4, 'video/mp4']] as const) {
    const surface = created(cmux(['open', path, '--no-focus', '--id-format', 'uuids'])) ?? (await findFileSurface(path));

    if (!surface) {
      check(`file pane ${mime}`, false, 'cmux did not open it');
      continue;
    }
    surfaces.push(surface);
    await sleep(3000);
    let file: Frame | null = null;
    const opened = Date.now();
    const sock = await phone(surface, null, (frame) => (file ??= frame));

    while (!file && Date.now() - opened < 10_000) await sleep(200);
    sock.close();
    const got = file as Frame | null;
    check(`file pane ${mime} sends a File frame`, got?._tag === 'File' && got.mime === mime, `${got?._tag ?? 'none'} ${got?.mime ?? ''}`);

    if (got?._tag === 'File' && got.mediaUrl) {
      const whole = readFileSync(path);
      const response = await fetch(new URL(got.mediaUrl, origin), { headers: { ...auth, range: 'bytes=10-41' }, redirect: 'manual' });
      const body = new Uint8Array(await response.arrayBuffer());
      const expected = whole.subarray(10, 42);
      check(`media endpoint serves ${mime} ranges`, response.status === 206 && response.headers.get('content-range') === `bytes 10-41/${whole.length}` && Buffer.from(body).equals(expected), `${response.status} ${response.headers.get('content-range')}`);
    }
  }

  const odd = created(cmux(['open', txt, '--no-focus', '--id-format', 'uuids'])) ?? (await findFileSurface(txt));

  if (odd) {
    surfaces.push(odd);
    await sleep(3000);
    let message: Frame | null = null;
    const opened = Date.now();
    const sock = await phone(odd, null, (frame) => (message ??= frame));

    while (!message && Date.now() - opened < 3000) await sleep(100);
    sock.close();
    const got = message as Frame | null;
    check('unsupported pane says so within 3s', got?._tag === 'Unsupported' && Date.now() - opened <= 3200, `${got?._tag ?? 'none'} after ${Date.now() - opened}ms`);
  } else {
    check('unsupported pane says so within 3s', false, 'cmux did not open the file');
  }
} finally {
  for (const surface of surfaces) {
    try {
      cmux(['close-surface', '--surface', surface]);
    } catch {
      continue;
    }
  }
}

async function findFileSurface(path: string): Promise<string | null> {
  await sleep(2500);
  const list = JSON.parse(cmux(['rpc', 'mobile.workspace.list', '{}'])) as { workspaces: ReadonlyArray<{ surfaces?: ReadonlyArray<{ surface_id: string; file_path?: string }> }> };

  return list.workspaces.flatMap((workspace) => workspace.surfaces ?? []).find((surface) => surface.file_path === path)?.surface_id ?? null;
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${detail})`);
process.exit(results.length > 0 && results.every(([, ok]) => ok) ? 0 : 1);
