// Shared helpers: points, handles, colors, lineweights, layers, linetypes, styles, entity summaries.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class U
    {
        public static double R(double v, int digits = 3) { return Math.Round(v, digits); }

        public static Point3d Pt(object o, string name)
        {
            var l = o as List<object>;
            if (l == null && o is string s && s.TrimStart().StartsWith("[")) l = Json.Parse(s) as List<object>;
            if (l == null || l.Count < 2 || l.Count > 3) throw new McpError(name + " must be a point [x, y] or [x, y, z]");
            return new Point3d(P.ToNum(l[0], name + "[0]"), P.ToNum(l[1], name + "[1]"), l.Count > 2 ? P.ToNum(l[2], name + "[2]") : 0);
        }

        public static Point3d Pt(P p, string key)
        {
            object o = p.Raw(key);
            if (o == null) throw new McpError((p.Path == "" ? key : p.Path + "." + key) + " is required");
            return Pt(o, p.Path == "" ? key : p.Path + "." + key);
        }

        public static Point3d? OptPt(P p, string key)
        {
            return p.Has(key) ? Pt(p, key) : (Point3d?)null;
        }

        public static List<Point3d> Pts(P p, string key, int min = 1)
        {
            var l = p.List(key);
            string name = p.Path == "" ? key : p.Path + "." + key;
            if (l == null) throw new McpError(name + " is required");
            if (l.Count < min) throw new McpError(name + " needs at least " + min + " points");
            var r = new List<Point3d>();
            for (int i = 0; i < l.Count; i++) r.Add(Pt(l[i], name + "[" + i + "]"));
            return r;
        }

        public static List<Point3d> PtList(object o, string name)
        {
            var l = o as List<object>;
            if (l == null) throw new McpError(name + " must be an array of points");
            var r = new List<Point3d>();
            for (int i = 0; i < l.Count; i++) r.Add(Pt(l[i], name + "[" + i + "]"));
            return r;
        }

        public static List<object> Xy(Point3d p) { return new List<object> { R(p.X), R(p.Y) }; }

        public static List<object> Xyz(Point3d p)
        {
            return Math.Abs(p.Z) < 1e-9 ? Xy(p) : new List<object> { R(p.X), R(p.Y), R(p.Z) };
        }

        public static double Rad(double deg) { return deg * Math.PI / 180.0; }

        public static double Deg(double rad) { return R(rad * 180.0 / Math.PI, 4); }

        // ---------------------------------------------------------------- handles

        public static string H(ObjectId id) { return id.Handle.ToString(); }

        public static ObjectId Id(Database db, string handle)
        {
            if (string.IsNullOrWhiteSpace(handle)) throw new McpError("Empty handle");
            long v;
            if (!long.TryParse(handle.Trim(), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v))
                throw new McpError("Invalid handle '" + handle + "' (handles are hexadecimal, e.g. \"2A7\")");
            ObjectId id;
            if (!db.TryGetObjectId(new Handle(v), out id) || id.IsNull || id.IsErased)
                throw new McpError("No object with handle " + handle + " in this drawing (it may have been deleted or undone).");
            return id;
        }

        public static List<ObjectId> Ids(Database db, P p, string key = "handles", bool required = true)
        {
            var hs = p.Strings(key);
            if (hs == null || hs.Count == 0)
            {
                if (required) throw new McpError(key + " is required (handles from query_entities, selection_info or draw results)");
                return new List<ObjectId>();
            }
            return hs.Select(h => Id(db, h)).Distinct().ToList();
        }

        // ---------------------------------------------------------------- colors and lineweights

        /// <summary>"bylayer", "byblock", ACI 1-255, [r,g,b] or "#rrggbb".</summary>
        public static Color Col(object v, string name)
        {
            if (v is double d)
            {
                int aci = (int)Math.Round(d);
                if (aci == 256) return Color.FromColorIndex(ColorMethod.ByLayer, 256);
                if (aci == 0) return Color.FromColorIndex(ColorMethod.ByBlock, 0);
                if (aci < 1 || aci > 255) throw new McpError(name + ": color index must be 1-255");
                return Color.FromColorIndex(ColorMethod.ByAci, (short)aci);
            }
            if (v is List<object> l && l.Count == 3)
                return Color.FromRgb((byte)P.ToNum(l[0], name), (byte)P.ToNum(l[1], name), (byte)P.ToNum(l[2], name));
            if (v is string s)
            {
                s = s.Trim().ToLowerInvariant();
                if (s == "bylayer") return Color.FromColorIndex(ColorMethod.ByLayer, 256);
                if (s == "byblock") return Color.FromColorIndex(ColorMethod.ByBlock, 0);
                if (s.StartsWith("#") && s.Length == 7)
                    return Color.FromRgb(Convert.ToByte(s.Substring(1, 2), 16), Convert.ToByte(s.Substring(3, 2), 16), Convert.ToByte(s.Substring(5, 2), 16));
                string[] names = { "", "red", "yellow", "green", "cyan", "blue", "magenta", "white" };
                int i = Array.IndexOf(names, s);
                if (i > 0) return Color.FromColorIndex(ColorMethod.ByAci, (short)i);
                short n;
                if (short.TryParse(s, out n)) return Col((double)n, name);
            }
            throw new McpError(name + ": color must be \"bylayer\", \"byblock\", an index 1-255, [r,g,b] or \"#rrggbb\"");
        }

        public static object ColOut(Color c)
        {
            if (c.IsByLayer) return "bylayer";
            if (c.IsByBlock) return "byblock";
            if (c.ColorMethod == ColorMethod.ByAci) return (int)c.ColorIndex;
            if (c.ColorMethod == ColorMethod.ByColor || c.ColorMethod == ColorMethod.ByPen)
                return string.Format("#{0:x2}{1:x2}{2:x2}", c.Red, c.Green, c.Blue);
            return c.ToString();
        }

        static readonly int[] Weights = { 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211 };

        /// <summary>Lineweight in mm (0.25), or "bylayer"/"byblock"/"default".</summary>
        public static LineWeight Lw(object v, string name)
        {
            if (v is string s)
            {
                s = s.Trim().ToLowerInvariant();
                if (s == "bylayer") return LineWeight.ByLayer;
                if (s == "byblock") return LineWeight.ByBlock;
                if (s == "default") return LineWeight.ByLineWeightDefault;
                double mm;
                if (double.TryParse(s.Replace("mm", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out mm)) v = mm;
            }
            if (v is double d)
            {
                if (d < 0) return d <= -3 ? LineWeight.ByLineWeightDefault : d <= -2 ? LineWeight.ByBlock : LineWeight.ByLayer;
                int hund = (int)Math.Round(d > 2.2 ? d : d * 100); // accept 0.25 (mm) or 25 (1/100 mm)
                int best = Weights.OrderBy(w => Math.Abs(w - hund)).First();
                return (LineWeight)best;
            }
            throw new McpError(name + ": lineweight must be in mm (e.g. 0.25) or \"bylayer\"");
        }

        public static object LwOut(LineWeight w)
        {
            if (w == LineWeight.ByLayer) return "bylayer";
            if (w == LineWeight.ByBlock) return "byblock";
            if (w == LineWeight.ByLineWeightDefault) return "default";
            return R((int)w / 100.0, 2);
        }

        // ---------------------------------------------------------------- units

        public static string UnitName(Database db)
        {
            switch (db.Insunits)
            {
                case UnitsValue.Millimeters: return "mm";
                case UnitsValue.Centimeters: return "cm";
                case UnitsValue.Meters: return "m";
                case UnitsValue.Inches: return "in";
                case UnitsValue.Feet: return "ft";
                case UnitsValue.Undefined: return "unitless";
                default: return db.Insunits.ToString();
            }
        }

        /// <summary>Metres per drawing unit (unitless drawings are treated as mm, the Vietnamese/ISO convention).</summary>
        public static double ToMetres(Database db)
        {
            switch (db.Insunits)
            {
                case UnitsValue.Centimeters: return 0.01;
                case UnitsValue.Meters: return 1;
                case UnitsValue.Inches: return 0.0254;
                case UnitsValue.Feet: return 0.3048;
                case UnitsValue.Decimeters: return 0.1;
                default: return 0.001;
            }
        }

        // ---------------------------------------------------------------- symbol tables

        public static ObjectId EnsureLinetype(Database db, Transaction tr, string name)
        {
            if (string.IsNullOrEmpty(name)) return ObjectId.Null;
            var lt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
            string key = name;
            if (lt.Has(key)) return lt[key];
            foreach (string file in new[] { db.Measurement == MeasurementValue.Metric ? "acadiso.lin" : "acad.lin", "acadiso.lin", "acad.lin" })
            {
                try
                {
                    db.LoadLineTypeFile(key, file);
                    lt = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
                    if (lt.Has(key)) return lt[key];
                }
                catch (Exception) { }
            }
            throw new McpError("Linetype '" + name + "' is not in the drawing nor in acadiso.lin/acad.lin " +
                "(common: Continuous, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, BORDER, DIVIDE, ACAD_ISO02W100...)");
        }

        /// <summary>Layer properties from a JSON object: color, linetype, lineweight, plot, description, transparency, on, frozen, locked.</summary>
        public static void ApplyLayerStyle(Database db, Transaction tr, LayerTableRecord ltr, P s)
        {
            if (s == null) return;
            if (s.Has("color")) ltr.Color = Col(s.Raw("color"), s.Path + ".color");
            if (s.Has("linetype")) ltr.LinetypeObjectId = EnsureLinetype(db, tr, s.Str("linetype"));
            if (s.Has("lineweight")) ltr.LineWeight = Lw(s.Raw("lineweight"), s.Path + ".lineweight");
            if (s.Has("plot")) ltr.IsPlottable = s.Bool("plot", true);
            if (s.Has("description")) ltr.Description = s.Str("description");
            if (s.Has("transparency"))
            {
                double t = Math.Max(0, Math.Min(90, s.Num("transparency", 0)));
                ltr.Transparency = new Transparency((byte)Math.Round(255 * (1 - t / 100.0)));
            }
            if (s.Has("on")) ltr.IsOff = !s.Bool("on", true);
            if (s.Has("frozen") && ltr.ObjectId != db.Clayer) ltr.IsFrozen = s.Bool("frozen", false);
            if (s.Has("locked")) ltr.IsLocked = s.Bool("locked", false);
        }

        /// <summary>Returns the layer id, creating the layer (with styles[name] when given) if it does not exist.</summary>
        public static ObjectId EnsureLayer(Database db, Transaction tr, string name, P styles, List<string> created)
        {
            if (string.IsNullOrEmpty(name)) return db.Clayer;
            var lt = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
            if (lt.Has(name))
            {
                ObjectId id = lt[name];
                if (id.IsErased) throw new McpError("Layer '" + name + "' was erased");
                return id;
            }
            try { SymbolUtilityServices.ValidateSymbolName(name, false); }
            catch (Exception) { throw new McpError("Invalid layer name '" + name + "' (not allowed: < > / \\ \" : ; ? * | , = `)"); }
            var ltr = new LayerTableRecord { Name = name };
            lt.UpgradeOpen();
            ObjectId nid = lt.Add(ltr);
            tr.AddNewlyCreatedDBObject(ltr, true);
            P st = styles != null ? styles.Obj(name) : null;
            ApplyLayerStyle(db, tr, ltr, st);
            if (created != null) created.Add(name);
            return nid;
        }

        public static ObjectId TextStyle(Database db, Transaction tr, string name)
        {
            if (string.IsNullOrEmpty(name)) return db.Textstyle;
            var t = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
            if (!t.Has(name)) throw new McpError("Text style '" + name + "' not found (create it with setup_styles)");
            return t[name];
        }

        public static ObjectId DimStyle(Database db, Transaction tr, string name)
        {
            if (string.IsNullOrEmpty(name)) return db.Dimstyle;
            var t = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
            if (!t.Has(name)) throw new McpError("Dimension style '" + name + "' not found (create it with setup_styles)");
            return t[name];
        }

        public static BlockTableRecord CurrentSpace(Database db, Transaction tr, OpenMode mode)
        {
            return (BlockTableRecord)tr.GetObject(db.CurrentSpaceId, mode);
        }

        public static BlockTableRecord ModelSpace(Database db, Transaction tr, OpenMode mode)
        {
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            return (BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace], mode);
        }

        public static string LayerName(Transaction tr, ObjectId layerId)
        {
            return ((LayerTableRecord)tr.GetObject(layerId, OpenMode.ForRead)).Name;
        }

        // ---------------------------------------------------------------- entities

        public static string TypeName(Entity e)
        {
            string dxf = e.GetRXClass().DxfName;
            return string.IsNullOrEmpty(dxf) ? e.GetType().Name.ToUpperInvariant() : dxf;
        }

        public static Extents3d? Ext(Entity e)
        {
            try
            {
                Extents3d x = e.GeometricExtents;
                if (double.IsNaN(x.MinPoint.X) || Math.Abs(x.MinPoint.X) > 1e20) return null;
                return x;
            }
            catch (Exception) { return null; }
        }

        public static Dictionary<string, object> BoundsOut(Extents3d? x)
        {
            if (x == null) return null;
            Extents3d e = x.Value;
            return new Dictionary<string, object>
            {
                { "min", Xy(e.MinPoint) }, { "max", Xy(e.MaxPoint) },
                { "size", new List<object> { R(e.MaxPoint.X - e.MinPoint.X), R(e.MaxPoint.Y - e.MinPoint.Y) } },
            };
        }

        /// <summary>Extents of the visible objects (on layers that are on and thawed) of a space; null when empty.</summary>
        public static Extents3d? SpaceExtents(Database db, Transaction tr, ObjectId spaceId)
        {
            Extents3d? acc = null;
            var space = (BlockTableRecord)tr.GetObject(spaceId, OpenMode.ForRead);
            var hidden = new Dictionary<ObjectId, bool>();
            foreach (ObjectId id in space)
            {
                var e = tr.GetObject(id, OpenMode.ForRead) as Entity;
                if (e == null || !e.Visible || e is Viewport) continue;
                if (!hidden.TryGetValue(e.LayerId, out bool off))
                {
                    var lay = (LayerTableRecord)tr.GetObject(e.LayerId, OpenMode.ForRead);
                    hidden[e.LayerId] = off = lay.IsOff || lay.IsFrozen;
                }
                if (!off) Grow(ref acc, Ext(e));
            }
            return acc;
        }

        public static void Grow(ref Extents3d? acc, Extents3d? x)
        {
            if (x == null) return;
            if (acc == null) acc = x;
            else { Extents3d a = acc.Value; a.AddExtents(x.Value); acc = a; }
        }

        public static string BlockName(Transaction tr, BlockReference br)
        {
            try
            {
                ObjectId id = br.IsDynamicBlock ? br.DynamicBlockTableRecord : br.BlockTableRecord;
                return ((BlockTableRecord)tr.GetObject(id, OpenMode.ForRead)).Name;
            }
            catch (Exception) { return br.Name; }
        }

        public static Dictionary<string, object> Attributes(Transaction tr, BlockReference br)
        {
            var d = new Dictionary<string, object>();
            foreach (ObjectId aid in br.AttributeCollection)
            {
                var a = tr.GetObject(aid, OpenMode.ForRead) as AttributeReference;
                if (a != null) d[a.Tag] = a.IsMTextAttribute ? a.MTextAttribute.Text : a.TextString;
            }
            return d;
        }

        /// <summary>Short summary of an entity: handle, type, layer and its main geometry.</summary>
        public static Dictionary<string, object> Info(Transaction tr, Entity e, bool detail, double toM)
        {
            var d = new Dictionary<string, object>
            {
                { "handle", e.Handle.ToString() }, { "type", TypeName(e) }, { "layer", e.Layer },
            };
            if (!e.Color.IsByLayer) d["color"] = ColOut(e.Color);
            if (detail)
            {
                if (e.Linetype != "ByLayer") d["linetype"] = e.Linetype;
                if (e.LineWeight != LineWeight.ByLayer) d["lineweight"] = LwOut(e.LineWeight);
            }
            switch (e)
            {
                case Line l:
                    d["from"] = Xyz(l.StartPoint); d["to"] = Xyz(l.EndPoint); d["length"] = R(l.Length);
                    break;
                case Polyline pl:
                    d["closed"] = pl.Closed; d["vertices"] = pl.NumberOfVertices; d["length"] = R(pl.Length);
                    if (pl.Closed) d["area_m2"] = R(pl.Area * toM * toM, 4);
                    if (detail)
                    {
                        var pts = new List<object>();
                        bool arcs = false;
                        for (int i = 0; i < Math.Min(pl.NumberOfVertices, 500); i++)
                        {
                            pts.Add(Xy(pl.GetPoint3dAt(i)));
                            if (Math.Abs(pl.GetBulgeAt(i)) > 1e-9) arcs = true;
                        }
                        d["points"] = pts;
                        if (arcs)
                        {
                            var b = new List<object>();
                            for (int i = 0; i < Math.Min(pl.NumberOfVertices, 500); i++) b.Add(R(pl.GetBulgeAt(i), 6));
                            d["bulges"] = b;
                        }
                        if (pl.ConstantWidth > 0) d["width"] = R(pl.ConstantWidth);
                    }
                    break;
                case Circle c:
                    d["center"] = Xyz(c.Center); d["radius"] = R(c.Radius);
                    break;
                case Arc a:
                    d["center"] = Xyz(a.Center); d["radius"] = R(a.Radius);
                    d["start_angle"] = Deg(a.StartAngle); d["end_angle"] = Deg(a.EndAngle); d["length"] = R(a.Length);
                    break;
                case DBText t:
                    d["text"] = t.TextString; d["at"] = Xyz(t.Position); d["height"] = R(t.Height);
                    if (Math.Abs(t.Rotation) > 1e-9) d["rotation"] = Deg(t.Rotation);
                    if (detail) d["style"] = t.TextStyleName;
                    break;
                case MText m:
                    d["text"] = m.Text; d["at"] = Xyz(m.Location); d["height"] = R(m.TextHeight);
                    if (detail) { d["contents"] = m.Contents; d["style"] = m.TextStyleName; d["width"] = R(m.Width); }
                    break;
                case Table tb:
                    d["at"] = Xyz(tb.Position); d["rows"] = tb.Rows.Count; d["columns"] = tb.Columns.Count;
                    break;
                case BlockReference br:
                    d["name"] = BlockName(tr, br); d["at"] = Xyz(br.Position);
                    if (Math.Abs(br.Rotation) > 1e-9) d["rotation"] = Deg(br.Rotation);
                    Scale3d s = br.ScaleFactors;
                    if (Math.Abs(s.X - 1) > 1e-9 || Math.Abs(s.Y - 1) > 1e-9 || Math.Abs(s.Z - 1) > 1e-9)
                        d["scale"] = new List<object> { R(s.X, 4), R(s.Y, 4), R(s.Z, 4) };
                    if (br.AttributeCollection.Count > 0) d["attributes"] = Attributes(tr, br);
                    break;
                case Hatch h:
                    d["pattern"] = h.PatternName;
                    d["area_m2"] = R(Takeoff.HatchArea(h) * toM * toM, 4);
                    if (detail) { d["scale"] = R(h.PatternScale, 4); d["angle"] = Deg(h.PatternAngle); d["loops"] = h.NumberOfLoops; }
                    break;
                case Dimension dim:
                    try { d["measurement"] = R(dim.Measurement); } catch (Exception) { }
                    if (!string.IsNullOrEmpty(dim.DimensionText) && dim.DimensionText != "<>") d["text_override"] = dim.DimensionText;
                    if (detail) d["style"] = dim.DimensionStyleName;
                    break;
                case Ellipse el:
                    d["center"] = Xyz(el.Center); d["major_radius"] = R(el.MajorRadius); d["minor_radius"] = R(el.MinorRadius);
                    break;
                case RasterImage img:
                    try
                    {
                        var def = (RasterImageDef)tr.GetObject(img.ImageDefId, OpenMode.ForRead);
                        d["file"] = def.SourceFileName;
                        d["pixels"] = new List<object> { (int)def.Size.X, (int)def.Size.Y };
                    }
                    catch (Exception) { }
                    break;
            }
            if (detail || e is BlockReference || e is Hatch || e is RasterImage) d["bounds"] = BoundsOut(Ext(e));
            return d;
        }
    }
}
