// Views, screenshots (off-screen render, the user's view is untouched), reference images, importing drawings, files.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.GraphicsSystem;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Exception = System.Exception;
using GsView = Autodesk.AutoCAD.GraphicsSystem.View;
using Image = System.Drawing.Image;
using Font = System.Drawing.Font;

namespace AcadMcp
{
    public static class Media
    {
        static readonly Dictionary<string, Vector3d> Directions = new Dictionary<string, Vector3d>
        {
            { "top", Vector3d.ZAxis }, { "bottom", -Vector3d.ZAxis }, { "front", -Vector3d.YAxis }, { "back", Vector3d.YAxis },
            { "left", -Vector3d.XAxis }, { "right", Vector3d.XAxis },
            { "iso", new Vector3d(1, -1, 1) }, { "iso_se", new Vector3d(1, -1, 1) }, { "iso_sw", new Vector3d(-1, -1, 1) },
            { "iso_ne", new Vector3d(1, 1, 1) }, { "iso_nw", new Vector3d(-1, 1, 1) },
        };

        /// <summary>Extents to frame: window, handles, or the drawing extents of the current space.</summary>
        static Extents3d? Target(Ctx ctx, P p, Transaction tr) { return Target(ctx, p, tr, ctx.Db.CurrentSpaceId); }

        static Extents3d? Target(Ctx ctx, P p, Transaction tr, ObjectId spaceId)
        {
            if (p.Has("window"))
            {
                var w = U.PtList(p.Raw("window"), "window");
                if (w.Count != 2) throw new McpError("window must be [[x1,y1],[x2,y2]]");
                var e = new Extents3d();
                e.AddPoint(w[0]);
                e.AddPoint(w[1]);
                return e;
            }
            Extents3d? acc = null;
            if (p.Has("handles"))
            {
                foreach (ObjectId id in U.Ids(ctx.Db, p)) U.Grow(ref acc, U.Ext((Entity)tr.GetObject(id, OpenMode.ForRead)));
                return acc;
            }
            return U.SpaceExtents(ctx.Db, tr, spaceId);
        }

        static Extents3d Pad(Extents3d e, double margin)
        {
            Vector3d d = e.MaxPoint - e.MinPoint;
            double m = Math.Max(d.X, d.Y) * margin;
            if (m <= 0) m = 1;
            return new Extents3d(e.MinPoint - new Vector3d(m, m, 0), e.MaxPoint + new Vector3d(m, m, 0));
        }

        public static object SetView(Ctx ctx, P p)
        {
            string view = (p.Str("view") ?? "extents").ToLowerInvariant();
            Editor ed = ctx.Ed;
            using (Transaction tr = ctx.Db.TransactionManager.StartTransaction())
            {
                Extents3d? ext = Target(ctx, p, tr);
                using (ViewTableRecord vtr = ed.GetCurrentView())
                {
                    if (Directions.TryGetValue(view, out Vector3d dir))
                    {
                        vtr.ViewDirection = dir.GetNormal();
                        vtr.ViewTwist = 0;
                    }
                    else if (view != "extents" && view != "current")
                        throw new McpError("view must be extents, top, bottom, front, back, left, right, iso, iso_se, iso_sw, iso_ne or iso_nw");
                    if (ext != null) Frame(vtr, Pad(ext.Value, p.Num("margin", 0.05)), vtr.Width / vtr.Height);
                    ed.SetCurrentView(vtr);
                }
                tr.Commit();
                return new Dictionary<string, object> { { "view", view }, { "framed", U.BoundsOut(ext) } };
            }
        }

