// Layer standardisation of drawings made by others. Offices name layers every way (TUONG, A-Wall, WALL, 墙; dims on
// DIM, Kich thuoc, A- Dimension, 0-dim...), name them after a pen (0.3, manh, net thay) instead of what they hold,
// draw on layer 0 and give each entity its colour, so the same thing sits on many layers and one layer holds many
// things. This engine reads the survey of a drawing (bridge layer_survey: every entity grouped by layer, type,
// colour, linetype, lineweight and block) and works out where each group goes in a standard: the purpose of a layer
// from its name (Vietnamese with or without accents, English, Chinese, AIA-like codes, the prefix of a bound xref
// dropped), the type of the entity where the name says nothing or says otherwise (a dimension is a dimension
// whatever its layer), the block of an insert (a door, a level mark, a title block), and the weight it plots with
// (from the plot style table of the layouts) for linework of no known purpose. It keeps the plotted look by default:
// an override stays only where the standard layer would plot it otherwise. The plan it returns is carried out by the
// bridge (layer_remap) in one Undo step.
import zlib from 'node:zlib';
import { LAYERS } from './standards.mjs';

// ---------------------------------------------------------------- names

/** A layer or block name as words: the prefix of a bound xref dropped, accents and đ removed, lower case. */
export function nameParts(raw) {
  const name = String(raw ?? '');
  const xref = name.includes('|');
  const parts = name.split(/\$\d+\$/);
  const base = parts[parts.length - 1];
  const norm = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^a-z0-9㐀-鿿]+/g, ' ').replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return { name, base, norm, xref, bound: parts.length > 1 };
}

// the purpose of a layer by its name: first rule that matches (annotation before objects, specific before general)
const R = (re, role) => ({ re, role });
const NAME_RULES = [
  R(/\b(g )?viewports?\b|\bvports?\b|khung nhin/, 'viewport'),
  R(/\bnplt\b|non ?plot|no ?plot|khong ?in\b/, 'keep'),
  R(/sua doi|revision|\brevs?\b|\bclouds?\b|更改|修正|修改|新增/, 'revision'),
  R(/khung ?ten|title ?(block|frame)|titleblock|\btitle\b|\bframe\b|\bborder\b|tieu de|\blogo\b|图框|圖框|标题|標題/, 'title'),
  R(/thep ?(chu|doc)\b|thepchu|thepdoc/, 'rebar'),
  R(/\bdims?\b|dimension|kich ?thuoc|khich ?thuoc|lkich|尺寸|标注|標註/, 'dims'),
  R(/ghi ?chu|chu ?thich|\bnotes?\b|leader|引线|說明|说明/, 'note'),
  R(/\btext|\btxt\b|\bchu\b|\bchu (vn|hoa|viet)|textvni|文字|字体|字/, 'text'),
  R(/\bkh ?cua|ky ?hieu|ki ?hieu|kyhieu|\bsymb|symbol|\btags?\b|\biden\b|\bmarks?\b|cao ?do|caodo|cao ?trinh|\blevels?\b|\bcos\b|mat ?cat ?ky|matcat|dau ?cat|daucat|section ?(line|mark)|so ?hieu|so ?thu ?tu|\bnorth\b|huong bac|符号|符號|標記|标高|標高/, 'symbol'),
  R(/\btruc\b|ng truc|\baxis|\bgrid|duong ?tim|\btim\b|\bcenter\b|轴|軸|网格/, 'grid'),
  R(/khuat|hidden|\bhide\b|\bhidd|虚线|虛線|隐藏/, 'hidden'),
  R(/thep ?dai|\bdai\b|stirrup|cot ?dai|箍筋/, 'stirrup'),
  R(/bolts?\b|bu ?lon|bulon|bu ?long|screw|\bvit\b|anchor|purlin|xa ?go|\bplates?\b|\bstif|thep hinh|\bmelt\b|metal|kim loai|螺栓|钢结构|鋼構/, 'steel'),
  R(/\bthep|\brebar|ferraillage|\bbarre\b|\bsteel\b|钢筋|鋼筋/, 'rebar'),
  R(/\bdam\b|\bbeams?\b|poutre|\bgiang\b|tigiang|梁/, 'beam'),
  R(/\bcot\b|\bcols?\b|columns?|\bcolu\b|\btru\b|柱/, 'column'),
  R(/be ?tong|betong|beton|concrete|\bconc\b|\bmong\b|foundation|footing|\bftg\b|混凝土|砼|基础|基礎/, 'concrete'),
  R(/hatch|\bhach|hacth|\bhatc|\bpatt|pattern|vat ?lieu|vatlieu|lat ?gach|dien hoa|填充|图案|圖案/, 'hatch'),
  R(/cua ?so|cuaso|windows?|\bwin\b|\bglaz|\bglass|\bkinh\b|louver|\bcurt\b|curtain|vach ?kinh|窗/, 'window'),
  R(/cua ?di|cuadi|\bdoors?\b|\bcua\b|门|門/, 'door'),
  R(/\btuong\b|\bwalls?\b|\bxay\b|partition|\bvach\b|墙|牆/, 'wall'),
  R(/thang ?may|elevator|\blift\b|\bevtr\b|\bmachines?\b|may ?moc/, 'equipment'),
  R(/lan ?can|\bhral|railing|handrail|tay ?vin|栏杆|欄杆/, 'railing'),
  R(/\bthang\b|stairs?\b|\bstrs\b|\bramp|bac ?thang|楼梯|樓梯/, 'stair'),
  R(/noi ?that|noithat|\bfurn|furniture|vat ?dung|vatdung|do ?dac|ban ?ghe|banghe|家具/, 'furniture'),
  R(/tbvs|ve ?sinh|sanitary|toilet|\bwc\b|\bfixd|\bfixt|洁具|衛浴|卫浴/, 'fixture'),
  R(/\bcase\b|casework|do ?go|tu ?bep|joinery|millwork/, 'casework'),
  R(/\btran\b|\bclng|ceiling|天花|吊顶/, 'ceiling'),
  R(/\bmai\b|\broofs?\b|\bngoi\b|\btole\b|\bton\b|屋顶|屋頂/, 'roof'),
  R(/\bflor\b|\bfloors?\b|nen nha/, 'floor_edge'),
  R(/\beqpm|equipment|thiet ?bi|设备|設備/, 'equipment'),
  R(/\belev\b|mat ?dung|立面/, 'elevation'),
  R(/\bsect\b|\bsection\b|mat ?cat|剖面/, 'section'),
  R(/\barea\b|dien ?tich/, 'area'),
  R(/\bcay|\btrees?\b|\bplnt|\bplants?\b|\bturf\b|ncay|\bpepl\b|people|绿化|綠化|树|樹/, 'landscape'),
  R(/\broads?\b|\bcurbs?\b|\bsite\b|ranh ?dat|via ?he|\bfenc|fence|hang ?rao|\bpkng\b|parking|\bpool\b|ho ?boi|\bvhcl\b|vehicle|\bbrdg\b|bridge|道路/, 'site'),
  R(/\bac\b|air ?con|dieu ?hoa|\bducts?\b|hvac|ong ?gio|空调|空調|风管|風管/, 'hvac'),
  R(/\bpipes?\b|\bong\b|cap ?nuoc|thoat ?nuoc|\bpccc\b|sprinkler|\bsprt\b|mhole|manhole|ho ?ga|管道|管/, 'pipe'),
  R(/\bden\b|\blights?\b|chieu ?sang|照明/, 'light'),
  R(/\bdien\b|\belec|\bcables?\b|\bpower\b|电|電/, 'power'),
  R(/\bdetl|\bdetails?\b|chi ?tiet|chitiet|insulation|cach ?nhiet/, 'detail'),
];
// names that only say how a line plots (a pen): their content is sorted by type
const WEIGHT = /^\s*(t|in|lw|n)?\s*\d+([ .,]\d+)?\s*$|\bnet\b|\bmanh\b|netmanh|\bthay\b|netthay|\bthin\b|\bfine\b|\bxfine\b|medium|midium|\bmedm\b|\bwide\b|\bbold\b|\bthick\b|\bdam\b|netdam|\bday\b|\bbao\b|duong ?bao|\bmo\b|\blines?\b|visible|\bcut\b|net ?cat|netcat|\bcat\b|\bin \d|可見|可见|折斷|折断|^\d+ line|^\d+$/;
const THICK = /\bcat\b|netcat|\bcut\b|\bbao\b|\bdam\b|netdam|\bday\b|\bwide\b|\bbold\b|\bthick\b/;
const THIN = /\bmanh\b|netmanh|\bthin\b|\bfine\b|\bxfine\b|\bmo\b|\bthay\b|netthay/;

