// Architectural finish quantities (bảng khối lượng hoàn thiện kiến trúc) of a building, floor by floor: floor tiles,
// wall tiles and skirting, skim coat and paint inside and outside, ceilings, waterproofing and the roof, stair granite
// and railings, doors and windows. The rooms and their finishes are those of the interior tools (materialSchedule,
// the same defaults by room name); the outer faces of the walls are those with no room on their side. For estimating:
// the quantity surveyor checks them against the final drawings. Quantities in m², m (md) and sets.
import { doorSchedule } from './doors.mjs';
import { buildModel } from './elevation.mjs';
import { inside, materialSchedule, polyArea } from './interior.mjs';
import { uStairGeom } from './plan.mjs';
import { TEXT_STYLE, viewTitle } from './standards.mjs';

const WET = /(WC|VỆ SINH|TẮM|TOILET|BATH|WASH)/i;
const OUTDOOR = /(SÂN|HIÊN|BAN CÔNG|LÔ GIA|LOGIA|BALCONY|TERRACE|PORCH|YARD)/i;
const STAIRS = /(CẦU THANG|STAIR)/i;
const r2 = (v) => Math.round(v * 100) / 100;
const perimeter = (poly) => poly.reduce((s, p, i) => s + Math.hypot(poly[(i + 1) % poly.length][0] - p[0], poly[(i + 1) % poly.length][1] - p[1]), 0);

const SECTIONS = {
  vi: { floor: 'I. LÁT NỀN, ỐP TƯỜNG, LEN', paint: 'II. BẢ MATIT, SƠN', ceiling: 'III. TRẦN', water: 'IV. CHỐNG THẤM, MÁI', stair: 'V. CẦU THANG, LAN CAN', doors: 'VI. CỬA ĐI, CỬA SỔ' },
  en: { floor: 'I. FLOOR AND WALL TILES, SKIRTING', paint: 'II. SKIM COAT AND PAINT', ceiling: 'III. CEILINGS', water: 'IV. WATERPROOFING, ROOF', stair: 'V. STAIRS, RAILINGS', doors: 'VI. DOORS AND WINDOWS' },
};
const T = {
  vi: {
    tile: 'Lát nền', putIn: 'Bả matit tường trong', paintIn: 'Sơn tường trong 1 nước lót, 2 nước phủ', paintOut: 'Bả matit, sơn tường ngoài 1 nước lót, 2 nước phủ',
    ceilPaint: 'Bả matit, sơn trần thạch cao', slabPaint: 'Bả matit, sơn trần bê tông (đáy sàn, đáy chiếu nghỉ)',
    wet: 'Chống thấm sàn vệ sinh, quét lên tường 300', balc: 'Chống thấm sàn ban công, sân phơi, quét lên tường 300',
    terr: 'Chống thấm sân thượng, quét lên tường 300', screed: 'Láng vữa XM M75 tạo dốc i=2% sân thượng', roof: 'Láng vữa tạo dốc, chống thấm mái tum',
    tread: 'Ốp đá granite mặt bậc, chiếu nghỉ', riser: 'Ốp đá granite cổ bậc', rail: 'Lan can, tay vịn cầu thang', balRail: 'Lan can ban công cao 1100',
    door: 'Cửa đi', window: 'Cửa sổ', set: 'bộ', doorArea: 'Tổng diện tích cửa đi', winArea: 'Tổng diện tích cửa sổ',
  },
  en: {
    tile: 'Floor', putIn: 'Skim coat, inner walls', paintIn: 'Paint, inner walls (primer and two coats)', paintOut: 'Skim coat and paint, outer walls (primer and two coats)',
    ceilPaint: 'Skim coat and paint, gypsum ceilings', slabPaint: 'Skim coat and paint, concrete soffits (slabs, landings)',
    wet: 'Waterproofing, toilet floors, 300 up the walls', balc: 'Waterproofing, balconies, 300 up the walls',
    terr: 'Waterproofing, roof terrace, 300 up the walls', screed: 'Screed to falls i=2%, roof terrace', roof: 'Screed to falls and waterproofing, tower roof',
    tread: 'Granite treads and landings', riser: 'Granite risers', rail: 'Stair railing and handrail', balRail: 'Balcony railing 1100 high',
    door: 'Door', window: 'Window', set: 'set', doorArea: 'Total door area', winArea: 'Total window area',
  },
};

