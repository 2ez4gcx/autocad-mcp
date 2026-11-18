// Preliminary structural calculation (bảng tính kết cấu sơ bộ) of the frame the structural plans draw: loads by
// TCVN 2737:2023 (slab build-ups, partitions, walls on the beams, live loads by room, cantilever balconies), the slab
// panels shared out to their beams (two-way: trapezoid and triangle, one-way), continuous beams analysed elastically
// with the live load on all, odd and even spans (moments from the equivalent uniform loads, shear and reactions from
// the tributary loads; beams resting on beams and columns standing on beams as point loads), sections designed by
// TCVN 5574:2018 (bending: αm, ξ ≤ ξR; shear: stirrups), column loads summed floor by floor down to the footings,
// columns and pad footings sized for them, slabs, stairs and balconies by the strip method. It is preliminary:
// a licensed structural engineer checks it, calculates it again and signs it. Pure computation and draw_entities specs.
import { buildModel, floorsOf } from './elevation.mjs';
import { gridList, num, PlanError, uStairGeom } from './plan.mjs';
import { floorTag, TEXT_STYLE, ROOM } from './standards.mjs';
import { framingPlan, SL } from './structure.mjs';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const area = (d) => (Math.PI * d * d) / 4;
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** TCVN 5574:2018, design strengths in MPa (Table 10 concrete, Table 13 steel). */
export const CONCRETE = { B15: { Rb: 8.5, Rbt: 0.75, Eb: 24000 }, B20: { Rb: 11.5, Rbt: 0.9, Eb: 27500 }, B25: { Rb: 14.5, Rbt: 1.05, Eb: 30000 }, B30: { Rb: 17, Rbt: 1.15, Eb: 32500 } };
export const STEEL = {
  'CB240-T': { Rs: 210, Rsc: 210, Rsw: 170 }, 'CB300-V': { Rs: 260, Rsc: 260, Rsw: 210 },
  'CB400-V': { Rs: 350, Rsc: 350, Rsw: 280 }, 'CB500-V': { Rs: 435, Rsc: 400, Rsw: 300 },
};
const ES = 200000;

/** Live loads (kPa, TCVN 2737:2023 for dwellings) by room name; the first match wins. */
export const LIVE = [
  { key: 'stair', re: ROOM.stairs, p: 3, vi: 'Cầu thang', en: 'Stairs' },
  { key: 'hall', re: ROOM.hall, p: 3, vi: 'Sảnh, hành lang', en: 'Halls, corridors' },
  { key: 'balcony', re: ROOM.balcony, p: 2, vi: 'Ban công, sân phơi', en: 'Balconies' },
  { key: 'terrace', re: ROOM.terrace, p: 1.5, vi: 'Sân thượng (mái có sử dụng)', en: 'Roof terrace (used)' },
  { key: 'wet', re: ROOM.wet, p: 1.5, vi: 'Phòng vệ sinh', en: 'Toilets' },
  { key: 'store', re: ROOM.store, p: 2, vi: 'Kho nhỏ trong nhà ở', en: 'Small stores' },
  { key: 'room', re: /.*/, p: 1.5, vi: 'Phòng ở, phòng khách, bếp, phòng thờ', en: 'Rooms, living, kitchen' },
];
/**
 * The prefix of the beams of a slab: Vietnamese GM. ground beams (giằng móng), D2. floor 2 (dầm), DT. stair tower, DM.
 * roof; English GB., B2., BT., RB.
 */
export function beamPrefix(where, name, k, lang = 'vi') {
  const en = lang === 'en';
  if (where === 'foundation') return en ? 'GB.' : 'GM.';
  if (where === 'roof') return en ? 'RB.' : 'DM.';
  return `${en ? 'B' : 'D'}${floorTag(name, String(k + 1))}.`;
}

export const ROOF_LIVE = { key: 'roof', p: 0.75, vi: 'Mái BTCT không sử dụng', en: 'RC roof, not used' };
export const gammaLive = (p) => (p < 2 ? 1.3 : 1.2);
/**
 * Cantilever balconies (TCVN 2737:2023): p over the whole slab or the strip load on a band of the given width along
 * the railing, the worse of the two; the railing as a line load (kN/m, steel or glass with its kerb).
 */
export const BALCONY = { p: 2, strip: 4, width: 0.8, rail: 0.6 };

/** Build-ups (name, thickness m, unit weight kN/m³ or load kPa when thickness is null, γf). SLAB = the RC slab. */
export const BUILDUP = {
  floor: [['Gạch lát dày 10', 'Floor tiles 10', 0.01, 20, 1.1], ['Vữa lót XM M75 dày 30', 'Mortar bed M75 30', 0.03, 18, 1.3], 'SLAB',
    ['Vữa trát trần dày 15', 'Soffit plaster 15', 0.015, 18, 1.3], ['Trần, đường ống, thiết bị', 'Ceiling and services', null, 0.3, 1.2]],
  wet: [['Chống thấm, vữa tạo dốc dày 50', 'Waterproofing, screed to falls 50', 0.05, 20, 1.3]],
  terrace: [['Gạch lát dày 10', 'Tiles 10', 0.01, 20, 1.1], ['Vữa tạo dốc trung bình dày 60', 'Screed to falls, average 60', 0.06, 18, 1.3],
    ['Chống thấm', 'Waterproofing', null, 0.1, 1.3], 'SLAB', ['Vữa trát trần dày 15', 'Soffit plaster 15', 0.015, 18, 1.3]],
  roof: [['Vữa tạo dốc trung bình dày 60', 'Screed to falls, average 60', 0.06, 18, 1.3], ['Chống thấm', 'Waterproofing', null, 0.1, 1.3], 'SLAB',
    ['Vữa trát trần dày 15', 'Soffit plaster 15', 0.015, 18, 1.3]],
  // the stair over its plan area: waist slab, steps and finishes
  stair: [['Bản thang, bậc xây, hoàn thiện (quy đổi trên mặt bằng)', 'Waist slab, steps and finishes (on plan)', null, 6, 1.15]],
};

export function layerLoads(kind, slab, lang, wet = false) {
  const rows = [];
  const list = [...BUILDUP[kind], ...(wet ? BUILDUP.wet : [])];
  for (const L of list) {
    if (L === 'SLAB') rows.push({ name: lang === 'en' ? `RC slab ${slab}` : `Sàn BTCT dày ${slab}`, gk: (slab / 1000) * 25, gf: 1.1 });
    else rows.push({ name: lang === 'en' ? L[1] : L[0], gk: L[2] === null ? L[3] : L[2] * L[3], gf: L[4] });
  }
  const gk = rows.reduce((s, r) => s + r.gk, 0), g = rows.reduce((s, r) => s + r.gk * r.gf, 0);
  return { rows, gk, g };
}

/** Wall load per m² of face (kPa): brick 18 kN/m³ γf 1.1, plaster 15 mm both sides γf 1.3. */
export const wallKPa = (t) => ({ gk: (t / 1000) * 18 + 2 * 0.015 * 18, g: (t / 1000) * 18 * 1.1 + 2 * 0.015 * 18 * 1.3 });

/** Self-weight of a beam below its slab with the plaster on its sides (kN/m, design). */
export const beamSelf = (b, h, slab) => {
  const web = Math.max(0, h - slab) / 1000;
  return (b / 1000) * web * 25 * 1.1 + 2 * web * 0.015 * 18 * 1.3;
};

function uniq(vals, tol) {
  const out = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

/**
 * Three-moment equation (tridiagonal): support moments (kNm, hogging negative) for given end moments M0, Mn.
 * pts: per span, point loads [{a (m from the left support), P (kN)}].
 */
export function supportMoments(L, q, M0 = 0, Mn = 0, pts = null) {
  const n = L.length;
  const M = new Array(n + 1).fill(0);
  M[0] = M0;
  M[n] = Mn;
  if (n < 2) return M;
  const a = [], b = [], c = [], d = [];
  for (let i = 1; i < n; i++) {
    a.push(L[i - 1]);
    b.push(2 * (L[i - 1] + L[i]));
    c.push(L[i]);
    let rhs = -(q[i - 1] * L[i - 1] ** 3 + q[i] * L[i] ** 3) / 4;
    for (const t of pts?.[i - 1] ?? []) rhs -= (t.P * t.a * (L[i - 1] ** 2 - t.a ** 2)) / L[i - 1];
    for (const t of pts?.[i] ?? []) {
      const e = L[i] - t.a;
      rhs -= (t.P * e * (L[i] ** 2 - e ** 2)) / L[i];
    }
    d.push(rhs - (i === 1 ? M0 * L[0] : 0) - (i === n - 1 ? Mn * L[n - 1] : 0));
  }
  // Thomas algorithm
  const m = b.length;
  for (let i = 1; i < m; i++) {
    const w = a[i] / b[i - 1];
    b[i] -= w * c[i - 1];
    d[i] -= w * d[i - 1];
  }
  const x = new Array(m);
  x[m - 1] = d[m - 1] / b[m - 1];
  for (let i = m - 2; i >= 0; i--) x[i] = (d[i] - c[i] * x[i + 1]) / b[i];
  for (let i = 1; i < n; i++) M[i] = x[i - 1];
  return M;
}

/** Shears at both ends and the largest sagging moment of a span with end moments Ml, Mr and point loads (kN, kNm). */
function spanForces(L, q, Ml, Mr, pts = []) {
  const Vl = (Mr - Ml) / L + (q * L) / 2 + sum(pts.map((t) => (t.P * (L - t.a)) / L));
  const Vr = Vl - q * L - sum(pts.map((t) => t.P));
  const Mat = (x) => Ml + Vl * x - (q * x * x) / 2 - sum(pts.map((t) => (t.a < x ? t.P * (x - t.a) : 0)));
  const xs = [0, ...pts.map((t) => t.a), L];
  let Mmax = Math.max(Ml, Mr);
  for (let k = 0; k + 1 < xs.length; k++) {
    const x0 = xs[k], x1 = xs[k + 1];
    Mmax = Math.max(Mmax, Mat(x0), Mat(x1));
    // where the shear is zero between two point loads
    const V0 = Vl - q * x0 - sum(pts.map((t) => (t.a <= x0 + 1e-9 ? t.P : 0)));
    if (q > 0) {
      const xz = x0 + V0 / q;
      if (xz > x0 && xz < x1) Mmax = Math.max(Mmax, Mat(xz));
    }
  }
  return { Vl, Vr, Mmax };
}

/**
 * A continuous beam: spans L (m), dead g and live p per span (kN/m), point loads [{i (span), a (m from its left
 * support), P (kN)}] taken as permanent. Envelope of the live load on all spans, on the odd and on the even spans;
 * the monolithic end supports (beams framing into columns: ends[k] = 1) take q·L²/24 hogging, in equilibrium with
 * the spans; an end that rests on another beam (ends[k] = 0) is a hinge. Reactions from the full load.
 */
export function analyseBeam(L, g, p, points = [], ends = [1, 1]) {
  const n = L.length;
  const pts = L.map((_, i) => points.filter((t) => t.i === i && t.P > 0).map((t) => ({ a: Math.max(0, Math.min(L[i], t.a)), P: t.P })).sort((x, y) => x.a - y.a));
  const patterns = [L.map(() => true), L.map((_, i) => i % 2 === 0), L.map((_, i) => i % 2 === 1)];
  const span = L.map(() => ({ M: 0, V: 0 })), sup = new Array(n + 1).fill(0);
  let reactions = null;
  for (const [k, on] of patterns.entries()) {
    const q = L.map((_, i) => g[i] + (on[i] ? p[i] : 0));
    // the end moments: of the uniform load, and of the uniform load that gives the same moment as the point loads
    const qe = (i) => q[i] + sum(pts[i].map((t) => (8 * t.P * t.a * (L[i] - t.a)) / L[i] ** 3));
    const M = supportMoments(L, q, ends[0] ? -(qe(0) * L[0] ** 2) / 24 : 0, ends[1] ? -(qe(n - 1) * L[n - 1] ** 2) / 24 : 0, pts);
    const R = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const f = spanForces(L[i], q[i], M[i], M[i + 1], pts[i]);
      span[i].M = Math.max(span[i].M, f.Mmax);
      span[i].V = Math.max(span[i].V, Math.abs(f.Vl), Math.abs(f.Vr));
      R[i] += f.Vl;
      R[i + 1] += -f.Vr;
    }
    for (let i = 0; i <= n; i++) sup[i] = Math.min(sup[i], M[i]);
    if (k === 0) reactions = R;
  }
  return { span, sup, reactions };
}

