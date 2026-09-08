/**
 * ULPIN — vertical extension format.
 *
 *     <state>-<district>-<scheme>-<parcel4>-<bldg3>-<floor2>-<unit2>
 *     e.g.  AP-VSP-3D26-0042-007-05-03
 *
 * Right-truncated for coarser entities, so a parcel is the first four groups,
 * a building five, and so on. Floor codes: '00' ground, '01'..'99' above,
 * 'B1'..'B9' basements.
 *
 * THE UNIT SLOT IS TYPED. A flat carries a bare ordinal ('03', '101', '2004');
 * anything that is not a flat carries a one- or two-letter prefix naming what
 * it is -- 'R01' a retail bay, 'P101' a parking slot, 'C01' common space, 'EV'
 * a lift shaft, 'ST' a staircase core. See UnitKind and unitSlot() below.
 * The format stays SEVEN groups: the kind rides in the slot rather than adding
 * an eighth segment, so parse(), ulpin_fmt() and UlpinCard's segment labels are
 * unchanged, and so is every identifier already minted.
 *
 * THE REVENUE CODES ARE PER PROJECT. `state` and `district` come from the
 * project row (projects.state_code / district_code); `scheme` is this
 * application's own series and defaults to '3D26'. Parcel NUMBERING restarts
 * at 0001 in every project, and it is the prefix that keeps two projects'
 * identifiers distinct -- so AP-VSP-3D26-0001 and TS-HYD-3D26-0001 are
 * different parcels in different districts, which is exactly what the real
 * identifier means.
 *
 * Every function here defaults to AP/VSP/3D26. That is not a leftover: it is
 * what makes this change invisible to the demo project. A call that passes no
 * codes produces, byte for byte, the string it produced when those codes were
 * hardcoded, which is why no identifier in data/api/siripuram/ moved.
 *
 * IMPORTANT: this is an UNOFFICIAL vertical extension of the 14-digit ULPIN
 * (Bhu-Aadhaar) land parcel identifier. It is NOT an official government
 * identifier and is not issued by, registered with, or recognised by any
 * revenue department. See DISCLAIMER below, which the UI renders verbatim.
 *
 * Mirrors ulpin_fmt() in db/02_functions.sql byte for byte, including the
 * defaults for the three code arguments.
 */

/** The revenue codes an identifier is minted under. */
export interface UlpinCodes {
  /** Two-letter state code, e.g. 'AP', 'TS'. */
  state: string;
  /** District code, e.g. 'VSP', 'HYD'. */
  district: string;
  /** This application's own series. */
  scheme: string;
}

export const DEFAULT_CODES: UlpinCodes = {
  state: 'AP',
  district: 'VSP',
  scheme: '3D26',
};

/** The demo project's prefix, kept as a named constant for readability. */
export const ULPIN_PREFIX = 'AP-VSP-3D26';

export const DISCLAIMER =
  'Unofficial vertical extension of the 14-digit ULPIN (Bhu-Aadhaar). ' +
  'Not an official government identifier.';

/**
 * What a unit slot names.
 *
 * The cadastre stopped being a stack of flats the moment a level could hold a
 * parking bay, a shop, an atrium or a lift shaft. A reader looking at
 * `-00-R01` has to be able to tell a titled retail bay from the circulation
 * beside it WITHOUT fetching the row, which is what the letter prefix is for.
 *
 * 'flat' carries NO prefix. That is what keeps every identifier already minted
 * -- the 80 flats in Sampath Skyline, the 27 cells in Dutt Island, and every
 * unit in the two OSM-derived projects -- byte-identical across this change.
 */
export type UnitKind =
  | 'flat' | 'retail' | 'anchor' | 'parking'
  | 'circulation' | 'atrium' | 'elevator' | 'stair' | 'plant';

/**
 * The letter a kind writes into the unit slot.
 *
 * 'anchor' shares 'R' with 'retail' and 'atrium' shares 'C' with
 * 'circulation' DELIBERATELY: both pairs are the same thing to the register --
 * a titled commercial bay, and common space nobody holds -- and differ only in
 * how the panel labels them. Encoding that difference in the identifier would
 * be asserting a distinction the cadastre does not actually record.
 */
