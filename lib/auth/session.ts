import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Stateless session token: the cookie IS the session.
 *
 * WHY STATELESS
 * -------------
 * Vercel serverless functions do not share memory. A Map<sessionId, ...>
 * populated in one invocation is gone in the next, and the only thing that
 * survives is the request's cookies. Putting the session claims in a signed
 * cookie and verifying the signature on every read is the same approach every
 * production framework converges on for this reason.
 *
 * THE COOKIE SHAPE
 * ----------------
 *   <base64url(JSON payload)>.<base64url(HMAC-SHA256)>
 *
 * The payload is plain JSON: { sid, role, sub, slug?, buildingId?, floor?,
 * unit?, name?, iat, exp }. There is no encryption -- aadhar and phone are NOT
 * stored in the cookie. Only a session id, a role, a subject identifier, and
 * whatever building the citizen owns. The HMAC makes the payload tamper-proof;
 * it does not make it confidential, and the cookie carries nothing that would
 * hurt to leak.
 *
 * LOGOUT
 * ------
 * Stateless logout cannot truly revoke a token. The right answer for a demo
 * is to clear the cookie; the server no longer sees it, so it cannot trust
 * it. For a production deployment that needs real revocation, the
 * `_revoked` Set in this module can be moved to Redis (a SADD on issue, a
 * SISMEMBER on every read) without changing the cookie shape.
 *
 * THE SECRET
 * ----------
 * SESSION_SECRET must be set in production. In dev, a process-lifetime
 * random secret is generated on first use so a fresh checkout works without
 * a `.env`. The dev secret is unstable (rotates every server start), which
 * is what you want for a demo -- any cookie issued by the previous run is
 * immediately unverifiable, the user is bounced to /login.
 */

const COOKIE_NAME = 'ulpin_session';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h sliding
/**
 * Hard ceiling on a session's TOTAL lifetime, regardless of how often the
 * user is active. The 24h sliding window can keep refreshing a token forever;
 * this prevents that. A stolen cookie whose holder continues to be active is
 * still a stolen cookie, and the longer it lives the more the user has to
 * lose when it is rotated by the org or invalidated by a logout-everywhere.
 *
 * 30 days is the cap: long enough to be invisible to a normal user who
 * closes the browser for a weekend, short enough to bound the blast radius of
 * a leak. Lengthening it is a judgement call that goes into the decisions
 * log, not a number to bump.
 */
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type Role = 'citizen' | 'gov';

export interface CitizenClaims {
  sid: string;
  role: 'citizen';
  sub: string;          // aadhar (masked in logs)
  name: string;         // for the header greeting
  slug: string;         // project slug
  buildingId: number;   // the citizen's building
  floor: number;
  unit: string;
  iat: number;          // ms
  exp: number;          // ms
}

export interface GovClaims {
  sid: string;
  role: 'gov';
  sub: string;          // email
  name: string;         // for the header greeting
  iat: number;
  exp: number;
}

export type SessionClaims = CitizenClaims | GovClaims;

let _secret: Buffer | null = null;
let _revoked: Set<string> | null = null;

function getSecret(): Buffer {
  if (_secret) return _secret;
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    _secret = Buffer.from(fromEnv, 'utf-8');
  } else if (process.env.NODE_ENV === 'production') {
    // A missing SESSION_SECRET in production is a SIGN-IN LOOP WAITING TO
    // HAPPEN. Every cold-started Vercel instance signs with its own random
    // key; the next request may be served by a different instance that
    // cannot verify the previous one, and the user lands on /login with no
    // error. Refuse to start the request handler in that case rather than
    // letting it present as "wrong password".
    throw new Error(
      'SESSION_SECRET is required in production (NODE_ENV=production). '
      + 'Set it to a high-entropy string of at least 16 characters. '
      + 'See .env.example.',
    );
  } else {
    // Dev-only: random per process. A real deployment sets SESSION_SECRET.
    // Documented at the top of the file; not a bug, not a backdoor.
    //
    // It IS a bug the moment a second process exists. The login route signs
    // with this process's key and the next request may be served by another
    // process -- another Vercel lambda, another `next dev` worker, the same
    // server after a restart -- whose key is different. The signature check
    // then fails, currentSession() returns null, and the user lands back on
    // /login with no error shown. That reads as "wrong password" and is not.
    // Say so once, loudly, rather than letting it present as a login loop.
    console.warn(
      '[ulpin-auth] SESSION_SECRET is not set; signing sessions with a random '
      + 'per-process key. Sessions will NOT survive a server restart, and on any '
      + 'multi-process deployment (Vercel included) login will loop back to '
      + '/login because the verifying process has a different key. Set '
      + 'SESSION_SECRET to a stable high-entropy string -- see .env.example.',
    );
    _secret = randomBytes(32);
  }
  return _secret;
}

