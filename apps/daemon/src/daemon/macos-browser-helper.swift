// sundial-browser-helper — the URL of the browser tab the owner is looking at.
//
// Window titles are all Gnomon had of the browser, and a title is arbitrary
// prose: it cannot say which site, which document, which ticket. The URL can,
// and only the browser knows it. Browsers expose the active tab over Apple
// Events (AppleScript), which macOS gates behind the Automation permission —
// one prompt per (this helper, that browser), answered by the owner once.
//
// Same identity story as the calendar helper (CLAUDE.md macOS note 6): TCC asks
// who is RESPONSIBLE for the process, and a child of node is judged as node's
// terminal. The helper re-execs itself once, disclaimed, so the prompt names
// Gnomon and the grant sticks to this binary; the embedded __info_plist carries
// the usage string TCC requires.
//
// Persistent: spawned by the node `browser` sensor, polls every 2 s, writes
// $SUNDIAL_HOME/.daemon/browser-info.json when the tab CHANGES, and exits when its
// parent is gone. It never writes a query string or fragment — the sensor
// strips them again, but a secret in a URL should not exist on disk at all.
// Private windows are skipped: the owner opened one to be unobserved.
import AppKit
import Foundation

/// Sundial's data folder: $SUNDIAL_HOME when set (test installs, CI), else ~/.sundial.
func sundialHome() -> URL {
    if let h = ProcessInfo.processInfo.environment["SUNDIAL_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".sundial")
}

private let DISCLAIM_MARKER = "SUNDIAL_BROWSER_DISCLAIMED"
private var childPid: pid_t = 0
private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer, Int32) -> Int32

func reexecDisclaimed() {
    if ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil { return }
    guard let handle = dlopen(nil, RTLD_NOW) else { return }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return }
    defer { posix_spawnattr_destroy(&attrs) }
    guard withUnsafeMutablePointer(to: &attrs, { setDisclaim(UnsafeMutableRawPointer($0), 1) }) == 0 else { return }

    let arguments = CommandLine.arguments
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    var environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment
        .map { strdup("\($0.key)=\($0.value)") }
    environment.append(strdup("\(DISCLAIM_MARKER)=1"))
    environment.append(nil)
    defer {
        for pointer in argv where pointer != nil { free(pointer) }
        for pointer in environment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, arguments[0], nil, &attrs, argv, environment) == 0 else { return }

    // The parent of the disclaimed copy is THIS process. If node kills us, the
    // child must not outlive us: forward the common termination signals.
    childPid = pid
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { _ in
            if childPid > 0 { kill(childPid, SIGTERM) }
            exit(0)
        }
    }

    var status: Int32 = 0
    waitpid(pid, &status, 0)
    exit((status & 0x7F) == 0 ? (status >> 8) & 0xFF : 1)
}

// MARK: - Browsers

/// Bundle id → how to ask for the active tab. Chromium-family browsers share
/// Chrome's scripting dictionary; Safari has its own.
enum Family { case chromium, safari
    case arc
}

private let BROWSERS: [String: (name: String, family: Family)] = [
    "com.google.Chrome": ("Google Chrome", .chromium),
    "com.google.Chrome.canary": ("Google Chrome Canary", .chromium),
    "com.brave.Browser": ("Brave Browser", .chromium),
    "com.microsoft.edgemac": ("Microsoft Edge", .chromium),
    "com.vivaldi.Vivaldi": ("Vivaldi", .chromium),
    // Arc has no `mode` on its windows (Chrome's incognito flag): the same
    // tab script minus that property, else -1700 on every read.
    "company.thebrowser.Browser": ("Arc", .arc),
    "com.apple.Safari": ("Safari", .safari),
]

struct TabRead {
    let url: String
    let title: String
    let incognito: Bool
}

/// Ask the frontmost browser for its active tab. nil when the browser has no
/// window, the script failed for a non-permission reason, or the tab is private.
/// Throws a permission marker when Apple Events are not authorized (-1743).
enum ReadError: Error { case notAuthorized(String), failed(String) }

