import { NextResponse } from 'next/server';
import { callerTagFromCtx } from '@/lib/http/caller-tag';
import {
  backend, getBuildingDetail, getBuildings, getLadmDoc, getParcels,
  getRoads, getSection22A, getSurveyParcelDetail, getSurveyParcels, getTopology,
  getUtilities,
} from '@/lib/db';
import { applyEdit, editsRev } from '@/lib/data/edits';
import { coerceEdit, validateEdit, warningsFor } from '@/lib/data/building-schema';
import { listProjects, resolveProject, unavailableMessage } from '@/lib/projects';
import { CRS_2D, codesOfSuId, jsonLd } from '@/lib/ladm';
import type { LADMParcelDoc } from '@/lib/ladm';
import { jsonPayload } from '@/lib/http/payload';
import { warmProject } from '@/lib/server-cache';
import {
  cachedDetail, cachedConflicts, cachedQueryPoint, type CacheStatus,
} from '@/lib/cache/store';
import {
  callerContext, enforceBuildingAccess, enforceProjectAccess,
  filterLadmForCaller, narrowDetailForCaller, ownsSpatialUnit, refuseMutation,
} from '@/lib/auth/access';
import type { GeoFC } from '@/lib/types';
import { section22aSourceFor } from '@/lib/section22a/source';
import type { Section22AFC } from '@/lib/section22a/types';

/**
 * The cadastre endpoints, written once.
 *
 * Each exists at two URLs -- `/api/p/<slug>/x`, and the unscoped `/api/x`,
 * which is a thin alias resolving to the demo project -- and the two must be
 * byte-identical, because the acceptance scripts drive the unscoped form while
 * the application drives the scoped one. Sharing the body is the only way to
 * make that true by construction rather than by review.
 *
 * THE ERROR CONTRACT lives here too, in gateProject(), ahead of every load, so
 * that no handler can forget it and no unknown slug reaches a data function:
 *
 *   404  nothing knows this slug -- not the registry, not PostGIS, and there
 *        is no data/api/<slug>/ directory
 *   503  the project is real, but it has no exported snapshot and the database
 *        is not answering. Distinct from 404 deliberately: telling a user
 *        their project does not exist when their docker is merely stopped is
 *        the wrong answer, and the gallery renders the two as different
 *        states rather than as one dead card.
 *
 * Neither path throws. A load that fails after the gate is a 500 carrying the
 * underlying error, which is the pre-existing behaviour of all seven routes.
 */

/** Headers every cadastre response carries. */
async function baseHeaders(slug: string): Promise<Record<string, string>> {
  return {
    'x-ulpin-backend': await backend(slug),
    'x-ulpin-project': slug,
  };
}

/**
 * 500-error body builder.
 *
 * The bare `String(err)` was the previous shape and it leaks DB host/port,
 * the file path that failed to read, and the SQL query that errored. The
 * detail is logged server-side and the body the caller sees carries no
 * information that would help an attacker. The 200 path is byte-identical
 * to before -- this only touches catch blocks, and the response code on
 * the 500 path is the only thing a passing acceptance script ever
 * matched against.
 */
function errorResponse(label: string, err: unknown): NextResponse {
  console.error(`[ulpin-api] ${label}:`, err);
  return NextResponse.json({ error: label }, { status: 500 });
}

/**
 * Add the `x-ulpin-cache: hit|miss|bypass` header to a header bag.
 *
 * The brief is explicit: "Add one additive header, leaving x-ulpin-backend
 * and x-ulpin-roads untouched in name, value and conditions." So this is
 * the ONLY place the new header is composed, and the existing two are
 * never re-stamped by it -- they are owned by baseHeaders() and the
 * roads handler, respectively.
 */
function withCacheHeader(
  headers: Record<string, string>,
  status: CacheStatus,
): Record<string, string> {
  return { ...headers, 'x-ulpin-cache': status };
}

/** The 404/503 gate. Returns null when the project may be served. */
async function gateProject(slug: string): Promise<NextResponse | null> {
  const resolution = await resolveProject(slug);
  if (resolution.kind === 'not-found') {
    return NextResponse.json(
      {
        error: 'project not found',
        slug,
        detail:
          `No project is registered under the slug "${slug}", there is no `
          + `data/api/${slug}/ snapshot directory, and PostGIS has no rows for `
          + 'it. GET /api/projects lists the projects that do exist.',
      },
      { status: 404 },
    );
  }
  if (resolution.kind === 'unavailable') {
    return NextResponse.json(
      {
        error: 'project unavailable',
        slug,
        status: resolution.project.status,
        detail: unavailableMessage(resolution.project),
      },
      { status: 503 },
    );
  }
  return null;
}

