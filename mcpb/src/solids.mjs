// The solid model of the structure and the masonry, for the bill of quantities (boq.mjs). Every member of the
// preliminary calculation (calc.mjs) is a solid: a vertical prism with a plan profile (mm) between two levels. Where
// members meet, the concrete belongs to one of them only, by the order of the rule set (Phụ lục VI, 5.4: what lies in
// the slab thickness is slab, the column-beam node is beam): each solid keeps its gross volume, the list of what the
// others took from it (cuts) and its net volume, so the sum of the net volumes is the volume of the union of all
// members. The brick walls, the openings and the lintels over them stand in the same model: masonry is the wall
// less the concrete in it and its openings, formwork is the concrete surface that is not cast against concrete,
// plaster the faces that meet the air, inside or outside. The ground floor has its slab on grade (the plate the
// walls enclose, cast last: it takes nothing from the members it meets) with the fill under it; the foundations have
// their earthwork (a pit under every pad, a trench under every ground beam, what is buried in them); the stairs the
// brick steps built on their flights. The model is exact for members parallel to the axes (a
// grid of the coordinates of every face: no tolerance, no sampling); a member at an angle is sampled on that grid
// and flagged. Lengths in mm; areas in m², volumes in m³ in the results.
import { buildModel } from './elevation.mjs';
import { segRect, uStairFinish, uStairGeom } from './plan.mjs';
import { ruleSet } from './rules.mjs';

const TOL = 1e-4;
const EMPTY = -1;
const rnd = (v) => Math.round(v * 1000) / 1000;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];

/** Typical lintels by the clear span of the opening: the table of the general notes (structureNotes), as data. */
export const LINTELS = [
  { max: 1200, h: 150, bottom: { n: 2, d: 10 }, top: { n: 2, d: 10 }, tie: { d: 6, s: 200 }, bearing: 200 },
  { max: 2000, h: 200, bottom: { n: 2, d: 12 }, top: { n: 2, d: 10 }, tie: { d: 6, s: 200 }, bearing: 250 },
  { max: 3000, h: 300, bottom: { n: 2, d: 14 }, top: { n: 2, d: 12 }, tie: { d: 6, s: 150 }, bearing: 300 },
];
export const lintelFor = (w) => LINTELS.find((l) => w <= l.max + TOL) ?? LINTELS[LINTELS.length - 1];
/**
 * The typical lintels as the rows of the table of the general notes (structureNotes): span, section, bottom bars, top
 * bars, stirrups, bearing. The notes and the bill read the same table. t: the wall thickness the section is written for.
 */
export function lintelRows(lang = 'vi', t = 220) {
  const rows = LINTELS.map((l, i) => [
    i === 0 ? `L ≤ ${l.max}` : `${LINTELS[i - 1].max} < L ≤ ${l.max}`, `${t}x${l.h}`, `${l.bottom.n}Ø${l.bottom.d}`, `${l.top.n}Ø${l.top.d}`, `Ø${l.tie.d}a${l.tie.s}`, String(l.bearing),
  ]);
  rows.push([`L > ${LINTELS[LINTELS.length - 1].max}`, lang === 'en' ? 'As a designed beam' : 'Theo thiết kế dầm', '', '', '', '']);
  return rows;
}

// ---------------------------------------------------------------- plane geometry

const box = (x0, y0, x1, y1) => {
  const a = rnd(Math.min(x0, x1)), b = rnd(Math.min(y0, y1)), c = rnd(Math.max(x0, x1)), d = rnd(Math.max(y0, y1));
  return [[a, b], [c, b], [c, d], [a, d]];
};
const area2 = (p) => {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a;
};
/** Area of a polygon (mm²). */
export const polyArea = (p) => Math.abs(area2(p)) / 2;
const bboxOf = (p) => [Math.min(...p.map((q) => q[0])), Math.min(...p.map((q) => q[1])), Math.max(...p.map((q) => q[0])), Math.max(...p.map((q) => q[1]))];
/** [x0, y0, x1, y1] of a polygon that is a rectangle along the axes, or null. */
function rectOf(p) {
  if (p.length !== 4) return null;
  const [x0, y0, x1, y1] = bboxOf(p);
  const on = p.every(([x, y]) => (Math.abs(x - x0) < TOL || Math.abs(x - x1) < TOL) && (Math.abs(y - y0) < TOL || Math.abs(y - y1) < TOL));
  return on && Math.abs(polyArea(p) - (x1 - x0) * (y1 - y0)) < 1e-3 ? [x0, y0, x1, y1] : null;
}
function inPoly(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const uniq = (vs) => {
  const s = [...vs].sort((a, b) => a - b), out = [];
  for (const v of s) if (!out.length || v - out[out.length - 1] > TOL) out.push(v);
  return out;
};
/** Index of a coordinate in a sorted list (the coordinate is one of the list). */
const locate = (arr, v) => {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v - TOL) lo = m + 1; else hi = m; }
  return lo;
};

/** Whether a panel has another panel beyond its side (the slab runs on over that beam). */
export function runsOn(c, side, cells) {
  return cells.some((o) => {
    if (o === c) return false;
    const ox = Math.min(c.x1, o.x1) - Math.max(c.x0, o.x0), oy = Math.min(c.y1, o.y1) - Math.max(c.y0, o.y0);
    return side === 'left' ? Math.abs(o.x1 - c.x0) < 60 && oy > 100 : side === 'right' ? Math.abs(o.x0 - c.x1) < 60 && oy > 100
      : side === 'bottom' ? Math.abs(o.y1 - c.y0) < 60 && ox > 100 : Math.abs(o.y0 - c.y1) < 60 && ox > 100;
  });
}

/**
 * The outline of a union of rectangles less holes: [{profile, holes}] (one entry for every separate piece, the outer
 * loop counter-clockwise), with the area of the union (mm²) and of each hole inside it. Traced on the grid of the
 * coordinates of the rectangles and the holes.
 */
function unionLoops(rects, holes = []) {
  const hb = holes.map(bboxOf);
  const xs = uniq([...rects.flatMap((r) => [r[0], r[2]]), ...hb.flatMap((r) => [r[0], r[2]])]);
  const ys = uniq([...rects.flatMap((r) => [r[1], r[3]]), ...hb.flatMap((r) => [r[1], r[3]])]);
  const nx = xs.length - 1, ny = ys.length - 1;
  const mask = new Uint8Array(Math.max(1, nx * ny)), holeArea = holes.map(() => 0);
  let area = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2, a = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
    if (!rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) continue;
    const h = holes.findIndex((p) => inPoly(cx, cy, p));
    if (h >= 0) { holeArea[h] += a; continue; }
    mask[j * nx + i] = 1;
    area += a;
  }
  // the boundary edges of the cells, the inside on their left, chained into loops
  const inside = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] === 1;
  const key = (i, j) => j * (nx + 1) + i;
  const next = new Map();
  const edge = (a, b) => { if (!next.has(a)) next.set(a, []); next.get(a).push(b); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!inside(i, j)) continue;
    if (!inside(i, j - 1)) edge(key(i, j), key(i + 1, j));
    if (!inside(i + 1, j)) edge(key(i + 1, j), key(i + 1, j + 1));
    if (!inside(i, j + 1)) edge(key(i + 1, j + 1), key(i, j + 1));
    if (!inside(i - 1, j)) edge(key(i, j + 1), key(i, j));
  }
  const loops = [];
  for (const [start, list] of next) {
    while (list.length) {
      const loop = [start];
      let cur = list.pop();
      while (cur !== start) { loop.push(cur); cur = next.get(cur).pop(); }
      const pts = loop.map((k) => [xs[k % (nx + 1)], ys[Math.floor(k / (nx + 1))]]);
      // the corners only
      const out = pts.filter((p, i) => {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[(i + 1) % pts.length];
        return Math.abs(cross(sub(p, a), sub(b, p))) > TOL;
      });
      loops.push(out);
    }
  }
  const outers = loops.filter((l) => area2(l) > 0).map((l) => ({ profile: l, holes: [] }));
  for (const h of loops.filter((l) => area2(l) < 0)) {
    const o = outers.find((x) => inPoly(h[0][0] + (h[1][0] - h[0][0]) / 2, h[0][1] + (h[1][1] - h[0][1]) / 2, x.profile)) ?? outers[0];
    if (o) o.holes.push([...h].reverse());
  }
  const perimeter = sum(loops.map((l) => sum(l.map((p, i) => Math.hypot(l[(i + 1) % l.length][0] - p[0], l[(i + 1) % l.length][1] - p[1])))));
  return { pieces: outers, area, holeArea, perimeter };
}

/** A rectangle grown by d on every side (a rectangle at an angle: along its own sides). */
function grow(poly, d) {
  if (!d) return poly;
  const r = rectOf(poly);
  if (r) return box(r[0] - d, r[1] - d, r[2] + d, r[3] + d);
  if (poly.length !== 4) return poly;
  const u = sub(poly[1], poly[0]), v = sub(poly[3], poly[0]), lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
  const at = (q, a, b) => [rnd(q[0] + (a * d * u[0]) / lu + (b * d * v[0]) / lv), rnd(q[1] + (a * d * u[1]) / lu + (b * d * v[1]) / lv)];
  return [at(poly[0], -1, -1), at(poly[1], 1, -1), at(poly[2], 1, 1), at(poly[3], -1, 1)];
}

