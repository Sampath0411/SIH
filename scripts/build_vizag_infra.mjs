/**
 * Build the `vizag-infra` project snapshot from the two site specs.
 *
 * Run with:  npm run build:vizag
 *
 * WHY A SCRIPT AND NOT HAND-WRITTEN JSON. The cadastre rows, the street
 * centrelines and the utility runs for this project are all DERIVED from the
 * same two files in data/api/vizag-infra/infra/. Deriving them by hand would
 * mean four places to keep in step every time a platform moves; deriving them
 * here means the snapshot is reproducible and a spec edit is one command away
 * from being on screen. This is the same arrangement scripts/build_roads.mjs
 * has with the OSM extract, and the output is committed for the same reason.
 *
 * WHAT IS AND IS NOT REAL. The anchors are real coordinates and the `facts`
 * blocks in the specs are sourced and cited. Everything this script writes --
 * footprints, parcel boundaries, street centrelines, and every metre of the
 * utility network -- is DERIVED or DEMONSTRATION, and each record says so in
 * the field the viewer reads: `height_source`, `name_source`, `provenance`.
 * Nothing here is presented as a survey.
 *
 * NO NETWORK, NO DATABASE, NO GDAL. The project is snapshot-only by design:
 * lib/projects.ts serves it from data/api/<slug>/ with docker down.
 */
import fs from 'node:fs';
import path from 'node:path';
import { placeSite, siteExtent } from '../lib/infra/build.ts';
import { UNDERGROUND_LAYERS } from '../lib/underground/categories.ts';
import { generate as ulpin } from '../lib/ulpin.ts';

const SLUG = 'vizag-infra';
const NAME = 'Visakhapatnam Central Corridor';
const STATE = 'AP';
const DISTRICT = 'VSP';
const SCHEME = '3D26';

/**
 * Identifier bases.
 *
 * Both are chosen to sit clear of every id and every ULPIN the other projects
 * already mint. Siripuram numbers its parcels 1..326 and Hyderabad 1..1309, so
 * a parcel numbered 9001 here can never collide in the `ulpin` UNIQUE index --
 * which matters because this project shares AP/VSP/3D26 with Siripuram, and
 * the ULPIN's revenue prefix is normally what keeps two projects apart.
 */
const PARCEL_NO_BASE = 9001;
const BUILDING_ID_BASE = 940001;
const PARCEL_ID_BASE = 941001;
const UTILITY_ID_BASE = 942001;
const ROAD_ID_BASE = 1;

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'data', 'api', SLUG);
const INFRA = path.join(OUT, 'infra');

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf-8');

// ---------------------------------------------------------------- specs ---
const specs = fs.readdirSync(INFRA)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => readJson(path.join(INFRA, f)));

if (specs.length === 0) throw new Error(`no site specs under ${INFRA}`);

// Placed at datum 0: this script produces GEOGRAPHY, and the height a
// structure is drawn at is resolved against terrain in the browser.
const sites = specs.map((s) => placeSite(s, 0));

// --------------------------------------------------------------- bbox -----
let west = Infinity;
let south = Infinity;
let east = -Infinity;
let north = -Infinity;
for (const site of sites) {
  const [w, s, e, n] = siteExtent(site);
  west = Math.min(west, w);
  south = Math.min(south, s);
  east = Math.max(east, e);
  north = Math.max(north, n);
}
// A margin, so the framed view is of the structures rather than flush to them.
const PAD = 0.0016;
const bbox = [
  +(west - PAD).toFixed(5), +(south - PAD).toFixed(5),
  +(east + PAD).toFixed(5), +(north + PAD).toFixed(5),
];

/** Ring flats ([lon,lat,...]) back to GeoJSON coordinate pairs. */
const toRing = (flat) => {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) out.push([+flat[i].toFixed(7), +flat[i + 1].toFixed(7)]);
  return out;
};

