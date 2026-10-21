const RANGE = /^bytes=(\d*)-(\d*)$/u;

export const parseRange = (header: string | null): { readonly start: number; readonly end: number | null } | null => {
  const match = header ? RANGE.exec(header.trim()) : null;

  if (!match || (match[1] === '' && match[2] === '')) return null;

  if (match[1] === '') return null;

  return { start: Number(match[1]), end: match[2] === '' ? null : Number(match[2]) };
};
