// Sundial — the Mac app (docs/release/06-mac-app-plan.md), the executable of
// `$SUNDIAL_HOME/Sundial.app`.
//
// macOS starts this through LaunchServices (the login item, a double-click), so
// this process is the responsible one and the permissions belong to the app —
// Full Disk Access included, which a LaunchAgent never managed (Phase 0, passed
// 2026-09-26). It starts the two halves Sundial already has, as its children:
//
//   1. the Swift launcher (`sundial-daemon`), which spawns the TCC helpers;
//   2. Node running `dsh web` — the plugins, the database, the web client.
//
// It restarts either one when it dies, shows an icon in the menu bar, and opens
// the web client in a window of its own.
//
// Its settings come from `$SUNDIAL_HOME/app.env`, which `sundial install` writes
// (the same values `start.sh` exports), so the app and a LaunchAgent install run
// exactly the same thing. The data folder is the one the bundle sits in; a
// bundle elsewhere (a test build in ~/Applications) uses $SUNDIAL_HOME or
// ~/.sundial. Variables in the environment win over the file, for test runs.
//
// With no checkout named (no SUNDIAL_REPO, no Resources/repo-path) the app runs
// the copy of the Node side inside itself: `apps/macos/scripts/package.sh` puts
// the built code in Resources/app and a pinned Node in Resources/node.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
#if canImport(Sparkle)
import Sparkle
#endif
import ServiceManagement
import WebKit

func log(_ message: String) {
    FileHandle.standardError.write("[sundial-app] \(message)\n".data(using: .utf8)!)
}

