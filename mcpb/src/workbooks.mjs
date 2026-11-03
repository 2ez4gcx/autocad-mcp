// The calculation and the quantities as live Excel workbooks: the inputs in yellow cells (materials, loads, soil,
// sections, bars, forces from the analysis) and everything else as formulas of them, so that the sheets calculate
// again when a value is changed. Built on xlsx.mjs.
import { BUILDUP, gammaLive, LIVE, ROOF_LIVE } from './calc.mjs';
import { colName, sref, xlsx } from './xlsx.mjs';

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const inp = (v) => ({ v, s: typeof v === 'number' ? 'input' : 'inputText' });
const f = (formula, s = 'num2') => ({ f: formula, s });
const tx = (v, s = 'text') => ({ v, s });

/** "12 x 1,40 x 1,40 x 0,1" -> "12*1.40*1.40*0.1" when the text is only arithmetic, else null. */
export function howFormula(how) {
  if (!how) return null;
  const e = String(how).replace(/,/g, '.').replace(/\s*x\s*/g, '*').replace(/\s+/g, '');
  return /^[\d.*+\-/()]+$/.test(e) && /\d/.test(e) && /[*+]/.test(e) ? e : null;
}

const TXT = {
  vi: {
    note: 'Ô màu vàng: số liệu nhập, sửa được; các ô khác là công thức, tự tính lại khi số liệu thay đổi. Bảng tính sơ bộ: kỹ sư kết cấu có chứng chỉ hành nghề kiểm tra, tính lại và ký xác nhận trước khi dùng để thi công.',
    params: 'Thông số', loads: 'Tải trọng', beams: 'Dầm', cols: 'Cột - Móng', bars: 'Thống kê thép', qty: 'Khối lượng',
  },
  en: {
    note: 'Yellow cells: inputs you may change; the others are formulas that calculate again. Preliminary: a licensed structural engineer checks, recalculates and signs it before construction.',
    params: 'Parameters', loads: 'Loads', beams: 'Beams', cols: 'Columns - footings', bars: 'Bar schedule', qty: 'Quantities',
  },
};

