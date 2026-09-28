import Foundation

/// Sundial's data folder: $SUNDIAL_HOME when set (test installs, CI), else ~/.sundial.
func sundialHome() -> URL {
    if let h = ProcessInfo.processInfo.environment["SUNDIAL_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".sundial")
}

// sundial-daemon — the CFBundleExecutable launcher. Phase 3 (PLAN.md) split:
// this process now spawns ONLY the TCC-granted Swift sidecar helpers (this
// app bundle's own code identity carries the grants) plus the in-process
// focus/AV/sleep-wake capture. It no longer spawns node — the dsh harness
// process is started separately (shell or launchd) and only READS the sidecar
// JSON files under $SUNDIAL_HOME/.daemon/. See .claude/CLAUDE.md's TCC learnings:
// the launcher must be spawned directly (never `open -a`), and dsh must never
// spawn TCC-gated subprocesses itself.
//
// Lifecycle: writes its own pid to $SUNDIAL_HOME/.daemon/sidecars.pid on start
// (NOT daemon.pid — a live daemon.pid is the legacy-daemon signature the
// sundial-db plugin's single-writer guard refuses to start against), removes
// it on clean exit. SIGTERM/SIGINT are handled via DispatchSourceSignal so
// cleanupSidecars() actually runs on a signal — under the old SIG_DFL
// settings the atexit_b handler never fired for signals, leaking helper
// processes and stale sidecar files.
//
// The process is kept alive by dispatchMain(): GCD timers (focus/AV polling,
// see SleepWakeCapture.swift's run-loop note) and Process children work
// without a pumped CFRunLoop.

private var childPids: [pid_t] = []
private var focusTimer: DispatchSourceTimer?
private var avTimer: DispatchSourceTimer?
private var signalSources: [DispatchSourceSignal] = []

private func macosDir() -> URL {
    let bundle = Bundle.main.bundleURL
    if bundle.pathExtension == "app" {
        return bundle.appendingPathComponent("Contents/MacOS")
    }
    let exe = URL(fileURLWithPath: CommandLine.arguments[0])
    return exe.deletingLastPathComponent()
}

private func runtimeDir() -> URL {
    sundialHome().appendingPathComponent(".daemon")
}

private func sidecarsPidPath() -> String {
    runtimeDir().appendingPathComponent("sidecars.pid").path
}

/// P7 — read the screen-OCR opt-in from `$SUNDIAL_HOME/config.json`. The launcher gates SPAWNING the
/// OCR helper on this (not just the sensor), so no screen capture happens at all unless the owner
/// enabled it. Missing file / missing `ocr` block → disabled (the privacy-preserving default).
private func readOcrConfig() -> (enabled: Bool, fullMs: Int, cursorMs: Int, regionPx: Int, vision: Bool) {
    let configPath = sundialHome().appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ocr = json["ocr"] as? [String: Any] else {
        return (false, 5000, 1500, 480, false)
    }
    let enabled = (ocr["enabled"] as? Bool) ?? false
    // J3.3: `ocr.vision.enabled` makes the helper write a frame beside its text.
    let vision = ((ocr["vision"] as? [String: Any])?["enabled"] as? Bool) ?? false
    let full = (ocr["fullIntervalMs"] as? NSNumber)?.intValue ?? 5000
    let cursor = (ocr["cursorIntervalMs"] as? NSNumber)?.intValue ?? 1500
    let region = (ocr["cursorRegionPx"] as? NSNumber)?.intValue ?? 480
    return (enabled, full, cursor, region, vision)
}

/// Read the ambient-hearing opt-in, the same shape `readOcrConfig` reads for
/// the screen. Gated on SPAWNING rather than in the sensor, so a Gnomon with
/// hearing off never opens the microphone at all — and never raises a
/// microphone prompt for an owner who did not ask to be heard.
private func readAudioConfig() -> (enabled: Bool, whisperUrl: String, modelPath: String, vadModelPath: String, silenceFlushMs: Int, maxUtteranceMs: Int, diarizeModelPath: String) {
    let defaults = (
        false,
        "http://127.0.0.1:8771/inference",
        sundialHome().appendingPathComponent("models/ggml-large-v3-turbo-q5_0.bin").path,
        sundialHome().appendingPathComponent("models/ggml-silero-v5.1.2.bin").path,
        900,
        25_000,
        ""
    )
    let configPath = sundialHome().appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let audio = json["audio"] as? [String: Any] else {
        return defaults
    }
    return (
        (audio["enabled"] as? Bool) ?? defaults.0,
        (audio["whisperUrl"] as? String) ?? defaults.1,
        (audio["modelPath"] as? String) ?? defaults.2,
        (audio["vadModelPath"] as? String) ?? defaults.3,
        (audio["silenceFlushMs"] as? NSNumber)?.intValue ?? defaults.4,
        (audio["maxUtteranceMs"] as? NSNumber)?.intValue ?? defaults.5,
        // J3.2 fallback: a tinydiarize model path switches whisper to speaker-turn marking (English only).
        (audio["diarizeModelPath"] as? String) ?? defaults.6
    )
}

/// Set once cleanup starts, so a helper that exits because WE stopped it is not restarted.
private var shuttingDown = false
/// Seconds to wait before restarting each helper, doubled per quick crash (1 s … 60 s).
private var backoff: [String: TimeInterval] = [:]

/// Start a helper and keep it running: one that exits on its own is started
/// again after a backoff, and one that ran for a minute earns a fresh backoff.
/// Nothing restarted a crashed helper before this; its sensor went silent until
/// the next `sundial restart`.
private func spawnSidecar(executable: URL, arguments: [String]) {
    let name = executable.lastPathComponent
    let task = Process()
    task.executableURL = executable
    task.arguments = arguments
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    let startedAt = Date()
    task.terminationHandler = { finished in
        DispatchQueue.main.async {
            childPids.removeAll { $0 == finished.processIdentifier }
            if shuttingDown { return }
            if Date().timeIntervalSince(startedAt) > 60 { backoff[name] = 1 }
            let wait = backoff[name] ?? 1
            backoff[name] = min(wait * 2, 60)
            fputs("[sundial-daemon] \(name) exited (\(finished.terminationStatus)); restarting in \(Int(wait))s\n", stderr)
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                if !shuttingDown { spawnSidecar(executable: executable, arguments: arguments) }
            }
        }
    }
    do {
        try task.run()
        childPids.append(task.processIdentifier)
    } catch {
        fputs("[sundial-daemon] Failed to start \(name): \(error)\n", stderr)
    }
}

