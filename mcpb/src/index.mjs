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
import { buildBuilding, buildElevation, buildingAssumed, buildSection, floorsOf } from './elevation.mjs';
import { buildPlan, planAssumptions, PlanError } from './plan.mjs';
import { dimStyleName, FIELD, fitScale, layerSpecs, layerStyles, LAYERS, PAPERS, ROLE, styleParams, TEXT_STYLE, titleBlock, viewStyles, viewTitle } from './standards.mjs';
import { beamDetail, footingDetail, rcSection, rebarSchedule } from './structure.mjs';
import { symbolDef } from './symbols.mjs';
import {
  ceilingPlan, centroid, cleanPoly, elevationKey, entBox, entityBounds, floorFinishPlan, freePoint, FURNITURE_DOC, furniturePlan, generalNotes, inside, notesBlock, wallFinishPlan,
  interiorElevation, joineryDetail, labelSize, materialSchedule, polyArea, resolveFinish, resolveItems, shiftSpec,
} from './interior.mjs';

/* global __AUTOCAD_MCP_VERSION__ */
const VERSION = typeof __AUTOCAD_MCP_VERSION__ !== 'undefined' ? __AUTOCAD_MCP_VERSION__ : '0.0.0-dev';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Commands that do not change the drawing (safe to retry after a timeout), and commands without an Undo step.
const READ_ONLY_CMDS = new Set(['ping', 'drawing_info', 'list_layers', 'list_blocks', 'query_entities', 'selection_info',
  'quantity_takeoff', 'check_drawing', 'screenshot', 'view_image', 'image_info', 'select_entities']);
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
          `Cannot connect to AutoCAD at ${HOST}:${PORT}. Open AutoCAD (full version 2021-2024) and type MCPSTATUS in its command line ` +
          '(MCPSTART starts the bridge). If the command is unknown, the bridge is not installed: run install_autocad_bridge, then restart AutoCAD.',
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
      '3. Drawing from an image or a 3D model: read every printed dimension first (view_image with grid/crop zooms in), pick the plot scale, ' +
        'setup_layers + setup_styles, attach_image as a faded underlay calibrated on a known dimension, draw_plan for walls/openings/columns/' +
        'grids/stairs/rooms/dimensions, draw_entities for the rest (furniture, fixtures, hatches, notes, elevations), then screenshot and compare ' +
        'with the source, fix, check_drawing, create_layout + export_pdf. Elevations and sections: draw_elevation / draw_section from ' +
        'the same plan (heights, roofs). Structural details: draw_structure_detail + rebar_schedule (sizes and bars from the engineer). ' +
        'Interior design: draw_furniture_plan (layout plan with coded furniture/joinery and elevation keys), draw_floor_finish_plan, ' +
        'draw_ceiling_plan, draw_interior_elevation (each wall of a room), draw_joinery_detail (kitchen, wardrobe), material_schedule; ' +
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
const Lang = z.enum(['vi', 'en']);
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
  const r = (await call('ping')) || {};
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
    '(no plot), X-IMAGE ảnh tham chiếu (no plot), X-REF. layers adds/changes custom layers: {name, color (1-255, [r,g,b], ' +
    '"#rrggbb"), linetype, lineweight (mm), plot, description, transparency %, on, frozen, locked}. Existing layers are kept as ' +
    'they are unless update_existing=true (use that to turn layers on/off, freeze or lock). current sets the current layer.',
  inputSchema: {
    standard: z.enum(['arch', 'none']).default('arch'),
    language: opt(Lang).describe('Language of the layer descriptions (default vi)'),
    layers: opt(Specs),
    update_existing: z.boolean().default(false),
    current: opt(Str),
  },
  annotations: EDIT_IDEMPOTENT,
}, async ({ standard, language: lang, layers, update_existing, current }) => {
  if (lang) language = lang;
  const list = [...(standard === 'arch' ? layerSpecs(lang ?? language) : []), ...(layers || [])];
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
  },
  annotations: EDIT_IDEMPOTENT,
}, async ({ scale, units, font, text_height, arrow }) =>
  text(await call('setup_styles', styleParams({ scale, units, font, textHeight: text_height, arrow }))));

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
  '- table {at (top-left), rows:[[...],...], title?, col_widths?, row_height?, height?}\n' +
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
  },
  annotations: EDIT,
}, ({ entities, space, image_handle, language: lang }) => exclusive(async () => {
  const specs = image_handle ? await pixelsToDrawing(image_handle, entities) : entities;
  return text(await sendNow('draw_entities', withStyles({ entities: specs, space, language: lang })));
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
  lastPlan = { ...args };
  lastFloors = null;
  if (dry_run) {
    return dryRun(plan.assumed, {
      walls: plan.walls.length, openings: (args.openings || []).length, rooms: plan.rooms.length, entities: plan.entities.length,
      notes: plan.notes.length ? plan.notes : undefined,
    });
  }
  const req = withStyles({
    walls: plan.walls, cuts: plan.cuts, columns: plan.columns, rooms: plan.rooms, room_options: plan.room_options,
    entities: plan.entities, language: args.language,
    styles: styleParams({ scale: args.scale ?? 100 }),
  });
  const r = await call('draw_plan', req);
  if (plan.notes.length) r.notes = plan.notes;
  if (plan.assumed.length) r.assumed = plan.assumed;
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
  lastPlan = { ...args };
  const widths = plans.map((p) => {
    const b = entityBounds(p.entities);
    return b ? b.max[0] - b.min[0] : 20000;
  });
  const pitch = Math.max(...widths) + 30 * scale;
  const offsets = floors.map((f, i) => [i * pitch, 0]);
  lastFloors = { offsets, names: floors.map((f) => f.name) };
  if (dryRunOnly) return dryRun(assumed, { floors: summary, notes: notes.length ? notes : undefined });
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
  const req = withStyles({
    walls: shifted.flatMap((p) => p.walls), cuts: shifted.flatMap((p) => p.cuts), columns: shifted.flatMap((p) => p.columns),
    rooms: shifted.flatMap((p) => p.rooms), room_options: shifted[0].room_options, entities, language: args.language,
    styles: styleParams({ scale }),
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
    notes: notes.length ? notes : undefined, assumed: assumedOrNone(assumed),
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
  },
  annotations: EDIT,
}, async (args) => text(await call('transform_entities', args)));

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
  },
  annotations: EDIT,
}, async (args) => text(await call('set_properties', withStyles(args))));

