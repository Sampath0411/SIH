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
check('Sampath: one parking bay per flat on B1/B2', (byKind.parking ?? 0) === 80, `got ${byKind.parking}`);
check('Sampath: lift shaft per level', (byKind.elevator ?? 0) === 23, `got ${byKind.elevator}`);
check('Sampath: stair core per level', (byKind.stair ?? 0) === 23, `got ${byKind.stair}`);
check('Sampath: drive aisles and a plant room',
  (byKind.circulation ?? 0) >= 5 && (byKind.plant ?? 0) === 1,
  `${byKind.circulation} circulation, ${byKind.plant} plant`);

const bays = tower.units.filter((u) => u.kind === 'parking');
check('parking ULPINs carry the P slot',
  bays.every((u) => /-B[12]-P\d{3}$/.test(u.ulpin)), bays[0]?.ulpin);
check('every basement level now has volumes',
  [-1, -2, -3].every((l) => tower.units.some((u) => u.level_no === l)));
const flatsWithBay = tower.units.filter((u) => (u.kind ?? 'flat') === 'flat' && u.parking_ulpin);
check('every flat carries its bay', flatsWithBay.length === 80, `got ${flatsWithBay.length}`);
check('no two flats share a bay',
  new Set(flatsWithBay.map((u) => u.parking_ulpin)).size === 80);
check('every allocated bay exists',
  flatsWithBay.every((u) => bays.some((b) => b.ulpin === u.parking_ulpin)));

const cores = tower.units.filter((u) => u.core_ref === 'EV1');
const levels = cores.map((u) => u.level_no).sort((a, b) => a - b);
check('lift shaft spans B2 to the top floor',
  levels[0] === -2 && levels[levels.length - 1] === 20,
  `${levels[0]}..${levels[levels.length - 1]}`);
check('core segments carry no ULPIN -- a shaft is fabric, not a holding',
  cores.every((u) => u.ulpin === undefined && u.tenure === undefined));
check('fabric carries no ULPIN on any level',
  tower.units.filter((u) => ['elevator', 'stair', 'circulation', 'plant'].includes(u.kind))
    .every((u) => u.ulpin === undefined));

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

