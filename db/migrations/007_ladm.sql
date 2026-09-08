-- Migration 007 — the ISO 19152 (LADM) core classes, for a volume that
-- already has data.
--
-- db/01_schema.sql is run by docker-entrypoint-initdb.d on a FRESH volume and
-- already contains everything below. This file exists for the other case: an
-- existing ulpin_pgdata volume you do not want to drop and re-seed. It is
-- additive and idempotent, and it never drops a table or deletes a row.
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/007_ladm.sql
--
-- Running it twice is a no-op. Running it on a fresh volume is also a no-op.
--
-- WHAT THIS IS FOR. This schema has called itself "LADM-inspired" since the
-- first line of 01_schema.sql, and the containment hierarchy really does
-- follow LADM: parcel -> building -> floor -> unit. What it has never had is
-- the half of LADM that the containment hierarchy exists to serve. Rights and
-- holders are flat text on the rows they describe -- parcel.owner,
-- unit.owner, unit.tenure, unit.encumbrance -- so the only join between Flat
-- 901, its parking slot and its share of the ground is that all three carry
-- the same owner STRING. That is not a join. Two owners with the same name
-- merge into one; one owner spelled two ways splits into two.
--
-- These five tables are that missing half: a party is a row, a bundle of
-- holdings is a row, and a right is a row that points at both.
--
-- WHY THE REGISTRY DOES NOT STORE GEOMETRY. `la_spatial_unit` records WHICH
-- existing row is a spatial unit, not a second copy of its shape. Migration
-- 006 already settled this argument for unit kinds: a parallel table "would
-- have duplicated the geometry column, the ULPIN uniqueness, the floor FK and
-- every reader in lib/db.ts, to record one word". The same applies here with
-- more force, because a duplicated PolyhedralSurfaceZ that drifts from its
-- original is a cadastre that disagrees with itself about where a property
-- is. `la_spatial_unit_v` joins the geometry back on, and there is exactly
-- one copy of it.
--
-- WHY project_id IS ON THE REGISTRY THOUGH IT IS NOT ON floor OR unit.
-- 01_schema.sql:44-47 refuses project_id on floor and unit because it "would
-- create a second, de-normalised answer to 'which project is this floor in'
-- that nothing enforces agreement between". The operative words are the last
-- five. floor and unit are written by the seed pipeline, by hand, in several
-- scripts. `la_spatial_unit` is a PROJECTION with exactly one writer --
-- ladm_backfill(), in db/02_functions.sql -- which reads the project from the
-- source row every time it runs. There is no second writer to disagree with,
-- and without the
-- column every scoped LADM query would join unit -> floor -> building to
-- recover a number the projection already knew.
--
-- WHAT IS DELIBERATELY NOT HERE.
--
--   * The flat register. Mortgages, tax demands and bills stay in
--     data/projects/<slug>/flat-register.json. lib/db.ts:254-270 explains
--     why: a different record owner, a different update cadence, and one file
--     read on BOTH backends is what stops PostGIS and the snapshot
--     disagreeing about money. `la_rrr` PROJECTS those entries when it serves
--     them; it does not absorb them.
--
--   * Air rights. Flyover decks and pillars have no row in this database in
--     either backend -- they are file-sourced specs (lib/infra/) so that they
--     render with the database down. `su_type` carries 'air_rights' because
--     the API mints those spatial units from the spec at request time, and a
--     CHECK that rejected the value would make the class unrepresentable.
--
--   * ST_Volume. `volume_m3` is built area times clear height, the same
--     arithmetic lib/deed/certificate.ts already prints on the deed. SFCGAL
--     is advisory in this schema (01_schema.sql:11-23) and must not become a
--     hard dependency, and a second implementation of a number people are
--     handed on a document is exactly what that file was written against.

\set ON_ERROR_STOP on
BEGIN;

