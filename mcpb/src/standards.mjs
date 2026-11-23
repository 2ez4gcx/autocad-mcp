// Drawing standards: the architectural layer set, text/dimension styles per plot scale, paper sizes and the title block.
// Pure functions (no AutoCAD): the server sends the results to the bridge.

// [name, color (ACI), linetype, lineweight (mm), plot, English description, Vietnamese description, role]
// AIA/NCS-style names: discipline letter - major group - minor group. One layer per kind of element, lineweights for
// monochrome plotting (monochrome.ctb + object lineweights).
const LAYER_TABLE = [
  ['S-GRID', 1, 'CENTER', 0.18, true, 'Structural grid lines', 'Trục định vị', 'grid'],
  ['S-GRID-IDEN', 7, 'Continuous', 0.25, true, 'Grid bubbles and labels', 'Ký hiệu trục', 'grid_tag'],
  ['S-COLS', 7, 'Continuous', 0.5, true, 'Columns (cut)', 'Cột (nét cắt)', 'column'],
  ['S-COLS-PATT', 8, 'Continuous', 0.09, true, 'Column hatch', 'Hatch cột', 'column_hatch'],
  ['S-BEAM', 8, 'HIDDEN', 0.18, true, 'Beams above (hidden)', 'Dầm phía trên (nét khuất)', 'beam'],
  ['S-CONC', 7, 'Continuous', 0.35, true, 'Concrete outlines (structural details)', 'Đường bao bê tông (chi tiết kết cấu)', 'concrete'],
  ['S-CONC-PATT', 8, 'Continuous', 0.09, true, 'Concrete hatch', 'Hatch bê tông', 'concrete_hatch'],
  ['S-REBR', 1, 'Continuous', 0.5, true, 'Main reinforcement', 'Cốt thép chủ', 'rebar'],
  ['S-REBR-STIR', 3, 'Continuous', 0.25, true, 'Stirrups and ties', 'Cốt đai', 'stirrup'],
  ['S-ANNO-TEXT', 7, 'Continuous', 0.18, true, 'Structural notes and bar marks', 'Ghi chú, số hiệu thép', 'struct_text'],
  ['S-ANNO-DIMS', 1, 'Continuous', 0.18, true, 'Structural dimensions', 'Kích thước kết cấu', 'struct_dims'],
  ['S-ANNO-SYMB', 7, 'Continuous', 0.25, true, 'Structural symbols: section marks, levels', 'Ký hiệu kết cấu: mặt cắt, cao độ', 'struct_symbol'],
  ['A-WALL', 7, 'Continuous', 0.5, true, 'Walls (cut)', 'Tường (nét cắt)', 'wall'],
  ['A-WALL-PATT', 8, 'Continuous', 0.09, true, 'Wall material hatch', 'Hatch vật liệu tường', 'wall_hatch'],
  ['A-DOOR', 3, 'Continuous', 0.25, true, 'Doors', 'Cửa đi', 'door'],
  ['A-GLAZ', 4, 'Continuous', 0.25, true, 'Windows and glazing', 'Cửa sổ, vách kính', 'window'],
  ['A-OPEN', 8, 'HIDDEN', 0.18, true, 'Openings and headers above (hidden)', 'Lỗ mở, lanh tô (nét khuất)', 'opening'],
  ['A-FLOR-STRS', 6, 'Continuous', 0.25, true, 'Stairs and ramps', 'Cầu thang, ram dốc', 'stair'],
  ['A-FLOR-LEVL', 8, 'Continuous', 0.18, true, 'Level changes and floor edges', 'Thay đổi cao độ, mép sàn', 'floor_edge'],
  ['A-FLOR-PATT', 8, 'Continuous', 0.09, true, 'Floor finish hatch', 'Hatch vật liệu sàn', 'floor_hatch'],
  ['A-WALL-FNSH', 30, 'Continuous', 0.35, true, 'Wall finish bands (interior plans)', 'Dải hoàn thiện tường (mặt bằng nội thất)', 'wall_finish'],
  ['A-FLOR-FIXT', 5, 'Continuous', 0.18, true, 'Sanitary fixtures', 'Thiết bị vệ sinh', 'fixture'],
  ['A-FURN', 8, 'Continuous', 0.18, true, 'Furniture', 'Nội thất', 'furniture'],
  ['A-FLOR-CASE', 30, 'Continuous', 0.25, true, 'Built-in joinery (casework)', 'Đồ gỗ đóng tại chỗ', 'casework'],
  ['A-CLNG', 7, 'Continuous', 0.25, true, 'Ceiling outlines and steps', 'Đường trần, giật cấp trần', 'ceiling'],
  ['A-CLNG-PATT', 8, 'Continuous', 0.09, true, 'Ceiling hatch', 'Hatch trần', 'ceiling_hatch'],
  ['E-LITE', 2, 'Continuous', 0.25, true, 'Light fixtures', 'Đèn', 'light'],
  ['E-LITE-STRP', 2, 'DASHED', 0.25, true, 'LED strips and cove lights', 'Đèn LED dây, đèn hắt', 'light_strip'],
  ['A-DETL', 7, 'Continuous', 0.25, true, 'Detail lines', 'Nét chi tiết', 'detail'],
  ['A-DETL-OTLN', 7, 'Continuous', 0.5, true, 'Detail cut outlines', 'Nét cắt chi tiết', 'detail_cut'],
  ['A-DETL-PATT', 8, 'Continuous', 0.09, true, 'Detail hatch', 'Hatch chi tiết', 'detail_hatch'],
  ['A-EQPM', 8, 'Continuous', 0.18, true, 'Equipment', 'Thiết bị', 'equipment'],
  ['A-ROOF', 2, 'Continuous', 0.35, true, 'Roof', 'Mái', 'roof'],
  ['A-ELEV', 7, 'Continuous', 0.25, true, 'Elevation lines', 'Nét mặt đứng', 'elevation'],
  ['A-ELEV-OTLN', 7, 'Continuous', 0.5, true, 'Elevation outlines and ground line', 'Đường bao mặt đứng, cốt nền', 'elevation_outline'],
  ['A-ELEV-PATT', 8, 'Continuous', 0.09, true, 'Elevation hatches (roof, cladding)', 'Hatch mặt đứng (mái, ốp)', 'elevation_hatch'],
  ['A-SECT', 7, 'Continuous', 0.5, true, 'Section cut lines', 'Nét cắt mặt cắt', 'section'],
  ['A-SECT-PATT', 8, 'Continuous', 0.09, true, 'Section hatch', 'Hatch mặt cắt', 'section_hatch'],
  ['A-HIDD', 8, 'HIDDEN', 0.18, true, 'Hidden and overhead lines', 'Nét khuất', 'hidden'],
  ['A-AREA', 30, 'Continuous', 0.09, false, 'Room area boundaries (not plotted)', 'Ranh diện tích phòng (không in)', 'area'],
  ['A-ANNO-ROOM', 7, 'Continuous', 0.25, true, 'Room names and areas', 'Tên phòng, diện tích', 'room_tag'],
  ['A-ANNO-TEXT', 7, 'Continuous', 0.18, true, 'Notes and text', 'Ghi chú', 'text'],
  ['A-ANNO-NOTE', 7, 'Continuous', 0.18, true, 'Material tags and keynotes', 'Ký hiệu vật liệu, ghi chú vật liệu', 'note'],
  ['A-ANNO-DIMS', 1, 'Continuous', 0.18, true, 'Dimensions', 'Kích thước', 'dims'],
  ['A-ANNO-SYMB', 7, 'Continuous', 0.25, true, 'Symbols: levels, section marks, north arrow', 'Ký hiệu: cao độ, mặt cắt, hướng bắc', 'symbol'],
  ['A-ANNO-TTLB', 7, 'Continuous', 0.35, true, 'Sheet frame and title block', 'Khung bản vẽ, khung tên', 'title'],
  ['A-ANNO-VPRT', 8, 'Continuous', 0.09, false, 'Viewports (not plotted)', 'Khung nhìn (không in)', 'viewport'],
  ['X-IMAGE', 8, 'Continuous', 0.09, false, 'Reference images (not plotted)', 'Ảnh tham chiếu (không in)', 'image'],
  ['X-REF', 8, 'Continuous', 0.09, true, 'Imported reference drawings', 'Bản vẽ tham chiếu nhập vào', 'reference'],
];