/** Bending (TCVN 5574:2018, rectangular section, single reinforcement): required As (mm²) for M (kNm). */
export function flexure(M, b, h, mat, a = 40) {
  const h0 = h - a;
  const { Rb } = mat.c, { Rs } = mat.s;
  const xiR = 0.8 / (1 + Rs / ES / 0.0035), aR = xiR * (1 - xiR / 2);
  const am = (Math.abs(M) * 1e6) / (Rb * b * h0 * h0);
  const ok = am <= aR;
  const xi = 1 - Math.sqrt(1 - 2 * Math.min(am, aR));
  const As = Math.max((xi * Rb * b * h0) / Rs, 0.001 * b * h0);
  return { h0, am, xi, xiR, aR, As, ok, mu: (As / (b * h0)) * 100 };
}

/** Bars for As: 2 to 4 of one diameter in one layer that fit the width, the least area with each bar over two counted 10 % more (fewer, larger bars). */
export function chooseBars(As, b, cover = 25, stirrup = 6) {
  let best = null;
  for (const d of [12, 14, 16, 18, 20, 22, 25]) {
    for (let n = 2; n <= 4; n++) {
      const fits = n * d + (n - 1) * Math.max(25, d) + 2 * (cover + stirrup) <= b;
      const A = n * area(d), cost = A * (1 + 0.1 * (n - 2));
      if (!fits || A < As) continue;
      if (!best || cost < best.cost - 1) best = { n, d, A, cost };
    }
  }
  return best && { n: best.n, d: best.d, A: best.A };
}

/** Shear (TCVN 5574:2018 8.1.3): stirrups Ø6 (Ø8 when Ø6 would be closer than 100) of two legs, spacing at the supports and midspan. */
export function stirrups(Q, b, h, mat, a = 40) {
  const h0 = h - a;
  const { Rb, Rbt } = mat.c, { Rsw } = mat.sw;
  const N = Math.abs(Q) * 1e3;
  const ok = N <= 0.3 * Rb * b * h0;
  const qMin = 0.25 * Rbt * b;
  const qReq = N > 0.5 * Rbt * b * h0 ? Math.max((N - 0.75 * Rbt * b * h0) / (1.5 * h0), qMin) : qMin;
  const sMax = N > 0 ? (Rbt * b * h0 * h0) / N : Infinity;
  const pick = (d) => {
    const s = Math.min((Rsw * 2 * area(d)) / qReq, sMax, h0 / 2, 300);
    return Math.floor(s / 50) * 50;
  };
  let d = 6, s = pick(6);
  if (s < 100) { d = 8; s = pick(8); }
  const span = Math.max(s, Math.min(Math.floor((0.75 * h0) / 50) * 50, 300));
  return { d, support: Math.max(s, 50), span, ok: ok && s >= 100, qReq };
}

/**
 * The slab panels between the beam lines (an orthogonal grid), with the edges that have a beam along them, and their
 * loads shared out to those edges as equivalent uniform loads per metre.
 */
export function panelEdges(members, tol = 30) {
  const vert = members.filter((m) => Math.abs(m.d[0]) < 0.01), hor = members.filter((m) => Math.abs(m.d[1]) < 0.01);
  const xs = uniq(vert.map((m) => m.A[0]), tol), ys = uniq(hor.map((m) => m.A[1]), tol);
  const beamOn = (horiz, c, a0, a1) => (horiz ? hor : vert).find((m) => {
    const k = horiz ? 1 : 0, j = horiz ? 0 : 1;
    return Math.abs(m.A[k] - c) < tol && Math.min(m.A[j], m.B[j]) <= a0 + tol && Math.max(m.A[j], m.B[j]) >= a1 - tol;
  });
  const all = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      all.push({ x0, x1, y0, y1, e: {
        bottom: beamOn(true, y0, x0, x1), top: beamOn(true, y1, x0, x1),
        left: beamOn(false, x0, y0, y1), right: beamOn(false, x1, y0, y1),
      } });
    }
  }
  // a beam that stops short does not cut the slab beyond its end: two cells with no beam between them, on the same
  // beams along their other sides, are one panel
  for (let again = true; again;) {
    again = false;
    search: for (const a of all) {
      for (const b of all) {
        if (a === b) continue;
        if (Math.abs(a.x1 - b.x0) < tol && a.y0 === b.y0 && a.y1 === b.y1 && !a.e.right && !b.e.left && a.e.bottom === b.e.bottom && a.e.top === b.e.top) {
          a.x1 = b.x1;
          a.e.right = b.e.right;
        } else if (Math.abs(a.y1 - b.y0) < tol && a.x0 === b.x0 && a.x1 === b.x1 && !a.e.top && !b.e.bottom && a.e.left === b.e.left && a.e.right === b.e.right) {
          a.y1 = b.y1;
          a.e.top = b.e.top;
        } else continue;
        all.splice(all.indexOf(b), 1);
        again = true;
        break search;
      }
    }
  }
  return all.filter(({ e }) => {
    const n = Object.values(e).filter(Boolean).length;
    // fewer than three edges carried, or two adjacent ones: not a slab panel of this frame
    return !(n < 2 || (n === 2 && !((e.bottom && e.top) || (e.left && e.right))));
  });
}

/**
 * The loads of a panel on each carried edge, per metre of the edge and per kPa on the panel: k, the uniform load of
 * the same largest moment (trapezoid lx/2·(1 - 2β² + β³), triangle 5/8·lx/2), for the bending of the beam; kT, the
 * load the edge really takes (trapezoid lx/2·(1 - β), triangle lx/4), for its shear and its reactions.
 */
function shareOut(cell) {
  const wx = (cell.x1 - cell.x0) / 1000, wy = (cell.y1 - cell.y0) / 1000;
  const { bottom, top, left, right } = cell.e;
  const out = [];
  const xPair = bottom && top, yPair = left && right;
  if (xPair && yPair && Math.max(wx, wy) / Math.min(wx, wy) <= 2) {
    // two-way: trapezoid on the long edges, triangle on the short edges
    const lx = Math.min(wx, wy), ly = Math.max(wx, wy), beta = lx / (2 * ly);
    const trap = (lx / 2) * (1 - 2 * beta ** 2 + beta ** 3), tri = (lx / 2) * (5 / 8);
    const trapT = (lx / 2) * (1 - beta), triT = lx / 4;
    const horizLong = wx >= wy;
    for (const [k, m] of [['bottom', bottom], ['top', top]]) out.push({ edge: k, m, k: horizLong ? trap : tri, kT: horizLong ? trapT : triT });
    for (const [k, m] of [['left', left], ['right', right]]) out.push({ edge: k, m, k: horizLong ? tri : trap, kT: horizLong ? triT : trapT });
  } else if (xPair && (!yPair || wy <= wx)) {
    // one-way between the bottom and top beams (across wy)
    for (const [k, m] of [['bottom', bottom], ['top', top]]) out.push({ edge: k, m, k: wy / 2, kT: wy / 2 });
  } else {
    for (const [k, m] of [['left', left], ['right', right]]) out.push({ edge: k, m, k: wx / 2, kT: wx / 2 });
  }
  return out;
}

/** The range [u0, u1] (mm along the member) of an edge or a wall on it. */
const along = (m, p, q) => {
  const a = dot(sub(p, m.A), m.d), b = dot(sub(q, m.A), m.d);
  return [Math.max(0, Math.min(a, b)), Math.min(m.L, Math.max(a, b))];
};

/**
 * Adds a line load over [u0, u1] of member m to its spans, spread uniformly over each span it covers: g, p for the
 * bending (equivalent), gT, pT for the shear and the reactions (default the same); terms: what it is made of.
 */
function addLine(m, u0, u1, ld) {
  if (u1 - u0 < 1) return;
  for (let i = 0; i + 1 < m.supports.length; i++) {
    const s0 = m.supports[i], s1 = m.supports[i + 1], L = s1 - s0;
    const ov = Math.min(u1, s1) - Math.max(u0, s0);
    if (ov <= 1 || L <= 1) continue;
    const f = ov / L;
    m.load[i].g += (ld.g ?? 0) * f;
    m.load[i].p += (ld.p ?? 0) * f;
    m.true[i].g += (ld.gT ?? ld.g ?? 0) * f;
    m.true[i].p += (ld.pT ?? ld.p ?? 0) * f;
    for (const t of ld.terms ?? []) m.terms[i].push(t.type === 'const' ? { ...t, g: t.g * f, p: t.p * f } : { ...t, k: t.k * f });
  }
}

/** A point load P (kN) at u (mm along the member): on a span, or straight into the support it stands on. */
function addPoint(m, u, P) {
  if (!(P > 0)) return;
  const n = m.supports.length;
  const j = m.supports.findIndex((s) => Math.abs(s - u) <= 100);
  if (j >= 0) {
    m.extra[j] += P;
    return;
  }
  for (let i = 0; i + 1 < n; i++) {
    if (u > m.supports[i] && u < m.supports[i + 1]) {
      m.points.push({ i, a: (u - m.supports[i]) / 1000, P });
      m.point = (m.point ?? 0) + P;
      return;
    }
  }
  m.extra[u <= m.supports[0] ? 0 : n - 1] += P;
}

/** [u0, u1] less the ranges already covered: the pieces left. */
function cutOut([u0, u1], covered) {
  let runs = [[u0, u1]];
  for (const [c0, c1] of covered) {
    runs = runs.flatMap(([a, b]) => {
      if (c1 <= a + 1 || c0 >= b - 1) return [[a, b]];
      return [[a, Math.min(b, c0)], [Math.max(a, c1), b]].filter(([x, y]) => y - x > 1);
    });
  }
  return runs;
}

/** Wall axis of a wall segment (its offsets from the drawn line). */
function wallAxis(s) {
  const n = [-s.d[1], s.d[0]], c = (s.o1 + s.o2) / 2;
  return { A: [s.a[0] + n[0] * c, s.a[1] + n[1] * c], B: [s.b[0] + n[0] * c, s.b[1] + n[1] * c] };
}

/** The build-up of a kind of slab: floor, wet (floor with waterproofing), terrace, roof, stair. */
const buildOf = (key, slab, lang) => layerLoads(key === 'wet' ? 'floor' : key, slab, lang, key === 'wet');

/**
 * Loads on one slab's beams: panels (build-up and live load of the rooms over each, by the share of the panel each
 * room takes; partitions standing on it), the walls standing on the beams, the cantilever balconies of the floor and
 * the self-weight of the beams. above: the floor whose walls stand on the slab (null: roof). Every load goes into the
 * equivalent set (load, for the bending) and into the true set (true, for the shear and the reactions); terms keeps
 * what each span's load is made of.
 */
