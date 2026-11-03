// Elevations and sections derived from the same plan description as draw_plan (walls, openings, columns, grids, rooms)
// plus heights and roofs, so plan, elevations and sections always agree. Pure geometry (mm, levels relative to the
// finished floor ±0.000): returns draw_entities specs for the bridge.
//   - view space: the viewer looks along v; u = horizontal position (to the viewer's right), w = depth (away from viewer)
//   - visibility: the nearest wall/column face wins along u; roofs, columns and facade pieces hide what is behind them
//     (line segments are clipped against the convex silhouettes of every nearer element)
import { buildWalls, findSegment, gridList, num, openingSpan, PlanError, pt, rectAround, segRect } from './plan.mjs';
import { dimStyleName, ROLE, TEXT_STYLE } from './standards.mjs';

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a); return l < 1e-9 ? [0, 0] : [a[0] / l, a[1] / l]; };
const left = (d) => [-d[1], d[0]];
const r3 = (v) => Math.round(v * 1000) / 1000;
const P = (p) => [r3(p[0]), r3(p[1])];
const dist = (a, b) => len(sub(a, b));
const DEG = Math.PI / 180;

export const HEIGHT_DEFAULTS = { ground: -450, floor: 0, top: 3600, door_head: 2400, window_sill: 900, window_head: 2400, slab: 100 };
export const FOUNDATION_DEFAULTS = { depth: 1500, width: 900, height: 350, lean: 100 };
export const SIDES = { bottom: [0, 1], top: [0, -1], left: [1, 0], right: [-1, 0] };

const L = {
  outline: ROLE.elevation_outline, line: ROLE.elevation, cut: ROLE.section, cutHatch: ROLE.section_hatch,
  dims: ROLE.dims, symbol: ROLE.symbol, text: ROLE.text, grid: ROLE.grid, gridTag: ROLE.grid_tag, glass: ROLE.window,
};

// ---------------------------------------------------------------- building model

function heightsOf(spec) {
  const src = spec.heights || {};
  const h = { ...HEIGHT_DEFAULTS };
  for (const k of Object.keys(HEIGHT_DEFAULTS)) if (src[k] !== undefined) h[k] = num(src[k], `heights.${k}`);
  h.foundation = { ...FOUNDATION_DEFAULTS };
  for (const k of Object.keys(FOUNDATION_DEFAULTS)) if (src.foundation?.[k] !== undefined) h.foundation[k] = num(src.foundation[k], `heights.foundation.${k}`, { min: 0 });
  h.walls_to_roof = src.walls_to_roof ?? 'end'; // 'end': gable-end walls rise to the roof; 'all': every wall across the ridge (tường thu hồi)
  if (h.top <= h.floor) throw new PlanError('heights.top must be above heights.floor');
  return h;
}

export function buildModel(spec) {
  const walls = buildWalls(spec);
  if (!walls.length) throw new PlanError('the plan has no walls: elevations and sections need the walls of the plan');
  const H = heightsOf(spec);
  for (const w of walls) {
    const hgt = spec.walls?.[w.index]?.height;
    if (hgt !== undefined && hgt !== null) w.height = num(hgt, `walls[${w.index}].height`, { positive: true });
  }
  const openings = (spec.openings || []).map((o, i) => {
    const name = `openings[${i}]`;
    const { s } = findSegment(walls, o, name);
    const span = openingSpan(s, o, name);
    const type = o.type ?? 'door';
    const isWin = type === 'window';
    const sill = num(o.sill ?? (isWin ? H.window_sill : H.floor), `${name}.sill`);
    const head = num(o.head ?? (isWin ? H.window_head : H.door_head), `${name}.head`);
    if (head <= sill) throw new PlanError(`${name}: head must be above sill`);
    return { s, span, type, sill, head, tag: o.tag };
  });
  const colSpecs = [...(spec.columns || [])];
  const grids = { x: gridList(spec.grids?.x, 'x'), y: gridList(spec.grids?.y, 'y') };
  if (spec.grid_columns) for (const gx of grids.x) for (const gy of grids.y) colSpecs.push({ at: [gx.at, gy.at], ...spec.grid_columns });
  const columns = colSpecs.map((c, i) => {
    const at = pt(c.at, `columns[${i}].at`);
    const size = c.diameter ? [c.diameter, c.diameter] : Array.isArray(c.size) ? c.size : [c.size ?? 400, c.size ?? 400];
    return { poly: rectAround(at, num(size[0], 'size'), num(size[1], 'size'), c.rotation ?? 0), top: c.height ?? H.top };
  });
  const pts = walls.flatMap((w) => w.segs.flatMap((s) => segRect(s)));
  const bbox = {
    x0: Math.min(...pts.map((p) => p[0])), x1: Math.max(...pts.map((p) => p[0])),
    y0: Math.min(...pts.map((p) => p[1])), y1: Math.max(...pts.map((p) => p[1])),
  };
  const roofSpecs = spec.roofs ?? [{ type: 'gable', ridge: bbox.x1 - bbox.x0 >= bbox.y1 - bbox.y0 ? 'x' : 'y' }];
  const assumed = heightAssumptions(spec);
  if (!spec.roofs) assumed.push({ item: 'roofs', value: `gable over the whole building, ridge along ${roofSpecs[0].ridge}` });
  const roofs = roofSpecs.map((r, i) => {
    const name = `roofs[${i}]`;
    const type = r.type ?? 'gable';
    const defs = type === 'flat' ? [['thickness', 120], ['parapet', 600]] : [['pitch', 30], ['overhang', 500], ['thickness', 150]];
    for (const [k, v] of defs) if (r[k] === undefined) assumed.push({ item: `${name}.${k}`, value: v });
    if (!['gable', 'flat'].includes(type)) throw new PlanError(`${name}.type must be gable or flat`);
    const reg = r.region ? [pt(r.region[0], `${name}.region[0]`), pt(r.region[1], `${name}.region[1]`)] : [[bbox.x0, bbox.y0], [bbox.x1, bbox.y1]];
    return {
      type, ridge: r.ridge === 'x' ? 'x' : r.ridge === 'y' ? 'y' : (Math.abs(reg[1][0] - reg[0][0]) >= Math.abs(reg[1][1] - reg[0][1]) ? 'x' : 'y'),
      pitch: num(r.pitch ?? (type === 'flat' ? 0 : 30), `${name}.pitch`, { min: 0 }),
      overhang: num(r.overhang ?? (type === 'flat' ? 0 : 500), `${name}.overhang`, { min: 0 }),
      thickness: num(r.thickness ?? (type === 'flat' ? 120 : 150), `${name}.thickness`, { positive: true }),
      parapet: num(r.parapet ?? (type === 'flat' ? 600 : 0), `${name}.parapet`, { min: 0 }),
      base: num(r.base ?? H.top, `${name}.base`),
      region: [[Math.min(reg[0][0], reg[1][0]), Math.min(reg[0][1], reg[1][1])], [Math.max(reg[0][0], reg[1][0]), Math.max(reg[0][1], reg[1][1])]],
    };
  });
  return { walls, H, openings, columns, grids, roofs, bbox, rooms: spec.rooms || [], assumed };
}