/// The data folder: the bundle's own folder when it was installed into one.
let home: URL = {
    if let h = ProcessInfo.processInfo.environment["SUNDIAL_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    let parent = Bundle.main.bundleURL.deletingLastPathComponent()
    if FileManager.default.fileExists(atPath: parent.appendingPathComponent(".sundial-install.json").path) { return parent }
    return URL(fileURLWithPath: NSHomeDirectory() + "/.sundial")
}()

/// `app.env` under the process environment: KEY=VALUE lines, `#` comments.
private let env: [String: String] = {
    var out: [String: String] = [:]
    if let text = try? String(contentsOf: home.appendingPathComponent("app.env"), encoding: .utf8) {
        for line in text.split(separator: "\n") where !line.hasPrefix("#") {
            guard let eq = line.firstIndex(of: "=") else { continue }
            out[String(line[..<eq])] = String(line[line.index(after: eq)...])
        }
    }
    for (key, value) in ProcessInfo.processInfo.environment { out[key] = value }
    out["SUNDIAL_HOME"] = home.path
    return out
}()

private let webPort = env["SUNDIAL_WEB_PORT"] ?? "3080"
private let helpersOn = env["SUNDIAL_NATIVE_HELPERS"] != "0"
let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Resources")
let daemonDir = home.appendingPathComponent(".daemon")

/// A path from the environment, else from Contents/Resources (what `apps/macos/build.sh` writes).
private func setting(_ key: String, file: String) -> String? {
    if let value = env[key], !value.isEmpty { return value }
    return (try? String(contentsOf: resources.appendingPathComponent(file), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The checkout to run, or nil: then the app runs its own Resources/app.
let repo = setting("SUNDIAL_REPO", file: "repo-path")
private let nodePath = setting("SUNDIAL_NODE", file: "node-path") ?? resources.appendingPathComponent("node").path

// MARK: - Children

/// One child the app keeps alive: restarted with backoff when it exits on its
/// own, left down when the app is quitting.
private final class Child {
    let name: String
    private let make: () -> Process?
    private var process: Process?
    private var backoff: TimeInterval = 1
    private var startedAt = Date()
    private var stopping = false

    /// The process a stop is sent to, when it is not the one we started.
    private let target: (Process) -> pid_t

    init(name: String, target: @escaping (Process) -> pid_t = { $0.processIdentifier }, make: @escaping () -> Process?) {
        self.name = name
        self.target = target
        self.make = make
    }

    var running: Bool { process?.isRunning == true }

    func start() {
        guard !stopping, let task = make() else { return }
        task.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.exited(finished.terminationStatus) }
        }
        do {
            try task.run()
            process = task
            startedAt = Date()
            log("\(name) started (pid \(task.processIdentifier))")
        } catch {
            log("\(name) failed to start: \(error)")
            scheduleRestart()
        }
    }

    private func exited(_ status: Int32) {
        process = nil
        if stopping { return }
        log("\(name) exited (\(status)); restarting in \(Int(backoff))s")
        scheduleRestart()
    }

    private func scheduleRestart() {
        // A child that ran for a minute earned a fresh backoff; one that dies at once waits longer each time.
        if Date().timeIntervalSince(startedAt) > 60 { backoff = 1 }
        let wait = backoff
        backoff = min(backoff * 2, 60)
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.start() }
    }

    func stop() {
        stopping = true
        guard let task = process, task.isRunning else { return }
        kill(target(task), SIGTERM)
        task.waitUntilExit()
    }

    /// Stop it now and start it again in a second: a grant it needs came back.
    func restart() {
        guard let task = process, task.isRunning else { return }
        log("restarting \(name)")
        startedAt = .distantPast
        kill(target(task), SIGTERM)
    }
}

/// An append handle on a log in the data folder, private to this user.
private func logFile(_ name: String) -> FileHandle? {
    let logs = home.appendingPathComponent("logs")
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = logs.appendingPathComponent(name)
    if !FileManager.default.fileExists(atPath: file.path) {
        FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    let handle = try? FileHandle(forWritingTo: file)
    _ = try? handle?.seekToEnd()
    return handle
}

private func childEnvironment() -> [String: String] {
    var out = env
    // `sundial prepare` writes the profile there; only a checkout's app.env may say otherwise.
    out["DSH_HOME"] = repo != nil ? out["DSH_HOME"] ?? home.appendingPathComponent("dsh").path : home.appendingPathComponent("dsh").path
    out["DSH_TELEMETRY_DISABLED"] = "1"
    out["SUNDIAL_WEB_PORT"] = webPort
    // Tells the web process its parent restarts it: exiting IS a restart.
    out["SUNDIAL_APP"] = "1"
    // The setup page names the real bundle and its TCC identity.
    out["SUNDIAL_APP_PATH"] = Bundle.main.bundlePath
    out["SUNDIAL_BUNDLE_ID"] = Bundle.main.bundleIdentifier
    return out
}

/// The launcher re-runs itself disclaimed (Disclaim.swift) and the copy does the
/// work: a stop goes to the copy, named in sidecars.pid, when it is our child's child.
private func disclaimedCopy(of task: Process) -> pid_t {
    guard let text = try? String(contentsOf: daemonDir.appendingPathComponent("sidecars.pid"), encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return task.processIdentifier }
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, pid_t(info.pbi_ppid) == task.processIdentifier else { return task.processIdentifier }
    return pid
}

private let launcher = Child(name: "helpers", target: disclaimedCopy) {
    guard helpersOn else { return nil }
    let path = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/sundial-daemon")
    guard FileManager.default.isExecutableFile(atPath: path.path) else {
        log("no launcher at \(path.path); running without helpers")
        return nil
    }
    let task = Process()
    task.executableURL = path
    task.environment = childEnvironment()
    let out = logFile("sidecars.log")
    task.standardOutput = out
    task.standardError = out
    return task
}

private let web = Child(name: "web") {
    let node = nodePath
    let nodeDir = URL(fileURLWithPath: node).deletingLastPathComponent().path
    var environment = childEnvironment()
    if environment["PATH"] == nil || !(environment["PATH"]!.contains(nodeDir)) {
        environment["PATH"] = "\(nodeDir):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    }
    let out = logFile("sundial.log")
    let task = Process()
    if let repo {
        // `.bin/dsh` is pnpm's shell shim, run as start.sh runs it; it finds Node on PATH.
        task.executableURL = URL(fileURLWithPath: "\(repo)/apps/harness/node_modules/.bin/dsh")
        task.arguments = ["web", "--no-open", "--host", "127.0.0.1", "--port", webPort]
        task.currentDirectoryURL = URL(fileURLWithPath: "\(repo)/apps/harness")
    } else {
        // Our own copy: the data folder, its config and the dsh profile are
        // (re)written first, pointing at wherever this bundle sits now.
        let app = resources.appendingPathComponent("app")
        let prepare = Process()
        prepare.executableURL = URL(fileURLWithPath: node)
        prepare.arguments = [app.appendingPathComponent("bin/sundial").path, "prepare"]
        prepare.environment = environment
        prepare.standardOutput = out
        prepare.standardError = out
        do { try prepare.run(); prepare.waitUntilExit() } catch { log("prepare failed: \(error)") }
        guard prepare.terminationStatus == 0 else {
            log("prepare exited \(prepare.terminationStatus); see logs/sundial.log")
            return nil
        }
        task.executableURL = URL(fileURLWithPath: node)
        task.arguments = [app.appendingPathComponent("apps/harness/node_modules/@deepseek-ai/dsh/lib/bin.js").path, "web", "--no-open", "--host", "127.0.0.1", "--port", webPort]
        task.currentDirectoryURL = app.appendingPathComponent("apps/harness")
    }
    task.environment = environment
    task.standardOutput = out
    task.standardError = out
    return task
}

// MARK: - Permissions, as the helpers report them

/// Each grant the helpers report: the file and flag that say it, the System
/// Settings pane that gives it, and what restarts when it comes back (macOS
/// hands a new grant only to a process started after it).
private struct Grant {
    let key: String
    let label: String
    let file: String
    let flag: String
    let pane: String
    let helpers: [String]
    /// Off is a fine answer: never nagged about, not needed to finish setup.
    var optional = false
}

private let grants = [
    Grant(key: "accessibility", label: "Accessibility", file: "notification-badges.json", flag: "accessGranted", pane: "Privacy_Accessibility", helpers: ["sundial-window-helper", "sundial-notification-helper"]),
    Grant(key: "inputMonitoring", label: "Input Monitoring", file: "input-activity.json", flag: "listenAccessGranted", pane: "Privacy_ListenEvent", helpers: ["sundial-input-helper"]),
    Grant(key: "screenRecording", label: "Screen Recording", file: "screen-ocr-status.json", flag: "accessGranted", pane: "Privacy_ScreenCapture", helpers: ["sundial-screen-ocr-helper"]),
    // The launcher reports it; Node (Mail, Messages) is the one that needs it.
    Grant(key: "fullDiskAccess", label: "Full Disk Access", file: "focus-info.json", flag: "assertionsReadable", pane: "Privacy_AllFiles", helpers: ["launcher", "web"], optional: true),
]

/// Panes the page may open with no grant behind them (no helper reports these).
private let otherPanes = ["calendar": "Privacy_Calendars", "locationServices": "Privacy_LocationServices"]

/// What the helpers report now. A grant with no file yet (helper not started,
/// OCR off) is absent: unknown is not a refusal.
private func reportedGrants() -> [String: Bool] {
    guard helpersOn else { return [:] }
    var out: [String: Bool] = [:]
    for grant in grants {
        guard let data = try? Data(contentsOf: daemonDir.appendingPathComponent(grant.file)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = json[grant.flag] as? Bool else { continue }
        out[grant.key] = value
    }
    return out
}

/// The path a process runs, or nil when it is gone or not ours to read.
private func executablePath(_ pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    return proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 ? String(cString: buffer) : nil
}

/// Stop one helper by its path in this bundle; the launcher starts it again.
private func restartHelper(_ name: String) {
    // realpath, not resolvingSymlinksInPath: that one turns /private/tmp into /tmp, and the kernel says /private/tmp.
    guard let real = realpath(Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(name)").path, nil) else { return }
    let path = String(cString: real)
    free(real)
    var pids = [pid_t](repeating: 0, count: 4096)
    let count = Int(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)))
    for pid in pids.prefix(max(0, count)) where pid > 0 && executablePath(pid) == path {
        kill(pid, SIGTERM)
        log("restarted \(name) (pid \(pid))")
    }
}

/// Written once setup is over: the Open Today button, or every needed grant seen on.
private let setupDoneFile = daemonDir.appendingPathComponent("setup-done")

// MARK: - Updates
//
// Sparkle 2 (docs/release/06-mac-app-plan.md, Phase 4), from an
// EdDSA-signed appcast. Only the self-contained app built by
// `apps/macos/scripts/package.sh` links Sparkle; a checkout install updates
// with git, and its build (`swift.sh`) compiles the empty variant below.
//
// Sparkle looks for an update once a day (SUEnableAutomaticChecks, package.sh);
// the menu's "Check for Updates Daily" turns that off and on, and Sparkle keeps
// the choice. An update it finds is shown and downloaded only on the owner's yes
// (SUAutomaticallyUpdate false: nothing installs unasked). The install waits
// until the web process answers, so an update never cuts into Node's boot, then
// relaunches the app. The notes of what was installed are kept for the next
// launch ("what's new").
//
// Until the app is signed with a team ID, every update is a new ad-hoc
// identity: macOS asks for the permissions again. Sparkle accepts it, because
// the EdDSA signature on the download is valid (SUUpdateValidator).

/// The notes of the update being installed, read once by the next launch.
let whatsNewKey = "SundialWhatsNew"

#if canImport(Sparkle)
final class Updates: NSObject, SPUUpdaterDelegate {
    private var controller: SPUStandardUpdaterController!
    private let ready: () -> Bool

    /// Nil when this build has no feed (package.sh without SUNDIAL_FEED_URL): updates are off.
    static func start(ready: @escaping () -> Bool) -> Updates? {
        guard let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String, !feed.isEmpty else { return nil }
        return Updates(ready: ready)
    }

    private init(ready: @escaping () -> Bool) {
        self.ready = ready
        super.init()
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    @objc func checkForUpdates(_ sender: Any?) {
        controller.checkForUpdates(sender)
    }

    /// The daily check, the owner's switch in the menu (2026-11-17); Sparkle keeps it in the app's defaults.
    var checksDaily: Bool { controller.updater.automaticallyChecksForUpdates }

    @objc func toggleDailyCheck(_ sender: NSMenuItem) {
        controller.updater.automaticallyChecksForUpdates = !checksDaily
        sender.state = checksDaily ? .on : .off
    }

    /// Run `block` once the web process answers, checking every 5 s.
    private func whenReady(_ block: @escaping () -> Void) {
        if ready() { return block() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.whenReady(block) }
    }

    /// A downloaded update installs now, not at the next quit (Sundial rarely quits), but never mid-boot.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
        whenReady(immediateInstallationBlock)
        return true
    }

    func updater(_ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem, untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        if ready() { return false }
        whenReady(installHandler)
        return true
    }

    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        let notes = item.itemDescription.flatMap { html in
            try? NSAttributedString(data: Data(html.utf8), options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue], documentAttributes: nil).string
        }
        UserDefaults.standard.set(["build": item.versionString, "version": item.displayVersionString, "notes": notes ?? ""], forKey: whatsNewKey)
    }
}
#else
final class Updates: NSObject {
    static func start(ready: @escaping () -> Bool) -> Updates? { nil }
    @objc func checkForUpdates(_ sender: Any?) {}
    var checksDaily: Bool { false }
    @objc func toggleDailyCheck(_ sender: NSMenuItem) {}
}
#endif

// MARK: - The overlay
//
/// An event the hardware made, not one a process posted (macos-input-helper.swift `isHardware`): Gnomon posts from a private source.
private func fromHardware(_ event: CGEvent) -> Bool {
    event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue)
}

