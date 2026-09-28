// macos-calendar-helper.swift
// Standalone EventKit helper that outputs upcoming calendar events as JSON.
// Compiled into the Sundial.app bundle alongside sundial-window-helper.
// On-demand CLI, not a persistent sidecar — invoked via execFile from the TS
// sensor, output read from stdout.
// Usage: sundial-calendar-helper [--hours N] [--past-days D]  (default: 24 hours lookahead, 12 hours back)
//        sundial-calendar-helper --create --title T --start ISO8601 --end ISO8601
//                               [--calendar NAME] [--location L] [--notes N]
//
// `--create` is the one WRITE this helper performs. It saves a single event to
// the named calendar (or the default one) and prints the saved event as JSON.
// It is reached only through `gnomon_calendar_create`, an outward tool the
// permission gate asks about before it runs — the helper itself is a pair of
// hands, not a policy.

import Contacts
import Darwin
import EventKit
import Foundation

// MARK: - Naming an attendee

/// Whether Contacts may be read, decided once per process run.
///
/// EventKit hands Google attendees over with `name == nil` even though the
/// Calendar app shows their names, because the name the app shows is looked up
/// in Contacts rather than carried on the event. Without that lookup the node
/// side receives a bare address, `sanitizeAtIngest` hashes it to a
/// `person-<hash>` alias, and the owner's own record cannot say who they met —
/// 25 aliases on the live record, and seven unanswerable "who is
/// person-c7e3af19c4?" questions put to the owner on 2026-09-09 as a result.
///
/// A denial is not an error. This helper's job is the calendar; Contacts is an
/// improvement on the names it reports, so every failure path returns nil and
/// the caller falls back to the address exactly as before.
private let contactsAuthorized: Bool = {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized:
        return true
    case .notDetermined:
        // A CLI has no run loop, so the async request is bridged with a
        // semaphore. Bounded: if the prompt is never answered — nobody at the
        // keyboard, a background invocation — the sensor poll must not hang, so
        // it gives up and reports addresses.
        let gate = DispatchSemaphore(value: 0)
        var granted = false
        CNContactStore().requestAccess(for: .contacts) { ok, _ in
            granted = ok
            gate.signal()
        }
        return gate.wait(timeout: .now() + 20) == .success && granted
    default:
        return false
    }
}()

private let contactStore = CNContactStore()

/// The full name Contacts holds for a participant, or nil.
private func contactName(for participant: EKParticipant) -> String? {
    guard contactsAuthorized else { return nil }
    let keys = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName)]
    guard let contact = try? contactStore.unifiedContacts(matching: participant.contactPredicate, keysToFetch: keys).first else { return nil }
    guard let name = CNContactFormatter.string(from: contact, style: .fullName), !name.isEmpty else { return nil }
    return name
}

/// What to call an attendee: the event's own name, else Contacts, else the address.
///
/// The address is still the last resort, so nothing regresses when Contacts is
/// unavailable — it just stops being the FIRST resort for every Google invitee.
private func displayName(for participant: EKParticipant) -> String {
    if let name = participant.name, !name.isEmpty { return name }
    if let name = contactName(for: participant) { return name }
    return participant.url.absoluteString
}

// MARK: - Standing on its own identity
//
// TCC does not ask "who is this binary?" — it asks "who is RESPONSIBLE for this
// binary?", and walks the spawn chain to answer. The calendar helper is exec'd
// by node, which is exec'd by a login script, which is started by launchd, so
// the responsible process is whatever the owner happened to launch. The visible
// proof: after consenting to a prompt, Privacy & Security → Calendars listed
// claude.app and Warp.app — the terminals that spawned it — and never Gnomon.
// A grant on the wrong process is not a grant, and the helper stayed denied.
//
// `responsibility_spawnattrs_setdisclaim` is the documented way out (CLAUDE.md's
// macOS note 6): a disclaimed child becomes responsible for ITSELF, so TCC
// evaluates its own code identity and its own embedded usage strings. The
// helper therefore re-execs itself once, disclaimed, and waits for that copy.
//
// Reached through `dlsym` rather than linked: it is a private SPI, and a
// missing symbol must degrade to today's behaviour rather than fail the build.
// stdout is inherited, so the child's JSON reaches the original caller
// unchanged and no caller has to know this happened.

private let DISCLAIM_MARKER = "SUNDIAL_CALENDAR_DISCLAIMED"

private typealias SetDisclaim = @convention(c) (UnsafeMutableRawPointer, Int32) -> Int32

