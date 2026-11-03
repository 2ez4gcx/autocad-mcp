// Unit tests of the pure parts (plan engine, standards) and a smoke test of the MCP server over stdio.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildElevation, buildSection, floorsOf } from '../src/elevation.mjs';
import { buildPlan, hull, planAssumptions, PlanError, uStairGeom } from '../src/plan.mjs';
import { beamDetail, beamSchedule, footingDetail, framingPlan, kgPerM, rcSection, rebarSchedule, structureNotes } from '../src/structure.mjs';
import { coverSheet, drawingList, fitScale, layerSpecs, layerStyles, ROLE, styleParams, titleBlock } from '../src/standards.mjs';
import { symbolDef } from '../src/symbols.mjs';
import { doorSchedule } from '../src/doors.mjs';
import { roofPlan } from '../src/roof.mjs';
import { stairDetail } from '../src/stair.mjs';
import { analyseBeam, calcCsv, calcSheet, chooseBars, CONCRETE, flexure, STEEL, stirrups, structuralCalc, supportMoments } from '../src/calc.mjs';
import { boqCsv, boqSheets } from '../src/boq.mjs';
import { finishQuantities } from '../src/archboq.mjs';
import { finishWorkbook, howFormula, kcWorkbook } from '../src/workbooks.mjs';
import { ceilingPlan, cleanPoly, cutBoxes, dejog, floorFinishPlan, furniturePlan, generalNotes, interiorElevation, joineryDetail, materialSchedule, notesBlock, offsetPoly, patternLines, polyArea, resolveFinish, resolveItems, roomEdge, wallFinishPlan } from '../src/interior.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const hasPt = (pts, p, tol = 1e-6) => pts.some((q) => near(q[0], p[0], tol) && near(q[1], p[1], tol));
const area = (pts) => Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2);

test('hull of a square with an inner point', () => {
  const h = hull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1]]);
  assert.equal(h.length, 4);
  assert.equal(area(h), 4);
});

test('closed room: 4 segment rectangles + 4 corner joints that fill the outer corners', () => {
  const p = buildPlan({ walls: [{ points: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]], closed: true, thickness: 200 }], dimensions: false });
  assert.equal(p.walls.length, 1);
  const solids = p.walls[0].solids;
  assert.equal(solids.length, 8);
  const joints = solids.slice(4);
  for (const c of [[-100, -100], [5100, -100], [5100, 4100], [-100, 4100]]) {
    assert.ok(joints.some((j) => hasPt(j, c)), `outer corner ${c} filled`);
  }
  assert.equal(p.walls[0].hatch.pattern, 'ANSI31');
  assert.equal(p.walls[0].hatch.layer, 'A-WALL-PATT');
});

test('L corner of two separate walls with different thickness', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [4000, 0]], thickness: 200 }, { points: [[4000, 0], [4000, 3000]], thickness: 100 }],
    dimensions: false,
  });
  const j = p.walls[0].solids.slice(2);
  assert.equal(j.length, 1);
  assert.ok(hasPt(j[0], [4050, -100]), 'outer miter corner of the 200 and 100 walls');
});

test('T junction: three ends at one node give one junction polygon', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [3000, 0], [6000, 0]], thickness: 200 }, { points: [[3000, 0], [3000, 3000]], thickness: 100 }],
    dimensions: false,
  });
  const j = p.walls[0].solids.slice(3);
  assert.equal(j.length, 1);
  assert.ok(area(j[0]) > 0);
});

test('straight continuation needs no extra polygon area outside the wall', () => {
  const p = buildPlan({ walls: [{ points: [[0, 0], [3000, 0], [6000, 0]], thickness: 200 }], dimensions: false });
  const j = p.walls[0].solids.slice(2);
  for (const poly of j) for (const q of poly) assert.ok(Math.abs(q[1]) <= 100 + 1e-6);
});

// A block-local point in the drawing (insert point, rotation, X mirror).
const world = (b, q) => {
  const a = ((b.rotation ?? 0) * Math.PI) / 180;
  const sx = Array.isArray(b.scale) ? b.scale[0] : 1;
  const x = q[0] * sx, y = q[1];
  return [b.at[0] + x * Math.cos(a) - y * Math.sin(a), b.at[1] + x * Math.sin(a) + y * Math.cos(a)];
};
const nearPt = (p, q, tol = 0.5) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
const tagOf = (ents, code) => ents.find((e) => e.type === 'block' && /^MCP_THE_/.test(e.name) && e.attributes?.MA === code);

test('door: wall cut through the whole thickness, leaf + arc on the toward side, tag', () => {
  const p = buildPlan({
    walls: [{ id: 'W1', points: [[0, 0], [5000, 0]], thickness: 200 }],
    openings: [{ wall: 'W1', offset: 1000, width: 900, type: 'door', toward: [1500, 2000], tag: 'D1' }],
    dimensions: false,
  });
  assert.equal(p.cuts.length, 1);
  const cut = p.cuts[0];
  assert.ok(hasPt(cut, [1000, -101]) && hasPt(cut, [1900, 101]));
  // a block: leaf from the hinge into the room, arc back to the far jamb
  const door = p.entities.find((e) => e.type === 'block' && e.layer === 'A-DOOR');
  assert.equal(door.name, 'MCP_CUA_DI_900');
  assert.equal(door.attributes.MA, 'D1');
  const leaf = door.def.entities.find((e) => e.type === 'line');
  assert.ok(nearPt(world(door, leaf.from), [1000, 100]) && nearPt(world(door, leaf.to), [1000, 1000]));
  const arc = door.def.entities.find((e) => e.type === 'arc');
  assert.ok(nearPt(world(door, arc.end), [1900, 100]));
  const m = world(door, arc.mid);
  assert.ok(near(Math.hypot(m[0] - 1000, m[1] - 100), 900, 0.2));
  assert.ok(tagOf(p.entities, 'D1'));
  // hinge at the end: mirrored, the leaf at the far jamb
  const q = buildPlan({ walls: [{ id: 'W1', points: [[0, 0], [5000, 0]], thickness: 200 }], openings: [{ wall: 'W1', offset: 1000, width: 900, type: 'door', toward: [1500, 2000], hinge: 'end' }], dimensions: false });
  const d2 = q.entities.find((e) => e.type === 'block' && e.layer === 'A-DOOR');
  assert.ok(nearPt(world(d2, [0, 900]), [1900, 1000]) && nearPt(world(d2, [900, 0]), [1000, 100]), JSON.stringify(d2));
});

test('window: four lines across the opening on A-GLAZ, opening by centre point', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [0, 4000]], thickness: 220 }],
    openings: [{ wall: 0, at: [0, 2000], width: 1200, type: 'window' }],
    dimensions: false,
  });
  const win = p.entities.filter((e) => e.layer === 'A-GLAZ');
  assert.equal(win.length, 1);
  assert.equal(win[0].name, 'MCP_CUA_SO_1200_220');
  const lines = win[0].def.entities;
  assert.equal(lines.length, 4);
  for (const l of lines) {
    const a = world(win[0], l.from), b = world(win[0], l.to);
    assert.ok(near(Math.abs(a[1] - b[1]), 1200, 0.2) && near(a[0], b[0], 0.2));
  }
});

test('window tags go outside the building, door tags away from the swing', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], closed: true, thickness: 200 }],
    openings: [
      { wall: 0, segment: 0, at: [3000, 0], width: 1200, type: 'window', tag: 'S1' },
      { wall: 0, segment: 2, at: [3000, 4000], width: 1200, type: 'window', tag: 'S2' },
      { wall: 0, segment: 0, at: [1000, 0], width: 900, type: 'door', toward: [1000, 2000], tag: 'D1' },
    ],
    dimensions: false,
    room_options: { text_height: 3 },
  });
  const tag = (t) => tagOf(p.entities, t).at;
  assert.ok(tag('S1')[1] < -100, 'S1 below the front wall');
  assert.ok(tag('S2')[1] > 4100, 'S2 above the back wall');
  assert.ok(tag('D1')[1] < -100, 'D1 outside, the door swings in');
  assert.equal(p.room_options.text_height, 300);
  const q = buildPlan({ walls: [{ points: [[0, 0], [4000, 0]] }], openings: [{ wall: 0, offset: 500, width: 900, type: 'window', tag: 'S9', tag_at: [1, 2] }], dimensions: false });
  assert.deepEqual(tagOf(q.entities, 'S9').at, [1, 2]);
});

test('opening outside its wall and overlapping openings are refused', () => {
  assert.throws(() => buildPlan({ walls: [{ points: [[0, 0], [1000, 0]] }], openings: [{ wall: 0, offset: 500, width: 900 }] }), PlanError);
  assert.throws(() => buildPlan({
    walls: [{ points: [[0, 0], [5000, 0]] }],
    openings: [{ wall: 0, offset: 500, width: 900 }, { wall: 0, offset: 1000, width: 900 }],
  }), /overlaps/);
  assert.throws(() => buildPlan({ walls: [{ points: [[0, 0], [5000, 0]] }], openings: [{ wall: 'X', offset: 0 }] }), /not found/);
});

