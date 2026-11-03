// Bills of quantities of the structural set from the preliminary calculation (calc.mjs): the bar schedule of every
// member (bảng thống kê cốt thép: footings, columns, ground beams and beams as designed, slabs and stairs by the
// detailing rules) and the quantities of materials (bảng tổng hợp khối lượng vật tư: concrete and formwork by member,
// steel by grade, brick walls and plaster). For estimating: the engineer and the quantity surveyor check them against
// the final drawings. Lengths in mm; quantities in m³, m², kg and tonnes.
import { buildModel } from './elevation.mjs';
import { uStairGeom } from './plan.mjs';
import { TEXT_STYLE, viewTitle } from './standards.mjs';
import { rebarSchedule, SL } from './structure.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const LAP = 40, ANCHOR = 30, STOCK = 11700;
const withLaps = (len, d) => len + Math.floor(len / STOCK) * LAP * d;
const tieLength = (b, h, c, d) => 2 * (b + h - 4 * c) + 2 * Math.max(75, 10 * d);
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

const W = {
  vi: {
    foot: 'MÓNG', col: 'CỘT', gm: 'GIẰNG MÓNG', beams: 'DẦM SÀN', slab: 'SÀN', stair: 'CẦU THANG', rules: 'theo cấu tạo',
    meshX: 'Lưới đáy phương X, bẻ móc 150', meshY: 'Lưới đáy phương Y, bẻ móc 150', colMain: 'Thép dọc cột, nối chồng 40d mỗi tầng', colTie: 'Đai cột',
    bottom: 'Thép dưới chạy suốt, neo 30d', supTop: 'Thép trên tại gối, dài L/3', spanTop: 'Thép trên giữa nhịp (cấu tạo), nối 40d', tie: 'Đai dầm',
    slabX: 'Thép lớp dưới phương X', slabY: 'Thép lớp dưới phương Y', slabTop: 'Thép mũ trên dầm, dài L/4', stMain: 'Thép chịu lực bản thang', stDist: 'Thép phân bố bản thang',
    stLand: 'Thép chiếu nghỉ 2 phương',
  },
  en: {
    foot: 'FOOTINGS', col: 'COLUMNS', gm: 'GROUND BEAMS', beams: 'BEAMS OF SLAB', slab: 'SLAB', stair: 'STAIRS', rules: 'detailing rules',
    meshX: 'Bottom mesh X, 150 hooks', meshY: 'Bottom mesh Y, 150 hooks', colMain: 'Column bars, 40d laps at each floor', colTie: 'Column ties',
    bottom: 'Bottom bars, through, 30d anchorage', supTop: 'Top bars at supports, L/3', spanTop: 'Top bars at midspan (detailing), 40d laps', tie: 'Stirrups',
    slabX: 'Bottom bars X', slabY: 'Bottom bars Y', slabTop: 'Top bars over the beams, L/4', stMain: 'Main bars of the flights', stDist: 'Distribution bars of the flights',
    stLand: 'Landing bars both ways',
  },
};

/** Column stacks of the calculation grouped by their height (C1, C2 ... from the tallest). */
function columnGroups(R) {
  const groups = new Map();
  for (const c of R.columns) {
    const key = `${c.top}|${c.bottom}|${c.storeys}|${c.on ?? ''}`;
    if (!groups.has(key)) groups.set(key, { top: c.top, bottom: c.bottom, storeys: c.storeys, on: c.on, count: 0, names: [] });
    const g = groups.get(key);
    g.count++;
    g.names.push(c.name);
  }
  return [...groups.values()].sort((a, b) => b.top - b.bottom - (a.top - a.bottom)).map((g, i) => ({ ...g, name: `C${i + 1}`, L: g.top - g.bottom }));
}

/** Net length of a beam between the faces of its supports (column width taken off each span). */
const netLength = (t, cb) => sum(t.spans.map((x) => Math.max(0, x * 1000 - cb)));

/** Slab area of a level (m²): its panels less the stair openings in them. */
function slabArea(S) {
  const cells = S.loads?.cells ?? [];
  const A = sum(cells.map((cl) => ((cl.x1 - cl.x0) / 1000) * ((cl.y1 - cl.y0) / 1000)));
  const open = sum((S.stairs || []).map((b) => sum(cells.map((cl) => {
    const w = Math.min(cl.x1, b[2]) - Math.max(cl.x0, b[0]), h = Math.min(cl.y1, b[3]) - Math.max(cl.y0, b[1]);
    return w > 0 && h > 0 ? (w / 1000) * (h / 1000) : 0;
  }))));
  return A - open;
}

