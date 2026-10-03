import AppKit
import WebKit

// The settings app lives beside the packaged runtime inside AgentLink.app/Contents/Resources.
func runtimeRoot() -> URL {
  if let root = ProcessInfo.processInfo.environment["AGENTLINK_RUNTIME_ROOT"] { return URL(fileURLWithPath: root) }
  return Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("runtime")
}
func nodeExecutable() -> URL { runtimeRoot().appendingPathComponent("bin/node") }
if CommandLine.arguments.contains("--selftest") {
  let root = runtimeRoot()
  guard FileManager.default.isExecutableFile(atPath: nodeExecutable().path),
        FileManager.default.fileExists(atPath: root.appendingPathComponent("dist/apps/runtime/ui.js").path) else {
    print("SELFTEST FAIL: packaged settings runtime missing"); exit(1)
  }
  print("SELFTEST OK: bundle-relative settings runtime"); exit(0)
}
final class Delegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var server: Process?
  var output = Data()
  var startupComplete = false
  var expectedOrigin: URL?
  func showError(_ message: String) {
    let text = NSTextField(wrappingLabelWithString: message)
    text.frame = NSRect(x: 24, y: 24, width: 700, height: 180)
    window.contentView = text
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    let frame = NSRect(x: 0, y: 0, width: 860, height: 720)
    window = NSWindow(contentRect: frame, styleMask: [.titled,.closable,.miniaturizable,.resizable], backing: .buffered, defer: false)
    window.title = "AgentLink 设置"
    window.minSize = NSSize(width: 560, height: 420)
    web = WKWebView(frame: frame); web.navigationDelegate = self; web.uiDelegate = self
    window.contentView = web; window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    let task = Process(), pipe = Pipe()
    task.executableURL = nodeExecutable()
    task.arguments = [runtimeRoot().appendingPathComponent("dist/apps/runtime/cli.js").path, "ui", "--port", "0", "--no-open", "--json", "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
    task.currentDirectoryURL = runtimeRoot()
    task.standardOutput = pipe; task.standardError = FileHandle.nullDevice
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty { handle.readabilityHandler = nil; return }
      DispatchQueue.main.async {
        guard let self, !self.startupComplete else { return }
        self.output.append(data)
        guard let newline = self.output.firstIndex(of: 10) else { return }
        guard let object = try? JSONSerialization.jsonObject(with: self.output.prefix(upTo: newline)) as? [String:String],
              let value = object["url"], let url = URL(string: value), url.host == "127.0.0.1", url.scheme == "http", url.fragment?.count == 64 else {
          self.showError("设置服务返回了无效启动信息，请重新打开应用。"); return
        }
        self.startupComplete = true; self.expectedOrigin = url; self.web.load(URLRequest(url: url))
      }
    }
    task.terminationHandler = { [weak self] _ in DispatchQueue.main.async { self?.showError("设置服务已退出，请关闭窗口后重新打开；仍失败时请查看 AgentLink 诊断。") } }
    do { try task.run(); server = task }
    catch { showError("无法启动包内运行时：\(error.localizedDescription)") }
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = navigationAction.request.url, let origin = expectedOrigin,
          url.scheme == origin.scheme, url.host == origin.host, url.port == origin.port else { decisionHandler(.cancel); return }
    decisionHandler(.allow)
  }
  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    let alert = NSAlert(); alert.messageText = prompt
    let input = NSTextField(string: defaultText ?? ""); input.frame = NSRect(x:0,y:0,width:330,height:24)
    alert.accessoryView = input; alert.addButton(withTitle:"确认"); alert.addButton(withTitle:"取消")
    alert.beginSheetModal(for:window) { result in completionHandler(result == .alertFirstButtonReturn ? input.stringValue : nil) }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ notification: Notification) { if let server, server.isRunning { server.terminate() } }
}
let app = NSApplication.shared
let delegate = Delegate(); app.delegate = delegate; app.setActivationPolicy(.regular); app.run()
