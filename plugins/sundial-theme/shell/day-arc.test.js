import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arcHours, atMinute, typicalDay } from './day-arc.js'
import { WAKING_DAY_START_HOUR } from './day-hours.js'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Days as `/gnomon/rhythm` serves them — K0.6, so the minutes count from
 * 04:00. Two of these run past midnight (`lastMin` over 1200) and they are
 * ordinary rows now, not exclusions.
 */
const DAYS = [
  { date: '2026-09-15', firstMin: 192, lastMin: 872 },
  { date: '2026-09-16', firstMin: 238, lastMin: 1015 },
  { date: '2026-09-17', firstMin: 203, lastMin: 1174 },
  { date: '2026-09-18', firstMin: 280, lastMin: 1233 },
  { date: '2026-09-19', firstMin: 265, lastMin: 1320 },
  { date: '2026-09-21', firstMin: 267, lastMin: 1090 },
]

describe('the shared 24-hour bar', () => {
  it('puts the same minute at the same x on every row', () => {
    // The only reason to stack them. Midnight at the left edge, midnight at
    // the right, and nothing in between that depends on the day.
    expect(atMinute(0, 422)).toBe(1)
    expect(atMinute(24 * 60, 422)).toBe(421)
    expect(atMinute(12 * 60, 422)).toBe(211)
  })

  it('clamps rather than drawing off the end', () => {
    expect(atMinute(-30, 422)).toBe(1)
    expect(atMinute(9999, 422)).toBe(421)
  })

  it('thins its hour labels when the card is narrow', () => {
    // Twenty-four labels in 300 pixels is a grey smear, not a scale.
    expect(arcHours(700).map((h) => h.at)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24])
    expect(arcHours(320).map((h) => h.at)).toEqual([0, 6, 12, 18, 24])
    // K0.6 — the POSITION runs 0..24 and the LABEL is the clock hour there,
    // which on a bar starting at 04:00 is 04, 07, … 01, 04. Reading one as the
    // other names the wrong hour on every tick.
    expect(arcHours(700).map((h) => h.label)).toEqual(['04', '07', '10', '13', '16', '19', '22', '01', '04'])
  })
})

describe('the typical day', () => {
  it('leaves no day out, because the late ones are what it is about', () => {
    // K0.6 overturned the exclusion. It existed because a night past midnight
    // looked like a day that began AND ended at midnight — and measured, not
    // one moment in the record ends at 23:59, so nothing was ever clipped. The
    // nine suspect days were seven late nights and two ordinary ones, and
    // dropping them dropped exactly the evidence this measure needs.
    const typical = typicalDay(DAYS)
    expect(typical.n, 'all six').toBe(6)
  })

  it('takes quartiles, not a mean', () => {
    // Same argument as the coverage calendar's: one all-nighter and one dead
    // day drag a mean in opposite directions and it describes neither.
    const skewed = [
      { firstMin: 480, lastMin: 1080 },
      { firstMin: 490, lastMin: 1090 },
      { firstMin: 500, lastMin: 1100 },
      { firstMin: 1300, lastMin: 1430 },
    ]
    expect(typicalDay(skewed).firstMid, 'the outlier does not move the middle').toBeLessThan(600)
  })

  it('refuses to describe a typical day from two days', () => {
    expect(typicalDay(DAYS.slice(0, 2))).toBe(null)
    expect(typicalDay([])).toBe(null)
  })
})

describe('the waking day (K0.6)', () => {
  it('keeps the client constant equal to the helper that buckets the rows', () => {
    // The client cannot import a workspace package — the shell is plain ES
    // modules served from disk — so the hour lives in two files. When one
    // drifts nothing looks broken: the axis simply names the wrong hour on
    // every tick, while the bars stay where they are.
    const helper = readFileSync(join(HERE, '../../../packages/helpers/src/local-day.ts'), 'utf8')
    const declared = /export const WAKING_DAY_START_HOUR = (\d+)/.exec(helper)
    expect(declared, 'the helper still declares it').not.toBeNull()
    expect(Number(declared[1])).toBe(WAKING_DAY_START_HOUR)
  })

  it('puts a late night near the right-hand end rather than at the left', () => {
    // The whole point of the boundary. 01:00 is minute 1260 of a day that
    // began at 04:00, so it sits at 87% of the bar; on a midnight axis it was
    // minute 60 and sat at 4%, on the wrong row, reading as an early start.
    const oneAm = (1 + 24 - WAKING_DAY_START_HOUR) * 60
    expect(oneAm).toBe(1260)
    expect(atMinute(oneAm, 422)).toBeGreaterThan(atMinute(12 * 60, 422))
  })
})
