// The surface model of the finishes: every finished surface of a floor as a FACE record, measured on what is built
// (plan and elevation): a wall face by the height of the wall behind it, the reveals of its openings, the vertical face
// of a dropped ceiling, treads and risers, skirting stepped along a stair, sloped soffits and roofs - never a room plan
// area or a perimeter times one height where the surface is vertical, sloped or stepped. The architectural bill
// (archboq.mjs) and the interior schedule (interior.mjs materialSchedule) both take their rows from these faces, so
// the two always agree. A face carries its ledger (gross, deductions, additions) and two quantities: net (the
// geometry: everything deducted) and measured (by the rule set of rules.mjs: an opening under rules.void.finish is not
// taken off), with the text of how it is made up (diễn giải).
//
// A face: { id, floor, room (room or location), kind, part (floor | skirting | wall | ceiling | soffit of the room
// finish, or null), code (finish code FL / SK / WL / CL, or the work key OUT, SLAB, WET, BALC, TERR, SCREED, ROOF, PITCH,
// RAIL, BALRAIL), desc (the description of the finish code), unit (m² | m), n (like parts), L, H (m, when the face is
// a strip or a rectangle; otherwise gross is the area of the outline), gross, deductions [{what, area | len, w, h,
// opening, always, off, u, z (a wall face: where the opening stands in it, m), poly (a face with an outline: the shape
// of the deduction in plan, mm; it may run past the outline)}], additions [{what, area, kind: reveal | upturn | threshold
// (the floor under a door: its clear width x half the wall) | slabzone | beam_side, perimeter, depth, n, L, H, expr,
// opening, poly}], net, measured, how, hnote (what the height of a wall face runs to, where there is no ceiling),
// none (a face of a room with no finish), edge / from / to (the room edge of a wall or skirting face, mm),
// stair + link (a stair face: the index of its stair in the stair list and its n, L, H as expressions of the stair
// parameters {n1} {n2} {riser} {going} {w} {landing} {B} {gap} {c1} {c2} {wall}, for the live workbook) }.
// Kinds: floor, landing (the floor of a stair room outside the wells, the half landing of a stair), ceiling (the flat
// part), ceiling_drop (the vertical face of a drop band), soffit, wall, splashback, skirting, tread, riser,
// stair_skirting, handrail, railing, waterproof, screed, roof, roof_pitched, exterior, parapet_top, column (the faces
// of a column that stands out of a wall or free in a room, with the wall finish of the room). The reveals (má
// cửa) are additions of the wall or exterior face they open in (kind: reveal, with the perimeter and the depth);
// revealFaces lists them as records of their own.
import { ROOM } from './standards.mjs';
import { buildModel, FLOOR_DEFAULTS } from './elevation.mjs';
import {
  BACKSPLASH, boxInterval, boxMid, clipSeg, clipToBox, dejog, edgesOf, inside, offsetPoly, openingsOn, perimeter, polyArea, resolveFinish, stairSpots, tooNarrow, wallFrame,
  wallHeightBehind,
} from './interior.mjs';
import { expandStairs, segRect, spiralGeom, uStairFinish, uStairGeom } from './plan.mjs';
import { measured as byRule, net as geometric, ruleSet } from './rules.mjs';

const WET = ROOM.wet, OUTDOOR = ROOM.outdoor;
/** Depth of a door or window frame in its wall (mm): a reveal is half the wall thickness less half a frame. */
export const FRAME = 50;
/** Height of the waterproofing turned up the walls (mm). */
export const UPTURN = 300;
/** A wall face lies along a line when it is within this distance of it (mm): a thicker wall beside a stairwell. */
const ALONG = 60;
/** A column that stands out of a wall face by less than this (mm) is flush with it under the plaster. */
export const FLUSH = 20;

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const left = (d) => [-d[1], d[0]];
const DEG = Math.PI / 180;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const sum = (list, f) => list.reduce((s, x) => s + f(x), 0);

// the order of the faces of a room or location
// clear height under which a flight needs the ceiling open above it
const HEADROOM = 2000;
const KIND_ORDER = ['floor', 'landing', 'tread', 'riser', 'ceiling', 'ceiling_drop', 'soffit', 'wall', 'column', 'splashback', 'skirting', 'stair_skirting', 'handrail', 'railing', 'waterproof', 'screed',
  'exterior', 'parapet_top', 'roof', 'roof_pitched'];

const WORDS = {
  vi: {
    door: 'cửa đi', window: 'cửa sổ', void: 'ô trống', reveal: 'má cửa', splash: 'ốp bếp', well: 'ô thang', upturn: 'quét lên tường', outline: 'theo đường bao', stair: 'CẦU THANG',
    balcony: 'BAN CÔNG', roof: 'MÁI', flight: 'vế', halfLanding: 'chiếu nghỉ', aroundLanding: 'quanh chiếu nghỉ', gap: 'khe thang', guard: 'lan can ô thang', top: '(đỉnh tường)',
    notOff: 'không trừ, nhỏ hơn', noFinish: 'không hoàn thiện', goings: 'mặt bậc', risers: 'cổ bậc', onSlope: 'theo dốc', slope: 'mái dốc', drop: 'mặt đứng giật cấp', sides: 'bên tường',
    soffit: 'đáy sàn', flightSoffit: 'đáy bản thang', landingSoffit: 'đáy chiếu nghỉ',
    hipRoof: 'mái hông bốn mái, dốc', spiral: 'thang xoắn, bậc', under: 'ngưỡng', stairHole: 'lỗ trần chỗ thang đi qua', foot: 'chân thang', toSoffit: 'cao đến đáy sàn', toRoof: 'cao đến đáy mái', openWell: 'ô thang thông tầng, cao tầng', throughSlab: 'qua chiều dày sàn tại ô thang',
    beamSide: 'thành dầm', column: 'cột', colFree: 'cột giữa phòng', colWall: 'cột nhô khỏi tường', perim: 'chu vi', doors: 'cửa',
  },
  en: {
    door: 'door', window: 'window', void: 'opening', reveal: 'reveals', splash: 'splashback', well: 'stairwell', upturn: 'up the walls', outline: 'by the outline', stair: 'STAIR',
    balcony: 'BALCONY', roof: 'ROOF', flight: 'flight', halfLanding: 'half landing', aroundLanding: 'around the landing', gap: 'well', guard: 'guard at the stairwell', top: '(top)',
    notOff: 'not deducted, under', noFinish: 'no finish', goings: 'goings', risers: 'risers', onSlope: 'on the slope', slope: 'slope', drop: 'drop face', sides: 'wall sides',
    soffit: 'soffit', flightSoffit: 'flight soffit', landingSoffit: 'landing soffit',
    hipRoof: 'hip roof, four slopes at', spiral: 'spiral stair, treads', under: 'under', stairHole: 'opening where the stair passes', foot: 'stair footprint', toSoffit: 'up to the slab soffit', toRoof: 'up to the roof soffit', openWell: 'open stairwell, storey', throughSlab: 'through the slab at the stairwell',
    beamSide: 'beam sides', column: 'column', colFree: 'free column', colWall: 'column standing out of the wall', perim: 'perimeter', doors: 'doors',
  },
};

/** A number of the "how" text: two decimals, three or four where they count (2,575; 0,2861), a decimal comma in Vietnamese. */
export function nf(v, en = false) {
  const r = Math.round(v * 1e4) / 1e4;
  const whole = (k) => Math.abs(r * k - Math.round(r * k)) < 1e-9;
  const s = r.toFixed(whole(100) ? 2 : whole(1000) ? 3 : 4);
  return en ? s : s.replace('.', ',');
}

function howText(f, R, en) {
  const t = WORDS[en ? 'en' : 'vi'], x = ' x ';
  const lin = f.unit === 'm', key = lin ? 'len' : 'area';
  let s = f.expr ?? (f.L !== undefined ? `${f.n !== 1 ? `${f.n}${x}` : ''}${nf(f.L, en)}${!lin && f.H !== undefined ? `${x}${nf(f.H, en)}` : ''}` : `${nf(f.gross, en)} (${t.outline})`);
  const skipped = [];
  for (const d of f.deductions) {
    const v = d.w !== undefined && d.h !== undefined ? `${nf(d.w, en)}${x}${nf(d.h, en)}` : nf(d[key], en);
    if (d.off) s += ` - ${v} (${d.what})`;
    else skipped.push(`${d.what} ${v}`);
  }
  for (const a of f.additions) {
    if (a.kind === 'reveal' && !R.reveals) continue;
    const v = a.perimeter !== undefined ? `${nf(a.perimeter, en)}${x}${nf(a.depth, en)}` : a.L !== undefined ? `${a.n > 1 ? `${a.n}${x}` : ''}${nf(a.L, en)}${x}${nf(a.H, en)}` : nf(a.area, en);
    s += ` + ${a.what} ${v}`;
  }
  if (f.hnote) s += ` [${f.hnote}]`;
  if (skipped.length) s += ` (${t.notOff} ${nf(R.void.finish, en)} m²: ${skipped.join('; ')})`;
  if (f.none) s += ` (${t.noFinish})`;
  return f.what ? `${f.what}: ${s}` : s;
}

/**
 * Closes the ledger of a face: gross (n x L x H, n x L for a length, unless given), net (the geometry: every deduction
 * taken off, every addition counted), measured (by the rule set: a deduction smaller than rules.void.finish is not
 * taken off - one flagged always is, such as another finish on the same wall; reveals count when rules.reveals) and
 * the text of how the quantity is made up.
 */
export function closeFace(f, rules = null, en = false) {
  const R = ruleSet(rules);
  const lin = f.unit === 'm', key = lin ? 'len' : 'area';
  if (f.gross === undefined) f.gross = f.n * (f.L ?? 0) * (lin ? 1 : f.H ?? 0);
  const fixed = f.deductions.filter((d) => d.always), rest = f.deductions.filter((d) => !d.always);
  const thr = lin ? 0 : R.void.finish;
  for (const d of f.deductions) d.off = d.always || d[key] >= thr;
  f.net = geometric(f.gross, f.deductions, f.additions, key);
  f.measured = f.none ? 0 : byRule(f.gross - sum(fixed, (d) => d[key]), rest, R.reveals ? f.additions : f.additions.filter((a) => a.kind !== 'reveal'), thr, key);
  f.how = howText(f, R, en);
  return f;
}

