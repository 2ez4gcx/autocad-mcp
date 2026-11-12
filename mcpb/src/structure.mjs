// Structural detail drawings (mm, at a detail scale such as 1:20 or 1:25): reinforced concrete cross-sections, beam
// details along their spans, pad footings, and the bar schedule with weights (d²/162 kg/m). Pure geometry: returns
// draw_entities specs. Sizes and reinforcement come from the user / the structural engineer: nothing is calculated
// here except lengths, counts and weights.
import { buildWalls, gridList, num, PlanError, pt } from './plan.mjs';
import { dimStyleName, FIELD, TEXT_STYLE, viewTitle } from './standards.mjs';
import { sym } from './symbols.mjs';
import { freePoint, inside } from './interior.mjs';
import { lintelRows } from './solids.mjs';

export const SL = {
  conc: 'S-CONC', concHatch: 'S-CONC-PATT', bar: 'S-REBR', tie: 'S-REBR-STIR', text: 'S-ANNO-TEXT', dims: 'S-ANNO-DIMS',
  symb: 'S-ANNO-SYMB', grid: 'S-GRID', gridTag: 'S-GRID-IDEN', ground: 'A-ELEV-OTLN', groundHatch: 'A-SECT-PATT',
  beam: 'S-BEAM', col: 'S-COLS', colHatch: 'S-COLS-PATT',
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
  out.push(...viewTitle(text, x, y, sc, SL.text, undefined, 4));
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
  const colTies = ties(p.column?.ties ?? {}, 'column.ties', { d: 6, spacing: 150, mark: '3' });
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
  title(out, `${p.language === 'en' ? 'FOOTING' : 'CHI TIẾT MÓNG'} ${p.name ?? p.label ?? 'M1'} (${B}x${Lw})`, cx, yb - lean - 32 * sc, sc);
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

// ---------------------------------------------------------------- framing plan (mặt bằng kết cấu dầm sàn)

const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul2 = (a, k) => [a[0] * k, a[1] * k];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];
const leftOf = (d) => [-d[1], d[0]];
const fmtLv = (mm) => (Math.abs(mm) < 0.5 ? '±0.000' : `${mm > 0 ? '+' : '-'}${(Math.abs(mm) / 1000).toFixed(3)}`);
const WET_ROOM = /(WC|VỆ SINH|TẮM|TOILET|BATH)/i;
const OUT_ROOM = /(BAN CÔNG|LÔ GIA|LOGIA|SÂN|BALCONY|TERRACE)/i;
const STAIR_ROOM = /(CẦU THANG|STAIR)/i;

/** Text along a direction, kept readable (never upside down). */
const readable = (d) => {
  let a = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
  if (a > 90.01) a -= 180;
  if (a <= -90.01) a += 180;
  return r2(a);
};

/**
 * Framing plan of one slab: beams along the load-bearing walls of the floor below (partitions under 150 mm stand on
 * the slab), columns at the wall nodes, the slab and its lowered parts (wet rooms, balconies), cantilever balconies,
 * stair openings, grids with their dimensions and the title. Sizes are preliminary (h = span / 12, rounded up to 50,
 * 300 to 700; b = wall thickness) unless given: column.sizes [{at, size, mark}] and foundation.sizes [{at, B, L, mark}]
 * take the sizes the calculation designed. A beam that ends on another beam with no column there rests on it (rests).
 * Returns {entities, beams, columns, footings, members, columnPoints, assumed}.
 */
