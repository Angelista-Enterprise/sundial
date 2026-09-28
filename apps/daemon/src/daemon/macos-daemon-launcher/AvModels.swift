import Foundation

struct AvProcessUsage: Codable {
    let pid: Int32
    let processName: String
    let bundleId: String?
}

/// Written to `av-context.json` by `startAvPolling` (main.swift) — a
/// dedicated sidecar, not merged into window-helper's `window-info.json`,
/// since only the launcher's process identity gets accurate Camera TCC
/// reads (see AvCamera.swift's comment).
struct AvContextSnapshot: Codable {
    let microphoneActive: Bool
    let cameraActive: Bool
    let audioInputProcesses: [AvProcessUsage]
    let audioOutputProcesses: [AvProcessUsage]
    let cameraProcesses: [AvProcessUsage]
    let captureTimestamp: String
}