/**
 * What walls enclose in plan: the regions the outside cannot reach around their footprints, each as rectangles
 * [x0, y0, x1, y1] that do not overlap (rows of the grid of the wall coordinates, joined where they stack), from the
 * lowest left. Exact for walls along the axes; walls at an angle are sampled on a grid of 50 mm or more.
 */
function enclosedRegions(polys) {
  if (!polys.length) return { regions: [], exact: true };
  const rects = polys.map(rectOf), exact = rects.every(Boolean), bb = polys.map(bboxOf);
  let xs = uniq(polys.flatMap((q) => q.map((v) => v[0]))), ys = uniq(polys.flatMap((q) => q.map((v) => v[1])));
  if (!exact) {
    const fill = (v) => { const step = Math.max(50, (v[v.length - 1] - v[0]) / 600); return uniq([...v, ...Array.from({ length: Math.floor((v[v.length - 1] - v[0]) / step) }, (_, i) => v[0] + (i + 1) * step)]); };
    xs = fill(xs);
    ys = fill(ys);
  }
  xs = [xs[0] - 1000, ...xs, xs[xs.length - 1] + 1000];
  ys = [ys[0] - 1000, ...ys, ys[ys.length - 1] + 1000];
  const nx = xs.length - 1, ny = ys.length - 1;
  // 1: a wall, 2: outside, 3 and more: a region
  const st = new Int32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (polys.some((q, k) => cx > bb[k][0] && cx < bb[k][2] && cy > bb[k][1] && cy < bb[k][3] && (rects[k] || inPoly(cx, cy, q)))) st[j * nx + i] = 1;
  }
  const flood = (start, mark) => {
    const stack = [start], cells = [];
    st[start] = mark;
    while (stack.length) {
      const c = stack.pop(), j = Math.floor(c / nx), i = c - j * nx;
      cells.push(c);
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (a < 0 || b < 0 || a >= nx || b >= ny || st[b * nx + a] !== 0) continue;
        st[b * nx + a] = mark;
        stack.push(b * nx + a);
      }
    }
    return cells;
  };
  flood(0, 2); // the margin is free all around: one seed reaches all of the outside
  const regions = [];
  for (let c = 0; c < nx * ny; c++) {
    if (st[c] !== 0) continue;
    const mark = 3 + regions.length;
    flood(c, mark);
    const out = [], open = new Map();
    let area = 0;
    for (let j = 0; j < ny; j++) {
      const now = new Map();
      for (let i = 0; i < nx; i++) {
        if (st[j * nx + i] !== mark) continue;
        let e = i;
        while (e + 1 < nx && st[j * nx + e + 1] === mark) e++;
        const key = `${i}|${e}`, r = open.get(key) ?? [xs[i], ys[j], xs[e + 1], ys[j]];
        if (!open.has(key)) out.push(r);
        r[3] = ys[j + 1];
        now.set(key, r);
        area += (xs[e + 1] - xs[i]) * (ys[j + 1] - ys[j]);
        i = e;
      }
      open.clear();
      for (const [k, r] of now) open.set(k, r);
    }
    regions.push({ rects: out, area, x0: Math.min(...out.map((r) => r[0])), y0: Math.min(...out.map((r) => r[1])) });
  }
  regions.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { regions, exact };
}

// ---------------------------------------------------------------- the union by a sweep (independent of the grid)

const spans = (poly, x) => {
  const ys = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j], [x2, y2] = poly[i];
    if (x1 > x !== x2 > x) ys.push(y1 + ((x - x1) / (x2 - x1)) * (y2 - y1));
  }
  ys.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i], ys[i + 1]]);
  return out;
};
const minus = (a, b) => {
  let out = a;
  for (const [c, d] of b) out = out.flatMap(([p, q]) => (d <= p || c >= q ? [[p, q]] : [[p, Math.min(q, c)], [Math.max(p, d), q]].filter(([u, v]) => v - u > 1e-9)));
  return out;
};

/** Area of the union of plane shapes [{profile, holes}] (mm²): strips between their vertices, intervals merged. */
export function unionArea(shapes) {
  const xs = uniq(shapes.flatMap((s) => [...s.profile, ...(s.holes ?? []).flat()].map((p) => p[0])));
  let A = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const xm = (xs[i] + xs[i + 1]) / 2, iv = [];
    for (const s of shapes) {
      let a = spans(s.profile, xm);
      if (!a.length) continue;
      for (const h of s.holes ?? []) a = minus(a, spans(h, xm));
      iv.push(...a);
    }
    iv.sort((a, b) => a[0] - b[0]);
    let len = 0, end = -Infinity;
    for (const [p, q] of iv) { if (q <= end) continue; len += q - Math.max(p, end); end = q; }
    A += len * (xs[i + 1] - xs[i]);
  }
  return A;
}

/**
 * Volume of the union of prisms [{profile, holes, z0, z1}] (m³): level by level, the area of the union of the
 * profiles that stand there. Another way to the same number as the sum of the net volumes of the model.
 */
export function unionVolume(prisms) {
  const zs = uniq(prisms.flatMap((p) => [p.z0, p.z1]));
  let V = 0;
  for (let k = 0; k + 1 < zs.length; k++) {
    const zm = (zs[k] + zs[k + 1]) / 2, act = prisms.filter((p) => p.z0 < zm && p.z1 > zm);
    if (act.length) V += unionArea(act) * (zs[k + 1] - zs[k]);
  }
  return V / 1e9;
}

/**
 * Volume (mm³) of the union of bodies [{z0, z1, sloped, at(z): [{profile, holes}]}], level by level: the area of the
 * union of their sections; where a section changes with the level (a pit with sloped sides) by Simpson's rule in
 * `layers` layers (exact for one pit: its section grows as a square of the level).
 */
function sweepVolume(bodies, layers = 8) {
  const zs = uniq(bodies.flatMap((b) => [b.z0, b.z1]));
  let V = 0;
  for (let k = 0; k + 1 < zs.length; k++) {
    const zm = (zs[k] + zs[k + 1]) / 2, act = bodies.filter((b) => b.z0 < zm && b.z1 > zm);
    if (!act.length) continue;
    const A = (z) => unionArea(act.flatMap((b) => b.at(z)));
    if (!act.some((b) => b.sloped)) { V += A(zm) * (zs[k + 1] - zs[k]); continue; }
    const dz = (zs[k + 1] - zs[k]) / layers;
    for (let i = 0; i < layers; i++) { const a = zs[k] + i * dz; V += (dz / 6) * (A(a) + 4 * A(a + dz / 2) + A(a + dz)); }
  }
  return V;
}

/**
 * The earthwork of the foundations by the design dimensions (no bulking): a pit under every pad and a trench under
 * every ground beam - the footprint of the lean concrete and a working space on every side, from its underside up to
 * the ground, the sides vertical or sloped (slope: horizontal for 1 vertical). Pits and trenches that overlap are
 * counted once: each takes what those before it left (the pits first). leans: the lean concrete of the geometry.
 * Returns {items: [{id, kind (pit | trench), mark, a, b, h (mm), gross, net (m³), value, expr, one}], total, sum (m³),
 * bodies (for sweepVolume), exact}.
 */
function earthwork(leans, ground, { space = 300, slope = 0 } = {}) {
  const m = Math.max(0, Number(slope) || 0), sp = Math.max(0, Number(space) || 0);
  const items = leans.filter((it) => it.z0 < ground - TOL).map((it) => {
    const base = grow(it.parts[0].poly, sp), h = ground - it.z0, pit = it.group === 'lean_footing';
    const e1 = Math.hypot(...sub(base[1], base[0])), e2 = Math.hypot(...sub(base[3], base[0]));
    const [a, b] = pit ? [e1, e2] : [Math.min(e1, e2), Math.max(e1, e2)];
    return {
      id: `${pit ? 'HM' : 'RG'} ${it.id.replace(/^LOT /, '')}`, kind: pit ? 'pit' : 'trench', mark: it.mark, a, b, h, z0: it.z0, z1: ground, sloped: m > 0, exact: !!rectOf(base), base,
      at: (z) => [{ profile: m > 0 ? grow(base, m * (z - it.z0)) : base, holes: [] }],
    };
  });
  let done = 0;
  items.forEach((x, i) => {
    const upTo = sweepVolume(items.slice(0, i + 1));
    x.net = (upTo - done) / 1e9;
    done = upTo;
    x.gross = sweepVolume([x], 1) / 1e9;
    const { a, b, h } = x;
    let formula, value;
    if (m > 0) {
      const am = a + m * h, bm = b + m * h, a1 = a + 2 * m * h, b1 = b + 2 * m * h;
      formula = `${mS(h)}/6*(${mS(a)}*${mS(b)}+4*${mS(am)}*${mS(bm)}+${mS(a1)}*${mS(b1)})`;
      value = (mV(h) / 6) * (mV(a) * mV(b) + 4 * mV(am) * mV(bm) + mV(a1) * mV(b1));
    } else { formula = `${mS(a)}*${mS(b)}*${mS(h)}`; value = mV(a) * mV(b) * mV(h); }
    const c = closed(formula, value, x.net);
    x.value = value; x.expr = c.expr; x.one = c.one;
  });
  return { items, total: done / 1e9, sum: sum(items.map((x) => x.gross)), bodies: items, exact: items.every((x) => x.exact) };
}

