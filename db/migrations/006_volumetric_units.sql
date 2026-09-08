-- 006: volumetric unit kinds, vertical cores, and the geoid separation.
--
-- Additive and idempotent, like 002-005: safe to run against a volume that
-- already carries data, and a no-op on one that has already had it.
--
-- WHY A `kind` COLUMN RATHER THAN A NEW TABLE. A parking bay, a retail shop, a
-- lift shaft and a flat are the same thing to this schema -- a titled or
-- untitled volume bounded by a level -- and they are already stored perfectly
-- well by `unit`: a PolyhedralSurfaceZ solid with a z range and an ULPIN. What
-- was missing was the ability to say WHICH, so that the viewer can colour a
-- circulation corridor differently from a shop, and so that the panel does not
-- print "Held by: not on record" against a staircase. A parallel table would
-- have duplicated the geometry column, the ULPIN uniqueness, the floor FK and
-- every reader in lib/db.ts, to record one word.
--
-- WHY A CORE IS N ROWS, NOT ONE. `unit.floor_id` is NOT NULL, and that is
-- load-bearing: the viewer's exploded stack and its section cut are both
-- per-level, and they find a unit's geometry through its floor. A lift shaft
-- stored as a single row spanning B2..L20 would detach from the stack the
-- moment the explode slider moved, and the section plane would cut it at one
-- level while leaving it whole at twenty others. So a core is one row per
-- level it passes through, sharing a `core_ref`; the panel groups them back up
-- and reports the span. The identifier says the same thing: every segment of
-- lift core EV1 is `...-<level>-EV`.
BEGIN;

-- ---------------------------------------------------------------- unit kinds
ALTER TABLE unit ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'flat';

-- Dropped first so re-running after a widening does not fail on the old list.
ALTER TABLE unit DROP CONSTRAINT IF EXISTS unit_kind_ck;
ALTER TABLE unit ADD CONSTRAINT unit_kind_ck CHECK (kind IN (
  -- titled volumes
  'flat', 'retail', 'anchor', 'parking',
  -- common and structural volumes, held by nobody
  'circulation', 'atrium', 'elevator', 'stair', 'plant'
));

-- Groups the per-level segments of one vertical core. NULL for everything
-- else, which is why the index below is partial.
ALTER TABLE unit ADD COLUMN IF NOT EXISTS core_ref text;

-- What to call it on screen: 'Slot P-101', 'Anchor Store', 'Public Atrium'.
-- Distinct from unit_no, which stays the short code written on the door.
ALTER TABLE unit ADD COLUMN IF NOT EXISTS label text;

CREATE INDEX IF NOT EXISTS unit_kind_ix ON unit (kind);
CREATE INDEX IF NOT EXISTS unit_core_ix ON unit (core_ref) WHERE core_ref IS NOT NULL;

-- ------------------------------------------------------------ geoid separation
-- EGM96 geoid height above the WGS84 ellipsoid at the project's bbox centre,
-- metres, negative where the geoid sits below the ellipsoid (about -65 m at
-- Visakhapatnam). Written by scripts/dem.py, which already builds the pyproj
-- transformer it needs.
--
-- Every z in this database is ORTHOMETRIC (see projects.elev_datum): dem.py
-- converts CartoDEM's ellipsoidal heights down to EGM96 at ingest. Cesium World
-- Terrain is ellipsoidal. This column is the one number that lets a consumer
-- convert between the two rather than guess, and NULL means "not known" -- never
-- zero, which would be a claim that the two datums coincide.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS geoid_sep_m double precision;

-- ------------------------------------------------------- utility.building_id
-- A run that belongs to ONE BUILDING rather than to a street.
--
-- This column is not new to the application -- UtilityProps has carried
-- `building_id` since the demo tower got its own riser, sewer lateral and
-- tank, and lib/underground/layout.ts reads it to hang those runs off the
-- tower's ground rather than off the street's. It was new to the DATABASE:
-- seed_demo_building.mjs wrote it straight into utilities.json, and
-- utilitiesSql never selected it, so the field existed on the snapshot backend
-- and nowhere else. On PostGIS every consumer saw `undefined`.
--
-- Two things went wrong because of that. The riser was laid out against the
-- street datum instead of its building's. And topology validation could not
-- tell a building's own plumbing from a trespass, so the demo tower was
-- reported as encroaching on itself.
ALTER TABLE utility ADD COLUMN IF NOT EXISTS building_id integer
  REFERENCES building(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS utility_building_ix ON utility (building_id)
  WHERE building_id IS NOT NULL;

COMMIT;
