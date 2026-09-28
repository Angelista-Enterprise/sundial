import { describe, expect, it } from 'vitest'
import { atFraction, trailScale } from './goal-trail.js'

const DAY = 86_400_000
const now = Date.parse('2026-09-18T12:00:00Z')
const ago = (days) => new Date(now - days * DAY).toISOString()

describe('trailScale', () => {
  it('spans from the oldest thing in the list to now, padded a day each side', () => {
    const scale = trailScale([{ life: [{ at: ago(10) }] }, { life: [{ at: ago(3) }] }], now)
    // 10 days back plus a day of padding at each end.
    expect(scale.days).toBe(12)
    expect(scale.from).toBeLessThan(Date.parse(ago(10)))
    expect(scale.to).toBeGreaterThan(now)
  })

  it('never draws three hours across the whole column', () => {
    // Every goal set this morning would otherwise imply a month of history.
    const scale = trailScale([{ life: [{ at: ago(0.1) }] }], now)
    expect(scale.days).toBeGreaterThanOrEqual(8)
  })

  it('survives a list with no dated goal at all', () => {
    expect(trailScale([], now).days).toBeGreaterThanOrEqual(8)
    expect(trailScale([{ life: [] }, { life: null }], now).days).toBeGreaterThanOrEqual(8)
  })
})

describe('atFraction', () => {
  const scale = trailScale([{ life: [{ at: ago(10) }] }], now)

  it('puts the oldest mark near the left and now near the right', () => {
    expect(atFraction(ago(10), scale)).toBeLessThan(0.15)
    expect(atFraction(new Date(now).toISOString(), scale)).toBeGreaterThan(0.85)
  })

  it('runs forwards', () => {
    expect(atFraction(ago(9), scale)).toBeGreaterThan(atFraction(ago(10), scale))
  })

  it('clamps a stray stamp instead of drawing off the end', () => {
    expect(atFraction(ago(400), scale)).toBe(0)
    expect(atFraction(new Date(now + 400 * DAY).toISOString(), scale)).toBe(1)
  })

  it('says nothing rather than zero for a date it cannot read', () => {
    expect(atFraction('not a date', scale)).toBeNull()
    expect(atFraction(null, scale)).toBeNull()
  })
})
