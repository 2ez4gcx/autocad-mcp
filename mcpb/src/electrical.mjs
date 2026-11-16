// Electrical set (mm): the devices of every floor placed from the plan (lights by the ceiling rules of the interior set,
// switches by the doors, sockets by the kind of room, air conditioners sized on the floor area, water heaters, hob, pump,
// data and TV outlets), the boards by the stair, the circuits of each board with their loads, breakers and cables, and
// the drawings: lighting and power plans with the wiring, the single-line diagram with the board schedules, the riser
// diagram and the earthing detail. Defaults: QCVN 12:2014/BXD, TCVN 9206:2012, TCVN 9207:2012. Pure geometry and
// numbers: returns draw_entities specs.
import { polyArea } from './interior.mjs';
import {
  add, arcE, boqTable, centroid, chain, deg, dist, doorFace, dot, facePoint, faceU, floorDoors, inside, isOutdoor, labelPlacer, legend,
  lineE, mergeOptions, mul, oppositeFaces, P, planModel, polyE, pumpSpot, r2, roomFaces, roomKind, runMid, sideFaces, sub, takeSpot, textE, unit,
} from './mep.mjs';
import { dimStyleName, ROLE, TEXT_STYLE, viewTitle } from './standards.mjs';
import { sym } from './symbols.mjs';

/** Defaults of the electrical design (every one reported in assumed when not given). */
export const E_DEFAULTS = {
  voltage: 220, cosphi: 0.85, rho: 0.0225,
  // mounting heights (mm above the finished floor)
  heights: { switch: 1250, socket: 400, counter: 1100, ac: 2200, heater: 2000, wp: 1250, washer: 1200, hob: 600, data: 400, board: 1500 },
  max_lights: 10, max_sockets: 8, btu_per_m2: 600,
  // installed power (W)
  power: { downlight: 9, ceiling_lamp: 24, pendant: 40, strip_m: 10, wall_light: 12, fan: 30, socket: 300, counter: 500, wp: 300, fridge: 200, hood: 200, washer: 2000, heater: 2500, hob: 4000, pump: 750 },
  // demand factors by kind of circuit; between the floor boards at the main board
  ks: { light: 0.8, socket: 0.2, ac: 0.7, heater: 0.4, hob: 0.6, pump: 1 },
  kdt: 0.6,
};

export const AC_SIZES = [9000, 12000, 18000, 24000];
/** Breaker ratings (A) and copper PVC cables in conduit, two loaded cores: current capacity Iz (A) by section (mm²). */
export const RATINGS = [6, 10, 16, 20, 25, 32, 40, 50, 63, 80, 100];
export const CABLES = [[1.5, 17.5], [2.5, 24], [4, 32], [6, 41], [10, 57], [16, 76], [25, 101], [35, 125]];
const PE = { 1.5: 1.5, 2.5: 2.5, 4: 4, 6: 4, 10: 6, 16: 10, 25: 16, 35: 16 };
const fmtS = (s, lang) => (lang === 'en' ? String(s) : String(s).replace('.', ','));
/** A cable: 2 cores and the earth, the decimal mark of the language (2x2,5+E2,5; 2x2.5+E2.5). */
export const cableText = (S, lang = 'vi') => `2x${fmtS(S, lang)}+E${fmtS(PE[S] ?? S, lang)}`;

/**
 * The codes of a set in its language: boards (TĐ-1 / DB-1, the main TĐ-T / MDB), dedicated circuits (ĐH / AC air
 * conditioner, NL / WH water heater, BT / CK hob, BN / PU pump; L lighting, S sockets in both) and the symbols of the
 * load calculation (Ptt, Itt, Kđt / Pd, Id, Kd). An electrical design keeps the codes of its language (design.codes).
 */
export const ECODE = {
  vi: { board: 'TĐ-', main: 'TĐ-T', ac: 'ĐH', heater: 'NL', hob: 'BT', pump: 'BN', P: 'Ptt', I: 'Itt', kdt: 'Kđt' },
  en: { board: 'DB-', main: 'MDB', ac: 'AC', heater: 'WH', hob: 'CK', pump: 'PU', P: 'Pd', I: 'Id', kdt: 'Kd' },
};
const codesOf = (design) => design.codes ?? ECODE.vi;

/** Circuits by kind: breaker, cable, name. */
const CIRCUIT = {
  light: { prefix: 'L', breaker: 'MCB 1P', rating: 10, S: 1.5, vi: 'Chiếu sáng', en: 'Lighting', layer: 'light_wire' },
  socket: { prefix: 'S', breaker: 'RCBO 1P 30mA', rating: 20, S: 2.5, vi: 'Ổ cắm', en: 'Sockets', layer: 'power_wire' },
  ac: { prefix: 'ĐH', breaker: 'MCB 1P', rating: 16, S: 2.5, vi: 'Điều hòa', en: 'Air conditioner', layer: 'power_wire' },
  heater: { prefix: 'NL', breaker: 'RCBO 1P 30mA', rating: 20, S: 2.5, vi: 'Bình nóng lạnh', en: 'Water heater', layer: 'power_wire' },
  hob: { prefix: 'BT', breaker: 'MCB 1P', rating: 32, S: 4, vi: 'Bếp từ', en: 'Induction hob', layer: 'power_wire' },
  pump: { prefix: 'BN', breaker: 'MCB 1P', rating: 16, S: 2.5, vi: 'Bơm nước', en: 'Water pump', layer: 'power_wire' },
};

/** Device kinds: block, real size or paper mm, layer role, plan (lighting / power / comm), description. */
export const DEVICES = {
  downlight: { block: 'MCP_DEN_DOWNLIGHT', real: true, layer: 'light', plan: 'lighting', vi: 'Đèn LED downlight âm trần 9W', en: 'LED downlight 9 W' },
  ceiling_lamp: { block: 'MCP_DEN_OP_TRAN', real: true, layer: 'light', plan: 'lighting', vi: 'Đèn LED ốp trần 24W', en: 'LED ceiling lamp 24 W' },
  pendant: { block: 'MCP_DEN_THA', real: true, layer: 'light', plan: 'lighting', vi: 'Đèn thả 40W', en: 'Pendant 40 W' },
  strip: { layer: 'light_strip', plan: 'lighting', vi: 'Đèn LED dây hắt trần 10W/m', en: 'LED cove strip 10 W/m' },
  wall_light: { block: 'MCP_DEN_TUONG', real: true, rotate: true, layer: 'light', plan: 'lighting', vi: 'Đèn gắn tường ngoài trời IP65 12W, cao +2,20', en: 'Outdoor wall light IP65 12 W, +2.20' },
  fan: { block: 'MCP_E_QH', layer: 'light', plan: 'lighting', vi: 'Quạt hút âm trần 30W', en: 'Ceiling extract fan 30 W' },
  switch: { layer: 'switch', rotate: true, plan: 'lighting', vi: 'Công tắc 1-4 hạt, cao +1,25', en: 'Switch 1-4 gang, +1.25' },
  switch2: { block: 'MCP_E_CT_2C', layer: 'switch', rotate: true, plan: 'lighting', vi: 'Công tắc 2 chiều (cầu thang), cao +1,25', en: 'Two-way switch (stairs), +1.25' },
  socket: { block: 'MCP_E_OC', layer: 'power', rotate: true, plan: 'power', vi: 'Ổ cắm đôi 3 chấu 16A, cao +0,40', en: 'Double socket 16 A, +0.40' },
  counter: { block: 'MCP_E_OC_BEP', layer: 'power', rotate: true, plan: 'power', vi: 'Ổ cắm đôi trên mặt bếp, cao +1,10', en: 'Worktop socket, +1.10' },
  high: { block: 'MCP_E_OC_CAO', layer: 'power', rotate: true, plan: 'power', vi: 'Ổ cắm đơn (điều hòa +2,20; bình nóng lạnh +2,00)', en: 'Single socket (air conditioner +2.20, water heater +2.00)' },
  wp: { block: 'MCP_E_OC_CN', layer: 'power', rotate: true, plan: 'power', vi: 'Ổ cắm chống nước có nắp (WC +1,25; máy giặt +1,20)', en: 'Weatherproof socket (WC +1.25, washer +1.20)' },
  hob: { block: 'MCP_E_BT', layer: 'power', rotate: true, plan: 'power', vi: 'Đầu chờ bếp từ, cao +0,60', en: 'Hob outlet, +0.60' },
  ac: { block: 'MCP_E_DH', layer: 'elec_equipment', rotate: true, plan: 'power', vi: 'Dàn lạnh điều hòa treo tường', en: 'Wall air conditioner (indoor unit)' },
  heater: { block: 'MCP_E_NL', layer: 'elec_equipment', rotate: true, plan: 'power', vi: 'Bình nóng lạnh 30L 2,5kW', en: 'Water heater 30 L 2.5 kW' },
  pump: { block: 'MCP_E_BOM', layer: 'elec_equipment', plan: 'power', vi: 'Máy bơm nước 0,75kW', en: 'Water pump 0.75 kW' },
  data: { block: 'MCP_E_MANG', layer: 'comm', rotate: true, plan: 'power', vi: 'Ổ cắm mạng RJ45 Cat6, cao +0,40', en: 'Data outlet RJ45 Cat6, +0.40' },
  tv: { block: 'MCP_E_TV', layer: 'comm', rotate: true, plan: 'power', vi: 'Ổ cắm truyền hình, cao +0,40', en: 'TV outlet, +0.40' },
  board: { block: 'MCP_E_TD', layer: 'elec_equipment', rotate: true, plan: 'both', vi: 'Tủ điện, đáy tủ cao +1,50', en: 'Distribution board, bottom +1.50' },
  network: { block: 'MCP_E_TM', layer: 'comm', rotate: true, plan: 'power', vi: 'Tủ mạng, truyền hình (modem, switch)', en: 'Data and TV cabinet' },
  meter: { block: 'MCP_E_CTO', layer: 'elec_equipment', rotate: true, plan: 'power', vi: 'Công tơ điện 1 pha (điện lực lắp)', en: 'Single-phase meter (utility)' },
};
const LIGHT_CODES = { downlight: 'LT-01', ceiling_lamp: 'LT-03', pendant: 'LT-04', wall_light: 'LT-05' };
const LIGHT_KINDS = ['downlight', 'ceiling_lamp', 'pendant', 'strip', 'wall_light', 'fan'];
const GROUP_OF = { downlight: 'downlight', ceiling_lamp: 'lamp', pendant: 'lamp', strip: 'strip', wall_light: 'wall', fan: 'fan' };
const AC_ROOMS = ['bedroom', 'living', 'office', 'dining'];

