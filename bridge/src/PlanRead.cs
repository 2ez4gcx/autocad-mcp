// plan_geometry: the linework of a plan as plain geometry in world coordinates, for the server to read the walls,
// openings, columns, grids and rooms of a drawing it did not make. Large block references (a bound xref, a plan
// inserted as a block) are opened and their content transformed to the world; small ones (doors, windows, tags,
// furniture) come back as inserts. Entities on layer 0 inside a block take the layer of the insert, ByLayer / ByBlock
// linetypes are resolved. Nothing is changed.
using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class PlanRead
    {
        class Out
        {
            public readonly List<string> Layers = new List<string>();
            public readonly Dictionary<string, int> LayerIdx = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            public readonly List<string> Linetypes = new List<string>();
            public readonly Dictionary<string, int> LtIdx = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            public readonly List<object> Lines = new List<object>(), Polys = new List<object>(), Arcs = new List<object>(), Circles = new List<object>();
            public readonly List<object> Texts = new List<object>(), Inserts = new List<object>(), Hatches = new List<object>(), Dims = new List<object>();
            public int Count, Skipped, Expanded;
            public Extents3d? Ext;
            public int L(string n) { if (!LayerIdx.TryGetValue(n, out int i)) { i = Layers.Count; Layers.Add(n); LayerIdx[n] = i; } return i; }
            public int T(string n) { if (!LtIdx.TryGetValue(n, out int i)) { i = Linetypes.Count; Linetypes.Add(n); LtIdx[n] = i; } return i; }
        }

        static double R(double v) => Math.Round(v, 1);

        public static object Run(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var o = new Out();
            Extents3d? win = null;
            var w = p.List("window");
            if (w != null && w.Count == 2)
            {
                var a = U.Pt(w[0], "window[0]"); var b = U.Pt(w[1], "window[1]");
                win = new Extents3d(new Point3d(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), -1e9), new Point3d(Math.Max(a.X, b.X), Math.Max(a.Y, b.Y), 1e9));
            }
            double nestedMin = p.Num("nested_min", 5000);
            int limit = (int)p.Num("limit", 200000);
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                var layerLt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var off = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (ObjectId id in lt)
                {
                    var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead);
                    layerLt[l.Name] = ((LinetypeTableRecord)tr.GetObject(l.LinetypeObjectId, OpenMode.ForRead)).Name;
                    if (l.IsOff || l.IsFrozen) off.Add(l.Name);
                }
                var ms = U.ModelSpace(db, tr, OpenMode.ForRead);
                Walk(tr, ms, Matrix3d.Identity, null, null, 0, o, win, nestedMin, limit, layerLt, off);
                tr.Commit();
            }
            return new Dictionary<string, object>
            {
                { "layers", o.Layers }, { "linetypes", o.Linetypes }, { "lines", o.Lines }, { "polys", o.Polys }, { "arcs", o.Arcs }, { "circles", o.Circles },
                { "texts", o.Texts }, { "inserts", o.Inserts }, { "hatches", o.Hatches }, { "dims", o.Dims }, { "count", o.Count }, { "skipped", o.Skipped }, { "expanded", o.Expanded },
                { "extents", U.BoundsOut(o.Ext) },
                { "units", U.UnitName(db) },
            };
        }

        static Extents3d? Box(Entity e, Matrix3d m)
        {
            try
            {
                var x = e.GeometricExtents;
                var pts = new[] { x.MinPoint, new Point3d(x.MaxPoint.X, x.MinPoint.Y, 0), x.MaxPoint, new Point3d(x.MinPoint.X, x.MaxPoint.Y, 0) }.Select(q => q.TransformBy(m)).ToList();
                return new Extents3d(new Point3d(pts.Min(q => q.X), pts.Min(q => q.Y), 0), new Point3d(pts.Max(q => q.X), pts.Max(q => q.Y), 0));
            }
            catch (Exception) { return null; }
        }

        static bool Hits(Extents3d? b, Extents3d? win)
        {
            if (win == null) return true;
            if (b == null) return false;
            var x = b.Value; var v = win.Value;
            return !(x.MaxPoint.X < v.MinPoint.X || x.MinPoint.X > v.MaxPoint.X || x.MaxPoint.Y < v.MinPoint.Y || x.MinPoint.Y > v.MaxPoint.Y);
        }

        static void Walk(Transaction tr, BlockTableRecord btr, Matrix3d m, string inLayer, string inLt, int depth, Out o, Extents3d? win, double nestedMin, int limit,
            Dictionary<string, string> layerLt, HashSet<string> off, string owner = null)
        {
            foreach (ObjectId id in btr)
            {
                if (o.Count >= limit) { o.Skipped++; continue; }
                var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                if (e == null || !e.Visible) continue;
                // the layer it shows on: layer 0 inside a block takes the insert's; the linetype ByLayer / ByBlock resolved
                string layer = (inLayer != null && e.Layer == "0") ? inLayer : e.Layer;
                if (off.Contains(layer)) continue;
                string ltype = e.Linetype;
                if (ltype.Equals("ByLayer", StringComparison.OrdinalIgnoreCase)) ltype = layerLt.TryGetValue(layer, out string lname) ? lname : "Continuous";
                else if (ltype.Equals("ByBlock", StringComparison.OrdinalIgnoreCase)) ltype = inLt ?? "Continuous";
                Extents3d? box = Box(e, m);
                if (!Hits(box, win)) continue;
                string h = owner != null ? "^" + owner : e.Handle.ToString();
                try
                {
                    switch (e)
                    {
                        case BlockReference br:
                            {
                                var def = (BlockTableRecord)tr.GetObject(br.IsDynamicBlock ? br.DynamicBlockTableRecord : br.BlockTableRecord, OpenMode.ForRead);
                                double diag = box == null ? 0 : box.Value.MinPoint.DistanceTo(box.Value.MaxPoint);
                                bool unresolved = def.IsFromExternalReference && !def.IsResolved;
                                if (!unresolved && depth < 4 && diag >= nestedMin)
                                {
                                    // a container: its content in world coordinates
                                    o.Expanded++;
                                    var inner = (BlockTableRecord)tr.GetObject(br.BlockTableRecord, OpenMode.ForRead);
                                    Walk(tr, inner, m * br.BlockTransform, layer, ltype, depth + 1, o, win, nestedMin, limit, layerLt, off, owner ?? br.Handle.ToString());
                                    break;
                                }
                                Point3d pos = br.Position.TransformBy(m);
                                Vector3d xd = Vector3d.XAxis.RotateBy(br.Rotation, Vector3d.ZAxis).TransformBy(m);
                                var attrs = new Dictionary<string, object>();
                                foreach (ObjectId aid in br.AttributeCollection)
                                {
                                    var at = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                                    if (at != null && !at.Invisible && !string.IsNullOrWhiteSpace(at.TextString)) attrs[at.Tag] = at.TextString;
                                }
                                double det = m.GetDeterminant();
                                o.Inserts.Add(new List<object>
                                {
                                    R(pos.X), R(pos.Y), Math.Round(Math.Atan2(xd.Y, xd.X) * 180 / Math.PI, 3), Math.Round(br.ScaleFactors.X * (det < 0 ? -1 : 1), 4), Math.Round(br.ScaleFactors.Y, 4),
                                    def.Name, o.L(layer), attrs.Count > 0 ? attrs : null,
                                    box == null ? null : new List<object> { R(box.Value.MinPoint.X), R(box.Value.MinPoint.Y), R(box.Value.MaxPoint.X), R(box.Value.MaxPoint.Y) }, h,
                                });
                                break;
                            }
                        case Line ln:
                            {
                                var a = ln.StartPoint.TransformBy(m); var b = ln.EndPoint.TransformBy(m);
                                o.Lines.Add(new List<object> { R(a.X), R(a.Y), R(b.X), R(b.Y), o.L(layer), o.T(ltype), h });
                                break;
                            }
                        case Polyline pl:
                            {
                                var pts = new List<object>();
                                bool bulged = false;
                                for (int i = 0; i < pl.NumberOfVertices; i++)
                                {
                                    var q = pl.GetPoint3dAt(i).TransformBy(m);
                                    pts.Add(R(q.X)); pts.Add(R(q.Y));
                                    if (Math.Abs(pl.GetBulgeAt(i)) > 1e-9) bulged = true;
                                }
                                double wid = 0;
                                try { wid = pl.ConstantWidth; } catch (Autodesk.AutoCAD.Runtime.Exception) { wid = pl.NumberOfVertices > 0 ? pl.GetStartWidthAt(0) : 0; }
                                o.Polys.Add(new List<object> { o.L(layer), o.T(ltype), pl.Closed ? 1 : 0, bulged ? 1 : 0, pts, h, R(wid * ScaleOf(m)) });
                                break;
                            }
                        case Polyline2d p2:
                            {
                                var pts = new List<object>();
                                foreach (ObjectId vid in p2)
                                {
                                    var v = tr.GetObject(vid, OpenMode.ForRead) as Vertex2d;
                                    if (v == null) continue;
                                    var q = p2.VertexPosition(v).TransformBy(m);
                                    pts.Add(R(q.X)); pts.Add(R(q.Y));
                                }
                                o.Polys.Add(new List<object> { o.L(layer), o.T(ltype), p2.Closed ? 1 : 0, 0, pts, h });
                                break;
                            }
                        case Arc arc:
                            {
                                var c = arc.Center.TransformBy(m); var a = arc.StartPoint.TransformBy(m); var b = arc.EndPoint.TransformBy(m);
                                if (m.GetDeterminant() < 0) { var t = a; a = b; b = t; }
                                double a0 = Math.Atan2(a.Y - c.Y, a.X - c.X) * 180 / Math.PI, a1 = Math.Atan2(b.Y - c.Y, b.X - c.X) * 180 / Math.PI;
                                o.Arcs.Add(new List<object> { R(c.X), R(c.Y), R(c.DistanceTo(a)), Math.Round(a0, 2), Math.Round(a1, 2), o.L(layer), h });
                                break;
                            }
                        case Circle ci:
                            {
                                var c = ci.Center.TransformBy(m);
                                var q = (ci.Center + Vector3d.XAxis * ci.Radius).TransformBy(m);
                                o.Circles.Add(new List<object> { R(c.X), R(c.Y), R(c.DistanceTo(q)), o.L(layer), h });
                                break;
                            }
                        case DBText tx:
                            {
                                var q = (tx.HorizontalMode == TextHorizontalMode.TextLeft && tx.VerticalMode == TextVerticalMode.TextBase ? tx.Position : tx.AlignmentPoint).TransformBy(m);
                                var c = box == null ? q : new Point3d((box.Value.MinPoint.X + box.Value.MaxPoint.X) / 2, (box.Value.MinPoint.Y + box.Value.MaxPoint.Y) / 2, 0);
                                o.Texts.Add(new List<object> { R(c.X), R(c.Y), R(tx.Height * ScaleOf(m)), tx.TextString, o.L(layer), h });
                                break;
                            }
                        case MText mt:
                            {
                                var c = box == null ? mt.Location.TransformBy(m) : new Point3d((box.Value.MinPoint.X + box.Value.MaxPoint.X) / 2, (box.Value.MinPoint.Y + box.Value.MaxPoint.Y) / 2, 0);
                                o.Texts.Add(new List<object> { R(c.X), R(c.Y), R(mt.TextHeight * ScaleOf(m)), mt.Text, o.L(layer), h });
                                break;
                            }
                        case Hatch hat:
                            {
                                var loops = new List<object>();
                                double diag = box == null ? 0 : box.Value.MinPoint.DistanceTo(box.Value.MaxPoint);
                                if (diag <= 3000)
                                {
                                    for (int i = 0; i < hat.NumberOfLoops && i < 4; i++)
                                    {
                                        var lp = hat.GetLoopAt(i);
                                        var pts = new List<object>();
                                        if (lp.IsPolyline) foreach (BulgeVertex bv in lp.Polyline) { var q = new Point3d(bv.Vertex.X, bv.Vertex.Y, 0).TransformBy(m); pts.Add(R(q.X)); pts.Add(R(q.Y)); }
                                        else foreach (Curve2d cv in lp.Curves) { var q = new Point3d(cv.StartPoint.X, cv.StartPoint.Y, 0).TransformBy(m); pts.Add(R(q.X)); pts.Add(R(q.Y)); }
                                        loops.Add(pts);
                                    }
                                }
                                o.Hatches.Add(new List<object>
                                {
                                    o.L(layer), hat.PatternName ?? "", hat.IsSolidFill ? 1 : 0,
                                    box == null ? null : new List<object> { R(box.Value.MinPoint.X), R(box.Value.MinPoint.Y), R(box.Value.MaxPoint.X), R(box.Value.MaxPoint.Y) }, loops, h,
                                });
                                break;
                            }
                        case Dimension dm:
                            {
                                if (box != null) o.Dims.Add(new List<object> { R(box.Value.MinPoint.X), R(box.Value.MinPoint.Y), R(box.Value.MaxPoint.X), R(box.Value.MaxPoint.Y), o.L(layer), h });
                                break;
                            }
                        default:
                            continue;
                    }
                    o.Count++;
                    if (box != null) U.Grow(ref o.Ext, box);
                }
                catch (Exception) { o.Skipped++; }
            }
        }

        static double ScaleOf(Matrix3d m) => Vector3d.XAxis.TransformBy(m).Length;
    }
}
