// Today's numbers: the day's context for one date, and the files worked in most today.
import { spanFrom, today } from './http.js'
import { buildDailyContext } from '@sundial/kernel/daily-context.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'

/** Top files of the day from `state.files.hot`: path, project, changes. */
function hotFilesOf(state) {
  const hot = Object.values(state?.files?.hot ?? {})
  return hot
    .sort((a, b) => b.changes - a.changes)
    .slice(0, 6)
    .map((f) => ({ path: f.relPath, project: f.projectRoot.split('/').pop() ?? f.projectRoot, changes: f.changes, focusedChanges: f.focusedChanges, lastAt: f.lastAt }))
}

export async function readToday({ state, url }) {
  const date = spanFrom(url, () => state).date
  const context = await buildDailyContext(date, { timeZone: loadSundialConfig().timezone })
  return {
    date,
    coverage: context.coverage,
    focus: context.focus,
    noProjectMin: context.noProjectMin,
    // Biggest first: the day's shape is the finding, and a list in
    // record order buries it.
    projects: [...context.projects]
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 6)
      .map((project) => ({ name: project.name, minutes: project.minutes, commits: project.commits, confidence: project.confidence })),
    noticed: context.anomalies.slice(0, 4).map((anomaly) => ({ title: anomaly.title, body: anomaly.body })),
    meetings: context.meetings.length,
    // The files worked in most today, off the fold's hot-files ring. Only
    // for today: the ring is reset at the day boundary.
    hotFiles: date === today(state?.config?.timezone) ? hotFilesOf(state) : [],
  }
}
