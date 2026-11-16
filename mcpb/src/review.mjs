// Reviewing drawings made by others: dimensions whose written value is not what they measure, area texts that are not
// the area of their room, the language of texts (for translating bilingual drawings), and the register of sheets of a
// whole folder of drawings. Pure functions over what the bridge reads (annotation_data, text_list, model_map).

/** Text of a dimension or label without mtext codes and AutoCAD symbols (%%c, %%d, %%p). */
export function plainText(s) {
  return String(s ?? '')
    .replace(/\\[A-Za-z][^;\\]*;/g, ' ')
    .replace(/\\[PpNnXx~]/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/%%[cCdDpP]/g, ' ')
    .replace(/<>/g, ' ');
}

/**
 * The values a dimension text may mean: each number as written ("4000", "4.000" and "4,000" with a thousands separator,
 * "3,5" with a decimal comma) and the product of "a x b" ("2x1200" is 2400).
 */
export function numbersIn(text) {
  const t = plainText(text);
  const out = [];
  const tokens = [...t.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
  const values = (tok) => {
    const v = new Set();
    v.add(Number(tok.replace(/,/g, '.').replace(/\.(?=.*\.)/g, ''))); // the last separator is the decimal point
    if (/^\d{1,3}([.,]\d{3})+$/.test(tok)) v.add(Number(tok.replace(/[.,]/g, ''))); // thousands
    return [...v].filter(Number.isFinite);
  };
  for (const tok of tokens) out.push(...values(tok));
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)/gi)) {
    for (const a of values(m[1])) for (const b of values(m[2])) out.push(a * b);
  }
  return out;
}

/**
 * The dimensions whose text is written over (bridge annotation_data): those whose numbers do not give what they
 * measure (with the linear factor, within half the last decimal, 0.2 % or 1 mm), those written as words only, the rest.
 * Each mismatch carries the fix: its number replaced by <> (the measured value), the rest of its text kept.
 */
export function checkDims(dims, unitsM = 0.001) {
  const mismatch = [], words = [], ok = [];
  for (const d of dims || []) {
    const vals = numbersIn(d.text);
    if (!vals.length) {
      words.push({ handle: d.h, text: d.text });
      continue;
    }
    const lfac = Number(d.lfac) || 1;
    const meas = [d.m, d.m * lfac, lfac ? d.m / lfac : d.m].filter(Number.isFinite);
    const tol = d.kind === 'angular' ? 0.5 : Math.max(0.5 * 10 ** -(d.dec ?? 0), 0.002 * Math.abs(d.m), 0.001 / (unitsM || 0.001));
    const diff = Math.min(...vals.flatMap((v) => meas.map((m) => Math.abs(v - m))));
    if (diff <= tol) {
      ok.push(d.h);
      continue;
    }
    const shown = Math.round(d.m * lfac * 10 ** (d.dec ?? 0)) / 10 ** (d.dec ?? 0);
    const tokens = [...plainText(d.text).matchAll(/\d+(?:[.,]\d+)*/g)];
    const onlyNumber = tokens.length === 1 && plainText(d.text).trim() === tokens[0][0];
    // the first number of the text becomes <>: "R=500" -> "R=<>", "3600 (CỬA)" -> "<> (CỬA)"
    const fixed = onlyNumber ? '<>' : String(d.text).replace(/\d+(?:[.,]\d+)*/, '<>');
    mismatch.push({ handle: d.h, kind: d.kind, text: d.text, measured: shown, diff: Math.round(diff * 1000) / 1000, layer: d.layer, b: d.b, fixed });
  }
  return { mismatch, words, ok };
}

/**
 * The area texts (bridge annotation_data) against the area of the room outline around them: a text whose number is
 * not that area (rounded as it is written) is a mismatch, fixed in the same form ("18,40 m²" -> "19,78 m²"). An outline
 * far from the written area (another outline, the building) does not count: no outline.
 */
export function checkAreas(areas) {
  const mismatch = [], ok = [], none = [];
  for (const a of areas || []) {
    const s = plainText(a.text);
    // the number written next to m2 / m², or after S = / DT / DIỆN TÍCH, else the last number with decimals
    const m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:m2|m²|㎡)/i) || s.match(/(?:S|DT|DIỆN TÍCH|AREA|面積|面积)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i) || s.match(/(\d+[.,]\d+)/);
    if (!m) continue;
    const tok = m[1];
    const sep = (tok.match(/[.,]/) || ['.'])[0];
    const dec = tok.includes(sep) && /[.,]/.test(tok) ? tok.split(/[.,]/)[1].length : 0;
    const v = Number(tok.replace(',', '.'));
    if (!Number.isFinite(a.area_m2) || a.area_m2 < 0.6 * v || a.area_m2 > 1.6 * v) {
      none.push({ handle: a.h, text: a.text });
      continue;
    }
    const tol = 0.5 * 10 ** -dec + 0.002 * a.area_m2;
    if (Math.abs(v - a.area_m2) <= tol) {
      ok.push(a.h);
      continue;
    }
    const written = a.area_m2.toFixed(dec).replace('.', sep);
    // the fix is written into the text as it is stored (an mtext keeps its formatting and its line breaks)
    const raw = a.raw && String(a.raw).includes(tok) ? String(a.raw) : String(a.text);
    mismatch.push({ handle: a.h, text: a.text, area_m2: Math.round(a.area_m2 * 100) / 100, outline: a.outline, b: a.b, fixed: raw.replace(tok, written) });
  }
  return { mismatch, ok, none };
}

