// scripts/test_auth.mjs
//
// Functional test of the auth foundation -- session encode/decode,
// role-aware building access, and a dry-run of the citizen filter
// applied to a real building document.
//
// USAGE:
//   npm run auth:test
//
// The script does NOT spin up Next.js or start a dev server. It loads
// the auth modules directly via the dynamic-import trick that
// scripts/test_cache.mjs established, and exercises the pure parts:
//   - encode/decode round trip
//   - role discrimination (citizen vs gov)
//   - checkBuildingAccess on a not-yours id
//   - the citizen filter on a real buildings.json FeatureCollection
//
// What is NOT tested here is the route handlers themselves -- those
// need a running server and are covered by the Playwright probe.

process.env.SESSION_SECRET = process.env.SESSION_SECRET
  ?? 'test-secret-do-not-use-in-prod-12345678';

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { encodeSession, decodeSession, makeCitizenSession, makeGovSession,
  _resetForTests, buildSetCookie, buildClearCookie } =
  await import('../lib/auth/session.ts');
const { checkBuildingAccess, checkMutation, checkProjectAccess,
  isMutator, ownsUnit, filterDetailForCaller, callerContext: _cc } =
  await import('../lib/auth/access-pure.ts');
const { callerTagFromCookie, callerTagFromCtx } = await import('../lib/http/caller-tag.ts');

let pass = 0, fail = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(() => { _resetForTests(); return fn(); })
    .then(() => { console.log(`  ok  ${name}`); pass++; })
    .catch((e) => { console.log(`  not ok  ${name}\n         ${e.stack || e.message}`); fail++; });
}

console.log('Auth foundation tests:\n');

// ---- session round trip ----------------------------------------------------
await test('encodeSession + decodeSession: round trip', () => {
  const claims = makeCitizenSession({
    aadhar: '111122223333',
    name: 'Ravi Kumar',
    slug: 'siripuram',
    buildingId: 999,
    floor: 2,
    unit: 'F-1',
  });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.ok(parsed, 'decode should yield a claims object');
  assert.equal(parsed.role, 'citizen');
  assert.equal(parsed.sub, '111122223333');
  assert.equal(parsed.buildingId, 999);
  assert.equal(parsed.floor, 2);
  assert.equal(parsed.unit, 'F-1');
});

await test('encodeSession + decodeSession: gov claims', () => {
  const claims = makeGovSession({ email: 'admin@sampath.gov.in', name: 'admin' });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.ok(parsed, 'decode should yield a claims object');
  assert.equal(parsed.role, 'gov');
  assert.equal(parsed.sub, 'admin@sampath.gov.in');
});

await test('decodeSession: tampered signature returns null', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a' });
  const token = encodeSession(claims);
  // Flip a byte in the signature half.
  const dot = token.lastIndexOf('.');
  const tampered = token.slice(0, dot + 1) + 'AAAA' + token.slice(dot + 5);
  const parsed = decodeSession(tampered);
  assert.equal(parsed, null, 'tampered token must not decode');
});

await test('decodeSession: expired token returns null', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a', ttlMs: -10 });
  const token = encodeSession(claims);
  const parsed = decodeSession(token);
  assert.equal(parsed, null, 'expired token must not decode');
});

await test('decodeSession: missing token returns null', () => {
  assert.equal(decodeSession(undefined), null);
  assert.equal(decodeSession(''), null);
  assert.equal(decodeSession('not-a-token'), null);
});

// ---- cookie shape ----------------------------------------------------------
await test('buildSetCookie: HttpOnly, SameSite=Lax, Max-Age present', () => {
  const claims = makeGovSession({ email: 'a@b.com', name: 'a' });
  const cookie = buildSetCookie(claims);
  assert.ok(cookie.includes('ulpin_session='), 'should set the cookie name');
  assert.ok(cookie.includes('HttpOnly'), 'should mark HttpOnly');
  assert.ok(cookie.includes('SameSite=Lax'), 'should use SameSite=Lax');
  assert.ok(/Max-Age=\d+/.test(cookie), 'should set Max-Age');
});

await test('buildClearCookie: zeros the cookie', () => {
  const cookie = buildClearCookie();
  assert.ok(cookie.includes('ulpin_session='), 'should target the cookie name');
  assert.ok(cookie.includes('Max-Age=0'), 'should expire immediately');
});

// ---- role-aware access -----------------------------------------------------
const mkRes = (status) => ({ status, headers: new Map() });

