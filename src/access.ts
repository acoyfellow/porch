export type Caller = { readonly kind: 'person'; readonly email: string } | { readonly kind: 'machine'; readonly tokenId: string };

type Jwk = JsonWebKey & { readonly kid: string };

type Claims = {
  readonly aud?: string | ReadonlyArray<string>;
  readonly exp?: number;
  readonly iss?: string;
  readonly email?: string;
  readonly common_name?: string;
  readonly sub?: string;
  readonly type?: string;
};

const decodeSegment = (segment: string): Uint8Array => {
  const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');

  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const parseJson = <T>(bytes: Uint8Array): T | null => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

const certCache = new Map<string, { readonly keys: ReadonlyArray<Jwk>; readonly at: number }>();

const CERT_TTL_MS = 10 * 60 * 1000;

const teamKeys = async (team: string): Promise<ReadonlyArray<Jwk>> => {
  const cached = certCache.get(team);

  if (cached && Date.now() - cached.at < CERT_TTL_MS) return cached.keys;
  const response = await fetch(`${team}/cdn-cgi/access/certs`);
  const body = (await response.json()) as { readonly keys?: ReadonlyArray<Jwk> };
  const keys = body.keys ?? [];
  certCache.set(team, { keys, at: Date.now() });

  return keys;
};

const audienceMatches = (aud: Claims['aud'], expected: string) => (Array.isArray(aud) ? aud.includes(expected) : aud === expected);

export const callerOf = (claims: Claims): Caller | null => {
  if (claims.email) return { kind: 'person', email: claims.email.toLowerCase() };

  if (claims.common_name) return { kind: 'machine', tokenId: claims.common_name };

  return null;
};

export const verifyAccess = async (request: Request, team: string, audience: string): Promise<Caller | null> => {
  const token = request.headers.get('cf-access-jwt-assertion');

  if (!token) return null;
  const [headerPart, payloadPart, signaturePart] = token.split('.');

  if (!headerPart || !payloadPart || !signaturePart) return null;
  const header = parseJson<{ readonly kid?: string; readonly alg?: string }>(decodeSegment(headerPart));
  const claims = parseJson<Claims>(decodeSegment(payloadPart));

  if (!header?.kid || header.alg !== 'RS256' || !claims) return null;

  if (!audienceMatches(claims.aud, audience) || (claims.exp ?? 0) * 1000 < Date.now() || claims.iss !== team) return null;
  const jwk = (await teamKeys(team)).find((key) => key.kid === header.kid);

  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeSegment(signaturePart), signed);

  return valid ? callerOf(claims) : null;
};
