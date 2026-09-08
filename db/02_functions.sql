-- Geometry + identifier helpers.
--
-- make_prism() builds a closed POLYHEDRALSURFACE Z by hand rather than calling
-- SFCGAL's ST_Extrude, so the pipeline still produces correct solids on a
-- PostGIS build without SFCGAL. SFCGAL is then only needed for ST_3DIntersects,
-- and even that has an exact fallback (see detect_conflicts below).

CREATE OR REPLACE FUNCTION make_prism(poly geometry, z0 double precision, z1 double precision)
RETURNS geometry
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  g     geometry;
  ring  geometry;
  n     int;
  i     int;
  xs    double precision[];
  ys    double precision[];
  faces text[] := '{}';
  face  text;
  srid  int;
BEGIN
  IF poly IS NULL THEN RETURN NULL; END IF;
  srid := ST_SRID(poly);
  g := ST_Force2D(poly);
  IF NOT ST_IsValid(g) THEN g := ST_MakeValid(g); END IF;

  -- MakeValid on a self-touching OSM ring can yield a collection; keep the
  -- largest polygon, which is the building the mapper actually drew.
  IF GeometryType(g) <> 'POLYGON' THEN
    SELECT d.geom INTO g
      FROM (SELECT (ST_Dump(g)).geom AS geom) d
     WHERE GeometryType(d.geom) = 'POLYGON'
     ORDER BY ST_Area(d.geom) DESC
     LIMIT 1;
  END IF;
  IF g IS NULL OR ST_IsEmpty(g) THEN RETURN NULL; END IF;

  ring := ST_ExteriorRing(ST_ForceRHR(g));
  n := ST_NPoints(ring);
  IF n < 4 THEN RETURN NULL; END IF;

  FOR i IN 1..n LOOP
    xs[i] := ST_X(ST_PointN(ring, i));
    ys[i] := ST_Y(ST_PointN(ring, i));
  END LOOP;

  -- floor face (as drawn)
  face := '';
  FOR i IN 1..n LOOP
    face := face || CASE WHEN i > 1 THEN ',' ELSE '' END
                 || xs[i] || ' ' || ys[i] || ' ' || z0;
  END LOOP;
  faces := array_append(faces, '((' || face || '))');

  -- ceiling face (reversed so the surface is consistently oriented outward)
  face := '';
  FOR i IN REVERSE n..1 LOOP
    face := face || CASE WHEN i < n THEN ',' ELSE '' END
                 || xs[i] || ' ' || ys[i] || ' ' || z1;
  END LOOP;
  faces := array_append(faces, '((' || face || '))');

  -- one quad per wall segment
  FOR i IN 1..(n - 1) LOOP
    faces := array_append(faces, '((' ||
        xs[i]     || ' ' || ys[i]     || ' ' || z0 || ',' ||
        xs[i + 1] || ' ' || ys[i + 1] || ' ' || z0 || ',' ||
        xs[i + 1] || ' ' || ys[i + 1] || ' ' || z1 || ',' ||
        xs[i]     || ' ' || ys[i]     || ' ' || z1 || ',' ||
        xs[i]     || ' ' || ys[i]     || ' ' || z0 || '))');
  END LOOP;

  RETURN ST_SetSRID(
           ST_GeomFromText('POLYHEDRALSURFACE Z(' || array_to_string(faces, ',') || ')'),
           srid);
END
$fn$;


-- ULPIN: <state>-<district>-<scheme>-<parcel4>-<bldg3>-<floor2>-<unit2>,
-- right-truncated. Floor codes: '00' ground, '01'..'99' above, 'B1'..'B9'
-- basements. Mirrored byte-for-byte in lib/ulpin.ts.
--
-- The revenue codes come from the project row (projects.state_code,
-- district_code, scheme_code) and are passed in by the caller. They DEFAULT to
-- AP/VSP/3D26, and that default is load-bearing rather than a convenience: a
-- call site that passes only (p, b, f, u) produces exactly the string it
-- produced when the prefix was a literal, which is what keeps every identifier
-- already minted for siripuram -- and every ULPIN in data/api/siripuram/ --
-- byte-identical across this signature change.
-- The four-argument version has to GO, not merely be replaced. CREATE OR
-- REPLACE only matches an identical signature, so on a volume that already has
-- the old function the new one is an OVERLOAD, and `ulpin_fmt(42)` then fails
-- with "function ulpin_fmt(integer) is not unique" -- every call site in
-- build_geometry.sql at once. Dropping first is what makes `npm run db:schema`
-- against an existing volume work rather than half-work.
DROP FUNCTION IF EXISTS ulpin_fmt(int, int, int, int);

