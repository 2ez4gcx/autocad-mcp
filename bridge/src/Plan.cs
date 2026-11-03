// draw_plan: wall outlines from the union of wall pieces (L/T/X junctions resolved by region booleans), openings and
// columns cut out, material hatch, rooms measured from the faces the walls enclose (never typed), then the remaining
// primitives (doors, windows, grids, dimensions...) computed by the MCP server. All in one transaction = one Undo step.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    /// <summary>A closed loop of a region boundary: vertices plus the bulge of the segment leaving each vertex.</summary>
    public class Loop
    {
        public List<Point2d> Pts = new List<Point2d>();
        public List<double> Bulges = new List<double>();
        public double SignedArea;
        public double Area { get { return Math.Abs(SignedArea); } }
        public List<Point2d> Dense; // arcs sampled, for point-in-polygon tests
        public int Depth;

        public double Perimeter
        {
            get
            {
                double p = 0;
                for (int i = 0; i < Pts.Count; i++)
                {
                    Point2d a = Pts[i], b = Pts[(i + 1) % Pts.Count];
                    double c = a.GetDistanceTo(b), bu = Bulges[i];
                    if (Math.Abs(bu) < 1e-12) p += c;
                    else
                    {
                        double th = 4 * Math.Atan(Math.Abs(bu));
                        p += c / (2 * Math.Sin(th / 2)) * th;
                    }
                }
                return p;
            }
        }

        public bool Contains(Point2d q)
        {
            bool inside = false;
            var v = Dense;
            for (int i = 0, j = v.Count - 1; i < v.Count; j = i++)
            {
                if ((v[i].Y > q.Y) != (v[j].Y > q.Y) &&
                    q.X < (v[j].X - v[i].X) * (q.Y - v[i].Y) / (v[j].Y - v[i].Y) + v[i].X) inside = !inside;
            }
            return inside;
        }

        public List<Point3d> Points3d() { return Pts.Select(p => new Point3d(p.X, p.Y, 0)).ToList(); }

        public List<object> BulgeList() { return Bulges.Select(b => (object)b).ToList(); }
    }

    public static class Geo
    {
        class Seg
        {
            public Point2d A, B;
            public double Bulge;
            public bool Used;
        }

        public static Region RegionFrom(List<Point3d> pts, string name)
        {
            if (pts.Count > 2 && pts[0].DistanceTo(pts[pts.Count - 1]) < 1e-9) pts = pts.Take(pts.Count - 1).ToList();
            if (pts.Count < 3) throw new McpError(name + ": a polygon needs at least 3 points");
            using (var pl = new Polyline())
            {
                for (int i = 0; i < pts.Count; i++) pl.AddVertexAt(i, new Point2d(pts[i].X, pts[i].Y), 0, 0, 0);
                pl.Closed = true;
                var curves = new DBObjectCollection { pl };
                DBObjectCollection regs;
                try { regs = Region.CreateFromCurves(curves); }
                catch (Exception) { throw new McpError(name + ": not a valid closed polygon (self-intersecting or zero area)"); }
                if (regs.Count == 0) throw new McpError(name + ": not a valid closed polygon");
                for (int i = 1; i < regs.Count; i++) regs[i].Dispose();
                return (Region)regs[0];
            }
        }

        /// <summary>Union of polygons; null when the list is empty.</summary>
        public static Region Union(List<List<Point3d>> polys, string name)
        {
            Region acc = null;
            for (int i = 0; i < polys.Count; i++)
            {
                Region r = RegionFrom(polys[i], name + "[" + i + "]");
                if (acc == null) { acc = r; continue; }
                acc.BooleanOperation(BooleanOperationType.BoolUnite, r);
                r.Dispose();
            }
            return acc;
        }

        public static void Subtract(Region r, List<List<Point3d>> polys, string name)
        {
            for (int i = 0; i < polys.Count; i++)
            {
                using (Region c = RegionFrom(polys[i], name + "[" + i + "]"))
                    r.BooleanOperation(BooleanOperationType.BoolSubtract, c);
            }
        }

        static void Collect(Entity e, List<Seg> segs)
        {
            var objs = new DBObjectCollection();
            e.Explode(objs);
            foreach (DBObject o in objs)
            {
                switch (o)
                {
                    case Region sub:
                        Collect(sub, segs);
                        break;
                    case Line l:
                        if (l.Length > 1e-9) segs.Add(new Seg { A = Flat(l.StartPoint), B = Flat(l.EndPoint) });
                        break;
                    case Arc a:
                        {
                            double sweep = a.EndAngle - a.StartAngle;
                            if (sweep < 0) sweep += 2 * Math.PI;
                            double bulge = Math.Tan(sweep / 4) * (a.Normal.Z < 0 ? -1 : 1);
                            segs.Add(new Seg { A = Flat(a.StartPoint), B = Flat(a.EndPoint), Bulge = bulge });
                            break;
                        }
                    case Circle c:
                        {
                            var p1 = new Point2d(c.Center.X + c.Radius, c.Center.Y);
                            var p2 = new Point2d(c.Center.X - c.Radius, c.Center.Y);
                            segs.Add(new Seg { A = p1, B = p2, Bulge = 1 });
                            segs.Add(new Seg { A = p2, B = p1, Bulge = 1 });
                            break;
                        }
                    case Curve cv:
                        {
                            // Ellipse/spline edges: sample into straight segments.
                            double s0 = cv.StartParam, s1 = cv.EndParam;
                            Point2d prev = Flat(cv.StartPoint);
                            for (int k = 1; k <= 32; k++)
                            {
                                Point2d q = Flat(cv.GetPointAtParameter(s0 + (s1 - s0) * k / 32));
                                segs.Add(new Seg { A = prev, B = q });
                                prev = q;
                            }
                            break;
                        }
                }
                o.Dispose();
            }
        }

        static Point2d Flat(Point3d p) { return new Point2d(p.X, p.Y); }

        /// <summary>Boundary loops of a region (all faces, outer and inner), with signed area and nesting depth.</summary>
        public static List<Loop> Loops(Region r)
        {
            var segs = new List<Seg>();
            Collect(r, segs);
            var loops = new List<Loop>();
            double size = 1;
            foreach (var s in segs) size = Math.Max(size, Math.Max(Math.Abs(s.A.X), Math.Abs(s.A.Y)));
            double tol = Math.Max(1e-6, size * 1e-9);
            foreach (var start in segs)
            {
                if (start.Used) continue;
                start.Used = true;
                var loop = new Loop();
                loop.Pts.Add(start.A);
                loop.Bulges.Add(start.Bulge);
                Point2d end = start.B;
                int guard = 0;
                while (end.GetDistanceTo(loop.Pts[0]) > tol && guard++ < segs.Count)
                {
                    Seg next = null;
                    bool reverse = false;
                    double best = tol * 10;
                    foreach (var s in segs)
                    {
                        if (s.Used) continue;
                        double da = s.A.GetDistanceTo(end), db = s.B.GetDistanceTo(end);
                        if (da < best) { best = da; next = s; reverse = false; }
                        if (db < best) { best = db; next = s; reverse = true; }
                    }
                    if (next == null) break;
                    next.Used = true;
                    loop.Pts.Add(reverse ? next.B : next.A);
                    loop.Bulges.Add(reverse ? -next.Bulge : next.Bulge);
                    end = reverse ? next.A : next.B;
                }
                if (loop.Pts.Count >= 2 && end.GetDistanceTo(loop.Pts[0]) <= tol * 10) loops.Add(Finish(loop));
            }
            foreach (var l in loops)
                l.Depth = loops.Count(o => o != l && o.Area > l.Area && o.Contains(l.Dense[0]));
            return loops;
        }

        static Loop Finish(Loop l)
        {
            // Drop collinear vertices of straight runs (region edges are often split where other pieces touched).
            for (int i = l.Pts.Count - 1; i >= 0 && l.Pts.Count > 3; i--)
            {
                int ip = (i - 1 + l.Pts.Count) % l.Pts.Count, inx = (i + 1) % l.Pts.Count;
                if (Math.Abs(l.Bulges[ip]) > 1e-12 || Math.Abs(l.Bulges[i]) > 1e-12) continue;
                Vector2d a = l.Pts[i] - l.Pts[ip], b = l.Pts[inx] - l.Pts[i];
                if (a.Length < 1e-9 || b.Length < 1e-9 || Math.Abs(a.X * b.Y - a.Y * b.X) <= 1e-9 * a.Length * b.Length && a.DotProduct(b) > 0)
                {
                    l.Pts.RemoveAt(i);
                    l.Bulges.RemoveAt(i);
                }
            }
            double area = 0;
            l.Dense = new List<Point2d>();
            for (int i = 0; i < l.Pts.Count; i++)
            {
                Point2d a = l.Pts[i], b = l.Pts[(i + 1) % l.Pts.Count];
                area += a.X * b.Y - b.X * a.Y;
                double bu = l.Bulges[i];
                l.Dense.Add(a);
                if (Math.Abs(bu) > 1e-12)
                {
                    double c = a.GetDistanceTo(b), th = 4 * Math.Atan(Math.Abs(bu));
                    double rad = c / (2 * Math.Sin(th / 2));
                    double seg = rad * rad / 2 * (th - Math.Sin(th));
                    area += 2 * Math.Sign(bu) * seg;
                    // Sample the arc for containment tests.
                    var mid = new Point2d((a.X + b.X) / 2, (a.Y + b.Y) / 2);
                    Vector2d d = (b - a).GetNormal();
                    var right = new Vector2d(d.Y, -d.X);
                    double sagitta = bu * c / 2;
                    Point2d apex = mid + right * sagitta;
                    var arc = new CircularArc2d(a, apex, b);
                    for (int k = 1; k < 8; k++) l.Dense.Add(arc.EvaluatePoint(arc.GetParameterOf(a) + (arc.GetParameterOf(b) - arc.GetParameterOf(a)) * k / 8));
                }
            }
            l.SignedArea = area / 2;
            return l;
        }

        public static Point2d Centroid(Loop l)
        {
            double cx = 0, cy = 0, a = 0;
            var v = l.Dense;
            for (int i = 0; i < v.Count; i++)
            {
                Point2d p = v[i], q = v[(i + 1) % v.Count];
                double f = p.X * q.Y - q.X * p.Y;
                cx += (p.X + q.X) * f;
                cy += (p.Y + q.Y) * f;
                a += f;
            }
            if (Math.Abs(a) < 1e-12) return v[0];
            var c = new Point2d(cx / (3 * a), cy / (3 * a));
            if (l.Contains(c)) return c;
            // Concave room: use the middle of the widest horizontal chord through the centroid height instead.
            var xs = new List<double>();
            for (int i = 0; i < v.Count; i++)
            {
                Point2d p = v[i], q = v[(i + 1) % v.Count];
                if ((p.Y > c.Y) != (q.Y > c.Y)) xs.Add(p.X + (c.Y - p.Y) * (q.X - p.X) / (q.Y - p.Y));
            }
            xs.Sort();
            double bestW = -1, bx = c.X;
            for (int i = 0; i + 1 < xs.Count; i += 2)
                if (xs[i + 1] - xs[i] > bestW) { bestW = xs[i + 1] - xs[i]; bx = (xs[i] + xs[i + 1]) / 2; }
            return new Point2d(bx, c.Y);
        }
    }

    public static class Plan
    {
        /// <summary>Interior span [l, r] of a loop along the horizontal line through p (arcs sampled).</summary>
        static bool SpanAt(Loop h, Point3d p, out double l, out double r)
        {
            var pts = h.Dense ?? h.Pts;
            l = double.NegativeInfinity; r = double.PositiveInfinity;
            for (int i = 0; i < pts.Count; i++)
            {
                Point2d a = pts[i], b = pts[(i + 1) % pts.Count];
                if ((a.Y > p.Y) == (b.Y > p.Y)) continue;
                double x = a.X + (p.Y - a.Y) / (b.Y - a.Y) * (b.X - a.X);
                if (x <= p.X) l = Math.Max(l, x); else r = Math.Min(r, x);
            }
            return !double.IsInfinity(l) && !double.IsInfinity(r);
        }

        /// <summary>
        /// Keeps a room label off the walls: a name wider than the room is wrapped at the space nearest its middle, then the
        /// label is shifted sideways to stay inside; a warning when it still does not fit.
        /// </summary>
        static void FitLabel(MText m, Loop hole, string title, string tail, Dictionary<string, object> ro1)
        {
            Point3d at = m.Location;
            if (Math.Abs(m.Rotation) > 1e-9 || !SpanAt(hole, at, out double l, out double r)) return;
            double gap = m.TextHeight * 0.4;
            double room = r - l - 2 * gap;
            if (m.ActualWidth > room && title.Contains(" "))
            {
                int mid = title.Length / 2, best = -1;
                for (int k = 0; k < title.Length; k++)
                    if (title[k] == ' ' && (best < 0 || Math.Abs(k - mid) < Math.Abs(best - mid))) best = k;
                string wrapped = title.Substring(0, best) + "\\P" + title.Substring(best + 1);
                m.Contents = tail == null ? wrapped : wrapped + "\\P" + tail;
            }
            double w = m.ActualWidth;
            if (w > room)
            {
                ro1["warning"] = "The label is wider than the room (" + U.R(w) + " > " + U.R(room) + "): shorten the name or lower room_options.text_height.";
                return;
            }
            double x = Math.Max(l + gap + w / 2, Math.Min(r - gap - w / 2, at.X));
            if (Math.Abs(x - at.X) > 1e-6)
            {
                m.Location = new Point3d(x, at.Y, at.Z);
                ro1["label_moved"] = new List<object> { U.R(x), U.R(at.Y) };
            }
        }

        static List<List<Point3d>> Polys(P p, string key)
        {
            var l = p.List(key);
            var r = new List<List<Point3d>>();
            if (l == null) return r;
            string name = p.Path == "" ? key : p.Path + "." + key;
            for (int i = 0; i < l.Count; i++) r.Add(U.PtList(l[i], name + "[" + i + "]"));
            return r;
        }

        static string Num(double v, int decimals, string sep)
        {
            string s = v.ToString("F" + decimals, CultureInfo.InvariantCulture);
            return sep == "," ? s.Replace(".", ",") : s;
        }

        public static object DrawPlan(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            double toM = U.ToMetres(db);
            var result = new Dictionary<string, object>();
            // Text/dimension styles for the plan scale, inside the same document lock (same Undo step).
            if (p.Has("styles")) result["styles"] = Styles.Setup(ctx, p.Obj("styles"));
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var space = U.ModelSpace(db, tr, OpenMode.ForWrite);
                var dr = new Drawer(db, tr, space, p.Obj("layer_styles"));
                var cuts = Polys(p, "cuts");
                var columns = Polys(p, "columns");
                Region all = null;

                // ---- walls, one group per material
                var wallOut = new List<object>();
                var groups = p.List("walls") ?? new List<object>();
                for (int gi = 0; gi < groups.Count; gi++)
                {
                    var g = new P(groups[gi], "walls[" + gi + "]");
                    string stage = "union of the wall pieces";
                    try
                    {
                    Region r = Geo.Union(Polys(g, "solids"), g.Path + ".solids");
                    if (r == null) continue;
                    stage = "room region";
                    var forRooms = (Region)r.Clone();
                    if (all == null) all = forRooms;
                    else { all.BooleanOperation(BooleanOperationType.BoolUnite, forRooms); forRooms.Dispose(); }
                    stage = "cutting the openings";
                    Geo.Subtract(r, cuts, "cuts");
                    stage = "cutting the columns";
                    Geo.Subtract(r, columns, "columns");
                    stage = "outline loops";
                    List<Loop> loops = Geo.Loops(r).OrderBy(l => l.Depth).ToList();
                    r.Dispose();
                    stage = "outline polylines";
                    var outline = new List<object>();
                    var outlineIds = new List<ObjectId>();
                    var lp = new P(new Dictionary<string, object> { { "layer", g.Str("layer") ?? "A-WALL" } }, g.Path);
                    foreach (var loop in loops)
                    {
                        var pl = dr.MakePoly(loop.Points3d(), loop.BulgeList(), true, null);
                        dr.Add(pl, lp);
                        U.Grow(ref dr.Bounds, U.Ext(pl));
                        outline.Add(pl.Handle.ToString());
                        outlineIds.Add(pl.ObjectId);
                    }
                    stage = "material hatch";
                    string hatch = null;
                    P hs = g.Obj("hatch");
                    if (hs != null && loops.Count > 0)
                    {
                        // The outlines themselves are the hatch boundaries (outer loops first, holes after).
                        var h = dr.MakeHatch(hs, new List<List<Point3d>>(), null, outlineIds);
                        hatch = h.Handle.ToString();
                    }
                    double area = loops.Sum(l => l.Depth % 2 == 0 ? l.Area : -l.Area);
                    wallOut.Add(new Dictionary<string, object>
                    {
                        { "layer", g.Str("layer") ?? "A-WALL" }, { "outline_handles", outline }, { "hatch_handle", hatch },
                        { "cut_area_m2", U.R(area * toM * toM, 3) },
                    });
                    }
                    catch (Autodesk.AutoCAD.Runtime.Exception e)
                    {
                        Bridge.Log("draw_plan " + stage + ": " + e);
                        throw new McpError("walls (" + (g.Str("layer") ?? "A-WALL") + "): AutoCAD refused the " + stage + " (" + e.ErrorStatus + ")");
                    }
                }
                result["walls"] = wallOut;
                if (columns.Count > 0)
                {
                    Region c = Geo.Union(columns, "columns");
                    if (all == null) all = c;
                    else { all.BooleanOperation(BooleanOperationType.BoolUnite, c); c.Dispose(); }
                }

                // ---- rooms: the holes of the wall region (before openings were cut)
                var roomSpecs = p.List("rooms") ?? new List<object>();
                if (roomSpecs.Count > 0 || p.Bool("report_spaces", true))
                {
                    List<Loop> holes;
                    try { holes = all == null ? new List<Loop>() : Geo.Loops(all).Where(l => l.Depth % 2 == 1).ToList(); }
                    catch (Autodesk.AutoCAD.Runtime.Exception e)
                    {
                        Bridge.Log("draw_plan rooms: " + e);
                        throw new McpError("rooms: AutoCAD refused the room outlines (" + e.ErrorStatus + ")");
                    }
                    P ro = p.Obj("room_options") ?? new P(null, "room_options");
                    int dec = ro.Int("decimals", 2);
                    string sep = ro.Str("decimal_separator") ?? ".";
                    string unit = ro.Str("area_unit") ?? "m²";
                    var used = new HashSet<Loop>();
                    var roomsOut = new List<object>();
                    for (int i = 0; i < roomSpecs.Count; i++)
                    {
                        var rs = new P(roomSpecs[i], "rooms[" + i + "]");
                        string name = rs.Str("name") ?? "";
                        Point3d at = U.Pt(rs, "at");
                        Loop hole = holes.Where(h => h.Contains(new Point2d(at.X, at.Y))).OrderBy(h => h.Area).FirstOrDefault();
                        var ro1 = new Dictionary<string, object> { { "name", name } };
                        if (rs.Has("number")) ro1["number"] = rs.Str("number");
                        string areaText = null;
                        if (hole == null)
                        {
                            ro1["warning"] = "The point is not inside a space closed by walls (missing wall, gap, or point outside): area not measured. " +
                                (rs.Has("area_m2") ? "Using the given area_m2." : "Pass area_m2 to label it anyway, or fix the walls.");
                            if (rs.Has("area_m2")) areaText = Num(rs.ReqNum("area_m2"), dec, sep);
                        }
                        else
                        {
                            if (used.Contains(hole)) ro1["warning"] = "Another room point is in the same space: the two labels share one area.";
                            used.Add(hole);
                            double a = hole.Area * toM * toM;
                            ro1["area_m2"] = U.R(a, 3);
                            ro1["perimeter_m"] = U.R(hole.Perimeter * toM, 3);
                            areaText = Num(a, dec, sep);
                            if (ro.Bool("boundary", true))
                            {
                                var pl = dr.MakePoly(hole.Points3d(), hole.BulgeList(), true, null);
                                dr.Add(pl, new P(new Dictionary<string, object> { { "layer", ro.Str("area_layer") ?? "A-AREA" } }, "room_options"));
                                ro1["boundary_handle"] = pl.Handle.ToString();
                            }
                            P fh = rs.Obj("hatch");
                            if (fh != null)
                            {
                                var h = dr.MakeHatch(fh, new List<List<Point3d>> { hole.Points3d() }, new List<List<object>> { hole.BulgeList() }, null);
                                ro1["hatch_handle"] = h.Handle.ToString();
                            }
                        }
                        if (rs.Bool("label", true))
                        {
                            string title = rs.Has("number") ? rs.Str("number") + " " + name : name;
                            string text = areaText == null ? title : (title == "" ? "" : title + "\n") + areaText + " " + unit;
                            var lp = new Dictionary<string, object>
                            {
                                { "layer", ro.Str("label_layer") ?? "A-ANNO-ROOM" }, { "align", "middle_center" },
                            };
                            if (ro.Has("text_height")) lp["height"] = ro.Raw("text_height");
                            if (ro.Has("style")) lp["style"] = ro.Raw("style");
                            var lps = new P(lp, rs.Path);
                            var m = dr.MakeMText(lps, text, at);
                            dr.Add(m, lps, false);
                            if (hole != null) FitLabel(m, hole, title, areaText == null ? null : areaText + " " + unit, ro1);
                            ro1["label_handle"] = m.Handle.ToString();
                        }
                        roomsOut.Add(ro1);
                    }
                    result["rooms"] = roomsOut;
                    var spaces = holes.Where(h => !used.Contains(h)).Select(h =>
                    {
                        Point2d c = Geo.Centroid(h);
                        return (object)new Dictionary<string, object>
                        {
                            { "inside_point", new List<object> { U.R(c.X), U.R(c.Y) } }, { "area_m2", U.R(h.Area * toM * toM, 3) },
                        };
                    }).ToList();
                    if (spaces.Count > 0) result["unlabelled_spaces"] = spaces;
                }
                if (all != null) all.Dispose();

                // ---- everything else
                result["entities"] = dr.DrawAll(p.List("entities"), "entities");
                result["count"] = dr.Count;
                if (dr.CreatedLayers.Count > 0) result["created_layers"] = dr.CreatedLayers;
                result["bounds"] = U.BoundsOut(dr.Bounds);
                tr.Commit();
            }
            return result;
        }
    }
}
