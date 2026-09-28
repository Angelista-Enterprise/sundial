// The icon catalogue.
//
// One set, drawn once, used by every surface. The audit rejected an icon RAIL —
// a column of glyphs standing in for words — and that rejection stands: nothing
// here replaces a label. An icon marks a line the eye is scanning for, beside
// the word that says what it is. A row with only a glyph on it has not been
// designed yet.
//
// The drawing rules follow the paper's:
//
//   · `currentColor` only, never a value. An icon inherits the tone of the text
//     it sits with, so it reads on both papers and needs no token of its own.
//     Pinned by palette.test.js, which forbids a literal colour anywhere.
//   · Stroke, not fill. Hairline at 1.25 on a 16 grid, which is the weight of
//     the borders everything else is separated by.
//   · Square caps, mitred joins, no rounding — the same argument as "no radius,
//     anywhere". A rounded icon set on square panels reads as borrowed.
//   · Sized in `em` and set on the baseline, so it grows with its text rather
//     than being placed against it.
//
// Adding one: keep it inside the 16×16 box with a half-unit of air, describe it
// in a comment by what it MEANS on this board rather than what it depicts, and
// add it to the test's roster.
import { el, svg } from './surfaces.js'

const P = (d) => svg('path', { d })

/**
 * name → the marks that draw it, on a 16×16 grid.
 *
 * Grouped by what they are for, because the useful question when reaching for
 * one is "what am I marking", not "what does it look like".
 */
