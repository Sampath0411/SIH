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
 * The geometry and placement every unit keeps, whoever is asking. None of it
 * says anything about who lives there.
 */
const PUBLIC_UNIT_FIELDS = [
  'id', 'floor_id', 'unit_no', 'level_no', 'z_min', 'z_max', 'ring',
] as const;

/**
 * Narrow a building detail document to what the caller may see.
 *
 * Gov and anon get it verbatim. A citizen gets their building, all of its
 * floors, and the SHAPE of every flat -- but the register behind a
 * neighbour's door is redacted: no ULPIN, no owner, no address, no areas, no
 * tenure or encumbrance. They keep `unit_no`, because a door number is
 * written on the door and the floor would be unreadable without it.
 *
 * Shown-but-redacted rather than removed, because a citizen is meant to be
 * able to look at their building and their floor. Deleting the neighbours
 * left them standing in an empty plate, which is a less honest picture of
 * where they live than four flats of which one is theirs.
 *
 * Done here, on the server, and not in the viewer: anyone can read a
 * response in devtools, so a filter that runs in the browser is decoration.
 */
export function filterDetailForCaller<
  T extends { units?: UnitLike[]; floors?: unknown[] },
>(ctx: CallerContext, detail: T): T {
  if (ctx.kind !== 'citizen') return detail;
  const units = Array.isArray(detail.units) ? detail.units : [];
  // Floors carry only geometry and label data today -- z-range, the
  // per-floor ULPIN, the level number, the floor plan -- nothing that
  // names who lives on the floor. They are passed through unchanged,
  // but the type carries the field explicitly so a future per-floor
  // sensitive field would surface here as a type error, not as a leak.
  return {
    ...detail,
    units: units.map((u) => {
      if (ownsUnit(ctx, u)) return u;
      const source = u as unknown as Record<string, unknown>;
      const redacted: Record<string, unknown> = { restricted: true };
      for (const k of PUBLIC_UNIT_FIELDS) {
        if (k in source) redacted[k] = source[k];
      }
      return redacted as unknown as UnitLike;
    }),
  };
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
