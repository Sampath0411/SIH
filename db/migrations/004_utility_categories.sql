-- 004 - widen utility.asset_type to the categories the viewer can draw.
--
-- WHY. lib/underground/categories.ts is the display taxonomy, and it carries
-- three classes the schema has never had a value for: telecom, drainage, and
-- the foundations of a structure. The viewer already renders all three -- the
-- first two from a project's own snapshot, and foundations derived from
-- `building.basements` rather than stored at all -- so nothing on screen
-- depends on this migration.
--
-- What depends on it is REPLACING the demonstration data with a real one. The
-- whole point of keeping lib/underground/layout.ts a display transform over
-- untouched coordinates is that a utility authority's own GIS can be loaded in
-- its place without rewriting the renderer; that is only true if the column
-- those records land in will accept them. This is that column.
--
-- Additive and idempotent, like 001-003: it drops and re-adds one CHECK, which
-- cannot fail on existing rows because every value it accepted before it still
-- accepts.
--
-- 'power' is deliberately KEPT rather than renamed to 'electrical'. The two
-- shipped projects hold 495 rows using it, `categoryOfAssetType` already maps
-- it onto the electrical category, and renaming it would mean rewriting those
-- rows and both committed snapshots to change a label the user never sees.

-- The whole migration is a single transaction. psql's default is auto-commit
-- per statement, and a CHECK that fails on the ADD CONSTRAINT half (a row
-- from a future exporter setting a value the table never allowed) would
-- leave the schema half-migrated: new CHECK gone, columns added, the
-- constraint never reinstated. ON_ERROR_STOP plus BEGIN/COMMIT is the
-- psql-native way to say "stop the script and roll back together". The
-- apply path in scripts/db_schema.mjs runs the file once; a half-applied
-- migration there would surface as the very next test failing for a
-- reason nobody can see in a code review.
\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE utility DROP CONSTRAINT IF EXISTS utility_asset_type_check;

ALTER TABLE utility
  ADD CONSTRAINT utility_asset_type_check
  CHECK (asset_type IN (
    'water',
    'sewer',
    -- What lib/underground/categories.ts calls 'electrical'. See above.
    'power',
    'metro',
    'telecom',
    'drainage',
    'foundation'
  ));

-- Optional attributes a real survey carries and the pipeline's own runs do
-- not. Nullable on purpose, and the DetailPanel renders a row only when the
-- value is present: a pipe whose material was never surveyed must show no
-- material, not a plausible one. Mirrors the nullable owner/address/facing
-- columns on `unit` and the reasoning recorded there.
ALTER TABLE utility ADD COLUMN IF NOT EXISTS ref           text;
ALTER TABLE utility ADD COLUMN IF NOT EXISTS diameter_mm   double precision;
ALTER TABLE utility ADD COLUMN IF NOT EXISTS material      text;
ALTER TABLE utility ADD COLUMN IF NOT EXISTS connected_area text;
ALTER TABLE utility ADD COLUMN IF NOT EXISTS installed_on  date;

-- How the record came to exist. 'estimated' is what scripts/utilities.sql
-- produces -- offsets from OSM road centrelines -- and is therefore the
-- default for every existing row. 'demonstration' says no survey was consulted
-- at all; 'surveyed' is reserved for real utility data, and nothing in this
-- repository sets it.
ALTER TABLE utility ADD COLUMN IF NOT EXISTS provenance text NOT NULL DEFAULT 'estimated';

ALTER TABLE utility DROP CONSTRAINT IF EXISTS utility_provenance_check;
ALTER TABLE utility
  ADD CONSTRAINT utility_provenance_check
  CHECK (provenance IN ('demonstration', 'estimated', 'surveyed'));

COMMIT;

