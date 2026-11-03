// Floor plan engine (pure geometry, lengths in mm): turns a plan spec (walls on axes, openings, columns, grids, stairs,
// rooms, symbols) into what the bridge's draw_plan command needs:
//   walls  : wall pieces per material (segment rectangles + junction polygons); the bridge unions them, so L/T/X
//            junctions come out clean, then cuts the openings and columns out of the outline and hatches it
//   cuts   : one rectangle per opening, columns: column footprints
//   rooms  : name + a point inside; the bridge measures the face the walls enclose (the area is never typed)
//   entities: doors, windows, grids, columns, stairs, symbols and dimension chains (draw_entities specs)
import { ROLE, TEXT_STYLE, dimStyleName } from './standards.mjs';
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

/** Normalised walls with their segments: axis a->b, direction d, face offsets [o1, o2] along left(d). */
export function buildWalls(spec) {
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
  const s = w.segs[si];
  if (!s) throw new PlanError(`${name}.segment ${si} does not exist (wall ${w.id} has ${w.segs.length} segments)`);
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

const DOOR_TYPES = { door: 'Cửa đi 1 cánh', double_door: 'Cửa đi 2 cánh', sliding: 'Cửa lùa', window: 'Cửa sổ' };
const r1 = (v) => Math.round(v * 10) / 10;

/**
 * A door or window as a block insert: drawn in its own frame (origin, x along the wall, y across it) and inserted with
 * the rotation and mirror that map it onto (ex, ey). One definition per kind and size (and wall thickness for windows
 * and sliding doors); code, kind and width as invisible attributes (a door/window count by block name).
 */
function openingBlock(kind, size, entities, origin, ex, ey, o, layer) {
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
      attributes: [['MA', 'Mã cửa'], ['LOAI', 'Loại'], ['RONG', 'Rộng']].map(([tag, prompt], i) => (
        { tag, prompt, at: [size[0] / 2, -100 - 120 * i], height: 80, invisible: true, style: TEXT_STYLE })),
    },
    box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
  };
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
    // the code in a tag block, clear of the wall face
    e.push(tagSym(String(o.tag), o.tag_at ? pt(o.tag_at, `${name}.tag_at`) : at(mid, face + tagSide * 4 * scale), scale, ROLE.text, 'hex'));
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
  const noT = spec.wall_thickness === undefined ? ids(spec.walls, (w) => w.thickness === undefined, 'walls') : [];
  if (noT.length) add('walls.thickness', 200, noT.join(', '));
  const noM = spec.wall_material === undefined ? ids(spec.walls, (w) => w.material === undefined, 'walls') : [];
  if (noM.length) add('walls.material', 'brick', noM.join(', '));
  const noW = ids(spec.openings, (o) => o.width === undefined, 'openings');
  if (noW.length) add('openings.width', 900, noW.join(', '));
  const noC = ids(spec.columns, (c) => c.size === undefined, 'columns');
  if (noC.length) add('columns.size', '400x400', noC.join(', '));
  if (spec.grid_columns && spec.grid_columns.size === undefined) add('grid_columns.size', '400x400');
  for (const [i, st] of (spec.stairs || []).entries()) {
    if (st.type === 'u') continue;
    for (const [k, v] of [['width', 1200], ['treads', 10], ['going', 270]]) if (st[k] === undefined) add(`stairs[${i}].${k}`, v);
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

/** Plan of a U stair: outline, treads, landing, well, walking lines with arrows, UP / DOWN labels, cut line. */
function uStairPlan(g, mode, scale, L, lang, entities) {
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
    textAt(LABELS[lang].up, a0 - 3 * scale, m1);
  }
  if (mode === 'down' || mode === 'both') {
    pl([[start2 + going / 2, m2], [mL, m2], ...(mode === 'down' ? [[mL, m1], [a0 + going / 2, m1]] : [[mL, m1]])]);
    if (mode === 'down') arrow(a0 + going / 2, m1, -1);
    else pl([[mL - ah / 2, m1 + ah], [mL, m1], [mL + ah / 2, m1 + ah]]);
    textAt(LABELS[lang].down, start2 - 3 * scale, m2);
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
  (spec.stairs || []).forEach((st, i) => {
    if (st.type !== 'u') return;
    const g = uStairGeom(st, floorH, `stairs[${i}]`);
    notes.push(...g.warnings);
    uStairPlan(g, (spec.stairs_below || []).some((b) => same(b, st)) ? 'both' : 'up', scale, L, lang, entities);
  });
  (spec.stairs_below || []).forEach((st, i) => {
    if ((spec.stairs || []).some((x) => x.type === 'u' && same(x, st))) return;
    uStairPlan(uStairGeom(st, st.height ?? floorH, `stairs_below[${i}]`), 'down', scale, L, lang, entities);
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
  (spec.stairs || []).forEach((st, i) => {
    if (st.type === 'u') return;
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
  const wallBoxes = walls.flatMap((w) => w.segs.map((s) => bboxOf(segRect(s))));
  (spec.levels || []).forEach((lv, i) => {
    const at = pt(lv.at, `levels[${i}].at`);
    // the mark reads to the right, or to the left when a wall is in the way on the right
    const right = [at[0] - 1.5 * scale, at[1], at[0] + 12 * scale, at[1] + 6 * scale];
    const leftBox = [at[0] - 12 * scale, at[1], at[0] + 1.5 * scale, at[1] + 6 * scale];
    const flip = lv.side === 'left' || (lv.side === undefined && wallBoxes.some((b) => boxesOverlap(b, right)) && !wallBoxes.some((b) => boxesOverlap(b, leftBox)));
    entities.push(sym(flip ? 'MCP_COTE_TRAI' : 'MCP_COTE', at, { scale, attrs: { COTE: String(lv.value ?? '±0.000') }, layer: L.symbol }));
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
