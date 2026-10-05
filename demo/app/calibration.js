// Whether Gnomon's confidence is worth anything.
//
// **The card's subject, and the number it could not compute before.** Three
// forecasters are live, and the only questions worth asking about any of them
// are: does it mean what it says, is it better than guessing, and is it still
// learning. The surface this replaces answered none of the three honestly.
//
// **The skill figure was computed against a three-sample opponent, and hid the
// two best forecasters entirely.** `skillVsBase` compared each forecaster's
// Brier against the `base-rate` forecaster on the same target. `base-rate` has
// bet three times in the whole record, only on `hour-fragmented`, so
// `prev-hour-lag` was shown at **+72%** against a denominator of three
// observations — while `day-ending` and `project-touched`, which have no
// `base-rate` opponent at all, were filtered off the leaderboard by the very
// join that produced the number.
//
// `skillVsConstant` needs no opponent. The reference is the Brier score a
// forecaster would have got by saying the target's own observed base rate
// every single time, which for a constant `p` equal to that rate is exactly
// `p(1 − p)` — computable from `n` and `hits`, which the tally already has.
// On the live record it gives +77%, +26% and +19%, and the first of those
// matches the offline measurement of the same forecaster (+77.4% in
// `measure-forecast-skill`) to within a rounding place. That agreement is the
// reason to trust it.
//
// It is an ORACLE constant — the base rate is computed with hindsight over the
// same bets it is scoring — so it is a slightly generous opponent and the card
// says so rather than quietly claiming a fairer one.
//
// **K0.3 supplies the fairer one.** Every prediction now carries `base_prob`,
// the target's running mean over PRIOR resolutions, so `skillVsPastBaseline`
// scores against a constant a forecaster could actually have bet. It is
// reported beside the oracle rather than instead of it, because it only exists
// for rows written after the column did and a card that swapped one figure for
// the other would be comparing two populations without saying so.

/** Below this a Brier score is noise and the card refuses to rank it. */
export const MIN_SCORED = 30

/**
 * Skill against always saying the target's own base rate: `1 − Brier/p(1−p)`.
 *
 * Null when there is nothing to compare against — no bets, or a target that
 * never happened and never failed to, where the constant is already perfect
 * and every skill number is a division by zero wearing a percentage.
 */
export function skillVsConstant({ n, hits, brier }) {
  if (!(n > 0)) return null
  const rate = hits / n
  const reference = rate * (1 - rate)
  if (!(reference > 0)) return null
  return 1 - brier / reference
}

/**
 * Skill against the opponent a forecaster could actually have bet — K0.3.
 *
 * `skillVsConstant` above fits its constant with HINDSIGHT to the same bets it
 * scores, which makes it a slightly generous opponent; the card said so and
 * could do no better, because nothing stored what the base rate was AT THE
 * TIME. Every prediction now carries `base_prob`, the target's running mean
 * over prior resolutions only, and this scores against that.
 *
 * **Both Briers are computed over the same rows, and that is the whole
 * arithmetic.** `fairBrier` is the forecaster's score over the rows that carry
 * an opponent, not over all of them. Dividing the all-rows Brier by the
 * baseline's would be two populations in one ratio — the fault the reliability
 * bins were rebuilt out of, where 500 rows were binned beside a tally of
 * 1,649. `fairN` travels with the answer so a caller can refuse a figure with
 * too few rows behind it, and the card prints it.
 *
 * Null wherever there is no contest: no rows with a baseline, or a baseline
 * that was already perfect (Brier 0), where every skill number is a division
 * by zero wearing a percentage.
 */
export function skillVsPastBaseline({ fairN, fairBrier, baselineBrier }) {
  if (!(fairN > 0) || typeof fairBrier !== 'number' || typeof baselineBrier !== 'number') return null
  if (!(baselineBrier > 0)) return null
  return 1 - fairBrier / baselineBrier
}

/**
 * What a forecaster's claims and outcomes look like, decile by decile.
 *
 * `gap` is observed minus claimed at the decile's midpoint: positive means the
 * thing happened MORE often than it was promised (under-confident), negative
 * less (over-confident). Empty deciles are kept — a forecaster that never says
 * 90% is a fact about the forecaster, and dropping the bin hides it.
 */
export function reliability(bins) {
  const out = []
  for (let decile = 0; decile < 10; decile++) {
    const bin = (bins ?? []).find((row) => row.decile === decile)
    const n = bin?.n ?? 0
    const observed = n > 0 ? bin.hits / n : null
    const claimed = decile / 10 + 0.05
    out.push({ decile, from: decile / 10, to: (decile + 1) / 10, claimed, n, hits: bin?.hits ?? 0, observed, gap: observed === null ? null : observed - claimed })
  }
  return out
}

/**
 * The band a forecaster never enters — the audit's "confidence coverage", and
 * it only means anything PER forecaster.
 *
 * `hour-fragmented` has never once said more than 57%: on 568 bets its highest
 * claim is a coin flip with a lean. That is a real limit on what it can ever
 * be useful for, and pooled with two other forecasters it was invisible.
 */
export function coverage(rows) {
  const used = (rows ?? []).filter((row) => row.n > 0)
  if (used.length === 0) return null
  const lo = used[0].from
  const hi = used[used.length - 1].to
  return { lo, hi, never: hi < 1 || lo > 0 }
}

/**
 * What calibration MEANS for this forecaster, in one line the owner can check.
 *
 * The audit asked for "when I say 3%, it happens 3% of the time" and the
 * honest version of that sentence is built from the forecaster's own heaviest
 * decile — the claim it actually makes most often — rather than from a
 * hypothetical 3%. A forecaster whose commonest claim is "almost certainly
 * not" should say so, because that is the thing the owner would otherwise have
 * to read off a chart.
 */
export function calibrationLine(rows) {
  const used = (rows ?? []).filter((row) => row.n > 0)
  if (used.length === 0) return null
  const busiest = used.reduce((most, row) => (row.n > most.n ? row : most), used[0])
  const claimed = `${Math.round(busiest.from * 100)}–${Math.round(busiest.to * 100)}%`
  const happened = `${Math.round(busiest.observed * 100)}%`
  return `Most often it says ${claimed}, and that happens ${happened} of the time.`
}

/** A decile under this many bets is not evidence of anything. */
const ENOUGH = 10

/**
 * Where a forecaster is wrong, in a band the owner can name.
 *
 * **Not a weighted mean, which was the first version and was useless here.**
 * `day-ending` puts 873 of its 910 bets in the bottom decile and is well
 * calibrated there, so any average over the whole range reports it "honest" —
 * while the 37 bets where it actually COMMITS, at 30–90%, came true every
 * single time. The fault is real, it is the only interesting thing about that
 * forecaster, and a mean centred on the dominant bin can never see it.
 *
 * So this reports the worst well-sampled decile and says which one. Under- and
 * over-confidence stay separate words: a forecaster that hedges is losing
 * value it already has, and one that overclaims is spending trust it has not
 * earned.
 */
export function lean(rows) {
  let worst = null
  for (const row of rows ?? []) {
    if (row.observed === null || row.n < ENOUGH) continue
    if (worst === null || Math.abs(row.gap) > Math.abs(worst.gap)) worst = row
  }
  if (worst === null) return null
  const word = Math.abs(worst.gap) < 0.1 ? 'honest' : worst.gap > 0 ? 'under-confident' : 'over-confident'
  return { gap: worst.gap, word, from: worst.from, to: worst.to, n: worst.n }
}
