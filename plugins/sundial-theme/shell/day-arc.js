// What one day looked like, on the clock every other day shares.
//
// **Three things on one row, and they answer three different questions.** The
// ARC is first touch to last touch — the span the day occupied. The WATCHED
// hatch behind it is which HOURS Gnomon was actually running, one cell each,
// because a twelve-hour day with two hours of coverage is a different fact
// from a twelve-hour day fully seen and the card must not let them look alike.
// The END CAPS are the two instants, marked, because "when do I start" is the
// question a rhythm card exists for and a bar's edge is hard to read against
// a neighbour's.
//
// **The bar runs from 04:00 to 04:00, and nothing on it is clipped — K0.6.**
// It used to run midnight to midnight, and both ends of a late night were then
// wrong: a moment is filed by the day it STARTS in, so an evening that ran to
// 00:33 was recorded as an evening stopping at 23:57 and a NEXT day starting at
// 00:03. The card met that with a heuristic — an end within five minutes of
// midnight was drawn as an open arrow and excluded from the typical day — which
// labelled a person working late as a day whose end the record could not see.
// It could see it perfectly; it was looking on the wrong row.
//
// Read against the waking day the record's nine suspect days become seven real
// late nights ending at 00:04, 00:16, 00:24, 00:33, 01:04, 01:23 and 02:00, and
// two ordinary ones. So the arrow is gone, both caps are instants, and the
// bedtime spread the audit asked for is a distribution rather than nine marks
// in the same place. `WAKING_DAY_START_HOUR` in `local-day.ts` holds the
// boundary and the argument for 04:00.
import { svg } from './surfaces.js'
import { WAKING_DAY_START_HOUR } from './day-hours.js'

const DAY_MIN = 24 * 60

/** Where a minute-of-day falls on the bar, in pixels. */
export const atMinute = (min, width) => Math.round((Math.min(DAY_MIN, Math.max(0, min)) / DAY_MIN) * (width - 2)) + 1

/**
 * The hours worth naming under a 24-hour bar at this width.
 *
 * Every third hour at a comfortable width, every sixth when the card is
 * narrow — a label every hour at 300px is twenty-four labels in 300 pixels,
 * which is a grey smear rather than a scale.
 */
export function arcHours(width) {
  const step = width >= 640 ? 3 : 6
  const hours = []
  // K0.6 — the labels are CLOCK hours on a bar that starts at 04:00, so the
  // track runs 04, 07, 10 … 01, 04. Drawn 0–24 they would name the wrong hour
  // on every tick, which is the quietest way for a picture to lie.
  for (let at = 0; at <= 24; at += step) hours.push({ at, label: String((WAKING_DAY_START_HOUR + at) % 24).padStart(2, '0') })
  return hours
}

/**
 * One day's arc: the hatch, the span, the two caps, and `now` on today alone.
 */
