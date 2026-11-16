// Illuminance check of a lighting layout (kiểm tra độ rọi): the lights of the reflected ceiling plan as point sources,
// the direct illuminance on a grid of the work plane of each room (and on vertical planes such as display walls), the
// inter-reflected part by the integrating sphere, then Em, Emin, Emax and U0 against the requirements of TCVN 7114-1:2008
// (ISO 8995-1:2002) per kind of room, with the power and the lighting power density.
import { num, PlanError, pt } from './plan.mjs';

const r2 = (v) => Math.round(v * 100) / 100;
const r0 = (v) => Math.round(v);
const DEG = Math.PI / 180;

/**
 * Default photometry by kind of light: luminous flux (lm, or lm per metre for linear and strip lights), the beam angle
 * (full width at half maximum; 120 is a Lambertian emitter), the power (W, or W/m) and, for a pendant, how far it hangs
 * below the ceiling. Replace them by code or kind with photometry {"LT-01": {lm, beam, w}} or on each light.
 */
export const PHOTOMETRY = {
  downlight: { lm: 800, beam: 60, w: 9 },
  spot: { lm: 700, beam: 36, w: 8 },
  linear: { lm_m: 1200, beam: 120, w_m: 12 },
  ceiling_lamp: { lm: 2000, beam: 120, w: 20 },
  pendant: { lm: 1500, beam: 120, w: 15, hang: 900 },
  strip: { lm_m: 600, w_m: 8, indirect: true },
};

/**
 * Maintained illuminance Em (lx) and uniformity U0 = Emin/Em by task, TCVN 7114-1:2008 (= ISO 8995-1:2002), and the
 * height of the reference plane (0 = the floor for circulation areas). Rooms of a dwelling are not in the standard: their
 * values are common reference values (standard: false), reported without a pass or a fail of the standard.
 */
export const LUX_TASKS = {
  office: { em: 500, u0: 0.6, vi: 'Văn phòng: viết, đọc, máy tính', en: 'Office: writing, reading, data processing' },
  meeting: { em: 500, u0: 0.6, vi: 'Phòng họp, hội nghị', en: 'Meeting and conference room' },
  reception: { em: 300, u0: 0.6, vi: 'Quầy lễ tân', en: 'Reception desk' },
  classroom: { em: 300, u0: 0.6, vi: 'Phòng học', en: 'Classroom' },
  reading: { em: 500, u0: 0.6, vi: 'Phòng đọc, thư viện', en: 'Reading area, library' },
  sales: { em: 300, u0: 0.4, vi: 'Khu bán hàng, trưng bày', en: 'Sales and display area' },
  till: { em: 500, u0: 0.6, vi: 'Quầy thu ngân', en: 'Till area' },
  kitchen_commercial: { em: 500, u0: 0.6, vi: 'Bếp nhà hàng', en: 'Restaurant kitchen' },
  canteen: { em: 200, u0: 0.4, vi: 'Căng tin, pantry', en: 'Canteen, pantry' },
  lounge: { em: 200, u0: 0.4, vi: 'Phòng chờ, sảnh nghỉ', en: 'Lounge, waiting area' },
  rest: { em: 100, u0: 0.4, vi: 'Phòng nghỉ', en: 'Rest room' },
  toilet: { em: 200, u0: 0.4, vi: 'Vệ sinh, phòng tắm, thay đồ', en: 'Toilets, washrooms, changing rooms' },
  storage: { em: 100, u0: 0.4, vi: 'Kho', en: 'Store room' },
  corridor: { em: 100, u0: 0.4, plane: 0, vi: 'Hành lang, lối đi', en: 'Corridor, circulation area' },
  entrance: { em: 100, u0: 0.4, plane: 0, vi: 'Sảnh vào', en: 'Entrance hall' },
  stairs: { em: 150, u0: 0.4, plane: 0, vi: 'Cầu thang', en: 'Stairs' },
  // dwellings (not in TCVN 7114-1): reference values
  living: { em: 150, u0: null, standard: false, vi: 'Phòng khách (nhà ở, tham khảo)', en: 'Living room (dwelling, reference)' },
  bedroom: { em: 100, u0: null, standard: false, vi: 'Phòng ngủ (nhà ở, tham khảo)', en: 'Bedroom (dwelling, reference)' },
  kitchen: { em: 300, u0: null, standard: false, vi: 'Bếp (nhà ở, tham khảo)', en: 'Kitchen (dwelling, reference)' },
  dining: { em: 200, u0: null, standard: false, vi: 'Phòng ăn (nhà ở, tham khảo)', en: 'Dining room (dwelling, reference)' },
  bathroom: { em: 150, u0: null, standard: false, vi: 'Phòng tắm, WC (nhà ở, tham khảo)', en: 'Bathroom (dwelling, reference)' },
  study: { em: 300, u0: null, standard: false, vi: 'Phòng làm việc (nhà ở, tham khảo)', en: 'Study (dwelling, reference)' },
};

