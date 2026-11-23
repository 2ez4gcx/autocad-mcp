// Floor plan engine (pure geometry, lengths in mm): turns a plan spec (walls on axes, openings, columns, grids, stairs,
// rooms, symbols) into what the bridge's draw_plan command needs:
//   walls  : wall pieces per material (segment rectangles + junction polygons); the bridge unions them, so L/T/X
//            junctions come out clean, then cuts the openings and columns out of the outline and hatches it
//   cuts   : one rectangle per opening, columns: column footprints
//   rooms  : name + a point inside; the bridge measures the face the walls enclose (the area is never typed)
//   entities: doors, windows, grids, columns, stairs, symbols and dimension chains (draw_entities specs)
import { ROLE, ROOM, TEXT_STYLE, dimStyleName, getDrawingLanguage, words } from './standards.mjs';
import { blockName, sym, tagSym } from './symbols.mjs';

const EPS = 1e-6;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; };
const left = (d) => [-d[1], d[0]];
const bboxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const boxesOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The box around the entities (and extra boxes) drawn so far: points, block boxes, circles. */
function boundsOf(ents, extra = []) {
  const bs = [...extra];
  for (const e of ents) {
    if (e.box) bs.push(e.box);
    const pts = [e.from, e.to, e.at, e.start, e.end, ...(e.points || [])].filter(Array.isArray);
    if (pts.length) bs.push(bboxOf(pts));
  }
  if (!bs.length) return null;
  return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
}

/** Where the line a + d·s enters and leaves box b ([s0, s1]), or null when it misses it. */
function lineThroughBox(a, d, b) {
  let s0 = -Infinity, s1 = Infinity;
  for (const k of [0, 1]) {
    if (Math.abs(d[k]) < 1e-12) {
      if (a[k] < b[k] || a[k] > b[k + 2]) return null;
      continue;
    }
    const t0 = (b[k] - a[k]) / d[k], t1 = (b[k + 2] - a[k]) / d[k];
    s0 = Math.max(s0, Math.min(t0, t1));
    s1 = Math.min(s1, Math.max(t0, t1));
  }
  return s0 <= s1 ? [s0, s1] : null;
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const P = (p) => [r6(p[0]), r6(p[1])];
const dist = (a, b) => len(sub(a, b));

export class PlanError extends Error {}

// Wall materials: hatch pattern and scale factor (x plot scale) for the cut face.
export const MATERIALS = {
  brick: { pattern: 'ANSI31', k: 0.6 },
  concrete: { pattern: 'AR-CONC', k: 0.05 },
  block: { pattern: 'ANSI32', k: 0.6 },
  light: { pattern: 'AR-SAND', k: 0.05 },
  stone: { pattern: 'ANSI33', k: 0.6 },
  solid: { pattern: 'SOLID', k: 1 },
  none: null,
};

const LABELS = {
  vi: { up: 'LÊN', down: 'XUỐNG', north: 'B' },
  en: { up: 'UP', down: 'DN', north: 'N' },
};

export function num(v, name, { min = -Infinity, positive = false } = {}) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new PlanError(`${name} must be a number`);
  if (positive && n <= 0) throw new PlanError(`${name} must be > 0`);
  if (n < min) throw new PlanError(`${name} must be >= ${min}`);
  return n;
}

export function pt(v, name) {
  if (!Array.isArray(v) || v.length < 2) throw new PlanError(`${name} must be [x, y]`);
  return [num(v[0], `${name}[0]`), num(v[1], `${name}[1]`)];
}

/** Convex hull (monotone chain), counter-clockwise. */
export function hull(points) {
  const p = [...points].map(P).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const uniq = p.filter((q, i) => i === 0 || dist(q, p[i - 1]) > 1e-6);
  if (uniq.length < 3) return uniq;
  const turn = (o, a, b) => cross(sub(a, o), sub(b, o));
  const lower = [];
  for (const q of uniq) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-9) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const q = uniq[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-9) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += cross(pts[i], pts[(i + 1) % pts.length]);
  return a / 2;
}

/** Intersection of lines p + s*u and q + t*v, or null when parallel. */
function intersect(p, u, q, v) {
  const d = cross(u, v);
  if (Math.abs(d) < 1e-9) return null;
  const s = cross(sub(q, p), v) / d;
  return add(p, mul(u, s));
}

/**
 * The points of an arc from a to b by its bulge (tan of a quarter of its angle, positive = counter-clockwise, as in a
 * polyline), a excluded and b included: chords whose sagitta stays under 5 mm (or no longer than chord), 4 at least.
 */
export function arcPoints(a, b, bulge, chord = null, openings = []) {
  const c = dist(a, b), th = 4 * Math.atan(bulge);
  if (Math.abs(bulge) < 1e-9 || c < 1) return [b];
  const R = c / (2 * Math.sin(Math.abs(th) / 2));
  const d = unit(sub(b, a)), n = left(d);
  const ctr = add(mul(add(a, b), 0.5), mul(n, (c / 2) / Math.tan(th / 2)));
  const step = (chord ? 2 * Math.asin(Math.min(1, chord / (2 * R))) : 2 * Math.acos(Math.max(-1, 1 - 5 / R))) / Math.abs(th);
  const a0 = Math.atan2(a[1] - ctr[1], a[0] - ctr[0]);
  const at = (t) => (t >= 1 - 1e-12 ? b : [ctr[0] + R * Math.cos(a0 + th * t), ctr[1] + R * Math.sin(a0 + th * t)]);
  // an opening stands in one straight chord of its own (a door or a window is straight): from its jambs, 50 mm clear
  const keep = openings.map((o) => {
    let f = (Math.atan2(o.at[1] - ctr[1], o.at[0] - ctr[0]) - a0) / th;
    f -= Math.floor(f);
    const half = Math.asin(Math.min(1, (o.width / 2 + 50) / R)) / Math.abs(th);
    return [Math.max(0, f - half), Math.min(1, f + half)];
  }).sort((x, y) => x[0] - y[0]);
  const ts = [0];
  const fill = (to) => {
    const from = ts[ts.length - 1];
    if (to - from < 1e-9) return;
    const k = Math.max(1, Math.ceil((to - from) / Math.max(step, 1e-4)));
    for (let i = 1; i <= k; i++) ts.push(from + ((to - from) * i) / k);
  };
  for (const [t0, t1] of keep) {
    if (t0 < ts[ts.length - 1] - 1e-9) continue; // overlaps the one before: the plan engine reports the overlap
    fill(t0);
    ts.push(t1);
  }
  fill(1);
  // four chords at least on an arc with no opening
  if (ts.length < 5 && !keep.length) return [1, 2, 3, 4].map((i) => at(i / 4));
  return ts.slice(1).map(at);
}

/** The length of an arc from a to b by its bulge. */
export const arcLength = (a, b, bulge) => {
  const c = dist(a, b), th = 4 * Math.atan(bulge);
  return Math.abs(bulge) < 1e-9 ? c : (c / (2 * Math.sin(Math.abs(th) / 2))) * Math.abs(th);
};

const okPoint = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1]));
// the open spaces among the rooms: a wall facing one is an outer wall (a lightwell is open to the sky)
const OPEN_TO_SKY = words('GIẾNG TRỜI', 'GIENG TROI', 'LIGHT ?WELLS?');
const isOpenRoom = (name) => ROOM.outdoor.test(name) || OPEN_TO_SKY.test(name);
const roleCache = new Map();

/**
 * Which walls stand on the outside of the building and which are partitions between rooms. The wall axes cut the plan
 * into regions (a raster flood fill): a region is inside when it holds the name of an indoor room, outside when it
 * reaches the edge of the plan, holds only open spaces (yard, balcony, terrace, lightwell) or is an unnamed region next
 * to an outside one (the ring between a house and its fence, a roof terrace round a stair tower, a courtyard). A
 * segment is outer when a point beside it lies outside; a wall is outer when one of its segments is. A plan without
 * room names, or a room whose region leaks out (a gap left for a door), falls back to rays: a point 300 mm off the
 * wall that sees out in two of the four directions. Returns ['outer' | 'partition'] by wall.
 */
export function wallRoles(spec) {
  const rooms = (spec.rooms || []).filter((r) => okPoint(r?.at)).map((r) => ({ name: String(r.name ?? '').normalize('NFC'), at: [Number(r.at[0]), Number(r.at[1])] }));
  const key = JSON.stringify([spec.walls ?? [], rooms]);
  if (roleCache.has(key)) return roleCache.get(key);
  const out = computeRoles(spec, rooms);
  if (roleCache.size > 64) roleCache.delete(roleCache.keys().next().value);
  roleCache.set(key, out);
  return out;
}

