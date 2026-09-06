import '@/lib/cesium/base-url';
import * as Cesium from 'cesium';
import { ringCentroid } from '@/lib/geo';
import { MATERIALS } from './materials';
import type { UseType } from '@/lib/types';

/**
 * Balcony slabs + railings for the architectural model of the active building.
 *
 * SCOPE. Only residential and commercial get balconies, and only on the two
 * longest edges of the footprint. Institutional (offices, schools) and
 * industrial (warehouses, plants) are not residential and do not get them.
 * Ground floor is skipped -- no balcony at street level. A single-storey
 * structure gets nothing (nowhere to put one).
 *
 * WHY ONLY THE TWO LONGEST EDGES. The principal-axis direction is the long
 * edge of a rectangular footprint and the line the rooms behind the
 * balcony are arranged along, so balconies sit there for a reason. The
 * short ends are where the service spaces go -- stairs, plant, lift cores.
 * In a non-rectangular footprint (a long L or T) the principal axis is
 * still where the rooms go, so the rule survives a slight irregularity.
 *
 * Z-FIGHT. The slab is drawn at the same height as its storey's wall, with
 * a +0.001 m horizontal bias outward. A coplanar slab would z-fight the
 * wall exactly the way the cornice comment in BuildingModelLayer predicts;
 * the bias is the same offset InfraSiteLayer's selection highlight uses
 * to win the depth test.
 *
 * LIFT. The slab and railing ride the explode slider with CallbackProperty
 * closures reading the same `liftFor` the wall does. The balcony is a
 * constant profile, so a callback CAN drive its position -- no per-frame
 * geometry rewrite. A callback that returns a `Cartesian3[]` for the
 * polyline needs the `as unknown as PositionProperty` cast that
 * BuildingModelLayer already uses for its floor bands.
 *
 * UNITS. metres. The ring is in degrees, so the projection from a lon/lat
 * vertex by 1.2 m along an outward normal uses the equirectangular frame
 * at the ring's centroid latitude. Same constants every other module
 * duplicates rather than imports (the canonical pair is private to
 * lib/geo.ts).
 */

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number) => 111320 * Math.cos((lat * Math.PI) / 180);

/** How far the balcony projects from the wall, metres. */
const PROJECTION_M = 1.2;
/** How thick the slab is, metres. */
const SLAB_THICKNESS_M = 0.18;
/** Inset from each end of the host edge so the corner stays clean, metres. */
const END_INSET_M = 0.4;
/** Railing height above the slab top, metres. */
const RAILING_H_M = 1.0;

const balconyMat = new Cesium.ColorMaterialProperty(MATERIALS.balconySlab);
const railingMat = new Cesium.ColorMaterialProperty(MATERIALS.balconyRailing);

/**
 * Find the two longest edges of a closed ring, in metres, and the
 * perpendicular outward normal at the edge midpoint.
 *
 * Returns the longest edge plus the runner-up. For a rectangle the result
 * is unambiguous; for a polygon with one very long edge and several short
 * ones, the long edge is the principal axis and the runner-up is the
 * perpendicular short side. Returns the two vertices + the outward
 * perpendicular unit vector in metric coords (m-east, m-north) at the
 * midpoint of the edge.
 *
 * The outward direction is computed from the ring's signed area -- the
 * same test `insetRing` uses to know which way "inward" points. A
 * counter-clockwise ring (positive signed area in this frame) has its
 * interior to the left of every edge as you walk the vertices in order.
 */
