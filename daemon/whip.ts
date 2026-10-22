export type WhipProxy = { readonly url: (surfaceId: string) => string; readonly unpublish: (surfaceId: string) => Promise<void>; readonly stop: () => void };

type Credentials = { readonly origin: string; readonly clientId: string; readonly clientSecret: string };

const FORWARDED = /^\/whip\/(pane\/[A-Za-z0-9-]{1,64}|session\/[A-Za-z0-9_-]{1,128})$/u;

export const startWhipProxy = (credentials: Credentials): WhipProxy => {
  const sessions = new Map<string, string>();
  const authHeaders = { 'cf-access-client-id': credentials.clientId, 'cf-access-client-secret': credentials.clientSecret };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const path = FORWARDED.exec(new URL(request.url).pathname)?.[1];

      if (!path) return new Response('not found', { status: 404 });
      const upstream = await fetch(new URL(`/api/rtc/whip/${path}`, credentials.origin), {
        method: request.method,
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/sdp', 'cf-access-client-id': credentials.clientId, 'cf-access-client-secret': credentials.clientSecret },
        body: request.method === 'POST' ? await request.text() : undefined,
        redirect: 'manual',
      });
      const location = upstream.headers.get('location');
      const surfaceId = path.startsWith('pane/') ? path.slice('pane/'.length) : null;

      if (surfaceId && location) sessions.set(surfaceId, location);
      const headers = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/sdp' });

      if (location?.startsWith('/api/rtc/whip/')) headers.set('location', location.replace('/api/rtc/whip/', '/whip/'));

      return new Response(upstream.body, { status: upstream.status, headers });
    },
  });

  return {
    url: (surfaceId) => `http://127.0.0.1:${server.port}/whip/pane/${surfaceId}`,
    unpublish: async (surfaceId) => {
      const location = sessions.get(surfaceId);
      sessions.delete(surfaceId);

      if (location) await fetch(new URL(location, credentials.origin), { method: 'DELETE', headers: authHeaders, redirect: 'manual' }).catch(() => undefined);
    },
    stop: () => server.stop(true),
  };
};
