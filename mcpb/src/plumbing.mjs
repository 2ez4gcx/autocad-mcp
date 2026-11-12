// Plumbing set (mm): water supply from the meter and the pump to the roof tank and down to every fixture by gravity
// (PPR, cold and hot from a water heater in each WC), drainage in three systems (soil to the septic tank, waste and
// rainwater to the manholes and the street sewer, uPVC), the shaft of stacks in the corner of the WCs, and the drawings:
// supply and drainage plans of each floor, the supply and drainage riser diagrams, the septic tank and manhole details,
// the calculation (TCVN 4513:1988 supply, TCVN 4474:1987 drainage) and the bill of quantities. Pure geometry and
// numbers: returns draw_entities specs.
import {
  add, boqTable, branchTree, centroid, deg, dist, doorFace, dot, floorDoors, inside, labelPlacer, legend, lineE, mergeOptions, mul,
  oppositeFaces, P, planModel, polyE, pumpSpot, r2, roomFaces, roomKind, routeLength, sub, textE, unit,
} from './mep.mjs';
import { polyArea } from './interior.mjs';
import { dimStyleName, ROLE, TEXT_STYLE, viewTitle } from './standards.mjs';
import { sym } from './symbols.mjs';

const L = (role) => ROLE[role];

/** Defaults of the plumbing design (every one reported in assumed when not given). */
export const P_DEFAULTS = {
  people: 6, q_day: 150, tank: 1500, pump_kw: 0.75, heater_l: 30,
  // PPR supply, uPVC drainage (mm)
  pipes: { riser: 32, up: 25, branch: 25, fixture: 20, hot: 20, city: 25, soil: 110, waste_stack: 90, waste: 60, rain: 90, vent: 60, main: 110 },
  slopes: { 60: 3, 90: 2, 110: 2 },
  shaft: 400,
  // TCVN 4513:1988, dwellings: q = 0.2 N^(1/a) + K N (l/s); a by the daily norm (table 9), K by N (table 10)
  a: null, K: null, v_max: 1.5,
  // free head at the highest shower (m): the least the code asks for, and what a shower and a water heater work well with
  head_min: 3, head_comfort: 8,
  septic_min: 3,
  // TCVN 4474:1987: Q = K F q5 / 10000 (l/s), K = 2; a D80-D90 roof drain takes 5 l/s
  rain_q5: 496, rain_k: 2, rain_pipe: 5,
};

/** TCVN 4513:1988 table 9: a by the daily norm (l/person/day). */
export const A_BY_NORM = [[100, 2.2], [125, 2.16], [150, 2.15], [200, 2.14], [250, 2.05], [300, 2], [350, 1.9], [400, 1.85]];
export const aForNorm = (q) => A_BY_NORM.reduce((best, r) => (Math.abs(r[0] - q) < Math.abs(best[0] - q) ? r : best))[1];
/** TCVN 4513:1988 table 10: K by the total of equivalents N. */
export const kForN = (N) => (N <= 300 ? 0.002 : N <= 500 ? 0.003 : N <= 800 ? 0.004 : N <= 1200 ? 0.005 : 0.006);
/** Design flow of a dwelling (l/s): q = 0.2 N^(1/a) + K N, not more than all the fixtures running together. */
export const supplyFlow = (N, a, K, sumQ0 = Infinity) => Math.min(0.2 * N ** (1 / a) + K * N, sumQ0);

/** Fixtures: TCVN 4513 table 2 equivalent N and flow q0 = 0.2 N (l/s), drainage flow (l/s), outlet DN, drainage system, hot water. */
export const FIXTURES = {
  toilet: { vi: 'Bồn cầu két nước', en: 'WC with cistern', N: 0.5, q: 0.1, drain: 1.6, dn: 110, sys: 'soil', hot: false },
  vanity: { vi: 'Chậu rửa mặt (lavabo)', en: 'Wash basin', N: 0.33, q: 0.07, drain: 0.1, dn: 60, sys: 'waste', hot: true },
  shower: { vi: 'Vòi sen tắm', en: 'Shower', N: 0.67, q: 0.14, drain: 0.2, dn: 60, sys: 'waste', hot: true },
  sink: { vi: 'Chậu rửa bếp', en: 'Kitchen sink', N: 1, q: 0.2, drain: 0.3, dn: 60, sys: 'waste', hot: false },
  washer: { vi: 'Máy giặt (van cấp, ống xả)', en: 'Washing machine', N: 1, q: 0.2, drain: 0.3, dn: 60, sys: 'waste', hot: false },
  tap: { vi: 'Vòi rửa sân, tưới cây', en: 'Hose tap', N: 1, q: 0.2, drain: 0, dn: 0, sys: null, hot: false },
};
/** Codes written at the equipment on the plans (the legend says what they are). */
export const CODE = { shaft: 'OĐ', septic: 'BTH', meter: 'ĐHN', pump: 'MB', tank: 'BỒN' };

/** Short names of the fixtures for the diagrams. */
const SHORT = {
  vi: { toilet: 'Bồn cầu', vanity: 'Lavabo', shower: 'Vòi sen', sink: 'Chậu bếp', washer: 'Máy giặt', tap: 'Vòi' },
  en: { toilet: 'WC', vanity: 'Basin', shower: 'Shower', sink: 'Sink', washer: 'Washer', tap: 'Tap' },
};

/** PPR PN10 pipes (cold water): outside diameter -> inside diameter (mm). */
export const PPR = [[20, 16.2], [25, 20.4], [32, 26.2], [40, 32.6], [50, 40.8], [63, 51.4]];
/** Stainless tanks (upright): volume (l) -> diameter (mm). */
const TANK_D = [[500, 770], [1000, 960], [1500, 1180], [2000, 1180], [3000, 1380], [5000, 1420]];
const tankDiameter = (v) => (TANK_D.find(([vol]) => vol >= v) ?? TANK_D[TANK_D.length - 1])[1];

const SYS = {
  cold: { layer: 'cold_water', vi: 'Ống cấp nước lạnh PPR', en: 'Cold water PPR', mat: 'PPR', abbr: 'CL' },
  hot: { layer: 'hot_water', vi: 'Ống cấp nước nóng PPR', en: 'Hot water PPR', mat: 'PPR', abbr: 'CN' },
  soil: { layer: 'soil', vi: 'Ống thoát xí uPVC', en: 'Soil uPVC', mat: 'uPVC', abbr: 'TX' },
  waste: { layer: 'waste', vi: 'Ống thoát nước rửa uPVC', en: 'Waste uPVC', mat: 'uPVC', abbr: 'TR' },
  rain: { layer: 'rain', vi: 'Ống thoát nước mưa uPVC', en: 'Rainwater uPVC', mat: 'uPVC', abbr: 'TM' },
  vent: { layer: 'vent', vi: 'Ống thông hơi uPVC', en: 'Vent uPVC', mat: 'uPVC', abbr: 'TH' },
};

/** Points of an L route from a to b with its corner by the wall it runs along (the corner nearest a wall of the rooms). */
function lRoute(a, b, rooms) {
  if (Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1) return [a, b];
  const c1 = [b[0], a[1]], c2 = [a[0], b[1]];
  const polys = Object.values(rooms);
  const wallDist = (p) => Math.min(...polys.flatMap((poly) => poly.map((q, i) => {
    const r = poly[(i + 1) % poly.length], v = sub(r, q), t = Math.max(0, Math.min(1, dot(sub(p, q), v) / (dot(v, v) || 1)));
    return dist(p, add(q, mul(v, t)));
  })));
  const ok = (p) => polys.some((poly) => inside(p, poly));
  const k1 = (ok(c1) ? 0 : 1e6) + wallDist(c1), k2 = (ok(c2) ? 0 : 1e6) + wallDist(c2);
  return [a, k1 <= k2 ? c1 : c2, b];
}

/** A polyline offset sideways by d (left of its direction), its corners joined. */
function offsetLine(pts, d) {
  const segs = pts.slice(1).map((p, i) => {
    const t = unit(sub(p, pts[i])), n = [-t[1], t[0]];
    return [add(pts[i], mul(n, d)), add(p, mul(n, d)), t];
  });
  const out = [segs[0][0]];
  for (let i = 1; i < segs.length; i++) {
    const [a0, , t0] = segs[i - 1], [b0, , t1] = segs[i];
    const den = t0[0] * t1[1] - t0[1] * t1[0];
    if (Math.abs(den) < 1e-9) out.push(b0);
    else {
      const w = sub(b0, a0), k = (w[0] * t1[1] - w[1] * t1[0]) / den;
      out.push(add(a0, mul(t0, k)));
    }
  }
  out.push(segs[segs.length - 1][1]);
  return out;
}

/**
 * Where the stacks stand in a shaft s wide along the wall: mm from its corner (along the wall, into the room) and its
 * depth. With a rainwater pipe the shaft is at least 380 deep: the large pipes at the wall, the supply risers in front.
 */
function shaftSlots(s, rain) {
  if (!rain) return { d: s, slots: { soil: [0.3 * s, 0.3 * s], waste: [0.74 * s, 0.3 * s], down: [0.3 * s, 0.76 * s], up: [0.76 * s, 0.76 * s] } };
  return { d: Math.max(s, 380), slots: { soil: [0.29 * s, 75], waste: [0.71 * s, 75], rain: [0.71 * s, 200], down: [0.29 * s, 195], up: [0.29 * s, 305] } };
}

/**
 * The plumbing design of a building. floors: [{name, level, height, spec, rooms, items (with the default fixtures)}];
 * roofDrains: [{at, tower}] of the roof plan. Returns {floors, shafts, equipment, rainPipes, calc, options, assumed,
 * warnings}.
 */
