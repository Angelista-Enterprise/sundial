import SwiftUI
import GnomonKit

// MARK: - Horizontal (desktop)

/// The day as one artefact: attention, deep work, breaks, meetings and the
/// present moment in a single 150pt band.
///
/// The gnomon is the shadow-casting part of a sundial. It does not act; it stands
/// still and you read the day off its shadow. The shadow here covers the hours
/// the system cannot know yet — it is not a "remaining time" bar, and it is
/// **never filled in**: the day's predicted end is drawn *over* it as an
/// ``Mark/inferred`` mark, leaving the shadow's own fill and extent untouched.
/// The shadow is a claim about evidence; the forecast is a claim about inference.
/// They are compatible statements, and the moment the shadow is lightened or
/// truncated where a guess reaches, the dial starts claiming those hours are
/// known. See ``DialModel/EndForecast``.
///
/// Hovering reads one hour back in words (``DialModel/detail(atHour:)``). Five
/// layers in 150pt was a shape you could see and not interrogate.
public struct DayDial: View {
    private let model: DialModel
    /// `nil` fills whatever height it is given, which is the default on Today.
    ///
    /// The dial was a fixed 150pt band next to a facts column twice its height,
    /// so the day — the highest-value artefact in the product — was the smallest
    /// thing in its own section, with a third of the band empty underneath it. The
    /// whole geometry is authored against a 1000×150 plate and scaled, so filling
    /// costs nothing but reading the proposal instead of ignoring it.
    private let fixedHeight: CGFloat?

    @Environment(\.gnomonStaticRender) private var staticRender

    /// Nil when the cursor is off the dial. Hover state rather than selection: a
    /// dial is a reading instrument, so nothing here is clickable and nothing
    /// persists after the cursor leaves.
    @State private var hoveredHour: Double?

    /// Changing this replays the curve's one draw. Nil never draws.
    ///
    /// Keyed on a *day* rather than on the model, because the model changes on
    /// every SSE refresh and every minute tick — redrawing then would make the one
    /// animation in the product that is allowed to draw itself into a twitch. Today
    /// passes its date; the live mini-dial in Memory · Now passes nothing.
    private let drawKey: String?

    public init(model: DialModel, height: CGFloat? = nil, drawKey: String? = nil) {
        self.model = model
        self.fixedHeight = height
        self.drawKey = drawKey
    }

    /// 0 → 1 once per `drawKey`. The curve is a *derived* shape, and watching a
    /// derived shape form is the one place a drawing animation says something true:
    /// it was computed, not observed.
    @State private var drawn: Double = 0

    private var hovered: DialModel.Detail? {
        hoveredHour.flatMap { model.detail(atHour: $0) }
    }

    /// Inverse of `x(_:_:)` — screen point back to an hour on the real scale.
    private func hour(atX x: CGFloat, width: CGFloat) -> Double {
        guard width > 0 else { return model.startHour }
        let fraction = Double(x / width).clamped(to: 0...1)
        return model.startHour + fraction * (model.endHour - model.startHour)
    }

    // Geometry, from the 1000×150 plate.
    private let baselineY: CGFloat = 130
    private let curveTopY: CGFloat = 18
    private let deepY: CGFloat = 132
    private let deepH: CGFloat = 6
    private let breakY: CGFloat = 126
    private let breakH: CGFloat = 4
    private let bandY: CGFloat = 141
    private let bandH: CGFloat = 5
    private let plateH: CGFloat = 150

    /// Below this the sub-baseline rows (a 5pt band, a 6pt block, a 4pt break
    /// notch) collapse into each other and the dial stops being readable, so a
    /// cramped proposal is refused rather than drawn illegibly.
    private static let minimumHeight: CGFloat = 96

    private func x(_ hour: Double, _ w: CGFloat) -> CGFloat { CGFloat(model.fraction(hour)) * w }

    /// Plate units to points, at the scale this render is running at.
    private func y(_ plateY: CGFloat, _ scale: CGFloat) -> CGFloat { plateY * scale }