// The electrical and plumbing sets (setup_layers standard "mep"): devices, wiring, pipes by system, equipment, notes.
const MEP_LAYER_TABLE = [
  ['E-LITE-SWCH', 2, 'Continuous', 0.25, true, 'Switches', 'Công tắc', 'switch'],
  ['E-LITE-WIRE', 2, 'Continuous', 0.18, true, 'Lighting wiring', 'Dây dẫn chiếu sáng', 'light_wire'],
  ['E-POWR', 1, 'Continuous', 0.25, true, 'Sockets and outlets', 'Ổ cắm, đầu chờ thiết bị', 'power'],
  ['E-POWR-WIRE', 1, 'Continuous', 0.18, true, 'Power wiring', 'Dây dẫn ổ cắm, động lực', 'power_wire'],
  ['E-POWR-EQPM', 6, 'Continuous', 0.25, true, 'Electrical equipment: boards, air conditioners, water heaters, pumps', 'Thiết bị điện: tủ điện, điều hòa, bình nóng lạnh, bơm', 'elec_equipment'],
  ['E-COMM', 4, 'DASHED', 0.18, true, 'Data and TV outlets and cables', 'Điện nhẹ: mạng, truyền hình', 'comm'],
  ['E-GRND', 3, 'Continuous', 0.35, true, 'Earthing', 'Tiếp địa', 'earth'],
  ['E-ANNO-TEXT', 7, 'Continuous', 0.18, true, 'Electrical notes, circuit names, diagrams', 'Ghi chú điện, tên mạch, sơ đồ', 'elec_text'],
  ['P-DOMW-CWTR', 5, 'Continuous', 0.35, true, 'Cold water pipes', 'Ống cấp nước lạnh', 'cold_water'],
  ['P-DOMW-HWTR', 1, 'DASHED', 0.35, true, 'Hot water pipes', 'Ống cấp nước nóng', 'hot_water'],
  ['P-SANR-SOIL', 6, 'Continuous', 0.5, true, 'Soil pipes (WC)', 'Ống thoát xí', 'soil'],
  ['P-SANR-WAST', 3, 'DASHED', 0.35, true, 'Waste pipes', 'Ống thoát nước rửa', 'waste'],
  ['P-SANR-VENT', 8, 'HIDDEN', 0.25, true, 'Vent pipes', 'Ống thông hơi', 'vent'],
  ['P-STRM', 4, 'DASHDOT', 0.35, true, 'Rainwater pipes', 'Ống thoát nước mưa', 'rain'],
  ['P-EQPM', 6, 'Continuous', 0.35, true, 'Plumbing equipment: tank, pump, septic tank, manholes', 'Thiết bị cấp thoát nước: bồn, bơm, bể tự hoại, hố ga', 'plumb_equipment'],
  ['P-UGND', 3, 'HIDDEN', 0.35, true, 'Pipes and tanks under the ground floor slab', 'Ống, bể ngầm dưới sàn tầng 1', 'underground'],
  ['P-ANNO-TEXT', 7, 'Continuous', 0.18, true, 'Plumbing notes, pipe names, diagrams', 'Ghi chú cấp thoát nước, ký hiệu ống, sơ đồ', 'plumb_text'],
];

const layerRow = (mep) => ([name, color, linetype, lineweight, plot, en, vi, role]) => ({ name, color, linetype, lineweight, plot, en, vi, role, mep });
export const LAYERS = [...LAYER_TABLE.map(layerRow(false)), ...MEP_LAYER_TABLE.map(layerRow(true))];

/** Standard layer name by role (wall, door, dims...). */
export const ROLE = Object.fromEntries(LAYERS.map((l) => [l.role, l.name]));