/**
 * floors: [{name, spec, height, rooms {name: outline}, finishes {name: finish of resolveFinish}, items}] from the bottom;
 * spec: the building (doors and windows). Returns {rows: [{head} | {stt, section, item, unit, q, how}]}.
 */
export function finishQuantities({ floors, spec, lang = 'vi', ground = null }) {
  const en = lang === 'en', t = T[lang] ?? T.vi;
  const acc = new Map();
  const fmt = (v) => r2(v).toFixed(2).replace('.', en ? '.' : ',');
  const put = (section, key, item, unit, floor, q) => {
    if (!(q > 0)) return;
    const k = `${section}|${key}`;
    const r = acc.get(k) ?? { section, item, unit, by: new Map() };
    r.by.set(floor, (r.by.get(floor) ?? 0) + q);
    acc.set(k, r);
  };
  const g0 = Math.abs(ground ?? spec?.heights?.ground ?? -450);
  floors.forEach((fl, k) => {
    const top = k === floors.length - 1;
    const rooms = fl.rooms || {};
    // the room finishes: tiles, skirting, wall finishes and ceilings, measured room by room
    const parts = new Map();
    for (const f of Object.values(fl.finishes || {})) for (const p of ['floor', 'skirting', 'wall', 'ceiling']) if (f?.[p]) parts.set(f[p].code, { part: p, def: f[p], kind: f.kind });
    const ms = materialSchedule({ spec: fl.spec, rooms, finishes: fl.finishes || {}, items: fl.items || [], lang, floor: fl.name });
    for (const r of ms.rows) {
      const pre = r.code.slice(0, 2), info = parts.get(r.code);
      if (pre === 'FL') {
        if (info?.kind === 'stair') continue;
        put('floor', r.code, `${t.tile}: ${r.description}`, 'm²', fl.name, r.qty);
      } else if (pre === 'SK') {
        put('floor', r.code, r.description, 'md', fl.name, r.qty);
      } else if (pre === 'WL') {
        if (!info || info.def.pattern === 'tile' || info.def.pattern === 'panel') put('floor', r.code, r.description, 'm²', fl.name, r.qty);
        else if (info.kind === 'outdoor') put('paint', 'OUT', t.paintOut, 'm²', fl.name, r.qty);
        else {
          put('paint', 'PUT', t.putIn, 'm²', fl.name, r.qty);
          put('paint', `IN|${r.code}`, `${t.paintIn}: ${r.description}`, 'm²', fl.name, r.qty);
        }
      } else if (pre === 'CL') {
        put('ceiling', r.code, r.description, 'm²', fl.name, r.qty);
        put('paint', 'CEIL', t.ceilPaint, 'm²', fl.name, r.qty);
      }
    }
    // rooms without a ceiling: their concrete soffit painted (not the open roof terrace); waterproofing by kind
    for (const [name, poly] of Object.entries(rooms)) {
      const f = fl.finishes?.[name];
      const A = Math.abs(polyArea(poly)) / 1e6, per = perimeter(poly) / 1000;
      const outdoor = OUTDOOR.test(name);
      if (f && !f.ceiling && !(outdoor && top)) put('paint', 'SLAB', t.slabPaint, 'm²', fl.name, A);
      if (WET.test(name)) put('water', 'WET', t.wet, 'm²', fl.name, A + 0.3 * per);
      else if (outdoor && !top) put('water', 'BALC', t.balc, 'm²', fl.name, A + 0.3 * per);
      else if (outdoor && top) {
        put('water', 'TERR', t.terr, 'm²', fl.name, A + 0.3 * per);
        put('water', 'SCREED', t.screed, 'm²', fl.name, A);
      }
    }
    // the outer faces of the walls (no room on that side): the facade height, the plinth on the ground floor, parapets
    const M = buildModel(fl.spec);
    for (const w of M.walls) {
      const parapet = w.height !== undefined;
      for (const s of w.segs) {
        const n = [-s.d[1], s.d[0]], mid = [s.a[0] + s.d[0] * s.L / 2, s.a[1] + s.d[1] * s.L / 2], c = (s.o1 + s.o2) / 2;
        const H = parapet ? w.height : fl.height + (k === 0 ? g0 : 0);
        const ops = M.openings.filter((o) => o.s === s);
        for (const o of [s.o1, s.o2]) {
          const side = Math.sign(o - c) || 1;
          const p = [mid[0] + n[0] * (o + side * 40), mid[1] + n[1] * (o + side * 40)];
          if (Object.values(rooms).some((poly) => inside(p, poly))) continue;
          let A = (s.L / 1000) * (H / 1000);
          for (const op of ops) A -= ((op.span.to - op.span.from) / 1000) * (Math.max(0, Math.min(op.head, H) - op.sill) / 1000);
          put('paint', 'OUT', t.paintOut, 'm²', fl.name, Math.max(0, A));
        }
        if (parapet) put('paint', 'OUT', t.paintOut, 'm²', fl.name, (s.L / 1000) * (s.t / 1000));
      }
    }
    // the tower roof over the top floor: inside its walls
    if (top) {
      const tw = M.walls.filter((w) => w.height === undefined).flatMap((w) => w.segs);
      if (tw.length) {
        const xs = tw.flatMap((s) => [s.a[0], s.b[0]]), ys = tw.flatMap((s) => [s.a[1], s.b[1]]);
        const A = ((Math.max(...xs) - Math.min(...xs)) / 1000) * ((Math.max(...ys) - Math.min(...ys)) / 1000);
        put('water', 'ROOF', t.roof, 'm²', fl.name, A);
      }
    }
    // stairs: granite on the treads, landing and risers; the railing along the well, the guard at the floor above
    for (const st of (fl.spec.stairs || []).filter((x) => x.type === 'u')) {
      const g = uStairGeom(st, fl.height);
      put('stair', 'TREAD', t.tread, 'm²', fl.name, (((g.n1 - 1 + g.n2 - 1) * g.going * g.w) + g.landing * (g.b1 - g.b0)) / 1e6);
      put('stair', 'RISER', t.riser, 'm²', fl.name, ((g.n1 + g.n2) * g.riser * g.w) / 1e6);
      put('stair', 'RAIL', t.rail, 'md', fl.name, (Math.hypot((g.n1 - 1) * g.going, g.n1 * g.riser) + Math.hypot((g.n2 - 1) * g.going, g.n2 * g.riser) + g.gap) / 1000);
    }
    if (!(fl.spec.stairs || []).some((x) => x.type === 'u')) {
      for (const st of (fl.spec.stairs_below || []).filter((x) => x.type === 'u')) {
        const g = uStairGeom(st, st.height ?? fl.height);
        put('stair', 'RAIL', t.rail, 'md', fl.name, (g.run + g.gap) / 1000);
      }
    }
    // balconies: the railing on the sides away from the building
    const pts = M.walls.flatMap((w) => w.segs.flatMap((s) => [s.a, s.b]));
    const box = pts.length ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : null;
    for (const bc of fl.spec.balconies || []) {
      if (!Array.isArray(bc.region) || !box) continue;
      const [[x0, y0], [x1, y1]] = bc.region;
      const edges = [[Math.abs(x1 - x0), Math.max(y0, y1)], [Math.abs(x1 - x0), Math.min(y0, y1)]].map(([L, y]) => (Math.abs(y - box[1]) < 300 || Math.abs(y - box[3]) < 300 ? 0 : L));
      const sides = [Math.abs(y1 - y0), Math.abs(y1 - y0)].map((L, i) => {
        const x = i === 0 ? Math.min(x0, x1) : Math.max(x0, x1);
        return Math.abs(x - box[0]) < 300 || Math.abs(x - box[2]) < 300 ? (x0 >= box[0] - 300 && x1 <= box[2] + 300 ? L : 0) : L;
      });
      put('stair', 'BALRAIL', t.balRail, 'md', fl.name, (edges[0] + edges[1] + sides[0] + sides[1]) / 1000);
    }
  });
  // doors and windows by type (the door schedule)
  const ds = spec ? doorSchedule({ spec, scale: 50, lang }) : null;
  const table = ds?.entities.find((e) => e.type === 'table');
  let dA = 0, wA = 0;
  for (const r of ds?.rows ?? []) {
    const [w, h] = r.size.split('x').map(Number);
    const row = table?.rows.find((x) => x[0] === r.tag);
    const kind = row?.[1] ?? (r.type === 'window' ? t.window : t.door);
    const a = (w / 1000) * (h / 1000) * r.count;
    if (r.type === 'window') wA += a;
    else dA += a;
    acc.set(`doors|${r.tag}`, { section: 'doors', item: `${r.tag} - ${kind} ${w}x${h}`, unit: t.set, by: new Map([['', r.count]]), how: `${r.count} x ${fmt(w / 1000)} x ${fmt(h / 1000)} = ${fmt(a)} m²${row?.[6] ? `; ${row[6]}` : ''}` });
  }
  if (dA) acc.set('doors|DA', { section: 'doors', item: t.doorArea, unit: 'm²', by: new Map([['', dA]]) });
  if (wA) acc.set('doors|WA', { section: 'doors', item: t.winArea, unit: 'm²', by: new Map([['', wA]]) });
  // rows by section, the quantity per floor as how it is made up
  const S = SECTIONS[lang] ?? SECTIONS.vi;
  const rows = [];
  let n = 0;
  for (const sec of Object.keys(S)) {
    const list = [...acc.values()].filter((r) => r.section === sec);
    if (!list.length) continue;
    rows.push({ head: true, item: S[sec] });
    for (const r of list) {
      const q = [...r.by.values()].reduce((s, x) => s + x, 0);
      const how = r.how ?? [...r.by.entries()].filter(([f]) => f).map(([f, x]) => `${f}: ${fmt(x)}`).join('; ');
      rows.push({ stt: ++n, section: sec, item: r.item, unit: r.unit, q: r.unit === t.set ? q : r2(q), how, by: Object.fromEntries([...r.by.entries()].map(([f, x]) => [f, r.unit === t.set ? x : r2(x)])) });
    }
  }
  return { rows };
}