export const ICONS = {
  // Time and observation.
  /** A clock: when something happened. */
  time: [svg('circle', { cx: 8, cy: 8, r: 5.75 }), P('M8 4.25V8l2.75 2')],
  /** An eye: what Gnomon watched. Not surveillance-as-decoration — it marks the observed totals. */
  seen: [P('M1.25 8S4.25 3.5 8 3.5 14.75 8 14.75 8 11.75 12.5 8 12.5 1.25 8 1.25 8Z'), svg('circle', { cx: 8, cy: 8, r: 1.9 })],
  /** A calendar: a named day. */
  day: [svg('rect', { x: 2.25, y: 3.25, width: 11.5, height: 10.5 }), P('M2.25 6.5h11.5M5.5 1.75v2.5M10.5 1.75v2.5')],

  // Where the work was.
  /** A window: the app in front. */
  app: [svg('rect', { x: 2.25, y: 3.25, width: 11.5, height: 9.5 }), P('M2.25 6.25h11.5')],
  /** A folder: the project. */
  project: [P('M1.75 12.75v-9.5h4.5l1.75 2.25h6.25v7.25Z')],
  /** A branch: the line of work a moment sat on. */
  branch: [svg('circle', { cx: 4.75, cy: 3.75, r: 1.6 }), svg('circle', { cx: 4.75, cy: 12.25, r: 1.6 }), svg('circle', { cx: 11.25, cy: 3.75, r: 1.6 }), P('M4.75 5.35v5.3M11.25 5.35V8H4.75')],
  /** A commit: one recorded change. */
  commit: [svg('circle', { cx: 8, cy: 8, r: 2.6 }), P('M1.5 8h3.9M10.6 8h3.9')],
  /** A prompt: shell commands run. */
  terminal: [P('M3 4.25 6.5 8 3 11.75M8.25 12.25H13')],

  // What was said, known, spent.
  /** A microphone: the owner's own voice, the one first-party source on a moment. */
  heard: [P('M6.25 2.75h3.5v6.5h-3.5ZM4 8v.5a4 4 0 0 0 8 0V8M8 12.5v1.75')],
  /** A message: a note on the board, which is a message and not a document. */
  note: [P('M2.25 3.25h11.5v7.5H6.5l-3 3v-3h-1.25Z')],
  /** A spark: something Gnomon worked out rather than recorded. */
  read: [P('M8 1.75v3M8 11.25v3M1.75 8h3M11.25 8h3M3.6 3.6l2.1 2.1M10.3 10.3l2.1 2.1M12.4 3.6l-2.1 2.1M5.7 10.3l-2.1 2.1')],
  /** A coin: money, at list price. */
  cost: [svg('circle', { cx: 8, cy: 8, r: 5.75 }), P('M8 4.5v7M6 6.25h3.25M6.75 9.75H10')],
  /** A target: a goal, or a forecast it is measured against. */
  goal: [svg('circle', { cx: 8, cy: 8, r: 5.75 }), svg('circle', { cx: 8, cy: 8, r: 2.4 })],
  /** A person. */
  person: [svg('circle', { cx: 8, cy: 5.25, r: 2.5 }), P('M2.75 13.75v-.75c0-2.1 2.35-3.5 5.25-3.5s5.25 1.4 5.25 3.5v.75')],
  /** A lens: search, and the search field. */
  search: [svg('circle', { cx: 7, cy: 7, r: 4.4 }), P('M10.3 10.3 14.25 14.25')],
  /** Bars: a measured quantity, a chart, a lens over numbers. */
  chart: [P('M2.5 13.5V7M6.5 13.5V2.75M10.5 13.5V9.5M14.5 13.5v-3')],
  /**
   * Stacked bands: a stretch of days read as a core sample. `chart` is columns
   * standing side by side — one axis, many values — and this is the other
   * thing: the same axis repeated down the page, one row per day. Neither
   * `chart` nor `time` nor `day` means that, which is why the roster grew.
   */
  layers: [P('M2.25 3.75h11.5M2.25 7.25h11.5M2.25 10.75h11.5M2.25 14h7')],

  /**
   * An arrow that comes back round: a thing that happens again, at about the
   * same time. `time` is a clock reading ONE position and is already the mark
   * on every moment's timestamp; `layers` is the same axis repeated down the
   * page, which is the strata; `day` is one named day. None of the three means
   * "again", which is the whole subject of the habits card, so the roster grew.
   */
  repeat: [P('M2.75 8a5.25 5.25 0 0 1 9-3.7l1.5 1.45M13.25 8a5.25 5.25 0 0 1-9 3.7L2.75 10.25'), P('M13.25 2.5v3.25H10M2.75 13.5v-3.25H6')],

  /**
   * An outline: one root rule with three things filed under it — the memory,
   * which is names with beliefs attached to them.
   *
   * The roster grew, and here is the argument. `layers` is the same axis
   * repeated down the page (the strata); `note` is one thing somebody wrote;
   * `branch` is three circles joined, which already means a commit graph and
   * would read as one here. `search` is the door to this card, not the card.
   * And deliberately NOT a node-link graph: the measurement refused to draw
   * one — 174 of 221 names hold exactly one belief — so a glyph promising a
   * graph would promise a picture that is not there.
   */
  known: [P('M2.75 2.5v10.5M2.75 4.75h5.5M2.75 8h8.5M2.75 11.25h5.5'), svg('circle', { cx: 10.4, cy: 4.75, r: 1.35 }), svg('circle', { cx: 13.15, cy: 8, r: 1.35 }), svg('circle', { cx: 10.4, cy: 11.25, r: 1.35 })],

  // States and acts. The words come from status.js; these mark them.
  /** Done. */
  done: [P('M2.75 8.25 6.5 12l6.75-8')],
  /** Failed, or wrong. */
  failed: [P('M3.75 3.75l8.5 8.5M12.25 3.75l-8.5 8.5')],
  /** Paused, or held back. */
  paused: [P('M5.75 3v10M10.25 3v10')],
  /** Open, in play — a filled dot, because live is the one thing worth a solid mark. */
  live: [svg('circle', { cx: 8, cy: 8, r: 3.25, fill: 'currentColor', stroke: 'none' })],
  /**
   * A question mark: Gnomon asking the owner something and waiting.
   *
   * The roster grew, and here is the argument, in the shape `known` and
   * `layers` set. `note` is the speech balloon and it means a message left
   * behind — a note card, a thing said with no answer expected, which is the
   * opposite of this card's whole subject. `flag` is something that wants
   * attention but not a reply. `search` is the OWNER looking, and it is
   * already the Find bar. `heard` is a microphone. None of them means "a
   * question that is owed an answer", and that is the one thing every row on
   * this surface is.
   *
   * Punctuation rather than a letterform, and the distinction is real: the
   * catalogue has no alphabet in it and is not getting one, but `?` is a mark
   * on its own, drawn here as an arc and a dot on the same 16 grid at the same
   * hairline weight as everything else.
   */
  ask: [P('M5.5 5.25a2.5 2.5 0 1 1 3.4 2.35c-.55.25-.9.8-.9 1.4v.75'), P('M8 12.5v.9')],
  /** Something that wants the owner's attention. */
  flag: [P('M8 2.25 14.75 13.75H1.25ZM8 6.5v3.25M8 11.5v.9')],
  /** Leaves this surface: opens the thing itself. */
  open: [P('M6.25 2.75H2.75v10.5h10.5V9.75M9.25 6.75l4-4M9.75 2.75h3.5v3.5')],
  /** Folds open, in place. */
  more: [P('M5.75 3.5 10.25 8l-4.5 4.5')],
}

/**
 * One icon, as a node.
 *
 * Decorative by default: an icon that sits beside its own word is noise to a
 * screen reader, so it is hidden from one unless `label` gives it something to
 * say. `size` is in `em` and almost never wants changing.
 */
export function icon(name, { label = null, size = '1em', className = null } = {}) {
  const marks = ICONS[name]
  if (!marks) return null
  const node = svg('svg', {
    class: ['icon', className].filter(Boolean).join(' '),
    viewBox: '0 0 16 16',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.25,
    'stroke-linecap': 'square',
    'stroke-linejoin': 'miter',
    ...(label ? { role: 'img' } : { 'aria-hidden': 'true', focusable: 'false' }),
  })
  if (label) node.append(svg('title', {}, document.createTextNode(label)))
  for (const mark of marks) node.append(mark.cloneNode(true))
  return node
}

/**
 * An icon and the word it marks, on one baseline.
 *
 * This is the only shape an icon ships in on a label. Reaching for `icon()`
 * alone means drawing a glyph with nothing to say what it is, which is the rail
 * the owner rejected.
 */
export function iconLabel(name, text, { className = null } = {}) {
  return el('span', { class: ['icon-label', className].filter(Boolean).join(' ') }, [icon(name), el('span', { text })])
}
