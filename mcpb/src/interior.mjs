// Interior design drawings (mm): a furniture library (plan symbol, front and side view of every type), floor finish plans
// with the real tile/plank joints from a start point, reflected ceiling plans (levels, drop band with cove light,
// lights), interior elevations of each wall of a room (openings, joinery and furniture seen from the front or the side,
// wall finish joints, skirting, ceiling, dimensions, material notes), joinery details (kitchen run, wardrobe: front
// with its modules and a section through the carcass) and the finish / material schedule. Pure geometry: returns
// draw_entities specs. Material codes follow the SketchUp MCP tag standard: FL floor, SK skirting, WL wall, CL ceiling,
// JN built-in joinery, FN loose furniture, SN sanitary ware, EQ equipment, LT lighting.
import { buildModel } from './elevation.mjs';
import { num, PlanError, pt } from './plan.mjs';
import { dimStyleName, ROLE, TEXT_STYLE } from './standards.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const P = (p) => [r2(p[0]), r2(p[1])];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};
const DEG = Math.PI / 180;

export const IL = {
  furniture: ROLE.furniture, casework: ROLE.casework, fixture: ROLE.fixture, equipment: ROLE.equipment, hidden: ROLE.hidden,
  floor: ROLE.floor_hatch, ceiling: ROLE.ceiling, light: ROLE.light, strip: ROLE.light_strip, note: ROLE.note,
  elev: ROLE.elevation, elevOut: ROLE.elevation_outline, elevPatt: ROLE.elevation_hatch, cut: ROLE.section, cutPatt: ROLE.section_hatch,
  detail: ROLE.detail, detailCut: ROLE.detail_cut, detailPatt: ROLE.detail_hatch, dims: ROLE.dims, symbol: ROLE.symbol,
  text: ROLE.text, glass: ROLE.window, room: ROLE.room_tag,
};

// ---------------------------------------------------------------- entities and text

const lineE = (a, b, layer, extra) => ({ type: 'line', from: P(a), to: P(b), layer, ...(extra || {}) });
const polyE = (pts, closed, layer, extra) => ({ type: 'polyline', points: pts.map(P), closed, layer, ...(extra || {}) });
const rectE = (x0, y0, x1, y1, layer, extra) => polyE([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true, layer, extra);
const textE = (text, at, h, layer, align = 'left') => ({ type: 'text', text: String(text), at: P(at), height: r2(h), align, layer, style: TEXT_STYLE });
const HID = { scale_linetype: true };

/** Width of a single line of Arial text of cap height h (AutoCAD text height), slightly generous. */
export function textWidth(s, h) {
  let w = 0;
  for (const ch of String(s)) {
    if (ch === ' ') w += 0.39;
    else if (/[0-9]/.test(ch)) w += 0.78;
    else if (ch !== ch.toLowerCase()) w += 0.95;
    else if (ch !== ch.toUpperCase()) w += 0.72;
    else w += 0.5;
  }
  return w * h;
}

/** Code in a box (material / item tag). Returns its box [x0, y0, x1, y1]. */
function tagBox(text, at, h, layer, out) {
  const w = textWidth(text, h) + 1.2 * h, hh = 1.9 * h;
  const box = [at[0] - w / 2, at[1] - hh / 2, at[0] + w / 2, at[1] + hh / 2];
  out.push(rectE(box[0], box[1], box[2], box[3], layer));
  out.push(textE(text, at, h, layer, 'middle_center'));
  return box;
}

function title(text, x, y, sc, out, layer = IL.text) {
  out.push(textE(text, [x, y], 5 * sc, layer, 'center'));
  out.push(textE(`TỶ LỆ 1:${sc}`, [x, y - 7 * sc], 3 * sc, layer, 'center'));
}

const fmtM = (v, dec = 2) => v.toFixed(dec).replace('.', ',');

// ---------------------------------------------------------------- polygons

export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** Counter-clockwise outline without the closing point, repeated or collinear vertices. */
export function cleanPoly(points) {
  const p = points.map((q) => [Number(q[0]), Number(q[1])]);
  if (p.length > 1 && len(sub(p[0], p[p.length - 1])) < 1e-6) p.pop();
  for (let changed = true; changed && p.length > 3;) {
    changed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const u = sub(b, a), v = sub(c, b);
      if (len(u) < 1e-6 || (Math.abs(cross(u, v)) < 1e-6 * len(u) * len(v) && dot(u, v) > 0)) {
        p.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (polyArea(p) < 0) p.reverse();
  return p;
}

export function inside(q, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

export function centroid(poly) {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    x += (p[0] + q[0]) * f;
    y += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  return [x / (3 * a), y / (3 * a)];
}

const perimeter = (poly) => poly.reduce((s, p, i) => s + len(sub(poly[(i + 1) % poly.length], p)), 0);

/** Inward offset of a counter-clockwise outline by d (mitred corners); null when it collapses. */
export function offsetPoly(poly, d) {
  const n = poly.length;
  const lines = poly.map((a, i) => {
    const t = unit(sub(poly[(i + 1) % n], a));
    return { p: add(a, mul([-t[1], t[0]], d)), t };
  });
  const out = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i + n - 1) % n], L2 = lines[i];
    const den = cross(L1.t, L2.t);
    if (Math.abs(den) < 1e-9) {
      out.push(L2.p);
      continue;
    }
    out.push(add(L1.p, mul(L1.t, cross(sub(L2.p, L1.p), L2.t) / den)));
  }
  for (let i = 0; i < n; i++) {
    if (dot(sub(poly[(i + 1) % n], poly[i]), sub(out[(i + 1) % n], out[i])) <= 0) return null;
  }
  return polyArea(out) > 0 ? out : null;
}

/**
 * The outline without small steps (shorter than tol between two parallel edges, e.g. where a 200 wall meets a 100 one):
 * the shorter neighbour moves onto the line of the longer one. For offsets (ceiling bands); areas use the real outline.
 */
export function dejog(poly, tol = 150) {
  let p = poly.slice();
  for (let changed = true; changed && p.length > 4;) {
    changed = false;
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      if (len(sub(b, a)) >= tol) continue;
      const pa = p[(i + n - 1) % n], nb = p[(i + 2) % n];
      const tPrev = unit(sub(a, pa)), tNext = unit(sub(nb, b));
      if (dot(tPrev, tNext) < 0.999) continue;
      const nrm = [-tPrev[1], tPrev[0]];
      if (len(sub(a, pa)) >= len(sub(nb, b))) {
        const d = dot(sub(b, a), nrm);
        p[(i + 1) % n] = sub(b, mul(nrm, d));
        p[(i + 2) % n] = sub(nb, mul(nrm, d));
      } else {
        const d = dot(sub(a, b), nrm);
        p[i] = sub(a, mul(nrm, d));
        p[(i + n - 1) % n] = sub(pa, mul(nrm, d));
      }
      p = cleanPoly(p);
      changed = true;
      break;
    }
  }
  return p;
}

/** Pieces of segment a-b inside a polygon. */
export function clipSeg(a, b, poly) {
  const d = sub(b, a);
  const ts = [0, 1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], e = sub(poly[(i + 1) % poly.length], p);
    const den = cross(d, e);
    if (Math.abs(den) < 1e-12) continue;
    const t = cross(sub(p, a), e) / den, s = cross(sub(p, a), d) / den;
    if (t > 0 && t < 1 && s >= -1e-9 && s <= 1 + 1e-9) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (t1 - t0 < 1e-9) continue;
    if (inside(add(a, mul(d, (t0 + t1) / 2)), poly)) out.push([add(a, mul(d, t0)), add(a, mul(d, t1))]);
  }
  return out;
}

