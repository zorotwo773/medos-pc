// MedOS Updater - standalone, single-file update launcher.
//
// C# 5 compatible (compiled with the .NET Framework 4.x csc.exe /langversion:5).
// It never contains user data. An update kit (update.json + payload/) is either
// appended to this EXE as a ZIP with the MDSPAY01 footer, or supplied externally
// with /kit=<folder-or-zip>. All safety checks live in apply_update.py, which is
// carried inside the kit and executed with the target install's bundled Python.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Runtime.Versioning.TargetFramework(
    ".NETFramework,Version=v4.6.2",
    FrameworkDisplayName = ".NET Framework 4.6.2")]

namespace MedOS.Updater
{
    internal sealed class UpdaterException : Exception
    {
        public UpdaterException(string message) : base(message) { }
    }

    internal sealed class Options
    {
        public bool Silent;
        public bool VerifyOnly;
        public bool IgnorePorts;
        public bool Help;
        public string Root = "";
        public string Kit = "";
        public string Log = "";

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            if (args == null) return options;
            foreach (string raw in args)
            {
                if (raw == null) continue;
                string arg = raw.Trim();
                string lower = arg.ToLowerInvariant();
                if (lower == "/silent" || lower == "-silent" || lower == "--silent") options.Silent = true;
                else if (lower == "/verify" || lower == "-verify" || lower == "--verify" || lower == "--verify-only") options.VerifyOnly = true;
                else if (lower == "/ignoreports" || lower == "-ignoreports" || lower == "--no-port-check") options.IgnorePorts = true;
                else if (lower == "/?" || lower == "/help" || lower == "--help") options.Help = true;
                else if (Starts(arg, "/root=") || Starts(arg, "--root=")) options.Root = Value(arg);
                else if (Starts(arg, "/kit=") || Starts(arg, "--kit=")) options.Kit = Value(arg);
                else if (Starts(arg, "/log=") || Starts(arg, "--log=")) options.Log = Value(arg);
            }
            return options;
        }

        private static bool Starts(string value, string prefix)
        {
            return value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static string Value(string arg)
        {
            int at = arg.IndexOf('=');
            return at < 0 ? "" : arg.Substring(at + 1).Trim();
        }

        public static string HelpText()
        {
            return "MedOS Updater\n\n" +
                "Usage: MedOS-Updater.exe [options]\n\n" +
                "  /root=<folder>    MedOS installation folder (auto-detected if omitted)\n" +
                "  /kit=<path>       Update kit folder or .zip (embedded kit if omitted)\n" +
                "  /verify           Verify the kit and target, change nothing\n" +
                "  /ignoreports      Apply even if MedOS is still running\n" +
                "  /silent           No UI; exit code 0 = success, 2 = failure\n" +
                "  /log=<file>       Write the full log to this file\n" +
                "  /help             Show this help\n\n" +
                "Your data, models, exports, .env files and uploads are never touched.";
        }
    }

    // Appended payload: magic, offset, length, sha256, schema (60 bytes).
    internal sealed class AppendedKit
    {
        private const int FooterBytes = 60;
        private static readonly byte[] Magic = Encoding.ASCII.GetBytes("MDSPAY01");