// the task of a room by its name (Vietnamese or English), first match wins
const TASK_BY_NAME = [
  [/hành lang|lối đi|corridor|passage/i, 'corridor'],
  [/cầu thang|thang bộ|stair/i, 'stairs'],
  [/lễ tân|reception/i, 'reception'],
  [/sảnh|entrance|lobby|foyer/i, 'entrance'],
  [/họp|hội nghị|meeting|conference|boardroom/i, 'meeting'],
  [/văn phòng|làm việc chung|office|workspace|open.?plan/i, 'office'],
  [/thu ngân|till|cashier/i, 'till'],
  [/trưng bày|showroom|gallery|bán hàng|cửa hàng|shop|retail|exhibition|display/i, 'sales'],
  [/thư viện|đọc|library|reading/i, 'reading'],
  [/lớp|phòng học|classroom/i, 'classroom'],
  [/căng tin|căn tin|nhà ăn|pantry|canteen/i, 'canteen'],
  [/chờ|lounge|waiting/i, 'lounge'],
  [/nghỉ|rest room|break/i, 'rest'],
  [/kho|store|storage/i, 'storage'],
  [/vệ sinh|toilet|wc|thay đồ|washroom|locker/i, 'toilet'],
  [/tắm|bath/i, 'bathroom'],
  [/bếp|kitchen/i, 'kitchen'],
  [/ăn|dining/i, 'dining'],
  [/ngủ|bed/i, 'bedroom'],
  [/khách|sinh hoạt|living|family/i, 'living'],
  [/làm việc|study/i, 'study'],
];

export function taskOf(name) {
  for (const [re, t] of TASK_BY_NAME) if (re.test(String(name))) return t;
  return null;
}

const insidePoly = (q, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const areaOf = (poly) => Math.abs(poly.reduce((s, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return s + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;
const perimeterOf = (poly) => poly.reduce((s, p, i) => {
  const q = poly[(i + 1) % poly.length];
  return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
}, 0);
const segDist = (q, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy);
};
const edgeDist = (q, poly) => Math.min(...poly.map((p, i) => segDist(q, p, poly[(i + 1) % poly.length])));

/**
 * The calculation grid of a room (EN 12464-1: cell size p = 0.2 x 5^log10(d), d the longer side in metres, p at most
 * 10 m), points at the centres of the cells, a band of margin along the walls left out (none when the room is too small).
 */
export function roomGrid(poly, margin = 500, spacing = null) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  for (const m of [margin, margin / 2, 0]) {
    const w = x1 - x0 - 2 * m, h = y1 - y0 - 2 * m;
    if (w <= 0 || h <= 0) continue;
    const d = Math.max(w, h) / 1000;
    const p = spacing ?? Math.min(10000, 200 * 5 ** Math.log10(Math.max(d, 0.1)));
    const nx = Math.max(1, Math.ceil(w / p)), ny = Math.max(1, Math.ceil(h / p));
    const pts = [];
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        const q = [x0 + m + ((i + 0.5) * w) / nx, y0 + m + ((j + 0.5) * h) / ny];
        if (insidePoly(q, poly) && (m === 0 || edgeDist(q, poly) >= m - 1)) pts.push(q);
      }
    }
    if (pts.length) return { points: pts, cell: [r0(w / nx), r0(h / ny)], margin: m };
  }
  return { points: [], cell: null, margin: 0 };
}