const SLOT_PREFIX: Record<UnitKind, string> = {
  flat: '',
  retail: 'R',
  anchor: 'R',
  parking: 'P',
  circulation: 'C',
  atrium: 'C',
  elevator: 'EV',
  stair: 'ST',
  plant: 'PL',
};

/**
 * The kind a slot's prefix implies.
 *
 * One-way by necessity: 'R01' cannot say whether it was minted as a shop or as
 * the anchor store, so it reads back as the base kind of its letter. The row's
 * own `kind` column is the authority; this is for reading a bare string.
 */
const KIND_OF_PREFIX: Record<string, UnitKind> = {
  R: 'retail',
  P: 'parking',
  C: 'circulation',
  EV: 'elevator',
  ST: 'stair',
  PL: 'plant',
};

export interface UlpinParts {
  parcel: number;
  building?: number;
  floor?: number;
  /**
   * The numeric tail of the unit slot, e.g. 101 for both '101' and 'P101'.
   *
   * Absent for a slot that carries no number at all -- a lift shaft is 'EV',
   * not 'EV01', because there is one of it per level and numbering it would
   * imply a second.
   */
  unit?: number;
  /** The unit slot exactly as written, e.g. '101', 'R01', 'EV'. */
  unitSlot?: string;
  /** What the slot's prefix says it is. 'flat' when there is no prefix. */
  unitKind?: UnitKind;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/**
 * Encode a unit slot for a kind.
 *
 * unitSlot('flat', 101)    -> '101'
 * unitSlot('retail', 1)    -> 'R01'
 * unitSlot('parking', 101) -> 'P101'
 * unitSlot('elevator')     -> 'EV'
 *
 * Ordinals are padded to two digits and left alone above 99 -- `padStart` only
 * pads up -- so a flat numbered 2004 stays '2004' rather than being truncated.
 */
export function unitSlot(kind: UnitKind, ordinal?: number): string {
  const p = SLOT_PREFIX[kind];
  if (ordinal === undefined || ordinal === null) {
    if (!p) throw new Error(`unitSlot: kind '${kind}' needs an ordinal`);
    return p;
  }
  return `${p}${pad(ordinal, 2)}`;
}

/**
 * Read a unit slot back into its kind and ordinal, or null if it is not one.
 *
 * Accepts exactly what unitSlot() emits, so it is the same grammar the ULPIN
 * regex uses -- a slot this rejects is one parse() would have rejected too.
 */
export function parseUnitSlot(
  slot: string,
): { kind: UnitKind; ordinal?: number } | null {
  const m = /^(EV|ST|PL|[RPC])?(\d{2,4})?$/.exec(slot.trim().toUpperCase());
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  // A letter prefix that takes an ordinal must have one, and one that does not
  // must not: 'R' alone and 'EV01' are both malformed.
  const bare = m[1] === 'EV' || m[1] === 'ST' || m[1] === 'PL';
  if (m[1] !== undefined && bare !== (m[2] === undefined)) return null;
  const kind = m[1] ? (KIND_OF_PREFIX[m[1]] ?? 'flat') : 'flat';
  return m[2] === undefined ? { kind } : { kind, ordinal: Number(m[2]) };
}

function withDefaults(codes?: Partial<UlpinCodes>): UlpinCodes {
  return codes ? { ...DEFAULT_CODES, ...codes } : DEFAULT_CODES;
}

/** The three-group prefix an identifier carries, e.g. 'TS-HYD-3D26'. */
export function prefixFor(codes?: Partial<UlpinCodes>): string {
  const c = withDefaults(codes);
  return `${c.state}-${c.district}-${c.scheme}`;
}

/** Encode a level number as its two-character floor code. */
export function floorCode(level: number): string {
  return level < 0 ? `B${Math.abs(level)}` : pad(level, 2);
}

/** Decode a two-character floor code back to a signed level number. */
export function parseFloorCode(code: string): number {
  return code.startsWith('B') ? -Number(code.slice(1)) : Number(code);
}

/**
 * Build a ULPIN, truncating at the first omitted level.
 * generate(42)                       -> AP-VSP-3D26-0042
 * generate(42, 7)                    -> AP-VSP-3D26-0042-007
 * generate(42, 7, -2)                -> AP-VSP-3D26-0042-007-B2
 * generate(42, 7, 5, 3)              -> AP-VSP-3D26-0042-007-05-03
 * generate(42, 7, 5, 3, tsHydCodes)  -> TS-HYD-3D26-0042-007-05-03
 *
 * `unit` takes a STRING for a typed slot, which passes through verbatim:
 * generate(165, 1, 0, unitSlot('retail', 1))  -> AP-VSP-3D26-0165-001-00-R01
 * generate(9999, 1, -2, unitSlot('elevator')) -> AP-VSP-3D26-9999-001-B2-EV
 */
export function generate(
  parcel: number,
  building?: number,
  floor?: number,
  unit?: number | string,
  codes?: Partial<UlpinCodes>,
): string {
  let out = `${prefixFor(codes)}-${pad(parcel, 4)}`;
  if (building === undefined || building === null) return out;
  out += `-${pad(building, 3)}`;
  if (floor === undefined || floor === null) return out;
  out += `-${floorCode(floor)}`;
  if (unit === undefined || unit === null) return out;
  return `${out}-${typeof unit === 'string' ? unit : pad(unit, 2)}`;
}

/**
 * Which codes to accept when reading an identifier.
 *
 * A concrete set validates the prefix, which is what "is this one of ours"
 * means when you know whose you are. 'any' accepts whatever well-formed prefix
 * the identifier carries, which is what a viewer already showing a project's
 * data needs: the server minted the string, and re-checking its district
 * against a constant would only reject the project the user is looking at.
 */
export type CodeMatch = Partial<UlpinCodes> | 'any';

/** Escape a code for literal use in a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Anything with the right SHAPE, whatever codes it carries. Structure only --
 * two letters, two to four letters, four alphanumerics -- so a string that is
 * not an identifier at all still fails.
 */
const ANY_PREFIX = '([A-Z]{2})-([A-Z]{2,4})-([A-Z0-9]{4})';

/**
 * The tail: parcel, then optionally building, floor and unit slot.
 *
 * THE UNIT GROUP USED TO BE `(\d{2})`, and that was wrong for data this
 * repository already shipped. The demo tower's flats are numbered by storey --
 * '101' on level 1, '2004' on level 20 -- so all 80 of them failed to parse,
 * which silently dropped UlpinCard's segment breakdown and made parentOf()
 * return null for every flat in the building. `generate()` was always correct
 * (`padStart` only pads up, so 101 stays '101'); only the reader disagreed.
 *
 * It now accepts two to four digits, optionally behind one of the SPECIFIC
 * kind prefixes unitSlot() writes -- not any letters. Being exact here is what
 * keeps 'AP-VSP-3D26-0042-007-XX' and a one-digit '...-05-3' rejected, as they
 * always were. Every identifier that parsed before still parses to exactly the
 * same parts.
 */
const UNIT_SLOT = String.raw`(?:EV|ST|PL|[RPC]\d{2,4}|\d{2,4})`;

const TAIL = String.raw`-(\d{4})(?:-(\d{3})(?:-(B\d|\d{2})(?:-(${UNIT_SLOT}))?)?)?$`;

function patternFor(codes: CodeMatch): RegExp {
  if (codes === 'any') return new RegExp(`^${ANY_PREFIX}${TAIL}`);
  const c = withDefaults(codes);
  return new RegExp(
    `^(${esc(c.state)})-(${esc(c.district)})-(${esc(c.scheme)})${TAIL}`,
  );
}

function match(ulpin: string, codes: CodeMatch): RegExpMatchArray | null {
  if (typeof ulpin !== 'string') return null;
  return ulpin.trim().toUpperCase().match(patternFor(codes));
}

/**
 * Parse a ULPIN back into its parts, or null if it is not one of ours.
 *
 * Defaults to the demo project's codes, so `parse(x)` still rejects
 * 'XX-VSP-3D26-0042' exactly as it always has. Pass 'any' to read an
 * identifier from a project whose codes you are not asserting.
 */
export function parse(ulpin: string, codes: CodeMatch = DEFAULT_CODES): UlpinParts | null {
  const m = match(ulpin, codes);
  if (!m) return null;
  const parts: UlpinParts = { parcel: Number(m[4]) };
  if (m[5] !== undefined) parts.building = Number(m[5]);
  if (m[6] !== undefined) parts.floor = parseFloorCode(m[6]);
  if (m[7] !== undefined) {
    // Cannot be null: the regex group above is the same grammar.
    const slot = parseUnitSlot(m[7])!;
    parts.unitSlot = m[7];
    parts.unitKind = slot.kind;
    // Left undefined for a slot with no number ('EV'), rather than 0 -- there
    // is no unit zero, and a consumer testing `parts.unit !== undefined`
    // should not be told a lift shaft is the ground-floor unit.
    if (slot.ordinal !== undefined) parts.unit = slot.ordinal;
  }
  return parts;
}

/**
 * The revenue codes an identifier carries.
 *
 * Kept apart from parse() rather than folded into UlpinParts so that parse()'s
 * return shape is unchanged -- callers deep-compare it.
 */
export function codesOf(ulpin: string): UlpinCodes | null {
  const m = match(ulpin, 'any');
  if (!m) return null;
  return { state: m[1], district: m[2], scheme: m[3] };
}

/**
 * Which cadastral level a ULPIN addresses.
 *
 * Permissive about codes by default: this answers "how deep does this
 * identifier go", a question whose answer does not depend on which district
 * minted it.
 */
export function levelOf(
  ulpin: string,
  codes: CodeMatch = 'any',
): 'parcel' | 'building' | 'floor' | 'unit' | null {
  const p = parse(ulpin, codes);
  if (!p) return null;
  // unitSlot, not unit: a lift shaft's slot is a bare 'EV' with no ordinal,
  // and it is still a unit-level identifier.
  if (p.unitSlot !== undefined) return 'unit';
  if (p.floor !== undefined) return 'floor';
  if (p.building !== undefined) return 'building';
  return 'parcel';
}

/**
 * The ULPIN of the containing entity, or null at parcel level.
 *
 * Permissive about codes for the same reason as levelOf, and it re-emits the
 * prefix it found rather than a default one, so walking up a TS-HYD
 * identifier never silently relabels it as AP-VSP.
 */
export function parentOf(ulpin: string, codes: CodeMatch = 'any'): string | null {
  const p = parse(ulpin, codes);
  if (!p) return null;
  const c = codesOf(ulpin) ?? DEFAULT_CODES;
  if (p.unitSlot !== undefined) return generate(p.parcel, p.building, p.floor, undefined, c);
  if (p.floor !== undefined) return generate(p.parcel, p.building, undefined, undefined, c);
  if (p.building !== undefined) return generate(p.parcel, undefined, undefined, undefined, c);
  return null;
}

/** Human label for a floor level, matching the ladder rungs. */
export function levelLabel(level: number, topLevel?: number): string {
  if (level < 0) return `B${Math.abs(level)}`;
  if (level === 0) return 'G';
  if (topLevel !== undefined && level === topLevel) return 'R';
  return String(level);
}

export const PROVENANCE_LABEL: Record<string, string> = {
  osm_tag: 'OSM tag (mapped)',
  surveyed_plan: 'Surveyed plan',
  dsm_dem: 'DSM/DEM derived',
  estimated: 'Estimated',
};

/** Estimated data is explicitly not authoritative; the UI colours it apart. */
export const PROVENANCE_IS_AUTHORITATIVE: Record<string, boolean> = {
  osm_tag: true,
  surveyed_plan: true,
  dsm_dem: false,
  estimated: false,
};
