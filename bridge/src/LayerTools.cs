// Layer standardisation of drawings made by others: layer_survey reads what the drawing holds (its layers, every
// entity grouped by layer, type, colour, linetype, lineweight and block, the block definitions, the plot styles of its
// layouts, the layers frozen in viewports), layer_remap carries out a mapping the server worked out: target layers
// created, whole layers renamed, entities moved by rules (model space, layouts, block definitions, attributes), their
// overrides set or cleared, emptied layers purged. One transaction: one Undo step.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class LayerTools
    {
        static string S(object v) => v == null ? "" : Convert.ToString(v, CultureInfo.InvariantCulture);

        /// <summary>The containers walked: model space, layouts, block definitions (not xrefs, dimension or table blocks).</summary>
        static IEnumerable<(BlockTableRecord btr, string space)> Containers(Database db, Transaction tr)
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            foreach (ObjectId id in bt)
            {
                var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                if (btr.IsErased || btr.IsFromExternalReference || btr.IsDependent) continue;
                if (btr.IsLayout)
                {
                    yield return (btr, btr.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase) ? "model" : "paper");
                    continue;
                }
                // a dimension's or a table's own block is redrawn by AutoCAD from its object: left as it is
                if (btr.IsAnonymous && (btr.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase) || btr.Name.StartsWith("*T", StringComparison.OrdinalIgnoreCase))) continue;
                yield return (btr, "block");
            }
        }

        // ---------------------------------------------------------------- survey

        public static object Survey(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var result = new Dictionary<string, object>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var ltNames = new Dictionary<ObjectId, string>();
                Func<ObjectId, string> ltName = id =>
                {
                    if (id.IsNull) return "";
                    if (!ltNames.TryGetValue(id, out string n)) ltNames[id] = n = ((LinetypeTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name;
                    return n;
                };
                // layers
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var layers = new List<object>();
                foreach (ObjectId id in lt)
                {
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (l.IsErased) continue;
                    var d = new Dictionary<string, object>
                    {
                        { "name", l.Name }, { "color", U.ColOut(l.Color) }, { "linetype", ltName(l.LinetypeObjectId) }, { "lineweight", U.LwOut(l.LineWeight) },
                    };
                    if (!l.IsPlottable) d["plot"] = false;
                    if (l.IsOff) d["on"] = false;
                    if (l.IsFrozen) d["frozen"] = true;
                    if (l.IsLocked) d["locked"] = true;
                    if (l.IsDependent) d["xref"] = true;
                    if (!string.IsNullOrEmpty(l.Description)) d["description"] = l.Description;
                    if (id == db.Clayer) d["current"] = true;
                    try { if (!db.PlotStyleMode && !string.IsNullOrEmpty(l.PlotStyleName)) d["plot_style"] = l.PlotStyleName; } catch (Exception) { }
                    layers.Add(d);
                }
                result["layers"] = layers;

                // entities grouped; block definitions summarised
                var groups = new Dictionary<string, Dictionary<string, object>>();
                var blocks = new List<object>();
                var refs = new Dictionary<string, int>();
                Action<Entity, string, string> add = (e, space, type) =>
                {
                    object col = U.ColOut(e.Color);
                    string lty = e.Linetype ?? "";
                    object lw = U.LwOut(e.LineWeight);
                    string bname = e is BlockReference br ? U.BlockName(tr, br) : null;
                    string key = space + "\u0001" + e.Layer + "\u0001" + type + "\u0001" + S(col) + "\u0001" + lty + "\u0001" + S(lw) + "\u0001" + (bname ?? "");
                    if (!groups.TryGetValue(key, out var g))
                    {
                        g = new Dictionary<string, object>
                        {
                            { "space", space }, { "layer", e.Layer }, { "type", type }, { "color", col }, { "linetype", lty }, { "lineweight", lw }, { "count", 0 },
                            { "sample", e.Handle.ToString() },
                        };
                        if (bname != null) g["block"] = bname;
                        groups[key] = g;
                    }
                    g["count"] = (int)g["count"] + 1;
                };
                foreach (var (btr, space) in Containers(db, tr))
                {
                    var bl = space == "block" ? new Dictionary<string, int>() : null;
                    var bty = space == "block" ? new Dictionary<string, int>() : null;
                    int n = 0;
                    foreach (ObjectId id in btr)
                    {
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        if (e == null) continue;
                        string type = U.TypeName(e);
                        add(e, space, type);
                        n++;
                        if (bl != null)
                        {
                            bl[e.Layer] = bl.TryGetValue(e.Layer, out int c) ? c + 1 : 1;
                            bty[type] = bty.TryGetValue(type, out int t) ? t + 1 : 1;
                        }
                        if (e is BlockReference br)
                        {
                            string bn = U.BlockName(tr, br);
                            if (space != "block") refs[bn] = refs.TryGetValue(bn, out int r) ? r + 1 : 1;
                            foreach (ObjectId aid in br.AttributeCollection)
                            {
                                var a = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                                if (a != null && !a.IsErased) add(a, space, "ATTRIB");
                            }
                        }
                    }
                    if (bl != null)
                    {
                        var b = new Dictionary<string, object> { { "name", btr.Name }, { "count", n }, { "layers", bl.ToDictionary(k => k.Key, k => (object)k.Value) }, { "types", bty.ToDictionary(k => k.Key, k => (object)k.Value) } };
                        if (btr.IsAnonymous) b["anonymous"] = true;
                        if (btr.IsDynamicBlock) b["dynamic"] = true;
                        if (btr.HasAttributeDefinitions) b["attributes"] = true;
                        blocks.Add(b);
                    }
                }
                foreach (Dictionary<string, object> b in blocks) b["refs"] = refs.TryGetValue((string)b["name"], out int c) ? c : 0;
                result["groups"] = groups.Values.ToList<object>();
                result["blocks"] = blocks;

                // plot styles of the layouts, the layers frozen in viewports
                var layouts = new List<object>();
                var vpFrozen = new Dictionary<string, int>();
                var dict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                foreach (DBDictionaryEntry en in dict)
                {
                    var lay = (Layout)tr.GetObject(en.Value, OpenMode.ForRead);
                    layouts.Add(new Dictionary<string, object> { { "name", lay.LayoutName }, { "style_sheet", lay.CurrentStyleSheet ?? "" }, { "model", lay.ModelType } });
                    if (lay.ModelType) continue;
                    var ps = (BlockTableRecord)tr.GetObject(lay.BlockTableRecordId, OpenMode.ForRead);
                    foreach (ObjectId id in ps)
                    {
                        var vp = tr.GetObject(id, OpenMode.ForRead) as Viewport;
                        if (vp == null) continue;
                        try
                        {
                            foreach (ObjectId fl in vp.GetFrozenLayers())
                            {
                                string nm = ((LayerTableRecord)tr.GetObject(fl, OpenMode.ForRead)).Name;
                                vpFrozen[nm] = vpFrozen.TryGetValue(nm, out int c) ? c + 1 : 1;
                            }
                        }
                        catch (Exception) { }
                    }
                }
                string root = "";
                try { root = Autodesk.AutoCAD.DatabaseServices.HostApplicationServices.Current.RoamableRootFolder ?? ""; } catch (Exception) { }
                result["plot"] = new Dictionary<string, object>
                {
                    { "color_dependent", db.PlotStyleMode }, { "layouts", layouts },
                    { "styles_folder", string.IsNullOrEmpty(root) ? "" : System.IO.Path.Combine(root, "Plotters", "Plot Styles") },
                    { "drawing_folder", string.IsNullOrEmpty(db.Filename) ? "" : System.IO.Path.GetDirectoryName(db.Filename) },
                };
                if (vpFrozen.Count > 0) result["viewport_frozen"] = vpFrozen.ToDictionary(k => k.Key, k => (object)k.Value);
                result["drawing"] = db.Filename ?? "";
                tr.Commit();
            }
            return result;
        }

        // ---------------------------------------------------------------- remap

        class Rule
        {
            public string To;
            public HashSet<string> Space, Type, Block, Color, Linetype, Lineweight;
            public P Set;
            public int Hits;
        }

        static HashSet<string> Set(P r, string key)
        {
            object v = r.Raw(key);
            if (v == null) return null;
            var list = v as List<object> ?? new List<object> { v };
            return new HashSet<string>(list.Select(x => S(x).ToLowerInvariant()));
        }

        static bool In(HashSet<string> s, string v) => s == null || s.Contains((v ?? "").ToLowerInvariant());

        /// <summary>
        /// layer_remap {create: [{name, color, linetype, lineweight, plot, description}], props: [the same, for layers
        /// that exist: their properties set], renames: [{from, to}], rules: [{from, to, space, type, block, color,
        /// linetype, lineweight, set: {color, linetype, lineweight}}] (the first rule of the entity's layer that
        /// matches wins), delete: [layers purged when nothing uses them any more], current: the layer made current
        /// when the current one is deleted}.
        /// </summary>
        public static object Remap(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var created = new List<string>();
            var renamed = new List<object>();
            var deleted = new List<string>();
            var kept = new List<object>();
            var unlocked = new List<string>();
            int moved = 0, changed = 0, failed = 0, anon = 0;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                // the target layers
                foreach (var spec in new[] { "create", "props" })
                {
                    var list = p.List(spec);
                    if (list == null) continue;
                    for (int i = 0; i < list.Count; i++)
                    {
                        var s = new P(list[i], spec + "[" + i + "]");
                        string name = s.Str("name");
                        if (string.IsNullOrEmpty(name)) throw new McpError(spec + "[" + i + "].name is required");
                        if (lt.Has(name))
                        {
                            if (spec == "props")
                            {
                                var l = (LayerTableRecord)tr.GetObject(lt[name], OpenMode.ForWrite);
                                U.ApplyLayerStyle(db, tr, l, s);
                                // the name spelt as given (layer names are the same whatever their case)
                                if (!l.IsDependent && l.Name != name && l.Name.Equals(name, StringComparison.OrdinalIgnoreCase) && l.Name != "0") l.Name = name;
                            }
                            continue;
                        }
                        U.EnsureLayer(db, tr, name, new P(new Dictionary<string, object> { { name, s.D } }, spec), created);
                    }
                }
                // whole layers renamed (their viewport overrides and states go with them)
                var rn = p.List("renames");
                if (rn != null)
                {
                    for (int i = 0; i < rn.Count; i++)
                    {
                        var r = new P(rn[i], "renames[" + i + "]");
                        string from = r.Str("from"), to = r.Str("to");
                        if (!lt.Has(from)) { kept.Add(new Dictionary<string, object> { { "layer", from }, { "why", "no such layer" } }); continue; }
                        if (lt.Has(to)) throw new McpError("renames[" + i + "]: layer '" + to + "' exists: merge with a rule instead");
                        var l = (LayerTableRecord)tr.GetObject(lt[from], OpenMode.ForWrite);
                        if (l.IsDependent || from == "0" || from.Equals("Defpoints", StringComparison.OrdinalIgnoreCase)) throw new McpError("renames[" + i + "]: '" + from + "' cannot be renamed");
                        l.Name = to;
                        if (r.Obj("props") != null) U.ApplyLayerStyle(db, tr, l, r.Obj("props"));
                        renamed.Add(new Dictionary<string, object> { { "from", from }, { "to", to } });
                    }
                }
                // rules by layer
                var rules = new Dictionary<string, List<Rule>>(StringComparer.OrdinalIgnoreCase);
                var rl = p.List("rules") ?? new List<object>();
                var all = new List<Rule>();
                for (int i = 0; i < rl.Count; i++)
                {
                    var r = new P(rl[i], "rules[" + i + "]");
                    string from = r.Str("from") ?? throw new McpError("rules[" + i + "].from is required");
                    var rule = new Rule
                    {
                        To = r.Str("to"), Space = Set(r, "space"), Type = Set(r, "type"), Block = Set(r, "block"), Color = Set(r, "color"),
                        Linetype = Set(r, "linetype"), Lineweight = Set(r, "lineweight"), Set = r.Obj("set"),
                    };
                    if (rule.To != null && !lt.Has(rule.To)) throw new McpError("rules[" + i + "].to: no layer '" + rule.To + "' (give it in create)");
                    if (!rules.TryGetValue(from, out var lst)) rules[from] = lst = new List<Rule>();
                    lst.Add(rule);
                    all.Add(rule);
                }
                // the layers touched are unlocked while their entities change, and locked again after
                var relock = new List<ObjectId>();
                foreach (ObjectId id in lt)
                {
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (!l.IsLocked) continue;
                    bool touched = rules.ContainsKey(l.Name) || all.Any(r => r.To != null && r.To.Equals(l.Name, StringComparison.OrdinalIgnoreCase));
                    if (!touched) continue;
                    l.UpgradeOpen();
                    l.IsLocked = false;
                    relock.Add(id);
                    unlocked.Add(l.Name);
                }
                var layerIds = new Dictionary<string, ObjectId>(StringComparer.OrdinalIgnoreCase);
                Func<string, ObjectId> layerId = n =>
                {
                    if (!layerIds.TryGetValue(n, out var id)) layerIds[n] = id = lt[n];
                    return id;
                };
                Func<Entity, string, string, string, Rule> match = (e, space, type, block) =>
                {
                    if (!rules.TryGetValue(e.Layer, out var lst)) return null;
                    string col = S(U.ColOut(e.Color)), lty = e.Linetype ?? "", lw = S(U.LwOut(e.LineWeight));
                    foreach (var r in lst)
                        if (In(r.Space, space) && In(r.Type, type) && In(r.Block, block) && In(r.Color, col) && In(r.Linetype, lty) && In(r.Lineweight, lw)) return r;
                    return null;
                };
                Action<Entity, Rule> apply = (e, r) =>
                {
                    try
                    {
                        if (!e.IsWriteEnabled) e.UpgradeOpen();
                        if (r.To != null && !r.To.Equals(e.Layer, StringComparison.OrdinalIgnoreCase)) { e.LayerId = layerId(r.To); moved++; }
                        if (r.Set != null)
                        {
                            if (r.Set.Has("color")) e.Color = U.Col(r.Set.Raw("color"), "set.color");
                            if (r.Set.Has("linetype")) e.Linetype = r.Set.Str("linetype").Equals("bylayer", StringComparison.OrdinalIgnoreCase) ? "ByLayer"
                                : r.Set.Str("linetype").Equals("byblock", StringComparison.OrdinalIgnoreCase) ? "ByBlock" : r.Set.Str("linetype");
                            if (r.Set.Has("lineweight")) e.LineWeight = U.Lw(r.Set.Raw("lineweight"), "set.lineweight");
                            changed++;
                        }
                        r.Hits++;
                    }
                    catch (Exception) { failed++; }
                };
                foreach (var (btr, space) in Containers(db, tr))
                {
                    foreach (ObjectId id in btr)
                    {
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        if (e == null) continue;
                        string type = U.TypeName(e);
                        string block = e is BlockReference br0 ? U.BlockName(tr, br0) : null;
                        string before = e.Layer;
                        var r = match(e, space, type, block);
                        if (r != null) apply(e, r);
                        if (e is BlockReference br)
                        {
                            // attributes on the layer of their insert go with it; the others by their own rules
                            foreach (ObjectId aid in br.AttributeCollection)
                            {
                                var a = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                                if (a == null || a.IsErased) continue;
                                if (r != null && a.Layer.Equals(before, StringComparison.OrdinalIgnoreCase)) { apply(a, r); continue; }
                                var ra = match(a, space, "ATTRIB", null);
                                if (ra != null) apply(a, ra);
                            }
                        }
                    }
                }
                // emptied layers purged; what the blocks of dimensions and tables (redrawn by AutoCAD from their object)
                // still hold on them goes to layer 0, where it takes the properties of its dimension
                var del = p.List("delete");
                if (del != null && del.Count > 0)
                {
                    var going = new HashSet<string>(del.Select(o => S(o)), StringComparer.OrdinalIgnoreCase);
                    var bt0 = (BlockTableRecord)null;
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    ObjectId zero = lt["0"];
                    foreach (ObjectId bid in bt)
                    {
                        bt0 = (BlockTableRecord)tr.GetObject(bid, OpenMode.ForRead);
                        if (!bt0.IsAnonymous || bt0.IsFromExternalReference || !(bt0.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase) || bt0.Name.StartsWith("*T", StringComparison.OrdinalIgnoreCase))) continue;
                        foreach (ObjectId id in bt0)
                        {
                            var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                            if (e == null || !going.Contains(e.Layer)) continue;
                            try { e.UpgradeOpen(); e.LayerId = zero; anon++; } catch (Exception) { failed++; }
                        }
                    }
                    var ids = new ObjectIdCollection();
                    var byId = new Dictionary<ObjectId, string>();
                    foreach (object o in del)
                    {
                        string n = S(o);
                        if (!lt.Has(n)) continue;
                        ObjectId id = lt[n];
                        if (n == "0" || n.Equals("Defpoints", StringComparison.OrdinalIgnoreCase)) { kept.Add(new Dictionary<string, object> { { "layer", n }, { "why", "a layer AutoCAD keeps" } }); continue; }
                        if (id == db.Clayer)
                        {
                            string cur = p.Str("current");
                            db.Clayer = !string.IsNullOrEmpty(cur) && lt.Has(cur) ? lt[cur] : lt["0"];
                        }
                        ids.Add(id);
                        byId[id] = n;
                    }
                    var free = new ObjectIdCollection();
                    foreach (ObjectId id in ids) free.Add(id);
                    db.Purge(free);
                    var freeSet = new HashSet<ObjectId>(free.Cast<ObjectId>());
                    foreach (var kv in byId)
                    {
                        if (freeSet.Contains(kv.Key))
                        {
                            var l = (LayerTableRecord)tr.GetObject(kv.Key, OpenMode.ForWrite);
                            l.Erase();
                            deleted.Add(kv.Value);
                        }
                        else kept.Add(new Dictionary<string, object> { { "layer", kv.Value }, { "why", "still used (an xref, a dimension or table block, a layer state or a filter)" } });
                    }
                }
                foreach (ObjectId id in relock)
                {
                    if (id.IsErased) continue;
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                    l.IsLocked = true;
                }
                tr.Commit();
                var hits = all.Select(r => (object)r.Hits).ToList();
                var res = new Dictionary<string, object>
                {
                    { "moved", moved }, { "overrides_set", changed }, { "created", created }, { "renamed", renamed }, { "deleted", deleted }, { "rule_hits", hits },
                };
                if (kept.Count > 0) res["kept"] = kept;
                if (unlocked.Count > 0) res["relocked"] = unlocked;
                if (failed > 0) res["failed"] = failed;
                if (anon > 0) res["dimension_block_entities"] = anon;
                return res;
            }
        }
    }
}