CREATE OR REPLACE FUNCTION ulpin_fmt(p int, b int DEFAULT NULL,
                                     f int DEFAULT NULL, u int DEFAULT NULL,
                                     st text DEFAULT 'AP',
                                     di text DEFAULT 'VSP',
                                     sc text DEFAULT '3D26')
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT st || '-' || di || '-' || sc || '-' || lpad(p::text, 4, '0')
    || CASE WHEN b IS NULL THEN '' ELSE '-' || lpad(b::text, 3, '0') END
    || CASE WHEN b IS NULL OR f IS NULL THEN ''
            WHEN f < 0 THEN '-B' || abs(f)::text
            ELSE '-' || lpad(f::text, 2, '0') END
    || CASE WHEN b IS NULL OR f IS NULL OR u IS NULL THEN ''
            ELSE '-' || lpad(u::text, 2, '0') END;
$fn$;


-- True when SFCGAL is available, i.e. ST_3DIntersects can take solids.
CREATE OR REPLACE FUNCTION has_sfcgal() RETURNS boolean
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  PERFORM 1 FROM pg_extension WHERE extname = 'postgis_sfcgal';
  RETURN FOUND;
END
$fn$;


-- Solid-vs-solid test. Uses SFCGAL's ST_3DIntersects when present; otherwise
-- falls back to (2D footprint intersect AND Z-range overlap), which is not an
-- approximation for our geometry -- every solid here is a vertical prism, so
-- the two tests are equivalent.
CREATE OR REPLACE FUNCTION solids_intersect(a geometry, az0 double precision, az1 double precision,
                                            b geometry, bz0 double precision, bz1 double precision)
RETURNS boolean
LANGUAGE plpgsql STABLE AS $fn$
BEGIN
  IF has_sfcgal() THEN
    BEGIN
      -- ST_MakeSolid: without it these are open shells, not volumes.
      RETURN ST_3DIntersects(ST_MakeSolid(a), ST_MakeSolid(b));
    EXCEPTION WHEN OTHERS THEN
      -- fall through to the prism-exact test
    END;
  END IF;
  RETURN ST_Intersects(ST_Force2D(a), ST_Force2D(b))
         AND az0 <= bz1 AND bz0 <= az1;
END
$fn$;


-- ---------------------------------------------------------------------------
-- ULPIN with a TYPED unit slot.
--
-- ulpin_fmt() above takes an integer unit and pads it to two digits, which is
-- right for a flat and cannot express anything else. A level holds more than
-- flats -- parking bays, shops, an atrium, the lift and stair cores -- and the
-- slot says which by carrying a prefix: 'R01' a retail bay, 'P101' a parking
-- slot, 'C01' common space, 'EV' a lift shaft, 'ST' a staircase.
--
-- A SEPARATE FUNCTION, not a widened ulpin_fmt(). Every identifier already
-- minted came out of the four-argument form, and changing that signature again
-- would repeat the overload breakage the DROP above exists to prevent. This
-- one delegates to it for the prefix, so the two cannot drift.
--
-- Mirrors generate() + unitSlot() in lib/ulpin.ts; lib/ulpin.test.ts asserts
-- the pair against fixed expectations.
CREATE OR REPLACE FUNCTION ulpin_fmt_slot(p int, b int, f int, uslot text,
                                          st text DEFAULT 'AP',
                                          di text DEFAULT 'VSP',
                                          sc text DEFAULT '3D26')
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN b IS NULL OR f IS NULL OR uslot IS NULL
      THEN ulpin_fmt(p, b, f, NULL, st, di, sc)
    ELSE ulpin_fmt(p, b, f, NULL, st, di, sc) || '-' || upper(uslot)
  END;
$fn$;