test('grids, columns at intersections, exterior dimension chains', () => {
  const p = buildPlan({
    scale: 100,
    walls: [{ points: [[0, 0], [9000, 0], [9000, 6000], [0, 6000]], closed: true }],
    openings: [{ wall: 0, offset: 2000, width: 1000, type: 'door' }],
    grids: { x: [0, 4500, 9000], y: [0, 6000] },
    grid_columns: { size: [300, 300] },
  });
  assert.equal(p.columns.length, 6);
  const chains = p.entities.filter((e) => e.type === 'dim_chain');
  assert.equal(chains.length, 5); // bottom: openings, grids, overall; left (no opening): grids, overall
  const bottom = chains.filter((c) => c.direction === 'horizontal');
  assert.deepEqual(bottom.map((c) => c.points.length), [4, 3, 2]);
  assert.deepEqual(bottom[0].points.map((q) => q[0]), [-150, 2000, 3000, 9150]); // columns stand 50 mm proud of the 200 mm walls
  assert.ok(bottom.every((c) => c.style === 'MCP-1-100' && c.layer === 'A-ANNO-DIMS'));
  const bubbles = p.entities.filter((e) => e.name === 'MCP_TRUC' && e.layer === 'S-GRID-IDEN');
  assert.equal(bubbles.length, 10);
  assert.ok(bubbles.every((b) => b.scale === 100));
  const labels = bubbles.map((e) => e.attributes.SO).sort();
  assert.deepEqual(labels, ['1', '1', '2', '2', '3', '3', 'A', 'A', 'B', 'B']);
});

test('rooms pass through with options; layer roles can follow the drawing', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [4000, 0]] }],
    rooms: [{ name: 'Phòng ngủ', at: [2000, 2000], hatch: { pattern: 'NET' } }],
    layers: { wall: 'TUONG', door: 'CUA' },
    dimensions: false,
  });
  assert.equal(p.walls[0].layer, 'TUONG');
  assert.equal(p.rooms[0].name, 'Phòng ngủ');
  assert.equal(p.rooms[0].hatch.layer, 'A-FLOR-PATT');
  assert.equal(p.room_options.decimal_separator, ',');
});

test('stairs and symbols', () => {
  const p = buildPlan({
    stairs: [{ start: [0, 0], direction: 90, width: 1200, treads: 10, going: 270 }],
    levels: [{ at: [0, 0], value: '+0.450' }],
    sections: [{ from: [0, -1000], to: [0, 5000], label: 'A' }],
    north: { at: [10000, 10000] },
    language: 'en',
  });
  assert.equal(p.entities.filter((e) => e.layer === 'A-FLOR-STRS' && e.type === 'line').length, 9);
  assert.ok(p.entities.some((e) => e.text === 'UP'));
  assert.ok(p.entities.some((e) => e.name === 'MCP_COTE' && e.attributes.COTE === '+0.450'));
  assert.ok(p.entities.some((e) => e.name === 'MCP_HUONG_BAC' && e.attributes.KY_HIEU === 'N'));
  assert.equal(p.entities.filter((e) => e.name === 'MCP_MAT_CAT' && e.attributes.TEN === 'A').length, 2);
  for (const n of ['MCP_COTE', 'MCP_HUONG_BAC', 'MCP_MAT_CAT', 'MCP_TRUC', 'MCP_THE_3', 'MCP_THE_TRAN_6', 'MCP_DEN_DOWNLIGHT', 'MCP_KY_HIEU_MD']) {
    assert.ok(symbolDef(n)?.entities?.length, n);
  }
});

test('standards: layers, styles, title block, scale fitting', () => {
  const specs = layerSpecs('vi');
  assert.ok(specs.length >= 30);
  assert.equal(new Set(specs.map((s) => s.name)).size, specs.length);
  assert.equal(ROLE.wall, 'A-WALL');
  assert.equal(specs.find((s) => s.name === 'A-AREA').plot, false);
  assert.ok(!('TUONG' in layerStyles('vi', { wall: 'TUONG' })));
  const st = styleParams({ scale: 50 });
  assert.equal(st.dim_style.name, 'MCP-1-50');
  assert.equal(st.ltscale, 20);
  const tb = titleBlock({ paper: 'A3', info: { title: 'MẶT BẰNG TẦNG 1', scale: '1:100' } });
  assert.deepEqual(tb.size, [420, 297]);
  // one block insert: the values are its attributes, every one defined in the block
  assert.equal(tb.entities.length, 1);
  const ins = tb.entities[0];
  assert.equal(ins.name, 'MCP_KHUNG_TEN_DOC_A3_NGANG'); // the vertical strip on every sheet
  assert.ok(ins.fit.TEN_BAN_VE > 40 && ins.fit.CONG_TRINH > 40 && ins.fit.SO_HD < 30, 'every value has the width of its cell');
  assert.ok(['CHU_DAU_TU', 'DU_AN', 'CONG_TRINH', 'SO_BAN_VE', 'GHI_CHU_CHUNG', 'TEN_BAN_VE_2'].filter((t) => t !== 'DU_AN').every((t) => t in ins.attributes));
  const bottom = titleBlock({ paper: 'A3', style: 'bottom', info: { title: 'X' } }).entities[0];
  assert.equal(bottom.name, 'MCP_KHUNG_TEN_A3_NGANG');
  assert.equal(titleBlock({ paper: 'A4', orientation: 'portrait' }).entities[0].name, 'MCP_KHUNG_TEN_DOC_A4_DUNG');
  assert.equal(titleBlock({ paper: 'A2', orientation: 'portrait' }).entities[0].name, 'MCP_KHUNG_TEN_DOC_A2_DUNG');
  assert.equal(ins.attributes.TEN_BAN_VE, 'MẶT BẰNG TẦNG 1');
  assert.equal(ins.attributes.TY_LE, '1:100');
  assert.deepEqual(Object.keys(ins.attributes).sort(), ins.def.attributes.map((a) => a.tag).sort());
  assert.ok(ins.def.entities.every((e) => e.layer === '0'));
  const [[x0, y0], [x1, y1]] = tb.area;
  assert.ok(x1 - x0 > 150 && y1 - y0 > 150);
  assert.equal(fitScale([30000, 20000], [380, 250]), 100);
  assert.equal(fitScale([3000, 2000], [380, 250]), 10);
});

// ---- elevations and sections
const BOX = {
  walls: [{ points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]], closed: true, thickness: 200, justify: 'right' }],
  openings: [{ wall: 0, segment: 0, at: [3000, 0], width: 1200, type: 'window', tag: 'S1' }],
  rooms: [{ name: 'PHÒNG', at: [3000, 2000] }],
  heights: { ground: -450, top: 3300, window_sill: 900, window_head: 2400 },
  roofs: [{ type: 'gable', ridge: 'y', pitch: 30, overhang: 400 }],
};
const lines = (r) => r.entities.filter((e) => e.type === 'line');
const hasLine = (r, a, b, tol = 1) => lines(r).some((l) => (near(l.from[0], a[0], tol) && near(l.from[1], a[1], tol) && near(l.to[0], b[0], tol) && near(l.to[1], b[1], tol))
  || (near(l.to[0], a[0], tol) && near(l.to[1], a[1], tol) && near(l.from[0], b[0], tol) && near(l.from[1], b[1], tol)));

test('front elevation: facade outline, window, gable roof apex, levels', () => {
  const r = buildElevation(BOX, { side: 'bottom', at: [0, 0] });
  // justify right: the wall body lies outside the axis rectangle -> outer faces at -200 and 6200; left end of the facade = x 0
  // the wall corners run up to the verge board, which hides their top
  const tv = 150 / Math.cos(Math.PI / 6);
  assert.ok(hasLine(r, [0, -450], [0, 3300 - tv]), 'left facade edge');
  assert.ok(hasLine(r, [6400, -450], [6400, 3300 - tv]), 'right facade edge');
  assert.ok(hasLine(r, [2600, 900], [3800, 900]), 'window sill line at x 2400..3600 + 200');
  const apexY = 3300 + 3200 * Math.tan(Math.PI / 6);
  assert.ok(lines(r).some((l) => near(l.to[1], apexY, 1) || near(l.from[1], apexY, 1)), 'gable apex');
  assert.deepEqual(r.levels, [-450, 0, 900, 2400, 3300, Math.round(apexY)]);
  assert.ok(r.entities.some((e) => e.text === 'MẶT ĐỨNG'));
});

test('side elevation shows the eaves side; nothing from the back wall leaks through', () => {
  const r = buildElevation(BOX, { side: 'left', at: [0, 0] });
  const eave = 3300 - 400 * Math.tan(Math.PI / 6);
  assert.ok(lines(r).some((l) => near(l.from[1], eave, 1) && near(l.to[1], eave, 1)), 'eave line');
  assert.ok(!r.entities.some((e) => e.type === 'line' && near(e.from[1], 900, 1) && near(e.to[1], 900, 1)), 'no window of the front wall in a side view');
});