/** The part (0..1) of the line p-q that has a wall face of the model along it. */
function wallCover(M, p, q) {
  if (!M) return 1;
  const L = len(sub(q, p));
  if (L < 1) return 0;
  const d = mul(sub(q, p), 1 / L), N = Math.max(4, Math.ceil(L / 100));
  let hit = 0;
  for (let i = 0; i < N; i++) {
    const pt = add(p, mul(d, ((i + 0.5) * L) / N));
    const on = M.walls.some((w) => w.segs.some((s) => {
      if (Math.abs(cross(s.d, d)) > 0.02) return false;
      const u = dot(sub(pt, s.a), s.d), off = dot(sub(pt, s.a), left(s.d));
      return u > -s.t / 2 && u < s.L + s.t / 2 && (Math.abs(off - s.o1) <= ALONG || Math.abs(off - s.o2) <= ALONG);
    }));
    if (on) hit++;
  }
  const c = hit / N;
  return c > 0.97 ? 1 : c < 0.03 ? 0 : c;
}

/** The stairs that start on a floor: U stairs (geometry of the plan engine) and straight flights. */
function stairsOf(spec, height, warnings) {
  const out = [];
  expandStairs(spec?.stairs).forEach((st, i) => {
    if (st.type === 'spiral') {
      try {
        const G = spiralGeom(st, `stairs[${i}]`), h = Number(st.height ?? height);
        out.push({ type: 'spiral', st, G, height: h, riser: h / G.risers, mid: G.c, box: G.box, z0: 0 });
      } catch (e) {
        warnings.push(`stairs[${i}]: not measured (${e.message})`);
      }
      return;
    }
    if (st.type === 'u') {
      if (!Array.isArray(st.region)) return;
      try {
        const g = uStairGeom(st, height, `stairs[${i}]`);
        out.push({ type: 'u', st, g, fin: uStairFinish(g), height, mid: [(st.region[0][0] + st.region[1][0]) / 2, (st.region[0][1] + st.region[1][1]) / 2] });
      } catch (e) {
        warnings.push(`stairs[${i}]: not measured (${e.message})`);
      }
      return;
    }
    if (!Array.isArray(st.start)) return;
    const a = (Number(st.direction ?? 90) * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a)], n = left(u);
    const w = Number(st.width ?? 1200), k = Math.round(Number(st.treads ?? 10)), going = Number(st.going ?? 270);
    if (!(w > 0 && k > 0 && going > 0)) return;
    // a flight of an L stair takes its share of the storey; its quarter landing has no riser
    const risers = Math.round(Number(st.risers ?? k + 1)), full = Number(st.height ?? height), h = full * (st.rise_share ?? 1);
    const c0 = add([Number(st.start[0]), Number(st.start[1])], mul(n, -w / 2));
    const at = (x, y) => add(add(c0, mul(u, x)), mul(n, y));
    const run = k * going, pts = [at(0, 0), at(run, 0), at(run, w), at(0, w)];
    const axis = Math.abs(u[0]) < 1e-6 || Math.abs(u[1]) < 1e-6;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    out.push({
      type: 'straight', st, k, going, w, risers, riser: risers > 0 ? h / risers : 0, run, at, height: h, mid: at(run / 2, w / 2), z0: full * (st.rise_from ?? 0), landing: !!st.landing,
      box: axis ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null,
    });
  });
  return out;
}