await test('checkBuildingAccess: anon passes', () => {
  const r = checkBuildingAccess({ kind: 'anon' }, 'siripuram', 999);
  assert.equal(r, null);
});

await test('checkBuildingAccess: gov passes', () => {
  const r = checkBuildingAccess({ kind: 'gov' }, 'siripuram', 999);
  assert.equal(r, null);
});

await test('checkBuildingAccess: citizen on their own building passes', () => {
  const r = checkBuildingAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'siripuram', 999,
  );
  assert.equal(r, null);
});

await test('checkBuildingAccess: citizen on a different building is 404', () => {
  const r = checkBuildingAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'siripuram', 193,
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404, 'must be 404 not 403, to avoid leaking which ids exist');
});

await test('checkProjectAccess: citizen on a different project is 404', () => {
  const r = checkProjectAccess(
    { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' },
    'hyderabad-banjara',
  );
  assert.ok(r, 'expected a 404 response');
  assert.equal(r.status, 404);
});

await test('isMutator: only gov can mutate', () => {
  assert.equal(isMutator({ kind: 'gov' }), true);
  assert.equal(isMutator({ kind: 'citizen', slug: 'a', buildingId: 1, floor: 1, unit: '101' }), false);
  assert.equal(isMutator({ kind: 'anon' }), false);
});

await test('checkMutation: citizen gets 403, anon gets 401', () => {
  const citizen = checkMutation({ kind: 'citizen', slug: 'a', buildingId: 1, floor: 1, unit: '101' });
  assert.equal(citizen.status, 403);
  const anon = checkMutation({ kind: 'anon' });
  assert.equal(anon.status, 401);
  assert.equal(checkMutation({ kind: 'gov' }), null);
});

// ---- citizen filter on the real buildings snapshot -------------------------
await test('Citizen buildings filter keeps only the matching id', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'buildings.json'),
    'utf-8',
  );
  const fc = JSON.parse(raw);
  const before = fc.features.length;
  const filtered = {
    ...fc,
    features: fc.features.filter((f) => f.properties.id === 999),
  };
  const after = filtered.features.length;
  assert.ok(after === 1, `expected 1 building after filter, got ${after}`);
  assert.ok(filtered.features[0].properties.id === 999);
  // Sanity: 999 is a real entry; before the seed script it would be 0.
  assert.ok(before > after, 'snapshot must include more than the one citizen building');
});

// ---- the response-memo cache key -------------------------------------------
// The compressed-payload memo in lib/http/payload.ts is keyed on this tag. If
// two callers who get DIFFERENT bodies from the same URL collapse to the same
// tag, the first one to warm the memo decides what the second one sees. That
// happened: the key was the bare role, so every citizen shared one entry and
// residents 2 and 3 of the demo tower were served resident 1's flat.

