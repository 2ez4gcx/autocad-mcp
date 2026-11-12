// Symbol blocks with attributes: grid bubbles, level marks, section marks, north arrow, bar marks, code tags, ceiling
// tags, lights, elevation keys. Annotation symbols are drawn in paper millimetres and inserted at the drawing scale
// (scale 100 = 1:100), so one definition serves every scale; lights are real size. Their values are attributes, so
// they can be edited (ATTEDIT, the properties palette) and counted (quantity_takeoff by block).
import { TEXT_STYLE } from './standards.mjs';

const T = TEXT_STYLE;
const attr = (tag, prompt, at, height, align = 'middle_center', extra = {}) => ({ tag, prompt, at, height, align, style: T, ...extra });
const tri = (a, b, c) => [{ type: 'polyline', points: [a, b, c], closed: true }, { type: 'hatch', boundary: [a, b, c], pattern: 'SOLID' }];

/** Width (paper mm) of a tag box holding n capitals of height h. */
const tagWidth = (n, h) => n * 0.95 * h + 1.2 * h;

const FIXED = {
  MCP_TRUC: {
    description: 'Ký hiệu trục / grid bubble',
    entities: [{ type: 'circle', center: [0, 0], radius: 4.5 }],
    attributes: [attr('SO', 'Tên trục', [0, 0], 4)],
  },
  MCP_COTE: {
    description: 'Ký hiệu cao độ / level mark',
    entities: [{ type: 'polyline', points: [[0, 0], [-1.5, 2.55], [1.5, 2.55]], closed: true }, { type: 'line', from: [-1.5, 2.55], to: [12, 2.55] }],
    attributes: [attr('COTE', 'Cao độ', [2.1, 3.3], 2.5, 'left')],
  },
  MCP_COTE_TRAI: {
    description: 'Ký hiệu cao độ, ghi bên trái / level mark to the left',
    entities: [{ type: 'polyline', points: [[0, 0], [-1.5, 2.55], [1.5, 2.55]], closed: true }, { type: 'line', from: [1.5, 2.55], to: [-12, 2.55] }],
    attributes: [attr('COTE', 'Cao độ', [-2.1, 3.3], 2.5, 'right')],
  },
  MCP_MUI_TEN: {
    description: 'Mũi tên hướng nhìn mặt cắt / section view arrow',
    entities: tri([3.5, 0], [0, 1.4], [0, -1.4]),
    attributes: [],
  },
  MCP_MAT_CAT: {
    description: 'Ký hiệu mặt cắt / section mark',
    entities: [{ type: 'circle', center: [0, 0], radius: 4 }],
    attributes: [attr('TEN', 'Tên mặt cắt', [0, 0], 3.5)],
  },
  MCP_HUONG_BAC: {
    description: 'Hướng bắc / north arrow',
    entities: [
      { type: 'circle', center: [0, 0], radius: 8 },
      { type: 'polyline', points: [[0, 8], [-3.6, -5.6], [0, 0], [3.6, -5.6]], closed: true },
      { type: 'hatch', boundary: [[0, 8], [0, 0], [3.6, -5.6]], pattern: 'SOLID' },
    ],
    attributes: [attr('KY_HIEU', 'Ký hiệu hướng bắc', [0, 12], 4)],
  },
  MCP_SO_HIEU: {
    description: 'Số hiệu thép / bar mark',
    entities: [{ type: 'circle', center: [0, 0], radius: 2.5 }],
    attributes: [attr('SH', 'Số hiệu thép', [0, 0], 2.5)],
  },
  MCP_KY_HIEU_MD: {
    description: 'Ký hiệu hướng nhìn mặt đứng nội thất A-D / interior elevation key',
    entities: (() => {
      const r = 3.5, out = [{ type: 'circle', center: [0, 0], radius: r }];
      [[0, 1, 'A'], [1, 0, 'B'], [0, -1, 'C'], [-1, 0, 'D']].forEach(([dx, dy, t]) => {
        const q = [-dy, dx];
        const tip = [dx * r * 1.9, dy * r * 1.9];
        const b1 = [dx * r * 0.9 + q[0] * r * 0.75, dy * r * 0.9 + q[1] * r * 0.75];
        const b2 = [dx * r * 0.9 - q[0] * r * 0.75, dy * r * 0.9 - q[1] * r * 0.75];
        out.push(...tri(tip, b1, b2));
        // the four letters clear of each other inside the circle
        out.push({ type: 'text', text: t, at: [dx * r * 0.58, dy * r * 0.58], height: 1.5, align: 'middle_center', style: T });
      });
      return out;
    })(),
    attributes: [attr('PHONG', 'Phòng', [0, -9], 2, 'middle_center', { invisible: true })],
  },
  // lights: real size (mm), the code as an invisible attribute for the schedule
  MCP_DEN_DOWNLIGHT: {
    description: 'Đèn downlight / downlight',
    entities: [{ type: 'circle', center: [0, 0], radius: 75 }, { type: 'line', from: [-115, 0], to: [115, 0] }, { type: 'line', from: [0, -115], to: [0, 115] }],
    attributes: [attr('MA', 'Mã đèn', [0, -150], 50, 'middle_center', { invisible: true })],
  },
  MCP_DEN_OP_TRAN: {
    description: 'Đèn ốp trần / ceiling lamp',
    entities: [{ type: 'circle', center: [0, 0], radius: 250 }, { type: 'circle', center: [0, 0], radius: 170 },
      { type: 'line', from: [-320, 0], to: [320, 0] }, { type: 'line', from: [0, -320], to: [0, 320] }],
    attributes: [attr('MA', 'Mã đèn', [0, -380], 50, 'middle_center', { invisible: true })],
  },
  MCP_DEN_THA: {
    description: 'Đèn thả / pendant',
    entities: [{ type: 'circle', center: [0, 0], radius: 200 }, { type: 'line', from: [-141.4, -141.4], to: [141.4, 141.4] }, { type: 'line', from: [-141.4, 141.4], to: [141.4, -141.4] }],
    attributes: [attr('MA', 'Mã đèn', [0, -260], 50, 'middle_center', { invisible: true })],
  },
  // floor drain at real size (150 grate), fall arrow in paper mm (tail at the insertion point, head 12 mm on)
  MCP_PHEU_THU: {
    description: 'Phễu thu sàn / floor drain',
    entities: [{ type: 'polyline', points: [[-75, -75], [75, -75], [75, 75], [-75, 75]], closed: true }, { type: 'circle', center: [0, 0], radius: 50 },
      { type: 'line', from: [-50, 0], to: [50, 0] }, { type: 'line', from: [0, -50], to: [0, 50] }],
    attributes: [attr('MA', 'Mã', [0, -110], 40, 'middle_center', { invisible: true })],
  },
  MCP_DOC: {
    description: 'Mũi tên dốc sàn / fall arrow',
    entities: [{ type: 'line', from: [0, 0], to: [10.5, 0] }, ...tri([12, 0], [10, 0.6], [10, -0.6])],
    attributes: [attr('I', 'Độ dốc', [6, 1.4], 2, 'center')],
  },
  MCP_DOC_NGUOC: {
    description: 'Mũi tên dốc sàn (đầu mũi tên ở gốc) / fall arrow, head at the insertion point',
    entities: [{ type: 'line', from: [1.5, 0], to: [12, 0] }, ...tri([0, 0], [2, 0.6], [2, -0.6])],
    attributes: [attr('I', 'Độ dốc', [6, 1.4], 2, 'center')],
  },
  MCP_DEN_LED_DAY: {
    description: 'Đèn LED dây (1 m) / LED strip',
    entities: [[-500, -340], [-220, -60], [60, 220], [340, 500]].map(([a, b]) => ({ type: 'line', from: [a, 0], to: [b, 0] })),
    attributes: [attr('MA', 'Mã đèn', [0, -80], 50, 'middle_center', { invisible: true })],
  },
  // wall light, real size: flat side on the wall (x = 0), facing +X
  MCP_DEN_TUONG: {
    description: 'Đèn gắn tường / wall light',
    entities: [{ type: 'arc', start: [0, -150], mid: [150, 0], end: [0, 150] }, { type: 'line', from: [0, -150], to: [0, 150] },
      { type: 'line', from: [10, -95], to: [110, 95] }, { type: 'line', from: [10, 95], to: [110, -95] }],
    attributes: [attr('MA', 'Mã đèn', [0, -200], 50, 'middle_center', { invisible: true })],
  },
  // ---- electrical devices, paper mm (inserted at the drawing scale), on the wall at x = 0, facing +X into the room
  MCP_E_CT_2C: {
    description: 'Công tắc 2 chiều / two-way switch',
    entities: [{ type: 'circle', center: [0, 0], radius: 0.9 }, { type: 'line', from: [0.9, 0], to: [3.6, 0] },
      { type: 'line', from: [3.6, 0], to: [3.6, 1.2] }, { type: 'line', from: [3, 0], to: [3, -1.2] }],
    attributes: [],
  },
  MCP_E_CT_2C_2: {
    description: 'Công tắc 2 chiều 2 hạt / two-way switch, two gangs',
    entities: [{ type: 'circle', center: [0, 0], radius: 0.9 }, { type: 'line', from: [0.9, 0], to: [3.6, 0] },
      { type: 'line', from: [3.6, 0], to: [3.6, 1.2] }, { type: 'line', from: [3, 0], to: [3, -1.2] },
      { type: 'line', from: [2.4, 0], to: [2.4, 1.2] }, { type: 'line', from: [1.8, 0], to: [1.8, -1.2] }],
    attributes: [],
  },
  MCP_E_OC: {
    description: 'Ổ cắm đôi 3 chấu +0.40 / double socket',
    entities: [...dome(1.6), { type: 'line', from: [0.55, -0.9], to: [0.55, 0.9] }],
    attributes: [],
  },
  MCP_E_OC_BEP: {
    description: 'Ổ cắm đôi trên mặt bếp +1.10 / worktop socket',
    entities: [...dome(1.6), { type: 'line', from: [0.55, -0.9], to: [0.55, 0.9] }, { type: 'line', from: [0, 0], to: [1.6, 0] }],
    attributes: [],
  },
  MCP_E_OC_CAO: {
    description: 'Ổ cắm đơn đặt cao (điều hòa +2.20, bình nóng lạnh +2.00) / high socket',
    entities: [...dome(1.6), { type: 'line', from: [1.6, 0], to: [2.8, 0] }],
    attributes: [],
  },
  MCP_E_OC_CN: {
    description: 'Ổ cắm chống nước có nắp / weatherproof socket',
    entities: [...dome(1.6), { type: 'hatch', boundary: domePts(1.6), pattern: 'SOLID' }],
    attributes: [],
  },
  MCP_E_DH: {
    description: 'Dàn lạnh điều hòa treo tường / air conditioner indoor unit',
    entities: [{ type: 'polyline', points: [[0, -4.5], [2.2, -4.5], [2.2, 4.5], [0, 4.5]], closed: true },
      ...[0.6, 1.1, 1.6].map((x) => ({ type: 'line', from: [x, -3.6], to: [x, 3.6] }))],
    attributes: [],
  },
  MCP_E_NL: {
    description: 'Bình nóng lạnh / water heater',
    entities: [{ type: 'polyline', points: [[0, -2.2], [2.6, -2.2], [2.6, 2.2], [0, 2.2]], closed: true },
      { type: 'polyline', points: [[1.3, -1.6], [0.7, -1], [1.9, -0.4], [0.7, 0.2], [1.9, 0.8], [1.3, 1.4]] }],
    attributes: [],
  },
  MCP_E_BT: {
    description: 'Đầu chờ bếp từ +0.60 / hob outlet',
    entities: [{ type: 'polyline', points: [[0, -1.2], [2.4, -1.2], [2.4, 1.2], [0, 1.2]], closed: true },
      { type: 'line', from: [0, -1.2], to: [2.4, 1.2] }, { type: 'line', from: [0, 1.2], to: [2.4, -1.2] }],
    attributes: [],
  },
  MCP_E_QH: {
    description: 'Quạt hút âm trần / ceiling extract fan',
    entities: [{ type: 'circle', center: [0, 0], radius: 1.7 }, { type: 'circle', center: [0, 0], radius: 0.4 },
      ...[90, 210, 330].map((a) => ({ type: 'line', from: polar(0.4, a), to: polar(1.5, a + 25) }))],
    attributes: [],
  },
  MCP_E_TD: {
    description: 'Tủ điện / distribution board',
    entities: [{ type: 'polyline', points: [[0, -3], [2.4, -3], [2.4, 3], [0, 3]], closed: true },
      { type: 'hatch', boundary: [[0, -3], [2.4, -3], [0, 3]], pattern: 'SOLID' }],
    attributes: [],
  },
  MCP_E_TM: {
    description: 'Tủ mạng, truyền hình / data cabinet',
    entities: [{ type: 'polyline', points: [[0, -2], [2.4, -2], [2.4, 2], [0, 2]], closed: true },
      { type: 'line', from: [0, -2], to: [2.4, 2] }, { type: 'line', from: [0, 2], to: [2.4, -2] }],
    attributes: [],
  },
  MCP_E_CTO: {
    description: 'Công tơ điện / electricity meter',
    entities: [{ type: 'polyline', points: [[0, -2], [3, -2], [3, 2], [0, 2]], closed: true }, { type: 'circle', center: [1.5, 0], radius: 1 },
      { type: 'line', from: [1.5, 0], to: [2.2, 0.7] }],
    attributes: [],
  },
  MCP_E_MANG: {
    description: 'Ổ cắm mạng RJ45 / data outlet',
    entities: [{ type: 'polyline', points: [[0, -1.4], [2.2, 0], [0, 1.4]], closed: true }, { type: 'line', from: [0.7, -0.9], to: [0.7, 0.9] }],
    attributes: [],
  },
  MCP_E_TV: {
    description: 'Ổ cắm truyền hình / TV outlet',
    entities: [{ type: 'polyline', points: [[0, -1.4], [2.2, 0], [0, 1.4]], closed: true }, { type: 'circle', center: [0.75, 0], radius: 0.4 }],
    attributes: [],
  },
  MCP_E_BOM: {
    description: 'Máy bơm / pump',
    entities: [{ type: 'circle', center: [0, 0], radius: 2 }, { type: 'polyline', points: [[-1, -1.7], [2, 0], [-1, 1.7]] }],
    attributes: [],
  },
  MCP_E_LEN: {
    description: 'Đường dây, đường ống đi lên / xuống tầng / riser',
    entities: [{ type: 'circle', center: [0, 0], radius: 1.3 }, { type: 'line', from: [0.92, 0.92], to: [2.8, 2.8] },
      ...tri([3.2, 3.2], [2.2, 2.9], [2.9, 2.2])],
    attributes: [],
  },
  MCP_E_TIEP_DIA: {
    description: 'Tiếp địa / earth',
    entities: [{ type: 'line', from: [0, 0], to: [0, -2] }, { type: 'line', from: [-2, -2], to: [2, -2] },
      { type: 'line', from: [-1.3, -2.8], to: [1.3, -2.8] }, { type: 'line', from: [-0.6, -3.6], to: [0.6, -3.6] }],
    attributes: [],
  },
  // ---- plumbing, paper mm
  MCP_P_OD: {
    description: 'Ống đứng / stack',
    entities: [{ type: 'circle', center: [0, 0], radius: 1.5 }, { type: 'hatch', boundary: polarPts(0.6, 8), pattern: 'SOLID' }],
    attributes: [],
  },
  MCP_P_VAN: {
    description: 'Van khóa / gate valve',
    entities: [{ type: 'polyline', points: [[-1.5, 1], [-1.5, -1], [1.5, 1], [1.5, -1]], closed: true }],
    attributes: [],
  },
  MCP_P_DHN: {
    description: 'Đồng hồ nước / water meter',
    entities: [{ type: 'circle', center: [0, 0], radius: 1.8 }, { type: 'line', from: [-1.8, 0], to: [1.8, 0] }, ...tri([1.2, 0], [0.2, 0.6], [0.2, -0.6])],
    attributes: [],
  },
  MCP_P_DIEM: {
    description: 'Điểm cấp nước thiết bị / supply point',
    entities: [{ type: 'circle', center: [0, 0], radius: 0.6 }, { type: 'hatch', boundary: polarPts(0.6, 10), pattern: 'SOLID' }],
    attributes: [],
  },
  MCP_P_TT: {
    description: 'Lỗ thông tắc / cleanout',
    entities: [{ type: 'circle', center: [0, 0], radius: 1.1 }, { type: 'line', from: [-0.78, -0.78], to: [0.78, 0.78] }, { type: 'line', from: [-0.78, 0.78], to: [0.78, -0.78] }],
    attributes: [],
  },
};

