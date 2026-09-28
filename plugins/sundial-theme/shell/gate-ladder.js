// Every decision the gate has ever made, on one vertical weight axis.
//
// **Why this is not another row of bands.** The first draw of the Unsaid card
// put each decision on a horizontal axis inside its own row — which is exactly
// the shape the habits, goals, people and asks cards already use, and the
// owner's verdict on seeing it was that every card now feels the same. They
// were right, and the sameness was not only a look: a band per row answers
// "where does THIS one sit", and the question this card exists for is "where
// should the bar sit", which is a question about all of them at once.
//
// So the axis turns ninety degrees and becomes the picture. Weight runs up the
// left edge; the three things the gate can do with a candidate — say it, hold
// it, drop it — are three columns facing that one axis; and the bar is a rule
// straight across all three. Then the finding reads itself off the shape:
//
//   * marks in the SAID column BELOW the bar — the dial has moved since, and
//     the record does not store where it was;
//   * marks in the DROPPED column ABOVE it — something other than the bar
//     refused those: the day's budget, the cost of breaking in, a worn key;
//   * and the band where both columns have marks at the same height, shaded,
//     which is the card's headline as a shape rather than as a sentence.
//
// The rows underneath keep no picture at all. One axis, drawn once, at the
// size the card actually is — which is also a lot less SVG than 171 of them.
import { octaves } from './gate.js'
import { svg } from './surfaces.js'

const GUTTER_L = 78 // the axis labels live here, right-aligned against the marks
const TOP = 30 // the column heads
const BOTTOM = 24 // the foot of the axis, and the 0
const COL_PAD = 12
const MARK_W = 9
const MARK_H = 3
const MARK_PITCH = 12
/** Marks within this many pixels of each other are one rank, laid side by side. */
const RANK = 7

/** The three things the gate can do, in the order a reader asks about them. */
export const LADDER_COLUMNS = [
  { key: 'said', label: 'said' },
  { key: 'held', label: 'held' },
  { key: 'dropped', label: 'dropped' },
]

/**
 * Where each mark goes, given the column's box and the rows in it.
 *
 * Pure, so the packing can be tested without a DOM. Rows at the same height
 * are laid side by side from the column's left edge, and the pitch COMPRESSES
 * rather than overflowing when a rank is crowded — a rank that ran off its
 * column would put marks under the neighbouring heading and claim the wrong
 * outcome for them, which is the one thing this picture must never do.
 */
export function packColumn(rows, { x, width, yOf }) {
  // K0.2 — a mark sits at its own doublings-above-its-own-bar, not at its raw
  // weight. `rows` arrive carrying `placedAt` for that; a row from before the
  // bars were recorded falls back to its weight and is counted in the card's
  // "cannot be placed" sentence rather than quietly moved.
  const placed = rows.map((row) => ({ row, y: yOf(row.placedAt ?? row.weight) })).sort((a, b) => a.y - b.y)
  const ranks = []
  for (const mark of placed) {
    const last = ranks[ranks.length - 1]
    if (last && mark.y - last[0].y <= RANK) last.push(mark)
    else ranks.push([mark])
  }
  const out = []
  for (const rank of ranks) {
    const room = Math.max(0, width - MARK_W)
    const pitch = rank.length < 2 ? 0 : Math.min(MARK_PITCH, room / (rank.length - 1))
    rank.forEach((mark, i) => out.push({ row: mark.row, x: x + i * pitch, y: Math.round(mark.y) - MARK_H / 2 }))
  }
  return out
}

/**
 * The whole ladder, painted into the box it was measured against.
 *
 * One user unit per pixel: the caller measures its own slab, hands the numbers
 * in, and calls again on resize. `onPick` is handed the decision a mark stands
 * for, which is what keeps this from being a picture you can only look at —
 * pressing a mark opens its row in the list below.
 */
