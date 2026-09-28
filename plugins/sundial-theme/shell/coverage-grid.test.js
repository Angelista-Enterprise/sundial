import { describe, expect, it } from 'vitest'
import { coverageWeeks, gridGeometry, weekdayOf, weekdayTypical } from './coverage-grid.js'

const DAYS = [
  { date: '2026-09-14', hours: 10.25 }, // Monday
  { date: '2026-09-15', hours: 10.94 },
  { date: '2026-09-16', hours: 7.78 },
  // 09-17 missing on purpose: a hole, not a zero.
  { date: '2026-09-18', hours: 11.94 },
  { date: '2026-09-19', hours: 1.32 },
  { date: '2026-09-20', hours: 0.15 },
  { date: '2026-09-21', hours: 14.96 }, // Monday
]

describe('the coverage calendar', () => {
  it('starts every week on Monday', () => {
    // ISO order, because a week of work starts on Monday and the whole point
    // of the columns is the weekday rhythm.
    expect(weekdayOf('2026-09-14')).toBe(0)
    expect(weekdayOf('2026-09-20')).toBe(6)
  })

  it('pads to whole weeks so the columns line up', () => {
    const weeks = coverageWeeks(DAYS)
    expect(weeks).toHaveLength(2)
    for (const week of weeks) expect(week.days).toHaveLength(7)
    expect(weeks[0].from).toBe('2026-09-14')
    expect(weeks[1].days.slice(1).every((day) => day.hours === null), 'padding past the last day is a hole').toBe(true)
  })

  it('keeps a missing day as a hole, never as a zero', () => {
    // The distinction the card exists for: the daemon NOT RUNNING and the
    // daemon watching almost nothing are different claims, and 09-20 at 0.15
    // hours is the second one.
    const [week] = coverageWeeks(DAYS)
    const missing = week.days.find((day) => day.date === '2026-09-17')
    expect(missing.hours, 'a day with no rows at all').toBe(null)
    expect(week.days.find((day) => day.date === '2026-09-20').hours, 'a day with almost none').toBe(0.15)
  })

  it('takes the median of a weekday, not the mean', () => {
    // Wednesday runs 1.77 to 23.9 hours on the live record. A mean is dragged
    // by one all-nighter and one dead day in opposite directions and describes
    // neither end.
    const typical = weekdayTypical([
      { date: '2026-09-02', hours: 2 },
      { date: '2026-09-09', hours: 10 },
      { date: '2026-09-16', hours: 24 },
    ])
    expect(typical[2].median, 'Wednesday').toBe(10)
    expect(typical[2].n).toBe(3)
    expect(typical[0].median, 'a weekday with no samples says nothing rather than zero').toBe(null)
  })

  it('takes its height from the width it was given', () => {
    // The owner's verdict on the first draw was "doesn't scale well": a
    // 250px-tall, 520px-capped grid left two thirds of a wide card empty and
    // collided its own weekday names. The height now follows the width, so a
    // wider card gets a bigger calendar rather than the same one with more
    // paper beside it.
    const weeks = coverageWeeks(DAYS)
    const narrow = gridGeometry(400, weeks)
    const wide = gridGeometry(1100, weeks)
    expect(wide.cellW).toBeGreaterThan(narrow.cellW)
    expect(wide.height).toBeGreaterThan(narrow.height)
    // And past a point it spends the room on spelling its heads out rather
    // than on being bigger. Never on a number inside the cell: the cell's own
    // ground is the value, so no ink clears 4.5:1 on it around half opacity —
    // measured on both papers, drawn, and taken out again.
    expect('numbered' in wide, 'the in-cell number was removed, not merely hidden').toBe(false)
    expect(narrow.spelled, 'a narrow head cannot spell out its median').toBe(false)
    expect(wide.spelled).toBe(true)
    expect(narrow.named, 'nor a full weekday name').toBe(false)
    expect(wide.named).toBe(true)
    // Never taller than it is wide per cell — a calendar, not a column chart.
    expect(wide.cellH).toBeLessThan(wide.cellW)
  })
})