        /// <summary>Centres a view record on extents (in its own view direction) with the given width/height ratio.</summary>
        static void Frame(ViewTableRecord vtr, Extents3d e, double ratio)
        {
            vtr.Target = e.MinPoint + (e.MaxPoint - e.MinPoint) / 2;
            Matrix3d toDcs = (Matrix3d.Rotation(-vtr.ViewTwist, vtr.ViewDirection, vtr.Target) *
                Matrix3d.Displacement(vtr.Target - Point3d.Origin) * Matrix3d.PlaneToWorld(vtr.ViewDirection)).Inverse();
            var dcs = new Extents3d();
            foreach (var c in Corners(e)) dcs.AddPoint(c.TransformBy(toDcs));
            double w = dcs.MaxPoint.X - dcs.MinPoint.X, h = dcs.MaxPoint.Y - dcs.MinPoint.Y;
            if (w > h * ratio) h = w / ratio; else w = h * ratio;
            vtr.CenterPoint = new Point2d((dcs.MinPoint.X + dcs.MaxPoint.X) / 2, (dcs.MinPoint.Y + dcs.MaxPoint.Y) / 2);
            vtr.Width = w;
            vtr.Height = h;
        }

        static IEnumerable<Point3d> Corners(Extents3d e)
        {
            Point3d a = e.MinPoint, b = e.MaxPoint;
            foreach (double x in new[] { a.X, b.X })
                foreach (double y in new[] { a.Y, b.Y })
                    foreach (double z in new[] { a.Z, b.Z })
                        yield return new Point3d(x, y, z);
        }

        // ---------------------------------------------------------------- screenshot

        public static object Screenshot(Ctx ctx, P p)
        {
            string path = p.ReqStr("path");
            int maxSize = Math.Max(64, Math.Min(4096, p.Int("max_size", 1400)));
            string view = (p.Str("view") ?? (p.Has("window") || p.Has("handles") ? "extents" : "current")).ToLowerInvariant();
            string bg = (p.Str("background") ?? "white").ToLowerInvariant();
            Document doc = ctx.Doc;
            var info = new Dictionary<string, object>();
            using (doc.LockDocument())
            using (Transaction tr = ctx.Db.TransactionManager.StartOpenCloseTransaction())
            {
                // Model space unless asked for the current space (a layout); "current" view = what the user sees.
                ObjectId spaceId = view == "current" || p.Str("space") == "current" ? ctx.Db.CurrentSpaceId : U.ModelSpace(ctx.Db, tr, OpenMode.ForRead).ObjectId;
                Extents3d? ext = view == "current" ? null : Target(ctx, p, tr, spaceId);
                if (view != "current" && ext == null) throw new McpError("Nothing to show: the drawing (or the given window/handles) is empty.");
                ViewTableRecord cur = ctx.Ed.GetCurrentView();
                int w, h;
                if (ext != null)
                {
                    Extents3d e = Pad(ext.Value, p.Num("margin", 0.04));
                    double ew = e.MaxPoint.X - e.MinPoint.X, eh = e.MaxPoint.Y - e.MinPoint.Y;
                    if (ew >= eh) { w = maxSize; h = (int)Math.Max(64, Math.Round(maxSize * eh / Math.Max(ew, 1e-9))); }
                    else { h = maxSize; w = (int)Math.Max(64, Math.Round(maxSize * ew / Math.Max(eh, 1e-9))); }
                }
                else
                {
                    double ratio = cur.Width / cur.Height;
                    if (ratio >= 1) { w = maxSize; h = (int)Math.Max(64, Math.Round(maxSize / ratio)); }
                    else { h = maxSize; w = (int)Math.Max(64, Math.Round(maxSize * ratio)); }
                }
                Extents3d? framed = ext == null ? (Extents3d?)null : Pad(ext.Value, p.Num("margin", 0.04));
                Bitmap bmp = null;
                try
                {
                    bmp = Offscreen(doc, tr, spaceId, framed, view, w, h, bg);
                    info["method"] = "offscreen";
                    if (IsBlank(bmp))
                    {
                        bmp.Dispose();
                        bmp = null;
                    }
                }
                catch (Exception e)
                {
                    Bridge.Log("screenshot offscreen: " + e);
                    if (bmp != null) bmp.Dispose();
                    bmp = null;
                }
                if (bmp == null)
                {
                    // Fallback: AutoCAD's own view image, the user's view being framed for the capture and then restored.
                    bmp = ViaUserView(ctx, framed, view, w, h);
                    info["method"] = "user_view";
                    info["note"] = "Captured through AutoCAD's view (its background color); the user's view was restored.";
                }
                using (bmp) bmp.Save(path, ImageFormat.Png);
                info["width"] = w;
                info["height"] = h;
                info["view"] = view;
                if (ext != null) info["framed"] = U.BoundsOut(ext);
                cur.Dispose();
            }
            return info;
        }