// ---------------------------------------------------------------- the members of the calculation as solids

const colBase = (R, c) => (c.foot ? -R.depth + c.foot.H : c.bottom);
const colBox = (c) => box(c.at[0] - c.size[0] / 2, c.at[1] - c.size[1] / 2, c.at[0] + c.size[0] / 2, c.at[1] + c.size[1] / 2);
const beamPoly = (m, e0, e1, b = m.b) => {
  const n = [-m.d[1], m.d[0]], h = b / 2;
  const a = [m.A[0] - m.d[0] * e0, m.A[1] - m.d[1] * e0], z = [m.B[0] + m.d[0] * e1, m.B[1] + m.d[1] * e1];
  return [[a[0] - n[0] * h, a[1] - n[1] * h], [z[0] - n[0] * h, z[1] - n[1] * h], [z[0] + n[0] * h, z[1] + n[1] * h], [a[0] + n[0] * h, a[1] + n[1] * h]].map(([x, y]) => [rnd(x), rnd(y)]);
};
const distSeg = (p, a, b) => {
  const d = sub(b, a), L2 = d[0] * d[0] + d[1] * d[1];
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]);
};

/**
 * The concrete members, the walls and the openings of the calculation result as prisms, before any junction rule:
 * items [{id, kind, group, floor, level, parts: [{poly}], holes, z0, z1, dims}] in the order of the bill.
 */
function geometry(R, { groundSlab = null } = {}) {
  const items = [], warnings = [];
  const push = (o) => { items.push({ holes: [], ...o }); };
  // pad footings with their lean concrete, and the column stubs up to ±0.000
  for (const c of R.columns) {
    if (!c.foot) continue;
    const { B, L, H, mark } = c.foot, [x, y] = c.at, zf = -R.depth;
    push({ id: `${mark}@${c.name}`, kind: 'footing', group: 'footing', floor: null, level: zf + H, mark, parts: [{ poly: box(x - B / 2, y - L / 2, x + B / 2, y + L / 2) }], z0: zf, z1: zf + H, dims: [B, L, H] });
    push({ id: `LOT ${mark}@${c.name}`, kind: 'lean', group: 'lean_footing', floor: null, level: zf, mark, parts: [{ poly: box(x - B / 2 - 100, y - L / 2 - 100, x + B / 2 + 100, y + L / 2 + 100) }], z0: zf - 100, z1: zf, dims: [B + 200, L + 200, 100] });
    push({ id: `CC@${c.name}`, kind: 'stub', group: 'stub', floor: null, level: 0, mark: c.mark, column: c.name, parts: [{ poly: colBox(c) }], z0: zf + H, z1: 0, dims: [c.size[0], c.size[1], R.depth - H] });
  }
  // columns storey by storey, from a floor level up to the next one
  const tops = R.slabs.filter((S) => S.kind !== 'foundation');
  const base = [0, ...tops.map((S) => S.level)];
  tops.forEach((S, i) => {
    const z0 = base[i], z1 = S.level;
    for (const c of R.columns) {
      if (!(c.bottom <= z0 + 1 && c.top >= z1 - 1)) continue;
      push({ id: `${c.mark}@${c.name}/${S.name}`, kind: 'column', group: `column:${S.name}`, floor: S.name, level: z1, mark: c.mark, column: c.name, parts: [{ poly: colBox(c) }], z0, z1, dims: [c.size[0], c.size[1], z1 - z0] });
    }
  });
  for (const S of R.slabs) {
    const g = S.kind === 'foundation';
    const cols = R.columns.filter((c) => colBase(R, c) < S.level - 1 && c.top >= S.level - 1);
    (S.members ?? []).forEach((m, i) => {
      // a beam runs through its end node: to the far face of the beam it meets there, or of the column under it
      const ext = (P) => {
        let e = 0;
        for (const o of S.members) if (o !== m && Math.abs(cross(o.d, m.d)) > 0.5 && distSeg(P, o.A, o.B) < 1) e = Math.max(e, o.b / 2);
        for (const c of cols) {
          if (Math.abs(P[0] - c.at[0]) <= c.size[0] / 2 + 1 && Math.abs(P[1] - c.at[1]) <= c.size[1] / 2 + 1) e = Math.max(e, (Math.abs(m.d[0]) * c.size[0] + Math.abs(m.d[1]) * c.size[1]) / 2);
        }
        return e;
      };
      const e0 = ext(m.A), e1 = ext(m.B), L = m.L + e0 + e1;
      push({ id: `${m.name}#${i + 1}`, kind: g ? 'ground_beam' : 'beam', group: g ? 'ground_beam' : `beam:${S.name}`, floor: S.name, level: S.level, mark: m.name, parts: [{ poly: beamPoly(m, e0, e1) }], z0: S.level - m.h, z1: S.level, dims: [m.b, m.h, L], order: -m.h });
      if (g) push({ id: `LOT ${m.name}#${i + 1}`, kind: 'lean', group: 'lean_ground_beam', floor: S.name, level: S.level - m.h, mark: m.name, parts: [{ poly: beamPoly(m, e0, e1, m.b + 200) }], z0: S.level - m.h - 100, z1: S.level - m.h, dims: [m.b + 200, 100, L] });
    });
    if (g) continue;
    // the slab: its panels out to the outer face of the edge beams, the stair wells (and other openings) as holes
    const cells = S.loads?.cells ?? [];
    if (cells.length && S.slab > 0) {
      const parts = cells.map((c) => {
        const e = (side) => (c.e?.[side] && !runsOn(c, side, cells) ? c.e[side].b / 2 : 0);
        return { poly: box(c.x0 - e('left'), c.y0 - e('bottom'), c.x1 + e('right'), c.y1 + e('top')) };
      });
      const voids = [...(S.stairs ?? []).map((b) => ({ kind: 'stair', b })), ...(S.openings ?? []).map((b) => ({ kind: 'opening', b }))];
      push({ id: `S/${S.name}`, kind: 'slab', group: `slab:${S.name}`, floor: S.name, level: S.level, parts, holes: voids.map((v) => box(v.b[0], v.b[1], v.b[2], v.b[3])), voidKinds: voids.map((v) => v.kind), z0: S.level - S.slab, z1: S.level, t: S.slab, order: 0 });
    }
    (S.balconyDesign ?? []).forEach((b, i) => {
      const [x0, y0, x1, y1] = b.box, w = x1 - x0, l = y1 - y0;
      push({ id: `BC/${S.name}#${i + 1}`, kind: 'balcony', group: `balcony:${S.name}`, floor: S.name, level: S.level, parts: [{ poly: box(x0, y0, x1, y1) }], z0: S.level - S.slab, z1: S.level, dims: [Math.max(w, l), Math.min(w, l), S.slab], order: 1 });
    });
  }
  // the walls of every floor with their openings, and a lintel over every opening that has masonry above it
  const walls = [], marks = [];
  R.floors.forEach((f, k) => {
    let M;
    try { M = buildModel(f.spec); } catch (e) { warnings.push(`${f.name}: ${e.message}`); return; }
    const above = R.slabs[k + 1];
    const top = above ? above.level - above.slab : f.level + f.height;
    // the soffit over a wall: the beam of the slab above that runs along it, else the slab
    const soffitOf = (s) => {
      const host = above?.members?.find((m) => Math.abs(cross(m.d, s.d)) < 1e-6 && Math.abs(cross(m.d, sub(s.a, m.A))) < s.t);
      return host ? above.level - host.h : top;
    };
    const bySeg = new Map();
    for (const w of M.walls) {
      const low = w.height !== undefined;
      for (const s of w.segs) {
        const rec = {
          id: `${f.name}:${w.id}.${s.index + 1}`, kind: 'wall', group: `wall:${s.t}`, floor: f.name, k, t: s.t, low, L: s.L, parts: [{ poly: segRect(s) }], holes: [],
          z0: low || k > 0 ? f.level : R.ground, z1: low ? f.level + w.height : top, order: low ? 1 : 0,
        };
        walls.push(rec);
        bySeg.set(s, rec);
      }
    }
    M.openings.forEach((o, i) => {
      const w = bySeg.get(o.s);
      if (!w) return;
      const z0 = f.level + o.sill, z1 = Math.min(f.level + o.head, w.z1), width = o.span.to - o.span.from;
      if (z1 <= z0) return;
      const mk = { id: `${f.name}:${o.tag ?? o.type}#${i + 1}`, kind: 'opening', floor: f.name, k, wall: w.id, t: w.t, type: o.type, tag: o.tag ?? null, width, sill: o.sill, head: o.head, parts: [{ poly: segRect(o.s, o.span.from, o.span.to) }], holes: [], z0, z1, lintel: null };
      marks.push(mk);
      // a lintel where there is masonry to carry over the head: under a beam nearer than the depth of a lintel the beam is the lintel
      const lt = lintelFor(width);
      if (Math.min(w.z1, soffitOf(o.s)) - z1 >= lt.h - 1) {
        const a = Math.max(0, o.span.from - lt.bearing), b = Math.min(o.s.L, o.span.to + lt.bearing);
        if (width > LINTELS[LINTELS.length - 1].max) warnings.push(`${mk.id}: opening ${Math.round(width)} wide, the lintel is a designed beam (taken as ${lt.h} deep)`);
        mk.lintel = `LT/${mk.id}`;
        push({ id: mk.lintel, kind: 'lintel', group: 'lintel', floor: f.name, level: z1 + lt.h, mark: `LT${lt.h}`, parts: [{ poly: segRect(o.s, a, b) }], z0: z1, z1: Math.min(z1 + lt.h, w.z1), dims: [w.t, Math.min(lt.h, w.z1 - z1), b - a], lintel: lt, width, t: w.t });
      }
    });
  });
  // the stairs: sloped waist slabs, not prisms. Each flight stands in the model as a flat plate of the same plan and
  // the same volume at its mid-height, the landing as it is; the volume of the bill is the formula on the slope
  const stairs = [];
  R.floors.forEach((f, k) => {
    const waist = (R.stairs ?? []).find((x) => x.index === k)?.waist ?? 120;
    const list = (f.spec.stairs || []).filter((x) => x.type === 'u');
    list.forEach((st, j) => {
      const g = uStairGeom(st, f.height);
      const run = (nr) => (nr - 1) * g.going, fl = (nr) => Math.hypot(run(nr), nr * g.riser);
      const aL = g.a0 + g.run, zl = f.level + g.n1 * g.riser;
      const q = (a0, b0, a1, b1) => [g.at(a0, b0), g.at(a1, b0), g.at(a1, b1), g.at(a0, b1)].map(([x, y]) => [rnd(x), rnd(y)]);
      const plate = (nr, zc) => { const t = (waist * fl(nr)) / Math.max(1, run(nr)); return [zc - t / 2, zc + t / 2]; };
      const [p0, p1] = plate(g.n1, f.level + (g.n1 * g.riser) / 2), [r0, r1] = plate(g.n2, zl + (g.n2 * g.riser) / 2);
      const id = `CT${k + 1}${list.length > 1 ? `.${j + 1}` : ''}`;
      stairs.push({ id, floor: f.name, level: f.level, g, waist, fl1: fl(g.n1), fl2: fl(g.n2), profile: q(g.a0, g.b0, g.a1, g.b1), z0: f.level, z1: f.level + f.height });
      for (const [tag, poly, z0, z1] of [['1', q(g.a0, g.f1[0], aL, g.f1[1]), p0, p1], ['L', q(aL, g.b0, g.a1, g.b1), zl - waist, zl], ['2', q(aL - run(g.n2), g.f2[0], aL, g.f2[1]), r0, r1]]) {
        push({ id: `${id}-${tag}`, kind: 'stair', group: 'stair', floor: f.name, level: f.level, mark: id, stair: id, parts: [{ poly }], z0: rnd(z0), z1: rnd(z1) });
      }
    });
  });
  // the slab on grade of the ground floor: the plate the full-height walls of the ground floor enclose (they stand
  // on the ground beams and hold the fill), one solid for every enclosed region, its top at the floor level
  const gs = groundSlab === false ? null : { thickness: 100, ...(groundSlab ?? {}) }, f0 = R.floors[0];
  if (gs && gs.thickness > 0 && f0) {
    const E = enclosedRegions(walls.filter((w) => w.k === 0 && !w.low).map((w) => w.parts[0].poly));
    E.regions.forEach((rg, i) => push({
      id: `NEN#${i + 1}`, kind: 'ground_slab', group: 'ground_slab', floor: f0.name, level: f0.level, parts: rg.rects.map((r) => ({ poly: box(r[0], r[1], r[2], r[3]) })),
      z0: f0.level - gs.thickness, z1: f0.level, t: gs.thickness, sampled: !E.exact, order: 0,
    }));
  }
  for (const it of [...items, ...walls, ...marks]) {
    for (const p of it.parts) p.rect = rectOf(p.poly);
    it.exact = it.parts.every((p) => p.rect) && !it.sampled;
    if (!it.exact) warnings.push(`${it.id}: not parallel to the axes, measured by sampling`);
    if (it.kind === 'stair') it.exact = false;
  }
  return { items, walls, marks, stairs, warnings };
}

