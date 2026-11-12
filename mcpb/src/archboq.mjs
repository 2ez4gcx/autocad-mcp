// Architectural finish quantities (bảng khối lượng hoàn thiện kiến trúc) of a building, floor by floor: floor tiles,
// wall tiles and skirting, skim coat and paint inside and outside, ceilings, waterproofing and the roof, stair granite
// and railings, doors and windows. Every row is the sum of faces of the surface model (surfaces.mjs): what is built,
// measured on its real surfaces (plan and elevation), the same faces as the interior schedule (materialSchedule), so
// the two bills agree. With the structure (the result of structuralCalc) the faces of the columns that stand out of
// the walls and the sides of the beams under a soffit that is the finish are measured too. Each row carries two numbers: q, measured by the rule set (rules.mjs; by default Phụ lục VI of
// Thông tư 13/2021/TT-BXD: an opening under 0,25 m² is not deducted), and geo, the geometric net. For estimating: the
// quantity surveyor checks them against the final drawings. Quantities in m², m (md) and sets.
import { doorSchedule } from './doors.mjs';
import { floorsOf } from './elevation.mjs';
import { materialSchedule } from './interior.mjs';
import { roundQ, ruleSet } from './rules.mjs';
import { TEXT_STYLE, viewTitle } from './standards.mjs';
import { checkName, floorSurfaces, surfaceChecks } from './surfaces.mjs';

const r2 = (v) => Math.round(v * 100) / 100;

const SECTIONS = {
  vi: { floor: 'I. LÁT NỀN, ỐP TƯỜNG, LEN', paint: 'II. BẢ MATIT, SƠN', ceiling: 'III. TRẦN', water: 'IV. CHỐNG THẤM, MÁI', stair: 'V. CẦU THANG, LAN CAN', doors: 'VI. CỬA ĐI, CỬA SỔ' },
  en: { floor: 'I. FLOOR AND WALL TILES, SKIRTING', paint: 'II. SKIM COAT AND PAINT', ceiling: 'III. CEILINGS', water: 'IV. WATERPROOFING, ROOF', stair: 'V. STAIRS, RAILINGS', doors: 'VI. DOORS AND WINDOWS' },
};
// the order of the rows of a section (the others: by their code)
const ORDER = { paint: ['CEIL', 'PUT', 'IN', 'OUT', 'SLAB'], water: ['WET', 'BALC', 'TERR', 'SCREED', 'ROOF', 'PITCH'], stair: ['TREAD', 'RISER', 'SKIRT', 'RAIL', 'BALRAIL'] };
const T = {
  vi: {
    tile: 'Lát nền', putIn: 'Bả matit tường trong', paintIn: 'Sơn tường trong 1 nước lót, 2 nước phủ', paintOut: 'Bả matit, sơn tường ngoài 1 nước lót, 2 nước phủ',
    ceilPaint: 'Bả matit, sơn trần thạch cao', slabPaint: 'Bả matit, sơn trần bê tông (đáy sàn, đáy bản thang, đáy chiếu nghỉ)',
    wet: 'Chống thấm sàn vệ sinh, quét lên tường 300', balc: 'Chống thấm sàn ban công, sân phơi, quét lên tường 300',
    terr: 'Chống thấm sân thượng, quét lên tường 300', screed: 'Láng vữa XM M75 tạo dốc i=2% sân thượng', roof: 'Láng vữa tạo dốc, chống thấm mái tum',
    pitch: 'Mái dốc: diện tích theo mặt nghiêng, kể cả phần đua',
    tread: 'Ốp đá granite mặt bậc, chiếu nghỉ', riser: 'Ốp đá granite cổ bậc', rail: 'Lan can, tay vịn cầu thang', balRail: 'Lan can ban công cao 1100',
    door: 'Cửa đi', window: 'Cửa sổ', set: 'bộ', doorArea: 'Tổng diện tích cửa đi', winArea: 'Tổng diện tích cửa sổ',
  },
  en: {
    tile: 'Floor', putIn: 'Skim coat, inner walls', paintIn: 'Paint, inner walls (primer and two coats)', paintOut: 'Skim coat and paint, outer walls (primer and two coats)',
    ceilPaint: 'Skim coat and paint, gypsum ceilings', slabPaint: 'Skim coat and paint, concrete soffits (slabs, flights, landings)',
    wet: 'Waterproofing, toilet floors, 300 up the walls', balc: 'Waterproofing, balconies, 300 up the walls',
    terr: 'Waterproofing, roof terrace, 300 up the walls', screed: 'Screed to falls i=2%, roof terrace', roof: 'Screed to falls and waterproofing, tower roof',
    pitch: 'Pitched roof: true area on the slope, overhang included',
    tread: 'Granite treads and landings', riser: 'Granite risers', rail: 'Stair railing and handrail', balRail: 'Balcony railing 1100 high',
    door: 'Door', window: 'Window', set: 'set', doorArea: 'Total door area', winArea: 'Total window area',
  },
};

