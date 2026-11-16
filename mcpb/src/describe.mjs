// The map of a drawing made by others (đọc hiểu bản vẽ): its sheets (the layouts with their viewports, or the frames
// drawn in model space, their paper size and scale found from their size), the drawing number and title block of each,
// and the views on each sheet from their titles (plan, elevation, section, detail, schedule...: kind, floor, scale and
// the model window), so the other tools can be pointed at a view without a person showing where it is.
import { decodeLegacy, legacyEncoding, vniPairs } from './vnfont.mjs';

// the kind of a view from its title (Vietnamese, English, Chinese); the first that matches wins
const KINDS = [
  ['site', /^(TỔNG MẶT BẰNG|MẶT BẰNG TỔNG THỂ|QUY HOẠCH|SITE PLAN|MASTER PLAN|總平面|总平面)/u],
  ['ceiling', /^(MẶT BẰNG (BỐ TRÍ )?TRẦN|MB TRẦN|(REFLECTED )?CEILING PLAN|RCP\b|.*天花(板)?(平面(圖|图)?|(佈置|布置)?(圖|图))$)/u],
  ['roof', /^(MẶT BẰNG MÁI|MB MÁI|ROOF PLAN|屋頂平面|屋顶平面)/u],
  ['foundation', /^(MẶT BẰNG MÓNG|MB MÓNG|FOUNDATION PLAN|基礎平面|基础平面)/u],
  ['plan', /^(MẶT BẰNG|MB[\s.]|.*\bPLAN$|.*\bPLAN\b.*(FLOOR|LEVEL|TẦNG)|.*FLOOR PLAN|.*\bLAYOUT$|.*平面(圖|图)?$)/u],
  ['elevation', /^(MẶT ĐỨNG|MĐ[\s.]|.*\bELEVATIONS?\b|.*立面(圖|图)?$)/u],
  ['section', /^(MẶT CẮT|MC[\s.]|.*\bSECTIONS?\b|.*剖面(圖|图)?$)/u],
  ['detail', /^(CHI TIẾT|CT[\s.]|.*\bDETAILS?\b|.*(大樣|大样|詳圖|详图|節點|节点|細節|细节)(圖|图)?$)/u],
  ['schedule', /^(BẢNG|THỐNG KÊ|.*\bSCHEDULE\b|.*\bTABLE\b|.*表$)/u],
  ['diagram', /^(SƠ ĐỒ|.*\bDIAGRAM\b|.*\bRISER\b|.*(系統圖|系统图))/u],
  ['notes', /^(GHI CHÚ|THUYẾT MINH|CHỈ DẪN|YÊU CẦU KỸ THUẬT|.*\bNOTES?$|.*(說明|说明))/u],
  ['perspective', /^(PHỐI CẢNH|.*\bPERSPECTIVE\b|.*(透視|透视))/u],
  ['list', /^(DANH MỤC|.*\bDRAWING (LIST|INDEX)\b|.*(目錄|目录))/u],
];
const NOT_TITLE = /^(XEM|SEE|REFER|THAM KHẢO|GHI CHÚ:|NOTE:|TRỤC|KÝ HIỆU)\b/u;

/** The title of a text: its kind and floor, or null. */
export function titleOf(raw) {
  const tries = [String(raw ?? '')];
  const enc = legacyEncoding(tries[0]);
  if (enc) tries.push(decodeLegacy(tries[0], enc));
  for (const t of tries) {
    const s = t.normalize('NFC').replace(/%%[uUoO]/g, '').replace(/\s+/g, ' ').trim().toLocaleUpperCase('vi')
      .replace(/^(\(?\d{1,3}\)?[.):\-–]?\s+|[A-Z][.):]\s+)/u, '');
    if (s.length < 2 || s.length > 90 || NOT_TITLE.test(s)) continue;
    const k = KINDS.find(([, re]) => re.test(s));
    if (!k) continue;
    return { kind: k[0], title: s, floor: floorOf(s), scale: scaleOf(s), legacy: t !== tries[0] ? enc : undefined };
  }
  return null;
}

