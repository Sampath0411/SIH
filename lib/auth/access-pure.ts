/**
 * Pure-logic role checks. NO `next/server` or `next/headers` imports, so
 * this module is testable from a plain Node script. The response
 * builders in lib/auth/access.ts wrap these and return a NextResponse
 * on refusal.
 *
 * The "no Next imports here" rule is the reason every helper in this
 * file returns either null (pass) or a plain object describing the
 * refusal (status + body), instead of a NextResponse. The route
 * handler takes the refusal object and turns it into a NextResponse;
 * the test suite just inspects the status and the error string.
 *
 * callerContext() lives in lib/auth/access.ts because it reads the
 * session from the Next-managed cookie jar, which is a runtime
 * concern, not a rules concern.
 */
import { parse } from '../ulpin.ts';

export type CallerContext =
  | { kind: 'gov' }
  // `floor` and `unit` come straight off the session claims and are what
  // narrows a citizen from "their building" to "their flat".
  | { kind: 'citizen'; slug: string; buildingId: number; floor: number; unit: string }
  | { kind: 'anon' };

export type AccessRefusal = { status: number; body: { error: string } };

/** True when this caller may write to the cadastre. Only gov may. */
export function isMutator(ctx: CallerContext): boolean {
  return ctx.kind === 'gov';
}

/**
 * For a building-scoped request, the citizen must own the building.
 * Returns a refusal on a denial, null on a pass.
 */
export function checkBuildingAccess(
  ctx: CallerContext,
  slug: string,
  buildingId: number,
): AccessRefusal | null {
  if (ctx.kind !== 'citizen') return null;
  if (ctx.slug !== slug || ctx.buildingId !== buildingId) {
    // 404 not 403, deliberately: a 403 would let an attacker enumerate
    // which ids exist by status code. 404 is the same shape a missing
    // building would have.
    return { status: 404, body: { error: 'building not found' } };
  }
  return null;
}

/** A refusal for mutating calls. */
export function checkMutation(ctx: CallerContext): AccessRefusal | null {
  if (ctx.kind === 'citizen') {
    return { status: 403, body: { error: 'government role required to edit' } };
  }
  if (ctx.kind === 'anon') {
    return { status: 401, body: { error: 'unauthenticated' } };
  }
  return null;
}

/** For a project-scoped call, the citizen must be on the right project. */
export function checkProjectAccess(
  ctx: CallerContext,
  slug: string,
): AccessRefusal | null {
  if (ctx.kind !== 'citizen') return null;
  if (ctx.slug !== slug) {
    return { status: 404, body: { error: 'project not found' } };
  }
  return null;
}

/** The subset of a unit this module needs in order to decide who owns it. */
interface UnitLike {
  unit_no: string;
  level_no: number;
}

/**
 * Is this the citizen's own flat?
 *
 * Matched on (level, unit code) because that is what the session carries --
 * the numeric unit id is assigned by the exporter and is not stable across a
 * re-seed, so a claim built on it would silently stop matching the day the
 * snapshot is regenerated. The code is the thing written on the door.
 */
export function ownsUnit(ctx: CallerContext, unit: UnitLike): boolean {
  if (ctx.kind !== 'citizen') return true;
  return unit.level_no === ctx.floor && unit.unit_no === ctx.unit;
}

/**
 * The kinds of volume that are building FABRIC rather than space anyone
 * could hold: the lift shaft, the staircase, the corridors and drive aisles,
 * the plant room. None of them is a registered spatial unit in this
 * cadastre, so none of them carries an identifier out of the API.
 */
const FABRIC_KINDS: ReadonlySet<string> = new Set([
  'elevator', 'stair', 'circulation', 'atrium', 'plant',
]);

/** The register-shaped fields a fabric volume must not carry. */
const IDENTITY_FIELDS = [
  'ulpin', 'carpet_m2', 'built_m2', 'tenure', 'encumbrance',
  'owner', 'address', 'facing',
] as const;

