// sundial-audio-helper — ambient hearing.
//
// A persistent sidecar (spawned by the launcher only when `audio.enabled` in
// $SUNDIAL_HOME/config.json) that taps the built-in microphone — and, while a
// window is open, what the Mac plays, so a call has both sides (`SystemEars`;
// each line says `source: mic|system`) — gates on loudness so
// silence costs nothing, and turns speech into text with a LOCAL whisper.cpp
// server. Each finished utterance is appended as one JSON line to
// `$SUNDIAL_HOME/.daemon/audio-transcript.jsonl`, which the TS `audio-transcript`
// sensor tails by byte offset — the same handoff the shell sensor uses for its
// hook file, because a transcript is a STREAM of utterances and a
// last-value-wins snapshot would drop every one it did not happen to catch.
//
// AUDIO NEVER TOUCHES DISK. Frames live in memory, go to the transcriber over
// loopback, and are dropped. Only text is written. That is a deliberate
// asymmetry with the screen-OCR helper's single snapshot: a rolling recording
// of a room is a different object from a description of it, and the owner asked
// for the second thing.
//
// WHY A LOCAL SERVER AND NOT AN API. Apple's own engines cannot do this job.
// Measured 2026-09-11 on macOS 26.6.2: the new `SpeechTranscriber` supports 30
// locales and Dutch is not among them, and the older `SFSpeechRecognizer` does
// list `nl-NL` but reports `supportsOnDeviceRecognition == false` for it, which
// means Dutch would be transcribed on Apple's servers. The owner needs English
// AND Dutch and wants neither leaving the machine, so whisper large-v3-turbo
// runs here instead: 1.0-1.4s for a 4s utterance on an M4 Pro once the model is
// warm, auto-detecting the language per utterance.
//
// Microphone TCC works the way Screen Recording does, and the OCR helper's
// comment is the reference for why: TCC judges the REQUESTING binary, so this
// helper re-execs itself as a disclaimed child and then asks for access itself.
// Inheriting the bundle's identity is not enough.
//
// argv: [outJsonl, whisperUrl, modelPath, vadModelPath, silenceFlushMs, maxUtteranceMs]

import AVFoundation
import CoreAudio
import Foundation

/// Sundial's data folder: $SUNDIAL_HOME when set (test installs, CI), else ~/.sundial.
func sundialHome() -> URL {
    if let h = ProcessInfo.processInfo.environment["SUNDIAL_HOME"], !h.isEmpty { return URL(fileURLWithPath: h) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".sundial")
}

// MARK: - Be responsible for yourself

private let DISCLAIM_MARKER = "SUNDIAL_AUDIO_DISCLAIMED"
private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer, Int32) -> Int32

var disclaimedChild: pid_t = 0

/// Re-exec self as a CHILD process that is responsible for itself, and babysit
/// it. Copied from the screen-OCR helper, whose comment carries the measurement
/// that made it necessary: a new process is where the kernel assigns
/// responsibility, so POSIX_SPAWN_SETEXEC (same pid, new image) leaves TCC
/// still judging the parent. Returns only when the hop could not be made, in
/// which case the helper runs undisclaimed rather than not at all.
func execDisclaimed() {
    if ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil { return }
    guard let handle = dlopen(nil, RTLD_NOW) else { return }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(symbol, to: SetDisclaim.self)

    var attrs: posix_spawnattr_t?
    guard posix_spawnattr_init(&attrs) == 0 else { return }
    defer { posix_spawnattr_destroy(&attrs) }
    guard withUnsafeMutablePointer(to: &attrs, { setDisclaim(UnsafeMutableRawPointer($0), 1) }) == 0 else { return }

    let arguments = CommandLine.arguments
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    var environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment.map { strdup("\($0.key)=\($0.value)") }
    environment.append(strdup("\(DISCLAIM_MARKER)=1"))
    environment.append(nil)
    defer {
        for pointer in argv where pointer != nil { free(pointer) }
        for pointer in environment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, arguments[0], nil, &attrs, argv, environment) == 0 else {
        FileHandle.standardError.write("sundial-audio-helper: disclaimed re-exec failed; running undisclaimed\n".data(using: .utf8)!)
        return
    }
    disclaimedChild = pid
    // The launcher stops the helper by signalling the pid it spawned — this
    // one. Pass it on, or the child outlives its parent as an orphan that keeps
    // listening after the launcher believes it stopped.
    signal(SIGTERM) { _ in kill(disclaimedChild, SIGTERM) }
    signal(SIGINT) { _ in kill(disclaimedChild, SIGINT) }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7F) == 0 ? (status >> 8) & 0xFF : 1)
}
execDisclaimed()

