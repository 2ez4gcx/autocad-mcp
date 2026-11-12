// The finish quantities (architecture) as a live Excel workbook, after the detail table of Phụ lục VI of Thông tư
// 13/2021/TT-BXD (Bảng 6.2): a sheet of the faces of the surface model, one row per face (like parts, length, height,
// gross as a formula, deductions, additions, the geometric net and the quantity by the rule set as formulas, how it is
// made up); the bill on the main sheet as SUMIFS over it, with both numbers; the stairs with their parameters (the
// stair faces take their sizes from them); the doors; the cross-checks. Built on xlsx.mjs.
import { colName, xlsx } from './xlsx.mjs';

const inp = (v, s) => ({ v, s: s ?? (typeof v === 'number' ? 'input3' : 'inputText') });
const f = (formula, s = 'num3') => ({ f: formula, s });
const tx = (v, s = 'text') => ({ v, s });
// a number as the model has it, to the 15 significant digits a spreadsheet keeps (4.6000000000000005 is 4.6; 3300 / 19
// keeps all its digits, so the workbook calculates what the model calculated)
const r6 = (v) => Number(Number(v).toPrecision(15));
const n6 = (v) => String(r6(v));

const KINDS = {
  vi: {
    floor: 'sàn', landing: 'chiếu nghỉ, chiếu tới', ceiling: 'trần (mặt phẳng)', ceiling_drop: 'trần (mặt đứng giật cấp)', soffit: 'đáy sàn, đáy thang', wall: 'tường',
    splashback: 'ốp bếp', column: 'má cột, cột giữa phòng', skirting: 'len chân tường', tread: 'mặt bậc', riser: 'cổ bậc', stair_skirting: 'len theo bậc', handrail: 'tay vịn, lan can thang', railing: 'lan can ban công',
    waterproof: 'chống thấm', screed: 'láng tạo dốc', roof: 'mái bằng', roof_pitched: 'mái dốc', exterior: 'tường ngoài', parapet_top: 'đỉnh tường chắn',
  },
  en: {
    floor: 'floor', landing: 'landing', ceiling: 'ceiling (flat)', ceiling_drop: 'ceiling (drop face)', soffit: 'soffit', wall: 'wall', column: 'column faces', splashback: 'splashback', skirting: 'skirting',
    tread: 'treads', riser: 'risers', stair_skirting: 'stepped skirting', handrail: 'handrail, guard', railing: 'balcony railing', waterproof: 'waterproofing', screed: 'screed to falls',
    roof: 'flat roof', roof_pitched: 'pitched roof', exterior: 'outer wall', parapet_top: 'parapet top',
  },
};
// the parameters of a stair on the stair sheet: the stair faces refer to them ({n1} ... in the link of a face)
const PCOL = { n1: 'B', n2: 'C', riser: 'D', going: 'E', w: 'F', landing: 'G', B: 'H', gap: 'I', c1: 'J', c2: 'K', wall: 'L' };

/**
 * The finish quantities as a live workbook. With the faces of finishQuantities (Q.faces): the sheet of the faces
 * (yellow: what was measured on the model, may be changed; gross, net and measured are formulas), the main sheet
 * (every quantity a SUMIFS over the faces by floor and row: measured by the rule set, and the geometric net), the
 * stairs (parameters in yellow, their surfaces as formulas), the doors and windows, the cross-checks (this workbook
 * against the model, then the checks of the model). Without the faces (an older result): the quantities by floor as
 * inputs, the total as their sum.
 */