function boxInterval(a, b, [x0, y0, x1, y1]) {
  let t0 = 0, t1 = 1;
  const d = sub(b, a);
  for (const [p, q] of [[-d[0], a[0] - x0], [d[0], x1 - a[0]], [-d[1], a[1] - y0], [d[1], y1 - a[1]]]) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/** Segments minus the parts inside axis-aligned boxes [x0, y0, x1, y1] (labels, openings, furniture). */
export function cutBoxes(segs, boxes) {
  let out = segs;
  for (const bx of boxes) {
    const next = [];
    for (const [a, b] of out) {
      const iv = boxInterval(a, b, bx);
      if (!iv) {
        next.push([a, b]);
        continue;
      }
      const d = sub(b, a);
      if (iv[0] > 1e-6) next.push([a, add(a, mul(d, iv[0]))]);
      if (iv[1] < 1 - 1e-6) next.push([add(a, mul(d, iv[1])), b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => len(sub(b, a)) > 1);
}

/**
 * Joints of a floor inside a polygon. kind tile: a grid of size [a along the angle, b across]; plank: long joints every
 * b, butt joints every a staggered by stagger x a from row to row. start: a point where two joints cross.
 */
export function patternLines(poly, { kind = 'tile', size, angle = 0, start, stagger = 1 / 3 }) {
  const e1 = [Math.cos(angle * DEG), Math.sin(angle * DEG)], e2 = [-e1[1], e1[0]];
  const [a, b] = size;
  const p1 = poly.map((p) => dot(sub(p, start), e1)), p2 = poly.map((p) => dot(sub(p, start), e2));
  const s1 = [Math.min(...p1), Math.max(...p1)], s2 = [Math.min(...p2), Math.max(...p2)];
  const at = (u, v) => add(start, add(mul(e1, u), mul(e2, v)));
  const segs = [];
  for (let k = Math.ceil(s2[0] / b); k * b <= s2[1]; k++) segs.push(...clipSeg(at(s1[0] - 10, k * b), at(s1[1] + 10, k * b), poly));
  if (kind === 'plank') {
    const nCycle = Math.max(1, Math.round(1 / stagger));
    for (let j = Math.floor(s2[0] / b); j * b < s2[1]; j++) {
      const off = ((((j % nCycle) + nCycle) % nCycle) * a) / nCycle;
      for (let k = Math.floor((s1[0] - off) / a); off + k * a <= s1[1]; k++) {
        const u = off + k * a;
        if (u >= s1[0]) segs.push(...clipSeg(at(u, j * b), at(u, (j + 1) * b), poly));
      }
    }
  } else {
    for (let k = Math.ceil(s1[0] / a); k * a <= s1[1]; k++) segs.push(...clipSeg(at(k * a, s2[0] - 10), at(k * a, s2[1] + 10), poly));
  }
  return segs;
}

// ---------------------------------------------------------------- room walls

const SIDE_OF = { A: 'top', B: 'right', C: 'bottom', D: 'left', TOP: 'top', RIGHT: 'right', BOTTOM: 'bottom', LEFT: 'left' };
const SIDE_DIR = { top: [0, 1], right: [1, 0], bottom: [0, -1], left: [-1, 0] };
export const WALL_LABELS = ['A', 'B', 'C', 'D'];

/** Edges of a counter-clockwise outline with their outward normal. */
function edgesOf(poly) {
  return poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const t = unit(sub(b, a));
    return { a, b, t, n: [t[1], -t[0]], L: len(sub(b, a)), i };
  });
}

/** The wall face of a room: A/top, B/right, C/bottom, D/left (the longest edge facing that way) or an edge index. */
export function roomEdge(poly, wall, name = 'wall') {
  const edges = edgesOf(poly);
  if (typeof wall === 'number' || /^\d+$/.test(String(wall))) {
    const e = edges[Number(wall)];
    if (!e) throw new PlanError(`${name}: the room has edges 0..${edges.length - 1}`);
    return e;
  }
  const side = SIDE_OF[String(wall).toUpperCase()];
  if (!side) throw new PlanError(`${name} must be A, B, C, D (top, right, bottom, left seen in plan) or an edge index`);
  const e = edges.filter((x) => dot(x.n, SIDE_DIR[side]) > 0.7).sort((p, q) => q.L - p.L)[0];
  if (!e) throw new PlanError(`${name}: the room has no wall facing ${side}`);
  return mergeRun(edges, e);
}

/**
 * One wall face from the longest edge and the parallel edges next to it that are within tol of its line, joined by
 * short steps (a 200 wall continuing as a 100 one): a, b span the whole run on the line of the longest edge.
 */
function mergeRun(edges, main, tol = 300) {
  const n = edges.length;
  const near = (k) => {
    const x = edges[((k % n) + n) % n];
    return Math.abs(cross(x.t, main.t)) < 0.01 && dot(x.t, main.t) > 0 && Math.abs(dot(sub(x.a, main.a), main.n)) <= tol;
  };
  const short = (k) => edges[((k % n) + n) % n].L <= tol;
  let first = main.i, last = main.i;
  while (first - 2 > main.i - n && short(first - 1) && near(first - 2)) first -= 2;
  while (last + 2 < main.i + n && short(last + 1) && near(last + 2)) last += 2;
  if (first === main.i && last === main.i) return { ...main, prev: edges[(main.i + n - 1) % n], next: edges[(main.i + 1) % n] };
  const ss = [];
  for (let k = first; k <= last; k++) {
    const x = edges[((k % n) + n) % n];
    ss.push(dot(sub(x.a, main.a), main.t), dot(sub(x.b, main.a), main.t));
  }
  const s0 = Math.min(...ss), s1 = Math.max(...ss);
  return {
    ...main, a: add(main.a, mul(main.t, s0)), b: add(main.a, mul(main.t, s1)), L: s1 - s0,
    prev: edges[(((first - 1) % n) + n) % n], next: edges[(((last + 1) % n) + n) % n],
  };
}

/** Viewing frame of a wall face seen from inside: r = the viewer's right, u = position along r. */
function wallFrame(e) {
  const r = [e.n[1], -e.n[0]];
  const ua = dot(e.a, r), ub = dot(e.b, r);
  return { e, n: e.n, r, u0: Math.min(ua, ub), u1: Math.max(ua, ub), left: ua <= ub ? e.a : e.b, u: (p) => dot(p, r) };
}

// ---------------------------------------------------------------- furniture library
// Local frame of an item: x along its width (to the right of someone facing it), y from its back (0, against the wall)
// to its front (d); elevation views use x (front) or y (side) against the height z.

const sL = (x0, y0, x1, y1, role) => ({ k: 'l', a: [x0, y0], b: [x1, y1], role });
const sR = (x0, y0, x1, y1, role) => ({ k: 'pl', pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], closed: true, role });
const sP = (pts, closed = false, role) => ({ k: 'pl', pts, closed, role });
const sC = (x, y, r, role) => ({ k: 'c', c: [x, y], r, role });
const sE = (x, y, rx, ry, role) => ({ k: 'el', c: [x, y], rx, ry, role });

/** Doors of a cabinet front between x0..x1, za..zb: n doors, pairs open in the middle; hinge V (hidden) and handles. */
function doorsFront(x0, x1, za, zb, n, out, handle = 'mid') {
  const dw = (x1 - x0) / n;
  for (let i = 1; i < n; i++) out.push(sL(x0 + i * dw, za, x0 + i * dw, zb));
  for (let i = 0; i < n; i++) {
    const a = x0 + i * dw, b = a + dw;
    const hingeLeft = n === 1 || i % 2 === 0;
    const hx = hingeLeft ? a : b, ox = hingeLeft ? b : a;
    out.push(sP([[hx, za], [ox, (za + zb) / 2], [hx, zb]], false, 'hidden'));
    const hxIn = ox + (hingeLeft ? -40 : 40);
    if (handle === 'mid') out.push(sL(hxIn, Math.min(zb - 60, za + 850), hxIn, Math.min(zb - 60, za + 1100)));
    else if (handle === 'top') out.push(sL(hxIn, zb - 60, hxIn, zb - 180));
    else if (handle === 'bottom') out.push(sL(hxIn, za + 60, hxIn, za + 180));
  }
}

/** Cabinet modules along a run: given [{w, type}] or equal modules about 600 wide; sink/hob positions pick their type. */
function modulesOf(w, o, name) {
  let mods;
  if (Array.isArray(o.modules) && o.modules.length) {
    mods = o.modules.map((m, i) => ({ w: num(m.w ?? m.width, `${name}.modules[${i}].w`, { positive: true }), type: m.type }));
  } else {
    const n = Math.max(1, Math.round(w / 600));
    mods = Array.from({ length: n }, () => ({ w: w / n }));
  }
  let x = 0;
  for (const m of mods) {
    m.x0 = x;
    m.x1 = x + m.w;
    x = m.x1;
    const has = (k) => o[k] !== undefined && o[k] >= m.x0 && o[k] < m.x1;
    if (!m.type) m.type = has('sink') ? 'sink' : has('hob') ? 'drawers' : m.w >= 700 ? 'doors' : 'door';
  }
  if (Math.abs(x - w) > 1) throw new PlanError(`${name}.modules add up to ${r2(x)}, not the width ${w}`);
  return mods;
}

function moduleFront(m, za, zb, out, handle) {
  out.push(sR(m.x0, za, m.x1, zb));
  if (m.type === 'drawers') {
    for (let k = 1; k < 3; k++) out.push(sL(m.x0, za + ((zb - za) * k) / 3, m.x1, za + ((zb - za) * k) / 3));
    const xc = (m.x0 + m.x1) / 2;
    for (let k = 0; k < 3; k++) {
      const z = za + ((zb - za) * (k + 1)) / 3 - 50;
      out.push(sL(xc - 80, z, xc + 80, z));
    }
  } else if (m.type === 'doors' || m.type === 'sink') {
    doorsFront(m.x0, m.x1, za, zb, 2, out, handle);
  } else if (m.type === 'door') {
    doorsFront(m.x0, m.x1, za, zb, 1, out, handle);
  } else if (m.type === 'open') {
    out.push(sL(m.x0, (za + zb) / 2, m.x1, (za + zb) / 2));
  }
}

function sofaPlan(w, d) {
  const arm = Math.min(180, w / 5), back = 200;
  const s = [sR(0, 0, w, d), sR(arm, 0, w - arm, back), sR(0, 0, arm, d), sR(w - arm, 0, w, d)];
  const n = Math.max(1, Math.round((w - 2 * arm) / 650));
  for (let k = 1; k < n; k++) s.push(sL(arm + (k * (w - 2 * arm)) / n, back, arm + (k * (w - 2 * arm)) / n, d));
  return s;
}

function sofaFront(w, d, h) {
  const arm = Math.min(180, w / 5);
  const s = [sR(80, 0, 140, 80), sR(w - 140, 0, w - 80, 80), sR(0, 80, arm, 600), sR(w - arm, 80, w, 600),
    sR(arm, 80, w - arm, 280), sR(arm, 280, w - arm, 430), sR(arm, 430, w - arm, h)];
  const n = Math.max(1, Math.round((w - 2 * arm) / 650));
  for (let k = 1; k < n; k++) {
    const x = arm + (k * (w - 2 * arm)) / n;
    s.push(sL(x, 280, x, 430), sL(x, 430, x, h));
  }
  return s;
}

const sofaSide = (w, d, h) => [sR(60, 0, 120, 80), sR(d - 120, 0, d - 60, 80), sR(0, 80, d, 600), sR(0, 600, 200, h)];

/**
 * Furniture types: cat/code (default material code), vi/en name, size [w, d, h], role (layer), plan / front / side
 * shapes, tag (local point for the code tag, or null to put it in front), z0 for wall-hung items, overhead (dashed in plan).
 */
export const TYPES = {
  bed: {
    code: 'FN-01', vi: 'Giường ngủ', en: 'Bed', size: [1600, 2000, 450], role: 'furniture',
    plan: (w, d) => {
      const s = [sR(0, 0, w, d), sR(0, 0, w, 60), sL(0, d * 0.36, w, d * 0.36)];
      const n = w >= 1200 ? 2 : 1, pw = n === 2 ? (w - 300) / 2 : w - 200;
      for (let i = 0; i < n; i++) s.push(sR(100 + i * (pw + 100), 120, 100 + i * (pw + 100) + pw, 450));
      return s;
    },
    front: (w, d, h, o) => {
      const hb = o.headboard ?? 1000;
      return [sR(0, 0, 60, 150), sR(w - 60, 0, w, 150), sR(0, 150, w, 300), sR(0, 300, w, h), sP([[0, h], [0, hb], [w, hb], [w, h]])];
    },
    side: (w, d, h, o) => {
      const hb = o.headboard ?? 1000;
      return [sR(0, 0, 60, hb), sR(60, 150, d, 300), sR(60, 300, d, h), sR(d - 60, 0, d, 150), sR(60, 0, 120, 150)];
    },
    tag: (w, d) => [w / 2, d * 0.68],
  },
  nightstand: {
    code: 'FN-02', vi: 'Tab đầu giường', en: 'Nightstand', size: [450, 400, 500], role: 'furniture',
    plan: (w, d) => [sR(0, 0, w, d), sC(w / 2, d / 2, Math.min(110, w / 4))],
    front: (w, d, h) => [sR(0, 0, w, h), sL(0, h - 160, w, h - 160), sC(w / 2, h - 80, 12), sL(0, 60, w, 60)],
    side: (w, d, h) => [sR(0, 0, d, h)],
    tag: null,
  },
  wardrobe: {
    code: 'JN-01', vi: 'Tủ áo', en: 'Wardrobe', size: [1600, 600, 2400], role: 'casework',
    plan: (w, d) => {
      const n = Math.max(1, Math.round(w / 450));
      const s = [sR(0, 0, w, d), sL(0, d - 20, w, d - 20), sL(60, d / 2, w - 60, d / 2, 'hidden')];
      for (let i = 1; i < n; i++) s.push(sL((i * w) / n, d - 20, (i * w) / n, d));
      return s;
    },
    front: (w, d, h) => {
      const n = Math.max(1, Math.round(w / 450));
      const zt = h >= 2200 ? h - 450 : null;
      const s = [sR(0, 0, w, 100), sR(0, 100, w, h)];
      if (zt) s.push(sL(0, zt, w, zt));
      doorsFront(0, w, 100, zt ?? h, n, s, 'mid');
      if (zt) doorsFront(0, w, zt, h, n, s, 'none');
      return s;
    },
    side: (w, d, h) => [sR(0, 100, d, h), sR(0, 0, d - 50, 100)],
    tag: (w, d) => [w / 2, d * 0.3],
  },
  sofa: {
    code: 'FN-03', vi: 'Sofa', en: 'Sofa', size: [2100, 850, 800], role: 'furniture',
    plan: sofaPlan, front: sofaFront, side: sofaSide, tag: (w, d) => [w / 2, 200 + (d - 200) * 0.55],
  },
  armchair: {
    code: 'FN-04', vi: 'Ghế bành', en: 'Armchair', size: [850, 850, 800], role: 'furniture',
    plan: sofaPlan, front: sofaFront, side: sofaSide, tag: null,
  },
  coffee_table: {
    code: 'FN-05', vi: 'Bàn trà', en: 'Coffee table', size: [1100, 600, 420], role: 'furniture',
    plan: (w, d) => [sR(0, 0, w, d), sR(60, 60, w - 60, d - 60)],
    front: (w, d, h) => [sR(0, h - 40, w, h), sR(40, 0, 90, h - 40), sR(w - 90, 0, w - 40, h - 40), sL(40, 120, w - 40, 120)],
    side: (w, d, h) => [sR(0, h - 40, d, h), sR(40, 0, 90, h - 40), sR(d - 90, 0, d - 40, h - 40)],
    tag: (w, d) => [w / 2, d / 2],
  },
  tv_cabinet: {
    code: 'JN-02', vi: 'Kệ tivi', en: 'TV cabinet', size: [1800, 400, 450], role: 'casework',
    plan: (w, d) => [sR(0, 0, w, d), sR(w / 2 - 615, 40, w / 2 + 615, 100)],
    front: (w, d, h) => {
      const n = Math.max(1, Math.round(w / 600));
      const s = [sR(30, 0, w - 30, 100), sR(0, 100, w, h)];
      for (let i = 1; i < n; i++) s.push(sL((i * w) / n, 100, (i * w) / n, h));
      for (let i = 0; i < n; i++) s.push(sL(((i + 0.5) * w) / n - 100, h - 70, ((i + 0.5) * w) / n + 100, h - 70));
      s.push(sR(w / 2 - 615, 800, w / 2 + 615, 1520), sR(w / 2 - 600, 815, w / 2 + 600, 1505));
      return s;
    },
    side: (w, d, h) => [sR(0, 100, d, h), sR(0, 0, d - 30, 100), sR(40, 800, 100, 1520)],
    tag: (w, d) => [w / 2, d * 0.62],
  },
  dining_table: {
    code: 'FN-06', vi: 'Bộ bàn ăn', en: 'Dining set', size: [1600, 900, 750], role: 'furniture',
    plan: (w, d, h, o) => {
      const s = [sR(0, 0, w, d)];
      const n = o.chairs ?? Math.max(1, Math.floor(w / 600));
      for (let k = 0; k < n; k++) {
        const xc = ((k + 0.5) * w) / n;
        s.push(sR(xc - 225, d + 50, xc + 225, d + 450), sR(xc - 225, d + 450, xc + 225, d + 500));
        s.push(sR(xc - 225, -450, xc + 225, -50), sR(xc - 225, -500, xc + 225, -450));
      }
      return s;
    },
    front: (w, d, h, o) => {
      const s = [sR(0, h - 40, w, h), sR(50, 0, 110, h - 40), sR(w - 110, 0, w - 50, h - 40)];
      const n = o.chairs ?? Math.max(1, Math.floor(w / 600));
      for (let k = 0; k < n; k++) s.push(sP([[((k + 0.5) * w) / n - 210, h], [((k + 0.5) * w) / n - 210, 900], [((k + 0.5) * w) / n + 210, 900], [((k + 0.5) * w) / n + 210, h]]));
      return s;
    },
    side: (w, d, h) => [sR(0, h - 40, d, h), sR(50, 0, 110, h - 40), sR(d - 110, 0, d - 50, h - 40)],
    tag: (w, d) => [w / 2, d / 2],
  },
  chair: {
    code: 'FN-07', vi: 'Ghế', en: 'Chair', size: [450, 450, 850], role: 'furniture',
    plan: (w, d) => [sR(0, 50, w, d), sR(0, 0, w, 50)],
    front: (w, d, h) => [sR(20, 0, 50, 430), sR(w - 50, 0, w - 20, 430), sR(0, 430, w, 460), sR(20, 460, w - 20, h)],
    side: (w, d, h) => [sR(0, 0, 40, h), sR(d - 40, 0, d, 430), sR(0, 430, d, 460)],
    tag: null,
  },
  desk: {
    code: 'FN-08', vi: 'Bàn làm việc', en: 'Desk', size: [1200, 600, 750], role: 'furniture',
    plan: (w, d) => [sR(0, 0, w, d), sR(w / 2 - 225, d + 50, w / 2 + 225, d + 450), sR(w / 2 - 225, d + 450, w / 2 + 225, d + 500)],
    front: (w, d, h) => [sR(0, h - 30, w, h), sR(0, 0, 30, h - 30), sR(w - 450, 0, w, h - 30), sL(w - 450, h - 210, w, h - 210),
      sL(w - 450, h - 390, w, h - 390), sL(w - 305, h - 120, w - 145, h - 120), sL(w - 305, h - 300, w - 145, h - 300)],
    side: (w, d, h) => [sR(0, h - 30, d, h), sR(30, 0, d - 30, h - 30)],
    tag: (w, d) => [w * 0.35, d / 2],
  },
  kitchen_base: {
    code: 'JN-03', vi: 'Tủ bếp dưới', en: 'Kitchen base cabinets', size: [2400, 600, 850], role: 'casework',
    plan: (w, d, h, o) => {
      const s = [sR(0, 0, w, d)];
      if (o.sink !== undefined) {
        const x = o.sink;
        s.push(sR(x - 400, 90, x + 400, 510), sR(x - 370, 120, x + 370, 480), sC(x, 300, 30), sC(x, 50, 22));
      }
      if (o.hob !== undefined) {
        const x = o.hob;
        s.push(sR(x - 350, 100, x + 350, 500));
        for (const [dx, dy] of [[-175, 210], [175, 210], [-175, 390], [175, 390]]) s.push(sC(x + dx, dy, 85));
      }
      return s;
    },
    front: (w, d, h, o, name) => {
      const s = [sR(0, 0, w, 100), sR(0, h - 20, w, h)];
      for (const m of modulesOf(w, o, name)) moduleFront(m, 100, h - 20, s, 'top');
      return s;
    },
    side: (w, d, h) => [sR(0, 0, d - 70, 100), sR(0, 100, d - 20, h - 20), sR(0, h - 20, d, h)],
    tag: (w, d, h, o) => {
      const free = (x) => (o.sink === undefined || Math.abs(x - o.sink) > 700) && (o.hob === undefined || Math.abs(x - o.hob) > 650);
      const n = Math.max(1, Math.round(w / 600));
      for (let i = 0; i < n; i++) if (free(((i + 0.5) * w) / n)) return [((i + 0.5) * w) / n, d / 2];
      return null;
    },
  },
  kitchen_wall: {
    code: 'JN-04', vi: 'Tủ bếp trên', en: 'Kitchen wall cabinets', size: [2400, 350, 700], role: 'casework', z0: 1500, overhead: true,
    plan: (w, d) => [sR(0, 0, w, d, 'hidden'), sL(0, 0, w, d, 'hidden'), sL(0, d, w, 0, 'hidden')],
    front: (w, d, h, o, name) => {
      const s = [];
      for (const m of modulesOf(w, { ...o, sink: undefined, hob: undefined }, name)) moduleFront(m, o.z0, o.z0 + h, s, 'bottom');
      return s;
    },
    side: (w, d, h, o) => [sR(0, o.z0, d, o.z0 + h)],
    tag: null,
  },
  hood: {
    code: 'EQ-03', vi: 'Máy hút mùi', en: 'Cooker hood', size: [700, 480, 650], role: 'equipment', z0: 1600, overhead: true,
    plan: (w, d) => [sR(0, 0, w, d, 'hidden')],
    front: (w, d, h, o) => [sP([[0, o.z0], [w, o.z0], [w - 150, o.z0 + 200], [150, o.z0 + 200]], true), sR(w / 2 - 150, o.z0 + 200, w / 2 + 150, o.z0 + h)],
    side: (w, d, h, o) => [sP([[0, o.z0], [d, o.z0], [d, o.z0 + 80], [300, o.z0 + 200], [0, o.z0 + 200]], true), sR(0, o.z0 + 200, 300, o.z0 + h)],
    tag: null,
  },
  fridge: {
    code: 'EQ-01', vi: 'Tủ lạnh', en: 'Refrigerator', size: [700, 700, 1800], role: 'equipment',
    plan: (w, d) => [sR(0, 0, w, d), sL(0, d - 40, w, d - 40)],
    front: (w, d, h) => [sR(0, 30, w, h), sL(0, h - 560, w, h - 560), sL(w - 60, h - 520, w - 60, h - 200), sL(w - 60, h - 620, w - 60, h - 1000),
      sR(40, 0, 100, 30), sR(w - 100, 0, w - 40, 30)],
    side: (w, d, h) => [sR(0, 30, d - 40, h), sR(d - 40, 30, d, h)],
    tag: (w, d) => [w / 2, d / 2],
  },
  washer: {
    code: 'EQ-02', vi: 'Máy giặt', en: 'Washing machine', size: [600, 600, 850], role: 'equipment',
    plan: (w, d) => [sR(0, 0, w, d), sC(w / 2, d / 2 + 20, Math.min(220, w / 2 - 50))],
    front: (w, d, h) => [sR(0, 0, w, h), sL(0, h - 130, w, h - 130), sC(w / 2, (h - 130) / 2, 210), sC(w / 2, (h - 130) / 2, 160)],
    side: (w, d, h) => [sR(0, 0, d, h)],
    tag: null,
  },
  toilet: {
    code: 'SN-01', vi: 'Bồn cầu', en: 'Toilet', size: [400, 700, 400], role: 'fixture',
    plan: (w, d) => [sR(20, 0, w - 20, 190), sE(w / 2, 190 + (d - 190) / 2, w / 2 - 15, (d - 190) / 2), sE(w / 2, 200 + (d - 190) / 2, w / 2 - 70, (d - 190) / 2 - 60)],
    front: (w, d, h) => [sR(40, h, w - 40, 800), sP([[30, h - 30], [w - 30, h - 30], [w - 90, 0], [90, 0]], true), sR(25, h - 30, w - 25, h)],
    side: (w, d, h) => [sR(0, h - 30, 190, 800), sP([[140, 0], [140, h - 30], [d, h - 30], [d - 40, h - 130], [320, 120], [280, 0]], true), sR(150, h - 30, d, h)],
    tag: null,
  },
  vanity: {
    code: 'SN-02', vi: 'Lavabo, tủ chậu, gương', en: 'Vanity with basin and mirror', size: [800, 500, 850], role: 'fixture',
    plan: (w, d) => [sR(0, 0, w, d), sE(w / 2, d * 0.55, Math.min(w * 0.32, 230), Math.min(150, d * 0.3)), sC(w / 2, 70, 22)],
    front: (w, d, h) => {
      const s = [sR(0, 180, w, h - 50), sR(0, h - 50, w, h), sP([[w / 2 - 230, h], [w / 2 - 200, h + 60], [w / 2 + 200, h + 60], [w / 2 + 230, h]]),
        sL(w / 2, h + 60, w / 2, h + 200), sL(w / 2, h + 200, w / 2 + 110, h + 200), sR(w / 2 - Math.min(300, w / 2), 1150, w / 2 + Math.min(300, w / 2), 1950)];
      doorsFront(0, w, 180, h - 50, w >= 700 ? 2 : 1, s, 'top');
      return s;
    },
    side: (w, d, h) => [sR(0, 180, d, h - 50), sR(0, h - 50, d, h), sR(0, 1150, 20, 1950)],
    tag: null,
  },
  shower: {
    code: 'SN-03', vi: 'Khu tắm đứng, vách kính', en: 'Shower with glass screen', size: [900, 900, 2000], role: 'fixture',
    plan: (w, d) => [sR(0, 0, w, d), sL(0, 0, w, d), sL(w, 0, 0, d), sC(w / 2, d / 2, 40), sL(0, d - 10, w, d - 10, 'glass')],
    front: (w, d, h) => [sR(0, 0, w, 60), sR(0, 60, w, h, 'glass'), sC(w / 2, 1100, 40), sL(w / 2, 1140, w / 2, 1900), sR(w / 2 - 120, 1900, w / 2 + 120, 1930)],
    side: (w, d, h) => [sR(0, 0, d, 60), sL(d, 60, d, h, 'glass'), sL(0, 1950, 300, 1950)],
    tag: null,
  },
  bathtub: {
    code: 'SN-04', vi: 'Bồn tắm', en: 'Bathtub', size: [1600, 750, 550], role: 'fixture',
    plan: (w, d) => [sR(0, 0, w, d), sR(70, 70, w - 70, d - 70), sC(w - 160, d / 2, 30)],
    front: (w, d, h) => [sR(0, 0, w, h), sL(0, h - 60, w, h - 60)],
    side: (w, d, h) => [sR(0, 0, d, h)],
    tag: (w, d) => [w / 2, d / 2],
  },
  shoe_cabinet: {
    code: 'JN-05', vi: 'Tủ giày', en: 'Shoe cabinet', size: [1000, 350, 1000], role: 'casework',
    plan: (w, d) => [sR(0, 0, w, d), sL(0, d - 20, w, d - 20)],
    front: (w, d, h) => {
      const s = [sR(0, 0, w, 100), sR(0, 100, w, h)];
      doorsFront(0, w, 100, h, Math.max(1, Math.round(w / 450)), s, 'top');
      return s;
    },
    side: (w, d, h) => [sR(0, 100, d, h), sR(0, 0, d - 40, 100)],
    tag: (w, d) => [w / 2, d * 0.45],
  },
  bookshelf: {
    code: 'JN-06', vi: 'Kệ sách', en: 'Bookshelf', size: [800, 300, 2000], role: 'casework',
    plan: (w, d) => [sR(0, 0, w, d)],
    front: (w, d, h) => {
      const s = [sR(0, 0, w, h), sL(0, 100, w, 100), sR(20, 100, w - 20, h - 20)];
      for (let z = 450; z < h - 120; z += 350) s.push(sL(20, z, w - 20, z));
      return s;
    },
    side: (w, d, h) => [sR(0, 0, d, h)],
    tag: (w, d) => [w / 2, d / 2],
  },
};

const ROOM_TYPES_DOC = Object.entries(TYPES).map(([k, t]) => `${k} (${t.size.join('x')})`).join(', ');
export const FURNITURE_DOC = ROOM_TYPES_DOC;

/**
 * Place items: room + wall (A/B/C/D or top/right/bottom/left, back against that wall face) + offset from its left end
 * (seen from inside; default centred) + gap; or at (centre of the back edge) + facing (degrees, direction the front
 * faces); or center + facing (freestanding). Returns items with their frame (back-left corner o, axes ex, ey).
 */
export function resolveItems(list, rooms) {
  const items = [], assumed = [], warnings = [];
  (list || []).forEach((it, i) => {
    const name = `items[${i}]`;
    const def = TYPES[it.type];
    if (!def) throw new PlanError(`${name}.type must be one of ${Object.keys(TYPES).join(', ')}`);
    const [dw, dd, dh] = def.size;
    const w = num(it.width ?? dw, `${name}.width`, { positive: true });
    const d = num(it.depth ?? dd, `${name}.depth`, { positive: true });
    const h = num(it.height ?? dh, `${name}.height`, { positive: true });
    if (it.width === undefined || it.depth === undefined || it.height === undefined) {
      assumed.push({ item: `${name}.size`, value: `${w}x${d}x${h}`, note: def.vi });
    }
    const code = String(it.code ?? def.code);
    if (it.code === undefined) assumed.push({ item: `${name}.code`, value: code, note: def.vi });
    const opts = { ...it };
    if (def.z0 !== undefined) {
      opts.z0 = num(it.z0 ?? def.z0, `${name}.z0`);
      if (it.z0 === undefined) assumed.push({ item: `${name}.z0`, value: def.z0, note: 'height of the underside' });
    }
    let o, ex, ey;
    let room = it.room;
    if (it.wall !== undefined) {
      const poly = rooms[it.room];
      if (!poly) throw new PlanError(`${name}: room "${it.room}" not found (rooms: ${Object.keys(rooms).join(', ') || 'none'})`);
      const F = wallFrame(roomEdge(poly, it.wall, `${name}.wall`));
      const L = F.u1 - F.u0;
      let off;
      if (it.offset !== undefined) off = num(it.offset, `${name}.offset`);
      else if (it.offset_right !== undefined) off = L - w - num(it.offset_right, `${name}.offset_right`);
      else {
        off = (L - w) / 2;
        assumed.push({ item: `${name}.offset`, value: r2(off), note: 'centred on the wall' });
      }
      if (off < -1 || off + w > L + 1) warnings.push(`${name}: the ${it.type} (${w} wide at ${r2(off)}) runs past the ends of wall ${it.wall} (${r2(L)} long)`);
      ex = F.r;
      ey = mul(F.n, -1);
      o = add(add(F.left, mul(F.r, off)), mul(ey, num(it.gap ?? 0, `${name}.gap`)));
    } else if (it.at || it.center) {
      const f = num(it.facing ?? -90, `${name}.facing`);
      if (it.facing === undefined) assumed.push({ item: `${name}.facing`, value: -90, note: 'front towards -Y (the bottom of the plan)' });
      ey = [Math.cos(f * DEG), Math.sin(f * DEG)];
      ex = [-ey[1], ey[0]];
      o = it.center ? sub(sub(pt(it.center, `${name}.center`), mul(ex, w / 2)), mul(ey, d / 2)) : sub(pt(it.at, `${name}.at`), mul(ex, w / 2));
      if (!room) {
        const c = add(o, add(mul(ex, w / 2), mul(ey, d / 2)));
        room = Object.keys(rooms).find((k) => inside(c, rooms[k]));
      }
    } else {
      throw new PlanError(`${name}: place it with room + wall (+ offset), or at (centre of its back edge) + facing, or center + facing`);
    }
    const description = String(it.description ?? `${def.vi} ${w}x${d}${def.z0 !== undefined || def.role === 'casework' ? `x${h}` : ''}`);
    items.push({ i, type: it.type, def, code, description, w, d, h, o, ex, ey, room, wall: it.wall, opts, name });
  });
  // one code = one item specification (type and size), as in the schedule
  const spec = new Map();
  for (const it of items) {
    const k = `${it.type} ${it.w}x${it.d}x${it.h}`;
    if (spec.has(it.code) && spec.get(it.code) !== k) warnings.push(`code ${it.code} is given to ${spec.get(it.code)} and ${k}: give each its own code`);
    else spec.set(it.code, k);
  }
  return { items, assumed, warnings };
}

const frameMap = (it, off = [0, 0]) => (p) => add(add(it.o, off), add(mul(it.ex, p[0]), mul(it.ey, p[1])));

function emit(shapes, m, layerOf, out) {
  for (const s of shapes) {
    const layer = layerOf(s.role);
    const extra = layer === IL.hidden ? HID : undefined;
    if (s.k === 'l') out.push(lineE(m(s.a), m(s.b), layer, extra));
    else if (s.k === 'pl') out.push(polyE(s.pts.map(m), s.closed, layer, extra));
    else if (s.k === 'c') out.push({ type: 'circle', center: P(m(s.c)), radius: r2(s.r), layer });
    else if (s.k === 'el') {
      const c = m(s.c);
      const major = s.rx >= s.ry ? sub(m([s.c[0] + s.rx, s.c[1]]), c) : sub(m([s.c[0], s.c[1] + s.ry]), c);
      out.push({ type: 'ellipse', center: P(c), major_axis: P(major), ratio: r2(Math.min(s.rx, s.ry) / Math.max(s.rx, s.ry)), layer });
    }
  }
}

function itemLayer(it) {
  const base = IL[it.def.role] ?? IL.furniture;
  return (role) => (role === 'hidden' || it.def.overhead ? IL.hidden : role === 'glass' ? IL.glass : base);
}

/** Bounding box [x0, y0, x1, y1] of a draw_entities spec (arcs and circles by centre and radius). */
export function entBox(e) {
  const pts = [e.from, e.to, e.at, e.start, e.mid, e.end, ...(e.points || []), ...(e.boundary || [])].filter(Array.isArray);
  if (e.center && e.radius) pts.push([e.center[0] - e.radius, e.center[1] - e.radius], [e.center[0] + e.radius, e.center[1] + e.radius]);
  else if (e.center) pts.push(e.center);
  if (!pts.length) return null;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** World boxes of the items' plan symbols (chairs included), moved by offset. */
export function footprints(items, offset = [0, 0]) {
  return items.filter((it) => !it.def.overhead).map((it) => {
    const ents = [];
    emit(it.def.plan(it.w, it.d, it.h, it.opts), frameMap(it, offset), () => IL.furniture, ents);
    const bs = ents.map(entBox).filter(Boolean);
    return [Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])), Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3]))];
  });
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * A point inside poly where a box of size [w, h] centred on it stays inside the room and clear of the hard obstacle
 * boxes (tags, door swings, other labels): first also clear of the soft ones (furniture), else over as little of them
 * as possible (soft: true in the result); the nearest to prefer. null when even the hard ones leave no room.
 */
