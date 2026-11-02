// Creates icon.png 512x512 (a floor plan: walls, a door swing, a grid line) with plain Node, no external libraries needed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const SS = 4; // supersampling for anti-aliasing
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icon.png');

const WALL = [241, 245, 249];
const DOOR = [56, 189, 248];
const GRID = [248, 113, 113];
// Walls of a room (x0, y0, x1, y1) with a gap for the door on the bottom wall.
const RECTS = [
  [112, 112, 400, 140], // top
  [112, 112, 140, 400], // left
  [372, 112, 400, 400], // right
  [112, 372, 200, 400], // bottom left of the door
  [312, 372, 400, 400], // bottom right of the door
];

function inRoundedSquare(x, y, r = 104) {
  const dx = Math.max(r - x, 0, x - (SIZE - r)), dy = Math.max(r - y, 0, y - (SIZE - r));
  return dx * dx + dy * dy <= r * r;
}

function sample(x, y) {
  if (!inRoundedSquare(x, y)) return [0, 0, 0, 0];
  for (const [x0, y0, x1, y1] of RECTS) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return [...WALL, 255];
  // Door: leaf from the hinge (200, 386) up to (200, 274) and a quarter swing arc back to (312, 386).
  if (x >= 196 && x <= 206 && y >= 274 && y <= 386) return [...DOOR, 255];
  const r = Math.hypot(x - 200, y - 386);
  if (x >= 200 && y <= 386 && Math.abs(r - 112) <= 3.5) return [...DOOR, 255];
  // Dash-dot grid line through the middle.
  if (Math.abs(y - 256) <= 3 && x > 60 && x < 452 && (Math.floor((x - 60) / 28) % 2 === 0)) return [...GRID, 255];
  const t = y / SIZE; // dark blue gradient background
  return [Math.round(15 + 10 * t), Math.round(39 + 14 * t), Math.round(71 + 22 * t), 255];
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const p = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
      acc[0] += p[0] * p[3]; acc[1] += p[1] * p[3]; acc[2] += p[2] * p[3]; acc[3] += p[3];
    }
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    const a = acc[3];
    raw[o] = a ? Math.round(acc[0] / a) : 0;
    raw[o + 1] = a ? Math.round(acc[1] / a) : 0;
    raw[o + 2] = a ? Math.round(acc[2] / a) : 0;
    raw[o + 3] = Math.round(a / (SS * SS));
  }
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(OUT, png);
console.log(`icon.png ${SIZE}x${SIZE}, ${png.length} bytes -> ${OUT}`);
