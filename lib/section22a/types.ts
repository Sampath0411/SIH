/**
 * Section 22A restricted lands: the record, what the API serves, and the words.
 *
 * WHAT SECTION 22A IS. Section 22A of the Registration Act 1908, as amended in
 * Andhra Pradesh and Telangana, lets the state publish a list of properties a
 * sub-registrar may not register a transaction on -- government land, assigned
 * land, endowment and wakf property, Bhoodan land, ceiling-surplus land, and
 * land under a court's order. The list is kept by the Registration & Stamps
 * department, NOT by the survey department, and that distinction is the reason
 * this module exists at all rather than a column on `survey_parcel`:
 *
 *   the cadastre says WHAT A PLOT IS -- its boundary, its extent, its number
 *   the 22A register says WHAT MAY NOT BE DONE WITH IT
 *
 * They have different owners, different update cadences and different
 * authority. Putting a legal prohibition into a cadastre column would make the
 * survey department appear to assert it. So a 22A entry is a record that
 * REFERENCES a parcel, and the geometry it is drawn with is the cadastre's,
 * borrowed for display and never modified. See resolve.ts.
 *
 * NAMING. `UnitInfo.restricted` and `LADMParcelDoc.restricted` already exist in
 * this codebase and mean ACCESS-CONTROL REDACTION -- "this caller may not see
 * that". Nothing here may be called a bare `restricted`, or the two concepts
 * become one field in someone's head. Everything is `section22a`.
 *
 * Cesium-free and pg-free on purpose: node --test loads this file directly.
 */
import type { GeoFC, GeoFeature, Ring } from '../types.ts';

/**
 * The status a record carries.
 *
 * A union of one, deliberately. The register lists prohibitions; it does not
 * list clearances, and an `UNRESTRICTED` value would invite the frontend to
 * draw a plot as CLEARED because it is absent from a demonstration dataset --
 * which is the single most damaging thing this feature could say. Absence from
 * the register means NOTHING IS KNOWN, and nothing is drawn.
 */
export type Section22AStatus = '22A_RESTRICTED';

/**
 * The clause groups the AP/TS prohibited-property lists are published under.
 *
 * Ordered as the notifications order them. `OTHER` exists because a real
 * register carries entries that do not fit the published groups, and dropping
 * such a record would be quietly hiding a prohibition.
 */
export type Section22ACategory =
  | 'GOVERNMENT_LAND'
  | 'ASSIGNED_LAND'
  | 'ENDOWMENT_LAND'
  | 'WAKF_LAND'
  | 'BHOODAN_LAND'
  | 'CEILING_SURPLUS'
  | 'COURT_ORDER'
  | 'OTHER';

/** Where a record's boundary came from. Reported on the card, never inferred. */
export type Section22AGeometrySource = 'register' | 'cadastre_match';

/** The administrative address a revenue record is written against. */
export interface Section22ALocation {
  village: string;
  mandal: string;
  district: string;
  state: string;
}

/**
 * One register entry, exactly as a source hands it over.
 *
 * This is the shape a real government feed has to be mapped INTO, and it is the
 * only thing lib/section22a/source.ts promises. Every field a register might
 * not carry is nullable, because a record with a missing memo number is still a
 * prohibition and must still be shown.
 */
export interface Section22ARecord {
  /** Stable within one register. Not a database id -- registers are files. */
  id: string;
  status: Section22AStatus;
  category: Section22ACategory;
  /** e.g. "22A(1)(a)". Null when the register does not cite one. */
  clause: string | null;
  /** Revenue survey number, e.g. "123/4". */
  survey_no: string;
  /** The real 14-digit Bhu-Aadhaar, when the register carries one. */
  ulpin_14: string | null;
  /**
   * The extent AS THE REGISTER STATES IT, m².
   *
   * Never overwritten with our own measurement of the drawn polygon. The two
   * are different claims by different authorities and the card shows both when
   * they disagree; see `mapped_extent_sqm` below.
   */
  extent_sqm: number | null;
  location: Section22ALocation;
  /** The department that published the entry. */
  authority: string | null;
  /** Memo / notification / order number. */
  reference: string | null;
  /** ISO date the entry was listed. */
  listed_on: string | null;
  remarks: string | null;
  /**
   * The cadastre parcel this entry is about.
   *
   * A reference, NOT a copy of its geometry. This is what lets the register be
   * replaced without touching a single boundary, and what makes "do not
   * duplicate existing parcel geometry" true by construction.
   */
  parcel_ref: { kind: 'survey_parcel'; id: number } | null;
  /**
   * The register's own boundary, when it has one.
   *
   * A real government dataset is authoritative about where its land is, so this
   * WINS over `parcel_ref` during resolution. Null in a register that only
   * cites survey numbers, which is the common case and the one the mock models.
   */
  geometry: Ring | null;
}

/**
 * What the API serves per feature: the record, plus what resolution learned.
 *
 * The record's own fields are carried through unchanged -- a client reads the
 * register's claim, not our restatement of it -- and everything this
 * application worked out is added alongside with a name that says so.
 */
