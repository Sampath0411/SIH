/**
 * Record the app driving a real Chrome and freeze it as docs/demo.gif.
 *
 *   SESSION_SECRET=... ULPIN_SESSION_COOKIE=$(node --experimental-strip-types scripts/mint_session.mjs) \
 *     node scripts/make_demo_gif.mjs            # record + encode
 *   node scripts/make_demo_gif.mjs --encode     # frames on disk -> GIF only
 *   node scripts/make_demo_gif.mjs --record     # frames only
 *
 * Why a GIF and not an mp4 or an external link: the README is read on GitHub,
 * which strips <iframe> embeds (the Google Drive one the README used to carry
 * never rendered) and only auto-plays videos uploaded through the web UI. A
 * GIF committed to the repo renders inline, plays silently, works in every
 * renderer GitHub and npm ship, and needs nothing outside the checkout.
 *
 * No new dependencies: the frames are puppeteer screenshots (puppeteer-core
 * is already a devDependency) and the GIF is packed here -- PNG decode via
 * zlib, area-average downscale, median-cut palette per frame, Floyd-Steinberg
 * dithering through a 15-bit nearest-colour LUT, and an LZW encoder written
 * once against omggif's proven code-size transitions. ffmpeg is not assumed.
 *
 * Frames land in .dist/demo-frames/ (gitignored); only the GIF is committed.
 */

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRAMES = path.join(ROOT, '.dist', 'demo-frames');
const OUT = path.join(ROOT, 'docs', 'demo.gif');

const CHROME = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ORIGIN = process.env.ULPIN_ORIGIN ?? 'http://localhost:3000';
const SLUG = process.env.ULPIN_SLUG ?? 'siripuram';
const FPS = 10;
/**
 * 1280x720 capture downscaled to 720x405. The scale and the shot list below
 * are a size budget, not a taste choice: every motion frame of a dithered
 * photographic scene costs ~100 KB of LZW, and a README GIF much past ~6 MB
 * is a slow first paint for every visitor. Holds are cheap (near-identical
 * frames compress to a few KB); motion is what costs, so motion is sampled
 * every second beat and the camera drags are slowed to match. The palette is
 * 128 colours for the same reason -- at this scale the dither hides it, and
 * halving the palette halves the LZW noise.
 */
const SCALE = 0.5625;
const PALETTE_SIZE = 128;
/**
 * Recording resumes: SwiftShader renders this scene at seconds per frame, so
 * a full pass does not fit in one shell invocation. Record segments in
 * separate runs, continuing the frame numbering:
 *
 *   ULPIN_GIF_FROM_SEGMENT=1 ULPIN_GIF_FRAME_OFFSET=0  node scripts/make_demo_gif.mjs --record
 *   ULPIN_GIF_FROM_SEGMENT=5 ULPIN_GIF_FRAME_OFFSET=85 node scripts/make_demo_gif.mjs --record
 *   node scripts/make_demo_gif.mjs --encode
 */
const FROM_SEGMENT = Number(process.env.ULPIN_GIF_FROM_SEGMENT ?? '1');
const FRAME_OFFSET = Number(process.env.ULPIN_GIF_FRAME_OFFSET ?? '0');
/**
 * Capture viewport override for slow segments. SwiftShader's per-frame cost
 * scales with pixels, and the underground + 2D views render continuously, so
 * the resume runs for segments 5-6 capture at 960x540; the encoder resamples
 * every frame to one target size, so mixed capture sizes are fine.
 */
const CAP_W = Number(process.env.ULPIN_GIF_W ?? '1280');
const CAP_H = Number(process.env.ULPIN_GIF_H ?? '720');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- recording --