test('a column in front hides the door lines behind it', () => {
  const spec = {
    walls: [{ points: [[0, 2000], [4000, 2000]], thickness: 200 }],
    openings: [{ wall: 0, at: [2000, 2000], width: 1600, type: 'double_door' }],
    columns: [{ at: [2000, 0], size: [400, 400] }],
    roofs: [],
  };
  const r = buildElevation(spec, { side: 'bottom', at: [0, 0] });
  const uMin = -100; // wall end extension: none, the face starts at the axis end 0 -> u 0
  for (const l of lines(r)) {
    const xm = (l.from[0] + l.to[0]) / 2, ym = (l.from[1] + l.to[1]) / 2;
    const insideCol = xm > 1800 + 1 && xm < 2200 - 1 && ym > -450 + 1 && ym < 3600 - 1;
    assert.ok(!insideCol, `line ${JSON.stringify(l)} is behind the column`);
  }
  assert.ok(uMin < 0);
});

test('section across the box: cut walls with the window gap, footing, room name, roof profile', () => {
  const r = buildSection(BOX, { from: [3000, -1000], to: [3000, 5000], look: 'left', label: 'A' });
  assert.equal(r.cut_walls, 2);
  assert.deepEqual(r.rooms, ['PHÒNG']);
  const hatches = r.entities.filter((e) => e.type === 'hatch' && e.pattern === 'ANSI31');
  assert.ok(hatches.length >= 3, 'front wall cut in two pieces around the window + back wall');
  assert.ok(r.entities.some((e) => e.text === 'MẶT CẮT A-A'));
  assert.ok(r.levels.includes(-1500) && r.levels.includes(2400));
});

test('section presentation: concrete solid, beams on the cut walls, ceilings with hangers and tags, levels both sides', () => {
  const ceilings = { 0: { 'PHÒNG': { level: 2800, drop: { width: 600, depth: 150 }, code: 'CL-01', floor_code: 'FL-01' } } };
  const spec = { ...BOX, rooms: [{ name: 'PHÒNG', at: [3000, 2000] }] };
  // at 1:50 the 3.8 m room is wide enough on paper for its finish tags (at 1:100 it would be under 50 mm: no tags)
  const r = buildSection(spec, { from: [3000, -1000], to: [3000, 5000], ceilings, scale: 50 });
  const narrow = buildSection(spec, { from: [3000, -1000], to: [3000, 5000], ceilings, scale: 100 });
  assert.ok(!narrow.entities.some((e) => e.attributes?.MA === 'CL-01'), 'no tags in a room under 50 mm of paper');
  noNaN(r.entities);
  assert.ok(r.entities.filter((e) => e.type === 'hatch' && e.pattern === 'SOLID').length >= 2, 'slab and beams poché');
  const ceil = r.entities.find((e) => e.type === 'polyline' && e.layer === 'A-CLNG');
  assert.ok(ceil && ceil.points.length === 6, 'ceiling with its drop band at both walls');
  assert.ok(r.entities.filter((e) => e.type === 'line' && e.layer === 'A-CLNG').length >= 1, 'hangers');
  assert.ok(r.entities.some((e) => e.attributes?.MA === 'CL-01') && r.entities.some((e) => e.attributes?.MA === 'FL-01'));
  const marks = r.entities.filter((e) => /^MCP_COTE/.test(e.name ?? ''));
  assert.ok(marks.some((e) => e.name === 'MCP_COTE_TRAI') && marks.some((e) => e.name === 'MCP_COTE'), 'levels on both sides');
  const plain = buildSection(spec, { from: [3000, -1000], to: [3000, 5000], poche: false, beam_depth: 0 });
  const solid = (x) => x.entities.filter((e) => e.type === 'hatch' && e.pattern === 'SOLID').length;
  assert.ok(plain.entities.some((e) => e.pattern === 'AR-CONC') && solid(plain) < solid(r), 'poche=false keeps the concrete pattern, beam_depth=0 no beams');
});

test('sections need a cut through the walls', () => {
  assert.throws(() => buildSection(BOX, { from: [-5000, -1000], to: [-5000, 5000] }), /crosses no wall/);
});

// ---- structural details
test('RC section: bars, stirrup with hooks, spacing warning', () => {
  const r = rcSection({ b: 220, h: 400, groups: [{ face: 'bottom', d: 16, n: 3, mark: '1' }, { face: 'top', d: 14, n: 2, mark: '2' }], stirrup: { d: 6, spacing: 150, mark: '3' } });
  assert.equal(r.entities.filter((e) => e.type === 'circle' && e.layer === 'S-REBR').length, 5);
  assert.equal(r.entities.filter((e) => e.layer === 'S-REBR-STIR').length, 3);
  assert.deepEqual(r.warnings, []);
  const w = rcSection({ b: 220, h: 400, groups: [{ face: 'bottom', d: 25, n: 5 }] });
  assert.equal(w.warnings.length, 1);
});

test('beam detail: bar lengths, stirrup zones, schedule', () => {
  const r = beamDetail({ spans: [4000], support: 200, b: 200, h: 400, cover: 25, bottom: { d: 16, n: 2, mark: '1' }, top: { d: 12, n: 2, mark: '2' }, extra_top: null, stirrup: { d: 6, end: 100, mid: 200, zone: 0.25, mark: '3' } });
  const bot = r.schedule.find((s) => s.mark === '1');
  assert.equal(bot.length, 4200 - 50 + 2 * Math.min(15 * 16, 400 - 50 - 6));
  const st = r.schedule.find((s) => s.mark === '3');
  // clear span 3800: 950 at a100 each end (10 + 10), middle 1900 at a200
  assert.ok(st.n >= 26 && st.n <= 32, `stirrups ${st.n}`);
});

test('assumptions: every default the engines apply is reported, nothing that was given', () => {
  const items = (a) => a.map((x) => x.item);
  const plan = planAssumptions({ walls: [{ id: 'W1', points: [[0, 0], [4000, 0]] }, { points: [[0, 0], [0, 3000]], thickness: 100, material: 'concrete' }], openings: [{ wall: 0, at: [2000, 0], tag: 'D1' }] });
  assert.deepEqual(plan, [
    { item: 'walls.thickness', value: 200, note: 'W1' }, { item: 'walls.material', value: 'brick', note: 'W1' },
    { item: 'openings.width', value: 900, note: 'D1' },
  ]);
  // BOX gives ground, top, the window sill/head and the roof pitch/overhang: floor, slab and the roof thickness are assumed
  const el = buildElevation(BOX, { side: 'bottom', at: [0, 0] });
  assert.deepEqual(items(el.assumed), ['heights.floor', 'heights.slab', 'heights.walls_to_roof', 'roofs[0].thickness']);
  const sec = buildSection(BOX, { from: [3000, -1000], to: [3000, 5000] });
  assert.ok(items(sec.assumed).includes('heights.foundation.depth') && items(sec.assumed).includes('heights.beam'));
  const given = buildSection({ ...BOX, heights: { ...BOX.heights, ground: -300, floor: 0, top: 3300, slab: 100, beam: 300, walls_to_roof: 'end', foundation: { depth: 1200, width: 800, height: 300, lean: 100 } } }, { from: [3000, -1000], to: [3000, 5000] });
  assert.deepEqual(items(given.assumed).filter((k) => k.startsWith('heights')), []);
  const beam = beamDetail({ spans: [4000], b: 200, h: 400, bottom: { d: 16, n: 2 }, top: { d: 12 }, extra_top: null, stirrup: { d: 6, end: 100, mid: 200 } });
  assert.deepEqual(items(beam.assumed), ['support', 'cover', 'top.n', 'stirrup.zone']);
  const foot = footingDetail({ B: 1200, H: 400, depth: 1500 });
  assert.ok(items(foot.assumed).includes('mesh.d') && !items(foot.assumed).includes('B'));
});

test('bar schedule weights (d²/162 kg/m)', () => {
  assert.ok(near(kgPerM(16), 1.58, 0.01));
  const s = rebarSchedule([{ mark: '1', d: 16, length: 1000, n: 2, members: 3 }, { mark: '2', d: 6, length: 500, n: 10 }]);
  assert.equal(s.rows[0].total, 6);
  assert.ok(near(s.rows[0].weight_kg, 6 * 1.58, 0.05));
  assert.ok(near(s.total_kg, s.rows[0].weight_kg + s.rows[1].weight_kg, 0.01));
  assert.equal(s.table[0][0], 'SỐ HIỆU');
});

// ---- interior design
const ROOM = cleanPoly([[0, 0], [6000, 0], [6000, 4000], [0, 4000], [0, 0]]);
const ROOM_SPEC = { ...BOX, openings: [{ wall: 0, segment: 2, at: [3000, 4000], width: 1200, type: 'window', tag: 'S1' }, { wall: 0, segment: 0, at: [1000, 0], width: 900, type: 'door', tag: 'D1' }], rooms: [{ name: 'PHÒNG NGỦ', at: [3000, 2000] }] };
const noNaN = (ents) => assert.ok(!JSON.stringify(ents).includes('null'), 'no NaN coordinates');