    public var body: some View {
        GeometryReader { geo in
            // Everything is authored in plate units and scaled once here, so a
            // taller band scales the curve, the shadow, the project band and the
            // gnomon together rather than letting any one of them drift.
            plate(
                width: geo.size.width,
                scale: max(fixedHeight ?? geo.size.height, Self.minimumHeight) / plateH
            )
        }
        // A fixed height pins the band; `nil` accepts whatever the parent proposes.
        .frame(height: fixedHeight)
        .animation(GnomonMotion.fast, value: hovered?.id)
        .onAppear { startDraw() }
        .onChange(of: drawKey) { _, _ in
            drawn = 0
            startDraw()
        }
    }

    /// Nil `drawKey` means the curve is simply there — no animation at all, which is
    /// what a live minute-by-minute dial wants. A static render is always settled:
    /// a plate that happened to be captured mid-draw would show a half-drawn curve
    /// as though that were the data.
    private var drawProgress: Double { (drawKey == nil || staticRender) ? 1 : drawn }

    private func startDraw() {
        guard drawKey != nil, !staticRender else { return }
        withAnimation(GnomonMotion.draw) { drawn = 1 }
    }

    private func plate(width w: CGFloat, scale: CGFloat) -> some View {
        Group {
            ZStack(alignment: .topLeading) {
                // The area beneath the attention curve, then the curve itself. The
                // fill fades while the stroke draws — trimming a filled shape looks
                // like a wipe rather than a line being drawn.
                if model.drawnEnergy.count > 1 {
                    EnergyShape(model: model, baselineY: baselineY, curveTopY: curveTopY, scale: scale, closed: true)
                        .fill(GnomonColor.panel)
                        .opacity(drawProgress)
                    EnergyShape(model: model, baselineY: baselineY, curveTopY: curveTopY, scale: scale, closed: false)
                        .trim(from: 0, to: drawProgress)
                        .stroke(GnomonColor.ochre, style: StrokeStyle(lineWidth: 2, lineCap: .butt, lineJoin: .round))
                }

                // The shadow over the hours that cannot be known yet. It eases with
                // the gnomon rather than cutting: the shadow's left edge IS the
                // gnomon's position, and two representations of one boundary moving
                // at different times reads as a glitch.
                if let now = model.now {
                    Rectangle()
                        .fill(GnomonColor.shadowTint)
                        .frame(width: max(0, w - x(now, w)), height: y(baselineY, scale))
                        .offset(x: x(now, w))
                        .animation(GnomonMotion.slow, value: now)
                }

                // Baseline.
                Rectangle()
                    .fill(GnomonColor.ink)
                    .frame(width: w, height: 1)
                    .offset(y: y(baselineY, scale))

                // The project band: the day's actual project shape, under the
                // baseline. Unattributed is drawn, not skipped — it is usually
                // the largest share, and leaving it out would make the day look
                // more accounted for than it is.
                ForEach(model.projectSpans) { span in
                    Rectangle()
                        .fill(GnomonColor.projectBand(span.project, inScope: span.inScope))
                        .frame(width: max(1, x(span.end, w) - x(span.start, w)), height: y(bandH, scale))
                        .offset(x: x(span.start, w), y: y(bandY, scale))
                        .animation(GnomonMotion.medium, value: span.inScope)
                }

                // Deep-work blocks — observed, so ink.
                ForEach(model.deepWork) { block in
                    Rectangle()
                        .fill(block.inScope ? GnomonColor.ink : GnomonColor.superseded)
                        .frame(width: max(1, x(block.end, w) - x(block.start, w)), height: y(deepH, scale))
                        .offset(x: x(block.start, w), y: y(deepY, scale))
                        .animation(GnomonMotion.medium, value: block.inScope)
                }

                // Breaks knock out the baseline — the day's own gaps.
                ForEach(model.breaks) { gap in
                    Rectangle()
                        .fill(GnomonColor.page)
                        .frame(width: max(1, x(gap.end, w) - x(gap.start, w)), height: y(breakH, scale))
                        .offset(x: x(gap.start, w), y: y(breakY, scale))
                }

                // Meetings.
                ForEach(model.meetings) { meeting in
                    Rectangle()
                        .fill(GnomonColor.navy.opacity(0.55))
                        .frame(width: 3, height: y(baselineY, scale))
                        .offset(x: x(meeting.start, w) - 1.5)
                }

                // What the calendar says is still ahead, in the band row where the
                // day's observed project time is drawn — solid behind the gnomon,
                // dashed in front of it. Same row on purpose: it is the one place
                // the dial makes a claim about how a block of the day was spent,
                // and a commitment is the closest thing to that a future hour has.
                ForEach(model.drawnUpcoming) { ahead in
                    ScheduledMark(
                        fromX: x(ahead.from, w),
                        toX: x(ahead.to, w),
                        // The hairline marks the scheduled *start*. An event
                        // already running has its start behind the gnomon, where a
                        // "not yet" mark would be a lie, so it gets none.
                        startX: ahead.event.inProgress ? nil : x(ahead.event.start, w),
                        baselineY: y(baselineY, scale),
                        bandY: y(bandY, scale),
                        bandH: y(bandH, scale)
                    )
                }

                // The day's predicted end, ON the shadow. Nothing above has been
                // changed to make room for it — that is the design decision, not
                // an implementation detail.
                if let now = model.now, let forecast = model.endForecast {
                    ForecastMark(
                        fromX: x(now, w),
                        toX: x(min(forecast.doneByHour, model.endHour), w),
                        baselineY: y(baselineY, scale)
                    )
                    .animation(GnomonMotion.slow, value: now)
                }

                // The gnomon: line and base, in one group so they cannot desync
                // when the minute ticks.
                if let now = model.now {
                    GnomonPointer(scale: scale, baselineY: baselineY)
                        .offset(x: x(now, w))
                        .animation(GnomonMotion.slow, value: now)
                }

                labels(width: w)

                // The hovered hour's own hairline, so the tooltip is anchored to
                // a place on the dial rather than floating beside the cursor.
                if let hoveredHour, hovered != nil {
                    Rectangle()
                        .fill(GnomonColor.borderStrong)
                        .frame(width: 1, height: y(baselineY, scale))
                        .offset(x: x(hoveredHour, w))
                        .allowsHitTesting(false)
                }
            }
            // `onContinuousHover` rather than `onHover` + a drag gesture: the
            // dial must stay non-interactive (nothing here is clickable), and a
            // gesture would swallow clicks meant for the page behind it.
            .contentShape(Rectangle())
            .onContinuousHover { phase in
                switch phase {
                case .active(let point):
                    hoveredHour = hour(atX: point.x, width: w)
                case .ended:
                    hoveredHour = nil
                }
            }
            .overlay(alignment: .topLeading) {
                if let hovered {
                    DialTooltip(detail: hovered)
                        // Clamped inside the dial so a detail read near 23:00
                        // does not hang off the right edge, which is what the
                        // meeting labels already had to solve.
                        .offset(x: min(x(hovered.hour, w) + 10, max(0, w - DialTooltip.width)), y: 6)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
        }
    }

    /// One placed label: where it goes, and which row it landed in.
    private struct PlacedLabel: Identifiable {
        let id: String
        let text: String
        let color: Color
        let weight: Font.Weight
        let x: CGFloat
        let row: Int
        /// A scheduled event's chip is dashed, like its mark on the dial.
        let dashed: Bool
    }

    /// Packs the meeting labels and the `now` label into rows so they cannot
    /// overlap, and clamps each one inside the dial so it cannot be cut off at
    /// the right edge. Both were happening: a meeting near `now` collided with
    /// it, and anything after about 22:00 ran off the end.
    private func placedLabels(width w: CGFloat) -> [PlacedLabel] {
        var candidates: [(id: String, text: String, color: Color, weight: Font.Weight, hour: Double, dashed: Bool)] =
            model.meetings.map { ($0.id, $0.title, GnomonColor.navy, .regular, $0.start, false) }
        // A scheduled event carries its start time in the label as well as its
        // title. Behind the gnomon the hairline's position is corroborated by
        // everything else on the dial; ahead of it the position is the only claim
        // being made, so it is worth stating in words.
        candidates += model.drawnUpcoming.map { ahead in
            (
                "ahead-\(ahead.id)",
                "\(hourLabel(ahead.event.start)) \(ahead.event.title)",
                GnomonColor.navy,
                .regular,
                ahead.from,
                true
            )
        }
        if let now = model.now {
            candidates.append(("now", "now \(hourLabel(now))", GnomonColor.ink, .medium, now, false))
        }
        candidates.sort { $0.hour < $1.hour }

        var rowEnds: [CGFloat] = []
        return candidates.map { candidate in
            let estimated = DialChip.estimatedWidth(candidate.text)
            let ideal = x(candidate.hour, w) + 6
            let clamped = min(ideal, max(0, w - estimated))
            let row = rowEnds.firstIndex { clamped >= $0 + 6 } ?? rowEnds.count
            if row < rowEnds.count { rowEnds[row] = clamped + estimated } else { rowEnds.append(clamped + estimated) }
            return PlacedLabel(
                id: candidate.id, text: candidate.text, color: candidate.color,
                weight: candidate.weight, x: clamped, row: row, dashed: candidate.dashed
            )
        }
    }

    @ViewBuilder
    private func labels(width w: CGFloat) -> some View {
        ForEach(placedLabels(width: w)) { label in
            DialChip(text: label.text, color: label.color, weight: label.weight, dashed: label.dashed)
                .offset(x: label.x, y: 2 + CGFloat(label.row) * 24)
        }
    }

    private func hourLabel(_ hour: Double) -> String {
        let h = Int(hour)
        let m = Int((hour - Double(h)) * 60 + 0.5)
        return String(format: "%02d:%02d", h, min(m, 59))
    }
}

/// The attention curve, as a real `Shape`.
///
/// It has to be a `Shape` rather than a bare `Path` view: a `Path` placed in a
/// `ZStack` is laid out at the size of its own bounding box and repositioned to
/// the stack's alignment, which silently flattens the curve onto the baseline —
/// the exact symptom this replaced. A `Shape` is handed the full cell rect and
/// draws in it.
private struct EnergyShape: Shape {
    let model: DialModel
    let baselineY: CGFloat
    let curveTopY: CGFloat
    let scale: CGFloat
    let closed: Bool

    func path(in rect: CGRect) -> Path {
        let pts = model.drawnEnergy.map { p in
            CGPoint(
                x: CGFloat(model.fraction(p.hour)) * rect.width,
                y: (baselineY - (baselineY - curveTopY) * CGFloat(p.score.clamped(to: 0...1))) * scale
            )
        }
        var path = Path.smoothCurve(through: pts)
        if closed, let first = pts.first, let last = pts.last {
            path.addLine(to: CGPoint(x: last.x, y: baselineY * scale))
            path.addLine(to: CGPoint(x: first.x, y: baselineY * scale))
            path.closeSubpath()
        }
        return path
    }
}

/// The day's predicted end, drawn over the shadow.
///
/// Three parts, and each is deliberately the ``Mark/inferred`` treatment the
/// grammar already defines for a forecaster's guess — dashed, `inkSubtle`, never
/// ink and never ochre:
///
/// - a dashed rule along the baseline from `now` to the predicted end, which is
///   the extent of the claim;
/// - a dashed vertical at the end itself, which is the claim;
/// - nothing else. No fill, no gradient into the shadow, no shortening of the
///   shadow behind it.
///
/// It is dashed rather than dotted-and-coloured because the app has exactly one
/// idiom for "a model guessed this", and a forecast on the highest-value screen
/// in the product is not the place to invent a second one.
private struct ForecastMark: View {
    let fromX: CGFloat
    let toX: CGFloat
    let baselineY: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: CGPoint(x: fromX, y: baselineY))
                path.addLine(to: CGPoint(x: max(fromX, toX), y: baselineY))
            }
            .stroke(Mark.inferred.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))

            Path { path in
                path.move(to: CGPoint(x: toX, y: baselineY))
                path.addLine(to: CGPoint(x: toX, y: baselineY * 0.34))
            }
            .stroke(Mark.inferred.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
        }
        .allowsHitTesting(false)
    }
}