/**
 * Load a collection and return it compressed, cacheable and revalidatable.
 *
 * WHY THE REQUEST IS THREADED THROUGH. `NextResponse.json()` streams the body
 * chunked with no `Content-Encoding`, so these five endpoints were shipping raw
 * GeoJSON -- measured at 4.4 MB across one cold boot, and 2.9 s of it (see
 * docs/perf/findings.md). Choosing an encoding needs the client's
 * `Accept-Encoding`, so `serve` needs the Request; every route wrapper now
 * passes the one it already receives.
 *
 * The cache key carries the SLUG. Two projects answer the same handler with
 * different bytes, so a key of "buildings" alone would let one project's
 * cadastre be served under another's URL -- the single most damaging bug this
 * layer could have. It carries the project's edit revision for the same
 * reason lib/http/payload.ts documents: a save must be visible immediately,
 * and `editsRev` is already per-slug on this branch.
 *
 * ROLE FILTER. For a citizen, the collection is replaced with a one-feature
 * FeatureCollection (or empty array) containing only their own building /
 * parcel / utility / conflict. The full FeatureCollection shape is preserved
 * so the rendering layer does not need a "if citizen" branch -- it just gets
 * a small collection and behaves normally.
 */
async function serve<T extends GeoFC>(
  slug: string,
  what: string,
  load: (slug: string) => Promise<T>,
  req: Request,
  extra: Record<string, string> = {},
  filter?: (value: T, ctx: { kind: 'citizen'; buildingId: number; slug: string }) => T | Promise<T>,
): Promise<NextResponse> {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const raw: T = await load(slug);
    const body: T = ctx.kind === 'citizen' && filter
      ? await filter(raw, { kind: 'citizen', buildingId: ctx.buildingId, slug: ctx.slug })
      : raw;
    return await jsonPayload(req, body, {
      resource: `${slug}:${what}`,
      rev: String(editsRev(slug)),
      headers: { ...(await baseHeaders(slug)), ...extra },
      // VERIFIED caller tag, not the raw cookie. See lib/http/caller-tag.ts
      // for the cache-poisoning shape the unverified version allows.
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse(`failed to load ${what}`, err);
  }
}

/** GET .../buildings -> GeoJSON FeatureCollection of every footprint. */
export function buildingsRoute(slug: string, req: Request) {
  return serve(slug, 'buildings', getBuildings, req, {}, filterBuildingsForCitizen);
}

/**
 * The identifying fields a citizen's collection features lose.
 *
 * The building document already withholds the tower's ULPIN and the plot's
 * owner (filterDetailForCaller); the FeatureCollections carry the same two
 * facts in their properties, and the status bar and the parcel inset print
 * from those. One list, applied to both, so the two routes cannot disagree.
 */
const CITIZEN_FEATURE_STRIP = ['ulpin', 'owner', 'ulpin_14', 'owner_name'] as const;

function stripFeatureIdentity<F extends { properties: unknown }>(f: F): F {
  const props = { ...(f.properties as Record<string, unknown>) };
  for (const k of CITIZEN_FEATURE_STRIP) delete props[k];
  return { ...f, properties: props };
}

/** Citizen view: only the one building they own, and not its identifier. */
function filterBuildingsForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  const features = Array.isArray(value.features) ? value.features : [];
  return {
    ...value,
    features: features
      .filter((f) => (f.properties as { id?: number } | null)?.id === ctx.buildingId)
      .map(stripFeatureIdentity),
  };
}

/** GET .../parcels -> GeoJSON of surface parcel polygons. */
export function parcelsRoute(slug: string, req: Request) {
  return serve(slug, 'parcels', getParcels, req, {}, filterParcelsForCitizen);
}

/**
 * Citizen view: the plot boundaries around them, and not a name on any of them.
 *
 * WIDER THAN THE BUILDING FILTER ABOVE, deliberately. A parcel boundary is
 * ground-draped cadastral geometry, not a home: it is what the "Parcel
 * context" inset is a map OF, and cutting the collection to the single plot
 * under the citizen's own tower left that inset drawing one square in an
 * empty frame -- a context map with no context. Buildings stay restricted to
 * their own, so the neighbourhood reads as plots, not as other people's
 * homes, and the inset's dark footprint is still theirs alone.
 *
 * Every parcel loses its identifier and its owner, including the one their
 * own building stands on: that plot belongs to the developer. What is left
 * is a boundary and an id, and `Picker` has no `case 'parcel'` at all, so
 * none of them opens a card.
 */