/** Layer specs for setup_layers / layer_styles in the user's language (mep: also the electrical and plumbing layers). */
export function layerSpecs(language = 'vi', mep = true) {
  return LAYERS.filter((l) => mep || !l.mep).map((l) => ({
    name: l.name, color: l.color, linetype: l.linetype, lineweight: l.lineweight, plot: l.plot,
    description: language === 'en' ? l.en : l.vi,
  }));
}

/** {name: props} for every standard layer: the bridge creates a missing standard layer with these properties. */
export function layerStyles(language = 'vi', roleMap = {}) {
  const out = {};
  for (const s of layerSpecs(language)) {
    const { name, ...props } = s;
    out[name] = props;
  }
  // A role mapped to an existing layer of the drawing keeps that layer's own properties.
  for (const [role, name] of Object.entries(roleMap)) {
    if (name && ROLE[role] && name !== ROLE[role]) delete out[name];
  }
  return out;
}

export const TEXT_STYLE = 'MCP-ARIAL';
export const dimStyleName = (scale) => `MCP-1-${scale}`;

/** Styles for a drawing at another scale (elevation, section, detail): created if missing, the current ones kept. */
export function viewStyles(scale) {
  return {
    text_style: { name: TEXT_STYLE, font: 'Arial', width_factor: 1, set_current: false },
    dim_style: { name: dimStyleName(scale), scale, text_height: 2.5, arrow: 'tick', leader_arrow: 'small_dot', set_current: false },
  };
}

/** setup_styles parameters for a plot scale (1:scale), lengths in mm. */
export function styleParams({ scale = 100, font = 'Arial', textHeight = 2.5, arrow = 'tick', units = 'mm', setCurrent = true } = {}) {
  return {
    units,
    text_style: { name: TEXT_STYLE, font, width_factor: 1, set_current: setCurrent },
    dim_style: { name: dimStyleName(scale), scale, text_height: textHeight, arrow, leader_arrow: 'small_dot', set_current: setCurrent },
    // acadiso.lin patterns are in mm: 0.4 x scale gives ~10-13 mm dashes on paper; PSLTSCALE is turned off.
    ltscale: Math.round(scale * 0.4 * 100) / 100,
  };
}

export const STANDARD_SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 1000, 2000];

// ISO paper sizes (landscape width x height, mm).
export const PAPERS = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };

const TB_TEXT = {
  vi: {
    project: 'CÔNG TRÌNH', title: 'TÊN BẢN VẼ', scale: 'TỶ LỆ', date: 'NGÀY', drawn: 'THIẾT KẾ', checked: 'KIỂM TRA',
    number: 'SỐ BẢN VẼ', revision: 'LẦN SỬA', sheet: 'TỜ', client: 'CHỦ ĐẦU TƯ',
  },
  en: {
    project: 'PROJECT', title: 'DRAWING TITLE', scale: 'SCALE', date: 'DATE', drawn: 'DRAWN', checked: 'CHECKED',
    number: 'DRAWING NO.', revision: 'REV.', sheet: 'SHEET', client: 'CLIENT',
  },
};

/**
 * Sheet frame + title block in paper space (mm), ISO 5457 / TCVN style: 20 mm binding margin on the left (10 mm on A4),
 * 10 mm elsewhere (5 mm on A4), title block 180 mm wide in the bottom-right corner.
 * Returns {entities, area: [[x0,y0],[x1,y1]] larger free drawing area for the viewport, areas: both (larger first), size: [w,h]}.
 */