/** The floor a title names: "TẦNG 2" -> "2", "TẦNG TRỆT", "GROUND FLOOR", "3F", "二層"... or null. */
export function floorOf(s) {
  const t = String(s).toLocaleUpperCase('vi');
  let m = t.match(/TẦNG\s+(HẦM\s*\d*|TRỆT|LỬNG|MÁI|TUM|THƯỢNG|KỸ THUẬT|ĐIỂN HÌNH|\d+(?:\s*[-–,]\s*\d+)*)/u);
  if (m) return m[1].replace(/\s+/g, ' ');
  m = t.match(/\b(\d+)(?:ST|ND|RD|TH)\s+FLOOR\b/) || t.match(/\bLEVEL\s+(\d+)\b/) || t.match(/\b(B?\d+)F\b/);
  if (m) return m[1];
  m = t.match(/\b(GROUND|BASEMENT|MEZZANINE|ROOF|TYPICAL)\s+FLOOR\b/);
  if (m) return m[1];
  m = t.match(/(地下)?([一二三四五六七八九十\d]+)[層层楼樓]/u);
  return m ? m[0] : null;
}

/** The scale a text gives: "TỶ LỆ 1/100", "TL: 1:50", "SCALE 1:20", "比例 1:100", or a text that is only "1/100". */
export function scaleOf(s) {
  const t = String(s ?? '').toLocaleUpperCase('vi');
  const m = t.match(/(?:TỶ LỆ|TỈ LỆ|T\.?L\.?|SCALE|比例)\s*[:=]?\s*1\s*[:/]\s*(\d{1,4})\b/u) || t.match(/^\s*1\s*[:/]\s*(\d{1,4})\s*$/);
  return m ? Number(m[1]) : null;
}

const PAPERS = [['A0', 1189, 841], ['A1', 841, 594], ['A2', 594, 420], ['A3', 420, 297], ['A4', 297, 210]];
const SCALES = [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 1000];

/** The paper and scale of a frame w x h (drawing units, mm): the pair that fits within 4 %, or null. */
export function paperOf(w, h, tolerance = 0.05) {
  const W = Math.max(w, h), H = Math.min(w, h);
  let best = null;
  for (const [name, pw, ph] of PAPERS) {
    for (const sc of SCALES) {
      const e = Math.abs(W / sc - pw) / pw + Math.abs(H / sc - ph) / ph;
      if (e < tolerance && (!best || e < best.e)) best = { paper: name, scale: sc, e };
    }
  }
  return best ? { paper: best.paper, scale: best.scale } : null;
}

/** The paper and scale of an extended frame: the short side a paper's at a scale, the long side up to half as long again. */
export function extendedPaperOf(w, h) {
  const W = Math.max(w, h), H = Math.min(w, h);
  let best = null;
  for (const [name, pw, ph] of PAPERS) {
    for (const sc of SCALES) {
      const e = Math.abs(H / sc - ph) / ph;
      if (e < 0.02 && W / sc >= 0.98 * pw && W / sc <= 1.5 * pw && (!best || e < best.e)) best = { paper: name, scale: sc, e };
    }
  }
  return best ? { paper: best.paper, scale: best.scale, extended: true } : null;
}

/** The paper of a frame w x h drawn at a known scale (standard, or extended along its long side), or null. */
export function paperAt(w, h, sc) {
  const W = Math.max(w, h) / sc, H = Math.min(w, h) / sc;
  for (const [name, pw, ph] of PAPERS) {
    if (Math.abs(H - ph) / ph < 0.03 && Math.abs(W - pw) / pw < 0.03) return { paper: name, scale: sc };
    if (Math.abs(H - ph) / ph < 0.02 && W >= 0.98 * pw && W <= 1.5 * pw) return { paper: name, scale: sc, extended: true };
  }
  return null;
}

