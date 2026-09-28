import Foundation
import UserNotifications

/// Posts Gnomon's PHASIC notices as native macOS banners with the three verdict
/// buttons, and drops the owner's answer back for the node side to fold.
///
/// Why this lives in the launcher rather than in a sidecar helper, unlike almost
/// everything else here: `UNUserNotificationCenter.current()` authorizes against
/// the calling process's *main bundle*, and traps outright for a process that
/// has none. The launcher is the CFBundleExecutable of `dev.sundial.daemon`, so
/// it is the only process in this design that owns a bundle identity. A spawned
/// sidecar is a loose Mach-O with no Info.plist of its own, and node has no
/// bundle at all — which is the entire reason the notice request arrives here as
/// a file instead of node just posting it.
///
/// This also inverts the sidecar direction for the only time in the codebase:
/// every other file under $SUNDIAL_HOME/.daemon/ is written by Swift and read by
/// node. `notice-request.json` goes the other way. The verdict drops
/// (`notice-verdict-<uuid>.json`) restore the usual direction.
///
/// Run-loop caveat, same one SleepWakeCapture.swift documents: the process is
/// kept alive by `dispatchMain()`, not a pumped CFRunLoop. GCD timers are proven
/// to fire here, which is why the request file is POLLED on a DispatchSourceTimer
/// rather than watched with a file-system event source. UNUserNotificationCenter
/// delegate callbacks are delivered on the main queue, which `dispatchMain()`
/// does drain.

private var noticeTimer: DispatchSourceTimer?
private var noticeDelegate: NoticeDelegate?

private let noticeCategoryId = "GNOMON_NOTICE"
private let questionCategoryId = "GNOMON_QUESTION"
private let verdictActions: [(id: String, title: String, verdict: String)] = [
    ("VERDICT_USEFUL", "Useful", "useful"),
    ("VERDICT_WRONG", "Wrong", "wrong"),
    ("VERDICT_NOT_NOW", "Not now", "not-now"),
]

/// Read the notification opt-in from `$SUNDIAL_HOME/config.json`, exactly as
/// `readOcrConfig()` reads the OCR one. Missing file or missing block → off:
/// a banner reaches the owner outside a window they chose to open, so silence
/// is the only safe default.
func readNotificationsEnabled() -> Bool {
    let configPath = sundialHome().appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let notifications = json["notifications"] as? [String: Any] else {
        return false
    }
    return (notifications["enabled"] as? Bool) ?? false
}

func startNoticePresenting(runtimeDir: String, enabled: Bool) {
    guard enabled else { return }

    let center = UNUserNotificationCenter.current()
    let delegate = NoticeDelegate(runtimeDir: runtimeDir)
    center.delegate = delegate
    noticeDelegate = delegate

    let actions = verdictActions.map {
        UNNotificationAction(identifier: $0.id, title: $0.title, options: [])
    }
    center.setNotificationCategories([
        UNNotificationCategory(identifier: noticeCategoryId, actions: actions, intentIdentifiers: [], options: []),
        // A question gets NO verdict buttons: rating a question is not answering
        // it, and offering "Useful / Wrong" next to "Is this still blocked?"
        // would collect a verdict where an answer was wanted. The banner's only
        // job here is to send the owner back to the chat.
        UNNotificationCategory(identifier: questionCategoryId, actions: [], intentIdentifiers: [], options: []),
    ])

    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error {
            fputs("[sundial-daemon] notification authorization failed: \(error)\n", stderr)
        } else if !granted {
            fputs("[sundial-daemon] notification authorization denied; banners will not appear\n", stderr)
        }
    }

    let requestPath = "\(runtimeDir)/notice-request.json"
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler {
        consumeNoticeRequest(at: requestPath)
    }
    timer.resume()
    noticeTimer = timer
}

func stopNoticePresenting() {
    noticeTimer?.cancel()
    noticeTimer = nil
    noticeDelegate = nil
}

/// Read → DELETE → post. Deleting before posting (the same ordering the node
/// test hook uses) means a post that fails loses one banner instead of
/// re-posting the same one every second forever.
private func consumeNoticeRequest(at path: String) {
    guard FileManager.default.fileExists(atPath: path) else { return }
    let data = try? Data(contentsOf: URL(fileURLWithPath: path))
    try? FileManager.default.removeItem(atPath: path)

    guard let data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let noticeKey = json["noticeKey"] as? String, !noticeKey.isEmpty else {
        return
    }

    let kind = (json["kind"] as? String) ?? "notice"
    let observation = (json["observation"] as? String) ?? ""

    let content = UNMutableNotificationContent()
    content.title = "Gnomon"
    if kind == "owner-question" {
        content.body = observation.isEmpty ? "Gnomon has a question for you." : observation
        content.subtitle = "Reply in the Gnomon chat"
        content.categoryIdentifier = questionCategoryId
    } else {
        content.body = observation.isEmpty ? kind : observation
        content.categoryIdentifier = noticeCategoryId
    }
    content.userInfo = ["noticeKey": noticeKey]
    content.sound = .default

    // nil trigger = deliver immediately. The gate already decided this moment
    // was worth the interruption; delaying it here would second-guess a
    // decision that was priced with an interruption cost.
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
        if let error {
            fputs("[sundial-daemon] could not post a notice banner: \(error)\n", stderr)
        }
    }
}

private final class NoticeDelegate: NSObject, UNUserNotificationCenterDelegate {
    private let runtimeDir: String

    init(runtimeDir: String) {
        self.runtimeDir = runtimeDir
    }

    /// Without this, macOS suppresses a banner whose own app is frontmost. The
    /// launcher is an LSUIElement agent that the owner never "focuses", but the
    /// suppression rule still applies, so it must opt in explicitly.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        defer { completionHandler() }

        guard let noticeKey = response.notification.request.content.userInfo["noticeKey"] as? String,
              let verdict = verdictActions.first(where: { $0.id == response.actionIdentifier })?.verdict else {
            // Body click / dismiss. Not a verdict — recording one would put
            // words in the owner's mouth and train the gate on a shrug.
            return
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        let json: [String: Any] = ["noticeKey": noticeKey, "verdict": verdict, "at": formatter.string(from: Date())]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }

        // One file per press, never an append: two processes sharing an append
        // log need offset bookkeeping they have no way to agree on. The node
        // watcher deletes each file as it folds it.
        let path = "\(runtimeDir)/notice-verdict-\(UUID().uuidString).json"
        let tmpPath = path + ".tmp"
        try? data.write(to: URL(fileURLWithPath: tmpPath))
        try? FileManager.default.moveItem(atPath: tmpPath, toPath: path)
    }
}