export function titleBlock({ paper = 'A3', orientation = 'landscape', info = {}, language = 'vi', style } = {}) {
  const base = PAPERS[String(paper).toUpperCase()];
  if (!base) throw new Error(`paper must be one of ${Object.keys(PAPERS).join(', ')}`);
  const [W, H] = orientation === 'portrait' ? [base[1], base[0]] : base;
  const small = String(paper).toUpperCase() === 'A4';
  // the vertical strip of Vietnamese construction sets by default (every paper), the bottom block when asked
  if ((style ?? 'strip') === 'strip') return stripTitleBlock({ paper, orientation, info, language, W, H });
  const left = small ? 10 : 20;
  const m = small ? 5 : 10;
  const layer = ROLE.title;
  const T = TB_TEXT[language] || TB_TEXT.vi;
  // A block per paper, orientation and language: frame, grid and labels; the values are attributes (edited in the
  // properties palette or ATTEDIT, the same on every sheet).
  const e = [];
  const attributes = [];
  const values = {};
  const fit = {};
  const rect = (x0, y0, x1, y1, lw) => e.push({ type: 'rectangle', from: [x0, y0], to: [x1, y1], layer: '0', ...(lw ? { lineweight: lw } : {}) });
  const line = (x0, y0, x1, y1) => e.push({ type: 'line', from: [x0, y0], to: [x1, y1], layer: '0' });
  const label = (x, y, s) => e.push({ type: 'text', at: [x, y], text: s, height: 1.8, layer: '0', style: TEXT_STYLE });
  // every value has the width of its cell (fit): a longer one is narrowed by the bridge to stay inside
  const value = (x, y, tag, prompt, s, h = 2.5, align = 'left', width) => {
    attributes.push({ tag, prompt, at: [x, y], height: h, align, style: TEXT_STYLE });
    values[tag] = s === undefined || s === null ? '' : String(s);
    if (width) fit[tag] = width;
  };

  rect(0, 0, W, H, 0.09); // trim edge
  rect(left, m, W - m, H - m, 0.7); // frame
  const tbW = Math.min(180, W - left - m);
  const x0 = W - m - tbW;
  const x1 = W - m;
  const y0 = m;
  // Rows from the bottom: number/revision/sheet (12), scale/date/drawn/checked (10), title (16), project (12), company (10).
  const rows = [12, 10, 16, 12, 10];
  const ys = [y0];
  for (const r of rows) ys.push(ys[ys.length - 1] + r);
  const top = ys[ys.length - 1];
  rect(x0, y0, x1, top, 0.5);
  for (let i = 1; i < ys.length - 1; i++) line(x0, ys[i], x1, ys[i]);
  // Row 0: number | revision | sheet
  const c0 = [x0, x0 + 100, x0 + 140, x1];
  line(c0[1], ys[0], c0[1], ys[1]);
  line(c0[2], ys[0], c0[2], ys[1]);
  label(c0[0] + 2, ys[1] - 3.5, T.number);
  value(c0[0] + 2, ys[0] + 2.5, 'SO_BAN_VE', T.number, info.number, 4, 'left', c0[1] - c0[0] - 4);
  label(c0[1] + 2, ys[1] - 3.5, T.revision);
  value(c0[1] + 2, ys[0] + 2.5, 'LAN_SUA', T.revision, info.revision, 3.5, 'left', c0[2] - c0[1] - 4);
  label(c0[2] + 2, ys[1] - 3.5, T.sheet);
  value(c0[2] + 2, ys[0] + 2.5, 'TO', T.sheet, info.sheet, 3.5, 'left', c0[3] - c0[2] - 4);
  // Row 1: scale | date | drawn | checked
  const q = tbW / 4;
  for (let k = 1; k < 4; k++) line(x0 + k * q, ys[1], x0 + k * q, ys[2]);
  [[T.scale, 'TY_LE', info.scale], [T.date, 'NGAY', info.date], [T.drawn, 'THIET_KE', info.drawn_by], [T.checked, 'KIEM_TRA', info.checked_by]].forEach(([l, tag, v], k) => {
    label(x0 + k * q + 2, ys[2] - 3.2, l);
    value(x0 + k * q + 2, ys[1] + 1.8, tag, l, v, 2.5, 'left', q - 4);
  });
  // Row 2: drawing title (large)
  label(x0 + 2, ys[3] - 3.5, T.title);
  value(x0 + 2, ys[2] + 3, 'TEN_BAN_VE', T.title, info.title, 5, 'left', tbW - 4);
  // Row 3: project | client (always both cells, so one block serves every sheet)
  line(x0 + tbW * 0.6, ys[3], x0 + tbW * 0.6, ys[4]);
  label(x0 + 2, ys[4] - 3.5, T.project);
  value(x0 + 2, ys[3] + 2, 'CONG_TRINH', T.project, info.project, 3.5, 'left', tbW * 0.6 - 4);
  label(x0 + tbW * 0.6 + 2, ys[4] - 3.5, T.client);
  value(x0 + tbW * 0.6 + 2, ys[3] + 2, 'CHU_DAU_TU', T.client, info.client, 2.5, 'left', tbW * 0.4 - 4);
  // Row 4: company
  value((x0 + x1) / 2, ys[4] + 3, 'CONG_TY', language === 'en' ? 'Company' : 'Công ty', info.company, 4, 'center', tbW - 4);
  // Free drawing area: inside the frame, above the title block on the right-hand part.
  const area = [[left + 5, top + 5], [W - m - 5, H - m - 5]];
  const areaFull = [[left + 5, m + 5], [x0 - 5, H - m - 5]];
  // Both free areas, the larger first: full height left of the title block, or full width above it.
  const sz = (a) => (a[1][0] - a[0][0]) * (a[1][1] - a[0][1]);
  const areas = sz(areaFull) > sz(area) ? [areaFull, area] : [area, areaFull];
  const name = `MCP_KHUNG_TEN_${String(paper).toUpperCase()}_${orientation === 'portrait' ? 'DUNG' : 'NGANG'}${language === 'en' ? '_EN' : ''}`;
  const insert = {
    type: 'block', name, at: [0, 0], layer, attributes: values, fit,
    def: { name, description: `Khung tên ${String(paper).toUpperCase()} ${orientation}`, entities: e, attributes },
  };
  return { entities: [insert], area: areas[0], areas, size: [W, H] };
}

// ---------------------------------------------------------------- view titles

/** Width of a line of capitals of height h (Arial), slightly generous. */
export const capsWidth = (s, h) => [...String(s)].reduce((w, ch) => w + (ch === ' ' ? 0.39 : /[0-9]/.test(ch) ? 0.78 : 0.86), 0) * h;

/**
 * The title under a drawing (as Vietnamese construction sets do): the name, a line under it, the scale written 1/50
 * under the line. h = the name's height in paper mm.
 */
// the language of the tool call being drawn (set by the server before every tool): what a title falls back to
let drawingLanguage = 'vi';
export const setDrawingLanguage = (lang) => { drawingLanguage = lang === 'en' ? 'en' : 'vi'; };

/**
 * A test of whole words in a name, any case, Vietnamese or English: words('ĂN', 'DINING') finds "PHÒNG ĂN" but not
 * "VĂN PHÒNG" or "CĂN HỘ" (a Vietnamese syllable is not matched inside another; digits and punctuation end a word).
 */
export function words(...alts) {
  const re = new RegExp(`(?<![\\p{L}\\p{M}])(?:${alts.join('|')})(?![\\p{L}\\p{M}])`, 'iu');
  return { test: (s) => re.test(String(s ?? '').normalize('NFC')) };
}
export const getDrawingLanguage = () => drawingLanguage;

/**
 * What a room is, read from the whole words of its name (Vietnamese or English), the same in every engine: finishes,
 * doors, structure (loads, lowered slabs), quantities, electrical, plumbing. "SÂN KHẤU" (a stage) is no yard, "KHOA" no
 * store, "VĂN PHÒNG" no dining room.
 */