bridgeTool('delete_entities',
  'Delete entities by explicit handle (never by selection). One Undo step.',
  { handles: Handles.describe(HANDLES_DESC) }, DESTRUCTIVE);

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
  },
  annotations: EDIT,
}, async (args) => text(await call('attach_image', withStyles({ ...args, path: path.resolve(args.path) }))));

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
}, ({ name, paper, orientation, window, scale, title_block, language: lang, replace, activate }) => exclusive(async () => {
  const info0 = await sendNow('drawing_info', {});
  let win = window;
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
  return text({ ...r, scale: `1:${s}`, paper, orientation, ...(warnings.length ? { warnings } : {}) });
}));

bridgeTool('export_pdf',
  'Plot to PDF with DWG To PDF.pc3: layouts (names, ["all"], or default the current one) become pages of one PDF; layouts on ' +
  'different paper sizes give one PDF per size (<name>_A1.pdf, <name>_A3-portrait.pdf: see pdfs). For "Model": paper, ' +
  'orientation, window (default extents) and scale (default fit). monochrome.ctb unless plot_style is given. Plotting can take ' +
  '~30 s on machines whose default Windows printer is an unreachable network printer.',
  {
    path: Str, layouts: opt(jsonish(z.array(Str))),
    paper: z.enum(['A0', 'A1', 'A2', 'A3', 'A4']).default('A3'), orientation: z.enum(['landscape', 'portrait']).default('landscape'),
    window: opt(Window), scale: opt(z.number().positive()), plot_style: opt(Str),
  }, DESTRUCTIVE, (a) => ({ ...a, path: path.resolve(a.path) }));