function slabLoads({ members, above, rooms, stairs, kind, slab, height, lang, roofLive, balconies = [], warnings = [], name = '' }) {
  for (const m of members) {
    const n = m.supports.length - 1;
    m.load = Array.from({ length: n }, () => ({ g: 0, p: 0 }));
    m.true = Array.from({ length: n }, () => ({ g: 0, p: 0 }));
    m.terms = Array.from({ length: n }, () => []);
    m.points = [];
    m.extra = m.supports.map(() => 0);
  }
  // the ground beams carry walls only (the ground floor slab lies on the ground)
  const cells = kind === 'foundation' ? [] : panelEdges(members);
  const used = new Map();
  const polys = Object.entries(rooms || {});
  const roomOf = (c) => {
    for (const [nm, poly] of polys) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > c[1]) !== (yj > c[1]) && c[0] < ((xj - xi) * (c[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return nm;
    }
    return null;
  };
  // walls of the floor above: on a beam (line load), else partitions on the panel they stand in
  const M = above ? buildModel(above.spec) : null;
  const wallLoads = [];
  const part = cells.map(() => []);
  if (M) {
    // the full-height walls first: a low wall (parapet) on a beam where one already stands is that wall, not a second one
    const covered = new Map();
    for (const low of [false, true]) {
      for (const w of M.walls) {
        const wh = w.height !== undefined ? w.height : null;
        if ((wh !== null) !== low) continue;
        for (const s of w.segs) {
          const ax = wallAxis(s);
          const hosts = members.filter((m) => Math.abs(cross(m.d, s.d)) < 1e-6 && Math.abs(cross(m.d, sub(ax.A, m.A))) < 30 && along(m, ax.A, ax.B)[1] - along(m, ax.A, ax.B)[0] > 1);
          const ops = M.openings.filter((op) => op.s === s);
          const k = wallKPa(s.t);
          const opPt = (v) => [s.a[0] + s.d[0] * v, s.a[1] + s.d[1] * v];
          for (const host of hosts) {
            const H = (wh ?? height - host.h) / 1000;
            const [u0, u1] = along(host, ax.A, ax.B);
            const runs = low ? cutOut([u0, u1], covered.get(host) ?? []) : [[u0, u1]];
            if (!low) covered.set(host, [...(covered.get(host) ?? []), [u0, u1]]);
            for (const [a0, a1] of runs) {
              for (let i = 0; i + 1 < host.supports.length; i++) {
                const s0 = Math.max(a0, host.supports[i]), s1 = Math.min(a1, host.supports[i + 1]);
                if (s1 - s0 < 1) continue;
                // the openings in it take their area off
                let A = ((s1 - s0) / 1000) * H;
                for (const op of ops) {
                  const [a, b] = along(host, opPt(op.span.from), opPt(op.span.to));
                  const ov = Math.min(b, s1) - Math.max(a, s0);
                  if (ov > 1) A -= (ov / 1000) * Math.max(0, Math.min(op.head, H * 1000) - op.sill) / 1000;
                }
                const L = (host.supports[i + 1] - host.supports[i]) / 1000;
                const a = Math.max(0, A) / L;
                host.load[i].g += a * k.g;
                host.true[i].g += a * k.g;
                host.terms[i].push({ type: 'wall', t: s.t, k: a });
                wallLoads.push({ t: s.t, H: r2(H), member: host.name, q: r2(a * k.g) });
              }
            }
          }
          if (hosts.length) continue;
          // a partition on the slab: its weight (less its openings) over the panel it stands in
          const H = (wh ?? height - slab) / 1000;
          const horiz = Math.abs(s.d[0]) > 0.5, j = horiz ? 0 : 1;
          cells.forEach((c, ci) => {
            // the length of the wall inside the panel (walls along the plan axes)
            const [lo, hi] = horiz ? [c.x0, c.x1] : [c.y0, c.y1];
            const across = horiz ? ax.A[1] : ax.A[0];
            const inBand = horiz ? across > c.y0 && across < c.y1 : across > c.x0 && across < c.x1;
            const q0 = Math.max(lo, Math.min(ax.A[j], ax.B[j])), q1 = Math.min(hi, Math.max(ax.A[j], ax.B[j]));
            if (!inBand || q1 - q0 <= 1) return;
            let A = ((q1 - q0) / 1000) * H;
            for (const op of ops) {
              const o0 = opPt(op.span.from)[j], o1 = opPt(op.span.to)[j];
              const ov = Math.min(q1, Math.max(o0, o1)) - Math.max(q0, Math.min(o0, o1));
              if (ov > 1) A -= (ov / 1000) * Math.max(0, Math.min(op.head, H * 1000) - op.sill) / 1000;
            }
            const Ac = ((c.x1 - c.x0) * (c.y1 - c.y0)) / 1e6;
            part[ci].push({ t: s.t, a: Math.max(0, A) / Ac });
          });
        }
      }
    }
  }
  // panels: build-up and live load of the rooms over each, weighted by the share of the panel each takes (12 x 12 points)
  const N = 12;
  const fallback = LIVE[LIVE.length - 1];
  cells.forEach((c, ci) => {
    const mix = new Map(), names = new Map();
    let none = 0, stairN = 0;
    const hit = (key, live, build) => {
      const e = mix.get(`${key}|${build}`) ?? { key, live, build, n: 0 };
      e.n++;
      mix.set(`${key}|${build}`, e);
    };
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const p = [c.x0 + ((i + 0.5) / N) * (c.x1 - c.x0), c.y0 + ((j + 0.5) / N) * (c.y1 - c.y0)];
        if ((stairs || []).some((b) => p[0] > b[0] && p[0] < b[2] && p[1] > b[1] && p[1] < b[3])) {
          stairN++;
          hit('stair', LIVE[0], 'stair');
        } else if (kind === 'roof') hit('roof', roofLive, 'roof');
        else {
          const nm = roomOf(p);
          if (nm === null) { none++; continue; }
          names.set(nm, (names.get(nm) ?? 0) + 1);
          const live = LIVE.find((x) => x.re.test(nm)) ?? fallback;
          hit(live.key, live, live.key === 'terrace' ? 'terrace' : live.key === 'wet' ? 'wet' : 'floor');
        }
      }
    }
    // points on no measured room: rooms as a whole when no room was measured, else on the walls between rooms
    if (none && (!polys.length || !mix.size)) for (let i = 0; i < none; i++) hit(fallback.key, fallback, 'floor');
    const total = sum([...mix.values()].map((e) => e.n));
    let g = 0, p = 0;
    const terms = [];
    for (const e of mix.values()) {
      const w = e.n / total, build = buildOf(e.build, slab, lang);
      g += w * build.g;
      p += w * e.live.p * gammaLive(e.live.p);
      if (!used.has(`${e.key}|${e.build}`)) used.set(`${e.key}|${e.build}`, { live: e.live, build });
      terms.push({ type: 'slab', build: e.build, live: e.live.key, k: w });
    }
    for (const q of part[ci]) {
      g += q.a * wallKPa(q.t).g;
      terms.push({ type: 'wall', t: q.t, k: q.a });
    }
    c.room = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    c.stair = stairN / (N * N);
    c.g = g;
    c.p = p;
    for (const e of shareOut(c)) {
      const [p0, p1] = e.edge === 'bottom' ? [[c.x0, c.y0], [c.x1, c.y0]] : e.edge === 'top' ? [[c.x0, c.y1], [c.x1, c.y1]]
        : e.edge === 'left' ? [[c.x0, c.y0], [c.x0, c.y1]] : [[c.x1, c.y0], [c.x1, c.y1]];
      const [u0, u1] = along(e.m, p0, p1);
      addLine(e.m, u0, u1, { g: g * e.k, p: p * e.k, gT: g * e.kT, pT: p * e.kT, terms: terms.map((t) => ({ ...t, k: t.k * e.k })) });
    }
  });
  // cantilever balconies: the slab beyond the frame hangs on the beam along it (dead load, the worse of the live load
  // over the whole slab and of the strip load along the railing, the railing)
  const bal = [];
  for (const [bi, bc] of (kind === 'floor' ? balconies || [] : []).entries()) {
    if (!bc?.region) continue;
    const xs = bc.region.map((q) => q[0]), ys = bc.region.map((q) => q[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const sides = [
      { p: [box[0], box[1]], q: [box[2], box[1]], horiz: true, c: box[1], out: box[3] - box[1] }, { p: [box[0], box[3]], q: [box[2], box[3]], horiz: true, c: box[3], out: box[3] - box[1] },
      { p: [box[0], box[1]], q: [box[0], box[3]], horiz: false, c: box[0], out: box[2] - box[0] }, { p: [box[2], box[1]], q: [box[2], box[3]], horiz: false, c: box[2], out: box[2] - box[0] },
    ];
    let best = null;
    for (const sd of sides) {
      const len = sd.horiz ? box[2] - box[0] : box[3] - box[1];
      for (const m of members) {
        if (sd.horiz ? Math.abs(m.d[1]) > 0.01 : Math.abs(m.d[0]) > 0.01) continue;
        const dist = Math.abs((sd.horiz ? m.A[1] : m.A[0]) - sd.c);
        if (dist > 400) continue;
        const [u0, u1] = along(m, sd.p, sd.q);
        if (u1 - u0 < 0.5 * len) continue;
        if (!best || u1 - u0 > best.u1 - best.u0) best = { m, u0, u1, d: (sd.out + dist) / 1000, horiz: sd.horiz };
      }
    }
    if (!best) {
      warnings.push(`${name}: balcony ${bi + 1} has no beam of the frame along it: its load is not carried (give it a beam)`);
      continue;
    }
    const build = buildOf('wet', slab, lang), live = LIVE.find((x) => x.key === 'balcony');
    const { d } = best, len = (best.u1 - best.u0) / 1000, gf = gammaLive(live.p), wS = Math.min(BALCONY.width, d);
    const rail = BALCONY.rail * 1.1;
    // the whole balcony on the length of the beam it hangs on (the slab may run past the beam ends)
    const full = Math.max(1, (best.horiz ? box[2] - box[0] : box[3] - box[1]) / 1000 / len);
    const gLine = (build.g * d + rail * (1 + (2 * d) / (len * full))) * full;
    const pLine = Math.max(live.p * d, BALCONY.strip * wS) * gf * full;
    // the cantilever moment per metre at the beam (kNm/m): the slab, the railing at its edge, the live load
    const Mc = (build.g * d * d) / 2 + rail * d + Math.max((live.p * d * d) / 2, BALCONY.strip * wS * (d - wS / 2)) * gf;
    addLine(best.m, best.u0, best.u1, { g: gLine, p: pLine, terms: [{ type: 'const', g: gLine, p: pLine, what: 'balcony' }] });
    if (!used.has('balcony|wet')) used.set('balcony|wet', { live: { ...live, vi: `Ban công công xôn (hoặc ${BALCONY.strip} x ${String(BALCONY.width).replace('.', ',')} m)`, en: `Cantilever balcony (or ${BALCONY.strip} x ${BALCONY.width} m)` }, build });
    bal.push({ box, host: best.m.name, d: r2(d), len: r2(len), g: build.g, gLine, pLine, M: Mc });
  }
  // self-weight of the beams below the slab, plaster on their sides
  for (const m of members) {
    const sw = beamSelf(m.b, m.h, slab);
    m.load.forEach((ld, i) => {
      ld.g += sw;
      m.true[i].g += sw;
      m.terms[i].push({ type: 'self' });
    });
  }
  return { cells, used, wallLoads, balconies: bal };
}

/** The order to analyse the beams in: one that rests on another before the beam that carries it. */
function restOrder(members) {
  const n = members.length, waits = new Array(n).fill(0);
  for (const m of members) for (const r of m.rests ?? []) if (r.on >= 0) waits[r.on]++;
  const order = [], queue = [];
  for (let k = 0; k < n; k++) if (!waits[k]) queue.push(k);
  while (queue.length) {
    const k = queue.shift();
    order.push(k);
    for (const r of members[k].rests ?? []) if (r.on >= 0 && --waits[r.on] === 0) queue.push(r.on);
  }
  // beams that rest on each other in a ring: taken as they come
  for (let k = 0; k < n; k++) if (!order.includes(k)) order.push(k);
  return order;
}

// ---------------------------------------------------------------- columns, footings, slabs

/** Buckling factor φ of an axially loaded column by l0/h (TCVN 5574:2018 8.1.2.4.2, long-term loads). */
export function buckling(lambda) {
  const T = [[6, 0.92], [10, 0.9], [15, 0.83], [20, 0.7]];
  if (lambda <= T[0][0]) return T[0][1];
  for (let i = 0; i + 1 < T.length; i++) {
    if (lambda <= T[i + 1][0]) return T[i][1] + ((T[i + 1][1] - T[i][1]) * (lambda - T[i][0])) / (T[i + 1][0] - T[i][0]);
  }
  // beyond l0/h = 20 the formula no longer applies: carried on along the last slope, and warned
  return Math.max(0.3, 0.7 - 0.026 * (lambda - 20));
}

/**
 * A rectangular column in eccentric compression about one axis, bars the same on both faces (TCVN 5574:2018 8.1.2.3,
 * 8.1.2.4): b across the bending, h along it (mm), N (kN), M (kNm, first order), l0 (mm), AsFace the bars on each of the
 * two faces (mm²), a their cover to the bar centre. e0 = M/N, at least the random eccentricity ea = max(l0/600, h/30,
 * 10); η = 1 / (1 - N/Ncr) with D = 0.15 Eb I / (φl (0.3 + δe)) + 0.7 Es Is, φl = 2 (the load is mostly long-term);
 * x from the equilibrium (σs falling from Rs past ξR), then N e ≤ Rb b x (h0 - x/2) + Rsc As' (h0 - a').
 * Returns {e0, ea, eta, x, Mu (kNm, the moment about the tension bars the section takes), util = N e / Mu, ok}.
 */
export function eccentricColumn({ N, M, b, h, l0, AsFace, a = 40, mat }) {
  const { Rb, Eb = 27500 } = mat.c, { Rs, Rsc } = mat.s;
  const h0 = h - a, Nn = N * 1000;
  if (!(Nn > 0)) return { e0: 0, ea: 0, eta: 1, x: 0, Mu: 0, util: 0, ok: true };
  const ea = Math.max(l0 / 600, h / 30, 10);
  const e0 = Math.max((Math.abs(M) * 1e6) / Nn, ea);
  const de = Math.min(1.5, Math.max(0.15, e0 / h));
  const I = (b * h ** 3) / 12, Is = 2 * AsFace * (h / 2 - a) ** 2;
  const D = (0.15 * Eb * I) / (2 * (0.3 + de)) + 0.7 * ES * Is;
  const Ncr = (Math.PI ** 2 * D) / l0 ** 2;
  if (Nn >= 0.95 * Ncr) return { e0, ea, eta: Infinity, x: h, Mu: 0, util: Infinity, ok: false, Ncr: Ncr / 1000 };
  const eta = 1 / (1 - Nn / Ncr);
  const e = e0 * eta + h / 2 - a;
  const xiR = 0.8 / (1 + Rs / ES / 0.0035);
  // equilibrium: N = Rb b x + Rsc As' - σs As, σs = Rs up to ξR h0, then falling to -Rsc at x = h0 (linear in x/h0)
  const sigma = (x) => (x <= xiR * h0 ? Rs : Math.max(-Rsc, Rs * ((2 * (1 - x / h0)) / (1 - xiR) - 1)));
  const f = (x) => Rb * b * x + Rsc * AsFace - sigma(x) * AsFace - Nn;
  let x;
  const x1 = (Nn - Rsc * AsFace + Rs * AsFace) / (Rb * b);
  if (x1 <= xiR * h0) x = Math.max(x1, 0);
  else {
    let lo = xiR * h0, hi = h;
    if (f(hi) < 0) x = h;
    else {
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (f(mid) > 0) hi = mid;
        else lo = mid;
      }
      x = (lo + hi) / 2;
    }
  }
  // a compression zone thinner than 2a': the compression bars do not yield, moment about them instead
  let Mu, need;
  if (x < 2 * a) {
    Mu = Rs * AsFace * (h0 - a);
    need = Nn * Math.max(0, e0 * eta - h / 2 + a);
  } else {
    Mu = Rb * b * x * (h0 - x / 2) + Rsc * AsFace * (h0 - a);
    need = Nn * e;
  }
  const util = Mu > 0 ? need / Mu : Infinity;
  return { e0, ea, eta, x, Mu: Mu / 1e6, util, ok: util <= 1 + 1e-9, Ncr: Ncr / 1000 };
}

