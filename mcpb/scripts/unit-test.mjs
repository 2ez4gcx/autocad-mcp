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
import { defaultFixtures, inside } from '../src/mep.mjs';
import { electricalDesign, electricalPlan, electricalQuantities, singleLineDiagram } from '../src/electrical.mjs';
import { aForNorm, kForN, plumbingBasis, plumbingDesign, plumbingPlan, plumbingQuantities, plumbingRisers, septicDetail, supplyFlow } from '../src/plumbing.mjs';
import { electricalWorkbook, plumbingWorkbook } from '../src/mepbooks.mjs';
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
  assert.equal(ins.name, 'MCP_KHUNG_TEN_DOC_A3_NGANG_R'); // the vertical strip on every sheet (_R: with its revision rows)
  assert.ok(ins.fit.TEN_BAN_VE > 40 && ins.fit.CONG_TRINH > 40 && ins.fit.SO_HD < 30, 'every value has the width of its cell');
  assert.ok(['CHU_DAU_TU', 'DU_AN', 'CONG_TRINH', 'SO_BAN_VE', 'GHI_CHU_CHUNG', 'TEN_BAN_VE_2'].filter((t) => t !== 'DU_AN').every((t) => t in ins.attributes));
  const bottom = titleBlock({ paper: 'A3', style: 'bottom', info: { title: 'X' } }).entities[0];
  assert.equal(bottom.name, 'MCP_KHUNG_TEN_A3_NGANG');
  assert.equal(titleBlock({ paper: 'A4', orientation: 'portrait' }).entities[0].name, 'MCP_KHUNG_TEN_DOC_A4_DUNG_R');
  assert.equal(titleBlock({ paper: 'A2', orientation: 'portrait' }).entities[0].name, 'MCP_KHUNG_TEN_DOC_A2_DUNG_R');
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
const r2t = (v) => Math.round(v * 100) / 100;

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

test('furniture: a low cabinet without its television, a sideboard, round tables; an opening named in its error', async () => {
  const { TYPES } = await import('../src/interior.mjs');
  const high = (shapes) => Math.max(...shapes.flatMap((s) => (s.pts || [s.a, s.b].filter(Boolean)).map((p) => p[1])));
  assert.equal(high(TYPES.tv_cabinet.front(1800, 400, 450, {})), 1520);
  assert.equal(high(TYPES.tv_cabinet.front(1800, 400, 450, { tv: false })), 450);
  assert.equal(TYPES.tv_cabinet.plan(1800, 400, 450, { tv: false }).length, 1);
  assert.equal(high(TYPES.sideboard.front(1800, 450, 750, {})), 750);
  assert.deepEqual(TYPES.coffee_table.plan(900, 900, 420, { shape: 'round' }).map((s) => [s.k, s.r]), [['c', 450], ['c', 410]]);
  // a round dining table of 1200 with its chairs around: one per 600 of the round (6)
  assert.equal(TYPES.dining_table.plan(1200, 1200, 750, { shape: 'round' }).length, 1 + 2 * 6);
  const r = resolveItems([{ type: 'coffee_table', diameter: 900, center: [3000, 2000], facing: -90 }, { type: 'dining_table', shape: 'round', width: 1100, center: [1500, 2000], facing: -90 }], { 'PHÒNG NGỦ': ROOM });
  assert.deepEqual(r.items.map((i) => [i.w, i.d, i.description]), [[900, 900, 'Bàn trà Ø900'], [1100, 1100, 'Bộ bàn ăn Ø1100']]);
  assert.throws(() => resolveItems([{ type: 'sofa', shape: 'round', center: [1, 1] }], {}), /round is for coffee_table and dining_table/);
  const { buildModel } = await import('../src/elevation.mjs');
  assert.throws(() => buildModel({ walls: [{ points: [[0, 0], [5000, 0]], thickness: 200 }], openings: [{ wall: 0, offset: 1000, width: 1200, type: 'window', tag: 'S2', sill: 2400, head: 2100 }] }), /openings\[0\] \(S2\): its head 2100 must be above its sill 2400/);
});

