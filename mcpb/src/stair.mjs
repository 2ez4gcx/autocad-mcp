// Stair detail (chi tiết cầu thang) of a U stair of the plan of draw_plan: its plan on each kind of floor (start, typical,
// arrival) with the surrounding walls, the treads numbered, the run / landing / width dimensions, the levels and the
// section mark; the section along the flights (the cut flight with its waist slab and landing, the flight seen beyond,
// the floor slabs and walls cut, the handrails, riser and going dimensions, levels); the build-up notes; and a tread and
// handrail detail at a larger scale. Pure geometry: draw_entities specs in drawing coordinates.
import { buildBuilding, fmtLevel } from './elevation.mjs';
import { notesBlock } from './interior.mjs';
import { gridList, segRect, uStairGeom, uStairPlan } from './plan.mjs';
import { dimStyleName, ROLE, TEXT_STYLE, viewTitle } from './standards.mjs';
import { sym } from './symbols.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const P = (p) => [r2(p[0]), r2(p[1])];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const sameRegion = (p, q) => JSON.stringify(p.region) === JSON.stringify(q.region);
const fmt = (v, lang) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1).replace('.', lang === 'en' ? '.' : ','));
const bboxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
const rectPoly = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(P);

const T = {
  vi: {
    plan: 'MẶT BẰNG THANG', section: 'MẶT CẮT', detail: 'CHI TIẾT BẬC THANG', landing: 'CHIẾU NGHỈ', floor: 'TẦNG',
    tread: 'CẤU TẠO BẬC THANG (TH):', land: 'CẤU TẠO CHIẾU NGHỈ (CN):',
  },
  en: {
    plan: 'STAIR PLAN', section: 'SECTION', detail: 'TREAD DETAIL', landing: 'LANDING', floor: 'FLOOR',
    tread: 'TREAD BUILD-UP (TH):', land: 'LANDING BUILD-UP (CN):',
  },
};
const BUILDUP = {
  vi: {
    tread: ['Mặt bậc, cổ bậc đá granite dày 20, mũi bậc xẻ 2 rãnh chống trơn', 'Lớp vữa XM M75 dày 20', 'Bậc xây gạch thẻ VXM M75',
      'Bản thang BTCT dày {w} (xem KC)', 'Trát trần VXM M75 dày 15, bả matit, sơn nước hoàn thiện'],
    land: ['Đá granite dày 20', 'Lớp vữa XM M75 dày 20', 'Bản chiếu nghỉ BTCT dày {w} (xem KC)', 'Trát trần VXM M75 dày 15, bả matit, sơn nước hoàn thiện'],
    rail: 'Tay vịn gỗ tự nhiên 60x80, thanh đứng sắt hộp 14x14 (2 thanh mỗi bậc), sơn tĩnh điện; lan can cao {h} tính từ mũi bậc',
  },
  en: {
    tread: ['Granite treads and risers 20 thick, two anti-slip grooves at the nosing', 'Cement mortar M75, 20', 'Steps of solid brick in mortar M75',
      'RC waist slab {w} (see structure)', 'Soffit: plaster M75 15, skim coat, emulsion paint'],
    land: ['Granite 20', 'Cement mortar M75, 20', 'RC landing slab {w} (see structure)', 'Soffit: plaster M75 15, skim coat, emulsion paint'],
    rail: 'Hardwood handrail 60x80, balusters 14x14 steel box (two per tread), powder coated; guarding {h} high above the nosings',
  },
};

/**
 * Axis-aligned union of rectangles minus cut rectangles, inside a box: its outline (edges on the box border left open,
 * the walls run on beyond the detail) and its fill as row strips. rects/cuts: [x0, y0, x1, y1].
 */
