// Shared by the electrical and plumbing sets (mm): the kind of a room from its name, the doors of each room (from the
// plan model), the wall faces of a room with the runs free of openings and spots on them for devices, nearest-neighbour
// chains, wiring arcs and pipe runs, labels kept clear of each other and the legend of a sheet. Pure geometry.
import { buildModel } from './elevation.mjs';
import { centroid, edgesOf, inside, openingsOn, overlaps, runsBetween, textWidth, wallFrame } from './interior.mjs';
import { TEXT_STYLE } from './standards.mjs';
import { sym } from './symbols.mjs';

export const r2 = (v) => Math.round(v * 100) / 100;
export const P = (p) => [r2(p[0]), r2(p[1])];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => len(sub(a, b));
export const unit = (a) => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};
export const deg = (v) => r2((Math.atan2(v[1], v[0]) * 180) / Math.PI);

/** Options over the defaults, one level deep, as new objects: a design never changes the defaults of the next one. */
export function mergeOptions(defaults, given) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const out = {};
  for (const [k, v] of Object.entries(defaults)) out[k] = isObj(v) ? { ...v } : v;
  for (const [k, v] of Object.entries(given || {})) out[k] = isObj(v) && isObj(out[k]) ? { ...out[k], ...v } : v;
  return out;
}

export const lineE = (a, b, layer, extra) => ({ type: 'line', from: P(a), to: P(b), layer, ...(extra || {}) });
export const polyE = (pts, closed, layer, extra) => ({ type: 'polyline', points: pts.map(P), closed, layer, ...(extra || {}) });
export const textE = (text, at, h, layer, align = 'left', rotation = 0) => ({
  type: 'text', text: String(text), at: P(at), height: r2(h), align, layer, style: TEXT_STYLE, ...(rotation ? { rotation: r2(rotation) } : {}),
});

// ---------------------------------------------------------------- rooms

const KINDS = [
  ['wc', /(WC|VỆ SINH|TẮM|TOILET|BATH)/i],
  ['kitchen', /(BẾP|KITCHEN)/i],
  ['stair', /(CẦU THANG|STAIR)/i],
  ['terrace', /(SÂN THƯỢNG|TERRACE|ROOF)/i],
  ['laundry', /(SÂN PHƠI|GIẶT|LAUNDRY)/i],
  ['outdoor', /(SÂN|HIÊN|BAN CÔNG|LÔ GIA|LOGIA|BALCONY|PORCH|YARD)/i],
  ['bedroom', /(NGỦ|BEDROOM)/i],
  ['living', /(KHÁCH|SINH HOẠT|LIVING|FAMILY)/i],
  ['worship', /(THỜ|ALTAR|WORSHIP)/i],
  ['hall', /(SẢNH|HÀNH LANG|HALL|LOBBY|CORRIDOR)/i],
  ['storage', /(KHO|STORE|STORAGE)/i],
  ['dining', /(ĂN|DINING)/i],
  ['office', /(LÀM VIỆC|OFFICE|ĐỌC|STUDY)/i],
];

/** Kind of a room from its name: wc, kitchen, stair, terrace, laundry, outdoor, bedroom, living, worship, hall, storage, dining, office, room. */
export const roomKind = (name) => KINDS.find(([, re]) => re.test(String(name)))?.[0] ?? 'room';
export const isOutdoor = (kind) => ['terrace', 'laundry', 'outdoor'].includes(kind);

/** The plan model of a floor (walls, openings), or null when it has no walls. */
export function planModel(spec) {
  try {
    return spec?.walls?.length ? buildModel(spec) : null;
  } catch {
    return null;
  }
}

/**
 * Doors and openings (not windows) of a floor with the rooms on each side: [{i, type, width, from, to (jambs on the wall
 * axis), mid, d (along the wall), hinge ('from' | 'to'), sides: {room: {inw (into that room), face (offset of its face)}},
 * outside: inw of the side with no room or null}].
 */