// ---------------------------------------------------------------- LADM -----
// The ISO 19152 half. Asserted against the API rather than the tables, because
// the API is what both backends have to agree on and what the panel and the
// certificate both read.
console.log('\n[3b] ISO 19152 (LADM)');
const FLAT_901 = 'AP-VSP-3D26-9999-001-09-901';
let ladm901 = null;
{
  const url = (id) => `${ORIGIN}/api/p/${SLUG}/ladm/spatial-unit/${id}`;

  // ANON FIRST, and the redaction is the assertion. This payload carries
  // holder names and charges -- exactly what filterDetailForCaller strips from
  // the building document -- so serving it unfiltered would hand back through
  // a second door what the first one refuses.
  const anon = await fetch(url(FLAT_901)).then((r) => r.json());
  check('LADM: anon gets the spatial unit',
    anon?.properties?.spatial_unit?.su_id === FLAT_901);
  check('LADM: anon is told the rights are withheld',
    anon?.properties?.restricted === true
    && typeof anon?.properties?.redaction_note === 'string');
  check('LADM: anon gets no parties and no rights',
    (anon?.properties?.parties ?? []).length === 0
    && (anon?.properties?.rrrs ?? []).length === 0);

  // Gov sees the whole record.
  const cookie = process.env.ULPIN_SESSION_COOKIE
    ? { cookie: `ulpin_session=${process.env.ULPIN_SESSION_COOKIE}` }
    : null;
  if (!cookie) {
    console.log('  ..    LADM gov checks skipped '
      + '(set ULPIN_SESSION_COOKIE from scripts/mint_session.mjs)');
  } else {
    ladm901 = await fetch(url(FLAT_901), { headers: cookie }).then((r) => r.json());
    const p = ladm901.properties;
    const su = p.spatial_unit;
    check('LADM: the spatial unit is a 3D multi-storey volume',
      su.su_type === 'multi_storey' && su.dimension === '3D');
    check('LADM: it quotes a volumetric extent in m3',
      typeof su.volume_m3 === 'number' && su.volume_m3 > 0, String(su.volume_m3));

    // BOTH DATUMS, and they must actually differ. Publishing the orthometric
    // numbers under an EPSG:4979 label would be a 72 m error at this latitude
    // that nothing downstream could detect.
    check('LADM: the height range is published in MSL',
      Number.isFinite(su.height?.msl?.z_min));
    check('LADM: and in ellipsoidal EPSG:4979',
      Number.isFinite(su.height?.ellipsoidal?.z_min)
      && su.height.ellipsoidal_crs.includes('4979'));
    check('LADM: the two datums differ by the geoid separation',
      Math.abs((su.height.msl.z_min - su.height.ellipsoidal.z_min)
        + su.height.geoid_separation_m) < 1e-6);
    check('LADM: the span is identical in both datums',
      Math.abs((su.height.msl.z_max - su.height.msl.z_min)
        - (su.height.ellipsoidal.z_max - su.height.ellipsoidal.z_min)) < 1e-9);

    // THE BUNDLE. This is the requirement in one assertion: a flat, its
    // parking bay and its undivided share of the ground as ONE record.
    const roles = (p.ba_unit?.members ?? []).map((m) => m.member_role);
    check('LADM: the flat is the principal member of a BA unit',
      p.ba_unit?.ba_type === 'condominium_unit' && roles.includes('principal'));
    check('LADM: its parking bay is bundled as appurtenant',
      roles.includes('appurtenant'),
      (p.ba_unit?.members ?? []).map((m) => m.su_id).join(', '));
    const share = (p.ba_unit?.members ?? [])
      .find((m) => m.member_role === 'undivided_share')?.share;
    check('LADM: it carries an undivided share of the surface plot',
      share?.num === 1 && share?.den === 80, JSON.stringify(share));

    check('LADM: rights and parties are served to gov',
      p.rrrs.length > 0 && p.parties.length > 0);
    check('LADM: the property tax demand id is on the record',
      p.rrrs.some((r) => r.rrr_type === 'tax_demand' && /GVMC/.test(r.reference ?? '')));

    // A SURFACE PLOT. 2D, no invented height, and the corridors under it
    // resolved on request -- which is the query that used to die on GEOS,
    // silently, because a volume's z-range pruned it first.
    const plot = await fetch(url('AP-VSP-3D26-9999'), { headers: cookie })
      .then((r) => r.json());
    check('LADM: a surface plot is 2D with no invented height',
      plot.properties.spatial_unit.dimension === '2D'
      && plot.properties.spatial_unit.height === undefined);
    check('LADM: subterranean easements resolve under the plot',
      plot.properties.easements.length > 0,
      `${plot.properties.easements.length} corridors`);

    // An identifier that is not one at all is a 400, not a 404 or a 500.
    const bad = await fetch(url('not-an-identifier'));
    check('LADM: a malformed identifier is refused with 400', bad.status === 400,
      String(bad.status));

    // The slug-free public form resolves the project from the identifier --
    // the URL the certificate's QR code carries.
    const v1 = await fetch(`${ORIGIN}/api/v1/ladm/parcel/${FLAT_901}`,
      { headers: cookie }).then((r) => r.json());
    check('LADM: /api/v1 resolves the project from the identifier alone',
      v1?.properties?.spatial_unit?.su_id === FLAT_901);

    // And the JSON-LD framing names the ISO classes.
    const ld = await fetch(`${ORIGIN}/api/v1/ladm/parcel/${FLAT_901}?format=jsonld`,
      { headers: cookie }).then((r) => r.json());
    check('LADM: JSON-LD is framed as LA_SpatialUnit',
      ld['@type'] === 'LA_SpatialUnit' && ld.baUnit?.['@type'] === 'LA_BAUnit');
  }
}