/**
 * Strip the identity off every fabric volume, for every caller.
 *
 * The demo seed writes the cores, the aisles, the lobby and the plant room
 * WITHOUT a ULPIN, because a staircase is not something a person holds and
 * an identifier on it invited exactly that reading -- the panel then had to
 * talk the user out of exporting a certificate for a lift shaft. PostGIS
 * cannot store a NULL there (`unit.ulpin` is UNIQUE NOT NULL), so the row
 * keeps a minted one and this function removes it on the way out. Both
 * backends therefore serve the same document, which is the contract every
 * acceptance script here is built on.
 *
 * `kind`, `core_ref`, `label`, the geometry and the level all survive: they
 * are what the volume IS, and the viewer draws and titles it from them.
 */
export function stripCoreIdentity<
  T extends { units?: UnitLike[] },
>(detail: T): T {
  const units = Array.isArray(detail.units) ? detail.units : [];
  if (!units.some((u) => FABRIC_KINDS.has((u as { kind?: string }).kind ?? 'flat'))) {
    return detail;
  }
  return {
    ...detail,
    units: units.map((u) => {
      const kind = (u as { kind?: string }).kind ?? 'flat';
      if (!FABRIC_KINDS.has(kind)) return u;
      const copy = { ...(u as unknown as Record<string, unknown>) };
      for (const k of IDENTITY_FIELDS) delete copy[k];
      return copy as unknown as UnitLike;
    }),
  };
}

/**
 * What a citizen is told about the building their flat stands in: enough to
 * name it and draw it, and nothing that identifies it as a registered
 * holding of someone else's. The tower's own ULPIN and the developer who
 * owns the plot are not theirs to read.
 */
const CITIZEN_BUILDING_FIELDS = [
  'id', 'name', 'address', 'footprint', 'height_m', 'floors', 'basements',
  'ground_elev', 'ground_source', 'use_type', 'height_source', 'parcel_id',
  'survey_synthetic', 'osm_id',
] as const;

/** The subset of a floor row this module narrows. */
interface FloorLike {
  level_no: number;
  ulpin?: string;
}

/**
 * Narrow a building detail document to what the caller may see.
 *
 * Gov and anon get it verbatim. A CITIZEN GETS THEIR FLAT AND NOTHING ELSE:
 *
 *   floors    only the level their flat is on, and without its ULPIN;
 *   units     their own flat, with its whole register entry, plus the parking
 *             bay that entry allocates to it -- the bay is a term of THEIR
 *             title, and the certificate prints it;
 *   building  name, address and massing (see CITIZEN_BUILDING_FIELDS); no
 *             identifier, no owner;
 *   parcel    dropped. The plot belongs to the developer.
 *
 * This REVERSES the earlier shown-but-redacted design, which kept every
 * neighbour's flat as an anonymous box and every floor as a rung. That was
 * argued for as the more honest picture of where a person lives, and it was;
 * but it also let a citizen page every level of the tower and read every
 * door number, and the product decision is now that the owner's view is the
 * owner's flat -- the other floors and flats are not theirs to browse at all.
 *
 * Done here, on the server, and not in the viewer: anyone can read a
 * response in devtools, so a filter that runs in the browser is decoration.
 */
export function filterDetailForCaller<
  T extends { units?: UnitLike[]; floors?: FloorLike[]; building?: unknown; parcel?: unknown },
>(ctx: CallerContext, detail: T): T {
  if (ctx.kind !== 'citizen') return detail;
  const units = Array.isArray(detail.units) ? detail.units : [];
  const floors = Array.isArray(detail.floors) ? detail.floors : [];

  const own = units.find((u) => ownsUnit(ctx, u));
  const bayUlpin = (own as { parking_ulpin?: string } | undefined)?.parking_ulpin;
  const bay = bayUlpin
    ? units.find((u) => (u as { ulpin?: string }).ulpin === bayUlpin)
    : undefined;

  const building = detail.building && typeof detail.building === 'object'
    ? (() => {
      const src = detail.building as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of CITIZEN_BUILDING_FIELDS) if (k in src) out[k] = src[k];
      return out;
    })()
    : detail.building;

  const { parcel: _parcel, ...rest } = detail;
  void _parcel;
  return {
    ...rest,
    building,
    floors: floors
      .filter((f) => f.level_no === ctx.floor)
      .map((f) => {
        const { ulpin: _u, ...keep } = f;
        void _u;
        return keep as FloorLike;
      }),
    units: [own, bay].filter((u): u is UnitLike => u !== undefined),
  } as unknown as T;
}