/**
 * The electrical design of a building. floors: [{name, height, spec, rooms {name: outline}, items (placed furniture),
 * lights [{kind, at, points?, length?}] (the lighting layout of the ceiling rules)}]. Returns {floors: [{name, board,
 * devices, circuits}], boards, assumed, warnings}.
 */
export function electricalDesign({ floors, options = {}, lang = 'vi' }) {
  const O = mergeOptions(E_DEFAULTS, options);
  const assumed = [], warnings = [];
  const note = (item, value, n) => assumed.push({ item, value, ...(n ? { note: n } : {}) });
  if (!options.voltage) note('supply', `1 phase ${O.voltage} V from the utility meter at the front`, 'QCVN 12:2014/BXD');
  if (!options.heights) note('heights', 'switches +1.25, sockets +0.40, worktop +1.10, air conditioner +2.20, water heater +2.00, WC +1.25, washer +1.20, hob +0.60, boards +1.50');
  if (!options.max_lights) note('max_lights', `${O.max_lights} lights a circuit (MCB 1P 10A, 2x1.5)`);
  if (!options.max_sockets) note('max_sockets', `${O.max_sockets} sockets a circuit (RCBO 1P 20A 30mA, 2x2.5+E2.5)`);
  const K = ECODE[lang] ?? ECODE.vi;
  if (!options.btu_per_m2) note('air conditioners', `${O.btu_per_m2} BTU/m² in bedrooms, living and dining rooms: ${AC_SIZES.join(' / ')} BTU`);
  let nid = 0;
  const id = () => `E${++nid}`;
  // which floors have a board: those with rooms other than stairs and open spaces (a stair tower takes the board below)
  const hasBoard = floors.map((f) => Object.keys(f.rooms).some((n) => !['stair', 'terrace', 'outdoor', 'laundry'].includes(roomKind(n))));
  const out = [];
  let lastBoard = null;
  floors.forEach((f, k) => {
    const M = planModel(f.spec);
    const doors = floorDoors(M, f.spec, f.rooms);
    const rooms = Object.entries(f.rooms).map(([name, poly]) => ({
      name, poly, kind: roomKind(name), faces: roomFaces(poly, M), area: Math.abs(polyArea(poly)) / 1e6,
      doors: doors.filter((d) => d.sides[name]), items: (f.items || []).filter((it) => it.room === name),
    }));
    const byName = Object.fromEntries(rooms.map((r) => [r.name, r]));
    const devices = [];
    const dev = (kind, at, room, extra = {}) => {
      const d = { id: id(), kind, at: P(at), room, floor: k, ...extra };
      devices.push(d);
      return d;
    };
    const onFace = (fc, u, kind, room, extra = {}, gap = 350) => {
      const x = takeSpot(fc, u, gap);
      if (x === null) return null;
      return dev(kind, facePoint(fc, x, 0), room, { rot: deg(fc.inw), face: fc, ...extra });
    };
    // spots on the other walls of a room, nearest first: where the wall of a door has no room for a device (an opening
    // as wide as the wall, as at the foot of an open stair). to: the point to stay near; by: what ranks the walls
    const nearSpots = (R, to, not, min, by = to) => R.faces.filter((x) => x !== not).flatMap((x) => x.runs.filter(([a, b]) => b - a >= min).map(([a, b]) => {
      const u = Math.max(a + min / 2, Math.min(b - min / 2, faceU(x, to)));
      return { fc: x, u, dd: dist(facePoint(x, u, 0), by) };
    })).sort((q, t) => q.dd - t.dd);
    // ---- the board (and on the ground floor the main board, the data cabinet and the meter)
    let board = null;
    if (hasBoard[k]) {
      const stair = rooms.find((r) => r.kind === 'stair');
      const cands = [];
      for (const d of doors) {
        if (stair && !d.sides[stair.name]) continue;
        for (const [name] of Object.entries(d.sides)) {
          const R = byName[name];
          if (!R || R.kind === 'stair' || isOutdoor(R.kind) || R.kind === 'wc') continue;
          const fc = doorFace(R.faces, d);
          if (fc) cands.push({ R, fc, d });
        }
      }
      if (!cands.length) {
        // no stair: inside the main entrance
        const ent = doors.filter((d) => d.outside && Object.keys(d.sides).length).sort((a, b) => b.width - a.width)[0];
        if (ent) {
          const R = byName[Object.keys(ent.sides)[0]];
          const fc = doorFace(R.faces, ent);
          if (fc) cands.push({ R, fc, d: ent });
        }
      }
      const c = cands[0];
      const bid = `${K.board}${k + 1}`;
      if (c) {
        const u0 = faceU(c.fc, c.d.from), u1 = faceU(c.fc, c.d.to);
        const ua = Math.min(u0, u1), ub = Math.max(u0, u1);
        const roomAfter = c.fc.runs.filter(([a]) => a >= ub - 1).reduce((s, [a, b]) => s + b - a, 0);
        const roomBefore = c.fc.runs.filter(([, b]) => b <= ua + 1).reduce((s, [a, b]) => s + b - a, 0);
        const sgn = roomAfter >= roomBefore ? 1 : -1;
        let fcB = c.fc, base = sgn > 0 ? ub + 600 : ua - 600, sg = sgn;
        board = onFace(fcB, base, 'board', c.R.name, { label: bid, z: O.heights.board }, 750);
        if (!board) {
          // no room on the wall of that door (a stair open across its whole width): the nearest other wall of the room,
          // the walls by the stair first, at their end towards the foot of the stair
          for (const a of nearSpots(c.R, c.d.mid, c.fc, 900, stair ? centroid(stair.poly) : c.d.mid)) {
            board = onFace(a.fc, a.u, 'board', c.R.name, { label: bid, z: O.heights.board }, 750);
            if (!board) continue;
            fcB = a.fc;
            base = a.u;
            sg = a.u >= faceU(a.fc, c.d.mid) ? 1 : -1;
            break;
          }
        }
        if (k === 0 && board) {
          // the main board beside it; where that wall has no more room, on the nearest other wall of the room
          const MAIN = { label: K.main, z: O.heights.board, isMain: true };
          const um = takeSpot(fcB, base + sg * 750, 750) ?? takeSpot(fcB, base - sg * 750, 750);
          if (um !== null) board.main = dev('board', facePoint(fcB, um, 0), c.R.name, { rot: deg(fcB.inw), ...MAIN });
          else {
            const alt = c.R.faces.filter((x) => x !== fcB && x.run >= 600).sort((p, q) => dist(facePoint(p, runMid(p)), board.at) - dist(facePoint(q, runMid(q)), board.at))[0];
            board.main = (alt && onFace(alt, runMid(alt), 'board', c.R.name, MAIN, 750)) ?? dev('board', add(board.at, mul(fcB.inw, 400)), c.R.name, { rot: deg(fcB.inw), ...MAIN });
          }
          board.network = onFace(fcB, base + sg * 1500, 'network', c.R.name, { label: lang === 'en' ? 'DATA' : 'TỦ MẠNG' }, 650);
        }
      }
      if (!board) {
        warnings.push(`${f.name}: no wall by the stair or the entrance for the board: placed at the middle of ${rooms[0]?.name}`);
        const R = rooms.find((r) => r.kind !== 'stair') ?? rooms[0];
        board = dev('board', centroid(R.poly), R.name, { rot: 0, label: bid, z: O.heights.board });
      }
      board.board = bid;
      lastBoard = bid;
      if (k === 0) {
        // the meter on the outside of the front wall, beside the main entrance
        const ent = doors.filter((d) => d.outside).sort((a, b) => b.width - a.width)[0];
        if (ent) {
          // on the wall beside the door, clear of the other openings of that wall and of its ends
          const o = ent.outside, s0 = M.openings[ent.i].s;
          const spans = M.openings.filter((x) => x.s === s0).map((x) => [x.span.from, x.span.to]);
          const at0 = (ent.from[0] - s0.a[0]) * s0.d[0] + (ent.from[1] - s0.a[1]) * s0.d[1];
          const cands = [350, 450, 700, 900].flatMap((g2) => [at0 - g2, at0 + ent.width + g2]).filter((t) => t > 200 && t < s0.L - 200
            && !spans.some(([a, b]) => t > a - 250 && t < b + 250));
          const t = cands[0] ?? at0 + ent.width + 900;
          const p = add(add(s0.a, mul(s0.d, t)), mul(o.inw, Math.abs(o.face)));
          board.meter = dev('meter', p, null, { rot: deg(o.inw), label: lang === 'en' ? 'METER' : 'CÔNG TƠ' });
        }
      }
    } else if (!lastBoard) {
      warnings.push(`${f.name}: no board on this or a lower floor`);
    }
    const served = board?.board ?? lastBoard;
    // the riser where the circuits of a floor without a board come up (by the stair)
    let riser = null;
    if (!board) {
      const stair = rooms.find((r) => r.kind === 'stair') ?? rooms[0];
      const fc = stair?.faces[0];
      riser = fc ? facePoint(fc, runMid(fc), 300) : stair ? centroid(stair.poly) : null;
    }

    // ---- lights: the ceiling layout, then the stair lamp, extract fans and outdoor wall lights
    const lights = [];
    for (const l of f.lights || []) {
      const R = rooms.find((r) => inside(l.at, r.poly));
      if (!R) continue;
      lights.push(dev(l.kind, l.at, R.name, l.kind === 'strip' ? { points: l.points, length: l.length } : {}));
    }
    for (const R of rooms) {
      const mine = lights.filter((d) => d.room === R.name);
      if (R.kind === 'stair' && !mine.length) lights.push(dev('ceiling_lamp', centroid(R.poly), R.name));
      if (R.kind === 'wc') {
        // the fan away from the door and clear of the lights
        const door = R.doors[0];
        const c = centroid(R.poly);
        const away = door ? unit(sub(c, door.mid)) : [0, 1];
        let p = add(c, mul(away, 350));
        if (!inside(p, R.poly) || mine.some((m) => dist(m.at, p) < 350)) p = add(c, mul([-away[1], away[0]], 400));
        lights.push(dev('fan', p, R.name));
      }
      if (isOutdoor(R.kind) && !mine.length) {
        for (const d of R.doors) {
          const fc = doorFace(R.faces, d);
          if (!fc) continue;
          const u = Math.max(faceU(fc, d.from), faceU(fc, d.to)) + 350;
          const l = onFace(fc, u, 'wall_light', R.name, { z: 2200 }, 300);
          if (l) lights.push(l);
          break;
        }
      }
    }
    // balconies outside the walls: a wall light beside the door that opens onto each
    for (const b of f.spec.balconies || []) {
      const [[x0, y0], [x1, y1]] = b.region;
      const inReg = (p) => p[0] > Math.min(x0, x1) && p[0] < Math.max(x0, x1) && p[1] > Math.min(y0, y1) && p[1] < Math.max(y0, y1);
      const d = doors.find((x) => x.outside && inReg(add(x.mid, mul(x.outside.inw, Math.abs(x.outside.face) + 300))));
      if (!d) continue;
      const host = Object.keys(d.sides)[0];
      const p = add(add(d.mid, mul(d.outside.inw, Math.abs(d.outside.face))), mul(d.d, d.width / 2 + 450));
      lights.push(dev('wall_light', p, host, { rot: deg(d.outside.inw), z: 2200, balcony: true, door: d }));
    }

    // ---- switches: one per room (WC and open spaces: on the inside of their door), one gang per group of lights
    const switches = [];
    for (const R of rooms) {
      const mine = lights.filter((d) => d.room === R.name && !d.balcony);
      const balc = lights.filter((d) => d.room === R.name && d.balcony);
      if (!mine.length && !balc.length) continue;
      const groups = new Map();
      for (const l of mine) {
        const g = GROUP_OF[l.kind];
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(l);
      }
      // groups of more lights than a circuit takes are split, each on its own gang
      const gangs = [];
      for (const [g, ls] of groups) {
        const n = Math.ceil(ls.length / O.max_lights);
        const sorted = [...ls].sort((a, b) => a.at[0] + a.at[1] * 0.001 - (b.at[0] + b.at[1] * 0.001));
        for (let i = 0; i < n; i++) gangs.push({ g, lights: sorted.slice(Math.round((i * ls.length) / n), Math.round(((i + 1) * ls.length) / n)) });
      }
      for (const l of balc) gangs.push({ g: 'balcony', lights: [l], door: l.door });
      // where: WC and outdoor spaces on the far side of their door (inside), the others by their main door
      const inside0 = R.kind === 'wc' || isOutdoor(R.kind);
      const pick = (list) => list.sort((a, b) => (b.outside ? 1 : 0) - (a.outside ? 1 : 0) || b.width - a.width)[0];
      let door = R.kind === 'living' || R.kind === 'hall' ? pick([...R.doors]) : R.doors.find((d) => Object.keys(d.sides).some((n) => n !== R.name && ['stair', 'hall', 'living'].includes(byName[n]?.kind))) ?? pick([...R.doors]);
      let host = R;
      if (inside0 && door) {
        const other = Object.keys(door.sides).find((n) => n !== R.name);
        if (other && !isOutdoor(byName[other].kind)) host = byName[other];
      }
      const place = (list, d0, kind) => {
        const d = d0 ?? door;
        let fc = d ? doorFace(host.faces, d) : null;
        let u;
        if (fc) {
          const latch = d.type === 'door' ? (d.hinge === 'from' ? d.to : d.from) : null;
          const uf = faceU(fc, d.from), ut = faceU(fc, d.to);
          const um = (uf + ut) / 2;
          const ul = latch ? faceU(fc, latch) : (fc.runs.filter(([a]) => a >= Math.max(uf, ut)).length ? Math.max(uf, ut) : Math.min(uf, ut));
          u = ul + Math.sign(ul - um || 1) * 250;
        } else {
          fc = host.faces[0];
          u = fc ? fc.longest[0] + 200 : 0;
        }
        if (!fc) return null;
        const more = { gangs: list.length, controls: list, z: O.heights.switch };
        let sw = onFace(fc, u, kind, host.name, more, 300);
        // no room beside that door on its wall (an opening as wide as the wall): the nearest other wall of the room
        if (!sw && d) {
          for (const a of nearSpots(host, d.mid, fc, 400)) {
            sw = onFace(a.fc, a.u, kind, host.name, more, 300);
            if (sw) break;
          }
        }
        if (sw) switches.push(sw);
        return sw;
      };
      if (R.kind === 'stair') {
        for (const gg of gangs) for (const l of gg.lights) l.switch = place([gg], null, 'switch2');
        continue;
      }
      const own = gangs.filter((g) => g.g !== 'balcony');
      for (let i = 0; i < own.length; i += 4) {
        const sw = place(own.slice(i, i + 4), null, 'switch');
        for (const gg of own.slice(i, i + 4)) for (const l of gg.lights) l.switch = sw;
      }
      for (const gg of gangs.filter((g) => g.g === 'balcony')) {
        host = R;
        const sw = place([gg], gg.door, 'switch');
        for (const l of gg.lights) l.switch = sw;
      }
    }
    for (const sw of switches) {
      if (sw.kind === 'switch') sw.block = `MCP_E_CT_${Math.min(4, sw.gangs)}`;
    }

    // ---- sockets and equipment by the kind of room
    const H = O.heights;
    const faceOf = (R, it) => R.faces.find((fc) => dot(fc.inw, it.ey) > 0.9 && Math.abs(dot(sub(it.o, fc.e.a), fc.F.n)) < 150) ?? null;
    const itemU = (fc, it, x) => faceU(fc, add(it.o, mul(it.ex, x)));
    for (const R of rooms) {
      const mainDoor = R.doors.sort((a, b) => b.width - a.width)[0];
      const doorFc = mainDoor ? doorFace(R.faces, mainDoor) : null;
      const notDoor = R.faces.filter((fc) => fc !== doorFc);
      const it = (type) => R.items.find((x) => x.type === type);
      const ac = (avoid = []) => {
        if (!AC_ROOMS.includes(R.kind) && !(R.kind === 'kitchen' && /ĂN|DINING/i.test(R.name))) return;
        const need = R.area * O.btu_per_m2;
        const btu = AC_SIZES.find((s) => s >= need) ?? AC_SIZES[AC_SIZES.length - 1];
        if (need > AC_SIZES[AC_SIZES.length - 1] * 1.1) warnings.push(`${f.name} ${R.name}: ${Math.round(need)} BTU needed, one ${btu} BTU unit drawn: consider two units`);
        const fcs = R.faces.filter((fc) => fc !== doorFc && !avoid.includes(fc) && fc.run >= 1100);
        const fc = fcs.find((x) => avoid.length && avoid.some((a) => Math.abs(dot(a.inw, x.inw)) < 0.01)) ?? fcs[0] ?? R.faces[0];
        if (!fc) return;
        const u = runMid(fc);
        const unitDev = onFace(fc, u, 'ac', R.name, { btu, power: btu / 10, z: H.ac }, 1000);
        if (unitDev) unitDev.socket = onFace(fc, u + 750, 'high', R.name, { z: H.ac, for: 'ac' }, 300);
      };
      switch (R.kind) {
        case 'bedroom': {
          const bed = it('bed');
          const bedFc = (bed && faceOf(R, bed)) ?? notDoor.find((fc) => fc.run >= 1800) ?? R.faces[0];
          if (!bedFc) break;
          const ub = bed ? itemU(bedFc, bed, bed.w / 2) : runMid(bedFc);
          const half = bed ? bed.w / 2 + 300 : 1150;
          onFace(bedFc, ub - half, 'socket', R.name, { z: H.socket });
          onFace(bedFc, ub + half, 'socket', R.name, { z: H.socket });
          const tvFc = oppositeFaces(R.faces, bedFc).sort((a, b) => b.run - a.run)[0] ?? sideFaces(R.faces, bedFc)[0];
          if (tvFc) {
            const m = runMid(tvFc);
            onFace(tvFc, m - 200, 'tv', R.name, { z: H.data }, 300);
            onFace(tvFc, m + 200, 'data', R.name, { z: H.data }, 300);
          }
          const desk = it('desk');
          const deskFc = desk ? faceOf(R, desk) : null;
          if (deskFc) onFace(deskFc, itemU(deskFc, desk, desk.w / 2), 'socket', R.name, { z: H.socket });
          else {
            const fc = sideFaces(R.faces, bedFc).filter((x) => x !== doorFc).sort((a, b) => b.run - a.run)[0] ?? tvFc;
            if (fc) onFace(fc, fc.longest[0] + 450, 'socket', R.name, { z: H.socket });
          }
          ac([bedFc]);
          break;
        }
        case 'living':
        case 'office':
        case 'dining': {
          const tvFc = notDoor[0] ?? R.faces[0];
          if (!tvFc) break;
          const m = runMid(tvFc);
          onFace(tvFc, m - 200, 'tv', R.name, { z: H.data }, 300);
          onFace(tvFc, m + 200, 'data', R.name, { z: H.data }, 300);
          onFace(tvFc, m + 750, 'socket', R.name, { z: H.socket });
          const opp = oppositeFaces(R.faces, tvFc).sort((a, b) => b.run - a.run)[0];
          if (opp) onFace(opp, runMid(opp), 'socket', R.name, { z: H.socket });
          const side = sideFaces(R.faces, tvFc).sort((a, b) => b.run - a.run)[0] ?? opp;
          if (side) onFace(side, runMid(side), 'socket', R.name, { z: H.socket });
          ac([tvFc]);
          break;
        }
        case 'kitchen': {
          const kb = it('kitchen_base');
          const kFc = (kb && faceOf(R, kb)) ?? notDoor.find((fc) => fc.run >= 1500) ?? R.faces[0];
          if (!kFc) break;
          let us, hobU;
          if (kb && kFc) {
            const avoid = [kb.opts.sink, kb.opts.hob].filter((x) => x !== undefined);
            const xs = [0.12, 0.45, 0.88].map((k2) => k2 * kb.w).map((x) => (avoid.some((a) => Math.abs(a - x) < 450) ? x + 500 : x));
            us = xs.map((x) => itemU(kFc, kb, x));
            hobU = kb.opts.hob !== undefined ? itemU(kFc, kb, kb.opts.hob) : null;
          } else {
            const [a, b] = kFc.longest;
            us = [a + 0.12 * (b - a), a + 0.45 * (b - a), a + 0.88 * (b - a)];
            hobU = a + 0.68 * (b - a);
          }
          for (const u of us) onFace(kFc, u, 'counter', R.name, { z: H.counter, kitchen: true }, 400);
          if (hobU !== null) {
            onFace(kFc, hobU, 'hob', R.name, { z: H.hob, power: O.power.hob }, 300);
            onFace(kFc, hobU + 350, 'high', R.name, { z: 2100, kitchen: true, power: O.power.hood, for: 'hood' }, 300);
          }
          const fr = it('fridge');
          const frFc = fr ? faceOf(R, fr) : null;
          if (frFc) onFace(frFc, itemU(frFc, fr, fr.w / 2), 'socket', R.name, { z: H.socket, kitchen: true, power: O.power.fridge });
          else onFace(kFc, kFc.longest[1] - 300, 'socket', R.name, { z: H.socket, kitchen: true, power: O.power.fridge });
          // the dining side of the room
          const din = oppositeFaces(R.faces, kFc).sort((a, b) => b.run - a.run)[0];
          if (din) onFace(din, runMid(din), 'socket', R.name, { z: H.socket });
          ac([kFc]);
          break;
        }
        case 'wc': {
          const van = it('vanity'), sh = it('shower');
          const vFc = van ? faceOf(R, van) : null;
          if (vFc) onFace(vFc, itemU(vFc, van, van.w + 200), 'wp', R.name, { z: H.wp });
          else {
            const fc = (doorFc ? sideFaces(R.faces, doorFc) : R.faces).sort((a, b) => b.run - a.run)[0] ?? R.faces[0];
            if (fc) onFace(fc, fc.longest[0] + 300, 'wp', R.name, { z: H.wp });
          }
          const sFc = sh ? faceOf(R, sh) : null;
          const back = sFc ?? (doorFc ? oppositeFaces(R.faces, doorFc)[0] : null) ?? R.faces[0];
          if (back) {
            const u = sh && sFc ? itemU(sFc, sh, sh.w / 2) : back.longest[1] - 450;
            const h = onFace(back, u, 'heater', R.name, { z: H.heater, power: O.power.heater }, 500);
            if (h) h.socket = onFace(back, u - 500, 'high', R.name, { z: H.heater, for: 'heater' }, 300);
          }
          break;
        }
        case 'laundry': {
          const w = it('washer');
          const wFc = w ? faceOf(R, w) : null;
          if (wFc) onFace(wFc, itemU(wFc, w, w.w / 2), 'wp', R.name, { z: H.washer, power: O.power.washer });
          else {
            const fc = notDoor[0] ?? R.faces[0];
            if (fc) onFace(fc, fc.longest[0] + 400, 'wp', R.name, { z: H.washer, power: O.power.washer });
          }
          break;
        }
        case 'terrace':
        case 'outdoor': {
          const fc = doorFc ?? R.faces[0];
          if (fc && mainDoor) onFace(fc, Math.min(faceU(fc, mainDoor.from), faceU(fc, mainDoor.to)) - 400, 'wp', R.name, { z: H.socket });
          break;
        }
        case 'hall':
        case 'storage':
        case 'room': {
          const fc = notDoor[0] ?? R.faces[0];
          if (fc) onFace(fc, runMid(fc), 'socket', R.name, { z: H.socket });
          break;
        }
        case 'worship': {
          const fc = (doorFc && oppositeFaces(R.faces, doorFc)[0]) ?? notDoor[0];
          if (fc) onFace(fc, runMid(fc), 'counter', R.name, { z: 1200 });
          break;
        }
        default:
      }
    }
    out.push({ name: f.name, height: f.height ?? 3300, level: f.level ?? 0, board, served, riser, devices, rooms: rooms.map((r) => r.name) });
  });

  // ---- stair lamps are switched from both ends of their flight: the plate of a floor also has a gang for the lamp of
  // the stair below
  for (let k = 1; k < out.length; k++) {
    const sw = out[k].devices.find((d) => d.kind === 'switch2');
    const below = out[k - 1].devices.find((d) => d.kind === 'switch2');
    if (sw && below) {
      sw.gangs = (sw.gangs ?? 1) + 1;
      sw.block = 'MCP_E_CT_2C_2';
    }
  }

  // ---- the pump: in the first laundry yard (else the first wet room) of the ground floor
  const g = out[0];
  if (g && options.pump !== false) {
    const ps = pumpSpot(floors[0].rooms, floors[0].spec);
    if (ps) {
      g.devices.push({ id: `E${++nid}`, kind: 'pump', at: ps.at, room: ps.room, floor: 0, power: O.power.pump });
      if (!options.pump) note('pump', `0,75 kW in ${ps.room} (${g.name}), own circuit from ${g.served}`);
    }
  }

  // ---- circuits by board: lighting (rooms in order, max_lights a circuit), sockets (max_sockets, the kitchen on its own),
  // one circuit for each air conditioner, water heater, hob and the pump
  const boards = new Map();
  for (const F of out) {
    if (!F.served) continue;
    if (!boards.has(F.served)) boards.set(F.served, { id: F.served, floors: [], circuits: [], at: null, floor: null });
    const B = boards.get(F.served);
    B.floors.push(F.name);
    if (F.board) {
      B.at = F.board.at;
      B.floor = F.name;
    }
  }
  const P0 = (F) => (F.board ? F.board.at : F.riser ?? [0, 0]);
  const counters = new Map();
  const newCircuit = (bid, kind) => {
    const key = `${bid}|${kind}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
    const C = { id: `${K[kind] ?? CIRCUIT[kind].prefix}${counters.get(key)}`, board: bid, kind, devices: [], floors: [] };
    boards.get(bid).circuits.push(C);
    return C;
  };
  for (const F of out) {
    if (!F.served) continue;
    const bid = F.served;
    const start = P0(F);
    const W = (d) => {
      const pw = O.power;
      if (d.kind === 'strip') return r2((d.length ?? 0) / 1000 * pw.strip_m);
      return d.power ?? pw[d.kind] ?? 0;
    };
    for (const d of F.devices) d.W = W(d);
    // lighting: groups of each switch (by room), nearest the board first
    const units = [];
    const seen = new Set();
    for (const sw of F.devices.filter((d) => d.kind === 'switch' || d.kind === 'switch2')) {
      for (const gg of sw.controls) {
        const ls = gg.lights.filter((l) => !seen.has(l.id));
        ls.forEach((l) => seen.add(l.id));
        if (ls.length) units.push({ sw, lights: ls, at: sw.at });
      }
    }
    // lights with no switch (none should be): a unit of their own
    const loose = F.devices.filter((d) => LIGHT_KINDS.includes(d.kind) && !seen.has(d.id));
    if (loose.length) units.push({ sw: null, lights: loose, at: loose[0].at });
    let C = null, n = 0;
    for (const u of chain(start, units)) {
      const pts = u.lights.length;
      if (!C || n + pts > O.max_lights) {
        C = newCircuit(bid, 'light');
        n = 0;
      }
      if (u.sw && !C.devices.includes(u.sw)) C.devices.push(u.sw);
      C.devices.push(...u.lights);
      C.units = [...(C.units ?? []), u];
      if (!C.floors.includes(F.name)) C.floors.push(F.name);
      n += pts;
    }
    // sockets
    const sockets = F.devices.filter((d) => ['socket', 'counter', 'wp'].includes(d.kind) || (d.kind === 'high' && d.for === 'hood'));
    const kitchen = sockets.filter((d) => d.kitchen);
    const rest = sockets.filter((d) => !d.kitchen);
    C = null;
    n = 0;
    for (const d of chain(start, rest)) {
      if (!C || n >= O.max_sockets) {
        C = newCircuit(bid, 'socket');
        n = 0;
        C.floors.push(F.name);
      }
      C.devices.push(d);
      n++;
    }
    if (kitchen.length) {
      C = newCircuit(bid, 'socket');
      C.floors.push(F.name);
      C.devices.push(...chain(start, kitchen));
      C.kitchen = true;
    }
    // dedicated
    for (const d of F.devices) {
      const kind = d.kind === 'ac' ? 'ac' : d.kind === 'heater' ? 'heater' : d.kind === 'hob' ? 'hob' : d.kind === 'pump' ? 'pump' : null;
      if (!kind) continue;
      const C2 = newCircuit(bid, kind);
      C2.floors.push(F.name);
      C2.devices.push(...(d.socket ? [d.socket, d] : [d]));
    }
  }
  // loads, breakers, cables and lengths of every circuit
  const I = (W) => W / (O.voltage * O.cosphi);
  const cableFor = (A, min = 1.5) => CABLES.find(([S, iz]) => S >= min && iz >= A)?.[0] ?? 35;
  const ratingFor = (A, min) => RATINGS.find((r) => r >= Math.max(A, min)) ?? 100;
  for (const B of boards.values()) {
    for (const C of B.circuits) {
      const def = CIRCUIT[C.kind];
      C.P = r2(C.devices.reduce((s, d) => s + (d.W ?? 0), 0));
      C.ks = O.ks[C.kind] ?? 1;
      C.Ptt = r2(C.P * C.ks);
      C.I = r2(I(C.P * (C.kind === 'light' || C.kind === 'socket' ? C.ks : 1)));
      C.rating = ratingFor(C.I, def.rating);
      C.S = cableFor(C.rating, def.S);
      C.breaker = `${def.breaker} ${C.rating}A`;
      C.cable = cableText(C.S, lang);
      C.name = lang === 'en' ? def.en : def.vi;
      const F = out.find((x) => x.name === C.floors[0]);
      const start = P0(F);
      // route: the board to the first device, then device to device; plus the drops from the slab to each device and,
      // for the floors without a board, the riser
      const devs = C.devices;
      let L = 0, p = start;
      for (const d of devs) {
        L += dist(p, d.at) * 1.08;
        p = d.at;
      }
      const drop = devs.reduce((s, d) => s + (LIGHT_KINDS.includes(d.kind) ? 300 : Math.max(0, (F.height ?? 3300) - (d.z ?? 400))), 0);
      const rise = F.board ? 0 : (F.level - (out.find((x) => x.name === B.floor)?.level ?? F.level));
      C.length = r2((L + drop + Math.max(0, rise)) / 1000);
      C.du = r2(((2 * C.length * C.I * O.rho) / C.S / O.voltage) * 100);
      C.rooms = [...new Set(devs.map((d) => d.room).filter(Boolean))];
      if (C.du > 3) warnings.push(`${B.id} ${C.id}: voltage drop ${C.du}% over 3%: larger cable`);
    }
    B.P = r2(B.circuits.reduce((s, c) => s + c.P, 0));
    B.Ptt = r2(B.circuits.reduce((s, c) => s + c.Ptt, 0));
    B.I = r2(I(B.Ptt));
    B.rating = ratingFor(B.I, 32);
    B.S = cableFor(B.rating, 6);
    B.breaker = `MCB 2P ${B.rating}A`;
    B.cable = cableText(B.S, lang);
    if (B.rating > 32 && !options.boards) assumed.push({ item: `${B.id}`, value: `MCB 2P ${B.rating}A, ${B.cable}`, note: `the load needs more than the 32A assumed (${B.I} A)` });
  }
  // the main board: the floor boards and the meter
  const list = [...boards.values()];
  const main = { id: K.main, P: r2(list.reduce((s, b) => s + b.P, 0)), kdt: O.kdt };
  main.Ptt = r2(O.kdt * list.reduce((s, b) => s + b.Ptt, 0));
  main.I = r2(I(main.Ptt));
  main.rating = ratingFor(main.I, 63);
  main.S = cableFor(main.rating, 16);
  main.breaker = `MCB 2P ${main.rating}A`;
  main.cable = `Cu/XLPE/PVC ${cableText(main.S, lang).replace('+E', ' + E')}`;
  if (main.rating > 63) warnings.push(`main board: ${main.I} A over a single-phase 63A supply: ask the utility for a three-phase supply`);
  // the floor feeders: their length from the main board up the stair
  const mainF = out[0];
  for (const B of list) {
    const F = out.find((x) => x.name === B.floor);
    B.feeder_length = r2(((F?.level ?? 0) + 3000 + (B.at && mainF.board ? dist(B.at, mainF.board.at) : 2000)) / 1000);
    B.du = r2(((2 * B.feeder_length * B.I * O.rho) / B.S / O.voltage) * 100);
  }
  return { floors: out, boards: list, main, options: O, assumed, warnings, codes: K };
}

// ---------------------------------------------------------------- drawings

const L = (role) => ROLE[role];

/** The device as a block insert at its place (paper symbols at the scale, lights at their real size). */
function deviceEntity(d, offset, scale) {
  const def = DEVICES[d.kind];
  if (d.kind === 'strip') return polyE(d.points.map((p) => add(p, offset)), true, L('light_strip'), { scale_linetype: true });
  const block = d.block ?? def.block;
  return sym(block, add(d.at, offset), { scale: def.real ? 1 : scale, rotation: def.rotate ? d.rot ?? 0 : 0, layer: L(def.layer), attrs: LIGHT_CODES[d.kind] ? { MA: LIGHT_CODES[d.kind] } : {} });
}

const PLAN_NOTES = {
  vi: {
    lighting: [
      'Dây dẫn đi âm tường, âm trần trong ống nhựa PVC cứng D16-D20; dây chiếu sáng Cu/PVC 2x1,5mm².',
      'Công tắc đặt cao +1,25m tính từ mặt sàn hoàn thiện, cách mép khuôn cửa 150-250mm; công tắc WC đặt ngoài cửa WC.',
      'Đèn cầu thang điều khiển 2 chiều từ hai đầu vế thang: công tắc 2 chiều ở tầng dưới và tầng trên (các tầng giữa dùng mặt 2 hạt).',
      'Vị trí đèn phối hợp bản vẽ trần nội thất; ký hiệu mạch (L1, L2...) và tủ cấp điện ghi trên đường dây về tủ.',
    ],
    power: [
      'Ổ cắm dùng loại 3 chấu có tiếp địa; khu ẩm ướt, ngoài trời dùng ổ chống nước có nắp, cấp qua RCBO 30mA.',
      'Mỗi điều hòa, bình nóng lạnh, bếp từ, máy bơm cấp riêng một mạch từ tủ tầng.',
      'Cao độ lắp đặt ghi trong bảng ký hiệu, tính từ mặt sàn hoàn thiện đến tâm thiết bị.',
      'Điện nhẹ: cáp mạng Cat6, cáp đồng trục RG6 đi riêng ống, cách cáp điện tối thiểu 300mm, về tủ mạng tầng 1.',
    ],
  },
  en: {
    lighting: ['Wiring concealed in PVC conduit D16-D20; lighting cable Cu/PVC 2x1.5 mm².', 'Switches at +1.25 m, 150-250 mm from the door frame; WC switches outside the WC door.', 'Stair lights switched two-way from both ends of the flight: the floors in between have a two-gang plate.', 'Light positions per the interior ceiling drawings; circuit names (L1, L2...) on the home runs.'],
    power: ['Sockets with earth pins; weatherproof covered sockets in wet and outdoor areas, on 30 mA RCBOs.', 'Each air conditioner, water heater, hob and pump on its own circuit.', 'Mounting heights per the legend, from the finished floor to the device centre.', 'Data Cat6 and TV RG6 cables in their own conduits, 300 mm from power cables, to the data cabinet on the ground floor.'],
  },
};
export const electricalNotes = (mode, lang = 'vi') => (PLAN_NOTES[lang] ?? PLAN_NOTES.vi)[mode] ?? [];

/**
 * The lighting or power plan of floor k: devices, wiring by circuit (arcs device to device, the home run to the board
 * with the circuit name), boards and their names, the riser, the legend with the counts of this floor.
 */
export function electricalPlan(design, k, { mode = 'lighting', offset = [0, 0], scale = 100, lang = 'vi', legendAt = null, circuitsAt = null, hard = [], limit = null } = {}) {
  const F = design.floors[k];
  const out = [];
  const en = lang === 'en';
  const sc = scale, h = 2 * sc;
  const at = (p) => add(p, offset);
  const lights = mode === 'lighting';
  // the boards (the main board too) are devices of the floor, the data cabinet and the meter of the power plan
  const shown = F.devices.filter((d) => (lights ? DEVICES[d.kind].plan === 'lighting' : DEVICES[d.kind].plan === 'power') || d.kind === 'board');
  for (const d of shown) out.push(deviceEntity(d, offset, sc));
  const labels = labelPlacer(h, hard, limit);
  // wiring by circuit
  const B = design.boards.find((b) => b.id === F.served);
  const start = F.board ? F.board.at : F.riser;
  const wireLayer = lights ? L('light_wire') : L('power_wire');
  // a run two circuits share (the home run to a switch with gangs on two circuits) is drawn once
  const drawn = new Set();
  // the arcs bulge towards the middle of the floor (never out through the outer walls) and stay shallow: a sag of
  // at most 350 mm
  const xs = F.devices.map((d) => d.at[0]), ys = F.devices.map((d) => d.at[1]);
  const mid = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  // points along the wires (the names of the boards keep off them)
  const wirePts = [];
  const along = (a, b, bulge) => {
    const chord = dist(a, b);
    if (!(chord > 1)) return;
    const n = [(b[1] - a[1]) / chord, -(b[0] - a[0]) / chord], sag = (bulge * chord) / 2;
    const steps = Math.max(1, Math.ceil(chord / (1.2 * sc)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, q = 4 * t * (1 - t) * sag;
      wirePts.push([a[0] + (b[0] - a[0]) * t + n[0] * q, a[1] + (b[1] - a[1]) * t + n[1] * q]);
    }
  };
  const wire = (a, b, bulge = 0.18) => {
    const key = `${P(a)}|${P(b)}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    const chord = dist(a, b);
    if (chord < 1) return;
    const left = (b[0] - a[0]) * (mid[1] - a[1]) - (b[1] - a[1]) * (mid[0] - a[0]) > 0;
    const bg = (left ? -1 : 1) * Math.min(bulge, 700 / chord);
    out.push(arcE(at(a), at(b), wireLayer, bg));
    along(at(a), at(b), bg);
  };
  for (const C of B?.circuits ?? []) {
    if (!C.floors.includes(F.name)) continue;
    if (lights !== (C.kind === 'light')) continue;
    let first = null;
    if (C.kind === 'light') {
      // board -> switches in turn; each switch -> its lights in a chain
      const sws = [];
      for (const u of C.units) if (u.sw && !sws.includes(u.sw)) sws.push(u.sw);
      let p = start;
      for (const sw of sws) {
        wire(p, sw.at);
        first = first ?? sw.at;
        p = sw.at;
      }
      for (const u of C.units) {
        let q = u.sw?.at ?? start;
        for (const l of chain(q, u.lights)) {
          const tgt = l.kind === 'strip' ? l.points.reduce((m, x) => (Math.hypot(x[0] - q[0], x[1] - q[1]) < Math.hypot(m[0] - q[0], m[1] - q[1]) ? x : m)) : l.at;
          wire(q, tgt, 0.12);
          first = first ?? tgt;
          q = l.at;
        }
      }
    } else {
      let p = start;
      for (const d of C.devices) {
        wire(p, d.at);
        first = first ?? d.at;
        p = d.at;
      }
    }
    if (!first) continue;
    // the circuit name on the home run, clear of the other names
    const a = start, b = first;
    const v = sub(b, a), nrm = unit([-v[1], v[0]]);
    const cands = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85, 0.42, 0.58].flatMap((t) => [1, -1, 2.6, -2.6].map((s) => [at(add(add(a, mul(v, t)), mul(nrm, s * 1.6 * sc))), 'middle_center']));
    const t = `${C.id}`;
    const pl = labels.place(t, cands);
    out.push(textE(t, pl.p, h, L('elec_text'), pl.align));
  }
  // data and TV: home runs to the data cabinet (or the riser by the board)
  if (!lights) {
    const hub = F.board?.network?.at ?? F.board?.at ?? F.riser;
    for (const d of F.devices.filter((x) => x.kind === 'data' || x.kind === 'tv')) out.push(lineE(at(d.at), at(hub), L('comm'), { scale_linetype: true }));
    // the meter: the incoming cable to the main board
    if (F.board?.meter && F.board.main) {
      out.push(lineE(at(F.board.meter.at), at(F.board.main.at), L('power_wire')));
      const m = add(F.board.meter.at, mul(sub(F.board.main.at, F.board.meter.at), 0.5));
      const t = design.main.cable;
      const pl = labels.place(t, [[at(add(m, [2 * sc, 0])), 'middle_left'], [at(add(m, [-2 * sc, 0])), 'middle_right']]);
      out.push(textE(t, pl.p, h * 0.9, L('elec_text'), pl.align));
    }
  }
  // the wires and cables as obstacles of the names that follow
  for (const e of out) if (e.type === 'line' && (e.layer === L('comm') || e.layer === L('power_wire'))) along(e.from, e.to, 0);
  for (const q of wirePts) labels.taken.push([q[0] - 1.3 * sc, q[1] - 0.8 * sc, q[0] + 1.3 * sc, q[1] + 0.8 * sc]);
  // boards and the meter: their names beside them, into the room
  const named = [F.board, F.board?.main, ...(lights ? [] : [F.board?.network, F.board?.meter])].filter(Boolean);
  for (const b of named) {
    const pl = labels.near(b.label, at(b.at), 22 * sc, 3 * sc);
    out.push(textE(b.label, pl.p, h, L('elec_text'), pl.align));
    if (pl.far) out.push(lineE(at(b.at), pl.p, L('elec_text')));
  }
  // the riser: up to the next floor's board, or where the circuits of this floor come from
  if (F.riser) {
    out.push(sym('MCP_E_LEN', at(F.riser), { scale: sc, layer: L('elec_text') }));
    const t = `${en ? 'FROM' : 'TỪ'} ${F.served}`;
    // beside the riser where that is clear, else the nearest clear place (off the treads of the stair) with a leader
    const pl = labels.near(t, at(F.riser), 24 * sc, 3.5 * sc);
    out.push(textE(t, pl.p, h, L('elec_text'), pl.align));
    if (pl.far) out.push(lineE(at(F.riser), pl.p, L('elec_text')));
  }
  // legend: the symbols of this plan with their counts on this floor
  let legendBottom = null;
  if (legendAt) {
    const kinds = lights ? ['downlight', 'ceiling_lamp', 'pendant', 'strip', 'wall_light', 'fan', 'switch', 'switch2', 'board']
      : ['socket', 'counter', 'high', 'wp', 'hob', 'ac', 'heater', 'pump', 'data', 'tv', 'board', 'network', 'meter'];
    const rows = [];
    for (const kd of kinds) {
      const list = F.devices.filter((d) => d.kind === kd);
      if (!list.length) continue;
      const def = DEVICES[kd];
      const block = kd === 'switch' ? 'MCP_E_CT_2' : def.block;
      rows.push({ block, real: def.real, layer: L(def.layer), text: en ? def.en : def.vi, ...(kd === 'strip' ? { block: null, line: L('light_strip'), extra: { scale_linetype: true } } : {}) });
    }
    rows.push({ line: wireLayer, text: lights ? (en ? 'Lighting wiring Cu/PVC 2x1.5 in conduit' : 'Dây chiếu sáng Cu/PVC 2x1,5 trong ống PVC') : (en ? 'Power wiring Cu/PVC 2x2.5+E2.5 (dedicated per schedule)' : 'Dây ổ cắm, động lực Cu/PVC 2x2,5+E2,5 (mạch riêng theo sơ đồ)') });
    if (!lights) rows.push({ line: L('comm'), extra: { scale_linetype: true }, text: en ? 'Data / TV cable to the data cabinet' : 'Cáp mạng, truyền hình về tủ mạng' });
    const lg = legend(en ? (lights ? 'LIGHTING LEGEND' : 'POWER LEGEND') : (lights ? 'KÝ HIỆU CHIẾU SÁNG' : 'KÝ HIỆU Ổ CẮM, THIẾT BỊ'), rows, legendAt, sc, L('elec_text'), L('elec_text'));
    out.push(...lg.entities);
    legendBottom = lg.bottom;
  }
  // the circuits of this floor under its plan: name, what it feeds, breaker, cable
  if (circuitsAt) {
    let y = circuitsAt[1];
    out.push(textE(en ? `CIRCUITS OF THIS FLOOR (FROM ${F.served})` : `CÁC MẠCH CỦA TẦNG (TỪ ${F.served})`, [circuitsAt[0], y], 2.5 * sc, L('elec_text')));
    y -= 5.5 * sc;
    for (const C of (B?.circuits ?? []).filter((c) => c.floors.includes(F.name) && lights === (c.kind === 'light'))) {
      out.push(textE(`${C.id}: ${C.name}${C.rooms.length ? ` (${C.rooms.join(', ')})` : ''} - ${C.breaker}, ${C.cable}`, [circuitsAt[0], y], 2 * sc, L('elec_text'), 'middle_left'));
      y -= 4.2 * sc;
    }
  }
  return { entities: out, legendBottom };
}

