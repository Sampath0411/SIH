/**
 * Spec -> geometry.
 *
 * Pure and Cesium-free: it takes a SiteSpec and a ground height and returns
 * lon/lat rings and column placements. That is what lets a station be
 * unit-tested, and it is the same separation lib/geo.ts and
 * lib/underground/layout.ts keep -- the layer turns rings into primitives and
 * decides nothing about where they are.
 *
 * THE LOCAL FRAME. A spec is authored in metres east/north of its anchor, then
 * rotated by the site's bearing so that a station is described along its own
 * track alignment rather than on a north-south grid. Metres become degrees
 * with the same equirectangular constants the rest of the codebase uses
 * (lib/geo.ts, scripts/project.py), so a footprint placed here lands where a
 * footprint placed there would.
 *
 * THE SITE DATUM, and why it is not one number for everything.
 *
 * A station's platforms and tracks ARE one plane -- they are graded level for
 * 550 m, and draping them on terrain would put a kink in a deck that has none.
 * But the ground they stand on is not level, and placing the whole site on the
 * height under its anchor buried the far end of every platform in the hillside
 * while the near end floated: the terrain cut through the geometry and left it
 * visibly torn.
 *
 * So there are four placement rules, one per kind of thing:
 *
 *   STRUCTURE   decks, shelters, bridges -- anything carried well clear of the
 *               ground. One datum for the whole site, because that is what a
 *               graded level is.
 *
 *   PLINTH      platforms, tracks, station buildings: structures whose TOP is
 *               part of that same level but which stand ON the ground rather
 *               than over it. The top face stays at the site datum -- a
 *               platform really is level for 550 m -- and the BOTTOM is
 *               extended down to the lowest ground beneath that piece. What
 *               you see is a platform on a retaining wall, which is what a
 *               platform on sloping ground is. It is also the only formulation
 *               that can neither float nor be buried, because both ends are
 *               pinned to something real.
 *
 *   SURFACE     roads, parking, the junction slab. These follow the ground,
 *               because roads do. Each piece takes the height under its own
 *               centre.
 *
 *   GROUNDED    pillars. The top is set by the structure it carries and the
 *               bottom by the ground it stands in, so a pier is never left
 *               hanging over a dip or half-swallowed by a rise.
 *
 * The caller pairs this with a datum taken from the MAXIMUM ground under the
 * structural footprints, so no top face can end up under the terrain. Between
 * that and the plinths, nothing in the model floats and nothing is eaten.
 */
import type {
  ComponentKind, ComponentLod, ComponentSpec, PlacedComponent, PlacedSite,
  SiteSpec,
} from './types.ts';

/**
 * Where the ground is, for a site being placed.
 *
 * `datum` is the level the STRUCTURE is graded to; `heightAt` is the terrain
 * under a given point, for the parts that follow it. A caller with no terrain
 * can pass the same number for both and get the old flat behaviour.
 */
export interface SiteGround {
  datum: number;
  heightAt(lon: number, lat: number): number;
}

/**
 * Components that follow the ground rather than the structure's own level.
 * Roads and paving are graded to the land; a platform is not.
 */
const SURFACE_KINDS = new Set<ComponentKind>(['road', 'parking', 'junction']);

/**
 * Components whose bottom is set by the ground and whose top is set by the
 * structure. A pier reaches from where it stands to what it carries.
 */
const GROUNDED_KINDS = new Set<ComponentKind>(['pillar']);

/**
 * Components that stand ON the ground with their top face at the site level.
 * Their underside is dropped to meet the terrain, so the gap a level surface
 * leaves over falling ground is filled rather than left as a hovering slab.
 */
const PLINTH_KINDS = new Set<ComponentKind>([
  'platform', 'track', 'station_building', 'concourse', 'entrance',
]);

/** How far a plinth is sunk past the lowest ground under it, metres. */
const PLINTH_EMBED_M = 0.4;

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat: number): number => 111320 * Math.cos((lat * Math.PI) / 180);

/** Default detail band per shape, when a component does not name one. */
const DEFAULT_LOD: ComponentLod = 'mid';

