/**
 * Topology validation: 3D clash and easement-clearance detection.
 *
 * WHAT THIS IS FOR. The cadastre already records one kind of conflict --
 * `utility_through_basement`, found at seed time by scripts/utilities.sql with
 * ST_3DIntersects and served from the `conflict` table. That is a fixed
 * question asked once, over one pair of layers. This module answers the
 * broader one on demand: given everything the project holds right now, which
 * volumes actually intersect, and which come closer to each other than the
 * clearance their category requires?
 *
 * WHY IT IS PURE, AND WHY IT DUPLICATES THE SQL. lib/db.ts serves from PostGIS
 * when the database answers and from the committed snapshot when it does not,
 * and the two must give the same answer -- that is the contract at the top of
 * lib/db.ts. PostGIS does the subsurface tests with real ST_3DIntersects and
 * ST_3DDistance; this module is what answers them when there is no database,
 * and it is the ONLY implementation of the air-rights test, because flyover
 * decks live in lib/infra/*.json and never reach a table.
 *
 * THE PRISM EQUIVALENCE. Every volume here -- a utility corridor, a basement
 * envelope, a parking bay, a flyover deck -- is a VERTICAL PRISM: a polygon
 * swept between two heights. For two such solids, "the solids intersect" is
 * exactly "their footprints intersect AND their z ranges overlap", and their
 * 3D separation decomposes into a horizontal gap and a vertical gap. That is
 * not an approximation, and it is the same reasoning db/02_functions.sql gives
 * for solids_intersect()'s fallback path. It is what lets this run without
 * SFCGAL, without PostGIS, and inside `node --test`.
 *
 * WHAT IT DOES NOT DO. It does not write to the `conflict` table, and it does
 * not touch the seeded snapshot. A validation run is a question, not a record:
 * the findings are returned to the caller and drawn, and nothing here claims
 * the authority of the surveyed conflicts already in the cadastre.
 */

// ---------------------------------------------------------------------------
// The local metric frame.
//
// Same equirectangular convention as lib/geo.ts, and for the same reason: over
// an AOI of a few kilometres it is accurate to well under the metre these
// clearances are quoted in, and it keeps the module dependency-free.
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** What kind of thing a side of a finding is. */
export type ClashPartyType =
  | 'utility' | 'building' | 'floor' | 'unit' | 'infra';

/** One side of a finding. */
export interface ClashParty {
  type: ClashPartyType;
  /** Numeric id where the entity has one; the string `ref` for infra. */
  id: number | string;
  ulpin?: string;
  label: string;
  /** Metres, in the project's stored (orthometric) datum. */
  z_min: number;
  z_max: number;
  /**
   * The building this side belongs to, where it belongs to one.
   *
   * Carried so the API can filter a citizen's findings down to their own
   * building. Without it the server would have to match on the utility side,
   * which is never the building -- a run has a building_id only when it is
   * that building's own plumbing, and those pairs are excluded by design.
   */
  building_id?: number;
}

export type ClashKind =
  /** Solids actually overlap. */
  | 'utility_through_basement'
  | 'utility_through_parking'
  | 'airspace_encroachment'
  /** Solids are clear but closer than the required clearance. */
  | 'clearance_breach';

export type ClashSeverity = 'critical' | 'warning';

export interface ClashFinding {
  kind: ClashKind;
  severity: ClashSeverity;
  a: ClashParty;
  b: ClashParty;
  /** Where to point the camera and what to print in the panel. */
  lon: number;
  lat: number;
  z: number;
  /**
   * Metres between the two solids. Zero for a real intersection; the shortest
   * 3D gap for a clearance breach.
   */
  separation_m: number;
  /** The clearance this pair was tested against, when one applied. */
  required_m?: number;
  /** One sentence, as the panel prints it. */
  note: string;
}

// ---------------------------------------------------------------------------
// Geometry primitives.
// ---------------------------------------------------------------------------

/** A vertical prism: a closed lon/lat ring swept between two heights. */
export interface Prism {
  ring: number[][];
  z_min: number;
  z_max: number;
}

interface XY { x: number; y: number }

/** Project a ring into metres about an origin. */
function toMetric(ring: number[][], lon0: number, lat0: number): XY[] {
  const mLon = mPerDegLon(lat0);
  const n = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1 : ring.length;
  const out: XY[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = {
      x: (ring[i][0] - lon0) * mLon,
      y: (ring[i][1] - lat0) * M_PER_DEG_LAT,
    };
  }
  return out;
}