// ---------------------------------------------------------------- single-line diagram and board schedules

/** A circuit breaker on a vertical line from top (x, y) going down: contact stroke and cross; returns the bottom y. */
function breakerSym(x, y, s, layer, out) {
  out.push(lineE([x, y], [x, y - 4 * s], layer));
  out.push(lineE([x, y - 4 * s], [x + 2.2 * s, y - 7.6 * s], layer));
  out.push(lineE([x - 0.8 * s, y - 3.2 * s], [x + 0.8 * s, y - 4.8 * s], layer), lineE([x - 0.8 * s, y - 4.8 * s], [x + 0.8 * s, y - 3.2 * s], layer));
  out.push(lineE([x, y - 8 * s], [x, y - 11 * s], layer));
  return y - 11 * s;
}

/**
 * The single-line diagram: the main board (meter, main breaker, the feeders to the floor boards) and each floor board
 * (incoming breaker, busbar, one drop per circuit with its breaker) with its schedule under it (circuit, load, current,
 * breaker, cable, length, voltage drop). At the scale (paper mm x scale), from at (top left).
 */
export function singleLineDiagram(design, { at = [0, 0], scale = 50, lang = 'vi' } = {}) {
  const out = [];
  const en = lang === 'en', s = scale, layer = L('elec_text');
  const T = (t, p, hh = 2.5, align = 'left', rot = 0) => out.push(textE(t, p, hh * s, layer, align, rot));
  const num = (v) => (en ? String(v) : String(v).replace('.', ','));
  const colW = 19, labW = 34;
  const x0 = at[0];
  const boards = design.boards;
  const M = design.main;
  const K = codesOf(design);
  // ---- the floor boards, one under another
  let y = at[1], right = x0;
  for (const B of boards) {
    T(`${en ? 'BOARD' : 'TỦ ĐIỆN'} ${B.id} (${B.floors.join(', ')})`, [x0, y], 4);
    y -= 10 * s;
    const bx = x0 + labW * s;
    T(`${en ? 'FROM' : 'TỪ'} ${M.id}: ${B.cable}`, [bx + 4 * s, y + 1 * s], 2.2);
    const yy = breakerSym(bx, y - 2 * s, s, layer, out);
    T(B.breaker, [bx + 4 * s, y - 9 * s], 2.2);
    const cs = B.circuits;
    const bR = bx + ((cs.length + 1) * colW) * s;
    out.push({ type: 'polyline', points: [P([bx - 10 * s, yy]), P([bR, yy])], closed: false, layer, width: r2(0.6 * s) });
    const rows = [[en ? 'Circuit' : 'Mạch'], [en ? 'Feeds' : 'Phụ tải'], [en ? 'Breaker' : 'Bảo vệ'], [en ? 'Cable Cu/PVC' : 'Dây Cu/PVC'], ['P (W)'], ['Ks'], [`${K.I} (A)`], [en ? 'Length (m)' : 'Dài (m)'], ['ΔU (%)']];
    cs.forEach((C, i) => {
      const x = bx + ((i + 0.5) * colW) * s;
      breakerSym(x, yy, s, layer, out);
      out.push(lineE([x, yy - 11 * s], [x, yy - 16 * s], layer));
      rows[0].push(C.id);
      rows[1].push(C.name);
      rows[2].push(C.breaker.replace(' 30mA', ''));
      rows[3].push(C.cable);
      rows[4].push(C.P);
      rows[5].push(C.ks);
      rows[6].push(C.I);
      rows[7].push(C.length);
      rows[8].push(C.du);
    });
    out.push({ type: 'table', at: P([bx - labW * s, yy - 16 * s]), rows, header: false, height: r2(1.8 * s), row_height: r2(6 * s), col_widths: [labW, ...cs.map(() => colW)].map((w) => r2(w * s)), layer, style: TEXT_STYLE, decimal_separator: en ? undefined : ',' });
    T(`ΣP = ${num(B.P)} W; ${K.P} = ${num(B.Ptt)} W; ${K.I} = ${num(B.I)} A`, [bx - labW * s, yy - 76 * s], 2.2);
    right = Math.max(right, bx + cs.length * colW * s, bR);
    y = yy - 88 * s;
  }
  // ---- the main board beside them: meter, main breaker, earth, a drop per floor board and a spare
  const m0 = right + 25 * s;
  let ym = at[1];
  T(`${en ? 'MAIN BOARD' : 'TỦ ĐIỆN TỔNG'} ${M.id}`, [m0, ym], 4);
  ym -= 10 * s;
  const mx = m0 + labW * s;
  out.push(sym('MCP_E_CTO', [mx - 1.5 * s, ym + 2 * s], { scale: s, rotation: -90, layer: L('elec_equipment') }));
  T(en ? 'FROM THE UTILITY GRID 1 PHASE 220V' : 'TỪ LƯỚI ĐIỆN EVN 1 PHA 220V', [mx + 4 * s, ym + 1 * s], 2.2);
  T(M.cable, [mx + 4 * s, ym - 4 * s], 2.2);
  const yb = breakerSym(mx, ym - 2 * s, s, layer, out);
  T(M.breaker, [mx + 4 * s, ym - 9 * s], 2.2);
  const feeders = [...boards.map((b) => ({ id: b.id, breaker: b.breaker, cable: b.cable, P: b.Ptt, I: b.I, L: b.feeder_length })),
    { id: en ? 'SPARE' : 'DỰ PHÒNG', breaker: 'MCB 2P 32A', cable: '', P: '', I: '', L: '' }];
  const busL = mx - 10 * s, busR = mx + (feeders.length * colW + 4) * s;
  out.push({ type: 'polyline', points: [P([busL, yb]), P([busR, yb])], closed: false, layer, width: r2(0.6 * s) });
  const rowsMain = [[en ? 'Feeder' : 'Lộ ra'], [en ? 'Breaker' : 'Thiết bị bảo vệ'], [en ? 'Cable Cu/PVC' : 'Dây dẫn Cu/PVC'], [`${K.P} (W)`], [`${K.I} (A)`], [en ? 'Length (m)' : 'Dài (m)']];
  feeders.forEach((fd, i) => {
    const x = mx + ((i + 0.5) * colW) * s;
    breakerSym(x, yb, s, layer, out);
    out.push(lineE([x, yb - 11 * s], [x, yb - 16 * s], layer));
    rowsMain[0].push(fd.id);
    rowsMain[1].push(fd.breaker);
    rowsMain[2].push(fd.cable);
    rowsMain[3].push(fd.P);
    rowsMain[4].push(fd.I);
    rowsMain[5].push(fd.L);
  });
  out.push({ type: 'table', at: P([mx - labW * s, yb - 16 * s]), rows: rowsMain, header: false, height: r2(1.8 * s), row_height: r2(6 * s), col_widths: [labW, ...feeders.map(() => colW)].map((w) => r2(w * s)), layer, style: TEXT_STYLE, decimal_separator: en ? undefined : ',' });
  out.push(lineE([busL, yb], [busL, yb - 8 * s], layer));
  out.push(sym('MCP_E_TIEP_DIA', [busL, yb - 8 * s], { scale: s, layer: L('earth') }));
  T(en ? 'EARTH R ≤ 4 Ω' : 'TIẾP ĐỊA R ≤ 4 Ω', [busL - 2 * s, yb - 15 * s], 2, 'right');
  T(`${K.P} = ${K.kdt} x Σ${K.P} = ${num(M.kdt)} x ${num(r2(M.Ptt / M.kdt))} = ${num(M.Ptt)} W; ${K.I} = ${num(M.I)} A`, [mx - labW * s, yb - 58 * s], 2.2);
  right = Math.max(right, mx + feeders.length * colW * s);
  out.push(...viewTitle(en ? 'SINGLE-LINE DIAGRAM AND BOARD SCHEDULES' : 'SƠ ĐỒ NGUYÊN LÝ CẤP ĐIỆN, BẢNG PHÂN PHỐI TỦ ĐIỆN', (x0 + right) / 2, y - 6 * s, s, layer, lang, 5, false));
  return { entities: out, bottom: y - 20 * s, right };
}

