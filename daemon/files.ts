import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { MAX_MEDIA_CHUNK } from '../shared/protocol';

const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.wav', 'audio/wav'],
  ['.pdf', 'application/pdf'],
]);

export const mimeOf = (path: string): string => MIME_BY_EXTENSION.get(extname(path).toLowerCase()) ?? 'application/octet-stream';

export const isStreamable = (mime: string): boolean => mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf';

export type FileInfo = { readonly name: string; readonly mime: string; readonly size: number };

export const fileInfo = async (path: string): Promise<FileInfo> => {
  const info = await stat(path);

  return { name: basename(path), mime: mimeOf(path), size: info.size };
};

export type Chunk = { readonly start: number; readonly end: number; readonly total: number; readonly bytes: Uint8Array };

export const clampRange = (total: number, start: number, end: number | null): { readonly start: number; readonly end: number } => {
  const first = Math.max(0, Math.min(start, Math.max(0, total - 1)));
  const wanted = end === null ? total - 1 : Math.min(end, total - 1);

  return { start: first, end: Math.max(first, Math.min(wanted, first + MAX_MEDIA_CHUNK - 1)) };
};

export const readChunk = async (path: string, start: number, end: number | null): Promise<Chunk> => {
  const handle = await open(path, 'r');

  try {
    const total = (await handle.stat()).size;
    const range = clampRange(total, start, end);
    const length = total === 0 ? 0 : range.end - range.start + 1;
    const bytes = new Uint8Array(length);
    await handle.read(bytes, 0, length, range.start);

    return { start: range.start, end: range.end, total, bytes };
  } finally {
    await handle.close();
  }
};