async function record() {
  if (!process.env.ULPIN_SESSION_COOKIE) {
    console.error('ULPIN_SESSION_COOKIE is required (see scripts/mint_session.mjs).');
    process.exit(2);
  }
  fs.mkdirSync(FRAMES, { recursive: true });

  const buildings = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'data', 'api', SLUG, 'buildings.json'), 'utf-8'),
  );
  const N = buildings.features.length;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--window-size=1300,760', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--hide-scrollbars', '--no-sandbox',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    ],
    defaultViewport: { width: CAP_W, height: CAP_H },
    // SwiftShader renders the underground view at seconds per frame; the
    // default 180s protocol timeout is not enough for a screenshot there.
    protocolTimeout: 900000,
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(300000);
  await page.setCookie({
    name: 'ulpin_session',
    value: process.env.ULPIN_SESSION_COOKIE,
    domain: 'localhost',
    path: '/',
  });

  let frame = FRAME_OFFSET;
  const shoot = async () => {
    const buf = await page.screenshot({ type: 'png', optimizeForSpeed: true });
    fs.writeFileSync(path.join(FRAMES, `${String(frame).padStart(5, '0')}.png`), buf);
    frame++;
  };

  /** Run the camera's own flight, then hold N frames. */
  const load = async (query, frames, settle = 1800) => {
    await page.goto(`${ORIGIN}/p/${SLUG}${query}`, {
      waitUntil: 'networkidle2',
      timeout: 240000,
    });
    await page.waitForFunction(
      (n) => new RegExp(`${n} 3D buildings`).test(document.body.innerText),
      { timeout: 300000 },
      N,
    );
    await sleep(settle);
    for (let i = 0; i < frames; i++) await shoot();
  };

  /** A slow user-style orbit drag, shot every `every` increments. */
  const orbit = async (frames, dxPerFrame, every = 2) => {
    const canvas = await page.$('canvas');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= frames; i++) {
      await page.mouse.move(cx + dxPerFrame * i, cy, { steps: 3 });
      if (i % every === 0) await shoot();
    }
    await page.mouse.up();
  };

  if (FROM_SEGMENT <= 1) {
    console.log('[1/6] city orbit');
    await load('', 8, 2200);
    await orbit(48, -3.4, 2);
  }

  if (FROM_SEGMENT <= 2) {
    console.log('[2/6] building fly-in');
    await load('?b=999', 18, 900);
  }

  if (FROM_SEGMENT <= 3) {
    console.log('[3/6] exploded floor stack');
    await load('?b=999&x=55', 16, 900);
  }

  if (FROM_SEGMENT <= 4) {
    console.log('[4/6] isolated floor');
    await load('?b=999&f=2', 16, 900);
  }

  if (FROM_SEGMENT <= 5) {
    console.log('[5/6] underground corridors');
    await load('?ug=1', 18, 900);
  }

  if (FROM_SEGMENT <= 6) {
    console.log('[6/6] 2D GIS cadastre (G)');
    await load('?b=999', 10, 900);
    await page.keyboard.press('g');
    for (let i = 0; i < 16; i++) await shoot();
    await page.keyboard.press('g');
    for (let i = 0; i < 6; i++) await shoot();
  }

  await browser.close();
  console.log(`recorded ${frame} frames -> ${FRAMES}`);
}

// ------------------------------------------------------------------ encoding --

/** Decode an 8-bit RGB/RGBA non-interlaced PNG into {w,h,bpp,data}. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let w = 0; let h = 0; let colorType = 0; let bitDepth = 0; let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) {
    throw new Error(`unsupported PNG (colorType ${colorType}, depth ${bitDepth}, interlace ${interlace})`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++];
    const lineStart = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[lineStart + x - bpp] : 0;
      const b = y > 0 ? out[lineStart - stride + x] : 0;
      const c = y > 0 && x >= bpp ? out[lineStart - stride + x - bpp] : 0;
      let v = raw[pos++];
      switch (f) {
        case 1: v = (v + a) & 255; break;
        case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
          break;
        }
      }
      out[lineStart + x] = v;
    }
  }
  return { w, h, bpp, data: out };
}

/** Area-average resample (unweighted box via float coverage). */
function resample(img, tw, th) {
  const { w, h, bpp, data } = img;
  const out = Buffer.alloc(tw * th * bpp);
  const xr = w / tw; const yr = h / th;
  for (let ty = 0; ty < th; ty++) {
    const y0 = ty * yr; const y1 = Math.min(h, y0 + yr);
    for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * xr; const x1 = Math.min(w, x0 + xr);
      const acc = [0, 0, 0];
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const cy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (cy <= 0) continue;
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const cx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (cx <= 0) continue;
          const o = (y * w + x) * bpp;
          acc[0] += data[o] * cx * cy;
          acc[1] += data[o + 1] * cx * cy;
          acc[2] += data[o + 2] * cx * cy;
          area += cx * cy;
        }
      }
      const o = (ty * tw + tx) * bpp;
      out[o] = Math.round(acc[0] / area);
      out[o + 1] = Math.round(acc[1] / area);
      out[o + 2] = Math.round(acc[2] / area);
    }
  }
  return { w: tw, h: th, bpp, data: out };
}