/**
 * The riser diagram (sơ đồ trục đứng): the floors as lines with their levels, the board of each floor, the feeders from
 * the main board, the meter and the utility supply, the data cabinet, the earthing pit; then the earthing detail.
 */
export function riserDiagram(design, { at = [0, 0], scale = 50, lang = 'vi' } = {}) {
  const out = [];
  const en = lang === 'en', s = scale, layer = L('elec_text');
  const T = (t, p, hh = 2.5, align = 'left') => out.push(textE(t, p, hh * s, layer, align));
  const floors = design.floors;
  const hpx = 34; // paper mm per floor
  const x0 = at[0], yBase = at[1] - (floors.length + 1) * hpx * s;
  const W = 150;
  const lvl = (i) => yBase + i * hpx * s;
  floors.forEach((F, i) => {
    const y = lvl(i);
    out.push(lineE([x0, y], [x0 + W * s, y], layer));
    T(`${F.name}`, [x0, y + 1.5 * s], 2.5);
    T(`${(F.level / 1000 >= 0 ? (F.level === 0 ? '±' : '+') : '')}${(F.level / 1000).toFixed(3).replace('.', en ? '.' : ',')}`, [x0 + W * s, y + 1.5 * s], 2.2, 'right');
  });
  const top = lvl(floors.length);
  out.push(lineE([x0, top], [x0 + W * s, top], layer));
  T(en ? 'ROOF' : 'MÁI', [x0, top + 1.5 * s], 2.5);
  const bx = x0 + 60 * s;
  const mainY = lvl(0) + 12 * s;
  // the main board and the meter outside
  const box = (x, y, w, hh, t) => {
    out.push(polyE([[x, y], [x + w * s, y], [x + w * s, y + hh * s], [x, y + hh * s]], true, L('elec_equipment')));
    T(t, [x + (w * s) / 2, y + (hh * s) / 2], 2.2, 'middle_center');
  };
  box(x0 + 18 * s, mainY, 16, 7, en ? 'METER' : 'CÔNG TƠ');
  T(en ? 'UTILITY 1P 220V' : 'LƯỚI EVN 1P 220V', [x0 + 18 * s, mainY - 4 * s], 2);
  out.push(lineE([x0 + 34 * s, mainY + 3.5 * s], [bx, mainY + 3.5 * s], L('power_wire')));
  T(design.main.cable, [x0 + 35 * s, mainY + 5 * s], 1.8);
  box(bx, mainY, 18, 7, design.main.id);
  // floor boards and feeders (one line each, offset so they do not overlap)
  design.boards.forEach((B, j) => {
    const i = floors.findIndex((F) => F.name === B.floor);
    const y = lvl(i) + 22 * s;
    const fx = bx + (24 + j * 4) * s;
    const xb = bx + 50 * s;
    out.push(polyE([[bx + 18 * s, mainY + (1.5 + j * 1.2) * s], [fx, mainY + (1.5 + j * 1.2) * s], [fx, y + 3.5 * s], [xb, y + 3.5 * s]], false, L('power_wire')));
    box(xb, y, 18, 7, B.id);
    T(`${B.breaker}, ${B.cable}`, [xb + 20 * s, y + 3.5 * s], 2, 'middle_left');
    T(`${en ? 'serves' : 'cấp cho'} ${B.floors.join(', ')}`, [xb + 20 * s, y - 0.5 * s], 1.8, 'middle_left');
  });
  // the data cabinet
  box(x0 + 38 * s, mainY - 12 * s, 18, 6, en ? 'DATA' : 'TỦ MẠNG');
  // earthing
  out.push(lineE([bx + 9 * s, mainY], [bx + 9 * s, lvl(0) - 8 * s], L('earth')));
  out.push(sym('MCP_E_TIEP_DIA', [bx + 9 * s, lvl(0) - 8 * s], { scale: s, layer: L('earth') }));
  T(en ? 'EARTH ELECTRODES, R ≤ 4 Ω' : 'HỆ TIẾP ĐỊA AN TOÀN, R ≤ 4 Ω', [bx + 13 * s, lvl(0) - 11 * s], 2);
  out.push(...viewTitle(en ? 'POWER RISER DIAGRAM' : 'SƠ ĐỒ TRỤC ĐỨNG CẤP ĐIỆN', x0 + (W * s) / 2, yBase - 22 * s, s, layer, lang, 5, false));
  // ---- earthing detail beside it
  const ex = x0 + (W + 30) * s, ey = at[1] - 30 * s;
  out.push(...earthingDetail([ex, ey], s, lang));
  return { entities: out };
}

