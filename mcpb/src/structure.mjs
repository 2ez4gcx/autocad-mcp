// Structural detail drawings (mm, at a detail scale such as 1:20 or 1:25): reinforced concrete cross-sections, beam
// details along their spans, pad footings, and the bar schedule with weights (d²/162 kg/m). Pure geometry: returns
// draw_entities specs. Sizes and reinforcement come from the user / the structural engineer: nothing is calculated
// here except lengths, counts and weights.
import { num, PlanError, pt } from './plan.mjs';
import { dimStyleName, FIELD, TEXT_STYLE, viewTitle } from './standards.mjs';
import { sym } from './symbols.mjs';

export const SL = {
  conc: 'S-CONC', concHatch: 'S-CONC-PATT', bar: 'S-REBR', tie: 'S-REBR-STIR', text: 'S-ANNO-TEXT', dims: 'S-ANNO-DIMS',
  symb: 'S-ANNO-SYMB', grid: 'S-GRID', gridTag: 'S-GRID-IDEN', ground: 'A-ELEV-OTLN', groundHatch: 'A-SECT-PATT',
};

const r2 = (v) => Math.round(v * 100) / 100;
const P = (x, y) => [r2(x), r2(y)];
export const kgPerM = (d) => (d * d) / 162;

function bars(v, name, def = {}) {
  if (!v) return null;
  return {
    d: num(v.d ?? def.d, `${name}.d`, { positive: true }),
    n: Math.round(num(v.n ?? def.n ?? 2, `${name}.n`, { min: 1 })),
    mark: String(v.mark ?? def.mark ?? ''),
  };
}

function ties(v, name, def = {}) {
  if (v === null || v === false) return null;
  const s = v || {};
  return {
    d: num(s.d ?? def.d ?? 6, `${name}.d`, { positive: true }),
    spacing: num(s.spacing ?? def.spacing ?? 150, `${name}.spacing`, { positive: true }),
    end: s.end !== undefined ? num(s.end, `${name}.end`, { positive: true }) : undefined,
    mid: s.mid !== undefined ? num(s.mid, `${name}.mid`, { positive: true }) : undefined,
    zone: num(s.zone ?? 0.25, `${name}.zone`, { min: 0 }),
    mark: String(s.mark ?? def.mark ?? ''),
  };
}

const label = (n, d) => `${n}Ø${d}`;

/** Defaults applied where the input is silent: [{item, value}] for the user to confirm or change. */
function assumedOf(p, list) {
  const get = (k) => k.split('.').reduce((o, s) => (o == null ? undefined : o[s]), p);
  return list.filter(([k]) => get(k) === undefined).map(([item, value]) => ({ item, value }));
}

/** Bar group defaults: the whole group when it is missing, else only its count. */
const barDefaults = (p, k, whole, n = 2) => (p[k] === undefined ? [[k, whole]] : p[k] === null ? [] : [[`${k}.n`, n]]);

/** Leader from a bar to a landing, text on the landing and the bar mark in a circle at its end. */
function callout(out, from, elbow, text, mark, sc, dir = 1) {
  const h = 2.5 * sc;
  const landing = Math.max(text.length * h * 0.72 + 2 * sc, 8 * sc);
  const end = [elbow[0] + dir * landing, elbow[1]];
  out.push({ type: 'polyline', points: [P(...from), P(...elbow), P(...end)], layer: SL.text });
  out.push({ type: 'circle', center: P(...from), radius: 0.5 * sc, layer: SL.text });
  out.push({ type: 'text', text, at: P(elbow[0] + dir * sc, elbow[1] + 0.8 * sc), height: h, align: dir > 0 ? 'left' : 'right', layer: SL.text, style: TEXT_STYLE });
  // One circle per mark: '2+3' (bars of two marks in one layer) becomes two circles side by side.
  for (const [i, m] of String(mark || '').split('+').filter(Boolean).entries()) {
    const c = [end[0] + dir * (2.5 + 5 * i) * sc, end[1]];
    if (m.length <= 2) {
      // the bar mark block (its number an attribute)
      out.push(sym('MCP_SO_HIEU', c, { scale: sc, attrs: { SH: m }, layer: SL.text, half: [2.5, 2.5] }));
      continue;
    }
    out.push({ type: 'circle', center: P(...c), radius: 2.5 * sc, layer: SL.text });
    out.push({ type: 'text', text: m, at: P(...c), height: 1.8 * sc, align: 'middle_center', layer: SL.text, style: TEXT_STYLE });
  }
}

function title(out, text, x, y, sc) {
  out.push(...viewTitle(text, x, y, sc, SL.text, 'vi', 4));
}

