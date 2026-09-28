// The noticing gate, read out of its own decision rows.
//
// **The card's subject is the BAR, not the rows.** That is the whole design,
// and it came from counting the rows first. `gate_decisions` holds 234
// verdicts over 38 days with 153 distinct keys — and 94 of the 104 non-ask
// keys appear on exactly ONE day, because the key embeds a date, a week
// number, a ULID or an hour bucket: `return-from-break:2026-09-11`,
// `work-shelved:01M2Q1G9M…`, `day-end-drift:w2957`. A list of one-offs is a
// log. Nobody tunes anything from a log.
//
// What recurs, and what the owner can actually change, is one bar: a weight to
// clear before Gnomon says anything in passing, and a higher one before it
// interrupts. So every row on this card is
// EVIDENCE ABOUT WHERE THAT NUMBER SHOULD SIT, and the audit's own framing is
// the test — "a dropped row with weight 0.52 against a bar of 0.55 is a
// different fact from one at 0.05". Drawn on a shared weight axis, sorted by
// that axis, those two rows land in visibly different places and the card
// needs no sentence to say which is which.
//
// Four things fell out of the counting and one out of the browser, and each
// one changed what gets drawn:
//
// 0. **The bar is not a constant, and the first draw of this card got it
//    wrong.** `noticeGate` scales both thresholds by `2 ** settings.noticeBias`
//    before it weighs anything, and the bias on this machine is −1 — so the
//    live bars are 0.28 and 0.80, and five rows the gate SAID sat below a line
//    the card had labelled "below this Gnomon says nothing at all". See
//    `barsFor`. Worse, the decision rows do not store the threshold they were
//    measured against, so historic rows cannot be placed against their own
//    bar; the card draws today's, counts the rows that disagree with it, and
//    says on its face that this is what that count means.
// 1. **The asks come off.** 63 of the 234 decisions are `owner-question`, and
//    every single one has `weight` exactly 2.0 and `habituation` exactly 1.0.
//    The gate does nothing to an ask but price the interruption; nothing here
//    could be tuned by looking at one, and an ask has had its own card since
//    I7. Leaving them in would have made a quarter of this card's rows a
//    constant.
// 2. **Habituation has one customer.** Of the 27 rows the gate ever suppressed
//    as `habituated`, 14 are `absent:flow|weekend` and 13 are a
//    `return-from-break:<date>` repeating inside its own day — and 94 of the
//    104 keys have been weighed on exactly ONE day, because the key names one
//    event. One key in the whole record has been seen on more than three days.
//    That is a finding about key naming, not a term to draw per row.
// 4. **Only the ambient bar applies to everything.** `decide` settles the
//    channel from the candidate's own `valueHalfLifeMs` BEFORE any threshold,
//    so something that keeps is measured against 0.28 however heavy it is and
//    never reaches the interrupting path — 46 rows sit above 0.80 and went out
//    as ambient. The list is therefore cut at one bar, not two, and the other
//    stays on the axis as a reference. `valueHalfLifeMs` is not stored, but
//    `phasic`, `deferred` and a priced cost only ever happen on that path, so
//    the count is exact.
// 3. **There is no single weight that separates said from refused, and that
//    is the headline.** The card's first draw counted "near misses" — drops
//    within a fifth of the bar — and the moving dial made the number
//    meaningless: against 0.55 it was 25 of 50, against the live 0.28 it was
//    43 of 50, which is the "every case lands in the same place" tell
//    DESIGN.md names for a figure. What the dial CANNOT spoil is the OVERLAP:
//    the gate has admitted things as light as 0.36 and refused things as
//    heavy as 1.59, and 45 admissions and 35 refusals share that band. In
//    August there was no overlap at all — admitted started at 1.00, refused
//    stopped at 0.97 — so the band is itself the record of the dial moving.
//
// Pure, and free of the display layer, so it can be tested against the live
// record's own numbers the way `asks.js` is.

/**
 * The two bars as SHIPPED — the policy's own constants, and not necessarily
 * where the gate's bar stands today.
 *
 * Copied deliberately rather than served from the route: they are constants in
 * `DEFAULT_GATE_POLICY` and a card that draws a bar has to know where to draw
 * it before any data arrives. `gate.test.js` holds these against the rule's own
 * file, which is what stops the copy from drifting.
 */
export const SHIPPED_TONIC_BAR = 0.55
export const SHIPPED_PHASIC_BAR = 1.6
/**
 * Ambient notices a local day allows. FOUR, not the six the audit's brief
 * wrote — and the brief's whole header sentence, "budget today: 5/6 spent — 3
 * held back", is wrong three times over. The budget is 4. A notice at or above
 * `budgetExemptAbove` (1.6, the interrupt bar) never counted against it, so
 * "spent" and "said" are different numbers. And "held back" reads as the
 * `deferred` channel, which is a live queue that gets re-scored every minute,
 * while what the brief meant is `budget-spent`, a permanent drop — 18 rows in
 * the record, on 8 of its 30 days, and none today.
 */
