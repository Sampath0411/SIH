import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreBarText, coreNoun, coreOf, coreSpan } from './cesium/cores.ts';

const units = [
  { id: 1, level_no: 5, z_min: 70, z_max: 73, unit_no: '502' },
  { id: 10, level_no: -2, z_min: 47, z_max: 51, kind: 'elevator', core_ref: 'EV1', label: 'Central Elevator Shaft' },
  { id: 11, level_no: -1, z_min: 51, z_max: 55, kind: 'elevator', core_ref: 'EV1', label: 'Central Elevator Shaft' },
  { id: 12, level_no: 0, z_min: 55, z_max: 58, kind: 'elevator', core_ref: 'EV1', label: 'Central Elevator Shaft' },
  { id: 13, level_no: 20, z_min: 115, z_max: 118, kind: 'elevator', core_ref: 'EV1', label: 'Central Elevator Shaft' },
  { id: 20, level_no: 0, z_min: 55, z_max: 58, kind: 'stair', core_ref: 'ST1' },
];

test('coreSpan: the shaft runs from its lowest segment base to its highest segment top', () => {
  const span = coreSpan(units, 'EV1');
  assert.ok(span);
  assert.equal(span.lowest, -2);
  assert.equal(span.highest, 20);
  assert.equal(span.levels, 4);
  assert.equal(span.z_min, 47);
  assert.equal(span.z_max, 118);
  assert.deepEqual(span.segmentIds, [10, 11, 12, 13]);
  assert.equal(span.kind, 'elevator');
  assert.equal(span.label, 'Central Elevator Shaft');
});

test('coreOf: answers from any segment, and null for a flat', () => {
  assert.equal(coreOf(units, 12)?.core_ref, 'EV1');
  assert.equal(coreOf(units, 13)?.core_ref, 'EV1');
  assert.equal(coreOf(units, 20)?.core_ref, 'ST1');
  assert.equal(coreOf(units, 1), null);
  assert.equal(coreOf(units, null), null);
  assert.equal(coreOf(units, 999), null);
});

test('coreSpan: an unknown core is null, not an empty span', () => {
  assert.equal(coreSpan(units, 'EV9'), null);
});

test('core wording: a lift is a lift and a stair is a staircase', () => {
  assert.equal(coreNoun('elevator'), 'Lift');
  assert.equal(coreNoun('stair'), 'Staircase');
  assert.equal(coreBarText('elevator'), 'LIFT');
  assert.equal(coreBarText('stair'), 'STAIRS');
});