test('floor zones, the designer\'s lights, a T-bar grid ceiling', async () => {
  const { outsidePolys, floorZones } = await import('../src/interior.mjs');
  // a joint across a zone keeps the parts outside it
  const cut = outsidePolys([[[0, 500], [6000, 500]]], [[[1000, 0], [2000, 0], [2000, 1000], [1000, 1000]]]);
  assert.deepEqual(cut.map(([a, b]) => [a[0], b[0]]), [[0, 1000], [2000, 6000]]);
  assert.equal(floorZones([{ rect: [[100, 100], [200, 200]], code: 'FL-02' }], {}).warnings.length, 1);
  const fin = { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ') };
  const zone = { rect: [[1000, 1000], [3000, 3000]], code: 'FL-02', description: 'Thảm tấm 500x500', size: [500, 500], note: 'LÁT ÂM SÀN' };
  const f = floorFinishPlan({ rooms: { 'PHÒNG NGỦ': ROOM }, finishes: fin, labels: { 'PHÒNG NGỦ': [4500, 2000] }, scale: 50, legendAt: [7000, 4000], zones: [zone] });
  noNaN(f.entities);
  // 24 m² room: 4 m² of carpet, 20 of tiles
  assert.deepEqual(f.legend.map((l) => [l.code, l.area_m2]), [['FL-01', 20], ['FL-02', 4]]);
  // no joint of the room inside the zone; the zone's own joints every 500 inside it
  const inZone = (p) => p[0] > 1001 && p[0] < 2999 && p[1] > 1001 && p[1] < 2999;
  const joints = f.entities.filter((e) => e.type === 'line' && e.layer === 'A-FLOR-PATT');
  const mids = joints.map((e) => [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2]);
  assert.ok(mids.filter(inZone).length >= 6, 'the zone has its joints');
  assert.ok(joints.every((e) => !(inZone(e.from) && !inZone(e.to)) || Math.abs(e.from[0] - e.to[0]) <= 2000), 'room joints stop at the zone');
  assert.ok(f.entities.some((e) => e.type === 'text' && e.text === 'LÁT ÂM SÀN'));
  // lights placed by hand: no automatic downlights; counted by code, a linear one with its length
  const c = ceilingPlan({
    rooms: { 'PHÒNG NGỦ': ROOM }, finishes: { 'PHÒNG NGỦ': { ...resolveFinish('PHÒNG NGỦ'), ceiling: { ...resolveFinish('PHÒNG NGỦ').ceiling, drop: null, grid: [600, 600] } } },
    scale: 50, legendAt: [7000, 4000],
    lights: [{ type: 'linear', from: [1000, 2000], to: [5000, 2000] }, { type: 'spot', at: [1500, 3000], aim: [1500, 4000] }, { type: 'spot', at: [4500, 3000] }, { type: 'access_panel', at: [5400, 600] }],
  });
  noNaN(c.entities);
  assert.ok(!c.entities.some((e) => e.name === 'MCP_DEN_DOWNLIGHT'), 'no automatic downlights');
  assert.deepEqual(c.lights.filter((l) => l.user).map((l) => [l.code, l.qty, l.length_m]), [['LT-06', 1, 4], ['LT-05', 2, undefined], ['AP-01', 1, undefined]]);
  // the T-bar grid: lines every 600 across the room
  assert.ok(c.entities.filter((e) => e.type === 'line' && e.layer === ROLE.ceiling).length >= 15);
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

test('joinery: display casework, elevation and section 1-1 at their own scales', async () => {
  const r = joineryDetail({ kind: 'display', width: 5750, bays: [{ title: 'SẢN PHẨM MỚI', subtitle: 'NEW ARRIVALS' }, {}, {}, {}, {}, { pegboard: true, picture: false }] });
  noNaN(r.entities);
  noNaN(r.section);
  // six bays between seven fins of 50: (5750 - 350) / 6 = 900 each
  assert.deepEqual(r.bays.map((b) => [b.x0, b.w]), [[50, 900], [1000, 900], [1950, 900], [2900, 900], [3850, 900], [4800, 900]]);
  // the height chain: plinth, base, shelf, picture, niche top, header, rail, ceiling
  const zc = r.entities.find((e) => e.type === 'dim_chain' && e.direction === 'vertical');
  assert.deepEqual(zc.points.map((p) => p[1]), [0, 80, 450, 480, 1450, 2000, 2060, 2090, 2490, 2600, 2800]);
  assert.equal(zc.style, 'MCP-1-30');
  assert.equal(r.section.find((e) => e.type === 'dim_chain').style, 'MCP-1-10');
  // one picture per bay but the pegboard one; the title of the bay on its header
  assert.equal(r.entities.filter((e) => e.type === 'line' && e.layer === 'A-DETL' && e.linetype).length, 0);
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text === 'SẢN PHẨM MỚI') && r.entities.some((e) => e.text === 'NEW ARRIVALS'));
  assert.ok(r.entities.some((e) => e.type === 'leader' && e.text.startsWith('Bảng đục lỗ')), 'the pegboard has its note');
  assert.ok(r.section.some((e) => e.type === 'leader' && e.text.startsWith('LT-07')) && r.section.some((e) => e.text === 'MẶT CẮT 1-1 - TỦ TRƯNG BÀY JN-10'));
  // codes of their own: none of the furniture library (JN-01..09), the ceiling lamp (LT-03) or the damp-proof ceiling (CL-02)
  assert.ok(![...r.entities, ...r.section].some((e) => e.type === 'leader' && /^(JN-0\d|LT-0[1-6]|CL-0[12]) /.test(e.text)));
  assert.equal(r.schedule[0].code, 'JN-10');
  // every note once in the section
  const texts = r.section.filter((e) => e.type === 'leader').map((e) => e.text);
  assert.equal(new Set(texts).size, texts.length);
  // the section stands to the right of the elevation's notes
  assert.ok(r.section_extent.min[0] > r.extent.max[0]);
  assert.ok(r.assumed.some((a) => a.item === 'materials.fin') && r.assumed.some((a) => a.item === 'ceiling'));
  // a given count of bays shares the width; no ceiling, no bulkhead
  const n = joineryDetail({ kind: 'display', width: 2900, bays: 3, ceiling: null, display: { picture: null } });
  assert.deepEqual(n.bays.map((b) => b.w), [900, 900, 900]);
  assert.ok(!n.entities.some((e) => e.layer === ROLE.ceiling));
  assert.throws(() => joineryDetail({ kind: 'display', width: 1200, bays: 4 }), /bays come out/);
  assert.throws(() => joineryDetail({ kind: 'display', width: 3000, height: 1500 }), /under 600/);
  assert.throws(() => joineryDetail({ kind: 'display', width: 3000, display: { picture: [300, 2000] } }), /display.picture/);
  assert.throws(() => joineryDetail({ kind: 'cupboard' }), /kitchen, wardrobe or display/);
  assert.throws(() => joineryDetail({ kind: 'display', width: 2000, display: { picture: [1800, 1500] } }), /at least 100 above its bottom/);
  assert.throws(() => joineryDetail({ kind: 'display', width: 2000, display: { base: 100 } }), /at least 150 above the plinth/);
  // no plinth: no flat hatch, no plinth in the section
  const np = joineryDetail({ kind: 'display', width: 2000, display: { plinth: 0 } });
  assert.ok(!np.entities.some((e) => e.type === 'hatch' && e.boundary[0][1] === e.boundary[2][1]));
  assert.ok(![...np.entities, ...np.section].some((e) => e.type === 'leader' && e.text.startsWith('Chân lùi')));
  // narrow bays: the icon stays inside its bay
  const nb = joineryDetail({ kind: 'display', width: 1000, bays: [{ w: 300, title: 'A' }, { w: 300 }, { w: 300 }], display: { fin: 25 } });
  const icons = nb.entities.filter((e) => e.type === 'hatch' && e.pattern === 'ANSI37');
  assert.ok(icons.every((h, i) => h.boundary[0][0] > nb.bays[i].x0 && h.boundary[1][0] < nb.bays[i].x0 + nb.bays[i].w), JSON.stringify(icons.map((h) => h.boundary[0])));
  // a pegboard without room under a low picture is left out with a warning; a section through a bay without a picture shows none
  assert.equal(joineryDetail({ kind: 'display', width: 2000, bays: [{ pegboard: true }, {}], display: { picture: [580, 1200] } }).warnings.length, 1);
  assert.ok(!joineryDetail({ kind: 'display', width: 2000, bays: [{ picture: false }, { picture: false }] }).section.some((e) => e.type === 'leader' && e.text.startsWith('Tranh in UV')));
  // an update draws the view as it was: a null (no ceiling, no wall cabinets) is kept with the view
  const { keptArgs } = await import('../src/views.mjs');
  assert.deepEqual(keptArgs('draw_joinery_detail', { kind: 'display', ceiling: null, wall: null, at: [0, 0] }), { kind: 'display', ceiling: null, wall: null });
});

test('lighting: illuminance from point sources, tasks by room name, the lights of the ceiling plan', async () => {
  const { lightingCalc, luxTable, roomGrid, taskOf } = await import('../src/lux.mjs');
  const sq = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
  const one = (f) => lightingCalc({ rooms: { A: sq }, fixtures: [{ room: 'A', at: [500, 500], z: 2750, ...f }], mf: 1, margin: 0, spacing: 1000, reflectances: { ceiling: 0, walls: 0, floor: 0 } }).rooms[0];
  // a diffuse source of 1000 lm, 2 m above the point: I = Φ/π, E = I/h² = 79.6 lx
  assert.equal(one({ kind: 'ceiling_lamp', lm: 1000 }).em, 80);
  // a 60° beam: k = ln 0.5 / ln cos 30° = 4.82, I = Φ (k+1) / 2π = 927 cd, E = 232 lx
  assert.equal(one({ kind: 'downlight', lm: 1000 }).em, 232);
  // a pendant hangs 900 below the ceiling: h = 1.1 m
  assert.equal(one({ kind: 'pendant', lm: 1000 }).em, Math.round(1000 / Math.PI / 1.21));
  // a spot aimed away lights the point less than straight down
  assert.ok(one({ kind: 'spot', lm: 1000, aim: [2500, 500] }).em < one({ kind: 'spot', lm: 1000 }).em / 2);
  // grid: EN 12464-1 cell size for a 5 m side 0.2 x 5^log10(5) = 0.62 m, the 0.5 m band left out
  const g = roomGrid([[0, 0], [6000, 0], [6000, 4000], [0, 4000]]);
  assert.equal(g.points.length, 9 * 5);
  assert.ok(g.points.every((p) => p[0] > 500 && p[0] < 5500 && p[1] > 500 && p[1] < 3500));
  assert.deepEqual(['PHÒNG HỌP', 'HÀNH LANG', 'SẢNH LỄ TÂN', 'SHOWROOM', 'WC NAM', 'PHÒNG NGỦ 1', 'PHÒNG KHÁCH', 'KHO', 'XYZ'].map(taskOf),
    ['meeting', 'corridor', 'reception', 'sales', 'toilet', 'bedroom', 'living', 'storage', null]);
  // whole words: "ăn" (dining) is not in "CĂN HỘ"; a restaurant kitchen, an office, a plant room
  assert.deepEqual(['CĂN HỘ', 'BẾP NHÀ HÀNG', 'PHÒNG LÀM VIỆC', 'PHÒNG KỸ THUẬT', 'PHÒNG ĂN', 'Meeting room 2', 'BẾP ĂN', 'BẾP ĂN TẬP THỂ'].map(taskOf),
    [null, 'kitchen_commercial', 'office', 'plant', 'dining', 'meeting', 'kitchen', 'kitchen_commercial']);
  // the ceiling plan keeps its lights: the band downlights hang from the band (150 lower), the lamp from the field
  const c = ceilingPlan({ rooms: { 'PHÒNG HỌP': ROOM }, finishes: { 'PHÒNG HỌP': resolveFinish('PHÒNG NGỦ') }, scale: 50 });
  assert.ok(c.fixtures.filter((f) => f.kind === 'downlight').every((f) => f.z === 2850 && f.room === 'PHÒNG HỌP'));
  assert.equal(c.fixtures.find((f) => f.kind === 'ceiling_lamp').z, 3000);
  assert.equal(c.fixtures.find((f) => f.kind === 'strip').length_m, 14.56);
  // lights placed by hand, moved by the offset of the copy: plan coordinates kept, the room found, lm carried
  const m = ceilingPlan({ rooms: { 'PHÒNG HỌP': ROOM }, finishes: { 'PHÒNG HỌP': resolveFinish('PHÒNG NGỦ') }, scale: 50, offset: [20000, 0], lights: [{ type: 'linear', from: [1000, 2000], to: [5000, 2000], lm: 4000 }, { type: 'access_panel', at: [5000, 600] }] });
  assert.deepEqual(m.fixtures.filter((f) => f.kind !== 'strip').map((f) => [f.kind, f.room, f.from, f.z, f.lm]), [['linear', 'PHÒNG HỌP', [1000, 2000], 3000, 4000]]);
  // 16 downlights of 800 lm and a lamp in 24 m²: well under the 500 lx of a meeting room, with advice
  const r = lightingCalc({ rooms: { 'PHÒNG HỌP': ROOM }, heights: { 'PHÒNG HỌP': 3000 }, fixtures: c.fixtures });
  const row = r.rooms[0];
  assert.equal(row.task, 'meeting');
  assert.equal(row.pass, false);
  assert.ok(row.em > 100 && row.em < 500, `Em ${row.em}`);
  assert.ok(row.advice[0].includes('lm'));
  assert.equal(row.lights, c.fixtures.length);
  assert.equal(row.power_w, r2t(16 * 9 + 20 + 14.56 * 8));
  assert.ok(r.assumed.some((a) => a.item === 'photometry.LT-01') && r.assumed.some((a) => a.item === 'PHÒNG HỌP.task'));
  // brighter downlights pass; a bedroom is a reference value (no pass or fail of the standard)
  const ok = lightingCalc({ rooms: { 'PHÒNG HỌP': ROOM }, fixtures: c.fixtures, photometry: { 'LT-01': { lm: 2600, beam: 90 } } }).rooms[0];
  assert.equal(ok.pass, true, JSON.stringify(ok));
  const bed = lightingCalc({ rooms: { 'PHÒNG NGỦ': ROOM }, fixtures: c.fixtures.map((f) => ({ ...f, room: 'PHÒNG NGỦ' })) }).rooms[0];
  assert.equal(bed.pass, null);
  assert.equal(bed.meets, true);
  // a corridor is measured on the floor
  assert.equal(lightingCalc({ rooms: { 'HÀNH LANG': ROOM }, fixtures: [] }).rooms[0].plane_mm, 0);
  assert.match(lightingCalc({ rooms: { 'HÀNH LANG': ROOM }, fixtures: [{ kind: 'downlight', code: 'LT-01', room: null, at: [9000, 0], z: 3000 }] }).warnings[0], /1 light\(s\) outside the rooms/);
  // a display wall lit by spots aimed at it, against one lit by downlights only
  const wall = { from: [0, 3800], to: [6000, 3800], z0: 800, z1: 2000 };
  const spots = [1000, 3000, 5000].map((x) => ({ kind: 'spot', code: 'LT-05', room: 'R', at: [x, 3000], aim: [x, 4000], z: 3000 }));
  const downs = [1000, 3000, 5000].map((x) => ({ kind: 'downlight', code: 'LT-01', room: 'R', at: [x, 3000], z: 3000 }));
  const vS = lightingCalc({ rooms: { R: ROOM }, fixtures: spots, vertical: [{ ...wall, em: 150 }], reflectances: { walls: 0, ceiling: 0, floor: 0 } }).vertical[0];
  const vD = lightingCalc({ rooms: { R: ROOM }, fixtures: downs, vertical: [wall], reflectances: { walls: 0, ceiling: 0, floor: 0 } }).vertical[0];
  assert.ok(vS.em > vD.em, `${vS.em} > ${vD.em}`);
  assert.equal(vS.room, 'R');
  assert.equal(typeof vS.pass, 'boolean');
  const t = luxTable(r);
  assert.equal(t[0][0], 'Phòng');
  assert.equal(t[1][11], 'KHÔNG ĐẠT');
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
  // the floor runs on under the door D1 to the middle of the 200 wall: 24 + 0.9 x 0.1 (counted since the surface model
  // measures the floor under the doors)
  assert.equal(row('FL-01').qty, 24.09);
  assert.ok(near(row('SK-01').qty, 20 - 0.9, 0.01), `skirting ${row('SK-01').qty}`);
  assert.equal(row('FN-01').qty, 1);
  // the drawn table shows each item's and light's block in its symbol column
  assert.equal(s.drawn[0][1], 'KÝ HIỆU');
  const fn = s.drawn.find((r) => r[0] === 'FN-01');
  assert.ok(fn[1].block.startsWith('NT_FN-01_bed') && fn[1].def.entities.length, JSON.stringify(fn[1]).slice(0, 80));
  const withLight = materialSchedule({ spec: ROOM_SPEC, rooms: {}, finishes: {}, lights: [{ kind: 'downlight', code: 'LT-01', description: 'Đèn', unit: 'cái', qty: 3 }] });
  assert.equal(withLight.drawn[1][1].block, 'MCP_DEN_DOWNLIGHT');
  assert.equal(withLight.rows[0].symbol, 'MCP_DEN_DOWNLIGHT');
  // walls: 20 m x 2.85 m minus the window 1.2 x (2400 - 900) and the door 0.9 x 2.4, plus their reveals 75 deep (half
  // the 200 wall less half a 50 frame): window (2 x 1.5 + 1.2 head + 1.2 sill) x 0.075 = 0.405, door (2 x 2.4 + 0.9) x
  // 0.075 = 0.4275: 53.87 m²
  assert.ok(near(row('WL-01').qty, 20 * 2.85 - 1.2 * 1.5 - 0.9 * 2.4 + 5.4 * 0.075 + 5.7 * 0.075, 0.01), `walls ${row('WL-01').qty}`);
  // the ceiling: the plan of the room 24 m² and the drop face of the band (20 - 8 x 0.6) x 0.15 = 2.28 m²
  assert.equal(row('CL-01').qty, 26.28);
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
  // between the inner faces of the outer walls: under the name (at 8000, 3.4 x 250 high) and over the stair (to 6700)
  const [h, v] = [extra.find((c) => c.direction === 'horizontal'), extra.find((c) => c.direction === 'vertical')];
  assert.deepEqual(h.points.map((q) => q[0]), [200, 4800]);
  assert.ok(h.points[0][1] === h.points[1][1] && h.points[0][1] > 6700 && h.points[0][1] < 8000 - 425, JSON.stringify(h));
  // beside the name (PHÒNG KHÁCH: 11 characters, 2500 +- 1073), clear of the stair (to 2550) and of the window S1 (2900-4100)
  assert.deepEqual(v.points.map((q) => q[1]), [200, 9800]);
  assert.ok(v.points[0][0] === v.points[1][0] && v.points[0][0] > 4150 && v.points[0][0] < 4800, JSON.stringify(v));
  // a line through an opening moves aside: the window S1 (2900-4100) at the bottom
  const w = chains({ ...f, interior_dimensions: true, rooms: [{ name: 'P', at: [1200, 8500] }] }).filter((c) => c.direction === 'vertical' && c.points[0][1] === 200);
  assert.ok(w.length === 1 && (w[0].points[0][0] < 2850 || w[0].points[0][0] > 4150), JSON.stringify(w));
  // a room with no line clear of its name and walls is not dimensioned inside: a note says so
  const small = { walls: [{ points: [[0, 0], [1600, 0], [1600, 1400], [0, 1400]], closed: true, thickness: 200 }], rooms: [{ name: 'KHO', at: [800, 700] }], interior_dimensions: true };
  const ps = buildPlan(small);
  assert.ok(!ps.entities.some((e) => e.type === 'dim_chain' && e.points.length === 2 && e.at[1] === e.points[0][1] && e.at[0] === e.points[0][0]));
  assert.equal(ps.notes.filter((n) => /^KHO: no clear line/.test(n)).length, 2, ps.notes.join(' | '));
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
  // the names: the tower's wrapped to fit inside the tower walls
  const names = r.entities.filter((e) => e.type === 'text').map((e) => e.text).join(' ');
  assert.equal(names, 'SÂN THƯỢNG MÁI BTCT TUM');
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
  assert.ok(r.detail.some((e) => e.type === 'text' && e.text === 'CHI TIẾT BẬC THANG (TẦNG 1)'));
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
  for (const t of [`MÓNG M1 (${R.footings[0].B}x${R.footings[0].L})`, 'CỘT C1 (220x220)', 'GIẰNG MÓNG', 'DẦM SÀN TẦNG 2', 'SÀN TẦNG 2', 'CẦU THANG']) assert.ok(titles.includes(t), `${t} in ${titles.join(' | ')}`);
  // every beam type: bottom, support top, midspan top, stirrups; weights by d²/162
  const d2 = B.groups.find((g) => g.title === 'DẦM SÀN TẦNG 2');
  assert.equal(d2.rows.length, 4 * R.slabs[1].types.length);
  for (const r of d2.sched.rows) assert.ok(near(r.weight_kg, (r.total * r.length / 1000) * r.d * r.d / 162, 0.01));
  const Q = B.quantities;
  const q = (re) => Q.rows.find((r) => !r.head && re.test(r.item));
  assert.ok(near(q(/^Bê tông móng M1/).q, R.footings.reduce((s, f) => s + f.count * (f.B / 1000) * (f.L / 1000) * (f.H / 1000), 0), 1e-3));
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

// ---- the architectural set (KT): quantities by measure, the live finish workbook, labels clear of each other

const boxesHit = (a, b) => a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1;
const segHits = (a, b, bx) => {
  let t0 = 0, t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  for (const [p, q] of [[-d[0], a[0] - bx[0]], [d[0], bx[2] - a[0]], [-d[1], a[1] - bx[1]], [d[1], bx[3] - a[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
    if (t0 > t1) return false;
  }
  return true;
};
const textBox = (e, k = 0.8) => {
  const w = [...e.text].length * k * e.height;
  return [e.at[0] - w / 2, e.at[1] - e.height / 2, e.at[0] + w / 2, e.at[1] + e.height / 2];
};
// level mark: the triangle on its point, the value over a line 13.5 paper mm long to its right
const coteBox = (e) => [e.at[0] - 1.5 * e.scale, e.at[1], e.at[0] + 12 * e.scale, e.at[1] + 5.8 * e.scale];
const KT_ROOMS = [
  { 'PHÒNG KHÁCH': [[200, 200], [4800, 200], [4800, 9800], [200, 9800]] },
  { 'PHÒNG NGỦ': [[1600, 200], [4800, 200], [4800, 9800], [1600, 9800]], WC: [[200, 200], [1500, 200], [1500, 1500], [200, 1500]] },
  // the terrace up to the faces of the tower walls (T1: 200 thick about its axis)
  { 'CẦU THANG': [[200, 3000], [2550, 3000], [2550, 6700], [200, 6700]], 'SÂN THƯỢNG': [[200, 200], [4800, 200], [4800, 9800], [200, 9800], [200, 6900], [2750, 6900], [2750, 2800], [200, 2800]] },
];
const ktQuantities = (spec, rooms = KT_ROOMS) => {
  const F = floorsOf(spec);
  const floors = F.map((f, i) => ({ name: f.name, spec: f.spec, height: f.height, rooms: rooms[i], finishes: Object.fromEntries(Object.keys(rooms[i]).map((n) => [n, resolveFinish(n, {}, [], f.height)])) }));
  return { F, Q: finishQuantities({ floors, spec }) };
};
// a hall around a stairwell (L-shaped seen from either leg), a door in the far wall of its front leg
const HALL = {
  walls: [
    { id: 'W1', points: [[100, 100], [4900, 100], [4900, 9900], [100, 9900]], closed: true, thickness: 200 },
    { id: 'I1', points: [[100, 2950], [2600, 2950]], thickness: 100 },
    { id: 'I2', points: [[2600, 2950], [2600, 6750]], thickness: 100 },
    { id: 'I3', points: [[100, 6750], [2600, 6750]], thickness: 100 },
  ],
  openings: [{ wall: 'W1', segment: 1, at: [4900, 1550], width: 900, type: 'door', tag: 'D1' }],
  rooms: [{ name: 'SẢNH', at: [3750, 5000] }],
};

test('finish quantities: walls by the height behind each edge, balconies, the arrival floor of the stair, outer faces to the corners', () => {
  const { Q } = ktQuantities(TOWN);
  const row = (key) => Q.rows.find((r) => r.key === key);
  // the terrace: 24.3 m of parapet 1000 high and 9.2 m of tower wall 2800 high, not 33.5 m of a full storey
  const ter = Q.rooms.find((r) => r.room === 'SÂN THƯỢNG');
  assert.equal(ter.kind, 'terrace');
  assert.ok(near(ter.per, 33.5, 1e-6) && near(ter.wallH * ter.per, 24.3 * 1.0 + 9.2 * 2.8, 0.01), JSON.stringify(ter));
  // the balcony of floor 2 (5.0 x 1.2): outdoor tiles, waterproofing with 300 up its edges, its soffit painted
  const bal = Q.rooms.find((r) => r.kind === 'balcony');
  assert.ok(bal && bal.floor === 'TẦNG 2' && near(bal.area, 6, 1e-9) && near(bal.per, 12.4, 1e-9), JSON.stringify(bal));
  assert.ok(near(row(`floor|${bal.floorCode}`).by['TẦNG 2'], 6, 0.005));
  assert.ok(near(row('water|BALC').by['TẦNG 2'], 6 + 0.3 * 12.4, 0.005));
  // the soffits of the floor: the balcony 6 m² and the stair that starts there, on the slope (19 risers of 3300 / 19 on
  // goings of 2575 / 9, flights 1125 wide: flight 1 hypot(9 goings, 10 risers) = 3.106, flight 2 hypot(8 goings, 9
  // risers) = 2.772, the half landing 1.125 x 2.35 = 2.644): 6 + 9.256
  const going2 = 2575 / 9, riser2 = 3300 / 19;
  const stairSoffit = ((Math.hypot(9 * going2, 10 * riser2) + Math.hypot(8 * going2, 9 * riser2)) * 1125 + 1125 * 2350) / 1e6;
  assert.ok(near(stairSoffit, 9.256, 0.001) && near(row('paint|SLAB').by['TẦNG 2'], 6 + stairSoffit, 0.005), JSON.stringify(row('paint|SLAB').by));
  // the stairwell of the arrival floor has no flight: no skirting along steps there (the terrace keeps its own)
  assert.equal(Q.rooms.find((r) => r.floor === 'TUM' && r.kind === 'stair').skirtingCode, null);
  assert.ok(near(row(`floor|${ter.skirtingCode}`).by.TUM, ter.per, 0.005));
  // the facade of the ground floor by hand: 2 x (5.0 + 10.0) m (to the corners, not the wall axes) x (3.6 + 0.45), less
  // the window 1.2 x 1.5, plus the outside half of its reveals (2 x 1.5 + 1.2 + 1.2) x 0.075 = 0.405
  assert.ok(near(row('paint|OUT').by['TẦNG 1'], 30 * 4.05 - 1.2 * 1.5 + 5.4 * 0.075, 0.005), JSON.stringify(row('paint|OUT').by));
  // the stair open to the room (a wall beside flight 1 only): its skirting steps along that wall and one side of the
  // landing; the flat roof of the tower to its edge (the outer faces of its walls): 2.75 x 4.10
  assert.ok(near(row('stair|SKIRT').by['TẦNG 2'], 9 * going2 / 1000 + 10 * riser2 / 1000 + 1.125, 0.005), JSON.stringify(row('stair|SKIRT').by));
  assert.ok(near(row('water|ROOF').by.TUM, 2.75 * 4.1, 0.005));
  // every row carries both numbers and its faces; with no opening under 0.25 m² they are the same
  for (const r of Q.rows) if (!r.head && r.faces.length) assert.ok(r.geo === r.q && r.faces.every((id) => Q.faces.some((f) => f.id === id && f.rows.includes(r.key))), r.key);
  // a partition meeting the outer walls leaves the outer faces as they are
  const part = { ...TOWN, floors: [{ ...TOWN.floors[0], walls: [...TOWN.floors[0].walls, { id: 'I', points: [[100, 5000], [4900, 5000]], thickness: 100 }] }, { ...TOWN.floors[1], walls: TOWN.floors[0].walls }, TOWN.floors[2]] };
  const rooms = [{ 'PHÒNG KHÁCH': [[200, 200], [4800, 200], [4800, 4950], [200, 4950]], 'BẾP': [[200, 5050], [4800, 5050], [4800, 9800], [200, 9800]] }, KT_ROOMS[1], KT_ROOMS[2]];
  assert.deepEqual(ktQuantities(part, rooms).Q.rows.find((r) => r.key === 'paint|OUT').by, row('paint|OUT').by);
  // a row's total is the sum of its floors as shown, so the sheet, the CSV and the workbook agree
  for (const r of Q.rows) if (!r.head && r.by) assert.ok(near(r.q, Object.values(r.by).reduce((a, x) => a + x, 0), 0.005), r.item);
});

test('finish workbook: the faces (Bảng 6.2), the bill as SUMIFS over them with both numbers, stairs, doors, checks', () => {
  const { F, Q } = ktQuantities(TOWN);
  const names = F.map((f) => f.name);
  const xml = finishWorkbook(Q, names).toString('utf8');
  for (const sheet of ['Hoàn thiện', 'Bề mặt', 'Cầu thang', 'Cửa', 'Kiểm tra']) assert.ok(xml.includes(`name="${sheet}"`), sheet);
  const n = (t) => xml.split(t).length - 1;
  // one row per face the bill counts: gross = like parts x length x height, the geometric net and the quantity by the
  // rules from the ledger of the face
  const counted = Q.faces.filter((f) => !f.none && f.rows.length);
  assert.equal(n('<f>MAX(0,J'), 2 * counted.length);
  assert.ok(n('<f>G') >= counted.filter((f) => f.L !== undefined).length, 'gross as a formula');
  // deductions and additions as their arithmetic: the window 1.2 x 1.5 off its wall, its reveals 5.4 x 0.075 on it
  assert.ok(xml.includes('<f>1.2*1.5</f>') && xml.includes('<f>5.4*0.075</f>'));
  // the bill: every quantity of a floor is a SUMIFS over the faces, by the rules (column O) and geometric (column N)
  const cells = Q.rows.filter((r) => !r.head && r.faces.length).reduce((k, r) => k + Object.keys(r.by).length, 0);
  assert.ok(n('<f>ROUND(SUMIFS(') >= 2 * cells && xml.includes("'Bề mặt'!$O$5") && xml.includes("'Bề mặt'!$N$5"), `${n('<f>ROUND(SUMIFS(')} of ${2 * cells}`);
  // the stair faces take their sizes from the parameters of the stair sheet
  assert.ok(xml.includes("<f>'Cầu thang'!$B$5-1</f>") && xml.includes("'Cầu thang'!$J$5*(("));
  // the checks: this workbook against the model row by row, then the checks of the model, the result as a formula
  assert.ok(n('KHÔNG ĐẠT') >= Q.checks.length && xml.includes("<f>'Hoàn thiện'!"));
  // no number typed where a formula can stand: the main sheet has no input cell (styles 7, 14, 16) at all
  const main = xml.slice(xml.indexOf('<sheetData>'), xml.indexOf('</sheetData>'));
  assert.ok(!/ s="(7|14|16)"/.test(main), 'an input on the main sheet');
  // quantities without their faces (an older result): a workbook of inputs, no formula over missing sheets
  const flat = finishWorkbook({ ...Q, rooms: undefined, faces: undefined }, names).toString('utf8');
  assert.ok(flat.subarray === undefined && !flat.includes('SUMIFS(') && !flat.includes('name="Bề mặt"'));
});

test('plan: a door tag beside the stair stands clear, a stair with no floor landing at its foot is reported', () => {
  const STAIRS = { type: 'u', region: [[200, 3000], [2550, 6700]], direction: 'up', turn: 'right' };
  const spec = { ...HALL, openings: [{ wall: 'I2', at: [2600, 3400], width: 800, type: 'door', tag: 'D6', toward: [3500, 3400] }], stairs: [STAIRS], interior_dimensions: true };
  const p = buildPlan(spec);
  // the wall I1 stands against the first riser: the stair is entered from its side, onto the steps
  assert.ok(p.notes.some((n) => /^stairs\[0\]: no floor landing in front of the flights/.test(n) && n.includes('1125')), p.notes.join(' | '));
  // I1 opened across both flights: the floor in front of them is the landing
  const opened = buildPlan({ ...spec, openings: [{ wall: 'I1', at: [1375, 2950], width: 2300, type: 'opening' }] });
  assert.ok(!opened.notes.some((n) => /no floor landing/.test(n)), opened.notes.join(' | '));
  // the tag: clear of the door and its swing, of the stair and of every wall
  const tag = p.entities.find((e) => e.type === 'block' && /^MCP_THE/.test(e.name) && e.attributes?.MA === 'D6');
  const door = p.entities.find((e) => e.type === 'block' && /^MCP_CUA_DI/.test(e.name));
  const wallBoxes = p.walls.flatMap((g) => g.solids.map((q) => [Math.min(...q.map((c) => c[0])), Math.min(...q.map((c) => c[1])), Math.max(...q.map((c) => c[0])), Math.max(...q.map((c) => c[1]))]));
  for (const b of [door.box, [200, 3000, 2550, 6700], ...wallBoxes]) assert.ok(!boxesHit(tag.box, b), `${tag.box} x ${b}`);
  // the interior dimension of the hall (2150 between the stairwell and the outer wall): clear of the name, the door and the tag
  const inner = p.entities.filter((e) => e.type === 'dim_chain' && e.points.length === 2 && e.at[0] === e.points[0][0] && e.at[1] === e.points[0][1]);
  assert.ok(inner.length >= 1 && inner.every((c) => c.direction !== 'horizontal' || (c.points[0][0] === 2650 && c.points[1][0] === 4800)), JSON.stringify(inner));
  const nameBox = [3750 - 9 * 0.78 * 250 / 2, 5000 - 425, 3750 + 9 * 0.78 * 250 / 2, 5000 + 425];
  for (const c of inner) {
    const [a, b] = c.points, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    // its line, and its text above (horizontal) or left of (vertical) the middle of the line
    const boxes = c.direction === 'horizontal' ? [[a[0], a[1] - 30, b[0], a[1] + 30], [mid[0] - 400, a[1], mid[0] + 400, a[1] + 300]] : [[a[0] - 30, a[1], a[0] + 30, b[1]], [a[0] - 300, mid[1] - 400, a[0], mid[1] + 400]];
    for (const bx of boxes) for (const o of [nameBox, door.box, tag.box]) assert.ok(!boxesHit(bx, o), `${c.direction} ${bx} x ${o}`);
  }
});

test('roof plan: names and level marks inside their regions, clear of the drains, the fall arrows and each other', () => {
  const fl = floorsOf(TOWN);
  const top = fl[fl.length - 1];
  for (const lang of ['vi', 'en']) {
    const r = roofPlan({ top, terrace: top.level, roof: top.level + top.height + 120, parapet: 1000, lang });
    const texts = r.entities.filter((e) => e.type === 'text');
    const labels = [...texts.map((e) => textBox(e, 0.9)), ...r.entities.filter((e) => e.name === 'MCP_COTE').map(coteBox)];
    // no text along a wall any more: the parapet height and its top level are in the notes
    assert.ok(texts.every((e) => !e.rotation) && r.notes[2].includes('+7.900'), r.notes[2]);
    const arrows = r.entities.filter((e) => /^MCP_DOC/.test(e.name ?? '')).map((e) => {
      const a = ((e.rotation ?? 0) * Math.PI) / 180, tip = [e.at[0] + Math.cos(a) * 12 * e.scale, e.at[1] + Math.sin(a) * 12 * e.scale];
      return [Math.min(e.at[0], tip[0]) - 250, Math.min(e.at[1], tip[1]) - 250, Math.max(e.at[0], tip[0]) + 250, Math.max(e.at[1], tip[1]) + 250];
    });
    const drains = r.entities.filter((e) => e.name === 'MCP_PHEU_THU').map((e) => [e.at[0] - 150, e.at[1] - 150, e.at[0] + 150, e.at[1] + 150]);
    labels.forEach((b, i) => {
      for (const o of [...arrows, ...drains, ...labels.slice(i + 1)]) assert.ok(!boxesHit(b, o), `${lang}: ${b.map(Math.round)} x ${o.map(Math.round)}`);
      // on the terrace inside the parapets (200 to 4800, 200 to 9800); the tower's inside its walls (200-2550, 3000-6700)
      assert.ok(b[0] >= 200 && b[2] <= 4800 && b[1] >= 200 && b[3] <= 9800, `${lang}: ${b.map(Math.round)} outside the terrace`);
      const inTower = b[0] < 2750 && b[2] > 0 && b[1] < 6900 && b[3] > 2800;
      if (inTower) assert.ok(b[0] >= 200 && b[2] <= 2550 && b[1] >= 3000 && b[3] <= 6700, `${lang}: ${b.map(Math.round)} across the tower walls`);
    });
  }
});

test('elevation from the side: level marks and the height chain stand outside the balcony', () => {
  // the balcony projects 1200 in front of the facade (plan y -1200 to 0): at one end of both side elevations
  for (const side of ['left', 'right']) {
    const e = buildElevation(TOWN, { side });
    const rail = e.entities.filter((x) => x.type === 'line' && Math.abs(x.from[1] - (3600 + 1100)) < 1 && Math.abs(x.to[1] - (3600 + 1100)) < 1);
    assert.ok(rail.length >= 1, 'the balcony railing is drawn');
    const lo = Math.min(...rail.flatMap((l) => [l.from[0], l.to[0]])), hi = Math.max(...rail.flatMap((l) => [l.from[0], l.to[0]]));
    const marks = e.entities.filter((x) => /^MCP_COTE/.test(x.name ?? ''));
    for (const m of marks) assert.ok(m.at[0] - 150 > hi || m.at[0] + 1200 < lo, `${side}: level mark at ${m.at[0]} in the balcony ${lo}..${hi}`);
    const chain = e.entities.find((x) => x.type === 'dim_chain' && x.direction === 'vertical');
    assert.ok(chain.at[0] < Math.min(lo, ...chain.points.map((q) => q[0])) && chain.points[0][0] <= lo, `${side}: height chain at ${chain.at[0]}`);
  }
});

test('section: the room is the space the cut stands in, its name clear of what is seen beyond', () => {
  // cut along x = 800 through the front leg, the stairwell and the back leg of the hall; its label point is beside the
  // stairwell, out of sight from both legs
  const cut = { from: [800, -1000], to: [800, 11000], look: 'right' };
  const plain = buildSection(HALL, cut);
  assert.deepEqual(plain.rooms, ['SẢNH', 'SẢNH']);
  // a ceiling at 2700 brings the name down to the door (900 x 2400) seen beyond in the front leg: it moves beside it
  const s = buildSection(HALL, { ...cut, ceilings: [{ 'SẢNH': { level: 2700 } }] });
  const names = s.entities.filter((e) => e.type === 'text' && e.text === 'SẢNH');
  assert.equal(names.length, 2);
  const lines = s.entities.filter((e) => e.type === 'line');
  assert.ok(lines.some((l) => Math.abs(l.from[1] - 2400) < 1 && Math.abs(l.to[1] - 2400) < 1 && Math.abs(Math.abs(l.from[0] - l.to[0]) - 900) < 1), 'the door seen beyond');
  for (const e of names) {
    const bx = textBox(e);
    assert.ok(!lines.some((l) => segHits(l.from, l.to, bx)), `SẢNH at ${e.at} on a line`);
    assert.ok(e.at[1] + e.height / 2 < 2700 && e.at[1] - e.height / 2 > 0, 'between the floor and the ceiling');
  }
});

test('stair detail: cells as large as what each plan takes, the figures of every storey', () => {
  const r = stairDetail({ spec: TOWN });
  // plans of floor 1, floor 2, the tower and the section: no cell runs into another
  assert.deepEqual(r.layout.map((c) => c.view), ['MẶT BẰNG THANG TẦNG 1', 'MẶT BẰNG THANG TẦNG 2', 'MẶT BẰNG THANG TUM', 'MẶT CẮT 1-1']);
  r.layout.forEach((a, i) => r.layout.slice(i + 1).forEach((b) => assert.ok(!boxesHit(a.box, b.box), `${a.view} x ${b.view}`)));
  // every grid bubble, level mark and dimension of a plan lies in its cell
  const cells = r.layout.map((c) => c.box);
  for (const e of r.main) {
    if (e.type !== 'dimension' && !(e.type === 'block' && e.box)) continue;
    const q = e.type === 'dimension' ? e.at : [(e.box[0] + e.box[2]) / 2, (e.box[1] + e.box[3]) / 2];
    assert.equal(cells.filter((c) => q[0] >= c[0] - 1 && q[0] <= c[2] + 1 && q[1] >= c[1] - 1 && q[1] <= c[3] + 1).length, 1, `${e.type} ${e.name ?? ''} at ${q}`);
  }
  // storeys of 3600 and 3300: other risers and goings, both in the notes; the tread detail says which it shows
  assert.deepEqual(r.stair.storeys.map((x) => [x.floors.join(), x.risers, x.riser, x.going]), [['TẦNG 1', 21, 171.43, 257.5], ['TẦNG 2', 19, 173.68, 286.11]]);
  const notes = r.main.find((e) => e.type === 'mtext').text;
  assert.ok(notes.includes('TẦNG 1: 21 bậc, h = 171,4, b = 257,5, 2h + b = 600') && notes.includes('TẦNG 2: 19 bậc, h = 173,7, b = 286,1, 2h + b = 633'), notes);
  assert.ok(notes.includes('Chi tiết bậc thang vẽ cho TẦNG 1'));
  // equal storeys: one line of figures as before, the plain title
  const even = stairDetail({ spec: { ...TOWN, floors: TOWN.floors.map((f, i) => (i === 1 ? { ...f, height: 3600 } : f)) } });
  assert.equal(even.stair.storeys.length, 1);
  assert.ok(even.detail.some((e) => e.type === 'text' && e.text === 'CHI TIẾT BẬC THANG'));
  assert.ok(even.main.find((e) => e.type === 'mtext').text.includes('Chiều cao bậc h = 171,4, bề rộng bậc b = 257,5: 2h + b = 600'));
});

test('door schedule: a single door by what it serves (a toilet, the outside, dry rooms)', () => {
  const spec = {
    walls: [
      { id: 'W1', points: [[100, 100], [4900, 100], [4900, 9900], [100, 9900]], closed: true, thickness: 200 },
      { id: 'P1', points: [[100, 5000], [4900, 5000]], thickness: 100 },
      { id: 'P2', points: [[2500, 5000], [2500, 9900]], thickness: 100 },
    ],
    openings: [
      { wall: 'W1', segment: 0, at: [2500, 100], width: 900, type: 'door', tag: 'D1' },
      { wall: 'P1', at: [3700, 5000], width: 800, type: 'door', tag: 'D2' },
      { wall: 'P1', at: [1300, 5000], width: 700, type: 'door', tag: 'D3' },
    ],
    rooms: [{ name: 'PHÒNG KHÁCH', at: [2500, 2500] }, { name: 'WC', at: [1300, 7500] }, { name: 'PHÒNG NGỦ', at: [3700, 7500] }],
  };
  const r = doorSchedule({ spec });
  assert.deepEqual(r.rows.map((x) => [x.tag, x.use]), [['D1', 'outside'], ['D2', 'inside'], ['D3', 'wet']]);
  const desc = Object.fromEntries(r.entities.find((e) => e.type === 'table').rows.slice(1).map((row) => [row[0], row[6]]));
  assert.ok(/gỗ công nghiệp/.test(desc.D2) && !/gỗ/.test(desc.D1) && !/gỗ/.test(desc.D3) && /vệ sinh/.test(desc.D3), JSON.stringify(desc));
  // a description given for a tag wins; rooms not named: the use is unknown, the default stays
  assert.equal(doorSchedule({ spec, materials: { D3: 'Cửa nhựa lõi thép' } }).entities.find((e) => e.type === 'table').rows[3][6], 'Cửa nhựa lõi thép');
  const blind = doorSchedule({ spec: { ...spec, rooms: [] } });
  assert.ok(blind.rows.every((x) => x.use === undefined) && /gỗ công nghiệp/.test(blind.entities.find((e) => e.type === 'table').rows[3][6]));
});

// ---- structural set after the audit: true loads for shear and column loads, point loads, beam on beam, balconies,
// designed columns, footings, slabs and stairs, the beam schedule pitch, the live workbook
import { buckling } from '../src/calc.mjs';

test('continuous beam with point loads and hinged ends: statics by hand', () => {
  // one span, hinged ends, P = 10 at 1 m of 4: reactions 7.5 / 2.5, M = 7.5 under the load
  const a = analyseBeam([4], [0], [0], [{ i: 0, a: 1, P: 10 }], [0, 0]);
  assert.ok(near(a.reactions[0], 7.5, 1e-9) && near(a.reactions[1], 2.5, 1e-9) && near(a.span[0].M, 7.5, 1e-9) && near(a.span[0].V, 7.5, 1e-9), JSON.stringify(a));
  // two spans of 4 m, P = 32 at the middle of the first: -3PL/32 = -12 over the middle support, reactions in balance
  assert.ok(near(supportMoments([4, 4], [0, 0], 0, 0, [[{ a: 2, P: 32 }], []])[1], -12, 1e-9));
  const b = analyseBeam([4, 4], [5, 5], [0, 0], [{ i: 0, a: 2, P: 32 }], [0, 0]);
  assert.ok(near(b.sup[1], -12 - 5 * 16 / 8, 1e-9) && near(b.reactions.reduce((s, x) => s + x, 0), 32 + 40, 1e-9), JSON.stringify(b));
  // buckling factor by l0/h (TCVN 5574:2018): 0.92 at 6, 0.90 at 10, 0.83 at 15, 0.70 at 20
  assert.ok(near(buckling(4), 0.92) && near(buckling(12.5), 0.865, 1e-9) && near(buckling(20), 0.7, 1e-9) && buckling(25) < 0.7);
});

test('structural calculation: bending from equivalent loads, shear and column loads from the loads really carried', () => {
  const R = structuralCalc({ spec: TOWN });
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  // everything the beams carry and the columns weigh arrives at the footings (the tower columns stand on beams: point loads)
  const beams = sum(R.slabs.flatMap((S) => S.members.flatMap((m) => m.true.map((ld, i) => (ld.g + ld.p) * m.span[i]))));
  const cols = sum(R.columns.map((c) => (c.size[0] / 1000) * (c.size[1] / 1000) * 25 * 1.1 * c.H));
  const lost = sum(R.columns.filter((c) => c.on && !R.slabs.some((S) => S.members.some((m) => (m.points.length || m.extra.some((x) => x > 0))))).map((c) => c.N));
  const footings = sum(R.columns.filter((c) => !c.on).map((c) => c.N));
  // the two tower columns at x = 2650 stand on no beam (the calculation warns): their load is not in the footings
  const off = sum(R.columns.filter((c) => c.on && Math.abs(c.at[0] - 2650) < 1).map((c) => c.N));
  assert.ok(R.warnings.filter((w) => /neither a column nor a beam/.test(w)).length === 2 && lost === 0);
  assert.ok(near(beams + cols - off, footings, 0.5), `${beams} + ${cols} - ${off} vs ${footings}`);
  // the panel 4.8 x 9.8 spans one way (l2/l1 > 2): its long beams take half of it each, in both sets of loads
  const S = R.slabs[1], long = S.members.find((m) => Math.abs(m.d[1]) > 0.9);
  assert.ok(near(long.load[0].p, long.true[0].p, 1e-9) && long.true[0].p > 1.5 * 1.3 * 2.4 && long.true[0].p < 3 * 1.2 * 2.4, 'rooms 1.5 kPa with the stairwell (3 kPa) in the panel');
  // the true loads share out the whole panel on its beams
  const cell = S.loads.cells[0], A = ((cell.x1 - cell.x0) * (cell.y1 - cell.y0)) / 1e6;
  const self = sum(S.members.map((m) => (m.b / 1000) * ((m.h - 120) / 1000) * 25 * 1.1 * m.span[0] + 2 * ((m.h - 120) / 1000) * 0.015 * 18 * 1.3 * m.span[0]));
  const walls = sum(S.loads.wallLoads.map((w) => w.q * S.members.find((m) => m.name === w.member).span[0]));
  const bal = S.loads.balconies[0];
  const slabLoad = sum(S.members.map((m) => (m.true[0].g + m.true[0].p) * m.span[0])) - self - (bal.gLine + bal.pLine) * 4.8;
  assert.ok(Math.abs(slabLoad - walls - (cell.g + cell.p) * A) < 0.02 * slabLoad, `${slabLoad} - ${walls} vs ${(cell.g + cell.p) * A}`);
  // the balcony of floor 2: a cantilever of 1.3 m to the axis of the front beam, its load on that beam, top bars designed
  assert.ok(near(bal.d, 1.3) && bal.host === S.members.find((m) => Math.abs(m.A[1] - 100) < 1 && Math.abs(m.B[1] - 100) < 1).name);
  assert.ok(near(bal.pLine, 4 * 0.8 * 1.2 * 5 / 4.8, 1e-6), 'the strip load 4 kPa x 0.8 m governs, the whole 5 m of balcony on the 4.8 m beam');
  assert.ok(S.balconyDesign[0].top.d >= 10 && R.warnings.some((w) => /balcony of TẦNG 2: cantilever 1.3 m/.test(w)));
  // slabs and stairs designed: the one-way panel spans 4.8 m between the long beams (q L² / 8), distribution bars the
  // other way; the stair as a simply supported strip
  assert.ok(near(S.design.M.x, (cell.g + cell.p) * 4.8 ** 2 / 8, 1e-6) && S.design.M.y === 0 && S.design.x.A > S.design.y.A && S.design.y.d === 8, JSON.stringify(S.design));
  assert.ok(R.stairs.length === 2 && R.stairs[0].main.d >= 10 && near(R.stairs[0].q, 6 * 1.15 + 3 * 1.2, 0.01) && near(R.stairs[0].M, R.stairs[0].q * R.stairs[0].L ** 2 / 8, 0.2));
  const tables = calcSheet(R).entities.filter((e) => e.type === 'table');
  assert.ok(tables.some((t) => t.title.startsWith('SÀN, CẦU THANG, BAN CÔNG')) && tables.some((t) => t.title.startsWith('CỘT VÀ MÓNG ĐƠN')), tables.map((t) => t.title).join(' | '));
});

test('structural calculation: columns and pad footings sized for their loads, strip footings advised when pads crowd the plan', () => {
  const R = structuralCalc({ spec: TOWN });
  const footed = R.columns.filter((c) => !c.on);
  // every column and footing passes with the sizes the calculation chose; the pads cover the area needed
  assert.ok(footed.every((c) => c.colOk && c.footOk && c.A >= c.Areq && c.foot.B % 100 === 0 && c.foot.B >= 1200), JSON.stringify(footed.map((c) => [c.N, c.cap, c.Areq, c.A])));
  assert.ok(footed.every((c) => near(c.Areq, c.N / 1.15 / (100 - 20 * 1.5), 0.01) && near(c.phi, buckling(0.7 * 4050 / 220), 1e-3)));
  assert.equal(R.footings.reduce((s, f) => s + f.count, 0), 4);
  // 100 kPa under a 9.8 m span: the pads take over half the plan -> strip footings or a raft, said in the warnings and on the sheet
  assert.ok(R.foundation.strip && R.foundation.ratio > 0.5 && R.warnings.some((w) => /strip footings or a raft/.test(w)));
  assert.ok(calcSheet(R).entities.some((e) => e.type === 'mtext' && /móng băng hoặc móng bè/.test(e.text)) && calcCsv(R).includes('móng băng hoặc móng bè'));
  assert.ok(R.foundation.edge === 4 && R.warnings.some((w) => /eccentric/.test(w)), 'pads on the outline are eccentric on a boundary');
  // better ground: smaller pads, no such advice
  const R3 = structuralCalc({ spec: TOWN, soil: 300 });
  assert.ok(!R3.foundation.strip && R3.footings[0].B < R.footings[0].B && !R3.warnings.some((w) => /strip footings/.test(w)));
  // a column too small for its load goes up to the size that passes, and the result says so
  const Rs = structuralCalc({ spec: TOWN, column: { size: [150, 150] } });
  const up = Rs.columns.filter((c) => c.first);
  assert.ok(up.length >= 4 && up.every((c) => c.colOk && c.size[0] * c.size[1] > 150 * 150 && c.N <= c.cap) && Rs.warnings.some((w) => /designed \d+x\d+ with/.test(w)), JSON.stringify(Rs.columns.map((c) => [c.name, c.size, c.N, c.cap])));
  // the plans take the designed sizes: columns and pads by mark
  const F = floorsOf(TOWN);
  const fd = framingPlan({ spec: F[0].spec, level: -450, name: 'MÓNG', prefix: 'GM.', beam: { h: 400 }, column: { sizes: Rs.design.columns }, foundation: { depth: 1500, sizes: Rs.design.footings } });
  assert.deepEqual(fd.footings.map((f) => [f.name, f.size, f.count]), Rs.footings.map((f) => [f.mark, `${f.B}x${f.L}`, f.count]));
  assert.deepEqual(fd.columns.map((c) => c.size).sort(), [...new Set(footed.map((c) => Rs.columns.find((x) => x.name === c.name).size.join('x')))].sort());
  assert.ok(fd.entities.some((e) => e.type === 'text' && /^\d\. CỘT: C\d \(/.test(e.text)) && fd.notes.some((n) => /MÓNG BIÊN/.test(n)));
  assert.ok(fd.beams.every((b) => b.slab === 0), 'ground beams carry no slab');
});

test('beam on beam: the reaction of a beam that ends on another beam is a point load on it, nothing is lost', () => {
  // a load-bearing wall across the house at mid length, and one from it to the front wall: its beam ends on two beams
  const spec = JSON.parse(JSON.stringify(TOWN));
  for (const k of [0, 1]) {
    spec.floors[k].walls = [...(spec.floors[k].walls ?? TOWN.floors[0].walls), { id: 'X0', points: [[100, 5000], [4900, 5000]], thickness: 200 }, { id: 'X1', points: [[2500, 100], [2500, 5000]], thickness: 200 }];
  }
  spec.floors[1].stairs = [];
  spec.floors[0].stairs = [];
  spec.floors.length = 2;
  const R = structuralCalc({ spec });
  const sum = (xs) => xs.reduce((s, x) => s + x, 0);
  const S = R.slabs[1];
  const carried = S.members.find((m) => Math.abs(m.A[0] - 2500) < 1 && Math.abs(m.B[0] - 2500) < 1);
  // it rests at both ends (no column there), and the beams it meets keep their single span with a point load at 2.4 m
  assert.equal(carried.rests.length, 2);
  assert.deepEqual(carried.supports.map(Math.round), [0, 4900]);
  const front = S.members.find((m) => Math.abs(m.A[1] - 100) < 1 && Math.abs(m.B[1] - 100) < 1);
  assert.deepEqual(front.supports.map(Math.round), [0, 4800]);
  assert.ok(front.points.length === 1 && near(front.points[0].a, 2.4, 1e-6) && near(front.points[0].P, carried.reactions[0], 1e-9), JSON.stringify(front.points));
  // the cross beam at y = 5000 rests on the two long beams in the same way: four ends carried in all
  assert.ok(S.carried.length === 4 && S.carried.every((c) => c.on) && R.warnings.some((w) => /rests on beam .*point load/.test(w)), JSON.stringify(S.carried));
  // the square panel behind it spans two ways: its beams bend under the equivalent load, heavier than the load they carry
  const back = S.members.find((m) => Math.abs(m.A[1] - 9900) < 1 && Math.abs(m.B[1] - 9900) < 1);
  assert.ok(back.load[0].p > back.true[0].p * 1.15 && near(back.true[0].p, 1.5 * 1.3 * 4.8 / 4, 0.05), JSON.stringify([back.load, back.true]));
  assert.ok(!S.fp.columnPoints.some((p) => Math.abs(p[0] - 2500) < 5), 'no column appears under the ends');
  // the building in balance: beam loads + column weights = footing loads
  const beams = sum(R.slabs.flatMap((s) => s.members.flatMap((m) => m.true.map((ld, i) => (ld.g + ld.p) * m.span[i]))));
  const cols = sum(R.columns.map((c) => (c.size[0] / 1000) * (c.size[1] / 1000) * 25 * 1.1 * c.H));
  assert.ok(near(beams + cols, sum(R.columns.map((c) => c.N)), 0.5), `${beams + cols} vs ${sum(R.columns.map((c) => c.N))}`);
  // a wall that stops in the room: its beam ends on nothing, and the calculation says how much is not carried
  const free = JSON.parse(JSON.stringify(spec));
  for (const k of [0, 1]) free.floors[k].walls = free.floors[k].walls.filter((w) => w.id !== 'X0');
  const Rf = structuralCalc({ spec: free });
  assert.ok(Rf.warnings.some((w) => /ends on nothing at .* kN is not carried down/.test(w)));
});

test('beam schedule: the pitch follows the real width of the sections, ground beams have no slab flange', () => {
  const sc = 25;
  const beams = [
    { name: 'D2.1', b: 200, h: 500, count: 2, level: 3600, slab: 120, bars: { support: [{ face: 'bottom', d: 20, n: 2 }, { face: 'top', d: 22, n: 2 }], span: [{ face: 'bottom', d: 20, n: 2 }, { face: 'top', d: 12, n: 2 }] }, stirrup: { d: 6, support: 100, span: 200 } },
    { name: 'D2.2', b: 300, h: 700, count: 6, level: 10200, slab: 120, bars: { support: [{ face: 'bottom', d: 25, n: 3, mark: '1' }, { face: 'top', d: 25, n: 4, mark: '2+3' }], span: [{ face: 'bottom', d: 25, n: 4, mark: '1' }, { face: 'top', d: 14, n: 2, mark: '4' }] }, stirrup: { d: 8, support: 100, span: 200, mark: '5' } },
    { name: 'GM.1', b: 200, h: 400, count: 2, level: -450, slab: 0 },
  ];
  const bs = beamSchedule({ beams, scale: sc });
  noNaN(bs.entities);
  // what a section takes: the level mark and its text on the left, the callouts (leader, text, bar marks) on the right
  const tags = bs.entities.filter((e) => e.name === 'MCP_COTE_TRAI').map((e) => ({ x: e.at[0], left: e.at[0] - (2.1 + [...e.attributes.COTE].length * 0.72 * 2.5) * sc, y: e.at[1] }));
  assert.equal(tags.length, 6);
  const rects = bs.entities.filter((e) => e.type === 'rectangle').sort((a, b) => a.from[0] - b.from[0]);
  assert.equal(rects.length, 6);
  const marks = bs.entities.filter((e) => e.name === 'MCP_SO_HIEU').map((e) => e.at[0] + 2.5 * sc);
  const ends = [...bs.entities.filter((e) => e.type === 'polyline' && e.layer === 'S-ANNO-TEXT' && e.points.length === 3).map((e) => e.points[2][0]), ...marks];
  for (let i = 0; i < 6; i++) {
    const x0 = rects[i].from[0], next = rects[i + 1]?.from[0] ?? Infinity;
    const right = Math.max(...ends.filter((x) => x > x0 && x < next));
    const tagNext = tags.map((t) => t.left).filter((x) => x > x0).sort((a, b) => a - b)[0] ?? Infinity;
    assert.ok(right + 2 * sc <= tagNext, `section ${i}: callouts end at ${right}, the next level mark starts at ${tagNext}`);
  }
  assert.ok(near(rects[1].from[0] - rects[0].from[0], bs.pitch.section) && near(rects[2].from[0] - rects[0].from[0], bs.pitch.beam));
  // longer callouts and bar marks widen the pitch (it was 72 and 110 mm whatever the content)
  const plain = beamSchedule({ beams: [beams[0]], scale: sc });
  assert.ok(bs.pitch.section > plain.pitch.section && bs.pitch.beam > plain.pitch.beam && plain.pitch.section >= 50 * sc);
  // the slab flange on both sides of the floor beams (six lines a section), none on the ground beams
  const conc = (i) => bs.entities.filter((e) => e.type === 'line' && e.layer === 'S-CONC' && e.from[0] > rects[i].from[0] - 10 * sc && e.to[0] < rects[i].to[0] + 10 * sc).length;
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(conc), [6, 6, 6, 6, 0, 0]);
  // the level mark of a ground beam stands on the beam itself
  assert.ok(tags.filter((t) => t.x > rects[4].from[0]).every((t) => t.x <= rects[5].to[0] && bs.entities.some((e) => e.name === 'MCP_COTE_TRAI' && e.attributes.COTE === 'FL-0.450')));
});

test('framing plan: balcony slab, labels clear of lines, dimension chains clear of the grid bubbles', () => {
  const F = floorsOf(TOWN);
  const rooms = { 'PHÒNG NGỦ': [[200, 200], [4800, 200], [4800, 2900], [2650, 2900], [2650, 6800], [4800, 6800], [4800, 9800], [200, 9800], [200, 6800], [200, 2900]], 'CẦU THANG': [[200, 3000], [2550, 3000], [2550, 6700], [200, 6700]] };
  const r = framingPlan({ spec: F[0].spec, level: F[1].level, slab: 120, name: F[1].name, prefix: 'D2.', scale: 100, rooms, balconies: F[1].spec.balconies });
  noNaN(r.entities);
  // the cantilever balcony: outlined, hatched as a lowered slab, named
  assert.ok(r.entities.some((e) => e.type === 'polyline' && e.closed && e.layer === 'S-CONC' && e.points.some((p) => p[1] === -1200)));
  assert.ok(r.entities.some((e) => e.type === 'text' && /^BC - BAN CÔNG/.test(e.text)) && r.assumed.some((a) => a.item === 'lowered_slab'));
  // the stair opening's name between its diagonals, not on their crossing
  const st = r.entities.find((e) => e.text === 'Ô THANG');
  assert.ok(st && Math.abs(st.at[1] - (3000 + 6700) / 2) > 0.25 * 3700, JSON.stringify(st.at));
  // no label across a line: every text box against every line drawn (beam faces, columns, diagonals, balcony, grids)
  const lines = [];
  for (const e of r.entities) {
    if (e.type === 'line') lines.push([e.from, e.to]);
    else if (e.type === 'polyline') e.points.forEach((q, i) => { if (i + 1 < e.points.length || e.closed) lines.push([q, e.points[(i + 1) % e.points.length]]); });
  }
  const cut = ([p, q], [x0, y0, x1, y1]) => {
    let t0 = 0, t1 = 1;
    for (const [u, v] of [[p[0] - q[0], p[0] - x0], [q[0] - p[0], x1 - p[0]], [p[1] - q[1], p[1] - y0], [q[1] - p[1], y1 - p[1]]]) {
      if (Math.abs(u) < 1e-12) { if (v < 0) return false; continue; }
      const k = v / u;
      if (u < 0) { if (k > t1) return false; t0 = Math.max(t0, k); } else { if (k < t0) return false; t1 = Math.min(t1, k); }
    }
    return t1 - t0 > 1e-9;
  };
  const labels = r.entities.filter((e) => e.type === 'text' && e.layer === 'S-ANNO-TEXT' && !/^(MẶT BẰNG|TỶ LỆ|CỘT:)/.test(e.text));
  for (const e of labels) {
    const w = [...e.text].length * 0.7 * e.height, h = e.height, up = Math.abs(Math.abs(e.rotation ?? 0) - 90) < 1;
    const mid = /middle/.test(e.align ?? '');
    const x0 = up ? e.at[0] - h / 2 : /left/.test(e.align ?? 'left') ? e.at[0] : /right/.test(e.align) ? e.at[0] - w : e.at[0] - w / 2;
    const y0 = up ? e.at[1] - w / 2 : mid ? e.at[1] - h / 2 : e.at[1];
    const box = [x0 + 25, y0 + 25, x0 + (up ? h : w) - 25, y0 + (up ? w : h) - 25];
    assert.ok(!lines.some((l) => cut(l, box)), `"${e.text}" at ${e.at} lies across a line`);
  }
  // the chain 8 mm off the plan, the overall dimension 8 mm further with its text (3.1 mm) beyond it, the bubbles from 20 mm
  const chain = r.entities.find((e) => e.type === 'dim_chain' && e.direction === 'vertical');
  const bubbleX = Math.max(...r.entities.filter((e) => e.name === 'MCP_TRUC' && e.at[0] < 0).map((e) => e.at[0] + 450));
  assert.ok(chain.total !== undefined && chain.at[0] - 800 - 310 > bubbleX, `overall dimension at ${chain.at[0] - 800}, bubbles up to ${bubbleX}`);
  // a plan with one grid each way still gets its overall sizes (the tower roof)
  const roof = framingPlan({ spec: F[2].spec, level: 9820, name: 'MÁI', prefix: 'DM.', scale: 100 });
  assert.equal(roof.entities.filter((e) => e.type === 'dim_chain').length, 2);
  // the column marks as the calculation gives them, the sizes in the legend under the title
  assert.ok(r.entities.some((e) => e.type === 'text' && e.text === 'C1') && r.entities.some((e) => e.type === 'text' && e.text === 'CỘT: C1 (220x220)'));
});

test('bar schedule and bill after the calculation: designed sizes and bars, balconies, steel grades as the notes', () => {
  const R = structuralCalc({ spec: TOWN, soil: 300 });
  const B = boqSheets(R);
  const Q = B.quantities, q = (re) => Q.rows.find((r) => !r.head && re.test(r.item));
  // footings by type, columns by the marks of the plans
  for (const ft of R.footings) assert.ok(B.groups.some((g) => g.title === `MÓNG ${ft.mark} (${ft.B}x${ft.L})`));
  assert.ok(B.groups.some((g) => g.title === 'CỘT C1 (220x220)') && B.groups.find((g) => g.title === 'CỘT C1 (220x220)').rows.some((r) => /Ø6a150/.test(r.shape)));
  // the slab bars are the designed ones; the balcony's top bars run as far into the slab as they cantilever
  const slab = B.groups.find((g) => g.title === 'SÀN TẦNG 2'), D = R.slabs[1].design;
  assert.ok(slab.rows[0].shape.endsWith(`Ø${D.x.d}a${D.x.s}`) && slab.rows[1].shape.endsWith(`Ø${D.y.d}a${D.y.s}`), slab.rows.map((r) => r.shape).join(' | '));
  const top = slab.rows.find((r) => /^BC/.test(r.mark));
  assert.ok(top && top.length >= 2 * 1300 && near(q(/^Bê tông ban công TẦNG 2/).q, 5 * 1.2 * 0.12, 1e-6) && q(/^Ván khuôn ban công TẦNG 2/).q > 6);
  // the stairs with the designed bars; their formwork counted
  assert.ok(B.groups.find((g) => g.title === 'CẦU THANG').rows[0].shape.endsWith(`Ø${R.stairs[0].main.d}a${R.stairs[0].main.s}`) && q(/^Ván khuôn cầu thang/).q > 0);
  // Ø10 is ribbed steel (CB300-V), as in the general notes and the calculation
  const d10 = Q.steel.byD[10] ?? 0;
  assert.ok(d10 > 0 && near(Q.steel.small, Object.entries(Q.steel.byD).filter(([d]) => Number(d) < 10).reduce((s, [, kg]) => s + kg, 0), 0.05));
  assert.ok(q(/Ø < 10$/) && q(/Ø ≥ 10$/) && near(q(/Ø ≥ 10$/).q, Q.steel.large / 1000, 1e-3));
  // the tower's low wall along its own full-height wall is one wall: 200 mm walls of the tower floor
  const sn = structureNotes({});
  assert.equal(sn.entities.find((e) => e.type === 'table' && e.title.startsWith('LỚP BÊ TÔNG')).rows[1][1], 50, 'footing cover 50 as the detail and the bill');
  assert.ok(footingDetail({ B: 1200, H: 400, depth: 1500 }).entities.some((e) => e.type === 'text' && e.text === 'Ø6a150'), 'column ties as the bar schedule');
  // the live workbook opens as a zip and carries the q of a beam as a formula of the Loads sheet
  const kc = kcWorkbook(R, B);
  assert.ok(kc.subarray(0, 2).toString() === 'PK' && kc.length > 5000);
});

import { minWidth, stairSpots } from '../src/interior.mjs';

// the back of a floor: a WC (door D3 swinging in) and a store behind one wall, and a stairwell with a U stair
const NT_R4 = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const NT_STAIR = { type: 'u', region: [[200, 7650], [2550, 11350]], direction: 'up', turn: 'right', gap: 100 };
const NT_BACK = {
  walls: [{ id: 'W', points: [[100, 15700], [4900, 15700], [4900, 17900], [100, 17900]], closed: true, thickness: 200 },
    { id: 'I6', points: [[2500, 15700], [2500, 17900]], thickness: 100 }],
  openings: [{ wall: 'W', segment: 0, at: [1300, 15700], width: 700, type: 'door', toward: [1300, 16800], tag: 'D3' },
    { wall: 'W', segment: 0, at: [3700, 15700], width: 800, type: 'door', toward: [3700, 16800], tag: 'D4' }],
  rooms: [{ name: 'WC', at: [1300, 16800] }, { name: 'KHO', at: [3700, 16800] }],
};
const NT_BACK_ROOMS = { WC: NT_R4(200, 15800, 2450, 17800), KHO: NT_R4(2550, 15800, 4800, 17800) };
const NT_HALL = [[200, 6050], [4800, 6050], [4800, 11350], [2650, 11350], [2650, 7550], [200, 7550]];
const ntHit = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

test('material schedule: the arrival floor of a stair counts its landing only, a narrow room is finished to its flat ceiling', () => {
  const walls = [{ id: 'T', points: [[100, 6000], [2600, 6000], [2600, 11400], [100, 11400]], closed: true, thickness: 200 }];
  const rooms = { 'CẦU THANG': NT_R4(200, 6100, 2500, 11300) };
  const finishes = { 'CẦU THANG': resolveFinish('CẦU THANG') };
  const q = (ms, code) => ms.rows.find((r) => r.code === code)?.qty;
  // the tower: the stair arrives from below, the floor is the landing 2300 x 1550, the skirting runs along it
  const top = materialSchedule({ spec: { walls, heights: { top: 2800 }, stairs_below: [NT_STAIR] }, rooms, finishes });
  assert.ok(Math.abs(q(top, 'FL-04') - 3.57) < 0.011, `landing ${q(top, 'FL-04')}`);
  assert.ok(Math.abs(q(top, 'SK-02') - 5.4) < 0.011, `skirting ${q(top, 'SK-02')}`);
  assert.ok(!top.rows.find((r) => r.code === 'FL-04').field, 'the landing is not the area of the whole room outline');
  // the same room on a floor where the stair starts: the landing in front of the flights as a floor (3.57 m², 5.4 m of
  // skirting) and the stair on its real surfaces, not on the plan of the stairwell: 19 risers of 173.7 and 17 goings
  // of 286.1 on flights 1125 wide, a half landing 1125 x 2350: treads and landing 8.12 m², risers 3.71 m², skirting
  // stepped along the flights and around the landing 12.76 m
  const start = materialSchedule({ spec: { walls, heights: { top: 3300 }, stairs: [NT_STAIR] }, rooms, finishes });
  assert.ok(Math.abs(q(start, 'FL-04') - (3.57 + 8.12 + 3.71)) < 0.02 && Math.abs(q(start, 'SK-02') - (5.4 + 12.76)) < 0.02, `${q(start, 'FL-04')} ${q(start, 'SK-02')}`);
  // a store 2250 wide: too narrow for the drop band, flat at +3.000, painted up to it (8.4 m of walls)
  const kho = materialSchedule({ spec: null, rooms: { KHO: NT_R4(0, 0, 2250, 1950) }, finishes: { KHO: resolveFinish('KHO') } });
  assert.ok(Math.abs(q(kho, 'WL-01') - 25.2) < 0.011, `paint ${q(kho, 'WL-01')}`);
  // a room wide enough keeps the band: painted to +2.850
  const big = materialSchedule({ spec: null, rooms: { 'PHÒNG NGỦ': NT_R4(0, 0, 4000, 3000) }, finishes: { 'PHÒNG NGỦ': resolveFinish('PHÒNG NGỦ') } });
  assert.ok(Math.abs(q(big, 'WL-01') - 14 * 2.85) < 0.011, `paint ${q(big, 'WL-01')}`);
});

test('ceiling plan: a hall with an arm too narrow for the drop band stays flat; the stairwell name on its half landing', () => {
  assert.equal(Math.round(minWidth(NT_HALL)), 1500);
  const hall = ceilingPlan({ rooms: { 'SẢNH': NT_HALL }, finishes: { 'SẢNH': resolveFinish('SẢNH', {}, [], 3300) }, scale: 50, mode: 'lighting' });
  assert.ok(hall.warnings.some((w) => /only 1500 wide/.test(w)), JSON.stringify(hall.warnings));
  assert.ok(!hall.lights.some((l) => l.kind === 'strip' || l.kind === 'ceiling_lamp') && hall.lights.find((l) => l.kind === 'downlight').qty === 10, JSON.stringify(hall.lights));
  // an L-shaped living room whose arm is 2150 wide keeps its band (the field there is 950 wide)
  const living = [[200, 200], [4800, 200], [4800, 11350], [2650, 11350], [2650, 7550], [200, 7550]];
  const lv = ceilingPlan({ rooms: { 'PHÒNG KHÁCH': living }, finishes: { 'PHÒNG KHÁCH': resolveFinish('PHÒNG KHÁCH', {}, [], 3600) }, scale: 50, mode: 'lighting' });
  assert.ok(lv.lights.some((l) => l.kind === 'strip') && !lv.warnings.length, JSON.stringify(lv.warnings));
  // the stairwell: its two lines on the far half of the half landing (y 10787.5 .. 11350) when the plan is given
  const rooms = { 'CẦU THANG': NT_R4(200, 7650, 2550, 11350) }, finishes = { 'CẦU THANG': resolveFinish('CẦU THANG') };
  const spot = stairSpots({ stairs: [NT_STAIR] })[0];
  assert.deepEqual(spot.far.map(Math.round), [200, 10788, 2550, 11350]);
  const withPlan = ceilingPlan({ rooms, finishes, scale: 50, mode: 'finish', spec: { stairs: [NT_STAIR] } });
  for (const t of withPlan.entities.filter((e) => e.type === 'text')) assert.ok(t.at[1] > spot.far[1] + 50 && t.at[1] < spot.far[3] - 50, `${t.text} at ${t.at}`);
  const bare = ceilingPlan({ rooms, finishes, scale: 50, mode: 'finish' });
  assert.ok(Math.abs(bare.entities.find((e) => e.text === 'CẦU THANG').at[1] - 9500) < 1, 'no plan: the middle of the room');
});

test('floor and wall finish plans: tags and notes clear of the door swings and inside the room, the stairwell tags on its landing', () => {
  const finishes = { WC: resolveFinish('WC', {}, [], 3300), KHO: resolveFinish('KHO', {}, [], 3300) };
  const labels = { WC: [1300, 16800], KHO: [3700, 16800] };
  const doors = buildPlan({ ...NT_BACK, scale: 50 }).entities.filter((e) => e.type === 'block' && e.box && e.layer === ROLE.door).map((e) => e.box);
  assert.equal(doors.length, 2);
  const inRoom = (b, poly) => b[0] >= poly[0][0] && b[2] <= poly[2][0] && b[1] >= poly[0][1] && b[3] <= poly[2][1];
  const textBox = (e) => [e.at[0] - e.text.length * 0.35 * e.height, e.at[1] - e.height / 2, e.at[0] + e.text.length * 0.35 * e.height, e.at[1] + e.height / 2];
  // floor: the WC tag FL-02 and its note are off the door swing, inside the room, and the joints stop at them
  const fl = floorFinishPlan({ rooms: NT_BACK_ROOMS, finishes, labels, scale: 50, spec: NT_BACK });
  const fTag = fl.entities.find((e) => e.type === 'block' && e.attributes?.MA === 'FL-02');
  const fNote = fl.entities.find((e) => e.type === 'text' && e.text.includes('HẠ 20'));
  for (const b of [fTag.box, textBox(fNote)]) {
    assert.ok(!doors.some((d) => ntHit(d, b)), `on a door swing: ${b}`);
    assert.ok(inRoom(b, NT_BACK_ROOMS.WC), `outside the WC: ${b}`);
  }
  const drain = fl.entities.find((e) => e.name === 'MCP_PHEU_THU' && e.at[0] < 2450);
  assert.ok(!ntHit(fTag.box, [drain.at[0] - 75, drain.at[1] - 75, drain.at[0] + 75, drain.at[1] + 75]), 'the tag is off the floor drain');
  // wall: the WC tag WL-02 with ỐP ĐẾN TRẦN wholly inside the room, off the bands along the walls and the swing
  const wl = wallFinishPlan({ spec: NT_BACK, rooms: NT_BACK_ROOMS, finishes, labels, scale: 50 });
  const wTag = wl.entities.find((e) => e.type === 'block' && e.attributes?.MA === 'WL-02');
  const wNote = wl.entities.find((e) => e.type === 'text' && e.text.startsWith('ỐP'));
  const inner = [[330, 15930], [0, 0], [2320, 17670]];
  for (const b of [wTag.box, textBox(wNote)]) {
    assert.ok(!doors.some((d) => ntHit(d, b)), `on a door swing: ${b}`);
    assert.ok(inRoom(b, inner), `on the wall bands of the WC: ${b}`);
  }
  // the stairwell: its floor and wall tags on the near half of the half landing (y 10225 .. 10787.5), off the treads
  const spec = { walls: [{ id: 'S', points: [[100, 7600], [2600, 7600], [2600, 11400], [100, 11400]], closed: true, thickness: 100 }], stairs: [NT_STAIR], rooms: [{ name: 'CẦU THANG', at: [1375, 9500] }] };
  const rooms = { 'CẦU THANG': NT_R4(200, 7650, 2550, 11350) }, fin = { 'CẦU THANG': resolveFinish('CẦU THANG') };
  const f2 = floorFinishPlan({ rooms, finishes: fin, labels: { 'CẦU THANG': [1375, 9500] }, scale: 50, spec });
  const w2 = wallFinishPlan({ spec, rooms, finishes: fin, labels: { 'CẦU THANG': [1375, 9500] }, scale: 50 });
  for (const [e, code] of [[f2.entities.find((x) => x.attributes?.MA === 'FL-04'), 'FL-04'], [w2.entities.find((x) => x.attributes?.MA === 'WL-01'), 'WL-01']]) {
    assert.ok(e && e.box[1] > 10225 && e.box[3] < 10788, `${code} at ${e?.at}`);
  }
});

test('review fixes: a door onto an unnamed corridor is an inside door, the open air is outside', async () => {
  const { isOutside, buildModel } = await import('../src/elevation.mjs');
  // two rooms and a corridor with no name between them; a door from each room to the corridor, one door to the open air
  const spec = {
    walls: [
      { id: 'W', points: [[100, 100], [6100, 100], [6100, 8100], [100, 8100]], closed: true, thickness: 200 },
      { id: 'A', points: [[100, 3000], [6100, 3000]], thickness: 100 }, { id: 'B', points: [[100, 5000], [6100, 5000]], thickness: 100 },
    ],
    openings: [
      { wall: 'A', at: [3000, 3000], width: 800, type: 'door', tag: 'D1' }, { wall: 'B', at: [3000, 5000], width: 800, type: 'door', tag: 'D1' },
      { wall: 'W', segment: 0, at: [3000, 100], width: 900, type: 'door', tag: 'D2' },
    ],
    rooms: [{ name: 'PHÒNG 1', at: [3000, 1500] }, { name: 'PHÒNG 2', at: [3000, 6500] }],
  };
  const r = doorSchedule({ spec });
  assert.equal(r.rows.find((x) => x.tag === 'D1').use, 'inside', JSON.stringify(r.rows));
  assert.equal(r.rows.find((x) => x.tag === 'D2').use, 'outside');
  const M = buildModel(spec);
  assert.equal(isOutside(M, [3000, 4000]), false);
  assert.equal(isOutside(M, [3000, -1000]), true);
  // English: the kinds and the materials of the schedule
  const en = doorSchedule({ spec, lang: 'en' }).entities.find((e) => e.type === 'table').rows;
  assert.ok(en.slice(1).every((row) => !/[ửăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừữựỳỵỷỹ]/i.test(row.join(' '))), JSON.stringify(en.slice(1, 3)));
});

test('review fixes: structural notes in English, view titles follow the language of the call', async () => {
  const { setDrawingLanguage, viewTitle } = await import('../src/standards.mjs');
  const notes = structureNotes({ lang: 'en' });
  const texts = notes.entities.flatMap((e) => (e.type === 'table' ? e.rows.flat().map(String) : e.type === 'text' || e.type === 'mtext' ? [String(e.text)] : []));
  assert.ok(!texts.some((t) => /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừữựỳỵỷỹ]/i.test(t)), texts.filter((t) => /[ăâđêôơư]/i.test(t)).slice(0, 3).join(' | '));
  assert.ok(texts.includes('MEMBER') && texts.some((t) => /^Concrete B20/.test(t)));
  setDrawingLanguage('en');
  assert.ok(viewTitle('PLAN', 0, 0, 100, 'L').some((e) => e.text === 'SCALE 1:100'));
  setDrawingLanguage('vi');
  assert.ok(viewTitle('MẶT BẰNG', 0, 0, 100, 'L').some((e) => e.text === 'TỶ LỆ: 1/100'));
});

test('review fixes: a text crossed by a line goes behind a mask, stair labels can be switched off', async () => {
  const { maskTexts } = await import('../src/mep.mjs');
  const crossed = { type: 'text', text: 'L1', at: [1000, 1000], height: 200, align: 'middle_center', layer: 'T' };
  const free = { type: 'text', text: 'L2', at: [5000, 5000], height: 200, align: 'middle_center', layer: 'T' };
  const out = maskTexts([crossed, { type: 'line', from: [0, 1000], to: [3000, 1000], layer: 'W' }, free]);
  assert.deepEqual(out.map((e) => e.type), ['line', 'text', 'wipeout', 'text']);
  assert.equal(out[1], free);
  assert.equal(out[3], crossed);
  // an arc (bulge) that passes over a text is found too
  const arc = { type: 'polyline', points: [[0, 0], [2000, 0]], bulges: [0.5, 0], layer: 'W' };
  const on = { type: 'text', text: 'X', at: [1000, -500], height: 200, align: 'middle_center', layer: 'T' };
  assert.equal(maskTexts([arc, on]).filter((e) => e.type === 'wipeout').length, 1);
  const f = floorsOf(TOWN)[0];
  const words = (sp) => buildPlan({ ...sp, scale: 100 }).entities.filter((e) => e.type === 'text' && /^(LÊN|XUỐNG)$/.test(e.text)).length;
  assert.ok(words(f.spec) > 0);
  assert.equal(words({ ...f.spec, stair_labels: false }), 0);
});

// ---------------------------------------------------------------- phase 2: the solid model of the structural bill
import { quantities as p2Quantities, steelTotals as p2SteelTotals } from '../src/boq.mjs';
import { solidModel as p2Model, structurePrisms as p2Prisms, unionVolume as p2Union } from '../src/solids.mjs';

// one bay: four columns 200x200 on the corners of a 4,0 x 5,0 m grid, 3,0 m to the top of the slab; a beam 200x400 on
// each side; a slab 100 thick. floor: a floor of walls for the model (the frame alone without it); voids: holes of the slab
const P2_BEAMS = [
  { name: 'D1', A: [0, 0], B: [4000, 0], d: [1, 0], L: 4000, b: 200, h: 400 }, { name: 'D2', A: [4000, 0], B: [4000, 5000], d: [0, 1], L: 5000, b: 200, h: 400 },
  { name: 'D1', A: [4000, 5000], B: [0, 5000], d: [-1, 0], L: 4000, b: 200, h: 400 }, { name: 'D2', A: [0, 5000], B: [0, 0], d: [0, -1], L: 5000, b: 200, h: 400 },
];
const p2Frame = ({ floor = null, voids = [] } = {}) => ({
  depth: 1500, ground: 0, cover: 25, names: { concrete: 'B20', steel: 'CB300-V', stirrupSteel: 'CB240-T' }, footings: [], stairs: [],
  floors: floor ? [{ name: 'TẦNG 1', level: 0, height: 3000, slab: 100, spec: floor }] : [],
  columns: [[0, 0], [4000, 0], [4000, 5000], [0, 5000]].map((at, i) => ({ name: `K${i + 1}`, mark: 'C1', size: [200, 200], at, bottom: 0, top: 3000, foot: null, on: null })),
  slabs: [
    { name: 'MÓNG', kind: 'foundation', level: 0, slab: 0, members: [] },
    { name: 'MÁI', kind: 'roof', level: 3000, slab: 100, members: P2_BEAMS, stairs: voids, balconyDesign: [], loads: { cells: [{ x0: 0, x1: 4000, y0: 0, y1: 5000, e: { bottom: P2_BEAMS[0], right: P2_BEAMS[1], top: P2_BEAMS[2], left: P2_BEAMS[3] } }] } },
  ],
});

test('solid model: one bay frame, the node to the beam, the slab thickness to the slab, sum of the nets = the union', () => {
  const R = p2Frame(), M = p2Model(R);
  const s = (id) => M.solids.find((x) => x.id === id);
  // the slab runs to the outer faces of the edge beams: 4,2 x 5,2 x 0,1 = 2,184 m³, nothing taken from it
  assert.ok(near(s('S/MÁI').net, 2.184, 1e-9) && s('S/MÁI').cuts.length === 0, `slab ${s('S/MÁI').net}`);
  assert.equal(s('S/MÁI').how, '4,20 x 5,20 x 0,10');
  // a beam runs through its end nodes: D1 0,2 x 0,4 x 4,2 = 0,336, D2 0,2 x 0,4 x 5,2 = 0,416; the slab takes the top
  // 0,1 of each (0,084 and 0,104); where two beams cross at a corner (0,2 x 0,2 x 0,3 = 0,012) the first keeps it:
  // D1#1 0,336 - 0,084 = 0,252; D2#2 0,416 - 0,104 - 0,012 = 0,300; D1#3 0,336 - 0,084 - 0,012 = 0,240;
  // D2#4 0,416 - 0,104 - 2 x 0,012 = 0,288; together the ring of webs (4,2 x 5,2 - 3,8 x 4,8) x 0,3 = 1,080
  for (const [id, v] of [['D1#1', 0.252], ['D2#2', 0.300], ['D1#3', 0.240], ['D2#4', 0.288]]) assert.ok(near(s(id).net, v, 1e-9), `${id} ${s(id).net}`);
  assert.ok(near(s('D1#1').gross, 0.336, 1e-9) && s('D1#1').cuts.length === 1 && s('D1#1').cuts[0].rule === 'slab' && near(s('D1#1').cuts[0].volume, 0.084, 1e-9));
  // a column: 0,2 x 0,2 x 3,0 = 0,120; the slab takes 0,2 x 0,2 x 0,1 = 0,004, the beams the node 0,2 x 0,2 x 0,3 =
  // 0,012: 0,104 = 0,2 x 0,2 x 2,6 (the column stops under the beams)
  const col = M.solids.filter((x) => x.kind === 'column');
  assert.equal(col.length, 4);
  for (const c of col) {
    assert.ok(near(c.net, 0.104, 1e-9) && near(c.gross, 0.12, 1e-9) && c.count === 4, `${c.id} ${c.net}`);
    const by = (rule) => c.cuts.filter((x) => x.rule === rule).reduce((a, x) => a + x.volume, 0);
    assert.ok(near(by('slab'), 0.004, 1e-9) && near(by('beam'), 0.012, 1e-9), JSON.stringify(c.cuts));
    assert.equal(c.how, '4 x (0,20 x 0,20 x 3,00 - 0,004 - 0,012)');
    // formwork: four faces under the beams, 4 x 0,2 x 2,6 = 2,08 m²
    assert.ok(near(c.formwork.total, 2.08, 1e-9), `column formwork ${c.formwork.total}`);
  }
  // the union: 2,184 + 1,080 + 4 x 0,104 = 3,680 m³ = the sum of the nets; gross 2,184 + 2 x 0,336 + 2 x 0,416 +
  // 4 x 0,120 = 4,168, the contact volumes 0,376 (slab from beams) + 0,048 (beam from beam) + 0,064 (from columns) = 0,488
  assert.ok(near(M.sumNet, 3.68, 1e-9) && near(M.union, 3.68, 1e-9) && near(M.sumGross, 4.168, 1e-9) && near(M.sumCuts, 0.488, 1e-9), `${M.sumNet} ${M.union} ${M.sumGross} ${M.sumCuts}`);
  assert.ok(M.checks.every((x) => x.ok), M.checks.filter((x) => !x.ok).map((x) => x.id).join(', '));
  // the prisms for an independent union (AutoCAD): nine members, the same volume by the sweep
  const prisms = p2Prisms(R);
  assert.ok(prisms.length === 9 && prisms.every((p) => p.exact && p.profile.length === 4) && near(p2Union(prisms), 3.68, 1e-9));
  // formwork of the beams: outer faces 2 x (4,2 + 5,2) x 0,3 = 5,64, inner faces 2 x (3,8 + 4,8) x 0,3 = 5,16,
  // soffits (the ring 3,6 m² less the four columns 0,16) = 3,44: 14,24 m²; the slab: soffit 3,8 x 4,8 = 18,24 and
  // its edge 18,8 x 0,1 = 1,88: 20,12 m²
  const fw = (kind) => M.solids.filter((x) => x.kind === kind).reduce((a, x) => a + x.formwork.total, 0);
  assert.ok(near(fw('beam'), 14.24, 1e-9) && near(fw('slab'), 20.12, 1e-9), `${fw('beam')} ${fw('slab')}`);
  // the bill carries the model: columns 0,416, beams 1,080, slab 2,184 m³; formwork of beams and slab 34,36 m²
  const Q = p2Quantities(R, []), q = (key) => Q.rows.find((r) => r.key === key);
  assert.ok(near(q('column:MÁI').q, 0.416, 1e-9) && q('column:MÁI').count === 4 && near(q('beam:MÁI').q, 1.08, 1e-9) && near(q('slab:MÁI').q, 2.184, 1e-9) && near(q('fw_slab:MÁI').q, 34.36, 1e-9) && near(q('fw_column:MÁI').q, 8.32, 1e-9));
  // (earthwork, the ground floor slab and the stair steps are measured now: what is left not counted is shorter)
  assert.ok(Q.checks.every((x) => x.ok) && Q.notCounted.length >= 1 && Q.rules.void.masonry === 0.25);
  // another order of the junction (the column first): the columns keep their full 0,120, the union is the same
  const M2 = p2Model(R, { rules: { junction: ['column', 'beam', 'slab'] } });
  assert.ok(M2.solids.filter((x) => x.kind === 'column').every((c) => near(c.net, 0.12, 1e-9)) && near(M2.sumNet, 3.68, 1e-9) && near(M2.union, 3.68, 1e-9));
  // beams before the slab: the beams keep their top (3,44 x 0,4 = 1,376 with the columns first), the slab 2,184 - 0,344 - 0,016 = 1,824
  assert.ok(near(M2.solids.find((x) => x.kind === 'slab').net, 1.824, 1e-9));
});

test('solid model: a hole in a slab, deducted or not by the thresholds of the rule set (0,1 m³ concrete, 1 m² formwork)', () => {
  // a hole 0,8 x 1,0 m in the slab of the bay: 0,8 m² and 0,08 m³, under both thresholds of Phụ lục VI
  const R = p2Frame({ voids: [[1000, 1000, 1800, 2000]] });
  const Q = p2Quantities(R, []), q = (key) => Q.rows.find((r) => r.key === key);
  // concrete: geometric (4,2 x 5,2 - 0,8 x 1,0) x 0,1 = 2,104; measured 2,184 (the hole is not deducted)
  assert.ok(near(q('slab:MÁI').geo, 2.104, 1e-9) && near(q('slab:MÁI').q, 2.184, 1e-9), `${q('slab:MÁI').geo} ${q('slab:MÁI').q}`);
  assert.equal(q('slab:MÁI').parts[0].expr, '(4.20*5.20-0.80*1.00)*0.10');
  // formwork: soffit 18,24 - 0,8 = 17,44, edges 1,88 + 2 x (0,8 + 1,0) x 0,1 = 2,24, beams 14,24: geometric 33,92;
  // measured 33,92 + 0,8 = 34,72 (a hole under 1 m² is not deducted)
  assert.ok(near(q('fw_slab:MÁI').geo, 33.92, 1e-9) && near(q('fw_slab:MÁI').q, 34.72, 1e-9), `${q('fw_slab:MÁI').geo} ${q('fw_slab:MÁI').q}`);
  assert.ok(Q.checks.every((x) => x.ok), Q.checks.filter((x) => !x.ok).map((x) => x.id).join(', '));
  // the geometric rule set deducts everything
  const N = p2Quantities(R, [], 'vi', 'NET');
  assert.ok(near(N.rows.find((r) => r.key === 'slab:MÁI').q, 2.104, 1e-9) && near(N.rows.find((r) => r.key === 'fw_slab:MÁI').q, 33.92, 1e-9));
  // a hole 1,0 x 1,2 m (1,2 m², 0,12 m³) is over both thresholds: deducted by Phụ lục VI too
  const B = p2Quantities(p2Frame({ voids: [[1000, 1000, 2000, 2200]] }), []), b = (key) => B.rows.find((r) => r.key === key);
  // (21,84 - 1,2) x 0,1 = 2,064; formwork 18,24 - 1,2 + 1,88 + 2 x 2,2 x 0,1 + 14,24 = 33,60
  assert.ok(near(b('slab:MÁI').q, 2.064, 1e-9) && near(b('slab:MÁI').geo, 2.064, 1e-9) && near(b('fw_slab:MÁI').q, 33.6, 1e-9));
  // the plate with its hole as one prism for the union
  const pr = p2Prisms(R).find((p) => p.kind === 'slab');
  assert.ok(pr.holes.length === 1 && pr.holes[0].length === 4);
});

test('solid model: masonry and plaster of a wall with a small and a large opening (the 0,25 m² rule), lintels', () => {
  // the bay closed by 200 walls on its axes; in the south wall a door 0,9 x 2,1 m and a window 0,4 x 0,5 m (0,2 m²)
  const R = p2Frame({ floor: {
    walls: [{ id: 'W', points: [[0, 0], [4000, 0], [4000, 5000], [0, 5000]], closed: true, thickness: 200 }],
    openings: [{ wall: 'W', segment: 0, at: [1000, 0], width: 900, type: 'door', sill: 0, head: 2100 }, { wall: 'W', segment: 0, at: [3000, 0], width: 400, type: 'window', sill: 1200, head: 1700 }],
    heights: { top: 3000 },
  } });
  const M = p2Model(R), Q = p2Quantities(R, [], 'vi', null, M), q = (key) => Q.rows.find((r) => r.key === key);
  assert.ok(M.checks.every((x) => x.ok) && M.warnings.length === 0, JSON.stringify(M.checks.filter((x) => !x.ok)));
  // lintels by the typical table (span up to 1200: 150 deep, 200 bearing): door 1,3 x 0,2 x 0,15 = 0,039 m³,
  // window 0,8 x 0,2 x 0,15 = 0,024 m³; formwork: two sides and the soffit over the opening:
  // 2 x 1,3 x 0,15 + 0,9 x 0,2 = 0,57 and 2 x 0,8 x 0,15 + 0,4 x 0,2 = 0,32 m²
  assert.ok(near(q('lintel').q, 0.063, 1e-9) && q('lintel').count === 2 && near(q('fw_lintel').q, 0.89, 1e-9), `${q('lintel').q} ${q('fw_lintel').q}`);
  // masonry: the walls between the columns and under the beams, 2 x (3,8 + 4,8) x 0,2 x 2,6 = 8,944 m³ (the walls up to
  // the slab 18 x 0,2 x 2,9 = 10,44 less the concrete in them: columns 4 x 0,04 x 2,6 = 0,416, beams 3,6 x 0,3 = 1,08),
  // less the openings 0,9 x 2,1 x 0,2 + 0,4 x 0,5 x 0,2 = 0,418 and the lintels 0,063: 8,463 m³ = 42,315 m²;
  // measured by Phụ lục VI the window (0,2 m² < 0,25) is not deducted: 42,515 m²
  const w = M.walls.reduce((a, x) => ({ gross: a.gross + x.gross, concrete: a.concrete + x.concrete, openings: a.openings + x.openings, net: a.net + x.net }), { gross: 0, concrete: 0, openings: 0, net: 0 });
  assert.ok(near(w.gross, 10.44, 1e-9) && near(w.concrete, 1.559, 1e-9) && near(w.openings, 0.418, 1e-9) && near(w.net, 8.463, 1e-9), JSON.stringify(w));
  assert.ok(near(q('masonry:200').geo, 42.315, 1e-9) && near(q('masonry:200').q, 42.515, 1e-9) && near(q('masonry:200').volume, 8.503, 1e-9), `${q('masonry:200').geo} ${q('masonry:200').q}`);
  const door = M.openings.find((o) => o.type === 'door'), win = M.openings.find((o) => o.type === 'window');
  assert.ok(near(door.area, 1.89, 1e-9) && near(win.area, 0.2, 1e-9) && door.lintel && win.lintel);
  // reveals: the door 2 x 2,1 x 0,2 (jambs) + 0,9 x 0,2 (head) = 1,02; the window 2 x 0,5 x 0,2 + 2 x 0,4 x 0,2 (head, sill) = 0,36; half inside
  assert.ok(near(door.reveal, 1.02, 1e-9) && near(win.reveal, 0.36, 1e-9) && near(door.revealIn, 0.51, 1e-9) && near(win.revealOut, 0.18, 1e-9));
  // plaster inside, up to the soffit of the beams: 2 x (3,8 + 4,8) x 2,6 = 44,72 less the openings 1,89 + 0,2 = 42,63
  // (of which the lintel faces 1,3 x 0,15 + 0,8 x 0,15 = 0,315), plus the reveals 0,51 + 0,18: 43,32 m²; measured:
  // the window is not deducted and has no reveals: + 0,2 - 0,18 = 43,34 m²
  assert.ok(near(M.plaster.inside.wall, 42.315, 1e-9) && near(M.plaster.inside.concrete, 0.315, 1e-9) && near(M.plaster.inside.reveal, 0.69, 1e-9), JSON.stringify(M.plaster.inside));
  assert.ok(near(q('plaster_in').geo, 43.32, 1e-9) && near(q('plaster_in').q, 43.34, 1e-9), `${q('plaster_in').geo} ${q('plaster_in').q}`);
  // plaster outside: walls 2 x (3,8 + 4,8) x 2,6 - 2,09 - 0,315 = 42,315; concrete: column faces 4 x 0,4 x 2,6 = 4,16,
  // beams 18,8 x 0,3 = 5,64, slab edge 18,8 x 0,1 = 1,88, lintels 0,315 = 11,995; reveals 0,69: 55,00; measured 55,02 m²
  assert.ok(near(M.plaster.outside.wall, 42.315, 1e-9) && near(M.plaster.outside.concrete, 11.995, 1e-9), JSON.stringify(M.plaster.outside));
  assert.ok(near(q('plaster_out').geo, 55, 1e-9) && near(q('plaster_out').q, 55.02, 1e-9), `${q('plaster_out').geo} ${q('plaster_out').q}`);
  // soffits: the slab 3,8 x 4,8 = 18,24 and the inner sides of the beams 17,2 x 0,3 = 5,16 (their soffits stand on the walls): 23,40 m²
  assert.ok(near(q('plaster_soffit').q, 23.4, 1e-9), `${q('plaster_soffit').q}`);
  // the geometric rule set deducts the window everywhere
  const N = p2Quantities(R, [], 'vi', 'NET');
  assert.ok(near(N.rows.find((r) => r.key === 'masonry:200').q, 42.315, 1e-9) && near(N.rows.find((r) => r.key === 'plaster_in').q, 43.32, 1e-9));
  // the frame does not change with the walls: columns formed on four faces (the walls are built after them)
  assert.ok(near(q('fw_column:MÁI').q, 8.32, 1e-9) && near(q('fw_slab:MÁI').q, 34.36, 1e-9));
});

test('steel of the bill: the diameter groups of Phụ lục VI (Ø ≤ 10, ≤ 18, > 18), laps counted, the checks of the sample', () => {
  // 162 bars of 1 m of each diameter weigh d² kg (d²/162 kg/m): Ø8 64, Ø10 100, Ø12 144, Ø18 324, Ø20 400, Ø25 625
  const rows = [8, 10, 12, 18, 20, 25].map((d, i) => ({ mark: `T${i + 1}`, shape: '', d, length: 1000, n: 162, members: 1 }));
  const st = p2SteelTotals([{ title: 'T', rows, sched: rebarSchedule(rows) }], { names: { steel: 'CB300-V', stirrupSteel: 'CB240-T' } });
  // Ø ≤ 10: 64 + 100 = 164; 10 < Ø ≤ 18: 144 + 324 = 468; Ø > 18: 400 + 625 = 1025; by grade: Ø < 10 64, Ø ≥ 10 1593
  assert.deepEqual(st.groups.map((g) => g.kg), [164, 468, 1025]);
  assert.ok(st.small === 64 && st.large === 1593 && st.total === 1657 && st.groups.map((g) => g.label).join('|') === 'Ø ≤ 10|10 < Ø ≤ 18|Ø > 18');
  // the town house: the column bars are lapped 40d at every floor above the first and anchored 300 + 30d at the ends
  const R = structuralCalc({ spec: TOWN }), B = boqSheets(R);
  const g = B.groups.find((x) => x.title.startsWith('CỘT C1')), c = R.columns.filter((x) => x.mark === 'C1').sort((a, b) => (b.top - b.bottom) - (a.top - a.bottom))[0];
  assert.equal(g.rows[0].length, Math.round(c.top - c.bottom + (c.on ? 30 * c.bars.d : 300) + 30 * c.bars.d + Math.max(0, c.storeys - 1) * 40 * c.bars.d));
  // lintels over the openings in the schedule and in the bill; the groups add up; every cross-check passes
  const Q = B.quantities, q = (re) => Q.rows.find((r) => !r.head && re.test(r.item));
  assert.ok(B.groups.some((x) => x.title === 'LANH TÔ') && q(/^Bê tông lanh tô/).q > 0 && q(/^Ván khuôn lanh tô/).q > 0);
  assert.ok(near(Q.steel.groups.reduce((a, x) => a + x.kg, 0), Q.steel.total, 0.05));
  for (const id of ['prism', 'union', 'contact', 'columns', 'formwork:footing', 'envelope', 'bill', 'formwork', 'steel', 'steel:groups']) assert.ok(B.checks.some((x) => x.id === id), id);
  assert.ok(B.checks.every((x) => x.ok && Number.isFinite(x.lhs) && Number.isFinite(x.rhs)), B.checks.filter((x) => !x.ok).map((x) => `${x.id} ${x.lhs} ${x.rhs} ${x.where}`).join('; '));
  assert.ok(near(B.model.sumNet, B.model.union, 1e-6) && B.model.sumGross > B.model.sumNet, `${B.model.sumNet} ${B.model.union}`);
  // every line has both quantities, its like parts and its calculation; the parts add up to the line
  for (const r of Q.rows.filter((x) => !x.head)) {
    assert.ok(Number.isFinite(r.q) && Number.isFinite(r.geo) && r.count >= 1 && r.how && r.parts.length, r.item);
    assert.ok(near(r.parts.reduce((a, p) => a + p.n * p.one, 0), r.q, 5.01e-4), r.item);
  }
  // the workbook: the quantity sheet made of the parts as formulas, and a checks sheet (7 sheets); the CSV with both
  const kc = kcWorkbook(R, B);
  assert.ok(kc.includes(Buffer.from('xl/worksheets/sheet7.xml')) && !kc.includes(Buffer.from('xl/worksheets/sheet8.xml')));
  const csv = boqCsv(B.groups, Q);
  assert.ok(csv.includes('KHỐI LƯỢNG HÌNH HỌC') && csv.includes('KIỂM TRA CHÉO') && csv.includes('CHƯA GỒM') && csv.includes('Nhóm Ø ≤ 10'));
});

// ---- the earthwork of the foundations, the slab on grade and the fill under it, the brick steps of the stairs
// (solids.mjs, boq.mjs); every answer calculated by hand

import { lintelRows as p2LintelRows } from '../src/solids.mjs';
import { uStairGeom as p2StairGeom } from '../src/plan.mjs';
import { structureNotes as p2Notes } from '../src/structure.mjs';

// the bay on pad footings (pad x pad x 0,4 m, their underside 1,5 m below the floor, lean concrete 100 thick and 100
// wider on every side), the ground at -0,45, ground beams 200x400 with their top at the ground
const p2Found = ({ pad = 1000, beams = P2_BEAMS, floor = null } = {}) => {
  const R = p2Frame({ floor });
  return {
    ...R, ground: -450, footings: [{ mark: 'M1', B: pad, L: pad, H: 400, count: 4 }],
    columns: R.columns.map((c) => ({ ...c, bottom: -1100, foot: { mark: 'M1', B: pad, L: pad, H: 400 } })),
    slabs: [{ name: 'MÓNG', kind: 'foundation', level: -450, slab: 0, members: beams }, R.slabs[1]],
  };
};

test('earthwork: pits and trenches counted once, what is buried in them, backfill and surplus soil; sloped sides', () => {
  const R = p2Found(), M = p2Model(R), Q = p2Quantities(R, [], 'vi', null, M), q = (key) => Q.rows.find((r) => r.key === key);
  // pits: the lean concrete 1,2 x 1,2 and 0,3 of working space on every side, from -1,60 up to the ground at -0,45:
  // 4 x 1,8 x 1,8 x 1,15 = 14,904 m³. Trenches under the ground beams (lean concrete 0,4 wide, 4,2 and 5,2 long, its
  // underside at -0,95): 1,0 x 4,8 x 0,5 = 2,4 and 1,0 x 5,8 x 0,5 = 2,9, of which 1,3 m at each end lies in a pit
  // (2 x 1,3 x 1,0 x 0,5 = 1,3 m³): 1,1 and 1,6 m³. Together 14,904 + 2 x 1,1 + 2 x 1,6 = 20,304 m³
  assert.ok(near(q('excavation').q, 20.304, 1e-9) && q('excavation').count === 8, `${q('excavation').q}`);
  assert.equal(q('excavation').how, '4 x 1,80 x 1,80 x 1,15 + 2 x (1,00 x 4,80 x 0,50 - 1,3) + 2 x (1,00 x 5,80 x 0,50 - 1,3)');
  assert.ok(near(M.earth.total, 20.304, 1e-9) && near(M.earth.sum, 14.904 + 2 * 2.4 + 2 * 2.9, 1e-9) && M.earth.items.length === 8);
  // buried: the lean concrete of the pads 4 x 1,2 x 1,2 x 0,1 = 0,576; the pads 4 x 0,4 = 1,6; the ground beams, a
  // ring (4,2 x 5,2 - 3,8 x 4,8) x 0,4 = 1,44; their lean concrete (2 x 1,68 + 2 x 2,08 - 4 x 0,09 at the corners -
  // 4 x 0,04 where the stubs pass) x 0,1 = 0,700; the stubs under the ground beams 4 x 0,2 x 0,2 x 0,25 = 0,04: 4,356 m³
  assert.ok(near(q('lean_footing').q, 0.576, 1e-9) && near(q('lean_ground_beam').q, 0.7, 1e-9) && near(q('footing').q, 1.6, 1e-9) && near(q('ground_beam').q, 1.44, 1e-9));
  assert.ok(near(M.earth.buried.total, 4.356, 1e-9) && near(M.earth.backfill, 15.948, 1e-9));
  assert.ok(near(q('backfill').q, 15.948, 1e-9) && near(q('surplus').q, 4.356, 1e-9), `${q('backfill').q} ${q('surplus').q}`);
  // the backfill is made of the lines above it (a whole line where all of it lies under the ground) and of the stubs
  // up to the ground: 0,2 x 0,2 x 0,65 less the 0,016 the ground beams took of each
  assert.deepEqual(q('backfill').parts.filter((x) => x.from).map((x) => `${x.from.k}:${x.from.key}`), ['1:excavation', '-1:lean_footing', '-1:lean_ground_beam', '-1:footing', '-1:ground_beam']);
  const stub = q('backfill').parts.find((x) => !x.from);
  assert.ok(stub.n === 4 && stub.expr === '-(0.20*0.20*0.65-0.016)' && near(stub.one, -0.01, 1e-9), JSON.stringify(stub));
  for (const id of ['earth:union', 'earth:buried', 'earth:inside', 'earth:bill', 'earth:balance']) assert.ok(Q.checks.find((x) => x.id === id)?.ok, id);
  assert.ok(Q.checks.every((x) => x.ok), Q.checks.filter((x) => !x.ok).map((x) => x.id).join(', '));
  // the working space and the vertical sides are assumptions of the bill; earth is not a concrete line: the lines
  // flagged concrete still add up to the solid model
  assert.ok(Q.assumed.some((a) => a.item === 'earth' && /300/.test(a.note)) && !Q.notCounted.some((x) => /Đào/.test(x.item)));
  assert.ok(!q('excavation').concrete && near(Q.rows.filter((r) => r.concrete).reduce((a, r) => a + r.parts.reduce((b, x) => b + x.n * x.one, 0), 0), M.sumNet, 2e-3));
  // sides sloped 0,5 horizontal for 1 vertical, no ground beams: each pit is 1,8 x 1,8 at the bottom, 2,95 x 2,95 at
  // the ground, 1,15 deep: 1,15 / 6 x (1,8² + 4 x 2,375² + 2,95²) = 6,613458 m³; buried 0,576 + 1,6 + the stubs up to
  // the ground 4 x 0,2 x 0,2 x 0,65 = 0,104: 2,28 m³
  const S = p2Quantities(p2Found({ beams: [] }), [], 'vi', null, null, { earth: { space: 300, slope: 0.5 } }), sl = (key) => S.rows.find((r) => r.key === key);
  assert.ok(sl('excavation').parts.length === 1 && sl('excavation').parts[0].n === 4 && near(sl('excavation').parts[0].one, 6.613458, 1e-6));
  assert.equal(sl('excavation').parts[0].expr, '1.15/6*(1.80*1.80+4*2.375*2.375+2.95*2.95)');
  assert.ok(near(sl('excavation').q, 26.454, 1e-9) && near(sl('backfill').q, 24.174, 1e-9) && near(sl('surplus').q, 2.28, 1e-9) && /1:0,5/.test(sl('excavation').item));
  // given by the caller they are not assumed; earth: false leaves the earthwork out
  assert.ok(S.checks.every((x) => x.ok) && !S.assumed.some((a) => a.item === 'earth'));
  const N = p2Quantities(R, [], 'vi', null, null, { earth: false });
  assert.ok(!N.rows.some((r) => ['excavation', 'backfill', 'surplus'].includes(r.key)) && N.checks.every((x) => x.ok));
});

test('footings that touch or overlap are cast as one: no formwork between them, the check follows their outline', () => {
  const row = (Q, key) => Q.rows.find((r) => r.key === key);
  // pads 4,0 x 4,0 x 0,4 under columns 4,0 m apart one way (5,0 the other): two pairs that touch along a side.
  // Formwork 4 x (2 x (4 + 4) x 0,4 - 4 x 0,4) = 19,2 m² = the outline of the two pairs, 2 x 24 x 0,4
  const T = p2Found({ pad: 4000, beams: [] }), MT = p2Model(T), QT = p2Quantities(T, [], 'vi', null, MT);
  assert.ok(near(row(QT, 'fw_footing').q, 19.2, 1e-9) && near(row(QT, 'footing').q, 25.6, 1e-9), `${row(QT, 'fw_footing').q}`);
  assert.equal(row(QT, 'fw_footing').how, '4 x (2 x (4,00 + 4,00) x 0,40 - 1,6)');
  const ct = MT.checks.find((x) => x.id === 'formwork:footing');
  assert.ok(ct.ok && near(ct.lhs, 19.2, 1e-9) && near(ct.rhs, 19.2, 1e-9) && QT.checks.every((x) => x.ok), JSON.stringify(ct));
  // pads 4,4 x 4,4: each pair overlaps by 0,4 x 4,4 x 0,4 = 0,704 m³, counted once: 4 x 7,744 - 2 x 0,704 = 29,568 m³;
  // formwork = the outline of the two pairs 2 x 2 x (8,4 + 4,4) x 0,4 = 20,48 m² (5,28 for the pad that keeps the
  // overlap, 4,96 for the other)
  const O = p2Found({ pad: 4400, beams: [] }), MO = p2Model(O), QO = p2Quantities(O, [], 'vi', null, MO);
  assert.ok(near(row(QO, 'footing').q, 29.568, 1e-9) && near(row(QO, 'fw_footing').q, 20.48, 1e-9), `${row(QO, 'footing').q} ${row(QO, 'fw_footing').q}`);
  const co = MO.checks.find((x) => x.id === 'formwork:footing');
  assert.ok(co.ok && near(co.lhs, 20.48, 1e-9) && near(co.rhs, 20.48, 1e-9) && QO.checks.every((x) => x.ok), JSON.stringify(co));
  // the town house on weak soil (50 kPa): pads of about 5 m under columns 4,8 m apart overlap; the bill is right
  // (less formwork than 2 x (B + L) x H of every pad) and every check passes
  const R = structuralCalc({ spec: TOWN, soil: 50 }), B = boqSheets(R);
  const pads = B.model.solids.filter((x) => x.kind === 'footing');
  assert.ok(row(B.quantities, 'fw_footing').q < pads.reduce((a, x) => a + x.formwork.gross, 0) - 1 && pads.some((x) => x.cuts.length));
  assert.ok(B.checks.every((x) => x.ok), B.checks.filter((x) => !x.ok).map((x) => `${x.id} ${x.lhs} ${x.rhs}`).join('; '));
  assert.ok(near(B.model.sumNet, B.model.union, 1e-6));
});

test('ground floor: the slab on grade inside the walls and the fill under it, in the solid model and in the prisms', () => {
  // the bay closed by 200 walls on its axes, the ground at -0,45: inside the walls 3,8 x 4,8 = 18,24 m²; the slab 100
  // thick 1,824 m³, the fill from the ground up to its underside 18,24 x 0,35 = 6,384 m³
  const floor = { walls: [{ id: 'W', points: [[0, 0], [4000, 0], [4000, 5000], [0, 5000]], closed: true, thickness: 200 }], openings: [], heights: { top: 3000 } };
  const R = { ...p2Frame({ floor }), ground: -450 }, M = p2Model(R), Q = p2Quantities(R, [], 'vi', null, M), q = (key) => Q.rows.find((r) => r.key === key);
  assert.ok(near(q('ground_slab').q, 1.824, 1e-9) && q('ground_slab').concrete === true && q('ground_slab').how === '3,80 x 4,80 x 0,10', `${q('ground_slab').q} ${q('ground_slab').how}`);
  assert.ok(near(q('ground_fill').q, 6.384, 1e-9) && !q('ground_fill').concrete && q('ground_fill').how === '3,80 x 4,80 x 0,35', `${q('ground_fill').q} ${q('ground_fill').how}`);
  // the slab is one more solid: the sum of the nets is still the union (3,68 + 1,824), and the prisms for AutoCAD have it
  assert.ok(near(M.sumNet, 5.504, 1e-9) && near(M.union, 5.504, 1e-9), `${M.sumNet} ${M.union}`);
  const prisms = p2Prisms(R, M.options);
  assert.ok(prisms.length === 10 && near(p2Union(prisms), 5.504, 1e-9) && near(p2Union(p2Prisms(R)), 5.504, 1e-9));
  for (const id of ['ground:plate', 'ground:fill']) assert.ok(M.checks.find((x) => x.id === id)?.ok, id);
  assert.ok(Q.checks.every((x) => x.ok) && Q.assumed.some((a) => a.item === 'ground_slab' && /100/.test(a.note)));
  // cast last, between the walls: without it the frame, its formwork, the masonry and the plaster are the same
  const N = p2Model(R, { groundSlab: false }), QN = p2Quantities(R, [], 'vi', null, N);
  assert.ok(near(N.sumNet, 3.68, 1e-9) && p2Prisms(R, N.options).length === 9 && !QN.rows.some((r) => /^ground_/.test(r.key)) && !QN.assumed.length);
  for (const key of ['column:MÁI', 'fw_column:MÁI', 'fw_slab:MÁI', 'masonry:200', 'plaster_in', 'plaster_out', 'plaster_soffit']) assert.ok(near(q(key).q, QN.rows.find((r) => r.key === key).q, 1e-9), key);
  // another thickness: 150 -> 2,736 m³ on 0,30 of fill 5,472 m³; given by the caller, it is not assumed
  const T = p2Quantities(R, [], 'vi', null, null, { groundSlab: { thickness: 150 } }), t = (key) => T.rows.find((r) => r.key === key);
  assert.ok(near(t('ground_slab').q, 2.736, 1e-9) && near(t('ground_fill').q, 5.472, 1e-9) && !T.assumed.some((a) => a.item === 'ground_slab') && T.checks.every((x) => x.ok));
});

test('brick steps of the stairs, one lintel table for the notes and the bill, the new lines of the sample in the workbook', () => {
  const R = structuralCalc({ spec: TOWN }), B = boqSheets(R), Q = B.quantities, q = (key) => Q.rows.find((r) => r.key === key);
  // a step: a triangle going x riser / 2 under every tread of a flight (n - 1 treads for n risers), as wide as the flight
  let steps = 0, vol = 0;
  for (const f of R.floors) {
    for (const st of (f.spec.stairs || []).filter((x) => x.type === 'u')) {
      const g = p2StairGeom(st, f.height), n = g.n1 - 1 + g.n2 - 1;
      steps += n;
      vol += (((n * g.going * g.riser) / 2) * g.w) / 1e9;
    }
  }
  assert.ok(steps > 0 && q('stair_steps').count === steps && q('stair_steps').unit === 'm³' && near(q('stair_steps').geo, vol, 2e-3), `${q('stair_steps').geo} ${vol} ${steps}`);
  assert.ok(B.checks.find((x) => x.id === 'steps')?.ok && B.assumed.some((a) => a.item === 'stair_steps'));
  // one table of typical lintels: the rows of the general notes are the table the bill measures its lintels by
  assert.deepEqual(p2LintelRows('vi'), [
    ['L ≤ 1200', '220x150', '2Ø10', '2Ø10', 'Ø6a200', '200'], ['1200 < L ≤ 2000', '220x200', '2Ø12', '2Ø10', 'Ø6a200', '250'],
    ['2000 < L ≤ 3000', '220x300', '2Ø14', '2Ø12', 'Ø6a150', '300'], ['L > 3000', 'Theo thiết kế dầm', '', '', '', ''],
  ]);
  const notes = JSON.stringify(p2Notes({ lang: 'en' }));
  assert.ok(notes.includes('2000 < L ≤ 3000') && notes.includes('As a designed beam') && notes.includes('2Ø14') && notes.includes('Ø6a150'));
  // the sample: excavation, backfill, surplus soil, the fill and the slab of the ground floor are lines of the bill
  // (backfill + surplus = excavation); what is left not counted no longer lists them
  for (const key of ['excavation', 'backfill', 'surplus', 'ground_fill', 'ground_slab']) assert.ok(q(key)?.q > 0 && q(key).parts.length, key);
  assert.ok(near(q('backfill').q + q('surplus').q, q('excavation').q, 2e-3) && q('ground_slab').concrete && !q('ground_fill').concrete);
  assert.ok(B.notCounted.length >= 1 && B.notCounted.every((x) => !/Bậc thang|Nền tầng 1|Đào/.test(x.item)) && B.assumed.map((a) => a.item).join() === 'earth,ground_slab,stair_steps');
  // the workbook: the backfill is a formula of the lines above it; the CSV lists what was assumed
  const kc = kcWorkbook(R, B).toString('utf8');
  assert.ok(/<f>I\d+<\/f>/.test(kc) && /<f>-I\d+<\/f>/.test(kc) && kc.includes('GIẢ ĐỊNH'));
  const csv = boqCsv(B.groups, Q);
  assert.ok(csv.includes('GIẢ ĐỊNH') && csv.includes('Đào hố móng') && csv.includes('Bê tông nền tầng 1') && csv.includes('Xây bậc thang'));
  // the prisms for AutoCAD with the options of the model: the same union as the bill
  assert.ok(near(p2Union(p2Prisms(R, B.model.options)), B.model.sumNet, 1e-6) && near(p2Union(p2Prisms(R)), B.model.sumNet, 1e-6));
});

// ---- the surface model of the finishes (surfaces.mjs): faces with their ledger, the measured and the geometric
// quantity, the cross-checks; every answer calculated by hand

import { floorPlate, floorSurfaces, revealFaces } from '../src/surfaces.mjs';
import { finishCsv as surfCsv, finishSheet as surfSheet } from '../src/archboq.mjs';
import { buildModel as surfModel } from '../src/elevation.mjs';

const SURF_R4 = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const surfFinishes = (rooms, h) => Object.fromEntries(Object.keys(rooms).map((name) => [name, resolveFinish(name, {}, [], h)]));
// a room 5.0 x 4.0 m inside walls 200 thick, storey 3300: a door D2 800 x 2400, a window S1 1200 x 1500 (sill 900), a
// small window S9 400 x 500 (0.20 m²: under the 0.25 m² of Phụ lục VI)
const SURF_BOX = {
  walls: [{ id: 'W', points: [[-100, -100], [5100, -100], [5100, 4100], [-100, 4100]], closed: true, thickness: 200 }], heights: { top: 3300 },
  openings: [{ wall: 'W', segment: 0, at: [1000, -100], width: 800, type: 'door', tag: 'D2' }, { wall: 'W', segment: 2, at: [2500, 4100], width: 1200, type: 'window', tag: 'S1' },
    { wall: 'W', segment: 1, at: [5100, 2000], width: 400, type: 'window', sill: 2000, head: 2500, tag: 'S9' }],
  rooms: [{ name: 'PHÒNG NGỦ', at: [2500, 2000] }],
};
const SURF_ROOMS = { 'PHÒNG NGỦ': SURF_R4(0, 0, 5000, 4000) };

test('surfaces: a room with a door, a window and a small opening: wall faces, reveals, skirting, the 0,25 m² rule', () => {
  // the ceiling of a 3300 storey is at +2.800 with a drop band 600 x 150: the walls are painted up to +2.650
  const finishes = surfFinishes(SURF_ROOMS, 3300);
  const S = floorSurfaces({ spec: SURF_BOX, rooms: SURF_ROOMS, finishes, floor: 'T1', ground: 450 });
  const wall = S.faces.filter((f) => f.kind === 'wall');
  assert.equal(wall.length, 4);
  // south: 5.00 x 2.65 = 13.25, less the door 0.80 x 2.40 = 1.92, plus its reveals 75 deep (half the 200 wall less half
  // a 50 frame): (2 x 2.40 + 0.80) x 0.075 = 0.42: 11.75 m²
  assert.ok(near(wall[0].measured, 13.25 - 1.92 + 0.42, 1e-9) && near(wall[0].net, 11.75, 1e-9), wall[0].how);
  assert.equal(wall[0].how, '5,00 x 2,65 - 0,80 x 2,40 (D2) + má cửa D2 5,60 x 0,075');
  // east: 4.00 x 2.65 = 10.60; S9 0.40 x 0.50 = 0.20 m² is not taken off by the rule (it is by the geometry); its
  // reveals (2 x 0.50 + 0.40 head + 0.40 sill) x 0.075 = 0.135 count in both: 10.735 measured, 10.535 geometric
  assert.ok(near(wall[1].measured, 10.6 + 0.135, 1e-9) && near(wall[1].net, 10.6 - 0.2 + 0.135, 1e-9), wall[1].how);
  assert.ok(wall[1].deductions[0].off === false && wall[1].how.includes('không trừ, nhỏ hơn 0,25 m²: S9 0,40 x 0,50'), wall[1].how);
  // north: 13.25 less the window 1.20 x 1.50 = 1.80, plus (2 x 1.50 + 1.20 + 1.20) x 0.075 = 0.405: 11.855; west: 10.60
  assert.ok(near(wall[2].measured, 13.25 - 1.8 + 0.405, 1e-9) && near(wall[3].measured, 10.6, 1e-9));
  // the reveals one by one: three openings, each on its two faces; the door 5.60 m of jambs and head x 0.075
  const rv = revealFaces(S.faces);
  assert.ok(rv.length === 6 && rv[0].of === wall[0].id && near(rv[0].L, 5.6, 1e-9) && near(rv[0].H, 0.075, 1e-9) && near(rv[0].measured, 0.42, 1e-9), JSON.stringify(rv[0]));
  // skirting: a run per edge, the door off its edge: 4.20 + 4.00 + 5.00 + 4.00 = 17.20 m
  assert.deepEqual(S.faces.filter((f) => f.kind === 'skirting').map((f) => Math.round(f.measured * 1000) / 1000), [4.2, 4, 5, 4]);
  // the outer faces: 5.40 and 4.40 long (to the corners), 3.30 + 0.45 of plinth high, the same openings, the outside
  // half of their reveals
  const out = S.faces.filter((f) => f.kind === 'exterior');
  assert.ok(near(out[0].measured, 5.4 * 3.75 - 1.92 + 0.42, 1e-9) && near(out[1].measured, 4.4 * 3.75 + 0.135, 1e-9) && near(out[1].net, 4.4 * 3.75 - 0.2 + 0.135, 1e-9));
  // the schedule: paint 11.75 + 10.735 + 11.855 + 10.60 = 44.94 m² by the rule, 44.74 m² geometric; with the geometric
  // rule set every opening is deducted
  const ms = materialSchedule({ spec: SURF_BOX, rooms: SURF_ROOMS, finishes });
  const row = (m, code) => m.rows.find((r) => r.code === code);
  assert.ok(near(row(ms, 'WL-01').qty, 44.94, 1e-9) && near(row(ms, 'WL-01').geo, 44.74, 1e-9) && row(ms, 'WL-01').faces.length === 4, JSON.stringify(row(ms, 'WL-01')));
  // the floor: the outline 20 m² and what lies under the door D2, 0.80 x half the 200 wall (the inner half only: there
  // is no room outside)
  assert.ok(near(row(ms, 'SK-01').qty, 17.2, 1e-9) && row(ms, 'FL-01').qty === 20.08);
  assert.ok(near(row(materialSchedule({ spec: SURF_BOX, rooms: SURF_ROOMS, finishes, rules: 'NET' }), 'WL-01').qty, 44.74, 1e-9));
  // the bill: the same paint with both numbers; outer paint 18.75 + 16.635 + 18.855 + 16.50 = 70.74 (70.54 geometric);
  // the gable roof the plan assumes (30°, 500 overhang) on its slope: (5.4 + 1.0) x (4.4 + 1.0) / cos 30° = 39.906 m²
  const Q = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: SURF_BOX, height: 3300, rooms: SURF_ROOMS, finishes }], spec: SURF_BOX });
  const q = (key) => Q.rows.find((r) => r.key === key);
  assert.ok(q('paint|PUT').q === 44.94 && q('paint|PUT').geo === 44.74 && q('paint|IN|WL-01').q === 44.94 && q('paint|PUT').faces.length === 4, JSON.stringify(q('paint|PUT')));
  assert.ok(q('paint|OUT').q === 70.74 && q('paint|OUT').geo === 70.54, JSON.stringify(q('paint|OUT')));
  assert.ok(near(q('water|PITCH').q, (6.4 * 5.4) / Math.cos(Math.PI / 6), 0.0006), JSON.stringify(q('water|PITCH')));
  // the checks: every opening on two faces (the room and the outside) by the same area, the reveals as perimeter x
  // depth, the bill against the schedule code by code (FL, SK, WL, CL)
  assert.ok(Q.checks.length >= 10 && Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  assert.equal(Q.checks.filter((c) => c.id === 'openings').length, 3);
  assert.ok(Q.checks.some((c) => c.id === 'reveals') && Q.checks.filter((c) => c.id === 'bill').length === 4);
  assert.ok(Q.rules.void === 0.25 && Q.rules.decimals === 3);
  // where the two numbers differ the drawn table and the CSV show both
  assert.ok(surfSheet(Q).entities.find((e) => e.type === 'table').rows[0].includes('KL HÌNH HỌC'));
  assert.equal(surfCsv(Q).split('\r\n')[1].split(';')[4], 'KL HÌNH HỌC');
  const net = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: SURF_BOX, height: 3300, rooms: SURF_ROOMS, finishes }], spec: SURF_BOX, rules: 'NET' });
  assert.ok(net.rows.find((r) => r.key === 'paint|PUT').q === 44.74 && !surfSheet(net).entities.find((e) => e.type === 'table').rows[0].includes('KL HÌNH HỌC'));
});

