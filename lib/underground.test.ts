/**
 * Underground layout tests.
 *
 * Run with:  node --test lib/underground.test.ts
 * (Node strips the type annotations natively; there is no build step.)
 *
 * These pin the three things the underground redesign turns on and that
 * nothing else can check without a WebGL context:
 *
 *   1. THE REGRESSION. The generator bakes one AOI-wide mean ground elevation
 *      into every vertex, which over Siripuram's 63 m of relief left 48 % of
 *      the "1 m deep" power network drawn ABOVE ground, up to +40 m in the
 *      air. `layoutRun` must put every vertex below the ground under it, no
 *      matter what the terrain does.
 *
 *   2. THE DATA-INTEGRITY RULE. The viewer may move a pipe on screen. It may
 *      never move the data. The feature handed to `layoutRun` comes back
 *      byte-identical.
 *
 *   3. THE SEPARATION INVARIANT. The depth bands are pairwise disjoint and the
 *      lanes hold the corridors apart, so two categories cannot occupy the
 *      same space -- which is the clutter the redesign exists to remove.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDERGROUND_BY_KEY, UNDERGROUND_LAYERS, UNDERGROUND_ORDER,
  categoryOfAssetType, type UtilityCategory,
} from './underground/categories.ts';
import {
  layoutRun, resolveCategoryDepths, type GroundLookup, type RunInput,
} from './underground/layout.ts';

// Siripuram, so the longitude scaling is the one the app actually uses.
const LAT = 17.723;
const LON = 83.31875;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);

/** The AOI-wide mean the generator bakes in. Siripuram's actual value. */
const AOI_MEAN_GROUND = 60.7798;

/**
 * A terrain field with 63 m of relief across 1 km, which is what Siripuram
 * actually has (ground_elev spans 19.59 - 82.60 m).
 */
const hillyField: GroundLookup = {
  heightAt(lon) {
    const eastM = (lon - LON) * M_PER_DEG_LON;
    return 51 + 31.5 * Math.sin(eastM / 160);
  },
};

const flatField: GroundLookup = { heightAt: () => 50 };

/** A run laid the way scripts/utilities.sql lays one: flat Z at the AOI mean. */
function pipelineRun(
  assetType: string,
  depthM: number,
  lengthM = 600,
  steps = 24,
): RunInput {
  const z = AOI_MEAN_GROUND + depthM;
  const coordinates: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    coordinates.push([LON + (lengthM * (i / steps)) / M_PER_DEG_LON, LAT, z]);
  }
  return {
    props: { id: 1, asset_type: assetType, depth_m: depthM, radius_m: 0.25 },
    coordinates,
  };
}

// ---------------------------------------------------------------------------
// 1. The regression: nothing is drawn in mid-air.
// ---------------------------------------------------------------------------

test('a flat-Z run over 63 m of relief stays below local ground', () => {
  for (const [assetType, depth] of [
    ['power', -1.0], ['water', -1.5], ['sewer', -3.0], ['metro', -14.0],
  ] as const) {
    const out = layoutRun(pipelineRun(assetType, depth), { field: hillyField });
    assert.ok(out, `${assetType} should have a category`);

    let checked = 0;
    for (let i = 0; i < out.tube.length; i += 3) {
      const [lon, lat, z] = [out.tube[i], out.tube[i + 1], out.tube[i + 2]];
      const ground = hillyField.heightAt(lon, lat);
      assert.ok(
        z < ground,
        `${assetType} vertex ${i / 3} at z=${z.toFixed(2)} is above ground `
        + `${ground.toFixed(2)} -- this is the mid-air bug`,
      );
      checked++;
    }
    assert.ok(checked > 20, 'expected the whole run to be checked');
  }
});

test('depth below local ground is the recorded depth, everywhere along the run', () => {
  const out = layoutRun(pipelineRun('water', -1.5), { field: hillyField });
  assert.ok(out);
  for (let i = 0; i < out.tube.length; i += 3) {
    const ground = hillyField.heightAt(out.tube[i], out.tube[i + 1]);
    assert.ok(
      Math.abs((out.tube[i + 2] - ground) - -1.5) < 1e-6,
      `expected -1.5 m under local ground, got ${(out.tube[i + 2] - ground).toFixed(3)}`,
    );
  }
});

