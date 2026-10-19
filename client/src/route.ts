export type Location = { readonly workspaceId: string | null; readonly surfaceId: string | null };

const PATH = /^\/w\/([^/]+)(?:\/s\/([^/]+))?\/?$/u;

export const locationOf = (pathname: string): Location => {
  const match = PATH.exec(pathname);

  if (!match) return { workspaceId: null, surfaceId: null };

  return { workspaceId: decodeURIComponent(match[1] ?? ''), surfaceId: match[2] ? decodeURIComponent(match[2]) : null };
};

export const pathOf = ({ workspaceId, surfaceId }: Location): string => {
  if (!workspaceId) return '/';

  if (!surfaceId) return `/w/${encodeURIComponent(workspaceId)}`;

  return `/w/${encodeURIComponent(workspaceId)}/s/${encodeURIComponent(surfaceId)}`;
};
