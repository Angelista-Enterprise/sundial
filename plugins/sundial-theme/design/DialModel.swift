import Foundation

extension Comparable {
    public func clamped(to range: ClosedRange<Self>) -> Self {
        min(max(self, range.lowerBound), range.upperBound)
    }
}

/// Everything a dial draws, in hours-since-midnight as `Double`.
///
/// This lives in `GnomonKit` rather than next to the two dial views because both
/// apps build it from the same `GET /daily` payload, and a second mapping is a
/// second chance for macOS and iOS to disagree about what the day looked like.
///
/// `now` is `nil` when the dial is showing a day that is not today. That is the
/// whole point of the shadow: there is nothing the system "cannot know yet" about
/// a finished day, so a past day gets no gnomon and no shadow rather than a
/// gnomon parked at 24:00.
public struct DialModel: Sendable, Equatable {
    public struct Span: Sendable, Equatable, Identifiable {
        public let id: String
        public let start: Double
        public let end: Double
        /// False when a project scope is active and this span belongs to a
        /// different one. Drained, never removed — the day's shape has to
        /// survive scoping or the proportion stops being readable.
        public let inScope: Bool

        public init(id: String, start: Double, end: Double, inScope: Bool = true) {
            self.id = id
            self.start = start
            self.end = end
            self.inScope = inScope
        }
    }

    /// A run of contiguous time on one project, built from moments.
    ///
    /// The dial had exactly one project-bearing element — deep-work blocks — and
    /// on a real day there are usually none of them: they need a sustained
    /// 25-minute high-focus run, and a normal day is hundreds of moments with a
    /// median under a minute. So scoping "worked" and changed nothing visible.
    /// This band is the day's actual project shape, and it is the thing a scope
    /// accentuates.
    public struct ProjectSpan: Sendable, Equatable, Identifiable {
        public let id: String
        public let start: Double
        public let end: Double
        /// Nil is unattributed — on a real machine the largest share by far, and
        /// a designed state rather than a gap to hide.
        public let project: String?
        public let inScope: Bool

        public init(id: String, start: Double, end: Double, project: String?, inScope: Bool) {
            self.id = id
            self.start = start
            self.end = end
            self.project = project
            self.inScope = inScope
        }
    }

    public struct Meeting: Sendable, Equatable, Identifiable {
        public let id: String
        public let title: String
        public let start: Double
        public init(id: String, title: String, start: Double) {
            self.id = id
            self.title = title
            self.start = start
        }
    }

    /// The predicted end of the day, drawn over the shadow rather than into it.
    ///
    /// The shadow means *no observation exists here*, and this does not change
    /// that: a forecast is a claim about inference, the shadow is a claim about
    /// evidence, and the two are compatible statements about the same hours. So
    /// the shadow is left exactly as it was and the forecast sits on top of it as
    /// an ``Mark/inferred`` mark — dashed, grey, labelled as a guess. Filling,
    /// lightening or truncating the shadow where the forecast reaches would be
    /// the dishonest version, because it would claim the hours are known.
    ///
    /// Only the day's *end* is forecast, and only because it is the one target
    /// with measured skill (`dayShapeForecast`: +46.1% from hour of day alone).
    /// The attention curve's future shape is not forecast at any strength,
    /// because nothing has measured it — the same reason mood is withheld
    /// outright. One number earns a mark; the other does not.
    public struct EndForecast: Sendable, Equatable {
        /// The hour the day probably ends *inside*.
        public let lastActiveHour: Double
        /// So `lastActiveHour: 17` reads "probably done by 18:00" — the hour after it.
        public var doneByHour: Double { lastActiveHour + 1 }
        public let probability: Double
        public let observedHours: Int

        public init(lastActiveHour: Double, probability: Double, observedHours: Int) {
            self.lastActiveHour = lastActiveHour
            self.probability = probability
            self.observedHours = observedHours
        }
    }

