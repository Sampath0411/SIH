/**
 * The vertical cores, put back together.
 *
 * A lift shaft or a staircase is stored as ONE UNIT ROW PER LEVEL sharing a
 * `core_ref` (see scripts/seed_demo_building.mjs for why), and three things
 * need to see the whole shaft rather than the segment that was clicked: the
 * bar the viewer draws in its place, the camera that frames it, and the card
 * that describes it. They all ask here, so they agree.
 *
 * Pure and Cesium-free; tested in lib/cores.test.ts.
 */

/** The parts of a unit this module reads. */
export interface CoreSegmentLike {
  id: number;
  level_no: number;
  z_min: number;
  z_max: number;
  kind?: string;
  core_ref?: string;
  label?: string;
}

export interface CoreSpan {
  core_ref: string;
  kind: string;
  /** The seeded display name, e.g. 'Central Elevator Shaft'. */
  label?: string;
  lowest: number;
  highest: number;
  levels: number;
  z_min: number;
  z_max: number;
  /** Every segment id, so a layer can hide them while the bar is up. */
  segmentIds: number[];
}

/** The core the given unit belongs to, or null for anything that is not a core segment. */
export function coreOf<T extends CoreSegmentLike>(
  units: readonly T[], unitId: number | null,
): CoreSpan | null {
  if (unitId === null) return null;
  const seg = units.find((u) => u.id === unitId);
  if (!seg?.core_ref) return null;
  return coreSpan(units, seg.core_ref);
}

/** The span of one core across every level it passes through. */
export function coreSpan<T extends CoreSegmentLike>(
  units: readonly T[], coreRef: string,
): CoreSpan | null {
  const segs = units.filter((u) => u.core_ref === coreRef);
  if (segs.length === 0) return null;
  let lowest = Infinity; let highest = -Infinity;
  let zMin = Infinity; let zMax = -Infinity;
  for (const s of segs) {
    if (s.level_no < lowest) lowest = s.level_no;
    if (s.level_no > highest) highest = s.level_no;
    if (s.z_min < zMin) zMin = s.z_min;
    if (s.z_max > zMax) zMax = s.z_max;
  }
  return {
    core_ref: coreRef,
    kind: segs[0].kind ?? 'elevator',
    label: segs[0].label,
    lowest,
    highest,
    levels: segs.length,
    z_min: zMin,
    z_max: zMax,
    segmentIds: segs.map((s) => s.id),
  };
}

/** What a core is called on screen: the plain word, not the seeded prose. */
export function coreNoun(kind: string | undefined): string {
  return kind === 'stair' ? 'Staircase' : 'Lift';
}

/** The short label on the bar itself. */
export function coreBarText(kind: string | undefined): string {
  return kind === 'stair' ? 'STAIRS' : 'LIFT';
}
