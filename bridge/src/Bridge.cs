// ACAD MCP Bridge: runs inside AutoCAD, listens on 127.0.0.1 (default port 9877) and executes one JSON command per
// connection on AutoCAD's main thread. Protocol (same as SketchUp MCP):
//   request  {"id": 1, "cmd": "draw_entities", "params": {...}}\n
//   response {"id": 1, "ok": true, "result": ...}\n   or   {"id": 1, "ok": false, "error": "..."}\n
// Every drawing edit runs inside one document lock named "MCP_<COMMAND>", so it is one step in AutoCAD's Undo.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using AcApp = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using Exception = System.Exception;

[assembly: ExtensionApplication(typeof(AcadMcp.BridgeApp))]
[assembly: CommandClass(typeof(AcadMcp.UserCommands))]

namespace AcadMcp
{
    public class BridgeApp : IExtensionApplication
    {
        public void Initialize()
        {
            try
            {
                Bridge.Init();
                if (Settings.AutoStart) Bridge.Start();
            }
            catch (Exception e)
            {
                Bridge.Log("Initialize failed: " + e);
            }
        }

        public void Terminate()
        {
            try { Bridge.Stop(); } catch (Exception) { }
        }
    }

    /// <summary>Port and autostart, kept in %APPDATA%\AcadMcp\settings.json.</summary>
    public static class Settings
    {
        public const int DefaultPort = 9877;
        public static int Port = DefaultPort;
        public static bool AutoStart = true;