export const ROOM = {
  wet: words('WC', 'VỆ SINH', 'TẮM', 'TOILETS?', 'BATH', 'BATHROOMS?', 'WASHROOMS?', 'RESTROOMS?', 'SHOWER ROOM', 'SHOWER', 'POWDER ROOM', 'ENSUITE'),
  kitchen: words('BẾP', 'KITCHENS?', 'KITCHENETTE', 'PANTRY'),
  stairs: words('CẦU THANG', 'THANG BỘ', 'STAIRS?', 'STAIRCASE', 'STAIRWELL'),
  terrace: words('SÂN THƯỢNG', 'TERRACE', 'ROOFTOP'),
  balcony: words('BAN CÔNG', 'LÔ GIA', 'LOGIA', 'LOGGIA', 'SÂN PHƠI', 'BALCONY', 'BALCONIES'),
  outdoor: words('SÂN(?! KHẤU)', 'HIÊN', 'BAN CÔNG', 'LÔ GIA', 'LOGIA', 'LOGGIA', 'VƯỜN', 'BALCONY', 'BALCONIES', 'TERRACE', 'ROOFTOP', 'PORCH', 'YARD', 'BACKYARD', 'COURTYARD', 'PATIO', 'GARDEN'),
  hall: words('SẢNH', 'HÀNH LANG', 'HALL', 'HALLWAY', 'LOBBY', 'CORRIDOR', 'FOYER'),
  store: words('KHO', 'STORES?', 'STOREROOM', 'STORAGE'),
};

/**
 * The short tag of a floor in marks (S2-1, D2.1, BC3-1): the number at the end of its name, T for a stair tower (TUM),
 * else fallback (the place of the floor), else the initials of its name without accents (TẦNG LỬNG -> TL, ROOF -> R).
 */
export function floorTag(name, fallback = '') {
  const s = String(name ?? '');
  const m = /(\d+)\s*$/.exec(s);
  if (m) return m[1];
  if (/\bTUM\b/i.test(s)) return 'T';
  if (fallback) return fallback;
  const ini = s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'D').split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('');
  return ini;
}

export function viewTitle(text, cx, y, scale, layer, lang = drawingLanguage, h = 5, showScale = true) {
  const w = capsWidth(text, h * scale) / 2 + scale;
  const r = (v) => Math.round(v * 100) / 100;
  return [
    { type: 'text', text, at: [r(cx), r(y)], height: r(h * scale), align: 'center', layer, style: TEXT_STYLE },
    { type: 'line', from: [r(cx - w), r(y - 1.6 * scale)], to: [r(cx + w), r(y - 1.6 * scale)], layer },
    // tables and notes have no scale
    ...(showScale ? [{ type: 'text', text: lang === 'en' ? `SCALE 1:${scale}` : `TỶ LỆ: 1/${scale}`, at: [r(cx), r(y - 6.2 * scale)], height: r(0.6 * h * scale), align: 'center', layer, style: TEXT_STYLE }] : []),
  ];
}

// ---------------------------------------------------------------- cover sheet

/**
 * The cover of a set (tờ bìa): the set's name large, then project, item, client, designer, contractor, location and
 * date, framed; drawn at scale (paper mm x scale) to sit on its own sheet.
 */
export function coverSheet({ set = 'KIẾN TRÚC', info = {}, at = [0, 0], scale = 50, lang = 'vi' }) {
  const sc = scale, r = (v) => Math.round(v * 100) / 100;
  const L = lang === 'en'
    ? [['PROJECT', info.project], ['ITEM', info.item], ['CLIENT', info.client], ['DESIGN CONSULTANT', info.company], ['CONTRACTOR', info.contractor], ['LOCATION', info.location]]
    : [['CÔNG TRÌNH', info.project], ['HẠNG MỤC', info.item], ['CHỦ ĐẦU TƯ', info.client], ['ĐƠN VỊ THIẾT KẾ', info.company], ['TỔNG THẦU', info.contractor], ['ĐỊA ĐIỂM XÂY DỰNG', info.location]];
  const rows = L.filter(([, v]) => v);
  const W = 260, H = 70 + rows.length * 14 + 20;
  const out = [];
  const x0 = at[0], y1 = at[1], x1 = x0 + W * sc, y0 = y1 - H * sc;
  out.push({ type: 'rectangle', from: [r(x0), r(y0)], to: [r(x1), r(y1)], layer: ROLE.title });
  out.push({ type: 'rectangle', from: [r(x0 + 4 * sc), r(y0 + 4 * sc)], to: [r(x1 - 4 * sc), r(y1 - 4 * sc)], layer: ROLE.title });
  const title = lang === 'en' ? `${String(set).toUpperCase()} DRAWINGS` : `HỒ SƠ BẢN VẼ ${String(set).toUpperCase()}`;
  out.push({ type: 'text', text: title, at: [r((x0 + x1) / 2), r(y1 - 30 * sc)], height: r(10 * sc), align: 'center', layer: ROLE.text, style: TEXT_STYLE });
  if (info.phase) out.push({ type: 'text', text: `${lang === 'en' ? 'PHASE' : 'GIAI ĐOẠN'}: ${info.phase}`, at: [r((x0 + x1) / 2), r(y1 - 44 * sc)], height: r(5 * sc), align: 'center', layer: ROLE.text, style: TEXT_STYLE });
  rows.forEach(([k, v], i) => {
    const y = y1 - (66 + i * 14) * sc;
    out.push({ type: 'text', text: `${k}:`, at: [r(x0 + 30 * sc), r(y)], height: r(4.5 * sc), layer: ROLE.text, style: TEXT_STYLE });
    out.push({ type: 'text', text: String(v), at: [r(x0 + 100 * sc), r(y)], height: r(4.5 * sc), layer: ROLE.text, style: TEXT_STYLE });
  });
  out.push({ type: 'text', text: `${lang === 'en' ? 'DATE' : 'NGÀY'}: ${info.date ?? ''}`, at: [r((x0 + x1) / 2), r(y0 + 12 * sc)], height: r(4 * sc), align: 'center', layer: ROLE.text, style: TEXT_STYLE });
  return { entities: out };
}

// ---------------------------------------------------------------- drawing list

