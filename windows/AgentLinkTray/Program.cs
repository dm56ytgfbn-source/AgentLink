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
using System.Text.RegularExpressions;
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
    public static string PositionPath { get { return Path.Combine(Path.GetDirectoryName(ConfigPath), "input-share-position.json"); } }
    public static string RegistryPath { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "AgentLink", "config", "runtime.local.json"); } }

    public static string ReadPosition()
    {
        try
        {
            Dictionary<string, object> data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(PositionPath));
            string position = data.ContainsKey("position") ? Convert.ToString(data["position"]) : "";
            return position == "left" || position == "right" || position == "top" || position == "bottom" ? position : "";
        }
        catch { return ""; }
    }

    public static void SavePosition(string position)
    {
        if (position != "" && position != "left" && position != "right" && position != "top" && position != "bottom") throw new Exception("无效的屏幕位置");
        Directory.CreateDirectory(Path.GetDirectoryName(PositionPath));
        string contents = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "position", position } });
        File.WriteAllText(PositionPath, contents + "\n", new UTF8Encoding(false));
    }

    public static List<PeerChoice> Discover(string root)
    {
        string output = RunPair(root, "pair discover", 15000);
        object[] entries = new JavaScriptSerializer().DeserializeObject(output) as object[];
        List<PeerChoice> peers = new List<PeerChoice>();
        if (entries == null) return peers;
        foreach (object entry in entries)
        {
            Dictionary<string, object> value = entry as Dictionary<string, object>;
            if (value == null || !value.ContainsKey("host") || !value.ContainsKey("name")) continue;
            string host = Convert.ToString(value["host"]);
            if (!ValidHost(host)) continue;
            PeerChoice peer = new PeerChoice();
            peer.Host = host; peer.Name = Convert.ToString(value["name"]);
            peer.DeviceId = value.ContainsKey("device_id") ? Convert.ToString(value["device_id"]) : "";
            peer.Port = value.ContainsKey("port") ? Convert.ToInt32(value["port"]) : 7443;
            peer.Open = value.ContainsKey("pairing_open") && Convert.ToBoolean(value["pairing_open"]);
            if (peer.Port > 0 && peer.Port <= 65535) peers.Add(peer);
        }
        return peers;
    }

    static bool ValidHost(string host)
    {
        return !String.IsNullOrWhiteSpace(host) && host.Length <= 253 && !host.Contains("..")
            && Regex.IsMatch(host, @"^[A-Za-z0-9][A-Za-z0-9.-]*$");
    }

    public static string Pair(string root, string host, int port)
    {
        if (!ValidHost(host) || port < 1 || port > 65535) throw new Exception("请输入有效的局域网地址和端口");
        return RunPair(root, "pair auto --host " + host + " --port " + port, 150000);
    }

    static string RunPair(string root, string arguments, int timeoutMs)
    {
        ProcessStartInfo info = new ProcessStartInfo(NodePath(root));
        info.Arguments = "\"" + CliPath(root) + "\" " + arguments;
        info.UseShellExecute = false; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.CreateNoWindow = true; info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
        using (Process process = Process.Start(info))
        {
            if (!process.WaitForExit(timeoutMs)) { process.Kill(); throw new Exception("等待配对超时，请在对方电脑重新开放连接后重试"); }
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (process.ExitCode != 0) throw new Exception(String.IsNullOrWhiteSpace(error) ? output.Trim() : error.Trim());
            return output.Trim();
        }
    }

    public static List<InputTarget> ReadPairedTargets(string json, string ownId)
    {
        Dictionary<string, object> registry = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);
        // JavaScriptSerializer uses ArrayList inside a typed dictionary, not object[].
        IEnumerable entries = registry.ContainsKey("devices") ? registry["devices"] as IEnumerable : null;
        if (entries == null || registry["devices"] is string) throw new Exception("设备列表格式无效");
        List<InputTarget> targets = new List<InputTarget>();
        HashSet<string> ids = new HashSet<string>();
        foreach (object entry in entries)
        {
            Dictionary<string, object> target = entry as Dictionary<string, object>;
            if (target == null || !target.ContainsKey("name") || !target.ContainsKey("device_id")) continue;
            string id = Convert.ToString(target["device_id"]), name = Convert.ToString(target["name"]);
            if (String.IsNullOrWhiteSpace(id) || String.IsNullOrWhiteSpace(name) || id == ownId || !ids.Add(id)) continue;
            targets.Add(new InputTarget { Id = id, Name = name });
        }
        return targets;
    }

    public static void TestPairedTargets()
    {
        string json = new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "devices", new object[] {
            new Dictionary<string, object> { { "device_id", "self" }, { "name", "My PC" } },
            new Dictionary<string, object> { { "device_id", "peer-one" }, { "name", "Cindy" } },
            new Dictionary<string, object> { { "device_id", "peer-two" }, { "name", "My PC" } }
        } } });
        List<InputTarget> targets = ReadPairedTargets(json, "self");
        if (targets.Count != 2 || targets[0].Id != "peer-one" || targets[0].Name != "Cindy" || targets[1].Id != "peer-two")
            throw new Exception("Paired-list regression: saved peers must populate the sharing selector, excluding only this device ID");
        if (ReadPairedTargets("{\"devices\":[]}", "self").Count != 0) throw new Exception("Empty paired-list regression");
    }

    public static void CheckPaired(string root, string deviceId)
    {
        if (!Regex.IsMatch(deviceId, @"^[a-zA-Z0-9_-]{1,200}$")) throw new Exception("设备标识无效");
        RunPair(root, "computer info " + deviceId, 15000);
    }

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
            result.DeviceId = Convert.ToString(config["device_id"]);
            result.ScreenPosition = ReadPosition();
            try
            {
                if (File.Exists(RegistryPath)) foreach (InputTarget target in ReadPairedTargets(File.ReadAllText(RegistryPath), result.DeviceId))
                {
                    result.TargetNames.Add(target.Name);
                    result.Targets.Add(target);
                }
            }
            catch (Exception error) { result.RegistryError = "配对列表读取失败：" + error.Message; }
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
                result.Version = info.ContainsKey("version") ? Convert.ToString(info["version"]) : "";
                Dictionary<string, object> package = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(root, "package.json")));
                string appVersion = Convert.ToString(package["version"]);
                if (result.Version != appVersion)
                    throw new Exception("窗口版本 " + appVersion + "，后台版本 " + result.Version + "。请退出旧版 AgentLink 后重新打开安装版；配对信息会保留。");
                result.Online = true;
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

    static string InputPreferencePath { get { return Path.Combine(Path.GetDirectoryName(RegistryPath), "input-share.local.json"); } }
    public static string ReadInputPosition(string id)
    {
        try {
            Dictionary<string, object> all = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(InputPreferencePath));
            Dictionary<string, object> item = all.ContainsKey(id) ? all[id] as Dictionary<string, object> : null;
            string value = item != null && item.ContainsKey("position") ? Convert.ToString(item["position"]) : "right";
            return value == "left" || value == "top" || value == "bottom" ? value : "right";
        } catch { return "right"; }
    }
    public static void SaveInputPosition(string id, string position)
    {
        Dictionary<string, object> all = File.Exists(InputPreferencePath)
            ? new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(InputPreferencePath))
            : new Dictionary<string, object>();
        all[id] = new Dictionary<string, object> { { "position", position } };
        Directory.CreateDirectory(Path.GetDirectoryName(InputPreferencePath));
        File.WriteAllText(InputPreferencePath, new JavaScriptSerializer().Serialize(all) + "\n", new UTF8Encoding(false));
    }
    public static ProcessStartInfo InputStartInfo(string root, string deviceId)
    {
        // IDs are data from the paired registry, never command syntax.
        if (!Regex.IsMatch(deviceId, @"^[a-zA-Z0-9_-]{1,200}$")) throw new Exception("配对设备标识无效，请重新配对");
        ProcessStartInfo info = new ProcessStartInfo(NodePath(root));
        info.Arguments = "\"" + Path.Combine(root, "scripts", "start-input-share-windows.mjs") + "\" connect --registry \"" + RegistryPath + "\" --device " + deviceId;
        info.UseShellExecute = false; info.CreateNoWindow = true;
        info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8; info.StandardErrorEncoding = Encoding.UTF8;
        return info;
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

sealed class InputTarget
{
    public string Id;
    public string Name;
    public override string ToString() { return Name; }
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
    public string DeviceId;
    public string ScreenPosition;
    public string RegistryError;
    public List<string> TargetNames = new List<string>();
    public List<InputTarget> Targets = new List<InputTarget>();
}

sealed class PeerChoice
{
    public string DeviceId;
    public string Name;
    public string Host;
    public int Port;
    public bool Open;
    public bool Paired;
    public override string ToString() { return Name + " · " + Host + (Paired ? " · 已配对" : Open ? " · 可连接" : " · 等待对方允许"); }
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
    Button positionButton;
    ComboBox inputTargets;
    ComboBox inputPositions;
    Process inputProcess;
    InputTarget activeInputTarget;
    string inputMessage;
    bool inputStopping;
    bool loadingInputSettings;
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
            text.AppendLine("已配对其他电脑：" + status.TargetNames.Count + " 台" + (status.TargetNames.Count > 0 ? "（" + String.Join("、", status.TargetNames.ToArray()) + "）" : ""));
            text.AppendLine("已保存配对授权：" + status.ClientCount + " 条（" + status.ClientSourceCount + " 个来源，不代表在线数）");
            text.AppendLine("新电脑连接：" + (status.PairingOpen ? "已开放，10 分钟后自动关闭" : "需在此处允许"));
            text.AppendLine("键鼠共享：" + (status.InputShareEnabled && status.InputShareHelperAvailable ? "Windows 端已就绪" : "Windows 端未就绪"));
            text.AppendLine();
            text.AppendLine("可以从这台 Windows 主动添加其他电脑，也可以允许其他电脑连接进来。");
        }
        else text.AppendLine("如果持续未就绪，点“检查并启动服务”。");
        return text.ToString();
    }

    void UpdateConsole(LocalStatus status)
    {
        if (heading == null || heading.IsDisposed) return;
        heading.Text = status.Online ? "这台电脑已就绪" : "连接需要检查";
        statusDetail.Text = status.Online
            ? "本机服务已就绪 · 已配对其他电脑 " + status.TargetNames.Count + " 台"
            : (status.Message ?? "正在检查本机服务…");
        if (inputTargets != null && inputProcess == null)
        {
            InputTarget previous = inputTargets.SelectedItem as InputTarget;
            string selected = previous == null ? null : previous.Id;
            loadingInputSettings = true;
            inputTargets.Items.Clear();
            foreach (InputTarget target in status.Targets) inputTargets.Items.Add(target);
            for (int i = 0; i < inputTargets.Items.Count; i++) if (((InputTarget)inputTargets.Items[i]).Id == selected) inputTargets.SelectedIndex = i;
            if (inputTargets.SelectedIndex < 0 && inputTargets.Items.Count > 0) inputTargets.SelectedIndex = 0;
            loadingInputSettings = false;
            LoadInputPosition();
        }
        if (inputTargets != null && inputProcess != null && inputTargets.Items.Count == 0 && activeInputTarget != null)
        {
            loadingInputSettings = true;
            inputTargets.Items.Add(activeInputTarget); inputTargets.SelectedIndex = 0;
            loadingInputSettings = false; LoadInputPosition();
        }
        RenderInputState();
        if (sharingCard != null && pairedCard != null && moreButton != null)
        {
            sharingCard.Height = 165;
            pairedCard.Top = sharingCard.Bottom + 14;
            moreButton.Top = pairedCard.Bottom + 17;
            technicalPanel.Top = moreButton.Bottom + 6;
            console.ClientSize = new Size(700, (technicalPanel.Visible ? technicalPanel.Bottom : moreButton.Bottom) + 25);
        }
        pairedDetail.Text = status.RegistryError != null ? status.RegistryError : status.TargetNames.Count == 0
            ? "还没有配对其他电脑。点击“添加电脑”开始配对。"
            : "已配对 " + status.TargetNames.Count + " 台：" + String.Join("、", status.TargetNames.ToArray());
        if (consoleText != null && !consoleText.IsDisposed) consoleText.Text = Describe(status);
    }

    static string PositionName(string position)
    {
        if (position == "left") return "左侧";
        if (position == "top") return "上方";
        if (position == "bottom") return "下方";
        return "右侧";
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
        menu.Items.Add(new ToolStripMenuItem("添加其他电脑", null, delegate { OpenConnect(); }));
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
            sharingCard = new Panel(); sharingCard.SetBounds(0, 220, 644, 165); sharingCard.BackColor = Color.White;
            Label sharingTitle = label("键鼠共享", 13, true, ink); sharingTitle.SetBounds(20, 13, 450, 30);
            sharingDetail = label("正在检查…", 9, false, muted); sharingDetail.SetBounds(20, 44, 600, 29);
            inputTargets = new ComboBox(); inputTargets.DropDownStyle = ComboBoxStyle.DropDownList; inputTargets.SetBounds(20, 77, 272, 30);
            inputPositions = new ComboBox(); inputPositions.DropDownStyle = ComboBoxStyle.DropDownList; inputPositions.SetBounds(304, 77, 320, 30);
            inputPositions.Items.AddRange(new object[] { "本机在对方左侧", "本机在对方右侧", "本机在对方上方", "本机在对方下方" });
            inputPositions.SelectedIndex = 1;
            inputTargets.SelectedIndexChanged += delegate { if (!loadingInputSettings) { inputMessage = null; LoadInputPosition(); RenderInputState(); } };
            inputPositions.SelectedIndexChanged += delegate { SaveInputPosition(); };
            sharingButton = button("开始共享", delegate { OpenInputSharing(); }, true); sharingButton.SetBounds(20, 118, 150, 36);
            sharingCard.Controls.Add(sharingTitle); sharingCard.Controls.Add(sharingDetail); sharingCard.Controls.Add(sharingButton);
            sharingCard.Controls.Add(inputTargets); sharingCard.Controls.Add(inputPositions);
            pairedCard = new Panel(); pairedCard.SetBounds(0, 358, 644, 130); pairedCard.BackColor = Color.White;
            Label pairedTitle = label("连接其他电脑", 13, true, ink); pairedTitle.SetBounds(20, 12, 450, 30);
            pairedDetail = label("正在检查…", 9, false, muted); pairedDetail.SetBounds(20, 43, 600, 29);
            Button connect = button("添加电脑", delegate { OpenConnect(); }, true); connect.SetBounds(20, 82, 145, 36);
            Button allow = button("允许别人连接", delegate { OpenPairing(); }, false); allow.SetBounds(177, 82, 145, 36);
            pairedCard.Controls.Add(pairedTitle); pairedCard.Controls.Add(pairedDetail); pairedCard.Controls.Add(connect); pairedCard.Controls.Add(allow);
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
            positionButton = button("接收共享设置", delegate { OpenReceiverSettings(); }, false); positionButton.SetBounds(318, 10, 145, 34);
            technicalPanel.Controls.Add(repair); technicalPanel.Controls.Add(startup); technicalPanel.Controls.Add(positionButton); technicalPanel.Controls.Add(consoleText);
            canvas.Controls.Add(brand); canvas.Controls.Add(tagline); canvas.Controls.Add(state);
            canvas.Controls.Add(sharingCard); canvas.Controls.Add(pairedCard); canvas.Controls.Add(moreButton); canvas.Controls.Add(technicalPanel);
            console.Controls.Add(canvas);
            console.FormClosed += delegate { console = null; consoleText = null; heading = null; statusDetail = null; sharingDetail = null; pairedDetail = null; sharingButton = null; inputTargets = null; inputPositions = null; sharingCard = null; pairedCard = null; moreButton = null; technicalPanel = null; };
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

    void OpenConnect()
    {
        using (Form dialog = new Form())
        {
            dialog.Text = "AgentLink · 添加电脑";
            dialog.ClientSize = new Size(480, 285);
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.MaximizeBox = false; dialog.MinimizeBox = false;
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.Font = new Font("Microsoft YaHei UI", 9f);
            Label hint = new Label(); hint.Text = "已配对电脑可直接检查连接；首次添加才需要对方允许。";
            hint.SetBounds(18, 16, 450, 28); dialog.Controls.Add(hint);
            ListBox peers = new ListBox(); peers.SetBounds(18, 48, 445, 110); dialog.Controls.Add(peers);
            Label addressLabel = new Label(); addressLabel.Text = "找不到？输入对方的局域网 IP 或主机名：";
            addressLabel.SetBounds(18, 169, 445, 23); dialog.Controls.Add(addressLabel);
            TextBox address = new TextBox(); address.SetBounds(18, 194, 300, 26); dialog.Controls.Add(address);
            Label state = new Label(); state.Text = "正在搜索局域网…"; state.SetBounds(18, 232, 315, 40); dialog.Controls.Add(state);
            Button scan = new Button(); scan.Text = "重新搜索"; scan.SetBounds(328, 191, 135, 30); dialog.Controls.Add(scan);
            Button connect = new Button(); connect.Text = "连接"; connect.SetBounds(348, 234, 115, 36); dialog.Controls.Add(connect);

            Action search = delegate
            {
                scan.Enabled = false; state.Text = "正在搜索局域网…";
                ThreadPool.QueueUserWorkItem(delegate
                {
                    List<PeerChoice> found = null; string error = null;
                    try { found = Runtime.Discover(root); }
                    catch (Exception caught) { error = caught.Message; }
                    try { dialog.BeginInvoke((MethodInvoker)delegate
                    {
                        peers.Items.Clear(); scan.Enabled = true;
                        if (found != null) foreach (PeerChoice peer in found)
                        {
                            if (last != null && peer.DeviceId == last.DeviceId) continue;
                            if (last != null) peer.Paired = last.Targets.Exists(target => target.Id == peer.DeviceId);
                            peers.Items.Add(peer);
                            if ((peer.Paired || peer.Open) && peers.SelectedIndex < 0) peers.SelectedItem = peer;
                        }
                        state.Text = error != null ? "搜索失败，可输入地址连接。" : peers.Items.Count == 0
                            ? "未发现电脑。可输入对方 IP；检查局域网防火墙。" : "找到 " + peers.Items.Count + " 台电脑。";
                    }); } catch { }
                });
            };
            Action updateConnect = delegate {
                PeerChoice chosen = peers.SelectedItem as PeerChoice;
                connect.Text = address.Text.Trim().Length == 0 && chosen != null && chosen.Paired ? "检查连接" : "添加电脑";
            };
            peers.SelectedIndexChanged += delegate { updateConnect(); };
            address.TextChanged += delegate { updateConnect(); };
            scan.Click += delegate { search(); };
            dialog.Shown += delegate { search(); };
            connect.Click += delegate
            {
                string host = address.Text.Trim(); int port = 7443;
                PeerChoice selected = peers.SelectedItem as PeerChoice;
                bool alreadyPaired = host.Length == 0 && selected != null && selected.Paired;
                if (host.Length == 0 && selected != null)
                {
                    if (!alreadyPaired && !selected.Open) { MessageBox.Show("请先在「" + selected.Name + "」上允许新电脑连接。", "AgentLink"); return; }
                    host = selected.Host; port = selected.Port;
                }
                if (host.Length == 0) { MessageBox.Show("请选择电脑，或输入对方的局域网地址。", "AgentLink"); return; }
                connect.Enabled = false; scan.Enabled = false; state.Text = alreadyPaired ? "正在验证已有连接…" : "已发出连接请求，请在对方电脑上确认…";
                ThreadPool.QueueUserWorkItem(delegate
                {
                    string error = null;
                    try { if (alreadyPaired) Runtime.CheckPaired(root, selected.DeviceId); else Runtime.Pair(root, host, port); }
                    catch (Exception caught) { error = caught.Message; }
                    try { dialog.BeginInvoke((MethodInvoker)delegate
                    {
                        connect.Enabled = true; scan.Enabled = true;
                        if (error != null) { state.Text = "连接失败：" + error; MessageBox.Show(error, "AgentLink 连接失败"); }
                        else { dialog.Close(); Refresh(); MessageBox.Show(alreadyPaired ? "连接正常。可在主窗口选择这台电脑并开始键鼠共享，无需重复配对。" : "已完成配对。可在主窗口选择这台电脑并开始键鼠共享。", "AgentLink"); }
                    }); } catch { }
                });
            };
            if (console != null && !console.IsDisposed) dialog.ShowDialog(console); else dialog.ShowDialog();
        }
    }

    void OpenScreenPosition()
    {
        using (Form dialog = new Form())
        {
            dialog.Text = "AgentLink · 屏幕位置";
            dialog.ClientSize = new Size(390, 175);
            dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
            dialog.MaximizeBox = false; dialog.MinimizeBox = false;
            dialog.StartPosition = FormStartPosition.CenterParent;
            dialog.Font = new Font("Microsoft YaHei UI", 9f);
            Label hint = new Label(); hint.Text = "由对方发起共享时，对方屏幕在本机的哪一侧";
            hint.SetBounds(18, 18, 350, 28); dialog.Controls.Add(hint);
            ComboBox choices = new ComboBox(); choices.DropDownStyle = ComboBoxStyle.DropDownList;
            choices.SetBounds(18, 52, 350, 30);
            choices.Items.AddRange(new object[] { "跟随发起端设置", "左侧", "右侧", "上方", "下方" });
            string current = Runtime.ReadPosition();
            choices.SelectedIndex = current == "left" ? 1 : current == "right" ? 2 : current == "top" ? 3 : current == "bottom" ? 4 : 0;
            dialog.Controls.Add(choices);
            Label note = new Label(); note.Text = "旧版共享可在此调整；新版请在发起端调整。";
            note.SetBounds(18, 91, 350, 25); dialog.Controls.Add(note);
            Button save = new Button(); save.Text = "保存位置"; save.SetBounds(249, 127, 119, 34); dialog.Controls.Add(save);
            save.Click += delegate
            {
                try
                {
                    string[] positions = { "", "left", "right", "top", "bottom" };
                    Runtime.SavePosition(positions[choices.SelectedIndex]);
                    dialog.Close(); Refresh();
                }
                catch (Exception error) { MessageBox.Show("保存失败：" + error.Message, "AgentLink"); }
            };
            if (console != null && !console.IsDisposed) dialog.ShowDialog(console); else dialog.ShowDialog();
        }
    }

    void RenderInputState()
    {
        if (sharingButton == null || sharingButton.IsDisposed) return;
        bool running = inputProcess != null;
        sharingButton.Text = inputStopping ? "正在停止…" : running ? "停止共享" : "开始共享";
        sharingButton.Enabled = !inputStopping && (running || inputTargets.Items.Count > 0);
        inputTargets.Enabled = !running;
        sharingDetail.Text = inputMessage ?? (inputTargets.Items.Count == 0
            ? "先添加另一台电脑；只需一端开始共享，两边键鼠都能跨屏。"
            : "选好电脑和位置后开始共享。Ctrl+Alt+Esc 随时停止。");
    }

    void LoadInputPosition()
    {
        if (inputTargets == null || inputPositions == null) return;
        InputTarget target = inputTargets.SelectedItem as InputTarget;
        if (target == null) return;
        loadingInputSettings = true;
        string position = Runtime.ReadInputPosition(target.Id);
        inputPositions.SelectedIndex = position == "left" ? 0 : position == "top" ? 2 : position == "bottom" ? 3 : 1;
        loadingInputSettings = false;
    }

    bool SaveInputPosition()
    {
        if (loadingInputSettings || inputTargets == null || inputPositions == null) return true;
        InputTarget target = inputTargets.SelectedItem as InputTarget;
        if (target == null || inputPositions.SelectedIndex < 0) return false;
        try { Runtime.SaveInputPosition(target.Id, new string[] { "left", "right", "top", "bottom" }[inputPositions.SelectedIndex]); return true; }
        catch (Exception error) { inputMessage = "位置保存失败：" + error.Message; RenderInputState(); return false; }
    }

    void StopInputSharing()
    {
        if (inputProcess == null) return;
        inputStopping = true;
        inputMessage = "正在停止共享，恢复两台电脑的本地键鼠…";
        try { inputProcess.StandardInput.WriteLine("stop"); inputProcess.StandardInput.Flush(); inputProcess.StandardInput.Close(); } catch { }
        RenderInputState();
    }

    void OpenInputSharing()
    {
        OpenConsole();
        if (inputProcess != null) { StopInputSharing(); return; }
        InputTarget target = inputTargets.SelectedItem as InputTarget;
        if (target == null) { inputMessage = "先点击“添加电脑”完成配对，再选择要共享的电脑。"; RenderInputState(); return; }
        if (!SaveInputPosition()) return;
        try
        {
            Process process = new Process(); process.StartInfo = Runtime.InputStartInfo(root, target.Id);
            inputMessage = "正在连接 " + target.Name + "…"; inputStopping = false;
            string lastMessage = "";
            DataReceivedEventHandler receive = delegate(object sender, DataReceivedEventArgs e)
            {
                if (String.IsNullOrWhiteSpace(e.Data)) return;
                string message = e.Data;
                if (message.StartsWith("{"))
                {
                    try {
                        Dictionary<string, object> item = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(message);
                        if (!item.ContainsKey("type") || Convert.ToString(item["type"]) != "input-focus") return;
                        message = "正在与 " + target.Name + " 共享 · 鼠标推向相邻屏幕边缘即可跨屏";
                    } catch { return; }
                }
                if (message.StartsWith("Input sharing stopped: ")) message = "共享已结束：" + message.Substring(23);
                if (message.Contains("input-sharing-already-active")) message = "已有键鼠共享正在使用本机，请先停止另一处共享。";
                if (message.Contains("HTTP 403")) message = "对方尚未开启接收键鼠，请在对方的“诊断与设置”中配置接收共享。";
                if (message.Contains("HTTP 409")) message = "对方正在共享键鼠，请先停止原来的共享。";
                lastMessage = message.Length > 250 ? message.Substring(0, 250) : message;
                string display = lastMessage;
                try { dispatcher.BeginInvoke((MethodInvoker)delegate { if (inputProcess == process && !inputStopping) { inputMessage = display; RenderInputState(); } }); } catch { }
            };
            process.OutputDataReceived += receive; process.ErrorDataReceived += receive;
            process.Start(); inputProcess = process; activeInputTarget = target;
            process.BeginOutputReadLine(); process.BeginErrorReadLine(); RenderInputState();
            ThreadPool.QueueUserWorkItem(delegate
            {
                process.WaitForExit();
                int code = process.ExitCode;
                try { dispatcher.BeginInvoke((MethodInvoker)delegate
                {
                    if (inputProcess != process) { process.Dispose(); return; }
                    inputMessage = inputStopping ? "共享已停止，两台电脑已恢复本地键鼠。" : String.IsNullOrEmpty(lastMessage) ? "共享已结束（" + code + "）。" : lastMessage;
                    inputProcess = null; activeInputTarget = null; inputStopping = false; process.Dispose(); if (last != null) UpdateConsole(last); else RenderInputState();
                }); } catch { process.Dispose(); }
            });
        }
        catch (Exception error) { inputProcess = null; inputMessage = "无法开始共享：" + error.Message; RenderInputState(); }
    }

    void OpenReceiverSettings()
    {
        if (last != null && last.InputShareEnabled && last.InputShareHelperAvailable) { OpenScreenPosition(); return; }
        ThreadPool.QueueUserWorkItem(delegate
        {
            string message;
            try { Runtime.PrepareInputSharing(root); message = "接收共享已配置，约 1 秒后生效。由已配对的电脑发起共享即可；旧版后台需先升级。"; }
            catch (Exception error) { message = "配置失败：" + error.Message; }
            try { dispatcher.BeginInvoke((MethodInvoker)delegate { inputMessage = message; RenderInputState(); Refresh(); }); } catch { }
        });
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { StopInputSharing(); icon.Visible = false; icon.Dispose(); menu.Dispose(); timer.Dispose(); pairingTimer.Dispose(); signalTimer.Dispose(); dispatcher.Dispose(); }
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
                Runtime.TestPairedTargets();
                LocalStatus status = Runtime.Local(root);
                Console.WriteLine("SELFTEST OK runtime=" + root);
                Console.WriteLine("  node=" + Runtime.NodePath(root));
                Console.WriteLine("  service=" + (status.Online ? "ready" : "unavailable") + " name=" + status.Name
                    + " pairing_records=" + status.ClientCount + " sources=" + status.ClientSourceCount
                    + " input_share=" + (status.InputShareEnabled && status.InputShareHelperAvailable ? "ready" : "unavailable"));
                Console.WriteLine("  outgoing_peers=" + status.Targets.Count + " names=" + String.Join(",", status.TargetNames.ToArray()));
                Console.WriteLine("  paired_list_regression=passed");
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
