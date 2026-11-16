// Views: what a drawing tool draws is one view of the drawing. Its entities carry the id of the view (the bridge
// tags them), and the drawing keeps a record of every view (its tool, where it stands, the plan it was drawn from,
// its arguments) and the plan description itself. So a tool called again with update: true replaces its earlier view
// where it stands - the sheets that show it keep showing it - and a drawing reopened in another session can still be
// changed: the plan is read back from it, the views drawn from an older plan are listed as stale.
import { createHash } from 'node:crypto';

/** The tools whose drawings are views (draw_entities is free drawing: not one). */
export const VIEW_TOOLS = new Set([
  'draw_plan', 'draw_elevation', 'draw_section', 'draw_roof_plan', 'draw_door_schedule', 'draw_stair_detail', 'draw_finish_quantities',
  'draw_structure_plan', 'draw_structure_detail', 'draw_beam_schedule', 'draw_structure_notes', 'structural_calc', 'draw_quantity_schedule', 'rebar_schedule',
  'draw_furniture_plan', 'draw_floor_finish_plan', 'draw_wall_finish_plan', 'draw_ceiling_plan', 'draw_interior_elevation', 'draw_joinery_detail', 'material_schedule',
  'draw_electrical_plan', 'draw_electrical_diagram', 'electrical_calc', 'draw_plumbing_plan', 'draw_plumbing_diagram', 'plumbing_calc', 'draw_mep_notes',
  'draw_cover_sheet', 'draw_drawing_list',
]);
/** Tools that draw nothing but work on the plan of the drawing: they take it from the drawing as the view tools do. */
export const PLAN_TOOLS = new Set(['verify_quantities']);

// the arguments that say which view of a tool a call is (the floor of a plan, the mark of a section, the room and
// walls of an interior elevation...): two calls that agree on them draw the same view
const IDENTITY = ['floor', 'mark', 'sides', 'room', 'walls', 'kind', 'label', 'name', 'item', 'mode', 'focus', 'system', 'set', 'stair'];
// what a call says about this one run, not about the view
const NOT_KEPT = new Set(['plan', 'update', 'dry_run', 'at', 'csv_path', 'xlsx_path']);
// the building of draw_plan is kept once, as the plan of the drawing: its view keeps how it was drawn
const BUILDING = new Set(['walls', 'openings', 'columns', 'grid_columns', 'grids', 'rooms', 'stairs', 'levels', 'sections', 'north', 'balconies', 'floors', 'entities', 'heights', 'roofs',
  'wall_thickness', 'wall_material']);

export const hashOf = (text) => createHash('sha1').update(String(text)).digest('hex').slice(0, 12);

const plain = (v) => ['string', 'number', 'boolean'].includes(typeof v);

/** The part of the arguments that names the view: "floor=2,walls=A+B". */
export function viewKey(args = {}) {
  const parts = [];
  for (const k of IDENTITY) {
    const v = args?.[k];
    if (v === undefined || v === null || v === '') continue;
    if (plain(v)) parts.push(`${k}=${v}`);
    else if (Array.isArray(v) && v.length && v.every(plain)) parts.push(`${k}=${v.join('+')}`);
  }
  return parts.join(',');
}

/** The id of the view of a call: the tool and what names the view, 180 characters at most (the tag of an entity). */
export function viewId(tool, args = {}) {
  const key = viewKey(args);
  const id = key ? `${tool}:${key}` : tool;
  return id.length <= 180 ? id : `${id.slice(0, 160)}~${hashOf(id)}`;
}

/** An id not yet taken: the base, else base#2, base#3... (a view drawn again without update is a view of its own). */
export function freeId(base, taken) {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let k = 2; ; k++) if (!used.has(`${base}#${k}`)) return `${base}#${k}`;
}

/** The arguments kept with a view: what a later session needs to draw it again (the plan apart). */
export function keptArgs(tool, args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || NOT_KEPT.has(k)) continue;
    if (tool === 'draw_plan' && BUILDING.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** The plan of a draw_plan call as it is kept in the drawing. */
export function keptPlan(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null && k !== 'update' && k !== 'dry_run') out[k] = v;
  return out;
}

/**
 * What view_list of the bridge returned, as views: [{id, base, tool, spots, plan, args, extra, time, entities, bounds}]
 * (entities: how many still carry the id; a record whose entities are all gone is left out), the ids in use and the
 * hash of the plan kept in the drawing.
 */
export function parseViews(r) {
  const live = r?.live || {};
  const views = [];
  for (const rec of r?.views || []) {
    let m;
    try {
      m = JSON.parse(rec.meta);
    } catch {
      continue;
    }
    if (!m || typeof m.id !== 'string') continue;
    const l = live[m.id];
    views.push({
      id: m.id, base: m.key ?? m.id, tool: m.tool, spots: Array.isArray(m.spots) ? m.spots : [], plan: m.plan ?? null, args: m.args ?? {}, extra: m.extra ?? {}, time: m.time ?? '',
      entities: l?.entities ?? 0, bounds: l?.bounds ?? null,
    });
  }
  return { views, ids: [...new Set([...views.map((v) => v.id), ...Object.keys(live)])], planHash: r?.values?.plan_hash ?? null };
}

/** The view an update replaces: the one named, else the newest live view of the tool with the same key. */
export function viewToReplace(views, tool, base, update) {
  if (typeof update === 'string') {
    const v = views.find((x) => x.id === update);
    if (!v) throw new Error(`${tool}: no view "${update}" in this drawing (list_views names them)`);
    if (v.tool !== tool) throw new Error(`${tool}: the view "${update}" was drawn by ${v.tool}: update it with that tool`);
    return v;
  }
  const mine = views.filter((x) => x.tool === tool && x.base === base && x.entities > 0);
  return mine.sort((a, b) => String(b.time).localeCompare(String(a.time)))[0] ?? null;
}

/** Two bounds {min, max} as one. */
export function joinBounds(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1])] };
}

/** Whether a view reaches past the one it replaced (more than a hundredth of its diagonal): sheets may crop it. */
export function outgrew(now, before) {
  if (!now || !before) return false;
  const tol = Math.hypot(before.max[0] - before.min[0], before.max[1] - before.min[1]) / 100;
  return now.min[0] < before.min[0] - tol || now.min[1] < before.min[1] - tol || now.max[0] > before.max[0] + tol || now.max[1] > before.max[1] + tol;
}
