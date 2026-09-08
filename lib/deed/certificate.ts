/**
 * The 3D property deed: what goes on it, assembled once.
 *
 * PURE, AND THE SINGLE SOURCE FOR THE NUMBERS. The panel already prints a
 * volume, a clear height and a Z extent for the selected unit, computing them
 * inline. A deed that recomputed them would be a second implementation of the
 * same arithmetic on a document people are meant to keep, and the two would
 * eventually disagree -- so this module owns them and the panel reads them
 * from here.
 *
 * WHAT A DEED MAY SAY. Every figure below comes from the cadastre or is
 * derived from it by arithmetic stated here; nothing is invented to fill a
 * field. Where the register has no answer -- an unowned common space, a flat
 * with no register entry behind it -- the field is absent and the renderer
 * prints nothing rather than a plausible blank. `provenance` and `disclaimer`
 * are carried on the document itself, not added by the renderer, because a
 * generated PDF that looks like a title document without saying what it is is
 * precisely the failure this codebase is written against.
 */
import type { BuildingDetail, UnitInfo } from '../types.ts';
import { DISCLAIMER, levelLabel } from '../ulpin.ts';

/** The bounding box a deed quotes: plan extent plus the vertical span. */
export interface DeedBounds {
  lon_min: number;
  lat_min: number;
  lon_max: number;
  lat_max: number;
  z_min: number;
  z_max: number;
}

export interface DeedDoc {
  /** The identifier the deed is FOR. Absent only on a redacted unit. */
  ulpin?: string;
  /** 'Flat 901', 'Shop G-03', 'Parking Slot P-101'. */
  title: string;
  /** 'Titled unit', 'Appurtenant space', 'Structural core'. */
  kicker: string;
  kind: string;
  /** True when the volume is separately titled and so has a holder. */
  titled: boolean;

  building_name: string;
  building_ulpin: string;
  parcel_ulpin?: string;
  address?: string;
  level_label: string;

  owner?: string;
  tenure?: string;
  encumbrance?: string;
  title_deed?: string;
  registered_on?: string;

  carpet_m2?: number;
  built_m2?: number;
  /** z_max - z_min, metres. */
  height_m: number;
  /** built_m2 * height_m, cubic metres. The volumetric extent of the right. */
  volume_m3?: number;

  bounds: DeedBounds;
  /** Plan centroid, for the one-line coordinate the deed quotes. */
  centre: { lon: number; lat: number };

  /** Absolute URL of the parcel API endpoint the QR code resolves to. */
  api_url: string;
  /** Vertical datum of every z on the document. */
  datum_note: string;
  /** How the geometry came to exist. */
  provenance: string;
  disclaimer: string;
  issued_at: string;
}

/** Plan bounds of a closed lon/lat ring. */
function ringBounds(ring: number[][]) {
  let lon_min = Infinity; let lat_min = Infinity;
  let lon_max = -Infinity; let lat_max = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < lon_min) lon_min = lon;
    if (lon > lon_max) lon_max = lon;
    if (lat < lat_min) lat_min = lat;
    if (lat > lat_max) lat_max = lat;
  }
  return { lon_min, lat_min, lon_max, lat_max };
}

export interface DeedInput {
  unit: UnitInfo;
  detail: BuildingDetail;
  /** Project slug, for the API URL the QR code carries. */
  slug: string;
  /** Origin of the deployment, e.g. 'https://aero-view.vercel.app'. */
  origin: string;
  /** How this volume is titled and described. Supplied by the panel, which
   *  owns the wording, so the two cannot drift. */
  title: string;
  kicker: string;
  titled: boolean;
  /** Vertical-datum sentence, from lib/datum.ts. */
  datumNote: string;
}

/**
 * Assemble the document.
 *
 * Returns null for a unit the server redacted: a citizen may see a neighbour's
 * volume on screen, and must not be able to export a deed for it. The server
 * has already stripped the fields (filterDetailForCaller); this is the second
 * gate, so a bug in the first one cannot become a downloadable document.
 */
