// macos-input-helper.swift
// Counts keyboard / mouse / scroll events globally and writes a 1-second
// rolling-window summary to a JSON file. We never read keycodes,
// characters, button identities, or coordinates — only counts.
// Set 3: a hardware key or click also rewrites the file at once (at most every 100 ms) with the newer
// lastKeyAt/lastClickAt and the last window's counts and timestamp unchanged, so the owner's hand is seen
// within ~100 ms (owner-hand.js reads this file before each screen step) and no count is read twice.
//
// Uses CGEventTap (.listenOnly) so keyboard counts honor the Input Monitoring
// TCC grant (ListenEvent). NSEvent global monitors require Accessibility for
// keyDown and silently return nil when the tap cannot be created.
//
// Compiled into $SUNDIAL_HOME/Sundial.app/Contents/MacOS/sundial-input-helper,
// started as a sidecar by the daemon launcher (alongside sundial-window-helper).
//
// Usage: sundial-input-helper /path/to/input-activity.json

import ApplicationServices
import Foundation

struct InputActivity: Codable {
    let timestamp: String
    let windowMs: Int
    let keyDownCount: Int
    let mouseClickCount: Int
    let mouseMoveCount: Int
    let scrollCount: Int
    let lastEventAt: String?
    /// CGPreflightListenEventAccess() — Input Monitoring grant present.
    let listenAccessGranted: Bool
    /// CGEventTap is installed and enabled.
    let tapActive: Bool
    /// Set 2 R5: the owner's hand alone. Keys and clicks that came from the hardware (see `isHardware`), this second.
    let ownerKeyDownCount: Int
    let ownerClickCount: Int
    /// The last hardware key and click since the helper started (nil until one), kept across seconds.
    let lastKeyAt: String?
    let lastClickAt: String?
    /// The four fields above are written: a reader may trust them as the owner's hand, with no by-Gnomon filtering.
    let ownerOnly: Bool
}

/// Set 2 R5: an event the hardware made, not one a process posted. The HID system posts real keys and clicks with
/// the HID system state (1); Gnomon's own acts post from a private state (ScreenLook `aim` and `keys`), and a
/// tool posting with a NULL or combined-session source carries 0. The same split the app already trusts for "the
/// owner moved" (AppChannel `secondsSinceLastEventType(.hidSystemState, ...)`). Not the poster's pid: a hardware
/// event's pid field is not documented, the state id is. Known limit: a process that posts from a
/// `.hidSystemState` source reads as the owner.
func isHardware(_ event: CGEvent) -> Bool {
    event.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue)
}

final class Counter {
    private let lock = NSLock()
    var keyDown = 0
    var clicks = 0
    var moves = 0
    var scrolls = 0
    var lastEventAt: Date?
    var ownerKeyDown = 0
    var ownerClicks = 0
    /// Never reset: the file always says when the owner last pressed a key or clicked.
    var lastKeyAt: Date?
    var lastClickAt: Date?

    func record(type: CGEventType, hardware: Bool) {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        lastEventAt = now
        switch type {
        case .keyDown:
            keyDown += 1
            if hardware { ownerKeyDown += 1; lastKeyAt = now }
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            clicks += 1
            if hardware { ownerClicks += 1; lastClickAt = now }
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
            moves += 1
        case .scrollWheel:
            scrolls += 1
        default:
            break
        }
    }

    /// The owner's last hardware key and click, read without touching the counts.
    func hand() -> (lastKeyAt: Date?, lastClickAt: Date?) {
        lock.lock()
        defer { lock.unlock() }
        return (lastKeyAt, lastClickAt)
    }

    func snapshotAndReset() -> (keyDown: Int, clicks: Int, moves: Int, scrolls: Int, lastEventAt: Date?, ownerKeyDown: Int, ownerClicks: Int, lastKeyAt: Date?, lastClickAt: Date?) {
        lock.lock()
        defer { lock.unlock() }
        let snap = (keyDown, clicks, moves, scrolls, lastEventAt, ownerKeyDown, ownerClicks, lastKeyAt, lastClickAt)
        keyDown = 0
        clicks = 0
        moves = 0
        scrolls = 0
        lastEventAt = nil
        ownerKeyDown = 0
        ownerClicks = 0
        return snap
    }
}

let counter = Counter()
var activeTap: CFMachPort?
var tapRunLoopSource: CFRunLoopSource?
var tapActive = false

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private func eventMask() -> CGEventMask {
    let types: [CGEventType] = [
        .keyDown,
        .leftMouseDown, .rightMouseDown, .otherMouseDown,
        .mouseMoved, .leftMouseDragged, .rightMouseDragged,
        .scrollWheel,
    ]
    return types.reduce(0) { $0 | (1 << $1.rawValue) }
}

