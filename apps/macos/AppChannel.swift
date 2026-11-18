// The app's end of the app channel (packages/harness-runtime/src/app-channel.ts) and the knock:
// Node appends a command line to app-commands.jsonl, the app appends what happened to app-events.jsonl.

import AppKit
import AVFoundation
import Carbon.HIToolbox

/// `experiments.<name>` in config.json when the app started. The colleague's switches are on unless set to false.
private func experimentOn(_ name: String) -> Bool {
    guard let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
          let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return true }
    return (config["experiments"] as? [String: Any])?[name] as? Bool ?? true
}

/// The menu shows "Quiet" only with the knock on.
let voiceKnockOn = experimentOn("voiceKnock")
/// Plan 15 step 2: the summon comes up without taking the keyboard.
let quietSummonOn = experimentOn("quietSummon")
/// Plan 15 step 3: hold the summon key and speak.
let holdToTalkOn = experimentOn("holdToTalk")
/// 27 section 3 item 9: a thin tree's window kept as a picture for a grounding fallback. Off unless set to true: it writes pixels to disk.
let windowCaptureOn: Bool = {
    guard let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
          let config = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
    return (config["experiments"] as? [String: Any])?["windowCapture"] as? Bool == true
}()

let voice = Voice()

/// Plan 15 review: plain Esc can be a hotkey only once. The knock, the quiet summon and a guide each say while
/// they need it; the newest one gets the key.
enum Esc {
    private static var users: [(name: String, run: () -> Void)] = []
    private static var ref: EventHotKeyRef?

    static func want(_ name: String, _ run: @escaping () -> Void) {
        users.removeAll { $0.name == name }
        users.append((name, run))
        if ref == nil { ref = registerHotKey(id: 3, key: UInt32(kVK_Escape), modifiers: 0) { users.last?.run() } }
    }

    static func drop(_ name: String) {
        users.removeAll { $0.name == name }
        guard users.isEmpty, let held = ref else { return }
        UnregisterEventHotKey(held)
        ref = nil
        hotKeys[3] = nil
    }
}

/// Plan 15 step 2: the app's half of the summon. The page writes typing, looking and the place it attached.
enum Summon {
    private static let channel = AppChannel()
    static func summoned(_ id: String) { channel.emit("overlay:summoned", ["summonId": id]) }
    static func dismissed(_ id: String) { channel.emit("overlay:dismissed", ["summonId": id]) }
    static func steppedBack(_ id: String) { channel.emit("overlay:first-move", ["summonId": id, "kind": "step-back"]) }
}

final class AppChannel {
    private let commands = daemonDir.appendingPathComponent("app-commands.jsonl")
    private let events = daemonDir.appendingPathComponent("app-events.jsonl")
    private var offset: UInt64 = 0
    private var rest = Data()
    private var source: DispatchSourceFileSystemObject?
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    var onCommand: ([String: Any]) -> Void = { _ in }

    /// A command from before this start is cut: nobody waits for it now.
    func start() {
        try? FileManager.default.createDirectory(at: daemonDir, withIntermediateDirectories: true)
        try? Data().write(to: commands)
        watch()
    }

    /// Node appends in place, so the watch is on the file itself: a folder watch does not see an append.
    private func watch() {
        let fd = open(commands.path, O_EVTONLY)
        guard fd >= 0 else { log("app channel: cannot watch \(commands.path)"); return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.extend, .write, .delete, .rename], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self, let seen = self.source?.data else { return }
            if !seen.isDisjoint(with: [.delete, .rename]) {
                self.source?.cancel()
                self.offset = 0
                self.rest = Data()
                if !FileManager.default.fileExists(atPath: self.commands.path) { try? Data().write(to: self.commands) }
                self.watch()
            }
            self.drain()
        }
        source.setCancelHandler { close(fd) }
        self.source = source
        source.resume()
    }

    private func drain() {
        guard let handle = try? FileHandle(forReadingFrom: commands) else { return }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        if size < offset { offset = 0; rest = Data() }
        guard size > offset, (try? handle.seek(toOffset: offset)) != nil, let chunk = try? handle.readToEnd() else { return }
        offset += UInt64(chunk.count)
        rest.append(chunk)
        while let newline = rest.firstIndex(of: 0x0A) {
            let line = Data(rest[rest.startIndex..<newline])
            rest = Data(rest[(newline + 1)...])
            guard let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                  let at = (command["at"] as? String).flatMap({ stamp.date(from: $0) }) else { continue }
            // A late command is a knock for a moment that is gone.
            guard Date().timeIntervalSince(at) <= 5 else { log("app channel: dropped a late \(command["type"] as? String ?? "command")"); continue }
            onCommand(command)
        }
    }

    func emit(_ type: String, _ payload: [String: Any] = [:]) {
        // No line id: the payload's own `id` (a mark's, an act's) is what Node waits on.
        var line = payload
        line["type"] = type
        line["at"] = stamp.string(from: Date())
        guard var data = try? JSONSerialization.data(withJSONObject: line) else { return }
        data.append(0x0A)
        let fd = open(events.path, O_WRONLY | O_APPEND | O_CREAT, 0o600)
        guard fd >= 0 else { log("app channel: cannot write \(type)"); return }
        data.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
        close(fd)
    }
}