/** The drawing list of one set (kiến trúc, kết cấu, nội thất): a table of its sheets. */
export function drawingList({ sheets, at = [0, 0], scale = 50, item = '', lang = 'vi' }) {
  const head = lang === 'en' ? ['NO.', 'DRAWING NO.', 'DRAWING TITLE', 'SCALE', 'PAPER', 'NOTES'] : ['STT', 'KÝ HIỆU', 'TÊN BẢN VẼ', 'TỶ LỆ', 'KHỔ GIẤY', 'GHI CHÚ'];
  const rows = [head, ...sheets.map((s, i) => [i + 1, s.number ?? '', s.title ?? '', s.scale ?? '', s.paper ?? '', s.note ?? ''])];
  const title = `${lang === 'en' ? 'DRAWING LIST' : 'DANH MỤC BẢN VẼ'}${item ? ` - ${String(item).toUpperCase()}` : ''}`;
  return {
    entities: [{
      type: 'table', at, title, rows, height: 2.5 * scale, row_height: 8 * scale, col_widths: [12, 26, 95, 18, 22, 30].map((w) => w * scale),
      layer: ROLE.text, style: TEXT_STYLE,
    }],
  };
}

// ---------------------------------------------------------------- fields
// AutoCAD fields keep a text in step with the drawing. {h:HANDLE} is replaced by the bridge with the object id of that
// entity, {viewport} by the sheet's viewport (create_layout).

const numFormat = (dec, lang) => `%lu2%pr${dec}${lang === 'en' ? '' : '%ds44'}`;

export const FIELD = {
  /** The scale of the sheet's viewport, as its name (1:100). */
  viewportScale: '1:%<\\AcExpr (1/%<\\AcObjProp Object({viewport}).CustomScale>%) \\f "%lu2%pr0">%',
  /** The name of the layout it is on, in capitals (the sheet number). */
  layoutName: '%<\\AcVar ctab \\f "%tc1">%',
  /** The total area in m² of closed outlines (mm drawing), with the decimals and separator of the language. */
  areaM2: (handles, lang = 'vi', dec = 2) => `%<\\AcExpr (${handles.map((h) => `%<\\AcObjProp Object({h:${h}}).Area>%`).join('+')})*0.000001 \\f "${numFormat(dec, lang)}">%`,
  /** A table formula (cell names A1...: column letter, row from 1 counting the title row). */
  formula: (expr, lang = 'vi', dec = 2) => `%<\\AcExpr (${expr}) \\f "${numFormat(dec, lang)}">%`,
  /** A custom drawing property (DWGPROPS, Custom tab): the project data of the title blocks and the cover. */
  prop: (name) => `%<\\AcVar CustomDP.${name}>%`,
};

/** The cell widths of the values of every title block these tools make, by block name: {NAME: {TAG: width}}. */
export function titleBlockFits() {
  const out = {};
  for (const paper of Object.keys(PAPERS)) {
    for (const orientation of ['landscape', 'portrait']) {
      for (const language of ['vi', 'en']) {
        for (const style of ['strip', 'bottom']) {
          const ins = titleBlock({ paper, orientation, language, style }).entities[0];
          if (ins.fit && Object.keys(ins.fit).length) out[ins.name] = ins.fit;
        }
      }
    }
  }
  return out;
}

/** Whether a value is already a field code. */
export const isFieldCode = (v) => typeof v === 'string' && v.includes('%<\\');

/**
 * The project data a drawing keeps once, in its custom properties (named as the title block attributes that show it):
 * the title blocks and the cover show them through fields, so a change made once (update_title_blocks project, or
 * DWGPROPS in AutoCAD) reaches every sheet.
 */
export const PROJECT_PROPS = {
  project: 'CONG_TRINH', location: 'DIA_DIEM', item: 'HANG_MUC', client: 'CHU_DAU_TU', client_address: 'DIA_CHI_CDT',
  company: 'CONG_TY', company_address: 'DIA_CHI_TV', contractor: 'TONG_THAU', contract: 'SO_HD', phase: 'GIAI_DOAN',
  chief: 'CHU_NHIEM', lead: 'CHU_TRI', drawn_by: 'THIET_KE', checked_by: 'KIEM_TRA',
};

/**
 * The values to write in a title block or a cover: the project data given go to the drawing properties (changes, the
 * ones the drawing already has unchanged), and every project item the drawing has becomes the field of its property;
 * the others stay as given. have: the custom properties of the drawing (null: a bridge that keeps none, plain values).
 * Returns {values, write: {PROP: value} to store first}.
 */
export function projectValues(given, have) {
  const values = { ...(given || {}) };
  delete values.fields;
  if (!have || given?.fields === false) return { values, write: {} };
  const write = {};
  for (const [k, prop] of Object.entries(PROJECT_PROPS)) {
    const v = values[k];
    if (v === undefined || v === null || isFieldCode(v)) continue;
    if (String(have[prop] ?? '') !== String(v)) write[prop] = String(v);
  }
  const after = { ...have, ...write };
  for (const [k, prop] of Object.entries(PROJECT_PROPS)) if (String(after[prop] ?? '').trim()) values[k] = FIELD.prop(prop);
  return { values, write };
}

