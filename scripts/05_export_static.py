"""05 - Export the seeded cadastre to static JSON under data/api/<slug>/.

These files are what the route handlers serve when PostGIS is unreachable, so
`npm run dev` alone renders the full app. PostGIS remains the source of truth --
this is a committed snapshot of it, not a parallel implementation.

Everything here is scoped to ONE project, read from the seed_ctx row that
scripts/project.py publishes. A second AOI writes a second directory and
touches nothing in the first.

Two things are written besides the five cadastre files:

  * `projects.stats` on the project's own row, so the gallery can print entity
    counts without running seven COUNT(*) queries per card;
  * `data/api/projects.json`, the committed registry snapshot, which is what
    makes the gallery render -- and the demo project open -- with the database
    down. It is rebuilt from every row in `projects`, not just this one, so
    exporting one project never drops another from the registry.

Geometry note: floors and units are exported as their 2D ring plus z_min/z_max
rather than as POLYHEDRALSURFACE WKT. Cesium extrudes a polygon between two
heights natively, so the ring+extent form is both what the renderer actually
wants and about an order of magnitude smaller on the wire.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg  # noqa: E402
import project as proj  # noqa: E402

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")

# Every query below filters on this. floor and unit have no project_id of their
# own -- they inherit one through building -- so they are scoped by the join
# they already had rather than by a duplicated column.
SCOPE = "(SELECT project_id FROM seed_ctx)"

BUILDINGS = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'aoi', (SELECT name FROM projects WHERE id = {SCOPE}),
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', b.id,
    'geometry', ST_AsGeoJSON(b.footprint, 7)::json,
    'properties', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'ground_source', b.ground_source, 'use_type', b.use_type,
      'flood_risk', b.flood_risk, 'cyclone_risk', b.cyclone_risk,
      'flood_score', b.flood_score, 'cyclone_score', b.cyclone_score,
      'coast_dist_m', b.coast_dist_m, 'local_relief_m', b.local_relief_m,
      'height_source', b.height_source, 'survey_synthetic', b.survey_synthetic, 'name', b.name, 'address', b.address,
      'osm_id', b.osm_id))), '[]'::json))
FROM building b WHERE b.project_id = {SCOPE};
"""

PARCELS = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', p.id,
    'geometry', ST_AsGeoJSON(p.geom, 7)::json,
    'properties', json_build_object(
      'id', p.id, 'ulpin', p.ulpin, 'area_m2', p.area_m2, 'owner', p.owner))), '[]'::json))
FROM parcel p WHERE p.project_id = {SCOPE};
"""

# All columns, plus the count of buildings standing on the parcel -- which the
# 2D panel shows and which the client would otherwise have to derive by scanning
# every footprint. `provenance` and `source` are exported verbatim: the panel
# reads them to decide whether it says "Derived parcel (unofficial)" or names an
# issuing authority, and that decision must be made from the data rather than
# from which endpoint answered.
SURVEY_PARCELS = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', sp.id,
    'geometry', ST_AsGeoJSON(sp.geom, 7)::json,
    'properties', json_build_object(
      'id', sp.id, 'label', sp.label,
      'ts_no', sp.ts_no, 'lpm_no', sp.lpm_no, 'ulpin_14', sp.ulpin_14,
      'extent_sqm', sp.extent_sqm, 'classification', sp.classification,
      'provenance', sp.provenance, 'source', sp.source,
      'source_date', to_char(sp.source_date, 'YYYY-MM-DD'),
      'building_count', (SELECT count(*) FROM building b
                          WHERE b.survey_parcel_id = sp.id),
      -- The relation, carried on THIS side. buildings.json deliberately does
      -- not gain a survey_parcel_id column: its bytes are an invariant of the
      -- repository (see HANDOFF.md, "Snapshot diff") and a scoping column is
      -- not a fact about a building. It has to be readable from one side or
      -- the other, and this is the file that can change.
      'building_ids', COALESCE((SELECT json_agg(b.id ORDER BY b.id)
                                  FROM building b
                                 WHERE b.survey_parcel_id = sp.id), '[]'::json)))
    ORDER BY sp.label), '[]'::json))
FROM survey_parcel sp WHERE sp.project_id = {SCOPE};
"""

UTILITIES = f"""
SELECT json_build_object(
  'type','FeatureCollection',
  'features', COALESCE(json_agg(json_build_object(
    'type','Feature', 'id', u.id,
    'geometry', ST_AsGeoJSON(u.geom_3d, 7)::json,
    'properties', json_build_object(
      'id', u.id, 'asset_type', u.asset_type, 'depth_m', u.depth_m,
      'radius_m', u.radius_m, 'authority', u.authority, 'status', u.status,
      'in_conflict', EXISTS (SELECT 1 FROM conflict c
                              WHERE c.a_type='utility' AND c.a_id = u.id)))), '[]'::json))
FROM utility u WHERE u.project_id = {SCOPE};
"""