export function floorDoors(M, spec, rooms) {
  if (!M) return [];
  return M.openings.map((op, i) => ({ op, o: spec.openings?.[i] ?? {}, i })).filter(({ op }) => op.type !== 'window').map(({ op, o, i }) => {
    const s = op.s, n = [-s.d[1], s.d[0]];
    const mid = add(s.a, mul(s.d, (op.span.from + op.span.to) / 2));
    const sides = {};
    let outside = null;
    for (const [face, sg] of [[s.o2, 1], [s.o1, -1]]) {
      const p = add(mid, mul(n, face + sg * 80));
      const name = Object.keys(rooms).find((k) => inside(p, rooms[k]));
      if (name) sides[name] = { inw: mul(n, sg), face };
      else outside = { inw: mul(n, sg), face };
    }
    return {
      i, type: op.type, width: op.span.to - op.span.from, from: add(s.a, mul(s.d, op.span.from)), to: add(s.a, mul(s.d, op.span.to)),
      mid, d: s.d, hinge: o.hinge === 'end' ? 'to' : 'from', sides, outside, tag: o.tag,
    };
  });
}

/**
 * Wall faces of a room (edges of 600 and more) with their runs free of openings (150 kept clear of each jamb and corner),
 * longest free run first.
 */
export function roomFaces(poly, M) {
  return edgesOf(poly).filter((e) => e.L >= 600).map((e) => {
    const F = wallFrame(e);
    const mid = add(e.a, mul(e.t, e.L / 2));
    const inw = inside(add(mid, mul(e.n, -20)), poly) ? mul(e.n, -1) : e.n;
    const gaps = openingsOn(M, e, F).map((o) => [o.ua - 150, o.ub + 150]);
    const runs = runsBetween(F.u0 + 150, F.u1 - 150, gaps).filter(([a, b]) => b - a >= 250);
    const longest = runs.reduce((m, r) => (r[1] - r[0] > m[1] - m[0] ? r : m), [0, 0]);
    return { e, F, inw, runs, used: [], L: e.L, longest, run: longest[1] - longest[0], gaps };
  }).sort((p, q) => q.run - p.run);
}

/** The point at u along a face, off into the room. */
export const facePoint = (fc, u, off = 0) => add(add(fc.F.left, mul(fc.F.r, u - fc.F.u0)), mul(fc.inw, off));
/** Position along a face of a point. */
export const faceU = (fc, p) => fc.F.u(p);
/** The middle of the longest free run of a face. */
export const runMid = (fc) => (fc.longest[0] + fc.longest[1]) / 2;

/** A free position on face fc as near u as possible: inside a free run, gap from the positions taken; null if none. */
export function takeSpot(fc, u, gap = 350) {
  const cands = [];
  for (const [a, b] of fc.runs) {
    const x0 = Math.min(b, Math.max(a, u));
    for (let k = 0; k <= 8; k++) for (const sgn of k ? [1, -1] : [1]) cands.push(x0 + sgn * k * gap * 0.5);
  }
  cands.sort((p, q) => Math.abs(p - u) - Math.abs(q - u));
  for (const x of cands) {
    if (!fc.runs.some(([a, b]) => x >= a - 1 && x <= b + 1)) continue;
    if (fc.used.some((v) => Math.abs(v - x) < gap)) continue;
    fc.used.push(x);
    return x;
  }
  return null;
}

/** The face of a room the door lies on (for this room's side), or null. */
export function doorFace(faces, door) {
  return faces.find((fc) => Math.abs(dot(sub(door.mid, fc.e.a), fc.F.n)) < 400 && Math.abs(dot(fc.F.r, door.d)) > 0.99
    && fc.F.u(door.mid) > fc.F.u0 - 1 && fc.F.u(door.mid) < fc.F.u1 + 1) ?? null;
}