/** The structural workbook: parameters, loads, beams, columns and footings; with B (boqSheets) the bars and quantities. */
export function kcWorkbook(R, B = null, lang = 'vi') {
  const en = lang === 'en', T = TXT[lang] ?? TXT.vi;
  const sheets = [];
  // ---- parameters
  const S1 = T.params, rows1 = [], at = {};
  rows1.push([tx(en ? 'PRELIMINARY STRUCTURAL CALCULATION - PARAMETERS' : 'BẢNG TÍNH KẾT CẤU SƠ BỘ - THÔNG SỐ TÍNH TOÁN', 'title')], [tx(T.note, 'note')], []);
  rows1.push([tx(en ? 'PARAMETER' : 'THÔNG SỐ', 'head'), tx(en ? 'VALUE' : 'GIÁ TRỊ', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), tx(en ? 'NOTE' : 'GHI CHÚ', 'head')]);
  const P = (key) => sref(S1, 1, at[key]);
  const par = (key, label, value, unit = '', note = '') => {
    rows1.push([tx(label), value, tx(unit), tx(note)]);
    at[key] = rows1.length;
  };
  const { c, s, sw } = R.mat;
  par('concrete', en ? 'Concrete' : 'Cấp bê tông', inp(R.names.concrete), '', 'TCVN 5574:2018');
  par('Rb', en ? 'Compressive strength Rb' : 'Cường độ chịu nén tính toán Rb', inp(c.Rb), 'MPa');
  par('Rbt', en ? 'Tensile strength Rbt' : 'Cường độ chịu kéo tính toán Rbt', inp(c.Rbt), 'MPa');
  par('steel', en ? 'Main bars' : 'Thép dọc', inp(R.names.steel));
  par('Rs', 'Rs', inp(s.Rs), 'MPa');
  par('Rsc', 'Rsc', inp(s.Rsc), 'MPa');
  par('stir', en ? 'Stirrups' : 'Thép đai', inp(R.names.stirrupSteel));
  par('Rsw', 'Rsw', inp(sw.Rsw), 'MPa');
  par('Es', 'Es', inp(200000), 'MPa');
  par('a', en ? 'Bar centre to the face a' : 'Khoảng cách trọng tâm thép a', inp(40), 'mm');
  par('xiR', 'ξR = 0,8 / (1 + Rs / Es / 0,0035)', f(`0.8/(1+${P('Rs')}/${P('Es')}/0.0035)`, 'num3'));
  par('aR', 'αR = ξR (1 - ξR / 2)', f(`${P('xiR')}*(1-${P('xiR')}/2)`, 'num3'));
  par('soil', en ? 'Bearing pressure R (assumed)' : 'Áp lực tính toán của đất nền R (giả thiết)', inp(R.soil), 'kPa', en ? 'from the site investigation' : 'lấy theo khảo sát địa chất');
  par('Hm', en ? 'Footing depth Hm' : 'Chiều sâu chôn móng Hm', inp(R.depth / 1000), 'm');
  par('gtb', en ? 'Mean unit weight of footing and soil γtb' : 'Trọng lượng riêng TB móng và đất γtb', inp(20), 'kN/m³');
  par('fB', en ? 'Footing B' : 'Cạnh móng B', inp(R.footing.B / 1000), 'm');
  par('fL', en ? 'Footing L' : 'Cạnh móng L', inp(R.footing.L / 1000), 'm');
  par('cb', en ? 'Column b' : 'Cột b', inp(R.column.size[0]), 'mm');
  par('ch', en ? 'Column h' : 'Cột h', inp(R.column.size[1]), 'mm');
  par('cn', en ? 'Column bars n' : 'Số thanh thép cột n', inp(R.column.bars.n));
  par('cd', en ? 'Column bars d' : 'Đường kính thép cột d', inp(R.column.bars.d), 'mm');
  par('cAs', 'As = n π d² / 4', f(`${P('cn')}*PI()*${P('cd')}^2/4`, 'num2'), 'mm²');
  par('phi', en ? 'Buckling factor φ' : 'Hệ số uốn dọc φ', inp(0.9));
  par('kn', en ? 'Ntc = Ntt / k' : 'Quy đổi tải tiêu chuẩn Ntc = Ntt / k', inp(1.15));
  sheets.push({ name: S1, rows: rows1, widths: [46, 14, 10, 40] });

  // ---- loads: build-ups, live loads, walls
  const S2 = T.loads, rows2 = [];
  rows2.push([tx(en ? 'LOADS (TCVN 2737:2023)' : 'TẢI TRỌNG (TCVN 2737:2023)', 'title')], [tx(T.note, 'note')], []);
  rows2.push([tx(en ? 'LAYER' : 'LỚP', 'head'), tx(en ? 'THICKNESS (m)' : 'DÀY (m)', 'head'), tx(en ? 'UNIT WEIGHT (kN/m³)' : 'TRỌNG LƯỢNG RIÊNG (kN/m³)', 'head'),
    tx('gk (kN/m²)', 'head'), tx('γf', 'head'), tx('g (kN/m²)', 'head')]);
  const slab = R.slabs.find((S2x) => S2x.kind === 'floor')?.slab ?? 120;
  const kinds = [['floor', en ? 'Floors' : 'Sàn phòng ở'], ['wet', en ? 'Toilets (with waterproofing)' : 'Sàn vệ sinh (có chống thấm)'], ['terrace', en ? 'Roof terrace' : 'Sân thượng'], ['roof', en ? 'Roof' : 'Mái'], ['stair', en ? 'Stairs (on plan)' : 'Cầu thang (quy đổi trên mặt bằng)']];
  for (const [kind, title] of kinds) {
    rows2.push([tx(title, 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section')]);
    const first = rows2.length + 1;
    const list = kind === 'wet' ? [...BUILDUP.floor, ...BUILDUP.wet] : BUILDUP[kind];
    for (const L of list) {
      const r = rows2.length + 1;
      if (L === 'SLAB') rows2.push([tx(en ? `RC slab ${slab}` : `Sàn BTCT dày ${slab}`), inp(slab / 1000), inp(25), f(`B${r}*C${r}`), inp(1.1), f(`D${r}*E${r}`)]);
      else if (L[2] === null) rows2.push([tx(en ? L[1] : L[0]), tx(''), tx(''), inp(L[3]), inp(L[4]), f(`D${r}*E${r}`)]);
      else rows2.push([tx(en ? L[1] : L[0]), inp(L[2]), inp(L[3]), f(`B${r}*C${r}`), inp(L[4]), f(`D${r}*E${r}`)]);
    }
    const last = rows2.length;
    rows2.push([tx(en ? 'Total' : 'Tổng', 'bold'), '', '', f(`SUM(D${first}:D${last})`, 'boldNum'), '', f(`SUM(F${first}:F${last})`, 'boldNum')]);
  }
  rows2.push([]);
  rows2.push([tx(en ? 'LIVE LOAD' : 'HOẠT TẢI', 'head'), tx('pk (kN/m²)', 'head'), tx('γf', 'head'), tx('p (kN/m²)', 'head')]);
  for (const L of [...LIVE, ROOF_LIVE]) {
    const r = rows2.length + 1;
    rows2.push([tx(en ? L.en : L.vi), inp(L.p), f(`IF(B${r}<2,1.3,1.2)`, 'num2'), f(`B${r}*C${r}`)]);
    void gammaLive;
  }
  rows2.push([]);
  rows2.push([tx(en ? 'WALLS (per m² of face)' : 'TƯỜNG (trên 1 m² mặt tường)', 'head'), tx(en ? 'THICKNESS (mm)' : 'DÀY (mm)', 'head'), tx(en ? 'BRICK (kN/m³)' : 'GẠCH (kN/m³)', 'head'),
    tx('gk (kN/m²)', 'head'), tx(en ? 'PLASTER 2 x 15' : 'TRÁT 2 x 15', 'head'), tx('g (kN/m²)', 'head')]);
  for (const t of [200, 100]) {
    const r = rows2.length + 1;
    rows2.push([tx(en ? `Brick wall ${t}` : `Tường gạch ${t}`), inp(t), inp(18), f(`B${r}/1000*C${r}+2*0.015*18`), tx('γf 1,1 / 1,3'), f(`B${r}/1000*C${r}*1.1+2*0.015*18*1.3`)]);
  }
  sheets.push({ name: S2, rows: rows2, widths: [46, 14, 16, 12, 12, 12] });

  // ---- beams: q from the load share and the analysis (inputs), the design by formulas
  const S3 = T.beams, rows3 = [];
  rows3.push([tx(en ? 'BEAMS: FORCES AND REINFORCEMENT (TCVN 5574:2018)' : 'DẦM: NỘI LỰC VÀ CỐT THÉP (TCVN 5574:2018)', 'title')], [tx(T.note, 'note')],
    [tx(en ? 'q: largest design load on the beam (slabs, walls, self-weight); kM, kQ: from the continuous beam analysis (M = k q L², Q = k q L): change q or the materials and the design follows.'
      : 'q: tải tính toán lớn nhất trên dầm (sàn, tường, bản thân); kM, kQ: từ phân tích dầm liên tục (M = k q L², Q = k q L): sửa q hoặc vật liệu, phần tính thép tự cập nhật.', 'note')]);
  const H3 = en
    ? ['SLAB', 'BEAM', 'No.', 'b (mm)', 'h (mm)', 'L max (m)', 'q (kN/m)', 'kM+', 'kM-', 'kQ', 'M+ (kNm)', 'M- (kNm)', 'Q (kN)', 'h0 (mm)', 'αm+', 'ξ+', 'As+ (mm²)', 'n+', 'Ø+', 'As+ chosen', 'CHECK +', 'αm-', 'ξ-', 'As- (mm²)', 'n-', 'Ø-', 'As- chosen', 'CHECK -', 'Qb,min (kN)', 'qsw req (N/mm)', 'Ø stirrup', 's max (mm)', 's (mm)', 'CHECK Q']
    : ['SÀN', 'DẦM', 'SL', 'b (mm)', 'h (mm)', 'L max (m)', 'q (kN/m)', 'kM+', 'kM-', 'kQ', 'M+ (kNm)', 'M- (kNm)', 'Q (kN)', 'h0 (mm)', 'αm+', 'ξ+', 'As+ (mm²)', 'n+', 'Ø+', 'As+ chọn', 'KT +', 'αm-', 'ξ-', 'As- (mm²)', 'n-', 'Ø-', 'As- chọn', 'KT -', 'Qb,min (kN)', 'qsw yc (N/mm)', 'Ø đai', 's max (mm)', 's chọn (mm)', 'KT Q'];
  rows3.push(H3.map((h) => tx(h, 'head')));
  const OK = en ? 'OK' : 'ĐẠT', NO = en ? 'FAILS' : 'KHÔNG ĐẠT';
  for (const S of R.slabs) {
    for (const t of S.types) {
      const r = rows3.length + 1;
      const L = Math.max(...t.spans);
      const q = t.q || 1e-9;
      const C = (k) => `${colName(k)}${r}`;
      rows3.push([
        tx(S.name), tx(t.name), t.count, inp(t.b), inp(t.h), L, inp(Math.round(t.q * 100) / 100),
        r4(t.Mspan / (q * L * L)), r4(Math.abs(t.Msup) / (q * L * L)), r4(t.Q / (q * L)),
        f(`${C(7)}*${C(6)}*${C(5)}^2`), f(`${C(8)}*${C(6)}*${C(5)}^2`), f(`${C(9)}*${C(6)}*${C(5)}`),
        f(`${C(4)}-${P('a')}`, 'int'),
        f(`${C(10)}*1000000/(${P('Rb')}*${C(3)}*${C(13)}^2)`, 'num3'), f(`1-SQRT(1-2*MIN(${C(14)},${P('aR')}))`, 'num3'),
        f(`MAX(${C(15)}*${P('Rb')}*${C(3)}*${C(13)}/${P('Rs')},0.001*${C(3)}*${C(13)})`, 'int'),
        inp(t.barsSpan.n), inp(t.barsSpan.d), f(`${C(17)}*PI()*${C(18)}^2/4`, 'int'),
        f(`IF(AND(${C(14)}<=${P('aR')},${C(19)}>=${C(16)}),"${OK}","${NO}")`, 'ok'),
        f(`${C(11)}*1000000/(${P('Rb')}*${C(3)}*${C(13)}^2)`, 'num3'), f(`1-SQRT(1-2*MIN(${C(21)},${P('aR')}))`, 'num3'),
        f(`MAX(${C(22)}*${P('Rb')}*${C(3)}*${C(13)}/${P('Rs')},0.001*${C(3)}*${C(13)})`, 'int'),
        inp(t.barsSup.n), inp(t.barsSup.d), f(`${C(24)}*PI()*${C(25)}^2/4`, 'int'),
        f(`IF(AND(${C(21)}<=${P('aR')},${C(26)}>=${C(23)}),"${OK}","${NO}")`, 'ok'),
        f(`0.5*${P('Rbt')}*${C(3)}*${C(13)}/1000`),
        f(`MAX((${C(12)}*1000-0.75*${P('Rbt')}*${C(3)}*${C(13)})/(1.5*${C(13)}),0.25*${P('Rbt')}*${C(3)})`),
        inp(t.stirrups.d),
        f(`MIN(${P('Rsw')}*2*PI()*${C(30)}^2/4/${C(29)},${P('Rbt')}*${C(3)}*${C(13)}^2/(${C(12)}*1000),${C(13)}/2,300)`, 'int'),
        inp(t.stirrups.support),
        f(`IF(AND(${C(32)}<=${C(31)},${C(12)}*1000<=0.3*${P('Rb')}*${C(3)}*${C(13)}),"${OK}","${NO}")`, 'ok'),
      ]);
    }
  }
  sheets.push({ name: S3, rows: rows3, widths: [12, 9, 5, 8, 8, 9, 9, 8, 8, 8, 10, 10, 9, 8, 8, 8, 10, 5, 5, 10, 11, 8, 8, 10, 5, 5, 10, 11, 10, 11, 7, 9, 9, 11], freeze: 5 });

  // ---- columns and footings
  const S4 = T.cols, rows4 = [];
  rows4.push([tx(en ? 'COLUMNS AND FOOTINGS' : 'CỘT VÀ MÓNG', 'title')], [tx(T.note, 'note')], []);
  rows4.push((en ? ['COLUMN', 'N (kN)', 'CAPACITY (kN)', 'COLUMN', 'Ntc (kN)', 'A REQ. (m²)', 'A FOOTING (m²)', 'FOOTING', 'SIDE REQ. (m)', 'NOTE']
    : ['CỘT', 'N (kN)', 'KHẢ NĂNG (kN)', 'KT CỘT', 'Ntc (kN)', 'A CẦN (m²)', 'A MÓNG (m²)', 'KT MÓNG', 'CẠNH CẦN (m)', 'GHI CHÚ']).map((h) => tx(h, 'head')));
  for (const col of R.columns) {
    const r = rows4.length + 1;
    const capF = f(`${P('phi')}*(${P('Rb')}*${P('cb')}*${P('ch')}+${P('Rsc')}*${P('cAs')})/1000`);
    const base = [tx(col.name), inp(col.N), capF, f(`IF(B${r}<=C${r},"${OK}","${NO}")`, 'ok'), f(`B${r}/${P('kn')}`)];
    if (col.on) rows4.push([...base, tx('-'), tx('-'), tx('-'), tx('-'), tx(en ? `on the ${col.on} beams` : `đặt trên dầm sàn ${col.on}`)]);
    else {
      rows4.push([...base, f(`E${r}/(${P('soil')}-${P('gtb')}*${P('Hm')})`), f(`${P('fB')}*${P('fL')}`), f(`IF(F${r}<=G${r},"${OK}","${NO}")`, 'ok'), f(`ROUNDUP(SQRT(F${r}),1)`, 'num2'), tx('')]);
    }
  }
  sheets.push({ name: S4, rows: rows4, widths: [16, 11, 15, 12, 11, 13, 14, 12, 14, 26] });

  if (!B) return xlsx(sheets);
  // ---- bar schedule: weights by formulas, totals by diameter
  const S5 = T.bars, rows5 = [];
  rows5.push([tx(en ? 'BAR SCHEDULE' : 'BẢNG THỐNG KÊ CỐT THÉP', 'title')], [tx(T.note, 'note')]);
  rows5.push((en ? ['MARK', 'SHAPE', 'Ø (mm)', 'BAR LENGTH (mm)', 'BARS / MEMBER', 'MEMBERS', 'TOTAL BARS', 'TOTAL LENGTH (m)', 'WEIGHT (kg)']
    : ['SỐ HIỆU', 'HÌNH DẠNG', 'Ø (mm)', 'DÀI 1 THANH (mm)', 'SỐ THANH/CK', 'SỐ CK', 'TỔNG SỐ THANH', 'TỔNG DÀI (m)', 'KHỐI LƯỢNG (kg)']).map((h) => tx(h, 'head')));
  const first5 = rows5.length + 1;
  for (const g of B.groups) {
    rows5.push([tx(g.title, 'section'), ...Array(8).fill(tx('', 'section'))]);
    for (const r0 of g.sched.rows) {
      const r = rows5.length + 1;
      rows5.push([tx(r0.mark), tx(r0.shape), inp(r0.d), inp(r0.length), inp(r0.n), inp(r0.members), f(`E${r}*F${r}`, 'int'), f(`G${r}*D${r}/1000`), f(`H${r}*C${r}^2/162`)]);
    }
  }
  const last5 = rows5.length;
  rows5.push([]);
  const ds = [...new Set(B.groups.flatMap((g) => g.sched.rows.map((x) => x.d)))].sort((a, b) => a - b);
  for (const d of ds) rows5.push([tx(`Ø${d}`, 'bold'), '', d, '', '', '', '', '', f(`SUMIF(C${first5}:C${last5},${d},I${first5}:I${last5})`, 'boldNum')]);
  const rSmall = rows5.length + 1;
  rows5.push([tx(`Ø ≤ 10 (${R.names.stirrupSteel})`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(C${first5}:C${last5},"<=10",I${first5}:I${last5})`, 'boldNum')]);
  const rLarge = rows5.length + 1;
  rows5.push([tx(`Ø > 10 (${R.names.steel})`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(C${first5}:C${last5},">10",I${first5}:I${last5})`, 'boldNum')]);
  rows5.push([tx(en ? 'TOTAL' : 'TỔNG CỘNG', 'bold'), '', '', '', '', '', '', '', f(`I${rSmall}+I${rLarge}`, 'boldNum')]);
  sheets.push({ name: S5, rows: rows5, widths: [12, 46, 8, 14, 12, 8, 12, 13, 14], freeze: 4 });

  // ---- quantities: the made-up-of text as the formula of the quantity; steel from the bar schedule
  const S6 = T.qty, rows6 = [];
  rows6.push([tx(en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ', 'title')], [tx(T.note, 'note')]);
  rows6.push((en ? ['No.', 'WORK ITEM', 'UNIT', 'QUANTITY', 'MADE UP OF'] : ['STT', 'HẠNG MỤC CÔNG VIỆC', 'ĐƠN VỊ', 'KHỐI LƯỢNG', 'DIỄN GIẢI']).map((h) => tx(h, 'head')));
  for (const q of B.quantities.rows) {
    if (q.head) {
      rows6.push([tx('', 'section'), tx(q.item, 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section')]);
      continue;
    }
    let cell;
    if (/Ø ≤ 10/.test(q.item)) cell = f(`${sref(S5, 8, rSmall)}/1000`, 'num3');
    else if (/Ø > 10/.test(q.item)) cell = f(`${sref(S5, 8, rLarge)}/1000`, 'num3');
    else {
      const e = howFormula(q.how);
      cell = e ? f(e, 'num3') : { v: q.q, s: 'num3' };
    }
    rows6.push([q.stt, tx(q.item), tx(q.unit), cell, tx(q.how ?? '')]);
  }
  sheets.push({ name: S6, rows: rows6, widths: [6, 58, 8, 13, 70], freeze: 4 });
  return xlsx(sheets);
}

/** The architectural finish quantities: one column per floor (values), the total by a formula of them. */
export function finishWorkbook(Q, floorNames, lang = 'vi') {
  const en = lang === 'en';
  const cols = [...floorNames, en ? 'WHOLE BUILDING' : 'CHUNG'];
  const rows = [];
  rows.push([tx(en ? 'ARCHITECTURAL FINISH QUANTITIES' : 'BẢNG KHỐI LƯỢNG HOÀN THIỆN KIẾN TRÚC', 'title')],
    [tx(en ? 'Quantities by floor (yellow, may be changed); the total is their sum. For estimating: the quantity surveyor checks them against the final drawings.'
      : 'Khối lượng theo từng tầng (ô màu vàng, sửa được); cột tổng là công thức cộng các tầng. Dùng lập dự toán: kỹ sư dự toán kiểm tra lại theo bản vẽ thi công.', 'note')]);
  rows.push([tx(en ? 'No.' : 'STT', 'head'), tx(en ? 'WORK ITEM' : 'HẠNG MỤC CÔNG VIỆC', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), ...cols.map((c) => tx(c, 'head')), tx(en ? 'TOTAL' : 'TỔNG', 'head'), tx(en ? 'NOTE' : 'GHI CHÚ', 'head')]);
  const c0 = 3, c1 = 3 + cols.length - 1;
  for (const q of Q.rows) {
    if (q.head) {
      rows.push([tx('', 'section'), tx(q.item, 'section'), ...Array(cols.length + 3).fill(tx('', 'section'))]);
      continue;
    }
    const r = rows.length + 1;
    const vals = cols.map((name, i) => {
      const v = i === cols.length - 1 ? q.by?.[''] : q.by?.[name];
      return v ? inp(v) : '';
    });
    rows.push([q.stt, tx(q.item), tx(q.unit), ...vals, f(`SUM(${colName(c0)}${r}:${colName(c1)}${r})`, 'boldNum'), tx(q.by?.[''] && q.how ? q.how : '')]);
  }
  return xlsx([{ name: en ? 'Finishes' : 'Hoàn thiện', rows, widths: [6, 66, 8, ...cols.map(() => 12), 13, 40], freeze: 4 }]);
}