private func cleanupSidecars() {
    shuttingDown = true
    focusTimer?.cancel()
    focusTimer = nil
    avTimer?.cancel()
    avTimer = nil
    stopNoticePresenting()
    for pid in childPids {
        kill(pid, SIGTERM)
    }
    childPids.removeAll()
    let rt = runtimeDir().path
    for name in [
        "window-info.json", "window-info.json.tmp",
        "focus-info.json", "focus-info.json.tmp",
        "input-activity.json", "input-activity.json.tmp",
        "notification-badges.json", "notification-badges.json.tmp",
        "av-context.json", "av-context.json.tmp",
        "sleep-wake-info.json", "sleep-wake-info.json.tmp",
        "screen-ocr.json", "screen-ocr.json.tmp",
        // `audio-transcript.jsonl` is deliberately ABSENT: it is the append-only
        // transcript, not a snapshot, and the sensor holds a byte offset into
        // it. Deleting it on stop would throw away utterances the sensor had
        // not read yet. `audio-status.json` is the helper's own snapshot and
        // the helper removes it itself on shutdown.
        // A request outlives its usefulness the moment we stop: the notice it
        // carries was scored for a moment that has passed. Verdict drops are
        // NOT cleaned — an unread one is the owner's answer, and the node
        // watcher sweeps the directory on its next start.
        "notice-request.json", "notice-request.json.tmp",
    ] {
        try? FileManager.default.removeItem(atPath: "\(rt)/\(name)")
    }
    try? FileManager.default.removeItem(atPath: sidecarsPidPath())
}

private func startFocusPolling(windowFile: String) {
    writeFocusInfoSidecar(nextTo: windowFile)
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler {
        writeFocusInfoSidecar(nextTo: windowFile)
    }
    timer.resume()
    focusTimer = timer
}

/// AV (mic/camera) state has to be captured here, not by window-helper --
/// see AvCamera.swift's comment for why. Written to its own sidecar file
/// (`av-context.json`), read by the `audio-context` sensor.
private func writeAvContextSidecar(to path: String) {
    let tmpPath = path + ".tmp"
    let snapshot = captureAvSnapshot()
    guard let data = try? JSONEncoder().encode(snapshot) else { return }
    try? data.write(to: URL(fileURLWithPath: tmpPath))
    try? FileManager.default.removeItem(atPath: path)
    try? FileManager.default.moveItem(atPath: tmpPath, toPath: path)
}

private func startAvPolling(avFile: String) {
    writeAvContextSidecar(to: avFile)
    let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler {
        writeAvContextSidecar(to: avFile)
    }
    timer.resume()
    avTimer = timer
}

