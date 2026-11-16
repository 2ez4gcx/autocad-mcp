// Bills of quantities of the structural set from the preliminary calculation (calc.mjs): the bar schedule of every
// member (bảng thống kê cốt thép: footings, columns, ground beams, beams, slabs, balconies, stairs and lintels with
// the sizes and bars the calculation designed) and the quantities of materials (bảng tổng hợp khối lượng vật tư:
// concrete and formwork by member, steel by grade, brick walls and plaster). The quantities are measured on the
// solid model of the structure (solids.mjs: every volume counted once, formwork and plaster on the real faces) by a
// rule set (rules.mjs: Phụ lục VI of Thông tư 13/2021/TT-BXD by default); each line carries the measured quantity and
// the geometric one, and the bill comes with its cross-checks. The earthwork of the foundations (excavation, backfill,
// surplus soil), the slab on grade of the ground floor with the fill under it and the brick steps of the stairs are
// measured on the same model, with what they assume (working space, thickness) returned as assumed. For estimating:
// the engineer and the quantity surveyor check them against the final drawings. Lengths in mm; quantities in m³, m²,
// kg and tonnes.
import { uStairGeom } from './plan.mjs';
import { ruleSet } from './rules.mjs';
import { dec, mS, runsOn, showExpr, solidModel } from './solids.mjs';
import { floorTag, TEXT_STYLE, viewTitle } from './standards.mjs';
import { rebarSchedule, SL } from './structure.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const fmt2 = (v) => String(v).replace('.', ',');
const LAP = 40, ANCHOR = 30, STOCK = 11700;
const withLaps = (len, d) => len + Math.floor(len / STOCK) * LAP * d;
const tieLength = (b, h, c, d) => 2 * (b + h - 4 * c) + 2 * Math.max(75, 10 * d);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const strip = (b) => `Ø${b.d}a${b.s ?? b.spacing}`;

const W = {
  vi: {
    foot: 'MÓNG', col: 'CỘT', gm: 'GIẰNG MÓNG', beams: 'DẦM SÀN', slab: 'SÀN', stair: 'CẦU THANG',
    meshX: (b) => `Lưới đáy phương X ${b}, bẻ móc 150`, meshY: (b) => `Lưới đáy phương Y ${b}, bẻ móc 150`,
    colMain: (h) => `Thép dọc cột cao ${h}, nối chồng 40d mỗi tầng`, colTie: 'Đai cột',
    bottom: 'Thép dưới chạy suốt, neo 30d', supTop: 'Thép trên tại gối, dài L/3', spanTop: 'Thép trên giữa nhịp (cấu tạo), nối 40d', tie: 'Đai dầm',
    slabX: 'Thép lớp dưới phương X', slabY: 'Thép lớp dưới phương Y', slabTop: 'Thép mũ trên dầm giữa hai ô, dài L/4 mỗi bên', slabEdge: 'Thép mũ trên dầm biên (cấu tạo), dài L/4',
    balTop: 'Thép mũ ban công, neo vào sàn trong', balBot: 'Thép lớp dưới ban công (cấu tạo)', balDist: 'Thép phân bố ban công, 2 lớp',
    stMain: 'Thép chịu lực bản thang và chiếu nghỉ', stDist: 'Thép phân bố bản thang', stLand: 'Thép mũ chiếu nghỉ 2 phương (cấu tạo)',
    lt: 'LANH TÔ', ltBottom: 'Thép dưới lanh tô', ltTop: 'Thép trên lanh tô', ltTie: 'Đai lanh tô',
  },
  en: {
    foot: 'FOOTING', col: 'COLUMNS', gm: 'GROUND BEAMS', beams: 'BEAMS OF SLAB', slab: 'SLAB', stair: 'STAIRS',
    meshX: (b) => `Bottom mesh X ${b}, 150 hooks`, meshY: (b) => `Bottom mesh Y ${b}, 150 hooks`,
    colMain: (h) => `Column bars, height ${h}, 40d laps at each floor`, colTie: 'Column ties',
    bottom: 'Bottom bars, through, 30d anchorage', supTop: 'Top bars at supports, L/3', spanTop: 'Top bars at midspan (detailing), 40d laps', tie: 'Stirrups',
    slabX: 'Bottom bars X', slabY: 'Bottom bars Y', slabTop: 'Top bars over the beams between panels, L/4 each side', slabEdge: 'Top bars over the edge beams (detailing), L/4',
    balTop: 'Balcony top bars, anchored into the floor slab', balBot: 'Balcony bottom bars (detailing)', balDist: 'Balcony distribution bars, two layers',
    stMain: 'Main bars of the flights and the landing', stDist: 'Distribution bars of the flights', stLand: 'Landing top bars both ways (detailing)',
    lt: 'LINTELS', ltBottom: 'Lintel bottom bars', ltTop: 'Lintel top bars', ltTie: 'Lintel stirrups',
  },
};

/** Column stacks of the calculation by their mark (C1, C2 ... by size), each mark split by height (a, b ... from the tallest). */
function columnGroups(R) {
  const marks = new Map();
  for (const c of R.columns) {
    if (!marks.has(c.mark)) marks.set(c.mark, { mark: c.mark, size: c.size, bars: c.bars, subs: new Map() });
    const g = marks.get(c.mark);
    const key = `${c.top}|${c.bottom}|${c.storeys}|${c.on ?? ''}`;
    if (!g.subs.has(key)) g.subs.set(key, { top: c.top, bottom: c.bottom, storeys: c.storeys, on: c.on, count: 0, L: c.top - c.bottom });
    g.subs.get(key).count++;
  }
  return [...marks.values()].sort((a, b) => a.mark.localeCompare(b.mark, undefined, { numeric: true }))
    .map((g) => ({ ...g, subs: [...g.subs.values()].sort((a, b) => b.L - a.L) }));
}

/**
 * The bar schedule groups: [{title, rows (rebarSchedule rows)}], in the order of the works. model: the solid model
 * of the calculation (solids.mjs), for the lintels over the openings; built here when not given.
 */