/** Heights taken from HEIGHT_DEFAULTS because the description does not give them (only those the drawing uses). */
function heightAssumptions(spec) {
  const src = spec.heights || {};
  const ops = spec.openings || [];
  const wins = ops.filter((o) => o.type === 'window');
  const doors = ops.filter((o) => o.type !== 'window');
  const used = {
    ground: true, floor: true, top: true, slab: true,
    door_head: doors.some((o) => o.head === undefined),
    window_sill: wins.some((o) => o.sill === undefined),
    window_head: wins.some((o) => o.head === undefined),
  };
  const out = Object.entries(HEIGHT_DEFAULTS).filter(([k]) => used[k] && src[k] === undefined).map(([k, v]) => ({ item: `heights.${k}`, value: v }));
  if (src.walls_to_roof === undefined && (spec.roofs ?? [{}]).some((r) => (r.type ?? 'gable') === 'gable')) {
    out.push({ item: 'heights.walls_to_roof', value: 'end', note: 'only the gable-end walls rise to the roof' });
  }
  return out;
}

/** Foundation sizes taken from FOUNDATION_DEFAULTS (sections only). */
function foundationAssumptions(spec) {
  const src = spec.heights?.foundation || {};
  return Object.entries(FOUNDATION_DEFAULTS).filter(([k]) => src[k] === undefined).map(([k, v]) => ({ item: `heights.foundation.${k}`, value: v }));
}

function viewOf(v) {
  const r = [v[1], -v[0]];
  return { v, r, u: (p) => dot(p, r), w: (p) => dot(p, v) };
}

/** Height of the roof underside above a plan point (gable or flat roofs covering it), or null. */
function roofUnderside(M, p) {
  let best = null;
  for (const R of M.roofs) {
    const [[x0, y0], [x1, y1]] = R.region;
    const ov = R.overhang;
    if (p[0] < x0 - ov - 1 || p[0] > x1 + ov + 1 || p[1] < y0 - ov - 1 || p[1] > y1 + ov + 1) continue;
    let h;
    if (R.type === 'flat') h = R.base;
    else {
      const tan = Math.tan(R.pitch * DEG);
      const half = R.ridge === 'x' ? (y1 - y0) / 2 : (x1 - x0) / 2;
      const off = R.ridge === 'x' ? Math.abs(p[1] - (y0 + y1) / 2) : Math.abs(p[0] - (x0 + x1) / 2);
      h = R.base + (half - off) * tan - R.thickness / Math.cos(R.pitch * DEG);
    }
    if (best === null || h > best) best = h;
  }
  return best;
}

/** Top of a wall at a point of its axis: gable walls (across the ridge) rise to the roof underside. */
function wallTopAt(M, s, p) {
  let top = M.walls[s.wall].height ?? M.H.top;
  for (const R of M.roofs) {
    if (R.type !== 'gable') continue;
    const ridgeDir = R.ridge === 'x' ? [1, 0] : [0, 1];
    if (Math.abs(dot(ridgeDir, s.d)) > 0.5) continue; // wall along the ridge: eave wall
    const [[x0, y0], [x1, y1]] = R.region;
    const inside = p[0] >= x0 - 1 && p[0] <= x1 + 1 && p[1] >= y0 - 1 && p[1] <= y1 + 1;
    if (!inside) continue;
    const edge = R.ridge === 'x' ? Math.min(Math.abs(p[0] - x0), Math.abs(p[0] - x1)) : Math.min(Math.abs(p[1] - y0), Math.abs(p[1] - y1));
    if (M.H.walls_to_roof === 'end' && edge > (s.o2 - s.o1) + 1) continue;
    const u = roofUnderside(M, p);
    if (u !== null && u > top) top = u;
  }
  return top;
}

// ---------------------------------------------------------------- faces and visibility

/** How far a wall face reaches past its axis end into the walls that meet it there (outer corner of an L). */
function endExtension(M, s, p) {
  let e = 0;
  for (const w of M.walls) for (const o of w.segs) {
    if (o === s || Math.abs(cross(o.d, s.d)) < 0.1) continue;
    let touches = dist(o.a, p) < 1 || dist(o.b, p) < 1;
    if (!touches) {
      const t = dot(sub(p, o.a), o.d);
      touches = t > 0 && t < o.L && Math.abs(cross(o.d, sub(p, o.a))) < 1;
    }
    if (touches) e = Math.max(e, Math.abs(o.o1), Math.abs(o.o2));
  }
  return e;
}

