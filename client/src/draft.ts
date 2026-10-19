const KEY = (surfaceId: string) => `porch:draft:${surfaceId}`;

export const storedDraft = (surfaceId: string | null): string => {
  if (!surfaceId) return '';

  try {
    return globalThis.localStorage.getItem(KEY(surfaceId)) ?? '';
  } catch {
    return '';
  }
};

export const saveDraft = (surfaceId: string, value: string) => {
  try {
    if (value) globalThis.localStorage.setItem(KEY(surfaceId), value);
    else globalThis.localStorage.removeItem(KEY(surfaceId));
  } catch {
    return;
  }
};
