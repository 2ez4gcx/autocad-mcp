// Door and window schedule (bảng thống kê cửa đi, cửa sổ): every type of door and window of the building drawn in
// elevation with its sizes and opening direction, its count by floor, and the table of types. Pure geometry: returns
// draw_entities specs. Types come from the openings of the plan description (by tag, kind and size).
import { buildBuilding } from './elevation.mjs';
import { dimStyleName, ROLE, TEXT_STYLE, viewTitle } from './standards.mjs';
import { tagSym } from './symbols.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const P = (x, y) => [r2(x), r2(y)];
const KIND = {
  vi: { door: 'Cửa đi 1 cánh mở quay', double_door: 'Cửa đi 2 cánh mở quay', sliding: 'Cửa đi lùa 2 cánh', window: 'Cửa sổ mở quay' },
  en: { door: 'Single swing door', double_door: 'Double swing door', sliding: 'Two-panel sliding door', window: 'Casement window' },
};
const MATERIAL = {
  door: 'Cửa gỗ công nghiệp, khung bao gỗ, sơn PU, phụ kiện đồng bộ',
  double_door: 'Cửa nhôm hệ, kính cường lực 8 mm, phụ kiện đồng bộ',
  sliding: 'Cửa lùa nhôm hệ, kính cường lực 8 mm',
  window: 'Cửa sổ nhôm hệ, kính cường lực 6,38 mm, có song bảo vệ',
};

/**
 * The schedule: one elevation per type (frame, leaves, opening direction dashed: the lines meet on the hinge side,
 * glazing, width/height/sill dimensions, its tag and count), then the table (tag, kind, size, sill, count by floor,
 * description). materials: {tag: description} replaces the default description of a type (listed as assumed).
 */
