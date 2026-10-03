import AppKit
import WebKit

// AgentLink menu bar app (M2 shell). It is a thin, honest client of the same runtime the
// CLI and every AI agent use: it never re-implements protocol or trust logic, it only
// renders "agentlink status" and offers the actions a person needs.

struct RegistryInfo: Decodable { let file: String; let error: String?; let count: Int }
struct DeviceInfo: Decodable {
    let name: String
    let online: Bool
    let latency_ms: Double?
    let error_code: String?
    let summary: String?
    let next_action: String?
    let os: String?
}
struct BridgeInfo: Decodable {
    let configured: Bool
    let running: Bool?
    let port: Int?
    let mount: String?
    let mount_path: String?
    let supervisor_ready: Bool?
}
struct PathsInfo: Decodable { let home: String; let config: String; let state: String }
struct StatusInfo: Decodable {
    let generated_at: String
    let paths: PathsInfo
    let registry: RegistryInfo
    let devices: [DeviceInfo]
    let bridge: BridgeInfo
}

struct Runtime {
    let executable: String
    let prefix: [String]
    let root: String
    var cli: String { root + "/dist/apps/runtime/cli.js" }

    static func locate() -> Runtime? {
        var root = ProcessInfo.processInfo.environment["AGENTLINK_RUNTIME_ROOT"]
        var node = ProcessInfo.processInfo.environment["AGENTLINK_NODE"]
        if root == nil, let url = Bundle.main.url(forResource: "runtime", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            // A packaged app stores bundle-relative paths, so the .app keeps working after
            // being moved. A development build may store absolute paths instead.
            let resources = Bundle.main.resourceURL?.path ?? ""
            func resolve(_ value: String?) -> String? {
                guard let value, !value.isEmpty else { return nil }
                return value.hasPrefix("/") ? value : (resources as NSString).appendingPathComponent(value)
            }
            root = resolve(object["runtime_root"])
            node = resolve(object["node"])
        }
        guard let root else { return nil }
        guard FileManager.default.fileExists(atPath: root + "/dist/apps/runtime/cli.js") else { return nil }
        if let node, FileManager.default.isExecutableFile(atPath: node) {
            return Runtime(executable: node, prefix: [], root: root)
        }
        return Runtime(executable: "/usr/bin/env", prefix: ["node"], root: root)
    }

    func run(_ arguments: [String]) throws -> (Int32, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = prefix + [cli] + arguments
        var environment = ProcessInfo.processInfo.environment
        environment["AGENTLINK_SESSION"] = environment["AGENTLINK_SESSION"] ?? "agentlink-menu"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
    }

    func status() throws -> StatusInfo {
        let (code, output) = try run(["status"])
        guard code == 0, let data = output.data(using: .utf8) else {
            throw NSError(domain: "AgentLink", code: Int(code), userInfo: [NSLocalizedDescriptionKey: "status 执行失败（exit \(code)）"])
        }
        return try JSONDecoder().decode(StatusInfo.self, from: data)
    }
}

