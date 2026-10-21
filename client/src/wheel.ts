import { sendBrowser } from './socket';

const FLUSH_MS = 60;

let pending = { dx: 0, dy: 0 };
let timer: ReturnType<typeof setTimeout> | null = null;

const surfaceFromPath = (): string | null => /\/s\/([^/]+)/u.exec(globalThis.location.pathname)?.[1] ?? null;

const flush = () => {
  timer = null;
  const surfaceId = surfaceFromPath();
  const { dx, dy } = pending;
  pending = { dx: 0, dy: 0 };

  if (surfaceId && (dx !== 0 || dy !== 0)) sendBrowser(decodeURIComponent(surfaceId), { _tag: 'Scroll', dx, dy });
};

const scaleOf = (image: HTMLImageElement): number => {
  const natural = Number(image.dataset['pageWidth'] ?? '0');

  return natural > 0 && image.clientWidth > 0 ? natural / image.clientWidth : 1;
};

export const installScreenWheel = () => {
  document.addEventListener(
    'wheel',
    (event) => {
      const target = event.target;

      if (!(target instanceof HTMLImageElement) || target.id !== 'screen') return;
      event.preventDefault();
      const scale = scaleOf(target);
      pending = { dx: pending.dx + event.deltaX * scale, dy: pending.dy + event.deltaY * scale };
      timer ??= setTimeout(flush, FLUSH_MS);
    },
    { passive: false },
  );
};