-- ---------------------------------------------------------------- la_party
-- LA_Party. A stakeholder: a title holder, an owners' association, a
-- municipal body, a utility operator, a bank holding a charge.
--
-- `party_type` is LADM's LA_PartyType. `role` is ours, and is the reason the
-- unique key includes it: GVMC is a municipal body AND a utility operator,
-- and collapsing those into one row would make it impossible to say which
-- capacity a right was granted in.
CREATE TABLE IF NOT EXISTS la_party (
  party_id       serial PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           text NOT NULL,
  party_type     text NOT NULL DEFAULT 'natural_person'
                 CHECK (party_type IN ('natural_person','non_natural_person','group')),
  role           text NOT NULL
                 CHECK (role IN ('owner','tenant_association','municipal_body',
                                 'utility_operator','bank','surveyor')),
  -- 'GVMC', 'APEPDCL'. NULL for a private person, who has no such code --
  -- never '' or 'N/A', which would read as one that exists and is unknown.
  authority_code text,
  UNIQUE (project_id, name, role)
);

-- -------------------------------------------------------------- la_ba_unit
-- LA_BAUnit. The bundle: the administrative record one legal entity holds.
--
-- This is the row that makes Flat 901, Parking Slot P-102 and an undivided
-- share of the ground ONE holding rather than three coincidences. It carries
-- no geometry of its own; its extent is the union of its members'.
CREATE TABLE IF NOT EXISTS la_ba_unit (
  ba_unit_id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Minted by ladm_backfill from the principal member's identifier, so a BA
  -- unit is addressable without knowing its serial. UNIQUE, not the PK: the
  -- FKs below are narrower as an integer and the string is the public name.
  ba_ulpin   text UNIQUE NOT NULL,
  name       text NOT NULL,
  ba_type    text NOT NULL DEFAULT 'basic_administrative_unit'
             CHECK (ba_type IN ('basic_administrative_unit','condominium_unit')),
  -- The official 14-digit ULPIN (Bhu-Aadhaar) where the survey record carries
  -- one -- survey_parcel.ulpin_14. NULL everywhere else, because this
  -- application does not mint that identifier and must not appear to.
  ulpin_14   text
);

-- --------------------------------------------------------- la_spatial_unit
-- LA_SpatialUnit. WHICH existing row is a spatial unit, and the derived
-- figures LADM asks for that the source row does not carry.
--
-- `su_id` is the identifier, and it is the 3D ULPIN wherever one exists --
-- for a parcel and for every volume in `unit`. Two source kinds have no
-- ULPIN and are given a namespaced identifier under the same revenue prefix:
-- a utility run is '<prefix>-UTL-<id>' and an air-rights volume is
-- '<prefix>-AIR-<site>-<ref>'. lib/ladm.ts states that convention once, in
-- suIdForUtility() and suIdForAirRights(), and lib/ladm.test.ts holds it.
--
-- `source_id` carries NO foreign key, deliberately. It is a polymorphic
-- reference discriminated by `source_kind`, the same shape `conflict`
-- (01_schema.sql:307) already uses for a_id/b_id -- four separate nullable
-- FK columns would leave three of them NULL on every row and would still
-- need a CHECK to say which one was meant. Referential integrity comes from
-- ladm_backfill(), which deletes and rebuilds the projection.
CREATE TABLE IF NOT EXISTS la_spatial_unit (
  su_id       text PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind text NOT NULL
              CHECK (source_kind IN ('parcel','survey_parcel','unit','utility')),
  source_id   integer NOT NULL,
  su_type     text NOT NULL
              CHECK (su_type IN ('surface','multi_storey','subterranean','air_rights')),
  -- LADM LA_DimensionType. '2D' for a surface parcel, which is stored as a
  -- Polygon with no Z and whose vertical extent is genuinely unrecorded --
  -- not zero, which would assert a plot of no height.
  dimension   text NOT NULL DEFAULT '3D' CHECK (dimension IN ('2D','3D')),
  -- Metres, ORTHOMETRIC (EGM96), like every other z in this database. See
  -- projects.elev_datum and projects.geoid_sep_m; lib/datum.ts converts.
  -- NULL together, on a 2D unit.
  z_min       double precision,
  z_max       double precision,
  -- Built area times clear height. NULL where the source row records no area
  -- -- a utility run has a radius, not a footprint -- rather than 0, which
  -- would be a claim that the volume is empty.
  volume_m3   double precision,
  provenance  text NOT NULL DEFAULT 'derived'
              CHECK (provenance IN ('surveyed','derived','estimated')),
  -- One cadastre row registers exactly once.
  UNIQUE (source_kind, source_id),
  CONSTRAINT la_spatial_unit_z_ck CHECK (
    (z_min IS NULL AND z_max IS NULL) OR (z_min IS NOT NULL AND z_max IS NOT NULL)
  )
);