/** Human labels for the component kinds, so a layer never spells one out. */
export const COMPONENT_LABEL: Record<string, string> = {
  station_building: 'Station building',
  concourse: 'Concourse',
  platform: 'Platform',
  platform_shelter: 'Platform shelter',
  track: 'Railway track',
  foot_over_bridge: 'Foot over bridge',
  entrance: 'Entrance',
  parking: 'Parking area',
  deck_span: 'Deck span',
  ramp: 'Ramp',
  pillar: 'Support pillar',
  pier_cap: 'Pier cap',
  barrier: 'Road barrier',
  junction: 'Junction',
  road: 'Road',
};

/** Substitute a 1-based index into a "%03d"-style pattern. */
export function applyRefPattern(pattern: string, index: number): string {
  return pattern.replace(/%(0?)(\d*)d/, (_m, zero: string, width: string) => {
    const w = width ? Number(width) : 0;
    const s = String(index);
    return zero && w ? s.padStart(w, '0') : s;
  });
}

interface Frame {
  /** Local (x east-ish, y along bearing) metres -> [lon, lat]. */
  toLonLat(x: number, y: number): [number, number];
}

function frameFor(spec: SiteSpec): Frame {
  const { lon: lon0, lat: lat0 } = spec.anchor;
  const theta = (spec.bearing * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const mLon = mPerDegLon(lat0) || 1;

  return {
    toLonLat(x, y) {
      // Bearing is clockwise from north, so +y runs along it and +x is 90
      // degrees to its right.
      const east = x * cos + y * sin;
      const north = -x * sin + y * cos;
      return [lon0 + east / mLon, lat0 + north / M_PER_DEG_LAT];
    },
  };
}

/** A closed flat ring from real lon/lat pairs. */
function geoRingFlat(ring: readonly (readonly [number, number])[]): number[] {
  const flat: number[] = [];
  for (const [lon, lat] of ring) flat.push(lon, lat);
  // Closed, as Cesium's hierarchy expects and as GeoJSON rings are.
  if (flat[0] !== flat[flat.length - 2] || flat[1] !== flat[flat.length - 1]) {
    flat.push(flat[0], flat[1]);
  }
  return flat;
}

/**
 * One segment of a real lon/lat strip, as a quad.
 *
 * The perpendicular is taken in a local metric frame at the segment's own
 * latitude, which is the same equirectangular treatment lib/geo.ts and
 * lib/underground/layout.ts use -- so a deck offset here lands where a pipe
 * offset there would.
 */
function geoStripQuad(
  a: readonly [number, number],
  b: readonly [number, number],
  width: number,
): number[] {
  const lat = (a[1] + b[1]) / 2;
  const mLon = mPerDegLon(lat) || 1;
  const dx = (b[0] - a[0]) * mLon;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const len = Math.hypot(dx, dy) || 1;
  const nx = ((dy / len) * (width / 2)) / mLon;
  const ny = ((-dx / len) * (width / 2)) / M_PER_DEG_LAT;
  const flat = [
    a[0] + nx, a[1] + ny,
    b[0] + nx, b[1] + ny,
    b[0] - nx, b[1] - ny,
    a[0] - nx, a[1] - ny,
  ];
  flat.push(flat[0], flat[1]);
  return flat;
}

/** A rectangle centred on (x, y) in the local frame, as a closed flat ring. */
function boxRing(frame: Frame, x: number, y: number, w: number, d: number): number[] {
  const hw = w / 2;
  const hd = d / 2;
  const corners: [number, number][] = [
    [x - hw, y - hd], [x + hw, y - hd], [x + hw, y + hd], [x - hw, y + hd],
  ];
  const flat: number[] = [];
  for (const [cx, cy] of corners) {
    const [lon, lat] = frame.toLonLat(cx, cy);
    flat.push(lon, lat);
  }
  // Closed, as GeoJSON rings are and as Cesium's hierarchy tolerates.
  flat.push(flat[0], flat[1]);
  return flat;
}

/**
 * One segment of a strip, as a quad.
 *
 * Per segment rather than one offset polygon for the whole line: an offset
 * polyline folds on itself at a tight corner, and these are decks and
 * platforms whose corners are gentle. A quad per segment cannot fold, and the
 * seam between two quads is invisible at any width worth drawing.
 */
function stripQuad(
  frame: Frame,
  a: [number, number],
  b: [number, number],
  width: number,
): number[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (dy / len) * (width / 2);
  const ny = (-dx / len) * (width / 2);
  const corners: [number, number][] = [
    [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny], [a[0] - nx, a[1] - ny],
  ];
  const flat: number[] = [];
  for (const [cx, cy] of corners) {
    const [lon, lat] = frame.toLonLat(cx, cy);
    flat.push(lon, lat);
  }
  flat.push(flat[0], flat[1]);
  return flat;
}

/** Terrain range under a ring's own corners. */
function groundUnder(flat: number[], ground: SiteGround): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const h = ground.heightAt(flat[i], flat[i + 1]);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return Number.isFinite(lo)
    ? { lo, hi }
    : { lo: ground.datum, hi: ground.datum };
}

