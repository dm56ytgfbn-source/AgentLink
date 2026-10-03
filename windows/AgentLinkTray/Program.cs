using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Collections;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using Microsoft.Win32;

// AgentLink tray app (M2b shell). It is a thin, honest client of the same runtime the CLI,
// the Mac app and every AI agent use: it runs "agentlink status" and renders the result.
// No protocol, trust or policy logic is duplicated here.

static class Runtime
{
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle, int command);

    public static void HideConsole()
    {
        IntPtr handle = GetConsoleWindow();
        if (handle != IntPtr.Zero) ShowWindow(handle, 0);
    }

    public static string Find()
    {
        string fromEnvironment = Environment.GetEnvironmentVariable("AGENTLINK_RUNTIME_ROOT");
        if (IsRuntime(fromEnvironment)) return fromEnvironment;
        string bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime");
        if (IsRuntime(bundled)) return bundled;
        string besideExe = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime-root.txt");
        if (File.Exists(besideExe))
        {
            string candidate = File.ReadAllText(besideExe).Trim();
            if (IsRuntime(candidate)) return candidate;
        }
        // Walk up from the executable: a source checkout keeps the app in build\windows.
        string directory = AppDomain.CurrentDomain.BaseDirectory;
        for (int depth = 0; depth < 4 && directory != null; depth++)
        {
            if (IsRuntime(directory)) return directory;
            directory = Path.GetDirectoryName(directory.TrimEnd(Path.DirectorySeparatorChar));
        }
        return null;
    }

    static bool IsRuntime(string root)
    {
        return !String.IsNullOrEmpty(root) && File.Exists(CliPath(root));
    }

    public static string CliPath(string root) { return Path.Combine(root, "dist", "apps", "runtime", "cli.js"); }

    public static string NodePath(string root)
    {
        string configured = Environment.GetEnvironmentVariable("AGENTLINK_NODE");
        if (!String.IsNullOrEmpty(configured) && File.Exists(configured)) return configured;
        string bundled = Path.Combine(root, "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string folder in path.Split(';'))
        {
            if (folder.Length == 0) continue;
            try
            {
                string candidate = Path.Combine(folder.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        string[] known = { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe") };
        foreach (string candidate in known) if (File.Exists(candidate)) return candidate;
        return "node.exe";
    }

    public static string Run(string root, string arguments, out int exitCode)
    {
        ProcessStartInfo info = new ProcessStartInfo(NodePath(root));
        info.Arguments = "\"" + CliPath(root) + "\" " + arguments;
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.EnvironmentVariables["AGENTLINK_SESSION"] = Environment.GetEnvironmentVariable("AGENTLINK_SESSION") ?? "agentlink-tray";
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            process.WaitForExit(30000);
            exitCode = process.HasExited ? process.ExitCode : -1;
            return output;
        }
    }

    public static Dictionary<string, object> Status(string root)
    {
        int exitCode;
        string output = Run(root, "status", out exitCode);
        if (String.IsNullOrWhiteSpace(output)) throw new Exception("status produced no output (exit " + exitCode + ")");
        return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output);
    }

    public static string ConfigPath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".agentlink-node", "node.local.json"); } }

    public static LocalStatus Local(string root)
    {
        LocalStatus result = new LocalStatus();
        result.Name = Environment.MachineName;
        result.ConfigPath = ConfigPath;
        if (!File.Exists(ConfigPath)) { result.Message = "首次启动中，正在创建这台电脑的身份。"; return result; }
        try
        {
            Dictionary<string, object> config = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigPath));
            result.Name = Convert.ToString(config["name"]);
            result.Port = Convert.ToInt32(config["port"]);
            if (config.ContainsKey("input_share"))
            {
                Dictionary<string, object> sharing = config["input_share"] as Dictionary<string, object>;
                if (sharing != null)
                {
                    result.InputShareEnabled = sharing.ContainsKey("enabled") && Convert.ToBoolean(sharing["enabled"]);
                    string helper = sharing.ContainsKey("helper") ? Convert.ToString(sharing["helper"]) : "";
                    result.InputShareHelperAvailable = !String.IsNullOrWhiteSpace(helper) && File.Exists(helper);
                }
            }
            string clients = Path.Combine(Path.GetDirectoryName(ConfigPath), "paired-clients.json");
            if (File.Exists(clients))
            {
                object[] entries = new JavaScriptSerializer().Deserialize<object[]>(File.ReadAllText(clients));
                result.ClientCount = entries == null ? 0 : entries.Length;
                HashSet<string> sources = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (entries != null) foreach (object entry in entries)
                {
                    Dictionary<string, object> client = entry as Dictionary<string, object>;
                    if (client != null && client.ContainsKey("name")) sources.Add(Convert.ToString(client["name"]));
                }
                result.ClientSourceCount = sources.Count;
            }
            string pem = File.ReadAllText(Convert.ToString(config["cert"]));
            string base64 = pem.Replace("-----BEGIN CERTIFICATE-----", "").Replace("-----END CERTIFICATE-----", "").Replace("\r", "").Replace("\n", "").Trim();
            X509Certificate2 expected = new X509Certificate2(Convert.FromBase64String(base64));
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://127.0.0.1:" + result.Port + "/pair/info");
            request.Timeout = 1800;
            request.ReadWriteTimeout = 1800;
            request.Proxy = null;
            request.ServerCertificateValidationCallback = delegate(object sender, X509Certificate certificate, System.Security.Cryptography.X509Certificates.X509Chain chain, System.Net.Security.SslPolicyErrors errors)
            {
                return certificate != null && StructuralComparisons.StructuralEqualityComparer.Equals(certificate.GetRawCertData(), expected.RawData);
            };
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                Dictionary<string, object> info = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                if (Convert.ToString(info["device_id"]) != Convert.ToString(config["device_id"])) throw new Exception("服务身份与本机配置不一致");
                result.Online = true;
                result.Version = info.ContainsKey("version") ? Convert.ToString(info["version"]) : "";
                result.PairingOpen = info.ContainsKey("pairing_open") && Convert.ToBoolean(info["pairing_open"]);
                result.Message = "已就绪，可供已配对的 Agent 使用。";
            }
        }
        catch (Exception error) { result.Message = "服务未就绪：" + error.Message; }
        return result;
    }

    public static string Ensure(string root)
    {
        string script = Path.Combine(root, "scripts", "windows-launch.mjs");
        if (!File.Exists(script)) throw new Exception("运行时缺少启动组件");
        ProcessStartInfo info = new ProcessStartInfo(NodePath(root));
        info.Arguments = "\"" + script + "\" --ensure";
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(30000)) { process.Kill(); throw new Exception("启动超时"); }
            if (process.ExitCode != 0) throw new Exception(String.IsNullOrWhiteSpace(error) ? output : error);
            return output.Trim();
        }
    }

    public static string EnableStartup()
    {
        string executable = Application.ExecutablePath;
        string command = "\"" + executable + "\"";
        string runPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        using (RegistryKey key = Registry.CurrentUser.CreateSubKey(runPath))
        {
            string existing = Convert.ToString(key.GetValue("AgentLink"));
            if (!String.IsNullOrEmpty(existing) && !String.Equals(existing, command, StringComparison.OrdinalIgnoreCase))
                throw new Exception("已有另一份 AgentLink 开机项，请先检查安装位置；原设置未改动。");
        }
        string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
        string[] oldNames = { "AgentLink-User-Supervisor.lnk", "AgentLink-User-Supervisor-RC1.lnk" };
        List<KeyValuePair<string, string>> moved = new List<KeyValuePair<string, string>>();
        try
        {
            foreach (string name in oldNames)
            {
                string from = Path.Combine(startup, name);
                if (!File.Exists(from)) continue;
                string backup = Path.Combine(Path.GetDirectoryName(ConfigPath), "Backups", "startup", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + name);
                Directory.CreateDirectory(Path.GetDirectoryName(backup));
                if (File.Exists(backup)) throw new Exception("启动项备份已存在：" + backup);
                File.Move(from, backup);
                moved.Add(new KeyValuePair<string, string>(from, backup));
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(runPath)) key.SetValue("AgentLink", command, RegistryValueKind.String);
        }
        catch
        {
            foreach (KeyValuePair<string, string> item in moved) if (File.Exists(item.Value) && !File.Exists(item.Key)) File.Move(item.Value, item.Key);
            throw;
        }
        return moved.Count == 0 ? "已设置登录后自动启动。" : "已设置登录后自动启动；旧启动项已移入备份。";
    }

    public static string PrepareInputSharing(string root)
    {
        string script = Path.Combine(root, "scripts", "windows-input-share.mjs");
        if (!File.Exists(script)) throw new Exception("运行时缺少键鼠共享组件");
        ProcessStartInfo info = new ProcessStartInfo(NodePath(root));
        info.Arguments = "\"" + script + "\"";
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        using (Process process = Process.Start(info))
        {
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(60000)) { process.Kill(); throw new Exception("准备键鼠共享超时"); }
            if (process.ExitCode != 0) throw new Exception(String.IsNullOrWhiteSpace(error) ? output : error);
            return output;
        }
    }
}

