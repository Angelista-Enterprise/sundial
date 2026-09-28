// Where in the day a ritual sits, on the same clock as every other ritual's.
//
// The audit asked for a day-arc, one per weekday, with rituals as named bands.
// That picture belongs to I13 (Rhythm), whose declared hero is fourteen stacked
// day-arcs — first touch, work block, evening tail, last activity — and the
// owner has already seen and approved a mock of it. Two day-arcs on one board,
// drawn from different data and meaning different things, is exactly the "don't
// confuse the user" the whole design note opens with.
//
// So this card draws the other half of the same idea, and only the half the
// rituals can carry: not one arc per day, but ONE CLOCK shared down the column,
// each ritual laying its usual window on it. Reading the column top to bottom
// IS the day's shape, ritual by ritual, and it needs no second picture and no
// second axis. It is `goal-trail`'s rule applied to a different scale — one
// scale for the whole list, computed once, every row beginning and ending at
// the same x — with the axis being a day rather than a quarter.
//
// Two marks, because they answer different questions. The BAND is the usual
// window, first quartile start to third quartile end: where this ritual lives.
// The tall tick is its median start: when it actually begins. A wide band with
// its tick hard left is a thing that starts on time and runs long; a wide band
// with the tick in the middle is a thing that happens whenever.
import { svg } from './surfaces.js'

const DAY_MIN = 24 * 60

/**
 * The clock the whole list shares.
 *
 * Never narrower than the working day, and widened to whatever was actually
 * seen — the strata's own fault, where a hardcoded 6→24 silently dropped the
 * midnight work a late night puts in the record. Rounded out to whole hours so
 * the labels land on the marks.
 */
export function dayScale(rituals) {
  let from = 8 * 60
  let to = 20 * 60
  for (const ritual of rituals ?? []) {
    if (Number.isFinite(ritual?.startMin)) from = Math.min(from, ritual.startMin)
    if (Number.isFinite(ritual?.endMin)) to = Math.max(to, ritual.endMin)
  }
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(DAY_MIN, Math.ceil(to / 60) * 60) }
}

/** The hours worth naming on that scale: every third one, and always both ends. */
export function scaleHours(scale) {
  const hours = []
  for (let minute = scale.from; minute <= scale.to; minute += 60) {
    const hour = minute / 60
    if (minute === scale.from || minute === scale.to || hour % 3 === 0) hours.push(hour)
  }
  return hours
}

const at = (minute, scale, width) => Math.round(((Math.min(scale.to, Math.max(scale.from, minute)) - scale.from) / (scale.to - scale.from)) * (width - 2)) + 1

/**
 * One ritual's window on the shared clock, drawn at one unit per pixel.
 *
 * `now` is minutes from local midnight, or null off today. It is the only ochre
 * on the picture, the same mark the dial puts on the current hour, and the
 * reason the column answers "am I on my usual path right now" without a word.
 */
export function dayClock({ startMin, endMin, width = 240, height = 14, now = null } = {}, scale) {
  const mid = Math.round(height / 2) + 0.5
  const node = svg('svg', { class: 'day-clock', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' })
  node.append(svg('line', { class: 'clock-axis', x1: 1, y1: mid, x2: width - 1, y2: mid }))
  if (Number.isFinite(startMin)) {
    const x1 = at(startMin, scale, width)
    // The band is the stretch; the tick is where it began. Drawn separately,
    // and the tick without the band, because the asks card has rows with a
    // start and no end — a question that expired unanswered — and those are
    // the most interesting rows on it. With both marks inside one branch an
    // expired ask drew a bare axis, which says "nothing happened" about the
    // one case where nothing happening IS the finding.
    if (Number.isFinite(endMin) && endMin > startMin) node.append(svg('rect', { class: 'clock-band', x: x1, y: mid - 3.5, width: Math.max(2, at(endMin, scale, width) - x1), height: 7 }))
    node.append(svg('line', { class: 'clock-start', x1: x1 + 0.5, y1: mid - 5.5, x2: x1 + 0.5, y2: mid + 5.5 }))
  }
  if (now !== null && now >= scale.from && now <= scale.to) {
    const x = at(now, scale, width) + 0.5
    node.append(svg('line', { class: 'clock-now', x1: x, y1: mid - 5.5, x2: x, y2: mid + 5.5 }))
  }
  return node
}
