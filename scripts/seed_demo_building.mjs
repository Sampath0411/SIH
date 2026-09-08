#!/usr/bin/env node
// scripts/seed_demo_building.mjs
//
// One-shot generator: add a 20-floor, 6-flat special building to the
// siripuram snapshot, with 3 underground parking basements and the
// building's own water riser + sewer tank + sewer lateral.
//
// The citizen demo (Phase 4 / Phase 5) binds to this building: the
// three demo citizens in data/projects/siripuram/residents.json
// (building_id=999) live on its floors 2, 5 and 9. Adding the building
// is what makes the citizen view show "your building" rather than the
// empty collection a 404 would land on.
//
// The script is idempotent: re-running it rewrites the same id=999
// entry, with the same coordinates, so the snapshot stays byte-stable
// across runs. It is NOT safe to run while the dev server is reading
// the snapshot -- stop the server, run the script, start it again.
//
// OUTPUT
//   Patches data/api/siripuram/buildings.json
//   Patches data/api/siripuram/parcels.json
//   Patches data/api/siripuram/detail.json     (adds 999 with full document)
//   Patches data/api/siripuram/utilities.json  (adds 3 building-internal lines)
//   Patches data/api/projects.json             (recounts project stats)
//   Upserts the same building into PostGIS, when DATABASE_URL is reachable
//
// WHY IT WRITES TO POSTGIS TOO
//
// The API serves from PostGIS whenever the database answers, and falls back
// to these snapshots when it does not. This script used to write only the
// snapshots, so the demo building existed in exactly one of the two
// backends. With docker running, siripuram held 384 buildings and no 999:
// the gov view was missing Sampath Skyline entirely, and the citizen -- whose
// buildings collection is filtered to their own id -- got an EMPTY collection
// and a viewer with no buildings in it at all. The bug looked like "the
// citizen view is broken" and was really "the demo building was never in the
// database".
//
// Writing both keeps the two backends telling the same story. If the
// database is unreachable the snapshot half still runs, which is what a
// contributor without docker needs.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'data', 'api', 'siripuram');
const PROJECTS = path.join(ROOT, 'data', 'api', 'projects.json');
const REGISTER = path.join(ROOT, 'data', 'projects', 'siripuram', 'flat-register.json');

const BUILDING_ID = 999;
const SLUG = 'siripuram';
const PARCEL_ID = 9990;
const STATE = 'AP';
const DISTRICT = 'VSP';
const SCHEME = '3D26';

// ---------------------------------------------------------------------------
// Geometry.
//
// Centre chosen in the empty part of the AOI (the existing snapshot has
// 384 buildings, but 221 of them are spread across the AOI with clear
// 36 m gaps in the south-east quadrant). 36 m × 28 m is the building
// footprint: 0.000340 deg lon, 0.000253 deg lat at this latitude.
// ---------------------------------------------------------------------------
const CX = 83.3190;
const CY = 17.7233;
const FL = 0.000340;        // footprint lon extent
const FW = 0.000253;        // footprint lat extent
const ABOVE_GROUND = 60;    // 20 floors × 3 m
const BASEMENT_DEPTH = 12;  // 3 basements × 4 m
// Sampled from the project's CartoDEM clip at (CX, CY) with scripts/dem.py
// (EGM96 orthometric), so this building stands on the same ground as its
// neighbours now that siripuram's ground_elev is real. Re-sample if CX/CY move:
//   .gdal-env/python.exe -c "import sys; sys.path.insert(0,'scripts'); import dem, project;
//     print(dem.Sampler(project.default_project()).sample(83.3190, 17.7233))"
const GROUND_ELEV = 55.31;
const GROUND_SOURCE = 'dsm_dem';
// Derived local hazard exposure for this footprint, from scripts/hazard.py run
// over the real AOI with this building appended -- so its class is graded
// against its actual neighbours, not invented. Re-compute if CX/CY/height move.
const HAZARD = {
  flood_risk: 'high', flood_score: 0.585,
  cyclone_risk: 'moderate', cyclone_score: 0.495,
  coast_dist_m: 1118, local_relief_m: 0.0,
};
const FLOOR_HEIGHT = 3;

const lon0 = CX - FL / 2;
const lon1 = CX + FL / 2;
const lat0 = CY - FW / 2;
const lat1 = CY + FW / 2;

// A rectangular footprint with the long side east-west, returning
// a closed ring (first point == last point), the shape every other
// building in the snapshot uses.
const footprintRing = [
  [lon0, lat0],
  [lon1, lat0],
  [lon1, lat1],
  [lon0, lat1],
  [lon0, lat0],
];

/**
 * Flat sub-footprints: a 2x2 grid on every residential floor.
 *
 * The previous version gave every flat the FULL building footprint, so four
 * flats on a floor were four identical stacked prisms -- nothing to see and
 * nothing to click apart. A flat has to be its own volume before the viewer
 * can distinguish it, highlight it, or resolve a click to it.
 *
 * Two gaps are cut out of the plate, and both are load-bearing for the
 * rendering rather than decorative:
 *
 *   FACADE_INSET  the strip between a flat and the outer wall. Without it a
 *                 flat's wall is coplanar with the building shell and the two
 *                 z-fight; the citizen view draws the shell ghosted around a
 *                 solid flat, so they must not share a surface.
 *   CORRIDOR      the cross down the middle of the plate: the lift core and
 *                 landing. It is what makes the four flats read as four
 *                 rather than as one quartered slab.
 *
 * Grid positions, seen from above (north up), matching the flat numbering
 * 1..4 used by `flatCode`:
 *
 *   +-----------+   +-----------+
 *   |     1     |   |     2     |     1 = NW   2 = NE
 *   +-----------+   +-----------+
 *   +-----------+   +-----------+
 *   |     3     |   |     4     |     3 = SW   4 = SE
 *   +-----------+   +-----------+
 */
const FACADE_INSET = 0.06;   // fraction of the footprint left as facade
const CORRIDOR = 0.06;       // fraction taken by the central core

/** The four grid slots, in flat-number order (1..4). */
const FLAT_SLOTS = [
  { col: 0, row: 1, facing: 'North-West' },
  { col: 1, row: 1, facing: 'North-East' },
  { col: 0, row: 0, facing: 'South-West' },
  { col: 1, row: 0, facing: 'South-East' },
];