/** Points of a dome (a socket outline): flat side on x = 0, bulging to +X with radius r. */
function domePts(r, n = 8) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(polar(r, -90 + (180 * i) / n));
  return pts;
}
function dome(r) {
  return [{ type: 'arc', start: [0, -r], mid: [r, 0], end: [0, r] }, { type: 'line', from: [0, -r], to: [0, r] }];
}
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [Math.round(r * Math.cos(a) * 1000) / 1000, Math.round(r * Math.sin(a) * 1000) / 1000];
}
function polarPts(r, n) {
  return Array.from({ length: n }, (_, i) => polar(r, (360 * i) / n));
}

/** The definition of a symbol block (fixed, or a tag sized for its text: MCP_THE_<n>, MCP_THE_TRAN_<n>), or null. */
export function symbolDef(name) {
  if (FIXED[name]) return { name, ...FIXED[name] };
  let m = /^MCP_E_CT_([1-4])$/.exec(name);
  if (m) {
    // a switch of n gangs: one tick per gang at the end of the stem
    const n = Number(m[1]);
    return {
      name, description: `Công tắc ${n} hạt / ${n}-gang switch`, attributes: [],
      entities: [{ type: 'circle', center: [0, 0], radius: 0.9 }, { type: 'line', from: [0.9, 0], to: [3.6, 0] },
        ...Array.from({ length: n }, (_, k) => ({ type: 'line', from: [3.6 - 0.75 * k, 0], to: [3.6 - 0.75 * k, 1.2] }))],
    };
  }
  m = /^MCP_THE_(\d+)$/.exec(name);
  if (m) {
    const n = Number(m[1]), h = 2, w = tagWidth(n, h), hh = 1.9 * h;
    return {
      name, description: 'Thẻ mã vật liệu, đồ nội thất / code tag',
      entities: [{ type: 'polyline', points: [[-w / 2, -hh / 2], [w / 2, -hh / 2], [w / 2, hh / 2], [-w / 2, hh / 2]], closed: true }],
      attributes: [attr('MA', 'Mã', [0, 0], h)],
    };
  }
  m = /^MCP_THE_TRAN_(\d+)$/.exec(name);
  if (m) {
    // level over code, as ceiling plans read them
    const n = Number(m[1]), h = 2, w = tagWidth(n, h), hh = 1.9 * h;
    return {
      name, description: 'Thẻ trần: cao độ và mã / ceiling tag',
      entities: [{ type: 'polyline', points: [[-w / 2, -hh], [w / 2, -hh], [w / 2, hh], [-w / 2, hh]], closed: true }, { type: 'line', from: [-w / 2, 0], to: [w / 2, 0] }],
      attributes: [attr('COTE', 'Cao độ trần', [0, hh / 2], h), attr('MA', 'Mã trần', [0, -hh / 2], h)],
    };
  }
  m = /^MCP_THE_LG_(\d+)$/.exec(name);
  if (m) {
    // furniture, joinery and door tags: an elongated hexagon
    const n = Number(m[1]), h = 2, w = tagWidth(n, h) + 1.2, hh = 1.9 * h, k = 1.2;
    return {
      name, description: 'Thẻ đồ nội thất, cửa / item tag',
      entities: [{ type: 'polyline', points: [[-w / 2 - k, 0], [-w / 2, hh / 2], [w / 2, hh / 2], [w / 2 + k, 0], [w / 2, -hh / 2], [-w / 2, -hh / 2]], closed: true }],
      attributes: [attr('MA', 'Mã', [0, 0], h)],
    };
  }
  m = /^MCP_GHI_CHU(_DUOI)?_(\d+)$/.exec(name);
  if (m) {
    // a material note of an elevation: the code boxed, its description under the box; the leader ends at the
    // insertion point (under the note, or above it for the notes under the drawing)
    const below = Boolean(m[1]), n = Number(m[2]), h = 2.5, w = tagWidth(n, h), bh = 5;
    // the box next to the end of the leader, the description beyond the box (the leader does not run through it)
    const y0 = below ? -0.6 - bh : 0.6;
    return {
      name, description: 'Ghi chú vật liệu mặt đứng: mã và mô tả / elevation material note',
      entities: [{ type: 'polyline', points: [[-w / 2, y0], [w / 2, y0], [w / 2, y0 + bh], [-w / 2, y0 + bh]], closed: true }],
      attributes: [attr('MA', 'Mã', [0, y0 + bh / 2], h), attr('MO_TA', 'Mô tả', [0, below ? y0 - 3.2 : y0 + bh + 1.2], 2, 'center')],
    };
  }
  return null;
}