/** The photometry of a light: its own values, then by its code, then by its kind. */
function photometryOf(f, table) {
  const base = PHOTOMETRY[f.kind] ?? PHOTOMETRY.downlight;
  const ph = { ...base, ...(table[f.kind] || {}), ...(table[f.code] || {}) };
  for (const k of ['lm', 'beam', 'w', 'hang', 'tilt']) if (f[k] !== undefined) ph[k] = f[k];
  if (f.length_m !== undefined) {
    // linear and strip lights: per metre unless the light gives its whole flux
    if (f.lm === undefined && ph.lm_m !== undefined) ph.lm = ph.lm_m * f.length_m;
    if (f.w === undefined && ph.w_m !== undefined) ph.w = ph.w_m * f.length_m;
  }
  if (!(ph.lm > 0)) throw new PlanError(`${f.code ?? f.kind}: no luminous flux (photometry {"${f.code ?? f.kind}": {lm}})`);
  return ph;
}

/**
 * The point sources of a light: [{p: [x, y, z], axis: [ax, ay, az], k, lm}]. A beam of full width at half maximum B is
 * I(θ) = Φ (k+1) / 2π cos^k θ with k = ln 0.5 / ln cos(B/2) (k = 1 for B = 120, a Lambertian emitter); a linear light is
 * cut in 100 mm pieces. A spot aims at its aim point on the reference plane (tilt: degrees from straight down).
 */
function sourcesOf(f, ph, planeZ) {
  const z = f.z - (f.kind === 'pendant' ? ph.hang ?? 900 : 0);
  const B = Math.min(179, Math.max(2, ph.beam ?? 120));
  const k = Math.log(0.5) / Math.log(Math.cos((B / 2) * DEG));
  if (f.from && f.to) {
    const L = Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]);
    const n = Math.max(1, Math.round(L / 100));
    return Array.from({ length: n }, (_, i) => {
      const t = (i + 0.5) / n;
      return { p: [f.from[0] + t * (f.to[0] - f.from[0]), f.from[1] + t * (f.to[1] - f.from[1]), z], axis: [0, 0, -1], k, lm: ph.lm / n };
    });
  }
  let axis = [0, 0, -1];
  if (f.aim || ph.tilt) {
    const dx = f.aim ? f.aim[0] - f.at[0] : 0, dy = f.aim ? f.aim[1] - f.at[1] : 0;
    const hd = Math.hypot(dx, dy);
    const tilt = ph.tilt !== undefined ? ph.tilt * DEG : Math.min(60 * DEG, Math.atan2(hd, Math.max(1, z - planeZ)));
    const ux = hd ? dx / hd : 1, uy = hd ? dy / hd : 0;
    axis = [Math.sin(tilt) * ux, Math.sin(tilt) * uy, -Math.cos(tilt)];
  }
  return [{ p: [f.at[0], f.at[1], z], axis, k, lm: ph.lm }];
}

/** Direct illuminance (lx, before the maintenance factor) at point q (mm) on a surface of normal n from the sources. */
function direct(q, n, sources) {
  let E = 0;
  for (const s of sources) {
    const v = [q[0] - s.p[0], q[1] - s.p[1], q[2] - s.p[2]];
    const r = Math.hypot(...v);
    if (r < 1) continue;
    const cosT = (v[0] * s.axis[0] + v[1] * s.axis[1] + v[2] * s.axis[2]) / r;
    if (cosT <= 0) continue;
    const cosI = -(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]) / r;
    if (cosI <= 0) continue;
    const I = (s.lm * (s.k + 1)) / (2 * Math.PI) * cosT ** s.k;
    E += (I * cosI) / (r / 1000) ** 2;
  }
  return E;
}