    /// An event the calendar says is still ahead, placed on the dial's day.
    ///
    /// The dial could show the hours behind in five layers and had nothing at all
    /// to say about the hours ahead except one dashed guess at the day's end —
    /// while the daemon had been folding the real calendar lookahead into
    /// `state.schedule.upcoming` on every poll and no reader ever asked for it.
    ///
    /// This is deliberately NOT the ``EndForecast`` treatment. A forecast is a
    /// model's guess and wears the ``Mark/inferred`` dash in `inkSubtle`; a
    /// scheduled event is an *observation* — the calendar server said it exists —
    /// that simply has not happened yet. So it keeps the meeting layer's navy,
    /// which is what makes a reader connect it to the solid meeting marks behind
    /// `now`, and it is dashed because the hours it covers are still unobserved.
    /// Colour carries "this is a meeting", the dash carries "not yet", and the
    /// key names both marks so neither can be read as the other.
    public struct Upcoming: Sendable, Equatable, Identifiable {
        public let id: String
        public let title: String
        /// Hours since midnight on the dial's day, clamped into the dial's window.
        /// An event that began yesterday (an overnight, or a multi-day all-day
        /// event) starts at the dial's left edge rather than off-scale.
        public let start: Double
        public let end: Double
        /// All-day events are drawn nowhere: they have no position on a dial whose
        /// whole axis is time of day, and stretching one across the full width
        /// would claim a block of hours the event never claimed. They stay in this
        /// list because a page still wants to name them.
        public let isAllDay: Bool
        /// A count, not names. Attendee strings are already aliased at ingest and
        /// on real data are a mix of people, rooms and mailing lists — the number
        /// is the part that means something at a glance.
        public let attendeeCount: Int
        /// `now` is inside it. Such an event is drawn only over the part still
        /// ahead; see ``DialModel/drawnUpcoming``.
        public let inProgress: Bool

        public init(
            id: String,
            title: String,
            start: Double,
            end: Double,
            isAllDay: Bool,
            attendeeCount: Int,
            inProgress: Bool
        ) {
            self.id = id
            self.title = title
            self.start = start
            self.end = end
            self.isAllDay = isAllDay
            self.attendeeCount = attendeeCount
            self.inProgress = inProgress
        }

        /// Whether this event has a mark on the dial at `hour`. Spelled once here so
        /// a page asking "is anything drawn ahead?" and ``DialModel/drawnUpcoming``
        /// deciding what to draw cannot answer differently.
        public func isAhead(of hour: Double) -> Bool {
            !isAllDay && end > hour
        }
    }

    public struct EnergyPoint: Sendable, Equatable {
        public let hour: Double
        /// Normalised to 0…1 here. The wire value is an integer 0…100.
        public let score: Double
        public init(hour: Double, score: Double) {
            self.hour = hour
            self.score = score
        }
    }

    public var energy: [EnergyPoint]
    public var projectSpans: [ProjectSpan]
    public var deepWork: [Span]
    public var breaks: [Span]
    public var meetings: [Meeting]
    /// What the calendar says is still ahead on this day, all-day events included.
    /// Empty on a past day for the same reason `endForecast` is dropped: nothing
    /// is ahead of a day that is over.
    public var upcoming: [Upcoming]
    public var now: Double?
    /// Only ever set alongside `now` — a finished day has no end left to predict,
    /// and a gnomon-less dial with a forecast on it would be nonsense.
    public var endForecast: EndForecast?
    public var startHour: Double
    public var endHour: Double

    public init(
        energy: [EnergyPoint] = [],
        projectSpans: [ProjectSpan] = [],
        deepWork: [Span] = [],
        breaks: [Span] = [],
        meetings: [Meeting] = [],
        upcoming: [Upcoming] = [],
        now: Double? = nil,
        endForecast: EndForecast? = nil,
        startHour: Double = 6,
        endHour: Double = 24
    ) {
        self.energy = energy
        self.projectSpans = projectSpans
        self.deepWork = deepWork
        self.breaks = breaks
        self.meetings = meetings
        self.upcoming = now == nil ? [] : upcoming
        self.now = now
        self.endForecast = now == nil ? nil : endForecast
        self.startHour = startHour
        self.endHour = endHour
    }