// The summon: one slip of paper, Gnomon's rings and tags on other apps, and the
// Nodus sheet, drawn over whatever the owner is doing. The board stays in the
// app window. A borderless, transparent, non-activating panel over the whole
// screen but the menu bar (whose privacy dots it must never cover), hosting the
// page in overlay mode (`/?overlay=slip`, plugins/sundial-theme/shell/overlay.js). The page reports where it is solid;
// everywhere else the panel ignores the mouse, so a click lands in the app
// underneath. The frontmost app stays frontmost, so what the window helper
// last wrote (`.daemon/window-info.json`) is what the owner is looking at, and
// the page carries it into the turn as its place. No screenshot, no new sensor.
//
// On unless `overlay.enabled` is false in config.json (read at launch); the
// hotkey is `overlay.hotkey`, default "option+space".

/// `overlay` in config.json: whether the summon exists, and its hotkey.
let overlayConfig: (enabled: Bool, hotkey: String) = {
    let json = (try? Data(contentsOf: home.appendingPathComponent("config.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let section = json?["overlay"] as? [String: Any]
    return (section?["enabled"] as? Bool ?? true, section?["hotkey"] as? String ?? "option+space")
}()

/// "option+space" → "⌥Space": the summon key as the owner sees it on the keyboard.
func keyName(_ text: String) -> String {
    let marks = ["option": "⌥", "opt": "⌥", "alt": "⌥", "cmd": "⌘", "command": "⌘", "ctrl": "⌃", "control": "⌃", "shift": "⇧"]
    return text.lowercased().split(separator: "+").map { part in let p = part.trimmingCharacters(in: .whitespaces); return marks[p] ?? (p == "space" ? "Space" : p.uppercased()) }.joined()
}

/// "option+space", "cmd+shift+g": Carbon's key code and modifiers, or nil when it does not parse.
func parseHotkey(_ text: String) -> (key: UInt32, modifiers: UInt32)? {
    // ANSI key codes 0-47 in order (kVK_ANSI_A = 0, kVK_ANSI_S = 1, ...); § holds 10, \r holds 36 (Return).
    let ansi = Array("asdfhgzxcv§bqweryt123465=97-80]ou[ip\rlj'k;\\,/nm.")
    var key: UInt32?
    var modifiers: UInt32 = 0
    for part in text.lowercased().split(separator: "+").map({ $0.trimmingCharacters(in: .whitespaces) }) {
        switch part {
        case "option", "opt", "alt": modifiers |= UInt32(optionKey)
        case "cmd", "command": modifiers |= UInt32(cmdKey)
        case "ctrl", "control": modifiers |= UInt32(controlKey)
        case "shift": modifiers |= UInt32(shiftKey)
        case "space": key = UInt32(kVK_Space)
        default:
            guard part.count == 1, let at = ansi.firstIndex(of: Character(part)) else { return nil }
            key = UInt32(at)
        }
    }
    guard let key, modifiers != 0 else { return nil }
    return (key, modifiers)
}

/// Each hotkey's handler by its id, reached from Carbon's C callback (which cannot capture).
var hotKeys: [UInt32: () -> Void] = [:]
/// Plan 15 step 3: a handler for the key coming up, for a hotkey that tells a tap from a hold.
var hotKeysUp: [UInt32: () -> Void] = [:]
private var hotKeyHandlerInstalled = false

/// One global hotkey; nil when the keys are taken.
func registerHotKey(id: UInt32, key: UInt32, modifiers: UInt32, _ run: @escaping () -> Void) -> EventHotKeyRef? {
    if !hotKeyHandlerInstalled {
        hotKeyHandlerInstalled = true
        var specs = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)), EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var pressed = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &pressed)
            let id = pressed.id
            let up = GetEventKind(event) == UInt32(kEventHotKeyReleased)
            DispatchQueue.main.async { (up ? hotKeysUp[id] : hotKeys[id])?() }
            return noErr
        }, 2, &specs, nil, nil)
    }
    var ref: EventHotKeyRef?
    guard RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: OSType(0x53_44_4C_59), id: id), GetApplicationEventTarget(), 0, &ref) == noErr else { return nil }
    hotKeys[id] = run
    return ref
}

/// A borderless panel may take the keyboard: the composer needs it.
private final class OverlayPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// The panel takes the mouse only on a solid region, so a click that reaches this view is meant for the page:
/// it takes the keyboard and reaches the page in the same click (a field gets the cursor at once).
private final class OverlayWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        // Doc 29: a Stop says whether a hand pressed it or a click was posted (the rig's), on its `chat:stop` row.
        evaluateJavaScript("document.documentElement.dataset.press = '\(event.cgEvent.map(fromHardware) ?? true ? "hand" : "posted")'")
        super.mouseDown(with: event)
    }
}

