// sundial-screen-ocr-helper — P7 (docs/design/07)
//
// A persistent sidecar (spawned by the launcher only when `ocr.enabled` in
// $SUNDIAL_HOME/config.json) that periodically captures the focused window and a
// region around the cursor, runs on-device Vision OCR, derives lightweight
// topic tags, and writes the latest capture to `$SUNDIAL_HOME/.daemon/screen-ocr.json`
// (atomic tmp+rename). The TS `screen-ocr` sensor reads it; ALL text is
// sanitized at ingest downstream (this helper does no redaction itself — it
// only tags the focused app's processName so the sanitizer can clear
// sensitive/hidden apps, and the sensor drops sensitive/hidden captures).
//
// Screen Recording TCC. This helper was written assuming it would inherit the
// bundle's grant through the shared `dev.sundial.daemon` identity, the way the
// window helper's Accessibility grant works. Measured 2026-09-04: it does not.
// With Accessibility and Input Monitoring both granted and live under the same
// launch chain, `CGPreflightScreenCaptureAccess()` stayed false through a
// fresh grant of "Sundial", a re-add of the entry, and three process
// restarts. Screen Recording judges the REQUESTING binary, and only a prompt
// raised by that binary creates an entry that matches it. So the helper now
// (1) re-execs itself as a disclaimed child, so TCC attributes the request to
// this helper and not to whatever spawned it — the same SPI the calendar
// helper uses; the parent babysits the child so the launcher's SIGTERM still
// stops it — and
// (2) calls `CGRequestScreenCaptureAccess()` once when denied, which is what
// raises the prompt and writes the matching entry. ScreenCaptureKit's
// SCScreenshotManager is macOS 14+; guarded below.
//
// argv: [outFile, fullIntervalMs, cursorIntervalMs, cursorRegionPx]

import AppKit
import Carbon
import CoreGraphics
import Foundation
import ScreenCaptureKit
import Vision

/// Sundial's data folder: $SUNDIAL_HOME when set (test installs, CI), else ~/.sundial.
func sundialHome() -> URL {
    if let h = ProcessInfo.processInfo.environment["SUNDIAL_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".sundial")
}

// MARK: - Be responsible for yourself

private let DISCLAIM_MARKER = "SUNDIAL_OCR_DISCLAIMED"
private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer, Int32) -> Int32

/// Re-exec self as a CHILD process that is responsible for itself, and babysit
/// it: forward SIGTERM/SIGINT, wait, exit with its status. Returns only when the
/// hop could not be made, in which case the helper runs undisclaimed — today's
/// behaviour — rather than not at all.
///
/// A child, not an in-place exec. The first version used POSIX_SPAWN_SETEXEC to
/// keep one pid, and it measured as NOT disclaimed: under the launcher the
/// helper stayed denied while the same binary run from a terminal that itself
/// held Screen Recording was granted — i.e. TCC was still judging the parent.
/// The kernel assigns responsibility when a NEW process is created; replacing
/// the image keeps the old one.
var disclaimedChild: pid_t = 0

func execDisclaimed() {
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
    var environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") }
    environment.append(strdup("\(DISCLAIM_MARKER)=1"))
    environment.append(nil)
    defer {
        for pointer in argv where pointer != nil { free(pointer) }
        for pointer in environment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, arguments[0], nil, &attrs, argv, environment) == 0 else {
        FileHandle.standardError.write("sundial-screen-ocr-helper: disclaimed re-exec failed; running undisclaimed\n".data(using: .utf8)!)
        return
    }
    disclaimedChild = pid
    // The launcher stops the helper by signalling the pid it spawned — this one.
    // Pass it on, or the child outlives its parent as an orphan that keeps
    // capturing the screen after the launcher believes it stopped.
    signal(SIGTERM) { _ in kill(disclaimedChild, SIGTERM) }
    signal(SIGINT) { _ in kill(disclaimedChild, SIGINT) }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7F) == 0 ? (status >> 8) & 0xFF : 1)
}
execDisclaimed()

// MARK: - Snapshot model (mirrors the TS ScreenOcrSnapshot)

struct ScreenOcrSnapshot: Codable {
    let region: String
    let processName: String
    let bundleId: String?
    let text: String
    let topics: [String]
    let captureTimestamp: String
    /// Some app holds a secure text field. Written, not acted on: the TS sensor drops the capture.
    let secureInput: Bool
}

// MARK: - Args