// MARK: - Args

private let args = CommandLine.arguments
private let home = FileManager.default.homeDirectoryForCurrentUser
private let outJsonl = args.count > 1 ? args[1] : sundialHome().appendingPathComponent(".daemon/audio-transcript.jsonl").path
private let whisperUrlString = args.count > 2 ? args[2] : "http://127.0.0.1:8771/inference"
private let modelPath = args.count > 3 ? args[3] : sundialHome().appendingPathComponent("models/ggml-large-v3-turbo-q5_0.bin").path
private let vadModelPath = args.count > 4 ? args[4] : sundialHome().appendingPathComponent("models/ggml-silero-v5.1.2.bin").path
/// How much quiet ends an utterance. Long enough to ride out the gap between
/// two sentences, short enough that a reply lands in the log while it is still
/// the same conversation.
private let silenceFlushMs = args.count > 5 ? (Int(args[5]) ?? 900) : 900
/// A hard ceiling, so a monologue (or a television) still produces text on a
/// steady cadence instead of one enormous utterance at the end of it.
private let maxUtteranceMs = args.count > 6 ? (Int(args[6]) ?? 25_000) : 25_000
/// J3.2 fallback: a whisper.cpp tinydiarize model (`*-tdrz.bin`). When set and
/// present, whisper-server runs on IT with `-tdrz` and marks speaker turns in
/// the text as `[_SPEAKER_TURN_]` — English only, so Dutch is lost meanwhile.
private let diarizeModelPath = args.count > 7 ? args[7] : ""
private let diarize = !diarizeModelPath.isEmpty && FileManager.default.fileExists(atPath: diarizeModelPath)

/// How far above the room's own noise floor counts as someone speaking.
///
/// A FIXED threshold cannot work, and measuring proved it: this room reads
/// 0.0003 RMS when quiet, and the first draft's hard-coded 0.008 sat 25x over
/// that — fine here, and useless in a café, an open-plan floor, or next to a
/// fan, where the floor itself is louder than the threshold and the gate would
/// never close. A room has a baseline; speech is a rise above it. So the floor
/// is learned (see `noiseFloor`) and this is the multiple of it that counts as
/// voice.
private let speechRatio: Float = 3.5

/// The quietest the learned floor is allowed to be. A silent room's RMS is
/// dither and rounding, and `3.5x` of nearly-nothing is still nearly-nothing —
/// without this the gate would open on the noise of the converter itself.
private let noiseFloorMin: Float = 0.0015

/// Once an utterance is open, it takes LESS to keep it than to start it. A
/// single threshold cuts on the pause between two words and hands whisper a
/// fragment; this is the hysteresis that rides those pauses out.
private let holdRatio: Float = 0.55

/// The machine's own microphone, by TRANSPORT TYPE rather than by name or UID.
///
/// `BuiltInMicrophoneDevice` is the UID on this Mac, but a UID is a per-model
/// detail and a localized name ("MacBook Pro Microphone") is worse. Asking
/// CoreAudio which device is attached by built-in transport is the question
/// actually being asked, and it answers the same way on every Mac that has one.
private func builtInInputDevice() -> AudioDeviceID? {
    var listAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &listAddress, 0, nil, &size) == noErr, size > 0 else { return nil }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &listAddress, 0, nil, &size, &devices) == noErr else { return nil }

    for device in devices {
        var transportAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var transport: UInt32 = 0
        var transportSize = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &transportAddress, 0, nil, &transportSize, &transport) == noErr,
              transport == kAudioDeviceTransportTypeBuiltIn else { continue }

        // Built-in OUTPUT is also built-in transport, so require input channels.
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &streamAddress, 0, nil, &streamSize) == noErr, streamSize > 0 else { continue }
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: Int(streamSize), alignment: 16)
        defer { buffer.deallocate() }
        guard AudioObjectGetPropertyData(device, &streamAddress, 0, nil, &streamSize, buffer) == noErr else { continue }
        let channels = UnsafeMutableAudioBufferListPointer(buffer.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
        if channels > 0 { return device }
    }
    return nil
}