# The ISO 19152 (LADM) registry, keyed by spatial-unit identifier.
#
# MIRRORS ladmSql() in lib/db.ts field for field. That function builds this
# same document for ONE su_id at request time against PostGIS; this dumps every
# one of them so the snapshot backend can answer identically with the database
# down. The two must not drift -- a LADM tab that says one thing on Vercel and
# another on a developer's machine is worse than one that says nothing -- so
# when you change one of these queries, change the other.
#
# THE RING IS EXPORTED, unlike floors and units elsewhere in this file. Those
# are drawn by Cesium, which extrudes a polygon between two heights and needs
# only ring + z extent. This document is served as a GeoJSON Feature to
# consumers outside this repository, and a Feature with a null geometry is not
# one. It costs about 120 bytes a row against a detail.json that is already
# 17 MB.
#
# `easements` is the one genuinely expensive part: a spatial join of every
# spatial unit against every utility run. It is bounded by the && bbox
# prefilter, which the 2-D index on utility.geom_3d serves, and it runs once
# per export rather than once per request.
LADM = f"""
SELECT COALESCE(json_object_agg(x.su_id, x.doc), '{{}}'::json) FROM (
  SELECT s.su_id, json_build_object(
    'su', json_build_object(
      'su_id', s.su_id, 'su_type', s.su_type, 'dimension', s.dimension,
      'source_kind', s.source_kind, 'source_id', s.source_id,
      'provenance', s.provenance,
      'z_min', s.z_min, 'z_max', s.z_max, 'volume_m3', s.volume_m3,
      'label', COALESCE(u.label, u.unit_no, 'Plot ' || s.su_id),
      'ring', ST_AsGeoJSON(ladm_plan_geom(s.geom_3d), 7)::json),

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
      FROM la_ba_unit_member pm
      JOIN la_ba_unit ba ON ba.ba_unit_id = pm.ba_unit_id
     WHERE pm.su_id = s.su_id AND pm.member_role = 'principal'
     LIMIT 1),

    'rrrs', COALESCE((
        SELECT json_agg(json_build_object(
                 'rrr_id', r.rrr_id, 'rrr_class', r.rrr_class,
                 'rrr_type', r.rrr_type,
                 'share_num', r.share_num, 'share_den', r.share_den,
                 'time_spec_from', to_char(r.time_spec_from, 'YYYY-MM-DD'),
                 'time_spec_to', to_char(r.time_spec_to, 'YYYY-MM-DD'),
                 'amount_inr', r.amount_inr, 'reference', r.reference,
                 'description', r.description,
                 'party', CASE WHEN pa.party_id IS NULL THEN NULL ELSE
                            json_build_object('party_id', pa.party_id,
                              'name', pa.name, 'party_type', pa.party_type,
                              'role', pa.role,
                              'authority_code', pa.authority_code) END)
               ORDER BY r.rrr_class, r.rrr_id)
          FROM la_ba_unit_member pm
          JOIN la_rrr r ON r.ba_unit_id = pm.ba_unit_id
          LEFT JOIN la_party pa ON pa.party_id = r.party_id
         WHERE pm.su_id = s.su_id AND pm.member_role = 'principal'), '[]'::json),

    'easements', COALESCE((
        SELECT json_agg(json_build_object(
                 'su_id', es.su_id,
                 'label', initcap(ut.asset_type) || ' corridor '
                          || COALESCE(ut.ref, ut.id::text),
                 'z_min', es.z_min, 'z_max', es.z_max,
                 'authority', ut.authority, 'asset_type', ut.asset_type,
                 'description', er.description)
               ORDER BY es.su_id)
          FROM la_spatial_unit es
          JOIN utility ut ON ut.id = es.source_id
          LEFT JOIN la_ba_unit eb ON eb.ba_ulpin = es.su_id || '-BA'
          LEFT JOIN la_rrr er ON er.ba_unit_id = eb.ba_unit_id
                             AND er.rrr_type = 'easement'
         WHERE es.project_id = s.project_id AND es.source_kind = 'utility'
           AND ST_Force2D(ut.geom_3d)
               && ST_Expand(ladm_plan_geom(s.geom_3d), 0.00006)
           AND ST_DWithin(ST_Force2D(ut.geom_3d)::geography,
                          ladm_plan_geom(s.geom_3d)::geography, ut.radius_m)
           AND (s.z_min IS NULL
                OR (es.z_min <= s.z_max AND s.z_min <= es.z_max))), '[]'::json)
  ) AS doc
  FROM la_spatial_unit_v s
  LEFT JOIN unit u ON s.source_kind = 'unit' AND u.id = s.source_id
  WHERE s.project_id = {SCOPE}
) x;
"""

