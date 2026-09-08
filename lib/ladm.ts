/**
 * ISO 19152 (LADM) — the four core classes, and the mapping from this
 * cadastre onto them.
 *
 * PURE, AND CESIUM-FREE. Relative `.ts` imports, no `window`, no `pg`, so
 * `node --test` loads it directly -- the same discipline lib/ulpin.ts,
 * lib/datum.ts and lib/deed/certificate.ts already keep. lib/ladm.test.ts
 * exercises every function here.
 *
 * WHAT LADM ADDS THAT THE CADASTRE DID NOT HAVE. db/01_schema.sql has
 * described itself as "LADM-inspired" since its second line, and the
 * containment hierarchy really does follow LADM. What was missing was the
 * half that hierarchy exists to serve: rights and holders were flat text on
 * the rows they described, so the only join between Flat 901, its parking
 * slot and its share of the ground was that all three carried the same owner
 * STRING. LA_Party makes a holder a row; LA_BAUnit makes a holding a row;
 * LA_RRR makes a right a row that points at both.
 *
 * THE TWO DATUMS. Every z in this database is ORTHOMETRIC (EGM96) -- see
 * projects.elev_datum and lib/datum.ts. EPSG:4979, which LADM consumers
 * expect for a 3D CRS, is ELLIPSOIDAL. Those differ by about 65 metres at
 * Visakhapatnam, so a payload that quoted one number and named the other
 * would be wrong by the height of a twenty-storey building. `heightRange()`
 * below therefore publishes both, each against its own CRS, and publishes the
 * ellipsoidal pair only when the project records a geoid separation -- absent
 * means NOT KNOWN, never zero, which would assert that the two coincide.
 */
import type {
  FlatRegisterEntry, ParcelInfo, Ring, UnitInfo, UtilityProps,
} from './types.ts';
import type { GeoidSeparation } from './datum.ts';
import { DATUM_LABEL, EGM96_DATUM, orthometricToEllipsoidal } from './datum.ts';
import type { UnitKind } from './ulpin.ts';

// ---------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------

/**
 * The revenue prefix a spatial-unit identifier carries: 'AP-VSP-3D26'.
 *
 * Structure only -- two letters, two to four letters, four alphanumerics --
 * so a string that is not an identifier at all still fails. Deliberately
 * SHORTER than lib/ulpin.ts's own pattern, which also requires a parcel
 * number and everything after it: most su_ids are ULPINs and would match
 * that, but a utility corridor's is '<prefix>-UTL-00042' and an air-rights
 * volume's is '<prefix>-AIR-TTF-P07', and neither is a ULPIN. Reusing
 * codesOf() here would have made those two classes unaddressable.
 */
const SU_PREFIX_RE = /^([A-Z]{2})-([A-Z]{2,4})-([A-Z0-9]{4})-/;

export interface SuCodes {
  state: string;
  district: string;
  scheme: string;
}

/**
 * The revenue codes a spatial-unit identifier carries, or null.
 *
 * This is what lets `/api/v1/ladm/parcel/:ulpin3d` resolve a project without
 * being told one: the codes are matched against projects.state_code /
 * district_code / scheme_code, which every backend already serves.
 */
export function codesOfSuId(suId: string): SuCodes | null {
  if (typeof suId !== 'string') return null;
  const m = suId.trim().toUpperCase().match(SU_PREFIX_RE);
  if (!m) return null;
  return { state: m[1], district: m[2], scheme: m[3] };
}

/**
 * The spatial-unit identifier for a utility run.
 *
 * MIRRORS ladm_utility_su_id() in db/02_functions.sql byte for byte, and
 * lib/ladm.test.ts holds the pair to fixed expectations -- this string is a
 * primary key, and the PostGIS backend and the snapshot backend must mint the
 * same one or the same corridor becomes two spatial units.
 *
 * Padded to five digits and LEFT ALONE above that. SQL's lpad() truncates a
 * longer string rather than passing it through, which mapped utility 100000
 * and 100001 both onto 'UTL-10000'; `padStart` only pads up, so the two
 * implementations agree only if this one is explicit about the wide case.
 */