export function freePoint(poly, hard, size, prefer, soft = [], step = 100) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [w, h] = size;
  let best = null, bestKey = [Infinity, Infinity];
  for (let x = Math.min(...xs) + w / 2; x <= Math.max(...xs) - w / 2; x += step) {
    for (let y = Math.min(...ys) + h / 2; y <= Math.max(...ys) - h / 2; y += step) {
      const box = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
      if (![[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].every((q) => inside(q, poly))) continue;
      if (hard.some((o) => overlaps(o, box))) continue;
      const key = [Math.round(soft.reduce((t, o) => t + overlapArea(o, box), 0) / 1e4), Math.hypot(x - prefer[0], y - prefer[1])];
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
        bestKey = key;
        best = [x, y];
      }
    }
  }
  return best ? Object.assign(best, { soft: bestKey[0] > 0 }) : null;
}

/** Size [w, h] a room label (name + area) needs, with a margin. */
export const labelSize = (name, h) => {
  const b = labelBox(name, [0, 0], h);
  return [b[2] - b[0] + h, b[3] - b[1] + 0.5 * h];
};

/** Plan symbols of items, moved by offset, with their code tags (inside the symbol when they fit, else in front). */
export function furniturePlan(items, { offset = [0, 0], scale = 50, tags = true } = {}) {
  const out = [];
  const th = 2 * scale;
  const feet = items.map((it) => (it.def.overhead ? null : footprints([it], offset)[0]));
  const placed = [];
  for (const [k, it] of items.entries()) {
    const m = frameMap(it, offset);
    emit(it.def.plan(it.w, it.d, it.h, it.opts), m, itemLayer(it), out);
    if (!tags || it.def.overhead) continue;
    const tw = textWidth(it.code, th) + 1.2 * th, thh = 1.9 * th;
    const quad = [[0, 0], [it.w, 0], [it.w, it.d], [0, it.d]].map(m);
    const boxAt = (c) => [c[0] - tw / 2, c[1] - thh / 2, c[0] + tw / 2, c[1] + thh / 2];
    const clear = (c, own) => !placed.some((b) => overlaps(b, boxAt(c))) && feet.every((f, j) => !f || j === k || own || !overlaps(f, boxAt(c)));
    const fits = (c) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([sx, sy]) => inside([c[0] + (sx * tw) / 2, c[1] + (sy * thh) / 2], quad));
    const local = it.def.tag ? it.def.tag(it.w, it.d, it.h, it.opts) : null;
    let loc = local && fits(m(local)) && clear(m(local), true) ? m(local) : null;
    if (!loc) {
      // in front of the item, as far out as the box needs, sliding along it or further out to keep clear of the rest
      const ext = Math.abs(it.ey[0]) * (tw / 2) + Math.abs(it.ey[1]) * (thh / 2);
      const cands = [];
      for (const step of [0, 1, 2]) for (const fx of [0.5, 0.25, 0.75, 0, 1]) cands.push(m([it.w * fx, it.d + 60 + ext + step * (thh + 60)]));
      loc = cands.find((c) => clear(c, false)) ?? cands[0];
    }
    placed.push(tagBox(it.code, loc, th, IL.note, out));
  }
  return out;
}