function rectUnion(rects, cuts, box) {
  const clip = (r) => [Math.max(r[0], box[0]), Math.max(r[1], box[1]), Math.min(r[2], box[2]), Math.min(r[3], box[3])];
  const R = rects.map(clip).filter((r) => r[2] - r[0] > 1 && r[3] - r[1] > 1);
  const C = cuts.map(clip).filter((r) => r[2] - r[0] > 1 && r[3] - r[1] > 1);
  const xs = [...new Set([box[0], box[2], ...R.flatMap((r) => [r[0], r[2]]), ...C.flatMap((r) => [r[0], r[2]])].map(r2))].sort((a, b) => a - b);
  const ys = [...new Set([box[1], box[3], ...R.flatMap((r) => [r[1], r[3]]), ...C.flatMap((r) => [r[1], r[3]])].map(r2))].sort((a, b) => a - b);
  const inR = (x, y, r) => x > r[0] && x < r[2] && y > r[1] && y < r[3];
  const cov = xs.slice(0, -1).map((x0, i) => ys.slice(0, -1).map((y0, j) => {
    const cx = (x0 + xs[i + 1]) / 2, cy = (y0 + ys[j + 1]) / 2;
    return R.some((r) => inR(cx, cy, r)) && !C.some((r) => inR(cx, cy, r));
  }));
  const nx = xs.length - 1, ny = ys.length - 1;
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= ny ? null : cov[i][j]);
  const edges = [];
  // horizontal edges at ys[j] between cells (i, j-1) and (i, j); the box border stays open
  for (let j = 1; j < ny; j++) {
    let start = null;
    for (let i = 0; i <= nx; i++) {
      const e = i < nx && at(i, j - 1) !== at(i, j);
      if (e && start === null) start = xs[i];
      if (!e && start !== null) { edges.push([[start, ys[j]], [xs[i], ys[j]]]); start = null; }
    }
  }
  for (let i = 1; i < nx; i++) {
    let start = null;
    for (let j = 0; j <= ny; j++) {
      const e = j < ny && at(i - 1, j) !== at(i, j);
      if (e && start === null) start = ys[j];
      if (!e && start !== null) { edges.push([[xs[i], start], [xs[i], ys[j]]]); start = null; }
    }
  }
  const strips = [];
  for (let j = 0; j < ny; j++) {
    let start = null;
    for (let i = 0; i <= nx; i++) {
      const c = i < nx && cov[i][j];
      if (c && start === null) start = xs[i];
      if (!c && start !== null) { strips.push([start, ys[j], xs[i], ys[j + 1]]); start = null; }
    }
  }
  return { edges, strips };
}

/** The stair's floors: every floor it goes up from (with its geometry) and the floor it arrives at. */
function stairFloors(spec, which) {
  const B = buildBuilding(spec);
  const first = B.find((f) => (f.spec.stairs || []).filter((s) => s.type === 'u').length > which);
  if (!first) return null;
  const st = first.spec.stairs.filter((s) => s.type === 'u')[which];
  const up = B.filter((f) => (f.spec.stairs || []).some((s) => s.type === 'u' && sameRegion(s, st)))
    .map((f) => ({ f, st: f.spec.stairs.find((s) => s.type === 'u' && sameRegion(s, st)), g: uStairGeom(f.spec.stairs.find((s) => s.type === 'u' && sameRegion(s, st)), f.height, `${f.name}.stairs`) }));
  const last = up[up.length - 1];
  const arrival = B[last.f.index + 1] ?? null;
  return { B, st, up, arrival };
}