const STRIP_TEXT = {
  vi: {
    rev: ['LẦN NỘP', 'NỘI DUNG ĐIỀU CHỈNH', 'NGÀY NỘP'], notes: 'GHI CHÚ - Note:', client: 'CHỦ ĐẦU TƯ - Client:', project: 'DỰ ÁN - Project:',
    item: 'HẠNG MỤC - Item:', consultant: 'TƯ VẤN THIẾT KẾ - Consultant:', chief: 'CHỦ NHIỆM TK - Chief of Project', lead: 'CHỦ TRÌ TK - Chief of Division',
    drawn: 'THIẾT KẾ - Designed by', checked: 'KIỂM TRA - Checked by', title: 'TÊN BẢN VẼ - Drawing name:', contract: 'SỐ HĐ - Contract No:',
    version: 'PHIÊN BẢN - Version', phase: 'GIAI ĐOẠN - Phase:', number: 'KÝ HIỆU BẢN VẼ - Drawing No', scale: 'TỶ LỆ - Scale:', date: 'HOÀN THÀNH - Finish:',
    general: 'GHI CHÚ:', generalText: 'NHÀ THẦU THI CÔNG KIỂM TRA KÍCH THƯỚC THỰC TẾ, NẾU THẤY CÓ XUNG ĐỘT CẦN BÁO LẠI CHO THIẾT KẾ VÀ QUẢN LÝ KỸ THUẬT.',
  },
  en: {
    rev: ['REV.', 'DESCRIPTION', 'DATE'], notes: 'NOTES:', client: 'CLIENT:', project: 'PROJECT:', item: 'ITEM:', consultant: 'CONSULTANT:',
    chief: 'CHIEF OF PROJECT', lead: 'CHIEF OF DIVISION', drawn: 'DESIGNED BY', checked: 'CHECKED BY', title: 'DRAWING NAME:', contract: 'CONTRACT NO:',
    version: 'VERSION', phase: 'PHASE:', number: 'DRAWING NO', scale: 'SCALE:', date: 'DATE:',
    general: 'NOTE:', generalText: 'THE CONTRACTOR CHECKS ALL DIMENSIONS ON SITE AND REPORTS ANY CONFLICT TO THE DESIGNER.',
  },
};

/**
 * The width of a line of Arial of height h (the height of its capitals), a little generous, measured on a plot: capitals and digits, small letters, spaces and marks
 * each their own (the labels of the title strip mix both).
 */
export const textWidth = (s, h) => [...String(s).normalize('NFC')].reduce((w, ch) => w + (ch === ' ' ? 0.39 : /[0-9]/.test(ch) ? 0.78
  : /[.,:;\-–()/]/.test(ch) ? 0.4 : ch !== ch.toUpperCase() ? 0.75 : 0.93), 0) * h;

/** Two lines of at most n characters (whole words) for a long drawing name. */
function twoLines(s, n) {
  const words = String(s ?? '').split(/\s+/).filter(Boolean);
  const a = [];
  while (words.length && (a.join(' ').length + words[0].length + (a.length ? 1 : 0)) <= n) a.push(words.shift());
  return [a.join(' '), words.join(' ')];
}

/**
 * The vertical title strip on the right (as Vietnamese interior and construction sets): revisions, notes, client,
 * project, item, consultant, the people who sign, the drawing name, contract and version, phase and drawing number,
 * scale and date; a general note along the bottom. A block per paper and language; the values are attributes.
 */