/** Elevation key: a circle with arrows to the walls A (top), B (right), C (bottom), D (left). */
export function elevationKey(at, scale, out, labels = WALL_LABELS) {
  const r = 3.5 * scale;
  out.push({ type: 'circle', center: P(at), radius: r2(r), layer: IL.symbol });
  ['top', 'right', 'bottom', 'left'].forEach((side, k) => {
    const d = SIDE_DIR[side], q = [-d[1], d[0]];
    const tip = add(at, mul(d, r * 1.9)), b1 = add(add(at, mul(d, r * 0.9)), mul(q, r * 0.75)), b2 = add(add(at, mul(d, r * 0.9)), mul(q, -r * 0.75));
    out.push(polyE([tip, b1, b2], true, IL.symbol));
    out.push({ type: 'hatch', boundary: [P(tip), P(b1), P(b2)], pattern: 'SOLID', layer: IL.symbol });
    out.push(textE(labels[k], add(at, mul(d, r * 0.45)), 2.2 * scale, IL.symbol, 'middle_center'));
  });
}

// ---------------------------------------------------------------- finishes

const WET = /(WC|VỆ SINH|TẮM|TOILET|BATH|WASH)/i;
const KITCHEN = /(BẾP|KITCHEN)/i;
const OUTDOOR = /(SÂN|HIÊN|BAN CÔNG|LÔ GIA|LOGIA|BALCONY|TERRACE|PORCH|YARD)/i;

/** Default finishes by the kind of room (from its name). */
export function defaultFinish(name) {
  const n = String(name);
  if (WET.test(n)) {
    return {
      kind: 'wet',
      floor: { code: 'FL-02', description: 'Gạch chống trơn 300x300', pattern: 'tile', size: [300, 300], start: 'center' },
      skirting: null,
      wall: { code: 'WL-02', description: 'Gạch ốp tường 300x600 ốp đến trần', pattern: 'tile', size: [600, 300], height: 'ceiling' },
      ceiling: { code: 'CL-02', description: 'Trần thạch cao chống ẩm khung chìm, sơn trắng', level: 3000, drop: null },
    };
  }
  if (OUTDOOR.test(n)) {
    return {
      kind: 'outdoor',
      floor: { code: 'FL-03', description: 'Gạch chống trơn ngoài trời 400x400', pattern: 'tile', size: [400, 400], start: 'center' },
      skirting: { code: 'SK-01', description: 'Len chân tường gạch cao 100', height: 100 },
      wall: { code: 'WL-04', description: 'Sơn ngoại thất màu trắng', pattern: 'paint' },
      ceiling: null,
    };
  }
  return {
    kind: KITCHEN.test(n) ? 'kitchen' : 'dry',
    floor: { code: 'FL-01', description: 'Gạch porcelain 600x600', pattern: 'tile', size: [600, 600], start: 'center' },
    skirting: { code: 'SK-01', description: 'Len chân tường gạch cao 100', height: 100 },
    wall: { code: 'WL-01', description: 'Sơn nước hoàn thiện màu trắng', pattern: 'paint' },
    ceiling: { code: 'CL-01', description: 'Trần thạch cao khung chìm, sơn trắng', level: 3000, drop: { width: 600, depth: 150, cove: true } },
  };
}

export const BACKSPLASH = { code: 'WL-03', description: 'Gạch ốp tường bếp 600x300', pattern: 'tile', size: [600, 300] };

/** Finishes of a room: the given parts over the defaults (null removes a part); assumed lists what was defaulted. */
export function resolveFinish(name, given = {}, assumed = []) {
  const def = defaultFinish(name);
  const out = { kind: def.kind };
  for (const part of ['floor', 'skirting', 'wall', 'ceiling']) {
    const g = given?.[part];
    if (g === null || g === false) out[part] = null;
    else if (g === undefined) {
      out[part] = def[part];
      assumed.push({ item: `${name}.${part}`, value: def[part] ? `${def[part].code} ${def[part].description}` : 'none' });
    } else out[part] = { ...(def[part] || {}), ...g };
  }
  if (out.ceiling && out.ceiling.drop && given?.ceiling?.drop !== undefined && given.ceiling.drop !== null) {
    out.ceiling.drop = { width: 600, depth: 150, cove: true, ...given.ceiling.drop };
  }
  return out;
}

// ---------------------------------------------------------------- floor finish plan

/** Approximate box of a room label (name + area, two lines, middle centre) of text height h. */
function labelBox(name, at, h) {
  const w = Math.max(textWidth(name, h), textWidth('00,00 m²', h)) + h;
  return [at[0] - w / 2, at[1] - 1.75 * h, at[0] + w / 2, at[1] + 1.75 * h];
}

const shiftBox = (b, o) => [b[0] + o[0], b[1] + o[1], b[2] + o[0], b[3] + o[1]];
const shiftPoly = (poly, o) => poly.map((p) => add(p, o));

/**
 * Floor joints of each room with a floor finish, kept clear of the room labels, a code tag under each label and the
 * legend (finish, size, area). rooms {name: outline (plan coords)}, labels {name: label point}.
 */
