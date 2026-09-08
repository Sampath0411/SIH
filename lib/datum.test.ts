/**
 * Vertical datum conversion tests.
 *
 * Run with:  node --test lib/datum.test.ts
 * (Node strips the type annotations natively; there is no build step.)
 *
 * The property worth pinning is not the arithmetic -- it is one addition -- but
 * the behaviour when the separation is UNKNOWN. Converting by zero would be an
 * assertion that the EGM96 geoid and the WGS84 ellipsoid coincide, which is
 * wrong everywhere on Earth and wrong by 65 m here. A project with no DEM must
 * come back unchanged, and be distinguishable from one that was converted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  datumNote, ellipsoidalToOrthometric, hasDatum, orthometricToEllipsoidal,
} from './datum.ts';

/**
 * The EGM96 separation at Siripuram's bbox centre.
 *
 * Computed with the same pyproj transformer scripts/dem.py uses:
 *   dem.geoid_separation(83.31875, 17.723)  ->  -72.1426065216065
 *
 * NOT the same number as the ~-65 m the code comments elsewhere quote. That
 * one is the mean delta CesiumRoot logs at boot between stored ground and
 * sampled Cesium World Terrain, which is the geoid separation PLUS whatever
 * World Terrain and CartoDEM disagree about. This is the datum offset alone.
 */
const VSKP_SEP = -72.1426065216065;

test('converts a stored MSL height to the ellipsoidal one Cesium wants', () => {
  // Sampath Skyline's ground, as seeded: 55.31 m MSL is -16.83 m ellipsoidal,
  // which is where the WGS84 globe actually puts that patch of Siripuram.
  const h = orthometricToEllipsoidal(55.31, VSKP_SEP);
  assert.ok(Math.abs(h - -16.8326065216065) < 1e-9, `got ${h}`);
  // And back.
  assert.ok(Math.abs(ellipsoidalToOrthometric(h, VSKP_SEP) - 55.31) < 1e-9);
});

test('the two directions are inverses', () => {
  for (const h of [0, 12, 55.31, 118.31, -4.5, 1234.5]) {
    const round = ellipsoidalToOrthometric(orthometricToEllipsoidal(h, VSKP_SEP), VSKP_SEP);
    assert.ok(Math.abs(round - h) < 1e-9, `${h} did not round-trip`);
  }
});

/**
 * THE POINT OF THE MODULE. A project with no DEM records no separation, and a
 * height that cannot be converted must come back untouched rather than
 * silently converted by zero.
 */
test('an unknown separation leaves the height alone', () => {
  for (const sep of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(orthometricToEllipsoidal(55.31, sep), 55.31);
    assert.equal(ellipsoidalToOrthometric(55.31, sep), 55.31);
    assert.equal(hasDatum(sep), false);
  }
  assert.equal(hasDatum(VSKP_SEP), true);
  // Zero is a real separation, not a missing one -- it happens where the geoid
  // crosses the ellipsoid, and must not be confused with "not recorded".
  assert.equal(hasDatum(0), true);
});

test('a non-finite height is never converted', () => {
  assert.ok(Number.isNaN(orthometricToEllipsoidal(Number.NaN, VSKP_SEP)));
  assert.equal(orthometricToEllipsoidal(Number.POSITIVE_INFINITY, VSKP_SEP),
    Number.POSITIVE_INFINITY);
});

test('the note says which datum, and whether a conversion was applied', () => {
  const known = datumNote(VSKP_SEP);
  assert.ok(known.includes('EGM96'));
  assert.ok(known.includes('-72.14'));
  const unknown = datumNote(null);
  assert.ok(unknown.includes('EGM96'));
  assert.ok(unknown.includes('No geoid separation'));
});
