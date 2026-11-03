// Creates entities from JSON specs: line, polyline, rectangle, circle, arc, ellipse, spline, point, text, mtext, hatch,
// dimension, dim_chain, leader, block, table. All of one request go into the same transaction (one Undo step):
// an invalid spec aborts the whole batch with "entities[i] (type): message".
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public class Drawer
    {
        readonly Database _db;
        readonly Transaction _tr;
        readonly BlockTableRecord _space;
        readonly P _layerStyles;
        public readonly List<string> CreatedLayers = new List<string>();
        public Extents3d? Bounds;
        public int Count;
        /// <summary>Attributes whose field names {viewport}: made by create_layout once the viewport exists.</summary>
        public readonly List<KeyValuePair<ObjectId, string>> PendingFields = new List<KeyValuePair<ObjectId, string>>();

        public Drawer(Database db, Transaction tr, BlockTableRecord space, P layerStyles)
        {
            _db = db;
            _tr = tr;
            _space = space;
            _layerStyles = layerStyles;
        }

        public List<object> DrawAll(List<object> specs, string path)
        {
            var results = new List<object>();
            if (specs == null) return results;
            for (int i = 0; i < specs.Count; i++)
            {
                var s = new P(specs[i], path + "[" + i + "]");
                string type = "?";
                try
                {
                    type = s.ReqStr("type").ToLowerInvariant();
                    results.Add(Draw(s, type));
                }
                catch (McpError e)
                {
                    throw new McpError(e.Message.StartsWith(s.Path) ? e.Message : s.Path + " (" + type + "): " + e.Message);
                }
                catch (Autodesk.AutoCAD.Runtime.Exception e)
                {
                    throw new McpError(s.Path + " (" + type + "): AutoCAD refused it (" + e.ErrorStatus + ")");
                }
            }
            return results;
        }

        // ---------------------------------------------------------------- fields

        /// <summary>A field code (starts with %&lt;\): text whose value AutoCAD keeps up to date.</summary>
        public static bool IsFieldCode(string s) => s != null && s.Contains("%<\\");

        /// <summary>{h:HANDLE} in a field code becomes the object id of that entity (%&lt;\_ObjId n&gt;%).</summary>
        public static string ResolveField(Database db, string code)
        {
            return System.Text.RegularExpressions.Regex.Replace(code, @"\{h:([0-9A-Fa-f]+)\}", m =>
            {
                ObjectId id;
                if (!db.TryGetObjectId(new Handle(Convert.ToInt64(m.Groups[1].Value, 16)), out id) || id.IsErased)
                    throw new McpError("field: no object with handle " + m.Groups[1].Value);
                return ObjId(id);
            });
        }

        public static string ObjId(ObjectId id) => "%<\\_ObjId " + id.OldIdPtr.ToInt64() + ">%";

        /// <summary>Puts a field on the text of an object (mtext, attribute) that is in the drawing.</summary>
        public ObjectId ApplyField(DBObject o, string code)
        {
            var f = new Field(ResolveField(_db, code));
            f.Evaluate();
            o.SetField(f);
            _tr.AddNewlyCreatedDBObject(f, true);
            return f.ObjectId;
        }

        // ---------------------------------------------------------------- common properties

        /// <summary>Applies layer/color/linetype/lineweight/ltscale/transparency, appends to the space, returns the handle.</summary>
        public string Add(Entity e, P s, bool setDefaults = true)
        {
            // Text, mtext and table set their defaults before their style/height (SetDatabaseDefaults would reset them).
            if (setDefaults) e.SetDatabaseDefaults(_db);
            ApplyProps(e, s);
            _space.AppendEntity(e);
            _tr.AddNewlyCreatedDBObject(e, true);
            Count++;
            return e.Handle.ToString();
        }

        public void ApplyProps(Entity e, P s)
        {
            if (s.Has("layer")) e.LayerId = U.EnsureLayer(_db, _tr, s.Str("layer"), _layerStyles, CreatedLayers);
            if (s.Has("color")) e.Color = U.Col(s.Raw("color"), s.Path + ".color");
            if (s.Has("linetype"))
            {
                string lt = s.Str("linetype");
                if (!lt.Equals("bylayer", StringComparison.OrdinalIgnoreCase) && !lt.Equals("byblock", StringComparison.OrdinalIgnoreCase))
                    U.EnsureLinetype(_db, _tr, lt);
                e.Linetype = lt;
            }
            if (s.Has("lineweight")) e.LineWeight = U.Lw(s.Raw("lineweight"), s.Path + ".lineweight");
            if (s.Has("ltscale")) e.LinetypeScale = Pos(s, "ltscale");
            if (s.Has("transparency"))
            {
                double t = Math.Max(0, Math.Min(90, s.Num("transparency", 0)));
                e.Transparency = new Autodesk.AutoCAD.Colors.Transparency((byte)Math.Round(255 * (1 - t / 100.0)));
            }
        }

        static double Pos(P s, string key)
        {
            double v = s.ReqNum(key);
            if (v <= 0) throw new McpError(key + " must be > 0");
            return v;
        }

        void Track(Entity e) { U.Grow(ref Bounds, U.Ext(e)); }

        Dictionary<string, object> One(string type, Entity e)
        {
            Track(e);
            return new Dictionary<string, object> { { "type", type }, { "handle", e.Handle.ToString() } };
        }

        Dictionary<string, object> Many(string type, List<Entity> es)
        {
            foreach (var e in es) Track(e);
            return new Dictionary<string, object> { { "type", type }, { "handles", es.Select(e => (object)e.Handle.ToString()).ToList() } };
        }

        // ---------------------------------------------------------------- dispatcher

        public Dictionary<string, object> Draw(P s, string type)
        {
            switch (type)
            {
                case "line": return Line(s);
                case "polyline": case "pline": case "lwpolyline": return Poly(s);
                case "rectangle": case "rect": return Rect(s);
                case "circle": return CircleE(s);
                case "arc": return ArcE(s);
                case "ellipse": return EllipseE(s);
                case "spline": return SplineE(s);
                case "point": return PointE(s);
                case "text": return TextE(s);
                case "mtext": return MTextE(s);
                case "hatch": return HatchE(s);
                case "dimension": case "dim": return Dim(s);
                case "dim_chain": return DimChain(s);
                case "leader": case "mleader": return LeaderE(s);
                case "block": case "insert": return Insert(s);
                case "table": return TableE(s);
                default:
                    throw new McpError("unknown type '" + type + "' (line, polyline, rectangle, circle, arc, ellipse, spline, point, " +
                        "text, mtext, hatch, dimension, dim_chain, leader, block, table)");
            }
        }

        // ---------------------------------------------------------------- geometry

        Dictionary<string, object> Line(P s)
        {
            List<Point3d> pts = s.Has("points") ? U.Pts(s, "points", 2) : new List<Point3d> { U.Pt(s, "from"), U.Pt(s, "to") };
            var es = new List<Entity>();
            for (int i = 0; i + 1 < pts.Count; i++)
            {
                if (pts[i].DistanceTo(pts[i + 1]) < 1e-9) throw new McpError("zero-length segment at point " + i);
                var l = new Line(pts[i], pts[i + 1]);
                Add(l, s);
                es.Add(l);
            }
            return es.Count == 1 ? One("line", es[0]) : Many("line", es);
        }

        public Polyline MakePoly(List<Point3d> pts, List<object> bulges, bool closed, P s)
        {
            var pl = new Polyline();
            for (int i = 0; i < pts.Count; i++)
            {
                double b = bulges != null && i < bulges.Count && bulges[i] != null ? P.ToNum(bulges[i], "bulges[" + i + "]") : 0;
                pl.AddVertexAt(i, new Point2d(pts[i].X, pts[i].Y), b, 0, 0);
            }
            pl.Closed = closed;
            if (pts.Count > 0 && Math.Abs(pts[0].Z) > 1e-9) pl.Elevation = pts[0].Z;
            if (s != null && s.Has("width")) pl.ConstantWidth = s.Num("width", 0);
            return pl;
        }

        Dictionary<string, object> Poly(P s)
        {
            var pts = U.Pts(s, "points", 2);
            bool closed = s.Bool("closed", false);
            // A closed polyline whose last point repeats the first: drop the duplicate.
            if (closed && pts.Count > 2 && pts[0].DistanceTo(pts[pts.Count - 1]) < 1e-9) pts.RemoveAt(pts.Count - 1);
            var pl = MakePoly(pts, s.List("bulges"), closed, s);
            Add(pl, s);
            return One("polyline", pl);
        }

        Dictionary<string, object> Rect(P s)
        {
            List<Point3d> c;
            if (s.Has("from"))
            {
                Point3d a = U.Pt(s, "from"), b = U.Pt(s, "to");
                if (Math.Abs(a.X - b.X) < 1e-9 || Math.Abs(a.Y - b.Y) < 1e-9) throw new McpError("from and to must differ in x and y");
                c = new List<Point3d> { a, new Point3d(b.X, a.Y, a.Z), new Point3d(b.X, b.Y, a.Z), new Point3d(a.X, b.Y, a.Z) };
            }
            else
            {
                Point3d o = U.Pt(s, "corner");
                double w = Pos(s, "width"), h = Pos(s, "height"), r = U.Rad(s.Num("rotation", 0));
                Vector3d u = new Vector3d(Math.Cos(r), Math.Sin(r), 0), v = new Vector3d(-Math.Sin(r), Math.Cos(r), 0);
                c = new List<Point3d> { o, o + u * w, o + u * w + v * h, o + v * h };
            }
            var pl = MakePoly(c, null, true, null); // "width" here is the rectangle's, not a polyline width
            Add(pl, s);
            return One("rectangle", pl);
        }

        Dictionary<string, object> CircleE(P s)
        {
            double r = s.Has("diameter") ? Pos(s, "diameter") / 2 : Pos(s, "radius");
            var c = new Circle(U.Pt(s, "center"), Vector3d.ZAxis, r);
            Add(c, s);
            return One("circle", c);
        }

        Dictionary<string, object> ArcE(P s)
        {
            Arc a;
            if (s.Has("mid"))
            {
                Point3d p1 = U.Pt(s, "start"), p2 = U.Pt(s, "mid"), p3 = U.Pt(s, "end");
                CircularArc3d ca;
                try { ca = new CircularArc3d(p1, p2, p3); }
                catch (Exception) { throw new McpError("start, mid and end are collinear"); }
                Point3d c = ca.Center;
                double a1 = Math.Atan2(p1.Y - c.Y, p1.X - c.X), a3 = Math.Atan2(p3.Y - c.Y, p3.X - c.X);
                // AutoCAD arcs run counter-clockwise: swap the ends of a clockwise arc.
                a = ca.Normal.Z >= 0 ? new Arc(c, ca.Radius, a1, a3) : new Arc(c, ca.Radius, a3, a1);
            }
            else
            {
                a = new Arc(U.Pt(s, "center"), Pos(s, "radius"), U.Rad(s.ReqNum("start_angle")), U.Rad(s.ReqNum("end_angle")));
            }
            Add(a, s);
            return One("arc", a);
        }

        Dictionary<string, object> EllipseE(P s)
        {
            Point3d c = U.Pt(s, "center");
            Point3d m = U.Pt(s, "major_axis");
            var major = new Vector3d(m.X, m.Y, 0);
            if (major.Length < 1e-9) throw new McpError("major_axis must not be zero");
            double ratio = s.Num("ratio", 0.5);
            if (ratio <= 0 || ratio > 1) throw new McpError("ratio must be in (0, 1]");
            var e = new Ellipse(c, Vector3d.ZAxis, major, ratio, U.Rad(s.Num("start_angle", 0)), U.Rad(s.Num("end_angle", 360)));
            Add(e, s);
            return One("ellipse", e);
        }

        Dictionary<string, object> SplineE(P s)
        {
            var pts = U.Pts(s, "points", 2);
            if (s.Bool("closed", false) && pts[0].DistanceTo(pts[pts.Count - 1]) > 1e-9) pts.Add(pts[0]);
            var sp = new Spline(new Point3dCollection(pts.ToArray()), 4, 0.0);
            Add(sp, s);
            return One("spline", sp);
        }

        Dictionary<string, object> PointE(P s)
        {
            var p = new DBPoint(U.Pt(s, "at"));
            Add(p, s);
            return One("point", p);
        }

        // ---------------------------------------------------------------- text

        static readonly Dictionary<string, AttachmentPoint> Align = new Dictionary<string, AttachmentPoint>
        {
            { "left", AttachmentPoint.BaseLeft }, { "center", AttachmentPoint.BaseCenter }, { "right", AttachmentPoint.BaseRight },
            { "middle", AttachmentPoint.BaseMid },
            { "top_left", AttachmentPoint.TopLeft }, { "top_center", AttachmentPoint.TopCenter }, { "top_right", AttachmentPoint.TopRight },
            { "middle_left", AttachmentPoint.MiddleLeft }, { "middle_center", AttachmentPoint.MiddleCenter }, { "middle_right", AttachmentPoint.MiddleRight },
            { "bottom_left", AttachmentPoint.BottomLeft }, { "bottom_center", AttachmentPoint.BottomCenter }, { "bottom_right", AttachmentPoint.BottomRight },
        };

        static AttachmentPoint Attach(P s, string key, AttachmentPoint def)
        {
            string a = s.Str(key);
            if (a == null) return def;
            AttachmentPoint r;
            if (!Align.TryGetValue(a.ToLowerInvariant(), out r)) throw new McpError(key + " must be one of " + string.Join(", ", Align.Keys));
            return r;
        }

        double TextHeight(P s)
        {
            if (s.Has("height")) return Pos(s, "height");
            var st = (TextStyleTableRecord)_tr.GetObject(s.Has("style") ? U.TextStyle(_db, _tr, s.Str("style")) : _db.Textstyle, OpenMode.ForRead);
            return st.TextSize > 0 ? st.TextSize : _db.Textsize;
        }

        Dictionary<string, object> TextE(P s)
        {
            string txt = s.ReqStr("text");
            if (txt.Contains("\n")) return MTextE(s);
            var t = new DBText();
            t.SetDatabaseDefaults(_db);
            t.TextString = txt;
            if (s.Has("style")) t.TextStyleId = U.TextStyle(_db, _tr, s.Str("style"));
            t.Height = TextHeight(s);
            t.Rotation = U.Rad(s.Num("rotation", 0));
            if (s.Has("width_factor")) t.WidthFactor = Pos(s, "width_factor");
            Point3d at = U.Pt(s, "at");
            AttachmentPoint ap = Attach(s, "align", AttachmentPoint.BaseLeft);
            t.Position = at;
            if (ap != AttachmentPoint.BaseLeft)
            {
                t.Justify = ap;
                t.AlignmentPoint = at;
            }
            Add(t, s, false);
            if (ap != AttachmentPoint.BaseLeft) t.AdjustAlignment(_db);
            return One("text", t);
        }

        public MText MakeMText(P s, string contents, Point3d at)
        {
            var m = new MText();
            m.SetDatabaseDefaults(_db);
            if (s.Has("style")) m.TextStyleId = U.TextStyle(_db, _tr, s.Str("style"));
            m.TextHeight = TextHeight(s);
            m.Location = at;
            m.Attachment = Attach(s, "align", AttachmentPoint.TopLeft);
            if (s.Has("width")) m.Width = Pos(s, "width");
            m.Rotation = U.Rad(s.Num("rotation", 0));
            if (s.Has("line_spacing")) m.LineSpacingFactor = Math.Max(0.25, Math.Min(4, s.Num("line_spacing", 1)));
            // Plain newlines become MText paragraph breaks.
            m.Contents = contents.Replace("\r\n", "\n").Replace("\n", "\\P");
            return m;
        }

        Dictionary<string, object> MTextE(P s)
        {
            var m = MakeMText(s, s.ReqStr("text"), U.Pt(s, "at"));
            Add(m, s, false);
            return One("mtext", m);
        }

        // ---------------------------------------------------------------- hatch

        Dictionary<string, object> HatchE(P s)
        {
            var loops = new List<List<Point3d>>();
            var loopBulges = new List<List<object>>();
            if (s.Has("boundary")) { loops.Add(U.Pts(s, "boundary", 3)); loopBulges.Add(s.List("bulges")); }
            if (s.Has("boundaries"))
            {
                var bl = s.List("boundaries");
                for (int i = 0; i < bl.Count; i++) { loops.Add(U.PtList(bl[i], s.Path + ".boundaries[" + i + "]")); loopBulges.Add(null); }
            }
            List<ObjectId> ids = U.Ids(_db, s, "boundary_handles", false);
            if (loops.Count == 0 && ids.Count == 0) throw new McpError("give boundary (points), boundaries (list of loops) or boundary_handles");
            var h = MakeHatch(s, loops, loopBulges, ids);
            return One("hatch", h);
        }

        /// <summary>Non-associative hatch from point loops (first loop outer, then islands; Normal style alternates fill).</summary>
        public Hatch MakeHatch(P s, List<List<Point3d>> loops, List<List<object>> bulges, List<ObjectId> boundaryIds)
        {
            var h = new Hatch();
            Add(h, s);
            string pattern = (s.Str("pattern") ?? "SOLID").ToUpperInvariant();
            try { h.SetHatchPattern(HatchPatternType.PreDefined, pattern); }
            catch (Exception) { throw new McpError("unknown hatch pattern '" + pattern + "' (e.g. SOLID, ANSI31, ANSI37, AR-CONC, AR-SAND, AR-BRSTD, AR-PARQ1, AR-B816, GRAVEL, EARTH, DOTS, NET, LINE, CROSS)"); }
            if (pattern != "SOLID")
            {
                // Scale and angle only exist once a pattern is set; setting the pattern again applies them.
                h.PatternScale = s.Has("scale") ? Pos(s, "scale") : 1;
                h.PatternAngle = U.Rad(s.Num("angle", 0));
                h.SetHatchPattern(HatchPatternType.PreDefined, pattern);
            }
            h.Associative = false;
            h.HatchStyle = HatchStyle.Normal;
            // Point loops become temporary closed polylines (the documented way to give a hatch its boundary), erased
            // once the hatch is evaluated: the hatch is not associative.
            var temp = new List<Polyline>();
            for (int i = 0; i < loops.Count; i++)
            {
                var pts = loops[i];
                if (pts.Count > 2 && pts[0].DistanceTo(pts[pts.Count - 1]) < 1e-9) pts = pts.Take(pts.Count - 1).ToList();
                if (pts.Count < 3) throw new McpError("hatch loop " + i + " needs at least 3 points");
                var pl = MakePoly(pts, bulges != null && i < bulges.Count ? bulges[i] : null, true, null);
                pl.SetDatabaseDefaults(_db);
                _space.AppendEntity(pl);
                _tr.AddNewlyCreatedDBObject(pl, true);
                temp.Add(pl);
                h.AppendLoop(i == 0 ? HatchLoopTypes.Outermost : HatchLoopTypes.Default, new ObjectIdCollection(new[] { pl.ObjectId }));
            }
            if (boundaryIds != null && boundaryIds.Count > 0)
            {
                foreach (ObjectId id in boundaryIds)
                {
                    var c = _tr.GetObject(id, OpenMode.ForRead) as Curve;
                    if (c == null || !c.Closed) throw new McpError("boundary handle " + id.Handle + " is not a closed curve");
                    h.AppendLoop(temp.Count == 0 ? HatchLoopTypes.Outermost : HatchLoopTypes.Default, new ObjectIdCollection(new[] { id }));
                }
            }
            h.EvaluateHatch(true);
            foreach (var pl in temp) pl.Erase();
            return h;
        }

        // ---------------------------------------------------------------- dimensions

        ObjectId DimStyleId(P s) { return U.DimStyle(_db, _tr, s.Str("style")); }

        double DimSpacing(ObjectId styleId)
        {
            var ds = (DimStyleTableRecord)_tr.GetObject(styleId, OpenMode.ForRead);
            double scale = ds.Dimscale > 0 ? ds.Dimscale : 1;
            return Math.Max(ds.Dimdli, ds.Dimtxt * 2.5) * scale;
        }

        static double DirAngle(P s, Point3d a, Point3d b)
        {
            object d = s.Raw("direction") ?? s.Raw("rotation");
            if (d is double deg) return U.Rad(deg);
            string dir = d as string;
            if (dir == "horizontal" || dir == "h") return 0;
            if (dir == "vertical" || dir == "v") return Math.PI / 2;
            if (dir == "aligned") return Math.Atan2(b.Y - a.Y, b.X - a.X);
            if (dir != null) throw new McpError("direction must be horizontal, vertical, aligned or an angle in degrees");
            return Math.Abs(b.X - a.X) >= Math.Abs(b.Y - a.Y) ? 0 : Math.PI / 2;
        }

        /// <summary>Dimension line point: "at" or "offset" (perpendicular to the measured direction, + = left of it).</summary>
        static Point3d DimLinePoint(P s, Point3d a, Point3d b, double ang)
        {
            if (s.Has("at")) return U.Pt(s, "at");
            double off = s.ReqNum("offset");
            var n = new Vector3d(-Math.Sin(ang), Math.Cos(ang), 0);
            Point3d mid = new Point3d((a.X + b.X) / 2, (a.Y + b.Y) / 2, 0);
            return mid + n * off;
        }

        Dictionary<string, object> Dim(P s)
        {
            string kind = (s.Str("kind") ?? "linear").ToLowerInvariant();
            string text = s.Str("text") ?? "";
            ObjectId st = DimStyleId(s);
            Dimension d;
            switch (kind)
            {
                case "linear":
                case "rotated":
                    {
                        Point3d a = U.Pt(s, "from"), b = U.Pt(s, "to");
                        double ang = DirAngle(s, a, b);
                        d = new RotatedDimension(ang, a, b, DimLinePoint(s, a, b, ang), text, st);
                        break;
                    }
                case "aligned":
                    {
                        Point3d a = U.Pt(s, "from"), b = U.Pt(s, "to");
                        double ang = Math.Atan2(b.Y - a.Y, b.X - a.X);
                        d = new AlignedDimension(a, b, DimLinePoint(s, a, b, ang), text, st);
                        break;
                    }
                case "angular":
                    d = new Point3AngularDimension(U.Pt(s, "center"), U.Pt(s, "from"), U.Pt(s, "to"), U.Pt(s, "at"), text, st);
                    break;
                case "radius":
                case "diameter":
                    {
                        Point3d c = U.Pt(s, "center");
                        double r = Pos(s, "radius"), ang = U.Rad(s.Num("angle", 45));
                        var dir = new Vector3d(Math.Cos(ang), Math.Sin(ang), 0);
                        d = kind == "radius"
                            ? (Dimension)new RadialDimension(c, c + dir * r, s.Num("leader_length", 0), text, st)
                            : new DiametricDimension(c + dir * r, c - dir * r, s.Num("leader_length", 0), text, st);
                        break;
                    }
                default:
                    throw new McpError("kind must be linear, aligned, angular, radius or diameter");
            }
            Add(d, s);
            d.DimensionStyle = st; // SetDatabaseDefaults switched it to the current style
            d.RecomputeDimensionBlock(true); // so the extents (bounds) include the text
            return One("dimension", d);
        }

        /// <summary>Continuous chain of rotated dimensions through points, plus an optional overall dimension further out.</summary>
        public Dictionary<string, object> DimChain(P s)
        {
            var pts = U.Pts(s, "points", 2);
            ObjectId st = DimStyleId(s);
            double ang = DirAngle(s, pts[0], pts[pts.Count - 1]);
            var u = new Vector3d(Math.Cos(ang), Math.Sin(ang), 0);
            var n = new Vector3d(-Math.Sin(ang), Math.Cos(ang), 0);
            // Sort along the direction and drop points that project onto the same place.
            var sorted = pts.OrderBy(p => (p - Point3d.Origin).DotProduct(u)).ToList();
            var uniq = new List<Point3d>();
            foreach (var p in sorted)
                if (uniq.Count == 0 || Math.Abs((p - uniq[uniq.Count - 1]).DotProduct(u)) > 1e-6) uniq.Add(p);
            if (uniq.Count < 2) throw new McpError("the points do not span any length in that direction");
            Point3d line = s.Has("at") ? U.Pt(s, "at") : pts[0] + n * s.ReqNum("offset");
            var es = new List<Entity>();
            for (int i = 0; i + 1 < uniq.Count; i++)
            {
                var d = new RotatedDimension(ang, uniq[i], uniq[i + 1], line, "", st);
                Add(d, s);
                d.DimensionStyle = st;
                d.RecomputeDimensionBlock(true);
                es.Add(d);
            }
            if (s.Bool("total", false) && uniq.Count > 2)
            {
                // Overall dimension one spacing further from the measured points than the chain.
                double side = (line - uniq[0]).DotProduct(n) >= 0 ? 1 : -1;
                double gap = s.Has("gap") ? s.Num("gap", 0) : DimSpacing(st);
                var d = new RotatedDimension(ang, uniq[0], uniq[uniq.Count - 1], line + n * side * gap, "", st);
                Add(d, s);
                d.DimensionStyle = st;
                d.RecomputeDimensionBlock(true);
                es.Add(d);
            }
            return Many("dim_chain", es);
        }

        // ---------------------------------------------------------------- leader

        Dictionary<string, object> LeaderE(P s)
        {
            var pts = U.Pts(s, "points", 2);
            var ml = new MLeader();
            Add(ml, s);
            if (s.Has("leader_style"))
            {
                // the multileader style of the view's scale (made by setup_styles with the dimension style of the same name)
                var dict = (DBDictionary)_tr.GetObject(_db.MLeaderStyleDictionaryId, OpenMode.ForRead);
                if (dict.Contains(s.Str("leader_style"))) ml.MLeaderStyle = dict.GetAt(s.Str("leader_style"));
            }
            if (s.Has("leader_linetype"))
            {
                // e.g. DASHED leaders of material tags
                ml.LeaderLineTypeId = U.EnsureLinetype(_db, _tr, s.Str("leader_linetype"));
            }
            if (s.Has("block"))
            {
                // a tag block (code box, description) as the content: the leader ends at its insertion point
                ObjectId bid = BlockId(s.Str("block"), null, false);
                Point3d bp = pts[pts.Count - 1];
                // block_scale is the size wanted in the drawing; the leader style's scale already multiplies the block
                double bs = s.Num("block_scale", 1);
                double styleScale = ml.Scale > 0 ? ml.Scale : 1;
                ml.ContentType = ContentType.BlockContent;
                ml.BlockContentId = bid;
                ml.BlockConnectionType = BlockConnectionType.ConnectBase;
                ml.BlockScale = new Scale3d(bs / styleScale);
                ml.BlockPosition = bp;
                ml.EnableLanding = false;
                ml.EnableDogleg = false;
                var btr = (BlockTableRecord)_tr.GetObject(bid, OpenMode.ForRead);
                P attrs = s.Obj("attributes");
                Matrix3d xf = Matrix3d.Displacement(bp - Point3d.Origin) * Matrix3d.Scaling(bs, Point3d.Origin);
                foreach (ObjectId id in btr)
                {
                    var ad = _tr.GetObject(id, OpenMode.ForRead) as AttributeDefinition;
                    if (ad == null || ad.Constant) continue;
                    using (var ar = new AttributeReference())
                    {
                        ar.SetAttributeFromBlock(ad, xf);
                        string key = attrs?.D.Keys.FirstOrDefault(k => k.Equals(ad.Tag, StringComparison.OrdinalIgnoreCase));
                        ar.TextString = key != null ? attrs.Str(key) ?? "" : "";
                        ml.SetBlockAttribute(id, ar);
                    }
                }
                // vertices from the arrow to the one before the block; the block's base closes the line
                int li = ml.AddLeaderLine(pts[pts.Count - 2]);
                for (int i = pts.Count - 3; i >= 0; i--) ml.AddFirstVertex(li, pts[i]);
                return One("leader", ml);
            }
            ml.ContentType = ContentType.MTextContent;
            var m = MakeMText(s, s.ReqStr("text"), pts[pts.Count - 1]);
            m.Attachment = pts[pts.Count - 1].X >= pts[0].X ? AttachmentPoint.MiddleLeft : AttachmentPoint.MiddleRight;
            double scale = ml.Scale > 0 ? ml.Scale : 1;
            m.TextHeight = TextHeight(s) / scale;
            ml.MText = m;
            // The leader style's scale (DIMSCALE of setup_styles) multiplies text height and arrow size.
            if (s.Has("height")) ml.TextHeight = Pos(s, "height") / scale;
            // The text first: a new leader line gets a vertex where it meets the landing. Then the line from the
            // vertex before the landing, the given landing point, and the earlier vertices added towards the arrow.
            ml.TextLocation = pts[pts.Count - 1];
            if (pts.Count == 2) ml.AddLeaderLine(pts[0]);
            else
            {
                int n = pts.Count - 1; // vertices pts[0..n-1], the last one at the landing
                int idx = n >= 2 ? ml.AddLeaderLine(pts[n - 2]) : ml.AddLeaderLine(pts[0]);
                ml.SetLastVertex(idx, pts[n - 1]);
                for (int i = n - 3; i >= 0; i--) ml.AddFirstVertex(idx, pts[i]);
            }
            return One("leader", ml);
        }

        // ---------------------------------------------------------------- blocks

        public ObjectId BlockId(string name, string file, bool redefine)
        {
            var bt = (BlockTable)_tr.GetObject(_db.BlockTableId, OpenMode.ForRead);
            if (string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(file)) name = Path.GetFileNameWithoutExtension(file);
            if (string.IsNullOrEmpty(name)) throw new McpError("name (or file) is required");
            if (bt.Has(name) && !(redefine && !string.IsNullOrEmpty(file))) return bt[name];
            if (string.IsNullOrEmpty(file))
                throw new McpError("block '" + name + "' is not defined in this drawing (define it with define_block, or pass file= a .dwg)");
            if (!File.Exists(file)) throw new McpError("file not found: " + file);
            using (var src = new Database(false, true))
            {
                src.ReadDwgFile(file, FileOpenMode.OpenForReadAndAllShare, true, "");
                src.CloseInput(true);
                return _db.Insert(name, src, true);
            }
        }

        public BlockReference InsertRef(ObjectId btrId, Point3d at, P s)
        {
            var br = new BlockReference(at, btrId);
            object sc = s.Raw("scale");
            if (sc is List<object> l && l.Count >= 2)
                br.ScaleFactors = new Scale3d(P.ToNum(l[0], "scale"), P.ToNum(l[1], "scale"), l.Count > 2 ? P.ToNum(l[2], "scale") : 1);
            else if (sc != null)
            {
                double f = P.ToNum(sc, "scale");
                if (f == 0) throw new McpError("scale must not be 0");
                br.ScaleFactors = new Scale3d(f);
            }
            br.Rotation = U.Rad(s.Num("rotation", 0));
            Add(br, s);
            var btr = (BlockTableRecord)_tr.GetObject(btrId, OpenMode.ForRead);
            if (btr.HasAttributeDefinitions)
            {
                P attrs = s.Obj("attributes");
                foreach (ObjectId id in btr)
                {
                    var ad = _tr.GetObject(id, OpenMode.ForRead) as AttributeDefinition;
                    if (ad == null || ad.Constant) continue;
                    var ar = new AttributeReference();
                    ar.SetAttributeFromBlock(ad, br.BlockTransform);
                    string val = null;
                    if (attrs != null)
                    {
                        string key = attrs.D.Keys.FirstOrDefault(k => k.Equals(ad.Tag, StringComparison.OrdinalIgnoreCase));
                        if (key != null) val = attrs.Str(key) ?? "";
                    }
                    // a field (the viewport scale, the layout name, an object's property) is made once the attribute is
                    // in the drawing; assigned as text, AutoCAD would make it at once, before {viewport} is known
                    bool field = IsFieldCode(val);
                    if (val != null) ar.TextString = field ? "" : val;
                    br.AttributeCollection.AppendAttribute(ar);
                    _tr.AddNewlyCreatedDBObject(ar, true);
                    if (field)
                    {
                        if (val.Contains("{viewport}")) PendingFields.Add(new KeyValuePair<ObjectId, string>(ar.ObjectId, val));
                        else ApplyField(ar, val);
                    }
                    if (ad.Justify != AttachmentPoint.BaseLeft) ar.AdjustAlignment(_db);
                }
            }
            return br;
        }

        Dictionary<string, object> Insert(P s)
        {
            ObjectId btrId = BlockId(s.Str("name"), s.Str("file"), s.Bool("redefine", false));
            var at = new List<Point3d>();
            if (s.Has("points")) at.AddRange(U.Pts(s, "points", 1));
            else at.Add(U.Pt(s, "at"));
            var es = at.Select(p => (Entity)InsertRef(btrId, p, s)).ToList();
            return es.Count == 1 ? One("block", es[0]) : Many("block", es);
        }

        // ---------------------------------------------------------------- table

        Dictionary<string, object> TableE(P s)
        {
            var rows = s.List("rows");
            if (rows == null || rows.Count == 0) throw new McpError("rows is required: [[\"cell\", ...], ...]");
            string title = s.Str("title");
            int cols = rows.Max(r => r is List<object> l ? l.Count : 1);
            int nrows = rows.Count + (title != null ? 1 : 0);
            double th = TextHeight(s);
            var t = new Table();
            t.SetDatabaseDefaults(_db);
            t.TableStyle = _db.Tablestyle;
            t.Position = U.Pt(s, "at");
            t.SetSize(nrows, cols);
            t.SetRowHeight(s.Has("row_height") ? Pos(s, "row_height") : th * 2.2);
            var widths = s.List("col_widths");
            for (int c = 0; c < cols; c++)
            {
                double w = widths != null && c < widths.Count ? P.ToNum(widths[c], "col_widths") : (s.Has("col_width") ? Pos(s, "col_width") : th * 12);
                t.Columns[c].Width = w;
            }
            int r0 = 0;
            if (title != null)
            {
                t.MergeCells(CellRange.Create(t, 0, 0, 0, cols - 1));
                t.Cells[0, 0].TextString = title;
                t.Cells[0, 0].TextHeight = th * 1.25;
                t.Cells[0, 0].Alignment = CellAlignment.MiddleCenter;
                r0 = 1;
            }
            for (int r = 0; r < rows.Count; r++)
            {
                var row = rows[r] as List<object> ?? new List<object> { rows[r] };
                for (int c = 0; c < cols; c++)
                {
                    Cell cell = t.Cells[r + r0, c];
                    string fieldCode = c < row.Count ? (row[c] is Dictionary<string, object> fd && fd.ContainsKey("field") ? Convert.ToString(fd["field"]) : row[c] as string) : null;
                    if (IsFieldCode(fieldCode))
                    {
                        // a quantity that follows the drawing: object properties, sums (AcExpr) of them, formulas of cells
                        cell.TextString = ResolveField(_db, fieldCode);
                        cell.TextHeight = th;
                        cell.Alignment = CellAlignment.MiddleRight;
                        continue;
                    }
                    if (c < row.Count && row[c] is Dictionary<string, object> bd && bd.ContainsKey("block"))
                    {
                        // a symbol in the cell (a light, a door): the block itself, scaled to fit
                        cell.BlockTableRecordId = BlockId(Convert.ToString(bd["block"]), null, false);
                        cell.Contents[0].IsAutoScale = true;
                        cell.Alignment = CellAlignment.MiddleCenter;
                        continue;
                    }
                    cell.TextString = c < row.Count && row[c] != null ? Convert.ToString(row[c], System.Globalization.CultureInfo.InvariantCulture) : "";
                    // decimal commas (Vietnamese, European) for the numbers
                    if (c < row.Count && row[c] is double && s.Has("decimal_separator")) cell.TextString = cell.TextString.Replace(".", s.Str("decimal_separator"));
                    cell.TextHeight = th;
                    cell.Alignment = r == 0 && s.Bool("header", true) ? CellAlignment.MiddleCenter
                        : (c < row.Count && row[c] is double ? CellAlignment.MiddleRight : CellAlignment.MiddleLeft);
                }
            }
            // Cell margins in proportion to the text (the table style's margins are tiny at large scales). The table-wide
            // margins are marked obsolete, but the per-cell Borders.*.Margin that replaces them leaves the layout
            // unchanged in AutoCAD 2024.
#pragma warning disable 618
            t.HorizontalCellMargin = th * 0.4;
            t.VerticalCellMargin = th * 0.25;
#pragma warning restore 618
            t.GenerateLayout();
            Add(t, s, false);
            return One("table", t);
        }
    }
}