    public func fraction(_ hour: Double) -> Double {
        guard endHour > startHour else { return 0 }
        return ((hour - startHour) / (endHour - startHour)).clamped(to: 0...1)
    }

    /// Energy is only drawn up to `now` — the curve must not run ahead of the
    /// observations behind it.
    public var drawnEnergy: [EnergyPoint] {
        let cutoff = now ?? endHour
        return energy
            .filter { $0.hour >= startHour && $0.hour <= min(cutoff, endHour) }
            .sorted { $0.hour < $1.hour }
    }

    public var isEmpty: Bool {
        energy.isEmpty && deepWork.isEmpty && breaks.isEmpty && meetings.isEmpty && projectSpans.isEmpty
            && upcoming.isEmpty
    }

    /// One scheduled event, clipped to the part of it that is still ahead.
    public struct DrawnUpcoming: Sendable, Equatable, Identifiable {
        public let event: Upcoming
        /// `max(event.start, now)` — where the mark begins.
        public let from: Double
        public let to: Double
        public var id: String { event.id }
    }

    /// The scheduled events the dial actually draws, in the extent it draws them.
    ///
    /// Three filters, each closing a way the mark could lie:
    ///
    /// - **All-day events are out.** They have no hour.
    /// - **Anything already over is out.** `scheduleTrack` filters on `end >= now`
    ///   at poll time, but a poll is up to a minute stale, so the meeting that
    ///   ended two minutes ago must not still be drawn as ahead.
    /// - **The extent starts at `now`, not at the event's start.** A meeting
    ///   running right now has observed time behind the gnomon and scheduled time
    ///   in front of it, and drawing the dashed mark back over the observed part
    ///   would put a "not yet" mark on hours that have already been recorded.
    public var drawnUpcoming: [DrawnUpcoming] {
        let cutoff = now ?? endHour
        return upcoming.compactMap { event in
            guard event.isAhead(of: cutoff), event.start <= endHour else { return nil }
            return DrawnUpcoming(event: event, from: max(event.start, cutoff), to: min(event.end, endHour))
        }
    }

    // MARK: - Hover

    /// What the dial is showing at one hour, in words.
    ///
    /// The dial packs five overlapping layers into 150pt, and until now a reader
    /// could see the shape of the day without being able to ask a single question
    /// about it. `lines` are already-formatted strings rather than raw values
    /// because the two dials (horizontal and upright) must not each decide how to
    /// phrase the same span.
    public struct Detail: Sendable, Equatable, Identifiable {
        /// Which layer answered. Drives the swatch, so the tooltip and the key agree.
        public enum Layer: String, Sendable, Equatable {
            case meeting, upcoming, deepWork, project, unattributed, gap, forecast, shadow, attention
        }

        public let layer: Layer
        public let title: String
        public let lines: [String]
        /// Where on the dial this was read, so the tooltip can point at it rather than at the cursor.
        public let hour: Double

        public var id: String { "\(layer.rawValue)-\(hour)" }

        public init(layer: Layer, title: String, lines: [String], hour: Double) {
            self.layer = layer
            self.title = title
            self.lines = lines
            self.hour = hour
        }
    }

    /// `07:20` for 7.333.
    public static func clockLabel(_ hour: Double) -> String {
        let total = Int((hour * 60).rounded())
        return String(format: "%02d:%02d", (total / 60) % 24, total % 60)
    }

    /// `1h 20m`, `20m`, `<1m`. Its own formatter rather than `GnomonDateFormatting`'s
    /// because that lives in the app target and the dial is in the design layer,
    /// which both apps share.
    public static func spanLabel(fromHours hours: Double) -> String {
        let minutes = Int((hours * 60).rounded())
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let remainder = minutes % 60
        return remainder == 0 ? "\(minutes / 60)h" : "\(minutes / 60)h \(remainder)m"
    }

