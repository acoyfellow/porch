import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const BRAND = new URL('.', import.meta.url).pathname;
const OUT = join(BRAND, '..', 'public');
const BACKGROUND = '#0b0c0f';

type Raster = { readonly source: string; readonly file: string; readonly width: number; readonly height?: number };

const RASTERS: ReadonlyArray<Raster> = [
  { source: 'mark.svg', file: 'favicon-32.png', width: 32 },
  { source: 'mark.svg', file: 'favicon-16.png', width: 16 },
  { source: 'mark.svg', file: 'icon-192.png', width: 192 },
  { source: 'mark.svg', file: 'icon-512.png', width: 512 },
  { source: 'maskable.svg', file: 'icon-maskable-512.png', width: 512 },
  { source: 'maskable.svg', file: 'apple-touch-icon.png', width: 180 },
  { source: 'og.svg', file: 'og.png', width: 1200, height: 630 },
];

const render = async (raster: Raster) => {
  const svg = await readFile(join(BRAND, raster.source));
  const image = sharp(svg, { density: 384 }).resize(raster.width, raster.height ?? raster.width);
  const png = await (raster.source === 'mark.svg' ? image : image.flatten({ background: BACKGROUND })).png().toBuffer();
  await writeFile(join(OUT, raster.file), png);

  return `${raster.file} ${png.length}B`;
};

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'favicon.svg'), await readFile(join(BRAND, 'mark.svg')));
console.log((await Promise.all(RASTERS.map(render))).join('\n'));
