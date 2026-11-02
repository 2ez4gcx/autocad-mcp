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
import { buildPlan, PlanError } from './plan.mjs';
import { dimStyleName, fitScale, layerSpecs, layerStyles, LAYERS, PAPERS, ROLE, styleParams, TEXT_STYLE, titleBlock } from './standards.mjs';

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

function sendNow(cmd, params = {}, label = cmd) {
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
      '1. Units: drawing units (mm in a metric drawing: check drawing_info.units), areas m², angles degrees counter-clockwise from +X, Y up, points [x,y].',
      '2. Start with drawing_info (and list_layers). On a connection error call ping; if the bridge is missing call install_autocad_bridge.',
      '3. Drawing from an image or a 3D model: read every printed dimension first (view_image with grid/crop zooms in), pick the plot scale, ' +
        'setup_layers + setup_styles, attach_image as a faded underlay calibrated on a known dimension, draw_plan for walls/openings/columns/' +
        'grids/stairs/rooms/dimensions, draw_entities for the rest (furniture, fixtures, hatches, notes, elevations), then screenshot and compare ' +
        'with the source, fix, check_drawing, create_layout + export_pdf.',
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
    '- stairs: [{start (middle of the first tread edge), direction (deg, 90 = up the page), width, treads, going, label?}]\n' +
    '- levels: [{at, value: "+0.000"}], sections: [{from, to, label, look: left|right}], north: {at, angle}\n' +
    '- dimensions: sides list (default ["bottom","left"]; ["bottom","left","top","right"]; false = none): chains of exterior ' +
    'openings/wall corners, grid spacing and overall size\n' +
    '- entities: extra draw_entities specs (furniture, fixtures, notes) drawn in the same step\n' +
    '- scale (100 = 1:100: text, symbols and hatch sizes), language vi|en, layers: {role: existing layer name} to follow the ' +
    'drawing\'s own scheme (roles: wall, wall_hatch, door, window, opening, column, column_hatch, grid, grid_tag, dims, ' +
    'room_tag, area, stair, text, symbol, floor_hatch).\n' +
    'Sets up MCP-ARIAL and the MCP-1-<scale> dimension style first. Returns wall handles, rooms with measured area_m2 and ' +
    'perimeter_m, unlabelled_spaces, entity handles and bounds. Check with screenshot afterwards.',
  inputSchema: {
    walls: opt(Specs), openings: opt(Specs), columns: opt(Specs), grid_columns: opt(Obj), grids: opt(Obj),
    rooms: opt(Specs), stairs: opt(Specs), levels: opt(Specs), sections: opt(Specs), north: opt(Obj),
    dimensions: opt(jsonish(z.union([z.boolean(), z.array(z.enum(['bottom', 'left', 'top', 'right']))]))),
    entities: opt(Specs),
    scale: z.number().positive().default(100),
    wall_thickness: opt(z.number().positive()), wall_material: opt(Str), hatch_walls: z.boolean().default(true),
    room_options: opt(Obj).describe('{decimals: 2, decimal_separator: "," (vi) or ".", boundary: true}'),
    layers: opt(Obj),
    language: opt(Lang),
  },
  annotations: EDIT,
}, async (args) => {
  let plan;
  try {
    plan = buildPlan({ ...args, language: args.language ?? language });
  } catch (e) {
    if (e instanceof PlanError) throw new Error(`draw_plan: ${e.message}`);
    throw e;
  }
  const req = withStyles({
    walls: plan.walls, cuts: plan.cuts, columns: plan.columns, rooms: plan.rooms, room_options: plan.room_options,
    entities: plan.entities, language: args.language,
    styles: styleParams({ scale: args.scale ?? 100 }),
  });
  const r = await call('draw_plan', req);
  if (plan.notes.length) r.notes = plan.notes;
  return text(r);
});

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
    title_block: opt(Obj).describe('{company, project, client, title, number, revision, sheet, date, drawn_by, checked_by}'),
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
  const tb = titleBlock({ paper, orientation, info: {}, language: lang ?? language });
  const area = tb.area;
  const aw = area[1][0] - area[0][0];
  const ah = area[1][1] - area[0][1];
  const ww = Math.abs(win[1][0] - win[0][0]);
  const wh = Math.abs(win[1][1] - win[0][1]);
  if (ww <= 0 || wh <= 0) throw new Error('create_layout: the window (or the drawing extents) is empty.');
  const s = scale ?? fitScale([ww, wh], [aw, ah], unitsPerMm);
  const info = { scale: `1:${s}`, date: new Date().toISOString().slice(0, 10), ...(title_block || {}) };
  const sheet = titleBlock({ paper, orientation, info, language: lang ?? language });
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
  return text({ ...r, scale: `1:${s}`, paper, orientation });
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
