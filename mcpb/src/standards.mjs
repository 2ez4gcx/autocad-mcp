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

export const LAYERS = LAYER_TABLE.map(([name, color, linetype, lineweight, plot, en, vi, role]) =>
  ({ name, color, linetype, lineweight, plot, en, vi, role }));

/** Standard layer name by role (wall, door, dims...). */
export const ROLE = Object.fromEntries(LAYERS.map((l) => [l.role, l.name]));

/** Layer specs for setup_layers / layer_styles in the user's language. */
export function layerSpecs(language = 'vi') {
  return LAYERS.map((l) => ({
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
    dim_style: { name: dimStyleName(scale), scale, text_height: 2.5, arrow: 'tick', set_current: false },
  };
}

/** setup_styles parameters for a plot scale (1:scale), lengths in mm. */
export function styleParams({ scale = 100, font = 'Arial', textHeight = 2.5, arrow = 'tick', units = 'mm', setCurrent = true } = {}) {
  return {
    units,
    text_style: { name: TEXT_STYLE, font, width_factor: 1, set_current: setCurrent },
    dim_style: { name: dimStyleName(scale), scale, text_height: textHeight, arrow, set_current: setCurrent },
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
export function titleBlock({ paper = 'A3', orientation = 'landscape', info = {}, language = 'vi' } = {}) {
  const base = PAPERS[String(paper).toUpperCase()];
  if (!base) throw new Error(`paper must be one of ${Object.keys(PAPERS).join(', ')}`);
  const [W, H] = orientation === 'portrait' ? [base[1], base[0]] : base;
  const small = String(paper).toUpperCase() === 'A4';
  const left = small ? 10 : 20;
  const m = small ? 5 : 10;
  const layer = ROLE.title;
  const T = TB_TEXT[language] || TB_TEXT.vi;
  const e = [];
  const rect = (x0, y0, x1, y1, lw) => e.push({ type: 'rectangle', from: [x0, y0], to: [x1, y1], layer, ...(lw ? { lineweight: lw } : {}) });
  const line = (x0, y0, x1, y1) => e.push({ type: 'line', from: [x0, y0], to: [x1, y1], layer });
  const label = (x, y, s) => e.push({ type: 'text', at: [x, y], text: s, height: 1.8, layer, style: TEXT_STYLE });
  const value = (x, y, s, h = 2.5, align = 'left') => { if (s) e.push({ type: 'text', at: [x, y], text: String(s), height: h, layer, style: TEXT_STYLE, align }); };

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
  value(c0[0] + 2, ys[0] + 2.5, info.number, 4);
  label(c0[1] + 2, ys[1] - 3.5, T.revision);
  value(c0[1] + 2, ys[0] + 2.5, info.revision, 3.5);
  label(c0[2] + 2, ys[1] - 3.5, T.sheet);
  value(c0[2] + 2, ys[0] + 2.5, info.sheet, 3.5);
  // Row 1: scale | date | drawn | checked
  const q = tbW / 4;
  for (let k = 1; k < 4; k++) line(x0 + k * q, ys[1], x0 + k * q, ys[2]);
  [[T.scale, info.scale], [T.date, info.date], [T.drawn, info.drawn_by], [T.checked, info.checked_by]].forEach(([l, v], k) => {
    label(x0 + k * q + 2, ys[2] - 3.2, l);
    value(x0 + k * q + 2, ys[1] + 1.8, v, 2.5);
  });
  // Row 2: drawing title (large)
  label(x0 + 2, ys[3] - 3.5, T.title);
  value(x0 + 2, ys[2] + 3, info.title, 5);
  // Row 3: project (+ client on the right half)
  if (info.client) line(x0 + tbW * 0.6, ys[3], x0 + tbW * 0.6, ys[4]);
  label(x0 + 2, ys[4] - 3.5, T.project);
  value(x0 + 2, ys[3] + 2, info.project, 3.5);
  if (info.client) {
    label(x0 + tbW * 0.6 + 2, ys[4] - 3.5, T.client);
    value(x0 + tbW * 0.6 + 2, ys[3] + 2, info.client, 2.5);
  }
  // Row 4: company
  value((x0 + x1) / 2, ys[4] + 3, info.company, 4, 'center');
  // Free drawing area: inside the frame, above the title block on the right-hand part.
  const area = [[left + 5, top + 5], [W - m - 5, H - m - 5]];
  const areaFull = [[left + 5, m + 5], [x0 - 5, H - m - 5]];
  // Both free areas, the larger first: full height left of the title block, or full width above it.
  const sz = (a) => (a[1][0] - a[0][0]) * (a[1][1] - a[0][1]);
  const areas = sz(areaFull) > sz(area) ? [areaFull, area] : [area, areaFull];
  return { entities: e, area: areas[0], areas, size: [W, H] };
}

/** Largest standard scale denominator that fits a model window (mm) into a paper area (mm). */
export function fitScale(windowSize, areaSize, unitsPerMm = 1) {
  const need = Math.max(windowSize[0] / areaSize[0], windowSize[1] / areaSize[1]) / unitsPerMm;
  return STANDARD_SCALES.find((s) => s >= need) ?? Math.ceil(need / 100) * 100;
}