/// `voice` in config.json: the engine, the voice name, and (plan 15 step 3) the Python that runs Kokoro.
let voiceConfig: (engine: String, name: String?, python: String?) = {
    let json = (try? Data(contentsOf: home.appendingPathComponent("config.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let v = json?["voice"] as? [String: Any]
    return (v?["engine"] as? String == "system" ? "system" : "kokoro", v?["name"] as? String, v?["python"] as? String)
}()

/// The knock: a sound, then five seconds in which the hotkey means "go" and Esc means "not now".
/// Plan 15 step 3: also the spoken reply, sentence by sentence, in Kokoro or the system voice, and the owner's stop.
final class Voice: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private let channel = AppChannel()
    private let synth = AVSpeechSynthesizer()
    private var waiting: (key: String, text: String?, voice: String?)?
    private var timeout: DispatchWorkItem?
    private var keys: [EventHotKeyRef] = []
    private var sound: NSSound?
    private lazy var kokoro = Kokoro.start()
    /// The sentences of one spoken turn, in their order; the line being said; what was said, for one `voice:said`.
    private var queue: [(seq: Int, text: String, lang: String?, last: Bool, stepId: String?, at: Date)] = []
    /// Round 5: the screen step whose line is about to sound; its `voice:said` is written the moment it starts.
    private var stepLine: (id: String, text: String)?
    private var nextSeq = 0
    private var turnAt: String?
    private var lineDone: (() -> Void)?
    private var player: AVAudioPlayer?
    private var said: [String] = []
    private var saidMode = "reply"
    private var releasedAt: Date?
    private var nodAt: Date?
    private var firstWordAt: Date?
    private var lineToken = 0

    var quietUntil: Date? {
        let at = UserDefaults.standard.double(forKey: "SundialQuietUntil")
        return at > Date().timeIntervalSince1970 ? Date(timeIntervalSince1970: at) : nil
    }

    /// Gnomon's voice is sounding, or has sentences still to say.
    var speaking: Bool { lineDone != nil || !queue.isEmpty }

    func start() {
        synth.delegate = self
        channel.onCommand = { [weak self] command in
            switch command["type"] as? String {
            case "speak": self?.speak(command)
            case "marks": screen.marks(command["marks"] as? [[String: Any]] ?? [], judge: command["judge"] as? Bool == true)
            case "act": screen.act(command)
            case "look": looks.look(command)
            case "place": looks.place(command)
            case "unplace": looks.unplace(command)
            default: break
            }
        }
        channel.start()
        // Runs 42, 50, 57: a frozen Finder held each AX call for the 6 s default; every call of this app now gives up in 2 s.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2)
        _ = kokoro
    }

    func toggleQuiet() {
        if quietUntil != nil {
            UserDefaults.standard.removeObject(forKey: "SundialQuietUntil")
            channel.emit("voice:muted", ["off": true])
        } else {
            UserDefaults.standard.set(Date().timeIntervalSince1970 + 3600, forKey: "SundialQuietUntil")
            channel.emit("voice:muted")
        }
    }

    /// The owner's go; false when no knock waits.
    func go() -> Bool {
        guard let knock = answer("voice:go") else { return false }
        utter(knock.text, lang: nil, name: knock.voice, mode: "notice")
        return true
    }

    /// The key was let go after a hold: the nod, at once, here. The reply that follows is timed from this.
    func nod() {
        finishTurn()
        releasedAt = Date()
        play("nod")
        nodAt = Date()
        firstWordAt = nil
    }

    /// The owner's stop (the key again, or Esc): silence now; the host drops what it has not sent.
    func stop() {
        guard speaking else { return }
        queue = []
        stepLine = nil
        synth.stopSpeaking(at: .immediate)
        player?.stop()
        player = nil
        lineDone = nil
        channel.emit("voice:interrupted", ["turnAt": turnAt ?? ""])
        finishTurn()
    }

    private func speak(_ command: [String: Any]) {
        let text = command["text"] as? String
        let name = (command["voice"] as? [String: Any])?["name"] as? String
        let sound = command["sound"] as? String
        if command["mode"] as? String == "reply" { return reply(command) }
        // A reply is being said: the notice waits its turn instead of cutting it off.
        if turnAt != nil, speaking { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.speak(command) }; return }
        // A spoken go (the fold heard "yes"): the knock is answered, and its sentence is said now.
        if let key = command["noticeKey"] as? String, sound == nil, waiting?.key == key { clearWait() }
        guard sound == "knock", let key = command["noticeKey"] as? String else {
            play(sound)
            utter(text, lang: nil, name: name, mode: "notice")
            return
        }
        // A password field has the keyboard: no sound, and no key is taken.
        if IsSecureEventInputEnabled() { channel.emit("voice:declined", ["noticeKey": key, "reason": "secure-input"]); return }
        if quietUntil != nil { channel.emit("voice:unanswered", ["noticeKey": key, "reason": "quiet"]); return }
        answer("voice:unanswered")
        play("knock")
        if command["mode"] as? String == "knock-speak" {
            channel.emit("voice:go", ["noticeKey": key, "auto": true])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.utter(text, lang: nil, name: name, mode: "notice") }
            return
        }
        waiting = (key, text, name)
        if hotKeys[1] == nil, let hotkey = parseHotkey(overlayConfig.hotkey),
           let ref = registerHotKey(id: 2, key: hotkey.key, modifiers: hotkey.modifiers, { [weak self] in _ = self?.go() }) { keys.append(ref) }
        Esc.want("knock") { [weak self] in _ = self?.answer("voice:declined", ["reason": "esc"]) }
        let work = DispatchWorkItem { [weak self] in _ = self?.answer("voice:unanswered") }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
    }

    /// Ends the wait and writes how it ended; nil when no knock waits.
    @discardableResult private func answer(_ type: String, _ more: [String: Any] = [:]) -> (text: String?, voice: String?)? {
        guard let knock = waiting else { return nil }
        clearWait()
        channel.emit(type, more.merging(["noticeKey": knock.key]) { _, key in key })
        return (knock.text, knock.voice)
    }

    private func clearWait() {
        waiting = nil
        timeout?.cancel()
        for ref in keys { UnregisterEventHotKey(ref) }
        keys = []
        hotKeys[2] = nil
        Esc.drop("knock")
    }

    /// One sentence of a spoken reply. The host sends them in order (`seq`) per turn (`turnAt`); a new turn ends the last.
    private func reply(_ command: [String: Any]) {
        let last = command["last"] as? Bool ?? false
        guard let text = command["text"] as? String, !text.isEmpty || last else { return }
        let turn = command["turnAt"] as? String
        if turn != turnAt {
            if turnAt != nil { finishTurn() }
            turnAt = turn
            nextSeq = 0
            queue = []
        }
        let step = (command["stepId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        queue.append((command["seq"] as? Int ?? nextSeq, text, command["lang"] as? String, last, step, Date()))
        queue.sort { $0.seq < $1.seq }
        pump()
    }

    private func pump() {
        guard lineDone == nil, let next = queue.first else { return }
        guard next.seq <= nextSeq else {
            // A line that never came (dropped as late, or cut by a stop): after a second, go on without it.
            let waiting = nextSeq
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self, self.nextSeq == waiting, let first = self.queue.first, first.seq > waiting else { return }
                self.nextSeq = first.seq
                self.pump()
            }
            return
        }
        queue.removeFirst()
        nextSeq = next.seq + 1
        if next.text.isEmpty { return next.last && queue.isEmpty ? finishTurn() : pump() }
        // A step's line that waited 5 s behind the reply is about a step long done: dropped, as a late command is.
        if next.stepId != nil, Date().timeIntervalSince(next.at) > 5 { return pump() }
        stepLine = next.stepId.map { ($0, next.text) }
        utter(next.text, lang: next.lang, name: voiceConfig.name, mode: "reply") { [weak self] in
            guard let self else { return }
            if next.last && self.queue.isEmpty { self.finishTurn() } else { self.pump() }
        }
    }

    /// One `voice:said` per spoken turn: what was said, and the two times the owner feels.
    private func finishTurn() {
        defer { said = []; turnAt = nil; queue = []; nextSeq = 0 }
        guard !said.isEmpty else { return }
        var row: [String: Any] = ["text": said.joined(separator: " "), "mode": saidMode]
        if let releasedAt, let nodAt { row["nodMs"] = Int(nodAt.timeIntervalSince(releasedAt) * 1000) }
        if let releasedAt, let firstWordAt, saidMode == "reply" { row["firstWordMs"] = Int(firstWordAt.timeIntervalSince(releasedAt) * 1000) }
        channel.emit("voice:said", row)
        releasedAt = nil
        nodAt = nil
    }

    /// Say one line: Kokoro when it runs and the language is English, else the system voice for that language.
    private func utter(_ text: String?, lang: String?, name: String?, mode: String, done: (() -> Void)? = nil) {
        guard let text, !text.isEmpty else { done?(); return }
        if mode == "notice" { finishTurn(); stepLine = nil }
        saidMode = mode
        said.append(text)
        let finish: () -> Void = { [weak self] in
            self?.lineDone = nil
            done?()
            if mode == "notice" { self?.finishTurn() }
        }
        lineDone = finish
        lineToken += 1
        let token = lineToken
        let dutch = lang.map { $0.lowercased().hasPrefix("dutch") || $0.lowercased().hasPrefix("nl") } ?? false
        if let kokoro, !dutch, voiceConfig.engine == "kokoro" {
            kokoro.render(text, voice: name) { [weak self] url in
                defer { if let url { try? FileManager.default.removeItem(at: url) } }
                guard let self, self.lineDone != nil, token == self.lineToken else { return }
                guard let url, let player = try? AVAudioPlayer(contentsOf: url) else { return self.system(text, lang: lang, name: nil) }
                self.player = player
                player.delegate = self
                self.began()
                player.play()
            }
            return
        }
        system(text, lang: lang, name: name)
    }

    private func system(_ text: String, lang: String?, name: String?) {
        let utterance = AVSpeechUtterance(string: text)
        if let name, let match = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name == name || $0.identifier == name }) { utterance.voice = match }
        else if let lang, lang.lowercased().hasPrefix("dutch") || lang.lowercased().hasPrefix("nl") { utterance.voice = AVSpeechSynthesisVoice(language: "nl-NL") }
        synth.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) { began() }

    /// A line starts to sound. A step's line writes its own `voice:said` now, so the log can tell it began before the act's `screen:acted`.
    private func began() {
        firstWordAt = firstWordAt ?? Date()
        guard let step = stepLine else { return }
        stepLine = nil
        channel.emit("voice:said", ["text": step.text, "mode": "step", "stepId": step.id])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { lineDone?() }
    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        self.player = nil
        lineDone?()
    }

    private func play(_ name: String?) {
        guard let name, ["knock", "nod", "return"].contains(name) else { return }
        let file = URL(fileURLWithPath: repo ?? resources.appendingPathComponent("app").path).appendingPathComponent("apps/macos/sounds/\(name).wav")
        guard let sound = NSSound(contentsOf: file, byReference: true) else { log("voice: no sound at \(file.path)"); return }
        self.sound = sound
        sound.play()
    }
}

/// Plan 15 step 3, decision A: Kokoro as a helper process (apps/macos/kokoro-say.py), started once with the
/// Python in `voice.python`. It renders a sentence to a file; the app plays it, so a stop needs no round trip.
/// No Python, no script, or a crash: nil, and the system voice speaks.
final class Kokoro {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var buffer = Data()
    private var waiting: [String: (URL?) -> Void] = [:]
    private var ready = false