export function framingPlan({ spec, level = 0, slab = 120, name = '', prefix = 'D', scale = 100, beam = {}, column = {}, rooms = {}, lang = 'vi', foundation = null, balconies = [], planted = [] }) {
  const sc = scale;
  const out = [], assumed = [];
  const walls = buildWalls(spec).filter((w) => w.t >= num(beam.min_wall ?? 150, 'beam.min_wall', { min: 0 }) && (spec.walls[w.index].height === undefined));
  const segs = walls.flatMap((w) => w.segs.map((s) => {
    const n = leftOf(s.d), c = (s.o1 + s.o2) / 2;
    return { s, A: add2(s.a, mul2(n, c)), B: add2(s.b, mul2(n, c)), t: s.t, d: s.d, L: s.L, n };
  }));
  if (!segs.length) throw new PlanError('no load-bearing walls under this slab (walls of 150 mm and more)');
  const tol = 30;
  const near3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol * 3;
  // the frame: a column at every grid intersection on a load-bearing wall, a beam along every grid line between two
  // columns where no wall runs (frame beams), as townhouse frames are built
  const gx0 = gridList(spec.grids?.x, 'x'), gy0 = gridList(spec.grids?.y, 'y');
  const onWall = (p) => segs.some((g) => {
    const v = sub2(p, g.A), u = dot2(v, g.d);
    return u > -tol && u < g.L + tol && Math.abs(cross2(g.d, v)) < g.t / 2 + tol;
  });
  const gridCols = column.at_grids === false ? [] : gx0.flatMap((x) => gy0.map((y) => [x.at, y.at])).filter(onWall);
  if (beam.frame !== false) {
    const covered = (a, b) => segs.some((g) => {
      const m = mul2(add2(a, b), 0.5), v = sub2(m, g.A), u = dot2(v, g.d);
      return Math.abs(cross2(g.d, sub2(b, a))) < 1e-6 * (1 + Math.hypot(...sub2(b, a))) && u > 0 && u < g.L && Math.abs(cross2(g.d, v)) < g.t / 2 + tol;
    });
    const lines = [...gx0.map((x) => gridCols.filter((c) => Math.abs(c[0] - x.at) < 1).sort((p, q) => p[1] - q[1])),
      ...gy0.map((y) => gridCols.filter((c) => Math.abs(c[1] - y.at) < 1).sort((p, q) => p[0] - q[0]))];
    for (const cs of lines) {
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i], b = cs[i + 1], L = Math.hypot(...sub2(b, a));
        if (L < 600 || covered(a, b)) continue;
        const d = mul2(sub2(b, a), 1 / L);
        segs.push({ A: a, B: b, t: 200, d, L, n: leftOf(d), frame: true });
      }
    }
  }
  // columns at the wall nodes (ends where two beams meet) and at the grid intersections on the walls
  const nodes = [];
  for (const g of segs) for (const p of [g.A, g.B]) {
    const k = nodes.findIndex((q) => near3(q.p, p));
    if (k < 0) nodes.push({ p, n: 1 });
    else nodes[k].n++;
  }
  const cols = nodes.filter((q) => q.n >= 2).map((q) => q.p);
  for (const c of gridCols) if (!cols.some((q) => near3(q, c))) cols.push(c);
  // supports along each beam: the columns on it and its two ends. An end with no column under it rests on the beam it
  // meets (beam on beam: that beam carries the reaction as a point load, its own span is not split there); an end
  // on nothing is a free end. Beams that only cross each other away from a column do not support each other.
  for (const g of segs) {
    const us = [];
    for (const c of cols) {
      const v = sub2(c, g.A), u = dot2(v, g.d);
      if (u > -3 * tol && u < g.L + 3 * tol && Math.abs(cross2(g.d, v)) < g.t / 2 + tol) us.push(Math.max(0, Math.min(g.L, u)));
    }
    g.rests = [];
    for (const [u, p] of [[0, g.A], [g.L, g.B]]) {
      if (us.some((x) => Math.abs(x - u) <= 100)) continue;
      const on = segs.findIndex((q) => {
        if (q === g || Math.abs(cross2(g.d, q.d)) < 0.1) return false;
        const w = sub2(p, q.A), uq = dot2(w, q.d);
        return uq > -tol && uq < q.L + tol && Math.abs(cross2(q.d, w)) < q.t / 2 + tol;
      });
      us.push(u);
      g.rests.push({ u, on });
    }
    us.sort((a, b) => a - b);
    g.supports = us.filter((u, i) => i === 0 || u - us[i - 1] > 100);
    g.spans = g.supports.slice(1).map((u, i) => u - g.supports[i]).filter((x) => x > 100);
    const Lmax = Math.max(...g.spans, 0);
    g.b = num(beam.b ?? Math.max(200, Math.round(g.t / 10) * 10), 'beam.b', { positive: true });
    g.h = num(beam.h ?? Math.min(700, Math.max(300, Math.ceil(Lmax / 12 / 50) * 50)), 'beam.h', { positive: true });
  }
  if (beam.h === undefined) assumed.push({ item: 'beam.h', value: 'span/12, 300-700', note: 'preliminary depth by span, rounded up to 50' });
  if (beam.b === undefined) assumed.push({ item: 'beam.b', value: 'wall thickness (min 200)', note: 'beams under the load-bearing walls' });
  // beam types: same size and spans, named from the deepest
  const types = new Map();
  for (const g of segs) {
    // the same beam read from either end is one type
    const sp = g.spans.map((x) => Math.round(x / 10) * 10), rv = [...sp].reverse();
    const key = `${g.b}x${g.h}|${(sp.join(',') <= rv.join(',') ? sp : rv).join(',')}`;
    if (!types.has(key)) types.set(key, { b: g.b, h: g.h, spans: g.spans.map((x) => Math.round(x)), count: 0, length: g.L, segs: [] });
    const t = types.get(key);
    t.count++;
    t.segs.push(g);
  }
  const beams = [...types.values()].sort((a, b) => b.h - a.h || b.length - a.length).map((t, i) => ({ ...t, name: `${prefix}${i + 1}` }));
  for (const t of beams) for (const g of t.segs) g.name = t.name;
  // beams: both faces (hidden: under the slab); their names go on later, clear of what is drawn
  for (const g of segs) {
    for (const k of [-0.5, 0.5]) out.push({ type: 'line', from: P(...add2(g.A, mul2(g.n, k * g.b))), to: P(...add2(g.B, mul2(g.n, k * g.b))), layer: SL.beam, scale_linetype: true });
  }
  // columns: the size given for each (column.sizes, from the calculation), else one preliminary size
  const csize = column.size ?? spec.grid_columns?.size ?? [220, 220];
  if (column.size === undefined && spec.grid_columns?.size === undefined && !column.sizes) assumed.push({ item: 'column.size', value: `${csize[0]}x${csize[1]}`, note: 'columns at the wall nodes' });
  const given = (column.sizes || []).map((s, i) => ({ at: pt(s.at, `column.sizes[${i}].at`), size: s.size ?? csize, mark: s.mark }));
  const colInfo = cols.map((c) => {
    const s = given.find((x) => near3(x.at, c));
    return { p: c, size: s?.size ?? csize, mark: s?.mark ?? null };
  });
  const sizeKeys = [...new Set(colInfo.map((c) => `${c.size[0]}x${c.size[1]}`))].sort((a, b) => {
    const [a0, a1] = a.split('x').map(Number), [b0, b1] = b.split('x').map(Number);
    return a0 * a1 - b0 * b1 || a0 - b0;
  });
  for (const c of colInfo) c.mark = c.mark ?? `C${sizeKeys.indexOf(`${c.size[0]}x${c.size[1]}`) + 1}`;
  const colBoxes = [];
  for (const c of colInfo) {
    const [cw, ch] = c.size;
    const r = [[c.p[0] - cw / 2, c.p[1] - ch / 2], [c.p[0] + cw / 2, c.p[1] - ch / 2], [c.p[0] + cw / 2, c.p[1] + ch / 2], [c.p[0] - cw / 2, c.p[1] + ch / 2]];
    out.push({ type: 'polyline', points: r.map((q) => P(...q)), closed: true, layer: SL.col });
    out.push({ type: 'hatch', boundary: r.map((q) => P(...q)), pattern: 'SOLID', layer: SL.colHatch });
    colBoxes.push([r[0][0], r[0][1], r[2][0], r[2][1]]);
  }
  const colMarks = [...new Set(colInfo.map((c) => c.mark))].sort();
  const columns = colMarks.map((mk) => {
    const list = colInfo.filter((c) => c.mark === mk);
    return { name: mk, size: `${list[0].size[0]}x${list[0].size[1]}`, count: list.length };
  });
  // columns of the storey above that stand on this slab's beams (planted): outlined, crossed, named
  const plantedPts = (planted || []).map((q, i) => (Array.isArray(q) ? { at: pt(q, `planted[${i}]`), size: csize } : { at: pt(q.at, `planted[${i}].at`), size: q.size ?? csize }))
    .filter((q) => !cols.some((c) => near3(c, q.at)));
  for (const q of plantedPts) {
    const [cw, ch] = q.size, [x, y] = q.at;
    out.push({ type: 'polyline', points: [P(x - cw / 2, y - ch / 2), P(x + cw / 2, y - ch / 2), P(x + cw / 2, y + ch / 2), P(x - cw / 2, y + ch / 2)], closed: true, layer: SL.col });
    out.push({ type: 'line', from: P(x - cw / 2, y - ch / 2), to: P(x + cw / 2, y + ch / 2), layer: SL.col }, { type: 'line', from: P(x - cw / 2, y + ch / 2), to: P(x + cw / 2, y - ch / 2), layer: SL.col });
    colBoxes.push([x - cw / 2, y - ch / 2, x + cw / 2, y + ch / 2]);
  }
  // the foundation plan: a pad footing under every column (hidden: below the ground beams), each with its mark
  let footings = [];
  const padBoxes = [], foundationNotes = [];
  if (foundation) {
    const fB = num(foundation.B ?? 1200, 'footing.B', { positive: true }), fL = num(foundation.L ?? foundation.B ?? 1200, 'footing.L', { positive: true });
    if (foundation.B === undefined && !foundation.sizes) assumed.push({ item: 'footing', value: `${fB}x${fL}`, note: 'pad footings M1 under the columns, bottom at the foundation depth' });
    const fGiven = (foundation.sizes || []).map((s, i) => ({ at: pt(s.at, `footing.sizes[${i}].at`), B: num(s.B, `footing.sizes[${i}].B`, { positive: true }), L: num(s.L ?? s.B, `footing.sizes[${i}].L`, { positive: true }), mark: s.mark }));
    const pads = cols.map((c) => {
      const s = fGiven.find((x) => near3(x.at, c));
      return { p: c, B: s?.B ?? fB, L: s?.L ?? fL, mark: s?.mark ?? null };
    });
    const padKeys = [...new Set(pads.map((q) => `${q.B}x${q.L}`))].sort((a, b) => {
      const [a0, a1] = a.split('x').map(Number), [b0, b1] = b.split('x').map(Number);
      return a0 * a1 - b0 * b1;
    });
    for (const q of pads) q.mark = q.mark ?? `M${padKeys.indexOf(`${q.B}x${q.L}`) + 1}`;
    for (const q of pads) {
      const c = q.p;
      const r = [[c[0] - q.B / 2, c[1] - q.L / 2], [c[0] + q.B / 2, c[1] - q.L / 2], [c[0] + q.B / 2, c[1] + q.L / 2], [c[0] - q.B / 2, c[1] + q.L / 2]];
      out.push({ type: 'polyline', points: r.map((v) => P(...v)), closed: true, layer: SL.beam, scale_linetype: true });
      out.push({ type: 'text', text: q.mark, at: P(c[0] + q.B / 2 - sc, c[1] + q.L / 2 - 3.2 * sc), height: r2(2 * sc), align: 'right', layer: SL.text, style: TEXT_STYLE });
      padBoxes.push([r[0][0], r[0][1], r[2][0], r[2][1]]);
    }
    const marks = [...new Set(pads.map((q) => q.mark))].sort();
    footings = marks.map((mk) => {
      const list = pads.filter((q) => q.mark === mk);
      return { name: mk, size: `${list[0].B}x${list[0].L}`, count: list.length, depth: foundation.depth };
    });
    // pads that take too much of the plan or run into each other: strip footings or a raft; pads on the outside walls
    const xs0 = cols.map((c) => c[0]), ys0 = cols.map((c) => c[1]);
    const footprint = ((Math.max(...xs0) - Math.min(...xs0) + 200) * (Math.max(...ys0) - Math.min(...ys0) + 200)) / 1e6;
    const total = pads.reduce((s, q) => s + (q.B * q.L) / 1e6, 0);
    const overlap = pads.some((a, i) => pads.some((b, j) => j > i && Math.abs(a.p[0] - b.p[0]) < (a.B + b.B) / 2 - 1 && Math.abs(a.p[1] - b.p[1]) < (a.L + b.L) / 2 - 1));
    const en = lang === 'en';
    if (overlap || total > 0.5 * footprint) {
      foundationNotes.push(en
        ? `THE PADS ${overlap ? 'OVERLAP' : ''}${overlap && total > 0.5 * footprint ? ' AND ' : ''}${total > 0.5 * footprint ? `TAKE ${Math.round((total / footprint) * 100)}% OF THE PLAN` : ''}: USE STRIP FOOTINGS OR A RAFT (THE ENGINEER DESIGNS THEM)`
        : `MÓNG ĐƠN ${overlap ? 'CHỒNG LÊN NHAU' : ''}${overlap && total > 0.5 * footprint ? ', ' : ''}${total > 0.5 * footprint ? `CHIẾM ${Math.round((total / footprint) * 100)}% DIỆN TÍCH NHÀ` : ''}: DÙNG MÓNG BĂNG HOẶC MÓNG BÈ (KỸ SƯ KẾT CẤU THIẾT KẾ)`);
    }
    const edge = pads.filter((q) => Math.abs(q.p[0] - Math.min(...xs0)) < 1 || Math.abs(q.p[0] - Math.max(...xs0)) < 1 || Math.abs(q.p[1] - Math.min(...ys0)) < 1 || Math.abs(q.p[1] - Math.max(...ys0)) < 1);
    if (edge.length) {
      foundationNotes.push(en ? 'PADS ON THE OUTSIDE WALLS ARE DRAWN CENTRED: ON A BOUNDARY THEY ARE ECCENTRIC OR STRIP FOOTINGS (THE ENGINEER DESIGNS THEM)'
        : 'MÓNG BIÊN VẼ ĐÚNG TÂM CỘT: SÁT RANH ĐẤT PHẢI LÀM MÓNG LỆCH TÂM HOẶC MÓNG BĂNG (KỸ SƯ KẾT CẤU THIẾT KẾ)');
    }
  }
  if (slab === undefined) assumed.push({ item: 'slab', value: 120 });
  const entries = Object.entries(rooms);
  const area = (poly) => Math.abs(poly.reduce((s2, p, i) => s2 + cross2(p, poly[(i + 1) % poly.length]), 0) / 2);
  const centre = (poly) => [poly.reduce((s2, p) => s2 + p[0], 0) / poly.length, poly.reduce((s2, p) => s2 + p[1], 0) / poly.length];
  const bboxOf = (poly) => [Math.min(...poly.map((p) => p[0])), Math.min(...poly.map((p) => p[1])), Math.max(...poly.map((p) => p[0])), Math.max(...poly.map((p) => p[1]))];
  const lowRoom = (n) => WET_ROOM.test(n) || OUT_ROOM.test(n);
  let lowered = 0;
  // the foundation plan has no slab openings or lowered slabs: the ground floor slab is drawn by the architect
  const stairBoxes = [], lowBoxes = [];
  // the stair openings: the wells of the stairs that come up from the floor below (a room named as the stair can be
  // larger: a tower with a landing at the head of the stair); a plan with no stair given: the rooms named as stairs
  const cross = ([x0, y0, x1, y1]) => {
    out.push({ type: 'line', from: P(x0, y0), to: P(x1, y1), layer: SL.conc }, { type: 'line', from: P(x0, y1), to: P(x1, y0), layer: SL.conc });
    stairBoxes.push([x0, y0, x1, y1]);
  };
  const wells = foundation ? [] : (spec.stairs || []).filter((st) => Array.isArray(st.region)).map((st) => bboxOf(st.region));
  wells.forEach(cross);
  for (const [n, poly] of foundation ? [] : entries) {
    if (STAIR_ROOM.test(n)) {
      if (!wells.length) cross(bboxOf(poly));
    } else if (lowRoom(n)) {
      out.push({ type: 'hatch', boundary: poly.map((p) => P(...p)), pattern: 'ANSI37', scale: r2(0.5 * sc), layer: SL.concHatch });
      lowBoxes.push(bboxOf(poly));
      lowered++;
    }
  }
  // cantilever balconies of this floor: the slab beyond the beams, lowered like the wet rooms
  const balBoxes = [];
  for (const [i, b] of (foundation ? [] : balconies || []).entries()) {
    if (!b?.region) continue;
    const p0 = pt(b.region[0], `balconies[${i}].region[0]`), p1 = pt(b.region[1], `balconies[${i}].region[1]`);
    const box = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
    const r = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map((q) => P(...q));
    out.push({ type: 'polyline', points: r, closed: true, layer: SL.conc });
    out.push({ type: 'hatch', boundary: r, pattern: 'ANSI37', scale: r2(0.5 * sc), layer: SL.concHatch });
    balBoxes.push(box);
    lowered++;
  }
  if (lowered) assumed.push({ item: 'lowered_slab', value: 50, note: 'wet rooms and balconies, mm below the floor slab' });
  // grids the beams reach: lines past the beams (and the balconies), bubbles at both ends, spacing and overall dimensions
  const xs = segs.flatMap((g) => [g.A[0], g.B[0]]), ys = segs.flatMap((g) => [g.A[1], g.B[1]]);
  const X0 = Math.min(...xs), X1 = Math.max(...xs), Y0 = Math.min(...ys), Y1 = Math.max(...ys);
  // the drawn extent: the pads and the balconies reach past the beam axes
  const reach = [...balBoxes, ...padBoxes];
  const EX0 = Math.min(X0, ...reach.map((b) => b[0])), EX1 = Math.max(X1, ...reach.map((b) => b[2]));
  const EY0 = Math.min(Y0, ...reach.map((b) => b[1])), EY1 = Math.max(Y1, ...reach.map((b) => b[3]));
  const gx = gridList(spec.grids?.x, 'x').filter((g) => g.at >= X0 - 300 && g.at <= X1 + 300);
  const gy = gridList(spec.grids?.y, 'y').filter((g) => g.at >= Y0 - 300 && g.at <= Y1 + 300);
  // the bubbles 20 mm off the plan: beyond the chain (8 mm), the overall dimension (16 mm) and its text
  const ext = 20 * sc, rB = 4.5 * sc;
  for (const g of gx) {
    out.push({ type: 'line', from: P(g.at, EY0 - ext), to: P(g.at, EY1 + ext), layer: SL.grid, scale_linetype: true });
    for (const y of [EY0 - ext - rB, EY1 + ext + rB]) out.push(sym('MCP_TRUC', [g.at, y], { scale: sc, attrs: { SO: String(g.label) }, layer: SL.gridTag, half: [4.5, 4.5] }));
  }
  for (const g of gy) {
    out.push({ type: 'line', from: P(EX0 - ext, g.at), to: P(EX1 + ext, g.at), layer: SL.grid, scale_linetype: true });
    for (const x of [EX0 - ext - rB, EX1 + ext + rB]) out.push(sym('MCP_TRUC', [x, g.at], { scale: sc, attrs: { SO: String(g.label) }, layer: SL.gridTag, half: [4.5, 4.5] }));
  }
  // the chains 8 mm off the plan, so that the overall dimension 8 mm beyond them stays clear of the bubbles; where fewer
  // than two grids cross the plan, the overall size between the beam axes instead
  const dimX = gx.length >= 2 ? gx.map((g) => g.at) : X1 - X0 > 600 ? [X0, X1] : null;
  const dimY = gy.length >= 2 ? gy.map((g) => g.at) : Y1 - Y0 > 600 ? [Y0, Y1] : null;
  if (dimX) out.push({ type: 'dim_chain', points: dimX.map((x) => P(x, EY0)), direction: 'horizontal', at: P(dimX[0], EY0 - 8 * sc), total: dimX.length > 2, style: dimStyleName(sc), layer: SL.dims });
  if (dimY) out.push({ type: 'dim_chain', points: dimY.map((y) => P(EX0, y)), direction: 'vertical', at: P(EX0 - 8 * sc, dimY[0]), total: dimY.length > 2, style: dimStyleName(sc), layer: SL.dims });
  // the labels last, each where it is clear of what is drawn (bubbles, marks) and of the labels before it
  const boxOf = (e) => {
    if (e.box) return e.box;
    if (e.type !== 'text') return null;
    const w = [...e.text].length * 0.72 * e.height, h = e.height * 1.4;
    const [bw, bh] = Math.abs(((e.rotation ?? 0) % 180) - 90) < 1 || Math.abs(((e.rotation ?? 0) % 180) + 90) < 1 ? [h, w] : [w, h];
    const x0 = /left/.test(e.align ?? 'left') ? e.at[0] : /right/.test(e.align) ? e.at[0] - bw : e.at[0] - bw / 2;
    const y0 = /middle/.test(e.align ?? '') ? e.at[1] - bh / 2 : e.at[1] - 0.2 * e.height;
    return [x0, y0, x0 + bw, y0 + bh];
  };
  const hit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const taken = out.map(boxOf).filter(Boolean);
  // what is drawn as lines (beam faces, pads, columns, stair diagonals, balcony edges, grid lines): a label is not put across them
  const drawn = [];
  for (const e of out) {
    if (e.type === 'line') drawn.push([e.from, e.to]);
    else if (e.type === 'polyline') e.points.forEach((q, i) => { if (i + 1 < e.points.length || e.closed) drawn.push([q, e.points[(i + 1) % e.points.length]]); });
  }
  const crossed = (b, m = 0.3 * sc) => {
    const [x0, y0, x1, y1] = [b[0] + m, b[1] + m, b[2] - m, b[3] - m];
    if (x1 <= x0 || y1 <= y0) return false;
    return drawn.some(([p, q]) => {
      let t0 = 0, t1 = 1;
      const dx = q[0] - p[0], dy = q[1] - p[1];
      for (const [u, v] of [[-dx, p[0] - x0], [dx, x1 - p[0]], [-dy, p[1] - y0], [dy, y1 - p[1]]]) {
        if (Math.abs(u) < 1e-12) { if (v < 0) return false; continue; }
        const r = v / u;
        if (u < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return t1 - t0 > 1e-9;
    });
  };
  // the dimension chains: their lines and numbers in a band beside the plan
  if (dimX) taken.push([EX0, EY0 - 19.5 * sc, EX1, EY0 - 5 * sc]);
  if (dimY) taken.push([EX0 - 19.5 * sc, EY0, EX0 - 5 * sc, EY1]);
  // a label on a hatched slab (a lowered slab, a balcony) stands on a mask: the hatch stops around it
  const hatched = [...lowBoxes, ...balBoxes];
  const text = (t, at, h, align = 'middle_center', rotation = 0) => {
    const e = { type: 'text', text: t, at: P(...at), height: r2(h), align, layer: SL.text, style: TEXT_STYLE, ...(rotation ? { rotation } : {}) };
    const b = boxOf(e);
    if (hatched.some((x) => hit(b, x))) {
      const m = 0.3 * h;
      out.push({ type: 'wipeout', points: [P(b[0] - m, b[1] - m), P(b[2] + m, b[1] - m), P(b[2] + m, b[3] + m), P(b[0] - m, b[3] + m)], layer: SL.text });
    }
    out.push(e);
    taken.push(b);
    return e;
  };
  // the column marks, at a free corner of the column: the most common mark once (at its lowest-left column: the
  // columns with no mark are of that one), every column of another mark; the sizes in the legend
  const labelAt = (c, t, h) => {
    const w = [...t].length * 0.72 * h;
    const tries = [];
    for (const k of [1.2, 3, 5, 8, 12]) {
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x0 = sx > 0 ? c.p[0] + c.size[0] / 2 + k * sc : c.p[0] - c.size[0] / 2 - k * sc - w;
        const y0 = sy > 0 ? c.p[1] + c.size[1] / 2 + k * sc : c.p[1] - c.size[1] / 2 - k * sc - 1.2 * h;
        tries.push({ box: [x0, y0 - 0.2 * h, x0 + w, y0 + 1.2 * h], at: [sx > 0 ? x0 : x0 + w, y0], al: sx > 0 ? 'left' : 'right' });
      }
    }
    const clear = (q) => !taken.some((o) => hit(q.box, o)) && !stairBoxes.some((o) => hit(q.box, o));
    const q = tries.find((x) => clear(x) && !crossed(x.box, 0)) ?? tries.find(clear) ?? tries[0];
    text(t, q.at, h, q.al);
  };
  const common = colMarks.map((mk) => colInfo.filter((c) => c.mark === mk)).sort((a, b) => b.length - a.length)[0] ?? [];
  if (common.length) labelAt(common.reduce((m, c) => (c.p[0] + c.p[1] < m.p[0] + m.p[1] ? c : m)), common[0].mark, 2 * sc);
  for (const c of colInfo) if (!common.includes(c)) labelAt(c, c.mark, 2 * sc);
  const legend = !columns.length ? null
    : `${lang === 'en' ? 'COLUMNS' : 'CỘT'}: ${columns.map((c) => `${c.name} (${c.size})`).join(', ')}${columns.length > 1 ? (lang === 'en' ? `; NOT MARKED: ${common[0].mark}` : `; CỘT KHÔNG GHI KÝ HIỆU: ${common[0].mark}`) : ''}`;
  // beam names along the beams: on the upper / left side at the middle when that is clear of the stair openings, the
  // pads, the columns and the other labels, else further along or on the other side; off the lowered slabs if it can
  const hard = [...stairBoxes, ...colBoxes];
  const soft = [...lowBoxes, ...balBoxes];
  for (const g of segs) {
    const t = `${g.name} (${g.b}x${g.h})`, h = 2.2 * sc;
    const w = [...t].length * 0.72 * h, hh = 1.4 * h;
    const rot = readable(g.d);
    const upright = Math.abs(Math.abs(rot) - 90) < 1;
    const first = g.n[1] < -1e-9 || (Math.abs(g.n[1]) < 1e-9 && g.n[0] > 0) ? mul2(g.n, -1) : g.n;
    const cands = [];
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88]) {
      for (const side of [first, mul2(first, -1)]) {
        const c = add2(add2(g.A, mul2(g.d, g.L * f)), mul2(side, g.b / 2 + 1.6 * sc));
        const box = upright ? [c[0] - hh / 2, c[1] - w / 2, c[0] + hh / 2, c[1] + w / 2]
          : Math.abs(rot) < 1 ? [c[0] - w / 2, c[1] - hh / 2, c[0] + w / 2, c[1] + hh / 2]
            : [c[0] - w / 2, c[1] - w / 2, c[0] + w / 2, c[1] + w / 2];
        cands.push({ c, box });
      }
    }
    const free = (q) => !hard.some((b) => hit(q.box, b)) && !taken.some((b) => hit(q.box, b));
    const q = cands.find((x) => free(x) && !crossed(x.box) && !soft.some((b) => hit(x.box, b))) ?? cands.find((x) => free(x) && !crossed(x.box)) ?? cands.find(free) ?? cands[0];
    text(t, q.c, h, 'middle_center', rot);
  }
  // the columns planted on a beam, named after the beams (a short name, clear of theirs)
  for (const q of plantedPts) labelAt({ p: q.at, size: q.size }, lang === 'en' ? 'PLANTED COLUMN' : 'CỘT CẤY', 1.8 * sc);
  // the most open point of a room (farthest from its edges, off the given boxes): where its label reads best
  const pole = (poly, avoid) => {
    const bx = poly.map((p) => p[0]), by = poly.map((p) => p[1]);
    const segDist = (q, a, b) => {
      const d = [b[0] - a[0], b[1] - a[1]], L2 = d[0] * d[0] + d[1] * d[1] || 1;
      const k = Math.max(0, Math.min(1, ((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1]) / L2));
      return Math.hypot(q[0] - a[0] - k * d[0], q[1] - a[1] - k * d[1]);
    };
    let best = null, bestD = -1;
    for (let x = Math.min(...bx) + 100; x < Math.max(...bx); x += 200) {
      for (let y = Math.min(...by) + 100; y < Math.max(...by); y += 200) {
        if (!inside([x, y], poly) || avoid.some((b) => x > b[0] && x < b[2] && y > b[1] && y < b[3])) continue;
        const d = Math.min(...poly.map((a, i) => segDist([x, y], a, poly[(i + 1) % poly.length])));
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
    }
    return best ?? centre(poly);
  };
  const inRoom = (t, poly, h, avoid = []) => {
    const w = [...t].length * 0.72 * h + h, hh = 1.8 * h;
    const p = freePoint(poly, [...taken, ...avoid], [w, hh], pole(poly, avoid), [], 100) ?? pole(poly, avoid);
    text(t, p, h);
  };
  // the stair opening's name between its diagonals (above the crossing, where they are apart), else beside it
  for (const b of stairBoxes) {
    const t = lang === 'en' ? 'STAIR OPENING' : 'Ô THANG', h = 2.2 * sc;
    const tw = [...t].length * 0.72 * h, bw = b[2] - b[0], bh = b[3] - b[1];
    const k = Math.min(0.4, Math.max(0.3, (tw / 2 + sc) / bw));
    const fits = tw / 2 + 0.5 * sc < k * bw && k * bh + h < bh / 2;
    text(t, fits ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2 + k * bh] : [(b[0] + b[2]) / 2, b[3] - 1.5 * h], h);
  }
  // the slab thickness in the largest room at the slab level; when every room is lowered, with the S2 label
  const rank = entries.filter(([n]) => !STAIR_ROOM.test(n)).sort((a, b) => area(b[1]) - area(a[1]));
  const main = rank.find(([n]) => !lowRoom(n)) ?? rank[0];
  const allLow = !!main && lowRoom(main[0]);
  const s2 = allLow ? (lang === 'en' ? `S2 - RC SLAB ${slab}, -50` : `S2 - SÀN BTCT DÀY ${slab}, HẠ 50`) : (lang === 'en' ? 'S2 - SLAB -50' : 'S2 - SÀN HẠ 50');
  for (const [n, poly] of foundation ? [] : entries) if (!STAIR_ROOM.test(n) && lowRoom(n)) inRoom(s2, poly, 2 * sc, stairBoxes);
  if (main && !foundation && !allLow) inRoom(`S1 - ${lang === 'en' ? 'RC SLAB' : 'SÀN BTCT DÀY'} ${slab}`, main[1], 2.5 * sc, stairBoxes);
  for (const b of balBoxes) {
    const poly = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    const long = lang === 'en' ? `BC - CANTILEVER BALCONY ${slab}, -50` : `BC - BAN CÔNG CÔNG XÔN DÀY ${slab}, HẠ 50`;
    const short = lang === 'en' ? 'BC - BALCONY -50' : 'BC - BAN CÔNG HẠ 50';
    const h = 2 * sc, wide = Math.max(b[2] - b[0], b[3] - b[1]);
    inRoom([...long].length * 0.72 * h + 2 * h < wide ? long : short, poly, h);
  }
  if (foundation) {
    // what the foundation plan shows, right of the plan beyond the grid bubbles
    const c = [EX1 + ext + 2 * rB + 8 * sc, EY1];
    const en = lang === 'en';
    const lines = [
      ...footings.map((f) => (en ? `PAD FOOTING ${f.name} ${f.size} (${f.count} No.)` : `MÓNG ĐƠN ${f.name} ${f.size} (SL ${f.count})`)),
      en ? `BOTTOM ${fmtLv(-(foundation.depth ?? 1500))}` : `ĐÁY MÓNG ${fmtLv(-(foundation.depth ?? 1500))}`,
      en ? 'GROUND BEAMS GM UNDER THE WALLS' : 'GIẰNG MÓNG GM DƯỚI TƯỜNG',
      ...(legend ? [legend] : []),
      ...foundationNotes,
    ];
    lines.forEach((l, i) => text(`${i + 1}. ${l}`, [c[0], c[1] - i * 4.5 * sc], 2.5 * sc, 'left'));
  }
  const t = foundation
    ? (lang === 'en' ? 'FOUNDATION PLAN' : 'MẶT BẰNG MÓNG, GIẰNG MÓNG')
    : lang === 'en' ? `STRUCTURAL PLAN - SLAB ${name} (${fmtLv(level)})` : `MẶT BẰNG KẾT CẤU SÀN ${name} (${fmtLv(level)})`;
  const ty = EY0 - ext - 2 * rB - 12 * sc;
  out.push(...viewTitle(t.replace(/\s+/g, ' ').trim(), (EX0 + EX1) / 2, ty, sc, SL.text, lang));
  if (legend && !foundation) out.push({ type: 'text', text: legend, at: P((EX0 + EX1) / 2, ty - 12 * sc), height: r2(2.5 * sc), align: 'center', layer: SL.text, style: TEXT_STYLE });
  return {
    entities: out, assumed,
    // the ground beams have no slab on them (the ground floor slab lies on the ground)
    beams: beams.map(({ segs: _s, ...b }) => ({ ...b, level, slab: foundation ? 0 : slab })),
    columns, footings, notes: foundationNotes,
    // for the structural calculation: every beam line with its supports, the ends that rest on another beam
    // (on: its index in members, -1: a free end) and the column points
    members: segs.map((g) => ({ name: g.name, A: g.A, B: g.B, d: g.d, L: g.L, b: g.b, h: g.h, supports: g.supports, frame: !!g.frame, rests: g.rests })),
    columnPoints: cols,
  };
}