/** Earthing detail (section): three copper-clad rods in a trench, the bare copper cable, the test box, with notes. */
export function earthingDetail(at, s, lang = 'vi') {
  const out = [];
  const en = lang === 'en', layer = L('elec_text'), g = L('earth');
  const T = (t, p, hh = 2.2, align = 'left') => out.push(textE(t, p, hh * s, layer, align));
  const [x0, y0] = at;
  // section: ground line, trench 800 deep, rods 2400 long every 3000 (drawn at 1:50 in paper mm / scale 1)
  const k = s / 50; // drawing units per mm of the detail at 1:50 on the sheet
  const gy = y0;
  out.push(lineE([x0, gy], [x0 + 7200 * k, gy], layer));
  out.push(polyE([[x0 + 300 * k, gy], [x0 + 300 * k, gy - 800 * k], [x0 + 6900 * k, gy - 800 * k], [x0 + 6900 * k, gy]], false, ROLE.hidden, { scale_linetype: true }));
  for (const i of [0, 1, 2]) {
    const x = x0 + (600 + i * 3000) * k;
    out.push(polyE([[x - 8 * k, gy - 700 * k], [x + 8 * k, gy - 700 * k], [x + 8 * k, gy - 3100 * k], [x - 8 * k, gy - 3100 * k]], true, g));
  }
  out.push(lineE([x0 + 600 * k, gy - 700 * k], [x0 + 6600 * k, gy - 700 * k], g));
  out.push(lineE([x0 + 600 * k, gy - 700 * k], [x0 + 600 * k, gy + 600 * k], g));
  out.push(polyE([[x0 + 400 * k, gy + 600 * k], [x0 + 800 * k, gy + 600 * k], [x0 + 800 * k, gy + 900 * k], [x0 + 400 * k, gy + 900 * k]], true, g));
  T(en ? 'TEST BOX' : 'HỘP KIỂM TRA', [x0 + 900 * k, gy + 750 * k], 2, 'middle_left');
  T(en ? 'BARE COPPER 25 mm²' : 'CÁP ĐỒNG TRẦN 25mm²', [x0 + 3600 * k, gy - 600 * k], 2, 'center');
  T(en ? 'COPPER-CLAD ROD D16 L=2400' : 'CỌC THÉP MẠ ĐỒNG D16 L=2400', [x0 + 6600 * k + 3 * s, gy - 2000 * k], 2, 'middle_left');
  // the measured length is the real one at 1:50 (k = 1); at another sheet scale the value is written
  const dimT = (v) => (Math.abs(k - 1) < 1e-9 ? {} : { text: String(v) });
  const st = dimStyleName(s);
  out.push({ type: 'dim', kind: 'linear', from: P([x0 + 600 * k, gy - 3100 * k]), to: P([x0 + 3600 * k, gy - 3100 * k]), offset: r2(-6 * s), layer: L('elec_text'), style: st, ...dimT(3000) });
  out.push({ type: 'dim', kind: 'linear', from: P([x0 + 3600 * k, gy - 3100 * k]), to: P([x0 + 6600 * k, gy - 3100 * k]), offset: r2(-6 * s), layer: L('elec_text'), style: st, ...dimT(3000) });
  out.push({ type: 'dim', kind: 'linear', from: P([x0 + 6900 * k, gy]), to: P([x0 + 6900 * k, gy - 800 * k]), offset: r2(-6 * s), layer: L('elec_text'), style: st, direction: 'vertical', ...dimT(800) });
  const notes = en
    ? ['Earth resistance R ≤ 4 Ω measured after installation; add rods until it is reached.', 'Trench 800 deep, backfilled with fine soil; joints exothermic welded.', 'The earth cable to the main board earth bar: Cu/PVC 1x16 mm².']
    : ['Điện trở nối đất R ≤ 4 Ω, đo kiểm tra sau khi thi công; không đạt thì đóng thêm cọc.', 'Rãnh sâu 800, lấp đất mịn; mối nối hàn hóa nhiệt.', 'Dây nối từ hệ tiếp địa về thanh tiếp địa tủ điện tổng: Cu/PVC 1x16mm².'];
  out.push({ type: 'mtext', text: notes.map((t, i) => `${i + 1}. ${t}`).join('\n'), at: P([x0, gy - 3800 * k - 14 * s]), height: r2(2.2 * s), width: r2(150 * s), layer, style: TEXT_STYLE });
  out.push(...viewTitle(en ? 'EARTHING DETAIL' : 'CHI TIẾT TIẾP ĐỊA', x0 + 3600 * k, gy - 3800 * k - 40 * s, s, layer, lang, 5, false));
  return out;
}