/** Squared distance from a point to a segment. */
function segDist2(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return (p.x - qx) ** 2 + (p.y - qy) ** 2;
}

/** Even-odd containment, matching pointInRing in lib/geo.ts. */
function contains(poly: XY[], p: XY): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const yi = poly[i].y;
    const yj = poly[j].y;
    if ((yi > p.y) !== (yj > p.y)) {
      const xAt = poly[i].x + ((p.y - yi) / (yj - yi)) * (poly[j].x - poly[i].x);
      if (p.x < xAt) inside = !inside;
    }
  }
  return inside;
}

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) =>
    Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y));
  const o1 = o(a, b, c); const o2 = o(a, b, d);
  const o3 = o(c, d, a); const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

/**
 * Horizontal gap between two rings, metres. 0 when they touch or overlap.
 *
 * Brute force over vertex/edge pairs. The candidate sets that reach here are
 * already cut down by a bounding-box prefilter, exactly as the SQL uses `&&`
 * on the GIST index before the exact test.
 */
export function ringGapM(
  ringA: number[][], ringB: number[][], lon0: number, lat0: number,
): number {
  const A = toMetric(ringA, lon0, lat0);
  const B = toMetric(ringB, lon0, lat0);
  if (A.length < 2 || B.length < 2) return Infinity;

  // Overlap or containment -> zero gap.
  for (let i = 0; i < A.length; i += 1) {
    const a1 = A[i]; const a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j += 1) {
      const b1 = B[j]; const b2 = B[(j + 1) % B.length];
      if (segmentsCross(a1, a2, b1, b2)) return 0;
    }
  }
  if (contains(B, A[0]) || contains(A, B[0])) return 0;

  let best = Infinity;
  for (const p of A) {
    for (let j = 0; j < B.length; j += 1) {
      best = Math.min(best, segDist2(p, B[j], B[(j + 1) % B.length]));
    }
  }
  for (const p of B) {
    for (let i = 0; i < A.length; i += 1) {
      best = Math.min(best, segDist2(p, A[i], A[(i + 1) % A.length]));
    }
  }
  return Math.sqrt(best);
}

/** Vertical gap between two z ranges, metres. 0 when they overlap. */
export function zGapM(a: Prism, b: Prism): number {
  if (a.z_min <= b.z_max && b.z_min <= a.z_max) return 0;
  return a.z_min > b.z_max ? a.z_min - b.z_max : b.z_min - a.z_max;
}

/**
 * 3D separation between two vertical prisms, metres. 0 when they intersect.
 *
 * The two gaps are independent -- one horizontal, one vertical -- so the
 * shortest line between the solids is their hypotenuse. This is the exact
 * answer for prisms, and it is what ST_3DDistance returns for them.
 */
export function prismSeparationM(
  a: Prism, b: Prism, lon0: number, lat0: number,
): number {
  const dz = zGapM(a, b);
  const dxy = ringGapM(a.ring, b.ring, lon0, lat0);
  if (dz === 0 && dxy === 0) return 0;
  return Math.sqrt(dz * dz + dxy * dxy);
}

/** True when two vertical prisms share volume. */
export function prismsIntersect(
  a: Prism, b: Prism, lon0: number, lat0: number,
): boolean {
  return zGapM(a, b) === 0 && ringGapM(a.ring, b.ring, lon0, lat0) === 0;
}

