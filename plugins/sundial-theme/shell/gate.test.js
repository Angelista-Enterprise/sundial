import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AXIS_ABOVE, AXIS_BELOW, GATE_DAILY_BUDGET, SHIPPED_PHASIC_BAR, SHIPPED_TONIC_BAR, barsFor, biasSentence, gateCensus, octaves, outcomeOf, weightAt, weightScale, whySentence, placedWeight } from './gate.js'

const SHIPPED = barsFor(0)

const HERE = dirname(fileURLToPath(import.meta.url))
const RULE = readFileSync(join(HERE, '../../../packages/rules/src/notice-gate.ts'), 'utf8')

describe('the bars this card draws', () => {
  // A constant is only pinned if it is pinned against something that is not
  // itself. The card cannot import `DEFAULT_GATE_POLICY` — `gnomon-theme` does
  // not depend on `@sundial/rules`, and adding the dependency for three numbers
  // is not worth it — so the copies are held against the rule's own source.
  // Without this the card would go on drawing a bar at 0.55 the day the policy
  // moved it, and nothing would look broken.
  const field = (name) => Number(new RegExp(`${name}:\\s*([0-9.]+)`).exec(RULE)?.[1])

  it('matches DEFAULT_GATE_POLICY', () => {
    expect(field('tonicThreshold')).toBe(SHIPPED_TONIC_BAR)
    expect(field('phasicThreshold')).toBe(SHIPPED_PHASIC_BAR)
    expect(field('dailyBudget')).toBe(GATE_DAILY_BUDGET)
  })

  it('says every reason the rule can actually emit', () => {
    // The shipped card had a lookup of seven one-word reasons, and three of
    // its keys — `below-bar`, `too-soon`, `focus` — are not values the rule
    // ever writes, so they could never fire and `below-threshold` fell through
    // to its own storage. This holds the sentences against the union.
    const union = /reason:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(RULE)?.[1] ?? ''
    const reasons = [...union.matchAll(/'([a-z-]+)'/g)].map(([, r]) => r)
    expect(reasons.length).toBeGreaterThan(4)
    // And none of them quotes a bar. The dial moves it and the decision row
    // does not store which one it was weighed against, so a per-row sentence
    // naming a threshold is wrong on every row decided at another setting.
    for (const reason of reasons) {
      const said = whySentence({ reason, channel: 'tonic', weight: 0.4, utility: 0.4, habituation: 0.3, interruptionCost: 0.5 })
      expect(said, `${reason} must read as a sentence, not as its own storage`).not.toContain(reason.replace(/-/g, ' '))
      expect(said.length, `${reason} must say something`).toBeGreaterThan(20)
      expect(/\b0\.55\b|\b1\.6\b|\b0\.28\b|\b0\.80\b/.test(said), `${reason} must not quote a bar the record does not store`).toBe(false)
    }
  })
})

