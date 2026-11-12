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
    mids.push({ zc, z, area: (z[2] - z[0]) * (z[3] - z[1]) });
  }
  if (tower) drains.push({ at: [tower[0] + 300, tower[1] + 300], from: tc, tower: true });
  // what the labels keep clear of: the drains, the fall arrows (with their i=..% text), the labels already placed
  const taken = [];
  const hits = (b) => taken.some((x) => x[0] < b[2] && b[0] < x[2] && x[1] < b[3] && b[1] < x[3]);
  const arrow = (from, to, label) => {
    const d = [to[0] - from[0], to[1] - from[1]], L = Math.hypot(...d);
    if (L < 14 * sc) return;
    const ang = (Math.atan2(d[1], d[0]) * 180) / Math.PI;
    const tail = [to[0] - (d[0] / L) * (12 * sc + 200), to[1] - (d[1] / L) * (12 * sc + 200)];
    const bx = bbox([tail, [to[0] - (d[0] / L) * 200, to[1] - (d[1] / L) * 200]]);
    taken.push([bx[0] - 3 * sc, bx[1] - 3 * sc, bx[2] + 3 * sc, bx[3] + 3 * sc]);
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
    taken.push([dr.at[0] - 150, dr.at[1] - 150, dr.at[0] + 150, dr.at[1] + 150]);
  }
  // A name (lines of text, centred) with its level mark under it, as a block of labels: placed at the first of the
  // candidate centres where it lies inside the region and clear of the drains, arrows and other labels; the name is
  // wrapped to the width of the region.
  const tw = (t, h) => [...t].length * 0.9 * h * sc; // capitals: about 0.83 of their height each
  const labelBlock = (name, level, region, centres, h, mask = false) => {
    const room = region[2] - region[0] - 2 * sc;
    const lines = [];
    for (const word of name.split(' ')) {
      const last = lines[lines.length - 1];
      if (last !== undefined && tw(`${last} ${word}`, h) <= room) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    const lh = 1.6 * h * sc;
    // the level mark: the triangle at its insertion point, the value over a line 13.5 paper mm long to its right
    const w = Math.max(...lines.map((l) => tw(l, h)), 15 * sc), H = lines.length * lh + 8 * sc;
    const boxAt = (c) => [c[0] - w / 2, c[1] - H / 2, c[0] + w / 2, c[1] + H / 2];
    const inside = (b) => b[0] >= region[0] + sc && b[2] <= region[2] - sc && b[1] >= region[1] + sc && b[3] <= region[3] - sc;
    // where nothing is free inside the region: the place that covers the least of what is there
    const over = (bx) => taken.reduce((a, x) => a + Math.max(0, Math.min(bx[2], x[2]) - Math.max(bx[0], x[0])) * Math.max(0, Math.min(bx[3], x[3]) - Math.max(bx[1], x[1])), 0);
    const ins = centres.filter((q) => inside(boxAt(q)));
    const c = ins.find((q) => !hits(boxAt(q))) ?? ins.map((q) => ({ q, a: over(boxAt(q)) })).sort((p, q) => p.a - q.a)[0]?.q ?? centres[0];
    const b = boxAt(c);
    taken.push(b);
    // on a hatched roof the block stands on a mask: the hatch stops around it
    if (mask) out.push({ type: 'wipeout', points: [P([b[0], b[1]]), P([b[2], b[1]]), P([b[2], b[3]]), P([b[0], b[3]])], layer: ROLE.text });
    lines.forEach((l, i) => T(l, [c[0], b[3] - (i + 0.5) * lh], h));
    out.push(sym('MCP_COTE', [c[0] - 5.5 * sc, b[1] + 0.5 * sc], { scale: sc, attrs: { COTE: level }, layer: ROLE.symbol }));
  };
  // candidate centres: the middle of the region, then the points of a grid over it, the nearest to the middle first
  const centresOf = (region) => {
    const c = [(region[0] + region[2]) / 2, (region[1] + region[3]) / 2], step = 2 * sc, list = [];
    const nx = Math.floor((region[2] - region[0]) / 2 / step), ny = Math.floor((region[3] - region[1]) / 2 / step);
    for (let i = -nx; i <= nx; i++) for (let j = -ny; j <= ny; j++) list.push([c[0] + i * step, c[1] + j * step]);
    return list.sort((p, q) => Math.hypot(p[0] - c[0], p[1] - c[1]) - Math.hypot(q[0] - c[0], q[1] - c[1]));
  };
  // levels and names: the terrace in its largest zone, the tower roof inside its walls
  const zone = mids.reduce((m, x) => (x.area > m.area ? x : m)).z;
  labelBlock(lang === 'en' ? 'ROOF TERRACE' : 'SÂN THƯỢNG', fmtLv(terrace), zone, centresOf(zone), 3);
  if (tower) {
    const t = Math.max(...towerSegs.map((s) => s.t));
    const region = [tower[0] + t, tower[1] + t, tower[2] - t, tower[3] - t];
    labelBlock(lang === 'en' ? 'RC TOWER ROOF' : 'MÁI BTCT TUM', fmtLv(roof), region, centresOf(region), 2.2, true);
  }
  // the parapet: its height and top level in the notes (a text along the wall would lie on the grids and dimensions)
  const top2 = fmtLv(terrace + parapet);
  const notes = lang === 'en'
    ? ['RC roofs waterproofed, screed to falls of 2% to the floor drains.', 'Rainwater pipes uPVC Ø90 from every drain down to the ground drainage.', `Parapets ${parapet} high (top ${top2}), coping and drip on top.`]
    : ['Mái BTCT chống thấm, láng vữa tạo dốc i=2% về phễu thu.', 'Ống thoát nước mưa uPVC Ø90 từ mỗi phễu thu xuống hệ thoát nước sân.', `Tường mái cao ${parapet} (đỉnh tường ${top2}), có gờ chắn nước và chỉ nhỏ giọt trên đỉnh.`];
  return { entities: out, assumed, notes, drains: drains.length, drainPoints: drains.map((d) => ({ at: [Math.round(d.at[0]), Math.round(d.at[1])], tower: Boolean(d.tower) })) };
}
