import SwiftUI

/// The redesign's colour tokens, verbatim from the handoff's token table.
///
/// Two things about this enum are product decisions rather than styling, and
/// should not be "improved" later:
///
/// - **There is no dark variant and no user-selectable accent.** The pre-redesign
///   app shipped a five-swatch accent picker in which two swatches (`amber`,
///   `coral`) were already semantic — degraded and error — so a user could pick a
///   selection colour indistinguishable from a failure state. One ochre carries
///   the whole identity instead.
/// - **`ochre`, `green`, `inkFaint` and `superseded` are the uncertainty grammar**
///   (see `Mark`), not a decorative palette. Reach for `Mark` rather than these
///   raw values when colouring a *value*; use these directly only for chrome.
public enum GnomonColor {
    /// The window background, everywhere.
    public static let page = Color(hex: "F0E9E3")
    /// A recessed column or card; also the fill under the energy curve.
    public static let panel = Color(hex: "E3D9CE")

    /// All primary text; anything observed.
    public static let ink = Color(hex: "000000")
    /// Secondary prose.
    public static let inkMuted = Color(hex: "4A4743")
    /// Eyebrows, captions, inferred values.
    public static let inkSubtle = Color(hex: "6F6B66")
    /// Absent values (`—`), timestamps.
    public static let inkFaint = Color(hex: "9E978E")
    /// Struck values, grouped-away spans.
    public static let superseded = Color(hex: "C9C2B9")

    /// Derived / live / provisional.
    public static let ochre = Color(hex: "D98A2B")
    /// Meetings; the densest step of the shadow field; accentuation.
    public static let navy = Color(hex: "002643")
    /// Links on hover, and question links — the only "action" colour.
    public static let blue = Color(hex: "0B64F9")
    /// Verified — confirmed by the owner, or a measurement that passed.
    public static let green = Color(hex: "056423")
    /// A healthy sensor dot only. Never text.
    public static let greenBright = Color(hex: "00C853")

    /// Every panel edge and section rule.
    public static let border = Color.inkA(0.12)
    /// Rules between rows.
    public static let divider = Color.inkA(0.08)
    /// Form inputs, and the dashed "inferred" outline.
    public static let borderStrong = Color.inkA(0.36)
    /// The gnomon's shadow over the hours the system cannot know yet.
    public static let shadowTint = Color.inkA(0.045)

    /// The one dark surface in the product: the record's header bar.
    public static let recordHeader = Color(hex: "000000")

    // MARK: - Memory tier hues

    /// Each memory tier owns a hue when selected. These are the same four values
    /// as `ochre`/`navy`/`blue`/`green`, aliased so the tier spine reads as one
    /// scale at its call site rather than four unrelated colour lookups.
    public enum Tier {
        public static let now = GnomonColor.ochre
        public static let recorded = GnomonColor.navy
        public static let noticed = GnomonColor.blue
        public static let known = GnomonColor.green
    }

    // MARK: - Data colour

    /// Colour for **data marks only** — bars, cells, lines, nodes, bands.
    ///
    /// The chrome palette above is deliberately muted and stays that way; a chart
    /// drawn *out of* that palette is not. The shadow field used to step
    /// `panel → superseded → inkSubtle` — three near-neutrals on a `#F0E9E3` page —
    /// so a busy hour and an idle one differed by a few points of warmth and the
    /// grid read as washed out. Data needs separation, and separation needs
    /// saturation.
    ///
    /// Two rules keep this from colliding with the uncertainty grammar:
    ///
    /// - **The sequential ramp is the ochre family on purpose.** Attention is a
    ///   *derived* quantity and ochre is the grammar's derived hue, so a warm ramp
    ///   is not a decorative choice — it says what kind of number it is, and the
    ///   dial's attention line (already ochre) sits in the same family.
    /// - **The categorical set avoids saying anything.** A project's hue is
    ///   synthesised client-side and carries no backend meaning, so it must not be
    ///   confusable with a semantic colour. `green` (verified) and pure action
    ///   `blue` are excluded from the rotation for exactly that reason.
    public enum Data {
        /// Low → high, five steps. The first is the page itself: an hour with no
        /// attention is *empty*, not lightly coloured.
        public static let attention: [Color] = [
            GnomonColor.page,
            Color(hex: "F2D9A6"),
            Color(hex: "E8AE52"),
            Color(hex: "D2792A"),
            Color(hex: "9C3D0A")
        ]

        /// Distinguishable at a 9pt bar and at a 15pt grid cell, in this order —
        /// adjacent entries are far apart in hue, so the two biggest projects never
        /// come out as neighbouring shades.
        public static let categorical: [Color] = [
            Color(hex: "1F6FB2"), // azure
            Color(hex: "0E8074"), // teal
            Color(hex: "B5237A"), // magenta
            Color(hex: "C0562B"), // burnt orange
            Color(hex: "5B3FBF"), // violet
            Color(hex: "6F8A1E"), // olive
            GnomonColor.navy
        ]

        /// Entity kinds in Known. Fixed rather than hashed: there are four of them
        /// and they mean the same thing on every install, so they should be the same
        /// colour on every install.
        public static func kind(_ kind: String) -> Color {
            switch kind {
            case "person": return categorical[0]
            case "tool": return categorical[1]
            case "topic": return categorical[2]
            case "task": return categorical[3]
            case "project": return categorical[4]
            default: return GnomonColor.inkSubtle
            }
        }

        /// Time that was observed but could not be attributed. Neutral by
        /// construction — a hue here would imply a category, and the whole point is
        /// that there isn't one. Darkened from `superseded` so it is actually
        /// visible on the page, which it previously was not.
        public static let unattributed = Color(hex: "A79E92")
    }

    // MARK: - The shadow field's five-step attention scale

    /// Trend's cell fill, by attention score. The key swatch and the cell must come
    /// from the same array or the key stops being data.
    public static func attentionStep(_ score: Double) -> Color {
        switch score {
        case ..<0.001: return Data.attention[0]
        case ..<0.25: return Data.attention[1]
        case ..<0.5: return Data.attention[2]
        case ..<0.75: return Data.attention[3]
        default: return Data.attention[4]
        }
    }

    /// The five steps in order, for rendering the `less → more attention` key.
    public static let attentionScale: [Color] = Data.attention

    // MARK: - Project hues

    /// A project's colour is synthesised client-side and stable per id. The backend
    /// has no colour concept, so this must never imply backend meaning — it is a
    /// way to tell two pills apart, nothing more.
    public static func project(id: String) -> Color {
        let hash = id.unicodeScalars.reduce(into: 0) { $0 = $0 &* 31 &+ Int($1.value) }
        return Data.categorical[abs(hash) % Data.categorical.count]
    }

    /// A span in the dial's project band.
    ///
    /// Unattributed gets `superseded` rather than being skipped: it is usually
    /// the largest share of a real day, and an empty stretch would read as "no
    /// data" when it actually means "observed, but not attributable".
    /// Out-of-scope spans drain to the same grey — the band keeps its full
    /// length either way, because the proportion is the finding.
    public static func projectBand(_ project: String?, inScope: Bool) -> Color {
        guard let project else { return Data.unattributed.opacity(inScope ? 0.75 : 0.35) }
        return inScope ? self.project(id: project) : Data.unattributed.opacity(0.4)
    }
}