export function dayArc({ day, width = 420, height = 18, now = null } = {}) {
  const mid = Math.round(height / 2) + 0.5
  const node = svg('svg', { class: 'arc', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' })
  node.append(svg('line', { class: 'arc-axis', x1: 1, y1: mid, x2: width - 1, y2: mid }))
  if (day === null || day === undefined || !Number.isFinite(day.firstMin)) return node

  const x1 = atMinute(day.firstMin, width)
  const x2 = atMinute(day.lastMin, width)
  const span = Math.max(1, x2 - x1)

  // The watched hatch, hour by hour, behind everything.
  //
  // **A day TOTAL cannot draw this, and the first attempt proved it.** Gnomon
  // often runs more hours than the owner works, so `observed / span` came out
  // above 1 on an ordinary day, clamped, and painted the underlay full width
  // on every row — a picture saying every day was completely watched, which is
  // the flat-24 fault this card exists to fix, wearing a different costume.
  // One cell per local hour, opacity by that hour's own share, across the
  // whole 24 rather than only the working span: an unwatched morning is part
  // of what the row has to say.
  const cell = (width - 2) / 24
  ;(day.hours ?? []).forEach((share, hour) => {
    if (!(share > 0.02)) return
    node.append(svg('rect', { class: 'arc-watched', x: Math.round(hour * cell) + 1, y: mid - 7, width: Math.max(1, Math.ceil(cell)), height: 14, 'fill-opacity': Math.max(0.08, Math.min(0.5, share * 0.5)) }))
  })

  node.append(svg('rect', { class: 'arc-span', x: x1, y: mid - 3, width: span, height: 6 }))

  // Both caps are instants. K0.6 removed the open arrow: on the waking day
  // there is no end the record cannot see, and drawing one said the opposite
  // about seven nights it knew exactly.
  const cap = (x) => node.append(svg('line', { class: 'arc-cap', x1: x + 0.5, y1: mid - 6.5, x2: x + 0.5, y2: mid + 6.5 }))
  cap(x1)
  cap(x2)

  // Now, and only on today. Ochre is the present moment, the same mark the
  // dial puts on the current hour — and on a column of finished days it would
  // say every one of them was live.
  if (now !== null) {
    const x = atMinute(now, width) + 0.5
    node.append(svg('line', { class: 'arc-now', x1: x, y1: 1, x2: x, y2: height - 1 }))
  }
  return node
}

/**
 * The typical day, as a band: the middle half of first touches and of last
 * touches, with the medians marked.
 *
 * Quartiles, not a mean, and the same argument as the coverage calendar's:
 * one all-nighter and one dead day drag a mean in opposite directions and it
 * describes neither. Clipped days are excluded outright — a midnight start is
 * not evidence about when the owner gets up.
 */
export function typicalDay(days) {
  // K0.6 — nothing is excluded any more. The exclusion existed because a late
  // night looked like a day that began and ended at midnight; on the waking day
  // it looks like a late night, and leaving the record's seven of them out was
  // dropping exactly the days the question is about.
  const clean = (days ?? []).filter((day) => day && Number.isFinite(day.firstMin))
  if (clean.length < 3) return null
  const at = (values, q) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))]
  const firsts = clean.map((d) => d.firstMin)
  const lasts = clean.map((d) => d.lastMin)
  return {
    n: clean.length,
    firstLo: at(firsts, 0.25),
    firstMid: at(firsts, 0.5),
    firstHi: at(firsts, 0.75),
    lastLo: at(lasts, 0.25),
    lastMid: at(lasts, 0.5),
    lastHi: at(lasts, 0.75),
  }
}

/**
 * One week's band on the same clock the arcs use.
 *
 * DESIGN.md: a list's shared axis need not be a calendar, but it must be ONE
 * axis — so this takes `atMinute` and the same 04:00-to-04:00 bar as the day
 * rows above it, and a reader can drop a vertical line through both. Drawn on
 * its own scale it would be a second picture of the same hours disagreeing
 * with the first.
 *
 * The band is the middle half and the tick is the median, which is the shape
 * the typical-day summary already uses at the top of the card. A thin week
 * takes the quiet ink rather than being left out: a week with two nights in it
 * is a fact about the week, and a missing row reads as a gap in the record.
 */
export function bedtimeBand({ week, width = 420, height = 18 } = {}) {
  const mid = Math.round(height / 2) + 0.5
  const node = svg('svg', { class: 'arc bedtime', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' })
  node.append(svg('line', { class: 'arc-axis', x1: 1, y1: mid, x2: width - 1, y2: mid }))
  if (week === null || week === undefined || !Number.isFinite(week.lo) || !Number.isFinite(week.hi)) return node

  // Midnight, because "did this week run past twelve" is the question the band
  // is read for and the bar's own ends are 04:00. A reference, not a target:
  // the owner has no stated bedtime, so there is no line to draw for one.
  const midnight = atMinute(20 * 60, width)
  node.append(svg('line', { class: 'bedtime-midnight', x1: midnight + 0.5, y1: 1, x2: midnight + 0.5, y2: height - 1 }))

  const x1 = atMinute(week.lo, width)
  const x2 = atMinute(week.hi, width)
  node.append(svg('rect', { class: `bedtime-half${week.thin ? ' is-thin' : ''}`, x: x1, y: mid - 4, width: Math.max(1, x2 - x1), height: 8 }))
  if (Number.isFinite(week.mid)) {
    const x = atMinute(week.mid, width)
    node.append(svg('line', { class: 'bedtime-mid', x1: x + 0.5, y1: mid - 7, x2: x + 0.5, y2: mid + 7 }))
  }
  return node
}
