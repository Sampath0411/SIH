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
