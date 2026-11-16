/**
 * AutoCAD MCP server (Node.js), packaged as a Claude Desktop Extension (.mcpb).
 *
 * Claude <-(stdio/MCP)-> this file <-(TCP 127.0.0.1:9877, one-line JSON)-> "ACAD MCP Bridge" .NET add-in in AutoCAD.
 *
 * Units: drawing units (mm in a metric drawing), areas in m², angles in degrees counter-clockwise from +X.
 * Notes for running inside Claude Desktop (built-in Node), same as SketchUp MCP:
 *  - cwd is NOT the extension folder -> every path is resolved from import.meta.url.
 *  - do nothing at startup, only connect to AutoCAD when a tool is called.
 *  - every socket/promise error is caught (an uncaught error ends the server); stdout is the MCP channel -> log to stderr.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod';
import { buildBuilding, buildElevation, buildingAssumed, buildSection, floorsOf, HEIGHT_DEFAULTS } from './elevation.mjs';
import { buildPlan, planAssumptions, PlanError } from './plan.mjs';
import { capsWidth, coverSheet, dimStyleName, drawingList, FIELD, fitScale, layerSpecs, layerStyles, LAYERS, PAPERS, ROLE, styleParams, TEXT_STYLE, setDrawingLanguage, titleBlock, viewStyles, viewTitle } from './standards.mjs';
import { beamDetail, beamSchedule, footingDetail, framingPlan, rcSection, rebarSchedule, structureNotes } from './structure.mjs';
import { symbolDef } from './symbols.mjs';
import { doorSchedule } from './doors.mjs';
import { roofPlan } from './roof.mjs';
import { stairDetail } from './stair.mjs';
import { beamPrefix, calcCsv, calcSheet, CONCRETE, STEEL, structuralCalc } from './calc.mjs';
import { boqCsv, boqSheets } from './boq.mjs';
import { ruleSet } from './rules.mjs';
import { parseCtb, planCsv, planLayers, readMappingCsv, readStandardCsv } from './layers.mjs';
import { planAreas, readPlan } from './readplan.mjs';
import { cloudEntities, clusterBoxes, clipBox, REV_LAYER, regionsOfDiff } from './revision.mjs';
import { describeDrawing, fitWindows, frameHandles, legacyStyles, viewsWithWindows } from './describe.mjs';
import { TCVN3, VNI } from './vnfont.mjs';
import { checkAreas, checkDims, listTexts, REGISTER_COLUMNS, registerRows, toCsv } from './review.mjs';
import { xlsx as xlsxBook } from './xlsx.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { freeId, hashOf, joinBounds, keptArgs, keptPlan, outgrew, parseViews, PLAN_TOOLS, VIEW_TOOLS, viewId, viewToReplace } from './views.mjs';
import { structurePrisms } from './solids.mjs';
import { finishCsv, finishQuantities, finishSheet } from './archboq.mjs';
import * as SURF from './surfaces.mjs';
import { finishWorkbook, kcWorkbook } from './workbooks.mjs';
import {
  ceilingPlan, centroid, cleanPoly, elevationKey, entBox, entityBounds, floorFinishPlan, footprints, freePoint, FURNITURE_DOC, furniturePlan, generalNotes, inside, notesBlock, shiftEntity, wallFinishPlan,
  interiorElevation, joineryDetail, labelBox, labelSize, materialSchedule, polyArea, resolveFinish, resolveItems, shiftSpec, textWidth,
} from './interior.mjs';
import { LIGHT_BLOCKS } from './symbols.mjs';
import { LUX_TASKS, lightingCalc, luxTable } from './lux.mjs';
import { calcSheetOf, defaultFixtures, legend as mepLegend, maskTexts, signOff, tablesCsv, wallBoxes } from './mep.mjs';
import {
  DEVICES, electricalBasis, electricalDesign, electricalNotes, electricalPlan, electricalQuantities, electricalTables, riserDiagram, singleLineDiagram,
} from './electrical.mjs';
import { FIXTURES, plumbingBasis, plumbingDesign, plumbingNotes, plumbingPlan, plumbingQuantities, plumbingRisers, plumbingTables, septicDetail } from './plumbing.mjs';
import { electricalWorkbook, plumbingWorkbook } from './mepbooks.mjs';

/* global __AUTOCAD_MCP_VERSION__ */
const VERSION = typeof __AUTOCAD_MCP_VERSION__ !== 'undefined' ? __AUTOCAD_MCP_VERSION__ : '0.0.0-dev';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Commands that do not change the drawing (safe to retry after a timeout), and commands without an Undo step.
const READ_ONLY_CMDS = new Set(['ping', 'drawing_info', 'list_layers', 'list_blocks', 'query_entities', 'selection_info',
  'quantity_takeoff', 'check_drawing', 'screenshot', 'view_image', 'image_info', 'select_entities', 'view_list', 'view_diff',
  'layer_survey', 'plan_geometry', 'drawing_diff', 'model_map', 'layout_views', 'view_extents', 'measure_model', 'annotation_data',
  'text_list']);
const NO_UNDO_CMDS = new Set(['undo', 'save_drawing', 'open_drawing', 'new_drawing', 'export_pdf']);

function afterSendHint(cmd) {
  if (READ_ONLY_CMDS.has(cmd)) {
    return ' This command does not modify the drawing and can be retried; for large drawings increase the timeout first ' +
      '(Claude Desktop: Settings > Extensions > AutoCAD MCP > Configure; other clients: AUTOCAD_MCP_TIMEOUT).';
  }
  if (NO_UNDO_CMDS.has(cmd)) {
    return ` Command '${cmd}' MAY HAVE ALREADY RUN (AutoCAD keeps working on it). Do NOT retry right away and do NOT use undo: ` +
      'wait, then check (ping, drawing_info, or whether the file exists).';
  }
  return ` Command '${cmd}' MAY HAVE ALREADY RUN (AutoCAD keeps working on it). Do NOT retry right away: wait, then call ` +
    'query_entities or screenshot to check; only re-run if it clearly did not apply, and use undo if it was duplicated.';
}

function compareVersions(a, b) {
  const pa = String(a).match(/^(\d+)\.(\d+)\.(\d+)/);
  const pb = String(b).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return d;
  }
  return 0;
}

function envValue(key) {
  const v = process.env[key];
  if (v === undefined) return undefined;
  const s = v.trim();
  return s === '' || /^\$\{[^}]*\}$/.test(s) ? undefined : s;
}

function envNumber(key, def, min, max) {
  const raw = envValue(key);
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

const HOST = envValue('AUTOCAD_MCP_HOST') ?? '127.0.0.1';
const PORT = Math.round(envNumber('AUTOCAD_MCP_PORT', 9877, 1, 65535));
const TIMEOUT = envNumber('AUTOCAD_MCP_TIMEOUT', 120, 1, 3600);
const CONNECT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

let nextId = 1;

class AcadError extends Error {}

function log(msg) {
  process.stderr.write(`[autocad-mcp] ${msg}\n`);
}

// The bridge serves one client at a time: commands are queued so each timeout starts when its turn comes.
let bridgeTail = Promise.resolve();
function exclusive(fn) {
  const run = bridgeTail.then(fn, fn);
  bridgeTail = run.then(() => {}, () => {});
  return run;
}

function call(cmd, params = {}, label = cmd) {
  return exclusive(() => sendNow(cmd, params, label));
}

/**
 * Block inserts made by the engines (symbols, lights, furniture, doors) carry their definition (def) or name one of
 * symbols.mjs: those missing from the drawing are defined first (one define_blocks), then the inserts go without def
 * and box (the box only places labels here).
 */
async function sendNow(cmd, params = {}, label = cmd) {
  const ctx = viewStore.getStore();
  if (!ctx || !VIEW_TOOLS.has(ctx.tool) || !(cmd === 'draw_plan' || cmd === 'draw_entities') || params.rooms_only) return sendDraw(cmd, params, label);
  // the first thing a view tool draws takes the old view away (the same Undo step) and keeps the plan in the drawing;
  // everything it draws carries the id of its view, whose record follows the places taken so far
  const first = !ctx.sent;
  ctx.sent = true;
  const meta = { id: ctx.id, tool: ctx.tool, key: ctx.base, spots: ctx.spots, plan: ctx.planHash ?? undefined, args: ctx.args, extra: ctx.extra, time: new Date().toISOString() };
  const store = first && ctx.planJson && ctx.planHash !== ctx.storedHash ? { plan: ctx.planJson, plan_hash: ctx.planHash } : undefined;
  const r = await sendDraw(cmd, { ...params, view: { id: ctx.id, erase: first && !!ctx.old, meta: JSON.stringify(meta), ...(store ? { store } : {}) } }, label);
  if (r?.view?.erased !== undefined) {
    ctx.erased = r.view.erased;
    ctx.locked = r.view.locked ?? 0;
    ctx.erasedBounds = r.view.erased_bounds ?? null;
  }
  if (r?.bounds) ctx.bounds = joinBounds(ctx.bounds, r.bounds);
  return r;
}

async function sendDraw(cmd, params = {}, label = cmd) {
  if (cmd === 'define_blocks' || !Array.isArray(params.entities)) return send(cmd, params, label);
  const defs = new Map();
  let any = false;
  const need = (name, def) => {
    if (defs.has(name)) return;
    const d = def ?? symbolDef(name);
    if (d) defs.set(name, d);
  };
  const entities = params.entities.map((e) => {
    if (e && e.type === 'table' && Array.isArray(e.rows)) {
      // symbol cells {block, def?} of a schedule
      if (!e.rows.some((r) => Array.isArray(r) && r.some((c) => c && typeof c === 'object' && c.block))) return e;
      any = true;
      return {
        ...e, rows: e.rows.map((r) => (Array.isArray(r) ? r.map((c) => {
          if (!c || typeof c !== 'object' || !c.block) return c;
          need(c.block, c.def);
          return { block: c.block };
        }) : r)),
      };
    }
    if (e && (e.type === 'leader' || e.type === 'mleader') && e.block) {
      need(e.block, e.def);
      if (e.def === undefined) return e;
      any = true;
      const { def, ...rest } = e;
      return rest;
    }
    if (!e || (e.type !== 'block' && e.type !== 'insert') || !e.name) return e;
    need(e.name, e.def);
    if (e.def === undefined && e.box === undefined) return e;
    any = true;
    const { def, box, ...rest } = e;
    return rest;
  });
  if (defs.size) {
    const styles = withStyles({ language: params.language }).layer_styles;
    const textStyle = { ...styleParams({ scale: 100 }).text_style, set_current: false };
    await send('define_blocks', {
      blocks: [...defs.values()].map((d) => ({ ...d, layer_styles: styles })), styles: { text_style: textStyle },
    }, `${label} (blocks)`);
  }
  return send(cmd, any ? { ...params, entities } : params, label);
}

function send(cmd, params = {}, label = cmd) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  clean._timeout = TIMEOUT;
  const data = JSON.stringify({ id: nextId++, cmd, params: clean }) + '\n';

  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let connected = false;
    let sent = false;
    let settled = false;
    const sock = net.createConnection({ host: HOST, port: PORT });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const connectTimer = setTimeout(() => {
      finish(new AcadError(`Cannot connect to AutoCAD at ${HOST}:${PORT} (connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s).`));
    }, CONNECT_TIMEOUT_MS);

    sock.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      sock.setTimeout((TIMEOUT + 5) * 1000);
      sock.write(data, 'utf8');
      sent = true;
    });

    sock.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_RESPONSE_BYTES) {
        finish(new AcadError(`Response from AutoCAD is too large (> ${MAX_RESPONSE_BYTES / 1024 / 1024} MB).${afterSendHint(label)}`));
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0x0a)) parseResponse();
    });

    sock.on('end', parseResponse);

    sock.on('timeout', () => {
      finish(new AcadError(`AutoCAD did not respond within ${Math.round(TIMEOUT)}s (command '${label}').${afterSendHint(label)}`));
    });

    sock.on('error', (e) => {
      if (!connected && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EADDRNOTAVAIL')) {
        finish(new AcadError(
          `Cannot connect to AutoCAD at ${HOST}:${PORT}. If AutoCAD was just started or is opening a drawing, the bridge listens only ` +
          'once AutoCAD has finished loading (1-2 minutes with a large drawing): wait and retry. Otherwise open AutoCAD (full version ' +
          '2021-2024) and type MCPSTATUS in its command line (MCPSTART starts the bridge). If the command is unknown, the bridge is not ' +
          'installed: run install_autocad_bridge, then restart AutoCAD.',
        ));
      } else {
        finish(new AcadError(`AutoCAD connection error (${e.code || e.name}): ${e.message}.${sent ? afterSendHint(label) : ''}`));
      }
    });

    sock.on('close', () => {
      if (!settled) parseResponse();
    });

    function parseResponse() {
      if (settled) return;
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          finish(new AcadError(`AutoCAD closed the connection without replying.${sent ? afterSendHint(label) : ''}`));
          return;
        }
        const nl = buf.indexOf(0x0a);
        if (nl < 0 && !sock.readableEnded && !sock.destroyed) return;
        let resp;
        try {
          resp = JSON.parse(buf.subarray(0, nl < 0 ? buf.length : nl).toString('utf8'));
        } catch (e) {
          finish(new AcadError(`Invalid JSON response from AutoCAD: ${e.message}.${afterSendHint(label)}`));
          return;
        }
        if (!resp || !resp.ok) {
          const err = resp && resp.error;
          let msg = err == null || err === '' ? 'Unknown error from AutoCAD' : typeof err === 'string' ? err : JSON.stringify(err);
          if (/Unsupported command/.test(msg)) {
            msg += ` The bridge in AutoCAD may be older than MCP server v${VERSION}: run install_autocad_bridge, then restart AutoCAD.`;
          }
          finish(new AcadError(msg));
          return;
        }
        finish(null, resp.result);
      } catch (e) {
        finish(new AcadError(`Invalid response from AutoCAD: ${e && e.message}`));
      }
    }
  });
}

// ---------------------------------------------------------------- tool registration helpers
const server = new McpServer(
  { name: 'autocad', version: VERSION },
  {
    instructions: [
      'Controls the drawing open in AutoCAD through the "ACAD MCP Bridge" add-in (127.0.0.1). Working rules:',
      '0. Ask before you assume: before drawing, list for the user what the request does not say or what cannot be read (dimensions, ' +
        'heights, roof, materials and finishes, furniture, structural sizes and bars...) with the value you would assume for each, and ' +
        'draw only after they confirm or change them. draw_plan, draw_elevation, draw_section, draw_structure_detail and the interior ' +
        'tools (draw_furniture_plan, draw_floor_finish_plan, draw_ceiling_plan, draw_interior_elevation, draw_joinery_detail) take ' +
        'dry_run=true: they return the defaults they would apply (assumed) without drawing. After drawing, tell the user the assumed ' +
        'list of each result.',
      '1. Units: drawing units (mm in a metric drawing: check drawing_info.units), areas m², angles degrees counter-clockwise from +X, Y up, points [x,y].',
      '2. Start with drawing_info (and list_layers). On a connection error call ping; if the bridge is missing call install_autocad_bridge.',
      '2b. Language: the drawings are Vietnamese by default (decimal comma, TCVN titles and codes). For a set in English call setup_layers with language "en" once (the session then draws in English) or pass language "en" to each tool: titles, notes, legends, tables, codes (DB-1/MDB boards, AC/WH circuits, CW/HW/SP/WP pipes, B2./GB. beams, F1 footings) and decimal points follow. Names the user gives (rooms, floors, sheet titles) are written as given: name the rooms in the language of the set (English names such as BEDROOM, KITCHEN, BATHROOM are recognised as well as Vietnamese ones).',
      '3. Drawing from an image or a 3D model: read every printed dimension first (view_image with grid/crop zooms in), pick the plot scale, ' +
        'setup_layers + setup_styles, attach_image as a faded underlay calibrated on a known dimension, draw_plan for walls/openings/columns/' +
        'grids/stairs/rooms/dimensions, draw_entities for the rest (furniture, fixtures, hatches, notes, elevations), then screenshot and compare ' +
        'with the source, fix, check_drawing, create_layout + export_pdf. Elevations and sections: draw_elevation / draw_section from ' +
        'the same plan (heights, roofs). Structural details: draw_structure_detail + rebar_schedule (sizes and bars from the engineer). ' +
        'Interior design: draw_furniture_plan (layout plan with coded furniture/joinery and elevation keys), draw_floor_finish_plan, ' +
        'draw_ceiling_plan, draw_interior_elevation (each wall of a room), draw_joinery_detail (kitchen, wardrobe, display casework), material_schedule, ' +
        'lighting_calc (illuminance of the ceiling plan lights per room against TCVN 7114-1); ' +
        'finishes default by kind of room (the results list them as assumed). Material codes as in SketchUp MCP: FL floor, SK skirting, ' +
        'WL wall, CL ceiling, JN joinery, FN furniture, SN sanitary, EQ equipment, LT lighting; one code = one specification.',
      '4. Layers: keep a layer scheme the drawing already has (pass its layer names); otherwise the standard set (A-WALL, A-DOOR, A-GLAZ, ' +
        'S-GRID, A-ANNO-DIMS...). Every entity gets a layer; never layer 0 or Defpoints; colors/linetypes stay ByLayer.',
      '4b. Drafting conventions: a wall is always its two faces at the real thickness (draw_plan), never one line made thick with a ' +
        'polyline width or lineweight; line weight comes from the layer. Openings cut the wall; dimensions use the dimension style.',
      '5. Every edit is one Undo step. If a result is wrong, undo right away and redo with corrected values; do not stack fixes.',
      '6. Handles come from tool results and stay valid while the drawing is open; never guess them.',
      '7. Prefer the dedicated tools; run_lisp only when none can do the job.',
      '8. A timed-out edit may already have run: check before repeating.',
      '9. Rooms: give each room a point inside; draw_plan measures its area from the walls (never type areas). quantity_takeoff and check_drawing report QS and QA.',
      '10. Changing a drawing these tools made (also one reopened later): do not draw it again beside the old one. list_views names its views and, with plan: true, returns the plan description the drawing keeps; change that description and call draw_plan with update: true, then call each tool it lists under stale_views again with update: true (and the arguments list_views shows): every view is replaced where it stands, so its sheet keeps showing it; export the sheets again. A drawing these tools did not make has no views: edit it entity by entity (query_entities, transform_entities, set_properties, delete_entities, draw_entities).',
    ].join('\n'),
  },
);

const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const EDIT_IDEMPOTENT = { ...EDIT, idempotentHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function text(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] };
}

function bridgeTool(name, description, inputSchema, annotations, prep = (a) => a) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => text(await call(name, prep(args))));
}

const opt = (schema) => schema.nullish();

/** Whether acad.exe runs on this machine (to tell a starting AutoCAD from a closed one). */
function acadRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq acad.exe', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(!err && /acad\.exe/i.test(String(out))));
  });
}

// the heights a plan description is read for (draw_elevation, draw_section, the interior tools)
const HEIGHT_KEYS = [...Object.keys(HEIGHT_DEFAULTS), 'beam', 'foundation', 'walls_to_roof'];
const HEIGHT_HINTS = {
  ceiling: 'top is floor to floor; the ceiling of a room is rooms[].ceiling.level of the interior tools',
  floor_to_floor: 'top', storey: 'top', height: 'top', sill: 'window_sill', head: 'door_head or window_head', base: 'ground',
};
/** Warnings for keys of heights that no tool reads (a misspelt key is otherwise silently ignored). */
function heightWarnings(h, where = 'heights') {
  if (!h || typeof h !== 'object' || Array.isArray(h)) return [];
  return Object.keys(h).filter((k) => !HEIGHT_KEYS.includes(k))
    .map((k) => `${where}.${k} is not read (keys: ${HEIGHT_KEYS.join(', ')}): ignored${HEIGHT_HINTS[k] ? `; ${HEIGHT_HINTS[k]}` : ''}`);
}

/**
 * The styles of a drawing request at a scale. LTSCALE is set only on a drawing with nothing in model space yet, or when
 * asked (ltscale: a number, or 'set'): views drawn at other scales size their dashes against the LTSCALE they were
 * drawn with, so changing it later breaks them.
 */
function stylesAt(scale, info, ltscale = 'auto') {
  const st = styleParams({ scale });
  if (typeof ltscale === 'number') st.ltscale = ltscale;
  else if (ltscale === 'keep' || (ltscale === 'auto' && (info?.model_space_entities ?? 0) > 0)) delete st.ltscale;
  return st;
}

// ---------------------------------------------------------------- views: replace what a tool drew, where it stands
// The call of a drawing tool runs in a view context: what it draws carries the id of its view, the places it takes
// are remembered, and with update: true the earlier view goes (in the Undo step of the first thing drawn) and the new
// one takes its places. The plan a view was drawn from and the plan of the drawing are kept in the drawing itself.
const viewStore = new AsyncLocalStorage();
const UpdateArg = opt(z.union([z.boolean(), z.string()])).describe(
  'true: replace the view this tool drew earlier in this drawing (the same floor, mark, room...) where it stands, so the ' +
  'sheets that show it keep showing it, instead of drawing a new one beside it; or the id of the view to replace ' +
  '(list_views). The result names the views still drawn from an older plan (stale_views): update them too');
const RevisionArg = opt(z.union([z.boolean(), z.number(), z.object({ no: opt(z.union([z.number(), z.string()])), note: opt(z.string()) })])).describe(
  'With update: cloud what the update changed (khoanh mây chỗ sửa đổi): the entities gone or new against the view as it ' +
  'was, grouped into regions, each clouded on A-ANNO-REVS with the delta of the revision number. A number, or {no, note} ' +
  '(note beside the delta, e.g. "Dời tường WC"); the clouds of one revision are one view (revision:<no>), kept when other ' +
  'views are updated');

/** The revision of a call ({no, note}) or null. */
const revisionOf = (r) => (r === undefined || r === null || r === false ? null : typeof r === 'object' ? { no: r.no ?? 1, note: r.note ?? '' } : { no: r === true ? 1 : r, note: '' });

/** Clouds around regions, drawn as the view revision:<no> (added to what that revision already has). */
async function drawClouds(regions, { no, note, scale }, send = call) {
  const ents = [];
  regions.forEach((b, i) => ents.push(...cloudEntities(b, { no, note: i === 0 ? note : '', scale })));
  if (!ents.length) return null;
  const id = `revision:${no}`;
  // a later call of the same revision without a note keeps the note the revision was given
  if (!note) {
    try {
      const known = parseViews(await send('view_list', {})).views.find((v) => v.id === id);
      note = known?.args?.note ?? '';
    } catch {
      // no views kept: no note to keep
    }
  }
  const meta = JSON.stringify({ id, tool: 'revision_cloud', key: id, spots: [], args: { no, note }, extra: {}, time: new Date().toISOString() });
  const r = await send('draw_entities', withStyles({ entities: ents, view: { id, erase: false, meta } }));
  return { id, clouds: regions.length, bounds: r?.bounds };
}

// the revision of an edit made entity by entity on a drawing (transform, properties, delete, draw, stretch, text)
const EditRevisionArg = opt(z.union([z.number(), z.string(), z.object({ no: opt(z.union([z.number(), z.string()])), note: opt(z.string()) })])).describe(
  'Cloud what this edit changed (khoanh mây chỗ sửa đổi) on A-ANNO-REVS with the delta of the revision: a number, or ' +
  '{no, note} (note beside the delta). The clouds of one revision are one view (revision:<no>)');
const EditScaleArg = z.number().positive().default(100).describe('Plot scale of the drawing, for the size of the clouds');
const editRevisionOf = (r) => (r === undefined || r === null || r === false || r === '' ? null : typeof r === 'object' ? { no: r.no ?? 1, note: r.note ?? '' } : { no: r, note: '' });

/** The extents [x0, y0, x1, y1] of entities of model space, by handle (those that have extents). */
async function boxesOf(handles, send = call) {
  if (!handles?.length) return [];
  const out = [];
  // detail: the extents of every kind of entity (without it only blocks and hatches carry them)
  for (let i = 0; i < handles.length; i += 2000) {
    const part = handles.slice(i, i + 2000);
    const q = await send('query_entities', { handles: part, limit: part.length, detail: true });
    for (const e of q.entities || []) if (e.bounds && e.space !== 'paper') out.push([e.bounds.min[0], e.bounds.min[1], e.bounds.max[0], e.bounds.max[1]]);
  }
  return out;
}

/** Clouds around the places an edit touched, merged where they lie close; the result of the edit gets revision. */
async function cloudEdit(out, rev, boxes, scale = 100, send = call) {
  if (!rev || !out || typeof out !== 'object') return out;
  const b = (boxes || []).filter((x) => Array.isArray(x) && x.length === 4 && x.every(Number.isFinite));
  if (!b.length) {
    out.revision = { no: rev.no, clouds: 0, note: 'nothing in model space to cloud' };
    return out;
  }
  try {
    const r = await drawClouds(clusterBoxes(b, 5 * scale), { ...rev, scale }, send);
    out.revision = { no: rev.no, clouds: r?.clouds ?? 0, view: r?.id, layer: REV_LAYER };
  } catch (e) {
    out.revision = { no: rev.no, clouds: 0, error: String(e.message || e) };
  }
  return out;
}

/** The call of a view tool: what the drawing knows of its views, the view to replace, the plan of the drawing. */
async function viewCall(tool, args, run) {
  if (args?.dry_run) {
    // a dry run draws nothing, but reads the plan this drawing keeps when the session has none of it
    if (!args.plan && tool !== 'draw_plan') {
      try {
        const known = parseViews(await call('view_list', { keys: ['plan_hash'] }));
        if (known.planHash && (!lastPlan || hashOf(specKey(lastPlan)) !== known.planHash)) {
          const r = await call('view_list', { keys: ['plan'] });
          lastPlan = JSON.parse(r.values.plan);
        }
      } catch {
        // a bridge that keeps no views
      }
    }
    return run();
  }
  let known;
  try {
    known = parseViews(await call('view_list', { keys: ['plan_hash'] }));
  } catch {
    return run(); // a bridge that keeps no views (older than the server): the tool draws as it always did
  }
  const base = viewId(tool, args);
  const old = args.update ? viewToReplace(known.views, tool, base, args.update) : null;
  const ctx = {
    tool, base, old, update: !!args.update, id: old ? old.id : freeId(base, known.ids), args: keptArgs(tool, args), views: known.views,
    n: 0, spots: [], extra: {}, sent: false, erased: 0, locked: 0, erasedBounds: null, bounds: null,
    planHash: null, planJson: null, storedHash: known.planHash, planBase: null, floorsBase: null,
  };
  if (tool === 'draw_plan') {
    const kept = keptPlan(args);
    ctx.planHash = hashOf(specKey(kept));
    ctx.planJson = JSON.stringify(kept);
  } else {
    // the building of this drawing: where draw_plan put its floors, and its plan when the call gives none and the
    // session's last plan is not the one of this drawing (a drawing reopened, or another drawing made current)
    const planView = known.views.filter((v) => v.tool === 'draw_plan' && v.entities > 0).sort((a, b) => String(b.time).localeCompare(String(a.time)))[0];
    if (planView?.extra?.floors) ctx.floorsBase = planView.extra.floors;
    if (!args.plan && known.planHash && (!lastPlan || hashOf(specKey(lastPlan)) !== known.planHash)) {
      try {
        const r = await call('view_list', { keys: ['plan'] });
        ctx.planBase = JSON.parse(r.values.plan);
        lastPlan = ctx.planBase;
        lastFloors = ctx.floorsBase ?? null;
      } catch {
        ctx.planBase = null;
      }
    }
  }
  const res = await viewStore.run(ctx, run);
  const out = viewResult(res, ctx, known);
  // the clouds of a revision: where this update changed the view
  const rev = revisionOf(args.revision);
  if (rev && ctx.sent && ctx.old) {
    try {
      const diff = await call('view_diff', { id: ctx.id, forget: true });
      const scale = Number(args.scale ?? ctx.args?.scale ?? 100) || 100;
      const regions = diff.known ? regionsOfDiff(diff, { scale }) : [];
      const drawn = regions.length ? await drawClouds(regions, { ...rev, scale }) : null;
      const part = out?.content?.find((c) => c.type === 'text');
      const o = JSON.parse(part.text);
      o.revision = drawn ? { no: rev.no, clouds: drawn.clouds, view: drawn.id, changed: { removed: diff.removed.length, added: diff.added.length, same: diff.same } }
        : { no: rev.no, clouds: 0, note: diff.known ? 'nothing changed in this view' : 'the view as it was is not known (drawn in another session): clouds need an update in this session, or revision_cloud' };
      part.text = JSON.stringify(o);
    } catch (e) {
      // the clouds are a courtesy: the update itself stands
    }
  } else if (rev && !ctx.old) {
    try {
      const part = out?.content?.find((c) => c.type === 'text');
      const o = JSON.parse(part.text);
      o.revision = { no: rev.no, clouds: 0, note: 'revision clouds what an update (update: true) changed; this call drew a new view' };
      part.text = JSON.stringify(o);
    } catch {
      // as is
    }
  }
  return out;
}

/** The result of a view tool with its view: its id, what it replaced, the views still drawn from another plan. */
function viewResult(res, ctx, known) {
  if (!ctx.sent) return res; // nothing was drawn
  try {
    const part = res?.content?.find((c) => c.type === 'text');
    const out = JSON.parse(part.text);
    if (!out || typeof out !== 'object' || Array.isArray(out)) return res;
    const v = { id: ctx.id };
    if (ctx.update && ctx.old) {
      v.replaced = ctx.erased;
      if (ctx.locked) v.locked = `${ctx.locked} entities of the old view are on locked layers and were left`;
      if (outgrew(ctx.bounds, ctx.erasedBounds)) v.note = 'the view reaches past the one it replaced: the sheets that show it may crop it (create_layout with replace: true makes a sheet again)';
    } else if (ctx.update) v.note = 'no earlier view of this tool with these arguments in this drawing: drawn as a new view';
    if (ctx.planBase) v.plan = 'the plan kept in this drawing';
    out.view = v;
    const now = ctx.planJson ? ctx.planHash : known.planHash;
    const stale = now ? known.views.filter((x) => x.id !== ctx.id && x.entities > 0 && x.plan && x.plan !== now).map((x) => x.id) : [];
    if (stale.length) out.stale_views = stale;
    part.text = JSON.stringify(out);
  } catch {
    return res;
  }
  return res;
}

const registerTool = server.registerTool.bind(server);
const toolHandlers = new Map();
server.registerTool = (name, def, handler) => {
  const view = VIEW_TOOLS.has(name);
  const d = view ? { ...def, inputSchema: { ...def.inputSchema, update: UpdateArg, revision: RevisionArg } } : def;
  const run = (args, extra) => {
    // every tool draws in the language of its call (its language argument), else in the language of the session: the
    // view titles of the engines that are not handed a language follow it
    setDrawingLanguage(args?.language ?? language);
    return view || PLAN_TOOLS.has(name) ? viewCall(name, args ?? {}, () => handler(args, extra)) : handler(args, extra);
  };
  toolHandlers.set(name, run);
  return registerTool(name, d, run);
};
const jsonish = (schema) => z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, schema);
const Point = jsonish(z.array(z.number()).min(2).max(3));
const Window = jsonish(z.array(z.array(z.number()).min(2).max(3)).length(2));
const Handles = jsonish(z.array(z.union([z.string(), z.number()]).transform(String)));
const Obj = jsonish(z.record(z.string(), z.any()));
const Specs = jsonish(z.array(z.record(z.string(), z.any())));
const Str = z.string();
const Lang = z.enum(['vi', 'en']).describe('Language of the texts drawn: vi (default of the session) or en');
const HANDLES_DESC = 'Entity handles (hex strings like "2A7") from tool results; valid while the drawing is open.';
const FILTER = {
  types: opt(jsonish(z.array(z.string()))).describe('DXF types: LINE, LWPOLYLINE (or polyline), CIRCLE, ARC, TEXT, MTEXT, INSERT (or block), HATCH, DIMENSION, MULTILEADER, IMAGE...'),
  layers: opt(jsonish(z.array(z.string()))).describe('Layer names, * and ? wildcards (e.g. ["A-WALL*"])'),
  block_names: opt(jsonish(z.array(z.string()))).describe('Block names (wildcards) for INSERTs'),
  text_contains: opt(Str),
  window: opt(Window).describe('[[x1,y1],[x2,y2]]'),
  window_mode: z.enum(['crossing', 'inside']).default('crossing'),
  handles: opt(Handles),
  space: opt(Str).describe('model (default), paper, all, current, or a layout name'),
};

// Standard layer properties travel with every drawing request, so a missing standard layer is created correctly.
let language = 'vi';
// Last plan description given to draw_plan: draw_elevation and draw_section derive from it.
let lastPlan = null;
// where draw_plan put each floor of a building (the plans side by side)
let lastFloors = null;
const withStyles = (a) => ({ ...a, layer_styles: { ...layerStyles(a.language ?? language), ...(a.layer_styles || {}) } });

// ---------------------------------------------------------------- read
server.registerTool('ping', {
  description: 'Check the connection to AutoCAD: AutoCAD version, open drawing, bridge and server versions.',
  inputSchema: {},
  annotations: READ,
}, async () => {
  let r;
  try {
    r = (await call('ping')) || {};
  } catch (e) {
    // AutoCAD running but the bridge not listening yet: it is still starting or opening a drawing
    if (/Cannot connect/.test(String(e.message)) && (await acadRunning())) {
      throw new Error('Cannot connect to AutoCAD: AutoCAD is running but its bridge does not answer yet; it is probably still starting or opening a drawing (1-2 minutes with a large drawing). Retry in a minute; if it stays so, type MCPSTATUS in AutoCAD (MCPSTART starts the bridge).');
    }
    throw e;
  }
  const out = { ...r, mcp_server: VERSION };
  if (r.bridge && !VERSION.includes('-dev')) {
    const c = compareVersions(r.bridge, VERSION);
    if (c < 0) out.warning = `The bridge in AutoCAD is v${r.bridge}, older than this server (v${VERSION}): run install_autocad_bridge, then restart AutoCAD.`;
    else if (c > 0) out.note = 'The bridge is newer than the MCP server: install the latest .mcpb.';
  }
  return text(out);
});

bridgeTool('drawing_info',
  'Overview of the open drawing: file, units (INSUNITS), extents, current layer/text style/dimension style/DIMSCALE, ' +
  'model-space entity counts by type, number of layers/blocks/xrefs, layouts, text and dimension styles.',
  {}, READ);

bridgeTool('list_layers',
  'List layers: name, color, linetype, lineweight, on/frozen/locked/plot, description and number of entities (all spaces).',
  {}, READ);

bridgeTool('list_blocks',
  'List block definitions with their reference counts (dynamic blocks included), attribute tags, xref paths. Sorted by count.',
  { include_unused: z.boolean().default(true) }, READ);

bridgeTool('query_entities',
  'Find entities and read their geometry: handle, type, layer, and per type: line from/to/length, polyline points/closed/length/' +
  'area, circle/arc center/radius, text/mtext content/position/height, block name/position/rotation/scale/attributes, hatch ' +
  'pattern/area, dimension measurement. Filters combine (AND). detail=true adds polyline points, styles and bounds. Paged by limit/offset.',
  {
    ...FILTER,
    detail: z.boolean().default(false),
    limit: z.number().int().min(0).max(2000).default(100),
    offset: z.number().int().min(0).default(0),
  }, READ);

bridgeTool('selection_info',
  'The objects the user has selected in AutoCAD (PICKFIRST): counts by type and layer, bounds and each entity (as query_entities).',
  { detail: z.boolean().default(false), limit: z.number().int().min(0).default(200) }, READ);