/** Shoelace area of a lon/lat ring, m². */
function ringAreaM2(ring) {
  const lat0 = ring[0][1];
  const mLon = mPerDegLon(lat0);
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * mLon;
    const y1 = ring[i][1] * M_PER_DEG_LAT;
    const x2 = ring[i + 1][0] * mLon;
    const y2 = ring[i + 1][1] * M_PER_DEG_LAT;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** Axis-aligned hull of a site, as a parcel-style ring. */
function extentRing(site, padM) {
  const [w, s, e, n] = siteExtent(site);
  const mLon = mPerDegLon((s + n) / 2);
  const dx = padM / mLon;
  const dy = padM / M_PER_DEG_LAT;
  const r = (v) => +v.toFixed(7);
  return [
    [r(w - dx), r(s - dy)], [r(e + dx), r(s - dy)],
    [r(e + dx), r(n + dy)], [r(w - dx), r(n + dy)], [r(w - dx), r(s - dy)],
  ];
}

// ------------------------------------------------------------- parcels ----
const parcels = [];
const parcelById = new Map();
sites.forEach((site, i) => {
  const id = PARCEL_ID_BASE + i;
  const no = PARCEL_NO_BASE + i;
  const ring = extentRing(site, site.kind === 'flyover' ? 12 : 30);
  const owner = site.kind === 'railway_station'
    ? 'South Coast Railway (Indian Railways)'
    : 'Greater Visakhapatnam Municipal Corporation';
  const props = {
    id,
    ulpin: ulpin(no, undefined, undefined, undefined,
      { state: STATE, district: DISTRICT, scheme: SCHEME }),
    area_m2: Math.round(ringAreaM2(ring)),
    owner,
  };
  parcelById.set(site.id, props);
  parcels.push({
    type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring] }, properties: props,
  });
});

// ----------------------------------------------------------- buildings ----
//
// Only the components that genuinely ARE buildings. A platform is not a
// building and forcing one into the cadastre would mean minting it a ULPIN, an
// owner and a tenure that do not exist.
const BUILDING_KINDS = new Set(['station_building', 'concourse']);
const buildings = [];
const detail = {};
let bIdx = 0;
for (const site of sites) {
  const parcel = parcelById.get(site.id);
  const parcelNo = PARCEL_NO_BASE + sites.indexOf(site);
  for (const c of site.components) {
    if (!BUILDING_KINDS.has(c.kind) || c.rings.length === 0) continue;
    const id = BUILDING_ID_BASE + bIdx;
    bIdx += 1;
    const ring = toRing(c.rings[0]);
    const height = c.top[0] - c.base[0];
    const props = {
      id,
      ulpin: ulpin(parcelNo, bIdx, undefined, undefined,
        { state: STATE, district: DISTRICT, scheme: SCHEME }),
      parcel_id: parcel.id,
      height_m: +height.toFixed(1),
      floors: Math.max(1, Math.round(height / 4.2)),
      basements: c.kind === 'concourse' ? 1 : 0,
      // No DEM was clipped for this AOI, so the schema's placeholder is what
      // this is and what it says it is.
      ground_elev: 12.0,
      ground_source: 'placeholder',
      use_type: 'institutional',
      // Derived from the authored spec, not measured. 'estimated' is the
      // provenance value that means exactly that.
      height_source: 'estimated',
      survey_synthetic: false,
      name: c.label,
      address: `${site.name}, Visakhapatnam, Andhra Pradesh`,
      osm_id: 0,
    };
    buildings.push({
      type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring] }, properties: props,
    });
    detail[String(id)] = {
      building: { ...props, footprint: { type: 'Polygon', coordinates: [ring] } },
      parcel,
      // No floor plan and no unit register exist for either structure. Empty is
      // the honest answer; a generated stack would be an invented one.
      floors: [],
      units: [],
    };
  }
}

