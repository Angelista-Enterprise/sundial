import { describe, expect, it } from 'vitest'
import { liveSpan, localToday } from './span.js'

describe('liveSpan (L1)', () => {
  it('reads a preset against today, so "Today" set last night is this morning', () => {
    const stored = { from: '2026-09-28', to: '2026-09-28', label: 'today', at: '2026-09-28T21:40:00.000Z' }
    expect(liveSpan(stored, '2026-09-29')).toEqual({ from: '2026-09-29', to: '2026-09-29', label: 'today', at: stored.at })
    expect(liveSpan({ from: '2026-09-22', to: '2026-09-28', label: '7d' }, '2026-09-29')).toMatchObject({ from: '2026-09-23', to: '2026-09-29' })
    // Across a month end and the October clock change: dates, not hours.
    expect(liveSpan({ from: '2026-10-01', to: '2026-10-14', label: '14d' }, '2026-10-26')).toMatchObject({ from: '2026-10-13', to: '2026-10-26' })
  })

  it('keeps the dates of a single day and of a custom range', () => {
    const day = { from: '2026-09-24', to: '2026-09-24', label: 'day' }
    const custom = { from: '2026-09-01', to: '2026-09-10', label: 'custom' }
    expect(liveSpan(day, '2026-09-29')).toBe(day)
    expect(liveSpan(custom, '2026-09-29')).toBe(custom)
    expect(liveSpan(null, '2026-09-29')).toBeNull()
  })

  it('names the local day', () => {
    expect(localToday(new Date(2026, 8, 3, 0, 5))).toBe('2026-09-03')
  })
})