function cookieFor(claims) {
  const b64 = Buffer.from(JSON.stringify(claims), 'utf-8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `ulpin_session=${b64}.sig`;
}

await test('callerTagFromCookie: two citizens never share a memo key', () => {
  const ravi = cookieFor({ role: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' });
  const priya = cookieFor({ role: 'citizen', slug: 'siripuram', buildingId: 999, floor: 5, unit: '502' });
  const other = cookieFor({ role: 'citizen', slug: 'hyderabad-banjara', buildingId: 999, floor: 2, unit: '201' });

  assert.notEqual(callerTagFromCookie(ravi), callerTagFromCookie(priya));
  // Same flat code on a different project is a different caller too.
  assert.notEqual(callerTagFromCookie(ravi), callerTagFromCookie(other));
  // The same session is the same caller, or the memo would never hit.
  assert.equal(callerTagFromCookie(ravi), callerTagFromCookie(ravi));
  // Two sessions for the same resident differ only in sid/iat, which do not
  // change the body and so must not fragment the cache.
  const raviAgain = cookieFor({
    sid: 'deadbeef', iat: 123, sub: '111122223333', name: 'Ravi Kumar',
    role: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201',
  });
  assert.equal(callerTagFromCookie(ravi), callerTagFromCookie(raviAgain));
});

await test('callerTagFromCookie: gov and anon are distinct and stable', () => {
  assert.equal(callerTagFromCookie(null), 'anon');
  assert.equal(callerTagFromCookie('other=1'), 'anon');
  assert.equal(callerTagFromCookie('ulpin_session=not-base64.sig'), 'anon');
  assert.equal(callerTagFromCookie(cookieFor({ role: 'gov', sub: 'admin' })), 'gov');
  assert.notEqual(
    callerTagFromCookie(cookieFor({ role: 'gov' })),
    callerTagFromCookie(cookieFor({ role: 'citizen', slug: 's', buildingId: 1, floor: 0, unit: 'a' })),
  );
});

// ---- verified-ctx key (cache poisoning defence) -----------------------------
//
// The cookie-derived tag was the source of a documented cache-poisoning
// shape: an attacker who knows a real citizen's (slug, buildingId, floor,
// unit) can flood the endpoint with a forged claim, the verified handler
// builds the FULL body (verified ctx is 'anon', no filter applies), and
// the FULL body lands in the memo under the citizen's key. The verified
// ctx the cadastre handlers now pass to jsonPayload closes this:
// anonymous traffic gets the 'anon' bucket regardless of the cookie's
// claim, and a real citizen gets their own bucket regardless of what
// cookies anyone else in the world sends.

await test('callerTagFromCtx: anon and gov resolve to one bucket each', () => {
  assert.equal(callerTagFromCtx({ kind: 'anon' }), 'anon');
  assert.equal(callerTagFromCtx({ kind: 'gov' }), 'gov');
  // Two anon contexts are the same bucket. Two gov contexts are the same
  // bucket. The role is the only input that matters for non-citizens.
  assert.equal(callerTagFromCtx({ kind: 'anon' }), callerTagFromCtx({ kind: 'anon' }));
  assert.equal(callerTagFromCtx({ kind: 'gov' }), callerTagFromCtx({ kind: 'gov' }));
});

await test('callerTagFromCtx: two citizens get distinct buckets even if their claims collide on one field', () => {
  const ravi  = { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' };
  const priya = { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 5, unit: '502' };
  // Same project, same building, different flat. Different buckets.
  assert.notEqual(callerTagFromCtx(ravi), callerTagFromCtx(priya));
  // Same flat, different project. Different buckets.
  const other = { kind: 'citizen', slug: 'hyderabad-banjara', buildingId: 999, floor: 2, unit: '201' };
  assert.notEqual(callerTagFromCtx(ravi), callerTagFromCtx(other));
  // Same identity twice is the same bucket, or the memo would never hit.
  assert.equal(callerTagFromCtx(ravi), callerTagFromCtx(ravi));
});

await test('callerTagFromCtx: a forged cookie does NOT poison a real citizen\'s bucket', () => {
  // Forged cookie claiming to be Ravi, with a junk signature. callerTagFromCookie
  // would still return "citizen:siripuram:999:2:201" for this string -- which is
  // the same key the real Ravi's responses cache under. That's the leak.
  //
  // The verified ctx for the forged request is 'anon' (the signature is
  // invalid, the cookie is not trusted). callerTagFromCtx therefore returns
  // 'anon', which is the bucket for the FULL body and is the bucket the
  // forged request was always going to land in. The real Ravi's bucket
  // (citizen:siripuram:999:2:201) is not affected.
  const forgedCookie = cookieFor({
    role: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201',
  }) + '.forged';
  // The cookie-derived tag is the same for the forged string and the real one.
  const raviReal = cookieFor({
    role: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201',
  });
  assert.equal(callerTagFromCookie(forgedCookie), callerTagFromCookie(raviReal),
    'the cookie parser is intentionally format-based and cannot tell these apart');
  // The verified tag is not. The forged request's verified ctx is anon;
  // the real one's is the citizen bucket.
  const verifiedForged = callerTagFromCtx({ kind: 'anon' });
  const verifiedReal = callerTagFromCtx({
    kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201',
  });
  assert.equal(verifiedForged, 'anon');
  assert.notEqual(verifiedForged, verifiedReal,
    'forged request and real citizen must NOT share a cache key');
});

// ---- sliding-cap on session total age --------------------------------------
//
// The 24h sliding window used to keep refreshing a token forever as long as
// the holder was active. The fix caps the new exp at claims.iat + 30d, so a
// session older than the cap expires on schedule regardless of activity.
// The cookie's wall-clock Max-Age is then the lesser of the two.

await test('buildSetCookie: a session older than the 30d cap is no longer refreshable', () => {
  // 31 days ago. claims.iat + 30d is one day in the past, so a refresh
  // would push newExp back to "now" -- which would let a leaked token
  // keep going forever. The fix clamps newExp to claims.iat + 30d, so
  // the rebuilt cookie's Max-Age is whatever is left of that.
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const old = makeCitizenSession({
    aadhar: '111122223333', name: 'Ravi Kumar', slug: 'siripuram',
    buildingId: 999, floor: 2, unit: '201', ttlMs: 30 * day,
  });
  // Synthesise the 31-day-old claims by hand: iat in the past, exp in the past.
  const ancient = { ...old, iat: now - 31 * day, exp: now - 1 * day };
  const cookie = buildSetCookie(ancient);
  // The rebuilt Max-Age must be 0 (exp is in the past) and never claims
  // a fresh 24h TTL on a token the cap has already retired.
  const m = /Max-Age=(\d+)/.exec(cookie);
  assert.ok(m, 'Max-Age must be present');
  const maxAge = Number(m[1]);
  assert.ok(maxAge <= 0, `expected Max-Age=0 for a 31-day-old session, got ${maxAge}`);
});

await test('buildSetCookie: a fresh session refreshes to a 24h Max-Age', () => {
  const fresh = makeGovSession({ email: 'admin@sampath.gov.in', name: 'Admin' });
  const cookie = buildSetCookie(fresh);
  const m = /Max-Age=(\d+)/.exec(cookie);
  assert.ok(m, 'Max-Age must be present');
  const maxAge = Number(m[1]);
  // Within 24h, but allow a few seconds of skew.
  assert.ok(maxAge > 23 * 3600 && maxAge <= 24 * 3600,
    `expected ~24h Max-Age for a fresh session, got ${maxAge}`);
});

// ---- unit-level filtering on the real detail snapshot ----------------------
const RAVI = { kind: 'citizen', slug: 'siripuram', buildingId: 999, floor: 2, unit: '201' };

await test('ownsUnit: matches on (level, code), not on id', () => {
  assert.equal(ownsUnit(RAVI, { level_no: 2, unit_no: '201' }), true);
  // Same code on another floor, and another code on the same floor.
  assert.equal(ownsUnit(RAVI, { level_no: 5, unit_no: '201' }), false);
  assert.equal(ownsUnit(RAVI, { level_no: 2, unit_no: '202' }), false);
  // Gov and anon are not narrowed to a flat at all.
  assert.equal(ownsUnit({ kind: 'gov' }, { level_no: 9, unit_no: '903' }), true);
  assert.equal(ownsUnit({ kind: 'anon' }, { level_no: 9, unit_no: '903' }), true);
});

await test('filterDetailForCaller: a citizen keeps every flat, but only one is readable', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  assert.ok(detail, 'building 999 must exist in the snapshot');
  assert.ok(detail.units.length > 1, 'the demo tower must hold more than one flat');

  const mine = filterDetailForCaller(RAVI, detail);
  // Every flat is still there -- the citizen can see their whole building.
  assert.equal(mine.units.length, detail.units.length);
  // The floors survive too: the flat is shown inside a real building.
  assert.equal(mine.floors.length, detail.floors.length);

  const own = mine.units.filter((u) => !u.restricted);
  assert.equal(own.length, 1, `expected 1 readable flat, got ${own.length}`);
  assert.equal(own[0].unit_no, '201');
  assert.equal(own[0].owner, 'Ravi Kumar');
  assert.ok(own[0].ulpin, 'the citizen keeps their own ULPIN');

  // Every other flat keeps its shape and loses its register entry.
  for (const u of mine.units.filter((x) => x.restricted)) {
    assert.ok(u.ring, `flat ${u.unit_no} must keep its geometry`);
    assert.ok(typeof u.level_no === 'number', 'and its level');
    for (const field of ['ulpin', 'owner', 'address', 'carpet_m2',
      'built_m2', 'tenure', 'encumbrance', 'facing']) {
      assert.equal(u[field], undefined,
        `restricted flat ${u.unit_no} must not carry ${field}`);
    }
  }

  // Belt and braces: no neighbour's ULPIN survives anywhere in the payload.
  const serialised = JSON.stringify(mine);
  for (const code of ['202', '203', '204', '502', '903']) {
    assert.ok(
      !serialised.includes(`-${code}"`),
      `neighbour flat ${code}'s ULPIN must not appear in a citizen's document`,
    );
  }
  // Nor any neighbour's name.
  for (const name of ['Meena Patnaik', 'Joseph Fernandes', 'Sanjay Varma']) {
    assert.ok(!serialised.includes(name), `${name} must not appear`);
  }
});

await test('filterDetailForCaller: the flat register is redacted with the flat', async () => {
  // The register (ownership, bank charge, tax, bills) is merged onto the unit
  // rows by enrichBuildingDetail, AFTER the snapshot and BEFORE the caller
  // filter. It is the most sensitive thing the document carries -- a
  // neighbour's outstanding loan -- so it gets its own assertion rather than
  // relying on the field whitelist staying a whitelist.
  const detail = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'), 'utf-8',
  ))['999'];
  const register = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'projects', 'siripuram', 'flat-register.json'), 'utf-8',
  ));
  assert.ok(Object.keys(register).length > 0, 'the demo tower must have a register');

  const merged = {
    ...detail,
    units: detail.units.map((u) => (register[u.ulpin] ? { ...u, ...register[u.ulpin] } : u)),
  };
  // Every register key names a flat that exists, or the panel silently shows
  // nothing for a flat the register thinks it describes.
  const ulpins = new Set(detail.units.map((u) => u.ulpin));
  for (const key of Object.keys(register)) {
    assert.ok(ulpins.has(key), `register key ${key} matches no flat`);
  }

  const mine = filterDetailForCaller(RAVI, merged);
  const own = mine.units.find((u) => !u.restricted);
  assert.ok(own.ownership, 'the citizen keeps their own ownership status');
  assert.ok(own.tax, 'and their own tax record');
  for (const u of mine.units.filter((x) => x.restricted)) {
    for (const field of ['ownership', 'title_deed', 'registered_on', 'mortgage', 'tax', 'bills']) {
      assert.equal(u[field], undefined,
        `restricted flat ${u.unit_no} must not carry ${field}`);
    }
  }
  // No neighbour's loan account or assessment number anywhere in the payload.
  const serialised = JSON.stringify(mine);
  for (const [key, entry] of Object.entries(register)) {
    if (key === own.ulpin) continue;
    if (entry.mortgage) {
      assert.ok(!serialised.includes(entry.mortgage.loan_no),
        `loan account ${entry.mortgage.loan_no} must not appear`);
    }
    if (entry.tax) {
      assert.ok(!serialised.includes(entry.tax.assessment_no),
        `assessment ${entry.tax.assessment_no} must not appear`);
    }
  }
});