-- ------------------------------------------------------ la_ba_unit_member
-- Which spatial units a BA unit is made of, and on what share.
--
-- THE SHARE LIVES ON THE MEMBERSHIP, not on either side of it. An undivided
-- share of the ground is not a property of the plot (which is whole) nor of
-- the flat (which is wholly owned); it is a property of the relationship
-- between them. Putting `share_num/share_den` here is what lets one query
-- answer "what fraction of the surface parcel does Flat 901 carry" without
-- any arithmetic in TypeScript.
CREATE TABLE IF NOT EXISTS la_ba_unit_member (
  ba_unit_id  integer NOT NULL REFERENCES la_ba_unit(ba_unit_id) ON DELETE CASCADE,
  su_id       text NOT NULL REFERENCES la_spatial_unit(su_id) ON DELETE CASCADE,
  member_role text NOT NULL
              CHECK (member_role IN ('principal','appurtenant','undivided_share')),
  -- A whole holding is 1/1. Kept as two integers rather than a float so that
  -- 1/3 is exactly 1/3 on the certificate, and so the shares of a building
  -- can be summed and checked against 1 without rounding.
  share_num   integer NOT NULL DEFAULT 1 CHECK (share_num >= 0),
  share_den   integer NOT NULL DEFAULT 1 CHECK (share_den > 0),
  PRIMARY KEY (ba_unit_id, su_id)
);

-- ------------------------------------------------------------------ la_rrr
-- LA_RRR. A right, a restriction or a responsibility, held against a BA unit.
--
-- One table for all three, as LADM models them, with `rrr_class` saying
-- which. `party_id` is nullable because a restriction often has no holder:
-- a height limit is imposed by a rule, not granted to a person.
CREATE TABLE IF NOT EXISTS la_rrr (
  rrr_id     serial PRIMARY KEY,
  ba_unit_id integer NOT NULL REFERENCES la_ba_unit(ba_unit_id) ON DELETE CASCADE,
  party_id   integer REFERENCES la_party(party_id) ON DELETE SET NULL,
  rrr_class  text NOT NULL CHECK (rrr_class IN ('right','restriction','responsibility')),
  rrr_type   text NOT NULL
             CHECK (rrr_type IN ('ownership','tenancy','mortgage','easement',
                                 'height_restriction','structural_restriction',
                                 'tax_demand','maintenance')),
  share_num  integer NOT NULL DEFAULT 1 CHECK (share_num >= 0),
  share_den  integer NOT NULL DEFAULT 1 CHECK (share_den > 0),
  -- LADM's timeSpec. NULL `to` means "still in force", which is different
  -- from a date in the past.
  time_spec_from date,
  time_spec_to   date,
  amount_inr     double precision,
  -- The loan number, the assessment number, the registered deed number --
  -- whatever the issuing record calls this right. NULL when there is none.
  reference      text,
  description    text
);

-- ---------------------------------------------------------------- indexes
CREATE INDEX IF NOT EXISTS la_party_project_ix     ON la_party (project_id);
CREATE INDEX IF NOT EXISTS la_ba_unit_project_ix   ON la_ba_unit (project_id);
CREATE INDEX IF NOT EXISTS la_su_project_ix        ON la_spatial_unit (project_id);
CREATE INDEX IF NOT EXISTS la_su_source_ix         ON la_spatial_unit (source_kind, source_id);
CREATE INDEX IF NOT EXISTS la_su_type_ix           ON la_spatial_unit (su_type);
CREATE INDEX IF NOT EXISTS la_member_su_ix         ON la_ba_unit_member (su_id);
CREATE INDEX IF NOT EXISTS la_rrr_ba_unit_ix       ON la_rrr (ba_unit_id, rrr_class);
CREATE INDEX IF NOT EXISTS la_rrr_party_ix         ON la_rrr (party_id) WHERE party_id IS NOT NULL;