describe('the shared weight axis', () => {
  it('keeps the bar in the same place whatever the dial says', () => {
    // Anchored on the bar, not on the rows. The draft before this fitted the
    // scale to the data and measured out at 11% up the frame with the top half
    // spent on eight outliers. Here the window travels with the dial, so the
    // picture reads the same at every setting — two doublings of headroom
    // below the bar and four above, which is where everything else the gate
    // does actually happens.
    const place = AXIS_BELOW / (AXIS_BELOW + AXIS_ABOVE)
    for (const bias of [-2, -1, 0, 1]) {
      const bars = barsFor(bias)
      expect(weightAt(bars.tonic, weightScale(bars))).toBeCloseTo(place, 6)
    }
    expect(weightAt(barsFor(0).phasic, weightScale(barsFor(0))), 'the interrupt bar is one doubling up, and on the picture').toBeLessThan(1)
  })

  it('makes one notch of the dial the same distance anywhere on the axis', () => {
    // The whole reason the axis is log: `noticeBias` moves both thresholds by
    // `2 ** bias`, so a doubling is what the owner's control actually does.
    // On this axis a doubling is a constant distance, which turns "how many
    // notches would catch that row" into something the eye can measure.
    const scale = weightScale(SHIPPED)
    const step = weightAt(0.5, scale) - weightAt(0.25, scale)
    for (const [a, b] of [[0.25, 0.5], [1, 2], [2, 4], [4, 8]]) {
      expect(weightAt(b, scale) - weightAt(a, scale)).toBeCloseTo(step, 6)
    }
  })

  it('clamps an outlier to an end that says it is an end', () => {
    // 14.35 is the record's heaviest and the next is 5.95. It pins to the top
    // rather than stretching the axis over it — and the ends are labelled, so
    // a pinned mark is not a mark claiming a weight it does not have.
    const scale = weightScale(SHIPPED)
    expect(weightAt(14.35, scale)).toBe(1)
    expect(weightAt(0.001, scale)).toBe(0)
    expect(scale.hi).toBeCloseTo(SHIPPED_TONIC_BAR * 2 ** AXIS_ABOVE, 6)
  })

  it('separates a near miss from a row that said nothing', () => {
    // The audit's own example, and what a linear axis could not do: 0.05 and
    // 0.52 would both land in the first eighth of it.
    const scale = weightScale(SHIPPED)
    expect(weightAt(0.52, scale) - weightAt(0.05, scale)).toBeGreaterThan(0.25)
    expect(weightAt(0.52, scale)).toBeLessThan(weightAt(SHIPPED.tonic, scale))
  })

  it('grids the picture in doublings of the bar, the bar among them', () => {
    const scale = weightScale(SHIPPED)
    const steps = octaves(scale)
    expect(steps).toHaveLength(AXIS_BELOW + AXIS_ABOVE + 1)
    expect(steps[AXIS_BELOW]).toBeCloseTo(SHIPPED.tonic, 6)
    expect(steps[0]).toBeCloseTo(scale.lo, 6)
    expect(steps[steps.length - 1]).toBeCloseTo(scale.hi, 6)
  })
})