/** The faces opposite and beside a reference face. */
export const oppositeFaces = (faces, fc) => faces.filter((x) => x !== fc && dot(x.inw, fc.inw) < -0.99);
export const sideFaces = (faces, fc) => faces.filter((x) => x !== fc && Math.abs(dot(x.inw, fc.inw)) < 0.01);

/** Order points by nearest neighbour from a start point. */
export function chain(start, items, at = (x) => x.at) {
  const rest = [...items], out = [];
  let p = start;
  while (rest.length) {
    let k = 0;
    for (let j = 1; j < rest.length; j++) if (dist(p, at(rest[j])) < dist(p, at(rest[k]))) k = j;
    out.push(rest[k]);
    p = at(rest[k]);
    rest.splice(k, 1);
  }
  return out;
}

/** A wiring arc from a to b (a polyline with one bulge), its length about 3% over the chord. */
export const arcE = (a, b, layer, bulge = 0.18, extra) => ({ type: 'polyline', points: [P(a), P(b)], bulges: [bulge, 0], closed: false, layer, ...(extra || {}) });

/** Outline of a text entity (an estimate, with a margin of pad text heights): for a mask under it. */
export function textOutline(e, pad = 0.25) {
  const h = e.height, w = textWidth(e.text, h), al = e.align ?? 'left', m = pad * h;
  const dx = /right/.test(al) ? -w : /center/.test(al) ? -w / 2 : 0;
  const dy = /^middle/.test(al) ? -h / 2 : /^top/.test(al) ? -h : 0;
  const a = ((e.rotation ?? 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[dx - m, dy - m], [dx + w + m, dy - m], [dx + w + m, dy + h + m], [dx - m, dy + h + m]].map(([x, y]) => P([e.at[0] + x * c - y * s, e.at[1] + x * s + y * c]));
}

/** A mask (wipeout) over an outline: what was drawn before it under the outline is hidden. */
export const maskE = (points, layer) => ({ type: 'wipeout', points, layer });

const segHitsBox = (a, b, bx) => {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [[-d[0], a[0] - bx[0]], [d[0], bx[2] - a[0]], [-d[1], a[1] - bx[1]], [d[1], bx[3] - a[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
};

/**
 * The entities with every text that one of their lines, polylines or arcs crosses moved to the end, each behind a
 * mask: the wire or the pipe breaks at the text instead of running through it. Texts that nothing crosses stay as
 * they are.
 */
export function maskTexts(ents) {
  const segs = [];
  for (const e of ents) {
    if (e.type === 'line' && e.from && e.to) segs.push([e.from, e.to]);
    else if (e.type === 'polyline' && Array.isArray(e.points)) {
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) {
        const a = e.points[i], b = e.points[(i + 1) % n], bulge = e.bulges?.[i] ?? 0;
        if (!bulge) { segs.push([a, b]); continue; }
        // a bulge arc as six chords (the sagitta to the right of a to b for a positive bulge)
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nr = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L], sag = (bulge * L) / 2;
        const at = (t) => [a[0] + (b[0] - a[0]) * t + nr[0] * 4 * t * (1 - t) * sag, a[1] + (b[1] - a[1]) * t + nr[1] * 4 * t * (1 - t) * sag];
        for (let k = 0; k < 6; k++) segs.push([at(k / 6), at((k + 1) / 6)]);
      }
    }
  }
  const rest = [], late = [];
  for (const e of ents) {
    if (e.type !== 'text' || !(e.height > 0) || !Array.isArray(e.at)) { rest.push(e); continue; }
    const poly = textOutline(e, 0.2), xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]), g = 0.1 * e.height;
    const bx = [Math.min(...xs) + g, Math.min(...ys) + g, Math.max(...xs) - g, Math.max(...ys) - g];
    if (segs.some(([a, b]) => segHitsBox(a, b, bx))) late.push(maskE(poly, e.layer), e);
    else rest.push(e);
  }
  return [...rest, ...late];
}