/// The selected device's name, for the status file. Reporting `listening` without
/// saying WHAT it is listening to is what made a Bluetooth speaker holding the
/// default input look identical to a working microphone.
private func deviceName(_ id: AudioDeviceID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    // `Unmanaged`, not a bare `CFString` var: CoreAudio returns a +1 reference
    // here, and writing it through a pointer to a managed CFString both leaks
    // and hands ARC an object it never retained.
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr,
          let resolved = name?.takeRetainedValue() else { return "unknown" }
    return resolved as String
}

/// The room's learned floor and the latest block's loudness, for the status
/// file. Plain vars rather than a lock: they are a readout, and a torn read of
/// a diagnostic float costs nothing.
var pinnedDevice = "system default"
var lastKnownFloor: Float = 0
var lastKnownRms: Float = 0

/// Whisper wants 16 kHz mono, and so does every byte of plumbing below.
private let sampleRate = 16_000.0

private let statusPath = sundialHome().appendingPathComponent(".daemon/audio-status.json").path

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private func writeStatus(_ fields: [String: Any]) {
    var payload = fields
    payload["at"] = isoFormatter.string(from: Date())
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return }
    let tmp = statusPath + ".tmp"
    try? data.write(to: URL(fileURLWithPath: tmp))
    _ = try? FileManager.default.replaceItemAt(URL(fileURLWithPath: statusPath), withItemAt: URL(fileURLWithPath: tmp))
}

private func log(_ message: String) {
    FileHandle.standardError.write("sundial-audio-helper: \(message)\n".data(using: .utf8)!)
}

// MARK: - The transcriber, as a child

/// whisper-server holds the model in Metal and answers over loopback. It is a
/// CHILD of this helper rather than of the launcher so that one thing owns the
/// model's lifetime: when hearing stops, the half-gigabyte of weights goes with
/// it, and the launcher's SIGTERM cascade already reaches through here.
///
/// It needs no TCC of its own — it never touches a device, only a socket.
var whisperChild: Process?

private func whisperBinary() -> String? {
    let candidates = ["/opt/homebrew/bin/whisper-server", "/usr/local/bin/whisper-server"]
    for path in candidates where FileManager.default.isExecutableFile(atPath: path) { return path }
    // PATH, for a machine that keeps it somewhere else.
    let which = Process()
    which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    which.arguments = ["which", "whisper-server"]
    let pipe = Pipe()
    which.standardOutput = pipe
    which.standardError = FileHandle.nullDevice
    try? which.run()
    which.waitUntilExit()
    let found = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return FileManager.default.isExecutableFile(atPath: found) ? found : nil
}

private func startWhisper(port: Int) -> Bool {
    guard let binary = whisperBinary() else {
        writeStatus(["state": "no-transcriber", "detail": "whisper-server not installed (brew install whisper-cpp)"])
        log("whisper-server not found; nothing to transcribe with")
        return false
    }
    guard FileManager.default.fileExists(atPath: modelPath) else {
        writeStatus(["state": "no-model", "detail": modelPath])
        log("model missing at \(modelPath)")
        return false
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: binary)
    var arguments = [
        "-m", diarize ? diarizeModelPath : modelPath,
        "-l", diarize ? "en" : "auto",
        "--host", "127.0.0.1",
        "--port", String(port),
        "-t", "8",
    ]
    // Silero segmentation, when the model is there. Without it whisper still
    // transcribes; it just returns one block per POST instead of per sentence.
    if FileManager.default.fileExists(atPath: vadModelPath) {
        arguments.append(contentsOf: ["--vad", "-vm", vadModelPath])
    }
    if diarize { arguments.append("-tdrz") }
    task.arguments = arguments
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    do {
        try task.run()
    } catch {
        writeStatus(["state": "transcriber-failed", "detail": String(describing: error)])
        log("could not start whisper-server: \(error)")
        return false
    }
    whisperChild = task
    return true
}

private func stopWhisper() {
    guard let task = whisperChild, task.isRunning else { return }
    task.terminate()
}

// MARK: - WAV, in memory

