import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type { SiteIndex, SiteSpec } from './infra/types';
import type {
  BuildingDetail, BuildingProps, ConflictRow, EnrichedBuilding, FlatRegisterEntry,
  GeoFC, ParcelInfo, Project, ProjectStats, Ring, RoadProps, StackHit,
  SurveyParcelDetail, SurveyParcelProps, UnitInfo, UtilityProps,
} from './types';
import { enrichBuilding, enrichCollection, type UnitFacts } from './mock/building';
import { allEdits, editsFor, editsRev } from './data/edits';
import type { BuildingEdit } from './data/building-schema';
import { API_DIR, DEFAULT_SLUG, PROJECTS_DIR, findProject, isValidSlug } from './projects';
import { DISCLAIMER } from './ulpin';
import { heightRange, rrrFromRegister } from './ladm';
import type {
  LADMBAUnit, LADMDimension, LADMMemberRole, LADMParcelDoc, LADMParty,
  LADMProvenance, LADMRRR, LADMRRRClass, LADMRRRType, LADMSpatialUnit,
  LADMSpatialUnitType,
} from './ladm';
import { detectClashes } from './topology';
import type {
  ClashFinding, ClashParty, ClashPartyType, RunInput, VolumeInput,
} from './topology';
import { categoryOfAssetType, UNDERGROUND_BY_KEY } from './underground/categories';
import { placeSite } from './infra/build';
import { resolveSection22A } from './section22a/resolve';
import { section22aSourceFor, type Section22AListing } from './section22a/source';
import {
  SECTION_22A_DISCLAIMER, SECTION_22A_MOCK_NOTE, type Section22AFC,
} from './section22a/types';

/**
 * Data access with two backends, scoped by project.
 *
 * PostGIS is the source of truth and does the real spatial work (ST_3DIntersects
 * over PolyhedralSurface solids). When it is unreachable -- typically because
 * docker-compose is not running -- we serve the committed snapshots in
 * data/api/<slug>/, which scripts/05_export_static.py generated FROM that same
 * database. The snapshot is never an alternative implementation of the spatial
 * logic; it is a cache of its output, so the two cannot drift in behaviour.
 *
 * The one genuine difference is /api/query: the point-in-volume test runs in
 * SQL when the DB is up, and as an equivalent prism test in JS when it is not.
 * Both are exact for vertical prisms, which is all this schema stores.
 *
 * SCOPING. Every exported reader takes a slug first. On the snapshot path that
 * selects a directory; on the PostGIS path it selects a `projects.id` that is
 * pushed into the WHERE clause. Three cases, resolved once per slug by
 * scopeFor():
 *
 *   scoped   the projects table exists and knows this slug -> filter on
 *            project_id, which is the normal multi-project case
 *   legacy   the projects table does NOT exist (a pre-migration volume) and
 *            the slug is the demo project -- every row in such a database is
 *            siripuram, so the unfiltered query is the correct one
 *   none     neither -- there is no PostGIS answer for this project, and the
 *            snapshot serves. This is also what a database that is simply not
 *            running looks like.
 *
 * `legacy` is what lets an existing ulpin_pgdata volume keep working without
 * running db/migrations/001_multi_project.sql first, rather than silently
 * falling back to the snapshot while the header still claimed `postgis`.
 */

const CONNECT_TIMEOUT_MS = 1500;
/**
 * After a failed probe, the next request that needs a DB decision waits
 * this long before re-probing. A short cooldown stops a tight loop of
 * failing SELECTs; a long enough one that a transient blip (TCP reset,
 * idle-client timeout, container restart) clears on its own within
 * seconds rather than minutes. Picked to be longer than the typical
 * docker-compose `up` time and shorter than a deploy cadence.
 */
const DB_REPROBE_COOLDOWN_MS = 5_000;

let pool: Pool | null = null;
/** null = never probed; boolean = last probe result. */
let dbUsable: boolean | null = null;
/** When the last failed probe ran. `usingDb` re-probes if the cooldown has expired. */
let dbProbeFailedAt = 0;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ?? 'postgresql://ulpin:ulpin@localhost:55432/ulpin',
      max: 10,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 10000,
    });
    // A pool-level error (idle-client RST, container restart) does NOT
    // permanently latch `dbUsable` to false. That was the previous
    // behaviour, and a single TCP blip would have demoted every
    // request from PostGIS to the snapshot for the rest of the
    // process's life -- a permanent availability/accuracy regression
    // for what is almost always a transient. Instead, the pool error
    // invalidates the cached probe so the next `usingDb` re-probes
    // after the cooldown elapses.
    pool.on('error', () => {
      dbUsable = null;
      dbProbeFailedAt = Date.now();
    });
  }
  return pool;
}

/**
 * Probe the DB; cache the result until something forces a re-probe.
 *
 * The first call after process start always probes. Subsequent calls
 * reuse the cached result unless:
 *   - a pool-level error invalidated it, or
 *   - the last probe failed AND the cooldown has elapsed.
 *
 * The second rule is the important one. A failed probe sets
 * `dbUsable = false` AND `dbProbeFailedAt = now`, so the next request
 * after the cooldown runs a fresh probe. If the DB is still down the
 * probe fails again and the cycle repeats; if the DB has come back up
 * the probe succeeds and every subsequent request answers from PostGIS
 * again. The pool's `error` event covers the case where the connection
 * dies AFTER a successful probe (idle client reaped, container restart);
 * the cooldown covers the case where the connection is fine but the
 * database itself is rejecting queries.
 */
async function usingDb(): Promise<boolean> {
  if (dbUsable !== null) {
    if (dbUsable) return true;
    if (Date.now() - dbProbeFailedAt < DB_REPROBE_COOLDOWN_MS) return false;
    // Cooldown elapsed; fall through to re-probe.
  }
  try {
    const res = await getPool().query('SELECT count(*)::int AS n FROM building');
    dbUsable = res.rows[0].n > 0;
  } catch {
    dbUsable = false;
    dbProbeFailedAt = Date.now();
  }
  return dbUsable;
}

async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(sql, params as never[]);
  return res.rows as T[];
}

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

interface Scope {
  /** projects.id, or null in `legacy` mode where the column does not exist. */
  id: number | null;
  /** The AOI name that goes in the FeatureCollection's `aoi` field. */
  name: string;
}

/**
 * Memoised per slug for the life of the process.
 *
 * The pipeline runs as a separate process and the dev server reloads its
 * modules when files change, so a stale entry cannot outlive a re-seed in
 * practice. A long-lived production server that gained a project would need a
 * restart, which is the same contract the snapshot file cache below has always
 * had.
 */
const scopeCache = new Map<string, Scope | null>();

async function scopeFor(slug: string): Promise<Scope | null> {
  if (scopeCache.has(slug)) return scopeCache.get(slug)!;
  const resolved = await resolveScope(slug);
  scopeCache.set(slug, resolved);
  return resolved;
}

async function resolveScope(slug: string): Promise<Scope | null> {
  if (!isValidSlug(slug)) return null;
  if (!(await usingDb())) return null;
  try {
    const rows = await q<{ id: number; name: string }>(
      'SELECT id, name FROM projects WHERE slug = $1', [slug]);
    if (!rows.length) return null;
    return { id: rows[0].id, name: rows[0].name };
  } catch {
    // No projects table: a volume seeded before this feature existed. Every
    // row in it is the demo AOI, so the unfiltered queries are correct for
    // that slug and only that slug.
    return slug === DEFAULT_SLUG
      ? { id: null, name: 'Siripuram, Visakhapatnam' }
      : null;
  }
}

/**
 * Run a PostGIS query for a project, or report that the snapshot should serve.
 *
 * A failed QUERY is treated exactly like a failed probe. The pool is small and
 * deliberately short-timeouted so a missing database is detected fast, which
 * also means a burst of concurrent requests can exhaust it and time out while
 * Postgres is perfectly healthy. The documented contract is that the committed
 * snapshot serves whenever PostGIS cannot -- not that the request 500s -- so a
 * starved pool degrades to the snapshot rather than to an error.
 *
 * The result is wrapped rather than returned as `T | null` because
 * getBuildingDetail legitimately resolves to null for an unknown id, and that
 * must not be confused with "the database could not answer".
 */
async function viaDb<T>(
  slug: string,
  run: (scope: Scope) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const scope = await scopeFor(slug);
  if (!scope) return { ok: false };
  try {
    return { ok: true, value: await run(scope) };
  } catch {
    return { ok: false };
  }
}

/**
 * The project filter, as a SQL fragment plus the parameters that precede it.
 *
 * Returned together so a call site cannot get the placeholder number and the
 * parameter array out of step, which is the one way this could go wrong
 * quietly: a mismatched $n does not error, it filters on the wrong value.
 */