bridgeTool('save_drawing',
  'Save the drawing (DWG, or DXF by extension/format). Empty path = save in place; a new path = Save As (the open drawing takes ' +
  'that name), overwrite=true to replace an existing file. version: 2018 (default), 2013, 2010, 2007, 2004, 2000. copy=true ' +
  'writes a copy and leaves the open drawing as it is (the default for DXF and older versions: an export for someone else).',
  { path: opt(Str), format: opt(z.enum(['dwg', 'dxf'])), version: opt(Str), overwrite: opt(z.boolean()), copy: opt(z.boolean()) },
  DESTRUCTIVE, (a) => ({ ...a, path: a.path ? path.resolve(a.path) : undefined }));

bridgeTool('open_drawing',
  'Open a .dwg/.dxf file in AutoCAD (or switch to it if already open). Handles from another drawing are not valid there.',
  { path: Str, read_only: z.boolean().default(false) }, DESTRUCTIVE, (a) => ({ ...a, path: path.resolve(a.path) }));

bridgeTool('new_drawing',
  'Create a new drawing from a template (default acadiso.dwt, metric) and make it current.',
  { template: opt(Str) }, DESTRUCTIVE);

// ---------------------------------------------------------------- elevations, sections, structural details
function planFor(args, tool) {
  const base = args.plan ?? lastPlan;
  if (!base) throw new Error(`${tool}: no plan description yet: call draw_plan first in this session, or pass plan (the same object as draw_plan).`);
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
  if (at) return { at, info };
  if (!info.extents) return { at: [0, 0], info };
  // far enough that a sheet window around the new view does not catch its neighbour
  return { at: [info.extents.max[0] + 40 * scale, info.extents.min[1] + 80 * scale], info };
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
  const { at, info } = await freeSpot(args.at, sc);
  const r = engine('draw_section', () => buildSection(spec, { from, to, look, label, at, scale: sc, title: args.title }));
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
  const offset = !args.plan && lastFloors?.offsets?.[k] ? lastFloors.offsets[k] : [0, 0];
  return { spec: floors[k].spec, offset, key: floors[k].name, height: floors[k].height, label: ` ${floors[k].name}` };
}

/** Room outlines of the plan in the drawing (the A-AREA boundaries draw_plan made), by the room names of the plan. */
async function roomOutlines(spec, tool, offset = [0, 0], handles = null) {
  const q = await sendNow('query_entities', { layers: [ROLE.area], types: ['polyline'], detail: true, limit: 2000 });
  const polys = (q.entities || []).filter((e) => e.closed && Array.isArray(e.points) && e.points.length >= 3).map((e) => ({ poly: cleanPoly(e.points), handle: e.handle }));
  const out = {};
  for (const r of spec.rooms || []) {
    const p = [r.at[0] + offset[0], r.at[1] + offset[1]];
    const c = polys.filter((x) => inside(p, x.poly)).sort((a, b) => polyArea(a.poly) - polyArea(b.poly))[0];
    if (!c) continue;
    out[String(r.name)] = c.poly.map((q2) => [q2[0] - offset[0], q2[1] - offset[1]]);
    // the boundary, for quantities kept as fields of it
    if (handles) handles[String(r.name)] = c.handle;
  }
  if (!Object.keys(out).length) {
    throw new Error(`${tool}: no room outlines on ${ROLE.area}: draw the plan with draw_plan first (rooms with a point inside each, room_options.boundary true).`);
  }
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

const NotesArg = z.union([z.boolean(), z.array(Str)]).default(true)
  .describe('General notes of the sheet (GHI CHÚ): true = the standard ones for this kind of plan, a list = these, false = none');

/** The sheet's general notes under its legend (or right of the plan at the top). */
function sheetNotes(args, kind, base, sc, lang, below, extra) {
  if (args.notes === false) return;
  const lines = Array.isArray(args.notes) ? args.notes : generalNotes(kind, lang);
  if (!lines.length) return;
  const at = [base.bounds.max[0] + 15 * sc, below != null ? below - 6 * sc : base.bounds.max[1]];
  extra.push(...notesBlock(lines, at, sc, lang));
}

/** A copy of the plan (walls, openings, columns, grids, dimensions, room names) at an interior scale, moved by offset. */
async function planCopy(tool, spec, args, scale, { doors = true, roomLabels = true, labels = {}, levels = true } = {}) {
  const info = await sendNow('drawing_info', {});
  const pts = (spec.walls || []).flatMap((w) => w.points || []);
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1]));
  const offset = args.offset ?? [info.extents ? info.extents.max[0] + 80 * scale - x0 : 0, 0];
  // room names where given (clear of the furniture), else where the plan has them
  const moved = { ...spec, rooms: (spec.rooms || []).map((r) => (labels[r.name] ? { ...r, at: labels[r.name] } : r)) };
  const shifted = shiftSpec(moved, offset);
  const plan = engine(tool, () => buildPlan({
    ...shifted, scale, language: args.language ?? language, rooms: roomLabels ? shifted.rooms : [], levels: levels ? shifted.levels : [],
    room_options: { ...(spec.room_options || {}), boundary: false, text_height: undefined },
  }));
  const tags = new Set((spec.openings || []).map((o) => o.tag).filter(Boolean).map(String));
  let ents = plan.entities;
  if (!doors) ents = ents.filter((e) => e.layer !== ROLE.door && !(e.type === 'text' && tags.has(String(e.text))));
  ents = ents.map((e) => ([ROLE.grid, ROLE.opening, ROLE.hidden, ROLE.beam].includes(e.layer) ? { ...e, scale_linetype: true } : e));
  const b = entityBounds(ents) ?? { min: [x0 + offset[0], y0 + offset[1]], max: [x1 + offset[0], y0 + offset[1]] };
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