/** Column sections tried in turn (short side, long side, bars n, d: about 1.4 to 1.7 % of steel). */
const COLUMN_SIZES = [[220, 220, 4, 16], [220, 300, 4, 18], [300, 300, 4, 20], [300, 400, 6, 20], [400, 400, 8, 20], [400, 500, 8, 22], [500, 500, 8, 25], [500, 600, 10, 25], [600, 600, 12, 25]];
const columnBars = (b, h) => {
  const hit = COLUMN_SIZES.find((q) => q[0] === Math.min(b, h) && q[1] === Math.max(b, h));
  if (hit) return { n: hit[2], d: hit[3] };
  const need = 0.012 * b * h;
  for (const [n, d] of [[4, 16], [4, 18], [4, 20], [6, 18], [6, 20], [8, 20], [8, 22], [8, 25], [10, 25], [12, 25]]) if (n * area(d) >= need) return { n, d };
  return { n: 12, d: 25 };
};

/** Bottom mesh options of a pad footing (d, spacing), by area. */
const MESH = [[12, 200], [12, 150], [12, 120], [14, 150], [12, 100], [14, 120], [16, 150], [14, 100], [16, 120], [16, 100], [18, 100], [20, 100]];

/**
 * A square pad footing for N (kN, design) on a column size: side from the bearing pressure (Ntc = N / 1.15 over
 * R - γtb·Hm, rounded up to step), thickness from punching (F ≤ Rbt·u·h0 on the perimeter h0/2 from the column),
 * bottom mesh from the bending of the cantilever at the column face.
 */
function padFooting(N, col, mat, { pNet, minSide, H0, step = 100, side: fixed = null }) {
  const Ntc = N / 1.15, Areq = pNet > 0 ? Ntc / pNet : Infinity;
  const side = fixed ?? Math.max(minSide, Math.ceil((Math.sqrt(Areq) * 1000) / step - 1e-9) * step);
  const A = (side / 1000) ** 2, p = N / A;
  let H = H0, punch = true;
  for (; ; H += 50) {
    const h0 = H - 60;
    const inner = ((col[0] + 2 * h0) / 1000) * ((col[1] + 2 * h0) / 1000);
    const F = Math.max(0, p * (A - inner)), u = 2 * (col[0] + col[1] + 2 * h0);
    if (F * 1000 <= mat.c.Rbt * u * h0) break;
    if (H >= 1200) { punch = false; break; }
  }
  const c = (side - Math.min(col[0], col[1])) / 2000, M = (p * c * c) / 2, h0 = H - 60;
  const As = Math.max((M * 1e6) / (0.9 * mat.s.Rs * h0), 0.001 * 1000 * h0);
  const pick = MESH.find(([d, s]) => (area(d) * 1000) / s >= As) ?? MESH[MESH.length - 1];
  return { Ntc, Areq, side, A, H, punch, M, As, mesh: { d: pick[0], spacing: pick[1] }, meshOk: (area(pick[0]) * 1000) / pick[1] >= As };
}

/** Slab bars (d, spacing) by area; plain bars under 10 mm of the stirrup grade, ribbed bars from 10 mm. */
const STRIP = [[8, 200], [8, 150], [10, 200], [8, 120], [8, 100], [10, 150], [10, 120], [12, 150], [10, 100], [12, 120], [12, 100], [14, 120], [14, 100]];

/** The tension a slab strip 1 m wide needs for M (kNm/m): {T (N/m), ok (αm ≤ αR)}. */
function stripNeed(M, h, a, mat) {
  const h0 = h - a;
  const am = (Math.abs(M) * 1e6) / (mat.c.Rb * 1000 * h0 * h0);
  const xiR = 0.8 / (1 + mat.s.Rs / ES / 0.0035), aR = xiR * (1 - xiR / 2);
  const xi = 1 - Math.sqrt(1 - 2 * Math.min(am, aR));
  return { T: xi * mat.c.Rb * 1000 * h0, ok: am <= aR };
}

/** The lightest bars of STRIP for the tension T (N/m): {d, s, A (mm²/m), As (needed for that grade), ok}. */
function stripBars(T, mat, minD = 8) {
  const rs = (d) => (d < 10 ? mat.sw.Rs : mat.s.Rs);
  const list = STRIP.filter(([d]) => d >= minD);
  const pick = list.find(([d, s]) => ((area(d) * 1000) / s) * rs(d) >= T - 1e-6) ?? list[list.length - 1];
  const A = (area(pick[0]) * 1000) / pick[1];
  return { d: pick[0], s: pick[1], A, As: T / rs(pick[0]), ok: A * rs(pick[0]) >= T - 1e-6 };
}

/**
 * The bars of a slab by the strip method. A two-way panel (l2/l1 ≤ 2, carried on four sides) by Marcus: its load
 * shared between its two ways by equal deflection at the centre (5, 2, 1 for no, one, two continuous ends), elastic
 * strip moments (span q·l²/8, 9/128, /24; support q·l²/8, /12), the span moments reduced for the twisting of the
 * panel (1 - 5/6·(l/l')²·M/M0). A one-way panel: q·l²/8, /11, /16 in the span, q·l²/8, /12 over the supports.
 * One set of bars for the slab, for its worst panel: bottom along X, bottom along Y, top over the beams between panels.
 */
function designSlab(S, mat) {
  const h = S.slab;
  const cells = (S.loads?.cells ?? []).filter((c) => (c.stair ?? 0) < 0.5);
  if (!cells.length || !(h > 0)) return null;
  const touch = (a, b, side) => {
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return side === 'left' ? Math.abs(b.x1 - a.x0) < 60 && oy > 100 : side === 'right' ? Math.abs(b.x0 - a.x1) < 60 && oy > 100
      : side === 'bottom' ? Math.abs(b.y1 - a.y0) < 60 && ox > 100 : Math.abs(b.y0 - a.y1) < 60 && ox > 100;
  };
  const cont = (c, side) => (cells.some((o) => o !== c && touch(c, o, side)) ? 1 : 0);
  const SPAN = [8, 11, 16], SUP = [0, 8, 12], DEFL = [5, 2, 1], ELASTIC = [1 / 8, 9 / 128, 1 / 24];
  const need = { x: 0, y: 0, top: 0 }, Mmax = { x: 0, y: 0, top: 0 };
  let ok = true, worst = null;
  for (const c of cells) {
    const wx = (c.x1 - c.x0) / 1000, wy = (c.y1 - c.y0) / 1000, q = c.g + c.p;
    // the strips along x rest on the left and right beams, those along y on the bottom and top beams
    const sx = c.e.left && c.e.right, sy = c.e.bottom && c.e.top;
    const nx = cont(c, 'left') + cont(c, 'right'), ny = cont(c, 'bottom') + cont(c, 'top');
    let qx, qy;
    const two = !!(sx && sy && Math.max(wx, wy) / Math.min(wx, wy) <= 2);
    if (two) {
      qx = (q * DEFL[ny] * wy ** 4) / (DEFL[nx] * wx ** 4 + DEFL[ny] * wy ** 4);
      qy = q - qx;
    } else if (sx && (!sy || wx <= wy)) [qx, qy] = [q, 0];
    else [qx, qy] = [0, q];
    let Mx = (qx * wx * wx) / SPAN[nx], My = (qy * wy * wy) / SPAN[ny];
    if (two) {
      const mx = qx * wx * wx * ELASTIC[nx], my = qy * wy * wy * ELASTIC[ny];
      Mx = mx * Math.max(0.5, 1 - (5 / 6) * (wx / wy) ** 2 * (mx / ((q * wx * wx) / 8)));
      My = my * Math.max(0.5, 1 - (5 / 6) * (wy / wx) ** 2 * (my / ((q * wy * wy) / 8)));
    }
    const Ms = Math.max(nx ? (qx * wx * wx) / SUP[nx] : 0, ny ? (qy * wy * wy) / SUP[ny] : 0);
    // the bars of the shorter way lie lowest
    const ax = wx <= wy ? 20 : 30, ay = wx <= wy ? 30 : 20;
    const tx = stripNeed(Mx, h, ax, mat), ty = stripNeed(My, h, ay, mat), tt = stripNeed(Ms, h, 20, mat);
    ok = ok && tx.ok && ty.ok && tt.ok;
    need.x = Math.max(need.x, tx.T);
    need.y = Math.max(need.y, ty.T);
    need.top = Math.max(need.top, tt.T);
    Mmax.x = Math.max(Mmax.x, Mx);
    Mmax.y = Math.max(Mmax.y, My);
    Mmax.top = Math.max(Mmax.top, Ms);
    const big = Math.max(Mx, My, Ms);
    if (!worst || big > worst.big) worst = { big, wx, wy, q, two };
  }
  // across a one-way panel: distribution bars, a fifth of the main ones at least
  const x = stripBars(Math.max(need.x, 0.2 * need.y), mat), y = stripBars(Math.max(need.y, 0.2 * need.x), mat), top = stripBars(need.top, mat);
  return { h, panels: cells.length, worst, M: Mmax, x, y, top, ok: ok && x.ok && y.ok && top.ok };
}

