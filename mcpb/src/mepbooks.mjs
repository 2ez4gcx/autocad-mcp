// The electrical and plumbing calculations as live Excel workbooks: the inputs in yellow cells (loads, lengths, people,
// norms, fixture counts) and the rest as formulas of them (currents, breakers and cables chosen from their tables,
// voltage drops, flows, pipe sizes, tank, septic tank, quantities), so the sheets calculate again when a value changes.
import { CABLES, RATINGS } from './electrical.mjs';
import { FIXTURES, PPR } from './plumbing.mjs';
import { sref, xlsx } from './xlsx.mjs';

const inp = (v) => ({ v, s: typeof v === 'number' ? 'input' : 'inputText' });
const f = (formula, s = 'num2') => ({ f: formula, s });
const tx = (v, s = 'text') => ({ v, s });

const NOTE = {
  vi: {
    e: 'Ô màu vàng: số liệu nhập, sửa được; các ô khác là công thức, tự tính lại. Bảng tính sơ bộ: kỹ sư điện có chứng chỉ hành nghề kiểm tra, tính lại và ký xác nhận trước khi thi công.',
    p: 'Ô màu vàng: số liệu nhập, sửa được; các ô khác là công thức, tự tính lại. Bảng tính sơ bộ: kỹ sư cấp thoát nước có chứng chỉ hành nghề kiểm tra, tính lại và ký xác nhận trước khi thi công.',
  },
  en: {
    e: 'Yellow cells: inputs you may change; the others are formulas. Preliminary: a licensed electrical engineer checks, recalculates and signs it before construction.',
    p: 'Yellow cells: inputs you may change; the others are formulas. Preliminary: a licensed plumbing engineer checks, recalculates and signs it before construction.',
  },
};

/** Parameter sheet helper: rows [label, value, unit, note], refs by key. */
function params(name, title, note, en) {
  const rows = [[tx(title, 'title')], [tx(note, 'note')], [], [tx(en ? 'PARAMETER' : 'THÔNG SỐ', 'head'), tx(en ? 'VALUE' : 'GIÁ TRỊ', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), tx(en ? 'NOTE' : 'GHI CHÚ', 'head')]];
  const at = {};
  return {
    rows, at,
    add(key, label, value, unit = '', n = '') {
      rows.push([tx(label), value, tx(unit), tx(n)]);
      at[key] = rows.length;
    },
    ref: (key) => sref(name, 1, at[key]),
  };
}

/** The smallest value of the list (sorted) at least x: nested IFs (works in Excel and LibreOffice without arrays). */
const ladder = (x, list, last) => list.reduceRight((acc, v) => `IF(${x}<=${v},${v},${acc})`, String(last));

// ---------------------------------------------------------------- electrical

/** The smallest breaker and cable of each kind of circuit (the defaults of the design). */
const MIN_IN = { light: 10, socket: 20, ac: 16, heater: 20, hob: 32, pump: 16 };
const MIN_S = { light: 1.5, socket: 2.5, ac: 2.5, heater: 2.5, hob: 4, pump: 2.5 };

