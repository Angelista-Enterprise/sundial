// sundial-window-helper — compiled into Sundial.app for TCC-granted window capture.
// Phase 1 scope: window identity + geometry only (no OCR/AV/focus-mode — those
// land with their own sensors in Phase 3).

import AppKit
import Foundation

let encoder = JSONEncoder()

if CommandLine.arguments.count > 1, CommandLine.arguments[1] == "--loop" {
    let outputPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "/tmp/sundial-window-info.json"
    let tmpPath = outputPath + ".tmp"

    signal(SIGTERM, SIG_DFL)

    func writeSnapshot() {
        if let info = getActiveWindowInfo(), let data = try? encoder.encode(info) {
            try? data.write(to: URL(fileURLWithPath: tmpPath))
            try? FileManager.default.removeItem(atPath: outputPath)
            try? FileManager.default.moveItem(atPath: tmpPath, toPath: outputPath)
        }
    }

    // Plan 15 I2: an app switch, a new focused window or a new title is written at once. The 1 s timer stays:
    // Node reads a file older than 3 s as a dead helper.
    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
        writeSnapshot()
    }
    let changed = Notification.Name("dev.sundial.window.changed")
    NotificationCenter.default.addObserver(forName: changed, object: nil, queue: .main) { _ in writeSnapshot() }
    var observer: AXObserver?
    func observe(_ app: NSRunningApplication?) {
        if let old = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .defaultMode) }
        observer = nil
        guard let pid = app?.processIdentifier,
              AXObserverCreate(pid, { _, _, _, _ in NotificationCenter.default.post(name: Notification.Name("dev.sundial.window.changed"), object: nil) }, &observer) == .success,
              let observer else { return }
        let element = AXUIElementCreateApplication(pid)
        for name in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXTitleChangedNotification, kAXSheetCreatedNotification] {
            AXObserverAddNotification(observer, element, name as CFString, nil)
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
        observe(note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        writeSnapshot()
    }
    observe(NSWorkspace.shared.frontmostApplication)
    writeSnapshot()
    RunLoop.main.run()
} else {
    if let info = getActiveWindowInfo() {
        if let data = try? encoder.encode(info), let json = String(data: data, encoding: .utf8) {
            print(json)
        } else {
            print("{\"error\": \"Failed to encode\"}")
        }
    } else {
        print("{\"error\": \"No active application\"}")
    }
}