/// A calendar commitment that has not happened yet.
///
/// Navy, because it is a meeting and the reader has to connect it to the solid
/// meeting marks behind the gnomon. Dashed, because the hours it covers are still
/// unobserved. It is NOT the ``Mark/inferred`` treatment even though it is also
/// dashed and also sits on the shadow: nothing here was guessed by a model — the
/// calendar server said the event exists — and the two marks differ in colour and
/// are named separately in ``DialKey`` so neither reads as the other.
///
/// Like ``ForecastMark`` it draws *over* the shadow and changes nothing beneath
/// it. A scheduled hour is still an unobserved hour.
private struct ScheduledMark: View {
    let fromX: CGFloat
    let toX: CGFloat
    /// Nil for an event already running — its start is behind the gnomon.
    let startX: CGFloat?
    let baselineY: CGFloat
    let bandY: CGFloat
    let bandH: CGFloat

    private var tint: Color { GnomonColor.navy.opacity(0.55) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Path { path in
                path.move(to: CGPoint(x: fromX, y: bandY + bandH / 2))
                path.addLine(to: CGPoint(x: max(fromX, toX), y: bandY + bandH / 2))
            }
            .stroke(tint, style: StrokeStyle(lineWidth: max(2, bandH), dash: [6, 5]))

            if let startX {
                Path { path in
                    path.move(to: CGPoint(x: startX, y: 0))
                    path.addLine(to: CGPoint(x: startX, y: baselineY))
                }
                .stroke(tint, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
            }
        }
        .allowsHitTesting(false)
    }
}