function dim(out, from, to, offset, sc, direction) {
  out.push({ type: 'dimension', kind: 'linear', from: P(...from), to: P(...to), offset, direction, style: dimStyleName(sc), layer: SL.dims });
}

// ---------------------------------------------------------------- cross-section

/**
 * Rectangular reinforced concrete cross-section. at = bottom-left corner. groups: [{face: bottom|top|bottom2|top2|
 * corners|sides|left|right, d, n, mark}]; stirrup {d, spacing, mark} drawn with 135° hooks.
 */
export function rcSection(p) {
  const sc = num(p.scale ?? 20, 'scale', { positive: true });
  const [x0, y0] = pt(p.at ?? [0, 0], 'at');
  const b = num(p.b, 'b', { positive: true }), h = num(p.h, 'h', { positive: true });
  const c = num(p.cover ?? 25, 'cover', { min: 0 });
  const st = ties(p.stirrup, 'stirrup');
  const sd = st ? st.d : 0;
  const out = [];
  const warnings = [];
  out.push({ type: 'rectangle', from: P(x0, y0), to: P(x0 + b, y0 + h), layer: SL.conc });
  if (st) {
    // Stirrup centre line with rounded corners (bend radius 2d) and the two 135° hook legs at the top-left corner.
    const i = c + sd / 2;
    const rr = Math.min(2 * sd, (b - 2 * i) / 4, (h - 2 * i) / 4);
    const xa = x0 + i, xb = x0 + b - i, ya = y0 + i, yb = y0 + h - i;
    const k = Math.tan(Math.PI / 8); // quarter-circle bulge
    out.push({
      type: 'polyline', closed: true, layer: SL.tie,
      points: [P(xa + rr, ya), P(xb - rr, ya), P(xb, ya + rr), P(xb, yb - rr), P(xb - rr, yb), P(xa + rr, yb), P(xa, yb - rr), P(xa, ya + rr)],
      bulges: [0, k, 0, k, 0, k, 0, k],
    });
    const hook = Math.max(6 * sd, 75);
    const hx = hook * Math.SQRT1_2;
    out.push({ type: 'line', from: P(xa + rr, yb), to: P(xa + rr + hx, yb - hx), layer: SL.tie });
    out.push({ type: 'line', from: P(xa, yb - rr), to: P(xa + hx, yb - rr - hx), layer: SL.tie });
  }
  const xl = x0 + c + sd, xr = x0 + b - c - sd, yl = y0 + c + sd, yt = y0 + h - c - sd;
  const placed = [];
  const row = (n, d, y) => {
    const xs = n === 1 ? [(xl + xr) / 2] : Array.from({ length: n }, (_, k) => xl + d / 2 + ((xr - xl - d) * k) / (n - 1));
    if (n > 1) {
      const clear = (xr - xl - d) / (n - 1) - d;
      if (clear < Math.max(d, 25)) warnings.push(`${n}Ø${d} in one row: clear spacing ${Math.round(clear)} mm is below max(d, 25 mm)`);
    }
    return xs.map((x) => [x, y]);
  };
  const col = (n, d, x) => Array.from({ length: n }, (_, k) => [x, yl + d / 2 + ((yt - yl - d) * (k + 1)) / (n + 1)]);
  for (const [gi, g] of (p.groups || []).entries()) {
    const gb = bars(g, `groups[${gi}]`);
    const face = g.face ?? 'bottom';
    let pts;
    switch (face) {
      case 'bottom': pts = row(gb.n, gb.d, yl + gb.d / 2); break;
      case 'top': pts = row(gb.n, gb.d, yt - gb.d / 2); break;
      case 'bottom2': pts = row(gb.n, gb.d, yl + gb.d * 1.5 + 25); break;
      case 'top2': pts = row(gb.n, gb.d, yt - gb.d * 1.5 - 25); break;
      case 'corners': pts = [[xl + gb.d / 2, yl + gb.d / 2], [xr - gb.d / 2, yl + gb.d / 2], [xr - gb.d / 2, yt - gb.d / 2], [xl + gb.d / 2, yt - gb.d / 2]]; break;
      case 'sides': pts = [...col(gb.n, gb.d, xl + gb.d / 2), ...col(gb.n, gb.d, xr - gb.d / 2)]; break;
      case 'left': pts = col(gb.n, gb.d, xl + gb.d / 2); break;
      case 'right': pts = col(gb.n, gb.d, xr - gb.d / 2); break;
      default: throw new PlanError(`groups[${gi}].face must be bottom, top, bottom2, top2, corners, sides, left or right`);
    }
    for (const q of pts) {
      out.push({ type: 'circle', center: P(...q), radius: gb.d / 2, layer: SL.bar });
      out.push({ type: 'hatch', boundary: Array.from({ length: 12 }, (_, k) => P(q[0] + (gb.d / 2) * Math.cos((k * Math.PI) / 6), q[1] + (gb.d / 2) * Math.sin((k * Math.PI) / 6))), pattern: 'SOLID', layer: SL.bar });
    }
    placed.push({ face, pts, g: gb });
  }
  // Callouts on the right, from the top down.
  const labels = [...placed].sort((p1, p2) => Math.max(...p2.pts.map((q) => q[1])) - Math.max(...p1.pts.map((q) => q[1])));
  let ty = y0 + h + 4 * sc;
  for (const g of labels) {
    const q = g.pts.reduce((best, s) => (s[0] > best[0] ? s : best), g.pts[0]);
    const n = g.pts.length;
    callout(out, q, [x0 + b + 8 * sc, ty], label(n, g.g.d), g.g.mark, sc);
    ty -= 7 * sc;
  }
  if (st) {
    callout(out, [x0 + b - c - sd / 2, y0 + h / 2], [x0 + b + 8 * sc, Math.min(ty, y0 + h * 0.3)], `Ø${st.d}a${st.spacing}`, st.mark, sc);
  }
  dim(out, [x0, y0], [x0 + b, y0], -7 * sc, sc, 'horizontal');
  dim(out, [x0, y0], [x0, y0 + h], 7 * sc, sc, 'vertical');
  if (p.title !== false) title(out, p.title ?? `MẶT CẮT ${p.label ?? '1-1'}`, x0 + b / 2, y0 - 18 * sc, sc);
  const assumed = assumedOf(p, [['cover', 25], ...(p.stirrup === null ? [] : [['stirrup.d', 6], ['stirrup.spacing', 150]])]);
  if (!(p.groups || []).length) warnings.push('no bars: give groups [{face, d, n}]');
  return { entities: out, warnings, assumed, bars: placed.map((g) => ({ face: g.face, n: g.pts.length, d: g.g.d, mark: g.g.mark })) };
}