server.registerTool('draw_furniture_plan', {
  description:
    'Furniture layout plan (mặt bằng bố trí nội thất): a copy of the plan of draw_plan at 1:50 (walls, doors, windows, grids, ' +
    'dimensions, room names) to the right of the drawing (or at offset), with the furniture and joinery from the library and their ' +
    'code tags, and elevation keys (A top, B right, C bottom, D left) for the interior elevations. copy=false draws the items on ' +
    'the plan itself. Place an item with room + wall (A/B/C/D or top/right/bottom/left: its back against that wall) + offset from ' +
    'the left end of the wall seen from inside (default centred) + gap, or at (middle of its back edge) + facing (degrees the front ' +
    'faces), or center + facing (freestanding, e.g. a dining table). width/depth/height override the type size; code (default per ' +
    'type, e.g. FN-01 bed), description; kitchen_base takes sink and hob (x from its left end) and modules [{w, type: door|doors|' +
    'drawers|sink|open|appliance}]; kitchen_wall/hood take z0 (underside). The items are remembered for draw_interior_elevation, ' +
    `draw_ceiling_plan (pendants over tables), draw_joinery_detail and material_schedule. Types (w x d x h): ${FURNITURE_DOC}.`,
  inputSchema: {
    items: Specs, copy: z.boolean().default(true), offset: opt(Point), scale: z.number().positive().default(50),
    tags: z.boolean().default(true),
    elevation_keys: opt(jsonish(z.array(z.union([Str, Obj])))).describe('Rooms that get an elevation key: names, or {room, at}'),
    notes: NotesArg,
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
  const base = await planCopy('draw_furniture_plan', spec, args, sc, { labels });
  const extra = furniturePlan(r.items, { offset: base.offset, scale: sc, tags: args.tags });
  for (const [i, p] of keys.entries()) {
    const k = args.elevation_keys[i];
    elevationKey([p[0] + base.offset[0], p[1] + base.offset[1]], sc, extra, undefined, typeof k === 'string' ? k : k.room);
  }
  sheetNotes(args, 'furniture', base, sc, lang, null, extra);
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'FURNITURE LAYOUT PLAN' : 'MẶT BẰNG BỐ TRÍ NỘI THẤT'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  const warnings = [...r.warnings, ...notes];
  return text({
    offset: base.offset, items: summary, assumed: assumedOrNone(r.assumed), warnings: warnings.length ? warnings : undefined,
    count: res.count, bounds: res.bounds,
  });
}));