/**
 * floors: [{name, spec, height, rooms {name: outline}, finishes {name: finish of resolveFinish}, items}] from the bottom;
 * spec: the building (doors and windows); rules: the rule set (a name of rules.mjs or a rule set; default Phụ lục VI);
 * structure: the result of structuralCalc for the same plan (its floors by name, else in the same order): the slab over
 * each floor (a room with no suspended ceiling is finished up to its soffit), the beams that cross such a room (their
 * two sides are painted with the soffit) and the columns that stand out of a wall or free in a room (the wall finish
 * wraps them); without it nothing of that is added and warnings says so. A floor may give slab_over (mm), the
 * thickness of the slab over it (default: of the floor above in spec, 120).
 * Returns {floors: [{name, rooms, S (the surface model of the floor: floorSurfaces)}], rows: [{head} | {stt, section, key, item, unit, q (measured by the rule set), geo (geometric net), how,
 * by {floor: q}, geoBy {floor: geo}, faces (ids)}], faces (every face of the surface model, with the keys of its rows),
 * checks [{id, name, ok, lhs, rhs, tol, where}], rooms (the measures of the rooms and balconies), stairs (the parameters
 * of the stairs), rules {name, void, reveals, decimals}, warnings, assumed [{item, value}] (a roof the plan does not
 * give)}.
 */