function filterParcelsForCitizen(
  value: GeoFC,
  _ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  void _ctx;
  const features = Array.isArray(value.features) ? value.features : [];
  return { ...value, features: features.map(stripFeatureIdentity) };
}

/** GET .../survey-parcels -> the 2D cadastral layer, as GeoJSON. */
export function surveyParcelsRoute(slug: string, req: Request) {
  return serve(slug, 'survey-parcels', getSurveyParcels, req, {},
    filterSurveyParcelsForCitizen);
}

/**
 * Citizen view: only the survey parcel their building stands on.
 *
 * Matched through `building_ids`, which the parcel carries, rather than
 * through a column on the building -- see SurveyParcelProps in lib/types.ts
 * for why the relation lives on this side. That makes this filter a scan of
 * the collection already in hand, with no second read; `filterParcelsForCitizen`
 * has to fetch the buildings to learn the citizen's `parcel_id`.
 */
function filterSurveyParcelsForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  const features = Array.isArray(value.features) ? value.features : [];
  return {
    ...value,
    features: features.filter((f) => {
      const ids = (f.properties as { building_ids?: number[] } | null)?.building_ids;
      return Array.isArray(ids) && ids.includes(ctx.buildingId);
    }),
  };
}

/**
 * GET .../section-22a -> the Section 22A restricted-land register, as GeoJSON.
 *
 * `x-ulpin-22a-source` names the register that answered -- the same integrity
 * signal `x-ulpin-roads: derived` carries for the streets. A caller can tell a
 * demonstration register from a government one from the response headers alone,
 * without reading the body and without trusting the interface to have said so.
 */
export function section22aRoute(slug: string, req: Request) {
  return serve(
    slug, 'section-22a', getSection22A, req,
    { 'x-ulpin-22a-source': section22aSourceFor(slug).id },
    filterSection22AForCitizen,
  );
}

/**
 * Citizen view: the listing on their own plot, and no one else's.
 *
 * Matched through the parcel's `building_ids` exactly as
 * `filterSurveyParcelsForCitizen` does -- the resolved feature carries
 * `parcel_id`, so the parcel it names is looked up once and its buildings
 * checked. Narrow rather than empty on purpose: "is my own land listed as
 * prohibited" is a question a citizen is entitled to ask about their own
 * property, and it is the whole value of the feature to them. Whether the
 * neighbour's land is listed is not theirs to know.
 *
 * The register META is left intact, including `record_count`. A citizen sees
 * "1 of 9 records" rather than a register that appears to hold one entry --
 * withholding the shape of the list is the point, misrepresenting its size is
 * not.
 */
async function filterSection22AForCitizen(
  value: Section22AFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): Promise<Section22AFC> {
  const parcels = await getSurveyParcels(ctx.slug);
  const mine = new Set<number>();
  for (const f of parcels.features) {
    const props = f.properties as { id?: number; building_ids?: number[] } | null;
    if (Array.isArray(props?.building_ids)
      && props.building_ids.includes(ctx.buildingId)
      && typeof props.id === 'number') {
      mine.add(props.id);
    }
  }
  return {
    ...value,
    features: value.features.filter(
      (f) => f.properties.parcel_id !== null && mine.has(f.properties.parcel_id),
    ),
  };
}

/**
 * GET .../survey-parcel/:id -> one parcel and the ULPIN tree beneath it.
 *
 * `enforceBuildingAccess` is not the right gate here -- the resource is a
 * parcel, not a building -- so the citizen case is handled by
 * `filterDetailForCaller` running over each building the document carries,
 * which is the same function `/building/:id` uses. A citizen asking for a
 * parcel that is not theirs gets the parcel and an EMPTY building list: the
 * plot boundary is public cadastral geometry, the register beneath it is not.
 */
export async function surveyParcelDetailRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const doc = await getSurveyParcelDetail(slug, id);
    if (!doc) {
      return NextResponse.json(
        { error: 'survey parcel not found' },
        { status: 404, headers: await baseHeaders(slug) },
      );
    }
    const body = ctx.kind === 'citizen'
      ? { ...doc, buildings: doc.buildings.filter(
        (b) => b.building.id === ctx.buildingId) }
      : doc;
    return await jsonPayload(req, body, {
      resource: `${slug}:survey-parcel:${id}`,
      rev: String(editsRev(slug)),
      headers: await baseHeaders(slug),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load survey parcel', err);
  }
}

/** GET .../utilities -> utility centrelines with depth/radius/authority. */
export function utilitiesRoute(slug: string, req: Request) {
  return serve(slug, 'utilities', getUtilities, req, {}, filterUtilitiesForCitizen);
}