test('polygons: clean, offset, clip, tile joints centred in the room, plank stagger', () => {
  assert.equal(ROOM.length, 4);
  assert.ok(polyArea(ROOM) > 0);
  const inner = offsetPoly(ROOM, 600);
  assert.ok(near(Math.abs(polyArea(inner)), 4800 * 2800, 1));
  const segs = patternLines(ROOM, { size: [600, 600], start: [3000 - 300, 2000 - 300] });
  // joints at x = 2700 + 600k inside 0..6000 -> 300, 900, ..., 5700 (10); y = 1700 + 600k inside 0..4000 -> 500 ... 3500 (6)
  assert.equal(segs.length, 16);
  const planks = patternLines(ROOM, { kind: 'plank', size: [900, 150], start: [0, 0] });
  assert.ok(planks.length > 26 + 26 * 6, `plank joints ${planks.length}`);
  assert.deepEqual(cutBoxes([[[0, 0], [1000, 0]]], [[400, -10, 600, 10]]).length, 2);
});

test('stepped walls: one face for the elevation and the furniture, no step in the ceiling band', () => {
  // a 200 wall (face x 2900) continuing as a 100 one (face x 2950) on the right of the room
  const poly = cleanPoly([[200, 200], [2900, 200], [2900, 1850], [2950, 1850], [2950, 4150], [200, 4150]]);
  const e = roomEdge(poly, 'B');
  assert.ok(near(e.L, 3950, 1e-6) && near(e.a[0], 2950), JSON.stringify(e.a));
  const dj = dejog(poly);
  assert.equal(dj.length, 4);
  assert.ok(offsetPoly(dj, 600));
  const r = resolveItems([{ type: 'wardrobe', room: 'R', wall: 'A', code: 'JN-01' }, { type: 'wardrobe', room: 'R', wall: 'C', width: 1200, code: 'JN-01' }], { R: poly });
  assert.ok(r.warnings.some((w) => /JN-01 is given to/.test(w)));
});

test('furniture: a bed against wall A is centred with its back on the wall, code tag inside', () => {
  const r = resolveItems([{ type: 'bed', room: 'PHÒNG NGỦ', wall: 'A' }, { type: 'wardrobe', room: 'PHÒNG NGỦ', wall: 'D', offset: 200, width: 1800 }], { 'PHÒNG NGỦ': ROOM });
  const bed = r.items[0];
  assert.ok(near(bed.o[1], 4000) && near(bed.o[0], 2200) && near(bed.ey[1], -1), JSON.stringify(bed.o));
  assert.ok(r.assumed.some((a) => a.item === 'items[0].size') && r.assumed.some((a) => a.item === 'items[0].offset'));
  const ents = furniturePlan(r.items, { scale: 50 });
  noNaN(ents);
  assert.ok(tagOf(ents, 'FN-01'));
  // the bed is a block with its code, name and size; back on the wall (its frame y points into the room)
  const b = ents.find((e) => e.type === 'block' && e.name.startsWith('NT_FN-01_bed'));
  assert.ok(b && b.attributes.MA === 'FN-01' && b.attributes.KICH_THUOC === `${bed.w}x${bed.d}x${bed.h}`, JSON.stringify(b));
  assert.ok(nearPt(world(b, [0, 0]), bed.o) && nearPt(world(b, [0, 100]), [bed.o[0] + bed.ey[0] * 100, bed.o[1] + bed.ey[1] * 100]));
  assert.ok(nearPt(world(b, [100, 0]), [bed.o[0] + bed.ex[0] * 100, bed.o[1] + bed.ex[1] * 100]));
  assert.ok(b.def.entities.every((e) => e.layer === '0' || e.layer === 'A-HIDD' || e.layer === 'A-GLAZ'));
  assert.throws(() => resolveItems([{ type: 'piano', room: 'PHÒNG NGỦ', wall: 'A' }], { 'PHÒNG NGỦ': ROOM }), /type must be one of/);
});

test('interior elevation: window and bed on wall A, wardrobe seen from the side, notes and dimensions', () => {
  const { items } = resolveItems([{ type: 'bed', room: 'PHÒNG NGỦ', wall: 'A' }, { type: 'wardrobe', room: 'PHÒNG NGỦ', wall: 'D', offset_right: 0, width: 1800 }], { 'PHÒNG NGỦ': ROOM });
  const finish = resolveFinish('PHÒNG NGỦ');
  const r = interiorElevation({ spec: ROOM_SPEC, room: 'PHÒNG NGỦ', poly: ROOM, finish, items, wall: 'A', scale: 30 });
  noNaN(r.entities);
  assert.equal(r.openings, 1);
  assert.ok(r.items.some((s) => s.includes('bed (front)')) && r.items.some((s) => s.includes('wardrobe (side)')), r.items.join(';'));
  // material notes: tag multileaders (code boxed, short description) in a row above, floor and skirting under it
  const leaders = r.entities.filter((e) => e.type === 'leader');
  const code = (l) => l.attributes.MA;
  assert.ok(leaders.some((e) => code(e) === 'WL-01') && leaders.some((e) => code(e) === 'CL-01'), leaders.map(code).join(','));
  assert.ok(leaders.every((l) => /^MCP_GHI_CHU_(DUOI_)?\d+$/.test(l.block) && l.leader_linetype === 'DASHED' && l.attributes.MO_TA.length <= 26));
  const top = leaders.filter((l) => !l.block.includes('DUOI')), under = leaders.filter((l) => l.block.includes('DUOI'));
  assert.ok(under.some((l) => code(l) === 'FL-01') && under.some((l) => code(l) === 'SK-01'));
  assert.ok(top.every((l) => l.points[2][1] > l.points[0][1]) && under.every((l) => l.points[2][1] < l.points[0][1]));
  // none crosses another
  const segs = leaders.map((l) => l.points.map((p, i, a) => (i ? [a[i - 1], p] : null)).filter(Boolean));
  const crosses = ([a, b], [c, d]) => {
    const o = (p, q, r2) => Math.sign((q[0] - p[0]) * (r2[1] - p[1]) - (q[1] - p[1]) * (r2[0] - p[0]));
    return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
  };
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) for (const s1 of segs[i]) for (const s2 of segs[j]) assert.ok(!crosses(s1, s2), `${leaders[i].text} x ${leaders[j].text}`);
  for (const l of leaders) assert.ok(near(l.points[0][0], l.points[1][0], 0.01), 'first run straight up or down');
  assert.ok(r.entities.some((e) => e.layer === 'A-FURN') && r.entities.some((e) => e.layer === 'A-FLOR-CASE'), 'bed and wardrobe on their own layers');
  // the items are blocks (front MD, side MB), each with wipeouts under its outlines, its lines on layer 0
  const bl = r.entities.filter((e) => e.type === 'block' && /^NT_M[DB]_/.test(e.name));
  assert.ok(bl.some((b) => b.name.startsWith('NT_MD_FN-01_bed_') && b.layer === 'A-FURN') && bl.some((b) => b.name.startsWith('NT_MB_JN-01_wardrobe_') && b.layer === 'A-FLOR-CASE'), bl.map((b) => b.name).join(','));
  for (const b of bl) {
    const k = b.def.entities.findIndex((x) => x.type !== 'wipeout');
    assert.ok(k > 0 && b.def.entities.slice(k).every((x) => x.type !== 'wipeout'), 'wipeouts first');
    assert.ok(b.def.entities.filter((x) => x.type !== 'wipeout').every((x) => ['0', 'A-HIDD', 'A-GLAZ'].includes(x.layer)), 'lines by block');
  }
  assert.ok(!r.entities.some((e) => (e.type === 'line' || e.type === 'polyline') && (e.layer === 'A-FURN' || e.layer === 'A-FLOR-CASE')), 'no loose furniture lines');
  assert.ok(r.entities.filter((e) => e.type === 'dim_chain').length === 2);
  const c = resolveFinish('PHÒNG NGỦ');
  const wallC = interiorElevation({ spec: ROOM_SPEC, room: 'PHÒNG NGỦ', poly: ROOM, finish: c, items, wall: 'C', scale: 30 });
  assert.equal(wallC.openings, 1, 'the door on wall C');
});