/** The outline of an item: [{profile, holes}] (a slab of several panels is traced as one plate with its openings). */
function outline(it) {
  if (it.parts.length === 1 && !it.holes.length) return { pieces: [{ profile: it.parts[0].poly, holes: [] }], area: polyArea(it.parts[0].poly), holeArea: [], perimeter: null };
  if (it.parts.every((p) => p.rect)) return unionLoops(it.parts.map((p) => p.rect), it.holes);
  return { pieces: it.parts.map((p) => ({ profile: p.poly, holes: [] })), area: sum(it.parts.map((p) => polyArea(p.poly))), holeArea: it.holes.map(() => 0), perimeter: null };
}

/**
 * The members of the structure as prisms for an independent union (AutoCAD's solid modeler, measure_model):
 * [{id, kind, group, profile, holes, z0, z1, exact}] in mm. Footings, lean concrete, column stubs, ground beams,
 * columns storey by storey, beams (through their nodes), slabs (one plate with its openings), balconies and lintels
 * are exact prisms. The flights of a stair are not prisms (a sloped waist): each is given as a flat plate of the
 * same plan and the same volume at the mid-height of the flight, the landing as it is (exact: false). The slab on
 * grade of the ground floor is one prism for every region the walls enclose (groundSlab: its options as given to
 * solidModel - {thickness}, or false for none: pass model.options so that both measure the same members).
 */
export function structurePrisms(R, { lean = true, lintels = true, stairs = true, groundSlab = null } = {}) {
  const G = geometry(R, { groundSlab }), out = [];
  for (const it of G.items) {
    if ((it.kind === 'lean' && !lean) || (it.kind === 'lintel' && !lintels) || (it.kind === 'stair' && !stairs)) continue;
    const o = outline(it);
    o.pieces.forEach((p, i) => out.push({ id: o.pieces.length > 1 ? `${it.id}.${i + 1}` : it.id, kind: it.kind, group: it.group, profile: p.profile, holes: p.holes, z0: it.z0, z1: it.z1, exact: it.exact }));
  }
  return out;
}

// ---------------------------------------------------------------- numbers as expressions