/**
 * Is this spatial unit the citizen's own flat?
 *
 * Answered from the IDENTIFIER, because a LADM document is addressed by
 * su_id and does not carry the (level, unit code) pair `ownsUnit` matches on.
 * For a unit-sourced spatial unit the su_id IS the ULPIN, so its floor code
 * and unit slot are exactly the two things the session claims hold.
 *
 * FALSE FOR EVERY OTHER KIND, deliberately. A citizen does not "own" the
 * surface plot, the utility corridor or the survey parcel their flat sits on
 * -- they hold an undivided share of the first and nothing at all in the
 * others -- so those documents are narrowed for them like anyone else's. The
 * share itself is still visible: it is a member of THEIR bundle, and they
 * reach it through their own flat's document.
 */
export function ownsSpatialUnit(ctx: CallerContext, suId: string): boolean {
  if (ctx.kind !== 'citizen') return true;
  const parts = parse(suId, 'any');
  if (!parts || parts.floor === undefined || parts.unitSlot === undefined) return false;
  return parts.floor === ctx.floor && parts.unitSlot === ctx.unit;
}

/** The parts of a LADM document this module narrows. Structural only. */
interface LadmLike {
  su: unknown;
  ba_unit?: unknown;
  rrrs: unknown[];
  parties: unknown[];
  easements: unknown[];
  restricted?: boolean;
  redaction_note?: string;
}

/**
 * Narrow a LADM document to what the caller may see.
 *
 * THIS IS THE MOST SENSITIVE PAYLOAD THE APPLICATION SERVES. Everything
 * `filterDetailForCaller` above exists to strip -- the holder's name, the
 * tenure, the charge, the identifier -- is precisely what LA_Party and LA_RRR
 * are FOR. Serving this document unfiltered would hand back, in a tidier
 * shape, exactly what the building endpoint refuses.
 *
 *   gov               everything
 *   citizen, own flat everything
 *   citizen, other    the spatial unit and the easements over it
 *   anon              the spatial unit and the easements over it
 *
 * THE SPATIAL UNIT SURVIVES because it is the shape of a volume and its place
 * in space, which the viewer already draws on screen for anyone -- withholding
 * the m³ of a box a user is looking at would be theatre, not privacy.
 *
 * THE EASEMENTS SURVIVE for the same reason and one more: they name utility
 * OPERATORS, never people, and /api/utilities already serves the same runs to
 * anyone who asks. Stripping them here would not protect a person; it would
 * only make the two endpoints disagree.
 *
 * WHAT GOES IS EVERY LINK TO A PERSON: the bundle (which says which other
 * assets one holder controls), the rights, and the parties themselves.
 *
 * `restricted` is set rather than the fields merely being absent, so the
 * viewer can print "not yours to read" instead of rendering an empty card
 * that reads as "nothing is registered here" -- the same distinction
 * UnitInfo.restricted draws, and the same one lib/deed/certificate.ts refuses
 * to export across.
 */
export function filterLadmForCaller<T extends LadmLike>(
  ctx: CallerContext, doc: T, owns: boolean,
): T {
  if (ctx.kind === 'gov') return doc;
  if (ctx.kind === 'citizen' && owns) return doc;
  const narrowed: LadmLike = {
    su: doc.su,
    rrrs: [],
    parties: [],
    easements: doc.easements,
    restricted: true,
    redaction_note: ctx.kind === 'anon'
      ? 'Rights and parties are not served to unauthenticated callers. '
        + 'The spatial unit and the easements over it are public.'
      : 'This volume is not yours to read. Sign in as its holder, or as a '
        + 'government user, to see its rights and parties.',
  };
  return narrowed as T;
}