-- The slot a kind writes, e.g. ('retail', 1) -> 'R01', ('elevator', NULL) -> 'EV'.
-- Ordinals below 100 are padded to two digits; above that they are left alone,
-- so a flat numbered 2004 stays '2004' rather than being truncated by lpad().
CREATE OR REPLACE FUNCTION unit_slot(kind text, ordinal int DEFAULT NULL)
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE kind
           WHEN 'flat' THEN ''
           WHEN 'retail' THEN 'R'  WHEN 'anchor' THEN 'R'
           WHEN 'parking' THEN 'P'
           WHEN 'circulation' THEN 'C' WHEN 'atrium' THEN 'C'
           WHEN 'elevator' THEN 'EV' WHEN 'stair' THEN 'ST'
           WHEN 'plant' THEN 'PL'
         END
      || CASE WHEN ordinal IS NULL THEN ''
              WHEN ordinal < 100 THEN lpad(ordinal::text, 2, '0')
              ELSE ordinal::text END;
$fn$;


-- The spatial-unit identifier for a utility run, which has no ULPIN of its
-- own: '<state>-<district>-<scheme>-UTL-<id>'.
--
-- STATED ONCE, here, because ladm_backfill() writes it in two places and
-- suIdForUtility() in lib/ladm.ts has to mint the identical string for the
-- snapshot backend. Three copies of a primary key is three chances to disagree.
--
-- The id is padded to five digits and LEFT ALONE above that. lpad() TRUNCATES
-- a longer string rather than passing it through -- unlike JavaScript's
-- padStart, which only pads up -- so a bare lpad(id, 5, '0') mapped utility
-- 100000 and utility 100001 both onto 'UTL-10000' and the second one violated
-- the primary key. This is the same trap unit_slot() above documents for
-- flat ordinals, and it is the same fix.
CREATE OR REPLACE FUNCTION ladm_utility_su_id(prefix text, id integer)
RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT prefix || '-UTL-'
      || CASE WHEN id < 100000 THEN lpad(id::text, 5, '0') ELSE id::text END;
$fn$;


-- ---------------------------------------------------------- ladm_backfill
-- Project one project's cadastre into the LADM classes.
--
-- SAFE TO RE-RUN, and re-running is how the projection is refreshed after a
-- re-seed. It deletes this project's LADM rows and rebuilds them; it never
-- touches another project's, and it never touches the cadastre it reads.
--
-- IT INVENTS NOTHING. Every party is a name already written on a row, every
-- right is a tenure or encumbrance string already stored, every share is 1/1
-- unless the cadastre says otherwise. Where the register is silent -- a
-- staircase with no holder, a flat whose owner column is NULL -- the
-- projection is silent too, and the panel prints nothing rather than a
-- plausible blank. That is the same rule lib/deed/certificate.ts states for
-- the deed, applied one layer down.
--
-- WHY IT IS A FUNCTION AND NOT A SEED SCRIPT. It reads only from tables, so
-- it works identically after the Python pipeline, after seed_demo_building.mjs
-- and after seed_dutt_retail.mjs, none of which know about each other.
CREATE OR REPLACE FUNCTION ladm_backfill(p_project_id integer)
RETURNS TABLE (parties bigint, spatial_units bigint, ba_units bigint, rrrs bigint)
LANGUAGE plpgsql AS $$
DECLARE
  v_prefix text;