const boxPoly = (b) => [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
/** The length (mm) of the edge e that lies along a box (inside it, or within ALONG beside it). */
function alongBox(e, b) {
  const kx = Math.abs(e.t[0]) > 0.99 ? 0 : ALONG, ky = Math.abs(e.t[1]) > 0.99 ? 0 : ALONG;
  const iv = boxInterval(e.a, e.b, [b[0] - kx, b[1] - ky, b[2] + kx, b[3] + ky]);
  return iv ? (iv[1] - iv[0]) * e.L : 0;
}

/**
 * The structure of one storey, for the finishes that meet it: from a calculation result R (structuralCalc of calc.mjs)
 * and the floor (its name in R.floors, else its index from the bottom), or as given {soffit, slab, beams, columns}.
 * Returns {soffit (the underside of the slab over the storey, mm above its floor), slab (its thickness), beams [{name,
 * A, B, b, h}] of that slab (h with the slab), columns [{name, mark, box [x0, y0, x1, y1]}] that stand in the storey},
 * or null when there is none.
 */
export function storeyStructure(structure, { floor = null, index = null } = {}) {
  if (!structure) return null;
  if (!Array.isArray(structure.slabs)) {
    if (!structure.beams && !structure.columns && structure.soffit === undefined) return null;
    return { soffit: structure.soffit ?? null, slab: structure.slab ?? null, beams: structure.beams ?? [], columns: structure.columns ?? [] };
  }
  const R = structure, F = R.floors ?? [];
  let k = floor !== null && floor !== '' ? F.findIndex((f) => f.name === floor) : -1;
  if (k < 0 && index !== null && F[index]) k = index;
  if (k < 0 && F.length === 1) k = 0;
  if (k < 0) return null;
  const z0 = F[k].level, z1 = F[k].level + F[k].height;
  // the slab over the storey: the floor slab of the next floor (its top at that floor), or a roof slab on the walls
  const tops = R.slabs.filter((S) => S.kind !== 'foundation' && S.slab > 0);
  const above = tops.find((S) => Math.abs(S.level - z1) < 1) ?? tops.find((S) => Math.abs(S.level - S.slab - z1) < 1) ?? null;
  return {
    soffit: above ? above.level - above.slab - z0 : null, slab: above?.slab ?? null,
    beams: (above?.members ?? []).map((m) => ({ name: m.name, A: m.A, B: m.B, b: m.b, h: m.h })),
    columns: (R.columns ?? []).filter((c) => c.bottom <= z0 + 1 && c.top >= z1 - 1)
      .map((c) => ({ name: c.name, mark: c.mark ?? null, box: [c.at[0] - c.size[0] / 2, c.at[1] - c.size[1] / 2, c.at[0] + c.size[0] / 2, c.at[1] + c.size[1] / 2] })),
  };
}

/**
 * The finished surfaces of one floor. spec: the plan of the floor (walls, openings, stairs, stairs_below, balconies,
 * roofs); rooms {name: outline}; finishes {name: finish of resolveFinish}; items (resolved furniture: the kitchen
 * splashback); floor: its name; height: the storey height (default: of the plan); top: the last floor (an outdoor room
 * is a roof terrace there); ground: the plinth below the floor that the outer faces go down to (mm, the ground floor);
 * shell: false leaves out what is not a room finish (outer faces, soffits, waterproofing, roofs, railings); slab: the
 * thickness of the floor slab over the floor (mm; a floor with a floor above it - not the last one, or a plan whose
 * roofs are an empty list - default 120): in a room with no suspended ceiling the wall finish goes up to its soffit;
 * structure: the calculation result (structuralCalc) or the structure of the storey (storeyStructure), index: the
 * place of the floor from the bottom when its name is not in the result: the sides of the beams that cross a room
 * whose soffit is the finish, the faces of the columns that stand out of a wall or free in a room, the slab soffit.
 * Returns {faces, measures (per room: area, per, doorW, wall {gross, opArea, splash, net}, finish, floorArea, skirt),
 * stairs (the stair list, the parameters of the stair sheet), M (the plan model), warnings, assumed (what the model
 * assumed that the quantities rest on: a roof the plan does not give)}.
 */
export function floorSurfaces({ spec, rooms = {}, finishes = {}, items = [], floor = null, lang = 'vi', rules = null, height = null, top = true, ground = 0, shell = true, slab = null, structure = null, index = null }) {
  const en = lang === 'en', R = ruleSet(rules), t = WORDS[en ? 'en' : 'vi'];
  const M = spec?.walls?.length ? buildModel(spec) : null;
  const Htop = height ?? M?.H.top ?? 3000;
  const fl = floor ?? '';
  // the storey: its height, whether a floor slab lies over it, the underside of that slab (of a roof slab on the walls:
  // the storey height)
  const ST = storeyStructure(structure, { floor: fl, index });
  const storey = M?.H.top ?? Htop;
  const covered = !top || (Array.isArray(spec?.roofs) && !spec.roofs.length);
  const soffit = ST?.soffit ?? (covered ? storey - (slab ?? FLOOR_DEFAULTS.slab) : storey);
  const faces = [], measures = [], stairRows = [], warnings = [], assumed = [];
  const face = (o) => {
    const f = { id: '', floor: fl, n: 1, unit: 'm²', part: null, code: null, deductions: [], additions: [], ...o };
    faces.push(f);
    return f;
  };
  const opName = (op) => op.tag ?? (op.type === 'window' ? t.window : op.type === 'opening' ? t.void : t.door);
  const opId = (op) => `O${M.openings.indexOf(op) + 1}`;
  // the reveal of an opening on one side of its wall: the jambs over the deducted height, the head where it lies
  // under the top of the face, the sill of a window; half the wall thickness, less half a frame for a door or window
  const reveal = (op, w, hh, faceTop) => {
    const depth = Math.max(0, op.type === 'opening' ? op.s.t / 2 : (op.s.t - FRAME) / 2) / 1000;
    const head = op.head < faceTop - 1e-6, sill = op.type === 'window' && op.sill > 0;
    const per = 2 * hh + (head ? w : 0) + (sill ? w : 0);
    return depth > 0 && hh > 0 ? { what: `${t.reveal} ${opName(op)}`, kind: 'reveal', area: per * depth, perimeter: per, depth, opening: opId(op), w, h: hh } : null;
  };

  // ---- the stairs of the floor
  const stairs = stairsOf(spec, Htop, warnings);
  const hostOf = (S) => Object.entries(rooms).find(([name, poly]) => finishes[name]?.kind === 'stair' && inside(S.mid, poly))?.[0] ?? null;

  // ---- the kitchen splashbacks: a face of their own, deducted from the wall they stand on
  const splash = {};
  for (const b of items.filter((it) => it.type === 'kitchen_base')) {
    const up = items.find((it) => it.type === 'kitchen_wall' && it.room === b.room);
    const h = Math.max(0, (up ? up.opts.z0 : b.h + 650) - b.h);
    const f = face({ kind: 'splashback', part: 'wall', code: BACKSPLASH.code, desc: BACKSPLASH.description, pattern: 'tile', room: b.room, L: b.w / 1000, H: h / 1000 });
    (splash[b.room] ??= []).push({ item: b, area: f.L * f.H, w: f.L, h: f.H });
  }

  // ---- the rooms: floor, ceiling and its drop, walls edge by edge with their openings and reveals, skirting
  for (const [name, poly] of Object.entries(rooms)) {
    const f = finishes[name];
    if (!f) continue;
    const E = edgesOf(poly);
    const area = Math.abs(polyArea(poly)) / 1e6, per = perimeter(poly) / 1000;
    const edgeH = E.map((e) => (M ? wallHeightBehind(M, e) : null));
    const ops = E.map((e) => openingsOn(M, e, wallFrame(e)));
    const isDoor = (op) => op.type !== 'window';
    const doorW = sum(ops.flat().filter((o) => isDoor(o.op)), (o) => (o.ub - o.ua) / 1000);
    const stair = f.kind === 'stair';
    // A stair room: outside the wells its floor and skirting are those of a room (the landing at the foot or at the
    // head of the stair); the flights are measured on their real surfaces on the floor they start from (below)
    // (a straight flight takes its footprint off the floor of whatever room it stands in)
    const wells = [
      // (a U stair standing in a room that is not a stair room takes its well off that room too)
      ...(spec ? stairSpots(spec).filter((x) => inside(boxMid(x.well), poly)) : []),
      ...stairs.filter((S) => S.type === 'straight' && S.box && inside(S.mid, poly)).map((S) => ({ well: S.box, up: true, flight: true, S })),
      // a spiral stair: its circle (the box for what lies along it, the area of the circle off the floor)
      ...stairs.filter((S) => S.type === 'spiral' && inside(S.mid, poly)).map((S) => ({ well: S.box, up: true, flight: true, S, area: (Math.PI * S.G.R ** 2) / 1e6 })),
    ];
    // the floor under the doors and plain openings of the room: their clear width x half the wall, on this side
    const sills = E.flatMap((e, k) => {
      const F = wallFrame(e);
      return ops[k].filter((o) => isDoor(o.op)).map(({ ua, ub, op }) => {
        const at = (u) => add(e.a, mul(F.r, u - F.u(e.a))), out = mul(e.n, op.s.t / 2);
        return { what: `${t.under} ${opName(op)}`, kind: 'threshold', area: ((ub - ua) / 1000) * (op.s.t / 2000), L: (ub - ua) / 1000, H: op.s.t / 2000, opening: opId(op), poly: [at(ua), at(ub), add(at(ub), out), add(at(ua), out)] };
      });
    });
    // the columns of the structure that stand in the room: their footprint, the wall finish around them (below)
    const inWell = (c) => wells.some((x) => c[0] > x.well[0] && c[0] < x.well[2] && c[1] > x.well[1] && c[1] < x.well[3]);
    const colName = (c) => `${c.mark ?? ''}${c.mark ? ' ' : ''}${String(c.name).startsWith('(') ? c.name : `(${c.name})`}`;
    const cols = (ST?.columns ?? []).map((c) => {
      const cut = clipToBox(poly, c.box);
      const a2 = cut.length < 3 ? 0 : Math.abs(polyArea(cut));
      if (a2 < 1) return null;
      const [x0, y0, x1, y1] = c.box;
      const sides = [[[x0, y0], [x1, y0], [0, -1]], [[x1, y0], [x1, y1], [1, 0]], [[x1, y1], [x0, y1], [0, 1]], [[x0, y1], [x0, y0], [-1, 0]]];
      // what of the outline of the column lies in the room (a side tested a millimetre out of the column: one in the
      // plane of a wall face does not count), and the wall face the column covers (a room edge that runs through it)
      const girth = sum(sides, ([a, b, n]) => sum(clipSeg(add(a, n), add(b, n), poly), ([q, r]) => len(sub(r, q))));
      const behind = E.map((e) => {
        const on = Math.abs(e.t[0]) > 0.99 ? Math.min(Math.abs(e.a[1] - y0), Math.abs(e.a[1] - y1)) < 0.5 : Math.abs(e.t[1]) > 0.99 ? Math.min(Math.abs(e.a[0] - x0), Math.abs(e.a[0] - x1)) < 0.5 : false;
        const iv = on ? null : boxInterval(e.a, e.b, c.box);
        return iv ? (iv[1] - iv[0]) * e.L : 0;
      });
      const hidden = sum(behind, (v) => v);
      // flush under the plaster: it stands out of the wall faces by less than FLUSH (its area in the room over the
      // length of wall face it covers)
      if (hidden >= 1 && a2 / hidden < FLUSH) return null;
      return { c, label: colName(c), area: a2 / 1e6, mid: [(x0 + x1) / 2, (y0 + y1) / 2], girth, hidden, behind };
    }).filter(Boolean);
    const colOff = () => cols.filter((x) => !inWell(x.mid)).map((x) => ({ what: `${t.column} ${colName(x.c)}`, area: x.area, column: x.c.name, poly: boxPoly(x.c.box) }));
    const kind = { kind: f.kind ?? '', outdoor: OUTDOOR.test(name), wet: WET.test(name) };
    const base = { room: name, finishKind: f.kind ?? '' };
    // floor
    const wellArea = wells.map((x) => x.area ?? Math.abs(polyArea(clipToBox(poly, x.well))) / 1e6);
    const floorNet = Math.max(0, area - sum(wellArea, (a) => a));
    if (f.floor ? floorNet > 1e-6 || sills.length > 0 : true) {
      face({
        ...base, kind: stair ? 'landing' : 'floor', part: 'floor', code: f.floor?.code ?? null, desc: f.floor?.description, pattern: f.floor?.pattern, none: !f.floor, gross: area, outline: poly,
        deductions: [...wells.map((x, i) => ({ what: x.flight ? t.foot : t.well, area: Math.min(wellArea[i], area), always: true, poly: boxPoly(x.well) })).filter((d) => d.area > 1e-9), ...colOff()],
        additions: f.floor ? sills.map((a) => ({ ...a })) : [],
      });
    }
    // ceiling: the flat part (the field and the underside of the band make up the plan of the room) and the vertical
    // face of the drop band along its inner edge
    const band = f.ceiling?.drop && !tooNarrow(f.ceiling.drop, poly) ? f.ceiling.drop : null;
    if (f.ceiling) {
      const cl = { ...base, part: 'ceiling', code: f.ceiling.code, desc: f.ceiling.description };
      // a straight flight goes up through the ceiling: the ceiling is open from where the treads come within the
      // headroom (2 m) of it to the head of the flight
      const cz = (f.ceiling.level ?? 3000) - (band?.depth ?? 0);
      const holes = wells.filter((x) => x.flight && x.S && (x.S.z0 ?? 0) + x.S.height > cz - HEADROOM).map((x) => {
        const S = x.S;
        if (S.type === 'spiral') return { what: t.stairHole, area: Math.min(x.area, area), always: true, poly: boxPoly(S.box) };
        // from where the treads come within the headroom of the ceiling (a flight of an L stair starts at its own level)
        const u0 = S.height > 0 ? S.run * Math.min(1, Math.max(0, (cz - HEADROOM - (S.z0 ?? 0)) / S.height)) : 0;
        const hole = [S.at(u0, 0), S.at(S.run, 0), S.at(S.run, S.w), S.at(u0, S.w)];
        const a2 = Math.abs(polyArea(hole)) / 1e6;
        return a2 > 1e-6 ? { what: t.stairHole, area: Math.min(a2, area), always: true, poly: hole } : null;
      }).filter(Boolean);
      face({ ...cl, kind: 'ceiling', gross: area, outline: poly, deductions: [...holes, ...cols.map((x) => ({ what: `${t.column} ${colName(x.c)}`, area: x.area, column: x.c.name, poly: boxPoly(x.c.box) }))] });
      if (band && band.depth > 0) {
        const inner = offsetPoly(dejog(poly), band.width);
        const Lin = inner ? perimeter(inner) / 1000 : Math.max(0, per - (8 * band.width) / 1000);
        face({ ...cl, kind: 'ceiling_drop', L: Lin, H: band.depth / 1000, what: t.drop });
      }
    }
    // the walls are finished up to the ceiling: its drop band along the walls, or the flat ceiling of a room too
    // narrow for the band; each edge to the height of the wall behind it (a parapet is lower than the storey)
    // With no suspended ceiling the finish goes up to the soffit of the slab over the room (the storey height less the
    // slab; under a roof slab that sits on the walls, the storey height); an outdoor room under the sky keeps the
    // height of its walls. Along a stairwell that is open through the slab above, the wall runs on: the full storey
    const sky = kind.outdoor && !covered;
    const low = f.ceiling ? (f.ceiling.level ?? 3000) - (band?.depth ?? 0) : sky ? storey : soffit;
    const hTo = !f.wall || f.wall.height === undefined || f.wall.height === 'ceiling' || f.wall.pattern === 'paint' ? low : Math.min(low, f.wall.height);
    const bare = !f.ceiling && !sky && hTo === low;
    const through = bare && soffit < storey - 1e-6 ? wells.filter((x) => x.up).map((x) => x.well) : [];
    const walls = E.map((e, k) => {
      const run = Math.min(e.L, sum(through, (b) => alongBox(e, b)));
      const whole = run >= e.L - 1, cap = whole ? storey : hTo;
      const h = Math.min(cap, edgeH[k] ?? cap);
      const w = face({
        ...base, kind: 'wall', part: 'wall', code: f.wall?.code ?? null, desc: f.wall?.description, pattern: f.wall?.pattern, none: !f.wall, L: e.L / 1000, H: h / 1000, edge: k,
        from: e.a, to: e.b,
      });
      if (bare && h === cap) {
        w.hnote = whole ? `${t.openWell} ${nf(storey / 1000, en)}`
          : soffit < storey - 1e-6 ? `${t.toSoffit} ${nf(storey / 1000, en)} - ${nf((storey - soffit) / 1000, en)}` : `${covered ? t.toSoffit : t.toRoof} ${nf(soffit / 1000, en)}`;
        if (!whole && run > 1 && f.wall) w.additions.push({ what: t.throughSlab, kind: 'slabzone', area: (run / 1000) * ((storey - soffit) / 1000), L: run / 1000, H: (storey - soffit) / 1000 });
      }
      const u0 = wallFrame(e).u0;
      for (const { ua, ub, op } of ops[k]) {
        const ow = (ub - ua) / 1000, sill = op.type === 'window' ? op.sill : 0;
        const hh = Math.max(0, Math.min(op.head, h) - sill) / 1000;
        if (!(hh > 0)) continue;
        // u, z: where the opening stands in the face (from its left end, above the floor), for whoever redraws it
        w.deductions.push({ what: opName(op), area: ow * hh, w: ow, h: hh, opening: opId(op), full: op.head <= h + 1e-6, u: (ua - u0) / 1000, z: sill / 1000 });
        const rv = f.wall ? reveal(op, ow, hh, h) : null;
        if (rv) w.additions.push(rv);
      }
      return w;
    });
    // the splashback of the kitchen stands on the wall behind the base units
    for (const sp of splash[name] ?? []) {
      const b = sp.item;
      const c = b.o && b.ex ? add(b.o, mul(b.ex, b.w / 2)) : null;
      let best = null;
      if (c) {
        E.forEach((e, k) => {
          if (Math.abs(cross(e.t, b.ex)) > 0.05) return;
          const u = dot(sub(c, e.a), e.t), d = Math.abs(dot(sub(c, e.a), e.n));
          if (u < -1 || u > e.L + 1) return;
          if (!best || d < best.d) best = { k, d };
        });
      }
      const w = walls[best?.k ?? walls.reduce((m, x, k) => (x.gross ?? x.L * x.H) > (walls[m].L * walls[m].H) ? k : m, 0)];
      if (!w) continue;
      const room = Math.max(0, w.L * w.H - sum(w.deductions, (d) => d.area));
      const a = Math.min(sp.area, room);
      // where it stands in the face: from the left end of the face, above the base units
      const Fb = best ? wallFrame(E[best.k]) : null;
      const pos = Fb ? { u: (Math.min(Fb.u(b.o), Fb.u(add(b.o, mul(b.ex, b.w)))) - Fb.u0) / 1000, z: b.h / 1000 } : {};
      if (a > 1e-9) w.deductions.push({ what: `${t.splash} ${BACKSPLASH.code}`, area: a, ...(a === sp.area ? { w: sp.w, h: sp.h, ...pos } : {}), always: true });
    }
    // a column that stands out of a wall face, or free in the room: the wall finish wraps what of its outline lies in
    // the room, less the strip of wall face it covers (2 x its projection for a column in a wall, its girth when free,
    // nothing in a corner where it only moves the corner in)
    if (f.wall) {
      for (const { c, girth, hidden, behind } of cols) {
        const more = girth - hidden;
        if (!(more > 1)) continue;
        const free = hidden < 1, kb = behind.indexOf(Math.max(...behind));
        const hc = free ? hTo : walls[kb].H * 1000;
        face({
          ...base, kind: 'column', part: 'wall', code: f.wall.code, desc: f.wall.description, pattern: f.wall.pattern, column: c.name,
          what: `${free ? t.colFree : t.colWall} ${colName(c)}`, n: free ? 1 : 2, L: (free ? more : more / 2) / 1000, H: hc / 1000,
        });
      }
    }
    // skirting: a run per edge less the doors and plain openings on it (and, in a stair room, less what lies along
    // the wells: the skirting there steps with the flights)
    let wellRun = 0, colSkirt = 0;
    if (f.skirting) {
      E.forEach((e, k) => {
        const s = face({ ...base, kind: 'skirting', part: 'skirting', code: f.skirting.code, desc: f.skirting.description, unit: 'm', L: e.L / 1000, edge: k, from: e.a, to: e.b, stairRoom: stair });
        for (const { ua, ub, op } of ops[k]) if (isDoor(op)) s.deductions.push({ what: opName(op), len: (ub - ua) / 1000, opening: opId(op), always: true });
        for (const { well, flight } of wells) {
          const run = Math.min(alongBox(e, well) / 1000, s.L - sum(s.deductions, (d) => d.len));
          if (run > 1e-9) {
            s.deductions.push({ what: flight ? t.foot : t.well, len: run, always: true });
            wellRun += run;
          }
        }
        if (s.L - sum(s.deductions, (d) => d.len) < 1e-6) faces.splice(faces.indexOf(s), 1);
      });
      // round the columns: what of their outline lies in the room, less the wall face they cover
      for (const x of cols) {
        const more = (x.girth - x.hidden) / 1000;
        if (!(more > 1e-3) || inWell(x.mid)) continue;
        face({ ...base, kind: 'skirting', part: 'skirting', code: f.skirting.code, desc: f.skirting.description, unit: 'm', L: r6(more), what: `${t.column} ${colName(x.c)}`, column: x.c.name, stairRoom: stair });
        colSkirt += more;
      }
    }
    measures.push({
      floor: fl, room: name, kind: f.kind ?? '', area, per, doorW, wellRun, colSkirt, finish: f, edges: E.length, wells, wet: kind.wet, outdoor: kind.outdoor, sills, cols, colOff,
      wall: f.wall ? { gross: sum(walls, (w) => w.L * w.H), opArea: sum(walls, (w) => sum(w.deductions.filter((d) => d.opening), (d) => d.area)), splash: sum(walls, (w) => sum(w.deductions.filter((d) => !d.opening), (d) => d.area)) } : null,
    });
  }

  // ---- the stairs on their real surfaces: treads and half landing, risers (the same stone), the skirting stepped
  // along the walls beside the flights and around the landing, the handrail on the slope, the sloped soffits
  stairs.forEach((S, i) => {
    const host = hostOf(S);
    const sf = host ? finishes[host] : resolveFinish(t.stair, {}, [], Htop);
    const room = host ?? t.stair;
    const st = { stair: i }, x = ' x ';
    const fin = sf.floor ? { part: 'floor', code: sf.floor.code, desc: sf.floor.description, pattern: sf.floor.pattern } : null;
    const sk = sf.skirting ? { part: 'skirting', code: sf.skirting.code, desc: sf.skirting.description, unit: 'm' } : null;
    const slope = (n, going, riser) => Math.hypot((n - 1) * going, n * riser);
    const slopeX = (n) => `SQRT((({${n}}-1)*{going})^2+({${n}}*{riser})^2)`;
    const stepped = (n, going, riser, c) => `${c !== 1 ? `${nf(c, en)}${x}` : ''}(${n - 1}${x}${nf(going, en)} + ${n}${x}${nf(riser, en)})`;
    if (S.type === 'u') {
      const g = S.g, B = (g.b1 - g.b0) / 1000, w = g.w / 1000, going = g.going / 1000, riser = g.riser / 1000, landing = g.landing / 1000, gap = g.gap / 1000;
      // the walls beside the flights and around the half landing
      const bm = (g.b0 + g.b1) / 2, outer = (fb) => (Math.abs(fb[0] - bm) > Math.abs(fb[1] - bm) ? fb[0] : fb[1]);
      const aL = g.a0 + g.run;
      const c1 = wallCover(M, g.at(g.a0, outer(g.f1)), g.at(aL, outer(g.f1)));
      const c2 = wallCover(M, g.at(aL - (g.n2 - 1) * g.going, outer(g.f2)), g.at(aL, outer(g.f2)));
      const cl = landing * (wallCover(M, g.at(aL, g.b0), g.at(g.a1, g.b0)) + wallCover(M, g.at(aL, g.b1), g.at(g.a1, g.b1))) + B * wallCover(M, g.at(g.a1, g.b0), g.at(g.a1, g.b1));
      if (fin) {
        face({ ...fin, ...st, room, kind: 'tread', what: `${t.flight} 1`, n: g.n1 - 1, L: going, H: w, link: { n: '{n1}-1', L: '{going}', H: '{w}' } });
        if (g.n2 > 1) face({ ...fin, ...st, room, kind: 'tread', what: `${t.flight} 2`, n: g.n2 - 1, L: going, H: w, link: { n: '{n2}-1', L: '{going}', H: '{w}' } });
        face({ ...fin, ...st, room, kind: 'landing', what: t.halfLanding, L: B, H: landing, link: { L: '{B}', H: '{landing}' } });
        face({ ...fin, ...st, room, kind: 'riser', what: `${t.flight} 1`, n: g.n1, L: w, H: riser, link: { n: '{n1}', L: '{w}', H: '{riser}' } });
        if (g.n2 > 0) face({ ...fin, ...st, room, kind: 'riser', what: `${t.flight} 2`, n: g.n2, L: w, H: riser, link: { n: '{n2}', L: '{w}', H: '{riser}' } });
      }
      if (sk) {
        if (c1 > 0) face({ ...sk, ...st, room, kind: 'stair_skirting', what: `${t.flight} 1`, L: c1 * ((g.n1 - 1) * going + g.n1 * riser), expr: stepped(g.n1, going, riser, c1), link: { L: '{c1}*(({n1}-1)*{going}+{n1}*{riser})' } });
        if (c2 > 0 && g.n2 > 0) face({ ...sk, ...st, room, kind: 'stair_skirting', what: `${t.flight} 2`, L: c2 * ((g.n2 - 1) * going + g.n2 * riser), expr: stepped(g.n2, going, riser, c2), link: { L: '{c2}*(({n2}-1)*{going}+{n2}*{riser})' } });
        if (cl > 0) face({ ...sk, ...st, room, kind: 'stair_skirting', what: t.aroundLanding, L: cl, link: { L: '{wall}' } });
      }
      if (shell) {
        const rail = { ...st, room, kind: 'handrail', code: 'RAIL', unit: 'm' }, sof = { ...st, room, kind: 'soffit', part: 'soffit', code: 'SLAB' };
        face({ ...rail, what: `${t.flight} 1 ${t.onSlope}`, L: slope(g.n1, going, riser), link: { L: slopeX('n1') } });
        if (g.n2 > 0) face({ ...rail, what: `${t.flight} 2 ${t.onSlope}`, L: slope(g.n2, going, riser), link: { L: slopeX('n2') } });
        if (gap > 0) face({ ...rail, what: t.gap, L: gap, link: { L: '{gap}' } });
        face({ ...sof, what: `${t.flightSoffit} 1`, L: slope(g.n1, going, riser), H: w, link: { L: slopeX('n1'), H: '{w}' } });
        if (g.n2 > 0) face({ ...sof, what: `${t.flightSoffit} 2`, L: slope(g.n2, going, riser), H: w, link: { L: slopeX('n2'), H: '{w}' } });
        face({ ...sof, what: t.landingSoffit, L: B, H: landing, link: { L: '{B}', H: '{landing}' } });
      }
      stairRows.push({ floor: fl, type: 'u', room, n1: g.n1, n2: g.n2, riser, going, w, landing, B, gap, c1, c2, wall: cl, height: S.height / 1000, fin: S.fin, area: 0, skirt: 0, guard: 0 });
      return;
    }
    if (S.type === 'spiral') {
      // a spiral stair: wedge treads (the ring it sweeps), risers from the post to the edge, the handrail on the outer
      // helix, the soffit on the helix at mid radius
      const G = S.G, R = G.R / 1000, r = G.r / 1000, H = S.height / 1000, riser = S.riser / 1000;
      const ring = (G.sweep / 2) * (R * R - r * r), rm = (R + r) / 2;
      if (fin) {
        face({ ...fin, ...st, room, kind: 'tread', what: `${t.spiral} ${G.k} x ${nf(G.sweepDeg / G.k, en)}°`, L: ring / (R - r), H: R - r });
        face({ ...fin, ...st, room, kind: 'riser', n: G.risers, L: R - r, H: riser });
      }
      if (shell) {
        face({ ...st, room, kind: 'handrail', code: 'RAIL', unit: 'm', what: t.onSlope, L: Math.hypot(G.sweep * R, H) });
        face({ ...st, room, kind: 'soffit', part: 'soffit', code: 'SLAB', what: t.flightSoffit, L: Math.hypot(G.sweep * rm, H), H: R - r });
      }
      return;
    }
    // a straight flight: its treads, risers (one more than the treads: the last one meets the floor above), the
    // skirting on the sides that lie along a wall, one handrail on the slope, the sloped soffit
    const going = S.going / 1000, w = S.w / 1000, riser = S.riser / 1000;
    const regular = S.risers === S.k + 1;
    const c = wallCover(M, S.at(0, 0), S.at(S.run, 0)) + wallCover(M, S.at(0, S.w), S.at(S.run, S.w));
    const sl = Math.hypot(S.k * going, S.risers * riser);
    const L1 = (k) => (regular ? k : undefined);
    if (fin) {
      face({ ...fin, ...st, room, kind: 'tread', n: S.k, L: going, H: w, link: L1({ n: '{n1}-1', L: '{going}', H: '{w}' }) });
      if (S.risers > 0) face({ ...fin, ...st, room, kind: 'riser', n: S.risers, L: w, H: riser, link: L1({ n: '{n1}', L: '{w}', H: '{riser}' }) });
    }
    if (sk && c > 0) {
      face({
        ...sk, ...st, room, kind: 'stair_skirting', L: c * (S.k * going + S.risers * riser), expr: `${c !== 1 ? `${nf(c, en)}${x}` : ''}(${S.k}${x}${nf(going, en)} + ${S.risers}${x}${nf(riser, en)})`,
        link: L1({ L: '{c1}*(({n1}-1)*{going}+{n1}*{riser})' }),
      });
    }
    if (shell) {
      face({ ...st, room, kind: 'handrail', code: 'RAIL', unit: 'm', what: t.onSlope, L: sl, link: L1({ L: slopeX('n1') }) });
      face({ ...st, room, kind: 'soffit', part: 'soffit', code: 'SLAB', what: t.flightSoffit, L: sl, H: w, link: L1({ L: slopeX('n1'), H: '{w}' }) });
    }
    if (!S.landing) stairRows.push({ floor: fl, type: 'straight', room, n1: S.risers, n2: 0, treads: S.k, riser, going, w, landing: 0, B: 0, gap: 0, c1: c, c2: 0, wall: 0, height: S.height / 1000, fin: null, area: 0, skirt: 0, guard: 0 });
  });

  // ---- balconies: the floor finish (a material of the schedule as well)
  const balconies = (spec?.balconies || []).filter((bc) => Array.isArray(bc.region));
  const balconyFinish = (bc) => resolveFinish(t.balcony, bc.finish ?? {}, [], Htop);
  // the doors that open onto a balcony: the outer half of the wall under each of them is floor of the balcony
  const doorsOnto = (bc) => {
    const [[x0, y0], [x1, y1]] = bc.region;
    const bx = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    return (M?.openings ?? []).filter((op) => op.type !== 'window').map((op) => {
      const sg = op.s, n = left(sg.d), c = (sg.o1 + sg.o2) / 2, u = (op.span.from + op.span.to) / 2;
      const at = (v, o) => add(add(sg.a, mul(sg.d, v)), mul(n, o));
      const o = [sg.o1, sg.o2].find((q) => {
        const pt = at(u, q + (Math.sign(q - c) || 1) * 40);
        return pt[0] > bx[0] && pt[0] < bx[2] && pt[1] > bx[1] && pt[1] < bx[3];
      });
      if (o === undefined) return null;
      const w = (op.span.to - op.span.from) / 1000;
      return { what: `${t.under} ${opName(op)}`, kind: 'threshold', area: w * (sg.t / 2000), L: w, H: sg.t / 2000, opening: opId(op), poly: [at(op.span.from, o), at(op.span.to, o), at(op.span.to, c), at(op.span.from, c)] };
    }).filter(Boolean);
  };
  balconies.forEach((bc, bi) => {
    const [[x0, y0], [x1, y1]] = bc.region;
    const bf = balconyFinish(bc);
    if (bf.floor) {
      face({
        room: t.balcony, finishKind: 'balcony', balcony: bi, kind: 'floor', part: 'floor', code: bf.floor.code, desc: bf.floor.description, pattern: bf.floor.pattern, L: Math.abs(x1 - x0) / 1000, H: Math.abs(y1 - y0) / 1000,
        additions: doorsOnto(bc),
      });
    }
  });

  if (shell) {
    // ---- rooms without a ceiling: their concrete soffit painted (not the open roof terrace; in a stair room where
    // flights start, the flat part outside the wells: the flights and the half landing have their sloped soffits);
    // waterproofing by kind of room, turned up the walls
    for (const m of measures) {
      const poly = rooms[m.room], f = m.finish;
      if (!f.ceiling && !(m.outdoor && top)) {
        const up = m.wells.filter((x) => x.up && stairs.some((S) => inside(S.mid, poly)));
        const off = up.map((x) => x.area ?? Math.abs(polyArea(clipToBox(poly, x.well))) / 1e6);
        if (m.area - sum(off, (a) => a) > 1e-6) {
          const sf = face({
            room: m.room, finishKind: m.kind, kind: 'soffit', part: 'soffit', code: 'SLAB', what: t.soffit, gross: m.area, outline: poly,
            deductions: [...up.map((x, i) => ({ what: x.flight ? t.foot : t.well, area: Math.min(off[i], m.area), always: true, poly: boxPoly(x.well) })).filter((d) => d.area > 1e-9),
              ...m.cols.filter((x) => !up.some((w) => x.mid[0] > w.well[0] && x.mid[0] < w.well[2] && x.mid[1] > w.well[1] && x.mid[1] < w.well[3]))
                .map((x) => ({ what: `${t.column} ${x.label}`, area: x.area, column: x.c.name, poly: boxPoly(x.c.box) }))],
          });
          // the beams of the slab over the room that cross it clear of the walls: their two sides below the slab are
          // painted with the soffit (their underside is in the plan of the room already). Not where a wall stands
          // under the beam, not in a well that is open above
          for (const bm of ST?.beams ?? []) {
            const depth = bm.h - (ST.slab ?? 0);
            if (!(depth > 0)) continue;
            let run = 0;
            for (const [q, r] of clipSeg(bm.A, bm.B, poly)) {
              const L = len(sub(r, q));
              if (L < 1) continue;
              const d = sub(r, q), at = (pt) => dot(sub(pt, q), d) / (L * L);
              // the stretches of the piece with something under or beside it: a wall or a column, a well open above
              const taken = [
                ...(M ? M.walls.flatMap((w) => w.segs.flatMap((sg) => clipSeg(q, r, segRect(sg)).map(([a, b]) => [at(a), at(b)]))) : []),
                ...(ST.columns ?? []).map((c) => boxInterval(q, r, c.box)).filter(Boolean),
                ...up.map((w) => boxInterval(q, r, [w.well[0] + 1, w.well[1] + 1, w.well[2] - 1, w.well[3] - 1])).filter(Boolean),
              ].sort((a, b) => a[0] - b[0]);
              let free = 1, end = 0;
              for (const [a, b] of taken) {
                if (b <= end) continue;
                free -= b - Math.max(a, end);
                end = b;
              }
              run += (L * Math.max(0, free)) / 1000;
            }
            run = r6(run);
            // where another beam meets this one in the room (clear of walls and columns) its section covers the side:
            // one side at a T, both at a crossing, by the shallower of the two depths
            let covered2 = 0;
            const dir = sub(bm.B, bm.A), Lb = len(dir);
            for (const o of Lb > 1 ? ST.beams : []) {
              if (o === bm) continue;
              const od = sub(o.B, o.A), Lo = len(od), den = cross(dir, od);
              if (Lo < 1 || Math.abs(den) < 1e-6 * Lb * Lo) continue;
              const s1 = cross(sub(o.A, bm.A), od) / den, s2 = cross(sub(o.A, bm.A), dir) / den;
              const tolB = (o.b ?? 220) / 2 / Lb, tolO = (bm.b ?? 220) / 2 / Lo;
              if (s1 < -tolB || s1 > 1 + tolB || s2 < -tolO || s2 > 1 + tolO) continue;
              const X = add(bm.A, mul(dir, Math.max(0, Math.min(1, s1))));
              if (!inside(X, poly)) continue;
              if (M && M.walls.some((w) => w.segs.some((sg) => inside(X, segRect(sg))))) continue;
              if ((ST.columns ?? []).some((c) => X[0] > c.box[0] - 1 && X[0] < c.box[2] + 1 && X[1] > c.box[1] - 1 && X[1] < c.box[3] + 1)) continue;
              if (up.some((w) => X[0] > w.well[0] && X[0] < w.well[2] && X[1] > w.well[1] && X[1] < w.well[3])) continue;
              // the other beam runs on past this one (a crossing: both sides) or ends on it (a T: one side)
              const through = s2 > tolO && s2 < 1 - tolO;
              const od2 = Math.min(depth, o.h - (ST.slab ?? 0));
              // at an end of this beam its two sides stop at the face of the other: half its width off each
              const atEnd = s1 < tolB || s1 > 1 - tolB;
              if (od2 > 0) covered2 += (atEnd ? 1 : through ? 2 : 1) * ((o.b ?? 220) / 1000) * (od2 / 1000);
            }
            const sideArea = Math.max(0, 2 * run * (depth / 1000) - covered2);
            if (run > 1e-6) sf.additions.push({ what: `${t.beamSide} ${bm.name}`, kind: 'beam_side', area: r6(sideArea), n: 2, L: run, H: depth / 1000, beam: bm.name, ...(covered2 > 0 ? { less: r6(covered2) } : {}) });
          }
        }
      }
      const wp = m.wet ? 'WET' : m.outdoor ? (top ? 'TERR' : 'BALC') : null;
      if (wp) {
        // the membrane turns up the walls, not across a door: there it runs on under the door, to the middle of the wall
        const upL = Math.max(0, m.per - m.doorW);
        face({
          room: m.room, finishKind: m.kind, kind: 'waterproof', code: wp, gross: m.area, outline: poly,
          additions: [{
            what: m.doorW > 0 ? `${t.upturn} ${UPTURN} (${t.perim} ${nf(m.per, en)} - ${t.doors} ${nf(m.doorW, en)})` : `${t.upturn} ${UPTURN}`, kind: 'upturn', area: (UPTURN / 1000) * upL, L: upL, H: UPTURN / 1000,
            ...(m.doorW > 0 ? { per: m.per, doors: m.doorW } : {}),
          }, ...m.sills.map((a) => ({ ...a }))],
        });
        if (wp === 'TERR') face({ room: m.room, finishKind: m.kind, kind: 'screed', code: 'SCREED', gross: m.area, outline: poly });
      }
    }
    // ---- the guard at the head of a stair that arrives on a floor where no stair starts
    if (!stairs.some((S) => S.type === 'u')) {
      for (const st of (spec?.stairs_below || []).filter((x) => x.type === 'u')) {
        try {
          const g = uStairGeom(st, st.height ?? Htop);
          const mid = [(st.region[0][0] + st.region[1][0]) / 2, (st.region[0][1] + st.region[1][1]) / 2];
          const room = Object.entries(rooms).find(([name, poly]) => finishes[name]?.kind === 'stair' && inside(mid, poly))?.[0] ?? t.stair;
          face({ room, kind: 'handrail', code: 'RAIL', unit: 'm', what: t.guard, L: (g.run + g.gap) / 1000, guard: true });
        } catch (e) {
          warnings.push(`stairs_below: not measured (${e.message})`);
        }
      }
    }
    // ---- balconies: waterproofing with its upturn, the soffit painted, the railing on the sides away from the building
    const pts = M ? M.walls.flatMap((w) => w.segs.flatMap((s) => [s.a, s.b])) : [];
    const box = pts.length ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))] : null;
    balconies.forEach((bc, bi) => {
      if (!box) return;
      const [[x0, y0], [x1, y1]] = bc.region;
      const X = Math.abs(x1 - x0) / 1000, Y = Math.abs(y1 - y0) / 1000;
      const edges = [[Math.abs(x1 - x0), Math.max(y0, y1)], [Math.abs(x1 - x0), Math.min(y0, y1)]].map(([L, y]) => (Math.abs(y - box[1]) < 300 || Math.abs(y - box[3]) < 300 ? 0 : L));
      const sides = [Math.abs(y1 - y0), Math.abs(y1 - y0)].map((L, i) => {
        const x = i === 0 ? Math.min(x0, x1) : Math.max(x0, x1);
        return Math.abs(x - box[0]) < 300 || Math.abs(x - box[2]) < 300 ? (x0 >= box[0] - 300 && x1 <= box[2] + 300 ? L : 0) : L;
      });
      const b = { room: t.balcony, finishKind: 'balcony', balcony: bi };
      const onto = doorsOnto(bc), dw = sum(onto, (a) => a.L), around = 2 * (X + Y), upL = Math.max(0, around - dw);
      face({
        ...b, kind: 'waterproof', code: 'BALC', L: X, H: Y,
        additions: [{
          what: dw > 0 ? `${t.upturn} ${UPTURN} (${t.perim} ${nf(around, en)} - ${t.doors} ${nf(dw, en)})` : `${t.upturn} ${UPTURN}`, kind: 'upturn', area: (UPTURN / 1000) * upL, L: upL, H: UPTURN / 1000,
          ...(dw > 0 ? { per: around, doors: dw } : {}),
        }, ...onto],
      });
      face({ ...b, kind: 'soffit', part: 'soffit', code: 'SLAB', what: t.soffit, L: X, H: Y });
      const rail = (edges[0] + edges[1] + sides[0] + sides[1]) / 1000;
      if (rail > 0) face({ ...b, kind: 'railing', code: 'BALRAIL', unit: 'm', L: rail });
    });
    // ---- the outer faces of the walls (no room on that side): the facade height, the plinth on the ground floor,
    // parapets. Each face is followed along its length: where a partition meets the wall the point falls in that
    // partition (neither a room nor outside) and is left out, so a junction does not turn an inner face into an outer
    // one; a parapet on the line of a full wall (the stair tower) is counted once, with that wall. The openings in an
    // outer face are deducted and the outside half of their reveals is counted with it.
    if (M) {
      const all = M.walls.flatMap((w) => w.segs.map((s) => ({ s, full: w.height === undefined })));
      const inWall = (p, skip, fullOnly = false) => all.some(({ s, full }) => {
        if (s === skip || (fullOnly && !full)) return false;
        const u = (p[0] - s.a[0]) * s.d[0] + (p[1] - s.a[1]) * s.d[1], off = -(p[0] - s.a[0]) * s.d[1] + (p[1] - s.a[1]) * s.d[0];
        return u > -s.t / 2 && u < s.L + s.t / 2 && off > Math.min(s.o1, s.o2) - 1 && off < Math.max(s.o1, s.o2) + 1;
      });
      const polys = Object.values(rooms);
      for (const w of M.walls) {
        const parapet = w.height !== undefined;
        const wid = spec.walls?.[w.index]?.id ?? `W${w.index + 1}`;
        for (const s of w.segs) {
          const n = [-s.d[1], s.d[0]], c = (s.o1 + s.o2) / 2;
          const H = parapet ? w.height : Htop + ground;
          const sops = M.openings.filter((o) => o.s === s);
          const at = (u, off) => [s.a[0] + s.d[0] * u + n[0] * off, s.a[1] + s.d[1] * u + n[1] * off];
          // out: outside the building; in: a room; skip: a junction, or a parapet stretch a full wall stands on
          const state = (u, o) => {
            const side = Math.sign(o - c) || 1;
            if (parapet && inWall(at(u, o - side * 40), s, true)) return 'skip';
            const p = at(u, o + side * 40);
            if (polys.some((poly) => inside(p, poly))) return 'in';
            return inWall(p, s) ? 'skip' : 'out';
          };
          // the length of the axis where a test holds: sampled every 250 at most, the ends of each stretch found by
          // bisection between two samples (to the millimetre)
          const stretch = (test) => {
            const N = Math.max(4, Math.ceil(s.L / 250));
            const us = Array.from({ length: N }, (_, i) => ((i + 0.5) * s.L) / N), v = us.map(test);
            let total = 0, start = v[0] ? 0 : null;
            for (let i = 0; i + 1 < N; i++) {
              if (v[i] === v[i + 1]) continue;
              let a = us[i], b = us[i + 1];
              for (let k = 0; k < 12; k++) {
                const m = (a + b) / 2;
                if (test(m) === v[i]) a = m;
                else b = m;
              }
              const edge = Math.round((a + b) / 2);
              if (v[i]) total += edge - start;
              start = v[i] ? null : edge;
            }
            return start === null ? total : total + s.L - start;
          };
          const name = `${wid}.${s.index + 1}`;
          for (const o of [s.o1, s.o2]) {
            // the face runs half a wall thickness past each end of the axis where it turns an outer corner (a facade
            // is as long as the building, not as its wall axes); at a junction or an inner corner that end is in a wall
            const ends = [-s.t / 4, s.L + s.t / 4].filter((u) => state(u, o) === 'out').length * (s.t / 2);
            const Lout = stretch((u) => state(u, o) === 'out') + ends;
            if (!(Lout > 0)) continue;
            const f = face({ room: name, kind: 'exterior', code: 'OUT', L: Lout / 1000, H: H / 1000, from: at(0, o), to: at(s.L, o) });
            for (const op of sops) {
              if (state((op.span.from + op.span.to) / 2, o) !== 'out') continue;
              const ow = (op.span.to - op.span.from) / 1000, hh = Math.max(0, Math.min(op.head, H) - op.sill) / 1000;
              if (!(hh > 0)) continue;
              f.deductions.push({ what: opName(op), area: ow * hh, w: ow, h: hh, opening: opId(op), full: op.head <= H + 1e-6 });
              const rv = reveal(op, ow, hh, H);
              if (rv) f.additions.push(rv);
            }
          }
          if (parapet) {
            const Ltop = stretch((u) => !inWall(at(u, c), s, true));
            if (Ltop > 0) face({ room: `${name} ${t.top}`, kind: 'parapet_top', code: 'OUT', L: Ltop / 1000, H: s.t / 1000 });
          }
        }
      }
      // ---- roofs: a flat roof over the full-height walls of the floor (the stair tower) to its edge; a pitched roof
      // by its true area on the slope, overhang included
      const full = M.walls.some((w) => w.height === undefined);
      M.roofs.forEach((Rf, i) => {
        const [[x0, y0], [x1, y1]] = Rf.region, ov = Rf.overhang;
        if (Rf.type === 'flat') {
          if (!(Array.isArray(spec.roofs?.[i]?.region) || (top && full))) return;
          face({ room: t.roof, kind: 'roof', code: 'ROOF', L: (x1 - x0 + 2 * ov) / 1000, H: (y1 - y0 + 2 * ov) / 1000 });
        } else if (Rf.type === 'hip') {
          // four slopes of one pitch: the plan of the roof (overhang included) over the cosine of the pitch; the ridge
          // and the four hips for their capping
          const X = x1 - x0 + 2 * ov, Y = y1 - y0 + 2 * ov, m = Math.min(X, Y) / 2;
          const hipL = Math.hypot(m * Math.SQRT2, m * Math.tan(Rf.pitch * DEG)), ridgeL = Math.abs(X - Y);
          face({ room: t.roof, kind: 'roof_pitched', code: 'PITCH', what: `${t.hipRoof} ${nf(Rf.pitch, en)}°`, L: X / 1000, H: Y / Math.cos(Rf.pitch * DEG) / 1000, pitch: Rf.pitch, hips_m: r6((4 * hipL) / 1000), ridge_m: r6(ridgeL / 1000) });
          if (!spec.roofs) assumed.push(...M.assumed.filter((a) => String(a.item).startsWith('roofs')));
        } else {
          const along = Rf.ridge === 'x' ? x1 - x0 : y1 - y0, span = Rf.ridge === 'x' ? y1 - y0 : x1 - x0;
          face({ room: t.roof, kind: 'roof_pitched', code: 'PITCH', what: `${t.slope} ${nf(Rf.pitch, en)}°`, n: 2, L: (along + 2 * ov) / 1000, H: (span / 2 + ov) / Math.cos(Rf.pitch * DEG) / 1000, pitch: Rf.pitch });
          // a roof the plan does not give: the one the elevations assume (the bill says so)
          if (!spec.roofs) assumed.push(...M.assumed.filter((a) => String(a.item).startsWith('roofs')));
        }
      });
    }
  }

  // ---- room by room (then the other locations as they come), each with its faces in one order; ids, ledgers
  const place = new Map(Object.keys(rooms).map((name, i) => [name, i]));
  for (const f of faces) if (!place.has(f.room)) place.set(f.room, 1e6 + place.size);
  const rank = (f) => KIND_ORDER.indexOf(f.kind);
  const order = new Map(faces.map((f, i) => [f, i]));
  faces.sort((a, b) => place.get(a.room) - place.get(b.room) || rank(a) - rank(b) || order.get(a) - order.get(b));
  const seen = new Map();
  for (const f of faces) {
    const base = `${fl ? `${fl}/` : ''}${f.room}/${f.kind}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    f.id = `${base}#${k}`;
    closeFace(f, R, en);
  }
  // the measures of the rooms, as the schedule and the bill report them
  for (const m of measures) {
    const mine = faces.filter((f) => f.room === m.room);
    if (m.wall) m.wall.net = sum(mine.filter((f) => f.kind === 'wall'), (f) => f.measured);
    const host = stairs.map((S, i) => (hostOf(S) === m.room ? i : -1)).filter((i) => i >= 0);
    const ofStair = (f) => f.stair !== undefined && host.includes(f.stair);
    m.floorArea = sum(mine.filter((f) => f.part === 'floor' && !f.none && (f.stair === undefined || ofStair(f))), (f) => f.measured);
    m.skirt = sum(mine.filter((f) => f.part === 'skirting' && (f.stair === undefined || ofStair(f))), (f) => f.measured);
  }
  return { faces, measures, stairs: stairRows, M, spec, warnings, assumed, structure: ST, soffit, covered };
}