function computeRoles(spec, rooms) {
  const axes = (spec.walls || []).map((w) => {
    // a wall the description has wrong is left to buildWalls to report
    if (!Array.isArray(w?.points) || w.points.length < 2 || !w.points.every(okPoint)) return [];
    const pts = w.points.map((p) => [Number(p[0]), Number(p[1])]);
    if (w.closed && pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) > EPS) pts.push(pts[0]);
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      let a = pts[i];
      for (const b of arcPoints(a, pts[i + 1], Number(w.bulges?.[i] ?? 0) || 0)) {
        if (dist(a, b) >= 1) segs.push([a, b]);
        a = b;
      }
    }
    return segs;
  });
  const all = axes.flat();
  if (!all.length) return axes.map(() => 'outer');
  // ---- rays: does a ray from q in direction d (up to tMax times d) cross a wall axis?
  const hits = (q, d, tMax = Infinity) => all.some(([a, b]) => {
    const e = sub(b, a), den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-12) return false;
    const w = sub(a, q);
    const t = (w[0] * e[1] - w[1] * e[0]) / den, s = (w[0] * d[1] - w[1] * d[0]) / den;
    return t > 1e-6 && t < tMax && s >= -1e-9 && s <= 1 + 1e-9;
  });
  const openAt = rooms.filter((r) => isOpenRoom(r.name)).map((r) => r.at);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const raySees = (q) => DIRS.filter((d) => !hits(q, d)).length >= 2 || openAt.some((p) => !hits(q, sub(p, q), 1));
  const sides = (a, b, off) => {
    const d = unit(sub(b, a)), n = left(d);
    return [0.25, 0.5, 0.75].map((f) => {
      const m = add(a, mul(sub(b, a), f));
      return [add(m, mul(n, off)), add(m, mul(n, -off))];
    });
  };
  if (!rooms.length) return axes.map((segs) => (segs.some(([a, b]) => sides(a, b, 300).some(([p, q]) => raySees(p) || raySees(q))) ? 'outer' : 'partition'));
  // ---- regions: the axes drawn on a raster, the cells between them flood-filled
  const xs = all.flatMap(([a, b]) => [a[0], b[0]]), ys = all.flatMap(([a, b]) => [a[1], b[1]]);
  const M = 1500, x0 = Math.min(...xs) - M, y0 = Math.min(...ys) - M;
  const cell = Math.max(25, (Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) + M) / 800);
  const nx = Math.ceil((Math.max(...xs) + M - x0) / cell) + 1, ny = Math.ceil((Math.max(...ys) + M - y0) / cell) + 1;
  const grid = new Int32Array(nx * ny); // 0 free, -1 wall, >0 region
  const ix = (x) => Math.floor((x - x0) / cell), iy = (y) => Math.floor((y - y0) / cell);
  for (const [a, b] of all) {
    // a little past each end: axes that should meet but stop a hair short do not leave a gap
    const L = dist(a, b), d = unit(sub(b, a)), ext = Math.max(cell, 30);
    const n = Math.ceil((L + 2 * ext) / (cell / 3));
    for (let k = 0; k <= n; k++) {
      const p = add(a, mul(d, -ext + (k * (L + 2 * ext)) / n));
      const i = ix(p[0]), j = iy(p[1]);
      if (i >= 0 && j >= 0 && i < nx && j < ny) grid[j * nx + i] = -1;
    }
  }
  const border = [];
  let nReg = 0;
  const stack = [];
  for (let s0 = 0; s0 < grid.length; s0++) {
    if (grid[s0] !== 0) continue;
    nReg++;
    let edge = false;
    grid[s0] = nReg;
    stack.push(s0);
    while (stack.length) {
      const c = stack.pop(), i = c % nx, j = (c - i) / nx;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) edge = true;
      if (i > 0 && grid[c - 1] === 0) { grid[c - 1] = nReg; stack.push(c - 1); }
      if (i < nx - 1 && grid[c + 1] === 0) { grid[c + 1] = nReg; stack.push(c + 1); }
      if (j > 0 && grid[c - nx] === 0) { grid[c - nx] = nReg; stack.push(c - nx); }
      if (j < ny - 1 && grid[c + nx] === 0) { grid[c + nx] = nReg; stack.push(c + nx); }
    }
    border[nReg] = edge;
  }
  // the region of a point (the nearest free cell when it falls on an axis)
  const regionAt = (p) => {
    const i0 = ix(p[0]), j0 = iy(p[1]);
    for (let r = 0; r <= 3; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const i = i0 + di, j = j0 + dj;
          if (i >= 0 && j >= 0 && i < nx && j < ny && grid[j * nx + i] > 0) return grid[j * nx + i];
        }
      }
    }
    return 0;
  };
  const indoor = new Set(), open = new Set();
  for (const r of rooms) {
    const g = regionAt(r.at);
    if (g) (isOpenRoom(r.name) ? open : indoor).add(g);
  }
  // in / out / leak (an indoor room that reaches the edge: a gap; rays decide there) / unknown (unnamed, closed)
  const state = [];
  for (let g = 1; g <= nReg; g++) {
    state[g] = indoor.has(g) ? (border[g] ? 'leak' : 'in') : border[g] || open.has(g) ? 'out' : 'unknown';
  }
  const off = Math.max(150, 2 * cell);
  const samples = axes.map((segs) => segs.map(([a, b]) => sides(a, b, off).map(([p, q]) => ({ p, q, g: regionAt(p), h: regionAt(q) }))));
  // an unnamed region next to an outside one is outside too (a fence ring, a terrace round a stair tower)
  for (let changed = true; changed;) {
    changed = false;
    for (const segs of samples) {
      for (const ss of segs) {
        for (const { g, h } of ss) {
          if (state[g] === 'unknown' && state[h] === 'out') { state[g] = 'out'; changed = true; }
          if (state[h] === 'unknown' && state[g] === 'out') { state[h] = 'out'; changed = true; }
        }
      }
    }
  }
  const outside = (g, p) => (state[g] === 'out' ? true : state[g] === 'leak' ? raySees(p) : false);
  return samples.map((segs) => (segs.some((ss) => ss.some(({ p, q, g, h }) => outside(g, p) || outside(h, q))) ? 'outer' : 'partition'));
}

/** The thickness a wall takes when it gives none: wall_thickness for all when given, else 200 outer and 100 partitions. */
export function defaultThickness(spec, roles) {
  if (spec.wall_thickness !== undefined && spec.partition_thickness === undefined) return () => spec.wall_thickness;
  return (i) => (roles[i] === 'partition' ? spec.partition_thickness ?? 100 : spec.wall_thickness ?? 200);
}

/**
 * Normalised walls with their segments: axis a->b, direction d, face offsets [o1, o2] along left(d). A wall with bulges
 * (one per segment, 0 = straight) is curved there: the arc becomes short chords (chord: their longest length, default
 * by a 5 mm sagitta), so every engine measures and draws it as it does straight walls; from: the segment of the
 * description each chord comes from.
 */
export function buildWalls(spec) {
  const walls = [];
  const needRoles = (spec.walls || []).some((w) => w?.thickness == null);
  const roles = needRoles ? wallRoles(spec) : [];
  const tDefault = defaultThickness(spec, roles);
  (spec.walls || []).forEach((w, wi) => {
    const name = `walls[${wi}]`;
    if (!Array.isArray(w.points) || w.points.length < 2) throw new PlanError(`${name}.points needs at least 2 points`);
    const pts = w.points.map((p, i) => pt(p, `${name}.points[${i}]`));
    const t = num(w.thickness ?? tDefault(wi), `${name}.thickness`, { positive: true });
    const just = w.justify ?? 'center';
    const offs = { center: [-t / 2, t / 2], left: [0, t], right: [-t, 0] }[just];
    if (!offs) throw new PlanError(`${name}.justify must be center, left or right`);
    const material = w.material ?? spec.wall_material ?? 'brick';
    if (!(material in MATERIALS)) throw new PlanError(`${name}.material must be one of ${Object.keys(MATERIALS).join(', ')}`);
    if (w.closed && pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) > EPS) pts.push(pts[0]);
    const bulges = Array.isArray(w.bulges) ? w.bulges.map((b, i) => num(b ?? 0, `${name}.bulges[${i}]`)) : null;
    const chord = w.chord !== undefined ? num(w.chord, `${name}.chord`, { positive: true }) : null;
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const bg = bulges?.[i] ?? 0;
      if (Math.abs(bg) > 4) throw new PlanError(`${name}.bulges[${i}] ${bg}: an arc of more than 300 degrees; draw it as two arcs`);
      let a = pts[i];
      const ops = bg ? (spec.openings || []).filter((o) => (o.wall === wi || o.wall === (w.id ?? `W${wi + 1}`)) && (o.segment ?? 0) === i && Array.isArray(o.at) && o.width > 0) : [];
      for (const b of arcPoints(a, pts[i + 1], bg, chord, ops)) {
        const L = dist(a, b);
        if (L < 1) throw new PlanError(`${name}: segment ${i} is shorter than 1 mm`);
        segs.push({ wall: wi, index: segs.length, from: i, a, b, d: unit(sub(b, a)), L, o1: offs[0], o2: offs[1], t, ...(bg ? { curved: true } : {}) });
        a = b;
      }
    }
    walls.push({ id: w.id ?? `W${wi + 1}`, index: wi, segs, t, material, layer: w.layer, ...(bulges?.some((b) => b) ? { curved: true } : {}) });
  });
  return walls;
}

/**
 * The stairs of a floor as the engines measure and draw them. An L stair {type: "l", start, direction, width, treads:
 * [n1, n2] (or their sum), going, turn: left | right} becomes its first flight, its quarter landing (a square of the
 * width) and its second flight turned 90 degrees, each a straight flight with its share of the storey height
 * (rise_share, rise_from: the risers are one more than the treads in each flight). Other stairs pass through.
 */
export function expandStairs(stairs) {
  const out = [];
  (stairs || []).forEach((st, i) => {
    if (st?.type !== 'l') {
      out.push(st);
      return;
    }
    const name = `stairs[${i}]`;
    const start = pt(st.start, `${name}.start`), dir = num(st.direction ?? 90, `${name}.direction`);
    const a = (dir * Math.PI) / 180, u = [Math.cos(a), Math.sin(a)], n = left(u);
    const w = num(st.width ?? 1000, `${name}.width`, { positive: true }), g = num(st.going ?? 270, `${name}.going`, { positive: true });
    const tr = Array.isArray(st.treads) ? st.treads : [Math.ceil((st.treads ?? 16) / 2), Math.floor((st.treads ?? 16) / 2)];
    const n1 = Math.round(num(tr[0], `${name}.treads[0]`, { positive: true })), n2 = Math.round(num(tr[1], `${name}.treads[1]`, { positive: true }));
    if (st.turn !== undefined && !['left', 'right'].includes(st.turn)) throw new PlanError(`${name}.turn must be left or right`);
    const turn = st.turn === 'right' ? -1 : 1, T = n1 + n2 + 2;
    const base = { width: w, going: g, ...(st.height !== undefined ? { height: st.height } : {}), of: i };
    const C = add(start, mul(u, n1 * g + w / 2)), u2 = mul(n, turn);
    out.push({ ...base, start: P(start), direction: dir, treads: n1, risers: n1 + 1, rise_share: (n1 + 1) / T, rise_from: 0, ...(st.label !== undefined ? { label: st.label } : {}) });
    out.push({ ...base, start: P(add(start, mul(u, n1 * g))), direction: dir, treads: 1, going: w, risers: 0, rise_share: 0, rise_from: (n1 + 1) / T, landing: true, label: '' });
    out.push({ ...base, start: P(add(C, mul(u2, w / 2))), direction: dir + 90 * turn, treads: n2, risers: n2 + 1, rise_share: (n2 + 1) / T, rise_from: (n1 + 1) / T, label: '' });
  });
  return out;
}

