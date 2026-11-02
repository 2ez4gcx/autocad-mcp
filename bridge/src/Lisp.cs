// run_lisp: the code (comments removed) is handed to AutoLISP in the variable mcp:code with Document.SetLispSymbol - no
// file is written, so AutoCAD's SECURELOAD never asks about it - then read and evaluated from the command line inside an
// UNDO group; (mcp-return id status value) hands the result (or the error message) back to the bridge.
using System;
using System.Collections.Generic;
using System.Text;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using Exception = System.Exception;

namespace AcadMcp
{
    public static class Lisp
    {
        static readonly Dictionary<string, Action<object, Exception>> _pending = new Dictionary<string, Action<object, Exception>>();

        /// <summary>Removes ; and ;| |; comments outside strings (read does not skip them) and checks the parentheses.</summary>
        public static string Clean(string code)
        {
            var sb = new StringBuilder();
            int depth = 0;
            for (int i = 0; i < code.Length; i++)
            {
                char c = code[i];
                if (c == '"')
                {
                    int j = i + 1;
                    while (j < code.Length && code[j] != '"') j += code[j] == '\\' ? 2 : 1;
                    if (j >= code.Length) throw new McpError("Unterminated string in the LISP code");
                    sb.Append(code, i, j - i + 1);
                    i = j;
                    continue;
                }
                if (c == ';')
                {
                    if (i + 1 < code.Length && code[i + 1] == '|')
                    {
                        int end = code.IndexOf("|;", i + 2, StringComparison.Ordinal);
                        i = end < 0 ? code.Length : end + 1;
                    }
                    else
                    {
                        while (i < code.Length && code[i] != '\n') i++;
                    }
                    sb.Append(' ');
                    continue;
                }
                if (c == '(') depth++;
                if (c == ')' && --depth < 0) throw new McpError("Unbalanced parentheses in the LISP code (too many ')')");
                sb.Append(c);
            }
            if (depth != 0) throw new McpError("Unbalanced parentheses in the LISP code (" + depth + " '(' not closed)");
            return sb.ToString();
        }

        public static void Start(Ctx ctx, P p, Action<object, Exception> finish)
        {
            string code = Clean(p.ReqStr("code"));
            bool undoGroup = p.Bool("undo_group", true);
            string id = Guid.NewGuid().ToString("N").Substring(0, 12);
            ctx.Doc.SetLispSymbol("mcp:code", "(progn " + code + "\n)");
            lock (_pending) _pending[id] = finish;

            var sb = new StringBuilder();
            sb.Append("(progn (setq mcp:echo (getvar \"CMDECHO\")) (setvar \"CMDECHO\" 0)");
            if (undoGroup) sb.Append(" (command \"_.UNDO\" \"_BE\")");
            sb.Append(" (setq mcp:r (vl-catch-all-apply (function (lambda () (eval (read mcp:code))))))");
            if (undoGroup) sb.Append(" (command \"_.UNDO\" \"_E\")");
            sb.Append(" (setvar \"CMDECHO\" mcp:echo)");
            sb.Append(" (if (vl-catch-all-error-p mcp:r) (mcp-return \"").Append(id).Append("\" \"ERR\" (vl-catch-all-error-message mcp:r))");
            sb.Append(" (mcp-return \"").Append(id).Append("\" \"OK\" mcp:r))");
            sb.Append(" (setq mcp:r nil mcp:code nil) (princ))\n");
            ctx.Doc.SendStringToExecute(sb.ToString(), true, false, false);
        }

        public static void Return(ResultBuffer args)
        {
            if (args == null) return;
            TypedValue[] v = args.AsArray();
            if (v.Length < 2) return;
            string id = v[0].Value as string;
            string status = v[1].Value as string;
            Action<object, Exception> finish;
            lock (_pending)
            {
                if (id == null || !_pending.TryGetValue(id, out finish)) return;
                _pending.Remove(id);
            }
            int i = 2;
            object value = null;
            try { value = v.Length > 2 ? Read(v, ref i) : null; }
            catch (Exception e) { value = "(result could not be converted: " + e.Message + ")"; }
            if (status == "ERR") finish(null, new McpError("LISP error: " + value));
            else finish(new Dictionary<string, object> { { "value", value } }, null);
        }

        static object Read(TypedValue[] v, ref int i)
        {
            TypedValue t = v[i++];
            switch ((LispDataType)t.TypeCode)
            {
                case LispDataType.ListBegin:
                    {
                        var l = new List<object>();
                        while (i < v.Length && v[i].TypeCode != (short)LispDataType.ListEnd && v[i].TypeCode != (short)LispDataType.DottedPair)
                            l.Add(Read(v, ref i));
                        i++; // ListEnd or DottedPair (a dotted pair (a . b) comes back as [a, b])
                        return l;
                    }
                case LispDataType.Nil: return null;
                case LispDataType.T_atom: return true;
                case LispDataType.Text: return t.Value as string;
                case LispDataType.Int16:
                case LispDataType.Int32:
                case LispDataType.Double:
                case LispDataType.Angle:
                case LispDataType.Orientation:
                    return Convert.ToDouble(t.Value);
                case LispDataType.Point2d:
                    {
                        var p = (Autodesk.AutoCAD.Geometry.Point2d)t.Value;
                        return new List<object> { p.X, p.Y };
                    }
                case LispDataType.Point3d:
                    {
                        var p = (Autodesk.AutoCAD.Geometry.Point3d)t.Value;
                        return new List<object> { p.X, p.Y, p.Z };
                    }
                case LispDataType.ObjectId:
                    return "<entity " + ((ObjectId)t.Value).Handle + ">";
                case LispDataType.SelectionSet:
                    return "<selection set>";
                default:
                    return t.Value == null ? null : t.Value.ToString();
            }
        }
    }
}