/**
 * The purpose of a layer by its name: {role, by: 'name' | 'weight' | 'zero' | 'keep' | null, thick?: true | false}.
 * role null: nothing in the name (its entities go by type); keep: a layer AutoCAD keeps as it is (Defpoints).
 */
export function layerRole(name) {
  const p = nameParts(name);
  if (p.xref) return { role: null, by: 'keep', why: 'xref' };
  if (p.base === '0') return { role: null, by: 'zero' };
  if (p.norm === 'defpoints') return { role: null, by: 'keep', why: 'defpoints' };
  let role = null;
  for (const r of NAME_RULES) {
    if (r.re.test(p.norm) || r.re.test(p.base)) {
      role = r.role;
      break;
    }
  }
  const weight = WEIGHT.test(p.norm);
  // the weight a pen name says, for linework of no other purpose
  const num = p.norm.match(/(\d+)[ .,](\d+)|^\s*t?\s*(0\d)\s*$/);
  let thick;
  if (THICK.test(p.norm)) thick = true;
  else if (THIN.test(p.norm)) thick = false;
  else if (num) {
    const v = num[3] ? Number(`0.${num[3].slice(1)}`) : Number(`${num[1]}.${num[2]}`);
    if (Number.isFinite(v) && v > 0 && v < 3) thick = v >= 0.35;
  }
  // a detail layer named by its weight (A-Detl-Wide) is a cut line
  if (role === 'detail' && thick) role = 'detail_cut';
  if (role === 'keep') return { role: null, by: 'keep', why: 'not_plotted' };
  if (role) return { role, by: 'name', ...(thick !== undefined ? { thick } : {}) };
  if (weight) return { role: null, by: 'weight', ...(thick !== undefined ? { thick } : {}) };
  return { role: null, by: null };
}