/** One plan of the stair: the walls around it, the stair (up / both / down), numbers, dimensions, levels, section mark. */
function stairPlan({ f, g, mode, landingLevel, level, title, sc, lang, mark, grids }) {
  const out = [];
  const m = 400;
  const corners = [g.at(g.a0, g.b0), g.at(g.a1, g.b0), g.at(g.a1, g.b1), g.at(g.a0, g.b1)];
  const rb = bboxOf(corners);
  const box = [rb[0] - m, rb[1] - m, rb[2] + m, rb[3] + m];
  // walls around the stairwell, openings cut out, hatched
  const rects = [], cuts = [];
  for (const w of f.M.walls) {
    for (const s of w.segs) {
      if (Math.abs(s.d[0]) > 1e-6 && Math.abs(s.d[1]) > 1e-6) continue;
      if (w.height !== undefined) continue;
      rects.push(bboxOf(segRect(s)));
    }
  }
  for (const op of f.M.openings) {
    const r = bboxOf(segRect(op.s, op.span.from, op.span.to, 1));
    cuts.push(r);
    if (op.type === 'window' && r[0] < box[2] && r[2] > box[0] && r[1] < box[3] && r[3] > box[1]) {
      const n = [-op.s.d[1], op.s.d[0]], mid = (op.s.o1 + op.s.o2) / 2, t = Math.abs(op.s.o2 - op.s.o1);
      for (const k of [-1 / 6, 1 / 6]) {
        const a = [op.s.a[0] + op.s.d[0] * op.span.from + n[0] * (mid + k * t), op.s.a[1] + op.s.d[1] * op.span.from + n[1] * (mid + k * t)];
        const b = [a[0] + op.s.d[0] * (op.span.to - op.span.from), a[1] + op.s.d[1] * (op.span.to - op.span.from)];
        const ca = [Math.min(Math.max(a[0], box[0]), box[2]), Math.min(Math.max(a[1], box[1]), box[3])];
        const cb = [Math.min(Math.max(b[0], box[0]), box[2]), Math.min(Math.max(b[1], box[1]), box[3])];
        if (Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) > 10) out.push({ type: 'line', from: P(ca), to: P(cb), layer: ROLE.window });
      }
    }
  }
  const u = rectUnion(rects, cuts, box);
  for (const [a, b] of u.edges) out.push({ type: 'line', from: P(a), to: P(b), layer: ROLE.wall });
  for (const s of u.strips) out.push({ type: 'hatch', boundary: rectPoly(...s), pattern: 'ANSI31', scale: r2(0.4 * sc), layer: ROLE.wall_hatch });
  // the stair itself
  uStairPlan(g, mode, sc, ROLE, lang, out, 5 * sc);
  // tread numbers on the outer side of each flight
  const { a0, a1, going, n1, n2, f1, f2 } = g;
  const aL = a0 + g.run, start2 = aL - (n2 - 1) * going;
  const out1 = f1[0] < f2[0] ? f1[0] : f1[1], s1 = f1[0] < f2[0] ? 1 : -1;
  const out2 = f2[0] > f1[0] ? f2[1] : f2[0], s2 = -s1;
  const numText = (k, a, b) => out.push({ type: 'text', text: String(k).padStart(2, '0'), at: P(g.at(a, b)), height: r2(1.8 * sc), align: 'middle_center', layer: ROLE.text, style: TEXT_STYLE });
  for (let k = 1; k <= n1 - 1; k++) numText(k, a0 + (k - 0.5) * going, out1 + s1 * 0.18 * g.w);
  for (let j = 1; j <= n2 - 1; j++) numText(n1 + j, aL - (j - 0.5) * going, out2 + s2 * 0.18 * g.w);
  // dimensions: along the flights outside the walls on both sides, across before the start
  const along = Math.abs(g.u[0]) > 0.5 ? 'horizontal' : 'vertical';
  const across = along === 'horizontal' ? 'vertical' : 'horizontal';
  const DS = dimStyleName(sc);
  const dim = (pa, pb, atp, direction, text) => out.push({ type: 'dimension', kind: 'linear', from: P(pa), to: P(pb), at: P(atp), direction, ...(text ? { text } : {}), style: DS, layer: ROLE.dims });
  // the box in stair coordinates: dimension lines stand outside it, on the side of each flight
  const cs = [box[0], box[2]].flatMap((x) => [box[1], box[3]].map((y) => [x, y]));
  const bMin = Math.min(...cs.map((c) => dot(c, g.n))), bMax = Math.max(...cs.map((c) => dot(c, g.n)));
  const as = cs.map((c) => dot(c, g.u));
  const aOut = Math.min(...as), aEnd = Math.max(...as);
  const off = 8 * sc;
  const sideB = (outer, k) => (outer < (g.b0 + g.b1) / 2 ? bMin - k * off : bMax + k * off);
  const chain = (pairs, b, dir) => pairs.forEach(([pa, pb, t]) => { if (Math.abs(pb - pa) > 1) dim(g.at(pa, b), g.at(pb, b), g.at((pa + pb) / 2, b), dir, t); });
  for (const [outer, pairs] of [
    [out1, [[a0, aL, `${n1 - 1}x${fmt(going, lang)}=<>`], [aL, a1]]],
    [out2, [[a0, start2], [start2, aL, `${n2 - 1}x${fmt(going, lang)}=<>`], [aL, a1]]],
  ]) {
    chain(pairs, sideB(outer, 1), along);
    chain([[a0, a1]], sideB(outer, 2), along);
  }
  const bsx = [...new Set([g.b0, f1[0], f1[1], f2[0], f2[1], g.b1].map(r2))].sort((p, q) => p - q);
  const aD = aOut - off;
  for (let k = 0; k + 1 < bsx.length; k++) dim(g.at(aD, bsx[k]), g.at(aD, bsx[k + 1]), g.at(aD, (bsx[k] + bsx[k + 1]) / 2), across);
  dim(g.at(aD - off, g.b0), g.at(aD - off, g.b1), g.at(aD - off, (g.b0 + g.b1) / 2), across);
  // levels: the floor beside the start of flight 1 (outside flight 2, where the stair is reached), the landing
  const mid1 = (f1[0] + f1[1]) / 2, mid = (g.b0 + g.b1) / 2;
  out.push(sym('MCP_COTE', P(g.at(a0 + 1.5 * going, out2 + s1 * 0.5 * m)), { scale: sc, attrs: { COTE: level }, layer: ROLE.symbol }));
  out.push(sym('MCP_COTE', P(g.at(aL + g.landing * 0.12, mid)), { scale: sc, attrs: { COTE: landingLevel }, layer: ROLE.symbol }));
  out.push({ type: 'text', text: T[lang].landing, at: P(g.at(aL + g.landing * 0.8, mid)), height: r2(2 * sc), align: 'middle_center', layer: ROLE.text, style: TEXT_STYLE });
  // grids through the box, bubbles beyond the dimensions
  const far = 2 * off + 8 * sc;
  for (const gr of grids) {
    const vert = gr.axis === 'x';
    if (vert ? gr.at < box[0] || gr.at > box[2] : gr.at < box[1] || gr.at > box[3]) continue;
    const e0 = vert ? [gr.at, box[1] - 2 * sc] : [box[0] - far + 4.5 * sc, gr.at], e1 = vert ? [gr.at, box[3] + far - 4.5 * sc] : [box[2] + 2 * sc, gr.at];
    out.push({ type: 'line', from: P(e0), to: P(e1), layer: ROLE.grid });
    const c = vert ? [gr.at, box[3] + far] : [box[0] - far, gr.at];
    out.push(sym('MCP_TRUC', P(c), { scale: sc, attrs: { SO: String(gr.label) }, layer: ROLE.grid_tag, half: [4.5, 4.5] }));
  }
  // section mark 1-1 along flight 1, looking towards flight 2
  if (mark) {
    const nn = f2[0] > f1[0] ? g.n : [-g.n[0], -g.n[1]];
    const ang = (Math.atan2(nn[1], nn[0]) * 180) / Math.PI;
    const pa = g.at(aOut - 3 * off, mid1), pb = g.at(aEnd + off, mid1);
    for (const [p, q] of [[pa, g.at(aOut - 2 * off, mid1)], [g.at(aEnd, mid1), pb]]) out.push({ type: 'polyline', points: [P(p), P(q)], width: r2(0.7 * sc), layer: ROLE.symbol });
    for (const p of [pa, pb]) {
      out.push(sym('MCP_MUI_TEN', P([p[0] + nn[0] * 0.6 * sc, p[1] + nn[1] * 0.6 * sc]), { scale: sc, rotation: r2(ang), layer: ROLE.symbol }));
      out.push(sym('MCP_MAT_CAT', P([p[0] + nn[0] * 8.1 * sc, p[1] + nn[1] * 8.1 * sc]), { scale: sc, attrs: { TEN: mark }, layer: ROLE.symbol, half: [4, 4] }));
    }
  }
  return { entities: out, box, title };
}