/** The bar schedule groups: [{title, rows (rebarSchedule rows)}], in the order of the works. */
export function rebarGroups(R, lang = 'vi', { mesh = { d: 12, spacing: 150 }, slabBar = { d: 8, spacing: 200 }, tie = { d: 6, spacing: 150 } } = {}) {
  const T = W[lang] ?? W.vi;
  const c = R.cover, groups = [];
  const nFoot = R.columns.filter((x) => !x.on).length;
  if (nFoot) {
    const { B, L } = R.footing, cf = 50;
    groups.push({
      title: `${T.foot} M1 (${B}x${L})`, rows: [
        { mark: 'M1-1', shape: T.meshX, d: mesh.d, length: B - 2 * cf + 300, n: Math.floor((L - 2 * cf) / mesh.spacing) + 1, members: nFoot },
        { mark: 'M1-2', shape: T.meshY, d: mesh.d, length: L - 2 * cf + 300, n: Math.floor((B - 2 * cf) / mesh.spacing) + 1, members: nFoot },
      ],
    });
  }
  const [cb, ch] = R.column.size, cbar = R.column.bars;
  const cg = columnGroups(R);
  if (cg.length) {
    const rows = [];
    for (const g of cg) {
      const footed = !g.on;
      // the bars: anchored into the footing (300 bend) or the beam under it (30d), lapped at every floor above the first
      const len = g.L + (footed ? 300 : ANCHOR * cbar.d) + ANCHOR * cbar.d + Math.max(0, g.storeys - 1) * LAP * cbar.d;
      rows.push({ mark: `${g.name}-1`, shape: `${T.colMain}`, d: cbar.d, length: Math.round(len), n: cbar.n, members: g.count });
      rows.push({ mark: `${g.name}-2`, shape: `${T.colTie} Ø${tie.d}a${tie.spacing}`, d: tie.d, length: Math.round(tieLength(cb, ch, c, tie.d)), n: Math.ceil(g.L / tie.spacing) + 1, members: g.count });
    }
    groups.push({ title: `${T.col} ${cb}x${ch}`, rows });
  }
  for (const S of R.slabs) {
    if (!S.types?.length) continue;
    const rows = [];
    for (const t of S.types) {
      const Ls = t.spans.map((x) => x * 1000), n = Ls.length, Lt = sum(Ls);
      const bs = t.barsSpan, bh = t.barsSup, sw = t.stirrups;
      rows.push({ mark: `${t.name}-1`, shape: T.bottom, d: bs.d, length: Math.round(withLaps(Lt + 2 * ANCHOR * bs.d, bs.d)), n: bs.n, members: t.count });
      const ends = n === 1 ? 2 * (Ls[0] / 3 + ANCHOR * bh.d) : Ls[0] / 3 + Ls[n - 1] / 3 + 2 * ANCHOR * bh.d;
      const inner = sum(Ls.slice(1).map((L, i) => (Ls[i] + L) / 3));
      rows.push({ mark: `${t.name}-2`, shape: T.supTop, d: bh.d, length: Math.round((ends + inner) / (n + 1)), n: (n + 1) * bh.n, members: t.count });
      rows.push({ mark: `${t.name}-3`, shape: T.spanTop, d: 12, length: Math.round(sum(Ls.map((L) => L / 3 + 2 * LAP * 12)) / n), n: 2 * n, members: t.count });
      const count = sum(Ls.map((L) => 2 * Math.ceil(L / 4 / sw.support) + Math.ceil(L / 2 / sw.span) + 1));
      rows.push({ mark: `${t.name}-4`, shape: `${T.tie} Ø${sw.d}a${sw.support}/${sw.span}`, d: sw.d, length: Math.round(tieLength(t.b, t.h, c, sw.d)), n: count, members: t.count });
    }
    groups.push({ title: S.kind === 'foundation' ? T.gm : `${T.beams} ${S.name}`, rows });
  }
  // slabs by the detailing rules (not designed): bottom both ways, top over the beams
  for (const S of R.slabs) {
    // every panel (the bars stop at the stair opening: counted through it, on the safe side)
    const cells = S.loads?.cells ?? [];
    if (!cells.length) continue;
    const s = slabBar.spacing, d = slabBar.d;
    const acc = { x: [0, 0], y: [0, 0], t: [0, 0] };
    for (const cl of cells) {
      const wx = cl.x1 - cl.x0, wy = cl.y1 - cl.y0, lmin = Math.min(wx, wy);
      acc.x[0] += Math.floor(wy / s) + 1; acc.x[1] += (Math.floor(wy / s) + 1) * (wx + 200);
      acc.y[0] += Math.floor(wx / s) + 1; acc.y[1] += (Math.floor(wx / s) + 1) * (wy + 200);
      for (const [k, e] of Object.entries(cl.e)) {
        if (!e) continue;
        const len = k === 'bottom' || k === 'top' ? wx : wy;
        acc.t[0] += Math.floor(len / s) + 1;
        acc.t[1] += (Math.floor(len / s) + 1) * (lmin / 4 + 150);
      }
    }
    const row = (mark, shape, [n, total]) => ({ mark, shape, d, length: Math.round(total / n), n, members: 1 });
    const id = `S${S.name.replace(/\s+/g, '')}`;
    groups.push({
      title: `${T.slab} ${S.name} (${T.rules})`, rows: [
        row(`${id}-1`, `${T.slabX} Ø${d}a${s}`, acc.x), row(`${id}-2`, `${T.slabY} Ø${d}a${s}`, acc.y), row(`${id}-3`, `${T.slabTop} Ø${d}a${s}`, acc.t),
      ],
    });
  }
  // stairs by the detailing rules: flights Ø10a150 along, Ø6a200 across; landings Ø8a200 both ways
  const srows = [];
  R.floors.forEach((f, k) => {
    for (const st of (f.spec.stairs || []).filter((x) => x.type === 'u')) {
      const g = uStairGeom(st, f.height);
      const flight = (nr) => Math.hypot((nr - 1) * g.going, nr * g.riser);
      for (const [j, nr] of [g.n1, g.n2].entries()) {
        const L = flight(nr);
        srows.push({ mark: `CT${k + 1}.${j * 2 + 1}`, shape: `${T.stMain} Ø10a150`, d: 10, length: Math.round(L + 2 * ANCHOR * 10), n: Math.floor(g.w / 150) + 1, members: 1 });
        srows.push({ mark: `CT${k + 1}.${j * 2 + 2}`, shape: `${T.stDist} Ø6a200`, d: 6, length: Math.round(g.w - 2 * 15), n: Math.floor(L / 200) + 1, members: 1 });
      }
      const wl = g.b1 - g.b0;
      srows.push({ mark: `CT${k + 1}.5`, shape: `${T.stLand} Ø8a200`, d: 8, length: Math.round((wl + g.landing) / 2 + 200), n: Math.floor(wl / 200) + Math.floor(g.landing / 200) + 2, members: 1 });
    }
  });
  if (srows.length) groups.push({ title: `${T.stair} (${T.rules})`, rows: srows });
  return groups.map((g) => ({ ...g, sched: rebarSchedule(g.rows, lang) }));
}