describe('what the record says about the gate', () => {
  it('counts a key the gate has only ever met once, from the record', () => {
    // The finding the census states, and it is a measurement rather than a
    // reading of the key's text: an earlier draft matched dates and ULIDs with
    // a regex and got 65 of 104 where the record says 94.
    const c = gateCensus(
      [
        { noticeKey: 'once', reason: 'admitted', channel: 'tonic', weight: 1, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'once', reason: 'admitted', channel: 'tonic', weight: 1, decidedAt: '2026-09-01T18:00:00.000Z' },
        { noticeKey: 'twice', reason: 'admitted', channel: 'tonic', weight: 1, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'twice', reason: 'admitted', channel: 'tonic', weight: 1, decidedAt: '2026-09-02T10:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.keys).toBe(2)
    expect(c.oneDayKeys, 'twice in one day is still one day').toBe(1)
  })

  it('finds the band where the bar has said and refused the same weight', () => {
    // The card's headline, and the reason it replaced a near-miss count: the
    // bar moves with the dial, so a figure measured against it says whatever
    // the dial says. This one is measured against the rows alone.
    const c = gateCensus([
      { noticeKey: 'a', reason: 'below-threshold', weight: 0.52, channel: 'suppressed', decidedAt: '2026-09-01T10:00:00.000Z' },
      { noticeKey: 'b', reason: 'below-threshold', weight: 0.05, channel: 'suppressed', decidedAt: '2026-09-01T11:00:00.000Z' },
      { noticeKey: 'c', reason: 'admitted', weight: 0.9, channel: 'tonic', decidedAt: '2026-09-02T11:00:00.000Z', verdict: 'useful' },
      { noticeKey: 'd', reason: 'admitted', weight: 0.4, channel: 'tonic', decidedAt: '2026-09-02T12:00:00.000Z' },
    ], SHIPPED)
    expect(c.overlap).toEqual({ lo: 0.4, hi: 0.52, said: 1, refused: 1 })
    expect(c.belowThreshold).toBe(2)
    expect(c.said).toBe(2)
    expect(c.dropped).toBe(2)
    expect(c.days).toBe(2)
    expect(c.judged).toBe(1)
    expect(c.worthSaying).toBe(1)
  })

  it('reports no band when the bar has been clean', () => {
    // August's own shape: everything admitted was heavier than everything
    // refused. Absent, not zero — a band of nothing is not a finding.
    const c = gateCensus(
      [
        { noticeKey: 'a', reason: 'below-threshold', weight: 0.2, channel: 'suppressed', decidedAt: '2026-08-16T10:00:00.000Z' },
        { noticeKey: 'b', reason: 'admitted', weight: 1.4, channel: 'tonic', decidedAt: '2026-08-16T11:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.overlap).toBe(null)
  })

  it('never lets another lever widen the band', () => {
    // A `budget-spent` drop at 4.84 is not the bar refusing anything, and
    // counting it would make every record overlap by construction.
    const c = gateCensus(
      [
        { noticeKey: 'a', reason: 'budget-spent', weight: 4.84, channel: 'suppressed', decidedAt: '2026-08-15T10:00:00.000Z' },
        { noticeKey: 'b', reason: 'admitted', weight: 1.4, channel: 'tonic', decidedAt: '2026-08-16T11:00:00.000Z' },
        { noticeKey: 'c', reason: 'below-threshold', weight: 0.2, channel: 'suppressed', decidedAt: '2026-08-16T12:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.overlap).toBe(null)
  })

  it('draws the bar the owner actually set, not the one that shipped', () => {
    // The fault this card was caught in live. `noticeGate` scales BOTH
    // thresholds by `2 ** settings.noticeBias` before weighing anything, and
    // the bias on the live machine is −1 — so the card drew a line at 0.55
    // with five rows the gate had SAID sitting below it. The rule's own
    // expression is held here, because a second copy of the dial would be a
    // second policy wearing a picture.
    expect(/2 \*\* \(settings\?\.noticeBias \?\? 0\)/.test(RULE), 'the rule must still scale the bars by the dial').toBe(true)
    expect(/tonicThreshold: DEFAULT_GATE_POLICY\.tonicThreshold \* scale/.test(RULE)).toBe(true)
    expect(/phasicThreshold: DEFAULT_GATE_POLICY\.phasicThreshold \* scale/.test(RULE)).toBe(true)
    const down = barsFor(-1)
    expect(down.tonic).toBeCloseTo(0.275, 5)
    expect(down.phasic).toBeCloseTo(0.8, 5)
    expect(biasSentence(down)).toContain('DOWN')
    expect(biasSentence(barsFor(0)), 'absent, not zero, where the dial has not moved').toBe(null)
  })

  it('counts a row the moved bar now puts on the wrong side of the line', () => {
    // `gate_decisions` has no threshold column, so a decision reached under a
    // different dial is drawn against today's bar and can land on the wrong
    // side of it. `reason` is the ground truth about each row's OWN bar.
    const c = gateCensus(
      [
        { noticeKey: 'a', reason: 'admitted', channel: 'tonic', weight: 0.42, decidedAt: '2026-09-21T10:00:00.000Z' },
        { noticeKey: 'b', reason: 'below-threshold', channel: 'suppressed', weight: 0.3, decidedAt: '2026-09-21T10:00:00.000Z' },
        { noticeKey: 'c', reason: 'admitted', channel: 'tonic', weight: 0.9, decidedAt: '2026-09-21T10:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.movedBar, 'only the 0.42 that was SAID disagrees with a bar of 0.55; the 0.30 drop agrees with it').toBe(1)
    expect(gateCensus([{ noticeKey: 'a', reason: 'admitted', channel: 'tonic', weight: 0.42, decidedAt: '2026-09-21T10:00:00.000Z' }], barsFor(-1)).movedBar, 'and it stops disagreeing under the bar that was actually in force').toBe(0)
  })

  it('counts what the bar refused while it sat above the bar', () => {
    // The shape the eye reads off the picture, and the card's argument in one
    // number: on the live record 69 of the 97 dropped decisions are ABOVE the
    // line, and nothing said is below it. Whatever keeps Gnomon quiet is
    // mostly not the bar.
    const c = gateCensus(
      [
        { noticeKey: 'a', channel: 'suppressed', reason: 'budget-spent', weight: 1.2, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'b', channel: 'suppressed', reason: 'below-threshold', weight: 0.9, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'c', channel: 'suppressed', reason: 'below-threshold', weight: 0.1, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'd', channel: 'tonic', reason: 'admitted', weight: 2, decidedAt: '2026-09-01T10:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.refusedAboveBar, 'the budget drop and the stale below-threshold one, not the 0.1').toBe(2)
  })

  it('counts only the rows the interrupting path ever weighed', () => {
    // 46 rows on the live record sit above the interrupt bar and went out as
    // AMBIENT: `decide` settles the channel from `valueHalfLifeMs` before any
    // threshold, so a thing that keeps never meets that bar at all. The field
    // is not stored; these three leavings are what identify the path.
    const c = gateCensus(
      [
        { noticeKey: 'a', channel: 'phasic', reason: 'admitted', weight: 2, interruptionCost: 0, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'b', channel: 'deferred', reason: 'too-costly-now', weight: 2, interruptionCost: 0.8, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'c', channel: 'suppressed', reason: 'below-threshold', weight: 0.2, interruptionCost: 0.4, decidedAt: '2026-09-01T10:00:00.000Z' },
        { noticeKey: 'd', channel: 'tonic', reason: 'admitted', weight: 5, interruptionCost: 0, decidedAt: '2026-09-01T10:00:00.000Z' },
      ],
      SHIPPED,
    )
    expect(c.urgent, 'the heavy tonic row was never eligible to interrupt').toBe(3)
  })

  it('reads all four channels as three words the owner can say', () => {
    expect(outcomeOf({ channel: 'tonic' })).toBe('said')
    expect(outcomeOf({ channel: 'phasic' })).toBe('said')
    expect(outcomeOf({ channel: 'deferred' })).toBe('held')
    expect(outcomeOf({ channel: 'suppressed' })).toBe('dropped')
  })
})

describe('a row is placed against the bar it actually met (K0.2)', () => {
  // The axis is anchored on the bar and every gridline is a doubling of it, so
  // a mark's height already means "this many doublings above the bar". That is
  // only true if every mark met the same bar, and the dial means they do not.
  it('rescales a row weighed under a different dial into the card\'s own bar', () => {
    // Weighed at 0.55 and worth exactly its bar; the card now draws 0.275.
    // It belongs ON the line, not at twice it.
    expect(placedWeight({ weight: 0.55, tonicBar: 0.55 }, 0.275)).toBeCloseTo(0.275, 10)
    // Two doublings above its own bar stays two doublings above the card's.
    expect(placedWeight({ weight: 2.2, tonicBar: 0.55 }, 0.275)).toBeCloseTo(1.1, 10)
  })

  it('leaves a row with no recorded bar exactly where its weight puts it', () => {
    // The unresolvable case. It is drawn against today's line and counted in
    // the card's "cannot be placed" sentence — never quietly moved, because
    // the dial's value at the time is not stored anywhere.
    expect(placedWeight({ weight: 0.9 }, 0.275)).toBe(0.9)
    expect(placedWeight({ weight: 0.9, tonicBar: null }, 0.275)).toBe(0.9)
    expect(placedWeight({ weight: 0.9, tonicBar: 0 }, 0.275)).toBe(0.9)
  })

  it('counts only the unplaceable rows as disagreeing with the line', () => {
    // Before K0.2 every row that crossed today's bar was a caveat. Now a row
    // carrying its own bar is right by construction, so `movedBar` is exactly
    // "rows from before the column existed", a number that only ever falls.
    const bars = { tonic: 0.275, phasic: 0.8, bias: -1 }
    const c = gateCensus(
      [
        // Said at 0.4 under the OLD 0.55 bar: impossible, so this row must
        // carry its bar or it reads as a rendering fault.
        { noticeKey: 'a', kind: 'k', channel: 'tonic', reason: 'admitted', weight: 0.4, utility: 0.4, interruptionCost: 0, decidedAt: '2026-09-20T10:00:00.000Z', tonicBar: 0.275 },
        { noticeKey: 'b', kind: 'k', channel: 'suppressed', reason: 'below-threshold', weight: 0.5, utility: 0.5, interruptionCost: 0, decidedAt: '2026-09-20T11:00:00.000Z', tonicBar: 0.55 },
        // No bar: the old rows.
        { noticeKey: 'c', kind: 'k', channel: 'tonic', reason: 'admitted', weight: 0.1, utility: 0.1, interruptionCost: 0, decidedAt: '2026-09-01T10:00:00.000Z' },
      ],
      bars,
    )
    expect(c.placedRows).toBe(2)
    expect(c.movedBar).toBe(1)
  })
})