// ---------------------------------------------------------------- quantities

/** Bill of quantities of the electrical set: devices by kind, boards and breakers, cables by size, conduit, earthing. */
export function electricalQuantities(design, { lang = 'vi', allowance = 0.1 } = {}) {
  const en = lang === 'en';
  const rows = [];
  const head = (t) => rows.push({ head: true, item: t });
  let n = 0;
  const row = (item, unit, q, how = '') => rows.push({ stt: ++n, item, unit, q, how });
  const pcs = en ? 'pcs' : 'cái', set = en ? 'set' : 'bộ';
  const all = design.floors.flatMap((F) => F.devices);
  const byFloor = (pred) => design.floors.map((F) => [F.name, F.devices.filter(pred).length]).filter(([, c]) => c).map(([f, c]) => `${f}: ${c}`).join('; ');
  head(en ? 'LIGHTING' : 'THIẾT BỊ CHIẾU SÁNG');
  for (const kd of ['downlight', 'ceiling_lamp', 'pendant', 'wall_light', 'fan']) {
    const c = all.filter((d) => d.kind === kd).length;
    if (c) row(en ? DEVICES[kd].en : DEVICES[kd].vi, pcs, c, byFloor((d) => d.kind === kd));
  }
  const strip = all.filter((d) => d.kind === 'strip').reduce((s, d) => s + (d.length ?? 0), 0) / 1000;
  if (strip) row(en ? DEVICES.strip.en : DEVICES.strip.vi, 'm', r2(strip));
  head(en ? 'SWITCHES, SOCKETS, OUTLETS' : 'CÔNG TẮC, Ổ CẮM, ĐẦU CHỜ');
  for (const g of [1, 2, 3, 4]) {
    const c = all.filter((d) => d.kind === 'switch' && Math.min(4, d.gangs) === g).length;
    if (c) row(en ? `Switch ${g} gang` : `Công tắc ${g} hạt`, pcs, c);
  }
  for (const g of [1, 2]) {
    const c = all.filter((d) => d.kind === 'switch2' && (d.gangs ?? 1) === g).length;
    if (c) row(en ? `Two-way switch ${g} gang (stairs)` : `Công tắc 2 chiều ${g} hạt (cầu thang)`, pcs, c);
  }
  for (const kd of ['socket', 'counter', 'high', 'wp', 'hob', 'data', 'tv']) {
    const c = all.filter((d) => d.kind === kd).length;
    if (c) row(en ? DEVICES[kd].en : DEVICES[kd].vi, pcs, c, byFloor((d) => d.kind === kd));
  }
  head(en ? 'EQUIPMENT' : 'THIẾT BỊ');
  for (const btu of AC_SIZES) {
    const c = all.filter((d) => d.kind === 'ac' && d.btu === btu).length;
    if (c) row(en ? `Wall air conditioner ${btu} BTU (with outdoor unit)` : `Điều hòa treo tường ${btu} BTU (kèm dàn nóng)`, set, c);
  }
  // water heaters and the pump: in the plumbing bill (their sockets and circuits here)
  head(en ? 'BOARDS AND BREAKERS' : 'TỦ ĐIỆN, THIẾT BỊ BẢO VỆ');
  row(en ? `Main board ${design.main.id} with ${design.main.breaker}` : `Tủ điện tổng ${design.main.id}, ${design.main.breaker}`, pcs, 1);
  for (const B of design.boards) row(en ? `Board ${B.id} with ${B.breaker}` : `Tủ điện ${B.id}, ${B.breaker}`, pcs, 1);
  const brk = new Map();
  for (const B of design.boards) {
    brk.set(B.breaker, (brk.get(B.breaker) ?? 0) + 1); // the feeder in the main board
    for (const C of B.circuits) brk.set(C.breaker, (brk.get(C.breaker) ?? 0) + 1);
  }
  // the spare way of the main board
  const SPARE = 'MCB 2P 32A';
  brk.set(SPARE, (brk.get(SPARE) ?? 0) + 1);
  for (const [b, c] of [...brk.entries()].sort()) rows.push({ stt: ++n, item: b, unit: pcs, q: c, how: b === SPARE ? (en ? `with 1 spare way in ${design.main.id}` : `gồm 1 lộ dự phòng ở ${design.main.id}`) : '', ...(b === SPARE ? { plus: 1 } : {}) });
  head(en ? 'CABLES AND CONDUIT' : 'DÂY DẪN, ỐNG LUỒN DÂY');
  const cab = new Map();
  for (const B of design.boards) {
    cab.set(B.cable, (cab.get(B.cable) ?? 0) + B.feeder_length);
    for (const C of B.circuits) cab.set(C.cable, (cab.get(C.cable) ?? 0) + C.length);
  }
  const nm = (v) => (en ? String(v) : String(v).replace('.', ','));
  for (const [c, m] of [...cab.entries()].sort()) row(`${en ? 'Cable' : 'Dây'} Cu/PVC ${c}`, 'm', r2(m * (1 + allowance)), `${nm(r2(m))} x ${nm(1 + allowance)}`);
  row(design.main.cable + (en ? ' (meter to main board)' : ' (công tơ - tủ tổng)'), 'm', 15);
  const total = [...cab.values()].reduce((s, m) => s + m, 0);
  row(en ? 'PVC conduit D20 (one per cable run)' : 'Ống luồn dây PVC D20 (theo tuyến dây)', 'm', r2(total * (1 + allowance)), `${nm(r2(total))} x ${nm(1 + allowance)}`);
  const comm = all.filter((d) => d.kind === 'data' || d.kind === 'tv');
  if (comm.length) {
    const lenComm = design.floors.reduce((s, F) => {
      const hub = F.board?.network?.at ?? F.board?.at ?? F.riser;
      return s + F.devices.filter((d) => d.kind === 'data' || d.kind === 'tv').reduce((t, d) => t + dist(d.at, hub) / 1000 + (F.level / 1000), 0);
    }, 0);
    row(en ? 'Data Cat6 and TV RG6 cables' : 'Cáp mạng Cat6, cáp truyền hình RG6', 'm', r2(lenComm * (1 + allowance)));
  }
  head(en ? 'EARTHING' : 'TIẾP ĐỊA');
  row(en ? 'Copper-clad rod D16 L=2.4 m' : 'Cọc thép mạ đồng D16 L=2,4m', pcs, 3);
  row(en ? 'Bare copper cable 25 mm²' : 'Cáp đồng trần 25mm²', 'm', 10);
  row(en ? 'Earth cable Cu/PVC 1x16 mm² (electrodes to the main board)' : 'Dây tiếp địa Cu/PVC 1x16mm² (hệ tiếp địa - tủ tổng)', 'm', 10);
  row(en ? 'Earth test box' : 'Hộp kiểm tra tiếp địa', pcs, 1);
  return { rows };
}