// MARK: - self test (no UI): proves the app can read real state through the shared runtime.
if CommandLine.arguments.contains("--selftest") {
    guard let runtime = Runtime.locate() else {
        FileHandle.standardError.write(Data("SELFTEST FAIL: runtime not found (set AGENTLINK_RUNTIME_ROOT)\n".utf8)); exit(1)
    }
    do {
        let status = try runtime.status()
        let online = status.devices.filter { $0.online }.count
        let (_, human) = try runtime.run(["status", "--human"])
        print("SELFTEST OK runtime=\(runtime.root)")
        print("  devices=\(status.devices.count) online=\(online) bridge_configured=\(status.bridge.configured) bridge_running=\(status.bridge.running ?? false) mount=\(status.bridge.mount ?? "-")")
        print("  registry_error=\(status.registry.error ?? "none") home=\(status.paths.home)")
        print("  human_summary_lines=\(human.split(separator: "\n").count)")
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("SELFTEST FAIL: \(error.localizedDescription)\n".utf8)); exit(1)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private var statusItem: NSStatusItem!
    private var window: NSWindow!
    private var web: WKWebView?
    private var server: Process?
    private var output = Data()
    private var expectedOrigin: URL?
    private var runtime: Runtime?
    private var timer: Timer?
    private var busy = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        runtime = Runtime.locate()
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "AgentLink"
        statusItem.button?.image = NSImage(systemSymbolName: "computermouse", accessibilityDescription: "AgentLink")
        statusItem.button?.imagePosition = .imageLeading
        statusItem.button?.target = self
        statusItem.button?.action = #selector(statusItemClicked)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 500),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "AgentLink"
        window.minSize = NSSize(width: 620, height: 480)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.center()
        showWindow()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        refresh()
        return false
    }

    @objc private func statusItemClicked() { showWindow() }

    private func showWindow() {
        if web == nil {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.navigationDelegate = self
            view.uiDelegate = self
            web = view
            window.contentView = view
            startUI()
        }
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func showError(_ message: String) {
        let field = NSTextField(wrappingLabelWithString: message)
        field.font = .systemFont(ofSize: 15)
        field.alignment = .center
        let container = NSView()
        field.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(field)
        NSLayoutConstraint.activate([
            field.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            field.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            field.widthAnchor.constraint(lessThanOrEqualTo: container.widthAnchor, constant: -60)
        ])
        window.contentView = container
        web = nil
    }

    private func startUI() {
        guard server == nil, let runtime else {
            if runtime == nil { showError("找不到 AgentLink 运行时。请打开完整安装包。") }
            return
        }
        output = Data()
        expectedOrigin = nil
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: runtime.executable)
        task.arguments = runtime.prefix + [runtime.cli, "ui", "--port", "0", "--no-open", "--json",
                                           "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
        task.currentDirectoryURL = URL(fileURLWithPath: runtime.root)
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        server = task
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async {
                guard let self, self.server === task, self.expectedOrigin == nil else { return }
                self.output.append(data)
                guard let newline = self.output.firstIndex(of: 10) else { return }
                guard let object = try? JSONSerialization.jsonObject(with: self.output.prefix(upTo: newline)) as? [String: String],
                      let value = object["url"], let url = URL(string: value),
                      url.host == "127.0.0.1", url.scheme == "http", url.fragment?.count == 64 else {
                    self.showError("无法打开控制界面。请关闭窗口后重新打开。")
                    return
                }
                self.expectedOrigin = url
                self.web?.load(URLRequest(url: url))
            }
        }
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, self.server === task else { return }
                self.server = nil
                if self.window.isVisible { self.showError("连接界面已停止。请关闭窗口后重新打开。") }
            }
        }
        do { try task.run() }
        catch {
            server = nil
            showError("无法启动 AgentLink：\(error.localizedDescription)")
        }
    }

    func windowWillClose(_ notification: Notification) {
        let old = server
        server = nil
        expectedOrigin = nil
        web?.stopLoading()
        web = nil
        window.contentView = NSView()
        old?.terminate()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let origin = expectedOrigin,
              url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 330, height: 24)
        alert.accessoryView = input
        alert.addButton(withTitle: "确认")
        alert.addButton(withTitle: "取消")
        alert.beginSheetModal(for: window) { result in
            completionHandler(result == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    private func refresh() {
        guard !busy else { return }
        busy = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let status = try? self.runtime?.status()
            DispatchQueue.main.async {
                self.busy = false
                guard let status else {
                    self.statusItem.button?.title = "AgentLink · 状态不可用"
                    return
                }
                let online = status.devices.filter { $0.online }
                if online.count == 1 { self.statusItem.button?.title = "AgentLink · \(online[0].name)" }
                else if online.count > 1 { self.statusItem.button?.title = "AgentLink · \(online.count) 台可用" }
                else { self.statusItem.button?.title = status.devices.isEmpty ? "AgentLink · 未连接" : "AgentLink · 等待电脑" }
            }
        }
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