    private static func range(_ start: Double, _ end: Double) -> String {
        "\(clockLabel(start)) – \(clockLabel(end)) · \(spanLabel(fromHours: max(0, end - start)))"
    }

    /// The attention score at `hour`, interpolated between the two nearest
    /// observed buckets. The curve is drawn as one continuous form, so reading a
    /// point off it has to interpolate too — snapping to the nearest bucket would
    /// report a number the curve is visibly not at.
    public func attention(atHour hour: Double) -> Double? {
        let points = drawnEnergy
        guard let first = points.first, let last = points.last else { return nil }
        if hour <= first.hour { return first.score }
        if hour >= last.hour { return last.score }
        for (before, after) in zip(points, points.dropFirst()) where hour >= before.hour && hour <= after.hour {
            let span = after.hour - before.hour
            guard span > 0 else { return before.score }
            let t = (hour - before.hour) / span
            return before.score + (after.score - before.score) * t
        }
        return nil
    }

    /// What to say about `hour`, most specific layer first.
    ///
    /// The order is the point: a meeting is a named thing a person recognises, a
    /// deep-work block is a derived claim about them, a project span is where the
    /// time went, and a gap is the day's own hole. Answering with the project
    /// band when the cursor is on a meeting would technically be true and useless.
    ///
    /// Past `now` there is nothing observed to report, so the answer is about the
    /// shadow itself — and it says so, rather than returning nil and leaving a
    /// reader to wonder whether the hover is broken.
    public func detail(atHour hour: Double) -> Detail? {
        guard hour >= startHour, hour <= endHour else { return nil }

        // A meeting is a hairline, so it needs a tolerance to be hoverable at all.
        // Six minutes is about 3pt on a 1000pt dial — the width of the mark.
        let meetingTolerance = 0.1
        if let meeting = meetings.min(by: { abs($0.start - hour) < abs($1.start - hour) }), abs(meeting.start - hour) <= meetingTolerance {
            return Detail(
                layer: .meeting,
                title: meeting.title,
                lines: ["meeting · starts \(Self.clockLabel(meeting.start))", "from the calendar, as observed"],
                hour: meeting.start
            )
        }

        if let now, hour > now {
            // A named thing the reader recognises outranks a statistical claim
            // about the same hour, exactly as a meeting outranks a deep-work
            // block behind the gnomon. Nearest start wins when two overlap.
            let ahead = drawnUpcoming
                .filter { hour >= $0.from && hour <= $0.to }
                .min { abs($0.event.start - hour) < abs($1.event.start - hour) }
            if let ahead {
                let event = ahead.event
                var lines = [Self.range(event.start, event.end)]
                lines.append(event.inProgress ? "from the calendar · started \(Self.clockLabel(event.start))" : "from the calendar · has not happened yet")
                if event.attendeeCount > 0 {
                    lines.append("\(event.attendeeCount) \(event.attendeeCount == 1 ? "attendee" : "attendees")")
                }
                return Detail(layer: .upcoming, title: event.title, lines: lines, hour: hour)
            }

            if let forecast = endForecast, hour <= forecast.doneByHour {
                return Detail(
                    layer: .forecast,
                    title: "Probably done by \(Self.clockLabel(forecast.doneByHour))",
                    lines: [
                        "inferred · \(Int((forecast.probability * 100).rounded()))% by then",
                        "from \(forecast.observedHours) observed hours of when your days ended",
                    ],
                    hour: hour
                )
            }
            return Detail(
                layer: .shadow,
                title: "Not known yet",
                lines: ["\(Self.clockLabel(hour)) has not happened", "the shadow is not empty time — it is unobserved time"],
                hour: hour
            )
        }

        if let block = deepWork.first(where: { hour >= $0.start && hour <= $0.end }) {
            return Detail(
                layer: .deepWork,
                title: "Deep-work block",
                lines: [Self.range(block.start, block.end), "derived · a sustained high-focus run"],
                hour: hour
            )
        }

        if let gap = breaks.first(where: { hour >= $0.start && hour <= $0.end }) {
            return Detail(
                layer: .gap,
                title: "Break",
                lines: [Self.range(gap.start, gap.end), "observed · nothing was recorded in this window"],
                hour: hour
            )
        }

        if let span = projectSpans.first(where: { hour >= $0.start && hour <= $0.end }) {
            var lines = [Self.range(span.start, span.end)]
            if let attention = attention(atHour: hour) {
                lines.append("attention \(Int((attention * 100).rounded()))% · derived")
            }
            if !span.inScope { lines.append("outside the current scope") }
            return Detail(
                layer: span.project == nil ? .unattributed : .project,
                title: span.project ?? "Unattributed",
                lines: span.project == nil
                    ? lines + ["observed, but no project could be resolved"]
                    : lines,
                hour: hour
            )
        }

        if let attention = attention(atHour: hour) {
            return Detail(
                layer: .attention,
                title: "\(Int((attention * 100).rounded()))% attention",
                lines: [Self.clockLabel(hour), "derived · no moment was attributed here"],
                hour: hour
            )
        }

        return nil
    }
}