/** The load calculation and the bill of quantities as tables (for the sheet and the CSV). */
export function electricalTables(design, Q, lang = 'vi') {
  const en = lang === 'en';
  const K = codesOf(design);
  const loads = {
    title: en ? 'LOAD CALCULATION, BREAKERS AND CABLES' : 'BẢNG TÍNH PHỤ TẢI, CHỌN THIẾT BỊ BẢO VỆ VÀ DÂY DẪN',
    widths: [16, 14, 72, 18, 10, 18, 14, 34, 26, 14, 14],
    rows: [[en ? 'BOARD' : 'TỦ', en ? 'CIRCUIT' : 'MẠCH', en ? 'FEEDS' : 'PHỤ TẢI', 'P (W)', 'Ks', `${K.P} (W)`, `${K.I} (A)`, en ? 'BREAKER' : 'BẢO VỆ', en ? 'CABLE Cu/PVC' : 'DÂY Cu/PVC', 'L (m)', 'ΔU (%)']],
  };
  for (const B of design.boards) {
    for (const C of B.circuits) loads.rows.push([B.id, C.id, `${C.name}: ${C.rooms.join(', ')}`, C.P, C.ks, C.Ptt, C.I, C.breaker, C.cable, C.length, C.du]);
    loads.rows.push([B.id, en ? 'TOTAL' : 'TỔNG', en ? `${B.floors.join(', ')}; feeder from ${design.main.id}` : `${B.floors.join(', ')}; cáp cấp từ ${design.main.id}`, B.P, '', B.Ptt, B.I, B.breaker, B.cable, B.feeder_length, B.du]);
  }
  const M = design.main;
  loads.rows.push([M.id, en ? 'MAIN' : 'TỔNG', en ? `all boards, ${K.kdt} = ${M.kdt}` : `các tủ tầng, ${K.kdt} = ${String(M.kdt).replace('.', ',')}`, M.P, M.kdt, M.Ptt, M.I, M.breaker, M.cable.replace('Cu/XLPE/PVC ', ''), '', '']);
  return [loads, boqTable(en ? 'BILL OF QUANTITIES - ELECTRICAL' : 'BẢNG KHỐI LƯỢNG VẬT TƯ ĐIỆN', Q.rows, lang)];
}