/**
 * The calculation of the whole frame of the building spec: the ground beams, every slab (floors 2.. and the roof),
 * taken from the top down so that a column standing on a slab (a stair tower's) hands its load to the beam under it;
 * then the columns and the footings (sized for their loads), the slabs, the stairs and the balconies.
 * rooms: {floorIndex: {name: poly}} (live loads by room).
 */
export function structuralCalc({ spec, rooms = {}, concrete = 'B20', steel = 'CB300-V', stirrupSteel = 'CB240-T', cover = 25, soil = 100, footing = {}, column = {}, lang = 'vi' }) {
  const mat = { c: CONCRETE[concrete], s: STEEL[steel], sw: STEEL[stirrupSteel] };
  if (!mat.c) throw new PlanError(`concrete must be one of ${Object.keys(CONCRETE).join(', ')}`);
  if (!mat.s || !mat.sw) throw new PlanError(`steel must be one of ${Object.keys(STEEL).join(', ')}`);
  const assumed = [], warnings = [];
  const en = lang === 'en';
  const F = floorsOf(spec);
  if (F.length < 2) throw new PlanError('the calculation needs a building of several floors (floors [...])');
  const ground = spec.heights?.ground ?? -450;
  const depth = num(spec.heights?.foundation?.depth ?? 1500, 'heights.foundation.depth', { positive: true });
  const fH = num(footing.H ?? 400, 'footing.H', { positive: true });
  const stairBoxes = (f) => (f.spec.stairs_below || []).filter((st) => st.region).map((st) => {
    const xs = st.region.map((q) => q[0]), ys = st.region.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const FOUND = en ? 'FOUNDATION' : 'MÓNG', ROOF = en ? 'ROOF' : 'MÁI';
  const plain = { size: column.size, at_grids: column.at_grids };
  // the levels from the bottom: ground beams (the ground floor walls on them), slabs of floors 2..n, the roof
  const slabs = [];
  {
    const f0 = F[0];
    const fp = framingPlan({ spec: f0.spec, level: ground, slab: 120, name: FOUND, prefix: beamPrefix('foundation', FOUND, 0, lang), beam: { h: 400 }, column: plain, foundation: { depth }, lang });
    slabs.push({ name: FOUND, level: ground, slab: 0, fp, above: f0, kind: 'foundation', rooms: {}, stairs: [], balconies: [], height: f0.height + Math.abs(ground) });
  }
  for (let k = 1; k < F.length; k++) {
    const f = F[k], below = F[k - 1];
    const fp = framingPlan({ spec: below.spec, level: f.level, slab: f.slab, name: f.name, prefix: beamPrefix('floor', f.name, k, lang), column: plain, lang });
    // tag: the floor in the marks of its slab and balconies (S2-1), as in those of its beams (D2.1)
    slabs.push({ name: f.name, tag: floorTag(f.name, String(k + 1)), level: f.level, slab: f.slab, fp, above: f, kind: 'floor', rooms: rooms[k] ?? {}, stairs: stairBoxes(f), balconies: f.spec.balconies ?? [], height: f.height });
  }
  {
    const t = F[F.length - 1];
    const fp = framingPlan({ spec: t.spec, level: t.level + t.height + 120, slab: 120, name: ROOF, prefix: beamPrefix('roof', ROOF, F.length, lang), column: plain, lang });
    slabs.push({ name: ROOF, tag: en ? 'R' : 'M', level: t.level + t.height + 120, slab: 120, fp, above: null, kind: 'roof', rooms: {}, stairs: [], balconies: [], height: 0 });
  }
  assumed.push({ item: 'materials', value: `${concrete} (Rb ${mat.c.Rb}, Rbt ${mat.c.Rbt} MPa), ${steel} (Rs ${mat.s.Rs}), ${stirrupSteel} (Rsw ${mat.sw.Rsw})` });
  assumed.push({ item: 'live loads', value: LIVE.map((x) => `${x.vi} ${x.p}`).join('; ') + `; ${ROOF_LIVE.vi} ${ROOF_LIVE.p} kPa`, note: 'TCVN 2737:2023, γf 1.3 (< 2 kPa) / 1.2' });
  assumed.push({ item: 'walls', value: 'brick 18 kN/m³ γf 1.1, plaster 2 x 15 mm γf 1.3, openings deducted' });
  assumed.push({ item: 'analysis', value: 'continuous beams, live load on all / odd / even spans; end supports qL²/24; bending from the equivalent slab loads, shear and column loads from the tributary loads; rectangular sections; a = 40 mm' });
  const base = column.size ?? [220, 220];
  const colKN = (size) => (size[0] / 1000) * (size[1] / 1000) * 25 * 1.1;
  const gx = gridList(spec.grids?.x, 'x'), gy = gridList(spec.grids?.y, 'y');
  const label = (p) => {
    const x = gx.find((g) => Math.abs(g.at - p[0]) < 300), y = gy.find((g) => Math.abs(g.at - p[1]) < 300);
    return x && y ? `${x.label}-${y.label}` : `(${Math.round(p[0])}, ${Math.round(p[1])})`;
  };
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 150;
  const stacks = [];
  const stackAt = (p) => {
    let c = stacks.find((q) => near(q.p, p));
    if (!c) stacks.push((c = { p, name: label(p), R: 0, H: 0, hs: [], levels: [], bottom: null, top: null, on: null }));
    return c;
  };
  // from the top down: loads, analysis, reactions into the columns; a column with none under it rests on a beam
  const transfers = slabs.map(() => []);
  for (let i = slabs.length - 1; i >= 0; i--) {
    const S = slabs[i];
    const members = S.fp.members.map((m) => ({ ...m }));
    S.loads = slabLoads({ members, above: S.above, rooms: S.rooms, stairs: S.stairs, kind: S.kind, slab: S.slab, height: S.height, lang, roofLive: ROOF_LIVE, balconies: S.balconies, warnings, name: S.name });
    S.members = members;
    S.carried = [];
    // the columns standing on this slab's beams: point loads
    for (const t of transfers[i]) addPoint(members[t.k], t.u, t.P);
    for (const k of restOrder(members)) {
      const m = members[k];
      const L = m.supports.slice(1).map((u, j) => (u - m.supports[j]) / 1000);
      m.span = L;
      const rests = m.rests ?? [];
      const ends = [rests.some((r) => r.u < 1) ? 0 : 1, rests.some((r) => r.u > m.L - 1) ? 0 : 1];
      // bending from the equivalent loads; shear and reactions from the loads the beam really takes
      m.res = analyseBeam(L, m.load.map((x) => x.g), m.load.map((x) => x.p), m.points, ends);
      const T = analyseBeam(L, m.true.map((x) => x.g), m.true.map((x) => x.p), m.points, ends);
      m.V = T.span.map((x) => x.V);
      m.reactions = T.reactions.map((R, j) => R + m.extra[j]);
      // an end that rests on another beam: its reaction is a point load on that beam
      for (const r of rests) {
        const j = r.u < 1 ? 0 : m.supports.length - 1;
        const Rj = Math.max(0, m.reactions[j]);
        const p = [m.A[0] + m.d[0] * r.u, m.A[1] + m.d[1] * r.u];
        const host = r.on >= 0 ? members[r.on] : null;
        if (!host || host.res) {
          S.carried.push({ beam: m.name, on: null, R: Rj, at: p });
          warnings.push(host
            ? `${S.name}: beams ${m.name} and ${host.name} rest on each other at ${label(p)}: ${r1(Rj)} kN is not carried down (add a column)`
            : `${S.name}: beam ${m.name} ends on nothing at ${label(p)}: ${r1(Rj)} kN is not carried down (add a column or a beam under its end)`);
          continue;
        }
        addPoint(host, dot(sub(p, host.A), host.d), Rj);
        S.carried.push({ beam: m.name, on: host.name, R: Rj, at: p });
      }
    }
    // beam on beam, said once per pair of beam types
    const pairs = new Map();
    for (const q of S.carried.filter((x) => x.on)) pairs.set(`${q.beam}|${q.on}`, Math.max(pairs.get(`${q.beam}|${q.on}`) ?? 0, q.R));
    for (const [k, R] of pairs) {
      const [a, b] = k.split('|');
      warnings.push(`${S.name}: beam ${a} rests on beam ${b}: its reaction (up to ${r1(R)} kN) is a point load on ${b}; add hanger stirrups there`);
    }
    // reactions at this slab's columns (the storey under it); the storey's own weight follows from the column size
    const storey = i > 0 ? (S.level - slabs[i - 1].level) / 1000 : (depth - fH + ground) / 1000;
    for (const p of S.fp.columnPoints) {
      const c = stackAt(p);
      if (c.on) continue;
      let R = 0;
      const parts = [];
      // fixed-end moments of the spans on each side of the column (dead load, and dead + live), beam stiffnesses
      const fem = { x: { neg: [0, 0], pos: [0, 0], Kb: 0 }, y: { neg: [0, 0], pos: [0, 0], Kb: 0 } };
      for (const m of members) {
        m.supports.forEach((u, j) => {
          if (!near([m.A[0] + m.d[0] * u, m.A[1] + m.d[1] * u], c.p)) return;
          // a beam may pull up on a column (a short span beside a long one): the beams meeting there are summed
          R += m.reactions[j];
          parts.push({ beam: m.name, R: m.reactions[j] });
          if (!m.span || !m.load) return;
          const F = fem[Math.abs(m.d[0]) >= Math.abs(m.d[1]) ? 'x' : 'y'];
          const fwd = m.d[0] + m.d[1] >= 0;
          for (const [s, side] of [[j - 1, fwd ? 'neg' : 'pos'], [j, fwd ? 'pos' : 'neg']]) {
            const L = m.span[s], q = m.load[s];
            if (!(L > 0) || !q) continue;
            F[side][0] += (q.g * L * L) / 12;
            F[side][1] += ((q.g + q.p) * L * L) / 12;
            F.Kb += ((m.b * m.h ** 3) / 12) / (L * 1000);
          }
        });
      }
      // the worst unbalance: the live load on one side only
      const unb = (F) => Math.max(Math.abs(F.pos[1] - F.neg[0]), Math.abs(F.neg[1] - F.pos[0]));
      R = Math.max(0, R);
      c.R += R;
      c.H += storey;
      if (i > 0) c.hs.push(storey);
      c.levels.push({ slab: S.name, R, parts, h: storey, dM: { x: unb(fem.x), y: unb(fem.y) }, Kb: { x: fem.x.Kb, y: fem.y.Kb } });
      if (c.top === null) c.top = S.level;
      c.bottom = i > 0 ? slabs[i - 1].level : -(depth - fH);
    }
    // columns of this storey with no column under them stand on the slab below: their load goes to its beam
    if (i > 0) {
      const lower = slabs[i - 1];
      for (const c of stacks) {
        if (c.on || !S.fp.columnPoints.some((p) => near(p, c.p)) || lower.fp.columnPoints.some((p) => near(p, c.p))) continue;
        const k = lower.fp.members.findIndex((m) => {
          const v = sub(c.p, m.A), u = dot(v, m.d);
          return u > 0 && u < m.L && Math.abs(cross(m.d, v)) < 150;
        });
        c.on = lower.name;
        if (k < 0) {
          warnings.push(`column ${c.name} of ${S.name} has neither a column nor a beam under it`);
          continue;
        }
        const host = lower.fp.members[k];
        transfers[i - 1].push({ k, u: dot(sub(c.p, host.A), host.d), P: c.R + colKN(base) * c.H });
      }
    }
  }
  // design of each beam type (the worst of its members)
  for (const S of slabs) {
    const types = new Map();
    for (const m of S.members) {
      const t = types.get(m.name) ?? { name: m.name, b: m.b, h: m.h, count: 0, spans: m.span, Mspan: 0, Msup: 0, Q: 0, q: 0, terms: [], point: 0 };
      t.count++;
      t.Mspan = Math.max(t.Mspan, ...m.res.span.map((x) => x.M));
      t.Msup = Math.min(t.Msup, ...m.res.sup);
      t.Q = Math.max(t.Q, ...m.V);
      m.load.forEach((x, j) => {
        if (x.g + x.p > t.q) {
          t.q = x.g + x.p;
          t.terms = m.terms[j];
        }
      });
      t.point = Math.max(t.point, m.point ?? 0);
      types.set(m.name, t);
    }
    for (const t of types.values()) {
      const fs = flexure(t.Mspan, t.b, t.h, mat), fh = flexure(t.Msup, t.b, t.h, mat);
      const bs = chooseBars(fs.As, t.b, cover), bh = chooseBars(fh.As, t.b, cover);
      const sw = stirrups(t.Q, t.b, t.h, mat);
      const bottom = bs ?? { n: 2, d: 25, A: 2 * area(25) }, topSup = bh ?? { n: 2, d: 25, A: 2 * area(25) };
      const ok = fs.ok && fh.ok && sw.ok && !!bs && !!bh;
      if (!ok) warnings.push(`${t.name} (${t.b}x${t.h}): ${!fs.ok || !fh.ok ? 'αm > αR' : !sw.ok ? 'shear' : 'bars do not fit'}: make the section larger`);
      Object.assign(t, {
        flexSpan: fs, flexSup: fh, barsSpan: bottom, barsSup: topSup, stirrup: sw, ok,
        bars: {
          support: [{ face: 'bottom', d: bottom.d, n: Math.max(2, bottom.n) }, { face: 'top', d: topSup.d, n: topSup.n }],
          span: [{ face: 'bottom', d: bottom.d, n: bottom.n }, { face: 'top', d: 12, n: 2 }],
        },
        stirrups: { d: sw.d, support: sw.support, span: sw.span },
      });
    }
    S.types = [...types.values()];
  }
  // ---- columns: axial load with the buckling factor by l0/h (l0 = 0.7 H); a size that fails goes up to the next one
  const pts = stacks.map((c) => c.p);
  const X0 = Math.min(...pts.map((p) => p[0])), X1 = Math.max(...pts.map((p) => p[0])), Y0 = Math.min(...pts.map((p) => p[1])), Y1 = Math.max(...pts.map((p) => p[1]));
  // the long side of a column along the long side of the plan (in the long walls)
  const alongY = Y1 - Y0 >= X1 - X0;
  const orient = (a, b) => (alongY ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)]);
  const baseArea = base[0] * base[1];
  const tries = [{ size: base, bars: column.bars ?? columnBars(base[0], base[1]) },
    ...COLUMN_SIZES.filter((q) => q[0] * q[1] > baseArea && q[0] >= Math.min(...base)).map((q) => ({ size: orient(q[0], q[1]), bars: { n: q[2], d: q[3] } }))];
  // bars on one face of a section: 2 of 4, 3 of 8 (and of 6 on the long faces), 4 of 12, in proportion beyond
  const faceBars = (n) => (n <= 4 ? 2 : n <= 8 ? 3 : Math.round(n / 4) + 1);
  const check = (c, t) => {
    const N = c.R + colKN(t.size) * c.H;
    const l0 = 700 * Math.max(...c.hs, 0), lambda = l0 / Math.min(...t.size), phi = buckling(lambda);
    const As = t.bars.n * area(t.bars.d);
    const cap = (phi * (mat.c.Rb * t.size[0] * t.size[1] + mat.s.Rsc * As)) / 1000;
    // eccentric compression storey by storey (levels from the top down): the moment the beams at the top of the storey
    // cannot balance, shared between the column above, the column below and the beams by their stiffness
    let ecc = null, Ncum = 0, Hcum = 0;
    const AsFace = faceBars(t.bars.n) * area(t.bars.d), aBar = cover + 8 + t.bars.d / 2;
    c.levels.forEach((lv, k) => {
      Ncum += lv.R;
      Hcum += lv.h;
      if (!(lv.h > 0)) return;
      const Nk = Ncum + colKN(t.size) * Hcum;
      const above = k > 0 ? c.levels[k - 1].h : 0;
      for (const [dir, hh, bb] of [['x', t.size[0], t.size[1]], ['y', t.size[1], t.size[0]]]) {
        const Ic = (bb * hh ** 3) / 12;
        const Kc = Ic / (lv.h * 1000), Ka = above > 0 ? Ic / (above * 1000) : 0;
        // the stub under the ground beams: their moments go to the footing (its pad is checked for the load); ea only
        const M = lv.dM?.[dir] && lv.slab !== FOUND ? (lv.dM[dir] * Kc) / (Kc + Ka + (lv.Kb?.[dir] ?? 0)) : 0;
        const e = eccentricColumn({ N: Nk, M, b: bb, h: hh, l0: 700 * lv.h, AsFace, a: aBar, mat });
        if (!ecc || e.util > ecc.util) ecc = { ...e, N: Nk, M, dir, slab: lv.slab };
      }
    });
    return { N, l0, lambda, phi, As, cap, ecc, ok: N <= cap && (!ecc || ecc.ok), size: t.size, bars: t.bars };
  };
  const designed = stacks.filter((c) => c.levels.length).map((c) => {
    const first = check(c, tries[0]);
    let use = first;
    for (let k = 1; !use.ok && k < tries.length; k++) use = check(c, tries[k]);
    return { c, first, use };
  });
  const keyOf = (s) => `${s[0]}x${s[1]}`;
  const sizeKeys = [...new Set(designed.map((q) => keyOf(q.use.size)))].sort((a, b) => {
    const [a0, a1] = a.split('x').map(Number), [b0, b1] = b.split('x').map(Number);
    return a0 * a1 - b0 * b1 || a0 - b0;
  });
  assumed.push({ item: 'column', value: `${keyOf(base)}, ${tries[0].bars.n}Ø${tries[0].bars.d}, φ by l0/h (l0 = 0.7 H)`, note: 'axial load at the base, and eccentric compression storey by storey: the moment the beams at a column cannot balance (fixed-end moments, live load on one side) shared with the columns by stiffness, random eccentricity max(l0/600, h/30, 10 mm), η by Ncr; no sway (wind, earthquake) moments; a size that fails goes up to the next one' });
  // ---- pad footings: side from the bearing pressure, thickness from punching, mesh from bending
  const fB = num(footing.B ?? 1200, 'footing.B', { positive: true }), fL = num(footing.L ?? footing.B ?? 1200, 'footing.L', { positive: true });
  const minSide = Math.max(fB, fL);
  if (footing.B === undefined) assumed.push({ item: 'footing', value: `${fB}x${fL}x${fH} at least`, note: 'square pads sized for the column load and the bearing pressure' });
  assumed.push({ item: 'soil', value: `R = ${soil} kPa`, note: 'assumed bearing pressure at the footing bottom: give the value of the site investigation' });
  const pNet = soil - 20 * (depth / 1000);
  if (pNet <= 0) warnings.push(`soil pressure ${soil} kPa is used up by the footing and the fill over it at ${depth} mm deep: the pads cannot be sized`);
  const footed = designed.filter((q) => !q.c.on);
  // as few footing types as a small house wants: the side rounded up to 100, coarser while more than four sizes come out
  let pads = [];
  for (const step of [100, 200, 300, 500]) {
    pads = footed.map((q) => padFooting(q.use.N, q.use.size, mat, { pNet, minSide, H0: fH, step }));
    if (new Set(pads.map((x) => x.side)).size <= 4) break;
  }
  const sides = [...new Set(pads.map((x) => x.side))].sort((a, b) => a - b);
  const padTypes = sides.map((side, k) => {
    const list = pads.filter((x) => x.side === side);
    const H = Math.max(...list.map((x) => x.H));
    const mesh = list.map((x) => x.mesh).sort((a, b) => area(b.d) / b.spacing - area(a.d) / a.spacing)[0];
    return { mark: `${en ? 'F' : 'M'}${k + 1}`, B: side, L: side, H, mesh, count: list.length, ok: list.every((x) => x.punch && x.meshOk) && Number.isFinite(side) };
  });
  const columns = designed.sort((a, b) => b.use.N - a.use.N).map(({ c, first, use }) => {
    const k = footed.findIndex((q) => q.c === c), pad = k >= 0 ? pads[k] : null, type = pad ? padTypes[sides.indexOf(pad.side)] : null;
    return {
      name: c.name, N: r1(use.N), size: use.size, bars: use.bars, As: Math.round(use.As), mark: `C${sizeKeys.indexOf(keyOf(use.size)) + 1}`,
      lambda: r1(use.lambda), phi: Math.round(use.phi * 1000) / 1000, cap: r1(use.cap), colOk: use.ok,
      ecc: use.ecc ? { slab: use.ecc.slab, dir: use.ecc.dir, N: r1(use.ecc.N), M: r1(use.ecc.M), e0: r1(use.ecc.e0), eta: Number.isFinite(use.ecc.eta) ? r2(use.ecc.eta) : null, util: Number.isFinite(use.ecc.util) ? r2(use.ecc.util) : null, ok: use.ecc.ok } : null,
      // the preliminary size, when it had to go up
      first: keyOf(first.size) === keyOf(use.size) ? null : { size: first.size, N: r1(first.N), cap: r1(first.cap), ecc: first.ecc ? { slab: first.ecc.slab, N: r1(first.ecc.N), M: r1(first.ecc.M) } : null },
      on: c.on, Areq: pad ? r2(pad.Areq) : 0, A: pad ? r2(pad.A) : 0, footOk: !pad || (type.ok && pad.Areq <= pad.A + 1e-9), side: pad ? pad.side : 0,
      foot: type ? { mark: type.mark, B: type.B, L: type.L, H: type.H, mesh: type.mesh } : null,
      at: c.p, top: c.top, bottom: c.bottom, storeys: c.levels.filter((x) => x.slab !== FOUND).length, R: c.R, H: c.H, hs: c.hs, levels: c.levels,
    };
  });
  for (const c of columns) {
    if (c.first) warnings.push(c.first.N > c.first.cap
      ? `column ${c.name}: N = ${c.first.N} kN is over the ${r1(c.first.cap)} kN of ${keyOf(c.first.size)}: designed ${keyOf(c.size)} with ${c.bars.n}Ø${c.bars.d} (${c.cap} kN)`
      : `column ${c.name}: ${keyOf(c.first.size)} fails in eccentric compression (N = ${c.first.ecc?.N} kN with M = ${c.first.ecc?.M} kNm under ${c.first.ecc?.slab}): designed ${keyOf(c.size)} with ${c.bars.n}Ø${c.bars.d}`);
    if (c.colOk === false && c.ecc && !c.ecc.ok && c.N <= c.cap) warnings.push(`column ${c.name}: ${keyOf(c.size)} fails in eccentric compression under ${c.ecc.slab} (N = ${c.ecc.N} kN, M = ${c.ecc.M} kNm): the engineer designs it`);
    if (!c.colOk) warnings.push(`column ${c.name}: N = ${c.N} kN over the capacity ${c.cap} kN of the largest size tried (${keyOf(c.size)}): the engineer designs it`);
    if (c.lambda > 20) warnings.push(`column ${c.name}: l0/h = ${c.lambda} is over 20: slender, the engineer designs it`);
    if (!c.footOk) warnings.push(`footing under ${c.name}: ${c.foot ? `${c.foot.B}x${c.foot.L}x${c.foot.H}` : ''} does not pass (bearing, punching or bending): the engineer designs it`);
  }
  // pads that overlap or take over half of the plan: strip footings or a raft; pads on the outline: eccentric
  const padAt = columns.filter((c) => c.foot);
  const footprint = ((X1 - X0 + 200) * (Y1 - Y0 + 200)) / 1e6, total = sum(padAt.map((c) => (c.foot.B * c.foot.L) / 1e6));
  const overlap = padAt.some((a, i) => padAt.some((b, j) => j > i && Math.abs(a.at[0] - b.at[0]) < (a.foot.B + b.foot.B) / 2 - 1 && Math.abs(a.at[1] - b.at[1]) < (a.foot.L + b.foot.L) / 2 - 1));
  const edge = padAt.filter((c) => Math.abs(c.at[0] - X0) < 1 || Math.abs(c.at[0] - X1) < 1 || Math.abs(c.at[1] - Y0) < 1 || Math.abs(c.at[1] - Y1) < 1).length;
  const ratio = footprint > 0 ? total / footprint : 0;
  const foundation = { pNet, total: r2(total), footprint: r2(footprint), ratio: r2(ratio), overlap, strip: overlap || ratio > 0.5, edge, notes: [] };
  if (foundation.strip) {
    foundation.notes.push(en
      ? `Pad footings for R = ${soil} kPa take ${r1(total)} m² (${Math.round(ratio * 100)} % of the plan)${overlap ? ' and overlap' : ''}: use strip footings or a raft; the engineer designs the foundation.`
      : `Móng đơn với R = ${soil} kPa cần ${r1(total).toFixed(1).replace('.', ',')} m² (${Math.round(ratio * 100)} % diện tích nhà)${overlap ? ', các móng chồng lên nhau' : ''}: dùng móng băng hoặc móng bè; kỹ sư kết cấu thiết kế móng.`);
    warnings.push(`foundation: the pads for R = ${soil} kPa take ${r1(total)} m² (${Math.round(ratio * 100)} % of the plan)${overlap ? ' and overlap' : ''}: use strip footings or a raft (the engineer designs them)`);
  }
  if (edge) {
    foundation.notes.push(en
      ? `${edge} pads stand on the outline of the plan and are sized as centred pads: on a site boundary they are eccentric (strap beams) or strip footings; the engineer designs them.`
      : `${edge} móng nằm trên biên nhà, tính như móng đúng tâm: sát ranh đất phải làm móng lệch tâm (có giằng) hoặc móng băng; kỹ sư kết cấu thiết kế.`);
    warnings.push(`foundation: ${edge} pads on the outline of the plan are sized as centred pads: on a site boundary they are eccentric (the engineer designs them)`);
  }
  // ---- slabs, stairs, balconies
  for (const S of slabs) {
    S.design = S.kind === 'foundation' ? null : designSlab(S, mat);
    if (S.design && !S.design.ok) warnings.push(`slab ${S.name} (${S.slab}): the bars needed do not fit one layer: make the slab thicker`);
    S.balconyDesign = (S.loads.balconies || []).map((b) => {
      const need = stripNeed(b.M, S.slab, 20, mat), top = stripBars(need.T, mat, 10);
      if (!need.ok || !top.ok) warnings.push(`balcony of ${S.name}: the cantilever of ${b.d} m needs a thicker slab or a beam under it`);
      return { ...b, top, dist: { d: 8, s: 200 }, ok: need.ok && top.ok };
    });
    if (S.balconyDesign.length) {
      const b = S.balconyDesign.reduce((m, x) => (x.M > m.M ? x : m));
      warnings.push(`balcony of ${S.name}: cantilever ${b.d} m, ${r1(b.M)} kNm/m at beam ${b.host}: its top bars run into the floor slab behind by the cantilever length at least; a beam that is not held by that slab must be designed for this torsion`);
    }
  }
  const stairs = [];
  F.forEach((f, k) => {
    for (const st of (f.spec.stairs || []).filter((x) => x.type === 'u')) {
      let g;
      try { g = uStairGeom(st, f.height); } catch { continue; }
      const waist = num(st.waist ?? 120, 'stair.waist', { positive: true });
      // the flight and its landing as one simply supported strip, loads on plan
      const L = (g.run + g.landing) / 1000, q = layerLoads('stair', waist, lang).g + LIVE[0].p * gammaLive(LIVE[0].p), M = (q * L * L) / 8;
      const need = stripNeed(M, waist, 20, mat), main = stripBars(need.T, mat, 10), dist = stripBars(0.2 * need.T, mat);
      if (!need.ok || !main.ok) warnings.push(`stair of ${f.name}: a waist of ${waist} over ${r2(L)} m is too thin: make it thicker or add a landing beam`);
      stairs.push({ floor: f.name, index: k, L: r2(L), q: r2(q), M, waist, main, dist, ok: need.ok && main.ok });
    }
  });
  assumed.push({ item: 'slabs', value: 'two-way panels by Marcus (load shared by equal deflection, span moments reduced for twisting), one-way panels qL²/8, /11, /16 in the span and qL²/8, /12 over the supports; one set of bars per slab for its worst panel' });
  if (stairs.length) assumed.push({ item: 'stairs', value: 'flight and landing as one simply supported strip, waist 120, 6 kPa dead and 3 kPa live on plan' });
  if (slabs.some((S) => S.balconyDesign.length)) assumed.push({ item: 'balconies', value: `cantilever slab: ${BALCONY.p} kPa or ${BALCONY.strip} kPa on ${BALCONY.width} m along the railing, railing ${BALCONY.rail} kN/m`, note: 'a brick parapet is heavier: tell the engineer' });
  return {
    slabs, columns, mat, names: { concrete, steel, stirrupSteel }, soil, depth, ground, floors: F, footing: { B: fB, L: fL, H: fH }, footings: padTypes, foundation, stairs,
    column: { size: base, As: tries[0].bars.n * area(tries[0].bars.d), bars: tries[0].bars }, cover, assumed, warnings,
    // what the plans and the details take from the calculation: draw_structure_plan column {sizes}, footing {sizes}
    design: {
      columns: columns.map((c) => ({ at: c.at, size: c.size, mark: c.mark, bars: c.bars })),
      footings: columns.filter((c) => c.foot).map((c) => ({ at: c.at, ...c.foot })),
    },
  };
}