// MARK: - Mapping from GET /daily

public extension DialModel {
    /// Builds the dial for one day's context.
    ///
    /// Three things about the wire data this has to absorb, all verified against
    /// `packages/kernel/src/daily-context.ts`:
    ///
    /// - **`energyCurve.score` is an integer 0…100**, not a fraction. It is
    ///   divided here, once.
    /// - **The curve is sparse.** `buildEnergyCurve` buckets by local hour and
    ///   emits only hours that had a moment, so two adjacent points can be five
    ///   hours apart. The curve is still drawn as one smooth form (it is a
    ///   *derived* value, and stepping it per hour would imply the buckets are
    ///   themselves observations), but nothing downstream may assume 24 points.
    /// - **A break can be classified `overnight` and last seven minutes.** The
    ///   kind is a label the classifier assigned, so the dial draws the span and
    ///   ignores the label rather than styling by it.
    ///
    /// `now` is passed in rather than read from the clock so a caller can render
    /// a past day (no gnomon, no shadow) and so tests are deterministic.
    /// - Parameter scopedProject: the short project name a scope is set to, or
    ///   nil. Only deep-work blocks carry a project on the wire, so scoping the
    ///   dial means draining those and leaving the curve, the breaks and the
    ///   meetings alone — none of them are attributed, and tinting them by a
    ///   scope would be inventing attribution the daemon never made.
    /// - Parameter moments: the day's closed moments, used to build the project
    ///   band. Passed in rather than derived from the day pack because the pack
    ///   has no per-project timeline — only `deepWorkBlocks`, which is empty on
    ///   most real days.
    /// - Parameter forecast: the day-end guess as the daemon computed it, or nil.
    ///   Passed in rather than derived here for the reason ``DialModel/EndForecast``
    ///   states: the smoothing lives next to the forecaster being scored.
    /// - Parameter upcoming: `state.schedule.upcoming` verbatim. The whole list is
    ///   passed and this mapping decides what belongs on the day — see
    ///   ``DialModel/upcomingSpans(from:now:calendar:startHour:endHour:)``, where
    ///   the same-day filter is the part that must not be skipped.
    static func from(
        _ context: DailyContextDTO?,
        now: Date?,
        scopedProject: String? = nil,
        moments: [MomentDTO] = [],
        identity: ProjectIdentity = ProjectIdentity(),
        forecast: DayEndForecastDTO? = nil,
        upcoming: [UpcomingEventDTO] = [],
        calendar: Calendar = .current,
        startHour: Double = 6,
        endHour: Double = 24
    ) -> DialModel {
        let band = projectBand(
            moments: moments, identity: identity, scopedProject: scopedProject, calendar: calendar
        )
        let endForecast = forecast.map {
            EndForecast(
                lastActiveHour: Double($0.lastActiveHour),
                probability: $0.probability,
                observedHours: $0.observedHours
            )
        }
        let ahead = upcomingSpans(
            from: upcoming, now: now, calendar: calendar, startHour: startHour, endHour: endHour
        )
        guard let context else {
            return DialModel(
                projectSpans: band,
                upcoming: ahead,
                now: now.map { calendar.hourOfDay($0) },
                endForecast: endForecast,
                startHour: startHour, endHour: endHour
            )
        }

        func hour(_ iso: String?) -> Double? {
            guard let date = ISO8601DateFormatter.parseGnomon(iso) else { return nil }
            return calendar.hourOfDay(date)
        }

        let energy: [EnergyPoint] = (context.energyCurve ?? []).compactMap { point in
            guard let score = point.score else { return nil }
            return EnergyPoint(hour: Double(point.hour), score: (score / 100).clamped(to: 0...1))
        }

        let deepWork: [Span] = (context.deepWorkBlocks ?? []).compactMap { block in
            guard let start = hour(block.start) else { return nil }
            // `end` is on the wire, but a block whose end is missing still has a
            // duration; falling back keeps the block drawn rather than dropped.
            let end = hour(block.end) ?? (start + Double(block.durationMin ?? 0) / 60)
            return Span(
                id: block.id,
                start: start,
                end: max(end, start),
                inScope: scopedProject == nil || block.project == scopedProject
            )
        }

        let breaks: [Span] = (context.breaks ?? []).compactMap { gap in
            guard let start = hour(gap.start) else { return nil }
            let end = hour(gap.end) ?? (start + Double(gap.durationMin ?? 0) / 60)
            return Span(id: gap.id, start: start, end: max(end, start))
        }

        let meetings: [Meeting] = (context.meetings ?? []).compactMap { meeting in
            guard let start = hour(meeting.start) else { return nil }
            return Meeting(id: meeting.id, title: meeting.title, start: start)
        }

        return DialModel(
            energy: energy,
            projectSpans: band,
            deepWork: deepWork,
            breaks: breaks,
            meetings: meetings,
            upcoming: ahead,
            now: now.map { calendar.hourOfDay($0) },
            endForecast: endForecast,
            startHour: startHour,
            endHour: endHour
        )
    }