const stats = (vals) => {
  const em = vals.reduce((a, b) => a + b, 0) / vals.length;
  const emin = Math.min(...vals), emax = Math.max(...vals);
  return { em: r0(em), emin: r0(emin), emax: r0(emax), u0: em > 0 ? r2(emin / em) : 0 };
};

/**
 * Illuminance per room. rooms {name: outline (plan coordinates)}; heights {name: ceiling level}; fixtures as recorded by
 * the ceiling plan ({kind, code, room, at | from + to, z, aim, lm, beam, w}); given {name: {task, em, u0, plane,
 * reflectances}}; vertical [{name, room, from, to, z0, z1, em}] planes (a display wall), lit from the room side.
 */
export function lightingCalc({ rooms, heights = {}, fixtures = [], given = {}, photometry = {}, mf = 0.8, plane = 750, margin = 500, spacing = null, reflectances = {}, vertical = [], lang = 'vi' }) {
  const rho = { ceiling: 0.7, walls: 0.5, floor: 0.2, ...reflectances };
  const assumed = [];
  const out = [];
  const used = new Set();
  for (const [name, poly] of Object.entries(rooms)) {
    const g = given[name] || {};
    const fx = fixtures.filter((f) => f.room === name);
    const taskKey = g.task ?? taskOf(name);
    if (g.task && !LUX_TASKS[g.task]) throw new PlanError(`rooms.${name}.task must be one of ${Object.keys(LUX_TASKS).join(', ')}`);
    const task = taskKey ? LUX_TASKS[taskKey] : null;
    if (!fx.length && !task && g.em === undefined) continue;
    const req = {
      em: g.em !== undefined ? num(g.em, `rooms.${name}.em`, { positive: true }) : task?.em ?? null,
      u0: g.u0 !== undefined ? num(g.u0, `rooms.${name}.u0`) : task?.u0 ?? null,
    };
    if (!g.task && g.em === undefined && taskKey) assumed.push({ item: `${name}.task`, value: taskKey, note: `${task[lang] ?? task.vi}: ${task.em} lx${task.u0 ? `, U0 ${task.u0}` : ''}${task.standard === false ? ' (reference, not in TCVN 7114-1)' : ''}` });
    const pz = g.plane !== undefined ? num(g.plane, `rooms.${name}.plane`) : task?.plane ?? plane;
    const H = heights[name] ?? 3000;
    const grid = roomGrid(poly, margin, spacing);
    const lit = [], ind = [];
    let power = 0, flux = 0, fluxInd = 0;
    for (const f of fx) {
      const ph = photometryOf(f, photometry);
      used.add(f.code ?? f.kind);
      power += ph.w ?? 0;
      if (ph.indirect) {
        fluxInd += ph.lm;
        continue;
      }
      flux += ph.lm;
      lit.push(...sourcesOf(f, ph, pz));
    }
    // inter-reflections by the integrating sphere: E = ρΦ / (A (1 - ρ)) over all the surfaces of the room
    const A = areaOf(poly) / 1e6, Pm = perimeterOf(poly) / 1000, Hm = H / 1000;
    const Aw = Pm * Hm, Atot = 2 * A + Aw;
    const rhoAvg = (A * rho.ceiling + A * rho.floor + Aw * rho.walls) / Atot;
    const Eind = ((flux * rhoAvg + fluxInd * rho.ceiling) * mf) / (Atot * (1 - rhoAvg));
    const vals = grid.points.map((q) => direct([q[0], q[1], pz], [0, 0, 1], lit) * mf + Eind);
    const st = vals.length ? stats(vals) : { em: null, emin: null, emax: null, u0: null };
    const row = {
      room: name, task: taskKey, description: task ? task[lang] ?? task.vi : null, required: req, standard: task ? task.standard !== false : null,
      plane_mm: pz, area_m2: r2(A), lights: fx.length, flux_lm: r0(flux + fluxInd), power_w: r2(power), lpd_w_m2: A ? r2(power / A) : null,
      points: vals.length, cell_mm: grid.cell, ...st, indirect: r0(Eind),
    };
    if (req.em !== null && st.em !== null) {
      const okE = st.em >= req.em, okU = req.u0 === null || st.u0 >= req.u0;
      row.pass = task?.standard === false && g.em === undefined ? null : okE && okU;
      row.meets = okE && okU;
      const advice = [];
      if (!okE) {
        const need = flux > 0 ? flux * (req.em / Math.max(1, st.em) - 1) : null;
        const main = fx.filter((f) => !photometryOf(f, photometry).indirect);
        const each = main.length ? photometryOf(main[0], photometry).lm : PHOTOMETRY.downlight.lm;
        advice.push(lang === 'en'
          ? `Em ${st.em} < ${req.em} lx: about ${r0(need ?? req.em * A / (mf * 0.5))} lm more (${Math.ceil((need ?? req.em * A / (mf * 0.5)) / each)} more lights of ${each} lm, or brighter ones)`
          : `Em ${st.em} < ${req.em} lx: thiếu khoảng ${r0(need ?? req.em * A / (mf * 0.5))} lm (thêm ${Math.ceil((need ?? req.em * A / (mf * 0.5)) / each)} đèn ${each} lm, hoặc dùng đèn sáng hơn)`);
      }
      if (!okU) {
        advice.push(lang === 'en'
          ? `U0 ${st.u0} < ${req.u0}: the lights are too far apart or their beams too narrow; closer spacing or wider beams`
          : `U0 ${st.u0} < ${req.u0}: đèn quá thưa hoặc góc chiếu hẹp; bố trí dày hơn hoặc dùng góc chiếu rộng hơn`);
      }
      if (okE && st.em > 2 * req.em) advice.push(lang === 'en' ? `Em is over twice the requirement: fewer or dimmer lights save power` : `Em gấp hơn 2 lần yêu cầu: có thể giảm số đèn hoặc công suất`);
      if (advice.length) row.advice = advice;
    }
    if (!fx.length) row.warning = lang === 'en' ? 'no lights in this room' : 'phòng không có đèn';
    out.push(row);
  }
  // vertical planes (display walls, boards): the illuminance on the face looking into the room
  const planes = vertical.map((v, i) => {
    const nm = `vertical[${i}]`;
    const a = pt(v.from, `${nm}.from`), b = pt(v.to, `${nm}.to`);
    const z0 = num(v.z0 ?? 800, `${nm}.z0`), z1 = num(v.z1 ?? 2000, `${nm}.z1`);
    if (z1 <= z0) throw new PlanError(`${nm}: z1 must be above z0`);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1) throw new PlanError(`${nm}: from and to are the same point`);
    const t = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const room = v.room ?? Object.keys(rooms).find((n) => insidePoly([mid[0] - t[1] * 200, mid[1] + t[0] * 200], rooms[n]) || insidePoly([mid[0] + t[1] * 200, mid[1] - t[0] * 200], rooms[n]));
    if (!room || !rooms[room]) throw new PlanError(`${nm}: not along a room (give room)`);
    // the normal towards the inside of the room
    let n = [-t[1], t[0]];
    if (!insidePoly([mid[0] + n[0] * 200, mid[1] + n[1] * 200], rooms[room])) n = [t[1], -t[0]];
    const lit = [];
    for (const f of fixtures.filter((x) => x.room === room)) {
      const ph = photometryOf(f, photometry);
      if (!ph.indirect) lit.push(...sourcesOf(f, ph, (z0 + z1) / 2));
    }
    const nu = Math.max(2, Math.ceil(L / 250)), nv = Math.max(2, Math.ceil((z1 - z0) / 250));
    const vals = [];
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const s = ((i + 0.5) * L) / nu, z = z0 + ((j + 0.5) * (z1 - z0)) / nv;
        // a point 1 mm in front of the face
        vals.push(direct([a[0] + t[0] * s + n[0], a[1] + t[1] * s + n[1], z], [n[0], n[1], 0], lit) * mf);
      }
    }
    const rr = out.find((r) => r.room === room);
    const ind = rr ? rr.indirect : 0;
    const st = stats(vals.map((x) => x + ind));
    const res = { name: v.name ?? `${room} ${nm}`, room, length_mm: r0(L), z: [z0, z1], points: vals.length, ...st };
    if (v.em !== undefined) {
      res.required = { em: num(v.em, `${nm}.em`), u0: v.u0 !== undefined ? num(v.u0, `${nm}.u0`) : null };
      res.pass = st.em >= res.required.em && (res.required.u0 === null || st.u0 >= res.required.u0);
    }
    return res;
  });
  // the photometry taken by default (by kind, as replaced by code or kind), reported in assumed
  const usedPh = Object.fromEntries([...used].map((k) => {
    const f = fixtures.find((x) => (x.code ?? x.kind) === k);
    const ph = { ...(PHOTOMETRY[f.kind] ?? PHOTOMETRY.downlight), ...(photometry[f.kind] || {}), ...(photometry[f.code] || {}) };
    return [k, ph];
  }));
  for (const [k, v] of Object.entries(usedPh)) if (!photometry[k] && !fixtures.some((f) => (f.code ?? f.kind) === k && f.lm !== undefined)) assumed.push({ item: `photometry.${k}`, value: v });
  // lights outside every room (or in a room without a ceiling) light nothing here: say so
  const lost = fixtures.filter((f) => !f.room || !rooms[f.room]);
  const warnings = lost.length ? [`${lost.length} light(s) outside the rooms of the plan, not counted: ${[...new Set(lost.map((f) => f.code ?? f.kind))].join(', ')}`] : [];
  return {
    rooms: out, vertical: planes.length ? planes : undefined, assumed, warnings,
    method: `${lang === 'en' ? 'point sources with beam cos^k, MF' : 'nguồn điểm, phân bố cos^k theo góc chiếu, hệ số duy trì MF'} ${mf}; ${lang === 'en' ? 'inter-reflections by the integrating sphere' : 'phản xạ nhiều lần theo phương pháp quả cầu tích phân'} (ρ ${rho.ceiling}/${rho.walls}/${rho.floor}); ${lang === 'en' ? 'grid EN 12464-1, wall band' : 'lưới điểm EN 12464-1, bỏ dải sát tường'} ${margin} mm; TCVN 7114-1:2008`,
  };
}

