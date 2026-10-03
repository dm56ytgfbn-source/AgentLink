import AppKit
import Foundation
import Security

struct AgentLinkDevice: Decodable {
    let name: String
    let url: String
    let token: String
    let ca: String
    let device_id: String
    var tls_server_name: String? = nil
}

struct AgentLinkRuntimeConfig: Decodable { let devices: [AgentLinkDevice] }

struct RemoteWindow: Decodable {
    let id: String
    let title: String
    let process: String
    let pid: UInt32
    let left: Int
    let top: Int
    let width: Int
    let height: Int
    let foreground: Bool
    let minimized: Bool
}

final class AgentLinkClient: NSObject, URLSessionDelegate {
    private let device: AgentLinkDevice
    private let pinnedCertificate: Data
    private let trustLock = NSLock()
    private var trustProblem: String?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForResource = 20
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    private func rememberTrustProblem(_ message: String?) {
        trustLock.lock(); trustProblem = message; trustLock.unlock()
    }

    private func explainedError(_ error: Error) -> Error {
        trustLock.lock(); let message = trustProblem; trustLock.unlock()
        let value = error as NSError
        if value.domain == NSURLErrorDomain && [NSURLErrorCancelled, NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted].contains(value.code), let message {
            return NSError(domain: "AgentLinkTLS", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return error
    }
    private let actionQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "AgentLink ordered input"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    init(device: AgentLinkDevice) throws {
        self.device = device
        let pem = try String(contentsOfFile: device.ca, encoding: .utf8)
        let body = pem
            .replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
            .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
            .components(separatedBy: .whitespacesAndNewlines).joined()
        guard let der = Data(base64Encoded: body) else { throw NSError(domain: "AgentLink", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法读取配对证书"]) }
        pinnedCertificate = der
        super.init()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = chain.first else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let serverData = SecCertificateCopyData(certificate) as Data
        guard serverData == pinnedCertificate else {
            rememberTrustProblem("Windows 证书与配对记录不一致，请核对目标电脑后重新配对。")
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        SecTrustSetAnchorCertificates(trust, [certificate] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, (device.tls_server_name ?? challenge.protectionSpace.host) as CFString))
        if SecTrustEvaluateWithError(trust, nil) { rememberTrustProblem(nil); completionHandler(.useCredential, URLCredential(trust: trust)) }
        else {
            rememberTrustProblem("证书未通过 macOS 校验，请检查地址、有效期和 TLS 服务器用途配置。")
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    private func makeRequest(action: String, payload: [String: Any]) throws -> URLRequest {
        guard let base = URL(string: device.url), base.scheme == "https", let url = URL(string: "/rpc", relativeTo: base) else { throw NSError(domain: "AgentLink", code: 2) }
        let id = UUID().uuidString
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = action == "window.capture" ? 15 : 8
        request.setValue("Bearer \(device.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["id": id, "type": "request", "action": action, "payload": payload, "timestamp": Int(Date().timeIntervalSince1970 * 1000)])
        return request
    }

    func listWindows(_ completion: @escaping (Result<[RemoteWindow], Error>) -> Void) {
        do {
            let request = try makeRequest(action: "window.list", payload: [:])
            session.dataTask(with: request) { data, response, error in
                if let error { let explained = self.explainedError(error); DispatchQueue.main.async { completion(.failure(explained)) }; return }
                do {
                    guard let data, let http = response as? HTTPURLResponse else { throw NSError(domain: "AgentLink", code: 3) }
                    let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                    if let message = (root?["error"] as? [String: Any])?["message"] as? String { throw NSError(domain: "AgentLink", code: 4, userInfo: [NSLocalizedDescriptionKey: message]) }
                    let sent = try JSONSerialization.jsonObject(with: request.httpBody!) as? [String: Any]
                    guard http.statusCode == 200, root?["ok"] as? Bool == true, root?["type"] as? String == "response", root?["id"] as? String == sent?["id"] as? String, let value = root?["result"] else { throw NSError(domain: "AgentLink", code: 3, userInfo: [NSLocalizedDescriptionKey: "Windows 返回了无效的窗口响应"]) }
                    let result = try JSONSerialization.data(withJSONObject: value)
                    let windows = try JSONDecoder().decode([RemoteWindow].self, from: result)
                    DispatchQueue.main.async { completion(.success(windows)) }
                } catch { DispatchQueue.main.async { completion(.failure(error)) } }
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func capture(id: String, _ completion: @escaping (Result<NSImage, Error>) -> Void) {
        do {
            let request = try makeRequest(action: "window.capture", payload: ["id": id])
            session.dataTask(with: request) { data, response, error in
                if let error { let explained = self.explainedError(error); DispatchQueue.main.async { completion(.failure(explained)) }; return }
                guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data, let image = NSImage(data: data) else {
                    let message = data.flatMap { String(data: $0, encoding: .utf8) } ?? "Windows 窗口画面不可用"
                    DispatchQueue.main.async { completion(.failure(NSError(domain: "AgentLink", code: 5, userInfo: [NSLocalizedDescriptionKey: message]))) }
                    return
                }
                DispatchQueue.main.async { completion(.success(image)) }
            }.resume()
        } catch { completion(.failure(error)) }
    }

    func action(_ action: String, payload: [String: Any], completion: ((Error?) -> Void)? = nil) {
        do {
            let request = try makeRequest(action: action, payload: payload)
            actionQueue.addOperation { [weak self] in
                guard let self else { return }
                let finished = DispatchSemaphore(value: 0)
                self.session.dataTask(with: request) { data, response, error in
                    var failure = error.map { self.explainedError($0) }
                    if failure == nil {
                        let http = response as? HTTPURLResponse
                        let root = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                        let sent = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                        if http?.statusCode != 200 || root?["ok"] as? Bool != true || root?["type"] as? String != "response" || root?["id"] as? String != sent?["id"] as? String {
                            failure = NSError(domain: "AgentLink", code: http?.statusCode ?? 0, userInfo: [NSLocalizedDescriptionKey: "Windows 未确认操作成功，请检查连接或窗口状态。"])
                        }
                    }
                    let reported = failure
                    DispatchQueue.main.async { completion?(reported) }
                    finished.signal()
                }.resume()
                // Keep input ordered until the request completes; the session has a total resource deadline.
                finished.wait()
            }
        } catch { completion?(error) }
    }
}

final class RemoteWindowView: NSView, NSTextInputClient {
    var client: AgentLinkClient?
    var remoteWindow: RemoteWindow? { didSet {
        if oldValue?.id != remoteWindow?.id || oldValue?.pid != remoteWindow?.pid {
            pendingTextWork?.cancel(); pendingTextWork = nil; pendingText = ""; image = nil
        }
    } }
    var image: NSImage? { didSet { needsDisplay = true } }
    private var lastMove = Date.distantPast
    private var pendingText = ""
    private var pendingTextWork: DispatchWorkItem?
    private var markedTextValue = NSAttributedString()
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    private var imageRect: NSRect {
        guard let image, image.size.width > 0, image.size.height > 0 else { return .zero }
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        return NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill(); bounds.fill()
        guard let image else {
            let text = "正在连接 Windows 应用…"
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 18), .foregroundColor: NSColor.secondaryLabelColor]
            let size = text.size(withAttributes: attributes)
            text.draw(at: NSPoint(x: (bounds.width-size.width)/2, y: (bounds.height-size.height)/2), withAttributes: attributes)
            return
        }
        image.draw(in: imageRect, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
    }

    private func remotePoint(_ event: NSEvent) -> [String: Any]? {
        guard let remoteWindow else { return nil }
        let point = convert(event.locationInWindow, from: nil), rect = imageRect
        guard rect.contains(point), rect.width > 0, rect.height > 0 else { return nil }
        return ["id": remoteWindow.id, "x": Int((point.x-rect.minX)/rect.width*CGFloat(remoteWindow.width)), "y": Int((point.y-rect.minY)/rect.height*CGFloat(remoteWindow.height))]
    }

    private func mouse(_ event: NSEvent, kind: String, button: String = "left") {
        guard var payload = remotePoint(event) else { return }
        payload["kind"] = kind; payload["button"] = button
        client?.action("window.input", payload: payload)
    }

    override func mouseDown(with event: NSEvent) { window?.makeFirstResponder(self); mouse(event, kind: "down") }
    override func mouseUp(with event: NSEvent) { mouse(event, kind: "up") }
    override func rightMouseDown(with event: NSEvent) { window?.makeFirstResponder(self); mouse(event, kind: "down", button: "right") }
    override func rightMouseUp(with event: NSEvent) { mouse(event, kind: "up", button: "right") }
    override func otherMouseDown(with event: NSEvent) { mouse(event, kind: "down", button: "middle") }
    override func otherMouseUp(with event: NSEvent) { mouse(event, kind: "up", button: "middle") }
    override func mouseMoved(with event: NSEvent) {
        guard Date().timeIntervalSince(lastMove) > 0.15 else { return }
        lastMove = Date(); mouse(event, kind: "move")
    }
    override func mouseDragged(with event: NSEvent) { mouseMoved(with: event) }
    override func rightMouseDragged(with event: NSEvent) { mouseMoved(with: event) }
    override func scrollWheel(with event: NSEvent) {
        guard var payload = remotePoint(event) else { return }
        payload["kind"] = "scroll"; payload["delta"] = Int(event.scrollingDeltaY * 40)
        client?.action("window.input", payload: payload)
    }
    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "v",
           let value = NSPasteboard.general.string(forType:.string) {
            queueText(value)
            return
        }
        interpretKeyEvents([event])
    }

    func insertText(_ string: Any, replacementRange: NSRange) {
        let value = (string as? NSAttributedString)?.string ?? (string as? String ?? "")
        queueText(value)
        markedTextValue = NSAttributedString()
    }

    private func queueText(_ value: String) {
        guard image != nil, remoteWindow != nil, !value.isEmpty else { return }
        pendingText += value
        pendingTextWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.flushText() }
        pendingTextWork = work
        DispatchQueue.main.asyncAfter(deadline:.now()+0.08, execute:work)
    }

    override func doCommand(by selector: Selector) {
        guard image != nil, let remoteWindow else { return }
        let commands: [String:String] = [
            "insertNewline:":"ENTER", "insertTab:":"TAB", "cancelOperation:":"ESCAPE",
            "deleteBackward:":"BACKSPACE", "deleteForward:":"DELETE",
            "moveLeft:":"LEFT", "moveRight:":"RIGHT", "moveUp:":"UP", "moveDown:":"DOWN",
            "moveToBeginningOfLine:":"HOME", "moveToEndOfLine:":"END",
            "pageUp:":"PAGEUP", "pageDown:":"PAGEDOWN"
        ]
        guard let key = commands[NSStringFromSelector(selector)] else { return }
        flushText()
        client?.action("window.input", payload:["id":remoteWindow.id,"kind":"key","key":key])
    }

    func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        markedTextValue = (string as? NSAttributedString) ?? NSAttributedString(string:string as? String ?? "")
    }
    func unmarkText() {
        let value = markedTextValue.string
        markedTextValue = NSAttributedString()
        queueText(value)
    }
    func hasMarkedText() -> Bool { markedTextValue.length > 0 }
    func markedRange() -> NSRange { hasMarkedText() ? NSRange(location:0,length:markedTextValue.length) : NSRange(location:NSNotFound,length:0) }
    func selectedRange() -> NSRange { NSRange(location:NSNotFound,length:0) }
    func attributedSubstring(forProposedRange range: NSRange, actualRange: NSRangePointer?) -> NSAttributedString? { nil }
    func validAttributesForMarkedText() -> [NSAttributedString.Key] { [] }
    func firstRect(forCharacterRange range: NSRange, actualRange: NSRangePointer?) -> NSRect {
        guard let window else { return .zero }
        let point = window.convertPoint(toScreen:NSPoint(x:bounds.midX,y:bounds.midY))
        return NSRect(origin:point,size:NSSize(width:1,height:20))
    }
    func characterIndex(for point: NSPoint) -> Int { NSNotFound }

    private func flushText() {
        pendingTextWork?.cancel(); pendingTextWork = nil
        guard let remoteWindow, !pendingText.isEmpty else { return }
        let value = pendingText; pendingText = ""
        client?.action("window.input", payload: ["id":remoteWindow.id,"kind":"text","text":value])
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var appWindow: NSWindow!
    private let canvas = RemoteWindowView()
    private let picker = NSPopUpButton()
    private let textInput = NSTextField()
    private let status = NSTextField(labelWithString: "连接中…")
    private var windows: [RemoteWindow] = []
    private var captureBusy = false
    private var refreshBusy = false
    private var requiresSelection = false
    private var client: AgentLinkClient!
    private var deviceName = "Windows"

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let root = Bundle.main.bundleURL.deletingLastPathComponent()
            let defaultConfig = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AgentLink/config/runtime.local.json")
            let configURL = ProcessInfo.processInfo.environment["AGENTLINK_CONFIG"].map { URL(fileURLWithPath: $0) }
                ?? (FileManager.default.fileExists(atPath: defaultConfig.path) ? defaultConfig : root.appendingPathComponent("agentlink/runtime.local.json"))
            let config = try JSONDecoder().decode(AgentLinkRuntimeConfig.self, from: Data(contentsOf: configURL))
            let requestedName = ProcessInfo.processInfo.environment["AGENTLINK_COMPUTER"]
            let selected = requestedName.flatMap { name in config.devices.first(where: { $0.name == name }) } ?? (requestedName == nil && config.devices.count == 1 ? config.devices.first : nil)
            guard let device = selected else { throw NSError(domain:"AgentLink",code:6,userInfo:[NSLocalizedDescriptionKey:"请通过 AGENTLINK_COMPUTER 指定已配对电脑；配置中须存在该电脑。只有一台时会自动选择。"]) }
            deviceName = device.name
            client = try AgentLinkClient(device: device); canvas.client = client
            buildWindow(deviceName: device.name)
            refreshWindows()
            Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in self?.refreshWindows() }
            Timer.scheduledTimer(withTimeInterval: 0.10, repeats: true) { [weak self] _ in self?.captureFrame() }
        } catch {
            NSAlert(error: error).runModal(); NSApp.terminate(nil)
        }
    }

    private func buildWindow(deviceName: String) {
        appWindow = NSWindow(contentRect: NSRect(x:0,y:0,width:1200,height:780), styleMask:[.titled,.closable,.miniaturizable,.resizable], backing:.buffered, defer:false)
        appWindow.title = "AgentLink · \(deviceName) 应用窗口"
        appWindow.center(); appWindow.setFrameAutosaveName("AgentLinkRemoteWindow"); appWindow.acceptsMouseMovedEvents = true
        let toolbar = NSStackView(); toolbar.orientation = .horizontal; toolbar.spacing = 10; toolbar.edgeInsets = NSEdgeInsets(top:8,left:12,bottom:8,right:12)
        let label = NSTextField(labelWithString: "Windows 应用："); label.font = .systemFont(ofSize: 13, weight: .semibold)
        picker.target = self; picker.action = #selector(selectionChanged); picker.setContentHuggingPriority(.defaultLow, for:.horizontal)
        let refresh = NSButton(title:"刷新", target:self, action:#selector(refreshPressed)); refresh.bezelStyle = .rounded
        textInput.placeholderString = "输入文字到 Windows…"; textInput.target = self; textInput.action = #selector(sendText)
        textInput.widthAnchor.constraint(equalToConstant:210).isActive = true
        let send = NSButton(title:"发送文字", target:self, action:#selector(sendText)); send.bezelStyle = .rounded
        status.textColor = .secondaryLabelColor; status.alignment = .right
        toolbar.addArrangedSubview(label); toolbar.addArrangedSubview(picker); toolbar.addArrangedSubview(refresh); toolbar.addArrangedSubview(textInput); toolbar.addArrangedSubview(send); toolbar.addArrangedSubview(status)
        let stack = NSStackView(views:[toolbar,canvas]); stack.orientation = .vertical; stack.spacing = 0
        toolbar.translatesAutoresizingMaskIntoConstraints=false; canvas.translatesAutoresizingMaskIntoConstraints=false
        appWindow.contentView = stack
        NSLayoutConstraint.activate([toolbar.heightAnchor.constraint(equalToConstant:48), canvas.widthAnchor.constraint(equalTo:stack.widthAnchor)])
        appWindow.makeKeyAndOrderFront(nil)
    }

    @objc private func refreshPressed() { refreshWindows() }
    @objc private func sendText() {
        guard canvas.image != nil, let selected = canvas.remoteWindow, !textInput.stringValue.isEmpty else { return }
        let value = textInput.stringValue
        client.action("window.input", payload:["id":selected.id,"kind":"text","text":value]) { [weak self] error in
            self?.status.stringValue = error == nil ? "文字已发送 · \(selected.process)" : "文字发送失败"
            if error == nil && self?.textInput.stringValue == value { self?.textInput.stringValue = "" }
        }
        appWindow.makeFirstResponder(canvas)
    }
    @objc private func selectionChanged() {
        guard picker.indexOfSelectedItem >= 0, picker.indexOfSelectedItem < windows.count else { return }
        let selected = windows[picker.indexOfSelectedItem]
        requiresSelection = false
        canvas.remoteWindow = selected; canvas.image = nil
        appWindow.title = "AgentLink · \(selected.title) · \(deviceName)"
        client.action("window.focus", payload:["id":selected.id])
    }

    private func refreshWindows() {
        guard !refreshBusy else { return }; refreshBusy = true
        client.listWindows { [weak self] result in
            guard let self else { return }
            self.refreshBusy = false
            let previous = self.canvas.remoteWindow
            switch result {
            case .failure(let error): self.canvas.image = nil; self.status.stringValue = "连接失败：\(error.localizedDescription)"
            case .success(let values):
                self.windows = values
                self.picker.removeAllItems(); self.picker.addItems(withTitles: values.map { "\($0.title)  [\($0.process)]" })
                var index = previous.flatMap { old in values.firstIndex(where:{$0.id == old.id && $0.pid == old.pid}) }
                if previous != nil && index == nil { self.requiresSelection = true }
                if previous == nil && !self.requiresSelection { index = values.firstIndex(where:{$0.foreground}) ?? (values.isEmpty ? nil : 0) }
                if let index { self.picker.selectItem(at:index); self.canvas.remoteWindow = values[index] }
                else { self.picker.select(nil); self.canvas.remoteWindow = nil; self.canvas.image = nil }
                self.status.stringValue = values.isEmpty ? "Windows 上没有可见应用" : "已连接 · \(values.count) 个窗口"
                if self.requiresSelection { self.status.stringValue = "原窗口已关闭，请重新选择应用" }
            }
        }
    }

    private func captureFrame() {
        guard !captureBusy, let selected = canvas.remoteWindow else { return }
        captureBusy = true
        client.capture(id:selected.id) { [weak self] result in
            guard let self else { return }; self.captureBusy = false
            guard self.canvas.remoteWindow?.id == selected.id, self.canvas.remoteWindow?.pid == selected.pid else { return }
            switch result {
            case .success(let image): self.canvas.image = image; self.status.stringValue = "实时 · \(selected.process)"
            case .failure(let error): self.canvas.image = nil; self.status.stringValue = "画面等待：\(error.localizedDescription)"
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