function filter(scope: Scope, expr: string, priorParams: unknown[] = []): {
  clause: string;
  params: unknown[];
} {
  if (scope.id === null) return { clause: '', params: priorParams };
  return {
    clause: expr.replace('$P', `$${priorParams.length + 1}`),
    params: [...priorParams, scope.id],
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

const fileCache = new Map<string, unknown>();

/**
 * Read data/api/<slug>/<name>, cached for the life of the process.
 *
 * The slug is validated by isValidSlug() before it is joined onto a directory
 * path, so a crafted slug cannot walk out of data/api/. resolveProject() gates
 * every route ahead of this, but this is the function that actually touches
 * the filesystem and it does not rely on a caller having checked.
 */
async function snapshot<T>(slug: string, name: string): Promise<T> {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const key = `${slug}/${name}`;
  if (fileCache.has(key)) return fileCache.get(key) as T;
  const raw = await fs.readFile(path.join(API_DIR, slug, name), 'utf-8');
  const parsed = JSON.parse(raw);
  fileCache.set(key, parsed);
  return parsed as T;
}

/**
 * The project's flat register: ownership, charge, tax and bills, keyed by the
 * flat's ULPIN.
 *
 * Deliberately NOT a cadastre table. The cadastre stores what the survey
 * knows -- geometry, level, ULPIN, title holder; who a flat is mortgaged to
 * and whether last quarter's water bill is settled are a different record
 * with a different owner and a different update cadence. Keeping them in one
 * committed file per project also means PostGIS and the snapshot cannot
 * disagree about them: the same file is read on both paths, which is exactly
 * the split-brain that lost the demo building and the citizen's utilities.
 *
 * A project with no register file simply has none. Every flat then renders
 * from the cadastre alone, which is the correct answer for the 384 OSM-derived
 * buildings -- inventing a mortgage for them would be presenting a guess as a
 * record.
 */
async function flatRegister(
  slug: string,
): Promise<Record<string, FlatRegisterEntry>> {
  if (!isValidSlug(slug)) throw new Error(`invalid project slug: ${slug}`);
  const key = `projects/${slug}/flat-register.json`;
  if (fileCache.has(key)) return fileCache.get(key) as Record<string, FlatRegisterEntry>;
  let parsed: Record<string, FlatRegisterEntry> = {};
  try {
    const raw = await fs.readFile(
      path.join(PROJECTS_DIR, slug, 'flat-register.json'),
      'utf-8',
    );
    const json: unknown = JSON.parse(raw);
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      parsed = json as Record<string, FlatRegisterEntry>;
    }
  } catch {
    // No register for this project. Not an error: see above.
  }
  fileCache.set(key, parsed);
  return parsed;
}

/**
 * Which backend actually answered for this project.
 *
 * Asking per project rather than globally, because the two can disagree: with
 * PostGIS up and a second project that exists only as a snapshot, a global
 * probe would report `postgis` for a response the snapshot served. For the
 * demo project with the database running this still returns `postgis`, which
 * is what it has always returned and what the acceptance scripts assert.
 */
export async function backend(slug: string): Promise<'postgis' | 'snapshot'> {
  return (await scopeFor(slug)) ? 'postgis' : 'snapshot';
}

// ---------------------------------------------------------------------------
// The registry, read from PostGIS. lib/projects.ts owns the snapshot half.
// ---------------------------------------------------------------------------

const PROJECTS_SQL = `
  SELECT p.slug, p.name, p.state_code, p.district_code, p.scheme_code,
         p.status, p.created_at, p.stats,
         p.elev_source, p.elev_datum, p.geoid_sep_m, p.bhuvan_layers,
         ST_XMin(p.bbox_geom) AS west,  ST_YMin(p.bbox_geom) AS south,
         ST_XMax(p.bbox_geom) AS east,  ST_YMax(p.bbox_geom) AS north
    FROM projects p ORDER BY p.created_at, p.id`;

interface ProjectRow {
  slug: string; name: string; state_code: string; district_code: string;
  scheme_code: string; status: Project['status']; created_at: Date | string;
  stats: ProjectStats | null;
  elev_source: Project['elev_source'] | null;
  elev_datum: string | null;
  geoid_sep_m: number | string | null;
  bhuvan_layers: Project['bhuvan_layers'];
  west: number; south: number; east: number; north: number;
}

/**
 * Registry rows from PostGIS, or null when there is no PostGIS answer.
 *
 * Null and [] are different: null means "ask the snapshot", [] means "the
 * database is up and there genuinely are no projects".
 */
export async function projectsFromDb(): Promise<Project[] | null> {
  if (!(await usingDb())) return null;
  try {
    const rows = await q<ProjectRow>(PROJECTS_SQL);
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      bbox: [r.west, r.south, r.east, r.north] as [number, number, number, number],
      state_code: r.state_code,
      district_code: r.district_code,
      scheme_code: r.scheme_code,
      status: r.status,
      created_at: new Date(r.created_at).toISOString(),
      stats: r.stats && Object.keys(r.stats).length ? r.stats : null,
      elev_source: r.elev_source ?? 'placeholder',
      elev_datum: r.elev_datum ?? null,
      // node-postgres hands back `double precision` as a string on some
      // driver versions; Number(null) is 0, which here would assert that the
      // geoid and the ellipsoid coincide, so the null check comes first.
      geoid_sep_m: r.geoid_sep_m === null || r.geoid_sep_m === undefined
        ? null : Number(r.geoid_sep_m),
      bhuvan_layers: r.bhuvan_layers ?? null,
    }));
  } catch {
    // No projects table -- a pre-migration volume. The snapshot registry is
    // the right answer there, and it names the demo project.
    return null;
  }
}

/** True when PostGIS holds rows for this project. Used by the 404/503 gate. */
export async function projectHasRows(slug: string): Promise<boolean> {
  const scope = await scopeFor(slug);
  if (!scope) return false;
  const r = await viaDb(slug, async (s) => {
    const f = filter(s, 'WHERE b.project_id = $P');
    const rows = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM building b ${f.clause}`, f.params);
    return rows[0].n > 0;
  });
  return r.ok && r.value;
}

// ---------------------------------------------------------------------------
// Cadastre SQL. Each is a function of the scope so the project filter and its
// placeholder number are generated together.
// ---------------------------------------------------------------------------

function buildingsSql(scope: Scope) {
  const f = filter(scope, 'WHERE b.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'aoi',$${f.params.length + 1}::text,
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',b.id,
      'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
      'properties', json_build_object(
        'id',b.id,'ulpin',b.ulpin,'parcel_id',b.parcel_id,
        'height_m',b.height_m,'floors',b.floors,'basements',b.basements,
        'ground_elev',b.ground_elev,'ground_source',b.ground_source,'use_type',b.use_type,
        'flood_risk',b.flood_risk,'cyclone_risk',b.cyclone_risk,
        'flood_score',b.flood_score,'cyclone_score',b.cyclone_score,
        'coast_dist_m',b.coast_dist_m,'local_relief_m',b.local_relief_m,
        'height_source',b.height_source,'survey_synthetic',b.survey_synthetic,'name',b.name,'address',b.address,
        'osm_id',b.osm_id))),'[]'::json)) AS fc
  FROM building b ${f.clause}`,
    params: [...f.params, scope.name],
  };
}

function parcelsSql(scope: Scope) {
  const f = filter(scope, 'WHERE p.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',p.id,
      'geometry', ST_AsGeoJSON(p.geom, 7)::json,
      'properties', json_build_object(
        'id',p.id,'ulpin',p.ulpin,'area_m2',p.area_m2,'owner',p.owner))),'[]'::json)) AS fc
  FROM parcel p ${f.clause}`,
    params: f.params,
  };
}

/**
 * The 2D cadastral layer. Mirrors SURVEY_PARCELS in scripts/05_export_static.py
 * field for field, so the PostGIS response and the committed snapshot are the
 * same document -- which is the property `check:gis2d` runs against both
 * backends to confirm.
 *
 * `building_ids` is here rather than a `survey_parcel_id` on buildings.json:
 * see the comment on SurveyParcelProps in lib/types.ts.
 */
function surveyParcelsSql(scope: Scope) {
  const f = filter(scope, 'WHERE sp.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',sp.id,
      'geometry', ST_AsGeoJSON(sp.geom, 7)::json,
      'properties', json_build_object(
        'id',sp.id,'label',sp.label,
        'ts_no',sp.ts_no,'lpm_no',sp.lpm_no,'ulpin_14',sp.ulpin_14,
        'extent_sqm',sp.extent_sqm,'classification',sp.classification,
        'provenance',sp.provenance,'source',sp.source,
        'source_date', to_char(sp.source_date, 'YYYY-MM-DD'),
        'building_count', (SELECT count(*) FROM building b
                            WHERE b.survey_parcel_id = sp.id),
        'building_ids', COALESCE((SELECT json_agg(b.id ORDER BY b.id)
                                    FROM building b
                                   WHERE b.survey_parcel_id = sp.id), '[]'::json)))
      ORDER BY sp.label),'[]'::json)) AS fc
  FROM survey_parcel sp ${f.clause}`,
    params: f.params,
  };
}

function utilitiesSql(scope: Scope) {
  const f = filter(scope, 'WHERE u.project_id = $P');
  return {
    sql: `
  SELECT json_build_object(
    'type','FeatureCollection',
    'features', COALESCE(json_agg(json_build_object(
      'type','Feature','id',u.id,
      'geometry', ST_AsGeoJSON(u.geom_3d, 7)::json,
      'properties', json_build_object(
        'id',u.id,'asset_type',u.asset_type,'depth_m',u.depth_m,
        'radius_m',u.radius_m,'authority',u.authority,'status',u.status,
        -- Emitted so the PostGIS response carries the field the snapshot has
        -- always carried. Without it UtilitiesLayer laid the demo tower's
        -- riser out against the street datum on one backend and the
        -- building's on the other.
        'building_id',u.building_id,
        'in_conflict', EXISTS (SELECT 1 FROM conflict c
                                WHERE c.a_type='utility' AND c.a_id=u.id)))),'[]'::json)) AS fc
  FROM utility u ${f.clause}`,
    params: f.params,
  };
}

// The conflict table has no project_id of its own: a conflict is a relation
// between a utility and a floor, and both already belong to a project. It is
// scoped through the building join it already had.
function conflictsSql(scope: Scope) {
  const f = filter(scope, 'WHERE b.project_id = $P');
  return {
    sql: `
  SELECT COALESCE(json_agg(json_build_object(
    'id',c.id,'kind',c.kind,'detected_at',c.detected_at,
    'utility_id',u.id,'asset_type',u.asset_type,'authority',u.authority,
    'status',u.status,'depth_m',u.depth_m,
    'floor_id',f.id,'floor_ulpin',f.ulpin,'level_no',f.level_no,
    'building_id',b.id,'building_ulpin',b.ulpin,'building_name',b.name)
    ORDER BY c.id),'[]'::json) AS rows
  FROM conflict c
  JOIN utility u  ON u.id = c.a_id
  JOIN floor f    ON f.id = c.b_id
  JOIN building b ON b.id = f.building_id ${f.clause}`,
    params: f.params,
  };
}