export const mS = (mm) => { const r = Math.round(mm); return r % 10 === 0 ? (r / 1000).toFixed(2) : (r / 1000).toFixed(3); };
const mV = (mm) => Math.round(mm) / 1000;
export const dec = (v, d) => { const s = (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace(/\.?0+$/, ''); return s === '' || s === '-0' ? '0' : s; };
const rd = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
/** An expression of the model ("0.22*0.22*3.60-0.0213") as it is written in a bill: "0,22 x 0,22 x 3,60 - 0,0213". */
export const showExpr = (expr, lang = 'vi') => {
  const s = String(expr).replace(/\*/g, ' x ').replace(/([0-9)])-/g, '$1 - ').replace(/\+/g, ' + ').replace(/\//g, ' / ');
  return lang === 'en' ? s : s.replace(/\./g, ',');
};
/** A closed formula and what the model measured: the formula alone when they agree, else less (or plus) the difference. */
function closed(expr, value, actual, d = 4) {
  const diff = value - actual;
  if (Math.abs(diff) < 0.5 * 10 ** -d) return { expr, one: value, gross: value };
  return diff > 0 ? { expr: `${expr}-${dec(diff, d)}`, one: value - rd(diff, d), gross: value } : { expr: `${expr}+${dec(-diff, d)}`, one: value + rd(-diff, d), gross: value };
}

// ---------------------------------------------------------------- the model

const CLASS = { slab: 'slab', balcony: 'slab', beam: 'beam', ground_beam: 'beam', column: 'column', stub: 'column' };
const CONCRETE = 3, MASONRY = 4, OPENING = 5, OUT = 1, IN = 2;

/**
 * The solid model of a calculation result R by a rule set (rules.mjs): {solids, walls, openings, stairs, plaster,
 * union, sumNet, sumGross, sumCuts, checks, warnings}.
 *  - solids: every concrete member {id, kind (footing, lean, stub, ground_beam, column, beam, slab, balcony, lintel,
 *    stair), group (its line of the bill), floor, level, profile, holes, z0, z1 (mm), area (m², plan), gross (m³),
 *    cuts: [{by, rule, volume}], net, count (like parts), how, expr, one, formwork: {side, soffit, total, expr,
 *    one}, faces};
 *  - walls: the masonry {id, floor, t, L, z0, z1, gross, concrete, openings, overlap, net (m³), faces};
 *  - openings: {id, floor, wall, t, type, width, area (m², clear of concrete), volume, faceIn, faceOut, reveal,
 *    revealIn, revealOut, lintel};
 *  - plaster: the faces that meet the air (m²): inside {wall, concrete, reveal}, outside {wall, concrete, reveal},
 *    soffit {slab, beam, balcony, stair};
 *  - union: the volume of the union of all concrete members by a sweep, sumNet the sum of the net volumes;
 *  - every solid also has below (m³ of its net volume under the ground) and buried ({volume, whole, expr, one});
 *    a slab on grade (kind ground_slab) has fill: the fill under it from the ground to its underside {height (m),
 *    gross, net (less what stands in it), expr, one}; a stair has steps: the brick steps of its flights [{flight,
 *    n (steps), going, riser, risers, w (mm), tread (m² of one), expr, one (m³ of one step)}];
 *  - earth: the earthwork of the foundations {items (pits, trenches: earthwork above), total, sum, space, slope,
 *    buried: {total, groups: [{group, volume, whole}]}, backfill} or null;
 *  - assumed [{item, value, note}]: what the model assumed (earthwork, ground slab, steps), options: {earth,
 *    groundSlab} as resolved (for structurePrisms).
 * Options: earth {space: working space in mm (300), slope: horizontal for 1 vertical (0)} or false; groundSlab
 * {thickness (100), concrete ('B15')} or false.
 */
export function solidModel(R, { rules = null, lang = 'vi', earth = null, groundSlab = null } = {}) {
  const RS = ruleSet(rules);
  const EO = earth === false ? null : { space: 300, slope: 0, ...(earth ?? {}) };
  const GO = groundSlab === false || groundSlab?.thickness === 0 ? null : { thickness: 100, concrete: 'B15', ...(groundSlab ?? {}) };
  const { items: raw, walls, marks, stairs, warnings } = geometry(R, { groundSlab: GO ?? false });
  const ground = R.ground ?? 0;
  // who takes the concrete where members meet: the order of the rule set, then deeper beams first
  const junction = RS.junction ?? ['slab', 'beam', 'column'];
  // (the slab on grade is cast last, around what stands in it: it takes nothing from the others)
  const rank = (it) => { const c = CLASS[it.kind], i = c ? junction.indexOf(c) : -1; return i >= 0 ? i : 10 + ['footing', 'stair', 'lintel', 'lean', 'ground_slab'].indexOf(it.kind); };
  const items = raw.map((it, i) => ({ it, i })).sort((a, b) => rank(a.it) - rank(b.it) || (a.it.order ?? 0) - (b.it.order ?? 0) || a.i - b.i).map((x) => x.it);
  const wallsO = walls.map((it, i) => ({ it, i })).sort((a, b) => a.it.order - b.it.order || a.i - b.i).map((x) => x.it);
  const all = [...items, ...wallsO];
  // the grid: every coordinate of a face, a margin of air around and above, the ground below
  const pts = [...all, ...marks].flatMap((it) => [...it.parts.flatMap((p) => p.poly), ...it.holes.flat()]);
  const zsAll = [...all, ...marks].flatMap((it) => [it.z0, it.z1]);
  const pad = (vs) => { const u = uniq(vs.map(rnd)); return [u[0] - 1000, ...u, u[u.length - 1] + 1000]; };
  const xs = pad(pts.map((p) => p[0])), ys = pad(pts.map((p) => p[1])), zs = pad([...zsAll, 0, R.ground ?? 0]);
  const nx = xs.length - 1, ny = ys.length - 1, nz = zs.length - 1, n = nx * ny * nz;
  const owner = new Int32Array(n).fill(EMPTY), stamp = new Int32Array(nx * ny);
  let serial = 0;
  const footprint = (it, visit) => {
    serial++;
    for (const part of it.parts) {
      const bb = part.rect ?? bboxOf(part.poly);
      const i0 = locate(xs, bb[0]), i1 = locate(xs, bb[2]), j0 = locate(ys, bb[1]), j1 = locate(ys, bb[3]);
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
        const k = j * nx + i;
        if (stamp[k] === serial) continue;
        const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
        if (!part.rect && !inPoly(cx, cy, part.poly)) continue;
        if (it.holes.some((h) => inPoly(cx, cy, h))) continue;
        stamp[k] = serial;
        visit(i, j, (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]));
      }
    }
  };
  const claim = (it, me) => {
    const k0 = locate(zs, it.z0), k1 = locate(zs, it.z1), cuts = new Map();
    let gross = 0, net = 0, plan = 0, below = 0;
    footprint(it, (i, j, a) => {
      plan += a;
      for (let k = k0; k < k1; k++) {
        const v = a * (zs[k + 1] - zs[k]), c = (k * ny + j) * nx + i, o = owner[c];
        gross += v;
        if (o === EMPTY) { owner[c] = me; net += v; if (zs[k + 1] <= ground + TOL) below += v; } else cuts.set(o, (cuts.get(o) ?? 0) + v);
      }
    });
    return { gross, net, plan, cuts, below };
  };
  // concrete first (by the junction order), then the openings (what is left of them clear of concrete), then masonry
  const got = new Map();
  items.forEach((it, i) => got.set(it, claim(it, i)));
  marks.forEach((mk, i) => got.set(mk, claim(mk, -2 - i)));
  wallsO.forEach((it, i) => got.set(it, claim(it, items.length + i)));
  // what every cell is: concrete, masonry, an opening, the air outside (reached from the margin above the ground),
  // the air inside (above the ground floor), or the ground and the fill under the ground floor. The slab on grade
  // counts as the ground it lies on: what stands in it (stubs, walls) was built before and keeps its faces as they were
  const type = new Uint8Array(n);
  for (let c = 0; c < n; c++) { const o = owner[c]; if (o !== EMPTY) type[c] = o <= -2 ? OPENING : o < items.length ? (items[o].kind === 'ground_slab' ? 0 : CONCRETE) : MASONRY; }
  const layer = nx * ny;
  const zmid = (k) => (zs[k] + zs[k + 1]) / 2;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (c, k) => { if (owner[c] === EMPTY && type[c] === 0 && zmid(k) > ground) { type[c] = OUT; queue[tail++] = c; } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) seed((k * ny + j) * nx + i, k);
  }
  while (head < tail) {
    const c = queue[head++], k = Math.floor(c / layer), r = c - k * layer, j = Math.floor(r / nx), i = r - j * nx;
    if (i > 0) seed(c - 1, k);
    if (i < nx - 1) seed(c + 1, k);
    if (j > 0) seed(c - nx, k);
    if (j < ny - 1) seed(c + nx, k);
    if (k > 0) seed(c - layer, k - 1);
    if (k < nz - 1) seed(c + layer, k + 1);
  }
  for (let k = 0; k < nz; k++) if (zmid(k) > 0) for (let c = k * layer; c < (k + 1) * layer; c++) if (owner[c] === EMPTY && type[c] === 0) type[c] = IN;
  // the faces of every member and opening by what they meet: [side, bottom, top] x [ground, outside, inside, concrete, masonry, opening] (mm²)
  const F = new Map();
  const acc = (o) => (o >= 0 ? all[o] : marks[-2 - o]);
  for (const it of [...all, ...marks]) F.set(it, new Float64Array(19));
  // [18]: the sides of a pad against concrete that is not another pad (a ground beam through it)
  const padSide = (me, f, c2, a) => { const o2 = owner[c2]; if (me.kind === 'footing' && type[c2] === CONCRETE && o2 >= 0 && all[o2].kind !== 'footing') f[18] += a; };
  for (let k = 0; k < nz; k++) {
    const dz = zs[k + 1] - zs[k];
    for (let j = 0; j < ny; j++) {
      const dy = ys[j + 1] - ys[j];
      for (let i = 0; i < nx; i++) {
        const c = (k * ny + j) * nx + i, o = owner[c];
        if (o === EMPTY) continue;
        const me = acc(o), f = F.get(me), dx = xs[i + 1] - xs[i];
        if (owner[c - 1] !== o) { f[type[c - 1]] += dy * dz; padSide(me, f, c - 1, dy * dz); }
        if (owner[c + 1] !== o) { f[type[c + 1]] += dy * dz; padSide(me, f, c + 1, dy * dz); }
        if (owner[c - nx] !== o) { f[type[c - nx]] += dx * dz; padSide(me, f, c - nx, dx * dz); }
        if (owner[c + nx] !== o) { f[type[c + nx]] += dx * dz; padSide(me, f, c + nx, dx * dz); }
        if (owner[c - layer] !== o) f[6 + type[c - layer]] += dx * dy;
        if (owner[c + layer] !== o) f[12 + type[c + layer]] += dx * dy;
      }
    }
  }
  const faces = (it) => {
    const f = F.get(it), row = (d) => ({ ground: f[d] / 1e6, out: f[d + 1] / 1e6, in: f[d + 2] / 1e6, concrete: f[d + 3] / 1e6, masonry: f[d + 4] / 1e6, opening: f[d + 5] / 1e6 });
    return { side: row(0), bottom: row(6), top: row(12), other: f[18] / 1e6 };
  };
  const bare = (r) => r.ground + r.out + r.in + r.masonry + r.opening;
  // the solids
  const idOf = (o) => (o >= 0 ? all[o].id : marks[-2 - o].id);
  const ruleOf = (it, o) => {
    const by = o >= 0 ? all[o] : null, a = CLASS[it.kind], b = by ? CLASS[by.kind] : null;
    return !by ? 'opening' : it.kind === 'wall' ? (by.kind === 'wall' ? 'once' : 'concrete') : a && b && a !== b ? b : 'once';
  };
  const cutsOf = (it) => [...got.get(it).cuts].filter(([, v]) => v > 0.5).map(([by, v]) => ({ by: idOf(by), rule: ruleOf(it, by), volume: v / 1e9 }));
  const offOf = (cuts) => {
    const byRule = new Map();
    for (const c of cuts) byRule.set(c.rule, (byRule.get(c.rule) ?? 0) + c.volume);
    return [...byRule].filter(([, v]) => v >= 5e-7).sort((a, b) => junction.indexOf(a[0]) - junction.indexOf(b[0]));
  };
  const solids = raw.filter((it) => it.kind !== 'stair').map((it) => {
    const G = got.get(it), o = outline(it), fc = faces(it), cuts = cutsOf(it);
    const area = o.area / 1e6, h = (it.z1 - it.z0) / 1000, gross = G.gross / 1e9, net = G.net / 1e9;
    // the prism formula of the member, and the volume the others took, by the rule that gave it to them
    let formula, value;
    // the plan of the member as an expression (for what is taken of its height: the part below the ground, the fill)
    let planExpr = dec(area, 4), planValue = rd(area, 4);
    if (it.dims && ['footing', 'stub', 'column'].includes(it.kind)) { planExpr = `${mS(it.dims[0])}*${mS(it.dims[1])}`; planValue = mV(it.dims[0]) * mV(it.dims[1]); }
    if (it.kind === 'ground_slab' && it.parts.length <= 6 && it.parts.every((q) => q.rect)) {
      // a region of a few rectangles: their sum
      const terms = it.parts.map((q) => `${mS(q.rect[2] - q.rect[0])}*${mS(q.rect[3] - q.rect[1])}`);
      planExpr = terms.length > 1 ? `(${terms.join('+')})` : terms[0];
      planValue = sum(it.parts.map((q) => mV(q.rect[2] - q.rect[0]) * mV(q.rect[3] - q.rect[1])));
      formula = `${planExpr}*${mS(it.z1 - it.z0)}`;
      value = planValue * mV(it.z1 - it.z0);
    } else if (it.dims) { formula = it.dims.map(mS).join('*'); value = it.dims.reduce((p, d) => p * mV(d), 1); }
    else {
      const r = o.pieces.length === 1 ? rectOf(o.pieces[0].profile) : null;
      const hr = r ? it.holes.map((hl, i) => (rectOf(hl) && Math.abs(o.holeArea[i] - polyArea(hl)) < 1 ? rectOf(hl) : null)) : [];
      if (r && hr.every(Boolean)) {
        const terms = [`${mS(r[2] - r[0])}*${mS(r[3] - r[1])}`, ...hr.map((q) => `${mS(q[2] - q[0])}*${mS(q[3] - q[1])}`)];
        formula = `${hr.length ? `(${terms.join('-')})` : terms[0]}*${mS(it.z1 - it.z0)}`;
        value = (mV(r[2] - r[0]) * mV(r[3] - r[1]) - sum(hr.map((q) => mV(q[2] - q[0]) * mV(q[3] - q[1])))) * mV(it.z1 - it.z0);
      } else { formula = `${dec(area, 4)}*${mS(it.z1 - it.z0)}`; value = rd(area, 4) * mV(it.z1 - it.z0); }
    }
    const off = offOf(cuts);
    const expr = formula + off.map(([, v]) => `-${dec(v, 6)}`).join('');
    const one = value - sum(off.map(([, v]) => rd(v, 6)));
    // formwork: the sides and the soffit that are not cast against concrete (a lintel is cast on its wall; footings,
    // stubs and ground beams stand on their lean concrete; lean concrete is cast on the ground)
    // (lean concrete and the slab on grade are cast on the ground, the slab between the walls)
    const side = it.kind === 'lean' || it.kind === 'ground_slab' ? 0 : it.kind === 'lintel' ? bare(fc.side) - fc.side.masonry : bare(fc.side);
    const soffit = ['beam', 'slab', 'balcony'].includes(it.kind) ? bare(fc.bottom) : it.kind === 'lintel' ? fc.bottom.out + fc.bottom.in + fc.bottom.opening : 0;
    let fw = { expr: '0', one: 0, gross: 0 };
    const [d0, d1, d2] = it.dims ?? [];
    if (it.kind === 'footing') fw = closed(`2*(${mS(d0)}+${mS(d1)})*${mS(d2)}`, 2 * (mV(d0) + mV(d1)) * mV(d2), side);
    else if (it.kind === 'stub' || it.kind === 'column') fw = closed(`2*(${mS(d0)}+${mS(d1)})*${mS(d2)}`, 2 * (mV(d0) + mV(d1)) * mV(d2), side);
    else if (it.kind === 'ground_beam') fw = closed(`2*${mS(d1)}*${mS(d2)}`, 2 * mV(d1) * mV(d2), side);
    else if (it.kind === 'beam') fw = closed(`(2*${mS(d1)}+${mS(d0)})*${mS(d2)}`, (2 * mV(d1) + mV(d0)) * mV(d2), side + soffit);
    else if (it.kind === 'balcony') fw = closed(`${mS(d0)}*${mS(d1)}+(${mS(d0)}+2*${mS(d1)})*${mS(d2)}`, mV(d0) * mV(d1) + (mV(d0) + 2 * mV(d1)) * mV(d2), side + soffit);
    else if (it.kind === 'lintel') fw = closed(`2*${mS(d1)}*${mS(d2)}+${mS(d0)}*${mS(it.width)}`, 2 * mV(d1) * mV(d2) + mV(d0) * mV(it.width), side + soffit);
    else if (it.kind === 'slab') fw = { expr: `${dec(soffit, 4)}+${dec(side, 4)}`, one: rd(soffit, 4) + rd(side, 4), gross: rd(soffit, 4) + rd(side, 4) };
    const voids = it.kind === 'slab' ? it.holes.map((hl, i) => ({ kind: it.voidKinds[i], box: bboxOf(hl), area: o.holeArea[i] / 1e6, volume: (o.holeArea[i] / 1e6) * h })).filter((v) => v.area > 1e-9) : undefined;
    // what lies under the ground: the whole member, or its height up to the ground less what the others took there
    const below = G.below / 1e9, whole = it.z1 <= ground + TOL;
    let buried = null;
    if (below > 5e-10) {
      if (whole) buried = { volume: below, whole, expr, one };
      else { const hb = ground - it.z0, cb = closed(`${planExpr}*${mS(hb)}`, planValue * mV(hb), below, 6); buried = { volume: below, whole, expr: cb.expr, one: cb.one }; }
    }
    // the fill under a slab on grade: from the ground up to its underside, less what stands in it
    let fill;
    if (it.kind === 'ground_slab') {
      let fg = 0, fn = 0;
      const hf = Math.max(0, it.z0 - ground);
      if (hf > TOL) {
        const ka = locate(zs, ground), kb = locate(zs, it.z0);
        footprint(it, (i, j, a) => { for (let k = ka; k < kb; k++) { const v = a * (zs[k + 1] - zs[k]); fg += v; if (owner[(k * ny + j) * nx + i] === EMPTY) fn += v; } });
      }
      const cf = closed(`${planExpr}*${mS(hf)}`, planValue * mV(hf), fn / 1e9);
      fill = { height: hf / 1000, gross: fg / 1e9, net: fn / 1e9, value: cf.gross, expr: cf.expr, one: cf.one };
    }
    return {
      id: it.id, kind: it.kind, group: it.group, floor: it.floor, level: it.level, mark: it.mark ?? null, profile: o.pieces[0]?.profile ?? [], holes: o.pieces[0]?.holes ?? [], pieces: o.pieces,
      z0: it.z0, z1: it.z1, area, height: h, formula, value, gross, cuts, net, expr, one, exact: it.exact, faces: fc, voids, below, buried, fill,
      formwork: { side, soffit, total: side + soffit, expr: fw.expr, one: fw.one, gross: fw.gross }, dims: it.dims ?? null, lintel: it.lintel, width: it.width, t: it.t,
    };
  });
  // the stairs by formula: waist slabs on the slope and the landing; soffits and the edges along the well
  for (const s of stairs) {
    const { g, waist, fl1, fl2 } = s, B = g.b1 - g.b0;
    const plates = raw.filter((it) => it.stair === s.id), cuts = plates.flatMap(cutsOf), off = offOf(cuts);
    const formula = `(${mS(fl1)}+${mS(fl2)})*${mS(g.w)}*${mS(waist)}+${mS(B)}*${mS(g.landing)}*${mS(waist)}`;
    const value = (mV(fl1) + mV(fl2)) * mV(g.w) * mV(waist) + mV(B) * mV(g.landing) * mV(waist);
    const expr = formula + off.map(([, v]) => `-${dec(v, 6)}`).join(''), one = value - sum(off.map(([, v]) => rd(v, 6)));
    const soffit = (mV(fl1) + mV(fl2)) * mV(g.w) + mV(B) * mV(g.landing), side = (mV(fl1) + mV(fl2)) * mV(waist);
    // the brick steps built on the flights: one triangle going x riser / 2 under every tread (the last riser of a
    // flight is the edge of the landing or of the floor). The going is the run of the stair over its treads, the
    // riser the storey height over all the risers: whole numbers of the drawing, so the formula is exact
    const kRun = Math.max(1, Math.round(g.run / g.going)), nAll = g.n1 + g.n2, rise = s.z1 - s.z0;
    const steps = [g.n1, g.n2].map((nr, i) => ({
      flight: i + 1, n: Math.max(0, nr - 1), going: g.going, riser: g.riser, risers: nr, w: g.w, tread: (mV(g.run) / kRun) * mV(g.w),
      expr: `${mS(g.run)}/${kRun}*${mS(rise)}/${nAll}/2*${mS(g.w)}`, one: (((mV(g.run) / kRun) * mV(rise)) / nAll / 2) * mV(g.w),
    })).filter((x) => x.n > 0);
    const below = sum(plates.map((q) => got.get(q).below)) / 1e9;
    solids.push({
      id: s.id, kind: 'stair', group: 'stair', floor: s.floor, level: s.level, mark: s.id, profile: s.profile, holes: [], pieces: plates.map((p) => ({ profile: p.parts[0].poly, holes: [], z0: p.z0, z1: p.z1 })),
      z0: s.z0, z1: s.z1, area: soffit, height: waist / 1000, formula, value, gross: sum(plates.map((p) => got.get(p).gross)) / 1e9, cuts, net: sum(plates.map((p) => got.get(p).net)) / 1e9, expr, one, exact: false, faces: null,
      steps, treads: uStairFinish(g).tread - (B * g.landing) / 1e6, below, buried: below > 5e-10 ? { volume: below, whole: false, expr: dec(below, 6), one: rd(below, 6) } : null,
      formwork: { side, soffit, total: side + soffit, expr: `(${mS(fl1)}+${mS(fl2)})*${mS(g.w)}+${mS(B)}*${mS(g.landing)}+(${mS(fl1)}+${mS(fl2)})*${mS(waist)}`, one: soffit + side, gross: soffit + side }, dims: null,
    });
  }
  // like parts: the same line of the bill and the same expression
  const like = new Map();
  for (const s of solids) like.set(`${s.group}|${s.expr}`, (like.get(`${s.group}|${s.expr}`) ?? 0) + 1);
  for (const s of solids) {
    s.count = like.get(`${s.group}|${s.expr}`);
    const e = showExpr(s.expr, lang);
    s.how = s.count > 1 ? `${s.count} x ${/[-+]/.test(s.expr.replace(/\([^)]*\)/g, '')) ? `(${e})` : e}` : e;
  }
  // the masonry and the openings
  const wallRecs = walls.map((it) => {
    const G = got.get(it);
    let concrete = 0, openings = 0, overlap = 0;
    for (const [o, v] of G.cuts) { if (o <= -2) openings += v; else if (o < items.length) concrete += v; else overlap += v; }
    return { id: it.id, floor: it.floor, k: it.k, t: it.t, low: it.low, L: it.L / 1000, z0: it.z0, z1: it.z1, gross: G.gross / 1e9, concrete: concrete / 1e9, openings: openings / 1e9, overlap: overlap / 1e9, net: G.net / 1e9, exact: it.exact, faces: faces(it) };
  });
  const openRecs = marks.map((mk) => {
    const G = got.get(mk), fc = faces(mk), volume = G.net / 1e9;
    // the reveals: jambs, head, and the sill of an opening that starts above the floor
    const reveal = fc.side.masonry + fc.side.concrete + fc.top.masonry + fc.top.concrete + (mk.sill > 1 ? fc.bottom.masonry + fc.bottom.concrete : 0);
    const faceIn = fc.side.in, faceOut = fc.side.out;
    const share = faceIn > 0 && faceOut > 0 ? 0.5 : faceOut > 0 && !(faceIn > 0) ? 0 : 1;
    return { id: mk.id, floor: mk.floor, wall: mk.wall, t: mk.t, type: mk.type, tag: mk.tag, width: mk.width / 1000, height: (mk.z1 - mk.z0) / 1000, area: volume / (mk.t / 1000), volume, faceIn, faceOut, reveal, revealIn: reveal * share, revealOut: reveal * (1 - share), lintel: mk.lintel };
  });
  // plaster: the faces that meet the air. Walls with the concrete that stands in them (columns, lintels) inside; the
  // whole facade outside (walls, columns, beam and slab edges, balcony edges); soffits with the inner sides of the beams
  const of = (kinds) => solids.filter((s) => kinds.includes(s.kind) && s.faces);
  const plaster = {
    inside: { wall: sum(wallRecs.map((w) => w.faces.side.in + w.faces.top.in)), concrete: sum(of(['column', 'stub', 'lintel']).map((s) => s.faces.side.in)), reveal: sum(openRecs.map((o) => o.revealIn)) },
    outside: { wall: sum(wallRecs.map((w) => w.faces.side.out + w.faces.top.out)), concrete: sum(of(['column', 'stub', 'lintel', 'beam', 'ground_beam', 'slab', 'balcony']).map((s) => s.faces.side.out)), reveal: sum(openRecs.map((o) => o.revealOut)) },
    soffit: {
      slab: sum(of(['slab']).map((s) => s.faces.bottom.in + s.faces.bottom.out + s.faces.side.in)), beam: sum(of(['beam']).map((s) => s.faces.bottom.in + s.faces.bottom.out + s.faces.side.in)),
      balcony: sum(of(['balcony']).map((s) => s.faces.bottom.in + s.faces.bottom.out)), stair: sum(solids.filter((s) => s.kind === 'stair').map((s) => s.formwork.soffit)),
    },
  };
  // the union of all concrete members by a sweep, and the checks
  const prisms = solids.flatMap((s) => s.pieces.map((p) => ({ profile: p.profile, holes: p.holes, z0: p.z0 ?? s.z0, z1: p.z1 ?? s.z1, ground: s.kind === 'ground_slab' })));
  const union = unionVolume(prisms);
  const sumNet = sum(solids.map((s) => s.net)), sumGross = sum(solids.map((s) => s.gross)), sumCuts = sum(solids.flatMap((s) => s.cuts.map((c) => c.volume)));
  const en = lang === 'en';
  const checks = [];
  const check = (id, name, lhs, rhs, tol, where = []) => checks.push({ id, name, ok: Math.abs(lhs - rhs) <= tol && !where.length, lhs: rd(lhs, 6), rhs: rd(rhs, 6), tol, where });
  const prismOff = solids.filter((s) => s.kind !== 'stair' && Math.abs(s.gross - s.area * s.height) > 1e-6 + 1e-9 * s.gross);
  const formOff = solids.filter((s) => s.kind !== 'stair' && Math.abs(s.value - s.gross) > 2e-4 * Math.max(1, s.gross));
  check('prism', en ? 'Every solid: the prism formula = area of its profile x height (m³)' : 'Từng khối: công thức lăng trụ = diện tích tiết diện x chiều cao (m³)',
    sum(solids.filter((s) => s.kind !== 'stair').map((s) => s.value)), sum(solids.filter((s) => s.kind !== 'stair').map((s) => s.area * s.height)), rd(Math.max(1e-3, 2e-4 * sumGross), 3), [...prismOff, ...formOff].map((s) => s.id));
  check('union', en ? 'Sum of the net volumes = volume of the union of all members (m³)' : 'Tổng thể tích tịnh = thể tích hợp của tất cả cấu kiện (m³)', sumNet, union, 1e-6);
  check('contact', en ? 'Gross volumes less the contact volumes, each given to one member = the union (m³)' : 'Tổng thể tích thô trừ phần giao (mỗi phần giao tính cho đúng một cấu kiện) = thể tích hợp (m³)', sumGross - sumCuts, union, 1e-6);
  for (const s of solids.filter((x) => x.kind === 'slab')) {
    const it = raw.find((x) => x.id === s.id);
    const plate = unionArea(it.parts.map((p) => ({ profile: p.poly, holes: [] }))) / 1e6;
    check(`plate:${s.floor}`, en ? `Slab ${s.floor}: slab area + openings = the floor plate (m²)` : `Sàn ${s.floor}: diện tích sàn + lỗ mở = diện tích mặt sàn (m²)`, s.area + sum(s.voids.map((v) => v.area)), plate, 1e-6);
  }
  const stacks = R.columns.map((c) => ({ c, h: sum(solids.filter((s) => (s.kind === 'column' || s.kind === 'stub') && raw.find((x) => x.id === s.id).column === c.name).map((s) => s.height)) }));
  check('columns', en ? 'Columns: the storeys of every column add up to its height (m)' : 'Cột: tổng chiều cao các đoạn của từng cột = chiều cao cột (m)', sum(stacks.map((x) => x.h)), sum(stacks.map((x) => (x.c.top - colBase(R, x.c)) / 1000)), 1e-6,
    stacks.filter((x) => Math.abs(x.h - (x.c.top - colBase(R, x.c)) / 1000) > 1e-6).map((x) => x.c.name));
  // the sides of the pads that are formed (with those against other concrete that is not a pad) against the outline
  // of the pads, level by level: pads that touch or overlap are cast as one, the sides between them are not formed
  const pads = solids.filter((s) => s.kind === 'footing');
  if (pads.length) {
    const pz = uniq(pads.flatMap((s) => [s.z0, s.z1]));
    let outline = 0;
    for (let k = 0; k + 1 < pz.length; k++) {
      const zm = (pz[k] + pz[k + 1]) / 2, act = pads.filter((s) => s.z0 < zm && s.z1 > zm).map((s) => raw.find((x) => x.id === s.id));
      if (act.length) outline += (unionLoops(act.flatMap((it) => it.parts.map((q) => q.rect ?? bboxOf(q.poly)))).perimeter * (pz[k + 1] - pz[k])) / 1e6;
    }
    check('formwork:footing', en ? 'Formwork of the footings = outline of the pads (pads that touch or overlap taken as one) x H (m²)' : 'Ván khuôn móng = chu vi đường bao các đế móng (móng chạm hoặc chồng nhau tính là một) x H (m²)',
      sum(pads.map((s) => s.formwork.side + s.faces.other)), outline, 1e-6);
  }
  const inside = plaster.inside.wall + plaster.inside.concrete;
  if (wallRecs.length) check('envelope', en ? 'The walls enclose the rooms: masonry net + concrete + openings + overlaps = gross (m³)' : 'Tường khép kín, thể tích xây + bê tông + cửa + phần trùng = thể tích thô (m³)',
    sum(wallRecs.map((w) => w.net + w.concrete + w.openings + w.overlap)), sum(wallRecs.map((w) => w.gross)), 1e-6, inside > 0 ? [] : [en ? 'no enclosed room found' : 'không tìm thấy phòng khép kín']);
  // the slab on grade: the regions against the rooms the outline of the ground-floor walls leaves (its inner loops)
  const slabs0 = solids.filter((s) => s.kind === 'ground_slab'), assumed = [];
  if (slabs0.length) {
    const ws = walls.filter((w) => w.k === 0 && !w.low);
    if (ws.every((w) => w.parts[0].rect)) {
      check('ground:plate', en ? 'Ground floor slab: its regions = what the outline of the ground-floor walls encloses (m²)' : 'Nền tầng 1: tổng các ô nền = phần đường bao tường tầng 1 khép kín (m²)',
        sum(slabs0.map((s) => s.area)), sum(unionLoops(ws.map((w) => w.parts[0].rect)).pieces.flatMap((q) => q.holes.map(polyArea))) / 1e6, 1e-6);
    }
    check('ground:fill', en ? 'Ground floor: slab + fill under it = the regions x the height from the ground to the floor (m³)' : 'Nền tầng 1: bê tông nền + lớp tôn nền = diện tích các ô nền x chiều cao từ mặt đất đến mặt nền (m³)',
      sum(slabs0.map((s) => s.gross + s.fill.gross)), sum(slabs0.map((s) => s.area * (s.height + s.fill.height))), 1e-6);
    if (groundSlab?.thickness === undefined) {
      const t = slabs0[0].t, hf = Math.round(slabs0[0].fill.height * 1000);
      assumed.push({
        item: 'ground_slab', value: `${t} mm, ${GO.concrete}`,
        note: en ? `ground floor slab on grade: concrete ${GO.concrete} ${t} thick inside the walls, no mesh${hf > 0 ? `, on ${hf} of sand fill compacted from the ground up to its underside` : ''}`
          : `nền tầng 1: bê tông ${GO.concrete} dày ${t} trong lòng tường, không lưới thép${hf > 0 ? `, trên lớp cát tôn nền dày ${hf} đầm chặt từ mặt đất tự nhiên đến đáy bê tông nền` : ''}`,
      });
    }
  }
  // the earthwork of the foundations: pits and trenches, what is buried in them, the backfill
  let earthRec = null;
  const E = EO ? earthwork(raw.filter((it) => it.kind === 'lean'), ground, EO) : null;
  if (E?.items.length) {
    const under = solids.filter((s) => s.kind !== 'ground_slab' && s.below > 5e-10);
    const groups = [...new Set(under.map((s) => s.group))].map((g) => {
      const mine = solids.filter((s) => s.group === g);
      return { group: g, volume: sum(mine.map((s) => s.below)), whole: mine.every((s) => !s.buried || s.buried.whole) && mine.every((s) => s.below > 5e-10 || s.net <= 5e-7) };
    });
    const buried = sum(under.map((s) => s.below)), m = Math.max(0, Number(EO.slope) || 0), sp = Math.max(0, Number(EO.space) || 0);
    earthRec = { items: E.items.map(({ at, base, ...x }) => x), total: E.total, sum: E.sum, space: sp, slope: m, exact: E.exact && !m, buried: { total: buried, groups }, backfill: E.total - buried };
    // another way to the union: the outline of the pits and trenches level by level (vertical sides along the axes);
    // with slopes, the same sweep in finer layers
    const tolE = m > 0 ? rd(Math.max(1e-3, 2e-3 * E.total), 3) : 1e-6;
    let other;
    if (!m && E.exact) {
      const ez = uniq(E.items.flatMap((x) => [x.z0, x.z1]));
      other = 0;
      for (let k = 0; k + 1 < ez.length; k++) {
        const zm = (ez[k] + ez[k + 1]) / 2, act = E.items.filter((x) => x.z0 < zm && x.z1 > zm);
        if (act.length) other += (unionLoops(act.map((x) => rectOf(x.base))).area * (ez[k + 1] - ez[k])) / 1e9;
      }
    } else other = sweepVolume(E.bodies, 32) / 1e9;
    check('earth:union', en ? 'Excavation: sum of the pits and trenches, overlaps once = volume of their union (m³)' : 'Đào đất: tổng các hố móng, rãnh giằng (chỗ giao tính một lần) = thể tích hợp của chúng (m³)', sum(E.items.map((x) => x.net)), other, tolE);
    const clip = prisms.filter((q) => !q.ground && q.z0 < ground - TOL).map((q) => ({ ...q, z1: Math.min(q.z1, ground) }));
    check('earth:buried', en ? 'Buried in the excavation: net volumes below the ground = union of the members cut at the ground (m³)' : 'Phần chiếm chỗ trong hố đào: tổng thể tích tịnh dưới mặt đất = thể tích hợp các cấu kiện cắt tại mặt đất (m³)', buried, unionVolume(clip), 1e-6);
    const bodies = clip.map((q) => ({ z0: q.z0, z1: q.z1, sloped: false, at: () => [{ profile: q.profile, holes: q.holes }] }));
    check('earth:inside', en ? 'Everything buried lies inside the excavation: union of the excavation and the buried members = the excavation (m³)' : 'Mọi cấu kiện chôn nằm trong hố đào: hợp của hố đào và cấu kiện chôn = thể tích đào (m³)', sweepVolume([...E.bodies, ...bodies]) / 1e9, E.total, tolE);
    if (earth?.space === undefined || earth?.slope === undefined) {
      assumed.push({
        item: 'earth', value: `space ${sp} mm, slope ${m}`,
        note: en ? `excavation: ${sp} of working space on every side of the lean concrete, ${m > 0 ? `sides sloped ${m} horizontal for 1 vertical` : 'vertical sides'}, a pit for every pad and a trench for every ground beam (overlaps counted once), by the design dimensions (no bulking); the soil the buried members displace is carted away`
          : `đào đất: lưu không ${sp} mỗi bên mép bê tông lót, ${m > 0 ? `mái dốc 1:${m} (ngang : đứng = ${m} : 1)` : 'thành hố đào thẳng đứng'}, đào từng hố móng và rãnh giằng (chỗ giao tính một lần), theo kích thước thiết kế (không tính hệ số nở rời); đất thừa bằng phần cấu kiện chiếm chỗ, vận chuyển đi`,
      });
    }
  }
  // the brick steps of the stairs against the treads of the flights (the granite of the architectural bill)
  const stepped = solids.filter((s) => s.kind === 'stair' && s.steps?.length);
  if (stepped.length) {
    check('steps', en ? 'Stair steps: steps x going x width = tread area of the flights (m²)' : 'Bậc thang: số bậc x mặt bậc x bề rộng vế = diện tích mặt bậc các vế thang (m²)',
      sum(stepped.flatMap((s) => s.steps.map((x) => x.n * x.tread))), sum(stepped.map((s) => s.treads)), 1e-3);
    assumed.push({ item: 'stair_steps', value: 'brick', note: en ? 'stair steps built in brick on the waist slabs (a step = going x riser / 2 x width)' : 'bậc thang xây gạch trên bản thang (một bậc = mặt bậc x cổ bậc / 2 x bề rộng vế)' });
  }
  return {
    rules: RS, solids, walls: wallRecs, openings: openRecs, plaster, union, sumNet, sumGross, sumCuts, checks, warnings, grid: { nx, ny, nz },
    earth: earthRec, ground, assumed: ['earth', 'ground_slab', 'stair_steps'].flatMap((k) => assumed.filter((x) => x.item === k)), options: { earth: EO ?? false, groundSlab: GO ?? false },
  };
}
