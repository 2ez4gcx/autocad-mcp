// Is the set complete enough to build from? A checklist of what an architectural set shows by common practice (TCVN
// 5671:2012 for the content of an architectural design, TCVN 5896:2012 and 5571:2012 for the layout of the sheets and the
// title block), read from the plan the drawing keeps and the views drawn in it. Each item: {code, severity (warn: a
// builder would have to ask; info: usual but optional), floor?, message, fix}. Pure computation.
import { floorsOf } from './elevation.mjs';
import { buildWalls, findSegment, wallRoles } from './plan.mjs';

const T = {
  vi: {
    grids: 'không có trục định vị (cần ít nhất 2 trục mỗi phương)',
    dimsSide: (s) => `mặt ${s} có cửa ở tường bao nhưng không có chuỗi kích thước`,
    interior: 'không có kích thước trong phòng (kích thước thông thủy, vị trí tường ngăn)',
    roomName: (n) => `${n} phòng chưa có tên`,
    tags: (n) => `${n} cửa chưa có ký hiệu (D1, S1...): không lập được bảng thống kê cửa`,
    levels: 'không có cốt cao độ sàn (±0.000)',
    north: 'mặt bằng tầng 1 không có hướng Bắc',
    noSection: 'chưa có mặt cắt nào',
    sectionMark: (l) => `mặt cắt ${l}-${l} đã vẽ nhưng mặt bằng không có đường cắt ${l}-${l}`,
    markNoSection: (l) => `mặt bằng có đường cắt ${l}-${l} nhưng chưa vẽ mặt cắt đó`,
    elevations: (n) => `mới có ${n} mặt đứng (thường cần đủ các mặt nhìn thấy, ít nhất 2)`,
    doorSchedule: 'cửa đã có ký hiệu nhưng chưa có bảng thống kê cửa',
    sheets: 'chưa dàn trang nào (khung tên, tỷ lệ, số bản vẽ)',
    list: 'nhiều tờ nhưng chưa có danh mục bản vẽ',
    stairs: 'nhà nhiều tầng nhưng tầng này không có thang đi lên',
  },
  en: {
    grids: 'no grid lines (two at least each way)',
    dimsSide: (s) => `the ${s} side has openings in its outer wall but no dimension chain`,
    interior: 'no interior dimensions (clear room sizes, the places of the partitions)',
    roomName: (n) => `${n} room(s) without a name`,
    tags: (n) => `${n} opening(s) without a tag (D1, W1...): no door schedule can be made`,
    levels: 'no floor level mark (±0.000)',
    north: 'the ground floor plan has no north arrow',
    noSection: 'no section drawn',
    sectionMark: (l) => `section ${l}-${l} is drawn but the plan has no cut line ${l}-${l}`,
    markNoSection: (l) => `the plan has a cut line ${l}-${l} but that section is not drawn`,
    elevations: (n) => `${n} elevation(s) only (usually every visible side, two at least)`,
    doorSchedule: 'the openings are tagged but there is no door schedule',
    sheets: 'no sheet laid out yet (title block, scale, drawing number)',
    list: 'several sheets but no drawing list',
    stairs: 'a building of several floors but this floor has no stair going up',
  },
};
const SIDE = { vi: { bottom: 'dưới', top: 'trên', left: 'trái', right: 'phải' }, en: { bottom: 'bottom', top: 'top', left: 'left', right: 'right' } };
const FIX = {
  grids: 'draw_plan grids {x: [...], y: [...]} (update: true)',
  dimsSide: 'draw_plan dimensions: ["bottom", "left", "top", "right"] (update: true)',
  interior: 'draw_plan interior_dimensions: true (update: true)',
  roomName: 'draw_plan rooms[].name',
  tags: 'draw_plan openings[].tag',
  levels: 'draw_plan levels [{at, value: "±0.000"}]',
  north: 'draw_plan north {at, angle}',
  noSection: 'draw_section from/to with a label, and the same cut in draw_plan sections',
  sectionMark: 'draw_plan sections [{from, to, label}] (update: true)',
  markNoSection: 'draw_section with that label',
  elevations: 'draw_elevation sides [...]',
  doorSchedule: 'draw_door_schedule',
  sheets: 'create_layout for each sheet',
  list: 'draw_drawing_list (and draw_cover_sheet)',
  stairs: 'draw_plan stairs on this floor',
};

/**
 * plan: the plan description the drawing keeps; views: [{tool, args}] drawn in it; layouts: the names of its layouts.
 */