/**
 * The reveals of the openings as records of their own (kind: reveal; L: the perimeter of the opening on that side,
 * the sill of a door left out; H: the depth; of: the id of the wall or exterior face they open in). A view for whoever
 * needs them one by one: they are already counted in the additions of that face, not to be added to a bill again.
 */
export function revealFaces(faces, rules = null) {
  const counted = ruleSet(rules).reveals !== false;
  return faces.flatMap((f) => f.additions.filter((a) => a.kind === 'reveal').map((a, i) => ({
    id: `${f.id}/reveal#${i + 1}`, floor: f.floor, room: f.room, kind: 'reveal', of: f.id, opening: a.opening, part: f.part, code: f.code, desc: f.desc, unit: 'm²', n: 1, L: a.perimeter,
    H: a.depth, gross: a.area, deductions: [], additions: [], net: a.area, measured: counted && !f.none ? a.area : 0, how: a.what,
  })));
}

// ---------------------------------------------------------------- cross-checks

/**
 * The floor plate of a plan, counted independently of the room outlines: the footprint of the walls (their segments,
 * run on into the corners they turn) and of the columns, the rooms, and what lies enclosed between them with no room
 * (void), on the grid of all their coordinates (exact for walls and rooms along the axes; a 50 mm grid otherwise).
 * Areas in mm²: {rooms (the sum of the outline areas), walls, columns (outside the walls), void, overlap (a room over a
 * wall, a column or another room), plate (everything inside the outer faces), exact}.
 */
