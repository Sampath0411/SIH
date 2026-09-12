/**
 * Generate the desktop app icons from the app's own SVG mark.
 *
 *   node scripts/make-icons.mjs
 *
 * Renders app/icon.svg (at the repo root) at 1024px with headless Chrome
 * (the same Chrome the screenshot harness uses, so nothing new is installed),
 * then writes into desktop/build/:
 *
 *   build/icon.png — 1024px square, the source electron-builder prefers
 *   build/icon.ico — 256/48/32/16 frames packed by hand (ICO format)
 *
 * electron-builder 26 picks these up automatically from the buildResources
 * directory and embeds them in the exe, installer and uninstaller.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..'); // the web app / repo root
const CHROME =
  process.env.CHROME_PATH ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SVG = path.join(ROOT, 'app', 'icon.svg');
const OUT_DIR = path.join(DESKTOP, 'build');
const PNG1024 = path.join(OUT_DIR, 'icon-1024.png');
const PNG256 = path.join(OUT_DIR, 'icon-256.png');
const ICO = path.join(OUT_DIR, 'icon.ico');

mkdirSync(OUT_DIR, { recursive: true });

// ---- 1. rasterize the SVG with headless Chrome -----------------------------
const svg = readFileSync(SVG, 'utf-8');
// Chrome screenshot of an SVG window: size 1024, and force the SVG to fill it
// by inlining width/height on the root element.
const sized = svg.replace(
  /<svg /,
  '<svg width="1024" height="1024" style="display:block" ',
);
const html = `<!doctype html><html><head><style>
  html,body{margin:0;padding:0;background:transparent}
</style></head><body>${sized}</body></html>`;
const tmpHtml = path.join(OUT_DIR, '_icon-render.html');
writeFileSync(tmpHtml, html);

const tmpShot = path.join(OUT_DIR, '_icon-raw.png');
execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox' in process.env ? '--no-sandbox' : '--no-first-run',
    `--screenshot=${tmpShot}`,
    '--window-size=1024,1024',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    `file:///${tmpHtml.replace(/\\/g, '/')}`,
  ],
  { stdio: 'pipe' },
);

// ---- 2. decode the PNG (screenshot is 8-bit RGBA, non-interlaced) ----------
const raw = readFileSync(tmpShot);
const png = decodePng(raw);
const square = Math.min(png.width, png.height);
const offX = (png.width - square) >> 1;
const offY = (png.height - square) >> 1;

// ---- 3. emit 1024 and 256 PNGs ---------------------------------------------
writeFileSync(PNG1024, encodePng(cropSquare(png, 1024, offX, offY)));
writeFileSync(PNG256, encodePng(cropSquare(png, 256, offX, offY)));

// ---- 4. pack the ICO: 256 (PNG-compressed) + 48/32/16 ----------------------
const sizes = [256, 48, 32, 16];
const frames = sizes.map((n) => {
  const data =
    n === 256
      ? readFileSync(PNG256) // 256px frames may be embedded PNG per the spec
      : encodePng(cropSquare(png, n, offX, offY));
  return { n, data };
});
writeFileSync(ICO, packIco(frames));

console.log(
  `[icons] wrote ${path.relative(ROOT, PNG1024)} (${png.width}px source), `
    + `${path.relative(ROOT, PNG256)}, ${path.relative(ROOT, ICO)}`,
);

// The raw Chrome screenshot is a throwaway once the icon files exist.
rmSync(tmpShot, { force: true });
rmSync(tmpHtml, { force: true });

// ---------------------------------------------------------------------------
/** Crop the square centre of a decoded RGBA image down to n×n, nearest-neighbour. */
function cropSquare(png, n, offX, offY) {
  const out = Buffer.alloc(n * n * 4);
  for (let y = 0; y < n; y++) {
    const sy = offY + Math.min(png.height - 1, Math.floor((y * square) / n));
    for (let x = 0; x < n; x++) {
      const sx = offX + Math.min(png.width - 1, Math.floor((x * square) / n));
      const si = (sy * png.width + sx) * 4;
      const di = (y * n + x) * 4;
      out[di] = png.data[si];
      out[di + 1] = png.data[si + 1];
      out[di + 2] = png.data[si + 2];
      out[di + 3] = png.data[si + 3];
    }
  }
  return { width: n, height: n, data: out };
}

/** Decode 8-bit non-interlaced RGB/RGBA PNG (same scope as scripts/shoot.mjs). */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(line, 0, rp, rp + stride);
    rp += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { width, height, data: out };
}

/** Encode RGBA pixels as an 8-bit non-interlaced RGBA PNG (filter 0 rows). */
function encodePng(img) {
  const { width, height, data } = img;
  // 0x5c376e14 == (0x1f ^ 0x8c | 0x1b << 8) ... just the standard constant.
  const crcTable = buildCrcTable();
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const bodyAndType = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcTable, bodyAndType) >>> 0);
    return Buffer.concat([len, bodyAndType, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rawOut = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    rawOut[rowStart] = 0; // filter: none
    data.copy(rawOut, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawOut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
}
function crc32(table, buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** Pack ICO frames: 6-byte header, 16-byte dir entries, then frame data. */
function packIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);
  const dirSize = 16 * frames.length;
  let offset = 6 + dirSize;
  const entries = [];
  for (const { n, data } of frames) {
    const e = Buffer.alloc(16);
    e[0] = n === 256 ? 0 : n; // 0 means 256
    e[1] = n === 256 ? 0 : n;
    e[2] = 0; // palette
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);  // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]);
}