/** Insert of a symbol block; box = its extent [x0, y0, x1, y1] in drawing units (for placing labels clear of it). */
export function sym(name, at, { scale = 1, rotation = 0, attrs = {}, layer, half = null } = {}) {
  const e = { type: 'block', name, at: [Math.round(at[0] * 100) / 100, Math.round(at[1] * 100) / 100], scale, attributes: attrs, layer };
  if (rotation) e.rotation = rotation;
  if (half) e.box = [at[0] - half[0] * scale, at[1] - half[1] * scale, at[0] + half[0] * scale, at[1] + half[1] * scale];
  return e;
}

/** A code tag (MCP_THE_<n>, or the hexagon MCP_THE_LG_<n> for items and doors) and its half size in paper mm. */
export function tagSym(code, at, scale, layer, shape = 'box') {
  const n = Math.max(3, String(code).length);
  if (shape === 'hex') return sym(`MCP_THE_LG_${n}`, at, { scale, attrs: { MA: String(code) }, layer, half: [tagWidth(n, 2) / 2 + 1.8, 1.9] });
  return sym(`MCP_THE_${n}`, at, { scale, attrs: { MA: String(code) }, layer, half: [tagWidth(n, 2) / 2, 1.9] });
}

/** Width in paper mm of an elevation note (code box or description, the wider). */
export const noteWidth = (code, desc) => Math.max(tagWidth(Math.max(3, String(code).length), 2.5), [...String(desc)].length * 0.72 * 2 + 2);