// ---------------------------------------------------------------- beam detail

/**
 * Beam along its spans. at = first axis at the beam soffit. spans: axis-to-axis lengths; support: column width.
 * bottom/top: continuous bars, extra_top: support bars over ratio x span each side, stirrup {d, end, mid, zone}.
 */
export function beamDetail(p) {
  const sc = num(p.scale ?? 25, 'scale', { positive: true });
  const [x0, y0] = pt(p.at ?? [0, 0], 'at');
  const spans = (p.spans || []).map((s, i) => num(s, `spans[${i}]`, { positive: true }));
  if (!spans.length) throw new PlanError('spans is required, e.g. [4000, 3500] (axis to axis, mm)');
  const b = num(p.b ?? 220, 'b', { positive: true }), h = num(p.h ?? 400, 'h', { positive: true });
  const w = num(p.support ?? 220, 'support', { positive: true });
  const c = num(p.cover ?? 25, 'cover', { min: 0 });
  const bot = bars(p.bottom ?? { d: 16, n: 2, mark: '1' }, 'bottom');
  const top = bars(p.top ?? { d: 14, n: 2, mark: '2' }, 'top');
  const ex = p.extra_top === null ? null : bars(p.extra_top ?? { d: 14, n: 1, mark: '3' }, 'extra_top');
  const ratio = num(p.extra_top?.ratio ?? 0.25, 'extra_top.ratio', { positive: true });
  const st = ties(p.stirrup ?? {}, 'stirrup', { d: 6, mark: '4' });
  const stEnd = st.end ?? 100, stMid = st.mid ?? 200;
  const sd = st.d;
  const axes = [x0];
  for (const s of spans) axes.push(axes[axes.length - 1] + s);
  const xs = axes[0] - w / 2, xe = axes[axes.length - 1] + w / 2;
  const out = [];
  const stub = 600;
  // Concrete: beam, column stubs above and below with break lines.
  out.push({ type: 'rectangle', from: P(xs, y0), to: P(xe, y0 + h), layer: SL.conc });
  const zig = (xa, xb, y) => {
    const m = (xa + xb) / 2;
    return { type: 'polyline', points: [P(xa - 50, y), P(m - 40, y), P(m - 15, y + 60), P(m + 15, y - 60), P(m + 40, y), P(xb + 50, y)], layer: SL.conc };
  };
  for (const ax of axes) {
    for (const [ya, yb] of [[y0 - stub, y0], [y0 + h, y0 + h + stub]]) {
      out.push({ type: 'line', from: P(ax - w / 2, ya), to: P(ax - w / 2, yb), layer: SL.conc });
      out.push({ type: 'line', from: P(ax + w / 2, ya), to: P(ax + w / 2, yb), layer: SL.conc });
    }
    out.push(zig(ax - w / 2, ax + w / 2, y0 - stub), zig(ax - w / 2, ax + w / 2, y0 + h + stub));
  }
  // Bars.
  const yB = y0 + c + sd + bot.d / 2;
  const yT = y0 + h - c - sd - top.d / 2;
  const hookB = Math.min(15 * bot.d, h - 2 * c - sd), hookT = Math.min(15 * top.d, h - 2 * c - sd);
  out.push({ type: 'polyline', points: [P(xs + c, yB + hookB), P(xs + c, yB), P(xe - c, yB), P(xe - c, yB + hookB)], layer: SL.bar });
  out.push({ type: 'polyline', points: [P(xs + c, yT - hookT), P(xs + c, yT), P(xe - c, yT), P(xe - c, yT - hookT)], layer: SL.bar });
  const schedule = [];
  const members = Math.round(num(p.count ?? 1, 'count', { min: 1 }));
  schedule.push({ mark: bot.mark, shape: 'U', d: bot.d, length: Math.round(xe - xs - 2 * c + 2 * hookB), n: bot.n, members });
  schedule.push({ mark: top.mark, shape: 'U', d: top.d, length: Math.round(xe - xs - 2 * c + 2 * hookT), n: top.n, members });
  const extras = [];
  if (ex) {
    const yE = yT - top.d / 2 - ex.d / 2 - 25;
    for (let i = 0; i < axes.length; i++) {
      const ll = i > 0 ? ratio * spans[i - 1] : null;
      const lr = i < spans.length ? ratio * spans[i] : null;
      const xa = ll === null ? xs + c : axes[i] - ll;
      const xb = lr === null ? xe - c : axes[i] + lr;
      const pts = [];
      if (ll === null) pts.push(P(xa, yE - hookT));
      pts.push(P(xa, yE), P(xb, yE));
      if (lr === null) pts.push(P(xb, yE - hookT));
      out.push({ type: 'polyline', points: pts, layer: SL.bar });
      const end = ll === null || lr === null;
      const length = Math.round(xb - xa + (end ? hookT : 0));
      // A different bar gets its own mark: L bars at the end supports keep the mark, straight bars over inner supports take mark'.
      const mark = end || !ex.mark ? ex.mark : `${ex.mark}'`;
      extras.push({ xa, xb, y: yE, mark });
      const same = schedule.find((r) => r.mark === mark && r.length === length);
      if (same) same.n += ex.n;
      else schedule.push({ mark, shape: end ? 'L' : '—', d: ex.d, length, n: ex.n, members });
    }
  }
  // Stirrups: dense near the supports, wider at mid-span.
  let nStir = 0;
  const notes = [];
  for (let i = 0; i < spans.length; i++) {
    const a = axes[i] + w / 2, e = axes[i + 1] - w / 2;
    const zone = (e - a) * st.zone;
    const xsList = [];
    for (let x = a + 50; x <= a + zone + 1e-6; x += stEnd) xsList.push(x);
    let last = xsList[xsList.length - 1] ?? a + 50;
    for (let x = last + stMid; x < e - zone - 1e-6; x += stMid) { xsList.push(x); last = x; }
    const right = [];
    for (let x = e - 50; x >= e - zone - 1e-6; x -= stEnd) right.push(x);
    xsList.push(...right.reverse().filter((x) => x > last + stMid / 2));
    for (const x of xsList) out.push({ type: 'line', from: P(x, y0 + c), to: P(x, y0 + h - c), layer: SL.tie });
    nStir += xsList.length;
    notes.push({ x: a + zone / 2, t: `Ø${sd}a${stEnd}` }, { x: (a + e) / 2, t: `Ø${sd}a${stMid}` }, { x: e - zone / 2, t: `Ø${sd}a${stEnd}` });
  }
  // Stirrup zone notes above the section marks (which reach 6 x scale above the beam).
  for (const n of notes) out.push({ type: 'text', text: n.t, at: P(n.x, y0 + h + 8 * sc), height: 2.5 * sc, align: 'bottom_center', layer: SL.text, style: TEXT_STYLE });
  const stirLen = Math.round(2 * (b - 2 * c) + 2 * (h - 2 * c) + 2 * Math.max(6 * sd, 75));
  schedule.push({ mark: st.mark, shape: 'đai', d: sd, length: stirLen, n: nStir, members });
  // Axes, span dimensions, bubbles.
  const yAx = y0 - stub - 4 * sc;
  for (const [i, ax] of axes.entries()) {
    out.push({ type: 'line', from: P(ax, y0 + h + stub + 3 * sc), to: P(ax, yAx - 9 * sc), layer: SL.grid, scale_linetype: true });
    out.push(sym('MCP_TRUC', [ax, yAx - 13.5 * sc], { scale: sc, attrs: { SO: String(p.axes?.[i] ?? i + 1) }, layer: SL.gridTag, half: [4.5, 4.5] }));
  }
  out.push({ type: 'dim_chain', points: axes.map((x) => P(x, y0 - stub)), direction: 'horizontal', at: P(axes[0], yAx), total: axes.length > 2, style: dimStyleName(sc), layer: SL.dims });
  // Callouts: bottom bar under the first span, top and support bars above.
  const m0 = (axes[0] + axes[1]) / 2;
  callout(out, [m0 + spans[0] * 0.1, yB], [m0 + spans[0] * 0.1 + 6 * sc, y0 - 9 * sc], label(bot.n, bot.d), bot.mark, sc);
  callout(out, [m0 - spans[0] * 0.05, yT], [m0 - spans[0] * 0.05 + 6 * sc, y0 + h + 15 * sc], label(top.n, top.d), top.mark, sc);
  if (ex && extras.length) {
    const e0 = extras[Math.min(1, extras.length - 1)];
    callout(out, [e0.xa + 3 * sc, e0.y], [e0.xa + 3 * sc - 4 * sc, y0 + h + 21 * sc], label(ex.n, ex.d), e0.mark, sc, -1);
  }
  // Section marks and the two cross-sections below.
  const s1 = axes[0] + w / 2 + Math.min(spans[0] * 0.12, 600);
  const s2 = m0;
  for (const [x, t] of [[s1, '1'], [s2, '2']]) {
    for (const [ya, yb] of [[y0 - 1.5 * sc, y0 - 6 * sc], [y0 + h + 1.5 * sc, y0 + h + 6 * sc]]) {
      out.push({ type: 'polyline', points: [P(x, ya), P(x, yb)], width: 0.6 * sc, layer: SL.symb });
    }
    out.push({ type: 'text', text: t, at: P(x + 1.5 * sc, y0 - 6 * sc), height: 3 * sc, layer: SL.symb, style: TEXT_STYLE });
    out.push({ type: 'text', text: t, at: P(x + 1.5 * sc, y0 + h + 4 * sc), height: 3 * sc, layer: SL.symb, style: TEXT_STYLE });
  }
  const ySec = yAx - 30 * sc - h;
  const fits = (n, d) => n === 1 || (b - 2 * c - 2 * sd - d) / (n - 1) - d >= Math.max(d, 25);
  const top1 = ex && fits(top.n + ex.n, Math.max(top.d, ex.d))
    ? [{ face: 'top', d: Math.max(top.d, ex.d), n: top.n + ex.n, mark: `${top.mark}+${ex.mark}` }]
    : [{ face: 'top', ...top }, ...(ex ? [{ face: 'top2', ...ex }] : [])];
  const sec1 = rcSection({ at: [axes[0], ySec], b, h, cover: c, stirrup: { ...st, spacing: stEnd }, scale: sc, label: '1-1', groups: [...top1, { face: 'bottom', ...bot }] });
  const sec2 = rcSection({ at: [axes[0] + b + 45 * sc, ySec], b, h, cover: c, stirrup: { ...st, spacing: stMid }, scale: sc, label: '2-2', groups: [{ face: 'top', ...top }, { face: 'bottom', ...bot }] });
  out.push(...sec1.entities, ...sec2.entities);
  title(out, `${p.name ?? 'DẦM'} (${b}x${h})`, (xs + xe) / 2, ySec - 30 * sc, sc);
  const assumed = assumedOf(p, [
    ['b', 220], ['h', 400], ['support', 220], ['cover', 25],
    ...barDefaults(p, 'bottom', '2Ø16'), ...barDefaults(p, 'top', '2Ø14'), ...barDefaults(p, 'extra_top', '1Ø14'),
    ...(p.extra_top === null ? [] : [['extra_top.ratio', 0.25]]),
    ['stirrup.d', 6], ['stirrup.end', 100], ['stirrup.mid', 200], ['stirrup.zone', 0.25],
  ]);
  return { entities: out, schedule, warnings: [...sec1.warnings, ...sec2.warnings], assumed, stirrups: nStir };
}

