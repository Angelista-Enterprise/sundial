import { describe, expect, it } from 'vitest'
import { MIN_SCORED, calibrationLine, coverage, lean, reliability, skillVsConstant, skillVsPastBaseline } from './calibration.js'
import { radiusFor } from './reliability.js'

/** The live record's three forecasters, as the tally reports them. */
const DAY_ENDING = { n: 910, hits: 43, brier: 0.010407 }
const HOUR_FRAGMENTED = { n: 568, hits: 118, brier: 0.122522 }
const PROJECT_TOUCHED = { n: 165, hits: 61, brier: 0.188384 }

describe('skill against a constant', () => {
  it('agrees with the offline measurement of the same forecaster', () => {
    // The reason to trust this figure at all. `measure-forecast-skill` scores
    // `day-ending` at +77.4% offline; the same forecaster's live Brier against
    // a constant at its own base rate gives +76.9%. Two independent routes to
    // one number is what makes it a measurement rather than an assertion.
    expect(skillVsConstant(DAY_ENDING)).toBeCloseTo(0.769, 2)
    expect(skillVsConstant(HOUR_FRAGMENTED)).toBeCloseTo(0.256, 2)
    expect(skillVsConstant(PROJECT_TOUCHED)).toBeCloseTo(0.192, 2)
  })

  it('needs no opponent, which is the whole point', () => {
    // The figure it replaces divided by the `base-rate` forecaster's Brier on
    // the same target. `base-rate` has bet three times in the whole record and
    // only on one target, so it produced +72% from a three-observation
    // denominator and filtered the other two forecasters off the board. This
    // one is computable from `n` and `hits` alone.
    expect(skillVsConstant({ n: 100, hits: 20, brier: 0.16 })).toBeCloseTo(0, 6)
    expect(skillVsConstant({ n: 100, hits: 20, brier: 0.08 })).toBeCloseTo(0.5, 6)
  })

  it('refuses a target that always happened, or never did', () => {
    // The constant is already perfect there, so every skill number is a
    // division by zero wearing a percentage.
    expect(skillVsConstant({ n: 40, hits: 40, brier: 0 })).toBe(null)
    expect(skillVsConstant({ n: 40, hits: 0, brier: 0 })).toBe(null)
    expect(skillVsConstant({ n: 0, hits: 0, brier: 0 })).toBe(null)
  })

  it('keeps a floor under which it refuses to rank at all', () => {
    expect(MIN_SCORED).toBeGreaterThanOrEqual(30)
  })
})

describe('reliability, per forecaster', () => {
  // `day-ending`'s real bins: 873 bets in the bottom decile at a 1% hit rate,
  // and 37 bets spread over 30–90% that ALL came true.
  const dayEndingBins = [
    { decile: 0, n: 873, hits: 9 },
    { decile: 3, n: 1, hits: 1 },
    { decile: 4, n: 2, hits: 2 },
    { decile: 5, n: 3, hits: 3 },
    { decile: 6, n: 5, hits: 5 },
    { decile: 7, n: 9, hits: 9 },
    { decile: 8, n: 17, hits: 17 },
  ]

  it('keeps an empty decile rather than dropping it', () => {
    // A forecaster that never says 90% is a fact about the forecaster.
    const rows = reliability(dayEndingBins)
    expect(rows).toHaveLength(10)
    expect(rows[9].n).toBe(0)
    expect(rows[9].observed, 'never said is not zero percent').toBe(null)
    expect(rows[1].observed).toBe(null)
  })

  it('finds the fault a weighted mean cannot see', () => {
    // The first version averaged the whole range weighted by n, and on
    // `day-ending` — 873 of 910 bets in the bottom decile, well calibrated
    // there — it reported "honest" while the 37 bets where the forecaster
    // actually COMMITS all came true. The worst well-sampled decile is the
    // only reading that can find that, and it is the one the owner can act on.
    const worst = lean(reliability(dayEndingBins))
    expect(worst.word).toBe('under-confident')
    expect(worst.from, 'and names the band it happens in').toBeCloseTo(0.8, 6)
    expect(lean(reliability([{ decile: 8, n: 50, hits: 10 }])).word).toBe('over-confident')
    expect(lean(reliability([{ decile: 4, n: 50, hits: 22 }])).word).toBe('honest')
  })

  it('ignores a decile too thin to be evidence of anything', () => {
    // A two-bet decile disagreeing by forty points says nothing at all, and it
    // must not become the verdict just because it is the largest gap.
    const noisy = reliability([{ decile: 0, n: 400, hits: 20 }, { decile: 9, n: 2, hits: 0 }])
    expect(noisy[9].n).toBe(2)
    expect(lean(noisy).from, 'the verdict comes from the well-sampled decile').toBeCloseTo(0, 6)
  })

  it('finds the band a forecaster never enters', () => {
    // The audit's "confidence coverage", and it only means anything per
    // forecaster: `hour-fragmented` has never said more than 57% on 568 bets.
    const band = coverage(reliability([{ decile: 0, n: 453, hits: 45 }, { decile: 4, n: 40, hits: 24 }, { decile: 5, n: 66, hits: 44 }]))
    expect(band.hi).toBeCloseTo(0.6, 6)
    expect(band.lo).toBeCloseTo(0, 6)
    expect(coverage(reliability([])), 'a forecaster with no bets has no band').toBe(null)
  })

  it('builds its one-line meaning from the claim actually made most often', () => {
    // The audit asked for "when I say 3%, it happens 3% of the time". The
    // honest version uses the forecaster's own heaviest decile: a forecaster
    // whose commonest claim is "almost certainly not" should say that, because
    // it is the thing the owner would otherwise read off the chart.
    expect(calibrationLine(reliability(dayEndingBins))).toBe('Most often it says 0–10%, and that happens 1% of the time.')
    expect(calibrationLine(reliability([])), 'and says nothing when it has said nothing').toBe(null)
  })
})