test('the old single-datum treatment is what this replaces', () => {
  // Guards the premise rather than the code: if the fixture ever stops being
  // one where the naive treatment fails, the test above proves nothing.
  const naiveZ = AOI_MEAN_GROUND + -1.0;
  let above = 0;
  let total = 0;
  for (let m = 0; m <= 600; m += 25) {
    const lon = LON + m / M_PER_DEG_LON;
    if (naiveZ > hillyField.heightAt(lon, LAT)) above++;
    total++;
  }
  assert.ok(above > 0 && above < total, 'fixture must have both wet and dry ground');
});

// ---------------------------------------------------------------------------
// 2. The data-integrity rule.
// ---------------------------------------------------------------------------

test('layoutRun does not mutate the feature it is given', () => {
  const run = pipelineRun('sewer', -3.0);
  const before = JSON.parse(JSON.stringify(run));
  const out = layoutRun(run, { field: hillyField, adjust: { sewer: -0.4 } });
  assert.ok(out);
  assert.deepEqual(run, before, 'the recorded coordinates must be untouched');
});

test('a displaced run reports both depths', () => {
  const out = layoutRun(pipelineRun('water', -1.5), {
    field: flatField,
    adjust: { water: -0.4 },
  });
  assert.ok(out);
  assert.equal(out.trueDepthM, -1.5);
  assert.ok(Math.abs(out.displayDepthM - -1.9) < 1e-9);
  assert.equal(out.displaced, true);
});

test('an undisplaced run is not reported as displaced', () => {
  const out = layoutRun(pipelineRun('water', -1.5), { field: flatField });
  assert.ok(out);
  assert.equal(out.displaced, false);
  assert.equal(out.trueDepthM, out.displayDepthM);
});

// ---------------------------------------------------------------------------
// 3. The separation invariant.
// ---------------------------------------------------------------------------

test('depth bands are pairwise disjoint', () => {
  for (const a of UNDERGROUND_LAYERS) {
    assert.ok(a.band.min < a.band.max, `${a.key}: min must be deeper than max`);
    assert.ok(
      a.band.min <= a.band.nominal && a.band.nominal <= a.band.max,
      `${a.key}: nominal must lie inside the band`,
    );
    for (const b of UNDERGROUND_LAYERS) {
      if (a.key === b.key) continue;
      const overlaps = a.band.min < b.band.max && b.band.min < a.band.max;
      assert.equal(overlaps, false, `${a.key} and ${b.key} bands overlap`);
    }
  }
});

test('the registry is ordered shallowest first and its order is dense', () => {
  const orders = UNDERGROUND_LAYERS.map((l) => l.order);
  assert.deepEqual(orders, orders.map((_, i) => i));
  for (let i = 1; i < UNDERGROUND_LAYERS.length; i++) {
    assert.ok(
      UNDERGROUND_LAYERS[i].band.max <= UNDERGROUND_LAYERS[i - 1].band.min,
      `${UNDERGROUND_LAYERS[i].key} must sit below ${UNDERGROUND_LAYERS[i - 1].key}`,
    );
  }
});

test('corridor lanes hold the street categories metres apart in plan view', () => {
  const corridors = UNDERGROUND_LAYERS.filter((l) => l.lane !== 0);
  for (const a of corridors) {
    for (const b of corridors) {
      if (a.key === b.key) continue;
      assert.ok(
        Math.abs(a.lane - b.lane) >= 2.5,
        `${a.key} and ${b.key} lanes are only ${Math.abs(a.lane - b.lane)} m apart`,
      );
    }
  }
});

test('two categories laid on one centreline are separated laterally on screen', () => {
  const ctx = { field: flatField };
  const w = layoutRun(pipelineRun('water', -1.5), ctx);
  const s = layoutRun(pipelineRun('sewer', -3.0), ctx);
  assert.ok(w && s);
  // Same input centreline; the display geometry must not be the same line.
  const dLat = Math.abs(w.tube[1] - s.tube[1]) * M_PER_DEG_LAT;
  assert.ok(dLat > 2.5, `expected lateral separation, got ${dLat.toFixed(2)} m`);
  assert.notEqual(w.lateralOffsetM, s.lateralOffsetM);
});

