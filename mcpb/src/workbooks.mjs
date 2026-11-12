// The calculation and the quantities as live Excel workbooks: the inputs in yellow cells (materials, loads, soil,
// sections, bars, forces from the analysis) and everything else as formulas of them, so that the sheets calculate
// again when a value is changed. Built on xlsx.mjs.
import { BUILDUP, gammaLive, LIVE, ROOF_LIVE } from './calc.mjs';
import { showExpr } from './solids.mjs';
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
    params: 'Thông số', loads: 'Tải trọng', beams: 'Dầm', cols: 'Cột - Móng', bars: 'Thống kê thép', qty: 'Khối lượng', checks: 'Kiểm tra',
  },
  en: {
    note: 'Yellow cells: inputs you may change; the others are formulas that calculate again. Preliminary: a licensed structural engineer checks, recalculates and signs it before construction.',
    params: 'Parameters', loads: 'Loads', beams: 'Beams', cols: 'Columns - footings', bars: 'Bar schedule', qty: 'Quantities', checks: 'Checks',
  },
};

/**
 * The structural workbook: parameters, loads, beams, columns and footings; with B (boqSheets) the bars and quantities.
 * The load q of a beam is a formula of the Loads sheet (build-ups, live loads, walls) and of its own b, h; the load N
 * of a column is a formula of the q of the beams it carries (their reactions per unit of q, from the analysis) and of
 * its own section: a change of a load, a material or a section runs through the beams, the columns and the footings.
 */
