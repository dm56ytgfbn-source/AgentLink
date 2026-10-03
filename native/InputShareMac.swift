import AppKit
import CoreGraphics
import ApplicationServices

// Reconcile remembered presses against hardware state, rather than the combined
// session state (which also contains software-generated input).
func releasedPhysicalInputs(_ remembered:Set<Int>, isDown:(Int)->Bool) -> [Int] {
    return remembered.filter { !isDown($0) }.sorted()
}
// Ignore only explicitly identified phantom startup keys (127), while retaining
// held-button and modifier protection. A subsequent physical down confirms even that key.
func uncertainStartupKeys(_ keys:Set<Int>) -> Set<Int> { keys.intersection([127]) }
func confirmedHeldCount(observed:Set<Int>, uncertain:Set<Int>) -> Int {
    return observed.subtracting(uncertain).count
}
if CommandLine.arguments.contains("--test-input-state") {
    precondition(releasedPhysicalInputs([55,58],isDown:{$0 == 58}) == [55])
    precondition(releasedPhysicalInputs([0,1],isDown:{_ in true}).isEmpty)
    precondition(releasedPhysicalInputs([],isDown:{_ in false}).isEmpty)
    precondition(releasedPhysicalInputs([0,1],isDown:{_ in false}) == [0,1])
    precondition(uncertainStartupKeys([55,58,127]) == [127])
    precondition(uncertainStartupKeys([0,55,58]).isEmpty)
    precondition(confirmedHeldCount(observed:[55,58],uncertain:[]) == 2) // held startup modifiers
    precondition(confirmedHeldCount(observed:[0],uncertain:[]) == 1) // held startup drag
    // A phantom snapshot press must not count as held.
    precondition(confirmedHeldCount(observed:[127],uncertain:[127]) == 0)
    precondition(confirmedHeldCount(observed:[127,30],uncertain:[127]) == 1)
    precondition(confirmedHeldCount(observed:[],uncertain:[]) == 0)
    precondition(confirmedHeldCount(observed:[30],uncertain:[]) == 1)
    print("PASS: stale physical presses clear; phantom snapshot presses never block a switch; real held keys/buttons remain protected")
    exit(0)
}