/** The rows of the result as a table (header first) for a CSV file or a table drawn in the drawing. */
export function luxTable(r, lang = 'vi') {
  const en = lang === 'en';
  const head = en
    ? ['Room', 'Task', 'Required Em (lx)', 'Required U0', 'Em (lx)', 'Emin (lx)', 'Emax (lx)', 'U0', 'Lights', 'Power (W)', 'LPD (W/m²)', 'Result']
    : ['Phòng', 'Công năng', 'Em yêu cầu (lx)', 'U0 yêu cầu', 'Em (lx)', 'Emin (lx)', 'Emax (lx)', 'U0', 'Số đèn', 'Công suất (W)', 'LPD (W/m²)', 'Kết quả'];
  const verdict = (x) => (x.pass === true ? (en ? 'PASS' : 'ĐẠT') : x.pass === false ? (en ? 'FAIL' : 'KHÔNG ĐẠT') : x.meets === true ? (en ? 'ok (reference)' : 'đạt (tham khảo)') : x.meets === false ? (en ? 'low (reference)' : 'thấp (tham khảo)') : '');
  const rows = r.rooms.map((x) => [x.room, x.description ?? '', x.required.em ?? '', x.required.u0 ?? '', x.em ?? '', x.emin ?? '', x.emax ?? '', x.u0 ?? '', x.lights, x.power_w, x.lpd_w_m2 ?? '', verdict(x)]);
  for (const v of r.vertical || []) rows.push([v.name, en ? 'vertical plane' : 'mặt đứng', v.required?.em ?? '', v.required?.u0 ?? '', v.em, v.emin, v.emax, v.u0, '', '', '', verdict(v)]);
  return [head, ...rows];
}