/// One hour of the dial, read back in words.
///
/// Sits on `panel` with a hairline for the same reason ``DialChip`` does: a
/// `page`-coloured plate on a `page` background has no edge and reads as a
/// floating white box, which was the original complaint about this dial.
private struct DialTooltip: View {
    static let width: CGFloat = 250

    let detail: DialModel.Detail

    private var swatch: Color {
        switch detail.layer {
        case .meeting, .upcoming: return GnomonColor.navy
        case .deepWork: return GnomonColor.ink
        case .project: return GnomonColor.ink
        case .unattributed: return GnomonColor.Data.unattributed
        case .gap: return GnomonColor.border
        case .forecast, .shadow: return Mark.inferred.color
        case .attention: return GnomonColor.ochre
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(swatch)
                    .frame(width: 8, height: 8)
                Text(detail.title)
                    .gnomonText(GnomonTextStyle(size: 13, weight: .medium, lineHeight: 1.2))
                    .foregroundStyle(GnomonColor.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
            ForEach(Array(detail.lines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .gnomonText(GnomonTextStyle(size: 11.5, lineHeight: 1.3))
                    .foregroundStyle(GnomonColor.inkMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(width: Self.width, alignment: .leading)
        .background(GnomonColor.panel)
        .overlay(Rectangle().strokeBorder(GnomonColor.borderStrong, lineWidth: 1))
    }
}

/// The gnomon itself: a 2pt vertical and its triangular base, kept in one view so
/// a `translateX` on the pair cannot let the two desync.
private struct GnomonPointer: View {
    let scale: CGFloat
    let baselineY: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(GnomonColor.ink)
                .frame(width: 2, height: (baselineY - 8) * scale)
                .offset(x: -1, y: 8 * scale)
            Path { p in
                p.move(to: CGPoint(x: -7 * scale, y: baselineY * scale))
                p.addLine(to: CGPoint(x: 0, y: (baselineY - 14) * scale))
                p.addLine(to: CGPoint(x: 7 * scale, y: baselineY * scale))
                p.closeSubpath()
            }
            .fill(GnomonColor.ink)
        }
    }
}

/// A label over the dial knocks out what is behind it rather than colliding
/// with it — but a `page`-coloured plate on a `page` background has no edge at
/// all, which is why these read as floating white boxes. It sits on `panel` with
/// a hairline instead: still quiet, but a thing rather than an absence.
private struct DialChip: View {
    let text: String
    let color: Color
    var weight: Font.Weight = .regular
    /// Dashed for a scheduled event, matching its mark on the dial.
    var dashed: Bool = false

    /// Used to keep labels from overlapping each other. Measuring properly would
    /// need a layout pass per chip; the label set here is short and fixed-size,
    /// so an estimate from the character count is enough to pack rows with.
    static func estimatedWidth(_ text: String) -> CGFloat {
        CGFloat(text.count) * 6.4 + 12
    }

    var body: some View {
        Text(text)
            .gnomonText(GnomonTextStyle(size: 12, weight: weight, lineHeight: 1))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(GnomonColor.panel)
            .overlay(
                Rectangle().strokeBorder(
                    dashed ? GnomonColor.navy.opacity(0.55) : GnomonColor.border,
                    style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 3] : [])
                )
            )
            .fixedSize()
    }
}

/// `06 08 10 … 24` under the dial, positioned on the real scale.
public struct DialHourAxis: View {
    private let model: DialModel
    private let step: Double