func readActiveTab(bundleId: String, family: Family) throws -> TabRead? {
    let source: String
    switch family {
    case .chromium:
        source = """
        tell application id "\(bundleId)"
            if (count of windows) is 0 then return "" & linefeed & "" & linefeed & "none"
            set w to front window
            set t to active tab of w
            return (URL of t) & linefeed & (title of t) & linefeed & (mode of w)
        end tell
        """
    case .arc:
        // Arc coerces a STORED window reference badly (-1700 on `active tab of w`);
        // the chained tell form resolves it in one step and works.
        // By NAME, not bundle id: inside NSAppleScript, `application id` left Arc's
        // terminology unresolved («class \0\0\0\0»), while the same script by name
        // and every variant through osascript worked.
        source = """
        tell application "Arc"
            if (count of windows) is 0 then return "" & linefeed & "" & linefeed & "none"
            tell front window to tell active tab to return (URL & linefeed & title & linefeed & "normal")
        end tell
        """
    case .safari:
        source = """
        tell application id "\(bundleId)"
            if (count of documents) is 0 then return "" & linefeed & "" & linefeed & "none"
            return (URL of front document) & linefeed & (name of front document) & linefeed & "normal"
        end tell
        """
    }
    var errorInfo: NSDictionary?
    guard let script = NSAppleScript(source: source) else { throw ReadError.failed("script did not compile") }
    let result = script.executeAndReturnError(&errorInfo)
    if let info = errorInfo {
        let number = (info[NSAppleScript.errorNumber] as? Int) ?? 0
        let message = (info[NSAppleScript.errorMessage] as? String) ?? "unknown"
        // -1743: not authorized to send Apple Events. -600: app not running.
        if number == -1743 { throw ReadError.notAuthorized(message) }
        throw ReadError.failed("\(number): \(message)")
    }
    guard let text = result.stringValue else { return nil }
    let parts = text.components(separatedBy: "\n")
    guard parts.count >= 3 else { return nil }
    let url = parts[0].trimmingCharacters(in: .whitespacesAndNewlines)
    if url.isEmpty || parts[2] == "none" { return nil }
    return TabRead(url: url, title: parts[1], incognito: parts[2].lowercased().contains("incognito"))
}

/// Origin + path only. A query or fragment is where a token lives; it never
/// reaches disk. `file:` and other odd schemes are reported as their scheme
/// alone — a local path is the window sensor's business, sanitized there.
func stripQuery(_ raw: String) -> String {
    guard let components = URLComponents(string: raw), let scheme = components.scheme else { return "" }
    if scheme != "http" && scheme != "https" { return "\(scheme):" }
    var out = URLComponents()
    out.scheme = scheme
    out.host = components.host
    out.port = components.port
    out.path = components.path
    return out.string ?? ""
}

// MARK: - Output

struct Snapshot: Codable {
    let timestamp: String
    let app: String?
    let bundleId: String?
    let url: String?
    let title: String?
    let authorized: Bool
    let error: String?
    let disclaimed: Bool
    /// J3.4: the page's visible text (whitespace-collapsed, ≤ 6000 chars), only with `--page-text`
    /// and only when the browser allows JavaScript from Apple Events; `textError` says why not.
    var text: String? = nil
    var textError: String? = nil
}

/// J3.4 — the page's own words, read through the same Apple Events door as the
/// URL. Chromium needs View → Developer → "Allow JavaScript from Apple Events";
/// Safari needs Develop → "Allow JavaScript from Apple Events". Denied: an
/// error, never a crash. The query string never enters: only `document.body.innerText`.
let wantPageText = CommandLine.arguments.contains("--page-text")