/** Wall and column faces turned towards the viewer, in view coordinates. beyond: only faces farther than that depth. */
function faceCandidates(M, V, beyond = -Infinity) {
  const out = [];
  for (const w of M.walls) for (const s of w.segs) {
    const n = left(s.d);
    for (const o of [s.o1, s.o2]) {
      const normal = o === s.o2 ? n : mul(n, -1);
      if (dot(normal, V.v) > -1e-6) continue;
      const ea = endExtension(M, s, s.a);
      const eb = endExtension(M, s, s.b);
      const A = add(add(s.a, mul(n, o)), mul(s.d, -ea));
      const B = add(add(s.b, mul(n, o)), mul(s.d, eb));
      const ua = V.u(A), ub = V.u(B), wa = V.w(A), wb = V.w(B);
      if (Math.abs(ub - ua) < 1 || Math.min(wa, wb) <= beyond + 1) continue;
      out.push(face('wall', ua, wa, ub, wb, { s, o, top: w.height ?? M.H.top }));
    }
  }
  for (const c of M.columns) {
    const poly = c.poly;
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length];
      const e = sub(B, A);
      // rectAround is counter-clockwise: the outward normal is on the right of each edge
      const normal = unit([e[1], -e[0]]);
      if (dot(normal, V.v) > -1e-6) continue;
      const ua = V.u(A), ub = V.u(B), wa = V.w(A), wb = V.w(B);
      if (Math.abs(ub - ua) < 1 || Math.min(wa, wb) <= beyond + 1) continue;
      out.push(face('column', ua, wa, ub, wb, { top: c.top }));
    }
  }
  return out;
}

function face(kind, ua, wa, ub, wb, extra) {
  const [u0, w0, u1, w1] = ua <= ub ? [ua, wa, ub, wb] : [ub, wb, ua, wa];
  return { kind, u0, u1, wAt: (u) => w0 + ((w1 - w0) * (u - u0)) / (u1 - u0 || 1), ...extra };
}

/** Nearest face along u: [{u0, u1, c, depth}], consecutive intervals of the same face merged. */
function visiblePieces(cands, uMin = -Infinity, uMax = Infinity) {
  const xs = [...new Set(cands.flatMap((c) => [c.u0, c.u1]).map(r3))].filter((x) => x >= uMin - 1e-6 && x <= uMax + 1e-6);
  if (Number.isFinite(uMin)) xs.push(uMin);
  if (Number.isFinite(uMax)) xs.push(uMax);
  xs.sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    if (b - a < 0.5 || a < uMin - 1e-6 || b > uMax + 1e-6) continue;
    const m = (a + b) / 2;
    let best = null, bd = Infinity;
    for (const c of cands) {
      if (c.u0 > m || c.u1 < m) continue;
      const d = c.wAt(m);
      if (d < bd - 1e-6) { bd = d; best = c; }
    }
    if (!best) continue;
    const last = pieces[pieces.length - 1];
    if (last && last.c === best && Math.abs(last.u1 - a) < 1e-6) last.u1 = b;
    else pieces.push({ u0: a, u1: b, c: best });
  }
  for (const p of pieces) p.depth = Math.min(p.c.wAt(p.u0), p.c.wAt(p.u1));
  return pieces;
}

// ---------------------------------------------------------------- hidden-line clipping

const EPS_IN = 0.5; // a line lying on a silhouette edge stays visible

function ccw(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) a += cross(poly[i], poly[(i + 1) % poly.length]);
  return a >= 0 ? poly : [...poly].reverse();
}