/** Length of an orthogonal route through points. */
export const routeLength = (pts) => pts.slice(1).reduce((s, p, i) => s + dist(pts[i], p), 0);

const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * Labels kept clear of each other and of the hard boxes: place(text, candidates [p, align]) takes the first free
 * candidate, else the one that overlaps least (or none when optional); near(text, p, rMax, step) searches rings around
 * p and says when the label sits far enough to need a leader.
 */
export function labelPlacer(h, hard = [], limit = null) {
  const taken = [...hard];
  const boxOf = (t, p, align, rot = 0) => {
    const w = textWidth(t, h);
    // text turned upright (along a vertical pipe): centred on p, its width up the sheet
    if (Math.abs(Math.abs(rot) - 90) < 1) return [p[0] - h * 0.7, p[1] - w / 2 - h * 0.2, p[0] + h * 0.7, p[1] + w / 2 + h * 0.2];
    const x0 = align.includes('right') ? p[0] - w : align.includes('center') ? p[0] - w / 2 : p[0];
    const y0 = align.startsWith('middle') ? p[1] - h / 2 : align.startsWith('top') ? p[1] - h : p[1];
    return [x0 - h * 0.2, y0 - h * 0.2, x0 + w + h * 0.2, y0 + h * 1.2];
  };
  // a label that leaves the limit box (the plan with its dimensions) costs as much as lying on another label
  const outside = (b) => (limit && (b[0] < limit[0] || b[1] < limit[1] || b[2] > limit[2] || b[3] > limit[3]) ? (b[2] - b[0]) * (b[3] - b[1]) : 0);
  const cost = (b) => taken.reduce((s, x) => s + overlapArea(x, b), 0) + outside(b);
  const api = {
    taken,
    /** Keep the labels off a line a-b (axis-aligned pipes, wires): a thin box around it. */
    blockSegment(a, b, e = h * 0.15) {
      if (Math.abs(a[0] - b[0]) > 1 && Math.abs(a[1] - b[1]) > 1) return;
      taken.push([Math.min(a[0], b[0]) - e, Math.min(a[1], b[1]) - e, Math.max(a[0], b[0]) + e, Math.max(a[1], b[1]) + e]);
    },
    place(t, cands, { optional = false } = {}) {
      let best = null;
      for (const [p, align = 'middle_center', rot = 0] of cands) {
        const b = boxOf(t, p, align, rot);
        const c = cost(b);
        if (c === 0) {
          taken.push(b);
          return { p, align };
        }
        if (!best || c < best.c) best = { p, align, b, c };
      }
      if (optional || !best) return null;
      taken.push(best.b);
      return { p: best.p, align: best.align, crowded: true };
    },
    near(t, p, rMax, step) {
      const cands = [];
      for (let r = step; r <= rMax + 1e-6; r += step) {
        for (const a of [0, 180, 30, 150, -30, -150, 60, 120, -60, -120, 90, -90]) {
          const c = Math.cos((a * Math.PI) / 180), sn = Math.sin((a * Math.PI) / 180);
          cands.push([[p[0] + r * c, p[1] + r * sn], c >= -0.01 ? 'middle_left' : 'middle_right']);
        }
      }
      const res = api.place(t, cands);
      return { ...res, far: dist(res.p, p) > 1.5 * step };
    },
  };
  return api;
}

/** The first t mm of the walls around rooms, as boxes: labels are not written into the walls. */
export function wallBoxes(polys, offset = [0, 0], t = 110) {
  const out = [];
  for (const poly of Object.values(polys || {})) {
    for (const e of edgesOf(poly)) {
      if (Math.abs(e.t[0]) > 0.01 && Math.abs(e.t[1]) > 0.01) continue;
      const mid = add(e.a, mul(e.t, e.L / 2));
      const outw = inside(add(mid, mul(e.n, 20)), poly) ? mul(e.n, -1) : e.n;
      const pts = [e.a, e.b, add(e.a, mul(outw, t)), add(e.b, mul(outw, t))].map((q) => add(q, offset));
      out.push([Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))]);
    }
  }
  return out;
}