export function presentationCheck({ plan, views = [], layouts = [], lang = 'vi' }) {
  const t = T[lang] ?? T.vi, side = SIDE[lang] ?? SIDE.vi;
  const out = [];
  const add = (code, severity, message, floor) => out.push({ code, severity, ...(floor ? { floor } : {}), message, fix: FIX[code] });
  // the architectural content is asked of a drawing whose plan is drawn in it (draw_plan), not of the structure,
  // interior or services sets that keep the plan only to draw from it
  const floors = plan && views.some((v) => v.tool === 'draw_plan') ? floorsOf(plan) : [];
  const multi = floors.length > 1;
  // a section is named by its label, else by the plan's mark it was drawn from
  const sectionsDrawn = new Set(views.filter((v) => v.tool === 'draw_section').map((v) => String(v.args?.label ?? v.args?.mark ?? 'A')));
  const marks = new Set();
  let tagged = 0;
  floors.forEach((f, k) => {
    const s = f.spec, name = multi ? f.name ?? `#${k + 1}` : null;
    if (!(s.walls || []).length) return;
    const gx = s.grids?.x ?? [], gy = s.grids?.y ?? [];
    if (gx.length < 2 || gy.length < 2) add('grids', 'warn', t.grids, name);
    // the sides with openings in an outer wall, and the sides that have chains
    let walls = [];
    try {
      walls = buildWalls(s);
    } catch {
      walls = [];
    }
    const roles = wallRoles(s);
    const xs = walls.flatMap((w) => w.segs.flatMap((g) => [g.a[0], g.b[0]])), ys = walls.flatMap((w) => w.segs.flatMap((g) => [g.a[1], g.b[1]]));
    const box = xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
    const dimSides = s.dimensions === false ? [] : Array.isArray(s.dimensions) ? s.dimensions : ['bottom', 'left'];
    const needs = new Set();
    for (const o of s.openings || []) {
      // the segment as draw_plan finds it (by index or id; on a curved wall the chord nearest the opening)
      let g = null;
      try {
        g = box ? findSegment(walls, o, 'opening').s : null;
      } catch {
        g = null;
      }
      if (!g || roles[g.wall] !== 'outer') continue;
      const m = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2];
      const horiz = Math.abs(g.d[1]) < 0.3, vert = Math.abs(g.d[0]) < 0.3;
      if (horiz) needs.add(m[1] < (box[1] + box[3]) / 2 ? 'bottom' : 'top');
      else if (vert) needs.add(m[0] < (box[0] + box[2]) / 2 ? 'left' : 'right');
    }
    for (const sd of ['bottom', 'left', 'top', 'right']) if (needs.has(sd) && !dimSides.includes(sd)) add('dimsSide', 'warn', t.dimsSide(side[sd]), name);
    if ((s.rooms || []).length >= 2 && !s.interior_dimensions) add('interior', 'info', t.interior, name);
    const unnamed = (s.rooms || []).filter((r) => !String(r.name ?? '').trim()).length;
    if (unnamed) add('roomName', 'warn', t.roomName(unnamed), name);
    const untag = (s.openings || []).filter((o) => !o.tag && o.type !== 'opening').length;
    tagged += (s.openings || []).filter((o) => o.tag).length;
    if (untag) add('tags', 'warn', t.tags(untag), name);
    if (!(s.levels || []).length) add('levels', 'warn', t.levels, name);
    if (k === 0 && !s.north && !plan.north) add('north', 'info', t.north, name);
    for (const sc of s.sections || []) marks.add(String(sc.label ?? 'A'));
    if (multi && k < floors.length - 1 && !(s.stairs || []).length) add('stairs', 'warn', t.stairs, name);
  });
  for (const sc of plan?.sections || []) marks.add(String(sc.label ?? 'A'));
  if (floors.length) {
    if (!sectionsDrawn.size) add('noSection', 'warn', t.noSection);
    for (const l of sectionsDrawn) if (!marks.has(l)) add('sectionMark', 'warn', t.sectionMark(l));
    for (const l of marks) if (!sectionsDrawn.has(l)) add('markNoSection', 'warn', t.markNoSection(l));
    const sides = new Set(views.filter((v) => v.tool === 'draw_elevation').flatMap((v) => v.args?.sides ?? ['bottom']));
    if (sides.size < 2) add('elevations', 'info', t.elevations(sides.size));
    if (tagged && !views.some((v) => v.tool === 'draw_door_schedule')) add('doorSchedule', 'info', t.doorSchedule);
  }
  const sheets = layouts.filter((n) => !/^(Layout\d+|Model)$/i.test(n));
  if (views.length && !sheets.length) add('sheets', 'info', t.sheets);
  if (sheets.length >= 3 && !views.some((v) => v.tool === 'draw_drawing_list')) add('list', 'info', t.list);
  return { checked: floors.length ? (lang === 'en' ? 'the plan kept in the drawing and its views' : 'mặt bằng lưu trong bản vẽ và các hình đã vẽ') : 'sheets only', items: out, warnings: out.filter((x) => x.severity === 'warn').length };
}