/** The section along the flights through flight 1 (cut), flight 2 seen beyond. */
function stairSection({ S, sc, lang, waist, landingT, rail, mark }) {
  const { up, arrival } = S;
  const g0 = up[0].g;
  const ext = 500;
  const m1 = (g0.f1[0] + g0.f1[1]) / 2;
  // the viewer looks from flight 1 towards flight 2: drawing x runs along u or against it
  const v = g0.f2[0] > g0.f1[0] ? g0.n : [-g0.n[0], -g0.n[1]];
  const xs = dot([v[1], -v[0]], g0.u) > 0 ? 1 : -1;
  const X = (a) => xs * (a - g0.a0);
  const out = [], cutHatch = ROLE.section_hatch;
  const poly = (pts, layer = ROLE.section) => out.push({ type: 'polyline', points: pts.map(P), closed: true, layer });
  const conc = (pts) => out.push({ type: 'hatch', boundary: pts.map(P), pattern: 'SOLID', layer: cutHatch });
  const thin = (pts) => out.push({ type: 'polyline', points: pts.map(P), layer: ROLE.elevation });
  const aMin = g0.a0 - ext, aMax = g0.a1 + ext;
  const floors = [...up.map((x) => x.f), ...(arrival ? [arrival] : [])];
  // slabs at every floor level: open over the stairwell between the arrival of the flight below and the landing wall
  floors.forEach((F, k) => {
    const below = k > 0 ? up[k - 1].g : null;
    const pieces = below ? [[aMin, below.a0 + below.run - (below.n2 - 1) * below.going], [g0.a1, aMax]] : [[aMin, aMax]];
    for (const [p, q] of pieces) {
      if (q - p < 1) continue;
      const pts = rectPoly(Math.min(X(p), X(q)), F.level - F.slab, Math.max(X(p), X(q)), F.level);
      poly(pts);
      conc(pts);
    }
  });
  // the roof of the arrival floor
  const topF = floors[floors.length - 1];
  const roofT = 120, roofZ = topF.level + (topF.height ?? 3000);
  {
    const pts = rectPoly(Math.min(X(aMin), X(aMax)), roofZ, Math.max(X(aMin), X(aMax)), roofZ + roofT);
    poly(pts);
    conc(pts);
  }
  // walls the cut line crosses, floor by floor, with their openings
  floors.forEach((F, k) => {
    const nextSlab = k + 1 < floors.length ? floors[k + 1].slab : 0;
    const top = k + 1 < floors.length ? floors[k + 1].level - nextSlab : roofZ;
    for (const w of F.M.walls) {
      for (const s of w.segs) {
        const rc = segRect(s);
        const bs = rc.map((p) => dot(p, g0.n)), asg = rc.map((p) => dot(p, g0.u));
        if (m1 < Math.min(...bs) || m1 > Math.max(...bs)) continue;
        const p = Math.max(aMin, Math.min(...asg)), q = Math.min(aMax, Math.max(...asg));
        if (q - p < 1) continue;
        const wTop = w.height !== undefined ? F.level + w.height : top;
        // where the cut line crosses the wall's axis, along the wall
        const dn = dot(s.d, g0.n);
        const t = Math.abs(dn) > 1e-6 ? (m1 - dot(s.a, g0.n)) / dn : -1;
        const ops = F.M.openings.filter((op) => op.s === s && t >= op.span.from && t <= op.span.to);
        let zs = [[F.level, wTop]];
        for (const op of ops) {
          zs = zs.flatMap(([z0, z1]) => [[z0, Math.min(z1, F.level + op.sill)], [Math.max(z0, F.level + op.head), z1]]).filter(([z0, z1]) => z1 - z0 > 1);
          if (op.type === 'window') {
            const c = (X(p) + X(q)) / 2;
            for (const dx of [-15, 15]) out.push({ type: 'line', from: P([c + dx, F.level + op.sill]), to: P([c + dx, F.level + op.head]), layer: ROLE.window });
          }
        }
        for (const [z0, z1] of zs) {
          const pts = rectPoly(Math.min(X(p), X(q)), z0, Math.max(X(p), X(q)), z1);
          poly(pts);
          out.push({ type: 'hatch', boundary: pts, pattern: 'ANSI31', scale: r2(0.4 * sc), layer: cutHatch });
        }
      }
    }
  });
  // flights
  const levels = new Set(floors.map((F) => F.level));
  const dims = [];
  for (const { f, g } of up) {
    const z0 = f.level, r = g.riser, s = r / g.going, c = Math.cos(Math.atan(s));
    const aL = g.a0 + g.run, zL = z0 + g.n1 * r, start2 = aL - (g.n2 - 1) * g.going, zTop = z0 + g.risers * r;
    levels.add(zL);
    // flight 1 and the landing, cut: steps on top, the waist slab under them
    const top = [[X(g.a0), z0]];
    for (let k = 0; k < g.n1; k++) {
      top.push([X(g.a0 + k * g.going), z0 + (k + 1) * r]);
      if (k < g.n1 - 1) top.push([X(g.a0 + (k + 1) * g.going), z0 + (k + 1) * r]);
    }
    const tw = waist / c;
    const aX = Math.min(aL, g.a0 + (zL - landingT - z0 + tw) / s);
    const cutPoly = [...top, [X(g.a1), zL], [X(g.a1), zL - landingT], [X(aX), zL - landingT], [X(g.a0), z0 - tw]];
    poly(cutPoly);
    conc(cutPoly);
    // flight 2 beyond: its steps and its soffit above the landing
    const prof = [[X(aL), zL]];
    for (let j = 1; j <= g.n2; j++) {
      prof.push([X(aL - (j - 1) * g.going), zL + j * r]);
      if (j < g.n2) prof.push([X(aL - j * g.going), zL + j * r]);
    }
    thin(prof);
    const slabAbove = (floors.find((F) => Math.abs(F.level - zTop) < 1)?.slab) ?? 120;
    const ae = aL - tw / s, at = Math.max(start2, aL - (zTop - slabAbove - zL + tw) / s);
    if (ae > at) thin([[X(ae), zL], [X(at), zL + (aL - at) * s - tw]]);
    // handrails on the well side (seen), balusters at each tread
    const railLine = (aA, zA, aB, zB) => {
      thin([[X(aA), zA + rail], [X(aB), zB + rail]]);
      thin([[X(aA), zA + rail - 50], [X(aB), zB + rail - 50]]);
    };
    railLine(g.a0, z0 + r, aL, zL);
    railLine(aL, zL + r, start2, zTop);
    thin([[X(aL), zL + rail - 50], [X(aL), zL + r + rail]]);
    for (let k = 0; k < g.n1 - 1; k++) {
      const a = g.a0 + (k + 0.5) * g.going, zt = z0 + (k + 1) * r;
      thin([[X(a), zt], [X(a), z0 + r + (a - g.a0) * s + rail - 50]]);
    }
    for (let j = 1; j < g.n2; j++) {
      const a = aL - (j - 0.5) * g.going, zt = zL + j * r;
      thin([[X(a), zt], [X(a), zL + r + (aL - a) * s + rail - 50]]);
    }
    dims.push({ z0, zL, zTop, g, aL, start2 });
  }
  // dimensions: risers per flight and floor heights on the left, goings under the lowest flight
  const DS = dimStyleName(sc);
  const xL = Math.min(X(aMin), X(aMax)) - 10 * sc;
  const dimV = (z0, z1, x, text) => out.push({ type: 'dimension', kind: 'linear', from: P([x + 6 * sc, z0]), to: P([x + 6 * sc, z1]), at: P([x, (z0 + z1) / 2]), direction: 'vertical', ...(text ? { text } : {}), style: DS, layer: ROLE.dims });
  for (const d of dims) {
    dimV(d.z0, d.zL, xL, `${d.g.n1}x${fmt(d.g.riser, lang)}=<>`);
    dimV(d.zL, d.zTop, xL, `${d.g.n2}x${fmt(d.g.riser, lang)}=<>`);
  }
  const fl = [...new Set(floors.map((F) => F.level).concat([roofZ]))].sort((p, q) => p - q);
  out.push({ type: 'dim_chain', points: fl.map((z) => P([xL + 6 * sc, z])), direction: 'vertical', at: P([xL - 8 * sc, fl[0]]), style: DS, layer: ROLE.dims });
  const d0 = dims[0], zB = d0.z0 - up[0].f.slab - 10 * sc;
  const dimH = (a, b, text) => out.push({ type: 'dimension', kind: 'linear', from: P([X(a), d0.z0]), to: P([X(b), d0.z0]), at: P([(X(a) + X(b)) / 2, zB]), direction: 'horizontal', ...(text ? { text } : {}), style: DS, layer: ROLE.dims });
  dimH(d0.g.a0, d0.aL, `${d0.g.n1 - 1}x${fmt(d0.g.going, lang)}=<>`);
  dimH(d0.aL, d0.g.a1);
  // levels on the right
  const xR = Math.max(X(aMin), X(aMax));
  for (const z of [...levels].sort((p, q) => p - q)) {
    out.push({ type: 'line', from: P([xR, z]), to: P([xR + 4 * sc, z]), layer: ROLE.symbol });
    out.push(sym('MCP_COTE', P([xR + 6 * sc, z]), { scale: sc, attrs: { COTE: fmtLevel(z) }, layer: ROLE.symbol }));
  }
  const zMin = d0.z0 - up[0].f.slab;
  const cx = (X(aMin) + X(aMax)) / 2;
  out.push(...viewTitle(`${T[lang].section} ${mark}-${mark}`, cx, zMin - 24 * sc, sc, ROLE.text, lang));
  return { entities: out, bounds: [Math.min(xL - 14 * sc, X(aMin)), zMin - 32 * sc, xR + 20 * sc, roofZ + roofT + 6 * sc] };
}