test('surfaces: an L-shaped room with a dropped ceiling: the vertical face of the drop band', () => {
  // 6.0 x 3.0 + 3.0 x 2.0 = 24 m², perimeter 22 m. The band is 600 wide and 150 deep: its inner edge is the outline
  // moved in by 600, 22 - 8 x 0.6 = 17.2 m long (a rectilinear outline loses 8 widths), so the drop face is
  // 17.2 x 0.15 = 2.58 m²
  const rooms = { 'PHÒNG KHÁCH': [[0, 0], [6000, 0], [6000, 3000], [3000, 3000], [3000, 5000], [0, 5000]] };
  const finishes = { 'PHÒNG KHÁCH': resolveFinish('PHÒNG KHÁCH') };
  const S = floorSurfaces({ spec: null, rooms, finishes });
  const drop = S.faces.find((f) => f.kind === 'ceiling_drop');
  assert.ok(near(drop.L, 17.2, 1e-9) && near(drop.H, 0.15, 1e-9) && near(drop.measured, 2.58, 1e-9) && drop.code === 'CL-01', JSON.stringify(drop));
  // six wall faces, each to the underside of the band (+2.850): 22 x 2.85 = 62.7 m²
  const wall = S.faces.filter((f) => f.kind === 'wall');
  assert.deepEqual(wall.map((f) => f.L), [6, 3, 3, 2, 3, 5]);
  assert.ok(wall.every((f) => near(f.H, 2.85, 1e-9)));
  // the ceiling: the flat part 24 (the field and the underside of the band make up the plan) + the drop face 2.58
  const ms = materialSchedule({ spec: null, rooms, finishes });
  const qty = (code) => ms.rows.find((r) => r.code === code).qty;
  assert.ok(qty('CL-01') === 26.58 && qty('FL-01') === 24 && qty('SK-01') === 22 && near(qty('WL-01'), 62.7, 1e-9), JSON.stringify(ms.rows));
  // a room too narrow for the band keeps a flat ceiling: no drop face
  const kho = floorSurfaces({ spec: null, rooms: { KHO: SURF_R4(0, 0, 2250, 1950) }, finishes: { KHO: resolveFinish('KHO') } });
  assert.ok(!kho.faces.some((f) => f.kind === 'ceiling_drop') && kho.faces.some((f) => f.kind === 'ceiling'));
});