    /// `state.schedule.upcoming` placed on the dial's one day.
    ///
    /// The trap this exists to avoid: the wire list is a 24-hour lookahead, so it
    /// contains tomorrow. Reading an hour-of-day off tomorrow's 09:00 standup and
    /// drawing it puts a meeting *behind* the gnomon that has not happened — the
    /// exact inversion the dial is built to prevent. So an event is kept only if it
    /// overlaps the dial's own day, and overlap is the test rather than "starts
    /// today" because a multi-day all-day event (a holiday) began days ago and is
    /// still true now.
    ///
    /// Duplicates are collapsed on `id` (start + title): two calendars subscribed
    /// to one meeting produce two identical rows in the live data, which would draw
    /// two hairlines and stack two identical labels.
    static func upcomingSpans(
        from events: [UpcomingEventDTO],
        now: Date?,
        calendar: Calendar = .current,
        startHour: Double = 6,
        endHour: Double = 24
    ) -> [Upcoming] {
        guard let now else { return [] }
        let dayStart = calendar.startOfDay(for: now)
        guard let dayEnd = calendar.date(byAdding: .day, value: 1, to: dayStart) else { return [] }
        var seen = Set<String>()
        var out: [Upcoming] = []
        for event in events {
            guard let start = ISO8601DateFormatter.parseGnomon(event.start) else { continue }
            let end = ISO8601DateFormatter.parseGnomon(event.end) ?? start
            guard start < dayEnd, end > dayStart else { continue }
            guard seen.insert(event.id).inserted else { continue }

            // Clamped to the dial's window, not to the day: an event that began
            // before 06:00 belongs at the left edge, and `fraction` would clamp it
            // there anyway — doing it here keeps the hover ranges honest too.
            let startHourOfDay = (start < dayStart ? startHour : calendar.hourOfDay(start)).clamped(to: startHour...endHour)
            let endHourOfDay = (end >= dayEnd ? endHour : calendar.hourOfDay(end)).clamped(to: startHour...endHour)
            out.append(Upcoming(
                id: event.id,
                title: event.title.isEmpty ? "(untitled event)" : event.title,
                start: startHourOfDay,
                end: max(endHourOfDay, startHourOfDay),
                isAllDay: event.isAllDay ?? false,
                attendeeCount: event.attendees?.count ?? 0,
                inProgress: start <= now && end > now
            ))
        }
        return out.sorted {
            // All-day first: they are context for the whole day rather than a point
            // in it, and a list of "what's ahead" reads badly with a holiday wedged
            // between two meetings by an arbitrary start time.
            $0.isAllDay == $1.isAllDay ? $0.start < $1.start : $0.isAllDay && !$1.isAllDay
        }
    }
}

