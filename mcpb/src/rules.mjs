// Measurement rules as data: what a bill counts, apart from the geometry. Every quantity line carries two numbers:
// the geometric net (what is really there, every opening deducted) and the measured quantity by a rule set. The
// default set follows Phụ lục VI of Thông tư 13/2021/TT-BXD (clause 5.4 as amended by Thông tư 01/2025/TT-BXD), the
// last detailed Vietnamese text on measuring quantities; a company's own rules are given as another set.

/** A rule set. Areas in m², volumes in m³, lengths in mm. */
export const RULE_SETS = {
  // Phụ lục VI, Thông tư 13/2021/TT-BXD (5.3 xây, 5.4 bê tông, 5.5 ván khuôn, 5.13 hoàn thiện)
  PL6: {
    name: { vi: 'Phụ lục VI Thông tư 13/2021/TT-BXD', en: 'Appendix VI, Circular 13/2021/TT-BXD' },
    // openings and voids smaller than these are not deducted
    void: { finish: 0.25, masonry: 0.25, formwork: 1, concrete: 0.1 },
    // who owns the concrete where members meet, first wins: what lies in the slab thickness is slab, the column-beam
    // node is beam, a column joined to a wall is wall
    junction: ['slab', 'beam', 'wall', 'column'],
    // reveals of openings (jambs, head, sill of a window) count with the finish of the wall face they open in
    reveals: true,
    // decimals of the quantities of the bill
    decimals: 3,
  },
  // the geometry as it is: every opening deducted, nothing rounded up
  NET: {
    name: { vi: 'Khối lượng hình học', en: 'Geometric quantities' },
    void: { finish: 0, masonry: 0, formwork: 0, concrete: 0 },
    junction: ['slab', 'beam', 'wall', 'column'],
    reveals: true,
    decimals: 3,
  },
};

export const DEFAULT_RULES = 'PL6';

/** The rule set by name or as given (an object: its fields over the default set). */
export function ruleSet(rules) {
  if (!rules) return RULE_SETS[DEFAULT_RULES];
  if (typeof rules === 'string') {
    const r = RULE_SETS[rules.toUpperCase()];
    if (!r) throw new Error(`rules: unknown rule set "${rules}" (${Object.keys(RULE_SETS).join(', ')})`);
    return r;
  }
  const base = RULE_SETS[String(rules.base ?? DEFAULT_RULES).toUpperCase()] ?? RULE_SETS[DEFAULT_RULES];
  return { ...base, ...rules, void: { ...base.void, ...(rules.void || {}) } };
}

/**
 * The quantity a rule set measures for a gross quantity and its deductions [{area | volume}] and additions: a
 * deduction smaller than the threshold of the kind of work is not taken off.
 */
export function measured(gross, deductions, additions, threshold, key = 'area') {
  const off = (deductions || []).reduce((s, d) => s + ((d[key] ?? 0) >= threshold ? d[key] ?? 0 : 0), 0);
  const on = (additions || []).reduce((s, a) => s + (a[key] ?? 0), 0);
  return Math.max(0, gross - off + on);
}

/** The geometric net: every deduction taken off. */
export function net(gross, deductions, additions, key = 'area') {
  return Math.max(0, gross - (deductions || []).reduce((s, d) => s + (d[key] ?? 0), 0) + (additions || []).reduce((s, a) => s + (a[key] ?? 0), 0));
}

/**
 * Round to the decimals of the rule set (three for Phụ lục VI), a half upwards as a spreadsheet does: a sum of binary
 * fractions may sit a hair under the half (16,6275 is 16,628), so the bill and its workbook show the same number.
 */
export const roundQ = (v, rules) => {
  const k = 10 ** (ruleSet(rules).decimals ?? 3);
  return Math.round((v + 1e-10) * k) / k;
};
