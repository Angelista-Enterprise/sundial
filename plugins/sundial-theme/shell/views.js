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
import { whenVisible } from './read.js'
import { json } from './view-kit.js'
import { ENGINE_TABS } from './view-cards.js'
import { trustPanel } from './view-trust.js'
import { calibrationPanel } from './view-calibration.js'
import { tracePanel } from './view-trace.js'
import { reachPanel } from './view-reach.js'
import { labPanel } from './view-lab.js'
export { lensesPanel } from './view-lenses.js'
export { dayPanel, hhmm, span, whatItSaw } from './view-day.js'
export { peopleSection } from './view-people.js'
export { answerDoor, briefLine, briefParts, heardInPassing, jobWords, resumeDetails, TODAY_PARTS, todayParts } from './view-today.js'
export { ENGINE_TABS, engineCard, inPlayCard, rhythmCard, voiceCard } from './view-cards.js'
export { beliefsCard } from './view-beliefs.js'
export { routesCard } from './view-routes.js'
export { hm, longDate } from './view-kit.js'

// ── The Instruments ───────────────────────────────────────────────────────

/** The instruments' renderers; the words and routes live in the card catalog (`cards.js`), checked by views.test.js. */
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