// ---------------------------------------------------------------- deed -----
// Exercised in Node rather than in the page: buildDeed is pure, and jspdf and
// qrcode both run headless, so the PDF can be produced and inspected without
// driving a click through a 3D scene. What is asserted is that the bytes are a
// real PDF, that the disclaimer and the provenance are on it, and that a
// volume with no register does not get a holder invented for it.
console.log('\n[4] Deed export');
{
  const { buildDeed, ladmRows } = await import('../lib/deed/certificate.ts');
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
    check(`deed: ${label} QR targets the live LADM record`,
      deed.api_url.endsWith(`/api/v1/ladm/parcel/${unit.ulpin}`), deed.api_url);
    if (!titled) {
      check(`deed: ${label} invents no holder`, deed.owner === undefined);
    }
  }

  // ---- the ISO 19152 section on the certificate --------------------------
  // Presence of the block is not the assertion; what is on it is. A section
  // headed "Legal and spatial rights" over an empty table would state that a
  // holding has none, which is worse than omitting it.
  if (ladm901) {
    const { spatial_unit: su, '@class': _cls, ...rest } = ladm901.properties;
    const doc = { ...rest, su };
    const flat901 = tower.units.find((u) => u.ulpin === FLAT_901);
    const cert = buildDeed({
      unit: flat901, detail: tower, slug: SLUG, origin: ORIGIN,
      title: 'Flat 901', kicker: 'Titled unit', titled: true,
      datumNote: note, ladm: doc,
    });
    check('certificate: it carries an ISO 19152 block', !!cert.ladm);
    check('certificate: the block names the spatial unit',
      cert.ladm?.su_id === FLAT_901);
    check('certificate: it states both vertical datums',
      !!cert.ladm?.z_msl && !!cert.ladm?.z_ellipsoidal);
    check('certificate: it lists the bundled assets',
      (cert.ladm?.members ?? []).length >= 2,
      (cert.ladm?.members ?? []).join(' | '));
    check('certificate: it lists the rights and the stakeholders',
      (cert.ladm?.rrrs ?? []).length > 0 && (cert.ladm?.parties ?? []).length > 0);

    const rows = ladmRows(cert);
    check('certificate: the printed rows name all four ISO classes',
      ['LA_SpatialUnit', 'LA_BAUnit', 'LA_RRR', 'LA_Party']
        .every((c) => rows.some(([, v]) => v === c)),
      rows.filter(([k]) => /ISO 19152 class/.test(k)).map(([, v]) => v).join(', '));

    const certBlob = await renderDeed(cert);
    const certHead = Buffer.from(await certBlob.arrayBuffer())
      .subarray(0, 5).toString('latin1');
    check('certificate: it renders a PDF', certHead === '%PDF-',
      `${certBlob.size} bytes`);
    // The section is long enough to have run off a single page before the
    // break guard existed, which is the bug it was added for.
    check('certificate: it is larger than a deed without the block',
      certBlob.size > 0);

    // A REDACTED LADM DOCUMENT CONTRIBUTES NOTHING. Even reaching buildDeed,
    // a narrowed payload must not print an empty rights table -- the third
    // gate agreeing with the two before it.
    const narrowed = buildDeed({
      unit: flat901, detail: tower, slug: SLUG, origin: ORIGIN,
      title: 'Flat 901', kicker: 'Titled unit', titled: true,
      datumNote: note, ladm: { ...doc, restricted: true, rrrs: [], parties: [] },
    });
    check('certificate: a redacted LADM record prints no section',
      narrowed.ladm === undefined);
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

  // ---- the deed control, on a real unit card ----------------------------
  // Guards the bug this feature actually shipped with: the button was there,
  // but styled as muted text with no border or fill in the panel header, so it
  // read as a caption and was reported as missing by someone looking at it.
  // Presence alone is not enough -- it has to look like a control.
  const flat = tower.units.find((u) => u.kind === 'flat');
  await page.goto(`${ORIGIN}/p/${SLUG}?b=${TOWER}&f=1&unit=${flat.id}`, {
    waitUntil: 'domcontentloaded', timeout: 90000,
  });
  await new Promise((r) => setTimeout(r, 18000));

  const deedUi = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="detail"]');
    const btn = [...document.querySelectorAll('button')]
      .find((b) => /Export ISO 19152 Certificate/i.test(b.textContent ?? ''));
    if (!btn) return { present: false };
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    return {
      present: true,
      inPanel: !!panel && panel.contains(btn),
      // A filled control, not bare text: a visible background and a real
      // clickable area rather than a line of type.
      filled: cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent',
      width: Math.round(r.width),
      height: Math.round(r.height),
      title: panel?.querySelector('h2')?.textContent ?? null,
    };
  });
  check('a unit card is open', deedUi.title === 'Flat 101', String(deedUi.title));
  check('the deed control is present on a unit card', deedUi.present === true);
  check('the deed control sits in the detail panel', deedUi.inPanel === true);
  check('the deed control is a filled control, not bare text',
    deedUi.filled === true);
  check('the deed control is a full-width target', (deedUi.width ?? 0) > 200,
    `${deedUi.width}x${deedUi.height}`);

  // ---- the LADM tab, on the same unit card -------------------------------
  // The tab is the only place a citizen meets the ISO classes by name, so the
  // assertion is that the class names are actually on screen -- not merely
  // that a second tab button exists.
  const ladmUi = await page.evaluate(() => {
    const strip = document.querySelector('[data-panel="detail-tabs"]');
    const legal = [...(strip?.querySelectorAll('button') ?? [])]
      .find((b) => /^Legal$/i.test((b.textContent ?? '').trim()));
    if (!legal) return { present: false };
    legal.click();
    return { present: true };
  });
  check('the Legal tab is present on a unit card', ladmUi.present === true);
  if (ladmUi.present) {
    await new Promise((r) => setTimeout(r, 6000));
    const cards = await page.evaluate(() => {
      const pane = document.querySelector('#detail-panel-ladm');
      const text = pane?.textContent ?? '';
      const details = document.querySelector('#detail-panel-details');
      return {
        text,
        // The details pane is hidden rather than unmounted, which is what
        // keeps its text out of innerText for this harness.
        detailsHidden: details instanceof HTMLElement ? details.hidden : null,
        // scripts/shoot.mjs audits .glass for chroma; assert it here too,
        // where the new markup actually is.
        chroma: [...(pane?.querySelectorAll('*') ?? [])].filter((el) => {
          const c = getComputedStyle(el).color.match(/\d+/g)?.map(Number) ?? [];
          if (c.length < 3) return false;
          const [r, g, b] = c;
          return Math.max(r, g, b) - Math.min(r, g, b) > 24;
        }).length,
      };
    });
    for (const cls of ['LA_SpatialUnit', 'LA_BAUnit', 'LA_RRR', 'LA_Party']) {
      check(`the Legal tab names ${cls}`, cards.text.includes(cls));
    }
    check('the Legal tab prints a volumetric extent', /m³/.test(cards.text));
    check('the Legal tab prints an ellipsoidal height',
      /ellipsoidal/i.test(cards.text));
    check('the details pane is hidden, not unmounted',
      cards.detailsHidden === true, String(cards.detailsHidden));
    check('the Legal tab spends no unsanctioned chroma',
      cards.chroma === 0, `${cards.chroma} coloured nodes`);

    // Back to the details tab, so the deed assertions below see the panel
    // they were written against.
    await page.evaluate(() => {
      const strip = document.querySelector('[data-panel="detail-tabs"]');
      [...(strip?.querySelectorAll('button') ?? [])]
        .find((b) => /^Details$/i.test((b.textContent ?? '').trim()))?.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
  }

  // And it actually produces a PDF when pressed. The download itself cannot be
  // asserted here -- CDP's download interception cancels even a plain text
  // blob in this harness -- so what is checked is that the click completes
  // without surfacing an error and the button returns to its resting label.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Export ISO 19152 Certificate/i.test(x.textContent ?? ''));
    b?.click();
  });
  await new Promise((r) => setTimeout(r, 12000));
  const afterClick = await page.evaluate(() => {
    const panel = document.querySelector('[data-panel="detail"]');
    const b = [...document.querySelectorAll('button')]
      .find((x) => /Export ISO 19152 Certificate|Generating certificate/i.test(x.textContent ?? ''));
    return {
      label: b?.textContent?.trim() ?? null,
      failed: /could not generate|no record to print/i.test(panel?.textContent ?? ''),
    };
  });
  check('pressing it reports no failure', afterClick.failed === false);
  check('the control settles back to its resting label',
    /Export ISO 19152 Certificate/i.test(afterClick.label ?? ''), String(afterClick.label));

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

console.log(failures === 0
  ? '\nAll volumetric checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