extension DialModel {
    /// Merges adjacent moments that resolve to the same project into one span.
    ///
    /// Merging matters: a day is hundreds of moments, and one rectangle each
    /// would be hundreds of views drawing sub-pixel slivers. A gap of up to five
    /// minutes stays inside a run — the same threshold `buildDeepWorkBlocks`
    /// uses for contiguity, so the band and the blocks above it agree about what
    /// counts as continuous.
    static func projectBand(
        moments: [MomentDTO],
        identity: ProjectIdentity,
        scopedProject: String?,
        calendar: Calendar
    ) -> [ProjectSpan] {
        let contiguousGap: TimeInterval = 5 * 60

        let entries: [(start: Date, end: Date, project: String?)] = moments.compactMap { moment in
            guard let start = ISO8601DateFormatter.parseGnomon(moment.startTime) else { return nil }
            let end = ISO8601DateFormatter.parseGnomon(moment.endTime)
                ?? start.addingTimeInterval(Double(moment.durationMs) / 1000)
            return (start, end, identity.name(forID: moment.projectId))
        }
        .sorted { $0.start < $1.start }

        var spans: [ProjectSpan] = []
        var runStart: Date?
        var runEnd: Date?
        var runProject: String??

        func flush() {
            guard let start = runStart, let end = runEnd, let project = runProject else { return }
            let from = calendar.hourOfDay(start)
            let to = calendar.hourOfDay(end)
            spans.append(ProjectSpan(
                id: "\(start.timeIntervalSince1970)-\(project ?? "none")",
                start: from,
                // A run crossing midnight would wrap to a smaller hour; clamp
                // rather than draw a negative-width span.
                end: max(to, from),
                project: project,
                inScope: scopedProject == nil || project == scopedProject
            ))
        }

        for entry in entries {
            if let end = runEnd, let project = runProject,
               project == entry.project, entry.start.timeIntervalSince(end) <= contiguousGap {
                runEnd = max(end, entry.end)
                continue
            }
            flush()
            runStart = entry.start
            runEnd = entry.end
            runProject = entry.project
        }
        flush()
        return spans
    }
}

extension Calendar {
    /// Hours since local midnight, fractional.
    ///
    /// Public because it is the *convention*, not a helper: every dial position, every
    /// energy bucket and now Memory's open-moment figure are all measured in local
    /// fractional hours, and a second view re-deriving that arithmetic is how two
    /// surfaces come to disagree about where "now" is.
    public func hourOfDay(_ date: Date) -> Double {
        let parts = dateComponents([.hour, .minute, .second], from: date)
        return Double(parts.hour ?? 0)
            + Double(parts.minute ?? 0) / 60
            + Double(parts.second ?? 0) / 3600
    }
}

public extension ISO8601DateFormatter {
    /// The daemon writes `2026-07-28T11:00:00.000Z` — fractional seconds, always
    /// Z. One shared formatter because `ISO8601DateFormatter` is expensive to
    /// build and this runs once per span on every day change.
    internal static let gnomon: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Same instant, without fractional seconds — some rows predate the
    /// millisecond-precision writer.
    internal static let gnomonWhole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parses either shape. Returns nil rather than a wrong instant.
    static func parseGnomon(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return gnomon.date(from: iso) ?? gnomonWhole.date(from: iso)
    }
}
