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
#if canImport(Sparkle)
import Sparkle
#endif
import ServiceManagement
import WebKit

private func log(_ message: String) {
    FileHandle.standardError.write("[sundial-app] \(message)\n".data(using: .utf8)!)
}

/// The data folder: the bundle's own folder when it was installed into one.
private let home: URL = {
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
private let resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Resources")
private let daemonDir = home.appendingPathComponent(".daemon")

/// A path from the environment, else from Contents/Resources (what `apps/macos/build.sh` writes).
private func setting(_ key: String, file: String) -> String? {
    if let value = env[key], !value.isEmpty { return value }
    return (try? String(contentsOf: resources.appendingPathComponent(file), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The checkout to run, or nil: then the app runs its own Resources/app.
private let repo = setting("SUNDIAL_REPO", file: "repo-path")
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
// Downloads happen in the background. The install waits until the web process
// answers, so an update never cuts into Node's boot, then relaunches the app.
// The notes of what was installed are kept for the next launch ("what's new").
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
}
#endif

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
        web.stop()
        launcher.stop()
        try? FileManager.default.removeItem(at: pidFile)
    }
}

// Everything Sundial writes is private to this user, as start.sh's `umask 077`.
umask(0o077)
private let app = NSApplication.shared
private let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
// SIGTERM (`sundial stop`, logout) quits cleanly, children included.
signal(SIGTERM, SIG_IGN)
private let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { NSApp.terminate(nil) }
termSource.resume()
app.run()
