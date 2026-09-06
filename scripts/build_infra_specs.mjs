/**
 * Build the two site specifications from mapped OpenStreetMap geometry.
 *
 * Run with:  npm run build:infra   (then npm run build:vizag)
 *
 * WHY THIS EXISTS. The specs were first authored by describing each structure
 * in its own local frame -- "a 12 m platform, 550 m long, on a bearing of 28
 * degrees". Everything about that is fine except the bearing, which was a
 * guess read off a map, and a guessed bearing is the one error a local frame
 * cannot absorb: the station's platforms actually run at 158.8 degrees, so the
 * whole model sat across the real tracks instead of on them, and the flyover
 * was drawn at 118 degrees and 720 m when the real structure runs at 91.5
 * degrees for 1,450 m as two separate carriageways.
 *
 * So the parts whose true shape is MAPPED now come from the map. This reads
 * the committed Overpass extracts in data/infra/osm/ and writes the shape of
 * each platform and each carriageway straight into the spec as lon/lat, where
 * there is no bearing left to get wrong. Everything the map does NOT record --
 * platform shelters, foot over bridges, pillar spacing, the station building's
 * footprint -- stays derived, but is now anchored to the measured axis rather
 * than to a guess, so it lines up with the real thing too.
 *
 * PROVENANCE. The OSM extracts are committed with their query, their download
 * date and their licence. Geometry taken from them is `osm_geometry` in the
 * facts block; everything this script invents is still marked derived, and the
 * DetailPanel keeps showing the two apart.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OSM = path.join(ROOT, 'data', 'infra', 'osm');
const OUT = path.join(ROOT, 'data', 'api', 'vizag-infra', 'infra');

const M_PER_DEG_LAT = 110574;
const mPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, 'utf-8');
const r7 = (v) => +v.toFixed(7);

/** Metric length of a lon/lat polyline. */
function lengthM(line) {
  let m = 0;
  for (let i = 1; i < line.length; i++) {
    m += Math.hypot(
      (line[i][0] - line[i - 1][0]) * mPerDegLon(line[i][1]),
      (line[i][1] - line[i - 1][1]) * M_PER_DEG_LAT,
    );
  }
  return m;
}