// --------------------------------------------------------------- roads ----
const roads = [];
let rIdx = 0;
for (const site of sites) {
  const spec = specs.find((s) => s.id === site.id);
  for (const c of spec.components) {
    if (c.kind !== 'road' || c.shape !== 'strip') continue;
    const placed = site.components.find((p) => p.ref === c.ref);
    if (!placed) continue;
    // The centreline, recovered from the drawn quads: each quad's two mid-edge
    // points are the segment's own ends.
    const line = [];
    placed.rings.forEach((flat, i) => {
      const pts = toRing(flat);
      const mid = (a, b) => [+((a[0] + b[0]) / 2).toFixed(7), +((a[1] + b[1]) / 2).toFixed(7)];
      if (i === 0) line.push(mid(pts[0], pts[3]));
      line.push(mid(pts[1], pts[2]));
    });
    if (line.length < 2) continue;

    let lengthM = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const mLon = mPerDegLon(line[i][1]);
      lengthM += Math.hypot(
        (line[i + 1][0] - line[i][0]) * mLon,
        (line[i + 1][1] - line[i][1]) * M_PER_DEG_LAT,
      );
    }

    // Two of these carry names the source actually publishes; the rest are
    // ours. name_source is what tells the two apart on screen.
    const sourced = /Dondaparthi|Asilmetta/.test(c.label ?? '');
    rIdx += 1;
    roads.push({
      type: 'Feature',
      id: ROAD_ID_BASE + rIdx - 1,
      geometry: { type: 'MultiLineString', coordinates: [line] },
      properties: {
        id: ROAD_ID_BASE + rIdx - 1,
        ref: `STR-${String(rIdx).padStart(3, '0')}`,
        name: c.label ?? 'Road',
        alt_name: null,
        name_source: sourced ? 'reference' : 'derived',
        derived_from: sourced ? 'Wikipedia: Telugu Thalli Flyover' : site.name,
        cls: sourced ? 'primary' : 'service',
        length_m: Math.round(lengthM),
        segments: line.length - 1,
        osm_ids: [],
        oneway: false,
        lanes: c.meta?.Lanes ?? null,
        surface: 'asphalt',
      },
    });
  }
}

// ----------------------------------------------------------- utilities ----
//
// DEMONSTRATION DATA. Generated by running one corridor per category along the
// street centrelines authored above, at the depth lib/underground/categories.ts
// states for that category. No utility survey, GIS layer or authority drawing
// was consulted for either site, and every record carries
// provenance: 'demonstration' so the viewer says so on the face of the card.
const AUTHORITY = {
  water: 'GVMC Water Supply',
  sewer: 'GVMC Sewerage Board',
  electrical: 'APEPDCL',
  telecom: 'BSNL',
  drainage: 'GVMC Storm Water Drainage',
};
/** The stored asset_type each display category is written as. */
const ASSET_TYPE = {
  water: 'water', sewer: 'sewer', electrical: 'power',
  telecom: 'telecom', drainage: 'drainage',
};
const MATERIAL = {
  water: 'Ductile iron', sewer: 'RCC NP3', electrical: 'HDPE duct bank',
  telecom: 'HDPE microduct', drainage: 'RCC box culvert',
};
const DIAMETER_MM = {
  water: 300, sewer: 450, electrical: 160, telecom: 110, drainage: 900,
};
const RADIUS_M = {
  water: 0.25, sewer: 0.35, electrical: 0.2, telecom: 0.15, drainage: 0.6,
};