/// Re-exec self as a process responsible for itself. Returns only when it could
/// not — never when the child ran, because then this process exits with its status.
func reexecDisclaimed() {
    // Already the disclaimed copy: run the actual work.
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
    var environment: [UnsafeMutablePointer<CChar>?] = ProcessInfo.processInfo.environment
        .map { strdup("\($0.key)=\($0.value)") }
    environment.append(strdup("\(DISCLAIM_MARKER)=1"))
    environment.append(nil)
    defer {
        for pointer in argv where pointer != nil { free(pointer) }
        for pointer in environment where pointer != nil { free(pointer) }
    }

    var pid: pid_t = 0
    guard posix_spawn(&pid, arguments[0], nil, &attrs, argv, environment) == 0 else { return }

    var status: Int32 = 0
    waitpid(pid, &status, 0)
    // Mirror the child's outcome so the caller cannot tell the hop happened.
    exit((status & 0x7F) == 0 ? (status >> 8) & 0xFF : 1)
}

struct CalendarEvent: Codable {
    let eventId: String
    let title: String
    let startDate: String
    let endDate: String
    let attendees: [String]
    let isRecurring: Bool
    let calendar: String
    let isAllDay: Bool
    let organizer: String?
    /// True when one of the attendees is `EKParticipant.isCurrentUser`. False
    /// when attendees are present but none is the current user. nil when there
    /// are no attendees at all (treat as self-organized — i.e. self-attended).
    let isSelfAttendee: Bool?
}

struct CreateOutput: Codable {
    let created: Bool
    let event: CalendarEvent?
    let error: String?
    let accessGranted: Bool
}

/// `notDetermined` (a prompt is possible) vs `denied`/`restricted` (it is not,
/// and no amount of retrying will change that) vs granted. Without this the
/// helper reported one flat `accessGranted: false` for two situations that need
/// opposite responses from the owner.
func authorizationLabel() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .fullAccess: return "fullAccess"
    case .writeOnly: return "writeOnly"
    @unknown default: return "unknown(\(status.rawValue))"
    }
}

/// Whether this process is the disclaimed copy — i.e. whether TCC is judging
/// the helper's own code identity rather than whatever started it.
func disclaimedLabel() -> Bool {
    ProcessInfo.processInfo.environment[DISCLAIM_MARKER] != nil
}

struct CalendarOutput: Codable {
    let events: [CalendarEvent]
    let timestamp: String
    let authorization: String
    let disclaimed: Bool
    /// False when EventKit denied access or usage strings are missing — distinguishes empty calendar from permission failure.
    let accessGranted: Bool
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// One event → the JSON shape the reader already emits, so a created event reads back identically.
func encode(_ ev: EKEvent) -> CalendarEvent {
    let participants = ev.attendees ?? []
    return CalendarEvent(
        eventId: ev.eventIdentifier ?? UUID().uuidString,
        title: ev.title ?? "(untitled)",
        startDate: isoFormatter.string(from: ev.startDate),
        endDate: isoFormatter.string(from: ev.endDate),
        attendees: participants.map { displayName(for: $0) },
        isRecurring: ev.hasRecurrenceRules,
        calendar: ev.calendar?.title ?? "Unknown",
        isAllDay: ev.isAllDay,
        organizer: ev.organizer.map { displayName(for: $0) },
        isSelfAttendee: participants.isEmpty ? nil : participants.contains(where: { $0.isCurrentUser })
    )
}

func printCreate(_ value: CreateOutput) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value), let str = String(data: data, encoding: .utf8) { print(str) }
}

func option(_ name: String, in args: [String]) -> String? {
    guard let idx = args.firstIndex(of: name), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

/// Parse an ISO-8601 date with or without fractional seconds — callers send both.
func parseDate(_ text: String) -> Date? {
    if let d = isoFormatter.date(from: text) { return d }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: text)
}

func create(store: EKEventStore, args: [String]) {
    guard let title = option("--title", in: args), !title.isEmpty else {
        printCreate(CreateOutput(created: false, event: nil, error: "--title is required", accessGranted: true)); return
    }
    guard let startText = option("--start", in: args), let start = parseDate(startText) else {
        printCreate(CreateOutput(created: false, event: nil, error: "--start must be an ISO-8601 date", accessGranted: true)); return
    }
    guard let endText = option("--end", in: args), let end = parseDate(endText), end > start else {
        printCreate(CreateOutput(created: false, event: nil, error: "--end must be an ISO-8601 date after --start", accessGranted: true)); return
    }

    // The named calendar, or the default. A name that matches nothing is an
    // error rather than a silent fallback: the owner asked for THAT calendar.
    var calendar = store.defaultCalendarForNewEvents
    if let wanted = option("--calendar", in: args) {
        guard let found = store.calendars(for: .event).first(where: { $0.title.caseInsensitiveCompare(wanted) == .orderedSame && $0.allowsContentModifications }) else {
            let names = store.calendars(for: .event).filter { $0.allowsContentModifications }.map { $0.title }.joined(separator: ", ")
            printCreate(CreateOutput(created: false, event: nil, error: "no writable calendar named \(wanted); writable calendars: \(names)", accessGranted: true)); return
        }
        calendar = found
    }
    guard let target = calendar else {
        printCreate(CreateOutput(created: false, event: nil, error: "no writable calendar available", accessGranted: true)); return
    }

    let ev = EKEvent(eventStore: store)
    ev.calendar = target
    ev.title = title
    ev.startDate = start
    ev.endDate = end
    ev.location = option("--location", in: args)
    ev.notes = option("--notes", in: args)
    do {
        try store.save(ev, span: .thisEvent, commit: true)
        printCreate(CreateOutput(created: true, event: encode(ev), error: nil, accessGranted: true))
    } catch {
        printCreate(CreateOutput(created: false, event: nil, error: "EventKit refused: \(error.localizedDescription)", accessGranted: true))
    }
}