/// A 16-bit PCM mono WAV around the samples. whisper-server takes a file
/// upload, so an utterance becomes a few hundred kilobytes of header+samples
/// that exist for exactly one HTTP request.
private func wav(from samples: [Int16], rate: Int = 16_000) -> Data {
    var data = Data()
    let byteCount = samples.count * 2
    func u32(_ value: UInt32) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    func u16(_ value: UInt16) { withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) } }
    data.append(contentsOf: Array("RIFF".utf8))
    u32(UInt32(36 + byteCount))
    data.append(contentsOf: Array("WAVE".utf8))
    data.append(contentsOf: Array("fmt ".utf8))
    u32(16)
    u16(1)                                  // PCM
    u16(1)                                  // mono
    u32(UInt32(rate))
    u32(UInt32(rate * 2))                   // byte rate
    u16(2)                                  // block align
    u16(16)                                 // bits
    data.append(contentsOf: Array("data".utf8))
    u32(UInt32(byteCount))
    samples.withUnsafeBufferPointer { data.append(UnsafeRawBufferPointer($0).bindMemory(to: UInt8.self)) }
    return data
}

// MARK: - The transcript file

private let appendQueue = DispatchQueue(label: "dev.sundial.audio.append")

/// One utterance, one line. Append-only and never rewritten, because the sensor
/// that reads it holds a byte offset — rewriting the file would make every
/// offset it remembers point at the wrong place.
private func appendLines(_ rows: [[String: Any]]) {
    appendQueue.sync {
        var blob = Data()
        for row in rows {
            guard let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { continue }
            blob.append(data)
            blob.append(0x0A)
        }
        guard !blob.isEmpty else { return }
        let url = URL(fileURLWithPath: outJsonl)
        if !FileManager.default.fileExists(atPath: outJsonl) {
            FileManager.default.createFile(atPath: outJsonl, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: blob)
    }
}

// MARK: - Transcribe one utterance

private let session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 120
    return URLSession(configuration: config)
}()

