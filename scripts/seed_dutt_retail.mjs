#!/usr/bin/env node
// scripts/seed_dutt_retail.mjs
//
// Give Dutt Island (building 5392) a real ground-floor retail plan.
//
// WHAT WAS THERE. The main pipeline subdivides every above-ground level of a
// commercial building with unit_cells(footprint, 3, 1) -- three parallel
// slices of the whole plate, numbered A01/A02/A03, identical on every storey.
// That is a reasonable default for 384 OSM buildings nobody has surveyed, and
// it is not a shopping floor: it has no shopfronts, no atrium, no way through,
// and selecting level G showed three anonymous slabs.
//
// WHAT THIS WRITES. Level G only: eight retail bays and an anchor store either
// side of a central circulation spine, a public atrium across the middle, and
// an escalator/lift corridor beside it. Levels 1-8 keep the pipeline's cells,
// because nothing here knows what is on them and inventing eight more floors
// of shops would be presenting a guess as a survey.
//
// THE THREE GENERIC CELLS ON LEVEL G ARE REPLACED, which retires the
// identifiers AP-VSP-3D26-0165-001-00-01 .. -03. They named volumes that no
// longer exist; the bays that replace them are minted as -00-R01 .. -R09 and
// the common space as -00-C01 .. -C04.
//
// GEOMETRY. Dutt Island's footprint is a real OSM way -- seven vertices, and
// convex, which is checked at run time rather than assumed. Every bay is cut
// from that polygon by successive half-plane clips (clipRingToHalfPlane, the
// same Sutherland-Hodgman the section view uses), so a bay is always exactly
// the footprint restricted to its band and never a rectangle poking out
// through a wall. The bands are laid out along the building's own principal
// axis, found with orientedDims, so the plan follows the building rather than
// north.
//
// Run with:  npm run seed:dutt
// Idempotent: re-running rewrites the same rows with the same ids.
//
// OUTPUT
//   Patches data/api/siripuram/detail.json    (level G units of building 5392)
//   Patches data/api/projects.json            (recounts project stats)
//   Upserts the same units into PostGIS, when DATABASE_URL is reachable

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipRingToHalfPlane, ringCentroid } from '../lib/geo.ts';
import { generate, unitSlot } from '../lib/ulpin.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'data', 'api', 'siripuram');
const PROJECTS = path.join(ROOT, 'data', 'api', 'projects.json');

const SLUG = 'siripuram';
const BUILDING_ID = 5392;
const PARCEL_NO = 165;      // AP-VSP-3D26-0165
const BUILDING_NO = 1;
const LEVEL = 0;

/**
 * Well clear of the exporter's range, for the reason seed_demo_building.mjs
 * records at length: the pipeline's largest unit id is around 127k, the demo
 * tower occupies 990000-990166, and a fresh block must not land on either.
 */
const UNIT_ID_BASE = 995000;

/** Vertical inset inside the storey, matching build_geometry.sql's units. */
const Z_BOTTOM_INSET = 0.15;
const Z_TOP_INSET = 0.35;

// ---------------------------------------------------------------------------
// The plan.
//
// Bands run along the building's principal axis, expressed as fractions of its
// length (u) and of its width (v), with v = 0 on the axis itself. The spine is
// the strip |v| <= SPINE_HALF; shops sit outside it on both sides.
// ---------------------------------------------------------------------------

/** Half-width of the central circulation spine, as a fraction of the width. */
const SPINE_HALF = 0.09;
/** Half-width of the atrium where it opens out. */
const ATRIUM_HALF = 0.30;

/**
 * The bands, in order along the axis.
 *
 * `shops` bands are split into equal bays either side of the spine; `full`
 * bands take the whole width. The atrium is a `full` band so the plan reads as
 * a mall with a middle rather than as two rows of boxes.
 */
const BANDS = [
  { kind: 'shops', u0: 0.02, u1: 0.30, bays: 2 },
  { kind: 'atrium', u0: 0.30, u1: 0.46 },
  { kind: 'escalator', u0: 0.46, u1: 0.54 },
  { kind: 'shops', u0: 0.54, u1: 0.80, bays: 2 },
  { kind: 'anchor', u0: 0.80, u1: 0.98 },
];