// the purpose of a block by its name; then by what it holds
const BLOCK_RULES = [
  R(/archtick|\btick\b|oblique|\barrow\b|\bdot\b|closed ?blank|\bnone\b/, 'dims'),
  R(/\btruc\b|ten ?truc|\bgrid|\baxis/, 'grid_tag'),
  R(/\bmarks?\b|\btags?\b|cao ?do|caodo|cao ?trinh|caotrinh|\blevels?\b|levername|mat ?cat|matcat|dau ?cat|daucat|section|detail ?mark|\bnorth\b|huong ?bac|\bbac\b|so ?hieu|sohieu|ky ?hieu|kyhieu|\bkh\b|\bkh ?cua|starting point|drop line|do ?doc|\bcode\b/, 'symbol'),
  R(/khung|\bframe\b|title|\bborder\b|tieu ?de|^a ?[0-4]\b/, 'title'),
  R(/\bdoors?\b|cua ?di|cuadi|^ad ?\d|^d ?\d{1,2}$|^dd ?\d|^sd ?\d|^vk ?\d*$/, 'door'),
  R(/windows?|cua ?so|cuaso|^aw ?\d|^sw ?\d|^w ?\d{1,2}$|^s ?\d{1,2}$|louver|\blam\b|sliding/, 'window'),
  R(/toilet|lavabo|bon ?cau|\bwc\b|urinal|\btieu\b|\bvoi\b|\bsen\b|\bsink\b|\bchau\b|pheu ?thu|drain|\bbath|\btub\b|shower|拖布|洗|便/, 'fixture'),
  R(/sofa|\bbeds?\b|giuong|\bban\b|\bghe\b|chairs?|tables?|\bdesk|\btu\b|cabinet|wardrobe|kitchen|\bbep\b|banghe|\bfurn/, 'furniture'),
  R(/\bcay|\btrees?\b|\bplants?\b|\bbush/, 'landscape'),
  R(/\bbolts?\b|screw|\bvit\b|anchor|bulon|bu ?long|purlin|\bbl\b/, 'steel'),
  R(/^cot\b|column|^c ?\d+ ?x ?\d+$|^\d+ ?x ?\d+$/, 'column'),
  R(/thang ?may|elevator|\blift\b/, 'equipment'),
  R(/\bac\b|outdoor|indoor|condition|dieu ?hoa|\bfan\b|\bducts?\b/, 'hvac'),
  R(/\bbrek|\bbreak/, 'detail'),
  R(/\brev\b|\bcloud/, 'revision'),
];

/** The purpose of a block: by its name, else by its content (a few entities with attributes: a tag; many: a title block). */
export function blockRole(name, info = null) {
  const p = nameParts(name);
  if (!/^\*/.test(p.base) && !/^a\$c[0-9a-f]+$/i.test(p.base)) {
    for (const r of BLOCK_RULES) if (r.re.test(p.norm) || r.re.test(p.base)) return r.role;
  }
  if (info?.attributes) {
    if ((info.count ?? 0) >= 40) return 'title';
    if ((info.count ?? 0) <= 15) return 'symbol';
  }
  return null;
}

// ---------------------------------------------------------------- the standard

// layers this engine may need beyond the standard set of the drawing tools (made only when used)
const EXTRA_TABLE = [
  ['A-ANNO-REVS', 6, 'Continuous', 0.25, true, 'Revision clouds and marks', 'Đám mây, ký hiệu sửa đổi', 'revision'],
  ['A-FLOR-HRAL', 6, 'Continuous', 0.25, true, 'Railings and handrails', 'Lan can, tay vịn', 'railing'],
  ['L-PLNT', 3, 'Continuous', 0.18, true, 'Trees and planting', 'Cây xanh', 'landscape'],
  ['C-SITE', 8, 'Continuous', 0.25, true, 'Site: roads, curbs, boundaries', 'Tổng mặt bằng: đường, bó vỉa, ranh đất', 'site'],
  ['S-STEL', 7, 'Continuous', 0.35, true, 'Structural steel, bolts and plates', 'Kết cấu thép, bu lông, bản mã', 'steel'],
  ['S-DETL', 7, 'Continuous', 0.25, true, 'Structural detail lines', 'Nét chi tiết kết cấu', 'struct_detail'],
  ['S-DETL-OTLN', 7, 'Continuous', 0.5, true, 'Structural detail cut outlines', 'Nét cắt chi tiết kết cấu', 'struct_detail_cut'],
  ['S-HIDD', 8, 'HIDDEN', 0.18, true, 'Structural hidden lines', 'Nét khuất kết cấu', 'struct_hidden'],
  ['M-HVAC', 4, 'Continuous', 0.25, true, 'Air conditioning and ducts', 'Điều hòa, ống gió', 'hvac'],
  ['P-PIPE', 5, 'Continuous', 0.25, true, 'Pipes (system not identified)', 'Đường ống (chưa rõ hệ)', 'pipe'],
];
const EXTRAS = EXTRA_TABLE.map(([name, color, linetype, lineweight, plot, en, vi, role]) => ({ name, color, linetype, lineweight, plot, en, vi, role }));

