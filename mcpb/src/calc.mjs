// Preliminary structural calculation (bảng tính kết cấu sơ bộ) of the frame the structural plans draw: loads by
// TCVN 2737:2023 (slab build-ups, partitions, walls on the beams, live loads by room), the slab panels shared out to
// their beams (two-way: trapezoid and triangle, one-way), continuous beams analysed elastically with the live load on
// all, odd and even spans, sections designed by TCVN 5574:2018 (bending: αm, ξ ≤ ξR; shear: stirrups), column loads
// summed floor by floor down to the footings, the footing area against an assumed bearing pressure. It is preliminary:
// a licensed structural engineer checks it, calculates it again and signs it. Pure computation and draw_entities specs.
import { buildModel, floorsOf } from './elevation.mjs';
import { notesBlock } from './interior.mjs';
import { gridList, num, PlanError } from './plan.mjs';
import { TEXT_STYLE } from './standards.mjs';
import { framingPlan, SL } from './structure.mjs';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const area = (d) => (Math.PI * d * d) / 4;

/** TCVN 5574:2018, design strengths in MPa (Table 10 concrete, Table 13 steel). */
export const CONCRETE = { B15: { Rb: 8.5, Rbt: 0.75 }, B20: { Rb: 11.5, Rbt: 0.9 }, B25: { Rb: 14.5, Rbt: 1.05 }, B30: { Rb: 17, Rbt: 1.15 } };
export const STEEL = {
  'CB240-T': { Rs: 210, Rsc: 210, Rsw: 170 }, 'CB300-V': { Rs: 260, Rsc: 260, Rsw: 210 },
  'CB400-V': { Rs: 350, Rsc: 350, Rsw: 280 }, 'CB500-V': { Rs: 435, Rsc: 400, Rsw: 300 },
};
const ES = 200000;

/** Live loads (kPa, TCVN 2737:2023 for dwellings) by room name; the first match wins. */
const LIVE = [
  { key: 'stair', re: /(CẦU THANG|STAIR)/i, p: 3, vi: 'Cầu thang', en: 'Stairs' },
  { key: 'hall', re: /(SẢNH|HÀNH LANG|HALL|CORRIDOR|LOBBY)/i, p: 3, vi: 'Sảnh, hành lang', en: 'Halls, corridors' },
  { key: 'balcony', re: /(BAN CÔNG|LÔ GIA|LOGIA|SÂN PHƠI|BALCONY|LOGGIA)/i, p: 2, vi: 'Ban công, sân phơi', en: 'Balconies' },
  { key: 'terrace', re: /(SÂN THƯỢNG|TERRACE)/i, p: 1.5, vi: 'Sân thượng (mái có sử dụng)', en: 'Roof terrace (used)' },
  { key: 'wet', re: /(WC|VỆ SINH|TẮM|TOILET|BATH)/i, p: 1.5, vi: 'Phòng vệ sinh', en: 'Toilets' },
  { key: 'store', re: /(KHO|STORE)/i, p: 2, vi: 'Kho nhỏ trong nhà ở', en: 'Small stores' },
  { key: 'room', re: /.*/, p: 1.5, vi: 'Phòng ở, phòng khách, bếp, phòng thờ', en: 'Rooms, living, kitchen' },
];
const ROOF_LIVE = { key: 'roof', p: 0.75, vi: 'Mái BTCT không sử dụng', en: 'RC roof, not used' };
const gammaLive = (p) => (p < 2 ? 1.3 : 1.2);