export function plumbingDesign({ floors, roofDrains = [], options = {}, lang = 'vi' }) {
  const O = mergeOptions(P_DEFAULTS, options);
  if (O.a == null) O.a = aForNorm(O.q_day);
  const assumed = [], warnings = [];
  const note = (item, value, n) => assumed.push({ item, value, ...(n ? { note: n } : {}) });
  if (!options.people) note('people', `${O.people} people, ${O.q_day} l/person/day`, 'TCVN 4513:1988');
  if (!options.tank) note('tank', `stainless tank ${O.tank} l on the roof of the stair tower, gravity supply; pump ${O.pump_kw} kW from the meter`);
  if (!options.pipes) note('pipes', `PPR: riser D${O.pipes.riser}, floor branches D${O.pipes.branch}, fixtures D${O.pipes.fixture}; uPVC: soil D${O.pipes.soil}, waste stack D${O.pipes.waste_stack}, branches D${O.pipes.waste}, rainwater D${O.pipes.rain}, vent D${O.pipes.vent}`);
  if (!options.slopes) note('slopes', 'D60 i=3%, D90-D110 i=2%', 'TCVN 4474:1987');
  if (!options.heater_l) note('hot water', `a ${O.heater_l} l water heater in each WC`);
  if (!options.shaft) note('shaft', `${O.shaft} x ${O.shaft} in the corner of the WCs (smaller where the toilet stands nearer the corner)`);
  const out = [];
  // ---- the shaft: the corner of the WC at the left end of the wall opposite its door, the same on every floor
  const corners = [];
  floors.forEach((f, k) => {
    const M = planModel(f.spec);
    const doors = floorDoors(M, f.spec, f.rooms);
    for (const [name, poly] of Object.entries(f.rooms)) {
      if (roomKind(name) !== 'wc') continue;
      const faces = roomFaces(poly, M);
      const door = doors.filter((d) => d.sides[name]).sort((a, b) => b.width - a.width)[0];
      const dfc = door ? doorFace(faces, door) : null;
      const back = (dfc && oppositeFaces(faces, dfc)[0]) ?? faces.find((x) => x !== dfc) ?? faces[0];
      if (!back) continue;
      // room for the shaft left of the toilet on that wall
      const toilet = (f.items || []).find((it) => it.room === name && it.type === 'toilet' && dot(it.ex, back.F.r) > 0.99);
      const free = toilet ? back.F.u(toilet.o) - back.F.u0 : O.shaft;
      corners.push({ k, room: name, c0: back.F.left, r: back.F.r, inw: back.inw, s: Math.max(250, Math.min(O.shaft, free)) });
      if (free < 250) warnings.push(`${f.name} ${name}: no room for the shaft left of the toilet (${Math.round(free)} mm)`);
    }
  });
  // stacked WCs share one shaft (the smallest size of the group)
  const groups = [];
  for (const c of corners) {
    const g = groups.find((x) => dist(x.c0, c.c0) < 150);
    if (g) {
      g.members.push(c);
      g.s = Math.min(g.s, c.s);
    } else groups.push({ c0: c.c0, r: c.r, inw: c.inw, s: c.s, members: [c] });
  }
  // the rainwater downpipes of the roof terrace (the drain of the tower roof spills onto the terrace)
  const roofPipes = roofDrains.filter((d) => !d.tower).map((d) => ({ drain: P(d.at), at: P(d.at), shaft: false }));
  for (const g of groups) {
    const q = (u, v) => add(add(g.c0, mul(g.r, u)), mul(g.inw, v));
    // a roof drain over the shaft: its downpipe runs inside the shaft
    const near = roofPipes.find((p) => {
      const w = sub(p.drain, g.c0), u = dot(w, g.r), v = dot(w, g.inw);
      return !p.shaft && u > -200 && u < g.s + 200 && v > -200 && v < g.s + 280;
    });
    const { d, slots } = shaftSlots(g.s, Boolean(near));
    g.d = d;
    g.poly = [q(0, 0), q(g.s, 0), q(g.s, d), q(0, d)].map(P);
    g.stacks = Object.fromEntries(Object.entries(slots).map(([key, [u, v]]) => [key, P(q(u, v))]));
    if (near) {
      near.at = g.stacks.rain;
      near.shaft = true;
    }
    g.floors = g.members.map((m) => m.k);
  }
  if (groups.length > 1) warnings.push(`the WCs are not stacked: ${groups.length} shafts (each with its own stacks)`);
  const ownShaft = (k, name) => groups.find((g) => g.members.some((m) => m.k === k && m.room === name)) ?? null;
  const main = groups[0];
  if (!main) warnings.push('no WC: no shaft, no stacks');

  // the drain of each balcony and its downpipe in the wall behind it, down to the ground
  const balconyPipes = [];
  floors.forEach((f, k) => {
    const pts = (f.spec.walls || []).flatMap((w) => w.points || []);
    if (!pts.length) return;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const wx = pts.map((p) => p[0]), wy = pts.map((p) => p[1]);
    for (const b of f.spec.balconies || []) {
      const [[x0, y0], [x1, y1]] = b.region;
      const p = [Math.min(x0, x1) + 300, Math.min(y0, y1) + 300];
      const at = P([clamp(p[0], Math.min(...wx), Math.max(...wx)), clamp(p[1], Math.min(...wy), Math.max(...wy))]);
      let bp = balconyPipes.find((x) => dist(x.at, at) < 200);
      if (!bp) balconyPipes.push(bp = { at, top: k, drains: [] });
      bp.top = Math.max(bp.top, k);
      bp.drains.push({ k, at: P(p) });
    }
  });

  // ---- the ground: septic tank, manholes, the meter, the pump
  const g0 = floors[0];
  const pts0 = Object.values(g0.rooms).flat();
  const bx0 = Math.min(...pts0.map((p) => p[0])), bx1 = Math.max(...pts0.map((p) => p[0]));
  const by0 = Math.min(...pts0.map((p) => p[1])), by1 = Math.max(...pts0.map((p) => p[1]));
  const N = O.people;
  // septic tank: useful volume W = Wn + Wc (the larger of that and the minimum); 3 compartments 1/2, 1/4, 1/4 of the
  // useful length between two baffles
  const Wn = r2((N * O.q_day * 1) / 1000);
  const Wc = r2((0.5 * 365 * (100 - 95) * 0.7 * 1.2 * N) / ((100 - 90) * 1000));
  const Wneed = r2(Wn + Wc);
  const V = Math.max(O.septic_min, Math.ceil(Wneed * 2) / 2);
  const Hw = 1.2, Bw = 1.2, Lw = Math.ceil((V / (Hw * Bw)) * 10) / 10;
  if (!options.septic_min) note('septic tank', `3 compartments, useful volume ${V} m³ (needed ${Wneed} m³: Wn ${Wn} + Wc ${Wc}), ${Lw * 1000} x ${Bw * 1000} x ${Hw * 1000} water depth, brick 220 on an RC base`, 'under the back of the ground floor: coordinate with the foundations');
  const wall = 220, baffle = 110;
  const tankL = Lw * 1000 + 2 * wall + 2 * baffle, tankB = Bw * 1000 + 2 * wall;
  const tankC = [(bx0 + bx1) / 2, by1 - 200 - tankB / 2];
  const septic = {
    c: P(tankC), L: tankL, B: tankB, V, Wn, Wc, Wneed, inner: [Lw * 1000, Bw * 1000, Hw * 1000], wall, baffle,
    poly: [[tankC[0] - tankL / 2, tankC[1] - tankB / 2], [tankC[0] + tankL / 2, tankC[1] - tankB / 2], [tankC[0] + tankL / 2, tankC[1] + tankB / 2], [tankC[0] - tankL / 2, tankC[1] + tankB / 2]].map(P),
    inlet: P([tankC[0] - tankL / 2, tankC[1]]), outlet: P([tankC[0] + tankL / 2, tankC[1]]),
  };
  // manhole 1 beside the outlet of the tank when a room is there (a yard at the back), else in front of the tank
  const hx = Math.min(bx1 - 400, septic.outlet[0] + 500);
  let hg1 = P([hx, tankC[1]]);
  if (hx - septic.outlet[0] < 300 || !Object.values(g0.rooms).some((poly) => inside(hg1, poly))) hg1 = P([hx, tankC[1] - tankB / 2 - 500]);
  const hg2 = P([bx1 - 500, by0 - 900]);
  const meter = P([bx1 - 1100, by0 - 600]);
  const pump = pumpSpot(g0.rooms, g0.spec);
  const equipment = { septic, hg1, hg2, meter, pump: pump?.at ?? null, pumpRoom: pump?.room ?? null };

  // ---- per floor: fixtures, heaters, drains, runs
  floors.forEach((f, k) => {
    const F = { name: f.name, level: f.level ?? 0, height: f.height ?? 3300, fixtures: [], heaters: [], drains: [], downpipes: [], runs: [], valves: [], ground: k === 0 };
    const route = (a, b) => lRoute(a, b, f.rooms);
    const run = (sys, dn, pts, extra = {}) => {
      if (routeLength(pts) < 1) return;
      F.runs.push({ sys, dn, pts: pts.map(P), ...extra });
    };
    for (const it of f.items || []) {
      const m = (x, y) => add(add(it.o, mul(it.ex, x)), mul(it.ey, y));
      // wall: the point of the wall behind the fixture; rot: the way it faces
      const fix = (kind, at, supply, outlet, extra = {}) => F.fixtures.push({ kind, room: it.room, at: P(at), supply: P(supply), outlet: P(outlet), wall: P(m(it.w / 2, 0)), rot: deg(it.ey), ...extra });
      if (it.type === 'toilet') fix('toilet', m(it.w / 2, it.d / 2), m(it.w / 2 + 150, 60), m(it.w / 2, 260));
      else if (it.type === 'vanity') fix('vanity', m(it.w / 2, it.d / 2), m(it.w / 2 + 40, 60), m(it.w / 2, 150), { hotAt: P(m(it.w / 2 - 80, 130)) });
      else if (it.type === 'shower') fix('shower', m(it.w / 2, it.d / 2), m(it.w / 2 + 40, 60), m(it.w / 2, it.d / 2), { hotAt: P(m(it.w / 2 - 80, 130)), drain: true });
      else if (it.type === 'kitchen_base' && it.opts?.sink !== undefined) fix('sink', m(it.opts.sink, 300), m(it.opts.sink, 60), m(it.opts.sink, 200), { wall: P(m(it.opts.sink, 0)) });
      else if (it.type === 'washer') fix('washer', m(it.w / 2, it.d / 2), m(it.w / 2, 60), m(it.w + 200, 200), { drain: true });
      else if (it.type === 'bathtub') fix('shower', m(it.w - 160, it.d / 2), m(it.w - 160, 60), m(it.w - 160, it.d / 2), { hotAt: P(m(it.w - 240, 130)), wall: P(m(it.w - 160, 0)) });
    }
    const wcs = Object.keys(f.rooms).filter((n) => roomKind(n) === 'wc');
    // a water heater in each WC with hot fixtures: on the wall over the shower mixer (else over the basin)
    for (const name of wcs) {
      const hot = F.fixtures.filter((x) => x.room === name && FIXTURES[x.kind].hot);
      if (!hot.length) continue;
      const host = hot.find((x) => x.kind === 'shower') ?? hot[0];
      F.heaters.push({ room: name, at: host.wall, rot: host.rot, host });
    }
    // floor drains: the showers and washers, one more in each WC clear of the fixtures, the yards
    for (const x of F.fixtures.filter((y) => y.drain)) F.drains.push({ at: x.outlet, room: x.room, kind: 'floor' });
    for (const name of wcs) {
      const poly = f.rooms[name];
      const c = centroid(poly);
      const busy = F.fixtures.filter((x) => x.room === name).map((x) => x.at);
      let best = null;
      for (const dx of [-600, -300, 0, 300, 600]) {
        for (const dy of [-600, -300, 0, 300, 600]) {
          const p = add(c, [dx, dy]);
          if (!inside(p, poly)) continue;
          const clear = Math.min(...busy.map((b) => dist(b, p)), Infinity);
          if (!best || clear > best.clear) best = { p, clear };
        }
      }
      if (best && best.clear > 450 && !F.drains.some((d) => d.room === name && dist(d.at, best.p) < 600)) F.drains.push({ at: P(best.p), room: name, kind: 'floor' });
    }
    for (const name of Object.keys(f.rooms).filter((n) => ['laundry', 'outdoor'].includes(roomKind(n)))) {
      if (F.drains.some((d) => d.room === name)) continue;
      F.drains.push({ at: P(centroid(f.rooms[name])), room: name, kind: 'floor' });
    }
    // rainwater: the balcony drains with their pipe to the downpipe in the wall, the roof drains on the top floor,
    // the downpipes passing every floor below
    for (const bp of balconyPipes) {
      const dr = bp.drains.find((x) => x.k === k);
      if (dr) {
        F.drains.push({ at: dr.at, room: null, kind: 'balcony' });
        run('rain', O.pipes.rain, [dr.at, bp.at], { from: 'balcony' });
      }
      if (k <= bp.top) F.downpipes.push({ at: bp.at, dn: O.pipes.rain, from: 'balcony' });
    }
    if (k === floors.length - 1) for (const d of roofDrains) F.drains.push({ at: P(d.at), room: null, kind: 'roof', tower: d.tower });
    for (const p of roofPipes) F.downpipes.push({ at: p.at, dn: O.pipes.rain, from: 'roof', shaft: p.shaft });

    // ---- supply: per shaft one branch of the floor from the down riser (trunk to the farthest fixture, tees and stubs
    // to the others), a stop valve where it leaves the shaft; hot water from the heater to the other hot fixtures
    const shaftFor = (name) => ownShaft(k, name) ?? main;
    const inShaft = (g, p) => {
      const w = sub(p, g.c0), u = dot(w, g.r), v = dot(w, g.inw);
      return u > 0 && u < g.s && v > 0 && v < g.d;
    };
    for (const g of groups) {
      const targets = F.fixtures.filter((x) => shaftFor(x.room) === g).map((x) => ({ p: x.supply, to: x.kind }));
      if (!targets.length) continue;
      const tree = branchTree(g.stacks.down, targets, route);
      for (const br of tree) run('cold', br.trunk && targets.length > 1 ? O.pipes.branch : O.pipes.fixture, br.pts, { to: br.to, trunk: br.trunk });
      const a = tree[0].pts[0], t = unit(sub(tree[0].pts[1], a)), len = dist(a, tree[0].pts[1]);
      let off = 0;
      while (off < len && inShaft(g, add(a, mul(t, off)))) off += 20;
      F.valves.push({ at: P(add(a, mul(t, Math.min(Math.max(len - 50, 0), off + 150)))), rot: deg(t) });
    }
    for (const h of F.heaters) {
      const targets = F.fixtures.filter((x) => x.room === h.room && FIXTURES[x.kind].hot && x !== h.host).map((x) => ({ p: x.hotAt, to: x.kind }));
      for (const br of branchTree(h.host.hotAt, targets, route)) run('hot', O.pipes.hot, br.pts, { room: h.room, to: br.to });
    }
    // ---- drainage: the toilets to the soil stack; basins, sinks and floor drains as one branch of the floor to the
    // waste stack. Ground floor rooms away from the shaft drain under the slab to manhole 1.
    for (const x of F.fixtures.filter((y) => FIXTURES[y.kind].sys === 'soil')) {
      const g = shaftFor(x.room);
      if (g) run('soil', FIXTURES[x.kind].dn, route(x.outlet, g.stacks.soil), { room: x.room, from: x.kind });
    }
    const wasteOf = (pred) => [
      ...F.fixtures.filter((y) => FIXTURES[y.kind].sys === 'waste' && !y.drain && pred(y.room)).map((y) => ({ p: y.outlet, to: y.kind })),
      ...F.drains.filter((d) => d.kind === 'floor' && pred(d.room)).map((d) => ({ p: d.at, to: 'drain' })),
    ];
    const toManhole = (name) => k === 0 && !ownShaft(k, name);
    for (const g of groups) {
      for (const br of branchTree(g.stacks.waste, wasteOf((name) => shaftFor(name) === g && !toManhole(name)), route)) run('waste', O.pipes.waste, br.pts, { from: br.to, trunk: br.trunk });
    }
    if (k === 0) for (const br of branchTree(hg1, wasteOf(toManhole), route)) run('waste', O.pipes.waste, br.pts, { from: br.to, trunk: br.trunk, under: true });
    out.push(F);
  });

  // ---- under the ground floor: the stacks to the septic tank and manhole 1, manhole 1 to 2 and the street, the rain
  // downpipes to the nearest manhole; the supply from the meter to the pump and up the shaft
  const G = out[0];
  if (main) {
    G.runs.push({ sys: 'soil', dn: O.pipes.soil, pts: [main.stacks.soil, [main.stacks.soil[0], septic.inlet[1]], septic.inlet].map(P), under: true });
    G.runs.push({ sys: 'waste', dn: O.pipes.waste_stack, pts: lRoute(main.stacks.waste, hg1, g0.rooms).map(P), under: true });
  }
  G.runs.push({ sys: 'soil', dn: O.pipes.main, pts: lRoute(septic.outlet, hg1, g0.rooms).map(P), under: true, label: 'septic' });
  G.runs.push({ sys: 'waste', dn: O.pipes.main, pts: [hg1, [hg1[0], hg2[1]], hg2].map(P), under: true, main: true });
  for (const dp of G.downpipes) {
    const hg = dist(dp.at, hg1) < dist(dp.at, hg2) ? hg1 : hg2;
    G.runs.push({ sys: 'rain', dn: O.pipes.rain, pts: lRoute(dp.at, hg, g0.rooms).map(P), under: true });
  }
  if (pump) {
    G.runs.push({ sys: 'cold', dn: O.pipes.city, pts: [meter, [meter[0], pump.at[1]], pump.at].map(P), under: true, to: 'pump' });
    if (main) G.runs.push({ sys: 'cold', dn: O.pipes.up, pts: lRoute(pump.at, main.stacks.up, g0.rooms).map(P), to: 'up' });
  }
  // the tank on the roof of the stair tower (the top floor's stair room), its pipes along the terrace to the shaft
  const T = out[out.length - 1];
  const topF = floors[floors.length - 1];
  const stairName = Object.keys(topF.rooms).find((n) => roomKind(n) === 'stair');
  const tankAt = P(centroid(stairName ? topF.rooms[stairName] : Object.values(topF.rooms)[0]));
  equipment.tank = { at: tankAt, d: tankDiameter(O.tank), floor: T.name, onTower: Boolean(stairName) };
  // a roof terrace in use: the vents rise 3 m over it
  equipment.terrace = Object.keys(topF.rooms).some((n) => roomKind(n) === 'terrace');
  if (main) {
    const down = lRoute(tankAt, main.stacks.down, topF.rooms);
    T.runs.push({ sys: 'cold', dn: O.pipes.riser, pts: down.map(P), to: 'down', roof: true });
    // the pump pipe beside it, 150 apart, from its own riser
    const off = offsetLine([...down].reverse(), 150);
    off[0] = Math.abs(off[0][0] - off[1][0]) < 1 ? [off[0][0], main.stacks.up[1]] : [main.stacks.up[0], off[0][1]];
    T.runs.push({ sys: 'cold', dn: O.pipes.up, pts: [main.stacks.up, ...off].map(P), to: 'tank', roof: true });
  }

  // ---- supply calculation (TCVN 4513:1988): equivalents, design flow, the riser for the velocity limit
  const fixtures = out.flatMap((F) => F.fixtures);
  const Ntot = r2(fixtures.reduce((s, x) => s + FIXTURES[x.kind].N, 0));
  const sumQ0 = r2(fixtures.reduce((s, x) => s + FIXTURES[x.kind].q, 0));
  const K = O.K ?? kForN(Ntot);
  const q = Math.round(supplyFlow(Ntot, O.a, K, sumQ0 || Infinity) * 1000) / 1000;
  const dNeed = Math.sqrt((4 * q) / 1000 / (Math.PI * O.v_max)) * 1000;
  const riserNeed = PPR.find(([, di]) => di >= dNeed)?.[0] ?? 63;
  if (riserNeed > O.pipes.riser && !options.pipes?.riser) {
    assumed.push({ item: 'supply riser', value: `PPR D${riserNeed}`, note: `q = ${q} l/s at v ≤ ${O.v_max} m/s needs ${r2(dNeed)} mm inside: larger than the D${O.pipes.riser} assumed` });
    O.pipes.riser = riserNeed;
    for (const F of out) for (const r of F.runs) if (r.to === 'down') r.dn = riserNeed;
  } else if (riserNeed > O.pipes.riser) {
    warnings.push(`supply riser D${O.pipes.riser}: q = ${q} l/s needs D${riserNeed} at v ≤ ${O.v_max} m/s`);
  }
  // rainwater (TCVN 4474:1987): the terrace and the tower roof shared out to the downpipes
  const roofArea = r2(Object.values(topF.rooms).reduce((s, poly) => s + Math.abs(polyArea(poly)) / 1e6, 0));
  const nDown = roofPipes.length;
  const rainQ = nDown ? r2((O.rain_k * (roofArea / nDown) * O.rain_q5) / 10000) : 0;
  if (rainQ > O.rain_pipe) warnings.push(`rainwater: ${rainQ} l/s a downpipe over the ${O.rain_pipe} l/s of a D${O.pipes.rain} roof drain: more downpipes`);
  const daily = r2((N * O.q_day) / 1000);
  if (O.tank / 1000 < daily) warnings.push(`tank ${O.tank} l holds less than a day (${daily} m³)`);
  // the head at the highest shower: tank bottom (on its 0.5 m stand) to the shower rose at +2.0, pipe losses not deducted
  const tankBottom = T.level + (T.height ?? 2800) + 500;
  const upper = [...out].reverse().find((F) => F.fixtures.some((x) => x.kind === 'shower'));
  const head = upper ? r2((tankBottom - (upper.level + 2000)) / 1000) : null;
  const headState = head === null ? null : head < O.head_min ? 'fail' : head < O.head_comfort ? 'low' : 'ok';
  if (headState === 'fail') warnings.push(`${upper.name}: only ${head} m of head at the shower, under the ${O.head_min} m TCVN 4513 asks for: a booster pump after the tank is needed`);
  else if (headState === 'low') warnings.push(`${upper.name}: about ${head} m of head at the shower: over the ${O.head_min} m minimum of TCVN 4513 but under ${O.head_comfort} m, the shower and the water heater work poorly: add a booster pump after the tank`);
  const drainQ = r2(q + Math.max(...fixtures.map((x) => FIXTURES[x.kind].drain), 0));
  return {
    floors: out, shafts: groups, equipment, options: O, assumed, warnings,
    rainPipes: { roof: nDown, balcony: balconyPipes.map((bp) => ({ at: bp.at, level: floors[bp.top].level ?? 0 })) },
    calc: {
      N: Ntot, sumQ0, a: O.a, K, q, dNeed: r2(dNeed), riser: O.pipes.riser, daily, tank: O.tank, tankBottom: tankBottom / 1000,
      showerLevel: upper ? (upper.level + 2000) / 1000 : null, head, headState, drainQ, people: N, septic, roofArea, nDown, rainQ,
    },
  };
}