export interface Section22AProps extends Omit<Section22ARecord, 'geometry'> {
  /** The cadastre parcel matched. Null when the record carried its own ring. */
  parcel_id: number | null;
  /** The parcel's 4-digit ordinal, "0195". What the parcel ULPIN is built from. */
  parcel_label: string | null;
  /** OUR measurement of the drawn ring, m². Distinct from `extent_sqm`. */
  mapped_extent_sqm: number | null;
  geometry_source: Section22AGeometrySource;
}

/**
 * Provenance of the whole collection, carried on the response.
 *
 * `authoritative` is the field the interface's wording keys off. It is false
 * for the demonstration register that ships with this repository, and every
 * surface that shows a 22A result has to say so while it is false -- see
 * SECTION_22A_MOCK_NOTE.
 */
export interface Section22ARegisterMeta {
  source_id: string;
  source_label: string;
  authoritative: boolean;
  /** ISO date the register was read from its publisher. */
  retrieved_on: string | null;
  /** Records the register holds, located or not. */
  record_count: number;
  /**
   * Records that could not be placed on the map.
   *
   * Reported rather than hidden. A register entry whose survey number matches
   * no parcel we hold is a real state -- our cadastre is one ward, the register
   * is a district -- and a count of them is the difference between "there are
   * no others" and "we could not draw the others".
   */
  unlocated_count: number;
}

/** The FeatureCollection the endpoint answers with. */
export interface Section22AFC extends GeoFC<Section22AProps> {
  register: Section22ARegisterMeta;
}

export type Section22AFeature = GeoFeature<Section22AProps>;

/**
 * The disclaimer, verbatim, on every 22A card.
 *
 * A constant because it is asserted by scripts/check_22a.mjs: the wording is a
 * requirement of the feature, not copy, and a check that reads it from here
 * cannot drift from what the panel renders.
 */
export const SECTION_22A_DISCLAIMER =
  '22A status shown here is based on the available government dataset. '
  + 'Verify the latest official land records before making any legal or '
  + 'financial decision.';

/**
 * Said IN ADDITION whenever `register.authoritative` is false.
 *
 * The disclaimer above tells a reader to check the official record. This tells
 * them the thing they are looking at is not an official record at all. The two
 * are different statements and the weaker one must not stand in for the
 * stronger: a demonstration dataset presented under the first sentence alone
 * reads as a government list that might be out of date.
 */
export const SECTION_22A_MOCK_NOTE =
  'This is a demonstration register created for this application. It is NOT '
  + 'the Registration & Stamps Department prohibited-property list, and no '
  + 'plot shown here is asserted to be legally restricted.';

/** Short label for a category. Shown on the card and in the legend. */
export const SECTION_22A_CATEGORY_LABEL: Record<Section22ACategory, string> = {
  GOVERNMENT_LAND: 'Government land',
  ASSIGNED_LAND: 'Assigned land',
  ENDOWMENT_LAND: 'Endowment land',
  WAKF_LAND: 'Wakf property',
  BHOODAN_LAND: 'Bhoodan land',
  CEILING_SURPLUS: 'Ceiling surplus',
  COURT_ORDER: 'Under court order',
  OTHER: 'Other prohibition',
};

/**
 * One line saying what the category MEANS, for a reader who is not a registrar.
 *
 * Paired with the labels above and asserted total over the union in
 * lib/section22a.test.ts, the way lib/ladm.test.ts pairs RRR_TYPE_LABEL: a
 * category that reaches the card with no explanation is a code with no key.
 */
export const SECTION_22A_CATEGORY_NOTE: Record<Section22ACategory, string> = {
  GOVERNMENT_LAND: 'Vested in or owned by the government.',
  ASSIGNED_LAND: 'Assigned to a beneficiary; alienation is barred.',
  ENDOWMENT_LAND: 'Attached to a religious or charitable endowment.',
  WAKF_LAND: 'Registered as wakf property.',
  BHOODAN_LAND: 'Donated under the Bhoodan movement.',
  CEILING_SURPLUS: 'Declared surplus under the urban land ceiling.',
  COURT_ORDER: 'Attached or injuncted by an order of a court.',
  OTHER: 'Prohibited on a ground the register does not group.',
};

/** m² in one acre. The revenue unit land is spoken about in here. */
export const SQM_PER_ACRE = 4046.8564224;

/** Extent in acres. Rounded by the caller, not here. */
export function acresOf(sqm: number): number {
  return sqm / SQM_PER_ACRE;
}

/**
 * Do the register's extent and our measured extent disagree enough to say so?
 *
 * 5%: below that, the difference is the resolution of a Voronoi boundary and
 * the rounding in a revenue record, and reporting it would be noise. Above it,
 * the register is describing a different piece of land from the one being
 * drawn, and a reader deserves to know that before acting on either number.
 */
export const EXTENT_DISAGREEMENT = 0.05;

export function extentsDisagree(
  registerSqm: number | null,
  mappedSqm: number | null,
): boolean {
  if (registerSqm === null || mappedSqm === null) return false;
  if (registerSqm <= 0 || mappedSqm <= 0) return false;
  return Math.abs(registerSqm - mappedSqm) / registerSqm > EXTENT_DISAGREEMENT;
}