private func transcribe(samples: [Int16], startedAt: Date, endedAt: Date, source: String) {
    guard let url = URL(string: whisperUrlString) else { return }
    let audio = wav(from: samples)
    let boundary = "sundial-\(UUID().uuidString)"
    var body = Data()
    func field(_ name: String, _ value: String) {
        body.append(contentsOf: Array("--\(boundary)\r\n".utf8))
        body.append(contentsOf: Array("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    body.append(contentsOf: Array("--\(boundary)\r\n".utf8))
    body.append(contentsOf: Array("Content-Disposition: form-data; name=\"file\"; filename=\"utterance.wav\"\r\n".utf8))
    body.append(contentsOf: Array("Content-Type: audio/wav\r\n\r\n".utf8))
    body.append(audio)
    body.append(contentsOf: Array("\r\n".utf8))
    field("response_format", "verbose_json")
    field("language", "auto")
    body.append(contentsOf: Array("--\(boundary)--\r\n".utf8))

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
    request.httpBody = body

    let durationMs = Int(endedAt.timeIntervalSince(startedAt) * 1000)
    session.dataTask(with: request) { data, _, error in
        if let error {
            writeStatus(["state": "transcribe-failed", "detail": error.localizedDescription])
            return
        }
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        let language = (json["language"] as? String) ?? "unknown"
        // Prefer whisper's own segments: with Silero on, each is one spoken
        // stretch with its own offsets, which is what makes a transcript
        // readable later instead of one wall of text per flush.
        var rows: [[String: Any]] = []
        let segments = (json["segments"] as? [[String: Any]]) ?? []
        for segment in segments {
            let text = ((segment["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            let offset = (segment["start"] as? NSNumber)?.doubleValue ?? 0
            let end = (segment["end"] as? NSNumber)?.doubleValue ?? 0
            rows.append([
                "at": isoFormatter.string(from: startedAt.addingTimeInterval(offset)),
                "startedAt": isoFormatter.string(from: startedAt),
                "offsetMs": Int(offset * 1000),
                "durationMs": Int(max(0, end - offset) * 1000),
                "language": language,
                "text": text,
                // Whisper's OWN judgement of whether this was speech at all, and
                // how sure it was of the words. Handed on rather than acted on
                // here: what counts as too unsure is a policy the sensor owns,
                // and a helper that dropped a row would leave no trace of the
                // decision. Measured on real Dutch off this microphone:
                // `noSpeechProb` 0.007. The invented sentences — Korean and
                // Turkish that nobody in the room speaks — score far higher.
                //
                // This, not a language allow-list, is the filter that fits the
                // owner: they also speak PAPIAMENTO, which whisper does not
                // support at all, so their real speech comes back labelled
                // Spanish or Portuguese. Judging the language would delete it
                // for ever; judging the confidence keeps it.
                "noSpeechProb": (segment["no_speech_prob"] as? NSNumber)?.doubleValue ?? 0,
                "avgLogprob": (segment["avg_logprob"] as? NSNumber)?.doubleValue ?? 0,
                "source": source,
            ])
        }
        if rows.isEmpty {
            let whole = ((json["text"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if whole.isEmpty { return }
            rows.append([
                "at": isoFormatter.string(from: startedAt),
                "startedAt": isoFormatter.string(from: startedAt),
                "offsetMs": 0,
                "durationMs": durationMs,
                "language": language,
                "text": whole,
                "source": source,
            ])
        }
        bleed.offer(rows, source: source, start: startedAt, end: endedAt)
        writeStatus([
            "state": "listening",
            "lastUtteranceAt": isoFormatter.string(from: endedAt),
            "lastLanguage": language,
            "lastSegments": rows.count,
            "noiseFloor": Double(String(format: "%.5f", lastKnownFloor)) ?? 0,
            "lastRms": Double(String(format: "%.5f", lastKnownRms)) ?? 0,
        ])
    }.resume()
}

// MARK: - Capture

/// Loudness gate for one stream: learns the stream's own floor, collects an
/// utterance while it is above it, and hands the utterance to whisper when it
/// goes quiet. The microphone and the system output each get one, because a
/// call's far side is loud in one and faint in the other.
private final class Gate {
    let source: String
    private var pending: [Int16] = []
    private var utteranceStart: Date?
    private var lastLoudAt: Date?
    private let lock = NSLock()

    /// The room, as a number. Tracked asymmetrically on purpose: it falls
    /// quickly toward any quieter block and rises very slowly, so a lull
    /// re-learns the baseline within a second while a minute of talking barely
    /// moves it. The other way round, speech would raise the floor until it
    /// stopped clearing its own threshold and the gate would shut mid-sentence.
    private var noiseFloor: Float = 0.01
    private var floorSeen = false

    init(source: String) { self.source = source }

    func feed(_ samples: [Int16]) {
        let frames = samples.count
        // Loudness on this block, as RMS over the normalized samples.
        var sum: Float = 0
        for sample in samples {
            let value = Float(sample) / 32768.0
            sum += value * value
        }
        let rms = frames > 0 ? (sum / Float(frames)).squareRoot() : 0
        let now = Date()

        lock.lock()
        // Learn the room first, then judge the block against it.
        if !floorSeen {
            noiseFloor = rms
            floorSeen = true
        } else if rms < noiseFloor {
            noiseFloor += (rms - noiseFloor) * 0.25
        } else {
            noiseFloor += (rms - noiseFloor) * 0.002
        }
        let floor = max(noiseFloorMin, noiseFloor)
        let openAt = floor * speechRatio
        // Hysteresis: a higher bar to begin, a lower one to continue.
        let threshold = utteranceStart == nil ? openAt : openAt * holdRatio
        if rms >= threshold {
            if utteranceStart == nil { utteranceStart = now }
            lastLoudAt = now
        }
        // Keep the quiet tail too: cutting exactly on the threshold clips the
        // ends of words, which is where whisper loses the most accuracy.
        if utteranceStart != nil { pending.append(contentsOf: samples) }

        // Published so the status file can show what the room sounds like — the
        // one number that explains why hearing is or is not triggering.
        if source == "mic" {
            lastKnownFloor = floor
            lastKnownRms = rms
        }
        let started = utteranceStart
        let quietFor = lastLoudAt.map { now.timeIntervalSince($0) * 1000 } ?? 0
        let heldFor = started.map { now.timeIntervalSince($0) * 1000 } ?? 0
        var flush: [Int16] = []
        var flushStart = now
        if started != nil && (quietFor >= Double(silenceFlushMs) || heldFor >= Double(maxUtteranceMs)) {
            flush = pending
            flushStart = started!
            pending.removeAll(keepingCapacity: true)
            utteranceStart = nil
            lastLoudAt = nil
        }
        lock.unlock()

        // Ignore a flush too short to be a word — a door, a cough, a keyboard.
        if flush.count >= Int(sampleRate * 0.35) {
            transcribe(samples: flush, startedAt: flushStart, endedAt: now, source: source)
        }
    }

    /// Drop whatever was mid-utterance. A window closes on a timer, so the
    /// tail of it is usually a half sentence with no end — flushing it into
    /// the NEXT window would file the end of this morning's standup as the
    /// first thing said in this afternoon's, which is worse than losing it.
    /// The room is re-learned too: the next window may be a different room.
    func reset() {
        lock.lock()
        pending.removeAll()
        utteranceStart = nil
        lastLoudAt = nil
        floorSeen = false
        lock.unlock()
    }
}

/// Any buffer, as 16 kHz mono Int16 — the only shape the gate and whisper see.
private func resample(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to target: AVAudioFormat) -> [Int16] {
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1024
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
    var supplied = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
        if supplied {
            status.pointee = .noDataNow
            return nil
        }
        supplied = true
        status.pointee = .haveData
        return buffer
    }
    guard error == nil, out.frameLength > 0, let channel = out.int16ChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
}

private let mono16k = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!

private final class Ears {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    let gate = Gate(source: "mic")

    func start() throws {
        let input = engine.inputNode
        // Pin the BUILT-IN microphone, rather than following the system default.
        //
        // Measured, and the reason hearing silently did nothing: the owner's
        // default input was a paired Bluetooth speaker ("Muzi blasta") that
        // advertises one input channel and never streams a sample. The engine
        // started without error, the helper reported `listening`, and CoreAudio
        // showed `runningSomewhere = 0` on every device — no microphone was
        // running at all. A default input is an output-routing preference as
        // often as it is a microphone choice, and a speaker being selected must
        // not decide whether Gnomon can hear.
        //
        // The built-in mic is also the honest answer to what was asked for:
        // ambient hearing is the machine's own ears, sitting where the owner is.
        // A headset would capture their voice more cleanly and the room far
        // worse, which is the opposite of the goal.
        if let builtIn = builtInInputDevice(), let unit = input.audioUnit {
            var device = builtIn
            let status = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size))
            // Not fatal: a machine with no built-in mic (a Mac mini, an external
            // rig) should still hear through whatever the default is.
            if status != noErr { log("could not pin the built-in microphone (status \(status)); using the system default") }
            else { pinnedDevice = deviceName(builtIn) }
        }
        // Read the format AFTER pinning — it belongs to the device now selected.
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0 else { throw NSError(domain: "sundial.audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "no input device"]) }
        let converter = AVAudioConverter(from: inputFormat, to: mono16k)
        self.converter = converter
        // Whatever the device offers, resampled once here, so every stage below
        // this line only ever sees 16 kHz mono.
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let converter else { return }
            let samples = resample(buffer, with: converter, to: mono16k)
            if !samples.isEmpty { self.gate.feed(samples) }
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        gate.reset()
    }
}

// MARK: - The far side of a call

/// What the Mac is PLAYING, through a CoreAudio process tap (macOS 14.2+):
/// the other people in a call, whose voices otherwise only reach the log as
/// whatever leaks from the speakers into the microphone — and not at all
/// through headphones. Text only, like the microphone; the samples go to
/// whisper and are dropped.
///
/// macOS asks the owner once ("System Audio Recording Only") the first time
/// the tap starts. A refused tap does not fail: it delivers silence, the gate
/// never opens, and hearing carries on with the microphone alone.
private final class SystemEars {
    let gate = Gate(source: "system")
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "dev.sundial.audio.system")
    private(set) var running = false

    func start() {
        guard #available(macOS 14.2, *), !running else { return }
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Sundial hearing"
        description.isPrivate = true
        description.muteBehavior = .unmuted
        guard AudioHardwareCreateProcessTap(description, &tapID) == noErr else { return fail("could not create the system audio tap") }

        var format = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &format) == noErr,
              let tapFormat = AVAudioFormat(streamDescription: &format),
              let converter = AVAudioConverter(from: tapFormat, to: mono16k) else { return fail("could not read the tap's format") }

        // A tap is read through a private aggregate device that holds it, with
        // the current output device as its clock — the shape of Apple's own
        // "Capturing system audio with Core Audio taps" sample.
        guard let outputUID = defaultOutputUID() else { return fail("no output device to follow") }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Sundial hearing",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]],
        ]
        guard AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID) == noErr else { return fail("could not create the tap's aggregate device") }

        let status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, input, _, _, _ in
            guard let self,
                  let buffer = AVAudioPCMBuffer(pcmFormat: tapFormat, bufferListNoCopy: input, deallocator: nil) else { return }
            let samples = resample(buffer, with: converter, to: mono16k)
            if !samples.isEmpty { self.gate.feed(samples) }
        }
        guard status == noErr, AudioDeviceStart(aggregateID, procID) == noErr else { return fail("could not start the system audio tap") }
        running = true
    }

    func stop() {
        if let procID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
        }
        procID = nil
        if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
        aggregateID = AudioObjectID(kAudioObjectUnknown)
        if #available(macOS 14.2, *), tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
        tapID = AudioObjectID(kAudioObjectUnknown)
        running = false
        gate.reset()
    }

    private func defaultOutputUID() -> String? {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr else { return nil }
        var uid: Unmanaged<CFString>?
        var uidSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var uidAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(device, &uidAddress, 0, nil, &uidSize, &uid) == noErr else { return nil }
        return uid?.takeRetainedValue() as String?
    }

    /// Not fatal: the microphone still hears. Logged, and everything made so far is torn down.
    private func fail(_ message: String) {
        log("\(message); hearing the microphone only")
        stop()
    }
}

// MARK: - Speaker bleed

/// With speakers instead of headphones, the microphone hears the far side of
/// a call too, and the same sentence would be filed twice: once as the owner's.
/// So while the system stream is running, a microphone line waits a few
/// seconds for the system line it may be an echo of, and is dropped when one
/// overlapping in time says mostly the same words.
private final class Bleed {
    private struct Heard { let start: Date; let end: Date; let words: Set<String> }
    private struct Held { let rows: [[String: Any]]; let heard: Heard; let deadline: Date }
    private var system: [Heard] = []
    private var held: [Held] = []
    private let lock = NSLock()
    var systemRunning = false

    private static func words(_ rows: [[String: Any]]) -> Set<String> {
        let text = rows.compactMap { $0["text"] as? String }.joined(separator: " ").lowercased()
        return Set(text.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty })
    }

    private static func echoes(_ mic: Heard, _ far: Heard) -> Bool {
        guard mic.start < far.end.addingTimeInterval(2), far.start < mic.end.addingTimeInterval(2) else { return false }
        let smaller = min(mic.words.count, far.words.count)
        guard smaller > 0 else { return false }
        let shared = mic.words.intersection(far.words).count
        return smaller < 3 ? mic.words == far.words : Double(shared) / Double(smaller) >= 0.6
    }

    func offer(_ rows: [[String: Any]], source: String, start: Date, end: Date) {
        let heard = Heard(start: start, end: end, words: Self.words(rows))
        lock.lock()
        if source == "system" {
            system.append(heard)
            system.removeAll { $0.end < Date().addingTimeInterval(-60) }
            held.removeAll { Self.echoes($0.heard, heard) }
            lock.unlock()
            appendLines(rows)
            return
        }
        let echo = system.contains { Self.echoes(heard, $0) }
        if !echo && systemRunning { held.append(Held(rows: rows, heard: heard, deadline: Date().addingTimeInterval(8))) }
        lock.unlock()
        if !echo && !systemRunning { appendLines(rows) }
    }

    /// Write the microphone lines no echo claimed in time. `all` at shutdown of the stream.
    func release(all: Bool = false) {
        lock.lock()
        let now = Date()
        let due = held.filter { all || $0.deadline <= now }
        held.removeAll { all || $0.deadline <= now }
        lock.unlock()
        for item in due { appendLines(item.rows) }
    }
}

private let bleed = Bleed()

// MARK: - Run

private let ears = Ears()
private let systemEars = SystemEars()

/// The window file the kernel publishes: `{ listen, reason, until, title }`.
private let listenWindowPath = sundialHome().appendingPathComponent(".daemon/audio-listen.json").path

/// The transcriber stays WARM while hearing sleeps, holding its model in memory.
/// Loading it costs ~18 seconds, and the whole point of waking three minutes
/// before a meeting is to be ready when the first person speaks; paying that
/// load at the start of every call would spend the lead time it was given.
///
/// Whether the microphone is open right now, so a one-second poll only acts on
/// a CHANGE rather than restarting the engine every tick.
private var listening = false
private var listenReason = ""

/// Read the kernel's decision. A missing or unreadable file means DO NOT LISTEN.
///
/// Fail-closed is the whole point. The old always-on helper heard a quiet room
/// all day and whisper filled it in: 229 utterances in 28 minutes across 15
/// languages, every one scored as confidently speech. If the harness is down,
/// mid-restart, or has not decided yet, a closed microphone is the honest
/// state — there is nobody to be in a meeting with.
private func readListenWindow() -> (listen: Bool, reason: String) {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: listenWindowPath)),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let listen = json["listen"] as? Bool else {
        return (false, "")
    }
    // The DEADLINE is enforced here as well as in the rule that set it, because
    // this file is an instruction from a process that can die. If the harness
    // stops — crash, upgrade, a stopped LaunchAgent — the last thing it wrote
    // stays on disk, and an instruction that says `listen: true` with nobody
    // left to withdraw it would hold the microphone open indefinitely. An
    // expired window is a closed one no matter who is still running.
    if listen, let until = json["until"] as? String, let deadline = isoFormatter.date(from: until), deadline < Date() {
        return (false, "")
    }
    return (listen, (json["reason"] as? String) ?? "")
}