        // One graphics model per drawing, kept while the drawing is open: an object can belong to only one graphics model,
        // so a model created and destroyed for each screenshot only renders the first time.
        static readonly Dictionary<Database, Model> _models = new Dictionary<Database, Model>();
        static GraphicsKernel _kernel;

        public static void ForgetModel(Database db)
        {
            Model m;
            if (db == null || !_models.TryGetValue(db, out m)) return;
            _models.Remove(db);
            try { m.Dispose(); } catch (Exception) { }
        }

        static bool IsBlank(Bitmap b)
        {
            var data = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                int bytes = Math.Abs(data.Stride) * b.Height;
                var buf = new byte[bytes];
                System.Runtime.InteropServices.Marshal.Copy(data.Scan0, buf, 0, bytes);
                for (int i = 0; i + 2 < bytes; i += 12)
                    if (buf[i] < 230 || buf[i + 1] < 230 || buf[i + 2] < 230) return false;
                return true;
            }
            finally { b.UnlockBits(data); }
        }

        static Bitmap ViaUserView(Ctx ctx, Extents3d? ext, string view, int w, int h)
        {
            Editor ed = ctx.Ed;
            ViewTableRecord saved = ed.GetCurrentView();
            try
            {
                if (ext != null)
                {
                    using (ViewTableRecord vtr = ed.GetCurrentView())
                    {
                        if (Directions.TryGetValue(view, out Vector3d dir)) { vtr.ViewDirection = dir.GetNormal(); vtr.ViewTwist = 0; }
                        Frame(vtr, ext.Value, (double)w / h);
                        ed.SetCurrentView(vtr);
                    }
                    ed.UpdateScreen();
                }
                return ctx.Doc.CapturePreviewImage((uint)w, (uint)h);
            }
            finally
            {
                if (ext != null) { ed.SetCurrentView(saved); ed.UpdateScreen(); }
                saved.Dispose();
            }
        }