export function kcWorkbook(R, B = null, lang = 'vi') {
  const en = lang === 'en', T = TXT[lang] ?? TXT.vi;
  const sheets = [];
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const sum = (xs) => xs.reduce((a, x) => a + x, 0);
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
  par('steel', en ? 'Bars Ø ≥ 10' : 'Thép Ø ≥ 10', inp(R.names.steel));
  par('Rs', 'Rs', inp(s.Rs), 'MPa');
  par('Rsc', 'Rsc', inp(s.Rsc), 'MPa');
  par('stir', en ? 'Bars Ø < 10, stirrups' : 'Thép Ø < 10, thép đai', inp(R.names.stirrupSteel));
  par('Rsw', 'Rsw', inp(sw.Rsw), 'MPa');
  par('Es', 'Es', inp(200000), 'MPa');
  par('a', en ? 'Bar centre to the face a' : 'Khoảng cách trọng tâm thép a', inp(40), 'mm');
  par('xiR', 'ξR = 0,8 / (1 + Rs / Es / 0,0035)', f(`0.8/(1+${P('Rs')}/${P('Es')}/0.0035)`, 'num3'));
  par('aR', 'αR = ξR (1 - ξR / 2)', f(`${P('xiR')}*(1-${P('xiR')}/2)`, 'num3'));
  par('gbt', en ? 'Unit weight of reinforced concrete' : 'Trọng lượng riêng bê tông cốt thép', inp(25), 'kN/m³');
  par('gfc', en ? 'γf of concrete' : 'Hệ số vượt tải bê tông γf', inp(1.1));
  par('soil', en ? 'Bearing pressure R (assumed)' : 'Áp lực tính toán của đất nền R (giả thiết)', inp(R.soil), 'kPa', en ? 'from the site investigation' : 'lấy theo khảo sát địa chất');
  par('Hm', en ? 'Footing depth Hm' : 'Chiều sâu chôn móng Hm', inp(R.depth / 1000), 'm');
  par('gtb', en ? 'Mean unit weight of footing and soil γtb' : 'Trọng lượng riêng TB móng và đất γtb', inp(20), 'kN/m³');
  par('k0', en ? 'Column effective length l0 = k H' : 'Chiều dài tính toán cột l0 = k H', inp(0.7), '', en ? 'frame with rigid joints' : 'khung nút cứng');
  par('kn', en ? 'Ntc = Ntt / k' : 'Quy đổi tải tiêu chuẩn Ntc = Ntt / k', inp(1.15));
  sheets.push({ name: S1, rows: rows1, widths: [46, 14, 10, 40] });

  // ---- loads: build-ups, live loads, walls
  const S2 = T.loads, rows2 = [];
  rows2.push([tx(en ? 'LOADS (TCVN 2737:2023)' : 'TẢI TRỌNG (TCVN 2737:2023)', 'title')], [tx(T.note, 'note')], []);
  rows2.push([tx(en ? 'LAYER' : 'LỚP', 'head'), tx(en ? 'THICKNESS (m)' : 'DÀY (m)', 'head'), tx(en ? 'UNIT WEIGHT (kN/m³)' : 'TRỌNG LƯỢNG RIÊNG (kN/m³)', 'head'),
    tx('gk (kN/m²)', 'head'), tx('γf', 'head'), tx('g (kN/m²)', 'head')]);
  const slab = R.slabs.find((S2x) => S2x.kind === 'floor')?.slab ?? 120;
  const kinds = [['floor', en ? 'Floors' : 'Sàn phòng ở'], ['wet', en ? 'Toilets, balconies (with waterproofing)' : 'Sàn vệ sinh, ban công (có chống thấm)'], ['terrace', en ? 'Roof terrace' : 'Sân thượng'], ['roof', en ? 'Roof' : 'Mái'], ['stair', en ? 'Stairs (on plan)' : 'Cầu thang (quy đổi trên mặt bằng)']];
  // where the totals stand (row) and what they are worth, for the formulas of the beams
  const gRow = {}, gVal = {}, pRow = {}, pVal = {}, wRow = {}, wVal = {};
  for (const [kind, title] of kinds) {
    rows2.push([tx(title, 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section')]);
    const first = rows2.length + 1;
    const list = kind === 'wet' ? [...BUILDUP.floor, ...BUILDUP.wet] : BUILDUP[kind];
    let g = 0;
    for (const L of list) {
      const r = rows2.length + 1;
      if (L === 'SLAB') {
        rows2.push([tx(en ? `RC slab ${slab}` : `Sàn BTCT dày ${slab}`), inp(slab / 1000), inp(25), f(`B${r}*C${r}`), inp(1.1), f(`D${r}*E${r}`)]);
        g += (slab / 1000) * 25 * 1.1;
      } else if (L[2] === null) {
        rows2.push([tx(en ? L[1] : L[0]), tx(''), tx(''), inp(L[3]), inp(L[4]), f(`D${r}*E${r}`)]);
        g += L[3] * L[4];
      } else {
        rows2.push([tx(en ? L[1] : L[0]), inp(L[2]), inp(L[3]), f(`B${r}*C${r}`), inp(L[4]), f(`D${r}*E${r}`)]);
        g += L[2] * L[3] * L[4];
      }
    }
    const last = rows2.length;
    rows2.push([tx(en ? 'Total' : 'Tổng', 'bold'), '', '', f(`SUM(D${first}:D${last})`, 'boldNum'), '', f(`SUM(F${first}:F${last})`, 'boldNum')]);
    gRow[kind] = rows2.length;
    gVal[kind] = g;
  }
  rows2.push([]);
  rows2.push([tx(en ? 'LIVE LOAD' : 'HOẠT TẢI', 'head'), tx('pk (kN/m²)', 'head'), tx('γf', 'head'), tx('p (kN/m²)', 'head')]);
  for (const L of [...LIVE, ROOF_LIVE]) {
    const r = rows2.length + 1;
    rows2.push([tx(en ? L.en : L.vi), inp(L.p), f(`IF(B${r}<2,1.3,1.2)`, 'num2'), f(`B${r}*C${r}`)]);
    pRow[L.key] = r;
    pVal[L.key] = L.p * gammaLive(L.p);
  }
  rows2.push([]);
  rows2.push([tx(en ? 'WALLS (per m² of face)' : 'TƯỜNG (trên 1 m² mặt tường)', 'head'), tx(en ? 'THICKNESS (mm)' : 'DÀY (mm)', 'head'), tx(en ? 'BRICK (kN/m³)' : 'GẠCH (kN/m³)', 'head'),
    tx('gk (kN/m²)', 'head'), tx(en ? 'PLASTER 2 x 15' : 'TRÁT 2 x 15', 'head'), tx('g (kN/m²)', 'head')]);
  // the wall thicknesses the building has
  const thick = [...new Set([200, 100, ...R.slabs.flatMap((S) => S.types.flatMap((t) => (t.terms ?? []).filter((x) => x.type === 'wall').map((x) => x.t)))])].sort((a, b) => b - a);
  for (const t of thick) {
    const r = rows2.length + 1;
    rows2.push([tx(en ? `Brick wall ${t}` : `Tường gạch ${t}`), inp(t), inp(18), f(`B${r}/1000*C${r}+2*0.015*18`), tx('γf 1,1 / 1,3'), f(`B${r}/1000*C${r}*1.1+2*0.015*18*1.3`)]);
    wRow[t] = r;
    wVal[t] = (t / 1000) * 18 * 1.1 + 2 * 0.015 * 18 * 1.3;
  }
  sheets.push({ name: S2, rows: rows2, widths: [46, 14, 16, 12, 12, 12] });

  // ---- beams: q from the Loads sheet, the forces by the coefficients of the analysis, the design by formulas
  const S3 = T.beams, rows3 = [];
  rows3.push([tx(en ? 'BEAMS: FORCES AND REINFORCEMENT (TCVN 5574:2018)' : 'DẦM: NỘI LỰC VÀ CỐT THÉP (TCVN 5574:2018)', 'title')], [tx(T.note, 'note')],
    [tx(en ? 'q: largest design load on the beam = Σ (share of the slab, m) x (g + p of the Loads sheet) + Σ (m² of wall per m) x (g of the wall) + self-weight from b, h + balconies; kM, kQ: from the continuous beam analysis (M = k q L², Q = k q L; they hold the point loads of beams and columns carried): change a load, a material or a section and the design follows.'
      : 'q: tải tính toán lớn nhất trên dầm = Σ (bề rộng truyền tải sàn, m) x (g + p ở sheet Tải trọng) + Σ (m² tường trên 1 m dầm) x (g tường) + trọng lượng bản thân theo b, h + ban công; kM, kQ: từ phân tích dầm liên tục (M = k q L², Q = k q L; đã gồm lực tập trung của dầm gác, cột cấy): sửa tải trọng, vật liệu hoặc tiết diện, phần tính thép tự cập nhật.', 'note')]);
  const H3 = en
    ? ['SLAB', 'BEAM', 'No.', 'b (mm)', 'h (mm)', 'L max (m)', 'q (kN/m)', 'kM+', 'kM-', 'kQ', 'M+ (kNm)', 'M- (kNm)', 'Q (kN)', 'h0 (mm)', 'αm+', 'ξ+', 'As+ (mm²)', 'n+', 'Ø+', 'As+ chosen', 'CHECK +', 'αm-', 'ξ-', 'As- (mm²)', 'n-', 'Ø-', 'As- chosen', 'CHECK -', 'Qb,min (kN)', 'qsw req (N/mm)', 'Ø stirrup', 's max (mm)', 's (mm)', 'CHECK Q']
    : ['SÀN', 'DẦM', 'SL', 'b (mm)', 'h (mm)', 'L max (m)', 'q (kN/m)', 'kM+', 'kM-', 'kQ', 'M+ (kNm)', 'M- (kNm)', 'Q (kN)', 'h0 (mm)', 'αm+', 'ξ+', 'As+ (mm²)', 'n+', 'Ø+', 'As+ chọn', 'KT +', 'αm-', 'ξ-', 'As- (mm²)', 'n-', 'Ø-', 'As- chọn', 'KT -', 'Qb,min (kN)', 'qsw yc (N/mm)', 'Ø đai', 's max (mm)', 's chọn (mm)', 'KT Q'];
  rows3.push(H3.map((h) => tx(h, 'head')));
  const OK = en ? 'OK' : 'ĐẠT', NO = en ? 'FAILS' : 'KHÔNG ĐẠT';
  const qCell = {}; // `${slab}|${beam}` -> the cell of its q on this sheet, and its value
  for (const S of R.slabs) {
    for (const t of S.types) {
      const r = rows3.length + 1;
      const L = Math.max(...t.spans);
      const q = t.q || 1e-9;
      const C = (k) => `${colName(k)}${r}`;
      // q as a formula of the Loads sheet: slab shares x (build-up + live load), walls, self-weight, the rest a number
      const coef = new Map();
      const add = (ref, val, k) => {
        const e = coef.get(ref) ?? { val, k: 0 };
        e.k += k;
        coef.set(ref, e);
      };
      let rest = 0, self = false, linked = (t.terms ?? []).length > 0;
      for (const m of t.terms ?? []) {
        if (m.type === 'slab' && gRow[m.build] && pRow[m.live] && (S.slab === slab || m.build === 'stair')) {
          add(sref(S2, 5, gRow[m.build]), gVal[m.build], m.k);
          add(sref(S2, 3, pRow[m.live]), pVal[m.live], m.k);
        } else if (m.type === 'wall' && wRow[m.t]) add(sref(S2, 5, wRow[m.t]), wVal[m.t], m.k);
        else if (m.type === 'self') self = true;
        else if (m.type === 'const') rest += m.g + m.p;
        else linked = false;
      }
      const web = Math.max(0, t.h - S.slab) / 1000;
      const parts = [...coef.entries()].map(([ref, e]) => `${r5(e.k)}*${ref}`);
      let value = sum([...coef.values()].map((e) => r5(e.k) * e.val)) + r5(rest);
      if (self) {
        parts.push(`${C(3)}/1000*MAX(0,${C(4)}-${S.slab})/1000*25*1.1+2*MAX(0,${C(4)}-${S.slab})/1000*0.015*18*1.3`);
        value += (t.b / 1000) * web * 25 * 1.1 + 2 * web * 0.015 * 18 * 1.3;
      }
      if (rest) parts.push(String(r5(rest)));
      // the formula stands only when it gives the load of the calculation; else the load is an input
      linked = linked && parts.length > 0 && Math.abs(value - t.q) < 0.01;
      qCell[`${S.name}|${t.name}`] = { ref: sref(S3, 6, r), q };
      rows3.push([
        tx(S.name), tx(t.name), t.count, inp(t.b), inp(t.h), L, linked ? f(parts.join('+')) : inp(Math.round(t.q * 100) / 100),
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
  sheets.push({ name: S3, rows: rows3, widths: [12, 9, 6, 9, 9, 9, 10, 8, 8, 8, 10, 10, 9, 8, 8, 8, 10, 8, 8, 10, 11, 8, 8, 10, 8, 8, 10, 11, 10, 11, 9, 9, 10, 11], freeze: 5 });

  // ---- columns and footings: N from the beams sheet, the section and the pad as the calculation sized them
  const S4 = T.cols, rows4 = [];
  rows4.push([tx(en ? 'COLUMNS AND PAD FOOTINGS' : 'CỘT VÀ MÓNG ĐƠN', 'title')], [tx(T.note, 'note')],
    [tx(en ? 'N = Σ k x q of the beams on the column (k: their reactions per unit of q, from the analysis) + the weight of the column b x h x ΣH; φ by l0/h (TCVN 5574:2018); pad: A = Ntc / (R - γtb Hm). Change b, h, the bars or the side of the pad to try another size.'
      : 'N = Σ k x q của các dầm gác lên cột (k: phản lực trên 1 đơn vị q, từ phân tích dầm) + trọng lượng cột b x h x ΣH; φ theo l0/h (TCVN 5574:2018); móng: A = Ntc / (R - γtb Hm). Sửa b, h, thép hoặc cạnh móng để thử tiết diện khác.', 'note')]);
  rows4.push((en ? ['COLUMN', 'MARK', 'b (mm)', 'h (mm)', 'n', 'Ø (mm)', 'As (mm²)', 'H storey (m)', 'l0/h', 'φ', 'ΣH (m)', 'N (kN)', 'CAPACITY (kN)', 'COLUMN', 'Ntc (kN)', 'A REQ. (m²)', 'SIDE REQ. (m)', 'PAD SIDE (m)', 'A PAD (m²)', 'FOOTING', 'NOTE']
    : ['CỘT', 'KÝ HIỆU', 'b (mm)', 'h (mm)', 'n', 'Ø (mm)', 'As (mm²)', 'H tầng (m)', 'l0/h', 'φ', 'ΣH (m)', 'N (kN)', 'KHẢ NĂNG (kN)', 'KT CỘT', 'Ntc (kN)', 'A CẦN (m²)', 'CẠNH CẦN (m)', 'CẠNH MÓNG (m)', 'A MÓNG (m²)', 'KT MÓNG', 'GHI CHÚ']).map((h) => tx(h, 'head')));
  for (const col of R.columns) {
    const r = rows4.length + 1;
    const C = (k) => `${colName(k)}${r}`;
    // the reactions of the beams on the column, per unit of the q of each beam type
    const coef = new Map();
    for (const lv of col.levels ?? []) {
      const total = sum(lv.parts.map((x) => x.R));
      for (const x of lv.parts) {
        const cell = qCell[`${lv.slab}|${x.beam}`];
        if (!cell) continue;
        // a level whose beams pull up on the column altogether hands it nothing
        const e = coef.get(cell.ref) ?? { q: cell.q, k: 0 };
        e.k += total > 0 ? x.R / cell.q : 0;
        coef.set(cell.ref, e);
      }
    }
    const own = (col.size[0] / 1000) * (col.size[1] / 1000) * 25 * 1.1 * (col.H ?? 0);
    const value = sum([...coef.values()].map((e) => r5(e.k) * e.q)) + own;
    const weight = `${C(2)}*${C(3)}/1000000*${P('gbt')}*${P('gfc')}*${C(10)}`;
    const linked = coef.size > 0 && Math.abs(value - col.N) < 0.15;
    const nCell = linked ? f([...[...coef.entries()].map(([ref, e]) => `${r5(e.k)}*${ref}`), weight].join('+')) : inp(col.N);
    const phi = `IF(${C(8)}<=6,0.92,IF(${C(8)}<=10,0.92-(${C(8)}-6)*0.005,IF(${C(8)}<=15,0.9-(${C(8)}-10)*0.014,IF(${C(8)}<=20,0.83-(${C(8)}-15)*0.026,MAX(0.3,0.7-(${C(8)}-20)*0.026)))))`;
    const base = [tx(col.name), tx(col.mark ?? ''), inp(col.size[0]), inp(col.size[1]), inp(col.bars.n), inp(col.bars.d), f(`${C(4)}*PI()*${C(5)}^2/4`, 'int'),
      inp(Math.round(Math.max(...(col.hs ?? []), 0) * 1000) / 1000), f(`${P('k0')}*${C(7)}*1000/MIN(${C(2)},${C(3)})`), f(phi, 'num3'), inp(Math.round((col.H ?? 0) * 1000) / 1000),
      nCell, f(`${C(9)}*(${P('Rb')}*${C(2)}*${C(3)}+${P('Rsc')}*${C(6)})/1000`), f(`IF(${C(11)}<=${C(12)},"${OK}","${NO}")`, 'ok'), f(`${C(11)}/${P('kn')}`)];
    if (col.on || !col.foot) rows4.push([...base, tx('-'), tx('-'), tx('-'), tx('-'), tx('-'), tx(col.on ? (en ? `on the ${col.on} beams` : `đặt trên dầm sàn ${col.on}`) : '')]);
    else {
      rows4.push([...base, f(`${C(14)}/(${P('soil')}-${P('gtb')}*${P('Hm')})`), f(`ROUNDUP(SQRT(${C(15)}),1)`, 'num2'), inp(col.foot.B / 1000), f(`${C(17)}^2`),
        f(`IF(${C(15)}<=${C(18)},"${OK}","${NO}")`, 'ok'), tx(`${col.foot.mark}: H = ${col.foot.H}, Ø${col.foot.mesh.d}a${col.foot.mesh.spacing}${col.first ? (en ? `; column up from ${col.first.size.join('x')}` : `; cột tăng từ ${col.first.size.join('x')}`) : ''}`)]);
    }
  }
  for (const n of R.foundation?.notes ?? []) rows4.push([], [tx(n, 'note')]);
  sheets.push({ name: S4, rows: rows4, widths: [16, 9, 8, 8, 6, 8, 10, 11, 8, 8, 9, 11, 14, 12, 11, 12, 13, 14, 12, 12, 44], freeze: 5 });

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
  // plain bars under 10 mm, ribbed bars from 10 mm (as the general notes and the calculation take them)
  const rSmall = rows5.length + 1;
  rows5.push([tx(`Ø < 10 (${R.names.stirrupSteel})`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(C${first5}:C${last5},"<10",I${first5}:I${last5})`, 'boldNum')]);
  const rLarge = rows5.length + 1;
  rows5.push([tx(`Ø ≥ 10 (${R.names.steel})`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(C${first5}:C${last5},">=10",I${first5}:I${last5})`, 'boldNum')]);
  const rTotal = rows5.length + 1;
  rows5.push([tx(en ? 'TOTAL' : 'TỔNG CỘNG', 'bold'), '', '', '', '', '', '', '', f(`I${rSmall}+I${rLarge}`, 'boldNum')]);
  // the diameter groups of the norms (Phụ lục VI, 5.6); the lengths of the schedule include the laps and the anchorage
  const rGroup = rows5.length + 1, rng = (c) => `${c}${first5}:${c}${last5}`;
  rows5.push([tx(`${en ? 'Group' : 'Nhóm'} Ø ≤ 10`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(${rng('C')},"<=10",${rng('I')})`, 'boldNum')]);
  rows5.push([tx(`${en ? 'Group' : 'Nhóm'} 10 < Ø ≤ 18`, 'bold'), '', '', '', '', '', '', '', f(`SUMIFS(${rng('I')},${rng('C')},">10",${rng('C')},"<=18")`, 'boldNum')]);
  rows5.push([tx(`${en ? 'Group' : 'Nhóm'} Ø > 18`, 'bold'), '', '', '', '', '', '', '', f(`SUMIF(${rng('C')},">18",${rng('I')})`, 'boldNum')]);
  sheets.push({ name: S5, rows: rows5, widths: [14, 58, 8, 14, 12, 8, 12, 13, 14], freeze: 4 });

  // ---- quantities as Bảng 6.2 of Phụ lục VI: every line of the bill made up of its like parts (mark, how many, the
  // calculation as a live formula for one part, all of them); the measured quantity is the sum of its parts, the
  // geometric one the same without what a rule adds; steel from the bar schedule
  const S6 = T.qty, rows6 = [], Q = B.quantities, W6 = 10;
  const blank = (st) => Array(W6).fill(tx('', st));
  rows6.push([tx(en ? 'BILL OF QUANTITIES' : 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ', 'title')], [tx(T.note, 'note')]);
  rows6.push([tx(Q.rules ? (en
    ? `Measured on the solid model of the structure by ${Q.rules.name}: every volume counted once (what lies in the slab thickness is slab, the column-beam node is beam); openings under ${Q.rules.void.masonry} m² (masonry, finishes), ${Q.rules.void.formwork} m² (formwork), ${Q.rules.void.concrete} m³ (concrete) are not deducted. GEOMETRIC: every opening deducted.`
    : `Đo trên mô hình khối của kết cấu theo ${Q.rules.name}: mỗi thể tích chỉ tính một lần (phần trong chiều dày sàn tính vào sàn, nút cột - dầm tính vào dầm); không trừ lỗ < ${Q.rules.void.masonry} m² (xây, trát), < ${Q.rules.void.formwork} m² (ván khuôn), < ${Q.rules.void.concrete} m³ (bê tông). HÌNH HỌC: trừ mọi lỗ mở.`) : '', 'note')]);
  rows6.push((en ? ['No.', 'DRAWING MARK', 'WORK ITEM', 'UNIT', 'LIKE PARTS', 'CALCULATION', 'ONE PART', 'ALL (MEASURED)', 'GEOMETRIC', 'NOTE']
    : ['STT', 'KÝ HIỆU BẢN VẼ', 'DANH MỤC CÔNG TÁC', 'ĐƠN VỊ', 'SỐ BỘ PHẬN GIỐNG NHAU', 'DIỄN GIẢI TÍNH TOÁN', 'KHỐI LƯỢNG MỘT BỘ PHẬN', 'KHỐI LƯỢNG TOÀN BỘ', 'KHỐI LƯỢNG HÌNH HỌC', 'GHI CHÚ']).map((h) => tx(h, 'head')));
  const at6 = {}, stt6 = {};
  for (const q of Q.rows) {
    if (q.head) {
      const row = blank('section');
      row[2] = tx(q.item, 'section');
      rows6.push(row);
      continue;
    }
    const r = rows6.length + 1, parts = q.parts ?? [];
    at6[q.key ?? q.stt] = r;
    stt6[q.key ?? q.stt] = q.stt;
    const steel = parts.find((x) => x.steel);
    if (steel) {
      const src = `${sref(S5, 8, steel.steel === 'small' ? rSmall : rLarge)}/1000`;
      rows6.push([q.stt, tx(''), tx(q.item, 'bold'), tx(q.unit), q.count ?? 1, tx(q.how ?? ''), f(src, 'num3'), f(`E${r}*G${r}`, 'boldNum3'), f(`H${r}`, 'boldNum3'), tx(S5)]);
      continue;
    }
    if (!parts.length) {
      // a line without parts (a bill made by other means): its made-up-of text as the formula when it is arithmetic
      const e = howFormula(q.how);
      rows6.push([q.stt, tx(''), tx(q.item, 'bold'), tx(q.unit), q.count ?? 1, tx(q.how ?? ''), tx(''), e ? f(e, 'boldNum3') : { v: q.q, s: 'boldNum3' }, e ? f(`H${r}`, 'boldNum3') : { v: q.geo ?? q.q, s: 'boldNum3' }, tx('')]);
      continue;
    }
    const a = r + 1, z = r + parts.length;
    rows6.push([q.stt, tx(''), tx(q.item, 'bold'), tx(q.unit), q.count ?? 1, tx(''), tx(''), f(`SUM(H${a}:H${z})`, 'boldNum3'), f(`SUM(I${a}:I${z})`, 'boldNum3'), tx(q.volume !== undefined ? `${en ? 'volume' : 'thể tích'} ${String(q.volume).replace('.', en ? '.' : ',')} m³` : '')]);
    parts.forEach((x, i) => {
      const k = a + i, live = /[*+/()]|\d-/.test(x.expr ?? '');
      const ids = x.ids ?? [];
      const note = x.rule ? x.label : x.model ? (en ? 'faces of the solid model' : 'mặt đo trên mô hình khối') : ids.length > 8 ? `${ids.slice(0, 8).join(', ')} ...` : ids.join(', ');
      // a part that is another line of the bill (the backfill: the excavation less the lines buried in it): a formula of
      // the geometric total of that line
      const src = x.from && at6[x.from.key] ? { f: `${x.from.k < 0 ? '-' : ''}I${at6[x.from.key]}`, text: `${x.from.k < 0 ? '- ' : ''}${en ? 'line' : 'dòng'} ${stt6[x.from.key]}` } : null;
      rows6.push([tx(''), tx(x.ref ?? ''), tx(x.rule ? '' : x.model || x.named ? x.label : ids.length ? '' : x.label ?? ''), tx(''), x.n, tx(src ? src.text : showExpr(x.expr, lang)),
        src ? f(src.f, 'num3') : live ? f(x.expr, 'num3') : { v: x.one, s: 'num3' }, f(`E${k}*G${k}`, 'num3'), x.rule ? tx('') : f(`H${k}`, 'num3'), tx(note)]);
    });
  }
  if (Q.notCounted?.length) {
    rows6.push([], [tx(''), tx(''), tx(en ? 'NOT INCLUDED' : 'CHƯA GỒM', 'bold')]);
    for (const x of Q.notCounted) rows6.push([tx(''), tx(''), tx(x.item), tx(''), tx(''), tx(x.why)]);
  }
  if (Q.assumed?.length) {
    rows6.push([], [tx(''), tx(''), tx(en ? 'ASSUMED' : 'GIẢ ĐỊNH', 'bold')]);
    for (const x of Q.assumed) rows6.push([tx(''), tx(''), tx(x.note ?? `${x.item}: ${x.value}`)]);
  }
  sheets.push({ name: S6, rows: rows6, widths: [6, 14, 52, 8, 11, 62, 13, 14, 14, 34], freeze: 5 });

  // ---- cross-checks: the two sides of each, the difference and the verdict as formulas; the lines of the bill and
  // the steel are read from their sheets
  if (Q.checks?.length) {
    const S7 = T.checks, rows7 = [];
    rows7.push([tx(en ? 'CROSS-CHECKS OF THE QUANTITIES' : 'KIỂM TRA CHÉO KHỐI LƯỢNG', 'title')], [tx(en ? 'Each check compares two ways to the same number: both sides, their difference and the verdict.' : 'Mỗi dòng so sánh hai cách tính cùng một đại lượng: hai vế, sai lệch và kết luận.', 'note')]);
    rows7.push((en ? ['No.', 'CHECK', 'LEFT', 'RIGHT', 'DIFFERENCE', 'TOLERANCE', 'RESULT', 'WHERE'] : ['STT', 'NỘI DUNG KIỂM TRA', 'VẾ TRÁI', 'VẾ PHẢI', 'SAI LỆCH', 'DUNG SAI', 'KẾT QUẢ', 'VỊ TRÍ']).map((h) => tx(h, 'head')));
    const geoOf = (test) => Q.rows.filter((q) => !q.head && test(q) && at6[q.key ?? q.stt]).map((q) => sref(S6, 8, at6[q.key ?? q.stt])).join('+');
    // the concrete lines of the solid model carry a flag (earth, fill and brick steps are m³ too)
    const flagged = Q.rows.some((q) => q.concrete);
    Q.checks.forEach((x, i) => {
      const r = rows7.length + 1;
      let lhs = { v: x.lhs, s: 'num3' }, rhs = { v: x.rhs, s: 'num3' };
      if (x.id === 'bill') lhs = f(geoOf((q) => (flagged ? q.concrete === true : q.unit === 'm³')), 'num3');
      else if (x.id === 'earth:balance' && at6.excavation && at6.backfill && at6.surplus) { lhs = f(`${sref(S6, 7, at6.backfill)}+${sref(S6, 7, at6.surplus)}`, 'num3'); rhs = f(sref(S6, 7, at6.excavation), 'num3'); }
      else if (x.id === 'formwork') lhs = f(geoOf((q) => /^fw_/.test(q.key ?? '')), 'num3');
      else if (x.id === 'steel') { lhs = f(`SUM(${ds.map((_, j) => sref(S5, 8, last5 + 2 + j)).join(',')})`, 'num3'); rhs = f(`SUM('${S5}'!I${first5}:I${last5})`, 'num3'); }
      else if (x.id === 'steel:groups') { lhs = f(`${sref(S5, 8, rGroup)}+${sref(S5, 8, rGroup + 1)}+${sref(S5, 8, rGroup + 2)}`, 'num3'); rhs = f(sref(S5, 8, rTotal), 'num3'); }
      rows7.push([i + 1, tx(x.name), lhs, rhs, f(`ABS(C${r}-D${r})`, 'num3'), { v: x.tol, s: 'text' }, f(`IF(AND(E${r}<=F${r},H${r}=""),"${en ? 'OK' : 'ĐẠT'}","${en ? 'FAILED' : 'KHÔNG ĐẠT'}")`, 'ok'), tx(x.where.join(', '))]);
    });
    sheets.push({ name: S7, rows: rows7, widths: [6, 84, 14, 14, 12, 12, 14, 40], freeze: 4 });
  }
  return xlsx(sheets);
}

// the finish workbook lives in its own module
export { finishWorkbook } from './finishbook.mjs';