function longestEdges(ring: number[][]): Array<{
  a: [number, number];
  b: [number, number];
  nx: number;
  ny: number;
  lengthM: number;
}> {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const mLon = mPerDegLon(cLat);
  const toM = (p: [number, number]): [number, number] => [
    (p[0] - cLon) * mLon,
    (p[1] - cLat) * M_PER_DEG_LAT,
  ];
  const toDeg = (x: number, y: number): [number, number] => [
    cLon + x / mLon,
    cLat + y / M_PER_DEG_LAT,
  ];

  const n = ring.length - 1; // skip the closing duplicate
  // Signed area to know the winding.
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = toM([ring[i][0], ring[i][1]]);
    const [x1, y1] = toM([ring[(i + 1) % n][0], ring[(i + 1) % n][1]]);
    area2 += x0 * y1 - x1 * y0;
  }
  // CCW (positive area) -> interior on the left -> outward is to the right
  // of the edge direction. CW -> the other way. The right of (dx,dy) is (dy,-dx).
  const right = area2 > 0 ? 1 : -1;

  const edges: Array<{ a: [number, number]; b: [number, number]; nx: number; ny: number; lengthM: number }> = [];
  for (let i = 0; i < n; i++) {
    const a: [number, number] = [ring[i][0], ring[i][1]];
    const b: [number, number] = [ring[(i + 1) % n][0], ring[(i + 1) % n][1]];
    const [ax, ay] = toM(a);
    const [bx, by] = toM(b);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthM = Math.hypot(dx, dy);
    if (lengthM < 0.5) continue; // skip degenerate micro-edges
    // Outward normal in metric coords: perpendicular to (dx,dy) on the
    // outward side. (dy, -dx) is the right of the edge direction; that
    // is outward for a CCW ring, inward for CW. The `right` flag flips
    // it back so the same code works for both windings.
    const ux = dx / lengthM;
    const uy = dy / lengthM;
    const nx = right * uy;
    const ny = -right * ux;
    edges.push({ a, b, nx, ny, lengthM });
  }
  // Sort by length, descending, and take the top two.
  edges.sort((p, q) => q.lengthM - p.lengthM);
  return edges.slice(0, 2);
}

/**
 * Build the four lon/lat vertices of a balcony slab on one host edge.
 *
 * The host edge is `a`-to-`b`. We walk a hair inward from each end
 * (END_INSET_M), then step 1.2 m outward along the edge normal. The
 * resulting quad is `(a_inset, b_inset, b_proj, a_proj)` walking the
 * rectangle, and a `PolygonHierarchy` with that order is what Cesium
 * needs.
 */
function slabQuad(
  a: [number, number], b: [number, number],
  nx: number, ny: number,
  edgeLengthM: number,
): number[] | null {
  if (edgeLengthM < 2 * END_INSET_M + 0.4) return null;
  const { lon: cLon, lat: cLat } = ringCentroid([a, b, a]);
  const mLon = mPerDegLon(cLat);
  // Step the endpoints along the edge so the slab does not reach the
  // corners (where two balconies would meet and produce a thick mass at
  // the corner instead of two separate slabs).
  const [ax, ay] = [
    (a[0] - cLon) * mLon,
    (a[1] - cLat) * M_PER_DEG_LAT,
  ];
  const [bx, by] = [
    (b[0] - cLon) * mLon,
    (b[1] - cLat) * M_PER_DEG_LAT,
  ];
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;

  // Four corners, in metric frame, walking the rectangle.
  // a_in  = a + (END_INSET_M / L) * (dx,dy)         ; walk in along edge
  // a_out = a_in + PROJECTION_M * (nx,ny)            ; walk out along normal
  // b_in  = b - (END_INSET_M / L) * (dx,dy)
  // b_out = b_in + PROJECTION_M * (nx,ny)
  const aIn  = [ax + ux * END_INSET_M,                ay + uy * END_INSET_M];
  const bIn  = [bx - ux * END_INSET_M,                by - uy * END_INSET_M];
  const aOut = [aIn[0] + nx * PROJECTION_M,           aIn[1] + ny * PROJECTION_M];
  const bOut = [bIn[0] + nx * PROJECTION_M,           bIn[1] + ny * PROJECTION_M];

  // Project the four corners back to lon/lat. The slab is a rectangle
  // in the metric frame, which is exact to well under a millimetre over
  // a single edge at this latitude.
  const toDeg = (x: number, y: number): [number, number] => [
    cLon + x / mLon,
    cLat + y / M_PER_DEG_LAT,
  ];
  const [p1x, p1y] = toDeg(aIn[0],  aIn[1]);
  const [p2x, p2y] = toDeg(bIn[0],  bIn[1]);
  const [p3x, p3y] = toDeg(bOut[0], bOut[1]);
  const [p4x, p4y] = toDeg(aOut[0], aOut[1]);
  return [p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y];
}