/// Open or close the microphone to match the window. Called on a timer, because
/// the window closes when NOTHING happens and nothing is not a notification.
private func applyListenWindow() {
    bleed.release()
    let window = readListenWindow()
    if window.listen == listening {
        if window.listen, window.reason != listenReason {
            listenReason = window.reason
            writeStatus(["state": "listening", "device": pinnedDevice, "reason": listenReason])
        }
        return
    }
    if window.listen {
        do {
            try ears.start()
            systemEars.start()
            bleed.systemRunning = systemEars.running
            listening = true
            listenReason = window.reason
            writeStatus(["state": "listening", "device": pinnedDevice, "reason": listenReason])
            log("listening (\(listenReason))")
        } catch {
            writeStatus(["state": "capture-failed", "detail": String(describing: error)])
            log("capture failed: \(error)")
        }
    } else {
        // Release the device, rather than tapping it and discarding frames. A
        // held microphone keeps the orange indicator lit, and a light that says
        // "listening" while nothing is being kept is a lie to whoever is in the
        // room.
        ears.stop()
        systemEars.stop()
        bleed.systemRunning = false
        bleed.release(all: true)
        listening = false
        listenReason = ""
        writeStatus(["state": "asleep", "device": pinnedDevice])
        log("asleep")
    }
}