        static Bitmap Offscreen(Document doc, Transaction tr, ObjectId spaceId, Extents3d? ext, string view, int w, int h, string bg)
        {
            Manager gsm = doc.GraphicsManager;
            if (_kernel == null)
            {
                var kd = new KernelDescriptor();
                kd.addRequirement(KernelDescriptor.Drawing3D);
                _kernel = Manager.AcquireGraphicsKernel(kd);
            }
            GraphicsKernel gk = _kernel;
            Model model;
            if (!_models.TryGetValue(doc.Database, out model))
            {
                model = gsm.CreateAutoCADModel(gk);
                _models[doc.Database] = model;
            }
            using (var v = new GsView())
            {
                short cvport = Convert.ToInt16(AcApp.GetSystemVariable("CVPORT"));
                gsm.SetViewFromViewport(v, cvport);
                using (Device dev = gsm.CreateAutoCADOffScreenDevice(gk))
                {
                    dev.OnSize(new Size(w, h));
                    dev.DeviceRenderType = RendererType.Default;
                    // Color 7 draws black on the white background (a dark background would hide it).
                    dev.BackgroundColor = Color.White;
                    dev.Add(v);
                    if (ext != null)
                    {
                        // Camera set once the view is on the sized device; the field matches the image aspect.
                        Extents3d e = ext.Value;
                        Vector3d dir = Directions.TryGetValue(view, out Vector3d d) ? d.GetNormal() : Vector3d.ZAxis;
                        Point3d center = e.MinPoint + (e.MaxPoint - e.MinPoint) / 2;
                        double size = Math.Max(1, (e.MaxPoint - e.MinPoint).Length);
                        Vector3d up = Math.Abs(dir.Z) > 0.999 ? Vector3d.YAxis : Vector3d.ZAxis;
                        double fw = Math.Max(e.MaxPoint.X - e.MinPoint.X, 1), fh = Math.Max(e.MaxPoint.Y - e.MinPoint.Y, 1);
                        if (fw / fh > (double)w / h) fh = fw * h / w; else fw = fh * w / h;
                        v.SetView(center + dir * size * 2, center, up, fw, fh);
                    }
                    dev.Update();
                    var space = (BlockTableRecord)tr.GetObject(spaceId, OpenMode.ForRead);
                    v.Add(space, model);
                    v.Invalidate();
                    v.Update();
                    Bitmap bmp = v.GetSnapshot(new Rectangle(0, 0, w, h));
                    v.EraseAll();
                    dev.Erase(v);
                    return bmp;
                }
            }
        }

        // ---------------------------------------------------------------- view an image file (crop, pixel grid)

        public static object ViewImage(Ctx ctx, P p)
        {
            string src = p.ReqStr("path");
            string outPath = p.ReqStr("out_path");
            if (!File.Exists(src)) throw new McpError("Image not found: " + src);
            int maxSize = Math.Max(64, Math.Min(4096, p.Int("max_size", 1568)));
            using (var img = Image.FromFile(src))
            {
                int W = img.Width, H = img.Height;
                Rectangle crop = new Rectangle(0, 0, W, H);
                if (p.Has("crop"))
                {
                    var c = p.List("crop");
                    if (c == null || c.Count != 4) throw new McpError("crop must be [x0, y0, x1, y1] in pixels of the original image");
                    int x0 = (int)P.ToNum(c[0], "crop"), y0 = (int)P.ToNum(c[1], "crop"), x1 = (int)P.ToNum(c[2], "crop"), y1 = (int)P.ToNum(c[3], "crop");
                    x0 = Math.Max(0, Math.Min(W - 1, Math.Min(x0, x1))); x1 = Math.Max(x0 + 1, Math.Min(W, Math.Max(x0, x1)));
                    y0 = Math.Max(0, Math.Min(H - 1, Math.Min(y0, y1))); y1 = Math.Max(y0 + 1, Math.Min(H, Math.Max(y0, y1)));
                    crop = new Rectangle(x0, y0, x1 - x0, y1 - y0);
                }
                double scale = Math.Min(1.0 * maxSize / crop.Width, 1.0 * maxSize / crop.Height);
                if (!p.Bool("upscale", true)) scale = Math.Min(1, scale);
                int ow = Math.Max(1, (int)Math.Round(crop.Width * scale)), oh = Math.Max(1, (int)Math.Round(crop.Height * scale));
                int gridStep = 0;
                object g = p.Raw("grid");
                if (g is double gd) gridStep = (int)gd;
                else if (g is bool gb && gb || (g is string gs && gs == "auto"))
                {
                    // About 10 lines across, on a round step in original pixels.
                    double raw = Math.Max(crop.Width, crop.Height) / 10.0;
                    double pow = Math.Pow(10, Math.Floor(Math.Log10(raw)));
                    gridStep = (int)(new[] { 1, 2, 5, 10 }.Select(k => k * pow).First(k => k >= raw));
                }
                int margin = gridStep > 0 ? 28 : 0;
                using (var bmp = new Bitmap(ow + margin, oh + margin))
                using (var gr = Graphics.FromImage(bmp))
                {
                    gr.Clear(Color.White);
                    gr.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    gr.DrawImage(img, new Rectangle(margin, margin, ow, oh), crop, GraphicsUnit.Pixel);
                    if (gridStep > 0)
                    {
                        using (var pen = new Pen(Color.FromArgb(150, 255, 0, 0), 1))
                        using (var font = new Font("Arial", 8))
                        using (var brush = new SolidBrush(Color.Red))
                        {
                            for (int x = (crop.Left / gridStep + 1) * gridStep; x < crop.Right; x += gridStep)
                            {
                                float sx = margin + (float)((x - crop.Left) * scale);
                                gr.DrawLine(pen, sx, margin, sx, margin + oh);
                                gr.DrawString(x.ToString(), font, brush, sx - 10, 2);
                            }
                            for (int y = (crop.Top / gridStep + 1) * gridStep; y < crop.Bottom; y += gridStep)
                            {
                                float sy = margin + (float)((y - crop.Top) * scale);
                                gr.DrawLine(pen, margin, sy, margin + ow, sy);
                                gr.DrawString(y.ToString(), font, brush, 0, sy - 6);
                            }
                        }
                    }
                    bmp.Save(outPath, ImageFormat.Png);
                }
                return new Dictionary<string, object>
                {
                    { "image_size", new List<object> { W, H } },
                    { "crop", new List<object> { crop.Left, crop.Top, crop.Right, crop.Bottom } },
                    { "output_size", new List<object> { ow + margin, oh + margin } },
                    { "scale", U.R(scale, 5) }, { "grid_step_px", gridStep }, { "grid_margin_px", margin },
                    { "note", gridStep > 0 ? "Grid labels are pixel coordinates of the ORIGINAL image (x to the right, y down from the top-left corner)." : null },
                };
            }
        }

