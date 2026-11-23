// MedOS Windows installer engine.
//
// Compiled by build_installer.py with the .NET Framework 4.x csc.exe using
// /langversion:5, so this file must stay C# 5 compatible: no string
// interpolation, no null-conditional operator, no expression-bodied members.
//
// The payload is a solid 7z archive that is either appended to this EXE
// (footer magic "MDSPAY01") or shipped next to it as MedOS-app.7z.001 parts.
// Nothing here needs the machine's Python, Node or 7-Zip installations.

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Runtime.Versioning.TargetFramework(
    ".NETFramework,Version=v4.6.2",
    FrameworkDisplayName = ".NET Framework 4.6.2")]

namespace MedOS.Setup
{
    internal sealed class SetupException : Exception
    {
        public SetupException(string message) : base(message) { }
    }

    // ------------------------------------------------------------------
    // Command line
    // ------------------------------------------------------------------
    internal sealed class Options
    {
        public string Mode = "";      // "", "new", "update"
        public string Dir = "";
        public bool Silent;
        public bool Uninstall;
        public bool Help;

        public static Options Parse(string[] args)
        {
            Options options = new Options();
            if (args == null) return options;
            foreach (string raw in args)
            {
                if (raw == null) continue;
                string arg = raw.Trim();
                string lower = arg.ToLowerInvariant();
                if (lower == "/update" || lower == "-update" || lower == "--update") options.Mode = "update";
                else if (lower == "/new" || lower == "-new" || lower == "--new") options.Mode = "new";
                else if (lower == "/silent" || lower == "-silent" || lower == "--silent") options.Silent = true;
                else if (lower == "/uninstall" || lower == "-uninstall" || lower == "--uninstall") options.Uninstall = true;
                else if (lower == "/?" || lower == "-h" || lower == "--help" || lower == "/help") options.Help = true;
                else if (lower.StartsWith("/dir=")) options.Dir = Unquote(arg.Substring(5));
                else if (lower.StartsWith("-dir=")) options.Dir = Unquote(arg.Substring(5));
                else if (lower.StartsWith("--dir=")) options.Dir = Unquote(arg.Substring(6));
                else if (lower == "/dir" || lower == "-dir" || lower == "--dir") { /* value not supported */ }
                else if (!arg.StartsWith("/") && !arg.StartsWith("-") && options.Dir.Length == 0)
                {
                    // A bare argument is accepted as the install folder.
                    options.Dir = Unquote(arg);
                }
            }
            if (options.Dir.Length > 0) options.Dir = options.Dir.TrimEnd('\\');
            return options;
        }

        private static string Unquote(string value)
        {
            string v = (value ?? "").Trim();
            if (v.Length >= 2 && v[0] == '"' && v[v.Length - 1] == '"') v = v.Substring(1, v.Length - 2);
            return v;
        }
    }

    // ------------------------------------------------------------------
    // Long path helpers / retrying file operations
    // ------------------------------------------------------------------
    internal static class Io
    {
        private const string Prefix = @"\\?\";
        private const int PrefixThreshold = 240;

        public static string Full(string path)
        {
            if (string.IsNullOrEmpty(path)) return path;
            if (path.StartsWith(@"\\?\")) return path;
            try { return Path.GetFullPath(path); }
            catch { return path; }
        }

        public static string ForcePrefix(string path)
        {
            string full = Full(path);
            if (string.IsNullOrEmpty(full)) return full;
            if (full.StartsWith(@"\\?\")) return full;
            if (full.StartsWith(@"\\")) return Prefix + "UNC\\" + full.Substring(2).TrimStart('\\');
            return Prefix + full;
        }

        // The prefix is only needed for paths that can exceed MAX_PATH; using it
        // for every short path breaks on runtimes with legacy IO path handling.
        public static string Lp(string path)
        {
            string full = Full(path);
            if (string.IsNullOrEmpty(full)) return full;
            return full.Length >= PrefixThreshold ? ForcePrefix(full) : full;
        }

        public static bool DirExists(string path)
        {
            try { return !string.IsNullOrEmpty(path) && Directory.Exists(Lp(path)); }
            catch { return false; }
        }

        public static bool FileExists(string path)
        {
            try { return !string.IsNullOrEmpty(path) && File.Exists(Lp(path)); }
            catch { return false; }
        }

        public static void EnsureDir(string path)
        {
            if (!DirExists(path)) Directory.CreateDirectory(Lp(path));
        }

        public static void MoveDir(string source, string destination)
        {
            if (DirExists(destination))
                throw new SetupException("The folder already exists: " + destination);
            Exception last = null;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                try
                {
                    Directory.Move(Lp(source), Lp(destination));
                    return;
                }
                catch (Exception ex)
                {
                    last = ex;
                    Thread.Sleep(300 + attempt * 250);
                }
            }
            throw new SetupException(
                "Could not move '" + source + "' to '" + destination + "'. " +
                "Close any program using this folder and try again. (" + last.Message + ")");
        }

        public static void CopyFile(string source, string destination)
        {
            EnsureDir(Path.GetDirectoryName(destination));
            Exception last = null;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    File.Copy(Lp(source), Lp(destination), true);
                    return;
                }
                catch (Exception ex)
                {
                    last = ex;
                    Thread.Sleep(300);
                }
            }
            throw new SetupException("Could not copy '" + source + "' to '" + destination + "'. (" + last.Message + ")");
        }

        public static void DeleteDir(string path)
        {
            if (!DirExists(path)) return;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    Directory.Delete(attempt == 0 ? ForcePrefix(path) : Lp(path), true);
                    return;
                }
                catch
                {
                    if (attempt == 1) ClearReadOnly(path);
                    Thread.Sleep(350 + attempt * 200);
                }
            }
            // Leaves the folder behind on purpose; the caller reports leftovers.
        }

