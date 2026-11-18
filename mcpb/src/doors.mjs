// Door and window schedule (bảng thống kê cửa đi, cửa sổ): every type of door and window of the building drawn in
// elevation with its sizes and opening direction, its count by floor, and the table of types. Pure geometry: returns
// draw_entities specs. Types come from the openings of the plan description (by tag, kind and size).
import { buildBuilding, isOutside, roomAt } from './elevation.mjs';
import { dimStyleName, ROLE, TEXT_STYLE, viewTitle, ROOM } from './standards.mjs';
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
  // a single door by what it serves: wood stays in dry rooms only
  door_wet: 'Cửa nhôm hệ, kính mờ cường lực 8 mm, chịu nước (cửa khu vệ sinh), phụ kiện đồng bộ',
  door_outside: 'Cửa nhôm hệ, kính cường lực 8 mm (cửa ra sân, ban công, ngoài trời), phụ kiện đồng bộ',
};
const MATERIAL_EN = {
  door: 'Engineered wood door, wood frame, PU paint, matching hardware',
  double_door: 'Aluminium system door, 8 mm tempered glass, matching hardware',
  sliding: 'Aluminium system sliding door, 8 mm tempered glass',
  window: 'Aluminium system window, 6.38 mm laminated glass, with a guard grille',
  door_wet: 'Aluminium system door, 8 mm frosted tempered glass, water resistant (toilet door), matching hardware',
  door_outside: 'Aluminium system door, 8 mm tempered glass (door to a yard, a balcony, the open air), matching hardware',
};
const WET = ROOM.wet, OUTDOOR = ROOM.outdoor;

/**
 * What a door serves, from the rooms on its two sides: 'wet' (a toilet or bathroom), 'outside' (the open air, a
 * balcony, a terrace, a yard), else 'inside'. Unknown (null) on a floor with no rooms named.
 */
function doorUse(M, op) {
  if (!M.rooms.length) return null;
  const s = op.s, n = [-s.d[1], s.d[0]], mid = (op.span.from + op.span.to) / 2;
  const pts = [Math.min(s.o1, s.o2) - 300, Math.max(s.o1, s.o2) + 300].map((o) => [s.a[0] + s.d[0] * mid + n[0] * o, s.a[1] + s.d[1] * mid + n[1] * o]);
  const names = pts.map((p) => roomAt(M, p)?.name ?? null);
  if (names.some((x) => x && WET.test(x))) return 'wet';
  // the open air (a space the walls do not close), or a room named as a yard, a balcony, a terrace; an enclosed space
  // with no room named in it (a corridor) is inside
  if (names.some((x, k) => (x ? OUTDOOR.test(x) : isOutside(M, pts[k])))) return 'outside';
  return 'inside';
}

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
      const t = types.get(key) ?? { tag, type: op.type, w, h, sill: Math.round(op.sill), count: 0, floors: new Map(), uses: new Set() };
      t.count++;
      if (op.type === 'door') t.uses.add(doorUse(f.M, op));
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
    // a single door: aluminium and glass where it serves a toilet or the outside, wood between dry rooms
    const use = t.uses.has('wet') ? 'wet' : t.uses.has('outside') ? 'outside' : 'inside';
    const MAT = lang === 'en' ? MATERIAL_EN : MATERIAL;
    const desc = materials[t.tag] ?? (use === 'inside' ? MAT[t.type] : MAT[`door_${use}`]);
    if (materials[t.tag] === undefined) {
      const mixed = use !== 'inside' && t.uses.size > 1;
      assumed.push({ item: `materials.${t.tag}`, value: desc, ...(mixed ? { note: `type ${t.tag} serves ${use === 'wet' ? 'a toilet' : 'the outside'} and dry rooms: give those doors a tag of their own` } : {}) });
    }
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
  return { entities: out, rows: list.map((t) => ({ tag: t.tag, type: t.type, size: `${t.w}x${t.h}`, sill: t.sill, count: t.count, ...(t.type === 'door' && !t.uses.has(null) ? { use: t.uses.has('wet') ? 'wet' : t.uses.has('outside') ? 'outside' : 'inside' } : {}) })), assumed };
}