        public static bool TryRead(string exe, out long offset, out long length, out string sha)
        {
            offset = 0;
            length = 0;
            sha = "";
            try
            {
                using (FileStream stream = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (stream.Length < FooterBytes) return false;
                    stream.Seek(-FooterBytes, SeekOrigin.End);
                    byte[] footer = new byte[FooterBytes];
                    int read = 0;
                    while (read < FooterBytes)
                    {
                        int n = stream.Read(footer, read, FooterBytes - read);
                        if (n <= 0) return false;
                        read += n;
                    }
                    for (int i = 0; i < Magic.Length; i++)
                    {
                        if (footer[i] != Magic[i]) return false;
                    }
                    using (MemoryStream memory = new MemoryStream(footer))
                    using (BinaryReader reader = new BinaryReader(memory))
                    {
                        reader.ReadBytes(8);
                        offset = reader.ReadInt64();
                        length = reader.ReadInt64();
                        byte[] hash = reader.ReadBytes(32);
                        uint schema = reader.ReadUInt32();
                        if (schema != 1 || offset < 0 || length <= 0) return false;
                        if (offset + length + FooterBytes != stream.Length) return false;
                        StringBuilder text = new StringBuilder();
                        foreach (byte b in hash) text.Append(b.ToString("x2"));
                        sha = text.ToString();
                        return true;
                    }
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        public static string Extract(string exe, string work, IProgress progress)
        {
            long offset, length;
            string sha;
            if (!TryRead(exe, out offset, out length, out sha))
                throw new UpdaterException("This updater does not contain an embedded update kit. Supply one with /kit=<folder-or-zip>.");

            string zip = Path.Combine(work, "kit.zip");
            using (FileStream input = new FileStream(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            using (FileStream output = new FileStream(zip, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                input.Seek(offset, SeekOrigin.Begin);
                byte[] buffer = new byte[1024 * 1024];
                long remaining = length;
                long done = 0;
                while (remaining > 0)
                {
                    int want = (int)Math.Min((long)buffer.Length, remaining);
                    int n = input.Read(buffer, 0, want);
                    if (n <= 0) throw new UpdaterException("The embedded update kit is truncated.");
                    output.Write(buffer, 0, n);
                    remaining -= n;
                    done += n;
                    progress.Report("Reading embedded update kit", length == 0 ? 0 : (int)(done * 100 / length));
                }
            }
            if (!string.Equals(FileHash(zip), sha, StringComparison.OrdinalIgnoreCase))
                throw new UpdaterException("The embedded update kit failed its SHA-256 check. Do not use this updater.");
            return UnpackZip(zip, Path.Combine(work, "kit"), progress);
        }

        public static string UnpackZip(string zip, string destination, IProgress progress)
        {
            Directory.CreateDirectory(destination);
            string root = Path.GetFullPath(destination);
            if (!root.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
                root += Path.DirectorySeparatorChar;
            try
            {
                using (ZipArchive archive = ZipFile.OpenRead(zip))
                {
                    int index = 0;
                    foreach (ZipArchiveEntry entry in archive.Entries)
                    {
                        string name = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                        string target = Path.GetFullPath(Path.Combine(destination, name));
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                            throw new UpdaterException("The update kit contains an unsafe path: " + entry.FullName);
                        if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.Name.Length == 0)
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            string parent = Path.GetDirectoryName(target);
                            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                            entry.ExtractToFile(target, true);
                        }
                        index++;
                        progress.Report("Unpacking update kit", archive.Entries.Count == 0 ? 0 : index * 100 / archive.Entries.Count);
                    }
                }
            }
            catch (InvalidDataException exc)
            {
                throw new UpdaterException("The update kit is not a valid ZIP archive: " + exc.Message);
            }
            return destination;
        }

        public static string FileHash(string path)
        {
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
            {
                byte[] hash = sha.ComputeHash(stream);
                StringBuilder text = new StringBuilder();
                foreach (byte b in hash) text.Append(b.ToString("x2"));
                return text.ToString();
            }
        }
    }

    internal interface IProgress
    {
        void Report(string status, int percent);
    }

    internal sealed class NullProgress : IProgress
    {
        public void Report(string status, int percent) { }
    }

    internal sealed class WorkItem
    {
        public string Kit;
        public string Root;
        public bool Embedded;
        public string Temp;
    }

    internal static class Engine
    {
        public static string FindRoot(string hint, IProgress progress)
        {
            if (!string.IsNullOrEmpty(hint))
            {
                string supplied = Path.GetFullPath(hint.Trim());
                if (!File.Exists(Path.Combine(supplied, "setup-drive.json")))
                    throw new UpdaterException("No setup-drive.json in " + supplied + ". Point /root at the MedOS installation folder.");
                return supplied;
            }

            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\MedOS"))
                {
                    string registered = key == null ? null : key.GetValue("InstallDir") as string;
                    if (!string.IsNullOrEmpty(registered) && File.Exists(Path.Combine(registered, "setup-drive.json")))
                        return Path.GetFullPath(registered);
                }
            }
            catch (Exception) { }

            string beside = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            if (File.Exists(Path.Combine(beside, "setup-drive.json"))) return beside;

            string fallback = @"C:\MedOS";
            if (File.Exists(Path.Combine(fallback, "setup-drive.json"))) return fallback;

            throw new UpdaterException("Could not find a MedOS installation. Run this updater from inside MedOS, or pass /root=<folder>.");
        }

        public static WorkItem Prepare(Options options, IProgress progress)
        {
            string work = Path.Combine(Path.GetTempPath(), "MedOS-update-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            WorkItem item = new WorkItem();
            item.Temp = work;

            try
            {
                if (!string.IsNullOrEmpty(options.Kit))
                {
                    string supplied = Path.GetFullPath(options.Kit.Trim());
                    if (Directory.Exists(supplied))
                    {
                        item.Kit = supplied;
                        item.Embedded = false;
                    }
                    else if (File.Exists(supplied) && supplied.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
                    {
                        item.Kit = AppendedKit.UnpackZip(supplied, Path.Combine(work, "external-kit"), progress);
                        item.Embedded = false;
                    }
                    else
                    {
                        throw new UpdaterException("Update kit not found: " + supplied);
                    }
                }
                else
                {
                    item.Kit = AppendedKit.Extract(Assembly.GetExecutingAssembly().Location, work, progress);
                    item.Embedded = true;
                }

                if (!File.Exists(Path.Combine(item.Kit, "update.json")))
                    throw new UpdaterException("The update kit is missing update.json.");
                string engine = Path.Combine(item.Kit, "apply_update.py");
                if (!File.Exists(engine))
                    throw new UpdaterException("The update kit is missing apply_update.py.");
                string engineText = File.ReadAllText(engine);
                if (engineText.IndexOf("Apply a verified MedOS code update", StringComparison.Ordinal) < 0)
                    throw new UpdaterException("The update kit's apply_update.py is not the MedOS update engine.");

                item.Root = FindRoot(options.Root, progress);
                return item;
            }
            catch (Exception)
            {
                TryDelete(work);
                throw;
            }
        }

        public static int Run(WorkItem item, Options options, IProgress progress, Action<string> log)
        {
            string python = Path.Combine(item.Root, "tools", "python", "python.exe");
            if (!File.Exists(python))
                throw new UpdaterException("The target MedOS install has no tools\\python\\python.exe. Use a complete MedOS 1.1.4 or 1.1.5 install.");

            StringBuilder arguments = new StringBuilder();
            arguments.Append(Quote(Path.Combine(item.Kit, "apply_update.py")));
            arguments.Append(" --root ").Append(Quote(item.Root));
            arguments.Append(" --kit ").Append(Quote(item.Kit));
            if (options.IgnorePorts) arguments.Append(" --no-port-check");
            if (options.VerifyOnly) arguments.Append(" --verify-only");

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = python;
            start.Arguments = arguments.ToString();
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.WorkingDirectory = item.Root;

            int exit = 2;
            using (Process process = new Process())
            {
                process.StartInfo = start;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null) log(e.Data);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                {
                    if (e.Data != null) log(e.Data);
                };
                progress.Report(options.VerifyOnly ? "Verifying update kit..." : "Applying update...", -1);
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                process.WaitForExit();
                exit = process.ExitCode;
            }
            return exit;
        }

        public static string Quote(string value)
        {
            if (value == null) return "\"\"";
            return "\"" + value.TrimEnd(Path.DirectorySeparatorChar) + "\"";
        }

        public static void TryDelete(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
            catch (Exception) { }
        }
    }

    internal sealed class MainForm : Form, IProgress
    {
        private readonly Options _options;
        private TextBox _rootBox;
        private TextBox _kitBox;
        private Label _kitMode;
        private ProgressBar _bar;
        private TextBox _log;
        private Button _verify;
        private Button _apply;
        private readonly Queue<string> _pending = new Queue<string>();
        private readonly object _gate = new object();
        private string _logFile;
        private bool _busy;

        public MainForm(Options options)
        {
            _options = options;
            Text = "MedOS Updater";
            Size = new System.Drawing.Size(680, 560);
            MinimumSize = new System.Drawing.Size(560, 440);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new System.Drawing.Font("Segoe UI", 9F);
            Build();
            _logFile = string.IsNullOrEmpty(options.Log)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MedOS", "updater.log")
                : options.Log;
            WriteLog("MedOS Updater started. " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            if (!string.IsNullOrEmpty(options.Root)) _rootBox.Text = options.Root;
            if (!string.IsNullOrEmpty(options.Kit)) _kitBox.Text = options.Kit;
            _kitMode.Text = string.IsNullOrEmpty(options.Kit) ? "Embedded kit (inside this EXE)" : "External kit";
        }

        private void Build()
        {
            TableLayoutPanel panel = new TableLayoutPanel();
            panel.Dock = DockStyle.Fill;
            panel.ColumnCount = 3;
            panel.RowCount = 5;
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92F));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 92F));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 40F));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 42F));
            panel.RowStyles.Add(new RowStyle(SizeType.Absolute, 40F));
            panel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            panel.Padding = new Padding(12);
            Controls.Add(panel);