// what a role becomes in a structural drawing
const STRUCT_ROLE = { text: 'struct_text', note: 'struct_text', dims: 'struct_dims', symbol: 'struct_symbol', detail: 'struct_detail', detail_cut: 'struct_detail_cut', hidden: 'struct_hidden', hatch: 'concrete_hatch', detail_hatch: 'concrete_hatch' };
// the hatch layer of the purpose of a layer
const HATCH_OF = {
  wall: 'wall_hatch', column: 'column_hatch', concrete: 'concrete_hatch', floor_edge: 'floor_hatch', ceiling: 'ceiling_hatch', section: 'section_hatch', elevation: 'elevation_hatch',
  roof: 'elevation_hatch', detail: 'detail_hatch', detail_cut: 'detail_hatch', hatch: 'hatch', title: 'title', symbol: 'symbol', landscape: 'landscape', site: 'site', grid_tag: 'grid_tag',
  revision: 'revision', struct_detail: 'concrete_hatch', struct_detail_cut: 'concrete_hatch', beam: 'concrete_hatch', area: 'area', viewport: 'viewport',
};
const TEXTUAL = new Set(['text', 'note', 'title', 'symbol', 'grid_tag', 'room_tag', 'revision', 'dims', 'struct_text', 'struct_symbol', 'struct_dims', 'area']);

/**
 * The target layers: {byRole: {role: spec}, byName: {name lowercase: spec}}. standard: a list of layers given by the
 * user ({name, color, linetype, lineweight, plot, description, role}): a role it names takes that layer, the other
 * roles keep the layer of the drawing tools.
 */
export function targetLayers(standard = null, lang = 'vi') {
  const byRole = {};
  for (const l of [...LAYERS, ...EXTRAS]) byRole[l.role] ??= { name: l.name, color: l.color, linetype: l.linetype, lineweight: l.lineweight, plot: l.plot, description: lang === 'en' ? l.en : l.vi };
  const own = [];
  for (const s of standard || []) {
    if (!s?.name) continue;
    const spec = { name: String(s.name), color: s.color ?? 7, linetype: s.linetype ?? 'Continuous', lineweight: s.lineweight ?? 0.25, plot: s.plot !== false, description: s.description ?? '' };
    own.push(spec);
    if (s.role) byRole[s.role] = spec;
  }
  const byName = {};
  for (const s of [...Object.values(byRole), ...own]) byName[s.name.toLowerCase()] = s;
  return { byRole, byName };
}

// ---------------------------------------------------------------- plot styles

/**
 * A colour-dependent plot style table (.ctb): {name, pens: [aci 1..255 -> lineweight mm, or null: the object's
 * own lineweight]}. The file is a header, then zlib text: plot_style{ n{ ... lineweight=<index> } } and a table
 * of the lineweights (index 0 = "use object lineweight").
 */
export function parseCtb(buffer, name = '') {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let text = null;
  for (let i = 0; i < Math.min(b.length - 2, 200); i++) {
    if (b[i] === 0x78 && (b[i + 1] === 0x9c || b[i + 1] === 0xda || b[i + 1] === 0x01 || b[i + 1] === 0x5e)) {
      try {
        text = zlib.inflateSync(b.subarray(i)).toString('latin1');
        break;
      } catch {
        // not the stream: go on
      }
    }
  }
  if (!text) throw new Error(`${name || 'plot style'}: not a plot style table`);
  const table = {};
  const lt = text.match(/custom_lineweight_table\{([^}]*)\}/);
  if (lt) for (const m of lt[1].matchAll(/(\d+)=([\d.]+)/g)) table[Number(m[1])] = Number(m[2]);
  const pens = new Array(256).fill(null);
  const ps = text.indexOf('plot_style{');
  if (ps >= 0) {
    for (const m of text.slice(ps).matchAll(/\n\s*(\d+)\{([^}]*)\}/g)) {
      const k = Number(m[1]);
      const w = m[2].match(/lineweight=(\d+)/);
      if (k >= 0 && k < 255 && w) {
        const idx = Number(w[1]);
        pens[k + 1] = idx === 0 || idx === 255 ? null : table[idx] ?? null;
      }
    }
  }
  return { name, pens };
}

// ---------------------------------------------------------------- the plan

const DIM_T = new Set(['DIMENSION', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'TOLERANCE', 'ARCALIGNEDTEXT']);
const TEXT_T = new Set(['TEXT', 'MTEXT', 'ATTDEF', 'RTEXT', 'ATTRIB']);
const LEADER_T = new Set(['LEADER', 'MULTILEADER', 'MLEADER']);
const FILL_T = new Set(['HATCH', 'SOLID', 'TRACE', 'MPOLYGON']);

const aciOf = (c) => (typeof c === 'number' ? c : null);
const lwNum = (w, dflt) => (typeof w === 'number' ? w : w === 'default' || w == null ? dflt : null);
const ltKey = (t) => String(t ?? '').toLowerCase();

/**
 * The mapping of a drawing to the standard. survey: the result of the bridge layer_survey. Options: discipline
 * ('auto' | 'arch' | 'struct'), keepLook (true: an override stays where the standard layer would plot the entity in
 * another class of weight - fine, thin, medium, thick - or change a continuous line into a dashed one or back;
 * 'exact': any other weight; false: everything ByLayer),
 * mapping {old layer: new layer | 'keep'} (the user's word over the engine's), standard (targetLayers' argument),
 * unknown ('map': layers named after nothing go by their content; 'keep': they stay), ctb (parseCtb of the plot
 * style of the layouts, null: the objects' own lineweights), lwDefault (mm), lang.
 * Returns {discipline, layers: [{layer, entities, role, by, targets {name: count}, action}], create, props, renames,
 * rules, delete, current, summary, warnings, keep}.
 */