let args = CommandLine.arguments
let outFile = args.count > 1 ? args[1] : (sundialHome().appendingPathComponent(".daemon/screen-ocr.json").path)
let fullIntervalMs = args.count > 2 ? (Int(args[2]) ?? 5000) : 5000
let cursorIntervalMs = args.count > 3 ? (Int(args[3]) ?? 1500) : 1500
// J3.3: when the launcher passes a fifth argument, each FULL capture also
// writes a downscaled JPEG of the window there (≤ 768 px, quality 0.6), for a
// LOCAL vision model to read. Empty = off. Never a cursor-region frame.
let framesFile = args.count > 5 ? args[5] : ""

func writeFrame(_ cgImage: CGImage) {
    guard !framesFile.isEmpty else { return }
    let side = max(cgImage.width, cgImage.height)
    let scale = side > 768 ? 768.0 / Double(side) : 1.0
    let w = max(1, Int(Double(cgImage.width) * scale))
    let h = max(1, Int(Double(cgImage.height) * scale))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return }
    ctx.interpolationQuality = .medium
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let small = ctx.makeImage() else { return }
    let rep = NSBitmapImageRep(cgImage: small)
    guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else { return }
    let tmp = framesFile + ".tmp"
    do {
        try data.write(to: URL(fileURLWithPath: tmp), options: .atomic)
        _ = try? FileManager.default.removeItem(atPath: framesFile)
        try FileManager.default.moveItem(atPath: tmp, toPath: framesFile)
    } catch {
        FileHandle.standardError.write("sundial-screen-ocr-helper: could not write frame: \(error)\n".data(using: .utf8)!)
    }
}
let cursorRegionPx = args.count > 4 ? (Int(args[4]) ?? 480) : 480

// MARK: - ISO timestamp

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

// MARK: - Topic classification (coarse keyword tags over OCR text + app)

func deriveTopics(text: String, appName: String) -> [String] {
    let lower = text.lowercased()
    var topics = Set<String>()
    let table: [(String, [String])] = [
        ("github", ["github.com", "pull request", "commits", " merge", "branch "]),
        ("jira", ["atlassian.net", "jira", "backlog", "sprint"]),
        ("terminal", ["$ ", "zsh", "bash", "% ", "npm ", "git "]),
        ("ai-chat", ["claude", "chatgpt", "gemini", "copilot"]),
        ("chat", ["slack", "message", "dm ", "teams"]),
        ("code", ["function ", "const ", "import ", "class ", "return ", "def "]),
        ("notes", ["obsidian", "# ", "todo", "- [ ]"]),
        ("email", ["inbox", "unread", "re:", "fwd:"]),
    ]
    for (topic, needles) in table where needles.contains(where: { lower.contains($0) }) {
        topics.insert(topic)
    }
    let app = appName.lowercased()
    if app.contains("code") || app.contains("xcode") || app.contains("cursor") { topics.insert("code") }
    if app.contains("chrome") || app.contains("safari") || app.contains("arc") { topics.insert("browser") }
    if app.contains("slack") || app.contains("teams") { topics.insert("chat") }
    return Array(topics).sorted()
}

// MARK: - OCR

func recognizeText(in cgImage: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    // `.accurate` with correction, in the two languages read on this screen.
    // `.fast` without correction misread small UI text badly enough that the
    // capture was mostly noise; accurate costs more CPU per frame, at the same
    // cadence.
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["en-US", "nl-NL"]
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    guard let observations = request.results else { return "" }
    let lines = observations.compactMap { $0.topCandidates(1).first?.string }
    // RAW, as of 2026-09-04: what to keep is decided in TypeScript
    // (`@sundial/rules/screen-text-filter`), per application, against the
    // previous capture — and audited. A filter here could not be measured,
    // could not be changed without a rebuild and a Screen Recording re-grant,
    // and was tuned for prose on a developer's screen. Only the size is bounded.
    return rawLines(lines).joined(separator: "\n")
}


/// Size bounds only. Empty and one-glyph observations are dropped; a line is
/// truncated at 200 characters; at most 200 lines are written per capture.
func rawLines(_ raw: [String], limit: Int = 200) -> [String] {
    var kept: [String] = []
    for line in raw {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else { continue }
        kept.append(trimmed.count > 200 ? String(trimmed.prefix(200)) : trimmed)
        if kept.count >= limit { break }
    }
    return kept
}

// MARK: - Capture