private final class Overlay: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var panel: OverlayPanel?
    private var webView: WKWebView?
    /// The page's solid rects, in its CSS pixels from the top left (= points).
    private var regions: [CGRect] = []
    /// The slip's own rect, same units (the page's `slip` message; nil while it is hidden): what the screen stage keeps clear of.
    private var slipBox: CGRect?
    /// The pointer, watched only while the panel is up (plan 15 I9).
    private var monitors: [Any] = []
    /// Gnomon's hands are posting a click or a scroll (`slipHands`): the panel lets the mouse through until they are done.
    private var handsBusy = false
    /// Whether the panel took the mouse when Gnomon's hands began: what it does again when they are done.
    private var tookMouse = false
    /// Doc 32 item 1: the last time the hands had the slip let the mouse through (uptime, as an event's timestamp), the owner's
    /// pointer before it and Gnomon's target; and a press meant for the slip in that time, pressed on the page when they are done.
    private var hands: (start: TimeInterval, end: TimeInterval?, back: CGPoint?, target: CGPoint?)?
    private var missed: (point: CGPoint, hand: Bool)?
    /// A quiet summon (plan 15 step 2): its id, its Esc, and the 1 Hz look for keys typed into the app below.
    private var summonId: String?
    private var summonedAt = Date.distantPast
    private var esc = false
    private var keysBelow: Timer?
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private var triedSignIn = false
    /// What the last summon found under it, as JSON for the page.
    private var context = "{}"
    /// The app that was frontmost at the summon: it gets the keyboard back.
    private var previous: NSRunningApplication?
    /// The page's composer holds the cursor (`messageHandlers.composer`).
    private var typing = false
    private let url = URL(string: "http://127.0.0.1:\(webPort)/?overlay=slip")!

    var shown: Bool { panel?.isVisible == true }

    /// The hotkey, Escape while it is up, and the lock screen.
    func start() {
        if let hotkey = parseHotkey(overlayConfig.hotkey) {
            // While a knock waits, the same keys are the owner's go.
            if registerHotKey(id: 1, key: hotkey.key, modifiers: hotkey.modifiers, { [weak self] in self?.keyDown() }) != nil {
                hotKeysUp[1] = { [weak self] in self?.keyUp() }
                log("overlay: summon with \(overlayConfig.hotkey)")
            } else {
                log("overlay: \(overlayConfig.hotkey) is taken; summon from the menu")
            }
        } else {
            log("overlay: cannot read the hotkey \"\(overlayConfig.hotkey)\"; summon from the menu")
        }
        drawMarks = { [weak self] marks, judge in self?.showMarks(marks, judge: judge) }
        slipFrame = { [weak self] in
            guard let self, self.shown, let panel = self.panel, let box = self.slipBox else { return nil }
            return CGRect(x: panel.frame.minX + box.minX, y: panel.frame.maxY - box.maxY, width: box.width, height: box.height)
        }
        slipHands = { [weak self] busy, back, target in
            guard let self else { return }
            // Run 248 T18: done, the panel took the pointer's place where the act had put it back (a spot the rig's glide had
            // left mid-way), let go, and the rig's Stop press went through to Finder. Pointer moves during the act are not
            // read (track), so the panel takes the mouse again as it did before the act; the next real move decides anew.
            let now = ProcessInfo.processInfo.systemUptime
            if busy, !self.handsBusy { self.tookMouse = self.panel?.ignoresMouseEvents == false; self.hands = (now, nil, back, target) }
            if !busy, self.handsBusy { self.hands?.end = now }
            self.handsBusy = busy
            if busy { self.panel?.ignoresMouseEvents = true } else if self.shown { self.panel?.ignoresMouseEvents = !self.tookMouse }
            if !busy, let missed = self.missed {
                self.missed = nil
                self.press(missed.point, hand: missed.hand)
            }
        }
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.shown, event.keyCode == UInt16(kVK_Escape), event.window === self.panel else { return event }
            // Esc stops the voice first; a second Esc hides the panel.
            if voice.speaking { voice.stop() } else { self.hide() }
            return nil
        }
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in self?.hide() }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in self?.hide() }
    }

    @objc func toggle() {
        shown ? hide() : summon()
    }

    /// Who opened the slip, because it decides where the keyboard goes.
    ///
    /// Reaching for Gnomon by hand means you want to write to it: the panel takes the keyboard and the
    /// cursor sits in the field, so typing and the mouse just work. Holding the key to TALK, or Gnomon
    /// opening itself to say something, must take nothing from the app you are in — you were busy, and
    /// it interrupted you. Before this it was the other way round, and the test runner had to find the
    /// field by reading the screen and clicking a pixel under it, which broke the moment the field moved.
    private var openedToTalk = false

    // Plan 15 step 3: the summon key. A tap shows or hides the panel, as before; held past 250 ms it talks.
    // 2026-11-13: the app records from key-down (the page's mic opened too late), and a press while Gnomon speaks
    // stops the voice AND listens, so the owner can cut in. A knock that waits takes the press as its go.
    private var downAt: Date?
    private var wasShown = false
    private var talking = false
    private var interrupted = false
    private var holdStart: DispatchWorkItem?

    private func keyDown() {
        interrupted = voice.speaking
        if interrupted { voice.stop() } else if voice.go() { downAt = nil; return }
        guard holdToTalkOn else { if !interrupted { toggle() }; return }
        downAt = Date()
        wasShown = shown
        holdEars.start()
        if !shown { summon(toTalk: true) }
        let start = DispatchWorkItem { [weak self] in
            guard let self, self.downAt != nil, self.shown else { return }
            self.talking = true
            self.webView?.evaluateJavaScript("window.sundialOverlay?.hold(true)")
        }
        holdStart = start
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: start)
    }

    private func keyUp() {
        holdStart?.cancel()
        defer { downAt = nil }
        guard downAt != nil else { return }
        if talking {
            talking = false
            voice.nod()
            webView?.evaluateJavaScript("window.sundialOverlay?.hold(false)")
            // The last word ends after the key comes up.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                let wav = holdEars.stop()?.base64EncodedString()
                self?.webView?.evaluateJavaScript("window.sundialOverlay?.heard(\(wav.map { "'\($0)'" } ?? "null"))")
            }
        } else {
            _ = holdEars.stop()
            if wasShown && !interrupted { hide() }
        }
    }

    private func summon(toTalk: Bool = false) {
        openedToTalk = toTalk
        // Never over a password field: secure input means the owner is typing a secret.
        guard !IsSecureEventInputEnabled() else { return log("overlay: not now, secure input is on") }
        // What is under it, read before the panel exists on screen.
        let info = (try? Data(contentsOf: daemonDir.appendingPathComponent("window-info.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let own = info?["bundleId"] as? String == Bundle.main.bundleIdentifier
        let front = NSWorkspace.shared.frontmostApplication
        previous = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
        var under: [String: Any] = own ? [:] : ["app": info?["processName"] as? String ?? "", "title": info?["windowTitle"] as? String ?? ""]
        summonId = quietSummonOn ? UUID().uuidString : nil
        if let id = summonId {
            under["quiet"] = true
            under["keyName"] = keyName(overlayConfig.hotkey)
            under["summonId"] = id
            if !own, let text = selectedText(previous) { under["selected"] = text }
        }
        context = (try? JSONSerialization.data(withJSONObject: under)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"

        let panel = self.panel ?? makePanel()
        // Set 3 R5: the screen that holds the front window's middle (window-info.json, top-left points), where the owner
        // looks; else the one the pointer is on. Minus the menu bar.
        let screens = NSScreen.screens
        let position = info?["position"] as? [String: Double], size = info?["size"] as? [String: Double]
        let middle = own ? nil : position.flatMap { p in size.map { s in CGPoint(x: (p["x"] ?? 0) + (s["width"] ?? 0) / 2, y: (p["y"] ?? 0) + (s["height"] ?? 0) / 2) } }
        let screen = middle.flatMap { lookScreenIndex($0, screens.map(\.frame)) }.map { screens[$0] }
            ?? screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main ?? screens[0]
        var frame = screen.frame
        frame.size.height = screen.visibleFrame.maxY - frame.minY
        panel.setFrame(frame, display: false)
        if webView?.url == nil { webView?.load(URLRequest(url: url)) }

        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = reduce ? 1 : 0
        panel.ignoresMouseEvents = true
        panel.orderFrontRegardless()
        if let id = summonId {
            summonedAt = Date()
            Summon.summoned(id)
            esc = true
            Esc.want("summon") { [weak self] in if voice.speaking { voice.stop() } else { self?.hide() } }
        }
        if summonId != nil, !openedToTalk {
            // Opened by hand: the owner came to write, so the field has the cursor and the panel the mouse.
            panel.makeKey()
            panel.makeFirstResponder(webView)
            typing = true  // summoned() puts the cursor in the composer; the page confirms or denies it.
        } else {
            // Opened to talk, or opened by Gnomon: the app below keeps the keyboard until the owner reaches over.
            typing = false
            keysBelow = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.lookForKeysBelow() }
        }
        if !reduce { fade(to: 1) }
        webView?.evaluateJavaScript("window.sundialOverlay?.summoned(\(context))")
        marksOnly = false
        watchPointer()
        log("overlay: summoned\((under["app"] as? String).map { $0.isEmpty ? "" : " over \($0)" } ?? "")\(summonId == nil ? "" : ", quiet")")
    }

    /// Where the pointer is decides whether the panel takes the click: checked when it moves, and on a click in the app below.
    private func watchPointer() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        let pointer: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown]
        monitors = [
            NSEvent.addGlobalMonitorForEvents(matching: pointer) { [weak self] event in
                guard let self else { return }
                // The owner's own click steps back; Gnomon's posted clicks do not (run202: the slip dimmed to 0.4 while Gnomon acted).
                // A press meant for the slip that went through it while Gnomon clicked is the slip's (doc 32 item 1), no step back.
                if !self.caught(event), event.type == .leftMouseDown || event.type == .rightMouseDown, event.cgEvent.map(fromHardware) ?? true { self.stepBack() }
                self.track()
            },
            NSEvent.addLocalMonitorForEvents(matching: pointer) { [weak self] event in self?.track(); return event },
        ].compactMap { $0 }
        track()
    }

    /// Doc 32 item 1 (run 258 T18): the rig pressed Stop while Gnomon clicked, the slip let the press through to Finder, and Gnomon
    /// renamed all 8 files. A press that went past the slip while the hands had it let the mouse through, and was meant for it
    /// (`slipMissed`), is pressed on the page when the hands are done, or at once when they already are.
    private func caught(_ event: NSEvent) -> Bool {
        guard event.type == .leftMouseDown, let panel, let cg = event.cgEvent else { return false }
        let hand = fromHardware(cg)
        let origin = CGPoint(x: panel.frame.minX, y: primaryHeight() - panel.frame.maxY)
        guard let point = slipMissed(cg.location, time: event.timestamp, hand: hand, window: hands, origin: origin, regions: regions) else { return false }
        if handsBusy { missed = missed ?? (point, hand) } else { press(point, hand: hand) }
        return true
    }

    /// The page's own click at a point of it, as the mouse would have given it: a Stop there says how it was pressed (doc 29).
    private func press(_ point: CGPoint, hand: Bool) {
        guard shown else { return }
        log("overlay: a \(hand ? "hand's" : "posted") press on the slip came while Gnomon clicked; pressed now")
        webView?.evaluateJavaScript("(() => { const e = document.elementFromPoint(\(point.x), \(point.y)); if (!e) return; document.documentElement.dataset.press = '\(hand ? "hand" : "posted")'; e.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })) })()")
    }

    // Plan 15 step 6: the marks on the real screen are drawn on this panel. Down, it comes up for the marks alone:
    // the board stays away and every click goes through. It goes down again when the marks clear (after the
    // "Right spot?" line, when the marks were to be judged).
    private var marksOnly = false
    private var marksGen = 0

    private func showMarks(_ marks: [[String: Any]], judge: Bool) {
        if marks.isEmpty && !shown { return }
        let panel = self.panel ?? makePanel()
        // Set 2 R5: a marks-only panel covers the display that holds the first mark, so a mark on a second display draws
        // there and not off the edge of the main one. A summoned slip stays on the display the owner called it to.
        let first = marks.first.map { CGPoint(x: ($0["x"] as? Double ?? 0) + ($0["w"] as? Double ?? 0) / 2, y: ($0["y"] as? Double ?? 0) + ($0["h"] as? Double ?? 0) / 2) }
        if !shown || marksOnly, let screen = first.flatMap(screenHolding) {
            var frame = screen.frame
            frame.size.height = screen.visibleFrame.maxY - frame.minY
            if panel.frame != frame { panel.setFrame(frame, display: false) }
        }
        if !shown {
            if webView?.url == nil { webView?.load(URLRequest(url: url)) }
            panel.alphaValue = 1
            panel.ignoresMouseEvents = true
            panel.orderFrontRegardless()
            marksOnly = true
            watchPointer()
        }
        // From top-left global points (anchored at the primary display, on every display) to the panel's own CSS points.
        let top = primaryHeight() - panel.frame.maxY
        let local: [[String: Any]] = marks.map { mark in
            var m = mark
            m["x"] = (mark["x"] as? Double ?? 0) - panel.frame.minX
            m["y"] = (mark["y"] as? Double ?? 0) - top
            return m
        }
        let json = (try? JSONSerialization.data(withJSONObject: local)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        webView?.evaluateJavaScript("window.sundialOverlay?.marks(\(json), \(marksOnly), \(judge))")
        if marks.isEmpty && marksOnly {
            marksGen += 1
            let gen = marksGen
            DispatchQueue.main.asyncAfter(deadline: .now() + (judge ? 10 : 0.3)) { [weak self] in if self?.marksOnly == true, self?.marksGen == gen { self?.hide() } }
        }
    }

    func hide() {
        guard let panel, panel.isVisible else { return }
        marksOnly = false
        if talking {
            talking = false
            _ = holdEars.stop()
            webView?.evaluateJavaScript("window.sundialOverlay?.hold(false)")
        }
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let id = summonId { Summon.dismissed(id) }
        summonId = nil
        endQuietWatch()
        giveBackKeys()
        let done = { panel.orderOut(nil); panel.alphaValue = 1 }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { done() } else { fade(to: 0, then: done) }
    }

    /// The one easing (DESIGN.md: cubic-bezier(0.2, 0, 0, 1)), 160 ms.
    private func fade(to alpha: CGFloat, then: (() -> Void)? = nil) {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0, 0, 1)
            panel?.animator().alphaValue = alpha
        }, completionHandler: then)
    }

    /// The owner went back to their work: a click or keys in the app below. The panel dims, once per summon.
    private func stepBack() {
        guard let id = summonId, esc || keysBelow != nil else { return }
        endQuietWatch()
        Summon.steppedBack(id)
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { panel?.alphaValue = 0.4 } else { fade(to: 0.4) }
    }

    private func endQuietWatch() {
        if esc { Esc.drop("summon") }
        esc = false
        keysBelow?.invalidate()
        keysBelow = nil
    }

    /// Keys typed while the panel does not hold the keyboard went to the app below. The input helper counts them
    /// each second; the hotkey that summoned the panel falls in the first 1.5 s and does not count.
    private func lookForKeysBelow() {
        guard let panel, downAt == nil else { return }
        if IsSecureEventInputEnabled() { return hide() }
        guard !panel.isKeyWindow,
              let data = try? Data(contentsOf: daemonDir.appendingPathComponent("input-activity.json")),
              let input = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              // The owner's keys alone when the helper counts them apart (`ownerOnly`): Gnomon's typing is not the owner going back to work.
              (input[input["ownerOnly"] as? Bool == true ? "ownerKeyDownCount" : "keyDownCount"] as? Int ?? 0) > 0,
              let at = (input["timestamp"] as? String).flatMap({ stamp.date(from: $0) }),
              at.timeIntervalSince(summonedAt) > 1.5 else { return }
        stepBack()
    }

    /// The text selected in the app below, read once at a quiet summon and only handed to the page; never written down.
    private func selectedText(_ app: NSRunningApplication?) -> String? {
        guard let app, AXIsProcessTrusted() else { return nil }
        var focused: CFTypeRef?
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.3)
        guard AXUIElementCopyAttributeValue(element, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        var text: CFTypeRef?
        guard AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXSelectedTextAttribute as CFString, &text) == .success,
              let selected = text as? String, !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return String(selected.prefix(2000))
    }

    /// Solid under the pointer: take the mouse; elsewhere let it through. Left alone
    /// mid-drag, so a selection that wanders off the page still ends where it began.
    /// Secure input coming on while it is up hides it.
    private func track() {
        guard let panel, !handsBusy else { return }
        if IsSecureEventInputEnabled() { return hide() }
        guard NSEvent.pressedMouseButtons == 0 else { return }
        let p = NSEvent.mouseLocation
        let point = CGPoint(x: p.x - panel.frame.minX, y: panel.frame.maxY - p.y)
        let inside = regions.contains { $0.contains(point) }
        if panel.ignoresMouseEvents == inside { panel.ignoresMouseEvents = !inside }
        // Dimmed after a step back: the pointer on a card brings it back.
        if inside, panel.alphaValue < 1, summonId != nil { panel.alphaValue = 1 }
        // Keys come here only while the pointer is on a card or the composer has
        // the cursor; otherwise a Return meant for the app underneath lands there.
        if panel.isKeyWindow, !inside, !typing { giveBackKeys() }
    }

    /// The keyboard back to the app that had it. A non-activating panel takes the
    /// keys without making Sundial active, so ordering it out alone leaves them nowhere.
    private func giveBackKeys() {
        guard panel?.isKeyWindow == true || NSApp.isActive, let previous, !previous.isTerminated else { return }
        previous.activate()
    }

    private func makePanel() -> OverlayPanel {
        let panel = OverlayPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "regions")
        config.userContentController.add(self, name: "slip")
        config.userContentController.add(self, name: "composer")
        config.userContentController.add(self, name: "focus")
        config.userContentController.add(self, name: "open")
        let webView = OverlayWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        // A transparent page shows the screen under it only when the view paints no ground of its own.
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        panel.contentView = webView
        self.panel = panel
        self.webView = webView
        return panel
    }

    // MARK: The page

    /// `regions`, `[{x, y, w, h}]`: where the page is solid; `slip`, `{x, y, w, h}` or null: the slip alone;
    /// `composer`, whether it holds the cursor. Only from Sundial's own page.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard origin.host == "127.0.0.1", String(origin.port) == webPort else { return }
        if message.name == "composer" { typing = message.body as? Bool ?? false; return }
        if message.name == "focus" { panel?.makeKey(); panel?.makeFirstResponder(webView); typing = true; return }
        if message.name == "open" { hide(); (NSApp.delegate as? AppDelegate)?.openFromMenu(); return }
        let rect = { (r: [String: Any]) -> CGRect? in
            guard let x = r["x"] as? Double, let y = r["y"] as? Double, let w = r["w"] as? Double, let h = r["h"] as? Double else { return nil }
            return CGRect(x: x, y: y, width: w, height: h)
        }
        if message.name == "slip" { slipBox = (message.body as? [String: Any]).flatMap(rect); return }
        guard let rects = message.body as? [[String: Any]] else { return }
        regions = rects.compactMap(rect)
        if shown { track() }
    }

    /// Plan 15 step 3: the microphone for hold to talk, for Sundial's own page only. macOS asks the owner once for the app.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" && String(origin.port) == webPort && type == .microphone ? .grant : .deny)
    }

    /// Signed out (a 401): sign in once with the app's link, as the window does.
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if (response.response as? HTTPURLResponse)?.statusCode == 401, !triedSignIn, let signIn = signInURL() {
            triedSignIn = true
            decisionHandler(.cancel)
            webView.load(URLRequest(url: signIn))
            return
        }
        decisionHandler(.allow)
    }

    /// The sign-in answers with a redirect to a clean `/`: the cookie is set by
    /// then, so the overlay goes straight back to itself instead of booting the board.
    /// Anything that is not Sundial's goes to macOS, as in the window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let target = action.request.url else { return decisionHandler(.allow) }
        let own = target.host == "127.0.0.1" && target.port.map(String.init) == webPort
        if own && target.path == "/" && target.query == nil {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: url))
            return
        }
        if own || target.scheme == "about" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(target)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.query?.contains("overlay=") == true else { return }
        triedSignIn = false
        // A summon that raced the load: the page learns what is under it now.
        if shown { webView.evaluateJavaScript("window.sundialOverlay?.summoned(\(context))") }
    }
}