function detailSql(scope: Scope, id: number) {
  const f = filter(scope, 'AND b.project_id = $P', [id]);
  return {
    sql: `
  SELECT json_build_object(
    'building', json_build_object(
      'id',b.id,'ulpin',b.ulpin,'parcel_id',b.parcel_id,'height_m',b.height_m,
      'floors',b.floors,'basements',b.basements,'ground_elev',b.ground_elev,'ground_source',b.ground_source,
      'flood_risk',b.flood_risk,'cyclone_risk',b.cyclone_risk,
      'flood_score',b.flood_score,'cyclone_score',b.cyclone_score,
      'coast_dist_m',b.coast_dist_m,'local_relief_m',b.local_relief_m,
      'use_type',b.use_type,'height_source',b.height_source,'survey_synthetic',b.survey_synthetic,'name',b.name,
      'address',b.address,'osm_id',b.osm_id,
      'footprint', ST_AsGeoJSON(b.footprint, 7)::json),
    'parcel', (SELECT json_build_object('id',p.id,'ulpin',p.ulpin,
         'area_m2',p.area_m2,'owner',p.owner,
         'geometry', ST_AsGeoJSON(p.geom, 7)::json)
       FROM parcel p WHERE p.id = b.parcel_id),
    'floors', COALESCE((SELECT json_agg(json_build_object(
         'id',f.id,'ulpin',f.ulpin,'level_no',f.level_no,'z_min',f.z_min,
         'z_max',f.z_max,'detect_source',f.detect_source,
         'ring', ST_AsGeoJSON(ST_Force2D(b.footprint), 7)::json)
         ORDER BY f.level_no)
       FROM floor f WHERE f.building_id = b.id),'[]'::json),
    'units', COALESCE((SELECT json_agg(json_build_object(
         'id',u.id,'floor_id',u.floor_id,'ulpin',u.ulpin,'unit_no',u.unit_no,
         'z_min',u.z_min,'z_max',u.z_max,'carpet_m2',u.carpet_m2,
         'built_m2',u.built_m2,'tenure',u.tenure,'encumbrance',u.encumbrance,
         'owner',u.owner,'address',u.address,'facing',u.facing,
         'kind',u.kind,'core_ref',u.core_ref,'label',u.label,
         'level_no',f2.level_no,
         'ring', ST_AsGeoJSON(ST_Force2D(ST_GeometryN(u.geom_3d,1)), 7)::json)
         ORDER BY f2.level_no, u.unit_no)
       FROM unit u JOIN floor f2 ON f2.id = u.floor_id
       WHERE f2.building_id = b.id),'[]'::json)
  ) AS doc
  FROM building b WHERE b.id = $1 ${f.clause}`,
    params: f.params,
  };
}

// Three subtleties here:
//
// 1. PostgreSQL only allows output column names or ordinals in a UNION's ORDER
//    BY, so the ranking expression sits outside the union rather than on it.
//
// 2. ST_3DIntersects treats a POLYHEDRALSURFACE as a *shell*: a point strictly
//    inside the prism does not intersect it. ST_MakeSolid promotes the shell to
//    a solid so the test becomes real volume containment. The `&&` prefilter
//    runs first on the 2D GIST index, so ST_MakeSolid only ever evaluates for
//    the handful of candidates under the cursor.
//
// 3. floor and unit have no project_id -- they inherit one through building --
//    so they are scoped by an extra join rather than an extra predicate. The
//    join is on the indexed FK and runs after the `&&` prefilter, so it costs
//    a lookup on the handful of candidates rather than a scan.
function querySql(scope: Scope, lon: number, lat: number, z: number) {
  const f = filter(scope, '$P', [lon, lat, z]);
  const p = f.clause; // '' in legacy mode, '$4' when scoped
  const parcelF = p ? `AND p.project_id = ${p}` : '';
  const buildingF = p ? `AND b.project_id = ${p}` : '';
  const floorJoin = p
    ? `JOIN building fb ON fb.id = f.building_id AND fb.project_id = ${p}` : '';
  const unitJoin = p
    ? `JOIN floor uf ON uf.id = u.floor_id
       JOIN building ub ON ub.id = uf.building_id AND ub.project_id = ${p}` : '';
  return {
    sql: `
  WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2,$3),4326) AS g,
                     ST_SetSRID(ST_MakePoint($1,$2),4326)    AS g2)
  SELECT s.level, s.id, s.building_id, s.ulpin, s.label, s.z_min, s.z_max, s.provenance
  FROM (
    SELECT 'parcel' AS level, p.id, NULL::bigint AS building_id, p.ulpin, p.owner AS label,
           NULL::float8 AS z_min, NULL::float8 AS z_max, NULL::text AS provenance
      FROM parcel p, pt WHERE ST_Intersects(p.geom, pt.g2) ${parcelF}
    UNION ALL
    SELECT 'building', b.id, b.id, b.ulpin,
           COALESCE(b.name, initcap(b.use_type) || ' building'),
           b.ground_elev, b.ground_elev + b.height_m, b.height_source
      FROM building b, pt
     WHERE ST_Intersects(b.footprint, pt.g2)
       AND $3 BETWEEN b.ground_elev - b.basements * 3.2 AND b.ground_elev + b.height_m
       ${buildingF}
    UNION ALL
    SELECT 'floor', f.id, f.building_id, f.ulpin, 'Level ' || f.level_no, f.z_min, f.z_max, f.detect_source
      FROM floor f ${floorJoin}, pt
     WHERE f.geom && pt.g2 AND ST_3DIntersects(ST_MakeSolid(f.geom), pt.g)
    UNION ALL
    SELECT 'unit', u.id, ub.id, u.ulpin, u.unit_no, u.z_min, u.z_max, NULL
      FROM unit u ${unitJoin}, pt
     WHERE u.geom_3d && pt.g2 AND ST_3DIntersects(ST_MakeSolid(u.geom_3d), pt.g)
  ) s
  ORDER BY CASE s.level WHEN 'parcel' THEN 1 WHEN 'building' THEN 2
                        WHEN 'floor' THEN 3 ELSE 4 END, s.id`,
    params: f.params,
  };
}

/** Raw footprints, from PostGIS or the snapshot. NOT enriched. */
async function buildingsFC(slug: string): Promise<GeoFC<BuildingProps>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = buildingsSql(scope);
    return (await q<{ fc: GeoFC<BuildingProps> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<BuildingProps>>(slug, 'buildings.json');
}

/**
 * A memo whose entries expire when the project's edits change.
 *
 * Used three times below with three different value types, which is the only
 * reason it is a helper rather than three pairs of module-level variables --
 * those were what made the single-project version of this file hard to reason
 * about once a second key had to be added to each of them.
 */
function editAwareCache<T>() {
  const store = new Map<string, { rev: number; value: T }>();
  return {
    get(slug: string): T | null {
      const hit = store.get(slug);
      return hit && hit.rev === editsRev(slug) ? hit.value : null;
    },
    set(slug: string, value: T): T {
      store.set(slug, { rev: editsRev(slug), value });
      return value;
    },
  };
}

/**
 * buildingId -> real unit totals, memoised per project.
 *
 * THE CONSISTENCY TRAP THIS SOLVES. getBuildings() has no unit rows in hand,
 * so a naive implementation would estimate built_up_m2 from the footprint
 * while getBuildingDetail() summed the real unit areas -- two different
 * numbers for the same building, and the DetailPanel reads its header rows
 * from the FeatureCollection and the rest from the detail document. Both
 * paths take their totals from this one index instead.
 *
 * On the snapshot path this walks detail.json once. That file is already
 * parsed and held by `fileCache` for getBuildingDetail, so the cost is paid
 * once per project per process and never again.
 */
const unitIndexCache = editAwareCache<Map<number, UnitFacts>>();

async function unitIndex(slug: string): Promise<Map<number, UnitFacts>> {
  const hit = unitIndexCache.get(slug);
  if (hit) return hit;
  const out = new Map<number, UnitFacts>();

  const viaSql = await viaDb(slug, async (scope) => {
    const f = filter(scope, 'WHERE b.project_id = $P');
    return q<{ building_id: number; built: string; n: number }>(
      'SELECT f.building_id, sum(u.built_m2) AS built, count(*)::int AS n '
      + 'FROM unit u JOIN floor f ON f.id = u.floor_id '
      + `JOIN building b ON b.id = f.building_id ${f.clause} `
      + 'GROUP BY f.building_id', f.params);
  });
  if (viaSql.ok) {
    for (const row of viaSql.value) {
      out.set(row.building_id, { builtM2: Number(row.built) || 0, unitCount: row.n });
    }
    return unitIndexCache.set(slug, out);
  }

  const all = await snapshot<Record<string, BuildingDetail>>(slug, 'detail.json');
  for (const [key, doc] of Object.entries(all)) {
    let builtM2 = 0;
    // Reads the on-disk snapshot, which is never redacted -- the ?? 0 is for
    // the optional type, not for a case that occurs here.
    for (const u of doc.units ?? []) builtM2 += u.built_m2 ?? 0;
    out.set(Number(key), { builtM2, unitCount: doc.units?.length ?? 0 });
  }
  return unitIndexCache.set(slug, out);
}

/**
 * Vertices of every street in a project, for the nearest-street lookup the
 * generated addresses use.
 *
 * A generated address should at least name a street that really runs past the
 * building. Built from the same derived artefact the map draws, and degrades
 * to an empty list (the generator then falls back to the project name) when it
 * is absent -- which is the normal state for a project whose roads artefact
 * has not been built.
 */
const streetIndexCache = new Map<string, { lon: number; lat: number; name: string }[]>();

async function streetIndex(
  slug: string,
): Promise<{ lon: number; lat: number; name: string }[]> {
  const hit = streetIndexCache.get(slug);
  if (hit) return hit;
  let pts: { lon: number; lat: number; name: string }[] = [];
  try {
    const fc = await snapshot<GeoFC<RoadProps>>(slug, 'roads.json');
    for (const f of fc.features) {
      const parts = f.geometry.type === 'MultiLineString'
        ? (f.geometry.coordinates as number[][][])
        : [f.geometry.coordinates as number[][]];
      for (const line of parts) {
        // Every third vertex is plenty: this is a nearest-street lookup, not a
        // routing index, and it keeps the scan small.
        for (let i = 0; i < line.length; i += 3) {
          pts.push({ lon: line[i][0], lat: line[i][1], name: f.properties.name });
        }
      }
    }
  } catch {
    pts = [];
  }
  streetIndexCache.set(slug, pts);
  return pts;
}

function nearestStreetFactory(pts: { lon: number; lat: number; name: string }[]) {
  return (lon: number, lat: number): string | null => {
    let best: string | null = null;
    let bestD = Infinity;
    for (const p of pts) {
      // Squared degrees: monotonic in true distance at this scale, and this
      // runs once per building over a few thousand points.
      const dx = p.lon - lon;
      const dy = p.lat - lat;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = p.name; }
    }
    return best;
  };
}

