import { describe, expect, it, vi } from 'vitest'

const cal = (title, startDate, extra = {}) => ({ signalType: 'calendar', eventType: 'upcoming', capturedAt: startDate, data: { event: { eventId: `id-${title}`, title, startDate, attendees: ['Mira Bakker'], ...extra } } })
vi.mock('@sundial/db/index.js', () => ({
  getAllEntities: async () => [],
  // Before attendance existed: a call app held the mic through one meeting; Sundial's own hearing through another.
  getAllSignalsInRange: async () => [
    { signalType: 'media', eventType: 'state', capturedAt: '2026-10-01T09:10:00.000Z', data: { audioInput: true, audioInputProcess: 'zoom.us' } },
    { signalType: 'media', eventType: 'state', capturedAt: '2026-10-02T09:10:00.000Z', data: { audioInput: true, audioInputProcess: 'Sundial' } },
  ],
  getSignalsInRange: async () => [
    cal('On a call, before attendance existed', '2026-10-01T09:00:00.000Z', { endDate: '2026-10-01T09:30:00.000Z' }),
    cal('Only Sundial listening', '2026-10-02T09:00:00.000Z', { endDate: '2026-10-02T09:30:00.000Z' }),
    cal('Declined long ago', '2026-10-01T10:00:00.000Z', { selfStatus: 'declined' }),
    cal('Joined', '2026-10-08T09:00:00.000Z'),
    cal('Only on the calendar', '2026-10-08T11:00:00.000Z'),
    { signalType: 'meeting', eventType: 'attended', capturedAt: '2026-10-08T09:35:00.000Z', data: { event: { eventId: 'Joined|2026-10-08T09:00:00.000Z', attendees: ['Mira Bakker'] } } },
  ],
}))
vi.mock('@sundial/helpers/sundial-config.js', () => ({ loadSundialConfig: () => ({ timezone: 'UTC' }) }))

describe('calendarEvents (who the owner met)', () => {
  it('counts only meetings the owner was in — rebuilt from the call and speech signals before attendance existed — and never a declined one', async () => {
    const { calendarEvents } = await import('./read-people.js')
    const titles = (await calendarEvents(Date.parse('2026-10-09T00:00:00Z'))).map(([, e]) => e.title)
    expect(titles).toEqual(['On a call, before attendance existed', 'Joined'])
  })
})