test('ceiling plan: drop band, cove, downlights in the band, lamp, tags; WC flat with a grid', () => {
  const finishes = { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ'), WC: resolveFinish('WC') };
  const wc = cleanPoly([[7000, 0], [9000, 0], [9000, 2400], [7000, 2400]]);
  const r = ceilingPlan({ rooms: { 'PHÒNG NGỦ': ROOM, WC: wc }, finishes, scale: 50, legendAt: [10000, 4000] });
  noNaN(r.entities);
  const dl = r.lights.find((l) => l.kind === 'downlight');
  assert.ok(dl && dl.qty >= 10, JSON.stringify(r.lights));
  assert.ok(r.lights.some((l) => l.kind === 'strip' && l.qty > 10) && r.lights.some((l) => l.kind === 'ceiling_lamp'));
  assert.ok(r.entities.some((e) => /^MCP_THE_TRAN_/.test(e.name) && e.attributes.COTE === '+2.850'));
  assert.ok(r.entities.filter((e) => e.name === 'MCP_DEN_DOWNLIGHT' && e.attributes.MA === 'LT-01').length >= dl.qty);
  assert.equal(finishes.WC.ceiling.drop, null);
});

test('floor finish plan: no joint inside the room label, tags, legend with areas', () => {
  const r = floorFinishPlan({ rooms: { 'PHÒNG NGỦ': ROOM }, finishes: { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ') }, labels: { 'PHÒNG NGỦ': [3000, 2000] }, scale: 50, legendAt: [7000, 4000] });
  noNaN(r.entities);
  const box = [3000 - 700, 2000 - 200, 3000 + 700, 2000 + 200];
  for (const e of r.entities.filter((x) => x.type === 'line' && x.layer === 'A-FLOR-PATT' && x.from[0] < 6001)) {
    const m = [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2];
    assert.ok(!(m[0] > box[0] && m[0] < box[2] && m[1] > box[1] && m[1] < box[3] && Math.abs(e.from[0] - e.to[0]) < 1 && Math.abs(e.to[1] - e.from[1]) < 400), 'joint through the label');
  }
  assert.deepEqual(r.legend.map((l) => [l.code, l.area_m2]), [['FL-01', 24]]);
});

// a bedroom and a WC with a door between them
const TWO = {
  walls: [
    { id: 'W', points: [[0, 0], [8000, 0], [8000, 4000], [0, 4000]], closed: true, thickness: 200 },
    { id: 'P', points: [[6000, 0], [6000, 4000]], thickness: 100 },
  ],
  openings: [{ wall: 'P', at: [6000, 1000], width: 700, type: 'door', tag: 'D2' }],
  rooms: [{ name: 'PHÒNG NGỦ', at: [3000, 2000] }, { name: 'WC', at: [7000, 2000] }],
};
const TWO_ROOMS = { 'PHÒNG NGỦ': cleanPoly([[100, 100], [5950, 100], [5950, 3900], [100, 3900]]), WC: cleanPoly([[6050, 100], [7900, 100], [7900, 3900], [6050, 3900]]) };
const TWO_FIN = { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ'), WC: resolveFinish('WC') };

test('floor finish plan notes: transition strip at the door, floor drain and fall in the WC, set-out and drop notes', () => {
  const r = floorFinishPlan({ rooms: TWO_ROOMS, finishes: TWO_FIN, labels: { 'PHÒNG NGỦ': [3000, 2000], WC: [7000, 2000] }, scale: 50, legendAt: [9000, 4000], spec: TWO });
  noNaN(r.entities);
  // a solid strip across the door on the wall axis (x 6000, y 650..1350)
  const strip = r.entities.find((e) => e.type === 'hatch' && e.pattern === 'SOLID' && e.boundary.some((p) => near(p[1], 650, 1)));
  assert.ok(strip && strip.boundary.every((p) => Math.abs(p[0] - 6000) < 20), JSON.stringify(strip));
  const drain = r.entities.find((e) => e.name === 'MCP_PHEU_THU' && e.at[0] > 6050 && e.at[0] < 7900);
  assert.ok(drain, 'a floor drain in the WC');
  assert.ok(r.entities.some((e) => /^MCP_DOC/.test(e.name) && e.attributes.I === 'i=1%'), 'fall arrow');
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text.includes('HẠ 20')), 'drop note');
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text.includes('LÁT TỪ TÂM')), 'set-out note');
  assert.ok(r.assumed.some((a) => a.item === 'WC.floor.drop' && a.value === 20));
  assert.ok(r.legendBottom < 4000 - 30 * 50, `legend bottom ${r.legendBottom}`);
});

test('wall finish plan: bands broken at the door, tile joints in the WC, tags and legend areas', () => {
  const r = wallFinishPlan({ spec: TWO, rooms: TWO_ROOMS, finishes: TWO_FIN, labels: { 'PHÒNG NGỦ': [3000, 2000], WC: [7000, 2000] }, scale: 50, legendAt: [9000, 4000] });
  noNaN(r.entities);
  const bands = r.entities.filter((e) => e.type === 'line' && e.layer === 'A-WALL-FNSH');
  assert.ok(bands.length > 20, `${bands.length} band lines`);
  // no band along the bedroom face x = 5950 across the door (y 650..1350)
  const across = bands.filter((e) => Math.abs(e.from[0] - e.to[0]) < 1 && e.from[0] > 5800 && e.from[0] < 5950)
    .some((e) => Math.min(e.from[1], e.to[1]) < 1000 && Math.max(e.from[1], e.to[1]) > 1000);
  assert.ok(!across, 'the band stops at the door');
  // the WC is tiled: two band lines and joint ticks every 600 along its walls
  const wcTicks = bands.filter((e) => e.from[0] > 6050 && e.from[0] < 7900 && e.from[1] > 100 && e.from[1] < 3900 && Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1]) < 60);
  assert.ok(wcTicks.length >= 4, `${wcTicks.length} joints`);
  assert.ok(tagOf(r.entities, 'WL-01') && tagOf(r.entities, 'WL-02'));
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text.startsWith('ỐP ĐẾN TRẦN')));
  const wl1 = r.legend.find((l) => l.code === 'WL-01');
  assert.ok(wl1 && wl1.area_m2 > 30, JSON.stringify(r.legend));
});