export function floorPlate(M, rooms) {
  const { walls: wallPolys, columns: colPolys, rooms: roomPolys } = plateOutlines(M, rooms);
  return plateOf(wallPolys, colPolys, roomPolys);
}

/**
 * The outlines that the floor plate counts, in mm: {walls (the footprint of every wall segment, run on into the corners
 * it turns), columns (the columns of the plan), rooms (the room outlines)}: their union is the plate inside the outer
 * faces, its outer edge the length of the outer faces.
 */
export function plateOutlines(M, rooms) {
  const key = (p) => `${Math.round(p[0])},${Math.round(p[1])}`;
  const segs = M.walls.flatMap((w) => w.segs);
  const nodes = new Map();
  for (const s of segs) {
    for (const [p, out] of [[s.a, mul(s.d, -1)], [s.b, s.d]]) {
      if (!nodes.has(key(p))) nodes.set(key(p), []);
      nodes.get(key(p)).push({ s, out });
    }
  }
  // a segment runs on past its end by the footprint of the walls it meets there (the corner of two walls)
  const ext = (s, p, out) => {
    let e = 0;
    for (const o of nodes.get(key(p))) {
      if (o.s === s) continue;
      const c = dot(left(o.s.d), out);
      e = Math.max(e, o.s.o1 * c, o.s.o2 * c);
    }
    return e;
  };
  return { walls: segs.map((s) => segRect(s, -ext(s, s.a, mul(s.d, -1)), s.L + ext(s, s.b, s.d))), columns: (M.columns || []).map((c) => c.poly), rooms: Object.values(rooms || {}) };
}