/** Median-cut palette from a sampled subset. */
function medianCut(samples, maxColors) {
  let buckets = [samples];
  while (buckets.length < maxColors) {
    let bi = -1; let br = -1; let bc = -1;
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[i];
      if (b.length < 2) continue;
      let rmin = 255; let rmax = 0; let gmin = 255; let gmax = 0; let bmin = 255; let bmax = 0;
      for (const p of b) {
        if (p[0] < rmin) rmin = p[0]; if (p[0] > rmax) rmax = p[0];
        if (p[1] < gmin) gmin = p[1]; if (p[1] > gmax) gmax = p[1];
        if (p[2] < bmin) bmin = p[2]; if (p[2] > bmax) bmax = p[2];
      }
      const rr = rmax - rmin; const gr = gmax - gmin; const brg = bmax - bmin;
      const range = Math.max(rr, gr, brg);
      if (range > br) { br = range; bi = i; bc = rr >= gr && rr >= brg ? 0 : gr >= brg ? 1 : 2; }
    }
    if (bi < 0) break;
    const b = buckets[bi];
    b.sort((p, q) => p[bc] - q[bc]);
    const mid = b.length >> 1;
    buckets.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return buckets.map((b) => {
    let r = 0; let g = 0; let bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    const n = b.length || 1;
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}

/**
 * 15-bit-keyed nearest-colour LUT: quantising the dither-domain colour to
 * 5 bits/channel keeps every lookup O(1) after an 8.4M-comparison build,
 * instead of 255 distance tests per pixel per frame.
 */
function nearestLUT(palette) {
  const lut = new Uint8Array(32768);
  for (let key = 0; key < 32768; key++) {
    const r = ((key >> 10) & 31) << 3;
    const g = ((key >> 5) & 31) << 3;
    const b = (key & 31) << 3;
    let best = 0; let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0]; const dg = g - p[1]; const db = b - p[2];
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bd) { bd = d; best = i; }
    }
    lut[key] = best;
  }
  return lut;
}

/** Map one frame to palette indices with Floyd-Steinberg error diffusion. */
function quantise(img, palette, lut) {
  const { w, h, bpp, data } = img;
  const idx = new Uint8Array(w * h);
  const err = new Float32Array((w + 2) * 3);
  const next = new Float32Array((w + 2) * 3);
  for (let y = 0; y < h; y++) {
    err.set(next); next.fill(0);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * bpp;
      const e = (x + 1) * 3;
      const r = Math.max(0, Math.min(255, data[o] + err[e]));
      const g = Math.max(0, Math.min(255, data[o + 1] + err[e + 1]));
      const b = Math.max(0, Math.min(255, data[o + 2] + err[e + 2]));
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const pi = lut[key];
      idx[y * w + x] = pi;
      const p = palette[pi];
      const er = r - p[0]; const eg = g - p[1]; const eb = b - p[2];
      if (x + 1 < w) {
        err[e + 3] += (er * 7) / 16; err[e + 4] += (eg * 7) / 16; err[e + 5] += (eb * 7) / 16;
      }
      const bn = ((y + 1 < h ? x : w + 1) + 1) * 3;
      if (y + 1 < h) {
        if (x > 0) {
          next[e - 3] += (er * 3) / 16; next[e - 2] += (eg * 3) / 16; next[e - 1] += (eb * 3) / 16;
        }
        next[bn] += (er * 5) / 16; next[bn + 1] += (eg * 5) / 16; next[bn + 2] += (eb * 5) / 16;
        if (x + 1 < w) {
          next[bn + 3] += (er * 1) / 16; next[bn + 4] += (eg * 1) / 16; next[bn + 5] += (eb * 1) / 16;
        }
      }
    }
  }
  return idx;
}

