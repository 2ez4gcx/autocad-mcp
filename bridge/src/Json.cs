// Minimal JSON reader/writer (no dependencies, so the same source builds for .NET Framework 4.8 and .NET 8).
// Objects -> Dictionary<string, object>, arrays -> List<object>, numbers -> double, plus string/bool/null.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace AcadMcp
{
    public static class Json
    {
        public static object Parse(string s)
        {
            int i = 0;
            object v = ReadValue(s, ref i);
            SkipWs(s, ref i);
            if (i != s.Length) throw new FormatException("Unexpected text after JSON value at " + i);
            return v;
        }

        static void SkipWs(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        static object ReadValue(string s, ref int i)
        {
            SkipWs(s, ref i);
            if (i >= s.Length) throw new FormatException("Unexpected end of JSON");
            char c = s[i];
            if (c == '{')
            {
                var d = new Dictionary<string, object>();
                i++;
                SkipWs(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return d; }
                while (true)
                {
                    SkipWs(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new FormatException("Expected a property name at " + i);
                    string k = ReadString(s, ref i);
                    SkipWs(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new FormatException("Expected ':' at " + i);
                    i++;
                    d[k] = ReadValue(s, ref i);
                    SkipWs(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return d; }
                    throw new FormatException("Expected ',' or '}' at " + i);
                }
            }
            if (c == '[')
            {
                var l = new List<object>();
                i++;
                SkipWs(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return l; }
                while (true)
                {
                    l.Add(ReadValue(s, ref i));
                    SkipWs(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return l; }
                    throw new FormatException("Expected ',' or ']' at " + i);
                }
            }
            if (c == '"') return ReadString(s, ref i);
            if (Match(s, ref i, "true")) return true;
            if (Match(s, ref i, "false")) return false;
            if (Match(s, ref i, "null")) return null;
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            if (start == i) throw new FormatException("Unexpected character '" + c + "' at " + i);
            return double.Parse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture);
        }

        static bool Match(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) return false;
            i += word.Length;
            return true;
        }

        static string ReadString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        sb.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber));
                        i += 4;
                        break;
                    default: sb.Append(e); break;
                }
            }
            throw new FormatException("Unterminated string");
        }

        public static string Write(object v)
        {
            var sb = new StringBuilder();
            WriteValue(sb, v);
            return sb.ToString();
        }

        static void WriteValue(StringBuilder sb, object v)
        {
            switch (v)
            {
                case null: sb.Append("null"); return;
                case string s: WriteString(sb, s); return;
                case bool b: sb.Append(b ? "true" : "false"); return;
                case double d: WriteNumber(sb, d); return;
                case float f: WriteNumber(sb, f); return;
                case int n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case long n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case short n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case byte n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case uint n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case ulong n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case decimal n: sb.Append(n.ToString(CultureInfo.InvariantCulture)); return;
                case Enum e: WriteString(sb, e.ToString()); return;
                case IDictionary dict:
                    {
                        sb.Append('{');
                        bool first = true;
                        foreach (DictionaryEntry kv in dict)
                        {
                            if (!first) sb.Append(',');
                            first = false;
                            WriteString(sb, Convert.ToString(kv.Key, CultureInfo.InvariantCulture));
                            sb.Append(':');
                            WriteValue(sb, kv.Value);
                        }
                        sb.Append('}');
                        return;
                    }
                case IEnumerable list:
                    {
                        sb.Append('[');
                        bool first = true;
                        foreach (object o in list)
                        {
                            if (!first) sb.Append(',');
                            first = false;
                            WriteValue(sb, o);
                        }
                        sb.Append(']');
                        return;
                    }
                default: WriteString(sb, v.ToString()); return;
            }
        }

        static void WriteNumber(StringBuilder sb, double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
            if (d == Math.Floor(d) && Math.Abs(d) < 1e15) sb.Append(((long)d).ToString(CultureInfo.InvariantCulture));
            else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }

    /// <summary>An error whose message is meant for Claude (bad parameter, missing object...).</summary>
    public class McpError : Exception
    {
        public McpError(string message) : base(message) { }
    }

    /// <summary>Typed access to the "params" object of a request, with clear error messages.</summary>
    public class P
    {
        public readonly Dictionary<string, object> D;
        public readonly string Path;

        public P(object o, string path = "")
        {
            D = o as Dictionary<string, object> ?? new Dictionary<string, object>();
            Path = path;
        }

        string Name(string key) { return Path == "" ? key : Path + "." + key; }

        public bool Has(string key) { object v; return D.TryGetValue(key, out v) && v != null; }

        public object Raw(string key) { object v; return D.TryGetValue(key, out v) ? v : null; }

        public string Str(string key, string def = null)
        {
            object v = Raw(key);
            if (v == null) return def;
            if (v is string s) return s;
            if (v is double d) return d.ToString(CultureInfo.InvariantCulture);
            if (v is bool b) return b ? "true" : "false";
            throw new McpError(Name(key) + " must be a string");
        }

        public string ReqStr(string key)
        {
            string s = Str(key);
            if (string.IsNullOrEmpty(s)) throw new McpError(Name(key) + " is required");
            return s;
        }

        public double Num(string key, double def)
        {
            object v = Raw(key);
            if (v == null) return def;
            return ToNum(v, Name(key));
        }

        public double? OptNum(string key)
        {
            object v = Raw(key);
            if (v == null) return null;
            return ToNum(v, Name(key));
        }

        public double ReqNum(string key)
        {
            object v = Raw(key);
            if (v == null) throw new McpError(Name(key) + " is required");
            return ToNum(v, Name(key));
        }

        public int Int(string key, int def) { return (int)Math.Round(Num(key, def)); }

        public bool Bool(string key, bool def)
        {
            object v = Raw(key);
            if (v == null) return def;
            if (v is bool b) return b;
            if (v is string s) return s == "true" || s == "1";
            if (v is double d) return d != 0;
            throw new McpError(Name(key) + " must be true or false");
        }

        public List<object> List(string key)
        {
            object v = Raw(key);
            if (v == null) return null;
            if (v is List<object> l) return l;
            if (v is string s && s.TrimStart().StartsWith("["))
            {
                try { return (List<object>)Json.Parse(s); } catch (Exception) { }
            }
            throw new McpError(Name(key) + " must be an array");
        }

        public P Obj(string key)
        {
            object v = Raw(key);
            if (v == null) return null;
            if (v is Dictionary<string, object>) return new P(v, Name(key));
            throw new McpError(Name(key) + " must be an object");
        }

        public List<string> Strings(string key)
        {
            var l = List(key);
            if (l == null) return null;
            var r = new List<string>();
            foreach (object o in l) r.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
            return r;
        }

        public static double ToNum(object v, string name)
        {
            if (v is double d)
            {
                if (double.IsNaN(d) || double.IsInfinity(d)) throw new McpError(name + " must be a finite number");
                return d;
            }
            if (v is string s && double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out double r)) return r;
            if (v is bool b) return b ? 1 : 0;
            throw new McpError(name + " must be a number");
        }
    }
}