function plateOf(wallPolys, colPolys, roomPolys) {
  const all = [...wallPolys, ...colPolys, ...roomPolys];
  const exact = all.every((poly) => poly.every((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.abs(p[0] - q[0]) < 1e-6 || Math.abs(p[1] - q[1]) < 1e-6;
  }));
  const uniq = (v) => [...v].sort((a, b) => a - b).filter((x, i, arr) => i === 0 || x - arr[i - 1] > 1e-6);
  let xs = uniq(all.flatMap((poly) => poly.map((p) => p[0]))), ys = uniq(all.flatMap((poly) => poly.map((p) => p[1])));
  if (!exact) {
    const step = Math.max(50, Math.max(xs[xs.length - 1] - xs[0], ys[ys.length - 1] - ys[0]) / 400);
    const fill = (v) => uniq([...v, ...Array.from({ length: Math.floor((v[v.length - 1] - v[0]) / step) }, (_, i) => v[0] + (i + 1) * step)]);
    xs = fill(xs);
    ys = fill(ys);
  }
  xs = [xs[0] - 1000, ...xs, xs[xs.length - 1] + 1000];
  ys = [ys[0] - 1000, ...ys, ys[ys.length - 1] + 1000];
  const boxed = (polys) => polys.map((poly) => ({ poly, x0: Math.min(...poly.map((p) => p[0])), x1: Math.max(...poly.map((p) => p[0])), y0: Math.min(...poly.map((p) => p[1])), y1: Math.max(...poly.map((p) => p[1])) }));
  const W = boxed(wallPolys), C = boxed(colPolys), Rm = boxed(roomPolys);
  const hits = (list, c) => list.filter((b) => c[0] > b.x0 && c[0] < b.x1 && c[1] > b.y0 && c[1] < b.y1 && inside(c, b.poly)).length;
  const nx = xs.length - 1, ny = ys.length - 1;
  const empty = new Uint8Array(nx * ny);
  const out = { rooms: sum(roomPolys, (p) => Math.abs(polyArea(p))), walls: 0, columns: 0, void: 0, overlap: 0, plate: 0, exact };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const c = [(xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2], a = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      const w = hits(W, c) > 0, col = !w && hits(C, c) > 0, r = hits(Rm, c);
      if (w) out.walls += a;
      if (col) out.columns += a;
      if (r > 0) out.overlap += a * (r - 1 + (w || col ? 1 : 0));
      if (w || col || r > 0) out.plate += a;
      else empty[i * ny + j] = 1;
    }
  }
  // what is empty and reached from the border is outside; the rest is enclosed with no room
  const stack = [0];
  empty[0] = 2;
  while (stack.length) {
    const k = stack.pop(), i = Math.floor(k / ny), j = k % ny;
    for (const [a, b] of [[i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1]]) {
      if (a < 0 || b < 0 || a >= nx || b >= ny || empty[a * ny + b] !== 1) continue;
      empty[a * ny + b] = 2;
      stack.push(a * ny + b);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (empty[i * ny + j] !== 1) continue;
      const a = (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      out.void += a;
      out.plate += a;
    }
  }
  return out;
}