            Label title = new Label();
            title.Text = "Update a MedOS installation safely";
            title.Font = new System.Drawing.Font("Segoe UI", 13F, System.Drawing.FontStyle.Bold);
            title.Dock = DockStyle.Fill;
            title.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
            panel.Controls.Add(title, 0, 0);
            panel.SetColumnSpan(title, 3);

            panel.Controls.Add(LabelFor("Install folder"), 0, 1);
            _rootBox = new TextBox();
            _rootBox.Dock = DockStyle.Fill;
            _rootBox.ReadOnly = true;
            panel.Controls.Add(_rootBox, 1, 1);
            Button rootBrowse = ButtonFor("Browse...");
            rootBrowse.Click += delegate(object s, EventArgs e) { Browse(_rootBox, true); };
            panel.Controls.Add(rootBrowse, 2, 1);

            panel.Controls.Add(LabelFor("Update kit"), 0, 2);
            _kitBox = new TextBox();
            _kitBox.Dock = DockStyle.Fill;
            _kitBox.ReadOnly = true;
            panel.Controls.Add(_kitBox, 1, 2);
            Button kitBrowse = ButtonFor("Browse...");
            kitBrowse.Click += delegate(object s, EventArgs e) { Browse(_kitBox, false); };
            panel.Controls.Add(kitBrowse, 2, 2);