// ---------------------------------------------------------------- pad footing

/**
 * Pad footing section. at = centre of the footing bottom (top of the lean concrete). B: width in the section,
 * L: the other side (default B), H: thickness at the column, edge: thickness at the edge (sloped when < H),
 * depth: footing bottom below ±0.000, ground: ground level, column {b, bars {d, n}, ties {d, spacing}}, mesh {d, spacing}.
 */
export function footingDetail(p) {
  const sc = num(p.scale ?? 25, 'scale', { positive: true });
  const [cx, yb] = pt(p.at ?? [0, 0], 'at');
  const B = num(p.B ?? 1200, 'B', { positive: true });
  const Lw = num(p.L ?? B, 'L', { positive: true });
  const H = num(p.H ?? 400, 'H', { positive: true });
  const edge = num(p.edge ?? H, 'edge', { positive: true });
  const c = num(p.cover ?? 50, 'cover', { min: 0 });
  const lean = num(p.lean ?? 100, 'lean', { min: 0 });
  const depth = num(p.depth ?? 1500, 'depth', { positive: true });
  const ground = num(p.ground ?? -450, 'ground');
  const cb = num(p.column?.b ?? 220, 'column.b', { positive: true });
  const ccov = num(p.column?.cover ?? 25, 'column.cover', { min: 0 });
  const colBars = bars(p.column?.bars ?? { d: 16, n: 4, mark: '2' }, 'column.bars');
  const colTies = ties(p.column?.ties ?? {}, 'column.ties', { d: 6, spacing: 200, mark: '3' });
  const mesh = bars({ d: p.mesh?.d ?? 12, n: 1, mark: p.mesh?.mark ?? '1' }, 'mesh');
  const s = num(p.mesh?.spacing ?? 150, 'mesh.spacing', { positive: true });
  const Y = (lvl) => yb + (lvl + depth); // drawing y of a level (mm relative to ±0.000)
  const yTop = yb + H;
  const stubTop = Y(p.column?.top ?? 0);
  if (stubTop <= yTop) throw new PlanError('column.top must be above the footing top');
  const out = [];
  // Lean concrete, footing (sloped if edge < H), column stub with a break line.
  if (lean > 0) {
    const lp = [P(cx - B / 2 - 100, yb - lean), P(cx + B / 2 + 100, yb - lean), P(cx + B / 2 + 100, yb), P(cx - B / 2 - 100, yb)];
    out.push({ type: 'polyline', points: lp, closed: true, layer: SL.conc });
    out.push({ type: 'hatch', boundary: lp, pattern: 'AR-CONC', scale: 0.04 * sc, layer: SL.concHatch });
  }
  const f = edge < H
    ? [P(cx - B / 2, yb), P(cx + B / 2, yb), P(cx + B / 2, yb + edge), P(cx + cb / 2 + 50, yTop), P(cx - cb / 2 - 50, yTop), P(cx - B / 2, yb + edge)]
    : [P(cx - B / 2, yb), P(cx + B / 2, yb), P(cx + B / 2, yTop), P(cx - B / 2, yTop)];
  out.push({ type: 'polyline', points: f, closed: true, layer: SL.conc });
  out.push({ type: 'line', from: P(cx - cb / 2, yTop), to: P(cx - cb / 2, stubTop), layer: SL.conc });
  out.push({ type: 'line', from: P(cx + cb / 2, yTop), to: P(cx + cb / 2, stubTop), layer: SL.conc });
  out.push({ type: 'polyline', points: [P(cx - cb / 2 - 50, stubTop), P(cx - 40, stubTop), P(cx - 15, stubTop + 60), P(cx + 15, stubTop - 60), P(cx + 40, stubTop), P(cx + cb / 2 + 50, stubTop)], layer: SL.conc });
  // Bottom mesh: bars in the section plane (with upturned ends) and the perpendicular bars as dots above them.
  const up = Math.max(Math.min(10 * mesh.d, edge - 2 * c), 0);
  const ym = yb + c + mesh.d / 2;
  out.push({ type: 'polyline', points: [P(cx - B / 2 + c, ym + up), P(cx - B / 2 + c, ym), P(cx + B / 2 - c, ym), P(cx + B / 2 - c, ym + up)], layer: SL.bar });
  const nAcross = Math.floor((B - 2 * c) / s) + 1;
  const nAlong = Math.floor((Lw - 2 * c) / s) + 1;
  const ydot = ym + mesh.d;
  for (let k = 0; k < nAcross; k++) {
    const x = cx - B / 2 + c + mesh.d + ((B - 2 * c - 2 * mesh.d) * k) / Math.max(1, nAcross - 1);
    out.push({ type: 'circle', center: P(x, ydot), radius: mesh.d / 2, layer: SL.bar });
    out.push({ type: 'hatch', boundary: Array.from({ length: 10 }, (_, j) => P(x + (mesh.d / 2) * Math.cos((j * Math.PI) / 5), ydot + (mesh.d / 2) * Math.sin((j * Math.PI) / 5))), pattern: 'SOLID', layer: SL.bar });
  }
  // Column bars with L legs resting on the mesh, ties in the stub and two inside the footing.
  const xc = cb / 2 - ccov - colTies.d - colBars.d / 2;
  const yLeg = ydot + mesh.d / 2 + colBars.d / 2;
  const leg = Math.max(15 * colBars.d, 200);
  for (const sgn of [-1, 1]) {
    out.push({ type: 'polyline', points: [P(cx + sgn * xc, stubTop + 3 * sc), P(cx + sgn * xc, yLeg), P(cx + sgn * (xc + leg), yLeg)], layer: SL.bar });
  }
  const tieYs = [yb + H - 100, yb + H / 2];
  for (let y = yTop + 50; y < stubTop - 20; y += colTies.spacing) tieYs.push(y);
  for (const y of tieYs) out.push({ type: 'line', from: P(cx - cb / 2 + ccov, y), to: P(cx + cb / 2 - ccov, y), layer: SL.tie });
  // Ground line, levels, dimensions, callouts, title.
  const yg = Y(ground);
  out.push({ type: 'line', from: P(cx - B / 2 - 600, yg), to: P(cx - cb / 2, yg), layer: SL.ground });
  out.push({ type: 'line', from: P(cx + cb / 2, yg), to: P(cx + B / 2 + 600, yg), layer: SL.ground });
  for (const [lv, y] of [[-depth, yb], [-depth + H, yTop], [ground, yg], [p.column?.top ?? 0, stubTop]]) {
    const xl = cx + B / 2 + 14 * sc;
    const t = 3 * sc;
    out.push({ type: 'polyline', points: [P(xl, y), P(xl - t / 2, y + t * 0.85), P(xl + t / 2, y + t * 0.85)], closed: true, layer: SL.symb });
    out.push({ type: 'line', from: P(xl - t / 2, y + t * 0.85), to: P(xl + t * 4, y + t * 0.85), layer: SL.symb });
    out.push({ type: 'text', text: Math.abs(lv) < 0.5 ? '±0.000' : `${lv > 0 ? '+' : '-'}${(Math.abs(lv) / 1000).toFixed(3)}`, at: P(xl + t * 0.7, y + t * 1.1), height: 2.5 * sc, layer: SL.symb, style: TEXT_STYLE });
  }
  dim(out, [cx - B / 2, yb], [cx + B / 2, yb], -(lean + 7 * sc), sc, 'horizontal');
  dim(out, [cx - cb / 2, stubTop], [cx + cb / 2, stubTop], 7 * sc, sc, 'horizontal');
  dim(out, [cx - B / 2, yb], [cx - B / 2, yTop], 8 * sc, sc, 'vertical');
  if (edge < H) dim(out, [cx - B / 2, yb], [cx - B / 2, yb + edge], 16 * sc, sc, 'vertical');
  callout(out, [cx + B / 4, ym], [cx + B / 4 + 5 * sc, yb - lean - 16 * sc], `Ø${mesh.d}a${s}`, mesh.mark, sc);
  callout(out, [cx + xc, (yTop + stubTop) / 2], [cx + cb / 2 + 10 * sc, (yTop + stubTop) / 2 + 6 * sc], label(colBars.n, colBars.d), colBars.mark, sc);
  callout(out, [cx - cb / 2 + ccov + 10, tieYs[tieYs.length - 1]], [cx - cb / 2 - 10 * sc, tieYs[tieYs.length - 1] + 6 * sc], `Ø${colTies.d}a${colTies.spacing}`, colTies.mark, sc, -1);
  title(out, `${p.name ?? 'MÓNG'} (${B}x${Lw})`, cx, yb - lean - 32 * sc, sc);
  const members = Math.round(num(p.count ?? 1, 'count', { min: 1 }));
  const schedule = [
    { mark: mesh.mark, shape: 'U', d: mesh.d, length: Math.round(B - 2 * c + 2 * up), n: nAlong, members },
    { mark: `${mesh.mark}'`, shape: 'U', d: mesh.d, length: Math.round(Lw - 2 * c + 2 * up), n: nAcross, members },
    { mark: colBars.mark, shape: 'L', d: colBars.d, length: Math.round(stubTop - yLeg + 3 * sc + leg), n: colBars.n, members },
    { mark: colTies.mark, shape: 'đai', d: colTies.d, length: Math.round(4 * (cb - 2 * ccov) + 2 * Math.max(6 * colTies.d, 75)), n: tieYs.length, members },
  ];
  const assumed = assumedOf(p, [
    ['B', 1200], ['L', 'B'], ['H', 400], ['edge', 'H (flat top)'], ['cover', 50], ['lean', 100], ['depth', 1500], ['ground', -450],
    ['column.b', 220], ['column.cover', 25], ['column.bars', '4Ø16'], ['column.ties.d', 6], ['column.ties.spacing', 200],
    ['mesh.d', 12], ['mesh.spacing', 150],
  ]);
  return { entities: out, schedule, assumed };
}