func readPageText(bundleId: String, family: Family) -> (text: String?, error: String?) {
    let js = "document.body ? document.body.innerText.slice(0, 20000) : ''"
    let source: String
    switch family {
    case .chromium:
        source = "tell application id \"\(bundleId)\" to execute active tab of front window javascript \"\(js)\""
    case .arc:
        source = "tell application \"Arc\" to tell window 1 to tell active tab to execute javascript \"\(js)\""
    case .safari:
        source = "tell application id \"\(bundleId)\" to do JavaScript \"\(js)\" in front document"
    }
    var errorInfo: NSDictionary?
    guard let script = NSAppleScript(source: source) else { return (nil, "script did not compile") }
    let result = script.executeAndReturnError(&errorInfo)
    if let info = errorInfo {
        let message = (info[NSAppleScript.errorMessage] as? String) ?? "unknown"
        return (nil, message)
    }
    guard let raw = result.stringValue else { return (nil, nil) }
    // NSAppleScript hands a JavaScript string back as a quoted literal with
    // escapes ("…\n…"); decode it as the JSON string it is, else use it as is.
    var unwrapped = raw
    if raw.hasPrefix("\""), raw.hasSuffix("\""), let data = "[\(raw)]".data(using: .utf8), let decoded = (try? JSONSerialization.jsonObject(with: data)) as? [String], let first = decoded.first {
        unwrapped = first
    }
    let collapsed = unwrapped.replacingOccurrences(of: "[\\s]+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    if collapsed.isEmpty { return (nil, nil) }
    return (String(collapsed.prefix(6000)), nil)
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func outputPath() -> String {
    return sundialHome().appendingPathComponent(".daemon/browser-info.json").path
}

func writeSnapshot(_ snapshot: Snapshot) {
    let path = outputPath()
    do {
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(snapshot)
        let tmp = path + ".tmp"
        try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
        _ = try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.moveItem(atPath: tmp, toPath: path)
    } catch {
        FileHandle.standardError.write("browser-helper: could not write snapshot: \(error)\n".data(using: .utf8)!)
    }
}

/// The frontmost app's bundle id. NSWorkspace first; when it has nothing, the
/// window helper's own snapshot, which is written every second by a process
/// that holds Accessibility and is never wrong about who is in front.
func frontmostBundleId() -> String? {
    if let front = NSWorkspace.shared.frontmostApplication, let id = front.bundleIdentifier { return id }
    let path = sundialHome().appendingPathComponent(".daemon/window-info.json").path
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let id = json["bundleId"] as? String else { return nil }
    return id
}

func main() {
    reexecDisclaimed()

    let interval: TimeInterval = 2.0
    var lastKey = ""
    var lastHeartbeat = Date.distantPast

    while true {
        // The node sensor is the parent (of the un-disclaimed copy, which
        // forwards signals). If the whole chain is gone, stop.
        if getppid() == 1 { exit(0) }

        let now = Date()
        var snapshot: Snapshot? = nil
        var key = "none"

        if let bundleId = frontmostBundleId(), let browser = BROWSERS[bundleId] {
            do {
                if let tab = try readActiveTab(bundleId: bundleId, family: browser.family), !tab.incognito {
                    let url = stripQuery(tab.url)
                    key = "\(bundleId)|\(url)"
                    var withTab = Snapshot(timestamp: isoFormatter.string(from: now), app: browser.name, bundleId: bundleId, url: url, title: tab.title, authorized: true, error: nil, disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
                    if wantPageText && key != lastKey {
                        let page = readPageText(bundleId: bundleId, family: browser.family)
                        withTab.text = page.text
                        withTab.textError = page.error
                    }
                    snapshot = withTab
                } else {
                    key = "\(bundleId)|private-or-empty"
                    snapshot = Snapshot(timestamp: isoFormatter.string(from: now), app: browser.name, bundleId: bundleId, url: nil, title: nil, authorized: true, error: nil, disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
                }
            } catch ReadError.notAuthorized(let message) {
                key = "\(bundleId)|unauthorized"
                snapshot = Snapshot(timestamp: isoFormatter.string(from: now), app: browser.name, bundleId: bundleId, url: nil, title: nil, authorized: false, error: message, disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
            } catch {
                key = "\(bundleId)|error"
                snapshot = Snapshot(timestamp: isoFormatter.string(from: now), app: browser.name, bundleId: bundleId, url: nil, title: nil, authorized: true, error: "\(error)", disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
            }
        } else {
            snapshot = Snapshot(timestamp: isoFormatter.string(from: now), app: nil, bundleId: nil, url: nil, title: nil, authorized: true, error: nil, disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
        }

        // Write on change, and at least every 30 s so the sensor can tell a
        // quiet helper from a dead one by mtime.
        if key != lastKey || now.timeIntervalSince(lastHeartbeat) >= 30 {
            if let s = snapshot { writeSnapshot(s) }
            lastKey = key
            lastHeartbeat = now
        }
        // A run loop, not a sleep: NSWorkspace learns about activation changes
        // through notifications delivered on the run loop, and a process that
        // never pumps one keeps answering with the app that was frontmost when
        // it started — which is how this helper spent an evening reporting
        // "no browser" over an open YouTube tab.
        RunLoop.main.run(until: Date().addingTimeInterval(interval))
    }
}

main()
