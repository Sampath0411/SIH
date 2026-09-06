/**
 * Where an underground asset is DRAWN, as opposed to where it is recorded.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE. The viewer may move a pipe on
 * screen to keep it readable. It may never move the data. Every function here
 * is pure and returns a NEW display geometry; the feature it was handed comes
 * back untouched, and lib/underground.test.ts asserts exactly that by deep
 * comparison. What the panel then reports is both numbers -- the recorded
 * depth and the drawn one -- so a displacement is something the user is told
 * about rather than something they are shown as fact.
 *
 * Three transforms, in this order:
 *
 *   1. GROUND-RELATIVE HEIGHT. The one that matters. Runs are re-hung off the
 *      terrain under each vertex instead of off one AOI-wide mean, which is
 *      what put 48 % of the "1 m deep" network in mid-air and made every run
 *      of a class coplanar. See lib/underground/ground-field.ts.
 *
 *   2. LANE OFFSET. A per-category lateral corridor, so six services do not
 *      share one line in plan view. Applied at render time rather than trusted
 *      from the data, because the generator's ST_OffsetCurve silently falls
 *      back to the raw centreline (scripts/utilities.sql:100) whenever the
 *      offset fails on a hairpin.
 *
 *   3. CATEGORY DEPTH RESOLUTION. A whole category is nudged down only when it
 *      would sit inside the one above it. On the shipped datasets this moves
 *      nothing; it is there so real survey data, whose depths will not be as
 *      tidy as the nominal ones, still separates.
 *
 * Cesium-free and dependency-light on purpose: it is executed directly by
 * `node --test`, and it is the piece that has to be right.
 */
import { planRunGeometry, type Riser } from '../geo.ts';
import {
  UNDERGROUND_BY_KEY,
  UNDERGROUND_ORDER,
  categoryOfAssetType,
  type UtilityCategory,
} from './categories.ts';

/**
 * The shape `layoutRun` needs from a ground field.
 *
 * Declared structurally rather than imported from ./ground-field, which pulls
 * in Cesium's base-url side effect and cannot be loaded by the test runner.
 * A real GroundField satisfies this.
 */
export interface GroundLookup {
  heightAt(lon: number, lat: number): number;
}

/**
 * The properties this module reads off a utility feature.
 *
 * Structural rather than `UtilityProps`, so a caller can pass the extra
 * `building_id` the snapshots carry (and the `utility` table does not) without
 * a cast, and so the tests can build a minimal record.
 */
export interface UtilityLike {
  id: number;
  asset_type: string;
  depth_m: number;
  radius_m: number;
  /** Present on a run that belongs to one building rather than to a street. */
  building_id?: number;
}

/** One run's real, recorded geometry. Read-only here, and never written to. */
export interface RunInput {
  props: UtilityLike;
  /** [[lon,lat,z?], ...] exactly as the API served it. */
  coordinates: number[][];
}

export interface DisplayRun {
  id: number;
  category: UtilityCategory;
  /** [lon,lat,height,...] for a PolylineVolume. Empty when purely vertical. */
  tube: number[];
  /** Vertical sections, which a swept volume cannot express. */
  risers: Riser[];
  radiusM: number;
  /** The depth the DATA records. What the panel leads with. */
  trueDepthM: number;
  /** The depth actually drawn, once category resolution has been applied. */
  displayDepthM: number;
  /** Metres the corridor is drawn off its recorded centreline. */
  lateralOffsetM: number;
  /** True when displayDepthM differs from trueDepthM by more than a hair. */
  displaced: boolean;
}

export interface LayoutContext {
  field: GroundLookup;
  /** Per-category depth deltas from resolveCategoryDepths(). */
  adjust?: Partial<Record<UtilityCategory, number>>;
  /**
   * Ground reference for a run that belongs to a building.
   *
   * A building-internal run -- a riser up a tower, a lateral into a tank --
   * was authored against THAT building's ground_elev, not against the AOI
   * mean, and it must be reconciled against the terrain sampled under that
   * building. Returning null falls back to the street path, which is correct
   * for anything the cadastre does not know about.
   */
  buildingGround?: (buildingId: number) => { stored: number; terrain: number } | null;
}

/** Depths closer than this are the same depth as far as the user is concerned. */
const DEPTH_EPS_M = 0.05;

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);

/**
 * Per-category depth deltas that keep the strata from touching.
 *
 * Walks the registry shallowest-first, carrying a ceiling. A category whose
 * recorded depth would put it within `clearance` of the one above is pushed
 * down to exactly that clearance and no further -- and never past its own
 * band floor unless the data already was.
 *
 * The representative depth per category is the MEDIAN of the recorded ones,
 * not the mean: one deliberately deep outlier (the demo building's sewer tank
 * at -10.5 m sits among 96 runs at -3.0 m) must not drag a whole network down
 * with it. Individual runs keep their own recorded depth; this only decides
 * how far the category as a whole has to move.
 */