const CHECKS = {
  vi: {
    plate: 'Diện tích các phòng + chân tường, cột = mặt sàn trong mép ngoài tường (m²)',
    perimeter: 'Tổng chiều dài các mặt tường của phòng = chu vi phòng (m)',
    skirting: 'Len chân tường = chu vi - bề rộng cửa đi, ô trống - đoạn dọc ô thang + phần quấn quanh cột lộ (m)',
    openings: 'Mỗi lỗ cửa được trừ trên đúng hai mặt (hai phòng, hoặc phòng và mặt ngoài) với cùng diện tích (m²)',
    reveals: 'Má cửa = chu vi lỗ cửa (cửa đi không tính ngưỡng) x chiều sâu má (m²)',
    ledger: 'Mỗi bề mặt: gộp - trừ + cộng = ròng, gộp = số bộ phận x dài x cao (số mặt đạt / tổng số mặt)',
    codes: 'Mỗi mặt sàn, tường, trần của phòng có một mã hoàn thiện hoặc ghi rõ không hoàn thiện (số mặt đạt / tổng số mặt)',
    stair_rise: 'Cầu thang: số bậc x chiều cao bậc = chiều cao tầng (m)',
    stair_treads: 'Cầu thang: số mặt bậc mỗi vế = số bậc - 1',
    stair_tread: 'Cầu thang: mặt bậc + chiếu nghỉ cộng từ các mặt = công thức của thang (m²)',
    stair_riser: 'Cầu thang: cổ bậc cộng từ các mặt = số bậc x cao bậc x rộng vế (m²)',
    stair_skirting: 'Cầu thang: len theo bậc = phần có tường của hai vế và quanh chiếu nghỉ, không vượt công thức đủ ba phía (m)',
    stair_rail: 'Cầu thang: tay vịn theo dốc hai vế + khe thang = công thức của thang (m)',
    bill: 'Bảng khối lượng kiến trúc = bảng vật liệu nội thất cho cùng một mã',
    thresholds: 'Phần sàn dưới cửa cộng theo cạnh phòng = bề rộng cửa x nửa chiều dày tường, đếm từng cửa, từng phía có phòng (m²)',
    upturn: 'Chống thấm quét lên tường: chiều dài + bề rộng cửa = chu vi phòng (m)',
  },
  en: {
    plate: 'Room areas + wall and column footprints = the floor plate inside the outer faces (m²)',
    perimeter: 'The wall faces of a room add up to its perimeter (m)',
    skirting: 'Skirting = perimeter - doors and plain openings - what lies along a stairwell + round the columns that stand out (m)',
    openings: 'Every opening is deducted on exactly two faces (two rooms, or a room and the outside) by the same area (m²)',
    reveals: 'Reveals = perimeter of the opening (no sill for a door) x depth (m²)',
    ledger: 'Every face: gross - deductions + additions = net, gross = like parts x length x height (faces that pass / faces)',
    codes: 'Every floor, wall and ceiling face of a room has one finish code or is marked as not finished (faces that pass / faces)',
    stair_rise: 'Stair: risers x riser = storey height (m)',
    stair_treads: 'Stair: treads of a flight = its risers - 1',
    stair_tread: 'Stair: treads + half landing summed from the faces = the formula of the stair (m²)',
    stair_riser: 'Stair: risers summed from the faces = risers x riser x flight width (m²)',
    stair_skirting: 'Stair: stepped skirting = the walled part of both flights and around the landing, at most the formula with walls on three sides (m)',
    stair_rail: 'Stair: handrail on the slope of both flights + the well = the formula of the stair (m)',
    bill: 'The architectural bill = the interior schedule for the same code',
    thresholds: 'Floor under the doors summed along the room edges = door width x half the wall, counted door by door and side by side (m²)',
    upturn: 'Waterproofing up the walls: its length + the door widths = the perimeter of the room (m)',
  },
};

