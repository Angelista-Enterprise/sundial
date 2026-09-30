// Rhythm: what the owner's days look like over the span — when they start and stop, how much was watched — with the attention numbers as a ribbon.
import { shiftDate, spanFrom } from './http.js'
import { buildWorkShape } from '@sundial/kernel/work-shape.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { localDayRange, WAKING_DAY_START_HOUR, wakingDate, wakingMinute } from '@sundial/helpers/local-day.js'
import { getActivityHours, getCommitsBetween, getContextSwitchesBetween, getDayArcs, getInterruptionsBetween, getObservedHours, getProfileFact, getShellRunsBetween, getThrashingBetween } from '@sundial/db/index.js'

export async function readRhythm({ state, now, url }) {
  const timeZone = loadSundialConfig().timezone
  const asked = spanFrom(url, () => state, 28)
  // A floor of four weeks, because a weekday is a column here and two
  // samples a column is not a rhythm — the same argument the coverage
  // calendar makes, and the same measurement behind it.
  const days = Math.min(90, Math.max(14, asked.pinned ? asked.days : Math.max(28, asked.days)))
  const until = url.searchParams.get('until') ?? asked.to
  const to = localDayRange(until, timeZone).end
  const from = localDayRange(shiftDate(until, -(days - 1)), timeZone).start
  const range = { from, to }

  const [arcs, observedHours, activityHours, switches, thrashing, interruptions, shellRuns, commits] = await Promise.all([
    // Each moment in its own day in the owner's zone, so a daylight saving change inside the window moves nothing.
    getDayArcs(from, to, timeZone),
    getObservedHours(),
    getActivityHours(range),
    getContextSwitchesBetween(range),
    getThrashingBetween(range),
    getInterruptionsBetween(range),
    getShellRunsBetween(range),
    getCommitsBetween(range),
  ])

  // Observed hours per local day, from the log — the same measure the Trust
  // card's calendar draws, and the reason this card never prints a flat 24.
  // `buildWorkShape` reports `observedHours: 24` on every single day, which
  // is a claim that the daemon watched every hour of every one of them; the
  // log says 13.3, 11.9, 12.2 for the same three days.
  // Per local HOUR, not per day. A day total cannot draw a hatch: Gnomon
  // often runs more hours than the owner works, so `observed / span` is
  // above 1 on an ordinary day and the underlay came out full width on every
  // row — a picture saying every day was completely watched, which is the
  // flat-24 fault in a different costume. The hatch needs to know WHICH
  // hours, so the route sends them.
  //
  // K0.6 — bucketed on the WAKING day and indexed from 04:00, so the hatch
  // and the arc above it describe the same twenty-four hours. Left on the
  // calendar day they would disagree for exactly the seven days this item
  // exists to fix: the arc would say "this evening ran to 00:33" while the
  // hatch under it drew the following morning.
  const watched = new Map()
  for (const { hour, share } of observedHours) {
    const at = new Date(`${hour}:00:00.000Z`)
    const day = wakingDate(at.toISOString(), timeZone)
    const slot = wakingMinute(at.toISOString(), timeZone) / 60
    const byHour = watched.get(day) ?? new Array(24).fill(0)
    byHour[Math.floor(slot)] = Math.min(1, byHour[Math.floor(slot)] + share)
    watched.set(day, byHour)
  }

  const shape = buildWorkShape({ from, to, timeZone, activityHours, switches, thrashing, interruptions, shellRuns, commits })
  const byDate = new Map(shape.days.map((day) => [day.date, day]))
  return {
    from,
    to,
    timeZone,
    // The owner's own words about their bedtime, asked rather than assumed.
    // The audit wanted the band drawn against "the 23:00 intent line"; the
    // record's answer is that there is no such intent, and a line drawn from
    // one evening's remark across a belief that disclaims having a target is
    // the same fault as a gate bar taken from a constant the dial has moved.
    intent: await getProfileFact('asleepBy'),
    // K0.6 — the WAKING day, so "today" names the same row the arcs do. At
    // 00:30 the owner's day is still yesterday's, and a `now` tick on the
    // calendar date would jump to an empty row at midnight.
    today: wakingDate(new Date(now).toISOString(), timeZone),
    nowMin: wakingMinute(new Date(now).toISOString(), timeZone),
    dayStartsAt: WAKING_DAY_START_HOUR,
    days: arcs.map((arc) => ({
      ...arc,
      hours: (watched.get(arc.date) ?? new Array(24).fill(0)).map((share) => Math.round(share * 100) / 100),
      observedHours: Math.round((watched.get(arc.date) ?? []).reduce((sum, share) => sum + share, 0) * 100) / 100,
      switches: byDate.get(arc.date)?.switches ?? null,
      interruptions: byDate.get(arc.date)?.interruptions ?? null,
    })),
    attention: { totals: shape.totals, switchesByHour: shape.switchesByHour, suspects: shape.suspects, days: shape.days.map((day) => ({ date: day.date, thrashingBursts: day.thrashingBursts, thrashingFlips: day.thrashingFlips, thrashingBurstsMeasured: day.thrashingBurstsMeasured })) },
  }
}
