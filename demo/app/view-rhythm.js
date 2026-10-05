// The rhythm: the shape of the owner's days over weeks.
import { el } from './surfaces.js'
import { arcHours, bedtimeBand, dayArc, typicalDay } from './day-arc.js'
import { bedtimeCensus, bedtimeWeeks } from './bedtime.js'

/**
 * What the owner's days actually look like.
 *
 * **The card this replaces was a nine-column table of counters** — switches,
 * same-app, thrash, interrupts, shell, commits, churn — one row a day, and
 * nothing in it answered the question a card called Shape is for. The audit
 * renamed it Rhythm and named the hero: stacked day-arcs, first touch to last
 * activity, today against typical. That is what leads now, and the counters
 * are a ribbon underneath.
 *
 * **Three of the brief's items were refused by the record, and one was a
 * defect the brief had already spotted.**
 *
 * `observedHours` reported a flat **24 on every single day** — a claim that
 * the daemon watched every hour of every one of them. The log says 13.3, 11.9
 * and 12.2 for the same three days. The brief's "`observedHours` hatch like
 * day, never a flat 24" was right, and the fix is to read the same log the
 * Trust card's calendar reads rather than to hatch a wrong number.
 *
 * **The "bedtime-spread band" was refused on a premise that did not hold, and
 * K0.6 overturned it.** The refusal said a moment belongs to the local day it
 * STARTS in, so a night past midnight ends the old day at 23:59 and opens the
 * next at 00:00, and nine of forty-one days carried such a mark — nine nights
 * in the same place, the "every case lands in the same place" tell. Measured,
 * **not one moment in the record ends at 23:59.** Nothing is clipped. What the
 * nine days actually were: seven whose FIRST moment falls between 00:00 and
 * 00:05, which is the previous evening continuing, and the "clip" was a
 * heuristic looking for an end within five minutes of midnight.
 *
 * Read against `WAKING_DAY_START_HOUR` those seven are ordinary late nights
 * ending at 00:04, 00:16, 00:24, 00:33, 01:04, 01:23 and 02:00 — a real spread.
 * So the open arrows are gone, nothing is excluded from the typical day, and
 * the bedtime band the audit asked for is now buildable. It is not built here:
 * this item moved the boundary and proved the measure, and a band is its own
 * piece of work.
 *
 * And the "focus sparkline (longest unbroken stretch vs median)" has no
 * measure behind it: a moment closes on a context switch, so the longest
 * moment of a day is the longest stretch in ONE app, not the longest stretch
 * of work. The card shows active minutes against the span instead, which is
 * the same question the record can actually answer.
 */
