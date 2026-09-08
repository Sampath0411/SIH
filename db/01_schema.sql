-- 3D ULPIN — Vertical Property Mapper
-- LADM-inspired cadastral schema: parcel -> building -> floor -> unit,
-- plus underground utility corridors and the conflicts between them.
--
-- Geometry convention: everything is stored in EPSG:4326 with Z in METRES
-- above the WGS84 ellipsoid-ish local datum. Metric construction happens in
-- EPSG:32644 (UTM 44N) and is transformed back; ST_Transform leaves Z alone,
-- which is exactly the lon/lat/height triple CesiumJS consumes.

CREATE EXTENSION IF NOT EXISTS postgis;

-- SFCGAL powers ST_3DIntersects on solids. It is present in postgis/postgis
-- images, but the app must not hard-fail if it is not, so this is advisory:
-- lib/db + the conflict pass fall back to (2D intersect AND z-range overlap),
-- which is mathematically exact for the vertical prisms we generate.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS postgis_sfcgal;
  RAISE NOTICE 'postgis_sfcgal enabled';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'postgis_sfcgal unavailable (%), falling back to prism-exact 2D+Z conflict test', SQLERRM;
END
$$;

DROP VIEW IF EXISTS la_spatial_unit_v CASCADE;
DROP TABLE IF EXISTS la_rrr, la_ba_unit_member, la_ba_unit, la_spatial_unit,
                     la_party,
                     conflict, utility, unit, floor, building, survey_parcel,
                     parcel, projects CASCADE;

-- ---------------------------------------------------------------- projects
-- One AOI. Everything below is scoped to one of these.
--
-- Parcel NUMBERING is per project: the parcel numbered 0001 exists in every
-- project, and it is the state/district prefix in the ULPIN that keeps the
-- identifiers distinct. That is why state_code and district_code live here
-- rather than in a constant -- see ulpin_fmt() in 02_functions.sql and
-- lib/ulpin.ts, which mirror each other.
--
-- Row IDs are a different thing and stay globally unique, because they are the
-- primary keys the FKs and the API address rows by. scripts/build_geometry.sql
-- therefore computes two numbers per parcel: a per-project ordinal for the
-- ULPIN, and that ordinal plus an offset for the id. For the first project
-- seeded the offset is zero, which is what keeps siripuram's identifiers AND
-- its ids byte-identical to what they have always been.
--
-- floor and unit deliberately carry NO project_id. They reach one through
-- building, and duplicating it would create a second, de-normalised answer to
-- "which project is this floor in" that nothing enforces agreement between.
--
-- Named in the plural, unlike every other table here. That is the one place
-- this schema breaks its own convention, and it is deliberate: "project" is
-- also the name of the per-row concept threaded through the TypeScript, the
-- Python and the CLI, and having the table differ from the type by more than a
-- case fold makes every reference unambiguous.
CREATE TABLE projects (
  id            serial PRIMARY KEY,
  slug          text UNIQUE NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name          text NOT NULL,
  bbox_geom     geometry(Polygon, 4326) NOT NULL,
  state_code    text NOT NULL,
  district_code text NOT NULL,
  scheme_code   text NOT NULL DEFAULT '3D26',
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','generating','ready','failed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Entity counts, written by 05_export_static.py. Denormalised on purpose:
  -- the gallery renders one line of counts per card and must not run seven
  -- COUNT(*) queries per card -- nor need the database at all, since the
  -- committed data/api/projects.json carries the same numbers.
  stats         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Where building.ground_elev came from for this AOI. 'cartodem_v3' when
  -- scripts/dem.py sampled an NRSC CartoDEM tile; 'placeholder' when every
  -- building carries the 12.0 m default. elev_datum names the vertical datum
  -- of the stored values ('msl_egm96': orthometric, EGM96 geoid) or is NULL
  -- for placeholders, which have no datum to speak of.
  elev_source   text NOT NULL DEFAULT 'placeholder'
                CHECK (elev_source IN ('cartodem_v3','placeholder')),
  elev_datum    text,
  -- EGM96 geoid height above the WGS84 ellipsoid at the bbox centre, metres
  -- (about -65 m at Visakhapatnam). NULL means not known, never zero. See
  -- migration 006 and scripts/dem.py.
  geoid_sep_m   double precision,
  -- Optional ISRO Bhuvan WMS overlays: {"lulc": ..., "flood": ..., "cyclone": ...}
  -- layer names. NULL means the viewer offers no "Context (ISRO)" group.
  bhuvan_layers jsonb
);