/**
 * Apply a user's edits over a record, in two passes.
 *
 * The two passes answer different questions and neither alone is correct:
 *
 *   Pass 1 overlays only the fields that exist in the REAL schema (name,
 *   address, floors, height_m) BEFORE enrichment, so that everything the
 *   generator derives from them -- the built-up estimate, the occupancy band,
 *   the permitted building subtypes -- is derived from the edited values
 *   rather than the originals.
 *
 *   Pass 2 overlays every edited field AFTER enrichment, so that a value the
 *   user typed explicitly wins outright over whatever the generator produced
 *   for it.
 *
 * A single pass in either direction gets one of the two wrong: applied only
 * before, an explicit built-up area is overwritten by the estimate; applied
 * only after, editing the storey count leaves every derived figure stale.
 */
const REAL_SCHEMA_FIELDS = ['name', 'address', 'floors', 'height_m'] as const;

function preEnrich(b: BuildingProps, edit: Partial<BuildingEdit> | null): BuildingProps {
  if (!edit) return b;
  const out = { ...b };
  for (const f of REAL_SCHEMA_FIELDS) {
    if (edit[f] !== undefined) (out as Record<string, unknown>)[f] = edit[f];
  }
  return out;
}

function postEnrich(
  b: EnrichedBuilding,
  edit: Partial<BuildingEdit> | null,
): EnrichedBuilding {
  if (!edit) return b;
  const out: EnrichedBuilding = { ...b, ...edit };
  // An edited name or address is no longer an OSM tag nor a generated value;
  // it is the user's. The panel needs to be able to say so.
  if (edit.name !== undefined) out.name_source = 'generated';
  if (edit.address !== undefined) out.address_source = 'generated';
  return out;
}

/**
 * Footprints, with the synthetic register attached.
 *
 * The enrichment is the LAST transform before the data leaves this module and
 * it is applied on both backends, so PostGIS and the snapshot serve identical
 * records. See lib/mock/building.ts for what it may and may not invent.
 *
 * Memoised per project on the edit revision.
 *
 * Enrichment walks 384 buildings and, for each, scans ~3,800 street vertices
 * to find the one its generated address should name -- about 1.5M distance
 * comparisons. Cheap once, wasteful on every request, and queryPoint calls
 * this too, so a point query was paying for the whole collection. The result
 * is a pure function of (raw data, unit index, streets, edits), and only the
 * last of those can change at runtime.
 */
const enrichedCache = editAwareCache<GeoFC<EnrichedBuilding>>();

export async function getBuildings(slug: string): Promise<GeoFC<EnrichedBuilding>> {
  const hit = enrichedCache.get(slug);
  if (hit) return hit;

  const [fc, units, streets, edits] = await Promise.all([
    buildingsFC(slug), unitIndex(slug), streetIndex(slug), allEdits(slug),
  ]);
  // The project's own name, so a generated address says where the building
  // actually is. It rides on the FeatureCollection from both backends.
  const locality = fc.aoi ?? null;
  const pre: GeoFC<BuildingProps> = edits.size === 0 ? fc : {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      properties: preEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  const enriched = enrichCollection(pre, units, nearestStreetFactory(streets), locality);
  const out: GeoFC<EnrichedBuilding> = edits.size === 0 ? enriched : {
    ...enriched,
    features: enriched.features.map((f) => ({
      ...f,
      properties: postEnrich(f.properties, edits.get(f.properties.id) ?? null),
    })),
  };
  return enrichedCache.set(slug, out);
}

export async function getParcels(slug: string): Promise<GeoFC<ParcelInfo>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = parcelsSql(scope);
    return (await q<{ fc: GeoFC<ParcelInfo> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<ParcelInfo>>(slug, 'parcels.json');
}

/**
 * The survey parcels, from PostGIS or from the committed snapshot.
 *
 * The snapshot fallback is the one that matters here in practice: an existing
 * volume that has not run db/migrations/005 has no `survey_parcel` table, the
 * query throws, and `viaDb` reports `{ok:false}` -- which lands on exactly the
 * same file the snapshot backend serves. A project whose seed predates this
 * layer has neither, and gets an empty FeatureCollection rather than a 500:
 * the 2D view then draws nothing and says so, which is the truthful state.
 * `getRoads` takes the same shape for the same reason.
 */
export async function getSurveyParcels(
  slug: string,
): Promise<GeoFC<SurveyParcelProps>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = surveyParcelsSql(scope);
    return (await q<{ fc: GeoFC<SurveyParcelProps> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  try {
    return await snapshot<GeoFC<SurveyParcelProps>>(slug, 'survey_parcels.json');
  } catch {
    return { type: 'FeatureCollection', features: [] } as GeoFC<SurveyParcelProps>;
  }
}

/**
 * One survey parcel with the whole ULPIN tree beneath it.
 *
 * NOT A SECOND NESTING IMPLEMENTATION. Every building is read through the same
 * `getBuildingDetail` that `/building/:id` serves, so floors, units, edits and
 * the mock register all arrive by the one path that already exists. The only
 * thing done here is regrouping that document's flat `units` array under the
 * floor each one names in `floor_id` -- which is a reshape of one response,
 * not a second way of asking the question.
 */
export async function getSurveyParcelDetail(
  slug: string,
  id: number,
): Promise<SurveyParcelDetail | null> {
  const fc = await getSurveyParcels(slug);
  const feature = fc.features.find(
    (f) => (f.properties as SurveyParcelProps | null)?.id === id,
  );
  if (!feature) return null;
  const props = feature.properties as SurveyParcelProps;

  const details = await Promise.all(
    (props.building_ids ?? []).map((bid) => getBuildingDetail(slug, bid)),
  );

  const buildings: SurveyParcelDetail['buildings'] = [];
  for (const d of details) {
    if (!d) continue;
    const byFloor = new Map<number, UnitInfo[]>();
    for (const u of d.units) {
      const list = byFloor.get(u.floor_id);
      if (list) list.push(u);
      else byFloor.set(u.floor_id, [u]);
    }
    buildings.push({
      building: d.building,
      floors: d.floors.map((f) => ({ ...f, units: byFloor.get(f.id) ?? [] })),
    });
  }

  return {
    parcel: { ...props, geometry: feature.geometry as unknown as Ring },
    buildings,
  };
}

/**
 * The Section 22A prohibited-property register, as drawable features.
 *
 * TWO SOURCES, ONE ANSWER. The register itself comes from
 * `section22aSourceFor(slug)` -- today a committed file, tomorrow a government
 * feed, and nothing downstream of here knows which. The GEOMETRY comes from
 * `getSurveyParcels`, which is the existing reader with its own PostGIS and
 * snapshot paths, so this endpoint works on both backends without a second
 * code path and without a line of SQL.
 *
 * WHY THE REGISTER IS NOT A TABLE. Same reason `flatRegister()` above is not:
 * it is read on BOTH backends, so PostGIS and the snapshot cannot disagree
 * about it. A `section_22a` table would be empty on every existing volume,
 * `viaDb()` would report success with zero rows, the snapshot fallback would
 * never fire, and the layer would draw nothing with docker up while drawing the
 * register with docker down. It is also the correct home on the merits: a 22A
 * listing is a Registration & Stamps record about what may not be DONE with a
 * plot, not a survey record about what the plot IS.
 *
 * NEVER THROWS. A missing file, an unreadable file and a source that throws all
 * become an empty register with `record_count: 0`, which is the same contract
 * `getRoads` and `getSurveyParcels` keep: a project with no register is a
 * normal state, and reporting it as a 500 would tell a user their project is
 * broken when it is merely not listed.
 */
export async function getSection22A(slug: string): Promise<Section22AFC> {
  const source = section22aSourceFor(slug);
  let listing: Section22AListing = { records: [], retrieved_on: null };
  try {
    listing = await source.list(slug);
  } catch (err) {
    console.error(`[ulpin-22a] register source ${source.id} failed for ${slug}:`, err);
  }

  const parcels = await getSurveyParcels(slug);
  const { features, unlocated } = resolveSection22A(listing.records, parcels);

  return {
    type: 'FeatureCollection',
    features,
    register: {
      source_id: source.id,
      source_label: source.label,
      authoritative: source.authoritative,
      retrieved_on: listing.retrieved_on,
      record_count: listing.records.length,
      unlocated_count: unlocated.length,
    },
    // Carried on the wire, not only in the interface: a caller reading this
    // endpoint directly gets the caveat with the data, which is the same reason
    // getRoads stamps its own derivation onto the collection.
    _disclaimer: source.authoritative
      ? SECTION_22A_DISCLAIMER
      : `${SECTION_22A_MOCK_NOTE} ${SECTION_22A_DISCLAIMER}`,
  };
}

export async function getUtilities(slug: string): Promise<GeoFC<UtilityProps>> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = utilitiesSql(scope);
    return (await q<{ fc: GeoFC<UtilityProps> }>(sql, params))[0].fc;
  });
  if (r.ok) return r.value;
  return snapshot<GeoFC<UtilityProps>>(slug, 'utilities.json');
}