/** Steel totals of the groups: by diameter (kg) and by grade (tonnes), plain bars up to 10 mm, ribbed above. */
export function steelTotals(groups, R) {
  const byD = {};
  for (const g of groups) for (const [d, kg] of Object.entries(g.sched.by_diameter_kg)) byD[d] = r2((byD[d] ?? 0) + kg);
  const small = sum(Object.entries(byD).filter(([d]) => Number(d) <= 10).map(([, kg]) => kg));
  const large = sum(Object.entries(byD).filter(([d]) => Number(d) > 10).map(([, kg]) => kg));
  return { byD, small: r2(small), large: r2(large), total: r2(small + large), grades: [R.names.stirrupSteel, R.names.steel] };
}

/** Walls of every floor with their net areas (openings off), heights up to the beam or slab above, exterior or not. */
function wallAreas(R) {
  const out = [];
  R.floors.forEach((f, k) => {
    const M = buildModel(f.spec);
    const above = R.slabs[k + 1];
    const segs = M.walls.flatMap((w) => w.segs);
    const pts = segs.flatMap((s) => [s.a, s.b]);
    const box = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    for (const w of M.walls) {
      for (const s of w.segs) {
        const host = above?.members?.find((m) => Math.abs(cross(m.d, s.d)) < 1e-6 && Math.abs(cross(m.d, sub(s.a, m.A))) < s.t);
        const parapet = w.height !== undefined;
        // the ground floor walls stand on the ground beams, below the floor level
        const base = k === 0 ? Math.abs(R.ground) : 0;
        const H = parapet ? w.height : f.height + base - (host ? host.h : above?.slab ?? 120);
        let A = (s.L / 1000) * (H / 1000);
        for (const op of M.openings.filter((o) => o.s === s)) A -= ((op.span.to - op.span.from) / 1000) * (Math.max(0, Math.min(op.head, H) - op.sill) / 1000);
        const onEdge = [box[0], box[2]].some((x) => Math.abs(s.d[0]) < 1e-6 && Math.abs(s.a[0] - x) < s.t) || [box[1], box[3]].some((y) => Math.abs(s.d[1]) < 1e-6 && Math.abs(s.a[1] - y) < s.t);
        out.push({ floor: f.name, t: s.t, A: Math.max(0, A), exterior: onEdge, parapet });
      }
    }
  });
  return out;
}