/**
 * A spiral stair {type: "spiral", center, radius (outer, default 900), inner (the post, default 100), treads (14),
 * sweep (degrees turned from the foot to the head, default 300), start_angle (of the first riser, default 0),
 * clockwise}: its sizes checked, angles in radians.
 */
export function spiralGeom(st, name = 'stairs[]') {
  const c = pt(st.center, `${name}.center`);
  const R = num(st.radius ?? 900, `${name}.radius`, { positive: true }), r = num(st.inner ?? 100, `${name}.inner`, { min: 0 });
  if (r >= R) throw new PlanError(`${name}.inner must be less than radius`);
  const k = Math.round(num(st.treads ?? 14, `${name}.treads`, { positive: true }));
  const sweepDeg = num(st.sweep ?? 300, `${name}.sweep`, { positive: true });
  if (sweepDeg > 720) throw new PlanError(`${name}.sweep over 720 degrees`);
  const sgn = st.clockwise ? -1 : 1, a0 = (num(st.start_angle ?? 0, `${name}.start_angle`) * Math.PI) / 180, sweep = (sweepDeg * Math.PI) / 180;
  const ang = (i) => a0 + (sgn * sweep * i) / k;
  const at = (rad, t) => [c[0] + rad * Math.cos(t), c[1] + rad * Math.sin(t)];
  return { c, R, r, k, sweep, sweepDeg, sgn, a0, ang, at, risers: k + 1, area: (sweep / 2) * (R * R - r * r), box: [c[0] - R, c[1] - R, c[0] + R, c[1] + R] };
}

export function segRect(s, from = 0, to = s.L, extra = 0) {
  const n = left(s.d);
  const p0 = add(s.a, mul(s.d, from));
  const p1 = add(s.a, mul(s.d, to));
  return [add(p0, mul(n, s.o1 - extra)), add(p1, mul(n, s.o1 - extra)), add(p1, mul(n, s.o2 + extra)), add(p0, mul(n, s.o2 + extra))].map(P);
}

/** Junction polygons: at every point where segment ends meet, the hull of their end edges and face-line miters. */
function joints(walls, tol = 1) {
  const ends = [];
  for (const w of walls) {
    for (const s of w.segs) {
      // u points from the node into the segment; offsets re-expressed along left(u).
      ends.push({ p: s.a, u: s.d, lo: s.o1, hi: s.o2, s });
      ends.push({ p: s.b, u: mul(s.d, -1), lo: -s.o2, hi: -s.o1, s });
    }
  }
  const nodes = [];
  for (const e of ends) {
    let node = nodes.find((n) => dist(n.p, e.p) <= tol);
    if (!node) nodes.push(node = { p: e.p, ends: [] });
    node.ends.push(e);
  }
  const polys = [];
  for (const node of nodes) {
    if (node.ends.length < 2) continue;
    const es = node.ends.map((e) => ({ ...e, ang: Math.atan2(e.u[1], e.u[0]) })).sort((x, y) => x.ang - y.ang);
    const pts = [];
    for (const e of es) {
      const n = left(e.u);
      pts.push(add(e.p, mul(n, e.lo)), add(e.p, mul(n, e.hi)));
    }
    const maxT = Math.max(...es.map((e) => e.hi - e.lo));
    for (let i = 0; i < es.length; i++) {
      const a = es[i];
      const b = es[(i + 1) % es.length];
      // Between a and the next end counter-clockwise: a's left face meets b's right face.
      const pa = add(a.p, mul(left(a.u), a.hi));
      const pb = add(b.p, mul(left(b.u), b.lo));
      const x = intersect(pa, a.u, pb, b.u);
      if (x && dist(x, node.p) <= 4 * maxT) pts.push(x);
    }
    const h = hull(pts);
    if (h.length >= 3 && Math.abs(polyArea(h)) > 1) polys.push(h);
  }
  return polys;
}

export function findSegment(walls, o, name) {
  let w;
  if (typeof o.wall === 'number') w = walls[o.wall];
  else w = walls.find((x) => x.id === o.wall);
  if (!w) throw new PlanError(`${name}.wall '${o.wall}' not found (use a wall id or its index)`);
  const si = o.segment ?? 0;
  // the segment of the description; on a curved one, the chord nearest to the point of the opening
  let cands = w.curved ? w.segs.filter((x) => x.from === si) : [w.segs[si]].filter(Boolean);
  if (!cands.length) throw new PlanError(`${name}.segment ${si} does not exist (wall ${w.id} has ${w.curved ? Math.max(...w.segs.map((x) => x.from)) + 1 : w.segs.length} segments)`);
  let s = cands[0];
  if (cands.length > 1) {
    if (!Array.isArray(o.at)) throw new PlanError(`${name}: an opening on a curved wall needs at (a point on the wall)`);
    const dSeg = (x) => {
      const u = Math.max(0, Math.min(x.L, dot(sub(o.at, x.a), x.d)));
      return dist(o.at, add(x.a, mul(x.d, u)));
    };
    s = cands.reduce((m, x) => (dSeg(x) < dSeg(m) ? x : m));
  }
  return { w, s };
}

/** Opening position along its segment: offset from the segment start, or "at" a point near the axis. */
export function openingSpan(s, o, name) {
  const width = num(o.width ?? 900, `${name}.width`, { positive: true });
  let from;
  if (o.at !== undefined) {
    // "at" = the opening's centre (projected on the axis).
    const c = dot(sub(pt(o.at, `${name}.at`), s.a), s.d);
    from = c - width / 2;
  } else from = num(o.offset ?? 0, `${name}.offset`);
  const to = from + width;
  if (from < -0.5 || to > s.L + 0.5) {
    throw new PlanError(`${name}: the opening (${Math.round(from)} to ${Math.round(to)} along the axis) does not fit in wall segment of length ${Math.round(s.L)}`);
  }
  return { from: Math.max(0, from), to: Math.min(s.L, to), width };
}

const DOOR_TYPES_VI = { door: 'Cửa đi 1 cánh', double_door: 'Cửa đi 2 cánh', sliding: 'Cửa lùa', window: 'Cửa sổ' };
const DOOR_TYPES_EN = { door: 'Single door', double_door: 'Double door', sliding: 'Sliding door', window: 'Window' };
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * A door or window as a block insert: drawn in its own frame (origin, x along the wall, y across it) and inserted with
 * the rotation and mirror that map it onto (ex, ey). One definition per kind and size (and wall thickness for windows
 * and sliding doors); code, kind and width as invisible attributes (a door/window count by block name).
 */