test('ceiling plan modes: finish without lights (step widths dimensioned), lighting without level tags; general notes', () => {
  const rooms = { 'PHÒNG NGỦ': ROOM };
  const finishes = { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ') };
  const fin = ceilingPlan({ rooms, finishes, scale: 50, legendAt: [7000, 4000], mode: 'finish' });
  assert.ok(!fin.entities.some((e) => /^MCP_DEN_/.test(e.name ?? '')) && fin.lights === null);
  assert.ok(fin.entities.some((e) => e.type === 'dim' && e.kind === 'aligned'), 'the band width');
  assert.ok(fin.entities.some((e) => /^MCP_THE_TRAN_/.test(e.name ?? '')));
  assert.ok(fin.entities.some((e) => e.type === 'text' && e.text === 'CHÚ THÍCH VẬT LIỆU TRẦN'));
  const lit = ceilingPlan({ rooms, finishes, scale: 50, legendAt: [7000, 4000], mode: 'lighting' });
  assert.ok(lit.entities.some((e) => e.name === 'MCP_DEN_DOWNLIGHT') && !lit.entities.some((e) => /^MCP_THE_TRAN_/.test(e.name ?? '')));
  assert.ok(lit.lights.some((l) => l.kind === 'downlight'));
  assert.ok(generalNotes('floor').length >= 6 && generalNotes('lighting', 'en')[0].startsWith('Dimensions'));
  const nb = notesBlock(generalNotes('wall'), [0, 0], 50);
  assert.ok(nb[0].text === 'GHI CHÚ:' && nb[1].type === 'mtext' && nb[1].text.startsWith('1. ') && nb[1].text.includes('\n6. '));
});

test('joinery: kitchen front + section with notes, wardrobe; schedule areas and counts', () => {
  const k = joineryDetail({ kind: 'kitchen', width: 2400, sink: 600, hob: 1800 });
  noNaN(k.entities);
  assert.ok(k.entities.some((e) => e.type === 'leader' && e.text.startsWith('Mặt đá')) && k.entities.some((e) => e.text === 'MẶT CẮT 1-1'));
  assert.ok(k.assumed.some((a) => a.item === 'materials.top'));
  const w = joineryDetail({ kind: 'wardrobe', width: 1800 });
  noNaN(w.entities);
  const { items } = resolveItems([{ type: 'bed', room: 'PHÒNG NGỦ', wall: 'A' }], { 'PHÒNG NGỦ': ROOM });
  const s = materialSchedule({ spec: ROOM_SPEC, rooms: { 'PHÒNG NGỦ': ROOM }, finishes: { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ') }, items });
  const row = (code) => s.rows.find((r) => r.code === code);
  assert.equal(row('FL-01').qty, 24);
  assert.ok(near(row('SK-01').qty, 20 - 0.9, 0.01), `skirting ${row('SK-01').qty}`);
  assert.equal(row('FN-01').qty, 1);
  // the drawn table shows each item's and light's block in its symbol column
  assert.equal(s.drawn[0][1], 'KÝ HIỆU');
  const fn = s.drawn.find((r) => r[0] === 'FN-01');
  assert.ok(fn[1].block.startsWith('NT_FN-01_bed') && fn[1].def.entities.length, JSON.stringify(fn[1]).slice(0, 80));
  const withLight = materialSchedule({ spec: ROOM_SPEC, rooms: {}, finishes: {}, lights: [{ kind: 'downlight', code: 'LT-01', description: 'Đèn', unit: 'cái', qty: 3 }] });
  assert.equal(withLight.drawn[1][1].block, 'MCP_DEN_DOWNLIGHT');
  assert.equal(withLight.rows[0].symbol, 'MCP_DEN_DOWNLIGHT');
  // walls: 20 m x 2.85 m minus the window 1.2 x (2400 - 900) and the door 0.9 x 2.4
  assert.ok(near(row('WL-01').qty, 20 * 2.85 - 1.2 * 1.5 - 0.9 * 2.4, 0.01), `walls ${row('WL-01').qty}`);
});

// ---- buildings of several floors
const STAIR = { type: 'u', region: [[200, 3000], [2550, 6700]], direction: 'up', turn: 'right' };
const TOWN = {
  grids: { x: [100, 4900], y: [100, 9900] },
  heights: { ground: -450 },
  floors: [
    { walls: [{ id: 'W1', points: [[100, 100], [4900, 100], [4900, 9900], [100, 9900]], closed: true, thickness: 200 }],
      openings: [{ wall: 'W1', segment: 0, at: [3500, 100], width: 1200, type: 'window', tag: 'S1' }], stairs: [STAIR],
      rooms: [{ name: 'PHÒNG KHÁCH', at: [2500, 8000] }] },
    { openings: [{ wall: 'W1', segment: 0, at: [3500, 100], width: 1200, type: 'window', tag: 'S1' }], stairs: [STAIR],
      balconies: [{ region: [[0, -1200], [5000, 0]] }], rooms: [{ name: 'PHÒNG NGỦ', at: [2500, 8000] }] },
    { name: 'TUM', height: 2800, walls: [{ id: 'T1', points: [[100, 2900], [2650, 2900], [2650, 6800], [100, 6800]], closed: true, thickness: 200 }],
      parapet: { walls: ['W1'], height: 1000 }, roof: { type: 'flat', parapet: 0 }, rooms: [{ name: 'SÂN THƯỢNG', at: [3800, 1500] }] },
  ],
};

test('floors: levels from the heights, walls taken from the floor below, parapet walls, stairs arriving above', () => {
  const F = floorsOf(TOWN);
  assert.deepEqual(F.map((f) => [f.name, f.level, f.height]), [['TẦNG 1', 0, 3600], ['TẦNG 2', 3600, 3300], ['TUM', 6900, 2800]]);
  assert.equal(F[1].spec.walls[0].id, 'W1');
  assert.deepEqual(F[2].spec.walls.map((w) => [w.id, w.height]), [['T1', undefined], ['W1-TC', 1000]]);
  assert.equal(F[1].spec.stairs_below.length, 1);
  assert.equal(F[1].slab, 120);
  const g = uStairGeom(STAIR, 3300);
  assert.equal(g.risers, 19);
  assert.ok(near(g.going, (3700 - 1125) / 9, 0.01) && near(g.w, 1125, 1e-9));
  // floor 2: the stair goes up and comes up from below: LÊN and XUỐNG; the tum only XUỐNG
  const txt = (spec) => buildPlan(spec).entities.filter((e) => e.type === 'text').map((e) => e.text);
  assert.ok(txt(F[1].spec).includes('LÊN') && txt(F[1].spec).includes('XUỐNG'));
  assert.ok(!txt(F[2].spec).includes('LÊN') && txt(F[2].spec).includes('XUỐNG'));
});

test('interior dimensions: face to face through the room, clear of its name and of the window', () => {
  const f = floorsOf(TOWN)[0].spec;
  const chains = (spec) => buildPlan(spec).entities.filter((e) => e.type === 'dim_chain');
  const extra = chains({ ...f, interior_dimensions: true }).filter((c) => !chains(f).some((d) => JSON.stringify(d) === JSON.stringify(c)));
  assert.equal(extra.length, 2, JSON.stringify(extra));
  // between the inner faces of the outer walls
  assert.deepEqual(extra[0].points, [[200, 7100], [4800, 7100]]);
  // left of the name (PHÒNG KHÁCH: 11 characters)
  assert.deepEqual(extra[1].points, [[1210, 200], [1210, 9800]]);
  // a line through an opening moves aside: the window S1 (2900-4100) at the bottom
  const w = chains({ ...f, interior_dimensions: true, rooms: [{ name: 'P', at: [4000, 8000] }] }).filter((c) => c.direction === 'vertical' && c.points[0][1] === 200);
  assert.ok(w.length === 1 && (w[0].points[0][0] < 2850 || w[0].points[0][0] > 4150), JSON.stringify(w));
});

test('stacked elevation: every floor level, parapet top, tum roof; balcony railing', () => {
  const e = buildElevation(TOWN, { side: 'bottom' });
  assert.ok(!JSON.stringify(e.entities).includes('null'));
  for (const lv of [-450, 0, 3600, 6900, 7900]) assert.ok(e.levels.includes(lv), `level ${lv} in ${e.levels}`);
  assert.ok(e.levels.includes(6900 + 2800 + 120), 'tum roof top');
  // balusters every 150 between the railing posts of the 5 m balcony
  const bal = e.entities.filter((x) => x.type === 'line' && near(x.from[1], 3600, 1) && near(x.to[1], 3600 + 1050, 1));
  assert.ok(bal.length > 25, `balusters ${bal.length}`);
});

test('structural set: framing plan of the floor 2 slab, beam schedule, general notes, drawing list', () => {
  const fl = floorsOf(TOWN);
  const r = framingPlan({ spec: fl[0].spec, level: fl[1].level, slab: 120, name: fl[1].name, prefix: 'D2.', scale: 100, rooms: { WC: [[200, 200], [1500, 200], [1500, 1500], [200, 1500]] } });
  noNaN(r.entities);
  // the four walls of the ground floor carry the slab: two long beams (span 9800 -> 700) and two short (4800 -> 400)
  assert.deepEqual(r.beams.map((b) => [b.name, `${b.b}x${b.h}`, b.count]), [['D2.1', '200x700', 2], ['D2.2', '200x400', 2]]);
  assert.equal(r.columns[0].count, 4);
  assert.ok(r.entities.filter((e) => e.layer === 'S-BEAM').length === 8, 'two faces per beam');
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text === 'D2.1 (200x700)'));
  assert.ok(r.entities.some((e) => e.type === 'text' && /^S2 - SÀN (BTCT DÀY 120, )?HẠ 50/.test(e.text)), 'the WC slab lowered');
  assert.equal(r.entities.filter((e) => e.name === 'MCP_TRUC').length, 8);
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text === 'MẶT BẰNG KẾT CẤU SÀN TẦNG 2 (+3.600)'));
  assert.ok(r.assumed.some((a) => a.item === 'beam.h') && r.assumed.some((a) => a.item === 'column.size'));
  const bs = beamSchedule({ beams: r.beams, scale: 25 });
  noNaN(bs.entities);
  assert.ok(bs.entities.some((e) => e.type === 'text' && e.text === 'DẦM D2.1 (200x700) - SL: 02'));
  assert.equal(bs.entities.filter((e) => e.type === 'text' && (e.text === 'GỐI' || e.text === 'NHỊP')).length, 4);
  assert.ok(bs.entities.some((e) => e.name === 'MCP_COTE_TRAI' && e.attributes.COTE === 'FL+3.600'));
  assert.ok(bs.assumed.some((a) => a.item === 'D2.1.bars'));
  const sn = structureNotes({});
  assert.equal(sn.entities.filter((e) => e.type === 'table').length, 4);
  const laps = sn.entities.find((e) => e.type === 'table' && e.title.startsWith('CHIỀU DÀI NEO'));
  assert.deepEqual(laps.rows[3], ['Ø14', 450, 300, 600, 450]);
  assert.ok(sn.assumed.some((a) => a.item === 'concrete.main'));
  // the foundation plan: pad footings under the columns, ground beams under the ground floor walls
  const fd = framingPlan({ spec: fl[0].spec, level: -450, name: 'MÓNG', prefix: 'GM.', beam: { h: 400 }, foundation: { depth: 1500 }, rooms: { WC: [[200, 200], [1500, 200], [1500, 1500], [200, 1500]] } });
  assert.deepEqual(fd.footings, [{ name: 'M1', size: '1200x1200', count: 4, depth: 1500 }]);
  assert.ok(fd.beams.every((b) => b.name.startsWith('GM.') && b.h === 400));
  assert.ok(fd.entities.some((e) => e.type === 'text' && e.text === 'MẶT BẰNG MÓNG, GIẰNG MÓNG') && fd.assumed.some((a) => a.item === 'footing'));
  const dl = drawingList({ sheets: [{ number: 'KC-01', title: 'GHI CHÚ CHUNG', scale: '1:50', paper: 'A3' }], item: 'Kết cấu' });
  assert.equal(dl.entities[0].title, 'DANH MỤC BẢN VẼ - KẾT CẤU');
  const cv = coverSheet({ set: 'Kết cấu', info: { project: 'NHÀ PHỐ', client: 'CĐT', phase: 'TKTC', date: '11/2026' } });
  assert.ok(cv.entities.some((e) => e.text === 'HỒ SƠ BẢN VẼ KẾT CẤU') && cv.entities.some((e) => e.text === 'CÔNG TRÌNH:') && !cv.entities.some((e) => e.text === 'TỔNG THẦU:'));
  assert.deepEqual(dl.entities[0].rows[1].slice(0, 3), [1, 'KC-01', 'GHI CHÚ CHUNG']);
});

