// The three things Gnomon says without being asked: the day, what its thinking
// costs, and whether its thinking is any good.
//
// WHERE THEY LIVE, and why.
//
// Today is not a page. It is the canvas's ZERO STATE — the first block of a
// fresh session, above the first thing you say. That is the honest place for
// it: the day is what Gnomon has to tell you before you tell it anything, and
// once you start talking the conversation grows underneath your own day rather
// than replacing it. It was a page before only because dsh's landing screen was
// the only seat a plugin could reach.
//
// The Ledger and the Instruments are not pages either, and they are not
// overlays. They are the canvas showing something other than a conversation,
// reached from the rail's foot. An overlay was the old shape because the old
// client could not have the canvas; owning it means a view switch, which is one
// less layer to reason about and cannot end up stacked under another page.
// None of these recompute anything. Every number here is a projection of a
// route that already existed and had no reader.
import { el } from './surfaces.js'
import { INSTRUMENT_ROUTES } from './cards.js'
import { read, whenVisible } from './read.js'
import { clock, focusBar, hm, json, panel, when } from './view-kit.js'
import { ENGINE_TABS } from './view-cards.js'
import { jobWords } from './view-today.js'
import { trustPanel } from './view-trust.js'
import { calibrationPanel } from './view-calibration.js'
import { hhmm, span } from './view-day.js'
import { tracePanel } from './view-trace.js'
import { reachPanel } from './view-reach.js'
import { labPanel } from './view-lab.js'
export { lensesPanel } from './view-lenses.js'
export { unsaidPanel } from './view-unsaid.js'
export { asksPanel } from './view-asks.js'
export { habitsPanel } from './view-habits.js'
export { rhythmPanel } from './view-rhythm.js'
export { dayPanel, hhmm, span, whatItSaw } from './view-day.js'
export { ledgerView } from './view-ledger.js'
export { shelfSection } from './view-shelf.js'
export { peopleSection } from './view-people.js'
export { goalsSection } from './view-goals.js'
export { answerDoor, briefLine, briefParts, doneAct, heardInPassing, jobWords, promiseRow, resumeDetails, TODAY_PARTS, todayBlock, todayParts } from './view-today.js'
export { ENGINE_TABS, engineCard, inPlayCard, rhythmCard, voiceCard } from './view-cards.js'
export { clock, focusBar, hm, longDate } from './view-kit.js'

// ── Today ─────────────────────────────────────────────────────────────────

// ── The Ledger ────────────────────────────────────────────────────────────

// ── The Instruments ───────────────────────────────────────────────────────

/**
 * Twelve readings, in two bands.
 *
 * They were one flat strip of twelve words, in the order they happened to be
 * written, and the first of them was `Trust` — a page about embedding counts
 * and redaction totals. So the first thing the owner met, every time, was the
 * engine's own health, and the seven pages that are actually ABOUT them were
 * scattered through the same row as the five that are about the machine.
 *
 * Two bands, and the owner's band first. The split is not cosmetic: these
 * answer different questions on different days ("what does it know about my
 * life" versus "is the thing working"), and a reader scanning twelve nouns for
 * one of them was reading all twelve every time.
 */
/**
 * The instruments, as `[tab, label, mark, keywords]`.
 *
 * **The fourth slot is why this comment exists.** The owner typed "rhythm"
 * into Find and got nothing, because the palette matched a card's one-word
 * NAME and nothing else — and a name is the last thing somebody reaches for
 * when they want a surface. They search for what it is about. Every card in
 * this series already has a subject sentence at the top of its body; these are
 * the words out of it, so "sleep" and "bedtime" reach Rhythm, "permissions"
 * and "obsidian" reach Reach, and "forecast" reaches Calibration.
 *
 * The words live in the card catalog (`cards.js`), the one place an
 * instrument is declared — the agent reads the same entry. Pinned by
 * *views.test.js*, which holds every tab against `PANELS` in both directions
 * and refuses one with no keywords.
 */

const RENDER = {
  trust: trustPanel,
  reach: reachPanel,
  calibration: calibrationPanel,
  lab: labPanel,
  trace: tracePanel,
}
/** Each instrument's route comes from the card catalog, shared with the agent's reader. */
const PANELS = Object.fromEntries(Object.entries(RENDER).map(([key, draw]) => [key, [INSTRUMENT_ROUTES[key], draw]]))

/** The panel keys, derived, so `views.test.js` holds them against the catalog's Engine room routes. */
export const PANEL_KEYS = Object.keys(PANELS)

/** One Engine room tab past cost as a body: a title and a node that fills itself and re-reads while visible. */
export async function instrumentPane(tab, filters = null) {
  const id = PANELS[tab] ? tab : PANEL_KEYS[0]
  const label = ENGINE_TABS.find(([k]) => k === id)?.[1] ?? id
  const mark = null
  const body = el('div', { class: 'view-body' }, [el('div', { class: 'reading', text: 'Reading…' })])
  const [route, render] = PANELS[id]
  // A day filter draws that day instead of the board span (the route takes `date`).
  const url = filters?.date ? `${route}?date=${filters.date}` : route
  // `refresh` re-reads and redraws only when the reading changed, so the pane
  // can ride the live beat without churning the DOM (or the owner's selection).
  let last = ''
  const refresh = async () => {
    try {
      const data = await json(url)
      const key = JSON.stringify(data)
      if (key === last) return
      // Stamped only once the drawing SUCCEEDED. Written before it, a renderer
      // that threw left the card saying "Reading…" for ever — the read had
      // happened, the key was already stored, so the catch below decided this
      // was a re-read failure worth leaving alone and the card never said a
      // word. Thirteen instruments shared that, and it cost half an hour on
      // this one. The reason is logged for the same reason.
      body.replaceChildren(...render(data).filter(Boolean))
      last = key
    } catch (error) {
      console.error(`[gnomon] ${id} could not be drawn:`, error)
      if (last === '') body.replaceChildren(el('div', { class: 'none', text: 'That instrument could not be read.' }))
    }
  }
  // The first read waits until the card is on screen, and a re-read only
  // happens while it still is AND the record moved in a table this reading is
  // made of — `url` is what tells `read.js` which those are. Thirteen
  // instruments on one board used to mean thirteen queued reads at boot and
  // thirteen more every thirty seconds, for cards the owner may never pan to.
  whenVisible(body, refresh, url)
  return { title: label, mark, node: el('div', { class: 'view' }, [body]) }
}

