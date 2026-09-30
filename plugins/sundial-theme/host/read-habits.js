// Habits — what Gnomon has learned about how the owner works: routines, open threads, day-end
// samples and rituals, projected from state and the commitments table; nothing is recomputed.
import { routineForecast, routineLabel, topRoutines } from '@sundial/kernel/routines.js'
import { mergeMirrors, rituals } from '@sundial/kernel/rituals.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { classifyActivity, isSystemProcess } from '@sundial/helpers/window-classification.js'
import { getMomentsSince, getOpenCommitments } from '@sundial/db/index.js'

/** How far back a habit is read. Eight weeks is enough for a weekday rhythm and bounds the scan. */
const RITUAL_WEEKS = 8

export async function readHabits({ state, now }) {
  const { trail, learned } = state.routines
  const forecast = routineForecast(trail, learned)
  const dayEnd = state.expectations.dayEnd ?? []
  const recurring = Object.values(state.expectations.recurring ?? {})
  const open = await getOpenCommitments(40)
  // The rituals are read over eight weeks, not over the board's span: a habit
  // is a thing that recurred, and a span of Today would empty the card every
  // morning. The card is pinned and says so, which is the case DESIGN.md
  // allows. Eight weeks also bounds the scan as the log grows.
  const timeZone = loadSundialConfig().timezone
  const since = new Date(now - RITUAL_WEEKS * 7 * 86_400_000).toISOString()
  const observed = await getMomentsSince(since)
  const practised = rituals(
    observed.map((m) => ({
      startTime: m.startTime,
      endTime: m.endTime,
      processName: m.processName,
      projectId: m.projectId,
      intent: m.data?.intent && typeof m.data.intent.text === 'string' ? m.data.intent.text : null,
    })),
    timeZone,
  )
  // What the taxonomy cannot tell apart, and how much of the record it costs.
  //
  // A routine step is `App/class`, and that second half comes from `leisureRules`
  // in config. An app with no entry there classifies as `unknown`, so every step
  // it makes records that it happened and nothing about what it was for. Measured
  // here rather than read off the learned table, because the table is capped at 64
  // rows and evicts by support: a browser the owner adopted last week cannot
  // out-support two months of the old one, so it shows up in the table once and
  // looks like a rounding error when it is in fact most of their day.
  //
  // Free, because the moments are already loaded for the rituals. The lock screen
  // is excluded by the same call `moment-close` uses — it is not an app anyone
  // chose to be in.
  const classes = new Map()
  for (const moment of observed) {
    if (isSystemProcess(moment.processName)) continue
    // EVERY title, not the first. A moment is a whole stretch and carries up to
    // fifty of them; one window with an address in it is enough for the taxonomy
    // to place the stretch. Judged on the first title alone, Chrome read 43%
    // unclassified against 4% measured on the switches themselves — a number the
    // card would have stated as a fact about the owner's browser.
    const titles = Array.isArray(moment.data?.windowTitles) ? moment.data.windowTitles : []
    const seen = classes.get(moment.processName) ?? { seen: 0, blind: 0 }
    seen.seen += 1
    if ((titles.length === 0 ? [''] : titles).every((title) => classifyActivity(moment.processName, title, state.config.leisureRules) === 'unknown')) seen.blind += 1
    classes.set(moment.processName, seen)
  }
  const unclassified = [...classes]
    .filter(([, c]) => c.blind > 0)
    .map(([app, c]) => ({ app, blind: c.blind, seen: c.seen }))
    .sort((a, b) => b.blind - a.blind)
  const lastLearnedAt = Object.values(learned).reduce((latest, r) => (r.lastSeenAt > latest ? r.lastSeenAt : latest), '')
  return {
    routines: {
      learnedCount: Object.keys(learned).length,
      // Mirror pairs merged: `A → B → C` and `C → B → A` are one oscillation
      // seen from both ends, and the card reported them as two habits.
      top: mergeMirrors(topRoutines(learned, 24)).map((r) => ({ label: routineLabel(r), steps: r.steps, support: r.support, mirrored: r.mirrored, lastSeenAt: r.lastSeenAt, firstSeenAt: r.firstSeenAt })),
      trail: trail.map((step) => step.split('/')[0]),
      forecast: forecast === null ? null : { next: forecast.expectedProcess, from: routineLabel(forecast.routine), support: forecast.routine.support },
      lastLearnedAt: lastLearnedAt === '' ? null : lastLearnedAt,
      unclassified,
    },
    rituals: { weeks: RITUAL_WEEKS, observed: observed.length, timeZone, list: practised },
    commitments: {
      open: open.map((c) => ({
        id: c.id,
        name: c.name,
        // `git-branch` or (J4.4) `speech` — a promise heard aloud, which the row can close by hand.
        source: c.source,
        branch: c.branch,
        project: c.projectName ?? null,
        touches: c.touches,
        activeDays: c.activeDays,
        lastTouchedAt: c.lastTouchedAt,
        quietDays: Math.floor((now - Date.parse(c.lastTouchedAt)) / 86_400_000),
        // Mirrors the live thread's marker, so the page says which ones Gnomon
        // already spoke about.
        fadingNoticed: state.commitments.open.find((t) => t.id === c.id)?.fadingNoticedAt ?? null,
        // UC1: a promise's terms (person, due and where it came from, confirmed), from the row.
        promise: c.promise ? { counterparty: state.memory.aliasNames?.[c.promise.counterparty] ?? c.promise.counterparty ?? null, deliverable: c.promise.deliverable, direction: c.promise.direction, due: c.promise.due ?? null, dueKind: c.promise.dueKind, nextMeeting: c.promise.nextMeeting?.title ?? null, confirmed: c.promise.confirmed === true, evidence: (c.promise.evidence ?? []).filter((e) => !e.strong).map((e) => e.text).slice(-2) } : null,
      })),
    },
    expectations: {
      // Newest last, minutes from local midnight. The page draws these as a
      // line; the slope is bedtime drift, which no surprise detector can see.
      dayEnd: dayEnd.slice(-21),
      recurring: recurring
        .filter((r) => r.intervalMs?.n >= 3)
        .sort((a, b) => b.intervalMs.n - a.intervalMs.n)
        .slice(0, 20)
        .map((r) => ({ stream: r.stream, bucket: r.bucket, n: r.intervalMs.n, meanIntervalMin: Math.round(r.intervalMs.mean / 60_000), lastSeenAt: r.lastSeenAt })),
    },
  }
}