/** Axis-aligned lon/lat bounds, for the cheap prefilter. */
export function ringBbox(ring: number[][]): [number, number, number, number] {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

/** True when two bboxes come within `padDeg` of each other. */
export function bboxNear(
  a: [number, number, number, number],
  b: [number, number, number, number],
  padDeg: number,
): boolean {
  return !(a[2] + padDeg < b[0] || b[2] + padDeg < a[0]
        || a[3] + padDeg < b[1] || b[3] + padDeg < a[1]);
}

/** Representative point of a ring, for the finding's coordinates. */
export function ringPoint(ring: number[][]): { lon: number; lat: number } {
  let lon = 0; let lat = 0; let n = 0;
  const last = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1 : ring.length;
  for (let i = 0; i < last; i += 1) {
    lon += ring[i][0]; lat += ring[i][1]; n += 1;
  }
  return n ? { lon: lon / n, lat: lat / n } : { lon: ring[0][0], lat: ring[0][1] };
}

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------

/** A buried or elevated run, as the utilities endpoint serves it. */
export interface RunInput {
  id: number;
  asset_type: string;
  authority: string;
  status: string;
  radius_m: number;
  depth_m: number;
  /** Centreline, [lon, lat, z?]. z is absolute where the record carries it. */
  coordinates: number[][];
  /** Fallback ground for a 2D centreline: the project's own datum. */
  groundZ: number;
  ref?: string;
  building_id?: number;
}

/** A volume to test runs against. */
export interface VolumeInput {
  type: ClashPartyType;
  id: number | string;
  ulpin?: string;
  label: string;
  ring: number[][];
  z_min: number;
  z_max: number;
  /**
   * Set on a volume that belongs to a building, so a run internal to that
   * building is not reported as trespassing on it.
   */
  building_id?: number;
  /** 'parking' etc, which decides the finding's kind. */
  kind?: string;
}

export interface DetectInput {
  runs: RunInput[];
  volumes: VolumeInput[];
  /** Required clearance for an asset type, metres, or null if none applies. */
  clearanceOf: (assetType: string) => number | null;
  /** Elevated structures (flyover decks) to test against building envelopes. */
  decks?: VolumeInput[];
  /** Building envelopes, for the air-rights test. */
  envelopes?: VolumeInput[];
}

/** Shortest distance from a polyline to a ring, metres. 0 when it crosses. */
export function polylineGapM(
  line: number[][], ring: number[][], lon0: number, lat0: number,
): number {
  const L = toMetric(line, lon0, lat0);
  const R = toMetric(ring, lon0, lat0);
  if (L.length === 0 || R.length < 3) return Infinity;

  // Any vertex inside the ring, or any segment crossing an edge -> 0.
  for (const p of L) if (contains(R, p)) return 0;
  for (let i = 0; i + 1 < L.length; i += 1) {
    for (let j = 0; j < R.length; j += 1) {
      if (segmentsCross(L[i], L[i + 1], R[j], R[(j + 1) % R.length])) return 0;
    }
  }

  let best = Infinity;
  // Line vertices to ring edges.
  for (const p of L) {
    for (let j = 0; j < R.length; j += 1) {
      best = Math.min(best, segDist2(p, R[j], R[(j + 1) % R.length]));
    }
  }
  // Ring vertices to line segments -- needed when the line is long and the
  // ring small, where no line VERTEX is the closest point.
  if (L.length > 1) {
    for (const p of R) {
      for (let i = 0; i + 1 < L.length; i += 1) {
        best = Math.min(best, segDist2(p, L[i], L[i + 1]));
      }
    }
  }
  return Math.sqrt(best);
}

/** The z range a run's corridor occupies, including its radius. */
function runZRange(run: RunInput): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of run.coordinates) {
    const z = c.length > 2 && Number.isFinite(c[2])
      ? (c[2] as number) : run.groundZ + run.depth_m;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  if (!Number.isFinite(lo)) {
    const z = run.groundZ + run.depth_m;
    lo = z;
    hi = z;
  }
  return [lo - run.radius_m, hi + run.radius_m];
}

/**
 * Run the whole validation pass.
 *
 * Two questions, asked of every candidate pair that survives a bounding-box
 * prefilter -- the same shape as the SQL, where `&&` on the GIST index runs
 * before ST_3DIntersects:
 *
 *   1. Do the solids intersect? A pipe inside a basement or a parking bay is
 *      an encroachment, and a flyover deck inside a building envelope is one
 *      on the air-rights side.
 *   2. If not, are they closer than the clearance their category requires?
 *      That is the easement question, and it is the one ST_3DDistance answers
 *      on the database path.
 *
 * A run that BELONGS to a building is never reported against that building's
 * own volumes. The demo tower's water riser runs up through all of it by
 * design; calling that a conflict would flag the building against itself.
 */
