'use client';

import '@/lib/cesium/base-url';
import type * as Cesium from 'cesium';
import { useEffect, useState } from 'react';
import {
  constantGroundField, sampleGroundField, type FieldBbox, type GroundField,
} from './ground-field';

/**
 * The project's terrain surface, sampled once and shared by every layer that
 * needs it.
 *
 * WHY A CACHE. Two layers hang geometry off this field -- the buried networks
 * and the conflict overlay drawn on top of them -- and they must agree to the
 * millimetre or the red tube stops sitting on the pipe it is flagging.
 * Sampling twice would also mean two terrain batches for one answer. The
 * promise is memoised per viewer and bbox, so the second caller waits on the
 * first caller's request rather than issuing its own.
 *
 * WHY A HOOK RATHER THAN VIEWER CONTEXT. CesiumRoot builds its context at
 * boot, and this is deliberately not boot work: a session that never opens
 * underground mode should never sample it. `enabled` is what makes that true,
 * and it is the layers -- not the viewer -- that know when it becomes true.
 *
 * WHY IT TAKES THE VIEWER AS AN ARGUMENT. So that lib/ does not import from
 * components/. The caller already has it from useViewer().
 */

/**
 * Margin added around the sampled domain, degrees (~110 m).
 *
 * The field is bilinear over a grid; a vertex exactly on the boundary lands in
 * a half-cell with nothing beyond it, so a little slack keeps the edge of the
 * data away from the edge of the field.
 */
const PAD_DEG = 0.001;

function walkCoords(node: unknown, visit: (lon: number, lat: number) => void): void {
  if (!Array.isArray(node)) return;
  if (typeof node[0] === 'number' && typeof node[1] === 'number') {
    visit(node[0] as number, node[1] as number);
    return;
  }
  for (const child of node) walkCoords(child, visit);
}

/**
 * The domain the ground field has to cover.
 *
 * NOT the project bbox on its own, which is the mistake this function exists
 * to prevent. The AOI is what the cadastre was clipped to; the utility runs
 * are OSM ways that leave it. On Siripuram 31 % of utility vertices fall
 * OUTSIDE the project bbox, and a field that stops at the bbox clamps every
 * one of them to an edge height -- which over 63 m of relief put the tail of
 * the network up to 34 m above the ground under it. Exactly the symptom the
 * whole redesign is meant to remove, reintroduced at the boundary.
 *
 * Rounded to five decimals (about a metre) so that two callers computing this
 * from the same data cannot produce keys that differ in the last float bit and
 * sample the terrain twice.
 */
export function fieldBboxFor(
  bbox: FieldBbox | null | undefined,
  ...collections: (readonly { geometry?: { coordinates?: unknown } }[] | undefined)[]
): FieldBbox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const see = (lon: number, lat: number) => {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };

  if (bbox) {
    see(bbox[0], bbox[1]);
    see(bbox[2], bbox[3]);
  }
  for (const features of collections) {
    for (const f of features ?? []) walkCoords(f.geometry?.coordinates, see);
  }

  if (!Number.isFinite(west) || east <= west || north <= south) return null;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return [
    r(west - PAD_DEG), r(south - PAD_DEG), r(east + PAD_DEG), r(north + PAD_DEG),
  ];
}

/**
 * Widen a domain to cover another box.
 *
 * A site does not have to sit inside the project whose list offers it: the
 * station and the flyover are Visakhapatnam landmarks and Siripuram is a
 * Visakhapatnam AOI, but they stand two kilometres west of the ground its
 * cadastre covers. A field built from the cadastre alone would CLAMP them to
 * its edge height -- the same boundary mistake that put the tail of the
 * utility network in the air -- so whoever draws a site widens the domain to
 * include it.
 */
export function unionBbox(
  a: FieldBbox | null | undefined,
  b: FieldBbox | null | undefined,
): FieldBbox | null {
  if (!a) return b ?? null;
  if (!b) return a;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return [
    r(Math.min(a[0], b[0])), r(Math.min(a[1], b[1])),
    r(Math.max(a[2], b[2])), r(Math.max(a[3], b[3])),
  ];
}

/** Per viewer, per bbox. WeakMap so a destroyed viewer takes its cache with it. */
const cache = new WeakMap<Cesium.Viewer, Map<string, Promise<GroundField>>>();

function keyFor(bbox: FieldBbox, fallback: number): string {
  return `${bbox.join(',')}|${fallback.toFixed(3)}`;
}

/**
 * Resolve the shared field for this viewer and bbox, sampling on first ask.
 *
 * Never rejects: a sampling failure resolves to a constant field at
 * `fallback`, which leaves geometry where it used to be rather than dropping
 * it to the ellipsoid. The failed promise is not cached, so a transient
 * network problem does not poison the mode for the rest of the session.
 */
export function groundFieldFor(
  viewer: Cesium.Viewer,
  bbox: FieldBbox,
  fallback: number,
): Promise<GroundField> {
  let byBbox = cache.get(viewer);
  if (!byBbox) {
    byBbox = new Map();
    cache.set(viewer, byBbox);
  }
  const key = keyFor(bbox, fallback);
  const hit = byBbox.get(key);
  if (hit) return hit;

  const p = sampleGroundField(viewer.terrainProvider, bbox, { fallback })
    .catch(() => {
      byBbox?.delete(key);
      return constantGroundField(fallback);
    });
  byBbox.set(key, p);
  return p;
}

export function useGroundField(
  viewer: Cesium.Viewer | null,
  ready: boolean,
  bbox: FieldBbox | null | undefined,
  fallback: number,
  enabled: boolean,
): GroundField | null {
  const [field, setField] = useState<GroundField | null>(null);

  useEffect(() => {
    if (!enabled || !viewer || !ready || !bbox || viewer.isDestroyed()) return;
    let cancelled = false;
    groundFieldFor(viewer, bbox, fallback).then((f) => {
      if (!cancelled) setField(f);
    });
    return () => { cancelled = true; };
    // `bbox` is a tuple from the project row and is stable for the page's
    // lifetime; joining it would only add a string to the dependency list.
  }, [enabled, viewer, ready, bbox, fallback]);

  return field;
}

/**
 * The datum to fall back to when terrain cannot be sampled.
 *
 * The mean of the heights already sampled under the buildings, which is the
 * surface the rest of the scene is drawn against. Zero only when nothing has
 * been sampled at all, which is also what an ellipsoid provider reports.
 */
export function fallbackDatum(ground: Map<number, number>): number {
  if (ground.size === 0) return 0;
  let sum = 0;
  for (const h of ground.values()) sum += h;
  return sum / ground.size;
}
