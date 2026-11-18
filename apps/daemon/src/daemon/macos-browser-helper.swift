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
import ApplicationServices
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

    // A parent killed hard (SIGKILL) sends no signal to forward; the child then kept the mic open as an orphan (2026-11-13).
    Thread.detachNewThread { while true { sleep(2); if getppid() == 1 { kill(childPid, SIGTERM); exit(0) } } }
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
    /// S4: a Firefox-family window's own title, which Node checks against the session's front tab too (Fable M2).
    var windowTitle: String? = nil
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

// MARK: - Firefox family (S4)

/// Firefox-family browsers have no Apple Events tab API: the node sensor reads their tab from the session file. Their page's words come
/// from Accessibility, the web area's text, with `--page-text-ax` only (config browser.pageTextAx). Node keeps them only when the title
/// is the session's front tab's, and a private window is never in the session file. The two the session reader knows.
let FIREFOX: Set<String> = ["app.zen-browser.zen", "org.mozilla.firefox"]
let wantPageTextAx = CommandLine.arguments.contains("--page-text-ax")

/// Fable M2: a window whose page is never read: a title that cannot be read or says nothing (fail closed), or one that says private
/// in any of the browsers' languages (Private Browsing, privénavigatie, privado, InPrivate, incognito).
func pageRefused(_ windowTitle: String?) -> Bool {
    let title = (windowTitle ?? "").trimmingCharacters(in: .whitespaces)
    return title.isEmpty || title.range(of: #"privat|privé|privad|приват|inprivate|incognito"#, options: [.regularExpression, .caseInsensitive]) != nil
}

/// L1: a page read again while it gave nothing or little (the tree still building), at most `tries` reads in all.
func pageAgain(text: String?, reads: Int, tries: Int = 3) -> Bool {
    reads < tries && (text?.count ?? 0) < 200
}

/// The page's words as the Apple Events path keeps them: white space collapsed, joined by a space, at most `max` characters.
func pageJoin(_ parts: [String], max: Int) -> String {
    var out = ""
    for part in parts {
        let words = part.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if words.isEmpty { continue }
        out += (out.isEmpty ? "" : " ") + words
        if out.count >= max { break }
    }
    return String(out.prefix(max))
}

private func axGet(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func axKids(_ element: AXUIElement) -> [AXUIElement] {
    ((axGet(element, kAXChildrenAttribute) as? [AnyObject]) ?? []).compactMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
}

/// The focused window's first web area: its title and the words of its static texts, in reading order, bounded by characters, nodes
/// and time. nil: no window, a private one, no web area. A secure field is no static text and is never read.
func axPageText(_ pid: pid_t, max: Int = 6000) -> (title: String, text: String, url: String)? {
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.25)
    guard let w = axGet(root, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
    let window = w as! AXUIElement
    if pageRefused(axGet(window, kAXTitleAttribute) as? String) { return nil }
    let deadline = Date().addingTimeInterval(1.0)
    var queue = [window], area: AXUIElement?, visited = 0
    while !queue.isEmpty, area == nil, visited < 2000, Date() < deadline {
        let node = queue.removeFirst()
        visited += 1
        if axGet(node, kAXRoleAttribute) as? String == "AXWebArea" { area = node } else { queue += axKids(node) }
    }
    guard let area else { return nil }
    var stack = [area], parts: [String] = [], chars = 0
    visited = 0
    while let node = stack.popLast(), chars < max, visited < 5000, Date() < deadline {
        visited += 1
        if axGet(node, kAXRoleAttribute) as? String == "AXStaticText", let text = axGet(node, kAXValueAttribute) as? String {
            parts.append(text)
            chars += text.count + 1
        }
        stack += axKids(node).reversed()
    }
    let url = (axGet(area, "AXURL") as? URL)?.absoluteString ?? axGet(area, "AXURL") as? String ?? ""
    // Gecko names its document in AXDescription, Chromium in AXTitle.
    let name = [kAXTitleAttribute, kAXDescriptionAttribute].lazy.compactMap { axGet(area, $0) as? String }.first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } ?? ""
    return (pageJoin([name], max: 300), pageJoin(parts, max: max), url)
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
    /// S4: the last Firefox-family page read, kept across heartbeats so the file keeps it while the page stays; `reads` (L1) and the
    /// page's AXURL, so a page that gave little is read again and a new page under the same title starts over.
    var firefox: (key: String, url: String, reads: Int, title: String?, text: String?, error: String?) = ("", "", 0, nil, nil, nil)
    /// Fable H1: Gecko builds its tree only after AXEnhancedUserInterface; set once per browser run.
    var woken: Set<pid_t> = []

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
        } else if wantPageTextAx, let front = NSWorkspace.shared.frontmostApplication, let bundleId = front.bundleIdentifier, FIREFOX.contains(bundleId) {
            // `app` stays nil: the sensor takes the tab from the session file, and these words only when the titles agree.
            let pid = front.processIdentifier
            let root = AXUIElementCreateApplication(pid)
            let title = axGet(root, kAXFocusedWindowAttribute).flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? axGet($0 as! AXUIElement, kAXTitleAttribute) as? String : nil }
            key = "\(bundleId)|ax|\(title ?? "")"
            if key != firefox.key { firefox = (key, "", 0, nil, nil, nil) }
            if pageRefused(title) {
                firefox = (key, "", 3, nil, nil, nil)
            } else if !AXIsProcessTrusted() {
                // Fable M5: no prompt from this loop; setup asks once. The file says why there are no words.
                firefox = (key, "", 3, nil, nil, "accessibility not granted")
            } else if pageAgain(text: firefox.text, reads: firefox.reads) {
                if woken.insert(pid).inserted, axGet(root, "AXEnhancedUserInterface") as? Bool != true {
                    AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
                }
                let page = axPageText(pid)
                let reads = page != nil && page!.url != firefox.url && !firefox.url.isEmpty ? 1 : firefox.reads + 1
                firefox = (key, page?.url ?? firefox.url, reads, page?.title, page.map(\.text).flatMap { $0.isEmpty ? nil : $0 }, nil)
            }
            var withText = Snapshot(timestamp: isoFormatter.string(from: now), app: nil, bundleId: bundleId, url: nil, title: firefox.title, authorized: true, error: nil, disclaimed: ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil)
            withText.text = firefox.text
            withText.textError = firefox.error
            withText.windowTitle = firefox.text == nil ? nil : title
            // A page read again writes when its words grew.
            key += "|\(firefox.text?.count ?? 0)"
            snapshot = withText
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

#if BROWSER_SELFCHECK
// swiftc -D BROWSER_SELFCHECK apps/daemon/src/daemon/macos-browser-helper.swift -o "$TMPDIR/browser-check" && "$TMPDIR/browser-check" [pid]
// With a pid (a window of your own): the page read's sizes, never its words.
var failed = 0
func check(_ ok: Bool, _ what: String) { if !ok { failed += 1; print("FAIL " + what) } }
check(pageJoin(["  Invoice \n BOX-484 ", "", "for  Puzzlebox Studio"], max: 6000) == "Invoice BOX-484 for Puzzlebox Studio", "white space collapsed, empty parts skipped")
check(pageJoin([String(repeating: "a", count: 4000), String(repeating: "b", count: 4000)], max: 6000).count == 6000 && pageJoin(["abc"], max: 0) == "", "bounded")
check(pageRefused("Lunch Thursday - Mozilla Firefox Private Browsing") && pageRefused("Lunch - Zen Browser private browsing") && pageRefused("Lunch - Mozilla Firefox-privénavigatie") && !pageRefused("Lunch Thursday - Zen Browser"), "a private window by its title")
check(pageRefused("Mira - Firefox (navegación privada)") && pageRefused("Mira - Navegação privada") && pageRefused("Mira - Приватный просмотр") && pageRefused("Mira - InPrivate") && pageRefused("Mira - Incognito") && pageRefused("Mira - Privater Modus"), "the private words of other languages")
check(pageRefused(nil) && pageRefused("") && pageRefused("   ") && !pageRefused("Invoice BOX-484"), "a title that cannot be read, or says nothing, is refused")
check(FIREFOX == ["app.zen-browser.zen", "org.mozilla.firefox"], "the Firefox family the session reader knows")
check(pageAgain(text: nil, reads: 0) && pageAgain(text: "short", reads: 2) && !pageAgain(text: nil, reads: 3) && !pageAgain(text: String(repeating: "w", count: 200), reads: 1), "a page that gave little is read again, three reads in all")
if CommandLine.arguments.count > 1, let pid = pid_t(CommandLine.arguments[1]) {
    let page = axPageText(pid)
    print("page read: \(page == nil ? "none" : "title \(page!.title.count) chars, text \(page!.text.count) chars, url \(page!.url.count) chars")")
}
print(failed == 0 ? "browser self-check: ok" : "browser self-check: \(failed) failed")
exit(failed == 0 ? 0 : 1)
#else
main()
#endif
