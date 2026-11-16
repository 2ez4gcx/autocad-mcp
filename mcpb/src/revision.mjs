// Revision clouds (khoanh mây chỗ sửa đổi): the places a change touched, clouded, with the delta of the revision
// number and an optional note. The places come from the difference of a view before and after its update (bridge
// view_diff: the extents of the entities that are gone or new) or are given (a window, points, handles' extents).
import { ROLE } from './standards.mjs';

export const REV_LAYER = 'A-ANNO-REVS';

/** Boxes [x0, y0, x1, y1] that lie within gap of each other merged; at most max regions (the gap grows until). */
export function clusterBoxes(boxes, gap, max = 12) {
  let g = gap;
  let out = boxes.map((b) => [...b]);
  for (let pass = 0; pass < 12; pass++) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length && !merged; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const a = out[i], b = out[j];
          if (a[0] - g <= b[2] && b[0] - g <= a[2] && a[1] - g <= b[3] && b[1] - g <= a[3]) {
            out[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            out.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    if (out.length <= max) break;
    g *= 2;
  }
  return out;
}

/**
 * The cloud around a box (drawing units): a closed polyline of arcs bulging outward, about chord long each, the box
 * grown by margin; the delta (a triangle with the revision number) at its top right corner, and the note beside it.
 * scale: the plot scale (paper mm x scale).
 */
export function cloudEntities(box, { no = 1, note = '', scale = 100, layer = REV_LAYER, margin = null } = {}) {
  const m = margin ?? 3 * scale, chord = 8 * scale;
  const x0 = box[0] - m, y0 = box[1] - m, x1 = box[2] + m, y1 = box[3] + m;
  // counter-clockwise: a positive bulge bows to the right of the way, outward
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pts = [], bulges = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(2, Math.round(L / chord));
    for (let k = 0; k < n; k++) {
      pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n].map((v) => Math.round(v * 10) / 10));
      bulges.push(0.45);
    }
  }
  const ents = [{ type: 'polyline', points: pts, bulges, closed: true, layer }];
  // the delta: an equilateral triangle 7 mm on paper, its number inside
  const s = 7 * scale, h = (s * Math.sqrt(3)) / 2, cx = x1, cy = y1 + h / 3 + 1.5 * scale;
  ents.push({ type: 'polyline', points: [[cx - s / 2, cy - h / 3], [cx + s / 2, cy - h / 3], [cx, cy + (2 * h) / 3]], closed: true, layer });
  ents.push({ type: 'text', text: String(no), at: [cx, cy], height: 2.5 * scale, align: 'middle_center', layer });
  if (note) ents.push({ type: 'text', text: note, at: [cx + s / 2 + 2 * scale, cy], height: 2.5 * scale, align: 'middle_left', layer });
  return ents;
}

/**
 * The regions to cloud from a view_diff: the extents of what is gone and what is new, merged where they lie close
 * (gap: paper mm x scale). A large line or polyline that changed (the outline of all the walls of a floor, drawn as one)
 * counts only where its vertices moved: each vertex of the old one that the new one has not, and the other way; a
 * large hatch that changed goes with its outline.
 */
export function regionsOfDiff(diff, { scale = 100, max = 12, fine = false } = {}) {
  const items = (list) => (list || []).map((x) => (Array.isArray(x) ? { b: x } : x)).filter((x) => Array.isArray(x.b) && x.b.length === 4 && x.b.every(Number.isFinite));
  const removed = items(diff.removed), added = items(diff.added);
  const all = [...removed, ...added];
  if (!all.length) return [];
  const ext = [Math.min(...all.map((x) => x.b[0])), Math.min(...all.map((x) => x.b[1])), Math.max(...all.map((x) => x.b[2])), Math.max(...all.map((x) => x.b[3]))];
  // nothing of the view is as it was (a schedule drawn again row by row): one cloud around what it is now
  if (diff.same === 0 && added.length) {
    return [[Math.min(...added.map((x) => x.b[0])), Math.min(...added.map((x) => x.b[1])), Math.max(...added.map((x) => x.b[2])), Math.max(...added.map((x) => x.b[3]))]];
  }
  // fine (two versions of a drawing): every line and outline vertex by vertex; else the large ones (a view's outline)
  const shaped = (x) => Array.isArray(x.p) || Array.isArray(x.q);
  const big = (x) => (fine && shaped(x)) || (shaped(x) && Math.hypot(x.b[2] - x.b[0], x.b[3] - x.b[1]) > Math.max(30 * scale, 0.25 * Math.hypot(ext[2] - ext[0], ext[3] - ext[1])));
  const boxes = [];
  const flat = (p) => Array.from({ length: Math.floor(p.length / 2) }, (_, i) => [p[2 * i], p[2 * i + 1]]);
  // each outline as its vertices; a closed one (a closed polyline, the loops of a hatch) also runs from its last vertex
  // back to its first; a line of two vertices is the same segment both ways
  const pts = (list) => list.filter(big).flatMap((x) => [
    ...(Array.isArray(x.p) ? [{ l: x.l, v: flat(x.p), closed: !!x.c || x.p.length === 4 }] : []),
    ...(Array.isArray(x.q) ? x.q.map((loop) => ({ l: x.l, v: flat(loop), closed: true })) : []),
  ]);
  const oldP = pts(removed), newP = pts(added);
  // the vertices of a side by layer and 4-unit cell, to find a vertex within 2 units
  const index = (sets) => {
    const m = new Map();
    for (const s of sets) for (const r of s.v) {
      const k = `${s.l}|${Math.floor(r[0] / 4)}|${Math.floor(r[1] / 4)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const idx = new Map();
  const has = (sets, l, q) => {
    if (!idx.has(sets)) idx.set(sets, index(sets));
    const m = idx.get(sets), cx = Math.floor(q[0] / 4), cy = Math.floor(q[1] / 4);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const r of m.get(`${l}|${cx + i}|${cy + j}`) || []) if (Math.abs(r[0] - q[0]) <= 2 && Math.abs(r[1] - q[1]) <= 2) return true;
    }
    return false;
  };
  // a vertex the other side has not; two such vertices in a row: the segment between them moved
  const moved = (sets, others) => {
    for (const s of sets) {
      const ch = s.v.map((q) => !has(others, s.l, q));
      s.v.forEach((q, i) => {
        if (!ch[i]) return;
        boxes.push([q[0], q[1], q[0], q[1]]);
        if (i === s.v.length - 1 && !s.closed) return;
        const j = (i + 1) % s.v.length, r = s.v[j];
        if (ch[j] && j !== i) boxes.push([Math.min(q[0], r[0]), Math.min(q[1], r[1]), Math.max(q[0], r[0]), Math.max(q[1], r[1])]);
      });
    }
  };
  moved(oldP, newP);
  moved(newP, oldP);
  // a dimension that changed is clouded at its text (its value), not along its whole length
  for (const x of all) if (!big(x)) boxes.push(Array.isArray(x.tp) ? [x.tp[0], x.tp[1], x.tp[0], x.tp[1]] : x.b);
  if (!boxes.length) return [];
  return clusterBoxes(boxes, 5 * scale, max);
}

/** The part of box a [x0, y0, x1, y1] inside box w, or null when they do not meet. */
export function clipBox(a, w) {
  const b = [Math.max(a[0], w[0]), Math.max(a[1], w[1]), Math.min(a[2], w[2]), Math.min(a[3], w[3])];
  return b[0] <= b[2] && b[1] <= b[3] ? b : null;
}

export { ROLE };
