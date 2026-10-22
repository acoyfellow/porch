export type RealtimeEnv = { readonly REALTIME_APP_ID?: string; readonly REALTIME_TOKEN?: string };

export type RealtimeRole = 'producer' | 'viewer';

const SESSION_PATH = /^\/api\/rtc\/sessions\/([A-Za-z0-9_-]{1,128})\/(tracks|renegotiate|close)$/u;

const upstream = (env: RealtimeEnv, path: string, method: string, body: string | undefined) =>
  fetch(`https://rtc.live.cloudflare.com/v1/apps/${env.REALTIME_APP_ID}${path}`, {
    method,
    headers: { authorization: `Bearer ${env.REALTIME_TOKEN}`, 'content-type': 'application/json' },
    body,
  });

const relayed = async (response: Response) => new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } });

type TrackRequest = { readonly tracks?: ReadonlyArray<{ readonly location?: string; readonly sessionId?: string }> };

const pullsOnlyFrom = (body: string, producerSessions: ReadonlySet<string>): boolean => {
  const parsed = JSON.parse(body || '{}') as TrackRequest;

  return (parsed.tracks ?? []).every((track) => track.location !== 'remote' || (track.sessionId !== undefined && producerSessions.has(track.sessionId)));
};

const pushesNothing = (body: string): boolean => ((JSON.parse(body || '{}') as TrackRequest).tracks ?? []).every((track) => track.location === 'remote');

export type RealtimeGuard = {
  readonly ownsSession: (sessionId: string) => Promise<boolean>;
  readonly claimSession: (sessionId: string) => Promise<void>;
  readonly producerSessions: () => Promise<ReadonlySet<string>>;
  readonly publish: (surfaceId: string, sessionId: string, trackName: string) => Promise<void>;
  readonly unpublish: (sessionId: string) => Promise<void>;
};

export const handleRealtime = async (request: Request, env: RealtimeEnv, role: RealtimeRole, guard: RealtimeGuard): Promise<Response> => {
  if (!env.REALTIME_APP_ID || !env.REALTIME_TOKEN) return Response.json({ error: 'realtime is not configured' }, { status: 503 });
  const { pathname } = new URL(request.url);
  const body = request.method === 'GET' ? undefined : await request.text();

  if (pathname === '/api/rtc/sessions' && request.method === 'POST') {
    const response = await upstream(env, '/sessions/new', 'POST', body);
    const json = (await response.json()) as { readonly sessionId?: string };

    if (response.ok && json.sessionId) await guard.claimSession(json.sessionId);

    return Response.json(json, { status: response.status });
  }
  const match = SESSION_PATH.exec(pathname);

  if (!match) return new Response('not found', { status: 404 });
  const [, sessionId = '', action] = match;

  if (!(await guard.ownsSession(sessionId))) return new Response('not your session', { status: 403 });

  if (action === 'tracks' && request.method === 'POST') {
    if (role === 'viewer' && !pushesNothing(body ?? '')) return new Response('viewers can only pull', { status: 403 });

    if (role === 'viewer' && !pullsOnlyFrom(body ?? '', await guard.producerSessions())) return new Response('viewers can only pull the porch producer', { status: 403 });

    return relayed(await upstream(env, `/sessions/${sessionId}/tracks/new`, 'POST', body));
  }

  if (action === 'renegotiate' && request.method === 'PUT') return relayed(await upstream(env, `/sessions/${sessionId}/renegotiate`, 'PUT', body));

  if (action === 'close' && request.method === 'PUT') return relayed(await upstream(env, `/sessions/${sessionId}/tracks/close`, 'PUT', body));

  return new Response('method not allowed', { status: 405 });
};

const MID = /^a=mid:(\S+)$/gmu;

export const midsOf = (sdp: string): ReadonlyArray<string> => [...sdp.matchAll(MID)].flatMap((match) => (match[1] ? [match[1]] : []));

export const trackNameOf = (surfaceId: string, mid: string) => `pane-${surfaceId}-${mid}`;

const WHIP_RESOURCE = /^\/api\/rtc\/whip\/session\/([A-Za-z0-9_-]{1,128})$/u;

const WHIP_PUBLISH = /^\/api\/rtc\/whip\/pane\/([A-Za-z0-9-]{1,64})$/u;

export const handleWhip = async (request: Request, env: RealtimeEnv, guard: RealtimeGuard): Promise<Response> => {
  if (!env.REALTIME_APP_ID || !env.REALTIME_TOKEN) return new Response('realtime is not configured', { status: 503 });
  const url = new URL(request.url);
  const resource = WHIP_RESOURCE.exec(url.pathname);

  if (resource && request.method === 'DELETE') {
    const sessionId = resource[1] ?? '';
    await guard.unpublish(sessionId);
    await upstream(env, `/sessions/${sessionId}/tracks/close`, 'PUT', JSON.stringify({ tracks: [], force: true })).catch(() => undefined);

    return new Response(null, { status: 200 });
  }
  const publish = WHIP_PUBLISH.exec(url.pathname);
  const surfaceId = publish?.[1] ?? url.searchParams.get('surface');

  if (!surfaceId || request.method !== 'POST' || (!publish && url.pathname !== '/api/rtc/whip')) return new Response('not found', { status: 404 });
  const offer = await request.text();
  const mids = midsOf(offer);

  if (mids.length === 0) return new Response('offer has no media', { status: 400 });
  const created = (await (await upstream(env, '/sessions/new', 'POST', undefined)).json()) as { readonly sessionId?: string };

  if (!created.sessionId) return new Response('could not open a realtime session', { status: 502 });
  const tracks = mids.map((mid) => ({ location: 'local', mid, trackName: trackNameOf(surfaceId, mid) }));
  const pushed = await upstream(env, `/sessions/${created.sessionId}/tracks/new`, 'POST', JSON.stringify({ sessionDescription: { type: 'offer', sdp: offer }, tracks }));
  const answer = (await pushed.json()) as { readonly sessionDescription?: { readonly sdp?: string }; readonly errorDescription?: string };

  if (!pushed.ok || !answer.sessionDescription?.sdp) return new Response(answer.errorDescription ?? 'realtime refused the offer', { status: 502 });
  await guard.publish(surfaceId, created.sessionId, tracks[0]?.trackName ?? '');

  return new Response(answer.sessionDescription.sdp, { status: 201, headers: { 'content-type': 'application/sdp', location: `/api/rtc/whip/session/${created.sessionId}` } });
};
