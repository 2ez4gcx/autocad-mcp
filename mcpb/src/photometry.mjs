// Photometric files of luminaires: IES LM-63 (type C) and EULUMDAT (.ldt) read into one intensity distribution
// {C: [deg], G: [deg], I: [[cd]] (per C plane, per gamma), sym, flux (lm, integrated), watts, name}: gamma from the
// nadir of the luminaire (0 = straight down, 180 = up), C around its vertical axis. Pure computation.
import { PlanError } from './plan.mjs';

const DEG = Math.PI / 180;
const nums = (text) => text.split(/[\s,]+/).filter((t) => t !== '').map(Number);

/** IES LM-63 (1986-2019), photometric type C, TILT=NONE. */
export function parseIES(text, name = 'IES') {
  const src = String(text).replace(/\r/g, '');
  const m = /^TILT\s*=\s*(\S+)\s*$/im.exec(src);
  if (!m) throw new PlanError(`${name}: not an IES file (no TILT line)`);
  if (m[1].toUpperCase() !== 'NONE') throw new PlanError(`${name}: TILT=${m[1]} is not read (only TILT=NONE)`);
  const v = nums(src.slice(m.index + m[0].length));
  if (v.length < 13 || v.some((x) => !Number.isFinite(x))) throw new PlanError(`${name}: the numbers after TILT cannot be read`);
  const [nLamps, lmLamp, mult, nV, nH, type] = v;
  if (type !== 1) throw new PlanError(`${name}: photometric type ${type === 2 ? 'B' : 'A'} is not read (only type C)`);
  const ballast = v[10], watts = v[12];
  let k = 13;
  const G = v.slice(k, k + nV);
  k += nV;
  const C = v.slice(k, k + nH);
  k += nH;
  if (v.length < k + nV * nH) throw new PlanError(`${name}: ${nV * nH} candela values expected, ${v.length - k} found`);
  const f = (mult || 1) * (ballast || 1);
  const I = C.map((_, h) => v.slice(k + h * nV, k + (h + 1) * nV).map((x) => x * f));
  const last = C[C.length - 1];
  const sym = C.length === 1 || last === 0 ? 'rot' : last === 90 ? 'quad' : last === 180 ? 'bi0' : 'full';
  const title = /\[LUMCAT\]\s*(.+)/i.exec(src)?.[1]?.trim() ?? /\[LUMINAIRE\]\s*(.+)/i.exec(src)?.[1]?.trim();
  return finish({ C, G, I, sym, watts: watts > 0 ? watts : null, name: title || name, lampLumens: lmLamp > 0 ? lmLamp * nLamps * (mult || 1) : null });
}

/** EULUMDAT (.ldt): intensities in cd/klm of the lamps, by the symmetry code of the file. */
export function parseLDT(text, name = 'LDT') {
  const L = String(text).replace(/\r/g, '').split('\n').map((s) => s.trim());
  const n = (i) => Number(String(L[i] ?? '').replace(',', '.'));
  const isym = n(2), Mc = n(3), Ng = n(5);
  if (![0, 1, 2, 3, 4].includes(isym) || !(Mc > 0) || !(Ng > 0)) throw new PlanError(`${name}: not a EULUMDAT file (symmetry, C planes and gamma angles in lines 3, 4 and 6)`);
  const conv = n(23) || 1, sets = n(25);
  if (!(sets >= 1)) throw new PlanError(`${name}: number of lamp sets (line 26) cannot be read`);
  // the lamp sets: a block of 6 lists of `sets` lines each (count, type, lumens, colour, CRI, watts)
  let k = 26;
  const lumens = [], watts = [];
  k += sets; // number of lamps
  k += sets; // type
  for (let i = 0; i < sets; i++) lumens.push(n(k + i));
  k += sets;
  k += sets; // colour
  k += sets; // CRI
  for (let i = 0; i < sets; i++) watts.push(n(k + i));
  k += sets;
  k += 10; // direct ratios
  const Call = [];
  for (let i = 0; i < Mc; i++) Call.push(n(k + i));
  k += Mc;
  const G = [];
  for (let i = 0; i < Ng; i++) G.push(n(k + i));
  k += Ng;
  const planes = isym === 0 ? Mc : isym === 1 ? 1 : isym === 4 ? Mc / 4 + 1 : Mc / 2 + 1;
  const klm = lumens.reduce((s, x) => s + (x > 0 ? x : 0), 0) / 1000;
  if (!(klm > 0)) throw new PlanError(`${name}: lamp lumens (line 29) cannot be read`);
  const I = [];
  for (let c = 0; c < planes; c++) {
    const row = [];
    for (let g = 0; g < Ng; g++) row.push(n(k + c * Ng + g) * klm * conv);
    I.push(row);
  }
  if (I.flat().some((x) => !Number.isFinite(x))) throw new PlanError(`${name}: ${planes * Ng} intensities expected after the angles`);
  // the C angles the planes stand for
  const i90 = Call.findIndex((a) => Math.abs(a - 90) < 1e-6);
  const C = isym === 1 ? [0] : isym === 3 ? Call.slice(i90, i90 + planes) : Call.slice(0, planes);
  const sym = { 0: 'full', 1: 'rot', 2: 'bi0', 3: 'bi90', 4: 'quad' }[isym];
  const w = watts.reduce((s, x) => s + (x > 0 ? x : 0), 0);
  return finish({ C, G, I, sym, watts: w > 0 ? w : null, name: L[8] || name, lampLumens: klm * 1000 });
}