/**
 * Streets. Snapshot-only, and deliberately so.
 *
 * db/01_schema.sql has no road table: scripts/utilities.sql builds one as an
 * UNLOGGED temp table to offset utility corridors from and drops it again. So
 * unlike buildings and parcels there is no PostGIS answer to prefer here, and
 * wrapping this in viaDb() would only imply one exists. The centrelines are
 * merged, named and measured at build time by scripts/build_roads.mjs.
 *
 * A project whose artefact has not been built answers with an empty collection
 * that says so, rather than a 500. Streets are orientation context; their
 * absence must not read as "this project is broken", and it is the same
 * honest caveat streets have always carried.
 */
export async function getRoads(slug: string): Promise<GeoFC<RoadProps>> {
  try {
    return await snapshot<GeoFC<RoadProps>>(slug, 'roads.json');
  } catch {
    return {
      type: 'FeatureCollection',
      features: [],
      _disclaimer:
        `No street artefact has been built for "${slug}". Streets are derived `
        + 'at build time by scripts/build_roads.mjs and written to '
        + `data/api/${slug}/roads.json; until that runs this project has no `
        + 'centrelines to draw. Nothing else about the project is affected.',
    } as GeoFC<RoadProps>;
  }
}

/**
 * A site id is a path segment joined onto a directory, so it is validated the
 * way lib/projects.ts validates a slug -- and for the same reason.
 */
export function isValidSiteId(id: string): boolean {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/**
 * The project's named infrastructure sites.
 *
 * Snapshot-only, exactly like streets: there is no `site` table, because a
 * platform is not a cadastral object and giving it one would mean minting it a
 * ULPIN, an owner and a tenure that do not exist. A project with no sites is
 * not an error -- it is every project but one -- so this answers with an empty
 * list rather than throwing.
 */
export async function getSites(slug: string): Promise<SiteIndex> {
  try {
    return await snapshot<SiteIndex>(slug, 'sites.json');
  } catch {
    return { sites: [] };
  }
}

/**
 * One site's full specification.
 *
 * Fetched separately from the index, and only when a site is actually opened:
 * the index is a few hundred bytes and drives the navigator, while a station
 * spec is the whole structure. Null when the project does not have it.
 */
export async function getSiteSpec(slug: string, siteId: string): Promise<SiteSpec | null> {
  if (!isValidSiteId(siteId)) return null;
  try {
    return await snapshot<SiteSpec>(slug, path.join('infra', `${siteId}.json`));
  } catch {
    return null;
  }
}

export async function getConflicts(slug: string): Promise<ConflictRow[]> {
  return getPristineConflicts(slug);
}

/**
 * The PRISTINE conflict set: every utility/floor intersection as it sits
 * in PostGIS or in the snapshot, with no edit overlay.
 *
 * The cache stores THIS value. When a building is edited (height_m or
 * basements), the floor's z range changes, and some conflicts that
 * existed in the pristine set are no longer intersections and some new
 * ones are. The route handler applies an overlay that recomputes
 * conflicts for the edited buildings and merges the result over the
 * pristine set -- the cache itself is never touched by a PATCH.
 */
export async function getPristineConflicts(slug: string): Promise<ConflictRow[]> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = conflictsSql(scope);
    return (await q<{ rows: ConflictRow[] }>(sql, params))[0].rows;
  });
  if (r.ok) return r.value;
  return snapshot<ConflictRow[]>(slug, 'conflicts.json');
}

/**
 * The PRISTINE building detail: the document exactly as it lives in PostGIS
 * or in the snapshot's detail.json, with no edit overlay and no enrichment.
 *
 * The Redis cache stores THIS value, not the enriched one. The route
 * handler reads the cached pristine document and applies the enrichment
 * (which is also where the edit overlay lives) on every request, so a
 * PATCH never has to invalidate the cache: the cache holds the un-edited
 * truth, and the overlay is a pure function applied over it.
 *
 * `null` is a legitimate return value -- a 404 -- and the caller is
 * responsible for not caching it. The brief is explicit on that: "never
 * cache a 404 or 503".
 */
export async function getPristineBuildingDetail(
  slug: string,
  id: number,
): Promise<BuildingDetail | null> {
  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = detailSql(scope, id);
    const rows = await q<{ doc: BuildingDetail }>(sql, params);
    return rows[0]?.doc ?? null;
  });
  if (r.ok) return r.value;
  const all = await snapshot<Record<string, BuildingDetail>>(slug, 'detail.json');
  return all[String(id)] ?? null;
}

/**
 * Run the enrichment (and edit overlay) over an already-fetched pristine
 * BuildingDetail. Exported so the read-through cache in lib/cache/store.ts
 * can hold the PRISTINE document in Redis and re-run enrichment on every
 * read -- the cached byte is small and stable, the overlay is the only
 * thing that can change, and running it on every read is the "no
 * invalidation to get wrong" property the cache exists to provide.
 *
 * `null` is returned only when the raw input is null; the enrichment
 * itself never nulls a document. The 404 signal therefore belongs to
 * the pristine read, not the overlay.
 */
export async function enrichBuildingDetail(
  slug: string,
  raw: BuildingDetail,
): Promise<BuildingDetail> {
  // Same generator, same seeds and the same unit index getBuildings uses, so
  // the header rows the panel reads from the FeatureCollection and the rows it
  // reads from here can never disagree.
  const id = raw.building.id;
  const [units, streets, edit, collection, register] = await Promise.all([
    unitIndex(slug), streetIndex(slug), editsFor(slug, id), buildingsFC(slug),
    flatRegister(slug),
  ]);
  const ring = (raw.building.footprint?.coordinates as number[][][] | undefined)?.[0];
  let lon = 0;
  let lat = 0;
  if (ring && ring.length > 1) {
    const n = ring.length - 1;
    for (let i = 0; i < n; i++) { lon += ring[i][0] / n; lat += ring[i][1] / n; }
  }
  const enriched = postEnrich(
    enrichBuilding(preEnrich(raw.building, edit), {
      footprint: raw.building.footprint,
      units: units.get(id) ?? null,
      nearestStreet: nearestStreetFactory(streets)(lon, lat),
      // Same locality the collection path uses, so the panel's header rows and
      // its detail rows cannot disagree about which city the building is in.
      locality: collection.aoi ?? null,
    }),
    edit,
  );
  // The register rides on the unit rows it belongs to, so the panel reads one
  // object per flat and the citizen filter's field whitelist redacts the money
  // for a neighbour's flat without needing to know these fields exist.
  const withRegister = raw.units.map((u) => {
    const entry = u.ulpin ? register[u.ulpin] : undefined;
    return entry ? { ...u, ...entry } : u;
  });
  return {
    ...raw,
    building: { ...enriched, footprint: raw.building.footprint },
    units: withRegister,
  };
}

export async function getBuildingDetail(
  slug: string,
  id: number,
): Promise<BuildingDetail | null> {
  const raw = await getPristineBuildingDetail(slug, id);
  if (!raw) return null;
  return enrichBuildingDetail(slug, raw);
}

/**
 * Every entity whose 3D volume contains (lon, lat, z), coarse to fine.
 * ST_3DIntersects against a POINT Z is the containment test on the DB path.
 */
export async function queryPoint(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const hits = await getPristineQueryPoint(slug, lon, lat, z);

  // The building label is built inside the query SQL (and its JS twin),
  // neither of which can reach the TypeScript enrichment. Reconciled here so
  // this third read path names a building the same way the other two do.
  const named = await getBuildings(slug);
  const byId = new Map(named.features.map((f) => [f.properties.id, f.properties]));
  return hits.map((h) => {
    const p = h.level === 'building' ? byId.get(h.id) : undefined;
    return p && p.name ? { ...h, label: p.name } : h;
  });
}

/**
 * The PRISTINE point query: the stack of entities at (lon, lat, z) as
 * PostGIS or the snapshot computes it, with the building label as it
 * sits in the database (or absent).
 *
 * The cache stores THIS value. When a building is edited, the
 * containment test's result can change for points inside the edited
 * building's volume (height_m and basements both feed the test), and
 * the building's name can change. The route handler applies an overlay
 * that adjusts z values and labels for edited buildings over the
 * cached pristine result.
 */
export async function getPristineQueryPoint(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const scope = await scopeFor(slug);
  if (scope) {
    const { sql, params } = querySql(scope, lon, lat, z);
    return q<StackHit>(sql, params);
  }
  return queryPointFromSnapshot(slug, lon, lat, z);
}

