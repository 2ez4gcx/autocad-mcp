// quantity_takeoff (lengths, areas, hatch areas, block counts by layer / block / type) and check_drawing (drawing QA).
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Takeoff
    {
        class Row
        {
            public int Count, Closed;
            public double Length, Area, Hatch;
            public readonly Dictionary<string, int> Types = new Dictionary<string, int>();
            public readonly Dictionary<string, int> Blocks = new Dictionary<string, int>();
            public readonly Dictionary<string, int> Layers = new Dictionary<string, int>();
            public readonly Dictionary<string, Dictionary<string, int>> Attrs = new Dictionary<string, Dictionary<string, int>>();
        }

        static void Inc(Dictionary<string, int> d, string k) { d[k] = d.TryGetValue(k, out int c) ? c + 1 : 1; }

        public static double Length(Curve c)
        {
            try
            {
                switch (c)
                {
                    case Line l: return l.Length;
                    case Arc a: return a.Length;
                    case Circle ci: return 2 * Math.PI * ci.Radius;
                    case Polyline pl: return pl.Length;
                    default: return Math.Abs(c.GetDistanceAtParameter(c.EndParam) - c.GetDistanceAtParameter(c.StartParam));
                }
            }
            catch (Exception) { return 0; }
        }

        /// <summary>Hatch area; when AutoCAD cannot compute it, from the loops (nesting parity, arcs sampled).</summary>
        public static double HatchArea(Hatch h)
        {
            try { return h.Area; } catch (Exception) { }
            var loops = new List<List<Point2d>>();
            for (int i = 0; i < h.NumberOfLoops; i++)
            {
                HatchLoop lp = h.GetLoopAt(i);
                var pts = new List<Point2d>();
                if (lp.IsPolyline) foreach (BulgeVertex bv in lp.Polyline) pts.Add(bv.Vertex);
                else
                    foreach (Curve2d c in lp.Curves)
                    {
                        if (c is LineSegment2d ls) pts.Add(ls.StartPoint);
                        else
                        {
                            Point2d[] s = c.GetSamplePoints(16);
                            for (int k = 0; k < s.Length - 1; k++) pts.Add(s[k]);
                        }
                    }
                if (pts.Count >= 3) loops.Add(pts);
            }
            Func<List<Point2d>, double> area = v =>
            {
                double a = 0;
                for (int k = 0; k < v.Count; k++) a += v[k].X * v[(k + 1) % v.Count].Y - v[(k + 1) % v.Count].X * v[k].Y;
                return Math.Abs(a / 2);
            };
            Func<List<Point2d>, Point2d, bool> inside = (v, q) =>
            {
                bool r = false;
                for (int a = 0, b = v.Count - 1; a < v.Count; b = a++)
                    if ((v[a].Y > q.Y) != (v[b].Y > q.Y) && q.X < (v[b].X - v[a].X) * (q.Y - v[a].Y) / (v[b].Y - v[a].Y) + v[a].X) r = !r;
                return r;
            };
            double total = 0;
            foreach (var l in loops)
            {
                int depth = loops.Count(o => o != l && area(o) > area(l) && inside(o, l[0]));
                total += depth % 2 == 0 ? area(l) : -area(l);
            }
            return Math.Max(0, total);
        }

        static IEnumerable<ObjectId> Targets(Ctx ctx, P p, Transaction tr)
        {
            if (p.Bool("selection_only", false))
            {
                PromptSelectionResult sel = ctx.Ed.SelectImplied();
                if (sel.Status != PromptStatus.OK || sel.Value == null) throw new McpError("Nothing is selected in AutoCAD.");
                return sel.Value.GetObjectIds();
            }
            if (p.Has("handles")) return U.Ids(ctx.Db, p);
            return Commands.SpaceIds(ctx.Db, tr, p.Str("space")).ToList();
        }

        public static object Quantity(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            double toM = U.ToMetres(db);
            string by = (p.Str("group_by") ?? "layer").ToLowerInvariant();
            if (by != "layer" && by != "block" && by != "type" && by != "layer_type") throw new McpError("group_by must be layer, block, type or layer_type");
            var f = new Commands.Filter(db, p);
            var rows = new SortedDictionary<string, Row>(StringComparer.OrdinalIgnoreCase);
            int n = 0;
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                foreach (ObjectId id in Targets(ctx, p, tr))
                {
                    if (!f.QuickOk(id)) continue;
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || e is Viewport || !f.Ok(tr, e)) continue;
                    string type = U.TypeName(e);
                    var br = e is Table ? null : e as BlockReference;
                    string key;
                    switch (by)
                    {
                        case "block":
                            if (br == null) continue;
                            key = U.BlockName(tr, br);
                            break;
                        case "type": key = type; break;
                        case "layer_type": key = e.Layer + " | " + type; break;
                        default: key = e.Layer; break;
                    }
                    if (!rows.TryGetValue(key, out Row r)) rows[key] = r = new Row();
                    n++;
                    r.Count++;
                    Inc(r.Types, type);
                    Inc(r.Layers, e.Layer);
                    if (e is Curve c)
                    {
                        r.Length += Length(c);
                        bool closed = c.Closed || c is Circle || (c is Ellipse el && Math.Abs(el.EndAngle - el.StartAngle - 2 * Math.PI) < 1e-9);
                        if (closed) { try { r.Area += Math.Abs(c.Area); r.Closed++; } catch (Exception) { } }
                    }
                    else if (e is Region rg) { try { r.Area += rg.Area; r.Closed++; } catch (Exception) { } }
                    else if (e is Hatch h) r.Hatch += HatchArea(h);
                    else if (br != null)
                    {
                        Inc(r.Blocks, U.BlockName(tr, br));
                        if (by == "block")
                            foreach (var kv in U.Attributes(tr, br))
                            {
                                if (!r.Attrs.TryGetValue(kv.Key, out var vals)) r.Attrs[kv.Key] = vals = new Dictionary<string, int>();
                                if (vals.Count < 50) Inc(vals, Convert.ToString(kv.Value));
                            }
                    }
                }
            }
            var outRows = new List<object>();
            double tl = 0, ta = 0, th = 0;
            foreach (var kv in rows)
            {
                Row r = kv.Value;
                var d = new Dictionary<string, object> { { by == "layer_type" ? "layer | type" : by, kv.Key }, { "count", r.Count } };
                if (r.Types.Count > 1 || by != "type") d["by_type"] = r.Types;
                if (r.Length > 0) d["length_m"] = U.R(r.Length * toM, 3);
                if (r.Closed > 0) { d["closed_area_m2"] = U.R(r.Area * toM * toM, 3); d["closed_count"] = r.Closed; }
                if (r.Hatch > 0) d["hatch_area_m2"] = U.R(r.Hatch * toM * toM, 3);
                if (r.Blocks.Count > 0 && by != "block") d["blocks"] = r.Blocks;
                if (by == "block") { d["by_layer"] = r.Layers; if (r.Attrs.Count > 0) d["attributes"] = r.Attrs; }
                tl += r.Length; ta += r.Area; th += r.Hatch;
                outRows.Add(d);
            }
            var res = new Dictionary<string, object>
            {
                { "group_by", by }, { "units", U.UnitName(db) }, { "entities", n }, { "rows", outRows },
                { "totals", new Dictionary<string, object> { { "length_m", U.R(tl * toM, 3) }, { "closed_area_m2", U.R(ta * toM * toM, 3) }, { "hatch_area_m2", U.R(th * toM * toM, 3) } } },
                { "notes", new List<object> {
                    "length_m: lines, arcs, polylines (closed ones by perimeter), circles, splines. closed_area_m2: closed polylines, circles, ellipses, regions. " +
                    "hatch_area_m2: hatches, reported apart (a hatch inside a closed polyline would otherwise be counted twice).",
                    "Geometry inside blocks is not measured: blocks are counted (group_by=block for counts with attribute values)." } },
            };
            if (db.Insunits == UnitsValue.Undefined) ((List<object>)res["notes"]).Add("The drawing is unitless (INSUNITS=0): lengths were read as mm.");
            return res;
        }

        // ---------------------------------------------------------------- check_drawing

        class Issues
        {
            public readonly List<object> List = new List<object>();

            public void Add(string code, string severity, string message, List<string> handles, int count = -1)
            {
                int n = count >= 0 ? count : handles == null ? 0 : handles.Count;
                if (n == 0 && count != 0 && handles != null) return;
                var d = new Dictionary<string, object> { { "code", code }, { "severity", severity }, { "message", message }, { "count", n } };
                if (handles != null && handles.Count > 0) d["handles"] = handles.Take(20).Cast<object>().ToList();
                List.Add(d);
            }
        }

        static string Key(double v) { return Math.Round(v, 2).ToString(CultureInfo.InvariantCulture); }

        static string Pt(Point3d p) { return Key(p.X) + "," + Key(p.Y) + "," + Key(p.Z); }

        static string GeomKey(Transaction tr, Entity e)
        {
            switch (e)
            {
                case Line l:
                    {
                        string a = Pt(l.StartPoint), b = Pt(l.EndPoint);
                        return "L|" + (string.CompareOrdinal(a, b) < 0 ? a + "|" + b : b + "|" + a);
                    }
                case Circle c: return "C|" + Pt(c.Center) + "|" + Key(c.Radius);
                case Arc a: return "A|" + Pt(a.Center) + "|" + Key(a.Radius) + "|" + Key(a.StartAngle) + "|" + Key(a.EndAngle);
                case Polyline pl:
                    {
                        var parts = new List<string>();
                        for (int i = 0; i < pl.NumberOfVertices; i++) parts.Add(Pt(pl.GetPoint3dAt(i)) + ":" + Key(pl.GetBulgeAt(i)));
                        if (pl.Closed)
                        {
                            string first = parts.OrderBy(x => x, StringComparer.Ordinal).First();
                            int m = parts.IndexOf(first);
                            parts = parts.Skip(m).Concat(parts.Take(m)).ToList();
                        }
                        return "P|" + pl.Closed + "|" + string.Join(";", parts);
                    }
                case DBText t: return "T|" + Pt(t.Position) + "|" + t.TextString;
                case MText m: return "M|" + Pt(m.Location) + "|" + m.Contents;
                case BlockReference br: return "B|" + U.BlockName(tr, br) + "|" + Pt(br.Position) + "|" + Key(br.Rotation) + "|" + Key(br.ScaleFactors.X) + "|" + Key(br.ScaleFactors.Y);
                default: return null;
            }
        }

        static bool HasNonAscii(string s) { return s != null && s.Any(ch => ch > 127); }

        public static object Check(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var iss = new Issues();
            var onZero = new List<string>();
            var onDefpoints = new List<string>();
            var colorOv = new List<string>();
            var ltOv = new List<string>();
            var lwOv = new List<string>();
            var tiny = new List<string>();
            var dup = new List<string>();
            var looksClosed = new List<string>();
            var openArea = new List<string>();
            var shxText = new List<string>();
            var dimOverride = new List<string>();
            var hiddenLayer = new List<string>();
            var thickWalls = new List<string>();
            var widePolys = new List<string>();
            var wallLayer = new System.Text.RegularExpressions.Regex("WALL|TUONG|TƯỜNG|MUR", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            var seen = new Dictionary<string, string>();
            var centers = new List<Point3d>();
            var boxes = new List<KeyValuePair<string, Extents3d>>();
            int n = 0;
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                // Text styles that cannot show Vietnamese (or other non-ASCII) characters: plain SHX fonts without a big font.
                var shxStyles = new HashSet<ObjectId>();
                var missingFonts = new List<string>();
                var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                foreach (ObjectId sid in tst)
                {
                    var ts = (TextStyleTableRecord)tr.GetObject(sid, OpenMode.ForRead);
                    string file = ts.FileName ?? "";
                    bool ttf = !string.IsNullOrEmpty(ts.Font.TypeFace) || file.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) || file.EndsWith(".ttc", StringComparison.OrdinalIgnoreCase);
                    if (!ttf && !ts.IsShapeFile) shxStyles.Add(sid);
                    if (!ttf && file != "")
                    {
                        try { HostApplicationServices.Current.FindFile(file.EndsWith(".shx", StringComparison.OrdinalIgnoreCase) ? file : file + ".shx", db, FindFileHint.CompiledShapeFile); }
                        catch (Exception) { missingFonts.Add(ts.Name + " (" + file + ")"); }
                    }
                }
                if (missingFonts.Count > 0)
                    iss.Add("missing_fonts", "warning", "Text styles whose SHX font file is not found on this computer (AutoCAD substitutes another font): " + string.Join(", ", missingFonts), null, missingFonts.Count);

                var layerOff = new HashSet<ObjectId>();
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                foreach (ObjectId lid in lt)
                {
                    var l = (LayerTableRecord)tr.GetObject(lid, OpenMode.ForRead);
                    if (l.IsOff || l.IsFrozen) layerOff.Add(lid);
                }

                foreach (ObjectId id in Commands.SpaceIds(db, tr, p.Str("space") ?? "all"))
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || e is Viewport) continue;
                    n++;
                    string h = e.Handle.ToString();
                    if (e.Layer == "0") onZero.Add(h);
                    if (e.Layer.Equals("Defpoints", StringComparison.OrdinalIgnoreCase) && !(e is Dimension)) onDefpoints.Add(h);
                    if (!e.Color.IsByLayer) colorOv.Add(h);
                    if (!e.Linetype.Equals("ByLayer", StringComparison.OrdinalIgnoreCase)) ltOv.Add(h);
                    if (e.LineWeight != LineWeight.ByLayer) lwOv.Add(h);
                    if (layerOff.Contains(e.LayerId)) hiddenLayer.Add(h);
                    if ((e is Line || e is Polyline) && wallLayer.IsMatch(e.Layer) && e.LineWeight != LineWeight.ByLayer && (int)e.LineWeight >= 70) thickWalls.Add(h);
                    switch (e)
                    {
                        case Line l when l.Length < 0.01: tiny.Add(h); break;
                        case Polyline pl:
                            {
                                // A wall drawn as ONE line made thick (polyline width) instead of its two faces.
                                double wmax = pl.ConstantWidth;
                                for (int k = 0; k < pl.NumberOfVertices && wmax <= 0; k++) wmax = Math.Max(pl.GetStartWidthAt(k), pl.GetEndWidthAt(k));
                                if (wmax > 0 && wallLayer.IsMatch(e.Layer)) thickWalls.Add(h);
                                else if (wmax >= 50 && !System.Text.RegularExpressions.Regex.IsMatch(e.Layer, "ANNO|SYMB|TTLB", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) widePolys.Add(h);
                            }
                            if (pl.Length < 0.01) tiny.Add(h);
                            else if (!pl.Closed && pl.NumberOfVertices > 2 && pl.StartPoint.DistanceTo(pl.EndPoint) < 0.01) looksClosed.Add(h);
                            else if (!pl.Closed && System.Text.RegularExpressions.Regex.IsMatch(e.Layer, "AREA|ROOM|PHONG|DIENTICH|DT-|SPACE", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) openArea.Add(h);
                            break;
                        case Circle c when c.Radius < 0.005: tiny.Add(h); break;
                        case DBText t:
                            if (string.IsNullOrWhiteSpace(t.TextString)) tiny.Add(h);
                            else if (HasNonAscii(t.TextString) && shxStyles.Contains(t.TextStyleId)) shxText.Add(h);
                            break;
                        case MText m:
                            if (string.IsNullOrWhiteSpace(m.Text)) tiny.Add(h);
                            else if (HasNonAscii(m.Text) && shxStyles.Contains(m.TextStyleId) && !m.Contents.Contains("\\f")) shxText.Add(h);
                            break;
                        case Dimension d:
                            if (!string.IsNullOrEmpty(d.DimensionText) && !d.DimensionText.Contains("<>")) dimOverride.Add(h);
                            break;
                    }
                    string key = GeomKey(tr, e);
                    if (key != null)
                    {
                        key = e.OwnerId.Handle + "|" + e.Layer + "|" + key;
                        if (seen.ContainsKey(key)) dup.Add(h); else seen[key] = h;
                    }
                    Extents3d? x = U.Ext(e);
                    if (x != null && e.OwnerId == db.CurrentSpaceId)
                    {
                        centers.Add(new Point3d((x.Value.MinPoint.X + x.Value.MaxPoint.X) / 2, (x.Value.MinPoint.Y + x.Value.MaxPoint.Y) / 2, 0));
                        boxes.Add(new KeyValuePair<string, Extents3d>(h, x.Value));
                    }
                }

                // Objects far from the rest blow up the extents (zoom extents shows a tiny drawing).
                var far = new List<string>();
                if (centers.Count >= 10)
                {
                    var xs = centers.Select(c => c.X).OrderBy(v => v).ToList();
                    var ys = centers.Select(c => c.Y).OrderBy(v => v).ToList();
                    Func<List<double>, double, double> q = (l, t) => l[(int)Math.Floor(t * (l.Count - 1))];
                    double spread = Math.Max(q(xs, 0.9) - q(xs, 0.1), q(ys, 0.9) - q(ys, 0.1));
                    double mx = q(xs, 0.5), my = q(ys, 0.5);
                    double lim = Math.Max(spread * 20, 1000);
                    foreach (var kv in boxes)
                    {
                        Extents3d b = kv.Value;
                        double dx = Math.Max(Math.Abs(b.MinPoint.X - mx), Math.Abs(b.MaxPoint.X - mx));
                        double dy = Math.Max(Math.Abs(b.MinPoint.Y - my), Math.Abs(b.MaxPoint.Y - my));
                        if (Math.Max(dx, dy) > lim) far.Add(kv.Key);
                    }
                }

                iss.Add("single_line_walls", "warning", "Walls drawn as ONE thick line (polyline width or a heavy lineweight) instead of their two faces: " +
                    "not an architectural drawing convention. Redraw them with draw_plan (two face lines at the real thickness, clean junctions, hatch).", thickWalls);
                iss.Add("wide_polylines", "info", "Polylines with a width of 50 units or more (walls or slabs drawn as one thick line?).", widePolys);
                iss.Add("duplicates", "warning", "Stacked duplicate copies (same geometry, same layer): they double lengths, areas and counts. Delete the listed copies (the first copy is kept).", dup);
                iss.Add("looks_closed_not_closed", "warning", "Polylines whose ends meet but that are not marked closed: their area is not measured. Fix with set_properties closed=true.", looksClosed);
                iss.Add("open_area_boundary", "warning", "Open polylines on area/room layers: area takeoff needs closed polylines.", openArea);
                iss.Add("shx_non_ascii_text", "warning", "Texts with Vietnamese/non-ASCII characters in an SHX text style: they can show as '?'. Use a TrueType style (setup_styles creates one with Arial).", shxText);
                iss.Add("defpoints", "warning", "Objects on layer Defpoints never plot.", onDefpoints);
                iss.Add("dimension_text_override", "warning", "Dimensions whose measured value was replaced by typed text: the shown number may not match the geometry.", dimOverride);
                iss.Add("far_objects", "warning", "Objects far away from the rest of the drawing (they blow up zoom extents and screenshots).", far);
                iss.Add("tiny_or_empty", "info", "Zero-length lines/polylines, tiny circles and empty texts.", tiny);
                iss.Add("layer_0", "info", "Objects on layer 0 (put them on a proper layer).", onZero);
                iss.Add("color_override", "info", "Objects with a color set directly instead of ByLayer.", colorOv);
                iss.Add("linetype_override", "info", "Objects with a linetype set directly instead of ByLayer.", ltOv);
                iss.Add("lineweight_override", "info", "Objects with a lineweight set directly instead of ByLayer.", lwOv);
                iss.Add("on_hidden_layers", "info", "Objects on layers that are off or frozen (not visible, not plotted).", hiddenLayer);

                var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                var badXrefs = new List<string>();
                foreach (ObjectId bid in bt)
                {
                    var btr = (BlockTableRecord)tr.GetObject(bid, OpenMode.ForRead);
                    if (btr.IsFromExternalReference && !btr.IsResolved) badXrefs.Add(btr.Name + " (" + btr.PathName + ")");
                }
                if (badXrefs.Count > 0) iss.Add("unresolved_xrefs", "warning", "Xrefs not found: " + string.Join(", ", badXrefs), null, badXrefs.Count);
                var badImages = new List<string>();
                ObjectId dictId = RasterImageDef.GetImageDictionary(db);
                if (!dictId.IsNull)
                {
                    var dict = (DBDictionary)tr.GetObject(dictId, OpenMode.ForRead);
                    foreach (DBDictionaryEntry de in dict)
                    {
                        var def = tr.GetObject(de.Value, OpenMode.ForRead) as RasterImageDef;
                        if (def != null && !File.Exists(def.ActiveFileName ?? "") && !File.Exists(def.SourceFileName ?? "")) badImages.Add(de.Key + " (" + def.SourceFileName + ")");
                    }
                }
                if (badImages.Count > 0) iss.Add("missing_images", "warning", "Attached images whose file is missing: " + string.Join(", ", badImages), null, badImages.Count);
                if (db.Insunits == UnitsValue.Undefined)
                    iss.Add("unitless", "info", "INSUNITS is unitless: set it to mm (setup_styles units=mm) so blocks and images insert at the right scale.", null, 1);
            }
            var list = iss.List;
            return new Dictionary<string, object>
            {
                { "entities_checked", n },
                { "warnings", list.Count(i => (string)((Dictionary<string, object>)i)["severity"] == "warning") },
                { "issues", list },
            };
        }
    }
}
