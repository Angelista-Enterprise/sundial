// `gnomon_compose_figure` results, drawn.
//
// There are two drawing paths in this client and only one of them was wired:
//
//   show_surface           → a `surface` frame → surfaces.js. Wired since day one.
//   gnomon_compose_figure  → a typed `Figure` in the TOOL RESULT → nothing.
//
// So the model would call `gnomon_compose_figure`, get a correct figure back,
// write prose referring to a drawing the owner could not see, and the numbers
// would sit in the tool row as raw JSON. That is the worst of both: the tokens
// were spent, the evidence was computed, and the answer reads as if something
// is missing — because it is.
//
// The two paths stay separate on purpose and the difference is WHO chose the
// numbers. A surface is the model's own composition; a figure's values are
// computed in `packages/kernel/src/tools/figure-tools.ts` from the record, and
// the model only picks the shape and the window. That is the acceptance
// criterion the figure tool was built around — an answer's chart and a page's
// chart cannot disagree, because they are one drawing over one set of numbers.
// This file honours it by REUSING the renderers rather than adding a second
// set: `dialPlate` is literally the same function Today's dial is drawn with,
// and four of the six kinds map onto the surface renderers unchanged.
//
// Named exports only.
import { dialPlate } from './dial.js'
import { chart, el, gaugeRow, grid, neighborhood } from './surfaces.js'

/** The six kinds `composeFigure` returns. Anything else says so rather than drawing wrong. */
export const FIGURE_KINDS = ['dial-slice', 'trend-slice', 'graph-neighborhood', 'fact-chain', 'commitment-thread', 'census']

const day = (iso) => String(iso ?? '').slice(0, 10)

/**
 * A count against its total, as a bar.
 *
 * Not `gaugeRow`: that one measures a reading against what is TYPICAL, and its
 * foot says "no baseline" when there is none. A census row has no baseline by
 * construction — it has a denominator, or it has nothing — so its foot says
 * which, and a row with `total: null` draws no bar at all rather than a full
 * one. The classes are the gauge's, so the two read as one family.
 */
function census(rows) {
  return el(
    'div',
    { class: 'gauges' },
    rows.map((row) => {
      const total = typeof row.total === 'number' && row.total > 0 ? row.total : null
      const share = total === null ? null : Math.round((row.count / total) * 100)
      return el('div', {}, [
        el('div', { class: 'gauge-head' }, [
          el('span', { class: 'gauge-label', text: row.label }),
          el('span', { class: 'gauge-value', text: row.count.toLocaleString() }),
        ]),
        // No denominator, no track: a bare count has nothing to be a share OF,
        // and a full bar would be a claim about completeness nobody made.
        total === null
          ? null
          : el('div', { class: 'gauge-track' }, [el('div', { class: 'gauge-fill', style: { width: `${Math.max(0, Math.min(100, share))}%` } })]),
        el('div', { class: 'gauge-foot' }, [el('span', { text: total === null ? 'no denominator' : `of ${total.toLocaleString()} · ${share}%` })]),
      ])
    }),
  )
}

/**
 * Figure → the body element(s) that draw it, or null when the payload does not
 * fit the kind it claims.
 *
 * Each arm is an ADAPTER onto an existing renderer wherever one fits, so the
 * marks, the em dashes and the "null is not observed, never zero" rule are
 * inherited rather than re-implemented.
 */
const RENDERERS = {
  // The same function Today draws its dial with, over the same figure shape:
  // `/gnomon/dial` returns exactly this and hands it straight to `dialPlate`.
  'dial-slice': (f) => (Array.isArray(f.curve) ? dialPlate(f) : null),

  // Bars per day. `observed: false` becomes `null`, which the chart draws as a
  // 2px stub — a day the sensors saw nothing is not a day of zero minutes.
  'trend-slice': (f) =>
    Array.isArray(f.days)
      ? chart({
          x: f.days.map((d) => d.date),
          series: [{ name: 'observed', unit: 'min', mark: 'observed', values: f.days.map((d) => (d.observed ? d.minutes : null)) }],
        })
      : null,

  // The composer already dropped superseded edges, so every line here is
  // current; what is left to say is whether Gnomon worked it out or was told.
  'graph-neighborhood': (f) =>
    Array.isArray(f.edges)
      ? neighborhood({
          center: f.center,
          edges: f.edges.map((edge) => ({ toName: edge.toName, inferred: edge.provenance === 'inference' || edge.provenance === 'assistant', superseded: false })),
        })
      : null,

  // A chain reads in time order, so it is a table and not a graph: the useful
  // question is "what did it say, when, and does it still hold".
  'fact-chain': (f) =>
    Array.isArray(f.links)
      ? grid({
          columns: [
            { key: 'at', label: 'when' },
            { key: 'object', label: f.predicate || 'value' },
            { key: 'confidence', label: 'confidence', type: 'number' },
            { key: 'provenance', label: 'from' },
            { key: 'state', label: '' },
          ],
          rows: f.links.map((link) => ({
            at: day(link.at),
            object: link.object,
            confidence: typeof link.confidence === 'number' ? link.confidence : null,
            provenance: link.provenance,
            state: link.supersededAt ? `superseded ${day(link.supersededAt)}` : 'current',
          })),
          note: `${f.entityName} · ${f.predicate}`,
        })
      : null,

  // One thread, one row. `activeDays` is the number that matters and the grid
  // renders a null as an em dash, which is what an unopened thread deserves.
  'commitment-thread': (f) =>
    typeof f.name === 'string'
      ? grid({
          columns: [
            { key: 'name', label: 'thread' },
            { key: 'branch', label: 'branch' },
            { key: 'openedAt', label: 'opened' },
            { key: 'activeDays', label: 'active days', type: 'number' },
            { key: 'touches', label: 'touches', type: 'number' },
          ],
          rows: [{ name: f.name, branch: f.branch, openedAt: day(f.openedAt) || null, activeDays: f.activeDays, touches: f.touches }],
        })
      : null,

  census: (f) => (Array.isArray(f.rows) ? census(f.rows) : null),
}