// ---------------------------------------------------------------------------
// Geometry helpers.
// ---------------------------------------------------------------------------

/**
 * The principal axis of a ring, as a unit vector in the local metric frame.
 *
 * orientedDims() reports the axis as an angle in degrees and normalises it so
 * the LONGER extent is always called "length", which is what the panel wants
 * and not what a layout does -- rotating the plan by 90 degrees would put the
 * spine across the building instead of along it. So the eigenvector is
 * recomputed here from the same covariance, and the extents are measured
 * rather than inferred.
 */
function principalFrame(ring) {
  const { lon: cLon, lat: cLat } = ringCentroid(ring);
  const mPerDegLat = 110574;
  const mPerDegLon = 111320 * Math.cos((cLat * Math.PI) / 180);
  const n = Math.max(1, ring.length - 1);

  let sxx = 0; let sxy = 0; let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (ring[i][0] - cLon) * mPerDegLon;
    const y = (ring[i][1] - cLat) * mPerDegLat;
    sxx += x * x; sxy += x * y; syy += y * y;
  }
  sxx /= n; sxy /= n; syy /= n;

  let theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ext = (t) => {
    let lo = Infinity; let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const x = (ring[i][0] - cLon) * mPerDegLon;
      const y = (ring[i][1] - cLat) * mPerDegLat;
      const p = x * Math.cos(t) + y * Math.sin(t);
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    return [lo, hi];
  };
  // Take whichever of the two principal directions is actually the longer one.
  const [al, ah] = ext(theta);
  const [bl, bh] = ext(theta + Math.PI / 2);
  if (bh - bl > ah - al) theta += Math.PI / 2;

  const [uMin, uMax] = ext(theta);
  const [vMin, vMax] = ext(theta + Math.PI / 2);
  return {
    cLon, cLat, mPerDegLon, mPerDegLat,
    ux: Math.cos(theta), uy: Math.sin(theta),
    vx: -Math.sin(theta), vy: Math.cos(theta),
    uMin, uMax, vMin, vMax,
  };
}

/**
 * A half-plane in lon/lat, keeping points on the side the normal points AWAY
 * from -- the convention clipRingToHalfPlane uses (it keeps d <= 0, where d is
 * measured along the normal from the anchor point).
 *
 * `axis` is 'u' or 'v'; `at` is the coordinate of the cut in metres; `keep` is
 * -1 to keep the lower side and +1 the upper.
 */
function halfPlane(fr, axis, at, keep) {
  const dx = axis === 'u' ? fr.ux : fr.vx;
  const dy = axis === 'u' ? fr.uy : fr.vy;
  // Anchor: the point on the axis at distance `at` from the centroid.
  const ax = dx * at;
  const ay = dy * at;
  return {
    lon: fr.cLon + ax / fr.mPerDegLon,
    lat: fr.cLat + ay / fr.mPerDegLat,
    nx: dx * keep,
    ny: dy * keep,
  };
}

/** Clip a ring by a list of half-planes, returning [] if nothing survives. */
function clipAll(ring, planes) {
  let out = ring;
  for (const p of planes) {
    out = clipRingToHalfPlane(out, p);
    if (out.length < 4) return [];
  }
  return out;
}