function getRevoked(): Set<string> {
  if (!_revoked) _revoked = new Set();
  return _revoked;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(s: string): Buffer {
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function sign(payload: string): string {
  return b64urlEncode(createHmac('sha256', getSecret()).update(payload).digest());
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Sign a claims object into a Set-Cookie value. */
export function encodeSession(claims: SessionClaims): string {
  const payload = b64urlEncode(Buffer.from(JSON.stringify(claims), 'utf-8'));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

/** Parse and verify a cookie value. Returns null on any failure. */
export function decodeSession(raw: string | undefined | null): SessionClaims | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sign(payload), sig)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payload).toString('utf-8'));
  } catch {
    return null;
  }
  if (!isClaims(parsed)) return null;
  const now = Date.now();
  // Two time checks, both enforced: the absolute ceiling so a token that
  // was somehow issued with a long exp cannot outlive the cap, and the
  // exp itself so an expired token is rejected even if the iat cap
  // was disabled by a malformed iat in the past.
  if (now > parsed.exp) return null;
  if (now > parsed.iat + MAX_SESSION_AGE_MS) return null;
  if (getRevoked().has(parsed.sid)) return null;
  return parsed;
}

/**
 * Validate the shape of a parsed JSON. Cheap, does not enforce role-specific
 * fields -- callers that need them (e.g. requireCitizen) check those.
 *
 * Number checks use Number.isFinite rather than `typeof === 'number'` so
 * NaN, Infinity and -Infinity are rejected. The cache key and the citizen
 * filters both treat claims as numbers in comparisons; a cookie carrying
 * `buildingId: NaN` would otherwise compare as "never equal to any real
 * id" and silently turn every filter into a no-op.
 */
function isClaims(v: unknown): v is SessionClaims {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.sid !== 'string' || o.sid.length === 0) return false;
  if (o.role !== 'citizen' && o.role !== 'gov') return false;
  if (typeof o.sub !== 'string' || o.sub.length === 0) return false;
  if (!Number.isFinite(o.iat) || !Number.isFinite(o.exp)) return false;
  // Hoist the two finite numbers so the rest of the function reads
  // them as `number` (Number.isFinite only narrows its own argument,
  // not other properties on the same object).
  const iat = o.iat as number;
  const exp = o.exp as number;
  if (exp <= iat) return false;
  if (o.role === 'citizen') {
    if (typeof o.slug !== 'string') return false;
    if (!Number.isFinite(o.buildingId)) return false;
    if (!Number.isFinite(o.floor)) return false;
    if (typeof o.unit !== 'string') return false;
    if (typeof o.name !== 'string') return false;
  } else {
    if (typeof o.name !== 'string') return false;
  }
  return true;
}

/** Build a citizen session. The aadhar is the subject, not stored. */
export function makeCitizenSession(input: {
  aadhar: string;
  name: string;
  slug: string;
  buildingId: number;
  floor: number;
  unit: string;
  ttlMs?: number;
}): CitizenClaims {
  const now = Date.now();
  // Clamp ttlMs to the absolute ceiling. A caller that asks for a 10-year
  // session is a bug or an attacker; the cap is the longest a session is
  // allowed to live regardless of how it was issued, and clamping at
  // issuance keeps decodeSession's read-time check (now > iat + 30d) and
  // buildSetCookie's write-time check from disagreeing.
  const requested = input.ttlMs ?? DEFAULT_TTL_MS;
  const ttl = Math.min(Math.max(requested, 0), MAX_SESSION_AGE_MS);
  return {
    sid: randomBytes(16).toString('hex'),
    role: 'citizen',
    sub: input.aadhar,
    name: input.name,
    slug: input.slug,
    buildingId: input.buildingId,
    floor: input.floor,
    unit: input.unit,
    iat: now,
    exp: now + ttl,
  };
}