const inside = (p, b, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const contains = (a, b) => b[0] >= a[0] - 1 && b[1] >= a[1] - 1 && b[2] <= a[2] + 1 && b[3] <= a[3] + 1;
const median = (v) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const r0 = (v) => Math.round(v);

// title block attribute tags
const TAG = {
  name: /^(TEN.?(BAN.?)?(VE|BV)|TENBV|TITLE|DWG.?TITLE|DRAWING.?(TITLE|NAME)|SHEET.?(TITLE|NAME)|TÊN)/i,
  number: /^(SO.?(BAN.?)?(VE|BV|HIEU)|SOBV|KY.?HIEU|KÝ.?HIỆU|DWG.?NO|DRAWING.?(NO|NUMBER)|SHEET.?(NO|NUMBER)|NO\.?$|BV.?SO)/i,
  scale: /^(TY.?LE|TL|SCALE|TỶ.?LỆ)$/i,
  date: /^(NGAY|DATE|NGÀY)/i,
  project: /^(CONG.?TRINH|DU.?AN|PROJECT|CÔNG.?TRÌNH|DỰ.?ÁN)/i,
};
// a drawing number: letters and two or three digits (KT-01, KC02, A-101, NT.03a); door tags (D1), levels (FL-0.050) are not
const NUMBER = /^[A-ZĐ]{1,4}\s*[-._]?\s*\d{2,3}[A-Za-z]?$/u;
// a block that is a frame or title block by its name
const FRAME_NAME = /KHUNG|FRAME|BORDER|TITLE|SHEET|\bTB\b|TITLEBLOCK|BIA|^A[0-4](\b|_|-)|圖框|图框|圖签|图签/i;

function titleBlock(attrs) {
  const out = {};
  for (const [tag, v] of Object.entries(attrs || {})) {
    for (const [k, re] of Object.entries(TAG)) if (!out[k] && re.test(tag.replace(/\s+/g, '_'))) out[k] = String(v);
  }
  return out;
}

/**
 * The frames in model space: rectangles and block references the size of a paper at a scale (a block only with a
 * frame's name or attributes), with texts inside; a frame inside another is not a sheet (its inner border, a detail
 * box, a block that happens to have the proportions).
 */
/** Rectangles made of four lines (frames drawn line by line): bottom side, the two sides up from its ends, the top. */
export function rectsFromLines(lines) {
  const key = (x, y) => `${Math.round(x)}|${Math.round(y)}`;
  const at = new Map();
  const segs = (lines || []).map((l) => ({ a: [l[0], l[1]], b: [l[2], l[3]], layer: l[4] }));
  for (const s of segs) for (const p of [s.a, s.b]) {
    const k = key(p[0], p[1]);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(s);
  }
  const other = (s, p) => (Math.abs(s.a[0] - p[0]) < 1 && Math.abs(s.a[1] - p[1]) < 1 ? s.b : s.a);
  const out = [];
  for (const s of segs) {
    if (Math.abs(s.a[1] - s.b[1]) > 1) continue; // the bottom: horizontal
    const [l, r] = s.a[0] < s.b[0] ? [s.a, s.b] : [s.b, s.a];
    for (const v of at.get(key(l[0], l[1])) || []) {
      if (v === s) continue;
      const top = other(v, l);
      if (Math.abs(top[0] - l[0]) > 1 || top[1] <= l[1] + 1) continue; // up from the left end
      const H = top[1] - l[1];
      const right = (at.get(key(r[0], r[1])) || []).find((u) => u !== s && Math.abs(other(u, r)[0] - r[0]) < 1 && Math.abs(other(u, r)[1] - (r[1] + H)) < 1);
      if (!right) continue;
      const lid = (at.get(key(top[0], top[1])) || []).find((u) => u !== v && Math.abs(u.a[1] - u.b[1]) < 1 && Math.abs(other(u, top)[0] - r[0]) < 1);
      if (lid) out.push([l[0], l[1], r[0], l[1] + H, s.layer]);
    }
  }
  return out;
}

export function framesOf(map) {
  const cands = [];
  for (const r of [...(map.rects || []), ...rectsFromLines(map.lines)]) {
    const b = r.slice(0, 4), pp = paperOf(b[2] - b[0], b[3] - b[1]) ?? extendedPaperOf(b[2] - b[0], b[3] - b[1]);
    if (pp) cands.push({ box: b, ...pp, from: 'rectangle', layer: r[4] });
  }
  for (const i of map.inserts || []) {
    const b = i.box;
    if (!b) continue;
    const tb = titleBlock(i.attributes);
    if (!FRAME_NAME.test(i.name || '') && Object.keys(tb).length < 2) continue;
    const pp = paperOf(b[2] - b[0], b[3] - b[1]) ?? extendedPaperOf(b[2] - b[0], b[3] - b[1]);
    if (pp) cands.push({ box: b, ...pp, from: 'block', block: i.name, handle: i.handle, title_block: tb });
  }
  const pts = (map.texts || []).map((t) => [t[0], t[1]]);
  const texted = (c) => pts.filter((p) => inside(p, c.box)).length >= 3 || Object.keys(c.title_block || {}).length > 0;
  cands.sort((a, b) => area(b.box) - area(a.box));
  // a rectangle around several sheets of one size and scale (a boundary drawn around the set) is not a sheet itself
  const group = new Set();
  for (const c of cands) {
    const kinds = new Map();
    for (const o of cands) {
      if (o === c || !contains(c.box, o.box) || area(o.box) > 0.6 * area(c.box) || !texted(o)) continue;
      const k = `${o.paper}@${o.scale}`;
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    if ([...kinds.values()].some((n) => n >= 2)) group.add(c);
  }
  const out = [];
  const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  for (const c of cands) {
    if (group.has(c)) continue;
    // the same sheet twice (a print boundary round the frame block, a rectangle round the border): one sheet, named by
    // the frame block when there is one
    const same = out.find((o) => overlap(o.box, c.box) > 0.7 * Math.min(area(o.box), area(c.box)) && area(c.box) > 0.6 * area(o.box));
    if (same) {
      if (c.from === 'block' && same.from !== 'block') Object.assign(same, { box: c.box, paper: c.paper, scale: c.scale, extended: c.extended, from: 'block', block: c.block, handle: c.handle });
      if (Object.keys(c.title_block || {}).length && !Object.keys(same.title_block || {}).length) same.title_block = c.title_block;
      continue;
    }
    const outer = out.find((o) => contains(o.box, c.box));
    if (outer) {
      // the same sheet (its inner border, the frame block in a rectangle): the title block goes to the sheet
      if (area(c.box) > 0.6 * area(outer.box) && Object.keys(c.title_block || {}).length && !Object.keys(outer.title_block || {}).length) outer.title_block = c.title_block;
      continue;
    }
    if (!texted(c)) continue;
    out.push(c);
  }
  // a title block that is a block of its own inside the frame (the strip or corner box with attributes)
  for (const f of out) {
    if (Object.keys(f.title_block || {}).length) continue;
    const tb = (map.inserts || []).filter((i) => i.box && contains(f.box, i.box)).map((i) => titleBlock(i.attributes)).sort((x, y) => Object.keys(y).length - Object.keys(x).length)[0];
    if (tb && Object.keys(tb).length >= 2) f.title_block = tb;
  }
  return out;
}

/**
 * The map of a drawing from bridge model_map and layout_views: sheets (layouts, model-space frames), their views by
 * title with kind, floor, scale and model window, the views outside any sheet, legacy-font texts.
 */
export function describeDrawing(map, layouts = [], { name = '' } = {}) {
  const texts = (map.texts || []).map((t) => ({ at: [t[0], t[1]], h: t[2], s: String(t[3]), layer: t[4], rot: t[5] || 0, tag: t[6], style: t[7] }));
  const titleMin = 1.2 * median(texts.map((t) => t.h).filter((h) => h > 0));
  // the titles: kind found, horizontal, as tall as titles are (or the title of a view title block)
  const titles = [];
  for (const t of texts) {
    if (Math.abs(t.rot % 180) > 1) continue;
    const ti = titleOf(t.s);
    if (!ti) continue;
    if (t.h < titleMin && !(t.tag && /TITLE|TEN|NAME/i.test(t.tag))) continue;
    titles.push({ ...ti, at: t.at.map(r0), h: t.h });
  }
  const scales = texts.map((t) => ({ ...t, sc: scaleOf(t.s) })).filter((t) => t.sc);
  // the scale of a title: in it, or a scale text just under or beside it
  for (const t of titles) {
    if (t.scale) continue;
    const near = scales.filter((s) => Math.abs(s.at[1] - t.at[1]) < 3 * t.h + 1 && s.at[0] - t.at[0] > -2 * t.h && s.at[0] - t.at[0] < 40 * t.h && s.at[1] <= t.at[1] + t.h)
      .sort((a, b) => Math.hypot(a.at[0] - t.at[0], a.at[1] - t.at[1]) - Math.hypot(b.at[0] - t.at[0], b.at[1] - t.at[1]));
    if (near.length) t.scale = near[0].sc;
  }
  const frames = framesOf(map);
  // texts written in the frame blocks themselves: a number written so is the sheet's only when frames differ in it
  const blockTexts = (map.block_texts || []).map((t) => ({ at: [t[0], t[1]], h: t[2], s: String(t[3]), insert: t[4] }));
  const blockNums = {};
  for (const t of blockTexts) if (NUMBER.test(t.s.trim())) blockNums[t.s.trim()] = (blockNums[t.s.trim()] || 0) + 1;
  const used = new Set();
  const sheets = [];
  let emptyFrames = 0;
  frames.sort((a, b) => (b.box[3] - a.box[3]) || (a.box[0] - b.box[0])); // rows from the top, left to right
  for (const f of frames) {
    const b = f.box, w = b[2] - b[0], h = b[3] - b[1];
    const mine = texts.filter((t) => inside(t.at, b));
    // the drawing number: a short code like KT-01 in the right or bottom part of the frame, the tallest
    const ownBlock = blockTexts.filter((t) => inside(t.at, b) && (blockNums[t.s.trim()] ?? 0) === 1);
    const nums = [...mine, ...ownBlock].filter((t) => NUMBER.test(t.s.trim()) && t.at[0] > b[2] - 0.35 * w && t.at[1] < b[1] + 0.3 * h).sort((x, y) => y.h - x.h || (y.at[0] - y.at[1]) - (x.at[0] - x.at[1]));
    const num = f.title_block?.number ?? nums[0]?.s.trim() ?? null;
    const numAt = nums[0]?.at;
    const views = [];
    let sheetTitle = f.title_block?.name ?? null;
    const here = titles.filter((t) => inside(t.at, b) && !used.has(t));
    // a title written twice on a sheet: under the view and in the title block, the one nearer the corner names the sheet
    const corner = (t) => Math.hypot(b[2] - t.at[0], t.at[1] - b[1]);
    for (const t of here) {
      const twin = here.find((o) => o !== t && o.title === t.title && corner(o) > corner(t));
      if (twin && !numAt) {
        used.add(t);
        sheetTitle ??= t.title;
        continue;
      }
    }
    for (const t of here) {
      if (used.has(t)) continue;
      used.add(t);
      // a title next to the drawing number is the name of the sheet, not of a view
      if (numAt && Math.abs(t.at[0] - numAt[0]) < 0.25 * w && Math.abs(t.at[1] - numAt[1]) < 0.15 * h) {
        sheetTitle ??= t.title;
        continue;
      }
      views.push(t);
    }
    // titles in the title block (the strip on the right, the box in the bottom right corner) name the sheet when the
    // sheet has views titled elsewhere
    const named = splitTitleBlock(views, b);
    if (named.length) {
      sheetTitle ??= named[0].title;
      for (const t of named) views.splice(views.indexOf(t), 1);
    }
    const merged = dedupe(views);
    windowsOf(merged, f.extended ? [b[0], b[1], b[2] - 0.12 * w, b[3]] : b);
    if (!views.length && !num && !sheetTitle && !Object.keys(f.title_block || {}).length) {
      emptyFrames++; // a print boundary, a box with the proportions of a paper: not a sheet
      continue;
    }
    const counts = {};
    for (const v of views) if (v.scale) counts[v.scale] = (counts[v.scale] || 0) + 1;
    const most = Number(Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0]) || null;
    const sc = Number(String(f.title_block?.scale ?? '').match(/1\s*[:/]\s*(\d+)/)?.[1]) || most;
    if (sc && sc !== f.scale) {
      const again = paperAt(w, h, sc);
      if (again) Object.assign(f, { paper: again.paper, scale: sc, extended: again.extended });
    }
    f.known = !!sc;
    f.sheet = sheets.length;
    sheets.push({
      source: 'model frame', number: num, title: sheetTitle, paper: f.extended ? `${f.paper} extended` : f.paper, scale: sc ?? f.scale,
      window: [[r0(b[0]), r0(b[1])], [r0(b[2]), r0(b[3])]], frame: f.from === 'block' ? `block ${f.block}` : `rectangle on ${f.layer}`,
      title_block: f.title_block && Object.keys(f.title_block).length ? f.title_block : undefined,
      views: merged.map(view),
    });
  }
  // a frame whose scale nothing gives (an A3 at 1:100 and an A1 at 1:50 are the same size): the scale of the frames of
  // its size that have one
  for (const f of frames) {
    if (f.known || f.sheet === undefined) continue;
    const fw = f.box[2] - f.box[0], fh = f.box[3] - f.box[1];
    const like = frames.filter((o) => o.known && Math.abs(o.box[2] - o.box[0] - fw) < 0.01 * fw && Math.abs(o.box[3] - o.box[1] - fh) < 0.01 * fh);
    if (!like.length) continue;
    const again = paperAt(fw, fh, like[0].scale);
    if (!again) continue;
    Object.assign(sheets[f.sheet], { paper: again.extended ? `${again.paper} extended` : again.paper, scale: like[0].scale });
  }
  // the layouts: their viewports show model areas; the titles in those areas are their views
  for (const l of layouts) {
    const tb = (l.title_blocks || []).map((x) => titleBlock(x.attributes)).find((x) => Object.keys(x).length) || {};
    const sheetNames = [];
    // the paper space viewport of the layout (scale 1, showing the paper itself) is not a view
    const isPaper = (v) => Math.abs((v.scale || 0) - 1) < 1e-6 && v.paper_center && Math.abs((v.window[0][0] + v.window[1][0]) / 2 - v.paper_center[0]) < 2 && Math.abs((v.window[0][1] + v.window[1][1]) / 2 - v.paper_center[1]) < 2;
    const ports = (l.viewports || []).filter((v) => !isPaper(v)).map((v) => {
      const w = v.window, box = [Math.min(w[0][0], w[1][0]), Math.min(w[0][1], w[1][1]), Math.max(w[0][0], w[1][0]), Math.max(w[0][1], w[1][1])];
      const vs = titles.filter((t) => !used.has(t) && inside(t.at, box, 0.02 * (box[2] - box[0])));
      vs.forEach((t) => used.add(t));
      // a viewport that shows a frame drawn in model space shows its title block too
      const shown = frames.find((f) => contains([box[0] - 0.03 * (box[2] - box[0]), box[1] - 0.03 * (box[3] - box[1]), box[2] + 0.03 * (box[2] - box[0]), box[3] + 0.03 * (box[3] - box[1])], f.box) && area(f.box) > 0.5 * area(box));
      if (shown) {
        for (const t of splitTitleBlock(vs, shown.box)) {
          vs.splice(vs.indexOf(t), 1);
          sheetNames.push(t.title);
        }
      }
      const merged = dedupe(vs);
      windowsOf(merged, box);
      return { scale: v.scale || null, window: w, twisted: v.twisted || undefined, views: merged.map(view) };
    });
    const paperTitles = (l.texts || []).map(titleOf).filter(Boolean).map((t) => t.title);
    sheets.push({
      source: 'layout', layout: l.name, number: tb.number && !/^model$/i.test(tb.number) ? tb.number : tb.number ? l.name : null, title: tb.name ?? paperTitles[0] ?? sheetNames[0] ?? null, paper: l.paper || null,
      title_block: Object.keys(tb).length ? tb : undefined, viewports: ports, paper_titles: paperTitles.length ? paperTitles.slice(0, 12) : undefined,
    });
  }
  const loose = titles.filter((t) => !used.has(t));
  const legacy = { tcvn3: 0, vni: 0 };
  for (const t of texts) {
    const e = legacyEncoding(t.s);
    if (e) legacy[e]++;
  }
  const lang = { vi: texts.filter((t) => /[ĂăĐđƠơƯưẠ-ỹ]/.test(t.s)).length, zh: texts.filter((t) => /[一-鿿]/.test(t.s)).length };
  const out = {
    drawing: name || map.drawing, extents: map.extents, texts: texts.length,
    language: lang.zh > lang.vi + legacy.tcvn3 + legacy.vni && lang.zh > 5 ? 'zh' : lang.vi + legacy.tcvn3 + legacy.vni > 5 ? 'vi' : 'en',
    sheets, views_outside_sheets: loose.slice(0, 60).map(view),
  };
  if (legacy.tcvn3 || legacy.vni) {
    out.legacy_font_texts = Object.fromEntries(Object.entries(legacy).filter(([, n]) => n));
    const ls = legacyStyles(map);
    if (Object.keys(ls).length) out.legacy_font_texts.styles = ls;
  }
  if (emptyFrames) out.frames_without_content = emptyFrames;
  if (map.truncated) out.note = 'more texts than were read: the map may miss some titles';
  return out;
}

/**
 * The text styles whose texts read as a legacy encoding (style -> 'tcvn3' | 'vni'): at least 3 such texts, and most of
 * the texts of the style with letters beyond ASCII. Finds a legacy font by what is written in it, whatever the font is
 * called (an SHX font, a renamed TrueType).
 */
export function legacyStyles(map) {
  const by = new Map();
  for (const t of map.texts || []) {
    const style = t[7];
    if (!style || !/[^\x00-\x7F]/.test(String(t[3]))) continue;
    if (!by.has(style)) by.set(style, { tcvn3: 0, vni: 0, n: 0, sure: { tcvn3: 0, vni: 0 } });
    const c = by.get(style);
    c.n++;
    const e = legacyEncoding(t[3]);
    if (e) c.sure[e]++;
    // a VNI text with one weak pair ("TAÀNG") counts with the others of its style
    const k = e ?? (vniPairs(t[3]) ? 'vni' : null);
    if (k) c[k]++;
  }
  const out = {};
  for (const [style, c] of by) {
    const e = c.vni >= c.tcvn3 ? 'vni' : 'tcvn3';
    if (c[e] >= 3 && c[e] >= 0.6 * c.n && c.sure[e] >= 1) out[style] = e;
  }
  return out;
}

/** The handles of the frames and title blocks of a drawing (they are not part of any view). */
export function frameHandles(map) {
  return (map.inserts || []).filter((i) => FRAME_NAME.test(i.name || '') || Object.keys(titleBlock(i.attributes)).length >= 2).map((i) => i.handle).filter(Boolean);
}

/** Every view of a map that has a window (to fit it to what is drawn there). */
export function viewsWithWindows(out) {
  return [
    ...out.sheets.flatMap((s) => [...(s.views || []), ...(s.viewports || []).flatMap((v) => v.views)]),
    ...out.views_outside_sheets,
  ].filter((v) => v.window);
}

/**
 * The window of a view fitted to the drawing in it (extents from bridge view_extents): what is drawn in the band of its
 * title, with a margin; the band when nothing is drawn there.
 */
export function fitWindows(views, found) {
  views.forEach((v, i) => {
    const f = found?.[i];
    if (!f || !Array.isArray(f.box) || f.count < 3) {
      v.window_from = 'titles';
      return;
    }
    const [x0, y0, x1, y1] = f.box, m = 0.02 * Math.max(x1 - x0, y1 - y0);
    v.window = [[Math.round(x0 - m), Math.round(y0 - m)], [Math.round(x1 + m), Math.round(y1 + m)]];
    v.window_from = 'drawing';
  });
  return views;
}

/**
 * The titles of a sheet that stand in its title block (the strip along the right edge, the box in the bottom right
 * corner), when other titles of the sheet stand outside it: those name the sheet, the others its views.
 */
function splitTitleBlock(views, b) {
  const w = b[2] - b[0], h = b[3] - b[1];
  const zone = (t) => t.at[0] > b[2] - 0.13 * w || (t.at[0] > b[2] - 0.35 * w && t.at[1] < b[1] + 0.2 * h);
  const inZone = views.filter(zone);
  if (!inZone.length || inZone.length === views.length) return [];
  return inZone.sort((x, y) => (y.h || 0) - (x.h || 0));
}

/** Views of one sheet with the same title (written again with the scale after it): the first, with a scale if any has one. */
function dedupe(views) {
  const key = (t) => t.title.replace(/\s*(TL|TỶ LỆ|TỈ LỆ|SCALE|比例)?\s*[:.]?\s*1\s*[:/]\s*\d+\s*$/u, '').trim();
  // a title in a second language just above or below another of the same kind is the same view
  const out = [];
  for (const t of views) {
    const k = key(t), h = t.h || 1;
    const twin = out.find((o) => o.kind === t.kind && !o.second && o.title !== k && Math.abs(o.at[1] - t.at[1]) < 2.5 * Math.max(h, o.h || 1) && Math.abs(o.at[0] - t.at[0]) < 12 * Math.max(h, o.h || 1));
    if (twin) {
      twin.second = k;
      twin.scale ??= t.scale;
      twin.floor ??= t.floor;
      continue;
    }
    out.push({ ...t, title: k || t.title });
  }
  // the same title written again (in the title block, or with its scale after it): one view, the one titled in two
  // languages kept first
  const keep = [];
  for (const t of [...out].sort((x, y) => (y.second ? 1 : 0) - (x.second ? 1 : 0))) {
    const names = [t.title, t.second].filter(Boolean);
    const dup = keep.find((o) => [o.title, o.second].filter(Boolean).some((n) => names.includes(n)));
    if (dup) {
      dup.scale ??= t.scale;
      dup.floor ??= t.floor;
      continue;
    }
    keep.push(t);
  }
  return keep.sort((x, y) => out.indexOf(x) - out.indexOf(y));
}

const view = (t) => {
  const v = { kind: t.kind, title: t.second ? `${t.title} / ${t.second}` : t.title, at: t.at };
  if (t.floor) v.floor = t.floor;
  if (t.scale) v.scale = t.scale;
  if (t.window) v.window = t.window;
  if (t.legacy) v.encoding = t.legacy;
  return v;
};

/**
 * The model window of each view of a sheet: titles stand under their views, so a row of titles owns the band up to
 * the next row above, split between the titles of the row halfway between them.
 */
function windowsOf(views, b) {
  if (!views.length) return;
  const h = b[3] - b[1];
  const rows = [];
  for (const t of [...views].sort((x, y) => x.at[1] - y.at[1])) {
    const row = rows.find((r) => Math.abs(r.y - t.at[1]) < 0.12 * h);
    if (row) row.items.push(t);
    else rows.push({ y: t.at[1], items: [t] });
  }
  rows.forEach((r, i) => {
    // the lowest row reaches the bottom of the sheet: a title may stand beside its drawing, not under it
    const y0 = i === 0 ? b[1] : Math.max(b[1], r.y - 3 * Math.max(...r.items.map((t) => t.h)));
    const next = rows[i + 1];
    const y1 = next ? next.y - 3 * Math.max(...next.items.map((t) => t.h)) : b[3];
    const xs = r.items.sort((x, y) => x.at[0] - y.at[0]);
    xs.forEach((t, k) => {
      const x0 = k === 0 ? b[0] : (xs[k - 1].at[0] + t.at[0]) / 2;
      const x1 = k === xs.length - 1 ? b[2] : (t.at[0] + xs[k + 1].at[0]) / 2;
      t.window = [[r0(x0), r0(y0)], [r0(x1), r0(y1)]];
    });
  });
}