export const GATE_DAILY_BUDGET = 4

/**
 * Where the two bars actually stand, given the owner's own dial.
 *
 * **This is the fault the card was caught in on the day it shipped.** Drawn
 * against the shipped constants, five rows the gate SAID sat visibly below a
 * line labelled "below this Gnomon says nothing at all" — which reads as a
 * rendering fault and is in fact the truth: `noticeBias` is −1 on this
 * machine, `noticeGate` scales BOTH thresholds by `2 ** bias`, and the live
 * bars are therefore 0.28 and 0.80. A card whose entire subject is the bar
 * cannot draw the wrong one.
 *
 * The same arithmetic as the rule, held against the rule's own source by
 * `gate.test.js` — the dial is one line in `noticeGate` and a second copy of
 * it here would be a second policy wearing a picture.
 */
export function barsFor(bias) {
  const scale = 2 ** (Number.isFinite(bias) ? bias : 0)
  return { tonic: SHIPPED_TONIC_BAR * scale, phasic: SHIPPED_PHASIC_BAR * scale, bias: Number.isFinite(bias) ? bias : 0 }
}

/**
 * What the dial did, in the owner's words — or nothing at all when it is where
 * it shipped. Absent, not zero: "you have not moved the dial" on every read is
 * a line that trains the eye to skip the paragraph it sits in.
 */
export function biasSentence(bars) {
  if (!bars?.bias) return null
  const notches = Math.abs(bars.bias)
  const step = `${notches} ${notches === 1 ? 'notch' : 'notches'}`
  return bars.bias < 0
    ? `You have turned noticing DOWN ${step}, so both bars are lower than they ship: ${bars.tonic.toFixed(2)} and ${bars.phasic.toFixed(2)} rather than ${SHIPPED_TONIC_BAR} and ${SHIPPED_PHASIC_BAR}.`
    : `You have turned noticing UP ${step}, so both bars are higher than they ship: ${bars.tonic.toFixed(2)} and ${bars.phasic.toFixed(2)} rather than ${SHIPPED_TONIC_BAR} and ${SHIPPED_PHASIC_BAR}.`
}

/**
 * What happened to a decision, in one word the owner can say.
 *
 * Four channels collapse to three, because `tonic` and `phasic` are both
 * "Gnomon said it" from where the owner sits — the difference is whether it
 * interrupted, and that is the row's own detail rather than its state.
 */
export function outcomeOf(row) {
  if (row?.channel === 'tonic' || row?.channel === 'phasic') return 'said'
  if (row?.channel === 'deferred') return 'held'
  return 'dropped'
}

/**
 * Why, as a sentence with the arithmetic in it.
 *
 * The shipped card had a lookup of one-word reasons whose keys did not match
 * what the rule actually writes — `below-bar`, `too-soon` and `focus` are not
 * `reason` values, so three of its seven entries could never fire and
 * `below-threshold` fell through to "below threshold", which is the storage in
 * a nicer font. These are the five the rule emits, plus `owner-silent`, and
 * each one says which number settled it.
 */
export function whySentence(row) {
  const w = (n) => (Number.isFinite(n) ? n.toFixed(2) : '?')
  switch (row?.reason) {
    // **Neither of these two names a number for the bar, and that is
    // deliberate.** The bar moves with the owner's dial and `gate_decisions`
    // does not store which one a row was weighed against, so a sentence saying
    // "it cleared 0.28" would be wrong on every row decided at a different
    // setting — 171 small lies against one caveat said once in the census. The
    // row's own weight is exact; which side of its own bar it fell on is exact,
    // because that is what `reason` records. Where the bar stood is not.
    case 'admitted':
      return row.channel === 'phasic'
        ? `it was worth ${w(row.utility)} after the cost of breaking in, and that cleared the bar to interrupt you`
        : `it came to ${w(row.weight)}, which cleared the bar for saying something in passing`
    case 'below-threshold':
      return `it came to ${w(row.weight)}, under the bar it needed`
    case 'habituated':
      return `you have heard this key often enough that its response fell to ${w(row.habituation)}, taking it to ${w(row.weight)}`
    case 'budget-spent':
      return `it was worth ${w(row.weight)} and the day's ambient budget was already gone`
    case 'too-costly-now':
      return `it was worth ${w(row.weight)}, but interrupting then cost ${w(row.interruptionCost)} — held for a cheaper moment`
    case 'owner-silent':
      return 'you had noticing turned off, so it was never weighed'
    default:
      return String(row?.reason ?? '').replace(/-/g, ' ')
  }
}