// ---------------------------------------------------------------- beam schedule (bảng mặt cắt dầm)

/** Preliminary bars for drafting (the engineer designs them): bottom by depth, top 2Ø14, more at the supports. */
function draftBars(b, h) {
  const bd = h <= 300 ? 14 : h <= 400 ? 16 : 18;
  const n = b >= 250 ? 3 : 2;
  return {
    support: [{ face: 'bottom', d: bd, n }, { face: 'top', d: 14, n: n + 1 }],
    span: [{ face: 'bottom', d: bd, n: n + 1 }, { face: 'top', d: 14, n: 2 }],
  };
}

/**
 * Beam schedule: for every beam type its sections at the support (GỐI) and at midspan (NHỊP), with the slab flange,
 * the slab level and the bars, titled "DẦM D2.1 (220x400) - SL: 3". beams: [{name, b, h, count, level, slab,
 * bars?: {support: groups, span: groups}, stirrup?: {d, support, span}}]. Bars not given are preliminary (assumed).
 * Ground beams (slab: 0, or named GM...) carry no slab: no flange. The pitch of the sections and of the beams comes
 * from what each section really takes (level mark on its left, bar callouts on its right), so nothing overlaps.
 */
export function beamSchedule({ beams, scale = 25, cover = 25, perRow = 3, lang = 'vi', at = [0, 0] }) {
  const sc = scale;
  const out = [], assumed = [];
  if (!beams?.length) throw new PlanError('beam_schedule: no beams (draw the structural plans first, or give beams)');
  // a callout of rcSection: leader to 8 mm right of the section, its landing under the text, a circle per bar mark
  const landing = (t) => Math.max([...t].length * 2.5 * sc * 0.72 + 2 * sc, 8 * sc);
  const marks = (m) => String(m ?? '').split('+').filter(Boolean).length * 5 * sc;
  const items = beams.map((bm, i) => {
    const b = num(bm.b, `beams[${i}].b`, { positive: true }), h = num(bm.h, `beams[${i}].h`, { positive: true });
    const slab = num(bm.slab ?? 120, `beams[${i}].slab`, { min: 0 });
    const flange = slab > 0 && bm.flange !== false && !/^GM/i.test(String(bm.name ?? ''));
    const bars = bm.bars ?? draftBars(b, h);
    if (!bm.bars) assumed.push({ item: `${bm.name}.bars`, value: `${bars.support.map((g) => `${g.n}Ø${g.d}`).join(' + ')} / ${bars.span.map((g) => `${g.n}Ø${g.d}`).join(' + ')}`, note: 'preliminary, for drafting: the engineer designs them' });
    const st = bm.stirrup ?? { d: 6, support: 100, span: 200 };
    const right = (k, sp) => b + 8 * sc + Math.max(...bars[k].map((g) => landing(`${g.n}Ø${g.d}`) + marks(g.mark)), landing(`Ø${st.d}a${sp}`) + marks(st.mark));
    // the level mark: its point on the slab beside the web (on the beam top where there is no slab), its text to the left
    const level = bm.level !== undefined ? `FL${fmtLv(bm.level)}` : '';
    const tagX = flange ? -1.5 * sc : Math.min(b / 2, 1.5 * sc);
    // the flange stops short of the depth dimension (7 mm left of the web), whose text stands beside it
    const fl = flange ? Math.min(1.6 * b, 6 * sc) : 0;
    const left = Math.max(11.5 * sc, level ? 2.1 * sc - tagX + [...level].length * 0.72 * 2.5 * sc + sc : 0, fl);
    const title = `${lang === 'en' ? 'BEAM' : 'DẦM'} ${bm.name} (${b}x${h}) - SL: ${String(bm.count ?? 1).padStart(2, '0')}`;
    return { bm, b, h, slab, flange, fl, bars, st, level, tagX, left, r1: right('support', st.support), r2: right('span', st.span), title, titleW: [...title].length * 0.8 * 3.5 * sc };
  });
  const left = Math.max(...items.map((q) => q.left));
  // from the left face of the GỐI section to that of the NHỊP section, and the width a beam takes
  const dx2 = Math.max(...items.map((q) => q.r1)) + 3 * sc + left;
  const body = left + dx2 + Math.max(...items.map((q) => q.r2));
  const colW = Math.max(body, ...items.map((q) => q.titleW)) + 8 * sc;
  const rowH = Math.max(...items.map((q) => q.h)) + 75 * sc;
  items.forEach((q, i) => {
    const { b, h, slab, fl, bars, st } = q;
    const cx = at[0] + (i % perRow) * colW + (colW - 8 * sc) / 2, oy = at[1] - Math.floor(i / perRow) * rowH;
    const ox = cx - body / 2 + left;
    [['support', lang === 'en' ? 'SUPPORT' : 'GỐI', st.support], ['span', lang === 'en' ? 'MIDSPAN' : 'NHỊP', st.span]].forEach(([k, lbl, sp], j) => {
      const x0 = ox + j * dx2, y0 = oy;
      const r = rcSection({ b, h, cover, groups: bars[k], stirrup: { d: st.d, spacing: sp, mark: st.mark }, at: [x0, y0], scale: sc, title: false });
      out.push(...r.entities);
      out.push({ type: 'text', text: lbl, at: P(x0 + b / 2, y0 - 16 * sc), height: r2(3 * sc), align: 'center', layer: SL.text, style: TEXT_STYLE });
      if (q.flange) {
        // the slab on both sides of the web
        for (const [xa, xb] of [[x0 - fl, x0], [x0 + b, x0 + b + fl]]) {
          out.push({ type: 'line', from: P(xa, y0 + h), to: P(xb, y0 + h), layer: SL.conc }, { type: 'line', from: P(xa, y0 + h - slab), to: P(xb, y0 + h - slab), layer: SL.conc });
        }
        out.push({ type: 'line', from: P(x0 - fl, y0 + h - slab), to: P(x0 - fl, y0 + h), layer: SL.conc }, { type: 'line', from: P(x0 + b + fl, y0 + h - slab), to: P(x0 + b + fl, y0 + h), layer: SL.conc });
      }
      if (q.level) out.push(sym('MCP_COTE_TRAI', [x0 + q.tagX, y0 + h], { scale: sc, attrs: { COTE: q.level }, layer: SL.symb }));
    });
    const ty = oy - 30 * sc;
    out.push({ type: 'text', text: q.title, at: P(cx, ty), height: r2(3.5 * sc), align: 'center', layer: SL.text, style: TEXT_STYLE });
    out.push({ type: 'line', from: P(cx - q.titleW / 2, ty - 1.2 * sc), to: P(cx + q.titleW / 2, ty - 1.2 * sc), layer: SL.text });
  });
  const rows = Math.ceil(beams.length / perRow);
  out.push(...viewTitle(lang === 'en' ? 'BEAM SCHEDULE' : 'BẢNG MẶT CẮT DẦM', at[0] + (Math.min(perRow, beams.length) * colW - 8 * sc) / 2, at[1] - rows * rowH - 5 * sc, sc, SL.text, lang));
  // pitch: between the two sections of a beam and between beams; left / right: what one beam takes about the left
  // face of its GỐI section
  return { entities: out, assumed, pitch: { section: r2(dx2), beam: r2(colW), left: r2(left), right: r2(body - left) } };
}