function openingBlock(kind, size, entities, origin, ex, ey, o, layer) {
  const DOOR_TYPES = getDrawingLanguage() === 'en' ? DOOR_TYPES_EN : DOOR_TYPES_VI;
  const rot = (Math.atan2(ey[1], ey[0]) * 180) / Math.PI - 90;
  const sx = Math.sign(dot(ex, [ey[1], -ey[0]])) || 1;
  const name = blockName([{ door: 'MCP_CUA_DI', double_door: 'MCP_CUA_DI_2C', sliding: 'MCP_CUA_LUA', window: 'MCP_CUA_SO' }[kind], ...size.map((v) => r1(v))]);
  const local = entities.flatMap((e) => [e.from, e.to, e.start, e.mid, e.end, ...(e.points || [])].filter(Boolean));
  const world = local.map((p) => add(add(origin, mul(ex, p[0])), mul(ey, p[1])));
  const xs = world.map((p) => p[0]), ys = world.map((p) => p[1]);
  return {
    type: 'block', name, at: P(origin), rotation: Math.round((((rot % 360) + 360) % 360) * 1000) / 1000, scale: sx < 0 ? [-1, 1, 1] : 1, layer,
    attributes: { MA: o.tag === undefined ? '' : String(o.tag), LOAI: DOOR_TYPES[kind], RONG: String(r1(size[0])) },
    def: {
      name, description: `${DOOR_TYPES[kind]} ${size.map(r1).join('x')}`, entities,
      attributes: (getDrawingLanguage() === 'en' ? [['MA', 'Tag'], ['LOAI', 'Type'], ['RONG', 'Width']] : [['MA', 'Mã cửa'], ['LOAI', 'Loại'], ['RONG', 'Rộng']]).map(([tag, prompt], i) => (
        { tag, prompt, at: [size[0] / 2, -100 - 120 * i], height: 80, invisible: true, style: TEXT_STYLE })),
    },
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
}

/** Door, window and opening symbols (plan view, cut above the sill). */
function openingSymbols(s, o, span, scale, name, center, avoid = []) {
  const type = o.type ?? 'door';
  const n = left(s.d);
  const e = [];
  const at = (along, off) => P(add(add(s.a, mul(s.d, along)), mul(n, off)));
  const doorLayer = o.layer ?? ROLE.door;
  const winLayer = o.layer ?? ROLE.window;
  // Swing side: "toward" a point (e.g. inside the room), else side "left"/"right" of the axis direction.
  let side = o.side === 'right' ? -1 : 1;
  if (o.toward) side = cross(s.d, sub(pt(o.toward, `${name}.toward`), s.a)) >= 0 ? 1 : -1;
  const face = side > 0 ? s.o2 : s.o1;
  const mid = (span.from + span.to) / 2;
  switch (type) {
    case 'door':
    case 'double_door': {
      // frame: x from the hinge (single) or the start jamb (double) along the opening, y the swing side
      const w = span.to - span.from;
      const ey = mul(n, side);
      const k = Math.SQRT1_2;
      let ents, origin, ex;
      if (type === 'door') {
        const fromEnd = o.hinge === 'end';
        origin = at(fromEnd ? span.to : span.from, face);
        ex = fromEnd ? mul(s.d, -1) : s.d;
        // leaf open at 90°, swing arc back to the closing jamb
        ents = [{ type: 'line', from: [0, 0], to: [0, r1(w)] }, { type: 'arc', start: [0, r1(w)], mid: [r1(w * k), r1(w * k)], end: [r1(w), 0] }];
      } else {
        origin = at(span.from, face);
        ex = s.d;
        const h = w / 2;
        ents = [
          { type: 'line', from: [0, 0], to: [0, r1(h)] }, { type: 'arc', start: [0, r1(h)], mid: [r1(h * k), r1(h * k)], end: [r1(h), 0] },
          { type: 'line', from: [r1(w), 0], to: [r1(w), r1(h)] }, { type: 'arc', start: [r1(w), r1(h)], mid: [r1(w - h * k), r1(h * k)], end: [r1(h), 0] },
        ];
      }
      e.push(openingBlock(type, [w], ents, origin, ex, ey, o, doorLayer));
      break;
    }
    case 'sliding': {
      // frame: x along the opening from its start, y across the wall from face o1
      const t = s.o2 - s.o1;
      const w = span.to - span.from;
      const pw = w * 0.55;
      const th = Math.min(40, t / 4);
      const rect = (x0, y0, x1, y1) => ({ type: 'polyline', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map((p) => p.map(r1)), closed: true });
      e.push(openingBlock('sliding', [w, t], [rect(0, t / 2 - th, pw, t / 2), rect(w - pw, t / 2, w, t / 2 + th)], at(span.from, s.o1), s.d, n, o, doorLayer));
      break;
    }
    case 'window': {
      const t = s.o2 - s.o1;
      const w = span.to - span.from;
      const g = Math.min(25, t / 8);
      const ents = [0, t, t / 2 - g, t / 2 + g].map((y) => ({ type: 'line', from: [0, r1(y)], to: [r1(w), r1(y)] }));
      e.push(openingBlock('window', [w, t], ents, at(span.from, s.o1), s.d, n, o, winLayer));
      break;
    }
    case 'opening': {
      for (const off of [s.o1, s.o2]) e.push({ type: 'line', from: at(span.from, off), to: at(span.to, off), layer: ROLE.opening });
      break;
    }
    default:
      throw new PlanError(`${name}.type must be door, double_door, sliding, window or opening`);
  }
  if (o.tag) {
    // Doors: tag on the side away from the swing. Windows and openings: outside the building (away from its centre).
    const swings = (type === 'door' || type === 'double_door') && (o.toward || o.side);
    const tagSide = swings ? -side : (center && cross(s.d, sub(center, s.a)) >= 0 ? -1 : 1);
    const face = tagSide > 0 ? s.o2 : s.o1;
    // the code in a tag block, clear of the wall face; where that place is taken (a stair behind the door) the tag
    // goes to the other side of the wall, beyond the swing
    const mk = (q) => tagSym(String(o.tag), q, scale, ROLE.text, 'hex');
    let tag = mk(o.tag_at ? pt(o.tag_at, `${name}.tag_at`) : at(mid, face + tagSide * 4 * scale));
    const taken = [...avoid, ...e.filter((x) => Array.isArray(x.box)).map((x) => x.box)];
    if (!o.tag_at && taken.some((b) => boxesOverlap(b, tag.box))) {
      // on the swing side: beyond the swing, else beside the door past either jamb
      const other = tagSide > 0 ? s.o1 : s.o2;
      const reach = swings ? (type === 'double_door' ? (span.to - span.from) / 2 : span.to - span.from) : 0;
      const hw = (tag.box[2] - tag.box[0]) / 2, hh = (tag.box[3] - tag.box[1]) / 2;
      const hn = Math.abs(n[0]) > 0.7 ? hw : hh, hs = Math.abs(n[0]) > 0.7 ? hh : hw;
      const alts = [
        at(mid, other - tagSide * (reach + 1.5 * scale + hn)),
        at(span.to + 1.5 * scale + hs, other - tagSide * (1.5 * scale + hn)),
        at(span.from - 1.5 * scale - hs, other - tagSide * (1.5 * scale + hn)),
      ].map(mk);
      tag = alts.find((x) => !taken.some((b) => boxesOverlap(b, x.box))) ?? tag;
    }
    e.push(tag);
  }
  return e;
}

export function rectAround(c, w, h, rotDeg = 0) {
  const r = (rotDeg * Math.PI) / 180;
  const u = [Math.cos(r), Math.sin(r)];
  const v = left(u);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => P(add(c, add(mul(u, (a * w) / 2), mul(v, (b * h) / 2)))));
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I and O skipped (read as 1 and 0)

export function gridList(list, axis) {
  return (list || []).map((g, i) => {
    if (typeof g === 'number') return { at: g, label: axis === 'x' ? String(i + 1) : LETTERS[i % LETTERS.length] + (i >= LETTERS.length ? String(Math.floor(i / LETTERS.length)) : '') };
    return { at: num(g.at, `grids.${axis}[${i}].at`), label: String(g.label ?? (axis === 'x' ? i + 1 : LETTERS[i % LETTERS.length])) };
  });
}

/** Builds the draw_plan request. */
/**
 * Defaults the plan engine applies where the description is silent ([{item, value, note?}]): shown to the user before
 * drawing (dry_run) or after it, to confirm or change.
 */
export function planAssumptions(spec) {
  const out = [];
  const add = (item, value, note) => out.push(note ? { item, value, note } : { item, value });
  const ids = (list, test, name) => (list || []).map((x, i) => (test(x) ? x.id ?? x.tag ?? `${name}[${i}]` : null)).filter(Boolean);
  // walls with no thickness: outer walls 200, partitions between rooms 100 (wall_thickness / partition_thickness)
  if (spec.wall_thickness === undefined || spec.partition_thickness === undefined) {
    const roles = wallRoles(spec), td = defaultThickness(spec, roles);
    for (const role of ['outer', 'partition']) {
      const list = ids(spec.walls, (w) => w.thickness == null && roles[(spec.walls || []).indexOf(w)] === role, 'walls');
      if (!list.length) continue;
      const i = (spec.walls || []).findIndex((w) => w.thickness == null && roles[(spec.walls || []).indexOf(w)] === role);
      if (role === 'outer' ? spec.wall_thickness === undefined : spec.partition_thickness === undefined && spec.wall_thickness === undefined) {
        add(role === 'outer' ? 'walls.thickness (outer walls)' : 'walls.thickness (partitions between rooms)', td(i), `${list.join(', ')}; wall_thickness / partition_thickness or a thickness per wall to change`);
      }
    }
  }
  const noM = spec.wall_material === undefined ? ids(spec.walls, (w) => w.material === undefined, 'walls') : [];
  if (noM.length) add('walls.material', 'brick', noM.join(', '));
  const noW = ids(spec.openings, (o) => o.width === undefined, 'openings');
  if (noW.length) add('openings.width', 900, noW.join(', '));
  const noC = ids(spec.columns, (c) => c.size === undefined, 'columns');
  if (noC.length) add('columns.size', '400x400', noC.join(', '));
  if (spec.grid_columns && spec.grid_columns.size === undefined) add('grid_columns.size', '400x400');
  for (const [i, st] of (spec.stairs || []).entries()) {
    if (st.type === 'u') continue;
    const defs = st.type === 'spiral' ? [['radius', 900], ['inner', 100], ['treads', 14], ['sweep', 300]] : st.type === 'l' ? [['width', 1000], ['treads', '8 + 8'], ['going', 270], ['turn', 'left']] : [['width', 1200], ['treads', 10], ['going', 270]];
    for (const [k, v] of defs) if (st[k] === undefined) add(`stairs[${i}].${k}`, v);
  }
  return out;
}

const STAIR_DIRS = { up: [0, 1], down: [0, -1], right: [1, 0], left: [-1, 0] };

/**
 * U-shaped (dog-leg) stair in a stairwell region [[x0,y0],[x1,y1]]: flight 1 goes up in direction (up/down/left/right
 * in plan, or degrees) from the near end, a half landing at the far end, flight 2 comes back beside it (turn: left or
 * right of flight 1) to the floor above. risers default round(height / 170); the going follows from the region.
 * Returns the geometry in stair coordinates a (along the flights, a0 = near end) and b (across): a point is u*a + n*b.
 */
export function uStairGeom(st, height, name = 'stair') {
  if (!st.region) throw new PlanError(`${name}: a U stair needs region [[x0,y0],[x1,y1]] (the stairwell)`);
  const r0 = pt(st.region[0], `${name}.region[0]`), r1 = pt(st.region[1], `${name}.region[1]`);
  const dn = st.direction ?? 'up';
  const u = STAIR_DIRS[dn] ?? (Number.isFinite(Number(dn)) ? [Math.cos((Number(dn) * Math.PI) / 180), Math.sin((Number(dn) * Math.PI) / 180)] : null);
  if (!u) throw new PlanError(`${name}.direction must be up, down, left, right or an angle in degrees`);
  const n = left(u);
  const cs = [r0, [r1[0], r0[1]], r1, [r0[0], r1[1]]];
  const as = cs.map((q) => dot(q, u)), bs = cs.map((q) => dot(q, n));
  const a0 = Math.min(...as), a1 = Math.max(...as), b0 = Math.min(...bs), b1 = Math.max(...bs);
  const gap = num(st.gap ?? 100, `${name}.gap`, { min: 0 });
  const w = (b1 - b0 - gap) / 2;
  if (w < 600) throw new PlanError(`${name}: the stairwell is too narrow for two flights (${Math.round(w)} each)`);
  const landing = num(st.landing ?? w, `${name}.landing`, { positive: true });
  const risers = Math.round(num(st.risers ?? Math.max(4, Math.round(height / 170)), `${name}.risers`, { min: 4 }));
  const n1 = Math.ceil(risers / 2), n2 = risers - n1;
  const run = a1 - a0 - landing;
  const going = run / Math.max(1, n1 - 1);
  const turnLeft = (st.turn ?? 'left') !== 'right';
  // flight 1 on the side away from the turn, flight 2 on the turn side
  const f1 = turnLeft ? [b0, b0 + w] : [b1 - w, b1];
  const f2 = turnLeft ? [b1 - w, b1] : [b0, b0 + w];
  const warnings = [];
  if (going < 250) warnings.push(`${name}: going ${Math.round(going)} mm is short (make the stairwell longer or give fewer risers)`);
  if (height / risers > 185) warnings.push(`${name}: riser ${Math.round(height / risers)} mm is high (give more risers)`);
  return {
    u, n, a0, a1, b0, b1, w, gap, landing, run, risers, riser: height / risers, going, n1, n2, f1, f2, height,
    at: (a, b) => add(mul(u, a), mul(n, b)), warnings,
  };
}

/**
 * The finished surfaces of a U stair of geometry g, as they are built (not as the plan shows them): tread (m²: the
 * treads of both flights and the half landing), riser (m²: every riser), skirt (m: the skirting on the walls, stepped
 * with the flights - a going and a riser for every step - and around the half landing), rail (m: the handrail along
 * both flights on the slope, and across the well).
 */
export function uStairFinish(g) {
  const goings = g.n1 - 1 + g.n2 - 1, risers = g.n1 + g.n2;
  return {
    tread: (goings * g.going * g.w + g.landing * (g.b1 - g.b0)) / 1e6,
    riser: (risers * g.riser * g.w) / 1e6,
    skirt: (goings * g.going + risers * g.riser + 2 * g.landing + (g.b1 - g.b0)) / 1000,
    rail: (Math.hypot((g.n1 - 1) * g.going, g.n1 * g.riser) + Math.hypot((g.n2 - 1) * g.going, g.n2 * g.riser) + g.gap) / 1000,
  };
}

/** Plan of a U stair: outline, treads, landing, well, walking lines with arrows, UP / DOWN labels, cut line. */
export function uStairPlan(g, mode, scale, L, lang, entities, labelGap = 3 * scale) {
  const at = (a, b) => P(g.at(a, b));
  const line = (a, b, c, d, layer = L.stair) => entities.push({ type: 'line', from: at(a, b), to: at(c, d), layer });
  const pl = (pts) => entities.push({ type: 'polyline', points: pts.map(([a, b]) => at(a, b)), layer: L.stair });
  const { a0, a1, b0, b1, run, going, n1, n2, f1, f2 } = g;
  entities.push({ type: 'polyline', points: [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)], closed: true, layer: L.stair });
  const aL = a0 + run;
  line(aL, b0, aL, b1);
  for (let k = 1; k < n1 - 1; k++) line(a0 + k * going, f1[0], a0 + k * going, f1[1]);
  const start2 = aL - (n2 - 1) * going;
  for (let k = 1; k <= n2 - 1; k++) line(aL - k * going, f2[0], aL - k * going, f2[1]);
  if (start2 > a0 + 1) line(a0, f2[0], a0, f2[1]);
  // well between the flights (both stringers)
  const wl = [Math.min(f1[1], f2[1]), Math.max(f1[0], f2[0])].sort((x, y) => x - y);
  line(a0, wl[0], aL, wl[0]);
  if (wl[1] - wl[0] > 1) line(a0, wl[1], aL, wl[1]);
  const m1 = (f1[0] + f1[1]) / 2, m2 = (f2[0] + f2[1]) / 2, mL = aL + g.landing / 2;
  const ah = Math.min(going * 0.8, 3 * scale);
  const arrow = (tipA, tipB, dirA) => pl([[tipA - dirA * ah, tipB - ah / 2], [tipA, tipB], [tipA - dirA * ah, tipB + ah / 2]]);
  const textAt = (txt, a, b) => entities.push({ type: 'text', text: txt, at: at(a, b), height: 2.5 * scale, align: 'middle_center', layer: L.text, style: TEXT_STYLE });
  const cutA = a0 + Math.min(run * 0.6, Math.max(going * 2, (1200 / g.riser) * going));
  if (mode === 'up' || mode === 'both') {
    // cut line across flight 1 (zigzag), the walking line up to it (both) or round to the floor above (up)
    const z = 0.25 * (f1[1] - f1[0]);
    pl([[cutA - going * 0.4, f1[0]], [cutA - going * 0.1, f1[0] + z * 1.6], [cutA + going * 0.1, f1[1] - z * 1.6], [cutA + going * 0.4, f1[1]]]);
    if (mode === 'up') {
      pl([[a0 + going / 2, m1], [mL, m1], [mL, m2], [start2 + going / 2, m2]]);
      arrow(start2 + going / 2, m2, -1);
    } else {
      pl([[a0 + going / 2, m1], [cutA - going * 0.6, m1]]);
      arrow(cutA - going * 0.6, m1, 1);
    }
    if (labelGap !== null) textAt(LABELS[lang].up, a0 - labelGap, m1);
  }
  if (mode === 'down' || mode === 'both') {
    pl([[start2 + going / 2, m2], [mL, m2], ...(mode === 'down' ? [[mL, m1], [a0 + going / 2, m1]] : [[mL, m1]])]);
    if (mode === 'down') arrow(a0 + going / 2, m1, -1);
    else pl([[mL - ah / 2, m1 + ah], [mL, m1], [mL + ah / 2, m1 + ah]]);
    if (labelGap !== null) textAt(LABELS[lang].down, a0 - labelGap, m2);
  }
}