        // ---------------------------------------------------------------- reference image (raster underlay)

        static Dictionary<string, object> ImageFrame(Transaction tr, RasterImage img)
        {
            var def = (RasterImageDef)tr.GetObject(img.ImageDefId, OpenMode.ForRead);
            CoordinateSystem3d cs = img.Orientation;
            double pw = def.Size.X, ph = def.Size.Y;
            Vector3d ux = cs.Xaxis / pw, vy = cs.Yaxis / ph;
            // Pixel (px, py) measured from the TOP-left corner, y down -> drawing point.
            Point3d topLeft = cs.Origin + cs.Yaxis;
            return new Dictionary<string, object>
            {
                { "handle", img.Handle.ToString() }, { "file", def.SourceFileName }, { "pixels", new List<object> { (int)pw, (int)ph } },
                { "origin_bottom_left", U.Xy(cs.Origin) }, { "top_left", U.Xy(topLeft) },
                { "units_per_pixel", U.R(ux.Length, 6) }, { "rotation", U.Deg(Math.Atan2(ux.Y, ux.X)) },
                { "pixel_to_drawing", new Dictionary<string, object>
                    {
                        { "x", new List<object> { U.R(topLeft.X, 6), U.R(ux.X, 8), U.R(-vy.X, 8) } },
                        { "y", new List<object> { U.R(topLeft.Y, 6), U.R(ux.Y, 8), U.R(-vy.Y, 8) } },
                        { "formula", "x = x[0] + x[1]*px + x[2]*py ; y = y[0] + y[1]*px + y[2]*py (px right, py down from the image's top-left corner)" },
                    } },
                { "bounds", U.BoundsOut(U.Ext(img)) },
            };
        }