// a stairwell 2.40 x 4.00 m inside walls 200 thick, storey 3200: 20 risers of 160 (10 + 10), goings of 300 (the flights
// run 2700, the half landing is 1300 deep), flights 1150 wide beside a 100 well
const SURF_STAIR = { type: 'u', region: [[0, 0], [2400, 4000]], direction: 'up', turn: 'right', gap: 100, risers: 20, landing: 1300 };
const SURF_WELL = { walls: [{ id: 'T', points: [[-100, -100], [2500, -100], [2500, 4100], [-100, 4100]], closed: true, thickness: 200 }], heights: { top: 3200 }, stairs: [SURF_STAIR] };

test('surfaces: a stairwell on its real surfaces: treads, risers, stepped skirting, handrail and soffits on the slope', () => {
  const rooms = { 'CẦU THANG': SURF_R4(0, 0, 2400, 4000) }, finishes = surfFinishes(rooms, 3200);
  const S = floorSurfaces({ spec: SURF_WELL, rooms, finishes });
  const sumOf = (kind, T = S) => T.faces.filter((f) => f.kind === kind).reduce((a, f) => a + f.measured, 0);
  // treads: 9 goings x 0.30 x 1.15 = 3.105 a flight; the half landing 2.40 x 1.30 = 3.12
  assert.deepEqual(S.faces.filter((f) => f.kind === 'tread').map((f) => [f.n, f.L, f.H]), [[9, 0.3, 1.15], [9, 0.3, 1.15]]);
  assert.ok(near(sumOf('tread'), 6.21, 1e-9) && near(sumOf('landing'), 3.12, 1e-9));
  // risers: 20 x 0.16 x 1.15 = 3.68
  assert.ok(near(sumOf('riser'), 3.68, 1e-9));
  // skirting stepped along the wall beside each flight: 9 x 0.30 + 10 x 0.16 = 4.30, and around the landing 2 x 1.30 +
  // 2.40 = 5.00: 13.60 m; none on the plan of the room (every edge of it lies along the well)
  assert.ok(near(sumOf('stair_skirting'), 13.6, 1e-9) && !S.faces.some((f) => f.kind === 'skirting'));
  // handrail on the slope of each flight hypot(2.70, 1.60) = 3.138 and across the well 0.10: 6.377 m
  const slope = Math.hypot(2.7, 1.6);
  assert.ok(near(sumOf('handrail'), 2 * slope + 0.1, 1e-9));
  // soffits: both flights on the slope 3.138 x 1.15 and the landing 3.12: 10.338 m², not the plan of the stairwell 9.60
  assert.ok(near(sumOf('soffit'), 2 * slope * 1.15 + 3.12, 1e-9));
  // the walls of the stairwell: 12.8 m x the storey 3.20 (no ceiling)
  assert.ok(near(sumOf('wall'), 12.8 * 3.2, 1e-9));
  // the schedule and the bill: granite 6.21 + 3.12 + 3.68 = 13.01 m², skirting 13.60 m
  const ms = materialSchedule({ spec: SURF_WELL, rooms, finishes });
  const qty = (code) => ms.rows.find((r) => r.code === code).qty;
  assert.ok(qty('FL-04') === 13.01 && qty('SK-02') === 13.6, JSON.stringify(ms.rows));
  const Q = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: SURF_WELL, height: 3200, rooms, finishes }], spec: SURF_WELL });
  const q = (key) => Q.rows.find((r) => r.key === key).q;
  assert.ok(q('stair|TREAD') === 9.33 && q('stair|RISER') === 3.68 && q('stair|SKIRT') === 13.6 && q('stair|RAIL') === 6.377 && q('paint|SLAB') === 10.338, JSON.stringify(Q.rows.filter((r) => r.section === 'stair')));
  // 20 risers x 0.16 = the storey 3.20, 9 treads a flight, the faces add up to the formulas of the stair
  for (const id of ['stair_rise', 'stair_treads', 'stair_tread', 'stair_riser', 'stair_skirting', 'stair_rail']) assert.ok(Q.checks.find((c) => c.id === id)?.ok, id);
  assert.ok(Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  assert.ok(Q.stairs[0].n1 === 10 && Q.stairs[0].n2 === 10 && Q.stairs[0].riser === 0.16 && Q.stairs[0].going === 0.3 && Q.stairs[0].c1 === 1 && Q.stairs[0].wall === 5);
  // the same stair open to a room, a wall beside flight 1 only: the skirting steps along that wall 4.30 m and runs
  // along its side of the landing 1.30 m
  const open = floorSurfaces({ spec: { walls: [{ id: 'A', points: [[-100, -100], [-100, 4100]], thickness: 200 }], heights: { top: 3200 }, stairs: [SURF_STAIR] }, rooms: {}, finishes: {} });
  assert.ok(near(sumOf('stair_skirting', open), 5.6, 1e-9) && near(sumOf('tread', open), 6.21, 1e-9));
  // a straight flight beside a wall, 14 treads of 250, 1.20 wide, 15 risers of 200 to +3.000: treads 14 x 0.25 x 1.2 =
  // 4.2, risers 15 x 0.2 x 1.2 = 3.6, skirting 14 x 0.25 + 15 x 0.2 = 6.5, handrail and soffit on hypot(3.5, 3.0) = 4.61
  const straight = floorSurfaces({ spec: { walls: [{ id: 'A', points: [[-100, -100], [-100, 6100]], thickness: 200 }], heights: { top: 3000 }, stairs: [{ start: [600, 1000], direction: 90, width: 1200, treads: 14, going: 250 }] }, rooms: {}, finishes: {} });
  assert.ok(near(sumOf('tread', straight), 4.2, 1e-9) && near(sumOf('riser', straight), 3.6, 1e-9) && near(sumOf('stair_skirting', straight), 6.5, 1e-9));
  assert.ok(near(sumOf('handrail', straight), Math.hypot(3.5, 3), 1e-9) && near(sumOf('soffit', straight), Math.hypot(3.5, 3) * 1.2, 1e-9));
});