CONFLICTS = f"""
SELECT COALESCE(json_agg(json_build_object(
  'id', c.id, 'kind', c.kind, 'detected_at', c.detected_at,
  'utility_id', u.id, 'asset_type', u.asset_type, 'authority', u.authority,
  'status', u.status, 'depth_m', u.depth_m,
  'floor_id', f.id, 'floor_ulpin', f.ulpin, 'level_no', f.level_no,
  'building_id', b.id, 'building_ulpin', b.ulpin, 'building_name', b.name)
  ORDER BY c.id), '[]'::json)
FROM conflict c
JOIN utility u  ON u.id = c.a_id
JOIN floor f    ON f.id = c.b_id
JOIN building b ON b.id = f.building_id
WHERE b.project_id = {SCOPE};
"""

DETAIL = f"""
SELECT COALESCE(json_object_agg(s.id, s.doc), '{{}}'::json) FROM (
  SELECT b.id, json_build_object(
    'building', json_build_object(
      'id', b.id, 'ulpin', b.ulpin, 'parcel_id', b.parcel_id,
      'height_m', b.height_m, 'floors', b.floors, 'basements', b.basements,
      'ground_elev', b.ground_elev, 'ground_source', b.ground_source, 'use_type', b.use_type,
      'flood_risk', b.flood_risk, 'cyclone_risk', b.cyclone_risk,
      'flood_score', b.flood_score, 'cyclone_score', b.cyclone_score,
      'coast_dist_m', b.coast_dist_m, 'local_relief_m', b.local_relief_m,
      'height_source', b.height_source, 'survey_synthetic', b.survey_synthetic, 'name', b.name, 'address', b.address,
      'osm_id', b.osm_id,
      'footprint', ST_AsGeoJSON(b.footprint, 7)::json),
    'parcel', (SELECT json_build_object(
        'id', p.id, 'ulpin', p.ulpin, 'area_m2', p.area_m2, 'owner', p.owner,
        'geometry', ST_AsGeoJSON(p.geom, 7)::json)
      FROM parcel p WHERE p.id = b.parcel_id),
    'floors', COALESCE((SELECT json_agg(json_build_object(
        'id', f.id, 'ulpin', f.ulpin, 'level_no', f.level_no,
        'z_min', f.z_min, 'z_max', f.z_max, 'detect_source', f.detect_source,
        'ring', ST_AsGeoJSON(ST_Force2D(b.footprint), 7)::json)
        ORDER BY f.level_no)
      FROM floor f WHERE f.building_id = b.id), '[]'::json),
    'units', COALESCE((SELECT json_agg(json_build_object(
        'id', un.id, 'floor_id', un.floor_id, 'ulpin', un.ulpin,
        'unit_no', un.unit_no, 'z_min', un.z_min, 'z_max', un.z_max,
        'carpet_m2', un.carpet_m2, 'built_m2', un.built_m2,
        'tenure', un.tenure, 'encumbrance', un.encumbrance,
        -- owner/address/facing are NULL for every OSM-derived unit and set
        -- only on the surveyed demo tower. They were missing here while
        -- seed_demo_building.mjs wrote them straight into detail.json, so a
        -- re-export silently dropped them and every flat lost its owner.
        'owner', un.owner, 'address', un.address, 'facing', un.facing,
        -- What the volume is, and the vertical core it belongs to.
        'kind', un.kind, 'core_ref', un.core_ref, 'label', un.label,
        'level_no', f2.level_no,
        'ring', ST_AsGeoJSON(ST_Force2D(ST_GeometryN(un.geom_3d, 1)), 7)::json)
        ORDER BY f2.level_no, un.unit_no)
      FROM unit un JOIN floor f2 ON f2.id = un.floor_id
      WHERE f2.building_id = b.id), '[]'::json)
  ) AS doc
  FROM building b WHERE b.project_id = {SCOPE}
) s;
"""

# Rebuilt from every row, so exporting one project never drops another from
# the registry the gallery reads with the database down.
REGISTRY = """
SELECT json_build_object('projects', COALESCE(json_agg(json_build_object(
  'slug', p.slug,
  'name', p.name,
  'bbox', json_build_array(ST_XMin(p.bbox_geom), ST_YMin(p.bbox_geom),
                           ST_XMax(p.bbox_geom), ST_YMax(p.bbox_geom)),
  'state_code', p.state_code,
  'district_code', p.district_code,
  'scheme_code', p.scheme_code,
  'status', p.status,
  'elev_source', p.elev_source,
  'elev_datum', p.elev_datum,
  'geoid_sep_m', p.geoid_sep_m,
  'bhuvan_layers', p.bhuvan_layers,
  'created_at', to_char(p.created_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'stats', CASE WHEN p.stats = '{}'::jsonb THEN NULL ELSE p.stats END)
  ORDER BY p.created_at, p.id), '[]'::json))
FROM projects p;
"""

