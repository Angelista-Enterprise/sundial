import { describe, expect, it } from 'vitest'
import { spanFrom, today } from './http.js'

describe('today', () => {
  // 23:30 UTC on the 1st is already the 2nd in Amsterdam and still the 1st in New York.
  const now = new Date('2026-03-01T23:30:00Z')
  it('is the day in config.timezone, not the machine zone', () => {
    expect(today('Europe/Amsterdam', now)).toBe('2026-03-02')
    expect(today('America/New_York', now)).toBe('2026-03-01')
  })
  it('spanFrom resolves the board span against that day', () => {
    const state = { config: { timezone: 'Europe/Amsterdam' }, board: { span: { label: '7d', from: '2026-01-01', to: '2026-01-07' } } }
    const span = spanFrom(new URL('http://x/'), () => state, 1, now)
    expect(span).toMatchObject({ from: '2026-02-24', to: '2026-03-02', days: 7, label: '7d', pinned: false })
    expect(spanFrom(new URL('http://x/?date=2026-02-10'), () => state, 1, now)).toMatchObject({ from: '2026-02-10', days: 1, pinned: true })
  })
})
