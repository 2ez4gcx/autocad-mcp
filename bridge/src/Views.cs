// Views: what a drawing tool draws is one view. Its entities carry the id of the view (extended data), so a later
// call can replace the view where it stands: erase what carries the id, draw again. What the server knows of a view
// (its tool, where it stands, the plan it was drawn from, its arguments) and the plan description itself are kept
// in the drawing (a dictionary of the named object dictionary), so a drawing reopened later can still be updated.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Views
    {
        public const string App = "ACADMCP_VIEW";
        const string DictName = "ACADMCP_STORE";
        const string ViewKey = "V_";   // the record of a view: V_<hash of its id>
        const int Chunk = 250;         // characters of a record string

        static void EnsureApp(Database db, Transaction tr)
        {
            var t = (RegAppTable)tr.GetObject(db.RegAppTableId, OpenMode.ForRead);
            if (t.Has(App)) return;
            t.UpgradeOpen();
            var r = new RegAppTableRecord { Name = App };
            t.Add(r);
            tr.AddNewlyCreatedDBObject(r, true);
        }

        /// <summary>The id of the view an entity belongs to, or null.</summary>
        public static string TagOf(Entity e)
        {
            ResultBuffer xd = null;
            try { xd = e.GetXDataForApplication(App); } catch (Exception) { return null; }
            if (xd == null) return null;
            using (xd)
            {
                foreach (TypedValue tv in xd)
                    if (tv.TypeCode == (int)DxfCode.ExtendedDataAsciiString) return tv.Value as string;
            }
            return null;
        }

        /// <summary>Marks a new entity (in the drawing, open for write) as part of a view.</summary>
        public static void Tag(Entity e, string id)
        {
            using (var rb = new ResultBuffer(new TypedValue((int)DxfCode.ExtendedDataRegAppName, App), new TypedValue((int)DxfCode.ExtendedDataAsciiString, id)))
                e.XData = rb;
        }

        static string KeyOf(string id)
        {
            using (var sha = SHA1.Create())
            {
                byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(id));
                var sb = new StringBuilder(ViewKey);
                for (int i = 0; i < 10; i++) sb.Append(h[i].ToString("x2"));
                return sb.ToString();
            }
        }

        static DBDictionary Store(Database db, Transaction tr, bool create)
        {
            var nod = (DBDictionary)tr.GetObject(db.NamedObjectsDictionaryId, OpenMode.ForRead);
            if (nod.Contains(DictName)) return (DBDictionary)tr.GetObject(nod.GetAt(DictName), create ? OpenMode.ForWrite : OpenMode.ForRead);
            if (!create) return null;
            nod.UpgradeOpen();
            var d = new DBDictionary();
            nod.SetAt(DictName, d);
            tr.AddNewlyCreatedDBObject(d, true);
            return d;
        }

        static string Read(Transaction tr, DBDictionary d, string key)
        {
            if (d == null || !d.Contains(key)) return null;
            var x = tr.GetObject(d.GetAt(key), OpenMode.ForRead) as Xrecord;
            if (x == null || x.Data == null) return null;
            var sb = new StringBuilder();
            using (ResultBuffer rb = x.Data)
            {
                foreach (TypedValue tv in rb) if (tv.TypeCode == (int)DxfCode.Text) sb.Append(tv.Value as string);
            }
            return sb.ToString();
        }

        static void Write(Transaction tr, DBDictionary d, string key, string value)
        {
            if (value == null)
            {
                if (d.Contains(key)) { var old = tr.GetObject(d.GetAt(key), OpenMode.ForWrite); d.Remove(key); old.Erase(); }
                return;
            }
            var rb = new ResultBuffer();
            for (int i = 0; i < value.Length; i += Chunk) rb.Add(new TypedValue((int)DxfCode.Text, value.Substring(i, Math.Min(Chunk, value.Length - i))));
            if (value.Length == 0) rb.Add(new TypedValue((int)DxfCode.Text, ""));
            if (d.Contains(key))
            {
                var x = (Xrecord)tr.GetObject(d.GetAt(key), OpenMode.ForWrite);
                x.Data = rb;
            }
            else
            {
                var x = new Xrecord { Data = rb };
                d.SetAt(key, x);
                tr.AddNewlyCreatedDBObject(x, true);
            }
        }

        /// <summary>
        /// Before a draw command draws: view {id, erase, meta, store}. With erase the entities that carry the id are
        /// erased first (the same transaction: one Undo step); what is drawn next carries the id. Returns what goes in
        /// the result (view: {id, erased, erased_bounds, locked}).
        /// </summary>
        public static Dictionary<string, object> Begin(Database db, Transaction tr, BlockTableRecord space, Drawer dr, P view)
        {
            if (view == null) return null;
            string id = view.Str("id");
            if (string.IsNullOrEmpty(id)) throw new McpError("view.id is required");
            if (id.Length > 200) throw new McpError("view.id is longer than 200 characters");
            EnsureApp(db, tr);
            var r = new Dictionary<string, object> { { "id", id } };
            if (view.Bool("erase", false))
            {
                int n = 0, locked = 0;
                Extents3d? ext = null;
                // the entities of the view first, then erased (the space is not changed while it is read)
                var mine = new List<Entity>();
                foreach (ObjectId oid in space)
                {
                    var e = tr.GetObject(oid, OpenMode.ForRead) as Entity;
                    if (e != null && TagOf(e) == id) mine.Add(e);
                }
                // what the view was, entity by entity: view_diff compares it with what is drawn now (revision clouds)
                var before = new List<KeyValuePair<string, Extents3d?>>();
                foreach (Entity e in mine)
                {
                    string sg = Sig(tr, e);
                    before.Add(new KeyValuePair<string, Extents3d?>(sg, U.Ext(e)));
                    var vs = Verts(e);
                    if (vs != null) BeforePts[db.Filename + "|" + id + "|" + sg] = vs;
                }
                Before[db.Filename + "|" + id] = before;
                foreach (Entity e in mine)
                {
                    try
                    {
                        Extents3d ge = e.GeometricExtents;
                        if (ext == null) ext = ge; else { var x = ext.Value; x.AddExtents(ge); ext = x; }
                    }
                    catch (Exception) { }
                    try { e.UpgradeOpen(); e.Erase(); n++; }
                    catch (Exception) { locked++; } // on a locked layer
                }
                r["erased"] = n;
                if (locked > 0) r["locked"] = locked;
                if (ext != null) r["erased_bounds"] = U.BoundsOut(ext);
            }
            dr.ViewTag = id;
            return r;
        }

        /// <summary>After a draw command drew: the record of the view (meta) and the values to keep in the drawing (store {key: text | null}).</summary>
        public static void End(Database db, Transaction tr, P view)
        {
            if (view == null) return;
            string meta = view.Str("meta");
            P store = view.Obj("store");
            if (meta == null && store == null) return;
            DBDictionary d = Store(db, tr, true);
            if (meta != null) Write(tr, d, KeyOf(view.Str("id")), meta);
            if (store != null)
                foreach (var kv in store.D)
                {
                    if (kv.Key.StartsWith(ViewKey)) throw new McpError("view.store: a key may not start with " + ViewKey);
                    Write(tr, d, kv.Key, kv.Value == null ? null : Convert.ToString(kv.Value));
                }
        }

        // the entities of each view as they were before its last update (drawing | view id)
        static readonly Dictionary<string, List<KeyValuePair<string, Extents3d?>>> Before = new Dictionary<string, List<KeyValuePair<string, Extents3d?>>>();
        // the vertices of the lines and polylines of a view before its update (by signature), for a finer diff
        static readonly Dictionary<string, List<double>> BeforePts = new Dictionary<string, List<double>>();

        /// <summary>The vertices of a line or polyline (x, y, x, y...), null for other entities.</summary>
        static List<double> Verts(Entity e)
        {
            var v = new List<double>();
            if (e is Line l) { v.Add(l.StartPoint.X); v.Add(l.StartPoint.Y); v.Add(l.EndPoint.X); v.Add(l.EndPoint.Y); return v; }
            if (e is Polyline pl) { for (int i = 0; i < pl.NumberOfVertices; i++) { var q = pl.GetPoint3dAt(i); v.Add(q.X); v.Add(q.Y); } return v; }
            return null;
        }

        static string N(double v) => Math.Round(v).ToString(System.Globalization.CultureInfo.InvariantCulture);
        static string Pt(Point3d p) => N(p.X) + "," + N(p.Y);

        /// <summary>A signature of what an entity draws: equal for an entity drawn again the same way.</summary>
        public static string Sig(Transaction tr, Entity e)
        {
            string head = e.GetRXClass().DxfName + "|" + e.Layer + "|";
            try
            {
                switch (e)
                {
                    case Line l:
                        {
                            string a = Pt(l.StartPoint), b = Pt(l.EndPoint);
                            return head + (string.CompareOrdinal(a, b) < 0 ? a + ";" + b : b + ";" + a);
                        }
                    case Polyline pl:
                        {
                            var sb = new StringBuilder(head + (pl.Closed ? "c" : "o"));
                            for (int i = 0; i < pl.NumberOfVertices; i++) sb.Append(";" + Pt(pl.GetPoint3dAt(i)) + "/" + Math.Round(pl.GetBulgeAt(i), 3).ToString(System.Globalization.CultureInfo.InvariantCulture));
                            return sb.ToString();
                        }
                    case Arc a: return head + Pt(a.Center) + ";" + N(a.Radius) + ";" + Pt(a.StartPoint) + ";" + Pt(a.EndPoint);
                    case Circle c: return head + Pt(c.Center) + ";" + N(c.Radius);
                    case DBText t: return head + t.TextString + ";" + Pt(t.Position) + ";" + N(t.Height * 10);
                    case MText m: return head + m.Contents + ";" + Pt(m.Location) + ";" + N(m.TextHeight * 10);
                    case BlockReference br:
                        {
                            var sb = new StringBuilder(head + U.BlockName(tr, br) + ";" + Pt(br.Position) + ";" + Math.Round(br.Rotation, 3) + ";" + Math.Round(br.ScaleFactors.X, 3));
                            foreach (ObjectId aid in br.AttributeCollection)
                                if (tr.GetObject(aid, OpenMode.ForRead) is AttributeReference at) sb.Append(";" + at.Tag + "=" + at.TextString);
                            return sb.ToString();
                        }
                    case Dimension d: return head + Math.Round(d.Measurement, 1) + ";" + d.DimensionText + ";" + Pt(d.TextPosition);
                    case Hatch h:
                        {
                            // its boundary: a wall band moved inside the same extents is a change
                            double sum = 0;
                            int nv = 0;
                            for (int i = 0; i < h.NumberOfLoops; i++)
                            {
                                HatchLoop lp = h.GetLoopAt(i);
                                if (lp.IsPolyline) foreach (BulgeVertex v in lp.Polyline) { sum += v.Vertex.X + 3 * v.Vertex.Y; nv++; }
                                else foreach (Curve2d c in lp.Curves) { sum += c.StartPoint.X + 3 * c.StartPoint.Y; nv++; }
                            }
                            var hx = U.Ext(h);
                            return head + h.PatternName + ";" + h.NumberOfLoops + ";" + nv + ";" + Math.Round(sum).ToString(System.Globalization.CultureInfo.InvariantCulture) + (hx == null ? "" : ";" + Pt(hx.Value.MinPoint) + ";" + Pt(hx.Value.MaxPoint));
                        }
                }
            }
            catch (Exception) { }
            var x = U.Ext(e);
            return head + (x == null ? "" : Pt(x.Value.MinPoint) + ";" + Pt(x.Value.MaxPoint));
        }

        /// <summary>
        /// view_diff {id}: what the view draws now against what it drew before its last update: the extents of the
        /// entities that are gone (removed) and of those that are new (added), entity by entity. Layer A-ANNO-REVS (the
        /// clouds themselves) is left out.
        /// </summary>
        public static object Diff(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string id = p.Str("id");
            if (string.IsNullOrEmpty(id)) throw new McpError("view_diff: give the id of a view");
            string key = db.Filename + "|" + id;
            if (!Before.TryGetValue(key, out var before)) return new Dictionary<string, object> { { "id", id }, { "known", false } };
            string skip = p.Str("skip_layer") ?? "A-ANNO-REVS";
            var now = new Dictionary<string, List<Extents3d?>>();
            var nowPts = new Dictionary<string, List<List<double>>>();
            using (Transaction tr = db.TransactionManager.StartOpenCloseTransaction())
            {
                var space = U.ModelSpace(db, tr, OpenMode.ForRead);
                foreach (ObjectId oid in space)
                {
                    var e = tr.GetObject(oid, OpenMode.ForRead) as Entity;
                    if (e == null || TagOf(e) != id || e.Layer.Equals(skip, StringComparison.OrdinalIgnoreCase)) continue;
                    string sg = Sig(tr, e);
                    if (!now.TryGetValue(sg, out var l)) now[sg] = l = new List<Extents3d?>();
                    l.Add(U.Ext(e));
                    if (!nowPts.TryGetValue(sg, out var lp)) nowPts[sg] = lp = new List<List<double>>();
                    lp.Add(Verts(e));
                }
                tr.Commit();
            }
            var removed = new List<object>();
            int same = 0;
            foreach (var kv in before)
            {
                if (kv.Key.Split('|').Length > 1 && kv.Key.Split('|')[1].Equals(skip, StringComparison.OrdinalIgnoreCase)) continue;
                if (now.TryGetValue(kv.Key, out var l) && l.Count > 0) { l.RemoveAt(l.Count - 1); nowPts[kv.Key].RemoveAt(nowPts[kv.Key].Count - 1); same++; continue; }
                if (kv.Value != null) removed.Add(Item(kv.Value.Value, kv.Key, BeforePts.TryGetValue(key + "|" + kv.Key, out var bp) ? bp : null));
            }
            var added = new List<object>();
            foreach (var kv in now)
                for (int i = 0; i < kv.Value.Count; i++)
                    if (kv.Value[i] != null) added.Add(Item(kv.Value[i].Value, kv.Key, nowPts[kv.Key][i]));
            if (p.Bool("forget", false))
            {
                Before.Remove(key);
                foreach (var k in BeforePts.Keys.Where(k => k.StartsWith(key + "|")).ToList()) BeforePts.Remove(k);
            }
            return new Dictionary<string, object> { { "id", id }, { "known", true }, { "same", same }, { "removed", removed }, { "added", added } };
        }

        static List<object> Box(Extents3d x) => new List<object> { Math.Round(x.MinPoint.X, 1), Math.Round(x.MinPoint.Y, 1), Math.Round(x.MaxPoint.X, 1), Math.Round(x.MaxPoint.Y, 1) };

        /// <summary>A changed entity: its extents, its layer and type, and the vertices of a line or polyline.</summary>
        static Dictionary<string, object> Item(Extents3d x, string sig, List<double> pts)
        {
            var parts = sig.Split('|');
            var d = new Dictionary<string, object> { { "b", Box(x) }, { "t", parts[0] }, { "l", parts.Length > 1 ? parts[1] : "" } };
            if (pts != null) d["p"] = pts.Select(v => (object)Math.Round(v, 1)).ToList();
            if (parts[0] == "LWPOLYLINE" && parts.Length > 2 && parts[2].StartsWith("c", StringComparison.Ordinal)) d["c"] = true;
            return d;
        }

        /// <summary>
        /// view_list {keys: [...], forget: [ids]}: the views of the drawing (their records, how many entities still
        /// carry each id and their extents) and the stored values asked for. forget removes the records of views
        /// (their entities stay, untagged entities are not touched).
        /// </summary>
        public static object List(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var result = new Dictionary<string, object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var live = new Dictionary<string, int>();
                var ext = new Dictionary<string, Extents3d>();
                var space = U.ModelSpace(db, tr, OpenMode.ForRead);
                foreach (ObjectId oid in space)
                {
                    var e = tr.GetObject(oid, OpenMode.ForRead) as Entity;
                    if (e == null) continue;
                    string id = TagOf(e);
                    if (id == null) continue;
                    live[id] = live.ContainsKey(id) ? live[id] + 1 : 1;
                    try
                    {
                        Extents3d ge = e.GeometricExtents;
                        if (ext.ContainsKey(id)) { var x = ext[id]; x.AddExtents(ge); ext[id] = x; } else ext[id] = ge;
                    }
                    catch (Exception) { }
                }
                DBDictionary d = Store(db, tr, false);
                var views = new List<object>();
                var seen = new HashSet<string>();
                if (d != null)
                {
                    foreach (DBDictionaryEntry en in d)
                    {
                        if (!en.Key.StartsWith(ViewKey)) continue;
                        string meta = Read(tr, d, en.Key);
                        views.Add(new Dictionary<string, object> { { "key", en.Key }, { "meta", meta } });
                    }
                }
                result["views"] = views;
                var counts = new Dictionary<string, object>();
                foreach (var kv in live)
                    counts[kv.Key] = new Dictionary<string, object> { { "entities", kv.Value }, { "bounds", ext.ContainsKey(kv.Key) ? U.BoundsOut(ext[kv.Key]) : null } };
                result["live"] = counts;
                var keys = p.List("keys");
                if (keys != null)
                {
                    var vals = new Dictionary<string, object>();
                    foreach (object k in keys) vals[Convert.ToString(k)] = Read(tr, d, Convert.ToString(k));
                    result["values"] = vals;
                }
                tr.Commit();
            }
            return result;
        }
    }
}