await test('filterDetailForCaller: gov keeps every flat', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  const all = filterDetailForCaller({ kind: 'gov' }, detail);
  assert.equal(all.units.length, detail.units.length);
});

await test('Every flat carries owner and address', async () => {
  const raw = await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  );
  const detail = JSON.parse(raw)['999'];
  for (const u of detail.units) {
    assert.ok(u.owner, `flat ${u.unit_no} has no owner`);
    assert.ok(u.address?.includes(u.unit_no), `flat ${u.unit_no} has no matching address`);
  }
  // Four flats per residential floor, each with its own footprint.
  const byLevel = new Map();
  for (const u of detail.units) {
    byLevel.set(u.level_no, (byLevel.get(u.level_no) ?? 0) + 1);
  }
  for (const [level, n] of byLevel) {
    assert.equal(n, 4, `level ${level} has ${n} flats, expected 4`);
  }
  const rings = new Set(detail.units
    .filter((u) => u.level_no === 2)
    .map((u) => JSON.stringify(u.ring)));
  assert.equal(rings.size, 4, 'the four flats on a floor must have distinct footprints');
});

// ---- the residents roster must match the flats that exist ------------------
await test('Every demo login points at a flat that exists', async () => {
  const residents = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'projects', 'siripuram', 'residents.json'),
    'utf-8',
  ));
  const detail = JSON.parse(await fs.readFile(
    path.join(process.cwd(), 'data', 'api', 'siripuram', 'detail.json'),
    'utf-8',
  ));
  for (const r of residents) {
    const doc = detail[String(r.building_id)];
    assert.ok(doc, `resident ${r.name} points at missing building ${r.building_id}`);
    const unit = doc.units.find(
      (u) => u.level_no === r.floor && u.unit_no === r.unit,
    );
    assert.ok(unit, `resident ${r.name} points at missing flat ${r.unit} on floor ${r.floor}`);
    // The roster name and the flat's owner are the same person, or the
    // citizen would sign in and find someone else's name on their own flat.
    assert.equal(unit.owner, r.name, `flat ${r.unit} owner disagrees with the roster`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