@available(macOS 14.0, *)
func captureFrontmost(cursorRegion: Bool) async -> (cgImage: CGImage, appName: String, bundleId: String?)? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }
    let appName = frontApp.localizedName ?? "unknown"
    let bundleId = frontApp.bundleIdentifier
    let frontPid = frontApp.processIdentifier

    guard let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) else { return nil }
    // Both captures below take ONLY the frontmost app's pixels. The text is filed
    // under that app's name, and ingest decides hidden/sensitive by that name, so
    // any other app's window (a password manager under the cursor, a floating
    // panel over the focused window) must never reach OCR under the wrong label.
    guard let frontSC = content.applications.first(where: { $0.processID == frontPid }) else { return nil }

    if cursorRegion {
        // A square region around the cursor on the display it's on.
        let mouse = NSEvent.mouseLocation // bottom-left origin, global
        guard let display = content.displays.first(where: { NSPointInRect(mouse, $0.frame) }) ?? content.displays.first else { return nil }
        let filter = SCContentFilter(display: display, including: [frontSC], exceptingWindows: [])
        let config = SCStreamConfiguration()
        let side = max(64, cursorRegionPx)
        // Convert mouse (bottom-left) to the display's top-left capture space.
        let localX = mouse.x - display.frame.minX
        let localYTop = display.frame.maxY - mouse.y
        let rect = CGRect(x: localX - Double(side) / 2, y: localYTop - Double(side) / 2, width: Double(side), height: Double(side))
        config.sourceRect = rect.intersection(CGRect(x: 0, y: 0, width: Double(display.width), height: Double(display.height)))
        // sourceRect is in points; the output size is in pixels. Asking for the
        // point size halves the resolution on a Retina display.
        let scale = CGFloat(SCShareableContent.info(for: filter).pointPixelScale)
        config.width = Int(CGFloat(side) * scale)
        config.height = Int(CGFloat(side) * scale)
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else { return nil }
        return (image, appName, bundleId)
    }

    // Full focused window: the frontmost app's largest on-screen window.
    //
    // The frame checks below pick a sensible capture target; they are NOT what keeps
    // this helper alive. That job belongs to the display-based filter further down —
    // see the comment there for the abort these checks were first written, wrongly,
    // to prevent. They still earn their place: skipping non-finite, sub-point and
    // off-screen frames avoids cropping to a rect that yields no pixels, and keeps
    // the "largest window" choice meaningful.
    let displayFrames = content.displays.map { $0.frame }
    let windows = content.windows.filter { window in
        guard window.owningApplication?.processID == frontPid, window.isOnScreen else { return false }
        let frame = window.frame
        guard frame.width.isFinite, frame.height.isFinite, frame.width >= 1, frame.height >= 1 else { return false }
        guard frame.width * frame.height > 10_000 else { return false }
        return displayFrames.contains { $0.intersects(frame) }
    }
    guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return nil }

    // Capture the window's DISPLAY and crop to the window's rect, rather than
    // filtering on the window itself.
    //
    // `SCContentFilter(desktopIndependentWindow:)` is the obvious API here and it
    // aborts the process on macOS 26: it hands the window rect to SkyLight's
    // SLSGetDisplaysWithRect, which calls __assert_rtn rather than returning an
    // error. Validating the frame first does not avoid it — a guard requiring a
    // finite, on-screen, display-intersecting frame was tried and the same abort
    // reproduced immediately, so the trigger is not something callers can screen
    // for. The display-based filter below takes a different path through
    // ScreenCaptureKit and is the same one the cursor-region branch above already
    // uses without incident.
    let windowFrame = window.frame
    guard let display = content.displays.first(where: { $0.frame.intersects(windowFrame) }) ?? content.displays.first else { return nil }
    let filter = SCContentFilter(display: display, including: [frontSC], exceptingWindows: [])
    let config = SCStreamConfiguration()
    // SCDisplay.frame and SCWindow.frame share a global, bottom-left-origin space;
    // sourceRect wants display-local coordinates with a top-left origin.
    let localX = windowFrame.minX - display.frame.minX
    let localYTop = display.frame.maxY - windowFrame.maxY
    let cropped = CGRect(x: localX, y: localYTop, width: windowFrame.width, height: windowFrame.height)
        .intersection(CGRect(x: 0, y: 0, width: Double(display.width), height: Double(display.height)))
    guard !cropped.isNull, cropped.width >= 1, cropped.height >= 1 else { return nil }
    config.sourceRect = cropped
    // Pixels, not points; see the cursor branch.
    let scale = CGFloat(SCShareableContent.info(for: filter).pointPixelScale)
    config.width = max(1, Int(cropped.width * scale))
    config.height = max(1, Int(cropped.height * scale))
    guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else { return nil }
    return (image, appName, bundleId)
}