-- The demo AOI. Present from initdb so the pipeline has a project to seed into
-- and the gallery has a card before anything has been generated.
-- created_at is pinned rather than defaulted to now(): data/api/projects.json
-- is a committed snapshot of this row, and a value that changed with every
-- initdb would make the two disagree about the same project every time the
-- volume was rebuilt. The timestamp is when the demo AOI's data first entered
-- the repository.
INSERT INTO projects (slug, name, bbox_geom, state_code, district_code, status,
                      created_at)
VALUES ('siripuram', 'Siripuram, Visakhapatnam',
        ST_MakeEnvelope(83.3130, 17.7180, 83.3245, 17.7280, 4326),
        'AP', 'VSP', 'ready', '2026-09-01T04:49:47Z');

-- ---------------------------------------------------------------- parcel
CREATE TABLE parcel (
  id         integer PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ulpin      text UNIQUE NOT NULL,
  geom       geometry(Polygon, 4326) NOT NULL,
  area_m2    double precision NOT NULL,
  owner      text NOT NULL
);

-- ------------------------------------------------------- survey_parcel
-- The cadastral parcel layer the 2D GIS view draws, and the place a real
-- survey register lands when one arrives.
--
-- TWO PARCEL TABLES, and the difference is what each is FOR:
--
--   parcel         the curtilage around a cluster of footprints -- a Voronoi
--                  cell trimmed to 7 m of the built form. It is what the 3D
--                  scene's parcels layer and the inset draw, and what
--                  building.parcel_id and the ULPIN hang off. Untouched.
--   survey_parcel  the whole block share: the same Voronoi cell, clipped to
--                  the road corridors and to OSM landuse, so cells tile the
--                  space between the streets the way a cadastral sheet does.
--
-- Both are derived from the same building clusters, so `label` is the SAME
-- per-project ordinal `parcel.ulpin` carries -- AP-VSP-3D26-0042 names one
-- plot whichever table you ask. Dissolving a sliver into its neighbour
-- retires an ordinal rather than renumbering the rest, so the sequence has
-- gaps and that is deliberate: renumbering would move every identifier after
-- the gap on the next re-seed.
--
-- provenance is the whole point of the table:
--
--   'derived'      generated here, from OpenStreetMap. NOT a survey number,
--                  and every string in the interface that names one of these
--                  says so in words.
--   'survey_dept'  loaded from an official file by
--                  scripts/import_survey_parcels.py. Then, and only then, do
--                  ts_no / lpm_no / ulpin_14 / source / source_date carry
--                  anything.
--
-- Those five columns are nullable and empty today. They exist so that the
-- arrival of a real register is an import and a badge flip rather than a
-- schema change -- and so that nothing here is ever tempted to invent a
-- survey number to fill a NOT NULL.
CREATE TABLE survey_parcel (
  id             integer PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- The 4-digit per-project ordinal, e.g. '0042'. Unique within a project;
  -- the state/district prefix is what separates projects, as it does for
  -- parcel.ulpin.
  label          text NOT NULL,
  -- Real survey identifiers. NULL for every derived row, by construction.
  ts_no          text,
  lpm_no         text,
  ulpin_14       text,
  extent_sqm     double precision NOT NULL,
  classification text,
  provenance     text NOT NULL DEFAULT 'derived'
                 CHECK (provenance IN ('derived','survey_dept')),
  -- Who issued the register, and as of when. NULL for derived rows: there is
  -- no issuing authority for a Voronoi cell.
  source         text,
  source_date    date,
  geom           geometry(Polygon, 4326) NOT NULL,
  UNIQUE (project_id, label),
  -- A derived row cannot carry a survey number, and a survey row must say
  -- where it came from. Enforced here rather than in the loader, because the
  -- loader is not the only thing that will ever write this table.
  CONSTRAINT survey_parcel_provenance_ck CHECK (
    (provenance = 'derived'
       AND ts_no IS NULL AND lpm_no IS NULL AND ulpin_14 IS NULL
       AND source IS NULL AND source_date IS NULL)
    OR (provenance = 'survey_dept' AND source IS NOT NULL)
  )
);