sealed class LocalStatus
{
    public string Name;
    public int Port;
    public bool Online;
    public bool PairingOpen;
    public int ClientCount;
    public int ClientSourceCount;
    public bool InputShareEnabled;
    public bool InputShareHelperAvailable;
    public string Version;
    public string Message;
    public string ConfigPath;
}

sealed class TrayApp : ApplicationContext
{
    readonly string root;
    readonly EventWaitHandle showSignal;
    readonly NotifyIcon icon = new NotifyIcon();
    readonly ContextMenuStrip menu = new ContextMenuStrip();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer pairingTimer = new System.Windows.Forms.Timer();
    readonly System.Windows.Forms.Timer signalTimer = new System.Windows.Forms.Timer();
    readonly Control dispatcher = new Control();
    readonly HashSet<string> seenRequests = new HashSet<string>();
    Form console;
    TextBox consoleText;
    Label heading;
    Label statusDetail;
    Label sharingDetail;
    Label pairedDetail;
    Button sharingButton;
    Panel sharingCard;
    Panel pairedCard;
    Button moreButton;
    Panel technicalPanel;
    bool busy;
    bool starting;
    string headline = "AgentLink";
    LocalStatus last;

    public TrayApp(string root, EventWaitHandle showSignal)
    {
        this.root = root;
        this.showSignal = showSignal;
        IntPtr handle = dispatcher.Handle;
        icon.Icon = SystemIcons.Application;
        icon.Text = "AgentLink";
        icon.Visible = true;
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += delegate { OpenConsole(); };
        timer.Interval = 30000;
        timer.Tick += delegate { Refresh(); };
        timer.Start();
        pairingTimer.Interval = 2000;
        pairingTimer.Tick += delegate { PollPairing(); };
        pairingTimer.Start();
        signalTimer.Interval = 500;
        signalTimer.Tick += delegate { if (showSignal.WaitOne(0)) OpenConsole(); };
        signalTimer.Start();
        OpenConsole();
        Refresh();
        EnsureService();
    }

