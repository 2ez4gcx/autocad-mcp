// Command table and the read / edit commands. Lengths are in drawing units (normally mm), areas in m², angles in degrees.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Commands
    {
        public static readonly Dictionary<string, Command> Table = new Dictionary<string, Command>();

        static void Reg(string name, Mode mode, CommandFn fn) { Table[name] = new Command { Name = name, Mode = mode, Fn = fn }; }

        static Commands()
        {
            Reg("ping", Mode.Session, Ping);
            Reg("drawing_info", Mode.Read, DrawingInfo);
            Reg("list_layers", Mode.Read, ListLayers);
            Reg("list_blocks", Mode.Read, ListBlocks);
            Reg("query_entities", Mode.Read, QueryEntities);
            Reg("selection_info", Mode.Read, SelectionInfo);
            Reg("quantity_takeoff", Mode.Read, Takeoff.Quantity);
            Reg("check_drawing", Mode.Read, Takeoff.Check);
            Reg("draw_entities", Mode.Write, DrawEntities);
            Reg("draw_plan", Mode.Write, Plan.DrawPlan);
            Reg("define_block", Mode.Write, DefineBlock);
            Reg("define_blocks", Mode.Write, DefineBlocks);
            Reg("transform_entities", Mode.Write, Transform);
            Reg("set_properties", Mode.Write, SetProperties);
            Reg("delete_entities", Mode.Write, Delete);
            Reg("select_entities", Mode.Read, Select);
            Reg("setup_layers", Mode.Write, SetupLayers);
            Reg("setup_styles", Mode.Write, Styles.Setup);
            Reg("purge_drawing", Mode.Write, Purge);
            Table["purge_drawing"].ModeFor = p => p.Bool("dry_run", false) ? Mode.Read : Mode.Write;
            Reg("undo", Mode.CommandContext, Undo);
            Reg("run_lisp", Mode.Lisp, null);
            Reg("set_view", Mode.Write, Media.SetView);
            Reg("screenshot", Mode.App, Media.Screenshot);
            Reg("view_image", Mode.Session, Media.ViewImage);
            Reg("attach_image", Mode.Write, Media.AttachImage);
            Reg("image_info", Mode.Read, Media.ImageInfo);
            Reg("import_drawing", Mode.Write, Media.ImportDrawing);
            Reg("create_layout", Mode.Write, Sheets.CreateLayout);
            Reg("export_pdf", Mode.App, Sheets.ExportPdf);
            Reg("save_drawing", Mode.App, Media.Save);
            Reg("open_drawing", Mode.App, Media.Open);
            Reg("new_drawing", Mode.Session, Media.New);
        }

        // ---------------------------------------------------------------- read

        static string AcadYear(string acadver)
        {
            var m = Regex.Match(acadver ?? "", @"^(\d+)\.(\d+)");
            if (!m.Success) return acadver;
            int major = int.Parse(m.Groups[1].Value), minor = int.Parse(m.Groups[2].Value);
            if (major == 24) return (2021 + minor).ToString();
            if (major == 25) return (2025 + minor).ToString();
            if (major == 26) return (2027 + minor).ToString();
            if (major == 23) return (2019 + minor).ToString();
            return acadver;
        }

        static object Ping(Ctx ctx, P p)
        {
            string ver = Convert.ToString(AcApp.GetSystemVariable("ACADVER"));
            var r = new Dictionary<string, object>
            {
                { "autocad", AcadYear(ver) }, { "acadver", ver }, { "product", Convert.ToString(AcApp.GetSystemVariable("PRODUCT")) },
                { "bridge", Bridge.VERSION }, { "dotnet", Environment.Version.ToString() }, { "port", Settings.Port },
                { "drawings_open", AcApp.DocumentManager.Count },
            };
            if (ctx.Doc != null)
            {
                r["drawing"] = Path.GetFileName(ctx.Doc.Name);
                r["path"] = ctx.Doc.Name;
                if (!ctx.Doc.Editor.IsQuiescent) r["busy_command"] = ctx.Doc.CommandInProgress;
            }
            return r;
        }

        /// <summary>Entities of the requested space(s): "model" (default), "paper" (all layouts), "all", "current" or a layout name.</summary>
        public static IEnumerable<ObjectId> SpaceIds(Database db, Transaction tr, string which)
        {
            which = string.IsNullOrEmpty(which) ? "model" : which;
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            var spaces = new List<ObjectId>();
            if (which == "current") spaces.Add(db.CurrentSpaceId);
            else
            {
                foreach (ObjectId id in bt)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (!btr.IsLayout) continue;
                    bool model = btr.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase);
                    if (which == "all" || (which == "model" && model) || (which == "paper" && !model)) spaces.Add(id);
                    else if (!model && which != "model" && which != "paper")
                    {
                        var lay = (Layout)tr.GetObject(btr.LayoutId, OpenMode.ForRead);
                        if (lay.LayoutName.Equals(which, StringComparison.OrdinalIgnoreCase)) spaces.Add(id);
                    }
                }
                if (spaces.Count == 0) throw new McpError("space must be model, paper, all, current or a layout name");
            }
            foreach (ObjectId sid in spaces)
            {
                var btr = (BlockTableRecord)tr.GetObject(sid, OpenMode.ForRead);
                foreach (ObjectId id in btr) yield return id;
            }
        }

        static object DrawingInfo(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var r = new Dictionary<string, object>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                r["name"] = Path.GetFileName(ctx.Doc.Name);
                r["path"] = ctx.Doc.Name;
                r["saved_to_file"] = File.Exists(ctx.Doc.Name);
                r["units"] = U.UnitName(db);
                if (db.Insunits == UnitsValue.Undefined) r["units_note"] = "INSUNITS is unitless: lengths are treated as mm.";
                // Computed from the visible model-space objects (EXTMIN/EXTMAX are only updated on a regen).
                Extents3d? ext = U.SpaceExtents(db, tr, U.ModelSpace(db, tr, OpenMode.ForRead).ObjectId);
                r["extents"] = ext == null ? null : U.BoundsOut(ext);
                r["ltscale"] = db.Ltscale;
                var dst = (DimStyleTableRecord)tr.GetObject(db.Dimstyle, OpenMode.ForRead);
                r["current"] = new Dictionary<string, object>
                {
                    { "layer", U.LayerName(tr, db.Clayer) },
                    { "text_style", ((TextStyleTableRecord)tr.GetObject(db.Textstyle, OpenMode.ForRead)).Name },
                    { "dim_style", dst.Name }, { "dimscale", dst.Dimscale },
                    { "space", db.TileMode ? "model" : "paper" }, { "layout", LayoutManager.Current.CurrentLayout },
                };
                var byType = new Dictionary<string, int>();
                int n = 0;
                foreach (ObjectId id in SpaceIds(db, tr, "model"))
                {
                    n++;
                    string t = id.ObjectClass.DxfName;
                    byType[t] = byType.TryGetValue(t, out int c) ? c + 1 : 1;
                }
                r["model_space_entities"] = n;
                r["by_type"] = byType.OrderByDescending(kv => kv.Value).ToDictionary(kv => kv.Key, kv => (object)kv.Value);
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                r["layers"] = lt.Cast<ObjectId>().Count();
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                int blocks = 0, xrefs = 0;
                var layouts = new List<object>();
                foreach (ObjectId id in bt)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (btr.IsLayout)
                    {
                        if (!btr.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase))
                            layouts.Add(((Layout)tr.GetObject(btr.LayoutId, OpenMode.ForRead)).LayoutName);
                    }
                    else if (btr.IsFromExternalReference) xrefs++;
                    else if (!btr.IsAnonymous) blocks++;
                }
                r["blocks"] = blocks;
                r["xrefs"] = xrefs;
                r["layouts"] = layouts;
                var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                r["text_styles"] = tst.Cast<ObjectId>().Select(i => ((TextStyleTableRecord)tr.GetObject(i, OpenMode.ForRead)))
                    .Where(t => !t.IsShapeFile && t.Name != "").Select(t => (object)t.Name).ToList();
                var ds = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
                r["dim_styles"] = ds.Cast<ObjectId>().Select(i => (object)((DimStyleTableRecord)tr.GetObject(i, OpenMode.ForRead)).Name).ToList();
                r["drawings_open"] = AcApp.DocumentManager.Count;
            }
            return r;
        }

        static object ListLayers(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var rows = new List<object>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var counts = new Dictionary<ObjectId, int>();
                foreach (ObjectId id in SpaceIds(db, tr, "all"))
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    counts[e.LayerId] = counts.TryGetValue(e.LayerId, out int c) ? c + 1 : 1;
                }
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                foreach (ObjectId id in lt)
                {
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (l.IsErased) continue;
                    var d = new Dictionary<string, object>
                    {
                        { "name", l.Name }, { "color", U.ColOut(l.Color) },
                        { "linetype", ((LinetypeTableRecord)tr.GetObject(l.LinetypeObjectId, OpenMode.ForRead)).Name },
                        { "lineweight", U.LwOut(l.LineWeight) }, { "count", counts.TryGetValue(id, out int c) ? c : 0 },
                    };
                    if (l.IsOff) d["on"] = false;
                    if (l.IsFrozen) d["frozen"] = true;
                    if (l.IsLocked) d["locked"] = true;
                    if (!l.IsPlottable) d["plot"] = false;
                    if (!string.IsNullOrEmpty(l.Description)) d["description"] = l.Description;
                    if (l.Transparency.IsByAlpha && l.Transparency.Alpha < 255) d["transparency"] = (int)Math.Round(100 * (1 - l.Transparency.Alpha / 255.0));
                    if (id == db.Clayer) d["current"] = true;
                    if (l.IsDependent) d["xref"] = true;
                    rows.Add(d);
                }
            }
            return new Dictionary<string, object> { { "count", rows.Count }, { "layers", rows } };
        }

        static object ListBlocks(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var rows = new List<object>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId id in bt)
                {
                    var btr = (BlockTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    if (btr.IsLayout || btr.IsAnonymous || btr.Name.StartsWith("_")) continue;
                    int count = btr.GetBlockReferenceIds(true, false).Count;
                    if (btr.IsDynamicBlock)
                        foreach (ObjectId aid in btr.GetAnonymousBlockIds())
                            count += ((BlockTableRecord)tr.GetObject(aid, OpenMode.ForRead)).GetBlockReferenceIds(true, false).Count;
                    if (!p.Bool("include_unused", true) && count == 0) continue;
                    var tags = new List<object>();
                    int ents = 0;
                    foreach (ObjectId eid in btr)
                    {
                        ents++;
                        if (eid.ObjectClass.DxfName == "ATTDEF") tags.Add(((AttributeDefinition)tr.GetObject(eid, OpenMode.ForRead)).Tag);
                    }
                    var d = new Dictionary<string, object> { { "name", btr.Name }, { "count", count }, { "entities", ents } };
                    if (tags.Count > 0) d["attributes"] = tags;
                    if (btr.IsDynamicBlock) d["dynamic"] = true;
                    if (btr.IsFromExternalReference) { d["xref"] = true; d["path"] = btr.PathName; d["resolved"] = btr.IsResolved; }
                    if (!string.IsNullOrEmpty(btr.Comments)) d["description"] = btr.Comments;
                    rows.Add(d);
                }
            }
            rows = rows.OrderByDescending(r => (int)((Dictionary<string, object>)r)["count"]).ToList();
            return new Dictionary<string, object> { { "count", rows.Count }, { "blocks", rows } };
        }

        static readonly Dictionary<string, string> TypeAlias = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "polyline", "LWPOLYLINE" }, { "pline", "LWPOLYLINE" }, { "block", "INSERT" }, { "dim", "DIMENSION" },
            { "leader", "MULTILEADER" }, { "mleader", "MULTILEADER" }, { "image", "IMAGE" }, { "rectangle", "LWPOLYLINE" },
        };

        static Regex Wild(string pattern)
        {
            return new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase);
        }

        /// <summary>Filter shared by query_entities, quantity_takeoff and check_drawing.</summary>
        public class Filter
        {
            HashSet<string> _types;
            List<Regex> _layers, _blocks;
            string _text;
            Extents3d? _win;
            bool _inside;
            HashSet<ObjectId> _ids;

            public Filter(Database db, P p)
            {
                var types = p.Strings("types");
                if (types != null && types.Count > 0)
                    _types = new HashSet<string>(types.Select(t => TypeAlias.TryGetValue(t, out string a) ? a : t.ToUpperInvariant()));
                var layers = p.Strings("layers");
                if (layers != null && layers.Count > 0) _layers = layers.Select(Wild).ToList();
                var blocks = p.Strings("block_names");
                if (blocks != null && blocks.Count > 0) _blocks = blocks.Select(Wild).ToList();
                _text = p.Str("text_contains");
                if (p.Has("window"))
                {
                    var w = U.PtList(p.Raw("window"), "window");
                    if (w.Count != 2) throw new McpError("window must be [[x1,y1],[x2,y2]]");
                    var e = new Extents3d();
                    e.AddPoint(new Point3d(w[0].X, w[0].Y, -1e9));
                    e.AddPoint(new Point3d(w[1].X, w[1].Y, 1e9));
                    _win = e;
                    _inside = (p.Str("window_mode") ?? "crossing") == "inside";
                }
                if (p.Has("handles")) _ids = new HashSet<ObjectId>(U.Ids(db, p));
            }

            public bool QuickOk(ObjectId id)
            {
                if (_ids != null && !_ids.Contains(id)) return false;
                if (_types != null && !_types.Contains(id.ObjectClass.DxfName)) return false;
                return true;
            }

            public bool Ok(Transaction tr, Entity e)
            {
                if (_layers != null && !_layers.Any(r => r.IsMatch(e.Layer))) return false;
                if (_blocks != null)
                {
                    var br = e as BlockReference;
                    if (br == null || !_blocks.Any(r => r.IsMatch(U.BlockName(tr, br)))) return false;
                }
                if (_text != null)
                {
                    string t = e is DBText dt ? dt.TextString : e is MText mt ? mt.Text : null;
                    if (t == null || t.IndexOf(_text, StringComparison.OrdinalIgnoreCase) < 0) return false;
                }
                if (_win != null)
                {
                    Extents3d? x = U.Ext(e);
                    if (x == null) return false;
                    Extents3d w = _win.Value, b = x.Value;
                    bool overlap = b.MinPoint.X <= w.MaxPoint.X && b.MaxPoint.X >= w.MinPoint.X && b.MinPoint.Y <= w.MaxPoint.Y && b.MaxPoint.Y >= w.MinPoint.Y;
                    bool inside = b.MinPoint.X >= w.MinPoint.X && b.MaxPoint.X <= w.MaxPoint.X && b.MinPoint.Y >= w.MinPoint.Y && b.MaxPoint.Y <= w.MaxPoint.Y;
                    if (_inside ? !inside : !overlap) return false;
                }
                return true;
            }
        }

        static object QueryEntities(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            double toM = U.ToMetres(db);
            int limit = Math.Max(0, Math.Min(2000, p.Int("limit", 100))), offset = Math.Max(0, p.Int("offset", 0));
            bool detail = p.Bool("detail", false);
            var f = new Filter(db, p);
            var list = new List<object>();
            int matched = 0;
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                IEnumerable<ObjectId> ids = p.Has("handles") ? U.Ids(db, p) : SpaceIds(db, tr, p.Str("space"));
                foreach (ObjectId id in ids)
                {
                    if (!f.QuickOk(id)) continue;
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || !f.Ok(tr, e)) continue;
                    if (matched >= offset && list.Count < limit) list.Add(U.Info(tr, e, detail, toM));
                    matched++;
                }
            }
            var r = new Dictionary<string, object> { { "matched", matched }, { "returned", list.Count }, { "entities", list } };
            if (matched > offset + list.Count) r["next_offset"] = offset + list.Count;
            return r;
        }

        static object SelectionInfo(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            PromptSelectionResult sel = ctx.Ed.SelectImplied();
            var r = new Dictionary<string, object>();
            if (sel.Status != PromptStatus.OK || sel.Value == null)
            {
                r["count"] = 0;
                r["note"] = "Nothing is selected in AutoCAD (select objects first, with PICKFIRST on).";
                return r;
            }
            ObjectId[] ids = sel.Value.GetObjectIds();
            int limit = p.Int("limit", 200);
            var list = new List<object>();
            var byType = new Dictionary<string, int>();
            var byLayer = new Dictionary<string, int>();
            Extents3d? all = null;
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                foreach (ObjectId id in ids)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    string t = U.TypeName(e);
                    byType[t] = byType.TryGetValue(t, out int c) ? c + 1 : 1;
                    byLayer[e.Layer] = byLayer.TryGetValue(e.Layer, out int c2) ? c2 + 1 : 1;
                    U.Grow(ref all, U.Ext(e));
                    if (list.Count < limit) list.Add(U.Info(tr, e, p.Bool("detail", false), U.ToMetres(db)));
                }
            }
            r["count"] = ids.Length;
            r["by_type"] = byType;
            r["by_layer"] = byLayer;
            r["bounds"] = U.BoundsOut(all);
            r["entities"] = list;
            return r;
        }

        // ---------------------------------------------------------------- draw / edit

        static object DrawEntities(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var specs = p.List("entities");
            if (specs == null || specs.Count == 0) throw new McpError("entities is required (a list of entity specs)");
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                // Model space by default: after create_layout the current space may be a layout.
                BlockTableRecord space = p.Str("space") == "current" ? U.CurrentSpace(db, tr, OpenMode.ForWrite) : U.ModelSpace(db, tr, OpenMode.ForWrite);
                var dr = new Drawer(db, tr, space, p.Obj("layer_styles"));
                var results = dr.DrawAll(specs, "entities");
                tr.Commit();
                var r = new Dictionary<string, object> { { "count", dr.Count }, { "results", results }, { "bounds", U.BoundsOut(dr.Bounds) } };
                if (dr.CreatedLayers.Count > 0) r["created_layers"] = dr.CreatedLayers;
                return r;
            }
        }

        static object DefineBlock(Ctx ctx, P p)
        {
            using (Transaction tr = ctx.Db.TransactionManager.StartTransaction())
            {
                var r = DefineOne(ctx.Db, tr, p, false);
                tr.Commit();
                return r;
            }
        }

        /// <summary>Block definitions of symbols and furniture: {blocks: [{name, entities, attributes, ...}]}; those already in the drawing are kept unless replace.</summary>
        static object DefineBlocks(Ctx ctx, P p)
        {
            var list = p.List("blocks") ?? new List<object>();
            var defined = new List<object>();
            var kept = new List<object>();
            // the text style the attributes and labels use, made only when the drawing does not have it yet
            P st = p.Obj("styles");
            P ts = st?.Obj("text_style");
            if (ts != null)
            {
                bool has;
                using (Transaction tr0 = ctx.Db.TransactionManager.StartTransaction())
                {
                    has = ((TextStyleTable)tr0.GetObject(ctx.Db.TextStyleTableId, OpenMode.ForRead)).Has(ts.Str("name") ?? "MCP-ARIAL");
                    tr0.Commit();
                }
                if (!has) Styles.Setup(ctx, st);
            }
            using (Transaction tr = ctx.Db.TransactionManager.StartTransaction())
            {
                var bt = (BlockTable)tr.GetObject(ctx.Db.BlockTableId, OpenMode.ForRead);
                for (int i = 0; i < list.Count; i++)
                {
                    var b = new P(list[i], "blocks[" + i + "]");
                    string name = b.ReqStr("name");
                    if (bt.Has(name) && !b.Bool("replace", false)) { kept.Add(name); continue; }
                    DefineOne(ctx.Db, tr, b, true);
                    defined.Add(name);
                }
                tr.Commit();
            }
            return new Dictionary<string, object> { { "defined", defined }, { "kept", kept } };
        }

        static Dictionary<string, object> DefineOne(Database db, Transaction tr, P p, bool replaceOk)
        {
            string name = p.ReqStr("name");
            try { SymbolUtilityServices.ValidateSymbolName(name, false); }
            catch (Exception) { throw new McpError("Invalid block name '" + name + "'"); }
            var specs = p.List("entities");
            if (specs == null || specs.Count == 0) throw new McpError("entities is required");
            {
                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                BlockTableRecord btr;
                bool existed = bt.Has(name);
                if (existed)
                {
                    if (!replaceOk && !p.Bool("replace", false)) throw new McpError("Block '" + name + "' already exists (pass replace=true to redefine it; its references update)");
                    btr = (BlockTableRecord)tr.GetObject(bt[name], OpenMode.ForWrite);
                    if (btr.IsLayout || btr.IsFromExternalReference) throw new McpError("'" + name + "' is a layout or xref");
                    foreach (ObjectId id in btr) tr.GetObject(id, OpenMode.ForWrite).Erase();
                }
                else
                {
                    btr = new BlockTableRecord { Name = name };
                    bt.UpgradeOpen();
                    bt.Add(btr);
                    tr.AddNewlyCreatedDBObject(btr, true);
                }
                btr.Origin = p.Has("base") ? U.Pt(p, "base") : Point3d.Origin;
                if (p.Has("description")) btr.Comments = p.Str("description");
                // Block contents go on layer 0 unless told otherwise, so they take the layer of each insert.
                foreach (object o in specs)
                    if (o is Dictionary<string, object> d && !d.ContainsKey("layer")) d["layer"] = "0";
                var dr = new Drawer(db, tr, btr, p.Obj("layer_styles"));
                dr.DrawAll(specs, "entities");
                var attrs = p.List("attributes");
                if (attrs != null)
                {
                    for (int i = 0; i < attrs.Count; i++)
                    {
                        var a = new P(attrs[i], "attributes[" + i + "]");
                        var ad = new AttributeDefinition();
                        ad.SetDatabaseDefaults(db);
                        ad.Tag = a.ReqStr("tag").ToUpperInvariant().Replace(" ", "_");
                        ad.Prompt = a.Str("prompt") ?? ad.Tag;
                        ad.TextString = a.Str("default") ?? "";
                        if (a.Has("style")) ad.TextStyleId = U.TextStyle(db, tr, a.Str("style"));
                        ad.Height = a.Num("height", 2.5);
                        ad.Position = U.Pt(a, "at");
                        ad.Invisible = a.Bool("invisible", false);
                        ad.LayerId = U.EnsureLayer(db, tr, a.Str("layer") ?? "0", null, null);
                        string al = a.Str("align");
                        var just = new Dictionary<string, AttachmentPoint>
                        {
                            { "center", AttachmentPoint.BaseCenter }, { "middle_center", AttachmentPoint.MiddleCenter },
                            { "middle_left", AttachmentPoint.MiddleLeft }, { "middle_right", AttachmentPoint.MiddleRight }, { "right", AttachmentPoint.BaseRight },
                        };
                        if (al != null && just.ContainsKey(al))
                        {
                            ad.Justify = just[al];
                            ad.AlignmentPoint = ad.Position;
                        }
                        if (a.Has("rotation")) ad.Rotation = U.Rad(a.Num("rotation", 0));
                        ad.LockPositionInBlock = true;
                        btr.AppendEntity(ad);
                        tr.AddNewlyCreatedDBObject(ad, true);
                        if (ad.Justify != AttachmentPoint.BaseLeft) ad.AdjustAlignment(db);
                    }
                }
                return new Dictionary<string, object>
                {
                    { "name", name }, { "redefined", existed }, { "entities", dr.Count }, { "attributes", attrs == null ? 0 : attrs.Count },
                    { "note", existed ? "Existing references now show the new definition." : "Insert it with draw_entities type=block name=" + name },
                };
            }
        }

        /// <summary>Deep-clones entities into their own space (keeps attributes, nested data) and returns the copies.</summary>
        static List<Entity> CloneAll(Database db, Transaction tr, List<ObjectId> ids)
        {
            var copies = new List<Entity>();
            foreach (var group in ids.GroupBy(i => tr.GetObject(i, OpenMode.ForRead).OwnerId))
            {
                var map = new IdMapping();
                db.DeepCloneObjects(new ObjectIdCollection(group.ToArray()), group.Key, map, false);
                foreach (ObjectId src in group)
                {
                    IdPair pair = map[src];
                    if (pair.IsCloned) copies.Add((Entity)tr.GetObject(pair.Value, OpenMode.ForWrite));
                }
            }
            return copies;
        }

        static object Transform(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string op = p.ReqStr("op").ToLowerInvariant();
            List<ObjectId> ids = U.Ids(db, p);
            var created = new List<object>();
            Extents3d? box = null;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var ents = ids.Select(id => (Entity)tr.GetObject(id, OpenMode.ForWrite)).ToList();
                foreach (var e in ents)
                {
                    var lay = (LayerTableRecord)tr.GetObject(e.LayerId, OpenMode.ForRead);
                    if (lay.IsLocked) throw new McpError("Entity " + e.Handle + " is on locked layer '" + lay.Name + "' (unlock it with setup_layers)");
                }
                Func<Vector3d> vec = () =>
                {
                    if (p.Has("vector")) { Point3d v = U.Pt(p, "vector"); return v - Point3d.Origin; }
                    return U.Pt(p, "to") - U.Pt(p, "from");
                };
                Action<IEnumerable<Entity>> track = es => { foreach (var x in es) U.Grow(ref box, U.Ext(x)); };
                switch (op)
                {
                    case "move":
                        {
                            Matrix3d m = Matrix3d.Displacement(vec());
                            foreach (var e in ents) e.TransformBy(m);
                            track(ents);
                            break;
                        }
                    case "rotate":
                        {
                            Matrix3d m = Matrix3d.Rotation(U.Rad(p.ReqNum("angle")), Vector3d.ZAxis, U.Pt(p, "center"));
                            foreach (var e in ents) e.TransformBy(m);
                            track(ents);
                            break;
                        }
                    case "scale":
                        {
                            double f = p.ReqNum("factor");
                            if (f <= 0) throw new McpError("factor must be > 0");
                            Matrix3d m = Matrix3d.Scaling(f, U.Pt(p, "base"));
                            foreach (var e in ents) e.TransformBy(m);
                            track(ents);
                            break;
                        }
                    case "mirror":
                        {
                            Point3d a = U.Pt(p, "from"), b = U.Pt(p, "to");
                            if (a.DistanceTo(b) < 1e-9) throw new McpError("from and to must differ (mirror line)");
                            Matrix3d m = Matrix3d.Mirroring(new Line3d(a, b));
                            var targets = p.Bool("keep_original", true) ? CloneAll(db, tr, ids) : ents;
                            foreach (var e in targets) e.TransformBy(m);
                            if (p.Bool("keep_original", true)) created.AddRange(targets.Select(e => (object)e.Handle.ToString()));
                            track(targets);
                            break;
                        }
                    case "copy":
                        {
                            Vector3d v = vec();
                            int count = Math.Max(1, p.Int("count", 1));
                            for (int k = 1; k <= count; k++)
                            {
                                var cs = CloneAll(db, tr, ids);
                                foreach (var e in cs) e.TransformBy(Matrix3d.Displacement(v * k));
                                created.AddRange(cs.Select(e => (object)e.Handle.ToString()));
                                track(cs);
                            }
                            break;
                        }
                    case "array_rect":
                        {
                            int rows = Math.Max(1, p.Int("rows", 1)), cols = Math.Max(1, p.Int("cols", 1));
                            double dy = p.Num("row_spacing", 0), dx = p.Num("col_spacing", 0);
                            for (int r = 0; r < rows; r++)
                                for (int c = 0; c < cols; c++)
                                {
                                    if (r == 0 && c == 0) continue;
                                    var cs = CloneAll(db, tr, ids);
                                    foreach (var e in cs) e.TransformBy(Matrix3d.Displacement(new Vector3d(c * dx, r * dy, 0)));
                                    created.AddRange(cs.Select(e => (object)e.Handle.ToString()));
                                    track(cs);
                                }
                            break;
                        }
                    case "array_polar":
                        {
                            int count = Math.Max(2, p.Int("count", 4));
                            double total = p.Num("angle", 360);
                            Point3d c0 = U.Pt(p, "center");
                            double step = Math.Abs(Math.Abs(total) - 360) < 1e-9 ? total / count : total / (count - 1);
                            bool rotateItems = p.Bool("rotate_items", true);
                            for (int k = 1; k < count; k++)
                            {
                                var cs = CloneAll(db, tr, ids);
                                foreach (var e in cs)
                                {
                                    if (rotateItems) e.TransformBy(Matrix3d.Rotation(U.Rad(step * k), Vector3d.ZAxis, c0));
                                    else
                                    {
                                        Extents3d? x = U.Ext(e);
                                        Point3d ctr = x == null ? c0 : new Point3d((x.Value.MinPoint.X + x.Value.MaxPoint.X) / 2, (x.Value.MinPoint.Y + x.Value.MaxPoint.Y) / 2, 0);
                                        e.TransformBy(Matrix3d.Displacement(ctr.RotateBy(U.Rad(step * k), Vector3d.ZAxis, c0) - ctr));
                                    }
                                }
                                created.AddRange(cs.Select(e => (object)e.Handle.ToString()));
                                track(cs);
                            }
                            break;
                        }
                    case "offset":
                        {
                            double d = p.ReqNum("distance");
                            Point3d? toward = U.OptPt(p, "toward");
                            bool both = p.Bool("both_sides", false);
                            foreach (var e in ents)
                            {
                                var cv = e as Curve;
                                if (cv == null) throw new McpError("offset needs curves (line, polyline, arc, circle...); " + e.Handle + " is " + U.TypeName(e));
                                var sides = new List<double>();
                                if (both) { sides.Add(Math.Abs(d)); sides.Add(-Math.Abs(d)); }
                                else if (toward != null)
                                {
                                    // Choose the side whose result is closer to the "toward" point.
                                    double best = double.MaxValue, pick = d;
                                    foreach (double s in new[] { Math.Abs(d), -Math.Abs(d) })
                                    {
                                        try
                                        {
                                            foreach (DBObject o in cv.GetOffsetCurves(s))
                                            {
                                                double dist = ((Curve)o).GetClosestPointTo(toward.Value, false).DistanceTo(toward.Value);
                                                if (dist < best) { best = dist; pick = s; }
                                                o.Dispose();
                                            }
                                        }
                                        catch (Exception) { }
                                    }
                                    sides.Add(pick);
                                }
                                else sides.Add(d);
                                foreach (double s in sides)
                                {
                                    DBObjectCollection res;
                                    try { res = cv.GetOffsetCurves(s); }
                                    catch (Exception) { throw new McpError("AutoCAD cannot offset " + e.Handle + " by " + s); }
                                    var space = (BlockTableRecord)tr.GetObject(e.OwnerId, OpenMode.ForWrite);
                                    foreach (DBObject o in res)
                                    {
                                        var ne = (Entity)o;
                                        space.AppendEntity(ne);
                                        tr.AddNewlyCreatedDBObject(ne, true);
                                        created.Add(ne.Handle.ToString());
                                        U.Grow(ref box, U.Ext(ne));
                                    }
                                }
                            }
                            break;
                        }
                    case "explode":
                        {
                            foreach (var e in ents)
                            {
                                var space = (BlockTableRecord)tr.GetObject(e.OwnerId, OpenMode.ForWrite);
                                var res = new DBObjectCollection();
                                try { e.Explode(res); }
                                catch (Exception) { throw new McpError(U.TypeName(e) + " " + e.Handle + " cannot be exploded"); }
                                foreach (DBObject o in res)
                                {
                                    var ne = o as Entity;
                                    if (ne == null || ne is AttributeDefinition) { o.Dispose(); continue; }
                                    space.AppendEntity(ne);
                                    tr.AddNewlyCreatedDBObject(ne, true);
                                    created.Add(ne.Handle.ToString());
                                    U.Grow(ref box, U.Ext(ne));
                                }
                                // Block attributes become their definitions' default text when exploded; keep the values as text.
                                if (e is BlockReference br)
                                    foreach (ObjectId aid in br.AttributeCollection)
                                    {
                                        var ar = (AttributeReference)tr.GetObject(aid, OpenMode.ForRead);
                                        if (ar.Invisible || string.IsNullOrEmpty(ar.TextString)) continue;
                                        var t = new DBText();
                                        t.SetPropertiesFrom(ar);
                                        t.TextStyleId = ar.TextStyleId; t.Height = ar.Height; t.Rotation = ar.Rotation; t.WidthFactor = ar.WidthFactor;
                                        t.TextString = ar.TextString; t.Position = ar.Position;
                                        if (ar.Justify != AttachmentPoint.BaseLeft) { t.Justify = ar.Justify; t.AlignmentPoint = ar.AlignmentPoint; }
                                        space.AppendEntity(t);
                                        tr.AddNewlyCreatedDBObject(t, true);
                                        created.Add(t.Handle.ToString());
                                    }
                                e.Erase();
                            }
                            break;
                        }
                    default:
                        throw new McpError("op must be move, copy, rotate, scale, mirror, array_rect, array_polar, offset or explode");
                }
                tr.Commit();
            }
            var outp = new Dictionary<string, object> { { "op", op }, { "count", ids.Count }, { "bounds", U.BoundsOut(box) } };
            if (created.Count > 0) outp["created"] = created;
            return outp;
        }

        static object SetProperties(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            List<ObjectId> ids = U.Ids(db, p);
            var created = new List<string>();
            int n = 0;
            var warnings = new List<object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var dr = new Drawer(db, tr, null, p.Obj("layer_styles"));
                foreach (ObjectId id in ids)
                {
                    var e = (Entity)tr.GetObject(id, OpenMode.ForWrite);
                    dr.ApplyProps(e, p);
                    if (p.Has("text"))
                    {
                        string t = p.Str("text");
                        if (e is DBText dt) dt.TextString = t;
                        else if (e is MText mt) mt.Contents = t.Replace("\r\n", "\n").Replace("\n", "\\P");
                        else if (e is Dimension dim) dim.DimensionText = t;
                        else if (e is MLeader ml && ml.MText != null) { var m = ml.MText; m.Contents = t.Replace("\n", "\\P"); ml.MText = m; }
                        else warnings.Add(e.Handle + ": " + U.TypeName(e) + " has no text");
                    }
                    if (p.Has("height"))
                    {
                        double h = p.ReqNum("height");
                        if (e is DBText dt) dt.Height = h;
                        else if (e is MText mt) mt.TextHeight = h;
                    }
                    if (p.Has("closed") && e is Polyline pl) pl.Closed = p.Bool("closed", true);
                    if (p.Has("rotation"))
                    {
                        if (e is DBText dt) dt.Rotation = U.Rad(p.ReqNum("rotation"));
                        else if (e is MText mt) mt.Rotation = U.Rad(p.ReqNum("rotation"));
                        else if (e is BlockReference br) br.Rotation = U.Rad(p.ReqNum("rotation"));
                    }
                    P attrs = p.Obj("attributes");
                    if (attrs != null && e is BlockReference b)
                    {
                        foreach (ObjectId aid in b.AttributeCollection)
                        {
                            var ar = (AttributeReference)tr.GetObject(aid, OpenMode.ForWrite);
                            string key = attrs.D.Keys.FirstOrDefault(k => k.Equals(ar.Tag, StringComparison.OrdinalIgnoreCase));
                            if (key != null) ar.TextString = attrs.Str(key) ?? "";
                        }
                    }
                    n++;
                }
                created.AddRange(dr.CreatedLayers);
                tr.Commit();
            }
            var r = new Dictionary<string, object> { { "updated", n } };
            if (created.Count > 0) r["created_layers"] = created;
            if (warnings.Count > 0) r["warnings"] = warnings;
            return r;
        }

        static object Delete(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            List<ObjectId> ids = U.Ids(db, p);
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                foreach (ObjectId id in ids)
                {
                    var o = tr.GetObject(id, OpenMode.ForRead);
                    if (!(o is Entity)) throw new McpError(id.Handle + " is not a drawing entity");
                    var lay = (LayerTableRecord)tr.GetObject(((Entity)o).LayerId, OpenMode.ForRead);
                    if (lay.IsLocked) throw new McpError(id.Handle + " is on locked layer '" + lay.Name + "'");
                    o.UpgradeOpen();
                    o.Erase();
                }
                tr.Commit();
            }
            return new Dictionary<string, object> { { "deleted", ids.Count } };
        }

        static object Select(Ctx ctx, P p)
        {
            List<ObjectId> ids = U.Ids(ctx.Db, p, "handles", false);
            ctx.Ed.SetImpliedSelection(ids.ToArray());
            return new Dictionary<string, object> { { "selected", ids.Count } };
        }

        static object SetupLayers(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var specs = p.List("layers") ?? new List<object>();
            bool update = p.Bool("update_existing", false);
            var rows = new List<object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                for (int i = 0; i < specs.Count; i++)
                {
                    var s = new P(specs[i], "layers[" + i + "]");
                    string name = s.ReqStr("name");
                    string status;
                    if (lt.Has(name))
                    {
                        if (update)
                        {
                            var ltr = (LayerTableRecord)tr.GetObject(lt[name], OpenMode.ForWrite);
                            U.ApplyLayerStyle(db, tr, ltr, s);
                            status = "updated";
                        }
                        else status = "exists";
                    }
                    else
                    {
                        var created = new List<string>();
                        ObjectId id = U.EnsureLayer(db, tr, name, null, created);
                        U.ApplyLayerStyle(db, tr, (LayerTableRecord)tr.GetObject(id, OpenMode.ForWrite), s);
                        status = "created";
                    }
                    rows.Add(new Dictionary<string, object> { { "name", name }, { "status", status } });
                }
                if (p.Has("current"))
                {
                    string cur = p.Str("current");
                    lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    if (!lt.Has(cur)) throw new McpError("Layer '" + cur + "' not found");
                    var ltr = (LayerTableRecord)tr.GetObject(lt[cur], OpenMode.ForWrite);
                    if (ltr.IsFrozen) ltr.IsFrozen = false;
                    db.Clayer = lt[cur];
                }
                tr.Commit();
            }
            return new Dictionary<string, object>
            {
                { "layers", rows }, { "created", rows.Count(r => (string)((Dictionary<string, object>)r)["status"] == "created") },
            };
        }

        static object Purge(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            bool dry = p.Bool("dry_run", false);
            var keep = new HashSet<string>(p.Strings("keep_layers") ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
            var purged = new Dictionary<string, List<object>>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                for (int pass = 0; pass < (dry ? 1 : 10); pass++)
                {
                    var ids = new ObjectIdCollection();
                    var kinds = new Dictionary<ObjectId, string>();
                    Action<ObjectId, string> addTable = (tableId, kind) =>
                    {
                        var t = (SymbolTable)tr.GetObject(tableId, OpenMode.ForRead);
                        foreach (ObjectId id in t)
                        {
                            var rec = (SymbolTableRecord)tr.GetObject(id, OpenMode.ForRead);
                            if (rec.IsDependent || rec.IsErased) continue;
                            if (kind == "layers" && keep.Contains(rec.Name)) continue;
                            if (rec is BlockTableRecord b && (b.IsLayout || b.IsFromExternalReference)) continue;
                            ids.Add(id);
                            kinds[id] = kind;
                        }
                    };
                    addTable(db.LayerTableId, "layers");
                    addTable(db.BlockTableId, "blocks");
                    addTable(db.LinetypeTableId, "linetypes");
                    addTable(db.TextStyleTableId, "text_styles");
                    addTable(db.DimStyleTableId, "dim_styles");
                    addTable(db.RegAppTableId, "regapps");
                    db.Purge(ids);
                    if (ids.Count == 0) break;
                    foreach (ObjectId id in ids)
                    {
                        var rec = (SymbolTableRecord)tr.GetObject(id, OpenMode.ForRead);
                        if (rec.Name.StartsWith("*") && kinds[id] == "blocks" && dry) { }
                        string k = kinds[id];
                        if (!purged.ContainsKey(k)) purged[k] = new List<object>();
                        if (!rec.Name.StartsWith("*")) purged[k].Add(rec.Name);
                        if (!dry) { rec.UpgradeOpen(); rec.Erase(); }
                    }
                }
                if (!dry) tr.Commit();
            }
            return new Dictionary<string, object>
            {
                { "dry_run", dry }, { "purged", purged.ToDictionary(kv => kv.Key, kv => (object)kv.Value) },
                { "total", purged.Values.Sum(v => v.Count) },
            };
        }

        static object Undo(Ctx ctx, P p)
        {
            int steps = Math.Max(1, Math.Min(50, p.Int("steps", 1)));
            ctx.Ed.Command("_.UNDO", steps.ToString());
            return new Dictionary<string, object> { { "undone_steps", steps } };
        }
    }
}