        public static object AttachImage(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string file = Path.GetFullPath(p.ReqStr("path"));
            if (!File.Exists(file)) throw new McpError("Image not found: " + file);
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                ObjectId dictId = RasterImageDef.GetImageDictionary(db);
                if (dictId.IsNull) dictId = RasterImageDef.CreateImageDictionary(db);
                var dict = (DBDictionary)tr.GetObject(dictId, OpenMode.ForWrite);
                string baseName = Path.GetFileNameWithoutExtension(file);
                string key = baseName;
                RasterImageDef def = null;
                for (int i = 1; dict.Contains(key); i++)
                {
                    var d = (RasterImageDef)tr.GetObject(dict.GetAt(key), OpenMode.ForRead);
                    if (string.Equals(Path.GetFullPath(d.SourceFileName), file, StringComparison.OrdinalIgnoreCase)) { def = d; break; }
                    key = baseName + "_" + i;
                }
                if (def == null)
                {
                    def = new RasterImageDef { SourceFileName = file };
                    def.Load();
                    dict.SetAt(key, def);
                    tr.AddNewlyCreatedDBObject(def, true);
                }
                double pw = def.Size.X, ph = def.Size.Y;
                if (pw < 1 || ph < 1) throw new McpError("AutoCAD could not read the image size of " + file);

                // Drawing units per image pixel.
                double upp;
                P cal = p.Obj("calibrate");
                if (cal != null)
                {
                    Point3d a = U.Pt(cal, "p1"), b = U.Pt(cal, "p2");
                    double px = a.DistanceTo(b);
                    if (px < 1) throw new McpError("calibrate.p1 and p2 must be different pixels");
                    upp = cal.ReqNum("distance") / px;
                }
                else if (p.Has("width")) upp = p.ReqNum("width") / pw;
                else upp = p.Num("units_per_pixel", 1);
                if (upp <= 0) throw new McpError("the image scale must be > 0");
                double rot = U.Rad(p.Num("rotation", 0));
                var ux = new Vector3d(Math.Cos(rot), Math.Sin(rot), 0) * upp;
                var vy = new Vector3d(-Math.Sin(rot), Math.Cos(rot), 0) * upp;
                // Placement: a chosen pixel at a drawing point (e.g. grid A-1 at 0,0), else the bottom-left corner at "at".
                Point3d origin;
                P anchor = p.Obj("anchor");
                if (anchor != null)
                {
                    Point3d px = U.Pt(anchor, "pixel"), at = U.Pt(anchor, "at");
                    origin = at - ux * px.X - vy * (ph - px.Y);
                }
                else origin = p.Has("at") ? U.Pt(p, "at") : Point3d.Origin;

                var img = new RasterImage();
                img.SetDatabaseDefaults(db);
                img.ImageDefId = def.ObjectId;
                img.Orientation = new CoordinateSystem3d(origin, ux * pw, vy * ph);
                img.ImageTransparency = true;
                img.ShowImage = true;
                img.Fade = (byte)Math.Max(0, Math.Min(90, p.Int("fade", 40)));
                var space = U.ModelSpace(db, tr, OpenMode.ForWrite);
                var dr = new Drawer(db, tr, space, p.Obj("layer_styles"));
                dr.ApplyProps(img, new P(new Dictionary<string, object> { { "layer", p.Str("layer") ?? "X-IMAGE" } }));
                space.AppendEntity(img);
                tr.AddNewlyCreatedDBObject(img, true);
                img.AssociateRasterDef(def);
                if (p.Bool("send_to_back", true))
                {
                    var dot = (DrawOrderTable)tr.GetObject(space.DrawOrderTableId, OpenMode.ForWrite);
                    dot.MoveToBottom(new ObjectIdCollection(new[] { img.ObjectId }));
                }
                var r = ImageFrame(tr, img);
                if (dr.CreatedLayers.Count > 0) r["created_layers"] = dr.CreatedLayers;
                tr.Commit();
                return r;
            }
        }

        public static object ImageInfo(Ctx ctx, P p)
        {
            using (Transaction tr = ctx.Db.TransactionManager.StartOpenCloseTransaction())
            {
                if (p.Has("handle"))
                {
                    var img = tr.GetObject(U.Id(ctx.Db, p.Str("handle")), OpenMode.ForRead) as RasterImage;
                    if (img == null) throw new McpError(p.Str("handle") + " is not an attached image");
                    return ImageFrame(tr, img);
                }
                var list = new List<object>();
                foreach (ObjectId id in Commands.SpaceIds(ctx.Db, tr, "all"))
                    if (id.ObjectClass.DxfName == "IMAGE") list.Add(ImageFrame(tr, (RasterImage)tr.GetObject(id, OpenMode.ForRead)));
                return new Dictionary<string, object> { { "images", list } };
            }
        }

        // ---------------------------------------------------------------- import a DWG/DXF (e.g. a 2D export from SketchUp/Revit)

        public static object ImportDrawing(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            string file = Path.GetFullPath(p.ReqStr("path"));
            if (!File.Exists(file)) throw new McpError("File not found: " + file);
            string prefix = p.Str("layer_prefix") ?? "";
            string name = p.Str("block_name") ?? ("IMPORT-" + Path.GetFileNameWithoutExtension(file));
            using (var src = new Database(false, true))
            {
                if (file.EndsWith(".dxf", StringComparison.OrdinalIgnoreCase)) src.DxfIn(file, null);
                else src.ReadDwgFile(file, FileOpenMode.OpenForReadAndAllShare, true, "");
                src.CloseInput(true);
                if (prefix != "")
                {
                    using (Transaction st = src.TransactionManager.StartTransaction())
                    {
                        var lt = (LayerTable)st.GetObject(src.LayerTableId, OpenMode.ForRead);
                        foreach (ObjectId lid in lt)
                        {
                            var l = (LayerTableRecord)st.GetObject(lid, OpenMode.ForWrite);
                            if (l.Name == "0" || l.Name.Equals("Defpoints", StringComparison.OrdinalIgnoreCase) || l.IsDependent) continue;
                            l.Name = prefix + l.Name;
                        }
                        st.Commit();
                    }
                }
                using (Transaction tr = db.TransactionManager.StartTransaction())
                {
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    string unique = name;
                    for (int i = 2; bt.Has(unique); i++) unique = name + "-" + i;
                    ObjectId btrId = db.Insert(unique, src, true);
                    var dr = new Drawer(db, tr, U.ModelSpace(db, tr, OpenMode.ForWrite), null);
                    var spec = new Dictionary<string, object> { { "scale", p.Num("scale", 1) }, { "rotation", p.Num("rotation", 0) } };
                    if (p.Has("layer")) spec["layer"] = p.Str("layer");
                    BlockReference br = dr.InsertRef(btrId, p.Has("at") ? U.Pt(p, "at") : Point3d.Origin, new P(spec));
                    var r = new Dictionary<string, object> { { "block", unique } };
                    if (p.Bool("explode", false))
                    {
                        var parts = new DBObjectCollection();
                        br.Explode(parts);
                        var space = U.ModelSpace(db, tr, OpenMode.ForWrite);
                        Extents3d? box = null;
                        int n = 0;
                        foreach (DBObject o in parts)
                        {
                            var e = o as Entity;
                            if (e == null) { o.Dispose(); continue; }
                            space.AppendEntity(e);
                            tr.AddNewlyCreatedDBObject(e, true);
                            U.Grow(ref box, U.Ext(e));
                            n++;
                        }
                        br.Erase();
                        tr.GetObject(btrId, OpenMode.ForWrite).Erase();
                        r["exploded"] = n;
                        r["bounds"] = U.BoundsOut(box);
                    }
                    else
                    {
                        r["handle"] = br.Handle.ToString();
                        r["bounds"] = U.BoundsOut(U.Ext(br));
                    }
                    tr.Commit();
                    r["units_note"] = "Source INSUNITS=" + src.Insunits + ", this drawing " + db.Insunits + ": check the size (scale) of the result.";
                    return r;
                }
            }
        }

        // ---------------------------------------------------------------- files

        static DwgVersion Version(string v)
        {
            switch (v ?? "")
            {
                case "": case "current": case "2018": return DwgVersion.Current;
                case "2013": return DwgVersion.AC1027;
                case "2010": return DwgVersion.AC1024;
                case "2007": return DwgVersion.AC1021;
                case "2004": return DwgVersion.AC1800;
                case "2000": return DwgVersion.AC1015;
                default: throw new McpError("version must be 2018, 2013, 2010, 2007, 2004 or 2000");
            }
        }

        public static object Save(Ctx ctx, P p)
        {
            Document doc = ctx.Doc;
            Database db = ctx.Db;
            string path = p.Str("path");
            bool named = File.Exists(doc.Name);
            if (string.IsNullOrEmpty(path))
            {
                if (!named) throw new McpError("This drawing has never been saved: give a path (e.g. D:/Project/plan.dwg).");
                path = doc.Name;
            }
            path = Path.GetFullPath(path);
            string fmt = (p.Str("format") ?? (path.EndsWith(".dxf", StringComparison.OrdinalIgnoreCase) ? "dxf" : "dwg")).ToLowerInvariant();
            bool inPlace = path.Equals(doc.Name, StringComparison.OrdinalIgnoreCase);
            if (File.Exists(path) && !p.Bool("overwrite", inPlace))
                throw new McpError("File exists: " + path + " (pass overwrite=true to replace it)");
            // writing over a drawing that another open document holds waits for AutoCAD forever: refuse it at once
            foreach (Document other in AcApp.DocumentManager)
            {
                if (other != doc && other.Name.Equals(path, StringComparison.OrdinalIgnoreCase))
                    throw new McpError("'" + path + "' is open in AutoCAD as another drawing: close it there (or save to another file) first.");
            }
            DwgVersion version = Version(p.Str("version"));
            // A copy (export) leaves the open drawing as it is; otherwise this is Save / Save As (the drawing takes the new name).
            // An older version or DXF is an export copy unless copy=false.
            bool copy = !inPlace && p.Bool("copy", fmt == "dxf" || version != DwgVersion.Current);
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            using (doc.LockDocument())
            {
                if (fmt == "dxf") db.DxfOut(path, 16, version);
                else if (copy)
                {
                    using (Database c = db.Wblock()) c.SaveAs(path, version);
                }
                else db.SaveAs(path, true, version, db.SecurityParameters);
            }
            return new Dictionary<string, object>
            {
                { "saved", path }, { "format", fmt }, { "copy", copy || fmt == "dxf" }, { "bytes", new FileInfo(path).Length },
                { "current_drawing", doc.Name },
            };
        }

        public static object Open(Ctx ctx, P p)
        {
            string path = Path.GetFullPath(p.ReqStr("path"));
            DocumentCollection docs = AcApp.DocumentManager;
            foreach (Document d in docs)
            {
                if (d.Name.Equals(path, StringComparison.OrdinalIgnoreCase))
                {
                    docs.MdiActiveDocument = d;
                    return new Dictionary<string, object> { { "opened", path }, { "already_open", true } };
                }
            }
            if (!File.Exists(path)) throw new McpError("File not found: " + path);
            Document doc = docs.Open(path, p.Bool("read_only", false));
            docs.MdiActiveDocument = doc;
            return new Dictionary<string, object> { { "opened", doc.Name }, { "read_only", doc.IsReadOnly } };
        }

        public static object New(Ctx ctx, P p)
        {
            DocumentCollection docs = AcApp.DocumentManager;
            string template = p.Str("template") ?? "acadiso.dwt";
            Document doc;
            try { doc = docs.Add(template); }
            catch (Exception e) { throw new McpError("Cannot create a drawing from template '" + template + "': " + e.Message); }
            docs.MdiActiveDocument = doc;
            return new Dictionary<string, object> { { "drawing", doc.Name }, { "template", template } };
        }
    }
}