            _kitMode = LabelFor("");
            panel.Controls.Add(_kitMode, 1, 3);
            panel.SetColumnSpan(_kitMode, 2);

            FlowLayoutPanel buttons = new FlowLayoutPanel();
            buttons.Dock = DockStyle.Fill;
            buttons.FlowDirection = FlowDirection.LeftToRight;
            _verify = ButtonFor("Verify only");
            _verify.AutoSize = true;
            _verify.Click += delegate(object s, EventArgs e) { Start(true); };
            _apply = ButtonFor("Apply update");
            _apply.AutoSize = true;
            _apply.Click += delegate(object s, EventArgs e) { Start(false); };
            Button exit = ButtonFor("Exit");
            exit.AutoSize = true;
            exit.Click += delegate(object s, EventArgs e) { Close(); };
            buttons.Controls.Add(_verify);
            buttons.Controls.Add(_apply);
            buttons.Controls.Add(exit);
            panel.Controls.Add(buttons, 0, 3);

            TableLayoutPanel lower = new TableLayoutPanel();
            lower.Dock = DockStyle.Fill;
            lower.RowCount = 2;
            lower.ColumnCount = 1;
            lower.RowStyles.Add(new RowStyle(SizeType.Absolute, 24F));
            lower.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            _bar = new ProgressBar();
            _bar.Dock = DockStyle.Fill;
            _bar.Style = ProgressBarStyle.Continuous;
            lower.Controls.Add(_bar, 0, 0);
            _log = new TextBox();
            _log.Dock = DockStyle.Fill;
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.Font = new System.Drawing.Font("Consolas", 9F);
            _log.BackColor = System.Drawing.Color.FromArgb(15, 23, 42);
            _log.ForeColor = System.Drawing.Color.FromArgb(220, 235, 245);
            lower.Controls.Add(_log, 0, 1);
            panel.Controls.Add(lower, 0, 4);
            panel.SetColumnSpan(lower, 3);