export function finishQuantities({ floors, spec, lang = 'vi', ground = null, rules = null, structure = null }) {
  const en = lang === 'en', t = T[lang] ?? T.vi, R = ruleSet(rules);
  // rounded to the decimals of the rule set, a half upwards as a spreadsheet does (16,6275 is 16,628 whatever the last
  // bit of the sum), so the workbook and the bill show the same numbers
  const dec = R.decimals ?? 3, rq = (v) => roundQ(v + 1e-10, R);
  const fmt = (v) => rq(v).toFixed(dec).replace('.', en ? '.' : ',');
  const acc = new Map();
  // a face of the surface model in a row of the bill: its measured quantity and its geometric net, by floor
  const put = (section, key, item, unit, f) => {
    if (!(f.measured > 0) && !(f.net > 0)) return;
    const k = `${section}|${key}`;
    const r = acc.get(k) ?? { section, key: k, item, unit, by: new Map(), geoBy: new Map(), faces: [] };
    r.by.set(f.floor, (r.by.get(f.floor) ?? 0) + f.measured);
    r.geoBy.set(f.floor, (r.geoBy.get(f.floor) ?? 0) + f.net);
    r.faces.push(f.id);
    f.rows.push(k);
    acc.set(k, r);
  };
  const assign = (f) => {
    if (f.none) return;
    switch (f.kind) {
      case 'floor': put('floor', f.code, `${t.tile}: ${f.desc}`, 'm²', f); break;
      // the skirting of a stair room goes with the stair (the same stone as its stepped skirting)
      case 'skirting': if (f.stairRoom) put('stair', 'SKIRT', f.desc, 'md', f); else put('floor', f.code, f.desc, 'md', f); break;
      case 'splashback': put('floor', f.code, f.desc, 'm²', f); break;
      case 'wall': case 'column':
        if (f.pattern === 'tile' || f.pattern === 'panel') put('floor', f.code, f.desc, 'm²', f);
        else if (f.finishKind === 'outdoor') put('paint', 'OUT', t.paintOut, 'm²', f);
        else {
          put('paint', 'PUT', t.putIn, 'm²', f);
          put('paint', `IN|${f.code}`, `${t.paintIn}: ${f.desc}`, 'm²', f);
        }
        break;
      case 'ceiling': case 'ceiling_drop':
        put('ceiling', f.code, f.desc, 'm²', f);
        put('paint', 'CEIL', t.ceilPaint, 'm²', f);
        break;
      case 'soffit': put('paint', 'SLAB', t.slabPaint, 'm²', f); break;
      case 'waterproof': put('water', f.code, { WET: t.wet, BALC: t.balc, TERR: t.terr }[f.code], 'm²', f); break;
      case 'screed': put('water', 'SCREED', t.screed, 'm²', f); break;
      case 'roof': put('water', 'ROOF', t.roof, 'm²', f); break;
      case 'roof_pitched': put('water', 'PITCH', t.pitch, 'm²', f); break;
      // the floor of a stair room (the landing at the foot or at the head of the stair) is the stone of the treads
      case 'tread': case 'landing': put('stair', 'TREAD', t.tread, 'm²', f); break;
      case 'riser': put('stair', 'RISER', t.riser, 'm²', f); break;
      case 'stair_skirting': put('stair', 'SKIRT', f.desc, 'md', f); break;
      case 'handrail': put('stair', 'RAIL', t.rail, 'md', f); break;
      case 'railing': put('stair', 'BALRAIL', t.balRail, 'md', f); break;
      case 'exterior': case 'parapet_top': put('paint', 'OUT', t.paintOut, 'm²', f); break;
      default: break;
    }
  };
  const g0 = Math.abs(ground ?? spec?.heights?.ground ?? -450);
  // the measures behind the quantities, for the live workbook and the checks
  const roomRows = [], stairRows = [], faces = [], data = [], warnings = [], assumed = [];
  // the slab over each floor: as given, else that of the floor above in the building
  let built = [];
  try {
    built = Array.isArray(spec?.floors) && spec.floors.length === floors.length ? floorsOf(spec) : [];
  } catch {
    built = [];
  }
  const slabOver = (k) => floors[k].slab_over ?? built[k + 1]?.slab ?? null;
  if (!structure) {
    warnings.push(en ? 'the sides of exposed beams and the faces of columns that stand out of the walls are not measured: no structure (run structural_calc of the same plan first)'
      : 'chưa đo thành dầm lộ dưới trần bê tông và má cột nhô khỏi tường: chưa có kết cấu (chạy structural_calc cho cùng mặt bằng trước)');
  }
  floors.forEach((fl, k) => {
    const top = k === floors.length - 1;
    const rooms = fl.rooms || {};
    const S = floorSurfaces({ spec: fl.spec, rooms, finishes: fl.finishes || {}, items: fl.items || [], floor: fl.name, lang, rules: R, height: fl.height, top, ground: k === 0 ? g0 : 0, slab: slabOver(k), structure, index: k });
    data.push({ name: fl.name, rooms, S });
    warnings.push(...S.warnings.map((w) => (fl.name ? `${fl.name}: ${w}` : w)));
    assumed.push(...S.assumed.map((a) => ({ item: fl.name ? `${fl.name}: ${a.item}` : a.item, value: a.value })));
    const first = stairRows.length;
    for (const f of S.faces) {
      f.rows = [];
      // the stairs of the building in one list (Q.stairs): stairRow is the place of the stair of a face in it
      if (f.stair !== undefined) f.stairRow = first + f.stair;
      assign(f);
      faces.push(f);
    }
    for (const m of S.measures) {
      const f = m.finish;
      roomRows.push({
        floor: fl.name, room: m.room, kind: m.wet ? 'wet' : m.outdoor ? (top ? 'terrace' : 'outdoor') : f.kind === 'stair' ? 'stair' : 'dry',
        floorCode: f.floor && f.kind !== 'stair' ? f.floor.code : null, skirtingCode: f.skirting && f.kind !== 'stair' ? f.skirting.code : null,
        wallCode: f.wall?.code ?? null, wallPaint: f.wall ? !(f.wall.pattern === 'tile' || f.wall.pattern === 'panel') : false, ceilingCode: f.ceiling?.code ?? null,
        area: m.area, per: m.per, doorW: m.doorW, wallH: m.wall && m.per ? m.wall.gross / m.per : 0, opArea: m.wall?.opArea ?? 0, splash: m.wall?.splash ?? 0,
      });
    }
    for (const w of S.faces.filter((f) => f.kind === 'waterproof' && f.balcony !== undefined)) {
      const fin = S.faces.find((f) => f.kind === 'floor' && f.balcony === w.balcony);
      roomRows.push({
        floor: fl.name, room: w.room, kind: 'balcony', floorCode: fin?.code ?? null, skirtingCode: null, wallCode: null, wallPaint: false,
        ceilingCode: null, area: w.L * w.H, per: 2 * (w.L + w.H), doorW: 0, wallH: 0, opArea: 0, splash: 0,
      });
    }
    // the stairs that start on the floor (the parameters of the stair sheet), then what a stair room has beside its
    // flights: the landing at the foot or at the head of a stair, its skirting, the guard at the stairwell
    stairRows.push(...S.stairs);
    const arrival = {
      area: S.faces.filter((f) => f.kind === 'landing' && f.stair === undefined).reduce((s, f) => s + f.measured, 0),
      skirt: S.faces.filter((f) => f.kind === 'skirting' && f.stairRoom).reduce((s, f) => s + f.measured, 0),
      guard: S.faces.filter((f) => f.guard).reduce((s, f) => s + f.measured, 0),
    };
    if (arrival.area > 0 || arrival.skirt > 0 || arrival.guard > 0) stairRows.push({ floor: fl.name, type: 'landing', n1: 0, n2: 0, riser: 0, going: 0, w: 0, landing: 0, B: 0, gap: 0, c1: 0, c2: 0, wall: 0, ...arrival });
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
    acc.set(`doors|${r.tag}`, {
      section: 'doors', key: `doors|${r.tag}`, item: `${r.tag} - ${kind} ${w}x${h}`, unit: t.set, by: new Map([['', r.count]]),
      how: `${r.count} x ${r2(w / 1000).toFixed(2).replace('.', en ? '.' : ',')} x ${r2(h / 1000).toFixed(2).replace('.', en ? '.' : ',')} = ${fmt(a)} m²${row?.[6] ? `; ${row[6]}` : ''}`,
      door: { tag: r.tag, window: r.type === 'window', w: w / 1000, h: h / 1000, count: r.count, note: row?.[6] ?? '' },
    });
  }
  if (dA) acc.set('doors|DA', { section: 'doors', key: 'doors|DA', item: t.doorArea, unit: 'm²', by: new Map([['', dA]]) });
  if (wA) acc.set('doors|WA', { section: 'doors', key: 'doors|WA', item: t.winArea, unit: 'm²', by: new Map([['', wA]]) });
  // rows by section, the quantity per floor as how it is made up
  const S = SECTIONS[lang] ?? SECTIONS.vi;
  const rows = [];
  let n = 0;
  for (const sec of Object.keys(S)) {
    const rank = (r) => (ORDER[sec] ? ORDER[sec].indexOf(r.key.split('|')[1]) : 0);
    const list = [...acc.values()].filter((r) => r.section === sec);
    if (sec !== 'doors') list.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    if (!list.length) continue;
    rows.push({ head: true, item: S[sec] });
    for (const r of list) {
      // the total is the sum of the floors as they are shown (rounded), so the sheet, the CSV and the workbook agree
      const set = r.unit === t.set;
      const round = (m) => Object.fromEntries([...m.entries()].map(([f, x]) => [f, set ? x : rq(x)]));
      const by = round(r.by), geoBy = r.geoBy ? round(r.geoBy) : by;
      const total = (o) => (set ? Object.values(o).reduce((s, x) => s + x, 0) : rq(Object.values(o).reduce((s, x) => s + x, 0)));
      const how = r.how ?? Object.entries(by).filter(([f]) => f).map(([f, x]) => `${f}: ${fmt(x)}`).join('; ');
      rows.push({ stt: ++n, section: sec, key: r.key, item: r.item, unit: r.unit, q: total(by), geo: total(geoBy), how, by, geoBy, faces: r.faces ?? [], ...(r.door ? { door: r.door } : {}) });
    }
  }
  // cross-checks: the surface model floor by floor, then the bill against the interior schedule, code by code (the
  // schedule adds the faces up on its own: a face left out of the bill, or counted twice, shows here)
  const checks = surfaceChecks(data, { lang });
  const sched = new Map();
  let ms = null;
  try {
    floors.forEach((fl, k) => {
      ms = materialSchedule({ spec: fl.spec, rooms: fl.rooms || {}, finishes: fl.finishes || {}, items: fl.items || [], lang, floor: fl.name, acc: sched, rules: R, top: k === floors.length - 1, slab: slabOver(k), structure, index: k });
    });
  } catch (e) {
    ms = null;
    warnings.push(`${checkName('bill', lang)}: ${e.message}`);
  }
  const billed = new Map();
  for (const f of faces) {
    if (!f.desc || f.none || !f.rows.length) continue;
    const k = `${f.code}|${f.desc}|${f.unit}`;
    billed.set(k, (billed.get(k) ?? 0) + f.measured);
  }
  for (const r of ms?.rows ?? []) {
    if (!(r.unit === 'm²' || r.unit === 'm') || !/^(FL|SK|WL|CL)-/.test(r.code)) continue;
    const lhs = r2(billed.get(`${r.code}|${r.description}|${r.unit}`) ?? 0);
    checks.push({ id: 'bill', name: checkName('bill', lang), ok: Math.abs(lhs - r.qty) <= 0.0051, lhs, rhs: r.qty, tol: 0.005, where: `${r.code} (${r.unit})` });
  }
  return {
    rows, rooms: roomRows, faces, floors: data, stairs: stairRows, checks, warnings, assumed,
    rules: { name: R.name?.[en ? 'en' : 'vi'] ?? R.name?.vi ?? String(R.name ?? ''), void: R.void.finish, reveals: R.reveals !== false, decimals: dec },
  };
}

// units that are counted, not measured: their quantity is a whole number
const COUNTED = /^(bộ|cái|set|sets|pcs|nos?)$/i;

/** The table of the finish quantities with its note and title (drawn at scale, paper mm x scale). */
export function finishSheet(Q, { scale = 25, lang = 'vi' } = {}) {
  const en = lang === 'en', sc = scale, rh = 6.5;
  // the geometric quantity has a column of its own where it differs from the measured one (an opening not deducted)
  const two = Q.rows.some((r) => !r.head && r.geo !== undefined && Math.abs(r.geo - r.q) > 5e-4);
  const head = [en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', ...(two ? [en ? 'GEOMETRIC' : 'KL HÌNH HỌC'] : []),
    en ? 'BY FLOOR / MADE UP OF' : 'DIỄN GIẢI THEO TẦNG'];
  // a quantity as the bill writes it: the decimals of the rule set (81,620, not 81,62), a count as a whole number
  const dec = Q.rules?.decimals ?? 3;
  const qf = (v) => Number(v).toFixed(dec).replace('.', en ? '.' : ',');
  const cell = (r, v) => (COUNTED.test(r.unit) && Number.isInteger(v) ? String(v) : qf(v));
  const rows = [head, ...Q.rows.map((r) => (r.head ? ['', r.item, '', '', ...(two ? [''] : []), ''] : [r.stt, r.item, r.unit, cell(r, r.q), ...(two ? [cell(r, r.geo ?? r.q)] : []), r.how]))];
  const title = en ? 'ARCHITECTURAL FINISH QUANTITIES' : 'BẢNG KHỐI LƯỢNG HOÀN THIỆN KIẾN TRÚC';
  const widths = two ? [10, 110, 14, 22, 22, 136] : [10, 118, 14, 22, 150];
  const out = [{
    type: 'table', at: [0, 0], title, rows, decimal_separator: en ? undefined : ',', height: r2(2.2 * sc), row_height: r2(rh * sc),
    col_widths: widths.map((w) => r2(w * sc)), layer: 'A-ANNO-TEXT', style: TEXT_STYLE,
    // the quantities are texts with their decimals: kept to the right as numbers are
    col_align: [null, null, null, 'right', ...(two ? ['right'] : []), null],
  }];
  // rows wrap where a cell is longer than its column: count their lines (about 1.45 mm a character at 2.2 mm)
  const lines = rows.map((row) => Math.max(1, ...row.map((v, i) => Math.ceil(([...String(v ?? '')].length * 1.45) / (widths[i] - 2)))));
  const y = -(lines.reduce((a, b) => a + b, 0) + 2) * rh * sc;
  const num = (v) => String(v).replace('.', en ? '.' : ',');
  const rule = Q.rules
    ? (en ? ` Measured by ${Q.rules.name}: an opening smaller than ${num(Q.rules.void)} m² is not deducted${two ? ' (the geometric column deducts every opening)' : ''}.`
      : ` Quy tắc đo: ${Q.rules.name}: lỗ nhỏ hơn ${num(Q.rules.void)} m² không trừ${two ? ' (cột khối lượng hình học trừ mọi lỗ)' : ''}.`)
    : '';
  const text = en
    ? `Quantities measured on the surfaces of the model: each wall face by the height of the wall behind it, openings deducted and their reveals added; the floor under the doors; the drop faces of the ceilings; the treads, risers and stepped skirting of the stairs, their soffits on the slope; with the finishes of the room schedule.${rule} For estimating: the quantity surveyor checks them against the final drawings. Outer walls: every face with no room on its side is counted, the side (party) walls included: take off the faces that stand against the neighbours. Masonry and plaster: see the structural bill of quantities.`
    : `Khối lượng đo trên từng bề mặt của mô hình: mỗi mặt tường theo chiều cao tường phía sau, đã trừ cửa và cộng má cửa; phần sàn dưới cửa; mặt đứng giật cấp của trần; mặt bậc, cổ bậc, len theo bậc và đáy bản thang theo mặt nghiêng của cầu thang; với vật liệu hoàn thiện của bảng thống kê vật liệu.${rule} Dùng để lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công. Tường ngoài: tính mọi mặt tường không giáp phòng, kể cả hai tường bên (giáp nhà bên cạnh): trừ phần không bả, sơn khi lập dự toán. Xây, trát: xem bảng khối lượng phần kết cấu.`;
  out.push({ type: 'mtext', at: [0, r2(y - 4 * sc)], width: r2(310 * sc), height: r2(2.5 * sc), layer: 'A-ANNO-TEXT', style: TEXT_STYLE, text });
  // the title under the note: about 1.65 mm a character at 2.5 mm, 4.2 mm a line
  const noteLines = Math.ceil(([...text].length * 1.65) / 306);
  out.push(...viewTitle(title, 157 * sc, y - Math.max(24, 4 + noteLines * 4.2 + 10) * sc, sc, 'A-ANNO-TEXT', lang, 5, false));
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
    [en ? 'No.' : 'STT', en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'QUANTITY' : 'KHỐI LƯỢNG', en ? 'GEOMETRIC QUANTITY' : 'KL HÌNH HỌC',
      en ? 'BY FLOOR' : 'DIỄN GIẢI THEO TẦNG'].map(esc).join(sep)];
  for (const r of Q.rows) lines.push((r.head ? ['', r.item, '', '', '', ''] : [r.stt, r.item, r.unit, r.q, r.geo ?? r.q, r.how]).map(esc).join(sep));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