/** Ray-casting point-in-ring; exact for the vertical prisms this schema stores. */
function inRing(ring: number[][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function firstRing(g: { coordinates: unknown }): number[][] {
  return (g.coordinates as number[][][])[0];
}

interface SnapParcel {
  properties: { id: number; ulpin: string; owner: string };
  geometry: { coordinates: unknown };
}
interface SnapBuilding {
  properties: {
    id: number; ulpin: string; name: string | null; use_type: string;
    ground_elev: number; height_m: number; basements: number; height_source: string;
  };
  geometry: { coordinates: unknown };
}

async function queryPointFromSnapshot(
  slug: string,
  lon: number,
  lat: number,
  z: number,
): Promise<StackHit[]> {
  const out: StackHit[] = [];
  const parcels = await snapshot<{ features: SnapParcel[] }>(slug, 'parcels.json');
  const buildings = (await buildingsFC(slug)) as unknown as { features: SnapBuilding[] };

  for (const f of parcels.features) {
    if (inRing(firstRing(f.geometry), lon, lat)) {
      out.push({
        level: 'parcel', id: f.properties.id, building_id: null,
        ulpin: f.properties.ulpin,
        label: f.properties.owner, z_min: null, z_max: null, provenance: null,
      });
    }
  }

  for (const f of buildings.features) {
    const p = f.properties;
    if (!inRing(firstRing(f.geometry), lon, lat)) continue;
    const zBottom = p.ground_elev - p.basements * 3.2;
    const zTop = p.ground_elev + p.height_m;
    if (z < zBottom || z > zTop) continue;

    const fallbackLabel = p.use_type.charAt(0).toUpperCase() + p.use_type.slice(1) + ' building';
    out.push({
      level: 'building', id: p.id, building_id: p.id, ulpin: p.ulpin,
      label: p.name ?? fallbackLabel,
      z_min: p.ground_elev, z_max: zTop,
      provenance: p.height_source as StackHit['provenance'],
    });

    const detail = await getBuildingDetail(slug, p.id);
    if (!detail) continue;
    for (const fl of detail.floors) {
      if (z >= fl.z_min && z <= fl.z_max) {
        out.push({
          level: 'floor', id: fl.id, building_id: p.id, ulpin: fl.ulpin,
          label: `Level ${fl.level_no}`,
          z_min: fl.z_min, z_max: fl.z_max, provenance: fl.detect_source,
        });
      }
    }
    for (const u of detail.units) {
      if (z >= u.z_min && z <= u.z_max && inRing(firstRing(u.ring), lon, lat)) {
        out.push({
          level: 'unit', id: u.id, building_id: p.id, ulpin: u.ulpin ?? '',
          label: u.unit_no,
          z_min: u.z_min, z_max: u.z_max, provenance: null,
        });
      }
    }
  }

  const rank = { parcel: 1, building: 2, floor: 3, unit: 4 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

// ---------------------------------------------------------------------------
// Topology validation.
//
// Answered on demand, unlike `conflict`, which is a seeded table recording one
// fixed question. Both backends answer, and they answer the SAME question:
//
//   PostGIS   runs it as real solid geometry -- ST_3DIntersects for the
//             encroachments and ST_3DDistance for the easement clearances,
//             through solids_intersect()'s SFCGAL path.
//   Snapshot  runs lib/topology.ts, which is the prism-exact equivalent of
//             the same two tests and is what db/02_functions.sql already
//             falls back to when SFCGAL is missing.
//
// The air-rights test has NO database half in either case: flyover decks are
// components of a SiteSpec in lib/infra, never rows, so it is computed from
// the specs on both paths.
// ---------------------------------------------------------------------------

/**
 * How far apart two things can be and still be worth an exact test, in
 * degrees. Comfortably wider than the largest clearance any category declares
 * (2.5 m, sewer), and it only decides which pairs reach the exact test.
 */
const TOPOLOGY_PAD_DEG = 0.00006;   // ~6.6 m

function topologySql(scope: Scope) {
  const runF = filter(scope, 'AND u.project_id = $P');
  const volF = filter(scope, 'AND b.project_id = $P', runF.params);
  const vol2F = filter(scope, 'AND b2.project_id = $P', volF.params);
  return {
    sql: `
  WITH runs AS (
    SELECT u.id, u.asset_type, u.authority, u.radius_m, u.envelope_3d,
           u.ref, u.building_id
      FROM utility u
     WHERE u.envelope_3d IS NOT NULL ${runF.clause}
  ), vols AS (
    -- Individually titled subsurface volumes: the parking bays.
    SELECT 'unit'::text AS vtype, un.id::bigint AS id, un.ulpin,
           COALESCE(un.label, un.unit_no) AS label, un.kind,
           un.geom_3d AS geom, un.z_min, un.z_max, f.building_id
      FROM unit un
      JOIN floor f ON f.id = un.floor_id
      JOIN building b ON b.id = f.building_id
     WHERE un.kind = 'parking' ${volF.clause}
    UNION ALL
    -- And the basement slabs themselves, for a building with no bay plan.
    SELECT 'floor', f2.id::bigint, f2.ulpin,
           'Level ' || f2.level_no, NULL,
           f2.geom, f2.z_min, f2.z_max, f2.building_id
      FROM floor f2
      JOIN building b2 ON b2.id = f2.building_id
     WHERE f2.level_no < 0 ${vol2F.clause}
  )
  SELECT r.id                AS run_id,
         r.asset_type, r.authority, r.ref, r.radius_m,
         v.vtype, v.id       AS vol_id,
         v.ulpin, v.label, v.kind,
         v.z_min, v.z_max,
         ST_Z(ST_PointOnSurface(ST_Force2D(r.envelope_3d))) IS NOT NULL AS has_z,
         ST_X(ST_PointOnSurface(ST_Force2D(v.geom))) AS lon,
         ST_Y(ST_PointOnSurface(ST_Force2D(v.geom))) AS lat,
         ST_ZMin(r.envelope_3d) AS run_z_min,
         ST_ZMax(r.envelope_3d) AS run_z_max,
         -- The exact tests. ST_MakeSolid matters on the intersect: without it
         -- both operands are open shells, so a corridor lying WHOLLY INSIDE a
         -- basement -- the worst encroachment there is -- would not report.
         ST_3DIntersects(ST_MakeSolid(r.envelope_3d), ST_MakeSolid(v.geom)) AS hits,
         ST_3DDistance(r.envelope_3d, v.geom) AS sep_m
    FROM runs r
    JOIN vols v
      ON ST_Force2D(r.envelope_3d) && ST_Expand(ST_Force2D(v.geom), ${TOPOLOGY_PAD_DEG})
   WHERE (r.building_id IS NULL OR r.building_id <> v.building_id)`,
    params: vol2F.params,
  };
}

interface TopologyRow {
  run_id: number;
  asset_type: string;
  authority: string;
  ref: string | null;
  radius_m: number;
  vtype: ClashPartyType;
  vol_id: number;
  building_id: number;
  ulpin: string | null;
  label: string;
  kind: string | null;
  z_min: number;
  z_max: number;
  lon: number;
  lat: number;
  run_z_min: number;
  run_z_max: number;
  hits: boolean;
  sep_m: number;
}

/**
 * Elevated air-rights findings, from the project's infrastructure specs.
 *
 * Shared by both backends because there is no other source: a deck span is a
 * component of a SiteSpec, and `placeSite` is the pure function that turns one
 * into rings and heights. The building envelope is the footprint swept from
 * its ground to its roof, which is the same volume BuildingsLayer extrudes.
 */
async function airRightsFor(slug: string): Promise<ClashFinding[]> {
  let index: SiteIndex;
  try {
    index = await getSites(slug);
  } catch {
    return [];
  }
  if (!index?.sites?.length) return [];

  const buildings = await getBuildings(slug);
  const envelopes: VolumeInput[] = [];
  for (const f of buildings.features) {
    const p = f.properties;
    const ring = (f.geometry.coordinates as number[][][])?.[0];
    if (!ring || ring.length < 4) continue;
    envelopes.push({
      type: 'building',
      id: p.id,
      ulpin: p.ulpin,
      label: p.name ?? `Building ${p.id}`,
      ring,
      z_min: p.ground_elev,
      z_max: p.ground_elev + Math.max(2, p.height_m),
    });
  }
  if (!envelopes.length) return [];

  const decks: VolumeInput[] = [];
  for (const entry of index.sites) {
    const spec = await getSiteSpec(slug, entry.id);
    if (!spec) continue;
    // A bare datum: the specs carry real lon/lat for the pieces that matter,
    // and the deck heights are relative to the site's own ground.
    const placed = placeSite(spec, 0);
    for (const c of placed.components) {
      if (c.kind !== 'deck_span' && c.kind !== 'ramp') continue;
      c.rings.forEach((flat, i) => {
        const ring: number[][] = [];
        for (let k = 0; k + 1 < flat.length; k += 2) ring.push([flat[k], flat[k + 1]]);
        if (ring.length < 3) return;
        ring.push(ring[0]);
        decks.push({
          type: 'infra',
          id: c.ref,
          label: c.label || c.ref,
          ring,
          z_min: c.base[i] ?? 0,
          z_max: c.top[i] ?? 0,
        });
      });
    }
  }
  if (!decks.length) return [];

  return detectClashes({ runs: [], volumes: [], clearanceOf, decks, envelopes });
}

/** The clearance a category requires, or null when it declares none. */
function clearanceOf(assetType: string): number | null {
  const cat = categoryOfAssetType(assetType);
  if (!cat) return null;
  return UNDERGROUND_BY_KEY[cat]?.clearance ?? null;
}

/**
 * Run topology validation for a project, on whichever backend answers.
 *
 * Never cached: it is a question about the CURRENT state, and the button that
 * fires it exists so a user can re-ask it after an edit.
 */
export async function getTopology(slug: string): Promise<ClashFinding[]> {
  const air = await airRightsFor(slug);

  const viaSql = await viaDb(slug, async (scope) => {
    const { sql, params } = topologySql(scope);
    const rows = await q<TopologyRow>(sql, params);
    const out: ClashFinding[] = [];
    for (const r of rows) {
      const clearance = clearanceOf(r.asset_type);
      const sep = Number(r.sep_m);
      const label = `${r.ref ?? `#${r.run_id}`} · ${r.asset_type} · ${r.authority}`;
      const a: ClashParty = {
        type: 'utility',
        id: r.run_id,
        label,
        z_min: Number(r.run_z_min),
        z_max: Number(r.run_z_max),
      };
      const b: ClashParty = {
        type: r.vtype,
        id: r.vol_id,
        ulpin: r.ulpin ?? undefined,
        label: r.label,
        z_min: Number(r.z_min),
        z_max: Number(r.z_max),
        building_id: r.building_id,
      };
      if (r.hits) {
        out.push({
          kind: r.kind === 'parking'
            ? 'utility_through_parking' : 'utility_through_basement',
          severity: 'critical',
          a,
          b,
          lon: Number(r.lon),
          lat: Number(r.lat),
          z: Math.max(b.z_min, Math.min(b.z_max, (a.z_min + a.z_max) / 2)),
          separation_m: 0,
          required_m: clearance ?? undefined,
          note: `${label} passes through ${r.label}.`,
        });
      } else if (clearance !== null && Number.isFinite(sep) && sep < clearance) {
        out.push({
          kind: 'clearance_breach',
          severity: 'warning',
          a,
          b,
          lon: Number(r.lon),
          lat: Number(r.lat),
          z: (a.z_min + a.z_max) / 2,
          separation_m: Math.round(sep * 1000) / 1000,
          required_m: clearance,
          note: `${label} comes within ${sep.toFixed(2)} m of ${r.label}; `
            + `${clearance.toFixed(2)} m clearance is required.`,
        });
      }
    }
    return out;
  });
  if (viaSql.ok) return [...viaSql.value, ...air];

  // ---- snapshot path -----------------------------------------------------
  // The same two tests, computed from the committed documents by the prism
  // arithmetic in lib/topology.ts.
  const [utilities, buildings] = await Promise.all([
    getUtilities(slug), getBuildings(slug),
  ]);
  const utilFc = utilities as GeoFC<UtilityProps>;

  // One ground datum for runs whose centreline carries no Z, matching what
  // scripts/utilities.sql bakes in: the project's mean building ground.
  let sum = 0; let n = 0;
  for (const f of buildings.features) {
    if (Number.isFinite(f.properties.ground_elev)) {
      sum += f.properties.ground_elev; n += 1;
    }
  }
  const groundZ = n ? sum / n : 12;

  const runs: RunInput[] = [];
  for (const f of utilFc.features) {
    const p = f.properties;
    const coords = f.geometry.coordinates as number[][];
    if (!Array.isArray(coords) || coords.length < 1) continue;
    runs.push({
      id: p.id,
      asset_type: p.asset_type,
      authority: p.authority,
      status: p.status,
      radius_m: p.radius_m,
      depth_m: p.depth_m,
      coordinates: coords,
      groundZ,
      ref: p.ref,
      building_id: p.building_id,
    });
  }

  // Only buildings with something below grade can be encroached on, so the
  // detail documents for the rest are never opened.
  const volumes: VolumeInput[] = [];
  for (const f of buildings.features) {
    const p = f.properties;
    if (!p.basements) continue;
    let doc: BuildingDetail | null = null;
    try {
      doc = await getBuildingDetail(slug, p.id);
    } catch {
      doc = null;
    }
    if (!doc) continue;
    const bays = doc.units.filter((u) => u.kind === 'parking');
    for (const u of bays) {
      const ring = (u.ring?.coordinates as number[][][] | undefined)?.[0];
      if (!ring || ring.length < 4) continue;
      volumes.push({
        type: 'unit',
        id: u.id,
        ulpin: u.ulpin,
        label: u.label ?? `Unit ${u.unit_no}`,
        ring,
        z_min: u.z_min,
        z_max: u.z_max,
        building_id: p.id,
        kind: 'parking',
      });
    }
    for (const fl of doc.floors) {
      if (fl.level_no >= 0) continue;
      const ring = (fl.ring?.coordinates as number[][][] | undefined)?.[0];
      if (!ring || ring.length < 4) continue;
      volumes.push({
        type: 'floor',
        id: fl.id,
        ulpin: fl.ulpin,
        label: `Level ${fl.level_no}`,
        ring,
        z_min: fl.z_min,
        z_max: fl.z_max,
        building_id: p.id,
      });
    }
  }

  return [...detectClashes({ runs, volumes, clearanceOf }), ...air];
}


// ---------------------------------------------------------------------------
// ISO 19152 (LADM)
//
// One document per spatial unit, assembled from three sources that each own a
// different part of it:
//
//   * the la_* REGISTRY (migration 007) -- who holds what, in what bundle,
//     under which right;
//   * the CADASTRE, reached through la_spatial_unit_v, for the geometry and
//     the vertical extent, which the registry deliberately does not copy;
//   * the FLAT REGISTER, a committed file, for the charge, the tax demand and
//     the parking allocation. Projected on read by lib/ladm.ts and never
//     migrated into PostGIS -- lib/db.ts:254-270 has the reasoning, and it is
//     also what makes those three fields identical on both backends.
//
// THE REGISTER LAYER RUNS ON BOTH PATHS, deliberately. Everything the
// projection can answer is answered by SQL on PostGIS and by ladm.json on the
// snapshot; everything the register answers is layered on afterwards, from the
// same file, by the same code. That is the shape that stops the two backends
// serving different documents -- the property `check:gis2d` already asserts
// for survey parcels.
// ---------------------------------------------------------------------------

/** The registry document as both backends serve it, before the register. */
interface LadmRaw {
  su: {
    su_id: string;
    su_type: LADMSpatialUnitType;
    dimension: LADMDimension;
    source_kind: 'parcel' | 'survey_parcel' | 'unit' | 'utility';
    source_id: number;
    provenance: LADMProvenance;
    z_min: number | null;
    z_max: number | null;
    volume_m3: number | null;
    label: string | null;
    ring: Ring | null;
  } | null;
  ba_unit: {
    ba_unit_id: number;
    ba_ulpin: string;
    name: string;
    ba_type: 'basic_administrative_unit' | 'condominium_unit';
    ulpin_14: string | null;
    members: Array<{
      su_id: string;
      member_role: LADMMemberRole;
      share_num: number;
      share_den: number;
      su_type: LADMSpatialUnitType;
      label: string | null;
    }>;
  } | null;
  rrrs: Array<{
    rrr_id: number;
    rrr_class: LADMRRRClass;
    rrr_type: LADMRRRType;
    share_num: number;
    share_den: number;
    time_spec_from: string | null;
    time_spec_to: string | null;
    amount_inr: number | null;
    reference: string | null;
    description: string | null;
    party: LADMParty | null;
  }>;
  easements: Array<{
    su_id: string;
    label: string | null;
    z_min: number | null;
    z_max: number | null;
    authority: string | null;
    asset_type: string | null;
    description: string | null;
  }>;
}

const EMPTY_LADM: LadmRaw = { su: null, ba_unit: null, rrrs: [], easements: [] };

/**
 * The 2-D plan geometry of the spatial unit under selection.
 *
 * ladm_plan_geom() is a SQL function (db/02_functions.sql) rather than a
 * fragment written out here, because scripts/05_export_static.py needs the
 * identical expression and because doing it by hand failed twice: GEOS and the
 * geography type both refuse a POLYHEDRALSURFACE, and ST_Force2D does not help
 * -- the 2-D projection of a polyhedral surface is still one. The function
 * takes the solid's first face, which for every prism make_prism() builds is
 * the floor plate.
 */
const SU_PLAN = 'ladm_plan_geom(s.geom_3d)';

/**
 * The whole LADM document for one spatial unit, in one round trip.
 *
 * Assembled with json_build_object like every other reader here rather than as
 * five queries stitched together in TypeScript: the nesting is the shape the
 * API serves, and building it in SQL is what keeps the snapshot -- which is a
 * dump of exactly this -- field for field identical.
 */
function ladmSql(scope: Scope, suId: string) {
  const f = filter(scope, 'AND s.project_id = $P', [suId]);
  return {
    sql: `
  WITH s AS (
    SELECT * FROM la_spatial_unit_v s WHERE s.su_id = $1 ${f.clause}
  )
  SELECT json_build_object(
    'su', (SELECT json_build_object(
              'su_id', s.su_id, 'su_type', s.su_type, 'dimension', s.dimension,
              'source_kind', s.source_kind, 'source_id', s.source_id,
              'provenance', s.provenance,
              'z_min', s.z_min, 'z_max', s.z_max, 'volume_m3', s.volume_m3,
              'label', COALESCE(u.label, u.unit_no, 'Plot ' || s.su_id),
              'ring', ST_AsGeoJSON(${SU_PLAN}, 7)::json)
             FROM s LEFT JOIN unit u ON s.source_kind = 'unit' AND u.id = s.source_id),

    'ba_unit', (SELECT json_build_object(
              'ba_unit_id', ba.ba_unit_id, 'ba_ulpin', ba.ba_ulpin,
              'name', ba.name, 'ba_type', ba.ba_type, 'ulpin_14', ba.ulpin_14,
              'members', COALESCE((
                 SELECT json_agg(json_build_object(
                          'su_id', m.su_id, 'member_role', m.member_role,
                          'share_num', m.share_num, 'share_den', m.share_den,
                          'su_type', ms.su_type,
                          'label', COALESCE(mu.label, mu.unit_no, 'Plot ' || m.su_id))
                        ORDER BY m.member_role, m.su_id)
                   FROM la_ba_unit_member m
                   JOIN la_spatial_unit ms ON ms.su_id = m.su_id
                   LEFT JOIN unit mu ON ms.source_kind = 'unit' AND mu.id = ms.source_id
                  WHERE m.ba_unit_id = ba.ba_unit_id), '[]'::json))
             FROM s
             JOIN la_ba_unit_member pm ON pm.su_id = s.su_id
                                      AND pm.member_role = 'principal'
             JOIN la_ba_unit ba ON ba.ba_unit_id = pm.ba_unit_id
             LIMIT 1),

    'rrrs', COALESCE((
             SELECT json_agg(json_build_object(
                      'rrr_id', r.rrr_id, 'rrr_class', r.rrr_class,
                      'rrr_type', r.rrr_type,
                      'share_num', r.share_num, 'share_den', r.share_den,
                      'time_spec_from', r.time_spec_from,
                      'time_spec_to', r.time_spec_to,
                      'amount_inr', r.amount_inr, 'reference', r.reference,
                      'description', r.description,
                      'party', CASE WHEN pa.party_id IS NULL THEN NULL ELSE
                                 json_build_object('party_id', pa.party_id,
                                   'name', pa.name, 'party_type', pa.party_type,
                                   'role', pa.role,
                                   'authority_code', pa.authority_code) END)
                    ORDER BY r.rrr_class, r.rrr_id)
               FROM s
               JOIN la_ba_unit_member pm ON pm.su_id = s.su_id
                                        AND pm.member_role = 'principal'
               JOIN la_rrr r ON r.ba_unit_id = pm.ba_unit_id
               LEFT JOIN la_party pa ON pa.party_id = r.party_id), '[]'::json),

    'easements', COALESCE((
             SELECT json_agg(json_build_object(
                      'su_id', es.su_id,
                      'label', initcap(ut.asset_type) || ' corridor '
                               || COALESCE(ut.ref, ut.id::text),
                      'z_min', es.z_min, 'z_max', es.z_max,
                      'authority', ut.authority, 'asset_type', ut.asset_type,
                      'description', er.description)
                    ORDER BY es.su_id)
               FROM s
               JOIN la_spatial_unit es ON es.project_id = s.project_id
                                      AND es.source_kind = 'utility'
               JOIN utility ut ON ut.id = es.source_id
               LEFT JOIN la_ba_unit eb ON eb.ba_ulpin = es.su_id || '-BA'
               LEFT JOIN la_rrr er ON er.ba_unit_id = eb.ba_unit_id
                                  AND er.rrr_type = 'easement'
              -- THE CENTRELINE PLUS ITS RADIUS, NOT THE ENVELOPE.
              --
              -- utility.envelope_3d is a POLYHEDRALSURFACE, and every GEOS
              -- predicate -- ST_Intersects included -- refuses one outright:
              -- "Unknown geometry type: 13 - PolyhedralSurface". The failure
              -- was invisible for a volume, because the z-range test happened
              -- to prune every candidate before the predicate ran, and
              -- appeared only on a 2D surface plot, which has no z to prune
              -- with. It is a planner-order accident either way, so the fix
              -- is to stop handing GEOS a solid at all.
              --
              -- A corridor's plan footprint IS its centreline swept by
              -- radius_m, so ST_DWithin over geography is not an
              -- approximation of the envelope -- it is the same region,
              -- measured in metres on the ellipsoid rather than in degrees.
              -- The && prefilter is the cheap bbox pass the 2-D index can
              -- serve, exactly as topologySql does above.
              WHERE ST_Force2D(ut.geom_3d)
                    && ST_Expand(${SU_PLAN}, ${TOPOLOGY_PAD_DEG})
                AND ST_DWithin(ST_Force2D(ut.geom_3d)::geography,
                               ${SU_PLAN}::geography, ut.radius_m)
                AND (s.z_min IS NULL
                     OR (es.z_min <= s.z_max AND s.z_min <= es.z_max))), '[]'::json)
  ) AS doc`,
    params: f.params,
  };
}

/**
 * The LADM document for one spatial unit, from PostGIS or the snapshot.
 *
 * Returns null for an identifier this project does not register, which the
 * route turns into a 404 -- distinct from a throw, which would mean the
 * backend could not answer at all.
 *
 * NOTES ON TWO OF THE SUBQUERIES ABOVE, because both look over-specified and
 * are not:
 *
 * `ba_unit` selects the bundle this unit is the PRINCIPAL member of. A spatial
 * unit can be a member of many bundles -- one plot carries an undivided share
 * for every flat above it -- so matching on membership alone would hand a
 * plot back the first of eighty administrative records, arbitrarily.
 *
 * `easements` is resolved PER REQUEST, not stored. Which plots a corridor
 * burdens is a spatial question, and a projection of it would be stale the
 * moment a run moved. The test is 2D intersection AND z-range overlap, which
 * is exact for these prisms -- the same fallback solids_intersect() uses when
 * SFCGAL is absent, used unconditionally here so the answer does not depend on
 * which PostGIS image is running. A 2D unit has no z to overlap, so every run
 * crossing a surface plot qualifies, which is the correct answer for a plot:
 * the whole column beneath it is burdened.
 */
export async function getLadmDoc(
  slug: string, suId: string,
): Promise<LADMParcelDoc | null> {
  let raw: LadmRaw | null = null;

  const r = await viaDb(slug, async (scope) => {
    const { sql, params } = ladmSql(scope, suId);
    const rows = await q<{ doc: LadmRaw }>(sql, params);
    return rows.length ? rows[0].doc : EMPTY_LADM;
  });
  if (r.ok) {
    raw = r.value;
  } else {
    // The snapshot half. A project exported before LADM existed simply has no
    // ladm.json, which is not an error: it has no LADM document to serve, and
    // the panel says so rather than rendering an empty card.
    try {
      const all = await snapshot<Record<string, LadmRaw>>(slug, 'ladm.json');
      raw = all[suId] ?? EMPTY_LADM;
    } catch {
      return null;
    }
  }
  if (!raw?.su) return null;

  const project = await findProject(slug);
  const sep = project?.geoid_sep_m ?? null;

  const su: LADMSpatialUnit = {
    su_id: raw.su.su_id,
    su_type: raw.su.su_type,
    dimension: raw.su.dimension,
    source_kind: raw.su.source_kind,
    source_id: raw.su.source_id,
    provenance: raw.su.provenance,
  };
  if (raw.su.z_min !== null && raw.su.z_max !== null) {
    su.height = heightRange(raw.su.z_min, raw.su.z_max, sep);
  }
  if (raw.su.volume_m3 !== null) su.volume_m3 = raw.su.volume_m3;
  if (raw.su.ring) su.ring = raw.su.ring;
  if (raw.su.label) su.label = raw.su.label;

  const rrrs: LADMRRR[] = raw.rrrs.map((row) => {
    const out: LADMRRR = { rrr_class: row.rrr_class, rrr_type: row.rrr_type };
    out.rrr_id = row.rrr_id;
    if (row.share_den !== 1 || row.share_num !== 1) {
      out.share = { num: row.share_num, den: row.share_den };
    }
    if (row.party) out.party = row.party;
    if (row.time_spec_from) out.from = row.time_spec_from;
    if (row.time_spec_to) out.to = row.time_spec_to;
    if (row.amount_inr !== null) out.amount_inr = row.amount_inr;
    if (row.reference) out.reference = row.reference;
    if (row.description) out.description = row.description;
    return out;
  });

  let baUnit: LADMBAUnit | undefined;
  if (raw.ba_unit) {
    baUnit = {
      ba_unit_id: raw.ba_unit.ba_unit_id,
      ba_ulpin: raw.ba_unit.ba_ulpin,
      name: raw.ba_unit.name,
      ba_type: raw.ba_unit.ba_type,
      members: raw.ba_unit.members.map((m) => ({
        su_id: m.su_id,
        member_role: m.member_role,
        share: { num: m.share_num, den: m.share_den },
        su_type: m.su_type,
        ...(m.label ? { label: m.label } : {}),
      })),
    };
    if (raw.ba_unit.ulpin_14) baUnit.ulpin_14 = raw.ba_unit.ulpin_14;
  }

  // ---- the register, layered on ------------------------------------------
  // Only a `unit` has one, and only where the project ships a register file.
  // Everything below is ADDITIVE: nothing read from the cadastre is replaced,
  // so a project without a register serves exactly the document above.
  if (raw.su.source_kind === 'unit') {
    const register = await flatRegister(slug);
    const entry = register[raw.su.su_id];
    if (entry) {
      rrrs.push(...rrrFromRegister(entry));

      // The parking bay appurtenant to this flat. THE ALLOCATION IS A
      // REGISTER FACT: a bay carries no owner, because it is not separately
      // titled, so there is nothing in the cadastre to join on. See the
      // comment on FlatRegisterEntry.parking_ulpin.
      const bay = entry.parking_ulpin;
      if (baUnit && bay && !baUnit.members.some((m) => m.su_id === bay)) {
        baUnit.members.push({
          su_id: bay,
          member_role: 'appurtenant',
          share: { num: 1, den: 1 },
          su_type: 'multi_storey',
          ...(entry.parking_label ? { label: entry.parking_label } : {}),
        });
      }
    }
  }

  // Every distinct party named by any right on this holding. Deduplicated by
  // name and role -- the same key la_party is unique on -- so a bank that
  // appears on both a cadastral encumbrance and a register charge is one
  // stakeholder rather than two.
  const parties: LADMParty[] = [];
  const seen = new Set<string>();
  for (const row of rrrs) {
    if (!row.party) continue;
    const key = `${row.party.name} ${row.party.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parties.push(row.party);
  }

  const easements: LADMSpatialUnit[] = raw.easements.map((e) => {
    const out: LADMSpatialUnit = {
      su_id: e.su_id,
      su_type: 'subterranean',
      dimension: '3D',
      source_kind: 'utility',
      provenance: 'estimated',
    };
    if (e.z_min !== null && e.z_max !== null) {
      out.height = heightRange(e.z_min, e.z_max, sep);
    }
    const label = e.label ?? (e.asset_type ? `${e.asset_type} corridor` : null);
    if (label) out.label = e.authority ? `${label} · ${e.authority}` : label;
    return out;
  });

  return {
    su,
    ...(baUnit ? { ba_unit: baUnit } : {}),
    rrrs,
    parties,
    easements,
    project: { slug, name: project?.name ?? slug },
    disclaimer: DISCLAIMER,
    issued_at: new Date().toISOString(),
  };
}