/** Two steps with their build-up and the handrail, true size (drawn at the detail scale). */
function treadDetail({ g, sc, lang, waist, rail, finish }) {
  const out = [];
  const r = g.riser, b = g.going, n = 2, s = r / b;
  const L = (pts, layer = ROLE.detail) => out.push({ type: 'polyline', points: pts.map(P), layer });
  const t1 = finish, t2 = finish * 2;
  const x0 = -250, xb = n * b + t2;
  // finished profile from the floor up two steps, then the layers under it (granite at t1, mortar at t2)
  const profile = (d) => {
    const pts = [[x0, -d]];
    for (let k = 0; k < n; k++) pts.push([k * b + d, k * r - d], [k * b + d, (k + 1) * r - d]);
    pts.push([xb, n * r - d]);
    return pts;
  };
  L(profile(0), ROLE.detail_cut);
  L(profile(t1));
  L(profile(t2));
  for (let k = 0; k < n; k++) for (const dx of [25, 45]) L([[k * b + dx, (k + 1) * r], [k * b + dx, (k + 1) * r - 4]]);
  // the RC waist slab (its top through the rough inner corners), brick steps on it, plaster under it
  const wTop = (x) => s * (x - t2) - t2, tw = waist / Math.cos(Math.atan(s));
  const xa = -150;
  const slab = [[xa, wTop(xa)], [xb, wTop(xb)], [xb, wTop(xb) - tw], [xa, wTop(xa) - tw]];
  out.push({ type: 'polyline', points: slab.map(P), closed: true, layer: ROLE.detail_cut });
  out.push({ type: 'hatch', boundary: slab.map(P), pattern: 'AR-CONC', scale: r2(0.04 * sc), layer: ROLE.detail_hatch });
  for (let k = 0; k < n; k++) {
    const tri = [[k * b + t2, k * r - t2], [k * b + t2, (k + 1) * r - t2], [(k + 1) * b + t2, (k + 1) * r - t2]];
    out.push({ type: 'hatch', boundary: tri.map(P), pattern: 'ANSI31', scale: r2(0.15 * sc), layer: ROLE.detail_hatch });
  }
  L([[xa, wTop(xa) - tw - 15], [xb, wTop(xb) - tw - 15]]);
  // break lines where the detail stops
  const brk = (x, zt, zb) => {
    const zm = (zt + zb) / 2, h = 1.2 * sc;
    L([[x, zt], [x, zm + h], [x - h, zm + h / 3], [x + h, zm - h / 3], [x, zm - h], [x, zb]]);
  };
  brk(xb, n * r + 2 * sc, wTop(xb) - tw - 15 - 2 * sc);
  brk(x0, 2 * sc, -t2 - 3 * sc);
  // handrail and balusters (two per tread)
  const nose = (x) => r + s * x;
  for (let k = 0; k < n; k++) {
    for (const q of [0.25, 0.75]) {
      const x = k * b + q * b;
      L([[x - 7, (k + 1) * r], [x - 7, nose(x) + rail - 80]]);
      L([[x + 7, (k + 1) * r], [x + 7, nose(x) + rail - 80]]);
    }
  }
  const rx0 = -60, rx1 = n * b + 60;
  out.push({ type: 'polyline', points: [[rx0, nose(rx0) + rail], [rx1, nose(rx1) + rail], [rx1, nose(rx1) + rail - 80], [rx0, nose(rx0) + rail - 80]].map(P), closed: true, layer: ROLE.detail_cut });
  // dimensions on the open side: risers and the handrail height on the left, goings above the rail
  const DS = dimStyleName(sc);
  const dim = (a, c, atp, direction, text) => out.push({ type: 'dimension', kind: 'linear', from: P(a), to: P(c), at: P(atp), direction, ...(text ? { text } : {}), style: DS, layer: ROLE.dims });
  const xl = x0 - 6 * sc;
  for (let k = 0; k < n; k++) dim([k * b, k * r], [k * b, (k + 1) * r], [xl, (k + 0.5) * r], 'vertical');
  dim([0, r], [0, r + rail], [xl - 8 * sc, r + rail / 2], 'vertical');
  const zg = nose(rx1) + rail + 6 * sc;
  for (let k = 0; k < n; k++) dim([k * b, (k + 1) * r], [(k + 1) * b, (k + 2) * r], [(k + 0.5) * b, zg], 'horizontal');
  // labels with leaders on the right
  const SH = lang === 'en'
    ? ['GRANITE 20', 'MORTAR M75, 20', 'BRICK STEPS', `RC WAIST SLAB ${waist}`, 'PLASTER 15, PAINT', 'HANDRAIL 60x80', 'BALUSTERS 14x14']
    : ['ĐÁ GRANITE DÀY 20', 'VỮA XM M75 DÀY 20', 'BẬC XÂY GẠCH THẺ', `BẢN THANG BTCT DÀY ${waist}`, 'TRÁT VXM DÀY 15, SƠN', 'TAY VỊN GỖ 60x80', 'THANH ĐỨNG SẮT 14x14'];
  const xm = 1.55 * b;
  const targets = [[xm, 2 * r - t1 / 2], [xm, 2 * r - 1.5 * t1], [1.3 * b, wTop(1.3 * b) + 30], [xm, wTop(xm) - tw / 2], [xm, wTop(xm) - tw - 8],
    [rx1 - 40, nose(rx1 - 40) + rail - 40], [1.75 * b + 7, 2 * r + 150]];
  const xT = xb + 10 * sc;
  const yTop = nose(rx1) + rail - 2 * sc;
  targets.forEach((p, i) => {
    const order = [5, 6, 0, 1, 2, 3, 4].indexOf(i);
    const y = yTop - order * 7 * sc;
    out.push({ type: 'leader', points: [P(p), P([xT - 3 * sc, y]), P([xT, y])], text: SH[i], height: r2(2 * sc), leader_style: DS, layer: ROLE.note });
  });
  out.push(...viewTitle(T[lang].detail, (x0 + xb) / 2 + 20 * sc, wTop(xa) - tw - 20 * sc, sc, ROLE.text, lang));
  return { entities: out };
}

