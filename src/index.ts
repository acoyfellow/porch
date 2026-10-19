import { type Caller, verifyAccess } from './access';
import { appPage } from './page';

export { Relay } from './relay';

export type Env = {
  readonly RELAY: DurableObjectNamespace;
  readonly ASSETS: Fetcher;
  readonly ACCESS_TEAM: string;
  readonly ACCESS_AUD: string;
  readonly OWNER_EMAIL: string;
  readonly DAEMON_TOKEN_ID: string;
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

const route = async (request: Request, env: Env, caller: Caller): Promise<Response> => {
  const { pathname } = new URL(request.url);

  if (pathname === '/daemon') return isDaemon(caller, env) ? forward(request, env, '/daemon') : new Response('forbidden', { status: 403 });

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
    const caller = await verifyAccess(request, env.ACCESS_TEAM, env.ACCESS_AUD);

    if (!caller) return secured(new Response('sign in through Cloudflare Access', { status: 401 }));

    return secured(await route(request, env, caller));
  },
} satisfies ExportedHandler<Env>;