/** Shoelace area of a lon/lat ring, in m². */
function areaM2(ring, fr) {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const x0 = (ring[i][0] - fr.cLon) * fr.mPerDegLon;
    const y0 = (ring[i][1] - fr.cLat) * fr.mPerDegLat;
    const x1 = (ring[i + 1][0] - fr.cLon) * fr.mPerDegLon;
    const y1 = (ring[i + 1][1] - fr.cLat) * fr.mPerDegLat;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** True when a closed ring is convex; the clip approach assumes it. */
function isConvex(ring, fr) {
  const pts = ring.slice(0, -1).map(([lon, lat]) => [
    (lon - fr.cLon) * fr.mPerDegLon, (lat - fr.cLat) * fr.mPerDegLat,
  ]);
  let sign = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Build the plan.
// ---------------------------------------------------------------------------

/** Interpolate a fraction of the axis extent to metres. */
const lerp = (lo, hi, t) => lo + (hi - lo) * t;

function buildPlan(footprint, floorRow) {
  const ring = footprint.coordinates[0];
  const fr = principalFrame(ring);
  if (!isConvex(ring, fr)) {
    throw new Error(
      'Dutt Island footprint is no longer convex; the half-plane clip below '
      + 'would cut bays outside the building. Re-cut the plan with a real '
      + 'polygon clipper before trusting this output.',
    );
  }

  const uAt = (t) => lerp(fr.uMin, fr.uMax, t);
  const vAt = (t) => lerp(fr.vMin, fr.vMax, 0.5 + t);   // t is +-fraction of width
  const zMin = floorRow.z_min + Z_BOTTOM_INSET;
  const zMax = floorRow.z_max - Z_TOP_INSET;

  /**
   * Candidates, collected before they are numbered.
   *
   * NUMBERING HAPPENS AFTER CLIPPING, and that is the point of the two passes.
   * Dutt Island tapers to the south-west, so the outermost bay on the narrow
   * side clips away to nothing. Numbering as we cut left a plan whose first
   * shop was G-02 and whose signage would have had a hole in it. The bays that
   * survive are numbered in order along the parade, so the sequence is always
   * contiguous however the bands happen to fall on the polygon.
   */
  const cand = [];

  const push = (kind, unit_no, label, planes, tenure, sortKey) => {
    const cut = clipAll(ring, planes);
    if (cut.length < 4) return;
    const a = areaM2(cut, fr);
    if (a < 4.0) return;               // same sliver floor as unit_cells()
    cand.push({ kind, unit_no, label, tenure, area: a, ring: cut, sortKey });
  };

  for (const band of BANDS) {
    const lo = halfPlane(fr, 'u', uAt(band.u0), -1);   // keep u >= u0
    const hi = halfPlane(fr, 'u', uAt(band.u1), +1);   // keep u <= u1
    const mid = (band.u0 + band.u1) / 2;

    if (band.kind === 'anchor') {
      // Sorted last among the bays whatever its position on the axis, because
      // an anchor store is the end of the parade by definition.
      push('anchor', null, 'Anchor Store', [lo, hi], 'Leasehold', 1e9);
      continue;
    }

    if (band.kind === 'atrium') {
      push('atrium', 'ATRIUM', 'Public Atrium',
        [lo, hi,
          halfPlane(fr, 'v', vAt(-ATRIUM_HALF), -1),
          halfPlane(fr, 'v', vAt(+ATRIUM_HALF), +1)],
        'Common area', mid);
      continue;
    }

    if (band.kind === 'escalator') {
      push('circulation', 'ESC', 'Escalator & Lift Corridor',
        [lo, hi,
          halfPlane(fr, 'v', vAt(-ATRIUM_HALF), -1),
          halfPlane(fr, 'v', vAt(+ATRIUM_HALF), +1)],
        'Common area', mid);
      continue;
    }

    // A shops band: bays either side of the spine, then the spine itself.
    // Sorted up one side of the parade and back down the other, which is the
    // order the numbers would be walked on the ground.
    for (const side of [+1, -1]) {
      for (let i = 0; i < band.bays; i += 1) {
        const t0 = lerp(band.u0, band.u1, i / band.bays);
        const t1 = lerp(band.u0, band.u1, (i + 1) / band.bays);
        push('retail', null, null,
          [
            halfPlane(fr, 'u', uAt(t0), -1),
            halfPlane(fr, 'u', uAt(t1), +1),
            // Outboard of the spine on this side.
            side > 0
              ? halfPlane(fr, 'v', vAt(+SPINE_HALF), -1)
              : halfPlane(fr, 'v', vAt(-SPINE_HALF), +1),
          ],
          'Leasehold', (side > 0 ? 0 : 1e6) + (t0 + t1) / 2);
      }
    }
    push('circulation', 'PASS', 'Central Circulation Passage',
      [lo, hi,
        halfPlane(fr, 'v', vAt(-SPINE_HALF), -1),
        halfPlane(fr, 'v', vAt(+SPINE_HALF), +1)],
      'Common area', mid);
  }

  // ---- second pass: number what actually survived the clip ---------------
  const bays = cand
    .filter((c) => c.kind === 'retail' || c.kind === 'anchor')
    .sort((a, b) => a.sortKey - b.sortKey);

  // The atrium leads the common spaces -- it is the one a visitor names --
  // then the escalator corridor, then the passages in axis order.
  const commonRank = (c) => (c.kind === 'atrium' ? 0 : c.unit_no === 'ESC' ? 1 : 2);
  const commons = cand
    .filter((c) => c.kind === 'atrium' || c.kind === 'circulation')
    .sort((a, b) => commonRank(a) - commonRank(b) || a.sortKey - b.sortKey);

  const out = [];
  let id = UNIT_ID_BASE;
  const emit = (c, ordinal) => {
    const isBay = c.kind === 'retail' || c.kind === 'anchor';
    const code = `G-${String(ordinal).padStart(2, '0')}`;
    out.push({
      id: id++,
      floor_id: floorRow.id,
      ulpin: generate(PARCEL_NO, BUILDING_NO, LEVEL, unitSlot(c.kind, ordinal)),
      unit_no: isBay ? code : c.unit_no,
      level_no: LEVEL,
      z_min: zMin,
      z_max: zMax,
      // Carpet is the lettable area inside the shopfront; the pipeline uses
      // 0.78 of the cell for the same reason and this stays consistent with it.
      carpet_m2: Math.round(c.area * 0.78 * 100) / 100,
      built_m2: Math.round(c.area * 100) / 100,
      tenure: c.tenure,
      encumbrance: 'None',
      kind: c.kind,
      label: c.label ?? (c.kind === 'anchor' ? 'Anchor Store' : `Shop ${code}`),
      ring: { type: 'Polygon', coordinates: [c.ring] },
    });
  };
  bays.forEach((c, i) => emit(c, i + 1));
  commons.forEach((c, i) => emit(c, i + 1));
  return out;
}

// ---------------------------------------------------------------------------
// Snapshot half.
// ---------------------------------------------------------------------------

/** Read JSON, remembering whether the file was pretty-printed. */
async function readJson(p) {
  const raw = await fs.readFile(p, 'utf8');
  return { value: JSON.parse(raw), pretty: /^\s*[[{]\s*\n/.test(raw) };
}

async function writeJson(p, { value, pretty }) {
  await fs.writeFile(p, pretty
    ? `${JSON.stringify(value, null, 2)}\n`
    : JSON.stringify(value), 'utf8');
}

async function main() {
  const detailPath = path.join(API, 'detail.json');
  const detail = await readJson(detailPath);
  const doc = detail.value[String(BUILDING_ID)];
  if (!doc) {
    console.error(`detail.json has no building ${BUILDING_ID}; run the main seed first.`);
    process.exitCode = 1;
    return;
  }

  const floorRow = doc.floors.find((f) => f.level_no === LEVEL);
  if (!floorRow) {
    console.error(`building ${BUILDING_ID} has no level ${LEVEL}.`);
    process.exitCode = 1;
    return;
  }

  const plan = buildPlan(doc.building.footprint, floorRow);

  // Replace level G wholesale; every other level keeps the pipeline's cells.
  const kept = doc.units.filter((u) => u.level_no !== LEVEL);
  const replaced = doc.units.length - kept.length;
  doc.units = [...kept, ...plan].sort(
    (a, b) => a.level_no - b.level_no || a.unit_no.localeCompare(b.unit_no, 'en'),
  );
  await writeJson(detailPath, detail);

  // Recount, never increment: the stats are a count of what is there now, and
  // incrementing them is how they drifted before (see seed_demo_building.mjs).
  const projects = await readJson(PROJECTS);
  const list = Array.isArray(projects.value) ? projects.value : projects.value.projects;
  const row = list.find((p) => p.slug === SLUG);
  if (row?.stats) {
    let units = 0;
    for (const d of Object.values(detail.value)) units += d.units.length;
    row.stats.units = units;
    await writeJson(PROJECTS, projects);
  }

  const byKind = plan.reduce((acc, u) => {
    acc[u.kind] = (acc[u.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Dutt Island (${BUILDING_ID}) level G re-planned:`);
  console.log(`  ${byKind.retail ?? 0} retail bays + ${byKind.anchor ?? 0} anchor store`);
  console.log(`  ${byKind.atrium ?? 0} atrium, ${byKind.circulation ?? 0} circulation`);
  console.log(`  replaced ${replaced} generic level-G cell(s)`);
  for (const u of plan) {
    console.log(`    ${u.ulpin}  ${(u.label ?? '').padEnd(30)} ${u.built_m2} m²`);
  }
  console.log('Snapshot files updated.');

  await seedPostgis(plan);
}

// ---------------------------------------------------------------------------
// PostGIS half -- the same rows, so both backends agree.
// ---------------------------------------------------------------------------

/** 'SRID=4326;POLYGON((...))' from a closed lon/lat ring. */
function ewktPolygon(ring) {
  return `SRID=4326;POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(',')}))`;
}

async function seedPostgis(plan) {
  if (!process.env.DATABASE_URL) {
    console.log('PostGIS: DATABASE_URL unset, snapshot only.');
    return;
  }
  let pg;
  try {
    ({ default: pg } = await import('pg'));
  } catch {
    console.log('PostGIS: `pg` not installed, snapshot only.');
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
  } catch (err) {
    console.log(`PostGIS: not reachable (${err.message}), snapshot only.`);
    return;
  }

  try {
    const { rows } = await client.query(
      'SELECT id FROM floor WHERE building_id = $1 AND level_no = $2',
      [BUILDING_ID, LEVEL],
    );
    if (!rows.length) {
      console.log(`PostGIS: building ${BUILDING_ID} level ${LEVEL} not seeded, skipping.`);
      return;
    }
    const floorId = rows[0].id;

    await client.query('BEGIN');
    // The columns migration 006 adds, applied here too so an existing volume
    // does not have to be dropped and re-seeded.
    await client.query(`
      ALTER TABLE unit ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'flat',
                       ADD COLUMN IF NOT EXISTS core_ref text,
                       ADD COLUMN IF NOT EXISTS label text`);
    await client.query('ALTER TABLE unit DROP CONSTRAINT IF EXISTS unit_kind_ck');
    await client.query(`
      ALTER TABLE unit ADD CONSTRAINT unit_kind_ck CHECK (kind IN (
        'flat','retail','anchor','parking',
        'circulation','atrium','elevator','stair','plant'))`);

    // Everything on level G goes, including the three generic cells this plan
    // replaces. Scoped to the one floor, so levels 1-8 are untouched.
    await client.query('DELETE FROM unit WHERE floor_id = $1', [floorId]);

    for (const u of plan) {
      await client.query(
        `INSERT INTO unit (id, floor_id, ulpin, unit_no, geom_3d, z_min, z_max,
                           carpet_m2, built_m2, tenure, encumbrance,
                           kind, core_ref, label)
         VALUES ($1,$2,$3,$4,
                 make_prism(ST_GeomFromEWKT($5), $6, $7),
                 $6,$7,$8,$9,$10,$11,$12,NULL,$13)`,
        [u.id, floorId, u.ulpin, u.unit_no,
          ewktPolygon(u.ring.coordinates[0]), u.z_min, u.z_max,
          u.carpet_m2, u.built_m2, u.tenure, u.encumbrance, u.kind, u.label],
      );
    }
    await client.query('COMMIT');
    console.log(`PostGIS: level G of ${BUILDING_ID} replaced with ${plan.length} volumes.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PostGIS: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

await main();