-- ---------------------------------------------------------------- building
CREATE TABLE building (
  id            integer PRIMARY KEY,
  project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parcel_id     integer NOT NULL REFERENCES parcel(id) ON DELETE CASCADE,
  -- Which survey parcel the footprint sits in, by largest shared area.
  -- NULLABLE, unlike parcel_id: survey_parcel is built in a later stage than
  -- building, an official import can replace the whole layer under it, and a
  -- building the join cannot place must read as unplaced rather than as
  -- placed somewhere arbitrary. ON DELETE SET NULL for the same reason.
  survey_parcel_id integer REFERENCES survey_parcel(id) ON DELETE SET NULL,
  ulpin         text UNIQUE NOT NULL,
  footprint     geometry(Polygon, 4326) NOT NULL,
  height_m      double precision NOT NULL,
  floors        integer NOT NULL,
  basements     integer NOT NULL DEFAULT 0,
  ground_elev   double precision NOT NULL DEFAULT 12.0,
  -- provenance of ground_elev: 'dsm_dem' when sampled from a DEM raster,
  -- 'placeholder' when it is the 12.0 m default (no raster, or nodata there).
  ground_source text NOT NULL DEFAULT 'placeholder'
                CHECK (ground_source IN ('dsm_dem','placeholder')),
  -- DERIVED local hazard exposure, from the DEM surface and the coastline in
  -- the same tile (scripts/hazard.py). NOT an NRSC product: Bhuvan's flood and
  -- cyclone layers are national-scale and return one polygon over an AOI this
  -- size, which is why a local index exists at all. NULL when no DEM.
  flood_risk    text CHECK (flood_risk IN ('low','moderate','high','severe')),
  cyclone_risk  text CHECK (cyclone_risk IN ('low','moderate','high','severe')),
  flood_score   double precision,
  cyclone_score double precision,
  coast_dist_m  double precision,
  local_relief_m double precision,
  use_type      text NOT NULL,
  -- provenance of height_m/floors. The whole point of the system is being
  -- able to tell a surveyed number from a guessed one.
  height_source text NOT NULL
                CHECK (height_source IN ('osm_tag','estimated','dsm_dem','surveyed_plan')),
  -- True when height_source='surveyed_plan' but the register that supplied it
  -- declared itself synthetic. Without this the UI would present fabricated
  -- demo data as an authoritative survey, which is the exact confusion this
  -- system exists to prevent.
  survey_synthetic boolean NOT NULL DEFAULT false,
  osm_id        bigint,
  name          text,
  address       text
);

-- ---------------------------------------------------------------- floor
CREATE TABLE floor (
  id            integer PRIMARY KEY,
  building_id   integer NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  ulpin         text UNIQUE NOT NULL,
  level_no      integer NOT NULL,          -- negative = basement, 0 = ground
  z_min         double precision NOT NULL,
  z_max         double precision NOT NULL,
  geom          geometry(PolyhedralSurfaceZ, 4326) NOT NULL,
  detect_source text NOT NULL
                CHECK (detect_source IN ('osm_tag','estimated','dsm_dem','surveyed_plan')),
  UNIQUE (building_id, level_no)
);

-- ---------------------------------------------------------------- unit
CREATE TABLE unit (
  id          integer PRIMARY KEY,
  floor_id    integer NOT NULL REFERENCES floor(id) ON DELETE CASCADE,
  ulpin       text UNIQUE NOT NULL,
  unit_no     text NOT NULL,
  geom_3d     geometry(PolyhedralSurfaceZ, 4326) NOT NULL,
  z_min       double precision NOT NULL,
  z_max       double precision NOT NULL,
  carpet_m2   double precision NOT NULL,
  built_m2    double precision NOT NULL,
  tenure      text NOT NULL,               -- Freehold / Leasehold / Rented / Co-operative
  encumbrance text NOT NULL DEFAULT 'None',
  -- WHAT this volume is. A level holds more than flats: parking bays below
  -- grade, shops and an atrium on a commercial ground floor, and the lift and
  -- stair cores running the height of the building. They are all the same
  -- shape to this table -- a solid bounded by a level -- and differ only in
  -- what they are, which is what this column records. See migration 006.
  kind        text NOT NULL DEFAULT 'flat'
              CHECK (kind IN ('flat','retail','anchor','parking',
                              'circulation','atrium','elevator','stair','plant')),
  -- Groups the per-level segments of one vertical core. A lift shaft is one
  -- row per level it passes through, sharing this key, because floor_id is
  -- NOT NULL and the viewer's explode and section are both per-level.
  core_ref    text,
  -- Display name: 'Slot P-101', 'Anchor Store'. unit_no stays the short code.
  label       text,
  -- Who holds the flat, where it is, which way it looks.
  --
  -- Nullable, unlike every column above, because only a surveyed building
  -- has them: the OSM-derived stock has no per-unit register behind it, and
  -- a NOT NULL default would turn "we do not know" into a fact on screen.
  -- The viewer shows a flat with no owner as unknown rather than falling
  -- back to the parcel's owner, which would attribute every flat in a tower
  -- to its developer.
  owner       text,
  address     text,
  facing      text
);