export function detectClashes(input: DetectInput): ClashFinding[] {
  const { runs, volumes, clearanceOf } = input;
  if (!runs.length || !volumes.length) return airRights(input);

  // One origin for the whole pass, so every metric comparison shares a frame.
  const origin = ringPoint(volumes[0].ring);
  const lon0 = origin.lon;
  const lat0 = origin.lat;

  const vBox = volumes.map((v) => ringBbox(v.ring));
  const out: ClashFinding[] = [];

  for (const run of runs) {
    if (!run.coordinates.length) continue;
    const rBox = ringBbox(run.coordinates);
    const [rz0, rz1] = runZRange(run);
    const clearance = clearanceOf(run.asset_type);
    // Prefilter pad: the widest gap that could still be a finding, in degrees.
    const padDeg = (run.radius_m + (clearance ?? 0) + 1) / M_PER_DEG_LAT;

    for (let i = 0; i < volumes.length; i += 1) {
      const vol = volumes[i];
      // A building's own service runs are not trespassing on it.
      if (run.building_id !== undefined && run.building_id === vol.building_id) continue;
      if (!bboxNear(rBox, vBox[i], padDeg)) continue;

      const hGap = Math.max(0,
        polylineGapM(run.coordinates, vol.ring, lon0, lat0) - run.radius_m);
      const vGap = rz0 <= vol.z_max && vol.z_min <= rz1
        ? 0
        : (rz0 > vol.z_max ? rz0 - vol.z_max : vol.z_min - rz1);
      const sep = hGap === 0 && vGap === 0
        ? 0 : Math.sqrt(hGap * hGap + vGap * vGap);

      const a: ClashParty = {
        type: 'utility',
        id: run.id,
        label: `${run.ref ?? `#${run.id}`} · ${run.asset_type} · ${run.authority}`,
        z_min: rz0,
        z_max: rz1,
      };
      const b: ClashParty = {
        type: vol.type,
        id: vol.id,
        ulpin: vol.ulpin,
        label: vol.label,
        z_min: vol.z_min,
        z_max: vol.z_max,
        building_id: vol.building_id,
      };
      const at = ringPoint(vol.ring);

      if (sep === 0) {
        out.push({
          kind: vol.kind === 'parking'
            ? 'utility_through_parking' : 'utility_through_basement',
          severity: 'critical',
          a,
          b,
          lon: at.lon,
          lat: at.lat,
          z: Math.max(vol.z_min, Math.min(vol.z_max, (rz0 + rz1) / 2)),
          separation_m: 0,
          required_m: clearance ?? undefined,
          note: `${a.label} passes through ${vol.label}.`,
        });
      } else if (clearance !== null && sep < clearance) {
        out.push({
          kind: 'clearance_breach',
          severity: 'warning',
          a,
          b,
          lon: at.lon,
          lat: at.lat,
          z: (rz0 + rz1) / 2,
          separation_m: Math.round(sep * 1000) / 1000,
          required_m: clearance,
          note: `${a.label} comes within ${sep.toFixed(2)} m of ${vol.label}; `
            + `${clearance.toFixed(2)} m clearance is required.`,
        });
      }
    }
  }

  return [...out, ...airRights(input)];
}

/**
 * Elevated air-rights: a flyover deck inside a private building envelope.
 *
 * Kept separate because its inputs come from a different place -- decks are
 * components of a SiteSpec in lib/infra, not rows in any table -- and because
 * it is the one test with no database implementation to fall back on.
 */
function airRights(input: DetectInput): ClashFinding[] {
  const decks = input.decks ?? [];
  const envelopes = input.envelopes ?? [];
  if (!decks.length || !envelopes.length) return [];

  const origin = ringPoint(envelopes[0].ring);
  const eBox = envelopes.map((e) => ringBbox(e.ring));
  const out: ClashFinding[] = [];

  for (const deck of decks) {
    const dBox = ringBbox(deck.ring);
    for (let i = 0; i < envelopes.length; i += 1) {
      const env = envelopes[i];
      if (!bboxNear(dBox, eBox[i], 2 / M_PER_DEG_LAT)) continue;
      const sep = prismSeparationM(
        { ring: deck.ring, z_min: deck.z_min, z_max: deck.z_max },
        { ring: env.ring, z_min: env.z_min, z_max: env.z_max },
        origin.lon, origin.lat,
      );
      if (sep > 0) continue;
      const at = ringPoint(deck.ring);
      out.push({
        kind: 'airspace_encroachment',
        severity: 'critical',
        a: {
          type: 'infra',
          id: deck.id,
          label: deck.label,
          z_min: deck.z_min,
          z_max: deck.z_max,
        },
        b: {
          type: env.type,
          id: env.id,
          ulpin: env.ulpin,
          label: env.label,
          z_min: env.z_min,
          z_max: env.z_max,
          // An envelope IS its building, so a citizen can be shown an
          // encroachment on their own airspace.
          building_id: env.type === 'building' && typeof env.id === 'number'
            ? env.id : env.building_id,
        },
        lon: at.lon,
        lat: at.lat,
        z: deck.z_min,
        separation_m: 0,
        note: `${deck.label} occupies airspace within ${env.label}.`,
      });
    }
  }
  return out;
}