export function buildDeed(input: DeedInput): DeedDoc | null {
  const { unit, detail, slug, origin } = input;
  if (unit.restricted) return null;

  const ring = (unit.ring?.coordinates as number[][][] | undefined)?.[0] ?? [];
  const bounds = ring.length
    ? ringBounds(ring)
    : { lon_min: 0, lat_min: 0, lon_max: 0, lat_max: 0 };

  let cLon = 0; let cLat = 0; let n = 0;
  const last = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
    ? ring.length - 1 : ring.length;
  for (let i = 0; i < last; i += 1) {
    cLon += ring[i][0]; cLat += ring[i][1]; n += 1;
  }

  const height = unit.z_max - unit.z_min;
  const floor = detail.floors.find((f) => f.id === unit.floor_id);
  const b = detail.building;

  return {
    ulpin: unit.ulpin,
    title: input.title,
    kicker: input.kicker,
    kind: unit.kind ?? 'flat',
    titled: input.titled,

    building_name: b.name ?? `Building ${b.id}`,
    building_ulpin: b.ulpin,
    parcel_ulpin: detail.parcel?.ulpin,
    address: unit.address ?? b.address ?? undefined,
    level_label: levelLabel(unit.level_no, b.floors - 1),

    // Only a titled volume carries these. A staircase has no holder, and
    // printing an empty "Held by" line on a deed would invite the reading
    // that one exists and is merely unrecorded.
    owner: input.titled ? unit.owner : undefined,
    tenure: unit.tenure,
    encumbrance: input.titled ? unit.encumbrance : undefined,
    title_deed: input.titled ? unit.title_deed : undefined,
    registered_on: input.titled ? unit.registered_on : undefined,

    carpet_m2: unit.carpet_m2,
    built_m2: unit.built_m2,
    height_m: height,
    volume_m3: unit.built_m2 === undefined ? undefined : unit.built_m2 * height,

    bounds: { ...bounds, z_min: unit.z_min, z_max: unit.z_max },
    centre: n ? { lon: cLon / n, lat: cLat / n } : { lon: 0, lat: 0 },

    // The parcel API endpoint for the building this volume sits in. Chosen
    // over a deep link to the unit because it is the resource that actually
    // exists and answers: /building/<id> serves the whole stack, this volume
    // included, on both backends.
    api_url: `${origin.replace(/\/+$/, '')}/api/p/${slug}/building/${b.id}`,
    datum_note: input.datumNote,
    provenance: provenanceLine(floor?.detect_source, b.survey_synthetic),
    disclaimer: DISCLAIMER,
    issued_at: new Date().toISOString(),
  };
}

/**
 * One sentence on where the geometry came from.
 *
 * The deed's most important line after the disclaimer. 'osm_tag' and
 * 'estimated' geometry is a derivation from an open map, not a survey, and a
 * document that does not say so is the exact thing this repository refuses to
 * produce elsewhere.
 */
function provenanceLine(source: string | undefined, synthetic: boolean): string {
  switch (source) {
    case 'surveyed_plan':
      return synthetic
        ? 'Geometry from a surveyed plan that declared itself synthetic. '
          + 'Demonstration data, not a survey record.'
        : 'Geometry from a surveyed plan.';
    case 'dsm_dem':
      return 'Geometry derived from a digital surface model. Not a survey record.';
    case 'osm_tag':
      return 'Geometry derived from OpenStreetMap tags and footprints, with '
        + 'storey heights estimated. Not a survey record.';
    default:
      return 'Geometry estimated by this application. Not a survey record.';
  }
}

/** The rows a deed prints, in order, skipping anything the record lacks. */
export function deedRows(d: DeedDoc): [string, string][] {
  const rows: [string, string][] = [];
  const push = (k: string, v: string | undefined | null) => {
    if (v !== undefined && v !== null && v !== '') rows.push([k, v]);
  };
  push('3D ULPIN', d.ulpin);
  push('Description', d.kicker);
  push('Building', `${d.building_name} (${d.building_ulpin})`);
  push('Parcel', d.parcel_ulpin);
  push('Level', d.level_label);
  push('Address', d.address);
  push('Held by', d.owner);
  push('Tenure', d.tenure);
  push('Encumbrance', d.encumbrance);
  push('Title deed', d.title_deed);
  push('Registered on', d.registered_on);
  push('Carpet area', d.carpet_m2 === undefined ? undefined : `${d.carpet_m2.toFixed(2)} m²`);
  push('Built-up area', d.built_m2 === undefined ? undefined : `${d.built_m2.toFixed(2)} m²`);
  push('Clear height', `${d.height_m.toFixed(2)} m`);
  push('Volumetric extent', d.volume_m3 === undefined ? undefined : `${d.volume_m3.toFixed(1)} m³`);
  return rows;
}

/** The spatial block, kept separate because the deed frames it as a table. */
export function deedBoundsRows(d: DeedDoc): [string, string][] {
  return [
    ['X min (lon)', d.bounds.lon_min.toFixed(7)],
    ['X max (lon)', d.bounds.lon_max.toFixed(7)],
    ['Y min (lat)', d.bounds.lat_min.toFixed(7)],
    ['Y max (lat)', d.bounds.lat_max.toFixed(7)],
    ['Z min', `${d.bounds.z_min.toFixed(2)} m`],
    ['Z max', `${d.bounds.z_max.toFixed(2)} m`],
    ['Centroid', `${d.centre.lat.toFixed(6)}, ${d.centre.lon.toFixed(6)}`],
    ['CRS', 'EPSG:4326 (WGS 84), heights EPSG:5773 (EGM96)'],
  ];
}