    public init(model: DialModel, step: Double = 2) {
        self.model = model
        self.step = step
    }

    private var hours: [Double] {
        stride(from: model.startHour, through: model.endHour, by: step).map { $0 }
    }

    public var body: some View {
        GeometryReader { geo in
            ForEach(hours, id: \.self) { hour in
                Text(String(format: "%02d", Int(hour)))
                    .gnomonText(GnomonTextStyle(size: 12, lineHeight: 1))
                    .foregroundStyle(GnomonColor.inkFaint)
                    .fixedSize()
                    // Centred on the tick, but nudged in at the ends: `06` and
                    // `24` sit on the edges and lose half a glyph otherwise.
                    .position(
                        x: (CGFloat(model.fraction(hour)) * geo.size.width).clamped(to: 10...(geo.size.width - 10)),
                        y: 8
                    )
            }
        }
        .frame(height: 16)
    }
}

/// The key row. This is data, not decoration — it names which mark is which, and
/// should not be dropped for space.
///
/// `forecast` is passed rather than always drawn: a key entry for a mark that is
/// not on this dial names something the reader cannot find, which is its own small
/// lie. On a young install the forecaster has learned too little to draw, and the
/// key says nothing about it.
public struct DialKey: View {
    private let forecast: Bool
    private let scheduled: Bool