test('surfaces: the floor plate check: room areas + wall footprints = the plate inside the outer faces', () => {
  // TWO: outer walls 200 about an 8.0 x 4.0 axis rectangle, a partition 100 at x = 6000. The plate to the outer faces
  // is 8.2 x 4.2 = 34.44 m²; the walls: the ring 34.44 - 7.8 x 3.8 = 4.80 and the partition 0.1 x 3.8 = 0.38: 5.18 m²;
  // the rooms 5.85 x 3.8 = 22.23 and 1.85 x 3.8 = 7.03: 29.26 m²; 29.26 + 5.18 = 34.44
  const M = surfModel(TWO);
  const bed = SURF_R4(100, 100, 5950, 3900), wc = SURF_R4(6050, 100, 7900, 3900);
  const p = floorPlate(M, { 'PHÒNG NGỦ': bed, WC: wc });
  assert.ok(p.exact && near(p.rooms, 29.26e6, 1) && near(p.walls, 5.18e6, 1) && near(p.plate, 34.44e6, 1) && p.void === 0 && p.overlap === 0, JSON.stringify(p));
  // a room left out: 7.03 m² enclosed with no room; an outline drawn to the axis of the partition: 0.05 x 3.8 = 0.19 m²
  // of it lies over the wall
  assert.ok(near(floorPlate(M, { 'PHÒNG NGỦ': bed }).void, 7.03e6, 1));
  assert.ok(near(floorPlate(M, { 'PHÒNG NGỦ': SURF_R4(100, 100, 6000, 3900), WC: wc }).overlap, 0.19e6, 1));
  // walls off the axes: a quadrilateral of 200 walls, its plate about the axis area 41.5 m² + 0.1 x the perimeter 26.15 m
  // (within 1 %)
  const skew = floorPlate(surfModel({ walls: [{ points: [[0, 0], [8000, 0], [8000, 5000], [1000, 6000]], closed: true, thickness: 200 }] }), {});
  assert.ok(!skew.exact && near(skew.plate / 1e6, 41.5 + 2.615, 0.45), JSON.stringify(skew));
  // in the checks of the bill: the plate, each room's perimeter and skirting, the door D2 (700 x 2400 = 1.68 m²) off its
  // two faces, one in each room
  const rooms = { 'PHÒNG NGỦ': bed, WC: wc };
  const floors = (r) => [{ name: 'TẦNG 1', spec: TWO, height: 3600, rooms: r, finishes: surfFinishes(r, 3600) }];
  const Q = finishQuantities({ floors: floors(rooms), spec: TWO });
  const plate = Q.checks.find((c) => c.id === 'plate');
  assert.ok(plate.ok && near(plate.lhs, 34.44, 1e-6) && near(plate.rhs, 34.44, 1e-6), JSON.stringify(plate));
  const d2 = Q.checks.find((c) => c.id === 'openings');
  assert.ok(d2.ok && d2.lhs === 1.68 && d2.rhs === 1.68 && d2.faces.length === 2 && d2.faces[0] !== d2.faces[1], JSON.stringify(d2));
  assert.equal(Q.checks.filter((c) => c.id === 'perimeter' && c.ok).length, 2);
  assert.ok(Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  // the WC left out: the plate check fails by its 7.03 m²
  const lost = finishQuantities({ floors: floors({ 'PHÒNG NGỦ': bed }), spec: TWO }).checks.find((c) => c.id === 'plate');
  assert.ok(!lost.ok && near(lost.rhs - lost.lhs, 7.03, 1e-6), JSON.stringify(lost));
});

// ---- the surface model, second part: what the first left out
import { plateOutlines as surfOutlines, storeyStructure as surfStorey } from '../src/surfaces.mjs';

test('surfaces: the floor under the doors (half the wall each side), the waterproofing up the walls only, not across a door', () => {
  // TWO: a bedroom 5.85 x 3.8 and a WC 1.85 x 3.8 either side of a 100 partition with the door D2 700 wide
  const rooms = { 'PHÒNG NGỦ': SURF_R4(100, 100, 5950, 3900), WC: SURF_R4(6050, 100, 7900, 3900) };
  const finishes = surfFinishes(rooms, 3600);
  const S = floorSurfaces({ spec: TWO, rooms, finishes, floor: 'T1' });
  const of = (room, kind) => S.faces.find((f) => f.room === room && f.kind === kind);
  // the floor of each room runs on under the door to the middle of the wall: 0.70 x 0.05 = 0.035 m² each side
  const bed = of('PHÒNG NGỦ', 'floor'), wc = of('WC', 'floor');
  assert.ok(near(bed.gross, 22.23, 1e-9) && near(bed.measured, 22.265, 1e-9) && near(wc.measured, 7.03 + 0.035, 1e-9), `${bed.measured} ${wc.measured}`);
  assert.equal(bed.how, '22,23 (theo đường bao) + ngưỡng D2 0,70 x 0,05');
  // the strip in plan (for whoever redraws it): from the face of the room to the axis of the partition, the door wide
  const strip = bed.additions[0].poly, xs = strip.map((q) => Math.round(q[0])), ys = strip.map((q) => Math.round(q[1]));
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [5950, 6000, 650, 1350]);
  // the skirting stops at the door as before: 19.3 - 0.7
  assert.ok(near(S.faces.filter((f) => f.room === 'PHÒNG NGỦ' && f.kind === 'skirting').reduce((a, f) => a + f.measured, 0), 18.6, 1e-9));
  // the waterproofing of the WC: its floor 7.03, up the walls 300 along the perimeter less the door (11.30 - 0.70) x
  // 0.30 = 3.18, and under the door 0.035: 10.245 m² (it was 7.03 + 11.30 x 0.30 = 10.42 with the door counted as wall)
  const wp = of('WC', 'waterproof');
  assert.ok(near(wp.measured, 7.03 + 10.6 * 0.3 + 0.035, 1e-9), wp.how);
  assert.equal(wp.how, '7,03 (theo đường bao) + quét lên tường 300 (chu vi 11,30 - cửa 0,70) 10,60 x 0,30 + ngưỡng D2 0,70 x 0,05');
  // the bill, the schedule and the checks: the strips counted from the rooms = from the door, side by side (2 x 0.035)
  const Q = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: TWO, height: 3600, rooms, finishes }], spec: TWO });
  const q = (key) => Q.rows.find((r) => r.key === key).q;
  assert.ok(q('floor|FL-01') === 22.265 && q('floor|FL-02') === 7.065 && q('water|WET') === 10.245, JSON.stringify(Q.rows.filter((r) => !r.head).map((r) => [r.key, r.q])));
  const th = Q.checks.find((c) => c.id === 'thresholds'), up = Q.checks.find((c) => c.id === 'upturn');
  assert.ok(th.ok && near(th.lhs, 0.07, 1e-9) && near(th.rhs, 0.07, 1e-9) && up.ok && near(up.lhs, 11.3, 1e-9), JSON.stringify([th, up]));
  assert.ok(Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  const ms = materialSchedule({ spec: TWO, rooms, finishes });
  assert.ok(near(ms.rows.find((r) => r.code === 'FL-01').qty, 22.265, 0.0051) && near(ms.rows.find((r) => r.code === 'FL-02').qty, 7.065, 0.0051));
  // the workbook: the upturn and the strip as their arithmetic
  const xml = finishWorkbook(Q, ['TẦNG 1']).toString('utf8');
  assert.ok(xml.includes('<f>(11.3-0.7)*0.3+0.7*0.05</f>') && xml.includes('<f>0.7*0.05</f>'));
  // a door to the outside (SURF_BOX: D2 800 in a 200 wall): the inner half only, one side in the check
  const box = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: SURF_BOX, height: 3300, rooms: SURF_ROOMS, finishes: surfFinishes(SURF_ROOMS, 3300) }], spec: SURF_BOX });
  const one = box.checks.find((c) => c.id === 'thresholds');
  assert.ok(one.ok && near(one.lhs, 0.08, 1e-9) && one.note === '1 phía cửa', JSON.stringify(one));
  // a balcony 5.0 x 1.2 with a sliding door D5 1600 wide onto it: its floor 6 + 1.6 x 0.1 (the outer half of the wall
  // under the door); waterproofing 6 + (12.4 - 1.6) x 0.3 + 0.16 = 9.40
  const BALC = {
    walls: [{ id: 'W', points: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]], closed: true, thickness: 200 }], heights: { top: 3300 },
    openings: [{ wall: 'W', segment: 0, at: [2500, 0], width: 1600, type: 'door', tag: 'D5' }], balconies: [{ region: [[0, -1300], [5000, -100]] }],
  };
  const B = floorSurfaces({ spec: BALC, rooms: {}, finishes: {} });
  const bal = (kind) => B.faces.find((f) => f.balcony === 0 && f.kind === kind);
  assert.ok(near(bal('floor').measured, 6.16, 1e-9) && near(bal('waterproof').measured, 9.4, 1e-9), `${bal('floor').how} | ${bal('waterproof').how}`);
});