export function makeGovSession(input: {
  email: string;
  name: string;
  ttlMs?: number;
}): GovClaims {
  const now = Date.now();
  const requested = input.ttlMs ?? DEFAULT_TTL_MS;
  const ttl = Math.min(Math.max(requested, 0), MAX_SESSION_AGE_MS);
  return {
    sid: randomBytes(16).toString('hex'),
    role: 'gov',
    sub: input.email,
    name: input.name,
    iat: now,
    exp: now + ttl,
  };
}

/** Read a session from a Cookie header string. Returns null if absent/invalid. */
export function sessionFromCookieHeader(cookieHeader: string | null): SessionClaims | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    // decodeURIComponent throws URIError on a malformed percent-encoded
    // sequence (e.g. "%E0%A4%A"). That would surface as a 500 from every
    // authed route, so the call is wrapped: a malformed value is treated
    // as an invalid cookie, same shape as a bad signature.
    let value: string;
    try {
      value = decodeURIComponent(p.slice(eq + 1));
    } catch {
      return null;
    }
    return decodeSession(value);
  }
  return null;
}

/** Build a Set-Cookie header value for the given claims. Sliding TTL. */
export function buildSetCookie(
  claims: SessionClaims,
  opts: { secure?: boolean; sameSite?: 'Lax' | 'Strict' | 'None' } = {},
): string {
  // Sliding refresh, but CAPPED at the original iat + MAX_SESSION_AGE_MS.
  //
  // The reason this matters: without the cap, every /api/me call advances
  // claims.exp by the full 24h, so a token that has been circulating for
  // 11 months is still "fresh" so long as the holder visits once a day.
  // The cookie is HMAC-signed, so it cannot be tampered with, but a leak
  // is a leak and the longer a leaked cookie is valid the more the
  // holder has to lose when it is later revoked. We refresh the wall
  // clock to "now + TTL" only as long as the absolute age stays within
  // the cap; past that we keep the existing exp, which is strictly less
  // useful to the user (the cookie expires on schedule) and strictly
  // safer for everyone else.
  const now = Date.now();
  const absoluteCeiling = claims.iat + MAX_SESSION_AGE_MS;
  const slidingCeiling = now + DEFAULT_TTL_MS;
  // Drop `claims.exp` from the min. claims.exp was set at login to
  // `login_time + DEFAULT_TTL_MS`; for any session older than a few
  // seconds, `claims.exp <= slidingCeiling` and the min would pick
  // `claims.exp`, leaving the wall clock at its original position and
  // silently expiring the session the moment the original 24h is up
  // regardless of activity. The intent is to refresh to now + TTL only
  // as long as the absolute age stays within the cap, so the min is
  // over the two ceilings, not the old exp.
  const newExp = Math.min(slidingCeiling, absoluteCeiling);
  const value = encodeSession(newExp === claims.exp ? claims : { ...claims, exp: newExp });
  const remaining = Math.max(0, Math.floor((newExp - now) / 1000));
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${remaining}`,
    `SameSite=${opts.sameSite ?? 'Lax'}`,
  ];
  if (opts.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}

/**
 * Best-effort detection of whether the current request is over HTTPS. We
 * trust x-forwarded-proto because the app runs behind Vercel's edge and
 * behind any local reverse proxy that uses the same header. Falling back
 * to the request URL's protocol keeps a direct-https local server honest
 * and a direct-http local server safe (a Secure cookie would not round-
 * trip on plain HTTP and the user would silently be signed out).
 */
export function isHttpsRequest(req: Request): boolean {
  const fwd = req.headers.get('x-forwarded-proto');
  if (fwd) return fwd.toLowerCase().startsWith('https');
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Clear the session cookie. `secure` is set on HTTPS so the browser
 *  drops the cookie regardless of protocol; the dev-server case (HTTP)
 *  stays insecure so a clear-cookie on a plain-HTTP localhost still works. */
export function buildClearCookie(opts: { secure?: boolean } = {}): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=Lax`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Revoke a session id (in-memory only; for production, move to Redis). */
export function revokeSession(sid: string): void {
  getRevoked().add(sid);
}

/** Visible for tests: forget all state. */
export function _resetForTests(): void {
  _secret = null;
  _revoked = null;
}

/** Visible for tests: cookie name. */
export const SESSION_COOKIE_NAME = COOKIE_NAME;