export function rebarGroups(R, lang = 'vi', { tie = { d: 6, spacing: 150 }, model = null } = {}) {
  const T = W[lang] ?? W.vi;
  const c = R.cover, groups = [];
  // pad footings by type, as the calculation sized them: bottom mesh both ways, cover 50
  const cf = 50;
  for (const ft of R.footings ?? []) {
    if (!ft.count) continue;
    const { B, L, mesh } = ft, b = `Ø${mesh.d}a${mesh.spacing}`;
    groups.push({
      title: `${T.foot} ${ft.mark} (${B}x${L})`, rows: [
        { mark: `${ft.mark}-1`, shape: T.meshX(b), d: mesh.d, length: B - 2 * cf + 300, n: Math.floor((L - 2 * cf) / mesh.spacing) + 1, members: ft.count },
        { mark: `${ft.mark}-2`, shape: T.meshY(b), d: mesh.d, length: L - 2 * cf + 300, n: Math.floor((B - 2 * cf) / mesh.spacing) + 1, members: ft.count },
      ],
    });
  }
  // columns by mark (the marks of the plans), each mark by height
  for (const g of columnGroups(R)) {
    const [cb, ch] = g.size, cbar = g.bars;
    const rows = [];
    g.subs.forEach((s, i) => {
      const id = g.subs.length > 1 ? `${g.mark}${String.fromCharCode(97 + i)}` : g.mark;
      // the bars: anchored into the footing (300 bend) or the beam under it (30d), lapped at every floor above the first
      const len = s.L + (s.on ? ANCHOR * cbar.d : 300) + ANCHOR * cbar.d + Math.max(0, s.storeys - 1) * LAP * cbar.d;
      rows.push({ mark: `${id}-1`, shape: T.colMain(Math.round(s.L)), d: cbar.d, length: Math.round(len), n: cbar.n, members: s.count });
      rows.push({ mark: `${id}-2`, shape: `${T.colTie} Ø${tie.d}a${tie.spacing}`, d: tie.d, length: Math.round(tieLength(cb, ch, c, tie.d)), n: Math.ceil(s.L / tie.spacing) + 1, members: s.count });
    });
    groups.push({ title: `${T.col} ${g.mark} (${cb}x${ch})`, rows });
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
  // slabs with the bars of the calculation: bottom both ways, top over the beams between panels; over the edge beams
  // by the detailing rules; then the balconies of the slab
  for (const S of R.slabs) {
    // every panel (the bars stop at the stair opening: counted through it, on the safe side)
    const cells = S.loads?.cells ?? [];
    if (!cells.length) continue;
    const D = S.design, bx = D?.x ?? { d: 8, s: 200 }, by = D?.y ?? { d: 8, s: 200 }, bt = D?.top ?? { d: 8, s: 200 }, be = { d: 8, s: 200 };
    const acc = { x: [0, 0], y: [0, 0], t: [0, 0], e: [0, 0] };
    for (const cl of cells) {
      const wx = cl.x1 - cl.x0, wy = cl.y1 - cl.y0, lmin = Math.min(wx, wy);
      acc.x[0] += Math.floor(wy / bx.s) + 1; acc.x[1] += (Math.floor(wy / bx.s) + 1) * (wx + 200);
      acc.y[0] += Math.floor(wx / by.s) + 1; acc.y[1] += (Math.floor(wx / by.s) + 1) * (wy + 200);
      for (const [k, e] of Object.entries(cl.e)) {
        if (!e) continue;
        const len = k === 'bottom' || k === 'top' ? wx : wy;
        const on = runsOn(cl, k, cells), a = on ? acc.t : acc.e, s = on ? bt.s : be.s;
        a[0] += Math.floor(len / s) + 1;
        a[1] += (Math.floor(len / s) + 1) * (lmin / 4 + 150);
      }
    }
    const row = (mark, shape, b, [n, total]) => ({ mark, shape: `${shape} ${strip(b)}`, d: b.d, length: Math.round(total / n), n, members: 1 });
    // S2-1 for the slab of floor 2 (the tag of its floor, not its whole name)
    const tag = S.tag ?? floorTag(S.name, S.name.replace(/\s+/g, ''));
    const id = `S${tag}`;
    const rows = [row(`${id}-1`, T.slabX, bx, acc.x), row(`${id}-2`, T.slabY, by, acc.y)];
    if (acc.t[0]) rows.push(row(`${id}-3`, T.slabTop, bt, acc.t));
    if (acc.e[0]) rows.push(row(`${id}-4`, T.slabEdge, be, acc.e));
    (S.balconyDesign ?? []).forEach((b, i) => {
      const out = b.d * 1000, len = b.len * 1000, bid = `BC${tag}${(S.balconyDesign.length > 1 ? `.${i + 1}` : '')}`;
      // top bars: the cantilever, as much again into the floor slab (40d at least), a hook down at the edge
      rows.push({ mark: `${bid}-1`, shape: `${T.balTop} ${strip(b.top)}`, d: b.top.d, length: Math.round(out + Math.max(out, LAP * b.top.d) + Math.max(0, S.slab - 40)), n: Math.floor(len / b.top.s) + 1, members: 1 });
      rows.push({ mark: `${bid}-2`, shape: `${T.balBot} ${strip(b.dist)}`, d: b.dist.d, length: Math.round(out + 150), n: Math.floor(len / b.dist.s) + 1, members: 1 });
      rows.push({ mark: `${bid}-3`, shape: `${T.balDist} ${strip(b.dist)}`, d: b.dist.d, length: Math.round(withLaps(len, b.dist.d)), n: 2 * (Math.floor(out / b.dist.s) + 1), members: 1 });
    });
    groups.push({ title: `${T.slab} ${S.name}`, rows });
  }
  // stairs with the bars of the calculation: main bars along the flight and its landing, distribution bars across
  const srows = [];
  R.floors.forEach((f, k) => {
    const D = (R.stairs ?? []).find((x) => x.index === k);
    const main = D?.main ?? { d: 10, s: 150 }, dist = D?.dist ?? { d: 8, s: 200 };
    for (const st of (f.spec.stairs || []).filter((x) => x.type === 'u')) {
      const g = uStairGeom(st, f.height);
      const flight = (nr) => Math.hypot((nr - 1) * g.going, nr * g.riser);
      for (const [j, nr] of [g.n1, g.n2].entries()) {
        const L = flight(nr) + g.landing;
        srows.push({ mark: `CT${k + 1}.${j * 2 + 1}`, shape: `${T.stMain} ${strip(main)}`, d: main.d, length: Math.round(L + 2 * ANCHOR * main.d), n: Math.floor(g.w / main.s) + 1, members: 1 });
        srows.push({ mark: `CT${k + 1}.${j * 2 + 2}`, shape: `${T.stDist} ${strip(dist)}`, d: dist.d, length: Math.round(g.w - 2 * 15), n: Math.floor(L / dist.s) + 1, members: 1 });
      }
      const wl = g.b1 - g.b0;
      srows.push({ mark: `CT${k + 1}.5`, shape: `${T.stLand} Ø8a200`, d: 8, length: Math.round((wl + g.landing) / 2 + 200), n: Math.floor(wl / 200) + Math.floor(g.landing / 200) + 2, members: 1 });
    }
  });
  if (srows.length) groups.push({ title: T.stair, rows: srows });
  // the lintels over the openings, by the typical table of the general notes (cover 15): like lintels together
  const lts = new Map();
  for (const x of (model ?? solidModel(R, { lang })).solids.filter((q) => q.kind === 'lintel' && q.net > 5e-7)) {
    const [b, h, L] = x.dims.map(Math.round), k = `${b}x${h}x${L}`;
    if (!lts.has(k)) lts.set(k, { b, h, L, lt: x.lintel, count: 0 });
    lts.get(k).count++;
  }
  const lrows = [];
  [...lts.values()].sort((p, q) => q.b - p.b || p.L - q.L || p.h - q.h).forEach((x, i) => {
    const id = `LT${i + 1}`, cl = 15;
    lrows.push({ mark: `${id}-1`, shape: `${T.ltBottom} ${x.b}x${x.h}, L=${x.L}`, d: x.lt.bottom.d, length: x.L - 2 * cl, n: x.lt.bottom.n, members: x.count });
    lrows.push({ mark: `${id}-2`, shape: T.ltTop, d: x.lt.top.d, length: x.L - 2 * cl, n: x.lt.top.n, members: x.count });
    lrows.push({ mark: `${id}-3`, shape: `${T.ltTie} Ø${x.lt.tie.d}a${x.lt.tie.s}`, d: x.lt.tie.d, length: Math.round(tieLength(x.b, x.h, cl, x.lt.tie.d)), n: Math.ceil(x.L / x.lt.tie.s) + 1, members: x.count });
  });
  if (lrows.length) groups.push({ title: T.lt, rows: lrows });
  return groups.map((g) => ({ ...g, sched: rebarSchedule(g.rows, lang) }));
}

/**
 * Steel totals of the groups: by diameter (kg), by grade (tonnes: plain bars under 10 mm, ribbed bars from 10 mm, as
 * the general notes say) and by the diameter groups of the norms (Phụ lục VI, 5.6: Ø ≤ 10, 10 < Ø ≤ 18, Ø > 18). The
 * lengths of the schedule include the laps and the anchorage. Weights are summed bar by bar before rounding, as the
 * formulas of the drawn tables and of the workbook do.
 */
export function steelTotals(groups, R) {
  // the weights as the tables and the workbook compute them: bars x length x d²/162, summed before rounding
  const raw = {};
  for (const g of groups) for (const r of g.sched.rows) raw[r.d] = (raw[r.d] ?? 0) + (r.total * r.length * r.d * r.d) / 162000;
  const byD = Object.fromEntries(Object.entries(raw).map(([d, kg]) => [d, r2(kg)]));
  const of = (test) => r2(sum(Object.entries(raw).filter(([d]) => test(Number(d))).map(([, kg]) => kg)));
  const small = of((d) => d < 10), large = of((d) => d >= 10);
  const norm = [
    { key: 'd<=10', label: 'Ø ≤ 10', kg: of((d) => d <= 10) },
    { key: 'd<=18', label: '10 < Ø ≤ 18', kg: of((d) => d > 10 && d <= 18) },
    { key: 'd>18', label: 'Ø > 18', kg: of((d) => d > 18) },
  ];
  return { byD, small, large, total: of(() => true), grades: [R.names.stirrupSteel, R.names.steel], groups: norm };
}

/** What the bill does not count, and why: returned with the bill and written under it. */
function notCountedList(en) {
  return en ? [
    { item: 'Wall ties, wall posts, starter bars of the walls', why: 'by the general notes: the model has no geometry for them' },
    { item: 'Shoring and dewatering of the excavation, formwork of the lean concrete', why: 'depend on the ground and the method of work' },
  ] : [
    { item: 'Giằng tường, bổ trụ, râu thép chờ tường', why: 'theo ghi chú chung: mô hình không có hình học của chúng' },
    { item: 'Chống vách, bơm nước hố móng, ván khuôn bê tông lót', why: 'tùy địa chất và biện pháp thi công' },
  ];
}

// a made-up-of text longer than this is given as a summary (the parts are in the workbook and the CSV)
const LONG = 96;

/**
 * The quantities of materials, measured on the solid model of the structure (solids.mjs) by a rule set (rules.mjs,
 * default Phụ lục VI): {rows, steel, checks, notCounted, assumed, rules}. A row is a section heading {head, item} or
 * {stt, key, item, unit, q (measured by the rule set), geo (the geometric net), count (like parts), how (diễn giải),
 * parts: [{ref, label, n, expr, one, rule}]}: q is the sum of n x one over its parts, geo the same without the parts
 * a rule adds (an opening too small to be deducted). The expr of a part is its formula ("0.22*0.22*3.60-0.0213": the
 * prism of the member less what the junction rules gave to others), a live formula in the workbook. A concrete line
 * of the solid model has concrete: true; a part may be named (its label is shown) and may come from another line of
 * the bill (from: {key, k}: k times the geometric total of that line - the backfill is the excavation less what is
 * buried in it). assumed [{item, value, note}]: what the earthwork, the ground slab and the steps assume. options:
 * those of solidModel (earth, groundSlab) when the model is built here.
 */
export function quantities(R, groups, lang = 'vi', rules = null, model = null, options = {}) {
  const en = lang === 'en', RS = ruleSet(rules);
  const M = model ?? solidModel(R, { rules: RS, lang, ...options });
  const D = RS.decimals ?? 3, rq = (v) => Math.round(v * 10 ** D) / 10 ** D;
  const fmt = (v, d = 2) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d).replace('.', en ? '.' : ',');
  const rd = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  const rows = [];
  let n = 0;
  const head = (t) => rows.push({ head: true, item: t });
  const tot = (ps) => sum(ps.map((p) => p.n * p.one));
  const add = (key, item, unit, parts, how, count = 1, more = {}) => {
    const row = { stt: ++n, key, item, unit, q: rq(tot(parts)), geo: rq(tot(parts.filter((p) => !p.rule))), count, how, parts, ...more };
    rows.push(row);
    return row;
  };
  const paren = (e) => { let s = e, t; do { t = s; s = s.replace(/\([^()]*\)/g, ''); } while (s !== t); return /[-+]/.test(s.replace(/^-/, '')); };
  const show = (p) => {
    const e = showExpr(p.expr, lang), body = p.n > 1 ? `${p.n} x ${paren(p.expr) ? `(${e})` : e}` : e;
    return p.rule || p.model || p.named ? `${p.label} ${body}` : body;
  };
  const text = (parts, short) => { const s = parts.map(show).join(' + '); return s.length > LONG && short ? short() : s; };
  /** Like parts of a list of solids: the same expression, counted. */
  const like = (list, pick) => {
    const m = new Map();
    for (const s of list) {
      const { expr, one } = pick(s);
      if (!m.has(expr)) m.set(expr, { ref: s.mark ?? s.id, label: s.id, n: 0, expr, one, ids: [] });
      const p = m.get(expr);
      p.n++;
      p.ids.push(s.id);
    }
    return [...m.values()];
  };
  const rulePart = (label, list, pick) => {
    const m = new Map();
    for (const x of list) { const { expr, one } = pick(x); if (!m.has(expr)) m.set(expr, { ref: '', label, n: 0, expr, one, rule: true }); m.get(expr).n++; }
    return [...m.values()];
  };
  const solidsOf = (g) => M.solids.filter((s) => s.group === g && s.net > 5e-7);
  const members = (k) => (en ? `${k} members` : `${k} cấu kiện`);
  const concrete = (key, item, list, why, extra = []) => {
    if (!list.length) return null;
    const parts = [...like(list, (s) => ({ expr: s.expr, one: s.one })), ...extra];
    const gross = sum(list.map((s) => s.value)), cut = gross - tot(parts.filter((p) => !p.rule));
    return add(key, item, 'm³', parts, text(parts, () => `${members(list.length)}: ${fmt(gross, 3)}${cut > 5e-4 ? ` - ${fmt(cut, 3)} (${why})` : ''}${extra.length ? ` + ${extra.map(show).join(' + ')}` : ''}`), list.length, { concrete: true });
  };
  const formwork = (key, item, list, why) => {
    const L = list.filter((s) => s.formwork.total > 1e-9);
    if (!L.length) return null;
    const parts = like(L, (s) => ({ expr: s.formwork.expr, one: s.formwork.one }));
    const gross = sum(L.map((s) => s.formwork.gross)), cut = gross - tot(parts);
    return add(key, item, 'm²', parts, text(parts, () => `${members(L.length)}: ${fmt(gross, 3)}${cut > 5e-4 ? ` - ${fmt(cut, 3)} (${why})` : ''}`), L.length);
  };
  const c = R.names.concrete;
  const Y = en ? {
    once: 'overlaps counted once', stub: 'less the column stubs, crossings once', node: 'the nodes are counted with the beams and the slabs', gnode: 'the nodes are counted with the ground beams',
    beam: 'what lies in the slab thickness is slab, crossings once', cast: 'less the faces cast against concrete', col: 'less the columns',
  } : {
    once: 'chỗ chồng nhau tính một lần', stub: 'trừ cổ cột, chỗ giao tính một lần', node: 'nút khung tính vào dầm, sàn', gnode: 'nút tính vào giằng móng',
    beam: 'phần trong chiều dày sàn tính vào sàn, chỗ giao tính một lần', cast: 'trừ mặt giáp bê tông', col: 'trừ phần cột',
  };
  const marks = (R.footings ?? []).filter((x) => x.count).map((x) => x.mark).join(', ');
  head(en ? 'I. FOUNDATIONS' : 'I. PHẦN MÓNG');
  // the earthwork: a pit under every pad, a trench under every ground beam, overlaps counted once
  const E = M.earth;
  let dug = null;
  if (E) {
    const parts = like(E.items, (x) => ({ expr: x.expr, one: x.one }));
    const nPit = E.items.filter((x) => x.kind === 'pit').length, nTr = E.items.length - nPit, over = E.sum - E.total;
    const sides = E.slope > 0 ? (en ? `slope 1:${fmt(E.slope, 2).replace(/[.,]?0+$/, '')}` : `mái dốc 1:${fmt(E.slope, 2).replace(/[.,]?0+$/, '')}`) : (en ? 'vertical' : 'thành đứng');
    dug = add('excavation', en ? `Excavation of pits and trenches (${sides}, ${E.space} space)` : `Đào hố móng, rãnh giằng (${sides}, lưu không ${E.space})`, 'm³', parts,
      text(parts, () => `${en ? `${nPit} pits, ${nTr} trenches` : `${nPit} hố móng, ${nTr} rãnh giằng`}: ${fmt(E.sum, 3)}${over > 5e-4 ? ` - ${fmt(over, 3)} (${Y.once})` : ''}`), E.items.length);
  }
  concrete('lean_footing', en ? 'Lean concrete B7.5 under the footings, 100 thick' : 'Bê tông lót móng đá 4x6 B7.5, dày 100', solidsOf('lean_footing'), Y.once);
  concrete('lean_ground_beam', en ? 'Lean concrete B7.5 under the ground beams, 100 thick' : 'Bê tông lót giằng móng B7.5, dày 100', solidsOf('lean_ground_beam'), Y.stub);
  concrete('footing', en ? `Concrete ${c}: pad footings ${marks}` : `Bê tông móng ${marks} ${c}`, solidsOf('footing'), Y.once);
  concrete('stub', en ? `Concrete ${c}: column stubs below ±0.000` : `Bê tông cổ cột (dưới cốt ±0.000) ${c}`, solidsOf('stub'), Y.gnode);
  concrete('ground_beam', en ? `Concrete ${c}: ground beams` : `Bê tông giằng móng ${c}`, solidsOf('ground_beam'), Y.once);
  formwork('fw_footing', en ? 'Formwork: footings' : 'Ván khuôn móng', solidsOf('footing'), Y.cast);
  formwork('fw_ground_beam', en ? 'Formwork: ground beams' : 'Ván khuôn giằng móng', solidsOf('ground_beam'), Y.cast);
  formwork('fw_stub', en ? 'Formwork: column stubs' : 'Ván khuôn cổ cột', solidsOf('stub'), Y.cast);
  // the backfill: the excavation less what is buried in it (the lines above where the whole line lies under the
  // ground, else the part of each member below the ground); the soil that is left over is what the members displace
  let back = null;
  if (E && dug) {
    const NAME = en ? { lean_footing: 'lean concrete of the footings', lean_ground_beam: 'lean concrete of the ground beams', footing: 'footings', stub: 'column stubs below the ground', ground_beam: 'ground beams' }
      : { lean_footing: 'bê tông lót móng', lean_ground_beam: 'bê tông lót giằng móng', footing: 'móng', stub: 'cổ cột dưới mặt đất', ground_beam: 'giằng móng' };
    const SHORT = en ? { lean_footing: 'lean', lean_ground_beam: 'lean of beams', footing: 'footings', stub: 'stubs', ground_beam: 'ground beams' }
      : { lean_footing: 'lót móng', lean_ground_beam: 'lót giằng', footing: 'móng', stub: 'cổ cột', ground_beam: 'giằng' };
    const all = tot(dug.parts);
    const parts = [{ ref: '', label: en ? 'excavation' : 'đất đào', n: 1, expr: dec(all, 3), one: all, from: { key: 'excavation', k: 1 }, named: true }];
    const names = [];
    // in the order of the lines above
    const ORDER = ['lean_footing', 'lean_ground_beam', 'footing', 'stub', 'ground_beam'], place = (g) => (ORDER.indexOf(g.group) + 1 || ORDER.length + 1);
    for (const g of [...E.buried.groups].sort((u, v) => place(u) - place(v))) {
      const row = rows.find((r) => r.key === g.group), label = `${en ? 'less' : 'trừ'} ${NAME[g.group] ?? g.group}`;
      if (g.whole && row) {
        const v = tot(row.parts.filter((x) => !x.rule));
        parts.push({ ref: '', label, n: 1, expr: `-${dec(v, 3)}`, one: -v, from: { key: g.group, k: -1 }, named: true });
      } else for (const x of like(M.solids.filter((q) => q.group === g.group && q.buried), (q) => ({ expr: `-(${q.buried.expr})`, one: -q.buried.one }))) parts.push({ ...x, label, named: true });
      names.push(`${SHORT[g.group] ?? g.group} ${fmt(g.volume, 3)}`);
    }
    const off = all - tot(parts), long = `${en ? 'excavation' : 'đào'} ${fmt(all, 3)} - ${en ? 'buried' : 'chiếm chỗ'} ${fmt(off, 3)} (${names.join(', ')})`;
    back = add('backfill', en ? 'Backfill of the excavation with the excavated soil' : 'Đắp đất hố móng bằng đất đào, đầm chặt', 'm³', parts,
      long.length > LONG ? `${en ? 'excavation' : 'đào'} ${fmt(all, 3)} - ${en ? 'buried members' : 'cấu kiện chiếm chỗ'} ${fmt(off, 3)}` : long);
    const filled = tot(parts);
    add('surplus', en ? 'Surplus soil carted away' : 'Vận chuyển đất thừa đi đổ', 'm³', [
      { ref: '', label: en ? 'excavation' : 'đất đào', n: 1, expr: dec(all, 3), one: all, from: { key: 'excavation', k: 1 }, named: true },
      { ref: '', label: en ? 'less the backfill' : 'trừ đất đắp', n: 1, expr: `-${dec(filled, 3)}`, one: -filled, from: { key: 'backfill', k: -1 }, named: true },
    ], `${en ? 'excavation' : 'đào'} ${fmt(all, 3)} - ${en ? 'backfill' : 'đắp'} ${fmt(filled, 3)}`);
  }
  // the ground floor: the fill from the ground up to the underside of the slab on grade, and the slab, both inside
  // the walls (the walls stand on the ground beams: the slab is cast between them, around the columns)
  {
    const slabs = solidsOf('ground_slab'), filled = slabs.filter((q) => q.fill?.net > 5e-7), GO = M.options?.groundSlab || {};
    if (filled.length) {
      const parts = like(filled, (q) => ({ expr: q.fill.expr, one: q.fill.one }));
      const gross = sum(filled.map((q) => q.fill.value)), cut = gross - tot(parts), hf = Math.round(filled[0].fill.height * 1000);
      add('ground_fill', en ? `Sand fill under the ground floor slab, ${hf} thick` : `Cát tôn nền tầng 1 dày ${hf}, đầm chặt`, 'm³', parts,
        text(parts, () => `${en ? `${filled.length} bays inside the walls` : `${filled.length} ô nền trong lòng tường`}: ${fmt(gross, 3)}${cut > 5e-4 ? ` - ${fmt(cut, 3)} (${Y.col})` : ''}`), filled.length);
    }
    if (slabs.length) {
      concrete('ground_slab', en ? `Concrete ${GO.concrete ?? 'B15'}: ground floor slab on grade, ${slabs[0].t} thick` : `Bê tông nền tầng 1 ${GO.concrete ?? 'B15'} dày ${slabs[0].t}`, slabs, Y.col);
    }
  }
  head(en ? 'II. FRAME' : 'II. PHẦN THÂN');
  const tops = R.slabs.filter((S) => S.kind !== 'foundation');
  for (const S of tops) {
    const cols = solidsOf(`column:${S.name}`);
    concrete(`column:${S.name}`, en ? `Concrete ${c}: columns up to ${S.name}` : `Bê tông cột đến sàn ${S.name} ${c}`, cols, Y.node);
    formwork(`fw_column:${S.name}`, en ? `Formwork: columns up to ${S.name}` : `Ván khuôn cột đến sàn ${S.name}`, cols, Y.cast);
  }
  const vc = RS.void.concrete, vf = RS.void.formwork, vp = RS.void.finish, vm = RS.void.masonry;
  const kept = (thr, unit) => (en ? `openings under ${fmt(thr)} ${unit} not deducted:` : `lỗ < ${fmt(thr)} ${unit} không trừ:`);
  const boxOf = (v, t) => { const w = v.box[2] - v.box[0], l = v.box[3] - v.box[1], full = Math.abs((w * l) / 1e6 - v.area) < 1e-9; return full ? `${mS(w)}*${mS(l)}${t ? `*${mS(t)}` : ''}` : dec(t ? v.volume : v.area, t ? 6 : 4); };
  const valOf = (v, t) => { const w = Math.round(v.box[2] - v.box[0]) / 1000, l = Math.round(v.box[3] - v.box[1]) / 1000, full = Math.abs(w * l - v.area) < 1e-9; return full ? w * l * (t ? Math.round(t) / 1000 : 1) : rd(t ? v.volume : v.area, t ? 6 : 4); };
  for (const S of tops) {
    const slab = solidsOf(`slab:${S.name}`), beams = solidsOf(`beam:${S.name}`), voids = slab.flatMap((s) => s.voids ?? []);
    concrete(`beam:${S.name}`, en ? `Concrete ${c}: beams of ${S.name} (below the slab)` : `Bê tông dầm sàn ${S.name} (phần dưới sàn) ${c}`, beams, Y.beam);
    // a void too small to be deducted stays in the slab (concrete) and under its formwork
    concrete(`slab:${S.name}`, en ? `Concrete ${c}: slab ${S.name}, ${S.slab} thick` : `Bê tông sàn ${S.name} dày ${S.slab} ${c}`, slab, Y.once,
      rulePart(kept(vc, 'm³'), voids.filter((v) => v.volume < vc), (v) => ({ expr: boxOf(v, S.slab), one: valOf(v, S.slab) })));
    const fb = beams.filter((s) => s.formwork.total > 1e-9);
    if (slab.length || fb.length) {
      const parts = [
        ...slab.map((s) => ({ ref: s.id, label: en ? 'slab, soffit + edges:' : 'sàn, đáy + thành:', n: 1, expr: s.formwork.expr, one: s.formwork.one, model: true })),
        ...like(fb, (s) => ({ expr: s.formwork.expr, one: s.formwork.one })),
        ...rulePart(kept(vf, 'm²'), voids.filter((v) => v.area < vf), (v) => ({ expr: boxOf(v), one: valOf(v) })),
      ];
      const fbSum = sum(fb.map((s) => s.formwork.one)), extra = parts.filter((p) => p.rule);
      const how = [
        slab.length ? `${en ? 'slab soffit' : 'đáy sàn'} ${fmt(sum(slab.map((s) => s.formwork.soffit)))} + ${en ? 'slab edges' : 'thành sàn'} ${fmt(sum(slab.map((s) => s.formwork.side)))}` : null,
        fb.length ? `${en ? 'beams (sides, soffits)' : 'dầm (thành, đáy)'} ${fmt(fbSum)}` : null, ...extra.map(show),
      ].filter(Boolean).join(' + ');
      add(`fw_slab:${S.name}`, en ? `Formwork: beams and slab ${S.name}` : `Ván khuôn dầm, sàn ${S.name}`, 'm²', parts, how, slab.length + fb.length);
    }
    const bal = solidsOf(`balcony:${S.name}`);
    concrete(`balcony:${S.name}`, en ? `Concrete ${c}: balconies of ${S.name}, ${S.slab} thick` : `Bê tông ban công ${S.name} dày ${S.slab} ${c}`, bal, Y.col);
    formwork(`fw_balcony:${S.name}`, en ? `Formwork: balconies of ${S.name}` : `Ván khuôn ban công ${S.name}`, bal, Y.cast);
  }
  // the stairs (waist slabs and landings: the steps are built on them), and the lintels over the openings
  const stairs = solidsOf('stair'), lintels = solidsOf('lintel');
  concrete('stair', en ? `Concrete ${c}: stair flights and landings (waist slabs)` : `Bê tông bản thang, chiếu nghỉ ${c}`, stairs, Y.col);
  formwork('fw_stair', en ? 'Formwork: stairs (soffits and edges of the waist slabs)' : 'Ván khuôn cầu thang (đáy bản, thành bản)', stairs, Y.cast);
  concrete('lintel', en ? 'Concrete B15: lintels' : 'Bê tông lanh tô B15', lintels, Y.col);
  formwork('fw_lintel', en ? 'Formwork: lintels (sides, soffit over the opening)' : 'Ván khuôn lanh tô (thành, đáy trên ô cửa)', lintels, Y.cast);
  const st = steelTotals(groups, R);
  const sched = en ? 'bar schedule (laps and anchorage included)' : 'theo bảng thống kê cốt thép (đã gồm nối chồng, neo)';
  add('steel_small', en ? `Reinforcement ${st.grades[0]}, Ø < 10` : `Cốt thép ${st.grades[0]}, Ø < 10`, en ? 't' : 'tấn', [{ ref: '', label: sched, n: 1, expr: null, one: st.small / 1000, steel: 'small' }], sched);
  add('steel_large', en ? `Reinforcement ${st.grades[1]}, Ø ≥ 10` : `Cốt thép ${st.grades[1]}, Ø ≥ 10`, en ? 't' : 'tấn', [{ ref: '', label: sched, n: 1, expr: null, one: st.large / 1000, steel: 'large' }], sched);
  head(en ? 'III. MASONRY AND PLASTER' : 'III. PHẦN XÂY, TRÁT');
  // masonry by thickness: the walls up to the slab less the concrete in them (columns, beams, lintels), the openings
  // and what two walls share where they meet; an opening smaller than the threshold is not deducted
  for (const t of [...new Set(M.walls.map((w) => w.t))].sort((a, b) => b - a)) {
    const tm = t / 1000, by = new Map();
    for (const w of M.walls.filter((x) => x.t === t)) {
      const k = `${w.floor}|${w.z1 - w.z0}|${w.low}`;
      if (!by.has(k)) by.set(k, { floor: w.floor, H: (w.z1 - w.z0) / 1000, low: w.low, L: 0, gross: 0, conc: 0, open: 0, over: 0 });
      const g = by.get(k);
      g.L += w.L; g.gross += w.gross; g.conc += w.concrete; g.open += w.openings; g.over += w.overlap;
    }
    const S = { gross: 0, conc: 0, open: 0, over: 0 };
    const parts = [...by.values()].map((g) => {
      const L = rd(g.L, 3), exact = Math.abs(L * g.H * tm - g.gross) < 1e-6;
      const gv = exact ? L * g.H * tm : rd(g.gross, 4), off = [g.conc, g.open, g.over].map((v) => rd(v, 4));
      S.gross += gv; S.conc += off[0]; S.open += off[1]; S.over += off[2];
      return {
        ref: g.floor, label: `${g.floor}${g.low ? (en ? ' (low walls)' : ' (tường thấp)') : ''}`, n: 1,
        expr: `(${exact ? `${dec(L, 3)}*${dec(g.H, 3)}*${dec(tm, 3)}` : dec(gv, 4)}${off.filter((v) => v > 0).map((v) => `-${dec(v, 4)}`).join('')})/${dec(tm, 3)}`, one: (gv - off[0] - off[1] - off[2]) / tm,
      };
    });
    parts.push(...rulePart(kept(vm, 'm²'), M.openings.filter((o) => o.t === t && o.area > 1e-9 && o.area < vm), (o) => ({ expr: dec(o.area, 4), one: rd(o.area, 4) })));
    const A = tot(parts), back = tot(parts.filter((p) => p.rule));
    const how = en ? `volume ${fmt(A * tm)} m³: walls up to the slab ${fmt(S.gross)} - concrete ${fmt(S.conc)} - openings ${fmt(S.open - back * tm)}${S.over > 5e-3 ? ` - shared at junctions ${fmt(S.over)}` : ''}`
      : `thể tích ${fmt(A * tm)} m³: tường đến đáy sàn ${fmt(S.gross)} - bê tông ${fmt(S.conc)} - ô cửa ${fmt(S.open - back * tm)}${S.over > 5e-3 ? ` - chỗ giao tường ${fmt(S.over)}` : ''}`;
    add(`masonry:${t}`, en ? `Brick walls ${t} thick, mortar M75 (openings off)` : `Xây tường gạch dày ${t} VXM M75 (đã trừ cửa)`, 'm²', parts, how, 1, { volume: rq(A * tm), volumeGeo: rq((A - back) * tm) });
  }
  // the brick steps on the flights of the stairs: like steps together (the flights they belong to in the note)
  {
    const m = new Map();
    for (const q of M.solids.filter((x) => x.kind === 'stair' && x.steps?.length)) {
      for (const x of q.steps) {
        if (!m.has(x.expr)) m.set(x.expr, { ref: q.id, label: en ? 'steps' : 'bậc', n: 0, expr: x.expr, one: x.one, ids: [] });
        const part = m.get(x.expr);
        part.n += x.n;
        part.ids.push(`${q.id}${en ? ' flight ' : ' vế '}${x.flight}: ${x.n}`);
      }
    }
    const parts = [...m.values()], count = sum(parts.map((x) => x.n));
    if (count) {
      add('stair_steps', en ? 'Brick steps on the stair flights, mortar M75' : 'Xây bậc thang gạch đặc VXM M75', 'm³', parts,
        text(parts, () => `${count} ${en ? 'steps' : 'bậc'}: ${fmt(tot(parts), 3)} (${en ? 'going x riser / 2 x width each' : 'mỗi bậc = mặt bậc x cổ bậc / 2 x bề rộng vế'})`), count);
    }
  }
  // plaster: the faces that meet the air, up to the soffit. An opening smaller than the threshold is not deducted
  // (and has no reveals); the reveals of the others count with the face they open in
  const P = M.plaster, rev = RS.reveals !== false, small = M.openings.filter((o) => o.area > 1e-9 && o.area < vp);
  const faceRow = (key, item, comps, reveal, face, revealOf) => {
    const parts = comps.filter(([, v]) => v > 1e-9).map(([label, v]) => ({ ref: '', label, n: 1, expr: dec(v, 3), one: rd(v, 3), model: true }));
    if (reveal > 1e-9) parts.push({ ref: '', label: en ? 'reveals' : 'má cửa', n: 1, expr: dec(reveal, 3), one: rd(reveal, 3), model: true });
    if (!rev && reveal > 1e-9) parts.push({ ref: '', label: en ? 'reveals not measured:' : 'không tính má cửa:', n: 1, expr: `-${dec(reveal, 3)}`, one: -rd(reveal, 3), rule: true });
    parts.push(...rulePart(kept(vp, 'm²'), small.filter((o) => face(o) > 1e-9), (o) => { const v = face(o) - (rev ? revealOf(o) : 0); return { expr: dec(v, 4), one: rd(v, 4) }; }));
    if (parts.length) add(key, item, 'm²', parts, parts.map(show).join(' + '));
  };
  faceRow('plaster_in', en ? 'Plaster inside, mortar M75 15 thick' : 'Trát tường trong VXM M75 dày 15',
    [[en ? 'wall faces' : 'mặt tường', P.inside.wall], [en ? 'columns and lintels in the walls' : 'mặt cột, lanh tô trong tường', P.inside.concrete]], P.inside.reveal, (o) => o.faceIn, (o) => o.revealIn);
  faceRow('plaster_out', en ? 'Plaster outside, mortar M75 15 thick' : 'Trát tường ngoài VXM M75 dày 15',
    [[en ? 'wall faces' : 'mặt tường', P.outside.wall], [en ? 'columns, beams and slab edges' : 'mặt cột, dầm, mép sàn', P.outside.concrete]], P.outside.reveal, (o) => o.faceOut, (o) => o.revealOut);
  {
    const voids = M.solids.filter((s) => s.kind === 'slab').flatMap((s) => s.voids ?? []).filter((v) => v.area < vp);
    const parts = [[en ? 'slab soffits' : 'đáy sàn', P.soffit.slab], [en ? 'beams (soffits, inner sides)' : 'dầm (đáy, thành trong)', P.soffit.beam], [en ? 'balcony soffits' : 'đáy ban công', P.soffit.balcony], [en ? 'stair soffits' : 'đáy bản thang', P.soffit.stair]]
      .filter(([, v]) => v > 1e-9).map(([label, v]) => ({ ref: '', label, n: 1, expr: dec(v, 3), one: rd(v, 3), model: true }));
    parts.push(...rulePart(kept(vp, 'm²'), voids, (v) => ({ expr: boxOf(v), one: valOf(v) })));
    if (parts.length) add('plaster_soffit', en ? 'Plaster of soffits and beams, mortar M75 15 thick' : 'Trát trần, dầm VXM M75 dày 15', 'm²', parts, parts.map(show).join(' + '));
  }
  // the cross-checks: those of the model, the bill against the model, the steel against its schedule
  const checks = M.checks.map((x) => ({ ...x }));
  const check = (id, name, lhs, rhs, tol, where = []) => checks.push({ id, name, ok: Math.abs(lhs - rhs) <= tol && !where.length, lhs: rd(lhs, 6), rhs: rd(rhs, 6), tol, where });
  const conc = rows.filter((r) => !r.head && r.concrete);
  check('bill', en ? 'Concrete lines of the bill (geometric) = sum of the net volumes of the model (m³)' : 'Tổng các dòng bê tông của bảng (hình học) = tổng thể tích tịnh của mô hình (m³)', sum(conc.map((r) => tot(r.parts.filter((p) => !p.rule)))), M.sumNet, 2e-3);
  const fw = rows.filter((r) => !r.head && /^fw_/.test(r.key));
  check('formwork', en ? 'Formwork lines of the bill (geometric) = formed faces of the model (m²)' : 'Tổng các dòng ván khuôn của bảng (hình học) = diện tích mặt cần ván khuôn của mô hình (m²)', sum(fw.map((r) => tot(r.parts.filter((p) => !p.rule)))), sum(M.solids.map((s) => s.formwork.total)), 2e-2);
  const nrows = sum(groups.map((g) => g.sched.rows.length));
  check('steel', en ? 'Steel by diameter = sum of the rows of the bar schedule, each rounded to 0,01 kg (kg)' : 'Thép theo đường kính = tổng các dòng của bảng thống kê, mỗi dòng làm tròn 0,01 kg (kg)', sum(Object.values(st.byD)), sum(groups.map((g) => g.sched.total_kg)), rd(Math.max(0.05, 0.005 * nrows), 2));
  check('steel:groups', en ? 'Steel groups Ø ≤ 10, ≤ 18, > 18 = total (kg)' : 'Thép theo nhóm Ø ≤ 10, ≤ 18, > 18 = tổng cộng (kg)', sum(st.groups.map((g) => g.kg)), st.total, 0.05);
  if (E && dug && back) {
    const lineOf = (key) => tot(rows.find((r) => r.key === key).parts);
    check('earth:bill', en ? 'Earthwork lines of the bill: excavation and backfill = those of the model (m³)' : 'Các dòng đào, đắp của bảng = đào, đắp của mô hình (m³)', lineOf('excavation') + lineOf('backfill'), E.total + E.backfill, 4e-3);
    check('earth:balance', en ? 'Earthwork: backfill + soil carted away = excavation (m³)' : 'Đào đắp: đất đắp + đất thừa vận chuyển đi = đất đào (m³)', lineOf('backfill') + lineOf('surplus'), lineOf('excavation'), 1e-6);
  }
  return {
    rows, steel: st, checks, notCounted: notCountedList(en), assumed: (M.assumed ?? []).map((a) => ({ ...a })),
    rules: { name: RS.name?.[lang] ?? RS.name?.vi ?? '', void: { ...RS.void }, junction: [...(RS.junction ?? [])], reveals: rev, decimals: D },
  };
}

