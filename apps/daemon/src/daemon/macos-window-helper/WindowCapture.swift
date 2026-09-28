import AppKit
import ApplicationServices
import Foundation

func getActiveWindowInfo() -> WindowInfo? {
    guard let frontApp = NSWorkspace.shared.frontmostApplication else { return nil }

    let pid = frontApp.processIdentifier
    let appName = frontApp.localizedName ?? "unknown"
    let bundleId = frontApp.bundleIdentifier ?? "unknown"
    let appPath = frontApp.bundleURL?.path ?? "unknown"

    var windowTitle = ""
    var axReportedTitle = false
    var windowId = "0"
    var method = "none"
    var documentPath: String? = nil
    var position: Position? = nil
    var size: Size? = nil
    var isFullscreen = false
    var isMinimized = false
    var isOnscreen = true
    var windowLayer = 0
    var windowAlpha = 1.0
    var windowRole = ""
    var windowSubrole = ""
    var diagnostics: [String: String] = [:]

    let appElement = AXUIElementCreateApplication(pid)
    var focusedWindow: CFTypeRef?

    let axResult = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedWindow)
    if axResult != .success {
        let axResult2 = AXUIElementCopyAttributeValue(appElement, kAXMainWindowAttribute as CFString, &focusedWindow)
        if axResult2 != .success {
            diagnostics["accessibility"] = "AXError focused=\(axResult.rawValue) main=\(axResult2.rawValue) — grant Accessibility permission to Sundial"
        }
    }

    if let window = focusedWindow {
        let axWindow = window as! AXUIElement

        var titleValue: CFTypeRef?
        let titleResult = AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleValue)
        if titleResult == .success, let title = titleValue as? String, !title.isEmpty {
            windowTitle = title
            // Remembered separately from `method`, which the CGWindowList pass
            // below may overwrite. A title that Accessibility actually reported
            // is real even when it equals the app name — see the final guard.
            axReportedTitle = true
            method = "accessibility"
        } else {
            diagnostics["accessibility"] = "AXTitle error=\(titleResult.rawValue) (window found but title empty)"
        }

        var docValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXDocumentAttribute as CFString, &docValue) == .success,
           let doc = docValue as? String, !doc.isEmpty {
            documentPath = doc
        }

        var posValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXPositionAttribute as CFString, &posValue) == .success {
            var point = CGPoint.zero
            if AXValueGetValue(posValue as! AXValue, .cgPoint, &point) {
                position = Position(x: Double(point.x), y: Double(point.y))
            }
        }

        var sizeValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXSizeAttribute as CFString, &sizeValue) == .success {
            var sz = CGSize.zero
            if AXValueGetValue(sizeValue as! AXValue, .cgSize, &sz) {
                size = Size(width: Double(sz.width), height: Double(sz.height))
            }
        }

        var roleValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXRoleAttribute as CFString, &roleValue) == .success,
           let role = roleValue as? String {
            windowRole = role
        }

        var subroleValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXSubroleAttribute as CFString, &subroleValue) == .success,
           let subrole = subroleValue as? String {
            windowSubrole = subrole
        }

        var fsValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, "AXFullScreen" as CFString, &fsValue) == .success,
           let fs = fsValue as? Bool {
            isFullscreen = fs
        }

        var minValue: CFTypeRef?
        if AXUIElementCopyAttributeValue(axWindow, kAXMinimizedAttribute as CFString, &minValue) == .success,
           let minimized = minValue as? Bool {
            isMinimized = minimized
        }
    }

    if let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        var foundPid = false
        var foundTitle = false
        for window in windowList {
            guard let ownerPID = window[kCGWindowOwnerPID as String] as? Int32, ownerPID == pid else { continue }
            foundPid = true
            let name = window[kCGWindowName as String] as? String ?? ""
            let layer = window[kCGWindowLayer as String] as? Int ?? 0
            let onscreen = window[kCGWindowIsOnscreen as String] as? Bool ?? false
            let alpha = window[kCGWindowAlpha as String] as? Double ?? 1.0

            guard layer >= -1, layer <= 5 else { continue }

            if let winNum = window[kCGWindowNumber as String] as? Int, windowId == "0" {
                windowId = String(winNum)
            }

            windowLayer = layer
            windowAlpha = alpha
            isOnscreen = onscreen

            if position == nil || size == nil, let bounds = window[kCGWindowBounds as String] as? [String: Double] {
                if position == nil {
                    position = Position(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0)
                }
                if size == nil {
                    size = Size(width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
                }
            }

            if !name.isEmpty {
                foundTitle = true
                if windowTitle.isEmpty || windowTitle == appName {
                    windowTitle = name
                    method = "cgwindow"
                }
                break
            }
        }
        if !foundPid {
            diagnostics["cgwindow"] = "No windows found for PID \(pid) — grant Screen Recording permission to Sundial"
        } else if !foundTitle {
            diagnostics["cgwindow"] = "PID \(pid) found but kCGWindowName empty — Screen Recording may not be fully granted"
        }
    } else {
        diagnostics["cgwindow"] = "CGWindowListCopyWindowInfo returned nil"
    }

    var screenInfo: ScreenInfo? = nil
    if let mainScreen = NSScreen.main {
        let frame = mainScreen.frame
        screenInfo = ScreenInfo(width: Double(frame.width), height: Double(frame.height),
                                x: Double(frame.origin.x), y: Double(frame.origin.y))
    }

    // A title equal to the app name is a CGWindowList PLACEHOLDER — but only when
    // Accessibility never reported one. Several apps genuinely title their window
    // after themselves: Claude for Desktop reports AXTitle "Claude", the Gnomon UI
    // reports "Gnomon". Blanking those cost 303 window events their real title
    // (277 Claude, 26 Gnomon) and reported `diagnostics: {}` while doing it, which
    // made the loss look like a permissions problem rather than this guard.
    if windowTitle.isEmpty || (windowTitle == appName && !axReportedTitle) {
        windowTitle = "No Title Found"
        if method == "none" { method = "failed" }
    }

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    let timestamp = formatter.string(from: Date())

    return WindowInfo(
        processName: appName, bundleId: bundleId, windowTitle: windowTitle,
        windowId: windowId, appPath: appPath, method: method,
        position: position, size: size,
        isFullscreen: isFullscreen, isMinimized: isMinimized,
        isOnscreen: isOnscreen, windowLayer: windowLayer, windowAlpha: windowAlpha,
        windowRole: windowRole, windowSubrole: windowSubrole,
        documentPath: documentPath,
        screen: screenInfo, pid: pid,
        diagnostics: diagnostics,
        captureTimestamp: timestamp
    )
}
