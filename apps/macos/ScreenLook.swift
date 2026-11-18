// Look, then act (docs/release/16-look-then-act.md, part B): the eyes (one window as a list of things with refs)
// and the hands (click, type, key, scroll). Generic on purpose: no per-app code, no ranking, no wording.
//
// Self-check of the pure parts, no grant needed:
//   swiftc -swift-version 5 -D LOOK_SELFCHECK -parse-as-library apps/macos/ScreenLook.swift -o "$TMPDIR/look-check" && "$TMPDIR/look-check"

import AppKit
import Carbon.HIToolbox
import ScreenCaptureKit
import Vision

// MARK: - Pure parts

/// One line of at most `max` characters: white space folded.
func lookCut(_ text: String?, _ max: Int) -> String {
    String((text ?? "").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(max))
}

/// The first that says something, cut to 120.
func lookLabel(_ candidates: [String?]) -> String {
    for candidate in candidates {
        let cut = lookCut(candidate, 120)
        if !cut.isEmpty { return cut }
    }
    return ""
}

/// A Vision box (0...1, from the bottom left of the image) as screen points, given where the image sat on
/// screen (points from the top left of the main display). The pixel scale drops out.
func lookBox(_ box: CGRect, in crop: CGRect) -> CGRect {
    CGRect(x: crop.minX + box.minX * crop.width, y: crop.minY + (1 - box.maxY) * crop.height, width: box.width * crop.width, height: box.height * crop.height)
}

// Two displays: AX, CGWindowList and CGEvent points are top-left global points, AppKit frames bottom-left ones, and BOTH
// spaces are anchored at the primary display (NSScreen.screens[0], the menu-bar one), wherever another display sits.
// So the flip always uses the primary's height, never the height of the display the point is on; what must follow
// the point is the choice of display (the panel's frame, the stage's room, the map's size).

/// An AppKit frame (bottom left of the primary display) as top-left global points.
func lookTopLeft(_ frame: CGRect, primary height: CGFloat) -> CGRect {
    CGRect(x: frame.minX, y: height - frame.maxY, width: frame.width, height: frame.height)
}

/// Whether Gnomon's click at `point` is the app's to take. `windows` front to back, as CGWindowList gives them: the app's own
/// window first under the point is a yes; a normal window (layer 0) of another app over it is a no, as is no window of the app.
/// Sundial's own windows (`own`) are passed over: the slip lets Gnomon's events through (`slipHands`), and `sundialAt` keeps
/// every other window of Sundial's from a click.
func lookOwns(_ windows: [(owner: pid_t, layer: Int, rect: CGRect)], _ point: CGPoint, app: pid_t, own: pid_t) -> Bool {
    for window in windows where window.rect.contains(point) {
        if window.owner == app { return true }
        if window.layer == 0, window.owner != own { return false }
    }
    return false
}

/// Which of `screens` (AppKit frames, primary first) holds `point` (top-left global points); nil when none does.
func lookScreenIndex(_ point: CGPoint, _ screens: [CGRect]) -> Int? {
    guard let height = screens.first?.height else { return nil }
    return screens.firstIndex { lookTopLeft($0, primary: height).contains(point) }
}