export function planLayers(survey, { discipline = 'auto', keepLook = true, mapping = {}, standard = null, unknown = 'map', ctb = null, lwDefault = 0.25, lang = 'vi', fixProps = true } = {}) {
  const T = targetLayers(standard, lang);
  const layerInfo = new Map((survey.layers || []).map((l) => [l.name.toLowerCase(), l]));
  const blockInfo = new Map((survey.blocks || []).map((b) => [b.name, b]));
  const groups = survey.groups || [];
  const userMap = new Map(Object.entries(mapping || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const roles = new Map();
  for (const l of survey.layers || []) roles.set(l.name.toLowerCase(), layerRole(l.name));
  for (const g of groups) if (!roles.has(g.layer.toLowerCase())) roles.set(g.layer.toLowerCase(), layerRole(g.layer));

  // the discipline: structural layers against architectural ones, by the entities they hold
  let disc = discipline;
  if (!disc || disc === 'auto') {
    const file = nameParts(String(survey.drawing ?? '').split(/[\\/]/).pop() ?? '').norm;
    if (/\b(kc|kcb|ket ?cau|structure|structural|struct)\b/.test(file)) disc = 'struct';
    else if (/\b(kt|kien ?truc|architecture|architectural|arch|nt|noi ?that|interior)\b/.test(file)) disc = 'arch';
    else {
      let s = 0, a = 0;
      for (const g of groups) {
        if (g.space === 'block') continue;
        const r = roles.get(g.layer.toLowerCase())?.role;
        if (['rebar', 'stirrup', 'beam', 'steel'].includes(r)) s += g.count;
        if (['door', 'window', 'furniture', 'fixture', 'casework', 'ceiling', 'stair', 'railing', 'wall'].includes(r)) a += g.count;
      }
      disc = s > a ? 'struct' : 'arch';
    }
  }
  const role2 = (r) => (disc === 'struct' && STRUCT_ROLE[r] ? STRUCT_ROLE[r] : r === 'hatch' ? 'detail_hatch' : r);
  const spec = (r) => T.byRole[role2(r)] ?? T.byRole[r] ?? null;

  // printed weight of an entity: the pen of its colour in the plot style, else its own lineweight (layer's, default)
  const pen = (aci, lw) => {
    const p = ctb && aci >= 1 && aci <= 255 ? ctb.pens[aci] : null;
    return p ?? lw;
  };
  const decide = (g) => {
    const key = g.layer.toLowerCase();
    const forced = userMap.get(key);
    const lr = roles.get(key) ?? { role: null, by: null };
    if (forced === 'keep' || forced === 'auto' ? forced === 'keep' : false) return { keep: true, why: 'given' };
    if (forced && forced !== 'auto') return { to: String(forced), why: 'given' };
    if (g.space === 'block' && lr.by === 'zero') return { keep: true, why: 'zero_in_block' };
    if (lr.by === 'keep') {
      if (g.type === 'VIEWPORT' && lr.why === 'defpoints') return { role: 'viewport', why: 'type' };
      return { keep: true, why: lr.why };
    }
    const r = lr.role;
    const t = g.type;
    if (t === 'VIEWPORT') return { role: 'viewport', why: 'type' };
    if (t === 'IMAGE' || t === 'OLE2FRAME' || t === 'PDFUNDERLAY' || t === 'DWFUNDERLAY' || t === 'DGNUNDERLAY') return { role: 'image', why: 'type' };
    if (DIM_T.has(t)) return { role: 'dims', why: 'type' };
    if (r && lr.by === 'name') {
      if (TEXT_T.has(t)) return { role: TEXTUAL.has(r) ? r : 'text', why: TEXTUAL.has(r) ? 'name' : 'type' };
      if (LEADER_T.has(t)) return { role: ['symbol', 'dims', 'revision', 'title'].includes(r) ? r : 'note', why: 'type' };
      if (FILL_T.has(t)) return { role: HATCH_OF[r] ?? (r === 'hatch' ? 'hatch' : 'hatch'), why: HATCH_OF[r] ? 'name' : 'type' };
      if (t === 'INSERT') {
        const b = blockRole(g.block, blockInfo.get(g.block));
        // a block of its own purpose on a layer of annotation or of none in particular
        if (b && b !== r && ['dims', 'text', 'note', 'hatch', 'detail', 'detail_cut'].includes(r)) return { role: b, why: 'block' };
        if (b === 'grid_tag' && (r === 'grid' || r === 'symbol')) return { role: 'grid_tag', why: 'block' };
        return { role: r, why: 'name' };
      }
      return { role: r, why: 'name' };
    }
    // a layer named after a pen, layer 0, or a name that says nothing: by type
    if (r === null && lr.by === null && unknown === 'keep') return { keep: true, why: 'unknown' };
    if (TEXT_T.has(t)) return { role: 'text', why: 'type' };
    if (LEADER_T.has(t)) return { role: 'note', why: 'type' };
    if (FILL_T.has(t)) return { role: 'hatch', why: 'type' };
    if (t === 'INSERT') return { role: blockRole(g.block, blockInfo.get(g.block)) ?? 'detail', why: blockRole(g.block, blockInfo.get(g.block)) ? 'block' : 'type' };
    if (t === 'WIPEOUT') return { role: 'detail', why: 'type' };
    // linework: thin or cut by the weight it plots with (or the weight its layer is named after)
    const L = layerInfo.get(key) ?? {};
    const lw = g.lineweight === 'bylayer' ? lwNum(L.lineweight, lwDefault) : lwNum(g.lineweight, lwDefault);
    const aci = g.color === 'bylayer' ? aciOf(L.color) : aciOf(g.color);
    const w = pen(aci, lw ?? lwDefault);
    const thick = w !== lwDefault ? w >= 0.35 : lr.thick === true;
    return { role: thick ? 'detail_cut' : 'detail', why: lr.by === 'weight' ? 'weight' : 'type' };
  };

  // every group decided
  const out = [];
  for (const g of groups) {
    const d = decide(g);
    let target = null;
    if (!d.keep) {
      if (d.to) target = T.byName[d.to.toLowerCase()] ?? { name: d.to, color: layerInfo.get(g.layer.toLowerCase())?.color ?? 7, linetype: layerInfo.get(g.layer.toLowerCase())?.linetype ?? 'Continuous', lineweight: 0.25, plot: true, description: '', given: true };
      else target = spec(d.role);
      if (!target) target = spec('detail');
    }
    out.push({ g, d, target });
  }

  // what each moved group must keep to plot as before (keepLook), else everything ByLayer
  const warnings = [];
  let ovBefore = 0, ovAfter = 0, lookKept = 0, weightChanges = 0, dashChanges = 0;
  for (const o of out) {
    const { g, target } = o;
    const isOv = (g.color !== 'bylayer' && g.color !== 'byblock') || !['bylayer', 'byblock'].includes(ltKey(g.linetype)) || (g.lineweight !== 'bylayer' && g.lineweight !== 'byblock');
    if (g.space !== 'block' && isOv) ovBefore += g.count;
    if (!target) {
      if (g.space !== 'block' && isOv) ovAfter += g.count;
      continue;
    }
    const L = layerInfo.get(g.layer.toLowerCase()) ?? {};
    const set = {};
    const inBlock = g.space === 'block';
    // colour and weight
    const colBefore = g.color === 'bylayer' ? aciOf(L.color) : g.color === 'byblock' ? (inBlock ? 'byblock' : 7) : g.color;
    // the weight it plots with: the entity's own, its layer's, the default lineweight (LWDEFAULT) where either says
    // "default", or a fixed pen of the plot style
    const ownLw = typeof g.lineweight === 'number' ? g.lineweight : g.lineweight === 'default' ? lwDefault
      : g.lineweight === 'bylayer' ? (typeof L.lineweight === 'number' ? L.lineweight : lwDefault) : null;
    const fixedPen = ctb && typeof colBefore === 'number' && colBefore >= 1 && colBefore <= 255 ? ctb.pens[colBefore] : null;
    const ltBefore = ltKey(g.linetype) === 'bylayer' ? ltKey(L.linetype) : ltKey(g.linetype);
    let wantColor = 'bylayer', wantLw = 'bylayer', wantLt = 'bylayer';
    if (g.color === 'byblock' && inBlock) wantColor = 'byblock';
    if (g.lineweight === 'byblock' && inBlock) wantLw = 'byblock';
    if (ltBefore === 'byblock' && inBlock) wantLt = 'byblock';
    let kept = false;
    // what the standard changes in how it plots: another class of weight (fine, thin, medium, thick: what a reader
    // sees), a continuous line dashed or a dashed one continuous. keepLook keeps those (an override stays); 'exact'
    // keeps any other weight; false takes the standard everywhere (the dry run counts what changes)
    const cls = (w) => (w < 0.14 ? 0 : w < 0.28 ? 1 : w < 0.45 ? 2 : 3);
    if (wantColor === 'bylayer' && wantLw === 'bylayer' && (fixedPen != null || ownLw != null)) {
      const before = fixedPen ?? ownLw;
      const after = pen(aciOf(target.color), lwNum(target.lineweight, lwDefault));
      const differs = keepLook === 'exact' ? Math.abs(before - after) > 0.005 : cls(before) !== cls(after);
      if (differs && g.space !== 'block') weightChanges += g.count;
      if (differs && keepLook) {
        if (fixedPen != null) wantColor = colBefore; // the pen comes from the colour
        else wantLw = Number(before.toFixed(2));
        kept = true;
      }
    }
    if (keepLook && typeof g.color === 'string' && g.color.startsWith('#')) wantColor = g.color; // a true colour stays
    const dashed = (t) => !!t && t !== 'continuous' && t !== 'bylayer' && t !== 'byblock';
    const tLt = ltKey(target.linetype || 'continuous');
    if (ltBefore && ltBefore !== 'byblock' && dashed(ltBefore) !== dashed(tLt)) {
      if (g.space !== 'block') dashChanges += g.count;
      if (keepLook) {
        wantLt = dashed(ltBefore) ? (ltKey(g.linetype) === 'bylayer' ? L.linetype : g.linetype) : 'Continuous';
        kept = true;
      }
    }
    if (kept) lookKept += g.count;
    if (String(wantColor) !== String(g.color)) set.color = wantColor;
    if (String(wantLw) !== String(g.lineweight)) set.lineweight = wantLw;
    if (ltKey(wantLt) !== ltKey(g.linetype)) set.linetype = wantLt;
    o.set = Object.keys(set).length ? set : null;
    const stays = (wantColor !== 'bylayer' && wantColor !== 'byblock') || (wantLw !== 'bylayer' && wantLw !== 'byblock') || !['bylayer', 'byblock'].includes(ltKey(wantLt));
    if (g.space !== 'block' && stays) ovAfter += g.count;
  }

  // per layer: where its entities go
  const perLayer = new Map();
  for (const o of out) {
    const k = o.g.layer;
    if (!perLayer.has(k)) perLayer.set(k, { layer: k, entities: 0, inBlocks: 0, role: roles.get(k.toLowerCase()), targets: new Map(), kept: 0, sets: 0, list: [] });
    const p = perLayer.get(k);
    if (o.g.space === 'block') p.inBlocks += o.g.count;
    else p.entities += o.g.count;
    p.list.push(o);
    if (!o.target) p.kept += o.g.count;
    else {
      p.targets.set(o.target.name, (p.targets.get(o.target.name) ?? 0) + o.g.count);
      if (o.set) p.sets += o.g.count;
    }
  }
  const existing = new Set((survey.layers || []).map((l) => l.name.toLowerCase()));
  const usedTargets = new Map();
  for (const o of out) if (o.target) usedTargets.set(o.target.name.toLowerCase(), o.target);

  // whole layers renamed when all they hold goes to one target the drawing does not have yet (their viewport
  // overrides and layer states stay with them); the rest moved by rules
  const renames = [], rules = [], renamedTo = new Set();
  const layersOut = [];
  for (const p of perLayer.values()) {
    const info = layerInfo.get(p.layer.toLowerCase());
    const targets = [...p.targets.keys()];
    let action = 'keep';
    const one = targets.length === 1 && p.kept === 0 ? targets[0] : null;
    if (one && one.toLowerCase() === p.layer.toLowerCase()) action = p.sets ? 'clean' : 'ok';
    else if (one && !existing.has(one.toLowerCase()) && !renamedTo.has(one.toLowerCase()) && p.sets === 0 && info && !info.xref && p.layer !== '0' && p.layer.toLowerCase() !== 'defpoints') {
      renames.push({ from: p.layer, to: one });
      renamedTo.add(one.toLowerCase());
      action = 'rename';
    } else if (targets.length) action = targets.length > 1 || p.kept ? 'split' : 'merge';
    if (action !== 'rename' && action !== 'keep' && action !== 'ok') {
      // one rule when every group goes the same way, else a rule per group
      const ways = new Map();
      for (const o of p.list) {
        if (!o.target) continue;
        const k = `${o.target.name}\u0001${JSON.stringify(o.set ?? null)}`;
        ways.set(k, (ways.get(k) ?? 0) + 1);
      }
      if (ways.size === 1 && p.kept === 0) {
        const o = p.list.find((x) => x.target);
        rules.push({ from: p.layer, to: o.target.name, ...(o.set ? { set: o.set } : {}) });
      } else {
        for (const o of p.list) {
          if (!o.target) continue;
          const g = o.g;
          rules.push({
            from: g.layer, to: o.target.name, space: g.space, type: g.type, color: g.color, linetype: g.linetype, lineweight: g.lineweight, ...(g.block ? { block: g.block } : {}),
            ...(o.set ? { set: o.set } : {}),
          });
        }
      }
    }
    layersOut.push({
      layer: p.layer, entities: p.entities, ...(p.inBlocks ? { in_blocks: p.inBlocks } : {}), role: p.role?.role ?? null, by: p.role?.by ?? null, action,
      targets: Object.fromEntries(p.targets), ...(p.kept ? { kept: p.kept } : {}), ...(p.sets ? { overrides: p.sets } : {}),
    });
  }
  // a renamed layer is the target of the others: it gets the standard properties
  const create = [], props = [];
  for (const [k, t] of usedTargets) {
    const r = renames.find((x) => x.to.toLowerCase() === k);
    const sp = { name: t.name, color: t.color, linetype: t.linetype, lineweight: t.lineweight, plot: t.plot, description: t.description };
    if (r) r.props = { color: t.color, linetype: t.linetype, lineweight: t.lineweight, plot: t.plot, description: t.description };
    else if (!existing.has(k)) create.push(sp);
    else if (fixProps && !t.given) {
      const L = layerInfo.get(k);
      // its properties, and its name spelt as the standard spells it (A-Wall becomes A-WALL: one spelling in every drawing)
      if (L && (L.name !== t.name || String(L.color) !== String(t.color) || ltKey(L.linetype) !== ltKey(t.linetype) || Number(L.lineweight) !== Number(t.lineweight) || (L.plot === false) === (t.plot !== false))) props.push(sp);
    }
  }
  // the layers left empty are purged; the current layer moves to where its entities went
  const targetNames = new Set([...usedTargets.keys()]);
  const del = layersOut.filter((l) => l.action !== 'keep' && l.action !== 'ok' && l.action !== 'clean' && l.action !== 'rename' && !l.kept && !targetNames.has(l.layer.toLowerCase()) && l.layer !== '0' && l.layer.toLowerCase() !== 'defpoints').map((l) => l.layer);
  // layers that hold nothing at all go too (empty layers of the drawing)
  const withEntities = new Set(groups.map((g) => g.layer.toLowerCase()));
  for (const l of survey.layers || []) {
    const k = l.name.toLowerCase();
    if (!withEntities.has(k) && !l.xref && !l.current && k !== '0' && k !== 'defpoints' && !targetNames.has(k)) del.push(l.name);
  }
  const cur = (survey.layers || []).find((l) => l.current);
  const curL = cur ? layersOut.find((l) => l.layer === cur.name) : null;
  // the current layer matters only when it is purged: then the layer most of its entities went to is made current
  const curTo = cur && del.includes(cur.name) ? (Object.entries(curL?.targets ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '0') : null;

  // viewport overrides lost by a merge
  for (const [name, n] of Object.entries(survey.viewport_frozen || {})) {
    if (del.includes(name)) warnings.push(`layer ${name} is frozen in ${n} viewport(s): after the merge its entities show there (freeze their new layer in those viewports if needed)`);
  }
  const keptOnDefpoints = out.filter((o) => !o.target && o.d.why === 'defpoints').reduce((s, o) => s + o.g.count, 0);
  if (keptOnDefpoints) warnings.push(`${keptOnDefpoints} entities on Defpoints are left there (that layer never plots)`);
  if (ctb === null) warnings.push('no colour-dependent plot style table was read: the weights compared are the lineweights of the objects');

  const allLayers = new Set((survey.layers || []).map((l) => l.name.toLowerCase()));
  const after = new Set([...allLayers].filter((k) => !del.map((d) => d.toLowerCase()).includes(k) && !renames.some((r) => r.from.toLowerCase() === k)));
  for (const r of renames) after.add(r.to.toLowerCase());
  for (const c of create) after.add(c.name.toLowerCase());
  const entities = groups.filter((g) => g.space !== 'block').reduce((s, g) => s + g.count, 0);
  const moved = out.filter((o) => o.target && o.target.name.toLowerCase() !== o.g.layer.toLowerCase()).reduce((s, o) => s + o.g.count, 0);
  return {
    discipline: disc, layers: layersOut.sort((a, b) => b.entities + (b.in_blocks ?? 0) - a.entities - (a.in_blocks ?? 0)), create, props, renames, rules, delete: [...new Set(del)], current: curTo,
    summary: {
      layers_before: allLayers.size, layers_after: after.size, entities, moved, overrides_before: ovBefore, overrides_after: ovAfter, look_kept: lookKept, plot_weight_changes: keepLook ? 0 : weightChanges, plot_dash_changes: keepLook ? 0 : dashChanges,
      by_name: layersOut.filter((l) => l.by === 'name').length, by_content: layersOut.filter((l) => l.by !== 'name' && l.action !== 'keep').length,
    },
    warnings,
  };
}

// ---------------------------------------------------------------- CSV of the mapping

const csvCell = (v, sep) => {
  const s = String(v ?? '');
  return s.includes(sep) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The proposed mapping as CSV: one row per layer; the column "to" is for the user (a layer, "keep" or empty). */
export function planCsv(plan, { sep = ';', lang = 'vi' } = {}) {
  const en = lang === 'en';
  const head = en ? ['layer', 'entities', 'purpose', 'read from', 'action', 'goes to', 'to'] : ['layer', 'so doi tuong', 'muc dich', 'doc tu', 'thao tac', 'chuyen sang', 'to'];
  const rows = [head, ...plan.layers.map((l) => [l.layer, l.entities, l.role ?? '', l.by ?? '', l.action, Object.entries(l.targets).map(([k, v]) => `${k} (${v})`).join(', ') + (l.kept ? ` keep (${l.kept})` : ''), ''])];
  return '﻿' + rows.map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join('\r\n') + '\r\n';
}

/** The user's mapping from that CSV: {layer: to} for the rows whose "to" is filled. */
export function readMappingCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return {};
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = (line) => {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map((h) => h.trim().toLowerCase());
  const iL = head.indexOf('layer'), iT = head.indexOf('to');
  if (iL < 0 || iT < 0) throw new Error('mapping_csv: the first row must name the columns "layer" and "to"');
  const out = {};
  for (const l of lines.slice(1)) {
    const c = split(l);
    const to = (c[iT] ?? '').trim();
    if (to) out[c[iL]] = to;
  }
  return out;
}

/** A company standard from CSV: name;color;linetype;lineweight;plot;role;description (a header row first). */
export function readStandardCsv(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const at = (k) => head.indexOf(k);
  return lines.slice(1).map((l) => {
    const c = l.split(sep).map((x) => x.trim());
    const num = (v) => (v === '' || v === undefined ? undefined : Number(String(v).replace(',', '.')));
    return {
      name: c[at('name')], color: num(c[at('color')]) ?? c[at('color')], linetype: c[at('linetype')] || undefined, lineweight: num(c[at('lineweight')]),
      plot: at('plot') >= 0 ? !/^(0|false|no|khong|không)$/i.test(c[at('plot')] ?? '') : true, role: at('role') >= 0 ? c[at('role')] || undefined : undefined,
      description: at('description') >= 0 ? c[at('description')] : undefined,
    };
  }).filter((s) => s.name);
}
