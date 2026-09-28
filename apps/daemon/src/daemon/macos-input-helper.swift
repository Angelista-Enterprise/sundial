// macos-input-helper.swift
// Counts keyboard / mouse / scroll events globally and writes a 1-second
// rolling-window summary to a JSON file. We never read keycodes,
// characters, button identities, or coordinates — only counts.
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
}

final class Counter {
    private let lock = NSLock()
    var keyDown = 0
    var clicks = 0
    var moves = 0
    var scrolls = 0
    var lastEventAt: Date?

    func record(type: CGEventType) {
        lock.lock()
        defer { lock.unlock() }
        lastEventAt = Date()
        switch type {
        case .keyDown:
            keyDown += 1
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            clicks += 1
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged:
            moves += 1
        case .scrollWheel:
            scrolls += 1
        default:
            break
        }
    }

    func snapshotAndReset() -> (keyDown: Int, clicks: Int, moves: Int, scrolls: Int, lastEventAt: Date?) {
        lock.lock()
        defer { lock.unlock() }
        let snap = (keyDown, clicks, moves, scrolls, lastEventAt)
        keyDown = 0
        clicks = 0
        moves = 0
        scrolls = 0
        lastEventAt = nil
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
    counter.record(type: type)
    return Unmanaged.passUnretained(event)
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
        tapActive: tapActive
    )
    do {
        let data = try JSONEncoder().encode(payload)
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
        // Silent failure — the consumer treats absent/stale file as "no data".
    }
}

func main() {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        FileHandle.standardError.write(Data("usage: sundial-input-helper <output-path>\n".utf8))
        exit(2)
    }
    let outputPath = args[1]
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
