// Unit tests of the pure parts (plan engine, standards) and a smoke test of the MCP server over stdio.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, hull, PlanError } from '../src/plan.mjs';
import { fitScale, layerSpecs, layerStyles, ROLE, styleParams, titleBlock } from '../src/standards.mjs';

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

test('door: wall cut through the whole thickness, leaf + arc on the toward side, tag', () => {
  const p = buildPlan({
    walls: [{ id: 'W1', points: [[0, 0], [5000, 0]], thickness: 200 }],
    openings: [{ wall: 'W1', offset: 1000, width: 900, type: 'door', toward: [1500, 2000], tag: 'D1' }],
    dimensions: false,
  });
  assert.equal(p.cuts.length, 1);
  const cut = p.cuts[0];
  assert.ok(hasPt(cut, [1000, -101]) && hasPt(cut, [1900, 101]));
  const leaf = p.entities.find((e) => e.type === 'line' && e.layer === 'A-DOOR');
  assert.deepEqual(leaf.from, [1000, 100]);
  assert.deepEqual(leaf.to, [1000, 1000]);
  const arc = p.entities.find((e) => e.type === 'arc');
  assert.deepEqual(arc.end, [1900, 100]);
  assert.ok(near(Math.hypot(arc.mid[0] - 1000, arc.mid[1] - 100), 900, 1e-3));
  assert.ok(p.entities.some((e) => e.type === 'text' && e.text === 'D1'));
});

test('window: four lines across the opening on A-GLAZ, opening by centre point', () => {
  const p = buildPlan({
    walls: [{ points: [[0, 0], [0, 4000]], thickness: 220 }],
    openings: [{ wall: 0, at: [0, 2000], width: 1200, type: 'window' }],
    dimensions: false,
  });
  const lines = p.entities.filter((e) => e.layer === 'A-GLAZ');
  assert.equal(lines.length, 4);
  for (const l of lines) assert.ok(near(Math.abs(l.from[1] - l.to[1]), 1200));
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
  const tag = (t) => p.entities.find((e) => e.text === t).at;
  assert.ok(tag('S1')[1] < -100, 'S1 below the front wall');
  assert.ok(tag('S2')[1] > 4100, 'S2 above the back wall');
  assert.ok(tag('D1')[1] < -100, 'D1 outside, the door swings in');
  assert.equal(p.room_options.text_height, 300);
  const q = buildPlan({ walls: [{ points: [[0, 0], [4000, 0]] }], openings: [{ wall: 0, offset: 500, width: 900, type: 'window', tag: 'S9', tag_at: [1, 2] }], dimensions: false });
  assert.deepEqual(q.entities.find((e) => e.text === 'S9').at, [1, 2]);
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
  const bubbles = p.entities.filter((e) => e.type === 'circle' && e.layer === 'S-GRID-IDEN');
  assert.equal(bubbles.length, 10);
  const labels = p.entities.filter((e) => e.type === 'text' && e.layer === 'S-GRID-IDEN').map((e) => e.text).sort();
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
  assert.ok(p.entities.some((e) => e.text === '+0.450'));
  assert.ok(p.entities.some((e) => e.text === 'N'));
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
  assert.ok(tb.entities.some((e) => e.text === 'MẶT BẰNG TẦNG 1'));
  const [[x0, y0], [x1, y1]] = tb.area;
  assert.ok(x1 - x0 > 150 && y1 - y0 > 150);
  assert.equal(fitScale([30000, 20000], [380, 250]), 100);
  assert.equal(fitScale([3000, 2000], [380, 250]), 10);
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
    const names = list.result.tools.map((t) => t.name);
    assert.equal(names.length, 31, names.join(','));
    for (const t of ['draw_plan', 'screenshot', 'install_autocad_bridge', 'quantity_takeoff']) assert.ok(names.includes(t));
    const ping = await rpc('tools/call', { name: 'ping', arguments: {} });
    assert.equal(ping.result.isError, true);
    assert.match(ping.result.content[0].text, /Cannot connect to AutoCAD/);
    const bad = await rpc('tools/call', { name: 'draw_plan', arguments: { walls: [{ points: [[0, 0], [1000, 0]] }], openings: [{ wall: 0, offset: 500, width: 900 }] } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /does not fit/);
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