/** Build-ups (name, thickness m, unit weight kN/m³ or load kPa when thickness is null, γf). SLAB = the RC slab. */
const BUILDUP = {
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

function layerLoads(kind, slab, lang, wet = false) {
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
const wallKPa = (t) => ({ gk: (t / 1000) * 18 + 2 * 0.015 * 18, g: (t / 1000) * 18 * 1.1 + 2 * 0.015 * 18 * 1.3 });

function uniq(vals, tol) {
  const out = [];
  for (const v of [...vals].sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

/** Three-moment equation (tridiagonal): support moments (kNm, hogging negative) for given end moments M0, Mn. */
export function supportMoments(L, q, M0 = 0, Mn = 0) {
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
    d.push(-(q[i - 1] * L[i - 1] ** 3 + q[i] * L[i] ** 3) / 4 - (i === 1 ? M0 * L[0] : 0) - (i === n - 1 ? Mn * L[n - 1] : 0));
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

/** Shears at both ends and the largest sagging moment of a span with end moments Ml, Mr (kN, kNm). */
function spanForces(L, q, Ml, Mr) {
  const Vl = (Mr - Ml) / L + (q * L) / 2, Vr = (Mr - Ml) / L - (q * L) / 2;
  const x0 = q > 0 ? Math.max(0, Math.min(L, Vl / q)) : 0;
  return { Vl, Vr, Mmax: Ml + Vl * x0 - (q * x0 * x0) / 2 };
}

/**
 * A continuous beam: spans L (m), dead g and live p per span (kN/m). Envelope of the live load on all spans, on the
 * odd and on the even spans; the monolithic end supports (beams framing into columns) take q·L²/24 hogging, in
 * equilibrium with the spans. Reactions from the full load.
 */
export function analyseBeam(L, g, p) {
  const n = L.length;
  const patterns = [L.map(() => true), L.map((_, i) => i % 2 === 0), L.map((_, i) => i % 2 === 1)];
  const span = L.map(() => ({ M: 0, V: 0 })), sup = new Array(n + 1).fill(0);
  let reactions = null;
  for (const [k, on] of patterns.entries()) {
    const q = L.map((_, i) => g[i] + (on[i] ? p[i] : 0));
    const M = supportMoments(L, q, -(q[0] * L[0] ** 2) / 24, -(q[n - 1] * L[n - 1] ** 2) / 24);
    const R = new Array(n + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const f = spanForces(L[i], q[i], M[i], M[i + 1]);
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
  const cells = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    for (let j = 0; j + 1 < ys.length; j++) {
      const [x0, x1, y0, y1] = [xs[i], xs[i + 1], ys[j], ys[j + 1]];
      const e = {
        bottom: beamOn(true, y0, x0, x1), top: beamOn(true, y1, x0, x1),
        left: beamOn(false, x0, y0, y1), right: beamOn(false, x1, y0, y1),
      };
      const n = Object.values(e).filter(Boolean).length;
      // fewer than three edges carried, or two adjacent ones: not a slab panel of this frame
      if (n < 2 || (n === 2 && !((e.bottom && e.top) || (e.left && e.right)))) continue;
      cells.push({ x0, x1, y0, y1, e });
    }
  }
  return cells;
}

/** Equivalent uniform loads (kN/m per kPa of the panel) on each carried edge of a panel. */
function shareOut(cell) {
  const wx = (cell.x1 - cell.x0) / 1000, wy = (cell.y1 - cell.y0) / 1000;
  const { bottom, top, left, right } = cell.e;
  const out = [];
  const xPair = bottom && top, yPair = left && right;
  if (xPair && yPair && Math.max(wx, wy) / Math.min(wx, wy) <= 2) {
    // two-way: trapezoid on the long edges, triangle on the short edges
    const lx = Math.min(wx, wy), ly = Math.max(wx, wy), beta = lx / (2 * ly);
    const trap = (lx / 2) * (1 - 2 * beta ** 2 + beta ** 3), tri = (lx / 2) * (5 / 8);
    const horizLong = wx >= wy;
    for (const [k, m] of [['bottom', bottom], ['top', top]]) out.push({ edge: k, m, k: horizLong ? trap : tri });
    for (const [k, m] of [['left', left], ['right', right]]) out.push({ edge: k, m, k: horizLong ? tri : trap });
  } else if (xPair && (!yPair || wy <= wx)) {
    // one-way between the bottom and top beams (across wy)
    for (const [k, m] of [['bottom', bottom], ['top', top]]) out.push({ edge: k, m, k: wy / 2 });
  } else {
    for (const [k, m] of [['left', left], ['right', right]]) out.push({ edge: k, m, k: wx / 2 });
  }
  return out;
}

/** The range [u0, u1] (mm along the member) of an edge or a wall on it. */
const along = (m, p, q) => {
  const a = dot(sub(p, m.A), m.d), b = dot(sub(q, m.A), m.d);
  return [Math.max(0, Math.min(a, b)), Math.min(m.L, Math.max(a, b))];
};

/** Adds a line load over [u0, u1] of member m to its spans, spread uniformly over each span it covers. */
function addLine(m, u0, u1, kind, q) {
  if (u1 - u0 < 1) return;
  for (let i = 0; i + 1 < m.supports.length; i++) {
    const s0 = m.supports[i], s1 = m.supports[i + 1], L = s1 - s0;
    const ov = Math.min(u1, s1) - Math.max(u0, s0);
    if (ov > 1 && L > 1) m.load[i][kind] += (q * ov) / L;
  }
}

/** Wall axis of a wall segment (its offsets from the drawn line). */
function wallAxis(s) {
  const n = [-s.d[1], s.d[0]], c = (s.o1 + s.o2) / 2;
  return { A: [s.a[0] + n[0] * c, s.a[1] + n[1] * c], B: [s.b[0] + n[0] * c, s.b[1] + n[1] * c] };
}

/**
 * Loads on one slab's beams: panels (build-up and live load of the room over each, partitions standing on it) and the
 * walls standing on the beams; self-weight of the beams. above: the floor whose walls stand on the slab (null: roof).
 */
function slabLoads({ members, above, rooms, stairs, kind, slab, height, lang, roofLive }) {
  for (const m of members) m.load = m.supports.slice(1).map(() => ({ g: 0, p: 0 }));
  // the ground beams carry walls only (the ground floor slab lies on the ground)
  const cells = kind === 'foundation' ? [] : panelEdges(members);
  const used = new Map();
  const roomOf = (c) => {
    for (const [name, poly] of Object.entries(rooms || {})) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > c[1]) !== (yj > c[1]) && c[0] < ((xj - xi) * (c[1] - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return name;
    }
    return null;
  };
  // walls of the floor above: on a beam (line load), else partitions on the panel they stand in
  const M = above ? buildModel(above.spec) : null;
  const wallLoads = [];
  const part = cells.map(() => ({ gk: 0, g: 0 }));
  if (M) {
    for (const w of M.walls) {
      for (const s of w.segs) {
        const ax = wallAxis(s);
        const wh = w.height !== undefined ? w.height : null;
        const host = members.find((m) => Math.abs(cross(m.d, s.d)) < 1e-6 && Math.abs(cross(m.d, sub(ax.A, m.A))) < 30);
        const ops = M.openings.filter((op) => op.s === s);
        const k = wallKPa(s.t);
        if (host) {
          const H = (wh ?? height - host.h) / 1000;
          const [u0, u1] = along(host, ax.A, ax.B);
          if (u1 - u0 < 1) continue;
          // the openings in it take their area off
          for (let i = 0; i + 1 < host.supports.length; i++) {
            const s0 = Math.max(u0, host.supports[i]), s1 = Math.min(u1, host.supports[i + 1]);
            if (s1 - s0 < 1) continue;
            let A = ((s1 - s0) / 1000) * H;
            for (const op of ops) {
              const [a, b] = along(host, [s.a[0] + s.d[0] * op.span.from, s.a[1] + s.d[1] * op.span.from], [s.a[0] + s.d[0] * op.span.to, s.a[1] + s.d[1] * op.span.to]);
              const ov = Math.min(b, s1) - Math.max(a, s0);
              if (ov > 1) A -= (ov / 1000) * Math.max(0, Math.min(op.head, H * 1000) - op.sill) / 1000;
            }
            const L = (host.supports[i + 1] - host.supports[i]) / 1000;
            host.load[i].g += (Math.max(0, A) * k.g) / L;
            wallLoads.push({ t: s.t, H: r2(H), member: host.name, q: r2((Math.max(0, A) * k.g) / L) });
          }
        } else {
          // a partition on the slab: its weight over the panel it stands in
          const H = (wh ?? height - slab) / 1000;
          const horiz = Math.abs(s.d[0]) > 0.5;
          cells.forEach((c, ci) => {
            // the length of the wall inside the panel (walls along the plan axes)
            const [lo, hi] = horiz ? [c.x0, c.x1] : [c.y0, c.y1];
            const [p0, p1] = horiz ? [ax.A[0], ax.B[0]] : [ax.A[1], ax.B[1]];
            const across = horiz ? ax.A[1] : ax.A[0];
            const inBand = horiz ? across > c.y0 && across < c.y1 : across > c.x0 && across < c.x1;
            const len = inBand ? Math.min(hi, Math.max(p0, p1)) - Math.max(lo, Math.min(p0, p1)) : 0;
            if (len <= 1) return;
            const Ac = ((c.x1 - c.x0) * (c.y1 - c.y0)) / 1e6;
            part[ci].gk += ((len / 1000) * H * k.gk) / Ac;
            part[ci].g += ((len / 1000) * H * k.g) / Ac;
          });
        }
      }
    }
  }
  // panels: build-up by room kind, live load by room
  cells.forEach((c, ci) => {
    const ctr = [(c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2];
    const inStair = (stairs || []).some((b) => ctr[0] > b[0] && ctr[0] < b[2] && ctr[1] > b[1] && ctr[1] < b[3]);
    const name = roomOf(ctr) ?? '';
    let live, build;
    if (inStair) {
      live = LIVE[0];
      build = layerLoads('stair', slab, lang);
    } else if (kind === 'roof') {
      live = roofLive;
      build = layerLoads('roof', slab, lang);
    } else {
      live = LIVE.find((x) => x.re.test(name)) ?? LIVE[LIVE.length - 1];
      build = layerLoads(live.key === 'terrace' ? 'terrace' : 'floor', slab, lang, live.key === 'wet');
    }
    const g = build.g + part[ci].g, p = live.p * gammaLive(live.p);
    const key = `${inStair ? 'stair' : kind === 'roof' ? 'roof' : live.key}${live.key === 'wet' ? '-wet' : ''}`;
    if (!used.has(key)) used.set(key, { live, build });
    c.room = name;
    c.g = g;
    c.p = p;
    for (const e of shareOut(c)) {
      const [p0, p1] = e.edge === 'bottom' ? [[c.x0, c.y0], [c.x1, c.y0]] : e.edge === 'top' ? [[c.x0, c.y1], [c.x1, c.y1]]
        : e.edge === 'left' ? [[c.x0, c.y0], [c.x0, c.y1]] : [[c.x1, c.y0], [c.x1, c.y1]];
      const [u0, u1] = along(e.m, p0, p1);
      addLine(e.m, u0, u1, 'g', g * e.k);
      addLine(e.m, u0, u1, 'p', p * e.k);
    }
  });
  // self-weight of the beams below the slab, plaster on their sides
  for (const m of members) {
    const web = Math.max(0, m.h - slab) / 1000;
    const sw = (m.b / 1000) * web * 25 * 1.1 + 2 * web * 0.015 * 18 * 1.3;
    for (const ld of m.load) ld.g += sw;
  }
  return { cells, used, wallLoads };
}

/**
 * The calculation of the whole frame of the building spec: the ground beams, every slab (floors 2.. and the roof),
 * taken from the top down so that a column standing on a slab (a stair tower's) hands its load to the beam under it;
 * then the columns and the footings. rooms: {floorIndex: {name: poly}} (live loads by room).
 */
export function structuralCalc({ spec, rooms = {}, concrete = 'B20', steel = 'CB300-V', stirrupSteel = 'CB240-T', cover = 25, soil = 100, footing = {}, column = {}, lang = 'vi' }) {
  const mat = { c: CONCRETE[concrete], s: STEEL[steel], sw: STEEL[stirrupSteel] };
  if (!mat.c) throw new PlanError(`concrete must be one of ${Object.keys(CONCRETE).join(', ')}`);
  if (!mat.s || !mat.sw) throw new PlanError(`steel must be one of ${Object.keys(STEEL).join(', ')}`);
  const assumed = [], warnings = [];
  const F = floorsOf(spec);
  if (F.length < 2) throw new PlanError('the calculation needs a building of several floors (floors [...])');
  const ground = spec.heights?.ground ?? -450;
  const depth = num(spec.heights?.foundation?.depth ?? 1500, 'heights.foundation.depth', { positive: true });
  const fH = num(footing.H ?? 400, 'footing.H', { positive: true });
  const stairBoxes = (f) => (f.spec.stairs_below || []).filter((st) => st.region).map((st) => {
    const xs = st.region.map((q) => q[0]), ys = st.region.map((q) => q[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  });
  const FOUND = lang === 'en' ? 'FOUNDATION' : 'MÓNG', ROOF = lang === 'en' ? 'ROOF' : 'MÁI';
  // the levels from the bottom: ground beams (the ground floor walls on them), slabs of floors 2..n, the roof
  const slabs = [];
  {
    const f0 = F[0];
    const fp = framingPlan({ spec: f0.spec, level: ground, slab: 120, name: FOUND, prefix: 'GM.', beam: { h: 400 }, column, foundation: { depth } });
    slabs.push({ name: FOUND, level: ground, slab: 0, fp, above: f0, kind: 'foundation', rooms: {}, stairs: [], height: f0.height + Math.abs(ground) });
  }
  for (let k = 1; k < F.length; k++) {
    const f = F[k], below = F[k - 1];
    const m = /(\d+)\s*$/.exec(String(f.name));
    const prefix = /TUM/i.test(String(f.name)) ? 'DT.' : `D${m ? m[1] : k + 1}.`;
    const fp = framingPlan({ spec: below.spec, level: f.level, slab: f.slab, name: f.name, prefix, column });
    slabs.push({ name: f.name, level: f.level, slab: f.slab, fp, above: f, kind: 'floor', rooms: rooms[k] ?? {}, stairs: stairBoxes(f), height: f.height });
  }
  {
    const t = F[F.length - 1];
    const fp = framingPlan({ spec: t.spec, level: t.level + t.height + 120, slab: 120, name: ROOF, prefix: 'DM.', column });
    slabs.push({ name: ROOF, level: t.level + t.height + 120, slab: 120, fp, above: null, kind: 'roof', rooms: {}, stairs: [], height: 0 });
  }
  assumed.push({ item: 'materials', value: `${concrete} (Rb ${mat.c.Rb}, Rbt ${mat.c.Rbt} MPa), ${steel} (Rs ${mat.s.Rs}), ${stirrupSteel} (Rsw ${mat.sw.Rsw})` });
  assumed.push({ item: 'live loads', value: LIVE.map((x) => `${x.vi} ${x.p}`).join('; ') + `; ${ROOF_LIVE.vi} ${ROOF_LIVE.p} kPa`, note: 'TCVN 2737:2023, γf 1.3 (< 2 kPa) / 1.2' });
  assumed.push({ item: 'walls', value: 'brick 18 kN/m³ γf 1.1, plaster 2 x 15 mm γf 1.3, openings deducted' });
  assumed.push({ item: 'analysis', value: 'continuous beams, live load on all / odd / even spans; end supports qL²/24; rectangular sections; a = 40 mm' });
  const csize = column.size ?? [220, 220];
  const colW = (csize[0] / 1000) * (csize[1] / 1000) * 25 * 1.1;
  const gx = gridList(spec.grids?.x, 'x'), gy = gridList(spec.grids?.y, 'y');
  const label = (p) => {
    const x = gx.find((g) => Math.abs(g.at - p[0]) < 300), y = gy.find((g) => Math.abs(g.at - p[1]) < 300);
    return x && y ? `${x.label}-${y.label}` : `(${Math.round(p[0])}, ${Math.round(p[1])})`;
  };
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 150;
  const stacks = [];
  const stackAt = (p) => {
    let c = stacks.find((q) => near(q.p, p));
    if (!c) stacks.push((c = { p, name: label(p), N: 0, levels: [], bottom: null, top: null, on: null }));
    return c;
  };
  // from the top down: loads, analysis, reactions into the columns; a column with none under it rests on a beam
  const transfers = slabs.map(() => []);
  for (let i = slabs.length - 1; i >= 0; i--) {
    const S = slabs[i];
    const members = S.fp.members.map((m) => ({ ...m }));
    S.loads = slabLoads({ members, above: S.above, rooms: S.rooms, stairs: S.stairs, kind: S.kind, slab: S.slab, height: S.height, lang, roofLive: ROOF_LIVE });
    S.members = members;
    for (const t of transfers[i]) {
      // a point load P at u of a span: the uniform load of the same largest moment (8 P a b / L³)
      const m = members[t.k];
      const j = m.supports.findIndex((u, q) => q + 1 < m.supports.length && t.u >= u && t.u <= m.supports[q + 1]);
      if (j < 0) continue;
      const L = (m.supports[j + 1] - m.supports[j]) / 1000, a = (t.u - m.supports[j]) / 1000, b = L - a;
      m.load[j].g += (8 * t.P * a * b) / L ** 3;
      m.point = (m.point ?? 0) + t.P;
    }
    for (const m of members) {
      const L = m.supports.slice(1).map((u, j) => (u - m.supports[j]) / 1000);
      m.span = L;
      m.res = analyseBeam(L, m.load.map((x) => x.g), m.load.map((x) => x.p));
    }
    // reactions at this slab's columns (the storey under it), plus the storey's own weight
    const storey = i > 0 ? (S.level - slabs[i - 1].level) / 1000 : (depth - fH + ground) / 1000;
    for (const p of S.fp.columnPoints) {
      const c = stackAt(p);
      if (c.on) continue;
      let R = 0;
      for (const m of members) {
        m.supports.forEach((u, j) => {
          if (near([m.A[0] + m.d[0] * u, m.A[1] + m.d[1] * u], c.p)) R += Math.max(0, m.res.reactions[j]);
        });
      }
      c.N += R + colW * storey;
      c.levels.push({ slab: S.name, R });
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
        transfers[i - 1].push({ k, u: dot(sub(c.p, host.A), host.d), P: c.N });
      }
    }
  }
  // design of each beam type (the worst of its members)
  for (const S of slabs) {
    const types = new Map();
    for (const m of S.members) {
      const t = types.get(m.name) ?? { name: m.name, b: m.b, h: m.h, count: 0, spans: m.span, Mspan: 0, Msup: 0, Q: 0, q: 0 };
      t.count++;
      t.Mspan = Math.max(t.Mspan, ...m.res.span.map((x) => x.M));
      t.Msup = Math.min(t.Msup, ...m.res.sup);
      t.Q = Math.max(t.Q, ...m.res.span.map((x) => x.V));
      t.q = Math.max(t.q, ...m.load.map((x) => x.g + x.p));
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
  const As = column.bars ? column.bars.n * area(column.bars.d) : 4 * area(16);
  const Ac = csize[0] * csize[1];
  const cap = (0.9 * (mat.c.Rb * Ac + mat.s.Rsc * As)) / 1000;
  if (!column.bars) assumed.push({ item: 'column', value: `${csize[0]}x${csize[1]}, 4Ø16, φ = 0,9`, note: 'axial load only (short column); the frame moments are not taken' });
  const fB = num(footing.B ?? 1200, 'footing.B', { positive: true }), fL = num(footing.L ?? footing.B ?? 1200, 'footing.L', { positive: true });
  if (footing.B === undefined) assumed.push({ item: 'footing', value: `${fB}x${fL}x${fH}` });
  assumed.push({ item: 'soil', value: `R = ${soil} kPa`, note: 'assumed bearing pressure at the footing bottom: give the value of the site investigation' });
  const pNet = soil - 20 * (depth / 1000);
  const columns = stacks.filter((c) => c.levels.length).sort((a, b) => b.N - a.N).map((c) => {
    const onFooting = !c.on;
    const Ntc = c.N / 1.15, Areq = onFooting && pNet > 0 ? Ntc / pNet : 0;
    return {
      name: c.name, N: r1(c.N), cap: r1(cap), colOk: c.N <= cap, on: c.on, Areq: r2(Areq), A: onFooting ? r2((fB * fL) / 1e6) : 0,
      footOk: !onFooting || Areq <= (fB * fL) / 1e6, side: Math.ceil((Math.sqrt(Areq) * 1000) / 100) * 100,
      at: c.p, top: c.top, bottom: c.bottom, storeys: c.levels.filter((x) => x.slab !== FOUND).length,
    };
  });
  for (const c of columns) {
    if (!c.colOk) warnings.push(`column ${c.name}: N = ${c.N} kN over its capacity ${c.cap} kN`);
    if (!c.footOk) warnings.push(`footing under ${c.name}: needs ${c.Areq} m² (about ${c.side}x${c.side}), the drawn one is ${c.A} m²`);
  }
  return {
    slabs, columns, mat, names: { concrete, steel, stirrupSteel }, soil, depth, ground, floors: F, footing: { B: fB, L: fL, H: fH },
    column: { size: csize, As, bars: column.bars ?? { n: 4, d: 16 } }, cover, assumed, warnings,
  };
}

// ---------------------------------------------------------------- the sheet and the CSV

const fmt = (v, lang, d = 1) => (typeof v === 'number' ? (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', lang === 'en' ? '.' : ',') : String(v ?? ''));
const bar = (b) => (b ? `${b.n}Ø${b.d}` : '-');

/** The tables of the calculation: [{title, widths (paper mm), rows}] (the first row is the header). */
export function calcTables(R, lang = 'vi') {
  const en = lang === 'en';
  const f = (v, d = 1) => fmt(v, lang, d);
  const t = [];
  const { c, s, sw } = R.mat;
  const xiR = 0.8 / (1 + s.Rs / ES / 0.0035);
  t.push({
    title: en ? 'MATERIALS (TCVN 5574:2018)' : 'VẬT LIỆU (TCVN 5574:2018)', widths: [50, 40, 60],
    rows: [[en ? 'MATERIAL' : 'VẬT LIỆU', en ? 'GRADE' : 'CẤP', en ? 'DESIGN STRENGTH (MPa)' : 'CƯỜNG ĐỘ TÍNH TOÁN (MPa)'],
      [en ? 'Concrete' : 'Bê tông', R.names.concrete, `Rb = ${f(c.Rb, 1)}; Rbt = ${f(c.Rbt, 2)}`],
      [en ? 'Main bars' : 'Thép dọc', R.names.steel, `Rs = Rsc = ${s.Rs}; ξR = ${f(xiR, 3)}`],
      [en ? 'Stirrups' : 'Thép đai', R.names.stirrupSteel, `Rsw = ${sw.Rsw}`]],
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
  t.push({ title: en ? 'SLAB LOADS (kPa, TCVN 2737:2023)' : 'TẢI TRỌNG SÀN (kN/m², TCVN 2737:2023)', widths: [56, 22, 22, 22, 12, 22], rows });
  // the build-up of a typical floor
  const lay = layerLoads('floor', R.slabs.find((S) => S.kind === 'floor')?.slab ?? 120, lang);
  t.push({
    title: en ? 'TYPICAL FLOOR BUILD-UP (kPa)' : 'CẤU TẠO SÀN ĐIỂN HÌNH (kN/m²)', widths: [70, 22, 14, 22],
    rows: [[en ? 'LAYER' : 'LỚP', 'gk', 'γf', 'g'], ...lay.rows.map((x) => [x.name, f(x.gk, 2), f(x.gf, 2), f(x.gk * x.gf, 2)]), [en ? 'Total' : 'Tổng', f(lay.gk, 2), '', f(lay.g, 2)]],
  });
  // beams
  const br = [[en ? 'BEAM' : 'DẦM', 'b x h', en ? 'SPANS (m)' : 'NHỊP (m)', 'q (kN/m)', 'M+ (kNm)', 'As+', en ? 'BOTTOM' : 'THÉP DƯỚI', 'M- (kNm)', 'As-', en ? 'TOP' : 'THÉP TRÊN', 'Q (kN)', en ? 'STIRRUPS' : 'ĐAI', en ? 'RESULT' : 'KẾT LUẬN']];
  for (const S of R.slabs) {
    for (const ty of S.types) {
      br.push([`${ty.name} (SL ${ty.count})`, `${ty.b}x${ty.h}`, ty.spans.map((x) => f(x, 2)).join('+'), f(ty.q, 1), f(ty.Mspan, 1), Math.round(ty.flexSpan.As), bar(ty.barsSpan),
        f(Math.abs(ty.Msup), 1), Math.round(ty.flexSup.As), bar(ty.barsSup), f(ty.Q, 1), `Ø${ty.stirrup.d}a${ty.stirrup.support}/a${ty.stirrup.span}`,
        ty.ok ? (en ? 'OK' : 'ĐẠT') : (en ? 'ENLARGE' : 'TĂNG TIẾT DIỆN')]);
    }
  }
  t.push({ title: en ? 'BEAMS: FORCES AND REINFORCEMENT' : 'DẦM: NỘI LỰC VÀ CỐT THÉP', widths: [26, 18, 46, 16, 18, 12, 20, 18, 12, 20, 16, 26, 26], rows: br });
  const cr = [[en ? 'COLUMN' : 'CỘT', 'N (kN)', en ? 'CAPACITY (kN)' : 'KHẢ NĂNG (kN)', en ? 'COLUMN' : 'CỘT', en ? 'FOOTING A REQ. (m²)' : 'MÓNG: A CẦN (m²)', en ? 'A DRAWN (m²)' : 'A ĐÃ VẼ (m²)', en ? 'FOOTING' : 'MÓNG']];
  for (const col of R.columns) {
    const on = col.on ? (en ? `on the ${col.on} beams` : `đặt trên dầm sàn ${col.on}`) : null;
    cr.push([col.name, f(col.N, 1), f(col.cap, 1), col.colOk ? (en ? 'OK' : 'ĐẠT') : (en ? 'NO' : 'KHÔNG ĐẠT'), on ? '-' : f(col.Areq, 2), on ? '-' : f(col.A, 2),
      on ?? (col.footOk ? (en ? 'OK' : 'ĐẠT') : `${en ? 'NO' : 'KHÔNG ĐẠT'} (≥ ${col.side}x${col.side})`)]);
  }
  t.push({ title: en ? `COLUMN LOADS AND FOOTINGS (R = ${R.soil} kPa assumed)` : `TẢI TRỌNG CỘT VÀ MÓNG (giả thiết R = ${R.soil} kPa)`, widths: [28, 18, 26, 22, 30, 24, 62], rows: cr });
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

/** The calculation as a sheet: title, warning, tables in two columns, assumptions and the sign-off. */
export function calcSheet(R, { scale = 50, lang = 'vi', at = [0, 0] } = {}) {
  const sc = scale, en = lang === 'en';
  const out = [];
  const th = 2.2 * sc, rh = 6.5 * sc;
  const tables = calcTables(R, lang);
  const T = (text, p, h, align = 'left') => out.push({ type: 'text', text, at: [r2(p[0]), r2(p[1])], height: r2(h), align, layer: SL.text, style: TEXT_STYLE });
  const x0 = at[0], yTop = at[1];
  T(en ? 'PRELIMINARY STRUCTURAL CALCULATION' : 'BẢNG TÍNH KẾT CẤU SƠ BỘ', [x0, yTop], 6 * sc);
  T(en ? 'Prepared by software for the drawings: a licensed structural engineer must check it, calculate it again and sign it before construction.'
    : 'Bảng tính do phần mềm lập để thể hiện bản vẽ: kỹ sư kết cấu có chứng chỉ hành nghề phải kiểm tra, tính toán lại và ký xác nhận trước khi dùng để thi công.',
  [x0, yTop - 9 * sc], 3 * sc);
  const place = (tb, x, y) => {
    out.push({ type: 'table', at: [r2(x), r2(y)], title: tb.title, rows: tb.rows, height: r2(th), row_height: r2(rh), col_widths: tb.widths.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE });
    return y - (tb.rows.length + 1) * rh - 12 * sc;
  };
  // left: materials, loads, build-up, assumptions; right: beams, columns, sign-off
  let yl = yTop - 18 * sc;
  for (const tb of tables.slice(0, 3)) yl = place(tb, x0, yl);
  const lines = en ? [
    'Loads: TCVN 2737:2023; design: TCVN 5574:2018 (rectangular sections, single reinforcement, a = 40 mm).',
    'Slab panels share out to their beams: two-way (trapezoid / triangle) when l2/l1 ≤ 2, else one-way.',
    'Walls on the beams with their openings deducted; partitions on the slab spread over their panel.',
    'Continuous beams, elastic: live load on all, odd and even spans; end supports (framing into columns) qL²/24.',
    'Stirrups: Q ≤ Qb + Qsw with c = 2h0; s ≤ h0/2 and 300 near the supports.',
    'Columns: axial load only; footings: area for the assumed bearing pressure, no settlement or punching check.',
    'Not covered: wind, earthquake (TCVN 9386), deflection, cracking, slabs, stairs, details: the engineer completes them.',
  ] : [
    'Tải trọng theo TCVN 2737:2023; tính toán theo TCVN 5574:2018 (tiết diện chữ nhật, cốt đơn, a = 40 mm).',
    'Tải sàn truyền vào dầm: bản kê 4 cạnh (hình thang / tam giác) khi l2/l1 ≤ 2, ngược lại bản dầm.',
    'Tường trên dầm đã trừ lỗ cửa; tường ngăn trên sàn quy về phân bố đều trên ô sàn.',
    'Dầm liên tục, tính đàn hồi: hoạt tải đặt toàn bộ, nhịp lẻ, nhịp chẵn; mô men gối biên (liên kết cột) qL²/24.',
    'Cốt đai: Q ≤ Qb + Qsw với c = 2h0; s ≤ h0/2 và 300 ở vùng gối.',
    'Cột: chỉ kiểm tra lực dọc; móng: diện tích theo áp lực đất giả thiết, chưa kiểm tra lún, chọc thủng.',
    'Chưa xét: tải gió, động đất (TCVN 9386), độ võng, nứt, tính sàn, cầu thang, cấu tạo: kỹ sư kết cấu bổ sung.',
  ];
  out.push(...notesBlock(lines, [x0, yl], sc, lang, 160).map((e) => ({ ...e, layer: SL.text })));
  const xr = x0 + 175 * sc;
  let yr = yTop - 18 * sc;
  for (const tb of tables.slice(3)) yr = place(tb, xr, yr);
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
  return '﻿' + parts.join('\r\n') + '\r\n';
}