export function electricalWorkbook(D, Q, lang = 'vi') {
  const en = lang === 'en';
  const S1 = en ? 'Parameters' : 'Thông số', S2 = en ? 'Loads' : 'Phụ tải', S3 = en ? 'Quantities' : 'Khối lượng';
  const O = D.options;
  const p = params(S1, en ? 'ELECTRICAL CALCULATION - PARAMETERS' : 'BẢNG TÍNH ĐIỆN - THÔNG SỐ', NOTE[lang]?.e ?? NOTE.vi.e, en);
  p.add('U', en ? 'Voltage U' : 'Điện áp U', inp(O.voltage), 'V', en ? '1 phase' : '1 pha');
  p.add('cos', 'cos φ', inp(O.cosphi));
  p.add('rho', en ? 'Copper resistivity ρ' : 'Điện trở suất đồng ρ', inp(O.rho), 'Ω mm²/m');
  for (const [k, vi, enl] of [['light', 'Ks chiếu sáng', 'Ks lighting'], ['socket', 'Ks ổ cắm', 'Ks sockets'], ['ac', 'Ks điều hòa', 'Ks air conditioners'], ['heater', 'Ks bình nóng lạnh', 'Ks water heaters'], ['hob', 'Ks bếp', 'Ks hob'], ['pump', 'Ks bơm', 'Ks pump']]) {
    p.add(`ks_${k}`, en ? enl : vi, inp(O.ks[k] ?? 1));
  }
  p.add('kdt', en ? 'Kđt between the floor boards' : 'Kđt giữa các tủ tầng', inp(O.kdt));
  p.add('du', en ? 'Allowed voltage drop' : 'Sụt áp cho phép', inp(3), '%');
  p.add('allow', en ? 'Cable allowance' : 'Hệ số hao hụt dây', inp(0.1));
  p.rows.push([], [tx(en ? 'CABLE Cu/PVC (mm²)' : 'DÂY Cu/PVC (mm²)', 'head'), tx('Iz (A)', 'head')]);
  const cab = {};
  for (const [S, iz] of CABLES) {
    p.rows.push([inp(S), inp(iz)]);
    cab[S] = p.rows.length;
  }
  const cs = CABLES.map(([S]) => S);
  const iz = (S) => sref(S1, 1, cab[S]), sv = (S) => sref(S1, 0, cab[S]);
  // smallest cable S >= Smin with Iz >= In
  const cableF = (In, Smin) => cs.reduceRight((acc, S) => `IF(AND(${sv(S)}>=${Smin},${iz(S)}>=${In}),${sv(S)},${acc})`, '"?"');
  const sheets = [{ name: S1, rows: p.rows, widths: [44, 14, 12, 30] }];

  // ---- loads
  const H = en ? ['BOARD', 'CIRCUIT', 'FEEDS', 'P (W)', 'Ks', 'Ptt (W)', 'Itt (A)', 'In min (A)', 'In (A)', 'BREAKER', 'S min (mm²)', 'S (mm²)', 'L (m)', 'ΔU (%)', 'CHECK']
    : ['TỦ', 'MẠCH', 'PHỤ TẢI', 'P (W)', 'Ks', 'Ptt (W)', 'Itt (A)', 'In min (A)', 'In (A)', 'THIẾT BỊ', 'S min (mm²)', 'S (mm²)', 'L (m)', 'ΔU (%)', 'KIỂM TRA'];
  const rows = [[tx(en ? 'LOADS, BREAKERS AND CABLES' : 'BẢNG TÍNH PHỤ TẢI, CHỌN THIẾT BỊ BẢO VỆ VÀ DÂY DẪN', 'title')], [tx(NOTE[lang]?.e ?? NOTE.vi.e, 'note')], [], H.map((h) => tx(h, 'head'))];
  const U = p.ref('U'), COS = p.ref('cos'), RHO = p.ref('rho'), DU = p.ref('du');
  const OK = en ? 'OK' : 'ĐẠT', NO = en ? 'FAILS' : 'KHÔNG ĐẠT';
  const boardRows = [];
  for (const B of D.boards) {
    const first = rows.length + 1;
    for (const C of B.circuits) {
      const r = rows.length + 1;
      const share = C.kind === 'light' || C.kind === 'socket' ? `*E${r}` : '';
      rows.push([tx(B.id), tx(C.id), tx(`${C.name}: ${C.rooms.join(', ')}`), inp(C.P), f(p.ref(`ks_${C.kind}`)), f(`D${r}*E${r}`, 'num2'),
        f(`D${r}${share}/(${U}*${COS})`), inp(MIN_IN[C.kind] ?? 10), f(ladder(`MAX(G${r},H${r})`, RATINGS, 100), 'int'),
        inp(C.breaker.replace(/ \d+A$/, '')), inp(MIN_S[C.kind] ?? 1.5), f(cableF(`I${r}`, `K${r}`)), inp(C.length),
        f(`2*M${r}*G${r}*${RHO}/L${r}/${U}*100`), f(`IF(N${r}<=${DU},"${OK}","${NO}")`, 'text')]);
    }
    const last = rows.length;
    const r = rows.length + 1;
    rows.push([tx(B.id, 'bold'), tx(en ? 'TOTAL' : 'TỔNG', 'bold'), tx(en ? `${B.floors.join(', ')}; feeder from TĐ-T` : `${B.floors.join(', ')}; cáp cấp từ TĐ-T`, 'bold'),
      f(`SUM(D${first}:D${last})`, 'boldNum'), tx(''), f(`SUM(F${first}:F${last})`, 'boldNum'), f(`F${r}/(${U}*${COS})`, 'boldNum'), inp(32),
      f(ladder(`MAX(G${r},H${r})`, RATINGS, 100), 'int'), inp('MCB 2P'), inp(6), f(cableF(`I${r}`, `K${r}`)), inp(B.feeder_length),
      f(`2*M${r}*G${r}*${RHO}/L${r}/${U}*100`), f(`IF(N${r}<=${DU},"${OK}","${NO}")`, 'text')]);
    boardRows.push(r);
  }
  const rm = rows.length + 1;
  rows.push([tx('TĐ-T', 'bold'), tx(en ? 'MAIN' : 'TỔNG', 'bold'), tx(en ? 'all floor boards x Kđt' : 'các tủ tầng x Kđt', 'bold'), f(boardRows.map((r) => `D${r}`).join('+'), 'boldNum'),
    f(p.ref('kdt')), f(`E${rm}*(${boardRows.map((r) => `F${r}`).join('+')})`, 'boldNum'), f(`F${rm}/(${U}*${COS})`, 'boldNum'), inp(63),
    f(ladder(`MAX(G${rm},H${rm})`, RATINGS, 100), 'int'), inp('MCB 2P'), inp(16), f(cableF(`I${rm}`, `K${rm}`)), inp(15), f(`2*M${rm}*G${rm}*${RHO}/L${rm}/${U}*100`), f(`IF(N${rm}<=${DU},"${OK}","${NO}")`, 'text')]);
  rows.push([], [tx(en ? 'In: the smallest rating at least Itt and In min; S: the smallest cable with Iz ≥ In and at least S min. Lengths from the drawing (edit them after the routes are set).'
    : 'In: cỡ nhỏ nhất không nhỏ hơn Itt và In min; S: tiết diện nhỏ nhất có Iz ≥ In và không nhỏ hơn S min. Chiều dài lấy theo bản vẽ (sửa khi đã chốt tuyến dây).', 'note')]);
  const lastLoad = rm;
  sheets.push({ name: S2, rows, widths: [9, 9, 52, 10, 7, 10, 9, 10, 8, 16, 10, 9, 9, 9, 12], freeze: 5 });

  // ---- quantities: devices (from the drawing), breakers and cables (from the loads)
  const q = [[tx(en ? 'BILL OF QUANTITIES - ELECTRICAL' : 'BẢNG KHỐI LƯỢNG VẬT TƯ ĐIỆN', 'title')], [tx(NOTE[lang]?.e ?? NOTE.vi.e, 'note')], [],
    [tx(en ? 'No.' : 'STT', 'head'), tx(en ? 'ITEM' : 'HẠNG MỤC', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), tx(en ? 'QUANTITY' : 'KHỐI LƯỢNG', 'head'), tx(en ? 'MADE UP OF' : 'DIỄN GIẢI', 'head')]];
  const L2 = (c) => `'${S2}'!$${c}$5:$${c}$${lastLoad}`;
  let n = 0;
  for (const r of Q.rows) {
    if (r.head) {
      q.push([tx('', 'section'), tx(r.item, 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section')]);
      continue;
    }
    const m = /Cu\/PVC (\d+(?:,\d+)?)x(\d+(?:,\d+)?)\+E/.exec(r.item);
    let cell = inp(r.q);
    if (m && /^(Dây|Cable)/.test(r.item)) cell = f(`SUMIF(${L2('L')},${m[2].replace(',', '.')},${L2('M')})*(1+${p.ref('allow')})`);
    else if (/^(Ống luồn|PVC conduit)/.test(r.item)) cell = f(`SUM(${L2('M')})*(1+${p.ref('allow')})`);
    else {
      const b = /^(MCB|RCBO) (\dP)(?: 30mA)? (\d+)A$/.exec(r.item);
      if (b) cell = f(`COUNTIFS(${L2('J')},"${r.item.replace(/ \d+A$/, '')}",${L2('I')},${b[3]})${r.plus ? `+${r.plus}` : ''}`, 'int');
    }
    q.push([++n, tx(r.item), tx(r.unit), cell, tx(r.how ?? '')]);
  }
  sheets.push({ name: S3, rows: q, widths: [6, 60, 10, 14, 40], freeze: 5 });
  return xlsx(sheets);
}

// ---------------------------------------------------------------- plumbing

export function plumbingWorkbook(D, Q, lang = 'vi') {
  const en = lang === 'en';
  const S1 = en ? 'Parameters' : 'Thông số', S2 = en ? 'Supply' : 'Cấp nước', S3 = en ? 'Drainage' : 'Thoát nước', S4 = en ? 'Septic tank' : 'Bể tự hoại', S5 = en ? 'Quantities' : 'Khối lượng';
  const O = D.options, C = D.calc;
  const note = NOTE[lang]?.p ?? NOTE.vi.p;
  const p = params(S1, en ? 'PLUMBING CALCULATION - PARAMETERS' : 'BẢNG TÍNH CẤP THOÁT NƯỚC - THÔNG SỐ', note, en);
  p.add('N', en ? 'People' : 'Số người sử dụng', inp(O.people), en ? 'people' : 'người');
  p.add('q', en ? 'Daily norm q' : 'Tiêu chuẩn dùng nước q', inp(O.q_day), en ? 'l/person/day' : 'l/ng.ngđ', 'TCVN 4513:1988');
  p.add('a', 'a', inp(C.a), '', en ? 'TCVN 4513 table 9, by the daily norm (100: 2.2; 150: 2.15; 200: 2.14; 250: 2.05; 300: 2)' : 'TCVN 4513 bảng 9, theo tiêu chuẩn dùng nước (100: 2,2; 150: 2,15; 200: 2,14; 250: 2,05; 300: 2)');
  p.add('K', 'K', inp(C.K), '', en ? 'TCVN 4513 table 10, by N (to 300: 0.002; to 500: 0.003)' : 'TCVN 4513 bảng 10, theo N (đến 300: 0,002; đến 500: 0,003)');
  p.add('v', en ? 'Velocity limit v' : 'Vận tốc giới hạn v', inp(O.v_max), 'm/s');
  p.add('tank', en ? 'Roof tank' : 'Bồn mái', inp(O.tank), 'l');
  p.add('tankLevel', en ? 'Tank bottom level' : 'Cao độ đáy bồn', inp(C.tankBottom), 'm');
  p.add('showerLevel', en ? 'Highest shower rose level' : 'Cao độ vòi sen cao nhất', inp(C.showerLevel ?? 0), 'm');
  p.add('minHead', en ? 'Least free head at a shower' : 'Áp lực tự do tối thiểu tại vòi sen', inp(O.head_min), 'm', 'TCVN 4513:1988');
  p.add('goodHead', en ? 'Head a shower and a water heater work well with' : 'Cột áp để sen, bình nóng lạnh hoạt động tốt', inp(O.head_comfort), 'm');
  p.add('rk', en ? 'Rain factor K' : 'Hệ số K (thoát mưa)', inp(O.rain_k), '', 'TCVN 4474:1987');
  p.add('q5', en ? 'Rain intensity q5 (5 minutes)' : 'Cường độ mưa q5 (5 phút)', inp(O.rain_q5), 'l/s.ha', en ? 'by the site' : 'lấy theo địa phương');
  p.add('rainPipe', en ? `Capacity of a D${O.pipes.rain} roof drain` : `Khả năng thoát của phễu D${O.pipes.rain}`, inp(O.rain_pipe), 'l/s');
  p.add('t', en ? 'Septic tank: days of wastewater t' : 'Bể tự hoại: số ngày lưu nước t', inp(1), en ? 'day' : 'ngày');
  p.add('as', en ? 'Sludge a' : 'Lượng cặn a', inp(0.5), en ? 'l/person/day' : 'l/ng.ngđ');
  p.add('T', en ? 'Desludging period T' : 'Thời gian hút cặn T', inp(365), en ? 'days' : 'ngày');
  p.add('W1', en ? 'Moisture of fresh sludge W1' : 'Độ ẩm cặn tươi W1', inp(95), '%');
  p.add('W2', en ? 'Moisture of digested sludge W2' : 'Độ ẩm cặn đã lên men W2', inp(90), '%');
  p.add('Vmin', en ? 'Minimum useful volume' : 'Dung tích hữu ích tối thiểu', inp(O.septic_min), 'm³');
  p.add('H', en ? 'Water depth' : 'Chiều sâu nước', inp(1.2), 'm');
  p.add('B', en ? 'Inside width' : 'Chiều rộng lòng bể', inp(1.2), 'm');
  p.add('allow', en ? 'Pipe allowance' : 'Hệ số hao hụt ống', inp(0.1));
  p.rows.push([], [tx(en ? 'PPR PN10 OUTSIDE D (mm)' : 'ỐNG PPR PN10 D NGOÀI (mm)', 'head'), tx(en ? 'INSIDE (mm)' : 'ĐƯỜNG KÍNH TRONG (mm)', 'head')]);
  const ppr = {};
  for (const [d, di] of PPR) {
    p.rows.push([inp(d), inp(di)]);
    ppr[d] = p.rows.length;
  }
  const P_ = p.ref;
  const sheets = [{ name: S1, rows: p.rows, widths: [46, 14, 12, 36] }];

  // ---- supply
  const rows = [[tx(en ? 'WATER SUPPLY (TCVN 4513:1988)' : 'TÍNH TOÁN CẤP NƯỚC (TCVN 4513:1988)', 'title')], [tx(note, 'note')], [],
    [tx(en ? 'FIXTURE' : 'THIẾT BỊ', 'head'), tx(en ? 'COUNT' : 'SỐ LƯỢNG', 'head'), tx(en ? 'EQUIV. N' : 'ĐƯƠNG LƯỢNG N', 'head'), tx('q0 (l/s)', 'head'), tx('ΣN', 'head'), tx('Σq0 (l/s)', 'head')]];
  const fx = D.floors.flatMap((F) => F.fixtures);
  const first = rows.length + 1;
  const countRow = {};
  for (const kind of Object.keys(FIXTURES)) {
    const r = rows.length + 1;
    rows.push([tx(en ? FIXTURES[kind].en : FIXTURES[kind].vi), inp(fx.filter((x) => x.kind === kind).length), inp(FIXTURES[kind].N), inp(FIXTURES[kind].q), f(`B${r}*C${r}`), f(`B${r}*D${r}`, 'num3')]);
    countRow[kind] = r;
  }
  const last = rows.length;
  const rN = rows.length + 1;
  rows.push([tx(en ? 'Total' : 'Tổng', 'bold'), '', '', '', f(`SUM(E${first}:E${last})`, 'boldNum'), f(`SUM(F${first}:F${last})`, 'boldNum')]);
  rows.push([]);
  const res = (label, formula, unit = '', s = 'num2') => {
    rows.push([tx(label), f(formula, s), tx(unit)]);
    return rows.length;
  };
  const rq = res('q = MIN(0,2 · N^(1/a) + K · N; Σq0)', `MIN(0.2*E${rN}^(1/${P_('a')})+${P_('K')}*E${rN},F${rN})`, 'l/s', 'num3');
  const rd = res(en ? 'Inside diameter needed d = √(4 q / π v)' : 'Đường kính trong cần d = √(4 q / π v)', `SQRT(4*B${rq}/1000/(PI()*${P_('v')}))*1000`, 'mm');
  const pprSel = PPR.reduceRight((acc, [d]) => `IF(${sref(S1, 1, ppr[d])}>=B${rd},${sref(S1, 0, ppr[d])},${acc})`, '"> D63"');
  res(en ? 'Riser PPR chosen (outside D)' : 'Ống đứng cấp nước chọn PPR D', pprSel, 'mm', 'int');
  const rQd = res(en ? 'Daily demand Q = N q / 1000' : 'Lưu lượng ngày Q = N q / 1000', `${P_('N')}*${P_('q')}/1000`, en ? 'm³/day' : 'm³/ngđ');
  rows.push([tx(en ? 'Tank holds a day' : 'Bồn đủ 1 ngày dùng'), f(`IF(${P_('tank')}/1000>=B${rQd},"${en ? 'OK' : 'ĐẠT'}","${en ? 'FAILS' : 'KHÔNG ĐẠT'}")`, 'text')]);
  const rh = res(en ? 'Head at the highest shower' : 'Cột áp tại vòi sen cao nhất', `${P_('tankLevel')}-${P_('showerLevel')}`, 'm');
  rows.push([tx(en ? 'Head check' : 'Kiểm tra cột áp'), f(`IF(B${rh}<${P_('minHead')},"${en ? 'FAILS: BOOSTER PUMP NEEDED' : 'KHÔNG ĐẠT: PHẢI CÓ BƠM TĂNG ÁP'}",IF(B${rh}<${P_('goodHead')},"${en ? 'OVER THE MINIMUM; BOOSTER PUMP ADVISED' : 'ĐẠT TỐI THIỂU; NÊN LẮP BƠM TĂNG ÁP'}","${en ? 'OK' : 'ĐẠT'}"))`, 'text')]);
  sheets.push({ name: S2, rows, widths: [46, 14, 14, 12, 12, 12] });

  // ---- drainage and rainwater
  const r3 = [[tx(en ? 'DRAINAGE AND RAINWATER (TCVN 4474:1987)' : 'TÍNH TOÁN THOÁT NƯỚC (TCVN 4474:1987)', 'title')], [tx(note, 'note')], []];
  const row3 = (label, cell, unit = '') => {
    r3.push([tx(label), cell, tx(unit)]);
    return r3.length;
  };
  const qc = row3(en ? 'Supply flow qc (from the supply sheet)' : 'Lưu lượng cấp qc (bảng cấp nước)', f(`'${S2}'!B${rq}`, 'num3'), 'l/s');
  const q0 = row3(en ? 'Largest fixture discharge q0 max (WC)' : 'Lưu lượng xả lớn nhất q0 max (bồn cầu)', inp(1.6), 'l/s');
  row3(en ? 'Design flow q = qc + q0 max' : 'Lưu lượng tính toán q = qc + q0 max', f(`B${qc}+B${q0}`, 'num3'), 'l/s');
  row3(en ? `Soil stack D${O.pipes.soil}, waste stack D${O.pipes.waste_stack}` : `Ống đứng thoát xí D${O.pipes.soil}, thoát rửa D${O.pipes.waste_stack}`, inp(`D${O.pipes.soil} / D${O.pipes.waste_stack}`));
  r3.push([]);
  const F = row3(en ? 'Roof area F' : 'Diện tích mái thu nước F', inp(C.roofArea), 'm²');
  const nP = row3(en ? 'Downpipes' : 'Số ống đứng thoát mưa', inp(C.nDown || 1));
  const qr = row3(en ? 'q a downpipe = K x F / n x q5 / 10000' : 'q mỗi ống = K x F / n x q5 / 10000', f(`${P_('rk')}*B${F}/B${nP}*${P_('q5')}/10000`, 'num3'), 'l/s');
  r3.push([tx(en ? 'Check' : 'Kiểm tra'), f(`IF(B${qr}<=${P_('rainPipe')},"${en ? 'OK' : 'ĐẠT'}","${en ? 'MORE DOWNPIPES' : 'THÊM ỐNG ĐỨNG'}")`, 'text')]);
  sheets.push({ name: S3, rows: r3, widths: [52, 16, 10] });

  // ---- septic tank
  const r4 = [[tx(en ? 'SEPTIC TANK' : 'TÍNH TOÁN BỂ TỰ HOẠI', 'title')], [tx(note, 'note')], []];
  const row4 = (label, cell, unit = '') => {
    r4.push([tx(label), cell, tx(unit)]);
    return r4.length;
  };
  const wn = row4(en ? 'Wn = N q t / 1000' : 'Wn = N q t / 1000', f(`${P_('N')}*${P_('q')}*${P_('t')}/1000`, 'num3'), 'm³');
  const wc = row4(en ? 'Wc = a T (100 - W1) 0,7 1,2 N / ((100 - W2) 1000)' : 'Wc = a T (100 - W1) 0,7 1,2 N / ((100 - W2) 1000)', f(`${P_('as')}*${P_('T')}*(100-${P_('W1')})*0.7*1.2*${P_('N')}/((100-${P_('W2')})*1000)`, 'num3'), 'm³');
  const w = row4('W = Wn + Wc', f(`B${wn}+B${wc}`, 'num3'), 'm³');
  const v = row4(en ? 'V chosen = max(W rounded up to 0,5; V min)' : 'V chọn = max(W làm tròn lên 0,5; V tối thiểu)', f(`MAX(CEILING(B${w},0.5),${P_('Vmin')})`), 'm³');
  row4(en ? 'Inside length L = V / (B H)' : 'Chiều dài lòng bể L = V / (B H)', f(`CEILING(B${v}/(${P_('B')}*${P_('H')}),0.1)`), 'm');
  sheets.push({ name: S4, rows: r4, widths: [56, 14, 10] });

  // ---- quantities: pipes from the drawing (yellow) with the allowance, fixtures from the supply sheet
  const q = [[tx(en ? 'BILL OF QUANTITIES - PLUMBING' : 'BẢNG KHỐI LƯỢNG VẬT TƯ CẤP THOÁT NƯỚC', 'title')], [tx(note, 'note')], [],
    [tx(en ? 'No.' : 'STT', 'head'), tx(en ? 'ITEM' : 'HẠNG MỤC', 'head'), tx(en ? 'UNIT' : 'ĐƠN VỊ', 'head'), tx(en ? 'MEASURED' : 'ĐO TRÊN BẢN VẼ', 'head'), tx(en ? 'QUANTITY' : 'KHỐI LƯỢNG', 'head')]];
  let n = 0;
  for (const r of Q.rows) {
    if (r.head) {
      q.push([tx('', 'section'), tx(r.item, 'section'), tx('', 'section'), tx('', 'section'), tx('', 'section')]);
      continue;
    }
    const rr = q.length + 1;
    // the length measured on the drawing (before the allowance)
    const measured = r.m ?? null;
    if (measured !== null) {
      q.push([++n, tx(r.item), tx(r.unit), inp(measured), f(`D${rr}*(1+${P_('allow')})`)]);
      continue;
    }
    const kind = Object.keys(FIXTURES).find((k) => r.item === FIXTURES[k].vi || r.item === FIXTURES[k].en);
    q.push([++n, tx(r.item), tx(r.unit), tx(''), kind ? f(`'${S2}'!B${countRow[kind]}`, 'int') : inp(r.q)]);
  }
  sheets.push({ name: S5, rows: q, widths: [6, 60, 10, 16, 14], freeze: 5 });
  return xlsx(sheets);
}