export function finishWorkbook(Q, floorNames, lang = 'vi') {
  const en = lang === 'en';
  const SH = en ? { main: 'Finishes', faces: 'Faces', doors: 'Doors', stairs: 'Stairs', checks: 'Checks' } : { main: 'Hoàn thiện', faces: 'Bề mặt', doors: 'Cửa', stairs: 'Cầu thang', checks: 'Kiểm tra' };
  const live = Array.isArray(Q.faces) && Q.faces.some((x) => x && x.id !== undefined && Array.isArray(x.rows));
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const names = [...new Set(floorNames)];
  // the columns of the floors, then what belongs to the whole building (doors and windows)
  const keys = names.includes('') ? names : [...names, ''];
  const cols = keys.map((k) => (k === '' ? (en ? 'WHOLE BUILDING' : 'CHUNG') : k));
  const K = keys.length;
  const dec = Q.rules?.decimals ?? (live ? 3 : 2);
  const TITLE = en ? 'ARCHITECTURAL FINISH QUANTITIES' : 'BẢNG KHỐI LƯỢNG HOÀN THIỆN KIẾN TRÚC';
  const USE = en ? 'For estimating: the quantity surveyor checks them against the final drawings.' : 'Dùng lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công.';

  // ---- without the faces: the quantities by floor as inputs
  if (!live) {
    const rows = [[tx(TITLE, 'title')],
      [tx(en ? `Quantities by floor (yellow, may be changed); the total is their sum. ${USE}` : `Khối lượng theo từng tầng (ô màu vàng, sửa được); cột tổng là công thức cộng các tầng. ${USE}`, 'note')],
      [tx(en ? 'No.' : 'STT', 'head'), tx(en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), ...cols.map((c) => tx(c, 'head')), tx(en ? 'TOTAL' : 'TỔNG', 'head'), tx(en ? 'NOTE' : 'GHI CHÚ', 'head')]];
    for (const row of Q.rows) {
      if (row.head) {
        rows.push([tx('', 'section'), tx(row.item, 'section'), ...Array(K + 3).fill(tx('', 'section'))]);
        continue;
      }
      const r = rows.length + 1;
      rows.push([{ v: row.stt, s: 'int' }, tx(row.item), tx(row.unit), ...keys.map((k) => (row.by?.[k] ? inp(row.by[k], 'input') : '')),
        f(`SUM(${colName(3)}${r}:${colName(3 + K - 1)}${r})`, 'boldNum'), tx(row.by?.[''] && row.how ? row.how : '')]);
    }
    return xlsx([{ name: SH.main, rows, widths: [6, 66, 8, ...cols.map(() => 12), 13, 40], freeze: 4 }]);
  }

  const rule = Q.rules ?? { name: '', void: 0.25, reveals: true };
  const num = (v) => String(v).replace('.', en ? '.' : ',');

  // ---- stairs: the flights as built, their parameters in yellow, their surfaces as formulas
  const stairs = Q.stairs ?? [];
  const S0 = 5, stairRow = new Map();
  const sr = [[tx(en ? 'STAIRS: PARAMETERS AND REAL SURFACES' : 'CẦU THANG: THÔNG SỐ VÀ DIỆN TÍCH THỰC', 'title')],
    [tx(en ? `A stair is measured on what is built, not on the plan of the stairwell. Yellow cells: the parameters of each stair (the stair faces of the sheet "${SH.faces}" take their number, length and width from here). Treads and half landing = (n1 - 1 + n2 - 1) x b x w + landing x B; risers = (n1 + n2) x h x w; skirting stepped along the walls beside the flights (1 = a wall all along the flight, 0 = none) and around the landing; handrail on the slope of the flights + the well; soffits of the flights on the slope + the landing. A straight flight: n2 = 0.`
      : `Cầu thang đo theo bề mặt thực, không theo hình chiếu bằng của lồng thang. Ô màu vàng: thông số của từng thang (các mặt của thang ở sheet "${SH.faces}" lấy số bộ phận, dài, rộng từ đây). Mặt bậc và chiếu nghỉ = (n1 - 1 + n2 - 1) x b x w + chiếu nghỉ x B; cổ bậc = (n1 + n2) x h x w; len theo bậc dọc tường bên các vế (1 = có tường suốt vế, 0 = không có) và quanh chiếu nghỉ; tay vịn theo chiều dốc các vế + khe thang; đáy bản thang theo mặt nghiêng + đáy chiếu nghỉ. Thang một vế thẳng: n2 = 0.`, 'note')], [],
    (en ? ['FLOOR', 'RISERS FLIGHT 1 (n1)', 'RISERS FLIGHT 2 (n2)', 'RISER h (m)', 'GOING b (m)', 'FLIGHT WIDTH w (m)', 'LANDING DEPTH (m)', 'STAIRWELL WIDTH B (m)', 'WELL GAP (m)', 'WALL BESIDE FLIGHT 1 (0-1)', 'WALL BESIDE FLIGHT 2 (0-1)', 'WALLS AROUND THE LANDING (m)', 'TREADS, LANDING (m²)', 'RISERS (m²)', 'STEPPED SKIRTING (m)', 'HANDRAIL (m)', 'SOFFITS (m²)']
      : ['TẦNG', 'SỐ BẬC VẾ 1 (n1)', 'SỐ BẬC VẾ 2 (n2)', 'CAO BẬC h (m)', 'RỘNG BẬC b (m)', 'RỘNG VẾ w (m)', 'SÂU CHIẾU NGHỈ (m)', 'RỘNG LỒNG THANG B (m)', 'KHE THANG (m)', 'TƯỜNG BÊN VẾ 1 (0-1)', 'TƯỜNG BÊN VẾ 2 (0-1)', 'TƯỜNG QUANH CHIẾU NGHỈ (m)', 'MẶT BẬC, CHIẾU NGHỈ (m²)', 'CỔ BẬC (m²)', 'LEN THEO BẬC (m)', 'TAY VỊN (m)', 'ĐÁY BẢN THANG, CHIẾU NGHỈ (m²)']).map((h) => tx(h, 'head'))];
  stairs.forEach((x, i) => {
    if (!(x.n1 > 0)) return;
    const r = S0 + stairRow.size;
    stairRow.set(i, r);
    const s1 = `SQRT(((B${r}-1)*E${r})^2+(B${r}*D${r})^2)`, s2 = `IF(C${r}>0,SQRT(((C${r}-1)*E${r})^2+(C${r}*D${r})^2),0)`;
    sr.push([tx(x.floor), { v: x.n1, s: 'inputInt' }, { v: x.n2, s: 'inputInt' }, inp(r6(x.riser)), inp(r6(x.going)), inp(r6(x.w)), inp(r6(x.landing)), inp(r6(x.B)), inp(r6(x.gap)),
      inp(r6(x.c1 ?? 1)), inp(r6(x.c2 ?? 1)), inp(r6(x.wall ?? 0)),
      f(`(MAX(B${r}-1,0)+MAX(C${r}-1,0))*E${r}*F${r}+G${r}*H${r}`), f(`(B${r}+C${r})*D${r}*F${r}`),
      f(`J${r}*(MAX(B${r}-1,0)*E${r}+B${r}*D${r})+K${r}*(MAX(C${r}-1,0)*E${r}+C${r}*D${r})+L${r}`),
      f(`${s1}+${s2}+I${r}`), f(`(${s1}+${s2})*F${r}+G${r}*H${r}`)]);
  });
  const linkX = (expr, i) => expr.replace(/\{(\w+)\}/g, (_, p) => `'${SH.stairs}'!$${PCOL[p]}$${stairRow.get(i)}`);

  // ---- the faces (Bảng 6.2): one row per face of the surface model that a row of the bill counts
  const faces = Q.faces.filter((x) => !x.none && x.rows?.length);
  const KD = KINDS[en ? 'en' : 'vi'];
  const F0 = 5, F1 = F0 + Math.max(1, faces.length) - 1;
  const nKeys = Math.max(1, ...faces.map((x) => x.rows.length));
  const KEY0 = 16;
  const fr = [[tx(en ? 'FACES: THE DETAIL OF THE QUANTITIES' : 'BỀ MẶT: BẢNG CHI TIẾT KHỐI LƯỢNG', 'title')],
    [tx(en ? `One row per finished surface of the model. Yellow cells: measured on the model, may be changed. Gross = like parts x length x height (or the area of the outline); geometric = gross - every deduction + additions (reveals of the openings, the floor under the doors, waterproofing up the walls, the sides of exposed beams); by the rules (${rule.name}) = gross - deductions of ${num(rule.void)} m² and more + additions: an opening smaller than ${num(rule.void)} m² is not taken off. The main sheet adds the rows up by floor and item (the item columns at the right).`
      : `Mỗi dòng là một bề mặt hoàn thiện của mô hình. Ô màu vàng: số đo trên mô hình, sửa được. Gộp = số bộ phận x dài x cao (hoặc diện tích theo đường bao); hình học = gộp - mọi phần trừ + phần cộng (má cửa, phần sàn dưới cửa, chống thấm quét lên tường, thành dầm lộ); theo quy tắc đo (${rule.name}) = gộp - phần trừ từ ${num(rule.void)} m² trở lên + phần cộng: lỗ nhỏ hơn ${num(rule.void)} m² không trừ. Bảng chính cộng các dòng theo tầng và khoản mục (các cột khoản mục ở bên phải).`, 'note')], [],
    [...(en ? ['No.', 'FLOOR', 'ROOM / LOCATION', 'KIND OF FACE', 'CODE', 'UNIT', 'LIKE PARTS', 'LENGTH (m)', 'HEIGHT / WIDTH (m)', 'GROSS', `DEDUCTED (>= ${num(rule.void)} m²)`, `NOT DEDUCTED (< ${num(rule.void)} m²)`, 'ADDED', 'GEOMETRIC', 'BY THE RULES', 'MADE UP OF']
      : ['STT', 'TẦNG', 'PHÒNG / VỊ TRÍ', 'LOẠI MẶT', 'MÃ', 'ĐƠN VỊ', 'SỐ BỘ PHẬN', 'DÀI (m)', 'CAO / RỘNG (m)', 'GỘP', `TRỪ (>= ${num(rule.void)} m²)`, `KHÔNG TRỪ (< ${num(rule.void)} m²)`, 'CỘNG', 'KL HÌNH HỌC', 'KL THEO QUY TẮC', 'DIỄN GIẢI']),
    ...Array.from({ length: nKeys }, (_, i) => `${en ? 'ITEM' : 'KHOẢN MỤC'} ${i + 1}`)].map((h) => tx(h, 'head'))];
  const keyCols = new Map();
  faces.forEach((x, k) => {
    const r = F0 + k, lin = x.unit === 'm', key = lin ? 'len' : 'area';
    const linked = x.link && stairRow.has(x.stairRow) ? x.link : null;
    const dim = (v, ex) => (linked?.[ex] ? f(linkX(linked[ex], x.stairRow)) : v === undefined ? '' : inp(r6(v)));
    // a sum of products where the parts are known (0.8*2.4+...), a number where only the amount is
    const sumOf = (list, term) => {
      if (!list.length) return '';
      const parts = list.map(term);
      return parts.some((p) => p.includes('*')) ? f(parts.join('+')) : inp(r6(parts.reduce((s, p) => s + Number(p), 0)));
    };
    const ded = (d) => (d.w !== undefined && d.h !== undefined ? `${n6(d.w)}*${n6(d.h)}` : n6(d[key]));
    // an addition as its arithmetic: a reveal (perimeter x depth), the upturn of the waterproofing ((perimeter - doors)
    // x height), the floor under a door (width x half the wall), the two sides of a beam (2 x length x depth)
    const addT = (a) => (a.perimeter !== undefined ? `${n6(a.perimeter)}*${n6(a.depth)}` : a.per !== undefined ? `(${n6(a.per)}-${n6(a.doors)})*${n6(a.H)}`
      : a.L !== undefined ? `${a.n > 1 ? `${a.n}*` : ''}${n6(a.L)}*${n6(a.H)}` : n6(a.area));
    const reveals = x.additions.filter((a) => a.kind === 'reveal'), counted = rule.reveals ? x.additions : x.additions.filter((a) => a.kind !== 'reveal');
    // reveals that the rules leave out are still part of the geometry
    const extra = !rule.reveals && reveals.length ? `+${reveals.map(addT).join('+')}` : '';
    x.rows.forEach((kk, i) => {
      if (!keyCols.has(kk)) keyCols.set(kk, new Set());
      keyCols.get(kk).add(colName(KEY0 + i));
    });
    fr.push([{ v: k + 1, s: 'int' }, tx(x.floor), tx(x.room), tx(KD[x.kind] ?? x.kind), tx(/^[A-Z]{2}-/.test(x.code ?? '') ? x.code : ''), tx(x.unit),
      linked?.n ? f(linkX(linked.n, x.stairRow), 'int') : { v: x.n, s: 'inputInt' }, dim(x.L, 'L'), lin ? '' : dim(x.H, 'H'),
      x.L !== undefined ? f(lin ? `G${r}*H${r}` : `G${r}*H${r}*I${r}`) : inp(r6(x.gross)),
      sumOf(x.deductions.filter((d) => d.off), ded), sumOf(x.deductions.filter((d) => !d.off), ded), sumOf(counted, addT),
      f(`MAX(0,J${r}-K${r}-L${r}+M${r}${extra})`), f(`MAX(0,J${r}-K${r}+M${r})`), tx(x.how), ...x.rows.map((kk) => tx(kk))]);
  });
  const FR = (c) => `'${SH.faces}'!$${c}$${F0}:$${c}$${F1}`;
  // the faces of a row of the bill on a floor (every floor when fl is null): SUMIFS over the value column
  const sumifs = (val, key, fl) => [...(keyCols.get(key) ?? [])].map((kc) => `SUMIFS(${FR(val)},${fl === null ? '' : `${FR('B')},${q(fl)},`}${FR(kc)},${q(key)})`).join('+');

  // ---- doors and windows
  const doors = Q.rows.filter((x) => x.door).map((x) => x.door);
  const D0 = 4, D1 = D0 + Math.max(1, doors.length) - 1;
  const DOOR = en ? 'door' : 'cửa đi', WIN = en ? 'window' : 'cửa sổ';
  const dr = [[tx(en ? 'DOORS AND WINDOWS' : 'CỬA ĐI, CỬA SỔ', 'title')], [],
    (en ? ['TAG', 'KIND', 'WIDTH (m)', 'HEIGHT (m)', 'COUNT', 'AREA (m²)', 'DESCRIPTION'] : ['KÝ HIỆU', 'LOẠI', 'RỘNG (m)', 'CAO (m)', 'SỐ LƯỢNG', 'DIỆN TÍCH (m²)', 'MÔ TẢ']).map((h) => tx(h, 'head'))];
  const doorRow = {};
  doors.forEach((d, i) => {
    const r = D0 + i;
    doorRow[d.tag] = r;
    dr.push([tx(d.tag), tx(d.window ? WIN : DOOR), inp(d.w), inp(d.h), { v: d.count, s: 'inputInt' }, f(`C${r}*D${r}*E${r}`), tx(d.note)]);
  });
  const DR = (col) => `'${SH.doors}'!$${col}$${D0}:$${col}$${D1}`;

  // ---- the main sheet: by the rules floor by floor and in all, the geometric net floor by floor and in all
  const c0 = 3, cT = c0 + K, g0 = cT + 1, gT = g0 + K, cN = gT + 1;
  const rows = [[tx(TITLE, 'title')],
    [tx(en ? `Every quantity is a formula over the sheet "${SH.faces}" (the faces of the model, one row each: change the yellow cells there), "${SH.stairs}" and "${SH.doors}"; the total is the sum of the floors. By the rules: ${rule.name} (an opening smaller than ${num(rule.void)} m² is not deducted); geometric: every opening deducted. ${USE}`
      : `Mọi khối lượng là công thức lấy từ sheet "${SH.faces}" (các bề mặt của mô hình, mỗi mặt một dòng: sửa ô vàng ở đó), "${SH.stairs}" và "${SH.doors}"; cột tổng cộng các tầng. Theo quy tắc đo: ${rule.name} (lỗ nhỏ hơn ${num(rule.void)} m² không trừ); hình học: trừ mọi lỗ cửa. ${USE}`, 'note')],
    [tx('', 'head'), tx('', 'head'), tx('', 'head'), tx(en ? 'QUANTITY BY THE RULES' : 'KHỐI LƯỢNG THEO QUY TẮC ĐO', 'head'), ...Array(K).fill(tx('', 'head')),
      tx(en ? 'GEOMETRIC QUANTITY' : 'KHỐI LƯỢNG HÌNH HỌC', 'head'), ...Array(K).fill(tx('', 'head')), tx('', 'head')],
    [tx(en ? 'No.' : 'STT', 'head'), tx(en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), ...cols.map((c) => tx(c, 'head')), tx(en ? 'TOTAL' : 'TỔNG', 'head'),
      ...cols.map((c) => tx(c, 'head')), tx(en ? 'TOTAL' : 'TỔNG', 'head'), tx(en ? 'NOTE' : 'GHI CHÚ', 'head')]];
  const merges = [`${colName(c0)}3:${colName(cT)}3`, `${colName(g0)}3:${colName(gT)}3`];
  const mainRow = new Map();
  for (const row of Q.rows) {
    if (row.head) {
      rows.push([tx('', 'section'), tx(row.item, 'section'), ...Array(2 * K + 4).fill(tx('', 'section'))]);
      continue;
    }
    const r = rows.length + 1;
    mainRow.set(row.key, r);
    const counted = !row.faces?.length;
    const cell = (name, by, val) => {
      const v = by?.[name];
      if (counted) {
        // doors and windows: from the door sheet, in the column of the whole building
        if (name !== '' || val !== 'O') return '';
        if (row.door && doorRow[row.door.tag]) return f(`'${SH.doors}'!E${doorRow[row.door.tag]}`, 'int');
        if (row.key === 'doors|DA') return f(`ROUND(SUMIFS(${DR('F')},${DR('B')},${q(DOOR)}),${dec})`);
        if (row.key === 'doors|WA') return f(`ROUND(SUMIFS(${DR('F')},${DR('B')},${q(WIN)}),${dec})`);
        return v ? inp(v) : '';
      }
      if (v === undefined) return '';
      // a formula only where the floor has the item (the other cells stay empty), rounded as the bill shows it
      const fx = sumifs(val, row.key, name);
      return fx ? f(`ROUND(${fx},${dec})`) : inp(v);
    };
    const set = !!row.door;
    rows.push([{ v: row.stt, s: 'int' }, tx(row.item), tx(row.unit), ...keys.map((name) => cell(name, row.by, 'O')), f(`SUM(${colName(c0)}${r}:${colName(cT - 1)}${r})`, set ? 'bold' : 'boldNum3'),
      ...keys.map((name) => cell(name, row.geoBy ?? row.by, 'N')), f(counted ? `${colName(cT)}${r}` : `SUM(${colName(g0)}${r}:${colName(gT - 1)}${r})`, set ? 'bold' : 'boldNum3'),
      tx(counted && row.how ? row.how : '')]);
  }

  // ---- the checks: this workbook against the model, then the cross-checks of the model
  const PASS = en ? 'PASS' : 'ĐẠT', FAIL = en ? 'FAIL' : 'KHÔNG ĐẠT';
  const C0 = 5;
  const cr = [[tx(en ? 'CROSS-CHECKS' : 'KIỂM TRA CHÉO', 'title')],
    [tx(en ? 'Each check compares two independent counts of the same thing; the difference and the result are formulas. Part A compares this workbook (its formulas) with the quantities of the model: it shows what a change of a yellow cell has moved.'
      : 'Mỗi dòng so hai cách tính độc lập của cùng một đại lượng; chênh lệch và kết quả là công thức. Phần A so bảng tính này (công thức) với khối lượng của mô hình: cho thấy phần đã đổi khi sửa ô vàng.', 'note')],
    [tx(en ? 'Checks that fail' : 'Số kiểm tra không đạt', 'bold'), '', '', '', '', '', '', null],
    (en ? ['No.', 'CHECK', 'WHERE', 'LEFT SIDE', 'RIGHT SIDE', 'TOLERANCE', 'DIFFERENCE', 'RESULT', 'NOTE'] : ['STT', 'KIỂM TRA', 'VỊ TRÍ', 'VẾ TRÁI', 'VẾ PHẢI', 'SAI SỐ CHO PHÉP', 'CHÊNH LỆCH', 'KẾT QUẢ', 'GHI CHÚ']).map((h) => tx(h, 'head'))];
  let cn = 0;
  const line = (name, where, lhs, rhs, tol, note = '') => {
    const r = cr.length + 1;
    cr.push([{ v: ++cn, s: 'int' }, tx(name), tx(where), lhs, rhs, { v: tol, s: 'num3' }, f(`ABS(D${r}-E${r})`), f(`IF(G${r}<=F${r}+0.000000001,${q(PASS)},${q(FAIL)})`, 'ok'), tx(note)]);
  };
  const section = (text) => cr.push([tx('', 'section'), tx(text, 'section'), ...Array(7).fill(tx('', 'section'))]);
  section(en ? 'A. THIS WORKBOOK AGAINST THE MODEL' : 'A. BẢNG TÍNH NÀY SO VỚI KHỐI LƯỢNG CỦA MÔ HÌNH');
  const BY = en ? 'by the rules' : 'theo quy tắc đo', GEO = en ? 'geometric' : 'hình học';
  for (const row of Q.rows) {
    if (row.head) continue;
    const r = mainRow.get(row.key), tol = row.door ? 0 : 0.001;
    line(row.item, `${BY} (${row.unit})`, f(`'${SH.main}'!${colName(cT)}${r}`), { v: row.q, s: 'num3' }, tol);
    if (row.faces?.length && row.geo !== undefined) line(row.item, `${GEO} (${row.unit})`, f(`'${SH.main}'!${colName(gT)}${r}`), { v: row.geo, s: 'num3' }, tol);
  }
  section(en ? 'B. CROSS-CHECKS OF THE SURFACE MODEL' : 'B. KIỂM TRA CHÉO CỦA MÔ HÌNH BỀ MẶT');
  for (const c of Q.checks ?? []) line(c.name, c.where ?? '', { v: c.lhs, s: 'num3' }, { v: c.rhs, s: 'num3' }, c.tol, c.note ?? '');
  cr[2][7] = f(`COUNTIF(H${C0}:H${cr.length},${q(FAIL)})`, 'bold');

  const sheets = [
    { name: SH.main, rows, merges, widths: [6, 66, 8, ...cols.map(() => 12), 13, ...cols.map(() => 12), 13, 40], freeze: 5 },
    { name: SH.faces, rows: fr, widths: [6, 10, 20, 20, 8, 7, 8, 10, 10, 11, 13, 13, 11, 12, 12, 70, ...Array(nKeys).fill(16)], freeze: 5 },
  ];
  if (stairRow.size) sheets.push({ name: SH.stairs, rows: sr, widths: [10, 11, 11, 10, 10, 11, 11, 12, 9, 11, 11, 12, 13, 10, 11, 10, 13], freeze: 5 });
  sheets.push({ name: SH.doors, rows: dr, widths: [10, 10, 10, 10, 10, 12, 60], freeze: 4 });
  sheets.push({ name: SH.checks, rows: cr, widths: [6, 70, 34, 13, 13, 12, 12, 12, 50], freeze: 5 });
  return xlsx(sheets);
}