BEGIN
  SELECT state_code || '-' || district_code || '-' || scheme_code
    INTO v_prefix
    FROM projects WHERE id = p_project_id;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'ladm_backfill: no project with id %', p_project_id;
  END IF;

  -- Cascades take la_ba_unit_member and la_rrr with them.
  DELETE FROM la_ba_unit      WHERE project_id = p_project_id;
  DELETE FROM la_spatial_unit WHERE project_id = p_project_id;
  DELETE FROM la_party        WHERE project_id = p_project_id;

  -- ------------------------------------------------------------- parties
  -- Title holders, from the two columns that carry a name.
  INSERT INTO la_party (project_id, name, party_type, role)
  SELECT DISTINCT p_project_id, t.name, 'natural_person', 'owner'
    FROM (
      SELECT p.owner AS name FROM parcel p
       WHERE p.project_id = p_project_id AND p.owner IS NOT NULL AND p.owner <> ''
      UNION
      SELECT u.owner FROM unit u
       JOIN floor f ON f.id = u.floor_id
       JOIN building b ON b.id = f.building_id
       WHERE b.project_id = p_project_id AND u.owner IS NOT NULL AND u.owner <> ''
    ) t
  ON CONFLICT (project_id, name, role) DO NOTHING;

  -- Utility operators. `authority` is an organisation, never a person, which
  -- is why the party_type differs from the block above rather than being
  -- guessed from the shape of the string.
  INSERT INTO la_party (project_id, name, party_type, role, authority_code)
  SELECT DISTINCT p_project_id, u.authority, 'non_natural_person', 'utility_operator',
         CASE
           WHEN u.authority LIKE 'GVMC%'    THEN 'GVMC'
           WHEN u.authority LIKE 'APEPDCL%' THEN 'APEPDCL'
           ELSE NULL
         END
    FROM utility u
   WHERE u.project_id = p_project_id AND u.authority IS NOT NULL AND u.authority <> ''
  ON CONFLICT (project_id, name, role) DO NOTHING;

  -- Banks named in an encumbrance. The two seeders write 'Mortgage - SBI'
  -- and 'Mortgage · HDFC Bank'; both separators are split here so that a
  -- charge resolves to a party rather than staying a sentence. An
  -- encumbrance that names no bank ('Lien - municipal dues') matches
  -- nothing and correctly produces no party.
  INSERT INTO la_party (project_id, name, party_type, role)
  SELECT DISTINCT p_project_id,
         btrim(regexp_replace(u.encumbrance, '^Mortgage\s*[-·]\s*', '')),
         'non_natural_person', 'bank'
    FROM unit u
    JOIN floor f ON f.id = u.floor_id
    JOIN building b ON b.id = f.building_id
   WHERE b.project_id = p_project_id
     AND u.encumbrance ~ '^Mortgage\s*[-·]\s*\S'
  ON CONFLICT (project_id, name, role) DO NOTHING;

  -- ------------------------------------------------------- spatial units
  -- Surface: the curtilage parcels, which carry a real ULPIN. 2D, because
  -- parcel.geom is a Polygon with no Z -- a plot's vertical extent is not
  -- recorded here, and writing 0 would be a claim that it has none.
  INSERT INTO la_spatial_unit
    (su_id, project_id, source_kind, source_id, su_type, dimension, provenance)
  SELECT p.ulpin, p_project_id, 'parcel', p.id, 'surface', '2D', 'derived'
    FROM parcel p WHERE p.project_id = p_project_id;

  -- Surface, from the survey layer -- ONLY where a real survey record was
  -- imported and carries the official 14-digit identifier. The 'derived'
  -- rows scripts/survey_parcels.sql generates are Voronoi shares of a block,
  -- have no survey number, and minting an su_id for them would dress a
  -- derivation up as a register entry.
  INSERT INTO la_spatial_unit
    (su_id, project_id, source_kind, source_id, su_type, dimension, provenance)
  SELECT sp.ulpin_14, p_project_id, 'survey_parcel', sp.id, 'surface', '2D', 'surveyed'
    FROM survey_parcel sp
   WHERE sp.project_id = p_project_id
     AND sp.provenance = 'survey_dept'
     AND sp.ulpin_14 IS NOT NULL
  ON CONFLICT (su_id) DO NOTHING;

  -- Multi-storey: every volume in `unit` -- flats, shops, parking bays, and
  -- the circulation and structural cores too. A lift shaft is a spatial unit
  -- that nobody holds, which LADM expresses precisely; leaving it out would
  -- make the volumes of a building fail to add up.
  INSERT INTO la_spatial_unit
    (su_id, project_id, source_kind, source_id, su_type, dimension,
     z_min, z_max, volume_m3, provenance)
  SELECT u.ulpin, p_project_id, 'unit', u.id, 'multi_storey', '3D',
         u.z_min, u.z_max,
         -- Built area times clear height: the same figure the deed prints.
         u.built_m2 * (u.z_max - u.z_min),
         CASE f.detect_source
           WHEN 'surveyed_plan' THEN 'surveyed'
           WHEN 'osm_tag'       THEN 'derived'
           ELSE 'estimated'
         END
    FROM unit u
    JOIN floor f ON f.id = u.floor_id
    JOIN building b ON b.id = f.building_id
   WHERE b.project_id = p_project_id;

  -- Subterranean: utility corridors. No ULPIN exists for these, so the
  -- identifier is namespaced under the same revenue prefix -- see
  -- suIdForUtility() in lib/ladm.ts, which mints the identical string.
  --
  -- z comes from depth_m +/- radius_m against the building ground the run is
  -- hung off, or against the project's own reference where it is a street
  -- run. A run above ground (a riser, depth_m >= 0) is still registered:
  -- 'subterranean' names the corridor class, not the sign of its z.
  INSERT INTO la_spatial_unit
    (su_id, project_id, source_kind, source_id, su_type, dimension,
     z_min, z_max, volume_m3, provenance)
  SELECT ladm_utility_su_id(v_prefix, u.id),
         p_project_id, 'utility', u.id, 'subterranean', '3D',
         ST_ZMin(u.geom_3d) - u.radius_m,
         ST_ZMax(u.geom_3d) + u.radius_m,
         -- A cylinder along the centreline: pi r^2 L. ST_Length on a
         -- geography gives metres on the ellipsoid, which is what the run
         -- actually measures; ST_Length on the 4326 geometry would give
         -- degrees.
         pi() * u.radius_m * u.radius_m
           * ST_Length(ST_Force2D(u.geom_3d)::geography),
         CASE u.provenance
           WHEN 'surveyed' THEN 'surveyed'
           WHEN 'demonstration' THEN 'derived'
           ELSE 'estimated'
         END
    FROM utility u WHERE u.project_id = p_project_id;

  -- ------------------------------------------------------------ BA units
  -- One BA unit per titled volume, named for the volume itself.
  --
  -- A CONDOMINIUM UNIT, in LADM's sense: a flat or a shop is held absolutely,
  -- and the ground under it is held in common with every other holder in the
  -- building. That is why the flat is the `principal` member and the parcel
  -- joins as an `undivided_share` below rather than as a second holding.
  --
  -- Untitled volumes -- stairs, lifts, plant, atria, circulation, and parking
  -- bays, which are appurtenant rather than separately titled -- get NO BA
  -- unit of their own. They are spatial units held by nobody, and inventing
  -- an administrative record for a staircase would put a holder where the
  -- register has none.
  INSERT INTO la_ba_unit (project_id, ba_ulpin, name, ba_type)
  SELECT p_project_id, u.ulpin || '-BA',
         COALESCE(u.label, initcap(u.kind) || ' ' || u.unit_no),
         'condominium_unit'
    FROM unit u
    JOIN floor f ON f.id = u.floor_id
    JOIN building b ON b.id = f.building_id
   WHERE b.project_id = p_project_id
     AND u.kind IN ('flat','retail','anchor')
     AND u.owner IS NOT NULL AND u.owner <> '';

  -- The titled volume itself.
  INSERT INTO la_ba_unit_member (ba_unit_id, su_id, member_role, share_num, share_den)
  SELECT ba.ba_unit_id, u.ulpin, 'principal', 1, 1
    FROM la_ba_unit ba
    JOIN unit u ON u.ulpin || '-BA' = ba.ba_ulpin
   WHERE ba.project_id = p_project_id;

  -- One BA unit per surface plot that names a holder.
  --
  -- `parcel.owner` is NOT NULL, so in practice this is every plot. A plot is a
  -- holding in its own right -- the flats above it hold an undivided SHARE of
  -- it, which is a different thing and is recorded as a share below -- and
  -- without this a citizen selecting a surface plot would see a spatial unit
  -- with no legal unit behind it, which would read as "unregistered" rather
  -- than "held by the person the cadastre names".
  --
  -- 'basic_administrative_unit', not 'condominium_unit': the ground is held
  -- whole. Only the volumes stacked on it are condominium units.
  INSERT INTO la_ba_unit (project_id, ba_ulpin, name, ba_type)
  SELECT p_project_id, p.ulpin || '-BA', 'Plot ' || p.ulpin, 'basic_administrative_unit'
    FROM parcel p
   WHERE p.project_id = p_project_id AND p.owner IS NOT NULL AND p.owner <> '';

  INSERT INTO la_ba_unit_member (ba_unit_id, su_id, member_role, share_num, share_den)
  SELECT ba.ba_unit_id, p.ulpin, 'principal', 1, 1
    FROM la_ba_unit ba
    JOIN parcel p ON p.ulpin || '-BA' = ba.ba_ulpin
   WHERE ba.project_id = p_project_id;

  -- One BA unit per utility corridor.
  --
  -- A run is not owned, it is EASED: the operator holds a right to occupy a
  -- corridor through ground somebody else holds. LADM has no way to say that
  -- without a BA unit to hang the easement on, so each run gets one, named for
  -- the asset rather than for a plot.
  INSERT INTO la_ba_unit (project_id, ba_ulpin, name, ba_type)
  SELECT p_project_id,
         ladm_utility_su_id(v_prefix, u.id) || '-BA',
         initcap(u.asset_type) || ' corridor ' || COALESCE(u.ref, u.id::text),
         'basic_administrative_unit'
    FROM utility u WHERE u.project_id = p_project_id;

  INSERT INTO la_ba_unit_member (ba_unit_id, su_id, member_role, share_num, share_den)
  SELECT ba.ba_unit_id, s.su_id, 'principal', 1, 1
    FROM la_ba_unit ba
    JOIN la_spatial_unit s ON s.su_id || '-BA' = ba.ba_ulpin
                          AND s.source_kind = 'utility'
   WHERE ba.project_id = p_project_id;

  -- The parking bay on the same title.
  --
  -- MATCHED BY OWNER WITHIN A BUILDING, which is the only link the cadastre
  -- actually records -- there is no allocation table. A bay whose owner
  -- column is NULL (every bay the demo seeder writes, deliberately) joins to
  -- nothing and is left as an unattached spatial unit, which is the honest
  -- answer: the register does not say whose it is.
  INSERT INTO la_ba_unit_member (ba_unit_id, su_id, member_role, share_num, share_den)
  SELECT DISTINCT ba.ba_unit_id, pu.ulpin, 'appurtenant', 1, 1
    FROM la_ba_unit ba
    JOIN unit u   ON u.ulpin || '-BA' = ba.ba_ulpin
    JOIN floor f  ON f.id = u.floor_id
    JOIN unit pu  ON pu.kind = 'parking' AND pu.owner = u.owner
    JOIN floor pf ON pf.id = pu.floor_id AND pf.building_id = f.building_id
   WHERE ba.project_id = p_project_id
  ON CONFLICT DO NOTHING;

  -- The undivided share of the ground.
  --
  -- The denominator is the number of titled volumes in the building, so the
  -- shares of one building's flats sum to exactly 1. This is a DERIVATION,
  -- not a register entry -- no deed in this database states a share -- and
  -- the API and the panel mark it as such. It is here rather than in
  -- TypeScript so that "what fraction of the plot does this flat carry" is
  -- one join for every consumer.
  INSERT INTO la_ba_unit_member (ba_unit_id, su_id, member_role, share_num, share_den)
  SELECT ba.ba_unit_id, p.ulpin, 'undivided_share', 1, cnt.n
    FROM la_ba_unit ba
    JOIN unit u    ON u.ulpin || '-BA' = ba.ba_ulpin
    JOIN floor f   ON f.id = u.floor_id
    JOIN building b ON b.id = f.building_id
    JOIN parcel p  ON p.id = b.parcel_id
    JOIN LATERAL (
      SELECT count(*)::int AS n
        FROM unit u2
        JOIN floor f2 ON f2.id = u2.floor_id
       WHERE f2.building_id = b.id
         AND u2.kind IN ('flat','retail','anchor')
         AND u2.owner IS NOT NULL AND u2.owner <> ''
    ) cnt ON true
   WHERE ba.project_id = p_project_id AND cnt.n > 0
  ON CONFLICT DO NOTHING;

  -- ---------------------------------------------------------------- RRRs
  -- Ownership, from unit.owner and unit.tenure.
  INSERT INTO la_rrr (ba_unit_id, party_id, rrr_class, rrr_type, description)
  SELECT ba.ba_unit_id, pa.party_id, 'right', 'ownership', u.tenure
    FROM la_ba_unit ba
    JOIN unit u ON u.ulpin || '-BA' = ba.ba_ulpin
    JOIN la_party pa ON pa.project_id = p_project_id
                    AND pa.name = u.owner AND pa.role = 'owner'
   WHERE ba.project_id = p_project_id;

  -- Ownership of a surface plot, from parcel.owner. No tenure column exists on
  -- `parcel`, so the description is left NULL rather than filled with the
  -- commonest value found on the flats above it.
  INSERT INTO la_rrr (ba_unit_id, party_id, rrr_class, rrr_type)
  SELECT ba.ba_unit_id, pa.party_id, 'right', 'ownership'
    FROM la_ba_unit ba
    JOIN parcel p ON p.ulpin || '-BA' = ba.ba_ulpin
    JOIN la_party pa ON pa.project_id = p_project_id
                    AND pa.name = p.owner AND pa.role = 'owner'
   WHERE ba.project_id = p_project_id;

  -- The operator's easement over a utility corridor.
  --
  -- A RIGHT, not a restriction, from the operator's side: it is the operator
  -- who holds it. The matching burden on the plots it crosses is a
  -- restriction, and it is NOT recorded here -- which plots a run burdens is a
  -- spatial question this projection would have to answer with a join it
  -- cannot keep current, so the API resolves it per request instead (see
  -- getLadmEasementsFor in lib/db.ts) and says so.
  INSERT INTO la_rrr (ba_unit_id, party_id, rrr_class, rrr_type, description)
  SELECT ba.ba_unit_id, pa.party_id, 'right', 'easement',
         initcap(u.asset_type) || ' corridor, '
           || abs(u.depth_m)::numeric(6,2)
           || CASE WHEN u.depth_m < 0 THEN ' m below ground' ELSE ' m above ground' END
           || ', radius ' || u.radius_m::numeric(6,2) || ' m'
    FROM la_ba_unit ba
    JOIN la_spatial_unit s ON s.su_id || '-BA' = ba.ba_ulpin AND s.source_kind = 'utility'
    JOIN utility u ON u.id = s.source_id
    LEFT JOIN la_party pa ON pa.project_id = p_project_id
                         AND pa.name = u.authority AND pa.role = 'utility_operator'
   WHERE ba.project_id = p_project_id;

  -- A charge, where the encumbrance names a bank.
  INSERT INTO la_rrr (ba_unit_id, party_id, rrr_class, rrr_type, description)
  SELECT ba.ba_unit_id, pa.party_id, 'restriction', 'mortgage', u.encumbrance
    FROM la_ba_unit ba
    JOIN unit u ON u.ulpin || '-BA' = ba.ba_ulpin
    LEFT JOIN la_party pa ON pa.project_id = p_project_id
                         AND pa.role = 'bank'
                         AND pa.name = btrim(regexp_replace(u.encumbrance, '^Mortgage\s*[-·]\s*', ''))
   WHERE ba.project_id = p_project_id
     AND u.encumbrance ~ '^Mortgage\s*[-·]';

  -- Any other encumbrance -- a lien, a pending suit -- as a restriction with
  -- no holder, because the string names a condition rather than a party.
  INSERT INTO la_rrr (ba_unit_id, rrr_class, rrr_type, description)
  SELECT ba.ba_unit_id, 'restriction', 'structural_restriction', u.encumbrance
    FROM la_ba_unit ba
    JOIN unit u ON u.ulpin || '-BA' = ba.ba_ulpin
   WHERE ba.project_id = p_project_id
     AND u.encumbrance IS NOT NULL
     AND u.encumbrance <> 'None'
     AND u.encumbrance !~ '^Mortgage\s*[-·]';

  RETURN QUERY
    SELECT (SELECT count(*) FROM la_party        WHERE project_id = p_project_id),
           (SELECT count(*) FROM la_spatial_unit WHERE project_id = p_project_id),
           (SELECT count(*) FROM la_ba_unit      WHERE project_id = p_project_id),
           (SELECT count(*) FROM la_rrr r JOIN la_ba_unit ba USING (ba_unit_id)
             WHERE ba.project_id = p_project_id);
END
$$;
