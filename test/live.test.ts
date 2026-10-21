import { describe, expect, it } from 'vitest';
import { clampRange, isStreamable, mimeOf } from '../daemon/files';
import { parseRange } from '../src/range';

describe('media ranges', () => {
  it('parses open and closed byte ranges and rejects suffix ranges', () => {
    expect(parseRange('bytes=0-')).toEqual({ start: 0, end: null });
    expect(parseRange('bytes=100-199')).toEqual({ start: 100, end: 199 });
    expect(parseRange('bytes=-500')).toBeNull();
    expect(parseRange(null)).toBeNull();
    expect(parseRange('items=0-1')).toBeNull();
  });

  it('clamps a range to the file and to one megabyte', () => {
    expect(clampRange(10, 0, null)).toEqual({ start: 0, end: 9 });
    expect(clampRange(10, 4, 100)).toEqual({ start: 4, end: 9 });
    expect(clampRange(5 * 1024 * 1024, 0, null)).toEqual({ start: 0, end: 1024 * 1024 - 1 });
    expect(clampRange(10, 50, null)).toEqual({ start: 9, end: 9 });
  });

  it('only streams images, video, audio and pdf', () => {
    expect(mimeOf('/a/baton-demo.MP4')).toBe('video/mp4');
    expect(isStreamable(mimeOf('x.png'))).toBe(true);
    expect(isStreamable(mimeOf('notes.txt'))).toBe(false);
  });
});
