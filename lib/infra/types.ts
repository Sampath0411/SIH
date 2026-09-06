/**
 * Named infrastructure: a station, a flyover, anything that is one structure
 * rather than one parcel.
 *
 * WHY A SEPARATE MODEL. The cadastre answers "who owns this ground". It has no
 * way to say "this is platform 3", because a platform is not a parcel, a floor
 * or a unit -- it has no ULPIN, no owner and no tenure, and forcing it into
 * `building` would mean inventing all three. A site is its own thing: a named
 * structure, made of components, standing on ground the cadastre still
 * describes.
 *
 * THE SPEC IS DATA, NOT GEOMETRY. A site file states a structure in metres
 * about an anchor -- "a 12 m platform, 600 m long, repeated eight times at
 * 26 m centres" -- and lib/infra/build.ts turns that into lon/lat/height at
 * runtime. Nothing here is a mesh. That is what keeps a whole station under
 * 30 KB of reviewable JSON instead of several MB of binary nobody can diff,
 * and what lets a component carry its own identity and metadata all the way
 * to the panel.
 *
 * ---------------------------------------------------------------------------
 * DATA INTEGRITY -- read this before adding a field.
 *
 * A site carries two kinds of value and never confuses them:
 *
 *   `facts`      SOURCED. Platform counts, station area, opening dates, lane
 *                counts, the coordinates themselves. Each carries `source`,
 *                and the panel shows them as fact.
 *
 *   everything   DERIVED BY US. Span lengths, pillar heights, component
 *   in `layout`  identifiers like TTF-P-014, the position of a shelter. No
 *                survey, no drawing and no as-built record was consulted --
 *                these are a plausible arrangement consistent with the facts,
 *                and the panel marks every one of them as derived.
 *
 * The split is the point. A viewer looking at this must be able to tell "there
 * are eight platforms" (true, and checkable) from "this pillar is 6.5 m tall"
 * (our arithmetic), and the second must never borrow the authority of the
 * first.
 * ---------------------------------------------------------------------------
 */

export type SiteKind = 'railway_station' | 'flyover';

/**
 * What a component IS. Drives its material, its level of detail band, and the
 * words the detail panel uses for it -- so a new kind is a registry entry in
 * lib/infra/build.ts, not a branch in a layer.
 */
export type ComponentKind =
  // railway station
  | 'station_building' | 'concourse' | 'platform' | 'platform_shelter'
  | 'track' | 'foot_over_bridge' | 'entrance' | 'parking'
  // flyover
  | 'deck_span' | 'ramp' | 'pillar' | 'pier_cap' | 'barrier' | 'junction'
  // shared
  | 'road';

/**
 * How a component is drawn.
 *
 * Three primitives, deliberately. Everything either sits on a footprint
 * (`box`), follows a line with a width (`strip` -- platforms, decks, roads,
 * barriers, tracks), or is a column (`cylinder`). A fourth would have to earn
 * itself; "more shapes" is how a procedural model turns into a mesh format.
 */
export type ComponentShape = 'box' | 'strip' | 'cylinder';

/**
 * Detail band. Maps to a DistanceDisplayCondition in the layer.
 *
 * `far` is the massing you must see to recognise the place from the air;
 * `near` is detail that is sub-pixel until you are among it and is pure cost
 * before then.
 */
export type ComponentLod = 'far' | 'mid' | 'near';

/** Repeat a component along the local frame. This is what gets instanced. */
export interface ComponentRepeat {
  count: number;
  /** Step between copies, metres in the local frame. */
  dx?: number;
  dy?: number;
  dz?: number;
  /**
   * Identifier pattern for the copies, e.g. "TTF-P-%03d". The index is
   * 1-based, so the fourteenth pillar really is TTF-P-014 and the panel can
   * be pointed at it.
   */
  refPattern?: string;
}

export interface ComponentSpec {
  /** Stable within the site. Used as the panel's identifier when no pattern. */
  ref: string;
  kind: ComponentKind;
  shape: ComponentShape;
  /** Human label. Falls back to the kind's own label when absent. */
  label?: string;
  lod?: ComponentLod;

  // ---- box ---------------------------------------------------------------
  /** Centre in the local frame, metres east / north of the anchor. */
  x?: number;
  y?: number;
  /** Extent along the local x and y axes, metres. */
  w?: number;
  d?: number;

