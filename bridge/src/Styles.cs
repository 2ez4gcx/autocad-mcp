// setup_styles: drawing units, a TrueType text style (shows Vietnamese), a dimension style and a multileader style for a
// plot scale, the table style text, and LTSCALE.
using System;
using System.Collections.Generic;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.GraphicsInterface;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Styles
    {
        static ObjectId ArrowBlock(Database db, Transaction tr, string arrow)
        {
            string blk;
            switch ((arrow ?? "tick").ToLowerInvariant())
            {
                case "tick": case "archtick": case "arch": blk = "_ArchTick"; break;
                case "oblique": blk = "_Oblique"; break;
                case "dot": blk = "_Dot"; break;
                case "small_dot": blk = "_DotSmall"; break;
                case "open": blk = "_Open"; break;
                case "closed": case "closed_filled": return ObjectId.Null;
                default: throw new McpError("arrow must be tick, oblique, dot, small_dot, open or closed");
            }
            var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            if (!bt.Has(blk))
            {
                // Setting DIMBLK makes AutoCAD create the arrowhead block definition.
                object old = AcApp.GetSystemVariable("DIMBLK");
                AcApp.SetSystemVariable("DIMBLK", blk);
                AcApp.SetSystemVariable("DIMBLK", string.IsNullOrEmpty(Convert.ToString(old)) ? "." : old);
                bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
            }
            return bt.Has(blk) ? bt[blk] : ObjectId.Null;
        }

        public static object Setup(Ctx ctx, P p)
        {
            Database db = ctx.Db;
            var res = new Dictionary<string, object>();
            using (Transaction tr = db.TransactionManager.StartTransaction())
            {
                string units = p.Str("units");
                if (units != null)
                {
                    switch (units.ToLowerInvariant())
                    {
                        case "mm": db.Insunits = UnitsValue.Millimeters; db.Measurement = MeasurementValue.Metric; break;
                        case "cm": db.Insunits = UnitsValue.Centimeters; db.Measurement = MeasurementValue.Metric; break;
                        case "m": db.Insunits = UnitsValue.Meters; db.Measurement = MeasurementValue.Metric; break;
                        default: throw new McpError("units must be mm, cm or m");
                    }
                    res["units"] = units;
                }

                ObjectId textStyle = db.Textstyle;
                P ts = p.Obj("text_style");
                if (ts != null)
                {
                    string name = ts.Str("name") ?? "MCP-ARIAL";
                    string font = ts.Str("font") ?? "Arial";
                    var tst = (TextStyleTable)tr.GetObject(db.TextStyleTableId, OpenMode.ForRead);
                    TextStyleTableRecord rec;
                    bool isNew = !tst.Has(name);
                    if (isNew)
                    {
                        rec = new TextStyleTableRecord { Name = name };
                        tst.UpgradeOpen();
                        tst.Add(rec);
                        tr.AddNewlyCreatedDBObject(rec, true);
                    }
                    else rec = (TextStyleTableRecord)tr.GetObject(tst[name], OpenMode.ForWrite);
                    if (font.EndsWith(".shx", StringComparison.OrdinalIgnoreCase))
                    {
                        rec.FileName = font;
                        rec.BigFontFileName = ts.Str("bigfont") ?? "";
                    }
                    else
                    {
                        rec.FileName = "";
                        rec.Font = new FontDescriptor(font, ts.Bool("bold", false), ts.Bool("italic", false), 0, 0);
                    }
                    rec.XScale = ts.Num("width_factor", 1);
                    rec.TextSize = ts.Num("height", 0);
                    textStyle = rec.ObjectId;
                    if (ts.Bool("set_current", true)) db.Textstyle = textStyle;
                    res["text_style"] = new Dictionary<string, object> { { "name", name }, { "font", font }, { "status", isNew ? "created" : "updated" } };

                    // Table text in the same style (schedules with Vietnamese text).
                    try
                    {
                        var tbs = (TableStyle)tr.GetObject(db.Tablestyle, OpenMode.ForWrite);
                        tbs.SetTextStyle(textStyle, (int)(RowType.DataRow | RowType.HeaderRow | RowType.TitleRow));
                    }
                    catch (Exception) { }
                }

                P ds = p.Obj("dim_style");
                if (ds != null)
                {
                    double scale = ds.Num("scale", 100);
                    if (scale <= 0) throw new McpError("dim_style.scale must be > 0");
                    string name = ds.Str("name") ?? ("MCP-1-" + scale.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    string arrow = ds.Str("arrow") ?? "tick";
                    bool tick = arrow.StartsWith("tick") || arrow.StartsWith("arch") || arrow == "oblique";
                    var dst = (DimStyleTable)tr.GetObject(db.DimStyleTableId, OpenMode.ForRead);
                    DimStyleTableRecord rec;
                    bool isNew = !dst.Has(name);
                    if (isNew)
                    {
                        rec = new DimStyleTableRecord { Name = name };
                        dst.UpgradeOpen();
                        dst.Add(rec);
                        tr.AddNewlyCreatedDBObject(rec, true);
                    }
                    else rec = (DimStyleTableRecord)tr.GetObject(dst[name], OpenMode.ForWrite);
                    rec.Dimscale = scale;
                    rec.Dimtxt = ds.Num("text_height", 2.5);
                    rec.Dimasz = ds.Num("arrow_size", tick ? 1.2 : 2.5);
                    rec.Dimexo = ds.Num("ext_offset", 1.5);
                    rec.Dimexe = ds.Num("ext_beyond", 1.5);
                    rec.Dimdle = ds.Num("dim_line_ext", tick ? 1.5 : 0);
                    rec.Dimgap = ds.Num("text_gap", 1);
                    rec.Dimdli = ds.Num("baseline_spacing", 8);
                    rec.Dimdec = ds.Int("decimals", 0);
                    rec.Dimadec = 0;
                    rec.Dimlunit = 2; // decimal
                    rec.Dimzin = 8;   // suppress trailing zeros
                    rec.Dimtad = 1;   // text above the dimension line
                    rec.Dimtih = false;
                    rec.Dimtoh = false;
                    rec.Dimtofl = true;
                    rec.Dimtmove = 2; // text moves freely, no leader
                    rec.Dimatfit = 3;
                    rec.Dimlfac = ds.Num("length_factor", 1);
                    rec.Dimclrd = Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByLayer, 256);
                    rec.Dimclre = rec.Dimclrd;
                    rec.Dimclrt = rec.Dimclrd;
                    rec.Dimtxsty = textStyle;
                    ObjectId arrowId = ArrowBlock(db, tr, arrow);
                    rec.Dimsah = false;
                    rec.Dimblk = arrowId;
                    rec.Dimblk1 = arrowId;
                    rec.Dimblk2 = arrowId;
                    rec.Dimldrblk = ObjectId.Null;
                    if (ds.Bool("set_current", true))
                    {
                        db.Dimstyle = rec.ObjectId;
                        db.SetDimstyleData(rec);
                    }
                    res["dim_style"] = new Dictionary<string, object> { { "name", name }, { "scale", scale }, { "status", isNew ? "created" : "updated" } };

                    // Multileader style of the same name and scale.
                    var mlDict = (DBDictionary)tr.GetObject(db.MLeaderStyleDictionaryId, OpenMode.ForRead);
                    MLeaderStyle mls;
                    if (mlDict.Contains(name)) mls = (MLeaderStyle)tr.GetObject(mlDict.GetAt(name), OpenMode.ForWrite);
                    else
                    {
                        mls = new MLeaderStyle();
                        mlDict.UpgradeOpen();
                        mlDict.SetAt(name, mls);
                        tr.AddNewlyCreatedDBObject(mls, true);
                    }
                    mls.Scale = scale;
                    mls.TextHeight = rec.Dimtxt;
                    mls.ArrowSize = ds.Num("leader_arrow_size", 2.5);
                    mls.TextStyleId = textStyle;
                    mls.ContentType = ContentType.MTextContent;
                    if (ds.Bool("set_current", true)) db.MLeaderstyle = mls.ObjectId;
                }

                if (p.Has("ltscale"))
                {
                    double v = p.Num("ltscale", 1);
                    if (v <= 0) throw new McpError("ltscale must be > 0");
                    db.Ltscale = v;
                    // LTSCALE is set for the plot scale, so viewports must not scale linetypes again.
                    db.Psltscale = false;
                    res["ltscale"] = v;
                }
                if (p.Has("lineweight_display")) db.LineWeightDisplay = p.Bool("lineweight_display", true);
                tr.Commit();
            }
            return res;
        }
    }
}
