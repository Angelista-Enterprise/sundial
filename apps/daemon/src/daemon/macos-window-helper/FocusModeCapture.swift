import Foundation

// Extends the daemon LAUNCHER's compile step (not the window-helper's) —
// invoked directly by macos-daemon-launcher/main.swift, same file WCS used.
// Requires Full Disk Access on the terminal that runs `gnomon start`, per
// .claude/CLAUDE.md's TCC section — the DoNotDisturb DB isn't readable
// otherwise.

struct FocusModeSidecar: Codable {
    let state: String
    let name: String?
    let modeIdentifier: String?
    let timestamp: String
    /// False when DoNotDisturb DB could not be read (TCC / FDA — restart daemon after granting).
    let assertionsReadable: Bool
}

private let knownModeStates: [String: String] = [
    "com.apple.donotdisturb.mode.default": "do-not-disturb",
    "com.apple.focus.work": "work",
    "com.apple.focus.personal": "personal",
    "com.apple.sleep.sleep-mode": "sleep",
]

private let weekdayBits = [1, 2, 4, 8, 16, 32, 64]

private func dndDbDir() -> URL {
    let homePath: String
    if let envHome = ProcessInfo.processInfo.environment["HOME"], !envHome.isEmpty {
        homePath = envHome
    } else {
        homePath = FileManager.default.homeDirectoryForCurrentUser.path
    }
    return URL(fileURLWithPath: homePath).appendingPathComponent("Library/DoNotDisturb/DB")
}

private func readJsonObject(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return obj
}

private func activeManualModeId(from assertions: [String: Any]?) -> String? {
    guard let data = assertions?["data"] as? [[String: Any]],
          let store = data.first?["storeAssertionRecords"] as? [[String: Any]],
          !store.isEmpty else {
        return nil
    }

    var best: [String: Any]?
    var bestTs = -Double.infinity
    for record in store {
        let ts = record["assertionStartDateTimestamp"] as? Double ?? 0
        if ts >= bestTs {
            bestTs = ts
            best = record
        }
    }

    guard let details = best?["assertionDetails"] as? [String: Any] else { return nil }
    return details["assertionDetailsModeIdentifier"] as? String
}

private func weekdayMatches(_ bitmask: Int?, weekday: Int) -> Bool {
    guard let bitmask, bitmask != 0 else { return true }
    guard weekday >= 0, weekday < weekdayBits.count else { return false }
    return (bitmask & weekdayBits[weekday]) != 0
}

private func scheduleTriggerActive(_ trigger: [String: Any], now: Date) -> Bool {
    guard let enabled = trigger["enabledSetting"] as? Int, enabled != 0 else { return false }
    if let cls = trigger["class"] as? String, cls != "DNDModeConfigurationScheduleTrigger" { return false }

    let start = (trigger["timePeriodStartTimeHour"] as? Int ?? 0) * 60
        + (trigger["timePeriodStartTimeMinute"] as? Int ?? 0)
    let end = (trigger["timePeriodEndTimeHour"] as? Int ?? 0) * 60
        + (trigger["timePeriodEndTimeMinute"] as? Int ?? 0)
    let cal = Calendar.current
    let nowMin = cal.component(.hour, from: now) * 60 + cal.component(.minute, from: now)
    let weekday = cal.component(.weekday, from: now) - 1

    if !weekdayMatches(trigger["timePeriodWeekdays"] as? Int, weekday: weekday) { return false }
    if start == end { return false }
    if start < end { return nowMin >= start && nowMin < end }
    return nowMin >= start || nowMin < end
}

private func modeConfigurations(from root: [String: Any]?) -> [String: [String: Any]]? {
    guard let data = root?["data"] as? [[String: Any]],
          let configs = data.first?["modeConfigurations"] as? [String: [String: Any]] else {
        return nil
    }
    return configs
}

private func activeScheduledModeId(
    configs: [String: [String: Any]]?,
    now: Date
) -> String? {
    guard let configs else { return nil }
    for (modeId, config) in configs {
        guard let triggers = config["triggers"] as? [String: Any],
              let list = triggers["triggers"] as? [[String: Any]] else { continue }
        for trigger in list where scheduleTriggerActive(trigger, now: now) {
            return modeId
        }
    }
    return nil
}

private func lookupModeName(
    configs: [String: [String: Any]]?,
    modeId: String
) -> String? {
    guard let configs else { return nil }
    if let mode = configs[modeId]?["mode"] as? [String: Any],
       let name = mode["name"] as? String {
        return name
    }
    for config in configs.values {
        guard let mode = config["mode"] as? [String: Any],
              mode["modeIdentifier"] as? String == modeId,
              let name = mode["name"] as? String else { continue }
        return name
    }
    return nil
}

func captureFocusModeSnapshot(now: Date = Date()) -> FocusModeSidecar {
    let dbDir = dndDbDir()
    let assertionsPath = dbDir.appendingPathComponent("Assertions.json")
    let assertions = readJsonObject(assertionsPath)
    let assertionsReadable = FileManager.default.isReadableFile(atPath: assertionsPath.path)
        && assertions != nil
    let modeRoot = readJsonObject(dbDir.appendingPathComponent("ModeConfigurations.json"))
    let configs = modeConfigurations(from: modeRoot)

    let manualModeId = activeManualModeId(from: assertions)
    let activeModeId = manualModeId ?? activeScheduledModeId(configs: configs, now: now)

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    let timestamp = formatter.string(from: now)

    guard let activeModeId else {
        return FocusModeSidecar(
            state: "off",
            name: nil,
            modeIdentifier: nil,
            timestamp: timestamp,
            assertionsReadable: assertionsReadable
        )
    }

    let displayName = lookupModeName(configs: configs, modeId: activeModeId)
    let state = knownModeStates[activeModeId] ?? "custom"

    return FocusModeSidecar(
        state: state,
        name: displayName,
        modeIdentifier: activeModeId,
        timestamp: timestamp,
        assertionsReadable: assertionsReadable
    )
}

func writeFocusInfoSidecar(nextTo windowInfoPath: String) {
    let dir = (windowInfoPath as NSString).deletingLastPathComponent
    let focusPath = (dir as NSString).appendingPathComponent("focus-info.json")
    let tmpPath = focusPath + ".tmp"
    let snapshot = captureFocusModeSnapshot()

    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    try? data.write(to: URL(fileURLWithPath: tmpPath))
    try? FileManager.default.removeItem(atPath: focusPath)
    try? FileManager.default.moveItem(atPath: tmpPath, toPath: focusPath)
}
