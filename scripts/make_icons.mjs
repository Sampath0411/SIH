// Generates build-res/aeroview.ico, build-res/icon.png and
// build-res/installerSidebar.bmp from the same geometry as app/icon.svg —
// three stacked isometric layers on a dark rounded square. Pure Node:
// PNG is hand-encoded with zlib.deflateSync, ICO wraps PNG entries, BMP is
// hand-packed for the NSIS installer sidebar. Run once; commit the output.
//
//   node scripts/make_icons.mjs

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build-res');
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Scene: viewBox 0 0 32 32. Rounded square #0b1220 rx=6, then three rhombi
// centred on x=16, each 20 wide and 12 tall, painted bottom-most last (the
// solid .95 layer overlaps the translucent ones, as in the SVG).
// ---------------------------------------------------------------------------

const BG = [0x0b, 0x12, 0x20];
const FG = [0x5c, 0xbe, 0xff];

const LAYERS = [
  { top: 10, opacity: 0.33 }, // path d="M6 10l10-6 10 6-10 6z"
  { top: 15, opacity: 0.6 },  // path d="M6 15l10-6 10 6-10 6z"
  { top: 20, opacity: 0.95 }, // path d="M6 20l10-6 10 6-10 6z"
];

// Interior test for the rounded square [0,s]x[0,s] with corner radius r.
function inRoundedSquare(px, py, s, r) {
  const min = r, max = s - r;
  if (px >= min && px <= max) return py >= 0 && py <= s;
  if (py >= min && py <= max) return px >= 0 && px <= s;
  const dx = px < min ? min - px : px - max;
  const dy = py < min ? min - py : py - max;
  return dx * dx + dy * dy <= r * r;
}

function inRhombus(px, py, topY) {
  // centre (16, topY+6), half-width 10, half-height 6
  const dx = Math.abs(px - 16) / 10;
  const dy = Math.abs(py - (topY + 6)) / 6;
  return dx + dy <= 1;
}

// Coverage of the scene at a point in 32x32 scene coordinates.
function sample(px, py) {
  if (!inRoundedSquare(px, py, 32, 6)) return [0, 0, 0, 0];
  let [r, g, b, a] = [...BG, 1];
  for (const layer of LAYERS) {
    if (inRhombus(px, py, layer.top)) {
      const t = layer.opacity;
      r = r * (1 - t) + FG[0] * t;
      g = g * (1 - t) + FG[1] * t;
      b = b * (1 - t) + FG[2] * t;
    }
  }
  return [r, g, b, a];
}

// Render the scene at `size` px with 3x3 supersampling. Returns RGBA bytes.
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = 3; // supersample grid per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const [sr, sg, sb, sa] = sample(
            (x + (sx + 0.5) / S) * (32 / size),
            (y + (sy + 0.5) / S) * (32 / size)
          );
          r += sr; g += sg; b += sb; a += sa;
        }
      }
      const n = S * S;
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / n);
      px[o + 1] = Math.round(g / n);
      px[o + 2] = Math.round(b / n);
      px[o + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, single IDAT, filter 0)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(rgba, size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

// icon.png — 512 px, what electron-builder picks up automatically
fs.writeFileSync(path.join(OUT, 'icon.png'), encodePNG(render(512), 512));

// aeroview.ico — PNG-compressed entries (Vista+), referenced from `build.win.icon`
const icoSizes = [256, 64, 48, 32, 16];
const pngs = icoSizes.map((s) => ({ s, png: encodePNG(render(s), s) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(pngs.length, 4);
const dir = Buffer.alloc(pngs.length * 16);
let offset = header.length + dir.length;
pngs.forEach(({ s, png }, i) => {
  const e = i * 16;
  dir[e] = s % 256;
  dir[e + 1] = s % 256;
  dir[e + 2] = 0;  // palette
  dir[e + 3] = 0;  // reserved
  dir.writeUInt16LE(1, e + 4);
  dir.writeUInt16LE(32, e + 6);
  dir.writeUInt32LE(png.length, e + 8);
  dir.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(OUT, 'aeroview.ico'), Buffer.concat([header, dir, ...pngs.map((p) => p.png)]));

// installerSidebar.bmp — 164x314 24-bit, dark background with the mark centred
{
  const W = 164, H = 314;
  const mark = render(120); // 120 px mark, centred
  const rowPad = (4 - ((W * 3) % 4)) % 4;
  const px = Buffer.alloc((W * 3 + rowPad) * H);
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = y * (W * 3 + rowPad) + x * 3;
    px[o] = b; px[o + 1] = g; px[o + 2] = r;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, ...BG);
  const ox = Math.floor((W - 120) / 2);
  const oy = Math.floor((H - 120) / 2);
  for (let y = 0; y < 120; y++) {
    for (let x = 0; x < 120; x++) {
      const o = (y * 120 + x) * 4;
      const a = mark[o + 3] / 255;
      if (a > 0) {
        // composite over the flat background
        put(ox + x, oy + y,
          Math.round(BG[0] * (1 - a) + mark[o] * a),
          Math.round(BG[1] * (1 - a) + mark[o + 1] * a),
          Math.round(BG[2] * (1 - a) + mark[o + 2] * a));
      }
    }
  }
  const fh = Buffer.alloc(14);
  fh.write('BM', 0, 'ascii');
  fh.writeUInt32LE(54 + px.length, 2);
  fh.writeUInt32LE(54, 10);
  const dih = Buffer.alloc(40);
  dih.writeUInt32LE(40, 0);
  dih.writeInt32LE(W, 4);
  dih.writeInt32LE(H, 8); // positive: bottom-up
  dih.writeUInt16LE(1, 12);
  dih.writeUInt16LE(24, 14);
  dih.writeUInt32LE(px.length, 20);
  fs.writeFileSync(path.join(OUT, 'installerSidebar.bmp'), Buffer.concat([fh, dih, px]));
}

console.log('build-res/: icon.png, aeroview.ico, installerSidebar.bmp written');