/**
 * The stair detail of the U stair number `stair` (0 = the first) of the building spec: parts drawn at `scale` (plans,
 * section, notes) and at `detailScale` (tread and handrail), each in its own coordinates; the caller places them.
 */
export function stairDetail({ spec, stair = 0, scale = 50, detailScale = 20, waist = 120, landing = 120, rail = 900, finish = 20, lang = 'vi' }) {
  const sc = scale;
  const S = stairFloors(spec, stair);
  if (!S) return null;
  const assumed = [];
  assumed.push({ item: 'waist', value: `${waist} mm`, note: 'RC waist and landing slabs (structure to confirm)' });
  assumed.push({ item: 'rail', value: `${rail} mm`, note: 'handrail height above the nosings' });
  assumed.push({ item: 'finish', value: `granite ${finish} + mortar ${finish}`, note: 'treads, risers and landing' });
  const grids = [...gridList(spec.grids?.x, 'x').map((g) => ({ ...g, axis: 'x' })), ...gridList(spec.grids?.y, 'y').map((g) => ({ ...g, axis: 'y' }))];
  const t = T[lang] ?? T.vi;
  // the plans: start floor, typical floors (grouped when their stairs are the same), arrival floor
  const kinds = [];
  S.up.forEach(({ f, g }, k) => {
    const mode = k === 0 && !(f.spec.stairs_below || []).some((b) => sameRegion(b, S.st)) ? 'up' : 'both';
    const prev = kinds[kinds.length - 1];
    if (prev && prev.mode === 'both' && mode === 'both' && Math.abs(prev.g.riser - g.riser) < 0.01 && prev.g.risers === g.risers) {
      prev.names.push(f.name);
      return;
    }
    kinds.push({ f, g, mode, levels: [f.level], landings: [f.level + g.n1 * g.riser], names: [f.name] });
  });
  for (const kd of kinds) {
    if (kd.names.length < 2) continue;
    // a group of typical floors: the levels of every floor of it
    const fl = S.up.filter(({ f }) => kd.names.includes(f.name));
    kd.levels = fl.map(({ f }) => f.level);
    kd.landings = fl.map(({ f, g }) => f.level + g.n1 * g.riser);
  }
  if (S.arrival) {
    const last = S.up[S.up.length - 1];
    kinds.push({ f: S.arrival, g: last.g, mode: 'down', levels: [S.arrival.level], landings: [last.f.level + last.g.n1 * last.g.riser], names: [S.arrival.name] });
  }
  const parts = [];
  const plans = kinds.map((kd) => {
    const floorsOnly = kd.names.every((n) => /^(TẦNG|FLOOR)\s/i.test(String(n)));
    const title = floorsOnly
      ? `${t.plan} ${t.floor} ${kd.names.map((n) => String(n).replace(/^(TẦNG|FLOOR)\s*/i, '')).join(', ')}`
      : `${t.plan} ${kd.names.join(', ')}`;
    return stairPlan({ ...kd, level: kd.levels.map(fmtLevel).join('; '), landingLevel: kd.landings.map(fmtLevel).join('; '), title, sc, lang, mark: '1', grids });
  });
  // the plans in a grid of two columns, the bottom row on 0; a cell: the box, its dimensions and bubbles, its title
  const padL = 26 * sc, padR = 14 * sc, padB = 46 * sc, padT = 30 * sc;
  const cw = Math.max(...plans.map((p) => p.box[2] - p.box[0])) + padL + padR;
  const ch = Math.max(...plans.map((p) => p.box[3] - p.box[1])) + padB + padT;
  const cols = Math.min(2, plans.length), rows = Math.ceil(plans.length / cols);
  plans.forEach((p, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x0 = col * cw, y0 = (rows - 1 - row) * ch;
    const dx = x0 + padL - p.box[0], dy = y0 + padB - p.box[1];
    parts.push(...p.entities.map((e) => shiftEnt(e, dx, dy)));
    parts.push(...viewTitle(p.title, (p.box[0] + p.box[2]) / 2 + dx, y0 + 8 * sc, sc, ROLE.text, lang));
  });
  // the section to the right of the plans, its title on the line of the bottom row's titles
  const sec = stairSection({ S, sc, lang, waist, landingT: landing, rail, mark: '1' });
  const sdx = cols * cw - sec.bounds[0], sdy = -sec.bounds[1];
  parts.push(...sec.entities.map((e) => shiftEnt(e, sdx, sdy)));
  const secRight = sec.bounds[2] + sdx;
  // the notes in the free cell of the grid, else right of the section
  const free = plans.length % cols !== 0;
  const notesAt = free ? [(plans.length % cols) * cw + padL, ch - padT] : [secRight + 12 * sc, sec.bounds[3] + sdy];
  const notesW = free ? (cw - padL - 4 * sc) / sc : 110;
  // notes: build-up of the treads and landing, the stair's figures
  const g = S.up[0].g;
  const B = BUILDUP[lang] ?? BUILDUP.vi;
  const fig = lang === 'en'
    ? [`Risers h = ${fmt(g.riser, lang)}, goings b = ${fmt(g.going, lang)}: 2h + b = ${Math.round(2 * g.riser + g.going)} (600 to 650 recommended)`, `Flights ${Math.round(g.w)} wide, landing ${Math.round(g.landing)}, well ${Math.round(g.gap)}`]
    : [`Chiều cao bậc h = ${fmt(g.riser, lang)}, bề rộng bậc b = ${fmt(g.going, lang)}: 2h + b = ${Math.round(2 * g.riser + g.going)} (nên 600 ÷ 650)`, `Vế thang rộng ${Math.round(g.w)}, chiếu nghỉ rộng ${Math.round(g.landing)}, khe giữa 2 vế ${Math.round(g.gap)}`];
  const lines = [
    `${t.tread} ${B.tread.map((l) => l.replace('{w}', waist)).join('; ')}.`,
    `${t.land} ${B.land.map((l) => l.replace('{w}', landing)).join('; ')}.`,
    `${B.rail.replace('{p}', Math.round(g.going / 2)).replace('{h}', rail)}.`,
    ...fig.map((l) => `${l}.`),
  ];
  parts.push(...notesBlock(lines, notesAt, sc, lang, notesW));
  const detail = treadDetail({ g, sc: detailScale, lang, waist, rail, finish });
  return {
    main: parts, detail: detail.entities, assumed,
    stair: { risers: g.risers, riser: r2(g.riser), going: r2(g.going), width: Math.round(g.w), landing: Math.round(g.landing), plans: kinds.map((k) => ({ floors: k.names, mode: k.mode })) },
  };
}

/** Shift a draw_entities spec by (dx, dy). */
function shiftEnt(e, dx, dy) {
  const s = (p) => [r2(p[0] + dx), r2(p[1] + dy)];
  const o = { ...e };
  for (const k of ['from', 'to', 'at', 'center', 'start', 'end']) if (Array.isArray(o[k])) o[k] = s(o[k]);
  for (const k of ['points', 'boundary']) if (Array.isArray(o[k])) o[k] = o[k].map(s);
  if (Array.isArray(o.box)) o.box = [o.box[0] + dx, o.box[1] + dy, o.box[2] + dx, o.box[3] + dy];
  return o;
}
