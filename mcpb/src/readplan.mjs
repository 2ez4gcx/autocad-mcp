// Reading a plan someone else drew: the walls, openings, columns, grids and rooms of the linework of a drawing (the
// bridge plan_geometry: lines, polylines, arcs, circles, texts, inserts, hatches in world coordinates), as the plan
// description draw_plan takes. Walls are pairs of parallel faces at a wall's thickness (on wall layers when the drawing
// has them, else on any layer that is not annotation); a stretch where both faces stop is an opening, a door where a
// swing arc or a door block is, a window where glazing lines or a window block are; columns are small closed outlines
// on column layers or filled; grids are long centre lines with their bubbles; rooms are names inside the walls. What
// it could not read is listed, so the user can correct it before the plan is drawn over the old one.
import { blockRole, layerRole } from './layers.mjs';

const r1 = (v) => Math.round(v);
const ROOM_WORDS = /^(phong|p\.? ?(ngu|khach|an|hop|lam viec|tho|bep)|wc|w\.c|ve sinh|toilet|kho|sanh|bep|nha (an|bep|ve sinh|kho|xe)|khu|hanh lang|cau thang|thang may|san |san$|ban cong|lo gia|logia|van phong|le tan|bao ve|gara|garage|ky thuat|ga ra|tien sanh|phong|office|lobby|hall|storage|store|meeting|kitchen|dining|living|bed|bath|stair|corridor|balcony|terrace|room|reception|pantry|wc)|(办公|卫生间|厕所|仓库|大厅|会议|厨房|餐厅|楼梯|走廊|门厅|值班|机房|辦公|衛生間|廁所|倉庫|會議|廚房|餐廳|樓梯|門廳)/;
const TAG = /^\s*[a-z]{1,3}\s*-?\s*\d{1,3}[a-z]?\s*$/i;
const NOT_NAME = /^[\s\d.,+\-±x×*/=:%()]+$|m2|m²|^\+|^-\d|^±/i;
// layers whose lines are not walls
const NOT_WALL = new Set(['dims', 'text', 'note', 'symbol', 'grid', 'grid_tag', 'title', 'hatch', 'furniture', 'fixture', 'landscape', 'door', 'window', 'stair', 'railing', 'hidden',
  'revision', 'viewport', 'area', 'pipe', 'hvac', 'equipment', 'light', 'power', 'rebar', 'stirrup', 'steel', 'casework', 'ceiling', 'site', 'elevation', 'section', 'beam', 'roof']);

const plain = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
const unitScale = (u) => (u === 'm' ? 1000 : u === 'cm' ? 10 : 1);

/** The straight segments of the linework: {a, b, layer, lt, h}. */
function segmentsOf(g, k) {
  const out = [];
  const add = (x1, y1, x2, y2, li, ti, h) => {
    const a = [x1 * k, y1 * k], b = [x2 * k, y2 * k];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 20) out.push({ a, b, layer: g.layers[li], lt: g.linetypes[ti] ?? '', h });
  };
  for (const [x1, y1, x2, y2, li, ti, h] of g.lines || []) add(x1, y1, x2, y2, li, ti, h);
  for (const [li, ti, closed, bulged, pts, h] of g.polys || []) {
    if (bulged) continue;
    const P = [];
    for (let i = 0; i + 1 < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
    for (let i = 0; i + 1 < P.length + (closed ? 1 : 0); i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      add(p[0], p[1], q[0], q[1], li, ti, h);
    }
  }
  return out;
}

const inBox = (p, w) => !w || (p[0] >= w[0][0] && p[0] <= w[1][0] && p[1] >= w[0][1] && p[1] <= w[1][1]);

/** Merge sorted intervals [a, b] with gaps up to tol. */
function union(iv, tol = 1) {
  const s = [...iv].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b, ...rest] of s) {
    const l = out[out.length - 1];
    if (l && a <= l[1] + tol) l[1] = Math.max(l[1], b);
    else out.push([a, b, ...rest]);
  }
  return out;
}

/**
 * The plan of a drawing. g: plan_geometry; options: window [[x0, y0], [x1, y1]] (drawing units), thickness [min, max]
 * (mm), wallLayers (names forced as wall layers). Returns {spec: {walls, openings, columns, grids, rooms}, found,
 * unread, used: handles of the entities read, window, candidates (other plan areas when no window was given)}.
 */
