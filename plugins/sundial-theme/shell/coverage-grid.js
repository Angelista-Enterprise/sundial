// How many hours of each day Gnomon actually watched, as a calendar.
//
// **A calendar, and not a bar per day, for two reasons.** The first is I8's:
// six lists on this board already put a mark per row on a shared axis, and a
// seventh reads as a copy. The second is the data's own shape — the audit
// asked for "observed-hours strip with weekday rhythm + today-vs-typical", and
// a weekday rhythm is a question you ask DOWN a column. Laid out as weeks in
// rows and weekdays in columns, the timeline reads across, the rhythm reads
// down, and today's cell is one mark; a strip of 47 bars answers the first
// question and neither of the others.
//
// **The gaps are the point.** 2026-09-20 holds 0.15 observed hours and
// 2026-09-19 holds 1.32, against a usual nine or ten. That is what "something
// was wrong" looks like in this record, and it is the only genuine health
// signal the log carries — one sensor emits on a clock whatever happens
// (`input:activity`), so its density IS the machine's pulse. Every other
// sensor's silence is indistinguishable from a quiet world. See `sensors.js`.
//
// A pale cell is therefore never drawn as zero-and-fine. It is drawn pale, and
// the card's prose names the days.
import { svg } from './surfaces.js'

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const GUTTER_L = 46 // the week-of labels
const TOP = 26 // the weekday heads and their medians
const GAP = 3
/** Below this the head's "usually Nh" overruns its neighbour. */
const WIDE_CELL = 62
/** "Wednesday" at 10px uppercase with the head's letter-spacing measures ~68. */
const NAMED_HEAD = 72

/** Monday-first weekday index, 0..6 — ISO order, because a week of work starts on Monday. */
export const weekdayOf = (date) => (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7

/**
 * The grid: one row per calendar week, one column per weekday.
 *
 * A day with no row in the data is a HOLE, not a zero — the daemon was not
 * running, which is a different claim from "the daemon watched nothing". Holes
 * are returned with `hours: null` so the drawing can leave them empty rather
 * than paint them as the palest possible observation.
 */
export function coverageWeeks(days) {
  const rows = (days ?? []).filter((day) => typeof day?.date === 'string').sort((a, b) => (a.date < b.date ? -1 : 1))
  if (rows.length === 0) return []
  const seen = new Map(rows.map((day) => [day.date, day.hours]))

  // Walk whole weeks from the Monday on or before the first day to the Sunday
  // on or after the last, so every row has seven cells and the columns line up.
  const start = new Date(`${rows[0].date}T12:00:00Z`)
  start.setUTCDate(start.getUTCDate() - weekdayOf(rows[0].date))
  const end = new Date(`${rows[rows.length - 1].date}T12:00:00Z`)
  end.setUTCDate(end.getUTCDate() + (6 - weekdayOf(rows[rows.length - 1].date)))

  const weeks = []
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const week = []
    for (let i = 0; i < 7; i++) {
      const at = new Date(cursor)
      at.setUTCDate(at.getUTCDate() + i)
      const date = at.toISOString().slice(0, 10)
      week.push({ date, hours: seen.has(date) ? seen.get(date) : null })
    }
    weeks.push({ from: week[0].date, days: week })
  }
  return weeks
}

/**
 * What a typical day of each weekday holds — the MEDIAN, not the mean.
 *
 * Measured before choosing: Wednesday's observed hours on the live record run
 * from 1.77 to 23.9, so a mean is dragged by one all-nighter and one dead day
 * in opposite directions and describes neither. `n` rides along because six
 * samples is not a rhythm and the card says the number rather than implying
 * one.
 */
export function weekdayTypical(days) {
  const byDow = new Map()
  for (const day of days ?? []) {
    if (typeof day?.hours !== 'number') continue
    const dow = weekdayOf(day.date)
    byDow.set(dow, [...(byDow.get(dow) ?? []), day.hours])
  }
  const out = []
  for (let dow = 0; dow < 7; dow++) {
    const seen = (byDow.get(dow) ?? []).sort((a, b) => a - b)
    out.push({ dow, label: DOW[dow], short: DOW[dow].slice(0, 3), n: seen.length, median: seen.length ? seen[Math.floor(seen.length / 2)] : null })
  }
  return out
}

