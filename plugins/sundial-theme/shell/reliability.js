// One forecaster's claims against what actually happened.
//
// **The canonical picture for this question, and nothing on this board looks
// like it.** Claimed probability runs across, observed rate runs up, and the
// diagonal is a forecaster that means exactly what it says. A mark above the
// line said 30% about something that happened 100% of the time — hedging. A
// mark below it overclaimed. The diagonal is the whole reading, and it is why
// this is not another bar chart: a bar can show how often a forecaster said
// 30%, but only a reference line can show whether 30% MEANT anything.
//
// **One picture per forecaster, never one for the card.** Calibration is a
// property OF a forecaster. `day-ending` bets 910 times at a 4.7% base rate,
// `hour-fragmented` 568 at 20.8%, `project-touched` 165 at 37%; pooled into
// one curve the shape belongs to whichever of them bets most, and the thing
// the owner would actually want to see — that `day-ending` sits hard ABOVE the
// line, right on all 37 of the bets where it committed — disappears into the
// other two.
//
// Small, and three of them, on the same two axes — which is what makes them
// comparable by eye and the only reason to draw them side by side. Mark size
// is the one thing NOT shared; see `reliabilityPlot`.
import { svg } from './surfaces.js'

// Room for the axis names and their ticks to sit APART. Measured after the
// owner's "text feels very tight on each other": at PAD_T 18 the vertical
// axis's name and its own 100 tick were drawn one pixel apart and overlapped,
// and the horizontal name sat eight pixels under its ticks.
const PAD_L = 34
const PAD_B = 40
const PAD_T = 32
const PAD_R = 10
/** Radius of the busiest decile's mark. Everything else is scaled against it by AREA. */
const MAX_R = 9
const MIN_R = 2.5

/** Mark radius by area, not by width — a circle twice as wide is four times the ink. */
export const radiusFor = (n, busiest) => (n <= 0 ? 0 : Math.max(MIN_R, MAX_R * Math.sqrt(n / Math.max(1, busiest))))

/**
 * The plot, painted into the box it was measured against.
 *
 * **`busiest` is this plot's own heaviest decile, not the card's.** Shared
 * across the three, the range is 873 to 1 and twenty of the twenty-one marks
 * clamp to the minimum radius — every mark the same size, which is the "every
 * case lands in the same place" tell, and `project-touched` in particular
 * would read as a forecaster with no bets anywhere. The two AXES are shared
 * and they are what the three plots are compared on; mark size answers a
 * within-plot question — which points to trust — so it is scaled within the
 * plot and the card's caption says so.
 */
export function reliabilityPlot(node, { rows, width, height, busiest, label, onPick }) {
  node.setAttribute('viewBox', `0 0 ${width} ${height}`)
  node.replaceChildren()
  if (width < 120 || height < 100) return

  const x = (p) => PAD_L + p * (width - PAD_L - PAD_R)
  const y = (p) => height - PAD_B - p * (height - PAD_T - PAD_B)

  // The frame, and then the diagonal ON it — the reference is the subject here,
  // so it is the one line drawn in ink rather than in the divider tone.
  node.append(svg('line', { class: 'rel-axis', x1: x(0), y1: y(0), x2: x(1), y2: y(0) }))
  node.append(svg('line', { class: 'rel-axis', x1: x(0), y1: y(0), x2: x(0), y2: y(1) }))
  node.append(svg('line', { class: 'rel-ideal', x1: x(0), y1: y(0), x2: x(1), y2: y(1) }))

  for (const at of [0, 0.5, 1]) {
    node.append(svg('text', { class: 'rel-tick', x: PAD_L - 6, y: y(at) + 3, 'text-anchor': 'end' }, [`${at * 100}`]))
    node.append(svg('text', { class: 'rel-tick', x: x(at), y: height - PAD_B + 13, 'text-anchor': 'middle' }, [`${at * 100}`]))
  }
  node.append(svg('text', { class: 'rel-label', x: x(0.5), y: height - 4, 'text-anchor': 'middle' }, [label ?? 'said, %']))
  // The vertical axis is named horizontally, clear ABOVE its own topmost tick.
  // Nothing the owner reads is leaned — a rotated label is composited off the
  // pixel grid and comes out soft — and a plot with only one axis named is one
  // you have to guess at. `PAD_T` is what buys the gap: written at the top of
  // the plot area it landed on the 100 tick.
  node.append(svg('text', { class: 'rel-label', x: 0, y: 10, 'text-anchor': 'start' }, ['it happened, %']))

  for (const row of rows ?? []) {
    if (row.n === 0 || row.observed === null) continue
    // A line from the diagonal to the mark, so the DISTANCE from honest is the
    // thing the eye measures rather than the mark's absolute position.
    node.append(svg('line', { class: 'rel-error', x1: x(row.claimed), y1: y(row.claimed), x2: x(row.claimed), y2: y(row.observed) }))
    const dot = svg('circle', {
      class: 'rel-mark',
      'data-lean': row.gap > 0.05 ? 'under' : row.gap < -0.05 ? 'over' : null,
      cx: x(row.claimed),
      cy: y(row.observed),
      r: radiusFor(row.n, busiest),
      tabindex: '0',
      role: 'button',
    })
    dot.append(svg('title', {}, [`said ${Math.round(row.from * 100)}–${Math.round(row.to * 100)}% on ${row.n} — it happened ${Math.round(row.observed * 100)}% of the time`]))
    const pick = () => onPick?.(row)
    dot.addEventListener('click', pick)
    dot.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        pick()
      }
    })
    node.append(dot)
  }
}