export function gateLadder(node, { rows, width, height, scale, bars, overlap, weightAt, onPick }) {
  node.setAttribute('viewBox', `0 0 ${width} ${height}`)
  node.replaceChildren()
  if (width < 240 || height < 160) return

  const floor = height - BOTTOM
  const yOf = (weight) => TOP + (1 - weightAt(weight, scale)) * (floor - TOP)
  const colW = (width - GUTTER_L) / LADDER_COLUMNS.length

  // The overlap, first and underneath everything: the stretch of weight where
  // the gate has both admitted and refused. Drawn as ground rather than as a
  // mark, because it is not a thing that happened — it is the shape of the
  // things that did.
  if (overlap) {
    const top = yOf(overlap.hi)
    const bottom = yOf(overlap.lo)
    node.append(svg('rect', { class: 'ladder-overlap', x: GUTTER_L, y: top, width: width - GUTTER_L, height: Math.max(2, bottom - top) }))
    node.append(svg('text', { class: 'ladder-overlap-label', x: GUTTER_L - 8, y: (top + bottom) / 2 + 3, 'text-anchor': 'end' }, ['both']))
  }

  // The axis. Every line on it is a DOUBLING of the bar, which is one notch of
  // the owner's own dial — so the grid is not decoration, it is the unit the
  // thing being tuned actually moves in.
  const rule = (weight, label, className, labelClass = 'ladder-axis-label') => {
    const y = Math.round(yOf(weight)) + 0.5
    node.append(svg('line', { class: className, x1: GUTTER_L, y1: y, x2: width, y2: y }))
    if (label !== null) node.append(svg('text', { class: labelClass, x: GUTTER_L - 8, y: y + 4, 'text-anchor': 'end' }, [label]))
  }
  const steps = octaves(scale)
  steps.forEach((weight, i) => {
    const end = i === 0 || i === steps.length - 1
    // The ends say they are ends. Nine of the record's rows fall outside the
    // window and pin to one, and a mark pinned to an unmarked ceiling is a
    // mark claiming a weight it does not have.
    rule(weight, end ? `${weight.toFixed(2)}${i === 0 ? ' and under' : ' and over'}` : weight.toFixed(2), end ? 'ladder-axis' : 'ladder-grid')
  })
  // The interrupting bar is the quiet one: it applies only to candidates with a
  // short shelf life, which most of these are not, so it is a reference rather
  // than a line every mark was measured against.
  rule(bars.phasic, null, 'ladder-bar-quiet')
  rule(bars.tonic, null, 'ladder-bar')
  // The two bars are named where they cannot be mistaken for another grid
  // line: on the RIGHT, in their own ink, with the word that says what they do.
  const name = (weight, text, className) => {
    const y = Math.round(yOf(weight)) + 0.5
    node.append(svg('text', { class: className, x: width - 4, y: y - 5, 'text-anchor': 'end' }, [text]))
  }
  name(bars.phasic, `${bars.phasic.toFixed(2)} — enough to break in`, 'ladder-bar-name ladder-bar-name-quiet')
  name(bars.tonic, `${bars.tonic.toFixed(2)} — enough to say anything`, 'ladder-bar-name')

  // The three columns.
  LADDER_COLUMNS.forEach((column, index) => {
    const x = GUTTER_L + index * colW + COL_PAD
    const inner = colW - COL_PAD * 2
    const mine = rows.filter((row) => row.outcome === column.key)
    node.append(svg('text', { class: 'ladder-head', x, y: 16 }, [`${column.label} ${mine.length}`]))
    if (index > 0) node.append(svg('line', { class: 'ladder-divide', x1: GUTTER_L + index * colW + 0.5, y1: 22, x2: GUTTER_L + index * colW + 0.5, y2: floor }))

    for (const mark of packColumn(mine, { x, width: inner, yOf })) {
      const dot = svg('rect', {
        class: 'ladder-mark',
        'data-outcome': column.key,
        x: Math.round(mark.x),
        y: Math.round(mark.y),
        width: MARK_W,
        height: MARK_H,
        // The hover carries the row, not a repeat of the column heading it is
        // already sitting under.
        tabindex: '0',
        role: 'button',
      })
      dot.append(svg('title', {}, [`${mark.row.observation ?? mark.row.noticeKey} — ${mark.row.weight.toFixed(2)}`]))
      const pick = () => onPick?.(mark.row)
      dot.addEventListener('click', pick)
      dot.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          pick()
        }
      })
      node.append(dot)
    }
  })
}