/** Half sizes (mm) of the real-size blocks. */
const REAL_HALF = { MCP_DEN_DOWNLIGHT: 115, MCP_DEN_OP_TRAN: 320, MCP_DEN_THA: 200, MCP_DEN_TUONG: 150, MCP_PHEU_THU: 75 };

/** The legend of a sheet: a title, then a symbol and its description per row (rows: {block | draw(p) | line, text}). */
export function legend(title, rows, at, scale, layer, symLayer) {
  const out = [textE(title, at, 3 * scale, layer)];
  let y = at[1] - 8 * scale;
  for (const r of rows) {
    const p = [at[0] + 5 * scale, y];
    // real-size blocks (lights, drains) at most a row high
    if (r.block) out.push(sym(r.block, p, { scale: r.real ? Math.min(1, (2.4 * scale) / (REAL_HALF[r.block] ?? 200)) : scale, layer: r.layer ?? symLayer, rotation: r.rotation ?? 0 }));
    if (r.line) out.push(lineE([at[0], y], [at[0] + 10 * scale, y], r.line, r.extra));
    if (r.draw) out.push(...r.draw(p));
    out.push(textE(r.text, [at[0] + 13 * scale, y], 2.2 * scale, layer, 'middle_left'));
    y -= 6.5 * scale;
  }
  return { entities: out, bottom: y };
}

export { centroid, inside };

/** The wall label (A top, B right, C bottom, D left) of a face, from its outward normal. */
export function faceLabel(fc) {
  const n = [-fc.inw[0], -fc.inw[1]];
  if (n[1] > 0.7) return 'A';
  if (n[0] > 0.7) return 'B';
  if (n[1] < -0.7) return 'C';
  return 'D';
}

/**
 * Default fixtures where the rooms have none (the furniture of draw_furniture_plan wins): a WC gets a toilet and a
 * shower on the wall opposite its door (the shaft corner at the left end kept free) and a basin on the side wall; a
 * kitchen its base cabinet run with the sink and the hob; a laundry yard a washing machine. Returns draw_furniture_plan
 * items and what was assumed.
 */
export function defaultFixtures(rooms, spec, items = [], shaft = 400) {
  const M = planModel(spec);
  const doors = floorDoors(M, spec, rooms);
  const out = [], assumed = [];
  for (const [name, poly] of Object.entries(rooms)) {
    const kind = roomKind(name);
    const has = (t) => items.some((it) => it.room === name && t.includes(it.type));
    const faces = roomFaces(poly, M);
    const door = doors.filter((d) => d.sides[name]).sort((a, b) => b.width - a.width)[0];
    const dfc = door ? doorFace(faces, door) : null;
    if (kind === 'wc' && !has(['toilet', 'vanity', 'shower', 'bathtub'])) {
      const back = (dfc && oppositeFaces(faces, dfc)[0]) ?? faces.find((f) => f !== dfc) ?? faces[0];
      if (!back) continue;
      const L = back.F.u1 - back.F.u0;
      const side = sideFaces(faces, back).filter((f) => f !== dfc).sort((a, b) => b.run - a.run)[0];
      out.push({ type: 'toilet', room: name, wall: faceLabel(back), offset: shaft + 100 });
      if (L >= shaft + 100 + 400 + 150 + 900) out.push({ type: 'shower', room: name, wall: faceLabel(back), offset_right: 0 });
      if (side) {
        // the basin on the side wall, past the toilet (which stands 700 out from the back wall)
        const sideFromBack = Math.abs(dot(sub(back.F.left, side.F.left), side.F.r)) < 50;
        const SL = side.F.u1 - side.F.u0;
        const off = sideFromBack ? 800 : Math.max(100, SL - 800 - 800);
        if (SL >= 1600) out.push({ type: 'vanity', room: name, wall: faceLabel(side), offset: off, width: 700 });
      }
      assumed.push({ item: `${name} fixtures`, value: 'toilet and shower on the wall opposite the door, basin 700 on the side wall', note: 'no furniture plan for this room' });
    } else if (kind === 'kitchen' && !has(['kitchen_base'])) {
      const run = faces.filter((f) => f !== dfc && f.run >= 1500)[0];
      if (!run) continue;
      const w = Math.min(2400, Math.floor(run.run / 100) * 100);
      const off = run.longest[0] - run.F.u0;
      out.push({ type: 'kitchen_base', room: name, wall: faceLabel(run), offset: off, width: w, sink: Math.round(w * 0.3), hob: Math.round(w * 0.75) });
      assumed.push({ item: `${name} kitchen`, value: `base cabinets ${w} with the sink at ${Math.round(w * 0.3)} and the hob at ${Math.round(w * 0.75)}`, note: 'no furniture plan for this room' });
    } else if (kind === 'laundry' && !has(['washer'])) {
      const fc = faces.filter((f) => f !== dfc)[0] ?? faces[0];
      if (!fc) continue;
      out.push({ type: 'washer', room: name, wall: faceLabel(fc), offset: fc.longest[0] - fc.F.u0 + 100 });
      assumed.push({ item: `${name} washer`, value: 'washing machine in the corner, its floor drain beside it', note: 'no furniture plan for this room' });
    }
  }
  return { items: out, assumed };
}

