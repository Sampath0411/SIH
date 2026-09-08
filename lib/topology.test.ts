/**
 * Topology validation tests.
 *
 * Run with:  node --test lib/topology.test.ts
 * (Node strips the type annotations natively; there is no build step.)
 *
 * Two things are worth pinning here, and neither is the arithmetic.
 *
 * The first is that a run BELONGING to a building is never reported against
 * that building. The demo tower's water riser goes up through all twenty-four
 * of its levels on purpose; a validator that called that an encroachment would
 * flag every serviced building in the AOI and be switched off within a day.
 *
 * The second is that a clearance breach is not an intersection. The panel
 * colours them differently and the register means different things by them --
 * one is "this pipe is inside your basement", the other is "it is legal but
 * closer than the easement allows" -- so a test that let the two collapse into
 * each other would take the meaning out of the whole feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClashes, polylineGapM, prismSeparationM, prismsIntersect, ringGapM, zGapM,
} from './topology.ts';
import type { RunInput, VolumeInput } from './topology.ts';

// Siripuram, so the longitude scaling is the one the app actually uses.
const LAT = 17.7233;
const LON = 83.3190;
const M_PER_DEG_LAT = 110574;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);

/** A closed rectangle `w` x `h` metres, offset `dx`/`dy` metres from the AOI. */
function rect(w: number, h: number, dx = 0, dy = 0): number[][] {
  const x = (m: number) => LON + (m + dx) / M_PER_DEG_LON;
  const y = (m: number) => LAT + (m + dy) / M_PER_DEG_LAT;
  return [
    [x(-w / 2), y(-h / 2)], [x(w / 2), y(-h / 2)],
    [x(w / 2), y(h / 2)], [x(-w / 2), y(h / 2)],
    [x(-w / 2), y(-h / 2)],
  ];
}

/** A horizontal line at `dy` metres, running `x0`..`x1` metres, at height z. */
function line(x0: number, x1: number, dy: number, z: number): number[][] {
  const x = (m: number) => LON + m / M_PER_DEG_LON;
  const y = LAT + dy / M_PER_DEG_LAT;
  return [[x(x0), y, z], [x(x1), y, z]];
}

const near = (a: number, b: number, tol = 0.05) => Math.abs(a - b) < tol;

// ---------------------------------------------------------------------------
// Geometry primitives
// ---------------------------------------------------------------------------

test('ringGapM is zero for overlapping rings and a real distance otherwise', () => {
  assert.equal(ringGapM(rect(10, 10), rect(10, 10), LON, LAT), 0);
  // 10 m boxes centred 30 m apart leave a 20 m gap.
  const g = ringGapM(rect(10, 10), rect(10, 10, 30), LON, LAT);
  assert.ok(near(g, 20), `expected ~20 m, got ${g}`);
  // Containment is not a gap either.
  assert.equal(ringGapM(rect(50, 50), rect(4, 4), LON, LAT), 0);
});

test('zGapM is zero on overlap and symmetric otherwise', () => {
  const a = { ring: rect(4, 4), z_min: 0, z_max: 10 };
  const b = { ring: rect(4, 4), z_min: 5, z_max: 15 };
  const c = { ring: rect(4, 4), z_min: 14, z_max: 20 };
  assert.equal(zGapM(a, b), 0);
  assert.equal(zGapM(a, c), 4);
  assert.equal(zGapM(c, a), 4);
});

/**
 * The prism equivalence the module is built on: for two vertical prisms the
 * shortest 3D line is the hypotenuse of the horizontal and vertical gaps.
 */
test('prism separation is the hypotenuse of the two gaps', () => {
  const a = { ring: rect(10, 10), z_min: 0, z_max: 10 };
  const b = { ring: rect(10, 10, 30), z_min: 25, z_max: 30 };   // 20 m across, 15 m up
  const s = prismSeparationM(a, b, LON, LAT);
  assert.ok(near(s, Math.hypot(20, 15)), `expected ~25 m, got ${s}`);
  assert.equal(prismsIntersect(a, b, LON, LAT), false);
});

test('prisms that share footprint and z range intersect', () => {
  const a = { ring: rect(10, 10), z_min: 0, z_max: 10 };
  const b = { ring: rect(4, 4), z_min: 5, z_max: 20 };
  assert.equal(prismsIntersect(a, b, LON, LAT), true);
  assert.equal(prismSeparationM(a, b, LON, LAT), 0);
});

/**
 * A long run past a small volume: the closest point is in the MIDDLE of a
 * segment, not at either vertex. Measuring only from the line's vertices
 * reported a pipe 200 m away as clear when it ran straight past the wall.
 */