    static func start() -> Kokoro? {
        guard voiceConfig.engine == "kokoro", let python = voiceConfig.python, FileManager.default.isExecutableFile(atPath: python) else { return nil }
        let script = URL(fileURLWithPath: repo ?? resources.appendingPathComponent("app").path).appendingPathComponent("apps/macos/kokoro-say.py")
        guard FileManager.default.fileExists(atPath: script.path) else { log("voice: no Kokoro script at \(script.path)"); return nil }
        signal(SIGPIPE, SIG_IGN)
        try? FileManager.default.removeItem(at: daemonDir.appendingPathComponent("voice"))
        let kokoro = Kokoro()
        kokoro.process.executableURL = URL(fileURLWithPath: python)
        kokoro.process.arguments = [script.path, daemonDir.appendingPathComponent("voice").path]
        kokoro.process.environment = ProcessInfo.processInfo.environment.merging(["HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"]) { _, new in new }
        kokoro.process.standardInput = kokoro.input
        kokoro.process.standardOutput = kokoro.output
        kokoro.process.standardError = FileHandle.nullDevice
        kokoro.output.fileHandleForReading.readabilityHandler = { [weak kokoro] handle in
            let data = handle.availableData
            DispatchQueue.main.async { kokoro?.read(data) }
        }
        kokoro.process.terminationHandler = { [weak kokoro] _ in
            DispatchQueue.main.async {
                guard let kokoro else { return }
                kokoro.ready = false
                for done in kokoro.waiting.values { done(nil) }
                kokoro.waiting = [:]
                log("voice: Kokoro stopped; the system voice speaks")
            }
        }
        do { try kokoro.process.run() } catch { log("voice: Kokoro did not start: \(error)"); return nil }
        return kokoro
    }

    /// Lines that are not JSON (the model's own prints) are skipped.
    private func read(_ data: Data) {
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = Data(buffer[buffer.startIndex..<newline])
            buffer = Data(buffer[(newline + 1)...])
            guard let json = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { continue }
            if json["ready"] as? Bool == true { ready = true; log("voice: Kokoro ready") }
            if let id = json["id"] as? String, let done = waiting.removeValue(forKey: id) { done((json["path"] as? String).map { URL(fileURLWithPath: $0) }) }
        }
    }

    /// A sentence to a file. Not ready, or no answer in 4 s: nil.
    func render(_ text: String, voice: String?, _ done: @escaping (URL?) -> Void) {
        guard ready, process.isRunning, let line = try? JSONSerialization.data(withJSONObject: ["id": UUID().uuidString, "text": text, "voice": voice ?? "af_heart"]),
              let id = (try? JSONSerialization.jsonObject(with: line) as? [String: Any])?["id"] as? String else { return done(nil) }
        waiting[id] = done
        do { try input.fileHandleForWriting.write(contentsOf: line + Data([0x0A])) } catch { waiting[id] = nil; return done(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.waiting.removeValue(forKey: id)?(nil) }
    }
}

// MARK: - The screen (plan 15 steps 6, 7 and 8)
//
// Gnomon points at a named thing in another app, walks the owner through a task, and does one step on a named
// control. Found through the Accessibility API by app, role and label; the frame follows the thing through an
// AXObserver, no timer. The panel draws; a click goes through a mark to the app.

/// The panel's drawing of the marks: `[{id, x, y, w, h, shape, label?, step?, dashed}]` in screen points from the top left.
var drawMarks: (_ marks: [[String: Any]], _ judge: Bool) -> Void = { _, _ in }
/// The slip's solid part on screen (Cocoa points) while it shows: the screen stage keeps clear of it.
var slipFrame: () -> CGRect? = { nil }
/// true while Gnomon's hands post a click or a scroll: the slip lets the mouse through to the app, wherever it is solid.
/// false after, with the pointer back: where it is decides again. `back`: the owner's pointer before the hands moved it;
/// `target`: where Gnomon presses (doc 32 item 1: a press meant for the slip in that time is not lost).
var slipHands: (_ busy: Bool, _ back: CGPoint?, _ target: CGPoint?) -> Void = { _, _, _ in }

func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

func axText(_ element: AXUIElement, _ attribute: String) -> String? { axValue(element, attribute) as? String }

/// The element's frame on screen, in points from the top left of the main display.
func axFrame(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(element, kAXPositionAttribute), let size = axValue(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    AXValueGetValue(position as! AXValue, .cgPoint, &point)
    AXValueGetValue(size as! AXValue, .cgSize, &extent)
    return extent.width > 0 && extent.height > 0 ? CGRect(origin: point, size: extent) : nil
}

/// "menuitem", "menu item" and AXMenuItem name one role.
func flatRole(_ s: String?) -> String? { s?.lowercased().replacingOccurrences(of: " ", with: "") }

/// Its own frame, or for an item of a closed menu (0 x 0) the nearest parent that shows: the menu's title.
func shownFrame(_ element: AXUIElement) -> CGRect? {
    var at: AXUIElement? = element
    for _ in 0..<6 {
        guard let now = at else { return nil }
        if let frame = axFrame(now) { return frame }
        at = axValue(now, kAXParentAttribute).map { $0 as! AXUIElement }
    }
    return nil
}

/// A menu item's submenu, read without opening it: its first item titles, or nil when it has no submenu.
func submenuItems(_ element: AXUIElement) -> [String]? {
    guard axText(element, kAXRoleAttribute) == kAXMenuItemRole as String,
          let menu = axList(axValue(element, kAXChildrenAttribute)).first(where: { axText($0, kAXRoleAttribute) == kAXMenuRole as String }) else { return nil }
    return Array(axList(axValue(menu, kAXChildrenAttribute)).compactMap { axText($0, kAXTitleAttribute) }.filter { !$0.isEmpty }.prefix(6))
}

/// Never on the main thread. A menu's items by its path from the menu bar ("Edit", "View > Sort By"), read through AX children only:
/// nothing is opened, pressed or brought forward. nil: no such menu in the bar.
func menuList(_ pid: pid_t, _ path: [String], max: Int) -> [String]? {
    // A hung app costs a third of a second a read, not six.
    let short = { (element: AXUIElement) -> AXUIElement in AXUIElementSetMessagingTimeout(element, 0.3); return element }
    var items = axList(axElement(axValue(short(AXUIElementCreateApplication(pid)), kAXMenuBarAttribute)).flatMap { axValue(short($0), kAXChildrenAttribute) })
    for title in path {
        guard let hit = items.first(where: { lookTitle(axText(short($0), kAXTitleAttribute)) == title }) else { return nil }
        items = axList(axValue(hit, kAXChildrenAttribute)).filter { axText(short($0), kAXRoleAttribute) == kAXMenuRole as String }.flatMap { axList(axValue($0, kAXChildrenAttribute)) }
    }
    // A long History or Window menu: no more than 200 reads.
    return Array(items.prefix(200).compactMap { axText(short($0), kAXTitleAttribute) }.filter { !$0.isEmpty }.prefix(max))
}

/// Never on the main thread. The app answers a plain read: asked twice, half a second each, a second apart, before it counts
/// as hung. A hung app (Finder stuck in a menu, runs 42, 50, 57) answers neither.
func axResponds(_ pid: pid_t) -> Bool {
    let root = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(root, 0.5)
    var role: CFTypeRef?
    let asked = { AXUIElementCopyAttributeValue(root, kAXRoleAttribute as CFString, &role) != .cannotComplete }
    if asked() { return true }
    Thread.sleep(forTimeInterval: 1)
    return asked()
}

/// The first `text` in a field, or its line `line` (1 is the first), selected with no key: focus, then the selection. `.noValue`: not in it.
func axSelect(_ element: AXUIElement, _ text: String, line: Int?) -> AXError {
    let all = (axText(element, kAXValueAttribute) ?? "") as NSString
    var range = CFRange(location: kCFNotFound, length: 0)
    if let line, line > 0 {
        var found: CFTypeRef?
        if AXUIElementCopyParameterizedAttributeValue(element, kAXRangeForLineParameterizedAttribute as CFString, NSNumber(value: line - 1), &found) == .success, let found, CFGetTypeID(found) == AXValueGetTypeID() { AXValueGetValue(found as! AXValue, .cfRange, &range) }
        // The line's own newline stays out of what is copied.
        if range.location != kCFNotFound, range.length > 0, range.location + range.length <= all.length, all.character(at: range.location + range.length - 1) == 10 { range.length -= 1 }
    } else if !text.isEmpty {
        let found = all.range(of: text)
        if found.location != NSNotFound { range = CFRange(location: found.location, length: found.length) }
    }
    guard range.location != kCFNotFound, let selection = AXValueCreate(.cfRange, &range) else { return .noValue }
    // A field that does not take the keyboard: the cmd+c after would copy from somewhere else.
    let focus = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard focus == .success, axValue(element, kAXFocusedAttribute) as? Bool == true else { return focus == .success || focus == .noValue ? .failure : focus }
    return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, selection)
}