/**
 * Pipes from start to the targets [{p, to}] as a tree: a trunk to the farthest target (an L along the walls) and a stub
 * from the trunk to each of the others. Returns [{pts, trunk, to}] (a target on the trunk gets no stub: a tee).
 */
export function branchTree(start, targets, route) {
  if (!targets.length) return [];
  const man = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  const sorted = [...targets].sort((a, b) => man(start, b.p) - man(start, a.p));
  const trunk = route(start, sorted[0].p);
  const out = [{ pts: trunk, trunk: true, to: sorted[0].to }];
  for (const t of sorted.slice(1)) {
    let best = null;
    for (let i = 1; i < trunk.length; i++) {
      const a = trunk[i - 1], v = sub(trunk[i], a);
      const k = Math.max(0, Math.min(1, dot(sub(t.p, a), v) / (dot(v, v) || 1)));
      const q = add(a, mul(v, k));
      if (!best || dist(q, t.p) < best.d) best = { q, d: dist(q, t.p) };
    }
    if (best.d < 1) continue;
    const straight = Math.abs(best.q[0] - t.p[0]) < 1 || Math.abs(best.q[1] - t.p[1]) < 1;
    out.push({ pts: straight ? [best.q, t.p] : route(best.q, t.p), trunk: false, to: t.to });
  }
  return out;
}

/** Where the pump stands: in the first laundry yard (else the first WC) of the ground floor, 450 off its longest wall. */
export function pumpSpot(rooms, spec, taken = []) {
  const M = planModel(spec);
  const name = Object.keys(rooms).find((n) => roomKind(n) === 'laundry') ?? Object.keys(rooms).find((n) => roomKind(n) === 'wc');
  if (!name) return null;
  const fc = roomFaces(rooms[name], M)[0];
  if (!fc) return null;
  let p = facePoint(fc, fc.longest[1] - 400, 450);
  if (taken.some((q) => dist(q, p) < 700)) p = facePoint(fc, fc.longest[0] + 400, 450);
  return { at: P(p), room: name };
}

// ---------------------------------------------------------------- calculation sheets, CSV