/**
 * Table specs: the bar schedule groups flowing in columns over pages, and the quantities with the steel summary.
 * rules: the measurement rule set (rules.mjs: 'PL6' by default, 'NET', or an object over one of them). Returns
 * {pages, boq, bills, groups, quantities, checks, notCounted, assumed, rules, model}: bills are the pages of the bill
 * (it breaks at pageHeight as the bar schedule does; boq is the first; each has tables and under(bottom): what goes
 * under the tables once their drawn extent is known), checks [{id, name, ok, lhs, rhs, tol,
 * where}] are the cross-checks of the model and the bill, model the solid model the quantities were measured on
 * (model.options: the earthwork and ground slab options as resolved - give them to structurePrisms). earth: {space:
 * working space of the excavation in mm (300), slope: horizontal for 1 vertical (0)} or false for no earthwork;
 * groundSlab: {thickness (100), concrete ('B15')} or false for no slab on grade; what is left to its default comes
 * back in assumed [{item, value, note}].
 */
export function boqSheets(R, { scale = 25, lang = 'vi', pageHeight = 330, perPage = 2, groups = null, rules = null, earth = null, groundSlab = null } = {}) {
  const en = lang === 'en', sc = scale;
  const M = solidModel(R, { rules, lang, earth, groundSlab });
  const G = groups ?? rebarGroups(R, lang, { model: M });
  const Q = quantities(R, G, lang, rules, M);
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
  // the quantities (measured by the rule set, and the geometric net beside it) with the steel totals
  const qx = pages.length * (perPage * colW + 60) * sc;
  const qHead = en ? ['No.', 'WORK ITEM', 'UNIT', 'QUANTITY', 'GEOMETRIC', 'MADE UP OF'] : ['STT', 'HẠNG MỤC CÔNG VIỆC', 'ĐƠN VỊ', 'KHỐI LƯỢNG', 'HÌNH HỌC', 'DIỄN GIẢI'];
  // the bill flows over pages of pageHeight as the bar schedule does: a page breaks before a section head where that
  // keeps more than half of it, the header row is repeated; the steel totals stand beside the first page, the note
  // under the last
  // a quantity as the bill writes it: the decimals of the rule set (0,460, not 0,46)
  const qDec = Q.rules?.decimals ?? 3;
  const qf = (v) => (v === undefined || v === null || v === '' ? '' : Number(v).toFixed(qDec).replace('.', en ? '.' : ','));
  const body = Q.rows.map((r) => (r.head ? ['', r.item, '', '', '', ''] : [r.stt, r.item, r.unit, qf(r.q), qf(r.geo), r.how]));
  const qW = [10, 88, 14, 22, 22, 96];
  // a row whose item or make-up runs over its cell is drawn on more lines: its height as the table will draw it,
  // estimated from the length of the texts (about half the text height a letter)
  const linesOf = (text, w) => Math.max(1, Math.ceil((String(text ?? '').length * 2.2 * 0.52) / (w - 3)));
  const rowH = (r) => Math.max(rh, Math.max(linesOf(r[1], qW[1]), linesOf(r[5], qW[5])) * 2.2 * 1.7 + 2);
  // pages of about the same height (not a full page and a nearly empty one): each stops at its even share, rather
  // before a section head when one is within three rows of the cut; a page that starts inside a section repeats
  // its head
  const heights = body.map(rowH), room = pageHeight - 2 * rh;
  const nPages = Math.max(1, Math.ceil(sum(heights) / room)), share = sum(heights) / nPages;
  const chunks = [];
  for (let i = 0; i < body.length;) {
    const even = chunks.length < nPages - 1;
    let j = i, h = 0;
    while (j < body.length && (j === i || (h + heights[j] <= room && (!even || h + heights[j] / 2 <= share)))) h += heights[j++];
    if (j < body.length) {
      for (let k = j; k >= Math.max(i + 1, j - 3); k--) {
        if (Q.rows[k].head) {
          j = k;
          break;
        }
      }
      // a head is not left alone at the foot of a page
      if (j - 1 > i && Q.rows[j - 1].head) j -= 1;
    }
    const rows = body.slice(i, j);
    const open = i > 0 && !Q.rows[i].head ? Q.rows.slice(0, i).reverse().find((r) => r.head) : null;
    if (open) rows.unshift(['', `${open.item} (${en ? 'cont.' : 'tiếp'})`, '', '', '', '']);
    chunks.push(rows);
    i = j;
  }
  if (!chunks.length) chunks.push([]);
  // the steel totals beside the first page: wide enough for their title on one line
  const sW = [40, 36];
  const billW = sum(qW) + 12 + sum(sW);
  const billTitle = en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ';
  const sRows = [[en ? 'DIAMETER' : 'ĐƯỜNG KÍNH', en ? 'WEIGHT (kg)' : 'KHỐI LƯỢNG (kg)']];
  for (const [d, kg] of Object.entries(Q.steel.byD).sort((a, b) => Number(a[0]) - Number(b[0]))) sRows.push([`Ø${d}`, kg]);
  sRows.push([`Ø < 10 (${Q.steel.grades[0]})`, Q.steel.small], [`Ø ≥ 10 (${Q.steel.grades[1]})`, Q.steel.large]);
  for (const g of Q.steel.groups) sRows.push([`${en ? 'Group' : 'Nhóm'} ${g.label}`, g.kg]);
  sRows.push([en ? 'TOTAL' : 'TỔNG CỘNG', Q.steel.total]);
  const out = Q.notCounted.map((x) => x.item.charAt(0).toLowerCase() + x.item.slice(1)).join('; ');
  const taken = Q.assumed.length ? `${en ? ' Assumed: ' : ' Giả định: '}${Q.assumed.map((a) => a.note).join('; ')}.` : '';
  const bad = Q.checks.filter((x) => !x.ok).length;
  const noteW = 230;
  const bills = chunks.map((rows, i) => {
    const x = qx + i * (billW + 60) * sc, last = i === chunks.length - 1;
    const title = chunks.length > 1 ? `${billTitle} (${i + 1}/${chunks.length})` : billTitle;
    const ents = [{
      type: 'table', at: [r2(x), 0], title, rows: [qHead, ...rows], decimal_separator: en ? undefined : ',',
      height: r2(2.2 * sc), row_height: r2(rh * sc), col_widths: qW.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE,
      // the quantities are texts with their decimals: kept to the right as numbers are
      col_align: [null, null, null, 'right', 'right', null],
    }];
    if (i === 0) {
      ents.push({
        type: 'table', at: [r2(x + (sum(qW) + 12) * sc), 0], title: en ? 'STEEL BY DIAMETER' : 'TỔNG HỢP THÉP THEO ĐƯỜNG KÍNH', rows: sRows, decimal_separator: en ? undefined : ',',
        height: r2(2.2 * sc), row_height: r2(rh * sc), col_widths: sW.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE,
      });
    }
    const tables = [...ents];
    // what stands under the tables: the note (the last page) and the title of the view. bottom: how far the tables
    // reach down (paper mm): as estimated here, or as they were drawn (under(bottom): the tool draws the tables first
    // and reads their extent, since the rows grow with their texts)
    const under = (bottom) => {
      const below = [];
      let low = bottom;
      if (last) {
        const note = {
          type: 'mtext', at: [r2(x), r2(-(bottom + 4) * sc)], width: r2(noteW * sc), height: r2(2.5 * sc), layer: SL.text, style: TEXT_STYLE,
    text: en ? `Quantities measured on the solid model of the preliminary calculation by ${Q.rules.name}: every volume counted once (what lies in the slab thickness is slab, the column-beam node is beam); formwork is the concrete surface not cast against concrete; masonry less the concrete in the walls and the openings; plaster on the faces that meet the air, up to the soffit, with the reveals. QUANTITY: by the rule set (openings under ${Q.rules.void.masonry} m² in masonry and finishes, ${Q.rules.void.formwork} m² in formwork, ${Q.rules.void.concrete} m³ in concrete are not deducted); GEOMETRIC: every opening deducted. Cross-checks: ${Q.checks.length - bad}/${Q.checks.length} passed. For estimating: the quantity surveyor checks them against the final drawings. Not included: ${out}.${taken}`
      : `Khối lượng đo trên mô hình khối của bảng tính sơ bộ theo ${Q.rules.name}: mỗi thể tích chỉ tính một lần (phần trong chiều dày sàn tính vào sàn, nút cột - dầm tính vào dầm); ván khuôn là mặt bê tông không giáp bê tông; khối xây đã trừ bê tông trong tường và ô cửa; trát tính trên các mặt lộ ra, đến đáy sàn, gồm má cửa. KHỐI LƯỢNG: theo quy tắc đo bóc (không trừ lỗ < ${fmt2(Q.rules.void.masonry)} m² với xây, trát; < ${fmt2(Q.rules.void.formwork)} m² với ván khuôn; < ${fmt2(Q.rules.void.concrete)} m³ với bê tông); HÌNH HỌC: trừ mọi lỗ mở. Kiểm tra chéo: đạt ${Q.checks.length - bad}/${Q.checks.length}. Dùng để lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công. Chưa gồm: ${out}.${taken}`,
        };
        below.push(note);
        low = bottom + 4 + (Math.ceil((note.text.length * 2.5 * 0.62) / noteW) + 1) * 2.5 * 1.7;
      }
      below.push(...viewTitle(title, x + 150 * sc, -(low + 14) * sc, sc, SL.text, lang, 5, false));
      return below;
    };
    const est = Math.max(2 * rh + sum(rows.map(rowH)), i === 0 ? (sRows.length + 1) * rh : 0);
    return { title, entities: [...tables, ...under(est)], tables, under };
  });
  // boq: the first page of the bill (the whole bill when it fits on one)
  const boq = bills[0];
  return { pages, boq, bills, groups: G, quantities: Q, checks: Q.checks, notCounted: Q.notCounted, assumed: Q.assumed, rules: Q.rules, model: M };
}