/// "text field" → "AXTextField": the role a person names, as the API names it.
private func axRole(_ words: String) -> String {
    words.hasPrefix("AX") ? words : "AX" + words.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
}

/// Chromium, Electron, Gecko, Flutter and Arc apps (Spotify, Slack, VS Code, Zen) build their accessibility tree only when asked. S4: only
/// those apps (`lookLazy`); a native app never needs it, and AXEnhancedUserInterface makes its windows animate.
/// nil: not such an app. true: it took AXManualAccessibility (Electron), or the switch was already on (L2): a short wait. false: it got
/// AXEnhancedUserInterface, which Google Chrome answers with an error and still obeys, its page in the tree 1.5 to 2 s later.
@discardableResult
func axWake(_ pid: pid_t) -> Bool? {
    guard axLazy(pid) else { return nil }
    let root = AXUIElementCreateApplication(pid)
    if axValue(root, "AXEnhancedUserInterface") as? Bool == true { return true }
    if AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success { return true }
    AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    return false
}

/// The app builds its tree only when asked: its bundle says so (`lookLazy`).
func axLazy(_ pid: pid_t) -> Bool {
    guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL?.appendingPathComponent("Contents") else { return false }
    let list = { (dir: String) in (try? FileManager.default.contentsOfDirectory(atPath: url.appendingPathComponent(dir).path)) ?? [] }
    return lookLazy(list("Frameworks"), list("MacOS"))
}