func main() {
    // Before touching EventKit: make sure the process asking is this helper,
    // not whatever started it. Returns immediately in the disclaimed copy.
    reexecDisclaimed()

    var lookaheadHours = 24
    let args = CommandLine.arguments
    let creating = args.contains("--create")
    if let idx = args.firstIndex(of: "--hours"), idx + 1 < args.count,
       let h = Int(args[idx + 1]) {
        lookaheadHours = h
    }
    // The back-fill on /setup reads what already happened: D days back, and
    // ended events are kept rather than dropped.
    var pastDays: Int? = nil
    if let idx = args.firstIndex(of: "--past-days"), idx + 1 < args.count,
       let d = Int(args[idx + 1]), d > 0 {
        pastDays = min(d, 90)
    }

    let store = EKEventStore()
    let semaphore = DispatchSemaphore(value: 0)
    var accessGranted = false

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { granted, _ in
            accessGranted = granted
            semaphore.signal()
        }
    } else {
        store.requestAccess(to: .event) { granted, _ in
            accessGranted = granted
            semaphore.signal()
        }
    }

    // BOUNDED. Consent blocks here until the owner answers, and a background
    // poll has nobody to answer it — the sensor's own execFile timeout would
    // kill this process, but the disclaimed child would outlive it and pile up
    // one stuck process per poll. Waiting a bounded time and reporting "not
    // granted" is the honest outcome: the prompt is still queued for whenever
    // the owner is actually there.
    if semaphore.wait(timeout: .now() + 20) == .timedOut {
        accessGranted = false
    }

    guard accessGranted else {
        if creating {
            printCreate(CreateOutput(created: false, event: nil, error: "Calendar access not granted", accessGranted: false)); return
        }
        let output = CalendarOutput(
            events: [],
            timestamp: isoFormatter.string(from: Date()),
            authorization: authorizationLabel(),
            disclaimed: disclaimedLabel(),
            accessGranted: false
        )
        printJSON(output)
        return
    }

    if creating {
        create(store: store, args: args)
        return
    }

    let now = Date()
    let end = Calendar.current.date(byAdding: .hour, value: lookaheadHours, to: now)!
    // Look back 12 hours so events already in progress (started before `now`)
    // are still returned — otherwise `calendar:active` never fires for an
    // ongoing meeting whose startDate is in the past.
    let lookbackStart = pastDays.map { Calendar.current.date(byAdding: .day, value: -$0, to: now)! }
        ?? Calendar.current.date(byAdding: .hour, value: -12, to: now)!

    let predicate = store.predicateForEvents(withStart: lookbackStart, end: end, calendars: nil)
    // Drop events whose endDate is in the past — those won't fire either
    // `calendar:active` or `calendar:upcoming` and would just waste payload.
    let ekEvents = store.events(matching: predicate).filter { pastDays != nil || $0.endDate >= now }

    let events: [CalendarEvent] = ekEvents.map { ev in
        let participants = ev.attendees ?? []
        let attendeeNames: [String] = participants.compactMap { participant in
            displayName(for: participant)
        }

        let isSelfAttendee: Bool? = participants.isEmpty
            ? nil
            : participants.contains(where: { $0.isCurrentUser })

        let organizerString: String? = {
            guard let org = ev.organizer else { return nil }
            return displayName(for: org)
        }()

        return CalendarEvent(
            eventId: ev.eventIdentifier ?? UUID().uuidString,
            title: ev.title ?? "(untitled)",
            startDate: isoFormatter.string(from: ev.startDate),
            endDate: isoFormatter.string(from: ev.endDate),
            attendees: attendeeNames,
            isRecurring: ev.hasRecurrenceRules,
            calendar: ev.calendar?.title ?? "Unknown",
            isAllDay: ev.isAllDay,
            organizer: organizerString,
            isSelfAttendee: isSelfAttendee
        )
    }

    let output = CalendarOutput(events: events, timestamp: isoFormatter.string(from: now), authorization: authorizationLabel(), disclaimed: disclaimedLabel(), accessGranted: true)
    printJSON(output)
}

func printJSON(_ value: CalendarOutput) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    if let data = try? encoder.encode(value),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

main()
