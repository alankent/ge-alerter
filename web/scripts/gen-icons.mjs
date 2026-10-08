// Generates the PWA icons as PNGs with no dependencies (a white bell on a fluorescent pink tile, #FF1493).
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance of a bell shape centred in a unit square, negative inside. */
function bell(u, v) {
  // Dome: circle centred (0.5, 0.42) r 0.2, plus body widening to a skirt at v=0.68.
  const dome = Math.hypot(u - 0.5, v - 0.42) - 0.2;
  let body = Infinity;
  if (v >= 0.42 && v <= 0.68) {
    const half = 0.2 + ((v - 0.42) / 0.26) * 0.1;
    body = Math.max(Math.abs(u - 0.5) - half, v - 0.68, 0.42 - v);
  }
  const skirt = Math.max(Math.abs(u - 0.5) - 0.34, Math.abs(v - 0.7) - 0.03);
  const clapper = Math.hypot(u - 0.5, v - 0.79) - 0.06;
  const knob = Math.hypot(u - 0.5, v - 0.2) - 0.045;
  return Math.min(dome, body, skirt, clapper, knob);
}

function coverage(d, px) {
  // Anti-alias by mapping distance (in pixels) to alpha.
  return Math.max(0, Math.min(1, 0.5 - d * px));
}

function tile(size, { maskable }) {
  const bg = [255, 20, 147];
  const radius = maskable ? 0 : 0.22 * size;
  const scale = maskable ? 0.62 : 0.78;
  return png(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    // Rounded square background.
    const cx = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0);
    const cy = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0);
    const rect = Math.hypot(cx, cy) - radius;
    const bgA = coverage(rect, 1);
    // Bell, scaled about the centre.
    const bu = (u - 0.5) / scale + 0.5;
    const bv = (v - 0.5) / scale + 0.5;
    const fgA = coverage(bell(bu, bv) * size * scale, 1);
    const r = Math.round(bg[0] + (255 - bg[0]) * fgA);
    const g = Math.round(bg[1] + (255 - bg[1]) * fgA);
    const b = Math.round(bg[2] + (255 - bg[2]) * fgA);
    return [r, g, b, Math.round(bgA * 255)];
  });
}

function badge(size) {
  // Monochrome: white bell on transparent, as Chrome expects for badges.
  return png(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const a = coverage(bell(u, v) * size, 1);
    return [255, 255, 255, Math.round(a * 255)];
  });
}

const targets = [
  ['icon-192.png', () => tile(192, { maskable: false })],
  ['icon-512.png', () => tile(512, { maskable: false })],
  ['icon-512-maskable.png', () => tile(512, { maskable: true })],
  ['badge-96.png', () => badge(96)],
];
for (const [name, make] of targets) {
  const file = join(outDir, name);
  if (process.argv.includes('--force') || !existsSync(file)) writeFileSync(file, make());
}
