// The day: its closed moments, trimmed to what a row states (when, how long, what, where, how deep, whether the intent pass described it).
import { spanFrom } from './http.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { getMomentsForDate } from '@sundial/db/index.js'

const MINUTE = 60_000

export async function readDay({ state, url }) {
  const timeZone = loadSundialConfig().timezone
  const date = spanFrom(url, () => state).date
  const moments = await getMomentsForDate(date, timeZone)
  return {
    date,
    timeZone,
    count: moments.length,
    moments: moments.map((moment) => {
      const data = moment.data ?? {}
      return {
        id: moment.id,
        startTime: moment.startTime,
        // Both ends and the raw span, because the shared moment detail builds
        // its sentence from them ("21:00–21:31 · 31 min deep focus").
        endTime: moment.endTime,
        durationMs: moment.durationMs,
        durationMin: Math.round(moment.durationMs / MINUTE),
        // Input-backed minutes beside wall minutes: presence is not work, and
        // the gap between the two is the honest part of the row.
        activeMin: typeof data.activeMs === 'number' ? Math.round(data.activeMs / MINUTE) : null,
        processName: moment.processName,
        projectId: moment.projectId,
        kind: data.kind ?? null,
        focusQuality: data.focusQuality ?? null,
        focusScore: typeof data.focusScore === 'number' ? data.focusScore : null,
        location: data.location ?? null,
        gitBranch: data.gitBranch ?? null,
        intent: data.intent && typeof data.intent.text === 'string' ? data.intent.text : null,
        title: Array.isArray(data.windowTitles) ? data.windowTitles[0] ?? null : null,
        // The substance, so a row can be opened into the shared moment
        // detail without a second request. Window titles are the one
        // unbounded field here (the analysis pass sends up to 50), and a
        // day of sixty moments carrying fifty titles each is a payload
        // nobody reads — the detail shows a handful and says so.
        data: { ...data, windowTitles: Array.isArray(data.windowTitles) ? data.windowTitles.slice(0, 12) : data.windowTitles },
      }
    }),
  }
}