export function resolveCategoryDepths(
  features: readonly { properties: UtilityLike }[],
): Record<UtilityCategory, number> {
  const byCategory = new Map<UtilityCategory, number[]>();
  for (const f of features) {
    const cat = categoryOfAssetType(f.properties.asset_type);
    if (!cat) continue;
    const d = f.properties.depth_m;
    if (!Number.isFinite(d)) continue;
    const list = byCategory.get(cat);
    if (list) list.push(d);
    else byCategory.set(cat, [d]);
  }

  const out = {} as Record<UtilityCategory, number>;
  // Ground level. The shallowest category still has to clear it.
  let ceiling = 0;

  for (const key of UNDERGROUND_ORDER) {
    out[key] = 0;
    const depths = byCategory.get(key);
    if (!depths || depths.length === 0) continue;

    depths.sort((a, b) => a - b);
    const want = depths[Math.floor(depths.length / 2)];

    const layer = UNDERGROUND_BY_KEY[key];
    const maxAllowed = ceiling - layer.clearance;
    // Never push past the band floor -- unless the data was already deeper,
    // in which case the data wins and nothing is moved.
    const floor = Math.min(layer.band.min, want);
    const resolved = Math.max(floor, Math.min(want, maxAllowed));

    out[key] = resolved - want;
    ceiling = resolved;
  }

  return out;
}

/**
 * Shift a lon/lat polyline sideways by `metres`, positive to the right of
 * travel.
 *
 * Per-vertex normals from the averaged incoming/outgoing direction, computed
 * in a local metric frame at each vertex's own latitude. Good enough for road
 * centrelines, which is all this is ever handed; it is a display offset, not a
 * buffering operation, and a tight hairpin pinching by a few centimetres is
 * invisible at the depths involved.
 *
 * A vertex whose neighbours share its horizontal position -- a riser -- has no
 * direction of its own, so it inherits the last one seen. That keeps both ends
 * of a riser on the same offset line and leaves it vertical, which
 * planRunGeometry then recognises.
 */
function offsetPolyline(coords: readonly number[][], metres: number): number[][] {
  const n = coords.length;
  if (metres === 0 || n === 0) return coords.map((c) => [c[0], c[1]]);

  const out: number[][] = [];
  let lastDx = 1;
  let lastDy = 0;

  for (let i = 0; i < n; i++) {
    const lat = coords[i][1];
    const mLon = mPerDegLon(lat) || 1;

    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(n - 1, i + 1)];
    let dx = (next[0] - prev[0]) * mLon;
    let dy = (next[1] - prev[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy);
    if (len > 1e-6) {
      dx /= len;
      dy /= len;
      lastDx = dx;
      lastDy = dy;
    } else {
      dx = lastDx;
      dy = lastDy;
    }

    // Right-hand normal of the direction of travel.
    const nx = dy;
    const ny = -dx;
    out.push([
      coords[i][0] + (nx * metres) / mLon,
      coords[i][1] + (ny * metres) / M_PER_DEG_LAT,
    ]);
  }
  return out;
}

/**
 * Plan one run's display geometry.
 *
 * Returns null for an asset type this build has no category for. Guessing
 * would put a pipe on screen in the wrong colour at the wrong depth and state
 * it as fact; the caller counts what it skipped and says so instead.
 */
export function layoutRun(run: RunInput, ctx: LayoutContext): DisplayRun | null {
  const { props } = run;
  const category = categoryOfAssetType(props.asset_type);
  if (!category) return null;

  const layer = UNDERGROUND_BY_KEY[category];
  const coords = run.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) return null;

  // A recorded depth is honoured. The band is where a run with nothing usable
  // goes, and the bound on how far resolution may move one -- not an override
  // of what the survey said.
  const recorded = Number.isFinite(props.depth_m) ? props.depth_m : layer.band.nominal;
  // Positive is above ground, which is not a depth. Treat it as grade.
  const depth = Math.min(0, recorded);

  const delta = ctx.adjust?.[category] ?? 0;

  /**
   * The stored datum this run's Z values are measured against, and the terrain
   * height to re-hang them from.
   *
   * For a street corridor both come from the run itself and the field:
   * `z_first - depth_m` recovers whatever ground reference the generator baked
   * in (the AOI mean for a pipeline run, the victim building's own elevation
   * for the planted conflict), and the field supplies the real ground under
   * every vertex.
   *
   * For a building-internal run the cadastre knows better, and this is the
   * same reconciliation toSceneZ() performs for the building's own storeys --
   * so a riser stays attached to the tower it climbs.
   */
  const first = coords[0];
  const hasZ = first.length > 2 && Number.isFinite(first[2]);

  const bg = props.building_id !== undefined && ctx.buildingGround
    ? ctx.buildingGround(props.building_id)
    : null;

  const storedGround = bg ? bg.stored : (hasZ ? (first[2] as number) - depth : 0);
  const groundAt = bg
    ? () => bg.terrain
    : (lon: number, lat: number) => ctx.field.heightAt(lon, lat);

  const offset = offsetPolyline(coords, layer.lane);

  // [lon, lat, displayZ] per vertex. The Z is computed from the ORIGINAL
  // vertex and the ground under the OFFSET one, so a corridor moved sideways
  // onto a slope still follows that slope.
  const display: number[][] = new Array(coords.length);
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    const z = hasZ && Number.isFinite(c[2]) ? (c[2] as number) : storedGround + depth;
    const lon = offset[i][0];
    const lat = offset[i][1];
    display[i] = [lon, lat, groundAt(lon, lat) + (z - storedGround) + delta];
  }

  const { tube, risers } = planRunGeometry(display, (c) => c[2]);

  return {
    id: props.id,
    category,
    tube,
    risers,
    radiusM: Math.max(0.2, Number.isFinite(props.radius_m) ? props.radius_m : 0.2),
    trueDepthM: recorded,
    displayDepthM: recorded + delta,
    lateralOffsetM: layer.lane,
    displaced: Math.abs(delta) > DEPTH_EPS_M,
  };
}