export function floorFinishPlan({ rooms, finishes, labels, offset = [0, 0], scale = 50, legendAt, lang = 'vi' }) {
  const out = [];
  const areas = {};
  const hLabel = 2.5 * scale, hTag = 2 * scale;
  for (const [name, poly0] of Object.entries(rooms)) {
    const f = finishes[name]?.floor;
    if (!f) continue;
    const poly = shiftPoly(poly0, offset);
    const at = add(labels[name] ?? centroid(poly0), offset);
    const masks = [labelBox(name, at, hLabel)];
    const tagAt = [at[0], at[1] - 1.75 * hLabel - 0.4 * hTag - 0.95 * hTag];
    if (f.pattern === 'tile' || f.pattern === 'plank') {
      const size = f.size ?? (f.pattern === 'plank' ? [900, 150] : [600, 600]);
      const angle = num(f.angle ?? 0, `${name}.floor.angle`);
      const e1 = [Math.cos(angle * DEG), Math.sin(angle * DEG)], e2 = [-e1[1], e1[0]];
      let start;
      if (Array.isArray(f.start)) start = add(pt(f.start, `${name}.floor.start`), offset);
      else if (f.start === 'corner') start = poly.reduce((m, p) => (p[0] + p[1] < m[0] + m[1] ? p : m));
      else start = sub(sub(centroid(poly), mul(e1, size[0] / 2)), mul(e2, size[1] / 2));
      const tw = textWidth(f.code, hTag) + 1.2 * hTag;
      masks.push([tagAt[0] - tw / 2 - hTag * 0.3, tagAt[1] - hTag * 1.25, tagAt[0] + tw / 2 + hTag * 0.3, tagAt[1] + hTag * 1.25]);
      const segs = cutBoxes(patternLines(poly, { kind: f.pattern, size, angle, start, stagger: f.stagger ?? 1 / 3 }), masks);
      for (const [a, b] of segs) out.push(lineE(a, b, IL.floor));
    } else if (f.pattern && f.pattern !== 'none') {
      out.push({ type: 'hatch', boundary: poly.map(P), pattern: f.pattern, scale: f.hatch_scale ?? scale * 0.5, layer: IL.floor });
    }
    if (inside(tagAt, poly)) tagBox(f.code, tagAt, hTag, IL.note, out);
    const a = Math.abs(polyArea(poly0)) / 1e6;
    areas[f.code] = areas[f.code] || { code: f.code, description: f.description, pattern: f.pattern, size: f.size, area_m2: 0, rooms: [] };
    areas[f.code].area_m2 += a;
    areas[f.code].rooms.push(name);
  }
  const legend = Object.values(areas).map((x) => ({ ...x, area_m2: r2(x.area_m2) }));
  if (legendAt) {
    let y = legendAt[1];
    out.push(textE(lang === 'en' ? 'FLOOR FINISHES' : 'CHÚ THÍCH VẬT LIỆU SÀN', [legendAt[0], y], 3 * scale, IL.text));
    y -= 8 * scale;
    for (const row of legend) {
      // swatch at the real joint size
      const sw = [legendAt[0], y - 12 * scale, legendAt[0] + 20 * scale, y];
      const swPoly = [[sw[0], sw[1]], [sw[2], sw[1]], [sw[2], sw[3]], [sw[0], sw[3]]];
      out.push(polyE(swPoly, true, IL.note));
      if (row.pattern === 'tile' || row.pattern === 'plank') {
        for (const [a, b] of patternLines(swPoly, { kind: row.pattern, size: row.size ?? [600, 600], start: [sw[0], sw[1]] })) out.push(lineE(a, b, IL.floor));
      }
      out.push(textE(`${row.code}  ${row.description}`, [sw[2] + 3 * scale, y - 4 * scale], 2.5 * scale, IL.note));
      out.push(textE(`${fmtM(row.area_m2)} m²  (${row.rooms.join(', ')})`, [sw[2] + 3 * scale, y - 9 * scale], 2 * scale, IL.note));
      y -= 17 * scale;
    }
  }
  return { entities: out, legend };
}

// ---------------------------------------------------------------- reflected ceiling plan

export const LIGHTS = {
  downlight: { code: 'LT-01', vi: 'Đèn downlight âm trần Ø90' },
  strip: { code: 'LT-02', vi: 'Đèn LED dây hắt trần' },
  ceiling_lamp: { code: 'LT-03', vi: 'Đèn ốp trần' },
  pendant: { code: 'LT-04', vi: 'Đèn thả' },
};

function lightSymbol(kind, p, out) {
  if (kind === 'downlight') {
    out.push({ type: 'circle', center: P(p), radius: 75, layer: IL.light });
    out.push(lineE([p[0] - 115, p[1]], [p[0] + 115, p[1]], IL.light), lineE([p[0], p[1] - 115], [p[0], p[1] + 115], IL.light));
  } else if (kind === 'ceiling_lamp') {
    out.push({ type: 'circle', center: P(p), radius: 250, layer: IL.light }, { type: 'circle', center: P(p), radius: 170, layer: IL.light });
    out.push(lineE([p[0] - 320, p[1]], [p[0] + 320, p[1]], IL.light), lineE([p[0], p[1] - 320], [p[0], p[1] + 320], IL.light));
  } else if (kind === 'pendant') {
    out.push({ type: 'circle', center: P(p), radius: 200, layer: IL.light });
    const k = 200 * Math.SQRT1_2;
    out.push(lineE([p[0] - k, p[1] - k], [p[0] + k, p[1] + k], IL.light), lineE([p[0] - k, p[1] + k], [p[0] + k, p[1] - k], IL.light));
  }
}

/** Points along a closed outline, about one per spacing on each edge, none at the corners. */
function alongEdges(poly, spacing) {
  const pts = [];
  for (const e of edgesOf(poly)) {
    const n = Math.max(1, Math.round(e.L / spacing));
    for (let k = 0; k < n; k++) pts.push(add(e.a, mul(e.t, ((k + 0.5) * e.L) / n)));
  }
  return pts;
}

/** Two-line ceiling tag: code over level, boxed. Returns the box. */
function ceilingTag(code, level, at, h, out) {
  const w = Math.max(textWidth(code, h), textWidth(level, h)) + 1.2 * h;
  const box = [at[0] - w / 2, at[1] - 1.9 * h, at[0] + w / 2, at[1] + 1.9 * h];
  out.push(rectE(box[0], box[1], box[2], box[3], IL.note), lineE([box[0], at[1]], [box[2], at[1]], IL.note));
  out.push(textE(code, [at[0], at[1] + 0.95 * h], h, IL.note, 'middle_center'), textE(level, [at[0], at[1] - 0.95 * h], h, IL.note, 'middle_center'));
  return box;
}

const fmtLevel = (mm) => (Math.abs(mm) < 0.5 ? '±0.000' : `${mm > 0 ? '+' : '-'}${(Math.abs(mm) / 1000).toFixed(3)}`);

/**
 * Reflected ceiling plan of each room: the drop band (lower ring along the walls) with its step line and the LED cove,
 * downlights in the band (or a grid when there is no band), a ceiling lamp in the middle (a pendant over a dining
 * table), level tags, the room name; then the light legend with counts.
 */
export function ceilingPlan({ rooms, finishes, items = [], offset = [0, 0], scale = 50, spacing = 1200, legendAt, lang = 'vi' }) {
  const out = [], warnings = [];
  const counts = {};
  const count = (kind, n = 1) => {
    counts[kind] = (counts[kind] ?? 0) + n;
  };
  const hName = 2.5 * scale, hTag = 2 * scale;
  for (const [name, poly0] of Object.entries(rooms)) {
    const c = finishes[name]?.ceiling;
    const poly = dejog(shiftPoly(poly0, offset));
    const ctr = centroid(poly);
    if (!c) {
      out.push(textE(name, ctr, hName, IL.room, 'middle_center'));
      out.push(textE(lang === 'en' ? '(open to the sky)' : '(không trần)', [ctr[0], ctr[1] - 1.8 * hName], 2 * scale, IL.note, 'middle_center'));
      continue;
    }
    const level = num(c.level ?? 3000, `${name}.ceiling.level`);
    const drop = c.drop;
    let field = poly;
    if (drop) {
      const inner = offsetPoly(poly, drop.width);
      if (!inner) warnings.push(`${name}: the room is too narrow for a ${drop.width} drop band: drawn flat`);
      else {
        field = inner;
        out.push(polyE(inner, true, IL.ceiling));
        if (drop.cove !== false) {
          const cove = offsetPoly(poly, drop.width + 80);
          if (cove) {
            out.push(polyE(cove, true, IL.strip, HID));
            counts.strip_m = (counts.strip_m ?? 0) + perimeter(cove) / 1000;
          }
        }
        const mid = offsetPoly(poly, drop.width / 2);
        for (const p of alongEdges(mid, spacing)) {
          lightSymbol('downlight', p, out);
          count('downlight');
        }
        const corner = mid.reduce((m, p) => (p[0] + p[1] < m[0] + m[1] ? p : m));
        ceilingTag(c.code, fmtLevel(level - drop.depth), corner, hTag * 0.8, out);
      }
    }
    const fc = centroid(field);
    const xs = field.map((p) => p[0]), ys = field.map((p) => p[1]);
    const gridLights = [];
    if (!drop || field === poly) {
      // flat ceiling: a grid of downlights about one per spacing, evenly in the room
      const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
      const nx = Math.max(1, Math.round(bw / spacing)), ny = Math.max(1, Math.round(bh / spacing));
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          const p = [Math.min(...xs) + ((i + 0.5) * bw) / nx, Math.min(...ys) + ((j + 0.5) * bh) / ny];
          if (inside(p, field)) {
            lightSymbol('downlight', p, out);
            count('downlight');
            gridLights.push(p);
          }
        }
      }
    }
    // Middle light: a pendant over each dining table of the room, else a ceiling lamp in dry rooms with a drop band.
    const tables = items.filter((it) => it.type === 'dining_table' && it.room === name);
    let lamp = null;
    if (tables.length) {
      for (const t of tables) {
        const p = add(frameMap(t, offset)([t.w / 2, t.d / 2]), [0, 0]);
        lightSymbol('pendant', p, out);
        count('pendant');
        lamp = lamp ?? p;
      }
    } else if (drop && field !== poly && c.center_light !== false) {
      lamp = fc;
      lightSymbol('ceiling_lamp', fc, out);
      count('ceiling_lamp');
    }
    // name above and level tag below the middle light (or between the grid lights)
    const clear = lamp ? 420 : gridLights.some((g) => Math.abs(g[0] - fc[0]) < 700 && Math.abs(g[1] - fc[1]) < 300) ? 260 : 0;
    const nameAt = [fc[0], fc[1] + clear + 0.9 * hName];
    out.push(textE(name, inside(nameAt, field) ? nameAt : fc, hName, IL.room, 'middle_center'));
    const tagAt = [fc[0], fc[1] - clear - 2.2 * hTag];
    ceilingTag(c.code, fmtLevel(level), inside(tagAt, field) ? tagAt : [fc[0], fc[1] - 2.2 * hTag], hTag, out);
  }
  const lights = [];
  for (const kind of ['downlight', 'ceiling_lamp', 'pendant']) {
    if (counts[kind]) lights.push({ kind, code: LIGHTS[kind].code, description: LIGHTS[kind].vi, unit: lang === 'en' ? 'pcs' : 'cái', qty: counts[kind] });
  }
  if (counts.strip_m) lights.push({ kind: 'strip', code: LIGHTS.strip.code, description: LIGHTS.strip.vi, unit: 'm', qty: r2(counts.strip_m) });
  if (legendAt) {
    let y = legendAt[1];
    out.push(textE(lang === 'en' ? 'LIGHTING LEGEND' : 'KÝ HIỆU ĐÈN', [legendAt[0], y], 3 * scale, IL.text));
    y -= 9 * scale;
    for (const l of lights) {
      const p = [legendAt[0] + 5 * scale, y];
      if (l.kind === 'strip') out.push(lineE([p[0] - 5 * scale, p[1]], [p[0] + 5 * scale, p[1]], IL.strip, HID));
      else lightSymbol(l.kind, p, out);
      out.push(textE(`${l.code}  ${l.description}: ${l.kind === 'strip' ? fmtM(l.qty, 1) : l.qty} ${l.unit}`, [p[0] + 9 * scale, p[1]], 2.5 * scale, IL.note, 'middle_left'));
      y -= 9 * scale;
    }
  }
  return { entities: out, lights, warnings };
}

// ---------------------------------------------------------------- interior elevation

/** Thickness of the wall whose face lies on edge e (from the plan model), or null. */
function wallThickness(M, e) {
  for (const w of M.walls) {
    for (const s of w.segs) {
      if (Math.abs(cross(s.d, e.t)) > 0.01) continue;
      const dAxis = Math.abs(dot(sub(e.a, s.a), [-s.d[1], s.d[0]]));
      if (dAxis <= Math.max(Math.abs(s.o1), Math.abs(s.o2)) + 5) {
        const ua = dot(sub(e.a, s.a), s.d), ub = dot(sub(e.b, s.a), s.d);
        if (Math.max(ua, ub) > 1 && Math.min(ua, ub) < s.L - 1) return s.t;
      }
    }
  }
  return null;
}

