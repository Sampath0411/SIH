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
import {
  formatShare, memberRoleLabel, partyRoleLabel, rrrTypeLabel, suTypeLabel,
  type LADMParcelDoc,
} from '../ladm.ts';

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

  /**
   * The ISO 19152 record, when the caller supplied one.
   *
   * OPTIONAL, AND ABSENT RATHER THAN EMPTY. A project seeded before the LADM
   * tables existed has no registry rows, and a certificate for one of its
   * volumes must print no LADM section at all -- not a section of blanks,
   * which would read as "registered, with nothing recorded" instead of "not
   * in the registry". Same rule as every other field on this document.
   */
  ladm?: DeedLadm;

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

/**
 * The LADM half of the certificate.
 *
 * Flattened to strings HERE rather than in the renderer, so that the deed and
 * the panel quote the same wording for the same class -- both go through
 * lib/ladm.ts's label functions -- and so that this module stays the single
 * source for what a deed says.
 */
export interface DeedLadm {
  su_id: string;
  su_type: string;
  dimension: string;
  provenance: string;
  /** The stored, orthometric extent. Always present on a 3D unit. */
  z_msl?: { z_min: number; z_max: number };
  /** EPSG:4979. Absent where the project records no geoid separation. */
  z_ellipsoidal?: { z_min: number; z_max: number };
  geoid_separation_m?: number;
  ba_ulpin?: string;
  ba_name?: string;
  ba_type?: string;
  /** 'Flat 901 — principal — 1', one line per bundled asset. */
  members: string[];
  /** 'Ownership (right) — Rajesh Gupta — DOC/2023/VSP/41730'. */
  rrrs: string[];
  /** 'Title holder — Rajesh Gupta'. */
  parties: string[];
  /** 'Sewer corridor 99002 · GVMC Sewerage Board'. */
  easements: string[];
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
  /**
   * The volume's LADM document, if the caller fetched one.
   *
   * PASSED IN rather than fetched here, because this module is pure -- it is
   * loaded by `node --test` and by scripts/check_volumetric.mjs with no
   * server in reach. DeedButton does the fetch, on click, for the same reason
   * it defers the PDF stack: most sessions never press it.
   */
  ladm?: LADMParcelDoc | null;
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
    // THE QR RESOLVES TO THE LADM RECORD, not to the building document.
    //
    // /api/v1/ladm/parcel/<ulpin> is slug-free on purpose: it resolves the
    // project from the revenue codes inside the identifier, and this is a
    // document somebody keeps. A slug can be renamed; AP-VSP-3D26 cannot,
    // because it IS the identifier. A deed whose QR code stops resolving the
    // day an AOI is renamed is a deed that lied about being durable.
    //
    // Falls back to the building endpoint for a redacted volume with no
    // identifier to address -- which buildDeed refuses to issue anyway, so
    // this is the second gate agreeing with the first.
    api_url: unit.ulpin
      ? `${origin.replace(/\/+$/, '')}/api/v1/ladm/parcel/${unit.ulpin}`
      : `${origin.replace(/\/+$/, '')}/api/p/${slug}/building/${b.id}`,
    datum_note: input.datumNote,
    ...(input.ladm ? { ladm: deedLadmOf(input.ladm) } : {}),
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

/**
 * Flatten a LADM document into the lines the certificate prints.
 *
 * EVERY LABEL COMES FROM lib/ladm.ts, not from a second table of wording here.
 * The panel and the deed must call the same right by the same name, or a
 * reader comparing the screen to the printout finds two documents describing
 * one holding differently.
 *
 * A REDACTED DOCUMENT CONTRIBUTES NOTHING. The server narrows a LADM payload
 * for a caller who may not read it (filterLadmForCaller), and buildDeed
 * already refuses a restricted unit outright -- but if a narrowed document
 * ever reached here, printing its empty rights list under the heading "Legal
 * and spatial rights" would state that a holding has none. So it returns
 * undefined and the section is omitted, which is the third gate agreeing with
 * the first two.
 */
function deedLadmOf(doc: LADMParcelDoc): DeedLadm | undefined {
  if (doc.restricted) return undefined;
  const su = doc.su;
  const out: DeedLadm = {
    su_id: su.su_id,
    su_type: suTypeLabel(su.su_type),
    dimension: su.dimension,
    provenance: su.provenance,
    members: [],
    rrrs: [],
    parties: [],
    easements: [],
  };
  if (su.height) {
    out.z_msl = su.height.msl;
    if (su.height.ellipsoidal) out.z_ellipsoidal = su.height.ellipsoidal;
    if (su.height.geoid_separation_m !== undefined) {
      out.geoid_separation_m = su.height.geoid_separation_m;
    }
  }
  if (doc.ba_unit) {
    out.ba_ulpin = doc.ba_unit.ba_ulpin;
    out.ba_name = doc.ba_unit.name;
    out.ba_type = doc.ba_unit.ba_type === 'condominium_unit'
      ? 'Condominium unit' : 'Basic administrative unit';
    out.members = doc.ba_unit.members.map((m) =>
      `${m.label ?? m.su_id} — ${memberRoleLabel(m.member_role)} — `
      + `share ${formatShare(m.share)}`);
  }
  out.rrrs = doc.rrrs.map((r) => {
    const bits = [`${rrrTypeLabel(r.rrr_type)} (${r.rrr_class})`];
    if (r.party) bits.push(r.party.name);
    if (r.reference) bits.push(r.reference);
    return bits.join(' — ');
  });
  out.parties = doc.parties.map((p) =>
    `${partyRoleLabel(p.role)} — ${p.name}`
    + (p.authority_code ? ` (${p.authority_code})` : ''));
  out.easements = doc.easements.map((e) => e.label ?? e.su_id);
  return out;
}

/**
 * The LADM rows a certificate prints, in order, skipping anything absent.
 *
 * Beside deedRows and deedBoundsRows, and for the same reason: the renderer
 * lays out tables and does not decide what goes in them.
 */
export function ladmRows(d: DeedDoc): [string, string][] {
  const l = d.ladm;
  if (!l) return [];
  const rows: [string, string][] = [];
  const push = (k: string, v: string | undefined | null) => {
    if (v !== undefined && v !== null && v !== '') rows.push([k, v]);
  };
  push('ISO 19152 class', 'LA_SpatialUnit');
  push('Spatial unit id', l.su_id);
  push('Spatial unit type', `${l.su_type} (${l.dimension})`);
  push('Provenance', l.provenance);
  if (l.z_msl) {
    push('Z extent (EGM96 MSL)',
      `${l.z_msl.z_min.toFixed(2)} m to ${l.z_msl.z_max.toFixed(2)} m`);
  }
  if (l.z_ellipsoidal) {
    push('Z extent (EPSG:4979)',
      `${l.z_ellipsoidal.z_min.toFixed(2)} m to `
      + `${l.z_ellipsoidal.z_max.toFixed(2)} m`);
  }
  if (l.geoid_separation_m !== undefined) {
    push('Geoid separation', `${l.geoid_separation_m.toFixed(2)} m`);
  }
  if (l.ba_ulpin) {
    push('ISO 19152 class ', 'LA_BAUnit');
    push('Legal unit', l.ba_name);
    push('Legal unit id', l.ba_ulpin);
    push('Legal unit type', l.ba_type);
  }
  l.members.forEach((m, i) => push(i === 0 ? 'Bundled assets' : '', m));
  if (l.rrrs.length) {
    push('ISO 19152 class  ', 'LA_RRR');
    l.rrrs.forEach((r, i) => push(i === 0 ? 'Rights' : '', r));
  }
  if (l.parties.length) {
    push('ISO 19152 class   ', 'LA_Party');
    l.parties.forEach((p, i) => push(i === 0 ? 'Stakeholders' : '', p));
  }
  if (l.easements.length) {
    l.easements.forEach((e, i) => push(i === 0 ? 'Easements' : '', e));
  }
  return rows;
}