// ---------------------------------------------------------------- bar schedule

const HEAD = {
  vi: ['SỐ HIỆU', 'HÌNH DẠNG', 'Ø (mm)', 'DÀI 1 THANH (mm)', 'SỐ THANH/CK', 'SỐ CK', 'TỔNG SỐ THANH', 'TỔNG DÀI (m)', 'KHỐI LƯỢNG (kg)'],
  en: ['MARK', 'SHAPE', 'Ø (mm)', 'BAR LENGTH (mm)', 'BARS/MEMBER', 'MEMBERS', 'TOTAL BARS', 'TOTAL LENGTH (m)', 'WEIGHT (kg)'],
};

/** Bar schedule rows with totals: per row, per diameter and overall. */
export function rebarSchedule(rows, lang = 'vi') {
  const out = (rows || []).map((r, i) => {
    const d = num(r.d, `rows[${i}].d`, { positive: true });
    const length = num(r.length, `rows[${i}].length`, { positive: true });
    const n = Math.round(num(r.n, `rows[${i}].n`, { min: 0 }));
    const members = Math.round(num(r.members ?? 1, `rows[${i}].members`, { min: 1 }));
    const total = n * members;
    const totalLength = (total * length) / 1000;
    return { mark: String(r.mark ?? i + 1), shape: r.shape ?? '', d, length, n, members, total, total_length_m: r2(totalLength), weight_kg: r2(totalLength * kgPerM(d)) };
  });
  const byD = {};
  for (const r of out) byD[r.d] = r2((byD[r.d] ?? 0) + r.weight_kg);
  const totalKg = r2(out.reduce((s, r) => s + r.weight_kg, 0));
  const T = lang === 'en' ? { total: 'TOTAL', d: 'Ø' } : { total: 'TỔNG CỘNG', d: 'Ø' };
  const table = [HEAD[lang] ?? HEAD.vi, ...out.map((r) => [r.mark, r.shape, r.d, r.length, r.n, r.members, r.total, r.total_length_m, r.weight_kg])];
  for (const [d, kg] of Object.entries(byD).sort((a, b) => Number(a[0]) - Number(b[0]))) table.push([`${T.d}${d}`, '', '', '', '', '', '', '', kg]);
  table.push([T.total, '', '', '', '', '', '', '', totalKg]);
  // drawn: the same with formulas; row k of the list is table row k + 2 (title, header). Columns: A mark, B shape,
  // C d, D length, E n, F members, G bars, H length m, I weight kg (d²/162 kg/m)
  const R = (i) => i + 3;
  const F = (e, dec) => ({ field: FIELD.formula(e, lang, dec) });
  const drawn = [HEAD[lang] ?? HEAD.vi, ...out.map((r, i) => [
    r.mark, r.shape, r.d, r.length, r.n, r.members, F(`E${R(i)}*F${R(i)}`, 0), F(`G${R(i)}*D${R(i)}/1000`, 2), F(`H${R(i)}*C${R(i)}*C${R(i)}/162`, 2),
  ])];
  for (const [d] of Object.entries(byD).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const cells = out.map((r, i) => (String(r.d) === d ? `I${R(i)}` : null)).filter(Boolean);
    drawn.push([`${T.d}${d}`, '', '', '', '', '', '', '', F(cells.join('+'), 2)]);
  }
  drawn.push([T.total, '', '', '', '', '', '', '', F(`Sum(I${R(0)}:I${R(out.length - 1)})`, 2)]);
  return { rows: out, by_diameter_kg: byD, total_kg: totalKg, table, drawn };
}