server.registerTool('draw_floor_finish_plan', {
  description:
    'Floor finish plan (mặt bằng lát sàn): a copy of the plan at 1:50 with the real tile or plank joints of each room (tiles ' +
    'centred in the room by default, or from a start point; planks staggered by a third), kept clear of the room names, a code ' +
    'tag under each name and the legend (finish, swatch at the real size, area m² and rooms). ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), legend: z.boolean().default(true),
    title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg,
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
  const base = await planCopy('draw_floor_finish_plan', spec, args, sc);
  const labels = Object.fromEntries((spec.rooms || []).map((r) => [String(r.name), r.at]));
  const ff = engine('draw_floor_finish_plan', () => floorFinishPlan({
    rooms, finishes, labels, offset: base.offset, scale: sc, lang, spec, items: interiorOf(key).items,
    legendAt: args.legend ? [base.bounds.max[0] + 15 * sc, base.bounds.max[1]] : undefined,
  }));
  assumed.push(...ff.assumed);
  const extra = [...ff.entities];
  sheetNotes(args, 'floor', base, sc, lang, ff.legendBottom, extra);
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'FLOOR FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN SÀN'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({ offset: base.offset, floors: ff.legend, assumed: assumedOrNone(assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_wall_finish_plan', {
  description:
    'Wall finish plan (mặt bằng hoàn thiện tường): a copy of the plan at 1:50; along the inside face of every wall of a room a band ' +
    'of its finish (one line for paint, two lines with the tile joints for tiles), broken at the doors and windows, the kitchen ' +
    'splashback behind the base cabinets of draw_furniture_plan, a code tag per room with the tiling height, the legend with the ' +
    'area of each wall finish (openings and splashback deducted) and the general notes. ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), legend: z.boolean().default(true),
    title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg,
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
  const base = await planCopy('draw_wall_finish_plan', spec, args, sc, { levels: false });
  const labels = Object.fromEntries((spec.rooms || []).map((r) => [String(r.name), r.at]));
  const wf = engine('draw_wall_finish_plan', () => wallFinishPlan({
    spec, rooms, finishes, items: st.items, labels, offset: base.offset, scale: sc, lang,
    legendAt: args.legend ? [base.bounds.max[0] + 15 * sc, base.bounds.max[1]] : undefined,
  }));
  const extra = [...wf.entities];
  sheetNotes(args, 'wall', base, sc, lang, wf.legendBottom, extra);
  sheetTitle(base, args.title ?? `${lang === 'en' ? 'WALL FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN TƯỜNG'}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({ offset: base.offset, walls: wf.legend, assumed: assumedOrNone(assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('draw_ceiling_plan', {
  description:
    'Reflected ceiling plan (mặt bằng trần đèn): a copy of the plan at 1:50 without door leaves; per room the drop band along the ' +
    'walls (step line, LED cove dashed), downlights in the band about every spacing (a grid on flat ceilings), a ceiling lamp in ' +
    'the middle or a pendant over each dining table of draw_furniture_plan, level tags (code over level) for the band and the ' +
    'field, the room name; then the light legend with counts (remembered for material_schedule). ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, offset: opt(Point), scale: z.number().positive().default(50), spacing: z.number().positive().default(1200),
    legend: z.boolean().default(true), title: opt(Str), plan: opt(Obj), language: opt(Lang), floor: FloorArg, notes: NotesArg,
    mode: z.enum(['both', 'finish', 'lighting']).default('both')
      .describe('finish = ceiling finish plan (materials, levels, step widths; no lights), lighting = lighting layout (lights and legend; no level tags), both = one reflected ceiling plan'),
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
  const base = await planCopy('draw_ceiling_plan', spec, args, sc, { doors: false, roomLabels: false, levels: false });
  const cp = engine('draw_ceiling_plan', () => ceilingPlan({
    rooms, finishes, items: st.items, offset: base.offset, scale: sc, spacing: args.spacing, lang, mode: args.mode,
    legendAt: args.legend ? [base.bounds.max[0] + 15 * sc, base.bounds.max[1]] : undefined,
  }));
  if (cp.lights) st.lights = cp.lights;
  const extra = [...cp.entities];
  sheetNotes(args, args.mode === 'lighting' ? 'lighting' : 'ceiling', base, sc, lang, cp.legendBottom, extra);
  const TITLES = {
    both: lang === 'en' ? 'REFLECTED CEILING PLAN' : 'MẶT BẰNG TRẦN ĐÈN',
    finish: lang === 'en' ? 'CEILING FINISH PLAN' : 'MẶT BẰNG HOÀN THIỆN TRẦN',
    lighting: lang === 'en' ? 'LIGHTING LAYOUT PLAN' : 'MẶT BẰNG BỐ TRÍ ĐÈN',
  };
  sheetTitle(base, args.title ?? `${TITLES[args.mode]}${floorLabel}`, sc, extra);
  const res = await drawPlanCopy(base, extra, sc, lang);
  return text({
    offset: base.offset, ceilings, lights: cp.lights, assumed: assumedOrNone(assumed), warnings: cp.warnings.length ? cp.warnings : undefined,
    count: res.count, bounds: res.bounds,
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
  const build = (wall, at) => engine('draw_interior_elevation', () => interiorElevation({
    spec, room: args.room, poly, finish: finishes[args.room], items, wall, at, scale: sc, lang,
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
    '{carcass, door, back, top, plinth, backsplash, rod, handle} replace the default specifications (reported in assumed).',
  inputSchema: {
    kind: z.enum(['kitchen', 'wardrobe']).default('kitchen'), item: opt(Str), name: opt(Str),
    width: opt(z.number().positive()), depth: opt(z.number().positive()), height: opt(z.number().positive()),
    modules: opt(Specs), wall_runs: opt(Specs).describe('[{x (from the left of the base run), w, modules}] wall cabinet runs; default one over the whole run'),
    hood: opt(Obj).describe('{x, w: 700, h: 650, z0: 1600} cooker hood between the wall cabinets'),
    sink: opt(z.number()), hob: opt(z.number()),
    base: opt(Obj), wall: opt(z.union([Obj, z.null()])), panel: opt(z.number().positive()), materials: opt(Obj),
    scale: z.number().positive().default(10), at: opt(Point), language: opt(Lang),
    dry_run: z.boolean().default(false).describe('List the sizes and materials it would assume, without drawing'),
  },
  annotations: EDIT,
}, ({ dry_run, ...args }) => exclusive(async () => {
  const p = { ...args };
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
    p.name = p.name ?? `${it.type === 'kitchen_base' ? 'TỦ BẾP' : it.def.vi.toUpperCase()} ${it.code}`;
  }
  const sc = p.scale;
  if (dry_run) {
    const r = engine('draw_joinery_detail', () => joineryDetail({ ...p, at: [0, 0] }));
    return dryRun(r.assumed, { kind: p.kind, width: p.width });
  }
  const { at, info } = await freeSpot(p.at, sc);
  const r = engine('draw_joinery_detail', () => joineryDetail({ ...p, at }));
  const res = await drawView(r.entities, sc, info, p.language);
  return text({ kind: p.kind, at, scale: `1:${sc}`, assumed: assumedOrNone(r.assumed), count: res.count, bounds: res.bounds });
}));

server.registerTool('material_schedule', {
  description:
    'Finish and material schedule (bảng thống kê vật liệu hoàn thiện): floors and ceilings in m² from the room outlines, ' +
    'skirting in m (door widths deducted), walls in m² (perimeter x height to the ceiling, openings deducted), kitchen ' +
    'backsplash, furniture/joinery/sanitary/equipment by count (draw_furniture_plan) and lights (draw_ceiling_plan); one row per ' +
    'code with its rooms. Draws a table (default right of the drawing) and csv_path saves it for Excel. ' + INTERIOR_DEFAULTS,
  inputSchema: {
    rooms: FinishRooms, draw: z.boolean().default(true), at: opt(Point), scale: z.number().positive().default(50),
    csv_path: opt(Str), csv_format: z.enum(['comma', 'semicolon']).default('comma'), plan: opt(Obj), language: opt(Lang),
    floor: FloorArg.describe('One floor of a building; default: every floor (rooms listed as "<floor>: <room>")'),
  },
  annotations: EDIT,
}, (args) => exclusive(async () => {
  const lang = args.language ?? language;
  const assumed = [];
  const whole = planFor(args, 'material_schedule');
  const multi = Array.isArray(whole.floors) && whole.floors.length && args.floor === undefined;
  const targets = multi ? floorsOf(whole).map((f, i) => floorFor({ ...args, floor: i + 1 }, 'material_schedule')) : [floorFor(args, 'material_schedule')];
  const acc = new Map();
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
    ms = engine('material_schedule', () => materialSchedule({ spec: t.spec, rooms, finishes, items: st.items, lights: st.lights, lang, floor: multi ? t.key : null, acc, handles }));
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