-- ---------------------------------------------------------------- utility
CREATE TABLE utility (
  id          integer PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Widened by migration 004; a fresh volume must start where that left off,
  -- or seeding a telecom/drainage/foundation run fails the CHECK.
  asset_type  text NOT NULL CHECK (asset_type IN ('water','sewer','power','metro',
                                                  'telecom','drainage','foundation')),
  geom_3d     geometry(LineStringZ, 4326) NOT NULL,  -- centreline, drawn as a PolylineVolume
  envelope_3d geometry(PolyhedralSurfaceZ, 4326),    -- solid corridor, used for 3D conflict tests
  depth_m     double precision NOT NULL,             -- negative = below ground
  radius_m    double precision NOT NULL,
  authority   text NOT NULL,
  status      text NOT NULL DEFAULT 'operational',
  -- Set on a run that serves ONE building rather than a street: the demo
  -- tower's riser, its sewer lateral and its tank. Read by
  -- lib/underground/layout.ts to hang the run off that building's ground, and
  -- by topology validation to tell a building's own plumbing from a trespass.
  building_id integer REFERENCES building(id) ON DELETE CASCADE,
  -- Added by migration 004. Every one is optional: a run whose material was
  -- never surveyed shows no material row rather than a plausible one.
  ref            text,
  diameter_mm    double precision,
  material       text,
  connected_area text,
  installed_on   date,
  provenance     text NOT NULL DEFAULT 'estimated'
                 CHECK (provenance IN ('demonstration','estimated','surveyed'))
);