function stripTitleBlock({ paper, orientation, info, language, W, H }) {
  const P0 = String(paper).toUpperCase();
  const left = P0 === 'A4' ? 15 : 20, m = P0 === 'A4' ? 7 : 10, sw = P0 === 'A4' ? 45 : P0 === 'A3' ? 50 : 60, band = 7;
  const layer = ROLE.title;
  const T = STRIP_TEXT[language] || STRIP_TEXT.vi;
  const e = [], attributes = [], values = {}, fit = {};
  const x1 = W - m, x0 = x1 - sw, xm = (x0 + x1) / 2;
  const line = (a, b, c, d, lw) => e.push({ type: 'line', from: [a, b], to: [c, d], layer: '0', ...(lw ? { lineweight: lw } : {}) });
  const rect = (a, b, c, d, lw) => e.push({ type: 'rectangle', from: [a, b], to: [c, d], layer: '0', ...(lw ? { lineweight: lw } : {}) });
  // a label is narrowed to the width of its cell (width factor), as the values are by the bridge
  const label = (x, y, s, h = 1.6, align = 'left', width = sw - 3) => {
    const w = textWidth(s, h);
    const wf = w > width ? Math.max(0.5, Math.floor((width / w) * 100) / 100) : 1;
    e.push({ type: 'text', at: [x, y], text: s, height: wf < 0.5 + 1e-9 && w * 0.5 > width ? Math.round(h * (width / (w * 0.5)) * 100) / 100 : h, layer: '0', style: TEXT_STYLE, align, ...(wf < 1 ? { width_factor: wf } : {}) });
  };
  // every value has the width of its cell: a longer one is narrowed by the bridge (fit) to stay inside
  const value = (x, y, tag, prompt, s, h = 2.2, align = 'left', width = sw - 3) => {
    attributes.push({ tag, prompt, at: [x, y], height: h, align, style: TEXT_STYLE });
    values[tag] = s === undefined || s === null ? '' : String(s);
    fit[tag] = width;
  };
  rect(0, 0, W, H, 0.09);
  rect(left, m, x1, H - m, 0.7);
  line(x0, m, x0, H - m, 0.5);
  // rows from the top, the notes box taking what is left
  const fixed = [['rev', 23], ['notes', 0], ['client', 22], ['project', 20], ['item', 9], ['consultant', 20], ['sign', 32], ['title', 16], ['contract', 8], ['number', 10], ['scale', 8]];
  const notesH = H - 2 * m - fixed.reduce((s, r) => s + r[1], 0);
  let y = H - m;
  const at = {};
  for (const [k, h] of fixed) {
    const hh = k === 'notes' ? notesH : h;
    at[k] = [y - hh, y];
    y -= hh;
    if (y > m + 0.1) line(x0, y, x1, y, 0.35);
  }
  // revisions: a header and four rows
  {
    const [b, t] = at.rev, c1 = x0 + 11, c2 = x1 - 13;
    line(c1, b, c1, t);
    line(c2, b, c2, t);
    line(x0, t - 7, x1, t - 7);
    label(x0 + 5.5, t - 4.2, T.rev[0], 1.4, 'center', c1 - x0 - 1.5);
    label((c1 + c2) / 2, t - 4.2, T.rev[1], 1.4, 'center', c2 - c1 - 1.5);
    label(x1 - 6.5, t - 4.2, T.rev[2], 1.4, 'center', x1 - c2 - 1.5);
    // the revisions given (info.revisions [{no, text, date}]) in the rows, the latest four
    const revs = Array.isArray(info.revisions) ? info.revisions.slice(-4) : [];
    for (let i = 1; i <= 4; i++) {
      const yy = t - 7 - 4 * i;
      if (i < 4) line(x0, yy, x1, yy);
      const rv = revs[i - 1];
      label(x0 + 5.5, yy + 1.2, String(i), 1.6, 'center');
      // attributes of the block, so each sheet carries its own revisions
      const room = Math.max(4, Math.floor((c2 - c1 - 2) / (1.4 * 0.62)));
      const tx = rv?.text ? String(rv.text) : '';
      value(c1 + 1, yy + 1.2, `REV${i}`, `${T.rev[1]} ${i}`, tx.length > room ? `${tx.slice(0, room - 1)}…` : tx, 1.4, 'left', c2 - c1 - 2);
      value(x1 - 6.5, yy + 1.2, `REV${i}_DATE`, `${T.rev[2]} ${i}`, rv?.date ?? '', 1.3, 'center', x1 - c2 - 1);
    }
  }
  label(x0 + 1.5, at.notes[1] - 3, T.notes);
  // client, project, item, consultant: a label, a name in the middle, an address under it
  const block = (k, lbl, tag, prompt, v, h, tag2, prompt2, v2) => {
    const [b, t] = at[k];
    label(x0 + 1.5, t - 3, lbl);
    // one line under the label (the item row is low): clear of the label, accents included
    value(xm, tag2 ? (b + t) / 2 + 0.5 : b + 1.6, tag, prompt, v, h, 'center');
    if (tag2) value(xm, b + 2.5, tag2, prompt2, v2, 1.6, 'center');
  };
  const en = language === 'en', pr = (vi, e) => (en ? e : vi);
  block('client', T.client, 'CHU_DAU_TU', pr('Chủ đầu tư', 'Client'), info.client, 2.4, 'DIA_CHI_CDT', pr('Địa chỉ chủ đầu tư', 'Client address'), info.client_address);
  block('project', T.project, 'CONG_TRINH', pr('Dự án', 'Project'), info.project, 2.8, 'DIA_DIEM', pr('Địa điểm', 'Location'), info.location);
  block('item', T.item, 'HANG_MUC', pr('Hạng mục', 'Item'), info.item, 2.2);
  block('consultant', T.consultant, 'CONG_TY', pr('Tư vấn thiết kế', 'Consultant'), info.company, 2.8, 'DIA_CHI_TV', pr('Địa chỉ tư vấn', 'Consultant address'), info.company_address);
  // the people who sign: a label and a name on the left, room for the signature on the right
  {
    const [b, t] = at.sign, xs = x0 + sw * 0.6;
    line(xs, b, xs, t);
    [[T.chief, 'CHU_NHIEM', info.chief], [T.lead, 'CHU_TRI', info.lead], [T.drawn, 'THIET_KE', info.drawn_by], [T.checked, 'KIEM_TRA', info.checked_by]].forEach(([l, tag, v], i) => {
      const yt = t - 8 * i;
      if (i) line(x0, yt, x1, yt);
      label(x0 + 1.5, yt - 2.6, l, 1.3, 'left', sw * 0.6 - 3);
      value(x0 + 1.5, yt - 6.6, tag, l, v, 2, 'left', sw * 0.6 - 3);
    });
  }
  {
    const [b, t] = at.title;
    label(x0 + 1.5, t - 3, T.title);
    const [l1, l2] = twoLines(info.title, 24);
    value(xm, b + 7.2, 'TEN_BAN_VE', T.title, l1, 2.6, 'center');
    value(xm, b + 2.6, 'TEN_BAN_VE_2', T.title, l2, 2.6, 'center');
  }
  const pair = (k, la, tagA, va, lb, tagB, vb, hb = 2.2) => {
    const [b, t] = at[k], xs = x0 + sw * 0.55;
    line(xs, b, xs, t);
    label(x0 + 1.2, t - 2.4, la, 1.3, 'left', xs - x0 - 2.4);
    value(x0 + 1.2, b + 1.2, tagA, la, va, 2, 'left', xs - x0 - 2.4);
    label(xs + 1.2, t - 2.4, lb, 1.3, 'left', x1 - xs - 2.4);
    value((xs + x1) / 2, b + 1.2, tagB, lb, vb, hb, 'center', x1 - xs - 2.4);
  };
  pair('contract', T.contract, 'SO_HD', info.contract, T.version, 'PHIEN_BAN', info.revision);
  pair('number', T.phase, 'GIAI_DOAN', info.phase, T.number, 'SO_BAN_VE', info.number, 3.2);
  pair('scale', T.scale, 'TY_LE', info.scale, T.date, 'NGAY', info.date);
  // the general note along the bottom of the drawing area
  line(left, m + band, x0, m + band, 0.35);
  label(left + 2, m + 2.3, T.general, 2.2);
  value(left + 16, m + 2.3, 'GHI_CHU_CHUNG', T.general, info.note ?? T.generalText, 2, 'left', x0 - left - 19);
  const area = [[left + 5, m + band + 5], [x0 - 5, H - m - 5]];
  // one block per paper and orientation (the geometry differs), the same layout of cells on all of them
  // _R: the strip with its revision rows as attributes (a drawing that has the strip of before keeps it as it was)
  const name = `MCP_KHUNG_TEN_DOC_${P0}_${orientation === 'portrait' ? 'DUNG' : 'NGANG'}${language === 'en' ? '_EN' : ''}_R`;
  const insert = {
    type: 'block', name, at: [0, 0], layer, attributes: values, fit,
    def: { name, description: `Khung tên dải dọc ${String(paper).toUpperCase()} ${orientation}`, entities: e, attributes },
  };
  return { entities: [insert], area, areas: [area], size: [W, H] };
}

/** Largest standard scale denominator that fits a model window (mm) into a paper area (mm). */
export function fitScale(windowSize, areaSize, unitsPerMm = 1) {
  const need = Math.max(windowSize[0] / areaSize[0], windowSize[1] / areaSize[1]) / unitsPerMm;
  return STANDARD_SCALES.find((s) => s >= need) ?? Math.ceil(need / 100) * 100;
}