export function doorSchedule({ spec, scale = 50, materials = {}, lang = 'vi', at = [0, 0] }) {
  const sc = scale;
  const out = [], assumed = [];
  const B = buildBuilding(spec);
  const types = new Map();
  for (const f of B) {
    for (const op of f.M.openings) {
      if (!['door', 'double_door', 'sliding', 'window'].includes(op.type)) continue;
      const w = Math.round(op.span.to - op.span.from), h = Math.round(op.head - op.sill);
      const tag = op.tag ?? `${op.type === 'window' ? 'S' : 'D'}-${w}x${h}`;
      const key = `${tag}|${op.type}|${w}x${h}`;
      const t = types.get(key) ?? { tag, type: op.type, w, h, sill: Math.round(op.sill), count: 0, floors: new Map() };
      t.count++;
      const fname = f.name ?? '';
      t.floors.set(fname, (t.floors.get(fname) ?? 0) + 1);
      types.set(key, t);
    }
  }
  const list = [...types.values()].sort((a, b) => (a.type === 'window') - (b.type === 'window') || String(a.tag).localeCompare(String(b.tag), 'vi', { numeric: true }));
  if (!list.length) return { entities: out, rows: [], assumed };
  const DIM = ROLE.dims, TXT = ROLE.text;
  const dashed = { scale_linetype: true }; // on the hidden layer: dashed by layer, no override
  const maxH = Math.max(...list.map((t) => t.h + (t.type === 'window' ? t.sill : 0)));
  const y0 = at[1];
  let x = at[0];
  for (const t of list) {
    const layer = t.type === 'window' ? ROLE.window : ROLE.door;
    const yb = y0 + (t.type === 'window' ? t.sill : 0);
    const { w, h } = t;
    const f = 50; // frame
    const rect = (x0, y1, x2, y3, lay = layer, extra = {}) => out.push({ type: 'rectangle', from: P(x0, y1), to: P(x2, y3), layer: lay, ...extra });
    const line = (a, b, lay = layer, extra = {}) => out.push({ type: 'line', from: P(...a), to: P(...b), layer: lay, ...extra });
    // the floor line under each type, the frame
    line([x - 300, y0], [x + w + 300, y0], ROLE.elevation_outline);
    rect(x, yb, x + w, yb + h);
    rect(x + f, yb + (t.type === 'window' ? f : 0), x + w - f, yb + h - f);
    const ix0 = x + f, ix1 = x + w - f, iy0 = yb + (t.type === 'window' ? f : 0), iy1 = yb + h - f;
    // leaves and how they open (the dashed lines meet on the hinge side)
    const swing = (a0, a1, hingeLeft) => {
      const hx = hingeLeft ? a0 : a1, fx = hingeLeft ? a1 : a0;
      line([fx, iy0], [hx, (iy0 + iy1) / 2], ROLE.hidden, dashed);
      line([fx, iy1], [hx, (iy0 + iy1) / 2], ROLE.hidden, dashed);
    };
    const glass = (a0, a1) => {
      // three short strokes: glazed
      for (const k of [0.3, 0.45, 0.6]) line([a0 + (a1 - a0) * k, iy0 + (iy1 - iy0) * (k + 0.15)], [a0 + (a1 - a0) * (k + 0.12), iy0 + (iy1 - iy0) * (k + 0.27)], layer);
    };
    if (t.type === 'door') {
      swing(ix0, ix1, true);
      out.push({ type: 'circle', center: P(ix1 - 80, (iy0 + iy1) / 2), radius: 25, layer });
    } else if (t.type === 'double_door') {
      const m = (ix0 + ix1) / 2;
      line([m, iy0], [m, iy1]);
      swing(ix0, m, true);
      swing(m, ix1, false);
      glass(ix0, m);
      glass(m, ix1);
    } else if (t.type === 'sliding') {
      const m = (ix0 + ix1) / 2;
      rect(ix0, iy0, m + 40, iy1);
      rect(m - 40, iy0, ix1, iy1);
      const ya = iy0 + (iy1 - iy0) * 0.45;
      line([m - 300, ya], [m - 60, ya]);
      line([m + 60, ya], [m + 300, ya]);
      glass(ix0, m);
      glass(m, ix1);
    } else {
      const n = w >= 900 ? 2 : 1;
      const step = (ix1 - ix0) / n;
      for (let k = 0; k < n; k++) {
        const a0 = ix0 + k * step, a1 = a0 + step;
        if (k) line([a0, iy0], [a0, iy1]);
        swing(a0, a1, n === 1 ? true : k === 0);
        glass(a0, a1);
      }
    }
    // dimensions: width under the floor line, height (and sill) on the right
    out.push({ type: 'dim_chain', points: [P(x, y0), P(x + w, y0)], direction: 'horizontal', at: P(x, y0 - 8 * sc), style: dimStyleName(sc), layer: DIM });
    const zs = t.type === 'window' ? [y0, yb, yb + h] : [yb, yb + h];
    out.push({ type: 'dim_chain', points: zs.map((z) => P(x + w, z)), direction: 'vertical', at: P(x + w + 8 * sc, y0), total: zs.length > 2, style: dimStyleName(sc), layer: DIM });
    // the tag over it with its count
    out.push(tagSym(t.tag, [x + w / 2, y0 + maxH + 10 * sc], sc, TXT, 'hex'));
    out.push({ type: 'text', text: `SL: ${String(t.count).padStart(2, '0')}`, at: P(x + w / 2, y0 + maxH + 4 * sc), height: r2(2.2 * sc), align: 'middle_center', layer: TXT, style: TEXT_STYLE });
    t.x = x;
    x += Math.max(w, 900) + 24 * sc;
  }
  // the table of types
  const K = KIND[lang] ?? KIND.vi;
  const head = lang === 'en' ? ['TAG', 'KIND', 'SIZE W x H', 'SILL', 'COUNT', 'WHERE', 'DESCRIPTION'] : ['KÝ HIỆU', 'LOẠI CỬA', 'KÍCH THƯỚC (R x C)', 'CAO BẬU', 'SỐ LƯỢNG', 'VỊ TRÍ', 'VẬT LIỆU, MÔ TẢ'];
  const rows = list.map((t) => {
    const desc = materials[t.tag] ?? MATERIAL[t.type];
    if (materials[t.tag] === undefined) assumed.push({ item: `materials.${t.tag}`, value: desc });
    return [t.tag, K[t.type], `${t.w} x ${t.h}`, t.type === 'window' ? t.sill : '', t.count, [...t.floors.entries()].map(([fl, n]) => (fl ? `${fl}: ${n}` : `${n}`)).join('; '), desc];
  });
  const yT = y0 - 22 * sc;
  // columns wide enough for one line per row; the title row, the header, the types
  out.push({
    type: 'table', at: P(at[0], yT), title: lang === 'en' ? 'DOOR AND WINDOW TYPES' : 'DANH MỤC CÁC LOẠI CỬA', rows: [head, ...rows], height: r2(2.5 * sc), row_height: r2(8 * sc),
    col_widths: [16, 40, 32, 16, 18, 54, 96].map((wd) => r2(wd * sc)), layer: TXT, style: TEXT_STYLE,
  });
  const yTitle = yT - (rows.length + 2) * 8 * sc - 18 * sc;
  out.push(...viewTitle(lang === 'en' ? 'DOOR AND WINDOW SCHEDULE' : 'BẢNG THỐNG KÊ CỬA ĐI, CỬA SỔ', (at[0] + x) / 2, yTitle, sc, TXT, lang));
  return { entities: out, rows: list.map((t) => ({ tag: t.tag, type: t.type, size: `${t.w}x${t.h}`, sill: t.sill, count: t.count })), assumed };
}