/** Citizen view: only utilities tagged with the citizen's building.
 *  City-wide mains (metro, power trunks) are suppressed -- they cross
 *  the AOI but are not what a citizen's screen is for. The demo
 *  building's own risers and laterals come from the building detail
 *  document, not from this endpoint, so a citizen does not lose
 *  anything they should see. */
function filterUtilitiesForCitizen(
  value: GeoFC,
  ctx: { kind: 'citizen'; buildingId: number; slug: string },
): GeoFC {
  const features = Array.isArray(value.features) ? value.features : [];
  return {
    ...value,
    features: features.filter((f) => {
      const pid = (f.properties as { building_id?: number } | null)?.building_id;
      return typeof pid === 'number' && pid === ctx.buildingId;
    }),
  };
}

/**
 * GET .../sites -> the project's named infrastructure sites, as an index.
 *
 * Deliberately not routed through `serve`, which is typed to a GeoJSON
 * FeatureCollection: a site is a structure, not a feature collection, and
 * widening that helper to "anything" would lose the type that keeps the five
 * cadastre endpoints honest.
 *
 * No citizen filter. A citizen's responses are narrowed to their own building,
 * and a railway station is not somebody's building -- it is public
 * infrastructure, and there is nothing in the index that is theirs to be
 * excluded from.
 */