// ---------------------------------------------------------------- structural general notes (ghi chú chung kết cấu)

/** Tables and notes of a structural set (TCVN 5574:2018 defaults; every value can be given). */
export function structureNotes({ at = [0, 0], scale = 50, lang = 'vi', concrete = {}, cover = {}, laps = {}, lintels = null, notes = null }) {
  const sc = scale, th = 2.5 * sc;
  const out = [], assumed = [];
  const en = lang === 'en', tr = (vi, e) => (en ? e : vi);
  const C = { main: concrete.main ?? 'B20 (M250)', minor: concrete.minor ?? 'B15 (M200)', lean: concrete.lean ?? 'B7,5 (M100)' };
  if (concrete.main === undefined) assumed.push({ item: 'concrete.main', value: C.main });
  const CV = {
    [tr('Móng (có bê tông lót)', 'Footings (on lean concrete)')]: cover.footing ?? 50, [tr('Dầm móng', 'Ground beams')]: cover.ground_beam ?? 30,
    [tr('Cột', 'Columns')]: cover.column ?? 25, [tr('Dầm', 'Beams')]: cover.beam ?? 25, [tr('Sàn, cầu thang', 'Slabs, stairs')]: cover.slab ?? 20,
    [tr('Lanh tô, bổ trụ', 'Lintels, wall posts')]: cover.lintel ?? 15,
  };
  if (cover.beam === undefined) assumed.push({ item: 'cover', value: Object.values(CV).join('/'), note: 'mm: footing, ground beam, column, beam, slab, lintel' });
  const kt = laps.anchor_tension ?? 30, kc = laps.anchor_compression ?? 20, lt = laps.lap_tension ?? 40, lc = laps.lap_compression ?? 30;
  if (laps.anchor_tension === undefined) assumed.push({ item: 'laps', value: `neo ${kt}d/${kc}d, nối ${lt}d/${lc}d`, note: 'tension/compression, rounded up to 50 mm' });
  const up50 = (v) => Math.ceil(v / 50) * 50;
  // the typical lintels: the table the bill measures its lintels by (solids.mjs LINTELS), one source for both
  const L = lintels ?? lintelRows(lang);
  if (!lintels) assumed.push({ item: 'lintels', value: 'by span 1200 / 2000 / 3000', note: 'typical lintels' });
  const tables = [
    { title: lang === 'en' ? 'MATERIALS' : 'VẬT LIỆU', widths: [60, 45, 75], rows: [
      [tr('CẤU KIỆN', 'MEMBER'), tr('VẬT LIỆU', 'MATERIAL'), tr('GHI CHÚ', 'NOTE')],
      [tr('Móng, dầm móng, cột, dầm, sàn, cầu thang', 'Footings, ground beams, columns, beams, slabs, stairs'), `${tr('Bê tông', 'Concrete')} ${C.main}`,
        tr('Đổ tại chỗ, đầm kỹ, bảo dưỡng ẩm ≥ 7 ngày', 'Cast in place, well vibrated, kept moist for 7 days or more')],
      [tr('Lanh tô, bổ trụ, giằng tường', 'Lintels, wall posts, wall ties'), `${tr('Bê tông', 'Concrete')} ${C.minor}`, ''],
      [tr('Bê tông lót móng', 'Lean concrete under the footings'), `${tr('Bê tông', 'Concrete')} ${C.lean}`, tr('Dày 100', '100 thick')],
      [tr('Thép Ø < 10', 'Bars Ø < 10'), concrete.steel_small ?? 'CB240-T', 'TCVN 1651-1:2018'], [tr('Thép Ø ≥ 10', 'Bars Ø ≥ 10'), concrete.steel_large ?? 'CB300-V', 'TCVN 1651-2:2018'],
    ] },
    { title: lang === 'en' ? 'CONCRETE COVER (mm)' : 'LỚP BÊ TÔNG BẢO VỆ (mm)', widths: [70, 30], rows: [[tr('CẤU KIỆN', 'MEMBER'), 'a (mm)'], ...Object.entries(CV).map(([k, v]) => [k, v])] },
    { title: lang === 'en' ? 'ANCHORAGE AND LAPS (mm)' : 'CHIỀU DÀI NEO VÀ NỐI CHỒNG (mm)', widths: [20, 30, 30, 30, 30], rows: [
      ['Ø', `${tr('NEO KÉO', 'ANCHOR, TENSION')} ${kt}d`, `${tr('NEO NÉN', 'ANCHOR, COMPR.')} ${kc}d`, `${tr('NỐI KÉO', 'LAP, TENSION')} ${lt}d`, `${tr('NỐI NÉN', 'LAP, COMPR.')} ${lc}d`],
      ...[10, 12, 14, 16, 18, 20, 22, 25].map((d) => [`Ø${d}`, up50(kt * d), up50(kc * d), up50(lt * d), up50(lc * d)]),
    ] },
    { title: lang === 'en' ? 'TYPICAL LINTELS' : 'LANH TÔ ĐIỂN HÌNH', widths: [40, 35, 25, 25, 25, 25], rows: [[tr('NHỊP Ô CỬA', 'OPENING SPAN'), tr('TIẾT DIỆN', 'SECTION'), tr('THÉP DƯỚI', 'BOTTOM BARS'), tr('THÉP TRÊN', 'TOP BARS'), tr('ĐAI', 'STIRRUPS'), tr('GỐI (mm)', 'BEARING (mm)')], ...L] },
  ];
  let y = at[1];
  out.push(...viewTitle(lang === 'en' ? 'STRUCTURAL GENERAL NOTES' : 'GHI CHÚ CHUNG KẾT CẤU', at[0] + 90 * sc, y, sc, SL.text, lang, 5, false));
  y -= 16 * sc;
  for (const t of tables) {
    out.push({ type: 'table', at: P(at[0], y), title: t.title, rows: t.rows, height: r2(th), row_height: r2(7 * sc), col_widths: t.widths.map((w) => r2(w * sc)), layer: SL.text, style: TEXT_STYLE });
    y -= (t.rows.length + 1) * 7 * sc + 10 * sc;
  }
  const N = notes ?? (en ? [
    'Dimensions in mm, levels in m; level ±0.000 is the finished floor of the ground floor.',
    'Designed to TCVN 2737:2023 (loads and actions) and TCVN 5574:2018 (reinforced concrete structures).',
    'Laps are staggered, no more than 50% of the bars lapped in one section; no laps of tension bars where the moment is large.',
    'Formwork of beams and slabs is struck when the concrete has 70% of its strength or more (spans to 8 m), 90% for cantilevers.',
    'Member sizes are those of the preliminary calculation: the structural engineer calculates and confirms them before construction.',
    'The contractor checks the dimensions on site and coordinates with the architectural, electrical and plumbing drawings before construction.',
  ] : [
    'Kích thước ghi bằng mm, cao độ ghi bằng m; cao độ ±0.000 là cao độ sàn hoàn thiện tầng 1.',
    'Thiết kế theo TCVN 2737:2023 (tải trọng và tác động), TCVN 5574:2018 (kết cấu bê tông cốt thép).',
    'Mối nối thép bố trí so le, không nối quá 50% số thanh tại một tiết diện; không nối thép chịu kéo tại vùng mô men lớn.',
    'Cốp pha dầm, sàn chỉ tháo khi bê tông đạt ≥ 70% cường độ (nhịp ≤ 8 m) và ≥ 90% với công xôn.',
    'Kích thước dầm, cột trên bản vẽ là sơ bộ theo nhịp: kỹ sư kết cấu tính toán, xác nhận trước khi thi công.',
    'Nhà thầu kiểm tra kích thước thực tế, phối hợp bản vẽ kiến trúc, điện, nước trước khi thi công.',
  ]);
  out.push({ type: 'text', text: lang === 'en' ? 'NOTES:' : 'GHI CHÚ:', at: P(at[0], y), height: r2(3 * sc), layer: SL.text, style: TEXT_STYLE });
  out.push({ type: 'mtext', text: N.map((l, i) => `${i + 1}. ${l}`).join('\n'), at: P(at[0], y - 5 * sc), height: r2(th), width: r2(180 * sc), layer: SL.text, style: TEXT_STYLE, line_spacing: 1.1 });
  return { entities: out, assumed };
}
