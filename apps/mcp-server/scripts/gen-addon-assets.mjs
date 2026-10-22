#!/usr/bin/env node
/**
 * Generates the Alexa+ add-on media for Stand-In (original artwork, no Amazon
 * or Alexa marks): a white shield holding a phone handset on a solid brand
 * colour. Writes apps/mcp-server/assets/:
 *   icon-72x72.png icon-64x64.png icon-88x88.png icon-126x126.png
 *   icon-180x180.png icon-241x241.png carousel-600x900.png
 *
 * Deterministic: pure geometry, 4x4 supersampling, a fixed PNG encoder
 * (RGB 8-bit, filter 0, node:zlib deflate level 9). No dependencies.
 *
 *   node apps/mcp-server/scripts/gen-addon-assets.mjs [outDir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const ICON_SIZES = [72, 64, 88, 126, 180, 241];
export const CAROUSEL = { width: 600, height: 900 };

const BRAND = [0x15, 0x5e, 0x75]; // deep teal
const WHITE = [0xff, 0xff, 0xff];
const ACCENT = [0xf5, 0xb7, 0x3b]; // warm amber

/* ---------------- PNG encoder ---------------- */

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** rgb: Uint8Array of width*height*3. */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- geometry (unit square, y down) ---------------- */

/** Shield: flat rounded top, straight sides, curved sides meeting in a point. */
function inShield(x, y) {
  const top = 0.15;
  const mid = 0.5;
  const bottom = 0.88;
  const w = 0.31;
  const r = 0.06;
  if (y < top || y > bottom) return false;
  const dx = Math.abs(x - 0.5);
  if (y <= mid) {
    if (dx > w) return false;
    // rounded top corners
    if (y < top + r && dx > w - r) return Math.hypot(dx - (w - r), y - (top + r)) <= r;
    return true;
  }
  const t = (y - mid) / (bottom - mid);
  return dx <= w * Math.cos((t * Math.PI) / 2);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * Phone handset, drawn upright in a local frame (a "(" spine with the ear and
 * mouth pieces pointing right) and rotated 45 degrees.
 */
function inHandset(x, y, cx, cy, scale) {
  const a = Math.PI / 4;
  const lx0 = (x - cx) / scale;
  const ly0 = (y - cy) / scale;
  // rotate into the local frame, then shift so the glyph's visual centre sits on (cx, cy)
  const lx = lx0 * Math.cos(a) - ly0 * Math.sin(a) + 0.02;
  const ly = lx0 * Math.sin(a) + ly0 * Math.cos(a);
  // spine: arc centred (0.12, 0), radius 0.2, around the left side
  const ccx = 0.12;
  const R = 0.2;
  const span = 122;
  const ang = Math.atan2(ly, lx - ccx);
  const deg = ((ang * 180) / Math.PI + 360) % 360;
  if (deg >= span && deg <= 360 - span && Math.abs(Math.hypot(lx - ccx, ly) - R) <= 0.06) return true;
  // ear and mouth pieces: fat capsules at each arc end, pointing at the concave side
  for (const s of [-1, 1]) {
    const ex = ccx + R * Math.cos((span * Math.PI) / 180);
    const ey = s * R * Math.sin((span * Math.PI) / 180);
    if (distToSegment(lx, ly, ex - 0.01, ey + s * 0.01, ex + 0.11, ey + s * 0.01) <= 0.085) return true;
  }
  return false;
}

/** 5x7 bitmap glyphs for the carousel wordmark. */
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Returns a predicate for text centred at (cx, top) with `cell` px per font pixel. */
function textShape(text, cx, top, cell) {
  const adv = 6; // 5 columns + 1 gap
  const width = (text.length * adv - 1) * cell;
  const left = cx - width / 2;
  return (x, y) => {
    const gy = Math.floor((y - top) / cell);
    if (gy < 0 || gy > 6) return false;
    const col = Math.floor((x - left) / cell);
    if (col < 0) return false;
    const ci = Math.floor(col / adv);
    const gx = col % adv;
    if (ci >= text.length || gx > 4) return false;
    const g = FONT[text[ci]];
    if (g === undefined) throw new Error(`no glyph for ${text[ci]}`);
    return g[gy][gx] === '1';
  };
}

/* ---------------- rendering ---------------- */

const SS = 4;

/** colourAt(x, y) in pixel space returns an [r,g,b]; supersampled SSxSS. */
function render(width, height, colourAt) {
  const out = new Uint8Array(width * height * 3);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colourAt(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (py * width + px) * 3;
      const n = SS * SS;
      out[i] = Math.round(r / n);
      out[i + 1] = Math.round(g / n);
      out[i + 2] = Math.round(b / n);
    }
  }
  return out;
}

/** The mark in a box of side `size` at (ox, oy), or undefined outside it. */
function markColour(x, y, ox, oy, size) {
  const u = (x - ox) / size;
  const v = (y - oy) / size;
  if (!inShield(u, v)) return undefined;
  if (inHandset(u, v, 0.5, 0.47, 0.78)) return BRAND;
  // small amber "live" dot on the shield
  if (Math.hypot(u - 0.7, v - 0.27) <= 0.042) return ACCENT;
  return WHITE;
}

export function renderIcon(size) {
  const rgb = render(size, size, (x, y) => markColour(x, y, 0, 0, size) ?? BRAND);
  return encodePng(size, size, rgb);
}

export function renderCarousel() {
  const { width, height } = CAROUSEL;
  const markSize = 420;
  const ox = (width - markSize) / 2;
  const oy = 130;
  const title = textShape('STAND-IN', width / 2, 590, 11);
  const tagline = textShape('HOLDS THE LINE FOR YOU', width / 2, 712, 4);
  const rgb = render(width, height, (x, y) => {
    const m = markColour(x, y, ox, oy, markSize);
    if (m !== undefined) return m;
    if (title(x, y)) return WHITE;
    if (tagline(x, y)) return ACCENT;
    return BRAND;
  });
  return encodePng(width, height, rgb);
}

export function generateAll(outDir) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const s of ICON_SIZES) {
    const name = `icon-${s}x${s}.png`;
    writeFileSync(join(outDir, name), renderIcon(s));
    written.push(name);
  }
  const name = `carousel-${CAROUSEL.width}x${CAROUSEL.height}.png`;
  writeFileSync(join(outDir, name), renderCarousel());
  written.push(name);
  return written;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets'));
  const files = generateAll(outDir);
  console.log(`addon assets: wrote ${files.length} PNGs to ${outDir}`);
}