function bboxOf(shapes) {
  const xs = [], ys = [];
  for (const s of shapes) {
    const pts = s.k === 'l' ? [s.a, s.b] : s.k === 'pl' ? s.pts : [[s.c[0] - (s.r ?? s.rx), s.c[1] - (s.r ?? s.ry)], [s.c[0] + (s.r ?? s.rx), s.c[1] + (s.r ?? s.ry)]];
    for (const p of pts) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  }
  return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
}

/** Tile / panel joints on a wall area [u0, z0]-[u1, z1] (elevation coords), minus boxes. */
function wallJoints(area, f, boxes) {
  const [u0, z0, u1, z1] = area;
  if (u1 - u0 < 1 || z1 - z0 < 1) return [];
  const segs = [];
  const [tw, th] = f.size ?? [600, 300];
  if (f.pattern === 'tile') for (let z = z0 + th; z < z1 - 1; z += th) segs.push([[u0, z], [u1, z]]);
  if (f.pattern === 'tile' || f.pattern === 'panel') {
    const mid = (u0 + u1) / 2;
    const first = f.start === 'corner' ? u0 : mid - tw / 2 - Math.floor((mid - tw / 2 - u0) / tw) * tw;
    for (let u = first; u < u1 - 1; u += tw) if (u > u0 + 1) segs.push([[u, z0], [u, z1]]);
  }
  return cutBoxes(segs, boxes);
}

/**
 * Elevation of one wall of a room seen from inside: cut end walls, floor slab and ceiling (drop band cut at the ends),
 * the doors and windows of that wall, items backed on it (front view) and items along the side walls (side view), wall
 * finish joints, kitchen backsplash, skirting, dimension chains and material notes with leaders.
 */
export function interiorElevation({ spec, room, poly, finish, items = [], wall, at = [0, 0], scale = 30, label, lang = 'vi' }) {
  const M = buildModel(spec);
  const e = roomEdge(poly, wall, 'wall');
  const F = wallFrame(e);
  const out = [], notes = [], skipped = [];
  const X = (u) => at[0] + (u - F.u0);
  const Y = (z) => at[1] + z;
  const W = F.u1 - F.u0;
  const c = finish.ceiling;
  const level = c ? num(c.level ?? 3000, 'ceiling.level') : M.H.top;
  const drop = c?.drop ?? null;
  const low = drop ? level - drop.depth : level;
  const slab = M.H.slab ?? 100;
  // the end walls: the edges before and after this face (which is left depends on the viewing direction)
  const leftEdge = F.left === e.a ? e.prev : e.next, rightEdge = F.left === e.a ? e.next : e.prev;
  const tl = wallThickness(M, leftEdge) ?? 200, tr = wallThickness(M, rightEdge) ?? 200;

  // Openings in this wall.
  const ops = [];
  for (const op of M.openings) {
    const s = op.s;
    if (Math.abs(cross(s.d, F.r)) > 0.01) continue;
    const A = add(s.a, mul(s.d, op.span.from)), B = add(s.a, mul(s.d, op.span.to));
    if (Math.abs(dot(sub(A, e.a), F.n)) > Math.max(Math.abs(s.o1), Math.abs(s.o2)) + 5) continue;
    const ua = Math.max(F.u0, Math.min(F.u(A), F.u(B))), ub = Math.min(F.u1, Math.max(F.u(A), F.u(B)));
    if (ub - ua < 10) continue;
    ops.push({ ua, ub, sill: op.type === 'window' ? op.sill : 0, head: Math.min(op.head, low), type: op.type, tag: op.tag });
  }

  // Items seen: backed on this wall (front view), along the side walls in the half of the room near this wall (side view).
  const depth = Math.max(...poly.map((p) => dot(sub(e.a, p), F.n)));
  const seen = [];
  for (const it of items) {
    if (it.room !== undefined && it.room !== room) continue;
    const back = dot(sub(it.o, e.a), F.n);
    if (dot(it.ey, F.n) < -0.99 && back <= 10 && back >= -600) {
      const u = F.u(it.o);
      if (u + it.w < F.u0 + 1 || u > F.u1 - 1) continue;
      const shapes = it.def.front(it.w, it.d, it.h, it.opts, it.name).map((s) => mapShape(s, (p) => [u + p[0], p[1]]));
      seen.push({ it, view: 'front', shapes, box: bboxOf(shapes), dist: -back + it.d });
    } else if (Math.abs(dot(it.ey, F.n)) < 0.01) {
      // along a side wall: shown when it reaches this wall (a corner item), else it would clutter the elevation
      const near = Math.min(...[[0, 0], [it.w, 0], [0, it.d], [it.w, it.d]].map((q) => dot(sub(e.a, frameMap(it)(q)), F.n)));
      if (near > 150) continue;
      const sign = dot(it.ey, F.r) > 0 ? 1 : -1;
      const u = F.u(it.o);
      const shapes = it.def.side(it.w, it.d, it.h, it.opts, it.name).map((s) => mapShape(s, (p) => [u + sign * p[0], p[1]]));
      seen.push({ it, view: 'side', shapes, box: bboxOf(shapes), dist: near + it.w });
    } else if (dot(it.ey, F.n) < -0.99) skipped.push(`${it.code} ${it.type} (not against this wall)`);
  }
  // Silhouettes (closed outlines, not glass): the items nearest the viewer hide what is behind them.
  seen.sort((p, q) => q.dist - p.dist);
  const occ = [];
  const itemSegs = [];
  for (const s of seen) {
    const lay = (role) => (role === 'glass' ? IL.glass : role === 'hidden' ? IL.hidden : IL.elev);
    for (const sh of s.shapes) {
      const layer = lay(sh.role);
      if (sh.k === 'l' || sh.k === 'pl') {
        const pts = sh.k === 'l' ? [sh.a, sh.b] : sh.pts;
        const segs = [];
        for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
        if (sh.k === 'pl' && sh.closed) segs.push([pts[pts.length - 1], pts[0]]);
        for (const piece of cutBoxes(segs, occ)) itemSegs.push([piece, layer]);
      } else if (!occ.some((b) => sh.c[0] > b[0] && sh.c[0] < b[2] && sh.c[1] > b[1] && sh.c[1] < b[3])) {
        emit([sh], (q) => [X(q[0]), Y(q[1])], () => layer, out);
      }
    }
    for (const sh of s.shapes) {
      if (sh.k === 'pl' && sh.closed && sh.role !== 'glass' && sh.role !== 'hidden') {
        const xs = sh.pts.map((q) => q[0]), zs = sh.pts.map((q) => q[1]);
        occ.push([Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)]);
      }
    }
  }
  const itemBoxes = occ;
  const opBoxes = ops.map((o) => [o.ua, o.sill, o.ub, o.head]);

  // Structure cut: floor slab, end walls, ceiling.
  out.push(rectE(X(F.u0) - tl, Y(-slab), X(F.u1) + tr, Y(0), IL.cut));
  out.push({ type: 'hatch', boundary: [[X(F.u0) - tl, Y(-slab)], [X(F.u1) + tr, Y(-slab)], [X(F.u1) + tr, Y(0)], [X(F.u0) - tl, Y(0)]].map(P), pattern: 'AR-CONC', scale: 0.04 * scale, layer: IL.cutPatt });
  for (const [x0, x1] of [[X(F.u0) - tl, X(F.u0)], [X(F.u1), X(F.u1) + tr]]) {
    out.push(rectE(x0, Y(0), x1, Y(level + 100), IL.cut));
    out.push({ type: 'hatch', boundary: [[x0, Y(0)], [x1, Y(0)], [x1, Y(level + 100)], [x0, Y(level + 100)]].map(P), pattern: 'ANSI31', scale: 0.4 * scale, layer: IL.cutPatt });
  }
  out.push(lineE([X(F.u0), Y(0)], [X(F.u1), Y(0)], IL.elevOut));
  out.push(lineE([X(F.u0), Y(level)], [X(F.u1), Y(level)], IL.elev));
  if (drop) {
    out.push(lineE([X(F.u0), Y(low)], [X(F.u1), Y(low)], IL.elev));
    for (const u of [F.u0 + drop.width, F.u1 - drop.width]) if (u > F.u0 && u < F.u1) out.push(lineE([X(u), Y(low)], [X(u), Y(level)], IL.elev));
    for (const [ua, ub] of [[F.u0, F.u0 + drop.width], [F.u1 - drop.width, F.u1]]) out.push(rectE(X(ua), Y(low), X(ub), Y(level), IL.cut));
  }

  // Wall finish, backsplash, skirting.
  const sk = finish.skirting;
  const skH = sk ? num(sk.height ?? 100, 'skirting.height') : 0;
  const wf = finish.wall;
  const blocks = [...opBoxes, ...itemBoxes];
  let splash = null;
  const base = seen.find((s) => s.view === 'front' && s.it.type === 'kitchen_base');
  const upper = seen.find((s) => s.view === 'front' && s.it.type === 'kitchen_wall');
  if (base) {
    const ua = base.box[0], ub = base.box[2];
    const zTop = upper ? upper.box[1] : Math.min(low, base.box[3] + 650);
    splash = [Math.max(F.u0, ua), base.box[3], Math.min(F.u1, ub), zTop];
    const others = blocks.filter((b) => b !== base.box && b !== upper?.box);
    for (const [a, b] of wallJoints(splash, BACKSPLASH, others)) out.push(lineE([X(a[0]), Y(a[1])], [X(b[0]), Y(b[1])], IL.elevPatt));
  }
  if (wf && (wf.pattern === 'tile' || wf.pattern === 'panel')) {
    const zTo = wf.height === 'ceiling' || wf.height === undefined ? low : Math.min(low, num(wf.height, 'wall.height'));
    const area = [F.u0, skH, F.u1, zTo];
    for (const [a, b] of wallJoints(area, wf, splash ? [...blocks, splash] : blocks)) out.push(lineE([X(a[0]), Y(a[1])], [X(b[0]), Y(b[1])], IL.elevPatt));
    if (wf.height !== 'ceiling' && zTo < low - 1) out.push(lineE([X(F.u0), Y(zTo)], [X(F.u1), Y(zTo)], IL.elev));
  }
  if (sk) {
    const gaps = [...ops.filter((o) => o.sill < skH).map((o) => [o.ua, 0, o.ub, skH]), ...itemBoxes.filter((b) => b[1] < skH)];
    for (const [a, b] of cutBoxes([[[F.u0, skH], [F.u1, skH]]], gaps.map((g) => [g[0], -1, g[2], skH + 1]))) out.push(lineE([X(a[0]), Y(a[1])], [X(b[0]), Y(b[1])], IL.elev));
  }

  // Openings (hidden where furniture stands in front), then the items.
  const opSegs = [];
  const rectSegs = (a, b, c, d) => [[[a, b], [c, b]], [[c, b], [c, d]], [[c, d], [a, d]], [[a, d], [a, b]]];
  for (const o of ops) {
    const f = 50;
    opSegs.push(...rectSegs(o.ua, o.sill, o.ub, o.head).map((sg) => [sg, IL.elev]));
    if (o.type === 'window') {
      opSegs.push(...rectSegs(o.ua + f, o.sill + f, o.ub - f, o.head - f).map((sg) => [sg, IL.glass]));
      if (o.ub - o.ua > 900) opSegs.push([[[(o.ua + o.ub) / 2, o.sill + f], [(o.ua + o.ub) / 2, o.head - f]], IL.glass]);
    } else if (o.type !== 'opening') {
      opSegs.push([[[o.ua + f, 0], [o.ua + f, o.head - f]], IL.elev], [[[o.ua + f, o.head - f], [o.ub - f, o.head - f]], IL.elev], [[[o.ub - f, o.head - f], [o.ub - f, 0]], IL.elev]);
      const double = o.type === 'double_door' || o.ub - o.ua > 1200;
      if (double) opSegs.push([[[(o.ua + o.ub) / 2, 0], [(o.ua + o.ub) / 2, o.head - f]], IL.elev]);
      const hx = double ? [(o.ua + o.ub) / 2 - 80, (o.ua + o.ub) / 2 + 80] : [o.ub - f - 80];
      for (const x of hx) opSegs.push([[[x - 60, 1000], [x + 60, 1000]], IL.elev]);
    }
  }
  const done = new Set();
  for (const [sg, layer] of [...opSegs.flatMap(([sg, layer]) => cutBoxes([sg], occ).map((pc) => [pc, layer])), ...itemSegs]) {
    // modules side by side share their edges: one line each
    const k = [sg[0], sg[1]].map((q) => `${Math.round(q[0] * 2)},${Math.round(q[1] * 2)}`).sort().join('|') + layer;
    if (done.has(k)) continue;
    done.add(k);
    out.push(lineE([X(sg[0][0]), Y(sg[0][1])], [X(sg[1][0]), Y(sg[1][1])], layer, layer === IL.hidden ? HID : undefined));
  }

  // Dimensions: horizontal chain (ends, openings, items backed on the wall) and heights.
  const us = [F.u0, F.u1, ...ops.flatMap((o) => [o.ua, o.ub]), ...seen.filter((s) => s.view === 'front').flatMap((s) => [s.box[0], s.box[2]])]
    .filter((u) => u >= F.u0 - 1 && u <= F.u1 + 1).sort((a, b) => a - b)
    .filter((u, i, arr) => i === 0 || u - arr[i - 1] > 20);
  const yDim = Y(-slab) - 8 * scale;
  out.push({ type: 'dim_chain', points: us.map((u) => P([X(u), Y(0)])), direction: 'horizontal', at: P([X(F.u0), yDim]), total: us.length > 2, gap: 12 * scale, style: dimStyleName(scale), layer: IL.dims });
  const zs = [0, low, level, ...ops.flatMap((o) => (o.type === 'window' ? [o.sill, o.head] : [o.head]))]
    .sort((a, b) => a - b).filter((z, i, arr) => i === 0 || z - arr[i - 1] > 20);
  const xDim = X(F.u0) - tl - 8 * scale;
  out.push({ type: 'dim_chain', points: zs.map((z) => P([X(F.u0) - tl, Y(z)])), direction: 'vertical', at: P([xDim, Y(0)]), total: zs.length > 2, gap: 12 * scale, style: dimStyleName(scale), layer: IL.dims });

  // Material notes in a column on the right, leaders to the element, ordered from the top.
  const freeAt = (zs2) => {
    for (const z of zs2) {
      for (let k = 1; k < 10; k++) {
        const u = F.u0 + (W * k) / 10;
        if (![...blocks, ...(splash ? [splash] : [])].some((b) => u > b[0] - 50 && u < b[2] + 50 && z > b[1] - 50 && z < b[3] + 50)) return [u, z];
      }
    }
    return [F.u0 + W / 2, zs2[0]];
  };
  if (c) notes.push({ text: `${c.code} ${c.description}`, target: drop ? [F.u0 + drop.width / 2, (low + level) / 2] : [F.u0 + W * 0.3, level] });
  if (wf) notes.push({ text: `${wf.code} ${wf.description}`, target: freeAt([low * 0.62, low * 0.8, low * 0.45]) });
  if (splash) notes.push({ text: `${BACKSPLASH.code} ${BACKSPLASH.description}`, target: [(splash[0] + splash[2]) / 2 + 150, (splash[1] + splash[3]) / 2] });
  for (const s of seen) notes.push({ text: `${s.it.code} ${s.it.description}`, target: [(s.box[0] + s.box[2]) / 2, (s.box[1] + s.box[3]) / 2] });
  if (sk) notes.push({ text: `${sk.code} ${sk.description}`, target: freeAt([skH / 2]) });
  if (finish.floor) notes.push({ text: `${finish.floor.code} ${finish.floor.description}`, target: [F.u0 + W * 0.15, 0] });
  const hN = 2.5 * scale, gapN = 2.6 * hN;
  const xN = X(F.u1) + tr + 12 * scale;
  notes.sort((p, q) => q.target[1] - p.target[1]);
  let yPrev = Infinity;
  for (const n of notes) {
    const y = Math.min(Y(n.target[1]), yPrev - gapN);
    yPrev = y;
    const tgt = [X(n.target[0]), Y(n.target[1])];
    out.push({ type: 'circle', center: P(tgt), radius: r2(0.6 * scale), layer: IL.note });
    out.push(polyE([tgt, [xN - 4 * scale, y], [xN - 1 * scale, y]], false, IL.note));
    out.push(textE(n.text, [xN, y], hN, IL.note, 'middle_left'));
  }
  const notesW = Math.max(0, ...notes.map((n) => textWidth(n.text, hN)));
  const lbl = label ?? String(wall).toUpperCase();
  const titleY = Math.min(yDim - 20 * scale, yPrev - 10 * scale);
  title(lang === 'en' ? `ELEVATION ${lbl} - ${room}` : `MẶT ĐỨNG ${lbl} - ${room}`, (X(F.u0) + X(F.u1)) / 2, titleY, scale, out);
  return {
    entities: out,
    extent: { min: [xDim - 18 * scale, titleY - 10 * scale], max: [xN + notesW + 2 * scale, Y(level + 100)] },
    openings: ops.length, items: seen.map((s) => `${s.it.code} ${s.it.type} (${s.view})`), skipped,
  };
}

