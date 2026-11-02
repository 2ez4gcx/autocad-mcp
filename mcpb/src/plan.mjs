// Floor plan engine (pure geometry, lengths in mm): turns a plan spec (walls on axes, openings, columns, grids, stairs,
// rooms, symbols) into what the bridge's draw_plan command needs:
//   walls  : wall pieces per material (segment rectangles + junction polygons); the bridge unions them, so L/T/X
//            junctions come out clean, then cuts the openings and columns out of the outline and hatches it
//   cuts   : one rectangle per opening, columns: column footprints
//   rooms  : name + a point inside; the bridge measures the face the walls enclose (the area is never typed)
//   entities: doors, windows, grids, columns, stairs, symbols and dimension chains (draw_entities specs)
import { ROLE, TEXT_STYLE, dimStyleName } from './standards.mjs';

const EPS = 1e-6;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => { const l = len(a); return l < EPS ? [0, 0] : [a[0] / l, a[1] / l]; };
const left = (d) => [-d[1], d[0]];
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

function num(v, name, { min = -Infinity, positive = false } = {}) {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new PlanError(`${name} must be a number`);
  if (positive && n <= 0) throw new PlanError(`${name} must be > 0`);
  if (n < min) throw new PlanError(`${name} must be >= ${min}`);
  return n;
}

function pt(v, name) {
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

/** Normalised walls with their segments: axis a->b, direction d, face offsets [o1, o2] along left(d). */
function buildWalls(spec) {
  const walls = [];
  (spec.walls || []).forEach((w, wi) => {
    const name = `walls[${wi}]`;
    if (!Array.isArray(w.points) || w.points.length < 2) throw new PlanError(`${name}.points needs at least 2 points`);
    const pts = w.points.map((p, i) => pt(p, `${name}.points[${i}]`));
    const t = num(w.thickness ?? spec.wall_thickness ?? 200, `${name}.thickness`, { positive: true });
    const just = w.justify ?? 'center';
    const offs = { center: [-t / 2, t / 2], left: [0, t], right: [-t, 0] }[just];
    if (!offs) throw new PlanError(`${name}.justify must be center, left or right`);
    const material = w.material ?? spec.wall_material ?? 'brick';
    if (!(material in MATERIALS)) throw new PlanError(`${name}.material must be one of ${Object.keys(MATERIALS).join(', ')}`);
    if (w.closed && pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) > EPS) pts.push(pts[0]);
    const segs = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L = dist(a, b);
      if (L < 1) throw new PlanError(`${name}: segment ${i} is shorter than 1 mm`);
      segs.push({ wall: wi, index: i, a, b, d: unit(sub(b, a)), L, o1: offs[0], o2: offs[1], t });
    }
    walls.push({ id: w.id ?? `W${wi + 1}`, index: wi, segs, t, material, layer: w.layer });
  });
  return walls;
}

