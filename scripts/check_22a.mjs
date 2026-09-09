/**
 * Acceptance check for the Section 22A restricted-land layer.
 *
 * Drives the real app and asserts the things that would make the feature a lie
 * if they were wrong: that the register on the wire declares what it is, that
 * the polygons drawn are the CADASTRE'S OWN and were not reshaped, that turning
 * the layer on leaves the rest of the scene exactly where it was, that clicking
 * a marked plot opens the entry for THAT plot, that the card carries the
 * disclaimer verbatim, and that turning the layer off removes it completely.
 *
 * The wording checks are assertions, not copy review. A crimson polygon labelled
 * "22A · Restricted" on a government-looking 3D cadastre is the most consequential
 * thing this application draws -- someone could decide not to buy land over it --
 * and every word that qualifies that claim is therefore tested. The strings are
 * imported from lib/section22a/types.ts, so the card and the check cannot drift.
 *
 * Usage:
 *   node scripts/check_22a.mjs
 *   ULPIN_URL=http://localhost:3001/p/siripuram node scripts/check_22a.mjs
 *
 * Run it against BOTH backends -- `docker compose start` and `docker compose
 * stop`. The register is one committed file read on both paths, and the whole
 * point of that decision is that the two agree; this is what proves it.
 *
 * Needs a signed session cookie, like the other browser checks here:
 *   ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  SECTION_22A_DISCLAIMER, SECTION_22A_MOCK_NOTE,
} from '../lib/section22a/types.ts';

const OUT = path.join(process.cwd(), 'docs', 'shots', '22a');
const URL = process.env.ULPIN_URL ?? 'http://localhost:3000/p/siripuram';
const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Derived from ULPIN_URL, so the second project cannot be compared against
 *  the first one's snapshot -- which would pass, because both have parcels. */
const SLUG = (/\/p\/([a-z0-9-]+)/.exec(URL)?.[1]) ?? 'siripuram';
const API = path.join(process.cwd(), 'data', 'api', SLUG);

mkdirSync(OUT, { recursive: true });

const BUILDING_COUNT = JSON.parse(
  readFileSync(path.join(API, 'buildings.json'), 'utf-8'),
).features.length;

/** The viewer is auth-gated; without this every navigation lands on /login. */
async function applySession(page, url) {
  const value = process.env.ULPIN_SESSION_COOKIE;
  if (!value) return;
  const u = new globalThis.URL(url);
  await page.setCookie({
    name: 'ulpin_session', value, domain: u.hostname, path: '/',
    httpOnly: true, sameSite: 'Lax',
  });
}

const PROTOCOL_TIMEOUT_MS = 900000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const bodyText = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
const shot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`  shot -> ${name}.png`);
};

/** Entities across every data source whose name starts with `prefix`. */
const countEntities = (page, prefix) => page.evaluate((p) => {
  const v = window.__ulpinViewer;
  if (!v) return -1;
  let n = 0;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (ds.name.startsWith(p)) n += ds.entities.values.length;
  }
  return n;
}, prefix);

/**
 * How many entities under this prefix are actually being DRAWN.
 *
 * Entity-level, not `dataSource.show`: BuildingsLayer hides itself through a
 * CallbackProperty on `polygon.show` and leaves its data sources visible, so a
 * data-source check reports the 3D city as on screen when every building in it
 * is invisible. Lifted from check_gis2d.mjs, which learned that the hard way.
 */
const drawn = (page, prefix) => page.evaluate((p) => {
  const v = window.__ulpinViewer;
  if (!v) return -1;
  const t = v.clock.currentTime;
  let n = 0;
  for (let i = 0; i < v.dataSources.length; i++) {
    const ds = v.dataSources.get(i);
    if (!ds.name.startsWith(p) || !ds.show) continue;
    for (const e of ds.entities.values) {
      const g = e.polygon ?? e.polyline ?? e.label;
      const show = g?.show;
      const on = show === undefined
        ? true
        : (typeof show.getValue === 'function' ? show.getValue(t) : show);
      if (on) n++;
    }
  }
  return n;
}, prefix);

const cameraPose = (page) => page.evaluate(() => {
  const c = window.__ulpinViewer.camera;
  return {
    lon: (c.positionCartographic.longitude * 180) / Math.PI,
    lat: (c.positionCartographic.latitude * 180) / Math.PI,
    height: c.positionCartographic.height,
    heading: (c.heading * 180) / Math.PI,
    pitch: (c.pitch * 180) / Math.PI,
  };
});