/** Perpendicular offset of a lon/lat polyline, metres, positive to the right. */
function offsetLine(line, metres) {
  const out = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const lat = line[i][1];
    const mLon = mPerDegLon(lat) || 1;
    const dx = (next[0] - prev[0]) * mLon;
    const dy = (next[1] - prev[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;
    out.push([
      r7(line[i][0] + ((dy / len) * metres) / mLon),
      r7(line[i][1] + ((-dx / len) * metres) / M_PER_DEG_LAT),
    ]);
  }
  return out;
}

/** Points every `stepM` along a lon/lat polyline, including both ends. */
function sampleAlong(line, stepM) {
  const total = lengthM(line);
  const n = Math.max(1, Math.round(total / stepM));
  const out = [];
  let seg = 0;
  let acc = 0;
  let segLen = Math.hypot(
    (line[1][0] - line[0][0]) * mPerDegLon(line[0][1]),
    (line[1][1] - line[0][1]) * M_PER_DEG_LAT,
  );
  for (let k = 0; k <= n; k++) {
    const want = (total * k) / n;
    while (seg < line.length - 2 && acc + segLen < want) {
      acc += segLen;
      seg += 1;
      segLen = Math.hypot(
        (line[seg + 1][0] - line[seg][0]) * mPerDegLon(line[seg][1]),
        (line[seg + 1][1] - line[seg][1]) * M_PER_DEG_LAT,
      );
    }
    const t = segLen > 0 ? Math.min(1, Math.max(0, (want - acc) / segLen)) : 0;
    out.push([
      r7(line[seg][0] + (line[seg + 1][0] - line[seg][0]) * t),
      r7(line[seg][1] + (line[seg + 1][1] - line[seg][1]) * t),
    ]);
  }
  return out;
}

/** Ring centroid and its principal axis, in a shared metric frame. */
function axisOf(rings) {
  let lat0 = 0;
  let lon0 = 0;
  let n = 0;
  for (const ring of rings) for (const [lon, lat] of ring) { lat0 += lat; lon0 += lon; n++; }
  lat0 /= n;
  lon0 /= n;
  const mLon = mPerDegLon(lat0);
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      const x = (lon - lon0) * mLon;
      const y = (lat - lat0) * M_PER_DEG_LAT;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let bearing = (90 - (theta * 180) / Math.PI + 360) % 360;
  if (bearing >= 180) bearing -= 180;
  return { lat0, lon0, mLon, theta, bearing };
}

// ===========================================================================
// Visakhapatnam Railway Station
// ===========================================================================
function buildStation() {
  const src = readJson(path.join(OSM, 'vskp-railway-station.json'));
  const platforms = src.elements
    .filter((e) => e.tags?.railway === 'platform' && e.geometry)
    .map((e) => ({ ref: e.tags.ref, ring: e.geometry }));
  const stationNode = src.elements.find((e) => e.type === 'node');

  const { lat0, lon0, mLon, theta, bearing } = axisOf(platforms.map((p) => p.ring));
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const vx = -uy;
  const vy = ux;
  const toLocal = ([lon, lat]) => {
    const x = (lon - lon0) * mLon;
    const y = (lat - lat0) * M_PER_DEG_LAT;
    return [x * ux + y * uy, x * vx + y * vy];
  };

  // Each platform's extent along and across the measured axis.
  const bodies = platforms.map((p) => {
    let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
    for (const pt of p.ring) {
      const [u, v] = toLocal(pt);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    return { ...p, u0, u1, v0, v1, len: u1 - u0, wid: v1 - v0, u: (u0 + u1) / 2, v: (v0 + v1) / 2 };
  }).sort((a, b) => a.v - b.v);

  const spanV = [Math.min(...bodies.map((b) => b.v0)), Math.max(...bodies.map((b) => b.v1))];
  const spanU = [Math.min(...bodies.map((b) => b.u0)), Math.max(...bodies.map((b) => b.u1))];
  const midU = (spanU[0] + spanU[1]) / 2;
  const midV = (spanV[0] + spanV[1]) / 2;

  /**
   * Measured frame -> spec frame. The one conversion, in one place.
   *
   * `axisOf` returns (u, v) = (along the axis, across it, to the LEFT). The
   * spec's local frame is the other way round and the other handedness:
   * lib/infra/build.ts runs +y ALONG the bearing and +x across it to the
   * RIGHT. Getting this wrong does not tilt the model slightly, it lays every
   * derived part at right angles to the mapped platforms -- which is exactly
   * what it did -- so it is written down rather than repeated inline.
   *
   *   spec x = -v      (across, right of travel)
   *   spec y =  u      (along the bearing)
   *   spec w = extent across      spec d = extent along
   */
  const at = (u, v) => ({ x: -v, y: u });

  const components = [];

  // ---- platforms: the MAPPED rings, verbatim ------------------------------
  for (const b of bodies) {
    components.push({
      ref: `VSKP-PF-${b.ref.replace(/&/g, '')}`,
      kind: 'platform',
      shape: 'box',
      label: `Platform ${b.ref}`,
      lod: 'far',
      geoRing: b.ring.map(([lon, lat]) => [r7(lon), r7(lat)]),
      base: 0,
      height: 0.9,
      meta: {
        'Platform numbers': b.ref,
        Length: `${Math.round(b.len)} m`,
        Width: `${b.wid.toFixed(1)} m`,
        Geometry: 'OpenStreetMap',
      },
    });
  }

  // ---- shelters: derived, one over each mapped platform -------------------
  for (const b of bodies) {
    // Inset from the platform edge so the canopy reads as sitting on it.
    const inset = Math.min(1.2, b.wid * 0.12);
    components.push({
      ref: `VSKP-SHL-${b.ref.replace(/&/g, '')}`,
      kind: 'platform_shelter',
      shape: 'box',
      label: `Platform ${b.ref} shelter`,
      lod: 'mid',
      ...at(b.u, b.v),
      w: Math.max(2, b.wid - inset * 2),
      d: Math.max(2, b.len * 0.62),
      base: 5.6,
      height: 0.45,
      meta: { 'Covered length': `${Math.round(b.len * 0.62)} m`, 'Clear height': '5.6 m' },
    });
  }

  // ---- tracks: derived, in the gaps between mapped platforms --------------
  let t = 0;
  for (let i = 0; i < bodies.length - 1; i++) {
    const gap = bodies[i + 1].v0 - bodies[i].v1;
    if (gap < 6) continue;
    // Two roads per gap where it is wide enough, otherwise one.
    const lanes = gap > 16 ? [0.3, 0.7] : [0.5];
    for (const f of lanes) {
      t += 1;
      components.push({
        ref: `VSKP-TRK-${String(t).padStart(2, '0')}`,
        kind: 'track',
        shape: 'box',
        label: 'Railway track',
        lod: 'mid',
        ...at(midU, bodies[i].v1 + gap * f),
        w: 3.4,
        d: Math.max(spanU[1] - spanU[0], 600),
        base: -0.25,
        height: 0.35,
        meta: { Gauge: 'Broad gauge', Electrified: 'Yes' },
      });
    }
  }

  // ---- foot over bridges: derived, across the mapped array ----------------
  const fobW = (spanV[1] - spanV[0]) + 30;
  [0.22, 0.72].forEach((f, i) => {
    const u = spanU[0] + (spanU[1] - spanU[0]) * f;
    components.push({
      ref: `VSKP-FOB-${String(i + 1).padStart(2, '0')}`,
      kind: 'foot_over_bridge',
      shape: 'box',
      label: 'Foot over bridge',
      lod: 'far',
      ...at(u, midV),
      w: fobW,
      d: 6,
      base: 8.6,
      height: 0.7,
      meta: { Span: `${Math.round(fobW)} m`, 'Deck height': '8.6 m', Crosses: 'All platforms' },
    });
  });

  // ---- station building + concourse: derived, off the mapped array --------
  const bldV = spanV[0] - 46;
  components.push({
    ref: 'VSKP-BLD-01',
    kind: 'station_building',
    shape: 'box',
    label: 'Main station building',
    lod: 'far',
    ...at(midU, bldV),
    w: 46,
    d: 132,
    base: 0,
    height: 16,
    meta: { Storeys: 3, Footprint: '132 x 46 m', Frontage: 'Gnanapuram side' },
  });
  components.push({
    ref: 'VSKP-CON-01',
    kind: 'concourse',
    shape: 'box',
    label: 'Concourse',
    lod: 'far',
    ...at(midU, spanV[0] - 14),
    w: 22,
    d: 132,
    base: 0,
    height: 7.5,
    meta: { Connects: 'Main building to the platforms' },
  });
  [-42, 42].forEach((du, i) => {
    components.push({
      ref: `VSKP-ENT-${String(i + 1).padStart(2, '0')}`,
      kind: 'entrance',
      shape: 'box',
      label: 'Entrance',
      lod: 'mid',
      ...at(midU + du, bldV - 30),
      w: 13,
      d: 15,
      base: 0,
      height: 6.5,
      meta: { Type: 'Passenger entrance / exit' },
    });
  });
  [-70, 70].forEach((du, i) => {
    components.push({
      ref: `VSKP-PRK-${String(i + 1).padStart(2, '0')}`,
      kind: 'parking',
      shape: 'box',
      label: 'Parking area',
      lod: 'mid',
      ...at(midU + du, bldV - 62),
      w: 42,
      d: 72,
      base: 0.02,
      height: 0.06,
      meta: { Surface: 'Paved' },
    });
  });
  components.push({
    ref: 'VSKP-RD-01',
    kind: 'road',
    shape: 'strip',
    label: 'Station approach road',
    lod: 'far',
    points: [
      [-(bldV - 90), spanU[0] - 60],
      [-(bldV - 78), midU],
      [-(bldV - 90), spanU[1] + 60],
    ],
    width: 14,
    base: 0.01,
    height: 0.05,
    meta: { Lanes: 2, Serves: 'Main entrance and parking' },
  });

  return {
    id: 'vskp-railway-station',
    name: 'Visakhapatnam Railway Station',
    kind: 'railway_station',
    // The station node OSM records, not a point read off a map.
    anchor: { lon: r7(lon0), lat: r7(lat0) },
    bearing: +bearing.toFixed(2),
    summary: 'South Coast Railway zone terminus at Gnanapuram — 8 platforms, 10 tracks.',
    facts: [
      { label: 'Station code', value: 'VSKP', source: 'wikipedia' },
      { label: 'Platforms', value: 8, source: 'wikipedia' },
      { label: 'Tracks', value: 10, source: 'wikipedia' },
      { label: 'Station area', value: '103,178 m²', source: 'wikipedia' },
      { label: 'Elevation', value: '5.97 m', source: 'wikipedia' },
      { label: 'Opened', value: '7 October 1896', source: 'wikipedia' },
      { label: 'Rebuilt', value: 2017, source: 'wikipedia' },
      { label: 'Zone', value: 'South Coast Railway', source: 'wikipedia' },
      { label: 'Division', value: 'Visakhapatnam', source: 'wikipedia' },
      {
        label: 'Station point',
        value: stationNode
          ? `${stationNode.lat.toFixed(6)}° N, ${stationNode.lon.toFixed(6)}° E`
          : `${lat0.toFixed(6)}° N, ${lon0.toFixed(6)}° E`,
        source: 'osm_geometry',
      },
      {
        label: 'Platform bodies',
        value: `${bodies.length} (${bodies.map((b) => b.ref).join(', ')})`,
        source: 'osm_geometry',
      },
      { label: 'Platform alignment', value: `${bearing.toFixed(1)}°`, source: 'osm_geometry' },
    ],
    derivedNote:
      'The platform outlines, their numbering and the station point are MAPPED '
      + '— they come from OpenStreetMap (© OpenStreetMap contributors, ODbL), '
      + 'and the platform count, area, elevation and dates are published '
      + 'figures. Everything else is DERIVED for this demonstration: the '
      + 'shelters, the foot over bridges, the track positions, the station '
      + 'building and the parking are a plausible arrangement anchored to the '
      + 'measured platform axis, not a station drawing or a survey.',
    components,
  };
}

// ===========================================================================
// Telugu Thalli Flyover
// ===========================================================================
function buildFlyover() {
  const src = readJson(path.join(OSM, 'telugu-thalli-flyover.json'));
  const ways = src.elements.filter((e) => e.geometry && e.geometry.length > 1);

  // Both carriageways run the same way on screen, whichever way traffic does.
  const west = (g) => (g[0][0] <= g[g.length - 1][0] ? g : [...g].reverse());
  const decks = ways.map((w) => ({ id: w.id, line: west(w.geometry), tags: w.tags }));
  decks.sort((a, b) => a.line[0][1] - b.line[0][1]);

  const total = lengthM(decks[0].line);
  const all = decks.flatMap((d) => d.line);
  const lat0 = all.reduce((s, p) => s + p[1], 0) / all.length;
  const lon0 = all.reduce((s, p) => s + p[0], 0) / all.length;
  const a = decks[0].line[0];
  const b = decks[0].line[decks[0].line.length - 1];
  let bearing = (Math.atan2(
    (b[0] - a[0]) * mPerDegLon(lat0),
    (b[1] - a[1]) * M_PER_DEG_LAT,
  ) * 180) / Math.PI;
  bearing = (bearing + 360) % 360;

  /**
   * Deck profile: at grade for the first and last RAMP_M, level in between.
   *
   * The mapped way is the whole structure including its approaches, and a
   * deck that starts 6 m in the air at the kerb is the one thing that would
   * still look wrong after the alignment is right.
   */
  const RAMP_M = 150;
  const DECK_H = 6.2;
  const gradeFor = (line) => {
    const out = [];
    let acc = 0;
    for (let i = 0; i < line.length; i++) {
      if (i > 0) {
        acc += Math.hypot(
          (line[i][0] - line[i - 1][0]) * mPerDegLon(line[i][1]),
          (line[i][1] - line[i - 1][1]) * M_PER_DEG_LAT,
        );
      }
      const fromEnd = Math.min(acc, total - acc);
      out.push(+(DECK_H * Math.min(1, Math.max(0.02, fromEnd / RAMP_M))).toFixed(2));
    }
    return out;
  };

  const components = [];
  const SIDE = ['north', 'south'];
  decks.forEach((d, i) => {
    components.push({
      ref: `TTF-DECK-${String(i + 1).padStart(2, '0')}`,
      kind: 'deck_span',
      shape: 'strip',
      label: `Carriageway (${SIDE[i] ?? i + 1}bound)`,
      lod: 'far',
      geoPoints: d.line.map(([lon, lat]) => [r7(lon), r7(lat)]),
      grade: gradeFor(d.line),
      width: 9,
      base: 0,
      height: 1.2,
      meta: {
        Length: `${Math.round(total)} m`,
        Lanes: d.tags?.lanes ?? 2,
        'Deck level': `${DECK_H} m above the road`,
        Geometry: 'OpenStreetMap',
        'OSM way': d.id,
      },
    });
    // Barriers along the outer edge of each carriageway.
    components.push({
      ref: `TTF-BAR-${String(i + 1).padStart(2, '0')}`,
      kind: 'barrier',
      shape: 'strip',
      label: 'Deck barrier',
      lod: 'near',
      geoPoints: offsetLine(d.line, i === 0 ? -4.7 : 4.7),
      grade: gradeFor(d.line),
      width: 0.45,
      base: 1.2,
      height: 0.95,
      meta: { Type: 'Crash barrier' },
    });
  });

  // ---- piers: derived spacing, on the mapped centreline -------------------
  //
  // Between the carriageways, which is where a dual-carriageway flyover's
  // piers actually stand, and only along the elevated part.
  const centre = decks[0].line.map((p, i) => {
    const q = decks[1] ? decks[1].line[Math.min(i, decks[1].line.length - 1)] : p;
    return [r7((p[0] + q[0]) / 2), r7((p[1] + q[1]) / 2)];
  });
  const SPAN_M = 30;
  const piers = sampleAlong(centre, SPAN_M);
  let pierNo = 0;
  piers.forEach((pos, i) => {
    const along = (total * i) / (piers.length - 1);
    if (along < RAMP_M || along > total - RAMP_M) return;   // ramps are at grade
    pierNo += 1;
    components.push({
      ref: `TTF-P-${String(pierNo).padStart(3, '0')}`,
      kind: 'pillar',
      shape: 'cylinder',
      label: 'Support pillar',
      lod: 'mid',
      geoPos: pos,
      radius: 0.95,
      base: -2.2,
      height: DECK_H + 2.2,
      meta: {
        'Height above road': `${DECK_H} m`,
        Diameter: '1.9 m',
        'Span to next pier': `${SPAN_M} m`,
        'Chainage from west end': `${Math.round(along)} m`,
      },
    });
  });

  // ---- the road the flyover carries, at grade -----------------------------
  //
  // Same mapped alignment as the deck, because that is what a flyover is: the
  // through movement lifted over the junction the surface road still crosses.
  // Emitted as a `road` so scripts/build_vizag_infra.mjs derives a street from
  // it and lays the demonstration utility corridors along it -- the buried
  // networks follow the streets, so a site with no street has nothing under it.
  components.push({
    ref: 'TTF-RD-01',
    kind: 'road',
    shape: 'strip',
    label: 'Dondaparthi Road (at grade)',
    lod: 'far',
    geoPoints: centre,
    width: 23,
    base: 0.01,
    height: 0.05,
    meta: { Lanes: 4, Runs: 'Beneath the flyover deck', Geometry: 'OpenStreetMap' },
  });

  // The junction the structure exists to separate, at the mapped mid-point.
  const mid = centre[Math.floor(centre.length / 2)];
  components.push({
    ref: 'TTF-JCT-01',
    kind: 'junction',
    shape: 'box',
    label: 'Asilmetta junction',
    lod: 'far',
    x: 0,
    y: 0,
    w: 74,
    d: 74,
    base: 0.02,
    height: 0.06,
    meta: {
      Type: 'At-grade crossing beneath the flyover',
      Arms: 4,
      Position: `${mid[1].toFixed(6)}, ${mid[0].toFixed(6)}`,
    },
  });

  return {
    id: 'telugu-thalli-flyover',
    name: 'Telugu Thalli Flyover',
    kind: 'flyover',
    anchor: { lon: r7(lon0), lat: r7(lat0) },
    bearing: +bearing.toFixed(2),
    summary: 'Four-lane grade separation at Asilmetta, carrying Dondaparthi Road over Asilmetta Road.',
    facts: [
      { label: 'Lanes', value: 4, source: 'wikipedia' },
      { label: 'Opened', value: 2013, source: 'wikipedia' },
      { label: 'Connects', value: 'Dondaparthi Road – Asilmetta Road', source: 'wikipedia' },
      { label: 'Also known as', value: 'Asilmetta Flyover', source: 'wikipedia' },
      { label: 'Carriageways', value: `${decks.length}, one-way each`, source: 'osm_geometry' },
      { label: 'Mapped length', value: `${Math.round(total)} m`, source: 'osm_geometry' },
      { label: 'Alignment', value: `${bearing.toFixed(1)}°`, source: 'osm_geometry' },
      {
        label: 'Coordinates',
        value: `${lat0.toFixed(6)}° N, ${lon0.toFixed(6)}° E`,
        source: 'osm_geometry',
      },
    ],
    derivedNote:
      'The two carriageway alignments and the structure\'s length are MAPPED — '
      + 'they come from OpenStreetMap (© OpenStreetMap contributors, ODbL) — '
      + 'and the lane count, opening year and the roads it connects are '
      + 'published figures. The STRUCTURE is DERIVED for this demonstration: '
      + 'the deck level, the ramp gradients, the 30 m span spacing and every '
      + 'pillar identifier such as TTF-P-014 are our arithmetic. No bridge '
      + 'drawing or span schedule was consulted; the source does not publish '
      + 'the number of spans.',
    components,
  };
}

// ---------------------------------------------------------------- write ---
const station = buildStation();
const flyover = buildFlyover();
writeJson(path.join(OUT, 'vskp-railway-station.json'), station);
writeJson(path.join(OUT, 'telugu-thalli-flyover.json'), flyover);

for (const s of [station, flyover]) {
  console.log(`${s.id}: anchor ${s.anchor.lat}, ${s.anchor.lon}  bearing ${s.bearing}  `
    + `${s.components.length} components`);
}
console.log(`written to data/api/vizag-infra/infra/`);
