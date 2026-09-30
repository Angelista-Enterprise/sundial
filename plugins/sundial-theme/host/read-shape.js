// The shape of the work over the span, from `buildWorkShape` in the kernel (one definition of a day).
import { shiftDate, spanFrom } from './http.js'
import { buildWorkShape } from '@sundial/kernel/work-shape.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDayRange } from '@sundial/helpers/local-day.js'
import { getActivityHours, getCommitsBetween, getContextSwitchesBetween, getInterruptionsBetween, getShellRunsBetween, getThrashingBetween } from '@sundial/db/index.js'

export async function readShape({ state, url }) {
  const timeZone = loadSundialConfig().timezone
  // Fourteen was hardcoded in two copies of the client's route table and
  // duplicated again in the reader; the board's span replaces both. A span of
  // one day would draw a one-bar shape, which says nothing, so this one keeps
  // a floor of a fortnight unless the caller asked for less on purpose.
  const asked = spanFrom(url, () => state, 14)
  const days = Math.min(60, Math.max(1, asked.pinned ? asked.days : Math.max(14, asked.days)))
  const until = url.searchParams.get('until') ?? asked.to
  // Whole local days, inclusive of `until`, so the window never cuts a day in
  // half — a half-day at either edge would be a phantom low-activity row.
  const to = localDayRange(until, timeZone).end
  const from = localDayRange(shiftDate(until, -(days - 1)), timeZone).start
  const range = { from, to }

  const [activityHours, switches, thrashing, interruptions, shellRuns, commits] = await Promise.all([
    getActivityHours(range),
    getContextSwitchesBetween(range),
    getThrashingBetween(range),
    getInterruptionsBetween(range),
    getShellRunsBetween(range),
    getCommitsBetween(range),
  ])

  return buildWorkShape({ from, to, timeZone, activityHours, switches, thrashing, interruptions, shellRuns, commits })
}