test('framing plan labels: clear of each other and of the stair opening; only the grids the beams reach', () => {
  const fl = floorsOf(TOWN);
  // the terrace round the stair tower: its vertex average falls in the stairwell
  const rooms = {
    'CẦU THANG': [[200, 3000], [2550, 3000], [2550, 6700], [200, 6700]],
    'SÂN THƯỢNG': [[200, 200], [4800, 200], [4800, 9800], [200, 9800], [200, 6800], [2650, 6800], [2650, 2900], [200, 2900]],
  };
  const r = framingPlan({ spec: fl[1].spec, level: 6900, slab: 120, name: 'TUM', prefix: 'DT.', rooms });
  // every room lowered: one label with the thickness, clear of the stair opening
  const only = r.entities.filter((e) => e.type === 'text' && /^S[12] -/.test(e.text));
  assert.ok(only.length === 1 && only[0].text === 'S2 - SÀN BTCT DÀY 120, HẠ 50', only.map((e) => e.text).join(' | '));
  assert.ok(!(only[0].at[0] > 200 && only[0].at[0] < 2550 && only[0].at[1] > 3000 && only[0].at[1] < 6700), 'over the stair opening');
  // a room at the slab level beside it: S1 there, S2 on the terrace, apart
  const rooms2 = { ...rooms, 'SÂN THƯỢNG': [[200, 200], [4800, 200], [4800, 2900], [200, 2900]], 'PHÒNG': [[2650, 2900], [4800, 2900], [4800, 9800], [200, 9800], [200, 6800], [2650, 6800]] };
  const r2 = framingPlan({ spec: fl[1].spec, level: 6900, slab: 120, name: 'TUM', prefix: 'DT.', rooms: rooms2 });
  const texts = r2.entities.filter((e) => e.type === 'text');
  const s1 = texts.find((e) => e.text.startsWith('S1 -')), s2 = texts.find((e) => e.text.startsWith('S2 -'));
  assert.ok(s1 && s2, 'both labels');
  const box = (e) => { const w = [...e.text].length * 0.72 * e.height; return [e.at[0] - w / 2, e.at[1] - 0.7 * e.height, e.at[0] + w / 2, e.at[1] + 0.7 * e.height]; };
  const [a, b] = [box(s1), box(s2)];
  assert.ok(!(a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]), `S1 ${s1.at} and S2 ${s2.at} overlap`);
  for (const e of [s1, s2]) assert.ok(!(e.at[0] > 200 && e.at[0] < 2550 && e.at[1] > 3000 && e.at[1] < 6700), `${e.text} over the stair opening`);
  // a roof over the tower only: its grid lines, not those of the whole building
  const tum = framingPlan({ spec: fl[2].spec, level: 9820, slab: 120, name: 'MÁI', prefix: 'DM.' });
  const bubbles = tum.entities.filter((e) => e.name === 'MCP_TRUC').map((e) => e.attributes.SO);
  assert.ok(!bubbles.includes('B') || bubbles.length <= 8, bubbles.join(','));
});

test('roof plan: the tower roof, the terrace inside its parapets, drains with falls, levels and notes', () => {
  const fl = floorsOf(TOWN);
  const top = fl[fl.length - 1];
  const r = roofPlan({ top, terrace: top.level, roof: top.level + top.height + 120, parapet: 1000 });
  noNaN(r.entities);
  // a drain pair in front of the stair tower and behind it, one on the tower roof
  assert.equal(r.drains, 5);
  assert.equal(r.entities.filter((e) => e.name === 'MCP_PHEU_THU').length, 5);
  assert.ok(r.entities.filter((e) => /^MCP_DOC/.test(e.name ?? '')).length >= 2, 'falls to the drains');
  assert.ok(r.entities.some((e) => e.text === 'SÂN THƯỢNG') && r.entities.some((e) => e.text === 'MÁI BTCT TUM'));
  assert.ok(r.entities.some((e) => e.name === 'MCP_COTE' && e.attributes.COTE === `+${(top.level / 1000).toFixed(3)}`), 'terrace level');
  assert.ok(r.notes.length === 3 && r.assumed.some((a) => a.item === 'fall'));
});

test('door and window schedule: one type per tag and size, counted by floor, elevations with dims, table', () => {
  const r = doorSchedule({ spec: TOWN, scale: 50 });
  noNaN(r.entities);
  const s1 = r.rows.find((x) => x.tag === 'S1');
  assert.ok(s1 && s1.type === 'window' && s1.count === 2 && s1.size === '1200x1500' && s1.sill === 900, JSON.stringify(r.rows));
  const table = r.entities.find((e) => e.type === 'table');
  assert.ok(table.rows.some((row) => row[0] === 'S1' && row[4] === 2 && String(row[5]).includes('TẦNG 1: 1')));
  assert.ok(r.entities.some((e) => e.name?.startsWith('MCP_THE_LG_') && e.attributes.MA === 'S1'), 'tag');
  assert.ok(r.entities.some((e) => e.type === 'line' && e.layer === 'A-HIDD' && !e.linetype), 'opening direction dashed (by layer)');
  assert.ok(r.entities.filter((e) => e.type === 'dim_chain').length >= 2 * r.rows.length);
  assert.ok(r.assumed.some((a) => a.item === 'materials.S1'));
});

test('section through the stair: slabs at each floor, flight cut (hatched steps), floors of rooms', () => {
  const s = buildSection(TOWN, { from: [700, -2000], to: [700, 11000], look: 'right', label: 'A' });
  assert.ok(!JSON.stringify(s.entities).includes('null'));
  const steps = s.entities.filter((x) => x.type === 'hatch' && x.boundary.length > 15);
  assert.ok(steps.length >= 2, `cut flights ${steps.length}`);
  assert.ok(s.levels.includes(3600) && s.levels.includes(6900));
  assert.deepEqual(s.rooms, ['TẦNG 1: PHÒNG KHÁCH', 'TẦNG 2: PHÒNG NGỦ']);
  assert.throws(() => floorsOf({ floors: [{ walls: [], parapet: { walls: ['W1'] } }] }), /no floor below/);
});

test('stair detail: plans of the start, typical and arrival floors, section 1-1, notes and the tread detail', () => {
  const r = stairDetail({ spec: TOWN });
  noNaN(r.main);
  noNaN(r.detail);
  assert.equal(r.stair.risers, 21);
  assert.deepEqual(r.stair.plans.map((p) => p.mode), ['up', 'both', 'down']);
  const texts = r.main.filter((e) => e.type === 'text').map((e) => e.text);
  for (const t of ['01', '20', 'MẶT BẰNG THANG TẦNG 1', 'MẶT BẰNG THANG TẦNG 2', 'MẶT BẰNG THANG TUM', 'MẶT CẮT 1-1', 'CHIẾU NGHỈ']) assert.ok(texts.includes(t), t);
  const dims = r.main.filter((e) => e.type === 'dimension').map((e) => e.text);
  assert.ok(dims.includes('10x257,5=<>') && dims.includes('11x171,4=<>'), dims.join(' | '));
  assert.ok(r.main.some((e) => e.name === 'MCP_COTE' && e.attributes.COTE === '+1.886'), 'landing level');
  assert.ok(r.main.filter((e) => e.type === 'hatch' && e.pattern === 'SOLID' && e.boundary.length > 20).length >= 2, 'cut flights');
  assert.ok(r.main.some((e) => e.type === 'mtext' && e.text.includes('2h + b = 600')));
  assert.equal(r.detail.filter((e) => e.type === 'leader').length, 7);
  assert.ok(r.detail.some((e) => e.type === 'text' && e.text === 'CHI TIẾT BẬC THANG'));
  assert.ok(r.assumed.some((a) => a.item === 'waist'));
});

test('structural calculation: three-moment equation, TCVN 5574 bending and shear, the frame of a building, the sheet', () => {
  // two equal spans pinned at the ends: -qL²/8 over the middle support
  assert.ok(near(supportMoments([4, 4], [10, 10])[1], -20, 1e-9));
  // one span framing into columns: qL²/24 over the supports, qL²/12 at midspan, qL/2 shear
  const a = analyseBeam([4.8], [10], [0]);
  assert.ok(near(a.sup[0], -9.6, 1e-9) && near(a.span[0].M, 19.2, 1e-9) && near(a.span[0].V, 24, 1e-9), JSON.stringify(a));
  // B20, CB300-V, 200x400, 69.4 kNm: αm 0.233, ξ 0.269, As 857 mm² (by hand)
  const mat = { c: CONCRETE.B20, s: STEEL['CB300-V'], sw: STEEL['CB240-T'] };
  const f = flexure(69.4, 200, 400, mat);
  assert.ok(near(f.am, 0.2328, 1e-3) && near(f.As, 857, 2) && near(f.xiR, 0.583, 1e-3) && f.ok, JSON.stringify(f));
  assert.deepEqual(chooseBars(f.As, 200), { n: 2, d: 25, A: 2 * Math.PI * 25 * 25 / 4 });
  assert.equal(chooseBars(413, 200).n, 3, 'three Ø14 rather than four Ø12');
  const s = stirrups(86.7, 200, 400, mat);
  assert.ok(s.d === 6 && s.support === 100 && s.ok, JSON.stringify(s));
  const R = structuralCalc({ spec: TOWN });
  assert.ok(!JSON.stringify(R.slabs.map((S) => S.types)).includes('null'));
  assert.deepEqual(R.slabs.map((S) => S.name), ['MÓNG', 'TẦNG 2', 'TUM', 'MÁI']);
  assert.ok(R.slabs.every((S) => S.types.every((t) => t.bars.span[0].n >= 2 && t.stirrups.support >= 50)));
  // the four corner columns on footings; the tower's columns stand on the TUM slab beams
  const footed = R.columns.filter((c) => !c.on);
  assert.equal(footed.length, 4, JSON.stringify(R.columns.map((c) => c.name)));
  assert.ok(R.columns.some((c) => c.on === 'TUM') && footed.every((c) => c.N > 0 && c.Areq > 0));
  assert.ok(R.assumed.some((x) => x.item === 'soil') && R.assumed.some((x) => x.item === 'live loads'));
  const sheet = calcSheet(R);
  const tables = sheet.entities.filter((e) => e.type === 'table');
  assert.ok(tables.some((t) => t.title === 'DẦM: NỘI LỰC VÀ CỐT THÉP') && tables.some((t) => t.title === 'XÁC NHẬN'), tables.map((t) => t.title).join(' | '));
  assert.ok(sheet.entities.some((e) => e.type === 'text' && /ký xác nhận/.test(e.text)), 'the sign-off note');
  const csv = calcCsv(R);
  assert.ok(csv.startsWith('﻿') && csv.includes('Chủ trì kết cấu') && csv.includes(';'));
});