export function readPlan(g, { window = null, thickness = [80, 450], wallLayers = null, minWall = 400, faceSet = 'auto' } = {}) {
  // the faces on wall layers, or on any layer that is not annotation: the one that finds more walls (a drawing may
  // have a wall layer that holds only some of its walls)
  if (faceSet === 'auto') {
    const A = readPlan(g, { window, thickness, wallLayers, minWall, faceSet: 'wall' });
    const B = readPlan(g, { window, thickness, wallLayers, minWall, faceSet: 'any' });
    return A.found.wall_length_m >= 0.6 * B.found.wall_length_m && A.found.walls ? A : B;
  }
  const k = unitScale(g.units);
  const win = window ? [[Math.min(window[0][0], window[1][0]) * k, Math.min(window[0][1], window[1][1]) * k], [Math.max(window[0][0], window[1][0]) * k, Math.max(window[0][1], window[1][1]) * k]] : null;
  const roleOf = new Map();
  const role = (l) => {
    if (!roleOf.has(l)) roleOf.set(l, wallLayers?.some((w) => w.toLowerCase() === String(l).toLowerCase()) ? 'wall' : layerRole(l).role);
    return roleOf.get(l);
  };
  const all = segmentsOf(g, k).filter((s) => inBox(s.a, win) && inBox(s.b, win));
  // faces: on wall (or column) layers when the drawing has enough of them, else on any layer that is not annotation
  const onWall = all.filter((s) => role(s.layer) === 'wall' || role(s.layer) === 'column');
  const oriented = (s) => {
      let d = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
      const L = Math.hypot(d[0], d[1]);
      d = [d[0] / L, d[1] / L];
      // one direction per line (0..180 degrees)
      if (d[1] < -1e-9 || (Math.abs(d[1]) <= 1e-9 && d[0] < 0)) d = [-d[0], -d[1]];
      const n = [-d[1], d[0]];
      const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
      const u0 = s.a[0] * d[0] + s.a[1] * d[1], u1 = s.b[0] * d[0] + s.b[1] * d[1];
      return { ...s, d, n, ang, o: s.a[0] * n[0] + s.a[1] * n[1], u0: Math.min(u0, u1), u1: Math.max(u0, u1), L };
  };
  const faces = (faceSet === 'wall' ? onWall : all.filter((s) => !NOT_WALL.has(role(s.layer)) && !/center|dash|hidden|phantom|divide|dot/i.test(s.lt)))
    .map(oriented).filter((f) => f.L >= 50);
  // glazing may sit on a window or door layer: looked for among all the lines
  const lines = all.filter((s) => !/center|dash|hidden|phantom|divide|dot/i.test(s.lt) && !['dims', 'grid', 'text', 'title'].includes(role(s.layer))).map(oriented);
  // ---- bands: the nearest parallel face at a wall's distance, piece by piece
  const byAng = new Map();
  for (const f of faces) {
    const key = Math.round(((f.ang % 180) + 180) % 180 * 2) / 2;
    if (!byAng.has(key)) byAng.set(key, []);
    byAng.get(key).push(f);
  }
  const bands = [];
  for (const [key, list] of byAng) {
    const near = [...list, ...(byAng.get((key + 0.5) % 180) ?? []), ...(byAng.get((key + 179.5) % 180) ?? [])];
    for (const f of list) {
      const cands = near.filter((t) => t !== f && t.o - f.o >= thickness[0] - 1 && t.o - f.o <= thickness[1] + 1 && Math.min(f.u1, t.u1) - Math.max(f.u0, t.u0) > 100)
        .sort((x, y) => x.o - y.o);
      // what lies between f and a candidate covers that stretch: only the nearest face pairs
      const between = near.filter((t) => t !== f && t.o - f.o > 20 && t.o - f.o < thickness[1]);
      let covered = [];
      for (const t of cands) {
        let iv = [[Math.max(f.u0, t.u0), Math.min(f.u1, t.u1)]];
        for (const b of between) {
          if (b === t || b.o >= t.o - 1) continue;
          iv = iv.flatMap(([a, c]) => (b.u1 <= a || b.u0 >= c ? [[a, c]] : [[a, Math.max(a, b.u0)], [Math.min(c, b.u1), c]].filter(([x, y]) => y - x > 1)));
        }
        for (const [a, c] of covered) iv = iv.flatMap(([x, y]) => (c <= x || a >= y ? [[x, y]] : [[x, Math.max(x, a)], [Math.min(y, c), y]].filter(([p, q]) => q - p > 1)));
        for (const [a, c] of iv) {
          if (c - a < 100) continue;
          bands.push({ d: f.d, n: f.n, ang: f.ang, t: t.o - f.o, axis: (f.o + t.o) / 2, u0: a, u1: c, faces: [f, t] });
        }
        covered = union([...covered, ...iv]);
      }
    }
  }
  // ---- walls: bands on one axis with one thickness joined; a short gap where the faces stop is an opening
  const groups = [];
  for (const b of bands) {
    const g0 = groups.find((x) => Math.abs(x.ang - b.ang) < 0.6 && Math.abs(x.axis - b.axis) <= 15 && Math.abs(x.t - b.t) <= 15);
    if (g0) g0.list.push(b);
    else groups.push({ ang: b.ang, axis: b.axis, t: b.t, d: b.d, n: b.n, list: [b] });
  }
  const runs = [];
  for (const G of groups) {
    const t = Math.round(G.list.reduce((s, b) => s + b.t, 0) / G.list.length / 5) * 5;
    for (const [u0, u1] of union(G.list.map((b) => [b.u0, b.u1]), 30)) runs.push({ d: G.d, n: G.n, ang: G.ang, axis: G.axis, t, u0, u1, faces: G.list.flatMap((b) => b.faces) });
  }
  const P = (r, u) => [r.d[0] * u + r.n[0] * r.axis, r.d[1] * u + r.n[1] * r.axis];
  // openings: two runs of one wall with a gap between 500 and 4000 mm
  const used = new Set();
  const openings = [];
  const runsByLine = new Map();
  runs.forEach((r, i) => {
    const key = `${Math.round(r.ang * 2)}|${Math.round(r.axis / 20)}|${r.t}`;
    if (!runsByLine.has(key)) runsByLine.set(key, []);
    runsByLine.get(key).push(i);
  });
  const arcs = (g.arcs || []).map(([cx, cy, r, a0, a1, li, h]) => ({ c: [cx * k, cy * k], r: r * k, a0, a1, layer: g.layers[li], h })).filter((a) => inBox(a.c, win));
  const inserts = (g.inserts || []).map(([x, y, rot, sx, sy, name, li, attrs, box, h]) => ({ at: [x * k, y * k], rot, name, layer: g.layers[li], attrs, box: box?.map((v) => v * k), h, role: blockRole(name) }))
    .filter((i) => inBox(i.at, win));
  const texts = (g.texts || []).map(([x, y, hgt, s, li, h]) => ({ at: [x * k, y * k], height: hgt * k, text: String(s ?? '').replace(/\\P/g, '\n').split('\n')[0].trim(), layer: g.layers[li], h }))
    .filter((t) => inBox(t.at, win) && t.text);
  const joined = new Set();
  for (const ids of runsByLine.values()) {
    const rs = ids.map((i) => runs[i]).sort((a, b) => a.u0 - b.u0);
    for (let i = 0; i + 1 < rs.length; i++) {
      const A = rs[i], B = rs[i + 1], gap = B.u0 - A.u1;
      if (gap < 450 || gap > 4000) continue;
      const mid = (A.u1 + B.u0) / 2, c = P(A, mid), half = gap / 2;
      const near = (p, tol) => Math.abs((p[0] - c[0]) * A.d[0] + (p[1] - c[1]) * A.d[1]) <= half + tol && Math.abs((p[0] - c[0]) * A.n[0] + (p[1] - c[1]) * A.n[1]) <= tol + A.t;
      // a door: a swing arc about as wide as the gap (or half of it, two leaves) hinged at an end; a door or window block
      const swing = arcs.filter((a) => (Math.abs(a.r - gap) <= 0.2 * gap || Math.abs(a.r - gap / 2) <= 0.12 * gap) && near(a.c, 150));
      // a block of no known name in the gap: a door when its outline reaches out of the wall (its leaf), a window
      // when it stays within the wall
      const unnamed = inserts.filter((x) => !x.role && !x.attrs && x.box && near(x.at, gap)).map((x) => {
        const corners = [[x.box[0], x.box[1]], [x.box[2], x.box[1]], [x.box[2], x.box[3]], [x.box[0], x.box[3]]];
        const off = corners.map((q) => (q[0] - c[0]) * A.n[0] + (q[1] - c[1]) * A.n[1]);
        const along = corners.map((q) => (q[0] - c[0]) * A.d[0] + (q[1] - c[1]) * A.d[1]);
        const span = Math.max(...along) - Math.min(...along), reach = Math.max(Math.max(...off), -Math.min(...off)) - A.t / 2;
        return span >= 0.6 * gap && span <= 1.3 * gap ? { ...x, role: reach > 0.3 * gap ? 'door' : 'window' } : null;
      }).filter(Boolean);
      const blk = [...inserts.filter((x) => (x.role === 'door' || x.role === 'window') && near(x.at, gap)), ...unnamed];
      // a leaf drawn as a line: from an end of the gap, across the wall (30 to 90 degrees), about as long as the gap
      const ends = [P(A, A.u1), P(B, B.u0)];
      const leaf = lines.filter((f) => {
        const cos = Math.abs(f.d[0] * A.d[0] + f.d[1] * A.d[1]);
        if (cos > 0.87 || f.L < 0.6 * gap || f.L > 1.15 * gap) return false;
        return ends.some((e) => [f.a, f.b].some((q) => Math.hypot(q[0] - e[0], q[1] - e[1]) <= A.t / 2 + 80));
      });
      const glazing = lines.filter((f) => Math.abs(f.ang - A.ang) < 1 && Math.abs(f.o - A.axis) < A.t / 2 + 5 && f.u0 >= A.u1 - 5 && f.u1 <= B.u0 + 5 && f.u1 - f.u0 >= 0.6 * gap);
      let type = 'opening';
      let toward;
      if (swing.length || blk.some((x) => x.role === 'door') || leaf.length) {
        type = swing.length >= 2 && swing.every((a) => Math.abs(a.r - gap / 2) <= 0.12 * gap) ? 'double_door' : 'door';
        const a = swing[0];
        const db = blk.find((x) => x.role === 'door' && x.box);
        if (a) {
          const am = ((a.a0 + ((((a.a1 - a.a0) % 360) + 360) % 360) / 2) * Math.PI) / 180;
          const p = [a.c[0] + Math.cos(am) * a.r, a.c[1] + Math.sin(am) * a.r];
          const side = Math.sign((p[0] - c[0]) * A.n[0] + (p[1] - c[1]) * A.n[1]) || 1;
          toward = [r1(c[0] + A.n[0] * side * 1000), r1(c[1] + A.n[1] * side * 1000)];
          used.add(a.h);
        } else if (leaf.length) {
          // the side the leaf lies on
          const f = leaf[0], far = [f.a, f.b].sort((x, y) => Math.hypot(y[0] - c[0], y[1] - c[1]) - Math.hypot(x[0] - c[0], x[1] - c[1]))[0];
          const side = Math.sign((far[0] - c[0]) * A.n[0] + (far[1] - c[1]) * A.n[1]) || 1;
          toward = [r1(c[0] + A.n[0] * side * 1000), r1(c[1] + A.n[1] * side * 1000)];
          if (leaf.length >= 2 && leaf.every((x) => x.L < 0.7 * gap)) type = 'double_door';
          for (const x of leaf) used.add(x.h);
        } else if (db) {
          // a door block: the leaf swings to the side of the wall its outline reaches into; its depth from the wall
          // is the leaf (the width of the opening for one leaf, half of it for two)
          const corners = [[db.box[0], db.box[1]], [db.box[2], db.box[1]], [db.box[2], db.box[3]], [db.box[0], db.box[3]]];
          const off = corners.map((q) => (q[0] - c[0]) * A.n[0] + (q[1] - c[1]) * A.n[1]);
          const plus = Math.max(...off) - A.t / 2, minus = -Math.min(...off) - A.t / 2;
          const side = plus >= minus ? 1 : -1, depth = Math.max(plus, minus);
          toward = [r1(c[0] + A.n[0] * side * 1000), r1(c[1] + A.n[1] * side * 1000)];
          if (depth > 0.3 * gap && Math.abs(depth - gap / 2) < Math.abs(depth - gap)) type = 'double_door';
        }
      } else if (glazing.length >= 1 || blk.some((x) => x.role === 'window')) {
        type = 'window';
        for (const f of glazing) used.add(f.h);
      } else if (gap > 2500) continue; // two walls, not an opening
      for (const x of blk) used.add(x.h);
      // the tag: a text "D1" near the opening, or the value of a tag block's attribute
      const tagTexts = [...texts, ...inserts.filter((x) => x.attrs).flatMap((x) => Object.values(x.attrs).map((v) => ({ at: x.at, text: String(v).trim(), h: x.h })))];
      const tag = tagTexts.filter((t) => TAG.test(t.text) && Math.hypot(t.at[0] - c[0], t.at[1] - c[1]) < Math.max(1500, gap)).sort((x, y) => Math.hypot(x.at[0] - c[0], x.at[1] - c[1]) - Math.hypot(y.at[0] - c[0], y.at[1] - c[1]))[0];
      if (tag) used.add(tag.h);
      openings.push({ runA: A, runB: B, at: c, width: r1(gap), type, toward, tag: tag?.text?.trim() });
      joined.add(`${runs.indexOf(A)}>${runs.indexOf(B)}`);
    }
  }
  // the wall pieces: runs on one line joined across their openings
  const pieces = [];
  for (const ids of runsByLine.values()) {
    const rs = ids.map((i) => runs[i]).sort((a, b) => a.u0 - b.u0);
    let cur = null;
    for (const r of rs) {
      if (cur && joined.has(`${runs.indexOf(cur.last)}>${runs.indexOf(r)}`)) {
        cur.u1 = r.u1;
        cur.last = r;
        cur.faces.push(...r.faces);
      } else {
        if (cur) pieces.push(cur);
        cur = { ...r, last: r, faces: [...r.faces] };
      }
    }
    if (cur) pieces.push(cur);
  }
  // short isolated bands (a step, a frame) are not walls
  let walls = pieces.filter((w) => w.u1 - w.u0 >= minWall);
  // ---- ends: an end near another wall's axis runs on to it (L and T junctions on the axes)
  for (const w of walls) {
    for (const end of [0, 1]) {
      const u = end ? w.u1 : w.u0;
      const p = P(w, u);
      let best = null;
      for (const o of walls) {
        if (o === w || Math.abs(Math.abs(o.d[0] * w.d[0] + o.d[1] * w.d[1])) > 0.3) continue;
        // where w's axis meets o's axis
        const den = w.d[0] * o.n[0] + w.d[1] * o.n[1];
        if (Math.abs(den) < 1e-9) continue;
        const s = (o.axis - (P(w, 0)[0] * o.n[0] + P(w, 0)[1] * o.n[1])) / den;
        const q = P(w, s);
        const uo = q[0] * o.d[0] + q[1] * o.d[1];
        const reach = Math.abs(s - u), lim = o.t / 2 + w.t / 2 + 60;
        if (reach <= lim && uo >= o.u0 - lim && uo <= o.u1 + lim && (!best || reach < best.reach)) best = { s, reach };
      }
      if (best) {
        if (end) w.u1 = Math.max(w.u1, best.s);
        else w.u0 = Math.min(w.u0, best.s);
        if (end) w.u1 = best.s > w.u0 ? best.s : w.u1;
      }
    }
  }
  walls = walls.filter((w) => w.u1 - w.u0 >= minWall);
  const specWalls = walls.map((w, i) => ({ id: `W${i + 1}`, points: [P(w, w.u0).map(r1), P(w, w.u1).map(r1)], thickness: w.t }));
  for (const w of walls) for (const f of w.faces) used.add(f.h);
  // openings on the walls they cut (their centre on the axis)
  const specOpenings = [];
  for (const o of openings) {
    const wi = walls.findIndex((w) => Math.abs(w.ang - o.runA.ang) < 0.6 && Math.abs(w.axis - o.runA.axis) <= 15 && w.t === o.runA.t && w.u0 <= o.runA.u1 + 1 && w.u1 >= o.runB.u0 - 1);
    if (wi < 0) continue;
    specOpenings.push({ wall: `W${wi + 1}`, at: o.at.map(r1), width: o.width, type: o.type, ...(o.toward ? { toward: o.toward } : {}), ...(o.tag ? { tag: o.tag } : {}) });
  }
  // ---- columns: small closed outlines on column layers, or filled with a solid hatch
  const columns = [];
  const solids = (g.hatches || []).filter(([li, pat, solid]) => solid).map(([li, pat, solid, box, loops, h]) => ({ box: box?.map((v) => v * k), layer: g.layers[li], h }));
  for (const [li, ti, closed, bulged, pts, h] of g.polys || []) {
    if (!closed || bulged || pts.length < 8 || pts.length > 10) continue;
    const xs = pts.filter((_, i) => i % 2 === 0).map((v) => v * k), ys = pts.filter((_, i) => i % 2 === 1).map((v) => v * k);
    const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
    const c = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
    if (!inBox(c, win) || w < 150 || hh < 150 || w > 1200 || hh > 1200) continue;
    const filled = solids.some((s) => s.box && Math.abs((s.box[0] + s.box[2]) / 2 - c[0]) < 30 && Math.abs((s.box[1] + s.box[3]) / 2 - c[1]) < 30);
    if (role(g.layers[li]) !== 'column' && !filled) continue;
    if (columns.some((x) => Math.hypot(x.at[0] - c[0], x.at[1] - c[1]) < 50)) continue;
    columns.push({ at: c.map(r1), size: [r1(w), r1(hh)] });
    used.add(h);
  }
  // ---- grids: long centre lines (grid layers or a centre linetype), labelled by the bubble at an end
  const gl = all.filter((s) => (role(s.layer) === 'grid' || /center|dashdot/i.test(s.lt)) && Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]) >= 2000);
  const labelAt = (p) => {
    const circ = (g.circles || []).map(([x, y, r, li, h]) => ({ c: [x * k, y * k], r: r * k, h })).filter((c) => c.r >= 150 && c.r <= 1200 && Math.hypot(c.c[0] - p[0], c.c[1] - p[1]) <= c.r * 2.5);
    for (const c of circ) {
      const t = texts.find((x) => Math.hypot(x.at[0] - c.c[0], x.at[1] - c.c[1]) <= c.r && x.text.length <= 4);
      if (t) {
        used.add(c.h);
        used.add(t.h);
        return t.text;
      }
    }
    const b = inserts.find((x) => (x.role === 'grid_tag' || x.role === 'symbol') && x.attrs && Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) <= 1500);
    if (b) {
      used.add(b.h);
      return String(Object.values(b.attrs)[0]).trim();
    }
    return null;
  };
  const gx = new Map(), gy = new Map();
  for (const s of gl) {
    const vert = Math.abs(s.b[0] - s.a[0]) < 1, hor = Math.abs(s.b[1] - s.a[1]) < 1;
    if (!vert && !hor) continue;
    const at = r1(vert ? s.a[0] : s.a[1]);
    const M = vert ? gx : gy;
    if ([...M.keys()].some((x) => Math.abs(x - at) < 5)) continue;
    const label = labelAt(s.a) ?? labelAt(s.b);
    M.set(at, label);
    used.add(s.h);
  }
  const grids = gx.size + gy.size >= 2 ? {
    x: [...gx.entries()].sort((a, b) => a[0] - b[0]).map(([at, label]) => (label ? { at, label } : at)),
    y: [...gy.entries()].sort((a, b) => a[0] - b[0]).map(([at, label]) => (label ? { at, label } : at)),
  } : undefined;
  // ---- rooms: names inside the walls (a word of a room, not a tag, an area or a level)
  let rooms = [];
  if (specWalls.length) {
    const xs = specWalls.flatMap((w) => w.points.map((p) => p[0])), ys = specWalls.flatMap((w) => w.points.map((p) => p[1]));
    const box = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
    rooms = texts.filter((t) => inBox(t.at, box) && !TAG.test(t.text) && !NOT_NAME.test(t.text) && ROOM_WORDS.test(plain(t.text)) && !['dims', 'title', 'grid_tag'].includes(role(t.layer)))
      .map((t) => {
        used.add(t.h);
        return { name: t.text.replace(/\s+/g, ' ').trim().toUpperCase(), at: t.at.map(r1) };
      });
    // one name per place
    rooms = rooms.filter((r, i) => !rooms.slice(0, i).some((q) => Math.hypot(q.at[0] - r.at[0], q.at[1] - r.at[1]) < 500));
  }
  // ---- beyond face pairs
  const extra = readExtras({ g, k, win, all, lines, arcs, texts, used, role, thickness, specWalls, walls });
  specWalls.push(...extra.walls);
  specOpenings.push(...extra.openings);
  // ---- what was not read
  const unread = [];
  const wallLike = faceSet === 'wall' ? onWall : [];
  const loose = wallLike.filter((s) => !used.has(s.h)).length;
  if (loose) unread.push({ what: 'lines on wall layers not paired as wall faces (curved walls, walls of another thickness, details)', count: loose });
  const doorsLeft = inserts.filter((x) => x.role === 'door' && !used.has(x.h)).length;
  if (doorsLeft) unread.push({ what: 'door blocks not on a recognised opening', count: doorsLeft });
  const windowsLeft = inserts.filter((x) => x.role === 'window' && !used.has(x.h)).length;
  if (windowsLeft) unread.push({ what: 'window blocks not on a recognised opening', count: windowsLeft });
  if ((g.arcs || []).some((a) => a)) {
    const swings = arcs.filter((a) => a.r >= 500 && a.r <= 1200 && !used.has(a.h)).length;
    if (swings) unread.push({ what: 'arcs of a door swing size not on a recognised opening', count: swings });
  }
  unread.push({ what: 'dimensions, furniture and notes are not read (draw_plan draws its own dimensions; furniture and notes stay on the drawing)' });
  if (extra.stairs.some((x) => x.pair)) unread.push({ what: 'a U stair was read as its two flights (draw_plan stairs type "u" draws it whole: give its region)' });
  if (extra.stairs.some((x) => x.assumed)) unread.push({ what: 'the way up of a stair was not marked (LÊN / UP): taken from the first tread', count: extra.stairs.filter((x) => x.assumed).length });
  const bboxOf = (ws) => {
    const xs = ws.flatMap((w) => w.points.map((p) => p[0])), ys = ws.flatMap((w) => w.points.map((p) => p[1]));
    return xs.length ? [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]] : null;
  };
  return {
    spec: {
      walls: specWalls, openings: specOpenings, ...(columns.length ? { columns } : {}), ...(grids ? { grids } : {}), ...(rooms.length ? { rooms } : {}),
      ...(extra.stairs.length ? { stairs: extra.stairs.map(({ assumed, pair, ...x }) => x) } : {}), ...(extra.levels.length ? { levels: extra.levels } : {}),
    },
    found: {
      walls: specWalls.length, wall_length_m: Math.round(walls.reduce((s, w) => s + (w.u1 - w.u0), 0)) / 1000, thicknesses: [...new Set(walls.map((w) => w.t))].sort((a, b) => a - b),
      openings: specOpenings.length, doors: specOpenings.filter((o) => /door/.test(o.type)).length, windows: specOpenings.filter((o) => o.type === 'window').length,
      columns: columns.length, grids: grids ? (grids.x.length + grids.y.length) : 0, rooms: rooms.length, faces_from: faceSet === 'wall' ? 'wall layers' : 'any layer that is not annotation',
      glazed_walls: extra.counts.glazed || undefined, single_line_walls: extra.counts.wide || undefined, curved_walls: extra.counts.curved || undefined,
      stairs: extra.stairs.length || undefined, levels: extra.levels.length || undefined,
    },
    bounds: bboxOf(specWalls), unread, used: [...used].filter(Boolean),
  };
}