/**
 * Highest terrain under the components that must share one level.
 *
 * The datum a caller should use. Taken over the STRUCTURAL footprints only:
 * a station's approach roads sprawl half a kilometre across ground that has
 * nothing to do with where the platforms sit, and letting them into the
 * calculation drags the level to somewhere neither serves.
 */
export function structuralDatum(spec: SiteSpec, heightAt: (lon: number, lat: number) => number): number {
  const probe = placeSite(spec, { datum: 0, heightAt });
  let hi = -Infinity;
  for (const c of probe.components) {
    if (SURFACE_KINDS.has(c.kind) || GROUNDED_KINDS.has(c.kind)) continue;
    for (const ring of c.rings) {
      for (let i = 0; i < ring.length; i += 2) {
        const h = heightAt(ring[i], ring[i + 1]);
        if (h > hi) hi = h;
      }
    }
    for (const col of c.columns) {
      const h = heightAt(col.lon, col.lat);
      if (h > hi) hi = h;
    }
  }
  return Number.isFinite(hi) ? hi : heightAt(spec.anchor.lon, spec.anchor.lat);
}

function placeOne(
  spec: SiteSpec,
  frame: Frame,
  c: ComponentSpec,
  ref: string,
  offset: { dx: number; dy: number; dz: number },
  ground: SiteGround,
  pickId: number,
): PlacedComponent | null {
  const base = (c.base ?? 0) + offset.dz;
  const height = c.height ?? 1;
  const surface = SURFACE_KINDS.has(c.kind);
  const plinth = PLINTH_KINDS.has(c.kind);

  const placed: PlacedComponent = {
    ref,
    siteId: spec.id,
    kind: c.kind,
    shape: c.shape,
    label: c.label ?? COMPONENT_LABEL[c.kind] ?? c.kind,
    lod: c.lod ?? DEFAULT_LOD,
    pickId,
    rings: [],
    columns: [],
    base: [],
    top: [],
    meta: { ...(c.meta ?? {}) },
  };

  if (c.shape === 'cylinder') {
    const [lon, lat] = c.geoPos
      ? c.geoPos
      : frame.toLonLat((c.x ?? 0) + offset.dx, (c.y ?? 0) + offset.dy);
    const top = ground.datum + base + height;
    // A pier is measured DOWN from what it carries, not up from a nominal
    // level: its foot goes wherever the ground is, plus the embedment the spec
    // asked for. Anything else leaves it hanging over a dip.
    const foot = GROUNDED_KINDS.has(c.kind)
      ? Math.min(ground.datum + base, ground.heightAt(lon, lat) + base)
      : ground.datum + base;
    placed.columns.push({
      lon, lat, base: foot, height: Math.max(0.5, top - foot), radius: c.radius ?? 0.5,
    });
    return placed;
  }

  if (c.shape === 'box') {
    const x = (c.x ?? 0) + offset.dx;
    const y = (c.y ?? 0) + offset.dy;
    const ring = c.geoRing ? geoRingFlat(c.geoRing) : boxRing(frame, x, y, c.w ?? 1, c.d ?? 1);
    placed.rings.push(ring);

    if (surface) {
      // A junction or a car park is a LEVEL PAD cut into the ground, and it is
      // wide enough that one height at its centre leaves a corner buried while
      // the opposite corner hovers. Pinning the top above the highest ground it
      // covers and the underside below the lowest gives a pad that is visible
      // everywhere and floating nowhere -- which is what levelling a site does.
      const g = groundUnder(ring, ground);
      placed.base.push(g.lo + base - PLINTH_EMBED_M);
      placed.top.push(g.hi + base + height);
      return placed;
    }

    const bottom = ground.datum + base;
    placed.base.push(
      plinth
        ? Math.min(bottom, groundUnder(ring, ground).lo - PLINTH_EMBED_M)
        : bottom,
    );
    placed.top.push(bottom + height);
    return placed;
  }

  // strip
  const geo = c.geoPoints;
  const pts = geo ?? c.points;
  if (!pts || pts.length < 2) return null;
  const width = c.width ?? 1;
  for (let i = 0; i < pts.length - 1; i++) {
    const a: [number, number] = geo
      ? [pts[i][0], pts[i][1]]
      : [pts[i][0] + offset.dx, pts[i][1] + offset.dy];
    const b: [number, number] = geo
      ? [pts[i + 1][0], pts[i + 1][1]]
      : [pts[i + 1][0] + offset.dx, pts[i + 1][1] + offset.dy];
    placed.rings.push(geo ? geoStripQuad(a, b, width) : stripQuad(frame, a, b, width));
    // A graded strip steps per segment. Each quad is flat -- Cesium extrudes
    // between two heights, not along a slope -- so a ramp is a short flight of
    // shallow steps, which at the segment lengths these use reads as a slope.
    const g0 = c.grade ? c.grade[i] ?? 0 : 0;
    const g1 = c.grade ? c.grade[i + 1] ?? g0 : g0;
    const mid = (g0 + g1) / 2;
    // A surface strip takes the ground under its own midpoint, so a 700 m
    // approach road follows the land instead of hovering over the far end.
    const [mlon, mlat] = geo
      ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      : frame.toLonLat((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    const z = surface ? ground.heightAt(mlon, mlat) : ground.datum;
    const quad = placed.rings[placed.rings.length - 1];
    const bottom = z + base + mid;
    placed.base.push(
      plinth ? Math.min(bottom, groundUnder(quad, ground).lo - PLINTH_EMBED_M) : bottom,
    );
    placed.top.push(z + base + mid + height);
  }
  return placed;
}

/**
 * Expand and place a site.
 *
 * `ground` is either a SiteGround -- a structural datum plus a terrain lookup
 * -- or a bare number, which places everything on one level.
 *
 * `startPickId` lets a caller keep pick handles unique across several sites.
 */
export function placeSite(
  spec: SiteSpec,
  ground: SiteGround | number,
  startPickId = 1,
): PlacedSite {
  // A bare number is the no-terrain case: structure and ground at one level,
  // which is what scripts/build_vizag_infra.mjs wants when it is producing
  // geography rather than a scene.
  const g: SiteGround = typeof ground === 'number'
    ? { datum: ground, heightAt: () => ground }
    : ground;
  const frame = frameFor(spec);
  const components: PlacedComponent[] = [];
  let pickId = startPickId;

  for (const c of spec.components) {
    const rep = c.repeat;
    const count = Math.max(1, rep?.count ?? 1);
    for (let i = 0; i < count; i++) {
      const ref = rep?.refPattern
        ? applyRefPattern(rep.refPattern, i + 1)
        : count > 1 ? `${c.ref}-${String(i + 1).padStart(2, '0')}` : c.ref;
      const placed = placeOne(spec, frame, c, ref, {
        dx: (rep?.dx ?? 0) * i,
        dy: (rep?.dy ?? 0) * i,
        dz: (rep?.dz ?? 0) * i,
      }, g, pickId);
      if (placed) {
        components.push(placed);
        pickId += 1;
      }
    }
  }

  return {
    id: spec.id,
    name: spec.name,
    kind: spec.kind,
    anchor: spec.anchor,
    summary: spec.summary,
    facts: spec.facts,
    derivedNote: spec.derivedNote,
    components,
  };
}

/** Bounding box of a placed site, west/south/east/north. */
export function siteExtent(site: PlacedSite): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const see = (lon: number, lat: number) => {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  };
  for (const c of site.components) {
    for (const ring of c.rings) {
      for (let i = 0; i < ring.length; i += 2) see(ring[i], ring[i + 1]);
    }
    for (const col of c.columns) see(col.lon, col.lat);
  }
  if (!Number.isFinite(west)) {
    return [site.anchor.lon, site.anchor.lat, site.anchor.lon, site.anchor.lat];
  }
  return [west, south, east, north];
}

/** Longest horizontal extent of a site, metres. Used to frame the camera. */
export function siteSpanM(site: PlacedSite): number {
  const [west, south, east, north] = siteExtent(site);
  const midLat = (south + north) / 2;
  return Math.max(
    (east - west) * mPerDegLon(midLat),
    (north - south) * M_PER_DEG_LAT,
    40,
  );
}