// Private JSON-lines IPC. This process never opens a network socket or records input.
let tag: Int64 = 0x41474C4B
let output = DispatchQueue(label: "agentlink.input.output")
let capacity = DispatchSemaphore(value: 512)
func emit(_ value: [String: Any]) {
    guard capacity.wait(timeout: .now()) == .success else { exit(3) }
    output.async {
        defer { capacity.signal() }
        if let data = try? JSONSerialization.data(withJSONObject: value), var text = String(data: data, encoding: .utf8) {
            text += "\n"; FileHandle.standardOutput.write(Data(text.utf8))
        }
    }
}
func displays() -> [[String: Any]] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32); var count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).filter { CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }.map {
        let r = CGDisplayBounds($0)
        return ["id": String($0), "x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }
}
let accessibility = AXIsProcessTrusted()
let inputMonitoring = CGPreflightListenEventAccess()
let postEvents = CGPreflightPostEventAccess()
let access = accessibility && inputMonitoring && postEvents
if CommandLine.arguments.contains("--inspect") {
    let v: [String: Any] = ["t":"ready", "permissions":access,
                            "accessibility":accessibility, "input_monitoring":inputMonitoring,
                            "post_events":postEvents, "displays":displays()]
    let data = try JSONSerialization.data(withJSONObject:v); FileHandle.standardOutput.write(data); print(""); exit(0)
}
if CommandLine.arguments.contains("--request-accessibility") {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    if !postEvents { _ = CGRequestPostEventAccess() }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 2))
    exit(0)
}
if CommandLine.arguments.contains("--request-input-monitoring") {
    _ = CGRequestListenEventAccess()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 2))
    exit(0)
}
if !access {
    FileHandle.standardError.write(Data("Input sharing needs Accessibility and Input Monitoring permission; no input captured.\n".utf8)); exit(2)
}
var epoch = 0, mode = "local", lastBeat = ProcessInfo.processInfo.systemUptime
var physicalKeys = Set<Int>(), physicalButtons = Set<Int>(), injectedKeys = Set<Int>(), injectedButtons = Set<Int>()
// Presses inferred from the startup snapshot, not observed as real down events yet.
var uncertainKeys = Set<Int>(), uncertainButtons = Set<Int>()
func heldCount() -> Int {
    return confirmedHeldCount(observed:physicalKeys,uncertain:uncertainKeys)
        + confirmedHeldCount(observed:physicalButtons,uncertain:uncertainButtons)
}
var tap: CFMachPort?
var stopped = false
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let statusItem = NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
statusItem.button?.title = "键鼠共享 · 本机"
class StopAction: NSObject { @objc func stopSharing() {stop("menu-stop")} }
let stopAction = StopAction()
let menu = NSMenu()
let stopItem = NSMenuItem(title:"停止共享（Control+Option+Esc）",action:#selector(StopAction.stopSharing),keyEquivalent:"")
stopItem.target = stopAction; menu.addItem(stopItem); statusItem.menu = menu
let initialDisplays = displays()
var cursor = CGEvent(source:nil)?.location ?? .zero
var lastClickTime = 0.0, lastClickPoint = CGPoint.zero, lastClickButton = -1, clickCount = 0
var scrollX = 0.0, scrollY = 0.0
let modifierCodes: [Int:CGEventFlags] = [54:.maskCommand,55:.maskCommand,56:.maskShift,60:.maskShift,58:.maskAlternate,61:.maskAlternate,59:.maskControl,62:.maskControl,57:.maskAlphaShift]
func send(_ event: CGEvent?) { event?.setIntegerValueField(.eventSourceUserData, value:tag); event?.post(tap:.cgSessionEventTap) }
func flags() -> CGEventFlags {
    var f:CGEventFlags=[]
    for k in injectedKeys { if let bit=modifierCodes[k] { f.insert(bit) } }
    return f
}
func key(_ code:Int,_ down:Bool) {
    if down { injectedKeys.insert(code) } else { injectedKeys.remove(code) }
    let e=CGEvent(keyboardEventSource:nil, virtualKey:CGKeyCode(code), keyDown:down)
    e?.flags=flags(); send(e)
}
func button(_ b:Int,_ down:Bool) {
    if down {
        injectedButtons.insert(b)
        let now=ProcessInfo.processInfo.systemUptime
        let close=abs(cursor.x-lastClickPoint.x)<=4 && abs(cursor.y-lastClickPoint.y)<=4
        clickCount = lastClickButton==b && close && now-lastClickTime<=NSEvent.doubleClickInterval ? min(3,clickCount+1) : 1
        lastClickTime=now;lastClickPoint=cursor;lastClickButton=b
    } else { injectedButtons.remove(b) }
    let type:CGEventType = b==0 ? (down ? .leftMouseDown:.leftMouseUp) : b==1 ? (down ? .rightMouseDown:.rightMouseUp) : (down ? .otherMouseDown:.otherMouseUp)
    let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:cursor,mouseButton:CGMouseButton(rawValue:UInt32(b)) ?? .center)
    e?.flags=flags(); e?.setIntegerValueField(.mouseEventButtonNumber,value:Int64(b)); e?.setIntegerValueField(.mouseEventClickState,value:Int64(clickCount)); send(e)
}
func releaseAll(){ for k in Array(injectedKeys) { key(k,false) }; for b in Array(injectedButtons){button(b,false)} }
func stop(_ reason:String) {
    if stopped { return }; stopped=true; mode="local"; releaseAll()
    if let t=tap { CGEvent.tapEnable(tap:t,enable:false) }
    emit(["t":"panic","reason":reason]); output.async { exit(0) }
}
func move(_ p:CGPoint) {
    cursor=p
    let b=injectedButtons.sorted().first
    let type:CGEventType = b==0 ? .leftMouseDragged : b==1 ? .rightMouseDragged : b != nil ? .otherMouseDragged : .mouseMoved
    let e=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:p,mouseButton:CGMouseButton(rawValue:UInt32(b ?? 0)) ?? .left)
    e?.flags=flags();e?.setIntegerValueField(.mouseEventButtonNumber,value:Int64(b ?? 0));send(e)
}
func refreshPhysicalInput() {
    let releasedKeys=releasedPhysicalInputs(physicalKeys) { CGEventSource.keyState(.hidSystemState,key:CGKeyCode($0)) }
    let releasedButtons=releasedPhysicalInputs(physicalButtons) {
        guard let b=CGMouseButton(rawValue:UInt32($0)) else {return false}
        return CGEventSource.buttonState(.hidSystemState,button:b)
    }
    for k in releasedKeys {
        physicalKeys.remove(k); uncertainKeys.remove(k)
        emit(["t":"event","epoch":epoch,"e":["kind":"key","code":k,"down":false]])
    }
    for b in releasedButtons {
        physicalButtons.remove(b); uncertainButtons.remove(b)
        emit(["t":"event","epoch":epoch,"e":["kind":"button","button":min(4,b),"down":false]])
    }
}
func handle(_ c:[String:Any]) {
    guard !stopped, let t=c["t"] as? String else{return}
    if t=="ping" {lastBeat=ProcessInfo.processInfo.systemUptime;return}
    if t=="stop" {stop("stopped");return}
    guard let n=c["epoch"] as? Int, n>=epoch else {return}
    if t=="mode",let m=c["mode"] as? String,["local","remote","receive"].contains(m) {
        refreshPhysicalInput()
        if m == "remote" && heldCount() > 0 {stop("input-held-during-switch");return}
        releaseAll();epoch=n;mode=m
        statusItem.button?.title = m == "receive" ? "键鼠共享 · 接收 Windows" : m == "remote" ? "键鼠共享 · 控制 Windows" : "键鼠共享 · 本机"
        if let p=c["point"] as? [String:Double],let x=p["x"],let y=p["y"] {move(CGPoint(x:x,y:y))}
        emit(["t":"ack","epoch":epoch]);return
    }
    guard n==epoch,mode=="receive",let e=c["e"] as? [String:Any],let kind=e["kind"] as? String else{return}
    switch kind {
    case "move": if let x=e["x"] as? Double,let y=e["y"] as? Double {move(CGPoint(x:x,y:y))}
    case "key": if let code=e["code"] as? Int,let down=e["down"] as? Bool,code<128 {key(code,down)}
    case "button": if let b=e["button"] as? Int,let down=e["down"] as? Bool {button(b,down)}
    case "scroll": if let dx=e["dx"] as? Double,let dy=e["dy"] as? Double {
        scrollX+=dx;scrollY+=dy;let x=Int32(scrollX),y=Int32(scrollY);scrollX-=Double(x);scrollY-=Double(y)
        let ev=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:y,wheel2:x,wheel3:0);ev?.flags=flags();send(ev)
    }
    default:break
    }
}
let callback:CGEventTapCallBack = { _,type,e,_ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { stop("event-tap-disabled"); return Unmanaged.passUnretained(e) }
    if e.getIntegerValueField(.eventSourceUserData)==tag { return Unmanaged.passUnretained(e) }
    var value:[String:Any]?
    switch type {
    case .keyDown,.keyUp,.flagsChanged:
        let code=Int(e.getIntegerValueField(.keyboardEventKeycode));var down=type == .keyDown
        if type == .flagsChanged {
            if code == 57 { // Caps Lock is a toggle, not a continuously held key.
                emit(["t":"event","epoch":epoch,"e":["kind":"key","code":57,"down":true]])
                emit(["t":"event","epoch":epoch,"e":["kind":"key","code":57,"down":false]])
                return mode == "remote" ? nil : Unmanaged.passUnretained(e)
            }
            down = CGEventSource.keyState(.hidSystemState,key:CGKeyCode(code))
        }
        if down {physicalKeys.insert(code);uncertainKeys.remove(code)} else {physicalKeys.remove(code);uncertainKeys.remove(code)}
        // Ctrl+Alt+Escape always restores this machine, even if Node/network is stuck.
        if code==53 && down && e.flags.contains(.maskControl) && e.flags.contains(.maskAlternate) {stop("emergency-hotkey");return nil}
        value=["kind":"key","code":code,"down":down]
    case .mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged:
        // An input-up can be missed while apps/permissions change. Recover that
        // state before the edge guard, and forward releases so the peer cannot stick.
        refreshPhysicalInput()
        value=["kind":"move","x":e.location.x,"y":e.location.y,"dx":e.getDoubleValueField(.mouseEventDeltaX),"dy":e.getDoubleValueField(.mouseEventDeltaY),"held":heldCount()]
    case .leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.otherMouseDown,.otherMouseUp:
        let b=Int(e.getIntegerValueField(.mouseEventButtonNumber));let down = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
        if down{physicalButtons.insert(b);uncertainButtons.remove(b)}else{physicalButtons.remove(b);uncertainButtons.remove(b)}
        value=["kind":"button","button":min(4,b),"down":down]
    case .scrollWheel:
        value=["kind":"scroll","dx":e.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),"dy":e.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)]
    default:break
    }
    if let v=value {emit(["t":"event","epoch":epoch,"e":v])}
    return mode == "remote" ? nil : Unmanaged.passUnretained(e)
}
let types:[CGEventType]=[.keyDown,.keyUp,.flagsChanged,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.otherMouseDragged,.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.otherMouseDown,.otherMouseUp,.scrollWheel]
let mask=types.reduce(CGEventMask(0)){ $0 | (1 << $1.rawValue) }
guard let created=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.defaultTap,eventsOfInterest:mask,callback:callback,userInfo:nil) else {
    FileHandle.standardError.write(Data("Cannot create input event tap.\n".utf8));exit(2)
}
tap=created
CFRunLoopAddSource(CFRunLoopGetMain(),CFMachPortCreateRunLoopSource(kCFAllocatorDefault,created,0),.commonModes)
// Preserve real held keys/buttons across startup. Only the observed invalid key 127
// is uncertain; it must not disable the gate for valid modifiers or an existing drag.
for k in 0..<128 where k != 57 {if CGEventSource.keyState(.hidSystemState,key:CGKeyCode(k)){physicalKeys.insert(k)}}
uncertainKeys = uncertainStartupKeys(physicalKeys)
for b in 0..<5 {if let button=CGMouseButton(rawValue:UInt32(b)),CGEventSource.buttonState(.hidSystemState,button:button){physicalButtons.insert(b)}}
CGEvent.tapEnable(tap:created,enable:true)
DispatchQueue.global().async {
    while let line=readLine() {
        if line.utf8.count>16384 {DispatchQueue.main.async{stop("oversize-command")};return}
        guard let data=line.data(using:.utf8),let c=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else {DispatchQueue.main.async{stop("bad-command")};return}
        DispatchQueue.main.async {handle(c)}
    }
    DispatchQueue.main.async{stop("controller-exited")}
}
let watchdog=Timer.scheduledTimer(withTimeInterval:0.2,repeats:true){ _ in
    if ProcessInfo.processInfo.systemUptime-lastBeat>1.5 {stop("controller-timeout")}
    if !AXIsProcessTrusted() || !CGPreflightListenEventAccess() {stop("permission-revoked")}
    if !NSDictionary(dictionary:["d":initialDisplays]).isEqual(to:["d":displays()]) {stop("display-layout-changed")}
}
emit(["t":"ready","permissions":true,"displays":initialDisplays])
RunLoop.main.run()