/** The sign-off table of a calculation: who calculated, checked and leads the discipline, with licence numbers. */
export function signOff(lead, lang = 'vi') {
  const en = lang === 'en';
  return {
    title: en ? 'SIGN-OFF' : 'XÁC NHẬN', widths: [34, 46, 46, 30, 26],
    rows: [[en ? 'ROLE' : 'CHỨC DANH', en ? 'NAME' : 'HỌ VÀ TÊN', en ? 'LICENCE No.' : 'CHỨNG CHỈ HÀNH NGHỀ SỐ', en ? 'SIGNATURE' : 'CHỮ KÝ', en ? 'DATE' : 'NGÀY'],
      [en ? 'Calculated' : 'Người tính', '', '', '', ''], [en ? 'Checked' : 'Kiểm tra', '', '', '', ''], [lead, '', '', '', '']],
  };
}

/** Lines a table takes: its rows wrap where a cell is longer than its column (about 1.45 mm a character at 2.2 mm). */
export const tableLines = (tb) => tb.rows.reduce((s, row) => s + Math.max(1, ...row.map((v, i) => Math.ceil(([...String(v ?? '')].length * 1.45) / Math.max(4, tb.widths[i] - 2)))), 0);

/**
 * A calculation sheet: title, warning line, the left tables one under another with the notes under them, the right
 * tables beside (paper mm x scale, from at = top left). tables: {title, widths (paper mm), rows}.
 */
export function calcSheetOf({ title, warning, left = [], right = [], notes = [], scale = 50, lang = 'vi', at = [0, 0], layer, gap = 15 }) {
  const sc = scale, out = [];
  const th = 2 * sc, rh = 5.5 * sc;
  const T = (t, p, h) => out.push(textE(t, p, h, layer));
  const [x0, yTop] = at;
  T(title, [x0, yTop], 6 * sc);
  if (warning) T(warning, [x0, yTop - 9 * sc], 3 * sc);
  const place = (tb, x, y) => {
    out.push({ type: 'table', at: P([x, y]), title: tb.title, rows: tb.rows, height: r2(th), row_height: r2(rh), col_widths: tb.widths.map((w) => r2(w * sc)), layer, style: TEXT_STYLE, decimal_separator: lang === 'en' ? undefined : ',' });
    return y - (tableLines(tb) + 1) * rh - 12 * sc;
  };
  let yl = yTop - 18 * sc;
  for (const tb of left) yl = place(tb, x0, yl);
  const wl = Math.max(0, ...left.map((tb) => tb.widths.reduce((a, b) => a + b, 0)));
  if (notes.length) {
    out.push(textE(lang === 'en' ? 'NOTES:' : 'GHI CHÚ:', [x0, yl], 3 * sc, layer));
    out.push({ type: 'mtext', text: notes.map((l, i) => `${i + 1}. ${l}`).join('\n'), at: P([x0, yl - 5 * sc]), height: r2(2.5 * sc), width: r2(Math.max(160, wl) * sc), layer, style: TEXT_STYLE, line_spacing: 1.1 });
  }
  const xr = x0 + (wl + gap) * sc;
  let yr = yTop - 18 * sc;
  for (const tb of right) yr = place(tb, xr, yr);
  return { entities: out };
}

/** Tables as CSV (Excel): a heading, then each table after an empty line; semicolons and decimal commas in Vietnamese. */
export function tablesCsv(head, tables, sep = ';') {
  const num = (v) => (typeof v === 'number' && sep === ';' ? String(v).replace('.', ',') : String(v ?? ''));
  const esc = (v) => {
    const s = num(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const parts = [esc(head)];
  for (const tb of tables) parts.push('', esc(tb.title), ...tb.rows.map((row) => row.map(esc).join(sep)));
  return '﻿' + parts.join('\r\n') + '\r\n';
}

/** The bill of quantities rows ({head} | {stt, item, unit, q, how}) as a table. */
export function boqTable(title, rows, lang = 'vi') {
  const en = lang === 'en';
  return {
    title, widths: [10, 92, 13, 20, 56],
    rows: [[en ? 'No.' : 'STT', en ? 'ITEM' : 'HẠNG MỤC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'MADE UP OF' : 'DIỄN GIẢI'],
      ...rows.map((r) => (r.head ? ['', r.item, '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how ?? '']))],
  };
}