private var windowTimer: DispatchSourceTimer?

private func begin() {
    let port = URL(string: whisperUrlString)?.port ?? 8771
    guard startWhisper(port: port) else { return }

    // Ask in our own name. Inheriting the bundle's identity is not enough — see
    // the header — and this is the call that raises the prompt and writes the
    // entry that matches this binary. Asked ONCE at startup even though the
    // microphone stays shut until a window opens: a permission prompt during a
    // meeting is worse than one at login.
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        guard granted else {
            writeStatus(["state": "denied", "detail": "microphone access refused; grant Sundial in System Settings → Privacy & Security → Microphone"])
            log("microphone denied")
            return
        }
        DispatchQueue.main.async {
            writeStatus(["state": "asleep", "device": pinnedDevice])
            log("armed; microphone stays shut until a meeting or a call opens the window")
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
            timer.schedule(deadline: .now(), repeating: 1)
            timer.setEventHandler { applyListenWindow() }
            timer.resume()
            windowTimer = timer
        }
    }
}

private func shutdown(_ code: Int32) {
    windowTimer?.cancel()
    windowTimer = nil
    ears.stop()
    systemEars.stop()
    stopWhisper()
    try? FileManager.default.removeItem(atPath: statusPath)
    exit(code)
}

signal(SIGTERM) { _ in shutdown(0) }
signal(SIGINT) { _ in shutdown(0) }

begin()
// The main run loop, not dispatchMain(): AVAudioEngine's own notifications and
// the URLSession completions want a pumped main loop, the same reason
// SleepWakeCapture gives in the launcher.
RunLoop.main.run()