-- THE 3D SPATIAL INDEX.
--
-- unit_geom_gix and utility_env_gix already exist, and both are ordinary 2-D
-- GiST: PostGIS's default operator class indexes the geometry's PLAN bounding
-- box and discards Z entirely. That is the right index for "which footprints
-- overlap" and the wrong one for "which volumes overlap", which is the
-- question solids_intersect() and lib/topology.ts actually ask -- a basement
-- and a twentieth-floor flat share a footprint and no volume, and a 2-D index
-- hands both to the recheck.
--
-- gist_geometry_ops_nd indexes the n-dimensional box, so the Z ranges prune
-- before the expensive ST_3DIntersects runs. Added under distinct names
-- ALONGSIDE the 2-D indexes rather than replacing them, because the 2-D
-- questions are still asked and are still faster on a 2-D index.
CREATE INDEX IF NOT EXISTS unit_geom_3d_ndgix
  ON unit USING gist (geom_3d gist_geometry_ops_nd);
CREATE INDEX IF NOT EXISTS floor_geom_ndgix
  ON floor USING gist (geom gist_geometry_ops_nd);
CREATE INDEX IF NOT EXISTS utility_env_ndgix
  ON utility USING gist (envelope_3d gist_geometry_ops_nd);

-- ------------------------------------------------------- la_spatial_unit_v
-- The registry with its geometry joined back on.
--
-- Readers select from this, never from la_spatial_unit directly, so that the
-- "registry does not store geometry" decision costs a consumer nothing. The
-- COALESCE is safe because source_kind makes exactly one join match.
CREATE OR REPLACE VIEW la_spatial_unit_v AS
SELECT s.su_id,
       s.project_id,
       s.source_kind,
       s.source_id,
       s.su_type,
       s.dimension,
       s.z_min,
       s.z_max,
       s.volume_m3,
       s.provenance,
       COALESCE(u.geom_3d, ut.envelope_3d, ut.geom_3d, p.geom, sp.geom) AS geom_3d
  FROM la_spatial_unit s
  LEFT JOIN unit          u  ON s.source_kind = 'unit'          AND u.id  = s.source_id
  LEFT JOIN utility       ut ON s.source_kind = 'utility'       AND ut.id = s.source_id
  LEFT JOIN parcel        p  ON s.source_kind = 'parcel'        AND p.id  = s.source_id
  LEFT JOIN survey_parcel sp ON s.source_kind = 'survey_parcel' AND sp.id = s.source_id;

COMMIT;
-- ladm_backfill() -- which populates all of the above from the cadastre -- is
-- NOT defined here. It lives with the other stored functions, in
-- db/02_functions.sql, beside make_prism() and ulpin_fmt(). That file is
-- entirely CREATE OR REPLACE and is therefore safe to re-apply to a volume
-- with data in it, which is why the function does not need a second copy in
-- this migration -- and a second copy is exactly how two definitions of one
-- projection would come to disagree.
--
-- So, on an existing volume, apply BOTH:
--
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/migrations/007_ladm.sql
--   docker exec -i ulpin-postgis psql -U ulpin -d ulpin -v ON_ERROR_STOP=1 \
--     -f - < db/02_functions.sql
--
-- The second is a no-op for every function that already existed.

\echo '--- migration 007 applied ---'
SELECT p.slug,
       (SELECT count(*) FROM la_spatial_unit WHERE project_id = p.id) AS spatial_units,
       (SELECT count(*) FROM la_ba_unit      WHERE project_id = p.id) AS ba_units,
       (SELECT count(*) FROM la_party        WHERE project_id = p.id) AS parties
  FROM projects p ORDER BY p.id;
\echo 'Run  SELECT * FROM ladm_backfill(<project_id>);  to populate.'