/** Parameter interval [t0, t1] of segment a-b strictly inside a convex polygon, or null. */
function insideInterval(a, b, poly) {
  let t0 = 0, t1 = 1;
  const d = sub(b, a);
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const e = sub(q, p);
    const el = len(e);
    if (el < 1e-9) continue;
    const nn = [-e[1] / el, e[0] / el]; // inward normal of a counter-clockwise polygon
    const k = dot(sub(a, p), nn) - EPS_IN;
    const den = dot(d, nn);
    if (Math.abs(den) < 1e-12) {
      if (k < 0) return null;
      continue;
    }
    const t = -k / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

function clipSegment(a, b, polys) {
  let parts = [[0, 1]];
  for (const poly of polys) {
    const iv = insideInterval(a, b, poly);
    if (!iv) continue;
    const next = [];
    for (const [s, e] of parts) {
      if (iv[1] <= s || iv[0] >= e) { next.push([s, e]); continue; }
      if (iv[0] > s) next.push([s, iv[0]]);
      if (iv[1] < e) next.push([iv[1], e]);
    }
    parts = next;
    if (!parts.length) break;
  }
  const d = sub(b, a);
  return parts.filter(([s, e]) => (e - s) * len(d) > 1).map(([s, e]) => [add(a, mul(d, s)), add(a, mul(d, e))]);
}

/** Far-to-near: every element's lines minus the silhouettes of all nearer elements; duplicates removed. */
function hiddenLines(elements) {
  const out = [];
  const seen = new Map();
  for (const el of elements) {
    const nearer = elements.filter((o) => o !== el && o.sil && o.depth < el.depth - 1).map((o) => o.sil);
    for (const sg of el.segs) {
      for (const [a, b] of clipSegment(sg.a, sg.b, nearer)) {
        const k1 = `${r3(a[0])},${r3(a[1])}`, k2 = `${r3(b[0])},${r3(b[1])}`;
        const key = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
        const prev = seen.get(key);
        if (prev) {
          if (sg.layer === L.outline || sg.layer === L.cut) prev.layer = sg.layer; // the heavier line wins
          continue;
        }
        const rec = { a, b, layer: sg.layer };
        seen.set(key, rec);
        out.push(rec);
      }
    }
  }
  return out;
}

const rectPoly = (u0, y0, u1, y1) => ccw([[u0, y0], [u1, y0], [u1, y1], [u0, y1]]);
const segsOfPoly = (poly, layer, closed = true) => {
  const s = [];
  for (let i = 0; i < poly.length - (closed ? 0 : 1); i++) s.push({ a: poly[i], b: poly[(i + 1) % poly.length], layer });
  return s;
};

// ---------------------------------------------------------------- roofs

function roofElement(R, V) {
  const cs = [R.region[0], [R.region[1][0], R.region[0][1]], R.region[1], [R.region[0][0], R.region[1][1]]];
  const us = cs.map(V.u), ws = cs.map(V.w);
  const u0 = Math.min(...us), u1 = Math.max(...us), w0 = Math.min(...ws), w1 = Math.max(...ws);
  const ov = R.overhang, t = R.thickness;
  const ridgeDir = R.ridge === 'x' ? [1, 0] : [0, 1];
  const alongU = Math.abs(dot(ridgeDir, V.r)) > 0.5;
  const segs = [];
  const extra = [];
  let sil;
  let topY;
  if (R.type === 'flat') {
    topY = R.base + t + R.parapet;
    sil = rectPoly(u0 - ov, R.base, u1 + ov, topY);
    segs.push(...segsOfPoly(sil, L.outline));
    if (R.parapet > 0) segs.push({ a: [u0 - ov, R.base + t], b: [u1 + ov, R.base + t], layer: L.line });
  } else {
    const tan = Math.tan(R.pitch * DEG);
    const tv = t / Math.cos(R.pitch * DEG);
    const eaveY = R.base - ov * tan;
    if (alongU) {
      // Eaves side: the slope seen from the front, tile ribs every 300 mm.
      topY = R.base + ((w1 - w0) / 2) * tan;
      sil = rectPoly(u0 - ov, eaveY, u1 + ov, topY);
      segs.push(...segsOfPoly(sil, L.outline));
      segs.push({ a: [u0 - ov, eaveY + tv], b: [u1 + ov, eaveY + tv], layer: L.line });
      for (let u = u0 - ov + 300; u < u1 + ov - 150; u += 300) segs.push({ a: [u, eaveY + tv], b: [u, topY], layer: L.line });
    } else {
      // Gable end: the verge triangle, fascia drawn as the parallel inner line.
      // Gable end: only the verge boards stand in front (two bands); the triangle below them is the gable wall or
      // cladding, in the plane of the wall: it hides what is behind it but not the wall itself.
      const um = (u0 + u1) / 2;
      topY = R.base + ((u1 - u0) / 2) * tan;
      const dx = tan > 1e-6 ? tv / tan : 0;
      segs.push({ a: [u0 - ov, eaveY], b: [um, topY], layer: L.outline }, { a: [um, topY], b: [u1 + ov, eaveY], layer: L.outline });
      segs.push({ a: [u0 - ov + dx, eaveY], b: [um, topY - tv], layer: L.line }, { a: [um, topY - tv], b: [u1 + ov - dx, eaveY], layer: L.line });
      segs.push({ a: [u0 - ov, eaveY], b: [u0 - ov + dx, eaveY], layer: L.outline }, { a: [u1 + ov - dx, eaveY], b: [u1 + ov, eaveY], layer: L.outline });
      sil = ccw([[u0 - ov, eaveY], [um, topY], [um, topY - tv], [u0 - ov + dx, eaveY]]);
      extra.push({ depth: w0 - ov, sil: ccw([[um, topY], [u1 + ov, eaveY], [u1 + ov - dx, eaveY], [um, topY - tv]]), segs: [] });
      const yIn = (u) => topY - tv - Math.abs(u - um) * tan;
      if (yIn(u0) < R.base) extra.push({ depth: w0, sil: ccw([[u0, yIn(u0)], [u1, yIn(u1)], [um, topY - tv]]), segs: [] });
      else extra.push({ depth: w0, sil: ccw([[u0, R.base], [u1, R.base], [u1, yIn(u1)], [um, topY - tv], [u0, yIn(u0)]]), segs: [] });
    }
  }
  const main = { depth: w0 - ov, sil, segs };
  return { els: [main, ...extra], depth: w0 - ov, sil, segs, topY, u0: u0 - ov, u1: u1 + ov, alongU, w0, w1, R };
}

// ---------------------------------------------------------------- shared annotation

function levelMark(x, y, value, scale, out) {
  const s = 3 * scale;
  out.push({ type: 'polyline', points: [P([x, y]), P([x - s / 2, y + s * 0.85]), P([x + s / 2, y + s * 0.85])], closed: true, layer: L.symbol });
  out.push({ type: 'line', from: P([x - s / 2, y + s * 0.85]), to: P([x + s * 4, y + s * 0.85]), layer: L.symbol });
  out.push({ type: 'text', text: value, at: P([x + s * 0.7, y + s * 1.1]), height: 2.5 * scale, layer: L.symbol, style: TEXT_STYLE });
}

export const fmtLevel = (mm) => (Math.abs(mm) < 0.5 ? '±0.000' : `${mm > 0 ? '+' : '-'}${(Math.abs(mm) / 1000).toFixed(3)}`);

function gridMarks(M, V, X, y0, scale, out, uFilter) {
  const r = 4.5 * scale;
  const list = [];
  for (const g of M.grids.x) list.push({ label: g.label, p: [g.at, 0], d: [0, 1] });
  for (const g of M.grids.y) list.push({ label: g.label, p: [0, g.at], d: [1, 0] });
  const marks = list.filter((g) => Math.abs(cross(g.d, V.v)) < 0.01).map((g) => ({ label: g.label, u: V.u(g.p) }))
    .filter((g) => !uFilter || uFilter(g.u)).sort((a, b) => a.u - b.u);
  for (const g of marks) {
    out.push({ type: 'line', from: P([X(g.u), y0 + 3 * scale]), to: P([X(g.u), y0 - 2 * r]), layer: L.grid });
    out.push({ type: 'circle', center: P([X(g.u), y0 - 3 * r]), radius: r, layer: L.gridTag });
    out.push({ type: 'text', at: P([X(g.u), y0 - 3 * r]), text: g.label, height: 4 * scale, align: 'middle_center', layer: L.gridTag, style: TEXT_STYLE });
  }
  if (marks.length >= 2) {
    out.push({
      type: 'dim_chain', points: marks.map((g) => P([X(g.u), y0])), direction: 'horizontal', at: P([X(marks[0].u), y0 - 0.5 * r]),
      style: dimStyleName(scale), layer: L.dims,
    });
  }
  return marks;
}

function titleBlock(text, cx, y, scale, out) {
  out.push({ type: 'text', text, at: P([cx, y]), height: 5 * scale, align: 'center', layer: L.text, style: TEXT_STYLE });
  out.push({ type: 'text', text: `TỶ LỆ 1:${scale}`, at: P([cx, y - 7 * scale]), height: 3 * scale, align: 'center', layer: L.text, style: TEXT_STYLE });
}

function segEntities(lines) {
  return lines.map((l) => ({ type: 'line', from: P(l.a), to: P(l.b), layer: l.layer }));
}

function openingLines(op, uA, uB, sillY, headY, layer) {
  const s = [];
  const add4 = (a, b, c, d) => s.push(...segsOfPoly([[a, b], [c, b], [c, d], [a, d]], layer));
  add4(uA, sillY, uB, headY);
  const f = Math.min(50, (uB - uA) / 10);
  add4(uA + f, sillY + (op.type === 'window' ? f : 0), uB - f, headY - f);
  const w = uB - uA;
  if (op.type === 'window') {
    if (w > 900) s.push({ a: [(uA + uB) / 2, sillY + f], b: [(uA + uB) / 2, headY - f], layer });
    if (headY - sillY > 1500) s.push({ a: [uA + f, headY - 450], b: [uB - f, headY - 450], layer });
    add4(uA - 60, sillY - 50, uB + 60, sillY);
  } else if (op.type === 'double_door' || op.type === 'sliding') {
    s.push({ a: [(uA + uB) / 2, sillY], b: [(uA + uB) / 2, headY - f], layer });
  }
  return s;
}

// ---------------------------------------------------------------- elevation

/**
 * Elevation of one side of the plan: side bottom|top|left|right (the viewer stands on that side of the plan and
 * looks at the building), at = drawing point of the left end of the facade at level ±0.000.
 */
export function buildElevation(spec, opts = {}) {
  const M = buildModel(spec);
  const scale = num(opts.scale ?? spec.scale ?? 100, 'scale', { positive: true });
  const side = opts.side ?? 'bottom';
  if (!SIDES[side]) throw new PlanError('side must be bottom, top, left or right (the side of the plan the viewer stands on)');
  const V = viewOf(SIDES[side]);
  const H = M.H;
  const pieces = visiblePieces(faceCandidates(M, V));
  if (!pieces.length) throw new PlanError('no wall faces this side');
  const roofs = M.roofs.map((R) => roofElement(R, V));
  const uMin = Math.min(...pieces.map((p) => p.u0));
  const uMax = Math.max(...pieces.map((p) => p.u1));
  const at = opts.at ? pt(opts.at, 'at') : [0, 0];
  const X = (u) => at[0] + (u - uMin);
  const Y = (y) => at[1] + y;
  const elements = [];

  // Facade pieces (walls and columns) with their openings.
  for (const pc of pieces) {
    const top = pc.c.top;
    const gableEnd = pc.c.kind === 'wall' && roofs.some((rf) => !rf.alongU && rf.R.type === 'gable' && Math.abs(pc.depth - rf.w0) <= (pc.c.s.o2 - pc.c.s.o1) + 1);
    const segs = [
      { a: [pc.u0, H.ground], b: [pc.u0, top], layer: L.outline },
      { a: [pc.u1, H.ground], b: [pc.u1, top], layer: L.outline },
    ];
    if (pc.c.kind === 'wall') segs.push({ a: [pc.u0, H.floor], b: [pc.u1, H.floor], layer: L.line }); // plinth line
    if (!gableEnd) segs.push({ a: [pc.u0, top], b: [pc.u1, top], layer: L.outline });
    elements.push({ depth: pc.depth, sil: rectPoly(pc.u0, H.ground, pc.u1, top), segs });
    if (pc.c.kind !== 'wall') continue;
    for (const op of M.openings.filter((o) => o.s === pc.c.s)) {
      const ua = V.u(add(op.s.a, mul(op.s.d, op.span.from)));
      const ub = V.u(add(op.s.a, mul(op.s.d, op.span.to)));
      const uA = Math.max(Math.min(ua, ub), pc.u0), uB = Math.min(Math.max(ua, ub), pc.u1);
      if (uB - uA < 10) continue;
      elements.push({ depth: pc.depth - 0.01, segs: openingLines(op, uA, uB, op.sill, op.head, L.line) });
    }
  }
  for (const rf of roofs) elements.push(...rf.els);
  elements.sort((a, b) => b.depth - a.depth);

  const ents = [];
  for (const l of hiddenLines(elements)) ents.push({ type: 'line', from: P([X(l.a[0]), Y(l.a[1])]), to: P([X(l.b[0]), Y(l.b[1])]), layer: l.layer });

  // Ground line with earth hatch.
  const uLo = Math.min(uMin, ...roofs.map((r) => r.u0)), uHi = Math.max(uMax, ...roofs.map((r) => r.u1));
  ents.push({ type: 'line', from: P([X(uLo) - 1000, Y(H.ground)]), to: P([X(uHi) + 1000, Y(H.ground)]), layer: L.outline });
  ents.push({
    type: 'hatch', boundary: [P([X(uLo) - 1000, Y(H.ground)]), P([X(uHi) + 1000, Y(H.ground)]), P([X(uHi) + 1000, Y(H.ground) - 2 * scale]), P([X(uLo) - 1000, Y(H.ground) - 2 * scale])],
    pattern: 'EARTH', scale: 0.15 * scale, layer: L.cutHatch,
  });

  // Levels (right) and the height chain (left).
  const ridge = Math.max(...roofs.map((r) => r.topY), ...pieces.map((p) => p.c.top));
  const visibleOps = M.openings.filter((o) => pieces.some((p) => p.c.s === o.s));
  const win = visibleOps.find((o) => o.type === 'window');
  const heights = [H.ground, H.floor, ...(win ? [win.sill, win.head] : []), H.top, ridge];
  const uniq = [...new Set(heights.map((v) => Math.round(v)))].sort((a, b) => a - b);
  const xr = X(uHi) + 8 * scale;
  for (const lv of uniq) levelMark(xr, Y(lv), fmtLevel(lv), scale, ents);
  ents.push({
    type: 'dim_chain', points: uniq.map((lv) => P([X(uLo), Y(lv)])), direction: 'vertical', at: P([X(uLo) - 12 * scale, Y(uniq[0])]),
    style: dimStyleName(scale), layer: L.dims, total: uniq.length > 2,
  });
  const marks = gridMarks(M, V, X, Y(H.ground) - 10 * scale, scale, ents);
  const label = marks.length >= 2 ? ` TRỤC ${marks[0].label}-${marks[marks.length - 1].label}` : '';
  titleBlock(opts.title ?? `MẶT ĐỨNG${label}`, (X(uLo) + X(uHi)) / 2, Y(H.ground) - 10 * scale - 9 * 4.5 * scale - 8 * scale, scale, ents);
  return { entities: ents, extent: { min: [X(uLo) - 12 * scale - 10 * scale, Y(H.ground) - 90 * scale], max: [xr + 20 * scale, Y(ridge) + 5 * scale] }, levels: uniq, assumed: M.assumed };
}

// ---------------------------------------------------------------- section

/** Room whose label point is seen from p without crossing a wall axis (nearest first). */
function roomAt(M, p) {
  const segs = M.walls.flatMap((w) => w.segs);
  const crosses = (a, b) => segs.some((s) => {
    const d1 = cross(sub(b, a), sub(s.a, a)), d2 = cross(sub(b, a), sub(s.b, a));
    const d3 = cross(sub(s.b, s.a), sub(a, s.a)), d4 = cross(sub(s.b, s.a), sub(b, s.a));
    return d1 * d2 < 0 && d3 * d4 < 0;
  });
  return M.rooms
    .map((r) => ({ r, d: dist(pt(r.at, 'rooms.at'), p) }))
    .sort((a, b) => a.d - b.d)
    .find((x) => !crosses(p, pt(x.r.at, 'rooms.at')))?.r;
}

/**
 * Section along a cut line from -> to (as the plan's section mark), looking to its left (default) or right.
 * at = drawing point of the left end of the cut at level ±0.000.
 */
export function buildSection(spec, opts = {}) {
  const M = buildModel(spec);
  const scale = num(opts.scale ?? spec.scale ?? 100, 'scale', { positive: true });
  const a = pt(opts.from, 'from'), b = pt(opts.to, 'to');
  if (dist(a, b) < 1) throw new PlanError('from and to must differ');
  const d = unit(sub(b, a));
  const v = opts.look === 'right' ? mul(left(d), -1) : left(d);
  const V = viewOf(v);
  const H = M.H;
  const F = H.foundation;
  const wc = V.w(a);
  const cu0 = Math.min(V.u(a), V.u(b)), cu1 = Math.max(V.u(a), V.u(b));
  const at = opts.at ? pt(opts.at, 'at') : [0, 0];
  const cutEls = [];
  const fills = [];
  const cutWalls = [];

  // Walls crossing the cut.
  for (const w of M.walls) for (const s of w.segs) {
    const poly = segRect(s);
    const us = [];
    for (let i = 0; i < 4; i++) {
      const p = poly[i], q = poly[(i + 1) % 4];
      const wp = V.w(p) - wc, wq = V.w(q) - wc;
      if (Math.abs(wp) < 1e-9) us.push(V.u(p));
      if (wp * wq < 0) us.push(V.u(add(p, mul(sub(q, p), wp / (wp - wq)))));
    }
    if (us.length < 2) continue;
    const ua = Math.max(Math.min(...us), cu0), ub = Math.min(Math.max(...us), cu1);
    if (ub - ua < 1) continue;
    const wa = V.w(s.a), wb = V.w(s.b);
    if (Math.abs(wb - wa) < 1e-9) continue; // wall lying in the cut plane
    const along = ((wc - wa) / (wb - wa)) * s.L;
    const pAxis = add(s.a, mul(s.d, Math.max(0, Math.min(s.L, along))));
    const top = wallTopAt(M, s, pAxis);
    const op = M.openings.find((o) => o.s === s && along >= o.span.from - 0.5 && along <= o.span.to + 0.5);
    const base = -F.depth + F.height;
    const ranges = op ? [[base, op.type === 'window' ? op.sill : H.floor], [op.head, top]] : [[base, top]];
    for (const [y0, y1] of ranges) {
      if (y1 - y0 < 1) continue;
      const poly2 = rectPoly(ua, y0, ub, y1);
      cutEls.push({ depth: wc, sil: poly2, segs: segsOfPoly(poly2, L.cut) });
      fills.push({ type: 'hatch', boundary: poly2, pattern: 'ANSI31', scale: 0.6 * scale, layer: L.cutHatch });
    }
    if (op) {
      const lt = Math.min(200, top - op.head);
      if (lt > 50) fills.push({ type: 'hatch', boundary: rectPoly(ua, op.head, ub, op.head + lt), pattern: 'AR-CONC', scale: 0.05 * scale, layer: L.cutHatch });
      if (op.type === 'window') {
        const um = (ua + ub) / 2;
        for (const du of [-15, 15]) fills.push({ type: 'line', from: [um + du, op.sill], to: [um + du, op.head], layer: L.glass });
      }
    }
    cutWalls.push({ ua, ub, top, s });
    // Footing under the wall: lean concrete + footing.
    const cx = (ua + ub) / 2;
    const fw = Math.max(F.width, ub - ua);
    const foot = rectPoly(cx - fw / 2, -F.depth, cx + fw / 2, -F.depth + F.height);
    cutEls.push({ depth: wc, sil: foot, segs: segsOfPoly(foot, L.cut) });
    fills.push({ type: 'hatch', boundary: foot, pattern: 'AR-CONC', scale: 0.05 * scale, layer: L.cutHatch });
    if (F.lean > 0) {
      const lean = rectPoly(cx - fw / 2 - 100, -F.depth - F.lean, cx + fw / 2 + 100, -F.depth);
      cutEls.push({ depth: wc, segs: segsOfPoly(lean, L.line) });
      fills.push({ type: 'hatch', boundary: lean, pattern: 'AR-SAND', scale: 0.02 * scale, layer: L.cutHatch });
    }
  }
  if (!cutWalls.length) throw new PlanError('the cut line crosses no wall: put it across the building (the plan\'s section mark)');
  cutWalls.sort((p, q) => p.ua - q.ua);
  const uMin = cutWalls[0].ua, uMax = cutWalls[cutWalls.length - 1].ub;

  // Floor slab and fill between the walls.
  for (let i = 0; i + 1 < cutWalls.length; i++) {
    const u0 = cutWalls[i].ub, u1 = cutWalls[i + 1].ua;
    if (u1 - u0 < 10) continue;
    const slab = rectPoly(u0, H.floor - H.slab, u1, H.floor);
    cutEls.push({ depth: wc, sil: slab, segs: segsOfPoly(slab, L.cut) });
    fills.push({ type: 'hatch', boundary: slab, pattern: 'AR-CONC', scale: 0.05 * scale, layer: L.cutHatch });
    if (H.floor - H.slab > H.ground + 10) {
      fills.push({ type: 'hatch', boundary: rectPoly(u0, H.ground, u1, H.floor - H.slab), pattern: 'AR-SAND', scale: 0.03 * scale, layer: L.cutHatch });
    }
  }

  // Roof cut by the plane.
  let roofTop = Math.max(...cutWalls.map((c) => c.top));
  for (const R of M.roofs) {
    const rf = roofElement(R, V);
    if (wc < rf.w0 - R.overhang || wc > rf.w1 + R.overhang) continue;
    const tan = Math.tan(R.pitch * DEG), tv = R.thickness / Math.cos(R.pitch * DEG);
    const u0 = Math.max(rf.u0, cu0 - R.overhang), u1 = Math.min(rf.u1, cu1 + R.overhang);
    if (R.type === 'flat') {
      const slab = rectPoly(u0, R.base, u1, R.base + R.thickness);
      cutEls.push({ depth: wc, sil: slab, segs: segsOfPoly(slab, L.cut) });
      fills.push({ type: 'hatch', boundary: slab, pattern: 'AR-CONC', scale: 0.05 * scale, layer: L.cutHatch });
      if (R.parapet > 0) for (const cw of [cutWalls[0], cutWalls[cutWalls.length - 1]]) {
        const par = rectPoly(cw.ua, R.base + R.thickness, cw.ub, R.base + R.thickness + R.parapet);
        cutEls.push({ depth: wc, sil: par, segs: segsOfPoly(par, L.cut) });
        fills.push({ type: 'hatch', boundary: par, pattern: 'ANSI31', scale: 0.6 * scale, layer: L.cutHatch });
      }
      roofTop = Math.max(roofTop, R.base + R.thickness + R.parapet);
    } else if (rf.alongU) {
      // The plane runs parallel to the ridge: the roof is cut along one height.
      const wm = (rf.w0 + rf.w1) / 2;
      const h = R.base + ((rf.w1 - rf.w0) / 2 - Math.abs(wc - wm)) * tan;
      const band = rectPoly(u0, h - tv, u1, h);
      cutEls.push({ depth: wc, sil: band, segs: segsOfPoly(band, L.cut) });
      fills.push({ type: 'hatch', boundary: band, pattern: 'SOLID', layer: L.cutHatch });
      roofTop = Math.max(roofTop, h);
    } else {
      // The plane runs across the ridge: both slopes in profile.
      const um = (rf.u0 + rf.u1) / 2;
      const eaveY = R.base - R.overhang * tan;
      const topY = R.base + ((rf.u1 - rf.u0 - 2 * R.overhang) / 2) * tan;
      for (const [pa, pb] of [[[rf.u0, eaveY], [um, topY]], [[um, topY], [rf.u1, eaveY]]]) {
        const quad = ccw([pa, pb, [pb[0], pb[1] - tv], [pa[0], pa[1] - tv]]);
        cutEls.push({ depth: wc, sil: quad, segs: segsOfPoly(quad, L.cut) });
        fills.push({ type: 'hatch', boundary: quad, pattern: 'SOLID', layer: L.cutHatch });
      }
      roofTop = Math.max(roofTop, topY);
    }
  }

  // Porch: columns outside the cut walls stand on the floor slab, which runs out to their outer faces (cut when the
  // plane passes between the columns, else seen beyond), with the plinth face down to the ground.
  const edges = { lo: uMin, hi: uMax };
  for (const side of ['lo', 'hi']) {
    const cols = M.columns.filter((c) => (side === 'lo' ? Math.max(...c.poly.map(V.u)) < uMin : Math.min(...c.poly.map(V.u)) > uMax));
    if (!cols.length) continue;
    const us = cols.flatMap((c) => c.poly.map(V.u)), ws = cols.flatMap((c) => c.poly.map(V.w));
    const edge = side === 'lo' ? Math.min(...us) : Math.max(...us);
    const [p0, p1] = side === 'lo' ? [edge, uMin] : [uMax, edge];
    const slab = rectPoly(p0, H.floor - H.slab, p1, H.floor);
    if (wc >= Math.min(...ws) && wc <= Math.max(...ws)) {
      cutEls.push({ depth: wc, sil: slab, segs: segsOfPoly(slab, L.cut) });
      fills.push({ type: 'hatch', boundary: slab, pattern: 'AR-CONC', scale: 0.05 * scale, layer: L.cutHatch });
      if (H.floor - H.slab > H.ground + 10) {
        fills.push({ type: 'hatch', boundary: rectPoly(p0, H.ground, p1, H.floor - H.slab), pattern: 'AR-SAND', scale: 0.03 * scale, layer: L.cutHatch });
      }
    } else {
      cutEls.push({ depth: wc + 1, segs: [{ a: [p0, H.floor], b: [p1, H.floor], layer: L.line }] });
    }
    cutEls.push({ depth: wc, segs: [{ a: [edge, H.ground], b: [edge, H.floor], layer: L.cut }] });
    edges[side] = edge;
  }
  // The drawing spans the cut walls, the porch and the roofs cut by the plane (eaves overhangs).
  const cutRoofs = M.roofs.map((R) => roofElement(R, V)).filter((rf) => wc >= rf.w0 - rf.R.overhang && wc <= rf.w1 + rf.R.overhang);
  const uLo = Math.min(edges.lo, ...cutRoofs.map((rf) => Math.max(rf.u0, cu0 - rf.R.overhang)));
  const uHi = Math.max(edges.hi, ...cutRoofs.map((rf) => Math.min(rf.u1, cu1 + rf.R.overhang)));

  // What is seen beyond the cut: wall faces, columns and their openings (thin lines), hidden by the cut parts.
  const beyondPieces = visiblePieces(faceCandidates(M, V, wc), uLo, uHi);
  const beyondEls = [];
  for (const pc of beyondPieces) {
    const top = pc.c.top;
    const segs = [
      { a: [pc.u0, H.floor], b: [pc.u0, top], layer: L.line }, { a: [pc.u1, H.floor], b: [pc.u1, top], layer: L.line },
      { a: [pc.u0, top], b: [pc.u1, top], layer: L.line },
    ];
    beyondEls.push({ depth: pc.depth, sil: rectPoly(pc.u0, H.floor, pc.u1, top), segs });
    if (pc.c.kind !== 'wall') continue;
    for (const op of M.openings.filter((o) => o.s === pc.c.s)) {
      const ua = V.u(add(op.s.a, mul(op.s.d, op.span.from))), ub = V.u(add(op.s.a, mul(op.s.d, op.span.to)));
      const uA = Math.max(Math.min(ua, ub), pc.u0), uB = Math.min(Math.max(ua, ub), pc.u1);
      if (uB - uA >= 10) beyondEls.push({ depth: pc.depth - 0.01, segs: openingLines(op, uA, uB, op.sill, op.head, L.line) });
    }
  }
  const elements = [...beyondEls, ...cutEls].sort((p, q) => q.depth - p.depth);
  const X = (u) => at[0] + (u - uMin);
  const Y = (y) => at[1] + y;
  const ents = [];
  for (const l of hiddenLines(elements)) ents.push({ type: 'line', from: P([X(l.a[0]), Y(l.a[1])]), to: P([X(l.b[0]), Y(l.b[1])]), layer: l.layer });
  for (const f of fills) {
    if (f.type === 'hatch') ents.push({ ...f, boundary: f.boundary.map((q) => P([X(q[0]), Y(q[1])])) });
    else ents.push({ ...f, from: P([X(f.from[0]), Y(f.from[1])]), to: P([X(f.to[0]), Y(f.to[1])]) });
  }

  // Ground outside the building.
  for (const [g0, g1] of [[X(edges.lo) - 15 * scale, X(edges.lo)], [X(edges.hi), X(edges.hi) + 15 * scale]]) {
    ents.push({ type: 'line', from: P([g0, Y(H.ground)]), to: P([g1, Y(H.ground)]), layer: L.outline });
    ents.push({ type: 'hatch', boundary: [P([g0, Y(H.ground)]), P([g1, Y(H.ground)]), P([g1, Y(H.ground) - 2 * scale]), P([g0, Y(H.ground) - 2 * scale])], pattern: 'EARTH', scale: 0.15 * scale, layer: L.cutHatch });
  }

  // Room names between the cut walls, above the door and window heads (seen beyond) when there is room for them.
  const roomsOut = [];
  const headMax = Math.max(H.floor, ...M.openings.map((o) => o.head));
  const yRoom = H.top - headMax >= 4 * 2.5 * scale ? (headMax + H.top) / 2 : H.floor + 1400;
  for (let i = 0; i + 1 < cutWalls.length; i++) {
    const u0 = cutWalls[i].ub, u1 = cutWalls[i + 1].ua;
    if (u1 - u0 < 600) continue;
    const um = (u0 + u1) / 2;
    const pPlan = add(a, mul(V.r, um - V.u(a)));
    const room = roomAt(M, pPlan);
    if (!room) continue;
    roomsOut.push(room.name);
    ents.push({ type: 'text', text: String(room.name), at: P([X(um), Y(yRoom)]), height: 2.5 * scale, align: 'middle_center', layer: L.text, style: TEXT_STYLE });
  }

  // Levels, height chain, grids, title.
  const ops = M.openings.filter((o) => cutWalls.some((c) => c.s === o.s));
  const heights = [-F.depth, H.ground, H.floor, ...ops.map((o) => o.head), H.top, roofTop];
  const uniq = [...new Set(heights.map((x) => Math.round(x)))].sort((p, q) => p - q);
  const xr = Math.max(X(uMax) + 16 * scale, X(uHi) + 10 * scale);
  for (const lv of uniq.filter((x) => x >= H.ground - 1)) levelMark(xr, Y(lv), fmtLevel(lv), scale, ents);
  ents.push({
    type: 'dim_chain', points: uniq.map((lv) => P([X(uLo), Y(lv)])), direction: 'vertical', at: P([Math.min(X(uMin) - 18 * scale, X(uLo) - 10 * scale), Y(uniq[0])]),
    style: dimStyleName(scale), layer: L.dims, total: uniq.length > 2,
  });
  const yGrid = Y(-F.depth - F.lean) - 8 * scale;
  gridMarks(M, V, X, yGrid, scale, ents, (u) => u >= edges.lo - 1 && u <= edges.hi + 1);
  const label = opts.label ?? 'A';
  titleBlock(opts.title ?? `MẶT CẮT ${label}-${label}`, (X(uLo) + X(uHi)) / 2, yGrid - 9 * 4.5 * scale - 8 * scale, scale, ents);
  return { entities: ents, rooms: roomsOut, levels: uniq, cut_walls: cutWalls.length, assumed: [...M.assumed, ...foundationAssumptions(spec)] };
}