export function suIdForUtility(prefix: string, id: number): string {
  const n = id < 100000 ? String(id).padStart(5, '0') : String(id);
  return `${prefix}-UTL-${n}`;
}

/**
 * The spatial-unit identifier for an air-rights volume.
 *
 * Air rights have no row in either backend: flyover decks and pillars are
 * file-sourced specs (lib/infra/) so that they render with the database down.
 * The identifier is minted from the spec at request time, which is why this
 * function has no SQL counterpart.
 */
export function suIdForAirRights(prefix: string, siteId: string, ref: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return `${prefix}-AIR-${clean(siteId)}-${clean(ref)}`;
}

/** The BA unit that holds one spatial unit, by identifier. */
export function baUlpinFor(suId: string): string {
  return `${suId}-BA`;
}

// ---------------------------------------------------------------------------
// The classes.
// ---------------------------------------------------------------------------

/** LADM LA_PartyType. */
export type LADMPartyType = 'natural_person' | 'non_natural_person' | 'group';

/** The capacity a party acts in. Mirrors la_party.role. */
export type LADMPartyRole =
  | 'owner' | 'tenant_association' | 'municipal_body'
  | 'utility_operator' | 'bank' | 'surveyor';

/** LADM LA_DimensionType, narrowed to the two this cadastre stores. */
export type LADMDimension = '2D' | '3D';

/** Mirrors la_spatial_unit.su_type. */
export type LADMSpatialUnitType =
  | 'surface' | 'multi_storey' | 'subterranean' | 'air_rights';

/** Mirrors la_spatial_unit.source_kind, plus the file-sourced 'infra'. */
export type LADMSourceKind =
  | 'parcel' | 'survey_parcel' | 'unit' | 'utility' | 'infra';

/** Mirrors la_rrr.rrr_class. */
export type LADMRRRClass = 'right' | 'restriction' | 'responsibility';

/** Mirrors la_rrr.rrr_type. */
export type LADMRRRType =
  | 'ownership' | 'tenancy' | 'mortgage' | 'easement'
  | 'height_restriction' | 'structural_restriction'
  | 'tax_demand' | 'maintenance';

/** Mirrors la_ba_unit_member.member_role. */
export type LADMMemberRole = 'principal' | 'appurtenant' | 'undivided_share';

/** Mirrors la_spatial_unit.provenance. */
export type LADMProvenance = 'surveyed' | 'derived' | 'estimated';

/**
 * A fraction, kept as two integers.
 *
 * NOT a float. An undivided share of 1/3 is exactly 1/3 on a document people
 * keep, and the shares of one building must sum to exactly 1 -- both of which
 * 0.3333333333333333 fails at. The renderer formats; it does not divide.
 */
export interface LADMShare {
  num: number;
  den: number;
}

/** ISO 19152 LA_Party. */
export interface LADMParty {
  /** Absent on a party the caller may not see -- see redaction in the API. */
  party_id?: number;
  name: string;
  party_type: LADMPartyType;
  role: LADMPartyRole;
  /** 'GVMC', 'APEPDCL'. Absent for a private person, who has no such code. */
  authority_code?: string;
}

/** ISO 19152 LA_RRR. */
export interface LADMRRR {
  rrr_id?: number;
  rrr_class: LADMRRRClass;
  rrr_type: LADMRRRType;
  /** The holder. Absent on a restriction imposed by a rule, not a person. */
  party?: LADMParty;
  share?: LADMShare;
  /** ISO yyyy-mm-dd. A missing `to` means still in force. */
  from?: string;
  to?: string;
  amount_inr?: number;
  /** Loan number, assessment number, registered deed number. */
  reference?: string;
  description?: string;
  /**
   * True where this row was PROJECTED from the flat register rather than read
   * from the cadastre. The panel and the deed mark those, because the two
   * records have different owners and different update cadences.
   */
  from_register?: boolean;
}

/** One spatial unit inside a bundle, with the share it is held on. */
export interface LADMBAUnitMember {
  su_id: string;
  member_role: LADMMemberRole;
  share: LADMShare;
  su_type: LADMSpatialUnitType;
  /** 'Flat 901', 'Parking Slot P-102', 'Plot AP-VSP-3D26-0042'. */
  label?: string;
}