test('surfaces: with no suspended ceiling the wall finish goes up to the slab soffit; along a stairwell open above, the full storey', () => {
  // a drying yard (no ceiling, exterior paint) in the box of SURF_BOX, storey 3300
  const rooms = { 'SÂN PHƠI': SURF_R4(0, 0, 5000, 4000) }, finishes = surfFinishes(rooms, 3300);
  const heights = (o) => floorSurfaces({ spec: SURF_BOX, rooms, finishes, ...o }).faces.filter((f) => f.kind === 'wall').map((f) => f.H);
  // the last floor, under the sky: the height of its walls
  assert.deepEqual(heights({}), [3.3, 3.3, 3.3, 3.3]);
  // a floor with a floor above it: up to the soffit of that slab, 3.30 - 0.12 (the default slab), or as given
  const under = floorSurfaces({ spec: SURF_BOX, rooms, finishes, top: false });
  const wall = under.faces.filter((f) => f.kind === 'wall');
  assert.ok(wall.every((f) => near(f.H, 3.18, 1e-9) && f.hnote === 'cao đến đáy sàn 3,30 - 0,12'), JSON.stringify(wall.map((f) => [f.H, f.hnote])));
  assert.equal(wall[0].how, '5,00 x 3,18 - 0,80 x 2,40 (D2) + má cửa D2 5,60 x 0,075 [cao đến đáy sàn 3,30 - 0,12]');
  assert.ok(heights({ top: false, slab: 150 }).every((h) => near(h, 3.15, 1e-9)));
  // a plan whose roofs are an empty list is a floor of a building with a floor above (floorsOf): the same, with no top
  assert.ok(floorSurfaces({ spec: { ...SURF_BOX, roofs: [] }, rooms, finishes }).faces.filter((f) => f.kind === 'wall').every((f) => near(f.H, 3.18, 1e-9)));
  // with the structure: the soffit it gives
  assert.ok(heights({ top: false, structure: { soffit: 3050 } }).every((h) => near(h, 3.05, 1e-9)));
  // a room with a ceiling is finished to its ceiling as before, whatever is above
  const bed = floorSurfaces({ spec: SURF_BOX, rooms: SURF_ROOMS, finishes: surfFinishes(SURF_ROOMS, 3300), top: false });
  assert.ok(bed.faces.filter((f) => f.kind === 'wall').every((f) => near(f.H, 2.65, 1e-9) && f.hnote === undefined));
  // a stair room 2.40 x 6.00 whose stairwell takes the first 4.00 m, storey 3200, a floor above: the wall at the foot
  // of the well runs the full storey (the well is open through the slab), the two long walls go to the soffit 3.08
  // and run on through the slab along the well (4.00 x 0.12 more), the far wall to the soffit
  const WELL6 = { walls: [{ id: 'T', points: [[-100, -100], [2500, -100], [2500, 6100], [-100, 6100]], closed: true, thickness: 200 }], heights: { top: 3200 }, stairs: [SURF_STAIR] };
  const sr = { 'CẦU THANG': SURF_R4(0, 0, 2400, 6000) }, sf = surfFinishes(sr, 3200);
  const st = floorSurfaces({ spec: WELL6, rooms: sr, finishes: sf, top: false }).faces.filter((f) => f.kind === 'wall');
  assert.deepEqual(st.map((f) => [f.L, f.H]), [[2.4, 3.2], [6, 3.08], [2.4, 3.08], [6, 3.08]]);
  assert.ok(st[0].hnote === 'ô thang thông tầng, cao tầng 3,20' && near(st[1].additions[0].area, 4 * 0.12, 1e-9) && st[2].additions.length === 0, JSON.stringify(st.map((f) => f.how)));
  assert.equal(st[1].how, '6,00 x 3,08 + qua chiều dày sàn tại ô thang 4,00 x 0,12 [cao đến đáy sàn 3,20 - 0,12]');
  assert.ok(near(st.reduce((a, f) => a + f.measured, 0), 16.8 * 3.08 + 10.4 * 0.12, 1e-9));
  // the same stair room on the last floor (a roof slab on the walls): the storey height all round
  const last = floorSurfaces({ spec: WELL6, rooms: sr, finishes: sf }).faces.filter((f) => f.kind === 'wall');
  assert.ok(last.every((f) => near(f.H, 3.2, 1e-9)) && last[2].hnote === 'cao đến đáy mái 3,20');
  // the bill and the schedule agree floor by floor (a ground floor under a slab, the yard on the last floor)
  const two = { floors: [{ ...SURF_BOX, heights: undefined, height: 3300 }, { height: 3300 }] };
  const F = floorsOf(two);
  const Q = finishQuantities({ floors: F.map((f) => ({ name: f.name, spec: f.spec, height: f.height, rooms, finishes })), spec: two });
  const paint = Q.rows.find((r) => r.key === 'paint|OUT');
  assert.ok(Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  const inner = (name) => Q.faces.filter((f) => f.floor === name && f.kind === 'wall').map((f) => f.H);
  assert.ok(inner('TẦNG 1').every((h) => near(h, 3.18, 1e-9)) && inner('TẦNG 2').every((h) => near(h, 3.3, 1e-9)) && paint.q > 0);
});

test('surfaces: a straight flight takes its footprint off the floor of the room it stands in, the skirting steps along it', () => {
  // a living room 5.0 x 6.0, storey 3000; a flight 1.20 wide against the left wall, 14 treads of 250 from y = 1000
  const LIV = {
    walls: [{ id: 'W', points: [[-100, -100], [5100, -100], [5100, 6100], [-100, 6100]], closed: true, thickness: 200 }], heights: { top: 3000 },
    stairs: [{ start: [600, 1000], direction: 90, width: 1200, treads: 14, going: 250 }],
  };
  const rooms = { 'PHÒNG KHÁCH': SURF_R4(0, 0, 5000, 6000) }, finishes = surfFinishes(rooms, 3000);
  const S = floorSurfaces({ spec: LIV, rooms, finishes });
  const floor = S.faces.find((f) => f.kind === 'floor');
  // the floor: 30 m² less the footprint of the flight 1.20 x 3.50 (whatever the rule set: it is not a small opening)
  assert.ok(near(floor.measured, 30 - 4.2, 1e-9) && floor.deductions[0].always && floor.how === '30,00 (theo đường bao) - 4,20 (chân thang)', floor.how);
  assert.deepEqual(floor.deductions[0].poly.map((q) => q.map(Math.round)), [[0, 1000], [1200, 1000], [1200, 4500], [0, 4500]]);
  // the skirting of the room stops along the flight (22 - 3.5 m); there it steps with the treads: 14 x 0.25 + 15 x 0.2
  const sum = (kind) => S.faces.filter((f) => f.kind === kind).reduce((a, f) => a + f.measured, 0);
  assert.ok(near(sum('skirting'), 18.5, 1e-9) && near(sum('stair_skirting'), 6.5, 1e-9) && near(sum('tread'), 4.2, 1e-9) && near(sum('riser'), 3.6, 1e-9));
  const Q = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: LIV, height: 3000, rooms, finishes }], spec: LIV });
  assert.ok(Q.rows.find((r) => r.key === 'floor|FL-01').q === 25.8 && Q.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
});

test('surfaces: with the structure: the sides of a beam under a painted soffit, the faces of columns in the wall finish', () => {
  // a store 6.0 x 4.0 with no ceiling under a 120 slab (soffit +3.180). A beam D1 200 x 400 crosses it at x = 3000, a
  // beam D2 runs over the south wall. Columns: C2 300 deep in the west wall (50 into the room, 220 wide), C2 220 x 300
  // free under D1, C1 in the north-east corner (60 into each wall line), C1 in the west wall 10 into the room (flush)
  const KHO = { walls: [{ id: 'W', points: [[-100, -100], [6100, -100], [6100, 4100], [-100, 4100]], closed: true, thickness: 200 }], heights: { top: 3300 }, roofs: [], rooms: [{ name: 'KHO', at: [3000, 2000] }] };
  const rooms = { KHO: SURF_R4(0, 0, 6000, 4000) }, finishes = { KHO: resolveFinish('KHO', { ceiling: null }, [], 3300) };
  const structure = {
    soffit: 3180, slab: 120,
    beams: [{ name: 'D1', A: [3000, -100], B: [3000, 4100], b: 200, h: 400 }, { name: 'D2', A: [-100, -100], B: [6100, -100], b: 200, h: 400 }],
    columns: [{ name: '1-A', mark: 'C2', box: [-250, 1890, 50, 2110] }, { name: '2-A', mark: 'C2', box: [2890, 1850, 3110, 2150] }, { name: '3-B', mark: 'C1', box: [5940, 3940, 6160, 4160] },
      { name: '1-B', mark: 'C1', box: [-210, 900, 10, 1120] }],
  };
  const S = floorSurfaces({ spec: KHO, rooms, finishes, floor: 'T1', structure });
  // the soffit: the plan 24 m² and the two sides of D1 below the slab, 0.28 deep, over its 4.00 m in the room less the
  // 0.30 of the column under it: 2 x 3.70 x 0.28 = 2.072; D2 over the wall shows no side
  const sof = S.faces.find((f) => f.kind === 'soffit');
  assert.ok(near(sof.measured, 24 + 2.072, 1e-9) && sof.additions.length === 1 && sof.how.includes('thành dầm D1 2 x 3,70 x 0,28'), sof.how);
  // the columns: 2 x 0.05 x 3.18 for the one in the wall, the girth 1.04 x 3.18 of the free one; the corner column only
  // moves the corner in (no face), the flush one is under the plaster
  const col = S.faces.filter((f) => f.kind === 'column');
  assert.deepEqual(col.map((f) => [f.n, Math.round(f.L * 1e6) / 1e6, f.H, f.code]), [[2, 0.05, 3.18, 'WL-01'], [1, 1.04, 3.18, 'WL-01']]);
  assert.ok(col[0].how === 'cột nhô khỏi tường C2 (1-A): 2 x 0,05 x 3,18' && col[1].how === 'cột giữa phòng C2 (2-A): 1,04 x 3,18', JSON.stringify(col.map((f) => f.how)));
  // their footprints on the floor (and the soffit): small openings, off the geometric net only (0.011 + 0.066 + 0.0036)
  const floor = S.faces.find((f) => f.kind === 'floor');
  assert.ok(floor.measured === 24 && near(floor.net, 24 - 0.0806, 1e-9) && floor.deductions.length === 3 && floor.deductions.every((d) => d.poly.length === 4 && !d.off), floor.how);
  // the bill with and without the structure; the schedule takes the column faces as well
  const fl = [{ name: 'T1', spec: KHO, height: 3300, rooms, finishes }];
  const Q = finishQuantities({ floors: fl, spec: KHO, structure }), Q0 = finishQuantities({ floors: fl, spec: KHO });
  const row = (X, key) => X.rows.find((r) => r.key === key);
  assert.ok(row(Q, 'paint|PUT').q === 67.225 && row(Q, 'paint|SLAB').q === 26.072 && row(Q, 'paint|SLAB').geo === 25.991 && row(Q, 'floor|FL-01').geo === 23.919, JSON.stringify(Q.rows.filter((r) => !r.head).map((r) => [r.key, r.q, r.geo])));
  assert.ok(row(Q0, 'paint|PUT').q === 63.6 && row(Q0, 'paint|SLAB').q === 24 && row(Q0, 'floor|FL-01').geo === 24);
  assert.ok(Q.warnings.length === 0 && Q0.warnings.length === 1 && /structural_calc/.test(Q0.warnings[0]), JSON.stringify(Q0.warnings));
  assert.ok(Q.checks.every((c) => c.ok) && Q0.checks.every((c) => c.ok), JSON.stringify(Q.checks.filter((c) => !c.ok)));
  assert.ok(near(materialSchedule({ spec: KHO, rooms, finishes, structure }).rows.find((r) => r.code === 'WL-01').qty, 67.23, 1e-9));
  assert.ok(finishWorkbook(Q, ['T1']).toString('utf8').includes('<f>2*3.7*0.28</f>'));
  // from a calculation result: the storey by its name or its place, the soffit under a floor slab (storey - slab) and
  // under the roof slab that sits on the walls of the last floor (the storey)
  const R = structuralCalc({ spec: TOWN });
  const g = surfStorey(R, { floor: 'TẦNG 1' }), t = surfStorey(R, { index: 2 });
  assert.ok(g.soffit === 3600 - g.slab && g.beams.length > 0 && g.columns.length > 0 && g.beams.every((b) => b.h > g.slab) && t.soffit === 2800, JSON.stringify([g.soffit, g.slab, t.soffit]));
  assert.equal(surfStorey(null), null);
});

test('surfaces: for whoever measures the faces again: the floor models, the plate outlines, the shapes of the deductions', () => {
  // the bill returns the surface model of every floor
  const rooms = { 'PHÒNG NGỦ': SURF_R4(100, 100, 5950, 3900), WC: SURF_R4(6050, 100, 7900, 3900) };
  const Q = finishQuantities({ floors: [{ name: 'TẦNG 1', spec: TWO, height: 3600, rooms, finishes: surfFinishes(rooms, 3600) }], spec: TWO });
  assert.ok(Q.floors.length === 1 && Q.floors[0].name === 'TẦNG 1' && Q.floors[0].rooms === rooms && Q.floors[0].S.faces.every((f) => Q.faces.includes(f)) && Q.floors[0].S.M.walls.length === 2);
  // the outlines the plate counts: the four walls of the ring run on into their corners and the partition, the rooms
  const O = surfOutlines(surfModel(TWO), rooms);
  assert.ok(O.walls.length === 5 && O.columns.length === 0 && O.rooms.length === 2 && O.walls.every((w) => w.length === 4));
  const xs = O.walls.flat().map((q) => q[0]), ys = O.walls.flat().map((q) => q[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-100, 8100, -100, 4100]);
  // a deduction with a shape carries it: the stairwell on the floor of its room (plan mm), an opening on its wall face
  // (u from the left end of the face, z above the floor, with its w and h, in m)
  const sr = { 'CẦU THANG': SURF_R4(0, 0, 2400, 4000) };
  const well = floorSurfaces({ spec: SURF_WELL, rooms: sr, finishes: surfFinishes(sr, 3200) });
  assert.equal(well.faces.find((f) => f.kind === 'landing' && f.outline), undefined, 'the whole room is the stairwell: no floor face');
  const lobby = { 'CẦU THANG': SURF_R4(0, 0, 2400, 6000) };
  const W6 = { walls: [{ id: 'T', points: [[-100, -100], [2500, -100], [2500, 6100], [-100, 6100]], closed: true, thickness: 200 }], heights: { top: 3200 }, stairs: [SURF_STAIR] };
  const land = floorSurfaces({ spec: W6, rooms: lobby, finishes: surfFinishes(lobby, 3200) }).faces.find((f) => f.kind === 'landing' && f.outline);
  assert.ok(near(land.measured, 14.4 - 9.6, 1e-9));
  assert.deepEqual(land.deductions[0].poly.map((q) => q.map(Math.round)), [[0, 0], [2400, 0], [2400, 4000], [0, 4000]]);
  const wall = floorSurfaces({ spec: SURF_BOX, rooms: SURF_ROOMS, finishes: surfFinishes(SURF_ROOMS, 3300) }).faces.filter((f) => f.kind === 'wall');
  const d = (k) => wall[k].deductions[0];
  assert.ok(near(d(0).u, 3.6, 1e-9) && d(0).z === 0 && d(0).w === 0.8 && d(0).h === 2.4, JSON.stringify(d(0)));
  assert.ok(d(1).z === 2 && near(d(1).u, 1.8, 1e-9) && d(2).z === 0.9 && near(d(2).u, 1.9, 1e-9), JSON.stringify([d(1), d(2)]));
  // the kitchen splashback on its wall: 300 from the left end of the face, above the base units
  const kr = { 'BẾP': SURF_R4(0, 0, 4000, 3000) };
  const items = resolveItems([{ type: 'kitchen_base', room: 'BẾP', wall: 'A', width: 2400, offset: 300 }, { type: 'kitchen_wall', room: 'BẾP', wall: 'A', width: 2400, offset: 300 }], kr).items;
  const kit = floorSurfaces({ spec: null, rooms: kr, finishes: { 'BẾP': resolveFinish('BẾP') }, items });
  const sp = kit.faces.filter((f) => f.kind === 'wall').flatMap((f) => f.deductions).find((x) => x.always);
  assert.ok(sp && near(sp.u, 0.3, 1e-9) && near(sp.z, items[0].h / 1000, 1e-9) && near(sp.w, 2.4, 1e-9) && near(sp.h, (items[1].opts.z0 - items[0].h) / 1000, 1e-9), JSON.stringify(sp));
});

// a small house for the electrical and plumbing sets: living room in front, WC and kitchen at the back, two floors
const MEP_WALLS = [
  { id: 'W1', points: [[100, 100], [5900, 100], [5900, 8900], [100, 8900]], closed: true, thickness: 200 },
  { id: 'I1', points: [[100, 6000], [5900, 6000]], thickness: 100 }, { id: 'I2', points: [[2500, 6000], [2500, 8900]], thickness: 100 },
];
const MEP_HOUSE = {
  floors: [
    { walls: MEP_WALLS, openings: [{ wall: 'W1', segment: 0, at: [3000, 100], width: 1200, type: 'double_door', toward: [3000, 1000] },
      { wall: 'I1', at: [4000, 6000], width: 900, type: 'door', toward: [4000, 7000] }, { wall: 'I2', at: [2500, 7500], width: 700, type: 'door', toward: [3200, 7500] }],
    rooms: [{ name: 'PHÒNG KHÁCH', at: [3000, 3000] }, { name: 'BẾP', at: [4200, 7500] }, { name: 'WC', at: [1300, 7500] }] },
    { openings: [{ wall: 'I1', at: [4000, 6000], width: 900, type: 'door', toward: [4000, 5000] }, { wall: 'I2', at: [2500, 7500], width: 700, type: 'door', toward: [1800, 7500] }],
      rooms: [{ name: 'PHÒNG NGỦ', at: [3000, 3000] }, { name: 'SẢNH', at: [4200, 7500] }, { name: 'WC', at: [1300, 7500] }] },
  ],
};
const MEP_ROOMS = [
  { 'PHÒNG KHÁCH': [[200, 200], [5800, 200], [5800, 5950], [200, 5950]], 'BẾP': [[2550, 6050], [5800, 6050], [5800, 8800], [2550, 8800]], WC: [[200, 6050], [2450, 6050], [2450, 8800], [200, 8800]] },
  { 'PHÒNG NGỦ': [[200, 200], [5800, 200], [5800, 5950], [200, 5950]], 'SẢNH': [[2550, 6050], [5800, 6050], [5800, 8800], [2550, 8800]], WC: [[200, 6050], [2450, 6050], [2450, 8800], [200, 8800]] },
];
test('old drawings: TCVN3 texts read, titles and floors, papers and scales of frames, the map of a sheet', async () => {
  const { decodeTcvn3, looksTcvn3 } = await import('../src/vnfont.mjs');
  assert.equal(decodeTcvn3('MÆt b»ng tÇng 1'), 'Mặt bằng tầng 1');
  assert.equal(decodeTcvn3('Phßng kh¸ch - n\u00ADíc - ®iÖn - Tû lÖ'), 'Phòng khách - nước - điện - Tỷ lệ');
  assert.equal(decodeTcvn3('mÆt c¾t a-a %%c12', true), 'MẶT CẮT A-A %%c12');
  assert.ok(looksTcvn3('MÆt b»ng') && !looksTcvn3('MẶT BẰNG') && !looksTcvn3('PHÒNG KHÁCH') && !looksTcvn3('PLAN'));
  const { decodeVni, legacyEncoding, decodeLegacy } = await import('../src/vnfont.mjs');
  assert.equal(decodeVni('MAËT BAÈNG CAÀU THANG TAÀNG 1 LEÂN TAÀNG MAÙI'), 'MẶT BẰNG CẦU THANG TẦNG 1 LÊN TẦNG MÁI');
  assert.equal(decodeVni('Tröôøng Ñaïi hoïc - ñòa chæ - Baùc só - Vieät Nam'), 'Trường Đại học - địa chỉ - Bác sĩ - Việt Nam');
  assert.deepEqual(['MAËT BAÈNG', 'MÆt b»ng', 'MẶT BẰNG', 'PHÒNG KHÁCH', 'PLAN'].map(legacyEncoding), ['vni', 'tcvn3', null, null, null]);
  // Unicode Vietnamese with Latin-1 letters only is not legacy
  assert.deepEqual(['PHÒNG', 'LÊN', 'CÔNG TRÌNH:', 'Ghi chú thêm', 'TOÀ NHÀ', 'Giá'].map(legacyEncoding), [null, null, null, null, null, null]);
  // a diameter sign or a lap length in a note, Chinese beside it: not a legacy font
  assert.deepEqual(['1x2石頭 Ø6@100鋼筋', '40Þ', 'Ø12a200', 'Phßng', '®iÖn'].map(legacyEncoding), [null, null, null, 'tcvn3', 'tcvn3']);
  assert.equal(decodeLegacy('DANH MUÏC BAÛN VEÕ KIEÁN TRUÙC'), 'DANH MỤC BẢN VẼ KIẾN TRÚC');
  const { titleOf, floorOf, scaleOf, paperOf, describeDrawing } = await import('../src/describe.mjs');
  assert.deepEqual([titleOf('MÆt b»ng tÇng 2').kind, titleOf('MÆt b»ng tÇng 2').floor], ['plan', '2']);
  assert.deepEqual([titleOf('MAËT CAÉT A-A').kind, titleOf('MAËT CAÉT A-A').title, titleOf('MAËT CAÉT A-A').legacy], ['section', 'MẶT CẮT A-A', 'vni']);
  assert.equal(titleOf('MẶT BẰNG MÁI').kind, 'roof');
  assert.equal(titleOf('2. MẶT CẮT A-A').kind, 'section');
  assert.equal(titleOf('SECOND FLOOR PLAN').kind, 'plan');
  assert.equal(titleOf('一層平面圖').kind, 'plan');
  assert.equal(titleOf('XEM CHI TIẾT 3'), null);
  assert.equal(titleOf('PHÒNG NGỦ 1'), null);
  assert.deepEqual([floorOf('MẶT BẰNG TẦNG TRỆT'), floorOf('3RD FLOOR PLAN'), floorOf('MẶT BẰNG TẦNG 2-5')], ['TRỆT', '3', '2-5']);
  assert.deepEqual([scaleOf('TỶ LỆ 1/100'), scaleOf('SCALE 1:50'), scaleOf('1/20'), scaleOf('TẦNG 1')], [100, 50, 20, null]);
  assert.deepEqual(paperOf(42000, 29700), { paper: 'A3', scale: 100 });
  assert.deepEqual(paperOf(59400, 84100), { paper: 'A1', scale: 100 });
  assert.equal(paperOf(10000, 1000), null);
  // a model-space A3 frame at 1:100 (and its inner border) with two plans side by side, a section above, a title block
  const T = (x, y, h, s, tag) => [x, y, h, s, 'TEXT', 0, ...(tag ? [tag] : [])];
  const map = {
    drawing: 'x.dwg', extents: [0, 0, 42000, 29700],
    rects: [[0, 0, 42000, 29700, 'KHUNG'], [1000, 500, 41500, 29200, 'KHUNG'], [2000, 2000, 2400, 2700, 'COT']],
    inserts: [{ name: 'TB', box: [30000, 500, 41500, 5000], attributes: { TEN_BV: 'MẶT BẰNG TẦNG 1, 2', SO_BV: 'KT-02' }, handle: '2A' }],
    texts: [
      T(5000, 3000, 500, 'MẶT BẰNG TẦNG 1'), T(5000, 2300, 300, 'TỶ LỆ 1/100'),
      T(20000, 3000, 500, 'MẶT BẰNG TẦNG 2'), T(20000, 2300, 300, 'TỶ LỆ 1/100'),
      T(8000, 16000, 500, 'MẶT CẮT A-A'), T(8000, 15300, 300, 'TL 1/50'),
      ...Array.from({ length: 20 }, (_, i) => T(3000 + i * 1000, 8000, 250, 'PHÒNG NGỦ')),
      T(35000, 2000, 400, 'MẶT BẰNG TẦNG 1, 2', 'TEN_BV'), T(40000, 1000, 700, 'KT-02', 'SO_BV'),
      T(60000, 3000, 500, 'MẶT ĐỨNG TRỤC 1-5'),
    ],
  };
  const D = describeDrawing(map, [{ name: 'A1-01', paper: 'ISO_A1', viewports: [{ paper_center: [420, 297], scale: 1, window: [[-100, 0], [940, 594]] }, { scale: 100, window: [[59000, 0], [80000, 15000]] }], title_blocks: [{ block: 'TB', attributes: { DRAWING_NO: 'KT-05' } }], texts: ['MẶT ĐỨNG'] }]);
  assert.equal(D.sheets.length, 2, JSON.stringify(D.sheets));
  const f = D.sheets[0];
  assert.deepEqual([f.source, f.paper, f.scale, f.number], ['model frame', 'A3', 100, 'KT-02']);
  assert.equal(f.title_block?.number, 'KT-02');
  assert.equal(f.title, 'MẶT BẰNG TẦNG 1, 2');
  assert.deepEqual(f.views.map((v) => [v.kind, v.floor ?? null, v.scale]), [['plan', '1', 100], ['plan', '2', 100], ['section', null, 50]]);
  // the two plans split the band at the midpoint of their titles; the section owns the band above
  const [p1, p2, sA] = f.views;
  assert.ok(p1.window[1][0] === 12500 && p2.window[0][0] === 12500 && p1.window[1][1] === sA.window[0][1], JSON.stringify(f.views));
  assert.ok(p1.window[0][1] < 3000 && sA.window[1][1] === 29700);
  const l = D.sheets[1];
  assert.deepEqual([l.source, l.number, l.viewports.length, l.viewports[0].views[0].kind], ['layout', 'KT-05', 1, 'elevation']);
  assert.deepEqual(D.views_outside_sheets, []);

  // a frame drawn as four lines; its sheet name in the title block strip; an empty print boundary is not a sheet
  const { rectsFromLines } = await import('../src/describe.mjs');
  const L4 = [[0, 0, 46800, 0, 'K'], [46800, 0, 46800, 29700, 'K'], [46800, 29700, 0, 29700, 'K'], [0, 29700, 0, 0, 'K'], [5000, 5000, 9000, 5000, 'X']];
  assert.deepEqual(rectsFromLines(L4).map((r) => r.slice(0, 4)), [[0, 0, 46800, 29700]]);
  const map2 = {
    rects: [[100000, 0, 142000, 29700, 'IN']],
    lines: L4,
    texts: [
      T(8000, 3000, 500, 'MẶT BẰNG TẦNG 1'), T(8000, 2300, 300, 'TỶ LỆ 1/100'), T(44000, 9000, 450, 'MẶT BẰNG TẦNG 1'),
      ...Array.from({ length: 10 }, (_, i) => T(3000 + i * 1000, 8000, 250, 'PHÒNG')),
      ...Array.from({ length: 3 }, (_, i) => T(101000 + i * 1000, 8000, 250, 'GHI')),
    ],
  };
  const D2 = describeDrawing(map2);
  assert.equal(D2.sheets.length, 1, JSON.stringify(D2.sheets));
  assert.deepEqual([D2.sheets[0].paper, D2.sheets[0].scale, D2.sheets[0].title, D2.sheets[0].views.length], ['A3 extended', 100, 'MẶT BẰNG TẦNG 1', 1]);
  assert.equal(D2.frames_without_content, 1);

  // a style whose texts read as VNI is a VNI style whatever its font; a Unicode style is not
  const { legacyStyles, fitWindows } = await import('../src/describe.mjs');
  const S = (s, style) => [0, 0, 250, s, 'T', 0, null, style];
  const LS = legacyStyles({ texts: [S('MAËT BAÈNG', 'SHX1'), S('TAÀNG 1', 'SHX1'), S('MAËT CAÉT A-A', 'SHX1'), S('PHÒNG', 'U'), S('MẶT BẰNG', 'U'), S('LÊN', 'U'), S('KHO', 'U'), S('Phßng', 'V3'), S('Kh¸ch', 'V3')] });
  assert.deepEqual(LS, { SHX1: 'vni' });
  // a view window fitted to what is drawn in it, with a margin; left as the band when nothing is there
  const V = [{ window: [[0, 0], [20000, 15000]] }, { window: [[20000, 0], [40000, 15000]] }];
  fitWindows(V, [{ box: [2000, 1500, 12000, 11500], count: 40 }, null]);
  assert.deepEqual([V[0].window, V[0].window_from, V[1].window_from], [[[1800, 1300], [12200, 11700]], 'drawing', 'titles']);
  // a title in Vietnamese with its Chinese beside it is one view, and its window is the whole sheet, not half of it
  const D3 = describeDrawing({
    rects: [[0, 0, 42000, 29700, 'K']],
    texts: [T(5000, 3000, 500, 'MẶT BẰNG TẦNG 1'), T(10500, 3000, 500, '一樓平面圖'), ...Array.from({ length: 12 }, (_, i) => T(3000 + i * 1500, 9000, 250, 'PHÒNG'))],
  });
  const v3 = D3.sheets[0].views;
  assert.equal(v3.length, 1, JSON.stringify(v3));
  assert.deepEqual([v3[0].title, v3[0].window], ['MẶT BẰNG TẦNG 1 / 一樓平面圖', [[0, 0], [42000, 29700]]]);
});