        public static string Dir
        {
            get { return System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AcadMcp"); }
        }

        static string FilePath { get { return System.IO.Path.Combine(Dir, "settings.json"); } }

        public static void Load()
        {
            try
            {
                if (!File.Exists(FilePath)) return;
                var p = new P(Json.Parse(File.ReadAllText(FilePath, Encoding.UTF8)));
                int port = p.Int("port", DefaultPort);
                if (port > 0 && port < 65536) Port = port;
                AutoStart = p.Bool("autostart", true);
            }
            catch (Exception e)
            {
                Bridge.Log("Cannot read settings: " + e.Message);
            }
        }

        public static void Save()
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, Json.Write(new Dictionary<string, object> { { "port", Port }, { "autostart", AutoStart } }), Encoding.UTF8);
        }
    }

    public static class Bridge
    {
        public static readonly string VERSION = "1.2.1";
        const int MaxRequestBytes = 64 * 1024 * 1024;

        static Control _ui;
        static TcpListener _listener;
        static Thread _thread;
        static volatile bool _running;
        static readonly object _logLock = new object();

        public static bool Running { get { return _running; } }

        public static string LogPath { get { return System.IO.Path.Combine(Settings.Dir, "bridge.log"); } }

        public static void Log(string msg)
        {
            try
            {
                lock (_logLock)
                {
                    Directory.CreateDirectory(Settings.Dir);
                    var fi = new FileInfo(LogPath);
                    if (fi.Exists && fi.Length > 2 * 1024 * 1024) File.Delete(LogPath);
                    File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + msg + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch (Exception) { }
        }

        /// <summary>Called on AutoCAD's main thread: creates the window used to marshal commands to that thread.</summary>
        public static void Init()
        {
            Settings.Load();
            if (_ui == null)
            {
                // A closed drawing drops its screenshot graphics model.
                AcApp.DocumentManager.DocumentToBeDestroyed += (s, e) => Media.ForgetModel(e.Document != null ? e.Document.Database : null);
                _ui = new Control();
                _ui.CreateControl();
                IntPtr unused = _ui.Handle; // force the handle on the main thread
            }
        }

        public static void Start()
        {
            if (_running) return;
            _listener = new TcpListener(IPAddress.Loopback, Settings.Port);
            _listener.Start(8);
            _running = true;
            _thread = new Thread(AcceptLoop) { IsBackground = true, Name = "AcadMcpBridge" };
            _thread.Start();
            Log("Started v" + VERSION + " on 127.0.0.1:" + Settings.Port);
        }

        public static void Stop()
        {
            if (!_running) return;
            _running = false;
            try { _listener.Stop(); } catch (Exception) { }
            Log("Stopped");
        }

        public static string Status()
        {
            return "ACAD MCP Bridge v" + VERSION + ": " + (_running ? "RUNNING on 127.0.0.1:" + Settings.Port : "STOPPED (port " + Settings.Port + ")");
        }

        static void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client;
                try { client = _listener.AcceptTcpClient(); }
                catch (Exception)
                {
                    if (!_running) return;
                    Thread.Sleep(200);
                    continue;
                }
                try { Serve(client); }
                catch (Exception e) { Log("Connection error: " + e.Message); }
                finally { try { client.Close(); } catch (Exception) { } }
            }
        }

        static void Serve(TcpClient client)
        {
            client.NoDelay = true;
            NetworkStream stream = client.GetStream();
            stream.ReadTimeout = 60000;
            var buf = new MemoryStream();
            var chunk = new byte[65536];
            while (true)
            {
                int n = stream.Read(chunk, 0, chunk.Length);
                if (n <= 0) break;
                int nl = Array.IndexOf(chunk, (byte)'\n', 0, n);
                buf.Write(chunk, 0, nl < 0 ? n : nl);
                if (nl >= 0) break;
                if (buf.Length > MaxRequestBytes) throw new IOException("Request too large");
            }
            if (buf.Length == 0) return;
            string line = Encoding.UTF8.GetString(buf.ToArray());
            string reply = Process(line) + "\n";
            byte[] bytes = Encoding.UTF8.GetBytes(reply);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush();
        }

        static string Process(string line)
        {
            object id = null;
            string cmd = "?";
            var sw = Stopwatch.StartNew();
            try
            {
                var req = Json.Parse(line) as Dictionary<string, object>;
                if (req == null) throw new McpError("Request must be a JSON object");
                req.TryGetValue("id", out id);
                object c;
                req.TryGetValue("cmd", out c);
                cmd = c as string;
                if (string.IsNullOrEmpty(cmd)) throw new McpError("Missing 'cmd'");
                object prm;
                req.TryGetValue("params", out prm);
                object result = Dispatch(cmd, new P(prm));
                Log(cmd + " ok " + sw.ElapsedMilliseconds + " ms");
                return Json.Write(new Dictionary<string, object> { { "id", id }, { "ok", true }, { "result", result } });
            }
            catch (Exception e)
            {
                Exception inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
                string msg = ErrorText(inner);
                Log(cmd + " FAILED " + sw.ElapsedMilliseconds + " ms: " + msg + (inner is McpError ? "" : "\n" + inner));
                return Json.Write(new Dictionary<string, object> { { "id", id }, { "ok", false }, { "error", msg } });
            }
        }

        public static string ErrorText(Exception e)
        {
            if (e is McpError) return e.Message;
            if (e is Autodesk.AutoCAD.Runtime.Exception ae) return "AutoCAD error " + ae.ErrorStatus + (string.IsNullOrEmpty(ae.Message) || ae.Message == ae.ErrorStatus.ToString() ? "" : ": " + ae.Message);
            return e.GetType().Name + ": " + e.Message;
        }

        // ------------------------------------------------------------------ main-thread execution

        /// <summary>A command waiting to run on AutoCAD's main thread.</summary>
        class Job
        {
            public Command Def;
            public P Params;
            public object Result;
            public Exception Error;
            public bool Busy;
            public string BusyCommand;
            public readonly ManualResetEvent Done = new ManualResetEvent(false);

            public void RunOnMain()
            {
                bool deferred = false;
                try
                {
                    Document doc = AcApp.DocumentManager.MdiActiveDocument;
                    if (Def.Mode != Mode.Session && doc == null)
                        throw new McpError("No drawing is open in AutoCAD: call new_drawing or open_drawing first.");
                    if (doc != null && Def.Mode != Mode.Session && !doc.Editor.IsQuiescent)
                    {
                        Busy = true;
                        BusyCommand = doc.CommandInProgress;
                        return;
                    }
                    var ctx = new Ctx(doc, Def.Name);
                    switch (Def.Mode)
                    {
                        case Mode.Session:
                        case Mode.App:
                            Result = Def.Fn(ctx, Params);
                            break;
                        case Mode.Read:
                            using (doc.LockDocument(DocumentLockMode.Read, null, null, false))
                                Result = Def.Fn(ctx, Params);
                            break;
                        case Mode.Write:
                            string undoName = "MCP_" + Def.Name.ToUpperInvariant();
                            using (doc.LockDocument(DocumentLockMode.Write, undoName, undoName, false))
                                Result = Def.Fn(ctx, Params);
                            break;
                        case Mode.CommandContext:
                            deferred = true;
                            AcApp.DocumentManager.ExecuteInCommandContextAsync(obj =>
                            {
                                try { Result = Def.Fn(new Ctx(AcApp.DocumentManager.MdiActiveDocument, Def.Name), Params); }
                                catch (Exception e) { Error = e; }
                                finally { Done.Set(); }
                                return Task.FromResult(0);
                            }, null);
                            break;
                        case Mode.Lisp:
                            deferred = true;
                            Lisp.Start(ctx, Params, Finish);
                            break;
                    }
                }
                catch (Exception e)
                {
                    Error = e;
                    deferred = false;
                }
                finally
                {
                    if (!deferred) Done.Set();
                }
            }

            public void Finish(object result, Exception error)
            {
                Result = result;
                Error = error;
                Done.Set();
            }
        }

        static object Dispatch(string name, P p)
        {
            Command def;
            if (!Commands.Table.TryGetValue(name, out def)) throw new McpError("Unsupported command: " + name);
            // AutoCAD busy in a command (or a dialog): retry for a few seconds before giving up.
            DateTime deadline = DateTime.UtcNow.AddSeconds(p.Num("_busy_wait", 8));
            while (true)
            {
                Command run = def.ModeFor == null ? def : new Command { Name = def.Name, Fn = def.Fn, Mode = def.ModeFor(p) };
                var job = new Job { Def = run, Params = p };
                if (_ui == null || !_ui.IsHandleCreated) throw new McpError("Bridge is not initialised (no main-thread window).");
                _ui.BeginInvoke(new Action(job.RunOnMain));
                // The MCP server gives up after its own timeout; never block the bridge forever (e.g. LISP waiting for input).
                if (!job.Done.WaitOne(TimeSpan.FromSeconds(Math.Max(5, p.Num("_timeout", 600)))))
                    throw new McpError("AutoCAD did not finish '" + name + "' in time. It may still be running or waiting for input " +
                        "in AutoCAD (press Esc there).");
                if (job.Busy)
                {
                    if (DateTime.UtcNow < deadline) { Thread.Sleep(300); continue; }
                    throw new McpError("AutoCAD is busy: command '" + job.BusyCommand + "' is active (or a dialog is open). " +
                        "Ask the user to finish it or press Esc in AutoCAD, then retry.");
                }
                if (job.Error != null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(job.Error).Throw();
                return job.Result;
            }
        }
    }

    public enum Mode
    {
        Session,        // runs without a drawing (ping, view_image)
        App,            // application context, no lock (open/new drawing)
        Read,           // read lock
        Write,          // write lock = one Undo step
        CommandContext, // ExecuteInCommandContextAsync (editor commands: undo, zoom, plot...)
        Lisp,           // SendStringToExecute + callback
    }

    public delegate object CommandFn(Ctx ctx, P p);

    public class Command
    {
        public string Name;
        public Mode Mode;
        public CommandFn Fn;
        public Func<P, Mode> ModeFor; // optional: mode chosen from the parameters
    }

    /// <summary>What a command needs: the document, its database and editor.</summary>
    public class Ctx
    {
        public readonly Document Doc;
        public readonly Database Db;
        public readonly Editor Ed;
        public readonly string Name;

        public Ctx(Document doc, string name)
        {
            Doc = doc;
            Db = doc != null ? doc.Database : null;
            Ed = doc != null ? doc.Editor : null;
            Name = name;
        }
    }

    // ------------------------------------------------------------------ commands typed by the user in AutoCAD
    public class UserCommands
    {
        static void Say(string msg)
        {
            Document doc = AcApp.DocumentManager.MdiActiveDocument;
            if (doc != null) doc.Editor.WriteMessage("\n" + msg + "\n");
        }

        [CommandMethod("MCPSTATUS", CommandFlags.Modal)]
        public void McpStatus() { Say(Bridge.Status() + "  Log: " + Bridge.LogPath); }

        [CommandMethod("MCPSTART", CommandFlags.Modal)]
        public void McpStart()
        {
            try { Bridge.Init(); Bridge.Start(); }
            catch (Exception e) { Say("Cannot start: " + e.Message + " (another program may use port " + Settings.Port + "; change it with MCPPORT)"); }
            Say(Bridge.Status());
        }

        [CommandMethod("MCPSTOP", CommandFlags.Modal)]
        public void McpStop() { Bridge.Stop(); Say(Bridge.Status()); }

        [CommandMethod("MCPPORT", CommandFlags.Modal)]
        public void McpPort()
        {
            Document doc = AcApp.DocumentManager.MdiActiveDocument;
            if (doc == null) return;
            var opt = new PromptIntegerOptions("\nBridge port (1024-65535) <" + Settings.Port + ">: ")
            {
                AllowNone = true, LowerLimit = 1024, UpperLimit = 65535, DefaultValue = Settings.Port, UseDefaultValue = true,
            };
            PromptIntegerResult r = doc.Editor.GetInteger(opt);
            if (r.Status != PromptStatus.OK) return;
            Settings.Port = r.Value;
            Settings.Save();
            bool was = Bridge.Running;
            Bridge.Stop();
            if (was)
            {
                try { Bridge.Start(); } catch (Exception e) { Say("Cannot start: " + e.Message); }
            }
            Say(Bridge.Status() + "  Set the same port in Claude (Settings > Extensions > Construction AutoCAD MCP > Configure).");
        }

        [CommandMethod("MCPLOG", CommandFlags.Modal)]
        public void McpLog()
        {
            try { Process.Start("notepad.exe", "\"" + Bridge.LogPath + "\""); } catch (Exception e) { Say(e.Message); }
        }

        /// <summary>(mcp-return "id" "OK"|"ERR" value): how run_lisp gets its result back.</summary>
        [LispFunction("mcp-return")]
        public object McpReturn(ResultBuffer args)
        {
            Lisp.Return(args);
            return null;
        }
    }
}