// ---------------------------------------------------------------- quantities and checks
const BOM = String.fromCharCode(0xfeff);
const CSV_HEAD = {
  vi: { layer: 'Layer', block: 'Block', type: 'Loại', layer_type: 'Layer | Loại', count: 'Số lượng', length: 'Chiều dài (m)', area: 'Diện tích kín (m²)', hatch: 'Diện tích hatch (m²)', blocks: 'Block', total: 'Tổng' },
  en: { layer: 'Layer', block: 'Block', type: 'Type', layer_type: 'Layer | Type', count: 'Count', length: 'Length (m)', area: 'Closed area (m²)', hatch: 'Hatch area (m²)', blocks: 'Blocks', total: 'Total' },
};
// Quoted only when needed: the separator, a quote or a line break (a decimal comma under ";" stays a number for Excel).
const csvCell = (v, sep = ',') => {
  const s = v === undefined || v === null ? '' : typeof v === 'object' ? Object.entries(v).map(([k, n]) => `${k}: ${n}`).join(' | ') : String(v);
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** AutoCAD measures prisms and faces (drawing units, mm) and the result comes back in m³ and m². */
async function measureModel({ solids = [], faces = [] }, send = call) {
  const r = await send('measure_model', { ...(solids.length ? { solids } : {}), ...(faces.length ? { faces } : {}) });
  const m3 = (v) => Math.round((v / 1e9) * 1e6) / 1e6, m2 = (v) => Math.round((v / 1e6) * 1e6) / 1e6;
  const out = {};
  if (r.solids) {
    out.solids = r.solids.map((x) => ({ id: x.id, group: x.group || undefined, volume_m3: m3(x.volume) }));
    out.sum_m3 = m3(r.sum);
    out.union_m3 = m3(r.union);
    out.overlap_m3 = m3(r.overlap);
    out.union_by_group_m3 = Object.fromEntries(Object.entries(r.union_by_group || {}).map(([k, v]) => [k || '-', m3(v)]));
  }
  if (r.faces) {
    out.faces = r.faces.map((x) => ({ id: x.id, area_m2: m2(x.area), perimeter_m: Math.round(x.perimeter) / 1000 }));
    out.area_m2 = m2(r.area);
  }
  return out;
}

server.registerTool('measure_model', {
  description:
    'Independent measure by AutoCAD\'s own solid modeler, to check quantities: solids [{id, group, profile: [[x,y]...], holes: ' +
    '[[[x,y]...]], z0, z1}] (prisms in mm: a column, a beam, a slab with its openings) give the volume of each, their sum, the ' +
    'volume of their union (members that overlap counted once), the overlap (sum - union) and the union of each group, in m³; ' +
    'faces [{id, outline: [[u,v]...], holes, add}] (a wall face with its door and window holes, a floor; add: more outlines ' +
    'united with the first) give each area in m² and perimeter in m. Nothing is drawn or changed in the drawing.',
  inputSchema: {
    solids: opt(Specs).describe('[{id, group, profile, holes, z0, z1}] in mm'),
    faces: opt(Specs).describe('[{id, outline, holes, add}] in mm, in the plane of the face'),
  },
  annotations: READ,
}, async (args) => text(await measureModel({ solids: args.solids ?? [], faces: args.faces ?? [] })));

server.registerTool('list_views', {
  description:
    'The views of this drawing: what each drawing tool drew (plans, elevations, sections, schedules, details...), kept in ' +
    'the drawing itself. Each view: its id, tool, the arguments it was drawn with (give them again, with update: true, to ' +
    'draw it again where it stands), how many entities it has, its extent, and whether it was drawn from the plan now ' +
    'kept in the drawing (plan: "current") or from an older one ("stale": update it). plan: true also returns the plan ' +
    'description kept in the drawing (what draw_plan was given): change it and call draw_plan with update: true to change ' +
    'the building, then update the stale views. Works on a drawing reopened in another session.',
  inputSchema: { plan: z.boolean().default(false).describe('Also return the plan description kept in the drawing') },
  annotations: READ,
}, async (args) => {
  const r = await call('view_list', { keys: args.plan ? ['plan_hash', 'plan'] : ['plan_hash'] });
  const known = parseViews(r);
  const views = known.views.filter((v) => v.entities > 0).sort((a, b) => String(a.time).localeCompare(String(b.time))).map((v) => ({
    view: v.id, tool: v.tool, entities: v.entities, bounds: v.bounds ? { min: v.bounds.min, max: v.bounds.max } : undefined,
    plan: v.plan ? (v.plan === known.planHash ? 'current' : 'stale') : undefined,
    args: Object.keys(v.args).length ? v.args : undefined,
  }));
  const out = { views, stale: views.filter((v) => v.plan === 'stale').map((v) => v.view), plan_kept: !!known.planHash };
  if (args.plan) {
    try {
      out.plan = JSON.parse(r.values.plan);
    } catch {
      out.plan = null;
    }
  }
  if (!views.length) out.note = 'no view is recorded in this drawing: it was not drawn by these tools, or by a version that did not keep views; such drawings are edited entity by entity (query_entities, transform_entities, set_properties, delete_entities) or drawn again';
  return text(out);
});

// ---------------------------------------------------------------- revision clouds

server.registerTool('revision_cloud', {
  description:
    'Cloud the places of a revision (khoanh mây chỗ sửa đổi) on A-ANNO-REVS: a cloud of arcs around each place, the delta ' +
    '(a triangle with the revision number) at its corner and the note beside the first. Places: windows [[x0,y0],[x1,y1]], ' +
    'handles (the extents of those entities: what was edited entity by entity with transform_entities, set_properties, ' +
    'draw_entities on an old drawing) and points; places close together share a cloud. The clouds of one revision are one ' +
    'view (revision:<no>), so list_views shows them. Every drawing tool also takes revision with update: true, which ' +
    'clouds what the update changed by itself. For the revision list of the sheets, give create_layout title_block ' +
    'revisions [{no, text, date}].',
  inputSchema: {
    no: z.union([z.number(), z.string()]).default(1), note: opt(Str),
    windows: opt(jsonish(z.array(z.array(Point).length(2)))), handles: opt(Handles), points: opt(jsonish(z.array(Point))),
    scale: z.number().positive().default(100).describe('Plot scale of the view (arc size, delta, text)'),
  },
  annotations: EDIT,
}, async (args) => {
  const boxes = [];
  for (const w of args.windows || []) boxes.push([Math.min(w[0][0], w[1][0]), Math.min(w[0][1], w[1][1]), Math.max(w[0][0], w[1][0]), Math.max(w[0][1], w[1][1])]);
  for (const p of args.points || []) boxes.push([p[0], p[1], p[0], p[1]]);
  if (args.handles?.length) boxes.push(...(await boxesOf(args.handles)));
  if (!boxes.length) throw new Error('revision_cloud: give windows, handles or points');
  const regions = clusterBoxes(boxes, 10 * args.scale);
  const r = await drawClouds(regions, { no: args.no, note: args.note ?? '', scale: args.scale });
  return text({ revision: args.no, clouds: r.clouds, view: r.id, bounds: r.bounds, layer: REV_LAYER });
});

// ---------------------------------------------------------------- editing drawings made by others in place

server.registerTool('compare_drawings', {
  description:
    'Compare the current drawing with an earlier version on disk and cloud what changed (so sánh hai phiên bản, khoanh mây ' +
    'chỗ sửa): model space entity by entity (type, layer, geometry to 0.1, text, block and attributes, dimension value); ' +
    'previous is read in the background, never opened. Returns how many entities are the same, removed, added and ' +
    'modified (the same handle changed), the layers that changed most and the regions of change; with revision (a ' +
    'number, or {no, note}) each region is clouded on A-ANNO-REVS with the delta, as the view revision:<no>. A line or ' +
    'outline that changed is clouded only where its vertices moved. Uses: cloud the hand edits of a revision against the ' +
    'issued file; check the new version a consultant sent against the old one (open the new one, previous = the old); ' +
    'layers: false ignores layer changes (against the copy before standardize_layers: nothing should differ). window ' +
    'limits both to an area; skip_layers leaves layers out. The comparison is with the file as saved, not with the Undo history.',
  inputSchema: {
    previous: Str.describe('DWG of the earlier version (a copy, or the saved file of this drawing before the edits)'),
    revision: EditRevisionArg, window: opt(Window), layers: z.boolean().default(true),
    skip_layers: opt(jsonish(z.array(Str))), scale: EditScaleArg,
    max_regions: z.number().int().min(1).max(60).default(12),
  },
  annotations: EDIT,
}, async (args) => {
  const d = await call('drawing_diff', { previous: path.resolve(args.previous), window: args.window, layers: args.layers, skip_layers: args.skip_layers });
  const regions = regionsOfDiff(d, { scale: args.scale, max: args.max_regions, fine: true });
  const out = {
    previous: d.previous, same: d.same, removed: d.removed_count, added: d.added_count, modified: d.modified,
    by_layer: d.by_layer, regions: regions.map((b) => [[Math.round(b[0]), Math.round(b[1])], [Math.round(b[2]), Math.round(b[3])]]),
  };
  if (!d.removed_count && !d.added_count) out.note = 'no difference in model space';
  if (d.truncated) out.note = 'many differences: the regions come from the first of them';
  const rev = editRevisionOf(args.revision);
  if (rev && regions.length) {
    const r = await drawClouds(regions, { ...rev, scale: args.scale });
    out.revision = { no: rev.no, clouds: r?.clouds ?? 0, view: r?.id, layer: REV_LAYER };
  }
  return text(out);
});

server.registerTool('stretch_entities', {
  description:
    'Stretch part of a drawing in place, as AutoCAD STRETCH with a crossing window (kéo dài, dời tường tại chỗ trên bản ' +
    'vẽ cũ): what lies wholly inside window moves by displacement (or from -> to); what crosses its edge has only its ' +
    'points inside moved: the end of a wall face, the vertices of a polyline, the definition points of a dimension (so ' +
    'the dimension follows and reads the new length), a block whose insertion point is inside. Use it to move a wall: ' +
    'a window around the wall (both faces, its hatch, the door in it) and the dimensions that reach it. Entities on ' +
    'locked layers are left; layers: only those. A room outline (closed polyline) that changes size takes the area ' +
    'written inside it along ("5,06 m²" becomes the new area, same form; update_areas: false leaves them). One Undo ' +
    'step. With revision, the area that changed is clouded.',
  inputSchema: {
    window: Window.describe('Crossing window [[x0,y0],[x1,y1]]'), displacement: opt(Point), from: opt(Point), to: opt(Point),
    layers: opt(jsonish(z.array(Str))), update_areas: z.boolean().default(true), revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, async ({ window, displacement, from, to, layers, update_areas, revision, scale }) => {
  const d = displacement ?? (from && to ? [to[0] - from[0], to[1] - from[1]] : null);
  if (!d) throw new Error('stretch_entities: give displacement [dx, dy], or from and to');
  const out = await call('stretch', { window, displacement: d.slice(0, 2), layers, update_areas });
  if (!out.moved && !out.stretched) out.note = 'nothing in the window (or only on locked layers)';
  const rev = editRevisionOf(revision);
  if (rev && (out.moved || out.stretched)) {
    const w = [Math.min(window[0][0], window[1][0]), Math.min(window[0][1], window[1][1]), Math.max(window[0][0], window[1][0]), Math.max(window[0][1], window[1][1])];
    const moved = [w[0] + d[0], w[1] + d[1], w[2] + d[0], w[3] + d[1]];
    const boxes = [out.before && clipBox(out.before, w), out.after && clipBox(out.after, moved)].filter(Boolean);
    await cloudEdit(out, rev, boxes.length ? [boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])] : [], scale);
  }
  return text(out);
});

server.registerTool('replace_text', {
  description:
    'Find and replace text across the whole drawing (sửa chữ hàng loạt: tên công trình, chủ đầu tư, số bản vẽ, ngày): ' +
    'texts, mtext, block attributes, attribute defaults, dimension text overrides and table cells of model space, every ' +
    'layout and the block definitions (blocks: false leaves the definitions). find is literal text unless regex: true ' +
    '(.NET pattern; replace may use $1); case_sensitive false by default; whole_word; layers: only those. preview: true ' +
    'lists what would change (from -> to) and changes nothing: use it first. Entities on locked layers are left and ' +
    'counted. One Undo step. With revision, each changed text in model space is clouded. Mtext keeps its formatting ' +
    'codes, so a word split by a formatting change is not found.',
  inputSchema: {
    find: Str, replace: Str.default(''), regex: z.boolean().default(false), case_sensitive: z.boolean().default(false),
    whole_word: z.boolean().default(false), layers: opt(jsonish(z.array(Str))), blocks: z.boolean().default(true),
    preview: z.boolean().default(false), revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, async ({ revision, scale, ...args }) => {
  const out = await call('replace_text', args);
  const rev = editRevisionOf(revision);
  if (rev && !args.preview && out.count) await cloudEdit(out, rev, (out.changes || []).map((c) => c.b).filter(Boolean), scale);
  return text(out);
});

server.registerTool('convert_vietnamese_text', {
  description:
    'Turn the texts of an old drawing typed for legacy Vietnamese fonts into Unicode and move their text styles to a ' +
    'Unicode font (Arial by default), so the drawing reads the same on any machine and can be edited with the other ' +
    'tools: TCVN3 / ABC fonts (.VnTime, .VnArial...: "MÆt b»ng tÇng 1") and VNI fonts (VNI-Times, VNI-Helve...: "MAËT ' +
    'BAÈNG TAÀNG 1") become "Mặt bằng tầng 1". Only texts in styles whose font is such a font (or mtext parts in one) ' +
    'change; the TCVN3 fonts ending in H (.VnTimeH) show capitals, so those texts become capitals. Texts, mtext, ' +
    'attributes, attribute defaults, dimension overrides and mleaders of every space and block. A text that already ' +
    'holds Unicode Vietnamese is left. A style whose font has another name (an SHX font, a renamed TrueType) is found ' +
    'by what its texts read (by_content, on by default: most of its texts read as TCVN3 or VNI); styles names styles ' +
    'outright ({"STYLE": "vni" | "tcvn3"}). preview: true lists the styles found and samples (from -> to) and changes ' +
    'nothing: use it first. One Undo step.',
  inputSchema: {
    font: Str.default('Arial').describe('Unicode font for the converted styles'),
    preview: z.boolean().default(false),
    tcvn3_fonts: opt(jsonish(z.array(Str))).describe('Font name prefixes counted as TCVN3 (default [".Vn"])'),
    vni_fonts: opt(jsonish(z.array(Str))).describe('Font name prefixes counted as VNI (default ["VNI-", "VNI "])'),
    by_content: z.boolean().default(true).describe('Also convert the styles whose texts read as TCVN3 or VNI, whatever their font'),
    styles: opt(jsonish(z.record(z.string(), z.enum(['tcvn3', 'vni'])))).describe('Styles to convert as that encoding'),
  },
  annotations: EDIT,
}, async ({ font, preview, tcvn3_fonts, vni_fonts, by_content, styles }) => {
  const named = { ...(styles || {}) };
  if (by_content) {
    try {
      for (const [st, enc] of Object.entries(legacyStyles(await call('model_map', {})))) named[st] ??= enc;
    } catch {
      // no map: the fonts alone
    }
  }
  const of = (enc) => Object.entries(named).filter(([, e]) => e === enc).map(([st]) => st);
  const out = await call('convert_text', {
    font, preview,
    encodings: [
      { name: 'TCVN3', prefixes: tcvn3_fonts ?? ['.Vn'], map: TCVN3, capitals_suffix: 'H', styles: of('tcvn3') },
      { name: 'VNI', prefixes: vni_fonts ?? ['VNI-', 'VNI '], map: VNI, styles: of('vni') },
    ],
  });
  if (!out.styles?.length) out.note = 'no text style uses a TCVN3 (.Vn...) or VNI (VNI-...) font: nothing to convert';
  return text(out);
});

server.registerTool('describe_drawing', {
  description:
    'Read the map of a drawing made by others (đọc hiểu bản vẽ) before working on it: its sheets (layouts with their ' +
    'viewports: the model area each shows and its scale; frames drawn in model space: paper size and scale found from ' +
    'their size), the drawing number and title block of each, and the views on each sheet from their titles (MẶT ' +
    'BẰNG, MẶT ĐỨNG, MẶT CẮT, CHI TIẾT, BẢNG, SƠ ĐỒ, GHI CHÚ, PHỐI CẢNH... in Vietnamese, English and Chinese, also ' +
    'titles typed in the old TCVN3 fonts): kind, floor, scale (TỶ LỆ 1/100, SCALE 1:50) and the model window of each, ' +
    'to hand to read_plan, compare_drawings, stretch_entities or screenshot. Counts the texts in legacy fonts and ' +
    'names their styles (convert_vietnamese_text). The window of a view is the band its title owns (titles stand under ' +
    'their views) fitted to what is drawn in it (window_from: drawing), or the band alone (window_from: titles).',
  inputSchema: {},
  annotations: READ,
}, async () => {
  const map = await call('model_map', {});
  let layouts = [];
  try {
    layouts = (await call('layout_views', {})).layouts || [];
  } catch {
    // an older bridge: the model frames only
  }
  const out = describeDrawing(map, layouts);
  // the window of each view fitted to what is drawn in it
  const views = viewsWithWindows(out);
  if (views.length) {
    try {
      const r = await call('view_extents', { windows: views.map((v) => v.window), skip_handles: frameHandles(map), skip_layers: ['A-ANNO-REVS', 'X-READ-PLAN'] });
      fitWindows(views, r.windows);
    } catch {
      // an older bridge: the windows stay as the titles place them
    }
  }
  const plans = [...out.sheets.flatMap((s) => [...(s.views || []), ...(s.viewports || []).flatMap((v) => v.views)]), ...out.views_outside_sheets].filter((v) => v.kind === 'plan' && v.window);
  const hints = [];
  if (plans.length) hints.push(`read_plan with window ${JSON.stringify(plans[0].window)} reads "${plans[0].title}"`);
  if (out.legacy_font_texts) {
    const counts = Object.entries(out.legacy_font_texts).filter(([k]) => k !== 'styles').map(([k, n]) => `${n} ${k.toUpperCase()}`).join(', ');
    const styles = Object.keys(out.legacy_font_texts.styles || {});
    hints.push(`texts typed for legacy Vietnamese fonts (${counts}${styles.length ? `; styles ${styles.join(', ')}` : ''}): convert_vietnamese_text (preview first)`);
  }
  if (hints.length) out.hints = hints;
  return text(out);
});

// ---------------------------------------------------------------- titles of views, title blocks of sheets

server.registerTool('retitle_view', {
  description:
    'Change the title of views drawn by these tools (đổi tên hình): the title text and its underline, which takes the length ' +
    'of the new title. old: the title as written (every view titled so changes; or handle: one title text). The view keeps ' +
    'the arguments it was drawn with: on a later update: true give the new title (title, or titles of draw_interior_elevation) ' +
    'or the old one comes back.',
  inputSchema: { old: opt(Str), handle: opt(z.union([Str, z.number()]).transform(String)), text: Str },
  annotations: EDIT,
}, async ({ old, handle, text: neu }) => {
  if (!old && !handle) throw new Error('retitle_view: give old (the title as written) or handle (of the title text)');
  const list = (await call('text_list', {})).items || [];
  const found = list.filter((i) => i[1] === 'text' && i[5] === 'model' && (handle ? String(i[0]).toUpperCase() === handle.toUpperCase() : String(i[2]).trim() === String(old).trim()));
  if (!found.length) throw new Error(`retitle_view: no title ${handle ? `with handle ${handle}` : `"${old}"`} in model space`);
  const out = [];
  for (const [h, , , , , , x, y, H] of found) {
    const s = H / 5;
    // the underline: a line 1.6 x scale under the title, centred on it
    const q = await call('query_entities', { types: ['LINE'], window: [[x - 600 * s, y - 2.4 * s], [x + 600 * s, y - 0.8 * s]], window_mode: 'crossing', limit: 30 });
    const ul = (q.entities || []).filter((e) => Array.isArray(e.from) && Array.isArray(e.to) && Math.abs(e.from[1] - (y - 1.6 * s)) < 0.4 * s && Math.abs(e.to[1] - e.from[1]) < 0.01 * s + 0.01 && Math.abs((e.from[0] + e.to[0]) / 2 - x) < 1.5 * s);
    await call('set_texts', { items: [{ handle: h, text: neu }] });
    for (const l of ul) {
      const half0 = Math.abs(l.to[0] - l.from[0]) / 2, half1 = capsWidth(neu, H) / 2 + s;
      if (half0 > 0) await call('transform_entities', { handles: [l.handle], op: 'scale', base: [(l.from[0] + l.to[0]) / 2, l.from[1]], factor: half1 / half0 });
    }
    out.push({ handle: h, at: [x, y], underline: ul.map((l) => l.handle) });
  }
  return text({ titles: out.length, changed: out });
});

server.registerTool('update_title_blocks', {
  description:
    'Write the revision and other fields into the title blocks of the sheets without making the layouts again (cập nhật ' +
    'lần sửa, ngày, phiên bản trên khung tên): revision {text, date} goes in the first empty revision row (REV1..REV4 and ' +
    'REV1_DATE.. of the title strip of create_layout; with four rows full the oldest goes up and out), values {TAG: value} ' +
    'into the attributes of that tag (e.g. PHIEN_BAN, NGAY, GIAI_DOAN, TEN_BAN_VE). layouts: names (default all). A title ' +
    'block of another office works with values by its own tags (list_texts shows them).',
  inputSchema: {
    layouts: opt(jsonish(z.array(Str))), values: opt(Obj),
    revision: opt(z.object({ no: opt(z.union([z.number(), Str])), text: Str, date: opt(Str) })),
  },
  annotations: EDIT,
}, async ({ layouts, values, revision }) => {
  if (!values && !revision) throw new Error('update_title_blocks: give revision {text, date} or values {TAG: value}');
  const info = await call('drawing_info', {});
  const all = (info.layouts || []).map((l) => (typeof l === 'string' ? l : l.name)).filter((n) => n && n.toLowerCase() !== 'model');
  const names = layouts?.length ? layouts : all;
  const missing = names.filter((n) => !all.some((a) => a.toLowerCase() === n.toLowerCase()));
  if (missing.length) throw new Error(`update_title_blocks: no layout ${missing.join(', ')} (layouts: ${all.join(', ')})`);
  const want = Object.keys(values || {}).map((k) => k.toUpperCase());
  const out = [];
  for (const lay of names) {
    const q = await call('query_entities', { space: lay, types: ['INSERT'], limit: 200 });
    const blocks = (q.entities || []).filter((e) => e.attributes && Object.keys(e.attributes).length);
    const tb = blocks.find((e) => revision && 'REV1' in e.attributes) ?? blocks.find((e) => want.some((t) => t in e.attributes));
    if (!tb) {
      out.push({ layout: lay, note: 'no title block with these tags' });
      continue;
    }
    const set = {};
    for (const [k, v] of Object.entries(values || {})) if (k.toUpperCase() in tb.attributes) set[k.toUpperCase()] = String(v);
    if (revision && 'REV1' in tb.attributes) {
      const text0 = revision.no !== undefined ? `${revision.no}. ${revision.text}` : revision.text;
      const rows = [1, 2, 3, 4].map((i) => ({ text: tb.attributes[`REV${i}`] ?? '', date: tb.attributes[`REV${i}_DATE`] ?? '' }));
      let i = rows.findIndex((r) => !String(r.text).trim());
      if (i < 0) {
        // four rows full: the oldest goes, the others move up
        for (let k = 0; k < 3; k++) {
          set[`REV${k + 1}`] = rows[k + 1].text;
          set[`REV${k + 1}_DATE`] = rows[k + 1].date;
        }
        i = 3;
      }
      set[`REV${i + 1}`] = text0;
      if (`REV${i + 1}_DATE` in tb.attributes) set[`REV${i + 1}_DATE`] = revision.date ?? '';
    }
    if (!Object.keys(set).length) {
      out.push({ layout: lay, note: 'none of the tags given is in its title block' });
      continue;
    }
    await call('set_properties', { handles: [tb.handle], attributes: set });
    out.push({ layout: lay, block: tb.name, set });
  }
  return text({ sheets: out.filter((o) => o.set).length, layouts: out });
});

// ---------------------------------------------------------------- reviewing and tidying drawings made by others

server.registerTool('check_annotations', {
  description:
    'Check the annotation of a drawing made by others (kiểm tra kích thước ghi đè, diện tích ghi sai): every dimension ' +
    'whose text is written over is compared with what it measures (its numbers, "4.000" or "4,000" read as thousands ' +
    'too, "2x1200" as 2400, with the linear factor; within half the last decimal, 0.2 % or 1 mm), and every area text ' +
    '(m2, m², S =, DT, DIỆN TÍCH, AREA, 面積) with the area of the smallest closed outline around it (an outline far ' +
    'from the written area does not count). Lists the mismatches with the fix (the number replaced by <>, the ' +
    'measured value; the right area in the same form) and the overrides written as words only (VAR, EQ: not checked). ' +
    'fix: dimensions | areas | all writes the fixes (handles: only those); with revision they are clouded. A detail ' +
    'drawn not to scale has its dimensions written over on purpose: check before fixing. One Undo step.',
  inputSchema: {
    fix: z.enum(['none', 'dimensions', 'areas', 'all']).default('none'), handles: opt(Handles),
    revision: EditRevisionArg, scale: EditScaleArg, limit: z.number().int().min(1).max(2000).default(200),
  },
  annotations: EDIT,
}, async ({ fix, handles, revision, scale, limit }) => {
  const d = await call('annotation_data', {});
  const dims = checkDims(d.dims, d.units_m);
  const areas = checkAreas(d.areas);
  const out = {
    dimensions: d.dims_checked, written_over: d.dims.length, dimension_mismatches: dims.mismatch.length, words_only: dims.words.length,
    area_texts: d.areas.length, area_mismatches: areas.mismatch.length, area_texts_without_outline: areas.none.length,
    dimensions_wrong: dims.mismatch.slice(0, limit).map(({ b, ...x }) => x), areas_wrong: areas.mismatch.slice(0, limit).map(({ b, ...x }) => x),
    words: dims.words.slice(0, 30),
  };
  if (fix !== 'none') {
    const want = (h) => !handles?.length || handles.includes(h);
    const items = [
      ...(fix === 'dimensions' || fix === 'all' ? dims.mismatch.filter((x) => want(x.handle)).map((x) => ({ handle: x.handle, text: x.fixed })) : []),
      ...(fix === 'areas' || fix === 'all' ? areas.mismatch.filter((x) => want(x.handle)).map((x) => ({ handle: x.handle, text: x.fixed })) : []),
    ];
    if (items.length) {
      const r = await call('set_texts', { items });
      out.fixed = r.set;
      if (r.locked) out.locked = r.locked;
      await cloudEdit(out, editRevisionOf(revision), r.boxes, scale);
    } else out.fixed = 0;
  }
  return text(out);
});

server.registerTool('list_texts', {
  description:
    'List the texts of a drawing (liệt kê chữ trên bản vẽ): texts, mtext, attributes, attribute defaults, dimensions ' +
    'written over, mleaders and table cells of model space and every layout (blocks: true adds block definitions). ' +
    'unique (default): one row per distinct text with how often it is written, its handles, kinds, layers and ' +
    'language (vi, zh, en). find (text, or a pattern with regex) and language narrow it. Use it to review the wording ' +
    'of a drawing or to translate it: translate the rows, then update_texts with each handle and its new text. ' +
    'save_path writes all rows as CSV (Excel opens it).',
  inputSchema: {
    unique: z.boolean().default(true), find: opt(Str), regex: z.boolean().default(false),
    language: opt(z.enum(['vi', 'zh', 'en', 'other'])), blocks: z.boolean().default(false),
    limit: z.number().int().min(1).max(5000).default(200), offset: z.number().int().min(0).default(0), save_path: opt(Str),
  },
  annotations: READ,
}, async ({ unique, find, regex, language, blocks, limit, offset, save_path }) => {
  const r = await call('text_list', { blocks });
  const rows = listTexts(r.items, { find, regex, language, unique });
  const out = { total: rows.length, offset, rows: rows.slice(offset, offset + limit) };
  if (rows.length > offset + limit) out.next_offset = offset + limit;
  if (r.truncated) out.note = 'more texts than were read';
  if (save_path) {
    const cols = unique
      ? [['text', 'Text'], ['count', 'Count'], ['language', 'Language'], ['kinds', 'Kinds'], ['layers', 'Layers'], ['handles', 'Handles'], ['translation', 'Translation / Bản dịch']]
      : [['handle', 'Handle'], ['kind', 'Kind'], ['text', 'Text'], ['layer', 'Layer'], ['style', 'Style'], ['space', 'Space'], ['translation', 'Translation / Bản dịch']];
    const flat = rows.map((x) => ({ ...x, kinds: [].concat(x.kinds ?? []).join(', '), layers: [].concat(x.layers ?? []).join(', '), handles: [].concat(x.handles ?? []).join(' ') }));
    const file = path.resolve(save_path);
    await fs.writeFile(file, toCsv(flat, cols), 'utf8');
    out.saved = file;
  }
  return text(out);
});

server.registerTool('update_texts', {
  description:
    'Set the text of many entities by handle in one Undo step (sửa nhiều chữ theo handle, ví dụ bản dịch): items ' +
    '[{handle, text}] from list_texts or query_entities. Texts, attributes, attribute defaults, mtext (the text is its ' +
    'contents: \\P is a new line), dimensions (their override; "<>" is the measured value), mleaders, and a table ' +
    'cell as "handle:row:column". Entities on locked layers are left and named. With revision, those in model space ' +
    'are clouded.',
  inputSchema: {
    items: jsonish(z.array(z.object({ handle: z.union([z.string(), z.number()]).transform(String), text: Str }))).describe('[{handle, text}]'),
    revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, async ({ items, revision, scale }) => {
  const r = await call('set_texts', { items });
  const { boxes, ...out } = r;
  await cloudEdit(out, editRevisionOf(revision), boxes, scale);
  return text(out);
});

server.registerTool('clean_drawing', {
  description:
    'Tidy a drawing made by others (dọn bản vẽ: nét trùng, nét chồng, chữ rỗng) in model space: entities drawn twice ' +
    '(same type, layer, colour, linetype, lineweight and geometry or text: lines, polylines, arcs, circles, texts, ' +
    'mtext, block references with their attributes, dimensions) keep one; lines, arcs, circles and polylines of no ' +
    'size and texts with nothing written go; lines on the same line with the same layer and properties that overlap ' +
    'or touch become one (as OVERKILL; tolerance in drawing units). Each part can be turned off; layers: only those. ' +
    'preview: true counts and names samples without changing anything: use it first. Locked layers are left. One Undo step.',
  inputSchema: {
    preview: z.boolean().default(false), duplicates: z.boolean().default(true), zero_length: z.boolean().default(true),
    empty_texts: z.boolean().default(true), overlapping_lines: z.boolean().default(true), layers: opt(jsonish(z.array(Str))),
    tolerance: z.number().positive().default(0.01),
  },
  annotations: DESTRUCTIVE,
}, async (args) => text(await call('clean', args)));

/** The DWG files of a folder (and its subfolders), backups and temporary copies left out. */
async function dwgFiles(folder, recursive, max = 500) {
  const out = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (out.length >= max) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(p);
      } else if (/\.dwg$/i.test(e.name) && !/^~|\$|\.sv\$$/i.test(e.name)) out.push(p);
    }
  };
  await walk(folder);
  return out.sort();
}

server.registerTool('describe_folder', {
  description:
    'Read the map of every drawing in a folder (đọc cả bộ hồ sơ: danh mục bản vẽ của một thư mục) without opening them ' +
    'in AutoCAD: for each DWG its sheets (layouts, frames in model space) with drawing number, sheet title, paper, ' +
    'scale and the views on it, and the texts in legacy Vietnamese fonts, as describe_drawing reads one drawing. ' +
    'save_path writes the register of sheets as .xlsx or .csv. A drawing that cannot be read is listed with the reason.',
  inputSchema: {
    folder: Str, recursive: z.boolean().default(false), save_path: opt(Str),
    max_files: z.number().int().min(1).max(500).default(200),
  },
  annotations: READ,
}, async ({ folder, recursive, save_path, max_files }) => {
  const dir = path.resolve(folder);
  const files = await dwgFiles(dir, recursive, max_files);
  if (!files.length) throw new Error(`describe_folder: no .dwg file in ${dir}`);
  const results = [];
  for (const file of files) {
    try {
      const map = await call('model_map', { path: file });
      let layouts = [];
      try {
        layouts = (await call('layout_views', { path: file })).layouts || [];
      } catch {
        // the model frames only
      }
      results.push({ file: path.relative(dir, file), map: describeDrawing(map, layouts, { name: file }) });
    } catch (e) {
      results.push({ file: path.relative(dir, file), error: String(e.message || e).slice(0, 200) });
    }
  }
  const rows = registerRows(results);
  const out = {
    folder: dir, files: files.length, read: results.filter((r) => !r.error).length, sheets: rows.filter((r) => r.source === 'layout' || r.source === 'model frame').length,
    errors: results.filter((r) => r.error).map((r) => ({ file: r.file, error: r.error })), register: rows.slice(0, 150),
  };
  if (rows.length > 150) out.note = `${rows.length} rows: the first 150 are listed; save_path writes them all`;
  if (save_path) {
    const file = path.resolve(save_path);
    if (/\.xlsx$/i.test(file)) {
      const head = REGISTER_COLUMNS.map(([, t]) => ({ v: t, s: 'head' }));
      await fs.writeFile(file, xlsxBook([{ name: 'Danh muc ban ve', rows: [head, ...rows.map((r) => REGISTER_COLUMNS.map(([k]) => r[k] ?? ''))], widths: [28, 12, 14, 10, 40, 12, 9, 22, 60, 16, 30], freeze: 2 }]));
    } else await fs.writeFile(file, toCsv(rows, REGISTER_COLUMNS), 'utf8');
    out.saved = file;
  }
  return text(out);
});

// ---------------------------------------------------------------- plans of drawings made by others

server.registerTool('read_plan', {
  description:
    'Read the plan of a drawing made by others (or of a drawing these tools did not keep) into the plan description of ' +
    'draw_plan, so it can be changed and updated in place like a plan drawn here: walls (pairs of parallel faces at a ' +
    'wall thickness, on wall layers or any layer that is not annotation; their ends run on to the wall they meet), ' +
    'openings (a stretch where both faces stop: a door where a swing arc or a door block is, double when two leaves, ' +
    'a window where glazing lines or a window block are, else a plain opening; their tag D1 / S1 nearby), columns (small ' +
    'closed outlines on column layers or filled), grids (long centre lines with their bubbles), rooms (names inside the ' +
    'walls). A plan inside a block or a bound xref is read through it. Without window it finds the areas of the model ' +
    'space that hold walls, ranks them by door swings, room names and walls in both directions (a section or an ' +
    'elevation has parallel faces too) and reads the first: give window to read another. Run standardize_layers first ' +
    'on a drawing with untidy layers. Returns the plan description, what was found and what was not read. preview: true ' +
    'draws what was read in red on a layer that does not plot (X-READ-PLAN) over the drawing, to compare (screenshot); ' +
    'adopt: true moves the entities that were read to the frozen layer X-OLD-PLAN (nothing deleted: thaw it to compare) ' +
    'and draws the plan in place with draw_plan (its view and plan kept in the drawing, so draw_plan update and the other ' +
    'tools work on it). Also read: curtain walls (two glass lines 20-80 mm apart: a wall with a window over its length), ' +
    'walls drawn as one wide polyline, curved walls (concentric arcs), doors drawn as a leaf line or an unnamed block, ' +
    'straight flights of equal treads (the way up from a LÊN / UP text; a U stair as its two flights) and level texts. ' +
    'Furniture and notes are not read (they stay on the drawing). To mark what you then change, give revision with ' +
    'update: true or use revision_cloud.',
  inputSchema: {
    window: opt(jsonish(z.array(Point).length(2))).describe('[[x0,y0],[x1,y1]] the area of the plan (drawing units)'),
    thickness: opt(jsonish(z.array(z.number()).length(2))).describe('[min, max] wall thickness in mm (default [80, 450])'),
    wall_layers: opt(jsonish(z.array(Str))).describe('Layers to take as wall layers whatever their name'),
    preview: z.boolean().default(false), adopt: z.boolean().default(false),
    save_path: opt(Str).describe('Write the plan description (JSON) to this file'),
    scale: z.number().positive().default(100), language: opt(Lang),
  },
  annotations: EDIT,
}, async (args) => {
  const tool = 'read_plan';
  const lang = args.language ?? language;
  const g = await call('plan_geometry', args.window ? { window: args.window } : {});
  const opts = { thickness: args.thickness ?? [80, 450], wallLayers: args.wall_layers ?? null };
  let window = args.window ?? null, candidates;
  if (!window) {
    candidates = engine(tool, () => planAreas(g, opts));
    if (candidates.length) window = candidates[0].window;
  }
  const r = engine(tool, () => readPlan(g, { ...opts, window }));
  const out = {
    window, found: r.found, unread: r.unread, plan: r.spec,
    candidates: candidates && candidates.length > 1 ? candidates.slice(0, 8) : undefined,
    expanded_blocks: g.expanded || undefined,
  };
  if (!r.spec.walls.length) {
    out.note = 'No walls were read here. Give the window of a plan (candidates lists the areas found), wall_layers, or a thickness range; a plan of single lines has no wall faces to pair.';
    return text(out);
  }
  if (args.save_path) {
    const file = path.resolve(args.save_path.endsWith('.json') ? args.save_path : `${args.save_path}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(r.spec, null, 1), 'utf8');
    out.saved = file;
  }
  if (args.preview && !args.adopt) {
    // what was read, in red on a layer that does not plot: the outline of each wall band, a circle at each opening
    const ents = [];
    for (const w of r.spec.walls) {
      const [a, b] = w.points, t = w.thickness / 2, L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const n = [(-(b[1] - a[1]) / L) * t, ((b[0] - a[0]) / L) * t];
      ents.push({ type: 'polyline', points: [[a[0] + n[0], a[1] + n[1]], [b[0] + n[0], b[1] + n[1]], [b[0] - n[0], b[1] - n[1]], [a[0] - n[0], a[1] - n[1]]], closed: true, layer: 'X-READ-PLAN', color: 1 });
    }
    for (const o of r.spec.openings) ents.push({ type: 'circle', center: o.at, radius: o.width / 2, layer: 'X-READ-PLAN', color: o.type === 'window' ? 3 : o.type === 'opening' ? 30 : 5 });
    for (const rm of r.spec.rooms || []) ents.push({ type: 'text', text: rm.name, at: rm.at, height: 2.5 * args.scale, layer: 'X-READ-PLAN', color: 6 });
    const pv = await call('draw_entities', { entities: ents, layer_styles: { 'X-READ-PLAN': { color: 1, plot: false, description: 'read_plan: what was read (not plotted)' } } });
    out.preview = { layer: 'X-READ-PLAN', entities: pv.count, bounds: pv.bounds, note: 'red: walls read, blue: doors, green: windows, orange: openings, magenta: rooms. Compare with screenshot over this window; delete_entities or undo removes it.' };
  }
  if (args.adopt) {
    // the old plan out of the way (frozen, not plotted, nothing deleted), then the plan drawn in place
    await call('layer_remap', { create: [{ name: 'X-OLD-PLAN', color: 8, plot: false, description: 'read_plan: the plan as it was drawn before it was adopted' }] });
    // what was read, and the dimensions of the old plan (draw_plan draws its own): an entity read through a block
    // ("^" + the block's handle) moves the whole block
    const b = r.bounds, m = 3000 * (g.units === 'm' ? 0.001 : 1);
    const dims = (g.dims || []).filter((d) => b && d[0] >= b[0][0] - m && d[2] <= b[1][0] + m && d[1] >= b[0][1] - m && d[3] <= b[1][1] + m).map((d) => d[5]);
    const nested = [...r.used, ...dims].some((h) => String(h).startsWith('^'));
    const handles = [...new Set([...r.used, ...dims].map((h) => String(h).replace(/^\^/, '')))];
    let moved = 0;
    for (let i = 0; i < handles.length; i += 2000) {
      const res = await call('set_properties', { handles: handles.slice(i, i + 2000), layer: 'X-OLD-PLAN' });
      moved += res.changed ?? res.count ?? handles.slice(i, i + 2000).length;
    }
    await call('layer_remap', { props: [{ name: 'X-OLD-PLAN', frozen: true }] });
    const draw = toolHandlers.get('draw_plan');
    const res = await draw({ ...r.spec, scale: args.scale, language: args.language, dimensions: ['bottom', 'left', 'top', 'right'] }, undefined);
    const drawn = JSON.parse(res.content.find((c) => c.type === 'text').text);
    out.adopted = {
      old_entities_moved: moved, old_layer: 'X-OLD-PLAN (frozen, not plotted)', plan_view: drawn.view?.id, rooms: drawn.rooms?.length, warnings: drawn.warnings, assumed: drawn.assumed,
      old_dimensions_moved: dims.length || undefined,
      inside_blocks: nested ? 'part of the plan sat inside a block (a bound xref, a plan inserted as a block): that whole block went to X-OLD-PLAN' : undefined,
      next: 'The plan is now this drawing\'s plan: change it with draw_plan update: true (list_views plan: true gives it), draw elevations, sections and schedules from it. Undo (3 steps) or thaw X-OLD-PLAN to compare with the old drawing.',
    };
  }
  return text(out);
});

// ---------------------------------------------------------------- layers of drawings made by others

/** The plot style table of the layouts of a drawing (the one most of them use), read from AutoCAD's folder or the drawing's. */
async function ctbOf(survey) {
  const names = (survey.plot?.layouts || []).map((l) => l.style_sheet).filter((n) => /\.ctb$/i.test(n || ''));
  if (!survey.plot?.color_dependent) return { ctb: null, note: 'named plot styles (STB): the weights compared are the lineweights of the objects' };
  if (!names.length) return { ctb: null, note: 'no plot style table on the layouts: the weights compared are the lineweights of the objects' };
  const count = new Map();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const name = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  for (const dir of [survey.plot.styles_folder, survey.plot.drawing_folder].filter(Boolean)) {
    try {
      const ctb = parseCtb(await fs.readFile(path.join(dir, name)), name);
      const fixed = ctb.pens.filter((x) => x != null).length;
      return { ctb, note: `${name}: ${fixed ? `${fixed} colours plot with a fixed weight` : 'every colour plots with the lineweight of the object'}` };
    } catch {
      // not there: the next folder
    }
  }
  return { ctb: null, note: `${name} was not found (AutoCAD's plot styles folder, the drawing's folder): the weights compared are the lineweights of the objects` };
}

/** A company standard: a list of layers, or a .csv (name;color;linetype;lineweight;plot;role;description) or .json file. */
async function standardOf(arg) {
  if (!arg) return null;
  if (Array.isArray(arg)) return arg;
  const file = path.resolve(String(arg));
  const text = await fs.readFile(file, 'utf8');
  return /\.json$/i.test(file) ? JSON.parse(text) : readStandardCsv(text);
}

/** The layers of the current drawing mapped to the standard: the plan (dry run) or the plan carried out and checked. */
async function standardizeCurrent(args, lang) {
  const tool = 'standardize_layers';
  const before = await sendNow('layer_survey', {});
  const { ctb, note } = await ctbOf(before);
  const mapping = { ...(args.mapping || {}) };
  if (args.mapping_csv) Object.assign(mapping, readMappingCsv(await fs.readFile(path.resolve(args.mapping_csv), 'utf8')));
  const standard = await standardOf(args.standard);
  // the weight of "default" lineweights where this AutoCAD plots them (LWDEFAULT, 1/100 mm)
  let lwDefault = 0.25;
  try {
    const v = Number((await sendNow('run_lisp', { code: '(getvar "LWDEFAULT")' }))?.value);
    if (v > 0) lwDefault = v / 100;
  } catch {
    // keep 0.25
  }
  const plan = engine(tool, () => planLayers(before, { discipline: args.discipline, keepLook: args.keep_look ?? true, mapping, standard, unknown: args.unknown, ctb, lang, lwDefault }));
  const out = {
    drawing: before.drawing || undefined, discipline: plan.discipline, plot_style: note, summary: plan.summary,
    layers: plan.layers.slice(0, args.list ?? 60).map((l) => ({
      layer: l.layer, entities: l.entities, ...(l.in_blocks ? { in_blocks: l.in_blocks } : {}), purpose: l.role ?? undefined, read_from: l.by ?? undefined, action: l.action,
      to: Object.keys(l.targets).length ? l.targets : undefined, ...(l.kept ? { kept: l.kept } : {}),
    })),
    more_layers: plan.layers.length > (args.list ?? 60) ? plan.layers.length - (args.list ?? 60) : undefined,
    warnings: plan.warnings.length ? plan.warnings : undefined,
  };
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, planCsv(plan, { lang }), 'utf8');
    out.csv = file;
  }
  if (!args.apply) {
    out.dry_run = true;
    out.next = 'Nothing changed. Review the mapping (csv_path writes it for Excel: fill the column "to" where you disagree and give it back as mapping_csv), then call again with apply: true.';
    return out;
  }
  const r = await sendNow('layer_remap', { create: plan.create, props: plan.props, renames: plan.renames, rules: plan.rules, delete: plan.delete, current: plan.current ?? undefined });
  // checked against a new survey: nothing lost, every entity where the plan put it
  const after = await sendNow('layer_survey', {});
  const tally = (sv) => {
    const m = new Map();
    for (const g of sv.groups) if (g.space !== 'block') m.set(`${g.space}|${g.type}`, (m.get(`${g.space}|${g.type}`) ?? 0) + g.count);
    return m;
  };
  const a = tally(before), b = tally(after);
  const lost = [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0) !== (b.get(k) ?? 0)).map((k) => `${k}: ${a.get(k) ?? 0} -> ${b.get(k) ?? 0}`);
  // the layers that should be empty now: those moved away, not a target of the standard themselves
  const targets = new Set(plan.layers.flatMap((l) => Object.keys(l.targets)).map((n) => n.toLowerCase()));
  const moved = new Set(plan.layers.filter((l) => ['merge', 'split', 'rename'].includes(l.action) && !l.kept && !targets.has(l.layer.toLowerCase())).map((l) => l.layer.toLowerCase()));
  const left = after.groups.filter((g) => moved.has(g.layer.toLowerCase()) && !(g.space === 'block' && g.layer === '0')).reduce((n, g) => n + g.count, 0);
  const ov = after.groups.filter((g) => g.space !== 'block' && ((g.color !== 'bylayer' && g.color !== 'byblock') || !['bylayer', 'byblock'].includes(String(g.linetype).toLowerCase()) || (g.lineweight !== 'bylayer' && g.lineweight !== 'byblock'))).reduce((n, g) => n + g.count, 0);
  out.applied = {
    layers_before: before.layers.length, layers_after: after.layers.length, moved: r.moved, overrides_set: r.overrides_set, renamed: r.renamed?.length || undefined,
    created: r.created?.length || undefined, deleted: r.deleted?.length || undefined, kept: r.kept?.length ? r.kept : undefined, failed: r.failed || undefined,
    dimension_block_entities: r.dimension_block_entities || undefined,
    overrides_left: ov, entities_check: lost.length ? lost : 'every entity is still there (same count per space and type)',
    left_on_old_layers: left || undefined, relocked: r.relocked?.length ? r.relocked : undefined,
  };
  out.next = 'One Undo step: undo puts every layer back. Save the drawing (save_drawing) to keep it.';
  return out;
}

server.registerTool('standardize_layers', {
  description:
    'Make the layers of a drawing made by others consistent (chuẩn hóa layer): every entity of model space, the layouts and ' +
    'the block definitions goes to one standard set of layers (the A-/S-/E-/P- layers of these tools, or a company ' +
    'standard), by what it is: the purpose of its layer read from the name (Vietnamese with or without accents, English, ' +
    'Chinese, AIA-like codes such as A-Wall or A-Text-VN, the prefix of a bound xref dropped), the type of the entity ' +
    'where the name says nothing or says otherwise (a dimension goes to the dimension layer wherever it was), the block of ' +
    'an insert (a door, a level mark, a grid bubble, a title block), and the weight it plots with (from the .ctb of the ' +
    'layouts) for linework on layers named after a pen ("0.3", "net manh") or on layer 0. Colours, linetypes and ' +
    'lineweights set on the entities become ByLayer, except where the drawing would then plot otherwise (keep_look, ' +
    'default: a bold line stays bold, a dashed one dashed; keep_look false gives the weights of the standard everywhere); the ' +
    'target layers take the properties and spelling of the standard; layers that end up empty are purged; layer 0 inside blocks, Defpoints and ' +
    'xref layers are left as they are. Default dry run: returns the mapping layer by layer (csv_path writes it for Excel: ' +
    'fill the column "to" to correct a row and give it back as mapping_csv) and changes nothing; apply: true carries it out ' +
    'in one Undo step and checks that every entity is still there. files: several drawings at once, each opened read-only ' +
    'and saved as a new file in out_dir (the originals are never written).',
  inputSchema: {
    apply: z.boolean().default(false).describe('false (default): only the proposed mapping; true: carry it out'),
    discipline: z.enum(['auto', 'arch', 'struct']).default('auto').describe('Which annotation layers to use (A-ANNO-* or S-ANNO-*); auto: from the file name (KT / KC) or the layers'),
    keep_look: opt(z.union([z.boolean(), z.literal('exact')])).describe('true (default): the drawing plots as before - an override stays on an entity that the standard layer would plot in another class of weight (fine, thin, medium, thick) or turn from continuous to dashed or back; false: the weights and linetypes of the standard everywhere (the dry run counts what would plot otherwise); "exact": any other weight is kept too'),
    mapping: opt(Obj).describe('{"old layer": "new layer" | "keep" | "auto"}: your word over the proposal'),
    mapping_csv: opt(Str).describe('The CSV of csv_path with the column "to" filled where you disagree'),
    csv_path: opt(Str).describe('Write the proposed mapping (one row per layer) for Excel'),
    standard: opt(z.union([Specs, Str])).describe('A company standard: [{name, color, linetype, lineweight, plot, role, description}] or a .csv / .json file; a role it names (wall, door, window, dims, text, symbol, grid, column, beam, rebar, stirrup, hatch, detail, title, furniture...) takes its layer'),
    unknown: z.enum(['map', 'keep']).default('map').describe('Layers whose name says nothing: map their entities by type (default) or keep them'),
    files: opt(jsonish(z.array(Str))).describe('Several drawings: each opened read-only, standardised and saved in out_dir as <name><suffix>.dwg'),
    out_dir: opt(Str), suffix: z.string().default('-layer'),
    list: z.number().int().positive().default(60).describe('How many layers the result lists (the CSV has them all)'),
    language: opt(Lang),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const lang = args.language ?? language;
  if (!args.files?.length) return text(await standardizeCurrent(args, lang));
  if (args.apply && !args.out_dir) throw new Error('standardize_layers: give out_dir for the standardised copies (the originals are never written)');
  const results = [];
  for (const f of args.files) {
    const src = path.resolve(f);
    const dst = args.out_dir ? path.join(path.resolve(args.out_dir), `${path.basename(src, path.extname(src))}${args.suffix}.dwg`) : null;
    try {
      if (dst && dst.toLowerCase() === src.toLowerCase()) throw new Error('the copy would overwrite the original: change out_dir or suffix');
      await sendNow('open_drawing', { path: src, read_only: true });
      const r = await standardizeCurrent({ ...args, files: undefined, csv_path: args.csv_path ? path.join(path.resolve(args.csv_path), `${path.basename(src, path.extname(src))}-layers.csv`) : undefined }, lang);
      if (args.apply) {
        const saved = await sendNow('save_drawing', { path: dst, overwrite: true, copy: false });
        r.saved = saved.saved;
      }
      await sendNow('close_drawing', { discard: true }).catch(() => {});
      results.push({ file: src, ...r, layers: undefined, layers_listed: r.layers.length });
    } catch (e) {
      await sendNow('close_drawing', { path: src, discard: true }).catch(() => {});
      results.push({ file: src, error: e.message });
    }
  }
  return text({ files: results.length, done: results.filter((r) => !r.error).length, results });
}));

server.registerTool('quantity_takeoff', {
  description:
    'Quantity takeoff of the drawing (QS): per layer (or per block / type): count, length in m (lines, arcs, polylines, circles, ' +
    'splines), area in m² of closed polylines/circles/regions, hatch area in m² (separate, never add both), block counts, ' +
    'and for group_by=block the tally of attribute values. Filters as query_entities; selection_only uses the user\'s selection. ' +
    'csv_path saves the table for Excel (UTF-8).',
  inputSchema: {
    group_by: z.enum(['layer', 'block', 'type', 'layer_type']).default('layer'),
    ...FILTER,
    selection_only: z.boolean().default(false),
    csv_path: opt(Str).describe("Optional CSV file, e.g. 'D:/QS/plan_takeoff.csv'"),
    csv_format: z.enum(['comma', 'semicolon']).default('comma').describe(
      'semicolon = ";" separators and decimal commas, for Excel with Vietnamese/European regional settings'),
    language: opt(Lang),
  },
  annotations: READ,
}, async (args) => {
  const { csv_path, csv_format, language: lang, ...rest } = args;
  const r = await call('quantity_takeoff', rest);
  if (csv_path) {
    const H = CSV_HEAD[lang ?? language] || CSV_HEAD.vi;
    const key = r.group_by === 'layer_type' ? 'layer | type' : r.group_by;
    const sep = csv_format === 'semicolon' ? ';' : ',';
    const num = (v) => (typeof v === 'number' && csv_format === 'semicolon' ? String(v).replace('.', ',') : v);
    const row = (cells) => cells.map((c) => csvCell(num(c), sep)).join(sep);
    const lines = [row([H[r.group_by] ?? r.group_by, H.count, H.length, H.area, H.hatch, H.blocks])];
    for (const x of r.rows) lines.push(row([x[key], x.count, x.length_m, x.closed_area_m2, x.hatch_area_m2, x.blocks ?? x.attributes]));
    lines.push(row([H.total, r.entities, r.totals.length_m, r.totals.closed_area_m2, r.totals.hatch_area_m2, '']));
    const file = path.resolve(csv_path.endsWith('.csv') ? csv_path : `${csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, BOM + lines.join('\r\n') + '\r\n', 'utf8');
    r.csv = file;
  }
  return text(r);
});

server.registerTool('check_drawing', {
  description:
    'Drawing QA: stacked duplicates (they double quantities), polylines that look closed but are not, open polylines on area layers, ' +
    'Vietnamese/non-ASCII text in SHX styles (shows "?"), missing fonts, unresolved xrefs and images, objects on Defpoints (never ' +
    'plot), dimensions whose value was typed over, objects far from the rest (blow up zoom extents), tiny/empty objects, objects on ' +
    'layer 0, color/linetype/lineweight not ByLayer, objects on hidden layers, unitless drawing; plus layers outside the standard. ' +
    'Each issue has handles (first 20) to fix with set_properties/delete_entities.',
  inputSchema: { space: opt(Str).describe('all (default), model, paper or a layout name') },
  annotations: READ,
}, async ({ space }) => {
  const r = await call('check_drawing', { space });
  const layers = (await call('list_layers')).layers || [];
  const std = new Set(LAYERS.map((l) => l.name));
  const loose = layers.filter((l) => l.count > 0 && !std.has(l.name) && !/^[A-Z]-[A-Z]{4}/.test(l.name) && l.name !== '0' && !/^defpoints$/i.test(l.name) && !l.xref);
  if (loose.length) {
    r.issues.push({
      code: 'non_standard_layers', severity: 'info', count: loose.length,
      message: 'Layers in use that do not follow a discipline-group naming (e.g. A-WALL). Fine if the office has its own scheme.',
      layers: loose.slice(0, 30).map((l) => l.name),
    });
  }
  return text(r);
});

// ---------------------------------------------------------------- standards
server.registerTool('setup_layers', {
  description:
    'Create layers. standard="arch" creates the architectural set (AIA/NCS style, lineweights for monochrome plotting, descriptions ' +
    'in the user\'s language): S-GRID trục (CENTER), S-GRID-IDEN, S-COLS cột, S-COLS-PATT, S-BEAM dầm (HIDDEN), A-WALL tường cắt ' +
    '0.5, A-WALL-PATT hatch, A-DOOR cửa đi, A-GLAZ cửa sổ/kính, A-OPEN lỗ mở (HIDDEN), A-FLOR-STRS cầu thang, A-FLOR-LEVL, ' +
    'A-FLOR-PATT, A-FLOR-FIXT TBVS, A-FURN nội thất, A-EQPM, A-ROOF, A-ELEV, A-ELEV-OTLN, A-SECT, A-SECT-PATT, A-HIDD, ' +
    'A-AREA ranh diện tích (no plot), A-ANNO-ROOM, A-ANNO-TEXT, A-ANNO-DIMS, A-ANNO-SYMB, A-ANNO-TTLB khung tên, A-ANNO-VPRT ' +
    '(no plot), X-IMAGE ảnh tham chiếu (no plot), X-REF. standard="mep" adds the electrical and plumbing layers (E-LITE-SWCH, ' +
    'E-LITE-WIRE, E-POWR, E-POWR-WIRE, E-POWR-EQPM, E-COMM, E-GRND, E-ANNO-TEXT, P-DOMW-CWTR, P-DOMW-HWTR, P-SANR-SOIL, ' +
    'P-SANR-WAST, P-SANR-VENT, P-STRM, P-EQPM, P-ANNO-TEXT). layers adds/changes custom layers: {name, color (1-255, [r,g,b], ' +
    '"#rrggbb"), linetype, lineweight (mm), plot, description, transparency %, on, frozen, locked}. Existing layers are kept as ' +
    'they are unless update_existing=true (use that to turn layers on/off, freeze or lock). current sets the current layer.',
  inputSchema: {
    standard: z.enum(['arch', 'mep', 'none']).default('arch'),
    language: opt(Lang).describe('Language of the layer descriptions (default vi)'),
    layers: opt(Specs),
    update_existing: z.boolean().default(false),
    current: opt(Str),
  },
  annotations: EDIT_IDEMPOTENT,
}, async ({ standard, language: lang, layers, update_existing, current }) => {
  if (lang) language = lang;
  const list = [...(standard === 'none' ? [] : layerSpecs(lang ?? language, standard === 'mep')), ...(layers || [])];
  return text(await call('setup_layers', { layers: list, update_existing, current }));
});

server.registerTool('setup_styles', {
  description:
    'Set up the drawing for a plot scale 1:scale: units (mm), the text style MCP-ARIAL (TrueType Arial: Vietnamese shows correctly, ' +
    'no "?"), the dimension style MCP-1-<scale> (DIMSCALE=scale, text 2.5 mm on paper above the line, architectural ticks, ' +
    'no decimals, ByLayer colors), a multileader style of the same name, table text in MCP-ARIAL, and LTSCALE=0.4 x scale ' +
    '(PSLTSCALE off). All become current. Call once per drawing scale; draw_plan does it for its own scale.',
  inputSchema: {
    scale: z.number().positive().default(100).describe('Plot scale denominator: 50 for 1:50, 100 for 1:100'),
    units: z.enum(['mm', 'cm', 'm']).default('mm'),
    font: z.string().default('Arial').describe('TrueType font family, or an .shx file'),
    text_height: z.number().positive().default(2.5).describe('Dimension text height on paper (mm)'),
    arrow: z.enum(['tick', 'oblique', 'closed', 'dot', 'small_dot', 'open']).default('tick'),
    ltscale: z.union([z.number().positive(), z.enum(['auto', 'set', 'keep'])]).default('auto').describe(
      'auto (default): LTSCALE = 0.4 x scale only on a drawing with nothing in model space yet; a drawing that already has views ' +
      'keeps its LTSCALE (the views of these tools size their own dashes for their scale, and changing LTSCALE would break the ' +
      'views at other scales). set: 0.4 x scale anyway; keep: never; or a number'),
  },
  annotations: EDIT_IDEMPOTENT,
}, async ({ scale, units, font, text_height, arrow, ltscale }) => {
  const info = await call('drawing_info', {});
  const p = { ...styleParams({ scale, units, font, textHeight: text_height, arrow }) };
  const set = typeof ltscale === 'number' ? ltscale : ltscale === 'set' || (ltscale === 'auto' && !((info?.model_space_entities ?? 0) > 0)) ? p.ltscale : null;
  if (set === null) delete p.ltscale;
  else p.ltscale = set;
  const r = await call('setup_styles', p);
  if (set === null) r.ltscale_kept = `${info?.ltscale ?? 1} (the drawing already has views; ltscale: "set" or a number changes it)`;
  return text(r);
});

// ---------------------------------------------------------------- drawing
const ENTITY_DOC =
  'Each entity: {type, layer, color?, linetype?, lineweight?, ...}. Types and fields (points [x,y], angles in degrees):\n' +
  '- line {from, to} or {points:[...]} (one line per segment)\n' +
  '- polyline {points, closed?, bulges? (per vertex, arc segments), width? (symbols only, never for walls)}\n' +
  '- rectangle {from, to} or {corner, width, height, rotation?}\n' +
  '- circle {center, radius|diameter}; arc {center, radius, start_angle, end_angle} or {start, mid, end}\n' +
  '- ellipse {center, major_axis:[dx,dy], ratio, start_angle?, end_angle?}; spline {points, closed?}; point {at}\n' +
  '- text {at, text, height, rotation?, align (left|center|right|middle|top_left|...|bottom_right), style?}\n' +
  '- mtext {at, text (\\n = new line), height, width?, align (default top_left), style?}\n' +
  '- hatch {boundary:[pts] | boundaries:[[pts],[island]...] | boundary_handles, pattern (SOLID, ANSI31, ANSI37, AR-CONC, ' +
  'AR-SAND, AR-BRSTD, AR-PARQ1, AR-B816, NET, DOTS, GRAVEL, EARTH...), scale, angle}\n' +
  '- dimension {kind: linear|aligned|angular|radius|diameter, from, to, at (point on the dimension line) or offset, ' +
  'direction (horizontal|vertical|aligned|angle, linear), text? ("<>" = measured), style?}; angular {center, from, to, at}; ' +
  'radius/diameter {center, radius, angle}\n' +
  '- dim_chain {points (measured points), direction, at or offset, total? (adds the overall dimension), style?}\n' +
  '- leader {points (arrow first, text last), text, height?}\n' +
  '- block {name, at or points:[...] (several copies), scale?, rotation?, attributes?:{TAG: value}, file? (.dwg to load the ' +
  'block from), redefine?}\n' +
  '- table {at (top-left), rows:[[...],...], title?, col_widths?, row_height?, height?, col_align? ("right" | "center" | "left" | null per column)}\n' +
  'Text heights are in drawing units: paper height x scale (2.5 mm at 1:100 = 250). Use style "MCP-ARIAL" for Vietnamese text.';

async function pixelsToDrawing(handle, specs) {
  const info = await sendNow('image_info', { handle }); // already inside exclusive()
  const [x0, xa, xb] = info.pixel_to_drawing.x;
  const [y0, ya, yb] = info.pixel_to_drawing.y;
  const k = info.units_per_pixel;
  const tp = (p) => [x0 + xa * p[0] + xb * p[1], y0 + ya * p[0] + yb * p[1]];
  const POINT = ['at', 'from', 'to', 'center', 'corner', 'start', 'mid', 'end'];
  const LIST = ['points', 'boundary'];
  return specs.map((s) => {
    const o = { ...s };
    for (const key of POINT) if (Array.isArray(o[key])) o[key] = tp(o[key]);
    for (const key of LIST) if (Array.isArray(o[key])) o[key] = o[key].map(tp);
    if (Array.isArray(o.boundaries)) o.boundaries = o.boundaries.map((l) => l.map(tp));
    for (const key of ['radius', 'diameter']) if (typeof o[key] === 'number') o[key] *= k;
    if (o.type === 'rectangle') for (const key of ['width', 'height']) if (typeof o[key] === 'number') o[key] *= k;
    return o;
  });
}

server.registerTool('draw_entities', {
  description:
    'Draw a batch of entities in one Undo step (if one spec is invalid nothing is drawn and the error names it). ' +
    'Missing layers are created (standard layers with their standard properties). Returns each entity\'s handle and the bounds.\n' +
    ENTITY_DOC + '\nimage_handle: points (and radius/rectangle sizes) are given in pixels of that attached image (x right, y down ' +
    'from its top-left corner) and converted to drawing coordinates, for tracing over a reference image.',
  inputSchema: {
    entities: Specs,
    space: z.enum(['model', 'current']).default('model').describe('model (default) or the current space (a layout when one is active)'),
    image_handle: opt(z.union([z.string(), z.number()]).transform(String)),
    language: opt(Lang),
    revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, ({ entities, space, image_handle, language: lang, revision, scale }) => exclusive(async () => {
  const specs = image_handle ? await pixelsToDrawing(image_handle, entities) : entities;
  const out = await sendNow('draw_entities', withStyles({ entities: specs, space, language: lang }));
  const rev = editRevisionOf(revision);
  if (rev && space !== 'current') {
    const handles = (out.results || []).flatMap((r) => r.handles || (r.handle ? [r.handle] : []));
    await cloudEdit(out, rev, await boxesOf(handles, sendNow), scale, sendNow);
  }
  return text(out);
}));

server.registerTool('draw_plan', {
  description:
    'Draw a complete floor plan in one Undo step from a plan description in mm (read from an image, a sketch or a 3D model):\n' +
    '- walls: [{id?, points:[[x,y],...] (wall AXIS), thickness (200), justify: center|left|right (side of the axis, looking ' +
    'along it), closed?, material: brick|concrete|block|light|stone|solid|none}] -> clean L/T/X junctions (wall pieces are ' +
    'unioned), cut outline on A-WALL 0.5, material hatch on A-WALL-PATT\n' +
    '- openings: [{wall (id or index), segment (0 = first axis segment), offset (from the segment start to the opening edge) ' +
    'or at (centre point), width, type: door|double_door|sliding|window|opening, toward:[x,y] (point the door swings to, e.g. ' +
    'inside the room) or side: left|right, hinge: start|end, tag? ("D1"), tag_at? (tag position when the automatic one ' +
    'collides)}] -> wall cut, leaf + swing arc, window lines; door tags go opposite the swing, window tags outside\n' +
    '- columns: [{at, size:[w,h] or diameter, rotation?, pattern?}] and/or grid_columns {size} (a column at every grid ' +
    'intersection): cut out of the walls, solid hatch\n' +
    '- grids: {x:[0, 6000, ...] or [{at, label}], y:[...], bubbles: both|start|end} -> axes 1,2,3 (x) and A,B,C (y)\n' +
    '- rooms: [{name, at (point inside), number?, hatch?:{pattern, scale}}] -> area MEASURED from the walls, label "name / ' +
    'xx,xx m²" on A-ANNO-ROOM, closed boundary on A-AREA (not plotted). A room not closed by walls gets a warning; ' +
    'unlabelled_spaces lists closed spaces without a room.\n' +
    '- stairs: [{start (middle of the first tread edge), direction (deg, 90 = up the page), width, treads, going, label?}] or ' +
    'U stairs [{type: "u", region: [[x0,y0],[x1,y1]] (stairwell), direction: up|down|left|right (flight 1 going up), turn: ' +
    'left|right (side of flight 2), gap: 100, risers?}] -> two flights, half landing, treads, LÊN/XUỐNG walking lines, cut line\n' +
    '- balconies: [{region (slab outside the walls), railing: 1100}] -> slab edge and railing\n' +
    '- floors (a building of several storeys): [{name, height (3600 ground floor, 3300 above), level?, walls (default: the ' +
    'floor below), columns, openings, rooms, stairs, balconies, levels, parapet: {walls: [ids of the floor below], height: ' +
    '1000} (roof terrace), roof {type: flat|gable...}, slab: 120}] with grids, heights, sections, north shared: one plan per ' +
    'floor side by side, titled; a U stair arrives on the floor above (drawn going down there); draw_elevation / ' +
    'draw_section stack the floors; the interior tools take floor.\n' +
    '- levels: [{at, value: "+0.000"}], sections: [{from, to, label, look: left|right}], north: {at, angle}\n' +
    '- dimensions: sides list (default ["bottom","left"]; ["bottom","left","top","right"]; false = none): chains of exterior ' +
    'openings/wall corners, grid spacing and overall size\n' +
    '- entities: extra draw_entities specs (furniture, fixtures, notes) drawn in the same step\n' +
    '- scale (100 = 1:100: text, symbols and hatch sizes), language vi|en, layers: {role: existing layer name} to follow the ' +
    'drawing\'s own scheme (roles: wall, wall_hatch, door, window, opening, column, column_hatch, grid, grid_tag, dims, ' +
    'room_tag, area, stair, text, symbol, floor_hatch).\n' +
    'Sets up MCP-ARIAL and the MCP-1-<scale> dimension style first. Returns wall handles, rooms with measured area_m2 and ' +
    'perimeter_m, unlabelled_spaces, entity handles and bounds. Check with screenshot afterwards. The plan description ' +
    '(with heights and roofs for draw_elevation / draw_section) is remembered while the server runs.',
  inputSchema: {
    walls: opt(Specs), openings: opt(Specs), columns: opt(Specs), grid_columns: opt(Obj), grids: opt(Obj),
    rooms: opt(Specs), stairs: opt(Specs), levels: opt(Specs), sections: opt(Specs), north: opt(Obj),
    balconies: opt(Specs), floors: opt(Specs).describe('Several storeys: see floors above'),
    dimensions: opt(jsonish(z.union([z.boolean(), z.array(z.enum(['bottom', 'left', 'top', 'right']))]))),
    interior_dimensions: z.boolean().default(false).describe('Interior dimensions (not the stairwells): the clear width and length of each room, wall face to wall face, on a line clear of the names, doors, tags, level marks and stairs; rooms with no clear line are listed in notes'),
    entities: opt(Specs),
    scale: z.number().positive().default(100),
    wall_thickness: opt(z.number().positive()), wall_material: opt(Str), hatch_walls: z.boolean().default(true),
    room_options: opt(Obj).describe('{decimals: 2, decimal_separator: "," (vi) or ".", boundary: true, text_height: 2.5 (paper mm)}'),
    layers: opt(Obj),
    language: opt(Lang),
    heights: opt(Obj).describe('For draw_elevation/draw_section, see there'),
    roofs: opt(Specs).describe('For draw_elevation/draw_section, see there'),
    dry_run: z.boolean().default(false).describe('Check the description and list the defaults it would assume, without drawing'),
  },
  annotations: EDIT,
}, async ({ dry_run, ...args }) => {
  if (Array.isArray(args.floors) && args.floors.length) return drawBuilding(args, dry_run);
  let plan;
  try {
    plan = buildPlan({ ...args, language: args.language ?? language });
  } catch (e) {
    if (e instanceof PlanError) throw new Error(`draw_plan: ${e.message}`);
    throw e;
  }
  lastPlan = keptPlan(args);
  lastFloors = null;
  if (dry_run) {
    const hw = heightWarnings(args.heights);
    return dryRun(plan.assumed, {
      walls: plan.walls.length, openings: (args.openings || []).length, rooms: plan.rooms.length, entities: plan.entities.length,
      notes: plan.notes.length ? plan.notes : undefined, warnings: hw.length ? hw : undefined,
    });
  }
  const info = await call('drawing_info', {});
  const sc = args.scale ?? 100;
  const styles = stylesAt(sc, info);
  const dashed = (ents) => ents.map((e) => ([ROLE.grid, ROLE.opening, ROLE.hidden, ROLE.beam].includes(e.layer) ? { ...e, scale_linetype: true } : e));
  const req = withStyles({
    walls: plan.walls, cuts: plan.cuts, columns: plan.columns, rooms: plan.rooms, room_options: plan.room_options,
    entities: styles.ltscale === undefined ? sizeLinetypes(dashed(plan.entities), sc, info.ltscale) : plan.entities, language: args.language,
    styles,
  });
  const r = await call('draw_plan', req);
  if (plan.notes.length) r.notes = plan.notes;
  if (plan.assumed.length) r.assumed = plan.assumed;
  const hw = heightWarnings(args.heights);
  if (hw.length) r.warnings = [...(r.warnings || []), ...hw];
  return text(r);
});

/**
 * draw_plan of a building: the plan of every floor (titled MẶT BẰNG <floor>) side by side in one Undo step; the
 * floors' positions are remembered for the interior tools.
 */
async function drawBuilding(args, dryRunOnly) {
  const lang = args.language ?? language;
  const scale = args.scale ?? 100;
  const floors = engine('draw_plan', () => floorsOf(args));
  const plans = floors.map((f) => engine('draw_plan', () => buildPlan({ ...f.spec, language: lang })));
  const B = engine('draw_plan', () => buildBuilding(args));
  const assumed = [
    ...floors.flatMap((f) => planAssumptions(f.spec).map((a) => ({ ...a, item: `${f.name}.${a.item}` }))),
    ...buildingAssumed(args, B),
  ];
  const notes = plans.flatMap((p, i) => p.notes.map((n) => `${floors[i].name}: ${n}`));
  const summary = floors.map((f, i) => ({ name: f.name, level: f.level, height: f.height, walls: plans[i].walls.length, rooms: plans[i].rooms.length }));
  lastPlan = keptPlan(args);
  const widths = plans.map((p) => {
    const b = entityBounds(p.entities);
    return b ? b.max[0] - b.min[0] : 20000;
  });
  // a plan that replaces an earlier one keeps the pitch of its floors while they still clear each other, so the
  // sheets of the floors keep showing them
  const vctx = viewStore.getStore();
  const was = vctx?.old?.extra?.floors?.offsets?.[1]?.[0];
  const pitch = was && was >= Math.max(...widths) + 12 * scale ? was : Math.max(...widths) + 30 * scale;
  const offsets = floors.map((f, i) => [i * pitch, 0]);
  lastFloors = { offsets, names: floors.map((f) => f.name) };
  if (vctx) vctx.extra.floors = lastFloors;
  const hw = [...heightWarnings(args.heights), ...(args.floors || []).flatMap((f, i) => heightWarnings(f?.heights, `floors[${i}].heights`))];
  if (dryRunOnly) return dryRun(assumed, { floors: summary, notes: notes.length ? notes : undefined, warnings: hw.length ? hw : undefined });
  const shifted = floors.map((f, i) => engine('draw_plan', () => buildPlan({ ...shiftSpec(f.spec, offsets[i], true), language: lang })));
  const entities = [];
  // titles on one line under the lowest plan
  const bounds = shifted.map((p) => entityBounds(p.entities));
  const yTitle = Math.min(...bounds.map((b) => b.min[1]));
  for (const [i, p] of shifted.entries()) {
    entities.push(...p.entities);
    const b = bounds[i];
    const cx = (b.min[0] + b.max[0]) / 2;
    entities.push(...viewTitle(lang === 'en' ? `${floors[i].name} PLAN` : `MẶT BẰNG ${floors[i].name}`, cx, yTitle - 14 * scale, scale, ROLE.text, lang));
  }
  const info = await call('drawing_info', {});
  const styles = stylesAt(scale, info);
  const dashed = (ents) => ents.map((e) => ([ROLE.grid, ROLE.opening, ROLE.hidden, ROLE.beam].includes(e.layer) ? { ...e, scale_linetype: true } : e));
  const req = withStyles({
    walls: shifted.flatMap((p) => p.walls), cuts: shifted.flatMap((p) => p.cuts), columns: shifted.flatMap((p) => p.columns),
    rooms: shifted.flatMap((p) => p.rooms), room_options: shifted[0].room_options,
    entities: styles.ltscale === undefined ? sizeLinetypes(dashed(entities), scale, info.ltscale) : entities, language: args.language,
    styles,
  });
  const r = await call('draw_plan', req);
  // the rooms come back in the order sent: floor by floor
  let k = 0;
  const out = floors.map((f, i) => {
    const n = shifted[i].rooms.length;
    const rooms = (r.rooms || []).slice(k, k + n);
    k += n;
    return { name: f.name, level: f.level, height: f.height, offset: offsets[i], rooms };
  });
  return text({
    floors: out, count: r.count, bounds: r.bounds, unlabelled_spaces: r.unlabelled_spaces,
    notes: notes.length ? notes : undefined, assumed: assumedOrNone(assumed), warnings: hw.length ? hw : undefined,
  });
}

server.registerTool('define_block', {
  description:
    'Define (or with replace=true redefine) a block from entity specs (same format as draw_entities, relative to base). Contents ' +
    'go on layer 0 unless a layer is given, so each insert takes its own layer. attributes: [{tag, prompt?, default?, at, ' +
    'height, align?: center|middle_center, invisible?}]. Use blocks for repeated items (doors, furniture, fixtures, title marks); ' +
    'insert with draw_entities type=block.',
  inputSchema: {
    name: Str, base: opt(Point), entities: Specs, attributes: opt(Specs), description: opt(Str),
    replace: z.boolean().default(false),
  },
  annotations: EDIT,
}, async (args) => text(await call('define_block', withStyles(args))));

server.registerTool('transform_entities', {
  description:
    'Edit entities by handle (one Undo step): op=move {vector or from/to}, copy {vector or from/to, count?}, rotate {center, ' +
    'angle}, scale {base, factor}, mirror {from, to (mirror line), keep_original=true}, array_rect {rows, cols, row_spacing, ' +
    'col_spacing}, array_polar {center, count, angle (total, 360), rotate_items}, offset {distance, toward:[x,y] (side) or ' +
    'both_sides}, explode (blocks/polylines/dimensions; block attribute values are kept as text). Returns created handles.',
  inputSchema: {
    handles: Handles.describe(HANDLES_DESC),
    op: z.enum(['move', 'copy', 'rotate', 'scale', 'mirror', 'array_rect', 'array_polar', 'offset', 'explode']),
    vector: opt(Point), from: opt(Point), to: opt(Point), count: opt(z.number().int()),
    center: opt(Point), angle: opt(z.number()), base: opt(Point), factor: opt(z.number()),
    keep_original: opt(z.boolean()), rows: opt(z.number().int()), cols: opt(z.number().int()),
    row_spacing: opt(z.number()), col_spacing: opt(z.number()), rotate_items: opt(z.boolean()),
    distance: opt(z.number()), toward: opt(Point), both_sides: opt(z.boolean()),
    revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, async ({ revision, scale, ...args }) => {
  const rev = editRevisionOf(revision);
  // the places before (what moved away) and after (where it went, what was made)
  const kept = ['copy', 'array_rect', 'array_polar', 'offset'].includes(args.op) || (args.op === 'mirror' && args.keep_original !== false);
  const before = rev && !kept ? await boxesOf(args.handles) : [];
  const out = await call('transform_entities', args);
  if (rev) {
    const after = await boxesOf([...(kept || args.op === 'explode' ? [] : args.handles), ...(out.created || [])]);
    await cloudEdit(out, rev, [...before, ...after], scale);
  }
  return text(out);
});

server.registerTool('set_properties', {
  description:
    'Change entity properties by handle (one Undo step): layer (created if missing), color ("bylayer", 1-255, [r,g,b]), ' +
    'linetype, lineweight (mm or "bylayer"), ltscale, transparency %, text (text/mtext/dimension override/leader), height, ' +
    'rotation, closed (polylines), attributes {TAG: value} (blocks).',
  inputSchema: {
    handles: Handles.describe(HANDLES_DESC),
    layer: opt(Str), color: opt(z.union([z.string(), z.number(), z.array(z.number())])), linetype: opt(Str),
    lineweight: opt(z.union([z.string(), z.number()])), ltscale: opt(z.number().positive()), transparency: opt(z.number()),
    text: opt(Str), height: opt(z.number().positive()), rotation: opt(z.number()), closed: opt(z.boolean()),
    attributes: opt(Obj),
    revision: EditRevisionArg, scale: EditScaleArg,
  },
  annotations: EDIT,
}, async ({ revision, scale, ...args }) => {
  const rev = editRevisionOf(revision);
  const before = rev ? await boxesOf(args.handles) : [];
  const out = await call('set_properties', withStyles(args));
  if (rev) await cloudEdit(out, rev, [...before, ...(await boxesOf(args.handles))], scale);
  return text(out);
});

server.registerTool('delete_entities', {
  description: 'Delete entities by explicit handle (never by selection). One Undo step. With revision, the places they took are clouded.',
  inputSchema: { handles: Handles.describe(HANDLES_DESC), revision: EditRevisionArg, scale: EditScaleArg },
  annotations: DESTRUCTIVE,
}, async ({ handles, revision, scale }) => {
  const rev = editRevisionOf(revision);
  const before = rev ? await boxesOf(handles) : [];
  const out = await call('delete_entities', { handles });
  if (rev) await cloudEdit(out, rev, before, scale);
  return text(out);
});

bridgeTool('select_entities',
  'Select entities in AutoCAD (grips) so the user can see them; empty handles clears the selection.',
  { handles: opt(Handles) }, EDIT_IDEMPOTENT);

bridgeTool('undo',
  'Undo the last AutoCAD step(s) (each tool edit is one step). Undoes whatever is last in AutoCAD, so only use it right after ' +
  'your own edit.',
  { steps: z.number().int().min(1).max(50).default(1) }, DESTRUCTIVE);

server.registerTool('purge_drawing', {
  description:
    'Purge unused layers, blocks, linetypes, text and dimension styles, registered apps (repeats for nested items). Standard ' +
    'layers are kept even when empty (keep_standard_layers). dry_run=true only lists what would go.',
  inputSchema: { dry_run: z.boolean().default(false), keep_standard_layers: z.boolean().default(true), keep_layers: opt(jsonish(z.array(Str))) },
  annotations: DESTRUCTIVE,
}, async ({ dry_run, keep_standard_layers, keep_layers }) => text(await call('purge_drawing', {
  dry_run, keep_layers: [...(keep_standard_layers ? LAYERS.map((l) => l.name) : []), ...(keep_layers || [])],
})));

// ---------------------------------------------------------------- run LISP
server.registerTool('run_lisp', {
  description:
    'Run AutoLISP in AutoCAD and return the value of the last expression (lists come back as JSON arrays, entities as ' +
    '"<entity handle>"). The code runs as one Undo group; errors come back as "LISP error: ...". (command ...) works. Use it only ' +
    'when no tool fits (e.g. AutoCAD commands such as OVERKILL, BOUNDARY, FLATSHOT, specific system variables). Never wait for ' +
    'user input (getpoint etc.).',
  inputSchema: {
    code: Str.describe('AutoLISP code, one or more expressions, e.g. (getvar "INSUNITS")'),
    undo_group: z.boolean().default(true),
  },
  annotations: { ...DESTRUCTIVE, openWorldHint: false },
}, async ({ code, undo_group }) => {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === ';') { while (i < code.length && code[i] !== '\n') i++; }
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth < 0) break;
  }
  if (depth !== 0 || inStr) throw new Error(`run_lisp: unbalanced ${inStr ? 'string quotes' : 'parentheses'} in the code (depth ${depth}).`);
  return text(await call('run_lisp', { code, undo_group }));
});

// ---------------------------------------------------------------- views, images, screenshots
const ViewName = z.enum(['current', 'extents', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso', 'iso_se', 'iso_sw', 'iso_ne', 'iso_nw']);

bridgeTool('set_view',
  'Zoom/frame the user\'s view: view=extents (default) or a direction (top, front, iso...); window [[x1,y1],[x2,y2]] or handles ' +
  'frame that area. Changes what the user sees.',
  { view: ViewName.default('extents'), window: opt(Window), handles: opt(Handles), margin: z.number().min(0).max(1).default(0.05) },
  EDIT_IDEMPOTENT);

async function imageFrom(cmd, params, label, savePath) {
  const file = path.join(os.tmpdir(), `autocad_mcp_${process.pid}_${randomUUID()}.png`);
  try {
    const r = await sendNow(cmd, { ...params, [cmd === 'view_image' ? 'out_path' : 'path']: file }, label);
    let data;
    try {
      data = await fs.readFile(file);
    } catch {
      throw new AcadError(`AutoCAD could not write the image (${JSON.stringify(r)}).`);
    }
    if (savePath) {
      const out = path.resolve(/\.png$/i.test(savePath) ? savePath : `${savePath}.png`);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, data);
      r.saved = out;
    }
    return { content: [{ type: 'image', data: data.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify(r) }] };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
    setTimeout(() => { fs.rm(file, { force: true }).catch(() => {}); }, (TIMEOUT + 60) * 1000).unref();
  }
}

server.registerTool('screenshot', {
  description:
    'Render the drawing to an image Claude sees (off-screen: the user\'s view is not changed), white background like a plot. ' +
    'view=extents (default) frames all of model space, window/handles frame that area, current = exactly what the user sees, ' +
    'or a direction (top, front, iso...) for 3D. space=current renders the active layout instead of model space. Use after ' +
    'every larger edit and compare with the source image. save_path also writes the PNG to a file (an image export, up to ' +
    '4096 px with max_size).',
  inputSchema: {
    view: opt(ViewName).describe('Default: extents (or the window/handles area)'),
    window: opt(Window), handles: opt(Handles),
    max_size: z.number().int().min(64).max(4096).default(1400),
    space: z.enum(['model', 'current']).default('model'),
    margin: z.number().min(0).max(1).default(0.04),
    save_path: opt(Str).describe("Optional PNG file, e.g. 'D:/Export/plan.png'"),
  },
  annotations: READ,
}, ({ save_path, ...args }) => exclusive(() => imageFrom('screenshot', { ...args, view: args.view ?? 'extents' }, 'screenshot', save_path)));

server.registerTool('view_image', {
  description:
    'Look at an image file (plan scan, photo, sketch, render; png/jpg/bmp/tif/gif) and return it to Claude, optionally a crop ' +
    '[x0,y0,x1,y1] in original pixels (zoom into details to read dimensions) and a pixel grid with coordinate labels (grid=true ' +
    'or a step in pixels) to read positions for calibration and tracing. Needs AutoCAD with the bridge running.',
  inputSchema: {
    path: Str,
    crop: opt(jsonish(z.array(z.number()).length(4))),
    grid: opt(z.union([z.boolean(), z.number().int().positive()])),
    max_size: z.number().int().min(64).max(4096).default(1568),
  },
  annotations: READ,
}, (args) => exclusive(() => imageFrom('view_image', { ...args, path: path.resolve(args.path) }, 'view_image')));

server.registerTool('attach_image', {
  description:
    'Attach an image (scan/photo of a plan, a render, a SketchUp export) as a faded underlay to draw over, on layer X-IMAGE ' +
    '(not plotted), sent to the back. Scale: calibrate {p1:[px,py], p2:[px,py], distance} = two pixels of a known dimension ' +
    'and its real length in drawing units (best), or width (drawing units of the whole image width), or units_per_pixel. ' +
    'Position: anchor {pixel:[px,py], at:[x,y]} puts a pixel (e.g. grid A-1) on a drawing point, else the bottom-left corner ' +
    'at "at". Returns pixel_to_drawing (x = x0 + x1*px + x2*py, y likewise), used by draw_entities image_handle.',
  inputSchema: {
    path: Str,
    calibrate: opt(Obj), width: opt(z.number().positive()), units_per_pixel: opt(z.number().positive()),
    anchor: opt(Obj), at: opt(Point), rotation: z.number().default(0),
    fade: z.number().int().min(0).max(90).default(40),
    layer: z.string().default(ROLE.image),
    name: opt(Str).describe('Name of the image definition (default the file name, made unique beside another file of that name)'),
    reload: z.boolean().default(true).describe('The same file attached again (a render written again): read it again'),
  },
  annotations: EDIT,
}, async (args) => text(await call('attach_image', withStyles({ ...args, path: path.resolve(args.path) }))));

/** A LISP string literal (paths with forward slashes). */
const lispStr = (s) => `"${String(s).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;

server.registerTool('manage_images', {
  description:
    'Manage the images attached to the drawing (ảnh chèn: render, ảnh nền): list (name, file, loaded, references), unload ' +
    '(AutoCAD lets go of the file, so a render can write it again), reload (read the file again after it changed), replace ' +
    '(point the image at another file, then reload: every reference of that image follows), detach (remove the image ' +
    'definition and all its references), purge (detach the definitions no image uses any more: what delete_entities leaves). ' +
    'The image by handle (of a reference) or name (of the definition). To refresh a render: unload, write the PNG, reload.',
  inputSchema: {
    action: z.enum(['list', 'unload', 'reload', 'replace', 'detach', 'purge']),
    handle: opt(z.union([Str, z.number()]).transform(String)), name: opt(Str), path: opt(Str),
  },
  annotations: EDIT,
}, async ({ action, handle, name, path: file }) => {
  // the image dictionary holds pairs (3 . name) (350 . def): read the names in order
  const listDefs = async () => {
    const code = `(progn (setq r nil) (setq d (dictsearch (namedobjdict) "ACAD_IMAGE_DICT")) (setq ss (ssget "_X" '((0 . "IMAGE"))))
      (setq nm nil)
      (if d (foreach x d (cond ((= (car x) 3) (setq nm (cdr x)))
        ((and (= (car x) 350) nm) (setq e (cdr x)) (setq ed (entget e)) (setq n 0)
          (if ss (progn (setq i 0) (repeat (sslength ss) (if (equal (cdr (assoc 340 (entget (ssname ss i)))) e) (setq n (1+ n))) (setq i (1+ i)))))
          (setq r (cons (list nm (cdr (assoc 1 ed)) (cdr (assoc 280 ed)) n) r)) (setq nm nil)))))
      (reverse r))`;
    const v = (await call('run_lisp', { code })).value || [];
    return v.map((x) => ({ name: x[0], file: x[1], loaded: Number(x[2]) === 1, references: Number(x[3]) }));
  };
  if (action === 'list') return text({ images: await listDefs() });
  if (action === 'purge') {
    const unused = (await listDefs()).filter((d) => d.references === 0);
    for (const d of unused) await call('run_lisp', { code: `(command "_.-IMAGE" "_Detach" ${lispStr(d.name)})` });
    return text({ detached: unused.map((d) => d.name) });
  }
  let nm = name;
  if (!nm && handle) nm = (await call('run_lisp', { code: `(vla-get-Name (vlax-ename->vla-object (handent ${lispStr(handle)})))` })).value;
  if (!nm) throw new Error('manage_images: give the handle of an image or the name of its definition');
  const defs = await listDefs();
  const def = defs.find((d) => d.name.toLowerCase() === String(nm).toLowerCase());
  if (!def) throw new Error(`manage_images: no image named "${nm}" (images: ${defs.map((d) => d.name).join(', ') || 'none'})`);
  const q = lispStr(def.name);
  if (action === 'unload') await call('run_lisp', { code: `(command "_.-IMAGE" "_Unload" ${q})` });
  else if (action === 'reload') await call('run_lisp', { code: `(command "_.-IMAGE" "_Reload" ${q})` });
  else if (action === 'detach') await call('run_lisp', { code: `(command "_.-IMAGE" "_Detach" ${q})` });
  else if (action === 'replace') {
    if (!file) throw new Error('manage_images: replace needs path (the new image file)');
    const f = path.resolve(file);
    await fs.access(f).catch(() => { throw new Error(`manage_images: no file ${f}`); });
    await call('run_lisp', { code: `(progn (command "_.-IMAGE" "_Path" ${q} ${lispStr(f)}) (command "_.-IMAGE" "_Reload" ${q}))` });
  }
  const after = (await listDefs()).find((d) => d.name === def.name);
  return text({ action, image: after ?? { name: def.name, detached: true } });
});

server.registerTool('import_drawing', {
  description:
    'Insert a DWG/DXF file into the drawing as a block (or exploded): e.g. a 2D export of a SketchUp/Revit plan, section or ' +
    'elevation to clean up and annotate, a standard detail, a site plan. layer_prefix renames the file\'s layers (e.g. "X-SU-") ' +
    'so they do not mix with yours. Check the size afterwards (units of the source).',
  inputSchema: {
    path: Str, at: opt(Point), scale: z.number().positive().default(1), rotation: z.number().default(0),
    explode: z.boolean().default(false), layer_prefix: opt(Str), block_name: opt(Str), layer: opt(Str),
  },
  annotations: EDIT,
}, async (args) => text(await call('import_drawing', { ...args, path: path.resolve(args.path) })));

// ---------------------------------------------------------------- sheets and files
/** create_layout with several viewports: each window at its scale, packed in rows (bottoms aligned) in the drawing area. */
async function layoutViews({ name, paper, orientation, views, title_block, lang, replace, activate, info0 }) {
  const lng = lang ?? language;
  const unitsPerMm = { m: 0.001, cm: 0.1 }[info0.units] ?? 1;
  const { areas } = titleBlock({ paper, orientation, info: {}, language: lng, style: title_block?.style });
  const area = areas.map((a) => ({ a, s: (a[1][0] - a[0][0]) * (a[1][1] - a[0][1]) })).sort((p, q) => q.s - p.s)[0].a;
  const [ax0, ay0, ax1, ay1] = [area[0][0], area[0][1], area[1][0], area[1][1]];
  const aw = ax1 - ax0, ah = ay1 - ay0, gap = 10;
  const vs = views.map((v, i) => {
    const ww = Math.abs(v.window[1][0] - v.window[0][0]), wh = Math.abs(v.window[1][1] - v.window[0][1]);
    if (ww <= 0 || wh <= 0) throw new Error(`create_layout: views[${i}].window is empty.`);
    const f = 1 / (v.scale * unitsPerMm);
    return { ...v, f, w: ww * f, h: wh * f };
  });
  const warnings = [];
  const auto = vs.filter((v) => !v.at);
  const rows = [];
  for (const v of auto) {
    const row = rows[rows.length - 1];
    const rw = row ? row.reduce((s, x) => s + x.w, 0) + gap * row.length : 0;
    if (!row || rw + v.w > aw + 1e-6) rows.push([v]);
    else row.push(v);
  }
  const rowH = rows.map((r) => Math.max(...r.map((v) => v.h)));
  const totalH = rowH.reduce((s, h) => s + h, 0) + gap * Math.max(0, rows.length - 1);
  if (totalH > ah + 1e-6 || rows.some((r) => r.reduce((s, x) => s + x.w, 0) + gap * (r.length - 1) > aw + 1e-6)) {
    warnings.push(`the views do not fit on ${paper} ${orientation} at their scales: they overlap or leave the drawing area. Use a larger paper, smaller scales or fewer views.`);
  }
  let top = ay1 - Math.max(0, (ah - totalH) / 2);
  rows.forEach((r, i) => {
    const w = r.reduce((s, x) => s + x.w, 0) + gap * (r.length - 1);
    let x = ax0 + Math.max(0, (aw - w) / 2);
    const bottom = top - rowH[i];
    for (const v of r) {
      v.at = [x + v.w / 2, bottom + v.h / 2];
      x += v.w + gap;
    }
    top = bottom - gap;
  });
  const scales = [...new Set(vs.map((v) => v.scale))];
  const d = new Date();
  const date = lng === 'en' ? d.toISOString().slice(0, 10) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const asShown = lng === 'en' ? 'AS SHOWN' : 'NHƯ HÌNH';
  const info = { scale: scales.length === 1 ? FIELD.viewportScale : asShown, number: FIELD.layoutName, date, ...(title_block || {}) };
  const sheet = titleBlock({ paper, orientation, info, language: lng, style: title_block?.style });
  const req = withStyles({
    name, paper, orientation, replace, activate,
    entities: sheet.entities,
    styles: { text_style: styleParams({ scale: scales[0] }).text_style },
    viewports: vs.map((v) => ({
      center: v.at.map((c) => Math.round(c * 100) / 100), width: v.w, height: v.h,
      view_center: [(v.window[0][0] + v.window[1][0]) / 2, (v.window[0][1] + v.window[1][1]) / 2], scale_factor: v.f,
    })),
  });
  req.styles.text_style.set_current = false;
  const r = await sendNow('create_layout', req);
  const scaleText = scales.length === 1 ? `1:${scales[0]}` : asShown;
  const list = sheetsMade.get(info0.name) ?? [];
  sheetsMade.set(info0.name, [...list.filter((x) => x.layout !== name), {
    layout: name, number: title_block?.number ?? name, title: title_block?.title ?? '', scale: scaleText, paper: `${paper} ${lng === 'en' ? orientation : orientation === 'portrait' ? 'đứng' : 'ngang'}`,
  }]);
  return { ...r, scale: scaleText, views: vs.map((v) => ({ scale: `1:${v.scale}`, at: v.at.map((c) => Math.round(c)) })), paper, orientation, ...(warnings.length ? { warnings } : {}) };
}

server.registerTool('create_layout', {
  description:
    'Create a sheet: a layout on ISO paper (A0-A4) for "DWG To PDF.pc3" with monochrome.ctb, a frame and title block (TCVN/ISO ' +
    'margins, 180 mm title block: company, project, client, drawing title, scale, date, drawn/checked by, drawing no., revision, ' +
    'sheet) and a locked viewport showing a model window at a standard scale (auto-fitted if scale is omitted). replace=true ' +
    'rebuilds a layout of the same name. Export with export_pdf.',
  inputSchema: {
    name: Str,
    paper: z.enum(['A0', 'A1', 'A2', 'A3', 'A4']).default('A3'),
    orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    window: opt(Window).describe('Model area to show; default: drawing extents'),
    scale: opt(z.number().positive()).describe('100 = 1:100; default: largest standard scale that fits'),
    views: opt(z.array(z.object({ window: opt(Window), view: opt(Str), margin: opt(z.number().min(0)), scale: z.number().positive(), at: opt(Point) }))).describe(
      'Several viewports on the sheet instead of window/scale, each a model window at its own scale (a plan at 1:50 and its ' +
      'details at 1:20): packed in rows left to right, bottoms aligned, the block centred in the drawing area; at = the ' +
      'centre of a viewport on the paper in mm. view (an id of list_views) instead of window: the extents of that view - its ' +
      'title, scale line and tags included - plus margin (paper mm, default 5). The title block scale reads "NHƯ HÌNH" (as ' +
      'shown) when the scales differ.',
    ),
    view: opt(Str).describe('An id of list_views: the window is the extents of that view plus margin'),
    margin: opt(z.number().min(0)).describe('Paper mm around a view window (default 5)'),
    title_block: opt(Obj).describe(
      '{style: strip (vertical strip on the right, default on landscape A3-A0) | bottom, company, company_address, project, location, item, ' +
      'client, client_address, title, number (default: a field of the layout name), revision, contract, phase, sheet, date, chief, lead, ' +
      'drawn_by, checked_by, scale (default: a field of the viewport scale), note (the general note along the bottom)}',
    ),
    language: opt(Lang),
    replace: z.boolean().default(false),
    activate: z.boolean().default(false).describe('Leave the new layout open in AutoCAD (default: back to Model)'),
  },
  annotations: EDIT,
}, ({ name, paper, orientation, window, scale, views, title_block, language: lang, replace, activate, view, margin }) => exclusive(async () => {
  const info0 = await sendNow('drawing_info', {});
  // windows from views: the extents of the view (all it drew) plus a margin on paper
  let known = null;
  const viewWindow = async (id, sc, m, where) => {
    known ??= parseViews(await sendNow('view_list', {})).views;
    const v = known.find((x) => x.id === id);
    if (!v) throw new Error(`create_layout: ${where}: no view "${id}" (list_views names them: ${known.map((x) => x.id).slice(0, 12).join(', ')})`);
    if (!v.bounds) throw new Error(`create_layout: ${where}: view "${id}" has nothing drawn`);
    const u = { m: 0.001, cm: 0.1 }[info0.units] ?? 1;
    const d = (m ?? 5) * (sc ?? 100) * u;
    return [[v.bounds.min[0] - d, v.bounds.min[1] - d], [v.bounds.max[0] + d, v.bounds.max[1] + d]];
  };
  if (views?.length) {
    const vs = [];
    for (const [i, v] of views.entries()) {
      if (!v.window && !v.view) throw new Error(`create_layout: views[${i}] needs window or view`);
      vs.push({ ...v, window: v.window ?? (await viewWindow(v.view, v.scale, v.margin, `views[${i}]`)) });
    }
    return text(await layoutViews({ name, paper, orientation, views: vs, title_block, lang, replace, activate, info0 }));
  }
  let win = window;
  if (!win && view) win = await viewWindow(view, scale, margin, 'view');
  if (!win) {
    if (!info0.extents) throw new Error('create_layout: model space is empty; draw first or give a window.');
    win = [info0.extents.min, info0.extents.max];
  }
  const units = info0.units;
  const unitsPerMm = { m: 0.001, cm: 0.1 }[units] ?? 1;
  const ww = Math.abs(win[1][0] - win[0][0]);
  const wh = Math.abs(win[1][1] - win[0][1]);
  if (ww <= 0 || wh <= 0) throw new Error('create_layout: the window (or the drawing extents) is empty.');
  // Viewport area: above the title block or left of it, whichever holds the window at the given scale (or at the
  // largest standard scale when none is given); the larger area on a tie.
  const dims = (a) => [a[1][0] - a[0][0], a[1][1] - a[0][1]];
  const fits = (a, sc) => ww / (sc * unitsPerMm) <= dims(a)[0] + 1e-6 && wh / (sc * unitsPerMm) <= dims(a)[1] + 1e-6;
  const { areas } = titleBlock({ paper, orientation, info: {}, language: lang ?? language, style: title_block?.style });
  const pick = scale
    ? { a: areas.find((a) => fits(a, scale)) ?? areas[0], s: scale }
    : areas.map((a) => ({ a, s: fitScale([ww, wh], dims(a), unitsPerMm) })).sort((p, q) => p.s - q.s)[0];
  const area = pick.a, s = pick.s;
  const [aw, ah] = dims(area);
  const warnings = fits(area, s) ? [] : [
    `the window (${Math.round(ww)} x ${Math.round(wh)} ${units || 'units'}) does not fit on ${paper} ${orientation} at 1:${s}: ` +
    'the viewport crops it. Use a larger paper, a smaller scale (larger number) or a smaller window.',
  ];
  // scale and number as fields (the viewport's scale, the layout name) unless given; the date of issue as text
  const d = new Date();
  const date = (lang ?? language) === 'en' ? d.toISOString().slice(0, 10) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const info = { scale: FIELD.viewportScale, number: FIELD.layoutName, date, ...(title_block || {}) };
  const sheet = titleBlock({ paper, orientation, info, language: lang ?? language, style: title_block?.style });
  const factor = 1 / (s * unitsPerMm);
  const vw = Math.min(aw, ww * factor);
  const vh = Math.min(ah, wh * factor);
  const req = withStyles({
    name, paper, orientation, replace, activate,
    entities: sheet.entities,
    styles: { text_style: styleParams({ scale: s }).text_style },
    viewport: {
      center: [(area[0][0] + area[1][0]) / 2, (area[0][1] + area[1][1]) / 2], width: vw, height: vh,
      view_center: [(win[0][0] + win[1][0]) / 2, (win[0][1] + win[1][1]) / 2], scale_factor: factor,
    },
  });
  req.styles.text_style.set_current = false;
  const r = await sendNow('create_layout', req);
  const list = sheetsMade.get(info0.name) ?? [];
  sheetsMade.set(info0.name, [...list.filter((x) => x.layout !== name), {
    layout: name, number: title_block?.number ?? name, title: title_block?.title ?? '', scale: `1:${s}`, paper: `${paper} ${(lang ?? language) === 'en' ? orientation : orientation === 'portrait' ? 'đứng' : 'ngang'}`,
  }]);
  return text({ ...r, scale: `1:${s}`, paper, orientation, ...(warnings.length ? { warnings } : {}) });
}));

/** Whether a file exists and another program holds it open (a PDF viewer keeps the PDF it shows locked). */
async function fileLocked(file) {
  try {
    const fh = await fs.open(file, 'r+');
    await fh.close();
    return false;
  } catch (e) {
    return ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);
  }
}

server.registerTool('export_pdf', {
  description:
    'Plot to PDF with DWG To PDF.pc3: layouts (names, ["all"], or default the current one) become pages of one PDF; layouts on ' +
    'different paper sizes give one PDF per size (<name>_A1.pdf, <name>_A3-portrait.pdf: see pdfs). For "Model": paper, ' +
    'orientation, window (default extents) and scale (default fit). monochrome.ctb unless plot_style is given. Plotting can take ' +
    '~30 s on machines whose default Windows printer is an unreachable network printer. A PDF open in a viewer (Nitro, Acrobat) ' +
    'is locked: the tool says so before plotting; if_locked: rename writes <name>-1.pdf (-2...) instead.',
  inputSchema: {
    path: Str, layouts: opt(jsonish(z.array(Str))),
    paper: z.enum(['A0', 'A1', 'A2', 'A3', 'A4']).default('A3'), orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    window: opt(Window), scale: opt(z.number().positive()), plot_style: opt(Str),
    if_locked: z.enum(['error', 'rename']).default('error'),
  },
  annotations: DESTRUCTIVE,
}, async ({ if_locked, ...a }) => {
  let file = path.resolve(a.path);
  const stem = file.replace(/\.pdf$/i, '');
  // the PDF and the PDFs per paper size that the plot may write (<name>_A1.pdf ...)
  const targets = async (f) => {
    const s = f.replace(/\.pdf$/i, '');
    const dir = path.dirname(f), base = path.basename(s);
    let more = [];
    try {
      more = (await fs.readdir(dir)).filter((n) => n.toLowerCase().startsWith(`${base.toLowerCase()}_`) && /\.pdf$/i.test(n)).map((n) => path.join(dir, n));
    } catch {
      // no folder yet
    }
    const out = [];
    for (const t of [f, ...more]) if (await fileLocked(t)) out.push(t);
    return out;
  };
  let locked = await targets(file);
  const note = [];
  if (locked.length && if_locked === 'rename') {
    for (let i = 1; i < 100 && locked.length; i++) {
      file = `${stem}-${i}.pdf`;
      locked = await targets(file);
    }
    note.push(`the PDF was open in another program: written to ${file}`);
  }
  if (locked.length) {
    throw new Error(`export_pdf: ${locked.join(', ')} ${locked.length > 1 ? 'are' : 'is'} open in another program (a PDF viewer such as Nitro or Acrobat keeps the file it shows locked, and AutoCAD then cancels the plot with ePageCancelled). Close it there, give another path, or pass if_locked: "rename".`);
  }
  try {
    const r = await call('export_pdf', { ...a, path: file });
    return text(note.length ? { ...r, note: note.join('; ') } : r);
  } catch (e) {
    if (/PageCancelled/i.test(String(e.message))) {
      throw new Error(`${e.message} - AutoCAD cancels a plot when the PDF (or one of its per-paper PDFs) cannot be written: check that ${file} is not open in a PDF viewer and that its folder can be written.`);
    }
    throw e;
  }
});

bridgeTool('save_drawing',
  'Save the drawing (DWG, or DXF by extension/format). Empty path = save in place; a new path = Save As (the open drawing takes ' +
  'that name), overwrite=true to replace an existing file. version: 2018 (default), 2013, 2010, 2007, 2004, 2000. copy=true ' +
  'writes a copy and leaves the open drawing as it is (the default for DXF and older versions: an export for someone else).',
  { path: opt(Str), format: opt(z.enum(['dwg', 'dxf'])), version: opt(Str), overwrite: opt(z.boolean()), copy: opt(z.boolean()) },
  DESTRUCTIVE, (a) => ({ ...a, path: a.path ? path.resolve(a.path) : undefined }));

bridgeTool('open_drawing',
  'Open a .dwg/.dxf file in AutoCAD (or switch to it if already open). Handles from another drawing are not valid there.',
  { path: Str, read_only: z.boolean().default(false) }, DESTRUCTIVE, (a) => ({ ...a, path: path.resolve(a.path) }));

bridgeTool('close_drawing',
  'Close a drawing (path, default the current one). A drawing with unsaved changes is closed only with discard=true.',
  { path: opt(Str), discard: z.boolean().default(false) }, DESTRUCTIVE, (a) => ({ ...a, ...(a.path ? { path: path.resolve(a.path) } : {}) }));

bridgeTool('new_drawing',
  'Create a new drawing from a template (default acadiso.dwt, metric) and make it current.',
  { template: opt(Str) }, DESTRUCTIVE);

// ---------------------------------------------------------------- elevations, sections, structural details
/** Where draw_plan put the floors of the building: in this session, else as the drawing remembers it. */
const floorSpots = () => lastFloors ?? viewStore.getStore()?.floorsBase ?? null;

function planFor(args, tool) {
  const ctx = viewStore.getStore();
  const base = args.plan ?? ctx?.planBase ?? lastPlan;
  if (!base) throw new Error(`${tool}: no plan description yet: call draw_plan first in this session, or pass plan (the same object as draw_plan).`);
  if (ctx && ctx.tool !== 'draw_plan') {
    // the plan the view is drawn from: kept in the drawing when it is not the one already there
    ctx.planHash = hashOf(specKey(base));
    if (ctx.planHash !== ctx.storedHash) ctx.planJson = JSON.stringify(keptPlan(base));
  }
  return {
    ...base,
    ...(args.heights ? { heights: { ...(base.heights || {}), ...args.heights } } : {}),
    ...(args.roofs ? { roofs: args.roofs } : {}),
    ...(args.scale ? { scale: args.scale } : {}),
  };
}

/** Result of a dry run: the defaults the tool would apply, nothing drawn. */
function dryRun(assumed, extra = {}) {
  return text({
    dry_run: true, drawn: false, assumed,
    next: assumed.length
      ? 'Show these assumptions to the user (item: value) and draw once they confirm or change them.'
      : 'Nothing is assumed: the description gives every value this tool needs.',
    ...extra,
  });
}

const assumedOrNone = (a) => (a?.length ? a : undefined);

/** The building of a plan description as a key: the plot scale a tool was called with is not part of the building. */
// what a plan says about how it is drawn, not about the building: two descriptions that differ only there (or in the
// order of their fields) are the same building, so a calculation made for one serves the other
const DRAWN_ONLY = new Set(['scale', 'dimensions', 'interior_dimensions', 'entities', 'room_options', 'layers', 'language', 'hatch_walls', 'sections', 'north', 'levels', 'dry_run', 'update']);
const specKey = (spec) => {
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !DRAWN_ONLY.has(k) && v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, k === 'floors' && Array.isArray(v) ? v.map((f) => (f && typeof f === 'object' && !Array.isArray(f) ? strip(f) : f)) : v]));
  return JSON.stringify(strip(spec));
};

const engine = (tool, fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof PlanError) throw new Error(`${tool}: ${e.message}`);
    throw e;
  }
};

/** Linetype dashes sized for the view's scale, whatever LTSCALE the drawing uses (entities flagged scale_linetype
 *  keep the linetype of their layer). */
function sizeLinetypes(ents, scale, ltscale) {
  const k = Math.round(((0.4 * scale) / (ltscale || 1)) * 1000) / 1000;
  return ents.map((e) => {
    if (!e.linetype && !e.scale_linetype) return e;
    const { scale_linetype, ...rest } = e;
    return { ...rest, ltscale: k };
  });
}

/** Place a new view to the right of everything in model space when no position is given. */
async function freeSpot(at, scale) {
  const info = await sendNow('drawing_info', {});
  const ctx = viewStore.getStore();
  const k = ctx ? ctx.n++ : -1;
  // a view that replaces an earlier one stands where that one stood (its k-th place)
  const kept = !at && ctx?.old?.spots?.[k];
  const spot = at ?? (Array.isArray(kept) ? kept
    // far enough that a sheet window around the new view does not catch its neighbour (texts run past the bounds)
    : !info.extents ? [0, 0] : [info.extents.max[0] + Math.max(40 * scale, 5000), info.extents.min[1] + 80 * scale]);
  if (ctx) ctx.spots[k] = spot;
  return { at: spot, info };
}

async function drawView(ents, scale, info, lang) {
  return sendNow('draw_plan', withStyles({
    entities: sizeLinetypes(ents, scale, info.ltscale), styles: viewStyles(scale), language: lang, report_spaces: false,
  }));
}

const HEIGHTS_DOC =
  'heights {ground: -450 (outside ground, mm from the finished floor ±0.000), top: 3600 (top of walls / eaves), door_head: ' +
  '2400, window_sill: 900, window_head: 2400, slab: 100, foundation: {depth: 1500, width: 900, height: 350, lean: 100}, ' +
  'walls_to_roof: end|all (walls across the ridge rise to the roof: gable ends only, or every one = tường thu hồi)}; ' +
  'per opening: sill, head; per wall: height. roofs [{type: gable|flat, ridge: x|y (direction of the ridge in plan), ' +
  'pitch (deg), overhang, thickness, base (eaves level, default heights.top), parapet (flat), region [[x0,y0],[x1,y1]] ' +
  '(default: the whole building)}] - several parts for e.g. a porch gable in front of the main roof.';

server.registerTool('draw_elevation', {
  description:
    'Draw elevations derived from the plan of draw_plan (same walls, openings, columns, grids), so they always agree: the ' +
    'nearest walls and columns win, roofs and columns hide what is behind them, doors and windows with frames, plinth line, ' +
    'ground line with earth hatch, roofs (gable end or eaves side), level marks, height dimensions, grid bubbles with ' +
    'spacing, title "MẶT ĐỨNG TRỤC 1-3". sides: plan sides the viewer stands on (bottom = front at the bottom of the plan). ' +
    'Several sides are placed side by side to the right of the drawing unless at is given (left end of the facade at ' +
    `±0.000). Decorative details seen in a photo (mouldings, gable ornaments) can be added with draw_entities.\n${HEIGHTS_DOC}`,
  inputSchema: {
    sides: jsonish(z.array(z.enum(['bottom', 'top', 'left', 'right']))).default(['bottom']),
    at: opt(Point), heights: opt(Obj), roofs: opt(Specs), scale: opt(z.number().positive()),
    titles: opt(Obj).describe('{bottom: "MẶT ĐỨNG CHÍNH", ...} to replace the automatic titles'),
    plan: opt(Obj).describe('Plan description (as draw_plan); default: the last one drawn'),
    language: opt(Lang),
    dry_run: z.boolean().default(false).describe('List the heights/roof defaults it would assume, without drawing'),
  },
  annotations: EDIT,
}, ({ sides, at, heights, roofs, scale, titles, plan, language: lang, dry_run }) => exclusive(async () => {
  const spec = planFor({ plan, heights, roofs, scale }, 'draw_elevation');
  const sc = spec.scale ?? 100;
  if (dry_run) {
    const r = engine('draw_elevation', () => buildElevation(spec, { side: sides[0], at: [0, 0], scale: sc }));
    return dryRun(r.assumed, { sides, levels: r.levels });
  }
  const { at: start, info } = await freeSpot(at, sc);
  const ents = [];
  const placed = [];
  let assumed = [];
  let x = start[0];
  for (const side of sides) {
    const r = engine('draw_elevation', () => buildElevation(spec, { side, at: [x, start[1]], scale: sc, title: titles?.[side] }));
    assumed = r.assumed;
    ents.push(...r.entities);
    placed.push({ side, at: [x, start[1]], levels: r.levels });
    x = r.extent.max[0] + 30 * sc;
  }
  const res = await drawView(ents, sc, info, lang);
  return text({ elevations: placed, assumed: assumedOrNone(assumed), count: res.count, bounds: res.bounds, created_layers: res.created_layers });
}));

server.registerTool('draw_section', {
  description:
    'Draw a section derived from the plan of draw_plan along a cut line (from/to, looking to its left or right like the ' +
    'plan\'s section mark, or mark: the label of a section drawn by draw_plan): walls cut (heavy outline + brick hatch) with ' +
    'the openings they cross and concrete lintels, footings with lean concrete, floor slab and fill, the roof cut (gable ' +
    'profile, eaves band or flat slab with parapets), walls/doors/windows seen beyond in thin lines, room names, level ' +
    'marks, height dimensions, grid bubbles, title "MẶT CẮT A-A". Footings are drawn as a typical section (sizes from ' +
    `heights.foundation), not a design.\n${HEIGHTS_DOC}`,
  inputSchema: {
    mark: opt(Str).describe('Label of a section mark of the plan (e.g. "A"): its from/to/look are used'),
    from: opt(Point), to: opt(Point), look: z.enum(['left', 'right']).default('left'), label: opt(Str),
    at: opt(Point), heights: opt(Obj), roofs: opt(Specs), scale: opt(z.number().positive()), title: opt(Str),
    plan: opt(Obj), language: opt(Lang),
    beam_depth: opt(z.number().min(0)).describe('Depth of the beams drawn under the slabs on the cut walls (default heights.beam or 300; 0 = none)'),
    dry_run: z.boolean().default(false).describe('List the heights/roof/foundation defaults it would assume, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_section');
  const sc = spec.scale ?? 100;
  let { from, to, look, label } = args;
  if (args.mark) {
    const m = (spec.sections || []).find((s) => String(s.label ?? 'A') === String(args.mark));
    if (!m) throw new Error(`draw_section: the plan has no section mark "${args.mark}" (marks: ${(spec.sections || []).map((s) => s.label ?? 'A').join(', ') || 'none'})`);
    from = m.from; to = m.to; look = m.look ?? 'left'; label = label ?? String(args.mark);
  }
  if (!from || !to) throw new Error('draw_section: give from and to (the cut line) or mark.');
  if (args.dry_run) {
    const r = engine('draw_section', () => buildSection(spec, { from, to, look, label, at: [0, 0], scale: sc }));
    return dryRun(r.assumed, { section: label ?? 'A', rooms: r.rooms, cut_walls: r.cut_walls, levels: r.levels });
  }
  let { at, info } = await freeSpot(args.at, sc);
  const ceilings = sectionCeilings(spec);
  const build = (p) => engine('draw_section', () => buildSection(spec, { from, to, look, label, at: p, scale: sc, title: args.title, ceilings, beam_depth: args.beam_depth }));
  let r = build(at);
  if (!args.at) {
    // the levels and dimensions on the left reach out of the cut: move the section right so they clear the last view
    const b = entityBounds(r.entities);
    const over = b ? at[0] - b.min[0] + 16 * sc : 0;
    if (over > 0) {
      at = [at[0] + over, at[1]];
      r = build(at);
    }
  }
  const res = await drawView(r.entities, sc, info, args.language);
  return text({
    section: label ?? 'A', at, rooms: r.rooms, cut_walls: r.cut_walls, levels: r.levels, assumed: assumedOrNone(r.assumed),
    count: res.count, bounds: res.bounds,
  });
}));

const STRUCT_DOC =
  'kind=section: rectangular RC cross-section {b, h, cover: 25, groups: [{face: bottom|top|bottom2|top2|corners|sides|' +
  'left|right, d, n, mark}], stirrup: {d, spacing, mark} (null = none), label: "1-1"}; kind=beam: beam along its spans ' +
  '{spans: [axis-to-axis], support: column width, b, h, cover, bottom {d, n, mark}, top {d, n, mark}, extra_top {d, n, ' +
  'mark, ratio: 0.25} (support bars over ratio x span), stirrup {d, end: 100, mid: 200, zone: 0.25, mark}, axes: labels, ' +
  'name, count: identical members} with sections 1-1 / 2-2; kind=footing: pad footing section {B, L, H, edge (sloped ' +
  'when < H), cover: 50, lean: 100, depth (bottom below ±0.000), ground, mesh {d, spacing, mark}, column {b, top, bars ' +
  '{d, n, mark}, ties {d, spacing, mark}}, name, count}.';

server.registerTool('draw_structure_detail', {
  description:
    'Draw a reinforced-concrete detail at a detail scale (default 1:20 sections, 1:25 beams/footings) on the structural ' +
    'layers (S-CONC, S-REBR, S-REBR-STIR, S-ANNO-*): concrete outline, bars and stirrups with 135° hooks, bar marks with ' +
    'leaders, dimensions, levels, title. Sizes and reinforcement must come from the user or the structural design (this ' +
    'tool computes no strength: draw what the engineer specifies, or label values as typical/to be checked). Returns the ' +
    'bar schedule rows (length, count) for rebar_schedule; schedule=true also draws the table next to the detail. ' +
    `Warns when bars in one row do not fit the clear spacing.\n${STRUCT_DOC}`,
  inputSchema: {
    kind: z.enum(['section', 'beam', 'footing']),
    at: opt(Point), scale: opt(z.number().positive()), schedule: z.boolean().default(false),
    b: opt(z.number()), h: opt(z.number()), cover: opt(z.number()), groups: opt(Specs), stirrup: opt(z.union([Obj, z.null()])), label: opt(Str),
    spans: opt(jsonish(z.array(z.number()))), support: opt(z.number()), bottom: opt(Obj), top: opt(Obj), extra_top: opt(z.union([Obj, z.null()])),
    axes: opt(jsonish(z.array(z.union([z.string(), z.number()])))), name: opt(Str), count: opt(z.number().int()),
    B: opt(z.number()), L: opt(z.number()), H: opt(z.number()), edge: opt(z.number()), lean: opt(z.number()), depth: opt(z.number()),
    ground: opt(z.number()), mesh: opt(Obj), column: opt(Obj), title: opt(Str), language: opt(Lang),
    dry_run: z.boolean().default(false).describe('List the sizes/bars it would assume and the schedule rows, without drawing'),
  },
  annotations: EDIT,
}, ({ dry_run, ...args }) => exclusive(async () => {
  const sc = args.scale ?? (args.kind === 'section' ? 20 : 25);
  const detail = (p) => engine('draw_structure_detail', () => (args.kind === 'section' ? rcSection(p) : args.kind === 'beam' ? beamDetail(p) : footingDetail(p)));
  if (dry_run) {
    const r = detail({ ...args, scale: sc, at: [0, 0] });
    return dryRun(r.assumed, { kind: args.kind, schedule_rows: r.schedule, warnings: r.warnings?.length ? r.warnings : undefined });
  }
  const { at, info } = await freeSpot(args.at, sc);
  const p = { ...args, scale: sc, at };
  const r = detail(p);
  const ents = [...r.entities];
  let sched;
  if (args.schedule && r.schedule) {
    sched = rebarSchedule(r.schedule, args.language ?? language);
    const xs = ents.flatMap((e) => [e.from, e.to, e.at, e.center, ...(e.points || [])].filter(Boolean).map((q) => q[0]));
    const ys = ents.flatMap((e) => [e.from, e.to, e.at, e.center, ...(e.points || [])].filter(Boolean).map((q) => q[1]));
    ents.push(scheduleTable(sched, [Math.max(...xs) + 15 * sc, Math.max(...ys)], sc, args.language ?? language));
  }
  const res = await drawView(ents, sc, info, args.language);
  return text({
    kind: args.kind, at, scale: `1:${sc}`, assumed: assumedOrNone(r.assumed), schedule_rows: r.schedule,
    warnings: r.warnings?.length ? r.warnings : undefined,
    schedule_total_kg: sched?.total_kg, count: res.count, bounds: res.bounds,
  });
}));

function scheduleTable(sched, at, sc, lang) {
  return {
    type: 'table', at, title: lang === 'en' ? 'BAR SCHEDULE' : 'BẢNG THỐNG KÊ CỐT THÉP', rows: sched.drawn ?? sched.table,
    decimal_separator: lang === 'en' ? undefined : ',', height: 2.5 * sc, row_height: 7 * sc, col_widths: [24, 16, 12, 24, 20, 12, 22, 20, 22].map((w) => w * sc),
    layer: 'S-ANNO-TEXT', style: TEXT_STYLE,
  };
}

server.registerTool('rebar_schedule', {
  description:
    'Bar schedule (bảng thống kê cốt thép): rows [{mark, shape, d (mm), length (mm per bar), n (bars per member), members}] ' +
    '(e.g. the schedule_rows of draw_structure_detail, several details combined) -> total bars, total length (m) and weight ' +
    '(d²/162 kg/m) per row, per diameter and overall. Draws it as a table at "at" (top-left, default right of the drawing) ' +
    'unless draw=false; csv_path also saves it for Excel.',
  inputSchema: {
    rows: Specs, at: opt(Point), scale: z.number().positive().default(25), draw: z.boolean().default(true),
    csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('comma'), language: opt(Lang),
  },
  annotations: EDIT,
}, ({ rows, at, scale, draw, csv_path, csv_format, language: lang }) => exclusive(async () => {
  const sched = engine('rebar_schedule', () => rebarSchedule(rows, lang ?? language));
  const out = { rows: sched.rows, by_diameter_kg: sched.by_diameter_kg, total_kg: sched.total_kg };
  if (draw) {
    const { at: pos, info } = await freeSpot(at, scale);
    const res = await drawView([scheduleTable(sched, pos, scale, lang ?? language)], scale, info, lang);
    out.table = res.results?.[0]?.handle ?? res.entities?.[0]?.handle;
    out.at = pos;
  }
  if (csv_path) {
    const sep = csv_format === 'semicolon' ? ';' : ',';
    const num = (v) => (typeof v === 'number' && csv_format === 'semicolon' ? String(v).replace('.', ',') : v);
    const file = path.resolve(csv_path.endsWith('.csv') ? csv_path : `${csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, BOM + sched.table.map((r) => r.map((c) => csvCell(num(c), sep)).join(sep)).join('\r\n') + '\r\n', 'utf8');
    out.csv = file;
  }
  return text(out);
}));

// ---------------------------------------------------------------- interior design
// What the interior tools of this session placed and chose, so the next ones agree: the furniture of
// draw_furniture_plan (elevations, ceiling pendants, schedule), the finishes given per room, the lights of the RCP.
// One such state per floor of a building ('' for a one-storey plan).
const interiorStates = new Map();
function interiorOf(key) {
  if (!interiorStates.has(key)) interiorStates.set(key, { items: [], given: {}, lights: [] });
  return interiorStates.get(key);
}

/**
 * The plan the interior tools work on: the whole plan, or one floor of a building (floor: name or number from 1),
 * with where that floor's plan was drawn.
 */
function floorFor(args, tool) {
  const spec = planFor(args, tool);
  if (!Array.isArray(spec.floors) || !spec.floors.length) return { spec, offset: [0, 0], key: '', height: null, label: '' };
  const floors = engine(tool, () => floorsOf(spec));
  if (args.floor === undefined) {
    throw new Error(`${tool}: the building has floors (${floors.map((f) => f.name).join(', ')}): give floor (its name or number).`);
  }
  const k = typeof args.floor === 'number' || /^\d+$/.test(String(args.floor)) ? Number(args.floor) - 1 : floors.findIndex((f) => f.name === String(args.floor));
  if (!floors[k]) throw new Error(`${tool}: no floor ${args.floor} (floors: ${floors.map((f) => f.name).join(', ')})`);
  const offset = !args.plan && floorSpots()?.offsets?.[k] ? floorSpots().offsets[k] : [0, 0];
  return { spec: floors[k].spec, offset, key: floors[k].name, height: floors[k].height, label: ` ${floors[k].name}` };
}

/** Room outlines of the plan in the drawing (the A-AREA boundaries draw_plan made), by the room names of the plan. */
async function roomOutlines(spec, tool, offset = [0, 0], handles = null) {
  const q = await sendNow('query_entities', { layers: [ROLE.area], types: ['polyline'], detail: true, limit: 2000 });
  const polys = (q.entities || []).filter((e) => e.closed && Array.isArray(e.points) && e.points.length >= 3).map((e) => ({ poly: cleanPoly(e.points), handle: e.handle }));
  const out = {};
  // the plan where draw_plan put it, else the newest copy of it in this drawing (an interior or structural file)
  for (const off of [offset, ...planCopies.filter((c) => c.sig === roomSig(spec)).map((c) => c.offset)]) {
    for (const r of spec.rooms || []) {
      const p = [r.at[0] + off[0], r.at[1] + off[1]];
      const c = polys.filter((x) => inside(p, x.poly)).sort((a, b) => polyArea(a.poly) - polyArea(b.poly))[0];
      if (!c) continue;
      out[String(r.name)] = c.poly.map((q2) => [q2[0] - off[0], q2[1] - off[1]]);
      // the boundary, for quantities kept as fields of it
      if (handles) handles[String(r.name)] = c.handle;
    }
    if (Object.keys(out).length) break;
  }
  if (!Object.keys(out).length) {
    // a drawing of its own (structural, interior): the outlines from the plan description, nothing drawn
    Object.assign(out, await planRooms(spec));
  }
  if (!Object.keys(out).length) {
    throw new Error(`${tool}: no room outlines: the plan has no rooms closed by walls (rooms with a point inside each).`);
  }
  return out;
}

/** Room outlines of a plan description computed by AutoCAD (region of the walls) without drawing anything. */
async function planRooms(spec) {
  const plan = engine('rooms', () => buildPlan({ ...spec, entities: [], dimensions: false }));
  if (!plan.rooms.length) return {};
  const r = await sendNow('draw_plan', { walls: plan.walls, cuts: plan.cuts, columns: plan.columns, rooms: plan.rooms, room_options: plan.room_options, rooms_only: true });
  const out = {};
  for (const rm of r.rooms || []) if (Array.isArray(rm.points) && rm.points.length >= 3) out[String(rm.name)] = cleanPoly(rm.points);
  return out;
}

/** Finishes of every room: what this call gives, else what an earlier call gave, over the defaults by kind of room. */
function finishesFor(st, rooms, given, assumed, floorHeight = null) {
  for (const g of given || []) {
    if (!g.room) throw new Error('rooms[]: each entry needs room (the room name) and floor / skirting / wall / ceiling');
    st.given[g.room] = { ...(st.given[g.room] || {}), ...g };
  }
  const out = {};
  for (const name of Object.keys(rooms)) out[name] = resolveFinish(name, st.given[name] || {}, assumed, floorHeight);
  return out;
}

const FloorArg = opt(z.union([Str, z.number().int().positive()])).describe('Floor of a building (name or number from 1)');

/**
 * Ceiling and floor finish of every room for the sections, by floor index: what the interior tools were given, else the
 * defaults by kind of room (resolveFinish).
 */
function sectionCeilings(spec) {
  const floors = Array.isArray(spec.floors) && spec.floors.length ? floorsOf(spec) : [{ name: '', spec, height: null }];
  const out = {};
  floors.forEach((f, i) => {
    const st = interiorOf(Array.isArray(spec.floors) && spec.floors.length ? f.name : '');
    out[i] = {};
    for (const rm of f.spec.rooms || []) {
      const name = String(rm.name);
      const fin = resolveFinish(name, st.given[name] || {}, [], f.height);
      if (fin.ceiling) out[i][name] = { level: fin.ceiling.level, drop: fin.ceiling.drop, code: fin.ceiling.code, floor_code: fin.floor?.code };
    }
  });
  return out;
}

/** The sheets made by create_layout, by drawing (for draw_drawing_list); the beams of the structural plans. */
const sheetsMade = new Map();
/** Where the interior tools drew their copies of the plan (newest first): their room boundaries stand for the rooms. */
const planCopies = [];
const roomSig = (spec) => (spec.rooms || []).map((r) => `${r.name}@${r.at}`).join('|');
const structBeams = new Map();
// the last structural_calc of the session (its plan as JSON): the quantities use its designed bars
let lastCalc = null;
// the last draw_finish_quantities of the session (for the workbook)
let lastFinish = null;

const NotesArg = z.union([z.boolean(), z.array(Str)]).default(true)
  .describe('General notes of the sheet (GHI CHÚ): true = the standard ones for this kind of plan, a list = these, false = none');

/** The lines of the general notes of a sheet ([] for none). */
const notesLines = (args, kind, lang) => (args.notes === false ? [] : Array.isArray(args.notes) ? args.notes : generalNotes(kind, lang));

/** Height of a notes block: the heading and the numbered lines of its mtext, 95 x scale wide. */
function notesHeight(lines, sc) {
  const rows = lines.reduce((t, l) => t + Math.max(1, Math.ceil((String(l).length + 4) / 62)), 0);
  return 5 * sc + rows * 2.5 * sc * 1.1 * 1.67;
}

/** Full bounds of a plan copy: its walls and columns, its entities, the text of its dimensions and its grid bubbles. */
function copyBounds(base, sc) {
  const xs = [], ys = [];
  const add = (p) => {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
      xs.push(p[0]);
      ys.push(p[1]);
    }
  };
  for (const g of base.plan?.walls || []) for (const solid of g.solids || []) for (const p of solid) add(p);
  for (const c of base.plan?.columns || []) for (const p of c) add(p);
  add(base.bounds.min);
  add(base.bounds.max);
  for (const e of base.ents) {
    if ((e.type === 'dim_chain' || (e.type === 'block' && e.name === 'MCP_TRUC')) && Array.isArray(e.at)) {
      add([e.at[0] - 6 * sc, e.at[1] - 6 * sc]);
      add([e.at[0] + 6 * sc, e.at[1] + 6 * sc]);
    }
  }
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

/** Whether model space has anything in box [x0, y0, x1, y1] (crossing). */
async function occupied(box) {
  try {
    const q = await sendNow('query_entities', { window: [[box[0], box[1]], [box[2], box[3]]], window_mode: 'crossing', limit: 1, space: 'model' });
    return (q?.matched ?? q?.entities?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Where the legend and notes of a plan copy go (top-left corner of a block w x h): notes_at when given; the place the
 * view it replaces had; else right of the plan (past its walls, dimensions and grid bubbles), below its title, left or
 * above it, the first one where the drawing is free.
 */
async function sideSpot(base, sc, args, [w, h]) {
  const cb = copyBounds(base, sc);
  const vctx = viewStore.getStore();
  const vk = vctx ? vctx.n++ : -1;
  const kept = vctx?.old?.spots?.[vk];
  const titleBottom = Math.min(cb.min[1], base.bounds.min[1] - 24 * sc);
  const cands = [
    ['right', [cb.max[0] + 15 * sc, cb.max[1]]],
    ['below', [cb.min[0], titleBottom - 10 * sc]],
    ['left', [cb.min[0] - 15 * sc - w, cb.max[1]]],
    ['above', [cb.min[0], cb.max[1] + 15 * sc + h]],
  ];
  let at = null, where = 'right', warning;
  if (args.notes_at) {
    at = args.notes_at;
    where = 'given';
  } else if (Array.isArray(kept)) {
    at = kept;
    where = 'kept';
  } else if (vctx?.old) {
    at = cands[0][1]; // an update: the view it replaces still stands beside the plan
  } else {
    for (const [k, c] of cands) {
      if (!(await occupied([c[0], c[1] - h, c[0] + w, c[1]]))) {
        at = c;
        where = k;
        break;
      }
    }
    if (!at) {
      at = cands[0][1];
      warning = 'no free place beside the plan for its legend and notes: they overlap other entities; give notes_at';
    }
  }
  if (vctx) vctx.spots[vk] = at;
  const r = (v) => Math.round(v);
  return { at, where, box: [[r(at[0]), r(at[1] - h)], [r(at[0] + w), r(at[1])]], warning };
}

/**
 * The legend (run(legendAt) of the plan's engine, or none) and the general notes of a plan copy, placed by sideSpot:
 * the engine is run once to measure its legend, then again where the block goes.
 */
async function sideBlock(base, sc, args, kind, lang, run) {
  const lines = notesLines(args, kind, lang);
  let r = run(args.legend ? [0, 0] : undefined);
  const lh = args.legend && r.legendBottom != null ? -r.legendBottom : 0;
  const h = lh + (lines.length ? (lh ? 6 * sc : 0) + notesHeight(lines, sc) : 0);
  if (h <= 0) return { r: args.legend ? run(undefined) : r, notes: [], side: null };
  const side = await sideSpot(base, sc, args, [100 * sc, h]);
  r = run(args.legend ? side.at : undefined);
  const top = args.legend && r.legendBottom != null ? r.legendBottom - 6 * sc : side.at[1];
  return { r, notes: lines.length ? notesBlock(lines, [side.at[0], top], sc, lang) : [], side };
}

const sideOut = (side) => (side ? { legend_and_notes: { position: side.where, window: side.box } } : {});

const PlanCopyArgs = {
  notes_at: opt(Point).describe('Top-left corner of the legend and notes; default: beside the plan (right of its walls, dimensions and grid bubbles; else below its title, left or above) where the drawing is free'),
  dimensions: opt(z.union([z.literal(false), jsonish(z.array(z.enum(['top', 'bottom', 'left', 'right'])))])).describe('Dimension chains of the plan copy: the sides that get them, or false for none (default: as the plan)'),
  interior_dimensions: z.boolean().default(false).describe('Clear room dimensions inside the plan copy (off by default: they would cross the room names, tags and finishes of this plan)'),
};

/** The sheet's general notes under its legend (or right of the plan at the top). */
function sheetNotes(args, kind, base, sc, lang, below, extra) {
  if (args.notes === false) return;
  const lines = Array.isArray(args.notes) ? args.notes : generalNotes(kind, lang);
  if (!lines.length) return;
  const at = [base.bounds.max[0] + 15 * sc, below != null ? below - 6 * sc : base.bounds.max[1]];
  extra.push(...notesBlock(lines, at, sc, lang));
}

/** A copy of the plan (walls, openings, columns, grids, dimensions, room names) at an interior scale, moved by offset. */
async function planCopy(tool, spec, args, scale, { doors = true, roomLabels = true, labels = {}, levels = true, hideRooms = null, dimensions = undefined, tags: withTags = true, stairLabels = true, front = undefined, interiorDims = undefined } = {}) {
  const info = await sendNow('drawing_info', {});
  const pts = (spec.walls || []).flatMap((w) => w.points || []);
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  // a view that replaces an earlier one keeps the offset of its plan (its k-th place), so its sheet keeps showing it
  const vctx = viewStore.getStore();
  const vk = vctx ? vctx.n++ : -1;
  const keptOffset = !args.offset && vctx?.old?.spots?.[vk];
  const offset = args.offset ?? (Array.isArray(keptOffset) ? keptOffset : [info.extents ? info.extents.max[0] + 80 * scale - x0 : 0, 0]);
  if (vctx) vctx.spots[vk] = offset;
  // front (a point in front of the house: the meter, the manhole; null: the bottom of the plan): that side stays free,
  // the dimension chains go to two other sides and the grid bubbles on that side are left out
  let frontSide = null;
  if (front !== undefined) {
    const d = front ? { bottom: front[1] - y0, top: y1 - front[1], left: front[0] - x0, right: x1 - front[0] } : { bottom: -1 };
    frontSide = Object.entries(d).sort((a, b) => a[1] - b[1])[0][0];
    if (dimensions === undefined) dimensions = [frontSide === 'left' ? 'right' : 'left', frontSide === 'top' ? 'bottom' : 'top'];
  }
  // room names where given (clear of the furniture), else where the plan has them
  const moved = { ...spec, rooms: (spec.rooms || []).map((r) => (labels[r.name] ? { ...r, at: labels[r.name] } : r)) };
  if (interiorDims !== undefined) moved.interior_dimensions = interiorDims;
  // tags false: the doors and windows without their schedule tags (plans of other trades)
  if (!withTags) moved.openings = (spec.openings || []).map(({ tag, ...o }) => o);
  const shifted = shiftSpec(moved, offset);
  const plan = engine(tool, () => buildPlan({
    ...shifted, scale, language: args.language ?? language, levels: levels ? shifted.levels : [], ...(stairLabels ? {} : { stair_labels: false }),
    ...(dimensions !== undefined ? { dimensions } : {}),
    // hideRooms: rooms whose name would lie on what the plan draws there (a stair)
    rooms: roomLabels ? shifted.rooms.filter((r) => !hideRooms || !hideRooms(String(r.name))) : [],
    room_options: { ...(spec.room_options || {}), boundary: false, text_height: undefined },
  }));
  const tags = new Set((spec.openings || []).map((o) => o.tag).filter(Boolean).map(String));
  let ents = plan.entities;
  if (!doors) ents = ents.filter((e) => e.layer !== ROLE.door && !(e.type === 'text' && tags.has(String(e.text))));
  ents = ents.map((e) => ([ROLE.grid, ROLE.opening, ROLE.hidden, ROLE.beam].includes(e.layer) ? { ...e, scale_linetype: true } : e));
  const b = entityBounds(ents) ?? { min: [x0 + offset[0], y0 + offset[1]], max: [x1 + offset[0], y0 + offset[1]] };
  // the grid bubbles on the front side go (the bounds keep their room: the title stays where it was)
  if (frontSide) {
    const beyond = { bottom: (q) => q[1] < y0 + offset[1], top: (q) => q[1] > y1 + offset[1], left: (q) => q[0] < x0 + offset[0], right: (q) => q[0] > x1 + offset[0] }[frontSide];
    ents = ents.filter((e) => !(e.type === 'block' && e.name === 'MCP_TRUC' && beyond(e.at)));
  }
  planCopies.unshift({ sig: roomSig(spec), offset });
  return { info, offset, plan, ents, bounds: b, centerX: (x0 + x1) / 2 + offset[0] };
}

async function drawPlanCopy(base, extra, scale, lang) {
  const { plan } = base;
  return sendNow('draw_plan', withStyles({
    walls: plan.walls, cuts: plan.cuts, columns: plan.columns, rooms: plan.rooms, room_options: plan.room_options,
    entities: sizeLinetypes([...base.ents, ...extra], scale, base.info.ltscale), styles: viewStyles(scale), language: lang, report_spaces: false,
  }));
}

function sheetTitle(base, text, scale, out) {
  out.push(...viewTitle(text, base.centerX, base.bounds.min[1] - 14 * scale, scale, ROLE.text));
}

const FinishRooms = opt(Specs).describe('[{room: "PHÒNG NGỦ 1", floor: {code, description, pattern: tile|plank|none|<hatch>, size: [600, 600], ' +
  'start: center|corner|[x,y], angle}, skirting: {code, description, height} | null, wall: {code, description, pattern: paint|tile|panel, ' +
  'size, height: ceiling|mm}, ceiling: {code, description, level: 3000, drop: {width: 600, depth: 150, cove: true} | null, center_light} | null}] ' +
  '- only what differs from the defaults; remembered for the other interior tools');
const INTERIOR_DEFAULTS =
  'Defaults by room name (reported in assumed): dry rooms FL-01 porcelain 600x600 centred, SK-01 skirting 100, WL-01 white paint, ' +
  'CL-01 suspended gypsum +3.000 (floors of 3.3 m: +2.800) with a 600 wide, 150 deep drop band and LED cove (flat in rooms ' +
  'narrower than 2.4 m); stairs FL-04 granite treads, no ceiling (stairwell); kitchens the same plus WL-03 backsplash tiles ' +
  'between the base and wall cabinets; WC/bathrooms FL-02 anti-slip 300x300, WL-02 wall tiles 300x600 to the ceiling, CL-02 ' +
  'moisture-resistant gypsum +3.000 flat; yards/balconies FL-03 outdoor tiles, no ceiling.';

// ---------------------------------------------------------------- structural set (kết cấu)

/** Moves entities so that their bounds start at p (a view placed by freeSpot). */
function placeAt(ents, p) {
  const b = entityBounds(ents);
  if (!b) return ents;
  const d = [p[0] - b.min[0], p[1] - b.min[1]];
  return ents.map((e) => shiftEntity(e, d));
}

server.registerTool('draw_structure_plan', {
  description:
    'Structural framing plan of one slab (mặt bằng kết cấu dầm sàn) from the plan of draw_plan, for the structural set (its own ' +
    'drawing: new_drawing first): beams along the load-bearing walls of the floor below (walls of 150 mm and more; thinner ' +
    'partitions stand on the slab), named per slab (D2.1, D2.2 ... for the slab of floor 2, DM.1 ... for the roof) with b x h and ' +
    'their count, columns at the wall nodes, the slab thickness, lowered slabs (wet rooms, balconies -50) hatched, stair ' +
    'openings crossed, grids with bubbles and dimensions, title "MẶT BẰNG KẾT CẤU SÀN <floor> (+level)". Sizes are ' +
    'preliminary (h = span/12 rounded up to 50, 300-700; b = wall thickness) and reported as assumed: the structural engineer ' +
    'designs them; give beam {b, h} and column {size} to use theirs. After structural_calc of the same plan the columns ' +
    '(marks C1, C2 ... with a legend) and the pad footings (M1, M2 ...) are those it designed; column {sizes: [{at, size, ' +
    'mark}]} and footing {sizes: [{at, B, L, mark}]} give them by hand. Cantilever balconies are outlined and hatched ' +
    '(BC), columns planted on a beam are marked, a beam that ends on another beam rests on it. The beams are remembered ' +
    'for draw_beam_schedule.',
  inputSchema: {
    floor: opt(z.union([Str, z.number().int().positive()])).describe('The slab: floor number from 2 or name (its floor slab), "roof" (over the top floor; default for a one-floor plan), or "foundation" (pad footings under the columns, ground beams GM under the ground floor walls)'),
    footing: opt(Obj).describe('Foundation plan: {B, L, depth} of the pad footings M1 (default 1200 x 1200, depth heights.foundation.depth or 1500), or {sizes: [{at, B, L, mark}]}; default after structural_calc: the pads it designed'),
    scale: z.number().positive().default(100), slab: opt(z.number().positive()), prefix: opt(Str),
    beam: opt(Obj).describe('{b, h, min_wall: 150}'), column: opt(Obj).describe('{size: [b, h]} or {sizes: [{at, size, mark}]}; default after structural_calc: the columns it designed'),
    at: opt(Point), plan: opt(Obj), language: opt(Lang),
    dry_run: z.boolean().default(false).describe('List the beams, columns and sizes it would assume, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_structure_plan');
  const floors = engine('draw_structure_plan', () => floorsOf(spec));
  const lang = args.language ?? language;
  const found = /^(foundation|móng|mong|1)$/i.test(String(args.floor ?? ''));
  const roof = found ? false : args.floor === undefined ? floors.length === 1 || null : /^(roof|mái|mai)$/i.test(String(args.floor));
  if (roof === null) throw new Error(`draw_structure_plan: give floor (2..${floors.length}), "roof" or "foundation"`);
  let below, level, name, slab, roomsSpec, prefix;
  if (found) {
    below = floors[0];
    level = below.spec.heights?.ground ?? 0;
    name = lang === 'en' ? 'FOUNDATION' : 'MÓNG';
    slab = args.slab ?? 120;
    roomsSpec = floors[0].spec;
    prefix = beamPrefix('foundation', name, 0, lang);
  } else if (roof) {
    below = floors[floors.length - 1];
    slab = args.slab ?? 120;
    // the top of the roof slab over the walls of the top floor
    level = below.level + (below.height ?? spec.heights?.top ?? 3600) + slab;
    name = lang === 'en' ? 'ROOF' : 'MÁI';
    roomsSpec = null;
    prefix = beamPrefix('roof', name, floors.length, lang);
  } else {
    const k = typeof args.floor === 'number' || /^\d+$/.test(String(args.floor)) ? Number(args.floor) - 1 : floors.findIndex((f) => f.name === String(args.floor));
    if (!floors[k] || k < 1) throw new Error(`draw_structure_plan: floor must be 2..${floors.length} (the slab of that floor) or "roof"`);
    below = floors[k - 1];
    level = floors[k].level;
    name = floors[k].name;
    slab = args.slab ?? floors[k].slab ?? 120;
    roomsSpec = floors[k].spec;
    // D2. for floor 2 ..., DT. for a stair tower (tum); B2., BT. in English
    prefix = beamPrefix('floor', name, k, lang);
  }
  const sc = args.scale;
  const rooms = roomsSpec && !args.dry_run ? await roomOutlines(roomsSpec, 'draw_structure_plan').catch(() => ({})) : {};
  // the sizes of the last calculation of this plan: columns, pads, the columns planted on this slab
  const calc = lastCalc?.key === specKey(spec) ? lastCalc.R : null;
  const r = engine('draw_structure_plan', () => framingPlan({
    spec: below.spec, level, slab, name, prefix: args.prefix ?? prefix, scale: sc, beam: args.beam ?? (found ? { h: 400 } : {}),
    column: args.column ?? (calc ? { sizes: calc.design.columns } : {}), rooms, lang,
    foundation: found ? { depth: spec.heights?.foundation?.depth ?? 1500, ...(args.footing ?? (calc ? { sizes: calc.design.footings } : {})) } : null,
    balconies: roomsSpec?.balconies ?? [],
    planted: calc ? calc.columns.filter((c) => c.on === name).map((c) => ({ at: c.at, size: c.size })) : [],
  }));
  const beams = r.beams.map((b) => ({ name: b.name, size: `${b.b}x${b.h}`, count: b.count, spans: b.spans }));
  if (args.dry_run) return dryRun(r.assumed, { slab: name, level, beams, columns: r.columns, footings: r.footings.length ? r.footings : undefined });
  structBeams.set(name, r.beams);
  const { at, info } = await freeSpot(args.at, sc);
  const res = await drawView(placeAt(r.entities, at), sc, info, args.language);
  return text({
    slab: name, level, beams, columns: r.columns, footings: r.footings.length ? r.footings : undefined, sizes: calc ? 'structural_calc' : undefined,
    notes: r.notes?.length ? r.notes : undefined, assumed: assumedOrNone(r.assumed), count: res.count, bounds: res.bounds,
  });
}));

server.registerTool('draw_beam_schedule', {
  description:
    'Beam schedule (bảng mặt cắt dầm) of the structural set: for every beam type its section at the support (GỐI) and at ' +
    'midspan (NHỊP) with the slab flange, the slab level (FL), bars, stirrups and b/h dimensions, titled "DẦM D2.1 (220x400) - ' +
    'SL: 03". beams default to those of the draw_structure_plan calls of this session; or give beams [{name, b, h, count, ' +
    'level, slab, bars: {support: [{face, d, n}], span: [...]}, stirrup: {d, support, span}}]. Bars not given are preliminary ' +
    '(by depth) and reported as assumed.',
  inputSchema: {
    beams: opt(Specs), scale: z.number().positive().default(25), per_row: z.number().int().positive().default(3), at: opt(Point), language: opt(Lang),
    dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const beams = args.beams ?? [...structBeams.values()].flat();
  if (!beams.length) throw new Error('draw_beam_schedule: no beams: call draw_structure_plan first, or give beams');
  const sc = args.scale;
  const r = engine('draw_beam_schedule', () => beamSchedule({ beams, scale: sc, perRow: args.per_row, lang: args.language ?? language }));
  if (args.dry_run) return dryRun(r.assumed, { beams: beams.map((b) => `${b.name} ${b.b}x${b.h} x${b.count ?? 1}`) });
  const { at, info } = await freeSpot(args.at, sc);
  const res = await drawView(placeAt(r.entities, at), sc, info, args.language);
  return text({ beams: beams.length, assumed: assumedOrNone(r.assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('structural_calc', {
  description:
    'Preliminary structural calculation (bảng tính kết cấu sơ bộ) of the frame of the plan of draw_plan, for the structural ' +
    'set: the beams of every slab (as draw_structure_plan lays them out) and the ground beams; loads by TCVN 2737:2023 (slab ' +
    'build-ups, live loads by room: rooms 1.5, halls and stairs 3, balconies 2 kPa..., partitions, walls on the beams less ' +
    'their openings, self-weight); slab panels shared out to their beams (two-way trapezoid / triangle, one-way); continuous ' +
    'beams with the live load on all / odd / even spans; bending and shear by TCVN 5574:2018 (αm, ξ ≤ ξR, As, bars; stirrups ' +
    'at the supports and midspan; shear and reactions from the loads really carried, a beam on a beam and a planted column ' +
    'as point loads); column loads down to the footings; the columns sized for their load (220x220, 220x300, 300x300 ... ' +
    'with φ by l0/h), the pad footings sized for the soil pressure (side, thickness by punching, mesh by bending, at most ' +
    'four types; a note when they overlap: strip footings or a raft), the slabs (two-way by Marcus, one-way strips), the ' +
    'stairs and the cantilever balconies. Drawn as a sheet of tables (materials, slab loads, floor build-up, beams, slabs, ' +
    'columns and footings, assumptions) ' +
    'with the sign-off (người tính, kiểm tra, chủ trì kết cấu: name, licence No., signature, date) and the note that a ' +
    'licensed structural engineer checks it, calculates it again and signs it. csv_path writes the tables for Excel. The ' +
    'designed bars and stirrups replace the preliminary ones of draw_beam_schedule, and draw_structure_plan of the same plan ' +
    'takes the designed columns and pads (call them afterwards; draw=false calculates without the sheet). Returns design ' +
    '{columns, footings} and the pad types (footings: mark, B, L, H, mesh) for draw_structure_detail. Defaults (materials, ' +
    'loads, soil pressure, footing, column) are reported as assumed; sizes that fail are listed in warnings.',
  inputSchema: {
    concrete: z.enum(Object.keys(CONCRETE)).default('B20'), steel: z.enum(Object.keys(STEEL)).default('CB300-V'),
    stirrup_steel: z.enum(Object.keys(STEEL)).default('CB240-T'), cover: z.number().positive().default(25),
    soil_pressure: z.number().positive().default(100).describe('Bearing pressure R at the footing bottom, kPa (from the site investigation)'),
    footing: opt(Obj).describe('{B, L}: the least size of the pad footings, mm'), column: opt(Obj).describe('{size: [b, h], bars: {n, d}}: the first size tried'),
    draw: z.boolean().default(true), csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('semicolon'),
    xlsx_path: opt(Str).describe('Excel workbook with live formulas: the inputs (materials, loads, soil, sections, bars, q) in yellow cells, the design calculated from them'),
    scale: z.number().positive().default(50), at: opt(Point), plan: opt(Obj), language: opt(Lang), dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'structural_calc');
  const lang = args.language ?? language;
  const floors = engine('structural_calc', () => floorsOf(spec));
  // the rooms of every floor (live loads by room), measured by AutoCAD from the plan description
  const rooms = {};
  if (!args.dry_run) for (let k = 1; k < floors.length; k++) rooms[k] = await roomOutlines(floors[k].spec, 'structural_calc').catch(() => ({}));
  const R = engine('structural_calc', () => structuralCalc({
    spec, rooms, concrete: args.concrete, steel: args.steel, stirrupSteel: args.stirrup_steel, cover: args.cover, soil: args.soil_pressure,
    footing: args.footing ?? {}, column: args.column ?? {}, lang,
  }));
  const beams = R.slabs.flatMap((S) => S.types.map((t) => ({
    slab: S.name, name: t.name, size: `${t.b}x${t.h}`, count: t.count, bottom: `${t.barsSpan.n}Ø${t.barsSpan.d}`, top: `${t.barsSup.n}Ø${t.barsSup.d}`,
    stirrups: `Ø${t.stirrup.d}a${t.stirrup.support}/a${t.stirrup.span}`, M: [Math.round(t.Mspan * 10) / 10, Math.round(t.Msup * 10) / 10], Q: Math.round(t.Q * 10) / 10, ok: t.ok,
  })));
  const columns = R.columns.map((c) => ({
    name: c.name, N: c.N, mark: c.mark, size: `${c.size[0]}x${c.size[1]}`, bars: `${c.bars.n}Ø${c.bars.d}`, capacity: c.cap, ok: c.colOk,
    footing: c.foot ? `${c.foot.mark} ${c.foot.B}x${c.foot.L}x${c.foot.H}` : undefined, footing_ok: c.foot ? c.footOk : undefined,
  }));
  const summary = { beams, columns, footings: R.footings, design: R.design, warnings: R.warnings, assumed: assumedOrNone(R.assumed) };
  if (args.dry_run) return dryRun(R.assumed, { beams, columns, footings: R.footings, warnings: R.warnings });
  lastCalc = { key: specKey(spec), R };
  // the beam schedule draws the designed bars from now on
  for (const S of R.slabs) {
    structBeams.set(S.name, S.types.map((t) => ({ name: t.name, b: t.b, h: t.h, count: t.count, spans: t.spans.map((x) => Math.round(x * 1000)), level: S.level, slab: S.kind === 'foundation' ? 0 : (S.slab || 120), bars: t.bars, stirrup: t.stirrups })));
  }
  const out = { ...summary };
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, calcCsv(R, lang, args.csv_format === 'comma' ? ',' : ';'), 'utf8');
    out.csv = file;
  }
  if (args.xlsx_path) {
    const file = path.resolve(args.xlsx_path.endsWith('.xlsx') ? args.xlsx_path : `${args.xlsx_path}.xlsx`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, kcWorkbook(R, null, lang));
    out.xlsx = file;
  }
  if (args.draw) {
    const sc = args.scale;
    const { at, info } = await freeSpot(args.at, sc);
    const sheet = calcSheet(R, { scale: sc, lang });
    const res = await drawView(placeAt(sheet.entities, at), sc, info, args.language);
    out.count = res.count;
    out.bounds = res.bounds;
  }
  return text(out);
}));

/** The finish faces measured again by AutoCAD (filled in by the surface model). */
let verifyFinishes = async () => ({ skipped: 'the finish faces are not available' });

/** The rule set of a bill: its name, or the fields given over the default set. */
const RulesArg = opt(z.union([Str, Obj])).describe(
  'Measurement rules: "PL6" (default: Phụ lục VI of Thông tư 13/2021/TT-BXD - openings under 0.25 m² are not deducted from masonry and ' +
  'finishes, under 1 m² from formwork, voids under 0.1 m³ from concrete; the column-beam node belongs to the beam, what lies in the slab ' +
  'thickness to the slab), "NET" (the geometry as it is, everything deducted), or an object over a set, e.g. {base: "PL6", void: {finish: 0.5}}');
const ruleName = (rules, lang) => {
  try {
    const r = typeof rules === 'object' && rules?.name ? rules : ruleSet(rules);
    if (typeof r.name === 'string') return r.name;
    return r.name?.[lang] ?? r.name?.vi ?? (typeof rules === 'string' ? rules : 'PL6');
  } catch {
    return String(rules ?? 'PL6');
  }
};
/** The checks of a bill in a result: how many pass, and those that fail in full. */
const checkSummary = (checks) => {
  if (!Array.isArray(checks) || !checks.length) return undefined;
  const bad = checks.filter((c) => !c.ok);
  return { passed: checks.length - bad.length, failed: bad.length, ...(bad.length ? { failures: bad.map((c) => ({ id: c.id, name: c.name, lhs: c.lhs, rhs: c.rhs, where: c.where })) } : {}) };
};
// the last structural bill of this session (for verify_quantities)
let lastBill = null;
/** The earthwork and ground slab options of a bill as boqSheets takes them (true or nothing: the defaults). */
const billOptions = (args) => ({
  earth: args.earth === false ? false : args.earth && typeof args.earth === 'object' ? args.earth : null,
  groundSlab: args.ground_slab === false ? false : args.ground_slab && typeof args.ground_slab === 'object' ? args.ground_slab : null,
});

server.registerTool('draw_quantity_schedule', {
  description:
    'Bar schedule of the whole structural set (bảng thống kê cốt thép: footings, columns, ground beams and the beams of every ' +
    'slab with the bars and stirrups of structural_calc, the slabs, stairs and balconies with the bars it designed; bars, lengths with laps and ' +
    'anchorage, weights by d²/162 as table formulas, totals per diameter) and the bill of quantities (bảng tổng hợp khối ' +
    'lượng vật tư: lean concrete, concrete and formwork of the footings, column stubs, ground beams, columns storey by storey, ' +
    'beams, slabs and stairs; excavation of the pits and trenches, backfill and surplus soil, the slab on grade and the fill ' +
    'under it; steel by grade; brick walls by thickness in m² (and m³) less the openings, lintels, brick stair steps; plaster ' +
    'inside, outside and of the soffits), each with how it is made up (diễn giải: like parts x one part). The concrete is ' +
    'measured on a solid model where members that meet are counted once (the sum of the lines is the volume poured), by the ' +
    'rule set (rules) with the geometric net beside it; the result lists the cross-checks that fail and what was assumed ' +
    '(working space of the excavation, the ground slab). Uses the last structural_calc of this session, ' +
    'else runs it with its defaults. The bar schedule flows in columns over pages (page_height mm, per_page columns) and the ' +
    'bill breaks into pages of the same height (bills), each page drawn apart for its own sheet (returned bounds); csv_path ' +
    'writes both for Excel. For estimating: ' +
    'the quantity surveyor checks them against the final drawings.',
  inputSchema: {
    scale: z.number().positive().default(25), page_height: z.number().positive().default(330), per_page: z.number().int().positive().default(2),
    csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('semicolon'), plan: opt(Obj), language: opt(Lang),
    xlsx_path: opt(Str).describe('Excel workbook with live formulas: the calculation (parameters, loads, beams, columns and footings), the bar schedule, the bill of quantities line by line (Bảng 6.2: like parts x one part) and its checks'),
    rules: RulesArg,
    earth: opt(jsonish(z.union([z.boolean(), z.record(z.any())]))).describe('Earthwork: {space: working space each side of the pits and trenches in mm (300), slope: horizontal for 1 vertical (0 = vertical sides)}; false leaves it out'),
    ground_slab: opt(jsonish(z.union([z.boolean(), z.record(z.any())]))).describe('Slab on grade of the ground floor: {thickness: 100, concrete: "B15"}; false leaves it out (with the fill under it)'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_quantity_schedule');
  const lang = args.language ?? language;
  const key = specKey(spec);
  const R = lastCalc?.key === key ? lastCalc.R : engine('draw_quantity_schedule', () => structuralCalc({ spec, lang }));
  const B = engine('draw_quantity_schedule', () => boqSheets(R, { scale: args.scale, lang, pageHeight: args.page_height, perPage: args.per_page, rules: args.rules ?? null, ...billOptions(args) }));
  lastBill = { key, B, options: JSON.stringify(billOptions(args)) };
  const sc = args.scale;
  const drawn = [];
  const bills = B.bills ?? [B.boq];
  for (const p of [...B.pages, ...bills]) {
    const { at, info } = await freeSpot(undefined, sc);
    if (p.tables && p.under) {
      // a page of the bill: its tables first, then the note and the title under them as they were drawn (a row with a
      // long text is taller than the others)
      // (one shift for both: the page as estimated stands on the free spot, its tables hang from y = 0 of the page)
      const eb = entityBounds(p.entities);
      const d = eb ? [at[0] - eb.min[0], at[1] - eb.min[1]] : [0, 0];
      const t = await drawView(p.tables.map((e) => shiftEntity(e, d)), sc, info, args.language);
      const u = await drawView(p.under((d[1] - t.bounds.min[1]) / sc).map((e) => shiftEntity(e, d)), sc, info, args.language);
      const bounds = { min: [Math.min(t.bounds.min[0], u.bounds.min[0]), Math.min(t.bounds.min[1], u.bounds.min[1])], max: [Math.max(t.bounds.max[0], u.bounds.max[0]), Math.max(t.bounds.max[1], u.bounds.max[1])] };
      drawn.push({ title: p.title, bounds, count: t.count + u.count });
      continue;
    }
    const res = await drawView(placeAt(p.entities, at), sc, info, args.language);
    drawn.push({ title: p.title, bounds: res.bounds, count: res.count });
  }
  const out = {
    // the bar schedule pages, then the bill (bills: its pages when it runs over more than one)
    pages: drawn.slice(0, B.pages.length), bill: drawn[B.pages.length], bills: bills.length > 1 ? drawn.slice(B.pages.length) : undefined,
    steel_kg: B.quantities.steel,
    // measured by the rule set; the geometric quantity beside it where the two differ
    quantities: B.quantities.rows.filter((r) => !r.head).map((r) => `${r.stt}. ${r.item}: ${r.q} ${r.unit}${r.geo !== undefined && Math.abs(r.geo - r.q) > 5e-4 ? ` (geometric ${r.geo})` : ''}`),
    rules: ruleName(B.rules ?? args.rules, lang),
    checks: checkSummary(B.checks),
    not_counted: B.notCounted?.length ? B.notCounted : undefined,
    assumed: assumedOrNone(B.assumed),
    from: lastCalc?.key === key ? 'structural_calc' : 'structural_calc defaults (run structural_calc first for the rooms and your materials)',
  };
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, boqCsv(B.groups, B.quantities, lang, args.csv_format === 'comma' ? ',' : ';'), 'utf8');
    out.csv = file;
  }
  if (args.xlsx_path) {
    const file = path.resolve(args.xlsx_path.endsWith('.xlsx') ? args.xlsx_path : `${args.xlsx_path}.xlsx`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, kcWorkbook(R, B, lang));
    out.xlsx = file;
  }
  return text(out);
}));

server.registerTool('verify_quantities', {
  description:
    'Independent check of the quantities by AutoCAD\'s own solid modeler (nothing is drawn): the concrete members of the ' +
    'structural bill (footings, columns, beams, slabs with their openings, lintels, stairs as plates) are rebuilt as solids in ' +
    'AutoCAD, their union is measured and compared with the sum of the net volumes of the bill (members that meet are counted ' +
    'once: the two must agree); the wall, floor and ceiling faces of the finish bill are rebuilt as regions with their openings ' +
    'and their areas compared face by face. Returns the differences and the faces or members that disagree by more than the ' +
    'tolerance; the floor plate of every floor (rooms, walls and columns united) is compared with the plate of the bill. Run ' +
    'structural_calc / draw_quantity_schedule and draw_finish_quantities of the same plan first, else it measures with their ' +
    'defaults; the finish part needs the plan drawn in the current drawing (draw_plan) for the room outlines.',
  inputSchema: {
    plan: opt(Obj), language: opt(Lang), rules: RulesArg,
    tolerance: z.number().positive().default(0.1).describe('Allowed difference in percent'),
    structure: z.boolean().default(true), finishes: z.boolean().default(true),
  },
  annotations: READ,
}, (args) => exclusive(async () => {
  const tool = 'verify_quantities';
  const spec = planFor(args, tool);
  const lang = args.language ?? language;
  const key = specKey(spec);
  const pct = (a, b) => (Math.abs(b) > 1e-9 ? Math.round(((a - b) / b) * 1e5) / 1e3 : 0);
  const out = { tolerance_percent: args.tolerance };
  if (args.structure) {
    const R = lastCalc?.key === key ? lastCalc.R : engine(tool, () => structuralCalc({ spec, lang }));
    const B = lastBill?.key === key && !args.rules ? lastBill.B : engine(tool, () => boqSheets(R, { lang, rules: args.rules ?? null }));
    // the same members as the bill (its ground slab as it was given)
    const prisms = engine(tool, () => structurePrisms(R, B.model.options ?? {}));
    const m = await measureModel({ solids: prisms.map((q) => ({ id: q.id, group: q.group ?? q.kind, profile: q.profile, holes: q.holes?.length ? q.holes : undefined, z0: q.z0, z1: q.z1 })) }, sendNow); // already inside exclusive()
    const bill = Math.round(B.model.sumNet * 1e6) / 1e6;
    const d = pct(m.union_m3, bill);
    out.structure = {
      members: prisms.length, not_prisms: prisms.filter((q) => q.exact === false).length || undefined,
      bill_net_m3: bill, autocad_union_m3: m.union_m3, difference_percent: d, ok: Math.abs(d) <= args.tolerance,
      autocad_sum_m3: m.sum_m3, autocad_overlap_m3: m.overlap_m3, bill_contacts_m3: Math.round((B.model.sumGross - B.model.sumNet) * 1e6) / 1e6,
      checks: checkSummary(B.checks),
      from: lastCalc?.key === key ? 'structural_calc' : 'structural_calc defaults',
    };
  }
  if (args.finishes) out.finishes = await verifyFinishes(tool, spec, args, lang);
  out.ok = [out.structure, out.finishes].filter(Boolean).every((x) => x.ok !== false);
  return text(out);
}));

server.registerTool('draw_structure_notes', {
  description:
    'Structural general notes (ghi chú chung kết cấu) as tables: materials (concrete B20/B15/B7.5, steel CB240-T / CB300-V), ' +
    'concrete cover by member, anchorage and lap lengths by diameter, typical lintels by span, and numbered notes (codes, laps, ' +
    'formwork, preliminary sizes). TCVN 5574:2018 defaults, every value can be given: concrete {main, minor, lean, ' +
    'steel_small, steel_large}, cover {footing, ground_beam, column, beam, slab, lintel}, laps {anchor_tension, ' +
    'anchor_compression, lap_tension, lap_compression} (multiples of d), lintels (rows), notes (lines). Defaults are listed as assumed.',
  inputSchema: {
    concrete: opt(Obj), cover: opt(Obj), laps: opt(Obj), lintels: opt(jsonish(z.array(z.array(z.any())))), notes: opt(z.array(Str)),
    scale: z.number().positive().default(50), at: opt(Point), language: opt(Lang), dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const sc = args.scale;
  const make = (at) => structureNotes({ ...args, at, scale: sc, lang: args.language ?? language });
  const r0 = engine('draw_structure_notes', () => make([0, 0]));
  if (args.dry_run) return dryRun(r0.assumed, {});
  const { at, info } = await freeSpot(args.at, sc);
  const r = make([at[0], at[1] + 250 * sc]);
  const res = await drawView(r.entities, sc, info, args.language);
  return text({ assumed: assumedOrNone(r.assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_door_schedule', {
  description:
    'Door and window schedule of the architectural set (bảng thống kê cửa đi, cửa sổ) from the plan of draw_plan: every type ' +
    '(by tag, kind and size, on every floor) drawn in elevation with its frame, leaves and opening direction (dashed lines ' +
    'meet on the hinge side), glazing, width / height / sill dimensions, its tag and count, then the table: tag, kind, W x H, ' +
    'sill, count by floor, description. materials {tag: description} replaces the default descriptions (listed as assumed).',
  inputSchema: { materials: opt(Obj), scale: z.number().positive().default(50), at: opt(Point), plan: opt(Obj), language: opt(Lang), dry_run: z.boolean().default(false) },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_door_schedule');
  const sc = args.scale;
  const make = (at) => doorSchedule({ spec, scale: sc, materials: args.materials ?? {}, lang: args.language ?? language, at });
  const r0 = engine('draw_door_schedule', () => make([0, 0]));
  if (args.dry_run) return dryRun(r0.assumed, { types: r0.rows });
  const { at, info } = await freeSpot(args.at, sc);
  const res = await drawView(placeAt(r0.entities, at), sc, info, args.language);
  return text({ types: r0.rows, assumed: assumedOrNone(r0.assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_stair_detail', {
  description:
    'Stair detail sheet of the architectural set (chi tiết cầu thang) for a U stair of the plan of draw_plan: the stair plan on ' +
    'each kind of floor (start, typical floors grouped, arrival) with the walls around it, the treads numbered, run / landing / ' +
    'width dimensions (n x going), floor and landing levels, grids and the section mark 1-1; section 1-1 along the flights (cut ' +
    'flight with its RC waist slab and landing, the flight beyond, floor slabs and walls cut, handrails with balusters, riser ' +
    'dimensions n x riser per flight, floor heights, levels); the build-up notes of treads and landing with 2h + b; and the tread ' +
    'and handrail detail (granite, mortar, brick steps, waist slab, plaster, handrail, balusters) at detail_scale, drawn apart: ' +
    'put the two parts on one sheet with create_layout views [{window: main, scale}, {window: detail, scale: detail_scale}].',
  inputSchema: {
    stair: z.number().int().min(0).default(0).describe('which U stair of the floor where stairs start (0 = the first)'),
    scale: z.number().positive().default(50), detail_scale: z.number().positive().default(20),
    waist: z.number().positive().default(120), landing: z.number().positive().default(120), rail: z.number().positive().default(900),
    finish: z.number().positive().default(20), at: opt(Point), plan: opt(Obj), language: opt(Lang), dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_stair_detail');
  const lang = args.language ?? language;
  const r0 = engine('draw_stair_detail', () => stairDetail({
    spec, stair: args.stair, scale: args.scale, detailScale: args.detail_scale, waist: args.waist, landing: args.landing, rail: args.rail, finish: args.finish, lang,
  }));
  if (!r0) throw new Error('draw_stair_detail: the plan has no U stair (stairs [{type: "u", region}] on a floor)');
  if (args.dry_run) return dryRun(r0.assumed, r0.stair);
  const { at, info } = await freeSpot(args.at, args.scale);
  const main = await drawView(placeAt(r0.main, at), args.scale, info, args.language);
  // the detail to the right of the main part, at its own scale
  const b = main.bounds;
  const dAt = [b.max[0] + 30 * args.scale, b.min[1] + 20 * args.scale];
  const detail = await drawView(placeAt(r0.detail, dAt), args.detail_scale, info, args.language);
  return text({ stair: r0.stair, assumed: assumedOrNone(r0.assumed), main: main.bounds, detail: detail.bounds, count: main.count + detail.count });
}));

server.registerTool('draw_roof_plan', {
  description:
    'Roof plan of the architectural set (mặt bằng mái) from the plan of draw_plan, for flat roofs: a copy of the top floor plan with its ' +
    'walls (the parapets and the stair tower) at the plan scale with its grids and dimensions, the roof of the stair tower ' +
    'hatched, the roof terrace, floor drains with falls (i=2%) and rainwater pipes, the levels of the terrace, the parapet ' +
    'top and the tower roof, names and notes (waterproofing, screed to falls, pipes).',
  inputSchema: {
    scale: z.number().positive().default(100), fall: z.number().positive().default(2), title: opt(Str), plan: opt(Obj), language: opt(Lang),
    notes: NotesArg, offset: opt(Point),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const spec = planFor(args, 'draw_roof_plan');
  const floors = engine('draw_roof_plan', () => floorsOf(spec));
  const top = floors[floors.length - 1];
  const sc = args.scale;
  const lang = args.language ?? language;
  const parapet = (top.spec.walls || []).find((w) => w.height !== undefined)?.height ?? 1000;
  const terrace = top.level, roofTop = top.level + (top.height ?? 3000) + 120;
  const roofSpec = { ...top.spec, openings: [], rooms: [], stairs: [], stairs_below: [], levels: [], entities: [], sections: [], balconies: [], north: top.spec.north ?? spec.north };
  const base = await planCopy('draw_roof_plan', roofSpec, args, sc, { doors: false, roomLabels: false, levels: false });
  const rp = engine('draw_roof_plan', () => roofPlan({ top, terrace, roof: roofTop, parapet, fall: args.fall, scale: sc, lang }));
  const extra = rp.entities.map((e) => shiftEntity(e, base.offset));
  if (args.notes !== false) extra.push(...notesBlock(Array.isArray(args.notes) ? args.notes : rp.notes, [base.bounds.max[0] + 15 * sc, base.bounds.max[1]], sc, lang));
  sheetTitle(base, args.title ?? (lang === 'en' ? 'ROOF PLAN' : 'MẶT BẰNG MÁI'), sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({ offset: base.offset, drains: rp.drains, assumed: assumedOrNone(rp.assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_cover_sheet', {
  description:
    'Cover sheet of a set (tờ bìa): "HỒ SƠ BẢN VẼ <set>" large, the phase, then project, item, client, design consultant, ' +
    'contractor, location and date, framed. set: KIẾN TRÚC, KẾT CẤU, NỘI THẤT... Put it on its own sheet before the drawing list.',
  inputSchema: {
    set: Str, project: opt(Str), item: opt(Str), client: opt(Str), company: opt(Str), contractor: opt(Str), location: opt(Str),
    phase: opt(Str), date: opt(Str), scale: z.number().positive().default(50), at: opt(Point), language: opt(Lang),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const sc = args.scale;
  const lang = args.language ?? language;
  const d = new Date();
  const date = args.date ?? (lang === 'en' ? d.toISOString().slice(0, 10) : `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`);
  const { at, info } = await freeSpot(args.at, sc);
  const r = coverSheet({ set: args.set, info: { ...args, date }, at: [at[0], at[1] + 200 * sc], scale: sc, lang });
  const res = await drawView(r.entities, sc, info, args.language);
  return text({ count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_drawing_list', {
  description:
    'Drawing list (danh mục bản vẽ) of the set in this drawing: a table of its sheets (number, title, scale, paper). sheets ' +
    'default to the layouts create_layout made in this drawing in this session; or give sheets [{number, title, scale, paper, ' +
    'note}]. item names the set (KIẾN TRÚC, KẾT CẤU, NỘI THẤT). Put it on the first sheet of the set (e.g. KT-00).',
  inputSchema: { sheets: opt(Specs), item: opt(Str), scale: z.number().positive().default(50), at: opt(Point), language: opt(Lang) },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const info0 = await sendNow('drawing_info', {});
  const sheets = args.sheets ?? sheetsMade.get(info0.name) ?? [];
  if (!sheets.length) throw new Error('draw_drawing_list: no sheets: make the layouts with create_layout first (or give sheets)');
  const sc = args.scale;
  const { at, info } = await freeSpot(args.at, sc);
  const r = drawingList({ sheets, at: [at[0], at[1] + (sheets.length + 2) * 8 * sc], scale: sc, item: args.item, lang: args.language ?? language });
  const res = await drawView(r.entities, sc, info, args.language);
  return text({ sheets: sheets.length, table: res.results?.[0]?.handle ?? res.entities?.[0]?.handle, bounds: res.bounds });
}));

server.registerTool('draw_furniture_plan', {
  description:
    'Furniture layout plan (mặt bằng bố trí nội thất): a copy of the plan of draw_plan at 1:50 (walls, doors, windows, grids, ' +
    'dimensions, room names) to the right of the drawing (or at offset), with the furniture and joinery from the library and their ' +
    'code tags, and elevation keys (A top, B right, C bottom, D left) for the interior elevations. copy=false draws the items on ' +
    'the plan itself. Place an item with room + wall (A/B/C/D or top/right/bottom/left: its back against that wall) + offset from ' +
    'the left end of the wall seen from inside (default centred) + gap, or at (middle of its back edge) + facing (degrees the front ' +
    'faces), or center + facing (freestanding, e.g. a dining table). width/depth/height override the type size; code (default per ' +
    'type, e.g. FN-01 bed), description; tv_cabinet takes tv: false (the low cabinet alone, no screen in plan or elevation; ' +
    'sideboard is a credenza of its own); coffee_table and dining_table take shape: "round" or diameter (a round table, the ' +
    'chairs of a dining table around it); kitchen_base takes sink and hob (x from its left end) and modules [{w, type: door|doors|' +
    'drawers|sink|open|appliance}]; kitchen_wall/hood take z0 (underside). The items are remembered for draw_interior_elevation, ' +
    `draw_ceiling_plan (pendants over tables), draw_joinery_detail and material_schedule. Types (w x d x h): ${FURNITURE_DOC}.`,
  inputSchema: {
    items: Specs, copy: z.boolean().default(true), offset: opt(Point), scale: z.number().positive().default(50),
    tags: z.boolean().default(true),
    elevation_keys: opt(jsonish(z.array(z.union([Str, Obj])))).describe('Rooms that get an elevation key: names, or {room, at}'),
    notes: NotesArg, ...PlanCopyArgs,
    title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg,
    dry_run: z.boolean().default(false).describe('Resolve the items and list the sizes/codes/positions it would assume, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const { spec, offset: at0, key, label: floorLabel } = floorFor(args, 'draw_furniture_plan');
  const st = interiorOf(key);
  const rooms = await roomOutlines(spec, 'draw_furniture_plan', at0);
  const r = engine('draw_furniture_plan', () => resolveItems(args.items, rooms));
  const summary = r.items.map((it) => ({ code: it.code, type: it.type, room: it.room, wall: it.wall, size: `${it.w}x${it.d}x${it.h}` }));
  if (args.dry_run) return dryRun(r.assumed, { items: summary, warnings: r.warnings.length ? r.warnings : undefined });
  st.items = r.items;
  const lang = args.language ?? language;
  if (!args.copy) {
    const sc = spec.scale ?? 100;
    const info = await sendNow('drawing_info', {});
    const res = await drawView(furniturePlan(r.items, { offset: at0, scale: sc, tags: args.tags }), sc, info, lang);
    return text({ items: summary, assumed: assumedOrNone(r.assumed), warnings: r.warnings.length ? r.warnings : undefined, count: res.count, bounds: res.bounds });
  }
  const sc = args.scale;
  // Room names and elevation keys go where the furniture, its tags and the door swings leave room.
  // hard: code tags and door swings (and each label placed); soft: the furniture symbols themselves
  const symbols = furniturePlan(r.items, { scale: sc, tags: args.tags });
  const hard = [
    ...symbols.filter((e) => e.layer === ROLE.note).map(entBox).filter(Boolean),
    ...engine('draw_furniture_plan', () => buildPlan({ ...spec, entities: [], scale: sc })).entities.filter((e) => e.layer === ROLE.door).map(entBox).filter(Boolean),
  ];
  const soft = symbols.filter((e) => e.layer !== ROLE.note).map(entBox).filter(Boolean);
  const labels = {};
  const notes = [];
  for (const rm of spec.rooms || []) {
    const poly = rooms[rm.name];
    if (!poly) continue;
    const size = labelSize(String(rm.name), 2.5 * sc);
    const p = freePoint(poly, hard, size, rm.at, soft);
    if (!p) {
      notes.push(`${rm.name}: no free place for the room name; it stays where the plan has it`);
      continue;
    }
    if (p.soft) notes.push(`${rm.name}: the room name had to go over furniture (the room is full); give the rooms[].at of the plan or move items`);
    labels[rm.name] = [p[0], p[1]];
    hard.push([p[0] - size[0] / 2, p[1] - size[1] / 2, p[0] + size[0] / 2, p[1] + size[1] / 2]);
  }
  const keys = [];
  for (const k of args.elevation_keys || []) {
    const name = typeof k === 'string' ? k : k.room;
    const poly = rooms[name];
    if (!poly) throw new Error(`draw_furniture_plan: elevation_keys: room "${name}" not found`);
    const kr = 3.5 * sc * 1.95;
    const p = typeof k === 'object' && k.at ? k.at : freePoint(poly, hard, [2 * kr, 2 * kr], centroid(poly), soft) ?? centroid(poly);
    hard.push([p[0] - kr, p[1] - kr, p[0] + kr, p[1] + kr]);
    keys.push([p[0], p[1]]);
  }
  const base = await planCopy('draw_furniture_plan', spec, args, sc, { labels, dimensions: args.dimensions ?? undefined, interiorDims: args.interior_dimensions });
  const extra = furniturePlan(r.items, { offset: base.offset, scale: sc, tags: args.tags });
  for (const [i, p] of keys.entries()) {
    const k = args.elevation_keys[i];
    elevationKey([p[0] + base.offset[0], p[1] + base.offset[1]], sc, extra, undefined, typeof k === 'string' ? k : k.room);
  }
  const sb = await sideBlock(base, sc, { ...args, legend: false }, 'furniture', lang, () => ({}));
  extra.push(...sb.notes);
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'FURNITURE LAYOUT PLAN' : 'MẶT BẰNG BỐ TRÍ NỘI THẤT'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  const warnings = [...r.warnings, ...notes, ...(sb.side?.warning ? [sb.side.warning] : [])];
  return text({
    offset: base.offset, items: summary, assumed: assumedOrNone(r.assumed), warnings: warnings.length ? warnings : undefined,
    count: res.count, bounds: res.bounds, ...sideOut(sb.side),
  });
}));

server.registerTool('draw_floor_finish_plan', {
  description:
    'Floor finish plan (mặt bằng lát sàn): a copy of the plan at 1:50 with the real tile or plank joints of each room (tiles ' +
    'centred in the room by default, or from a start point; planks staggered by a third), kept clear of the room names, a code ' +
    'tag under each name and the legend (finish, swatch at the real size, area m² and rooms). ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), legend: z.boolean().default(true),
    title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg, ...PlanCopyArgs,
    zones: opt(Specs).describe('Areas of another floor inside a room, e.g. carpet tiles set into the stone floor: [{rect: [[x0,y0],[x1,y1]] | outline: [[x,y]...] (plan coordinates, as furniture items), room? (default the room around it), code (FL-02), description, pattern: tile|plank|none|<hatch>, size (default 500x500), angle, start, note (e.g. "LÁT ÂM SÀN")}]: the joints of the room stop at the zone edge, the zone gets its own joints, tag and area, and its area is taken off the room finish'),
    dry_run: z.boolean().default(false).describe('List the finishes it would assume per room, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const { spec, offset: at0, key, height, label: floorLabel } = floorFor(args, 'draw_floor_finish_plan');
  const rooms = await roomOutlines(spec, 'draw_floor_finish_plan', at0);
  const assumed = [];
  const finishes = finishesFor(interiorOf(key), rooms, args.rooms, assumed, height);
  const floors = Object.fromEntries(Object.entries(finishes).map(([k, f]) => [k, f.floor ? `${f.floor.code} ${f.floor.description}` : 'none']));
  if (args.dry_run) return dryRun(assumed, { floors });
  const sc = args.scale;
  const lang = args.language ?? language;
  const base = await planCopy('draw_floor_finish_plan', spec, args, sc, { dimensions: args.dimensions ?? undefined, interiorDims: args.interior_dimensions });
  const labels = Object.fromEntries((spec.rooms || []).map((r) => [String(r.name), r.at]));
  const sb = await sideBlock(base, sc, args, 'floor', lang, (legendAt) => engine('draw_floor_finish_plan', () => floorFinishPlan({
    rooms, finishes, labels, offset: base.offset, scale: sc, lang, spec, items: interiorOf(key).items, legendAt, zones: args.zones,
  })));
  const ff = sb.r;
  assumed.push(...ff.assumed);
  const extra = [...ff.entities, ...sb.notes];
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'FLOOR FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN SÀN'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  const warnings = [...(ff.warnings || []), ...(sb.side?.warning ? [sb.side.warning] : [])];
  return text({ offset: base.offset, floors: ff.legend, assumed: assumedOrNone(assumed), warnings: warnings.length ? warnings : undefined, count: res.count, bounds: res.bounds, ...sideOut(sb.side) });
}));

server.registerTool('draw_wall_finish_plan', {
  description:
    'Wall finish plan (mặt bằng hoàn thiện tường): a copy of the plan at 1:50; along the inside face of every wall of a room a band ' +
    'of its finish (one line for paint, two lines with the tile joints for tiles), broken at the doors and windows, the kitchen ' +
    'splashback behind the base cabinets of draw_furniture_plan, a code tag per room with the tiling height, the legend with the ' +
    'area of each wall finish (openings and splashback deducted) and the general notes. ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), legend: z.boolean().default(true),
    title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg, ...PlanCopyArgs,
    dry_run: z.boolean().default(false).describe('List the wall finishes it would assume per room, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const { spec, offset: at0, key, height, label: floorLabel } = floorFor(args, 'draw_wall_finish_plan');
  const rooms = await roomOutlines(spec, 'draw_wall_finish_plan', at0);
  const assumed = [];
  const st = interiorOf(key);
  const finishes = finishesFor(st, rooms, args.rooms, assumed, height);
  const walls = Object.fromEntries(Object.entries(finishes).map(([k, f]) => [k, f.wall ? `${f.wall.code} ${f.wall.description}` : 'none']));
  if (args.dry_run) return dryRun(assumed, { walls });
  const sc = args.scale;
  const lang = args.language ?? language;
  const base = await planCopy('draw_wall_finish_plan', spec, args, sc, { levels: false, dimensions: args.dimensions ?? undefined, interiorDims: args.interior_dimensions });
  const labels = Object.fromEntries((spec.rooms || []).map((r) => [String(r.name), r.at]));
  const sb = await sideBlock(base, sc, args, 'wall', lang, (legendAt) => engine('draw_wall_finish_plan', () => wallFinishPlan({
    spec, rooms, finishes, items: st.items, labels, offset: base.offset, scale: sc, lang, legendAt,
  })));
  const wf = sb.r;
  const extra = [...wf.entities, ...sb.notes];
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'WALL FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN TƯỜNG'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({ offset: base.offset, walls: wf.legend, assumed: assumedOrNone(assumed), warnings: sb.side?.warning ? [sb.side.warning] : undefined, count: res.count, bounds: res.bounds, ...sideOut(sb.side) });
}));

server.registerTool('draw_ceiling_plan', {
  description:
    'Reflected ceiling plan (mặt bằng trần đèn): a copy of the plan at 1:50 without door leaves; per room the drop band along the ' +
    'walls (step line, LED cove dashed), downlights in the band about every spacing (a grid on flat ceilings), a ceiling lamp in ' +
    'the middle or a pendant over each dining table of draw_furniture_plan, level tags (code over level) for the band and the ' +
    'field, the room name; then the light legend with counts (remembered for material_schedule, and the lights for ' +
    'lighting_calc). Lights placed by hand take lm, beam, w (and z, tilt, hang) for lighting_calc. ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), spacing: z.number().positive().default(1200),
    legend: z.boolean().default(true), title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg, ...PlanCopyArgs,
    mode: z.enum(['both', 'finish', 'lighting']).default('both')
      .describe('finish = ceiling finish plan (materials, levels, step widths; no lights), lighting = lighting layout (lights and legend; no level tags), both = one reflected ceiling plan'),
    lights: opt(Specs).describe('The lights where the designer puts them (then no automatic downlights, lamps or pendants; the LED cove of a drop band stays): [{type: downlight | spot | linear | ceiling_lamp | pendant | slot_diffuser | access_panel, at: [x,y] (plan coordinates, as furniture items) | from + to (linear, slot_diffuser) | at + length + angle, aim: [x,y] (spot), width, size (access panel, default 600), code (default LT-01 downlight, LT-05 spot, LT-06 linear, LT-03 lamp, LT-04 pendant, AC-01 diffuser, AP-01 access panel), description}]; the legend counts them by code (linear ones with their length). A T-bar grid ceiling: rooms[].ceiling.grid [600, 600]'),
    dry_run: z.boolean().default(false).describe('List the ceilings it would assume per room, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const { spec, offset: at0, key, height, label: floorLabel } = floorFor(args, 'draw_ceiling_plan');
  const st = interiorOf(key);
  const rooms = await roomOutlines(spec, 'draw_ceiling_plan', at0);
  const assumed = [];
  const finishes = finishesFor(st, rooms, args.rooms, assumed, height);
  const ceilings = Object.fromEntries(Object.entries(finishes).map(([k, f]) => [k, f.ceiling ? `${f.ceiling.code} +${f.ceiling.level}${f.ceiling.drop ? ` drop ${f.ceiling.drop.width}/${f.ceiling.drop.depth}` : ''}` : 'none']));
  if (args.dry_run) return dryRun(assumed, { ceilings });
  const sc = args.scale;
  const lang = args.language ?? language;
  const base = await planCopy('draw_ceiling_plan', spec, args, sc, { doors: false, roomLabels: false, levels: false, tags: false, dimensions: args.dimensions ?? undefined, interiorDims: args.interior_dimensions });
  const sb = await sideBlock(base, sc, args, args.mode === 'lighting' ? 'lighting' : 'ceiling', lang, (legendAt) => engine('draw_ceiling_plan', () => ceilingPlan({
    spec, rooms, finishes, items: st.items, offset: base.offset, scale: sc, spacing: args.spacing, lang, mode: args.mode, legendAt,
    lights: args.lights,
  })));
  const cp = sb.r;
  if (cp.lights) st.lights = cp.lights;
  if (args.mode !== 'finish') {
    st.fixtures = cp.fixtures;
    // the plan they belong to: another drawing of this session (another plan) does not take them
    st.fixturesKey = specKey(spec);
    st.ceilingArgs = { lights: args.lights, spacing: args.spacing };
  }
  const extra = [...cp.entities, ...sb.notes];
  if (sb.side?.warning) cp.warnings.push(sb.side.warning);
  const TITLES = {
    both: lang === 'en' ? 'REFLECTED CEILING PLAN' : 'MẶT BẰNG TRẦN ĐÈN',
    finish: lang === 'en' ? 'CEILING FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN TRẦN',
    lighting: lang === 'en' ? 'LIGHTING LAYOUT PLAN' : 'MẶT BẰNG BỐ TRÍ ĐÈN',
  };
  sheetTitle(base, args.title ?? `${TITLES[args.mode]}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({
    offset: base.offset, ceilings, lights: cp.lights, assumed: assumedOrNone(assumed), warnings: cp.warnings.length ? cp.warnings : undefined,
    count: res.count, bounds: res.bounds, ...sideOut(sb.side),
  });
}));

server.registerTool('draw_interior_elevation', {
  description:
    'Interior elevations (triển khai mặt đứng nội thất) of the walls of one room, seen from inside, side by side: cut end walls, ' +
    'floor slab and ceiling (the drop band cut at the ends), the doors and windows of the wall (from the plan), the furniture and ' +
    'joinery of draw_furniture_plan backed on it (front view) and along the side walls (side view), wall finish joints (tiles, ' +
    'panels), kitchen backsplash between base and wall cabinets, skirting, width and height dimension chains, material notes with ' +
    'leaders (codes + descriptions), title "MẶT ĐỨNG A - <room>". walls: A top, B right, C bottom, D left (as in plan). ' + INTERIOR_DEFAULTS,
  inputSchema: {
    room: Str, walls: jsonish(z.array(z.union([Str, z.number()]))).default(['A', 'B', 'C', 'D']), at: opt(Point),
    scale: z.number().positive().default(30), rooms: FinishRooms,
    items: opt(Specs).describe('Furniture as in draw_furniture_plan; default: the items of the last draw_furniture_plan'),
    wall_finishes: opt(Obj).describe('The finish of one wall where it differs from the room: {D: {code: "WL-02", description: "Kính sơn mặt sau", pattern: paint|tile|panel, size, height}} (A top, B right, C bottom, D left)'),
    titles: opt(Obj).describe('The title of an elevation instead of "MẶT ĐỨNG A - <room>": {A: "MẶT ĐỨNG A - SẢNH CHÍNH"}'),
    plan: opt(Obj), language: opt(Lang), floor: FloorArg,
    dry_run: z.boolean().default(false).describe('List the finishes and items it would show per wall, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const { spec, offset: at0, key, height } = floorFor(args, 'draw_interior_elevation');
  const st = interiorOf(key);
  const rooms = await roomOutlines(spec, 'draw_interior_elevation', at0);
  const poly = rooms[args.room];
  if (!poly) throw new Error(`draw_interior_elevation: room "${args.room}" not found (rooms: ${Object.keys(rooms).join(', ')})`);
  const assumed = [];
  const finishes = finishesFor(st, rooms, args.rooms, assumed, height);
  const own = assumed.filter((a) => a.item.startsWith(`${args.room}.`));
  let items = st.items;
  if (args.items) {
    const r = engine('draw_interior_elevation', () => resolveItems(args.items, rooms));
    items = r.items;
    own.push(...r.assumed);
  }
  const sc = args.scale;
  const lang = args.language ?? language;
  const wallKey = (w) => String(w).toUpperCase();
  const finishOf = (w) => {
    const own = args.wall_finishes?.[wallKey(w)] ?? args.wall_finishes?.[String(w)];
    const f = finishes[args.room];
    return own ? { ...f, wall: { ...(f.wall || {}), ...own } } : f;
  };
  const build = (wall, at) => engine('draw_interior_elevation', () => interiorElevation({
    spec, room: args.room, poly, finish: finishOf(wall), items, wall, at, scale: sc, lang,
    titleText: args.titles?.[wallKey(wall)] ?? args.titles?.[String(wall)] ?? null,
  }));
  if (args.dry_run) {
    const walls = args.walls.map((w) => {
      const r = build(w, [0, 0]);
      return { wall: w, openings: r.openings, items: r.items };
    });
    return dryRun(own, { walls });
  }
  const { at, info } = await freeSpot(args.at, sc);
  const ents = [];
  const placed = [];
  let x = at[0];
  for (const w of args.walls) {
    const probe = build(w, [0, at[1]]);
    const left = -probe.extent.min[0];
    const r = build(w, [x + left, at[1]]);
    ents.push(...r.entities);
    placed.push({ wall: w, at: [Math.round(x + left), at[1]], openings: r.openings, items: r.items, skipped: r.skipped.length ? r.skipped : undefined });
    x = r.extent.max[0] + 15 * sc;
  }
  const res = await drawView(ents, sc, info, lang);
  return text({ room: args.room, elevations: placed, assumed: assumedOrNone(own), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_joinery_detail', {
  description:
    'Joinery shop drawing (chi tiết đồ gỗ) at 1:10: kind kitchen (base cabinets with plinth, carcass, doors/drawers, stone top; ' +
    'backsplash; wall cabinets) or wardrobe (plinth, doors, top boxes): front elevation with the modules, hinge side dashed, ' +
    'handles, module and height dimension chains and section mark 1-1; section 1-1 through the carcass (panels 17 mm, back 8 mm, ' +
    'shelves, door, plinth, countertop, wall cabinet) with dimensions and material notes. item: the code of a kitchen_base or ' +
    'wardrobe of draw_furniture_plan takes its width, modules, sink and hob (and the kitchen_wall of the same room). materials ' +
    '{carcass, door, back, top, plinth, backsplash, rod, handle} replace the default specifications (reported in assumed).\n' +
    'kind display: display casework of a showroom or gallery (tủ trưng bày dạng hộc): bays between vertical fins (50) on a ' +
    'veneered back panel, each with a recessed plinth (80), a base cabinet with push-open doors up to 450, a display shelf (30), ' +
    'a picture panel (1450-2000, or a pegboard), a niche top shelf with an LED strip under it, a header box (mica front with an ' +
    'icon and the title of the bay), a top rail at height (2600) and a gypsum bulkhead up to the ceiling (2800). The elevation ' +
    'at scale (default 30) with material notes and dimension chains, and section 1-1 through a bay at section_scale (default ' +
    '10) beside it, its floor on the same line: put them on one sheet with create_layout views [{window: elevation, scale}, ' +
    '{window: section, scale: section_scale}]. bays: a count of equal bays, or [{w, title, subtitle, picture: false, ' +
    'pegboard: true}]; display {plinth, recess, base, shelf, header, rail, fin, back, depth, picture: [z0, z1] or null, panel}; ' +
    'materials {fin, back, shelf, niche_top, door, carcass, plinth, header, picture, led, rail, pegboard, bulkhead}.',
  inputSchema: {
    kind: z.enum(['kitchen', 'wardrobe', 'display']).default('kitchen'), item: opt(Str), name: opt(Str), code: opt(Str),
    width: opt(z.number().positive()), depth: opt(z.number().positive()), height: opt(z.number().positive()),
    modules: opt(Specs), wall_runs: opt(Specs).describe('[{x (from the left of the base run), w, modules}] wall cabinet runs; default one over the whole run'),
    hood: opt(Obj).describe('{x, w: 700, h: 650, z0: 1600} cooker hood between the wall cabinets'),
    sink: opt(z.number()), hob: opt(z.number()),
    base: opt(Obj), wall: opt(z.union([Obj, z.null()])), panel: opt(z.number().positive()), materials: opt(Obj),
    bays: opt(jsonish(z.union([z.number().int().positive(), z.array(z.union([z.number().positive(), z.record(z.string(), z.any())]))])))
      .describe('display: a count of equal bays, or [{w, title, subtitle, picture: false, pegboard: true, icon: false} or a width]'),
    display: opt(Obj).describe('display: sizes {plinth: 80, recess: 50, base: 450, shelf: 30, header: 400, rail: 110, fin: 50, back: 20, depth: 500, picture: [1450, 2000], panel: 18}'),
    ceiling: opt(z.union([z.number().positive(), z.null()])).describe('display: the ceiling level (2800): a gypsum bulkhead from the top of the casework up to it; null for none'),
    bulkhead: opt(z.boolean()),
    scale: opt(z.number().positive()).describe('Default 10 (display: 30, its elevation)'),
    section_scale: z.number().positive().default(10).describe('display: the scale of section 1-1'),
    at: opt(Point), language: opt(Lang),
    dry_run: z.boolean().default(false).describe('List the sizes and materials it would assume, without drawing'),
  },
  annotations: EDIT,
}, ({ dry_run, ...args }) => exclusive(async () => {
  const p = { ...args };
  if (args.item && args.kind === 'display') throw new Error('draw_joinery_detail: item takes a kitchen_base or wardrobe of the furniture plan; give the width and bays of a display casework');
  if (args.item) {
    const owner = [...interiorStates.values()].find((s2) => s2.items.some((x) => x.code === args.item && ['kitchen_base', 'wardrobe'].includes(x.type)));
    const pool = owner?.items ?? [];
    const it = pool.find((x) => x.code === args.item && ['kitchen_base', 'wardrobe'].includes(x.type));
    if (!it) throw new Error(`draw_joinery_detail: no kitchen_base or wardrobe with code ${args.item} in the last draw_furniture_plan`);
    p.kind = it.type === 'wardrobe' ? 'wardrobe' : 'kitchen';
    p.width = p.width ?? it.w;
    if (it.type === 'wardrobe') {
      p.depth = p.depth ?? it.d;
      p.height = p.height ?? it.h;
    } else {
      p.base = { d: it.d, h: it.h, ...(p.base || {}) };
      p.modules = p.modules ?? it.opts.modules;
      p.sink = p.sink ?? it.opts.sink;
      p.hob = p.hob ?? it.opts.hob;
      // wall cabinets and hood on the same wall, measured from the left end of the base run
      const along = (x) => (x.room === it.room && Math.abs(x.ey[0] - it.ey[0]) + Math.abs(x.ey[1] - it.ey[1]) < 1e-6
        ? (x.o[0] - it.o[0]) * it.ex[0] + (x.o[1] - it.o[1]) * it.ex[1] : null);
      const ups = pool.filter((x) => x.type === 'kitchen_wall' && along(x) !== null);
      if (ups.length && p.wall === undefined) {
        p.wall = { d: ups[0].d, h: ups[0].h, z0: ups[0].opts.z0 };
        p.wall_runs = p.wall_runs ?? ups.map((x) => ({ x: along(x), w: x.w, modules: x.opts.modules }));
      }
      const hood = pool.find((x) => x.type === 'hood' && along(x) !== null);
      if (hood && p.hood === undefined) p.hood = { x: along(hood), w: hood.w, d: hood.d, h: hood.h, z0: hood.opts.z0 };
    }
    const en = (p.language ?? language) === 'en';
    p.name = p.name ?? `${it.type === 'kitchen_base' ? (en ? 'KITCHEN CABINETS' : 'TỦ BẾP') : (en ? it.def.en : it.def.vi).toUpperCase()} ${it.code}`;
  }
  const sc = p.scale = p.scale ?? (p.kind === 'display' ? 30 : 10);
  if (dry_run) {
    const r = engine('draw_joinery_detail', () => joineryDetail({ ...p, at: [0, 0] }));
    return dryRun(r.assumed, { kind: p.kind, width: p.width, ...(r.bays ? { bays: r.bays } : {}) });
  }
  const { at, info } = await freeSpot(p.at, sc);
  if (p.kind === 'display') {
    // the elevation, then section 1-1 at its own scale to the right of what was drawn, its floor on the same line
    const r = engine('draw_joinery_detail', () => joineryDetail({ ...p, at }));
    const elev = await drawView(r.entities, sc, info, p.language);
    const dx = elev.bounds.max[0] + 20 * sc - r.section_extent.min[0];
    const sec = await drawView(r.section.map((e) => shiftEntity(e, [dx, 0])), p.section_scale, info, p.language);
    return text({
      kind: 'display', at, scale: `1:${sc}`, section_scale: `1:${p.section_scale}`, bays: r.bays, assumed: assumedOrNone(r.assumed),
      warnings: r.warnings.length ? r.warnings : undefined, count: elev.count + sec.count, elevation: elev.bounds, section: sec.bounds,
    });
  }
  const r = engine('draw_joinery_detail', () => joineryDetail({ ...p, at }));
  const res = await drawView(r.entities, sc, info, p.language);
  return text({ kind: p.kind, at, scale: `1:${sc}`, assumed: assumedOrNone(r.assumed), count: res.count, bounds: res.bounds });
}));

/**
 * The finish bill of the building of a plan: the rooms of every floor as they are drawn, their finishes (those of the
 * interior tools of this session, else the defaults by room name), the surface model and its rows. The exposed sides
 * of beams and columns come from the structure of structural_calc when it was run for the same plan.
 */
async function finishModel(args, tool, lang) {
  const whole = planFor(args, tool);
  const F = engine(tool, () => floorsOf(whole));
  const assumed = [];
  const floors = [];
  for (let i = 0; i < F.length; i++) {
    const t = F.length > 1 || whole.floors ? floorFor({ ...args, floor: i + 1 }, tool) : floorFor(args, tool);
    const st = interiorOf(t.key);
    const rooms = await roomOutlines(t.spec, tool, t.offset).catch(() => ({}));
    const finishes = finishesFor(st, rooms, undefined, assumed, t.height);
    floors.push({ name: t.key || F[i].name || '', spec: t.spec, height: F[i].height ?? t.height ?? 3000, rooms, finishes, items: st.items });
  }
  if (!floors.some((f) => Object.keys(f.rooms).length)) throw new Error(`${tool}: no room outlines found: draw the plan with draw_plan (or rooms_only) first.`);
  const key = specKey(whole);
  const structure = lastCalc?.key === key ? lastCalc.R : null;
  const Q = engine(tool, () => finishQuantities({ floors, spec: whole, lang, rules: args.rules ?? null, structure }));
  lastFinish = { key, rules: args.rules ?? null, lang, whole, floors, Q, assumed };
  return lastFinish;
}

/**
 * The finish faces measured again by AutoCAD: every face with an outline in plan (floors, landings, ceilings, soffits,
 * waterproofing, screed) as a region less the wells cut in it, every wall face of a room as its rectangle less its
 * openings where they stand, and the floor plate of every floor as the union of its rooms, walls and columns (its area
 * against the plate of the bill, its perimeter against the lengths of the outer faces).
 */
verifyFinishes = async (tool, spec, args, lang) => {
  let fm = lastFinish?.key === specKey(spec) && !args.rules && lastFinish.lang === lang ? lastFinish : null;
  if (!fm) {
    try {
      fm = await finishModel(args, tool, lang);
    } catch (e) {
      return { skipped: e.message };
    }
  }
  const { Q } = fm;
  const r3 = (v) => Math.round(v * 1e3) / 1e3, r6 = (v) => Math.round(v * 1e6) / 1e6;
  const faces = [], expect = new Map();
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  for (const f of Q.faces) {
    if (f.unit !== 'm²' || expect.has(f.id)) continue;
    if (Array.isArray(f.outline) && f.outline.length >= 3) {
      const cut = f.deductions.filter((d) => Array.isArray(d.poly) && d.poly.length >= 3);
      faces.push({ id: f.id, outline: f.outline, holes: cut.length ? cut.map((d) => d.poly) : undefined });
      expect.set(f.id, f.gross - cut.reduce((a, d) => a + d.area, 0));
    } else if (f.kind === 'wall' && f.L > 0 && f.H > 0 && (f.n ?? 1) === 1) {
      const cut = f.deductions.filter((d) => d.u !== undefined && d.w > 0 && d.h > 0);
      faces.push({
        id: f.id, outline: rect(0, 0, f.L * 1000, f.H * 1000),
        holes: cut.length ? cut.map((d) => rect(d.u * 1000, (d.z ?? 0) * 1000, d.w * 1000, d.h * 1000)) : undefined,
      });
      expect.set(f.id, f.gross - cut.reduce((a, d) => a + d.area, 0));
    }
  }
  const plates = [];
  for (const fl of Q.floors || []) {
    const M = fl.S?.M;
    if (!M || !SURF.plateOutlines || !Object.keys(fl.rooms || {}).length) continue;
    const o = engine(tool, () => SURF.plateOutlines(M, fl.rooms));
    const all = [...o.rooms, ...o.walls, ...o.columns];
    if (!all.length) continue;
    const id = `plate/${fl.name}`;
    faces.push({ id, outline: all[0], add: all.length > 1 ? all.slice(1) : undefined });
    plates.push({ id, floor: fl.name, plate: SURF.floorPlate(M, fl.rooms).plate / 1e6, outer: fl.S.faces.filter((f) => f.kind === 'exterior').reduce((a, f) => a + f.L, 0) });
  }
  if (!faces.length) return { skipped: 'no finish face to measure' };
  const m = await measureModel({ faces }, sendNow); // already inside exclusive()
  const got = new Map(m.faces.map((x) => [x.id, x]));
  const tol = args.tolerance / 100;
  const off = (a, b) => Math.abs(a - b) > Math.max(0.001, tol * Math.abs(b));
  let bill = 0, acad = 0;
  const bad = [];
  for (const [id, e] of expect) {
    const a = got.get(id)?.area_m2 ?? 0;
    bill += e;
    acad += a;
    if (off(a, e)) bad.push({ face: id, bill_m2: r6(e), autocad_m2: a });
  }
  const pct = Math.abs(bill) > 1e-9 ? Math.round(((acad - bill) / bill) * 1e5) / 1e3 : 0;
  const floorsOut = plates.map((q) => {
    const g = got.get(q.id) ?? {};
    // the outer faces of the bill follow the outline of the plate (to the millimetre of their ends)
    const lineOk = Math.abs((g.perimeter_m ?? 0) - q.outer) <= Math.max(0.02, tol * q.outer);
    return {
      floor: q.floor, plate_bill_m2: r3(q.plate), plate_autocad_m2: r3(g.area_m2 ?? 0), outer_faces_bill_m: r3(q.outer), outline_autocad_m: r3(g.perimeter_m ?? 0),
      ok: !off(g.area_m2 ?? 0, q.plate) && lineOk,
    };
  });
  return {
    faces: expect.size, bill_m2: r3(bill), autocad_m2: r3(acad), difference_percent: pct,
    ok: !bad.length && Math.abs(pct) <= args.tolerance && floorsOut.every((x) => x.ok),
    disagree: bad.length ? bad.slice(0, 30) : undefined, disagree_count: bad.length || undefined,
    floors: floorsOut.length ? floorsOut : undefined,
    rules: Q.rules?.name, checks: checkSummary(Q.checks),
  };
};

server.registerTool('draw_finish_quantities', {
  description:
    'Architectural finish quantities (bảng khối lượng hoàn thiện kiến trúc) of the building of draw_plan, floor by floor, for ' +
    'the architectural set: floor tiles by finish, wall tiles (toilets, kitchen backsplash), skirting; skim coat and paint of ' +
    'the inner walls, the outer walls (faces with no room on their side, the plinth, parapets) and the ceilings (gypsum, ' +
    'concrete soffits); gypsum ceilings; waterproofing of toilets, balconies and the roof terrace (300 up the walls), screed ' +
    'to falls, the tower roof; stair granite (treads, landings, risers), stair and balcony railings; doors and windows by ' +
    'type (sets and m²). The rooms and finishes are those of the interior tools (material_schedule, the same defaults by ' +
    'room name, the finishes given there in this session). Every quantity is the sum of the faces of a surface model ' +
    '(a wall face by the height of the wall behind it with its openings and reveals, the vertical face of a dropped ' +
    'ceiling, treads and risers, the floor under the doors), measured by the rule set (rules) with the geometric net ' +
    'beside it, to three decimals; the result lists the cross-checks that fail. Drawn as a table with the quantity of every ' +
    'floor (diễn giải); csv_path writes it for Excel (with a geometric column). Masonry and plaster are in the structural ' +
    'bill (draw_quantity_schedule); verify_quantities has AutoCAD measure the faces again.',
  inputSchema: {
    scale: z.number().positive().default(25), csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('semicolon'),
    at: opt(Point), plan: opt(Obj), language: opt(Lang), draw: z.boolean().default(true),
    xlsx_path: opt(Str).describe('Excel workbook with live formulas: the bill summed from the faces (sheet "Bề mặt", Bảng 6.2: like parts x length x height, less and plus), the stairs from their parameters, the doors, and the cross-checks (sheet "Kiểm tra")'),
    rules: RulesArg,
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const lang = args.language ?? language;
  const { whole, floors, Q, assumed } = await finishModel(args, 'draw_finish_quantities', lang);
  const out = {
    // measured by the rule set; the geometric quantity beside it where the two differ
    rows: Q.rows.filter((r) => !r.head).map((r) => `${r.stt}. ${r.item}: ${r.q} ${r.unit}${r.geo !== undefined && Math.abs(r.geo - r.q) > 5e-4 ? ` (geometric ${r.geo})` : ''}`),
    rules: Q.rules?.name,
    checks: checkSummary(Q.checks),
    warnings: Q.warnings?.length ? Q.warnings : undefined,
    assumed: assumedOrNone([...assumed, ...(Q.assumed || [])]),
  };
  if (args.draw) {
    const sc = args.scale;
    const { at, info } = await freeSpot(args.at, sc);
    const sheet = finishSheet(Q, { scale: sc, lang });
    const res = await drawView(placeAt(sheet.entities, at), sc, info, args.language);
    out.count = res.count;
    out.bounds = res.bounds;
  }
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, finishCsv(Q, lang, args.csv_format === 'comma' ? ',' : ';'), 'utf8');
    out.csv = file;
  }
  if (args.xlsx_path) {
    const file = path.resolve(args.xlsx_path.endsWith('.xlsx') ? args.xlsx_path : `${args.xlsx_path}.xlsx`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, finishWorkbook(Q, floors.map((x) => x.name), lang));
    out.xlsx = file;
  }
  return text(out);
}));

server.registerTool('lighting_calc', {
  description:
    'Illuminance check of a lighting layout (kiểm tra độ rọi theo TCVN 7114-1:2008 = ISO 8995-1): the lights of the last ' +
    'draw_ceiling_plan of the floor (or lights given here, as in draw_ceiling_plan) as point sources with their beam, by ' +
    'default downlight 800 lm 60°, spot 700 lm 36° aimed at its aim, linear 1200 lm/m, ceiling lamp 2000 lm, pendant 1500 lm ' +
    'hung 900 below the ceiling, LED cove 600 lm/m as reflected light only (photometry {"LT-01": {lm, beam, w}} by code or ' +
    'kind, or lm/beam/w on each light, replaces them). The direct illuminance on a grid of the work plane of each room (0.75 m; ' +
    'the floor in corridors, stairs and entrance halls; EN 12464-1 grid without a 0.5 m band along the walls) times the ' +
    'maintenance factor 0.8, plus the inter-reflected light (integrating sphere, reflectances ceiling/walls/floor 0.7/0.5/0.2). ' +
    'Per room: Em, Emin, Emax, U0 against the requirement of its task, found from the room name (office 500 lx U0 0.6, ' +
    'meeting 500/0.6, reception 300/0.6, sales and showroom 300/0.4, canteen 200/0.4, toilets 200/0.4, stairs 150/0.4, ' +
    'corridor and entrance 100/0.4, store 100/0.4...; rooms of a dwelling get reference values, not a pass or a fail), the ' +
    'power and the lighting power density (W/m²), and what to change where it fails. vertical: planes such as display walls ' +
    '[{name, from, to, z0, z1, em}] (illuminance on the face looking into the room). csv_path saves the table; table: true ' +
    'draws it. Walls between rooms block light: only the lights of a room light it.',
  inputSchema: {
    rooms: opt(Obj).describe(`{room name: {task, em, u0, plane}}: task one of ${Object.keys(LUX_TASKS).join(', ')}; em/u0 a requirement of its own; plane the height of the reference plane (mm)`),
    lights: opt(Specs).describe('Lights as in draw_ceiling_plan (plan coordinates), with lm, beam, w, z, tilt, hang; default: those of the last draw_ceiling_plan of the floor'),
    photometry: opt(Obj).describe('{code or kind: {lm (lm_m for linear and strip), beam (degrees, 120 = diffuse), w (w_m), hang (pendant)}}'),
    maintenance_factor: z.number().positive().max(1).default(0.8),
    work_plane: z.number().min(0).default(750), margin: z.number().min(0).default(500),
    grid: opt(z.number().positive()).describe('Grid spacing (mm); default by EN 12464-1 from the size of the room'),
    reflectances: opt(Obj).describe('{ceiling: 0.7, walls: 0.5, floor: 0.2}'),
    vertical: opt(Specs).describe('[{name, room, from: [x,y], to: [x,y], z0: 800, z1: 2000, em, u0}] vertical planes'),
    csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('semicolon'),
    table: z.boolean().default(false).describe('Draw the table in the drawing'), at: opt(Point), scale: z.number().positive().default(50),
    plan: opt(Obj), floor: FloorArg, language: opt(Lang),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'lighting_calc';
  const lang = args.language ?? language;
  const { spec, offset: at0, key, height } = floorFor(args, tool);
  const st = interiorOf(key);
  const rooms = await roomOutlines(spec, tool, at0);
  let fixtures = args.lights || st.fixturesKey !== specKey(spec) ? null : st.fixtures;
  // a drawing reopened in another session: the ceiling plan of the floor as the drawing keeps it (its lights, its ceilings)
  const kept = fixtures || args.lights ? null : (viewStore.getStore()?.views || [])
    .filter((v) => v.tool === 'draw_ceiling_plan' && v.entities > 0 && (v.args?.mode ?? 'both') !== 'finish' && String(v.args?.floor ?? '') === String(args.floor ?? ''))
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))[0]?.args ?? null;
  const finishes = finishesFor(st, rooms, kept?.rooms, [], height);
  const extra = [];
  let source = 'draw_ceiling_plan';
  if (!fixtures) {
    // the lights given here, else those of the ceiling plan kept in the drawing, else those the ceiling rules would place
    const cp = engine(tool, () => ceilingPlan({
      spec, rooms, finishes, items: st.items, offset: [0, 0], scale: 50, spacing: kept?.spacing ?? st.ceilingArgs?.spacing ?? 1200, mode: 'lighting',
      lights: args.lights ?? kept?.lights ?? st.ceilingArgs?.lights,
    }));
    fixtures = cp.fixtures;
    source = args.lights ? 'lights' : kept ? 'draw_ceiling_plan (kept in the drawing)' : 'ceiling rules';
    if (!args.lights && !kept) extra.push({ item: 'lights', value: 'the automatic lights of the ceiling rules', note: 'no draw_ceiling_plan of this floor: give lights or draw the ceiling plan first' });
  }
  const unknown = Object.keys(args.rooms || {}).filter((n) => !rooms[n]);
  const heights = Object.fromEntries(Object.keys(rooms).map((n) => [n, finishes[n]?.ceiling?.level ?? height ?? 3000]));
  const r = engine(tool, () => lightingCalc({
    rooms, heights, fixtures, given: args.rooms || {}, photometry: args.photometry || {}, mf: args.maintenance_factor, plane: args.work_plane,
    margin: args.margin, spacing: args.grid ?? null, reflectances: args.reflectances || {}, vertical: args.vertical || [], lang,
  }));
  const rows = luxTable(r, lang);
  const out = {
    source, lights: fixtures.length, rooms: r.rooms, vertical: r.vertical, assumed: assumedOrNone([...extra, ...r.assumed]), method: r.method,
    warnings: [...(unknown.length ? [`rooms not in the plan: ${unknown.join(', ')}`] : []), ...r.warnings],
  };
  if (!out.warnings.length) delete out.warnings;
  if (args.csv_path) {
    const sep = args.csv_format === 'semicolon' ? ';' : ',';
    const numFmt = (v) => (typeof v === 'number' && args.csv_format === 'semicolon' ? String(v).replace('.', ',') : v);
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, BOM + rows.map((row) => row.map((c) => csvCell(numFmt(c), sep)).join(sep)).join('\r\n') + '\r\n', 'utf8');
    out.csv = file;
  }
  if (args.table) {
    const sc = args.scale;
    const { at, info } = await freeSpot(args.at, sc);
    const table = {
      type: 'table', at, title: lang === 'en' ? 'ILLUMINANCE CHECK (TCVN 7114-1:2008)' : 'BẢNG KIỂM TRA ĐỘ RỌI (TCVN 7114-1:2008)', rows,
      decimal_separator: lang === 'en' ? undefined : ',', height: 2.5 * sc, row_height: 8 * sc,
      col_widths: [32, 48, 18, 14, 14, 14, 14, 12, 12, 18, 16, 24].map((w) => w * sc), layer: ROLE.text, style: TEXT_STYLE,
    };
    const res = await drawView([table], sc, info, lang);
    out.table = { at, bounds: res.bounds };
  }
  return text(out);
}));

server.registerTool('material_schedule', {
  description:
    'Finish and material schedule (bảng thống kê vật liệu hoàn thiện): floors and ceilings in m² from the room outlines, ' +
    'skirting in m (door widths deducted), walls in m² face by face (the height of the wall behind each face, openings ' +
    'deducted by the rule set of rules, their reveals added), the drop face of a ceiling, stairs on their treads and risers, kitchen ' +
    'backsplash, furniture/joinery/sanitary/equipment by count (draw_furniture_plan) and lights (draw_ceiling_plan); one row per ' +
    'code with its rooms. Draws a table (default right of the drawing) and csv_path saves it for Excel. ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, draw: z.boolean().default(true), at: opt(Point), scale: z.number().positive().default(50),
    csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('comma'), plan: opt(Obj), language: opt(Lang),
    floor: FloorArg.describe('One floor of a building; default: every floor (rooms listed as "<floor>: <room>")'),
    rules: RulesArg,
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const lang = args.language ?? language;
  const assumed = [];
  const whole = planFor(args, 'material_schedule');
  const multi = Array.isArray(whole.floors) && whole.floors.length && args.floor === undefined;
  const targets = multi ? floorsOf(whole).map((f, i) => floorFor({ ...args, floor: i + 1 }, 'material_schedule')) : [floorFor(args, 'material_schedule')];
  const acc = new Map();
  const FL = Array.isArray(whole.floors) && whole.floors.length ? engine('material_schedule', () => floorsOf(whole)) : [];
  const structure = lastCalc?.key === specKey(whole) ? lastCalc.R : null;
  let ms;
  for (const t of targets) {
    const st = interiorOf(t.key);
    let rooms, handles;
    try {
      handles = {};
      rooms = await roomOutlines(t.spec, 'material_schedule', t.offset, handles);
    } catch (e) {
      if (multi) continue; // a floor without rooms (e.g. a roof)
      throw e;
    }
    const finishes = finishesFor(st, rooms, multi ? undefined : args.rooms, assumed, t.height);
    // the place of the floor in the building: the slab over it (a room with no suspended ceiling is finished up to its
    // soffit) and the columns of structural_calc that stand out of its walls, as in the architectural bill
    const k = FL.findIndex((f) => f.name === t.key);
    const place = k >= 0 ? { top: k === FL.length - 1, slab: FL[k + 1]?.slab ?? null, structure, index: k } : {};
    ms = engine('material_schedule', () => materialSchedule({ spec: t.spec, rooms, finishes, items: st.items, lights: st.lights, lang, floor: multi ? t.key : null, acc, handles, rules: args.rules ?? null, ...place }));
  }
  if (!ms) throw new Error('material_schedule: no room outlines found: draw the plan with draw_plan first.');
  const out = { rows: ms.rows, assumed: assumedOrNone(assumed) };
  if (args.draw) {
    const sc = args.scale;
    const { at: pos, info } = await freeSpot(args.at, sc);
    const table = {
      type: 'table', at: pos, title: lang === 'en' ? 'FINISH AND MATERIAL SCHEDULE' : 'BẢNG THỐNG KÊ VẬT LIỆU HOÀN THIỆN', rows: ms.drawn, decimal_separator: lang === 'en' ? undefined : ',',
      height: 2.5 * sc, row_height: 8 * sc, col_widths: [16, 16, 30, 75, 55, 12, 22].map((w) => w * sc), layer: ROLE.text, style: TEXT_STYLE,
    };
    const res = await drawView([table], sc, info, lang);
    out.table = res.results?.[0]?.handle ?? res.entities?.[0]?.handle;
    out.at = pos;
  }
  if (args.csv_path) {
    const sep = args.csv_format === 'semicolon' ? ';' : ',';
    const numFmt = (v) => (typeof v === 'number' && args.csv_format === 'semicolon' ? String(v).replace('.', ',') : v);
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, BOM + ms.table.map((r) => r.map((c) => csvCell(numFmt(c), sep)).join(sep)).join('\r\n') + '\r\n', 'utf8');
    out.csv = file;
  }
  return text(out);
}));

// ---------------------------------------------------------------- electrical and plumbing sets (điện, cấp thoát nước)

/** The lights of a floor by the ceiling rules of the interior set (the lighting layout of draw_ceiling_plan). */
function ceilingLights(rooms, finishes, items, spacing) {
  const cp = ceilingPlan({ rooms, finishes, items, offset: [0, 0], scale: 100, spacing, mode: 'lighting' });
  const kinds = Object.fromEntries(Object.entries(LIGHT_BLOCKS).map(([k, v]) => [v.name, k]));
  const out = [];
  for (const e of cp.entities) {
    if (e.type === 'block' && kinds[e.name] && kinds[e.name] !== 'strip') out.push({ kind: kinds[e.name], at: e.at });
    else if (e.type === 'polyline' && e.layer === ROLE.light_strip && e.closed) {
      const L = e.points.reduce((s, p, i) => {
        const q = e.points[(i + 1) % e.points.length];
        return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
      }, 0);
      out.push({ kind: 'strip', at: e.points[0], points: e.points, length: L });
    }
  }
  return out;
}

/**
 * Every floor of the building with its rooms (measured by AutoCAD from the plan), its furniture (draw_furniture_plan,
 * else the default fixtures of wet rooms and kitchens) and its finishes, for the electrical and plumbing designs.
 */
async function mepFloors(args, tool) {
  const spec = planFor(args, tool);
  const multi = Array.isArray(spec.floors) && spec.floors.length > 0;
  const list = multi ? engine(tool, () => floorsOf(spec)) : [{ spec, name: '', level: 0, height: spec.heights?.top ?? 3000 }];
  const assumed = [], floors = [];
  for (const [k, f] of list.entries()) {
    const key = multi ? f.name : '';
    const offset = !args.plan && floorSpots()?.offsets?.[k] ? floorSpots().offsets[k] : [0, 0];
    const rooms = await roomOutlines(f.spec, tool, offset).catch(() => ({}));
    const st = interiorOf(key);
    const df = engine(tool, () => defaultFixtures(rooms, f.spec, st.items, args.options?.shaft ?? 400));
    const extra = engine(tool, () => resolveItems(df.items, rooms)).items;
    assumed.push(...df.assumed.map((a) => ({ ...a, item: `${key ? `${key} ` : ''}${a.item}` })));
    floors.push({ name: key, index: k, level: f.level ?? 0, height: f.height ?? 3000, spec: f.spec, rooms, items: [...st.items, ...extra], finishes: finishesFor(st, rooms, undefined, [], f.height) });
  }
  return { spec, floors, assumed, list };
}

/** items of one floor (as draw_furniture_plan, nothing drawn): remembered for the device and fixture positions. */
async function rememberItems(args, tool) {
  const { spec, offset, key } = floorFor(args, tool);
  const rooms = await roomOutlines(spec, tool, offset);
  interiorOf(key).items = engine(tool, () => resolveItems(args.items, rooms)).items;
}

const mepCache = { elec: null, plumb: null };
const interiorSig = () => JSON.stringify([...interiorStates.entries()].map(([k, s]) => [k, s.items.map((it) => [it.type, it.room, it.o, it.ex, it.w, it.d, it.opts?.sink, it.opts?.hob]), s.given]));

async function electricalModel(args, tool) {
  if (args.items) await rememberItems(args, tool);
  const spec = planFor(args, tool);
  const lang = args.language ?? language;
  const key = JSON.stringify([specKey(spec), args.options ?? null, args.spacing ?? 1200, lang, interiorSig()]);
  if (mepCache.elec?.key === key) return mepCache.elec.D;
  const { floors, assumed } = await mepFloors(args, tool);
  for (const f of floors) f.lights = ceilingLights(f.rooms, f.finishes, f.items, args.spacing ?? 1200);
  const D = engine(tool, () => electricalDesign({ floors, options: args.options ?? {}, lang }));
  D.assumed.unshift(...assumed);
  D.floors.forEach((F, k) => {
    F.polys = floors[k].rooms;
  });
  mepCache.elec = { key, D };
  return D;
}

async function plumbingModel(args, tool) {
  if (args.items) await rememberItems(args, tool);
  const spec = planFor(args, tool);
  const lang = args.language ?? language;
  const key = JSON.stringify([specKey(spec), args.options ?? null, lang, interiorSig()]);
  if (mepCache.plumb?.key === key) return mepCache.plumb.D;
  const { floors, assumed, list } = await mepFloors(args, tool);
  // the drains of the roof terrace (as draw_roof_plan places them)
  let roofDrains = [];
  try {
    const top = list[list.length - 1];
    const parapet = (top.spec.walls || []).find((w) => w.height !== undefined)?.height ?? 1000;
    roofDrains = roofPlan({ top, terrace: top.level ?? 0, roof: (top.level ?? 0) + (top.height ?? 3000) + 120, parapet, fall: 2, scale: 100, lang }).drainPoints ?? [];
  } catch {
    roofDrains = [];
  }
  const D = engine(tool, () => plumbingDesign({ floors, roofDrains, options: args.options ?? {}, lang }));
  D.assumed.unshift(...assumed);
  D.floors.forEach((F, k) => {
    F.polys = floors[k].rooms;
    F.items = floors[k].items;
  });
  mepCache.plumb = { key, D };
  return D;
}

/** Boxes of the drawn devices or fixtures (room names keep clear of them). */
const pointBoxes = (pts, half) => pts.map((p) => [p[0] - half, p[1] - half, p[0] + half, p[1] + half]);
const textBoxes = (ents) => [
  ...ents.filter((e) => e.type === 'text').map((e) => {
    const w = textWidth(e.text, e.height), h = e.height;
    const x0 = /right/.test(e.align ?? '') ? e.at[0] - w : /center/.test(e.align ?? '') ? e.at[0] - w / 2 : e.at[0];
    const y0 = /^middle/.test(e.align ?? '') ? e.at[1] - h / 2 : e.at[1];
    return [x0, y0, x0 + w, y0 + h];
  }),
  // tags and symbols that know their extent (door and window tags, grid bubbles, door swings)
  ...ents.filter((e) => e.type === 'block' && Array.isArray(e.box)).map((e) => e.box),
  // dimension chains: the band of their line and texts (text above a horizontal line, left of a vertical one)
  ...ents.filter((e) => e.type === 'dim_chain' && Array.isArray(e.points) && Array.isArray(e.at)).map((e) => {
    const xs = e.points.map((p) => p[0]), ys = e.points.map((p) => p[1]);
    const sc = Number(String(e.style ?? '').split('-').pop()) || 100;
    return e.direction === 'vertical' ? [e.at[0] - 4 * sc, Math.min(...ys), e.at[0] + 0.6 * sc, Math.max(...ys)] : [Math.min(...xs), e.at[1] - 0.6 * sc, Math.max(...xs), e.at[1] + 4 * sc];
  }),
];
/** The plan copy with its dimensions as the box the labels of a plan stay in. */
const planLimit = (base, sc) => [base.bounds.min[0] - 2 * sc, base.bounds.min[1] - 2 * sc, base.bounds.max[0] + 2 * sc, base.bounds.max[1] + 2 * sc];

/**
 * The plan under an electrical or plumbing plan: walls, doors, grids and two dimension chains away from the front of
 * the house (front: the meter or the manhole there), no tags, no stair texts; the room names come after.
 */
const mepCopy = (front) => ({ roomLabels: false, levels: false, tags: false, stairLabels: false, front: front ?? null });

/**
 * Boxes along the lines, arcs and symbols an engine drew (at offset), back in plan coordinates: the room names keep
 * off the wires and the pipes.
 */
function drawnBoxes(ents, offset, sc) {
  const out = [];
  const put = (p, r) => out.push([p[0] - offset[0] - r, p[1] - offset[1] - r, p[0] - offset[0] + r, p[1] - offset[1] + r]);
  const seg = (a, b, bulge) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1) return;
    // a positive bulge: the arc runs counter-clockwise from a to b, to the right of the chord
    const n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L], sag = (bulge * L) / 2;
    const steps = Math.max(1, Math.ceil(L / 120));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, q = 4 * t * (1 - t) * sag;
      put([a[0] + (b[0] - a[0]) * t + n[0] * q, a[1] + (b[1] - a[1]) * t + n[1] * q], 70);
    }
  };
  for (const e of ents) {
    if (e.type === 'line' && e.from && e.to) seg(e.from, e.to, 0);
    else if (e.type === 'polyline' && Array.isArray(e.points)) {
      const n = e.points.length;
      for (let i = 0; i < (e.closed ? n : n - 1); i++) seg(e.points[i], e.points[(i + 1) % n], e.bulges?.[i] ?? 0);
    } else if (e.type === 'block' && e.at) put(e.at, 1.5 * sc);
    else if (e.type === 'circle' && e.center) put(e.center, (e.radius ?? 0) + 30);
  }
  return out;
}

/** The stairs of a plan as boxes (labels are not written on the treads). */
const stairBoxes = (spec, offset) => [...(spec.stairs || []), ...(spec.stairs_below || [])].filter((st) => Array.isArray(st.region)).map((st) => {
  const [[x0, y0], [x1, y1]] = st.region;
  return [Math.min(x0, x1) + offset[0], Math.min(y0, y1) + offset[1], Math.max(x0, x1) + offset[0], Math.max(y0, y1) + offset[1]];
});

/**
 * The room names of an electrical or plumbing plan: the name alone (the areas are on the architectural plans), where
 * the devices or fixtures (busy boxes, plan coordinates) leave room, not for the stairs. Returns the text entities at
 * offset and their boxes (obstacles of the other labels).
 */
function roomNames(spec, polys, busy, offset, sc, planEnts = []) {
  const entities = [], boxes = [];
  // the doors with their swings, the windows and the tags of the plan copy (their boxes are at offset)
  const taken = [...busy, ...planEnts.filter((e) => e.type === 'block' && e.box).map((e) => [e.box[0] - offset[0], e.box[1] - offset[1], e.box[2] - offset[0], e.box[3] - offset[1]])];
  for (const rm of spec.rooms || []) {
    const name = String(rm.name);
    const poly = polys?.[name];
    if (!poly || STAIR_ROOM(name)) continue;
    // a text height clear of the walls on both sides
    const sizeOf = (hh) => [textWidth(name, hh) + 2 * hh, 1.8 * hh];
    // clear of the devices and the doors, smaller in a crowded room; when nothing is free: over as little as it can
    let h = 2.5 * sc, p = null;
    for (const k of [2.5, 2, 1.8]) {
      p = freePoint(poly, taken, sizeOf(k * sc), rm.at, [], 50);
      if (p) { h = k * sc; break; }
    }
    if (!p) {
      h = 2 * sc;
      p = freePoint(poly, [], sizeOf(h), rm.at, taken, 50) ?? rm.at;
    }
    const size = sizeOf(h);
    const box = [p[0] - size[0] / 2, p[1] - size[1] / 2, p[0] + size[0] / 2, p[1] + size[1] / 2];
    taken.push(box);
    entities.push({ type: 'text', text: name, at: [Math.round(p[0] + offset[0]), Math.round(p[1] + offset[1])], height: h, align: 'middle_center', layer: ROLE.room_tag, style: TEXT_STYLE });
    boxes.push([box[0] + offset[0], box[1] + offset[1], box[2] + offset[0], box[3] + offset[1]]);
  }
  return { entities, boxes };
}

const MepOptions = opt(Obj);
const STAIR_ROOM = (name) => /(CẦU THANG|STAIR)/i.test(name);
const ItemsArg = opt(Specs).describe('Furniture of this floor (as draw_furniture_plan, not drawn): sets the bedside, desk, kitchen and bathroom positions');
const floorIndex = (D, key) => Math.max(0, D.floors.findIndex((F) => F.name === key));
const langOf = (args) => args.language ?? language;

server.registerTool('draw_electrical_plan', {
  description:
    'Electrical plan of one floor (mặt bằng điện) for the electrical set (its own file), from the plan of draw_plan. mode ' +
    'lighting (mặt bằng chiếu sáng): the lights by the ceiling rules of the interior set (downlights in the drop band, ' +
    'ceiling lamps, pendants over dining tables, LED coves), extract fans in WCs, outdoor wall lights, the stair lamp; one ' +
    'switch per room by its main door (latch side, WC switches outside the WC) with one gang per group of lights, two-way ' +
    'switches at the stairs; the wiring of each circuit as arcs and its home run to the board named L1, L2... (the circuits listed under the plan). mode power ' +
    '(mặt bằng ổ cắm, điều hòa): double sockets by the kind of room (bedside, desk, TV wall, dining), worktop sockets, hob ' +
    'outlet and hood socket, weatherproof sockets in WCs and yards, wall air conditioners sized at 600 BTU/m² with their ' +
    'sockets, water heaters in WCs, the pump, data and TV outlets to the data cabinet, the meter outside the front door; ' +
    'circuits S, ĐH, NL, BT, BN (English set: S, AC, WH, CK, PU). Boards: TĐ-1, TĐ-2... (DB-1...) by the stair door, the main ' +
    'board TĐ-T (MDB) on the ground floor (a floor ' +
    'without rooms of its own, e.g. the stair tower, is fed from the board below). Legend with the counts, the circuits of ' +
    'the floor, general notes. The same design (devices, circuits, loads) serves draw_electrical_diagram and ' +
    'electrical_calc. Defaults (heights, circuit sizes, demand factors, powers) are listed in assumed; options: {heights, ' +
    'max_lights, max_sockets, btu_per_m2, power, ks, kdt, pump: false}.',
  inputSchema: {
    floor: FloorArg, mode: z.enum(['lighting', 'power']).default('lighting'), scale: z.number().positive().default(100),
    offset: opt(Point), legend: z.boolean().default(true), notes: NotesArg, title: opt(Str), plan: opt(Obj), language: opt(Lang),
    items: ItemsArg, options: MepOptions, spacing: z.number().positive().default(1200).describe('Downlight spacing of the ceiling rules (mm)'),
    circuits: z.boolean().default(true).describe('List the circuits of the floor under its plan'),
    dry_run: z.boolean().default(false).describe('List the design (boards, circuits, devices) and what it assumes, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'draw_electrical_plan';
  const { spec, key, label: floorLabel } = floorFor(args, tool);
  const D = await electricalModel(args, tool);
  const k = floorIndex(D, key);
  const F = D.floors[k];
  const count = {};
  for (const d of F.devices) count[d.kind] = (count[d.kind] ?? 0) + 1;
  const B = D.boards.find((b) => b.id === F.served);
  const circuits = (B?.circuits ?? []).filter((c) => c.floors.includes(F.name)).map((c) => `${c.id} ${c.name} (${c.rooms.join(', ')}): ${c.P} W, ${c.breaker}, ${c.cable}`);
  const summary = { floor: F.name, board: F.board?.label ?? `${F.served} (${langOf(args) === 'en' ? 'floor below' : 'tầng dưới'})`, devices: count, circuits };
  if (args.dry_run) return dryRun(D.assumed, { ...summary, warnings: D.warnings.length ? D.warnings : undefined });
  const sc = args.scale;
  const lg = langOf(args);
  const pts = F.devices.filter((d) => d.kind !== 'strip').map((d) => d.at);
  const base = await planCopy(tool, spec, args, sc, mepCopy(D.floors[0]?.board?.meter?.at));
  // a first pass for the wires: the room names keep off them and off the devices
  const wires = engine(tool, () => electricalPlan(D, k, { mode: args.mode, offset: base.offset, scale: sc, lang: lg, hard: [], limit: null, legendAt: null, circuitsAt: null }));
  const names = roomNames(spec, F.polys, [...pointBoxes(pts, 2.2 * sc), ...drawnBoxes(wires.entities.filter((e) => e.type !== 'text'), base.offset, sc)], base.offset, sc, base.ents);
  const hard = [...textBoxes(base.ents), ...names.boxes, ...wallBoxes(F.polys, base.offset), ...stairBoxes(spec, base.offset),
    ...pointBoxes(pts.map((p) => [p[0] + base.offset[0], p[1] + base.offset[1]]), 1.2 * sc)];
  const lp = engine(tool, () => electricalPlan(D, k, {
    mode: args.mode, offset: base.offset, scale: sc, lang: lg, hard, limit: planLimit(base, sc),
    legendAt: args.legend ? [base.bounds.max[0] + 15 * sc, base.bounds.max[1]] : null,
    circuitsAt: args.circuits === false ? null : [base.bounds.min[0], base.bounds.min[1] - 28 * sc],
  }));
  const extra = [...lp.entities, ...names.entities];
  if (args.notes !== false) {
    const lines = Array.isArray(args.notes) ? args.notes : electricalNotes(args.mode, lg);
    extra.push(...notesBlock(lines, [base.bounds.max[0] + 15 * sc, lp.legendBottom != null ? lp.legendBottom - 6 * sc : base.bounds.max[1]], sc, lg));
  }
  const TITLE = { lighting: lg === 'en' ? 'LIGHTING PLAN' : 'MẶT BẰNG BỐ TRÍ ĐIỆN CHIẾU SÁNG', power: lg === 'en' ? 'POWER PLAN' : 'MẶT BẰNG BỐ TRÍ Ổ CẮM, ĐIỀU HÒA' };
  sheetTitle(base, args.title ?? `${TITLE[args.mode]}${floorLabel}`, sc, extra);
  // a name or a circuit mark that a wire crosses stands on a mask: the wire breaks at it
  const res = await drawPlanCopy(base, maskTexts(extra), sc, lg);
  return text({ offset: base.offset, ...summary, assumed: assumedOrNone(D.assumed), warnings: D.warnings.length ? D.warnings : undefined, count: res.count, bounds: res.bounds });
}));


server.registerTool('draw_electrical_diagram', {
  description:
    'Diagrams of the electrical set from the design of draw_electrical_plan (same plan, items and options). kind ' +
    'single_line (sơ đồ nguyên lý cấp điện): the main board TĐ-T (MDB in English) from the meter (cable, main breaker, earth) with a drop per ' +
    'floor board and its schedule, then each floor board (incoming breaker, busbar, a drop per circuit) with its schedule: ' +
    'circuit, load, breaker, cable Cu/PVC, P, Ks, Itt, length, voltage drop. kind riser (sơ đồ trục đứng cấp điện): the ' +
    'floors and levels, the meter, the main and floor boards with their feeders, the data cabinet, the earthing; with the ' +
    'earthing detail (chi tiết tiếp địa: 3 rods D16 L=2.4 m in a trench, bare copper 25 mm², test box, R ≤ 4 Ω).',
  inputSchema: {
    kind: z.enum(['single_line', 'riser']).default('single_line'), scale: z.number().positive().default(50), at: opt(Point),
    plan: opt(Obj), language: opt(Lang), options: MepOptions, spacing: z.number().positive().default(1200),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'draw_electrical_diagram';
  const D = await electricalModel(args, tool);
  const sc = args.scale;
  const { at, info } = await freeSpot(args.at, sc);
  const r = engine(tool, () => (args.kind === 'riser' ? riserDiagram(D, { scale: sc, lang: langOf(args) }) : singleLineDiagram(D, { scale: sc, lang: langOf(args) })));
  const res = await drawView(placeAt(r.entities, at), sc, info, args.language);
  return text({
    kind: args.kind, main: { breaker: D.main.breaker, cable: D.main.cable, Ptt: D.main.Ptt, I: D.main.I },
    boards: D.boards.map((b) => ({ id: b.id, floors: b.floors, breaker: b.breaker, cable: b.cable, Ptt: b.Ptt, I: b.I, circuits: b.circuits.length })),
    warnings: D.warnings.length ? D.warnings : undefined, count: res.count, bounds: res.bounds,
  });
}));

server.registerTool('electrical_calc', {
  description:
    'Electrical calculation and bill of quantities (bảng tính phụ tải, khối lượng vật tư điện) of the design of ' +
    'draw_electrical_plan: per circuit and board P, Ks, Ptt, Itt, the breaker (In ≥ Itt), the cable Cu/PVC (Iz ≥ In), length ' +
    'and voltage drop; the main board with Kđt; the bill (lights, switches, sockets, air conditioners, boards and breakers, ' +
    'cables by size from the circuit lengths, conduit, data cables, earthing). draw: a sheet with both tables, the design ' +
    'basis and the sign-off for the electrical engineer (who checks, recalculates and signs it). xlsx_path: live workbook ' +
    '(inputs in yellow; currents, breakers, cables, voltage drops and cable quantities as formulas). csv_path: the tables.',
  inputSchema: {
    draw: z.boolean().default(true), scale: z.number().positive().default(50), at: opt(Point), csv_path: opt(Str),
    csv_format: z.enum(['comma', 'semicolon']).default('semicolon'), xlsx_path: opt(Str), plan: opt(Obj), language: opt(Lang),
    options: MepOptions, spacing: z.number().positive().default(1200), dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'electrical_calc';
  const D = await electricalModel(args, tool);
  const lg = langOf(args), en = lg === 'en';
  const Q = electricalQuantities(D, { lang: lg });
  const tables = electricalTables(D, Q, lg);
  const out = {
    main: { breaker: D.main.breaker, cable: D.main.cable, Ptt: D.main.Ptt, I: D.main.I },
    boards: D.boards.map((b) => ({ id: b.id, breaker: b.breaker, cable: b.cable, P: b.P, Ptt: b.Ptt, I: b.I })),
    quantities: Q.rows.filter((r) => !r.head).map((r) => `${r.stt}. ${r.item}: ${r.q} ${r.unit}`),
    assumed: assumedOrNone(D.assumed), warnings: D.warnings.length ? D.warnings : undefined,
  };
  if (args.dry_run) return dryRun(D.assumed, out);
  const head = en ? 'PRELIMINARY ELECTRICAL CALCULATION - to be checked, recalculated and signed by a licensed electrical engineer'
    : 'BẢNG TÍNH ĐIỆN SƠ BỘ - kỹ sư điện có chứng chỉ hành nghề phải kiểm tra, tính lại và ký xác nhận';
  const sign = signOff(en ? 'Electrical lead' : 'Chủ trì thiết kế điện', lg);
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, tablesCsv(head, [...tables, sign], args.csv_format === 'comma' ? ',' : ';'), 'utf8');
    out.csv = file;
  }
  if (args.xlsx_path) {
    const file = path.resolve(args.xlsx_path.endsWith('.xlsx') ? args.xlsx_path : `${args.xlsx_path}.xlsx`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, electricalWorkbook(D, Q, lg));
    out.xlsx = file;
  }
  if (args.draw) {
    const sc = args.scale;
    const { at, info } = await freeSpot(args.at, sc);
    const sheet = calcSheetOf({
      title: en ? 'PRELIMINARY ELECTRICAL CALCULATION' : 'BẢNG TÍNH ĐIỆN SƠ BỘ',
      warning: en ? 'Prepared by software for the drawings: a licensed electrical engineer must check it, calculate it again and sign it before construction.'
        : 'Bảng tính do phần mềm lập để thể hiện bản vẽ: kỹ sư điện có chứng chỉ hành nghề phải kiểm tra, tính toán lại và ký xác nhận trước khi thi công.',
      left: [tables[0]], right: [tables[1], sign], notes: electricalBasis(D, lg), scale: sc, lang: lg, layer: ROLE.elec_text,
    });
    const res = await drawView(placeAt(sheet.entities, at), sc, info, args.language);
    out.count = res.count;
    out.bounds = res.bounds;
  }
  return text(out);
}));

server.registerTool('draw_plumbing_plan', {
  description:
    'Plumbing plan of one floor (mặt bằng cấp thoát nước) for the plumbing set (its own file), from the plan of draw_plan. ' +
    'mode supply (mặt bằng cấp nước): the shaft in the WC corner with the down riser from the roof tank and the pump riser ' +
    'up, one cold water branch per floor (PPR trunk with tees and stubs to the toilet, basin, shower, kitchen sink, washer; ' +
    'the water heater of each WC over the shower mixer), hot water from it to the basin (dashed), a stop valve where the ' +
    'branch leaves the shaft, supply points; the ground floor adds the meter, the ' +
    'pump and their pipes; the top floor the tank on the stair tower roof and its pipes along the terrace. mode drainage ' +
    '(mặt bằng thoát nước): soil D110 from the toilets, waste D60 from basins, sinks and floor drains to the stacks (TX ' +
    'D110, TR D90) with slopes, rainwater downpipes D90 of the roof and balcony drains; the ground floor adds the septic ' +
    'tank (3 compartments, under the slab), the manholes HG1, HG2 and the drain to the street sewer. Fixtures from ' +
    'draw_furniture_plan (or items), else defaults (toilet and shower opposite the WC door, basin on the side wall, kitchen ' +
    'run with the sink, washer in the yard). focus: a room name, the result gives its window for an enlarged plan (e.g. ' +
    'the WC at scale 25). Defaults (people, norms, tank, pipes, slopes, septic tank) are listed in assumed; options: ' +
    '{people, q_day, tank, pump_kw, heater_l, pipes, slopes, shaft, a, K, v_max, head_min, head_comfort, septic_min, rain_q5, rain_k, rain_pipe}.',
  inputSchema: {
    floor: FloorArg, mode: z.enum(['supply', 'drainage']).default('supply'), scale: z.number().positive().default(100),
    offset: opt(Point), legend: z.boolean().default(true), notes: NotesArg, title: opt(Str), plan: opt(Obj), language: opt(Lang),
    items: ItemsArg, options: MepOptions, focus: opt(Str).describe('Room name: return its window for an enlarged plan'),
    dry_run: z.boolean().default(false).describe('List the design (shaft, fixtures, pipes, tank, septic tank) and what it assumes, without drawing'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'draw_plumbing_plan';
  const { spec, key, label: floorLabel } = floorFor(args, tool);
  const D = await plumbingModel(args, tool);
  const k = floorIndex(D, key);
  const F = D.floors[k];
  const summary = {
    floor: F.name, fixtures: F.fixtures.map((x) => `${x.kind} (${x.room})`), drains: F.drains.length, downpipes: F.downpipes.length,
    shaft: D.shafts[0]?.poly, calc: { N: D.calc.N, q: D.calc.q, riser: `D${D.calc.riser}`, tank: D.calc.tank, head: D.calc.head, septic: D.calc.septic.V },
  };
  if (args.dry_run) return dryRun(D.assumed, { ...summary, warnings: D.warnings.length ? D.warnings : undefined });
  const sc = args.scale, lg = langOf(args);
  const base = await planCopy(tool, spec, args, sc, mepCopy(D.equipment?.meter ?? D.equipment?.hg2));
  // the fixtures themselves (furniture library), then the pipes
  const fixtureTypes = ['toilet', 'vanity', 'shower', 'bathtub', 'kitchen_base', 'washer'];
  const fixtureItems = (F.items || []).filter((it) => fixtureTypes.includes(it.type));
  const extra = furniturePlan(fixtureItems, { offset: base.offset, scale: sc, tags: false });
  // the room names clear of the fixtures, the drains, the shaft, what stands on this floor and the pipes (a first pass)
  const E = D.equipment;
  const pipes = engine(tool, () => plumbingPlan(D, k, { mode: args.mode, offset: base.offset, scale: sc, lang: lg, hard: [], limit: null, legendAt: null }));
  const names = roomNames(spec, F.polys, [
    ...drawnBoxes(pipes.entities.filter((e) => e.type !== 'text'), base.offset, sc),
    ...footprints(fixtureItems), ...pointBoxes(F.drains.map((d) => d.at), 1.5 * sc),
    ...D.shafts.map((g) => [Math.min(...g.poly.map((q) => q[0])), Math.min(...g.poly.map((q) => q[1])), Math.max(...g.poly.map((q) => q[0])), Math.max(...g.poly.map((q) => q[1]))]),
    ...(F.ground ? pointBoxes([E.hg1, E.hg2, ...(E.pump ? [E.pump] : [])], 350) : []),
  ], base.offset, sc, base.ents);
  // an enlarged plan of one room: its window (the room and a margin for its labels and title)
  let focusWindow = null, focusTitle = null;
  if (args.focus) {
    const poly = F.polys?.[args.focus];
    if (!poly) throw new Error(`${tool}: focus: room "${args.focus}" not on ${F.name}`);
    const xs = poly.map((p) => p[0] + base.offset[0]), ys = poly.map((p) => p[1] + base.offset[1]);
    const m = 800;
    focusTitle = [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys) + 1500 + 5 * sc];
    focusWindow = [[Math.min(...xs) - m, Math.min(...ys) - m], [Math.max(...xs) + m, focusTitle[1] + 6 * sc]];
  }
  const pp = engine(tool, () => plumbingPlan(D, k, {
    mode: args.mode, offset: base.offset, scale: sc, lang: lg,
    // the labels stay on the plan (inside the window of an enlarged plan, under its title)
    limit: focusWindow ? [focusWindow[0][0], focusWindow[0][1], focusWindow[1][0], focusTitle[1] - 4 * sc] : planLimit(base, sc),
    // the pipe names keep off the plan texts, the room names, the walls and the fixtures
    hard: [...textBoxes(base.ents), ...names.boxes, ...wallBoxes(F.polys, base.offset), ...stairBoxes(spec, base.offset), ...footprints(fixtureItems, base.offset)],
    legendAt: args.legend ? [base.bounds.max[0] + 15 * sc, base.bounds.max[1]] : null,
  }));
  extra.push(...pp.entities, ...names.entities);
  if (args.notes !== false) {
    const lines = Array.isArray(args.notes) ? args.notes : plumbingNotes(args.mode, lg);
    extra.push(...notesBlock(lines, [base.bounds.max[0] + 15 * sc, pp.legendBottom != null ? pp.legendBottom - 6 * sc : base.bounds.max[1]], sc, lg));
  }
  const TITLE = { supply: lg === 'en' ? 'WATER SUPPLY PLAN' : 'MẶT BẰNG CẤP NƯỚC', drainage: lg === 'en' ? 'DRAINAGE PLAN' : 'MẶT BẰNG THOÁT NƯỚC' };
  const titleText = args.title ?? `${TITLE[args.mode]}${floorLabel}`;
  // an enlarged plan of one room: its title above the room, in the window the result gives for the sheet
  if (focusWindow) extra.push(...viewTitle(titleText, focusTitle[0], focusTitle[1], sc, ROLE.text, lg));
  else sheetTitle(base, titleText, sc, extra);
  // a name or a code that a pipe crosses stands on a mask: the pipe breaks at it
  const res = await drawPlanCopy(base, maskTexts(extra), sc, lg);
  const out = { offset: base.offset, ...summary, assumed: assumedOrNone(D.assumed), warnings: D.warnings.length ? D.warnings : undefined, count: res.count, bounds: res.bounds };
  if (focusWindow) out.focus_window = focusWindow;
  return text(out);
}));

server.registerTool('draw_plumbing_diagram', {
  description:
    'Diagrams and details of the plumbing set from the design of draw_plumbing_plan. kind risers: the supply riser diagram ' +
    '(sơ đồ nguyên lý cấp nước: meter, pump, the roof tank, the down riser and the branch of each floor to its fixtures) and ' +
    'the drainage riser diagram (sơ đồ nguyên lý thoát nước: soil and waste stacks with their vents, the floor branches, ' +
    'the septic tank, manholes HG1, HG2 and the street sewer, rain downpipes) side by side. kind septic: the 3-compartment ' +
    'septic tank (plan and section with its volume, walls, baffles, tees, vent and covers, dimensioned, with notes) and the ' +
    'manhole (plan and section), at 1:25 by default.',
  inputSchema: {
    kind: z.enum(['risers', 'septic']).default('risers'), scale: opt(z.number().positive()), at: opt(Point), plan: opt(Obj),
    language: opt(Lang), options: MepOptions,
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'draw_plumbing_diagram';
  const D = await plumbingModel(args, tool);
  const sc = args.scale ?? (args.kind === 'septic' ? 25 : 50);
  const { at, info } = await freeSpot(args.at, sc);
  const r = engine(tool, () => (args.kind === 'septic' ? septicDetail(D, { scale: sc, lang: langOf(args) }) : plumbingRisers(D, { scale: sc, lang: langOf(args) })));
  const res = await drawView(placeAt(r.entities, at), sc, info, args.language);
  return text({ kind: args.kind, scale: sc, septic: D.calc.septic.V, warnings: D.warnings.length ? D.warnings : undefined, count: res.count, bounds: res.bounds });
}));

server.registerTool('plumbing_calc', {
  description:
    'Plumbing calculation and bill of quantities (bảng tính cấp thoát nước, khối lượng vật tư) of the design of ' +
    'draw_plumbing_plan: people and daily demand, fixture equivalents N, the design flow of a dwelling q = 0.2 N^(1/a) + ' +
    'K N (TCVN 4513:1988), the riser size for the velocity limit, the roof tank, the head at the highest shower against ' +
    'the 3 m minimum (booster pump advised under 8 m), the drainage flow (TCVN 4474:1987), rainwater per downpipe Q = K F ' +
    'q5 / 10000 with K = 2, the septic tank volume W = Wn + Wc; the bill of ' +
    'pipes by system and diameter (plan runs, risers, drops, allowance), fittings, fixtures, equipment, septic tank and ' +
    'manholes. draw: a sheet with both tables and the sign-off for the plumbing engineer. xlsx_path: live workbook (inputs ' +
    'in yellow, everything else formulas). csv_path: the tables.',
  inputSchema: {
    draw: z.boolean().default(true), scale: z.number().positive().default(50), at: opt(Point), csv_path: opt(Str),
    csv_format: z.enum(['comma', 'semicolon']).default('semicolon'), xlsx_path: opt(Str), plan: opt(Obj), language: opt(Lang),
    options: MepOptions, dry_run: z.boolean().default(false),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const tool = 'plumbing_calc';
  const D = await plumbingModel(args, tool);
  const lg = langOf(args), en = lg === 'en';
  const Q = plumbingQuantities(D, { lang: lg });
  const tables = plumbingTables(D, Q, lg);
  const out = {
    calc: { people: D.calc.people, N: D.calc.N, q: D.calc.q, riser: `D${D.calc.riser}`, daily_m3: D.calc.daily, tank_l: D.calc.tank, head_m: D.calc.head, rain_q: D.calc.rainQ, septic_m3: D.calc.septic.V },
    quantities: Q.rows.filter((r) => !r.head).map((r) => `${r.stt}. ${r.item}: ${r.q} ${r.unit}`),
    assumed: assumedOrNone(D.assumed), warnings: D.warnings.length ? D.warnings : undefined,
  };
  if (args.dry_run) return dryRun(D.assumed, out);
  const head = en ? 'PRELIMINARY PLUMBING CALCULATION - to be checked, recalculated and signed by a licensed plumbing engineer'
    : 'BẢNG TÍNH CẤP THOÁT NƯỚC SƠ BỘ - kỹ sư cấp thoát nước có chứng chỉ hành nghề phải kiểm tra, tính lại và ký xác nhận';
  const sign = signOff(en ? 'Plumbing lead' : 'Chủ trì thiết kế cấp thoát nước', lg);
  if (args.csv_path) {
    const file = path.resolve(args.csv_path.endsWith('.csv') ? args.csv_path : `${args.csv_path}.csv`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, tablesCsv(head, [...tables, sign], args.csv_format === 'comma' ? ',' : ';'), 'utf8');
    out.csv = file;
  }
  if (args.xlsx_path) {
    const file = path.resolve(args.xlsx_path.endsWith('.xlsx') ? args.xlsx_path : `${args.xlsx_path}.xlsx`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, plumbingWorkbook(D, Q, lg));
    out.xlsx = file;
  }
  if (args.draw) {
    const sc = args.scale;
    const { at, info } = await freeSpot(args.at, sc);
    const sheet = calcSheetOf({
      title: en ? 'PRELIMINARY PLUMBING CALCULATION' : 'BẢNG TÍNH CẤP THOÁT NƯỚC SƠ BỘ',
      warning: en ? 'Prepared by software for the drawings: a licensed plumbing engineer must check it, calculate it again and sign it before construction.'
        : 'Bảng tính do phần mềm lập để thể hiện bản vẽ: kỹ sư cấp thoát nước có chứng chỉ hành nghề phải kiểm tra, tính toán lại và ký xác nhận trước khi thi công.',
      left: [tables[0]], right: [tables[1], sign], notes: plumbingBasis(D, lg), scale: sc, lang: lg, layer: ROLE.plumb_text,
    });
    const res = await drawView(placeAt(sheet.entities, at), sc, info, args.language);
    out.count = res.count;
    out.bounds = res.bounds;
  }
  return text(out);
}));

const MEP_NOTES = {
  electrical: {
    vi: [
      'Tiêu chuẩn áp dụng: QCVN 12:2014/BXD Hệ thống điện của nhà ở và nhà công cộng; TCVN 9206:2012, TCVN 9207:2012; TCVN 7447 (IEC 60364); TCVN 9385:2012 (chống sét, tiếp địa).',
      'Nguồn điện 1 pha 220V từ lưới điện lực qua công tơ; tủ điện tổng TĐ-T đặt tại tầng 1, mỗi tầng một tủ điện tầng cạnh cầu thang.',
      'Dây dẫn Cu/PVC đi trong ống nhựa PVC cứng, âm tường, âm sàn, âm trần; tiết diện, thiết bị bảo vệ theo sơ đồ nguyên lý.',
      'Mạch ổ cắm và thiết bị khu ẩm ướt bảo vệ bằng RCBO 30mA; mỗi điều hòa, bình nóng lạnh, bếp, bơm một mạch riêng.',
      'Màu dây: pha đỏ hoặc nâu, trung tính xanh dương hoặc đen, tiếp địa vàng xanh; mọi ổ cắm 3 chấu có dây tiếp địa.',
      'Hệ thống tiếp địa an toàn R ≤ 4Ω, nối về thanh tiếp địa của tủ điện tổng; đo kiểm tra trước khi nghiệm thu.',
      'Chủng loại đèn, công tắc, ổ cắm theo mẫu chủ đầu tư duyệt; vị trí theo mặt bằng, cao độ theo bảng ký hiệu.',
      'Phối hợp bản vẽ kiến trúc, nội thất, kết cấu trước khi đục tường, chôn ống; không cắt cốt thép kết cấu.',
      'Sau khi thi công đo điện trở cách điện, thử tải, kiểm tra RCBO và lập bản vẽ hoàn công.',
    ],
    en: [
      'Standards: QCVN 12:2014/BXD; TCVN 9206:2012, TCVN 9207:2012; TCVN 7447 (IEC 60364); TCVN 9385:2012 (earthing).',
      'Single-phase 220 V supply through the utility meter; main board MDB on the ground floor, a board on each floor by the stair.',
      'Cu/PVC cables in rigid PVC conduit concealed in walls, floors and ceilings; sizes and breakers per the single-line diagram.',
      'Socket circuits and wet areas on 30 mA RCBOs; each air conditioner, water heater, hob and pump on its own circuit.',
      'Cable colours: line red or brown, neutral blue or black, earth green-yellow; every socket earthed.',
      'Protective earthing R ≤ 4 Ω to the earth bar of the main board, measured before handover.',
      'Lights, switches and sockets as approved by the client; positions per the plans, heights per the legend.',
      'Coordinate with the architectural, interior and structural drawings before chasing; never cut structural bars.',
      'After installation: insulation test, load test, RCBO test and as-built drawings.',
    ],
  },
  plumbing: {
    vi: [
      'Tiêu chuẩn áp dụng: TCVN 4513:1988 Cấp nước bên trong; TCVN 4474:1987 Thoát nước bên trong.',
      'Nguồn nước: mạng cấp nước thành phố qua đồng hồ, máy bơm đẩy lên bồn trên mái tum, cấp xuống các tầng tự chảy.',
      'Ống cấp nước PPR (nước lạnh PN10, nước nóng PN20) hàn nhiệt; ống thoát uPVC nối keo; ống qua sàn, tường có ống lồng và chống thấm cổ ống.',
      'Thoát nước 3 hệ riêng: xí vào bể tự hoại 3 ngăn; nước rửa, nước mưa và nước sau bể tự hoại vào hố ga rồi ra cống chung.',
      'Độ dốc ống nằm ngang: D60 i=3%, D90-D110 i=2%; ống đứng có lỗ thông tắc ở chân, ống thông hơi cao hơn mái 0,7m (3,0m trên sân thượng có sử dụng).',
      'Thử áp lực ống cấp 1,5 lần áp lực làm việc, không nhỏ hơn 6 bar trong 30 phút; thử kín ống thoát bằng nước trước khi lấp.',
      'Thiết bị vệ sinh theo mẫu chủ đầu tư duyệt, lắp theo hướng dẫn nhà sản xuất; điểm chờ theo cao độ thiết bị.',
      'Súc rửa đường ống, vệ sinh bồn nước trước khi đưa vào sử dụng; lập bản vẽ hoàn công.',
    ],
    en: [
      'Standards: TCVN 4513:1988 internal water supply; TCVN 4474:1987 internal drainage.',
      'City water through the meter; the pump fills the tank on the stair tower roof, which feeds the floors by gravity.',
      'Supply PPR (cold PN10, hot PN20) heat-fused; drainage uPVC solvent welded; sleeves and waterproofing where pipes pass slabs and walls.',
      'Three drainage systems: soil to the 3-compartment septic tank; waste, rainwater and the tank outflow to the manholes and the sewer.',
      'Horizontal slopes D60 3%, D90-D110 2%; cleanouts at the foot of the stacks, vents 0.7 m above the roof (3.0 m above a roof terrace in use).',
      'Supply pressure test 1.5 times the working pressure, at least 6 bar for 30 minutes; drains water-tested before backfilling.',
      'Sanitary ware as approved by the client, installed to the maker\'s instructions; supply points at the fixture heights.',
      'Flush the pipes and clean the tank before use; as-built drawings.',
    ],
  },
};

server.registerTool('draw_mep_notes', {
  description:
    'General notes and legend sheet of the electrical or plumbing set (ghi chú chung, bảng ký hiệu, chữ viết tắt): the ' +
    'standards, supply, materials, installation and tests as numbered notes, every symbol of the set with its description ' +
    'and mounting height, and the abbreviations (TĐ, L, S, ĐH, NL, BT, BN, MCB, RCBO / TX, TR, TM, HG, PPR, uPVC; in English DB, MDB, AC, ' +
    'WH, CK, PU / CW, HW, SP, WP, RWP, VP, SH, ST, MH, WM). For the ' +
    'first sheet after the drawing list (Đ-01, N-01). notes replaces the general notes.',
  inputSchema: { system: z.enum(['electrical', 'plumbing']), scale: z.number().positive().default(50), at: opt(Point), notes: opt(z.array(Str)), language: opt(Lang) },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const sc = args.scale, lg = langOf(args), en = lg === 'en';
  const elec = args.system === 'electrical';
  const layer = elec ? ROLE.elec_text : ROLE.plumb_text;
  const { at, info } = await freeSpot(args.at, sc);
  const out = [];
  const lines = args.notes ?? MEP_NOTES[args.system][en ? 'en' : 'vi'];
  out.push({ type: 'text', text: en ? (elec ? 'ELECTRICAL GENERAL NOTES' : 'PLUMBING GENERAL NOTES') : (elec ? 'GHI CHÚ CHUNG HỆ THỐNG ĐIỆN' : 'GHI CHÚ CHUNG HỆ THỐNG CẤP THOÁT NƯỚC'), at: [0, 0], height: 5 * sc, layer, style: TEXT_STYLE });
  out.push({ type: 'mtext', text: lines.map((l, i) => `${i + 1}. ${l}`).join('\n'), at: [0, -10 * sc], height: 2.5 * sc, width: 170 * sc, layer, style: TEXT_STYLE, line_spacing: 1.2 });
  let rows;
  if (elec) {
    rows = Object.entries(DEVICES).map(([kd, d]) => (kd === 'strip' ? { line: ROLE.light_strip, extra: { scale_linetype: true }, text: en ? d.en : d.vi }
      : { block: kd === 'switch' ? 'MCP_E_CT_2' : d.block, real: d.real, layer: ROLE[d.layer], text: en ? d.en : d.vi }));
    rows.push({ line: ROLE.light_wire, text: en ? 'Lighting wiring' : 'Dây dẫn chiếu sáng' }, { line: ROLE.power_wire, text: en ? 'Power wiring' : 'Dây dẫn ổ cắm, động lực' },
      { line: ROLE.comm, extra: { scale_linetype: true }, text: en ? 'Data / TV cable' : 'Cáp mạng, truyền hình' }, { block: 'MCP_E_LEN', layer, text: en ? 'Riser (up / down a floor)' : 'Đường dây lên / xuống tầng' },
      { block: 'MCP_E_TIEP_DIA', layer: ROLE.earth, text: en ? 'Earth' : 'Tiếp địa' });
  } else {
    rows = [
      { line: ROLE.cold_water, text: en ? 'Cold water PPR (CL)' : 'Ống cấp nước lạnh PPR (CL)' }, { line: ROLE.hot_water, extra: { scale_linetype: true }, text: en ? 'Hot water PPR (CN)' : 'Ống cấp nước nóng PPR (CN)' },
      { line: ROLE.soil, text: en ? 'Soil uPVC (TX)' : 'Ống thoát xí uPVC (TX)' }, { line: ROLE.waste, extra: { scale_linetype: true }, text: en ? 'Waste uPVC (TR)' : 'Ống thoát nước rửa uPVC (TR)' },
      { line: ROLE.rain, extra: { scale_linetype: true }, text: en ? 'Rainwater uPVC (TM)' : 'Ống thoát nước mưa uPVC (TM)' }, { line: ROLE.vent, extra: { scale_linetype: true }, text: en ? 'Vent uPVC (TH)' : 'Ống thông hơi uPVC (TH)' },
      { block: 'MCP_P_VAN', layer: ROLE.cold_water, text: en ? 'Gate valve' : 'Van khóa' }, { block: 'MCP_P_DIEM', layer: ROLE.cold_water, text: en ? 'Supply point of a fixture' : 'Điểm cấp nước thiết bị' },
      { block: 'MCP_P_DHN', layer: ROLE.plumb_equipment, text: en ? 'Water meter' : 'Đồng hồ nước' }, { block: 'MCP_E_BOM', layer: ROLE.plumb_equipment, text: en ? 'Pump' : 'Máy bơm' },
      { block: 'MCP_E_NL', layer: ROLE.plumb_equipment, text: en ? 'Water heater' : 'Bình nóng lạnh' }, { block: 'MCP_PHEU_THU', real: true, layer: ROLE.waste, text: en ? 'Floor / roof drain' : 'Phễu thu sàn, phễu thu mái' },
      { draw: (p) => [{ type: 'circle', center: p, radius: 1.5 * sc, layer: ROLE.soil }], text: en ? 'Stack (soil, waste, rainwater)' : 'Ống đứng (thoát xí, thoát rửa, thoát mưa)' },
      { block: 'MCP_P_TT', layer: ROLE.waste, text: en ? 'Cleanout' : 'Lỗ thông tắc' },
      ...Object.values(FIXTURES).map((x) => ({ text: `${en ? x.en : x.vi}${x.N ? `: N = ${String(x.N).replace('.', en ? '.' : ',')}` : ''}` })),
    ];
  }
  const lgd = mepLegend(en ? 'LEGEND' : 'BẢNG KÝ HIỆU', rows, [190 * sc, 0], sc, layer, layer);
  out.push(...lgd.entities);
  const abbr = elec
    ? (en ? 'MDB main distribution board; DB-n floor distribution board; L lighting; S sockets; AC air conditioner; WH water heater; CK cooker (hob); PU pump; Pd design load; Id design current; Kd diversity factor; MCB miniature circuit breaker; RCBO residual current breaker with overcurrent; Cu/PVC copper PVC cable.'
      : 'TĐ-T tủ điện tổng; TĐ-n tủ điện tầng; L chiếu sáng; S ổ cắm; ĐH điều hòa; NL bình nóng lạnh; BT bếp từ; BN bơm nước; MCB aptomat; RCBO aptomat chống dòng rò; Cu/PVC dây đồng cách điện PVC.')
    : (en ? 'CW cold water; HW hot water; SP soil pipe; WP waste pipe; RWP rainwater pipe; VP vent pipe; SH shaft with the stacks and risers; ST septic tank; MH manhole; WM water meter; PU pump; PPR polypropylene pipe; uPVC rigid PVC pipe; D outside diameter; i slope.'
      : 'CL cấp lạnh; CN cấp nóng; TX thoát xí; TR thoát rửa; TM thoát mưa; TH thông hơi; OĐ hộp gen ống đứng; BTH bể tự hoại; HG hố ga; ĐHN đồng hồ nước; MB máy bơm; PPR ống nhựa PP-R; uPVC ống nhựa PVC cứng; D đường kính ngoài; i độ dốc.');
  out.push({ type: 'text', text: en ? 'ABBREVIATIONS' : 'CHỮ VIẾT TẮT', at: [0, -110 * sc], height: 3 * sc, layer, style: TEXT_STYLE });
  out.push({ type: 'mtext', text: abbr, at: [0, -116 * sc], height: 2.5 * sc, width: 170 * sc, layer, style: TEXT_STYLE });
  const res = await drawView(placeAt(out, at), sc, info, args.language);
  return text({ count: res.count, bounds: res.bounds });
}));

// ---------------------------------------------------------------- install the bridge into AutoCAD
const BUNDLE = 'AcadMcpBridge.bundle';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function bundleSource() {
  for (const dir of [path.join(HERE, '..', 'bridge', BUNDLE), path.join(HERE, '..', '..', 'bridge', 'dist', BUNDLE)]) {
    if (await exists(path.join(dir, 'PackageContents.xml'))) return dir;
  }
  throw new Error(`Bridge bundle (${BUNDLE}) not found in the extension package.`);
}

function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Installed AutoCAD releases from the registry: [{release: "R24.3", year: 2024}]. */
async function installedAutoCAD() {
  const out = await regQuery('HKLM\\SOFTWARE\\Autodesk\\AutoCAD');
  const rel = [...out.matchAll(/\\(R\d+\.\d+)\s*$/gm)].map((m) => m[1]);
  const year = (r) => {
    const [maj, min] = r.slice(1).split('.').map(Number);
    return maj === 24 ? 2021 + min : maj === 25 ? 2025 + min : maj === 26 ? 2027 + min : null;
  };
  return rel.map((r) => ({ release: r, year: year(r), supported: /^R24\./.test(r) }));
}

server.registerTool('install_autocad_bridge', {
  description:
    'Install (or update) the "ACAD MCP Bridge" add-in so the other tools can connect: copies AcadMcpBridge.bundle into ' +
    '%APPDATA%/Autodesk/ApplicationPlugins, which AutoCAD 2021-2024 loads at startup (restart AutoCAD afterwards; the first ' +
    'time AutoCAD may ask to load an unsigned file: choose "Always load"). dry_run=true only reports.',
  inputSchema: { dry_run: z.boolean().default(false) },
  annotations: { ...EDIT_IDEMPOTENT, title: 'Install ACAD MCP Bridge' },
}, async ({ dry_run }) => {
  if (process.platform !== 'win32') throw new Error('AutoCAD with this bridge runs on Windows only.');
  const src = await bundleSource();
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dest = path.join(appData, 'Autodesk', 'ApplicationPlugins', BUNDLE);
  const files = [];
  async function walk(dir, rel = '') {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else files.push(r);
    }
  }
  await walk(src);
  // PackageContents.xml last: AutoCAD never sees a manifest pointing to a DLL that is not there yet.
  files.sort((a, b) => (a.endsWith('PackageContents.xml') ? 1 : 0) - (b.endsWith('PackageContents.xml') ? 1 : 0));
  let changed = 0;
  const errors = [];
  for (const rel of files) {
    const want = await fs.readFile(path.join(src, rel));
    const target = path.join(dest, rel);
    const have = await fs.readFile(target).catch(() => null);
    if (have && have.equals(want)) continue;
    changed++;
    if (dry_run) continue;
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, want);
    } catch (e) {
      errors.push(`${rel}: ${e.code || e.name} ${e.message}`);
    }
  }
  // Older versioned DLLs: remove when AutoCAD is not holding them (it keeps the loaded one open until it closes).
  const removed = [];
  if (!dry_run) {
    const keep = new Set(files.map((f) => path.basename(f).toLowerCase()));
    const dllDir = path.join(dest, 'Contents', 'Win64');
    for (const f of await fs.readdir(dllDir).catch(() => [])) {
      if (/^AcadMcpBridge.*\.dll$/i.test(f) && !keep.has(f.toLowerCase())) {
        try {
          await fs.rm(path.join(dllDir, f));
          removed.push(f);
        } catch { /* in use: removed on a later install */ }
      }
    }
  }
  const acad = await installedAutoCAD();
  const unsupported = acad.filter((a) => !a.supported);
  let note;
  if (errors.length) note = 'Some files could not be written (see errors). Close AutoCAD and run the tool again.';
  else if (dry_run) note = changed ? `Dry run: ${changed} file(s) would be copied to ${dest}.` : 'Already up to date.';
  else if (changed) note = 'Bridge installed. Fully quit and reopen AutoCAD (choose "Always load" if AutoCAD asks about the unsigned file), then type MCPSTATUS.';
  else note = 'Already up to date. If the tools still cannot connect, type MCPSTATUS (or MCPSTART) in AutoCAD.';
  if (unsupported.length) {
    note += ` AutoCAD ${unsupported.map((a) => a.year || a.release).join(', ')} (.NET 8) is not supported by this build of the bridge.`;
  }
  return text({ dry_run, bundle: dest, changed_files: changed, removed_old: removed, errors, autocad_found: acad, note });
});

// ---------------------------------------------------------------- startup
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready, AutoCAD bridge at ${HOST}:${PORT} (timeout ${TIMEOUT}s)`);
}

main().catch((e) => {
  log(`Startup error: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
