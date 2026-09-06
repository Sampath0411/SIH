/**
 * The caller's identity, as far as a cached response body depends on it.
 *
 * NO `next/*` IMPORTS, deliberately, and for the same reason
 * lib/auth/access-pure.ts has none: this is the key that decides whose
 * document a memo hands back, so it has to be testable from a plain Node
 * script rather than only through a running server.
 */

import type { CallerContext } from '@/lib/auth/access-pure';

/**
 * Pull the caller's identity out of a raw Cookie header.
 *
 * THE ROLE ALONE IS NOT ENOUGH, and keying a response memo on it was a live
 * data leak. `filterDetailForCaller` narrows a citizen's building document to
 * their own flat using (slug, buildingId, floor, unit) from their session --
 * so two citizens asking for the same URL must get two different bodies. With
 * `citizen` as the whole tag they shared one memo entry, and whoever warmed it
 * decided what everybody else saw: the second and third residents of the demo
 * tower were served the FIRST resident's flat -- his ULPIN, name, address,
 * encumbrance and register -- and could not reach their own flat at all. It
 * read as "the citizen view is broken for me" and was really one cache key
 * short of the filter it was caching.
 *
 * So the tag carries exactly the claims a filter reads, and nothing else:
 * whatever narrows the body has to be in the key, and anything that does not
 * (the session id, the issue time, the holder's name) would only fragment the
 * cache. `sub` is deliberately absent -- it is the aadhar, it does not change
 * what is served, and it has no business in a cache key.
 *
 * The header is parsed inline rather than through the runtime's cookie jar
 * because the callers of this module must not pull in `next/headers`, which is
 * runtime-only. The format is fixed: a single `ulpin_session=...` entry, which
 * is all the login routes set.
 *
 * The signature is NOT verified here. That is the access layer's job and it has
 * already run by the time a route reaches the payload layer; a forged cookie is
 * refused there, and the worst one could do to this key is claim its own
 * private memo slot.
 *
 * USE callerTagFromCtx WHEN THE VERIFIED CONTEXT IS AVAILABLE. This cookie
 * parser is a fallback for callers that have not yet resolved the session --
 * it under-segments in the presence of a forged cookie claiming to be a
 * citizen of a real building, which is the cache-poisoning shape the
 * CallerContext-aware version is the fix for.
 */
export function callerTagFromCookie(cookieHeader: string | null): string {
  if (!cookieHeader) return 'anon';
  const m = /(?:^|;\s*)ulpin_session=([^;]+)/.exec(cookieHeader);
  if (!m) return 'anon';
  // The token is base64url(payload).base64url(sig). Only the first segment is
  // needed, and it is JSON.
  try {
    const payload = m[1].split('.')[0];
    // base64url -> base64
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - payload.length % 4) % 4);
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    const c = JSON.parse(json) as {
      role?: string; slug?: string; buildingId?: number;
      floor?: number; unit?: string;
    };
    if (c.role !== 'citizen') return c.role ?? 'anon';
    // Every input the citizen filters read.
    return `citizen:${c.slug ?? '?'}:${c.buildingId ?? '?'}:${c.floor ?? '?'}:${c.unit ?? '?'}`;
  } catch {
    return 'anon';
  }
}

/**
 * The verified identity, expressed as a memo key.
 *
 * This is the tag the response cache actually uses. It carries the same
 * claims as callerTagFromCookie -- (slug, buildingId, floor, unit) for a
 * citizen, the role for everyone else -- but sourced from the *verified*
 * CallerContext, not from the raw cookie.
 *
 * WHY THE DIFFERENCE MATTERS. With callerTagFromCookie as the key, a
 * request whose signature fails to verify (verified ctx === 'anon') is
 * cached under whatever the forged cookie claimed. An attacker who knows
 * a real citizen's (slug, buildingId, floor, unit) -- all four are in
 * every building response and in devtools -- can flood the endpoint
 * with that forged claim; the verified handler builds the FULL body (no
 * citizen filter, because the verified ctx is anon); the full body lands
 * in the memo under the citizen's key. The real citizen's next request
 * hits the cache and reads the full, unfiltered document. They see every
 * neighbour's ULPIN, name, encumbrance.
 *
 * The fix is to use the verified identity, which is what this function
 * returns. A request whose signature fails to verify has ctx.kind ===
 * 'anon' and lands in the 'anon' bucket; a real citizen lands in their
 * own bucket; the two do not collide.
 */
export function callerTagFromCtx(ctx: CallerContext): string {
  if (ctx.kind === 'citizen') {
    return `citizen:${ctx.slug}:${ctx.buildingId}:${ctx.floor}:${ctx.unit}`;
  }
  return ctx.kind;
}
