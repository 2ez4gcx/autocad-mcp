// Layouts (paper size, plot device, a scaled viewport, paper-space title block entities) and PDF export with the
// "DWG To PDF.pc3" device (several layouts = one multi-page PDF).
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.PlottingServices;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Sheets
    {
        public const string Device = "DWG To PDF.pc3";

        /// <summary>Canonical media name for an ISO paper (A0-A4) on the device, and the rotation that gives the wanted orientation.</summary>
        static string Media(PlotSettingsValidator psv, PlotSettings ps, string paper, bool landscape, out PlotRotation rot)
        {
            paper = paper.ToUpperInvariant();
            var names = psv.GetCanonicalMediaNameList(ps).Cast<string>().ToList();
            string pick = names.FirstOrDefault(n => n.StartsWith("ISO_full_bleed_" + paper + "_", StringComparison.OrdinalIgnoreCase))
                ?? names.FirstOrDefault(n => n.StartsWith("ISO_" + paper + "_", StringComparison.OrdinalIgnoreCase))
                ?? names.FirstOrDefault(n => n.IndexOf("_" + paper + "_", StringComparison.OrdinalIgnoreCase) >= 0);
            if (pick == null) throw new McpError("Paper " + paper + " not found for " + Device + " (A0, A1, A2, A3, A4)");
            var m = Regex.Match(pick, @"\(([\d.]+)_x_([\d.]+)_MM\)");
            bool mediaLandscape = !m.Success || double.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture) >= double.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
            rot = mediaLandscape == landscape ? PlotRotation.Degrees000 : PlotRotation.Degrees090;
            return pick;
        }

        static void SetCtb(PlotSettingsValidator psv, PlotSettings ps, string ctb)
        {
            try { psv.SetCurrentStyleSheet(ps, ctb); }
            catch (Exception) { /* the plot style table may not exist on this machine (STB drawings): keep the current one */ }
        }

        public static object CreateLayout(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string name = p.ReqStr("name");
            string paper = p.Str("paper") ?? "A3";
            bool landscape = (p.Str("orientation") ?? "landscape") != "portrait";
            LayoutManager lm = LayoutManager.Current;
            var res = new Dictionary<string, object> { { "name", name } };
            if (p.Has("styles")) Styles.Setup(ctx, p.Obj("styles"));
            if (lm.LayoutExists(name))
            {
                if (!p.Bool("replace", false)) throw new McpError("Layout '" + name + "' exists (pass replace=true to rebuild it)");
                if (lm.CurrentLayout.Equals(name, StringComparison.OrdinalIgnoreCase)) lm.CurrentLayout = "Model";
                lm.DeleteLayout(name);
            }
            ObjectId lid = lm.CreateLayout(name);
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lay = (Layout)tr.GetObject(lid, OpenMode.ForWrite);
                PlotSettingsValidator psv = PlotSettingsValidator.Current;
                psv.SetPlotConfigurationName(lay, Device, null);
                psv.RefreshLists(lay);
                PlotRotation rot;
                string media = Media(psv, lay, paper, landscape, out rot);
                psv.SetCanonicalMediaName(lay, media);
                psv.SetPlotPaperUnits(lay, PlotPaperUnit.Millimeters);
                psv.SetPlotRotation(lay, rot);
                psv.SetPlotType(lay, Autodesk.AutoCAD.DatabaseServices.PlotType.Layout);
                psv.SetUseStandardScale(lay, true);
                psv.SetStdScaleType(lay, StdScaleType.StdScale1To1);
                psv.SetPlotOrigin(lay, Point2d.Origin);
                SetCtb(psv, lay, p.Str("plot_style") ?? "monochrome.ctb");
                res["media"] = media;
                tr.Commit();
            }
            // Activating the layout initialises it (AutoCAD may add a default viewport, removed below).
            lm.CurrentLayout = name;
            var fieldIds = new List<ObjectId>();
            var pendingAttrs = new List<ObjectId>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                var lay = (Layout)tr.GetObject(lid, OpenMode.ForRead);
                var paperSpace = (BlockTableRecord)tr.GetObject(lay.BlockTableRecordId, OpenMode.ForWrite);
                ObjectIdCollection vps = lay.GetViewports();
                for (int i = 1; i < vps.Count; i++) tr.GetObject(vps[i], OpenMode.ForWrite).Erase();
                foreach (ObjectId id in paperSpace)
                {
                    var vp = tr.GetObject(id, OpenMode.ForRead) as Viewport;
                    if (vp != null && vps.Count > 0 && id != vps[0] && !vp.IsErased) { vp.UpgradeOpen(); vp.Erase(); }
                }
                var dr = new Drawer(db, tr, paperSpace, p.Obj("layer_styles"));
                res["entities"] = dr.DrawAll(p.List("entities"), "entities").Count;
                // one viewport, or several (views at their own scales); the title block fields show the first one
                var views = new List<P>();
                if (p.Obj("viewport") != null) views.Add(p.Obj("viewport"));
                var more = p.List("viewports");
                if (more != null) for (int i = 0; i < more.Count; i++) views.Add(new P(more[i], "viewports[" + i + "]"));
                var handles = new List<object>();
                foreach (P v in views)
                {
                    var vp = new Viewport();
                    dr.Add(vp, new P(new Dictionary<string, object> { { "layer", v.Str("layer") ?? "A-ANNO-VPRT" } }, "viewport"));
                    vp.CenterPoint = U.Pt(v, "center");
                    vp.Width = v.ReqNum("width");
                    vp.Height = v.ReqNum("height");
                    vp.ViewDirection = Vector3d.ZAxis;
                    vp.ViewTarget = Point3d.Origin;
                    Point3d vc = U.Pt(v, "view_center");
                    vp.ViewCenter = new Point2d(vc.X, vc.Y);
                    vp.CustomScale = v.ReqNum("scale_factor");
                    vp.On = true;
                    vp.Locked = v.Bool("locked", true);
                    handles.Add(vp.Handle.ToString());
                    if (handles.Count > 1) continue;
                    res["viewport_handle"] = vp.Handle.ToString();
                    // title block attributes that show the viewport (its scale)
                    foreach (var pf in dr.PendingFields)
                    {
                        var ar = (AttributeReference)tr.GetObject(pf.Key, OpenMode.ForWrite);
                        fieldIds.Add(dr.ApplyField(ar, pf.Value.Replace("{viewport}", Drawer.ObjId(vp.ObjectId))));
                        pendingAttrs.Add(pf.Key);
                    }
                    res["fields"] = dr.PendingFields.Count;
                }
                if (handles.Count > 1) res["viewport_handles"] = handles;
                if (dr.CreatedLayers.Count > 0) res["created_layers"] = dr.CreatedLayers;
                tr.Commit();
            }
            // a field of a viewport made in the same transaction reads #### until the viewport is in the drawing:
            // evaluated again now
            if (fieldIds.Count > 0)
            {
                using (Transaction tr = db.TransactionManager.StartTransaction())
                {
                    foreach (ObjectId id in fieldIds) ((Field)tr.GetObject(id, OpenMode.ForWrite)).Evaluate();
                    foreach (ObjectId id in pendingAttrs)
                    {
                        var ar = (AttributeReference)tr.GetObject(id, OpenMode.ForWrite);
                        if (ar.Justify != AttachmentPoint.BaseLeft) ar.AdjustAlignment(db);
                    }
                    tr.Commit();
                }
            }
            if (!p.Bool("activate", true)) lm.CurrentLayout = "Model";
            res["current_layout"] = lm.CurrentLayout;
            return res;
        }

        public static object ExportPdf(Ctx ctx, P p)
        {
            Document doc = ctx.Doc;
            Database db = ctx.Db;
            string path = Path.GetFullPath(p.ReqStr("path"));
            if (!path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase)) path += ".pdf";
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            if (PlotFactory.ProcessPlotState != ProcessPlotState.NotPlotting) throw new McpError("AutoCAD is already plotting; wait and retry.");
            var wanted = p.Strings("layouts");
            var sheets = new List<KeyValuePair<ObjectId, PlotSettings>>();
            var names = new List<string>();
            var files = new List<object>();
            object bgp = AcApp.GetSystemVariable("BACKGROUNDPLOT");
            using (doc.LockDocument())
            {
            string original = LayoutManager.Current.CurrentLayout;
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                PlotSettingsValidator psv = PlotSettingsValidator.Current;
                var dict = (DBDictionary)tr.GetObject(db.LayoutDictionaryId, OpenMode.ForRead);
                var layouts = new List<Layout>();
                foreach (DBDictionaryEntry de in dict) layouts.Add((Layout)tr.GetObject(de.Value, OpenMode.ForRead));
                layouts = layouts.OrderBy(l => l.TabOrder).ToList();
                List<Layout> chosen;
                if (wanted == null || wanted.Count == 0)
                {
                    string cur = LayoutManager.Current.CurrentLayout;
                    chosen = layouts.Where(l => l.LayoutName.Equals(cur, StringComparison.OrdinalIgnoreCase)).ToList();
                }
                else if (wanted.Count == 1 && wanted[0] == "all") chosen = layouts.Where(l => !l.ModelType).ToList();
                else
                {
                    chosen = new List<Layout>();
                    foreach (string w in wanted)
                    {
                        var l = layouts.FirstOrDefault(x => x.LayoutName.Equals(w, StringComparison.OrdinalIgnoreCase));
                        if (l == null) throw new McpError("Layout '" + w + "' not found (" + string.Join(", ", layouts.Select(x => x.LayoutName)) + ")");
                        chosen.Add(l);
                    }
                }
                if (chosen.Count == 0) throw new McpError("No layout to plot.");
                foreach (Layout l in chosen)
                {
                    var ps = new PlotSettings(l.ModelType);
                    ps.CopyFrom(l);
                    psv.SetPlotConfigurationName(ps, Device, null);
                    psv.RefreshLists(ps);
                    if (l.ModelType)
                    {
                        // Model space: a window (or the extents) fitted or at a scale on the chosen paper.
                        PlotRotation rot;
                        psv.SetCanonicalMediaName(ps, Media(psv, ps, p.Str("paper") ?? "A3", (p.Str("orientation") ?? "landscape") != "portrait", out rot));
                        psv.SetPlotRotation(ps, rot);
                        psv.SetPlotPaperUnits(ps, PlotPaperUnit.Millimeters);
                        if (p.Has("window"))
                        {
                            var w = U.PtList(p.Raw("window"), "window");
                            psv.SetPlotWindowArea(ps, new Extents2d(Math.Min(w[0].X, w[1].X), Math.Min(w[0].Y, w[1].Y), Math.Max(w[0].X, w[1].X), Math.Max(w[0].Y, w[1].Y)));
                            psv.SetPlotType(ps, Autodesk.AutoCAD.DatabaseServices.PlotType.Window);
                        }
                        else psv.SetPlotType(ps, Autodesk.AutoCAD.DatabaseServices.PlotType.Extents);
                        if (p.Has("scale"))
                        {
                            psv.SetUseStandardScale(ps, false);
                            psv.SetCustomPrintScale(ps, new CustomScale(U.ToMetres(db) * 1000, p.ReqNum("scale")));
                        }
                        else
                        {
                            psv.SetUseStandardScale(ps, true);
                            psv.SetStdScaleType(ps, StdScaleType.ScaleToFit);
                        }
                        psv.SetPlotCentered(ps, true);
                    }
                    else
                    {
                        // Keep the layout's own paper when the PDF device has it.
                        try { psv.SetCanonicalMediaName(ps, l.CanonicalMediaName); }
                        catch (Exception)
                        {
                            PlotRotation rot;
                            psv.SetCanonicalMediaName(ps, Media(psv, ps, "A3", true, out rot));
                        }
                    }
                    SetCtb(psv, ps, p.Str("plot_style") ?? "monochrome.ctb");
                    sheets.Add(new KeyValuePair<ObjectId, PlotSettings>(l.ObjectId, ps));
                    names.Add(l.LayoutName);
                }
                tr.Commit();
            }
            // One plot document holds one paper size only (BeginPage refuses another size with eInvalidPlotInfo): sheets
            // are grouped by paper, one PDF per group, in the order of their first sheet.
            var groups = new List<List<int>>();
            var keys = new List<string>();
            for (int i = 0; i < sheets.Count; i++)
            {
                string key = sheets[i].Value.CanonicalMediaName + "|" + sheets[i].Value.PlotRotation;
                int g = keys.IndexOf(key);
                if (g < 0) { keys.Add(key); groups.Add(new List<int>()); g = groups.Count - 1; }
                groups[g].Add(i);
            }
            try
            {
                AcApp.SetSystemVariable("BACKGROUNDPLOT", (short)0);
                for (int g = 0; g < groups.Count; g++)
                {
                    string file = groups.Count == 1 ? path
                        : Path.Combine(Path.GetDirectoryName(path), Path.GetFileNameWithoutExtension(path) + "_" + PaperLabel(sheets[groups[g][0]].Value) + ".pdf");
                    var idx = groups[g];
                    try { PlotGroup(doc, idx.Select(i => sheets[i]).ToList(), idx.Select(i => names[i]).ToList(), file); }
                    catch (Exception)
                    {
                        // Never leave a truncated PDF behind.
                        try { File.Delete(file); } catch (Exception) { }
                        throw;
                    }
                    files.Add(new Dictionary<string, object>
                    {
                        { "pdf", file }, { "layouts", idx.Select(i => (object)names[i]).ToList() }, { "paper", PaperLabel(sheets[idx[0]].Value) },
                        { "bytes", File.Exists(file) ? new FileInfo(file).Length : 0 },
                    });
                }
            }
            finally
            {
                AcApp.SetSystemVariable("BACKGROUNDPLOT", bgp);
                foreach (var s in sheets) s.Value.Dispose();
                try { LayoutManager.Current.CurrentLayout = original; } catch (Exception) { }
            }
            }
            var r = new Dictionary<string, object> { { "pages", sheets.Count } };
            if (files.Count == 1) foreach (var kv in (Dictionary<string, object>)files[0]) r[kv.Key] = kv.Value;
            else
            {
                r["pdfs"] = files;
                r["note"] = "The layouts use different paper sizes: one PDF per paper size.";
            }
            return r;
        }

        /// <summary>"A3", "A3-portrait"... from the media name and rotation of plot settings.</summary>
        static string PaperLabel(PlotSettings ps)
        {
            var m = Regex.Match(ps.CanonicalMediaName ?? "", @"_(A\d)_\(([\d.]+)_x_([\d.]+)_MM\)", RegexOptions.IgnoreCase);
            if (!m.Success) return Regex.Replace(ps.CanonicalMediaName ?? "paper", @"[^A-Za-z0-9]+", "-").Trim('-');
            double a = double.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
            double b = double.Parse(m.Groups[3].Value, System.Globalization.CultureInfo.InvariantCulture);
            bool rotated = ps.PlotRotation == PlotRotation.Degrees090 || ps.PlotRotation == PlotRotation.Degrees270;
            bool landscape = (a >= b) != rotated;
            return m.Groups[1].Value.ToUpperInvariant() + (landscape ? "" : "-portrait");
        }

        static void PlotGroup(Document doc, List<KeyValuePair<ObjectId, PlotSettings>> sheets, List<string> names, string file)
        {
            using (PlotEngine pe = PlotFactory.CreatePublishEngine())
            using (var ppd = new PlotProgressDialog(false, sheets.Count, false))
            {
                ppd.OnBeginPlot();
                ppd.IsVisible = false;
                pe.BeginPlot(ppd, null);
                for (int i = 0; i < sheets.Count; i++)
                {
                    // AutoCAD plots only the current layout.
                    LayoutManager.Current.CurrentLayout = names[i];
                    var pi = new PlotInfo { Layout = sheets[i].Key, OverrideSettings = sheets[i].Value };
                    var piv = new PlotInfoValidator { MediaMatchingPolicy = MatchingPolicy.MatchEnabled };
                    piv.Validate(pi);
                    if (i == 0) pe.BeginDocument(pi, doc.Name, null, 1, true, file);
                    ppd.OnBeginSheet();
                    pe.BeginPage(new PlotPageInfo(), pi, i == sheets.Count - 1, null);
                    pe.BeginGenerateGraphics(null);
                    pe.EndGenerateGraphics(null);
                    pe.EndPage(null);
                    ppd.OnEndSheet();
                }
                pe.EndDocument(null);
                ppd.OnEndPlot();
                pe.EndPlot(null);
            }
        }
    }
}
