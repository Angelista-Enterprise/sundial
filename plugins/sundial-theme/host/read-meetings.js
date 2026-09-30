// The meetings of one day with their calendar times, from the calendar log (a week before the day finds every one) — the windows Explore's Said reads speech inside.
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDate, localDayRange } from '@sundial/helpers/local-day.js'
import { getSignalsInRange } from '@sundial/db/index.js'

export async function readMeetings({ now, url }) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') ?? '') ? url.searchParams.get('date') : localDate(new Date(now).toISOString(), loadSundialConfig().timezone)
  const { start, end } = localDayRange(date, loadSundialConfig().timezone)
  const rows = await getSignalsInRange(new Date(Date.parse(start) - 7 * 86_400_000).toISOString(), end, 20_000, ['calendar'])
  const events = new Map()
  for (const row of rows) {
    const e = row?.data?.event
    if (!e?.title || e.isAllDay || !e.startDate || e.startDate < start || e.startDate >= end) continue
    events.set(`${e.title}|${e.startDate}`, { title: String(e.title ?? 'a meeting'), start: e.startDate, end: e.endDate ?? e.startDate, attendees: Array.isArray(e.attendees) ? e.attendees.length : 0 })
  }
  return { date, meetings: [...events.values()].sort((a, b) => a.start.localeCompare(b.start)) }
}