describe('the mark', () => {
  it('scales by area, so twice as wide is four times the bets', () => {
    // A circle drawn at twice the radius is four times the ink; scaling the
    // radius linearly would make a 200-bet decile look four times an 800-bet
    // one's neighbour rather than half of it.
    expect(radiusFor(400, 400)).toBeCloseTo(9, 6)
    expect(radiusFor(100, 400)).toBeCloseTo(4.5, 6)
    expect(radiusFor(0, 400), 'an empty decile is not drawn').toBe(0)
  })

  it('keeps a floor, which is why the scale is per plot', () => {
    // Measured live: against the card's busiest decile (873) every other mark
    // on every plot clamped to the floor — twenty of twenty-one the same size,
    // which is a picture claiming nothing. Scaled within its own plot a small
    // decile is still at the floor sometimes, and that is honest: it really is
    // fifty times smaller. Between plots, the AXES are what compare.
    expect(radiusFor(17, 873), 'against the card-wide busiest').toBe(2.5)
    expect(radiusFor(45, 45), 'against its own plot').toBeCloseTo(9, 6)
  })
})

describe('the fair opponent (K0.3)', () => {
  it('scores the forecaster and the baseline over the SAME rows', () => {
    // The whole arithmetic. `brier` is over every bet; `fairBrier` is over the
    // bets that carry an opponent. Dividing one by the other's baseline would
    // be two populations in one ratio — the fault the reliability bins were
    // rebuilt out of, where 500 rows were binned beside a tally of 1,649.
    expect(skillVsPastBaseline({ fairN: 100, fairBrier: 0.05, baselineBrier: 0.2 })).toBeCloseTo(0.75, 10)
    // Worse than the baseline is a real answer and reads negative.
    expect(skillVsPastBaseline({ fairN: 100, fairBrier: 0.3, baselineBrier: 0.2 })).toBeCloseTo(-0.5, 10)
  })

  it('refuses a figure where there is no contest', () => {
    // No rows with a baseline: the column is new and most of the record
    // predates it. A missing opponent is not a zero one — a zero baseline
    // Brier would make every forecaster infinitely skilful.
    expect(skillVsPastBaseline({ fairN: 0, fairBrier: null, baselineBrier: null })).toBeNull()
    expect(skillVsPastBaseline({ fairN: 10, fairBrier: 0.1, baselineBrier: 0 })).toBeNull()
    expect(skillVsPastBaseline({ fairN: 10, fairBrier: null, baselineBrier: 0.2 })).toBeNull()
  })

  it('does not reuse the all-rows Brier as the fair one', () => {
    // A forecaster with 900 bets and 3 carrying a baseline must not publish
    // its 900-bet score against a 3-bet opponent. The two never mix, so the
    // only input that can produce a fair figure is `fairBrier`.
    const row = { n: 900, hits: 42, brier: 0.04, fairN: 3, fairBrier: 0.09, baselineBrier: 0.18 }
    expect(skillVsPastBaseline(row)).toBeCloseTo(0.5, 10)
    expect(skillVsPastBaseline(row)).not.toBeCloseTo(skillVsConstant(row), 3)
  })
})
