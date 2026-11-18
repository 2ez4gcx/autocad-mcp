// Cross-checks: what is read from an image before it is drawn (the scale against several printed dimensions, dimension
// chains), and a bill of quantities against another one of the same building (a SketchUp takeoff, a surveyor's sheet).
import { PlanError } from './plan.mjs';

/**
 * The scale of an image from several known dimensions (least squares through the origin), how far each is off, the
 * scales along X and along Y apart (a stretched image), and the arithmetic of printed dimension chains.
 */
export function scaleCheck(calibrate, chains) {
  const out = { units_per_pixel: null, report: null, chains: null, warnings: [] };
  if (Array.isArray(calibrate) && calibrate.length) {
    const ms = calibrate.map((c, i) => {
      const [a, b] = [c.p1, c.p2];
      if (!Array.isArray(a) || !Array.isArray(b) || !(c.distance > 0)) throw new PlanError(`calibrate[${i}] needs p1, p2 (pixels) and distance`);
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 2) throw new PlanError(`calibrate[${i}]: p1 and p2 are the same pixel`);
      return { L, d: Number(c.distance), horizontal: Math.abs(dx) >= Math.abs(dy), skew: Math.min(Math.abs(dx), Math.abs(dy)) / L };
    });
    const fit = (list) => (list.length ? list.reduce((s, m) => s + m.d * m.L, 0) / list.reduce((s, m) => s + m.L * m.L, 0) : null);
    const upp = fit(ms);
    const r4 = (v) => Math.round(v * 1e4) / 1e4;
    const each = ms.map((m) => ({ given: m.d, from_image: Math.round(m.L * upp * 10) / 10, off_percent: r4(((m.L * upp - m.d) / m.d) * 100), direction: m.skew > 0.2 ? 'oblique' : m.horizontal ? 'horizontal' : 'vertical' }));
    const ux = fit(ms.filter((m) => m.horizontal && m.skew <= 0.2)), uy = fit(ms.filter((m) => !m.horizontal && m.skew <= 0.2));
    const worst = Math.max(...each.map((e) => Math.abs(e.off_percent)));
    out.units_per_pixel = upp;
    out.report = { units_per_pixel: r4(upp), dimensions: each, worst_percent: r4(worst), ...(ux && uy ? { x_units_per_pixel: r4(ux), y_units_per_pixel: r4(uy), stretch_percent: r4((ux / uy - 1) * 100) } : {}) };
    if (ms.length === 1) out.warnings.push('one calibration dimension only: nothing to check the scale against; give a second one at right angles');
    else if (!(ux && uy)) out.warnings.push('the calibration dimensions all run the same way: give one horizontal and one vertical to see whether the image is stretched');
    if (ux && uy && Math.abs(ux / uy - 1) > 0.01) out.warnings.push(`the image is stretched: ${r4(Math.abs(ux / uy - 1) * 100)}% between its horizontal and vertical scales (a photo at an angle, or a scan that is not square): do not read coordinates from it, type the printed dimensions`);
    else if (worst > 1) out.warnings.push(`the calibration dimensions disagree by up to ${r4(worst)}%: check the pixels picked and the values read, or the image is distorted`);
  } else if (calibrate && !Array.isArray(calibrate)) out.warnings.push('one calibration dimension only: nothing to check the scale against; give calibrate as a list with a second dimension at right angles');
  if (Array.isArray(chains) && chains.length) {
    out.chains = chains.map((c, i) => {
      const parts = (c.parts || []).map(Number), sum = parts.reduce((s, v) => s + v, 0), total = Number(c.total);
      if (!parts.length || !Number.isFinite(sum) || !Number.isFinite(total)) throw new PlanError(`dimension_chains[${i}] needs parts (numbers) and total`);
      const ok = Math.abs(sum - total) <= Math.max(1, Math.abs(total) * 1e-4);
      if (!ok) out.warnings.push(`${c.name ?? `dimension_chains[${i}]`}: the parts add up to ${sum}, the total printed is ${total} (difference ${sum - total}): read the dimensions again before drawing`);
      return { ...(c.name ? { name: c.name } : {}), sum, total, ok };
    });
  }
  return out;
}


