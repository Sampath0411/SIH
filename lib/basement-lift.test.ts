import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basementLift, depthBelowGround, depthCaption } from './cesium/basement-lift.ts';

test('basementLift: a basement rises to clear the ground by the stated amount', () => {
  // B2 of the demo tower: base at 47.31, ground at 55.31, clear by 1.5.
  const lift = basementLift(47.31, 55.31, 1.5);
  assert.ok(Math.abs(47.31 + lift - (55.31 + 1.5)) < 1e-9);
});

test('basementLift: an above-ground level is never moved', () => {
  assert.equal(basementLift(58.31, 55.31, 1.5), 0);
  assert.equal(basementLift(55.31, 55.31, 1.5), 0);
});

test('basementLift: refuses a non-finite input rather than poisoning the camera', () => {
  assert.equal(basementLift(Number.NaN, 55.31, 1.5), 0);
  assert.equal(basementLift(47.31, Number.NaN, 1.5), 0);
});

test('depthBelowGround: quotes the stored depth, not the drawn one', () => {
  assert.ok(Math.abs(depthBelowGround(55.31, 47.31) - 8) < 1e-9);
  assert.equal(depthBelowGround(55.31, 55.31), 0);
  assert.equal(depthCaption('B2', 8), 'B2 · 8.0 m below ground');
});