/**
 * The geometry, from the width alone.
 *
 * **The height FOLLOWS the width; it is not given.** The first draw fixed the
 * slab at 250px with a 520px cap and the owner's verdict was "doesn't scale
 * well" — on a wide card it left two thirds of the paper empty, and the
 * weekday names collided because the cells were narrower than their own
 * labels. A calendar cell does not have to be square: given room, the column
 * gets wider, the row gets taller in proportion, and past `WIDE_CELL` the cell
 * spends the room it was given on SAYING ITS NUMBER rather than on being
 * bigger. That is the difference between a picture that fills a card and a
 * picture that merely fits one.
 *
 * **What the room does NOT buy is a number inside each cell.** That was drawn
 * and taken out again after measuring it on both papers: the cell's ground is
 * the value, so any ink written on it sits on a shade that changes cell by
 * cell, and around half opacity — eight to ten hours, the commonest days in
 * this record — neither the paper colour nor any of the three text tones
 * clears 4.5:1. A two-tone flip only moves the worst case to the flip point.
 * The shade IS the comparison, the hover carries the exact figure, the weekday
 * head carries the median and the prose carries the outliers; a number written
 * over the shade would be the same value said twice, which DESIGN.md already
 * says is a value read once.
 */
export function gridGeometry(width, weeks) {
  const cellW = Math.max(10, (width - GUTTER_L - GAP * 6) / 7)
  const cellH = Math.min(64, Math.max(20, cellW * 0.42))
  return {
    cellW,
    cellH,
    named: cellW >= NAMED_HEAD,
    spelled: cellW >= WIDE_CELL,
    height: Math.round(TOP + weeks.length * (cellH + GAP)),
  }
}

/**
 * The calendar, painted into the width it was measured against.
 *
 * One user unit per pixel, the strata's idiom — with the caller measuring only
 * the WIDTH and taking the height back from `gridGeometry`, so the picture is
 * never squashed to fit a box somebody guessed at.
 */
export function coverageGrid(node, { weeks, typical, today, width, onPick }) {
  if (width < 200 || weeks.length === 0) return 0
  const g = gridGeometry(width, weeks)
  node.setAttribute('viewBox', `0 0 ${width} ${g.height}`)
  node.setAttribute('height', g.height)
  node.replaceChildren()

  const xOf = (dow) => GUTTER_L + dow * (g.cellW + GAP)

  // The weekday heads carry the rhythm, because the rhythm is what a column
  // IS: the median of that column, under the name of the day. A number the
  // card would otherwise have to say in a sentence about seven things.
  typical.forEach((day) => {
    const mid = xOf(day.dow) + g.cellW / 2
    node.append(svg('text', { class: 'cov-head', x: mid, y: 9, 'text-anchor': 'middle' }, [g.named ? day.label : day.short.slice(0, g.cellW >= 26 ? 3 : 1)]))
    if (day.median !== null) node.append(svg('text', { class: 'cov-head-median', x: mid, y: TOP - 6, 'text-anchor': 'middle' }, [g.spelled ? `usually ${day.median.toFixed(0)}h` : `${day.median.toFixed(0)}h`]))
  })

  weeks.forEach((week, row) => {
    const y = TOP + row * (g.cellH + GAP)
    node.append(svg('text', { class: 'cov-week', x: GUTTER_L - 8, y: y + g.cellH / 2 + 3, 'text-anchor': 'end' }, [week.from.slice(5).replace('-', '/')]))
    week.days.forEach((day, dow) => {
      const box = { x: xOf(dow), y, width: g.cellW, height: g.cellH }
      // A hole is an OUTLINE, an observation is a FILL. They are different
      // claims — "the daemon was not running" against "the daemon watched
      // almost nothing" — and a shared shade would say the first was the
      // second, which is exactly the day this card exists to surface.
      if (day.hours === null) {
        node.append(svg('rect', { class: 'cov-hole', ...box }))
        return
      }
      const cellNode = svg('rect', {
        class: 'cov-cell',
        ...box,
        // Against a waking day, not against 24: a day Gnomon watched for
        // sixteen hours is a fully-seen day, and dividing by 24 would paint
        // every good day two-thirds dark and leave no room at the top.
        'fill-opacity': Math.max(0.06, Math.min(1, day.hours / 16)),
        'data-today': day.date === today ? 'yes' : null,
        tabindex: '0',
        role: 'button',
      })
      cellNode.append(svg('title', {}, [`${day.date} — ${day.hours.toFixed(1)} hours watched`]))
      cellNode.addEventListener('click', () => onPick?.(day))
      cellNode.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onPick?.(day)
        }
      })
      node.append(cellNode)
      // Today is a ring, not a darker fill: the fill is already carrying the
      // hours, and one mark cannot answer two questions.
      if (day.date === today) node.append(svg('rect', { class: 'cov-today', x: box.x - 1.5, y: box.y - 1.5, width: g.cellW + 3, height: g.cellH + 3 }))
    })
  })
  return g.height
}