// ---------------------------------------------------------------------------
// Category resolution.
// ---------------------------------------------------------------------------

test('well-separated recorded depths are left exactly where they are', () => {
  // The depths the two shipped projects actually carry.
  const features = [
    ...Array.from({ length: 95 }, () => ({ properties: { id: 1, asset_type: 'power', depth_m: -1.0, radius_m: 0.2 } })),
    ...Array.from({ length: 96 }, () => ({ properties: { id: 2, asset_type: 'water', depth_m: -1.5, radius_m: 0.25 } })),
    ...Array.from({ length: 96 }, () => ({ properties: { id: 3, asset_type: 'sewer', depth_m: -3.0, radius_m: 0.4 } })),
    ...Array.from({ length: 15 }, () => ({ properties: { id: 4, asset_type: 'metro', depth_m: -14.0, radius_m: 3.2 } })),
  ];
  const adjust = resolveCategoryDepths(features);
  for (const key of UNDERGROUND_ORDER) {
    assert.equal(adjust[key], 0, `${key} should not have been moved`);
  }
});

test('colliding recorded depths are pushed apart by the clearance', () => {
  const features = [
    { properties: { id: 1, asset_type: 'power', depth_m: -1.0, radius_m: 0.2 } },
    { properties: { id: 2, asset_type: 'water', depth_m: -1.0, radius_m: 0.25 } },
  ];
  const adjust = resolveCategoryDepths(features);
  assert.equal(adjust.electrical, 0, 'the shallower category holds its depth');
  const gap = Math.abs((-1.0 + adjust.water) - (-1.0 + adjust.electrical));
  assert.ok(
    gap >= UNDERGROUND_BY_KEY.water.clearance - 1e-9,
    `expected at least ${UNDERGROUND_BY_KEY.water.clearance} m of clearance, got ${gap}`,
  );
});

test('one deep outlier does not drag its whole category down', () => {
  // The demo building's sewer tank sits at -10.5 m among 96 runs at -3.0 m.
  const features = [
    ...Array.from({ length: 96 }, () => ({ properties: { id: 1, asset_type: 'sewer', depth_m: -3.0, radius_m: 0.4 } })),
    { properties: { id: 2, asset_type: 'sewer', depth_m: -10.5, radius_m: 0.5 } },
    { properties: { id: 3, asset_type: 'sewer', depth_m: -8.0, radius_m: 0.3 } },
  ];
  assert.equal(resolveCategoryDepths(features).sewer, 0);
});

test('a category with no runs contributes no ceiling', () => {
  const adjust = resolveCategoryDepths([
    { properties: { id: 1, asset_type: 'metro', depth_m: -14.0, radius_m: 3.2 } },
  ]);
  assert.equal(adjust.metro, 0);
  assert.equal(adjust.water, 0);
});

// ---------------------------------------------------------------------------
// The legacy mapping: the two shipped projects must not need a data migration.
// ---------------------------------------------------------------------------

test('the stored asset types map onto display categories', () => {
  assert.equal(categoryOfAssetType('water'), 'water');
  assert.equal(categoryOfAssetType('sewer'), 'sewer');
  assert.equal(categoryOfAssetType('power'), 'electrical');
  assert.equal(categoryOfAssetType('metro'), 'metro');
  assert.equal(categoryOfAssetType('telecom'), 'telecom');
  assert.equal(categoryOfAssetType('drainage'), 'drainage');
  assert.equal(categoryOfAssetType('foundation'), 'foundations');
});

test('an unknown asset type is refused rather than guessed', () => {
  assert.equal(categoryOfAssetType('gas'), null);
  assert.equal(categoryOfAssetType(''), null);
  const out = layoutRun(
    { props: { id: 9, asset_type: 'gas', depth_m: -1, radius_m: 0.2 }, coordinates: [[LON, LAT, 59], [LON + 0.001, LAT, 59]] },
    { field: flatField },
  );
  assert.equal(out, null);
});