-- ---------------------------------------------------------------- conflict
CREATE TABLE conflict (
  id          serial PRIMARY KEY,
  a_id        integer NOT NULL,
  a_type      text    NOT NULL,
  b_id        integer NOT NULL,
  b_type      text    NOT NULL,
  kind        text    NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

-- ===========================================================================
-- ISO 19152 (LADM) core classes.
--
-- Everything above is the CADASTRE: where things are. Everything below is the
-- REGISTER: who holds them, and under what. The schema has described itself as
-- LADM-inspired since line 2 of this file, and the containment hierarchy
-- really does follow LADM -- but until these five tables there was no LA_Party,
-- no LA_BAUnit and no LA_RRR, so the only join between Flat 901, its parking
-- slot and its share of the ground was that all three carried the same owner
-- STRING. That is not a join: two owners with the same name merge into one,
-- and one owner spelled two ways splits into two.
--
-- See db/migrations/007_ladm.sql to add these to a volume that already has
-- data, and ladm_backfill() in db/02_functions.sql to populate them.
-- ===========================================================================

-- ---------------------------------------------------------------- la_party
-- LA_Party. A stakeholder: a title holder, an owners' association, a municipal
-- body, a utility operator, a bank holding a charge.
--
-- `role` is in the unique key on purpose. GVMC is a municipal body AND a
-- utility operator, and collapsing those into one row would make it impossible
-- to say which capacity a right was granted in.
CREATE TABLE la_party (
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
CREATE TABLE la_ba_unit (
  ba_unit_id serial PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Minted from the principal member's identifier, so a BA unit is
  -- addressable without knowing its serial. UNIQUE rather than the PK: the
  -- FKs below are narrower as an integer, and the string is the public name.
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
-- IT STORES NO GEOMETRY. Migration 006 settled this argument for unit kinds: a
-- parallel table "would have duplicated the geometry column, the ULPIN
-- uniqueness, the floor FK and every reader in lib/db.ts, to record one word".
-- It applies here with more force, because a duplicated PolyhedralSurfaceZ
-- that drifts from its original is a cadastre disagreeing with itself about
-- where a property is. `la_spatial_unit_v` at the foot of this file joins the
-- geometry back on, and there is exactly one copy of it.
--
-- `su_id` is the 3D ULPIN wherever one exists -- for a parcel and for every
-- volume in `unit`. Two kinds have no ULPIN and take a namespaced identifier
-- under the same revenue prefix: a utility run is '<prefix>-UTL-<id>', an
-- air-rights volume '<prefix>-AIR-<site>-<ref>'. lib/ladm.ts states that
-- convention once and lib/ladm.test.ts holds it.
--
-- `source_id` carries NO foreign key, deliberately: it is a polymorphic
-- reference discriminated by `source_kind`, the same shape `conflict` above
-- already uses for a_id/b_id. Four nullable FK columns would leave three NULL
-- on every row and still need a CHECK to say which one was meant. Integrity
-- comes from ladm_backfill(), which deletes and rebuilds the projection.
--
-- WHY project_id IS HERE THOUGH IT IS NOT ON floor OR unit. The rule at the
-- top of this file refuses it there because it "would create a second,
-- de-normalised answer that nothing enforces agreement between". The operative
-- words are the last five: floor and unit are written by hand by three
-- different seeders. This table is a PROJECTION with exactly one writer, which
-- reads the project from the source row every time it runs.
CREATE TABLE la_spatial_unit (
  su_id       text PRIMARY KEY,
  project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind text NOT NULL
              CHECK (source_kind IN ('parcel','survey_parcel','unit','utility')),
  source_id   integer NOT NULL,
  su_type     text NOT NULL
              CHECK (su_type IN ('surface','multi_storey','subterranean','air_rights')),
  -- LADM LA_DimensionType. '2D' for a surface parcel, stored as a Polygon with
  -- no Z, whose vertical extent is genuinely unrecorded -- not zero, which
  -- would assert a plot of no height.
  dimension   text NOT NULL DEFAULT '3D' CHECK (dimension IN ('2D','3D')),
  -- Metres, ORTHOMETRIC (EGM96), like every other z here. See
  -- projects.elev_datum and projects.geoid_sep_m; lib/datum.ts converts to the
  -- ellipsoidal heights Cesium and EPSG:4979 use. NULL together, on a 2D unit.
  z_min       double precision,
  z_max       double precision,
  -- NULL where the source records no area, rather than 0, which would be a
  -- claim that the volume is empty.
  volume_m3   double precision,
  provenance  text NOT NULL DEFAULT 'derived'
              CHECK (provenance IN ('surveyed','derived','estimated')),
  -- One cadastre row registers exactly once.
  UNIQUE (source_kind, source_id),
  CONSTRAINT la_spatial_unit_z_ck CHECK (
    (z_min IS NULL AND z_max IS NULL) OR (z_min IS NOT NULL AND z_max IS NOT NULL)
  )
);

-- ------------------------------------------------------- la_ba_unit_member
-- Which spatial units a BA unit is made of, and on what share.
--
-- THE SHARE LIVES ON THE MEMBERSHIP, not on either side of it. An undivided
-- share of the ground is not a property of the plot (which is whole) nor of
-- the flat (which is wholly owned); it is a property of the relationship
-- between them. Putting it here is what lets one join answer "what fraction of
-- the surface parcel does Flat 901 carry" with no arithmetic in TypeScript.
CREATE TABLE la_ba_unit_member (
  ba_unit_id  integer NOT NULL REFERENCES la_ba_unit(ba_unit_id) ON DELETE CASCADE,
  su_id       text NOT NULL REFERENCES la_spatial_unit(su_id) ON DELETE CASCADE,
  member_role text NOT NULL
              CHECK (member_role IN ('principal','appurtenant','undivided_share')),
  -- Two integers rather than a float, so that 1/3 is exactly 1/3 on the
  -- certificate and the shares of one building sum to 1 without rounding.
  share_num   integer NOT NULL DEFAULT 1 CHECK (share_num >= 0),
  share_den   integer NOT NULL DEFAULT 1 CHECK (share_den > 0),
  PRIMARY KEY (ba_unit_id, su_id)
);

-- ------------------------------------------------------------------ la_rrr
-- LA_RRR. A right, a restriction or a responsibility held against a BA unit.
--
-- One table for all three, as LADM models them, with `rrr_class` saying which.
-- `party_id` is nullable because a restriction often has no holder: a height
-- limit is imposed by a rule, not granted to a person.
--
-- The flat register is NOT here. Mortgages, tax demands and bills stay in
-- data/projects/<slug>/flat-register.json -- lib/db.ts:254-270 explains why: a
-- different record owner, a different update cadence, and one file read on
-- BOTH backends is what stops PostGIS and the snapshot disagreeing about
-- money. lib/ladm.ts PROJECTS those entries into this class on read; the
-- register is not absorbed into the cadastre.
CREATE TABLE la_rrr (
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
  -- LADM's timeSpec. A NULL `to` means "still in force", which is a different
  -- statement from a date in the past.
  time_spec_from date,
  time_spec_to   date,
  amount_inr     double precision,
  -- The loan number, the assessment number, the registered deed number --
  -- whatever the issuing record calls this right. NULL when there is none.
  reference      text,
  description    text
);

-- ---------------------------------------------------------------- indexes
CREATE INDEX projects_bbox_gix  ON projects USING gist (bbox_geom);
CREATE INDEX parcel_geom_gix    ON parcel   USING gist (geom);
CREATE INDEX parcel_project_ix  ON parcel   (project_id);
CREATE INDEX building_project_ix ON building (project_id);
CREATE INDEX utility_project_ix ON utility  (project_id);
CREATE INDEX building_fp_gix    ON building USING gist (footprint);
CREATE INDEX building_parcel_ix ON building (parcel_id);
CREATE INDEX survey_parcel_geom_gix   ON survey_parcel USING gist (geom);
CREATE INDEX survey_parcel_project_ix ON survey_parcel (project_id);
CREATE INDEX building_survey_parcel_ix ON building (survey_parcel_id);
CREATE INDEX floor_geom_gix     ON floor    USING gist (geom);
CREATE INDEX floor_building_ix  ON floor    (building_id);
CREATE INDEX unit_geom_gix      ON unit     USING gist (geom_3d);
CREATE INDEX unit_floor_ix      ON unit     (floor_id);
CREATE INDEX unit_kind_ix       ON unit     (kind);
CREATE INDEX unit_core_ix       ON unit     (core_ref) WHERE core_ref IS NOT NULL;
CREATE INDEX utility_geom_gix   ON utility  USING gist (geom_3d);
CREATE INDEX utility_env_gix    ON utility  USING gist (envelope_3d);
CREATE INDEX utility_building_ix ON utility (building_id) WHERE building_id IS NOT NULL;

CREATE INDEX la_party_project_ix   ON la_party (project_id);
CREATE INDEX la_ba_unit_project_ix ON la_ba_unit (project_id);
CREATE INDEX la_su_project_ix      ON la_spatial_unit (project_id);
CREATE INDEX la_su_source_ix       ON la_spatial_unit (source_kind, source_id);
CREATE INDEX la_su_type_ix         ON la_spatial_unit (su_type);
CREATE INDEX la_member_su_ix       ON la_ba_unit_member (su_id);
CREATE INDEX la_rrr_ba_unit_ix     ON la_rrr (ba_unit_id, rrr_class);
CREATE INDEX la_rrr_party_ix       ON la_rrr (party_id) WHERE party_id IS NOT NULL;

-- THE 3D SPATIAL INDEX.
--
-- unit_geom_gix and utility_env_gix above are ordinary 2-D GiST: PostGIS's
-- default operator class indexes the geometry's PLAN bounding box and discards
-- Z entirely. That is the right index for "which footprints overlap" and the
-- wrong one for "which volumes overlap" -- a basement and a twentieth-floor
-- flat share a footprint and no volume, and a 2-D index hands both to the
-- recheck for solids_intersect() to reject one at a time.
--
-- gist_geometry_ops_nd indexes the n-dimensional box, so Z prunes before the
-- expensive ST_3DIntersects runs. These sit ALONGSIDE the 2-D indexes rather
-- than replacing them: the 2-D questions are still asked, and are still faster
-- on a 2-D index.
CREATE INDEX unit_geom_3d_ndgix ON unit    USING gist (geom_3d gist_geometry_ops_nd);
CREATE INDEX floor_geom_ndgix   ON floor   USING gist (geom gist_geometry_ops_nd);
CREATE INDEX utility_env_ndgix  ON utility USING gist (envelope_3d gist_geometry_ops_nd);

-- ------------------------------------------------------- la_spatial_unit_v
-- The registry with its geometry joined back on.
--
-- Readers select from this, never from la_spatial_unit directly, so that "the
-- registry stores no geometry" costs a consumer nothing. The COALESCE is
-- unambiguous because source_kind makes exactly one join match.
--
-- A utility prefers its envelope over its centreline: the corridor is the
-- spatial unit, and the centreline is where it was drawn from.
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