            System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
            pump.Interval = 80;
            pump.Tick += delegate(object s, EventArgs e) { Drain(); };
            pump.Start();
        }

        private static Label LabelFor(string text)
        {
            Label label = new Label();
            label.Text = text;
            label.Dock = DockStyle.Fill;
            label.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
            return label;
        }

        private static Button ButtonFor(string text)
        {
            Button button = new Button();
            button.Text = text;
            button.Dock = DockStyle.Fill;
            button.AutoSize = false;
            button.Padding = new Padding(6, 2, 6, 2);
            button.UseVisualStyleBackColor = true;
            return button;
        }

        private void Browse(TextBox box, bool folder)
        {
            if (folder)
            {
                FolderBrowserDialog dialog = new FolderBrowserDialog();
                dialog.Description = "Select the MedOS installation folder";
                if (dialog.ShowDialog(this) == DialogResult.OK) box.Text = dialog.SelectedPath;
            }
            else
            {
                OpenFileDialog dialog = new OpenFileDialog();
                dialog.Title = "Select an update kit folder's update.json or a .zip";
                dialog.Filter = "Update kit|update.json;*.zip|All files|*.*";
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    string selected = dialog.FileName;
                    if (selected.EndsWith("update.json", StringComparison.OrdinalIgnoreCase)) selected = Path.GetDirectoryName(selected);
                    box.Text = selected;
                }
            }
        }

        private void Start(bool verify)
        {
            if (_busy) return;
            _busy = true;
            _verify.Enabled = false;
            _apply.Enabled = false;
            _bar.Style = ProgressBarStyle.Marquee;

            Options run = new Options();
            run.Root = _rootBox.Text;
            run.Kit = _kitBox.Text;
            run.VerifyOnly = verify || _options.VerifyOnly;
            run.IgnorePorts = _options.IgnorePorts;
            run.Silent = true;
            run.Log = _logFile;

            Thread thread = new Thread(delegate()
            {
                int code = 2;
                WorkItem item = null;
                try
                {
                    item = Engine.Prepare(run, this);
                    Report(item.Embedded ? "Using embedded update kit." : "Using external update kit.", -1);
                    Report("Target: " + item.Root, -1);
                    code = Engine.Run(item, run, this, delegate(string line) { Append(line); });
                    if (code == 0)
                        Append(run.VerifyOnly ? "Verification succeeded. No files were changed." : "Update complete. Your data was preserved.");
                    else
                        Append("Updater exited with code " + code + ". See the log for details.");
                }
                catch (Exception exc)
                {
                    Append("Updater error: " + exc.Message);
                }
                finally
                {
                    if (item != null) Engine.TryDelete(item.Temp);
                }
                BeginInvoke(new Action(delegate()
                {
                    _bar.Style = ProgressBarStyle.Continuous;
                    _bar.Value = code == 0 ? 100 : 0;
                    _verify.Enabled = true;
                    _apply.Enabled = true;
                    _busy = false;
                }));
            });
            thread.IsBackground = true;
            thread.Start();
        }

        public void Report(string status, int percent)
        {
            Append(status + (percent >= 0 ? " (" + percent + "%)" : ""));
        }

        private void Append(string line)
        {
            if (string.IsNullOrEmpty(line)) return;
            WriteLog(line);
            lock (_gate) _pending.Enqueue(line);
        }

        private void Drain()
        {
            List<string> lines = new List<string>();
            lock (_gate)
            {
                while (_pending.Count > 0) lines.Add(_pending.Dequeue());
            }
            if (lines.Count == 0) return;
            _log.AppendText(string.Join(Environment.NewLine, lines.ToArray()) + Environment.NewLine);
        }

        private void WriteLog(string line)
        {
            try
            {
                string parent = Path.GetDirectoryName(_logFile);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                File.AppendAllText(_logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine, Encoding.UTF8);
            }
            catch (Exception) { }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Options options = Options.Parse(args);
            if (options.Help)
            {
                if (options.Silent) Console.WriteLine(Options.HelpText());
                else MessageBox.Show(Options.HelpText(), "MedOS Updater", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!options.Silent)
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(options));
                return;
            }

            int code = 2;
            WorkItem item = null;
            string logFile = string.IsNullOrEmpty(options.Log)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MedOS", "updater.log")
                : options.Log;
            Action<string> log = delegate(string line)
            {
                Console.WriteLine(line);
                try
                {
                    string parent = Path.GetDirectoryName(logFile);
                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                    File.AppendAllText(logFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine, Encoding.UTF8);
                }
                catch (Exception) { }
            };
            try
            {
                item = Engine.Prepare(options, new NullProgress());
                log("Target: " + item.Root);
                log(item.Embedded ? "Using embedded update kit." : "Using external update kit.");
                code = Engine.Run(item, options, new NullProgress(), log);
            }
            catch (Exception exc)
            {
                log("Updater error: " + exc.Message);
                code = 2;
            }
            finally
            {
                if (item != null) Engine.TryDelete(item.Temp);
            }
            Environment.ExitCode = code;
        }
    }
}