/// A protected app, a secure field, a sign-in window: never looked at, never acted on.
func screenRefusal(_ element: AXUIElement) -> String? {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? ""
    if ["com.apple.systempreferences", "com.apple.Passwords", "com.apple.keychainaccess", "com.apple.SecurityAgent"].contains(bundle) { return "protected-app" }
    if axText(element, kAXSubroleAttribute) == kAXSecureTextFieldSubrole as String { return "secure-field" }
    let window = axText(element, kAXRoleAttribute) == kAXWindowRole as String ? element : axElement(axValue(element, kAXWindowAttribute))
    let title = window.flatMap { axText($0, kAXTitleAttribute) }?.lowercased() ?? ""
    if title.range(of: #"sign in|log in|login|password|wachtwoord|inloggen"#, options: .regularExpression) != nil { return "sign-in" }
    return nil
}

/// Doc 32 item 3: the app's live process (`lookLivePid`). NSWorkspace's list and its frontmost app are a cache: in run 258 they
/// held a TextEdit that had quit while the TextEdit just started showed the window. LaunchServices and the window server are asked afresh.
func liveApp(_ app: NSRunningApplication) -> NSRunningApplication {
    let pid = app.processIdentifier
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var owners: [pid_t] = []
    for w in list where w[kCGWindowLayer as String] as? Int == 0 {
        if let owner = w[kCGWindowOwnerPID as String] as? pid_t, !owners.contains(owner) { owners.append(owner) }
    }
    let known = !app.isTerminated && NSRunningApplication(processIdentifier: pid) != nil
    if known, owners.contains(pid) { return app }
    let windows = owners.map { (pid: $0, bundle: $0 == pid ? app.bundleIdentifier : NSRunningApplication(processIdentifier: $0)?.bundleIdentifier) }
    let live = lookLivePid(pid, known: known, bundle: app.bundleIdentifier, windows: windows)
    return live == pid ? app : NSRunningApplication(processIdentifier: live) ?? app
}

/// One named thing: an app, and a role, a label or a line of text in it.
struct ScreenTarget {
    let app: String
    let window: String?
    let role: String?
    let label: String?
    let text: String?

    init?(_ json: Any?) {
        guard let t = json as? [String: Any], let app = t["app"] as? String, !app.isEmpty else { return nil }
        self.app = app
        window = t["window"] as? String
        role = t["role"] as? String
        label = t["label"] as? String
        text = t["text"] as? String
    }

    /// An app alone can be opened; finding a thing in it takes a role, a label or a text.
    var named: Bool { role != nil || label != nil || text != nil }

    var json: [String: Any] { ["app": app, "window": window as Any, "role": role as Any, "label": label as Any, "text": text as Any].compactMapValues { $0 is NSNull ? nil : $0 } }

    var running: NSRunningApplication? {
        let name = app.lowercased()
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        return (apps.first { $0.localizedName?.lowercased() == name } ?? apps.first { $0.localizedName?.lowercased().contains(name) == true }).map(liveApp)
    }

    /// The app's bundle: the running one, else the first by that name in an Applications folder.
    var appURL: URL? {
        if let url = running?.bundleURL { return url }
        let name = app.lowercased()
        let folders = ["/Applications", "/System/Applications", "/System/Applications/Utilities", NSHomeDirectory() + "/Applications"]
        let bundles = folders.flatMap { dir in ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".app") }.map { URL(fileURLWithPath: dir).appendingPathComponent($0) } }
        let stem = { (url: URL) in url.deletingPathExtension().lastPathComponent.lowercased() }
        return bundles.first { stem($0) == name } ?? bundles.first { stem($0).contains(name) }
    }

    /// Open the app or bring it to the front, then look until the thing shows (about 6 s for a cold start).
    func reach(_ done: @escaping ((element: AXUIElement, how: String)?) -> Void) {
        if running?.isActive == true, let found = find() { return done(found) }
        guard AXIsProcessTrusted(), appURL != nil else { return done(nil) }
        wake()
        let tries = running == nil ? 12 : 4
        func look(_ left: Int) {
            if let found = find() { return done(found) }
            if left <= 1 { return done(nil) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { look(left - 1) }
        }
        open { _ in look(tries) }
    }

    func wake() {
        if let app = running { axWake(app.processIdentifier) }
    }

    /// Open the app, or bring it to the front.
    func open(_ done: @escaping (Bool) -> Void) {
        guard let url = appURL else { return done(false) }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { app, _ in DispatchQueue.main.async { done(app != nil) } }
    }

    /// The first element that matches, and how it was found: `ax` (named by the app) or `text` (a line of text).
    func find() -> (element: AXUIElement, how: String)? {
        guard named, AXIsProcessTrusted(), let app = running else { return nil }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.3)
        // "View > Sort By > Size": from the menu bar down by exact titles, no menu opened on the way (runs 42, 50, 57).
        let path = (label ?? "").components(separatedBy: " > ").map(lookTitle)
        // A walk that meets a hung app stops in about 2 s, not one timeout per element.
        let deadline = Date().addingTimeInterval(2)
        let short = { (element: AXUIElement) -> AXUIElement in AXUIElementSetMessagingTimeout(element, 0.3); return element }
        if path.count > 1, !path.contains(""), flatRole(role.map(axRole)) == "axmenuitem" {
            var items = axList(axElement(axValue(root, kAXMenuBarAttribute)).flatMap { axValue(short($0), kAXChildrenAttribute) })
            var hit: AXUIElement?
            for title in path {
                hit = items.first { Date() < deadline && lookTitle(axText(short($0), kAXTitleAttribute)) == title }
                guard let at = hit else { return nil }
                // A bar item or an item holds its menu; the menu holds the next items.
                items = axList(axValue(at, kAXChildrenAttribute)).flatMap { axList(axValue(short($0), kAXChildrenAttribute)) }
            }
            return hit.map { ($0, "ax") }
        }
        let windows = (axValue(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        let window = window.flatMap { w in windows.first { axText($0, kAXTitleAttribute)?.lowercased().contains(w.lowercased()) == true } }
            ?? (axValue(root, kAXFocusedWindowAttribute)).map { $0 as! AXUIElement } ?? windows.first
        // A thing counts only where the owner can see it: inside the window, or in the menu bar.
        // Chromium apps keep hidden copies of controls (a list row's own Pause) at the screen's corner.
        let frame = window.flatMap(axFrame)
        var queue: [(element: AXUIElement, inWindow: Bool)] = [window.map { ($0, true) }, axValue(root, kAXMenuBarAttribute).map { ($0 as! AXUIElement, false) }].compactMap { $0 }
        let shows = { (element: AXUIElement, inWindow: Bool) -> Bool in
            guard let f = axFrame(element) else {
                // A closed menu's items are 0 x 0 yet pressable: only when a menu item is asked for.
                return !inWindow && flatRole(role.map(axRole)) == "axmenuitem"
            }
            return !inWindow || frame.map { $0.insetBy(dx: -2, dy: -2).contains(f.insetBy(dx: f.width / 2 - 0.5, dy: f.height / 2 - 0.5)) } ?? true
        }
        var loose: (element: AXUIElement, how: String)?
        // Items of a closed menu, kept until the window has had its say; two with the same name are answered with their paths.
        var menuHits: [AXUIElement] = []
        let wantRole = role.map(axRole).map { flatRole($0) == "axmenuitem" ? kAXMenuItemRole as String : $0 }
        let wantLabel = label?.lowercased()
        let wantText = text?.lowercased()
        // {role: "button", text: "Send"} names a control by its words, as a label does.
        let named = wantLabel ?? (wantRole == nil ? nil : wantText)
        var seen = 0
        while !queue.isEmpty, seen < 4000, Date() < deadline {
            let (element, inWindow) = queue.removeFirst()
            _ = short(element)
            seen += 1
            let elementRole = axText(element, kAXRoleAttribute) ?? ""
            let words = [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute, kAXPlaceholderValueAttribute].compactMap { axText(element, $0)?.lowercased() }
            // A search field is an AXTextField with subrole AXSearchField, a tab an AXRadioButton with subrole AXTabButton.
            let roleOK = wantRole.map { flatRole($0) == flatRole(elementRole) || flatRole($0) == flatRole(axText(element, kAXSubroleAttribute)) || flatRole(axText(element, kAXRoleDescriptionAttribute)) == flatRole(role) } ?? true
            // Its exact name first ("Pause"); a longer name that holds it ("Pause Liked Songs") only if nothing is exact.
            if roleOK, let named, words.contains(where: { $0.contains(named) }), shows(element, inWindow) {
                if words.contains(named), inWindow || axFrame(element) != nil { return (element, "ax") }
                if words.contains(named) { menuHits.append(element) }
                else { loose = loose ?? (element, "ax") }
            }
            if roleOK, named == nil, wantRole != nil, shows(element, inWindow) { return (element, "ax") }
            if let wantText, named != wantText, elementRole == kAXStaticTextRole as String || elementRole == kAXTextAreaRole as String, words.contains(where: { $0.contains(wantText) || ($0.count >= 6 && wantText.contains($0)) }), shows(element, inWindow) {
                if words.contains(wantText) { return (element, "text") }
                loose = loose ?? (element, "text")
            }
            queue.append(contentsOf: ((axValue(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []).map { ($0, inWindow) })
        }
        let paths = menuHits.map(menuPathOf).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if paths.count > 1 { return (menuHits[0], "ambiguous:" + paths.prefix(4).joined(separator: "\n")) }
        return menuHits.first.map { ($0, "ax") } ?? loose
    }
}

/// An item's path from the menu bar ("View > Sort By > Size"): its title and the titles of the items above it.
func menuPathOf(_ element: AXUIElement) -> String {
    var titles: [String] = []
    var at: AXUIElement? = element
    let until = Date().addingTimeInterval(1)
    for _ in 0..<10 where Date() < until {
        guard let now = at else { break }
        AXUIElementSetMessagingTimeout(now, 0.3)
        guard let role = axText(now, kAXRoleAttribute), role != kAXMenuBarRole as String else { break }
        if role == kAXMenuItemRole as String || role == kAXMenuBarItemRole as String { titles.insert(axText(now, kAXTitleAttribute) ?? "", at: 0) }
        at = axElement(axValue(now, kAXParentAttribute))
    }
    return titles.joined(separator: " > ")
}

final class Screen {
    private let channel = AppChannel()
    /// What is drawn now, by mark id: the mark as Node sent it, its element, its frame, and how it was found.
    /// `offset`: a line of text a look read has no element; it is a box from the corner of its window (the element).
    private var placed: [String: (mark: [String: Any], element: AXUIElement, frame: CGRect, how: String, offset: CGRect?)] = [:]
    private var order: [String] = []
    private var observers: [pid_t: AXObserver] = [:]
    private var judge = false
    private var guide: (taskKey: String, app: String)?
    private var monitors: [Any] = []
    private var activation: NSObjectProtocol?
    /// The exact value the last set-value replaced, for screen_undo, and the value it set. Never written down: the log keeps a redacted copy.
    private var replaced: (id: String, element: AXUIElement, value: String, set: String)?
    /// Marks whose app is opening, and the ids the fold wants now: a late find for a dropped mark is let go.
    private var reaching: Set<String> = []
    private var wanted: Set<String> = []

    // MARK: Marks (step 6) and the guide (step 7)

    /// The whole set of marks, as the fold holds it. A mark that cannot be found clears itself and says so.
    func marks(_ list: [[String: Any]], judge: Bool) {
        let ids = Set(list.compactMap { $0["id"] as? String })
        for id in order where !ids.contains(id) { forget(id) }
        order = order.filter { ids.contains($0) }
        self.judge = judge
        wanted = ids
        for mark in list {
            guard let id = mark["id"] as? String, placed[id] == nil, !reaching.contains(id) else { continue }
            let by = mark["target"] as? [String: Any]
            let target = ScreenTarget(by)
            reaching.insert(id)
            let found = { [weak self] (hit: Looks.Hit?) in
                guard let self else { return }
                self.reaching.remove(id)
                guard self.wanted.contains(id), self.placed[id] == nil else { return }
                guard let hit else {
                    return self.channel.emit("screen:mark-cleared", ["id": id, "reason": AXIsProcessTrusted() ? "not-found" : "no-access"])
                }
                let how = hit.text ? "text" : "ax"
                self.placed[id] = (mark, hit.element, hit.frame, how, hit.offset)
                self.placedAt[id] = Date()
                self.watchAway()
                self.order.append(id)
                self.follow(hit.element, pid: hit.app.processIdentifier)
                self.channel.emit("screen:mark-placed", ["id": id, "how": how, "frame": [hit.frame.minX, hit.frame.minY, hit.frame.width, hit.frame.height].map { Int($0) }])
                self.redraw()
            }
            if let look = by?["look"] as? String, let ref = by?["ref"] as? String {
                // Doc 16, B5: the exact thing a look found. A ref gone stale is not found.
                looks.resolve(look, ref) { hit in
                    guard let hit else { return found(nil) }
                    looks.front(hit.app) { found(hit) }
                }
            } else if let target {
                target.reach { hit in
                    found(hit.flatMap { hit in axFrame(hit.element).flatMap { frame in target.running.map { ($0, hit.element, frame, nil, hit.how == "text") } } })
                }
            } else {
                found(nil)
            }
        }
        guideWatch(list.first { $0["guide"] is String })
        redraw()
    }

    private func forget(_ id: String) {
        placed[id] = nil
    }

    private func redraw() {
        let drawn: [[String: Any]] = order.compactMap { id in
            guard let p = placed[id] else { return nil }
            // Doubles, not CGFloat: the panel reads `as? Double`, and a CGFloat in an Any read that way is nil (every mark drew at 0,0).
            var mark: [String: Any] = ["id": id, "x": Double(p.frame.minX), "y": Double(p.frame.minY), "w": Double(p.frame.width), "h": Double(p.frame.height), "shape": p.mark["shape"] as? String ?? "ring", "dashed": p.how == "text"]
            if let label = p.mark["label"] as? String { mark["label"] = label }
            if let step = p.mark["step"] as? Int { mark["step"] = step }
            if let of = p.mark["of"] as? Int { mark["of"] = of }
            return mark
        }
        drawMarks(drawn, judge)
    }

    /// Moved, resized or gone: the mark moves with the thing, or goes with it.
    private func follow(_ element: AXUIElement, pid: pid_t?) {
        guard let pid, let observer = observer(pid) else { return }
        for name in [kAXMovedNotification, kAXResizedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification] {
            AXObserverAddNotification(observer, element, name as CFString, nil)
        }
    }

    /// The app's one observer, made once. Every notification stamps the app's time for the look after an act;
    /// an app-wide one (refcon set, from `listen`) does nothing else.
    private func observer(_ pid: pid_t) -> AXObserver? {
        let born = NSRunningApplication(processIdentifier: pid)?.launchDate
        if let observer = observers[pid] {
            if launched[pid] == born { return observer }
            // The app quit and its pid was reused: the old observer hears nothing.
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
            observers[pid] = nil
            axStamps.forget(pid)
        }
        launched[pid] = born
        var observer: AXObserver?
        guard AXObserverCreate(pid, { _, element, notification, refcon in
            var pid: pid_t = 0
            AXUIElementGetPid(element, &pid)
            axStamps.stamp(pid)
            guard refcon == nil else { return }
            let name = notification as String
            DispatchQueue.main.async {
                if name == kAXFocusedWindowChangedNotification as String { return screen.moved(to: nil, pid: element) }
                screen.changed(element, gone: name == kAXUIElementDestroyedNotification as String, value: name == kAXValueChangedNotification as String)
            }
        }, &observer) == .success, let observer else { return nil }
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        observers[pid] = observer
        AXObserverAddNotification(observer, AXUIElementCreateApplication(pid), kAXFocusedWindowChangedNotification as CFString, nil)
        return observer
    }

    /// The whole app heard from before an act, so the look after it waits for the app to go quiet, not a fixed time.
    private func listen(_ pid: pid_t) {
        guard let observer = observer(pid), axStamps.last(pid) == nil else { return }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        let names = [kAXCreatedNotification, kAXUIElementDestroyedNotification, kAXValueChangedNotification, kAXLayoutChangedNotification, kAXFocusedUIElementChangedNotification,
                     kAXSelectedChildrenChangedNotification, kAXSelectedRowsChangedNotification, kAXTitleChangedNotification, kAXWindowCreatedNotification, kAXMenuOpenedNotification, kAXMenuClosedNotification]
        let heard = names.filter { AXObserverAddNotification(observer, app, $0 as CFString, UnsafeMutableRawPointer(bitPattern: 1)) == .success }
        if !heard.isEmpty { axStamps.listen(pid) }
    }

    // A mark points at what is in front of the owner. Another app, another window in the same app, or a click
    // on the marked thing itself (it did its job) takes it away. A guide's rings move on by their own rules.
    private var placedAt: [String: Date] = [:]
    /// Each observed pid's launch date, so a reused pid gets a fresh observer.
    private var launched: [pid_t: Date?] = [:]
    private var watchers: [Any] = []

    private func watchAway() {
        guard watchers.isEmpty else { return }
        watchers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
            self?.moved(to: app.processIdentifier, pid: nil)
        })
        if let click = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp, handler: { [weak self] _ in
            guard let self else { return }
            let main = primaryHeight()
            let point = CGPoint(x: NSEvent.mouseLocation.x, y: main - NSEvent.mouseLocation.y)
            let hit = self.placed.filter { $0.value.mark["guide"] == nil && $0.value.frame.insetBy(dx: -4, dy: -4).contains(point) }.map(\.key)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.drop(hit, "done") }
        }) { watchers.append(click) }
    }

    /// The owner went to another app (`to`), or another window of the app that owns `pid`: its marks go.
    fileprivate func moved(to front: pid_t?, pid window: AXUIElement?) {
        var windowPid: pid_t = 0
        if let window { AXUIElementGetPid(window, &windowPid) }
        let settled = Date().addingTimeInterval(-1.5)
        let away = placed.filter { id, p in
            guard p.mark["guide"] == nil, !id.hasPrefix("act:"), (placedAt[id] ?? .distantPast) < settled else { return false }
            var pid: pid_t = 0
            AXUIElementGetPid(p.element, &pid)
            return front.map { pid != $0 } ?? (pid == windowPid)
        }.map(\.key)
        drop(away, "away")
    }

    private func drop(_ ids: [String], _ reason: String) {
        let gone = ids.filter { placed[$0] != nil }
        guard !gone.isEmpty else { return }
        for id in gone {
            placed[id] = nil
            placedAt[id] = nil
            channel.emit("screen:mark-cleared", ["id": id, "reason": reason])
        }
        order.removeAll { gone.contains($0) }
        redraw()
    }

    fileprivate func changed(_ element: AXUIElement, gone: Bool, value: Bool) {
        // More than one: the lines of text a look read all hang on their window.
        let hits = placed.filter { CFEqual($0.value.element, element) }
        guard !hits.isEmpty else { return }
        for (id, p) in hits {
            if value, let taskKey = p.mark["guide"] as? String { stepDone(taskKey); continue }
            if gone {
                placed[id] = nil
                order.removeAll { $0 == id }
                channel.emit("screen:mark-cleared", ["id": id, "reason": "gone"])
            } else if let frame = axFrame(element) {
                placed[id] = (p.mark, p.element, p.offset?.offsetBy(dx: frame.minX, dy: frame.minY) ?? frame, p.how, p.offset)
            }
        }
        redraw()
    }

    /// A guide's step is done when its thing changes value, or the owner clicks inside it. Esc or another app ends the guide.
    private func guideWatch(_ mark: [String: Any]?) {
        let taskKey = mark?["guide"] as? String
        guard taskKey != guide?.taskKey else { return }
        Esc.drop("guide")
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        let by = mark?["target"] as? [String: Any]
        guard let taskKey, let app = ScreenTarget(by)?.app ?? looks.app(of: by?["look"] as? String)?.localizedName else { guide = nil; return }
        guide = (taskKey, app)
        Esc.want("guide") { [weak self] in self?.endGuide("esc") }
        monitors = [NSEvent.addGlobalMonitorForEvents(matching: .leftMouseUp) { [weak self] event in self?.clicked(event) }].compactMap { $0 }
        activation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.localizedName ?? ""
            guard let self, let guide = self.guide, app != "Sundial", !app.lowercased().contains(guide.app.lowercased()) else { return }
            self.endGuide("away")
        }
    }

    private func clicked(_ event: NSEvent) {
        guard let guide else { return }
        let main = primaryHeight()
        let point = CGPoint(x: NSEvent.mouseLocation.x, y: main - NSEvent.mouseLocation.y)
        if placed.values.contains(where: { $0.mark["guide"] as? String == guide.taskKey && $0.frame.insetBy(dx: -4, dy: -4).contains(point) }) {
            // After the app has handled the click: the step's own change may follow, and the ring moves on either way.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.stepDone(guide.taskKey) }
        }
    }

    private func stepDone(_ taskKey: String) {
        guard guide?.taskKey == taskKey else { return }
        channel.emit("guide:step", ["taskKey": taskKey])
    }

    private func endGuide(_ reason: String) {
        guard let guide else { return }
        channel.emit("guide:ended", ["taskKey": guide.taskKey, "reason": reason])
        guideWatch(nil)
    }

    // MARK: Act (step 8)

    /// Ring the control, wait a beat for the owner's hand, then do the one step. Refused in code, never by prompt.
    /// The thing is named (`target`) or is a ref of a look (`look`, `ref`; doc 16, B3).
    func act(_ command: [String: Any]) {
        guard let id = command["id"] as? String, let action = command["action"] as? String else { return }
        let target = ScreenTarget(command["target"])
        let look = command["look"] as? String
        let ref = command["ref"] as? String
        let byRef = look != nil && action != "open"
        let tune = LookTune(command["tune"])
        // When the step began: the look after it waits for the app to go quiet from here.
        var began = Date()
        let answer = { (app: NSRunningApplication?) in { (outcome: String, more: [String: Any]) in
            var named: [String: Any] = look.map { ["look": $0, "ref": ref ?? "", "app": app?.localizedName ?? ""] } ?? target?.json ?? [:]
            // Menu words read off the screen ride in the target, beside its app, where the redaction pass knows them.
            if let names = more["names"] { named["screenText"] = names }
            self.channel.emit("screen:acted", more.filter { $0.key != "names" }.merging(["id": id, "outcome": outcome, "target": named]) { _, new in new })
            // The action's name and the reason, never its value: a refusal can be traced.
            if outcome == "refused" { log("screen: \(action.prefix(40)) refused, \(more["reason"] as? String ?? "no reason")") }
            // B4: a performed act is followed by a look at the same app (refused, with no text, for an app on the privacy list).
            if outcome == "performed", let app { looks.look(after: id, pid: app.processIdentifier, since: began, hidden: command["private"], tune) }
        } }
        if IsSecureEventInputEnabled() { return answer(nil)("refused", ["reason": "secure-input"]) }
        // Run 119 T05: a menu read only lists; the answer is a "submenu" refusal with up to 61 names (Node shows 60 and says when cut).
        if action == "list-menu" {
            let path = (target?.label ?? "").components(separatedBy: " > ").map(lookTitle)
            guard let app = target?.running, !path.contains(""), AXIsProcessTrusted() else { return answer(nil)("refused", ["reason": "not-found"]) }
            if lookPrivate(app.localizedName, app.bundleIdentifier, command["private"]) { return answer(nil)("refused", ["reason": "private-app"]) }
            return looks.queue.async {
                let names = menuList(app.processIdentifier, path, max: 61)
                DispatchQueue.main.async { answer(nil)("refused", names.map { ["reason": "submenu", "names": $0] } ?? ["reason": "not-found"]) }
            }
        }
        guard overlayConfig.enabled else { return answer(nil)("refused", ["reason": "no-panel"]) }
        if action == "undo" {
            guard let last = replaced, last.id == command["of"] as? String else { return answer(nil)("refused", ["reason": "nothing-to-undo"]) }
            replaced = nil
            // Asked off the main thread: an app that hangs must not hang Sundial.
            return looks.queue.async {
                AXUIElementSetMessagingTimeout(last.element, 1.5)
                var pid: pid_t = 0
                AXUIElementGetPid(last.element, &pid)
                let same = axText(last.element, kAXValueAttribute) ?? "" == last.set
                let error = same ? AXUIElementSetAttributeValue(last.element, kAXValueAttribute as CFString, last.value as CFString) : .failure
                DispatchQueue.main.async {
                    if !same || error != .success {
                        if self.replaced == nil { self.replaced = last }
                        return answer(nil)("refused", ["reason": same ? "ax-\(error.rawValue)" : "changed-since"])
                    }
                    answer(NSRunningApplication(processIdentifier: pid))("performed", [:])
                }
            }
        }
        let show = { (hit: Looks.Hit?, missing: String) in
            guard let hit else { return answer(nil)("refused", ["reason": AXIsProcessTrusted() ? missing : "no-access"]) }
            let answer = answer(hit.app)
            self.listen(hit.app.processIdentifier)
            // A click, a key and the wheel land on the app in front.
            looks.front(hit.app) {
                self.ring(id, command, hit, began, answer) {
                    // Never the thing from before the wait: it is read again, and a thing that went is not acted on.
                    // A ref goes through its look again: another look may have taken its place, a list may have recycled the row.
                    let again = { (done: @escaping (Looks.Hit?) -> Void) in byRef ? looks.resolve(look, ref, ttl: tune.textTtl, front: true, done) : looks.fresh(hit, done) }
                    again { now in
                        guard let now else { return answer("refused", ["reason": "look again"]) }
                        began = Date()
                        self.step(id, action, command, now, target?.named == true || ref != nil, answer)
                    }
                }
            }
        }
        let reach = { () -> Void in
            if byRef {
                // An app on the owner's privacy list has no look to act on.
                if let app = looks.app(of: look), lookPrivate(app.localizedName, app.bundleIdentifier, command["private"]) { return answer(nil)("refused", ["reason": "private-app"]) }
                return looks.resolve(look, ref, ttl: tune.textTtl, front: true) { show($0, "look again") }
            }
            guard let target else { return answer(nil)("refused", ["reason": "not-found"]) }
            if action == "open" { return target.open { ok in ok ? answer(target.running)("performed", [:]) : answer(nil)("refused", ["reason": "no-such-app"]) } }
            // An app alone takes a key, typing and the wheel on its front window.
            if !target.named, ["key", "type", "scroll"].contains(action) {
                return target.open { _ in DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { looks.window(target.running) { show($0, "not-found") } } }
            }
            target.reach { found in
                // Two menu items by that name: their paths, so the next pick-menu names one.
                if let how = found?.how, how.hasPrefix("ambiguous:") { return answer(nil)("refused", ["reason": "ambiguous", "names": how.dropFirst(10).components(separatedBy: "\n")]) }
                // The quick search missed: the look's own walk, which also names a thing by its children's words.
                if found == nil, target.named, AXIsProcessTrusted(), let app = target.running { return looks.named(app, target) { show($0, "not-found") } }
                show(found.flatMap { found in shownFrame(found.element).flatMap { frame in target.running.map { ($0, found.element, frame, nil, false) } } }, "not-found")
            }
        }
        // Probed on the look queue, never the main thread: a hung app is a quick no.
        let rest = { () -> Void in
            guard action != "open", let app = byRef ? looks.app(of: look) : target?.running else { return reach() }
            looks.queue.async {
                let ok = axResponds(app.processIdentifier)
                DispatchQueue.main.async { ok ? reach() : answer(nil)("refused", ["reason": "not-responding"]) }
            }
        }
        // A window asked for by name comes in front first; no such window is a no, never the front one instead.
        let part = (command["window"] as? String ?? target?.window).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        guard part != nil || action == "raise" else { return rest() }
        guard let part, let app = byRef ? looks.app(of: look) : target?.running else { return answer(nil)("refused", ["reason": "no-such-window"]) }
        looks.raise(app, part) { reason, _ in
            if let reason { return answer(nil)("refused", ["reason": reason]) }
            action == "raise" ? looks.front(app) { answer(app)("performed", [:]) } : rest()
        }
    }

    /// Every refusal, then `perform` at once. With `tune.ring` seconds: show the ring that long first, then every refusal again.
    private func ring(_ id: String, _ command: [String: Any], _ hit: Looks.Hit, _ asked: Date, _ answer: @escaping (String, [String: Any]) -> Void, _ perform: @escaping () -> Void) {
        let presses = !hit.text && ["press", "AXPress", "pick", "pick-menu"].contains(command["action"] as? String ?? "")
        // Asked off the main thread: an app that hangs must not hang Sundial.
        let refusal = { (then: @escaping ([String: Any]?) -> Void) in
            looks.queue.async {
                // Runs 42, 50, 57: an AXPress on "Sort By", a submenu parent, froze Finder; its items are read, never opened.
                let items = presses ? submenuItems(hit.element) : nil
                let more: [String: Any]? = screenRefusal(hit.element).map { ["reason": $0] } ?? items.map { ["reason": "submenu", "names": $0] }
                DispatchQueue.main.async { then(more) }
            }
        }
        // A key or a click within `within` s, Esc and hotkeys included (a monitor misses those): the owner moved.
        let since = { (type: CGEventType) in CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: type) }
        let moved = { (within: Double) in min(since(.keyDown), since(.leftMouseDown), since(.rightMouseDown)) < within ? "owner-moved" : IsSecureEventInputEnabled() ? "secure-input" : nil }
        let wait = LookTune(command["tune"]).ring
        refusal { more in
            // No wait: only a key or a click since the act was asked, so the owner's own approval does not count.
            if let more = more ?? (wait > 0 ? nil : moved(Date().timeIntervalSince(asked)).map { ["reason": $0] }) { return answer("refused", more) }
            guard wait > 0 else { return perform() }
            self.placed["act:\(id)"] = (["shape": "ring", "label": (command["because"] as? String).map { String($0.prefix(40)) } as Any], hit.element, hit.frame, hit.text ? "text" : "ax", hit.offset)
            self.order.append("act:\(id)")
            self.redraw()
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                self.placed["act:\(id)"] = nil
                self.order.removeAll { $0 == "act:\(id)" }
                self.redraw()
                if let reason = moved(0.75) { return answer("refused", ["reason": reason]) }
                if NSWorkspace.shared.frontmostApplication?.processIdentifier != front { return answer("refused", ["reason": "app-changed"]) }
                refusal { more in
                    if let more { return answer("refused", more) }
                    perform()
                }
            }
        }
    }

    /// The one step. `thing`: a thing was named, not only an app or a window; keys go into it.
    private func step(_ id: String, _ action: String, _ command: [String: Any], _ hit: Looks.Hit, _ thing: Bool, _ answer: @escaping (String, [String: Any]) -> Void) {
        let value = command["value"] as? String ?? ""
        let pid = hit.app.processIdentifier
        // 27 section 3 item 8: with no ref the hit is the look's window, and `at` is a point in it from its top left.
        let at = command["ref"] == nil ? lookPoint(command["at"]) : nil
        let centre = at.map { CGPoint(x: hit.frame.minX + $0.x, y: hit.frame.minY + $0.y) } ?? CGPoint(x: hit.frame.midX, y: hit.frame.midY)
        if at != nil, !hit.frame.contains(centre) { return answer("refused", ["reason": "outside-window"]) }
        let into = thing && !hit.text ? hit.element : nil
        let done = { (reason: String) in { (ok: Bool) in ok ? answer("performed", [:]) : answer("refused", ["reason": reason]) } }
        // A password field has the keyboard, or what has it cannot be read: nothing was sent.
        let strict = LookTune(command["tune"]).focusStrict
        let sent = { (reason: String?) in
            if let reason { answer("refused", ["reason": reason]) } else { answer("performed", [:]) }
        }
        switch action {
        case "click":
            let held = command["modifiers"]
            let names = held == nil || held is NSNull ? [] : held as? [String] ?? (held as? String)?.split(separator: "+").map(String.init)
            let button = command["button"] as? String ?? "left"
            // A button or a modifier off the list is not guessed at.
            guard let flags = names.flatMap(lookFlags), ["left", "right"].contains(button) else { return answer("refused", ["reason": "bad-click"]) }
            return looks.click(centre, pid, count: (command["count"] as? NSNumber)?.intValue ?? 1, right: button == "right", flags: flags, done("covered"))
        case "scroll": return looks.scroll(hit.frame, Int(value.trimmingCharacters(in: .whitespaces)) ?? 3, pid, done("covered"))
        // 27 section 3 item 2: from the ref (or the point) to `to`, a ref of the same look or a point in its window, read again now.
        case "drag":
            let look = command["look"] as? String
            let drop = { (to: CGPoint?) in
                guard let to else { return answer("refused", ["reason": "look again"]) }
                looks.drag(centre, to, pid, done("covered"))
            }
            if let ref = command["to"] as? String { return looks.resolve(look, ref, front: true) { drop($0.map { CGPoint(x: $0.frame.midX, y: $0.frame.midY) }) } }
            guard let point = lookPoint(command["to"]) else { return answer("refused", ["reason": "bad-drag"]) }
            return looks.resolve(look, nil, front: true) { window in
                guard let window else { return drop(nil) }
                let to = CGPoint(x: window.frame.minX + point.x, y: window.frame.minY + point.y)
                window.frame.contains(to) ? drop(to) : answer("refused", ["reason": "outside-window"])
            }
        case "type": return looks.type(value, into: into, pid, strict: strict, sent)
        case "key":
            guard let key = lookKey(value) else { return answer("refused", ["reason": "unknown-key"]) }
            // Quit and delete-for-good are never pressed for the owner, nor is Sundial's own window closed.
            let own = pid == ProcessInfo.processInfo.processIdentifier && key.flags.contains(.maskCommand) && key.code == 13
            if key.refused || own { return answer("refused", ["reason": "refused-key"]) }
            guard key.code == 53, key.flags.isEmpty else { return looks.key(key.code, key.flags, into: into, pid, strict: strict, sent) }
            // Runs 42, 50, 57: Finder kept its menu open through four Escapes. One still open after the key is cancelled once.
            return looks.key(key.code, key.flags, into: into, pid, strict: strict) { reason in
                guard reason == nil else { return sent(reason) }
                looks.queue.asyncAfter(deadline: .now() + 0.2) {
                    let root = AXUIElementCreateApplication(pid)
                    AXUIElementSetMessagingTimeout(root, 0.5)
                    let open = axList(axElement(axValue(root, kAXMenuBarAttribute)).flatMap { axValue($0, kAXChildrenAttribute) }).first { axValue($0, kAXSelectedAttribute) as? Bool == true }
                    if let menu = open.flatMap({ axList(axValue($0, kAXChildrenAttribute)).first }) { AXUIElementPerformAction(menu, kAXCancelAction as CFString) }
                    DispatchQueue.main.async { sent(nil) }
                }
            }
        default: break
        }
        // A line of text has no element: it takes a click, a key or the wheel, nothing else.
        if hit.text { return answer("refused", ["reason": "unknown-action"]) }
        looks.queue.async {
            // Longer than a read: a press that opens a sheet answers when the sheet is up.
            AXUIElementSetMessagingTimeout(hit.element, 1.5)
            let old = action == "set-value" ? axText(hit.element, kAXValueAttribute) ?? "" : nil
            let item = axText(hit.element, kAXRoleAttribute) == kAXMenuItemRole as String
            var error: AXError
            var slow = false, unconfirmed = false
            switch action {
            case "focus": error = AXUIElementSetAttributeValue(hit.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            case "set-value": error = AXUIElementSetAttributeValue(hit.element, kAXValueAttribute as CFString, value as CFString)
            // Runs 43, 57, 61: copying one line by caret keys took 17 to 22 steps.
            case "select": error = axSelect(hit.element, value, line: (command["line"] as? NSNumber)?.intValue)
            default:
                // The element's own action names pass as they are; "press" and "show-menu" are AXPress and AXShowMenu.
                let name = action == "pick-menu" ? kAXPressAction as String : axActions(hit.element).contains(action) ? action : axRole(action.replacingOccurrences(of: "-", with: " "))
                let root = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(root, 0.5)
                let front = { () -> (window: AXUIElement?, title: String?) in let w = axElement(axValue(root, kAXFocusedWindowAttribute)); return (w, w.flatMap { axText($0, kAXTitleAttribute) }) }
                let before = front()
                let result = AXUIElementPerformAction(hit.element, name as CFString)
                // ponytail: a press that opens a menu or a sheet answers late and reads as "cannot complete"; it counts as done, and the look that follows shows what happened.
                // On an app that then stays silent the press may still have happened: done, said slow, and the look after shows it.
                slow = result == .cannotComplete && !axResponds(pid)
                error = result == .cannotComplete ? .success : result
                // Doc 32 item 2 (run 261 T19): -25205 on a Save that closed its panel. Read for a second whether the thing went or the
                // front window changed (`axUnknownDone`); then it is done and says so, else the no stands.
                for _ in 0..<10 where error == .attributeUnsupported {
                    Thread.sleep(forTimeInterval: 0.1)
                    var role: CFTypeRef?
                    let gone = AXUIElementCopyAttributeValue(hit.element, kAXRoleAttribute as CFString, &role) == .invalidUIElement
                    let now = front()
                    let moved = now.window.map { w in before.window.map { !CFEqual($0, w) } ?? true } ?? (before.window != nil) || now.title != before.title
                    if axUnknownDone(error, gone: gone, moved: moved) { error = .success; unconfirmed = true }
                }
            }
            // A menu item that quits its app (Quit, Close Window of its last window) takes the element with it: the app gone is the step done.
            if item, error != .success {
                for _ in 0..<15 where kill(pid, 0) == 0 { Thread.sleep(forTimeInterval: 0.1) }
                if kill(pid, 0) != 0 { error = .success }
            }
            DispatchQueue.main.async {
                guard error == .success else {
                    return answer("refused", ["reason": error == .invalidUIElement ? "look again" : error == .actionUnsupported ? "unknown-action" : error == .noValue ? "not-in-text" : error == .cannotComplete ? "not-responding" : "ax-\(error.rawValue)"])
                }
                var more: [String: Any] = slow ? ["reason": "slow"] : unconfirmed ? ["reason": "unconfirmed"] : [:]
                if let old {
                    // Text Gnomon set itself, unchanged since on the same element, is not the owner's (`own`): the owner's from before
                    // stays the value screen_undo puts back. Only how much goes to the log; the value itself stays here.
                    let own = self.replaced.map { CFEqual($0.element, hit.element) && $0.set == old } == true
                    self.replaced = (id, hit.element, own ? self.replaced!.value : old, value)
                    more["replacedChars"] = self.replaced!.value.count
                    if own { more["own"] = true }
                }
                answer("performed", more)
            }
        }
    }
}

