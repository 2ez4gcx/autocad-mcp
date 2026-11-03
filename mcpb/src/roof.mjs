// Roof plan (mặt bằng mái) of a building with flat roofs: the roof terrace inside its parapets and the roof of the stair
// tower, the falls to the floor drains, the rainwater pipes, the levels and the notes. Pure geometry: draw_entities specs,
// in plan coordinates (the caller moves them with the plan copy).
import { buildWalls, segRect } from './plan.mjs';
import { ROLE, TEXT_STYLE } from './standards.mjs';
import { sym } from './symbols.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const P = (p) => [r2(p[0]), r2(p[1])];
const fmtLv = (mm) => (Math.abs(mm) < 0.5 ? '±0.000' : `${mm > 0 ? '+' : '-'}${(Math.abs(mm) / 1000).toFixed(3)}`);
const bbox = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

/**
 * top: the top floor (its spec: the walls of the stair tower and the parapets copied from the floor below);
 * terrace: level of the roof terrace (the top floor's floor), roof: level of the tower roof slab top.
 */
export function roofPlan({ top, terrace, roof, parapet = 1000, fall = 2, scale = 100, lang = 'vi' }) {
  const sc = scale, out = [], assumed = [];
  const walls = buildWalls(top.spec);
  const isPar = (w) => top.spec.walls[w.index].height !== undefined;
  const parSegs = walls.filter(isPar).flatMap((w) => w.segs), towerSegs = walls.filter((w) => !isPar(w)).flatMap((w) => w.segs);
  if (!parSegs.length && !towerSegs.length) return { entities: out, assumed };
  const outer = bbox([...parSegs, ...towerSegs].flatMap((s) => segRect(s)));
  const tower = towerSegs.length ? bbox(towerSegs.flatMap((s) => segRect(s))) : null;
  const inner = parSegs.length ? (() => {
    // the terrace: inside the parapets (their inner faces)
    const b = bbox(parSegs.flatMap((s) => segRect(s)));
    const t = Math.max(...parSegs.map((s) => s.t));
    return [b[0] + t, b[1] + t, b[2] - t, b[3] - t];
  })() : outer;
  const T = (text, p, h = 2.5) => out.push({ type: 'text', text, at: P(p), height: r2(h * sc), align: 'middle_center', layer: ROLE.text, style: TEXT_STYLE });
  // the stair tower roof: its outline seen from above, hatched lightly
  if (tower) {
    const poly = [[tower[0], tower[1]], [tower[2], tower[1]], [tower[2], tower[3]], [tower[0], tower[3]]];
    out.push({ type: 'polyline', points: poly.map(P), closed: true, layer: ROLE.elevation_outline });
    out.push({ type: 'hatch', boundary: poly.map(P), pattern: 'ANSI31', scale: r2(1.5 * sc), layer: ROLE.elevation_hatch });
  }
  // drains: the terrace in zones (in front of and behind the stair tower when there is room on both sides), each with
  // drains at its two corners farthest from the tower; one corner of the tower roof; falls towards them
  const tc = tower ? [(tower[0] + tower[2]) / 2, (tower[1] + tower[3]) / 2] : [(inner[0] + inner[2]) / 2, (inner[1] + inner[3]) / 2];
  const zones = [];
  if (tower) {
    const alongY = inner[3] - inner[1] >= inner[2] - inner[0];
    const [lo, hi, t0, t1] = alongY ? [inner[1], inner[3], tower[1], tower[3]] : [inner[0], inner[2], tower[0], tower[2]];
    if (t0 - lo > 1500) zones.push(alongY ? [inner[0], inner[1], inner[2], tower[1]] : [inner[0], inner[1], tower[0], inner[3]]);
    if (hi - t1 > 1500) zones.push(alongY ? [inner[0], tower[3], inner[2], inner[3]] : [tower[2], inner[1], inner[2], inner[3]]);
  }
  if (!zones.length) zones.push(inner);
  const drains = [], mids = [];
  for (const z of zones) {
    const zc = [(z[0] + z[2]) / 2, (z[1] + z[3]) / 2];
    const corners = [[z[0], z[1]], [z[2], z[1]], [z[2], z[3]], [z[0], z[3]]]
      .map((c) => [c[0] + Math.sign(zc[0] - c[0]) * 250, c[1] + Math.sign(zc[1] - c[1]) * 250])
      .filter((c) => !tower || c[0] < tower[0] || c[0] > tower[2] || c[1] < tower[1] || c[1] > tower[3])
      .sort((a, b) => Math.hypot(b[0] - tc[0], b[1] - tc[1]) - Math.hypot(a[0] - tc[0], a[1] - tc[1]));
    for (const c of corners.slice(0, 2)) drains.push({ at: c, from: zc });
    mids.push({ zc, area: (z[2] - z[0]) * (z[3] - z[1]) });
  }
  if (tower) drains.push({ at: [tower[0] + 300, tower[1] + 300], from: tc });
  const arrow = (from, to, label) => {
    const d = [to[0] - from[0], to[1] - from[1]], L = Math.hypot(...d);
    if (L < 14 * sc) return;
    const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    const tail = [to[0] - (d[0] / L) * (12 * sc + 200), to[1] - (d[1] / L) * (12 * sc + 200)];
    const upright = Math.cos((ang * Math.PI) / 180) >= -1e-9;
    out.push(upright
      ? sym('MCP_DOC', tail, { scale: sc, rotation: r2(ang), attrs: { I: label }, layer: ROLE.note })
      : sym('MCP_DOC_NGUOC', [to[0] - (d[0] / L) * 200, to[1] - (d[1] / L) * 200], { scale: sc, rotation: r2(ang + 180), attrs: { I: label }, layer: ROLE.note }));
  };
  const label = `i=${fall}%`;
  if (fall === 2) assumed.push({ item: 'fall', value: '2%', note: 'roof screed falls to the floor drains' });
  // falls from the middle of each zone (and of the tower roof) to its drains
  for (const dr of drains) arrow(dr.from, dr.at, label);
  for (const dr of drains) {
    out.push(sym('MCP_PHEU_THU', dr.at, { attrs: { MA: lang === 'en' ? 'RD' : 'PT' }, layer: ROLE.fixture, half: [75, 75] }));
    out.push({ type: 'circle', center: P(dr.at), radius: 45, layer: ROLE.fixture });
  }
  // levels and names in the largest zone
  const mid = mids.reduce((m, x) => (x.area > m.area ? x : m)).zc;
  out.push(sym('MCP_COTE', [mid[0] + 8 * sc, mid[1] - 4 * sc], { scale: sc, attrs: { COTE: fmtLv(terrace) }, layer: ROLE.symbol }));
  T(lang === 'en' ? 'ROOF TERRACE' : 'SÂN THƯỢNG', [mid[0], mid[1] + 3 * sc], 3);
  if (tower) {
    T(lang === 'en' ? 'RC ROOF OF THE STAIR TOWER' : 'MÁI BTCT TUM', [tc[0], tc[1] + 3 * sc], 2.5);
    out.push(sym('MCP_COTE', [tc[0] + 6 * sc, tc[1] - 5 * sc], { scale: sc, attrs: { COTE: fmtLv(roof) }, layer: ROLE.symbol }));
  }
  if (parSegs.length) {
    const s = parSegs.reduce((m, x) => (x.L > m.L ? x : m));
    const c = [(s.a[0] + s.b[0]) / 2 + 6 * sc, (s.a[1] + s.b[1]) / 2 + 6 * sc];
    out.push({
      type: 'text', text: `${lang === 'en' ? 'PARAPET H=' : 'TƯỜNG MÁI CAO '}${parapet} (${fmtLv(terrace + parapet)})`, at: P(c),
      height: r2(2.2 * sc), rotation: r2((Math.atan2(s.d[1], s.d[0]) * 180) / Math.PI) % 180 === 90 ? 90 : 0, layer: ROLE.text, style: TEXT_STYLE,
    });
  }
  const notes = lang === 'en'
    ? ['RC roofs waterproofed, screed to falls of 2% to the floor drains.', 'Rainwater pipes uPVC Ø90 from every drain down to the ground drainage.', 'Parapets 1000 high, coping and drip on top.']
    : ['Mái BTCT chống thấm, láng vữa tạo dốc i=2% về phễu thu.', 'Ống thoát nước mưa uPVC Ø90 từ mỗi phễu thu xuống hệ thoát nước sân.', 'Tường mái cao 1000, có gờ chắn nước và chỉ nhỏ giọt trên đỉnh.'];
  return { entities: out, assumed, notes, drains: drains.length };
}
