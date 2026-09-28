import { describe, expect, it } from 'vitest'
import { MIN_NIGHTS, bedtimeCensus, bedtimeWeeks, isoWeek } from './bedtime.js'

/** Minutes on the waking axis: 04:00 is 0, midnight is 1200, 02:00 is 1320. */
const at = (h, m = 0) => ((h - 4 + 24) % 24) * 60 + m

/** A week of stop times, as `/gnomon/rhythm` serves the rows. */
const week = (from, stops) =>
  stops.map((min, i) => {
    const d = new Date(`${from}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return { date: d.toISOString().slice(0, 10), lastMin: min }
  })

describe('the weekly band', () => {
  it('takes the middle half, not the extremes', () => {
    // Min-to-max was measured on the live record and ran six to thirteen hours,
    // because the low end is not a bedtime — it is a day the owner barely
    // opened the machine (one stops at 19:15 after three minutes of activity).
    // A band whose bottom edge is "the day I did almost nothing" measures
    // attendance.
    const days = week('2026-09-07', [at(12), at(20), at(21), at(22), at(23), at(23, 30), at(1)])
    const [w] = bedtimeWeeks(days)
    expect(w.n).toBe(7)
    expect(w.lo, 'the 12:00 outlier is outside the middle half').toBeGreaterThan(at(19))
    expect(w.mid).toBe(at(22))
  })

  it('keeps a night past midnight above the evening it belongs to', () => {
    // The whole reason this is buildable. On the waking axis 01:00 is minute
    // 1260 and 23:00 is 1140, so a late night sorts ABOVE a normal one instead
    // of wrapping to the bottom — no clamp, no special case, no arrow.
    const days = week('2026-09-07', [at(22), at(23), at(0, 30), at(2)])
    const [w] = bedtimeWeeks(days)
    expect(w.hi).toBeGreaterThan(at(23))
    expect(at(2), '02:00 is minute 1320').toBe(1320)
  })

  it('marks a thin week rather than dropping it', () => {
    // A quiet week is a fact about the week. A silently missing row reads as a
    // gap in the record, which is a different claim.
    const [w] = bedtimeWeeks(week('2026-09-07', [at(21), at(22)]))
    expect(w.n).toBe(2)
    expect(w.thin).toBe(true)
    expect(MIN_NIGHTS).toBe(4)
  })

  it('puts each day in the week its date belongs to', () => {
    expect(isoWeek('2026-09-07').key).toBe(isoWeek('2026-09-13').key)
    expect(isoWeek('2026-09-13').key).not.toBe(isoWeek('2026-09-14').key)
    expect(isoWeek('nonsense')).toBeNull()
  })
})

describe('what the series says', () => {
  it('reports the typical spread as a median of weeks, not of nights', () => {
    // One thin or wild week should not decide how variable a habit is, which
    // is the same argument the coverage calendar and the typical day already
    // make for quartiles over means.
    const weeks = [
      ...bedtimeWeeks(week('2026-08-31', [at(20), at(21), at(22), at(23)])),
      ...bedtimeWeeks(week('2026-09-07', [at(19), at(20), at(21), at(22)])),
      ...bedtimeWeeks(week('2026-09-14', [at(12), at(21), at(22), at(3)])),
    ]
    const c = bedtimeCensus(weeks)
    expect(c.weeks).toBe(3)
    expect(c.typicalSpread).toBeGreaterThan(0)
    expect(c.latestMid).toBeGreaterThan(c.earliestMid)
  })

  it('counts the weeks whose middle half reaches past midnight', () => {
    const weeks = [
      ...bedtimeWeeks(week('2026-08-31', [at(20), at(21), at(22), at(23)])),
      ...bedtimeWeeks(week('2026-09-07', [at(23), at(23, 30), at(0, 30), at(1, 30)])),
    ]
    expect(bedtimeCensus(weeks).pastMidnight).toBe(1)
  })

  it('refuses a census where every week is thin', () => {
    // Three nights cannot say how variable a bedtime is, and a figure computed
    // from them would be the card claiming something the record cannot back.
    expect(bedtimeCensus(bedtimeWeeks(week('2026-09-07', [at(21), at(22)])))).toBeNull()
    expect(bedtimeCensus([])).toBeNull()
  })
})