    public init(forecast: Bool = false, scheduled: Bool = false) {
        self.forecast = forecast
        self.scheduled = scheduled
    }

    public var body: some View {
        HStack(spacing: 26) {
            item { Rectangle().fill(GnomonColor.ink).frame(width: 16, height: 5) }
                label: { Text("deep-work block · observed") }
            item { Rectangle().fill(GnomonColor.ochre).frame(width: 16, height: 2) }
                label: { Text("attention · derived") }
            item {
                HStack(spacing: 2) {
                    Rectangle().fill(GnomonColor.Data.categorical[0]).frame(width: 7, height: 5)
                    Rectangle().fill(GnomonColor.Data.categorical[2]).frame(width: 5, height: 5)
                    Rectangle().fill(GnomonColor.Data.unattributed).frame(width: 4, height: 5)
                }
            }
                label: { Text("project · observed") }
            // The shadow is deliberately faint on the dial, where it covers a
            // large area. At 16×10 that same fill is invisible and reads as a
            // missing swatch, so the key outlines it — the fill still matches.
            item {
                Rectangle()
                    .fill(GnomonColor.shadowTint)
                    .frame(width: 16, height: 10)
                    .overlay(Rectangle().strokeBorder(GnomonColor.border, lineWidth: 1))
            }
                label: { Text("not yet known") }
            // Named separately from the forecast, and immediately before it, so the
            // two dashed marks on the same shadow are told apart by a reader rather
            // than by a doc comment: one is the calendar, one is a guess.
            if scheduled {
                item {
                    Path { path in
                        path.move(to: CGPoint(x: 0, y: 5))
                        path.addLine(to: CGPoint(x: 16, y: 5))
                    }
                    .stroke(GnomonColor.navy.opacity(0.55), style: StrokeStyle(lineWidth: 3, dash: [5, 4]))
                    .frame(width: 16, height: 10)
                }
                    label: { Text("scheduled · not yet") }
            }
            if forecast {
                item {
                    Path { path in
                        path.move(to: CGPoint(x: 0, y: 5))
                        path.addLine(to: CGPoint(x: 16, y: 5))
                    }
                    .stroke(Mark.inferred.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .frame(width: 16, height: 10)
                }
                    label: { Text("day's end · inferred") }
            }
        }
        .gnomonText(GnomonTextStyle(size: 12, lineHeight: 1))
        .foregroundStyle(GnomonColor.inkMuted)
    }

    private func item<S: View, L: View>(@ViewBuilder swatch: () -> S, @ViewBuilder label: () -> L) -> some View {
        HStack(spacing: 8) { swatch(); label() }
    }
}

// MARK: - Upright (mobile)

/// The same dial stood upright.
///
/// A sundial reads vertically, so on a phone the day runs top to bottom and the
/// gnomon is a *horizontal* line at `now` with the unknown hours in shadow below
/// it. The hour labels are positioned on the real scale, not spaced evenly — a
/// gutter of evenly-spaced hours against a linear dial is a quietly wrong chart.
public struct UprightDial: View {
    private let model: DialModel
    private let height: CGFloat
    private let gutterWidth: CGFloat