/** The basis of the electrical calculation (notes of the sheet). */
export function electricalBasis(design, lang = 'vi') {
  const O = design.options, en = lang === 'en';
  const { P: Pd, I: Id, kdt: Kd } = codesOf(design);
  const c = (v) => (en ? String(v) : String(v).replace('.', ','));
  return en ? [
    `Supply 1 phase ${O.voltage} V, cos φ = ${O.cosphi}; ${Id} = ${Pd} / (U cos φ). Demand factors Ks: lighting ${O.ks.light}, sockets ${O.ks.socket}, air conditioners ${O.ks.ac}, water heaters ${O.ks.heater}, hob ${O.ks.hob}; diversity between the floor boards ${Kd} = ${O.kdt}.`,
    `${Id} of a lighting or socket circuit: Ks P / (U cos φ); of a dedicated circuit (air conditioner, water heater, hob, pump): the full P / (U cos φ), its Ks only counts in the load of the board.`,
    `Breakers: In ≥ ${Id}; cables Cu/PVC in conduit, two loaded cores: Iz ≥ In (1.5: 17.5 A, 2.5: 24 A, 4: 32 A, 6: 41 A, 10: 57 A, 16: 76 A).`,
    `Voltage drop ΔU% = 2 L I ρ / (S U) x 100, ρ = ${O.rho} Ω mm²/m; at most 3 % on a circuit.`,
    `Installed power: socket ${O.power.socket} W, worktop socket ${O.power.counter} W, water heater ${O.power.heater} W, hob ${O.power.hob} W, pump ${O.power.pump} W, air conditioners about BTU/10 W.`,
    'Standards: QCVN 12:2014/BXD, TCVN 9206:2012, TCVN 9207:2012, TCVN 7447 (IEC 60364), TCVN 9385:2012 (earthing).',
  ] : [
    `Nguồn 1 pha ${O.voltage} V, cos φ = ${c(O.cosphi)}; Itt = Ptt / (U cos φ). Hệ số đồng thời Ks: chiếu sáng ${c(O.ks.light)}, ổ cắm ${c(O.ks.socket)}, điều hòa ${c(O.ks.ac)}, bình nóng lạnh ${c(O.ks.heater)}, bếp ${c(O.ks.hob)}; giữa các tủ tầng Kđt = ${c(O.kdt)}.`,
    'Itt của mạch chiếu sáng, ổ cắm: Ks P / (U cos φ); của mạch riêng (điều hòa, bình nóng lạnh, bếp, bơm): lấy đủ P / (U cos φ), Ks của mạch riêng chỉ dùng khi cộng phụ tải tủ.',
    'Thiết bị bảo vệ: In ≥ Itt; dây Cu/PVC đi trong ống, 2 lõi mang tải: Iz ≥ In (1,5: 17,5 A; 2,5: 24 A; 4: 32 A; 6: 41 A; 10: 57 A; 16: 76 A).',
    `Sụt áp ΔU% = 2 L I ρ / (S U) x 100, ρ = ${c(O.rho)} Ω mm²/m; không quá 3 % trên mỗi mạch.`,
    `Công suất đặt: ổ cắm ${O.power.socket} W, ổ mặt bếp ${O.power.counter} W, bình nóng lạnh ${O.power.heater} W, bếp từ ${O.power.hob} W, bơm ${O.power.pump} W, điều hòa khoảng BTU/10 W.`,
    'Tiêu chuẩn: QCVN 12:2014/BXD, TCVN 9206:2012, TCVN 9207:2012, TCVN 7447 (IEC 60364), TCVN 9385:2012 (tiếp địa).',
  ];
}
