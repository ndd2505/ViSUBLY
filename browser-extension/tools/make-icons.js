'use strict';
// Throwaway placeholder icon generator: node browser-extension/tools/make-icons.js
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function inPoly(x, y, pts) {
  let r = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) r = !r;
  }
  return r;
}
function coverage(size, px, py) { // 4x4 supersample, returns {bg, fg} coverage 0..1
  let bg = 0, fg = 0; const S = 4, rad = size * 0.22, u = size / 100;
  const arrow = [[42, 22], [58, 22], [58, 50], [72, 50], [50, 76], [28, 50], [42, 50]].map(([a, b]) => [a * u, b * u]);
  for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
    const x = px + (sx + 0.5) / S, y = py + (sy + 0.5) / S;
    const cx = Math.min(Math.max(x, rad), size - rad), cy = Math.min(Math.max(y, rad), size - rad);
    if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) { bg++; if (inPoly(x, y, arrow) || (y >= 82 * u && y <= 88 * u && x >= 28 * u && x <= 72 * u)) fg++; }
  }
  return { bg: bg / 16, fg: fg / 16 };
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const { bg, fg } = coverage(size, x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const f = bg ? fg / bg : 0;
      raw[o] = Math.round(255 * f + 255 * (1 - f)); raw[o + 1] = Math.round(255 * f + 139 * (1 - f)); raw[o + 2] = Math.round(255 * f + 110 * (1 - f));
      raw[o + 3] = Math.round(bg * 255);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = path.join(__dirname, '..', 'chrome', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${s}.png`), png(s));
console.log('icons written to', out);