const clickToggle = (page) => page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')]
    .find((b) => /^22A( ✓)?$/.test(b.textContent.trim()));
  if (!btn) return false;
  btn.click();
  return true;
});

/**
 * The pole of inaccessibility of a ring, in degrees.
 *
 * The centroid is not good enough and the reason is the same one
 * SurveyParcelsLayer gives for its labels: a plot clipped around a junction is
 * often an L, and the average of its vertices lands on the neighbour's land --
 * so a click there would select the neighbour and this check would fail while
 * the application was correct. Reimplemented rather than imported from
 * lib/geo.ts only because that module is Cesium-adjacent; the algorithm is the
 * simple grid refinement, which is plenty for a click target.
 */
function poleOf(ring) {
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  let best = null;
  let minX = Math.min(...xs); let maxX = Math.max(...xs);
  let minY = Math.min(...ys); let maxY = Math.max(...ys);
  const inside = (x, y) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        hit = !hit;
      }
    }
    return hit;
  };
  const distToEdge = (x, y) => {
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const dx = xj - xi; const dy = yj - yi;
      const len = dx * dx + dy * dy;
      let t = len > 0 ? ((x - xi) * dx + (y - yi) * dy) / len : 0;
      t = Math.max(0, Math.min(1, t));
      const px = xi + t * dx; const py = yi + t * dy;
      d = Math.min(d, Math.hypot(x - px, y - py));
    }
    return d;
  };
  for (let pass = 0; pass < 6; pass++) {
    const stepX = (maxX - minX) / 12;
    const stepY = (maxY - minY) / 12;
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        const x = minX + i * stepX;
        const y = minY + j * stepY;
        if (!inside(x, y)) continue;
        const d = distToEdge(x, y);
        if (!best || d > best.d) best = { x, y, d };
      }
    }
    if (!best) break;
    minX = best.x - stepX; maxX = best.x + stepX;
    minY = best.y - stepY; maxY = best.y + stepY;
  }
  return best ? [best.x, best.y] : [xs[0], ys[0]];
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: PROTOCOL_TIMEOUT_MS,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    '--no-sandbox',
    '--window-size=1680,950',
  ],
  defaultViewport: { width: 1680, height: 950 },
});