private func eventCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = activeTap {
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        return Unmanaged.passUnretained(event)
    }
    let hardware = isHardware(event)
    counter.record(type: type, hardware: hardware)
    if hardware, type == .keyDown || type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown { handNow() }
    return Unmanaged.passUnretained(event)
}

/// The output path and the last window written, for the hand's rewrite between windows.
var outputPath = ""
var lastWindow: InputActivity?
/// At most one hand rewrite per 100 ms; a key inside that gap is written when it ends.
let handGap: TimeInterval = 0.1
var lastHandWrite = Date.distantPast
var handPending = false

/// A hardware key or click: rewrite the file now (or when the 100 ms gap ends) with the newer hand times. The counts and
/// the timestamp stay the last window's, so a reader that adds each new timestamp once (the input-activity sensor) adds nothing.
func handNow() {
    guard !handPending, !outputPath.isEmpty else { return }
    let wait = handGap - Date().timeIntervalSince(lastHandWrite)
    if wait <= 0 { return writeHand() }
    handPending = true
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { handPending = false; writeHand() }
}

func writeHand() {
    guard let window = lastWindow else { return }
    lastHandWrite = Date()
    let hand = counter.hand()
    save(InputActivity(
        timestamp: window.timestamp, windowMs: window.windowMs, keyDownCount: window.keyDownCount, mouseClickCount: window.mouseClickCount,
        mouseMoveCount: window.mouseMoveCount, scrollCount: window.scrollCount, lastEventAt: window.lastEventAt,
        listenAccessGranted: window.listenAccessGranted, tapActive: window.tapActive, ownerKeyDownCount: window.ownerKeyDownCount,
        ownerClickCount: window.ownerClickCount, lastKeyAt: hand.lastKeyAt.map { isoFormatter.string(from: $0) },
        lastClickAt: hand.lastClickAt.map { isoFormatter.string(from: $0) }, ownerOnly: true
    ), to: outputPath)
}

func save(_ payload: InputActivity, to path: String) {
    do {
        let data = try JSONEncoder().encode(payload)
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
        // Silent failure: the consumer treats an absent or stale file as "no data".
    }
}

func installTap() -> Bool {
    if activeTap != nil { return true }

    if !CGPreflightListenEventAccess() {
        _ = CGRequestListenEventAccess()
        if !CGPreflightListenEventAccess() {
            fputs("sundial-input-helper: Input Monitoring not granted (ListenEvent)\n", stderr)
            return false
        }
    }

    let refcon = Unmanaged.passUnretained(counter).toOpaque()
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: eventMask(),
        callback: eventCallback,
        userInfo: refcon
    ) else {
        fputs("sundial-input-helper: CGEventTapCreate returned nil\n", stderr)
        return false
    }

    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
        fputs("sundial-input-helper: failed to create run loop source\n", stderr)
        return false
    }

    activeTap = tap
    tapRunLoopSource = source
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    tapActive = true
    fputs("sundial-input-helper: event tap active\n", stderr)
    return true
}

func writeJSON(to path: String, windowMs: Int) {
    let snap = counter.snapshotAndReset()
    let listenGranted = CGPreflightListenEventAccess()
    let payload = InputActivity(
        timestamp: isoFormatter.string(from: Date()),
        windowMs: windowMs,
        keyDownCount: snap.keyDown,
        mouseClickCount: snap.clicks,
        mouseMoveCount: snap.moves,
        scrollCount: snap.scrolls,
        lastEventAt: snap.lastEventAt.map { isoFormatter.string(from: $0) },
        listenAccessGranted: listenGranted,
        tapActive: tapActive,
        ownerKeyDownCount: snap.ownerKeyDown,
        ownerClickCount: snap.ownerClicks,
        lastKeyAt: snap.lastKeyAt.map { isoFormatter.string(from: $0) },
        lastClickAt: snap.lastClickAt.map { isoFormatter.string(from: $0) },
        ownerOnly: true
    )
    lastWindow = payload
    save(payload, to: path)
}

func main() {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        FileHandle.standardError.write(Data("usage: sundial-input-helper <output-path>\n".utf8))
        exit(2)
    }
    outputPath = args[1]
    let windowMs = 1000

    _ = installTap()

    // Retry tap install every 5s until granted (user may toggle TCC while daemon runs).
    Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { _ in
        if !tapActive {
            _ = installTap()
        }
    }

    Timer.scheduledTimer(withTimeInterval: TimeInterval(windowMs) / 1000.0, repeats: true) { _ in
        writeJSON(to: outputPath, windowMs: windowMs)
    }

    writeJSON(to: outputPath, windowMs: windowMs)
    RunLoop.main.run()
}

main()