/**
 * Build one balcony (slab + railing) on one host edge for one storey.
 *
 * `storeyZ` is the storey's base Z in scene-Z; `topZ` is its top. The slab
 * sits at `storeyZ` (slab top at `storeyZ + SLAB_THICKNESS_M`); the railing
 * is a polyline along the front edge of the slab at
 * `storeyZ + SLAB_THICKNESS_M + RAILING_H_M`. `liftFor` returns the explode
 * lift for THIS storey, applied uniformly to slab base and railing height.
 */
function balconyOnEdge(
  edge: { a: [number, number]; b: [number, number]; nx: number; ny: number; lengthM: number },
  storeyZ: number,
  lift: number,
): Cesium.Entity[] {
  const slabBase = storeyZ + lift;
  const slabTop = slabBase + SLAB_THICKNESS_M;
  const railZ = slabTop + RAILING_H_M;

  const slabRing = slabQuad(edge.a, edge.b, edge.nx, edge.ny, edge.lengthM);
  if (!slabRing) return [];

  // Slab: a thin extrusion.
  const slab = new Cesium.Entity({
    polygon: {
      hierarchy: new Cesium.PolygonHierarchy(
        Cesium.Cartesian3.fromDegreesArray(slabRing),
      ),
      height: slabBase,
      extrudedHeight: slabTop,
      material: balconyMat,
      outline: false,
    },
  });

  // Railing: a polyline along the front edge of the slab, at the rail
  // height. The host edge's outward normal is the railing's offset from
  // the wall; the rail walks from a_out to b_out at the rail height.
  const { lon: cLon, lat: cLat } = ringCentroid([edge.a, edge.b, edge.a]);
  const mLon = mPerDegLon(cLat);
  const [ax, ay] = [(edge.a[0] - cLon) * mLon, (edge.a[1] - cLat) * M_PER_DEG_LAT];
  const [bx, by] = [(edge.b[0] - cLon) * mLon, (edge.b[1] - cLat) * M_PER_DEG_LAT];
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  const ux = dx / L;
  const uy = dy / L;
  const aIn = [ax + ux * END_INSET_M, ay + uy * END_INSET_M];
  const bIn = [bx - ux * END_INSET_M, by - uy * END_INSET_M];
  const aOut = [aIn[0] + edge.nx * PROJECTION_M, aIn[1] + edge.ny * PROJECTION_M];
  const bOut = [bIn[0] + edge.nx * PROJECTION_M, bIn[1] + edge.ny * PROJECTION_M];
  const aOutLon = cLon + aOut[0] / mLon;
  const aOutLat = cLat + aOut[1] / M_PER_DEG_LAT;
  const bOutLon = cLon + bOut[0] / mLon;
  const bOutLat = cLat + bOut[1] / M_PER_DEG_LAT;

  const rail = new Cesium.Entity({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights([
        aOutLon, aOutLat, railZ,
        bOutLon, bOutLat, railZ,
      ]),
      width: 1.4,
      material: railingMat,
      clampToGround: false,
    },
  });

  return [slab, rail];
}

/**
 * All balconies for the building, as Cesium entities, ready to add to a
 * `CustomDataSource`. Both long edges, every storey above ground.
 *
 * `use` filters: institutional and industrial get nothing. `storeyCount`
 * is the number of above-ground storeys; ground floor is skipped, so
 * storeys `1..storeyCount-1` get a balcony. A single-storey structure
 * returns `[]`.
 *
 * `baseZ` is the building's `ground_elev` in scene-Z (NOT the raw stored
 * value). `floorH` is the floor-to-floor height in metres. `liftFor(i)`
 * is the explode lift for storey `i`, in metres -- the same function
 * `BuildingModelLayer` already uses to lift each wall.
 */
export function balconiesFor(
  use: UseType,
  ring: number[][],
  baseZ: number,
  floorH: number,
  storeyCount: number,
  liftFor: (storeyIndex: number) => number,
): Cesium.Entity[] {
  if (use !== 'residential' && use !== 'commercial') return [];
  if (storeyCount < 2) return [];

  const edges = longestEdges(ring);
  if (edges.length === 0) return [];

  const out: Cesium.Entity[] = [];
  for (let i = 1; i < storeyCount; i++) {
    const storeyZ = baseZ + i * floorH;
    const lift = liftFor(i);
    for (const edge of edges) {
      out.push(...balconyOnEdge(edge, storeyZ, lift));
    }
  }
  return out;
}