STATS = f"""
SELECT json_build_object(
  'buildings', (SELECT count(*) FROM building WHERE project_id = {SCOPE}),
  'parcels',   (SELECT count(*) FROM parcel   WHERE project_id = {SCOPE}),
  'survey_parcels', (SELECT count(*) FROM survey_parcel WHERE project_id = {SCOPE}),
  'floors',    (SELECT count(*) FROM floor f JOIN building b ON b.id = f.building_id
                 WHERE b.project_id = {SCOPE}),
  'units',     (SELECT count(*) FROM unit u JOIN floor f ON f.id = u.floor_id
                 JOIN building b ON b.id = f.building_id
                 WHERE b.project_id = {SCOPE}),
  'utilities', (SELECT count(*) FROM utility WHERE project_id = {SCOPE}),
  'conflicts', (SELECT count(*) FROM conflict c JOIN utility u ON u.id = c.a_id
                 WHERE u.project_id = {SCOPE}));
"""


def dump(out_dir, name, sql):
    os.makedirs(out_dir, exist_ok=True)
    raw = pg.scalar(sql)
    if not raw:
        raise SystemExit(f"export {name}: query returned nothing")
    obj = json.loads(raw)
    path = os.path.join(out_dir, name)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    size = os.path.getsize(path) / 1024.0
    n = len(obj["features"]) if isinstance(obj, dict) and "features" in obj else len(obj)
    print(f"  {name:<18} {n:>6} entries  {size:>8.0f} KB")
    return obj


def street_count(out_dir):
    """Streets are a build artefact, not a table -- see lib/db.ts getRoads().

    Counted from the file rather than queried, and reported as 0 when
    scripts/build_roads.mjs has not run for this project yet.
    """
    path = os.path.join(out_dir, "roads.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return len(json.load(fh).get("features", []))
    except (OSError, ValueError):
        return 0


def main():
    p = proj.parse_args()
    proj.make_seed_ctx(p)
    out = p.api_dir
    print(f"exporting static snapshots -> data/api/{p.slug}/")

    dump(out, "buildings.json", BUILDINGS)
    dump(out, "parcels.json", PARCELS)
    dump(out, "survey_parcels.json", SURVEY_PARCELS)
    dump(out, "utilities.json", UTILITIES)
    dump(out, "conflicts.json", CONFLICTS)
    dump(out, "detail.json", DETAIL)
    # Skipped, not fatal, when the LADM tables are absent: a volume that
    # predates migration 007 still exports every other file, and the LADM
    # tab reports that this project has no registry rather than the whole
    # export failing over a table the pipeline does not otherwise need.
    try:
        dump(out, "ladm.json", LADM)
    except Exception as exc:  # noqa: BLE001 -- see above
        print(f"  ladm.json         skipped ({exc})")

    stats = json.loads(pg.scalar(STATS))
    stats["streets"] = street_count(out)
    proj.write_stats(p, stats)
    # Only now: a project is 'ready' when there is something to read, not when
    # the pipeline started.
    proj.set_status(p, "ready")

    registry_path = os.path.join(DATA, "api", "projects.json")
    registry = json.loads(pg.scalar(REGISTRY))
    # Merge with any project rows the database does not know about.
    # vizag-infra is a snapshot-only project (no `projects` row), but
    # an `npm run seed` of a different project would otherwise delete
    # it from the registry, and the gallery would no longer render it.
    # Snapshot-only rows carry the `aoi` field that the building
    # registry merges in (see scripts/build_vizag_infra.mjs), so any
    # already-present row keeps its extras through the merge.
    existing = {}
    if os.path.exists(registry_path):
        try:
            with open(registry_path, "r", encoding="utf-8") as fh:
                for row in json.load(fh).get("projects", []):
                    existing[row["slug"]] = row
        except (OSError, json.JSONDecodeError):
            existing = {}
    for row in registry["projects"]:
        existing[row["slug"]] = {**existing.get(row["slug"], {}), **row}
    merged = {"projects": list(existing.values())}
    with open(registry_path, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2)
        fh.write("\n")
    print(f"  {'projects.json':<18} {len(merged['projects']):>6} project(s)")
    print("  stats: " + ", ".join(f"{k}={v}" for k, v in sorted(stats.items())))
    print("done")


if __name__ == "__main__":
    main()
