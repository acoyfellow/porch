import { type Caller, verifyAccess } from './access';
import { handleMcp } from './mcp';
import { handleRealtime, handleWhip, type RealtimeGuard } from './realtime';
import { appPage } from './page';

export { Relay } from './relay';

export type Env = {
  readonly RELAY: DurableObjectNamespace;
  readonly ASSETS: Fetcher;
  readonly ACCESS_TEAM: string;
  readonly ACCESS_AUD: string;
  readonly OWNER_EMAIL: string;
  readonly DAEMON_TOKEN_ID: string;
  readonly MCP_TOKEN_ID?: string;
  readonly REALTIME_APP_ID?: string;
  readonly REALTIME_TOKEN?: string;
  readonly DEV_CALLER?: string;
};

const RELAY_NAME = 'owner';

const API = new Map<string, string>([
  ['/api/sidebar', '/sidebar'],
  ['/api/machine', '/machine'],
  ['/api/send', '/send'],
  ['/api/frame', '/frame'],
  ['/api/key', '/key'],
]);

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const secured = (response: Response): Response => {
  if (response.status === 101) return response;
  const copy = new Response(response.body, response);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) copy.headers.set(name, value);

  return copy;
};

const isOwner = (caller: Caller, env: Env) => caller.kind === 'person' && caller.email === env.OWNER_EMAIL.toLowerCase();

const isDaemon = (caller: Caller, env: Env) => caller.kind === 'machine' && caller.tokenId === env.DAEMON_TOKEN_ID;

const isMcpClient = (caller: Caller, env: Env) => isOwner(caller, env) || (caller.kind === 'machine' && env.MCP_TOKEN_ID !== undefined && caller.tokenId === env.MCP_TOKEN_ID);

const relayCall = (request: Request, env: Env) => (path: string, init?: RequestInit) => relay(env).fetch(new Request(new URL(path, new URL(request.url).origin), init));

const relayJson = async <T>(env: Env, path: string, body?: unknown): Promise<T> =>
  (await relay(env).fetch(new Request(`https://relay${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).json() as Promise<T>;

const realtimeGuard = (env: Env, owner: string): RealtimeGuard => ({
  ownsSession: async (sessionId) => (await relayJson<{ owns: boolean }>(env, `/rtc/owns?${new URLSearchParams({ session: sessionId, owner })}`)).owns,
  claimSession: async (sessionId) => void (await relayJson(env, '/rtc/claim', { sessionId, owner })),
  producerSessions: async () => new Set((await relayJson<{ sessions: ReadonlyArray<string> }>(env, '/rtc/producers')).sessions),
  publish: async (surfaceId, sessionId, trackName) => void (await relayJson(env, '/rtc/publish', { surfaceId, sessionId, trackName })),
  unpublish: async (sessionId) => void (await relayJson(env, '/rtc/unpublish', { sessionId })),
});

const ownerKey = (caller: Caller) => (caller.kind === 'person' ? `person:${caller.email}` : `machine:${caller.tokenId}`);

const sameOrigin = (request: Request) => {
  const origin = request.headers.get('origin');

  return origin === null || origin === new URL(request.url).origin;
};

const relay = (env: Env) => env.RELAY.get(env.RELAY.idFromName(RELAY_NAME));

const forward = (request: Request, env: Env, path: string) => {
  const url = new URL(request.url);
  url.pathname = path;

  return relay(env).fetch(new Request(url, request));
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

const devCaller = (request: Request, env: Env): Caller | null => {
  if (env.DEV_CALLER !== 'local' || !LOCAL_HOSTS.has(new URL(request.url).hostname)) return null;

  if (new URL(request.url).pathname === '/daemon') return { kind: 'machine', tokenId: env.DAEMON_TOKEN_ID };

  if (request.headers.get('x-porch-dev-caller') === 'mcp' && env.MCP_TOKEN_ID) return { kind: 'machine', tokenId: env.MCP_TOKEN_ID };

  if (request.headers.get('x-porch-dev-caller') === 'stranger') return { kind: 'machine', tokenId: 'stranger' };

  return { kind: 'person', email: env.OWNER_EMAIL.toLowerCase() };
};

const route = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === '/daemon') return isDaemon(caller, env) ? forward(request, env, '/daemon') : new Response('forbidden', { status: 403 });

  if (pathname === '/api/focus' && request.method === 'POST')
    return isMcpClient(caller, env) ? relay(env).fetch(new Request('https://relay/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await request.text() })) : new Response('forbidden', { status: 403 });

  if (pathname.startsWith('/api/rtc/whip')) return isDaemon(caller, env) ? handleWhip(request, env, realtimeGuard(env, 'producer')) : new Response('forbidden', { status: 403 });

  if (pathname.startsWith('/api/rtc/')) return isMcpClient(caller, env) ? handleRealtime(request, env, 'viewer', realtimeGuard(env, ownerKey(caller))) : new Response('forbidden', { status: 403 });

  if (pathname === '/api/media') return isMcpClient(caller, env) ? forward(request, env, '/media') : new Response('forbidden', { status: 403 });

  if (pathname === '/phone' && !isOwner(caller, env) && isMcpClient(caller, env)) return forward(request, env, '/phone-watch');

  if (pathname === '/mcp') return isMcpClient(caller, env) ? handleMcp(request, relayCall(request, env)) : new Response('forbidden', { status: 403 });

  if (!isOwner(caller, env) && isMcpClient(caller, env) && (pathname === '/' || pathname.startsWith('/w/')) && request.method === 'GET') return appPage('');

  if (!isOwner(caller, env) && isMcpClient(caller, env) && request.method === 'GET' && !pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

  if (!isOwner(caller, env)) return new Response('forbidden', { status: 403 });

  if (!sameOrigin(request)) return new Response('cross-origin request refused', { status: 403 });

  if (pathname === '/phone') return forward(request, env, '/phone');
  const api = API.get(pathname);

  if (api) return forward(request, env, api);

  if (pathname === '/' || pathname.startsWith('/w/')) return appPage(caller.kind === 'person' ? caller.email : '');

  return env.ASSETS.fetch(request);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const caller = devCaller(request, env) ?? (await verifyAccess(request, env.ACCESS_TEAM, env.ACCESS_AUD));

    if (!caller) return secured(new Response('sign in through Cloudflare Access', { status: 401 }));

    return secured(await route(request, env, caller));
  },
} satisfies ExportedHandler<Env>;