/** The quantities of materials: rows [stt, item, unit, quantity, how it is made up] with section headings. */
export function quantities(R, groups, lang = 'vi') {
  const en = lang === 'en';
  const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', en ? '.' : ',');
  const rows = [];
  let n = 0;
  const head = (t) => rows.push({ head: true, item: t });
  const add = (item, unit, q, how) => rows.push({ stt: ++n, item, unit, q: r3(q), how });
  const [cb, ch] = R.column.size;
  const { B, L, H } = R.footing;
  const nFoot = R.columns.filter((x) => !x.on).length;
  const GM = R.slabs.find((S) => S.kind === 'foundation');
  const gmLen = GM ? sum(GM.types.map((t) => netLength(t, cb) * t.count)) / 1000 : 0;
  const gmT = GM?.types?.[0];
  head(en ? 'I. FOUNDATIONS' : 'I. PHẦN MÓNG');
  add(en ? 'Lean concrete B7.5 under the footings, 100 thick' : 'Bê tông lót móng đá 4x6 B7.5, dày 100', 'm³', nFoot * ((B + 200) / 1000) * ((L + 200) / 1000) * 0.1, `${nFoot} x ${fmt((B + 200) / 1000)} x ${fmt((L + 200) / 1000)} x 0,1`);
  if (gmT) add(en ? 'Lean concrete B7.5 under the ground beams, 100 thick' : 'Bê tông lót giằng móng B7.5, dày 100', 'm³', gmLen * ((gmT.b + 200) / 1000) * 0.1, `${fmt(gmLen)} x ${fmt((gmT.b + 200) / 1000)} x 0,1`);
  add(en ? `Concrete ${R.names.concrete}: pad footings M1` : `Bê tông móng M1 ${R.names.concrete}`, 'm³', nFoot * (B / 1000) * (L / 1000) * (H / 1000), `${nFoot} x ${fmt(B / 1000)} x ${fmt(L / 1000)} x ${fmt(H / 1000)}`);
  const stub = (R.depth - H) / 1000;
  add(en ? `Concrete ${R.names.concrete}: column stubs below ±0.000` : `Bê tông cổ cột (dưới cốt ±0.000) ${R.names.concrete}`, 'm³', nFoot * (cb / 1000) * (ch / 1000) * stub, `${nFoot} x ${fmt(cb / 1000)} x ${fmt(ch / 1000)} x ${fmt(stub)}`);
  if (gmT) add(en ? `Concrete ${R.names.concrete}: ground beams` : `Bê tông giằng móng ${R.names.concrete}`, 'm³', sum(GM.types.map((t) => (netLength(t, cb) / 1000) * t.count * (t.b / 1000) * (t.h / 1000))), GM.types.map((t) => `${t.count} x ${fmt(netLength(t, cb) / 1000)} x ${fmt(t.b / 1000)} x ${fmt(t.h / 1000)}`).join(' + '));
  add(en ? 'Formwork: footings' : 'Ván khuôn móng', 'm²', nFoot * 2 * ((B + L) / 1000) * (H / 1000), `${nFoot} x 2 x (${fmt(B / 1000)} + ${fmt(L / 1000)}) x ${fmt(H / 1000)}`);
  if (gmT) add(en ? 'Formwork: ground beams' : 'Ván khuôn giằng móng', 'm²', sum(GM.types.map((t) => (netLength(t, cb) / 1000) * t.count * 2 * (t.h / 1000))), `${fmt(gmLen)} x 2 x ${fmt(gmT.h / 1000)}`);
  add(en ? 'Formwork: column stubs' : 'Ván khuôn cổ cột', 'm²', nFoot * 2 * ((cb + ch) / 1000) * stub, `${nFoot} x 2 x (${fmt(cb / 1000)} + ${fmt(ch / 1000)}) x ${fmt(stub)}`);
  head(en ? 'II. FRAME' : 'II. PHẦN THÂN');
  // columns storey by storey, from the floor level (or the slab they stand on) up to the next slab
  const levels = R.slabs.filter((S) => S.kind !== 'foundation').map((S) => S.level);
  const floorsBase = [0, ...levels];
  for (let i = 0; i < levels.length; i++) {
    const z0 = floorsBase[i], z1 = levels[i];
    const cnt = R.columns.filter((c) => c.bottom <= z0 + 1 && c.top >= z1 - 1).length;
    if (!cnt) continue;
    const h = (z1 - z0) / 1000;
    const nm = R.slabs[i + 1]?.name ?? '';
    add(en ? `Concrete ${R.names.concrete}: columns up to ${nm}` : `Bê tông cột đến sàn ${nm} ${R.names.concrete}`, 'm³', cnt * (cb / 1000) * (ch / 1000) * h, `${cnt} x ${fmt(cb / 1000)} x ${fmt(ch / 1000)} x ${fmt(h)}`);
    add(en ? `Formwork: columns up to ${nm}` : `Ván khuôn cột đến sàn ${nm}`, 'm²', cnt * 2 * ((cb + ch) / 1000) * h, `${cnt} x 2 x (${fmt(cb / 1000)} + ${fmt(ch / 1000)}) x ${fmt(h)}`);
  }
  for (const S of R.slabs.filter((x) => x.kind !== 'foundation')) {
    const web = (t) => Math.max(0, t.h - S.slab) / 1000;
    add(en ? `Concrete ${R.names.concrete}: beams of ${S.name} (below the slab)` : `Bê tông dầm sàn ${S.name} (phần dưới sàn) ${R.names.concrete}`, 'm³',
      sum(S.types.map((t) => t.count * (netLength(t, cb) / 1000) * (t.b / 1000) * web(t))), S.types.map((t) => `${t.count} x ${fmt(netLength(t, cb) / 1000)} x ${fmt(t.b / 1000)} x ${fmt(web(t))}`).join(' + '));
    const Aslab = slabArea(S);
    add(en ? `Concrete ${R.names.concrete}: slab ${S.name}, ${S.slab} thick` : `Bê tông sàn ${S.name} dày ${S.slab} ${R.names.concrete}`, 'm³', Aslab * (S.slab / 1000), `${fmt(Aslab)} x ${fmt(S.slab / 1000)}`);
    add(en ? `Formwork: beams and slab ${S.name}` : `Ván khuôn dầm, sàn ${S.name}`, 'm²',
      Aslab + sum(S.types.map((t) => t.count * (netLength(t, cb) / 1000) * 2 * web(t))), `${fmt(Aslab)} + ${S.types.map((t) => `${t.count} x ${fmt(netLength(t, cb) / 1000)} x 2 x ${fmt(web(t))}`).join(' + ')}`);
  }
  // the stairs: waist slabs of the flights and the landing, 120 thick
  let Vst = 0;
  const parts = [];
  R.floors.forEach((f) => {
    for (const st of (f.spec.stairs || []).filter((x) => x.type === 'u')) {
      const g = uStairGeom(st, f.height);
      const fl = (nr) => Math.hypot((nr - 1) * g.going, nr * g.riser) / 1000;
      const v = (fl(g.n1) + fl(g.n2)) * (g.w / 1000) * 0.12 + ((g.b1 - g.b0) / 1000) * (g.landing / 1000) * 0.12;
      Vst += v;
      parts.push(fmt(v, 3));
    }
  });
  if (Vst) add(en ? `Concrete ${R.names.concrete}: stair flights and landings, 120 thick` : `Bê tông bản thang, chiếu nghỉ dày 120 ${R.names.concrete}`, 'm³', Vst, parts.join(' + '));
  const st = steelTotals(groups, R);
  add(en ? `Reinforcement ${st.grades[0]}, Ø ≤ 10` : `Cốt thép ${st.grades[0]}, Ø ≤ 10`, en ? 't' : 'tấn', st.small / 1000, en ? 'bar schedule' : 'theo bảng thống kê cốt thép');
  add(en ? `Reinforcement ${st.grades[1]}, Ø > 10` : `Cốt thép ${st.grades[1]}, Ø > 10`, en ? 't' : 'tấn', st.large / 1000, en ? 'bar schedule' : 'theo bảng thống kê cốt thép');
  head(en ? 'III. MASONRY AND PLASTER' : 'III. PHẦN XÂY, TRÁT');
  const walls = wallAreas(R);
  for (const t of [...new Set(walls.map((w) => w.t))].sort((a, b) => b - a)) {
    const A = sum(walls.filter((w) => w.t === t).map((w) => w.A));
    add(en ? `Brick walls ${t} thick, mortar M75 (openings off)` : `Xây tường gạch dày ${t} VXM M75 (đã trừ cửa)`, 'm²', A, en ? `volume ${fmt(A * (t / 1000), 2)} m³` : `thể tích ${fmt(A * (t / 1000), 2)} m³`);
  }
  const inside = sum(walls.map((w) => (w.parapet ? 0 : w.exterior ? w.A : 2 * w.A)));
  const outside = sum(walls.map((w) => (w.parapet ? 2 * w.A : w.exterior ? w.A : 0)));
  add(en ? 'Plaster inside, mortar M75 15 thick' : 'Trát tường trong VXM M75 dày 15', 'm²', inside, en ? 'both faces of the inner walls, inner face of the outer walls' : '2 mặt tường trong, mặt trong tường bao');
  add(en ? 'Plaster outside, mortar M75 15 thick' : 'Trát tường ngoài VXM M75 dày 15', 'm²', outside, en ? 'outer face of the outer walls, both faces of the parapets' : 'mặt ngoài tường bao, 2 mặt tường mái');
  let soffit = 0;
  for (const S of R.slabs.filter((x) => x.kind !== 'foundation')) {
    soffit += slabArea(S) + sum(S.types.map((t) => t.count * (netLength(t, cb) / 1000) * 2 * (Math.max(0, t.h - S.slab) / 1000)));
  }
  add(en ? 'Plaster of soffits and beams, mortar M75 15 thick' : 'Trát trần, dầm VXM M75 dày 15', 'm²', soffit, en ? 'slab soffits and beam sides' : 'đáy sàn và thành dầm');
  return { rows, steel: st };
}