    void Refresh()
    {
        if (busy) return;
        busy = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            LocalStatus status = Runtime.Local(root);
            try { dispatcher.BeginInvoke((MethodInvoker)delegate
            {
                busy = false;
                last = status;
                headline = status.Online ? "AgentLink · 已就绪" : "AgentLink · 等待服务";
                icon.Text = headline;
                UpdateConsole(status);
                BuildMenu();
            }); }
            catch { busy = false; }
        });
    }

    static string Describe(LocalStatus status)
    {
        StringBuilder text = new StringBuilder();
        text.AppendLine(status.Message ?? "正在检查…");
        text.AppendLine();
        text.AppendLine("电脑：" + status.Name);
        if (status.Online)
        {
            text.AppendLine("已保存配对授权：" + status.ClientCount + " 条（" + status.ClientSourceCount + " 个来源，不代表在线数）");
            text.AppendLine("新电脑连接：" + (status.PairingOpen ? "已开放，10 分钟后自动关闭" : "需在此处允许"));
            text.AppendLine("键鼠共享：" + (status.InputShareEnabled && status.InputShareHelperAvailable ? "Windows 端已就绪" : "Windows 端未就绪"));
            text.AppendLine();
            text.AppendLine("在 Mac 的 AgentLink 中选择这台电脑；以后开机后会自动恢复连接。");
        }
        else text.AppendLine("如果持续未就绪，点“检查并启动服务”。");
        return text.ToString();
    }

    void UpdateConsole(LocalStatus status)
    {
        if (heading == null || heading.IsDisposed) return;
        heading.Text = status.Online ? "这台电脑已就绪" : "正在启动连接";
        statusDetail.Text = status.Online
            ? "Mac 或其他 Agent 可以直接连接到 " + status.Name + "。开机后会自动恢复。"
            : (status.Message ?? "正在检查本机服务…");
        sharingDetail.Text = status.InputShareEnabled && status.InputShareHelperAvailable
            ? "已就绪。回到 Mac 的 AgentLink，直接点“开启共享”。"
            : "键鼠共享尚未准备好。点击下方按钮检查配置。";
        bool sharingReady = status.InputShareEnabled && status.InputShareHelperAvailable;
        if (sharingButton != null && !sharingButton.IsDisposed) sharingButton.Visible = !sharingReady;
        if (sharingCard != null && pairedCard != null && moreButton != null)
        {
            sharingCard.Height = sharingReady ? 92 : 124;
            pairedCard.Top = sharingCard.Bottom + 14;
            moreButton.Top = pairedCard.Bottom + 17;
            technicalPanel.Top = moreButton.Bottom + 6;
            console.ClientSize = new Size(700, (technicalPanel.Visible ? technicalPanel.Bottom : moreButton.Bottom) + 25);
        }
        pairedDetail.Text = status.ClientSourceCount == 0
            ? "还没有其他电脑连接。首次使用时，点击“允许新电脑连接”。"
            : "已授权 " + status.ClientSourceCount + " 个来源，保存了 " + status.ClientCount + " 条记录。记录数不是在线电脑数。";
        if (consoleText != null && !consoleText.IsDisposed) consoleText.Text = Describe(status);
    }

    void EnsureService()
    {
        if (starting || (last != null && last.Online)) return;
        starting = true;
        ThreadPool.QueueUserWorkItem(delegate
        {
            string error = null;
            try
            {
                Runtime.Ensure(root);
            }
            catch (Exception caught) { error = caught.Message; }
            try { dispatcher.BeginInvoke((MethodInvoker)delegate
            {
                starting = false;
                if (error != null && consoleText != null && !consoleText.IsDisposed) consoleText.Text = "启动失败：" + error;
                else Refresh();
            }); }
            catch { starting = false; }
        });
    }

    void OpenPairing()
    {
        if (last == null || !last.Online)
        {
            MessageBox.Show("请先等服务显示“已就绪”。", "AgentLink");
            return;
        }
        try
        {
            File.WriteAllText(Path.Combine(Path.GetDirectoryName(Runtime.ConfigPath), "PAIRING_OPEN"), "");
            MessageBox.Show("已开放新电脑连接 10 分钟。请在另一台电脑的 AgentLink 点“连接新电脑”。申请到达时，这里会弹出确认。", "AgentLink");
            Refresh();
        }
        catch (Exception error) { MessageBox.Show("无法开放连接：" + error.Message, "AgentLink"); }
    }

    void PollPairing()
    {
        if (last == null || !last.Online || !last.PairingOpen) return;
        string directory = Path.Combine(Path.GetDirectoryName(Runtime.ConfigPath), "pairing-requests");
        if (!Directory.Exists(directory)) return;
        foreach (string file in Directory.GetFiles(directory, "*.json"))
        {
            string id = Path.GetFileNameWithoutExtension(file);
            if (id.Length != 48 || seenRequests.Contains(id)) continue;
            bool valid = true;
            foreach (char c in id) if (!Uri.IsHexDigit(c) || Char.IsUpper(c)) valid = false;
            if (!valid) continue;
            seenRequests.Add(id);
            try
            {
                Dictionary<string, object> request = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                if (Convert.ToString(request["pending_id"]) != id || Convert.ToDouble(request["expires"]) <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) continue;
                string name = Convert.ToString(request["name"]);
                if (String.IsNullOrWhiteSpace(name)) continue;
                if (name.Length > 200) name = name.Substring(0, 200);
                DialogResult decision = MessageBox.Show("电脑「" + name + "」申请连接这台电脑。\n\n这是你认识的电脑吗？", "AgentLink 连接确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (decision != DialogResult.Yes || Convert.ToDouble(request["expires"]) <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) continue;
                string approvals = Path.Combine(Path.GetDirectoryName(Runtime.ConfigPath), "pairing-approvals");
                Directory.CreateDirectory(approvals);
                using (new FileStream(Path.Combine(approvals, id + ".approved"), FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
                Refresh();
            }
            catch { /* A stale or malformed request cannot grant access. */ }
        }
    }

    void BuildMenu()
    {
        menu.Items.Clear();
        ToolStripMenuItem header = new ToolStripMenuItem(headline);
        header.Enabled = false;
        menu.Items.Add(header);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("打开 AgentLink", null, delegate { OpenConsole(); }));
        menu.Items.Add(new ToolStripMenuItem("刷新", null, delegate { Refresh(); }));
        menu.Items.Add(new ToolStripMenuItem("允许新电脑连接", null, delegate { OpenPairing(); }));
        menu.Items.Add(new ToolStripMenuItem("键鼠共享", null, delegate { OpenInputSharing(); }));
        menu.Items.Add(new ToolStripMenuItem("开机自动连接", null, delegate { EnableStartup(); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("打开配置目录", null, delegate { OpenFolder("config"); }));
        menu.Items.Add(new ToolStripMenuItem("复制 Agent 接入信息", null, delegate { CopyEntry(); }));
        menu.Items.Add(new ToolStripMenuItem("检查并启动服务", null, delegate { EnsureService(); }));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("退出界面（后台继续运行）", null, delegate { ExitThread(); }));
    }

    void OpenConsole()
    {
        if (console == null || console.IsDisposed)
        {
            console = new Form();
            console.Text = "AgentLink";
            console.ClientSize = new Size(700, 580);
            console.MinimumSize = new Size(650, 540);
            console.StartPosition = FormStartPosition.CenterScreen;
            console.BackColor = Color.FromArgb(239, 244, 246);
            console.Font = new Font("Microsoft YaHei UI", 9f);
            Color ink = Color.FromArgb(25, 41, 51);
            Color muted = Color.FromArgb(96, 114, 124);
            Color teal = Color.FromArgb(23, 105, 112);
            Func<string, int, bool, Color, Label> label = (value, size, bold, color) => {
                Label result = new Label(); result.Text = value; result.ForeColor = color;
                result.Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular);
                result.AutoSize = false; result.TextAlign = ContentAlignment.MiddleLeft; return result;
            };
            Func<string, EventHandler, bool, Button> button = (value, click, primary) => {
                Button result = new Button(); result.Text = value; result.AutoSize = false;
                result.Width = value.Length > 9 ? 150 : 112; result.Height = 36;
                result.FlatStyle = FlatStyle.Flat; result.FlatAppearance.BorderSize = primary ? 0 : 1;
                result.FlatAppearance.BorderColor = Color.FromArgb(210, 225, 229);
                result.BackColor = primary ? teal : Color.White; result.ForeColor = primary ? Color.White : ink;
                result.Cursor = Cursors.Hand; result.Click += click; return result;
            };
            Panel canvas = new Panel(); canvas.Dock = DockStyle.Fill; canvas.Padding = new Padding(28, 25, 28, 25);
            Label brand = label("AgentLink", 21, true, ink); brand.SetBounds(0, 0, 360, 40);
            Label tagline = label("你的电脑，始终连在一起。", 9, false, muted); tagline.SetBounds(0, 38, 500, 25);
            Panel state = new Panel(); state.SetBounds(0, 82, 644, 124); state.BackColor = Color.FromArgb(229, 245, 241);
            Label eyebrow = label("连接状态", 9, true, teal); eyebrow.SetBounds(20, 12, 250, 24);
            heading = label("正在检查这台电脑", 19, true, ink); heading.SetBounds(20, 39, 590, 40);
            statusDetail = label("正在检查本机服务…", 9, false, muted); statusDetail.SetBounds(20, 85, 600, 25);
            state.Controls.Add(eyebrow); state.Controls.Add(heading); state.Controls.Add(statusDetail);
            sharingCard = new Panel(); sharingCard.SetBounds(0, 220, 644, 124); sharingCard.BackColor = Color.White;
            Label sharingTitle = label("键鼠共享", 13, true, ink); sharingTitle.SetBounds(20, 13, 450, 30);
            sharingDetail = label("正在检查…", 9, false, muted); sharingDetail.SetBounds(20, 44, 600, 29);
            sharingButton = button("配置键鼠共享", delegate { OpenInputSharing(); }, true); sharingButton.SetBounds(20, 78, 150, 36);
            sharingCard.Controls.Add(sharingTitle); sharingCard.Controls.Add(sharingDetail); sharingCard.Controls.Add(sharingButton);
            pairedCard = new Panel(); pairedCard.SetBounds(0, 358, 644, 130); pairedCard.BackColor = Color.White;
            Label pairedTitle = label("连接其他电脑", 13, true, ink); pairedTitle.SetBounds(20, 12, 450, 30);
            pairedDetail = label("正在检查…", 9, false, muted); pairedDetail.SetBounds(20, 43, 600, 29);
            Button connect = button("允许新电脑连接", delegate { OpenPairing(); }, true); connect.SetBounds(20, 82, 155, 36);
            Button refresh = button("刷新", delegate { Refresh(); }, false); refresh.SetBounds(184, 82, 92, 36);
            pairedCard.Controls.Add(pairedTitle); pairedCard.Controls.Add(pairedDetail); pairedCard.Controls.Add(connect); pairedCard.Controls.Add(refresh);
            moreButton = button("诊断与设置", delegate { technicalPanel.Visible = !technicalPanel.Visible; console.ClientSize = new Size(700, (technicalPanel.Visible ? technicalPanel.Bottom : moreButton.Bottom) + 25); }, false);
            moreButton.SetBounds(0, 505, 140, 34);
            technicalPanel = new Panel(); technicalPanel.SetBounds(0, 545, 644, 150); technicalPanel.BackColor = Color.White; technicalPanel.Visible = false;
            Button repair = button("检查并启动服务", delegate { EnsureService(); }, false); repair.SetBounds(12, 10, 150, 34);
            Button startup = button("开机自动连接", delegate { EnableStartup(); }, false); startup.SetBounds(170, 10, 140, 34);
            consoleText = new TextBox();
            consoleText.Multiline = true;
            consoleText.ReadOnly = true;
            consoleText.ScrollBars = ScrollBars.Vertical;
            consoleText.SetBounds(12, 54, 620, 85);
            consoleText.Font = new Font("Microsoft YaHei UI", 9f);
            consoleText.BackColor = Color.White;
            consoleText.BorderStyle = BorderStyle.None;
            technicalPanel.Controls.Add(repair); technicalPanel.Controls.Add(startup); technicalPanel.Controls.Add(consoleText);
            canvas.Controls.Add(brand); canvas.Controls.Add(tagline); canvas.Controls.Add(state);
            canvas.Controls.Add(sharingCard); canvas.Controls.Add(pairedCard); canvas.Controls.Add(moreButton); canvas.Controls.Add(technicalPanel);
            console.Controls.Add(canvas);
            console.FormClosed += delegate { console = null; consoleText = null; heading = null; statusDetail = null; sharingDetail = null; pairedDetail = null; sharingButton = null; sharingCard = null; pairedCard = null; moreButton = null; technicalPanel = null; };
        }
        console.Show();
        console.BringToFront();
        if (last != null)
        {
            UpdateConsole(last);
        }
        else Refresh();
    }

    void OpenFolder(string name)
    {
        try
        {
            string target = Path.GetDirectoryName(Runtime.ConfigPath);
            if (Directory.Exists(target)) { Process.Start("explorer.exe", "\"" + target + "\""); return; }
        }
        catch { }
        MessageBox.Show("请先运行一次 status 以生成目录信息。", "AgentLink");
    }

    void CopyEntry()
    {
        try
        {
            int exitCode;
            string snippet = Runtime.Run(root, "agent snippet", out exitCode);
            if (exitCode != 0 || String.IsNullOrWhiteSpace(snippet)) throw new Exception("运行时未生成接入信息");
            Clipboard.SetText(snippet);
            MessageBox.Show("已复制 Agent 接入配置到剪贴板。", "AgentLink");
        }
        catch (Exception error) { MessageBox.Show("复制失败：" + error.Message, "AgentLink"); }
    }

    void EnableStartup()
    {
        try { MessageBox.Show(Runtime.EnableStartup(), "AgentLink"); }
        catch (Exception error) { MessageBox.Show("设置失败：" + error.Message, "AgentLink"); }
    }

    void OpenInputSharing()
    {
        if (last == null) { Refresh(); MessageBox.Show("正在读取键鼠共享状态，请稍后再试。", "AgentLink"); return; }
        if (last.InputShareEnabled && last.InputShareHelperAvailable)
        {
            OpenConsole();
            return;
        }
        if (MessageBox.Show("Windows 端尚未准备好键鼠共享。现在配置本机辅助程序吗？完成后需要重新启动 AgentLink 服务才能生效。", "AgentLink 键鼠共享", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            string message;
            try { Runtime.PrepareInputSharing(root); message = "Windows 端已配置。重新启动 AgentLink 服务后，在 Mac 的 AgentLink 设置中点击“开启键鼠共享”。"; }
            catch (Exception error) { message = "配置失败：" + error.Message; }
            try { dispatcher.BeginInvoke((MethodInvoker)delegate { MessageBox.Show(message, "AgentLink 键鼠共享"); Refresh(); }); }
            catch { }
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { icon.Visible = false; icon.Dispose(); menu.Dispose(); timer.Dispose(); pairingTimer.Dispose(); signalTimer.Dispose(); dispatcher.Dispose(); }
        base.Dispose(disposing);
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        string root = Runtime.Find();
        if (Array.IndexOf(args, "--selftest") >= 0 || Array.IndexOf(args, "--status") >= 0)
        {
            if (root == null)
            {
                Console.Error.WriteLine("SELFTEST FAIL: runtime not found. Set AGENTLINK_RUNTIME_ROOT to the agentlink folder.");
                Environment.Exit(1);
            }
            try
            {
                LocalStatus status = Runtime.Local(root);
                Console.WriteLine("SELFTEST OK runtime=" + root);
                Console.WriteLine("  node=" + Runtime.NodePath(root));
                Console.WriteLine("  service=" + (status.Online ? "ready" : "unavailable") + " name=" + status.Name
                    + " pairing_records=" + status.ClientCount + " sources=" + status.ClientSourceCount
                    + " input_share=" + (status.InputShareEnabled && status.InputShareHelperAvailable ? "ready" : "unavailable"));
                Console.WriteLine("  " + status.Message);
                Environment.Exit(0);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("SELFTEST FAIL: " + error.Message);
                Environment.Exit(1);
            }
        }
        if (root == null)
        {
            MessageBox.Show("未找到 AgentLink 运行时。请把 runtime-root.txt 放在本程序旁边，或设置 AGENTLINK_RUNTIME_ROOT 环境变量。", "AgentLink");
            return;
        }
        bool first;
        using (Mutex mutex = new Mutex(true, "Local\\AgentLinkApp", out first))
        {
            if (!first)
            {
                try { using (EventWaitHandle existing = EventWaitHandle.OpenExisting("Local\\AgentLinkShow")) existing.Set(); }
                catch { }
                return;
            }
            using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AgentLinkShow"))
            {
                Runtime.HideConsole();
                Application.EnableVisualStyles();
                Application.Run(new TrayApp(root, show));
            }
        }
    }
}