/** The name of a check by its id (for checks made elsewhere, such as the bill against the schedule). */
export const checkName = (id, lang = 'vi') => (CHECKS[lang === 'en' ? 'en' : 'vi'][id] ?? id);

/**
 * Cross-checks of the surface model, floor by floor: floors [{name, rooms, S: the result of floorSurfaces}]. Each
 * check {id, name, ok, lhs, rhs, tol, where, note?} compares two independent counts of the same thing.
 */
export function surfaceChecks(floors, { lang = 'vi' } = {}) {
  const en = lang === 'en', N = CHECKS[en ? 'en' : 'vi'];
  const out = [];
  const push = (id, where, lhs, rhs, tol, extra = {}) => out.push({ id, name: N[id], ok: Math.abs(lhs - rhs) <= tol, lhs: r6(lhs), rhs: r6(rhs), tol, where, ...extra });
  for (const { name, rooms = {}, S } of floors) {
    const M = S.M, at = (x) => (name ? `${name} ${x}` : x);
    // 1. the floor plate
    if (M && Object.keys(rooms).length) {
      const p = floorPlate(M, rooms), m2 = (v) => v / 1e6;
      push('plate', name, m2(p.rooms + p.walls + p.columns), m2(p.plate), p.exact ? 0.001 : 0.01 * m2(p.plate), {
        note: en ? `rooms ${nf(m2(p.rooms), true)}, walls ${nf(m2(p.walls), true)}, columns ${nf(m2(p.columns), true)}; enclosed with no room ${nf(m2(p.void), true)}, overlapping ${nf(m2(p.overlap), true)}`
          : `phòng ${nf(m2(p.rooms))}, tường ${nf(m2(p.walls))}, cột ${nf(m2(p.columns))}; kín không có phòng ${nf(m2(p.void))}, chồng lên nhau ${nf(m2(p.overlap))}`,
      });
    }
    // 2, 3. per room: the wall faces close the perimeter, the skirting is the perimeter less doors and stairwells
    for (const m of S.measures) {
      const mine = S.faces.filter((f) => f.room === m.room);
      push('perimeter', at(m.room), sum(mine.filter((f) => f.kind === 'wall'), (f) => f.L), perimeter(rooms[m.room]) / 1000, 0.001);
      if (m.finish.skirting) push('skirting', at(m.room), sum(mine.filter((f) => f.kind === 'skirting'), (f) => f.measured), Math.max(0, m.per - m.doorW - m.wellRun) + (m.colSkirt ?? 0), 0.001);
    }
    // 4. every opening on two faces, by the same area (by the same width where a finish stops under its head)
    const sided = S.faces.filter((f) => f.kind === 'wall' || f.kind === 'exterior');
    (M?.openings ?? []).forEach((op, i) => {
      const id = `O${i + 1}`;
      const hit = sided.flatMap((f) => f.deductions.filter((d) => d.opening === id).map((d) => ({ f, d })));
      const where = at(`${op.tag ?? op.type} (${id})`), ids = hit.map((h) => h.f.id);
      if (hit.length !== 2) out.push({ id: 'openings', name: N.openings, ok: false, lhs: hit.length, rhs: 2, tol: 0, where, faces: ids, note: en ? 'number of faces' : 'số mặt trừ lỗ cửa' });
      else if (hit[0].d.full && hit[1].d.full) push('openings', where, hit[0].d.area, hit[1].d.area, 0.001, { faces: ids });
      else push('openings', where, hit[0].d.w, hit[1].d.w, 0.002, { faces: ids, note: en ? 'widths (a finish stops under the head)' : 'so bề rộng (lớp hoàn thiện dừng dưới đỉnh cửa)' });
    });
    // 5. reveals: perimeter x depth, from the opening and its wall
    if (M) {
      let lhs = 0, rhs = 0, n = 0;
      for (const f of sided) {
        for (const a of f.additions.filter((x) => x.kind === 'reveal')) {
          const op = M.openings[Number(a.opening.slice(1)) - 1], d = f.deductions.find((x) => x.opening === a.opening);
          const depth = Math.max(0, op.type === 'opening' ? op.s.t / 2 : (op.s.t - FRAME) / 2) / 1000;
          const per = 2 * d.h + (op.head < f.H * 1000 - 1e-6 ? d.w : 0) + (op.type === 'window' && op.sill > 0 ? d.w : 0);
          lhs += a.area;
          rhs += per * depth;
          n++;
        }
      }
      if (n) push('reveals', name, lhs, rhs, 0.001, { note: en ? `${n} reveals` : `${n} má cửa` });
    }
    // 5b. the floor under the doors: from the rooms (edge by edge), and from the openings (each side that has a room
    // with a floor finish); the waterproofing up the walls against the perimeter of its room
    if (M) {
      const floored = new Set(S.measures.filter((m) => m.finish.floor).map((m) => m.room));
      const lhs = sum(S.faces.filter((f) => (f.kind === 'floor' || f.kind === 'landing') && f.balcony === undefined && f.stair === undefined && !f.none), (f) => sum(f.additions.filter((a) => a.kind === 'threshold'), (a) => a.area));
      let rhs = 0, n = 0;
      for (const op of M.openings) {
        if (op.type === 'window') continue;
        const sg = op.s, nn = left(sg.d), c = (sg.o1 + sg.o2) / 2, u = (op.span.from + op.span.to) / 2;
        for (const o of [sg.o1, sg.o2]) {
          const pt = add(add(sg.a, mul(sg.d, u)), mul(nn, o + (Math.sign(o - c) || 1) * 40));
          const room = Object.entries(rooms).find(([, poly]) => inside(pt, poly))?.[0];
          if (room === undefined || !floored.has(room)) continue;
          rhs += ((op.span.to - op.span.from) / 1000) * (sg.t / 2000);
          n++;
        }
      }
      if (n || lhs > 0) push('thresholds', name, lhs, rhs, 0.001, { note: en ? `${n} door sides` : `${n} phía cửa` });
    }
    for (const m of S.measures) {
      const wp = S.faces.find((f) => f.kind === 'waterproof' && f.room === m.room && f.balcony === undefined);
      const upt = wp?.additions.find((a) => a.kind === 'upturn');
      if (upt) push('upturn', at(m.room), upt.L + sum(wp.additions.filter((a) => a.kind === 'threshold'), (a) => a.L), m.per, 0.001);
    }
    // 6. the ledger of every face; 7. a finish code or an explicit none on every face of a room
    const ledger = S.faces.filter((f) => {
      const key = f.unit === 'm' ? 'len' : 'area';
      const net = f.gross - sum(f.deductions, (d) => d[key]) + sum(f.additions, (a) => a[key] ?? 0);
      const dims = f.L === undefined ? f.gross : f.n * f.L * (f.unit === 'm' ? 1 : f.H ?? 0);
      return Math.abs(net - f.net) <= 1e-9 && net >= -1e-9 && Math.abs(dims - f.gross) <= 1e-9;
    });
    push('ledger', name, ledger.length, S.faces.length, 0);
    const roomFaces = S.faces.filter((f) => ['floor', 'landing', 'wall', 'column', 'ceiling', 'ceiling_drop', 'skirting', 'tread', 'riser', 'stair_skirting', 'splashback'].includes(f.kind));
    const coded = roomFaces.filter((f) => (typeof f.code === 'string' && f.code.length > 0) !== (f.none === true));
    const complete = S.measures.every((m) => S.faces.filter((f) => f.room === m.room && f.kind === 'wall').length === m.edges);
    push('codes', name, coded.length + (complete ? 0 : -1), roomFaces.length, 0);
    // 8. stairs: the rise, the treads of each flight, the faces against the formulas of the stair
    S.stairs.forEach((st, i) => {
      if (!(st.n1 > 0)) return;
      const where = at(`${st.room} ${i + 1}`), mine = S.faces.filter((f) => f.stair === i);
      const of = (kind) => mine.filter((f) => kind.includes(f.kind));
      push('stair_rise', where, (st.n1 + st.n2) * st.riser, st.height, 0.001);
      if (of(['tread']).length) push('stair_treads', where, sum(of(['tread']), (f) => f.n), st.n1 - 1 + Math.max(0, st.n2 - 1), 0);
      if (st.type !== 'u') return;
      if (of(['tread']).length) {
        push('stair_tread', where, sum(of(['tread', 'landing']), (f) => f.measured), st.fin.tread, 0.001);
        push('stair_riser', where, sum(of(['riser']), (f) => f.measured), st.fin.riser, 0.001);
      }
      const walled = st.c1 * ((st.n1 - 1) * st.going + st.n1 * st.riser) + st.c2 * ((st.n2 - 1) * st.going + st.n2 * st.riser) + st.wall;
      if (of(['stair_skirting']).length) {
        const lhs = sum(of(['stair_skirting']), (f) => f.measured);
        out.push({ id: 'stair_skirting', name: N.stair_skirting, ok: Math.abs(lhs - walled) <= 0.001 && lhs <= st.fin.skirt + 0.001, lhs: r6(lhs), rhs: r6(walled), tol: 0.001, where, note: `${en ? 'walls on three sides' : 'đủ ba phía có tường'}: ${nf(st.fin.skirt, en)}` });
      }
      const rail = mine.filter((f) => f.kind === 'handrail');
      if (rail.length) push('stair_rail', where, sum(rail, (f) => f.measured), st.fin.rail, 0.001);
    });
  }
  return out;
}