/** Table specs: the bar schedule groups flowing in columns over pages, and the quantities with the steel summary. */
export function boqSheets(R, { scale = 25, lang = 'vi', pageHeight = 330, perPage = 2, groups = null } = {}) {
  const en = lang === 'en', sc = scale;
  const G = groups ?? rebarGroups(R, lang);
  const Q = quantities(R, G, lang);
  const rh = 6.5, widths = [20, 66, 12, 22, 18, 12, 20, 20, 22];
  const colW = sum(widths) + 12;
  const tableH = (g) => (g.sched.drawn.length + 1) * rh + 10;
  // the bar schedule: tables top to bottom in columns of pageHeight, perPage columns a page
  const pages = [];
  let page = null, col = -1, y = 0;
  const newCol = () => {
    col++;
    if (!page || col >= perPage) {
      page = { title: en ? 'BAR SCHEDULE' : 'BẢNG THỐNG KÊ CỐT THÉP', entities: [], x0: pages.length * (perPage * colW + 60) * sc };
      pages.push(page);
      col = 0;
    }
    y = 0;
  };
  newCol();
  for (const g of G) {
    const h = tableH(g);
    if (y > 0 && y + h > pageHeight) newCol();
    page.entities.push({
      type: 'table', at: [r2(page.x0 + col * colW * sc), r2(-y * sc)], title: g.title, rows: g.sched.drawn, decimal_separator: en ? undefined : ',',
      height: r2(2.2 * sc), row_height: r2(rh * sc), col_widths: widths.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE,
    });
    y += h;
  }
  pages.forEach((p, i) => {
    const title = pages.length > 1 ? `${p.title} (${i + 1}/${pages.length})` : p.title;
    p.title = title;
    p.entities.push(...viewTitle(title, p.x0 + (perPage * colW * sc) / 2, -(pageHeight + 12) * sc, sc, SL.text, lang, 5, false));
  });
  // the quantities with the steel totals beside them
  const qx = pages.length * (perPage * colW + 60) * sc;
  const qRows = [[en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'MADE UP OF' : 'DIỄN GIẢI']];
  for (const r of Q.rows) qRows.push(r.head ? ['', r.item, '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how]);
  const qEnt = {
    type: 'table', at: [qx, 0], title: en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ', rows: qRows, decimal_separator: en ? undefined : ',',
    height: r2(2.2 * sc), row_height: r2(rh * sc), col_widths: [10, 92, 14, 22, 92].map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE,
  };
  const sRows = [[en ? 'DIAMETER' : 'ĐƯỜNG KÍNH', en ? 'WEIGHT (kg)' : 'KHỐI LƯỢNG (kg)']];
  for (const [d, kg] of Object.entries(Q.steel.byD).sort((a, b) => Number(a[0]) - Number(b[0]))) sRows.push([`Ø${d}`, kg]);
  sRows.push([`Ø ≤ 10 (${Q.steel.grades[0]})`, Q.steel.small], [`Ø > 10 (${Q.steel.grades[1]})`, Q.steel.large], [en ? 'TOTAL' : 'TỔNG CỘNG', Q.steel.total]);
  const sEnt = {
    type: 'table', at: [r2(qx + 242 * sc), 0], title: en ? 'STEEL BY DIAMETER' : 'TỔNG HỢP THÉP THEO ĐƯỜNG KÍNH', rows: sRows, decimal_separator: en ? undefined : ',',
    height: r2(2.2 * sc), row_height: r2(rh * sc), col_widths: [34, 30].map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE,
  };
  const note = {
    type: 'mtext', at: [r2(qx), r2(-(qRows.length + 2) * rh * sc - 4 * sc)], width: r2(230 * sc), height: r2(2.5 * sc), layer: SL.text, style: TEXT_STYLE,
    text: en ? 'Quantities from the preliminary calculation, for estimating: the quantity surveyor checks them against the final drawings (lengths along the axes, joints and columns in the walls not deducted).'
      : 'Khối lượng lấy theo bảng tính sơ bộ, dùng để lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công (chiều dài theo trục, chưa trừ phần giao nhau, cột trong tường).',
  };
  const boq = { title: en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ', entities: [qEnt, sEnt, note] };
  boq.entities.push(...viewTitle(boq.title, qx + 150 * sc, -(qRows.length + 12) * rh * sc, sc, SL.text, lang, 5, false));
  return { pages, boq, groups: G, quantities: Q };
}

/** The bar schedule and the quantities as CSV (Excel), semicolons and decimal commas in Vietnamese. */
export function boqCsv(G, Q, lang = 'vi', sep = ';') {
  const en = lang === 'en';
  const num = (v) => (typeof v === 'number' ? (sep === ';' ? String(v).replace('.', ',') : String(v)) : String(v ?? ''));
  const esc = (v) => {
    const s = num(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [esc(en ? 'BAR SCHEDULE' : 'BẢNG THỐNG KÊ CỐT THÉP')];
  for (const g of G) lines.push('', esc(g.title), ...g.sched.table.map((r) => r.map(esc).join(sep)));
  lines.push('', esc(en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ'));
  lines.push([en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'MADE UP OF' : 'DIỄN GIẢI'].map(esc).join(sep));
  for (const r of Q.rows) lines.push((r.head ? ['', r.item, '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how]).map(esc).join(sep));
  lines.push('', esc(en ? 'STEEL BY DIAMETER (kg)' : 'TỔNG HỢP THÉP THEO ĐƯỜNG KÍNH (kg)'));
  for (const [d, kg] of Object.entries(Q.steel.byD).sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push([`Ø${d}`, kg].map(esc).join(sep));
  lines.push([en ? 'TOTAL' : 'TỔNG CỘNG', Q.steel.total].map(esc).join(sep));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