export async function sitesRoute(slug: string, req: Request) {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { getSites } = await import('@/lib/db');
    return await jsonPayload(req, await getSites(slug), {
      resource: `${slug}:sites`,
      rev: String(editsRev(slug)),
      headers: await baseHeaders(slug),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load sites', err);
  }
}

/**
 * GET .../infra/:site -> one site's full specification.
 *
 * Its own endpoint rather than a field on the index, because this is the
 * lazy-loading boundary: the index is what the navigator lists, and a whole
 * station only crosses the wire when somebody opens it.
 */
export async function siteSpecRoute(slug: string, siteId: string, req: Request) {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { getSiteSpec } = await import('@/lib/db');
    const spec = await getSiteSpec(slug, siteId);
    if (!spec) {
      return NextResponse.json(
        { error: 'site not found', slug, site: siteId },
        { status: 404 },
      );
    }
    return await jsonPayload(req, spec, {
      resource: `${slug}:site:${siteId}`,
      rev: String(editsRev(slug)),
      headers: await baseHeaders(slug),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load site', err);
  }
}

/** GET .../conflicts -> utility/basement intersections found by ST_3DIntersects. */
export async function conflictsRoute(slug: string, req: Request) {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { value, cache } = await cachedConflicts(slug);
    const filtered = ctx.kind === 'citizen'
      ? (Array.isArray(value) ? value.filter((c) => c?.building_id === ctx.buildingId) : [])
      : value;
    return await jsonPayload(req, filtered, {
      resource: `${slug}:conflicts`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load conflicts', err);
  }
}

/**
 * GET .../roads -> merged street centrelines.
 *
 * `x-ulpin-roads: derived` is sent alongside the usual backend header because
 * this resource is unlike the others: there is no road table in PostGIS, so it
 * is served from the committed artefact whatever the database is doing. The
 * header says so on the wire rather than only in a comment.
 */
export function roadsRoute(slug: string, req: Request) {
  return serve(slug, 'roads', getRoads, req, { 'x-ulpin-roads': 'derived' });
}

/** Shared id parsing, so GET and PATCH cannot disagree about what is valid. */
function parseEntityId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) ? n : null;
}

/** GET .../building/:id -> building with its floors and units nested. */
export async function buildingDetailRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      // A null result here is either "not found" (genuine 404) or "the
      // project was unknown" (handled by the gate above). A genuine 404
      // is NOT cached -- the pristine store skips the write when the
      // underlying getter returns null, and the route does not serve
      // a header that would tell an operator a building exists when it
      // does not. bypass is the honest label: the value is correct, it
      // just never went near Redis.
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    // A citizen owns one flat, not the tower. The neighbours' units are
    // dropped here, on the server, before the document is serialised --
    // filtering them in the viewer would leave every ULPIN, area and
    // encumbrance in the response body for anyone with devtools open.
    return await jsonPayload(req, narrowDetailForCaller(ctx, detail), {
      resource: `${slug}:building:${id}`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load building', err);
  }
}

/**
 * The progressive half of the detail API.
 *
 * `/building/:id` returns the whole document -- attributes, parcel, every
 * storey and every flat. That is the right answer for a caller that wants one
 * round trip, and the wrong one for a panel that opens on a header: for a tower
 * the floors and units are the overwhelming majority of the bytes and none of
 * them are on screen until the user opens the ladder or the unit grid.
 *
 * All three read through the SAME cache entry as the full document rather than
 * keeping their own. Two caches over one source are two ways to be stale, and
 * the memory they would save is memory lib/server-cache.ts already bounds.
 */
export async function buildingSummaryRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  // The first building-scoped call a session makes, and it does not await the
  // warm-up: the landmarks are pulled in while this response is written.
  // NOTE: warmProject is the in-process LRU warm-up; the Redis cache has
  // its own first-request behaviour. The two coexist for now; the in-process
  // warm path is documented as redundant in the decisions log.
  //
  // The call is attached to a `.catch` so a warm-up failure becomes a
  // single logged warning rather than an unhandled rejection. Without
  // this, a rejected promise from a corrupt snapshot or a transient
  // I/O error would surface as `UnhandledPromiseRejection` and could
  // be flagged by the Next.js dev server as a worker crash.
  warmProject(slug).catch((err: unknown) => {
    console.warn(
      `[ulpin-api] warmProject(${slug}) failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    // Narrowed like the full document: a citizen's summary names their
    // building and counts their own floor and flat, not the tower's.
    const visible = narrowDetailForCaller(ctx, detail);
    return await jsonPayload(
      req,
      {
        building: visible.building,
        parcel: visible.parcel,
        floor_count: visible.floors.length,
        unit_count: visible.units.length,
      },
      {
        resource: `${slug}:building-summary:${id}`,
        rev: String(editsRev(slug)),
        headers: withCacheHeader(await baseHeaders(slug), cache),
        callerTag: callerTagFromCtx(ctx),
      },
    );
  } catch (err) {
    return errorResponse('failed to load building', err);
  }
}

export async function buildingFloorsRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    // Through the same narrowing as the full document, or a citizen could
    // read every floor's ULPIN here that /building/:id refuses them.
    const floors = narrowDetailForCaller(ctx, detail).floors;
    return await jsonPayload(req, { building_id: id, floors }, {
      resource: `${slug}:building-floors:${id}`,
      rev: String(editsRev(slug)),
      headers: withCacheHeader(await baseHeaders(slug), cache),
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load floors', err);
  }
}

/** Page size when the caller does not ask, and the ceiling when it does. */
const UNITS_DEFAULT_LIMIT = 200;
const UNITS_MAX_LIMIT = 1000;

/**
 * GET .../building/:id/units?level=&limit=&offset=
 *
 * The isolated-floor view wants one storey; an export wants pages. The cap is
 * on the SERVER: an endpoint whose page size is whatever the client asked for
 * is not paginated, it is merely inconvenient.
 */
export async function buildingUnitsRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }
  const url = new URL(req.url);
  const rawLevel = url.searchParams.get('level');
  const level = rawLevel === null ? null : Number(rawLevel);
  if (rawLevel !== null && !Number.isInteger(level)) {
    return NextResponse.json({ error: 'level must be an integer' }, { status: 400 });
  }
  const rawLimit = Number(url.searchParams.get('limit'));
  const rawOffset = Number(url.searchParams.get('offset'));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), UNITS_MAX_LIMIT)
    : UNITS_DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const ctx = await callerContext(req);
  const denied = enforceBuildingAccess(ctx, slug, id);
  if (denied) return denied;
  const gate = await gateProject(slug);
  if (gate) return gate;
  try {
    const { value: detail, cache } = await cachedDetail(slug, id);
    if (!detail) {
      return NextResponse.json(
        { error: 'building not found' },
        { status: 404, headers: withCacheHeader(await baseHeaders(slug), cache) },
      );
    }
    // Role first, then the level filter: a citizen paging this endpoint must
    // not be able to walk their neighbours' flats one page at a time.
    const visible = narrowDetailForCaller(ctx, detail).units;
    const matching = level === null
      ? visible
      : visible.filter((u) => u.level_no === level);
    return await jsonPayload(
      req,
      {
        building_id: id,
        level,
        total: matching.length,
        offset,
        limit,
        units: matching.slice(offset, offset + limit),
      },
      {
        // The page is part of the identity of the response: two pages of the
        // same building are different resources and must not share an ETag.
        resource: `${slug}:building-units:${id}:${level ?? 'all'}:${offset}:${limit}`,
        rev: String(editsRev(slug)),
        headers: withCacheHeader(await baseHeaders(slug), cache),
        callerTag: callerTagFromCtx(ctx),
      },
    );
  } catch (err) {
    return errorResponse('failed to load units', err);
  }
}

/**
 * PATCH .../building/:id -> record a manual edit and return the new document.
 *
 * The response body is the FULL re-read BuildingDetail rather than an
 * acknowledgement, so the client replaces its cached document with a
 * server-authoritative one in a single write and can never drift from what
 * the next reader would see.
 *
 * Status codes carry meaning the form relies on:
 *   400  the body was malformed, or named a field that is not editable
 *        (coordinates and ULPIN land here)
 *   404  no such building
 *   422  well-formed but invalid -- the per-field errors render in the form
 *
 * Edits are stored per project (data/projects/<slug>/edits.json), because the
 * store is keyed by building id and building ids are only unique within a
 * project. One global file would have let a save against one AOI silently
 * rewrite a building in another.
 */
export async function buildingPatchRoute(
  slug: string,
  rawId: string,
  req: Request,
): Promise<NextResponse> {
  const id = parseEntityId(rawId);
  if (id === null) {
    return NextResponse.json({ error: 'id must be an integer' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be valid JSON' }, { status: 400 });
  }

  const ctx = await callerContext(req);
  const mutationRefused = refuseMutation(ctx);
  if (mutationRefused) return mutationRefused;
  const buildingRefused = enforceBuildingAccess(ctx, slug, id);
  if (buildingRefused) return buildingRefused;

  const coerced = coerceEdit(body);
  if (!coerced.ok) {
    return NextResponse.json(
      { error: 'unrecognised or mistyped fields', errors: coerced.errors },
      { status: 400 },
    );
  }

  const gate = await gateProject(slug);
  if (gate) return gate;

  try {
    const current = await getBuildingDetail(slug, id);
    if (!current) {
      return NextResponse.json({ error: 'building not found' }, { status: 404 });
    }

    // Validated against the CURRENT values, so a rule spanning two fields
    // still holds when only one of them is in the patch.
    const ctxValues = {
      floors: current.building.floors,
      height_m: current.building.height_m,
    };
    const errors = validateEdit(coerced.value, ctxValues);
    if (errors.length) {
      return NextResponse.json({ error: 'validation failed', errors }, { status: 422 });
    }

    const record = await applyEdit(slug, id, coerced.value);
    // The read-back goes through the same cache as a GET would, with the
    // new edit visible on the very next request. The cache key is the
    // PRISTINE document, not the edited one; the overlay applies the
    // edit on top. This is the "no invalidation to get wrong" property:
    // a PATCH never touches Redis, and the response body is exactly
    // what the next GET would have returned.
    const { value: updated, cache } = await cachedDetail(slug, id);
    if (!updated) {
      return NextResponse.json({ error: 'building vanished' }, { status: 500 });
    }

    return NextResponse.json(
      {
        detail: updated,
        rev: record.rev,
        updated_at: record.updated_at,
        warnings: warningsFor(coerced.value, ctxValues),
      },
      {
        headers: withCacheHeader(
          { ...(await baseHeaders(slug)), 'x-ulpin-edit-rev': String(record.rev) },
          cache,
        ),
      },
    );
  } catch (err) {
    return errorResponse('failed to save building', err);
  }
}

/**
 * POST .../query {lon, lat, z}
 * Every entity whose 3D volume contains the point, ordered
 * parcel < building < floor < unit.
 */
export async function queryRoute(slug: string, req: Request): Promise<NextResponse> {
  let body: { lon?: unknown; lat?: unknown; z?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const lon = Number(body.lon);
  const lat = Number(body.lat);
  const z = Number(body.z);
  if (![lon, lat, z].every(Number.isFinite)) {
    return NextResponse.json(
      { error: 'lon, lat and z are required numbers' },
      { status: 400 },
    );
  }
  if (lat < -90 || lat > 90) {
    return NextResponse.json({ error: 'lat out of range' }, { status: 400 });
  }
  if (lon < -180 || lon > 180) {
    return NextResponse.json({ error: 'lon out of range' }, { status: 400 });
  }

  // NOT through serve(). serve() memoises the compressed body under a
  // per-resource key, and every point query would share the key `slug:query`
  // while answering about a different point -- the cache would hand one user
  // the stack under somebody else's cursor. A point query is also a few
  // hundred bytes about one click: there is nothing here worth compressing or
  // revalidating, so it answers directly.
  //
  // The Redis cache, by contrast, keys each point query by (slug, lon, lat, z)
  // at 7-decimal precision, so distinct clicks land on distinct keys. The
  // CACHE_HIT cost is one map lookup; the CACHE_MISS cost is one ST_3DIntersects
  // run. The TTL is short (60 s) because queries are session-local: a user
  // clicking the same point twice in 60 s gets the same response in 1 ms
  // instead of 30 ms.
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const { value: stack, cache } = await cachedQueryPoint(slug, lon, lat, z);
    // A citizen's clicks should only ever land on their own building; the
    // server still filters the stack so a misclick does not leak neighbours
    // (e.g. a stack entry whose top-level entity is a different building).
    const filtered = ctx.kind === 'citizen'
      ? stack.filter((entry) => {
        const id = (entry as { building_id?: number } | null)?.building_id;
        // Building level entries drop out unless they are the citizen's
        // own building. Parcel / floor / unit entries always belong to
        // a building, and the building is checked above; the absence
        // of building_id on a sub-building entry is therefore a leak
        // (the entry is about some other building) and is dropped.
        return id === ctx.buildingId;
      })
      : stack;
    return NextResponse.json(
      { point: { lon, lat, z }, count: filtered.length, stack: filtered },
      {
        headers: withCacheHeader(
          { ...(await baseHeaders(slug)),
            // A click is not an HTTP-cacheable resource.
            'cache-control': 'no-store',
          },
          cache,
        ),
      },
    );
  } catch (err) {
    return errorResponse('query failed', err);
  }
}

/**
 * GET .../topology -> a live 3D clash and easement-clearance run.
 *
 * DELIBERATELY NOT CACHED, and deliberately not the same resource as
 * `/conflicts`. The conflicts endpoint serves the `conflict` table: a fixed
 * question asked once at seed time and recorded. This one asks the question
 * again, now, against whatever the project currently holds -- which is the
 * point of a button labelled "Run Topology Validation". Caching it would mean
 * the answer stopped changing after an edit, which is exactly when a user
 * presses it.
 *
 * A citizen sees only findings that touch their own building, on the same
 * reasoning as conflictsRoute: the topology of a neighbour's basement is not
 * theirs to read.
 */
export async function topologyRoute(slug: string, req: Request) {
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;
  try {
    const findings = await getTopology(slug);
    // Matched on BOTH sides: the utility side never carries a building (a run
    // that does is its own building's plumbing, and those pairs are excluded
    // before they become findings), so filtering on `a` alone would hide every
    // finding from every citizen.
    const visible = ctx.kind === 'citizen'
      ? findings.filter((f) => f.a.building_id === ctx.buildingId
          || f.b.building_id === ctx.buildingId)
      : findings;
    const headers = await baseHeaders(slug);
    // The current state, every time. See the comment above.
    headers['cache-control'] = 'no-store';
    return await jsonPayload(req, {
      project: slug,
      ran_at: new Date().toISOString(),
      count: visible.length,
      findings: visible,
    }, {
      resource: `${slug}:topology`,
      rev: String(editsRev(slug)),
      headers,
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to run topology validation', err);
  }
}

/**
 * GET /api/p/<slug>/ladm/spatial-unit/<suId>
 * GET /api/v1/ladm/parcel/<ulpin3d>       (same body, project resolved from the id)
 *
 * The ISO 19152 document for one spatial unit: LA_SpatialUnit, the LA_BAUnit
 * it belongs to with every member and its share, the LA_RRRs against that
 * bundle, the LA_Parties who hold them, and the subterranean easements that
 * cross it.
 *
 * TWO REPRESENTATIONS, one document. GeoJSON-3D by default -- a Feature whose
 * geometry is the plan ring and whose properties carry the LADM classes --
 * and JSON-LD on `?format=jsonld` or an `Accept: application/ld+json`. The
 * framing lives in lib/ladm.ts rather than here so it is testable without a
 * server and so the ISO class names appear exactly once.
 *
 * NO ZOD. The identifier IS the input, and lib/ulpin.ts's grammar is already
 * its validator -- codesOfSuId() rejects anything that is not shaped like one
 * of ours before a query is built.
 */
export async function ladmSpatialUnitRoute(
  slug: string, rawSuId: string, req: Request,
): Promise<NextResponse> {
  const suId = decodeURIComponent(rawSuId).trim().toUpperCase();
  if (!codesOfSuId(suId)) {
    return NextResponse.json(
      {
        error: 'not a spatial unit identifier',
        detail: 'Expected <state>-<district>-<scheme>-... , e.g. '
          + 'AP-VSP-3D26-9999-001-09-901 or AP-VSP-3D26-UTL-00042.',
      },
      { status: 400 },
    );
  }
  const gate = await gateProject(slug);
  if (gate) return gate;
  const ctx = await callerContext(req);
  const projectGuard = enforceProjectAccess(ctx, slug);
  if (projectGuard) return projectGuard;

  try {
    const doc = await getLadmDoc(slug, suId);
    if (!doc) {
      return NextResponse.json(
        { error: 'spatial unit not registered', su_id: suId },
        { status: 404, headers: await baseHeaders(slug) },
      );
    }

    /*
     * THE REDACTION HAPPENS HERE, ON THE SERVER, before the body is built --
     * not in the viewer, where anyone can read the response in devtools. This
     * is the payload that carries holder names, charges and tenure, which is
     * exactly what filterDetailForCaller strips from the building document;
     * serving it unfiltered would hand back through a second door what the
     * first one refuses.
     */
    const body = filterLadmForCaller(ctx, doc, ownsSpatialUnit(ctx, suId));

    const url = new URL(req.url);
    const wantsLd = url.searchParams.get('format') === 'jsonld'
      || (req.headers.get('accept') ?? '').includes('application/ld+json');

    const headers = await baseHeaders(slug);
    headers['content-type'] = wantsLd
      ? 'application/ld+json; charset=utf-8'
      : 'application/geo+json; charset=utf-8';

    const payload: unknown = wantsLd ? jsonLd(body) : geoJsonOf(body);

    return await jsonPayload(req, payload, {
      resource: `${slug}:ladm:${suId}:${wantsLd ? 'ld' : 'geo'}`,
      rev: String(editsRev(slug)),
      headers,
      // NOT OPTIONAL. lib/http/caller-tag.ts documents the cross-citizen
      // cache-poisoning leak that follows from omitting it, and this response
      // differs by role in exactly the way that bug exploits.
      callerTag: callerTagFromCtx(ctx),
    });
  } catch (err) {
    return errorResponse('failed to load the LADM document', err);
  }
}

/**
 * The document as a GeoJSON-3D Feature.
 *
 * `geometry` is the PLAN ring, and the vertical extent rides in the
 * properties rather than in the coordinates. That is deliberate: a GeoJSON
 * consumer that reads a position's third element treats it as an ELLIPSOIDAL
 * height, and every z stored here is orthometric. Publishing z inside the
 * coordinates would silently mislabel it by the geoid separation -- 72 m at
 * Visakhapatnam -- with nothing downstream able to detect the error. The
 * `height` block states both datums and names each one's CRS.
 */
function geoJsonOf(doc: LADMParcelDoc): Record<string, unknown> {
  const { su, ...rest } = doc;
  const { ring, ...suProps } = su;
  return {
    type: 'Feature',
    id: su.su_id,
    // The 2D CRS of the ring below. GeoJSON is CRS84 by definition; naming it
    // costs nothing and stops a reader guessing which of the three CRS on
    // this document the coordinates are in.
    crs: CRS_2D,
    geometry: ring ?? null,
    properties: {
      '@class': 'LA_SpatialUnit',
      spatial_unit: suProps,
      ...rest,
    },
  };
}

/**
 * GET /api/v1/ladm/parcel/<ulpin3d> -- the slug-free public form.
 *
 * The project is resolved FROM THE IDENTIFIER: an su_id carries the revenue
 * codes (state, district, scheme) that projects.state_code / district_code /
 * scheme_code hold, so the AOI is derivable rather than something the caller
 * has to know. That is what makes a versioned, slug-free namespace coherent
 * here, and it is the URL the exported certificate's QR code resolves to --
 * a deed that outlives the session that produced it must not carry a slug
 * that could be renamed.
 *
 * listProjects() reads the committed registry on the snapshot path and
 * PostGIS on the other, so this resolves with the database down.
 */
export async function ladmByIdentifierRoute(
  rawSuId: string, req: Request,
): Promise<NextResponse> {
  const suId = decodeURIComponent(rawSuId).trim().toUpperCase();
  const codes = codesOfSuId(suId);
  if (!codes) {
    return NextResponse.json(
      {
        error: 'not a spatial unit identifier',
        detail: 'Expected <state>-<district>-<scheme>-... , e.g. '
          + 'AP-VSP-3D26-9999-001-09-901.',
      },
      { status: 400 },
    );
  }
  const projects = await listProjects();
  const match = projects.find((p) => p.state_code === codes.state
    && p.district_code === codes.district
    && p.scheme_code === codes.scheme);
  if (!match) {
    return NextResponse.json(
      {
        error: 'no project issues this identifier',
        codes,
        detail: `No registered project has state_code "${codes.state}", `
          + `district_code "${codes.district}" and scheme_code "${codes.scheme}". `
          + 'GET /api/projects lists the projects that do exist.',
      },
      { status: 404 },
    );
  }
  return ladmSpatialUnitRoute(match.slug, suId, req);
}
