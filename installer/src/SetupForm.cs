// MedOS Windows installer UI (C# 5 / WinForms).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace MedOS.Setup
{
    internal sealed class SetupForm : Form, ISetupUi
    {
        private readonly Options _options;
        private readonly List<InstallInfo> _installs;
        private readonly bool _hasPayload;

        private Panel[] _pages;
        private int _pageIndex;
        private bool _busy;
        private string _installTarget;

        private Label _lblDetected;
        private Button _btnNewInstall;
        private Button _btnUpdate;

        private TextBox _txtDir;
        private Label _lblSpace;
        private Label _lblExisting;
        private Button _btnInstall;

        private Label _lblUpdateInfo;
        private TextBox _txtUrl;
        private Button _btnUsePackage;
        private Button _btnPickPackage;
        private Button _btnDownload;

        private Label _lblStatus;
        private ProgressBar _bar;
        private TextBox _log;

        private Label _lblDoneTitle;
        private Label _lblDoneDetail;
        private CheckBox _chkLaunch;
        private Button _btnFinish;

        public SetupForm(Options options)
        {
            _options = options ?? new Options();
            _installs = Detector.FindAll();
            _hasPayload = HasLocalPayload();

            Text = "MedOS Setup " + BuildInfo.Version;
            ClientSize = new Size(680, 530);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.White;
            Font = new Font("Segoe UI", 9F);
            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("MedOS.Setup.ico"))
                {
                    if (stream != null) Icon = new Icon(stream);
                }
            }
            catch { }

            BuildUi();
            RefreshWelcome();
        }

        // --------------------------------------------------------------
        // Layout
        // --------------------------------------------------------------
        private void BuildUi()
        {
            Panel header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 88;
            header.BackColor = Color.FromArgb(13, 33, 55);
            Controls.Add(header);

            try
            {
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("MedOS.Setup.ico"))
                {
                    if (stream != null)
                    {
                        PictureBox icon = new PictureBox();
                        icon.Image = new Icon(stream, 48, 48).ToBitmap();
                        icon.SizeMode = PictureBoxSizeMode.CenterImage;
                        icon.Size = new Size(52, 52);
                        icon.Location = new Point(22, 18);
                        icon.BackColor = Color.Transparent;
                        header.Controls.Add(icon);
                    }
                }
            }
            catch { }

            Label brand = new Label();
            brand.Text = "MedOS";
            brand.Font = new Font("Segoe UI Semibold", 19F, FontStyle.Bold);
            brand.ForeColor = Color.White;
            brand.AutoSize = true;
            brand.BackColor = Color.Transparent;
            brand.Location = new Point(82, 14);
            header.Controls.Add(brand);

            Label tagline = new Label();
            tagline.Text = "Clinical Intelligence Platform";
            tagline.Font = new Font("Segoe UI", 9F);
            tagline.ForeColor = Color.FromArgb(151, 191, 224);
            tagline.AutoSize = true;
            tagline.BackColor = Color.Transparent;
            tagline.Location = new Point(85, 52);
            header.Controls.Add(tagline);

            Label headerVersion = new Label();
            headerVersion.Text = "Setup " + BuildInfo.Version;
            headerVersion.Font = new Font("Segoe UI", 9F);
            headerVersion.ForeColor = Color.FromArgb(120, 158, 190);
            headerVersion.AutoSize = true;
            headerVersion.BackColor = Color.Transparent;
            header.Controls.Add(headerVersion);
            // Header starts at its default width, so anchoring cannot place this
            // label correctly; pin it to the right edge whenever the header resizes.
            EventHandler placeVersion = delegate
            {
                headerVersion.Left = Math.Max(210, header.ClientSize.Width - headerVersion.Width - 22);
                headerVersion.Top = 34;
            };
            header.Resize += placeVersion;
            placeVersion(null, EventArgs.Empty);

            Panel body = new Panel();
            body.Dock = DockStyle.Fill;
            body.BackColor = Color.White;
            Controls.Add(body);
            body.BringToFront();

            _pages = new Panel[5];
            _pages[0] = BuildWelcomePage();
            _pages[1] = BuildTargetPage();
            _pages[2] = BuildUpdatePage();
            _pages[3] = BuildProgressPage();
            _pages[4] = BuildDonePage();
            for (int i = 0; i < _pages.Length; i++)
            {
                _pages[i].Dock = DockStyle.Fill;
                _pages[i].Visible = i == 0;
                body.Controls.Add(_pages[i]);
            }
        }

        private Panel NewPage()
        {
            Panel page = new Panel();
            page.BackColor = Color.White;
            return page;
        }

        private static Label NewLabel(string text, int x, int y, int width, int height, float size, FontStyle style, Color color)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.Size = new Size(width, height);
            label.Font = new Font("Segoe UI", size, style);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            return label;
        }

        private static Button NewButton(string text, int x, int y, int width, int height, bool primary)
        {
            Button button = new Button();
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, height);
            button.FlatStyle = FlatStyle.Flat;
            button.UseVisualStyleBackColor = false;
            button.Cursor = Cursors.Hand;
            button.Font = new Font("Segoe UI", 9.75F, primary ? FontStyle.Bold : FontStyle.Regular);
            if (primary)
            {
                button.BackColor = Color.FromArgb(15, 98, 180);
                button.ForeColor = Color.White;
                button.FlatAppearance.BorderSize = 0;
            }
            else
            {
                button.BackColor = Color.White;
                button.ForeColor = Color.FromArgb(24, 48, 72);
                button.FlatAppearance.BorderSize = 1;
                button.FlatAppearance.BorderColor = Color.FromArgb(198, 210, 224);
            }
            return button;
        }

        private Panel BuildWelcomePage()
        {
            Panel page = NewPage();
            page.Controls.Add(NewLabel("Install or update MedOS", 28, 20, 600, 30, 14F, FontStyle.Bold, Color.FromArgb(20, 40, 60)));

            _lblDetected = NewLabel("", 28, 58, 608, 46, 9.75F, FontStyle.Regular, Color.FromArgb(58, 76, 94));
            page.Controls.Add(_lblDetected);

            _btnNewInstall = NewButton("New install", 28, 116, 286, 54, true);
            _btnNewInstall.Click += delegate { OpenTargetPage(); };
            page.Controls.Add(_btnNewInstall);

            _btnUpdate = NewButton("Download update", 322, 116, 314, 54, false);
            _btnUpdate.Click += delegate { OpenUpdatePage(); };
            page.Controls.Add(_btnUpdate);

            page.Controls.Add(NewLabel(
                "Copy MedOS to this PC. Add your books and media from Content Manager afterwards.",
                28, 178, 286, 48, 8.75F, FontStyle.Regular, Color.FromArgb(110, 126, 141)));
            page.Controls.Add(NewLabel(
                "Fetch a newer MedOS-Setup.exe and update the installation that is already here.",
                322, 178, 314, 48, 8.75F, FontStyle.Regular, Color.FromArgb(110, 126, 141)));

            Panel rule = new Panel();
            rule.Location = new Point(28, 248);
            rule.Size = new Size(608, 1);
            rule.BackColor = Color.FromArgb(224, 230, 237);
            page.Controls.Add(rule);

            page.Controls.Add(NewLabel(
                "The installer copies the MedOS program and its bundled runtimes only. " +
                "Books, media, caches and notes belong to Content Manager, so you can move them to another drive " +
                "or PC whenever you like.",
                28, 264, 608, 60, 9F, FontStyle.Regular, Color.FromArgb(70, 88, 106)));

            page.Controls.Add(NewLabel(
                "Version " + BuildInfo.Version + "  |  Windows 10 / 11  |  no administrator rights required",
                28, 404, 460, 22, 8.5F, FontStyle.Regular, Color.FromArgb(130, 145, 160)));

            LinkLabel logLink = new LinkLabel();
            logLink.Text = "Setup log";
            logLink.Location = new Point(556, 402);
            logLink.AutoSize = true;
            logLink.LinkColor = Color.FromArgb(15, 98, 180);
            logLink.Click += delegate { OpenLogFolder(); };
            page.Controls.Add(logLink);
            return page;
        }

        private Panel BuildTargetPage()
        {
            Panel page = NewPage();
            page.Controls.Add(NewLabel("Where should MedOS be installed?", 28, 20, 600, 30, 14F, FontStyle.Bold, Color.FromArgb(20, 40, 60)));
            page.Controls.Add(NewLabel(
                "Pick a fast local drive with about 5 GB free. A folder on this drive is used for the download and unpacking.",
                28, 56, 608, 36, 9F, FontStyle.Regular, Color.FromArgb(70, 88, 106)));

            _txtDir = new TextBox();
            _txtDir.Location = new Point(28, 100);
            _txtDir.Size = new Size(468, 27);
            _txtDir.Font = new Font("Segoe UI", 10F);
            _txtDir.TextChanged += delegate { UpdateSpaceLabel(); };
            page.Controls.Add(_txtDir);

            Button browse = NewButton("Browse...", 506, 99, 130, 29, false);
            browse.Font = new Font("Segoe UI", 9F);
            browse.Click += delegate { BrowseForFolder(); };
            page.Controls.Add(browse);

            _lblSpace = NewLabel("", 28, 140, 608, 22, 9F, FontStyle.Regular, Color.FromArgb(90, 106, 122));
            page.Controls.Add(_lblSpace);

            _lblExisting = NewLabel("", 28, 168, 608, 54, 9F, FontStyle.Regular, Color.FromArgb(178, 92, 30));
            page.Controls.Add(_lblExisting);

            _btnInstall = NewButton("Install", 28, 386, 160, 40, true);
            _btnInstall.Click += delegate { BeginNewInstall(); };
            page.Controls.Add(_btnInstall);

            Button back = NewButton("Back", 198, 386, 110, 40, false);
            back.Click += delegate { ShowPage(0); };
            page.Controls.Add(back);
            return page;
        }

        private Panel BuildUpdatePage()
        {
            Panel page = NewPage();
            page.Controls.Add(NewLabel("Update MedOS", 28, 20, 600, 30, 14F, FontStyle.Bold, Color.FromArgb(20, 40, 60)));

            _lblUpdateInfo = NewLabel("", 28, 56, 608, 58, 9.5F, FontStyle.Regular, Color.FromArgb(58, 76, 94));
            page.Controls.Add(_lblUpdateInfo);

            _btnUsePackage = NewButton("Update with this installer", 28, 120, 270, 44, true);
            _btnUsePackage.Click += delegate { BeginUpdateFromThisPackage(); };
            page.Controls.Add(_btnUsePackage);

            _btnPickPackage = NewButton("Choose MedOS-Setup.exe ...", 310, 120, 326, 44, false);
            _btnPickPackage.Click += delegate { PickUpdatePackage(); };
            page.Controls.Add(_btnPickPackage);

            page.Controls.Add(NewLabel("Or download the newest installer:", 28, 184, 400, 22, 9F, FontStyle.Regular, Color.FromArgb(70, 88, 106)));

            _txtUrl = new TextBox();
            _txtUrl.Location = new Point(28, 208);
            _txtUrl.Size = new Size(468, 27);
            _txtUrl.Font = new Font("Segoe UI", 9.5F);
            page.Controls.Add(_txtUrl);

            _btnDownload = NewButton("Download", 506, 207, 130, 29, false);
            _btnDownload.Font = new Font("Segoe UI", 9F);
            _btnDownload.Click += delegate { BeginDownload(); };
            page.Controls.Add(_btnDownload);

            page.Controls.Add(NewLabel(
                "Paste the download link of a MedOS-Setup.exe. The file is saved to your temporary folder, " +
                "checked for damage and then applied to the installation above.",
                28, 244, 608, 48, 8.75F, FontStyle.Regular, Color.FromArgb(120, 136, 151)));

            Button back = NewButton("Back", 28, 386, 110, 40, false);
            back.Click += delegate { ShowPage(0); };
            page.Controls.Add(back);
            return page;
        }

        private Panel BuildProgressPage()
        {
            Panel page = NewPage();
            _lblStatus = NewLabel("Preparing ...", 28, 22, 608, 30, 12F, FontStyle.Bold, Color.FromArgb(20, 40, 60));
            page.Controls.Add(_lblStatus);

            _bar = new ProgressBar();
            _bar.Location = new Point(28, 60);
            _bar.Size = new Size(608, 16);
            _bar.Style = ProgressBarStyle.Continuous;
            page.Controls.Add(_bar);

            _log = new TextBox();
            _log.Location = new Point(28, 92);
            _log.Size = new Size(608, 300);
            _log.Multiline = true;
            _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical;
            _log.BackColor = Color.FromArgb(247, 249, 251);
            _log.ForeColor = Color.FromArgb(60, 76, 92);
            _log.BorderStyle = BorderStyle.FixedSingle;
            _log.Font = new Font("Consolas", 8.25F);
            _log.WordWrap = false;
            page.Controls.Add(_log);

            page.Controls.Add(NewLabel(
                "Keep this window open. You can finish and open MedOS when the bar reaches the end.",
                28, 402, 608, 22, 8.5F, FontStyle.Regular, Color.FromArgb(130, 145, 160)));
            return page;
        }

        private Panel BuildDonePage()
        {
            Panel page = NewPage();
            _lblDoneTitle = NewLabel("", 28, 22, 608, 34, 14F, FontStyle.Bold, Color.FromArgb(20, 40, 60));
            page.Controls.Add(_lblDoneTitle);

            _lblDoneDetail = NewLabel("", 28, 64, 608, 210, 9.5F, FontStyle.Regular, Color.FromArgb(58, 76, 94));
            page.Controls.Add(_lblDoneDetail);

            _chkLaunch = new CheckBox();
            _chkLaunch.Text = "Open MedOS now";
            _chkLaunch.Location = new Point(28, 300);
            _chkLaunch.Size = new Size(300, 26);
            _chkLaunch.Checked = true;
            _chkLaunch.Font = new Font("Segoe UI", 9.5F);
            page.Controls.Add(_chkLaunch);

            _btnFinish = NewButton("Finish", 28, 386, 160, 40, true);
            _btnFinish.Click += delegate { Finish(); };
            page.Controls.Add(_btnFinish);

            Button openLog = NewButton("Open log folder", 198, 386, 150, 40, false);
            openLog.Click += delegate { OpenLogFolder(); };
            page.Controls.Add(openLog);
            return page;
        }

        // --------------------------------------------------------------
        // Navigation
        // --------------------------------------------------------------
        private void ShowPage(int index)
        {
            for (int i = 0; i < _pages.Length; i++) _pages[i].Visible = i == index;
            _pageIndex = index;
        }

        private void RefreshWelcome()
        {
            if (_installs.Count == 0)
            {
                _lblDetected.Text = "MedOS is not installed on this PC yet.";
                return;
            }
            InstallInfo info = _installs[0];
            string version = string.IsNullOrEmpty(info.Version) ? "" : " " + info.Version;
            _lblDetected.Text = "Found MedOS" + version + " in " + info.Dir + ".";
            if (!_hasPayload)
            {
                _lblDetected.Text += Environment.NewLine +
                    "This copy has no installation payload, so use Download update with a full MedOS-Setup.exe.";
            }
        }

        private void OpenTargetPage()
        {
            if (!_hasPayload)
            {
                MessageBox.Show(this,
                    "This copy of MedOS-Setup.exe has no installation payload." + Environment.NewLine + Environment.NewLine +
                    "Download a complete MedOS-Setup.exe, or copy MedOS-app.7z.001 next to this file.",
                    "MedOS Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            _txtDir.Text = _installs.Count > 0 ? _installs[0].Dir : Detector.DefaultInstallDir();
            _lblExisting.Text = "";
            UpdateSpaceLabel();
            ShowPage(1);
            _txtDir.Focus();
        }

        private void OpenUpdatePage()
        {
            InstallInfo info = _installs.Count > 0 ? _installs[0] : null;
            if (info != null)
            {
                string version = string.IsNullOrEmpty(info.Version) ? "" : " " + info.Version;
                _lblUpdateInfo.Text = "MedOS" + version + " is installed in " + info.Dir +
                    ". Updating keeps your content in data\\, models\\ and exports\\ plus your settings.";
            }
            else
            {
                _lblUpdateInfo.Text = "No existing installation was found. Download or choose a MedOS-Setup.exe to install MedOS.";
            }
            _btnUsePackage.Enabled = _hasPayload;
            if (!_hasPayload) _btnUsePackage.Text = "This copy has no payload";
            _txtUrl.Text = DefaultUpdateUrl();
            ShowPage(2);
        }

        private static string DefaultUpdateUrl()
        {
            try
            {
                string dir = Path.GetDirectoryName(Payload.CurrentExePath());
                string file = Path.Combine(dir, "update-url.txt");
                if (File.Exists(Io.Lp(file)))
                {
                    string[] lines = File.ReadAllLines(Io.Lp(file));
                    if (lines.Length > 0) return lines[0].Trim();
                }
            }
            catch { }
            return "";
        }

        private void BrowseForFolder()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "Choose the folder where MedOS should be installed";
                dialog.ShowNewFolderButton = true;
                string current = _txtDir.Text.Trim();
                if (current.Length > 0)
                {
                    try
                    {
                        string parent = Path.GetDirectoryName(current);
                        if (!string.IsNullOrEmpty(parent) && Directory.Exists(parent)) dialog.SelectedPath = parent;
                    }
                    catch { }
                }
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    string chosen = dialog.SelectedPath.TrimEnd('\\');
                    string leaf = Path.GetFileName(chosen);
                    _txtDir.Text = string.Equals(leaf, "MedOS", StringComparison.OrdinalIgnoreCase)
                        ? chosen
                        : Path.Combine(chosen, "MedOS");
                }
            }
        }

        private void UpdateSpaceLabel()
        {
            string dir = _txtDir.Text.Trim();
            _lblExisting.Text = "";
            if (dir.Length == 0)
            {
                _lblSpace.Text = "";
                return;
            }
            long free = Detector.FreeBytes(dir);
            _lblSpace.Text = free >= 0
                ? "Free space: " + (free / 1073741824.0).ToString("N1") + " GB on this drive."
                : "";
            if (Detector.LooksLikeInstall(dir))
            {
                _lblExisting.Text = "MedOS is already installed here. Its program files will be replaced; " +
                    "your content and settings are kept.";
            }
            else if (Io.DirExists(dir) && HasAnyEntries(dir))
            {
                _lblExisting.Text = "This folder is not empty. MedOS is added next to the existing files.";
            }
        }

        private static bool HasAnyEntries(string dir)
        {
            try { return Directory.GetFileSystemEntries(Io.Lp(dir)).Length > 0; }
            catch { return false; }
        }

        private void BeginNewInstall()
        {
            string target = _txtDir.Text.Trim();
            if (target.Length == 0)
            {
                MessageBox.Show(this, "Choose an install folder first.", "MedOS Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            target = target.TrimEnd('\\');
            string parent;
            try { parent = Path.GetDirectoryName(Path.GetFullPath(target)); }
            catch (Exception ex)
            {
                MessageBox.Show(this, "That folder is not valid: " + ex.Message, "MedOS Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (string.IsNullOrEmpty(parent))
            {
                MessageBox.Show(this, "Choose a folder such as C:\\MedOS, not a drive root.", "MedOS Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!Detector.CanCreateUnder(target))
            {
                MessageBox.Show(this,
                    "MedOS cannot write to " + parent + "." + Environment.NewLine + Environment.NewLine +
                    "Choose a folder in your user profile or another drive.",
                    "MedOS Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            if (Detector.LooksLikeInstall(target))
            {
                DialogResult answer = MessageBox.Show(this,
                    "MedOS is already installed in:" + Environment.NewLine + target + Environment.NewLine + Environment.NewLine +
                    "Replace its program files? Your content (data, models, exports) and settings are kept.",
                    "MedOS Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
            }
            else if (Io.DirExists(target) && HasAnyEntries(target))
            {
                DialogResult answer = MessageBox.Show(this,
                    "The folder is not empty:" + Environment.NewLine + target + Environment.NewLine + Environment.NewLine +
                    "Install MedOS there anyway? Existing files are left in place unless they have the same names.",
                    "MedOS Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
            }

            StartInstall(target, false);
        }

        private void BeginUpdateFromThisPackage()
        {
            InstallInfo info = _installs.Count > 0 ? _installs[0] : null;
            if (info == null)
            {
                OpenTargetPage();
                return;
            }
            DialogResult answer = MessageBox.Show(this,
                "Update MedOS in:" + Environment.NewLine + info.Dir + Environment.NewLine + Environment.NewLine +
                "Your content in data\\, models\\ and exports\\ is kept.",
                "MedOS Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (answer != DialogResult.Yes) return;
            StartInstall(info.Dir, true);
        }

        private void PickUpdatePackage()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "Choose a MedOS-Setup.exe";
                dialog.Filter = "MedOS Setup (MedOS-Setup.exe)|MedOS-Setup.exe|Programs (*.exe)|*.exe|All files (*.*)|*.*";
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                if (ConfirmPackage(dialog.FileName)) RunPackage(dialog.FileName);
            }
        }

        private bool ConfirmPackage(string path)
        {
            long offset;
            long length;
            string sha;
            if (Payload.TryReadFooter(path, out offset, out length, out sha)) return true;

            string dir = Path.GetDirectoryName(path);
            string parts = Path.Combine(dir ?? "", "MedOS-app.7z.001");
            if (File.Exists(Io.Lp(parts))) return true;

            DialogResult answer = MessageBox.Show(this,
                "This file does not look like a MedOS installer." + Environment.NewLine + Environment.NewLine +
                "Run it anyway?", "MedOS Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            return answer == DialogResult.Yes;
        }

        private void RunPackage(string path)
        {
            string target = "";
            if (_installs.Count > 0) target = _installs[0].Dir;
            else if (_options.Dir.Length > 0) target = _options.Dir;

            string arguments = "";
            if (target.Length > 0) arguments = "/update /dir=\"" + target + "\"";
            else arguments = "";

            try
            {
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = path;
                start.Arguments = arguments;
                start.UseShellExecute = true;
                start.WorkingDirectory = Path.GetDirectoryName(path) ?? "";
                Process.Start(start);
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Could not start the installer: " + ex.Message, "MedOS Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void BeginDownload()
        {
            string url = _txtUrl.Text.Trim();
            if (url.Length == 0)
            {
                MessageBox.Show(this, "Paste the download link of a MedOS-Setup.exe first.", "MedOS Setup",
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            _busy = true;
            ShowPage(3);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;
            _log.Text = "";
            SetBusyButtons(false);

            Thread worker = new Thread(delegate()
            {
                string downloaded = null;
                try
                {
                    string path = Path.Combine(Path.GetTempPath(), "MedOS-Setup-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                    Journal.Write("download: " + url);
                    Downloader.Download(url, path, this);
                    downloaded = path;
                    Journal.Write("downloaded: " + path);
                    this.Status("Checking the downloaded installer ...");
                    this.Percent(100);
                    this.Log("  download complete");
                }
                catch (Exception ex)
                {
                    Journal.Write(ex.ToString());
                    string message = ex.Message;
                    OnUi(delegate
                    {
                        _busy = false;
                        SetBusyButtons(true);
                        ShowPage(2);
                        MessageBox.Show(this, message, "MedOS Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    });
                    return;
                }

                OnUi(delegate
                {
                    _busy = false;
                    SetBusyButtons(true);
                    if (ConfirmPackage(downloaded)) RunPackage(downloaded);
                    else ShowPage(2);
                });
            });
            worker.IsBackground = true;
            worker.Name = "MedOS download";
            worker.Start();
        }

        private void SetBusyButtons(bool enabled)
        {
            _btnUsePackage.Enabled = enabled && _hasPayload;
            _btnPickPackage.Enabled = enabled;
            _btnDownload.Enabled = enabled;
            _btnNewInstall.Enabled = enabled;
            _btnUpdate.Enabled = enabled;
            _btnInstall.Enabled = enabled;
        }

        // --------------------------------------------------------------
        // Install
        // --------------------------------------------------------------
        private void StartInstall(string target, bool update)
        {
            _installTarget = target;
            _busy = true;
            ShowPage(3);
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;
            _log.Text = "";
            SetBusyButtons(false);
            Journal.Write("install: target=" + target + " mode=" + (update ? "update" : "new"));

            Thread worker = new Thread(delegate()
            {
                try
                {
                    Installer engine = new Installer(target, update, this);
                    string installed = engine.Run();
                    OnUi(delegate
                    {
                        _busy = false;
                        ShowDone(true, installed, update);
                    });
                }
                catch (Exception ex)
                {
                    Journal.Write(ex.ToString());
                    string message = ex.Message;
                    OnUi(delegate
                    {
                        _busy = false;
                        ShowDone(false, message, update);
                    });
                }
            });
            worker.IsBackground = true;
            worker.Name = "MedOS install";
            worker.Start();
        }

        private void ShowDone(bool success, string detail, bool update)
        {
            ShowPage(4);
            if (success)
            {
                _lblDoneTitle.Text = update ? "MedOS has been updated" : "MedOS is installed";
                _lblDoneDetail.Text =
                    "Version " + BuildInfo.Version + Environment.NewLine +
                    "Folder: " + detail + Environment.NewLine + Environment.NewLine +
                    "A MedOS shortcut is on your desktop and in the Start menu." + Environment.NewLine + Environment.NewLine +
                    "Next: open MedOS and choose your books, media and other content in Content Manager.";
                _chkLaunch.Visible = true;
                _chkLaunch.Checked = true;
                _btnFinish.Text = "Finish";
            }
            else
            {
                _lblDoneTitle.Text = "The installation did not finish";
                _lblDoneDetail.Text = detail + Environment.NewLine + Environment.NewLine +
                    "Details were written to:" + Environment.NewLine + Journal.FilePath;
                _chkLaunch.Visible = false;
                _btnFinish.Text = "Close";
            }
        }

        private void Finish()
        {
            if (!_busy && _chkLaunch.Visible && _chkLaunch.Checked && !string.IsNullOrEmpty(_installTarget))
            {
                TryLaunch(_installTarget);
            }
            Close();
        }

        private static void TryLaunch(string dir)
        {
            try
            {
                string vbs = Path.Combine(dir, "launch.vbs");
                string wscript = Path.Combine(Environment.SystemDirectory, "wscript.exe");
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = wscript;
                start.Arguments = "\"" + vbs + "\"";
                start.UseShellExecute = true;
                start.WorkingDirectory = dir;
                Process.Start(start);
            }
            catch (Exception ex)
            {
                Journal.Write("launch failed: " + ex.Message);
            }
        }

        private void OpenLogFolder()
        {
            try
            {
                Process.Start("explorer.exe", "/select,\"" + Journal.FilePath + "\"");
            }
            catch { }
        }

        private static bool HasLocalPayload()
        {
            long offset;
            long length;
            string sha;
            string exe = Payload.CurrentExePath();
            if (Payload.TryReadFooter(exe, out offset, out length, out sha)) return true;
            try
            {
                string dir = Path.GetDirectoryName(exe);
                return File.Exists(Io.Lp(Path.Combine(dir, "MedOS-app.7z.001"))) ||
                       File.Exists(Io.Lp(Path.Combine(dir, "payload", "MedOS-app.7z.001")));
            }
            catch { return false; }
        }

        // --------------------------------------------------------------
        // ISetupUi
        // --------------------------------------------------------------
        public void Status(string text)
        {
            OnUi(delegate { _lblStatus.Text = text; });
        }

        public void Percent(int value)
        {
            if (value < 0) value = 0;
            if (value > 100) value = 100;
            OnUi(delegate
            {
                if (_bar.Style == ProgressBarStyle.Continuous)
                {
                    try { _bar.Value = value; }
                    catch { }
                }
            });
        }

        public void Marquee(bool enabled)
        {
            OnUi(delegate
            {
                _bar.Style = enabled ? ProgressBarStyle.Marquee : ProgressBarStyle.Continuous;
                if (!enabled) _bar.Value = 0;
            });
        }

        public void Log(string line)
        {
            Journal.Write(line);
            OnUi(delegate
            {
                if (_log.TextLength > 400000) _log.Text = "";
                _log.AppendText(line + Environment.NewLine);
            });
        }

        private void OnUi(Action action)
        {
            if (IsDisposed) return;
            try
            {
                if (InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch (Exception) { }
        }

        // --------------------------------------------------------------
        // Startup and shutdown
        // --------------------------------------------------------------
        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (_options.Mode.Length == 0) return;

            string target = _options.Dir;
            if (string.IsNullOrEmpty(target) && _installs.Count > 0) target = _installs[0].Dir;
            if (string.IsNullOrEmpty(target)) target = Detector.DefaultInstallDir();
            bool update = _options.Mode == "update";

            if (update && !Detector.LooksLikeInstall(target))
            {
                // Nothing to update; fall back to the normal new-install choices.
                _txtDir.Text = target;
                UpdateSpaceLabel();
                ShowPage(1);
                return;
            }
            if (!_hasPayload)
            {
                MessageBox.Show(this,
                    "This copy of MedOS-Setup.exe has no installation payload.",
                    "MedOS Setup", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            StartInstall(target, update);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (_busy && e.CloseReason == CloseReason.UserClosing)
            {
                DialogResult answer = MessageBox.Show(this,
                    "MedOS Setup is still working. Stop it and leave the installation unfinished?",
                    "MedOS Setup", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (answer != DialogResult.Yes) e.Cancel = true;
            }
            base.OnFormClosing(e);
        }
    }
}