test('compare and stretch: every line vertex by vertex, a clipped box', async () => {
  const { regionsOfDiff, clipBox } = await import('../src/revision.mjs');
  // a 6 m wall face whose end moved 300: the cloud is at the end, not along the face
  const line = (x1) => ({ b: [0, 0, x1, 0], t: 'LINE', l: 'A-WALL', p: [0, 0, x1, 0] });
  const R = regionsOfDiff({ same: 40, removed: [line(6000)], added: [line(6300)] }, { scale: 100, fine: true });
  assert.equal(R.length, 1);
  assert.ok(R[0][0] >= 5900 && R[0][2] <= 6400, JSON.stringify(R));
  assert.deepEqual(clipBox([0, 0, 100, 100], [50, 50, 200, 200]), [50, 50, 100, 100]);
  // the wall hatch moved inside its loops: clouded along the band that moved, not around the whole floor
  const hatch = (y) => ({ b: [0, 0, 5000, 18000], t: 'HATCH', l: 'A-WALL-PATT', q: [[0, 0, 5000, 0, 5000, 18000, 0, 18000], [200, y, 4800, y, 4800, y + 100, 200, y + 100]] });
  const H = regionsOfDiff({ same: 40, removed: [hatch(15450)], added: [hatch(15750)] }, { scale: 100, fine: true });
  assert.equal(H.length, 1);
  assert.ok(H[0][1] >= 15400 && H[0][3] <= 15900 && H[0][2] - H[0][0] > 4000, JSON.stringify(H));
  // an open polyline whose two ends moved: no box from its last vertex back to its first
  const open = (d) => ({ b: [0, 0, 20000, 100], t: 'LWPOLYLINE', l: 'A', p: [0 + d, 0, 10000, 0, 10000, 100, 20000 + d, 100] });
  const O = regionsOfDiff({ same: 40, removed: [open(0)], added: [open(50)] }, { scale: 100, fine: true });
  assert.ok(O.every((b) => b[2] - b[0] < 1000), JSON.stringify(O));
  // a dimension that changed: at its text
  const Dm = regionsOfDiff({ same: 40, removed: [{ b: [0, 0, 100, 4000], t: 'DIMENSION', l: 'D', tp: [50, 2000] }], added: [{ b: [0, 0, 100, 4300], t: 'DIMENSION', l: 'D', tp: [50, 2150] }] }, { scale: 100, fine: true });
  assert.ok(Dm.length === 1 && Dm[0][3] - Dm[0][1] < 500, JSON.stringify(Dm));
  assert.equal(clipBox([0, 0, 10, 10], [50, 50, 60, 60]), null);
});

test('reviewing old drawings: dimensions written over, area texts, texts by language, the register of a folder', async () => {
  const { numbersIn, checkDims, checkAreas, textLanguage, listTexts, registerRows, toCsv, REGISTER_COLUMNS } = await import('../src/review.mjs');
  assert.ok(numbersIn('4.000').includes(4000) && numbersIn('4,000').includes(4000) && numbersIn('3,5').includes(3.5));
  assert.ok(numbersIn('2x1200').includes(2400) && numbersIn('%%c600').includes(600) && numbersIn('{\\fArial|b0;4300}').includes(4300));
  const D = checkDims([
    { h: 'A', text: '4000', m: 4300, dec: 0, lfac: 1, kind: 'linear' },          // written over with the old value
    { h: 'B', text: '4000', m: 3999.6, dec: 0, lfac: 1, kind: 'linear' },        // drafting not exact: fine
    { h: 'C', text: 'R=500', m: 450, dec: 0, lfac: 1, kind: 'radius' },
    { h: 'D', text: '3600 (CỬA)', m: 3000, dec: 0, lfac: 1, kind: 'linear' },
    { h: 'E', text: 'VAR', m: 1234, dec: 0, lfac: 1, kind: 'linear' },
    { h: 'F', text: '1200', m: 24, dec: 0, lfac: 50, kind: 'linear' },           // a detail scaled with its linear factor
    { h: 'G', text: '4.000', m: 4000, dec: 0, lfac: 1, kind: 'linear' },
  ], 0.001);
  assert.deepEqual(D.mismatch.map((x) => [x.handle, x.fixed, x.measured]), [['A', '<>', 4300], ['C', 'R=<>', 450], ['D', '<> (CỬA)', 3000]]);
  assert.deepEqual(D.words.map((x) => x.handle), ['E']);
  assert.deepEqual(D.ok, ['B', 'F', 'G']);
  const A = checkAreas([
    { h: '1', text: 'WC\n5,06 m²', area_m2: 4.39 },
    { h: '2', text: 'BẾP + ĂN 19,78 m2', area_m2: 19.78 },
    { h: '3', text: 'S = 12.5', area_m2: 96.0 },                                 // only the building around it: no outline
    { h: '4', text: 'DT: 18,4m2', area_m2: 18.43 },
  ]);
  assert.deepEqual(A.mismatch.map((x) => [x.handle, x.fixed]), [['1', 'WC\n4,39 m²']]);
  assert.deepEqual([A.ok, A.none.map((x) => x.handle)], [['2', '4'], ['3']]);
  assert.deepEqual(['一樓平面圖', 'PHÒNG KHÁCH', 'LIVING ROOM', '1/100'].map(textLanguage), ['zh', 'vi', 'en', 'other']);
  const L = listTexts([['1', 'text', 'WC', 'A', 'S', 'model', 0, 0, 250], ['2', 'text', 'WC', 'A', 'S', 'model', 0, 0, 250], ['3', 'attribute TEN', '廁所', 'B', 'S', 'model', 0, 0, 250]], { language: null });
  assert.deepEqual(L.map((x) => [x.text, x.count, x.language, x.kinds]), [['WC', 2, 'en', ['text']], ['廁所', 1, 'zh', ['attribute']]]);
  assert.equal(listTexts([['3', 'text', '廁所', 'B', 'S', 'model', 0, 0, 250], ['4', 'text', 'WC', 'B', 'S', 'model', 0, 0, 250]], { language: 'zh', unique: false }).length, 1);
  const R = registerRows([
    { file: 'KT.dwg', map: { sheets: [{ source: 'layout', layout: 'KT-01', number: 'KT-01', title: 'MẶT BẰNG', paper: 'A3', viewports: [{ views: [{ kind: 'plan', title: 'MẶT BẰNG TẦNG 1', scale: 100 }] }] }], views_outside_sheets: [] } },
    { file: 'bad.dwg', error: 'eDwgNeedsRecovery' },
  ]);
  assert.deepEqual(R.map((r) => [r.file, r.source, r.number, r.scale, r.views]), [['KT.dwg', 'layout', 'KT-01', '1/100', 'MẶT BẰNG TẦNG 1'], ['bad.dwg', 'error', undefined, undefined, undefined]]);
  const csv = toCsv(R, REGISTER_COLUMNS);
  assert.ok(csv.startsWith('\uFEFF') && csv.includes('MẶT BẰNG TẦNG 1') && csv.split('\r\n').length === 4);
});

const mepFloorsOf = () => floorsOf(MEP_HOUSE).map((f, i) => {
  const rooms = MEP_ROOMS[i];
  const items = resolveItems(defaultFixtures(rooms, f.spec, []).items, rooms).items;
  return { name: f.name, level: f.level, height: f.height, spec: f.spec, rooms, items };
});

test('revision clouds: regions merged, a cloud of outward arcs, the delta and its number; revisions in the title strip', async () => {
  const { clusterBoxes, cloudEntities, regionsOfDiff } = await import('../src/revision.mjs');
  // two changes 500 apart merge at a 1000 gap, a far one stays apart; too many regions merge further
  assert.equal(clusterBoxes([[0, 0, 100, 100], [600, 0, 700, 100], [9000, 9000, 9100, 9100]], 1000).length, 2);
  assert.equal(clusterBoxes(Array.from({ length: 30 }, (_, i) => [i * 5000, 0, i * 5000 + 10, 10]), 100, 6).length <= 6, true);
  const E = cloudEntities([0, 0, 4000, 2000], { no: 2, note: 'Dời tường WC', scale: 100 });
  const cloud = E[0];
  assert.equal(cloud.type, 'polyline');
  assert.ok(cloud.closed && cloud.points.length === cloud.bulges.length && cloud.bulges.every((b) => b > 0));
  // grown by 3 mm on paper (300 at 1:100), about 8 mm arcs (800)
  const xs = cloud.points.map((p) => p[0]), ys = cloud.points.map((p) => p[1]);
  assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], [-300, -300, 4300, 2300]);
  assert.ok(cloud.points.length >= 14 && cloud.points.length <= 20);
  assert.ok(E.some((e) => e.type === 'text' && e.text === '2') && E.some((e) => e.type === 'text' && e.text === 'Dời tường WC'));
  assert.ok(E.every((e) => e.layer === 'A-ANNO-REVS'));
  assert.equal(regionsOfDiff({ removed: [[0, 0, 10, 10]], added: [[50, 0, 60, 10], [90000, 0, 90010, 10]] }, { scale: 100 }).length, 2);
  assert.deepEqual(regionsOfDiff({ removed: [], added: [] }), []);
  // a view with nothing as it was: one cloud around what it is now
  assert.deepEqual(regionsOfDiff({ same: 0, removed: [[0, 0, 10, 10]], added: [[0, 0, 100, 50], [0, 60, 100, 120]] }), [[0, 0, 100, 120]]);
  // the outline of all the walls of a floor changed at one corner: only that corner is clouded
  const outline = (y) => ({ b: [0, 0, 5000, 18000], t: 'LWPOLYLINE', l: 'A-WALL', p: [0, 0, 5000, 0, 5000, 18000, 0, 18000, 0, y, 2500, y] });
  const R = regionsOfDiff({ removed: [outline(15800)], added: [outline(15500), { b: [3000, 15400, 3400, 15600], t: 'TEXT', l: 'A-ANNO-ROOM' }] }, { scale: 100 });
  assert.equal(R.length, 1);
  assert.ok(R[0][1] >= 15000 && R[0][3] <= 16000 && R[0][0] >= 0 && R[0][2] <= 3500, JSON.stringify(R));
  // the revisions of a sheet are attributes of its title strip
  const tb = titleBlock({ paper: 'A2', orientation: 'landscape', info: { revisions: [{ no: 1, text: 'Phát hành lần đầu', date: '01/11/2026' }, { no: 2, text: 'Dời tường WC tầng 1', date: '13/11/2026' }] } });
  const ins = tb.entities[0];
  assert.equal(ins.attributes.REV2, 'Dời tường WC tầng 1');
  assert.equal(ins.attributes.REV2_DATE, '13/11/2026');
  assert.equal(ins.attributes.REV3, '');
  assert.ok(ins.def.attributes.some((a) => a.tag === 'REV4'));
});

test('views: the id of a view, a free id, what is kept with it, the view an update replaces, a view that outgrew the old one', async () => {
  const V = await import('../src/views.mjs');
  // the tool and what names the view; arguments that only say how it is drawn do not change the id
  assert.equal(V.viewId('draw_roof_plan', { scale: 100, fall: 2 }), 'draw_roof_plan');
  assert.equal(V.viewId('draw_structure_plan', { floor: 2, scale: 100, plan: { walls: [] } }), 'draw_structure_plan:floor=2');
  assert.equal(V.viewId('draw_interior_elevation', { floor: 2, room: 'PHÒNG NGỦ 1', walls: ['A', 'B'], scale: 20 }), 'draw_interior_elevation:floor=2,room=PHÒNG NGỦ 1,walls=A+B');
  assert.equal(V.viewId('draw_section', { mark: 'A' }), V.viewId('draw_section', { mark: 'A', scale: 50, update: true }));
  assert.notEqual(V.viewId('draw_section', { mark: 'A' }), V.viewId('draw_section', { mark: 'B' }));
  // an object is not a name (the item of a joinery detail may be one); a long id is cut with a hash: 180 characters at most
  assert.equal(V.viewId('draw_joinery_detail', { kind: 'kitchen', item: { code: 'JN-01' } }), 'draw_joinery_detail:kind=kitchen');
  const long = V.viewId('draw_interior_elevation', { room: 'X'.repeat(400) });
  assert.ok(long.length <= 180 && long !== V.viewId('draw_interior_elevation', { room: 'X'.repeat(401) }));
  // a view drawn again without update is a view of its own
  assert.equal(V.freeId('draw_section:mark=A', []), 'draw_section:mark=A');
  assert.equal(V.freeId('draw_section:mark=A', ['draw_section:mark=A', 'draw_section:mark=A#2']), 'draw_section:mark=A#3');
  // kept with the view: its arguments without the plan and the run (a null is a value: none); the building of draw_plan
  // is kept once, as the plan
  assert.deepEqual(V.keptArgs('draw_ceiling_plan', { floor: 2, mode: 'lighting', plan: { walls: [] }, update: true, at: [0, 0], spacing: 1200, legend: undefined, wall: null }), { floor: 2, mode: 'lighting', spacing: 1200, wall: null });
  assert.deepEqual(V.keptArgs('draw_plan', { walls: [1], floors: [2], dimensions: ['bottom'], scale: 100, update: true }), { dimensions: ['bottom'], scale: 100 });
  assert.deepEqual(V.keptPlan({ walls: [1], scale: 100, update: true, dry_run: false, north: null }), { walls: [1], scale: 100 });
  assert.equal(V.hashOf('a').length, 12);
  assert.notEqual(V.hashOf('a'), V.hashOf('b'));
  // what the bridge lists, as views: a record that is not JSON is skipped, entities and extent come from what is alive
  const meta = (o) => JSON.stringify(o);
  const known = V.parseViews({
    views: [
      { key: 'V_1', meta: meta({ id: 'draw_section:mark=A', tool: 'draw_section', key: 'draw_section:mark=A', spots: [[10, 20]], plan: 'p1', args: { mark: 'A' }, time: '2026-11-13T01:00:00Z' }) },
      { key: 'V_2', meta: meta({ id: 'draw_section:mark=A#2', tool: 'draw_section', key: 'draw_section:mark=A', spots: [[90, 20]], plan: 'p2', time: '2026-11-13T02:00:00Z' }) },
      { key: 'V_3', meta: meta({ id: 'draw_roof_plan', tool: 'draw_roof_plan', key: 'draw_roof_plan', time: '2026-11-13T03:00:00Z' }) },
      { key: 'V_4', meta: 'not json' },
    ],
    live: { 'draw_section:mark=A': { entities: 40, bounds: { min: [0, 0], max: [10, 10] } }, 'draw_section:mark=A#2': { entities: 42, bounds: null }, 'stray': { entities: 1 } },
    values: { plan_hash: 'p2' },
  });
  assert.equal(known.views.length, 3);
  assert.equal(known.planHash, 'p2');
  assert.deepEqual(known.ids.sort(), ['draw_roof_plan', 'draw_section:mark=A', 'draw_section:mark=A#2', 'stray']);
  assert.equal(known.views[0].entities, 40);
  assert.equal(known.views[2].entities, 0);
  // an update replaces the newest live view of the tool with the same key; one named by its id; never one of another tool
  assert.equal(V.viewToReplace(known.views, 'draw_section', 'draw_section:mark=A', true).id, 'draw_section:mark=A#2');
  assert.equal(V.viewToReplace(known.views, 'draw_section', 'draw_section:mark=A', 'draw_section:mark=A').id, 'draw_section:mark=A');
  assert.equal(V.viewToReplace(known.views, 'draw_section', 'draw_section:mark=B', true), null);
  assert.equal(V.viewToReplace(known.views, 'draw_roof_plan', 'draw_roof_plan', true), null); // its entities are gone
  assert.throws(() => V.viewToReplace(known.views, 'draw_section', 'x', 'nothing'), /no view/);
  assert.throws(() => V.viewToReplace(known.views, 'draw_roof_plan', 'x', 'draw_section:mark=A'), /drawn by draw_section/);
  // bounds joined; a view outgrew the old one when it reaches past it by more than a hundredth of its diagonal
  const B = (x0, y0, x1, y1) => ({ min: [x0, y0], max: [x1, y1] });
  assert.deepEqual(V.joinBounds(B(0, 0, 10, 10), B(5, -5, 20, 8)), B(0, -5, 20, 10));
  assert.deepEqual(V.joinBounds(null, B(0, 0, 1, 1)), B(0, 0, 1, 1));
  assert.equal(V.outgrew(B(0, 0, 1000, 1000), B(0, 0, 1000, 1000)), false);
  assert.equal(V.outgrew(B(0, 0, 1010, 1000), B(0, 0, 1000, 1000)), false);
  assert.equal(V.outgrew(B(0, 0, 1300, 1000), B(0, 0, 1000, 1000)), true);
  assert.equal(V.outgrew(B(100, 100, 900, 900), B(0, 0, 1000, 1000)), false);
  assert.equal(V.outgrew(B(0, 0, 1, 1), null), false);
  // every view tool is a registered kind of drawing tool; free drawing is not a view
  assert.ok(V.VIEW_TOOLS.has('draw_plan') && V.VIEW_TOOLS.has('material_schedule') && !V.VIEW_TOOLS.has('draw_entities'));
});

test('measurement rules: the sets, the thresholds, a company set over the default, rounding as a spreadsheet does', async () => {
  const { DEFAULT_RULES, measured, net, roundQ, ruleSet, RULE_SETS } = await import('../src/rules.mjs');
  assert.equal(DEFAULT_RULES, 'PL6');
  assert.equal(ruleSet(), RULE_SETS.PL6);
  assert.equal(ruleSet('net'), RULE_SETS.NET);
  assert.throws(() => ruleSet('XYZ'), /unknown rule set/);
  // Phụ lục VI: 0,25 m² for masonry and finishes, 1 m² for formwork, 0,1 m³ for concrete; slab > beam > wall > column
  assert.deepEqual(RULE_SETS.PL6.void, { finish: 0.25, masonry: 0.25, formwork: 1, concrete: 0.1 });
  assert.deepEqual(RULE_SETS.PL6.junction, ['slab', 'beam', 'wall', 'column']);
  // a company set: one threshold changed, the rest of the base kept
  const own = ruleSet({ base: 'PL6', void: { finish: 0.5 } });
  assert.equal(own.void.finish, 0.5);
  assert.equal(own.void.formwork, 1);
  assert.equal(own.decimals, 3);
  // a wall of 10 m² with a door of 1,92 m², a vent of 0,2 m² and reveals of 0,3 m²
  const ded = [{ area: 1.92 }, { area: 0.2 }], add = [{ area: 0.3 }];
  assert.ok(near(net(10, ded, add), 8.18));
  assert.ok(near(measured(10, ded, add, 0.25), 8.38)); // the vent is under the threshold: not taken off
  assert.ok(near(measured(10, ded, add, 0), 8.18)); // the geometric set takes everything off
  assert.ok(near(measured(10, [{ area: 0.25 }], [], 0.25), 9.75)); // at the threshold: taken off
  assert.equal(measured(1, [{ area: 2 }], [], 0), 0); // never negative
  assert.ok(near(measured(5, [{ volume: 0.05 }, { volume: 0.2 }], [], 0.1, 'volume'), 4.8));
  // 16,6275 as a sum of binary fractions sits a hair under the half: a spreadsheet shows 16,628
  assert.equal(roundQ(16.6275), 16.628);
  assert.equal(roundQ(1.0005), 1.001);
  assert.equal(roundQ(2.34549), 2.345);
  assert.equal(roundQ(7), 7);
});

test('layers of drawings by others: the purpose read from names in Vietnamese, English, Chinese and AIA codes, pens, blocks', async () => {
  const { layerRole, blockRole, nameParts } = await import('../src/layers.mjs');
  const role = (n) => layerRole(n).role;
  // accents or not, any case, separators, the prefix of a bound xref dropped
  assert.equal(nameParts('Plan-xref$0$A-Wall').base, 'A-Wall');
  assert.equal(nameParts('Tường xây 200').norm, 'tuong xay 200');
  for (const [n, r] of [['Tường', 'wall'], ['TUONG', 'wall'], ['A-Wall', 'wall'], ['Plan-xref$0$A-Wall', 'wall'], ['墙体', 'wall'],
    ['Kích thước', 'dims'], ['KICHTHUOC', 'dims'], ['A- Dimension', 'dims'], ['_Dim', 'dims'], ['DIM', 'dims'],
    ['Cửa sổ', 'window'], ['CUASO', 'window'], ['A-Glaz', 'window'], ['Cửa đi', 'door'], ['A-Door', 'door'], ['KHCUA', 'symbol'], ['A-Door-Iden', 'symbol'],
    ['Ghi chú', 'note'], ['GHICHU', 'note'], ['TEXT', 'text'], ['A-Text-VN', 'text'], ['S-25Text-VN', 'text'],
    ['TRUC', 'grid'], ['A-Grid', 'grid'], ['Cột', 'column'], ['A-Cols', 'column'], ['Dầm', 'beam'], ['THEP', 'rebar'], ['THEP_CHU', 'rebar'], ['DAI', 'stirrup'],
    ['HACHT', 'hatch'], ['A-Hatch', 'hatch'], ['khungten00', 'title'], ['KHUNGTEN', 'title'], ['Nội thất', 'furniture'], ['A-Eqpm-Fixd', 'fixture'],
    ['Khuất', 'hidden'], ['A-Detl-Wide', 'detail_cut'], ['A-Detl-Thin', 'detail'], ['修正 範圍', 'revision'], ['A-Revs', 'revision'], ['Cây xanh', 'landscape'],
    ['A-Road-Curb', 'site'], ['ZL_BuLon', 'steel'], ['MONG', 'concrete'], ['G-Viewport', 'viewport'], ['A-Hral', 'railing'], ['Thang máy', 'equipment']]) {
    assert.equal(role(n), r, `${n} -> ${role(n)} (expected ${r})`);
  }
  // names after a pen: no purpose, a weight; layer 0; Defpoints, xref layers and "not plotted" are kept
  for (const n of ['0.3', '0.09', 'T0.13', 'manh', 'Nét mảnh', 'NET-THAY', 'netcat', 'medium', '02', '6 LINE']) assert.equal(layerRole(n).by, 'weight', n);
  assert.equal(layerRole('net cat').thick, true);
  assert.equal(layerRole('Nét mảnh').thick, false);
  assert.equal(layerRole('0.35').thick, true);
  assert.equal(layerRole('0').by, 'zero');
  assert.equal(layerRole('Defpoints').by, 'keep');
  assert.equal(layerRole('PLAN|A-WALL').by, 'keep');
  assert.equal(layerRole('G-Anno-Nplt').by, 'keep');
  assert.equal(layerRole('MAU').by, null);
  // blocks by name, then by what they hold; copied anonymous names say nothing
  for (const [n, r] of [['TRUC A', 'grid_tag'], ['Grid mark', 'grid_tag'], ['CAOTRINH1', 'symbol'], ['Level mark - Plan', 'symbol'], ['Door mark', 'symbol'], ['KHUNGTEN', 'title'],
    ['A1_TitleFrame -ARC', 'title'], ['D1', 'door'], ['AW5', 'window'], ['MBCUASO', 'window'], ['Toilet', 'fixture'], ['pheu thu', 'fixture'], ['sofa 3', 'furniture'],
    ['SCREW20', 'steel'], ['_ArchTick', 'dims'], ['COT', 'column'], ['thangmay', 'equipment']]) assert.equal(blockRole(n), r, `${n} -> ${blockRole(n)}`);
  assert.equal(blockRole('A$C206177D3'), null);
  assert.equal(blockRole('SADASAS', { attributes: true, count: 60 }), 'title');
  assert.equal(blockRole('SADASAS', { attributes: true, count: 4 }), 'symbol');
});