test('polylineGapM measures to the segment, not only to its vertices', () => {
  const g = polylineGapM(line(-200, 200, 12, 50), rect(4, 4), LON, LAT);
  assert.ok(near(g, 10), `expected ~10 m, got ${g}`);
  // And zero when it runs through.
  assert.equal(polylineGapM(line(-200, 200, 0, 50), rect(4, 4), LON, LAT), 0);
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Clearances as lib/underground/categories.ts declares them. */
const CLEARANCE: Record<string, number> = { sewer: 2.5, water: 0.4, power: 0.3 };
const clearanceOf = (t: string) => CLEARANCE[t] ?? null;

function run(over: Partial<RunInput> = {}): RunInput {
  return {
    id: 1,
    asset_type: 'sewer',
    authority: 'GVMC Sewerage Board',
    status: 'operational',
    radius_m: 0.4,
    depth_m: -3,
    coordinates: line(-100, 100, 0, 50),
    groundZ: 55.31,
    ...over,
  };
}

function vol(over: Partial<VolumeInput> = {}): VolumeInput {
  return {
    type: 'unit',
    id: 10,
    label: 'Parking Slot P-101',
    ring: rect(20, 20),
    z_min: 47.31,
    z_max: 51.31,
    kind: 'parking',
    ...over,
  };
}

test('a pipe through a parking bay is a critical intersection', () => {
  const found = detectClashes({
    runs: [run({ coordinates: line(-100, 100, 0, 49) })],
    volumes: [vol()],
    clearanceOf,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'utility_through_parking');
  assert.equal(found[0].severity, 'critical');
  assert.equal(found[0].separation_m, 0);
  assert.equal(found[0].b.label, 'Parking Slot P-101');
});

test('a basement volume reports the basement kind, not the parking one', () => {
  const found = detectClashes({
    runs: [run({ coordinates: line(-100, 100, 0, 49) })],
    volumes: [vol({ type: 'floor', kind: undefined, label: 'Level B2' })],
    clearanceOf,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'utility_through_basement');
});

/** THE DISTINCTION THE FEATURE RESTS ON. Clear, but not clear enough. */
test('a pipe that clears the bay but breaches its easement is a warning', () => {
  // Bay top is 51.31; put the corridor 1.5 m above it, inside the 2.5 m
  // sewer clearance but not touching.
  const found = detectClashes({
    runs: [run({ coordinates: line(-100, 100, 0, 53.2) })],
    volumes: [vol()],
    clearanceOf,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'clearance_breach');
  assert.equal(found[0].severity, 'warning');
  assert.ok(found[0].separation_m > 0, 'a breach is not an intersection');
  assert.ok(found[0].separation_m < 2.5);
  assert.equal(found[0].required_m, 2.5);
});

test('a pipe with the required clearance is not reported at all', () => {
  const found = detectClashes({
    runs: [run({ coordinates: line(-100, 100, 0, 60) })],   // 8 m above the bay
    volumes: [vol()],
    clearanceOf,
  });
  assert.deepEqual(found, []);
});

/**
 * A run that belongs to the building is its own plumbing.
 *
 * The demo tower's riser (utility 99001, building_id 999) passes through every
 * level it serves. Without this rule the validator's loudest finding would be
 * the building conflicting with itself.
 */
test('a building own service run is never reported against that building', () => {
  const inputs = {
    runs: [run({ building_id: 999, coordinates: line(-100, 100, 0, 49) })],
    volumes: [vol({ building_id: 999 })],
    clearanceOf,
  };
  assert.deepEqual(detectClashes(inputs), []);
  // The same run against a DIFFERENT building is still a finding.
  assert.equal(detectClashes({
    ...inputs,
    volumes: [vol({ building_id: 1234 })],
  }).length, 1);
});

test('an asset type with no declared clearance yields no warning', () => {
  const found = detectClashes({
    runs: [run({ asset_type: 'metro', coordinates: line(-100, 100, 0, 53.2) })],
    volumes: [vol()],
    clearanceOf,
  });
  assert.deepEqual(found, []);
});

test('elevated air rights: a deck inside a building envelope', () => {
  const found = detectClashes({
    runs: [],
    volumes: [],
    clearanceOf,
    decks: [{
      type: 'infra', id: 'TTF-D-01', label: 'Deck span TTF-D-01',
      ring: rect(120, 9), z_min: 61, z_max: 67.2,
    }],
    envelopes: [
      {
        type: 'building', id: 5392, ulpin: 'AP-VSP-3D26-0165-001',
        label: 'Dutt Island', ring: rect(30, 30), z_min: 55, z_max: 84,
      },
      // Far enough away in plan to be clear.
      {
        type: 'building', id: 7, label: 'Elsewhere',
        ring: rect(20, 20, 400), z_min: 55, z_max: 84,
      },
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'airspace_encroachment');
  assert.equal(found[0].b.id, 5392);
});

test('a deck clearing the roof is not an encroachment', () => {
  const found = detectClashes({
    runs: [],
    volumes: [],
    clearanceOf,
    decks: [{
      type: 'infra', id: 'TTF-D-01', label: 'Deck span',
      ring: rect(120, 9), z_min: 90, z_max: 96,
    }],
    envelopes: [{
      type: 'building', id: 5392, label: 'Dutt Island',
      ring: rect(30, 30), z_min: 55, z_max: 84,
    }],
  });
  assert.deepEqual(found, []);
});

test('nothing to test against yields nothing, not a crash', () => {
  assert.deepEqual(detectClashes({ runs: [], volumes: [], clearanceOf }), []);
  assert.deepEqual(
    detectClashes({ runs: [run()], volumes: [], clearanceOf }), [],
  );
});