/**
 * The scale the picture shares: two doublings of the bar below it, four above.
 *
 * **Log, and the first reason is the owner's own control.** `noticeBias` moves
 * both thresholds by `2 ** bias` — one notch is a doubling, wherever the bar
 * happens to be. An axis on which a doubling is the same distance everywhere
 * is therefore the axis that dial is read on, and "how many notches would I
 * have to turn this to catch that row" becomes a distance the eye can measure.
 * A weight is also a PRODUCT of four factors, and a product belongs on a log
 * scale; that is the second reason and it would not have been enough alone.
 *
 * **Anchored on the bar, not on the rows.** The draft before this was a root
 * scale fitted to the data, and measured in the browser it put the bar 11% up
 * the picture and spent the top half of the frame on eight outliers — 160 of
 * 173 marks inside a third of it, which is the "every mark lands in the same
 * place" fault one step short of arriving. Anchored on the bar instead, the
 * window travels with the dial and the bar keeps its place in the frame.
 *
 * **And the window is not symmetric, which was measured rather than chosen.**
 * Everything the gate does other than refuse lives ABOVE the bar: the
 * interrupt bar is a doubling up, `budgetExemptAbove` sits with it, and the
 * record's heaviest decisions are four doublings up. Below it there is only
 * "not worth saying", and the record puts 2 of its 173 rows more than two
 * doublings under. Symmetric, the bottom three octaves of the frame carried
 * five marks — a third of the picture for 3% of it, which is the same empty
 * third `height: auto` once left on the strata. Six octaves hold 164 of 173;
 * the other 9 clamp to ends that are labelled as ends, and every mark still
 * carries its exact number in its hover and in its row.
 */
export const AXIS_BELOW = 2
export const AXIS_ABOVE = 4

export function weightScale(bars) {
  const bar = Math.max((bars ?? barsFor(0)).tonic, 0.0001)
  return { lo: bar / 2 ** AXIS_BELOW, hi: bar * 2 ** AXIS_ABOVE, bar }
}

/**
 * A row's weight, expressed against the bar the CARD is drawing — K0.2.
 *
 * The axis is anchored on the bar and every gridline is a doubling of it, so a
 * mark's position already means "this many doublings above the bar". That only
 * holds if every mark was measured against the SAME bar, and it was not: the
 * dial scales both thresholds by `2 ** noticeBias`, and a decision reached at
 * a different setting belongs at a different place. A row that carries its own
 * `tonicBar` is rescaled into the card's — same number of doublings above its
 * own line, which is what the axis means — so the picture stays true however
 * often the owner moves the dial.
 *
 * A row from before the column existed has no bar and keeps its raw weight.
 * That is the old, unresolvable case: it is drawn against today's line and
 * counted in `movedBar`, which is the card saying out loud how much of its own
 * picture it cannot vouch for.
 */
export function placedWeight(row, cardBar) {
  const own = typeof row?.tonicBar === 'number' && row.tonicBar > 0 ? row.tonicBar : null
  const weight = row?.weight ?? 0
  return own === null || !(cardBar > 0) ? weight : weight * (cardBar / own)
}

/** Where a weight lands on that scale, 0..1. */
export const weightAt = (weight, scale) => {
  const clamped = Math.min(Math.max(weight ?? 0, scale.lo), scale.hi)
  return (Math.log2(clamped) - Math.log2(scale.lo)) / (Math.log2(scale.hi) - Math.log2(scale.lo))
}

/** Every doubling of the bar, which is the picture's own grid. */
export const octaves = (scale) => {
  const out = []
  for (let step = -AXIS_BELOW; step <= AXIS_ABOVE; step += 1) out.push(scale.bar * 2 ** step)
  return out
}

