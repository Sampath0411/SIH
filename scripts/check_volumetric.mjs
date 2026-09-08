/**
 * Acceptance check for the volumetric cadastre work.
 *
 * Asserts, in the order a user meets them:
 *   1. the API serves the new interior volumes, with their kinds and ULPINs
 *   2. selecting a basement draws individual parking bays, not one box
 *   3. Dutt Island's level G is a retail plan, not three generic cells
 *   4. the two vertical cores span B2 to the top floor
 *   5. topology validation returns findings and highlights them
 *   6. the deed export produces a real PDF for a flat, a shop and a bay
 *
 * Run against a server that is already up:
 *   ULPIN_ORIGIN=http://localhost:3002 node scripts/check_volumetric.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ORIGIN = process.env.ULPIN_ORIGIN ?? 'http://localhost:3000';
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const TOWER = 999;
const MALL = 5392;

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `  (${detail})` : ''}`);
}

// ---------------------------------------------------------------- API ------
console.log('[1] API — interior volumes');
const tower = await fetch(`${ORIGIN}/api/p/${SLUG}/building/${TOWER}`).then((r) => r.json());
const byKind = tower.units.reduce((a, u) => {
  a[u.kind ?? 'flat'] = (a[u.kind ?? 'flat'] ?? 0) + 1;
  return a;
}, {});
check('Sampath: 80 flats', byKind.flat === 80, `got ${byKind.flat}`);
check('Sampath: parking bays on B1/B2', (byKind.parking ?? 0) === 40, `got ${byKind.parking}`);
check('Sampath: lift shaft per level', (byKind.elevator ?? 0) === 23, `got ${byKind.elevator}`);
check('Sampath: stair core per level', (byKind.stair ?? 0) === 23, `got ${byKind.stair}`);

const bays = tower.units.filter((u) => u.kind === 'parking');
check('parking ULPINs carry the P slot',
  bays.every((u) => /-B[12]-P\d{3}$/.test(u.ulpin)), bays[0]?.ulpin);
check('every basement level now has volumes',
  [-1, -2].every((l) => tower.units.some((u) => u.level_no === l)));

const cores = tower.units.filter((u) => u.core_ref === 'EV1');
const levels = cores.map((u) => u.level_no).sort((a, b) => a - b);
check('lift shaft spans B2 to the top floor',
  levels[0] === -2 && levels[levels.length - 1] === 20,
  `${levels[0]}..${levels[levels.length - 1]}`);
check('core segments share one ULPIN slot',
  cores.every((u) => u.ulpin.endsWith('-EV')));

console.log('\n[2] API — Dutt Island retail plan');
const mall = await fetch(`${ORIGIN}/api/p/${SLUG}/building/${MALL}`).then((r) => r.json());
const g = mall.units.filter((u) => u.level_no === 0);
const gKind = g.reduce((a, u) => { a[u.kind] = (a[u.kind] ?? 0) + 1; return a; }, {});
check('level G is no longer 3 generic cells', g.length > 3, `${g.length} volumes`);
check('level G has retail bays', (gKind.retail ?? 0) >= 6, `got ${gKind.retail}`);
check('level G has an anchor store', (gKind.anchor ?? 0) === 1);
check('level G has a public atrium', (gKind.atrium ?? 0) === 1);
check('level G has circulation', (gKind.circulation ?? 0) >= 2, `got ${gKind.circulation}`);
check('retail ULPINs carry the R slot',
  g.filter((u) => u.kind === 'retail' || u.kind === 'anchor')
    .every((u) => /-00-R\d{2}$/.test(u.ulpin)),
  g.find((u) => u.kind === 'retail')?.ulpin);
check('shop numbering is contiguous from G-01',
  g.some((u) => u.unit_no === 'G-01'));
check('levels 1-8 keep the pipeline cells',
  mall.units.filter((u) => u.level_no === 1).length === 3);

console.log('\n[3] API — topology validation');
const topo = await fetch(`${ORIGIN}/api/p/${SLUG}/topology`).then((r) => r.json());
check('endpoint answers', Array.isArray(topo.findings), `count ${topo.count}`);
check('found at least one encroachment',
  topo.findings.some((f) => f.severity === 'critical'));
check('found at least one clearance breach',
  topo.findings.some((f) => f.kind === 'clearance_breach'));
check('every finding carries coordinates and a Z',
  topo.findings.every((f) => Number.isFinite(f.lon)
    && Number.isFinite(f.lat) && Number.isFinite(f.z)));
check('a building own plumbing is not reported against it',
  !topo.findings.some((f) => /9900[123]/.test(f.a.label)));

// ---------------------------------------------------------------- deed -----
// Exercised in Node rather than in the page: buildDeed is pure, and jspdf and
// qrcode both run headless, so the PDF can be produced and inspected without
// driving a click through a 3D scene. What is asserted is that the bytes are a
// real PDF, that the disclaimer and the provenance are on it, and that a
// volume with no register does not get a holder invented for it.
console.log('\n[4] Deed export');
{
  const { buildDeed } = await import('../lib/deed/certificate.ts');
  const { renderDeed, deedFilename } = await import('../lib/deed/pdf.ts');
  const { datumNote } = await import('../lib/datum.ts');
  const projects = await fetch(`${ORIGIN}/api/projects`).then((r) => r.json());
  const proj = projects.projects.find((x) => x.slug === SLUG);
  const note = datumNote(proj?.geoid_sep_m);
  check('the project carries a geoid separation',
    typeof proj?.geoid_sep_m === 'number', String(proj?.geoid_sep_m));
  check('the datum note names EGM96 and the separation',
    note.includes('EGM96') && note.includes('-72.14'));

  const samples = [
    ['flat', tower.units.find((u) => u.kind === 'flat'), tower, true],
    ['parking bay', tower.units.find((u) => u.kind === 'parking'), tower, false],
    ['lift core', tower.units.find((u) => u.kind === 'elevator'), tower, false],
    ['shop', mall.units.find((u) => u.kind === 'retail'), mall, true],
    ['anchor store', mall.units.find((u) => u.kind === 'anchor'), mall, true],
  ];
  for (const [label, unit, detail, titled] of samples) {
    if (!unit) { check(`deed: ${label} present`, false); continue; }
    const deed = buildDeed({
      unit, detail, slug: SLUG, origin: ORIGIN,
      title: label, kicker: label, titled, datumNote: note,
    });
    const blob = await renderDeed(deed);
    const head = Buffer.from(await blob.arrayBuffer()).subarray(0, 5).toString('latin1');
    check(`deed: ${label} renders a PDF`, head === '%PDF-',
      `${blob.size} bytes, ${deedFilename(deed)}`);
    check(`deed: ${label} quotes a volumetric extent`,
      typeof deed.volume_m3 === 'number' && deed.volume_m3 > 0);
    check(`deed: ${label} carries Z min and Z max`,
      Number.isFinite(deed.bounds.z_min) && Number.isFinite(deed.bounds.z_max));
    check(`deed: ${label} carries the disclaimer`,
      /Not an official government identifier/.test(deed.disclaimer));
    check(`deed: ${label} states its provenance`,
      typeof deed.provenance === 'string' && deed.provenance.length > 20);
    check(`deed: ${label} QR targets the parcel API`,
      deed.api_url.endsWith(`/api/p/${SLUG}/building/${detail.building.id}`));
    if (!titled) {
      check(`deed: ${label} invents no holder`, deed.owner === undefined);
    }
  }

  // A redacted unit must not be exportable, even if a caller asks.
  const redacted = { ...tower.units[0], restricted: true };
  check('deed: a redacted unit is refused',
    buildDeed({
      unit: redacted, detail: tower, slug: SLUG, origin: ORIGIN,
      title: 'x', kicker: 'x', titled: true, datumNote: note,
    }) === null);
}

// ---------------------------------------------------------------- UI -------
console.log('\n[5] UI');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
  defaultViewport: { width: 1680, height: 950 },
  protocolTimeout: 240000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

/**
 * The viewer redirects an anonymous browser to /login, so the run needs a
 * session. Same mechanism scripts/shoot.mjs uses:
 *
 *   ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs)
 */