/** The table of the finish quantities with its note and title (drawn at scale, paper mm x scale). */
export function finishSheet(Q, { scale = 25, lang = 'vi' } = {}) {
  const en = lang === 'en', sc = scale, rh = 6.5;
  const head = [en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'BY FLOOR / MADE UP OF' : 'DIỄN GIẢI THEO TẦNG'];
  const rows = [head, ...Q.rows.map((r) => (r.head ? ['', r.item, '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how]))];
  const title = en ? 'ARCHITECTURAL FINISH QUANTITIES' : 'BẢNG KHỐI LƯỢNG HOÀN THIỆN KIẾN TRÚC';
  const out = [{
    type: 'table', at: [0, 0], title, rows, decimal_separator: en ? undefined : ',', height: r2(2.2 * sc), row_height: r2(rh * sc),
    col_widths: [10, 118, 14, 22, 150].map((w) => r2(w * sc)), layer: 'A-ANNO-TEXT', style: TEXT_STYLE,
  }];
  // rows wrap where a cell is longer than its column: count their lines (about 1.45 mm a character at 2.2 mm)
  const widths = [10, 118, 14, 22, 150];
  const lines = rows.map((row) => Math.max(1, ...row.map((v, i) => Math.ceil(([...String(v ?? '')].length * 1.45) / (widths[i] - 2)))));
  const y = -(lines.reduce((a, b) => a + b, 0) + 2) * rh * sc;
  out.push({
    type: 'mtext', at: [0, r2(y - 4 * sc)], width: r2(310 * sc), height: r2(2.5 * sc), layer: 'A-ANNO-TEXT', style: TEXT_STYLE,
    text: en ? 'Quantities by the rooms of the plans (walls to the ceiling, openings deducted) and the finishes of the room schedule, for estimating: the quantity surveyor checks them against the final drawings. Masonry and plaster: see the structural bill of quantities.'
      : 'Khối lượng theo các phòng của mặt bằng (tường tính đến trần, đã trừ cửa) và vật liệu hoàn thiện của bảng thống kê vật liệu, dùng để lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công. Xây, trát: xem bảng khối lượng phần kết cấu.',
  });
  out.push(...viewTitle(title, 157 * sc, y - 24 * sc, sc, 'A-ANNO-TEXT', lang, 5, false));
  return { title, entities: out };
}

/** CSV (Excel) of the finish quantities: semicolons and decimal commas in Vietnamese. */
export function finishCsv(Q, lang = 'vi', sep = ';') {
  const en = lang === 'en';
  const num = (v) => (typeof v === 'number' ? (sep === ';' ? String(v).replace('.', ',') : String(v)) : String(v ?? ''));
  const esc = (v) => {
    const s = num(v);
    return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [esc(en ? 'ARCHITECTURAL FINISH QUANTITIES' : 'BẢNG KHỐI LƯỢNG HOÀN THIỆN KIẾN TRÚC'),
    [en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'BY FLOOR' : 'DIỄN GIẢI THEO TẦNG'].map(esc).join(sep)];
  for (const r of Q.rows) lines.push((r.head ? ['', r.item, '', '', ''] : [r.stt, r.item, r.unit, r.q, r.how]).map(esc).join(sep));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
