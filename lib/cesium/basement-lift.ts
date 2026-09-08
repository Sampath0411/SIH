/**
 * Where an isolated basement is DRAWN, and how deep it really is.
 *
 * Pure, Cesium-free, so FloorStackLayer, UnitsLayer and CameraDirector all
 * agree on the same number by calling the same function -- a plate lifted by
 * one amount and flats lifted by another would float. Tested in
 * lib/basement-lift.test.ts.
 *
 * The lift is presentation only. Nothing here touches the stored z of a
 * floor or a unit; the depth the indicator quotes is computed from the
 * stored z and the building's ground elevation, exactly as the API served
 * them.
 */

/**
 * The vertical offset that puts a level whose base is at `levelZ0` (scene
 * metres) so that it sits `clearM` above `groundZ` (scene metres).
 *
 * Zero for a level that is already at or above the ground: an above-grade
 * storey is never moved by this rule.
 */
export function basementLift(levelZ0: number, groundZ: number, clearM: number): number {
  if (!Number.isFinite(levelZ0) || !Number.isFinite(groundZ)) return 0;
  if (levelZ0 >= groundZ) return 0;
  return groundZ + clearM - levelZ0;
}

/**
 * How far below ground a level's base is, metres, from the STORED heights.
 * Positive for a basement, zero for the ground floor, negative above.
 */
export function depthBelowGround(groundElev: number, zMin: number): number {
  return groundElev - zMin;
}

/** 'B2 · 8.0 m below ground', the indicator's caption. */
export function depthCaption(levelLabel: string, depthM: number): string {
  return `${levelLabel} · ${depthM.toFixed(1)} m below ground`;
}