/// Real signal handling: cleanupSidecars() must run on SIGTERM/SIGINT (the
/// only ways this long-lived process is ever stopped). `signal(sig, SIG_IGN)`
/// first, then a DispatchSourceSignal — the libdispatch-documented pattern so
/// the default terminating disposition never races the source.
private func installSignalHandlers() {
    for sig in [SIGTERM, SIGINT] {
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: DispatchQueue.global(qos: .utility))
        source.setEventHandler {
            cleanupSidecars()
            exit(0)
        }
        source.resume()
        signalSources.append(source)
    }
}

private func runDaemon() {
    let rt = runtimeDir()
    try? FileManager.default.createDirectory(at: rt, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let windowFile = rt.appendingPathComponent("window-info.json").path
    let inputFile = rt.appendingPathComponent("input-activity.json").path
    let notificationFile = rt.appendingPathComponent("notification-badges.json").path
    let avFile = rt.appendingPathComponent("av-context.json").path
    let sleepWakeFile = rt.appendingPathComponent("sleep-wake-info.json").path
    let ocrFile = rt.appendingPathComponent("screen-ocr.json").path
    let transcriptFile = rt.appendingPathComponent("audio-transcript.jsonl").path

    let helpers = macosDir()
    let windowHelper = helpers.appendingPathComponent("sundial-window-helper")
    let inputHelper = helpers.appendingPathComponent("sundial-input-helper")
    let notificationHelper = helpers.appendingPathComponent("sundial-notification-helper")
    let ocrHelper = helpers.appendingPathComponent("sundial-screen-ocr-helper")
    let audioHelper = helpers.appendingPathComponent("sundial-audio-helper")

    // Own-liveness marker for `sundial-sidecars.js` (stop/status). This is
    // deliberately NOT daemon.pid: that file is the legacy daemon's signature
    // and the harness's single-writer guard treats it as a violation.
    try? String(ProcessInfo.processInfo.processIdentifier)
        .write(toFile: sidecarsPidPath(), atomically: true, encoding: .utf8)

    installSignalHandlers()

    // No camera prompt: `isCameraActive()` reads cameracaptured's CPU, which
    // needs no Camera grant, so asking a new user for one bought nothing.

    startFocusPolling(windowFile: windowFile)
    startAvPolling(avFile: avFile)
    startSleepWakeObserving(sidecarPath: sleepWakeFile)
    // Opt-in, and gated here rather than in the plugin so no authorization
    // prompt appears for an owner who never asked for banners.
    startNoticePresenting(runtimeDir: rt.path, enabled: readNotificationsEnabled())

    if FileManager.default.isExecutableFile(atPath: windowHelper.path) {
        spawnSidecar(executable: windowHelper, arguments: ["--loop", windowFile])
    }
    if FileManager.default.isExecutableFile(atPath: inputHelper.path) {
        spawnSidecar(executable: inputHelper, arguments: [inputFile])
    }
    if FileManager.default.isExecutableFile(atPath: notificationHelper.path) {
        spawnSidecar(executable: notificationHelper, arguments: [notificationFile, "30000"])
    }
    // P7 — only spawn the OCR helper when the owner opted in, so no screen capture happens by
    // default. Intervals/region come from the same `$SUNDIAL_HOME/config.json` the sensor reads.
    let ocr = readOcrConfig()
    if ocr.enabled && FileManager.default.isExecutableFile(atPath: ocrHelper.path) {
        let frameFile = ocr.vision ? rt.appendingPathComponent("screen-frame.jpg").path : ""
        spawnSidecar(executable: ocrHelper, arguments: [ocrFile, String(ocr.fullMs), String(ocr.cursorMs), String(ocr.regionPx), frameFile])
    }
    // Ambient hearing, opt-in for the same reason the screen is: the helper
    // owns the microphone AND the local transcriber, so not spawning it is the
    // difference between a Gnomon that cannot hear and one that chooses not to.
    let audio = readAudioConfig()
    if audio.enabled && FileManager.default.isExecutableFile(atPath: audioHelper.path) {
        spawnSidecar(
            executable: audioHelper,
            arguments: [transcriptFile, audio.whisperUrl, audio.modelPath, audio.vadModelPath, String(audio.silenceFlushMs), String(audio.maxUtteranceMs), audio.diarizeModelPath]
        )
    }
}

// First, before any file or helper: see Disclaim.swift.
reexecLauncherDisclaimed()
runDaemon()
// Keep the process alive forever (until SIGTERM/SIGINT): GCD timers and
// The main RUN LOOP, not dispatchMain(). GCD timers (focus/AV polling, child
// supervision) are happy on either — the main queue is drained by the run loop
// too. What is NOT happy on dispatchMain() is NSWorkspace: its
// willSleep/didWake notifications are delivered through the main run loop, and
// with nothing pumping it the observers SleepWakeCapture registers were never
// called. `system:sleep-wake` last fired on 2026-08-15, the day it was written;
// the machine slept and woke every day in between.
RunLoop.main.run()