export function buildPlan(spec) {
  const scale = num(spec.scale ?? 100, 'scale', { positive: true });
  const lang = spec.language === 'en' ? 'en' : 'vi';
  const L = { ...ROLE, ...(spec.layers || {}) };
  const dimStyle = dimStyleName(scale);
  const walls = buildWalls(spec);
  const entities = [];
  const notes = [];
  const wallBoxes = walls.flatMap((w) => w.segs.map((s) => bboxOf(segRect(s))));
  const stairBoxes = (spec.stairs || []).concat(spec.stairs_below || []).filter((st) => st.region).map((st) => bboxOf(st.region.map((q, k) => pt(q, `stairs.region[${k}]`))));
  // the far half of the half landings of the U stairs, beyond the walking line (filled where the stairs are drawn): a
  // stairwell's name stands there
  const stairLandings = [];
  // stair_labels false: the stairs keep their arrows, not the UP / DOWN texts (plans of other trades)
  const stairLabels = spec.stair_labels !== false;

  // ---- openings: cuts + symbols (centre of the wall axes: tells inside from outside)
  const axisPts = walls.flatMap((w) => w.segs.flatMap((s) => [s.a, s.b]));
  const center = axisPts.length ? axisPts.reduce((acc, p) => add(acc, mul(p, 1 / axisPts.length)), [0, 0]) : null;
  const cuts = [];
  const bySeg = new Map();
  (spec.openings || []).forEach((o, i) => {
    const name = `openings[${i}]`;
    const { s } = findSegment(walls, o, name);
    const span = openingSpan(s, o, name);
    const key = `${s.wall}:${s.index}`;
    for (const other of bySeg.get(key) || []) {
      if (span.from < other.to - 0.5 && span.to > other.from + 0.5) throw new PlanError(`${name} overlaps openings[${other.i}] on the same wall segment`);
    }
    bySeg.set(key, [...(bySeg.get(key) || []), { ...span, i }]);
    cuts.push(segRect(s, span.from, span.to, 1));
    entities.push(...openingSymbols(s, o, span, scale, name, center, [...stairBoxes, ...wallBoxes]));
  });

  // ---- wall pieces grouped by material (one outline + hatch per material)
  const jointPolys = joints(walls);
  const groups = new Map();
  for (const w of walls) {
    const key = `${w.material}|${w.layer ?? L.wall}`;
    if (!groups.has(key)) groups.set(key, { material: w.material, layer: w.layer ?? L.wall, solids: [] });
    for (const s of w.segs) groups.get(key).solids.push(segRect(s));
  }
  // Junction polygons go to the group of the first wall that meets there (same material in most plans).
  for (const j of jointPolys) {
    const c = j.reduce((acc, p) => add(acc, mul(p, 1 / j.length)), [0, 0]);
    let best = null;
    let bd = Infinity;
    for (const w of walls) for (const s of w.segs) {
      const d = Math.min(dist(c, s.a), dist(c, s.b));
      if (d < bd) { bd = d; best = w; }
    }
    groups.get(`${best.material}|${best.layer ?? L.wall}`).solids.push(j);
  }
  const wallGroups = [...groups.values()].map((g) => {
    const m = MATERIALS[g.material];
    return {
      layer: g.layer,
      solids: g.solids,
      ...(m && spec.hatch_walls !== false ? { hatch: { pattern: m.pattern, scale: Math.max(0.01, m.k * scale), layer: L.wall_hatch } } : {}),
    };
  });

  // ---- columns
  const columns = [];
  const colSpecs = [...(spec.columns || [])];
  const grids = { x: gridList(spec.grids?.x, 'x'), y: gridList(spec.grids?.y, 'y') };
  if (spec.grid_columns) {
    for (const gx of grids.x) for (const gy of grids.y) colSpecs.push({ at: [gx.at, gy.at], ...spec.grid_columns });
  }
  colSpecs.forEach((c, i) => {
    const name = `columns[${i}]`;
    const at = pt(c.at, `${name}.at`);
    let poly;
    if (c.diameter) {
      const r = num(c.diameter, `${name}.diameter`, { positive: true }) / 2;
      entities.push({ type: 'circle', center: at, radius: r, layer: L.column });
      poly = Array.from({ length: 24 }, (_, k) => P(add(at, [r * Math.cos((k * Math.PI) / 12), r * Math.sin((k * Math.PI) / 12)])));
    } else {
      const size = Array.isArray(c.size) ? c.size : [c.size ?? 400, c.size ?? 400];
      poly = rectAround(at, num(size[0], `${name}.size[0]`, { positive: true }), num(size[1], `${name}.size[1]`, { positive: true }), c.rotation ?? 0);
      entities.push({ type: 'polyline', points: poly, closed: true, layer: L.column });
    }
    columns.push(poly);
    if (c.hatch !== false) entities.push({ type: 'hatch', boundary: poly, pattern: c.pattern ?? 'SOLID', scale: c.pattern ? scale * 0.05 : 1, layer: L.column_hatch });
  });

  // ---- extents of the building (walls + columns + grid positions)
  const all = [...wallGroups.flatMap((g) => g.solids.flat()), ...columns.flat()];
  for (const g of grids.x) all.push([g.at, all.length ? all[0][1] : 0]);
  for (const g of grids.y) all.push([all.length ? all[0][0] : 0, g.at]);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const box = all.length ? { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } : null;

  // ---- dimensions: chains outside the building (openings/walls, grids, overall) on the chosen sides
  const gap = 8 * scale;
  const first = 12 * scale;
  const dimSides = spec.dimensions === false ? [] : Array.isArray(spec.dimensions) ? spec.dimensions : ['bottom', 'left'];
  let chainsOut = { bottom: 0, top: 0, left: 0, right: 0 };
  // balconies stand out of the building: the chains of that side start beyond them
  const out = { bottom: 0, top: 0, left: 0, right: 0 };
  if (box) {
    for (const bc of spec.balconies || []) {
      if (!Array.isArray(bc.region)) continue;
      const q = bc.region.map((v, k) => pt(v, `balconies.region[${k}]`));
      out.bottom = Math.max(out.bottom, box.y0 - Math.min(q[0][1], q[1][1]));
      out.top = Math.max(out.top, Math.max(q[0][1], q[1][1]) - box.y1);
      out.left = Math.max(out.left, box.x0 - Math.min(q[0][0], q[1][0]));
      out.right = Math.max(out.right, Math.max(q[0][0], q[1][0]) - box.x1);
    }
  }
  if (box && walls.length) {
    const wallSegs = walls.flatMap((w) => w.segs);
    for (const side of dimSides) {
      const horiz = side === 'bottom' || side === 'top';
      const sign = side === 'bottom' || side === 'left' ? -1 : 1;
      const faceVal = side === 'bottom' ? box.y0 : side === 'top' ? box.y1 : side === 'left' ? box.x0 : box.x1;
      const coord = (p) => (horiz ? p[0] : p[1]);
      const mk = (c) => (horiz ? [c, faceVal] : [faceVal, c]);
      const chains = [];
      // 1. Openings and wall corners on the exterior face of this side.
      const ptsA = new Set();
      for (const s of wallSegs) {
        const along = horiz ? Math.abs(s.d[1]) < 1e-6 : Math.abs(s.d[0]) < 1e-6;
        if (!along) continue;
        const n = left(s.d);
        const faces = [s.o1, s.o2].map((o) => (horiz ? s.a[1] + n[1] * o : s.a[0] + n[0] * o));
        const outer = sign < 0 ? Math.min(...faces) : Math.max(...faces);
        if (Math.abs(outer - faceVal) > 0.5 * s.t + 1) continue;
        for (const op of bySeg.get(`${s.wall}:${s.index}`) || []) {
          ptsA.add(Math.round(coord(add(s.a, mul(s.d, op.from))) * 1000) / 1000);
          ptsA.add(Math.round(coord(add(s.a, mul(s.d, op.to))) * 1000) / 1000);
        }
      }
      const lo = horiz ? box.x0 : box.y0;
      const hi = horiz ? box.x1 : box.y1;
      // Outer corners + opening jambs (skipped when the side has no opening: it would repeat the overall dimension).
      const withinA = [...ptsA].filter((c) => c > lo + 1 && c < hi - 1).sort((a, b) => a - b);
      if (withinA.length) chains.push([lo, ...withinA, hi]);
      const gl = (horiz ? grids.x : grids.y).map((g) => g.at).sort((a, b) => a - b);
      if (gl.length >= 2) chains.push(gl);
      chains.push([lo, hi]);
      chains.forEach((c, k) => {
        const off = faceVal + sign * (first + out[side] + k * gap);
        entities.push({
          type: 'dim_chain', points: c.map(mk), direction: horiz ? 'horizontal' : 'vertical',
          at: horiz ? [c[0], off] : [off, c[0]], style: dimStyle, layer: L.dims,
        });
      });
      chainsOut[side] = first + out[side] + (chains.length - 1) * gap;
    }
  }

  // ---- grids: lines past the dimension chains, bubbles at both ends
  if (box && (grids.x.length || grids.y.length)) {
    const ext = num(spec.grids?.extend ?? 0, 'grids.extend', { min: 0 });
    const r = 4.5 * scale;
    const th = 4 * scale;
    void th;
    const bubble = (c, label) => entities.push(sym('MCP_TRUC', c, { scale, attrs: { SO: String(label) }, layer: L.grid_tag, half: [4.5, 4.5] }));
    const ends = spec.grids?.bubbles ?? 'both';
    for (const g of grids.x) {
      const y0 = box.y0 - Math.max(chainsOut.bottom + 6 * scale, ext);
      const y1 = box.y1 + Math.max(chainsOut.top + 6 * scale, ext || 6 * scale);
      entities.push({ type: 'line', from: [g.at, y0], to: [g.at, y1], layer: L.grid });
      if (ends === 'both' || ends === 'start') bubble([g.at, y0 - r], g.label);
      if (ends === 'both' || ends === 'end') bubble([g.at, y1 + r], g.label);
    }
    for (const g of grids.y) {
      const x0 = box.x0 - Math.max(chainsOut.left + 6 * scale, ext);
      const x1 = box.x1 + Math.max(chainsOut.right + 6 * scale, ext || 6 * scale);
      entities.push({ type: 'line', from: [x0, g.at], to: [x1, g.at], layer: L.grid });
      if (ends === 'both' || ends === 'start') bubble([x0 - r, g.at], g.label);
      if (ends === 'both' || ends === 'end') bubble([x1 + r, g.at], g.label);
    }
  }

  // ---- U stairs: going up from this floor (with the flight coming up from below when the floor below has the
  // same stair: both), or only arriving from the floor below (down)
  const floorH = num(spec.heights?.top ?? 3600, 'heights.top', { positive: true });
  const same = (p, q) => JSON.stringify(p.region) === JSON.stringify(q.region);
  // the walls across the foot of the flights (in front of the first riser): the UP / DOWN labels go beyond them, and a
  // foot closed by a wall with no opening is reported (no floor landing)
  const cutBoxes = cuts.map((c) => bboxOf(c));
  const inBox = (q, bx2) => q[0] > bx2[0] && q[0] < bx2[2] && q[1] > bx2[1] && q[1] < bx2[3];
  const footOf = (g, name, range) => {
    const corners = [g.at(g.a0 - 6 * scale, g.b0), g.at(g.a0, g.b0), g.at(g.a0, g.b1), g.at(g.a0 - 6 * scale, g.b1)];
    let gap = 3 * scale;
    for (const s of walls.flatMap((w) => w.segs)) {
      // a wall along the flights (the side of the stairwell) does not stand across their foot
      if (Math.abs(dot(s.d, g.u)) > 0.7 * Math.hypot(s.d[0], s.d[1])) continue;
      const rect = segRect(s);
      if (!boxesOverlap(bboxOf(rect), bboxOf(corners))) continue;
      const far = Math.min(...rect.map((q) => dot(q, g.u)));
      gap = Math.max(gap, g.a0 - far + 0.8 * scale + 1.25 * scale);
    }
    // a landing as deep as the flight is wide (900 at least is asked for) in front of the first riser
    const need = Math.min(g.w, 900);
    let blocked = 0, all = 0;
    for (const da of [60, need / 2, need - 60]) {
      for (let k = 0; k < 5; k++) {
        const q = g.at(g.a0 - da, range[0] + ((k + 0.5) * (range[1] - range[0])) / 5);
        all++;
        if (wallBoxes.some((bx2) => inBox(q, bx2)) && !cutBoxes.some((bx2) => inBox(q, bx2))) blocked++;
      }
    }
    if (blocked >= all / 5) {
      notes.push(`${name}: no floor landing in front of the flights: a wall stands within ${Math.round(need)} mm of the first riser. Open that wall across the flight, or shorten the stair so that a landing at least ${Math.round(g.w)} deep (the flight width) is left.`);
    }
    return gap;
  };
  (spec.stairs || []).forEach((st, i) => {
    if (st.type !== 'u') return;
    const g = uStairGeom(st, floorH, `stairs[${i}]`);
    notes.push(...g.warnings);
    stairLandings.push(bboxOf([g.at(g.a0 + g.run + g.landing / 2, g.b0), g.at(g.a1, g.b1)]));
    const both = (spec.stairs_below || []).some((b) => same(b, st));
    const gap = footOf(g, `stairs[${i}]`, both ? [g.b0, g.b1] : g.f1);
    uStairPlan(g, both ? 'both' : 'up', scale, L, lang, entities, stairLabels ? gap : null);
  });
  (spec.stairs_below || []).forEach((st, i) => {
    if ((spec.stairs || []).some((x) => x.type === 'u' && same(x, st))) return;
    const g = uStairGeom(st, st.height ?? floorH, `stairs_below[${i}]`);
    stairLandings.push(bboxOf([g.at(g.a0 + g.run + g.landing / 2, g.b0), g.at(g.a1, g.b1)]));
    const gap = footOf(g, `stairs_below[${i}]`, g.f2);
    uStairPlan(g, 'down', scale, L, lang, entities, stairLabels ? gap : null);
  });

  // ---- balconies: slab edge and railing (double line) on the sides away from the building
  const wallPts = walls.flatMap((w) => w.segs.flatMap((sg) => segRect(sg)));
  const bx = wallPts.length ? [Math.min(...wallPts.map((q) => q[0])), Math.min(...wallPts.map((q) => q[1])), Math.max(...wallPts.map((q) => q[0])), Math.max(...wallPts.map((q) => q[1]))] : null;
  (spec.balconies || []).forEach((bc, i) => {
    const name = `balconies[${i}]`;
    if (!bc.region) throw new PlanError(`${name}: give region [[x0,y0],[x1,y1]] (the balcony slab outside the walls)`);
    const q0 = pt(bc.region[0], `${name}.region[0]`), q1 = pt(bc.region[1], `${name}.region[1]`);
    const x0 = Math.min(q0[0], q1[0]), x1 = Math.max(q0[0], q1[0]), y0 = Math.min(q0[1], q1[1]), y1 = Math.max(q0[1], q1[1]);
    entities.push({ type: 'polyline', points: [P([x0, y0]), P([x1, y0]), P([x1, y1]), P([x0, y1])], closed: true, layer: L.floor_edge });
    const t = num(bc.railing_thickness ?? 50, `${name}.railing_thickness`, { positive: true });
    const sides = [[[x0, y0], [x1, y0], [0, 1]], [[x1, y0], [x1, y1], [-1, 0]], [[x1, y1], [x0, y1], [0, -1]], [[x0, y1], [x0, y0], [1, 0]]];
    for (const [a, b, inward] of sides) {
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (bx && mid[0] >= bx[0] - 5 && mid[0] <= bx[2] + 5 && mid[1] >= bx[1] - 5 && mid[1] <= bx[3] + 5) continue; // against the building
      entities.push({ type: 'line', from: P(add(a, mul(inward, t))), to: P(add(b, mul(inward, t))), layer: L.floor_edge });
    }
  });

  // ---- stairs (straight flights): outline, treads, walking line with arrow, UP label
  expandStairs(spec.stairs).forEach((st, i) => {
    if (st.type === 'u') return;
    const name = `stairs[${st.of ?? i}]`;
    if (st.type === 'spiral') {
      // a spiral stair: the outer circle, the post, a riser line per tread, the walking line with its arrow
      const G = spiralGeom(st, name), seg = (t0, t1, rad) => {
        const m = Math.max(2, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 24)));
        return Array.from({ length: m + 1 }, (_, j) => P(G.at(rad, t0 + ((t1 - t0) * j) / m)));
      };
      entities.push({ type: 'circle', center: P(G.c), radius: G.R, layer: L.stair });
      if (G.r > 0) entities.push({ type: 'circle', center: P(G.c), radius: G.r, layer: L.stair });
      for (let t = 0; t <= G.k; t++) entities.push({ type: 'line', from: P(G.at(G.r, G.ang(t))), to: P(G.at(G.R, G.ang(t))), layer: L.stair });
      const rm = (G.R + G.r) / 2 + (G.R - G.r) / 6, walk = seg(G.ang(0.5), G.ang(G.k - 0.5), rm);
      entities.push({ type: 'polyline', points: walk, layer: L.stair });
      const tip = walk[walk.length - 1], bk = walk[walk.length - 2], d = unit(sub(tip, bk)), nn = left(d), ah = Math.min(250, 3 * scale);
      entities.push({ type: 'polyline', points: [P(add(sub(tip, mul(d, ah)), mul(nn, ah / 2))), tip, P(sub(sub(tip, mul(d, ah)), mul(nn, ah / 2)))], layer: L.stair });
      const lblS = stairLabels ? st.label ?? LABELS[lang].up : null;
      if (lblS) entities.push({ type: 'text', text: lblS, at: P(G.at(G.R + 2 * scale, G.ang(-1.2))), height: 2.5 * scale, layer: L.text, style: TEXT_STYLE });
      return;
    }
    const start = pt(st.start, `${name}.start`);
    const a = ((st.direction ?? 90) * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a)];
    const n = left(u);
    const w = num(st.width ?? 1200, `${name}.width`, { positive: true });
    const k = Math.round(num(st.treads ?? 10, `${name}.treads`, { positive: true }));
    const g = num(st.going ?? 270, `${name}.going`, { positive: true });
    const run = k * g;
    const c0 = add(start, mul(n, -w / 2));
    const corner = (x, y) => P(add(add(c0, mul(u, x)), mul(n, y)));
    entities.push({ type: 'polyline', points: [corner(0, 0), corner(run, 0), corner(run, w), corner(0, w)], closed: true, layer: L.stair });
    for (let t = 1; t < k; t++) entities.push({ type: 'line', from: corner(t * g, 0), to: corner(t * g, w), layer: L.stair });
    const tip = corner(run - g / 2, w / 2);
    const ah = Math.min(g * 0.8, 3 * scale);
    // (the quarter landing of an L stair: its outline only)
    if (!st.landing) {
      entities.push({ type: 'polyline', points: [corner(g / 2, w / 2), tip], layer: L.stair });
      entities.push({ type: 'polyline', points: [corner(run - g / 2 - ah, w / 2 - ah / 2), tip, corner(run - g / 2 - ah, w / 2 + ah / 2)], layer: L.stair });
    }
    const lbl = stairLabels ? st.label ?? LABELS[lang].up : null;
    if (lbl) {
      entities.push({
        type: 'text', text: lbl, at: corner(g * 0.5, w / 2 - 3 * scale), height: 2.5 * scale, rotation: (a * 180) / Math.PI,
        layer: L.text, style: TEXT_STYLE,
      });
    }
  });

  // ---- level marks (+0.000), section marks, north arrow
  const markBoxes = [];
  (spec.levels || []).forEach((lv, i) => {
    const at = pt(lv.at, `levels[${i}].at`);
    // the mark reads to the right, or to the left when a wall is in the way on the right
    const right = [at[0] - 1.5 * scale, at[1], at[0] + 12 * scale, at[1] + 6 * scale];
    const leftBox = [at[0] - 12 * scale, at[1], at[0] + 1.5 * scale, at[1] + 6 * scale];
    const flip = lv.side === 'left' || (lv.side === undefined && wallBoxes.some((b) => boxesOverlap(b, right)) && !wallBoxes.some((b) => boxesOverlap(b, leftBox)));
    entities.push(sym(flip ? 'MCP_COTE_TRAI' : 'MCP_COTE', at, { scale, attrs: { COTE: String(lv.value ?? '±0.000') }, layer: L.symbol }));
    markBoxes.push(flip ? leftBox : right);
  });
  const drawn = boundsOf(entities, wallBoxes);
  (spec.sections || []).forEach((sc, i) => {
    let a = pt(sc.from, `sections[${i}].from`);
    let b = pt(sc.to, `sections[${i}].to`);
    const d = unit(sub(b, a));
    const nn = mul(left(d), sc.look === 'right' ? -1 : 1);
    const r = 4 * scale;
    // ends moved out along the cut line past the walls, grids and dimension chains, so the marks stand clear of them
    if (drawn && sc.keep_ends !== true) {
      const a0 = a, L0 = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const span = lineThroughBox(a0, d, drawn);
      if (span) {
        a = add(a0, mul(d, Math.min(0, span[0] - 4 * scale)));
        b = add(a0, mul(d, Math.max(L0, span[1] + 4 * scale)));
      }
    }
    for (const [p, q] of [[a, add(a, mul(d, 8 * scale))], [sub(b, mul(d, 8 * scale)), b]]) {
      entities.push({ type: 'polyline', points: [P(p), P(q)], width: 0.7 * scale, layer: L.symbol });
    }
    const ang = (Math.atan2(nn[1], nn[0]) * 180) / Math.PI;
    for (const [p, inward] of [[a, d], [b, mul(d, -1)]]) {
      // arrow from the thick end towards the view, the letter beyond it
      const foot = add(p, mul(inward, 4 * scale));
      entities.push(sym('MCP_MUI_TEN', add(foot, mul(nn, 0.6 * scale)), { scale, rotation: r1(ang), layer: L.symbol }));
      entities.push({ type: 'line', from: P(foot), to: P(add(foot, mul(nn, 0.8 * scale))), layer: L.symbol });
      const c = add(add(foot, mul(nn, 4.1 * scale + r)), [0, 0]);
      entities.push(sym('MCP_MAT_CAT', c, { scale, attrs: { TEN: String(sc.label ?? 'A') }, layer: L.symbol, half: [4, 4] }));
    }
  });
  if (spec.north) {
    const at = pt(spec.north.at, 'north.at');
    entities.push(sym('MCP_HUONG_BAC', at, { scale, rotation: (spec.north.angle ?? 90) - 90, attrs: { KY_HIEU: LABELS[lang].north }, layer: L.symbol, half: [8, 14] }));
  }

  // ---- extra free entities (furniture, notes...) pass through unchanged
  for (const e of spec.entities || []) entities.push(e);

  const doorBoxes = entities.filter((e) => e.type === 'block' && e.box && (e.layer === L.door || e.layer === L.window)).map((e) => e.box);
  const roomH = num(spec.room_options?.text_height ?? 2.5, 'room_options.text_height', { positive: true }) * scale;
  const rooms = (spec.rooms || []).map((r, i) => {
    const out = { name: String(r.name ?? ''), at: pt(r.at, `rooms[${i}].at`) };
    if (r.label !== false && r.keep_at !== true) {
      // a label (name over area) that would sit on a door swing moves to the nearest place clear of the doors and
      // walls, not across a wall
      const w = Math.max(String(r.name ?? '').length, 9) * 0.78 * roomH, h = 3.4 * roomH;
      const boxAt = (p) => [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2];
      const hits = (p) => doorBoxes.some((b) => boxesOverlap(b, boxAt(p))) || wallBoxes.some((b) => boxesOverlap(b, boxAt(p)));
      const reach = (p) => {
        for (let k = 1; k <= 10; k++) {
          const q = add(out.at, mul(sub(p, out.at), k / 10));
          if (wallBoxes.some((b) => q[0] > b[0] && q[0] < b[2] && q[1] > b[1] && q[1] < b[3])) return false;
        }
        return true;
      };
      // the name of a stairwell stands alone (no area) on the half landing beyond the walking line, not over the treads
      const well = stairBoxes.findIndex((b) => out.at[0] > b[0] && out.at[0] < b[2] && out.at[1] > b[1] && out.at[1] < b[3]);
      const nameW = [...out.name].length * 0.8 * roomH;
      const land = well >= 0 && r.hatch === undefined
        ? stairLandings.find((b) => boxesOverlap(b, stairBoxes[well]) && b[2] - b[0] >= nameW + roomH && b[3] - b[1] >= 1.6 * roomH) : null;
      if (land) {
        const c = P([(land[0] + land[2]) / 2, (land[1] + land[3]) / 2]);
        entities.push({ type: 'text', text: out.name, at: c, height: roomH, align: 'middle_center', layer: L.room_tag, style: TEXT_STYLE });
        out.label = false;
        notes.push(`${out.name}: the name alone on the half landing of the stair, clear of the treads (rooms[${i}].keep_at keeps the name and area at its point)`);
        if (r.number !== undefined) out.number = String(r.number);
        if (r.area_m2 !== undefined) out.area_m2 = num(r.area_m2, `rooms[${i}].area_m2`);
        return out;
      }
      if (doorBoxes.some((b) => boxesOverlap(b, boxAt(out.at)))) {
        let best = null;
        for (let dx = -1200; dx <= 1200; dx += 100) {
          for (let dy = -1200; dy <= 1200; dy += 100) {
            const p = add(out.at, [dx, dy]);
            const dd = Math.hypot(dx, dy);
            if ((!best || dd < best.dd) && !hits(p) && reach(p)) best = { p, dd };
          }
        }
        if (best) {
          notes.push(`${out.name}: the room name moved ${Math.round(best.dd)} mm clear of a door swing (rooms[${i}].keep_at keeps it)`);
          out.at = P(best.p);
        }
      }
    }
    if (r.number !== undefined) out.number = String(r.number);
    if (r.area_m2 !== undefined) out.area_m2 = num(r.area_m2, `rooms[${i}].area_m2`);
    if (r.label === false) out.label = false;
    if (r.hatch) {
      out.hatch = { pattern: r.hatch.pattern ?? 'NET', scale: r.hatch.scale ?? scale * 0.5, angle: r.hatch.angle ?? 0, layer: L.floor_hatch };
    }
    return out;
  });

  // ---- interior dimensions: the clear width and length of every room (not the stairwells), wall face to wall face,
  // each on a line that is clear of the room names, door swings, tags, level marks, stairs, the walls beside it and
  // the dimensions already placed (the text above a horizontal line, left of a vertical one). A room with no clear
  // line for a dimension gets a note, not a dimension over something else.
  if (spec.interior_dimensions && box && walls.length) {
    const segs = walls.flatMap((w) => w.segs);
    const th = 2.5 * scale;
    const labelBox = (rm) => {
      const w = Math.max(String(rm.name ?? '').length, 9) * 0.78 * roomH, h = 3.4 * roomH;
      return [rm.at[0] - w / 2, rm.at[1] - h / 2, rm.at[0] + w / 2, rm.at[1] + h / 2];
    };
    const obstacles = [
      ...rooms.filter((rm) => rm.label !== false).map(labelBox),
      ...entities.filter((e) => e.type === 'block' && Array.isArray(e.box)).map((e) => e.box),
      ...entities.filter((e) => e.type === 'text' && Array.isArray(e.at)).map((e) => {
        const w = [...String(e.text)].length * 0.8 * e.height;
        return [e.at[0] - w, e.at[1] - e.height, e.at[0] + w, e.at[1] + e.height];
      }),
      ...markBoxes, ...stairBoxes,
    ];
    // the wall faces on both sides of v on the line c (horizontal: the line y = c, measured along x); null when a side
    // has no wall or, when strict, the line meets an opening of that wall (there is no face to dimension to)
    const spanAt = (horiz, c, v, strict = true) => {
      const k = horiz ? 1 : 0, j = horiz ? 0 : 1;
      let lo = null, hi = null;
      for (const s of segs) {
        const across = horiz ? Math.abs(s.d[0]) < 1e-6 : Math.abs(s.d[1]) < 1e-6;
        if (!across) continue;
        const a0 = Math.min(s.a[k], s.b[k]), a1 = Math.max(s.a[k], s.b[k]);
        if (c < a0 - s.t / 2 - 1 || c > a1 + s.t / 2 + 1) continue;
        const t = (c - s.a[k]) / s.d[k];
        const open = (bySeg.get(`${s.wall}:${s.index}`) || []).some((op) => t > op.from - 50 && t < op.to + 50);
        const n = left(s.d);
        for (const o of [s.o1, s.o2]) {
          const f = s.a[j] + n[j] * o;
          if (f <= v && (!lo || f > lo.f)) lo = { f, open };
          if (f >= v && (!hi || f < hi.f)) hi = { f, open };
        }
      }
      if (!lo || !hi || hi.f - lo.f < 1 || (strict && (lo.open || hi.open))) return null;
      return [Math.round(lo.f * 10) / 10, Math.round(hi.f * 10) / 10];
    };
    const placed = [];
    for (const rm of rooms) {
      if (stairBoxes.some((bx2) => rm.at[0] > bx2[0] && rm.at[0] < bx2[2] && rm.at[1] > bx2[1] && rm.at[1] < bx2[3])) continue;
      const lb = labelBox(rm);
      for (const horiz of [true, false]) {
        const j = horiz ? 0 : 1, k = horiz ? 1 : 0;
        // where the line may go: between the walls around the name, across the dimension
        const ext = spanAt(!horiz, rm.at[j], rm.at[k], false);
        if (!ext) continue;
        // just below (left of) the name and further from it, then above (right of) it
        const first = horiz ? lb[1] - th - 3 * scale : lb[0] - 3 * scale;
        const second = horiz ? lb[3] + 3 * scale : lb[2] + th + 3 * scale;
        const cands = [];
        for (let d = 0; d <= 250; d++) cands.push([first - d * scale, d], [second + d * scale, d + 0.5]);
        cands.sort((p, q) => p[1] - q[1]);
        let ok = false;
        for (const [c] of cands) {
          if (c < ext[0] + 1.4 * scale || c > ext[1] - 1.4 * scale) continue;
          const sp = spanAt(horiz, c, rm.at[j]);
          if (!sp) continue;
          const [lo, hi] = sp;
          const tw = String(Math.round(hi - lo)).length * 0.8 * th + 0.6 * scale;
          if (hi - lo < tw + scale) continue;
          const mid = (lo + hi) / 2;
          const lineBox = horiz ? [lo + 1, c - 1.2 * scale, hi - 1, c + 1.2 * scale] : [c - 1.2 * scale, lo + 1, c + 1.2 * scale, hi - 1];
          const textBox = horiz ? [mid - tw / 2, c + 0.2 * scale, mid + tw / 2, c + th + 1.1 * scale] : [c - th - 1.1 * scale, mid - tw / 2, c - 0.2 * scale, mid + tw / 2];
          const hit = (bx2) => boxesOverlap(bx2, lineBox) || boxesOverlap(bx2, textBox);
          // two dimension lines may cross; a text keeps clear of every line and text
          if (obstacles.some(hit) || wallBoxes.some(hit) || placed.some((d) => hit(d.text) || boxesOverlap(d.line, textBox))) continue;
          placed.push({ line: lineBox, text: textBox });
          entities.push({
            type: 'dim_chain', points: [P(horiz ? [lo, c] : [c, lo]), P(horiz ? [hi, c] : [c, hi])], direction: horiz ? 'horizontal' : 'vertical',
            at: P(horiz ? [lo, c] : [c, lo]), style: dimStyle, layer: L.dims,
          });
          ok = true;
          break;
        }
        if (!ok) notes.push(`${rm.name}: no clear line for its ${horiz ? 'width' : 'length'} dimension (names, doors and walls leave no room): not dimensioned inside`);
      }
    }
  }

  if (!walls.length) notes.push('No walls: only the other elements were drawn.');
  return {
    walls: wallGroups,
    cuts,
    columns,
    rooms,
    room_options: {
      text_height: num(spec.room_options?.text_height ?? 2.5, 'room_options.text_height', { positive: true }) * scale,
      style: TEXT_STYLE, area_layer: L.area, label_layer: L.room_tag,
      decimals: spec.room_options?.decimals ?? 2, decimal_separator: spec.room_options?.decimal_separator ?? (lang === 'vi' ? ',' : '.'),
      boundary: spec.room_options?.boundary ?? true,
    },
    entities,
    notes,
    assumed: planAssumptions(spec),
  };
}