export function rhythmPanel(d) {
  const days = Array.isArray(d.days) ? d.days : []
  const attention = d.attention ?? {}
  const totals = attention.totals ?? {}
  const typical = typicalDay(days)
  const count = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`
  const clock = (min) => (Number.isFinite(min) ? `${String(Math.floor(min / 60 + startsAt) % 24).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}` : '—')
  const hm2 = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`)
  const dayName = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const today = days.find((day) => day.date === d.today) ?? null
  // K0.6 — served by the route on the waking axis. Computed here from the
  // host clock it was four hours out on every row, and the card has no way to
  // know the owner's zone.
  const nowMin = typeof d.nowMin === 'number' ? d.nowMin : null
  // Minutes on this bar count from 04:00, so a label has to add it back.
  const startsAt = typeof d.dayStartsAt === 'number' ? d.dayStartsAt : 4

  // ── One day ─────────────────────────────────────────────────────────────
  // Newest first, because the question "when did I start today" is asked far
  // more often than "when did I start three weeks ago".
  const ARC_WIDTH = 420
  const row = (day, index) =>
    el('div', { class: 'arc-line', 'data-today': day.date === d.today ? 'yes' : null, style: { '--i': index } }, [
      el('span', { class: 'arc-when', text: dayName(day.date) }),
      el('span', {
        class: 'arc-cell',
        title: `${clock(day.firstMin)} to ${clock(day.lastMin)} · ${hm2(day.activeMin)} active · ${day.observedHours.toFixed(1)}h watched${day.lastMin > 20 * 60 ? ' · ran past midnight' : ''}`,
      }, [dayArc({ day, width: ARC_WIDTH, now: day.date === d.today ? nowMin : null })]),
      el('span', { class: 'arc-span-text', text: `${clock(day.firstMin)}–${clock(day.lastMin)}` }),
      el('span', { class: 'arc-active', text: hm2(day.activeMin) }),
    ])

  return [
    el('section', { class: 'panel' }, [
      el('p', {
        class: 'panel-lead',
        text: days.length
          ? `The shape of your days — when work started, when it stopped, and how much of that Gnomon was actually running for. ${count(days.length, 'day')} in the window. The bar is the span and the pale blocks behind it are the hours Gnomon was running, one cell each. A day here runs from ${String(startsAt).padStart(2, '0')}:00 to ${String(startsAt).padStart(2, '0')}:00, not midnight to midnight, so a night that goes past twelve stays on the evening it belongs to.`
          : 'No day has been watched yet.',
      }),
      typical
        ? el('p', {
            class: 'panel-note',
            // Quartiles rather than a mean, and the n said out loud. K0.6: no
            // day is left out any more — the seven that used to be excluded
            // were the late nights, which is exactly what this measure is about.
            text: `A usual day starts between ${clock(typical.firstLo)} and ${clock(typical.firstHi)} — ${clock(typical.firstMid)} is the middle — and stops between ${clock(typical.lastLo)} and ${clock(typical.lastHi)}. That is over ${count(typical.n, 'day')}, with none left out.`,
          })
        : null,
      // Today against that, which is the delta callout the brief asked for.
      today && typical
        ? el('p', {
            class: 'arc-today',
            text: `Today you started at ${clock(today.firstMin)}, ${Math.abs(today.firstMin - typical.firstMid) < 15 ? 'about when you usually do' : today.firstMin < typical.firstMid ? `${hm2(typical.firstMid - today.firstMin)} earlier than usual` : `${hm2(today.firstMin - typical.firstMid)} later than usual`} — ${hm2(today.activeMin)} active so far, over a span of ${hm2(today.lastMin - today.firstMin)}.`,
          })
        : null,
      // The axis ABOVE the rows. Below twenty-three of them it is an axis the
      // reader has to scroll past the picture to find, which is no axis.
      days.length
        ? el('div', { class: 'arc-head' }, [
            el('span'),
            // K0.6 — `at` is the position on the 04:00-to-04:00 bar and `label`
            // is the clock hour there. They differ by four, and reading one as
            // the other names the wrong hour on every tick.
            el('span', { class: 'arc-cell arc-hours' }, arcHours(ARC_WIDTH).map((hour) => el('span', { class: 'ritual-hour', style: { '--at': `${(hour.at / 24) * 100}%` }, text: hour.label }))),
            el('span'),
            el('span'),
          ])
        : null,
      days.length ? el('div', { class: 'arc-list' }, [...days].reverse().map(row)) : null,
    ]),

    // ── When you stop ───────────────────────────────────────────────────
    // The band the audit asked for twice and was refused twice, both times on
    // a premise K0.6 measured and found false. It sits under the arcs and on
    // their axis, so a reader can drop a line through both.
    (() => {
      const weeks = bedtimeWeeks(days)
      const c = bedtimeCensus(weeks)
      if (weeks.length === 0) return null
      const said = d.intent?.object ?? null
      return el('section', { class: 'panel' }, [
        el('h2', { class: 'panel-title', text: 'When you stop' }),
        el('p', {
          class: 'panel-lead',
          text: c
            ? `The middle half of each week's stop times, with the median marked. Typically ${hm2(c.typicalSpread)} wide — your quietest week's middle sat at ${clock(c.earliestMid)} and your latest at ${clock(c.latestMid)}.`
            : 'Not enough nights yet to say when a week typically ends.',
        }),
        // No target line, and the record is what refuses it. DESIGN.md's rule
        // about asking the policy, pointed at the owner's own assertion.
        said
          ? el('p', {
              class: 'panel-note',
              text: `There is no line to measure this against, because you have said there is no target: “${said}”. So the band is drawn for its width rather than its distance from anything — the only reference on it is midnight.`,
            })
          : el('p', {
              class: 'panel-note',
              text: 'There is no target line here. The record holds no stated bedtime to draw one from, and a line invented for the picture would be a goal you never set.',
            }),
        el(
          'div',
          { class: 'arc-list' },
          [...weeks].reverse().map((week, index) =>
            el('div', { class: 'arc-line', 'data-thin': week.thin ? 'yes' : null, style: { '--i': index } }, [
              el('span', { class: 'arc-when', text: `week of ${new Date(`${week.from}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` }),
              el('span', { class: 'arc-cell', title: `${clock(week.lo)} to ${clock(week.hi)}, middle ${clock(week.mid)} · ${count(week.n, 'night')}` }, [bedtimeBand({ week, width: ARC_WIDTH })]),
              el('span', { class: 'arc-span-text', text: `${clock(week.lo)}–${clock(week.hi)}` }),
              // The n travels with the band, because a two-night week's middle
              // half is not a habit — DESIGN.md's rule that a verdict carries
              // the evidence it rests on, applied to a picture.
              el('span', { class: 'arc-active', text: count(week.n, 'night') }),
            ]),
          ),
        ),
        c && c.thin
          ? el('p', { class: 'panel-note', text: `${count(c.thin, 'week has', 'weeks have')} fewer than four nights in the record and ${c.thin === 1 ? 'is' : 'are'} drawn pale; ${c.thin === 1 ? 'it is' : 'they are'} left out of the figures above.` })
          : null,
      ])
    })(),

    // ── The attention ribbon ────────────────────────────────────────────
    // Everything the old card was, demoted to what it is: counters about how
    // scattered the work was, under the picture of when it happened.
    el('section', { class: 'panel' }, [
      el('h2', { class: 'panel-title', text: 'How scattered it was' }),
      el('p', {
        class: 'panel-note',
        text: `${(totals.switches ?? 0).toLocaleString()} moves between windows over ${count(totals.days ?? 0, 'day')}, about ${totals.switchesPerHour ?? 0} an active hour, and ${totals.sameAppSwitches ?? 0} of them were between two windows of the SAME app. ${((totals.shellFailureRate ?? 0) * 100).toFixed(0)}% of ${(totals.shellRuns ?? 0).toLocaleString()} shell commands failed.`,
      }),
      // Thrashing, WITH its definition and its threshold, which is what the
      // audit asked for. The detector was corrected on 2026-09-22 — it had
      // been counting window TITLE changes and firing at five of them — so the
      // bursts split into ones the corrected measure can read and ones it
      // cannot, and the card says which rather than summing them together.
      (() => {
        const bursts = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingBursts ?? 0), 0)
        const measured = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingBurstsMeasured ?? 0), 0)
        const flips = (attention.days ?? []).reduce((sum, day) => sum + (day.thrashingFlips ?? 0), 0)
        if (bursts === 0) return el('p', { class: 'panel-note', text: 'No burst of app-flipping was recorded in this window.' })
        return el('p', {
          class: 'panel-note',
          text: measured === 0
            ? `${bursts.toLocaleString()} bursts of flipping were recorded, and none of them can be read: all were written before the detector was corrected on 22 September, when it counted window TITLE changes and fired at five of them — so a terminal re-titling itself during a build scored as thrashing. New bursts need nine flips between DIFFERENT apps inside ninety seconds, which is the top tenth of working windows on your own record.`
            : `${measured.toLocaleString()} of ${bursts.toLocaleString()} bursts carry the corrected measure, ${flips.toLocaleString()} app-to-app flips between them. A burst is nine flips between different apps inside ninety seconds — the top tenth of working windows on your own record. The rest were written before 22 September, when the detector counted window TITLE changes and fired at five, so a terminal re-titling itself during a build scored as thrashing.`,
        })
      })(),
      (attention.suspects ?? []).length
        ? el('p', {
            class: 'panel-note',
            text: `The apps most often in front when a move happened: ${attention.suspects.slice(0, 4).map((s) => `${s.app} (${count(s.present, 'time')})`).join(', ')}.`,
          })
        : null,
    ]),
  ]
}