function segRect(s, from = 0, to = s.L, extra = 0) {
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

function findSegment(walls, o, name) {
  let w;
  if (typeof o.wall === 'number') w = walls[o.wall];
  else w = walls.find((x) => x.id === o.wall);
  if (!w) throw new PlanError(`${name}.wall '${o.wall}' not found (use a wall id or its index)`);
  const si = o.segment ?? 0;
  const s = w.segs[si];
  if (!s) throw new PlanError(`${name}.segment ${si} does not exist (wall ${w.id} has ${w.segs.length} segments)`);
  return { w, s };
}

/** Opening position along its segment: offset from the segment start, or "at" a point near the axis. */
function openingSpan(s, o, name) {
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

/** Door, window and opening symbols (plan view, cut above the sill). */
function openingSymbols(s, o, span, scale, name, center) {
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
      const leaves = type === 'double_door' ? [[span.from, mid], [span.to, mid]] : [o.hinge === 'end' ? [span.to, span.from] : [span.from, span.to]];
      for (const [h, f] of leaves) {
        const w = Math.abs(f - h);
        const hinge = at(h, face);
        const tip = P(add(hinge, mul(n, side * w)));
        const jamb = at(f, face);
        e.push({ type: 'line', from: hinge, to: tip, layer: doorLayer });
        // Swing arc from the open leaf back to the closing jamb.
        e.push({ type: 'arc', start: tip, mid: P(add(hinge, mul(unit(add(sub(tip, hinge), sub(jamb, hinge))), w))), end: jamb, layer: doorLayer });
      }
      break;
    }
    case 'sliding': {
      const t = s.o2 - s.o1;
      const c = (s.o1 + s.o2) / 2;
      const pw = (span.to - span.from) * 0.55;
      const th = Math.min(40, t / 4);
      e.push({ type: 'rectangle', from: at(span.from, c - th), to: at(span.from + pw, c), layer: doorLayer });
      e.push({ type: 'rectangle', from: at(span.to - pw, c), to: at(span.to, c + th), layer: doorLayer });
      break;
    }
    case 'window': {
      const c = (s.o1 + s.o2) / 2;
      const g = Math.min(25, (s.o2 - s.o1) / 8);
      for (const off of [s.o1, s.o2, c - g, c + g]) e.push({ type: 'line', from: at(span.from, off), to: at(span.to, off), layer: winLayer });
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
    e.push({
      type: 'text', text: String(o.tag), at: o.tag_at ? pt(o.tag_at, `${name}.tag_at`) : at(mid, face + tagSide * 2.5 * scale * 1.6), height: 2.5 * scale,
      align: 'middle_center', layer: ROLE.text, style: TEXT_STYLE,
    });
  }
  return e;
}

function rectAround(c, w, h, rotDeg = 0) {
  const r = (rotDeg * Math.PI) / 180;
  const u = [Math.cos(r), Math.sin(r)];
  const v = left(u);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => P(add(c, add(mul(u, (a * w) / 2), mul(v, (b * h) / 2)))));
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I and O skipped (read as 1 and 0)

function gridList(list, axis) {
  return (list || []).map((g, i) => {
    if (typeof g === 'number') return { at: g, label: axis === 'x' ? String(i + 1) : LETTERS[i % LETTERS.length] + (i >= LETTERS.length ? String(Math.floor(i / LETTERS.length)) : '') };
    return { at: num(g.at, `grids.${axis}[${i}].at`), label: String(g.label ?? (axis === 'x' ? i + 1 : LETTERS[i % LETTERS.length])) };
  });
}

/** Builds the draw_plan request. */
export function buildPlan(spec) {
  const scale = num(spec.scale ?? 100, 'scale', { positive: true });
  const lang = spec.language === 'en' ? 'en' : 'vi';
  const L = { ...ROLE, ...(spec.layers || {}) };
  const dimStyle = dimStyleName(scale);
  const walls = buildWalls(spec);
  const entities = [];
  const notes = [];

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
    entities.push(...openingSymbols(s, o, span, scale, name, center));
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
        const off = faceVal + sign * (first + k * gap);
        entities.push({
          type: 'dim_chain', points: c.map(mk), direction: horiz ? 'horizontal' : 'vertical',
          at: horiz ? [c[0], off] : [off, c[0]], style: dimStyle, layer: L.dims,
        });
      });
      chainsOut[side] = first + (chains.length - 1) * gap;
    }
  }

  // ---- grids: lines past the dimension chains, bubbles at both ends
  if (box && (grids.x.length || grids.y.length)) {
    const ext = num(spec.grids?.extend ?? 0, 'grids.extend', { min: 0 });
    const r = 4.5 * scale;
    const th = 4 * scale;
    const bubble = (c, label) => {
      entities.push({ type: 'circle', center: P(c), radius: r, layer: L.grid_tag });
      entities.push({ type: 'text', at: P(c), text: label, height: th, align: 'middle_center', layer: L.grid_tag, style: TEXT_STYLE });
    };
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

  // ---- stairs (straight flights): outline, treads, walking line with arrow, UP label
  (spec.stairs || []).forEach((st, i) => {
    const name = `stairs[${i}]`;
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
    entities.push({ type: 'polyline', points: [corner(g / 2, w / 2), tip], layer: L.stair });
    const ah = Math.min(g * 0.8, 3 * scale);
    entities.push({ type: 'polyline', points: [corner(run - g / 2 - ah, w / 2 - ah / 2), tip, corner(run - g / 2 - ah, w / 2 + ah / 2)], layer: L.stair });
    const lbl = st.label ?? LABELS[lang].up;
    if (lbl) {
      entities.push({
        type: 'text', text: lbl, at: corner(g * 0.5, w / 2 - 3 * scale), height: 2.5 * scale, rotation: (a * 180) / Math.PI,
        layer: L.text, style: TEXT_STYLE,
      });
    }
  });

  // ---- level marks (+0.000), section marks, north arrow
  (spec.levels || []).forEach((lv, i) => {
    const at = pt(lv.at, `levels[${i}].at`);
    const s = 3 * scale;
    entities.push({ type: 'polyline', points: [P(at), P(add(at, [-s / 2, s * 0.85])), P(add(at, [s / 2, s * 0.85]))], closed: true, layer: L.symbol });
    entities.push({ type: 'line', from: P(add(at, [-s / 2, s * 0.85])), to: P(add(at, [s * 4, s * 0.85])), layer: L.symbol });
    entities.push({ type: 'text', text: String(lv.value ?? '±0.000'), at: P(add(at, [s * 0.7, s * 1.1])), height: 2.5 * scale, layer: L.symbol, style: TEXT_STYLE });
  });
  (spec.sections || []).forEach((sc, i) => {
    const a = pt(sc.from, `sections[${i}].from`);
    const b = pt(sc.to, `sections[${i}].to`);
    const d = unit(sub(b, a));
    const nn = mul(left(d), sc.look === 'right' ? -1 : 1);
    const r = 4 * scale;
    for (const [p, q] of [[a, add(a, mul(d, 8 * scale))], [sub(b, mul(d, 8 * scale)), b]]) {
      entities.push({ type: 'polyline', points: [P(p), P(q)], width: 0.7 * scale, layer: L.symbol });
    }
    for (const p of [a, b]) {
      const c = add(p, mul(nn, r * 1.6));
      entities.push({ type: 'circle', center: P(c), radius: r, layer: L.symbol });
      entities.push({ type: 'text', text: String(sc.label ?? 'A'), at: P(c), height: 3.5 * scale, align: 'middle_center', layer: L.symbol, style: TEXT_STYLE });
    }
  });
  if (spec.north) {
    const at = pt(spec.north.at, 'north.at');
    const r = 8 * scale;
    const a = (((spec.north.angle ?? 90)) * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a)];
    const n = left(u);
    entities.push({ type: 'circle', center: P(at), radius: r, layer: L.symbol });
    entities.push({ type: 'polyline', points: [P(add(at, mul(u, r))), P(add(add(at, mul(u, -r * 0.7)), mul(n, r * 0.45))), P(at), P(add(add(at, mul(u, -r * 0.7)), mul(n, -r * 0.45)))], closed: true, layer: L.symbol });
    entities.push({ type: 'hatch', boundary: [P(add(at, mul(u, r))), P(at), P(add(add(at, mul(u, -r * 0.7)), mul(n, -r * 0.45)))], pattern: 'SOLID', layer: L.symbol });
    entities.push({ type: 'text', text: LABELS[lang].north, at: P(add(at, mul(u, r + 4 * scale))), height: 4 * scale, align: 'middle_center', layer: L.symbol, style: TEXT_STYLE });
  }

  // ---- extra free entities (furniture, notes...) pass through unchanged
  for (const e of spec.entities || []) entities.push(e);

  const rooms = (spec.rooms || []).map((r, i) => {
    const out = { name: String(r.name ?? ''), at: pt(r.at, `rooms[${i}].at`) };
    if (r.number !== undefined) out.number = String(r.number);
    if (r.area_m2 !== undefined) out.area_m2 = num(r.area_m2, `rooms[${i}].area_m2`);
    if (r.label === false) out.label = false;
    if (r.hatch) {
      out.hatch = { pattern: r.hatch.pattern ?? 'NET', scale: r.hatch.scale ?? scale * 0.5, angle: r.hatch.angle ?? 0, layer: L.floor_hatch };
    }
    return out;
  });

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
  };
}