const CODE = /^\s*([A-Z]{2,3})\s*-\s*(\d{1,3})\b/;
const numOf = (v) => {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').trim().replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(t)) return NaN;
  // 1.234,56 and 1,234.56 and 12,5: the last separator is the decimal mark
  const k = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
  return Number(k < 0 ? t : `${t.slice(0, k).replace(/[.,]/g, '')}.${t.slice(k + 1)}`);
};

/** The rows of a CSV text (comma, semicolon or tab; quoted cells). */
export function csvRows(text) {
  const src = String(text).replace(/^\uFEFF/, '');
  const first = src.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const sep = [';', '\t', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/**
 * The quantities of another bill by code: rows [{code, qty}] (several rows of one code are summed), or a CSV whose rows
 * start a cell with a code (FL-01, "WL-02 Sơn trắng"...): the quantity is the column named qty_column (header text or
 * index from 0), else the last number of the row.
 */
export function otherBill({ rows = null, csv = null, qty_column = null } = {}) {
  const out = new Map();
  const put = (code, qty) => {
    const m = CODE.exec(String(code ?? '').toUpperCase());
    if (!m || !Number.isFinite(qty)) return;
    const k = `${m[1]}-${m[2].padStart(2, '0')}`;
    out.set(k, (out.get(k) ?? 0) + qty);
  };
  for (const r of rows || []) put(r.code ?? r.tag ?? r.name, numOf(r.qty ?? r.quantity ?? r.area ?? r.area_m2 ?? r.length ?? r.length_m ?? r.count));
  if (csv) {
    const R = csvRows(csv);
    let col = typeof qty_column === 'number' ? qty_column : null;
    if (typeof qty_column === 'string') {
      const h = R.find((r) => r.some((c) => String(c).trim().toLowerCase() === qty_column.trim().toLowerCase()));
      if (!h) throw new PlanError(`compare_with: no column named "${qty_column}" in the CSV`);
      col = h.findIndex((c) => String(c).trim().toLowerCase() === qty_column.trim().toLowerCase());
    }
    for (const r of R) {
      const code = r.find((c) => CODE.test(String(c).toUpperCase()));
      if (!code) continue;
      const qty = col !== null ? numOf(r[col]) : [...r].reverse().map(numOf).find((v) => Number.isFinite(v));
      put(code, qty ?? NaN);
    }
  }
  return out;
}

/**
 * Two bills of one building side by side: ours [{code, qty, unit, description}] and theirs (otherBill). Per code the
 * two quantities, the difference and its percentage of theirs, ok within tolerance (percent); the codes only one has.
 */
export function compareBills(ours, theirs, tolerance = 2) {
  const mine = new Map();
  for (const r of ours) {
    const m = CODE.exec(String(r.code ?? '').toUpperCase());
    if (!m) continue;
    const k = `${m[1]}-${m[2].padStart(2, '0')}`;
    const e = mine.get(k) ?? { qty: 0, unit: r.unit, description: r.description };
    e.qty += Number(r.qty) || 0;
    mine.set(k, e);
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const rows = [], onlyOurs = [], onlyTheirs = [];
  for (const [k, e] of mine) {
    if (!theirs.has(k)) { onlyOurs.push({ code: k, qty: r3(e.qty), unit: e.unit }); continue; }
    const t = theirs.get(k), d = e.qty - t;
    const pct = t !== 0 ? (d / t) * 100 : e.qty === 0 ? 0 : Infinity;
    rows.push({ code: k, description: e.description, unit: e.unit, ours: r3(e.qty), theirs: r3(t), difference: r3(d), percent: Number.isFinite(pct) ? Math.round(pct * 100) / 100 : null, ok: Math.abs(pct) <= tolerance });
  }
  for (const [k, t] of theirs) if (!mine.has(k)) onlyTheirs.push({ code: k, qty: r3(t) });
  rows.sort((a, b) => Math.abs(b.percent ?? 1e9) - Math.abs(a.percent ?? 1e9));
  return { tolerance_percent: tolerance, compared: rows.length, agree: rows.filter((r) => r.ok).length, rows, only_here: onlyOurs, only_there: onlyTheirs };
}