test('bar schedule and bill of quantities of the structural set', () => {
  const R = structuralCalc({ spec: TOWN });
  const B = boqSheets(R);
  const titles = B.groups.map((g) => g.title);
  for (const t of ['MÓNG M1 (1200x1200)', 'CỘT 220x220', 'GIẰNG MÓNG', 'DẦM SÀN TẦNG 2', 'SÀN TẦNG 2 (theo cấu tạo)', 'CẦU THANG (theo cấu tạo)']) assert.ok(titles.includes(t), `${t} in ${titles.join(' | ')}`);
  // every beam type: bottom, support top, midspan top, stirrups; weights by d²/162
  const d2 = B.groups.find((g) => g.title === 'DẦM SÀN TẦNG 2');
  assert.equal(d2.rows.length, 4 * R.slabs[1].types.length);
  for (const r of d2.sched.rows) assert.ok(near(r.weight_kg, (r.total * r.length / 1000) * r.d * r.d / 162, 0.01));
  const Q = B.quantities;
  const q = (re) => Q.rows.find((r) => !r.head && re.test(r.item));
  assert.ok(near(q(/^Bê tông móng M1/).q, 4 * 1.2 * 1.2 * 0.4, 1e-6));
  assert.ok(q(/^Xây tường gạch dày 200/).q > 0 && q(/^Trát tường trong/).q > 0 && q(/^Trát tường ngoài/).q > 0 && q(/^Bê tông sàn TẦNG 2/).q > 0);
  const total = B.groups.reduce((s, g) => s + g.sched.total_kg, 0);
  assert.ok(near(Q.steel.total, total, 0.05), `${Q.steel.total} vs ${total}`);
  assert.ok(B.pages.length >= 1 && B.boq.entities.some((e) => e.type === 'table' && e.title === 'BẢNG TỔNG HỢP KHỐI LƯỢNG VẬT TƯ'));
  const csv = boqCsv(B.groups, Q);
  assert.ok(csv.includes('BẢNG THỐNG KÊ CỐT THÉP') && csv.includes('Bê tông móng M1'));
});

test('architectural finish quantities: tiles, paint inside and outside, waterproofing, stair granite, railings, doors', () => {
  const F = floorsOf(TOWN);
  const rooms = [
    { 'PHÒNG KHÁCH': [[200, 200], [4800, 200], [4800, 9800], [200, 9800]] },
    { 'PHÒNG NGỦ': [[1600, 200], [4800, 200], [4800, 9800], [1600, 9800]], WC: [[200, 200], [1500, 200], [1500, 1500], [200, 1500]] },
    { 'CẦU THANG': [[200, 3000], [2550, 3000], [2550, 6700], [200, 6700]], 'SÂN THƯỢNG': [[200, 200], [4800, 200], [4800, 9800], [200, 9800], [200, 6800], [2650, 6800], [2650, 2900], [200, 2900]] },
  ];
  const floors = F.map((f, i) => ({
    name: f.name, spec: f.spec, height: f.height, rooms: rooms[i],
    finishes: Object.fromEntries(Object.keys(rooms[i]).map((n) => [n, resolveFinish(n, {}, [], f.height)])),
  }));
  const Q = finishQuantities({ floors, spec: TOWN });
  const q = (re) => Q.rows.find((r) => !r.head && re.test(r.item));
  assert.ok(q(/^Lát nền: Gạch porcelain 600x600/).q > 0 && q(/^Gạch ốp tường 300x600/).q > 0, 'tiles');
  assert.ok(q(/^Bả matit tường trong/).q > 0 && q(/^Sơn tường trong/).q > 0 && q(/^Bả matit, sơn tường ngoài/).q > 0, 'paint');
  assert.ok(q(/^Trần thạch cao khung chìm/).q > 0 && q(/^Bả matit, sơn trần thạch cao/).q > 0, 'ceilings');
  assert.ok(q(/^Chống thấm sàn vệ sinh/).q > 0 && q(/^Chống thấm sân thượng/).q > 0 && q(/^Láng vữa tạo dốc, chống thấm mái tum/).q > 0, 'waterproofing');
  assert.ok(q(/^Ốp đá granite mặt bậc/).q > 0 && q(/^Lan can, tay vịn cầu thang/).q > 0 && q(/^Lan can ban công/).q > 0, 'stairs and railings');
  const s1 = Q.rows.find((r) => /^S1 - /.test(r.item ?? ''));
  assert.ok(s1 && s1.q === 2 && s1.unit === 'bộ', JSON.stringify(s1));
  // the outer wall of the ground floor: its outside face painted, its inside face counted with the room
  assert.ok(q(/^Bả matit, sơn tường ngoài/).by['TẦNG 1'] > 2 * (4.8 + 9.8) * 3, JSON.stringify(q(/^Bả matit, sơn tường ngoài/).by));
  const wb = finishWorkbook(Q, F.map((f) => f.name));
  assert.ok(wb.subarray(0, 2).toString() === 'PK' && wb.length > 2000);
  const kc = kcWorkbook(structuralCalc({ spec: TOWN }), null);
  assert.ok(kc.subarray(0, 2).toString() === 'PK');
  assert.equal(howFormula('12 x 1,40 x 1,40 x 0,1'), '12*1.40*1.40*0.1');
  assert.equal(howFormula('theo bảng thống kê cốt thép'), null);
});

// ---- smoke test: the bundled server starts, lists its tools and reports a clear error without AutoCAD
async function smoke() {
  const entry = path.join(ROOT, 'dist', 'bundle', 'server', 'index.mjs');
  const child = spawn(process.execPath, [entry], { env: { ...process.env, AUTOCAD_MCP_PORT: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      } catch { /* not JSON */ }
    }
  });
  // a server that cannot start answers nothing: fail with its error instead of waiting
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.on('exit', (code) => {
    for (const w of waiters.values()) w({ error: { message: `server exited (${code}): ${err.slice(0, 400)}` } });
    waiters.clear();
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    waiters.set(mid, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n');
  });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.ok(list.result, list.error?.message);
    const names = list.result.tools.map((t) => t.name);
    assert.equal(names.length, 53, names.join(','));
    for (const t of ['draw_plan', 'screenshot', 'install_autocad_bridge', 'quantity_takeoff']) assert.ok(names.includes(t));
    const ping = await rpc('tools/call', { name: 'ping', arguments: {} });
    assert.equal(ping.result.isError, true);
    assert.match(ping.result.content[0].text, /Cannot connect to AutoCAD/);
    const bad = await rpc('tools/call', { name: 'draw_plan', arguments: { walls: [{ points: [[0, 0], [1000, 0]] }], openings: [{ wall: 0, offset: 500, width: 900 }] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /does not fit/);
    // dry runs need no AutoCAD: they list the assumptions and draw nothing
    const dry = await rpc('tools/call', { name: 'draw_plan', arguments: { walls: [{ points: [[0, 0], [4000, 0]] }], dry_run: true } });
    const dr = JSON.parse(dry.result.content[0].text);
    assert.equal(dr.drawn, false);
    assert.deepEqual(dr.assumed.map((a) => a.item), ['walls.thickness', 'walls.material']);
    const dryEl = await rpc('tools/call', { name: 'draw_elevation', arguments: { dry_run: true } });
    assert.ok(JSON.parse(dryEl.result.content[0].text).assumed.some((a) => a.item === 'roofs'));
    const dryB = await rpc('tools/call', { name: 'draw_plan', arguments: { ...TOWN, dry_run: true } });
    const db = JSON.parse(dryB.result.content[0].text);
    assert.deepEqual(db.floors.map((f) => f.level), [0, 3600, 6900], dryB.result.content[0].text.slice(0, 300));
  } finally {
    child.kill();
  }
}

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.stack}`);
    process.exitCode = 1;
  }
}
try {
  await smoke();
  passed++;
} catch (e) {
  console.error(`FAIL smoke test\n  ${e.stack}`);
  process.exitCode = 1;
}
console.log(`${passed}/${tests.length + 1} tests passed`);