  // ---- real geographic geometry -------------------------------------------
  /**
   * Geometry given as REAL lon/lat rather than in the local frame.
   *
   * WHY BOTH EXIST. The local frame is how a structure is DESCRIBED -- "a 12 m
   * platform, 550 m long" -- and it is what makes a spec readable and editable.
   * But a described structure is only ever as well aligned as the bearing it
   * was described against, and a bearing guessed from a map is wrong by tens
   * of degrees: this station was authored at 28 degrees when its platforms run
   * at 158.8, which put the whole model across the real tracks rather than on
   * them.
   *
   * So anything whose true shape is MAPPED carries that shape instead. These
   * come from OpenStreetMap via data/infra/osm/, are converted by
   * scripts/build_infra_specs.mjs, and bypass the frame entirely -- there is
   * no bearing left to get wrong. Derived parts (shelters, bridges, pillar
   * spacing) still use the local frame, anchored to the same measured axis.
   */
  geoRing?: [number, number][];
  /** Real lon/lat centreline, for a strip. Replaces `points`. */
  geoPoints?: [number, number][];
  /** Real lon/lat position, for a cylinder. Replaces `x`/`y`. */
  geoPos?: [number, number];

  // ---- strip -------------------------------------------------------------
  /** Centreline in the local frame. Any number of segments. */
  points?: [number, number][];
  /** Full width of the corridor, metres. */
  width?: number;
  /**
   * Per-vertex base height, metres above the site datum. Length must match
   * `points`. This is what makes a ramp a ramp rather than a flat slab.
   */
  grade?: number[];

  // ---- cylinder ----------------------------------------------------------
  radius?: number;

  // ---- vertical ----------------------------------------------------------
  /** Underside, metres above the site datum. Negative goes below grade. */
  base?: number;
  /** Thickness or storey height, metres. */
  height?: number;

  repeat?: ComponentRepeat;

  /**
   * Rows the detail panel shows for this component.
   *
   * Free-form because a platform and a pillar have nothing in common to
   * normalise. Values are DERIVED unless the key also appears in the site's
   * `facts`, and the panel labels them accordingly.
   */
  meta?: Record<string, string | number>;
}

/** One sourced fact about the site. */
export interface SiteFact {
  label: string;
  value: string | number;
  /** Where it came from. Printed next to the value. */
  source: string;
}

export interface SiteSpec {
  id: string;
  name: string;
  kind: SiteKind;
  /** REAL coordinates. Never adjusted for looks. */
  anchor: { lon: number; lat: number };
  /**
   * Rotation of the local frame, degrees clockwise from north.
   *
   * The local +y axis points along this bearing, so a station is authored
   * along its own track alignment and a flyover along its own carriageway,
   * rather than every structure being forced onto a north-south grid.
   */
  bearing: number;
  /** One-line description for the site navigator. */
  summary: string;
  facts: SiteFact[];
  /** The caveat the panel prints under the derived rows. */
  derivedNote: string;
  components: ComponentSpec[];
}

/** A component after the spec has been expanded and placed. */
export interface PlacedComponent {
  /** Unique within the site, after any repeat pattern has been applied. */
  ref: string;
  siteId: string;
  kind: ComponentKind;
  shape: ComponentShape;
  label: string;
  lod: ComponentLod;
  /**
   * Numeric handle for picking.
   *
   * EntityTag.id is a number, and a component's identity is a string, so the
   * layer mints one of these per component and the store maps back through it.
   * Deliberately not derived from the ref by hashing: a collision would select
   * the wrong pillar, and a counter cannot collide.
   */
  pickId: number;
  /** Footprint rings as [lon,lat,...] flats, one per drawn piece. */
  rings: number[][];
  /** Cylinder placements, when shape is 'cylinder'. */
  columns: { lon: number; lat: number; base: number; height: number; radius: number }[];
  /** Underside and top, metres above the ellipsoid, per ring. */
  base: number[];
  top: number[];
  meta: Record<string, string | number>;
}

export interface PlacedSite {
  id: string;
  name: string;
  kind: SiteKind;
  anchor: { lon: number; lat: number };
  summary: string;
  facts: SiteFact[];
  derivedNote: string;
  components: PlacedComponent[];
}

/**
 * One row of the site index.
 *
 * Deliberately small: the navigator needs a name, a place and a size, and
 * nothing more. The full spec is a separate fetch, so opening the list does
 * not pull down every structure the project holds.
 */
export interface SiteIndexEntry {
  id: string;
  name: string;
  kind: SiteKind;
  summary: string;
  anchor: { lon: number; lat: number };
  /** west, south, east, north — the order every bbox in this codebase uses. */
  extent: [number, number, number, number];
  /** How many components the spec expands to. Shown as a size cue. */
  components: number;
}

export interface SiteIndex {
  sites: SiteIndexEntry[];
}
