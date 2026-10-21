import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { BrowserInput } from '../shared/protocol';

const run = promisify(execFile);

const CMUX = process.env.PORCH_CMUX_BIN ?? 'cmux';
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const FRAME_WIDTH = 900;
const FRAME_QUALITY = 62;
const SCROLL_SCALE = 1;

export type BrowserScreen = { readonly image: string; readonly width: number; readonly height: number; readonly url: string; readonly title: string; readonly digest: string };

const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  const { stdout } = await run(CMUX, ['rpc', method, JSON.stringify(params)], { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8' });

  return JSON.parse(stdout) as T;
};

const evaluate = async <T>(surfaceId: string, script: string): Promise<T> => (await rpc<{ readonly value: T }>('browser.eval', { surface_id: surfaceId, script })).value;

type PageInfo = { readonly width: number; readonly height: number; readonly url: string; readonly title: string };

const PAGE_INFO = '({ width: innerWidth, height: innerHeight, url: location.href, title: document.title })';

const digestOf = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha1').update(bytes).digest('hex');

export const captureScreen = async (surfaceId: string): Promise<BrowserScreen> => {
  const [shot, page] = await Promise.all([rpc<{ readonly png_base64: string }>('browser.screenshot', { surface_id: surfaceId }), evaluate<PageInfo>(surfaceId, PAGE_INFO)]);
  const jpeg = await sharp(Buffer.from(shot.png_base64, 'base64')).resize({ width: FRAME_WIDTH, withoutEnlargement: true }).jpeg({ quality: FRAME_QUALITY, mozjpeg: true }).toBuffer();

  return { image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: page.width, height: page.height, url: page.url, title: page.title, digest: digestOf(jpeg) };
};

const tapScript = (x: number, y: number) => `(() => {
  const x = ${x}, y = ${y};
  const target = document.elementFromPoint(x, y);
  if (!target) return null;
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
  for (const type of ['pointerdown', 'mousedown']) target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { ...init, pointerType: 'touch', isPrimary: true }));
  const editable = target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  if (editable) {
    editable.focus();
    window.__porchCaret = { element: editable, position: 'value' in editable ? editable.value.length : 0 };
  }
  for (const type of ['pointerup', 'mouseup']) target.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, { ...init, pointerType: 'touch', isPrimary: true }));
  target.click();
  return target.tagName;
})()`;

const editScript = (text: string | null) => `(() => {
  const text = ${JSON.stringify(text)};
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  if (!('value' in el) || typeof el.setRangeText !== 'function') return text === null ? false : document.execCommand('insertText', false, text);
  const saved = window.__porchCaret;
  const caret = saved && saved.element === el && saved.position <= el.value.length ? saved.position : el.value.length;
  const start = text === null ? Math.max(0, caret - 1) : caret;
  el.setRangeText(text ?? '', start, caret, 'end');
  window.__porchCaret = { element: el, position: start + (text ?? '').length };
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: text === null ? 'deleteContentBackward' : 'insertText' }));
  return true;
})()`;

const scrollScript = (dx: number, dy: number) => `(() => { scrollBy(${dx * SCROLL_SCALE}, ${dy * SCROLL_SCALE}); return [scrollX, scrollY]; })()`;

const HAS_SCHEME = new RegExp('^https?:' + '/'.repeat(2), 'iu');

const normalizedUrl = (raw: string): string => {
  const trimmed = raw.trim();

  if (HAS_SCHEME.test(trimmed)) return trimmed;

  if (/^[\w-]+(\.[\w-]+)+(\/|$)/u.test(trimmed)) return `https://${trimmed}`;

  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
};

export const applyInput = async (surfaceId: string, input: BrowserInput): Promise<void> => {
  const surface = { surface_id: surfaceId };

  switch (input._tag) {
    case 'Tap':
      await evaluate(surfaceId, tapScript(Math.round(input.x), Math.round(input.y)));

      return;
    case 'Scroll':
      await evaluate(surfaceId, scrollScript(Math.round(input.dx), Math.round(input.dy)));

      return;
    case 'Type':
      await evaluate(surfaceId, editScript(input.text));

      return;
    case 'Press':
      if (input.key === 'Backspace' && (await evaluate<boolean>(surfaceId, editScript(null)))) return;
      await rpc('browser.press', { ...surface, key: input.key });

      return;
    case 'Navigate':
      await rpc('browser.navigate', { ...surface, url: normalizedUrl(input.url) });

      return;
    case 'Back':
      await rpc('browser.back', surface);

      return;
    case 'Forward':
      await rpc('browser.forward', surface);

      return;
    case 'Reload':
      await rpc('browser.reload', surface);

      return;
  }
};
