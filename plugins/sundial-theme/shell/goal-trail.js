// The life of a goal, on the same axis as every other goal's.
//
// The list could say when a goal last moved and not how long it had been going,
// which is the question anyone looking at a list of intentions is actually
// asking. "Sep 11" is the same four characters whether the goal was born that
// day and died that day, or has been running since the 8th and was last touched
// on the 11th and is still open now.
//
// So each row draws its own life — birth to end — against ONE scale shared by
// the whole list, and the column of them becomes a picture: goals born
// together, goals that stopped, goals still reaching the right-hand edge. It is
// the strata's argument at row scale, and the same rule applies: one user unit
// per pixel, measured against the box it is drawn into.
//
// Two kinds of mark, because they answer different questions. A tall full-ink
// tick is the owner SAYING something — opened it, moved it on, dropped it. A
// short faint tick is a commit on the branch the goal names: work, which is not
// the same thing as attention. A goal with one tick at the far left and nothing
// since is exactly the goal the stale nudge is about, and now you can see it
// without reading a date.
import { svg } from './surfaces.js'

const DAY = 86_400_000

/**
 * One scale for the list.
 *
 * Padded by a day at each end so a mark on the first or last day is a mark and
 * not half a mark against the edge, and floored at a week so a list whose goals
 * were all set this morning does not draw three hours across 300 pixels and
 * imply a month of history.
 */
export function trailScale(goals, now = Date.now()) {
  const stamps = []
  for (const goal of goals ?? []) for (const event of goal?.life ?? []) if (event?.at) stamps.push(new Date(event.at).getTime())
  const valid = stamps.filter((t) => Number.isFinite(t))
  const to = now + DAY
  const from = Math.min(valid.length ? Math.min(...valid) : now - 7 * DAY, to - 8 * DAY) - DAY
  return { from, to, days: Math.max(1, Math.round((to - from) / DAY)) }
}

/**
 * Where an instant falls, 0 → 1, clamped so a stray stamp cannot draw off the
 * end.
 *
 * `null` and `undefined` are rejected BEFORE the Date, because `new Date(null)`
 * is the epoch and finite — an undated event would have drawn a real mark at
 * the far left of every trail, which is a lie about a goal rather than a gap.
 */
export const atFraction = (at, scale) => {
  if (at === null || at === undefined || at === '') return null
  const t = new Date(at).getTime()
  if (!Number.isFinite(t) || scale.to <= scale.from) return null
  return Math.min(1, Math.max(0, (t - scale.from) / (scale.to - scale.from)))
}

/**
 * One goal's trail, drawn at one unit per pixel into a box of `width`.
 *
 * `life` is the goal's own events, newest or oldest first — it does not matter,
 * only the extent and the marks do. `live` decides the right-hand end: a goal
 * still in play runs to now and is capped with the ochre dot the whole client
 * uses for the present moment; a settled one stops where it stopped.
 */
export function goalTrail({ life = [], live = false, width = 240, height = 14 } = {}, scale) {
  const mid = Math.round(height / 2) + 0.5
  const marks = life.map((e) => ({ ...e, x: atFraction(e.at, scale) })).filter((e) => e.x !== null)
  const pixel = (x) => Math.round(x * (width - 2)) + 1
  const xs = marks.map((m) => pixel(m.x))
  const start = xs.length ? Math.min(...xs) : null
  const end = live ? width - 1 : xs.length ? Math.max(...xs) : null

  const node = svg('svg', { class: 'goal-trail', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', focusable: 'false' })
  // The axis every row shares, drawn full width so a short life reads as short
  // rather than as a line that happens to be that long.
  node.append(svg('line', { class: 'trail-axis', x1: 1, y1: mid, x2: width - 1, y2: mid }))
  if (start !== null && end !== null && end > start) node.append(svg('line', { class: 'trail-life', x1: start, y1: mid, x2: end, y2: mid }))
  for (const mark of marks) {
    const x = pixel(mark.x) + 0.5
    const tall = mark.kind === 'said'
    node.append(svg('line', { class: `trail-mark trail-${mark.kind}`, x1: x, y1: mid - (tall ? 5 : 2.5), x2: x, y2: mid + (tall ? 5 : 2.5) }))
  }
  // Now, and only for a goal that is still running. Ochre is the present
  // moment — the same mark the dial puts on the current hour.
  if (live) node.append(svg('circle', { class: 'trail-now', cx: width - 1.5, cy: mid, r: 2 }))
  return node
}