/// "cmd+f" as a key code and its flags; nil for a key off the list. `refused`: never pressed for the owner.
func lookKey(_ text: String) -> (code: CGKeyCode, flags: CGEventFlags, refused: Bool)? {
    // "Cmd + Page Up", "arrow_up", "ArrowUp": one name a key, however it is spelled.
    let parts = text.lowercased().split(separator: "+").map { part -> String in
        let name = part.trimmingCharacters(in: .whitespaces)
        return name.count > 1 ? name.filter { !" -_".contains($0) } : name
    }
    guard let name = parts.last else { return nil }
    var named: [String: CGKeyCode] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "spacebar": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
                                      "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121]
    for (n, arrow) in ["left", "right", "down", "up"].enumerated() {
        for spelled in [arrow, "arrow" + arrow, arrow + "arrow"] { named[spelled] = CGKeyCode(123 + n) }
    }
    for (n, code) in [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111].enumerated() { named["f\(n + 1)"] = CGKeyCode(code) }
    // ponytail: letters and digits by their place on a US keyboard; another layout presses its own letter there.
    let places: [Character: CGKeyCode] = ["a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
                                          "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
                                          "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
                                          "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "`": 50]
    guard let code = named[name] ?? (name.count == 1 ? places[Character(name)] : nil), let flags = lookFlags(Array(parts.dropLast())) else { return nil }
    // Quit, log out, lock (cmd+q in any form) and delete-for-good (cmd+delete in any form).
    return (code, flags, flags.contains(.maskCommand) && (code == 12 || code == 51))
}

/// Modifier names as event flags; nil for a name off the list.
func lookFlags(_ names: [String]) -> CGEventFlags? {
    var flags: CGEventFlags = []
    for name in names {
        switch name.lowercased().trimmingCharacters(in: .whitespaces) {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: return nil
        }
    }
    return flags
}

/// The owner's privacy list holds this app: a fragment of its name or of its bundle id, in any case. An entry that starts
/// with "=" is a name a private app goes by in another language (PRIVATE_APP_NAMES, app-channel.ts): the app's whole name,
/// trimmed, any case, without ".app", as privateAppName matches it in Node ("Notities" is Notes; "Notes Plus" is not).
func lookPrivate(_ name: String?, _ bundle: String?, _ fragments: Any?) -> Bool {
    let app = [(name ?? "").lowercased(), (bundle ?? "").lowercased()]
    var whole = (name ?? "").trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "\u{2019}", with: "'")
    if whole.hasSuffix(".app") { whole.removeLast(4) }
    return (fragments as? [Any] ?? []).contains { fragment in
        let part = (fragment as? String ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if part.hasPrefix("=") { return part.count > 1 && whole == String(part.dropFirst()) }
        return !part.isEmpty && app.contains { $0.contains(part) }
    }
}

/// Plan 2B (doc 30 finding 3): keys go to the process that owns the thing with the keyboard. A Save or Open panel of a
/// sandboxed app is drawn by another process (the open-and-save panel service): keys posted to the app never reach it.
/// Never Sundial's own process (`own`): keys meant for another app never land in the slip.
func lookKeyTarget(app: pid_t, focused: pid_t?, own: pid_t = getpid()) -> pid_t {
    guard let focused, focused > 0, focused != own else { return app }
    return focused
}

/// A point in a window as [x, y] from its top left (a click at a point, a drag's end); nil when it is not two finite numbers.
func lookPoint(_ json: Any?) -> CGPoint? {
    guard let pair = json as? [Any], pair.count == 2, let x = (pair[0] as? NSNumber)?.doubleValue, let y = (pair[1] as? NSNumber)?.doubleValue,
          x.isFinite, y.isFinite else { return nil }
    return CGPoint(x: x, y: y)
}

/// A drag's pointer path after the press: a nudge to start it, even steps to the drop, and a rest over the drop target
/// so it can show it takes the drop. `steps` between 2 and 60.
func lookPath(_ from: CGPoint, _ to: CGPoint, steps: Int = 12) -> [CGPoint] {
    let n = max(2, min(60, steps))
    let along = (1 ... n).map { i in CGPoint(x: from.x + (to.x - from.x) * CGFloat(i) / CGFloat(n), y: from.y + (to.y - from.y) * CGFloat(i) / CGFloat(n)) }
    return [CGPoint(x: from.x + 2, y: from.y + 2)] + along + [to, to]
}

/// The app has gone quiet: it was heard after `since` (silence before it reacts is not done), at least 0.06 s have passed,
/// and nothing for `quiet` seconds.
func lookQuiet(last: Date?, since: Date, start: Date, now: Date, quiet: TimeInterval) -> Bool {
    guard let last, last >= since else { return false }
    return now.timeIntervalSince(start) >= 0.06 && now.timeIntervalSince(last) >= quiet
}

/// What Node may tune without a rebuild, each held to a range that cannot hang the app.
struct LookTune {
    var thin = 15, visited = 5000, cap = 90_000
    /// S4: the characters a look reads of its text areas, all of them together (0: a text area's value is cut to 200, as any value).
    var area = 4000
    var settle = 0.4, settleNew = 0.5, deadline = 1.5, textTtl = 30.0, ring = 0.0
    /// 27 section 3 item 7: how long the app's AX notifications stay quiet before the screen counts as settled.
    var quiet = 0.1
    /// S4: seconds a Chromium browser's first look waits after AXEnhancedUserInterface (Chrome builds its page in 1.5 to 2 s).
    var wake = 2.0
    var languages = ["en-US", "nl-NL"]
    var focusStrict = true

    init(_ json: Any?) {
        let tune = json as? [String: Any] ?? [:]
        let number = { (key: String, low: Double, high: Double, or: Double) -> Double in
            let value = (tune[key] as? NSNumber)?.doubleValue ?? or
            return value.isFinite ? min(max(value, low), high) : or
        }
        thin = Int(number("thin", 0, 400, 15))
        visited = Int(number("visited", 100, 20000, 5000))
        area = Int(number("area", 0, 20000, 4000))
        // Bytes; a small number is taken as KB.
        let bytes = number("cap", 1, 400_000, 90_000)
        cap = Int(max(10_000, bytes < 1000 ? bytes * 1000 : bytes))
        settle = number("settle", 0, 3, 0.4)
        settleNew = number("settleNew", 0, 3, 0.5)
        deadline = number("deadline", 0.2, 5, 1.5)
        textTtl = number("textTtl", 1, 600, 30)
        ring = number("ring", 0, 3, 0)
        quiet = number("quiet", 0.03, 1, 0.1)
        wake = number("wake", 0, 5, 2.0)
        focusStrict = tune["focusStrict"] as? Bool ?? true
        let asked = (tune["languages"] as? [Any] ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty && $0.count <= 20 }
        if !asked.isEmpty { languages = Array(asked.prefix(6)) }
    }
}

/// A ref still stands for what the look saw: the same role and words (a recycled row keeps its element and
/// takes other words); a line of text, which has no element to ask, for `ttl` seconds.
func lookHolds(_ was: (role: String, label: String), _ now: (role: String, label: String)?, text: Bool, age: TimeInterval, ttl: TimeInterval) -> Bool {
    text ? age <= ttl : now.map { $0 == was } ?? false
}

/// A thing is in front when its window, or the sheet it sits in (`own`), is the app's focused or main window (`front`).
/// Runs 255, 257: a field in a sheet names the sheet's parent as its AXWindow, while a sheet just opened is the app's
/// focused and main window itself; only a raise of the parent made it main again (run 256).
func lookInFront<E>(_ own: [E?], _ front: [E?], same: (E, E) -> Bool) -> Bool {
    own.contains { o in o.map { o in front.contains { f in f.map { same($0, o) } ?? false } } ?? false }
}

/// May keys go to the app? nil = yes: nothing has the keyboard, or a thing that is not a password field.
/// A read that failed is a no while `strict`: the thing may be a password field.
func lookKeyGate(focus: AXError, subrole: AXError, sub: String?, strict: Bool = true) -> String? {
    if focus == .noValue { return nil }
    let unknown = strict ? "focus-unknown" : nil
    guard focus == .success else { return unknown }
    if subrole == .success { return sub == kAXSecureTextFieldSubrole ? "secure-field" : nil }
    return subrole == .noValue || subrole == .attributeUnsupported ? nil : unknown
}

/// An app's windows for a look, front to back: at most 12, each title cut to 120.
func lookWindows(_ rows: [(title: String?, main: Bool, minimized: Bool)]) -> [[String: Any]] {
    rows.prefix(12).map { ["title": lookCut($0.title, 120), "main": $0.main, "minimized": $0.minimized] }
}

/// A menu title as a pick-menu path names it: any case, white space folded, a trailing "…" or "..." dropped.
func lookTitle(_ text: String?) -> String {
    var title = lookCut(text, 200).lowercased()
    if title.hasSuffix("…") { title.removeLast() } else if title.hasSuffix("...") { title.removeLast(3) }
    return title.trimmingCharacters(in: .whitespaces)
}

/// A menu item's key as its menu draws it ("⇧⌘G"), from AXMenuItemCmdChar and AXMenuItemCmdModifiers. nil: none, or a key with no letter.
func lookShortcut(_ char: String?, _ mods: Int?) -> String? {
    guard let char = char?.trimmingCharacters(in: .whitespaces), !char.isEmpty,
          char.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value != 127 && !(0xF700 ... 0xF8FF).contains($0.value) }) else { return nil }
    let m = mods ?? 0
    return (m & 4 != 0 ? "⌃" : "") + (m & 2 != 0 ? "⌥" : "") + (m & 1 != 0 ? "⇧" : "") + (m & 8 == 0 ? "⌘" : "") + char.uppercased()
}

/// The window a fragment of its title names: the exact title first, else the first that holds it. nil = none.
func lookWindowMatch(_ titles: [String?], _ part: String) -> Int? {
    let want = part.trimmingCharacters(in: .whitespaces).lowercased()
    let all = titles.map { ($0 ?? "").lowercased() }
    return want.isEmpty ? nil : all.firstIndex(of: want) ?? all.firstIndex { $0.contains(want) }
}

/// A part as the list shows it, or nil when it says nothing: a plain group (Chromium and Electron wrap everything in
/// one) with no label and no value whose actions are only the defaults. Such a group is never settable, and every part
/// loses the defaults Chromium hangs on nearly every node, unless they are all it has.
func lookPart(role: String, label: String, value: String, actions: [String], settable: Bool) -> (actions: [String], settable: Bool)? {
    let quiet: Set<String> = ["AXShowMenu", "AXScrollToVisible"]
    let mute = (role == kAXGroupRole || role == kAXUnknownRole) && label.isEmpty && value.isEmpty
    if mute, actions.allSatisfy({ quiet.contains($0) || $0 == kAXPressAction }) { return nil }
    let kept = actions.filter { !quiet.contains($0) }
    return (kept.isEmpty ? actions : kept, settable && !mute)
}

/// S5R1: what a group, an unknown or a web area says it is, so the gate can tell a web message box (a contenteditable) from a
/// wrapper: its role description ("text entry area", "group") and `editable` when the app says so. Other roles say it by role.
func lookEntry(role: String, roleDescription: String?, editable: Bool) -> [String: Any] {
    guard role == kAXGroupRole || role == kAXUnknownRole || role == "AXWebArea" else { return [:] }
    var out: [String: Any] = [:]
    let said = lookCut(roleDescription, 40)
    if !said.isEmpty { out["roleDescription"] = said }
    if editable { out["editable"] = true }
    return out
}

/// The words of a look's query that say something (two letters or more), lowercased.
func lookQuery(_ text: String?) -> [String] {
    (text ?? "").lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init).filter { $0.count >= 2 }.prefix(8).map { $0 }
}

/// How much a part answers the query: 0 is not wanted, and the rest are kept past the cut, best first.
///
/// A whole word scores two and a word inside another scores one. In run 11 the query "play" made every
/// "Play <playlist>" in the sidebar wanted, those filled the 60 places the walk kept, and the walk stopped
/// before it ever reached the album's own Play button. Now nothing stops the walk, and the best 60 are kept.
func lookScore(_ role: String, _ words: String, _ query: [String]) -> Int {
    if role == kAXMenuItemRole as String { return 1 }
    guard !query.isEmpty else { return 0 }
    // A query is often a list ("To Subject message body"): the long words carry it, the short ones only help.
    let strong = query.filter { $0.count >= 4 }
    let asked = strong.isEmpty ? query : strong
    let have = Set(words.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init))
    return asked.reduce(0) { $0 + (have.contains($1) ? 2 : words.contains($1) ? 1 : 0) }
}

/// How many parts past the cut a walk still reads: many for a query's words, few for the window's edges alone.
func lookOverrun(_ query: [String]) -> Int { query.isEmpty ? 300 : 1500 }

/// Run 198: the focused element the walk never met (Finder's rename box is no visible child of its list) is a part of the
/// looked window when its middle lies in the window's frame and it names no other window as its own (nil: it names none).
func lookFocusInside(_ box: CGRect, window frame: CGRect, sameWindow: Bool?) -> Bool {
    sameWindow != false && frame.insetBy(dx: -2, dy: -2).contains(CGPoint(x: box.midX, y: box.midY))
}

/// The parts a cut keeps, by place in the list, in the window's order: rank 0 (the window's edges) first, then 1, then 2 (list rows).
func lookKeep(_ ranks: [Int], _ max: Int) -> [Int] {
    guard ranks.count > max else { return Array(ranks.indices) }
    return ranks.indices.sorted { (ranks[$0], $0) < (ranks[$1], $1) }.prefix(Swift.max(0, max)).sorted()
}

/// Rig run205 T12: a caret's line as the look says it, the first being 1, from AX's own number (the first being 0). nil: none, or nonsense.
func lookLineNumber(_ zeroBased: Int?) -> Int? {
    zeroBased.flatMap { $0 >= 0 && $0 < 10_000_000 ? $0 + 1 : nil }
}

/// The frame to ring for the caret's line, from AXBoundsForRange of that line and the text area's frame: the area's width (an
/// empty line has none of its own), the line's height. nil when the line is scrolled out of the area or its bounds say nothing.
func lookCaretLine(_ line: CGRect, in box: CGRect) -> CGRect? {
    guard [line.minX, line.minY, line.width, line.height].allSatisfy({ $0.isFinite }), line.height > 0, line.height < 200 else { return nil }
    let band = CGRect(x: box.minX, y: line.minY, width: box.width, height: line.height)
    return box.contains(CGPoint(x: band.midX, y: band.midY)) ? band.intersection(box) : nil
}

/// S4: which characters of a text area a look reads, at most `max`. All of a small one; else the part that shows, its start when that
/// is longer unless the caret is in its last `max` characters (a terminal's prompt is its last line); else the end of the whole.
/// `midLine`: the range may start inside a line, which `lookText` then drops. nil: nothing to ask by range.
func lookTextSpan(total: Int?, visible: CFRange?, caret: Int? = nil, max: Int) -> (range: CFRange, midLine: Bool)? {
    guard max > 0 else { return nil }
    if let total, total >= 0, total <= max { return total == 0 ? nil : (CFRange(location: 0, length: total), false) }
    if let v = visible, v.location >= 0, v.length > 0 {
        let end = total.map { Swift.min(v.location + v.length, $0) } ?? v.location + v.length
        let length = Swift.min(end - v.location, max)
        guard length > 0 else { return nil }
        if length == end - v.location { return (CFRange(location: v.location, length: length), false) }
        if let caret, caret >= end - max, caret <= end { return (CFRange(location: end - length, length: length), true) }
        return (CFRange(location: v.location, length: length), false)
    }
    if let total, total > max { return (CFRange(location: total - max, length: max), true) }
    return nil
}

/// S4: a text area's words as a look keeps them: one line a line, its white space folded, blank lines gone, at most the last `max`
/// characters, starting at a line (a secret's name is never cut off its value): a partial first line goes, or with no line break
/// left, a partial first word. `midLine`: the text itself starts inside a line.
func lookText(_ text: String?, _ max: Int, midLine: Bool = false) -> String {
    var lines = (text ?? "").split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).map { $0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
    if midLine, !lines.isEmpty { lines.removeFirst() }
    let whole = lines.filter { !$0.isEmpty }.joined(separator: "\n")
    guard whole.count > max else { return whole }
    let kept = whole.suffix(Swift.max(0, max))
    if let cut = kept.firstIndex(of: "\n") { return String(kept[kept.index(after: cut)...]) }
    if let cut = kept.firstIndex(of: " ") { return String(kept[kept.index(after: cut)...]) }
    return ""
}

/// M4: characters left out of a text area's read, never only its spacing folded: the range began past the start or ended short
/// of `total`, or `lookText` kept less than the whole folded text (`kept`).
func lookTextCut(_ text: String, kept: String, range: CFRange? = nil, total: Int? = nil) -> Bool {
    range.map { $0.location > 0 || $0.length < total ?? Int.max } == true || kept != lookText(text, Int.max)
}

/// S5R1 (Fable H3): a text area read whole whose blank lines, indents or runs of spaces the look folded (its ends aside): no cut,
/// so the look is honest, but a set-value would lose the owner's spacing, so it is marked apart.
func lookTextFolded(_ text: String, kept: String) -> Bool {
    kept != text.trimmingCharacters(in: .whitespacesAndNewlines)
}

/// M4 and S5R1 (Fable H3): the marks a text area's read leaves on its part: read in part, its whole length (`cut`); read whole with its
/// spacing folded, `folded`; and its real length (`chars`, never the text) when the words as read are shorter. The walk and a focused part alike.
func lookReadMarks(_ read: (text: String, total: Int, cut: Bool, folded: Bool)?) -> [String: Any] {
    guard let read else { return [:] }
    if read.cut { return ["cut": read.total] }
    return (read.folded ? ["folded": true] : [:]).merging(read.total != read.text.utf16.count ? ["chars": read.total] : [:]) { _, new in new }
}

/// S5R1: Return in a one-line field presses its window's or sheet's default button; the look names it (its ref and words) beside its part's mark.
func lookDefaultButton(_ elements: [[String: Any]]) -> [String: Any]? {
    elements.first { $0["default"] as? Bool == true }.map { ["ref": $0["ref"] as? String ?? "", "label": $0["label"] as? String ?? ""] }
}

/// S4: a look is read as a picture too when its tree is thin, unless a text area already gave it its words (Terminal: ten parts, one of them the whole screen).
func lookThin(_ count: Int, areaChars: Int, _ thin: Int) -> Bool {
    count < thin && areaChars < 200
}

/// S4: an app that builds its accessibility tree only when asked, by its bundle: Electron, CEF (Spotify), a Chromium browser, Gecko
/// (Zen, Firefox: Contents/MacOS/XUL), Flutter, Arc. `frameworks`: Contents/Frameworks; `binaries`: Contents/MacOS.
func lookLazy(_ frameworks: [String], _ binaries: [String] = []) -> Bool {
    binaries.contains("XUL") || frameworks.contains { name in
        ["Electron Framework.framework", "Chromium Embedded Framework.framework", "FlutterMacOS.framework", "ArcCore.framework"].contains(name)
            || name.hasSuffix(" Framework.framework") && ["Chrome", "Chromium", "Brave", "Edge", "Vivaldi", "Opera"].contains { name.contains($0) }
    }
}

/// One app run's labels: a thing keeps its number across looks while it shows. `E` is an AXUIElement (a String in the self-check).
struct LookLabels<E> {
    var next = 0, looks = 0
    var all: [Int: (element: E, hash: Int, role: String, label: String, place: String, last: Int)] = [:]

    /// A number for each part of one look: the same element with the same role and words keeps its number; else the one
    /// entry not in this look with the same role, words and place takes it back (a menu shut and opened again); else a new one.
    /// `cut`: the look was cut, so a thing missing from it may still show; no number is taken back by place then.
    mutating func give(_ parts: [(element: E, hash: Int, role: String, label: String, place: String)], cut: Bool = false, same: (E, E) -> Bool) -> [Int] {
        looks += 1
        var byHash: [Int: [Int]] = [:], byKey: [String: [Int]] = [:]
        for (n, e) in all {
            byHash[e.hash, default: []].append(n)
            byKey[e.role + "\n" + e.label + "\n" + e.place, default: []].append(n)
        }
        var ids = [Int?](repeating: nil, count: parts.count)
        var taken = Set<Int>()
        for (i, p) in parts.enumerated() {
            guard let n = byHash[p.hash]?.sorted().first(where: { !taken.contains($0) && all[$0]!.role == p.role && all[$0]!.label == p.label && same(all[$0]!.element, p.element) }) else { continue }
            ids[i] = n
            taken.insert(n)
        }
        for (i, p) in parts.enumerated() where ids[i] == nil && !cut {
            let alike = (byKey[p.role + "\n" + p.label + "\n" + p.place] ?? []).filter { !taken.contains($0) }
            if alike.count == 1 { ids[i] = alike[0]; taken.insert(alike[0]) }
        }
        let given = parts.enumerated().map { i, p -> Int in
            let n = ids[i] ?? { next += 1; return next }()
            all[n] = (p.element, p.hash, p.role, p.label, p.place, looks)
            return n
        }
        // Not seen in 30 looks, or past 3000: forgotten, oldest first.
        all = all.filter { looks - $0.value.last < 30 }
        if all.count > 3000 { for n in all.sorted(by: { $0.value.last < $1.value.last }).prefix(all.count - 3000).map(\.key) { all[n] = nil } }
        return given
    }
}

/// Doc 32 item 1 (run 258 T18): a mouse-down that went through the slip while Gnomon's hands had it let the mouse through
/// (`slipHands`, from `start` to `end`, nil while it lasts). The point of the slip it was meant for, in the panel's own points
/// from its top left (`origin`: the panel's top left on screen), or nil. Gnomon's own press (posted, on its `target`) never is.
/// A hand presses wherever the pointer is, and for those 0.2 s the hands had moved it to the target: a hand's press then is read
/// where the owner's pointer was (`back`). A posted one (the rig's) is read where it says it is. `late`: for a moment after, the
/// slip may still let the mouse through (it takes it again only where the pointer was before the hands, until the next move), and
/// an event that went through as the hands let go reaches the monitor after them; the pointer is back by then.
func slipMissed(_ at: CGPoint, time: TimeInterval, hand: Bool, window: (start: TimeInterval, end: TimeInterval?, back: CGPoint?, target: CGPoint?)?,
                origin: CGPoint, regions: [CGRect], late: TimeInterval = 1) -> CGPoint? {
    guard let window, time >= window.start, time <= (window.end ?? .infinity) + late else { return nil }
    if !hand, let target = window.target, hypot(at.x - target.x, at.y - target.y) < 1 { return nil }
    guard let meant = hand && time <= (window.end ?? .infinity) ? window.back : at else { return nil }
    let local = CGPoint(x: meant.x - origin.x, y: meant.y - origin.y)
    return regions.contains { $0.contains(local) } ? local : nil
}

/// Doc 32 item 3 (run 258 T19): NSWorkspace still named a TextEdit that LaunchServices no longer knew (`known` false) as frontmost
/// and first by name, while the TextEdit the double-click had started showed notes.txt; 24 looks at the old one read no window.
/// The process to look at: this one while it is known and has a window on screen, else the first process of the same app that has
/// one (`windows`: the owners of the windows on screen, front first), else this one.
func lookLivePid(_ pid: pid_t, known: Bool, bundle: String?, windows: [(pid: pid_t, bundle: String?)]) -> pid_t {
    if known, windows.contains(where: { $0.pid == pid }) { return pid }
    guard let bundle, !bundle.isEmpty else { return pid }
    return windows.first { $0.pid != pid && $0.bundle == bundle }?.pid ?? pid
}

/// An app still starting has no window to give yet: it is looked at again for a moment. Not done launching, or started within 10 s.
func lookStarting(finished: Bool, launched: Date?, now: Date) -> Bool {
    !finished || launched.map { now.timeIntervalSince($0) < 10 } == true
}

/// Doc 32 item 2 (run 261 T19): AXPress on the Save panel's Save answered -25205 (kAXErrorAttributeUnsupported) while the panel
/// closed and the file was saved. That answer says nothing: the press is done when what it pressed is gone or the app's front window
/// changed (`gone`, `moved`, read after it). Every other error, and -25205 with nothing changed, stays a no.
func axUnknownDone(_ error: AXError, gone: Bool, moved: Bool) -> Bool {
    error == .attributeUnsupported && (gone || moved)
}

#if LOOK_SELFCHECK

@main enum LookCheck {
    static func main() {
        var failed = 0
        func check(_ ok: Bool, _ what: String) {
            if !ok { failed += 1; print("FAIL " + what) }
        }
        check(lookCut("  Lunch \n\t Thursday  ", 120) == "Lunch Thursday", "cut folds white space")
        check(lookCut(String(repeating: "a", count: 300), 40).count == 40, "cut cuts")
        check(lookCut(nil, 40) == "", "cut of nothing")
        check(lookCut("Mira 👩‍👩‍👧 Bakker", 6) == "Mira 👩‍👩‍👧", "cut keeps a whole emoji")
        check(lookLabel([nil, "", "  ", "New Message", "later"]) == "New Message", "label is the first that says something")
        check(lookLabel([nil, " "]) == "", "label of nothing")
        check(lookLabel([String(repeating: "b", count: 500)]).count == 120, "label is cut to 120")
        // A window on a second display left of the main one; a box in the upper half of the image.
        let box = lookBox(CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.1), in: CGRect(x: -1820, y: 50, width: 800, height: 600))
        check(box == CGRect(x: -1620, y: 290, width: 400, height: 60), "box on a second display: \(box)")
        check(lookBox(CGRect(x: 0, y: 0, width: 1, height: 1), in: CGRect(x: 10, y: 20, width: 30, height: 40)) == CGRect(x: 10, y: 20, width: 30, height: 40), "the whole image is the crop")
        check(lookBox(CGRect(x: 0, y: 0.9, width: 0.1, height: 0.1), in: CGRect(x: 0, y: 25, width: 1440, height: 875)).minY == 25, "the top of the image is the top of the crop")
        let find = lookKey("cmd+f")
        check(find?.code == 3 && find?.flags == .maskCommand && find?.refused == false, "cmd+f")
        check(lookKey("Return")?.code == 36 && lookKey("return")?.flags == [], "return")
        check(lookKey("shift+tab")?.flags == .maskShift && lookKey("shift+tab")?.code == 48, "shift+tab")
        check(lookKey("ctrl+alt+page-down")?.code == 121 && lookKey("ctrl+alt+page-down")?.flags == [.maskControl, .maskAlternate], "ctrl+alt+page-down")
        check(lookKey("up")?.code == 126 && lookKey("left")?.code == 123 && lookKey("7")?.code == 26, "arrows and digits")
        check(lookKey("cmd+q")?.refused == true && lookKey("cmd+shift+q")?.refused == true && lookKey("ctrl+cmd+q")?.refused == true, "cmd+q in any form is refused")
        check(lookKey("cmd+delete")?.refused == true && lookKey("cmd+alt+delete")?.refused == true && lookKey("delete")?.refused == false, "cmd+delete is refused, delete is not")
        check(lookKey("q")?.refused == false && lookKey("cmd+w")?.refused == false, "q alone and cmd+w are keys")
        check(lookKey("") == nil && lookKey("f13") == nil && lookKey("hyper+f") == nil && lookKey("cmd+") == nil && lookKey("ab") == nil, "off the list")
        check(lookFlags([]) == [] && lookFlags(["Cmd", "shift"]) == [.maskCommand, .maskShift] && lookFlags(["alt", "ctrl"]) == [.maskAlternate, .maskControl] && lookFlags(["hyper"]) == nil, "click modifiers")
        // A: the privacy list.
        check(lookPrivate("Puzzlebox Notes", "studio.puzzlebox.notes", ["notes"]) && lookPrivate("Mail", "com.example.Post", ["example.post"]) && lookPrivate("MAIL", nil, ["mail"]), "a fragment of the name or the bundle id, any case")
        check(!lookPrivate("Mail", "com.example.post", ["notes"]) && !lookPrivate("Mail", "com.example.post", nil) && !lookPrivate("Mail", "com.example.post", []), "not on the list")
        check(!lookPrivate("Puzzlebox Notes", "x", ["", " "]) && lookPrivate("Mail", "x", [7, "mail"]) && !lookPrivate(nil, nil, ["mail"]), "an empty fragment holds nothing; a bad entry is skipped")
        // Item 4 (2026-11-17): a private app's name in another language, matched whole; the substring list is unchanged.
        check(lookPrivate("Notities", "nl.example.x", ["=notities"]) && lookPrivate("  notities.app ", nil, ["=notities"]) && lookPrivate("Trousseaux d\u{2019}accès", nil, ["=trousseaux d'accès"]), "a localized name, whole, any case, without .app")
        check(!lookPrivate("Notities Plus", nil, ["=notities"]) && !lookPrivate("Mijn notities", nil, ["=notities"]) && !lookPrivate("x", "nl.notities", ["=notities"]) && !lookPrivate("=", nil, ["="]), "never a part of the name, never the bundle id")
        check(lookPrivate("Apple Mail", "com.example.post", ["mail", "=mail"]), "the substring list still holds")
        // Item 1 (plan 2B): keys go to the panel's own process.
        check(lookKeyTarget(app: 400, focused: 512) == 512 && lookKeyTarget(app: 400, focused: nil) == 400 && lookKeyTarget(app: 400, focused: 0) == 400 && lookKeyTarget(app: 400, focused: 400) == 400 && lookKeyTarget(app: 400, focused: 77, own: 77) == 400, "keys to the process that owns the focused thing")
        // Item 8: a point, a drag's path, the quiet settle.
        check(lookPoint([12, 30.5]) == CGPoint(x: 12, y: 30.5) && lookPoint([1]) == nil && lookPoint(["a", 2]) == nil && lookPoint([Double.nan, 2]) == nil && lookPoint(nil) == nil, "a point is two finite numbers")
        let path = lookPath(CGPoint(x: 100, y: 100), CGPoint(x: 200, y: 50), steps: 4)
        check(path.count == 7 && path[0] == CGPoint(x: 102, y: 102) && path[1] == CGPoint(x: 125, y: 87.5) && path[4] == CGPoint(x: 200, y: 50) && path.suffix(2).allSatisfy { $0 == CGPoint(x: 200, y: 50) }, "a drag nudges, steps evenly, rests on the drop")
        check(lookPath(.zero, .zero, steps: 0).count == 5 && lookPath(.zero, .zero, steps: 500).count == 63, "a drag's steps held to 2...60")
        let t0 = Date(timeIntervalSince1970: 1000)
        check(!lookQuiet(last: nil, since: t0, start: t0, now: t0 + 1, quiet: 0.1) && !lookQuiet(last: t0 - 1, since: t0, start: t0, now: t0 + 1, quiet: 0.1), "not heard since the act: not settled")
        check(lookQuiet(last: t0 + 0.02, since: t0, start: t0, now: t0 + 0.2, quiet: 0.1) && !lookQuiet(last: t0 + 0.15, since: t0, start: t0, now: t0 + 0.2, quiet: 0.1) && !lookQuiet(last: t0, since: t0, start: t0, now: t0 + 0.05, quiet: 0.01), "quiet for the window, and never before 0.06 s")
        check(LookTune(nil).quiet == 0.1 && LookTune(["quiet": 0.3] as [String: Any]).quiet == 0.3 && LookTune(["quiet": 9] as [String: Any]).quiet == 1 && LookTune(["quiet": 0] as [String: Any]).quiet == 0.03, "the quiet window held to 0.03...1 s")
        // B: the tune, defaults and ranges.
        let plain = LookTune(nil)
        check(plain.thin == 15 && plain.settle == 0.4 && plain.settleNew == 0.5 && plain.deadline == 1.5 && plain.visited == 5000 && plain.cap == 90_000 && plain.languages == ["en-US", "nl-NL"] && plain.textTtl == 30, "tune defaults")
        let tuned = LookTune(["thin": 3, "settle": 0.25, "settleNew": 1, "deadline": 2.5, "visited": 800, "cap": 60_000, "languages": ["nl-NL"], "textTtl": 10] as [String: Any])
        check(tuned.thin == 3 && tuned.settle == 0.25 && tuned.settleNew == 1 && tuned.deadline == 2.5 && tuned.visited == 800 && tuned.cap == 60_000 && tuned.languages == ["nl-NL"] && tuned.textTtl == 10, "tune as asked")
        let wild = LookTune(["thin": -5, "settle": 600, "settleNew": "long", "deadline": 0, "visited": 1e12, "cap": 90, "languages": [], "textTtl": Double.infinity] as [String: Any])
        check(wild.thin == 0 && wild.settle == 3 && wild.settleNew == 0.5 && wild.deadline == 0.2 && wild.visited == 20000 && wild.cap == 90_000 && wild.languages == ["en-US", "nl-NL"] && wild.textTtl == 30, "a wild tune is held: \(wild)")
        check(LookTune(["cap": 5] as [String: Any]).cap == 10_000 && LookTune(["cap": 9e9] as [String: Any]).cap == 400_000 && LookTune("no").thin == 15, "the cap has a floor and a ceiling")
        // D: a ref holds while the thing is the same thing.
        let row = (role: "AXRow", label: "Mira Bakker, Lunch Thursday")
        check(lookHolds(row, ("AXRow", "Mira Bakker, Lunch Thursday"), text: false, age: 900, ttl: 30), "the same row holds, however old")
        check(!lookHolds(row, ("AXRow", "Puzzlebox Studio, Invoice"), text: false, age: 1, ttl: 30) && !lookHolds(row, ("AXCell", row.label), text: false, age: 1, ttl: 30), "a recycled row does not")
        check(!lookHolds(row, nil, text: false, age: 1, ttl: 30), "a thing that cannot be read does not")
        check(lookHolds(("text", "Reply to all"), nil, text: true, age: 29, ttl: 30) && !lookHolds(("text", "Reply to all"), nil, text: true, age: 31, ttl: 30), "a line of text holds for its time")
        // E: keys go only on a read that says no password field has the keyboard.
        check(lookKeyGate(focus: .noValue, subrole: .noValue, sub: nil) == nil, "nothing focused: send")
        check(lookKeyGate(focus: .success, subrole: .success, sub: "AXSearchField") == nil && lookKeyGate(focus: .success, subrole: .noValue, sub: nil) == nil && lookKeyGate(focus: .success, subrole: .attributeUnsupported, sub: nil) == nil, "a plain field: send")
        check(lookKeyGate(focus: .success, subrole: .success, sub: kAXSecureTextFieldSubrole) == "secure-field", "a password field: no")
        check(lookKeyGate(focus: .cannotComplete, subrole: .noValue, sub: nil) == "focus-unknown" && lookKeyGate(focus: .failure, subrole: .noValue, sub: nil) == "focus-unknown" && lookKeyGate(focus: .apiDisabled, subrole: .noValue, sub: nil) == "focus-unknown", "the focus cannot be read: no")
        check(lookKeyGate(focus: .success, subrole: .cannotComplete, sub: nil) == "focus-unknown" && lookKeyGate(focus: .success, subrole: .invalidUIElement, sub: nil) == "focus-unknown", "the focused thing cannot be read: no")
        check(LookTune(nil).focusStrict && LookTune(["focusStrict": "no"] as [String: Any]).focusStrict && !LookTune(["focusStrict": false] as [String: Any]).focusStrict, "focusStrict is true unless it is false")
        check(lookKeyGate(focus: .cannotComplete, subrole: .noValue, sub: nil, strict: false) == nil && lookKeyGate(focus: .failure, subrole: .noValue, sub: nil, strict: false) == nil && lookKeyGate(focus: .success, subrole: .cannotComplete, sub: nil, strict: false) == nil, "not strict: a failed read sends")
        check(lookKeyGate(focus: .success, subrole: .success, sub: kAXSecureTextFieldSubrole, strict: false) == "secure-field" && lookKeyGate(focus: .success, subrole: .success, sub: "AXSearchField", strict: false) == nil, "not strict: a password field is still a no")
        // W4: a key by any common name, the refusals kept.
        check(lookKey("Enter")?.code == 36 && lookKey("esc")?.code == 53 && lookKey("Backspace")?.code == 51 && lookKey("forward-delete")?.code == 117 && lookKey("Home")?.code == 115 && lookKey("end")?.code == 119, "enter, esc, backspace, forward-delete, home, end")
        check(lookKey("arrow-up")?.code == 126 && lookKey("ArrowUp")?.code == 126 && lookKey("up")?.code == 126 && lookKey("arrow_left")?.code == 123 && lookKey("DownArrow")?.code == 125, "arrows by any name")
        check(lookKey("page up")?.code == 116 && lookKey("Page_Down")?.code == 121 && lookKey("cmd + page up")?.flags == .maskCommand, "page up, spaced")
        check(lookKey("F1")?.code == 122 && lookKey("f5")?.code == 96 && lookKey("f12")?.code == 111 && lookKey("f13") == nil, "f1 to f12")
        check(lookKey("Command+Option+f")?.flags == [.maskCommand, .maskAlternate] && lookKey("opt+left")?.flags == .maskAlternate && lookKey("control+a")?.flags == .maskControl && lookKey("meta+f")?.flags == .maskCommand, "modifier names")
        check(lookKey("cmd+,")?.code == 43 && lookKey("cmd+/")?.code == 44 && lookKey("ctrl+-")?.code == 27, "punctuation")
        check(lookKey("Command + Q")?.refused == true && lookKey("cmd+backspace")?.refused == true && lookKey("meta+q")?.refused == true && lookKey("backspace")?.refused == false, "the refusals hold under every name")
        // W1, W2: the windows, and the one a fragment names.
        let rows = (1 ... 14).map { (title: Optional("Puzzlebox vault \($0)"), main: $0 == 1, minimized: $0 == 2) }
        let listed = lookWindows(rows)
        check(listed.count == 12 && listed[0]["title"] as? String == "Puzzlebox vault 1" && listed[0]["main"] as? Bool == true && listed[1]["minimized"] as? Bool == true, "twelve windows, front first")
        check(lookWindows([(String(repeating: "w", count: 300), false, false), (nil, false, false)]).map { ($0["title"] as? String ?? "?").count } == [120, 0], "a long title is cut, a missing one is empty")
        let titles: [String?] = ["Notes 2 - Puzzlebox", nil, "Notes", "Mira Bakker"]
        check(lookWindowMatch(titles, "notes") == 2 && lookWindowMatch(titles, " PUZZLEBOX ") == 0 && lookWindowMatch(titles, "mira") == 3, "exact title first, else the first that holds it, any case")
        check(lookWindowMatch(titles, "invoice") == nil && lookWindowMatch(titles, "  ") == nil && lookWindowMatch([], "notes") == nil, "no such window")
        check(lookShortcut("g", 1) == "⇧⌘G" && lookShortcut("N", 0) == "⌘N" && lookShortcut("1", 6) == "⌃⌥⌘1" && lookShortcut("x", 8) == "X", "a menu key as its menu draws it")
        check(lookShortcut(nil, 0) == nil && lookShortcut("", 0) == nil && lookShortcut("\u{7F}", 0) == nil && lookShortcut("\u{F704}", 0) == nil, "no key, or one with no letter")
        check(lookTitle(" Show View Options…") == "show view options" && lookTitle("Save As...") == "save as" && lookTitle("Sort  By") == "sort by" && lookTitle(nil) == "", "a menu title as a path names it")
        // Run 11: "play" matched every "Play <playlist>" in the sidebar as much as the album's own button.
        let q = lookQuery("play a love supreme")
        check(lookScore("AXButton", "play a love supreme", q) > lookScore("AXButton", "play daily mix", q), "the one that answers more of the query scores higher")
        check(lookScore("AXButton", "playlist", lookQuery("play")) == 1 && lookScore("AXButton", "play", lookQuery("play")) == 2, "a whole word beats a word inside another")
        check(lookScore("AXButton", "home", q) == 0 && lookScore("AXMenuItem", "anything", []) == 1, "nothing of the query is not wanted; a menu item always is")
        check(lookScore("AXButton", "to me", lookQuery("to cc")) == 2, "a query of short words still matches")
        // Fixed labels: a thing keeps its number across looks while it shows.
        var book = LookLabels<String>()
        let part = { (e: String, label: String, place: String) in (element: e, hash: e.hashValue, role: "AXButton", label: label, place: place) }
        let first = book.give([part("play", "Play", "player"), part("next", "Next", "player")], same: ==)
        check(first == [1, 2], "a first look numbers in order: \(first)")
        check(book.give([part("new", "New", "toolbar"), part("next", "Next", "player"), part("play", "Play", "player")], same: ==) == [3, 2, 1], "the same thing keeps its number, a new one gets the next")
        check(book.give([part("play", "Pause", "player")], same: ==) == [4], "the same element with other words is another thing")
        check(book.give([part("play2", "Play", "player")], same: ==) == [1], "one gone thing alike takes its number back")
        check(book.give([part("a", "Add", "row"), part("b", "Add", "row")], same: ==) == [5, 6] && book.give([part("c", "Add", "row"), part("d", "Add", "row")], same: ==) == [7, 8], "two alike are never guessed at")
        check(Set(book.give([part("x", "Same", "p"), part("x", "Same", "p")], same: ==)).count == 2, "one number is never given twice in one look")
        var whole = LookLabels<String>()
        _ = whole.give([part("row1", "Open", "list")], same: ==)
        var cut = whole
        check(whole.give([part("row2", "Open", "list")], same: ==) == [1] && cut.give([part("row2", "Open", "list")], cut: true, same: ==) == [2], "a cut look takes no number back by place")
        // Runs 255, 257: a field in a sheet gives its parent as window and the sheet as top level; a fresh sheet is focused and main.
        check(lookInFront(["doc", "sheet"], ["sheet", "sheet"], same: ==) && lookInFront(["doc", "sheet"], ["sheet", "doc"], same: ==) && lookInFront(["doc", "sheet"], ["doc", "doc"], same: ==), "a thing in a sheet is in front, fresh or after a raise of its parent")
        check(lookInFront(["doc", "doc"], ["doc", nil], same: ==) && !lookInFront(["back", "back"], ["doc", "doc"], same: ==) && !lookInFront(["back", "sheet2"], ["doc", "sheet"], same: ==), "a window behind another, or a sheet on it, is not")
        check(!lookInFront(["doc", nil], [nil, nil], same: ==) && !lookInFront([nil, nil] as [String?], [nil, "doc"], same: ==), "nothing read is never in front")
        for _ in 0 ..< 31 { _ = book.give([], same: ==) }
        check(book.all.isEmpty, "a thing unseen for 30 looks is forgotten")
        // The cut keeps the edges, then the middle, then list rows, in the window's order.
        check(lookOverrun([]) == 300 && lookOverrun(["play"]) == 1500, "past the cut: 300 parts for the edges, 1500 for a query")
        let pane = CGRect(x: 440, y: 200, width: 920, height: 450)
        check(lookFocusInside(CGRect(x: 700, y: 350, width: 64, height: 18), window: pane, sameWindow: true) && lookFocusInside(CGRect(x: 700, y: 350, width: 64, height: 18), window: pane, sameWindow: nil), "a rename box in the window is a part, its window named or not")
        check(!lookFocusInside(CGRect(x: 700, y: 350, width: 64, height: 18), window: pane, sameWindow: false) && !lookFocusInside(CGRect(x: 1500, y: 350, width: 64, height: 18), window: pane, sameWindow: true), "focus in another window, or outside this one, is not")
        check(lookKeep([1, 2, 2, 0, 1], 3) == [0, 3, 4] && lookKeep([2, 2, 2], 2) == [0, 1] && lookKeep([1, 0], 5) == [0, 1], "the cut keeps by rank, then order")
        check(lookPart(role: "AXGroup", label: "", value: "", actions: ["AXShowMenu", "AXScrollToVisible", "AXPress"], settable: true) == nil && lookPart(role: "AXGroup", label: "", value: "", actions: ["AXIncrement"], settable: true)! == (["AXIncrement"], false) && lookPart(role: "AXButton", label: "Play", value: "", actions: ["AXPress", "AXShowMenu"], settable: false)! == (["AXPress"], false) && lookPart(role: "AXLink", label: "", value: "", actions: ["AXShowMenu"], settable: false)! == (["AXShowMenu"], false), "a mute wrapper goes, defaults go when there is more")
        // Set 2 R5: a point on a second display finds that display; the flip is the primary's either way.
        let main = CGRect(x: 0, y: 0, width: 1440, height: 900), right = CGRect(x: 1440, y: -180, width: 1920, height: 1080), above = CGRect(x: 0, y: 900, width: 1280, height: 800)
        check(lookTopLeft(right, primary: 900) == CGRect(x: 1440, y: 0, width: 1920, height: 1080) && lookTopLeft(above, primary: 900) == CGRect(x: 0, y: -800, width: 1280, height: 800), "an AppKit frame flips against the primary's height")
        check(lookScreenIndex(CGPoint(x: 100, y: 100), [main, right, above]) == 0 && lookScreenIndex(CGPoint(x: 2000, y: 1000), [main, right, above]) == 1 && lookScreenIndex(CGPoint(x: 600, y: -400), [main, right, above]) == 2, "a point finds the display that holds it, beside or above")
        check(lookScreenIndex(CGPoint(x: 1500, y: 1050), [main, right]) == 1 && lookScreenIndex(CGPoint(x: 100, y: 950), [main, right]) == nil && lookScreenIndex(.zero, []) == nil, "below the primary on the taller one; off every display is none")
        // Runs 231-234: Send under the slip's run card. Sundial's own floating panel over the point is passed over; another
        // app's normal window over it is still a cover, a bar above the normal layer is not, and no window of the app is a no.
        let browser: pid_t = 200, sundial: pid_t = 100, other: pid_t = 300
        let send = CGPoint(x: 420, y: 560), page = CGRect(x: 300, y: 40, width: 1100, height: 760)
        let slip = (owner: sundial, layer: 3, rect: CGRect(x: 0, y: 25, width: 1440, height: 875))
        let bar = (owner: other, layer: 25, rect: CGRect(x: 0, y: 500, width: 600, height: 100))
        let note = (owner: other, layer: 0, rect: CGRect(x: 350, y: 500, width: 300, height: 200))
        let tab = (owner: browser, layer: 0, rect: page)
        check(lookOwns([slip, tab], send, app: browser, own: sundial) && lookOwns([bar, slip, tab], send, app: browser, own: sundial), "the slip over Send, or a bar above it, is no cover")
        check(!lookOwns([note, tab], send, app: browser, own: sundial) && !lookOwns([slip, note, tab], send, app: browser, own: sundial), "another app's window over Send still is")
        check(!lookOwns([slip, tab], CGPoint(x: 100, y: 560), app: browser, own: sundial) && !lookOwns([], send, app: browser, own: sundial), "a point off the app's window is not its to take")
        // Rig run205 T12: the caret's line, numbered from 1, ringed across the text area.
        check(lookLineNumber(0) == 1 && lookLineNumber(11) == 12 && lookLineNumber(nil) == nil && lookLineNumber(-1) == nil, "AX's line 0 is line 1; none or a negative is none")
        let area = CGRect(x: 240, y: 100, width: 900, height: 600)
        check(lookCaretLine(CGRect(x: 300, y: 410, width: 120, height: 18), in: area) == CGRect(x: 240, y: 410, width: 900, height: 18), "a line is ringed across the area, at its own height")
        check(lookCaretLine(CGRect(x: 244, y: 410, width: 0, height: 18), in: area) == CGRect(x: 240, y: 410, width: 900, height: 18), "an empty line, no width of its own, still rings")
        check(lookCaretLine(CGRect(x: 300, y: 40, width: 120, height: 18), in: area) == nil && lookCaretLine(CGRect(x: 300, y: 900, width: 120, height: 18), in: area) == nil, "a line scrolled out of the area rings nothing")
        check(lookCaretLine(CGRect(x: 300, y: 410, width: 120, height: 0), in: area) == nil && lookCaretLine(CGRect(x: 300, y: 100, width: 900, height: 600), in: area) == nil && lookCaretLine(CGRect(x: CGFloat.nan, y: 410, width: 1, height: 18), in: area) == nil, "no height, a whole page, or nonsense is no line")
        check(lookCaretLine(CGRect(x: 300, y: 92, width: 120, height: 18), in: area) == CGRect(x: 240, y: 100, width: 900, height: 10), "a line half out is cut to the area")
        // S4: a text area is read by its range, bounded.
        check(plain.area == 4000 && LookTune(["area": 0] as [String: Any]).area == 0 && LookTune(["area": 9e9] as [String: Any]).area == 20000 && LookTune(["area": -1] as [String: Any]).area == 0, "the text area budget: 4000, held to 0...20000")
        // S4R2: a text area read whole is no cut for its blank lines and double spaces; one read in part, or past the budget, is.
        let spaced = "Lunch  Thursday\n\n\nMira  Bakker\n"
        check(!lookTextCut(spaced, kept: lookText(spaced, 4000), range: CFRange(location: 0, length: spaced.count), total: spaced.count) && !lookTextCut(spaced, kept: lookText(spaced, 4000)), "folded spacing read whole is no cut")
        // S5R1 (Fable H3): that same read whole is folded, so a set-value is refused there; plain lines, or a line break at the end only, are not.
        check(lookTextFolded(spaced, kept: lookText(spaced, 4000)) && lookTextFolded("Lunch\n  - soup", kept: lookText("Lunch\n  - soup", 4000)) && lookTextFolded("a\tb", kept: lookText("a\tb", 4000)), "blank lines, an indent or a tab are folded")
        check(!lookTextFolded("Lunch Thursday\nMira Bakker\n", kept: lookText("Lunch Thursday\nMira Bakker\n", 4000)) && !lookTextFolded("", kept: lookText("", 4000)), "plain lines, or a line break at the end only, are not folded")
        check(lookTextCut(spaced, kept: lookText(spaced, 4000), range: CFRange(location: 3, length: 10), total: spaced.count) && lookTextCut(spaced, kept: lookText(spaced, 8)) && lookTextCut(spaced, kept: lookText(spaced, 4000), range: CFRange(location: 0, length: 10)), "a part, a budget or an unknown length is a cut")
        // S5R1: a text area's marks, the walk's and a focused part's alike.
        check(lookReadMarks(("Lunch Thursday", 900, true, false))["cut"] as? Int == 900 && lookReadMarks(("Lunch Thursday", 900, true, true)).count == 1, "read in part: its whole length, nothing else")
        let folded = lookReadMarks((lookText(spaced, 4000), spaced.utf16.count, false, true))
        check(folded["folded"] as? Bool == true && folded["chars"] as? Int == spaced.utf16.count && folded["cut"] == nil, "read whole and folded: folded, and its real length")
        check(lookReadMarks(("Lunch", 5, false, false)).isEmpty && lookReadMarks(nil).isEmpty, "read whole as it is, or no read: no mark")
        // S5R1: the default button named at the window, from its part's mark.
        let parts: [[String: Any]] = [["ref": "e1", "label": "Name", "role": "AXTextField"], ["ref": "e2", "label": "Cancel", "cancel": true], ["ref": "e3", "label": "Replace", "default": true]]
        check(lookDefaultButton(parts)?["ref"] as? String == "e3" && lookDefaultButton(parts)?["label"] as? String == "Replace", "the part marked default is the window's default button")
        // S5R1: a web composer says what it is; a button or a field does not need to.
        let entry = lookEntry(role: "AXGroup", roleDescription: "  text entry\n area ", editable: true)
        check(entry["roleDescription"] as? String == "text entry area" && entry["editable"] as? Bool == true, "a group's role description and its editable mark")
        check(lookEntry(role: "AXWebArea", roleDescription: "", editable: false).isEmpty && lookEntry(role: "AXButton", roleDescription: "button", editable: true).isEmpty, "nothing said, or not a group or web area: no marks")
        check(lookDefaultButton(Array(parts.prefix(2))) == nil && lookDefaultButton([]) == nil, "no part marked default: none")
        let span = { (r: (range: CFRange, midLine: Bool)?) in r.map { [$0.range.location, $0.range.length, $0.midLine ? 1 : 0] } }
        check(span(lookTextSpan(total: 1200, visible: CFRange(location: 300, length: 500), max: 4000)) == [0, 1200, 0], "a small text area is read whole")
        check(span(lookTextSpan(total: 2_000_000, visible: CFRange(location: 1_998_000, length: 1500), max: 4000)) == [1_998_000, 1500, 0], "a long scrollback: the part that shows")
        check(span(lookTextSpan(total: 2_000_000, visible: CFRange(location: 10_000, length: 9000), max: 4000)) == [10_000, 4000, 0] && span(lookTextSpan(total: 2_000_000, visible: CFRange(location: 10_000, length: 9000), caret: 12_000, max: 4000)) == [10_000, 4000, 0], "a part that shows past the budget keeps its start")
        check(span(lookTextSpan(total: 2_000_000, visible: CFRange(location: 10_000, length: 9000), caret: 18_990, max: 4000)) == [15_000, 4000, 1] && span(lookTextSpan(total: 2_000_000, visible: CFRange(location: 10_000, length: 9000), caret: 15_000, max: 4000)) == [15_000, 4000, 1], "its end, from inside a line, when the caret is in the last screenful")
        check(span(lookTextSpan(total: 9000, visible: nil, max: 4000)) == [5000, 4000, 1] && span(lookTextSpan(total: 9000, visible: CFRange(location: 0, length: 0), max: 4000)) == [5000, 4000, 1], "no visible range: the end of the whole, from inside a line")
        check(span(lookTextSpan(total: nil, visible: CFRange(location: 40, length: 100), max: 4000)) == [40, 100, 0] && span(lookTextSpan(total: 100, visible: CFRange(location: 90, length: 50), max: 50)) == [90, 10, 0], "no length known, or a range past the end")
        check(lookTextSpan(total: 0, visible: nil, max: 4000) == nil && lookTextSpan(total: nil, visible: nil, max: 4000) == nil && lookTextSpan(total: 9000, visible: nil, max: 0) == nil && lookTextSpan(total: nil, visible: CFRange(location: -1, length: 9), max: 10) == nil, "nothing to ask")
        check(lookText("  $ ls   -la \n\n\n  total 8   \r\n\n", 4000) == "$ ls -la\ntotal 8", "lines kept, white space folded, blank lines gone")
        check(lookText("one\ntwo\nthree", 100) == "one\ntwo\nthree" && lookText(nil, 10) == "" && lookText("abc", 0) == "", "short text is kept whole")
        // Fable H2: a cut never starts inside a line, so API_KEY= is never cut off its value.
        check(lookText("export PUZZLE_API_KEY=EXAMPLE_KEY_PLACEHOLDER\nlast line", 30) == "last line", "a cut drops the partial first line")
        check(lookText("Y=EXAMPLE_KEY_PLACEHOLDER\nlast line", 4000, midLine: true) == "last line" && lookText("whole first\nlast", 4000, midLine: false) == "whole first\nlast", "a range that starts inside a line drops it")
        check(lookText("token EXAMPLE_KEY ok fine", 12) == "ok fine" && lookText(String(repeating: "a", count: 50), 10) == "", "no line break: a partial first word goes, and one long word is nothing")
        check(lookText(String(repeating: "\u{1F469}\u{200D}\u{1F467} ", count: 3000), 4000).count <= 4000, "bounded in characters, a whole emoji each")
        check(lookThin(10, areaChars: 0, 15) && !lookThin(10, areaChars: 3800, 15) && !lookThin(40, areaChars: 0, 15) && lookThin(3, areaChars: 199, 15), "a text area with words is not a thin tree")
        check(lookLazy(["Electron Framework.framework", "Squirrel.framework"]) && lookLazy(["Chromium Embedded Framework.framework"]) && lookLazy(["Google Chrome Framework.framework"]) && lookLazy(["Google Chrome for Testing Framework.framework"]) && lookLazy(["Microsoft Edge Framework.framework"]) && lookLazy(["Brave Browser Framework.framework"]), "Electron, CEF and the Chromium browsers wake")
        check(lookLazy(["ChannelPrefs.framework"], ["XUL", "gpu-helper.app"]) && lookLazy(["FlutterMacOS.framework", "App.framework"]) && lookLazy(["ArcCore.framework"]), "Gecko (Zen, Firefox), Flutter and Arc wake")
        check(plain.wake == 2.0 && LookTune(["wake": 0.5] as [String: Any]).wake == 0.5 && LookTune(["wake": 60] as [String: Any]).wake == 5, "a Chromium browser's first look waits 2 s, held to 0...5")
        check(!lookLazy([]) && !lookLazy(["Sparkle.framework", "Puzzlebox Framework.framework"], ["Puzzlebox"]) && !lookLazy(["ChromeKit.framework"]) && !lookLazy(["ChannelPrefs.framework"], ["Zen"]), "a native app is never woken")
        // Doc 32 item 1: the slip at (0, 25), its Stop at (1100, 1080) in the page; Gnomon clicks a file at (300, 200).
        let stop = CGRect(x: 1090, y: 1070, width: 60, height: 30), card = CGRect(x: 900, y: 700, width: 500, height: 420)
        let origin = CGPoint(x: 0, y: 25), onStop = CGPoint(x: 1112, y: 1108), file = CGPoint(x: 300, y: 200)
        let open = (start: 100.0, end: TimeInterval?.none, back: CGPoint?.some(onStop), target: CGPoint?.some(file))
        check(slipMissed(onStop, time: 100.1, hand: false, window: open, origin: origin, regions: [stop, card]) == CGPoint(x: 1112, y: 1083), "the rig's press on Stop while Gnomon clicks: meant for the slip")
        check(slipMissed(file, time: 100.1, hand: true, window: open, origin: origin, regions: [stop]) == CGPoint(x: 1112, y: 1083), "a hand's press lands on Gnomon's target, but the owner's pointer was on Stop")
        check(slipMissed(CGPoint(x: 1000, y: 800), time: 100.1, hand: false, window: (100, nil, onStop, CGPoint(x: 1000, y: 800)), origin: origin, regions: [card]) == nil
              && slipMissed(onStop, time: 100.1, hand: false, window: (100, nil, nil, onStop), origin: origin, regions: [stop]) == nil, "Gnomon's own press, even on a point under the slip, never is")
        check(slipMissed(CGPoint(x: 1112, y: 1108), time: 100.1, hand: true, window: (100, nil, CGPoint(x: 400, y: 400), file), origin: origin, regions: [stop]) == nil
              && slipMissed(file, time: 100.1, hand: true, window: (100, nil, nil, file), origin: origin, regions: [stop]) == nil, "a hand whose pointer was off the slip, or not known: not meant for it")
        check(slipMissed(CGPoint(x: 600, y: 600), time: 100.1, hand: false, window: open, origin: origin, regions: [stop, card]) == nil, "a posted press off the slip goes where it went")
        check(slipMissed(onStop, time: 99.9, hand: false, window: open, origin: origin, regions: [stop]) == nil && slipMissed(onStop, time: 100.1, hand: false, window: nil, origin: origin, regions: [stop]) == nil, "before the hands, or no hands yet: not this")
        let shut = (start: 100.0, end: TimeInterval?.some(100.2), back: CGPoint?.some(onStop), target: CGPoint?.some(file))
        // Run 258 T18: Gnomon's click was done at 34.005, the rig's press at about 34.15 still went through.
        check(slipMissed(onStop, time: 100.35, hand: false, window: shut, origin: origin, regions: [stop]) != nil && slipMissed(onStop, time: 101.3, hand: false, window: shut, origin: origin, regions: [stop]) == nil, "a press that went through just after the hands still counts; a second later it is not this")
        check(slipMissed(onStop, time: 100.3, hand: true, window: (100, 100.2, CGPoint(x: 400, y: 400), file), origin: origin, regions: [stop]) != nil
              && slipMissed(file, time: 100.3, hand: true, window: (100, 100.2, onStop, file), origin: origin, regions: [stop]) == nil, "after the hands, a hand's press is where the pointer is")
        // Doc 32 item 3: the old TextEdit (pid 10) unknown, the new one (pid 20) with notes.txt on screen.
        let te = "com.apple.TextEdit", shown: [(pid: pid_t, bundle: String?)] = [(20, te), (30, "com.apple.finder")]
        check(lookLivePid(10, known: false, bundle: te, windows: shown) == 20 && lookLivePid(10, known: true, bundle: te, windows: shown) == 20, "a process with no window on screen gives way to the same app's that has one")
        check(lookLivePid(20, known: true, bundle: te, windows: [(10, te), (20, te)]) == 20, "a known process with a window stays, even behind another of its app")
        check(lookLivePid(10, known: false, bundle: te, windows: [(30, "com.apple.finder")]) == 10 && lookLivePid(10, known: false, bundle: nil, windows: [(20, nil)]) == 10 && lookLivePid(10, known: true, bundle: "", windows: [(20, "")]) == 10, "no other of its app on screen, or no bundle: itself")
        let launched = Date(timeIntervalSince1970: 1000)
        check(lookStarting(finished: false, launched: nil, now: launched) && lookStarting(finished: true, launched: launched, now: launched.addingTimeInterval(2)), "still launching, or started 2 s ago: starting")
        check(!lookStarting(finished: true, launched: launched, now: launched.addingTimeInterval(30)) && !lookStarting(finished: true, launched: nil, now: launched), "running a while, or no launch date: not")
        // Doc 32 item 2.
        check(axUnknownDone(.attributeUnsupported, gone: true, moved: false) && axUnknownDone(.attributeUnsupported, gone: false, moved: true), "-25205 with the button gone or the window changed: done")
        check(!axUnknownDone(.attributeUnsupported, gone: false, moved: false) && !axUnknownDone(.failure, gone: true, moved: true) && !axUnknownDone(.actionUnsupported, gone: true, moved: true), "-25205 with nothing changed, or another error: still a no")
        print(failed == 0 ? "look self-check: ok" : "look self-check: \(failed) failed")
        exit(failed == 0 ? 0 : 1)
    }
}

#else

// MARK: - Accessibility, read with care

/// An AX value as an element. Checked by type: a CF cast in Swift never fails on its own.
func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

/// Many attributes in one round trip; one the element does not have is nil.
private func axMany(_ element: AXUIElement, _ names: [String]) -> [CFTypeRef?]? {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(element, names as CFArray, [], &values) == .success,
          let list = values as? [AnyObject], list.count == names.count else { return nil }
    return list.map { value in
        if value is NSNull { return nil }
        if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
        return value
    }
}

/// The app's focused or main window is this one, or `top`: the sheet a thing sits in (its AXTopLevelUIElement).
private func axInFront(_ root: AXUIElement, _ window: AXUIElement, _ top: AXUIElement? = nil) -> Bool {
    lookInFront([window, top], [kAXFocusedWindowAttribute, kAXMainWindowAttribute].map { axElement(axValue(root, $0)) }, same: { CFEqual($0, $1) })
}

/// A list of elements, each checked by type.
func axList(_ value: CFTypeRef?) -> [AXUIElement] {
    (value as? [AnyObject])?.compactMap { axElement($0) } ?? []
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
}

private func axRect(_ position: CFTypeRef?, _ size: CFTypeRef?) -> CGRect? {
    guard let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent),
          extent.width > 0, extent.height > 0, [point.x, point.y, extent.width, extent.height].allSatisfy({ $0.isFinite && abs($0) < 1e7 }) else { return nil }
    return CGRect(origin: point, size: extent)
}

private func ints(_ rect: CGRect) -> [Int] { [rect.minX, rect.minY, rect.width, rect.height].map { $0.isFinite ? Int(max(-1e7, min(1e7, $0)).rounded()) : 0 } }

/// A parameterized AX value of the given type; nil when the element has none.
private func axParam(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef, _ type: AXValueType) -> AXValue? {
    var value: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, parameter, &value) == .success, let value,
          CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == type else { return nil }
    return (value as! AXValue)
}

/// Look queue. Rig run205 T12: where the caret of a text area is, as the part's `caret`: its line (the first is 1) and that line's
/// frame on screen. Numbers and a frame only, never a word of the text; nothing for a secure field (a private app never gets here).
private func axCaret(_ element: AXUIElement, role: String, sub: String, box: CGRect) -> [String: Any]? {
    guard role == kAXTextAreaRole as String, sub != kAXSecureTextFieldSubrole as String,
          let selected = axValue(element, kAXSelectedTextRangeAttribute), CFGetTypeID(selected) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(selected as! AXValue, .cfRange, &range), range.location >= 0 else { return nil }
    let asked = (axValue(element, kAXInsertionPointLineNumberAttribute) as? NSNumber)?.intValue
    var bounds = CGRect.zero
    guard let line = lookLineNumber(asked) ?? lookLineNumber(axParamNumber(element, kAXLineForIndexParameterizedAttribute, NSNumber(value: range.location))),
          let span = axParam(element, kAXRangeForLineParameterizedAttribute, NSNumber(value: line - 1), .cfRange),
          let found = axParam(element, kAXBoundsForRangeParameterizedAttribute, span, .cgRect), AXValueGetValue(found, .cgRect, &bounds),
          let frame = lookCaretLine(bounds, in: box) else { return nil }
    return ["line": line, "frame": ints(frame)]
}

private func axParamNumber(_ element: AXUIElement, _ attribute: String, _ parameter: CFTypeRef) -> Int? {
    var value: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, parameter, &value) == .success ? (value as? NSNumber)?.intValue : nil
}

private func axRange(_ value: CFTypeRef?) -> CFRange? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(value as! AXValue, .cfRange, &range) ? range : nil
}

/// Look queue. S4: a text area's words by range (`lookTextSpan`), at most `max` characters, and its whole length; else its value
/// (`whole`, already read) the same way. Never a secure field (the caller asks only for a plain text area).
private func axAreaText(_ element: AXUIElement, _ max: Int, whole: String?) -> (text: String, total: Int, cut: Bool, folded: Bool)? {
    let total = (axValue(element, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue
    if let span = lookTextSpan(total: total, visible: axRange(axValue(element, kAXVisibleCharacterRangeAttribute)), caret: axRange(axValue(element, kAXSelectedTextRangeAttribute))?.location, max: max) {
        var range = span.range
        var out: CFTypeRef?
        if let asked = AXValueCreate(.cfRange, &range), AXUIElementCopyParameterizedAttributeValue(element, kAXStringForRangeParameterizedAttribute as CFString, asked, &out) == .success,
           let text = out as? String {
            let kept = lookText(text, max, midLine: span.midLine)
            return (kept, total ?? text.utf16.count, lookTextCut(text, kept: kept, range: span.range, total: total), lookTextFolded(text, kept: kept))
        }
    }
    return whole.map { (lookText($0, max), total ?? $0.utf16.count, lookTextCut($0, kept: lookText($0, max)), lookTextFolded($0, kept: lookText($0, max))) }
}

private let lookNames = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXPlaceholderValueAttribute,
                         kAXHelpAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXChildrenAttribute, kAXRoleDescriptionAttribute,
                         kAXVisibleRowsAttribute, kAXVisibleChildrenAttribute, "AXMenuItemMarkChar", "AXMenuItemCmdChar", "AXMenuItemCmdModifiers"]


/// The dialog or sheet around the focused element, if any: what a web app's compose window or an app's sheet is.
func lookDialog(_ focused: AXUIElement?) -> AXUIElement? {
    var at = focused
    for _ in 0 ..< 14 {
        guard let element = at else { return nil }
        let sub = axText(element, kAXSubroleAttribute) ?? ""
        if sub == "AXApplicationDialog" || sub == kAXDialogSubrole as String || axText(element, kAXRoleAttribute) == kAXSheetRole as String { return element }
        if axText(element, kAXRoleAttribute) == kAXWindowRole as String { return nil }
        at = axElement(axValue(element, kAXParentAttribute))
    }
    return nil
}

/// One part a walk kept. `words`: its label and value in lower case, for the OCR's doubles. `rank`: what a cut drops last (see `lookKeep`).
private typealias Part = (json: [String: Any], element: AXUIElement, frame: CGRect, words: String, rank: Int)

/// What one walk saw.
private struct Seen {
    var refused: String?
    var window: AXUIElement?
    var title = ""
    var frame = CGRect.zero
    var items: [Part] = []
    var menus: [String] = []
    var focused: AXUIElement?
    var truncated = false
    /// The window read is the app's own front window. False means the look is of a window the owner cannot see.
    var front = true
    /// A dialog or sheet holds the keyboard: what is behind it cannot be used until it is answered.
    var dialog = false
    var windows: [[String: Any]] = []
    /// S4: the characters its text areas gave (`LookTune.area` at most, all of them together).
    var area = 0
    /// S5R1: the buttons Return and Escape press in a one-line field, its sheet's or dialog's when one holds the keyboard, else the window's.
    var defaultButton: AXUIElement?
    var cancelButton: AXUIElement?
}

private final class Once { var done = false }

/// The time of each app's last AX notification: stamped on the main run loop (Screen's observer), read on the look queue.
/// No entry = the app is not heard, and a look after an act waits its whole settle.
final class AXStamps {
    private let lock = NSLock()
    private var last: [pid_t: Date] = [:]
    func listen(_ pid: pid_t) { lock.lock(); last[pid] = last[pid] ?? .distantPast; lock.unlock() }
    func stamp(_ pid: pid_t) { lock.lock(); if last[pid] != nil { last[pid] = Date() }; lock.unlock() }
    func last(_ pid: pid_t) -> Date? { lock.lock(); defer { lock.unlock() }; return last[pid] }
    func forget(_ pid: pid_t) { lock.lock(); last[pid] = nil; lock.unlock() }
}

let axStamps = AXStamps()

// MARK: - The look

final class Looks {
    /// What a ref stands for now: its app, its element (for a line of text: the window), its frame on screen.
    typealias Hit = (app: NSRunningApplication, element: AXUIElement, frame: CGRect, offset: CGRect?, text: Bool)

    /// What a ref stood for when the look saw it. A line of text has no element of its own: it keeps its
    /// window and its box from the window's corner, so it moves with the window.
    private typealias Ref = (element: AXUIElement, offset: CGRect?, role: String, label: String)

    private let channel = AppChannel()
    /// Every AX read runs here, one at a time, never on the main thread.
    let queue = DispatchQueue(label: "dev.sundial.look", qos: .userInitiated)
    /// Vision reads and typing is sent on queues of their own: neither holds a ring, a refusal check or a look.
    private let text = DispatchQueue(label: "dev.sundial.look.text", qos: .userInitiated)
    private let hands = DispatchQueue(label: "dev.sundial.look.hands", qos: .userInitiated)
    /// Main thread only. Per app, until its next look: the look's id and time, its window, and what each ref stands for.
    /// `ids`: the app run's last 20 looks, any of which an act may name. A label holds across them; a line of text only in its own look.
    private var kept: [pid_t: (id: String, at: Date, window: AXUIElement, size: CGSize, ocr: Bool, refs: [String: Ref], ids: [String])] = [:]
    /// Look queue only. Per app run: its tag (the label's "@ab12") and the labels its things keep across looks.
    private var labels: [pid_t: (tag: String, book: LookLabels<AXUIElement>)] = [:]
    /// Look queue only: the apps already asked to build their tree.
    private var woken: Set<pid_t> = []
    /// Look queue only: the apps whose thin tree was asked again (run 21).
    private var rewoken: Set<pid_t> = []
    /// Look queue only. The screen stage (experiments.screenStage): each placed window, by the app name Node gave, with its frame from before.
    private var staged: [(app: String, window: AXUIElement, was: CGRect)] = []

    /// The screen stage: the app's window (the one `window` names, else its front one) into `slot`, [x, y, w, h] in parts of the
    /// free screen, its frame from before kept for `unplace`. Refused without a word, as a look is: secure input, a private or
    /// protected app, a sign-in window, a full-screen or minimized window, a named window that is not there (never the front one instead).
    func place(_ command: [String: Any]) {
        guard let name = command["app"] as? String, let slot = (command["slot"] as? [NSNumber])?.map(\.doubleValue), slot.count == 4,
              AXIsProcessTrusted(), !IsSecureEventInputEnabled(), let app = ScreenTarget(["app": name])?.running,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier, !lookPrivate(app.localizedName, app.bundleIdentifier, command["private"]) else { return }
        // Set 2 R5: the room of the display the window is on, read here on the main thread for every display.
        let screens = NSScreen.screens.map(\.frame)
        let rooms = NSScreen.screens.map { stageFrame($0) }
        let part = command["window"] as? String
        let pid = app.processIdentifier
        queue.async {
            let root = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(root, 0.5)
            let all = part == nil ? [] : self.windows(root)
            let named = part.map { part in lookWindowMatch(all.map(\.title), part).map { all[$0].element } }
            guard let window = named ?? axElement(axValue(root, kAXFocusedWindowAttribute)) ?? axElement(axValue(root, kAXMainWindowAttribute)),
                  screenRefusal(window) == nil, axValue(window, "AXFullScreen") as? Bool != true, axValue(window, kAXMinimizedAttribute) as? Bool != true, let was = axFrame(window) else { return }
            let free = lookScreenIndex(CGPoint(x: was.midX, y: was.midY), screens).map { rooms[$0] } ?? rooms.first ?? .zero
            let to = CGRect(x: free.minX + slot[0] * free.width, y: free.minY + slot[1] * free.height, width: slot[2] * free.width, height: slot[3] * free.height).integral
            // Kept even when it already sits there: its look then says it is on the stage, and Node keeps its slot.
            if !self.staged.contains(where: { CFEqual($0.window, window) }) { self.staged.append((name, window, was)) }
            guard abs(was.minX - to.minX) + abs(was.minY - to.minY) + abs(was.width - to.width) + abs(was.height - to.height) >= 2 else { return }
            axSetFrame(window, to)
            // ponytail: a fixed 0.2 s for the app to lay out again before a look walks it.
            Thread.sleep(forTimeInterval: 0.2)
        }
    }

    /// The screen stage: every placed window of `app` (no app: every one) back to its frame from before. `wait`: before the app quits.
    func unplace(_ command: [String: Any], wait: Bool = false) {
        let name = command["app"] as? String
        let back = {
            for s in self.staged where name == nil || s.app == name { axSetFrame(s.window, s.was) }
            self.staged.removeAll { name == nil || $0.app == name }
        }
        wait ? queue.sync(execute: back) : queue.async(execute: back)
    }

    /// B1. `app` missing = the app in front, never Sundial. A look reads; it does not bring the app forward.
    func look(_ command: [String: Any]) {
        guard let id = command["id"] as? String else { return }
        let name = command["app"] as? String
        let app = name == nil ? frontApp() : ScreenTarget(["app": name ?? ""])?.running
        run(id, app, window: (command["window"] as? String).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }, max: min(max(command["max"] as? Int ?? 400, 1), 1000), ocr: command["ocr"] as? Bool == true, after: nil,
            hidden: command["private"], LookTune(command["tune"]), query: lookQuery(command["query"] as? String))
    }

    /// B4. The look that follows a performed act, under its own id, with the act's privacy list and tune.
    /// `since`: when the act's step began.
    func look(after act: String, pid: pid_t, since: Date, hidden: Any?, _ tune: LookTune) {
        run("look-" + String(format: "%08x", UInt32.random(in: 0 ... UInt32.max)), NSRunningApplication(processIdentifier: pid), window: nil, max: 400, ocr: kept[pid]?.ocr ?? false, after: act,
            hidden: hidden, tune, since: since)
    }

    /// The app of a look.
    func app(of look: String?) -> NSRunningApplication? {
        kept.first { $0.value.ids.contains(look ?? "") }.flatMap { NSRunningApplication(processIdentifier: $0.key) }
    }

    private func frontApp() -> NSRunningApplication? {
        let own = ProcessInfo.processInfo.processIdentifier
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != own { return front }
        // Sundial's own window is in front: the app whose window lies just under it.
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for window in windows where window[kCGWindowLayer as String] as? Int == 0 {
            guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid != own,
                  let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { continue }
            return app
        }
        return nil
    }

    private func run(_ id: String, _ app: NSRunningApplication?, window part: String?, max: Int, ocr: Bool, after: String?, hidden: Any?, _ tune: LookTune, query: [String] = [], since: Date? = nil) {
        var base: [String: Any] = ["id": id]
        if let after { base["after"] = after }
        let refuse = { (reason: String, base: [String: Any]) in self.channel.emit("screen:looked", base.merging(["refused": reason]) { _, new in new }) }
        if IsSecureEventInputEnabled() { return refuse("secure-input", base) }
        guard AXIsProcessTrusted() else { return refuse("no-access", base) }
        // Doc 32 item 3: the app's live process, not the one NSWorkspace still keeps after it quit (`liveApp`).
        guard let app = app.map(liveApp), !app.isTerminated, kill(app.processIdentifier, 0) == 0, app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return refuse("not-running", base) }
        let pid = app.processIdentifier
        base["app"] = app.localizedName ?? ""
        base["bundleId"] = app.bundleIdentifier ?? ""
        // The owner's privacy list: nothing of this app is read, and what an older look kept goes.
        if lookPrivate(app.localizedName, app.bundleIdentifier, hidden) {
            kept[pid] = nil
            queue.async { self.labels[pid] = nil }
            return refuse("private-app", base)
        }
        let line = base
        let before = kept[pid]?.window
        let go = { self.queue.async {
            // B4: the screen settles first.
            if after != nil { self.settle(pid, since: since ?? Date(), tune.settle, quiet: tune.quiet) }
            // Asked for by name, the OCR gets a quarter of the room.
            var seen = self.walk(pid, part, ocr ? max - max / 4 : max, before: before, after: after != nil, tune, query: query)
            // Run 21: Spotify (CEF) gave 4 parts on every first look until a focus step. A big window with almost nothing in it
            // is a tree not built yet: both switches on, a moment, and the walk again, once per app run.
            if seen.refused == nil, seen.window != nil, seen.items.count < 8, seen.frame.width * seen.frame.height > 400 * 300, self.rewoken.insert(pid).inserted {
                let root = AXUIElementCreateApplication(pid)
                AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
                AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
                Thread.sleep(forTimeInterval: 0.6)
                let again = self.walk(pid, part, ocr ? max - max / 4 : max, before: before, after: after != nil, tune, query: query)
                if again.items.count > seen.items.count { seen = again }
            }
            // Doc 32 item 3: an app still starting has no window yet: up to 2 s more, a walk each half second.
            for _ in 0..<4 where seen.refused == "no-window" && lookStarting(finished: app.isFinishedLaunching, launched: app.launchDate, now: Date()) {
                Thread.sleep(forTimeInterval: 0.5)
                seen = self.walk(pid, part, ocr ? max - max / 4 : max, before: before, after: after != nil, tune, query: query)
            }
            // A probe for the next time no window comes (run 258 T19 gave 24 and no cause): the process, whether LaunchServices
            // knows it, how long it has run, and the windows Accessibility gave.
            let probe: [String: Any] = seen.refused == "no-window" ? ["probe": ["pid": Int(pid), "known": NSRunningApplication(processIdentifier: pid) != nil,
                "finished": app.isFinishedLaunching, "age": app.launchDate.map { Int(Date().timeIntervalSince($0)) } ?? -1, "axWindows": seen.windows.count]] : [:]
            guard seen.refused == nil, seen.window != nil else {
                let windows = seen.refused == "no-such-window" ? ["windows": seen.windows] : probe
                return DispatchQueue.main.async { refuse(seen.refused ?? "no-window", line.merging(windows) { _, new in new }) }
            }
            // A thin tree (`tune.thin`, a guess until the bench says otherwise) is read as a picture too.
            let thin = lookThin(seen.items.count, areaChars: seen.area, tune.thin)
            let text = { (line: [String: Any]) in
                guard ocr || thin else { return self.finish(line, pid, seen, nil, nil, ocr, max, tune) }
                guard CGPreflightScreenCaptureAccess() else { return self.finish(line, pid, seen, nil, "no grant", ocr, max, tune) }
                self.read(pid, seen.frame, tune.languages) { lines in self.finish(line, pid, seen, lines, lines == nil ? "failed" : nil, ocr, max, tune) }
            }
            // 27 section 3 item 9, the hook only: experiments.windowCapture (off unless true) keeps a thin tree's window as a picture.
            guard thin, windowCaptureOn, CGPreflightScreenCaptureAccess() else { return text(line) }
            self.capture(pid, seen.frame, id) { name in text(name.map { name in line.merging(["capture": name]) { _, new in new } } ?? line) }
        } }
        // A window asked for by name comes in front first; no such window is a no, with the windows there are.
        guard let part else { return go() }
        raise(app, part) { reason, windows in
            guard let reason else { return go() }
            refuse(reason, windows.isEmpty ? line : line.merging(["windows": windows]) { _, new in new })
        }
    }

    /// Look queue. Refs are given here; the map from ref to element goes to the main thread with the event.
    private func finish(_ line: [String: Any], _ pid: pid_t, _ seen: Seen, _ lines: [(text: String, box: CGRect)]?, _ note: String?, _ ocr: Bool, _ max: Int, _ tune: LookTune) {
        guard let window = seen.window else { return }
        // A new app run (a new pid) starts its labels again; those of apps gone are dropped.
        if labels[pid] == nil {
            labels = labels.filter { kill($0.key, 0) == 0 }
            labels[pid] = (String(format: "%06x", UInt32.random(in: 0 ... 0xFF_FFFF)), LookLabels())
        }
        let ids = labels[pid]!.book.give(seen.items.map { (element: $0.element, hash: Int(bitPattern: CFHash($0.element)), role: $0.json["role"] as? String ?? "",
                                                        label: $0.json["label"] as? String ?? "", place: ($0.json["in"] as? String ?? "") + "\n" + seen.title) }, cut: seen.truncated, same: { CFEqual($0, $1) })
        var refs: [String: Ref] = [:]
        for (n, e) in labels[pid]!.book.all { refs["e\(n)"] = (e.element, nil, e.role, e.label) }
        var elements: [[String: Any]] = []
        var focused: String?
        var truncated = seen.truncated
        for (n, item) in seen.items.enumerated() {
            let ref = "e\(ids[n])"
            var json = item.json.merging(["ref": ref]) { _, new in new }
            // The caret's line is a ref of its own (c7 for e7's), held as a line of text is: in this look, while the window keeps its size.
            if var caret = json["caret"] as? [String: Any], let f = caret["frame"] as? [Int], f.count == 4 {
                caret["ref"] = "c\(ids[n])"
                json["caret"] = caret
                refs["c\(ids[n])"] = (window, CGRect(x: f[0], y: f[1], width: f[2], height: f[3]).offsetBy(dx: -seen.frame.minX, dy: -seen.frame.minY), "text", "line \(caret["line"] as? Int ?? 0)")
            }
            elements.append(json)
            if focused == nil, let element = seen.focused, CFEqual(element, item.element) { focused = ref }
        }
        var n = 0
        for text in lines ?? [] {
            // Skipped where an AX element with the same words already covers the box.
            let words = text.text.lowercased()
            let centre = CGPoint(x: text.box.midX, y: text.box.midY)
            if seen.items.contains(where: { $0.frame.insetBy(dx: -4, dy: -4).contains(centre) && $0.words.contains(words) }) { continue }
            if elements.count >= max { truncated = true; break }
            n += 1
            refs["t\(n)"] = (window, text.box.offsetBy(dx: -seen.frame.minX, dy: -seen.frame.minY), "text", text.text)
            elements.append(["ref": "t\(n)", "role": "text", "sub": "", "label": text.text, "value": "", "frame": ints(text.box), "actions": [String](), "settable": false, "enabled": true, "in": "ocr"])
        }
        // One line of the event file stays under about 100 KB; what goes first is what a cut drops first.
        var ranks = seen.items.map(\.rank) + Array(repeating: 1, count: elements.count - seen.items.count)
        while elements.count > 1, ((try? JSONSerialization.data(withJSONObject: elements))?.count ?? 0) > tune.cap {
            let keep = lookKeep(ranks, elements.count - elements.count / 4 - 1)
            elements = keep.map { elements[$0] }
            ranks = keep.map { ranks[$0] }
            truncated = true
        }
        var event = line
        event["tag"] = labels[pid]!.tag
        event["window"] = seen.title
        event["frame"] = ints(seen.frame)
        event["menus"] = seen.menus
        event["windows"] = seen.windows
        event["source"] = lines == nil ? "ax" : "ax+ocr"
        event["truncated"] = truncated
        if !seen.front { event["front"] = false }
        if seen.dialog { event["dialog"] = true }
        event["elements"] = elements
        if let focused { event["focused"] = focused }
        if let button = lookDefaultButton(elements) { event["defaultButton"] = button }
        if let note { event["ocr"] = note }
        if staged.contains(where: { CFEqual($0.window, window) }) { event["staged"] = true }
        DispatchQueue.main.async {
            let id = line["id"] as? String ?? ""
            self.kept[pid] = (id, Date(), window, seen.frame.size, ocr, refs, Array(((self.kept[pid]?.ids ?? []) + [id]).suffix(20)))
            event["screen"] = screenMap(around: CGPoint(x: seen.frame.midX, y: seen.frame.midY))
            self.channel.emit("screen:looked", event)
        }
    }

    /// Any queue but main. B4: until the app's AX notifications have been quiet for `quiet` s (tune.quiet, 0.1) since `since`
    /// (at least 0.06 s, at most `cap`). An app not heard gets the whole `cap`. No notification at all is not "unchanged": the look still walks.
    func settle(_ pid: pid_t, since: Date, _ cap: TimeInterval, quiet: TimeInterval = 0.1) {
        guard axStamps.last(pid) != nil else { return Thread.sleep(forTimeInterval: cap) }
        let start = Date()
        while Date().timeIntervalSince(start) < cap {
            // Shorter only once the app has spoken since the act and then gone quiet: silence before it reacts is not done.
            if lookQuiet(last: axStamps.last(pid), since: since, start: start, now: Date(), quiet: quiet) { return }
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    /// Look queue. One window of one app: what shows in it and has something to say or do.
    private func walk(_ pid: pid_t, _ part: String?, _ max: Int, before: AXUIElement?, after: Bool, _ tune: LookTune, query: [String] = []) -> Seen {
        var seen = Seen()
        // Past `max` the walk goes on (1500 parts at most, list rows skipped) for what was asked for, an open menu's items and the
        // window's edges: the best 60 asked for are listed first, and the cut keeps a player bar over the rows of a long list.
        var first: [(item: Part, score: Int, at: Int)] = []
        var cutAt: Int?
        let root = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(root, 0.25)
        // Chromium and Electron build their tree only when asked, and take a moment.
        if woken.insert(pid).inserted, let manual = axWake(pid) { Thread.sleep(forTimeInterval: manual ? 0.3 : tune.wake) }
        let pick = { () -> AXUIElement? in
            let windows = self.windows(root)
            seen.windows = lookWindows(windows.map { ($0.title, $0.main, $0.minimized) })
            // A window asked for by name is that window or none, never the front one instead.
            if let part { return lookWindowMatch(windows.map(\.title), part).map { windows[$0].element } }
            return axElement(axValue(root, kAXFocusedWindowAttribute)) ?? axElement(axValue(root, kAXMainWindowAttribute)) ?? windows.first?.element
        }
        var picked = pick()
        // B4: no window yet, or another one than before the act: it gets a little longer to draw.
        if after, picked.map({ now in before.map { !CFEqual($0, now) } ?? false }) ?? true {
            Thread.sleep(forTimeInterval: tune.settleNew)
            picked = pick()
        }
        if let picked { AXUIElementSetMessagingTimeout(picked, 0.25) }
        guard let window = picked else { seen.refused = !axResponds(pid) ? "not-responding" : part == nil ? "no-window" : "no-such-window"; return seen }
        guard let frame = axFrame(window) else { seen.refused = "no-window"; return seen }
        if let refusal = screenRefusal(window) { seen.refused = refusal; return seen }
        seen.window = window
        seen.frame = frame
        seen.title = lookCut(axText(window, kAXTitleAttribute), 120)
        seen.focused = axElement(axValue(root, kAXFocusedUIElementAttribute))

        // Depth first, so the list reads in the window's own order. `named`: the nearest ancestor with a name;
        // `kind`: the nearest that is more than a plain group, as the app describes it ("toolbar").
        var stack: [(element: AXUIElement, named: String, kind: String, clip: CGRect, top: Bool, row: Bool)] = [(window, "", "", frame.insetBy(dx: -2, dy: -2), true, false)]
        let bar = axElement(axValue(root, kAXMenuBarAttribute)).map { axList(axValue($0, kAXChildrenAttribute)) } ?? []
        for item in bar.dropFirst() {
            guard let a = axMany(item, [kAXTitleAttribute, kAXSelectedAttribute, kAXChildrenAttribute]), let title = a[0] as? String, !title.isEmpty else { continue }
            seen.menus.append(lookCut(title, 40))
            // An open menu shows, though it hangs outside the window.
            if a[1] as? Bool == true { stack.append(contentsOf: axList(a[2]).reversed().map { ($0, lookCut(title, 40), "", CGRect.infinite, false, false) }) }
        }
        // A context menu hangs under the app itself.
        for child in axList(axValue(root, kAXChildrenAttribute)) where axText(child, kAXRoleAttribute) == kAXMenuRole { stack.append((child, "", "", CGRect.infinite, false, false)) }
        // An open dialog that holds the keyboard (a web app's compose window, a sheet) is read first: it often sits past the cut.
        let dialog = lookDialog(seen.focused)
        var dialogRead = false
        if let dialog { stack.append((dialog, "", "dialog", frame.insetBy(dx: -2, dy: -2), false, false)) }
        seen.dialog = dialog != nil
        // S5R1: a sheet or dialog that holds the keyboard has its own default button; the window's is not pressed behind it.
        seen.defaultButton = axElement(axValue(dialog ?? window, kAXDefaultButtonAttribute))
        seen.cancelButton = axElement(axValue(dialog ?? window, kAXCancelButtonAttribute))
        seen.front = axInFront(root, window)
        // L3: the text area with the keyboard is read first, so another one never takes its share.
        var areaFirst: (element: AXUIElement, read: (text: String, total: Int, cut: Bool, folded: Bool))?
        if let focus = seen.focused, axText(focus, kAXRoleAttribute) == kAXTextAreaRole as String, axText(focus, kAXSubroleAttribute) != kAXSecureTextFieldSubrole as String,
           let read = axAreaText(focus, tune.area, whole: axValue(focus, kAXValueAttribute) as? String) {
            areaFirst = (focus, read)
            seen.area += read.text.count
        }
        let deadline = Date().addingTimeInterval(tune.deadline)
        let lists: Set<String> = [kAXRowRole, kAXListRole, kAXTableRole, kAXOutlineRole]
        var visited = 0
        while let node = stack.popLast() {
            // Past the cut the walk looks further, 1500 parts for a query, 300 for the window's edges (each a round trip), and a list row there could only push out another row.
            if let cutAt, visited - cutAt > lookOverrun(query) { seen.truncated = true; break }
            if visited >= tune.visited || Date() > deadline { seen.truncated = true; break }
            if cutAt != nil, node.row, query.isEmpty { continue }
            visited += 1
            // The dialog was read first; met again in the window's own order, it is passed over.
            if let dialog, CFEqual(node.element, dialog) { if dialogRead { continue }; dialogRead = true }
            // The timeout is the element's own: a hung app costs a quarter second, not six.
            AXUIElementSetMessagingTimeout(node.element, 0.25)
            guard let a = axMany(node.element, lookNames) else { continue }
            let role = a[0] as? String ?? ""
            let frame = axRect(a[7], a[8])
            // A real frame wholly off the clip: nothing under it shows either.
            // ponytail: a long list still costs one round trip a row; the budget cuts it, `truncated` says so.
            if !node.top, let frame, !frame.intersects(node.clip) { continue }
            // A table or a list names the rows that show: the thousands above and below are never asked.
            // ponytail: with them go the table's header and its columns (the same cells a second time).
            let kids = self.kids(a)
            let name = lookLabel([a[2] as? String, a[3] as? String])
            if !node.top, let frame, node.clip.contains(CGPoint(x: frame.midX, y: frame.midY)) {
                let actions = axActions(node.element)
                var can: DarwinBoolean = false
                let settable = AXUIElementIsAttributeSettable(node.element, kAXValueAttribute as CFString, &can) == .success && can.boolValue
                let sub = a[1] as? String ?? ""
                // A secure field never gives its value. S4: a text area (Terminal's screen, TextEdit's page) gives its words by range, bounded.
                // L3: the focused text area was read first (`areaFirst`); the others share what is left.
                let early = areaFirst.flatMap { CFEqual($0.element, node.element) ? $0.read : nil }
                let room = tune.area - seen.area
                let read = early ?? (role == kAXTextAreaRole as String && sub != kAXSecureTextFieldSubrole as String && room > 0 ? axAreaText(node.element, room, whole: a[4] as? String) : nil)
                let value = sub == kAXSecureTextFieldSubrole ? "" : read?.text ?? lookCut((a[4] as? String) ?? (a[4] as? NSNumber)?.stringValue, 200)
                if early == nil { seen.area += read?.text.count ?? 0 }
                let label = self.label(a, kids, !actions.isEmpty)
                // Something to say, or something to do on a thing with nothing under it. A mute wrapper is passed over, its children are not.
                // A nameless clickable leaf (an icon drawn as a background) stays: it is pressable by ref.
                if let part = lookPart(role: role, label: label, value: value, actions: actions, settable: settable) ?? (kids.isEmpty && actions.contains(kAXPressAction as String) ? (["AXPress"], false) : nil),
                   !label.isEmpty || !value.isEmpty || part.settable || (!actions.isEmpty && kids.isEmpty) {
                    var json: [String: Any] = ["role": role, "sub": sub, "label": label, "value": value, "frame": ints(frame), "actions": part.actions, "settable": part.settable,
                                               "enabled": a[9] as? Bool ?? true, "in": node.named.isEmpty ? node.kind : node.named]
                    json.merge(entry(node.element, role, a)) { _, new in new }
                    // Runs 42, 50, 57: no menu item showed its check mark, so which view or sort was on could not be told.
                    if role == kAXMenuItemRole, (a[14] as? String)?.isEmpty == false { json["checked"] = true }
                    // The item's own key, so a step can press it instead of walking the menu.
                    if role == kAXMenuItemRole, let keys = lookShortcut(a[15] as? String, (a[16] as? NSNumber)?.intValue) { json["keys"] = keys }
                    // Runs 42, 50, 57: a submenu parent looked like a leaf until open, and a press on one froze Finder.
                    if role == kAXMenuItemRole, let kid = kids.first {
                        AXUIElementSetMessagingTimeout(kid, 0.25)
                        if axText(kid, kAXRoleAttribute) == kAXMenuRole { json["submenu"] = true }
                    }
                    if let caret = axCaret(node.element, role: role, sub: sub, box: frame) { json["caret"] = caret }
                    // M4: a text area read in part: its whole length, so a set-value never replaces what was not read. Spacing folded alone is no cut.
                    json.merge(lookReadMarks(read)) { _, new in new }
                    // Run 126: a cut at 400 dropped Spotify's player bar. Rows deep in a list go first, the window's top and bottom last.
                    let rank = node.row || lists.contains(role) ? 2 : frame.minY < seen.frame.minY + 120 || frame.maxY > seen.frame.maxY - 120 ? 0 : 1
                    let item: Part = (json, node.element, frame, (label + "\n" + value).lowercased(), rank)
                    let score = lookScore(role, item.words, query)
                    if score > 0, first.count < 400 { first.append((item, score, visited)) }
                    else { seen.items.append(item); if seen.items.count > max { cutAt = cutAt ?? visited } }
                }
            }
            let named = node.top || name.isEmpty ? node.named : lookCut(name, 40)
            let kind = node.top || role.isEmpty || role == kAXGroupRole || role == kAXUnknownRole ? node.kind : lookCut(a[11] as? String, 40)
            // A scroll area hides what it scrolled away; an open menu or a popover may hang outside the window.
            let clip = role == kAXMenuRole || role == kAXPopoverRole ? CGRect.infinite : role == kAXScrollAreaRole ? frame.map { node.clip.intersection($0) } ?? node.clip : node.clip
            // Finder's list view: the column headers (Name, Size) sort, and the visible rows alone never reached them (198 looks).
            let header = role == kAXOutlineRole || role == kAXTableRole ? axElement(axValue(node.element, kAXHeaderAttribute)) : nil
            let row = node.row || lists.contains(role)
            for kid in ([header].compactMap { $0 } + kids).reversed() { stack.append((kid, named, kind, clip, false, row)) }
        }
        if seen.items.count > max {
            seen.truncated = true
            seen.items = lookKeep(seen.items.map(\.rank), max).map { seen.items[$0] }
        }
        // Best first, and in the window's own order where they tie: sorting in Swift is not stable by itself. Asked for: never cut by bytes first.
        seen.items = first.sorted { $0.score != $1.score ? $0.score > $1.score : $0.at < $1.at }.prefix(60).map { var p = $0.item; p.rank = -1; return p } + seen.items
        // Run 198: an in-place editor (Finder's rename box, a table cell's field) has the keyboard but is no visible row or child
        // of its list, so the walk never met it and the look's focus named no part. It goes first, marked, never cut.
        if let focus = seen.focused, !CFEqual(focus, window), !seen.items.contains(where: { CFEqual($0.element, focus) }), let part = focusedPart(focus, window, seen.frame, room: tune.area - seen.area) { seen.items.insert(part, at: 0) }
        // S5R1: the default and cancel buttons are marked and never cut: the gate reads what a Return in a native field presses.
        // One the walk never met (past the cut, the clock) is read as the focused part is.
        for (mark, button) in [("default", seen.defaultButton), ("cancel", seen.cancelButton)] {
            guard let button else { continue }
            if let i = seen.items.firstIndex(where: { CFEqual($0.element, button) }) { seen.items[i].json[mark] = true; seen.items[i].rank = -1 }
            else if var part = focusedPart(button, window, seen.frame, room: 0, owned: true) { part.json[mark] = true; seen.items.append(part) }
        }
        return seen
    }

    /// S5R1: lookEntry of a part, asking a group or a web area (only) whether it is editable: AXEditable, or it is its own
    /// AXEditableAncestor (a contenteditable root). One more round trip, for the few groups that say or do something.
    private func entry(_ element: AXUIElement, _ role: String, _ a: [CFTypeRef?]) -> [String: Any] {
        guard role == kAXGroupRole || role == kAXUnknownRole || role == "AXWebArea" else { return [:] }
        let e = axMany(element, ["AXEditable", "AXEditableAncestor"])
        let editable = (e?[0] as? Bool) == true || axElement(e?[1] ?? nil).map { CFEqual($0, element) } == true
        return lookEntry(role: role, roleDescription: a[11] as? String, editable: editable)
    }

    /// Look queue. The focused element as a part of `window`, read as the walk reads one (a secure field gives no value, a text area
    /// its words by range, at most `room` characters but never fewer than 200, with the walk's marks); nil when it lies outside the
    /// window or has nothing to say or do. `owned`: the window or its sheet named it (its default button), so it is the window's own and not focused.
    private func focusedPart(_ element: AXUIElement, _ window: AXUIElement, _ frame: CGRect, room: Int, owned: Bool = false) -> Part? {
        AXUIElementSetMessagingTimeout(element, 0.25)
        guard let a = axMany(element, lookNames), let box = axRect(a[7], a[8]),
              lookFocusInside(box, window: frame, sameWindow: owned ? true : axElement(axValue(element, kAXWindowAttribute)).map { CFEqual($0, window) }) else { return nil }
        let role = a[0] as? String ?? ""
        let sub = a[1] as? String ?? ""
        let actions = axActions(element)
        var can: DarwinBoolean = false
        let settable = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &can) == .success && can.boolValue
        let read = role == kAXTextAreaRole as String && sub != kAXSecureTextFieldSubrole as String ? axAreaText(element, max(room, 200), whole: a[4] as? String) : nil
        let value = sub == kAXSecureTextFieldSubrole ? "" : read?.text ?? lookCut((a[4] as? String) ?? (a[4] as? NSNumber)?.stringValue, 200)
        let label = self.label(a, kids(a), !actions.isEmpty)
        guard let part = lookPart(role: role, label: label, value: value, actions: actions, settable: settable),
              !label.isEmpty || !value.isEmpty || part.settable || !part.actions.isEmpty else { return nil }
        // Its place: the parent's name ("icon view"), as the walk names a part's place.
        let parent = axElement(axValue(element, kAXParentAttribute)).flatMap { p -> String? in
            AXUIElementSetMessagingTimeout(p, 0.25)
            return axMany(p, lookNames).map { lookLabel([$0[2] as? String, $0[3] as? String, $0[11] as? String]) }
        } ?? ""
        var json: [String: Any] = ["role": role, "sub": sub, "label": label, "value": value, "frame": ints(box), "actions": part.actions, "settable": part.settable,
                                   "enabled": a[9] as? Bool ?? true, "in": lookCut(parent, 40)]
        json.merge(entry(element, role, a)) { _, new in new }
        if !owned { json["focused"] = true }
        json.merge(lookReadMarks(read)) { _, new in new }
        if let caret = axCaret(element, role: role, sub: sub, box: box) { json["caret"] = caret }
        return (json, element, box, (label + "\n" + value).lowercased(), -1)
    }

    /// Look queue. The app's windows, front to back, each with its title and whether it is main or minimized.
    private func windows(_ root: AXUIElement) -> [(element: AXUIElement, title: String?, main: Bool, minimized: Bool)] {
        axList(axValue(root, kAXWindowsAttribute)).prefix(40).map { window in
            AXUIElementSetMessagingTimeout(window, 0.25)
            let a = axMany(window, [kAXTitleAttribute, kAXMainAttribute, kAXMinimizedAttribute])
            return (window, a?[0] as? String, a?[1] as? Bool ?? false, a?[2] as? Bool ?? false)
        }
    }

    /// The app's window whose title holds `part`, brought in front: its app activated, then the window un-minimized,
    /// raised and made main. One already in front of its app is left as it is. `done` runs on the main thread with
    /// nil, or the reason (`no-such-window` with the app's windows, `cannot-raise`).
    func raise(_ app: NSRunningApplication, _ part: String, _ done: @escaping (String?, [[String: Any]]) -> Void) {
        guard AXIsProcessTrusted() else { return done("no-access", []) }
        let pid = app.processIdentifier
        queue.async {
            let root = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(root, 0.5)
            let all = self.windows(root)
            guard let n = lookWindowMatch(all.map(\.title), part) else {
                let list = lookWindows(all.map { ($0.title, $0.main, $0.minimized) })
                return DispatchQueue.main.async { done("no-such-window", list) }
            }
            let window = all[n].element
            if axInFront(root, window) { return DispatchQueue.main.async { done(nil, []) } }
            DispatchQueue.main.async {
                self.front(app) {
                    self.queue.async {
                        AXUIElementSetMessagingTimeout(window, 1)
                        if all[n].minimized { AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
                        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                        // ponytail: a fixed 0.3 s for the window server; a window slower than that reads as not raised.
                        Thread.sleep(forTimeInterval: 0.3)
                        let ok = axInFront(root, window)
                        DispatchQueue.main.async { done(ok ? nil : "cannot-raise", []) }
                    }
                }
            }
        }
    }

    /// The children that show, of an element read with `lookNames`.
    private func kids(_ a: [CFTypeRef?]) -> [AXUIElement] {
        [a[12], a[13], a[10]].lazy.map(axList).first { !$0.isEmpty } ?? []
    }

    /// A thing's words: its own name, else (a row, a web button) its first static texts, else its placeholder or help.
    private func label(_ a: [CFTypeRef?], _ kids: [AXUIElement], _ acts: Bool) -> String {
        var label = lookLabel([a[2] as? String, a[3] as? String])
        if label.isEmpty, acts, !kids.isEmpty { label = childText(kids) }
        return label.isEmpty ? lookLabel([a[5] as? String, a[6] as? String]) : label
    }

    /// Look queue. A thing's role and words now, read as a look reads them; nil when it does not answer.
    private func identity(_ element: AXUIElement) -> (role: String, label: String)? {
        AXUIElementSetMessagingTimeout(element, 0.5)
        guard let a = axMany(element, lookNames) else { return nil }
        return (a[0] as? String ?? "", label(a, kids(a), !axActions(element).isEmpty))
    }

    /// The words of a control whose name sits in its children (a row, a web button): its first static texts.
    private func childText(_ kids: [AXUIElement]) -> String {
        var queue = kids.map { ($0, 1) }
        var texts: [String] = []
        var seen = 0
        while !queue.isEmpty, seen < 12, texts.count < 4 {
            let (kid, depth) = queue.removeFirst()
            seen += 1
            AXUIElementSetMessagingTimeout(kid, 0.25)
            guard let a = axMany(kid, [kAXRoleAttribute, kAXValueAttribute, kAXTitleAttribute, kAXChildrenAttribute]) else { continue }
            let text = a[0] as? String == kAXStaticTextRole ? lookCut((a[1] as? String) ?? (a[2] as? String), 120) : ""
            if !text.isEmpty { texts.append(text) } else if depth < 3 { queue.append(contentsOf: axList(a[3]).map { ($0, depth + 1) }) }
        }
        return lookCut(texts.joined(separator: ", "), 120)
    }

    // MARK: Local OCR

    /// The target app's own pixels, read on this Mac by Apple Vision and dropped: only lines of text and their
    /// boxes (screen points) leave this function. Nothing is written to disk. `done` runs once, on the look queue.
    private func read(_ pid: pid_t, _ window: CGRect, _ languages: [String], _ done: @escaping ([(text: String, box: CGRect)]?) -> Void) {
        let once = Once()
        let finish = { (lines: [(text: String, box: CGRect)]?) in
            self.queue.async {
                guard !once.done else { return }
                once.done = true
                done(lines)
            }
        }
        // The capture service can stall and a text read can run long: the look answers without them.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.5) { finish(nil) }
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
            let area = { (display: SCDisplay) -> CGFloat in
                let shared = CGDisplayBounds(display.displayID).intersection(window)
                return shared.isNull ? 0 : shared.width * shared.height
            }
            guard let content, let app = content.applications.first(where: { $0.processID == pid }),
                  let display = content.displays.max(by: { area($0) < area($1) }) else { return finish(nil) }
            // CG display bounds are points from the top left of the main display, as AX frames are.
            let bounds = CGDisplayBounds(display.displayID)
            let crop = bounds.intersection(window)
            // Only this app's windows are in the picture, never another app's.
            // ponytail: another window of the same app over this one is read too.
            let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
            let scale = CGFloat(filter.pointPixelScale)
            guard !crop.isNull, crop.width >= 8, crop.height >= 8, scale > 0 else { return finish(nil) }
            let config = SCStreamConfiguration()
            config.width = Int(bounds.width * scale)
            config.height = Int(bounds.height * scale)
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
                self.text.async {
                    // Cut by hand: a CGImage counts its pixels from the top left, whatever the capture's own rect means.
                    guard let image, bounds.width > 0 else { return finish(nil) }
                    let k = CGFloat(image.width) / bounds.width
                    let pixels = CGRect(x: (crop.minX - bounds.minX) * k, y: (crop.minY - bounds.minY) * k, width: crop.width * k, height: crop.height * k).integral
                    guard k > 0, let cut = image.cropping(to: pixels) else { return finish(nil) }
                    let shown = CGRect(x: bounds.minX + max(pixels.minX, 0) / k, y: bounds.minY + max(pixels.minY, 0) / k, width: CGFloat(cut.width) / k, height: CGFloat(cut.height) / k)
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    request.usesLanguageCorrection = true
                    // Only languages this Mac reads: one it does not know fails the whole read.
                    let known = (try? request.supportedRecognitionLanguages()) ?? languages
                    let asked = languages.filter(known.contains)
                    if !asked.isEmpty { request.recognitionLanguages = asked }
                    guard (try? VNImageRequestHandler(cgImage: cut, options: [:]).perform([request])) != nil else { return finish(nil) }
                    finish((request.results ?? []).compactMap { line in
                        let text = lookCut(line.topCandidates(1).first?.string, 120)
                        return text.isEmpty ? nil : (text, lookBox(line.boundingBox, in: shown))
                    })
                }
            }
        }
    }

    /// Behind experiments.windowCapture, off by default: one window of `pid` (the one that best covers `frame`), by its window id,
    /// as a PNG in .daemon/captures (0600), the newest 3 kept. `done` gets the file's name, never read here: no OCR, no vision.
    /// A grounding fallback for an app with no Accessibility tree reads it later. `done` runs once, on the look queue.
    private func capture(_ pid: pid_t, _ frame: CGRect, _ id: String, _ done: @escaping (String?) -> Void) {
        let once = Once()
        let finish = { (name: String?) in self.queue.async { guard !once.done else { return }; once.done = true; done(name) } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { finish(nil) }
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
            let cover = { (w: SCWindow) -> CGFloat in let shared = w.frame.intersection(frame); return shared.isNull ? 0 : shared.width * shared.height }
            guard let window = content?.windows.filter({ $0.owningApplication?.processID == pid && cover($0) > 0 }).max(by: { cover($0) < cover($1) }) else { return finish(nil) }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width * CGFloat(filter.pointPixelScale))
            config.height = Int(window.frame.height * CGFloat(filter.pointPixelScale))
            config.showsCursor = false
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, _ in
                guard let image, let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return finish(nil) }
                let dir = daemonDir.appendingPathComponent("captures")
                try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let name = "\(id.filter { $0.isLetter || $0.isNumber || $0 == "-" }.prefix(40)).png"
                guard FileManager.default.createFile(atPath: dir.appendingPathComponent(name).path, contents: png, attributes: [.posixPermissions: 0o600]) else { return finish(nil) }
                let old = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
                    .filter { $0.pathExtension == "png" }
                    .sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
                for file in old.dropFirst(3) { try? FileManager.default.removeItem(at: file) }
                finish(name)
            }
        }
    }

    // MARK: Refs

    /// What a ref of a look stands for now; no ref = the look's window. nil = look again: the look is not one of its
    /// app run's last 20, the ref is unknown, or the element is gone. `done` runs on the main thread.
    /// `front`: for an act, the look's window must still be its app's front window, or a click would land on another window over it.
    func resolve(_ look: String?, _ ref: String?, ttl: TimeInterval = 30, front: Bool = false, _ done: @escaping (Hit?) -> Void) {
        guard let (pid, entry) = kept.first(where: { $0.value.ids.contains(look ?? "") }), let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return done(nil) }
        // A label holds in any look of its app run; a line of text, or a caret's line, only in the newest.
        let item: Ref? = ref == nil ? (entry.window, nil, "", "") : (ref?.hasPrefix("t") == true || ref?.hasPrefix("c") == true) && entry.id != look ? nil : entry.refs[ref ?? ""]
        guard let item else { return done(nil) }
        let age = Date().timeIntervalSince(entry.at)
        queue.async {
            // A cached element is never trusted: its role and words are read again (a list hands a row to other
            // content), and its frame. A line of text holds for `ttl` seconds, and only while its window keeps its size.
            let root = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(root, 0.5)
            // A label may be of another window of the app than the newest look's: the front check asks the thing's own window.
            let own = ref == nil || item.offset != nil ? entry.window : axElement(axValue(item.element, kAXWindowAttribute)) ?? entry.window
            // A thing in a sheet: its AXWindow is the sheet's parent, its top level the sheet, which is what the app has in front.
            let top = ref == nil || item.offset != nil ? nil : axElement(axValue(item.element, kAXTopLevelUIElementAttribute))
            let holds = (!front || axInFront(root, own, top)) && (ref == nil || lookHolds((item.role, item.label), item.offset == nil ? self.identity(item.element) : nil, text: item.offset != nil, age: age, ttl: ttl))
            let base = !holds ? nil : axFrame(item.element).flatMap { item.offset == nil || abs($0.width - entry.size.width) + abs($0.height - entry.size.height) < 2 ? $0 : nil }
            let hit: Hit? = base.map { (app, item.element, item.offset?.offsetBy(dx: $0.minX, dy: $0.minY) ?? $0, item.offset, item.offset != nil) }
            DispatchQueue.main.async { done(hit) }
        }
    }

    /// The same thing a moment later, after the ring: its frame read again, nil when it is gone. `done` runs on the main thread.
    /// Run 21: an item of a closed menu has no frame of its own ("Quit Dictionary" read as gone three times): its menu's title stands in, as when it was found.
    func fresh(_ hit: Hit, _ done: @escaping (Hit?) -> Void) {
        queue.async {
            let now: Hit? = (hit.offset == nil ? shownFrame(hit.element) : axFrame(hit.element)).map { (hit.app, hit.element, hit.offset?.offsetBy(dx: $0.minX, dy: $0.minY) ?? $0, hit.offset, hit.text) }
            DispatchQueue.main.async { done(now) }
        }
    }

    /// Spotify, every run: a link named by its child text was not found by name, and the next look listed it. The look's own
    /// walk, asked with the name as its query: the one thing whose words are that name, in that role. `done` runs on the main thread.
    func named(_ app: NSRunningApplication, _ target: ScreenTarget, _ done: @escaping (Hit?) -> Void) {
        guard let words = (target.label ?? target.text)?.trimmingCharacters(in: .whitespaces).lowercased(), !words.isEmpty else { return done(nil) }
        let want = flatRole(target.role).map { $0.hasPrefix("ax") ? String($0.dropFirst(2)) : $0 }
        queue.async {
            let seen = self.walk(app.processIdentifier, target.window, 400, before: nil, after: false, LookTune(nil), query: lookQuery(words))
            let found = seen.items.filter { item in
                (item.json["label"] as? String)?.lowercased() == words && (want.map { w in [item.json["role"], item.json["sub"]].contains { flatRole($0 as? String)?.hasSuffix(w) == true } } ?? true)
            }
            DispatchQueue.main.async { done(found.count == 1 ? (app, found[0].element, found[0].frame, nil, false) : nil) }
        }
    }

    /// An app's front window, for a key, typing or a scroll with no thing named.
    func window(_ app: NSRunningApplication?, _ done: @escaping (Hit?) -> Void) {
        guard let app, AXIsProcessTrusted() else { return done(nil) }
        queue.async {
            let root = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(root, 0.5)
            let window = axElement(axValue(root, kAXFocusedWindowAttribute)) ?? axElement(axValue(root, kAXMainWindowAttribute))
            let hit: Hit? = window.flatMap { window in axFrame(window).map { (app, window, $0, nil, false) } }
            DispatchQueue.main.async { done(hit) }
        }
    }

    /// A click, a key and a scroll land on the app in front: bring it there first, as the old path's reach does.
    /// 27 section 3 item 7: done once the app's notifications go quiet after it comes forward, 0.4 s at most (an app not heard: 0.4 s).
    func front(_ app: NSRunningApplication, _ done: @escaping () -> Void) {
        guard !app.isActive, let url = app.bundleURL else { return done() }
        let asked = Date()
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) { _, _ in
            DispatchQueue.global(qos: .userInitiated).async {
                self.settle(app.processIdentifier, since: asked, 0.4)
                DispatchQueue.main.async { done() }
            }
        }
    }

    // MARK: Hands

    /// A click at a point on screen: once, twice or three times, left or right, with modifier keys held.
    /// This one moves the pointer for an instant, then puts it back.
    func click(_ point: CGPoint, _ pid: pid_t, count: Int, right: Bool, flags: CGEventFlags, _ done: @escaping (Bool) -> Void) {
        aim(point, pid, done) { source in
            var events: [CGEvent?] = []
            for n in 1 ... max(1, min(3, count)) {
                for type in right ? [CGEventType.rightMouseDown, .rightMouseUp] : [CGEventType.leftMouseDown, .leftMouseUp] {
                    let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: right ? .right : .left)
                    event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                    event?.flags = flags
                    events.append(event)
                }
            }
            return events
        }
    }

    /// 27 section 3 item 2: press at `from`, move to `to` with the button held, let go there. Both points must be the app's
    /// own window, under no other app's; the pointer goes back after, as for a click.
    func drag(_ from: CGPoint, _ to: CGPoint, _ pid: pid_t, _ done: @escaping (Bool) -> Void) {
        aim(from, also: [to], pid, done) { source in
            let event = { (type: CGEventType, at: CGPoint) in CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: .left) }
            // A nil is a pause of one beat (15 ms): an app starts a drag only after the press has been held a moment.
            return [event(.leftMouseDown, from), nil, nil, nil] + lookPath(from, to).map { event(.leftMouseDragged, $0) } + [nil, nil, event(.leftMouseUp, to)]
        }
    }

    /// The wheel over the thing, `lines` down (negative = up). Moves the pointer for an instant, as a click does.
    /// Run 36: the slip sat over the middle of a wide page; the point is the first of its middle, left third and top third that is the app's own.
    func scroll(_ frame: CGRect, _ lines: Int, _ pid: pid_t, _ done: @escaping (Bool) -> Void) {
        let points = [CGPoint(x: frame.midX, y: frame.midY), CGPoint(x: frame.minX + frame.width / 6, y: frame.midY), CGPoint(x: frame.midX, y: frame.minY + frame.height / 6)]
        let point = points.first { owns($0, pid) && !sundialAt($0) } ?? points[0]
        aim(point, pid, done) { source in [CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: Int32(-max(-50, min(50, lines))), wheel2: 0, wheel3: 0)] }
    }

    /// Pointer to the point, the events, pointer back. false = the point is not the app's to take: it is not in
    /// front, another app's window lies over the point, or a window of Sundial's other than the slip does.
    private func aim(_ point: CGPoint, also: [CGPoint] = [], _ pid: pid_t, _ done: @escaping (Bool) -> Void, _ events: @escaping (CGEventSource?) -> [CGEvent?]) {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, ([point] + also).allSatisfy({ owns($0, pid) }) else { return done(false) }
        // A private source: these are not the owner's hand, and the next owner-moved check must not read them as one.
        let source = CGEventSource(stateID: .privateState)
        let back = CGEvent(source: nil)?.location
        // Runs 231-234: the slip's run card lay over Send and Submit at the bottom left of the window, and every click
        // there was refused "covered". The slip lets Gnomon's own events through to the app, so it is never clicked
        // itself; any other window of Sundial's that takes the mouse at the point still is a no. Doc 32 item 1: from
        // before the pointer moves, so the slip knows the owner's pointer and a press meant for it in this time is kept.
        slipHands(true, back, point)
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
            let own = ([point] + also).contains { self.sundialAt($0) }
            DispatchQueue.global(qos: .userInteractive).async {
                if !own {
                    for event in events(source) {
                        event?.post(tap: .cghidEventTap)
                        usleep(15000)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) {
                    if let back {
                        CGWarpMouseCursorPosition(back)
                        CGAssociateMouseAndMouseCursorPosition(1)
                    }
                    slipHands(false, nil, nil)
                    done(!own)
                }
            }
        }
    }

    /// Main thread. One of Sundial's own windows (the slip, where it is solid) takes the mouse at this point.
    private func sundialAt(_ point: CGPoint) -> Bool {
        let flipped = NSPoint(x: point.x, y: primaryHeight() - point.y)
        return NSApp.windows.contains { $0.isVisible && !$0.ignoresMouseEvents && $0.frame.contains(flipped) }
    }

    /// The app's own window is the first under the point; a normal window of another app over it is a no.
    private func owns(_ point: CGPoint, _ pid: pid_t) -> Bool {
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let listed = windows.compactMap { window -> (owner: pid_t, layer: Int, rect: CGRect)? in
            guard let owner = window[kCGWindowOwnerPID as String] as? pid_t, let bounds = window[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
            return (owner, window[kCGWindowLayer as String] as? Int ?? -1, rect)
        }
        return lookOwns(listed, point, app: pid, own: ProcessInfo.processInfo.processIdentifier)
    }

    /// Text as key events, a pair a character; the character rides on the event, whatever the keyboard layout.
    func type(_ text: String, into element: AXUIElement?, _ pid: pid_t, strict: Bool, _ done: @escaping (String?) -> Void) {
        keys(pid, into: element, strict, done) { source, pid in
            for character in text.prefix(2000) {
                let code: CGKeyCode = character.isNewline ? 36 : character == "\t" ? 48 : 0
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { continue }
                    event.flags = []
                    if code == 0 { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units) }
                    event.postToPid(pid)
                }
                usleep(3000)
            }
        }
    }

    /// One key with its modifiers.
    func key(_ code: CGKeyCode, _ flags: CGEventFlags, into element: AXUIElement?, _ pid: pid_t, strict: Bool, _ done: @escaping (String?) -> Void) {
        keys(pid, into: element, strict, done) { source, pid in
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
                event?.flags = flags
                event?.postToPid(pid)
            }
        }
    }

    /// Keys go to the app itself (the slip may hold the keyboard), into `element` when a thing was named.
    /// `done` gets the reason nothing was sent: a password field has the keyboard, or what has it cannot be read.
    /// Plan 2B: `send` gets the pid that owns the thing with the keyboard: a Save or Open panel's service, not the app (19 tries, 0 landed).
    private func keys(_ pid: pid_t, into element: AXUIElement?, _ strict: Bool, _ done: @escaping (String?) -> Void, _ send: @escaping (CGEventSource?, pid_t) -> Void) {
        queue.async {
            if let element {
                AXUIElementSetMessagingTimeout(element, 0.5)
                AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                Thread.sleep(forTimeInterval: 0.05)
            }
            let root = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(root, 0.5)
            var value: CFTypeRef?
            var focus = AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &value)
            var sub: CFTypeRef?
            var subrole = AXError.noValue
            var owner: pid_t?
            if focus == .success {
                if let focused = axElement(value) {
                    AXUIElementSetMessagingTimeout(focused, 0.5)
                    subrole = AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString, &sub)
                    var got: pid_t = 0
                    if AXUIElementGetPid(focused, &got) == .success { owner = got }
                } else {
                    focus = .failure
                }
            }
            if let reason = lookKeyGate(focus: focus, subrole: subrole, sub: sub as? String, strict: strict) { return DispatchQueue.main.async { done(reason) } }
            // Sent on its own queue: a long text takes seconds, and no look or refusal check waits behind it.
            let target = lookKeyTarget(app: pid, focused: owner)
            if target != pid { log("screen: keys go to pid \(target), the process that holds the keyboard for pid \(pid)") }
            self.hands.async {
                send(CGEventSource(stateID: .privateState), target)
                DispatchQueue.main.async { done(nil) }
            }
        }
    }
}

let looks = Looks()

/// A window to `to` (top-left points): size, place, size again, since an app may refuse a size that would cross the screen's edge.
func axSetFrame(_ window: AXUIElement, _ to: CGRect) {
    var point = to.origin
    var size = to.size
    AXUIElementSetMessagingTimeout(window, 1)
    let set = { (attribute: String, value: AXValue?) in _ = value.map { AXUIElementSetAttributeValue(window, attribute as CFString, $0) } }
    set(kAXSizeAttribute, AXValueCreate(.cgSize, &size))
    set(kAXPositionAttribute, AXValueCreate(.cgPoint, &point))
    set(kAXSizeAttribute, AXValueCreate(.cgSize, &size))
}

/// Main thread. The primary display's height: the flip between AppKit and top-left points, on every display (see lookTopLeft).
func primaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

/// Main thread. The display that holds `point` (top-left global points), else the primary.
func screenHolding(_ point: CGPoint) -> NSScreen? {
    let screens = NSScreen.screens
    return lookScreenIndex(point, screens.map(\.frame)).map { screens[$0] } ?? screens.first
}

/// Main thread. The screen stage's room, in top-left points: the visible part of `screen` (the primary when nil), beside Sundial's slip when it shows there.
func stageFrame(_ screen: NSScreen? = nil) -> CGRect {
    guard let screen = screen ?? NSScreen.screens.first else { return .zero }
    var free = screen.visibleFrame
    if let slip = slipFrame(), slip.intersects(free) {
        let left = slip.minX - free.minX
        let right = free.maxX - slip.maxX
        free = left >= right ? CGRect(x: free.minX, y: free.minY, width: left - 8, height: free.height) : CGRect(x: slip.maxX + 8, y: free.minY, width: right - 8, height: free.height)
    }
    return lookTopLeft(free, primary: primaryHeight())
}

/// Main thread. Run 21: the screen as a map for the engine, with every look: its size, the free room beside the slip, and the
/// app windows that show, front first (CGWindowList: no AX call; a title only with the Screen Recording grant). Names and
/// titles go in the fields the one redaction pass knows.
/// Set 2 R5: `size`, `free` and `display` (its CGDirectDisplayID) are the display that holds `around`, the looked window's
/// middle; `displays`, every display's top-left frame, only when there is more than one.
func screenMap(around: CGPoint? = nil) -> [String: Any] {
    let own = ProcessInfo.processInfo.processIdentifier
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let shown: [[String: Any]] = list.compactMap { w in
        guard w[kCGWindowLayer as String] as? Int == 0, let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != own,
              let box = (w[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0 as CFDictionary) }), box.width > 40, box.height > 40,
              let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { return nil }
        return ["processName": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "windowTitle": w[kCGWindowName as String] as? String ?? "", "frame": ints(box), "front": pid == front]
    }
    let screen = around.flatMap(screenHolding) ?? NSScreen.screens.first
    let size = screen?.frame.size ?? .zero
    var map: [String: Any] = ["size": [Int(size.width), Int(size.height)], "free": ints(stageFrame(screen)), "windows": Array(shown.prefix(8))]
    if let id = screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber { map["display"] = id.intValue }
    if NSScreen.screens.count > 1 { map["displays"] = NSScreen.screens.map { ints(lookTopLeft($0.frame, primary: primaryHeight())) } }
    return map
}

#endif