/** One flat's closed ring, as GeoJSON Polygon coordinates. */
function flatRing(slot) {
  const near = [FACADE_INSET, 0.5 - CORRIDOR / 2];
  const far = [0.5 + CORRIDOR / 2, 1 - FACADE_INSET];
  const [fx0, fx1] = slot.col === 0 ? near : far;
  const [fy0, fy1] = slot.row === 0 ? near : far;
  const x0 = lon0 + FL * fx0;
  const x1 = lon0 + FL * fx1;
  const y0 = lat0 + FW * fy0;
  const y1 = lat0 + FW * fy1;
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

/** Built-up area of one grid slot, in m². Same degrees->metres convention
 *  as the parcel area above, so the numbers stay comparable. */
function flatAreaM2() {
  const w = FL * (0.5 - CORRIDOR / 2 - FACADE_INSET) * 111000;
  const h = FW * (0.5 - CORRIDOR / 2 - FACADE_INSET) * 111000;
  return w * h;
}

/**
 * A unit slot, mirroring unitSlot() in lib/ulpin.ts.
 *
 * Mirrored rather than imported because this script runs under plain `node`
 * (npm run demo:seed), which cannot load a .ts module without a strip-types
 * flag. lib/ulpin.test.ts pins the encoding on the other side, and every
 * identifier this file mints is parsed back by parse() in the round-trip check.
 *
 * A flat carries no prefix, which is what keeps the 80 identifiers already in
 * data/api/siripuram/detail.json byte-identical.
 */
const SLOT_PREFIX = {
  flat: '', retail: 'R', anchor: 'R', parking: 'P',
  circulation: 'C', atrium: 'C', elevator: 'EV', stair: 'ST', plant: 'PL',
};
function unitSlot(kind, ordinal) {
  const pre = SLOT_PREFIX[kind];
  if (ordinal === undefined || ordinal === null) return pre;
  return `${pre}${String(ordinal).padStart(2, '0')}`;
}

/** A closed ring from normalised footprint fractions, x/y in 0..1. */
function fracRing(fx0, fy0, fx1, fy1) {
  const x0 = lon0 + FL * fx0;
  const x1 = lon0 + FL * fx1;
  const y0 = lat0 + FW * fy0;
  const y1 = lat0 + FW * fy1;
  return [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
}

/** Area of a normalised rectangle, m². Same degrees->metres convention as
 *  flatAreaM2, so every area in this file stays comparable. */
function fracAreaM2(fx0, fy0, fx1, fy1) {
  return (FL * (fx1 - fx0) * 111000) * (FW * (fy1 - fy0) * 111000);
}

/**
 * THE VERTICAL CORES: the lift shaft and the emergency staircase.
 *
 * They occupy the north-south arm of the corridor cross that flatRing()
 * already leaves empty -- x from 0.47 to 0.53, which is exactly the gap
 * between the west flats (which end at 0.47) and the east flats (which start
 * at 0.53). Nothing here can overlap a flat, on any floor, by construction.
 *
 * Each is ONE ROW PER LEVEL sharing `core_ref`, not one row spanning the
 * tower. `unit.floor_id` is NOT NULL, and the viewer's exploded stack and its
 * section cut are both indexed by level: a single spanning solid would detach
 * from the stack the moment the explode slider moved, and the section plane
 * would cut it at one level and leave it whole at twenty-two others. The panel
 * groups the segments back together and reports the span.
 */
const CORES = [
  {
    kind: 'elevator',
    core_ref: 'EV1',
    label: 'Central Elevator Shaft',
    unit_no: 'EV',
    frac: [0.47, 0.30, 0.53, 0.47],
  },
  {
    kind: 'stair',
    core_ref: 'ST1',
    label: 'Emergency Staircase Core',
    unit_no: 'ST',
    frac: [0.47, 0.53, 0.53, 0.70],
  },
];

/**
 * Levels the cores run through: B2 up to the top floor.
 *
 * B3 is plant and tankage and is not served by the passenger lift, so the
 * shaft starts at B2 -- which is what the brief describes, and also what keeps
 * the deepest basement from reading as another parking level.
 */
const CORE_LEVELS = [-2, -1, ...Array.from({ length: 21 }, (_, i) => i)];

/**
 * Subterranean parking, on B1 and B2.
 *
 * THREE BANKS PER LEVEL -- south wall, centre, north wall -- with a drive
 * aisle between each pair. Fourteen 2.4 m bays fit along the 33.9 m the plate
 * leaves between its end walls, which is a real bay width rather than the
 * 3.4 m the old two-bank grid stretched to. The centre bank loses the two
 * bays the cores stand through (x 0.47-0.53), so each level holds 14+12+14 =
 * 40 bays and the two levels hold 80: ONE PER FLAT. Every flat's title
 * carries a bay, and the certificate prints it.
 *
 * The aisles ARE modelled now, as `circulation` rows -- but the viewer draws
 * basement circulation as a painted strip on the plate, not as a box, so the
 * bays stay visible. The old objection ("a box labelled aisle would hide the
 * bays") was to the box, not to the record.
 *
 * B3 gets no bays. It is plant, tankage and the sump -- the sewer tank
 * utility (99003) already sits at that depth -- and giving all three
 * basements an identical grid would state that they are interchangeable,
 * which is the kind of plausible filler this repository avoids elsewhere. It
 * carries one `plant` volume instead, so isolating it shows what it is for.
 */
const PARKING_LEVELS = [-1, -2];
const BAYS_PER_BANK = 14;
/** South, centre, north: [y0, y1] of each bank as a fraction of the plate. */
const PARKING_BANKS = [[0.03, 0.19], [0.42, 0.58], [0.81, 0.97]];
/** The drive aisles between the banks, same convention. */
const PARKING_AISLES = [[0.19, 0.42], [0.58, 0.81]];
/** The x-band the two cores occupy on every level they pass through. */
const CORE_X = [0.47, 0.53];

/** Indian flat numbering: floor 2 slot 1 -> "201", floor 20 slot 3 -> "2003". */
function flatCode(level, slotNo) {
  return `${level}${String(slotNo).padStart(2, '0')}`;
}

function floorZ(levelNo) {
  // levelNo = 0 is the ground floor, +N is above, -N is below.
  if (levelNo >= 0) {
    return [GROUND_ELEV + levelNo * FLOOR_HEIGHT, GROUND_ELEV + (levelNo + 1) * FLOOR_HEIGHT];
  }
  const n = -levelNo;
  return [GROUND_ELEV - n * 4, GROUND_ELEV - (n - 1) * 4];
}

const ULPIN_BASE = `${STATE}-${DISTRICT}-${SCHEME}-9999`;

/**
 * The residential floors. Four flats on each, so a floor is a plate with
 * four distinct volumes on it rather than one slab -- which is the whole
 * point: a citizen has to be able to see their flat apart from its
 * neighbours before "click your own flat" means anything.
 *
 * EVERY FLOOR, not a sample of them. This used to be [2, 5, 9, 13, 17, 20]:
 * six floors out of twenty, chosen to keep the register small. The building
 * record has always said `floors: 20`, so isolating floor 6 gave a bare plate
 * with nothing on it and the tower read as mostly empty -- the one thing the
 * demo tower exists not to do. 20 floors x 4 slots = 80 flats, which the
 * register generates deterministically and the floor view already renders one
 * plate at a time.
 *
 * The ground floor (0) is deliberately not residential.
 */
const FLAT_FLOORS = Array.from({ length: 20 }, (_, i) => i + 1);

// 24 levels: 3 basements + 21 above-ground levels (ground + 20 storeys).
const ALL_LEVELS = [-3, -2, -1, ...Array.from({ length: 21 }, (_, i) => i)];

const BUILDING_NAME = 'Sampath Skyline';
const STREET = 'Siripuram East';
const CITY = 'Visakhapatnam';
const PIN = '530003';

/**
 * Named owners, keyed "<level>-<slot>".
 *
 * The three entries that match data/projects/siripuram/residents.json are the
 * demo logins and MUST stay in step with it -- the citizen session carries
 * `unit` as a string code and the viewer matches it against `unit_no`. The
 * rest are here so a floor reads as a real floor: three neighbours the
 * citizen can see the shape of and cannot open.
 *
 * This covers the six floors the register originally had. Every other flat
 * gets a name from ownerFor() below rather than the string "Unallotted",
 * which on 56 of 80 flats would read as a half-built dataset.
 */
const OWNERS = {
  '2-1': 'Ravi Kumar',        // demo login  111122223333
  '2-2': 'Meena Patnaik',
  '2-3': 'Joseph Fernandes',
  '2-4': 'Sanjay Varma',
  '5-1': 'Aruna Devi',
  '5-2': 'Priya Sharma',      // demo login  222233334444
  '5-3': 'Vikram Naidu',
  '5-4': 'Fatima Begum',
  '9-1': 'Rajesh Gupta',
  '9-2': 'Sunita Rao',
  '9-3': 'Anand Rao',         // demo login  333344445555
  '9-4': 'Deepak Chowdary',
  '13-1': 'Suresh Iyer',
  '13-2': 'Kavitha Menon',
  '13-3': 'Imran Sheikh',
  '13-4': 'Padma Lakshmi',
  '17-1': 'Lakshmi Iyer',
  '17-2': 'Gopal Krishna',
  '17-3': 'Rehana Yusuf',
  '17-4': 'Mahesh Babu',
  '20-1': 'Karthik Reddy',
  '20-2': 'Shanti Prasad',
  '20-3': 'Nikhil Jain',
  '20-4': 'Ananya Bose',
};

// ---------------------------------------------------------------------------
// Read existing snapshots.
// ---------------------------------------------------------------------------
/**
 * Remember how each file was formatted, so writing it back does not reformat
 * it.
 *
 * This script PATCHES committed snapshots; it does not own them. The
 * exporter writes the big API files minified, and blindly re-emitting them at
 * indent 2 turned detail.json from 3.6 MB on one line into 9.5 MB across
 * 434,718 lines -- a diff nobody can read, wrapped around a one-building
 * change, in a file that is also served over the wire. projects.json, by
 * contrast, really is kept pretty-printed and hand-readable.
 *
 * So the style is read off the file rather than decided here.
 */
const style = new Map();

async function readJson(p) {
  const raw = await fs.readFile(p, 'utf-8');
  const parsed = JSON.parse(raw);
  // Pretty-printed files put a newline after the opening brace; minified ones
  // do not. That is the only signal needed, and it does not depend on the
  // document's shape.
  const pretty = /^\s*[[{]\s*\n/.test(raw);
  style.set(p, { pretty, trailingNewline: raw.endsWith('\n') });
  return parsed;
}

async function writeJson(p, value) {
  const s = style.get(p) ?? { pretty: true, trailingNewline: true };
  const body = s.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  await fs.writeFile(p, body + (s.trailingNewline ? '\n' : ''), 'utf-8');
}

const buildings = await readJson(path.join(API, 'buildings.json'));
const parcels = await readJson(path.join(API, 'parcels.json'));
const detail = await readJson(path.join(API, 'detail.json'));
const utilities = await readJson(path.join(API, 'utilities.json'));
const projectsDoc = await readJson(PROJECTS);

// ---------------------------------------------------------------------------
// 1. buildings.json -- one new feature with id=999.
// ---------------------------------------------------------------------------
const newBuilding = {
  type: 'Feature',
  id: BUILDING_ID,
  geometry: { type: 'Polygon', coordinates: [footprintRing] },
  properties: {
    id: BUILDING_ID,
    ulpin: `${ULPIN_BASE}-001`,
    parcel_id: PARCEL_ID,
    height_m: ABOVE_GROUND,
    floors: 20,
    basements: 3,
    ground_elev: GROUND_ELEV,
    ground_source: GROUND_SOURCE,
    ...HAZARD,
    use_type: 'residential',
    height_source: 'surveyed_plan',
    survey_synthetic: true,
    name: 'Sampath Skyline',
    address: 'Siripuram East',
    osm_id: 0,
  },
};
buildings.features = buildings.features.filter((f) => f.properties.id !== BUILDING_ID);
buildings.features.push(newBuilding);

// ---------------------------------------------------------------------------
// 2. parcels.json -- one parcel that contains the building footprint.
// ---------------------------------------------------------------------------
const newParcel = {
  type: 'Feature',
  id: PARCEL_ID,
  geometry: { type: 'Polygon', coordinates: [footprintRing] },
  properties: {
    id: PARCEL_ID,
    ulpin: ULPIN_BASE,
    area_m2: Math.round(FL * 111000 * FW * 111000 * 0.92), // 36 m × 28 m in m²
    owner: 'Sampath Estates Pvt Ltd',
  },
};
parcels.features = parcels.features.filter((f) => f.properties.id !== PARCEL_ID);
parcels.features.push(newParcel);

// ---------------------------------------------------------------------------
// 3. detail.json -- the full BuildingDetail document for id=999.
// ---------------------------------------------------------------------------
const floorIdBase = 90000;
/**
 * WELL CLEAR OF THE EXPORTER'S RANGE, and that is not arbitrary.
 *
 * This was 95000, which fitted while the demo tower had 24 flats. At 80 it
 * runs to 95079 and collides head-on with the units the main seed assigned to
 * buildings 5579-5582 -- the PostGIS half of this script died on
 * `duplicate key value violates unique constraint "unit_pkey"` and rolled
 * back, leaving the database describing a 24-flat tower and the snapshot an
 * 80-flat one.
 *
 * 990000 sits above every id the exporter issues (the largest unit id in a
 * seeded database is around 127k) and echoes the demo numbering used for the
 * building (999), the parcel (9990) and its utilities (99001-99003). The
 * floor base above needs no such move: it spans 24 ids and always will,
 * because ALL_LEVELS is fixed.
 */
const unitIdBase = 990000;

// A floor's own ring stays the full plate -- the storey really is the whole
// footprint. It is the UNITS on it that are subdivided.
const floors = ALL_LEVELS.map((lvl, i) => ({
  id: floorIdBase + i,
  ulpin: `${ULPIN_BASE}-001-${lvl < 0 ? 'B' + -lvl : String(lvl).padStart(2, '0')}`,
  level_no: lvl,
  z_min: floorZ(lvl)[0],
  z_max: floorZ(lvl)[1],
  detect_source: 'surveyed_plan',
  ring: { type: 'Polygon', coordinates: [footprintRing] },
}));

const builtM2 = Math.round(flatAreaM2());
const carpetM2 = Math.round(flatAreaM2() * 0.72);

// ---------------------------------------------------------------------------
// 3a. The flat register -- ownership, charge, tax and bills.
//
// A SEPARATE record from the cadastre, written to
// data/projects/siripuram/flat-register.json and merged onto the unit rows by
// lib/db.ts on read. Not a set of unit columns, for two reasons. The cadastre
// answers "what is this volume and who holds title"; a bank's charge and last
// month's electricity bill answer something else, are owned by other
// authorities and change on a different clock. And a file both backends read
// cannot drift the way a column that only PostGIS has would -- which is the
// same split-brain that lost the demo building and still hides the citizen's
// own utility runs.
//
// Every value here is INVENTED. It is shaped like a register entry so the
// panel can be built and read honestly; the panel labels it as a
// demonstration value, and nothing in it should ever be quoted as fact.
// ---------------------------------------------------------------------------

/**
 * The three demo logins get their state chosen rather than hashed.
 *
 * Everything else in the register is deterministic from the flat code, which
 * is fine for the 21 flats nobody signs in as. It is not fine for the three
 * that are the demo: whether the panel shows a mortgage, an outstanding
 * demand or an overdue bill would then be decided by a hash, and the most
 * likely outcome is that the first login anyone tries shows the dullest
 * possible card. These three are picked to cover the states between them.
 *
 *   tax: 0 = nothing paid, 2 = part paid, 8 = paid in full
 *   arrears: the bills left unpaid
 */
const DEMO_STATES = {
  // Ravi Kumar, floor 2 -- mortgaged, tax settled, the water bill overdue.
  201: { mortgaged: true, tax: 8, arrears: ['water'] },
  // Priya Sharma, floor 5 -- owns it outright and owes nothing.
  502: { mortgaged: false, tax: 8, arrears: [] },
  // Anand Rao, floor 9 -- mortgaged, and this year's tax only half paid.
  903: { mortgaged: true, tax: 2, arrears: ['electricity'] },
};

/** Deterministic 0..n-1 from a string, so a re-run produces the same register. */
function pick(seed, n) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % n;
}

/**
 * Given and family names for the flats OWNERS does not name.
 *
 * Two lists combined by `pick`, so 80 flats do not need 80 hand-written
 * entries and a re-run produces the same register. Coastal-Andhra surnames,
 * matching the hand-written names above so one floor does not read as a
 * different city from the next.
 */
const GIVEN = [
  'Srinivas', 'Padmaja', 'Venkat', 'Lalitha', 'Ramesh', 'Bhavani',
  'Kishore', 'Swapna', 'Prasad', 'Jyothi', 'Naveen', 'Sridevi',
  'Chandra', 'Vasantha', 'Murali', 'Indira', 'Satish', 'Vijaya',
  'Harish', 'Rukmini', 'Bhaskar', 'Sarita', 'Mohan', 'Kalyani',
];
const FAMILY = [
  'Raju', 'Patnaik', 'Naidu', 'Sastry', 'Varma', 'Reddy', 'Rao',
  'Chowdary', 'Prasad', 'Murthy', 'Appalaraju', 'Yadav', 'Kumari',
  'Simhadri', 'Gollapalli', 'Kandregula',
];

/**
 * Who owns one flat. A hand-written owner wins; otherwise a stable made-up
 * one, seeded from the flat code exactly as registerFor() seeds everything
 * else about the flat, so the name and its title deed never disagree between
 * runs.
 */
function ownerFor(level, slotNo) {
  const named = OWNERS[`${level}-${slotNo}`];
  if (named) return named;
  const seed = `own-${level}-${slotNo}`;
  return `${GIVEN[pick(`g${seed}`, GIVEN.length)]} `
    + `${FAMILY[pick(`f${seed}`, FAMILY.length)]}`;
}

const BANKS = [
  { bank: 'State Bank of India', branch: 'Siripuram, Visakhapatnam', code: 'SBI' },
  { bank: 'HDFC Bank', branch: 'Dwaraka Nagar, Visakhapatnam', code: 'HDFC' },
  { bank: 'Union Bank of India', branch: 'Asilmetta, Visakhapatnam', code: 'UBI' },
  { bank: 'LIC Housing Finance', branch: 'Visakhapatnam', code: 'LICHFL' },
];

/** Assessment year and the billing month the demo is written against. */
const TAX_YEAR = '2026-27';
const TAX_DUE = '2026-09-30';
const BILL_PERIOD = 'Aug 2026';

/**
 * One register entry per flat.
 *
 * Two in every three flats carry a bank charge, which is about what a tower
 * of this age would look like, and the mix matters: a panel that only ever
 * renders "Owned outright" never shows the row a mortgaged owner cares about.
 * The same goes for the arrears -- a register in which everything is settled
 * would leave the overdue state untested and unseen.
 */
function registerFor(level, slotNo, code, ulpin) {
  const seed = `${SLUG}-${code}`;
  const forced = DEMO_STATES[code];
  const mortgaged = forced ? forced.mortgaged : pick(`m${seed}`, 3) !== 0;
  const b = BANKS[pick(`b${seed}`, BANKS.length)];
  const sanctioned = 3_200_000 + pick(`s${seed}`, 22) * 100_000;
  const paidOff = 0.18 + pick(`p${seed}`, 45) / 100;
  const from = 2016 + pick(`y${seed}`, 8);
  const regMonth = 1 + pick(`mm${seed}`, 12);
  const registeredOn = `${from}-${String(regMonth).padStart(2, '0')}-`
    + `${String(1 + pick(`dd${seed}`, 27)).padStart(2, '0')}`;
  // Same month as the deed, a fortnight later -- close enough to read as one
  // transaction without ever landing before it.
  const chargeFrom = `${registeredOn.slice(0, 8)}${String(
    Math.min(28, Number(registeredOn.slice(8)) + 1),
  ).padStart(2, '0')}`;

  const demand = 14_200 + pick(`t${seed}`, 40) * 200;
  // Most of the tower has settled this year's demand; a couple of flats have
  // not paid at all and one has paid part -- the three states the tax row has
  // to be able to render.
  const taxState = forced ? forced.tax : pick(`ts${seed}`, 9);
  const taxPaid = taxState < 2 ? 0 : taxState === 2 ? Math.round(demand / 2) : demand;

  const bill = (kind, authority, prefix, amount, dueDay, seedKey) => {
    const paid = forced ? !forced.arrears.includes(kind) : pick(seedKey + seed, 4) !== 0;
    return {
      kind,
      authority,
      account: `${prefix}-${pick('a' + seedKey + seed, 900000) + 100000}`,
      period: BILL_PERIOD,
      amount_inr: amount,
      paid,
      due_on: `2026-09-${String(dueDay).padStart(2, '0')}`,
      // Early in the month, so a settled bill is never dated after the day the
      // demo is set on -- a receipt from next week reads as broken data long
      // before anyone works out it is only a demo.
      paid_on: paid
        ? `2026-09-${String(1 + pick('pd' + seedKey + seed, Math.min(4, dueDay))).padStart(2, '0')}`
        : null,
    };
  };

  return {
    ulpin,
    entry: {
      ownership: mortgaged ? 'mortgaged' : 'owned',
      title_deed: `DOC/${from}/VSP/${40000 + pick(`d${seed}`, 9000)}`,
      registered_on: registeredOn,
      ...(mortgaged
        ? {
          mortgage: {
            bank: b.bank,
            branch: b.branch,
            loan_no: `${b.code}-HL-${1000000 + pick(`l${seed}`, 8999999)}`,
            sanctioned_inr: sanctioned,
            outstanding_inr: Math.round((sanctioned * (1 - paidOff)) / 100) * 100,
            emi_inr: Math.round((sanctioned / 240) * 1.55 / 10) * 10,
            // The charge is created when the sale is registered, never before
            // it: a mortgage dated ahead of the deed is not a thing a register
            // can hold, and it is the kind of detail a reader checks first.
            charge_from: chargeFrom,
            closes_on: `${from + 20}${chargeFrom.slice(4)}`,
          },
        }
        : {}),
      tax: {
        authority: 'Greater Visakhapatnam Municipal Corporation',
        assessment_no: `GVMC/50/${1100 + level}/${code}`,
        year: TAX_YEAR,
        demand_inr: demand,
        paid_inr: taxPaid,
        paid_on: taxPaid > 0
          ? `2026-0${4 + pick(`tp${seed}`, 5)}-${String(1 + pick(`td${seed}`, 27)).padStart(2, '0')}`
          : null,
        due_on: TAX_DUE,
      },
      bills: [
        bill('water', 'GVMC Water Supply', 'GVMC-W', 380 + pick(`w${seed}`, 24) * 20, 12, 'w'),
        bill('electricity', 'APEPDCL', 'APEPDCL', 1_180 + pick(`e${seed}`, 60) * 30, 18, 'e'),
        bill('maintenance', `${BUILDING_NAME} Owners' Association`, 'SSOA', 3_500, 5, 'x'),
      ],
    },
  };
}

/** ULPIN -> register entry, written to data/projects/siripuram/. */
const flatRegister = {};

const units = [];
let unitCounter = 0;
for (const lvl of FLAT_FLOORS) {
  const floorEntry = floors.find((f) => f.level_no === lvl);
  if (!floorEntry) continue;
  FLAT_SLOTS.forEach((slot, idx) => {
    const slotNo = idx + 1;
    const code = flatCode(lvl, slotNo);
    const ulpin = `${floorEntry.ulpin}-${code}`;
    const reg = registerFor(lvl, slotNo, code, ulpin);
    flatRegister[reg.ulpin] = reg.entry;
    units.push({
      id: unitIdBase + unitCounter,
      floor_id: floorEntry.id,
      ulpin,
      unit_no: code,
      level_no: lvl,
      z_min: floorEntry.z_min,
      z_max: floorEntry.z_max,
      carpet_m2: carpetM2,
      built_m2: builtM2,
      tenure: 'Freehold',
      // The cadastre's own encumbrance column, kept in step with the register
      // rather than hardcoded to 'None'. A flat with a bank's charge on it
      // that reads "Encumbrance: None" is a wrong answer stated as a right
      // one -- the same defect the owner fallback used to have.
      encumbrance: reg.entry.mortgage
        ? `Mortgage · ${reg.entry.mortgage.bank}`
        : 'None',
      // The three fields the detail panel needs to describe a flat as a
      // home rather than as a volume. `owner` in particular did not exist
      // before: the panel fell back to the PARCEL's owner, so every flat in
      // the tower was attributed to the developer.
      owner: ownerFor(lvl, slotNo),
      address: `Flat ${code}, ${BUILDING_NAME}, ${STREET}, ${CITY} ${PIN}`,
      facing: slot.facing,
      ring: { type: 'Polygon', coordinates: flatRing(slot) },
    });
    unitCounter++;
  });
}

// ---------------------------------------------------------------------------
// 3b. The volumes that are not flats.
//
// Before this, levels B3..B1 and the ground floor held no unit rows at all, so
// isolating one of them drew the storey prism and nothing inside it -- the
// "single bounding extrusion box" the interior model exists to replace. The
// flats above were already individual volumes; the basements and the lobby had
// nothing to show.
//
// NONE OF THESE CARRY AN OWNER. A parking bay is appurtenant to a flat, and
// the lift shaft, the staircase and the lobby are common property held by the
// association rather than titled separately. Inventing a holder for them would
// be exactly the attribution error the nullable `owner` column was added to
// prevent -- so tenure says what they are and the panel says nothing more.
// ---------------------------------------------------------------------------
const floorByLevel = new Map(floors.map((f) => [f.level_no, f]));

/**
 * Push one non-flat volume, taking the next id from the shared counter.
 *
 * `identity: false` writes the row WITHOUT a ULPIN, areas or tenure. That is
 * what a structural core gets: a lift shaft is building fabric, not a
 * registered spatial unit anyone could hold, and an identifier on it invited
 * exactly the reading the panel then had to talk the user out of. The
 * PostGIS half still mints one, because `unit.ulpin` is NOT NULL there, and
 * the API strips it on the way out for both backends (stripCoreIdentity in
 * lib/auth/access-pure.ts) so the two responses are byte-identical.
 */
function pushVolume({
  level, kind, ordinal, unit_no, label, frac, tenure, identity = true, core_ref,
}) {
  const floorEntry = floorByLevel.get(level);
  if (!floorEntry) return;
  const [fx0, fy0, fx1, fy1] = frac;
  const area = fracAreaM2(fx0, fy0, fx1, fy1);
  const row = {
    id: unitIdBase + unitCounter,
    floor_id: floorEntry.id,
    unit_no,
    level_no: level,
    z_min: floorEntry.z_min,
    z_max: floorEntry.z_max,
    kind,
    label,
    ring: { type: 'Polygon', coordinates: fracRing(fx0, fy0, fx1, fy1) },
  };
  if (identity) {
    Object.assign(row, {
      ulpin: `${floorEntry.ulpin}-${unitSlot(kind, ordinal)}`,
      // Carpet is the usable area; for a bay or a shaft it IS the enclosed
      // area, so the 0.72 factor the flats use does not apply.
      carpet_m2: Math.round(area * 10) / 10,
      built_m2: Math.round(area * 10) / 10,
      tenure,
      encumbrance: 'None',
    });
  }
  if (core_ref) row.core_ref = core_ref;
  units.push(row);
  unitCounter++;
}

// ---- subterranean parking bays -------------------------------------------
// Numbered by level in the Indian convention the flats already use: B1 is the
// 100 series, B2 the 200 series, so slot P-101 is the first bay on B1.
for (const level of PARKING_LEVELS) {
  const series = -level * 100;
  let n = 0;
  PARKING_BANKS.forEach(([by0, by1], bank) => {
    for (let i = 0; i < BAYS_PER_BANK; i += 1) {
      // A hairline gap between neighbouring bays, so the painted line between
      // two cars is visible rather than two solids sharing a wall. The flats
      // get the same treatment at render time via FLOOR_VIEW.UNIT_INSET_M.
      const x0 = 0.05 + (0.90 / BAYS_PER_BANK) * i + 0.004;
      const x1 = 0.05 + (0.90 / BAYS_PER_BANK) * (i + 1) - 0.004;
      // The centre bank is where the cores come down. A bay drawn through a
      // lift shaft would be a clash the topology check is built to catch.
      const underCore = bank === 1 && x1 > CORE_X[0] && x0 < CORE_X[1];
      if (underCore) continue;
      n += 1;
      const ordinal = series + n;
      pushVolume({
        level,
        kind: 'parking',
        ordinal,
        unit_no: `P-${ordinal}`,
        label: `Parking Slot P-${ordinal}`,
        frac: [x0, by0, x1, by1],
        // Appurtenant to a flat, not separately titled. The panel prints this
        // instead of a tenure it cannot support.
        tenure: 'Appurtenant',
      });
    }
  });
  // The two drive aisles. Circulation, like the lobby, and carrying no
  // identity for the same reason the cores carry none: nobody holds an aisle.
  PARKING_AISLES.forEach(([ay0, ay1], i) => {
    pushVolume({
      level,
      kind: 'circulation',
      unit_no: `AISLE-${i + 1}`,
      label: `Drive aisle ${i + 1}`,
      frac: [0.03, ay0, 0.97, ay1],
      identity: false,
    });
  });
}

// ---- B3: plant and tankage -----------------------------------------------
// The deepest level holds the sump the sewer tank (99003) drains to, the
// pumps and the water tanks. One volume, so the level is not an empty plate,
// and no identity, because plant is building fabric like the cores.
pushVolume({
  level: -3,
  kind: 'plant',
  unit_no: 'PLANT',
  label: 'Plant, pumps and tankage',
  frac: [0.06, 0.06, 0.94, 0.94],
  identity: false,
});

// ---- the two vertical cores ----------------------------------------------
// One row per level, sharing core_ref. See the CORES comment above for why
// this is not a single spanning solid, and pushVolume for why it has no
// identity.
for (const core of CORES) {
  for (const level of CORE_LEVELS) {
    pushVolume({
      level,
      kind: core.kind,
      unit_no: core.unit_no,
      label: core.label,
      frac: core.frac,
      identity: false,
      core_ref: core.core_ref,
    });
  }
}

// ---- the ground-floor lobby ----------------------------------------------
// Level 0 is deliberately not residential (see FLAT_FLOORS), which left it as
// empty as the basements. It is the entrance lobby, and it is the one volume
// on that level besides the two cores passing through it.
pushVolume({
  level: 0,
  kind: 'circulation',
  unit_no: 'LOBBY',
  label: 'Entrance Lobby',
  frac: [0.06, 0.06, 0.94, 0.28],
  identity: false,
});

// ---- which bay belongs to which flat --------------------------------------
// THE ALLOCATION IS A REGISTER FACT, NOT A CADASTRAL ONE, and it goes in the
// register file for exactly that reason.
//
// A parking bay still carries no owner -- see the comment above pushVolume,
// which is unchanged and still right. Who may park in P-213 is not a property
// of the concrete; it is a term of the flat's title, sitting beside the deed
// number and the charge, in the record that already holds those. Writing an
// owner onto the bay instead would make the cadastre claim a bay is
// separately titled, which is the one thing it is not.
//
// This is what binds Flat 901, its bay and its undivided share of the ground
// into ONE administrative record: lib/ladm.ts reads `parking_ulpin` and adds
// the bay to the LA_BAUnit as an `appurtenant` member. Because it lives in
// the register, it works identically on PostGIS and on the snapshot.
//
// EIGHTY BAYS FOR EIGHTY FLATS. Every flat's title carries exactly one bay, so
// the certificate can print it as an appurtenant right and the bay's own card
// can say which flat it is reserved for. Allocation is in flat order, lowest
// floor first, and the lower basement fills first -- both deterministic, and
// the order a builder actually sells in. The script fails loudly if the two
// counts ever drift apart again.
{
  const bays = units
    .filter((u) => u.kind === 'parking')
    .sort((a, b) => b.level_no - a.level_no || a.unit_no.localeCompare(b.unit_no));
  const flats = units
    .filter((u) => u.kind === undefined || u.kind === 'flat')
    .sort((a, b) => a.level_no - b.level_no || a.unit_no.localeCompare(b.unit_no));
  if (bays.length !== flats.length) {
    throw new Error(
      `parking: ${bays.length} bays for ${flats.length} flats -- the layout `
      + 'must give every flat exactly one bay',
    );
  }
  flats.forEach((flat, i) => {
    const bay = bays[i];
    const entry = flatRegister[flat.ulpin];
    if (!entry) throw new Error(`no register entry for ${flat.ulpin}`);
    entry.parking_ulpin = bay.ulpin;
    entry.parking_label = bay.label;
    entry.parking_level = bay.level_no;
  });
}

detail[String(BUILDING_ID)] = {
  building: {
    ...newBuilding.properties,
    footprint: { type: 'Polygon', coordinates: [footprintRing] },
  },
  parcel: newParcel.properties,
  floors,
  units,
};

// ---------------------------------------------------------------------------
// 3c. ladm.json -- the ISO 19152 projection of the tower, for the snapshot
// backend.
//
// scripts/05_export_static.py dumps this file from PostGIS after
// ladm_backfill(), and used to be the ONLY way the tower's entries got there:
// re-seeding the tower without re-exporting left the Legal tab describing
// bays that no longer existed. The shapes written here mirror ladmSql() in
// lib/db.ts field for field (the same contract the exporter keeps), and the
// PostGIS half below runs ladm_backfill() so a later export reproduces them.
//
// Only volumes WITH an identity get an entry: a flat and a bay are spatial
// units; a core, an aisle and the plant room are fabric, and have no su_id
// to be addressed by. The parcel's own entry is left alone -- it is the
// exporter's, and its undivided-share denominator is the flat count, which
// has not changed.
//
// What the flat's document does NOT carry here: the bay as an appurtenant
// member, and the mortgage, tax and bill rights. Those are layered on at read
// time from the register by lib/db.ts, identically for both backends.
// ---------------------------------------------------------------------------
const LADM_SNAPSHOT = path.join(API, 'ladm.json');
{
  let ladm = {};
  try { ladm = await readJson(LADM_SNAPSHOT); } catch { /* first export */ }
  const towerPrefix = `${ULPIN_BASE}-001-`;
  for (const k of Object.keys(ladm)) {
    if (k.startsWith(towerPrefix)) delete ladm[k];
  }
  const flatCount = units.filter((u) => u.kind === undefined || u.kind === 'flat').length;
  let seq = 0;
  for (const u of units) {
    if (!u.ulpin) continue;
    seq += 1;
    const isFlat = u.kind === undefined || u.kind === 'flat';
    const label = u.label ?? u.unit_no;
    const entry = {
      su: {
        su_id: u.ulpin,
        su_type: 'multi_storey',
        dimension: '3D',
        source_kind: 'unit',
        source_id: u.id,
        provenance: 'surveyed',
        z_min: u.z_min,
        z_max: u.z_max,
        volume_m3: Math.round(u.built_m2 * (u.z_max - u.z_min) * 10) / 10,
        label,
        ring: u.ring,
      },
      ba_unit: null,
      rrrs: [],
      easements: [],
    };
    if (isFlat) {
      // Synthetic ids in the demo range, so they cannot collide with anything
      // the exporter issued for the 384 OSM buildings.
      entry.ba_unit = {
        ba_unit_id: 990000 + seq,
        ba_ulpin: `${u.ulpin}-BA`,
        name: `Flat ${u.unit_no}`,
        ba_type: 'condominium_unit',
        ulpin_14: null,
        members: [
          { su_id: u.ulpin, member_role: 'principal', share_num: 1, share_den: 1,
            su_type: 'multi_storey', label },
          { su_id: ULPIN_BASE, member_role: 'undivided_share', share_num: 1,
            share_den: flatCount, su_type: 'surface', label: `Plot ${ULPIN_BASE}` },
        ],
      };
      entry.rrrs = [{
        rrr_id: 990000 + seq,
        rrr_class: 'right',
        rrr_type: 'ownership',
        share_num: 1,
        share_den: 1,
        time_spec_from: null,
        time_spec_to: null,
        amount_inr: null,
        reference: null,
        description: u.tenure,
        party: {
          party_id: 990000 + seq,
          name: u.owner,
          party_type: 'natural_person',
          role: 'owner',
          authority_code: null,
        },
      }];
    }
    ladm[u.ulpin] = entry;
  }
  await writeJson(LADM_SNAPSHOT, ladm);
}

// ---------------------------------------------------------------------------
// 4. utilities.json -- the building's three internal lines.
// ---------------------------------------------------------------------------
const waterRiserZ = [];
for (const lvl of ALL_LEVELS) {
  const [zmin] = floorZ(lvl);
  waterRiserZ.push(zmin + 0.5);
}
const waterRiser = {
  type: 'Feature',
  id: 99001,
  geometry: {
    type: 'LineString',
    coordinates: waterRiserZ.map((z) => [lon0 + 0.00001, lat0 + 0.00001, z]),
  },
  properties: {
    id: 99001,
    building_id: BUILDING_ID,
    asset_type: 'water',
    depth_m: 0,
    radius_m: 0.05,
    authority: 'GVMC Water Supply',
    status: 'operational',
    in_conflict: false,
  },
};
const sewerLateral = {
  type: 'Feature',
  id: 99002,
  geometry: {
    type: 'LineString',
    coordinates: [
      [lon0 + FL * 0.9, lat0 + FW * 0.9, GROUND_ELEV - 4],
      [lon0 + FL * 0.9, lat0 + FW * 0.9, GROUND_ELEV - 8],
      [lon1 - FL * 0.05, lat0 + FW * 0.9, GROUND_ELEV - 8],
      [lon1 - FL * 0.05, lat0 + FW * 0.5, GROUND_ELEV - 12],
    ],
  },
  properties: {
    id: 99002,
    building_id: BUILDING_ID,
    asset_type: 'sewer',
    depth_m: -8,
    radius_m: 0.3,
    authority: 'GVMC Sewerage Board',
    status: 'operational',
    in_conflict: false,
  },
};
const sewerTank = {
  type: 'Feature',
  id: 99003,
  geometry: {
    type: 'LineString',
    coordinates: [
      [lon0 + FL * 0.05, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.30, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.30, lat0 + FW * 0.40, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.05, lat0 + FW * 0.40, GROUND_ELEV - 10.5],
      [lon0 + FL * 0.05, lat0 + FW * 0.05, GROUND_ELEV - 10.5],
    ],
  },
  properties: {
    id: 99003,
    building_id: BUILDING_ID,
    asset_type: 'sewer',
    depth_m: -10.5,
    radius_m: 0.5,
    authority: 'Sampath Estates Pvt Ltd',
    status: 'operational',
    in_conflict: false,
  },
};
utilities.features = utilities.features.filter(
  (f) => ![99001, 99002, 99003].includes(f.properties.id),
);
utilities.features.push(waterRiser, sewerLateral, sewerTank);

// ---------------------------------------------------------------------------
// 5. projects.json -- bump stats so the gallery reflects the new build.
// ---------------------------------------------------------------------------
// COUNTED, not incremented. The previous version added a fixed delta on every
// run, so a second run silently double-counted the one building it had already
// added -- which is exactly what happened, and left the gallery claiming 386
// buildings against a file holding 385. Recomputing from the snapshots that
// were just written makes the script idempotent and makes the stats true by
// construction rather than by arithmetic nobody re-checks.
for (const p of projectsDoc.projects ?? []) {
  if (p.slug !== SLUG) continue;
  p.stats = {
    ...p.stats,
    buildings: buildings.features.length,
    parcels: parcels.features.length,
    utilities: utilities.features.length,
    floors: Object.values(detail).reduce((n, d) => n + (d.floors?.length ?? 0), 0),
    units: Object.values(detail).reduce((n, d) => n + (d.units?.length ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Write back.
// ---------------------------------------------------------------------------
await writeJson(path.join(API, 'buildings.json'), buildings);
await writeJson(path.join(API, 'parcels.json'), parcels);
await writeJson(path.join(API, 'detail.json'), detail);
await writeJson(path.join(API, 'utilities.json'), utilities);
await writeJson(PROJECTS, projectsDoc);
// The register is this script's own file, not a snapshot it patches, so it is
// written whole and pretty-printed -- it is meant to be read and edited by
// hand when the demo needs a different story.
await fs.writeFile(REGISTER, JSON.stringify(flatRegister, null, 2) + '\n', 'utf-8');

const mortgaged = Object.values(flatRegister).filter((e) => e.mortgage).length;
const taxDue = Object.values(flatRegister)
  .filter((e) => (e.tax?.paid_inr ?? 0) < (e.tax?.demand_inr ?? 0)).length;

// Counted by kind rather than reported as `units.length` flats, which is what
// this line used to say and stopped being true the moment the basements and
// the cores became volumes: it printed "167 flats" for 80 flats and 87 other
// things.
const byKind = units.reduce((acc, u) => {
  const k = u.kind ?? 'flat';
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

console.log('Seeded building 999:');
console.log(
  `  ${byKind.flat ?? 0} flats: 4 per floor on floors `
  + `${FLAT_FLOORS[0]}-${FLAT_FLOORS[FLAT_FLOORS.length - 1]}`
  + `, each ${builtM2} m² built-up / ${carpetM2} m² carpet`,
);
console.log(`  flat register: ${mortgaged} mortgaged, ${taxDue} with tax outstanding`);
console.log(
  `  ${byKind.parking ?? 0} parking bays on B1-B2, one per flat`
  + `, ${byKind.circulation ?? 0} circulation (lobby + aisles)`
  + `, ${byKind.plant ?? 0} plant room on B3`,
);
console.log(
  `  cores: ${byKind.elevator ?? 0}-level lift shaft + `
  + `${byKind.stair ?? 0}-level staircase, B2 to level `
  + `${CORE_LEVELS[CORE_LEVELS.length - 1]}`,
);
console.log(`  ${units.length} volumes on ${floors.length} levels`);
console.log('  3 basements (B1, B2, B3)');
console.log('  1 water riser, 1 sewer lateral, 1 sewer tank');
console.log('Snapshot files updated.');

// ---------------------------------------------------------------------------
// 6. PostGIS -- the same building, so both backends agree.
// ---------------------------------------------------------------------------
await seedPostgis();

async function seedPostgis() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('PostGIS: DATABASE_URL unset, snapshot only.');
    return;
  }
  let Client;
  try {
    ({ Client } = await import('pg'));
  } catch {
    console.log('PostGIS: `pg` not installed, snapshot only.');
    return;
  }
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    // Not an error: a contributor without docker still gets the snapshots,
    // and the API falls back to them anyway.
    console.log(`PostGIS: unreachable (${err.message.split('\n')[0]}), snapshot only.`);
    return;
  }

  const ring2d = (ring) =>
    `SRID=4326;POLYGON((${ring.map(([x, y]) => `${x} ${y}`).join(',')}))`;

  /**
   * The ULPIN a volume without an identity is stored under.
   *
   * `unit.ulpin` is UNIQUE NOT NULL, so the cores, the aisles, the lobby and
   * the plant room need one here even though the snapshot carries none and
   * the API strips it. Minted from the kind's slot prefix and the ordinal
   * in the code ('AISLE-2' -> C02), which is what the exporter would have
   * written; two aisles on one level therefore stay distinct.
   */
  const dbUlpin = (u) => {
    if (u.ulpin) return u.ulpin;
    const floorEntry = floorByLevel.get(u.level_no);
    const m = /-(\d+)$/.exec(u.unit_no);
    const ordinal = m ? Number(m[1]) : undefined;
    return `${floorEntry.ulpin}-${unitSlot(u.kind, ordinal)}`;
  };
  /** Enclosed area of a volume's ring, m², for the NOT NULL area columns. */
  const enclosedM2 = (u) => {
    const r = u.ring.coordinates[0];
    const w = Math.abs(r[1][0] - r[0][0]) * 111000;
    const h = Math.abs(r[2][1] - r[1][1]) * 111000;
    return Math.round(w * h * 10) / 10;
  };

  try {
    const { rows } = await client.query(
      'SELECT id FROM projects WHERE slug = $1', [SLUG],
    );
    if (!rows.length) {
      console.log(`PostGIS: project ${SLUG} not seeded, skipping.`);
      return;
    }
    const projectId = rows[0].id;

    await client.query('BEGIN');
    // The new nullable columns, added to db/01_schema.sql. Applied here too so
    // an existing volume does not have to be dropped and re-seeded.
    await client.query(`
      ALTER TABLE unit ADD COLUMN IF NOT EXISTS owner text,
                       ADD COLUMN IF NOT EXISTS address text,
                       ADD COLUMN IF NOT EXISTS facing text,
                       ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'flat',
                       ADD COLUMN IF NOT EXISTS core_ref text,
                       ADD COLUMN IF NOT EXISTS label text`);
    // The CHECK from migration 006. Dropped and re-added rather than created
    // conditionally, so a volume carrying an older, narrower list is widened
    // rather than rejecting the parking bays and cores below.
    await client.query(
      'ALTER TABLE utility ADD COLUMN IF NOT EXISTS building_id integer');
    await client.query('ALTER TABLE unit DROP CONSTRAINT IF EXISTS unit_kind_ck');
    await client.query(`
      ALTER TABLE unit ADD CONSTRAINT unit_kind_ck CHECK (kind IN (
        'flat','retail','anchor','parking',
        'circulation','atrium','elevator','stair','plant'))`);

    // Delete first, in dependency order. floor/unit cascade from building.
    await client.query('DELETE FROM building WHERE id = $1', [BUILDING_ID]);
    await client.query('DELETE FROM parcel WHERE id = $1', [PARCEL_ID]);
    await client.query('DELETE FROM utility WHERE id = ANY($1)', [[99001, 99002, 99003]]);

    await client.query(
      `INSERT INTO parcel (id, ulpin, geom, area_m2, owner, project_id)
       VALUES ($1,$2,ST_GeomFromEWKT($3),$4,$5,$6)`,
      [PARCEL_ID, newParcel.properties.ulpin, ring2d(footprintRing),
        newParcel.properties.area_m2, newParcel.properties.owner, projectId],
    );

    const bp = newBuilding.properties;
    await client.query(
      `INSERT INTO building (id, parcel_id, ulpin, footprint, height_m, floors,
                             basements, ground_elev, use_type, height_source,
                             survey_synthetic, osm_id, name, address, project_id,
                             ground_source, flood_risk, cyclone_risk,
                             flood_score, cyclone_score, coast_dist_m,
                             local_relief_m)
       VALUES ($1,$2,$3,ST_GeomFromEWKT($4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
               $17,$18,$19,$20,$21,$22)`,
      [BUILDING_ID, PARCEL_ID, bp.ulpin, ring2d(footprintRing), bp.height_m,
        bp.floors, bp.basements, bp.ground_elev, bp.use_type, bp.height_source,
        bp.survey_synthetic, bp.osm_id, bp.name, bp.address, projectId,
        bp.ground_source, bp.flood_risk, bp.cyclone_risk, bp.flood_score,
        bp.cyclone_score, bp.coast_dist_m, bp.local_relief_m],
    );

    for (const f of floors) {
      await client.query(
        // floor.geom is a PolyhedralSurfaceZ too: a storey is the solid
        // between its two heights, not a flat plate.
        `INSERT INTO floor (id, building_id, ulpin, level_no, z_min, z_max,
                            geom, detect_source)
         VALUES ($1,$2,$3,$4,$5,$6,make_prism(ST_GeomFromEWKT($7),$5,$6),$8)`,
        [f.id, BUILDING_ID, f.ulpin, f.level_no, f.z_min, f.z_max,
          ring2d(footprintRing), f.detect_source],
      );
    }

    for (const u of units) {
      // geom_3d is a PolyhedralSurfaceZ. make_prism() in db/02_functions.sql
      // is the project's own extruder -- written by hand precisely because
      // ST_Extrude needs SFCGAL, which this image does not carry -- and it is
      // what seed.py uses for every other unit. Using it here means the demo
      // flats are the same kind of solid as the rest of the cadastre, so the
      // 3D conflict tests treat them identically.
      await client.query(
        `INSERT INTO unit (id, floor_id, ulpin, unit_no, geom_3d, z_min, z_max,
                           carpet_m2, built_m2, tenure, encumbrance,
                           owner, address, facing, kind, core_ref, label)
         VALUES ($1,$2,$3,$4,
                 make_prism(ST_GeomFromEWKT($5), $6, $7),
                 $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [u.id, u.floor_id, dbUlpin(u), u.unit_no,
          ring2d(u.ring.coordinates[0]), u.z_min, u.z_max,
          // A volume without an identity has no areas or tenure in the
          // snapshot; the columns are NOT NULL here, so the enclosed area and
          // 'Common area' stand in. The API never serves them: see
          // stripCoreIdentity in lib/auth/access-pure.ts.
          u.carpet_m2 ?? enclosedM2(u), u.built_m2 ?? enclosedM2(u),
          u.tenure ?? 'Common area', u.encumbrance ?? 'None',
          u.owner ?? null, u.address ?? null, u.facing ?? null,
          // A flat carries no `kind` in the row objects above, so the column
          // default is spelled out here rather than relying on the INSERT
          // omitting it -- it cannot, the column is in the list.
          u.kind ?? 'flat', u.core_ref ?? null, u.label ?? null],
      );
    }

    for (const f of [waterRiser, sewerLateral, sewerTank]) {
      const p = f.properties;
      const ewkt = `SRID=4326;LINESTRING Z(${
        f.geometry.coordinates.map(([x, y, z]) => `${x} ${y} ${z}`).join(',')})`;
      // envelope_3d stays NULL: it is the solid corridor the 3D conflict test
      // intersects against, and these three runs are internal to the building
      // and flagged in_conflict:false. The column is nullable for exactly
      // this case, and a wrong solid would be worse than no solid.
      await client.query(
        `INSERT INTO utility (id, asset_type, geom_3d, envelope_3d, depth_m,
                              radius_m, authority, status, project_id,
                              building_id)
         VALUES ($1,$2,ST_GeomFromEWKT($3),NULL,$4,$5,$6,$7,$8,$9)`,
        [p.id, p.asset_type, ewkt, p.depth_m, p.radius_m,
          p.authority, p.status, projectId,
          // These three serve this building, not a street. The snapshot has
          // always said so; until migration 006 the database had nowhere to.
          p.building_id ?? null],
      );
    }

    // The ISO 19152 projection, rebuilt from the rows just written so the
    // Legal tab on PostGIS describes the same bays and flats the snapshot
    // does. The function deletes and recreates the project's LADM rows, so
    // it is safe to run on every seed.
    let ladmNote = 'LADM tables absent, backfill skipped';
    try {
      const { rows: filled } = await client.query(
        'SELECT * FROM ladm_backfill($1)', [projectId],
      );
      const f = filled[0] ?? {};
      ladmNote = `ladm_backfill: ${f.spatial_units} spatial units, `
        + `${f.ba_units} BA units, ${f.rrrs} rights`;
    } catch (err) {
      ladmNote += ` (${err.message.split('\n')[0]})`;
    }

    await client.query('COMMIT');
    console.log(`PostGIS: building ${BUILDING_ID}, ${floors.length} floors, `
      + `${units.length} volumes, 3 utilities upserted.`);
    console.log(`PostGIS: ${ladmNote}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`PostGIS: FAILED, snapshot is still correct -- ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
