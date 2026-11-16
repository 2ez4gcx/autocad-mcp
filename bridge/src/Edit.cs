// Editing drawings made by others in place: stretch (what crosses a window has its points inside moved, what lies
// inside moves whole: walls lengthen, dimensions follow, as AutoCAD's STRETCH), text find / replace across the drawing
// (texts, mtext, attributes, dimension overrides, table cells), the signatures of a drawing or of a file on disk (to
// compare two versions and cloud what changed), and the views of the layouts (viewports, the model area each shows).
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using FontDescriptor = Autodesk.AutoCAD.GraphicsInterface.FontDescriptor;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Edit
    {
        static List<object> Box(Extents3d? x) => x == null ? null : new List<object> { Math.Round(x.Value.MinPoint.X, 1), Math.Round(x.Value.MinPoint.Y, 1), Math.Round(x.Value.MaxPoint.X, 1), Math.Round(x.Value.MaxPoint.Y, 1) };

        static bool Inside(Point3d q, Point3d a, Point3d b) => q.X >= a.X - 1e-6 && q.X <= b.X + 1e-6 && q.Y >= a.Y - 1e-6 && q.Y <= b.Y + 1e-6;

        /// <summary>
        /// stretch {window: [[x0,y0],[x1,y1]], displacement: [dx,dy], layers?: [only these]}: in model space, an entity
        /// wholly inside the window moves; one that crosses it has the points that lie inside moved (the end of a wall
        /// line, the vertices of a polyline, the definition points of a dimension); one whose points all lie outside stays.
        /// Locked layers are left. One Undo step.
        /// </summary>
        public static object Stretch(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var w = p.List("window") ?? throw new McpError("stretch: window [[x0,y0],[x1,y1]] is required");
            var a0 = U.Pt(w[0], "window[0]"); var b0 = U.Pt(w[1], "window[1]");
            var a = new Point3d(Math.Min(a0.X, b0.X), Math.Min(a0.Y, b0.Y), 0); var b = new Point3d(Math.Max(a0.X, b0.X), Math.Max(a0.Y, b0.Y), 0);
            var dv = p.List("displacement") ?? throw new McpError("stretch: displacement [dx, dy] is required");
            var d = new Vector3d(P.ToNum(dv[0], "displacement[0]"), P.ToNum(dv[1], "displacement[1]"), 0);
            var only = p.Strings("layers");
            var layers = only == null ? null : new HashSet<string>(only, StringComparer.OrdinalIgnoreCase);
            int moved = 0, stretched = 0, locked = 0, failed = 0;
            var handles = new List<object>();
            Extents3d? before = null, after = null;
            // closed polylines stretched (room outlines): their area before, so the area written inside can follow
            var oldAreas = new Dictionary<ObjectId, double>();
            var areaChanges = new List<object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var lockedLayers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId id in lt) { var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead); if (l.IsLocked) lockedLayers.Add(l.Name); }
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                var mv = Matrix3d.Displacement(d);
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || (layers != null && !layers.Contains(e.Layer))) continue;
                    Extents3d? x = U.Ext(e);
                    if (x == null) continue;
                    var xv = x.Value;
                    if (xv.MaxPoint.X < a.X || xv.MinPoint.X > b.X || xv.MaxPoint.Y < a.Y || xv.MinPoint.Y > b.Y) continue;
                    if (lockedLayers.Contains(e.Layer)) { locked++; continue; }
                    try
                    {
                        bool whole = Inside(xv.MinPoint, a, b) && Inside(xv.MaxPoint, a, b);
                        if (whole)
                        {
                            e.UpgradeOpen();
                            U.Grow(ref before, x);
                            e.TransformBy(mv);
                            U.Grow(ref after, U.Ext(e));
                            moved++;
                            handles.Add(e.Handle.ToString());
                            continue;
                        }
                        // a hatch not tied to its boundary gives no stretch points: its loops are stretched vertex by vertex
                        if (e is Hatch hat0 && !hat0.Associative)
                        {
                            int hr = StretchHatch(hat0, a, b, d);
                            if (hr == 0) continue;
                            if (hr < 0) { failed++; continue; }
                            U.Grow(ref before, x);
                            U.Grow(ref after, U.Ext(e));
                            stretched++;
                            handles.Add(e.Handle.ToString());
                            continue;
                        }
                        var pts = new Point3dCollection();
                        e.GetStretchPoints(pts);
                        var idx = new IntegerCollection();
                        for (int i = 0; i < pts.Count; i++) if (Inside(pts[i], a, b)) idx.Add(i);
                        if (idx.Count == 0) continue;
                        if (e is Polyline pa && pa.Closed && idx.Count < pts.Count) oldAreas[id] = pa.Area;
                        e.UpgradeOpen();
                        U.Grow(ref before, x);
                        if (idx.Count == pts.Count) e.TransformBy(mv);
                        else e.MoveStretchPointsAt(idx, d);
                        U.Grow(ref after, U.Ext(e));
                        stretched++;
                        handles.Add(e.Handle.ToString());
                    }
                    catch (Exception) { failed++; }
                }
                if (p.Bool("update_areas", true) && oldAreas.Count > 0) AreaTexts(db, tr, ms, oldAreas, lockedLayers, areaChanges);
                tr.Commit();
            }
            var r = new Dictionary<string, object> { { "moved", moved }, { "stretched", stretched }, { "handles", handles }, { "before", Box(before) }, { "after", Box(after) } };
            if (areaChanges.Count > 0) r["areas_updated"] = areaChanges;
            if (locked > 0) r["locked"] = locked;
            if (failed > 0) r["failed"] = failed;
            return r;
        }

        internal static bool InPoly(List<Point2d> poly, Point3d q)
        {
            bool c = false;
            for (int i = 0, j = poly.Count - 1; i < poly.Count; j = i++)
                if ((poly[i].Y > q.Y) != (poly[j].Y > q.Y) && q.X < (poly[j].X - poly[i].X) * (q.Y - poly[i].Y) / (poly[j].Y - poly[i].Y) + poly[i].X) c = !c;
            return c;
        }

        /// <summary>
        /// The texts that write the area of a room whose outline changed: a text inside the outline that reads like an
        /// area (m2, m², S =, DT, DIỆN TÍCH, AREA, 面積, or only a number) and holds the old area, rounded as it is
        /// written, gets the new one in the same form ("5,06 m²" -> "5,36 m²").
        /// </summary>
        static void AreaTexts(Database db, Transaction tr, BlockTableRecord ms, Dictionary<ObjectId, double> oldAreas, HashSet<string> lockedLayers, List<object> changes)
        {
            double toM = U.ToMetres(db), k2 = toM * toM;
            var texts = new List<Entity>();
            foreach (ObjectId id in ms)
            {
                var t = tr.GetObject(id, OpenMode.ForRead) as Entity;
                if ((t is DBText && !(t is AttributeDefinition)) || t is MText) texts.Add(t);
            }
            var num = new Regex(@"(?<![\d.,])(\d+)([.,])(\d{1,3})(?!\d)");
            var areaWord = new Regex(@"m2|m²|㎡|\bS\s*=|\bDT\b|DIỆN TÍCH|AREA|面積|面积", RegexOptions.IgnoreCase);
            foreach (var kv in oldAreas)
            {
                var pl = (Polyline)tr.GetObject(kv.Key, OpenMode.ForRead);
                double a0 = kv.Value * k2, a1 = pl.Area * k2;
                if (Math.Abs(a1 - a0) < 0.005) continue;
                var poly = new List<Point2d>();
                for (int i = 0; i < pl.NumberOfVertices; i++) poly.Add(pl.GetPoint2dAt(i));
                foreach (var t in texts)
                {
                    if (lockedLayers.Contains(t.Layer)) continue;
                    var dt = t as DBText;
                    Point3d at = dt != null ? (dt.Justify == AttachmentPoint.BaseLeft ? dt.Position : dt.AlignmentPoint) : ((MText)t).Location;
                    if (!InPoly(poly, at)) continue;
                    string s0 = dt != null ? dt.TextString : ((MText)t).Contents;
                    if (!areaWord.IsMatch(s0) && !Regex.IsMatch(s0.Trim(), @"^\d+[.,]\d{1,3}$")) continue;
                    string s1 = num.Replace(s0, m =>
                    {
                        int dec = m.Groups[3].Value.Length;
                        double v = double.Parse(m.Groups[1].Value + "." + m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture);
                        if (Math.Abs(v - Math.Round(a0, dec)) > 0.5 * Math.Pow(10, -dec) + 1e-9) return m.Value;
                        return Math.Round(a1, dec).ToString("F" + dec, System.Globalization.CultureInfo.InvariantCulture).Replace(".", m.Groups[2].Value);
                    });
                    if (s1 == s0) continue;
                    t.UpgradeOpen();
                    if (dt != null) dt.TextString = s1; else ((MText)t).Contents = s1;
                    changes.Add(new Dictionary<string, object> { { "handle", t.Handle.ToString() }, { "from", s0 }, { "to", s1 }, { "outline", pl.Handle.ToString() } });
                }
            }
        }

        /// <summary>
        /// The loops of a hatch with their vertices inside the window [a, b] moved by d (lines and polyline loops; an arc
        /// moves only whole). 0: nothing inside, 1: stretched, -1: a loop it cannot stretch (left as it was).
        /// </summary>
        static int StretchHatch(Hatch h, Point3d a, Point3d b, Vector3d d)
        {
            var dv = new Vector2d(d.X, d.Y);
            Func<Point2d, bool> ins = q => q.X >= a.X - 1e-6 && q.X <= b.X + 1e-6 && q.Y >= a.Y - 1e-6 && q.Y <= b.Y + 1e-6;
            int n = h.NumberOfLoops;
            var types = new List<HatchLoopTypes>();
            var polys = new List<BulgeVertexCollection>();
            var edges = new List<Curve2dCollection>();
            var kinds = new List<IntegerCollection>();
            bool any = false;
            for (int i = 0; i < n; i++)
            {
                HatchLoop lp = h.GetLoopAt(i);
                types.Add(h.LoopTypeAt(i));
                if (lp.IsPolyline)
                {
                    var pv = new BulgeVertexCollection();
                    foreach (BulgeVertex v in lp.Polyline)
                    {
                        bool m = ins(v.Vertex);
                        any |= m;
                        pv.Add(new BulgeVertex(m ? v.Vertex + dv : v.Vertex, v.Bulge));
                    }
                    polys.Add(pv); edges.Add(null); kinds.Add(null);
                    continue;
                }
                // lines and arcs head to tail: the loop becomes a polyline loop (its vertices and bulges); vertices in the
                // window move and every arc keeps its bulge, as STRETCH keeps the bulge of a polyline arc
                var nv = new BulgeVertexCollection();
                Point2d? prevEnd = null;
                foreach (Curve2d c in lp.Curves)
                {
                    Point2d s0 = c.StartPoint, e0 = c.EndPoint;
                    if (prevEnd != null && prevEnd.Value.GetDistanceTo(s0) > 1e-3) return -1; // not head to tail
                    prevEnd = e0;
                    if (c is CircularArc2d ca)
                    {
                        Vector2d ch = e0 - s0;
                        if (ch.Length < 1e-9)
                        {
                            // a full circle (a round hole): two half circles
                            var q0 = ca.Center - new Vector2d(ca.Radius, 0); var q1 = ca.Center + new Vector2d(ca.Radius, 0);
                            double sg = ca.IsClockWise ? -1 : 1;
                            bool mq0 = ins(q0), mq1 = ins(q1);
                            any |= mq0 || mq1;
                            nv.Add(new BulgeVertex(mq0 ? q0 + dv : q0, sg));
                            nv.Add(new BulgeVertex(mq1 ? q1 + dv : q1, sg));
                            continue;
                        }
                        var iv = ca.GetInterval();
                        Point2d mid = ca.EvaluatePoint((iv.LowerBound + iv.UpperBound) / 2);
                        var cm = new Point2d((s0.X + e0.X) / 2, (s0.Y + e0.Y) / 2);
                        // bulge = 2 x rise / chord, positive when the arc runs counter-clockwise (it lies right of the chord)
                        double bulge = 2 * (mid - cm).Length / ch.Length * (ch.X * (mid.Y - s0.Y) - ch.Y * (mid.X - s0.X) < 0 ? 1 : -1);
                        bool ma = ins(s0);
                        any |= ma;
                        nv.Add(new BulgeVertex(ma ? s0 + dv : s0, bulge));
                    }
                    else if (c is LineSegment2d)
                    {
                        bool ml = ins(s0);
                        any |= ml;
                        nv.Add(new BulgeVertex(ml ? s0 + dv : s0, 0));
                    }
                    else return -1; // ellipses and splines in a boundary: not stretched
                }
                // a polyline loop is closed by its first vertex written again at its end
                if (nv.Count > 1) nv.Add(new BulgeVertex(nv[0].Vertex, 0));
                polys.Add(nv); edges.Add(null); kinds.Add(null);
            }
            if (!any) return 0;
            h.UpgradeOpen();
            for (int i = n - 1; i >= 0; i--) h.RemoveLoopAt(i);
            for (int i = 0; i < n; i++)
            {
                if (polys[i] != null)
                {
                    var vs = new Point2dCollection();
                    var bs = new DoubleCollection();
                    foreach (BulgeVertex v in polys[i]) { vs.Add(v.Vertex); bs.Add(v.Bulge); }
                    h.AppendLoop(types[i] | HatchLoopTypes.Polyline, vs, bs); // a loop rebuilt from edges is now a polyline loop
                }
                else h.AppendLoop(types[i], edges[i], kinds[i]);
            }
            h.EvaluateHatch(true);
            return 1;
        }

        /// <summary>
        /// replace_text {find, replace, regex, case_sensitive, whole_word, layers, preview}: texts, mtext, attributes,
        /// dimension text overrides and table cells of model space, the layouts and the block definitions. preview
        /// lists the changes without making them.
        /// </summary>
        public static object ReplaceText(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string find = p.ReqStr("find"), repl = p.Str("replace") ?? "";
            bool preview = p.Bool("preview", false), isRegex = p.Bool("regex", false);
            var opts = p.Bool("case_sensitive", false) ? RegexOptions.None : RegexOptions.IgnoreCase;
            string pat = isRegex ? find : Regex.Escape(find);
            if (p.Bool("whole_word", false)) pat = @"(?<![\p{L}\p{N}_])" + pat + @"(?![\p{L}\p{N}_])";
            Regex re;
            try { re = new Regex(pat, opts); } catch (ArgumentException ex) { throw new McpError("replace_text: find is not a valid pattern: " + ex.Message); }
            bool inBlocks = p.Bool("blocks", true);
            var only = p.Strings("layers");
            var layers = only == null ? null : new HashSet<string>(only, StringComparer.OrdinalIgnoreCase);
            var changes = new List<object>();
            int count = 0, locked = 0;
            Extents3d? where = null;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var lockedLayers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId id in lt) { var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead); if (l.IsLocked) lockedLayers.Add(l.Name); }
                BlockTableRecord bt;
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                Action<Entity, string, Func<string>, Action<string>, string> one = (e, kind, get, set, space) =>
                {
                    if (layers != null && !layers.Contains(e.Layer)) return;
                    string s0 = get();
                    if (string.IsNullOrEmpty(s0) || !re.IsMatch(s0)) return;
                    string s1 = re.Replace(s0, repl);
                    if (s1 == s0) return;
                    if (lockedLayers.Contains(e.Layer)) { locked++; return; }
                    count++;
                    var ex = space == "model" ? U.Ext(e) : null;
                    if (changes.Count < 500)
                    {
                        var c = new Dictionary<string, object> { { "handle", e.Handle.ToString() }, { "kind", kind }, { "space", space }, { "layer", e.Layer }, { "from", s0.Length > 120 ? s0.Substring(0, 120) + "…" : s0 }, { "to", s1.Length > 120 ? s1.Substring(0, 120) + "…" : s1 } };
                        if (ex != null) c["b"] = Box(ex);
                        changes.Add(c);
                    }
                    U.Grow(ref where, ex);
                    if (preview) return;
                    if (!e.IsWriteEnabled) e.UpgradeOpen();
                    set(s1);
                };
                foreach (ObjectId bid in table)
                {
                    bt = (BlockTableRecord)tr.GetObject(bid, OpenMode.ForRead);
                    if (bt.IsFromExternalReference || bt.IsDependent) continue;
                    // dimension and table blocks are drawn from their dimension or table: changed there, not here
                    if (bt.IsAnonymous && (bt.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase) || bt.Name.StartsWith("*T", StringComparison.OrdinalIgnoreCase))) continue;
                    if (!bt.IsLayout && !inBlocks) continue;
                    string space = bt.IsLayout ? (bt.Name.Equals(BlockTableRecord.ModelSpace, StringComparison.OrdinalIgnoreCase) ? "model" : "paper") : "block";
                    foreach (ObjectId id in bt)
                    {
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        switch (e)
                        {
                            case DBText t when !(e is AttributeDefinition): one(t, "text", () => t.TextString, v => t.TextString = v, space); break;
                            case AttributeDefinition ad: one(ad, "attribute default", () => ad.TextString, v => ad.TextString = v, space); break;
                            case MText m: one(m, "mtext", () => m.Contents, v => m.Contents = v, space); break;
                            case Dimension dm: one(dm, "dimension override", () => dm.DimensionText, v => dm.DimensionText = v, space); break;
                            case Table tb:
                                for (int r = 0; r < tb.Rows.Count; r++)
                                    for (int c = 0; c < tb.Columns.Count; c++)
                                    {
                                        int rr = r, cc = c;
                                        one(tb, "table cell", () => tb.Cells[rr, cc].TextString, v => tb.Cells[rr, cc].TextString = v, space);
                                    }
                                break;
                            case BlockReference br:
                                foreach (ObjectId aid in br.AttributeCollection)
                                {
                                    var at = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                                    if (at != null) one(at, "attribute", () => at.TextString, v => at.TextString = v, space);
                                }
                                break;
                            case MLeader mlm when mlm.ContentType == ContentType.MTextContent:
                                {
                                    var mt = mlm.MText;
                                    if (mt != null) one(mlm, "mleader", () => mt.Contents, v => { mt.Contents = v; mlm.MText = mt; }, space);
                                    break;
                                }
                            case MLeader mlb when mlb.ContentType == ContentType.BlockContent:
                                foreach (var ad in Review.LeaderAttDefs(tr, mlb))
                                {
                                    var a2 = ad;
                                    one(mlb, "mleader attribute " + a2.Tag, () => Review.LeaderAtt(mlb, a2), v => Review.SetLeaderAtt(mlb, a2, v), space);
                                }
                                break;
                        }
                    }
                }
                if (!preview) tr.Commit();
            }
            var res = new Dictionary<string, object> { { "count", count }, { "preview", preview }, { "changes", changes }, { "bounds", Box(where) } };
            if (count > changes.Count) res["listed"] = changes.Count;
            if (locked > 0) res["locked"] = locked;
            return res;
        }

        sealed class Rec { public string S, T, L, H; public Extents3d X; public List<object> P, Q, TP; public bool C; }

        /// <summary>The loops of a hatch, each its vertices (x, y, x, y...): its boundary for the comparison.</summary>
        static List<object> Loops(Hatch h)
        {
            var o = new List<object>();
            try
            {
                for (int i = 0; i < h.NumberOfLoops; i++)
                {
                    var v = new List<object>();
                    HatchLoop lp = h.GetLoopAt(i);
                    if (lp.IsPolyline) foreach (BulgeVertex bv in lp.Polyline) { v.Add(Math.Round(bv.Vertex.X, 1)); v.Add(Math.Round(bv.Vertex.Y, 1)); }
                    else foreach (Curve2d c in lp.Curves) { v.Add(Math.Round(c.StartPoint.X, 1)); v.Add(Math.Round(c.StartPoint.Y, 1)); }
                    if (v.Count >= 4) o.Add(v);
                }
            }
            catch (Exception) { return null; }
            return o.Count > 0 ? o : null;
        }

        sealed class Enc { public string Name, Capitals; public List<string> Prefixes, Styles; public Dictionary<string, string> Map = new Dictionary<string, string>(); }

        /// <summary>The entities of model space as signatures (view_diff's), with their extents and vertices.</summary>
        static List<Rec> Records(Database db, Point3d? wa, Point3d? wb, bool withLayer, HashSet<string> skip)
        {
            var list = new List<Rec>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var ms = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForRead);
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || skip.Contains(e.Layer)) continue;
                    // the clouds of a revision (drawn by revision_cloud and the revision of the tools) are not the drawing
                    if ((Views.TagOf(e) ?? "").StartsWith("revision:", StringComparison.Ordinal)) continue;
                    var x = U.Ext(e);
                    if (x == null) continue;
                    if (wa != null && (x.Value.MaxPoint.X < wa.Value.X || x.Value.MinPoint.X > wb.Value.X || x.Value.MaxPoint.Y < wa.Value.Y || x.Value.MinPoint.Y > wb.Value.Y)) continue;
                    string sg = Views.Sig(tr, e);
                    var parts = sg.Split(new[] { '|' }, 3);
                    if (!withLayer && parts.Length == 3) sg = parts[0] + "||" + parts[2];
                    var rec = new Rec { S = sg, T = parts[0], L = parts.Length > 1 ? parts[1] : "", H = e.Handle.ToString(), X = x.Value, P = Verts(e), C = e is Polyline pc && pc.Closed };
                    if (e is Hatch hh) rec.Q = Loops(hh);
                    if (e is Dimension dd) rec.TP = new List<object> { Math.Round(dd.TextPosition.X, 1), Math.Round(dd.TextPosition.Y, 1) };
                    list.Add(rec);
                }
                tr.Commit();
            }
            return list;
        }

        /// <summary>
        /// drawing_diff {previous, window?, layers: true, skip_layers?, max: 4000}: model space of the current drawing
        /// against model space of a DWG on disk (an earlier version: read in the background, never opened in the
        /// editor), entity by entity on view_diff's signatures (type, layer, rounded geometry, text). Returns what is
        /// only in the earlier one (removed) and only in the current one (added), with extents and the vertices of
        /// lines and polylines; modified: the handles in both lists (the same entity changed). layers: false leaves
        /// layer changes out (a drawing compared with its standardised copy). The revision clouds of these tools are left out.
        /// </summary>
        public static object Diff(Ctx ctx, P p)
        {
            string path = p.ReqStr("previous");
            bool withLayer = p.Bool("layers", true);
            int max = (int)p.Num("max", 4000);
            var skip = new HashSet<string>(p.Strings("skip_layers") ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
            var w = p.List("window");
            Point3d? wa = null, wb = null;
            if (w != null && w.Count == 2)
            {
                var a0 = U.Pt(w[0], "window[0]"); var b0 = U.Pt(w[1], "window[1]");
                wa = new Point3d(Math.Min(a0.X, b0.X), Math.Min(a0.Y, b0.Y), 0); wb = new Point3d(Math.Max(a0.X, b0.X), Math.Max(a0.Y, b0.Y), 0);
            }
            path = System.IO.Path.GetFullPath(path);
            if (!System.IO.File.Exists(path)) throw new McpError("drawing_diff: no file " + path);
            List<Rec> before;
            using (var side = new Database(false, true))
            {
                side.ReadDwgFile(path, System.IO.FileShare.ReadWrite, true, null);
                side.CloseInput(true);
                before = Records(side, wa, wb, withLayer, skip);
            }
            var now = Records(ctx.Db, wa, wb, withLayer, skip);
            var bag = new Dictionary<string, List<Rec>>();
            foreach (var r in now) { if (!bag.TryGetValue(r.S, out var l)) bag[r.S] = l = new List<Rec>(); l.Add(r); }
            var removed = new List<Rec>();
            int same = 0;
            foreach (var r in before)
            {
                if (bag.TryGetValue(r.S, out var l) && l.Count > 0)
                {
                    int k = l.FindIndex(q => q.H == r.H);
                    l.RemoveAt(k >= 0 ? k : l.Count - 1);
                    same++;
                }
                else removed.Add(r);
            }
            var added = bag.Values.SelectMany(l => l).ToList();
            var gone = new HashSet<string>(removed.Select(r => r.H));
            int modified = added.Count(r => gone.Contains(r.H));
            // by layer: what changed where
            var by = new Dictionary<string, int[]>();
            foreach (var r in removed) { if (!by.TryGetValue(r.L, out var c)) by[r.L] = c = new int[2]; c[0]++; }
            foreach (var r in added) { if (!by.TryGetValue(r.L, out var c)) by[r.L] = c = new int[2]; c[1]++; }
            Func<Rec, object> item = r =>
            {
                var d = new Dictionary<string, object> { { "b", Box(r.X) }, { "t", r.T }, { "l", r.L }, { "h", r.H } };
                if (r.P != null) d["p"] = r.P;
                if (r.C) d["c"] = true;
                if (r.Q != null) d["q"] = r.Q;
                if (r.TP != null) d["tp"] = r.TP;
                return d;
            };
            var res = new Dictionary<string, object>
            {
                { "previous", path }, { "current", ctx.Doc?.Name }, { "known", true },
                { "before", before.Count }, { "now", now.Count }, { "same", same }, { "modified", modified },
                { "removed", removed.Take(max).Select(item).ToList() }, { "added", added.Take(max).Select(item).ToList() },
                { "removed_count", removed.Count }, { "added_count", added.Count },
                { "by_layer", by.OrderByDescending(kv => kv.Value[0] + kv.Value[1]).Take(30).Select(kv => (object)new Dictionary<string, object> { { "layer", kv.Key }, { "removed", kv.Value[0] }, { "added", kv.Value[1] } }).ToList() },
            };
            if (removed.Count > max || added.Count > max) res["truncated"] = true;
            return res;
        }

        static List<object> Verts(Entity e)
        {
            var v = new List<object>();
            if (e is Line l) { v.Add(Math.Round(l.StartPoint.X, 1)); v.Add(Math.Round(l.StartPoint.Y, 1)); v.Add(Math.Round(l.EndPoint.X, 1)); v.Add(Math.Round(l.EndPoint.Y, 1)); return v; }
            if (e is Polyline pl) { for (int i = 0; i < pl.NumberOfVertices; i++) { var q = pl.GetPoint3dAt(i); v.Add(Math.Round(q.X, 1)); v.Add(Math.Round(q.Y, 1)); } return v; }
            return null;
        }

        static List<object> Box(Extents3d x) => Box((Extents3d?)x);

        /// <summary>
        /// model_map {max_texts: 20000}: what tells the parts of a drawing apart, from model space: the texts (with
        /// the attributes of block references) [x, y, height, text, layer, rotation, tag?], the rectangles that may be
        /// sheet frames (closed 4-corner polylines, sides 1.2-2.3 to 1, from 400 units) [x0, y0, x1, y1, layer] and
        /// the block references that may be frames or title blocks (large, or with attributes) with their attributes.
        /// </summary>
        public static object ModelMap(Ctx ctx, P p) => Review.WithDb(ctx, p, (db, name) => ModelMapOf(db, name, p));

        static object ModelMapOf(Database db, string name, P p)
        {
            int maxTexts = (int)p.Num("max_texts", 20000);
            var texts = new List<object>();
            var rects = new List<object>();
            var inserts = new List<object>();
            var blockTexts = new List<object>();
            var lines = new List<object>();
            Extents3d? all = null;
            Func<double, double> R = v => Math.Round(v, 1);
            double[] sides = { 1189, 841, 594, 420, 297, 210 };
            double[] scales = { 1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 1000 };
            Func<double, bool> paperSide = len => sides.Any(sd => scales.Any(sc => Math.Abs(len / sc - sd) / sd < 0.015));
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    var x = U.Ext(e);
                    if (x != null) U.Grow(ref all, x);
                    if (e is Line ln && lines.Count < 5000)
                    {
                        double dx = Math.Abs(ln.EndPoint.X - ln.StartPoint.X), dy = Math.Abs(ln.EndPoint.Y - ln.StartPoint.Y), len = ln.Length;
                        if (len >= 400 && (dx < 1e-6 * len || dy < 1e-6 * len) && paperSide(len))
                            lines.Add(new List<object> { R(ln.StartPoint.X), R(ln.StartPoint.Y), R(ln.EndPoint.X), R(ln.EndPoint.Y), ln.Layer });
                    }
                    else if (e is DBText t)
                    {
                        if (texts.Count < maxTexts && !string.IsNullOrWhiteSpace(t.TextString))
                        {
                            var at = t.Justify == AttachmentPoint.BaseLeft ? t.Position : t.AlignmentPoint;
                            texts.Add(new List<object> { R(at.X), R(at.Y), R(t.Height), t.TextString, t.Layer, Math.Round(t.Rotation * 180 / Math.PI, 1), null, t.TextStyleName });
                        }
                    }
                    else if (e is MText m)
                    {
                        if (texts.Count < maxTexts && !string.IsNullOrWhiteSpace(m.Text))
                            texts.Add(new List<object> { R(m.Location.X), R(m.Location.Y), R(m.TextHeight), m.Text, m.Layer, Math.Round(m.Rotation * 180 / Math.PI, 1), null, m.TextStyleName });
                    }
                    else if (e is Polyline pl && x != null)
                    {
                        int n = pl.NumberOfVertices;
                        if (n > 1 && pl.GetPoint3dAt(0).DistanceTo(pl.GetPoint3dAt(n - 1)) < 1e-6) n--;
                        if ((pl.Closed || n < pl.NumberOfVertices) && n == 4)
                        {
                            double w = x.Value.MaxPoint.X - x.Value.MinPoint.X, h = x.Value.MaxPoint.Y - x.Value.MinPoint.Y;
                            double r = Math.Max(w, h) / Math.Max(1e-9, Math.Min(w, h));
                            bool square = true;
                            for (int i = 0; i < 4; i++)
                            {
                                var q = pl.GetPoint3dAt(i);
                                if (Math.Abs(q.X - x.Value.MinPoint.X) > 1e-3 * w && Math.Abs(q.X - x.Value.MaxPoint.X) > 1e-3 * w) square = false;
                                if (Math.Abs(q.Y - x.Value.MinPoint.Y) > 1e-3 * h && Math.Abs(q.Y - x.Value.MaxPoint.Y) > 1e-3 * h) square = false;
                            }
                            if (square && Math.Max(w, h) >= 400 && r >= 1.2 && r <= 2.3 && rects.Count < 3000)
                                rects.Add(new List<object> { R(x.Value.MinPoint.X), R(x.Value.MinPoint.Y), R(x.Value.MaxPoint.X), R(x.Value.MaxPoint.Y), pl.Layer });
                        }
                    }
                    else if (e is BlockReference br && x != null)
                    {
                        var attrs = new Dictionary<string, object>();
                        foreach (ObjectId aid in br.AttributeCollection)
                        {
                            if (!(tr.GetObject(aid, OpenMode.ForRead) is AttributeReference a) || a.Invisible || string.IsNullOrWhiteSpace(a.TextString)) continue;
                            attrs[a.Tag] = a.TextString;
                            if (texts.Count < maxTexts)
                            {
                                var at = a.Justify == AttachmentPoint.BaseLeft ? a.Position : a.AlignmentPoint;
                                texts.Add(new List<object> { R(at.X), R(at.Y), R(a.Height), a.TextString, a.Layer, Math.Round(a.Rotation * 180 / Math.PI, 1), a.Tag, a.TextStyleName });
                            }
                        }
                        double w = x.Value.MaxPoint.X - x.Value.MinPoint.X, h = x.Value.MaxPoint.Y - x.Value.MinPoint.Y;
                        double r = Math.Max(w, h) / Math.Max(1e-9, Math.Min(w, h));
                        bool frameLike = Math.Max(w, h) >= 400 && r >= 1.2 && r <= 2.3;
                        // the texts written in a frame block's definition (the drawing number, the sheet name of a frame
                        // made for one sheet), where they stand in the drawing
                        if (frameLike && blockTexts.Count < 20000)
                        {
                            var def = (BlockTableRecord)tr.GetObject(br.BlockTableRecord, OpenMode.ForRead);
                            var bm = br.BlockTransform;
                            double sc = Math.Abs(br.ScaleFactors.Y);
                            int n0 = 0;
                            foreach (ObjectId did in def)
                            {
                                if (n0 >= 300) break;
                                var de = tr.GetObject(did, OpenMode.ForRead);
                                string s0 = null; Point3d q = Point3d.Origin; double th = 0;
                                if (de is AttributeDefinition ad) { if (!ad.Constant) continue; s0 = ad.TextString; q = ad.Position; th = ad.Height; }
                                else if (de is DBText dt) { s0 = dt.TextString; q = dt.Justify == AttachmentPoint.BaseLeft ? dt.Position : dt.AlignmentPoint; th = dt.Height; }
                                else if (de is MText mt) { s0 = mt.Text; q = mt.Location; th = mt.TextHeight; }
                                if (string.IsNullOrWhiteSpace(s0)) continue;
                                var wq = q.TransformBy(bm);
                                blockTexts.Add(new List<object> { R(wq.X), R(wq.Y), R(th * sc), s0, br.Handle.ToString() });
                                n0++;
                            }
                        }
                        if ((frameLike || attrs.Count > 0) && inserts.Count < 3000)
                            inserts.Add(new Dictionary<string, object> { { "name", U.BlockName(tr, br) }, { "box", Box(x) }, { "layer", br.Layer }, { "attributes", attrs }, { "handle", br.Handle.ToString() } });
                    }
                }
            }
            return new Dictionary<string, object>
            {
                { "drawing", name }, { "extents", Box(all) }, { "texts", texts }, { "rects", rects }, { "inserts", inserts },
                { "block_texts", blockTexts }, { "lines", lines },
                { "truncated", texts.Count >= maxTexts },
            };
        }

        /// <summary>
        /// convert_text {map: {char: text}, font_prefixes: [".Vn"], font: "Arial", preview}: texts written for a legacy
        /// Vietnamese font (TCVN3 / ABC: .VnTime, .VnArial...; the fonts whose name ends in H show capitals) turned into
        /// Unicode, character by character through map, and their text styles moved to a Unicode font. Texts, mtext
        /// (inline font changes followed), attributes, attribute definitions, dimension overrides and mleaders of every
        /// space and block definition. A text in a legacy style that already holds Unicode Vietnamese is left.
        /// </summary>
        public static object ConvertText(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            // the encodings: font name prefixes, a map of one or two characters, the font name suffix that shows capitals
            var encs = new List<Enc>();
            foreach (var o in p.List("encodings") ?? new List<object>())
            {
                var ep = new P(o, "encodings");
                var en = new Enc { Name = ep.Str("name") ?? "legacy", Prefixes = ep.Strings("prefixes") ?? new List<string>(), Capitals = ep.Str("capitals_suffix"), Styles = ep.Strings("styles") ?? new List<string>() };
                var mp = ep.Obj("map");
                if (mp != null)
                    foreach (var kv in mp.D)
                        if (kv.Key.Length >= 1 && kv.Key.Length <= 2 && kv.Value != null) en.Map[kv.Key] = Convert.ToString(kv.Value, System.Globalization.CultureInfo.InvariantCulture);
                encs.Add(en);
            }
            if (encs.Count == 0) throw new McpError("convert_text: encodings [{name, prefixes, map}] are required");
            string font = p.Str("font") ?? "Arial";
            bool preview = p.Bool("preview", false);
            Func<string, string> bare = n =>
            {
                n = (n ?? "").Trim();
                if (n.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase) || n.EndsWith(".shx", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
                return n;
            };
            // the encoding of a font (index into encs) or -1; capitals when its name ends in the suffix
            Func<string, int> encOf = n => { n = bare(n); return n.Length == 0 ? -1 : encs.FindIndex(x => x.Prefixes.Any(pr => n.StartsWith(pr, StringComparison.OrdinalIgnoreCase))); };
            Func<string, bool> capitals = n => { int k = encOf(n); return k >= 0 && !string.IsNullOrEmpty(encs[k].Capitals) && bare(n).EndsWith(encs[k].Capitals, StringComparison.Ordinal); };
            // already Unicode Vietnamese: letters a legacy font cannot hold
            Func<string, bool> unicode = s0 => s0.Any(c => c == '\u0103' || c == '\u0102' || c == '\u01A1' || c == '\u01A0' || c == '\u01B0' || c == '\u01AF' || c == '\u0111' || c == '\u0110' || (c >= '\u1EA0' && c <= '\u1EF9'));
            // one run of characters through an encoding: two-character sequences first, %% codes kept
            Action<StringBuilder, string, int, bool> run = (sb, s0, k, up) =>
            {
                var map = encs[k].Map;
                for (int i = 0; i < s0.Length; i++)
                {
                    char c = s0[i];
                    if (c == '%' && i + 2 < s0.Length && s0[i + 1] == '%') { sb.Append(s0, i, 3); i += 2; continue; }
                    string r;
                    if (i + 1 < s0.Length && map.TryGetValue(s0.Substring(i, 2), out r)) { sb.Append(up ? r.ToUpperInvariant() : r); i++; continue; }
                    if (map.TryGetValue(c.ToString(), out r)) sb.Append(up ? r.ToUpperInvariant() : r);
                    else sb.Append(up ? char.ToUpperInvariant(c) : c);
                }
            };
            Func<string, int, bool, string> plain = (s0, k, up) => { var sb = new StringBuilder(); run(sb, s0, k, up); return sb.ToString(); };
            Func<string, int, bool, string> mtext = (s0, k0, up0) =>
            {
                var sb = new StringBuilder();
                var stack = new Stack<int>();
                int k = k0;
                bool up = up0;
                var seg = new StringBuilder();
                Action flush = () =>
                {
                    if (seg.Length == 0) return;
                    if (k >= 0) run(sb, seg.ToString(), k, up); else sb.Append(seg);
                    seg.Clear();
                };
                for (int i = 0; i < s0.Length; i++)
                {
                    char c = s0[i];
                    if (c == '\\' && i + 1 < s0.Length)
                    {
                        char kc = s0[i + 1];
                        if ("PLlOoKkNX~\\{}".IndexOf(kc) >= 0) { flush(); sb.Append(c).Append(kc); i++; continue; }
                        int j = s0.IndexOf(';', i);
                        if (j < 0) { flush(); sb.Append(s0.Substring(i)); break; }
                        flush();
                        string code = s0.Substring(i, j - i + 1);
                        if (kc == 'f')
                        {
                            var parts = code.Substring(2, code.Length - 3).Split('|');
                            k = encOf(parts[0]);
                            up = capitals(parts[0]);
                            if (k >= 0) code = "\\f" + font + string.Concat(parts.Skip(1).Select(x => "|" + (x.StartsWith("c") ? "c0" : x))) + ";";
                        }
                        sb.Append(code);
                        i = j;
                        continue;
                    }
                    if (c == '{') { flush(); stack.Push(((k + 1) << 1) | (up ? 1 : 0)); sb.Append(c); continue; }
                    if (c == '}') { flush(); if (stack.Count > 0) { int v = stack.Pop(); k = (v >> 1) - 1; up = (v & 1) != 0; } sb.Append(c); continue; }
                    seg.Append(c);
                }
                flush();
                return sb.ToString();
            };
            var samples = new List<object>();
            var byStyle = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            int count = 0, skipped = 0, lockedN = 0, failed = 0;
            var styles = new List<object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var lockedLayers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId id in lt) { var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead); if (l.IsLocked) lockedLayers.Add(l.Name); }
                // the legacy styles: style -> (encoding, capitals)
                var st = new Dictionary<ObjectId, int>();
                var stUp = new HashSet<ObjectId>();
                var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                foreach (ObjectId id in tst)
                {
                    var ts = (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    string face = "";
                    try { face = ts.Font.TypeFace; } catch (Exception) { }
                    string which = encOf(face) >= 0 ? face : encOf(ts.FileName) >= 0 ? ts.FileName : null;
                    if (which == null)
                    {
                        // a style named by the caller: its texts read as that encoding whatever its font is called
                        int fk = encs.FindIndex(x => x.Styles.Any(n => n.Equals(ts.Name, StringComparison.OrdinalIgnoreCase)));
                        if (fk < 0) continue;
                        st[id] = fk;
                        styles.Add(new Dictionary<string, object> { { "style", ts.Name }, { "font", string.IsNullOrEmpty(face) ? ts.FileName : face }, { "encoding", encs[fk].Name }, { "capitals", false }, { "named", true } });
                        continue;
                    }
                    st[id] = encOf(which);
                    if (capitals(which)) stUp.Add(id);
                    styles.Add(new Dictionary<string, object> { { "style", ts.Name }, { "font", which }, { "encoding", encs[encOf(which)].Name }, { "capitals", capitals(which) } });
                }
                Func<Entity, ObjectId, string, Func<string>, Action<string>, bool, bool> one = (e, style, kind, get, set, isM) =>
                {
                    int k = st.TryGetValue(style, out int k0) ? k0 : -1;
                    bool up = stUp.Contains(style);
                    string s0 = get();
                    if (string.IsNullOrEmpty(s0)) return false;
                    if (k < 0 && !(isM && s0.Contains("\\f"))) return false;
                    if (k < 0 && !s0.Split(new[] { "\\f" }, StringSplitOptions.None).Skip(1).Any(x => encOf(x.Split('|', ';')[0]) >= 0)) return false;
                    if (unicode(s0)) { skipped++; return false; }
                    string s1 = isM ? mtext(s0, k, up) : plain(s0, k, up);
                    if (s1 == s0) return false;
                    if (lockedLayers.Contains(e.Layer)) { lockedN++; return false; }
                    count++;
                    string sn = st.ContainsKey(style) ? ((TextStyleTableRecord)tr.GetObject(style, OpenMode.ForRead)).Name : "(inline)";
                    byStyle[sn] = byStyle.TryGetValue(sn, out int n0) ? n0 + 1 : 1;
                    if (samples.Count < 40) samples.Add(new Dictionary<string, object> { { "handle", e.Handle.ToString() }, { "kind", kind }, { "from", s0.Length > 80 ? s0.Substring(0, 80) : s0 }, { "to", s1.Length > 80 ? s1.Substring(0, 80) : s1 } });
                    if (preview) return true;
                    if (!e.IsWriteEnabled) e.UpgradeOpen();
                    set(s1);
                    return true;
                };
                var table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                foreach (ObjectId bid in table)
                {
                    var bt = (BlockTableRecord)tr.GetObject(bid, OpenMode.ForRead);
                    if (bt.IsFromExternalReference || bt.IsDependent) continue;
                    if (bt.IsAnonymous && (bt.Name.StartsWith("*D", StringComparison.OrdinalIgnoreCase) || bt.Name.StartsWith("*T", StringComparison.OrdinalIgnoreCase))) continue;
                    foreach (ObjectId id in bt)
                    {
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        try
                        {
                            switch (e)
                            {
                                case AttributeDefinition ad: one(ad, ad.TextStyleId, "attribute default", () => ad.TextString, v => ad.TextString = v, false); break;
                                case DBText t: one(t, t.TextStyleId, "text", () => t.TextString, v => t.TextString = v, false); break;
                                case MText m: one(m, m.TextStyleId, "mtext", () => m.Contents, v => m.Contents = v, true); break;
                                case Dimension dm: one(dm, dm.TextStyleId, "dimension override", () => dm.DimensionText, v => dm.DimensionText = v, true); break;
                                case MLeader ml when ml.ContentType == ContentType.MTextContent:
                                    {
                                        var mt = ml.MText;
                                        if (mt != null) one(ml, mt.TextStyleId, "mleader", () => mt.Contents, v => { mt.Contents = v; ml.MText = mt; }, true);
                                        break;
                                    }
                                case Table tb:
                                    {
                                        ObjectId fallback = ObjectId.Null;
                                        try { fallback = ((TableStyle)tr.GetObject(tb.TableStyle, OpenMode.ForRead)).TextStyle(RowType.DataRow); } catch (Exception) { }
                                        for (int rr = 0; rr < tb.Rows.Count; rr++)
                                            for (int cc = 0; cc < tb.Columns.Count; cc++)
                                            {
                                                var cell = tb.Cells[rr, cc];
                                                ObjectId sid = ObjectId.Null;
                                                try { if (cell.GetType().GetProperty("TextStyleId")?.GetValue(cell, null) is ObjectId oid) sid = oid; } catch (Exception) { }
                                                if (sid.IsNull) sid = fallback;
                                                one(tb, sid, "table cell", () => cell.TextString, v => cell.TextString = v, true);
                                            }
                                        break;
                                    }
                                case BlockReference br:
                                    foreach (ObjectId aid in br.AttributeCollection)
                                    {
                                        var at = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                                        if (at == null) continue;
                                        if (at.IsMTextAttribute) { var mt = at.MTextAttribute; one(at, at.TextStyleId, "attribute", () => mt.Contents, v => { mt.Contents = v; at.MTextAttribute = mt; }, true); }
                                        else one(at, at.TextStyleId, "attribute", () => at.TextString, v => at.TextString = v, false);
                                    }
                                    break;
                            }
                        }
                        catch (Exception) { failed++; }
                    }
                }
                // the styles move to the Unicode font
                if (!preview)
                    foreach (var id in st.Keys)
                    {
                        var ts = (TextStyleTableRecord)tr.GetObject(id, OpenMode.ForWrite);
                        bool b = false, it = false;
                        try { b = ts.Font.Bold; it = ts.Font.Italic; } catch (Exception) { }
                        ts.FileName = "";
                        ts.BigFontFileName = "";
                        ts.Font = new FontDescriptor(font, b, it, 0, 0);
                    }
                if (!preview) tr.Commit();
            }
            var res = new Dictionary<string, object> { { "converted", count }, { "preview", preview }, { "styles", styles }, { "by_style", byStyle }, { "samples", samples }, { "font", font } };
            if (skipped > 0) res["left_unicode"] = skipped;
            if (failed > 0) res["failed"] = failed;
            if (lockedN > 0) res["locked"] = lockedN;
            return res;
        }

        /// <summary>
        /// view_extents {windows: [[[x0,y0],[x1,y1]], ...], skip_handles?, skip_layers?}: for each window, the extents
        /// of the model space entities that lie wholly in it (what is drawn there; a frame, its border or a title block
        /// passed in skip_handles does not count, nor anything as wide and as tall as the window) and how many.
        /// </summary>
        public static object ViewExtents(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var ws = new List<double[]>();
            foreach (var o in p.List("windows") ?? new List<object>())
            {
                var w = o as List<object>;
                if (w == null || w.Count != 2) { ws.Add(null); continue; }
                var a = U.Pt(w[0], "window"); var b = U.Pt(w[1], "window");
                ws.Add(new[] { Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y) });
            }
            var skip = new HashSet<string>(p.Strings("skip_handles") ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
            var skipLayers = new HashSet<string>(p.Strings("skip_layers") ?? new List<string>(), StringComparer.OrdinalIgnoreCase);
            var box = new Extents3d?[ws.Count];
            var count = new int[ws.Count];
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                foreach (ObjectId id in ms)
                {
                    var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                    if (e == null || skip.Contains(e.Handle.ToString()) || skipLayers.Contains(e.Layer) || !e.Visible) continue;
                    var x = U.Ext(e);
                    if (x == null) continue;
                    var mn = x.Value.MinPoint; var mx = x.Value.MaxPoint;
                    for (int i = 0; i < ws.Count; i++)
                    {
                        var w = ws[i];
                        if (w == null || mn.X < w[0] || mn.Y < w[1] || mx.X > w[2] || mx.Y > w[3]) continue;
                        if (mx.X - mn.X > 0.9 * (w[2] - w[0]) && mx.Y - mn.Y > 0.9 * (w[3] - w[1])) continue;
                        U.Grow(ref box[i], x);
                        count[i]++;
                    }
                }
            }
            var outL = new List<object>();
            for (int i = 0; i < ws.Count; i++) outL.Add(box[i] == null ? null : new Dictionary<string, object> { { "box", Box(box[i]) }, { "count", count[i] } });
            return new Dictionary<string, object> { { "windows", outL } };
        }

        /// <summary>
        /// layout_views: every layout with its paper, plot style, title block attributes (inserts with attributes in
        /// paper space) and viewports: their size on paper, scale, and the model space window each shows.
        /// </summary>
        public static object LayoutViews(Ctx ctx, P p) => Review.WithDb(ctx, p, (db, name) => LayoutViewsOf(db));

        static object LayoutViewsOf(Database db)
        {
            var outL = new List<object>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var dict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                foreach (DBDictionaryEntry en in dict)
                {
                    var lay = (Layout)tr.GetObject(en.Value, OpenMode.ForRead);
                    if (lay.ModelType) continue;
                    var vps = new List<object>();
                    var attrs = new List<object>();
                    var texts = new List<object>();
                    var ps = (BlockTableRecord)tr.GetObject(lay.BlockTableRecordId, OpenMode.ForRead);
                    var vids = lay.GetViewports();
                    ObjectId overall = vids != null && vids.Count > 0 ? vids[0] : ObjectId.Null;
                    foreach (ObjectId id in ps)
                    {
                        var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                        if (e is Viewport vp)
                        {
                            if (vp.ObjectId == overall || vp.Number == 1) continue; // the paper space viewport itself
                            // a layout never shown has no list of viewports: its paper viewport shows the paper at 1:1
                            if (Math.Abs(vp.CustomScale - 1) < 1e-9 && Math.Abs(vp.ViewCenter.X + vp.ViewTarget.X - vp.CenterPoint.X) < 1 && Math.Abs(vp.ViewCenter.Y + vp.ViewTarget.Y - vp.CenterPoint.Y) < 1) continue;
                            double h = vp.ViewHeight, wv = h * vp.Width / Math.Max(1e-9, vp.Height);
                            var c = vp.ViewCenter;
                            // the view centre in display coordinates of the target; the plan view of a viewport not twisted
                            vps.Add(new Dictionary<string, object>
                            {
                                { "paper_center", new List<object> { Math.Round(vp.CenterPoint.X, 1), Math.Round(vp.CenterPoint.Y, 1) } },
                                { "paper_size", new List<object> { Math.Round(vp.Width, 1), Math.Round(vp.Height, 1) } },
                                { "scale", vp.CustomScale > 0 ? Math.Round(1 / vp.CustomScale, 2) : 0 },
                                { "window", new List<object> { new List<object> { Math.Round(c.X - wv / 2 + vp.ViewTarget.X), Math.Round(c.Y - h / 2 + vp.ViewTarget.Y) }, new List<object> { Math.Round(c.X + wv / 2 + vp.ViewTarget.X), Math.Round(c.Y + h / 2 + vp.ViewTarget.Y) } } },
                                { "twisted", Math.Abs(vp.TwistAngle) > 1e-6 },
                            });
                        }
                        else if (e is BlockReference br)
                        {
                            var d = new Dictionary<string, object>();
                            foreach (ObjectId aid in br.AttributeCollection)
                                if (tr.GetObject(aid, OpenMode.ForRead) is AttributeReference at && !string.IsNullOrWhiteSpace(at.TextString)) d[at.Tag] = at.TextString;
                            if (d.Count > 0) attrs.Add(new Dictionary<string, object> { { "block", U.BlockName(tr, br) }, { "attributes", d } });
                        }
                        else if ((e is DBText || e is MText) && texts.Count < 80)
                        {
                            string s = e is DBText t ? t.TextString : ((MText)e).Text;
                            if (!string.IsNullOrWhiteSpace(s)) texts.Add(s.Length > 100 ? s.Substring(0, 100) : s);
                        }
                    }
                    outL.Add(new Dictionary<string, object>
                    {
                        { "name", lay.LayoutName }, { "tab", lay.TabOrder }, { "paper", lay.CanonicalMediaName ?? "" }, { "style_sheet", lay.CurrentStyleSheet ?? "" },
                        { "viewports", vps }, { "title_blocks", attrs }, { "texts", texts },
                    });
                }
            }
            return new Dictionary<string, object> { { "layouts", outL.OrderBy(l => (int)((Dictionary<string, object>)l)["tab"]).ToList() } };
        }
    }
}
