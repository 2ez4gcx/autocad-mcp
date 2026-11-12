// measure_model: AutoCAD's own solid modeler measures prisms and planar faces the server describes, so the quantities
// of the server can be checked against an independent, exact kernel: the volume of every prism, the volume of the
// union of all of them (members that overlap are counted once) and of each group, the area and perimeter of every
// face with its holes (a face may be the union of several outlines: add). Nothing is added to the drawing: the solids
// and regions live in memory only.
using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Measure
    {
        /// <summary>A region of an outline, united with more outlines (add), less its holes (each a list of points).</summary>
        static Region Face(List<Point3d> outline, List<object> holes, string name, List<object> add = null)
        {
            Region r = Geo.RegionFrom(outline, name);
            if (add != null)
            {
                // united two by two in rounds, as the solids are: one region growing through every union is slow
                var work = new List<Region> { r };
                try
                {
                    for (int i = 0; i < add.Count; i++) work.Add(Geo.RegionFrom(U.PtList(add[i], name + ".add[" + i + "]"), name + ".add[" + i + "]"));
                    while (work.Count > 1)
                    {
                        var next = new List<Region>();
                        for (int k = 0; k + 1 < work.Count; k += 2)
                        {
                            work[k].BooleanOperation(BooleanOperationType.BoolUnite, work[k + 1]);
                            work[k + 1].Dispose();
                            next.Add(work[k]);
                        }
                        if (work.Count % 2 == 1) next.Add(work[work.Count - 1]);
                        work = next;
                    }
                    r = work[0];
                }
                catch (Exception)
                {
                    foreach (var w in work) w.Dispose();
                    throw;
                }
            }
            if (holes == null) return r;
            for (int i = 0; i < holes.Count; i++)
            {
                using (Region h = Geo.RegionFrom(U.PtList(holes[i], name + ".holes[" + i + "]"), name + ".holes[" + i + "]"))
                    r.BooleanOperation(BooleanOperationType.BoolSubtract, h);
            }
            return r;
        }

        /// <summary>The prism of a profile (with holes) between z0 and z1.</summary>
        static Solid3d Prism(P s, string name)
        {
            double z0 = s.ReqNum("z0"), z1 = s.ReqNum("z1");
            if (z1 - z0 <= 1e-9) throw new McpError(name + ": z1 must be above z0");
            using (Region r = Face(U.Pts(s, "profile", 3), s.List("holes"), name))
            {
                var sol = new Solid3d();
                sol.Extrude(r, z1 - z0, 0);
                if (Math.Abs(z0) > 1e-12) sol.TransformBy(Matrix3d.Displacement(new Vector3d(0, 0, z0)));
                return sol;
            }
        }

        static double Volume(Solid3d s)
        {
            try { return s.MassProperties.Volume; }
            catch (Exception) { return 0; } // an empty solid (a union with nothing in it)
        }

        public static object Run(Ctx ctx, P p)
        {
            var result = new Dictionary<string, object>();
            var solids = p.List("solids");
            if (solids != null && solids.Count > 0)
            {
                var rows = new List<object>();
                var all = new List<Solid3d>();
                var groups = new Dictionary<string, List<int>>();
                var keys = new List<double[]>(); // level, x, y of each prism: neighbours are united first
                double sum = 0;
                try
                {
                    for (int i = 0; i < solids.Count; i++)
                    {
                        var s = new P(solids[i], "solids[" + i + "]");
                        string id = s.Str("id") ?? i.ToString();
                        Solid3d sol = Prism(s, "solids[" + i + "]");
                        var pf = U.Pts(s, "profile", 3);
                        keys.Add(new[] { s.ReqNum("z0"), pf.Min(q => q.X), pf.Min(q => q.Y) });
                        all.Add(sol);
                        double v = Volume(sol);
                        sum += v;
                        string g = s.Str("group") ?? "";
                        if (!groups.ContainsKey(g)) groups[g] = new List<int>();
                        groups[g].Add(i);
                        rows.Add(new Dictionary<string, object> { { "id", id }, { "group", g }, { "volume", v } });
                    }
                    // the union of everything (and of each group when asked): overlapping members counted once. The
                    // solids are united two by two in rounds (neighbours first: they are sorted by level and place), so
                    // that most unions join small solids; one solid growing through every union would take minutes.
                    Func<List<int>, double> union = idx =>
                    {
                        var work = new List<Solid3d>();
                        try
                        {
                            foreach (int k in idx) work.Add((Solid3d)all[k].Clone());
                            while (work.Count > 1)
                            {
                                var next = new List<Solid3d>();
                                for (int k = 0; k + 1 < work.Count; k += 2)
                                {
                                    work[k].BooleanOperation(BooleanOperationType.BoolUnite, work[k + 1]);
                                    work[k + 1].Dispose();
                                    next.Add(work[k]);
                                }
                                if (work.Count % 2 == 1) next.Add(work[work.Count - 1]);
                                work = next;
                            }
                            return work.Count == 0 ? 0 : Volume(work[0]);
                        }
                        finally { foreach (var w in work) w.Dispose(); }
                    };
                    var order = Enumerable.Range(0, all.Count).OrderBy(k => keys[k][0]).ThenBy(k => keys[k][1]).ThenBy(k => keys[k][2]).ToList();
                    double total = union(order);
                    var byGroup = new Dictionary<string, object>();
                    if (p.Bool("groups", false))
                        foreach (var kv in groups) byGroup[kv.Key] = union(kv.Value.OrderBy(k => keys[k][0]).ThenBy(k => keys[k][1]).ThenBy(k => keys[k][2]).ToList());
                    result["solids"] = rows;
                    result["sum"] = sum;
                    result["union"] = total;
                    result["overlap"] = sum - total;
                    result["union_by_group"] = byGroup;
                }
                finally { foreach (var s in all) s.Dispose(); }
            }
            var faces = p.List("faces");
            if (faces != null && faces.Count > 0)
            {
                var rows = new List<object>();
                double area = 0;
                for (int i = 0; i < faces.Count; i++)
                {
                    var f = new P(faces[i], "faces[" + i + "]");
                    using (Region r = Face(U.Pts(f, "outline", 3), f.List("holes"), "faces[" + i + "]", f.List("add")))
                    {
                        double a = 0, per = 0;
                        try { a = r.Area; per = r.Perimeter; } catch (Exception) { }
                        area += a;
                        rows.Add(new Dictionary<string, object> { { "id", f.Str("id") ?? i.ToString() }, { "area", a }, { "perimeter", per } });
                    }
                }
                result["faces"] = rows;
                result["area"] = area;
            }
            if (result.Count == 0) throw new McpError("measure_model: give solids [{id, group, profile, holes, z0, z1}] and / or faces [{id, outline, add, holes}]");
            return result;
        }
    }
}