/** LZW against omggif's code-size transitions (widen before assign, clear at 4096). */
function lzwEncode(indices, minCodeSize) {
  const CLEAR = 1 << minCodeSize;
  const EOI = CLEAR + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  let nextCode = EOI + 1;

  const out = [];
  let cur = 0; let curBits = 0;
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 255);
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(CLEAR);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (w << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      w = hit;
    } else {
      emit(w);
      if (nextCode === 4096) {
        emit(CLEAR);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = EOI + 1;
      } else {
        if (nextCode >= (1 << codeSize)) codeSize++;
        dict.set(key, nextCode++);
      }
      w = k;
    }
  }
  emit(w);
  emit(EOI);
  if (curBits > 0) out.push(cur & 255);
  return out;
}

function encode() {
  // ULPIN_GIF_EVERY=2 keeps every second frame and doubles the per-frame delay:
  // same wall-clock duration, half the bytes. Inter-frame motion in the shot
  // list is a few pixels, so the halved rate stays smooth; it is how the
  // committed demo.gif is produced.
  const EVERY = Math.max(1, Number(process.env.ULPIN_GIF_EVERY ?? '1'));
  const all = fs.readdirSync(FRAMES).filter((f) => f.endsWith('.png')).sort();
  const files = all.filter((_, i) => i % EVERY === 0);
  if (files.length === 0) throw new Error('no frames to encode');

  // Dimensions from the first frame; every frame must match.
  const first = decodePNG(fs.readFileSync(path.join(FRAMES, files[0])));
  const tw = Math.round(first.w * SCALE) & ~1;
  const th = Math.round(first.h * SCALE) & ~1;
  const delayCs = Math.round((100 / FPS) * EVERY); // GIF delays are centiseconds

  const gif = [];
  const push = (...b) => gif.push(...b);
  const le16 = (v) => [v & 255, (v >> 8) & 255];

  push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // GIF89a
  push(...le16(tw), ...le16(th), 0x70, 0, 0); // no GCT; 8-bit colour resolution
  // Netscape: loop forever.
  push(0x21, 0xff, 0x0b);
  for (const c of 'NETSCAPE2.0') push(c.charCodeAt(0));
  push(0x03, 0x01, 0x00, 0x00, 0x00);

  const sampleEvery = 6;
  const samples = [];

  for (const f of files) {
    let img = decodePNG(fs.readFileSync(path.join(FRAMES, f)));
    img = resample(img, tw, th);

    samples.length = 0;
    for (let i = 0; i < tw * th; i += sampleEvery) {
      const o = i * 3;
      samples.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
    }
    const palette = medianCut(samples, PALETTE_SIZE);
    while (palette.length < 256) palette.push(palette[palette.length - 1] ?? [0, 0, 0]);
    const lut = nearestLUT(palette);
    const idx = quantise(img, palette, lut);
    const lzw = lzwEncode(idx, 8);

    // Graphic Control Extension: packed=0 (no disposal/transparency), delay,
    // transparent index 0, block terminator. All five bytes after the block
    // size are required -- omitting the trailing terminator makes strict
    // decoders (Chrome's img.decode among them) reject the whole file.
    push(0x21, 0xf9, 0x04, 0x00, ...le16(delayCs), 0x00, 0x00);
    // Image Descriptor with a local 256-colour table.
    push(0x2c, 0, 0, 0, 0, ...le16(tw), ...le16(th), 0x87);
    for (const p of palette) push(p[0], p[1], p[2]);
    push(8); // LZW min code size
    let off = 0;
    while (off < lzw.length) {
      const n = Math.min(255, lzw.length - off);
      push(n);
      for (let i = 0; i < n; i++) push(lzw[off + i]);
      off += n;
    }
    push(0); // block terminator
    console.log(`  ${f}: ${PALETTE_SIZE} colours, ${lzw.length} LZW bytes`);
  }

  push(0x3b); // trailer
  fs.writeFileSync(OUT, Buffer.from(gif));
  const mb = (fs.statSync(OUT).size / 1048576).toFixed(2);
  console.log(`wrote ${OUT} (${files.length} frames, ${tw}x${th}, ${mb} MB)`);
}

// --------------------------------------------------------------------- main --

const args = process.argv.slice(2);
const doRecord = args.includes('--record') || args.length === 0;
const doEncode = args.includes('--encode') || args.length === 0;
if (doRecord) await record();
if (doEncode) encode();