let screen = Screen()

/// Hold to talk, recorded here (2026-11-13): the page's getUserMedia took about a second to open, and every
/// dictation lost its first words. The engine starts on key-down; a tap or a quiet room gives nothing back.
final class HoldEars {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var samples: [Float] = []
    private var rate: Double = 48_000

    func start() {
        guard !engine.isRunning else { return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else { return }
        rate = format.sampleRate
        lock.lock(); samples = []; lock.unlock()
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let channel = buffer.floatChannelData?[0] else { return }
            let frame = UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength))
            self.lock.lock(); self.samples.append(contentsOf: frame); self.lock.unlock()
        }
        do { try engine.start() } catch { input.removeTap(onBus: 0); log("hold to talk: the microphone did not start: \(error)") }
    }

    /// Stops, and returns a 16-bit mono WAV, or nil for a tap (under 0.4 s) or a quiet room.
    func stop() -> Data? {
        guard engine.isRunning else { return nil }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        lock.lock(); let s = samples; samples = []; lock.unlock()
        guard Double(s.count) >= rate * 0.4, sqrt(s.reduce(0) { $0 + $1 * $1 } / Float(s.count)) >= 0.003 else { return nil }
        var data = Data()
        func put<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
        let bytes = UInt32(s.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36) + bytes); data.append(contentsOf: Array("WAVEfmt ".utf8))
        put(UInt32(16)); put(UInt16(1)); put(UInt16(1)); put(UInt32(rate)); put(UInt32(rate) * 2); put(UInt16(2)); put(UInt16(16))
        data.append(contentsOf: Array("data".utf8)); put(bytes)
        for x in s { put(Int16(max(-1, min(1, x)) * 32767)) }
        return data
    }
}
let holdEars = HoldEars()