const CATEGORIES = ['water', 'sewer', 'electrical', 'telecom', 'drainage'];
const utilities = [];
let uIdx = 0;
for (const site of sites) {
  const siteRoads = roads.filter((r) => r.properties.derived_from === site.name
    || /Dondaparthi|Asilmetta/.test(r.properties.name));
  for (const cat of CATEGORIES) {
    const layer = UNDERGROUND_LAYERS.find((l) => l.key === cat);
    for (const r of siteRoads) {
      const line = r.geometry.coordinates[0];
      if (line.length < 2) continue;
      uIdx += 1;
      const id = UTILITY_ID_BASE + uIdx - 1;
      utilities.push({
        type: 'Feature',
        id,
        geometry: {
          type: 'LineString',
          // 2D on purpose. Depth is a PROPERTY, resolved against the terrain
          // under each vertex at draw time -- baking one absolute Z per run is
          // precisely the mistake the underground redesign removed.
          coordinates: line.map((c) => [c[0], c[1]]),
        },
        properties: {
          id,
          ref: `${site.kind === 'flyover' ? 'TTF' : 'VSKP'}-${cat.slice(0, 3).toUpperCase()}-${String(uIdx).padStart(3, '0')}`,
          asset_type: ASSET_TYPE[cat],
          depth_m: layer.band.nominal,
          radius_m: RADIUS_M[cat],
          diameter_mm: DIAMETER_MM[cat],
          material: MATERIAL[cat],
          authority: AUTHORITY[cat],
          connected_area: site.name,
          status: 'operational',
          in_conflict: false,
          provenance: 'demonstration',
        },
      });
    }
  }
}

// ---------------------------------------------------------------- write ---
const fc = (features, extra = {}) => ({
  type: 'FeatureCollection', features, ...extra,
});

const DISCLAIMER = 'DERIVED for demonstration from the site specifications in '
  + 'data/api/vizag-infra/infra/ — not a survey, a cadastral record or an '
  + 'as-built drawing.';

writeJson(path.join(OUT, 'buildings.json'), fc(buildings, { aoi: NAME, _disclaimer: DISCLAIMER }));
writeJson(path.join(OUT, 'parcels.json'), fc(parcels, { _disclaimer: DISCLAIMER }));
writeJson(path.join(OUT, 'roads.json'), fc(roads, { _disclaimer: DISCLAIMER }));
writeJson(path.join(OUT, 'utilities.json'), fc(utilities, {
  _disclaimer: 'DEMONSTRATION DATA. No utility survey was consulted. Alignments '
    + 'follow the derived street centrelines; depths are the nominal band for '
    + 'each category in lib/underground/categories.ts.',
}));
writeJson(path.join(OUT, 'conflicts.json'), []);
writeJson(path.join(OUT, 'detail.json'), detail);

// A light index, so the site navigator can list what exists without pulling a
// whole structure. The specs themselves are fetched only when a site is opened.
writeJson(path.join(OUT, 'sites.json'), {
  sites: sites.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    summary: s.summary,
    anchor: s.anchor,
    extent: siteExtent(s).map((v) => +v.toFixed(6)),
    components: s.components.length,
  })),
});

// ------------------------------------------------------------- registry ---
const registryPath = path.join(ROOT, 'data', 'api', 'projects.json');
const registry = readJson(registryPath);
const stats = {
  units: 0,
  floors: 0,
  parcels: parcels.length,
  streets: roads.length,
  buildings: buildings.length,
  conflicts: 0,
  utilities: utilities.length,
};
const row = {
  slug: SLUG,
  name: NAME,
  bbox,
  state_code: STATE,
  district_code: DISTRICT,
  scheme_code: SCHEME,
  status: 'ready',
  // No CartoDEM tile was clipped for this AOI, so every building carries the
  // 12.0 m default and the registry says which of the two that is.
  elev_source: 'placeholder',
  elev_datum: null,
  bhuvan_layers: null,
  created_at: '2026-09-06T00:00:00.000Z',
  stats,
};
const i = registry.projects.findIndex((p) => p.slug === SLUG);
if (i >= 0) registry.projects[i] = row;
else registry.projects.push(row);
writeJson(registryPath, registry);

console.log(`${SLUG}: ${sites.length} sites, `
  + `${sites.reduce((n, s) => n + s.components.length, 0)} components`);
console.log(`  bbox      ${bbox.join(', ')}`);
console.log(`  buildings ${buildings.length}   parcels ${parcels.length}   `
  + `streets ${roads.length}   utilities ${utilities.length}`);
console.log(`  written to data/api/${SLUG}/`);