// ---------------------------------------------------------------- the sheet and the CSV

const fmt = (v, lang, d = 1) => (typeof v === 'number' ? (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', lang === 'en' ? '.' : ',') : String(v ?? ''));
const bar = (b) => (b ? `${b.n}Ø${b.d}` : '-');
const strip = (b) => (b ? `Ø${b.d}a${b.s}` : '-');

/** The tables of the calculation: [{title, widths (paper mm), rows, side}] (the first row is the header). */
export function calcTables(R, lang = 'vi') {
  const en = lang === 'en';
  const f = (v, d = 1) => fmt(v, lang, d);
  const t = [];
  const { c, s, sw } = R.mat;
  const xiR = 0.8 / (1 + s.Rs / ES / 0.0035);
  t.push({
    side: 'left', title: en ? 'MATERIALS (TCVN 5574:2018)' : 'VẬT LIỆU (TCVN 5574:2018)', widths: [50, 40, 60],
    rows: [[en ? 'MATERIAL' : 'VẬT LIỆU', en ? 'GRADE' : 'CẤP', en ? 'DESIGN STRENGTH (MPa)' : 'CƯỜNG ĐỘ TÍNH TOÁN (MPa)'],
      [en ? 'Concrete' : 'Bê tông', R.names.concrete, `Rb = ${f(c.Rb, 1)}; Rbt = ${f(c.Rbt, 2)}`],
      [en ? 'Bars Ø ≥ 10' : 'Thép Ø ≥ 10', R.names.steel, `Rs = Rsc = ${s.Rs}; ξR = ${f(xiR, 3)}`],
      [en ? 'Bars Ø < 10, stirrups' : 'Thép Ø < 10, thép đai', R.names.stirrupSteel, `Rs = ${sw.Rs}; Rsw = ${sw.Rsw}`]],
  });
  // slab loads by kind (the build-ups in use)
  const rows = [[en ? 'FLOOR / ROOM' : 'Ô SÀN / PHÒNG', en ? 'DEAD gk' : 'TĨNH TẢI gk', en ? 'DEAD g' : 'TĨNH TẢI g', en ? 'LIVE pk' : 'HOẠT TẢI pk', 'γf', en ? 'LIVE p' : 'HOẠT TẢI p']];
  const seen = new Set();
  for (const S of R.slabs) {
    for (const [, u] of S.loads.used) {
      const k = `${u.live.key}|${f(u.build.g, 2)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push([en ? u.live.en : u.live.vi, f(u.build.gk, 2), f(u.build.g, 2), f(u.live.p, 2), f(gammaLive(u.live.p), 1), f(u.live.p * gammaLive(u.live.p), 2)]);
    }
  }
  t.push({ side: 'left', title: en ? 'SLAB LOADS (kPa, TCVN 2737:2023)' : 'TẢI TRỌNG SÀN (kN/m², TCVN 2737:2023)', widths: [56, 22, 22, 22, 12, 22], rows });
  // slabs, stairs, balconies: the worst panel, its moments and the bars
  const sr = [[en ? 'MEMBER' : 'CẤU KIỆN', en ? 'PANEL, SPAN (m)' : 'Ô, NHỊP (m)', 'q (kN/m²)', en ? 'BOTTOM X: M / BARS' : 'DƯỚI X: M / THÉP', en ? 'BOTTOM Y: M / BARS' : 'DƯỚI Y: M / THÉP', en ? 'TOP: M / BARS' : 'TRÊN GỐI: M / THÉP']];
  for (const S of R.slabs) {
    const D = S.design;
    if (D) {
      sr.push([`${en ? 'Slab' : 'Sàn'} ${S.name} (${S.slab})`, `${f(Math.min(D.worst.wx, D.worst.wy), 2)} x ${f(Math.max(D.worst.wx, D.worst.wy), 2)}`, f(D.worst.q, 2),
        `${f(D.M.x, 1)} / ${strip(D.x)}`, `${f(D.M.y, 1)} / ${strip(D.y)}`, D.M.top > 0 ? `${f(D.M.top, 1)} / ${strip(D.top)}` : strip(D.top)]);
    }
    for (const b of S.balconyDesign ?? []) {
      sr.push([`${en ? 'Balcony' : 'Ban công'} ${S.name} (${S.slab})`, `${en ? 'cantilever' : 'vươn'} ${f(b.d, 2)}`, f(b.g, 2), '-', `${strip(b.dist)} ${en ? '(distribution)' : '(phân bố)'}`, `${f(b.M, 1)} / ${strip(b.top)}`]);
    }
  }
  for (const st of R.stairs ?? []) {
    sr.push([`${en ? 'Stair' : 'Thang'} ${st.floor} (${st.waist})`, `L = ${f(st.L, 2)}`, f(st.q, 2), `${f(st.M, 1)} / ${strip(st.main)}`, `${strip(st.dist)} ${en ? '(distribution)' : '(phân bố)'}`, '-']);
  }
  if (sr.length > 1) t.push({ side: 'left', title: en ? 'SLABS, STAIRS, BALCONIES: MOMENTS (kNm/m) AND BARS' : 'SÀN, CẦU THANG, BAN CÔNG: MÔ MEN (kNm/m) VÀ CỐT THÉP', widths: [38, 24, 16, 29, 29, 29], rows: sr });
  // the build-up of a typical floor
  const lay = layerLoads('floor', R.slabs.find((S) => S.kind === 'floor')?.slab ?? 120, lang);
  t.push({
    side: 'right', order: 2, title: en ? 'TYPICAL FLOOR BUILD-UP (kPa)' : 'CẤU TẠO SÀN ĐIỂN HÌNH (kN/m²)', widths: [70, 22, 14, 22],
    rows: [[en ? 'LAYER' : 'LỚP', 'gk', 'γf', 'g'], ...lay.rows.map((x) => [x.name, f(x.gk, 2), f(x.gf, 2), f(x.gk * x.gf, 2)]), [en ? 'Total' : 'Tổng', f(lay.gk, 2), '', f(lay.g, 2)]],
  });
  // beams
  const br = [[en ? 'BEAM' : 'DẦM', 'b x h', en ? 'SPANS (m)' : 'NHỊP (m)', 'q (kN/m)', 'M+ (kNm)', 'As+', en ? 'BOTTOM' : 'THÉP DƯỚI', 'M- (kNm)', 'As-', en ? 'TOP' : 'THÉP TRÊN', 'Q (kN)', en ? 'STIRRUPS' : 'ĐAI', en ? 'RESULT' : 'KẾT LUẬN']];
  for (const S of R.slabs) {
    for (const ty of S.types) {
      br.push([`${ty.name} (SL ${ty.count})`, `${ty.b}x${ty.h}`, ty.spans.map((x) => f(x, 2)).join('+'), `${f(ty.q, 1)}${ty.point ? ' +P' : ''}`, f(ty.Mspan, 1), Math.round(ty.flexSpan.As), bar(ty.barsSpan),
        f(Math.abs(ty.Msup), 1), Math.round(ty.flexSup.As), bar(ty.barsSup), f(ty.Q, 1), `Ø${ty.stirrup.d}a${ty.stirrup.support}/a${ty.stirrup.span}`,
        ty.ok ? (en ? 'OK' : 'ĐẠT') : (en ? 'ENLARGE' : 'TĂNG TIẾT DIỆN')]);
    }
  }
  t.push({ side: 'right', order: 0, title: en ? 'BEAMS: FORCES AND REINFORCEMENT' : 'DẦM: NỘI LỰC VÀ CỐT THÉP', widths: [26, 18, 46, 18, 18, 12, 20, 18, 12, 20, 16, 26, 24], rows: br });
  // columns and footings as designed
  const cr = [[en ? 'COLUMN' : 'CỘT', 'N (kN)', en ? 'SECTION' : 'TIẾT DIỆN', en ? 'BARS' : 'THÉP DỌC', 'l0/h', 'φ', en ? 'CAPACITY (kN)' : 'KHẢ NĂNG (kN)', en ? 'M (kNm); N e / [M]' : 'M (kNm); N e / [M]', en ? 'COLUMN' : 'KẾT LUẬN CỘT',
    en ? 'A REQ. (m²)' : 'A CẦN (m²)', en ? 'FOOTING' : 'MÓNG CHỌN', en ? 'H, MESH' : 'H, LƯỚI THÉP', en ? 'FOOTING' : 'KẾT LUẬN MÓNG']];
  for (const col of R.columns) {
    const on = col.on ? (en ? `on the ${col.on} beams` : `trên dầm sàn ${col.on}`) : null;
    const okc = col.colOk ? (col.first ? (en ? `OK (was ${col.first.size.join('x')})` : `ĐẠT (tăng từ ${col.first.size.join('x')})`) : (en ? 'OK' : 'ĐẠT')) : (en ? 'NO' : 'KHÔNG ĐẠT');
    cr.push([`${col.name} (${col.mark})`, f(col.N, 1), col.size.join('x'), bar(col.bars), f(col.lambda, 1), f(col.phi, 2), f(col.cap, 1), col.ecc ? `${f(col.ecc.M, 1)}; ${col.ecc.util === null ? '> 1' : f(col.ecc.util, 2)}` : '-', okc,
      on ? '-' : f(col.Areq, 2), on ? '-' : `${col.foot.mark} ${col.foot.B}x${col.foot.L}`, on ? '-' : `${col.foot.H}, Ø${col.foot.mesh.d}a${col.foot.mesh.spacing}`,
      on ?? (col.footOk ? (en ? 'OK' : 'ĐẠT') : (en ? 'NO' : 'KHÔNG ĐẠT'))]);
  }
  t.push({ side: 'right', order: 1, title: en ? `COLUMNS AND PAD FOOTINGS (R = ${R.soil} kPa assumed)` : `CỘT VÀ MÓNG ĐƠN (giả thiết R = ${R.soil} kPa)`, widths: [30, 16, 18, 16, 11, 11, 22, 26, 34, 18, 30, 30, 38], rows: cr });
  return t;
}

/** The sign-off of the calculation: who calculated, checked and approved it, with their licence numbers. */
function signOff(lang) {
  const en = lang === 'en';
  return {
    title: en ? 'SIGN-OFF' : 'XÁC NHẬN', widths: [34, 46, 46, 30, 26],
    rows: [[en ? 'ROLE' : 'CHỨC DANH', en ? 'NAME' : 'HỌ VÀ TÊN', en ? 'LICENCE No.' : 'CHỨNG CHỈ HÀNH NGHỀ SỐ', en ? 'SIGNATURE' : 'CHỮ KÝ', en ? 'DATE' : 'NGÀY'],
      [en ? 'Calculated' : 'Người tính', '', '', '', ''], [en ? 'Checked' : 'Kiểm tra', '', '', '', ''], [en ? 'Structural lead' : 'Chủ trì kết cấu', '', '', '', '']],
  };
}

/** The notes of the calculation: what was done and how, what the engineer must still do. */
export function calcNotes(R, lang = 'vi') {
  const fnd = R.foundation?.notes ?? [];
  return lang === 'en' ? [
    'Loads: TCVN 2737:2023; design: TCVN 5574:2018 (rectangular sections, single reinforcement, a = 40 mm).',
    'Slab panels share out to their beams: two-way (trapezoid / triangle) when l2/l1 ≤ 2, else one-way. Beam moments from the equivalent uniform loads; shear and the loads handed to the columns from the loads the beams really take.',
    'Walls on the beams and partitions on the slab with their openings deducted; partitions spread over their panel.',
    'Continuous beams, elastic: live load on all, odd and even spans; end supports (framing into columns) qL²/24. A beam resting on a beam is hinged there and its reaction is a point load on the carrying beam (+P).',
    'Stirrups: Q ≤ Qb + Qsw with c = 2h0; s ≤ h0/2 and 300 near the supports.',
    'Columns: axial load N ≤ φ (Rb A + Rsc As), φ by l0/h with l0 = 0.7 H; and eccentric compression in each storey (TCVN 5574:2018 8.1.2.3): M from the fixed-end moments the beams at the column cannot balance (live load on one side), shared by stiffness, e0 ≥ ea = max(l0/600, h/30, 10), η = 1/(1 - N/Ncr), N e ≤ [M]. No sway moments (wind, earthquake). A size that fails goes up to the next one.',
    'Pad footings: A = Ntc / (R - γtb Hm), Ntc = N / 1.15; thickness by punching, mesh by the bending of the cantilever; no settlement check.',
    ...fnd,
    'Slabs: two-way panels by the Marcus method (load shared by equal deflection, span moments reduced for twisting), one-way panels as strips (span qL²/8, /11, /16; supports qL²/8, /12); one set of bars per slab for its worst panel. Stairs: flight and landing as one simply supported strip. Balconies: cantilevers, top bars run into the floor slab by the cantilever length at least.',
    'Not covered: wind, earthquake (TCVN 9386), deflection, cracking, torsion, details: the engineer completes them.',
  ] : [
    'Tải trọng theo TCVN 2737:2023; tính toán theo TCVN 5574:2018 (tiết diện chữ nhật, cốt đơn, a = 40 mm).',
    'Tải sàn truyền vào dầm: bản kê 4 cạnh (hình thang / tam giác) khi l2/l1 ≤ 2, ngược lại bản dầm. Mô men dầm tính với tải phân bố tương đương; lực cắt và tải truyền xuống cột tính với tải thực theo diện truyền tải.',
    'Tường trên dầm và tường ngăn trên sàn đã trừ lỗ cửa; tường ngăn quy về phân bố đều trên ô sàn.',
    'Dầm liên tục, tính đàn hồi: hoạt tải đặt toàn bộ, nhịp lẻ, nhịp chẵn; mô men gối biên (liên kết cột) qL²/24. Dầm gác lên dầm: đầu gác là khớp, phản lực là lực tập trung trên dầm đỡ (+P).',
    'Cốt đai: Q ≤ Qb + Qsw với c = 2h0; s ≤ h0/2 và 300 ở vùng gối.',
    'Cột: nén đúng tâm N ≤ φ (Rb A + Rsc As), φ theo l0/h với l0 = 0,7 H; và nén lệch tâm từng tầng (TCVN 5574:2018 mục 8.1.2.3): M lấy từ mô men ngàm của dầm không cân bằng tại cột (hoạt tải một phía), chia theo độ cứng, e0 ≥ ea = max(l0/600; h/30; 10), η = 1/(1 - N/Ncr), N e ≤ [M]. Chưa xét mô men do tải ngang (gió, động đất). Tiết diện không đạt được tăng lên cỡ kế tiếp.',
    'Móng đơn: A = Ntc / (R - γtb Hm), Ntc = N / 1,15; chiều cao theo chọc thủng, lưới thép theo mô men công xôn; chưa kiểm tra lún.',
    ...fnd,
    'Sàn: ô bản kê 4 cạnh theo phương pháp Marcus (chia tải theo độ võng bằng nhau, giảm mô men nhịp do xoắn), ô bản dầm tính theo dải (nhịp qL²/8, /11, /16; gối qL²/8, /12); mỗi sàn một loại thép theo ô bất lợi nhất. Cầu thang: vế thang và chiếu nghỉ là một dải kê đơn giản. Ban công: công xôn, thép mũ neo vào sàn trong tối thiểu bằng chiều dài vươn.',
    'Chưa xét: tải gió, động đất (TCVN 9386), độ võng, nứt, xoắn dầm, cấu tạo chi tiết: kỹ sư kết cấu bổ sung.',
  ];
}

/** The calculation as a sheet: title, warning, tables in two columns, assumptions and the sign-off. */
export function calcSheet(R, { scale = 50, lang = 'vi', at = [0, 0] } = {}) {
  const sc = scale, en = lang === 'en';
  const out = [];
  const th = 2.2 * sc, rh = 5.5 * sc;
  const tables = calcTables(R, lang);
  const T = (text, p, h, align = 'left') => out.push({ type: 'text', text, at: [r2(p[0]), r2(p[1])], height: r2(h), align, layer: SL.text, style: TEXT_STYLE });
  const x0 = at[0], yTop = at[1];
  T(en ? 'PRELIMINARY STRUCTURAL CALCULATION' : 'BẢNG TÍNH KẾT CẤU SƠ BỘ', [x0, yTop], 6 * sc);
  T(en ? 'Prepared by software for the drawings: a licensed structural engineer must check it, calculate it again and sign it before construction.'
    : 'Bảng tính do phần mềm lập để thể hiện bản vẽ: kỹ sư kết cấu có chứng chỉ hành nghề phải kiểm tra, tính toán lại và ký xác nhận trước khi dùng để thi công.',
  [x0, yTop - 9 * sc], 3 * sc);
  const place = (tb, x, y) => {
    out.push({ type: 'table', at: [r2(x), r2(y)], title: tb.title, rows: tb.rows, height: r2(th), row_height: r2(rh), col_widths: tb.widths.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE });
    // a row whose text runs over its cell is drawn on more lines and the table grows: its height as it will be drawn
    // (taken generously: 0.62 of the text height a letter, 2 mm of margin each side), so what follows does not
    // stand on its last rows
    const lines = (row) => Math.max(1, ...row.map((v, i) => Math.ceil((String(v ?? '').length * 2.2 * 0.62) / ((tb.widths[i] ?? 20) - 4))));
    const body = tb.rows.reduce((h, row) => h + Math.max(rh, (lines(Array.isArray(row) ? row : [row]) * 2.2 * 1.7 + 2) * sc), 0);
    return y - body - rh - 10 * sc;
  };
  // left: materials, loads, slabs, the notes; right: beams, columns and footings, the floor build-up, the sign-off
  let yl = yTop - 18 * sc;
  for (const tb of tables.filter((x) => x.side === 'left')) yl = place(tb, x0, yl);
  T(en ? 'NOTES:' : 'GHI CHÚ:', [x0, yl], 3 * sc);
  out.push({ type: 'mtext', text: calcNotes(R, lang).map((l, i) => `${i + 1}. ${l}`).join('\n'), at: [r2(x0), r2(yl - 5 * sc)], height: r2(th), width: r2(165 * sc), layer: SL.text, style: TEXT_STYLE, line_spacing: 1.1 });
  const xr = x0 + 175 * sc;
  let yr = yTop - 18 * sc;
  for (const tb of tables.filter((x) => x.side === 'right').sort((a, b) => a.order - b.order)) yr = place(tb, xr, yr);
  place(signOff(lang), xr, yr);
  return { entities: out };
}

/** The tables as CSV (Excel): sections separated by an empty line, semicolons, decimal commas in Vietnamese. */
export function calcCsv(R, lang = 'vi', sep = ';') {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n,]/.test(s) && (sep === ',' || s.includes(sep) || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const parts = [];
  const head = lang === 'en' ? 'PRELIMINARY STRUCTURAL CALCULATION - to be checked, recalculated and signed by a licensed structural engineer'
    : 'BẢNG TÍNH KẾT CẤU SƠ BỘ - kỹ sư kết cấu có chứng chỉ hành nghề phải kiểm tra, tính lại và ký xác nhận';
  parts.push(esc(head));
  for (const tb of [...calcTables(R, lang), signOff(lang)]) {
    parts.push('', esc(tb.title), ...tb.rows.map((row) => row.map(esc).join(sep)));
  }
  const notes = calcNotes(R, lang);
  parts.push('', esc(lang === 'en' ? 'NOTES' : 'GHI CHÚ'), ...notes.map((l, i) => esc(`${i + 1}. ${l}`)));
  return '﻿' + parts.join('\r\n') + '\r\n';
}