/**
 * The bar schedule and the quantities as CSV (Excel), semicolons and decimal commas in Vietnamese: the bill with both
 * quantities, then every line made up of its parts (Bảng 6.2 of Phụ lục VI: mark, like parts, expression, one part,
 * all), the steel by diameter and by group, the cross-checks and what is not counted.
 */
export function boqCsv(G, Q, lang = 'vi', sep = ';') {
  const en = lang === 'en';
  const num = (v) => (typeof v === 'number' ? (sep === ';' ? String(v).replace('.', ',') : String(v)) : String(v ?? ''));
  const esc = (v) => {
    const s = num(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  const line = (cells) => cells.map(esc).join(sep);
  const lines = [esc(en ? 'BAR SCHEDULE' : 'BẢNG THỐNG KÊ CỐT THÉP')];
  for (const g of G) lines.push('', esc(g.title), ...g.sched.table.map((r) => r.map(esc).join(sep)));
  lines.push('', esc(en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ'));
  if (Q.rules?.name) lines.push(esc(Q.rules.name));
  lines.push(line(en ? ['No.', 'WORK ITEM', 'UNIT', 'QUANTITY', 'MADE UP OF', 'GEOMETRIC QUANTITY', 'LIKE PARTS'] : ['STT', 'HẠNG MỤC CÔNG VIỆC', 'ĐƠN VỊ', 'KHỐI LƯỢNG', 'DIỄN GIẢI', 'KHỐI LƯỢNG HÌNH HỌC', 'SỐ BỘ PHẬN']));
  for (const r of Q.rows) lines.push(line(r.head ? ['', r.item, '', '', '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how, r.geo ?? r.q, r.count ?? 1]));
  if (Q.rows.some((r) => r.parts?.length)) {
    lines.push('', esc(en ? 'DETAILS OF THE QUANTITIES' : 'DIỄN GIẢI CHI TIẾT KHỐI LƯỢNG'));
    lines.push(line(en ? ['No.', 'MARK', 'ITEM', 'UNIT', 'LIKE PARTS', 'CALCULATION', 'ONE PART', 'ALL'] : ['STT', 'KÝ HIỆU', 'DANH MỤC', 'ĐƠN VỊ', 'SỐ BỘ PHẬN GIỐNG NHAU', 'DIỄN GIẢI TÍNH TOÁN', 'KHỐI LƯỢNG MỘT BỘ PHẬN', 'KHỐI LƯỢNG TOÀN BỘ']));
    for (const r of Q.rows) {
      if (r.head) { lines.push(line(['', r.item, '', '', '', '', '', ''])); continue; }
      lines.push(line([r.stt, '', r.item, r.unit, r.count ?? 1, '', '', r.q]));
      for (const p of r.parts ?? []) lines.push(line(['', p.ref ?? '', p.rule || p.model || p.named || !p.expr || !p.ids ? p.label : '', '', p.n, p.expr ? showExpr(p.expr, lang) : '', r4(p.one), r4(p.n * p.one)]));
    }
  }
  lines.push('', esc(en ? 'STEEL BY DIAMETER (kg)' : 'TỔNG HỢP THÉP THEO ĐƯỜNG KÍNH (kg)'));
  for (const [d, kg] of Object.entries(Q.steel.byD).sort((a, b) => Number(a[0]) - Number(b[0]))) lines.push([`Ø${d}`, kg].map(esc).join(sep));
  for (const g of Q.steel.groups ?? []) lines.push(line([`${en ? 'Group' : 'Nhóm'} ${g.label}`, g.kg]));
  lines.push([en ? 'TOTAL' : 'TỔNG CỘNG', Q.steel.total].map(esc).join(sep));
  if (Q.checks?.length) {
    lines.push('', esc(en ? 'CROSS-CHECKS' : 'KIỂM TRA CHÉO'), line(en ? ['CHECK', 'LEFT', 'RIGHT', 'TOLERANCE', 'RESULT', 'WHERE'] : ['NỘI DUNG', 'VẾ TRÁI', 'VẾ PHẢI', 'DUNG SAI', 'KẾT QUẢ', 'VỊ TRÍ']));
    for (const x of Q.checks) lines.push(line([x.name, x.lhs, x.rhs, x.tol, x.ok ? (en ? 'OK' : 'ĐẠT') : (en ? 'FAILED' : 'KHÔNG ĐẠT'), x.where.join(', ')]));
  }
  if (Q.notCounted?.length) {
    lines.push('', esc(en ? 'NOT INCLUDED' : 'CHƯA GỒM'));
    for (const x of Q.notCounted) lines.push(line([x.item, x.why]));
  }
  if (Q.assumed?.length) {
    lines.push('', esc(en ? 'ASSUMED' : 'GIẢ ĐỊNH'));
    for (const x of Q.assumed) lines.push(line([x.item, x.value, x.note]));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
