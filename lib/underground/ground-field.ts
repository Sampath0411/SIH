import '@/lib/cesium/base-url';
import type * as Cesium from 'cesium';
import { sampleGroundHeights, type SamplePoint } from '@/lib/cesium/terrain';

/**
 * Terrain height as a continuous function of position.
 *
 * WHY THIS EXISTS -- the bug it fixes. scripts/utilities.sql computes ONE
 * ground reference for the whole AOI:
 *
 *     CREATE UNLOGGED TABLE ground_ref AS
 *     SELECT avg(ground_elev) AS z0 FROM building WHERE project_id = ...;
 *
 * and bakes `z0 + depth_m` into every vertex of every run. The viewer then
 * applied ONE scalar `datumShift` uniformly, while buildings got per-building
 * reconciliation through toSceneZ(). Siripuram's ground_elev spans
 * 19.59 - 82.60 m, so measured against the ground actually under them:
 *
 *     power (nominal -1.0 m)   48.4 % of vertices ABOVE ground, up to +40.2 m
 *     water (nominal -1.5 m)   47.1 % above ground, up to +60.5 m
 *     sewer (nominal -3.0 m)   37.6 % above ground, up to +38.2 m
 *
 * Nearly half the buried network was drawn in mid-air, passing through
 * buildings, and every run of a class shared exactly one Z -- so all 95 power
 * runs were coplanar and intersected each other at every junction. That, not
 * styling, is the underground clutter.
 *
 * The fix is to know the ground everywhere rather than on average. A coarse
 * grid is enough: this places a pipe against the surface being drawn, and the
 * inputs on both sides (a CartoDEM sample, or a flat 12 m placeholder) are
 * metre-scale to begin with.
 *
 * COST. One extra sampleTerrain batch at boot for the whole project, against
 * one sample per building already being taken. Both go through
 * sampleGroundHeights, which caps at tile level 13 and short-circuits an
 * EllipsoidTerrainProvider to zeros -- so with no ion token this costs nothing
 * and correctly reports a flat ellipsoid.
 */
export interface GroundField {
  /** Terrain height under (lon, lat), metres. Never NaN. */
  heightAt(lon: number, lat: number): number;
  /** False when sampling failed or was never attempted; the field is constant. */
  readonly sampled: boolean;
}

/** west, south, east, north -- the order every bbox in this codebase uses. */
export type FieldBbox = readonly [number, number, number, number];

/**
 * Target ground spacing between grid nodes, metres, and the bounds on how many
 * nodes that is allowed to become.
 *
 * Sized against the terrain the field is sampling, not against the AOI: a
 * fixed 16x16 over Siripuram is a 75 m posting, and 63 m of relief inside one
 * cell is exactly what the AOI-wide mean got wrong in the first place.
 * Measured on the shipped snapshot, tightening the posting from 75 m to 25 m
 * halves the residual disagreement with the cadastre's own elevations; past
 * that it plateaus, because what is left is the cadastre's noise rather than
 * the field's.
 *
 * The upper bound matters for cost. These are point lookups INSIDE tiles that
 * sampleTerrain has already fetched -- the tile count is set by the AOI and
 * GROUND_SAMPLE_LEVEL, not by this -- so 64x64 is 4,096 interpolations
 * against a handful of tile requests, and the request count does not move.
 */
const TARGET_SPACING_M = 25;
const MIN_N = 16;
const MAX_N = 64;

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);

/** Nodes per axis needed to hold TARGET_SPACING_M over this bbox. */
function gridNFor(bbox: FieldBbox): number {
  const [west, south, east, north] = bbox;
  const midLat = (south + north) / 2;
  const spanM = Math.max(
    (east - west) * mPerDegLon(midLat),
    (north - south) * M_PER_DEG_LAT,
  );
  if (!Number.isFinite(spanM) || spanM <= 0) return MIN_N;
  return Math.min(MAX_N, Math.max(MIN_N, Math.round(spanM / TARGET_SPACING_M) + 1));
}

/** A field that answers the same height everywhere. The no-terrain fallback. */
export function constantGroundField(height: number): GroundField {
  const h = Number.isFinite(height) ? height : 0;
  return { heightAt: () => h, sampled: false };
}

/**
 * Sample a ground-height field over `bbox`.
 *
 * Never rejects. A sampling failure returns a constant field at `fallback`,
 * which leaves the scene exactly as wrong as it was before rather than
 * throwing during boot.
 */
export async function sampleGroundField(
  terrainProvider: Cesium.TerrainProvider,
  bbox: FieldBbox,
  opts: { n?: number; fallback?: number } = {},
): Promise<GroundField> {
  const fallback = opts.fallback ?? 0;

  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
    return constantGroundField(fallback);
  }

  const n = Math.max(2, opts.n ?? gridNFor(bbox));

  const points: SamplePoint[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      points.push({
        id: row * n + col,
        lon: west + ((east - west) * col) / (n - 1),
        lat: south + ((north - south) * row) / (n - 1),
      });
    }
  }

  const map = await sampleGroundHeights(terrainProvider, points);
  if (map.size === 0) return constantGroundField(fallback);

  // Densified into a plain array so lookup is arithmetic rather than a Map
  // probe: this is called once per vertex of every run that gets built.
  const h = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const v = map.get(i);
    h[i] = Number.isFinite(v) ? (v as number) : fallback;
  }

  const lonSpan = east - west;
  const latSpan = north - south;

  return {
    sampled: true,
    heightAt(lon: number, lat: number): number {
      // Clamped, not wrapped. A run may leave the bbox -- an OSM way clipped
      // at the AOI edge still carries its last vertex outside -- and the
      // nearest edge height is the right answer there, not a wrapped one from
      // the far side of the project.
      const fx = Math.min(n - 1, Math.max(0, ((lon - west) / lonSpan) * (n - 1)));
      const fy = Math.min(n - 1, Math.max(0, ((lat - south) / latSpan) * (n - 1)));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(n - 1, x0 + 1);
      const y1 = Math.min(n - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;

      const h00 = h[y0 * n + x0];
      const h10 = h[y0 * n + x1];
      const h01 = h[y1 * n + x0];
      const h11 = h[y1 * n + x1];

      const a = h00 + (h10 - h00) * tx;
      const b = h01 + (h11 - h01) * tx;
      const out = a + (b - a) * ty;
      return Number.isFinite(out) ? out : fallback;
    },
  };
}