test('every category has a distinct colour and label', () => {
  const colours = new Set(UNDERGROUND_LAYERS.map((l) => l.colour));
  const labels = new Set(UNDERGROUND_LAYERS.map((l) => l.label));
  assert.equal(colours.size, UNDERGROUND_LAYERS.length);
  assert.equal(labels.size, UNDERGROUND_LAYERS.length);
  for (const l of UNDERGROUND_LAYERS) {
    assert.match(l.colour, /^#[0-9A-Fa-f]{6}$/, `${l.key} colour must be hex`);
  }
});

// ---------------------------------------------------------------------------
// Vertical sections and building-internal runs.
// ---------------------------------------------------------------------------

test('a riser is kept vertical and handed back as a riser, not a tube', () => {
  // The demo tower's water riser: 24 vertices at one lon/lat, spanning 72 m.
  const coordinates: number[][] = [];
  for (let lvl = -3; lvl <= 20; lvl++) coordinates.push([LON, LAT, 43.81 + (lvl + 3) * 3]);

  const out = layoutRun(
    { props: { id: 99001, asset_type: 'water', depth_m: 0, radius_m: 0.05, building_id: 999 }, coordinates },
    { field: flatField, buildingGround: () => ({ stored: 55.31, terrain: 40 }) },
  );
  assert.ok(out);
  assert.equal(out.tube.length, 0, 'a purely vertical run has no sweepable tube');
  assert.equal(out.risers.length, 1);
  // Re-hung onto the building's terrain: the base was 11.5 m under its own
  // ground, and must still be 11.5 m under the terrain sampled there.
  assert.ok(Math.abs(out.risers[0].z0 - (40 - 11.5)) < 1e-9);
  assert.ok(Math.abs((out.risers[0].z1 - out.risers[0].z0) - 69) < 1e-9);
});

test('a building-internal run ignores the street ground field', () => {
  const coordinates = [[LON, LAT, 52.31], [LON + 0.0005, LAT, 52.31]];
  const out = layoutRun(
    { props: { id: 99002, asset_type: 'sewer', depth_m: -3, radius_m: 0.3, building_id: 999 }, coordinates },
    {
      field: { heightAt: () => 999 },
      buildingGround: () => ({ stored: 55.31, terrain: 40 }),
    },
  );
  assert.ok(out);
  for (let i = 2; i < out.tube.length; i += 3) {
    assert.ok(Math.abs(out.tube[i] - 37) < 1e-9, `expected 40 - 3, got ${out.tube[i]}`);
  }
});

test('a 2D centreline falls back to the recorded depth', () => {
  const out = layoutRun(
    { props: { id: 5, asset_type: 'water', depth_m: -1.5, radius_m: 0.25 }, coordinates: [[LON, LAT], [LON + 0.002, LAT]] },
    { field: flatField },
  );
  assert.ok(out);
  for (let i = 2; i < out.tube.length; i += 3) {
    assert.ok(Math.abs(out.tube[i] - 48.5) < 1e-9, `expected 50 - 1.5, got ${out.tube[i]}`);
  }
});

test('a depth recorded above ground is treated as grade, not as height', () => {
  const out = layoutRun(
    { props: { id: 6, asset_type: 'water', depth_m: 2.5, radius_m: 0.25 }, coordinates: [[LON, LAT], [LON + 0.002, LAT]] },
    { field: flatField },
  );
  assert.ok(out);
  for (let i = 2; i < out.tube.length; i += 3) {
    assert.ok(out.tube[i] <= 50 + 1e-9, `expected at or below grade, got ${out.tube[i]}`);
  }
});

test('layout is idempotent under repeated calls', () => {
  const run = pipelineRun('water', -1.5);
  const ctx = { field: hillyField };
  assert.deepEqual(layoutRun(run, ctx), layoutRun(run, ctx));
});

test('every registry key round-trips through UNDERGROUND_BY_KEY', () => {
  for (const key of UNDERGROUND_ORDER) {
    const layer = UNDERGROUND_BY_KEY[key as UtilityCategory];
    assert.equal(layer.key, key);
  }
  assert.equal(UNDERGROUND_ORDER.length, UNDERGROUND_LAYERS.length);
});