// ---------------------------------------------------------------- drawings

/** Supply (cold, hot, valves, heaters, tank, pump, meter) or drainage (soil, waste, rain, drains, stacks, septic, manholes) plan of floor k. */
export function plumbingPlan(design, k, { mode = 'supply', offset = [0, 0], scale = 100, lang = 'vi', legendAt = null, hard = [], limit = null } = {}) {
  const F = design.floors[k];
  const O = design.options, E = design.equipment;
  const out = [], en = lang === 'en', sc = scale, h = 1.8 * sc;
  const at = (p) => add(p, offset);
  const supply = mode === 'supply';
  const labels = labelPlacer(h, hard, limit);
  // the name of a piece of equipment near it, with a leader when it has to go further out
  const equipLabel = (t, p, rMax = 30) => {
    const pl = labels.near(t, at(p), Math.max(rMax * sc, 1500), 3 * sc);
    out.push(textE(t, pl.p, h, L('plumb_text'), pl.align));
    if (pl.far) out.push(lineE(at(p), pl.p, L('plumb_text')));
  };
  const sysShown = supply ? ['cold', 'hot'] : ['soil', 'waste', 'rain'];
  const shown = F.runs.filter((x) => sysShown.includes(x.sys));
  // the names keep off the pipes, the shafts and the symbols
  const box = (p, e) => [p[0] - e, p[1] - e, p[0] + e, p[1] + e];
  for (const r of shown) for (let i = 1; i < r.pts.length; i++) labels.blockSegment(at(r.pts[i - 1]), at(r.pts[i]));
  for (const g of design.shafts) {
    const xs = g.poly.map((q) => at(q)[0]), ys = g.poly.map((q) => at(q)[1]);
    labels.taken.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  for (const q of supply ? [...F.valves.map((v) => v.at), ...F.heaters.map((x) => x.at)] : [...F.drains.map((d) => d.at), ...F.downpipes.map((d) => d.at)]) labels.taken.push(box(at(q), 1.2 * sc));
  // shafts and their stacks (drawn at their size, not under 0.9 mm on paper)
  for (const g of design.shafts) {
    out.push(polyE(g.poly.map(at), true, L('plumb_equipment')));
    const st = supply ? [['down', 'cold', O.pipes.riser], ['up', 'cold', O.pipes.up]]
      : [['soil', 'soil', O.pipes.soil], ['waste', 'waste', O.pipes.waste_stack], ...(g.stacks.rain ? [['rain', 'rain', O.pipes.rain]] : [])];
    for (const [key, sys, dn] of st) out.push({ type: 'circle', center: P(at(g.stacks[key])), radius: r2(Math.max(dn / 2, 0.45 * sc)), layer: L(SYS[sys].layer) });
    // a short code at the shaft: what it holds is in the legend
    const txt = CODE.shaft;
    const c = centroid(g.poly);
    const pl = labels.near(txt, at(c), Math.max(30 * sc, 1500), 3 * sc);
    out.push(textE(txt, pl.p, h, L('plumb_text'), pl.align));
    out.push(lineE(at(c), pl.p, L('plumb_text')));
  }
  // pipes under the ground floor slab on their own hidden-line layer
  const lineOf = (r) => polyE(r.pts.map(at), false, r.under ? L('underground') : L(SYS[r.sys].layer), { scale_linetype: true });
  for (const r of shown) out.push(lineOf(r));
  // pipe names on the longest segment of a run (system, diameter, slope): one for the trunk and one for the stubs of
  // each room and size
  const named = new Set();
  for (const r of shown) {
    const key = `${r.sys}|${r.dn}|${r.room ?? ''}|${r.under ?? ''}|${r.trunk ? 1 : 0}`;
    if (named.has(key) && !r.main && !r.label) continue;
    let best = null;
    for (let i = 1; i < r.pts.length; i++) {
      const l = dist(r.pts[i - 1], r.pts[i]);
      if (!best || l > best.l) best = { l, a: r.pts[i - 1], b: r.pts[i] };
    }
    if (!best || best.l < 8 * sc) continue;
    const slope = !supply && r.sys !== 'rain' ? ` i=${O.slopes[r.dn] ?? 2}%` : '';
    const t = `${SYS[r.sys].abbr} D${r.dn}${slope}`;
    const v = sub(best.b, best.a);
    // along the pipe, read from the bottom or the right of the sheet
    let rot = Math.atan2(v[1], v[0]) * 180 / Math.PI;
    if (rot > 90.5 || rot < -89.5) rot += rot > 0 ? -180 : 180;
    const upright = Math.abs(Math.abs(rot) - 90) < 1;
    const n = unit([-v[1], v[0]]);
    const cands = [0.5, 0.3, 0.7, 0.18, 0.82].flatMap((tt) => [1, -1].map((sg) => [at(add(add(best.a, mul(v, tt)), mul(n, sg * 1.6 * sc))), 'middle_center', upright ? 90 : 0]));
    // a pipe name that finds no free place is left out (the legend and the enlarged plans name the pipes)
    const pl = labels.place(t, cands, { optional: true });
    if (!pl) continue;
    named.add(key);
    out.push(textE(t, pl.p, h, L('plumb_text'), 'middle_center', Math.abs(rot) < 1 ? 0 : upright ? 90 : rot));
  }
  if (supply) {
    for (const x of F.fixtures) {
      out.push(sym('MCP_P_DIEM', at(x.supply), { scale: sc, layer: L('cold_water') }));
      if (x.hotAt) out.push(sym('MCP_P_DIEM', at(x.hotAt), { scale: sc, layer: L('hot_water') }));
    }
    for (const v of F.valves) out.push(sym('MCP_P_VAN', at(v.at), { scale: sc, rotation: r2(v.rot), layer: L('cold_water') }));
    for (const hh of F.heaters) out.push(sym('MCP_E_NL', at(hh.at), { scale: sc, rotation: hh.rot, layer: L('plumb_equipment') }));
    if (F.ground) {
      out.push(sym('MCP_P_DHN', at(E.meter), { scale: sc, layer: L('plumb_equipment') }));
      equipLabel(CODE.meter, E.meter);
      if (E.pump) {
        out.push(sym('MCP_E_BOM', at(E.pump), { scale: sc, layer: L('plumb_equipment') }));
        equipLabel(CODE.pump, E.pump);
      }
    }
    if (k === design.floors.length - 1 && E.tank) {
      out.push({ type: 'circle', center: P(at(E.tank.at)), radius: E.tank.d / 2, layer: ROLE.hidden, scale_linetype: true });
      out.push(lineE(at(add(E.tank.at, [-E.tank.d / 2, 0])), at(add(E.tank.at, [E.tank.d / 2, 0])), L('plumb_equipment')));
      equipLabel(CODE.tank, E.tank.at);
    }
  } else {
    for (const d of F.drains) out.push(sym('MCP_PHEU_THU', at(d.at), { layer: L(d.kind === 'floor' ? 'waste' : 'rain'), attrs: { MA: d.kind === 'floor' ? 'PT' : 'PM' } }));
    // the downpipe inside a shaft is one of its stacks
    for (const dp of F.downpipes.filter((x) => !x.shaft)) {
      out.push({ type: 'circle', center: P(at(dp.at)), radius: r2(Math.max(dp.dn / 2, 0.45 * sc)), layer: L('rain') });
    }
    if (F.ground) {
      const s = E.septic;
      out.push(polyE(s.poly.map(at), true, L('underground'), { scale_linetype: true }));
      // the two baffles: compartments 1/2, 1/4, 1/4 of the useful length
      const xa = s.c[0] - s.L / 2 + s.wall, Lu = s.inner[0];
      for (const x of [xa + Lu / 2 + s.baffle / 2, xa + Lu * 0.75 + s.baffle * 1.5]) {
        out.push(lineE(at([x, s.c[1] - s.B / 2]), at([x, s.c[1] + s.B / 2]), L('underground'), { scale_linetype: true }));
      }
      equipLabel(CODE.septic, s.c, 40);
      for (const [p, name] of [[E.hg1, 'HG1'], [E.hg2, 'HG2']]) {
        out.push(polyE([[-300, -300], [300, -300], [300, 300], [-300, 300]].map((q) => at(add(p, q))), true, L('plumb_equipment')));
        out.push(polyE([[-200, -200], [200, -200], [200, 200], [-200, 200]].map((q) => at(add(p, q))), true, L('plumb_equipment')));
        equipLabel(name, p);
      }
    }
  }
  // legend: the pipes of the floor, the symbols and what the codes stand for
  let legendBottom = null;
  if (legendAt) {
    const rows = [];
    const codeRow = (code, text) => rows.push({ draw: (p) => [textE(code, p, 2.2 * sc, L('plumb_text'), 'middle_center')], text });
    const vent = String(ventHeight(design) / 1000).replace('.', en ? '.' : ',');
    // rows of at most about 48 characters: the legend stays as wide as the notes under it
    const has = (sys) => F.runs.some((r) => r.sys === sys);
    for (const sys of sysShown) {
      if (!has(sys)) continue;
      const dns = [...new Set(F.runs.filter((r) => r.sys === sys).map((r) => r.dn))].sort((a, b) => a - b).map((d) => `D${d}`).join(', ');
      rows.push({ line: L(SYS[sys].layer), extra: { scale_linetype: true }, text: `${SYS[sys].abbr}: ${en ? SYS[sys].en : SYS[sys].vi} ${dns}` });
    }
    if (!supply && F.ground) rows.push({ line: L('underground'), extra: { scale_linetype: true }, text: en ? 'Pipes and tank under the ground floor slab' : 'Ống, bể đi ngầm dưới sàn tầng 1 (nét đứt)' });
    if (supply) {
      rows.push({ block: 'MCP_P_DIEM', layer: L('cold_water'), text: en ? 'Supply point of a fixture (cold / hot)' : 'Điểm cấp nước thiết bị (lạnh / nóng)' });
      rows.push({ block: 'MCP_P_VAN', layer: L('cold_water'), text: en ? 'Gate valve' : 'Van khóa' });
      if (F.heaters.length) rows.push({ block: 'MCP_E_NL', layer: L('plumb_equipment'), text: en ? `Water heater ${O.heater_l} L` : `Bình nóng lạnh ${O.heater_l}L` });
      codeRow(CODE.shaft, en ? `Shaft: risers D${O.pipes.riser} down, D${O.pipes.up} up to the tank` : `Hộp gen: ống cấp D${O.pipes.riser} xuống, D${O.pipes.up} lên bồn`);
      if (F.ground) {
        rows.push({ block: 'MCP_P_DHN', layer: L('plumb_equipment'), text: en ? `${CODE.meter}: water meter, from the city main` : `${CODE.meter}: đồng hồ nước, từ ống cấp TP` });
        if (E.pump) rows.push({ block: 'MCP_E_BOM', layer: L('plumb_equipment'), text: en ? `${CODE.pump}: pump ${O.pump_kw} kW with float switch` : `${CODE.pump}: máy bơm ${String(O.pump_kw).replace('.', ',')}kW, phao điện` });
      }
      if (k === design.floors.length - 1 && E.tank) codeRow(CODE.tank, en ? `Stainless tank ${O.tank} L on ${E.tank.onTower ? 'the tower roof' : 'the roof'}` : `Bồn inox ${O.tank}L đặt trên ${E.tank.onTower ? 'mái tum' : 'mái'}`);
    } else {
      codeRow(CODE.shaft, `${en ? 'Shaft: stacks' : 'Hộp gen: ống đứng'} ${SYS.soil.abbr} D${O.pipes.soil}, ${SYS.waste.abbr} D${O.pipes.waste_stack}${design.shafts.some((g) => g.stacks.rain) ? `, ${SYS.rain.abbr} D${O.pipes.rain}` : ''}`);
      if (k === design.floors.length - 1) codeRow('TH', en ? `Vents of the stacks, ${vent} m over the roof` : `Ống thông hơi cao ${vent}m trên mặt mái`);
      if (F.ground) {
        codeRow(CODE.septic, en ? `Septic tank, 3 compartments, ${E.septic.V} m³, under the slab` : `Bể tự hoại 3 ngăn V=${String(E.septic.V).replace('.', ',')}m³, dưới sàn tầng 1`);
        codeRow('HG', en ? 'Manholes 600x600; HG2 to the street sewer' : 'Hố ga 600x600; HG2 ra cống chung');
      }
      rows.push({ block: 'MCP_PHEU_THU', real: true, layer: L('waste'), text: en ? 'Floor drain D60 / roof and balcony drain D90' : 'Phễu thu sàn D60 / phễu thu mái, ban công D90' });
      if (F.downpipes.length) rows.push({ draw: (p) => [{ type: 'circle', center: P(p), radius: r2(0.9 * sc), layer: L('rain') }], text: en ? `Rainwater downpipe ${SYS.rain.abbr} D${O.pipes.rain}` : `Ống đứng thoát nước mưa ${SYS.rain.abbr} D${O.pipes.rain}` });
    }
    const lg = legend(en ? (supply ? 'WATER SUPPLY LEGEND' : 'DRAINAGE LEGEND') : (supply ? 'KÝ HIỆU CẤP NƯỚC' : 'KÝ HIỆU THOÁT NƯỚC'), rows, legendAt, sc, L('plumb_text'), L('plumb_text'));
    out.push(...lg.entities);
    legendBottom = lg.bottom;
  }
  return { entities: out, legendBottom };
}

const PLAN_NOTES = {
  vi: {
    supply: [
      'Ống cấp nước dùng ống nhựa PPR (nước lạnh PN10, nước nóng PN20), nối bằng phương pháp hàn nhiệt; đi âm tường, âm sàn.',
      'Cấp nước từ đồng hồ qua máy bơm lên bồn trên mái, từ bồn cấp xuống các tầng theo ống đứng trong hộp gen.',
      'Mỗi khu vệ sinh có van khóa riêng; điểm chờ cấp nước theo cao độ thiết bị (lavabo +0,55, sen +1,10, bồn cầu +0,20).',
      'Thử áp lực đường ống 1,5 lần áp lực làm việc, không nhỏ hơn 6 bar, trong 30 phút trước khi trát, ốp lát.',
    ],
    drainage: [
      'Ống thoát nước dùng ống uPVC, nối bằng keo; thoát xí, thoát rửa, thoát mưa đi riêng.',
      'Độ dốc ống nằm ngang: D60 i=3%, D90-D110 i=2% về phía ống đứng; ống đứng thoát xí, thoát rửa kéo dài làm ống thông hơi, cao hơn mái 0,7m (3,0m trên sân thượng có sử dụng).',
      'Thoát xí vào bể tự hoại 3 ngăn; nước rửa, nước mưa và nước sau bể tự hoại vào hố ga rồi ra cống chung.',
      'Phễu thu sàn có lưới chắn rác, ngăn mùi; sàn khu ướt dốc i=1% về phễu thu.',
    ],
  },
  en: {
    supply: ['Supply pipes PPR (cold PN10, hot PN20), heat-fused, concealed in walls and floors.', 'From the meter the pump fills the roof tank; the tank feeds the floors down the risers in the shaft.', 'A stop valve on the branch of each WC; supply points at the fixture heights (basin +0.55, shower +1.10, WC +0.20).', 'Pressure test 1.5 times the working pressure, at least 6 bar, for 30 minutes before finishing.'],
    drainage: ['Drainage uPVC, solvent welded; soil, waste and rainwater in separate systems.', 'Horizontal slopes: D60 3%, D90-D110 2% to the stacks; soil and waste stacks carried up as vents 0.7 m above the roof (3.0 m above a roof terrace in use).', 'Soil to the 3-compartment septic tank; waste, rainwater and the tank outflow to the manholes and the street sewer.', 'Floor drains with grates and traps; wet floors fall 1% to the drains.'],
  },
};
export const plumbingNotes = (mode, lang = 'vi') => (PLAN_NOTES[lang] ?? PLAN_NOTES.vi)[mode] ?? [];

// ---------------------------------------------------------------- riser diagrams

/** How far the vents rise over the roof (mm): 3 m over a roof terrace in use, else 0.7 m (TCVN 4474:1987). */
export const ventHeight = (design) => (design.equipment.terrace ? 3000 : 700);

/**
 * The supply riser diagram (sơ đồ nguyên lý cấp nước) and the drainage riser diagram (sơ đồ nguyên lý thoát nước), side
 * by side: floors as lines with their levels; the tank, the pump and the meter; per floor the branch to each fixture;
 * the soil and waste stacks with their vents, the floor branches, the septic tank and the manholes, the rain downpipes.
 */
export function plumbingRisers(design, { at = [0, 0], scale = 50, lang = 'vi' } = {}) {
  const out = [];
  const en = lang === 'en', s = scale, O = design.options;
  const T = (t, p, hh = 2.2, align = 'left', layer = L('plumb_text')) => out.push(textE(t, p, hh * s, layer, align));
  const floors = design.floors;
  const hpx = 32, W = 150;
  const yBase = at[1] - (floors.length + 2) * hpx * s;
  const lvl = (i) => yBase + i * hpx * s;
  const frame = (x0, title) => {
    floors.forEach((F, i) => {
      out.push(lineE([x0, lvl(i)], [x0 + W * s, lvl(i)], L('plumb_text')));
      T(F.name, [x0, lvl(i) + 1.5 * s], 2.5);
      T(`${F.level === 0 ? '±' : '+'}${(F.level / 1000).toFixed(3).replace('.', en ? '.' : ',')}`, [x0 + W * s, lvl(i) + 1.5 * s], 2.2, 'right');
    });
    out.push(lineE([x0, lvl(floors.length)], [x0 + W * s, lvl(floors.length)], L('plumb_text')));
    T(en ? 'ROOF' : 'MÁI', [x0, lvl(floors.length) + 1.5 * s], 2.5);
    out.push(...viewTitle(title, x0 + (W * s) / 2, yBase - 38 * s, s, L('plumb_text'), lang, 5, false));
  };
  // ---- supply
  const x0 = at[0];
  frame(x0, en ? 'WATER SUPPLY RISER DIAGRAM' : 'SƠ ĐỒ NGUYÊN LÝ CẤP NƯỚC');
  const xr = x0 + 40 * s, xu = x0 + 30 * s;
  const yTank = lvl(floors.length) + 10 * s;
  out.push(polyE([[xr - 8 * s, yTank], [xr + 8 * s, yTank], [xr + 8 * s, yTank + 9 * s], [xr - 8 * s, yTank + 9 * s]], true, L('plumb_equipment')));
  T(en ? `TANK ${O.tank} L` : `BỒN ${O.tank}L`, [xr + 10 * s, yTank + 4.5 * s], 2.2, 'middle_left');
  out.push(lineE([xr, yTank], [xr, lvl(0) + 6 * s], L('cold_water')));
  T(`PPR D${O.pipes.riser}`, [xr + 1.5 * s, lvl(floors.length) - 5 * s], 2);
  out.push(polyE([[xu, lvl(0) - 6 * s], [xu, yTank + 6 * s], [xr - 8 * s, yTank + 6 * s]], false, L('cold_water')));
  T(`${en ? 'UP' : 'ỐNG ĐẨY'} PPR D${O.pipes.up}`, [xu - 1.5 * s, lvl(1) + 10 * s], 2, 'right');
  out.push(sym('MCP_E_BOM', [xu, lvl(0) - 8 * s], { scale: s, layer: L('plumb_equipment') }));
  out.push(lineE([xu - 2 * s, lvl(0) - 8 * s], [x0 + 6 * s, lvl(0) - 8 * s], L('cold_water')));
  out.push(sym('MCP_P_DHN', [x0 + 12 * s, lvl(0) - 8 * s], { scale: s, layer: L('plumb_equipment') }));
  T(en ? 'CITY MAIN' : 'ỐNG CẤP TP', [x0 + 1 * s, lvl(0) - 13 * s], 2);
  floors.forEach((F, i) => {
    const fx = F.fixtures;
    if (!fx.length) return;
    const y = lvl(i) + 6 * s;
    out.push(lineE([xr, y], [xr + (12 + fx.length * 14) * s, y], L('cold_water')));
    out.push(sym('MCP_P_VAN', [xr + 5 * s, y], { scale: s, layer: L('cold_water') }));
    T(`D${O.pipes.branch}`, [xr + 8 * s, y + 1.2 * s], 1.8);
    fx.forEach((x, j) => {
      const px = xr + (16 + j * 14) * s;
      out.push(lineE([px, y], [px, y + 7 * s], L('cold_water')));
      out.push(sym('MCP_P_DIEM', [px, y + 7 * s], { scale: s, layer: L('cold_water') }));
      T((en ? SHORT.en : SHORT.vi)[x.kind] ?? x.kind, [px, y + 9 * s], 1.6, 'center');
    });
    if (F.heaters.length) T(en ? `+ water heater ${O.heater_l} L` : `+ bình nóng lạnh ${O.heater_l}L`, [xr + (16 + fx.length * 14) * s, y + 1.2 * s], 1.8);
  });
  // ---- drainage
  const d0 = x0 + (W + 30) * s;
  frame(d0, en ? 'DRAINAGE RISER DIAGRAM' : 'SƠ ĐỒ NGUYÊN LÝ THOÁT NƯỚC');
  const xs = d0 + 40 * s, xw = d0 + 52 * s, xm = d0 + 120 * s;
  const yTop = lvl(floors.length) + 7 * s;
  out.push(lineE([xs, yTop], [xs, lvl(0) - 6 * s], L('soil')));
  out.push(lineE([xw, yTop], [xw, lvl(0) - 6 * s], L('waste'), { scale_linetype: true }));
  T(`${SYS.soil.abbr} D${O.pipes.soil}`, [xs - 1.5 * s, lvl(floors.length) - 6 * s], 2, 'right');
  T(`${SYS.waste.abbr} D${O.pipes.waste_stack}`, [xw + 1.5 * s, lvl(floors.length) - 6 * s], 2);
  for (const x of [xs, xw]) out.push(polyE([[x - 2 * s, yTop], [x + 2 * s, yTop], [x + 2 * s, yTop + 2 * s], [x - 2 * s, yTop + 2 * s]], true, L('vent')));
  const vh = String(ventHeight(design) / 1000).replace('.', en ? '.' : ',');
  T(en ? `VENT CAPS ${vh} m ABOVE THE ${ventHeight(design) > 1000 ? 'TERRACE' : 'ROOF'}` : `CHỤP THÔNG HƠI CAO ${vh}m TRÊN ${ventHeight(design) > 1000 ? 'SÂN THƯỢNG' : 'MÁI'}`, [xw + 4 * s, yTop + 1 * s], 1.8);
  floors.forEach((F, i) => {
    const y = lvl(i) + 3 * s;
    const soil = F.fixtures.filter((x) => FIXTURES[x.kind].sys === 'soil').length;
    const waste = F.fixtures.filter((x) => FIXTURES[x.kind].sys === 'waste' && !x.drain).length + F.drains.filter((d) => d.kind === 'floor').length;
    if (soil) {
      out.push(lineE([xs - 14 * s, y], [xs, y - 1 * s], L('soil')));
      T(en ? `${soil} WC` : `${soil} bồn cầu`, [xs - 15 * s, y], 1.8, 'middle_right');
    }
    if (waste) {
      out.push(lineE([xw + 14 * s, y], [xw, y - 1 * s], L('waste'), { scale_linetype: true }));
      T(en ? `${waste} basins / drains` : `${waste} lavabo, phễu thu`, [xw + 15 * s, y], 1.8, 'middle_left');
    }
  });
  // underground: soil to the septic tank, waste and tank to HG1, HG1 to HG2 and the sewer; rain downpipes to the manholes
  const yg = lvl(0) - 12 * s;
  out.push(polyE([[xs - 10 * s, yg - 8 * s], [xs + 10 * s, yg - 8 * s], [xs + 10 * s, yg], [xs - 10 * s, yg]], true, L('plumb_equipment')));
  for (const fr of [0.5, 0.75]) out.push(lineE([xs - 10 * s + 20 * s * fr, yg - 8 * s], [xs - 10 * s + 20 * s * fr, yg], L('plumb_equipment')));
  T(en ? `SEPTIC TANK ${design.equipment.septic.V} m³` : `BỂ TỰ HOẠI ${String(design.equipment.septic.V).replace('.', ',')}m³`, [xs, yg - 11 * s], 2, 'center');
  out.push(lineE([xs, lvl(0) - 6 * s], [xs, yg], L('soil')));
  const hgx = xm - 30 * s;
  for (const [x, t] of [[hgx, 'HG1'], [xm, 'HG2']]) {
    out.push(polyE([[x - 3 * s, yg - 6 * s], [x + 3 * s, yg - 6 * s], [x + 3 * s, yg], [x - 3 * s, yg]], true, L('plumb_equipment')));
    T(t, [x, yg - 9 * s], 2, 'center');
  }
  out.push(polyE([[xw, lvl(0) - 6 * s], [xw, yg - 3 * s], [hgx - 3 * s, yg - 3 * s]], false, L('waste'), { scale_linetype: true }));
  out.push(lineE([xs + 10 * s, yg - 4 * s], [hgx - 3 * s, yg - 4 * s], L('soil')));
  out.push(lineE([hgx + 3 * s, yg - 3 * s], [xm - 3 * s, yg - 3 * s], L('waste')));
  out.push(lineE([xm + 3 * s, yg - 3 * s], [xm + 18 * s, yg - 3 * s], L('waste')));
  T(en ? 'STREET SEWER' : 'CỐNG CHUNG', [xm + 19 * s, yg - 3 * s], 2, 'middle_left');
  const dps = design.rainPipes.roof + design.rainPipes.balcony.length;
  out.push(lineE([xm - 10 * s, lvl(floors.length) + 3 * s], [xm - 10 * s, yg], L('rain'), { scale_linetype: true }));
  T(en ? `${dps} rain downpipes D${O.pipes.rain}` : `${dps} ống đứng thoát mưa D${O.pipes.rain}`, [xm - 8 * s, lvl(floors.length) - 3 * s], 1.8);
  return { entities: out };
}

// ---------------------------------------------------------------- septic tank and manhole details

/** Plan and section of the 3-compartment septic tank, and the manhole, at 1:25 (paper mm x scale, real size inside). */
export function septicDetail(design, { at = [0, 0], scale = 25, lang = 'vi' } = {}) {
  const out = [];
  const en = lang === 'en', s = scale;
  const S = design.equipment.septic;
  const [Li, Bi, Hi] = S.inner;
  const w = 220, base = 200, lean = 100, cover = 100, free = 300;
  const k = s / 25; // drawing units per mm (real size when the sheet is at 1:25)
  const X = (v) => v * k;
  const layer = L('plumb_equipment'), txt = L('plumb_text');
  const T = (t, p, hh = 2.2, align = 'left') => out.push(textE(t, p, hh * s, txt, align));
  const st = dimStyleName(s);
  const dimT = (v) => (Math.abs(k - 1) < 1e-9 ? {} : { text: String(Math.round(v)) });
  const dim = (a, b, off, dir) => out.push({ type: 'dim', kind: 'linear', from: P(a), to: P(b), offset: r2(off), layer: L('plumb_text'), style: st, ...(dir ? { direction: dir } : {}), ...dimT(dist(a, b) / k) });
  const [x0, y0] = at;
  // compartments 1/2, 1/4, 1/4 of the useful length Li between the end walls and two baffles t thick
  const t = S.baffle ?? 110;
  const Lo = Li + 2 * w + 2 * t, Bo = Bi + 2 * w;
  const xb = [w + Li / 2, w + Li * 0.75 + t]; // left faces of the baffles
  const comps = [[w, xb[0]], [xb[0] + t, xb[1]], [xb[1] + t, Lo - w]];
  // ---- plan
  const rect = (a, b, extra) => polyE([[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]], true, layer, extra);
  out.push(rect([x0, y0], [x0 + X(Lo), y0 + X(Bo)]), rect([x0 + X(w), y0 + X(w)], [x0 + X(Lo - w), y0 + X(Bo - w)]));
  out.push({ type: 'hatch', boundary: [[x0, y0], [x0 + X(Lo), y0], [x0 + X(Lo), y0 + X(Bo)], [x0, y0 + X(Bo)]].map(P), boundaries: [[[x0 + X(w), y0 + X(w)], [x0 + X(Lo - w), y0 + X(w)], [x0 + X(Lo - w), y0 + X(Bo - w)], [x0 + X(w), y0 + X(Bo - w)]].map(P)], pattern: 'ANSI31', scale: r2(0.5 * s), layer: L('plumb_equipment') });
  for (const b of xb) out.push(rect([x0 + X(b), y0 + X(w)], [x0 + X(b + t), y0 + X(Bo - w)]));
  // access covers over each compartment, inlet and outlet tees
  for (const [a, b] of comps) {
    const cx = x0 + X((a + b) / 2), cy = y0 + X(Bo / 2);
    out.push(polyE([[cx - X(250), cy - X(250)], [cx + X(250), cy - X(250)], [cx + X(250), cy + X(250)], [cx - X(250), cy + X(250)]], true, ROLE.hidden, { scale_linetype: true }));
  }
  out.push(lineE([x0 - X(600), y0 + X(Bo / 2)], [x0 + X(w + 150), y0 + X(Bo / 2)], L('soil')));
  out.push(lineE([x0 + X(Lo - w - 150), y0 + X(Bo / 2)], [x0 + X(Lo + 600), y0 + X(Bo / 2)], L('waste')));
  // short names over the stubs, clear of the width dimension beyond them
  T(en ? `IN ${SYS.soil.abbr} D110` : `VÀO ${SYS.soil.abbr} D110`, [x0 - X(300), y0 + X(Bo / 2) + 1.2 * s], 1.8, 'center');
  T(en ? 'OUT D110 → HG1' : 'RA D110 → HG1', [x0 + X(Lo + 300), y0 + X(Bo / 2) + 1.2 * s], 1.8, 'center');
  dim([x0, y0], [x0 + X(Lo), y0], -10 * s);
  for (const [a, b] of comps) dim([x0 + X(a), y0 + X(Bo)], [x0 + X(b), y0 + X(Bo)], 8 * s);
  // the overall width beyond the outlet pipe
  dim([x0 + X(Lo), y0], [x0 + X(Lo), y0 + X(Bo)], -(X(600) + 8 * s), 'vertical');
  out.push(...viewTitle(en ? 'SEPTIC TANK - PLAN' : 'MẶT BẰNG BỂ TỰ HOẠI', x0 + X(Lo / 2), y0 - 22 * s, s, txt, lang));
  // ---- section
  const sy = y0 - 70 * s - X(Hi + free + base + lean + cover);
  const H = Hi + free;
  const top = sy + X(base + H + cover);
  out.push(rect([x0 - X(100), sy - X(lean)], [x0 + X(Lo + 100), sy]));
  out.push({ type: 'hatch', boundary: [[x0 - X(100), sy - X(lean)], [x0 + X(Lo + 100), sy - X(lean)], [x0 + X(Lo + 100), sy], [x0 - X(100), sy]].map(P), pattern: 'AR-CONC', scale: r2(0.02 * s), layer });
  out.push(rect([x0, sy], [x0 + X(Lo), sy + X(base)]));
  for (const xx of [x0, x0 + X(Lo - w)]) out.push(rect([xx, sy + X(base)], [xx + X(w), sy + X(base + H)]));
  out.push(rect([x0, sy + X(base + H)], [x0 + X(Lo), top]));
  for (const b of xb) {
    const xl = x0 + X(b), xr = x0 + X(b + t);
    out.push(rect([xl, sy + X(base)], [xr, sy + X(base + H)]));
    // the passage holes in the baffles at mid depth
    out.push(polyE([[xl, sy + X(base + Hi * 0.45)], [xr, sy + X(base + Hi * 0.45)], [xr, sy + X(base + Hi * 0.6)], [xl, sy + X(base + Hi * 0.6)]], true, layer));
  }
  out.push(lineE([x0 + X(w), sy + X(base + Hi)], [x0 + X(Lo - w), sy + X(base + Hi)], ROLE.hidden, { scale_linetype: true }));
  T(en ? 'WATER LEVEL' : 'MỰC NƯỚC', [x0 + X(w + 100), sy + X(base + Hi) + 1.2 * s], 1.8);
  // tees in and out
  out.push(polyE([[x0 - X(500), sy + X(base + Hi + 100)], [x0 + X(w + 150), sy + X(base + Hi + 100)], [x0 + X(w + 150), sy + X(base + Hi - 400)]], false, L('soil')));
  out.push(polyE([[x0 + X(Lo + 500), sy + X(base + Hi - 50)], [x0 + X(Lo - w - 150), sy + X(base + Hi - 50)], [x0 + X(Lo - w - 150), sy + X(base + Hi - 450)]], false, L('waste')));
  // vent pipe through the cover
  const xv = x0 + X((comps[2][0] + comps[2][1]) / 2);
  out.push(lineE([xv, sy + X(base + Hi)], [xv, top + X(600)], L('vent'), { scale_linetype: true }));
  T(en ? 'VENT D60' : 'ỐNG THÔNG HƠI D60', [xv + 1.5 * s, top + X(500)], 1.8);
  dim([x0 + X(Lo), sy], [x0 + X(Lo), sy + X(base)], -10 * s, 'vertical');
  dim([x0 + X(Lo), sy + X(base)], [x0 + X(Lo), sy + X(base + Hi)], -10 * s, 'vertical');
  dim([x0 + X(Lo), sy + X(base + Hi)], [x0 + X(Lo), sy + X(base + H)], -10 * s, 'vertical');
  dim([x0 + X(Lo), sy + X(base + H)], [x0 + X(Lo), top], -10 * s, 'vertical');
  const notes = en ? [
    `Useful volume ${S.V} m³ (W = Wn + Wc = ${S.Wn} + ${S.Wc} = ${S.Wneed} m³ for ${design.calc.people} people; at least ${design.options.septic_min} m³).`,
    'Walls brick 220, M75 mortar, plastered 20 inside with waterproof mortar; base RC 200 B20 on lean concrete 100; cover RC 100.',
    'Compartments 1/2, 1/4, 1/4 of the length; baffles 110 thick with passage holes; inlet and outlet tees D110; vent D60 above the roof.',
    'Covers 500x500 over each compartment, sealed; empty the sludge every 1-3 years.',
    'Coordinate the position of the tank with the foundation drawings; build it before the ground slab.',
  ] : [
    `Dung tích hữu ích ${String(S.V).replace('.', ',')}m³ (W = Wn + Wc = ${String(S.Wn).replace('.', ',')} + ${String(S.Wc).replace('.', ',')} = ${String(S.Wneed).replace('.', ',')}m³ cho ${design.calc.people} người; tối thiểu ${design.options.septic_min}m³).`,
    'Tường xây gạch 220 vữa XM M75, trát trong 20 vữa XM chống thấm; đáy BTCT dày 200 B20 trên lót BT đá 4x6 dày 100; nắp BTCT dày 100.',
    'Chia 3 ngăn theo chiều dài 1/2, 1/4, 1/4; vách ngăn dày 110 có lỗ thông; ống vào, ống ra dạng chữ T D110; ống thông hơi D60 lên mái.',
    'Nắp thăm 500x500 trên mỗi ngăn, trát kín; hút bùn định kỳ 1-3 năm một lần.',
    'Vị trí bể phối hợp với bản vẽ kết cấu móng, giằng móng; thi công bể trước khi đổ sàn tầng 1.',
  ];
  out.push({ type: 'mtext', text: notes.map((t, i) => `${i + 1}. ${t}`).join('\n'), at: P([x0, sy - X(lean) - 22 * s]), height: r2(2.2 * s), width: r2(X(Lo) + 40 * s), layer: txt, style: TEXT_STYLE });
  out.push(...viewTitle(en ? 'SEPTIC TANK - SECTION' : 'MẶT CẮT BỂ TỰ HOẠI', x0 + X(Lo / 2), sy - X(lean) - 12 * s, s, txt, lang));
  // ---- manhole: plan and section beside
  const mx = x0 + X(Lo) + 60 * s, my = y0;
  out.push(rect([mx, my], [mx + X(1040), my + X(1040)]), rect([mx + X(220), my + X(220)], [mx + X(820), my + X(820)]));
  dim([mx, my], [mx + X(1040), my], -10 * s);
  out.push(...viewTitle(en ? 'MANHOLE HG - PLAN' : 'MẶT BẰNG HỐ GA', mx + X(520), my - 22 * s, s, txt, lang));
  const msy = sy;
  out.push(rect([mx, msy], [mx + X(1040), msy + X(150)]));
  for (const xx of [mx, mx + X(820)]) out.push(rect([xx, msy + X(150)], [xx + X(220), msy + X(950)]));
  out.push(rect([mx, msy + X(950)], [mx + X(1040), msy + X(1030)]));
  out.push(lineE([mx - X(400), msy + X(500)], [mx + X(220), msy + X(500)], L('waste')));
  out.push(lineE([mx + X(820), msy + X(450)], [mx + X(1440), msy + X(450)], L('waste')));
  dim([mx + X(1040), msy + X(150)], [mx + X(1040), msy + X(950)], -10 * s, 'vertical');
  T(en ? 'Inside 600x600, brick 220, RC cover 80 with a lifting hook' : 'Lòng hố 600x600, xây gạch 220, nắp BTCT dày 80 có móc', [mx, msy - 12 * s], 2);
  out.push(...viewTitle(en ? 'MANHOLE HG - SECTION' : 'MẶT CẮT HỐ GA', mx + X(520), msy - X(lean) - 22 * s, s, txt, lang));
  return { entities: out };
}

// ---------------------------------------------------------------- quantities

/** Bill of quantities: pipes by system and diameter (plan runs, risers and drops, + allowance), fittings, fixtures, equipment. */
export function plumbingQuantities(design, { lang = 'vi', allowance = 0.1 } = {}) {
  const en = lang === 'en', O = design.options;
  const rows = [];
  let n = 0;
  const head = (t) => rows.push({ head: true, item: t });
  const row = (item, unit, q, how = '', m = undefined) => rows.push({ stt: ++n, item, unit, q, how, ...(m !== undefined ? { m } : {}) });
  const pcs = en ? 'pcs' : 'cái', set = en ? 'set' : 'bộ';
  const floors = design.floors;
  const top = floors[floors.length - 1];
  // the tank stands over the top floor; the roof drains are in its floor (the terrace); the stacks rise over it as vents
  const roofLevel = top.level + (top.height ?? 2800);
  const ventTop = top.level + ventHeight(design);
  const acc = new Map();
  const add2 = (sys, dn, m) => {
    const k = `${sys}|${dn}`;
    acc.set(k, (acc.get(k) ?? 0) + m);
  };
  for (const F of floors) for (const r of F.runs) add2(r.sys, r.dn, r.pts.slice(1).reduce((s, p, i) => s + dist(r.pts[i], p), 0) / 1000);
  // risers: soil and waste stacks from the ground to 0.7 m over the roof; supply down from the tank, up from the pump
  const shafts = design.shafts.length;
  add2('soil', O.pipes.soil, shafts * ventTop / 1000);
  add2('waste', O.pipes.waste_stack, shafts * ventTop / 1000);
  // the vent of the septic tank, up the shaft
  add2('vent', O.pipes.vent, ventTop / 1000);
  add2('cold', O.pipes.riser, shafts * (roofLevel + 800) / 1000);
  add2('cold', O.pipes.up, shafts * (roofLevel + 800) / 1000);
  add2('rain', O.pipes.rain, design.rainPipes.roof * top.level / 1000 + design.rainPipes.balcony.reduce((s, b) => s + b.level / 1000, 0));
  // the vertical pieces the plans do not show: the drop to each tap (supply 0.8 m, hot 0.8 m), the trap arm of each
  // fixture and of each floor drain down to its branch under the slab (0.4 m)
  for (const F of floors) {
    for (const x of F.fixtures) {
      add2('cold', O.pipes.fixture, 0.8);
      if (x.hotAt) add2('hot', O.pipes.hot, 0.8);
      // a shower or a washer drains into its floor drain (counted below), the others have a trap arm of their own
      if (!x.drain) add2(FIXTURES[x.kind].sys, FIXTURES[x.kind].dn, 0.4);
    }
    for (const d of F.drains || []) if (!d.roof) add2('waste', O.pipes.waste, 0.4);
  }
  const SYS_ORDER = ['cold', 'hot', 'soil', 'waste', 'rain', 'vent'];
  const nm = (v) => (en ? String(v) : String(v).replace('.', ','));
  head(en ? 'PIPES' : 'ĐƯỜNG ỐNG');
  for (const sys of SYS_ORDER) {
    for (const [k, m] of [...acc.entries()].filter(([kk]) => kk.startsWith(`${sys}|`)).sort((a, b) => Number(a[0].split('|')[1]) - Number(b[0].split('|')[1]))) {
      const dn = k.split('|')[1];
      row(`${en ? SYS[sys].en : SYS[sys].vi} D${dn}`, 'm', r2(m * (1 + allowance)), `${nm(r2(m))} x ${nm(1 + allowance)}`, r2(m));
    }
  }
  head(en ? 'FITTINGS' : 'PHỤ KIỆN');
  const valves = floors.reduce((s, F) => s + F.valves.length, 0) + 3;
  row(en ? 'Gate valve PPR (branches, tank, pump)' : 'Van khóa PPR (nhánh WC, bồn, bơm)', pcs, valves);
  const fd = floors.reduce((s, F) => s + F.drains.filter((d) => d.kind === 'floor').length, 0);
  const rd = floors.reduce((s, F) => s + F.drains.filter((d) => d.kind !== 'floor').length, 0);
  if (fd) row(en ? 'Floor drain D60 with trap' : 'Phễu thu sàn D60 ngăn mùi', pcs, fd);
  if (rd) row(en ? 'Roof / balcony drain D90 with grate' : 'Phễu thu nước mưa D90 có cầu chắn rác', pcs, rd);
  row(en ? 'Vent cap D110 / D90 / D60' : 'Chụp thông hơi D110 / D90 / D60', pcs, shafts * 2 + 1);
  row(en ? 'Cleanout at the foot of each stack' : 'Lỗ thông tắc chân ống đứng', pcs, shafts * 2);
  row(en ? 'Fittings (elbows, tees, joints): 25 % of the pipe cost' : 'Phụ kiện cút, tê, măng sông: 25% giá trị ống', en ? 'lot' : 'trọn gói', 1);
  head(en ? 'FIXTURES' : 'THIẾT BỊ VỆ SINH');
  const fx = floors.flatMap((F) => F.fixtures);
  for (const kind of Object.keys(FIXTURES)) {
    const c = fx.filter((x) => x.kind === kind).length;
    if (c) row(en ? FIXTURES[kind].en : FIXTURES[kind].vi, set, c, floors.map((F) => [F.name, F.fixtures.filter((x) => x.kind === kind).length]).filter(([, cc]) => cc).map(([f, cc]) => `${f}: ${cc}`).join('; '));
  }
  head(en ? 'EQUIPMENT' : 'THIẾT BỊ');
  const heaters = floors.reduce((s, F) => s + F.heaters.length, 0);
  if (heaters) row(en ? `Water heater ${O.heater_l} L 2.5 kW` : `Bình nóng lạnh ${O.heater_l}L 2,5kW`, set, heaters);
  row(en ? `Stainless water tank ${O.tank} L with stand` : `Bồn inox ${O.tank}L kèm chân bồn`, set, 1);
  row(en ? `Pump ${O.pump_kw} kW with float switch` : `Máy bơm ${String(O.pump_kw).replace('.', ',')}kW kèm phao điện`, set, 1);
  row(en ? 'Water meter D25 (utility)' : 'Đồng hồ nước D25 (cấp nước lắp)', pcs, 1);
  head(en ? 'SEPTIC TANK AND MANHOLES' : 'BỂ TỰ HOẠI, HỐ GA');
  const S = design.equipment.septic;
  row(en ? `3-compartment septic tank, useful ${S.V} m³ (see the detail)` : `Bể tự hoại 3 ngăn, dung tích hữu ích ${String(S.V).replace('.', ',')}m³ (theo chi tiết)`, en ? 'no.' : 'bể', 1);
  row(en ? 'Manhole 600x600 with RC cover' : 'Hố ga 600x600 nắp BTCT', pcs, 2);
  return { rows };
}

/** The calculation and the bill of quantities as tables. */
export function plumbingTables(design, Q, lang = 'vi') {
  const en = lang === 'en', C = design.calc, O = design.options;
  const c = (v) => (en ? String(v) : String(v).replace('.', ','));
  const fx = design.floors.flatMap((F) => F.fixtures);
  const calc = {
    title: en ? 'WATER SUPPLY AND DRAINAGE CALCULATION' : 'BẢNG TÍNH CẤP THOÁT NƯỚC', widths: [86, 36, 20, 60],
    rows: [[en ? 'ITEM' : 'NỘI DUNG', en ? 'VALUE' : 'GIÁ TRỊ', en ? 'UNIT' : 'ĐƠN VỊ', en ? 'NOTE' : 'GHI CHÚ']],
  };
  const r = (a, b, u = '', nn = '') => calc.rows.push([a, b, u, nn]);
  r(en ? 'People' : 'Số người sử dụng', C.people, en ? 'people' : 'người');
  r(en ? 'Daily norm' : 'Tiêu chuẩn dùng nước', O.q_day, en ? 'l/person/day' : 'l/ng.ngđ', 'TCVN 4513:1988');
  r(en ? 'Daily demand Q = N q / 1000' : 'Lưu lượng ngày Q = N q / 1000', C.daily, en ? 'm³/day' : 'm³/ngđ');
  for (const kind of Object.keys(FIXTURES)) {
    const cnt = fx.filter((x) => x.kind === kind).length;
    if (cnt) r(`${en ? FIXTURES[kind].en : FIXTURES[kind].vi}: ${cnt} x N ${c(FIXTURES[kind].N)}`, r2(cnt * FIXTURES[kind].N), en ? 'equiv.' : 'đương lượng');
  }
  r(en ? 'Total equivalents N' : 'Tổng đương lượng N', C.N, en ? 'equiv.' : 'đương lượng');
  r(en ? 'Sum of the fixture flows Σq0' : 'Tổng lưu lượng các thiết bị Σq0', C.sumQ0, 'l/s');
  r('q = 0,2 · N^(1/a) + K · N  (≤ Σq0)', C.q, 'l/s', `a = ${c(C.a)}, K = ${c(C.K)}`);
  r(en ? `Riser d = √(4q / π v), v ≤ ${O.v_max} m/s` : `Ống đứng d = √(4q / π v), v ≤ ${c(O.v_max)} m/s`, `${c(C.dNeed)} → PPR D${C.riser}`, 'mm', 'PPR PN10');
  r(en ? 'Roof tank (at least one day)' : 'Bồn mái (tối thiểu 1 ngày dùng)', O.tank, 'l');
  const HEAD = {
    fail: en ? `under ${O.head_min} m: booster pump needed` : `dưới ${O.head_min} m: phải có bơm tăng áp`,
    low: en ? `over the ${O.head_min} m minimum, under ${O.head_comfort} m: booster pump advised` : `đạt tối thiểu ${O.head_min} m, dưới ${O.head_comfort} m: nên lắp bơm tăng áp`,
    ok: en ? 'OK' : 'đạt',
  };
  r(en ? 'Head at the highest shower (losses not deducted)' : 'Cột áp tại vòi sen cao nhất (chưa trừ tổn thất)', C.head ?? '-', 'm', C.headState ? HEAD[C.headState] : '');
  r(en ? 'Drainage q = qc + q0 max' : 'Thoát nước q = qc + q0 max', C.drainQ, 'l/s', 'TCVN 4474:1987');
  r(en ? `Rain: roof ${c(C.roofArea)} m² on ${C.nDown} downpipes, q = K F q5 / 10000` : `Thoát mưa: mái ${c(C.roofArea)} m² chia ${C.nDown} ống đứng, q = K F q5 / 10000`, C.rainQ, en ? 'l/s a pipe' : 'l/s mỗi ống', `K = ${c(O.rain_k)}; q5 = ${O.rain_q5} l/s.ha; ${en ? 'drain' : 'phễu'} D${O.pipes.rain} ≤ ${c(O.rain_pipe)} l/s`);
  r(en ? 'Septic tank Wn = N q t / 1000 (t = 1 day)' : 'Bể tự hoại Wn = N q t / 1000 (t = 1 ngày)', C.septic.Wn, 'm³');
  r(en ? 'Sludge Wc = a T (100-W1) 0.7 1.2 N / ((100-W2) 1000)' : 'Cặn Wc = a T (100-W1) 0,7 1,2 N / ((100-W2) 1000)', C.septic.Wc, 'm³', en ? 'a 0.5 l; T 365 days; W1 95%; W2 90%' : 'a 0,5 l; T 365 ngày; W1 95%; W2 90%');
  r(en ? 'Septic tank chosen' : 'Bể tự hoại chọn', C.septic.V, 'm³', `${C.septic.inner.join(' x ')}`);
  return [calc, boqTable(en ? 'BILL OF QUANTITIES - PLUMBING' : 'BẢNG KHỐI LƯỢNG VẬT TƯ CẤP THOÁT NƯỚC', Q.rows, lang)];
}

/** The basis of the plumbing calculation (notes of the sheet), in the language of the sheet. */
export function plumbingBasis(design, lang = 'vi') {
  const O = design.options, C = design.calc, en = lang === 'en';
  const c = (v) => (en ? String(v) : String(v).replace('.', ','));
  const head = C.headState === 'fail'
    ? (en ? `The head at the highest shower is ${C.head} m, under the ${O.head_min} m TCVN 4513 asks for: a booster pump after the tank is needed.` : `Cột áp tại vòi sen cao nhất chỉ ${c(C.head)} m, nhỏ hơn ${O.head_min} m theo TCVN 4513: phải lắp bơm tăng áp sau bồn.`)
    : C.headState === 'low'
      ? (en ? `The head at the highest shower is ${C.head} m (losses not deducted): over the ${O.head_min} m minimum of TCVN 4513 but under ${O.head_comfort} m, so the shower and the water heater work poorly: a booster pump after the tank is advised.` : `Cột áp tại vòi sen cao nhất ${c(C.head)} m (chưa trừ tổn thất): đạt tối thiểu ${O.head_min} m theo TCVN 4513 nhưng dưới ${O.head_comfort} m nên sen và bình nóng lạnh hoạt động yếu: nên lắp bơm tăng áp sau bồn.`)
      : null;
  return (en ? [
    `Supply (TCVN 4513:1988, dwellings): q = 0.2 N^(1/a) + K N with a = ${O.a} for ${O.q_day} l/person/day (table 9) and K = ${C.K} (table 10); fixture equivalents by table 2 (1 equivalent = 0.2 l/s).`,
    `Riser sized for v ≤ ${O.v_max} m/s; cold water PPR PN10, hot water PPR PN20.`,
    head,
    'Drainage (TCVN 4474:1987): q = qc + q0 max (the WC cistern 1.6 l/s); soil, waste and rainwater in separate systems.',
    `Rainwater: Q = K F q5 / 10000 with K = ${O.rain_k}, q5 = ${O.rain_q5} l/s.ha (5 minute rain, give the value of the site); a D${O.pipes.rain} roof drain takes ${O.rain_pipe} l/s.`,
    'Septic tank: W = Wn + Wc, at least the minimum volume; three compartments 1/2, 1/4, 1/4.',
  ] : [
    `Cấp nước (TCVN 4513:1988, nhà ở): q = 0,2 · N^(1/a) + K · N với a = ${c(O.a)} ứng với ${O.q_day} l/người.ngđ (bảng 9), K = ${c(C.K)} (bảng 10); đương lượng thiết bị theo bảng 2 (1 đương lượng = 0,2 l/s).`,
    `Ống đứng chọn theo vận tốc v ≤ ${c(O.v_max)} m/s; nước lạnh PPR PN10, nước nóng PPR PN20.`,
    head,
    'Thoát nước (TCVN 4474:1987): q = qc + q0 max (bồn cầu két nước 1,6 l/s); thoát xí, thoát rửa, thoát mưa đi riêng.',
    `Thoát mưa: Q = K F q5 / 10000 với K = ${c(O.rain_k)}, q5 = ${O.rain_q5} l/s.ha (mưa 5 phút, lấy theo địa phương); một phễu D${O.pipes.rain} thoát ${c(O.rain_pipe)} l/s.`,
    'Bể tự hoại: W = Wn + Wc, không nhỏ hơn dung tích tối thiểu; chia 3 ngăn 1/2, 1/4, 1/4.',
  ]).filter(Boolean);
}
