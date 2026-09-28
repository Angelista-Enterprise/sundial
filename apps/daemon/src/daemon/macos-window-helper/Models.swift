import Foundation

/// Phase 1 scope was basic window identity + geometry only. AV (mic/camera)
/// state is captured by the launcher instead, into its own `av-context.json`
/// sidecar — not here. Live testing (2026-07-17) found window-helper's
/// process identity can't get accurate Camera TCC reads (see
/// `macos-daemon-launcher/AvCamera.swift`'s comment), so co-locating it in
/// `window-info.json` as originally planned doesn't work; OCR/focused-
/// element/screen-lock capture still belong to other, not-yet-ported
/// concerns.
struct WindowInfo: Codable {
    let processName: String
    let bundleId: String
    let windowTitle: String
    let windowId: String
    let appPath: String
    let method: String
    let position: Position?
    let size: Size?
    let isFullscreen: Bool
    let isMinimized: Bool
    let isOnscreen: Bool
    let windowLayer: Int
    let windowAlpha: Double
    let windowRole: String
    let windowSubrole: String
    let documentPath: String?
    let screen: ScreenInfo?
    let pid: Int32
    let diagnostics: [String: String]
    let captureTimestamp: String
}

struct Position: Codable { let x: Double; let y: Double }
struct Size: Codable { let width: Double; let height: Double }
struct ScreenInfo: Codable { let width: Double; let height: Double; let x: Double; let y: Double }