// MARK: - Write (atomic tmp+rename, mirrors the AV sidecar)

let writeQueue = DispatchQueue(label: "dev.sundial.screen-ocr.write")

func writeSnapshot(_ snapshot: ScreenOcrSnapshot) {
    writeQueue.sync {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let tmp = outFile + ".tmp"
        try? data.write(to: URL(fileURLWithPath: tmp))
        try? FileManager.default.removeItem(atPath: outFile)
        try? FileManager.default.moveItem(atPath: tmp, toPath: outFile)
    }
}

func captureAndWrite(cursorRegion: Bool) {
    guard #available(macOS 14.0, *) else { return }
    Task {
        guard let shot = await captureFrontmost(cursorRegion: cursorRegion) else { return }
        if !cursorRegion { writeFrame(shot.cgImage) }
        let text = recognizeText(in: shot.cgImage).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return }
        let snapshot = ScreenOcrSnapshot(
            region: cursorRegion ? "cursor" : "focused",
            processName: shot.appName,
            bundleId: shot.bundleId,
            text: text,
            topics: deriveTopics(text: text, appName: shot.appName),
            captureTimestamp: isoFormatter.string(from: Date()),
            secureInput: IsSecureEventInputEnabled()
        )
        writeSnapshot(snapshot)
    }
}

// MARK: - Main loop

guard #available(macOS 14.0, *) else {
    FileHandle.standardError.write("sundial-screen-ocr-helper requires macOS 14+\n".data(using: .utf8)!)
    exit(0)
}

// MARK: - Say so when we cannot see
//
// `SCScreenshotManager.captureImage` returns nil without Screen Recording
// permission, and every caller above swallows the nil. The helper therefore ran
// for weeks, wrote nothing, and looked exactly like a quiet screen. This checks
// the permission on a timer and writes the answer to a SIBLING file — not the
// snapshot file, whose shape the sensor owns — so the Instruments can show
// "denied" instead of "quiet 16 days". Adhoc-signed helpers are granted by
// cdhash, so every rebuild of this binary is a fresh denial until re-granted.
let statusFile = URL(fileURLWithPath: outFile).deletingLastPathComponent().appendingPathComponent("screen-ocr-status.json").path
var lastReportedGranted: Bool? = nil

var requestedAccess = false

func reportAccess() {
    let granted = CGPreflightScreenCaptureAccess()
    // Denied and never asked: ask. This is the call that raises the system
    // prompt and, whatever the owner answers, writes the entry for THIS binary
    // into Privacy & Security → Screen Recording — the one a hand-added
    // "Sundial" entry never matched. Once per process; the answer is
    // re-read by preflight on the next tick.
    if !granted && !requestedAccess {
        requestedAccess = true
        _ = CGRequestScreenCaptureAccess()
    }
    if granted == lastReportedGranted { return }
    lastReportedGranted = granted
    let disclaimed = ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil
    let json = "{\"accessGranted\":\(granted),\"disclaimed\":\(disclaimed),\"checkedAt\":\"\(isoFormatter.string(from: Date()))\"}\n"
    try? json.data(using: .utf8)?.write(to: URL(fileURLWithPath: statusFile))
    FileHandle.standardError.write("sundial-screen-ocr-helper: screen recording \(granted ? "granted" : "DENIED — grant Sundial in Privacy & Security → Screen Recording")\n".data(using: .utf8)!)
}
reportAccess()
let accessTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in reportAccess() }
RunLoop.main.add(accessTimer, forMode: .common)

let fullTimer = Timer.scheduledTimer(withTimeInterval: Double(fullIntervalMs) / 1000, repeats: true) { _ in
    if lastReportedGranted == true { captureAndWrite(cursorRegion: false) }
}
let cursorTimer = Timer.scheduledTimer(withTimeInterval: Double(cursorIntervalMs) / 1000, repeats: true) { _ in
    if lastReportedGranted == true { captureAndWrite(cursorRegion: true) }
}
RunLoop.main.add(fullTimer, forMode: .common)
RunLoop.main.add(cursorTimer, forMode: .common)
if lastReportedGranted == true { captureAndWrite(cursorRegion: false) }
RunLoop.main.run()
