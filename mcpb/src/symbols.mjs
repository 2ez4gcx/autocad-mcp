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
        out.push({ type: 'text', text: t, at: [dx * r * 0.45, dy * r * 0.45], height: 2.2, align: 'middle_center', style: T });
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
};

/** The definition of a symbol block (fixed, or a tag sized for its text: MCP_THE_<n>, MCP_THE_TRAN_<n>), or null. */
export function symbolDef(name) {
  if (FIXED[name]) return { name, ...FIXED[name] };
  let m = /^MCP_THE_(\d+)$/.exec(name);
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
    const y0 = below ? -0.6 - bh : 4.2;
    return {
      name, description: 'Ghi chú vật liệu mặt đứng: mã và mô tả / elevation material note',
      entities: [{ type: 'polyline', points: [[-w / 2, y0], [w / 2, y0], [w / 2, y0 + bh], [-w / 2, y0 + bh]], closed: true }],
      attributes: [attr('MA', 'Mã', [0, y0 + bh / 2], h), attr('MO_TA', 'Mô tả', [0, below ? y0 - 3.2 : 1.2], 2, 'center')],
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