        public static void DeleteFile(string path)
        {
            if (!FileExists(path)) return;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                try
                {
                    File.SetAttributes(Lp(path), FileAttributes.Normal);
                    File.Delete(Lp(path));
                    return;
                }
                catch
                {
                    Thread.Sleep(250);
                }
            }
        }

        private static void ClearReadOnly(string root)
        {
            try
            {
                foreach (string file in Directory.EnumerateFiles(ForcePrefix(root), "*", SearchOption.AllDirectories))
                {
                    try { File.SetAttributes(file, FileAttributes.Normal); }
                    catch { }
                }
            }
            catch { }
        }

        public static void WriteText(string path, string text)
        {
            EnsureDir(Path.GetDirectoryName(path));
            byte[] bytes = new UTF8Encoding(false).GetBytes(text ?? "");
            File.WriteAllBytes(Lp(path), bytes);
        }

        public static string ReadText(string path)
        {
            try { return File.Exists(Lp(path)) ? File.ReadAllText(Lp(path)) : null; }
            catch { return null; }
        }
    }

    internal static class Journal
    {
        private static readonly object Gate = new object();
        private static string _file;

        public static string FilePath
        {
            get
            {
                if (_file != null) return _file;
                string dir = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MedOS");
                try { Directory.CreateDirectory(dir); }
                catch { }
                _file = System.IO.Path.Combine(dir, "setup.log");
                return _file;
            }
        }

        public static void Write(string message)
        {
            lock (Gate)
            {
                try
                {
                    File.AppendAllText(FilePath,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "  " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
                catch { }
            }
        }
    }

    // ------------------------------------------------------------------
    // Progress sink implemented by the UI
    // ------------------------------------------------------------------
    internal interface ISetupUi
    {
        void Status(string text);
        void Percent(int value);
        void Marquee(bool enabled);
        void Log(string line);
    }

    // ------------------------------------------------------------------
    // Payload discovery: appended overlay or side-by-side volume parts
    // ------------------------------------------------------------------
    internal sealed class Payload
    {
        public const int FooterBytes = 60;
        public static readonly byte[] Magic = Encoding.ASCII.GetBytes("MDSPAY01");

        public string ArchivePath;
        public string ExpectedSha256;
        public long Bytes;

        public static Payload Locate(string workDir, ISetupUi ui, Action<long> sizeKnown)
        {
            string exe = CurrentExePath();
            long offset;
            long length;
            string sha;

            if (TryReadFooter(exe, out offset, out length, out sha))
            {
                ui.Log("  payload: embedded in " + System.IO.Path.GetFileName(exe));
                if (sizeKnown != null) sizeKnown(length);
                CopyRegion(exe, offset, length, workDir, ui, 2, 12);
                Payload embedded = new Payload();
                embedded.ArchivePath = workDir;
                embedded.ExpectedSha256 = sha;
                embedded.Bytes = length;
                return embedded;
            }

            string exeDir = System.IO.Path.GetDirectoryName(exe);
            string[] bases = new string[]
            {
                System.IO.Path.Combine(exeDir, "MedOS-app.7z.001"),
                System.IO.Path.Combine(exeDir, "payload", "MedOS-app.7z.001"),
            };
            foreach (string first in bases)
            {
                if (!Io.FileExists(first)) continue;
                return JoinParts(first, workDir, ui, sizeKnown);
            }

            throw new SetupException(
                "This installer does not contain the MedOS payload." + Environment.NewLine + Environment.NewLine +
                "Keep MedOS-Setup.exe in one piece, or place MedOS-app.7z.001 (and the following parts) " +
                "in the same folder before running it.");
        }

        private static Payload JoinParts(string firstPart, string workDir, ISetupUi ui, Action<long> sizeKnown)
        {
            string dir = System.IO.Path.GetDirectoryName(firstPart);
            string baseName = firstPart.Substring(0, firstPart.Length - ".001".Length);
            List<string> parts = new List<string>();
            for (int index = 1; index < 1000; index++)
            {
                string part = baseName + "." + index.ToString("000", CultureInfo.InvariantCulture);
                if (!Io.FileExists(part)) break;
                parts.Add(part);
            }
            if (parts.Count == 0) throw new SetupException("Payload parts not found: " + firstPart);

            long total = 0;
            foreach (string part in parts) total += new FileInfo(Io.Lp(part)).Length;

            string expected = null;
            string shaFile = System.IO.Path.Combine(dir, "MedOS-app.sha256");
            if (Io.FileExists(shaFile))
            {
                string text = (Io.ReadText(shaFile) ?? "").Trim();
                int space = text.IndexOf(' ');
                expected = (space > 0 ? text.Substring(0, space) : text).ToLowerInvariant();
            }

            ui.Log("  payload: " + parts.Count + " part(s), " + (total / 1048576.0).ToString("N1") + " MB");
            if (sizeKnown != null) sizeKnown(total);
            long copied = 0;
            int lastPercent = -1;
            using (FileStream output = new FileStream(Io.Lp(workDir), FileMode.Create, FileAccess.Write, FileShare.None, 4 << 20))
            {
                byte[] buffer = new byte[4 << 20];
                foreach (string part in parts)
                {
                    using (FileStream input = new FileStream(Io.Lp(part), FileMode.Open, FileAccess.Read, FileShare.Read, 4 << 20))
                    {
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            output.Write(buffer, 0, read);
                            copied += read;
                            int percent = total <= 0 ? 0 : (int)(copied * 100 / total);
                            if (percent != lastPercent)
                            {
                                lastPercent = percent;
                                ui.Percent(2 + percent * 10 / 100);
                            }
                        }
                    }
                }
            }

            Payload payload = new Payload();
            payload.ArchivePath = workDir;
            payload.ExpectedSha256 = expected;
            payload.Bytes = total;
            return payload;
        }

        public static bool TryReadFooter(string exePath, out long offset, out long length, out string sha)
        {
            offset = 0;
            length = 0;
            sha = null;
            try
            {
                using (FileStream stream = new FileStream(Io.Lp(exePath), FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    if (stream.Length < FooterBytes) return false;
                    stream.Seek(-FooterBytes, SeekOrigin.End);
                    byte[] buffer = new byte[FooterBytes];
                    int read = 0;
                    while (read < FooterBytes)
                    {
                        int count = stream.Read(buffer, read, FooterBytes - read);
                        if (count <= 0) return false;
                        read += count;
                    }
                    for (int i = 0; i < Magic.Length; i++)
                    {
                        if (buffer[i] != Magic[i]) return false;
                    }
                    offset = BitConverter.ToInt64(buffer, 8);
                    length = BitConverter.ToInt64(buffer, 16);
                    byte[] hash = new byte[32];
                    Array.Copy(buffer, 24, hash, 0, 32);
                    uint schema = BitConverter.ToUInt32(buffer, 56);
                    if (schema != 1) return false;
                    if (offset < 0 || length <= 0) return false;
                    if (offset + length + FooterBytes != stream.Length) return false;
                    sha = Hashes.Hex(hash);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void CopyRegion(string source, long offset, long length, string destination, ISetupUi ui, int fromPercent, int toPercent)
        {
            using (FileStream input = new FileStream(Io.Lp(source), FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4 << 20))
            using (FileStream output = new FileStream(Io.Lp(destination), FileMode.Create, FileAccess.Write, FileShare.None, 4 << 20))
            {
                input.Seek(offset, SeekOrigin.Begin);
                byte[] buffer = new byte[4 << 20];
                long remaining = length;
                long copied = 0;
                int lastPercent = -1;
                while (remaining > 0)
                {
                    int want = (int)Math.Min(buffer.Length, remaining);
                    int read = input.Read(buffer, 0, want);
                    if (read <= 0) throw new SetupException("The installer payload is truncated.");
                    output.Write(buffer, 0, read);
                    remaining -= read;
                    copied += read;
                    int percent = length <= 0 ? 100 : (int)(copied * 100 / length);
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        ui.Percent(fromPercent + percent * (toPercent - fromPercent) / 100);
                    }
                }
            }
        }

        public static string CurrentExePath()
        {
            try
            {
                Process process = Process.GetCurrentProcess();
                if (process.MainModule != null && !string.IsNullOrEmpty(process.MainModule.FileName))
                    return process.MainModule.FileName;
            }
            catch { }
            try
            {
                Assembly assembly = Assembly.GetEntryAssembly();
                if (assembly != null && !string.IsNullOrEmpty(assembly.Location)) return assembly.Location;
            }
            catch { }
            return System.IO.Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "MedOS-Setup.exe");
        }
    }

    internal static class Hashes
    {
        public static string Hex(byte[] bytes)
        {
            StringBuilder builder = new StringBuilder(bytes.Length * 2);
            for (int i = 0; i < bytes.Length; i++) builder.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
            return builder.ToString();
        }

        public static string Sha256File(string path, ISetupUi ui, int fromPercent, int toPercent)
        {
            using (FileStream stream = new FileStream(Io.Lp(path), FileMode.Open, FileAccess.Read, FileShare.Read, 4 << 20))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] buffer = new byte[4 << 20];
                long total = stream.Length;
                long done = 0;
                int lastPercent = -1;
                int read;
                while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    sha.TransformBlock(buffer, 0, read, null, 0);
                    done += read;
                    int percent = total <= 0 ? 100 : (int)(done * 100 / total);
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        ui.Percent(fromPercent + percent * (toPercent - fromPercent) / 100);
                    }
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                return Hex(sha.Hash);
            }
        }
    }

    // ------------------------------------------------------------------
    // 7-Zip extraction using the embedded (or installed) 7z binaries
    // ------------------------------------------------------------------
    internal static class Extractor
    {
        public static void Extract(string archive, string destination, ISetupUi ui, int fromPercent, int toPercent)
        {
            string tools = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "MedOS-setup-" + Guid.NewGuid().ToString("N"));
            Io.EnsureDir(tools);
            try
            {
                string exe = System.IO.Path.Combine(tools, "7z.exe");
                WriteResource("MedOS.Setup.7z.exe", exe);
                WriteResource("MedOS.Setup.7z.dll", System.IO.Path.Combine(tools, "7z.dll"));

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = exe;
                start.Arguments = "x -y -bd -bsp1 -bso1 -bse1 -o\"" + destination + "\" \"" + archive + "\"";
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.WorkingDirectory = tools;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = Encoding.UTF8;
                start.StandardErrorEncoding = Encoding.UTF8;

                List<string> errors = new List<string>();
                int lastPercent = -1;
                using (Process process = new Process())
                {
                    process.StartInfo = start;
                    process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
                    {
                        if (e.Data == null) return;
                        int percent;
                        if (TryParsePercent(e.Data, out percent))
                        {
                            if (percent != lastPercent)
                            {
                                lastPercent = percent;
                                ui.Percent(fromPercent + percent * (toPercent - fromPercent) / 100);
                                ui.Status("Unpacking MedOS ... " + percent + "%");
                            }
                        }
                    };
                    process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
                    {
                        if (e.Data == null) return;
                        string line = e.Data.Trim();
                        if (line.Length == 0) return;
                        errors.Add(line);
                        if (errors.Count > 40) errors.RemoveAt(0);
                        ui.Log("  7z: " + line);
                    };
                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    process.WaitForExit();
                    if (process.ExitCode != 0 && process.ExitCode != 1)
                    {
                        string detail = errors.Count > 0 ? errors[errors.Count - 1] : "no detail";
                        throw new SetupException("Could not unpack the MedOS payload (7-Zip exit code " +
                            process.ExitCode + ": " + detail + ").");
                    }
                }
            }
            finally
            {
                Io.DeleteDir(tools);
            }
        }

        private static bool TryParsePercent(string line, out int percent)
        {
            percent = 0;
            int index = line.IndexOf('%');
            if (index <= 0) return false;
            string number = line.Substring(0, index).Trim();
            if (number.Length == 0 || number.Length > 4) return false;
            return int.TryParse(number, NumberStyles.Integer, CultureInfo.InvariantCulture, out percent);
        }

        private static void WriteResource(string name, string destination)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(name))
            {
                if (stream == null) throw new SetupException("The installer is missing its built-in tool: " + name);
                using (FileStream output = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    stream.CopyTo(output);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Process handling
    // ------------------------------------------------------------------
    internal static class Processes
    {
        private static readonly HashSet<string> ToolImages = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "node.exe", "python.exe", "pythonw.exe", "7z.exe",
        };

        public static int StopAll(string installDir, Action<string> log)
        {
            int self = Process.GetCurrentProcess().Id;
            Dictionary<int, int> parents = new Dictionary<int, int>();
            List<int> candidates = new List<int>();

            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine FROM Win32_Process"))
                {
                    using (ManagementObjectCollection results = searcher.Get())
                    {
                        foreach (ManagementObject item in results)
                        {
                            try
                            {
                                int pid = Convert.ToInt32(item["ProcessId"], CultureInfo.InvariantCulture);
                                int parent = Convert.ToInt32(item["ParentProcessId"], CultureInfo.InvariantCulture);
                                parents[pid] = parent;
                                if (pid == self) continue;

                                string name = (item["Name"] as string) ?? "";
                                string exePath = item["ExecutablePath"] as string;
                                string command = item["CommandLine"] as string;

                                // Only processes that actually run from inside the install
                                // folder, or bundled runtimes whose command line names it.
                                // A shell or editor that merely mentions the path is left alone.
                                string root = installDir.TrimEnd('\\') + "\\";
                                bool match =
                                    (!string.IsNullOrEmpty(exePath) && exePath.StartsWith(root, StringComparison.OrdinalIgnoreCase)) ||
                                    (ToolImages.Contains(name) && !string.IsNullOrEmpty(command) &&
                                     command.IndexOf(root, StringComparison.OrdinalIgnoreCase) >= 0);
                                if (match) candidates.Add(pid);
                            }
                            catch { }
                            finally { item.Dispose(); }
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                log("  (could not enumerate processes: " + ex.Message + ")");
            }

            // Never kill this installer or any of its ancestors.
            HashSet<int> protectedPids = new HashSet<int>();
            protectedPids.Add(self);
            int cursor = self;
            for (int depth = 0; depth < 32; depth++)
            {
                int parent;
                if (!parents.TryGetValue(cursor, out parent) || parent <= 0) break;
                if (!protectedPids.Add(parent)) break;
                cursor = parent;
            }

            int killed = 0;
            foreach (int pid in candidates)
            {
                if (protectedPids.Contains(pid)) continue;
                if (Kill(pid)) killed++;
            }
            if (killed > 0) Thread.Sleep(900);
            return killed;
        }

        private static bool Kill(int pid)
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = System.IO.Path.Combine(Environment.SystemDirectory, "taskkill.exe");
                start.Arguments = "/F /T /PID " + pid.ToString(CultureInfo.InvariantCulture);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                using (Process process = Process.Start(start))
                {
                    process.WaitForExit(15000);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    // ------------------------------------------------------------------
    // Locations
    // ------------------------------------------------------------------
    internal sealed class InstallInfo
    {
        public string Dir = "";
        public string Version = "";
        public string Source = "";
    }

    internal static class Detector
    {
        public static List<InstallInfo> FindAll()
        {
            List<InstallInfo> found = new List<InstallInfo>();
            ReadRegistry(found);
            foreach (string dir in CommonPaths())
            {
                Add(found, dir, "folder");
            }
            // Deduplicate, registry hits first.
            List<InstallInfo> unique = new List<InstallInfo>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (InstallInfo info in found)
            {
                string key;
                try { key = System.IO.Path.GetFullPath(info.Dir).TrimEnd('\\'); }
                catch { key = info.Dir; }
                if (key.Length == 0 || seen.Contains(key)) continue;
                seen.Add(key);
                info.Dir = key;
                unique.Add(info);
            }
            return unique;
        }

        private static void ReadRegistry(List<InstallInfo> found)
        {
            RegistryKey[] roots = new RegistryKey[] { Registry.CurrentUser, Registry.LocalMachine };
            foreach (RegistryKey root in roots)
            {
                try
                {
                    using (RegistryKey key = root.OpenSubKey(@"Software\MedOS"))
                    {
                        if (key != null)
                        {
                            string dir = key.GetValue("InstallDir") as string;
                            string version = key.GetValue("Version") as string;
                            if (!string.IsNullOrEmpty(dir)) Add(found, dir, version ?? "");
                        }
                    }
                }
                catch { }
                try
                {
                    using (RegistryKey key = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS"))
                    {
                        if (key != null)
                        {
                            string dir = key.GetValue("InstallLocation") as string;
                            string version = key.GetValue("DisplayVersion") as string;
                            if (!string.IsNullOrEmpty(dir)) Add(found, dir, version ?? "");
                        }
                    }
                }
                catch { }
            }
        }

        public static string[] CommonPaths()
        {
            List<string> paths = new List<string>();
            try
            {
                paths.Add(System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MedOS"));
            }
            catch { }
            paths.Add(@"C:\MedOS");
            paths.Add(@"D:\MedOS");
            try
            {
                paths.Add(System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "MedOS"));
            }
            catch { }
            try
            {
                paths.Add(System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "MedOS"));
            }
            catch { }
            try
            {
                string exeDir = System.IO.Path.GetDirectoryName(Payload.CurrentExePath());
                if (!string.IsNullOrEmpty(exeDir))
                {
                    paths.Add(System.IO.Path.Combine(exeDir, "MedOS"));
                }
            }
            catch { }
            return paths.ToArray();
        }

        private static void Add(List<InstallInfo> found, string dir, string source)
        {
            if (string.IsNullOrEmpty(dir)) return;
            if (!LooksLikeInstall(dir)) return;
            InstallInfo info = new InstallInfo();
            info.Dir = dir;
            info.Version = ReadVersion(dir);
            info.Source = source;
            found.Add(info);
        }

        public static bool LooksLikeInstall(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            if (!Io.DirExists(dir)) return false;
            bool launcher = Io.FileExists(System.IO.Path.Combine(dir, "START.ps1")) ||
                            Io.FileExists(System.IO.Path.Combine(dir, "START.bat"));
            bool runtime = Io.DirExists(System.IO.Path.Combine(dir, "tools", "python"));
            return launcher && runtime;
        }

        public static string ReadVersion(string dir)
        {
            string marker = Io.ReadText(System.IO.Path.Combine(dir, ".medos-install.json"));
            if (!string.IsNullOrEmpty(marker))
            {
                int index = marker.IndexOf("\"version\"", StringComparison.OrdinalIgnoreCase);
                if (index >= 0)
                {
                    int colon = marker.IndexOf(':', index);
                    int first = colon >= 0 ? marker.IndexOf('"', colon + 1) : -1;
                    int last = first >= 0 ? marker.IndexOf('"', first + 1) : -1;
                    if (first >= 0 && last > first) return marker.Substring(first + 1, last - first - 1);
                }
            }
            return "";
        }

        public static string DefaultInstallDir()
        {
            string[] candidates = new string[] { @"C:\MedOS", SafeLocalAppData() };
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate)) continue;
                if (LooksLikeInstall(candidate)) return candidate;
                if (CanCreateUnder(candidate)) return candidate;
            }
            return SafeLocalAppData();
        }

        private static string SafeLocalAppData()
        {
            try
            {
                return System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MedOS");
            }
            catch { return @"C:\MedOS"; }
        }

        public static bool CanCreateUnder(string dir)
        {
            try
            {
                string parent = System.IO.Path.GetDirectoryName(dir.TrimEnd('\\'));
                if (string.IsNullOrEmpty(parent)) return false;
                if (!Directory.Exists(Io.Lp(parent))) return false;
                string probe = System.IO.Path.Combine(parent, ".medos-probe-" + Guid.NewGuid().ToString("N").Substring(0, 6));
                using (FileStream stream = new FileStream(Io.Lp(probe), FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
                {
                    stream.WriteByte(0);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public static void CheckWritable(string dir)
        {
            string probe = System.IO.Path.Combine(dir, ".medos-probe-" + Guid.NewGuid().ToString("N").Substring(0, 6));
            try
            {
                using (FileStream stream = new FileStream(Io.Lp(probe), FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose))
                {
                    stream.WriteByte(0);
                }
            }
            catch (Exception ex)
            {
                throw new SetupException("MedOS cannot write to '" + dir + "'. Choose another folder. (" + ex.Message + ")");
            }
        }

        public static long FreeBytes(string dir)
        {
            try
            {
                string root = System.IO.Path.GetPathRoot(dir);
                if (string.IsNullOrEmpty(root)) return -1;
                DriveInfo drive = new DriveInfo(root);
                if (!drive.IsReady) return -1;
                return drive.AvailableFreeSpace;
            }
            catch { return -1; }
        }
    }

    // ------------------------------------------------------------------
    // Shortcuts and registry
    // ------------------------------------------------------------------
    internal static class Shell
    {
        public static void CreateShortcut(string shortcutPath, string target, string arguments,
                                          string workingDirectory, string iconPath, string description)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new SetupException("Windows Script Host is not available.");
            object shell = Activator.CreateInstance(shellType);
            object shortcut = null;
            try
            {
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type type = shortcut.GetType();
                type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                type.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { arguments ?? "" });
                type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDirectory ?? "" });
                type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description ?? "MedOS" });
                if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
                {
                    type.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath + ",0" });
                }
                type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null)
                {
                    try { System.Runtime.InteropServices.Marshal.ReleaseComObject(shortcut); }
                    catch { }
                }
                try { System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); }
                catch { }
            }
        }

        public static void CreateDesktopShortcut(string installDir)
        {
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
            if (string.IsNullOrEmpty(desktop)) return;
            string vbs = System.IO.Path.Combine(installDir, "launch.vbs");
            string icon = System.IO.Path.Combine(installDir, "medos.ico");
            CreateShortcut(
                System.IO.Path.Combine(desktop, "MedOS.lnk"),
                System.IO.Path.Combine(Environment.SystemDirectory, "wscript.exe"),
                "\"" + vbs + "\"",
                installDir,
                icon,
                "MedOS - Clinical Intelligence Platform");
        }

        public static void CreateStartMenuShortcuts(string installDir)
        {
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
            if (string.IsNullOrEmpty(programs)) return;
            string folder = System.IO.Path.Combine(programs, "MedOS");
            try { Directory.CreateDirectory(folder); }
            catch { return; }
            string vbs = System.IO.Path.Combine(installDir, "launch.vbs");
            string icon = System.IO.Path.Combine(installDir, "medos.ico");
            CreateShortcut(
                System.IO.Path.Combine(folder, "MedOS.lnk"),
                System.IO.Path.Combine(Environment.SystemDirectory, "wscript.exe"),
                "\"" + vbs + "\"",
                installDir,
                icon,
                "MedOS - Clinical Intelligence Platform");
            string uninstaller = System.IO.Path.Combine(installDir, "Uninstall-MedOS.ps1");
            if (File.Exists(uninstaller))
            {
                CreateShortcut(
                    System.IO.Path.Combine(folder, "Uninstall MedOS.lnk"),
                    System.IO.Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
                    "-NoProfile -ExecutionPolicy Bypass -File \"" + uninstaller + "\"",
                    installDir,
                    icon,
                    "Remove MedOS from this PC");
            }
        }

        public static void RemoveShortcuts()
        {
            try
            {
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                if (!string.IsNullOrEmpty(desktop)) Io.DeleteFile(System.IO.Path.Combine(desktop, "MedOS.lnk"));
            }
            catch { }
            try
            {
                string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                if (!string.IsNullOrEmpty(programs)) Io.DeleteDir(System.IO.Path.Combine(programs, "MedOS"));
            }
            catch { }
        }

        public static void RegisterInstall(string installDir, string mode, string version)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\MedOS"))
                {
                    key.SetValue("InstallDir", installDir, RegistryValueKind.String);
                    key.SetValue("Version", version, RegistryValueKind.String);
                    key.SetValue("Mode", mode, RegistryValueKind.String);
                    key.SetValue("InstalledAt", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture), RegistryValueKind.String);
                }
            }
            catch (Exception ex) { Journal.Write("registry (software): " + ex.Message); }

            try
            {
                string uninstaller = System.IO.Path.Combine(installDir, "Uninstall-MedOS.ps1");
                string icon = System.IO.Path.Combine(installDir, "medos.ico");
                string displayIcon = File.Exists(icon) ? icon + ",0" : installDir;
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MedOS"))
                {
                    key.SetValue("DisplayName", "MedOS", RegistryValueKind.String);
                    key.SetValue("DisplayVersion", version, RegistryValueKind.String);
                    key.SetValue("Publisher", "MedOS", RegistryValueKind.String);
                    key.SetValue("InstallLocation", installDir, RegistryValueKind.String);
                    key.SetValue("DisplayIcon", displayIcon, RegistryValueKind.String);
                    key.SetValue("UninstallString",
                        "\"" + System.IO.Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe") +
                        "\" -NoProfile -ExecutionPolicy Bypass -File \"" + uninstaller + "\"",
                        RegistryValueKind.String);
                    key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", CultureInfo.InvariantCulture), RegistryValueKind.String);
                }
            }
            catch (Exception ex) { Journal.Write("registry (uninstall): " + ex.Message); }
        }

        public static string ReadRegisteredDir()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\MedOS"))
                {
                    if (key != null)
                    {
                        string dir = key.GetValue("InstallDir") as string;
                        if (!string.IsNullOrEmpty(dir)) return dir;
                    }
                }
            }
            catch { }
            return null;
        }
    }

    // ------------------------------------------------------------------
    // Installer
    // ------------------------------------------------------------------
    internal sealed class Installer
    {
        // Folders and files that belong to the user and survive an update.
        private static readonly string[] Preserve = new string[]
        {
            "data",
            "models",
            "exports",
            "app/.env",
            "app/backend/.env",
            "app/uploads",
            "app/public/uploads",
        };

        private readonly string _target;
        private readonly bool _update;
        private readonly ISetupUi _ui;

        public Installer(string target, bool update, ISetupUi ui)
        {
            _target = target;
            _update = update;
            _ui = ui;
        }

        public string Run()
        {
            if (string.IsNullOrEmpty(_target)) throw new SetupException("Choose an install folder first.");
            string target = System.IO.Path.GetFullPath(_target.Trim()).TrimEnd('\\');
            string parent = System.IO.Path.GetDirectoryName(target);
            string leaf = System.IO.Path.GetFileName(target);
            if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(leaf))
                throw new SetupException("Choose a folder such as C:\\MedOS, not a drive root.");
            if (leaf == "." || leaf == "..")
                throw new SetupException("Choose a normal folder such as C:\\MedOS.");

            _ui.Status("Checking the install folder ...");
            Io.EnsureDir(parent);
            Detector.CheckWritable(parent);
            _ui.Log("  target: " + target + (Io.DirExists(target) ? " (existing install)" : " (new)"));

            string work = System.IO.Path.Combine(parent, "." + leaf + ".medos-tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            string staging = System.IO.Path.Combine(work, "tree");
            string archive = System.IO.Path.Combine(work, "payload.7z");
            Io.EnsureDir(work);

            try
            {
                _ui.Marquee(false);
                _ui.Status("Reading the installation payload ...");
                _ui.Percent(1);
                Payload payload = Payload.Locate(archive, _ui, delegate(long bytes) { CheckSpace(parent, bytes); });
                _ui.Log("  payload: " + (payload.Bytes / 1048576.0).ToString("N1") + " MB");

                bool existed = Io.DirExists(target);
                if (!existed) Io.EnsureDir(target);
                Detector.CheckWritable(target);

                _ui.Status("Stopping running MedOS processes ...");
                int killed = Processes.StopAll(target, _ui.Log);
                if (killed > 0) _ui.Log("  stopped " + killed + " process(es)");

                _ui.Percent(12);
                if (!string.IsNullOrEmpty(payload.ExpectedSha256))
                {
                    _ui.Status("Verifying the payload ...");
                    string actual = Hashes.Sha256File(archive, _ui, 12, 20);
                    if (!string.Equals(actual, payload.ExpectedSha256, StringComparison.OrdinalIgnoreCase))
                        throw new SetupException("The installation payload is damaged (checksum mismatch). Download MedOS-Setup.exe again.");
                    _ui.Log("  checksum: OK");
                }
                else
                {
                    _ui.Log("  checksum: not provided by this package");
                }

                _ui.Percent(20);
                _ui.Status("Unpacking MedOS ...");
                Io.EnsureDir(staging);
                Extractor.Extract(archive, staging, _ui, 20, 88);
                if (!Io.FileExists(System.IO.Path.Combine(staging, "START.ps1")))
                    throw new SetupException("The payload is incomplete: START.ps1 is missing.");

                _ui.Percent(89);
                PatchNextConfig(staging, target);
                WriteMarker(staging, target);
                WriteUninstaller(staging);

                _ui.Status("Installing program files ...");
                _ui.Percent(91);
                Swap(target, staging, existed);

                _ui.Percent(96);
                _ui.Status("Creating shortcuts ...");
                Shell.RegisterInstall(target, _update ? "update" : "new", BuildInfo.Version);
                try { Shell.CreateDesktopShortcut(target); }
                catch (Exception ex) { _ui.Log("  (desktop shortcut failed: " + ex.Message + ")"); }
                try { Shell.CreateStartMenuShortcuts(target); }
                catch (Exception ex) { _ui.Log("  (start menu shortcut failed: " + ex.Message + ")"); }

                EnsureUserFolders(target);
                Io.DeleteFile(archive);
                _ui.Percent(100);
                _ui.Status("MedOS " + BuildInfo.Version + " is ready.");
                _ui.Log("  installed to " + target);
                return target;
            }
            finally
            {
                Io.DeleteDir(work);
            }
        }

        private void CheckSpace(string parent, long payloadBytes)
        {
            long free = Detector.FreeBytes(parent);
            if (free < 0) return;
            long required = payloadBytes + 2400000000L;
            _ui.Log("  free space: " + (free / 1073741824.0).ToString("N1") + " GB, needs about " +
                    (required / 1073741824.0).ToString("N1") + " GB");
            if (free < required)
            {
                throw new SetupException(
                    "Not enough free space on this drive." + Environment.NewLine + Environment.NewLine +
                    "Available: " + (free / 1073741824.0).ToString("N1") + " GB" + Environment.NewLine +
                    "Needed:    " + (required / 1073741824.0).ToString("N1") + " GB");
            }
        }

        // The Next.js build records the absolute folder it was compiled in; rewrite
        // it so the installed copy resolves its own app folder instead of ours.
        private void PatchNextConfig(string staging, string target)
        {
            string file = System.IO.Path.Combine(staging, "app", ".next", "required-server-files.json");
            if (!Io.FileExists(file)) return;

            string text;
            try { text = File.ReadAllText(Io.Lp(file)); }
            catch (Exception ex)
            {
                _ui.Log("  (could not read the Next.js build config: " + ex.Message + ")");
                return;
            }

            const string key = "\"outputFileTracingRoot\"";
            int keyIndex = text.IndexOf(key, StringComparison.Ordinal);
            if (keyIndex < 0) return;
            int colon = text.IndexOf(':', keyIndex + key.Length);
            if (colon < 0) return;
            int open = text.IndexOf('"', colon + 1);
            if (open < 0) return;
            int close = open + 1;
            while (close < text.Length)
            {
                if (text[close] == '\\') { close += 2; continue; }
                if (text[close] == '"') break;
                close++;
            }
            if (close >= text.Length) return;

            string appPath = System.IO.Path.Combine(target, "app");
            string encoded = appPath.Replace("\\", "\\\\").Replace("\"", "\\\"");
            string updated = text.Substring(0, open + 1) + encoded + text.Substring(close);
            if (string.Equals(updated, text, StringComparison.Ordinal)) return;

            try
            {
                Io.WriteText(file, updated);
                _ui.Log("  build path: " + appPath);
            }
            catch (Exception ex)
            {
                _ui.Log("  (could not update the Next.js build path: " + ex.Message + ")");
            }
        }

        private void WriteMarker(string staging, string target)
        {
            string json = "{" + Environment.NewLine +
                "  \"product\": \"MedOS\"," + Environment.NewLine +
                "  \"version\": \"" + BuildInfo.Version + "\"," + Environment.NewLine +
                "  \"mode\": \"" + (_update ? "update" : "new") + "\"," + Environment.NewLine +
                "  \"installed_at\": \"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\"," + Environment.NewLine +
                "  \"installer\": \"MedOS-Setup.exe\"" + Environment.NewLine +
                "}" + Environment.NewLine;
            Io.WriteText(System.IO.Path.Combine(staging, ".medos-install.json"), json);
        }

        private void WriteUninstaller(string staging)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream("MedOS.Setup.uninstall.ps1"))
            {
                if (stream == null) return;
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    string text = reader.ReadToEnd();
                    Io.WriteText(System.IO.Path.Combine(staging, "Uninstall-MedOS.ps1"), text);
                }
            }
        }

        private void Swap(string target, string staging, bool existed)
        {
            string parent = System.IO.Path.GetDirectoryName(target);
            string leaf = System.IO.Path.GetFileName(target);
            string old = System.IO.Path.Combine(parent, "." + leaf + ".medos-old-" + DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture));
            bool movedOld = false;

            if (Io.DirExists(target))
            {
                if (existed)
                {
                    _ui.Log("  moving the previous program files aside ...");
                    Io.MoveDir(target, old);
                    movedOld = true;
                }
                else
                {
                    // We created this empty placeholder ourselves.
                    Io.DeleteDir(target);
                }
            }
            if (Io.DirExists(target)) throw new SetupException("The install folder is still in use: " + target);

            try
            {
                Io.MoveDir(staging, target);
                if (movedOld) RestorePreserved(old, target);
            }
            catch (Exception ex)
            {
                Rollback(target, old, movedOld);
                throw new SetupException("Could not install the program files: " + ex.Message);
            }

            if (movedOld)
            {
                Io.DeleteDir(old);
                if (Io.DirExists(old))
                {
                    _ui.Log("  note: the previous program files are still in " + old);
                    _ui.Log("        you can delete that folder by hand.");
                }
            }
        }

        private void RestorePreserved(string oldRoot, string newRoot)
        {
            foreach (string relative in Preserve)
            {
                string rel = relative.Replace('/', System.IO.Path.DirectorySeparatorChar);
                string from = System.IO.Path.Combine(oldRoot, rel);
                string to = System.IO.Path.Combine(newRoot, rel);
                if (Io.DirExists(from))
                {
                    _ui.Log("  keeping " + relative + "/");
                    Io.DeleteDir(to);
                    Io.MoveDir(from, to);
                }
                else if (Io.FileExists(from))
                {
                    Io.CopyFile(from, to);
                }
            }
        }

        private void Rollback(string target, string old, bool movedOld)
        {
            _ui.Log("  rolling back ...");
            if (movedOld && Io.DirExists(old))
            {
                foreach (string relative in Preserve)
                {
                    string rel = relative.Replace('/', System.IO.Path.DirectorySeparatorChar);
                    string inNew = System.IO.Path.Combine(target, rel);
                    string inOld = System.IO.Path.Combine(old, rel);
                    try
                    {
                        if (Io.DirExists(inNew) && !Io.DirExists(inOld)) Io.MoveDir(inNew, inOld);
                        else if (Io.FileExists(inNew) && !Io.FileExists(inOld)) Io.CopyFile(inNew, inOld);
                    }
                    catch { }
                }
            }
            Io.DeleteDir(target);
            if (movedOld && Io.DirExists(old))
            {
                try { Io.MoveDir(old, target); }
                catch (Exception ex) { Journal.Write("rollback move failed: " + ex.Message); }
            }
        }

        private void EnsureUserFolders(string target)
        {
            string[] dirs = new string[] { "data", "exports" };
            foreach (string name in dirs)
            {
                try { Io.EnsureDir(System.IO.Path.Combine(target, name)); }
                catch { }
            }
        }
    }

    // ------------------------------------------------------------------
    // Download support
    // ------------------------------------------------------------------
    internal static class Downloader
    {
        public static void Download(string url, string destination, ISetupUi ui)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri))
                throw new SetupException("That download link is not a valid URL.");
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
                throw new SetupException("Only http and https links are supported.");

            ui.Marquee(false);
            ui.Percent(0);
            ui.Status("Downloading the update ...");
            Exception failure = null;
            ManualResetEvent finished = new ManualResetEvent(false);

            using (WebClient client = new WebClient())
            {
                client.Headers.Add("User-Agent", "MedOS-Setup/" + BuildInfo.Version);
                client.DownloadProgressChanged += delegate(object sender, DownloadProgressChangedEventArgs e)
                {
                    ui.Percent(e.ProgressPercentage);
                    ui.Status("Downloading the update ... " + e.ProgressPercentage + "%");
                };
                client.DownloadFileCompleted += delegate(object sender, AsyncCompletedEventArgs e)
                {
                    if (e.Error != null) failure = e.Error;
                    else if (e.Cancelled) failure = new SetupException("The download was cancelled.");
                    finished.Set();
                };
                try
                {
                    client.DownloadFileAsync(uri, destination);
                    while (!finished.WaitOne(250)) { }
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            }
            if (failure != null)
                throw new SetupException("Could not download the update: " + failure.Message);
            if (!Io.FileExists(destination) || new FileInfo(Io.Lp(destination)).Length < 1024)
                throw new SetupException("The downloaded file is empty or incomplete.");
        }
    }

    // ------------------------------------------------------------------
    // Silent (unattended) install used by automation and update launches
    // ------------------------------------------------------------------
    internal sealed class NullUi : ISetupUi
    {
        public void Status(string text) { Journal.Write("  " + text); }
        public void Percent(int value) { }
        public void Marquee(bool enabled) { }
        public void Log(string line) { Journal.Write(line); }
    }

    // ------------------------------------------------------------------
    // Program entry point
    // ------------------------------------------------------------------
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                ServicePointManager.SecurityProtocol = ServicePointManager.SecurityProtocol |
                    (SecurityProtocolType)3072; // TLS 1.2
            }
            catch { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Options options = Options.Parse(args);
            Journal.Write("---- MedOS Setup " + BuildInfo.Version + " " + string.Join(" ", args) + " ----");

            if (options.Help)
            {
                System.Windows.Forms.MessageBox.Show(
                    "MedOS Setup " + BuildInfo.Version + Environment.NewLine + Environment.NewLine +
                    "  MedOS-Setup.exe                 interactive setup" + Environment.NewLine +
                    "  MedOS-Setup.exe /update /dir=C:\\MedOS" + Environment.NewLine +
                    "  MedOS-Setup.exe /new /dir=C:\\MedOS" + Environment.NewLine +
                    "  MedOS-Setup.exe /uninstall" + Environment.NewLine,
                    "MedOS Setup", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Information);
                return 0;
            }

            if (options.Uninstall)
            {
                return Uninstaller.Run(options.Dir);
            }

            if (options.Silent)
            {
                return RunSilent(options);
            }

            SetupForm form = new SetupForm(options);
            Application.Run(form);
            return 0;
        }

        private static int RunSilent(Options options)
        {
            string target = options.Dir;
            if (string.IsNullOrEmpty(target)) target = Shell.ReadRegisteredDir();
            if (string.IsNullOrEmpty(target))
            {
                List<InstallInfo> found = Detector.FindAll();
                target = found.Count > 0 ? found[0].Dir : Detector.DefaultInstallDir();
            }
            bool update = options.Mode != "new";
            Journal.Write("silent install: " + target + " update=" + update);
            try
            {
                Installer engine = new Installer(target, update, new NullUi());
                engine.Run();
                return 0;
            }
            catch (Exception ex)
            {
                Journal.Write(ex.ToString());
                return 1;
            }
        }
    }

    internal static class Uninstaller
    {
        public static int Run(string requestedDir)
        {
            string dir = requestedDir;
            if (string.IsNullOrEmpty(dir)) dir = Shell.ReadRegisteredDir();
            if (string.IsNullOrEmpty(dir) || !Detector.LooksLikeInstall(dir))
            {
                List<InstallInfo> found = Detector.FindAll();
                if (found.Count > 0) dir = found[0].Dir;
            }
            if (string.IsNullOrEmpty(dir) || !Detector.LooksLikeInstall(dir))
            {
                System.Windows.Forms.MessageBox.Show(
                    "MedOS does not appear to be installed on this PC.",
                    "MedOS", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Information);
                return 1;
            }
            string script = System.IO.Path.Combine(dir, "Uninstall-MedOS.ps1");
            if (!File.Exists(Io.Lp(script)))
            {
                System.Windows.Forms.MessageBox.Show(
                    "The uninstaller is missing from " + dir + "." + Environment.NewLine + Environment.NewLine +
                    "Delete that folder and the MedOS desktop shortcut by hand.",
                    "MedOS", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Warning);
                return 1;
            }
            try
            {
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = System.IO.Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
                start.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"";
                start.UseShellExecute = true;
                start.WorkingDirectory = dir;
                Process.Start(start);
                return 0;
            }
            catch (Exception ex)
            {
                System.Windows.Forms.MessageBox.Show("Could not start the uninstaller: " + ex.Message,
                    "MedOS", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