/** The language of a text: zh (Chinese characters), vi (Vietnamese letters), en (Latin letters only), other. */
export function textLanguage(s) {
  const t = String(s ?? '');
  if (/[㐀-鿿豈-﫿]/.test(t)) return 'zh';
  if (/[ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯưẠ-ỹ]/.test(t)) return 'vi';
  if (/[A-Za-z]/.test(t)) return 'en';
  return 'other';
}

/**
 * Texts of bridge text_list ([handle, kind, text, layer, style, space, x, y, height]) filtered (find: text or
 * pattern, language), as they are or one row per distinct text with how often it is written and where.
 */
export function listTexts(items, { find = null, regex = false, language = null, unique = true } = {}) {
  let re = null;
  if (find) re = regex ? new RegExp(find, 'i') : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = (items || []).map((i) => ({ handle: i[0], kind: i[1], text: String(i[2]).trim(), layer: i[3], style: i[4], space: i[5], at: [i[6], i[7]], height: i[8] }))
    .filter((r) => r.text && (!re || re.test(r.text)) && (!language || textLanguage(r.text) === language));
  if (!unique) return rows;
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.text)) by.set(r.text, { text: r.text, count: 0, handles: [], kinds: new Set(), layers: new Set(), spaces: new Set(), language: textLanguage(r.text) });
    const u = by.get(r.text);
    u.count++;
    if (u.handles.length < 50) u.handles.push(r.handle);
    u.kinds.add(r.kind.replace(/^attribute .*/, 'attribute'));
    u.layers.add(r.layer);
    u.spaces.add(r.space);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .map((u) => ({ ...u, kinds: [...u.kinds], layers: [...u.layers].slice(0, 5), spaces: [...u.spaces].slice(0, 5) }));
}

/** The rows of a register of sheets from the maps of several drawings ([{file, map}] where map is describeDrawing's). */
export function registerRows(results) {
  const rows = [];
  for (const { file, map, error } of results) {
    if (error) {
      rows.push({ file, source: 'error', note: error });
      continue;
    }
    const legacy = map.legacy_font_texts ? Object.entries(map.legacy_font_texts).filter(([k]) => k !== 'styles').map(([k, n]) => `${n} ${k.toUpperCase()}`).join(', ') : '';
    for (const s of map.sheets) {
      const views = [...(s.views || []), ...(s.viewports || []).flatMap((v) => v.views)];
      rows.push({
        file, source: s.source === 'layout' ? 'layout' : 'model frame', layout: s.layout ?? '', number: s.number ?? '', title: s.title ?? (views[0]?.title ?? ''),
        paper: s.paper ?? '', scale: s.scale ? `1/${s.scale}` : (views.find((v) => v.scale)?.scale ? `1/${views.find((v) => v.scale).scale}` : ''),
        views: views.map((v) => v.title).join('; '), kinds: [...new Set(views.map((v) => v.kind))].join(', '), legacy,
      });
    }
    if (!map.sheets.length) rows.push({ file, source: 'no sheet found', views: map.views_outside_sheets.map((v) => v.title).join('; '), legacy });
  }
  return rows;
}

export const REGISTER_COLUMNS = [
  ['file', 'File / Tệp'], ['source', 'Source / Nguồn'], ['layout', 'Layout'], ['number', 'No. / Số BV'], ['title', 'Sheet / Tên tờ'],
  ['paper', 'Paper / Khổ'], ['scale', 'Scale / Tỷ lệ'], ['kinds', 'Kinds / Loại hình'], ['views', 'Views / Các hình'], ['legacy', 'Legacy fonts / Font cũ'],
  ['note', 'Note / Ghi chú'],
];

/** CSV (UTF-8 with BOM, for Excel) of rows over columns [[key, title]]. */
export function toCsv(rows, columns) {
  const q = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map(([, t]) => q(t)).join(','), ...rows.map((r) => columns.map(([k]) => q(r[k])).join(','))].join('\r\n') + '\r\n';
}
