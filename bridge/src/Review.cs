// Reviewing and tidying drawings made by others: the dimensions whose written value is not what they measure and the
// area texts of the rooms (annotation_data, checked by the server), texts set by handle in one step (set_texts), every
// text of a drawing (text_list), duplicates, zero-length entities, empty texts and overlapping lines removed (clean),
// and a drawing on disk read in the background for the map of a whole folder (WithDb).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Review
    {
        static List<object> Box(Extents3d x) => new List<object> { Math.Round(x.MinPoint.X, 1), Math.Round(x.MinPoint.Y, 1), Math.Round(x.MaxPoint.X, 1), Math.Round(x.MaxPoint.Y, 1) };

        /// <summary>The drawing of p.path read in the background (never opened in the editor), else the current one.</summary>
        public static object WithDb(Ctx ctx, P p, Func<Database, string, object> f)
        {
            string path = p.Str("path");
            if (string.IsNullOrEmpty(path)) return f(ctx.Db, ctx.Doc?.Name);
            path = System.IO.Path.GetFullPath(path);
            if (!System.IO.File.Exists(path)) throw new McpError("No file " + path);
            using (var side = new Database(false, true))
            {
                side.ReadDwgFile(path, System.IO.FileShare.ReadWrite, true, null);
                side.CloseInput(true);
                var prev = HostApplicationServices.WorkingDatabase;
                try
                {
                    HostApplicationServices.WorkingDatabase = side;
                    return f(side, path);
                }
                finally { HostApplicationServices.WorkingDatabase = prev; }
            }
        }

        static HashSet<string> LockedLayers(Database db, Transaction tr)
        {
            var s = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            foreach (ObjectId id in lt) { var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead); if (l.IsLocked) s.Add(l.Name); }
            return s;
        }

        static readonly Regex AreaWord = new Regex(@"m2|m²|㎡|\bS\s*=|\bDT\b|DIỆN TÍCH|AREA|面積|面积", RegexOptions.IgnoreCase);

        /// <summary>
        /// annotation_data: in model space, the dimensions whose text is written over (with their measured value,
        /// decimals and linear factor) and the texts that read like an area (m2, m², S =, DT, DIỆN TÍCH, AREA, 面積)
        /// with the smallest closed polyline around them and its area in m².
        /// </summary>
        public static object AnnotationData(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            double toM = U.ToMetres(db), k2 = toM * toM;
            var dims = new List<object>();
            var areas = new List<object>();
            int dimCount = 0;
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                var outlines = new List<Polyline>();
                var boxes = new List<Extents3d>();
                var texts = new List<Entity>();
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    if (e is Dimension d)
                    {
                        dimCount++;
                        string ov = d.DimensionText ?? "";
                        if (ov.Trim().Length == 0 || ov.Trim() == "<>") continue;
                        double m;
                        try { m = d.Measurement; } catch (Exception) { continue; }
                        string kind = "linear";
                        if (d is LineAngularDimension2 || d is Point3AngularDimension) { m = m * 180 / Math.PI; kind = "angular"; }
                        else if (d is RadialDimension || d is RadialDimensionLarge) kind = "radius";
                        else if (d is DiametricDimension) kind = "diameter";
                        else if (d is ArcDimension) kind = "arc";
                        var x = U.Ext(d);
                        dims.Add(new Dictionary<string, object>
                        {
                            { "h", d.Handle.ToString() }, { "text", ov }, { "m", Math.Round(m, 4) }, { "dec", d.Dimdec }, { "lfac", d.Dimlfac },
                            { "kind", kind }, { "layer", d.Layer }, { "b", x == null ? null : Box(x.Value) },
                        });
                    }
                    else if (e is Polyline pl && pl.Closed && pl.NumberOfVertices >= 3)
                    {
                        // a revision cloud (its view, its layer, every side an arc) is not a room outline
                        if ((Views.TagOf(pl) ?? "").StartsWith("revision:", StringComparison.Ordinal) || pl.Layer.IndexOf("REVS", StringComparison.OrdinalIgnoreCase) >= 0) continue;
                        bool allArcs = true;
                        for (int k = 0; k < pl.NumberOfVertices && allArcs; k++) if (Math.Abs(pl.GetBulgeAt(k)) < 1e-6) allArcs = false;
                        if (allArcs) continue;
                        var x = U.Ext(pl);
                        if (x != null) { outlines.Add(pl); boxes.Add(x.Value); }
                    }
                    else if ((e is DBText && !(e is AttributeDefinition)) || e is MText) texts.Add(e);
                }
                foreach (var t in texts)
                {
                    var dt = t as DBText;
                    string s = dt != null ? dt.TextString : ((MText)t).Text;
                    if (string.IsNullOrWhiteSpace(s) || !AreaWord.IsMatch(s) || !Regex.IsMatch(s, @"\d")) continue;
                    Point3d at = dt != null ? (dt.Justify == AttachmentPoint.BaseLeft ? dt.Position : dt.AlignmentPoint) : ((MText)t).Location;
                    Polyline best = null;
                    double bestA = double.MaxValue;
                    for (int i = 0; i < outlines.Count; i++)
                    {
                        var b = boxes[i];
                        if (at.X < b.MinPoint.X || at.X > b.MaxPoint.X || at.Y < b.MinPoint.Y || at.Y > b.MaxPoint.Y) continue;
                        double a = outlines[i].Area;
                        if (a >= bestA) continue;
                        var poly = new List<Point2d>();
                        for (int k = 0; k < outlines[i].NumberOfVertices; k++) poly.Add(outlines[i].GetPoint2dAt(k));
                        if (!Edit.InPoly(poly, at)) continue;
                        best = outlines[i];
                        bestA = a;
                    }
                    var tx = U.Ext(t);
                    var it = new Dictionary<string, object> { { "h", t.Handle.ToString() }, { "text", s }, { "raw", dt != null ? dt.TextString : ((MText)t).Contents }, { "layer", t.Layer }, { "b", tx == null ? null : Box(tx.Value) } };
                    if (best != null) { it["outline"] = best.Handle.ToString(); it["outline_layer"] = best.Layer; it["area_m2"] = Math.Round(bestA * k2, 4); }
                    areas.Add(it);
                }
            }
            return new Dictionary<string, object> { { "dims", dims }, { "dims_checked", dimCount }, { "areas", areas }, { "units_m", toM } };
        }

        /// <summary>Whether an entity lies in model space (an attribute: its block reference does).</summary>
        static bool InModel(Transaction tr, Entity e, ObjectId ms)
        {
            if (e.OwnerId == ms) return true;
            if (e is AttributeReference && tr.GetObject(e.OwnerId, OpenMode.ForRead) is Entity owner) return owner.OwnerId == ms;
            return false;
        }

        /// <summary>
        /// set_texts {items: [{handle, text}]}: the text of each entity by handle in one Undo step: text, mtext (its
        /// contents), attribute, attribute default, dimension (its override; "&lt;&gt;" is the measured value), mleader, and a
        /// table cell as "handle:row:column". Returns the extents of those in model space (to cloud them).
        /// </summary>
        public static object SetTexts(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var items = p.List("items") ?? throw new McpError("set_texts: items [{handle, text}] are required");
            int n = 0;
            var missing = new List<object>();
            var locked = new List<object>();
            var boxes = new List<object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lockedLayers = LockedLayers(db, tr);
                var ms = SymbolUtilityServices.GetBlockModelSpaceId(db);
                foreach (var o in items)
                {
                    var ip = new P(o, "items");
                    string hs = ip.ReqStr("handle");
                    string text = ip.Str("text") ?? "";
                    var parts = hs.Split(':');
                    int r = -1, c = -1;
                    if (parts.Length == 3 && (!int.TryParse(parts[1], out r) || !int.TryParse(parts[2], out c))) { missing.Add(hs); continue; }
                    string tag = parts.Length == 2 ? parts[1] : null;
                    ObjectId id;
                    try { id = U.Id(db, parts[0]); } catch (McpError) { missing.Add(hs); continue; }
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null) { missing.Add(hs); continue; }
                    if (lockedLayers.Contains(e.Layer)) { locked.Add(hs); continue; }
                    if (tag != null)
                    {
                        // an attribute by its tag: of a block reference, or of the block of a multileader (a note tag)
                        bool done = false;
                        if (e is MLeader mlt)
                        {
                            var ad = LeaderAttDefs(tr, mlt).FirstOrDefault(a => a.Tag.Equals(tag, StringComparison.OrdinalIgnoreCase));
                            if (ad != null) { mlt.UpgradeOpen(); SetLeaderAtt(mlt, ad, text); done = true; }
                        }
                        else if (e is BlockReference brt)
                        {
                            foreach (ObjectId aid in brt.AttributeCollection)
                            {
                                if (!(tr.GetObject(aid, OpenMode.ForRead) is AttributeReference ar) || !ar.Tag.Equals(tag, StringComparison.OrdinalIgnoreCase)) continue;
                                ar.UpgradeOpen();
                                ar.TextString = text;
                                done = true;
                            }
                        }
                        if (!done) { missing.Add(hs); continue; }
                        n++;
                        var xt = U.Ext(e);
                        if (xt != null && InModel(tr, e, ms)) boxes.Add(Box(xt.Value));
                        continue;
                    }
                    e.UpgradeOpen();
                    switch (e)
                    {
                        case Table tb when r >= 0 && r < tb.Rows.Count && c >= 0 && c < tb.Columns.Count: tb.Cells[r, c].TextString = text; break;
                        case DBText t: t.TextString = text; break; // texts, attributes, attribute defaults
                        case MText m: m.Contents = text.Replace("\r\n", "\\P").Replace("\n", "\\P"); break; // a plain new line is a paragraph
                        case Dimension d: d.DimensionText = text; break;
                        case MLeader ml when ml.ContentType == ContentType.MTextContent:
                            {
                                var mt = ml.MText;
                                mt.Contents = text;
                                ml.MText = mt;
                                break;
                            }
                        default: missing.Add(hs); continue;
                    }
                    n++;
                    var x = U.Ext(e);
                    if (x != null && InModel(tr, e, ms)) boxes.Add(Box(x.Value));
                }
                tr.Commit();
            }
            var res = new Dictionary<string, object> { { "set", n }, { "boxes", boxes } };
            if (missing.Count > 0) res["not_found"] = missing;
            if (locked.Count > 0) res["locked"] = locked;
            return res;
        }

        /// <summary>
        /// text_list {blocks: false, limit: 20000}: every text of the drawing, model space and layouts (and block
        /// definitions with blocks): [handle, kind, text (plain), layer, style, space, x, y, height]. A table cell is
        /// "handle:row:column"; a dimension only when its text is written over.
        /// </summary>
        public static object TextList(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            bool blocks = p.Bool("blocks", false);
            int limit = (int)p.Num("limit", 20000);
            var items = new List<object>();
            Func<double, double> R = v => Math.Round(v, 1);
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var ms = SymbolUtilityServices.GetBlockModelSpaceId(db);
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId bid in table)
                {
                    var btr = (BlockTableRecord)tr.GetObject(bid, OpenMode.ForRead);
                    if (btr.IsFromExternalReference || btr.IsDependent) continue;
                    if (btr.IsAnonymous && (btr.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase) || btr.Name.StartsWith("*T", StringComparison.OrdinalIgnoreCase))) continue;
                    if (!btr.IsLayout && !blocks) continue;
                    string space = bid == ms ? "model" : btr.IsLayout ? "layout " + ((Layout)tr.GetObject(btr.LayoutId, OpenMode.ForRead)).LayoutName : "block " + btr.Name;
                    Action<string, string, string, Entity, Point3d, double, string> add = (h, kind, s, e, at, ht, style) =>
                    {
                        if (items.Count >= limit || string.IsNullOrWhiteSpace(s)) return;
                        items.Add(new List<object> { h, kind, s, e.Layer, style, space, R(at.X), R(at.Y), R(ht) });
                    };
                    foreach (ObjectId id in btr)
                    {
                        if (items.Count >= limit) break;
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        try
                        {
                            switch (e)
                            {
                                case AttributeDefinition ad: add(ad.Handle.ToString(), "attribute default", ad.TextString, ad, ad.Position, ad.Height, ad.TextStyleName); break;
                                case DBText t: add(t.Handle.ToString(), "text", t.TextString, t, t.Justify == AttachmentPoint.BaseLeft ? t.Position : t.AlignmentPoint, t.Height, t.TextStyleName); break;
                                case MText m: add(m.Handle.ToString(), "mtext", m.Text, m, m.Location, m.TextHeight, m.TextStyleName); break;
                                case Dimension d:
                                    if (!string.IsNullOrWhiteSpace(d.DimensionText) && d.DimensionText.Trim() != "<>") add(d.Handle.ToString(), "dimension override", d.DimensionText, d, d.TextPosition, d.Dimtxt * d.Dimscale, "");
                                    break;
                                case MLeader ml when ml.ContentType == ContentType.MTextContent:
                                    {
                                        var mt = ml.MText;
                                        if (mt != null) add(ml.Handle.ToString(), "mleader", mt.Text, ml, mt.Location, mt.TextHeight, mt.TextStyleName);
                                        break;
                                    }
                                case MLeader mlb when mlb.ContentType == ContentType.BlockContent:
                                    // a note whose content is a block with attributes: each as "handle:TAG"
                                    foreach (var ad in LeaderAttDefs(tr, mlb))
                                        add(mlb.Handle + ":" + ad.Tag, "mleader attribute " + ad.Tag, LeaderAtt(mlb, ad), mlb, mlb.BlockPosition, ad.Height * mlb.BlockScale.X, ad.TextStyleName);
                                    break;
                                case Table tb:
                                    for (int r = 0; r < tb.Rows.Count; r++)
                                        for (int c = 0; c < tb.Columns.Count; c++)
                                            add(tb.Handle + ":" + r + ":" + c, "table cell", tb.Cells[r, c].TextString, tb, tb.Position, 0, "");
                                    break;
                                case BlockReference br:
                                    foreach (ObjectId aid in br.AttributeCollection)
                                        if (tr.GetObject(aid, OpenMode.ForRead) is AttributeReference at && !at.Invisible)
                                            add(at.Handle.ToString(), "attribute " + at.Tag, at.TextString, at, at.Justify == AttachmentPoint.BaseLeft ? at.Position : at.AlignmentPoint, at.Height, at.TextStyleName);
                                    break;
                            }
                        }
                        catch (Exception) { }
                    }
                }
            }
            return new Dictionary<string, object> { { "items", items }, { "truncated", items.Count >= limit } };
        }

        /// <summary>The attribute definitions of the block of a multileader with block content (the tags it writes).</summary>
        internal static List<AttributeDefinition> LeaderAttDefs(Transaction tr, MLeader ml)
        {
            var l = new List<AttributeDefinition>();
            if (ml.ContentType != ContentType.BlockContent || ml.BlockContentId.IsNull) return l;
            var btr = (BlockTableRecord)tr.GetObject(ml.BlockContentId, OpenMode.ForRead);
            foreach (ObjectId id in btr)
                if (tr.GetObject(id, OpenMode.ForRead) is AttributeDefinition ad && !ad.Constant) l.Add(ad);
            return l;
        }

        internal static string LeaderAtt(MLeader ml, AttributeDefinition ad)
        {
            using (var ar = ml.GetBlockAttribute(ad.ObjectId)) return ar.TextString;
        }

        internal static void SetLeaderAtt(MLeader ml, AttributeDefinition ad, string v)
        {
            using (var ar = ml.GetBlockAttribute(ad.ObjectId))
            {
                ar.TextString = v;
                ml.SetBlockAttribute(ad.ObjectId, ar);
            }
        }

        static bool Dupable(Entity e) => e is Line || e is Polyline || e is Arc || e is Circle || (e is DBText && !(e is AttributeDefinition)) || e is MText || e is BlockReference || e is Dimension;

        /// <summary>
        /// clean {preview, duplicates, zero_length, empty_texts, overlapping_lines, layers?, tolerance: 0.01}: in model
        /// space, entities drawn twice (same type, layer, colour, linetype, lineweight and geometry or text) keep one;
        /// lines, arcs, circles and polylines of no size and texts with nothing written go; lines lying on the same line
        /// with the same layer and properties that overlap or touch become one line (as OVERKILL). Locked layers are
        /// left. One Undo step.
        /// </summary>
        public static object Clean(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            bool preview = p.Bool("preview", false), dup = p.Bool("duplicates", true), zero = p.Bool("zero_length", true);
            bool empty = p.Bool("empty_texts", true), over = p.Bool("overlapping_lines", true);
            double tol = Math.Max(1e-9, p.Num("tolerance", 0.01));
            var only = p.Strings("layers");
            var layers = only == null ? null : new HashSet<string>(only, StringComparer.OrdinalIgnoreCase);
            int nDup = 0, nZero = 0, nEmpty = 0, nOver = 0, nLocked = 0;
            var samples = new Dictionary<string, List<object>> { { "duplicates", new List<object>() }, { "zero_length", new List<object>() }, { "empty_texts", new List<object>() }, { "overlapping_lines", new List<object>() } };
            Action<string, Entity> note = (k, e) => { if (samples[k].Count < 20) samples[k].Add(e.Handle.ToString()); };
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lockedLayers = LockedLayers(db, tr);
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                var erase = new List<Entity>();
                var seen = new HashSet<string>();
                var lines = new List<Line>();
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || (layers != null && !layers.Contains(e.Layer))) continue;
                    if (lockedLayers.Contains(e.Layer)) { nLocked++; continue; }
                    try
                    {
                        if (zero && ((e is Line l0 && l0.Length < 1e-6) || (e is Arc a0 && a0.Radius < 1e-6) || (e is Circle c0 && c0.Radius < 1e-6) || (e is Polyline p0 && p0.Length < 1e-6)))
                        { erase.Add(e); nZero++; note("zero_length", e); continue; }
                        if (empty && ((e is DBText t0 && !(e is AttributeDefinition) && string.IsNullOrWhiteSpace(t0.TextString)) || (e is MText m0 && string.IsNullOrWhiteSpace(m0.Text))))
                        { erase.Add(e); nEmpty++; note("empty_texts", e); continue; }
                        if (dup && Dupable(e))
                        {
                            string key = Views.Sig(tr, e) + "|" + e.Color + "|" + e.Linetype + "|" + e.LineWeight + "|" + Math.Round(e.LinetypeScale, 6);
                            if (!seen.Add(key)) { erase.Add(e); nDup++; note("duplicates", e); continue; }
                        }
                        if (over && e is Line ln) lines.Add(ln);
                    }
                    catch (Exception) { }
                }
                // lines on one line: group by properties, direction and offset, merge the intervals along the direction
                var groups = new Dictionary<string, List<Line>>();
                foreach (var ln in lines)
                {
                    var v = ln.EndPoint - ln.StartPoint;
                    if (v.Length < 1e-9) continue;
                    var dir = v.GetNormal();
                    if (dir.X < -1e-9 || (Math.Abs(dir.X) <= 1e-9 && dir.Y < 0)) dir = -dir;
                    double off = -ln.StartPoint.X * dir.Y + ln.StartPoint.Y * dir.X;
                    string key = ln.Layer + "|" + ln.Color + "|" + ln.Linetype + "|" + ln.LineWeight + "|" + Math.Round(ln.LinetypeScale, 6) + "|" +
                                 Math.Round(Math.Atan2(dir.Y, dir.X), 6) + "|" + Math.Round(off / tol) + "|" + Math.Round(ln.StartPoint.Z, 3);
                    if (!groups.TryGetValue(key, out var g)) groups[key] = g = new List<Line>();
                    g.Add(ln);
                }
                foreach (var g in groups.Values)
                {
                    if (g.Count < 2) continue;
                    var v0 = (g[0].EndPoint - g[0].StartPoint).GetNormal();
                    if (v0.X < -1e-9 || (Math.Abs(v0.X) <= 1e-9 && v0.Y < 0)) v0 = -v0;
                    var iv = g.Select(ln =>
                    {
                        double t0 = ln.StartPoint.GetAsVector().DotProduct(v0), t1 = ln.EndPoint.GetAsVector().DotProduct(v0);
                        return new { ln, lo = Math.Min(t0, t1), hi = Math.Max(t0, t1) };
                    }).OrderBy(x => x.lo).ToList();
                    int i = 0;
                    while (i < iv.Count)
                    {
                        var keep = iv[i];
                        double lo = keep.lo, hi = keep.hi;
                        int j = i + 1;
                        while (j < iv.Count && iv[j].lo <= hi + tol) { hi = Math.Max(hi, iv[j].hi); j++; }
                        if (j - i > 1)
                        {
                            // the kept line stays on its own line and takes the whole length
                            var basePt = keep.ln.StartPoint - v0 * keep.ln.StartPoint.GetAsVector().DotProduct(v0);
                            if (!preview)
                            {
                                keep.ln.UpgradeOpen();
                                keep.ln.StartPoint = basePt + v0 * lo;
                                keep.ln.EndPoint = basePt + v0 * hi;
                            }
                            for (int k = i + 1; k < j; k++) { erase.Add(iv[k].ln); nOver++; note("overlapping_lines", iv[k].ln); }
                        }
                        i = j;
                    }
                }
                if (!preview)
                {
                    foreach (var e in erase.Distinct())
                    {
                        if (!e.IsWriteEnabled) e.UpgradeOpen();
                        e.Erase();
                    }
                    tr.Commit();
                }
            }
            var res = new Dictionary<string, object>
            {
                { "preview", preview }, { "duplicates", nDup }, { "zero_length", nZero }, { "empty_texts", nEmpty }, { "overlapping_lines", nOver },
                { "removed", nDup + nZero + nEmpty + nOver }, { "samples", samples },
            };
            if (nLocked > 0) res["on_locked_layers"] = nLocked;
            return res;
        }
    }
}