try {
  const page = await browser.newPage();
  await applySession(page, URL);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log(`navigating to ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 120000 });
  await page.waitForFunction(
    (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
    { timeout: 300000 }, BUILDING_COUNT,
  );
  await sleep(8000);

  // ------------------------------------------------------------------ DATA
  console.log('\n[1] THE REGISTER ON THE WIRE');
  const api = await page.evaluate(async (slug) => {
    const res = await fetch(`/api/p/${slug}/section-22a`);
    return {
      status: res.status,
      backend: res.headers.get('x-ulpin-backend'),
      source: res.headers.get('x-ulpin-22a-source'),
      body: await res.json(),
    };
  }, SLUG);

  check('GET /section-22a answers 200', api.status === 200, `status ${api.status}`);
  check('it declares which backend served it', Boolean(api.backend),
    `x-ulpin-backend: ${api.backend}`);
  check('it names the register that answered', Boolean(api.source),
    `x-ulpin-22a-source: ${api.source}`);

  const reg = api.body?.register ?? {};
  const feats = api.body?.features ?? [];
  check('records were served', feats.length > 0, `${feats.length} drawn`);
  check('the register says how many entries it holds',
    typeof reg.record_count === 'number' && reg.record_count >= feats.length,
    `${feats.length} drawn of ${reg.record_count} listed`);
  check('entries that could not be placed are reported, not dropped',
    reg.record_count - feats.length === reg.unlocated_count,
    `${reg.unlocated_count} not located`);
  check('the register declares whether it is authoritative',
    typeof reg.authoritative === 'boolean',
    `authoritative: ${reg.authoritative}`);
  check('a non-authoritative register says so on the wire',
    reg.authoritative || String(api.body._disclaimer).includes(SECTION_22A_MOCK_NOTE),
    reg.authoritative ? 'n/a — register claims authority' : 'mock note present');
  check('every entry carries the fields the card needs',
    feats.every((f) => f.properties.survey_no && f.properties.location.village
      && f.properties.location.mandal && f.properties.location.district
      && f.properties.category && f.properties.status === '22A_RESTRICTED'),
    'survey no, village, mandal, district, category, status');

  // THE GUARANTEE: the layer marks land, it does not redraw it.
  const parcels = await page.evaluate(async (slug) => {
    const res = await fetch(`/api/p/${slug}/survey-parcels`);
    return (await res.json()).features;
  }, SLUG);
  const byId = new Map(parcels.map((f) => [f.properties.id, f]));
  const matched = feats.filter((f) => f.properties.geometry_source === 'cadastre_match');
  check('every drawn boundary is the cadastral parcel it names, unmodified',
    matched.every((f) => {
      const p = byId.get(f.properties.parcel_id);
      return p && JSON.stringify(p.geometry) === JSON.stringify(f.geometry);
    }),
    `${matched.length} matched entries compared vertex for vertex`);

  const aliasMatch = await page.evaluate(async (slug) => {
    const [a, b] = await Promise.all([
      fetch('/api/section-22a').then((r) => r.text()),
      fetch(`/api/p/${slug}/section-22a`).then((r) => r.text()),
    ]);
    return a === b;
  }, SLUG);
  check('alias and scoped route are byte-identical',
    aliasMatch || SLUG !== 'siripuram',
    SLUG === 'siripuram' ? '' : 'n/a — alias points at the demo project');

  // ------------------------------------------------------ BEFORE THE LAYER
  console.log('\n[2] THE SCENE, BEFORE');
  const before = {
    buildings: await drawn(page, 'buildings'),
    parcels: await countEntities(page, 'parcels'),
    roads: await countEntities(page, 'roads'),
    restricted: await countEntities(page, 'section-22a'),
    pose: await cameraPose(page),
  };
  check('the 22A layer has drawn nothing yet', before.restricted === 0,
    `${before.restricted} entities`);
  check('buildings are on screen', before.buildings > 0,
    `${before.buildings} drawn`);
  await shot(page, 'before');

  // ------------------------------------------------------------- TOGGLE ON
  console.log('\n[3] TOGGLE ON');
  check('the 22A control exists', await clickToggle(page));
  await page.waitForFunction(() => {
    const v = window.__ulpinViewer;
    if (!v) return false;
    for (let i = 0; i < v.dataSources.length; i++) {
      const ds = v.dataSources.get(i);
      if (ds.name === 'section-22a' && ds.entities.values.length > 0) return true;
    }
    return false;
  }, { timeout: 60000 });
  await sleep(2500);

  const after = {
    buildings: await drawn(page, 'buildings'),
    parcels: await countEntities(page, 'parcels'),
    roads: await countEntities(page, 'roads'),
    restricted: await drawn(page, 'section-22a'),
    pose: await cameraPose(page),
  };

  // Four entities per plot: tint, hatch, boundary, label.
  check('every located entry is drawn', after.restricted === feats.length * 4,
    `${after.restricted} entities for ${feats.length} parcels`);
  check('the 3D buildings are still on screen',
    after.buildings === before.buildings,
    `${before.buildings} -> ${after.buildings}`);
  check('the streets were not reloaded', after.roads === before.roads,
    `${before.roads} -> ${after.roads}`);
  check('the parcel layer was not reloaded', after.parcels === before.parcels,
    `${before.parcels} -> ${after.parcels}`);
  check('the camera did not move',
    Math.abs(after.pose.height - before.pose.height) < 1
    && Math.abs(after.pose.pitch - before.pose.pitch) < 0.5,
    `${before.pose.height.toFixed(0)} m -> ${after.pose.height.toFixed(0)} m`);

  const legend = await bodyText(page);
  check('the legend keys the layer', /22A restricted land/i.test(legend));
  check('the legend says the parcels are restricted or prohibited',
    /Restricted \/ prohibited parcel/i.test(legend));
  check('the legend reports entries it could not place',
    reg.unlocated_count === 0 || /not located in this area/i.test(legend),
    `${reg.unlocated_count} unlocated`);
  check('the status bar reports the layer',
    new RegExp(`22A · ${feats.length} restricted`, 'i').test(legend));
  await shot(page, 'on');

  // ----------------------------------------------------------------- CLICK
  console.log('\n[4] CLICK A RESTRICTED PARCEL');
  // The largest drawn plot, so the click target is unambiguous at this zoom.
  const target = [...feats].sort(
    (a, b) => (b.properties.mapped_extent_sqm ?? 0) - (a.properties.mapped_extent_sqm ?? 0),
  )[0];
  const [tLon, tLat] = poleOf(target.geometry.coordinates[0]);

  const at = await page.evaluate(([lon, lat]) => {
    const v = window.__ulpinViewer;
    const carto = {
      longitude: (lon * Math.PI) / 180,
      latitude: (lat * Math.PI) / 180,
      height: 0,
    };
    // AT THE GROUND, not the ellipsoid: these polygons are clamped to terrain
    // and Siripuram's ground runs 20-83 m up, so projecting at height 0 puts
    // the point tens of metres below the surface and the click lands in the
    // neighbouring plot. check_gis2d.mjs documents measuring exactly that.
    const ground = v.scene.globe.getHeight(carto);
    carto.height = typeof ground === 'number' ? ground : 0;
    const cart = v.scene.globe.ellipsoid.cartographicToCartesian(carto);
    const win = v.scene.cartesianToCanvasCoordinates(cart);
    return win ? { x: win.x, y: win.y } : null;
  }, [tLon, tLat]);

  check('the target projects onto the canvas', Boolean(at),
    at ? `${at.x.toFixed(0)}, ${at.y.toFixed(0)}` : 'off screen');

  if (at) {
    await page.mouse.click(at.x, at.y);
    await sleep(2500);
  }
  const panel = await bodyText(page);

  check('the panel opened on the entry that was clicked',
    panel.includes(target.properties.survey_no),
    `clicked ${target.properties.id}, expected survey no ${target.properties.survey_no}`);
  check('the card states the status plainly', /Restricted/.test(panel));
  // Case-insensitive: `panel-title` and the chip both carry `uppercase`, and
  // innerText reports the RENDERED text, so an exact-case match here silently
  // fails -- and worse, the mirror check in [5] would then pass for the wrong
  // reason and stop proving that the card was dismissed.
  check('the card names the section', /section 22a/i.test(panel));
  check('the card carries the village', panel.includes(target.properties.location.village));
  check('the card carries the mandal', panel.includes(target.properties.location.mandal));
  check('the card carries the district', panel.includes(target.properties.location.district));
  check('the card carries the extent in acres', /\d ac\)/.test(panel));
  check('the card names the issuing authority',
    !target.properties.authority || panel.includes(target.properties.authority));

  // The wording. Imported, so the card and this check cannot drift apart.
  const squash = (t) => t.replace(/\s+/g, ' ').trim();
  check('the disclaimer is on the card, verbatim',
    squash(panel).includes(squash(SECTION_22A_DISCLAIMER)));
  check('a demonstration register says so on the card',
    reg.authoritative || squash(panel).includes(squash(SECTION_22A_MOCK_NOTE)),
    reg.authoritative ? 'n/a — register claims authority' : '');
  check('the card does not assert the plot IS legally restricted',
    !/is legally restricted/i.test(panel));
  await shot(page, 'panel');

  // ------------------------------------------------------------ TOGGLE OFF
  console.log('\n[5] TOGGLE OFF');
  check('the control is still there to press', await clickToggle(page));
  await sleep(2000);

  const off = {
    restricted: await drawn(page, 'section-22a'),
    entities: await countEntities(page, 'section-22a'),
    buildings: await drawn(page, 'buildings'),
    pose: await cameraPose(page),
  };
  check('nothing 22A is drawn any more', off.restricted === 0,
    `${off.restricted} drawn`);
  check('the entities were hidden, not rebuilt',
    off.entities === after.restricted,
    `${off.entities} entities retained`);
  check('the rest of the scene is untouched', off.buildings === before.buildings,
    `${before.buildings} -> ${off.buildings}`);
  check('the camera is where it was',
    Math.abs(off.pose.height - before.pose.height) < 1,
    `${before.pose.height.toFixed(0)} m -> ${off.pose.height.toFixed(0)} m`);

  const cleared = await bodyText(page);
  check('the legend key is gone', !/Restricted \/ prohibited parcel/i.test(cleared));
  check('the card is gone', !/section 22a/i.test(cleared));
  await shot(page, 'off');

  // --------------------------------------------------------------- CONSOLE
  console.log('\n[6] CONSOLE');
  const real = errors.filter(
    (e) => !/favicon|ERR_INTERNET_DISCONNECTED|tile\.openstreetmap|openstreetmap\.org/i.test(e)
      && !/arcgisonline\.com|maptiles\.arcgis\.com|cartocdn\.com|api\.mapbox\.com|nrsc\.gov\.in/i.test(e),
  );
  check('no runtime errors', real.length === 0, real.slice(0, 3).join(' | '));

  console.log(
    `\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
}