private let overlay = Overlay()

// MARK: - The app

/// The sign-in link dsh prints at start (`?token=`). Opening it once gives this
/// window's cookie store a session, as `sundial open` does for a browser.
private func signInURL() -> URL? {
    guard let text = try? String(contentsOf: home.appendingPathComponent("logs/sundial.log"), encoding: .utf8) else { return nil }
    let pattern = "http://127\\.0\\.0\\.1:\(webPort)/\\?token=[A-Za-z0-9_-]+"
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
    let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    guard let last = matches.last, let range = Range(last.range, in: text) else { return nil }
    return URL(string: String(text[range]))
}

private let pidFile = daemonDir.appendingPathComponent("app.pid")

/// Another Sundial app already running on this data folder (two would write one
/// database), by its pid file and its executable, never by liveness alone.
private func otherAppOnThisFolder() -> pid_t? {
    guard let text = try? String(contentsOf: pidFile, encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid != getpid(), kill(pid, 0) == 0 else { return nil }
    return executablePath(pid)?.hasSuffix("/Contents/MacOS/Sundial") == true ? pid : nil
}

/// Phase 5: a LaunchAgent install of this same data folder (`sundial install
/// --no-app`, or one from before the app) hands over to the app. Its web
/// process would hold the port, and its detached launcher would run a second
/// set of helpers. Only the agent whose plist names this folder, as
/// `bin/sundial`'s removeAgent does.
private func takeOverLaunchAgent() {
    let label = env["SUNDIAL_LABEL"] ?? "dev.sundial.agent"
    let plist = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/LaunchAgents/\(label).plist")
    guard let text = try? String(contentsOf: plist, encoding: .utf8), text.contains("<string>\(label)</string>"), text.contains(home.path) else { return }
    log("taking over from the LaunchAgent \(label)")
    func launchctl(_ args: String...) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = args
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        return task.terminationStatus
    }
    // bootout returns before the job is gone.
    _ = launchctl("bootout", "gui/\(getuid())/\(label)")
    for _ in 0..<40 where launchctl("print", "gui/\(getuid())/\(label)") == 0 { usleep(250_000) }
    try? FileManager.default.removeItem(at: plist)
    // Its launcher, by pid file and executable. Wait for it: its cleanup removes sidecars.pid, which ours is about to write.
    if let text = try? String(contentsOf: daemonDir.appendingPathComponent("sidecars.pid"), encoding: .utf8),
       let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), executablePath(pid)?.hasSuffix("/sundial-daemon") == true {
        kill(pid, SIGTERM)
        for _ in 0..<40 where kill(pid, 0) == 0 { usleep(250_000) }
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var statusItem: NSStatusItem!
    private var statusLine: NSMenuItem!
    private var permissionsItem: NSMenuItem!
    private var loginItem: NSMenuItem!
    private var quietItem: NSMenuItem?
    private var window: NSWindow?
    private var signedIn = false
    /// The last answer each helper gave, to act on changes only.
    private var lastGrants: [String: Bool] = [:]
    /// Preflight answers lie for a few seconds after wake: no reading until then.
    private var quietUntil = Date.distantPast
    /// Grants the owner pressed Grant for. Most answers reach a running helper
    /// only after a restart, so these restart when the owner comes back.
    private var asked: Set<String> = []
    private var askedAt = Date.distantPast
    /// The web process answered HTTP: past its boot. Updates never install before this.
    private var webReady = false
    private var updates: Updates?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // One Sundial per bundle id, and one per data folder: two would write one database.
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
            .filter { $0.processIdentifier != getpid() }
        if let first = others.first ?? otherAppOnThisFolder().flatMap({ NSRunningApplication(processIdentifier: $0) }) {
            log("already running (pid \(first.processIdentifier)); handing over")
            first.activate()
            exit(0)
        }
        try? FileManager.default.createDirectory(at: daemonDir, withIntermediateDirectories: true)
        try? "\(getpid())\n".write(to: pidFile, atomically: true, encoding: .utf8)

        // No menu bar shows for this app, but ⌘C, ⌘V and the rest only reach the
        // web view through an Edit menu's key equivalents: without one, paste does nothing.
        let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Redo", "redo:", "Z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
        }
        let editItem = NSMenuItem()
        editItem.submenu = edit
        NSApp.mainMenu = NSMenu()
        NSApp.mainMenu?.addItem(editItem)

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menu = NSMenu()
        statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Sundial", action: #selector(openFromMenu), keyEquivalent: "o"))
        if overlayConfig.enabled {
            let summon = NSMenuItem(title: "Summon Gnomon", action: #selector(Overlay.toggle), keyEquivalent: "")
            summon.target = overlay
            menu.addItem(summon)
        }
        if voiceKnockOn {
            let quiet = NSMenuItem(title: "Quiet for one hour", action: #selector(toggleQuiet), keyEquivalent: "")
            menu.addItem(quiet)
            quietItem = quiet
        }
        permissionsItem = NSMenuItem(title: "Permissions…", action: #selector(openPermissions), keyEquivalent: "")
        menu.addItem(permissionsItem)
        loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")
        menu.addItem(loginItem)
        // Only the self-contained app updates itself; a checkout updates with git.
        if repo == nil, let updates = Updates.start(ready: { [weak self] in self?.webReady == true }) {
            self.updates = updates
            let check = NSMenuItem(title: "Check for Updates…", action: #selector(Updates.checkForUpdates(_:)), keyEquivalent: "")
            check.target = updates
            menu.addItem(check)
            let daily = NSMenuItem(title: "Check for Updates Daily", action: #selector(Updates.toggleDailyCheck(_:)), keyEquivalent: "")
            daily.target = updates
            daily.state = updates.checksDaily ? .on : .off
            menu.addItem(daily)
        }
        let local = NSMenuItem(title: "Your data stays on this Mac", action: nil, keyEquivalent: "")
        local.isEnabled = false
        menu.addItem(local)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Sundial", action: #selector(quit), keyEquivalent: "q"))
        statusItem.menu = menu

        // The install asks for the login item once; after that the owner's own
        // toggle (here or in System Settings) is the answer, never overridden.
        if env["SUNDIAL_LOGIN_ITEM"] == "1", SMAppService.mainApp.status == .notRegistered {
            do { try SMAppService.mainApp.register() } catch { log("login item not registered: \(error)") }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            self?.quietUntil = Date().addingTimeInterval(10)
        }

        if overlayConfig.enabled { overlay.start() }
        voice.start()
        takeOverLaunchAgent()
        launcher.start()
        web.start()
        refresh()
        Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        showWhatsNew()
    }

    /// Once, after an update: what changed, and that macOS asks for the permissions again.
    private func showWhatsNew() {
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        guard let saved = UserDefaults.standard.dictionary(forKey: whatsNewKey), saved["build"] as? String == build else { return }
        let version = saved["version"] as? String
        UserDefaults.standard.removeObject(forKey: whatsNewKey)
        log("updated to \(version ?? "?")")
        openWindow(path: "/setup")
        guard let window else { return }
        let alert = NSAlert()
        alert.messageText = "Sundial is now version \(version ?? "")"
        let notes = (saved["notes"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        alert.informativeText = (notes.isEmpty ? "" : "\(notes)\n\n") + "Until Sundial is signed, every update is a new app to macOS, so it asks for the permissions again. Grant them on this page."
        alert.beginSheetModal(for: window)
    }

    private var setupDone: Bool { FileManager.default.fileExists(atPath: setupDoneFile.path) }

    private func markSetupDone() {
        guard !setupDone else { return }
        FileManager.default.createFile(atPath: setupDoneFile.path, contents: nil)
        log("setup done; the menu now warns about a lost grant")
    }

    /// The revoke monitor and the menu, every 5 s. Acts only on a change: a grant
    /// that comes back restarts what needs it; one that goes away shows in the
    /// menu, once setup is over (during setup the page is the one talking).
    private func refresh() {
        probeWeb()
        if Date() >= quietUntil {
            let now = reportedGrants()
            for grant in grants {
                let before = lastGrants[grant.key], after = now[grant.key]
                if before == false && after == true {
                    log("\(grant.label) came back")
                    restart(grant)
                } else if before == true && after == false {
                    log("\(grant.label) was taken away")
                }
            }
            lastGrants = now
            let needed = grants.filter { !$0.optional && now[$0.key] != nil }
            if !needed.isEmpty && needed.allSatisfy({ now[$0.key] == true }) { markSetupDone() }
        }
        let refused = setupDone ? grants.filter { !$0.optional && lastGrants[$0.key] == false }.map(\.label) : []
        let parts = [webReady ? "Running" : "Starting", helpersOn ? (launcher.running ? nil : "sensors off") : "sensors off"].compactMap { $0 }
        statusLine.title = refused.isEmpty ? parts.joined(separator: " · ") : "Needs \(refused.joined(separator: ", "))"
        permissionsItem.title = refused.isEmpty ? "Permissions…" : "Fix permissions…"
        let symbol = refused.isEmpty ? "sun.max" : "sun.max.trianglebadge.exclamationmark"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Sundial") ?? NSImage(systemSymbolName: "sun.max", accessibilityDescription: "Sundial")
        image?.isTemplate = true
        statusItem.button?.image = image
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
        let quiet = voice.quietUntil
        quietItem?.title = quiet.map { "Quiet until \(DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short))" } ?? "Quiet for one hour"
        quietItem?.state = quiet == nil ? .off : .on
    }

    @objc func toggleQuiet() {
        voice.toggleQuiet()
        refresh()
    }

    /// Any HTTP answer (401 included) means the web process is past its boot.
    private func probeWeb() {
        guard web.running, let url = URL(string: "http://127.0.0.1:\(webPort)/") else { webReady = false; return }
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            DispatchQueue.main.async { self?.webReady = response is HTTPURLResponse }
        }.resume()
    }

    /// Restart what needs this grant. Its report is cleared first, so the old
    /// "no" in the file never reads as a fresh change once the new helper answers.
    private func restart(_ grant: Grant) {
        try? FileManager.default.removeItem(at: daemonDir.appendingPathComponent(grant.file))
        lastGrants[grant.key] = nil
        for name in grant.helpers {
            switch name {
            case "launcher": launcher.restart()
            case "web": web.restart()
            default: restartHelper(name)
            }
        }
    }

    /// The owner is back from System Settings: restart what a Grant press was for.
    /// macOS's own prompt can bring the app forward first, hence the few seconds' grace.
    func applicationDidBecomeActive(_ notification: Notification) {
        guard Date().timeIntervalSince(askedAt) > 5 else { return }
        for grant in grants where asked.contains(grant.key) && lastGrants[grant.key] != true { restart(grant) }
        asked.removeAll()
    }

    // MARK: The page's bridge (window.webkit.messageHandlers.sundial)

    /// `{grant: key}` from a Grant button, `{setupDone: true}` from Open Today.
    /// Only Sundial's own pages load in this window, and only these keys are read.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard origin.host == "127.0.0.1", String(origin.port) == webPort, let body = message.body as? [String: Any] else { return }
        if body["setupDone"] as? Bool == true { markSetupDone() }
        if let key = body["grant"] as? String { requestGrant(key) }
    }

    /// Open the pane first, then ask macOS, so its prompt lands on top of Settings.
    private func requestGrant(_ key: String) {
        guard let pane = grants.first(where: { $0.key == key })?.pane ?? otherPanes[key],
              let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
        asked.insert(key)
        askedAt = Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            switch key {
            // No helper asks for Accessibility; this puts Sundial in the list, switched off.
            case "accessibility": _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            case "inputMonitoring": _ = CGRequestListenEventAccess()
            case "screenRecording": _ = CGRequestScreenCaptureAccess()
            default: break // Full Disk Access, Calendar, Location: macOS has no prompt to raise
            }
        }
    }

    @objc func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            log("login item: \(error)")
            // macOS wants the owner's approval in System Settings → General → Login Items.
            if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
        }
        refresh()
    }

    @objc func openPermissions() {
        openWindow(path: "/setup")
    }

    @objc func openFromMenu() {
        openWindow(path: nil)
    }

    private func openWindow(path: String?) {
        if window == nil {
            let config = WKWebViewConfiguration()
            config.userContentController.add(self, name: "sundial")
            let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: config)
            webView.navigationDelegate = self
            webView.uiDelegate = self
            let win = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            win.title = "Sundial"
            win.contentView = webView
            win.isReleasedWhenClosed = false
            win.delegate = self
            win.setFrameAutosaveName("SundialWindow")
            if !win.setFrameUsingName("SundialWindow") { win.center() }
            window = win
        }
        if let webView = window?.contentView as? WKWebView {
            if !signedIn || webView.url == nil {
                if let url = signInURL() {
                    webView.load(URLRequest(url: url))
                    signedIn = true
                } else {
                    webView.loadHTMLString("<body style='font:15px -apple-system;padding:40px;color:#555'>Sundial is starting. Open it again in a few seconds.</body>", baseURL: nil)
                }
            }
            if let path, signedIn, let url = URL(string: "http://127.0.0.1:\(webPort)\(path)") {
                // After the sign-in redirect has set the cookie, not before it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { webView.load(URLRequest(url: url)) }
            }
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    /// Only Sundial's own pages load in the window. Anything else — a System
    /// Settings pane from setup (`x-apple.systempreferences:`), a mail link, an
    /// outside site — goes to macOS, which opens it where it belongs.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        let own = url.host == "127.0.0.1" && url.port.map(String.init) == webPort
        if own || url.scheme == "about" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    /// A link meant for a new tab (`target=_blank`) opens in the default browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /// Closing hides; the app keeps running in the menu bar.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    /// A second launch, or a click on the app in Finder, opens the window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow(path: nil)
        return true
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The screen stage: every window Gnomon placed goes back where it was.
        looks.unplace([:], wait: true)
        web.stop()
        launcher.stop()
        try? FileManager.default.removeItem(at: pidFile)
    }
}

private let delegate = AppDelegate()
private let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)

@main enum Main {
    static func main() {
        // Everything Sundial writes is private to this user, as start.sh's `umask 077`.
        umask(0o077)
        let app = NSApplication.shared
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        // SIGTERM (`sundial stop`, logout) quits cleanly, children included.
        signal(SIGTERM, SIG_IGN)
        termSource.setEventHandler { NSApp.terminate(nil) }
        termSource.resume()
        app.run()
    }
}