/**
 * One composed figure → the element that draws it.
 *
 * `{ unavailable }` is a real answer from the composer, not an error: a day
 * with nothing observed has no shape. It draws as the reason, in the figure's
 * own frame, so the owner sees WHY there is no drawing instead of a gap.
 *
 * The frame is `.surface`, deliberately: a figure and a surface are the same
 * kind of object on the page, and giving them different chrome would say they
 * are not.
 */
export function renderFigure(figure) {
  if (figure === null || typeof figure !== 'object') return null
  const head = (title, because) =>
    el('div', { class: 'surface-head' }, [
      el('span', { class: 'surface-title', text: title }),
      because ? el('span', { class: 'surface-because', text: `· ${because}` }) : null,
    ])

  if (typeof figure.unavailable === 'string') {
    return el('section', { class: 'surface' }, [head('figure'), el('div', { class: 'surface-body' }, el('div', { class: 'surface-fail', text: figure.unavailable }))])
  }
  if (typeof figure.kind !== 'string') return null

  const body = RENDERERS[figure.kind]?.(figure) ?? null
  // The caption is composed with the numbers ("4h 47m observed of 10h 27m"),
  // so it is the figure's own claim and belongs in the head rather than under it.
  const [title, ...rest] = String(figure.caption ?? figure.kind).split(' · ')
  return el('section', { class: 'surface' }, [
    head(title || figure.kind, rest.join(' · ')),
    el('div', { class: 'surface-body' }, body ?? el('div', { class: 'surface-fail', text: `No renderer for "${figure.kind}" yet.` })),
  ])
}

/**
 * Figures in the transcript that can take the stage.
 *
 * The node itself moves — no copy — and a stub keeps its place in the turn, so
 * bringing it back puts it exactly where the record has it. Gnomon lifts a
 * surface the moment it draws one live; the owner lifts any figure, new or
 * old, with the act in its head.
 *
 * A figure on the board belongs to the BOARD, not to the thread it was drawn
 * in. Switching threads used to take every staged figure off the board, and
 * the server stamped each of those removes as the owner's. Now `clear` only
 * forgets the transcript's nodes: the cards stay where they are, and when the
 * thread is opened again (or the page reloads onto it) a replayed figure whose
 * card is still on the board is lifted back into that card, quietly.
 *
 * `stage` is the four things this needs from stage.js, passed in so the rule
 * can be tested without a board.
 */
export function figureStage({ onBoard, pane, focusPane, dismissPane }) {
  const figures = new Map()
  const lift = (id, { quiet = false } = {}) => {
    const node = figures.get(id)
    if (node === undefined) return false
    if (!node.isConnected || node.closest('.pane-body')) return !quiet && void focusPane(id)
    const title = node.querySelector('.surface-title')?.textContent || 'Figure'
    const stub = el('div', { class: 'surface-stub' }, [
      el('span', { text: `${title} — on the stage` }),
      el('button', { type: 'button', class: 'link', text: 'bring back', onclick: () => dismissPane(id) }),
    ])
    node.replaceWith(stub)
    // What it shows goes onto the card as its text, so `gnomon_look` reads the
    // same thing the owner sees.
    const text = (node.innerText ?? node.textContent ?? '').replace(/\s+\n/g, '\n').trim().slice(0, 4000)
    pane(id, { title, node, home: stub, text, reading: node.querySelector('.surface-because')?.textContent.replace(/^·\s*/, '') ?? '' })
    if (!quiet) focusPane(id)
    return true
  }
  return {
    /** A figure drawn into the transcript. `live`: Gnomon just drew it, so it takes the stage. */
    add(node, id, { live = false } = {}) {
      figures.set(id, node)
      node.querySelector('.surface-head')?.append(el('button', { type: 'button', class: 'stage-act', text: 'Stage', title: 'Bring this to the stage', onclick: () => lift(id) }))
      if (live) lift(id)
      else if (onBoard(id)) lift(id, { quiet: true })
    },
    /** The board holds a card for `id` and nothing draws it: put the replayed figure back in it. */
    relift: (id) => lift(id, { quiet: true }),
    /** The thread leaves the page. Its figures on the board stay there. */
    clear: () => figures.clear(),
  }
}