/** ISO 19152 LA_BAUnit. */
export interface LADMBAUnit {
  ba_unit_id?: number;
  ba_ulpin: string;
  name: string;
  ba_type: 'basic_administrative_unit' | 'condominium_unit';
  /** The official 14-digit ULPIN, where the survey record carries one. */
  ulpin_14?: string;
  members: LADMBAUnitMember[];
}

/**
 * A vertical extent, published against BOTH datums.
 *
 * `msl` is what the database stores. `ellipsoidal` is the same extent
 * converted through the project's geoid separation, and is ABSENT when no
 * separation is recorded -- which means "not known", never zero.
 */
export interface LADMHeightRange {
  msl: { z_min: number; z_max: number };
  msl_crs: string;
  ellipsoidal?: { z_min: number; z_max: number };
  ellipsoidal_crs: string;
  geoid_separation_m?: number;
  datum_note: string;
}

/** ISO 19152 LA_SpatialUnit. */
export interface LADMSpatialUnit {
  su_id: string;
  su_type: LADMSpatialUnitType;
  dimension: LADMDimension;
  source_kind: LADMSourceKind;
  source_id?: number;
  provenance: LADMProvenance;
  /** Absent on a 2D unit, whose vertical extent is genuinely unrecorded. */
  height?: LADMHeightRange;
  /** Absent where the source records no area to derive one from. */
  volume_m3?: number;
  /** The plan ring, when the caller asked for geometry. */
  ring?: Ring;
  label?: string;
}

/** The assembled document one LADM endpoint serves. */
export interface LADMParcelDoc {
  su: LADMSpatialUnit;
  /** Absent for a spatial unit no administrative record covers. */
  ba_unit?: LADMBAUnit;
  rrrs: LADMRRR[];
  parties: LADMParty[];
  /**
   * Subterranean runs whose corridor meets this unit, with the easement each
   * is held under. Resolved per request rather than stored: which plots a run
   * burdens is a spatial question a projection cannot keep current.
   */
  easements: LADMSpatialUnit[];
  project: { slug: string; name: string };
  /**
   * True when the caller was served a narrowed document. The viewer prints
   * the reason rather than an empty card, so "you may not read this" is never
   * shown as "there is nothing here".
   */
  restricted?: boolean;
  /**
   * WHY it was narrowed, in words the panel prints verbatim.
   *
   * Carried on the document rather than composed in the viewer, for the same
   * reason `disclaimer` is: "you may not read this" and "nothing is registered
   * here" are opposite facts, and the component that renders an empty card
   * must not be the one deciding which of the two it means.
   */
  redaction_note?: string;
  disclaimer: string;
  issued_at: string;
}

// ---------------------------------------------------------------------------
// CRS.
// ---------------------------------------------------------------------------

/**
 * The CRS this cadastre stores, as an OGC URN.
 *
 * EPSG:4326 for the horizontal, EPSG:5773 (EGM96 height) for the vertical --
 * a COMPOUND CRS, which is what a lon/lat/orthometric-height triple actually
 * is. db/01_schema.sql declares the geometry columns 4326 and carries Z
 * inside them, which is a convenience PostGIS allows and not a claim that the
 * heights are ellipsoidal.
 */
export const CRS_STORED = 'urn:ogc:def:crs,crs:EPSG::4326,crs:EPSG::5773';

/**
 * EPSG:4979 -- WGS 84 3D, ellipsoidal height. What a LADM consumer expects of
 * a 3D CRS, and what `LADMHeightRange.ellipsoidal` is expressed in.
 */
export const CRS_ELLIPSOIDAL = 'urn:ogc:def:crs:EPSG::4979';

/** EPSG:4326, for the 2D ring GeoJSON carries. */
export const CRS_2D = 'urn:ogc:def:crs:OGC:1.3:CRS84';

/**
 * Build the two-datum height range for a stored z extent.
 *
 * `sep` is projects.geoid_sep_m: null or undefined means the separation was
 * never measured for this AOI. In that case the ellipsoidal pair is OMITTED
 * rather than defaulted, because emitting the orthometric numbers under an
 * EPSG:4979 label would be a 65-metre error presented as a coordinate.
 */
