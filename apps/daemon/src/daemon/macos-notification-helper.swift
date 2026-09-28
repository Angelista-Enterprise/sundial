// macos-notification-helper.swift
// Reads Dock badge counts via Accessibility (AXStatusLabel on dock items).
// We never open Notification Center, read banner text, or access the usernoted DB.
// Output is app name + integer count only — enough to detect interruptions.
//
// Usage: sundial-notification-helper /path/to/notification-badges.json [intervalMs]

import ApplicationServices
import AppKit
import Foundation

struct BadgeSnapshot: Codable {
    let timestamp: String
    let accessGranted: Bool
    let badges: [String: Int]
    let totalCount: Int
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    guard err == .success, let raw = value else { return nil }
    if let s = raw as? String { return s }
    if let n = raw as? NSNumber { return n.stringValue }
    return nil
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let arr = value as? [AXUIElement] else {
        return []
    }
    return arr
}

private func parseBadge(_ text: String) -> Int? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    if trimmed == "!" || trimmed == "•" || trimmed == "…" { return 1 }
    if trimmed.hasSuffix("+") {
        return Int(String(trimmed.dropLast()))
    }
    return Int(trimmed)
}

private func dockProcessId() -> pid_t? {
    for app in NSWorkspace.shared.runningApplications {
        if app.bundleIdentifier == "com.apple.dock" {
            return app.processIdentifier
        }
    }
    return nil
}

private func badgeCountsFromDock() -> [String: Int] {
    guard AXIsProcessTrusted() else { return [:] }
    guard let pid = dockProcessId() else { return [:] }

    let dockApp = AXUIElementCreateApplication(pid)
    var badges: [String: Int] = [:]

    func walk(_ element: AXUIElement) {
        let role = axString(element, kAXRoleAttribute as String) ?? ""
        if role == "AXDockItem" {
            let name = axString(element, kAXTitleAttribute as String)
                ?? axString(element, kAXDescriptionAttribute as String)
                ?? ""
            if !name.isEmpty, let label = axString(element, "AXStatusLabel"), let count = parseBadge(label) {
                badges[name] = count
            }
        }
        for child in axChildren(element) {
            walk(child)
        }
    }

    walk(dockApp)
    return badges
}

private func writeSnapshot(to path: String) {
    let accessGranted = AXIsProcessTrusted()
    let badges = badgeCountsFromDock()
    let total = badges.values.reduce(0, +)
    let payload = BadgeSnapshot(
        timestamp: isoFormatter.string(from: Date()),
        accessGranted: accessGranted,
        badges: badges,
        totalCount: total
    )
    do {
        let data = try JSONEncoder().encode(payload)
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    } catch {
        // Consumer treats missing/stale file as no data.
    }
}

func main() {
    let args = CommandLine.arguments
    guard args.count >= 2 else {
        FileHandle.standardError.write(Data("usage: sundial-notification-helper <output-path> [intervalMs]\n".utf8))
        exit(2)
    }
    let outputPath = args[1]
    let intervalMs = args.count >= 3 ? (Int(args[2]) ?? 30_000) : 30_000
    let intervalSec = max(1.0, Double(intervalMs) / 1000.0)

    if !AXIsProcessTrusted() {
        fputs("sundial-notification-helper: Accessibility not granted — cannot read Dock badges\n", stderr)
    }

    writeSnapshot(to: outputPath)

    Timer.scheduledTimer(withTimeInterval: intervalSec, repeats: true) { _ in
        writeSnapshot(to: outputPath)
    }

    RunLoop.main.run()
}

main()
