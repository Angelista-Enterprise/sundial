import AppKit
import Foundation

/// Replaces WCS's `pmset -g log` polling entirely (Wave 3e, per docs/phase-3-
/// implementation-plan.md) with the real notification-driven mechanism WCS's
/// own sensor comment named as the eventual upgrade path. Registered in the
/// launcher (not a sidecar) — same rationale as focus-mode/AV: this is
/// system-level state, not per-window, and needs the launcher's stable
/// process identity.
///
/// Live-testing caveat, honestly noted rather than silently assumed clean:
/// this observer is registered on `NSWorkspace.shared.notificationCenter`
/// without spinning the launcher's own `CFRunLoop` (the launcher blocks on
/// `node.waitUntilExit()`, same as it did before this file existed). Focus-
/// mode and AV polling already prove GCD dispatch-queue timers fire
/// correctly in this process without a pumped run loop; NSWorkspace's
/// notification delivery mechanism is expected to behave the same way, but
/// an actual sleep/wake cycle hasn't been exercised against this code yet —
/// flagged in docs/implementation-test-log.md, not assumed working.
private var lastTransition: (kind: String, at: Date)?

func startSleepWakeObserving(sidecarPath: String) {
    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: nil) { _ in
        writeSleepWakeTransition(kind: "sleep", sidecarPath: sidecarPath)
    }
    center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { _ in
        writeSleepWakeTransition(kind: "wake", sidecarPath: sidecarPath)
    }
}

private func writeSleepWakeTransition(kind: String, sidecarPath: String) {
    let now = Date()
    if let last = lastTransition, last.kind == kind { return }

    var gapSeconds: Int? = nil
    if let last = lastTransition {
        gapSeconds = Int(now.timeIntervalSince(last.at).rounded())
    }
    lastTransition = (kind, now)

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]

    var json: [String: Any] = ["kind": kind, "timestamp": formatter.string(from: now)]
    if let gapSeconds { json["gapSeconds"] = gapSeconds }

    guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
    let tmpPath = sidecarPath + ".tmp"
    try? data.write(to: URL(fileURLWithPath: tmpPath))
    try? FileManager.default.removeItem(atPath: sidecarPath)
    try? FileManager.default.moveItem(atPath: tmpPath, toPath: sidecarPath)
}