/** A photometric file by its content (and extension): IES or LDT. */
export function parsePhotometry(text, file = '') {
  const base = String(file).split(/[\\/]/).pop() || 'file';
  if (/\.ldt$/i.test(file)) return parseLDT(text, base);
  if (/\.ies$/i.test(file) || /^TILT\s*=/im.test(text)) return parseIES(text, base);
  return parseLDT(text, base);
}

function finish(d) {
  if (d.G.length < 2) throw new PlanError(`${d.name}: fewer than two vertical angles`);
  d.flux = fluxOf(d);
  if (!(d.flux > 0)) throw new PlanError(`${d.name}: the distribution has no light`);
  d.peak = Math.max(...d.I.flat());
  return d;
}

const lerp = (xs, ys, x) => {
  if (x <= xs[0]) return x < xs[0] - 1e-6 ? null : ys[0];
  const n = xs.length;
  if (x >= xs[n - 1]) return x > xs[n - 1] + 1e-6 ? null : ys[n - 1];
  let i = 1;
  while (xs[i] < x) i++;
  const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
};

/** Luminous intensity (cd) at gamma (deg from the nadir) in plane c (deg): interpolated, 0 outside the measured gammas. */
export function intensity(d, gamma, c = 0) {
  const at = (row) => lerp(d.G, row, gamma) ?? 0;
  if (d.sym === 'rot' || d.C.length === 1) return at(d.I[0]);
  let a = ((c % 360) + 360) % 360;
  if (d.sym === 'quad') {
    a %= 180;
    if (a > 90) a = 180 - a;
  } else if (d.sym === 'bi0') {
    if (a > 180) a = 360 - a;
  } else if (d.sym === 'bi90') {
    // measured from C90 to C270, mirrored about that plane
    if (a < 90) a = 180 - a;
    else if (a > 270) a = 540 - a;
  }
  const C = d.C, n = C.length;
  if (a <= C[0]) return at(d.I[0]);
  if (a >= C[n - 1]) {
    // a full file that stops short of 360: wrap round to its first plane
    if (d.sym === 'full' && C[n - 1] < 360 - 1e-6) {
      const t = (a - C[n - 1]) / (360 + C[0] - C[n - 1]);
      return at(d.I[n - 1]) * (1 - t) + at(d.I[0]) * t;
    }
    return at(d.I[n - 1]);
  }
  let i = 1;
  while (C[i] < a) i++;
  const t = (a - C[i - 1]) / (C[i] - C[i - 1] || 1);
  return at(d.I[i - 1]) * (1 - t) + at(d.I[i]) * t;
}

/** The flux of a distribution (lm): its intensity summed over the sphere (1° of gamma, 10° of C). */
export function fluxOf(d) {
  let sum = 0;
  const dc = d.sym === 'rot' || d.C.length === 1 ? 360 : 10;
  for (let c = 0; c < 360; c += dc) {
    for (let g = 0.5; g < 180; g += 1) sum += intensity(d, g, c) * Math.sin(g * DEG) * DEG * (dc * DEG);
  }
  return sum;
}

/** The beam of a distribution: full angle (deg) where the intensity falls to half its peak, in plane C0. */
export function beamOf(d) {
  const i0 = intensity(d, 0, 0) || d.peak;
  for (let g = 0; g <= 90; g += 0.5) if (intensity(d, g, 0) < i0 / 2) return Math.round(2 * g);
  return 180;
}