/** An elevation material note as the content of a multileader (code boxed, description under it). */
export function noteLeader(code, desc, points, scale, layer, leaderStyle, below = false) {
  const n = Math.max(3, String(code).length);
  return {
    type: 'leader', points, block: `MCP_GHI_CHU${below ? '_DUOI' : ''}_${n}`, block_scale: scale, attributes: { MA: String(code), MO_TA: String(desc) },
    leader_style: leaderStyle, leader_linetype: 'DASHED', scale_linetype: true, layer,
  };
}

/** A two-line ceiling tag (code over level). */
export function ceilingSym(code, level, at, scale, layer) {
  const n = Math.max(3, String(code).length, String(level).length);
  return sym(`MCP_THE_TRAN_${n}`, at, { scale, attrs: { MA: String(code), COTE: String(level) }, layer, half: [tagWidth(n, 2) / 2, 3.8] });
}

export const tagHalf = (code) => [tagWidth(Math.max(3, String(code).length), 2) / 2, 1.9];

/** Light blocks by kind (half = half their size in mm, for placing labels clear of them). */
export const LIGHT_BLOCKS = {
  downlight: { name: 'MCP_DEN_DOWNLIGHT', half: 115 },
  ceiling_lamp: { name: 'MCP_DEN_OP_TRAN', half: 320 },
  pendant: { name: 'MCP_DEN_THA', half: 200 },
  strip: { name: 'MCP_DEN_LED_DAY', half: 500 },
};

/** A block name from its parts (characters AutoCAD refuses replaced), with a short hash of key when given. */
export function blockName(parts, key = null) {
  let name = parts.map((p) => String(p).trim().replace(/[<>/\\":;?*|,=`'\s]+/g, '-')).join('_');
  if (key) {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    name += `_${h.toString(36).slice(0, 5)}`;
  }
  return name.slice(0, 250);
}