/**
 * What face pairs at a wall's thickness do not find: glazed walls (two faces 20-80 mm apart on window or glass layers,
 * a curtain wall: a wall with a window over its length), walls drawn as one wide polyline (its width the thickness),
 * curved walls (two concentric arcs a wall's thickness apart, the wall along the middle arc), stairs (six or more equal
 * parallel treads at an even going: a straight flight; the way up from a LÊN / UP text or arrow near an end) and levels
 * (texts like +3.600 / ±0.000 on symbol layers or with a level mark).
 */
function readExtras({ g, k, win, all, lines, arcs, texts, used, role, thickness, specWalls, walls }) {
  const out = { walls: [], openings: [], stairs: [], levels: [], counts: {} };
  let n = specWalls.length;
  const nextId = () => `W${++n}`;
  const covered = (a, b, t) => walls.some((w) => {
    // already a wall there (an axis within half a thickness, overlapping)
    const pa = [a[0] * w.n[0] + a[1] * w.n[1], a[0] * w.d[0] + a[1] * w.d[1]], pb = [b[0] * w.n[0] + b[1] * w.n[1], b[0] * w.d[0] + b[1] * w.d[1]];
    return Math.abs(pa[0] - w.axis) < w.t / 2 + t && Math.abs(pb[0] - w.axis) < w.t / 2 + t && Math.min(pa[1], pb[1]) < w.u1 && Math.max(pa[1], pb[1]) > w.u0;
  });
  // ---- glazed walls: thin pairs on window / glass layers, 1 m long at least
  const glass = lines.filter((f) => role(f.layer) === 'window');
  const pairs = [];
  for (const f of glass) {
    for (const t of glass) {
      if (t === f || Math.abs(f.ang - t.ang) > 0.6) continue;
      const d = t.o - f.o;
      if (d < 20 || d > Math.min(80, thickness[0] - 1)) continue;
      const u0 = Math.max(f.u0, t.u0), u1 = Math.min(f.u1, t.u1);
      if (u1 - u0 < 1000) continue;
      pairs.push({ f, t, d, u0, u1, axis: (f.o + t.o) / 2 });
    }
  }
  const glazed = [];
  for (const p of pairs.sort((a, b) => b.u1 - b.u0 - (a.u1 - a.u0))) {
    if (glazed.some((q) => Math.abs(q.f.ang - p.f.ang) < 0.6 && Math.abs(q.axis - p.axis) < 120 && q.u0 < p.u1 && p.u0 < q.u1)) continue;
    glazed.push(p);
  }
  for (const p of glazed) {
    const P = (u) => [p.f.d[0] * u + p.f.n[0] * p.axis, p.f.d[1] * u + p.f.n[1] * p.axis].map(r1);
    const a = P(p.u0), b = P(p.u1);
    if (covered(a, b, 50)) continue;
    const id = nextId(), L = p.u1 - p.u0;
    out.walls.push({ id, points: [a, b], thickness: Math.max(50, Math.round(p.d / 10) * 10), material: 'none' });
    out.openings.push({ wall: id, at: P((p.u0 + p.u1) / 2), width: r1(L - 2), type: 'window' });
    used.add(p.f.h);
    used.add(p.t.h);
  }
  out.counts.glazed = glazed.length;
  // ---- walls drawn as one wide polyline
  let wide = 0;
  for (const [li, ti, closed, bulged, pts, h, width] of g.polys || []) {
    const w = (width ?? 0) * k;
    if (!(w >= Math.max(60, thickness[0] * 0.75) && w <= thickness[1]) || bulged) continue;
    const P = [];
    for (let i = 0; i + 1 < pts.length; i += 2) P.push([pts[i] * k, pts[i + 1] * k]);
    if (!P.every((q) => inBox(q, win))) continue;
    const ring = closed ? [...P, P[0]] : P;
    const pl = ring.map((q) => q.map(r1));
    if (pl.length < 2) continue;
    out.walls.push({ id: nextId(), points: pl, thickness: Math.round(w / 5) * 5 });
    used.add(h);
    wide++;
  }
  out.counts.wide = wide;
  // ---- curved walls: concentric arcs a wall's thickness apart
  let curved = 0;
  const usedArc = new Set();
  for (const a of arcs) {
    if (usedArc.has(a) || a.r < 500 || ['door', 'symbol', 'dims', 'grid'].includes(role(a.layer))) continue;
    const b = arcs.find((x) => x !== a && !usedArc.has(x) && Math.hypot(x.c[0] - a.c[0], x.c[1] - a.c[1]) < 20 && Math.abs(x.r - a.r) >= thickness[0] && Math.abs(x.r - a.r) <= thickness[1]
      && Math.abs(((x.a0 - a.a0 + 540) % 360) - 180) < 3 && Math.abs(((x.a1 - a.a1 + 540) % 360) - 180) < 3);
    if (!b) continue;
    usedArc.add(a);
    usedArc.add(b);
    const rm = (a.r + b.r) / 2, sweep = (((a.a1 - a.a0) % 360) + 360) % 360 || 360;
    const steps = Math.max(2, Math.ceil(sweep / 10));
    const pts = Array.from({ length: steps + 1 }, (_, i) => {
      const t = ((a.a0 + (sweep * i) / steps) * Math.PI) / 180;
      return [r1(a.c[0] + rm * Math.cos(t)), r1(a.c[1] + rm * Math.sin(t))];
    });
    out.walls.push({ id: nextId(), points: pts, thickness: Math.round(Math.abs(a.r - b.r) / 5) * 5 });
    used.add(a.h);
    used.add(b.h);
    curved++;
  }
  out.counts.curved = curved;
  // ---- stairs: six or more equal parallel treads at an even going
  const treadsOf = lines.filter((f) => f.L >= 600 && f.L <= 3000 && !['dims', 'grid', 'text', 'title', 'wall'].includes(role(f.layer)));
  const byDir = new Map();
  for (const f of treadsOf) {
    const key = Math.round(f.ang) % 180;
    if (!byDir.has(key)) byDir.set(key, []);
    byDir.get(key).push(f);
  }
  const taken = new Set();
  for (const list of byDir.values()) {
    list.sort((x, y) => x.o - y.o);
    for (let i = 0; i < list.length; i++) {
      if (taken.has(list[i])) continue;
      const first = list[i], run = [first];
      let going = null;
      for (let j = i + 1; j < list.length; j++) {
        const t = list[j], last = run[run.length - 1];
        const gap = t.o - last.o;
        if (gap < 150) continue;
        if (gap > 380) break;
        if (Math.abs(t.L - first.L) > 0.05 * first.L || Math.abs(t.u0 - first.u0) > 60 || Math.abs(t.u1 - first.u1) > 60) continue;
        if (going === null) going = gap;
        else if (Math.abs(gap - going) > 15) break;
        run.push(t);
      }
      if (run.length < 6 || going < 200) continue;
      for (const t of run) taken.add(t);
      const w = first.L, uMid = (first.u0 + first.u1) / 2;
      const at = (o) => [first.d[0] * uMid + first.n[0] * o, first.d[1] * uMid + first.n[1] * o];
      const lo = at(first.o), hi = at(run[run.length - 1].o);
      out.stairs.push({
        start: lo.map(r1), direction: Math.round((Math.atan2(first.n[1], first.n[0]) * 180) / Math.PI), width: r1(w), treads: run.length - 1, going: r1(going), assumed: true,
        lo, hi, nUp: first.n,
      });
      for (const t of run) used.add(t.h);
    }
  }
  // the way up: each LÊN / UP text marks the flight whose end is nearest to it, at that end
  for (const t of texts.filter((x) => /^(len|up|上)\b/i.test(plain(x.text)))) {
    let best = null;
    for (const st of out.stairs) {
      for (const [end, other, sign] of [[st.lo, st.hi, 1], [st.hi, st.lo, -1]]) {
        const d = Math.hypot(t.at[0] - end[0], t.at[1] - end[1]);
        if (d < 3000 && (!best || d < best.d)) best = { st, d, end, sign };
      }
    }
    if (!best) continue;
    const st = best.st;
    st.start = best.end.map(r1);
    const n = [st.nUp[0] * best.sign, st.nUp[1] * best.sign];
    st.direction = Math.round((Math.atan2(n[1], n[0]) * 180) / Math.PI);
    st.assumed = false;
    used.add(t.h);
  }
  for (const st of out.stairs) {
    delete st.lo;
    delete st.hi;
    delete st.nUp;
    st.direction = ((st.direction % 360) + 360) % 360;
  }
  // one flight read twice (a run of treads inside a longer one): the longer kept
  out.stairs = out.stairs.filter((st, i) => !out.stairs.some((o, j) => j !== i && o.direction === st.direction && Math.hypot(o.start[0] - st.start[0], o.start[1] - st.start[1]) < 300 && (o.treads > st.treads || (o.treads === st.treads && j < i))));
  // two flights side by side with the same going (a U stair): the one whose way up was not marked runs the other way
  for (let i = 0; i < out.stairs.length; i++) {
    for (let j = 0; j < out.stairs.length; j++) {
      const A = out.stairs[i], B = out.stairs[j];
      if (i === j || A.assumed || !B.assumed || Math.abs(A.going - B.going) > 15 || Math.abs(((A.direction - B.direction + 540) % 360) - 180) < 170 && A.direction !== B.direction) continue;
      const dx = B.start[0] - A.start[0], dy = B.start[1] - A.start[1], a = (A.direction * Math.PI) / 180;
      const side = Math.abs(-Math.sin(a) * dx + Math.cos(a) * dy);
      if (side > A.width + B.width + 400) continue;
      // B starts at its far end and goes the other way
      const len = B.treads * B.going, b = (B.direction * Math.PI) / 180;
      B.start = [r1(B.start[0] + Math.cos(b) * len), r1(B.start[1] + Math.sin(b) * len)];
      B.direction = (A.direction + 180) % 360;
      B.assumed = false;
      B.pair = true;
    }
  }
  // ---- levels: +3.600, -0.450, ±0.000
  for (const t of texts) {
    const m = t.text.replace(/\s/g, '').match(/^(±|\+|-)?\d{1,2}[.,]\d{3}$/);
    if (!m) continue;
    const v = t.text.replace(/\s/g, '').replace(',', '.');
    if (out.levels.some((l) => Math.hypot(l.at[0] - t.at[0], l.at[1] - t.at[1]) < 300)) continue;
    out.levels.push({ at: t.at.map(r1), value: v.startsWith('±') || v.startsWith('+') || v.startsWith('-') ? v : `+${v}` });
    used.add(t.h);
  }
  return out;
}