function mapShape(s, m) {
  if (s.k === 'l') return { ...s, a: m(s.a), b: m(s.b) };
  if (s.k === 'pl') return { ...s, pts: s.pts.map(m) };
  if (s.k === 'c') return { ...s, c: m(s.c) };
  if (s.k === 'el') return { ...s, c: m(s.c) };
  return s;
}

// ---------------------------------------------------------------- joinery details

const JN_MATERIALS = {
  carcass: 'JN-01 Thùng tủ MDF lõi xanh chống ẩm 17 mm phủ melamine',
  door: 'Cánh MDF lõi xanh chống ẩm 17 mm phủ melamine',
  back: 'Hậu tủ MDF 8 mm',
  top: 'Mặt đá granite 20 mm',
  plinth: 'Chân tủ nhựa chống nước cao 100',
  backsplash: 'WL-03 Gạch ốp tường bếp 600x300',
  rod: 'Thanh treo quần áo inox Ø25',
  handle: 'Tay nắm nhôm âm cánh',
};

/**
 * Joinery detail: kind kitchen (base + wall cabinets) or wardrobe. Front elevation with its modules, doors (hinge
 * dashed), drawers, handles, dimension chains; section 1-1 through the carcass with panel thicknesses and material
 * notes. Sizes in mm; materials {carcass, door, back, top, plinth, backsplash, rod, handle} replace the defaults.
 */
export function joineryDetail(p) {
  const sc = num(p.scale ?? 10, 'scale', { positive: true });
  const [x0, y0] = pt(p.at ?? [0, 0], 'at');
  const kind = p.kind ?? 'kitchen';
  if (!['kitchen', 'wardrobe'].includes(kind)) throw new PlanError('kind must be kitchen or wardrobe');
  const assumed = [];
  const mat = { ...JN_MATERIALS, ...(p.materials || {}) };
  const used = kind === 'kitchen' ? ['carcass', 'door', 'back', 'top', 'plinth', 'backsplash', 'handle'] : ['carcass', 'door', 'back', 'plinth', 'rod', 'handle'];
  for (const k of used) if (!p.materials?.[k]) assumed.push({ item: `materials.${k}`, value: JN_MATERIALS[k] });
  const T = num(p.panel ?? 17, 'panel', { positive: true });
  const out = [];
  const D = IL.detail, DC = IL.detailCut;
  const Xf = (x) => x0 + x, Yf = (z) => y0 + z;
  const front = (shapes) => emit(shapes, (q) => [Xf(q[0]), Yf(q[1])], (role) => (role === 'hidden' ? IL.hidden : D), out);
  const w = num(p.width ?? (kind === 'kitchen' ? 2400 : 1600), 'width', { positive: true });
  if (p.width === undefined) assumed.push({ item: 'width', value: w });
  const dimH = (pts, y, gap) => out.push({ type: 'dim_chain', points: pts.map(P), direction: 'horizontal', at: P([pts[0][0], y]), total: pts.length > 2, gap, style: dimStyleName(sc), layer: IL.dims });
  const dimV = (pts, x) => out.push({ type: 'dim_chain', points: pts.map(P), direction: 'vertical', at: P([x, pts[0][1]]), total: pts.length > 2, gap: 12 * sc, style: dimStyleName(sc), layer: IL.dims });
  let hTotal, secShapes = [], cutRects = [], zDims, title1, sectionX, handleRect, xDims, secDims = [];
  const notesFor = [];
  if (kind === 'kitchen') {
    const b = { d: 600, h: 850, plinth: 100, top: 20, toe: 50, ...(p.base || {}) };
    const wl = p.wall === null ? null : { d: 350, h: 700, z0: 1500, ...(p.wall || {}) };
    for (const [k, v] of Object.entries({ d: 600, h: 850, plinth: 100, top: 20 })) if (p.base?.[k] === undefined) assumed.push({ item: `base.${k}`, value: v });
    if (p.wall === undefined) assumed.push({ item: 'wall', value: 'wall cabinets 350 deep, 700 high, underside at 1500, over the whole run' });
    const mods = modulesOf(w, { modules: p.modules, sink: p.sink, hob: p.hob }, 'modules');
    const fr = [sR(0, 0, w, b.plinth), sR(0, b.h - b.top, w, b.h)];
    for (const m of mods) moduleFront(m, b.plinth, b.h - b.top, fr, 'top');
    // Wall cabinets: runs [{x, w, modules}] along the base (default one run over it), and the cooker hood between them.
    const runs = wl ? (p.wall_runs?.length ? p.wall_runs : [{ x: 0, w }]) : [];
    const hood = p.hood ? { w: 700, d: 480, h: 650, z0: 1600, ...p.hood } : null;
    for (const [i, r] of runs.entries()) {
      for (const m of modulesOf(num(r.w, `wall_runs[${i}].w`, { positive: true }), { modules: r.modules }, `wall_runs[${i}].modules`)) {
        moduleFront({ ...m, x0: m.x0 + r.x, x1: m.x1 + r.x }, wl.z0, wl.z0 + wl.h, fr, 'bottom');
      }
    }
    const hoodShapes = hood ? TYPES.hood.front(hood.w, hood.d, hood.h, { z0: hood.z0 }).map((s) => mapShape(s, (q) => [q[0] + hood.x, q[1]])) : [];
    fr.push(...hoodShapes);
    if (wl) {
      const hb = hood ? bboxOf(hoodShapes) : null;
      for (const [a, bb] of wallJoints([0, b.h, w, wl.z0], BACKSPLASH, hb ? [hb] : [])) fr.push(sL(a[0], a[1], bb[0], bb[1]));
    }
    front(fr);
    hTotal = wl ? wl.z0 + wl.h : b.h;
    // Section 1-1 through a door module under a wall cabinet.
    const under = (m) => runs.some((r) => (m.x0 + m.x1) / 2 >= r.x && (m.x0 + m.x1) / 2 <= r.x + r.w);
    const sm = mods.find((m) => (m.type === 'doors' || m.type === 'door') && under(m)) ?? mods.find((m) => m.type === 'doors' || m.type === 'door') ?? mods[0];
    sectionX = (sm.x0 + sm.x1) / 2 + (sm.x1 - sm.x0) / 4;
    zDims = [0, b.plinth, b.h - b.top, b.h, ...(wl ? [wl.z0, wl.z0 + wl.h] : [])];
    xDims = [0, ...mods.map((m) => m.x1)];
    const cd = b.d - 20 - T;
    const sf = cd + T - b.toe;
    cutRects = [
      ['top', [0, b.h - b.top, b.d, b.h], 'AR-SAND'],
      ['bottom', [8, b.plinth, cd, b.plinth + T]], ['back', [0, b.plinth + T, 8, b.h - b.top]],
      ['rail', [cd - 100, b.h - b.top - T, cd, b.h - b.top]], ['rail2', [8, b.h - b.top - T, 108, b.h - b.top]],
      ['shelf', [8, (b.plinth + b.h - b.top) / 2, cd - 20, (b.plinth + b.h - b.top) / 2 + T]],
      ['door', [cd, b.plinth + 3, cd + T, b.h - b.top - 3]], ['plinth', [sf - 16, 0, sf, b.plinth]],
    ];
    handleRect = [cd + T, b.h - b.top - 70, cd + T + 12, b.h - b.top - 40];
    secShapes = [sR(0, b.plinth, cd, b.h - b.top), sR(...handleRect)];
    if (wl) {
      const wd = wl.d - T;
      cutRects.push(
        ['wback', [0, wl.z0, 8, wl.z0 + wl.h]], ['wbottom', [8, wl.z0, wd, wl.z0 + T]], ['wtop', [8, wl.z0 + wl.h - T, wd, wl.z0 + wl.h]],
        ['wshelf', [8, wl.z0 + wl.h / 2 - T / 2, wd - 20, wl.z0 + wl.h / 2 + T / 2]], ['wdoor', [wd, wl.z0, wd + T, wl.z0 + wl.h]],
        ['splash', [0, b.h, 10, wl.z0]],
      );
      secShapes.push(sR(0, wl.z0, wd, wl.z0 + wl.h), sR(wd + T, wl.z0 + 40, wd + T + 12, wl.z0 + 70));
    }
    notesFor.push(['top', mat.top], ['door', mat.door], ['bottom', mat.carcass], ['back', mat.back], ['plinth', mat.plinth], ['handle', mat.handle]);
    if (wl) notesFor.push(['splash', mat.backsplash]);
    title1 = `MẶT ĐỨNG ${p.name ?? 'TỦ BẾP'}`;
    // Section depth dimensions: the base (bottom) and the wall cabinets (top).
    secDims = [[0, b.d, 0], ...(wl ? [[0, wl.d, wl.z0 + wl.h]] : [])];
  } else {
    const d = num(p.depth ?? 600, 'depth', { positive: true });
    const h = num(p.height ?? 2400, 'height', { positive: true });
    if (p.depth === undefined) assumed.push({ item: 'depth', value: 600 });
    if (p.height === undefined) assumed.push({ item: 'height', value: 2400 });
    front(TYPES.wardrobe.front(w, d, h));
    hTotal = h;
    const zt = h >= 2200 ? h - 450 : h - T;
    const n = Math.max(1, Math.round(w / 450));
    sectionX = w / n / 2;
    zDims = [0, 100, zt, h];
    xDims = [0, ...Array.from({ length: n }, (_, i) => ((i + 1) * w) / n)];
    const cd = d - T - 3;
    cutRects = [
      ['bottom', [8, 100, cd, 100 + T]], ['back', [0, 100 + T, 8, h - T]], ['topp', [8, h - T, cd, h]],
      ['shelf', [8, zt, cd, zt + T]], ['door', [cd + 3, 103, cd + 3 + T, zt - 2]], ['door2', [cd + 3, zt + 2, cd + 3 + T, h - 3]],
      ['plinth', [cd - 50 - 16, 0, cd - 50, 100]],
    ];
    handleRect = [cd + 3 + T, 950, cd + 3 + T + 12, 1250];
    secShapes = [sR(0, 100, cd, h), sC(cd / 2, zt - 80, 12.5), sR(...handleRect)];
    notesFor.push(['door', mat.door], ['bottom', mat.carcass], ['back', mat.back], ['plinth', mat.plinth], ['rod', mat.rod], ['handle', mat.handle]);
    title1 = `MẶT ĐỨNG ${p.name ?? 'TỦ ÁO'}`;
    secDims = [[0, d, 0]];
  }
  out.push(lineE([Xf(-200), Yf(0)], [Xf(w + 200), Yf(0)], DC));
  // Front: module widths and overall below; the heights are on the section next to it.
  dimH([...new Set(xDims.map(r2))].sort((a, b2) => a - b2).map((x) => [Xf(x), Yf(0)]), Yf(0) - 12 * sc, 10 * sc);
  for (const [za, zb, tz] of [[-3.8 * sc, -0.8 * sc, -3.8 * sc], [hTotal + 1 * sc, hTotal + 4 * sc, hTotal + 5 * sc]]) {
    out.push(polyE([[Xf(sectionX), Yf(za)], [Xf(sectionX), Yf(zb)]], false, IL.symbol, { width: 0.6 * sc }));
    out.push(textE('1', [Xf(sectionX) + 1.5 * sc, Yf(tz)], 3 * sc, IL.symbol));
  }
  title(title1, Xf(w / 2), Yf(0) - 32 * sc, sc, out);
  // Section to the right: wall (cut brick band), floor, cut panels, seen outlines, notes.
  const sx0 = Xf(w) + 50 * sc;
  const S = (s2, z) => [sx0 + s2, Yf(z)];
  const depthMax = Math.max(...cutRects.map((r) => r[1][2]));
  out.push(rectE(sx0 - 120, Yf(0), sx0, Yf(hTotal + 200), IL.cut));
  out.push({ type: 'hatch', boundary: [S(-120, 0), S(0, 0), S(0, hTotal + 200), S(-120, hTotal + 200)].map(P), pattern: 'ANSI31', scale: 0.4 * sc, layer: IL.cutPatt });
  out.push(lineE(S(-120, 0), S(depthMax + 200, 0), DC));
  emit(secShapes, (q) => S(q[0], q[1]), () => D, out);
  const rectAt = { handle: handleRect };
  for (const [key, [a, b2, c, d2], hatch] of cutRects) {
    rectAt[key] = [a, b2, c, d2];
    out.push(polyE([S(a, b2), S(c, b2), S(c, d2), S(a, d2)], true, DC));
    if (hatch) out.push({ type: 'hatch', boundary: [S(a, b2), S(c, b2), S(c, d2), S(a, d2)].map(P), pattern: hatch, scale: 0.02 * sc, layer: IL.detailPatt });
  }
  if (kind === 'wardrobe') rectAt.rod = [cutRects[0][1][2] / 2 - 12, zDims[2] - 92, cutRects[0][1][2] / 2 + 12, zDims[2] - 68];
  const hN = 2.5 * sc, xN = sx0 + depthMax + 25 * sc;
  const targets = notesFor.filter(([k]) => rectAt[k]).map(([k, text]) => {
    const r = rectAt[k];
    return { text, target: S((r[0] + r[2]) / 2, (r[1] + r[3]) / 2) };
  }).sort((a, b2) => b2.target[1] - a.target[1]);
  let yPrev = Infinity;
  for (const n of targets) {
    const y = Math.min(n.target[1], yPrev - 2.6 * hN);
    yPrev = y;
    out.push({ type: 'circle', center: P(n.target), radius: r2(0.5 * sc), layer: IL.note });
    out.push(polyE([n.target, [xN - 4 * sc, y], [xN - 1 * sc, y]], false, IL.note));
    out.push(textE(n.text, [xN, y], hN, IL.note, 'middle_left'));
  }
  for (const [s0, s1, z] of secDims) dimH([S(s0, z), S(s1, z)], z === 0 ? Yf(0) - 10 * sc : Yf(z) + 8 * sc, 10 * sc);
  dimV([...new Set(zDims)].sort((a, b2) => a - b2).map((z) => S(-120, z)), sx0 - 120 - 10 * sc);
  title('MẶT CẮT 1-1', sx0 + depthMax / 2, Yf(0) - 32 * sc, sc, out);
  const schedule = [{ code: kind === 'kitchen' ? 'JN-03' : 'JN-01', description: p.name ?? (kind === 'kitchen' ? 'Tủ bếp' : 'Tủ áo'), unit: 'bộ', qty: 1 }];
  return {
    entities: out, assumed, schedule,
    extent: { min: [Xf(-200) - 25 * sc, Yf(0) - 45 * sc], max: [xN + Math.max(...targets.map((t) => textWidth(t.text, hN)), 0), Yf(hTotal + 200)] },
  };
}

