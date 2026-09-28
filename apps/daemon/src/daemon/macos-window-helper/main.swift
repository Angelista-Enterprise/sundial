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

    Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
        writeSnapshot()
    }
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