export function heightRange(
  z_min: number, z_max: number, sep: GeoidSeparation,
): LADMHeightRange {
  const out: LADMHeightRange = {
    msl: { z_min, z_max },
    msl_crs: CRS_STORED,
    ellipsoidal_crs: CRS_ELLIPSOIDAL,
    datum_note: DATUM_LABEL[EGM96_DATUM],
  };
  if (sep !== null && sep !== undefined && Number.isFinite(sep)) {
    out.geoid_separation_m = sep;
    out.ellipsoidal = {
      z_min: orthometricToEllipsoidal(z_min, sep),
      z_max: orthometricToEllipsoidal(z_max, sep),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row -> class mappers.
// ---------------------------------------------------------------------------

/**
 * Which volumes are separately titled.
 *
 * The SAME predicate DetailPanel's UNIT_KINDS table applies and
 * lib/deed/certificate.ts honours when it nulls `owner` for an untitled
 * volume. A staircase is a spatial unit that nobody holds -- LADM expresses
 * that precisely -- and giving it an ownership right would put a holder where
 * the register has none.
 */
const TITLED_KINDS: ReadonlySet<string> = new Set(['flat', 'retail', 'anchor']);

export function isTitledKind(kind: UnitKind | string | undefined): boolean {
  return TITLED_KINDS.has(kind ?? 'flat');
}

/** LA_SpatialUnit for a volume in `unit`. */
export function spatialUnitOfUnit(
  unit: UnitInfo, sep: GeoidSeparation, provenance: LADMProvenance = 'derived',
): LADMSpatialUnit {
  const su: LADMSpatialUnit = {
    // A redacted unit arrives with no ULPIN. It still has a shape and a
    // vertical extent, and those are what the caller is allowed to see.
    su_id: unit.ulpin ?? '',
    su_type: 'multi_storey',
    dimension: '3D',
    source_kind: 'unit',
    source_id: unit.id,
    provenance,
    height: heightRange(unit.z_min, unit.z_max, sep),
    ring: unit.ring,
  };
  if (unit.built_m2 !== undefined) {
    su.volume_m3 = unit.built_m2 * (unit.z_max - unit.z_min);
  }
  const label = unit.label ?? unit.unit_no;
  if (label) su.label = label;
  return su;
}

/** LA_SpatialUnit for a surface plot. 2D: a parcel has no recorded height. */
export function spatialUnitOfParcel(parcel: ParcelInfo): LADMSpatialUnit {
  return {
    su_id: parcel.ulpin,
    su_type: 'surface',
    dimension: '2D',
    source_kind: 'parcel',
    source_id: parcel.id,
    provenance: 'derived',
    label: `Plot ${parcel.ulpin}`,
  };
}

/**
 * LA_SpatialUnit for a utility corridor.
 *
 * The corridor is the run's centreline swept by its radius, so the vertical
 * extent is the centreline depth plus and minus that radius -- the same
 * envelope `make_prism` builds for the conflict test. `depth_m` is negative
 * below ground, which is why z_min is the smaller of the two either way.
 */
export function spatialUnitOfUtility(
  utility: UtilityProps, prefix: string, groundZ: number, sep: GeoidSeparation,
): LADMSpatialUnit {
  const centre = groundZ + utility.depth_m;
  return {
    su_id: suIdForUtility(prefix, utility.id),
    su_type: 'subterranean',
    dimension: '3D',
    source_kind: 'utility',
    source_id: utility.id,
    provenance: utility.provenance === 'surveyed' ? 'surveyed' : 'estimated',
    height: heightRange(centre - utility.radius_m, centre + utility.radius_m, sep),
    label: `${utility.asset_type} corridor ${utility.ref ?? utility.id}`,
  };
}

/**
 * LA_SpatialUnit for an air-rights volume -- a flyover deck or pillar.
 *
 * Assembled from the spec, not from a row: there is no infra table in either
 * backend, deliberately, so that a flyover renders with the database down.
 * `provenance` is always 'derived' because these components are OUR
 * arithmetic over a site's sourced facts, which is the split
 * lib/infra/types.ts draws and the panel already marks.
 */
export function spatialUnitOfAirRights(
  prefix: string, siteId: string, ref: string,
  z_min: number, z_max: number, sep: GeoidSeparation,
  label?: string, footprint_m2?: number,
): LADMSpatialUnit {
  const su: LADMSpatialUnit = {
    su_id: suIdForAirRights(prefix, siteId, ref),
    su_type: 'air_rights',
    dimension: '3D',
    source_kind: 'infra',
    provenance: 'derived',
    height: heightRange(z_min, z_max, sep),
  };
  if (footprint_m2 !== undefined) su.volume_m3 = footprint_m2 * (z_max - z_min);
  if (label) su.label = label;
  return su;
}

// ---------------------------------------------------------------------------
// The flat register, projected.
// ---------------------------------------------------------------------------

/**
 * Project a flat-register entry into LA_RRR rows.
 *
 * THE REGISTER IS NOT MIGRATED, AND MUST NOT BE. lib/db.ts:254-270 states
 * why: mortgages, tax demands and bills have a different record owner and a
 * different update cadence from the cadastre, and reading ONE committed file
 * on both backends is what stops PostGIS and the snapshot disagreeing about
 * money. So these rows are built on read and carry `from_register: true`, and
 * the viewer says so. Copying them into la_rrr would create the split-brain
 * that file exists to prevent.
 *
 * Bills are deliberately NOT projected. A quarterly water bill is a payment
 * against a service, not a right, a restriction or a responsibility in the
 * property, and forcing it into LA_RRR to make the card look fuller would be
 * a misuse of the class.
 */
export function rrrFromRegister(entry: FlatRegisterEntry): LADMRRR[] {
  const out: LADMRRR[] = [];

  if (entry.title_deed || entry.registered_on) {
    const r: LADMRRR = {
      rrr_class: 'right',
      rrr_type: 'ownership',
      from_register: true,
      description: 'Registered title',
    };
    if (entry.title_deed) r.reference = entry.title_deed;
    if (entry.registered_on) r.from = entry.registered_on;
    out.push(r);
  }

  if (entry.mortgage) {
    const m = entry.mortgage;
    out.push({
      rrr_class: 'restriction',
      rrr_type: 'mortgage',
      from_register: true,
      party: {
        name: m.bank,
        party_type: 'non_natural_person',
        role: 'bank',
      },
      reference: m.loan_no,
      amount_inr: m.outstanding_inr,
      from: m.charge_from,
      to: m.closes_on,
      description: `Charge held by ${m.bank}, ${m.branch}`,
    });
  }

  if (entry.tax) {
    const t = entry.tax;
    out.push({
      rrr_class: 'responsibility',
      rrr_type: 'tax_demand',
      from_register: true,
      party: {
        name: t.authority,
        party_type: 'non_natural_person',
        role: 'municipal_body',
      },
      // The assessment number IS the demand id the requirement asks for.
      reference: t.assessment_no,
      amount_inr: t.demand_inr,
      to: t.due_on,
      description: `Property tax ${t.year}`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Presentation helpers, shared by the panel, the deed and the tests.
// ---------------------------------------------------------------------------

/** '1/3', or '1' for a whole holding. Never a decimal. */
export function formatShare(share: LADMShare | undefined): string {
  if (!share) return '1';
  if (share.den === 1) return String(share.num);
  return `${share.num}/${share.den}`;
}

/** The ISO 19152 class name a card is labelled with. */
export const LADM_CLASS_LABEL = {
  spatial_unit: 'LA_SpatialUnit',
  ba_unit: 'LA_BAUnit',
  rrr: 'LA_RRR',
  party: 'LA_Party',
} as const;

const SU_TYPE_LABEL: Record<LADMSpatialUnitType, string> = {
  surface: 'Surface plot',
  multi_storey: 'Multi-storey volume',
  subterranean: 'Subterranean corridor',
  air_rights: 'Elevated air rights',
};

export function suTypeLabel(t: LADMSpatialUnitType): string {
  return SU_TYPE_LABEL[t] ?? t;
}

const RRR_TYPE_LABEL: Record<LADMRRRType, string> = {
  ownership: 'Ownership',
  tenancy: 'Tenancy',
  mortgage: 'Mortgage',
  easement: 'Easement',
  height_restriction: 'Height restriction',
  structural_restriction: 'Structural restriction',
  tax_demand: 'Property tax demand',
  maintenance: 'Maintenance',
};

export function rrrTypeLabel(t: LADMRRRType): string {
  return RRR_TYPE_LABEL[t] ?? t;
}

const MEMBER_ROLE_LABEL: Record<LADMMemberRole, string> = {
  principal: 'Principal holding',
  appurtenant: 'Appurtenant',
  undivided_share: 'Undivided share',
};

export function memberRoleLabel(r: LADMMemberRole): string {
  return MEMBER_ROLE_LABEL[r] ?? r;
}

const PARTY_ROLE_LABEL: Record<LADMPartyRole, string> = {
  owner: 'Title holder',
  tenant_association: 'Tenant association',
  municipal_body: 'Municipal body',
  utility_operator: 'Utility operator',
  bank: 'Charge holder',
  surveyor: 'Surveyor',
};

export function partyRoleLabel(r: LADMPartyRole): string {
  return PARTY_ROLE_LABEL[r] ?? r;
}

// ---------------------------------------------------------------------------
// JSON-LD.
// ---------------------------------------------------------------------------

/**
 * The LADM JSON-LD context.
 *
 * The ISO 19152 vocabulary has no dereferenceable namespace IRI that this
 * project can cite honestly, so the terms are namespaced under a URN for the
 * standard itself. That is a statement about WHICH vocabulary the class names
 * come from -- checkable against the published standard -- and not a link to
 * a document that would 404.
 */
const LADM_NS = 'urn:iso:std:iso:19152:ed-1:';

/**
 * Frame an assembled document as JSON-LD.
 *
 * Kept here rather than in the route so it is testable without a server, and
 * so the class names appear exactly once in the codebase.
 */
export function jsonLd(doc: LADMParcelDoc): Record<string, unknown> {
  const su = doc.su;
  const node: Record<string, unknown> = {
    '@context': {
      '@vocab': LADM_NS,
      ulpin: `${LADM_NS}LA_SpatialUnit#suID`,
      geojson: 'https://purl.org/geojson/vocab#',
    },
    '@type': 'LA_SpatialUnit',
    '@id': `urn:ulpin:${su.su_id}`,
    suID: su.su_id,
    dimension: su.dimension,
    surfaceRelation: su.su_type,
    provenance: su.provenance,
    referenceSystem: {
      stored: CRS_STORED,
      ellipsoidal: CRS_ELLIPSOIDAL,
    },
  };
  if (su.volume_m3 !== undefined) node.volume_m3 = su.volume_m3;
  if (su.height) node.verticalExtent = su.height;
  if (doc.ba_unit) {
    node.baUnit = {
      '@type': 'LA_BAUnit',
      '@id': `urn:ulpin:${doc.ba_unit.ba_ulpin}`,
      uID: doc.ba_unit.ba_ulpin,
      name: doc.ba_unit.name,
      type: doc.ba_unit.ba_type,
      members: doc.ba_unit.members.map((m) => ({
        '@type': 'LA_SpatialUnit',
        '@id': `urn:ulpin:${m.su_id}`,
        role: m.member_role,
        share: formatShare(m.share),
      })),
    };
  }
  node.rrr = doc.rrrs.map((r) => ({
    '@type': 'LA_RRR',
    class: r.rrr_class,
    type: r.rrr_type,
    ...(r.share ? { share: formatShare(r.share) } : {}),
    ...(r.reference ? { reference: r.reference } : {}),
    ...(r.party ? { party: { '@type': 'LA_Party', name: r.party.name } } : {}),
  }));
  node.party = doc.parties.map((p) => ({
    '@type': 'LA_Party',
    name: p.name,
    type: p.party_type,
    role: p.role,
    ...(p.authority_code ? { authorityCode: p.authority_code } : {}),
  }));
  node.disclaimer = doc.disclaimer;
  node.issued = doc.issued_at;
  return node;
}