// ---------------------------------------------------------------- schedule

const CATEGORY = {
  FL: 'Sàn', SK: 'Len chân tường', WL: 'Tường hoàn thiện', CL: 'Trần', JN: 'Đồ gỗ đóng tại chỗ', FN: 'Nội thất rời',
  SN: 'Thiết bị vệ sinh', EQ: 'Thiết bị', LT: 'Đèn', DE: 'Trang trí', CU: 'Rèm',
};

/**
 * Finish and material schedule: floors and ceilings by area, skirting by length (doors deducted), walls by area
 * (openings deducted), backsplash, items and lights by count. One row per code with its rooms.
 */
export function materialSchedule({ spec, rooms, finishes, items = [], lights = [], lang = 'vi' }) {
  const M = spec?.walls?.length ? buildModel(spec) : null;
  const rows = new Map();
  const addRow = (code, description, unit, qty, where) => {
    const key = `${code}|${description}|${unit}`;
    const r = rows.get(key) ?? { code, category: CATEGORY[code.slice(0, 2)] ?? '', description, unit, qty: 0, rooms: new Set() };
    r.qty += qty;
    if (where) r.rooms.add(where);
    rows.set(key, r);
  };
  const splash = {};
  for (const b of items.filter((it) => it.type === 'kitchen_base')) {
    const up = items.find((it) => it.type === 'kitchen_wall' && it.room === b.room);
    const a = (b.w * Math.max(0, (up ? up.opts.z0 : b.h + 650) - b.h)) / 1e6;
    splash[b.room] = (splash[b.room] ?? 0) + a;
    addRow(BACKSPLASH.code, BACKSPLASH.description, 'm²', a, b.room);
  }
  for (const [name, poly] of Object.entries(rooms)) {
    const f = finishes[name];
    if (!f) continue;
    const area = Math.abs(polyArea(poly)) / 1e6;
    const per = perimeter(poly) / 1000;
    const ops = [];
    if (M) {
      for (const e of edgesOf(poly)) {
        const F = wallFrame(e);
        for (const op of M.openings) {
          const s = op.s;
          if (Math.abs(cross(s.d, F.r)) > 0.01) continue;
          const A = add(s.a, mul(s.d, op.span.from)), B = add(s.a, mul(s.d, op.span.to));
          if (Math.abs(dot(sub(A, e.a), F.n)) > Math.max(Math.abs(s.o1), Math.abs(s.o2)) + 5) continue;
          const ua = Math.max(F.u0, Math.min(F.u(A), F.u(B))), ub = Math.min(F.u1, Math.max(F.u(A), F.u(B)));
          if (ub - ua > 10) ops.push({ w: (ub - ua) / 1000, sill: op.type === 'window' ? op.sill : 0, head: op.head, door: op.type !== 'window' });
        }
      }
    }
    if (f.floor) addRow(f.floor.code, f.floor.description, 'm²', area, name);
    if (f.ceiling) addRow(f.ceiling.code, f.ceiling.description, 'm²', area, name);
    const low = f.ceiling ? (f.ceiling.level ?? 3000) - (f.ceiling.drop?.depth ?? 0) : (M?.H.top ?? 3000);
    if (f.skirting) addRow(f.skirting.code, f.skirting.description, 'm', Math.max(0, per - ops.filter((o) => o.door).reduce((s, o) => s + o.w, 0)), name);
    if (f.wall) {
      const hTo = f.wall.height === undefined || f.wall.height === 'ceiling' || f.wall.pattern === 'paint' ? low : Math.min(low, f.wall.height);
      const opArea = ops.reduce((s, o) => s + o.w * Math.max(0, Math.min(o.head, hTo) - o.sill) / 1000, 0);
      addRow(f.wall.code, f.wall.description, 'm²', Math.max(0, (per * hTo) / 1000 - opArea - (splash[name] ?? 0)), name);
    }
  }
  for (const it of items) addRow(it.code, it.description, lang === 'en' ? 'pcs' : 'cái', 1, it.room);
  for (const l of lights) addRow(l.code, l.description, l.unit, l.qty, l.room);
  const out = [...rows.values()].map((r) => ({ ...r, qty: r.unit === 'm²' || r.unit === 'm' ? r2(r.qty) : r.qty, rooms: [...r.rooms].join(', ') }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const HEAD = lang === 'en' ? ['CODE', 'ITEM', 'DESCRIPTION', 'LOCATION', 'UNIT', 'QTY'] : ['MÃ', 'HẠNG MỤC', 'MÔ TẢ', 'VỊ TRÍ', 'ĐV', 'KHỐI LƯỢNG'];
  const table = [HEAD, ...out.map((r) => [r.code, r.category, r.description, r.rooms, r.unit, r.qty])];
  return { rows: out, table };
}

// ---------------------------------------------------------------- plan copies

/** The plan description moved by d (walls, openings, columns, grids, rooms, stairs, levels, north), without its extra entities and section marks. */
export function shiftSpec(spec, d) {
  const mv = (p) => (Array.isArray(p) ? [Number(p[0]) + d[0], Number(p[1]) + d[1]] : p);
  return {
    ...spec,
    walls: (spec.walls || []).map((w) => ({ ...w, points: (w.points || []).map(mv) })),
    openings: (spec.openings || []).map((o) => ({ ...o, ...(o.at ? { at: mv(o.at) } : {}), ...(o.toward ? { toward: mv(o.toward) } : {}), ...(o.tag_at ? { tag_at: mv(o.tag_at) } : {}) })),
    columns: (spec.columns || []).map((c) => ({ ...c, at: mv(c.at) })),
    grids: spec.grids ? {
      ...spec.grids,
      x: (spec.grids.x || []).map((g) => (typeof g === 'object' ? { ...g, at: Number(g.at) + d[0] } : Number(g) + d[0])),
      y: (spec.grids.y || []).map((g) => (typeof g === 'object' ? { ...g, at: Number(g.at) + d[1] } : Number(g) + d[1])),
    } : undefined,
    rooms: (spec.rooms || []).map((r) => ({ ...r, at: mv(r.at), hatch: undefined })),
    stairs: (spec.stairs || []).map((s) => ({ ...s, start: mv(s.start) })),
    levels: (spec.levels || []).map((l) => ({ ...l, at: mv(l.at) })),
    north: spec.north ? { ...spec.north, at: mv(spec.north.at) } : undefined,
    sections: [],
    entities: [],
  };
}

/** Bounding box of draw_entities specs (points, centres, text positions). */
export function entityBounds(ents) {
  const xs = [], ys = [];
  for (const e of ents) {
    for (const p of [e.from, e.to, e.at, e.center, ...(e.points || []), ...(e.boundary || [])]) {
      if (Array.isArray(p)) {
        xs.push(p[0]);
        ys.push(p[1]);
      }
    }
  }
  return xs.length ? { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] } : null;
}