/**
 * Places where a plan may be (no window given): the extents of the groups of wall-like bands, largest first, so the
 * user (or the tool) picks one sheet of a model space that holds many.
 */
export function planAreas(g, opts = {}) {
  const r = readPlan(g, { ...opts, minWall: 800 });
  const ws = r.spec.walls.map((w) => ({ box: [[Math.min(w.points[0][0], w.points[1][0]), Math.min(w.points[0][1], w.points[1][1])], [Math.max(w.points[0][0], w.points[1][0]), Math.max(w.points[0][1], w.points[1][1])]], len: Math.hypot(w.points[1][0] - w.points[0][0], w.points[1][1] - w.points[0][1]) }));
  const groups = [];
  const near = (a, b, m) => !(a[1][0] + m < b[0][0] || b[1][0] + m < a[0][0] || a[1][1] + m < b[0][1] || b[1][1] + m < a[0][1]);
  for (const w of ws) {
    let gi = groups.filter((gr) => near(gr.box, w.box, 3000));
    const box = [[w.box[0][0], w.box[0][1]], [w.box[1][0], w.box[1][1]]];
    let len = w.len, n = 1;
    for (const gr of gi) {
      box[0][0] = Math.min(box[0][0], gr.box[0][0]); box[0][1] = Math.min(box[0][1], gr.box[0][1]);
      box[1][0] = Math.max(box[1][0], gr.box[1][0]); box[1][1] = Math.max(box[1][1], gr.box[1][1]);
      len += gr.len;
      n += gr.n;
    }
    gi.forEach((gr) => groups.splice(groups.indexOf(gr), 1));
    groups.push({ box, len, n });
  }
  const k = unitScale(g.units);
  // what makes an area a plan and not a section or an elevation (which have parallel faces too): door swings and
  // door blocks, room names, walls in both directions
  const inside = (p, b) => p[0] >= b[0][0] && p[0] <= b[1][0] && p[1] >= b[0][1] && p[1] <= b[1][1];
  const swings = (g.arcs || []).filter(([x, y, rr]) => rr * k >= 500 && rr * k <= 1300).map(([x, y]) => [x * k, y * k]);
  const doors = (g.inserts || []).filter(([x, y, rot, sx, sy, name]) => blockRole(name) === 'door').map(([x, y]) => [x * k, y * k]);
  const names = (g.texts || []).filter(([x, y, h, t]) => ROOM_WORDS.test(plain(t)) && !TAG.test(String(t))).map(([x, y]) => [x * k, y * k]);
  return groups.filter((gr) => gr.n >= 4).map((gr) => {
    const d = swings.filter((p) => inside(p, gr.box)).length + doors.filter((p) => inside(p, gr.box)).length;
    const rn = names.filter((p) => inside(p, gr.box)).length;
    const both = ws.filter((w) => inside(w.box[0], gr.box));
    const v = both.filter((w) => w.box[1][0] - w.box[0][0] < w.box[1][1] - w.box[0][1]).length, h = both.length - v;
    const balance = both.length ? Math.min(v, h) / Math.max(1, Math.max(v, h)) : 0;
    return {
      window: [[r1(gr.box[0][0] / k - 1000), r1(gr.box[0][1] / k - 1000)], [r1(gr.box[1][0] / k + 1000), r1(gr.box[1][1] / k + 1000)]], walls: gr.n, wall_length_m: Math.round(gr.len) / 1000,
      doors: d, room_names: rn, plan_score: Math.round(gr.n * (0.3 + balance) + 4 * d + 3 * rn),
    };
  }).sort((a, b) => b.plan_score - a.plan_score);
}