test('layers of drawings by others: the plot style table read, the plan of a drawing (rename, merge, split, keep, purge, look)', async () => {
  const { parseCtb, planLayers, planCsv, readMappingCsv, readStandardCsv } = await import('../src/layers.mjs');
  const zlib = await import('node:zlib');
  // a .ctb: header, then zlib text; lineweight index 0 is "use object lineweight"
  const body = 'description="\naci_table_available=TRUE\nplot_style{\n 0{\n  name="Color_1\n  lineweight=13\n }\n 1{\n  name="Color_2\n  lineweight=0\n }\n 6{\n  name="Color_7\n  lineweight=6\n }\n}\ncustom_lineweight_table{\n 0=0.0\n 6=0.18\n 13=0.5\n}\n';
  const head = Buffer.alloc(60, 0x20);
  head.write('PIAFILEVERSION_2.0,CTBVER1,compress\r\npmzlibcodec');
  const ctb = parseCtb(Buffer.concat([head, zlib.deflateSync(Buffer.from(body, 'latin1'))]), 'office.ctb');
  assert.equal(ctb.pens[1], 0.5);
  assert.equal(ctb.pens[2], null);
  assert.equal(ctb.pens[7], 0.18);
  assert.throws(() => parseCtb(Buffer.from('not a ctb')), /not a plot style/);

  const L = (name, extra = {}) => ({ name, color: 7, linetype: 'Continuous', lineweight: 'default', ...extra });
  const G = (space, layer, type, count, extra = {}) => ({ space, layer, type, color: 'bylayer', linetype: 'ByLayer', lineweight: 'bylayer', count, ...extra });
  const survey = {
    drawing: 'D:/Du an/KT-nha pho.dwg',
    layers: [L('0', { current: true }), L('Defpoints', { plot: false }), L('TUONG', { lineweight: 0.5 }), L('Kich thuoc', { color: 2 }), L('net manh', { lineweight: 0.09 }), L('TEXT'), L('Cây xanh'), L('Trống')],
    groups: [
      G('model', '0', 'LINE', 10, { color: 3 }), G('model', 'TUONG', 'LINE', 20), G('model', 'TUONG', 'HATCH', 5), G('block', 'TUONG', 'LINE', 3),
      G('model', 'Kich thuoc', 'DIMENSION', 7, { color: 1 }), G('model', 'Kich thuoc', 'TEXT', 2), G('model', 'net manh', 'LINE', 4),
      G('model', 'TEXT', 'MTEXT', 6), G('model', 'TEXT', 'INSERT', 3, { block: 'TRUC A' }), G('paper', 'Defpoints', 'VIEWPORT', 1), G('model', 'Defpoints', 'LINE', 2),
      G('block', '0', 'LINE', 50), G('model', 'Cây xanh', 'CIRCLE', 9),
    ],
    blocks: [{ name: 'TRUC A', count: 3, refs: 3 }], plot: { color_dependent: true, layouts: [] },
  };
  const P = planLayers(survey, { keepLook: false });
  assert.equal(P.discipline, 'arch'); // KT in the file name
  const of = (n) => P.layers.find((l) => l.layer === n);
  assert.deepEqual(of('TUONG').targets, { 'A-WALL': 23, 'A-WALL-PATT': 5 });
  assert.equal(of('TUONG').action, 'split');
  assert.deepEqual(of('Kich thuoc').targets, { 'A-ANNO-DIMS': 9 });
  assert.equal(of('0').targets['A-DETL'], 10);
  assert.equal(of('0').kept, 50); // layer 0 inside blocks stays
  assert.deepEqual(of('TEXT').targets, { 'A-ANNO-TEXT': 6, 'S-GRID-IDEN': 3 }); // a grid bubble on a text layer
  assert.equal(of('Defpoints').kept, 2);
  assert.equal(of('Defpoints').targets['A-ANNO-VPRT'], 1);
  // a whole layer to a layer the drawing does not have: renamed (no override to clear); the rest moved by rules
  assert.ok(P.renames.some((r) => r.from === 'Cây xanh' && r.to === 'L-PLNT' && r.props.color === 3));
  assert.ok(P.rules.some((r) => r.from === 'Kich thuoc' && r.to === 'A-ANNO-DIMS'));
  assert.ok(P.rules.some((r) => r.from === 'TUONG' && r.type === 'HATCH' && r.to === 'A-WALL-PATT'));
  assert.ok(P.rules.some((r) => r.from === '0' && r.color === 3 && r.set?.color === 'bylayer'));
  assert.ok(!P.rules.some((r) => r.from === '0' && r.space === 'block'));
  // emptied layers and the empty one go; 0, Defpoints and the targets stay
  for (const n of ['TUONG', 'Kich thuoc', 'TEXT', 'Trống']) assert.ok(P.delete.includes(n), n);
  // "net manh" holds only linework of no purpose: it becomes the detail layer itself (renamed), layer 0's lines join it
  assert.ok(P.renames.some((r) => r.from === 'net manh' && r.to === 'A-DETL'));
  assert.ok(!P.delete.includes('net manh'));
  for (const n of ['0', 'Defpoints', 'Cây xanh']) assert.ok(!P.delete.includes(n), n);
  assert.ok(P.create.some((c) => c.name === 'A-WALL' && c.lineweight === 0.5));
  assert.equal(P.current, null); // layer 0 is current and stays
  const Q = planLayers({ ...survey, layers: survey.layers.map((l) => ({ ...l, current: l.name === 'TEXT' })) });
  assert.equal(Q.current, 'A-ANNO-TEXT'); // the current layer purged: the one most of its entities went to
  assert.equal(P.summary.overrides_after, 0);
  // with the look kept: the fine pen of "net manh" (0.09) stays where the standard would plot it thin (0.25)
  const K = planLayers(survey); // the look kept by default
  assert.ok(K.rules.some((r) => r.from === 'net manh' && r.set?.lineweight === 0.09));
  assert.ok(K.summary.overrides_after >= 4);
  // the user's word: a layer kept, a layer sent elsewhere; a structural drawing by its name
  const U = planLayers(survey, { keepLook: false, mapping: { 'net manh': 'keep', TEXT: 'GHI-CHU' } });
  assert.equal(U.layers.find((l) => l.layer === 'net manh').action, 'keep');
  assert.deepEqual(U.layers.find((l) => l.layer === 'TEXT').targets, { 'GHI-CHU': 9 });
  const S = planLayers({ ...survey, drawing: 'D:/KC-mong.dwg' }, { keepLook: false });
  assert.equal(S.discipline, 'struct');
  assert.deepEqual(S.layers.find((l) => l.layer === 'Kich thuoc').targets, { 'S-ANNO-DIMS': 9 });
  // a company standard takes the roles it names
  const C = planLayers(survey, { keepLook: false, standard: readStandardCsv('name;color;linetype;lineweight;plot;role\nCT-TUONG;7;Continuous;0.4;1;wall\nCT-KT;1;Continuous;0.13;1;dims\n') });
  assert.deepEqual(C.layers.find((l) => l.layer === 'Kich thuoc').targets, { 'CT-KT': 9 });
  assert.equal(C.layers.find((l) => l.layer === 'TUONG').targets['CT-TUONG'], 23);
  // the CSV for Excel and back: the column "to" filled where the user disagrees
  const csv = planCsv(P);
  assert.ok(csv.startsWith('\uFEFF') && csv.includes('TUONG') && csv.split('\r\n')[0].endsWith(';to'));
  const edited = csv.replace(/^(TUONG;.*);\r$/m, '$1;CT-TUONG\r').replace(/^(TUONG;[^\r]*);$/m, '$1;CT-TUONG');
  assert.deepEqual(readMappingCsv(edited), { TUONG: 'CT-TUONG' });
  assert.throws(() => readMappingCsv('a;b\n1;2'), /layer.*to/);
});

test('read a plan drawn by others: walls from face pairs, openings by swing, glazing or block, grids with bubbles, rooms', async () => {
  const { readPlan, planAreas } = await import('../src/readplan.mjs');
  // two rooms 4000 + 3000 wide, 5000 deep, outer walls 200 (axes on 0 / 7000 / 0 / 5000), a 100 partition at x 4000
  const layers = ['TUONG', 'CUA', 'TRUC', 'TEXT', 'KICH THUOC'];
  const lines = [];
  const L = (x1, y1, x2, y2, li = 0, ti = 0, h = `h${lines.length}`) => lines.push([x1, y1, x2, y2, li, ti, h]);
  // outer faces (-100 / 7100, -100 / 5100) and inner faces (100 / 6900, 100 / 4900); the front wall (y 0) has a door
  // gap 1500..2400 (900) and a window gap 5000..6200 (1200)
  L(-100, -100, 1500, -100); L(2400, -100, 5000, -100); L(6200, -100, 7100, -100);
  L(100, 100, 1500, 100); L(2400, 100, 3950, 100); L(4050, 100, 5000, 100); L(6200, 100, 6900, 100);
  L(-100, 5100, 7100, 5100); L(100, 4900, 3950, 4900); L(4050, 4900, 6900, 4900);
  L(-100, -100, -100, 5100); L(100, 100, 100, 4900); L(7100, -100, 7100, 5100); L(6900, 100, 6900, 4900);
  L(3950, 100, 3950, 4900); L(4050, 100, 4050, 4900);
  // window glazing in the gap, along the wall; dimension lines that must not count
  L(5000, -30, 6200, -30, 1); L(5000, 30, 6200, 30, 1);
  L(-100, -1500, 7100, -1500, 4); L(-100, -1600, 7100, -1600, 4);
  // grids: centre lines 1 / 2 / 3 and A / B with their bubbles
  for (const [x, lab] of [[0, '1'], [4000, '2'], [7000, '3']]) L(x, -2500, x, 6500, 2, 1);
  for (const [y, lab] of [[0, 'A'], [5000, 'B']]) L(-2500, y, 8500, y, 2, 1);
  const circles = [[0, -3000, 400, 2, 'c1'], [4000, -3000, 400, 2, 'c2'], [7000, -3000, 400, 2, 'c3'], [-3000, 0, 400, 2, 'c4'], [-3000, 5000, 400, 2, 'c5']];
  const texts = [[0, -3000, 350, '1', 3, 't1'], [4000, -3000, 350, '2', 3, 't2'], [7000, -3000, 350, '3', 3, 't3'], [-3000, 0, 350, 'A', 3, 't4'], [-3000, 5000, 350, 'B', 3, 't5'],
    [2000, 2500, 300, 'PHÒNG KHÁCH', 3, 't6'], [5500, 2500, 300, 'Phòng ngủ', 3, 't7'], [1950, -700, 250, 'D1', 3, 't8'], [5600, -700, 250, 'S1', 3, 't9'], [2000, 2000, 250, '20.5 m2', 3, 't10']];
  // the door swing: hinged at x 1500, radius 900, into the room
  const arcs = [[1500, 0, 900, 0, 90, 1, 'a1']];
  const g = { units: 'mm', layers, linetypes: ['Continuous', 'CENTER'], lines, polys: [], arcs, circles, texts, inserts: [], hatches: [] };
  const r = readPlan(g);
  const W = r.spec.walls;
  assert.ok(W.every((w) => [100, 200].includes(w.thickness)), JSON.stringify(W));
  const along = (y) => W.filter((w) => w.points[0][1] === y && w.points[1][1] === y);
  assert.ok(along(0).length >= 1 && along(5000).length >= 1, JSON.stringify(W));
  // the partition reaches the axes of the walls it meets
  const part = W.find((w) => w.points[0][0] === 4000 && w.points[1][0] === 4000);
  assert.ok(part && part.thickness === 100 && Math.min(part.points[0][1], part.points[1][1]) === 0 && Math.max(part.points[0][1], part.points[1][1]) === 5000, JSON.stringify(part));
  // the corners meet on the axes
  assert.ok(W.some((w) => w.points.some((p) => p[0] === 0 && p[1] === 0)));
  assert.ok(W.some((w) => w.points.some((p) => p[0] === 7000 && p[1] === 5000)));
  const door = r.spec.openings.find((o) => o.type === 'door');
  assert.deepEqual([door.at, door.width, door.tag], [[1950, 0], 900, 'D1']);
  assert.ok(door.toward[1] > 0); // it swings into the room
  const win = r.spec.openings.find((o) => o.type === 'window');
  assert.deepEqual([win.at, win.width, win.tag], [[5600, 0], 1200, 'S1']);
  assert.equal(r.spec.openings.length, 2);
  assert.deepEqual(r.spec.grids.x, [{ at: 0, label: '1' }, { at: 4000, label: '2' }, { at: 7000, label: '3' }]);
  assert.deepEqual(r.spec.grids.y, [{ at: 0, label: 'A' }, { at: 5000, label: 'B' }]);
  assert.deepEqual(r.spec.rooms.map((x) => x.name).sort(), ['PHÒNG KHÁCH', 'PHÒNG NGỦ']);
  assert.ok(r.used.includes('a1') && r.used.includes('t8'));
  // the plan sits in one area of the model space, found and ranked with its door and room names
  const areas = planAreas(g);
  assert.equal(areas.length, 1);
  assert.ok(areas[0].doors >= 1 && areas[0].room_names === 2 && areas[0].window[0][0] <= -100);
  // beyond face pairs: a curtain wall (two glass lines 50 apart), a door drawn as a leaf line, a stair of equal treads
  // with LÊN at its foot, a level, a wall drawn as one wide polyline
  const g2 = JSON.parse(JSON.stringify(g));
  g2.layers.push('A-GLAZ', 'A-FLOR-STRS', 'TUONG DAY');
  const gl = g2.layers.indexOf('A-GLAZ'), sl = g2.layers.indexOf('A-FLOR-STRS'), wl = g2.layers.indexOf('TUONG DAY');
  g2.lines.push([-100, 8000, 7000, 8000, gl, 0, 'g1'], [-100, 8050, 7000, 8050, gl, 0, 'g2']);
  for (let i = 0; i <= 8; i++) g2.lines.push([9000, 1000 + i * 270, 10200, 1000 + i * 270, sl, 0, `s${i}`]);
  g2.texts.push([9600, 700, 250, 'LÊN', 3, 'up'], [3000, 3500, 250, '+0.000', 3, 'lv']);
  g2.polys.push([wl, 0, 0, 0, [12000, 0, 12000, 4000], 'wp', 220]);
  const r2 = readPlan(g2);
  const cw = r2.spec.walls.find((w) => w.material === 'none');
  assert.ok(cw && cw.thickness === 50 && r2.spec.openings.some((o) => o.wall === cw.id && o.type === 'window' && o.width > 7000), JSON.stringify(cw));
  assert.deepEqual(r2.spec.stairs, [{ start: [9600, 1000], direction: 90, width: 1200, treads: 8, going: 270 }]);
  assert.deepEqual(r2.spec.levels, [{ at: [3000, 3500], value: '+0.000' }]);
  assert.ok(r2.spec.walls.some((w) => w.thickness === 220 && w.points[0][0] === 12000));
  assert.equal(r2.found.glazed_walls, 1);
  // a window that misses the plan reads nothing
  assert.equal(readPlan(g, { window: [[20000, 20000], [30000, 30000]] }).spec.walls.length, 0);
});

test('electrical set: boards, switches by the doors, sockets, air conditioners, circuits, breakers and cables', () => {
  const floors = mepFloorsOf();
  // lights by the ceiling rules of the interior set
  for (const f of floors) {
    const finishes = Object.fromEntries(Object.keys(f.rooms).map((n) => [n, resolveFinish(n, {}, [], f.height)]));
    f.lights = ceilingPlan({ rooms: f.rooms, finishes, items: f.items, mode: 'lighting', scale: 100 }).entities
      .filter((e) => e.type === 'block' && /^MCP_DEN_/.test(e.name)).map((e) => ({ kind: e.name === 'MCP_DEN_DOWNLIGHT' ? 'downlight' : 'ceiling_lamp', at: e.at }));
  }
  const D = electricalDesign({ floors });
  assert.deepEqual(D.boards.map((b) => b.id), ['TĐ-1', 'TĐ-2']);
  const F1 = D.floors[0];
  assert.ok(F1.board.main && F1.board.meter && F1.board.network, 'main board, meter and data cabinet on the ground floor');
  assert.ok(F1.board.meter.at[1] < 100, 'the meter outside the front wall');
  // every light has a switch; the WC switch is outside the WC
  for (const F of D.floors) for (const d of F.devices.filter((x) => ['downlight', 'ceiling_lamp', 'fan'].includes(x.kind))) assert.ok(d.switch, `${F.name} ${d.kind} has a switch`);
  const wcFan = F1.devices.find((d) => d.kind === 'fan' && d.room === 'WC');
  assert.ok(wcFan && wcFan.switch.room !== 'WC', 'WC switch outside the WC');
  // air conditioner of the living room: 32 m² x 600 BTU -> 24000
  const ac = F1.devices.find((d) => d.kind === 'ac' && d.room === 'PHÒNG KHÁCH');
  assert.equal(ac.btu, 24000);
  assert.ok(F1.devices.some((d) => d.kind === 'hob') && F1.devices.filter((d) => d.kind === 'counter').length === 3, 'kitchen outlets');
  const B1 = D.boards[0];
  for (const C of B1.circuits) {
    if (C.kind === 'light') assert.ok(C.devices.filter((d) => !d.kind.startsWith('switch')).length <= 10);
    if (C.kind === 'socket') assert.ok(C.devices.length <= 8 && C.breaker.startsWith('RCBO'));
  }
  assert.equal(B1.circuits.find((c) => c.kind === 'hob').cable, '2x4+E4');
  assert.ok(D.main.rating >= 63 && /^Cu\/XLPE\/PVC 2x16/.test(D.main.cable), D.main.cable);
  const plan = electricalPlan(D, 0, { mode: 'power', legendAt: [8000, 9000] });
  assert.ok(plan.entities.some((e) => e.name === 'MCP_E_DH') && plan.entities.some((e) => e.type === 'polyline' && e.layer === 'E-POWR-WIRE'));
  assert.ok(electricalPlan(D, 1, { mode: 'lighting' }).entities.some((e) => /^MCP_E_CT_[1-4]$/.test(e.name ?? '')));
  assert.ok(singleLineDiagram(D).entities.filter((e) => e.type === 'table').length === 3);
  const Q = electricalQuantities(D);
  assert.ok(Q.rows.some((r) => /^Dây Cu\/PVC 2x2,5\+E2,5$/.test(r.item ?? '')));
  const wb = electricalWorkbook(D, Q);
  assert.ok(wb.subarray(0, 2).toString() === 'PK' && (wb.toString('latin1').match(/<f>/g) || []).length > 50, 'live formulas');
  for (const n of ['MCP_E_CT_3', 'MCP_E_CT_2C', 'MCP_E_CT_2C_2', 'MCP_E_OC_CN', 'MCP_E_TD', 'MCP_DEN_TUONG']) assert.ok(symbolDef(n)?.entities?.length, n);
  // a floor without rooms does not break the design; the defaults stay as they are
  electricalDesign({ floors: [...floors, { name: 'MÁI', level: 6900, height: 2800, spec: {}, rooms: {}, items: [], lights: [] }], options: { heights: { socket: 300 } } });
  assert.equal(electricalDesign({ floors }).options.heights.socket, 400);
  assert.ok(Q.rows.some((r) => /^MCB 2P 32A$/.test(r.item ?? '') && r.plus === 1), 'the spare way of the main board is counted');
});

test('plumbing set: shaft and stacks, fixtures, supply and drainage runs, septic tank, calculation, quantities', () => {
  const floors = mepFloorsOf();
  const D = plumbingDesign({ floors, roofDrains: [{ at: [400, 400] }, { at: [5600, 8600] }] });
  assert.equal(D.shafts.length, 1, 'the WCs are stacked: one shaft');
  const g = D.shafts[0];
  for (const p of Object.values(g.stacks)) assert.ok(inside(p, MEP_ROOMS[0].WC), 'stacks in the WC');
  const F1 = D.floors[0];
  assert.deepEqual(F1.fixtures.map((x) => x.kind).sort(), ['shower', 'sink', 'toilet', 'vanity']);
  assert.equal(F1.heaters.length, 1);
  const soil = F1.runs.find((r) => r.sys === 'soil' && r.from === 'toilet');
  assert.deepEqual(soil.pts[soil.pts.length - 1], g.stacks.soil, 'the toilet drains to the soil stack');
  // the heater hangs over the shower mixer: hot water runs on to the basin; one cold branch per floor with one valve
  assert.ok(F1.runs.some((r) => r.sys === 'hot' && r.to === 'vanity') && F1.runs.some((r) => r.sys === 'cold' && r.to === 'sink'));
  assert.equal(F1.runs.filter((r) => r.sys === 'cold' && r.trunk).length, 1);
  assert.equal(F1.valves.length, 1);
  assert.ok(!inside(F1.valves[0].at, g.poly), 'the valve stands outside the shaft');
  assert.ok(D.equipment.septic.V >= 3 && D.equipment.hg1 && D.equipment.hg2 && D.equipment.meter);
  // TCVN 4513:1988, dwellings: q = 0.2 N^(1/a) + K N; N = 2 x (0.5 + 0.33 + 0.67) + 1 = 4, a = 2.15 for 150 l/person/day
  assert.equal(D.calc.N, 4);
  assert.ok(near(D.calc.q, 0.2 * 4 ** (1 / 2.15) + 0.002 * 4, 1e-3), `q = ${D.calc.q}`);
  assert.ok(near(supplyFlow(7.5, 2.15, 0.002), 0.526, 1e-3) && aForNorm(200) === 2.14 && kForN(400) === 0.003);
  assert.equal(supplyFlow(100, 2.15, 0.002, 0.5), 0.5, 'never more than all the fixtures together');
  assert.equal(D.calc.riser, 32, 'the riser keeps the assumed D32 when the flow needs less');
  // TCVN 4474:1987: Q = K F q5 / 10000 with K = 2, shared out to the two downpipes
  assert.ok(near(D.calc.rainQ, (2 * (D.calc.roofArea / 2) * 496) / 10000, 0.01), `rain ${D.calc.rainQ}`);
  assert.equal(D.floors[1].downpipes.length, 2);
  // the design never changes the defaults of the next one
  plumbingDesign({ floors, options: { pipes: { rain: 110 }, people: 40 } });
  assert.equal(plumbingDesign({ floors }).options.pipes.rain, 90);
  // the septic tank of the plan and of the detail are the same: two baffles between three compartments
  const S = D.equipment.septic;
  assert.equal(S.L, S.inner[0] + 2 * S.wall + 2 * S.baffle);
  assert.ok((S.inner[0] * S.inner[1] * S.inner[2]) / 1e9 >= S.V, 'useful volume as stated');
  const dims = septicDetail(D).entities.filter((e) => e.type === 'dim').map((e) => Math.round(Math.hypot(e.to[0] - e.from[0], e.to[1] - e.from[1])));
  assert.ok(dims.includes(S.L) && dims.includes(S.inner[0] / 2) && dims.includes(S.inner[0] / 4), dims.join(','));
  const sp = plumbingPlan(D, 0, { mode: 'supply', legendAt: [8000, 9000] });
  assert.ok(sp.entities.some((e) => e.name === 'MCP_P_VAN') && sp.entities.some((e) => e.layer === 'P-DOMW-HWTR'));
  // short codes at the equipment, explained in the legend
  const dp = plumbingPlan(D, 0, { mode: 'drainage', legendAt: [8000, 9000] });
  const texts = dp.entities.filter((e) => e.type === 'text').map((e) => e.text);
  assert.ok(texts.includes('BTH') && texts.includes('HG1') && texts.some((t) => /^Bể tự hoại 3 ngăn/.test(t)) && dp.entities.some((e) => e.layer === 'P-SANR-SOIL'), texts.join('|'));
  assert.ok(septicDetail(D).entities.filter((e) => e.type === 'dim').length >= 8);
  assert.ok(plumbingRisers(D).entities.length > 50);
  assert.ok(plumbingBasis(D, 'vi').every((l) => !/\b(the|of|and)\b/.test(l)), 'the sheet notes are in the language of the sheet');
  // a roof drain over the shaft: its downpipe is one of the stacks of the shaft
  const D2 = plumbingDesign({ floors, roofDrains: [{ at: [450, 6300] }, { at: [5600, 400] }] });
  assert.ok(D2.shafts[0].stacks.rain && D2.floors[0].downpipes.some((d) => d.shaft) && D2.shafts[0].d >= 380);
  const Q = plumbingQuantities(D);
  assert.ok(Q.rows.some((r) => /^Ống thoát xí uPVC D110$/.test(r.item ?? '')) && Q.rows.some((r) => /^Bể tự hoại 3 ngăn/.test(r.item ?? '')));
  const wb = plumbingWorkbook(D, Q);
  assert.ok(wb.subarray(0, 2).toString() === 'PK' && (wb.toString('latin1').match(/<f>/g) || []).length > 20, 'live formulas');
  assert.ok(!wb.toString('utf8').includes('>NaN<'), 'every measured length is a number');
});

test('English sets: codes, decimal marks and texts in English; room names of both languages; marks', async () => {
  const VI = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
  const floors = mepFloorsOf();
  for (const f of floors) {
    const finishes = Object.fromEntries(Object.keys(f.rooms).map((n) => [n, resolveFinish(n, {}, [], f.height)]));
    f.lights = ceilingPlan({ rooms: f.rooms, finishes, items: f.items, mode: 'lighting', scale: 100 }).entities
      .filter((e) => e.type === 'block' && /^MCP_DEN_/.test(e.name)).map((e) => ({ kind: e.name === 'MCP_DEN_DOWNLIGHT' ? 'downlight' : 'ceiling_lamp', at: e.at }));
  }
  // the user's own words (floor and room names) may stay Vietnamese; nothing else
  const user = new Set(floors.flatMap((f) => [f.name, ...Object.keys(f.rooms)]).flatMap((n) => String(n).split(/[\s,;:()+]+/)));
  const own = (texts) => texts.filter((t) => VI.test(t) && !String(t).split(/[\s,;:()+]+/).every((w) => !VI.test(w) || user.has(w)));
  const textsOf = (ents) => ents.flatMap((e) => (e.type === 'table' ? e.rows.flat().map((c) => String(c?.text ?? c ?? '')) : e.text !== undefined ? [String(e.text)] : []));
  const S = await import('../src/standards.mjs');
  const E = await import('../src/electrical.mjs');
  S.setDrawingLanguage('en');
  try {
    const D = electricalDesign({ floors, lang: 'en' });
    assert.deepEqual(D.boards.map((b) => b.id), ['DB-1', 'DB-2']);
    assert.equal(D.main.id, 'MDB');
    const ids = D.boards.flatMap((b) => b.circuits.map((c) => c.id));
    assert.ok(ids.some((i) => /^AC\d/.test(i)) && ids.some((i) => /^CK\d/.test(i)) && !ids.some((i) => /^(ĐH|NL|BT|BN)/.test(i)), ids.join(','));
    assert.equal(D.boards[0].circuits.find((c) => c.kind === 'socket').cable, '2x2.5+E2.5');
    const Q = electricalQuantities(D, { lang: 'en' });
    const et = [
      ...textsOf([...electricalPlan(D, 0, { mode: 'power', legendAt: [8000, 9000], lang: 'en' }).entities, ...electricalPlan(D, 0, { mode: 'lighting', legendAt: [8000, 9000], lang: 'en' }).entities]),
      ...textsOf([...singleLineDiagram(D, { lang: 'en' }).entities, ...E.riserDiagram(D, { lang: 'en' }).entities]),
      ...Q.rows.flatMap((r) => [r.item ?? '', r.how ?? '']), ...E.electricalTables(D, Q, 'en').flatMap((t) => t.rows.flat().map(String)), ...E.electricalBasis(D, 'en'),
    ];
    assert.deepEqual(own(et), []);
    assert.ok(et.some((t) => t.startsWith('Pd = Kd x ΣPd')) && et.includes('Pd (W)'), 'the load symbols in English');
    // plumbing: the codes of the plans, risers and the septic tank in English
    const P = plumbingDesign({ floors, roofDrains: [{ at: [400, 400] }, { at: [5600, 8600] }], lang: 'en' });
    const pt = textsOf([
      ...plumbingPlan(P, 0, { mode: 'drainage', legendAt: [8000, 9000], lang: 'en' }).entities, ...plumbingPlan(P, 0, { mode: 'supply', legendAt: [8000, 9000], lang: 'en' }).entities,
      ...plumbingRisers(P, { lang: 'en' }).entities, ...septicDetail(P, { lang: 'en' }).entities,
    ]);
    assert.deepEqual(own(pt), []);
    assert.ok(pt.includes('ST') && pt.includes('MH1') && pt.some((t) => /^SP D110/.test(t)), pt.join('|').slice(0, 400));
    assert.ok(!pt.some((t) => /(^|\s)(TX|TR|TM|CL|CN|OĐ|BTH|HG\d)\b/.test(t)), 'no Vietnamese codes');
    // joinery: kitchen, wardrobe, display casework
    for (const kind of ['kitchen', 'wardrobe', 'display']) {
      const r = joineryDetail({ kind, width: 2400 });
      assert.deepEqual(own(textsOf([...r.entities, ...(r.section || [])])), [], kind);
      assert.ok(textsOf(r.entities).some((t) => t.startsWith('ELEVATION - ')), kind);
    }
  } finally {
    S.setDrawingLanguage('vi');
  }
  // the Vietnamese sets keep their codes
  assert.equal(electricalDesign({ floors }).main.id, 'TĐ-T');
  // room names: whole words of either language ("ĂN" is not in "VĂN PHÒNG" or "CĂN HỘ", "KHO" not in "KHOA")
  const { roomKind } = await import('../src/mep.mjs');
  assert.deepEqual(['VĂN PHÒNG', 'CĂN HỘ', 'KHOA NỘI', 'PHÒNG ĂN', 'BẾP + ĂN', 'BATHROOM 2', 'MASTER BEDROOM', 'LIVING ROOM', 'STAIRCASE', 'WC1', 'P.NGỦ 2'].map(roomKind),
    ['office', 'room', 'room', 'dining', 'kitchen', 'wc', 'bedroom', 'living', 'stair', 'wc', 'bedroom']);
  // marks: the tag of the floor, beams by language
  const { beamPrefix } = await import('../src/calc.mjs');
  assert.deepEqual(['TẦNG 2', 'TUM', 'TẦNG LỬNG', 'ROOF', 'Level 3'].map((n) => S.floorTag(n)), ['2', 'T', 'TL', 'R', '3']);
  assert.deepEqual([beamPrefix('floor', 'TẦNG 2', 1), beamPrefix('floor', 'TẦNG 2', 1, 'en'), beamPrefix('foundation', '', 0, 'en'), beamPrefix('floor', 'TUM', 4), beamPrefix('roof', '', 4, 'en')],
    ['D2.', 'B2.', 'GB.', 'DT.', 'RB.']);
  // a floor whose name ends in no number keeps the number of its place (as before)
  assert.equal(beamPrefix('floor', 'TẦNG LỬNG', 1), 'D2.');
  // the slabs carry the tag of their beams: S2-1 with D2.1, the roof M (R in English)
  const spec5 = { floors: [{ name: 'TẦNG 1', height: 3300, walls: [{ points: [[0, 0], [5000, 0], [5000, 6000], [0, 6000]], closed: true, thickness: 200 }], columns: [{ at: [0, 0] }, { at: [5000, 0] }, { at: [5000, 6000] }, { at: [0, 6000] }] }, { name: 'TẦNG LỬNG', height: 3000 }] };
  for (const lang of ['vi', 'en']) {
    const R = structuralCalc({ spec: spec5, lang });
    const fl = R.slabs.find((s) => s.kind === 'floor');
    assert.equal(fl.tag, '2', lang);
    assert.ok(fl.types.every((t) => t.name.startsWith(lang === 'en' ? 'B2.' : 'D2.')), fl.types.map((t) => t.name).join(','));
    assert.equal(R.slabs.find((s) => s.kind === 'roof').tag, lang === 'en' ? 'R' : 'M');
  }
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
    assert.equal(names.length, 81, names.join(','));
    for (const t of ['draw_plan', 'screenshot', 'install_autocad_bridge', 'quantity_takeoff', 'draw_electrical_plan', 'draw_plumbing_plan', 'plumbing_calc', 'measure_model', 'verify_quantities', 'list_views', 'standardize_layers', 'close_drawing', 'read_plan', 'revision_cloud', 'compare_drawings', 'stretch_entities', 'replace_text', 'convert_vietnamese_text', 'describe_drawing', 'check_annotations', 'list_texts', 'update_texts', 'clean_drawing', 'describe_folder', 'manage_images', 'retitle_view', 'update_title_blocks', 'lighting_calc']) assert.ok(names.includes(t));
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