    public init(model: DialModel, height: CGFloat = 272, gutterWidth: CGFloat = 34) {
        self.model = model
        self.height = height
        self.gutterWidth = gutterWidth
    }

    private let spineX: CGFloat = 6
    private let deepBarWidth: CGFloat = 5

    private func y(_ hour: Double) -> CGFloat { CGFloat(model.fraction(hour)) * height }

    private var hourLabels: [Double] {
        stride(from: model.startHour, through: model.endHour - 2, by: 4).map { $0 }
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ZStack(alignment: .topLeading) {
                ForEach(hourLabels, id: \.self) { hour in
                    Text(String(format: "%02d", Int(hour)))
                        .gnomonText(GnomonTextStyle(size: 13, lineHeight: 1))
                        .foregroundStyle(GnomonColor.inkFaint)
                        .offset(y: y(hour) - 7)
                }
            }
            .frame(width: gutterWidth, height: height, alignment: .topLeading)

            GeometryReader { geo in
                let w = geo.size.width
                ZStack(alignment: .topLeading) {
                    if model.drawnEnergy.count > 1 {
                        UprightEnergyShape(model: model, spineX: spineX, height: height, closed: true)
                            .fill(GnomonColor.panel)
                        UprightEnergyShape(model: model, spineX: spineX, height: height, closed: false)
                            .stroke(GnomonColor.ochre, style: StrokeStyle(lineWidth: 2, lineCap: .butt, lineJoin: .round))
                    }

                    if let now = model.now {
                        Rectangle()
                            .fill(GnomonColor.shadowTint)
                            .frame(width: max(0, w - spineX), height: max(0, height - y(now)))
                            .offset(x: spineX, y: y(now))
                    }

                    // The spine.
                    Rectangle()
                        .fill(GnomonColor.ink)
                        .frame(width: 1, height: height)
                        .offset(x: spineX)

                    ForEach(model.projectSpans) { span in
                        Rectangle()
                            .fill(GnomonColor.projectBand(span.project, inScope: span.inScope))
                            .frame(width: 4, height: max(1, y(span.end) - y(span.start)))
                            .offset(x: spineX + 2, y: y(span.start))
                    }

                    // Deep-work blocks sit against the spine, on its outside.
                    ForEach(model.deepWork) { block in
                        Rectangle()
                            .fill(GnomonColor.ink)
                            .frame(width: deepBarWidth, height: max(2, y(block.end) - y(block.start)))
                            .offset(x: spineX - deepBarWidth, y: y(block.start))
                    }

                    ForEach(model.meetings) { meeting in
                        Rectangle()
                            .fill(GnomonColor.navy.opacity(0.55))
                            .frame(width: w - spineX, height: 2)
                            .offset(x: spineX, y: y(meeting.start))
                    }

                    // The same two marks turned ninety degrees: a dashed navy bar
                    // in the band column for the scheduled extent, and a dashed
                    // cross-line at the scheduled start. There is no hover on a
                    // phone, so the title travels with the mark — see the Ahead
                    // list on `PhoneTodayScreen` for the rest of the day.
                    ForEach(model.drawnUpcoming) { ahead in
                        Path { path in
                            path.move(to: CGPoint(x: spineX + 4, y: y(ahead.from)))
                            path.addLine(to: CGPoint(x: spineX + 4, y: max(y(ahead.from), y(ahead.to))))
                        }
                        .stroke(GnomonColor.navy.opacity(0.55), style: StrokeStyle(lineWidth: 4, dash: [6, 5]))

                        if !ahead.event.inProgress {
                            Path { path in
                                path.move(to: CGPoint(x: spineX, y: y(ahead.event.start)))
                                path.addLine(to: CGPoint(x: w, y: y(ahead.event.start)))
                            }
                            .stroke(GnomonColor.navy.opacity(0.55), style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        }
                    }

                    // Same mark, turned ninety degrees: a dashed rule down the
                    // spine to the predicted end and a dashed cross-line at it.
                    // The shadow behind it is untouched here too.
                    if let now = model.now, let forecast = model.endForecast {
                        let endY = y(min(forecast.doneByHour, model.endHour))
                        Path { path in
                            path.move(to: CGPoint(x: spineX, y: y(now)))
                            path.addLine(to: CGPoint(x: spineX, y: max(y(now), endY)))
                        }
                        .stroke(Mark.inferred.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                        Path { path in
                            path.move(to: CGPoint(x: spineX, y: endY))
                            path.addLine(to: CGPoint(x: (w - spineX) * 0.55, y: endY))
                        }
                        .stroke(Mark.inferred.color, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    }

                    if let now = model.now {
                        UprightGnomonPointer(width: w - spineX)
                            .offset(x: spineX, y: y(now))
                            .animation(GnomonMotion.slow, value: now)
                        DialChip(text: "now \(Self.hourLabel(now))", color: GnomonColor.ink, weight: .medium)
                            .offset(x: spineX + 14, y: y(now) - 11)
                    }
                }
            }
            .frame(height: height)
        }
    }

    static func hourLabel(_ hour: Double) -> String {
        let h = Int(hour)
        let m = Int((hour - Double(h)) * 60 + 0.5)
        return String(format: "%02d:%02d", h, min(m, 59))
    }
}

private struct UprightEnergyShape: Shape {
    let model: DialModel
    let spineX: CGFloat
    let height: CGFloat
    let closed: Bool

    func path(in rect: CGRect) -> Path {
        let span = max(1, rect.width * 0.92 - spineX)
        let pts = model.drawnEnergy.map { p in
            CGPoint(
                x: spineX + span * CGFloat(p.score.clamped(to: 0...1)),
                y: CGFloat(model.fraction(p.hour)) * height
            )
        }
        var path = Path.smoothCurve(through: pts)
        if closed, let first = pts.first, let last = pts.last {
            path.addLine(to: CGPoint(x: spineX, y: last.y))
            path.addLine(to: CGPoint(x: spineX, y: first.y))
            path.closeSubpath()
        }
        return path
    }
}

private struct UprightGnomonPointer: View {
    let width: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(GnomonColor.ink)
                .frame(width: width, height: 2)
                .offset(y: -1)
            Path { p in
                p.move(to: CGPoint(x: -12, y: -7))
                p.addLine(to: CGPoint(x: 0, y: 0))
                p.addLine(to: CGPoint(x: -12, y: 7))
                p.closeSubpath()
            }
            .fill(GnomonColor.ink)
        }
    }
}

// MARK: - Curve

extension Path {
    /// A smooth cubic through the given points (Catmull-Rom converted to Bézier).
    ///
    /// The energy curve is a *derived* value, so it is drawn as one continuous
    /// form rather than as a stepped bar chart per hour: the stepping would imply
    /// the hourly buckets are themselves observations.
    static func smoothCurve(through pts: [CGPoint]) -> Path {
        var path = Path()
        guard let first = pts.first else { return path }
        guard pts.count > 2 else {
            path.move(to: first)
            for p in pts.dropFirst() { path.addLine(to: p) }
            return path
        }
        path.move(to: first)
        for i in 0..<(pts.count - 1) {
            let p0 = pts[max(i - 1, 0)]
            let p1 = pts[i]
            let p2 = pts[i + 1]
            let p3 = pts[min(i + 2, pts.count - 1)]
            let c1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
            let c2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
            path.addCurve(to: p2, control1: c1, control2: c2)
        }
        return path
    }
}