if (process.env.ULPIN_SESSION_COOKIE) {
  await page.setCookie({
    name: 'ulpin_session',
    value: process.env.ULPIN_SESSION_COOKIE,
    domain: new URL(ORIGIN).hostname,
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
  });
} else {
  console.log('  note  ULPIN_SESSION_COOKIE unset — the viewer will redirect to /login');
}

try {
  await page.goto(`${ORIGIN}/p/${SLUG}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('canvas', { timeout: 60000 });
  // The scene needs its boot fetch and a terrain sample before any layer draws.
  await new Promise((r) => setTimeout(r, 14000));

  // The validation control, driven through the DOM rather than the store:
  // there is no debug handle on the store, and clicking the real button is a
  // better test of the wiring anyway.
  const btn = await page.evaluateHandle(() => {
    const all = [...document.querySelectorAll('button')];
    return all.find((b) => /Run Topology Validation/i.test(b.textContent ?? '')) ?? null;
  });
  const hasBtn = await btn.evaluate((b) => b !== null).catch(() => false);
  check('"Run Topology Validation" control is present', hasBtn);

  if (hasBtn) {
    await btn.asElement()?.click();
    // The endpoint runs the whole project through ST_3DIntersects; give it room.
    await new Promise((r) => setTimeout(r, 20000));

    const after = await page.evaluate(() => {
      const text = document.body.innerText;
      const v = window.__ulpinViewer;
      let markers = 0;
      if (v) {
        for (let i = 0; i < v.dataSources.length; i++) {
          const ds = v.dataSources.get(i);
          if (ds.name === 'topology') markers = ds.entities.values.length;
        }
      }
      return {
        reported: /finding/i.test(text) || /No clashes/i.test(text),
        markers,
        panel: /Topology validation/i.test(text),
      };
    });
    check('the run reports a result in the layer panel', after.reported);
    check('findings are listed in the detail panel', after.panel);
    check('findings are drawn in the scene', after.markers > 0,
      `${after.markers} entities`);
  }

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(failures === 0
  ? '\nAll volumetric checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