/** What the whole record says about the bar, as counts the card states on its face. */
export function gateCensus(rows, bars) {
  const list = Array.isArray(rows) ? rows : []
  const bar = (bars ?? barsFor(0)).tonic
  const days = new Set()
  // Days per key, not a guess at the key's shape. An earlier draft read the
  // key's TEXT for a date, a week number or a ULID and called the rest
  // recurring, which put the count at 65 of 104 on a rule of thumb. The record
  // answers the same question exactly — how many keys the gate has weighed on
  // more than one day — and a measurement beats a regex, which is DESIGN.md's
  // rule about figures applied to a sentence.
  const daysByKey = new Map()
  const reasons = {}
  const outcomes = { said: 0, held: 0, dropped: 0 }
  // The overlap: the lightest thing the bar ever ADMITTED and the heaviest it
  // ever REFUSED. Computed off `reason` alone, which is each row's own verdict
  // about its own bar, so no threshold enters the arithmetic and the moving
  // dial cannot touch it. The other reasons are excluded on purpose —
  // `budget-spent`, `too-costly-now` and `habituated` are not the bar
  // refusing, they are the other three levers, and mixing them in would make
  // every band on every card overlap by construction.
  let lightestSaid = Infinity
  let heaviestRefused = -Infinity
  let habituatedKeys = new Set()
  // Rows the interrupting path ever weighed. `decide` settles the channel from
  // `valueHalfLifeMs` before any threshold, and that field is not stored — but
  // the three things it leaves behind are: `phasic` and `deferred` only happen
  // on that path, and only that path ever prices a cost. Without this the card
  // would report the interrupt bar as if all 171 rows had met it, and 46 rows
  // above it went out as ambient.
  let urgent = 0
  // Decisions the gate refused while they sat ABOVE the bar it now draws. The
  // shape the eye actually reads off the picture — a dense run of dropped
  // marks over the rule — and the sharpest form of the card's argument: on the
  // live record it is 69 of 97, and not one thing the gate SAID sits below the
  // bar. Whatever is doing the refusing here, it is mostly not the bar.
  let refusedAboveBar = 0
  let judged = 0
  let worthSaying = 0
  let movedBar = 0
  // K0.2 — how many rows can be placed against the bar they actually met.
  let placedRows = 0

  for (const row of list) {
    days.add(String(row.decidedAt ?? '').slice(0, 10))
    const seen = daysByKey.get(row.noticeKey) ?? new Set()
    seen.add(String(row.decidedAt ?? '').slice(0, 10))
    daysByKey.set(row.noticeKey, seen)
    reasons[row.reason] = (reasons[row.reason] ?? 0) + 1
    outcomes[outcomeOf(row)] += 1
    if (row.channel === 'phasic' || row.channel === 'deferred' || row.interruptionCost > 0) urgent += 1
    // K0.2 — every comparison to the bar uses the row's OWN bar where it has
    // one. `placedWeight` rescales it into the card's, which on this axis is
    // the same statement: so many doublings above the line it actually met.
    const at = placedWeight(row, bar)
    if (outcomeOf(row) === 'dropped' && at >= bar) refusedAboveBar += 1
    if (row.reason === 'admitted') lightestSaid = Math.min(lightestSaid, at)
    if (row.reason === 'below-threshold') heaviestRefused = Math.max(heaviestRefused, at)
    // A row on the wrong side of the bar the card is drawing — and since K0.2
    // only a row that PREDATES the column can be one.
    //
    // The old story: `gate_decisions` stored no threshold, so a decision
    // reached under a different `noticeBias` was drawn against today's bar and
    // could land on the wrong side of it — five rows on the live record were
    // SAID at weights under the shipped 0.55, which read as a rendering fault
    // and was in fact the dial. A row carrying its own bar is placed against
    // it and is right by construction, so this count is now exactly "how many
    // rows cannot be placed at all", and it only ever falls. `reason` stays
    // the ground truth for the rest: `admitted` cleared its bar,
    // `below-threshold` did not.
    if (typeof row.tonicBar !== 'number') {
      if (row.reason === 'admitted' && row.weight < bar) movedBar += 1
      if (row.reason === 'below-threshold' && row.weight >= bar) movedBar += 1
    } else {
      placedRows += 1
    }
    if (row.reason === 'habituated') habituatedKeys.add(row.noticeKey)
    if (row.verdict) {
      judged += 1
      if (row.verdict === 'useful') worthSaying += 1
    }
  }

  // Everything inside the band, counted on a second pass — the band is not
  // known until the first one has finished.
  const overlap = { lo: lightestSaid, hi: heaviestRefused, said: 0, refused: 0 }
  if (Number.isFinite(overlap.lo) && Number.isFinite(overlap.hi) && overlap.hi > overlap.lo) {
    for (const row of list) {
      // K0.2 — the same placed weight the band's ends were computed from.
      const at = placedWeight(row, bar)
      if (at < overlap.lo || at > overlap.hi) continue
      if (row.reason === 'admitted') overlap.said += 1
      if (row.reason === 'below-threshold') overlap.refused += 1
    }
  }

  return {
    total: list.length,
    overlap: overlap.said > 0 && overlap.refused > 0 ? overlap : null,
    days: days.size,
    keys: daysByKey.size,
    // Keys the gate has met on exactly one day — the ones a worn-down response
    // can never be read on again.
    oneDayKeys: [...daysByKey.values()].filter((seen) => seen.size === 1).length,
    reasons,
    ...outcomes,
    movedBar,
    placedRows,
    urgent,
    refusedAboveBar,
    belowThreshold: reasons['below-threshold'] ?? 0,
    habituatedKeys: habituatedKeys.size,
    judged,
    worthSaying,
  }
}
