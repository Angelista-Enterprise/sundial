// Gnomon's client.
//
// No framework and no build step, on purpose. The whole app is a reducer over
// one frame stream: the server projects the session log into frames
// (`frames.js`), and everything here does is fold them into the canvas. Replay
// and live are the same fold, which is why re-opening a session looks identical
// to having watched it happen.
//
// The state that exists is deliberately small — the current session id, the
// element the current turn is appending into, and a map of open tool rows. The
// canvas itself IS the state; there is no shadow copy of the transcript to keep
// in step with it.
import { COMPANION_SESSION_ID } from '@sundial/helpers/vocab.js'
import { renderMarkdown, setCardLabel } from './markdown.js'
import { figureStage, renderFigure } from './figures.js'
import { el, liveFirst, renderSurface } from './surfaces.js'
import { TODAY_PARTS, engineCard, hhmm, inPlayCard, rhythmCard, todayParts, voiceCard } from './views.js'
import { elapsed, resultGist, toolLine } from './tool-line.js'
import { jsonNode, jsonShape, parseResult } from './json-view.js'
import { applyBoard, dismissPane, filtersOf, fitAll, focusPane, focused, has, lensShelf, mount, notice, onBoard, onChange, pane, pointAt, setResolver, titleOf, touchedSince, walkContinue } from './stage.js'
import { openPalette } from './palette.js'
import { mascot } from './mascot.js'
import { openEntity, openExplore, openMoment } from './explore.js'
import { BLUR_LABEL, SETTINGS, applySettings, loadSettings, nextPaper, setSetting, settingsNode } from './settings.js'
import { kanbanCard } from './sections.js'
import { liveSpan } from './span.js'
import { CARDS, MENU, cardOf, heirOf } from './cards.js'
import { checkSignedIn, onReading, markStale, rereadAll } from './read.js'
import { status } from './status.js'
import { postVerdict, verdictActs } from './verdicts.js'

const $ = (id) => document.getElementById(id)
const canvas = $('canvas')
const rail = $('sessions')
const companionSeat = $('companion')
const companionSaid = $('companion-said')
const companionDot = $('companion-dot')
const threadsLabel = $('threads-label')
const companionMeter = $('companion-meter')
const companionFill = $('companion-fill')
const companionTokens = $('companion-tokens')
const input = $('input')
const send = $('send')
const bar = $('bar')
const modelPick = $('model-pick')
const modelMenu = $('model-menu')
const askSeat = $('ask')
const strip = $('strip')

// Signed out (read.js noticed a 401): one line in the foot, with what to do.
document.addEventListener('gnomon:signed-out', () => {
  $('signed-out').hidden = false
})

// ── What the page is reading ──────────────────────────────────────────────
// The head's bottom rule turns ochre while a route is in flight and names the
// routes. It is deliberately LATE: a read that lands inside 180ms never shows
// a bar at all, because a bar that flickers on every beat is worse than no bar.
// Hiding is immediate — the moment nothing is in flight, the rule is gone.
const readingLine = $('reading-line')
const readingWhat = $('reading-what')
let readingTimer = 0
onReading((names) => {
  clearTimeout(readingTimer)
  if (names.length === 0) {
    readingLine.hidden = true
    readingWhat.hidden = true
    return
  }
  readingWhat.textContent = names.length > 3 ? `reading ${names.length} readings` : `reading ${names.join(' · ')}`
  if (readingLine.hidden) {
    readingTimer = setTimeout(() => {
      readingLine.hidden = false
      readingWhat.hidden = false
    }, 180)
  }
})

// ── The stage ─────────────────────────────────────────────────────────────
// Everything the owner can look at is a pane; the conversation and the threads
// exist from the first frame. `follow` and `loadQuestion` are declarations, so
// they are already defined here.
// A card the record names that nobody has drawn yet (Gnomon placed it, or a
// scene brought it back) is built here from its id.
/** Write what a card is set to into the record (the stage redraws it from there). */
const setFilters = (id, filters) => fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'place', id, kind: id, filters }) }).catch(() => {})
/** Open any card by id, as a board link does. */
const openCard = (id) => document.dispatchEvent(new CustomEvent('gnomon:card', { detail: id }))

const resolveCard = async (id, card = null) => {
  const filters = card?.filters ?? null
  const part = TODAY_PARTS.find(([key]) => key === id)
  if (part) {
    // The day card set to a date draws that day; Activity set to a tab opens on it.
    const node = (await todayParts(loadQuestion, id === 'dial' ? (filters?.date ?? null) : null))[id]
    if (filters?.tab) node?.selectTab?.(filters.tab)
    return { title: part[1], node }
  }
  // A drawn figure's card, back from the record: the replayed thread's node fills it.
  if ((id.startsWith('surface:') || id.startsWith('figure:')) && figureSeat.relift(id)) return null
  if (id === 'kanban') return { title: 'Kanban', node: await kanbanCard(loadQuestion) }
  if (id === 'play') return { title: 'In play', node: await inPlayCard(loadQuestion, filters) }
  if (id === 'rhythm') return { title: 'Rhythm', node: await rhythmCard(filters) }
  if (id === 'voice') return { title: 'Voice', node: await voiceCard(filters) }
  if (id === 'settings') return { title: 'Settings', node: settingsNode() }
  if (id === 'work') return { title: 'Work', node: workNode(filters) }
  // An instrument keeps its own re-read: `whenVisible` registered it with the
  // route it reads, so a `stale` frame naming that route's tables reaches it
  // without the shell holding a registry of them.
  if (id === 'engine') return { title: 'Engine room', node: await engineCard(filters, (tab) => setFilters('engine', tab === 'cost' ? null : { tab })) }
  // These three seat their own pane and fill it from a read tool, so they hand
  // back nothing and the stage leaves the seat they took alone. The card's OWN
  // id is passed through: an `entity:Pat` card must fill the seat the record
  // named, not a second one under the lowercased name.
  if (id === 'explore') openExplore(filters?.query ?? '', { quiet: true, kind: filters?.kind ?? null, date: filters?.date ?? null, meeting: filters?.meeting ?? null })
  else if (id.startsWith('entity:')) openEntity(id.slice(7), { quiet: true, id })
  else if (id.startsWith('moment:')) openMoment(id.slice(7), { quiet: true, id })
  return null
}
setResolver(resolveCard)

/**
 * Can this id be OPENED — not "is it on the board". A link that only works
 * while the card already happens to be up is a link the owner learns not to
 * trust, and "the goals card" is worth pressing precisely when it is not in
 * front of them. Every id `resolveCard` above can build belongs here; the two
 * lists are read side by side on purpose.
 */
const CARD_NAME = new Map([
  // Every single card in the catalog (families like `entity:` need a key, so they are not openable by name).
  ...CARDS.filter((c) => !c.id.endsWith(':')).map((c) => [c.id, c.title]),
  ['session', 'the conversation'],
  ['chat', 'the conversation'],
])
/** These three seat their own pane on the way in, so `has` is false for a moment after. */
const seatsItself = (id) => id === 'explore' || id.startsWith('entity:') || id.startsWith('moment:')
const nameOf = (id) => {
  if (CARD_NAME.has(id)) return CARD_NAME.get(id)
  if (heirOf(id)) return CARD_NAME.get(heirOf(id).id) ?? null
  // A lens is named by the shelf, not by the board, so a link to one Gnomon
  // made last week still reads as its title after its card was thrown away.
  const shelved = lensShelf()[id]
  if (shelved) return shelved.title
  // A card already up carries its own words — a note's text, a web card's
  // title. Not a lens, whose text is its whole JSON spec, and not an essay: a
  // link is a name, so anything that is not one is no better than the id.
  const own = has(id) ? titleOf(id) : id
  if (own !== id && own.length <= 40 && !own.startsWith('{')) return own
  if (id.startsWith('entity:')) return id.slice(7)
  return null
}

setCardLabel(nameOf)

// A `board:` link in Gnomon's own words, pressed. The card it names may not be
// on the board yet — the sentence is allowed to point at anything the resolver
// can build — so this takes the same path a summon does: build, seat, frame.
// A bare `board:` means the whole board.
document.addEventListener('gnomon:card', async (event) => {
  // A link to a retired card (in an old transcript) opens the card that owns
  // its facts now, set to the same view (an old Trust link opens the Engine room on Trust).
  const heir = heirOf(String(event.detail ?? ''))
  if (heir?.filters) await setFilters(heir.id, heir.filters)
  const id = heir?.id ?? String(event.detail ?? '')
  if (id === '') return fitAll()
  // A lens whose card was thrown away is put back from the shelf, through the
  // record, so it lands exactly as Gnomon's own placement did — and the board
  // frame that comes back is what frames it.
  const shelved = has(id) ? null : lensShelf()[id]
  if (shelved) {
    await fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'place', id, kind: 'lens', text: shelved.spec }) }).catch(() => {})
    await fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'focus', ids: [id], text: shelved.title }) }).catch(() => {})
    return
  }
  if (!has(id)) {
    const made = await resolveCard(id)
    if (made) pane(id, made)
  }
  // Nothing could be built and nothing seats itself: say so rather than
  // swallowing the press, which reads as a broken screen.
  if (!has(id) && !seatsItself(id)) return notice({ text: `There is no ${id} card to open.` })
  focusPane(id)
})
// Mount first: `mount` seats itself synchronously and reads the record in the
// background; panes registered meanwhile queue until it has.
mount({ board: $('board'), world: $('world'), tools: $('board-tools'), parked: $('parked') })
// The thread list lives in the conversation card now (it was its own Threads
// card): the bar names the thread you are in, and its button opens the list.
$('thread-picker').append($('rail'))
// A board saved while Threads was a card still names one; it has nothing to draw.
onChange(({ cards }) => cards.includes('threads') && dismissPane('threads'))

// The conversation is a card (it was the ghost, a panel over the board's
// right edge, until 2026-09-23). `#ghost` keeps its id so every seam that
// reaches for it still resolves; it simply lives in the `chat` card's body.
// ⌥C (stage.js clicks the old toggle) brings the card to the front with the
// cursor in the composer, and from the front sends focus back where it was.
const ghost = $('ghost')
// Focusing the card (⌥C, a click, the arrow keys) puts the cursor in the composer.
pane('chat', { title: 'Gnomon', mark: 'note', node: ghost, park: true, onFocus: () => (follow(true), input.focus({ preventScroll: true })) })
let beforeChat = null
const setGhost = (open) => {
  const front = focused() === 'chat'
  if (open) {
    if (!front) beforeChat = focused()
    focusPane('chat')
    ghost.dataset.open = 'true'
    return
  }
  ghost.dataset.open = 'false'
  if (!front) return
  if (beforeChat !== null && beforeChat !== 'chat' && has(beforeChat)) focusPane(beforeChat)
  else fitAll()
}
$('ghost-toggle').addEventListener('click', (event) => {
  // It sits inside the chat card: without this the click also reads as a click
  // ON that card, and focus lands straight back on the conversation.
  event.stopPropagation()
  const opening = focused() !== 'chat'
  setGhost(opening)
  if (opening) input.focus({ preventScroll: true })
})
// ── The floating conversation ──────────────────────────────────────────
// When the view leaves the chat card while Gnomon is still talking — Gnomon
// showing a card mid-answer, or the owner stepping away — the conversation
// does not stay behind. The SAME element (#ghost: transcript, scroll, composer)
// lifts into a seat floating over the board, so nothing is copied and nothing
// can disagree. Coming back to the chat card (⌥C, a click) settles it home;
// the fold button sends it home without moving the view.
const floatSeat = el('aside', { class: 'float-chat', hidden: true, 'aria-label': 'The conversation, floating' }, [
  el('div', { class: 'float-head' }, [
    el('span', { class: 'dot float-dot' }),
    el('span', { class: 'float-name', text: 'Gnomon' }),
    el('button', { type: 'button', class: 'link', text: 'Back to chat', title: 'Back to the chat card (⌥C)', onclick: () => setGhost(true) }),
    el('button', { type: 'button', class: 'float-x', 'aria-label': 'Fold', title: 'Fold it back into the chat card', onclick: () => dockChat() }),
  ]),
])
document.querySelector('.shell')?.append(floatSeat)
const chatAway = el('div', { class: 'chat-away', text: 'The conversation is floating over the board. ⌥C brings it back here.' })
let floating = false
function floatChat() {
  if (floating || ghost.parentElement === null) return
  floating = true
  ghost.replaceWith(chatAway)
  floatSeat.append(ghost)
  floatSeat.hidden = false
  follow(true)
}
function dockChat() {
  if (!floating) return
  floating = false
  if (chatAway.isConnected) chatAway.replaceWith(ghost)
  floatSeat.hidden = true
  follow(true)
}
/** Gnomon is mid-turn: the owner's own, or one it started (the session watch). */
const talking = () => state.running || state.watchLive === true
onChange(({ focus }) => {
  if (focus === 'chat') dockChat()
  else if (talking()) floatChat()
})
const markTalking = () => floatSeat.toggleAttribute('data-talking', talking())

/** Bring the conversation to the owner: its card in front, landed at its end. */
function showConversation() {
  setGhost(true)
  follow(true)
}
const gnomon = mascot($('mascot'))
$('mascot').addEventListener('click', () => {
  showConversation()
  input.focus({ preventScroll: true })
})

/** Everything mutable, in one place so it is easy to see how little there is. */
const state = {
  sessionId: null,
  /** The `.turn` element the current stream is appending into. */
  turn: null,
  /** The `<p class="prose">` the assistant's text is growing in. */
  prose: null,
  /** callId → the row element, so a result can close the row that opened it. */
  tools: new Map(),
  /** callId → the drawn surface, so a REFUSED one can say so instead of standing there wrong. */
  surfaces: new Map(),
  /** approval id → its card, so an outcome can settle the card that asked. */
  approvals: new Map(),
  running: false,
  /** Text is arriving: the gnomon speaks rather than thinks. */
  speaking: false,
  /** Reading history back: a drawn surface stays in its turn instead of taking the stage. */
  replaying: false,
  aborter: null,
  /** 'session' | 'ledger' | 'instruments' — what the canvas is showing. */
  view: 'session',
  /** Select mode in the rail, and what is picked. */
  selecting: false,
  picked: new Set(),
  /** Whether the rail is showing the archived sessions instead of the live ones. */
  showArchived: false,
  /** The last listing, so select mode can redraw without a fetch. */
  rows: [],
}

// A figure in the transcript that can take the stage, and the card it keeps
// across a thread switch: see `figureStage` in figures.js.
const figureSeat = figureStage({ onBoard, pane, focusPane, dismissPane })

// ── The canvas ────────────────────────────────────────────────────────────

function stack() {
  let node = canvas.querySelector('.stack')
  if (node === null) {
    node = el('div', { class: 'stack' })
    canvas.append(node)
  }
  return node
}

/**
 * Keep the newest thing in view — unless the owner has scrolled away to read
 * something.
 *
 * Tracked as a FLAG the owner sets, not inferred from distance. Distance was
 * the first attempt and it fails on exactly the content worth following: a
 * table or a code block lands in one frame, adds more than the threshold at
 * once, and auto-scroll switches itself off for the rest of the answer with
 * nobody having touched anything.
 *
 * The flag is safe to derive from the scroll event because every scroll WE
 * perform lands at the bottom, so an event that leaves us anywhere else came
 * from the owner.
 */
let stickToBottom = true

canvas.addEventListener('scroll', () => {
  stickToBottom = canvas.scrollHeight - canvas.scrollTop - canvas.clientHeight < 40
})

function follow(force = false) {
  if (!force && !stickToBottom) return
  canvas.scrollTop = canvas.scrollHeight
  stickToBottom = true
}

function clearCanvas() {
  document.body.removeAttribute('data-lens')
  // Figures on the board stay: a thread switch is not the owner removing them.
  figureSeat.clear()
  canvas.replaceChildren()
  state.turn = null
  state.prose = null
  state.tools.clear()
  state.surfaces.clear()
  state.approvals.clear()
}

/**
 * The day, as the canvas's zero state.
 *
 * Rendered INTO the stack rather than as a screen the first turn replaces, so
 * the conversation grows underneath the owner's own day instead of wiping it.
 * That is the whole reason Today stopped being a page: it is what Gnomon has to
 * say before you say anything, which makes it a beginning and not a
 * destination.
 */
/** A row's question, loaded into the composer with where the owner was standing. */
function loadQuestion(place, question) {
  input.value = question
  autosize()
  input.focus({ preventScroll: true })
  input.dataset.place = place
  setRunning(false)
}

/**
 * The day, as the stage's zero state: its own pane, in focus until the owner
 * says something, then in the wings — still live, still the same node.
 */
async function showToday() {
  const parts = await todayParts(loadQuestion)
  const block = parts.today
  dayObserved = block?.querySelector('.numeral')?.dataset.value ?? dayObserved
  queueMicrotask(drawStrip)
  // The conversation has nothing in it yet; its frame must still say what it
  // is and where to begin, in the wings as much as in focus.
  if (stack().querySelector('.turn, .empty') === null) {
    stack().append(
      el('div', { class: 'empty' }, [
        el('p', { text: 'Nothing said yet.' }),
        el('p', { class: 'empty-sub', text: 'Today is on the stage. Click any row there to load a question, or just talk — the answer grows here.' }),
      ]),
    )
  }
  pane('today', {
    title: 'Today',
    sticky: true,
    node:
      block ??
      el('div', { class: 'empty' }, [
        el('p', { text: 'Gnomon answers from the record it kept — the day, the projects, the facts it believes.' }),
        el('p', { class: 'empty-sub', text: 'It will say so when the record cannot answer.' }),
      ]),
  })
  // The other parts of the day (TODAY_PARTS): their own cards, beside the face. The
  // rule finds each a free place; nothing lands on anything.
  // A part the record has set to something (a day, a tab) is drawn by the
  // resolver with its filters; today's unfiltered node must not replace it.
  for (const [id, title] of TODAY_PARTS) if (!filtersOf(id)) pane(id, { title, node: parts[id], near: 'today' })
  // No focus here: the board decides what is in focus (the first card at boot,
  // the last visited after that), and a removed Today stays removed.
}

/**
 * The surfaces index, as a LENS on the canvas rather than a tab beside it.
 *
 * A session's surfaces are already in the canvas, in the order they were drawn.
 * A second list would be a second source of truth about the same thing, free to
 * disagree with the first; hiding everything else cannot.
 *
 * Appears only once a session has drawn one, because a control that is always
 * there and usually says "0" is furniture.
 */
function updateLens() {
  const count = stack().querySelectorAll('.surface:not([data-refused])').length
  let lens = canvas.querySelector('.lens')
  if (count === 0) {
    lens?.remove()
    document.body.removeAttribute('data-lens')
    return
  }
  if (lens === null) {
    const toggle = el('button', {
      type: 'button',
      class: 'lens-toggle',
      'aria-pressed': 'false',
      text: 'Show only these',
      onclick: () => {
        const on = document.body.getAttribute('data-lens') === 'surfaces'
        document.body.toggleAttribute('data-lens', !on)
        if (!on) document.body.setAttribute('data-lens', 'surfaces')
        toggle.setAttribute('aria-pressed', String(!on))
        toggle.textContent = on ? 'Show only these' : 'Show everything'
      },
    })
    lens = el('div', { class: 'lens' }, [el('span', { class: 'lens-count' }), toggle])
    stack().prepend(lens)
  }
  lens.firstChild.textContent = `${count} surface${count === 1 ? '' : 's'} in this session`
}

/**
 * Fold the day into the strip.
 *
 * Once the owner has said something, the day is context rather than content —
 * it has done its job of being the first thing on the page. It is not removed,
 * it MOVES: the strip is already showing the same facts, so the block folds up
 * into where they now live. Height and opacity together, then gone.
 */
function collapseToday() {
  // The owner spoke: the conversation must be where they can read the answer.
  // A replayed thread at boot is not the owner speaking; the board stays first.
  if (!state.replaying) showConversation()
}

/** Open a new turn block. */
function openTurn() {
  canvas.querySelector('.empty')?.remove()
  collapseToday()
  foldTurn(state.turn)
  state.turn = el('div', { class: 'turn' })
  state.prose = null
  stack().append(state.turn)
  return state.turn
}

function turn() {
  return state.turn ?? openTurn()
}

/** Taller than this and a finished answer folds behind its opening lines. */
const FOLD_PX = 220

/**
 * A finished turn recedes. The latest answer is read whole; the ones before it
 * fold to their first lines and their tool rows, so the thread reads as a
 * conversation rather than as one long page. One click brings a turn back.
 */
function foldTurn(prev) {
  if (!prev || prev.querySelector(':scope > .more') !== null) return
  const tall = [...prev.querySelectorAll(':scope > .prose')].reduce((n, p) => n + p.offsetHeight, 0)
  if (tall <= FOLD_PX) return
  prev.dataset.folded = ''
  prev.append(el('button', { type: 'button', class: 'link more', text: 'Read the whole answer', onclick: (e) => { delete prev.dataset.folded; e.currentTarget.remove() } }))
}

/**
 * The block the assistant is currently speaking into.
 *
 * It holds its own RAW markdown on `_md`, because the rendered DOM cannot be
 * appended to — a delta may close a list, finish a fence or complete a `**`
 * that was half-typed one frame ago, so the block is re-parsed rather than
 * grown. Keeping the source on the element means each block owns its own
 * buffer and a tool call in between simply starts a new one.
 */
function prose() {
  if (state.prose === null || !state.prose.isConnected) {
    state.prose = el('div', { class: 'prose' })
    state.prose._md = ''
    turn().append(state.prose)
  }
  return state.prose
}

/**
 * Re-render one prose block from its raw markdown, at most once a frame.
 *
 * Parsing a few kilobytes per delta would be pure waste at thirty frames a
 * second, and the DOM churn would fight text selection. Coalescing to a frame
 * makes it exactly as often as the screen can show it.
 */
const pendingRender = new Set()
let renderQueued = false

function drawProse(block) {
  pendingRender.add(block)
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    for (const node of pendingRender) {
      if (!node.isConnected) continue
      node.replaceChildren(renderMarkdown(node._md))
    }
    pendingRender.clear()
    follow()
  })
}

/** The work row list for this turn, created the first time a tool is called. */
function work() {
  let node = turn().querySelector(':scope > .work')
  if (node === null) {
    node = el('div', { class: 'work' })
    turn().append(node)
  }
  return node
}

/**
 * The model's plan (`todo_write`), drawn at the top of the turn it belongs to
 * and REPLACED on every frame — the tool sends the whole list each time. A
 * finished turn keeps its checklist; the next turn is a new block, so it
 * starts without one.
 */
function drawPlan(todos) {
  let node = turn().querySelector(':scope > .plan')
  if (node === null) {
    node = el('ol', { class: 'plan', 'aria-label': 'Plan' })
    // Below the owner's own words, above everything Gnomon then did.
    const said = turn().querySelector(':scope > .said')
    if (said !== null) said.after(node)
    else turn().prepend(node)
  }
  node.replaceChildren(...todos.map((item) => el('li', { class: 'plan-step', 'data-status': item.status, text: item.content })))
  drawWorkPlan(todos)
}

// ── The Work card ─────────────────────────────────────────────────────────
// Gnomon's work, on the board: one card, one block per turn, one row per tool
// call — name, what it asked, what came back, how long. The rows are the same
// `tool` / `tool-done` frames the chat folds, so replaying a session rebuilds
// them; durations are live-only because the frames carry no clock, and an
// honest blank beats an invented number. Above the rows: the plan, which the
// owner can edit — skip, reorder, add — and every edit is a `board:plan` event
// Gnomon reads before its next step.
const wk = { node: null, block: null, rows: new Map(), plan: null, seats: null, filters: null }

/**
 * Four seats, in the order the card is read: what is running, the plan it is
 * following, where the work stands, and every other job — waiting, finished,
 * and the tool rows of the turns that did them.
 *
 * Built once and filled in place. They used to prepend themselves as they
 * arrived, so the card's order was whichever frame landed first, and a finished
 * job left nothing behind but a fold titled "Gnomon working" — the card could
 * not answer the one question it exists for.
 *
 * A seat with nothing in it hides rather than standing empty; `Where the work
 * stands` is the exception, because zero jobs today is itself the reading.
 */
function workSeats() {
  if (wk.seats !== null) return wk.seats
  const seat = (name, label) => {
    const body = el('div', { class: 'work-seat-body' })
    const node = el('section', { class: 'work-seat', 'data-seat': name }, [label === null ? null : el('h3', { class: 'work-seat-title', text: label }), body])
    return { node, body }
  }
  wk.seats = { now: seat('now', 'Working'), plan: seat('plan', null), info: seat('info', 'Where the work stands'), past: seat('past', 'Other jobs'), soon: seat('soon', 'Coming up'), rules: seat('rules', 'Rules it watches for'), can: seat('can', 'What Gnomon can do') }
  wk.node.append(wk.seats.now.node, wk.seats.plan.node, wk.seats.info.node, wk.seats.past.node, wk.seats.soon.node, wk.seats.rules.node, wk.seats.can.node)
  drawWorkExtras()
  wk.seats.now.node.hidden = true
  wk.seats.plan.node.hidden = true
  wk.seats.past.node.hidden = true
  return wk.seats
}

/**
 * Two standing seats: what Gnomon has set itself to come back to, and what it
 * can do. The second is what Intro should have been — the owner asked "what
 * can you do" some ninety times; the answer is kept where the work is.
 */
const CAN_DO = [
  ['Your day', 'What did I do yesterday? · Walk me through today · Show me last Tuesday'],
  ['People and projects', 'What do you know about Alex? · What is open on sundial? · Who did I meet this week?'],
  ['Code', 'What did I commit this week? · Where did I leave that branch?'],
  ['The board', 'Put In play and the Engine room up · Open Rhythm on the days'],
  ['The web', 'Research this and leave it on my shelf · Read this page for me · Do this on a site, step by step (you approve each step)'],
  ['On its own', 'Keep an eye on this and report back · Remind me at four to call Tom'],
  ['Asks you first', 'Put a meeting in my calendar · Run the tests · Write this into Obsidian'],
]
async function drawWorkExtras() {
  const [wakeups, reach] = await Promise.all([fetch('/gnomon/api/wakeups').then((r) => r.json()).catch(() => null), fetch('/gnomon/reach').then((r) => r.json()).catch(() => null)])
  const open = [...(wakeups?.open ?? [])].sort((a, b) => a.at.localeCompare(b.at))
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  wk.seats.soon.body.replaceChildren(...open.map((w) => el('div', { class: 'work-line' }, [el('span', { class: 'work-line-key', text: when(w.at) }), el('span', { class: 'work-line-text', text: w.reason })])))
  wk.seats.soon.node.hidden = open.length === 0
  drawRules()
  const used = Object.values(reach?.ownUsed ?? {}).filter((u) => u?.calls).length
  wk.seats.can.body.replaceChildren(
    ...CAN_DO.map(([group, examples]) => el('div', { class: 'work-line' }, [el('span', { class: 'work-line-key', text: group }), el('span', { class: 'work-line-text', text: examples })])),
    reach
      ? el('p', { class: 'panel-note' }, [
          document.createTextNode(`${reach.totalTools} tools, ${used} of its own used since ${new Date(reach.countingSince).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}${(reach.integrations ?? []).length ? `; your services: ${reach.integrations.map((i) => i.name).join(', ')}` : ''}. `),
          el('button', { type: 'button', class: 'board-link', text: 'Every tool, on the Engine room', onclick: () => setFilters('engine', { tab: 'reach' }).then(() => openCard('engine')) }),
        ])
      : null,
  )
}

/**
 * The rules Gnomon watches for (UC4 F20): one row each — its words, its
 * version, this week against what its backtest promised, the owner's verdicts
 * with their n, and the gate's word on its last fires. Pause, Edit and Drop sit
 * on the row. Drop arms on the first click. Edit opens the spec; Test replays
 * it over 30 days, and only a tested text can be saved, which the host tests
 * once more before it becomes the next version.
 */
const HEARD = { phasic: 'said', tonic: 'listed', suppressed: 'held back', deferred: 'waited' }
async function drawRules() {
  const body = await fetch('/gnomon/api/rules').then((r) => r.json()).catch(() => null)
  const rules = body?.rules ?? []
  const seat = wk.seats.rules
  seat.node.hidden = rules.length === 0
  const post = (payload) => fetch('/gnomon/api/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((r) => r.json()).catch(() => ({ valid: false, error: 'Gnomon could not answer that.' }))
  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  seat.body.replaceChildren(
    el('div', { class: 'work-jobs' }, rules.map((r) => {
      const fired = r.lastFires.length ? `Last: ${r.lastFires.map((f) => `${when(f.at)} ${HEARD[f.channel] ?? f.channel}`).join(' · ')}` : 'Not fired since it was adopted.'
      const acts = el('span', { class: 'rule-acts' })
      const edit = el('div', { class: 'rule-edit', hidden: true })
      const drop = el('button', {
        type: 'button', class: 'act act-small', text: 'Drop', title: 'Stop watching for this. Click twice.',
        onclick: async (event) => {
          const b = event.currentTarget
          if (!b.hasAttribute('data-arm')) { b.setAttribute('data-arm', ''); b.textContent = 'Drop it?'; return }
          b.disabled = true
          await post({ op: 'drop', id: r.id })
          drawRules()
        },
      })
      acts.append(
        el('button', { type: 'button', class: 'act act-small', text: r.paused ? 'Resume' : 'Pause', onclick: async (event) => { event.currentTarget.disabled = true; await post({ op: r.paused ? 'resume' : 'pause', id: r.id }); drawRules() } }),
        el('button', { type: 'button', class: 'act act-small', text: 'Edit', onclick: () => { edit.hidden = !edit.hidden; if (!edit.hidden) edit.querySelector('textarea').focus() } }),
        drop,
      )
      const spec = el('textarea', { class: 'rule-spec', rows: 8, spellcheck: 'false', 'aria-label': `The spec of ${r.title}` })
      spec.value = JSON.stringify((({ id: _id, ...rest }) => rest)(r.rule), null, 2)
      const said = el('p', { class: 'panel-note', text: 'Test replays it over the last 30 days. Only a tested spec can be saved.' })
      let tested = null
      const save = el('button', { type: 'button', class: 'act act-small', text: `Save as v${r.version + 1}`, disabled: true, onclick: async (event) => {
        event.currentTarget.disabled = true
        const out = await post({ op: 'adopt', id: r.id, rule: JSON.parse(tested) })
        said.textContent = out.adopted ? `Saved: ${out.fired} fires in 30 days, ${out.heard} heard.` : (out.error ?? 'Not saved.')
        if (out.adopted) drawRules()
      } })
      spec.addEventListener('input', () => { save.disabled = spec.value !== tested })
      edit.append(spec, el('span', { class: 'rule-acts' }, [
        el('button', { type: 'button', class: 'act act-small', text: 'Test', onclick: async () => {
          let rule
          try { rule = JSON.parse(spec.value) } catch { said.textContent = 'That is not JSON yet.'; return }
          said.textContent = 'Replaying 30 days…'
          const out = await post({ op: 'test', id: r.id, rule })
          if (!out.valid) { said.textContent = out.error ?? 'Not a rule.'; tested = null; save.disabled = true; return }
          said.textContent = `Would have fired ${out.fired} times in ${out.days} days (older half ${out.holdout.older.fired}, recent half ${out.holdout.recent.fired}); heard ${out.gate.phasic + out.gate.tonic}${r.predicted ? `, against ${r.predicted.fired} for v${r.version}` : ''}.`
          tested = spec.value
          save.disabled = false
        } }),
        save,
      ]), said)
      return el('div', { class: 'work-job rule-row', 'data-mark': r.paused ? 'paused' : r.week?.drifting ? 'waiting' : 'on' }, [
        el('span', { class: 'work-job-mark' }),
        el('span', { class: 'work-job-what' }, [
          el('span', { class: 'work-job-title', text: r.title }),
          el('span', { class: 'work-job-why', text: r.words, title: r.words }),
          el('span', { class: 'work-job-why', text: `${r.line}. ${fired}` }),
        ]),
        acts,
        edit,
      ])
    })),
  )
}

function workNode(filters = wk.filters ?? null) {
  wk.filters = filters
  if (wk.node === null) wk.node = el('div', { class: 'work-card' })
  if (!has('work')) pane('work', { title: 'Work', node: wk.node, near: 'work' })
  const fresh = wk.seats === null
  workSeats()
  // A card summoned from the head arrives with no frame behind it; fill the
  // standing seat from the last `now` we already hold rather than waiting for
  // the next beat to say anything at all.
  if (fresh) drawWorkStanding()
  requestAnimationFrame(focusWork)
  return wk.node
}

/**
 * The job block: what Gnomon is doing ON ITS OWN right now, at the top of the
 * Work card — subject, kind, how long, the steps (done · running · next), what
 * waits, and Stop. Drawn from the live `now` and `working` frames; the card is
 * summoned when a job opens and the block leaves when it closes.
 */
let jobSeen = null
function drawJob() {
  const job = present?.working ?? null
  if (job === null) {
    if (wk.seats !== null) {
      // Only the job block. A question waiting for an answer lives in this seat
      // too, and outlives the job that raised it.
      wk.seats.now.body.querySelector(':scope > .job')?.remove()
      wk.seats.now.node.hidden = wk.seats.now.body.childElementCount === 0
    }
    jobSeen = null
    drawWorkStanding()
    return
  }
  if (jobSeen !== job.jobId) {
    jobSeen = job.jobId
    workNode()
  }
  const steps = workingSteps.jobId === job.jobId ? workingSteps.todos : []
  const done = steps.filter((t) => t.status === 'completed').length
  const node = el('section', { class: 'job', 'aria-live': 'polite' }, [
    el('div', { class: 'job-head' }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'job-title', text: job.subject }),
      el('span', { class: 'job-meta', text: `${job.kind} · ${dur(job.min ?? 0)}${steps.length ? ` · ${done}/${steps.length}` : ''}${present.queued > 0 ? ` · ${present.queued} waiting` : ''}` }),
      el('button', {
        type: 'button',
        class: 'act act-small job-stop',
        text: 'Stop',
        title: 'Stop this job. The slot frees; nothing is shelved.',
        onclick: async (event) => {
          event.currentTarget.disabled = true
          await fetch('/gnomon/api/work/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: job.jobId }) }).catch(() => {})
        },
      }),
    ]),
    steps.length
      ? el('ol', { class: 'plan job-steps', 'aria-label': 'Steps' }, steps.map((t) => el('li', { class: 'plan-step', 'data-status': t.status, text: t.content })))
      : el('p', { class: 'job-none', text: 'Reading the record, no plan written yet.' }),
  ])
  const seats = workSeats()
  const was = seats.now.body.querySelector(':scope > .job')
  if (was) was.replaceWith(node)
  else seats.now.body.prepend(node)
  seats.now.node.hidden = false
  drawWorkStanding()
}

/**
 * Where the work stands, and every job that is not the open one.
 *
 * Four readings over the workbench's own counters, then one list holding the
 * queue (what it will pick up, and why) above what it has closed (with the
 * outcome, which is the only part that says whether the job was worth doing).
 * Nothing here is derived: these are the records the kernel already keeps, and
 * the tool counts are this session's own rows.
 */
function drawWorkStanding() {
  if (wk.node === null) return
  const seats = workSeats()
  const bench = present?.workbench ?? { queue: [], recent: [], today: 0 }
  const calls = wk.node.querySelectorAll('.work-row').length
  const failed = wk.node.querySelectorAll('.work-row[data-failed]').length
  // The em dash rule: a count that was never taken is not a zero. Tool calls
  // are only counted from the moment this card opened, so they read as blank
  // until one is made rather than claiming the session ran none.
  const stat = (n, label) => el('div', { class: 'work-stat' }, [el('span', { class: 'work-stat-n', text: n === null ? '—' : String(n) }), el('span', { class: 'eyebrow', text: label })])
  seats.info.body.replaceChildren(
    el('div', { class: 'work-stats' }, [
      stat(bench.today ?? 0, 'jobs today'),
      stat(bench.queue?.length ?? 0, 'waiting'),
      stat(calls === 0 ? null : calls, 'tool calls'),
      stat(calls === 0 ? null : failed, 'failed'),
    ]),
    present?.working ? el('p', { class: 'work-standing-line', text: `On ${present.working.subject} for ${dur(present.working.min ?? 0)}${present.working.reason ? ` — ${present.working.reason}` : ''}` }) : el('p', { class: 'work-standing-line', text: 'No job open. Gnomon picks one when the record gives it a reason.' }),
  )

  const jobRow = (job, mark, right) =>
    el('div', { class: 'work-job', 'data-mark': mark, 'data-job': job.id, 'data-focused': wk.filters?.job === job.id ? '' : null }, [
      el('span', { class: 'work-job-mark' }),
      el('span', { class: 'work-job-what' }, [el('span', { class: 'work-job-title', text: job.title || job.subject }), job.reason ? el('span', { class: 'work-job-why', text: job.reason }) : null]),
      el('span', { class: 'work-job-meta', text: right }),
    ])
  const waiting = (bench.queue ?? []).map((job) => jobRow(job, 'waiting', `${job.kind} · waiting`))
  // The owner's words, not the record's. "shelved" reads as abandoned and means
  // the opposite: the result is on the shelf, waiting for them. A state that
  // owes a reason and has none says so rather than standing there as one word.
  const closed = (bench.recent ?? []).map((job) => {
    const said = status(job.outcome)
    const why = job.reason ? ` · ${job.reason}` : said.needsReason ? ' · no reason given' : ''
    return jobRow(job, job.outcome, `${said.word}${why} · ${dur(job.min ?? 0)} · ${job.closedAt ? new Date(job.closedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}`)
  })
  const jobs = seats.past.body.querySelector(':scope > .work-jobs') ?? el('div', { class: 'work-jobs' })
  jobs.replaceChildren(...waiting, ...closed)
  if (!jobs.isConnected) seats.past.body.prepend(jobs)
  seats.past.node.hidden = waiting.length === 0 && closed.length === 0 && seats.past.body.querySelector('.work-turn') === null
  focusWork()
}

/**
 * The Work card set to a view or a job (its filters): that seat, or that job's
 * row, is marked and scrolled to. The card stays whole — it is live, and a
 * filter that hid the running job would hide the one thing that moves.
 */
const WORK_SEAT = { now: 'now', history: 'past', wakeups: 'soon', rules: 'rules', can: 'can' }
let workAimed = ''
function focusWork() {
  if (wk.seats === null) return
  const seat = WORK_SEAT[wk.filters?.view] ?? null
  for (const [name, s] of Object.entries(wk.seats)) s.node.toggleAttribute('data-focused', name === seat)
  const target = wk.filters?.job ? wk.node.querySelector(`[data-job="${CSS.escape(wk.filters.job)}"]`) : seat ? wk.seats[seat].node : null
  const aim = JSON.stringify(wk.filters ?? null)
  if (target === null || target.hidden || aim === workAimed) return
  workAimed = aim
  const body = wk.node.closest('.pane-body')
  if (body) body.scrollTop += target.getBoundingClientRect().top - body.getBoundingClientRect().top - 12
}

/**
 * A new turn opens a new block; the previous one folds.
 *
 * The title is the owner's own words when they asked for this, and the job's
 * subject when Gnomon started it on its own — without that fallback every
 * autonomous turn folded under the same three words and the card read as a
 * column of identical rows.
 */
function workBlock() {
  if (wk.block !== null && wk.block._turn === state.turn) return wk.block
  const said = turn().querySelector(':scope > .said')?.textContent?.trim()
  const block = el('details', { class: 'work-turn', open: true }, [
    el('summary', { class: 'work-summary' }, [
      el('span', { class: 'work-when', text: state.replaying ? 'earlier' : new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
      el('span', { class: 'work-title', text: said?.slice(0, 80) || present?.working?.subject || 'Gnomon working' }),
    ]),
  ])
  block._turn = state.turn
  const seats = workNode() && workSeats()
  for (const old of wk.node.querySelectorAll('details')) old.open = false
  // Newest first, like every other list of what happened: a replay appends in
  // clock order, which put the oldest turn at the top and the one just
  // finished at the bottom of a long fold.
  const first = seats.past.body.querySelector(':scope > .work-turn')
  if (first !== null) first.before(block)
  else seats.past.body.append(block)
  seats.past.node.hidden = false
  wk.block = block
  return block
}

const gist = (value, max) => {
  const text = typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  const line = text.split('\n')[0].trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function workRow(frame) {
  const args = frame.args ?? {}
  const first = Object.values(args).find((v) => typeof v === 'string') ?? (Object.keys(args).length ? args : '')
  const row = el('div', { class: 'work-row' }, [
    el('span', { class: 'dot' }),
    el('span', { class: 'work-name', text: frame.name.replace(/^gnomon_/, '') }),
    el('span', { class: 'work-arg', text: gist(first, 60) }),
    el('span', { class: 'work-out' }),
    el('span', { class: 'work-ms' }),
  ])
  row._t0 = state.replaying ? null : performance.now()
  workBlock().append(row)
  wk.rows.set(frame.callId, row)
  // No pan: the owner is reading the conversation, and a camera that jumps to
  // the Work card on every step breaks exactly that. The card fills in place.
  return row
}

function workDone(frame) {
  const row = wk.rows.get(frame.callId)
  if (row === undefined) return
  wk.rows.delete(frame.callId)
  row.setAttribute('data-done', '')
  if (frame.failed) row.setAttribute('data-failed', '')
  row.querySelector('.work-out').textContent = gist(frame.text ?? '', 80)
  if (row._t0 !== null) row.querySelector('.work-ms').textContent = `${((performance.now() - row._t0) / 1000).toFixed(1)}s`
}

/** The plan, editable: skip, move, add. Every edit is one `board:plan` event. */
function drawWorkPlan(todos) {
  const steps = todos.map((t) => ({ content: t.content, status: t.status }))
  if (wk.plan === null) {
    wk.plan = el('div', { class: 'work-plan' })
    workNode()
    workSeats().plan.body.append(wk.plan)
  }
  workSeats().plan.node.hidden = steps.length === 0
  const postPlan = (next) => fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'plan', steps: next }) }).catch(() => {})
  const render = (list) => {
    const field = el('input', { class: 'work-plan-add', placeholder: 'add a step…', 'aria-label': 'Add a step' })
    field.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || field.value.trim() === '') return
      const next = [...list, { content: field.value.trim(), status: 'pending' }]
      render(next)
      postPlan(next)
    })
    wk.plan.replaceChildren(
      el('div', { class: 'col-head' }, [el('h3', { class: 'col-title', text: 'Plan' }), el('span', { class: 'col-hint', text: `${list.filter((s) => s.status === 'completed').length} / ${list.length}` })]),
      el(
        'ol',
        { class: 'work-steps' },
        list.map((s, i) =>
          el('li', { class: 'work-step', 'data-status': s.status }, [
            el('span', { class: 'work-step-text', text: s.content }),
            el('span', { class: 'work-step-acts' }, [
              el('button', { type: 'button', class: 'pane-act work-step-up', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; render(n); postPlan(n) } }),
              el('button', { type: 'button', class: 'pane-act work-step-skip', title: s.status === 'skipped' ? 'Unskip' : 'Skip this step', 'aria-label': 'Skip', onclick: () => { const n = list.map((x, k) => (k === i ? { ...x, status: x.status === 'skipped' ? 'pending' : 'skipped' } : x)); render(n); postPlan(n) } }),
            ]),
          ]),
        ),
      ),
      field,
    )
  }
  render(steps)
}

/** A waiting question, on the board too: answer here or in the seat. */
function drawWorkAsk(open) {
  wk.node?.querySelector('.work-ask')?.remove()
  if (!open || !open.waiting || !state.running) return
  const card = el('div', { class: 'work-ask' }, [
    el('span', { class: 'eyebrow', text: 'Gnomon asks, and waits' }),
    el('p', { class: 'work-ask-q', text: open.question }),
    el('div', { class: 'ask-choices' }, [
      ...(open.choices ?? []).map((choice) => el('button', { type: 'button', class: 'choice', text: choice, onclick: () => (tellsMore(choice) ? (showConversation(), answerInComposer()) : answerOpenAsk(choice)) })),
      el('button', { type: 'button', class: 'choice-own', text: 'Answer in the chat', onclick: () => { showConversation(); answerInComposer() } }),
    ]),
  ])
  // With the running job, not folded into the turn that raised it: a question
  // that stops the work belongs where the owner looks for the work.
  workNode()
  const seats = workSeats()
  seats.now.body.append(card)
  seats.now.node.hidden = false
  focusPane('work', { ifHidden: true })
}

/**
 * Draw a `gnomon_compose_figure` result into the turn that asked for it.
 *
 * Counted by `updateLens` like any surface, because to the owner it IS one: the
 * lens is "show me only the things Gnomon drew", and a figure is one of them.
 */
function drawFigure(text, callId) {
  let figure = null
  try {
    figure = JSON.parse(text ?? '')
  } catch {
    return
  }
  const node = renderFigure(figure)
  if (node === null) return
  dropLiveLine()
  turn().append(node)
  // Named by the call, so the same figure has the same card when the thread is replayed.
  figureSeat.add(node, `figure:${callId}`, { live: !state.replaying })
  state.prose = null
  updateLens()
  follow()
}

function liveLine(text) {
  let node = turn().querySelector(':scope > .live')
  if (node === null) {
    node = el('div', { class: 'live' }, [el('span', { class: 'dot' }), el('span', {})])
    turn().append(node)
  }
  node.lastChild.textContent = text
  return node
}

function dropLiveLine() {
  turn().querySelector(':scope > .live')?.remove()
}

// ── Approvals ─────────────────────────────────────────────────────────────
// Drawn in the canvas, inside the turn that raised them, rather than as a
// modal. The decision is about something the assistant is doing right there,
// and taking over the screen to ask would cut the question off from its reason.

function drawApproval(frame) {
  const acts = el('div', { class: 'approval-acts' })
  const card = el('div', { class: 'approval' }, [
    el('div', { class: 'approval-head', text: 'Gnomon wants to' }),
    el('p', { class: 'approval-tool', text: frame.toolName }),
    // The thing being approved, not only the tool's name. The call was drawn
    // before the question was asked, so its arguments are already here.
    // A non-shell call shows its arguments too: an approval you cannot read is
    // not an approval (a vault delete names its file only here).
    commandOf(frame.callId) !== null
      ? el('pre', { class: 'approval-cmd', text: `$ ${commandOf(frame.callId)}` })
      : argsOf(frame.callId) !== null
        ? el('pre', { class: 'approval-cmd', text: argsOf(frame.callId) })
        : null,
    frame.reason ? el('p', { class: 'approval-why', text: frame.reason }) : null,
    acts,
  ])

  const answer = async (outcome) => {
    for (const button of acts.querySelectorAll('button')) button.disabled = true
    try {
      await fetch('/gnomon/api/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: frame.id, outcome }),
      })
    } catch {
      // The server will time the question out on its own. Re-enabling here
      // would invite a second answer to a question that may already be settled.
    }
  }

  acts.append(
    el('button', { type: 'button', class: 'act', text: 'Allow once', onclick: () => answer('allowed-once') }),
    el('button', { type: 'button', class: 'act', text: 'No', onclick: () => answer('rejected') }),
  )
  state.approvals.set(frame.id, card)
  turn().append(card)
  follow(true)
}

// ── Deliverables ──────────────────────────────────────────────────────────
// A file Gnomon is handing over, drawn where it was handed over. This is the
// whole point of the `present` tool: a path in a sentence is not a delivery —
// the owner has to read it, remember it, and go somewhere else to open it.
//
// dsh copies nothing, so this card is a POINTER, not an attachment. The label
// says so, because "download" would promise a snapshot that does not exist:
// clicking tomorrow gives tomorrow's contents, and a file since deleted gives
// an honest 404 from the route rather than a stale copy.
function drawDeliverable(frame) {
  if (frame.files.length === 0) return
  const card = el('div', { class: 'deliverable' }, [
    el('div', { class: 'deliverable-head', text: frame.files.length === 1 ? 'Gnomon made you a file' : `Gnomon made you ${frame.files.length} files` }),
    ...frame.files.map((file) =>
      el('div', { class: 'deliverable-file' }, [
        el('a', {
          class: 'deliverable-name',
          // The session is part of the request because the session log IS the
          // server's allowlist — the route will not serve a path this session
          // never presented.
          href: `/gnomon/api/deliverable?session=${encodeURIComponent(state.sessionId ?? '')}&path=${encodeURIComponent(file.path)}`,
          download: file.name,
          // The full path, because on this machine that is how the owner finds
          // it in a terminal or a Finder window.
          title: file.path,
          text: file.name,
        }),
        file.description ? el('p', { class: 'deliverable-why', text: file.description }) : null,
      ]),
    ),
  ])
  turn().append(card)
  follow(true)
}

const OUTCOME_WORDS = {
  'allowed-once': 'Allowed, once.',
  rejected: 'Refused.',
  cancelled: 'Withdrawn — the turn ended first.',
  unavailable: 'Nobody could answer, so it was refused.',
}

function settleApproval(frame) {
  const card = state.approvals.get(frame.id)
  if (card === undefined) return
  state.approvals.delete(frame.id)
  card.setAttribute('data-settled', '')
  card.append(el('div', { class: 'approval-outcome', text: OUTCOME_WORDS[frame.outcome] ?? String(frame.outcome) }))
}

/** The shell command a call id carries, if the call was a shell command. */
function commandOf(callId) {
  const args = state.tools.get(callId ?? '')?._args
  return typeof args?.command === 'string' && args.command !== '' ? args.command : null
}

/** A call's arguments as readable JSON, bounded, or null when it has none. */
function argsOf(callId) {
  const args = state.tools.get(callId ?? '')?._args
  if (args === undefined || args === null || (typeof args === 'object' && Object.keys(args).length === 0)) return null
  const text = JSON.stringify(args, null, 2)
  return text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text
}

/** The tool that runs a command. Its call draws as a block, not a chip: the command IS the content. */
const SHELL_TOOL = 'gnomon_run_shell'

/**
 * The tool whose RESULT is a drawing.
 *
 * Unlike `show_surface`, whose call carries the whole payload, this one is a
 * request: the numbers are computed on the host and come back in the result, so
 * the figure can only be drawn once the call closes. That asymmetry is why it
 * is handled in `tool-done` and not beside the surface frame.
 */
const FIGURE_TOOL = 'gnomon_compose_figure'

/** Every other tool: a chip that opens to show what was asked and what came back. */
// ── Gnomon pointing, in its own voice ─────────────────────────────────────
// A walk step, a focus with words, a notice: the board used to draw these as
// a walk box, a caption and a banner — three voices besides the chat. They are
// the chat's now. The call is already in the session log, so a walk streams
// into the conversation live and is still there when you scroll back; the
// board only frames the card and edges it (stage.js pointAt).
const POINTING = new Set(['step', 'walk', 'notice'])
const isPointing = (frame) => frame.name === 'gnomon_board' && (POINTING.has(frame.args?.action) || (frame.args?.action === 'focus' && typeof frame.args?.text === 'string' && frame.args.text.trim() !== ''))
const idsOf = (value) => {
  const list = typeof value === 'string' ? parseResult(value).value : value
  return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id !== '') : []
}
/** The cards a line points at, each a door that brings it back into view. */
function cardLinks(ids) {
  if (ids.length === 0) return null
  return el('span', { class: 'point-cards' }, ids.map((id) => el('button', { type: 'button', class: 'point-card', 'data-id': id, text: cardName(id), onclick: (event) => (event.stopPropagation(), pointAt([id])) })))
}
function pointLine({ kind, label = null, text, ids }) {
  const node = el('div', { class: 'point', 'data-kind': kind, tabindex: ids.length ? '0' : null }, [
    label ? el('span', { class: 'point-n', text: label }) : null,
    el('div', { class: 'point-text' }, [renderMarkdown(text ?? '')]),
    cardLinks(ids),
  ])
  // stopPropagation: the line sits inside the chat card, and a click that
  // reached the card would focus the chat straight back.
  if (ids.length) node.addEventListener('click', (event) => (event.stopPropagation(), pointAt(ids)))
  return node
}
/** A card's name for a link. A card that has not drawn yet has only its id, so the links are renamed once it has. */
const cardName = (id) => {
  const title = titleOf(id)
  return title !== id ? title : CARD_NAME.get(id) ?? (id.startsWith('lens:') ? 'the lens' : id.replace(/^[a-z]+:/, ''))
}
onChange(() => {
  for (const link of document.querySelectorAll('.point-card[data-id]')) link.textContent = cardName(link.dataset.id)
})
function pointNode(frame) {
  const a = frame.args ?? {}
  if (a.action === 'walk') return walkSay(frame)
  const ids = idsOf(a.ids)
  const steps = [...turn().querySelectorAll(':scope > .point[data-kind="step"]')]
  const node = pointLine({ kind: a.action, label: a.action === 'step' ? `Step ${steps.length + 1}` : null, text: a.text, ids })
  const acts = el('div', { class: 'point-acts' })
  if (a.action === 'step' && !state.replaying) {
    const prev = steps.at(-1)
    const next = el('button', {
      type: 'button',
      class: 'act point-next',
      text: 'Next',
      onclick: (event) => {
        event.stopPropagation()
        next.disabled = true
        next.textContent = 'Gnomon continues…'
        walkContinue()
      },
    })
    if (prev) acts.append(el('button', { type: 'button', class: 'act', text: 'Back', onclick: (event) => (event.stopPropagation(), prev.click()) }))
    acts.append(next)
    // Every step waits for Next: the owner reads at their own pace. Only their
    // own setting (Settings → auto-advance) moves a walk on by itself.
    const dwell = SETTINGS.autoAdvanceMs ?? 0
    if (dwell) {
      const shownAt = performance.now()
      setTimeout(() => next.isConnected && !next.disabled && !touchedSince(shownAt) && next.click(), dwell)
    }
  }
  if (a.action === 'notice' && !state.replaying) {
    const replies = typeof a.actions === 'string' ? parseResult(a.actions).value : a.actions
    for (const reply of (Array.isArray(replies) ? replies : []).slice(0, 3)) {
      if (typeof reply?.label !== 'string' || typeof reply?.say !== 'string') continue
      acts.append(el('button', { type: 'button', class: 'act', text: reply.label, onclick: (event) => (event.stopPropagation(), acts.remove(), say(reply.say)) }))
    }
  }
  if (acts.childElementCount) node.append(acts)
  turn().append(node)
  state.prose = null
  return node
}
/** A whole walk laid down at once: its steps arrive one Next at a time, and all stay to scroll back to. */
function walkSay(frame) {
  const raw = frame.args?.steps
  const steps = typeof raw === 'string' ? parseResult(raw).value : raw
  if (!Array.isArray(steps) || steps.length === 0) return toolChip(frame)
  let i = 0
  let reached = state.replaying ? steps.length - 1 : 0
  const items = steps.map((step, k) => {
    const item = pointLine({ kind: 'step', label: `${k + 1} of ${steps.length}`, text: step?.text, ids: idsOf(step?.ids) })
    item.addEventListener('click', (event) => (event.stopPropagation(), (i = k), draw()))
    return item
  })
  const back = el('button', { type: 'button', class: 'act', text: 'Back', onclick: (event) => (event.stopPropagation(), (i = Math.max(0, i - 1)), draw(), pointAt(idsOf(steps[i]?.ids))) })
  const next = el('button', {
    type: 'button',
    class: 'act point-next',
    text: 'Next',
    onclick: (event) => {
      event.stopPropagation()
      if (i < steps.length - 1) {
        i += 1
        reached = Math.max(reached, i)
        draw()
        pointAt(idsOf(steps[i]?.ids))
      } else if (state.running) {
        next.disabled = true
        next.textContent = 'Gnomon continues…'
        walkContinue()
      } else acts.remove()
    },
  })
  const acts = el('div', { class: 'point-acts' }, [back, next])
  const draw = () => {
    items.forEach((item, k) => {
      item.hidden = k > reached
      item.toggleAttribute('data-current', k === i && !state.replaying)
    })
    back.disabled = i === 0
    if (!next.disabled) next.textContent = i === steps.length - 1 ? (state.running ? 'Next' : 'Done') : 'Next'
  }
  const node = el('div', { class: 'walk-say', 'data-kind': 'walk' }, [...items, state.replaying ? null : acts])
  draw()
  turn().append(node)
  state.prose = null
  return node
}
// Anything else the board has to say (a card that cannot open, say) is a line in the conversation too.
document.addEventListener('gnomon:point', (event) => {
  const { text } = event.detail ?? {}
  if (typeof text !== 'string' || text.trim() === '') return
  stack().append(pointLine({ kind: 'aside', text, ids: [] }))
  follow()
})

/**
 * A question Gnomon asked with choices (`ask_user_question`): the options are
 * buttons, and there is always room to say something else. One tap answers a
 * single choice; several choices take a Send. Drawn from the tool call, so a
 * reopened thread shows what was asked and what you picked.
 */
function questionNode(frame) {
  const raw = frame.args?.questions
  const questions = (typeof raw === 'string' ? parseResult(raw).value : raw) ?? []
  if (!Array.isArray(questions) || questions.length === 0) return toolChip(frame)
  const sessionId = state.sessionId
  const picked = new Map(questions.map((q) => [String(q.id), new Set()]))
  const own = new Map()
  const node = el('div', { class: 'question', 'data-kind': 'question' })
  const send = el('button', { type: 'button', class: 'act point-next', text: 'Send', hidden: true })
  const answer = async () => {
    const answers = questions.map((q) => ({ id: String(q.id), selected: [...picked.get(String(q.id))], custom: own.get(String(q.id))?.value ?? '' }))
    lock()
    try {
      const response = await fetch('/gnomon/api/question', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, answers }) })
      if (!response.ok) node.append(el('div', { class: 'fail', text: 'That question is no longer waiting.' }))
    } catch {
      node.append(el('div', { class: 'fail', text: 'The answer could not be sent.' }))
    }
  }
  const lock = () => {
    node.setAttribute('data-answered', '')
    for (const b of node.querySelectorAll('button, input')) b.disabled = true
  }
  const several = questions.length > 1 || questions.some((q) => q.multiSelect)
  for (const q of questions) {
    const id = String(q.id)
    const choices = (Array.isArray(q.options) ? q.options : []).filter((o) => typeof o?.label === 'string')
    const field = el('input', { class: 'question-own', type: 'text', placeholder: choices.length ? 'Or say something else…' : 'Your answer…', 'aria-label': 'Your own answer' })
    own.set(id, field)
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || field.value.trim() === '') return
      event.preventDefault()
      if (!several) picked.get(id).clear()
      if (several) send.hidden = false
      else answer()
    })
    node.append(
      el('div', { class: 'question-item', 'data-id': id }, [
        q.header ? el('span', { class: 'point-n', text: q.header }) : null,
        el('div', { class: 'point-text' }, [renderMarkdown(q.question ?? '')]),
        q.detail ? el('div', { class: 'question-detail' }, [renderMarkdown(q.detail)]) : null,
        choices.length
          ? el('div', { class: 'question-choices' }, choices.map((o) => {
              const suggested = /\(Recommended\)\s*$/.test(o.label)
              return el('button', {
                type: 'button',
                class: 'question-choice',
                'data-label': o.label,
                'data-suggested': suggested || null,
                title: o.description ?? '',
                onclick: (event) => {
                  event.stopPropagation()
                  const set = picked.get(id)
                  if (q.multiSelect) {
                    set.has(o.label) ? set.delete(o.label) : set.add(o.label)
                    event.currentTarget.toggleAttribute('data-chosen', set.has(o.label))
                  } else {
                    set.clear()
                    set.add(o.label)
                    for (const c of event.currentTarget.parentElement.children) c.toggleAttribute('data-chosen', c === event.currentTarget)
                  }
                  if (several) send.hidden = false
                  else answer()
                },
              }, [el('span', { text: o.label.replace(/\s*\(Recommended\)\s*$/, '') }), o.description ? el('span', { class: 'question-choice-sub', text: o.description }) : null])
            }))
          : null,
        field,
      ]),
    )
  }
  send.addEventListener('click', (event) => (event.stopPropagation(), answer()))
  node.append(el('div', { class: 'point-acts' }, [send]))
  // The result says what was picked — live after a tap, and on replay.
  node._onResult = (text) => {
    const got = parseResult(text)
    for (const a of got.ok && Array.isArray(got.value?.answers) ? got.value.answers : []) {
      const item = node.querySelector(`.question-item[data-id="${CSS.escape(String(a.id))}"]`)
      for (const c of item?.querySelectorAll('.question-choice') ?? []) c.toggleAttribute('data-chosen', (a.selected ?? []).includes(c.dataset.label))
      if (a.custom) item?.append(el('p', { class: 'question-said', text: a.custom }))
    }
    lock()
  }
  if (state.replaying) lock()
  // Reopened while the question is still waiting (the server says so): answerable again.
  node._unlock = () => {
    node.removeAttribute('data-answered')
    for (const b of node.querySelectorAll('button, input')) b.disabled = false
  }
  turn().append(node)
  state.prose = null
  return node
}

/**
 * Finished tool lines fold into one — "Looked at 11 things · 1.8s" — once there
 * are three; the running one always shows, and a click opens the rest.
 */
function foldWork(list) {
  const done = [...list.querySelectorAll(':scope > .tool[data-done]')]
  if (done.length < 3) return
  let head = list.querySelector(':scope > .work-fold')
  if (head === null) {
    head = el('button', { type: 'button', class: 'work-fold', 'aria-expanded': 'false', onclick: () => head.setAttribute('aria-expanded', String(list.toggleAttribute('data-open'))) })
    list.prepend(head)
  }
  const ms = done.reduce((total, row) => total + (row._ms ?? 0), 0)
  const failed = done.filter((row) => row.hasAttribute('data-failed')).length
  head.textContent = `Looked at ${done.length} things${failed ? ` · ${failed} failed` : ''}${ms ? ` · ${elapsed(ms)}` : ''}`
}

/**
 * One tool call, as a line the owner can read: what it is doing, on what, how
 * long it has taken, and — once back — what came of it. The raw call and its
 * result are one click away. A call still running after a few seconds offers
 * Stop, which ends THAT call and lets the turn carry on without it.
 */
function toolChip(frame) {
  const { verb, detail: arg } = toolLine(frame.name, frame.args)
  const detail = el('div', { class: 'tool-detail', hidden: true })
  const time = el('span', { class: 'tool-time' })
  const gist = el('span', { class: 'tool-gist' })
  const main = el('button', { type: 'button', class: 'tool-main', 'aria-expanded': 'false', title: frame.name }, [
    el('span', { class: 'dot' }),
    el('span', { class: 'tool-verb', text: verb }),
    arg ? el('span', { class: 'tool-arg', text: arg }) : null,
    gist,
    time,
  ])
  const row = el('div', { class: 'tool' }, [main, stopButton(frame.callId)])
  row._args = frame.args
  row._detail = detail
  row._gist = gist
  row._time = time
  row._t0 = state.replaying ? null : performance.now()
  row._refresh = () => {
    if (!detail.hidden) detail.replaceChildren(...toolDetail(frame, row._result))
  }
  main.addEventListener('click', () => {
    const open = detail.hidden
    // One open at a time: the panel sits under the whole list, so two open at
    // once would be two panels and no way to tell whose is whose.
    for (const other of turn().querySelectorAll(':scope > .tool-detail')) other.hidden = true
    for (const other of turn().querySelectorAll(':scope > .work .tool-main')) other.setAttribute('aria-expanded', 'false')
    detail.hidden = !open
    main.setAttribute('aria-expanded', String(open))
    row._refresh()
  })
  work().append(row)
  work().after(detail)
  return row
}

/**
 * What a call was asked and what it gave back, drawn (json-view.js) rather
 * than dumped. `gnomon_call` shows the arguments of the tool it called. The raw
 * text is one click away for when the drawing hides something.
 */
function toolDetail(frame, result) {
  const inner = frame.name === 'gnomon_call' && frame.args?.args !== undefined ? (typeof frame.args.args === 'string' ? parseResult(frame.args.args).value : frame.args.args) : frame.args
  const asked = inner && typeof inner === 'object' && Object.keys(inner).length > 0 ? jsonNode(jsonShape(inner)) : el('span', { class: 'jv-text jv-quiet', text: 'nothing' })
  const got = result === undefined ? null : parseResult(result)
  const back = got === null ? el('span', { class: 'jv-text jv-quiet', text: 'still running…' }) : got.ok ? jsonNode(jsonShape(got.value)) : el('pre', { class: 'jv-raw', text: got.value || '(nothing)' })
  const raw = el('pre', { class: 'jv-raw', hidden: true, text: `${frame.name}(${JSON.stringify(frame.args ?? {}, null, 1)})\n\n${result ?? '…'}` })
  return [
    el('div', { class: 'jv-sec' }, [el('div', { class: 'jv-head', text: 'Asked' }), asked]),
    el('div', { class: 'jv-sec' }, [el('div', { class: 'jv-head', text: 'Got back' }), back]),
    got?.ok ? el('button', { type: 'button', class: 'link jv-toggle', text: 'Raw', onclick: (e) => { raw.hidden = !raw.hidden; e.currentTarget.textContent = raw.hidden ? 'Raw' : 'Hide raw' } }) : null,
    raw,
  ].filter(Boolean)
}

/** Stop for one call: hidden until the call has run a few seconds (see the tick below). */
function stopButton(callId) {
  return el('button', {
    type: 'button',
    class: 'tool-stop',
    hidden: true,
    text: 'Stop',
    title: 'Stop this step only — the answer goes on without it',
    onclick: async (event) => {
      event.stopPropagation()
      const button = event.currentTarget
      button.disabled = true
      button.textContent = 'Stopping…'
      try {
        const response = await fetch('/gnomon/api/tool/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId }) })
        if (!response.ok) button.hidden = true
      } catch {
        button.disabled = false
        button.textContent = 'Stop'
      }
    },
  })
}

/** The model names a thread in the background; this is when to look again. */
const TITLE_SETTLE_MS = 6000
/** How long a call runs before it offers Stop. */
const STOP_AFTER_MS = 3000
// One clock for every running call: the time on each line, and Stop once it is slow.
setInterval(() => {
  const now = performance.now()
  for (const row of state.tools.values()) {
    if (row._t0 == null) continue
    const ms = now - row._t0
    if (row._time) row._time.textContent = elapsed(ms)
    const stop = row.querySelector(':scope > .tool-stop, :scope > .cmd-head > .tool-stop')
    if (stop && ms >= STOP_AFTER_MS && stop.hidden && !stop.disabled) stop.hidden = false
  }
}, 250)

function shellBlock(frame) {
  const command = typeof frame.args?.command === 'string' ? frame.args.command : ''
  const label = el('span', { text: 'shell' })
  // The head is the handle: a long answer folds away behind it, so a page of
  // output does not bury the sentence the shell was run for.
  const time = el('span', { class: 'tool-time' })
  const head = el('div', { class: 'cmd-head', role: 'button', tabindex: '0', 'aria-expanded': 'true' }, [el('span', { class: 'dot' }), label, time, stopButton(frame.callId)])
  const out = el('pre', { class: 'cmd-out', hidden: true })
  const block = el('div', { class: 'cmd' }, [head, el('pre', { class: 'cmd-line', text: `$ ${command}` }), out])
  head.addEventListener('click', () => {
    // Before the answer arrives there is nothing to fold.
    if (out.textContent === '') return
    out.hidden = !out.hidden
    head.setAttribute('aria-expanded', String(!out.hidden))
  })
  block._args = frame.args
  block._label = label
  block._time = time
  block._t0 = state.replaying ? null : performance.now()
  turn().append(block)
  return block
}

/** How many lines of output stay in view without asking. */
const SHELL_OUT_PEEK = 8

// ── The fold ──────────────────────────────────────────────────────────────

/**
 * One frame into the canvas.
 *
 * The same function runs for a replayed transcript and for a live stream, which
 * is the reason re-opening a session looks exactly like having watched it. The
 * only difference between the two is which text frame arrives: `say` carries an
 * assembled paragraph, `text` carries one delta.
 */
function apply(frame) {
  switch (frame.type) {
    case 'turn':
      openTurn()
      break

    case 'user':
      openTurn().append(el('p', { class: 'said', text: frame.text }))
      break

    case 'brought':
      // Into the block the watch just opened for this turn, not a second one after it.
      ;(state.turn !== null && state.turn.childElementCount === 0 ? state.turn : openTurn()).append(el('div', { class: 'brought' }, [el('span', { class: 'brought-label', text: 'Brought in' }), el('span', { text: frame.title })]))
      break

    case 'say': {
      // Replay: the whole block at once. A follow-up is a later line of Gnomon's, labelled with when.
      const block = prose()
      block._md = frame.text
      block.replaceChildren(renderMarkdown(frame.text))
      if (frame.followup !== undefined) block.before(el('span', { class: 'followup-label', text: frame.followup ? `Follow-up · ${hhmm(frame.followup)}` : 'Follow-up' }))
      state.prose = null
      break
    }

    case 'text': {
      dropLiveLine()
      const block = prose()
      // Leading whitespace before the first real character is the blank line a
      // model leaves between its reasoning and its answer. Inside the answer it
      // is the answer's own.
      block._md += block._md === '' ? frame.delta.replace(/^\s+/, '') : frame.delta
      drawProse(block)
      if (!state.speaking) {
        state.speaking = true
        updateMood()
      }
      break
    }

    case 'thinking':
      if (prose()._md === '') liveLine('thinking…')
      break

    case 'tool': {
      dropLiveLine()
      const row = frame.name === SHELL_TOOL ? shellBlock(frame) : frame.name === 'ask_user_question' ? questionNode(frame) : isPointing(frame) ? pointNode(frame) : toolChip(frame)
      // Remembered on the row rather than in a second map: the row is already
      // the thing keyed by call id, and a parallel map is one more thing that
      // can disagree with it.
      if (frame.name === FIGURE_TOOL) row._figure = true
      state.tools.set(frame.callId, row)
      workRow(frame)
      state.speaking = false
      updateMood()
      // A tool call ends the current paragraph: what comes after it is a new
      // thought, informed by what came back.
      state.prose = null
      break
    }

    case 'todo':
      drawPlan(frame.todos)
      // The plan is a new thought, like a tool call: prose after it starts fresh.
      state.prose = null
      break

    case 'deliverable':
      drawDeliverable(frame)
      // A handover closes the paragraph that led to it, the way a tool call does.
      state.prose = null
      break

    case 'tool-done': {
      // A surface is drawn from its CALL, before the tool has said whether it
      // accepted the payload. When it did not — a grid with no columns, a chart
      // with no marks — the frame that is already on screen says "No renderer
      // for grid yet", which blames the client for the model's malformed
      // payload and leaves a broken drawing in the transcript. Seen live: the
      // model sent positional rows, was correctly refused, re-sent them shaped
      // right, and the owner was left looking at both.
      const surface = state.surfaces.get(frame.callId)
      if (surface !== undefined) {
        state.surfaces.delete(frame.callId)
        if (frame.failed || /^Not drawn:/.test(frame.text ?? '')) {
          // A refusal is not a figure: whatever took the stage comes back down.
          if (!state.replaying) dismissPane(`surface:${frame.callId}`)
          surface.setAttribute('data-refused', '')
          surface
            .querySelector('.surface-body')
            .replaceChildren(el('div', { class: 'surface-fail', text: (frame.text ?? '').replace(/^Not drawn:\s*/, '') || 'This surface was refused.' }))
          updateLens()
        }
        break
      }

      workDone(frame)
      const row = state.tools.get(frame.callId)
      if (row === undefined) break
      state.tools.delete(frame.callId)
      row.setAttribute('data-done', '')
      if (frame.failed) row.setAttribute('data-failed', '')
      row._result = frame.text ?? ''
      row._onResult?.(row._result, frame.failed)
      for (const stop of row.querySelectorAll('.tool-stop')) stop.remove()
      // A live step's Next has done its work once the step call returns.
      if (row.dataset.kind === 'step') row.querySelector(':scope > .point-acts')?.remove()
      if (row._t0 != null) row._ms = performance.now() - row._t0
      if (row._ms != null && row._time) row._time.textContent = elapsed(row._ms)
      if (row._gist) row._gist.textContent = resultGist(row._result, frame.failed) ?? ''
      const out = row.querySelector(':scope > .cmd-out')
      if (out !== null) {
        // The shell's answer, under its command. An empty result still shows,
        // because "it ran and said nothing" is different from "still running".
        out.textContent = row._result === '' ? '(no output)' : row._result
        const lines = out.textContent.split('\n').length
        // A short answer reads in place. A long one folds, and says how long it
        // is, so the fold is an offer rather than a loss.
        out.hidden = lines > SHELL_OUT_PEEK
        row.querySelector(':scope > .cmd-head')?.setAttribute('aria-expanded', String(!out.hidden))
        if (row._label !== undefined && out.hidden) row._label.textContent = `shell — ${lines} lines`
      } else row._refresh?.()
      const list = row.closest('.work')
      if (list) foldWork(list)
      // The composed figure, drawn from the result the call came back with. A
      // result that will not parse leaves the chip and its JSON exactly as they
      // were — a figure that cannot be read is not a figure to draw wrong.
      if (row._figure === true) drawFigure(row._result, frame.callId)
      break
    }

    case 'surface': {
      dropLiveLine()
      const drawn = renderSurface(frame)
      state.surfaces.set(frame.callId, drawn)
      turn().append(drawn)
      state.prose = null
      updateLens()
      figureSeat.add(drawn, `surface:${frame.callId}`, { live: !state.replaying })
      break
    }

    case 'approval':
      drawApproval(frame)
      break

    case 'question-open':
      ;[...canvas.querySelectorAll('.question[data-answered]')].filter((q) => q.querySelector('[data-chosen], .question-said') === null).pop()?._unlock?.()
      break

    case 'approval-closed':
      settleApproval(frame)
      break

    case 'error':
      dropLiveLine()
      turn().append(el('div', { class: 'fail', text: frame.message }))
      break

    case 'done':
      dropLiveLine()
      state.speaking = false
      if (wk.block) wk.block.open = false
      wk.node?.querySelector('.work-ask')?.remove()
      // A turn that ended for any reason other than finishing says so. Before
      // this, a model that failed at the provider produced an empty turn that
      // looked exactly like Gnomon choosing to say nothing.
      // The owner's own Stop already drew its line, and `stopped` is not a
      // failure — saying "ended without an answer" over it would scold them for
      // using a button. Every other ending still says what happened.
      if (frame.reason === 'aborted' && frame.by === 'user') break
      // An answer is a line Gnomon produced, so it takes the three taps (J0.8).
      // The id is the session and the turn's place in it — the same under
      // replay as live, so a rated answer can be found again. `wrong` on an
      // unkept answer is recorded and stops there (`feedbackTrack`).
      if ((frame.reason ?? 'complete') === 'complete' && state.turn?.querySelector(':scope > .prose') && state.turn.querySelector(':scope > .verdicts') === null) {
        const turns = [...stack().querySelectorAll(':scope > .turn')]
        state.turn.append(verdictActs('ask_thread', `${state.sessionId ?? 'session'}#${turns.indexOf(state.turn) + 1}`))
      }
      if (frame.reason && frame.reason !== 'complete') {
        const why =
          frame.reason === 'aborted'
            ? 'Something stopped the turn.'
            : frame.reason === 'error'
              ? `The turn failed${frame.message ? `: ${frame.message}` : '.'}`
              : `The turn ended without an answer (${frame.reason}).`
        turn().append(el('div', { class: 'fail', text: `${why} Check the model in the rail's foot, or the Ledger for the provider's reply.` }))
      }
      break

    default:
      break
  }
  follow()
}

// ── The rail ──────────────────────────────────────────────────────────────

/** The owner's threads: minted `session-…` by this shell, plus the conversation. */
const ownThread = (r) => r.id.startsWith('session-') || r.id === COMPANION_SESSION_ID

/** Gnomon's own sessions. Archivable, never deletable while it is using them. */
const PROTECTED = new Set([COMPANION_SESSION_ID])

async function loadSessions() {
  let body = null
  try {
    body = await (await fetch('/gnomon/api/sessions', { headers: { accept: 'application/json' } })).json()
  } catch {
    rail.replaceChildren(el('div', { class: 'session-none', text: 'Sessions could not be read.' }))
    return
  }
  state.rows = body.sessions ?? []
  drawRail()
}

/**
 * The rail, from the last listing.
 *
 * Two modes, one list: rows are buttons that open, or labels around a checkbox
 * that pick. Archived rows are hidden unless the owner asks for them, and the
 * toggle that asks says how many are hiding — a rail that silently drops
 * sessions is a rail the owner stops trusting.
 */
/**
 * How heavy the conversation is, against the point dsh compacts it.
 *
 * Read after a turn rather than polled: the number only changes when a call is
 * made, and the ledger is the thing that knows. A conversation that has never
 * been spoken in has nothing to show, so the gauge stays hidden rather than
 * drawing a zero.
 */
async function drawContextMeter() {
  let body = null
  try {
    body = await (await fetch('/gnomon/context', { headers: { accept: 'application/json' } })).json()
  } catch {
    body = null
  }
  const tokens = body?.promptTokens ?? null
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) {
    companionMeter.hidden = true
    return
  }
  const window = body.contextWindow ?? 64000
  const compactAt = body.compactAt ?? Math.floor(window * 0.8)
  companionMeter.hidden = false
  companionFill.style.width = `${Math.min(100, Math.round((100 * tokens) / window))}%`
  companionFill.dataset.over = String(tokens >= compactAt)
  const k = (n) => `${Math.round(n / 1000)}k`
  companionTokens.textContent = `${k(tokens)}/${k(window)}`
  companionMeter.title = tokens >= compactAt
    ? `${tokens.toLocaleString()} tokens — past the ${compactAt.toLocaleString()} mark, so the next turn carries a compacted summary of the earlier exchange.`
    : `${tokens.toLocaleString()} tokens of a ${window.toLocaleString()} window. Compacts at ${compactAt.toLocaleString()}.`
}

/**
 * The pinned conversation.
 *
 * Its liveness and its last words come from what the page already tracks — the
 * sessions listing and the `said`/`noticed` frames the presence strip reads —
 * so the seat cannot disagree with the strip about whether Gnomon is talking.
 */
function drawCompanion() {
  const row = state.rows.find((r) => r.id === COMPANION_SESSION_ID)
  companionDot.dataset.live = String(Boolean(row?.live))
  companionSeat.setAttribute('aria-current', String(state.sessionId === COMPANION_SESSION_ID))
  // The last thing it SAID, not the session title: a title is derived from the
  // first message and stops being true on the second. Falls back to the title,
  // then to a plain description of what the seat is.
  const said = lastSaid?.text?.replace(/\s+/g, ' ').trim()
  // Never show the owner something the record deliberately made unreadable.
  // `ownerAsk.unanswerable` refuses to ASK a question quoting a `person-<hash>`
  // or a `[private]`/`[hidden]` placeholder; the same text must not arrive here
  // through the back door either, and the strip was showing exactly that — an
  // "Who is person-f1f2f3f4f5?" from before that guard existed. A stale value
  // the seat cannot honestly render falls back to what the seat IS.
  const readable = said && !/\bperson-[0-9a-f]{6,}\b|\[(private|hidden)\]/i.test(said) ? said : null
  companionSaid.textContent = readable || row?.title || 'the ongoing conversation'
  void drawContextMeter()
}

function drawRail() {
  const archivedCount = state.rows.filter((r) => r.archived && r.id !== COMPANION_SESSION_ID).length
  // The conversation has its own seat above, so it is never also a row here —
  // including after the owner unarchives it.
  // Gnomon's own work sessions ("Gnomon opened a job for itself…") and blank
  // ones are machine noise in a list meant for the owner's threads. They stay
  // reachable (a job's result is on the shelf; the current one always shows).
  // A helper's or a job's own session (anything not minted as `session-…` here)
  // is Gnomon's working paper, not a thread of the owner's.
  const noise = (r) => r.id !== state.sessionId && (!ownThread(r) || /^Gnomon opened a job/i.test(r.title ?? '') || r.blank === true)
  // Live on top, then last touched. The route answers in creation order, which
  // put the session the owner was speaking in FOURTH during the audit — a
  // thread you are in the middle of is not merely the newest thing, it is the
  // only one you can act on. `lastPromptAt` is a cache hint and is null for a
  // session the list could not read, so creation time is the fallback.
  const rows = liveFirst(
    state.rows.filter((r) => r.id !== COMPANION_SESSION_ID && Boolean(r.archived) === state.showArchived && !noise(r)),
    (r) => r.lastPromptAt ?? r.createdAt,
    (r) => r.id === state.sessionId || r.live === true,
  )
  threadsLabel.textContent = state.showArchived ? 'Archived' : 'Threads'
  drawCompanion()
  drawThreadBar()

  const toggle = $('archived-toggle')
  toggle.hidden = archivedCount === 0 && !state.showArchived
  toggle.setAttribute('aria-pressed', String(state.showArchived))
  toggle.textContent = state.showArchived ? '← Back to sessions' : `${archivedCount} archived`

  if (rows.length === 0) {
    rail.replaceChildren(el('div', { class: 'session-none', text: state.showArchived ? 'Nothing archived.' : 'No sessions yet.' }))
    drawActions()
    return
  }

  rail.replaceChildren(
    ...rows.map((row) => {
      // `blank` comes from dsh's `sessionListMetadata` projection and means
      // the log contains no turn at all — a session opened and never spoken
      // in. "Empty session" is the true thing to call it; "Untitled" implies
      // there are words in there that nobody named. The flag is a cached hint
      // and is null for a session whose checkpoint the list could not read, so
      // only an explicit `true` changes the wording.
      const title = row.title || (row.blank === true ? 'Empty session' : 'Untitled session')
      if (!state.selecting) {
        return el('button', {
          type: 'button',
          class: 'session',
          role: 'listitem',
          'aria-current': String(row.id === state.sessionId),
          // The id is a poor name and the whole reason the server derives one,
          // but it is still the honest fallback when a session has no words yet.
          text: title,
          title: row.id,
          onclick: () => openSession(row.id),
        })
      }
      const picked = state.picked.has(row.id)
      return el(
        'label',
        {
          class: 'session-pick',
          role: 'listitem',
          'data-picked': picked || null,
          'data-archived': row.archived || null,
          'data-protected': PROTECTED.has(row.id) || null,
          title: row.id,
        },
        [
          el('input', {
            type: 'checkbox',
            checked: picked,
            onchange: (event) => {
              if (event.target.checked) state.picked.add(row.id)
              else state.picked.delete(row.id)
              drawRail()
            },
          }),
          el('span', { text: title }),
        ],
      )
    }),
  )
  drawActions()
}

/** The action bar: count, archive or restore, and a delete that asks twice. */
function drawActions() {
  const bar = $('rail-actions')
  bar.hidden = !state.selecting
  if (!state.selecting) return
  const n = state.picked.size
  $('rail-count').textContent = n === 0 ? 'Pick sessions' : `${n} selected`
  const archive = $('act-archive')
  const del = $('act-delete')
  archive.textContent = state.showArchived ? 'Restore' : 'Archive'
  archive.disabled = n === 0
  const deletable = [...state.picked].filter((id) => !PROTECTED.has(id)).length
  del.disabled = deletable === 0
  if (!del.hasAttribute('data-arm')) del.textContent = 'Delete'
}

function setSelecting(on) {
  state.selecting = on
  if (!on) state.picked.clear()
  $('select-toggle').setAttribute('aria-pressed', String(on))
  $('select-toggle').textContent = on ? 'Done' : 'Select'
  $('act-delete').removeAttribute('data-arm')
  drawRail()
}

async function archivePicked(archived) {
  const ids = [...state.picked]
  if (ids.length === 0) return
  try {
    await fetch('/gnomon/api/sessions/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, archived }),
    })
  } catch {
    return
  }
  state.picked.clear()
  await loadSessions()
}

/**
 * Delete, in two clicks on the same button.
 *
 * The first arms it: it fills and names the count, which is the confirmation.
 * The second does it. Anything else — picking another row, leaving select
 * mode — disarms it, so an armed delete never survives a change of mind.
 */
async function deletePicked() {
  const del = $('act-delete')
  const ids = [...state.picked].filter((id) => !PROTECTED.has(id))
  if (ids.length === 0) return
  if (!del.hasAttribute('data-arm')) {
    del.setAttribute('data-arm', '')
    del.textContent = `Delete ${ids.length}?`
    return
  }
  del.removeAttribute('data-arm')
  del.disabled = true
  let body = null
  try {
    body = await (await fetch('/gnomon/api/sessions/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })).json()
  } catch {
    body = null
  }
  const deleted = new Set(body?.deleted ?? [])
  if (deleted.has(state.sessionId)) {
    // The session on screen is gone. Say so where the owner is looking, and do
    // not leave a composer aimed at nothing.
    state.sessionId = null
    loadModels()
    loadPermission()
    clearCanvas()
    await showToday()
  }
  for (const id of deleted) state.picked.delete(id)
  if (body?.refused?.length) {
    // Refusals are shown, not swallowed: the owner asked for something and part
    // of it did not happen, and the reason is the useful part.
    apply({ type: 'error', message: body.refused.map((r) => `Not deleted — ${r.reason}`).join(' ') })
  }
  await loadSessions()
}

companionSeat.addEventListener('click', () => openSession(COMPANION_SESSION_ID))

// A conversation hit in Explore opens the conversation it was said in. The
// search knows which session; only this module knows how to open one, and it
// cannot be imported from there (explore.js is imported BY the stage it draws
// on), so the hit asks rather than reaches.
document.addEventListener('gnomon:open-session', (event) => {
  const id = event.detail?.id
  if (typeof id === 'string' && id !== '') openSession(id)
})

/**
 * Save the open conversation.
 *
 * dsh ships `session-log-export`, and it is enabled — but it registers an
 * `/export` COMMAND that dsh's own browser plugin observes, and that plugin
 * never boots here because Gnomon serves `/` itself. The frames are already
 * one fetch away on this shell's own route, so this is the whole feature.
 */
$('companion-export').addEventListener('click', async () => {
  const id = state.sessionId ?? COMPANION_SESSION_ID
  const button = $('companion-export')
  const label = button.textContent
  button.disabled = true
  try {
    const body = await (await fetch(`/gnomon/api/session?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })).json()
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
    const link = el('a', { href: url, download: `gnomon-${id}.json` })
    link.click()
    // Revoked on the next tick, not immediately: the click is synchronous but
    // the browser reads the blob after this handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 0)
    button.textContent = 'Saved'
  } catch {
    button.textContent = 'Failed'
  }
  setTimeout(() => {
    button.textContent = label
    button.disabled = false
  }, 1600)
})

/** Compact now, rather than at the threshold the gauge is counting toward. */
$('companion-compact').addEventListener('click', async () => {
  const button = $('companion-compact')
  const label = button.textContent
  button.disabled = true
  button.textContent = 'Compacting…'
  try {
    const response = await fetch('/gnomon/api/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId ?? COMPANION_SESSION_ID }),
    })
    const body = await response.json()
    button.textContent = body?.compacted === true ? 'Compacted' : 'Unavailable'
    // The gauge is the point of compacting, so it should not wait for a turn.
    void drawContextMeter()
  } catch {
    button.textContent = 'Failed'
  }
  setTimeout(() => {
    button.textContent = label
    button.disabled = false
  }, 2000)
})

/**
 * Open a thread: replay its log into the canvas.
 *
 * `all` replays every turn; otherwise the server sends the recent ones and says
 * how many came before (`earlier`), and a fold at the top brings them in. A
 * number for `all` is how many turns the fold had held, so the page opens where
 * the owner was reading rather than at the end.
 */
async function openSession(id, { quiet = false, all = false } = {}) {
  $('act-delete')?.removeAttribute('data-arm')
  state.aborter?.abort()
  state.sessionId = id
  loadModels()
  loadPermission()
  state.view = 'session'
  delete input.dataset.place
  markFoot()
  clearCanvas()
  for (const button of rail.querySelectorAll('.session')) button.setAttribute('aria-current', String(button.title === id))
  // The pinned seat is not a `.session` row, so it marks itself.
  drawCompanion()
  openThreads(false)
  drawThreadBar()
  if (!quiet) showConversation()

  let body = null
  try {
    body = await (await fetch(`/gnomon/api/session?id=${encodeURIComponent(id)}${all ? '&all=1' : ''}`, { headers: { accept: 'application/json' } })).json()
  } catch {
    apply({ type: 'error', message: 'That session could not be read.' })
    return
  }
  state.replaying = true
  // After "Earlier": a mark where the recent turns began, to open the page there.
  let turns = 0
  let wasFirst = null
  for (const frame of body.frames ?? []) {
    if (frame.type === 'turn' && typeof all === 'number' && turns++ === all) stack().append((wasFirst = el('div', { class: 'earlier-mark' })))
    apply(frame)
  }
  state.replaying = false
  if (body.earlier > 0) stack().prepend(earlierFold(id, body.earlier))
  updateLens()
  // A session with nothing in it yet opens on the day, the same as a new one.
  if ((body.frames ?? []).length === 0) await showToday()
  replayUnheard()
  watchSession(id)
  // Force, not follow: opening a session should land at its end, wherever the
  // scroll happened to be a moment ago. After "Earlier", on the turn that had
  // been first, with what was folded above it.
  if (wasFirst) {
    stickToBottom = false
    wasFirst.scrollIntoView({ block: 'start' })
  } else follow(true)
  input.focus({ preventScroll: true })
}

/** The top of a thread opened on its recent turns: one act that brings in the rest. */
function earlierFold(id, count) {
  return el('div', { class: 'earlier' }, [
    el('button', {
      type: 'button',
      class: 'link',
      text: `Show the ${count} earlier turn${count === 1 ? '' : 's'}`,
      onclick: (event) => {
        event.currentTarget.disabled = true
        event.currentTarget.textContent = 'Reading the earlier turns…'
        void openSession(id, { quiet: true, all: count })
      },
    }),
  ])
}

/**
 * Jump back through a long conversation: every thing you said in it, newest
 * first, each a door to its place in the transcript. Read off the transcript
 * itself, so it is exactly what is on screen.
 */
function turnsButton() {
  const list = el('div', { class: 'turns-menu', hidden: true, role: 'listbox', 'aria-label': 'Your messages in this conversation' })
  const button = el('button', {
    type: 'button',
    class: 'turns-pick',
    text: 'Turns',
    'aria-expanded': 'false',
    title: 'Jump to something you said earlier',
    onclick: (event) => {
      event.stopPropagation()
      const open = list.hidden
      list.hidden = !open
      button.setAttribute('aria-expanded', String(open))
      if (!open) return
      const said = [...canvas.querySelectorAll('.turn > p.said')].reverse().slice(0, 40)
      list.replaceChildren(
        ...(said.length
          ? said.map((p) => el('button', { type: 'button', class: 'mention', text: p.textContent, onclick: (e) => (e.stopPropagation(), (list.hidden = true), button.setAttribute('aria-expanded', 'false'), p.closest('.turn')?.scrollIntoView({ block: 'start' })) }))
          : [el('span', { class: 'turns-none', text: 'Nothing said here yet.' })]),
      )
    },
  })
  return el('span', { class: 'turns' }, [button, list])
}

/** Show or hide the thread list over the transcript; showing it brings the card forward. */
function openThreads(open) {
  const picker = $('thread-picker')
  picker.hidden = !open
  $('thread-bar').querySelector('.thread-pick')?.setAttribute('aria-expanded', String(open))
  if (open) {
    showConversation()
    loadSessions()
  }
  markFoot()
}

/**
 * The bar over the transcript: which thread this is, and the button that lists
 * them all. In a side thread it also offers the way back, and Bring in — which
 * carries this thread's words into the conversation and lets Gnomon say where
 * it landed.
 */
function drawThreadBar() {
  const bar = $('thread-bar')
  const id = state.sessionId
  const side = id !== null && id !== COMPANION_SESSION_ID
  const title = side ? state.rows.find((r) => r.id === id)?.title || 'Side thread' : 'Gnomon'
  const pick = el('button', {
    type: 'button',
    class: 'thread-pick',
    'aria-expanded': String(!$('thread-picker').hidden),
    title: 'All threads',
    onclick: () => openThreads($('thread-picker').hidden),
  }, [el('span', { class: 'thread-bar-name', text: title }), el('span', { class: 'thread-pick-mark', text: 'Threads' })])
  if (!side) return void bar.replaceChildren(pick, turnsButton(), companionMeter)
  const bring = el('button', {
    type: 'button',
    class: 'act',
    text: 'Bring into the conversation',
    title: 'Carry this thread into the main conversation; Gnomon says what it settled',
    onclick: async (event) => {
      event.currentTarget.disabled = true
      await openSession(COMPANION_SESSION_ID)
      try {
        const response = await fetch('/gnomon/api/bring', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: id, title }) })
        const got = await response.json().catch(() => ({}))
        if (!response.ok) apply({ type: 'error', message: got.unavailable ?? 'That thread could not be brought in.' })
      } catch {
        apply({ type: 'error', message: 'That thread could not be brought in.' })
      }
    },
  })
  bar.replaceChildren(pick, bring, el('button', { type: 'button', class: 'link', text: 'Back to Gnomon', onclick: () => openSession(COMPANION_SESSION_ID) }))
}

/**
 * Turns nobody typed, as they happen: the companion woken by a notice, a job
 * reporting back, a turn that outlived its POST. The server keeps this quiet
 * while our own POST streams, so a frame here is always one the POST did not
 * carry. `heardLive` tells the `said` broadcast its words are already drawn.
 */
let watcher = null
function watchSession(id) {
  watcher?.close()
  watcher = new EventSource(`/gnomon/api/watch?id=${encodeURIComponent(id)}`)
  watcher.onmessage = (event) => {
    if (state.sessionId !== id || state.running) return
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    if (frame.type === 'text') state.heardLive = true
    if (frame.type === 'turn') state.watchLive = true
    if (frame.type === 'done') state.watchLive = false
    markTalking()
    apply(frame)
    if (frame.type === 'done') {
      state.speaking = false
      updateMood()
    }
  }
  watcher.onerror = () => void checkSignedIn()
}

async function newSession() {
  try {
    const body = await (await fetch('/gnomon/api/session/new', { method: 'POST' })).json()
    if (typeof body.id !== 'string') return
    state.sessionId = body.id
    // Live from the first word: a helper's report can wake this thread too.
    watchSession(body.id)
    loadModels()
    loadPermission()
    state.view = 'session'
    delete input.dataset.place
    openThreads(false)
    markFoot()
    clearCanvas()
    await showToday()
    replayUnheard()
    await loadSessions()
    // A new thread is for talking: the chat opens, the composer takes the cursor.
    showConversation()
    input.focus({ preventScroll: true })
  } catch {
    apply({ type: 'error', message: 'A session could not be started.' })
  }
}

// ── Saying something ──────────────────────────────────────────────────────

function setRunning(running) {
  state.running = running
  markTalking()
  // The board reads this: a walk's last Next means "continue" while a turn runs.
  document.body.dataset.running = String(running)
  // Live while a turn runs: the button is the Stop. Disabled only when there
  // is neither a turn to stop nor anything to say.
  send.disabled = !running && input.value.trim() === ''
  updateBarMode()
  updateMood()
}

/**
 * Stop the running turn, and say whether the owner left a note.
 *
 * Aborting the stream only ever stopped this browser READING — the turn ran on,
 * spending tokens on a shell command that had hung. This calls the turn off for
 * real and puts the reason on the record, so the next turn knows the silence
 * was the owner's doing.
 *
 * The note is whatever is in the composer. No second control and no dialog: a
 * dialog to explain an interruption is one more thing to dismiss while the
 * thing you wanted stopped is still running. Type or do not; Stop works either way.
 */
async function stopTurn() {
  if (state.sessionId === null) return
  const note = input.value.trim()
  send.disabled = true
  send.textContent = 'Stopping…'
  try {
    const res = await fetch('/gnomon/api/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, ...(note === '' ? {} : { note }) }),
    })
    if (!res.ok) {
      apply({ type: 'error', message: 'That turn could not be stopped — it may have finished on its own.' })
      return
    }
    input.value = ''
    autosize()
    // Drawn here rather than waiting for the `done` frame: the owner pressed a
    // button and the page must answer immediately, and their note is a thing
    // they said, so it belongs in the transcript in their own words.
    dropLiveLine()
    turn().append(
      el('div', { class: 'stopped' }, [el('span', { text: 'You stopped this.' }), note === '' ? null : el('span', { class: 'stopped-note', text: note })]),
    )
    state.prose = null
    follow()
  } catch {
    apply({ type: 'error', message: 'That turn could not be stopped — the shell could not be reached.' })
  } finally {
    setRunning(state.running)
  }
}

// A reply pressed on a notice row. The band raised it knowing only the words;
// this is what makes them a turn — the owner's answer arrives exactly as if
// they had typed it, so there is no second channel for Gnomon to read.
document.addEventListener('gnomon:say', (event) => {
  const text = event.detail?.text
  if (typeof text === 'string' && text.trim() !== '') {
    showConversation()
    say(text.trim())
  }
})

/**
 * Send one message and read the turn it opens.
 *
 * The stream is read straight off the POST rather than through a second
 * subscribe: there is then no window in which the turn has started and nobody
 * is listening. Aborting it only stops READING — the turn keeps running and
 * lands in the log, because the tokens are spent either way.
 */
async function say(text, extra = {}) {
  if (state.sessionId === null) await newSession()
  if (state.sessionId === null) return

  setRunning(true)
  const controller = new AbortController()
  state.aborter = controller

  try {
    const response = await fetch('/gnomon/api/turn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, text: withMentions(text), place: input.dataset.place ?? placeOfView(), ...extra }),
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      apply({ type: 'error', message: 'Gnomon could not be reached.' })
      return
    }

    // SSE by hand, because EventSource cannot POST. Frames are `data: <json>`
    // separated by a blank line, and a chunk boundary falls anywhere, so the
    // tail is carried over.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find((candidate) => candidate.startsWith('data: '))
        if (line === undefined) continue
        try {
          apply(JSON.parse(line.slice(6)))
        } catch {
          // A truncated frame is the stream ending mid-write. Nothing to draw.
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) apply({ type: 'error', message: 'That turn ended badly.' })
  } finally {
    if (state.aborter === controller) state.aborter = null
    setRunning(false)
    // The first message names the session, so the rail is stale the moment it
    // lands — and the model-written title follows a few seconds after the turn.
    loadSessions()
    setTimeout(loadSessions, TITLE_SETTLE_MS)
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────

/** Grow the box with the text, up to the CSS ceiling, then let it scroll. */
function autosize() {
  input.style.height = 'auto'
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`
}

input.addEventListener('input', () => {
  autosize()
  setRunning(state.running)
  drawMentions()
})

// ── @ a thread ────────────────────────────────────────────────────────────
// Type @ and part of a thread's name to pull that thread into what you say:
// dsh-session-reference turns the mention into a bounded snapshot of that
// thread, handed to the model as background. The composer shows "@Name"; the
// canonical `@[Name](dsh-session:<base64url of the JSON id>)` is written only
// when the message goes.
const mentions = new Map()
const mentionMenu = el('div', { class: 'mention-menu', role: 'listbox', hidden: true, 'aria-label': 'Threads to mention' })
input.before(mentionMenu)
const b64url = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** The owner's words with every picked "@Name" as the mention dsh understands. */
function withMentions(text) {
  let out = text
  for (const [label, id] of mentions) out = out.split(`@${label}`).join(`@[${label.replace(/[\[\]]/g, '')}](dsh-session:${b64url(JSON.stringify(id))})`)
  mentions.clear()
  return out
}
function drawMentions() {
  const before = input.value.slice(0, input.selectionStart ?? input.value.length)
  const match = /(^|\s)@([^@\n]{0,40})$/.exec(before)
  if (match === null) return void (mentionMenu.hidden = true)
  const q = match[2].toLowerCase()
  const rows = state.rows.filter((r) => r.id !== state.sessionId && ownThread(r) && !r.archived && (r.title ?? '') !== '' && r.title.toLowerCase().includes(q)).slice(0, 6)
  mentionMenu.hidden = rows.length === 0
  mentionMenu.replaceChildren(
    ...rows.map((r) =>
      el('button', {
        type: 'button',
        class: 'mention',
        role: 'option',
        text: r.id === COMPANION_SESSION_ID ? 'Gnomon (the conversation)' : r.title,
        onmousedown: (event) => {
          event.preventDefault()
          const label = r.id === COMPANION_SESSION_ID ? 'Gnomon' : r.title
          mentions.set(label, r.id)
          const at = before.length - match[2].length - 1
          input.value = `${input.value.slice(0, at)}@${label} ${input.value.slice(before.length)}`
          const caret = at + label.length + 2
          input.setSelectionRange(caret, caret)
          mentionMenu.hidden = true
          autosize()
        },
      }),
    ),
  )
}

// Enter says it; Shift+Enter is a new line. (⌘⏎ is taken system-wide on the owner's Mac.)
input.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !mentionMenu.hidden) return void (mentionMenu.hidden = true)
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  // Enter with the thread list open picks the first thread, it does not send.
  if (!mentionMenu.hidden) return void mentionMenu.firstChild?.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }))
  bar.requestSubmit()
})

/**
 * Images waiting to go with the next message.
 *
 * Uploaded on paste rather than on send, so a big screenshot is already stored
 * by the time the owner finishes typing — and so a refusal ("not a PNG", "too
 * many pixels") arrives while they can still do something about it, instead of
 * failing the turn.
 */
const pending = []

/** Fewer than the store's twenty per message: a composer is not an album. */
const MAX_ATTACHMENTS = 4

/**
 * Say why an attachment was refused, in the strip itself.
 *
 * Not a `.fail` line in the turn: there is no turn yet — the owner is still
 * typing — and the reason belongs beside the thing that was refused. Clears on
 * the next redraw, which is the next paste or the next send.
 */
function note(text) {
  const strip = $('attached')
  strip.hidden = false
  strip.replaceChildren(el('span', { class: 'attached-note', text }))
}

function drawPending() {
  const strip = $('attached')
  strip.hidden = pending.length === 0
  strip.replaceChildren(
    ...pending.map((item, index) =>
      el('span', { class: 'attached-chip' }, [
        el('img', { class: 'attached-thumb', src: item.preview, alt: item.ref.name ?? 'attached image' }),
        el('span', { class: 'attached-name', text: `${item.ref.width}×${item.ref.height}` }),
        el('button', {
          type: 'button',
          class: 'attached-drop',
          'aria-label': 'Remove this image',
          text: '×',
          onclick: () => {
            URL.revokeObjectURL(pending[index].preview)
            pending.splice(index, 1)
            drawPending()
          },
        }),
      ]),
    ),
  )
}

/** Store one image and hold its ref for the next message. */
async function attach(file) {
  if (pending.length >= MAX_ATTACHMENTS) return
  try {
    const response = await fetch('/gnomon/api/attach', {
      method: 'POST',
      headers: { 'content-type': file.type, 'x-gnomon-filename': encodeURIComponent(file.name ?? 'pasted') },
      body: file,
    })
    const body = await response.json()
    if (body?.attachment === undefined) {
      // The store's own reason, verbatim — "not an image" and "too many
      // pixels" need different things from the owner.
      note(body?.unavailable ?? 'That image was refused.')
      return
    }
    pending.push({ ref: body.attachment, preview: URL.createObjectURL(file) })
    drawPending()
  } catch {
    note('That image could not be attached.')
  }
}

/** Paste, drop, or the file picker — all three end up here. */
const attachAll = (files) => {
  for (const file of files) if (typeof file?.type === 'string' && file.type.startsWith('image/')) void attach(file)
}

// The paperclip: the same store a paste uses, reached by the file picker for
// anyone who did not just copy something.
$('act-attach').addEventListener('click', () => $('attach-file').click())
$('attach-file').addEventListener('change', (event) => {
  for (const file of event.currentTarget.files ?? []) attach(file)
  event.currentTarget.value = ''
})

/**
 * The mic: speak instead of typing.
 *
 * Recorded here, typed out by the whisper server on this machine's own
 * loopback — never a browser speech service, which would send the owner's
 * voice off the machine for a convenience. The text lands in the composer
 * rather than being sent, so nothing is said that the owner did not read.
 */
const mic = { rec: null, chunks: [] }
const micButton = $('act-mic')
const setMic = (on) => {
  micButton.setAttribute('aria-pressed', String(on))
  micButton.title = on ? 'Stop and type it out' : 'Speak instead of typing — transcribed on this machine'
}
micButton.addEventListener('click', async () => {
  if (mic.rec !== null) {
    mic.rec.stop()
    return
  }
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    note('The microphone was refused. Allow it for this page and try again.')
    return
  }
  mic.chunks = []
  mic.rec = new MediaRecorder(stream)
  mic.rec.ondataavailable = (event) => event.data.size > 0 && mic.chunks.push(event.data)
  mic.rec.onstop = async () => {
    for (const track of stream.getTracks()) track.stop()
    const blob = new Blob(mic.chunks, { type: mic.rec.mimeType || 'audio/webm' })
    mic.rec = null
    setMic(false)
    if (blob.size < 1200) return
    micButton.setAttribute('data-busy', '')
    try {
      const got = await (await fetch('/gnomon/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob })).json()
      if (typeof got?.text === 'string' && got.text !== '') {
        input.value = input.value === '' ? got.text : `${input.value} ${got.text}`
        autosize()
        input.focus({ preventScroll: true })
      } else note(got?.unavailable ?? 'Nothing was heard.')
    } catch {
      note('That could not be typed out.')
    } finally {
      micButton.removeAttribute('data-busy')
    }
  }
  mic.rec.start()
  setMic(true)
})

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])]
  if (files.length === 0) return
  // Only when there ARE files: a normal text paste must not be swallowed.
  event.preventDefault()
  attachAll(files)
})

for (const [name, handler] of [
  ['dragover', (event) => event.preventDefault()],
  ['drop', (event) => {
    event.preventDefault()
    attachAll([...(event.dataTransfer?.files ?? [])])
  }],
]) {
  bar.addEventListener(name, handler)
}

bar.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  // An image with no words is still a message: "look at this" is the question.
  // Mid-turn the button IS the Stop, and anything typed rides along as the note
  // — which is why this is checked before the empty-message guard below.
  if (state.running) {
    await stopTurn()
    return
  }
  if (text === '' && pending.length === 0) return
  // A question is open and the owner typed: that is the answer. Recorded as one
  // (the fold closes the question), AND said to the model with the question as
  // context — an answer like "a few bugs, here are the topics" is exactly the
  // kind of thing worth keeping, and only a turn can keep it.
  const ask = answeringNow() ? openAsk : null
  input.value = ''
  autosize()
  setRunning(true)
  if (ask !== null) {
    await answerOpenAsk(text, { typed: true })
    // A WAITING ask has a turn paused on it in the thread that asked; the
    // record is the whole answer and that turn picks it up. A second turn here
    // would answer twice.
    if (ask.waiting) {
      setRunning(false)
      return
    }
    // Gnomon's questions and the owner's answers live in the ONE long
    // conversation, whichever thread happened to be open when they typed.
    if (state.sessionId !== COMPANION_SESSION_ID) await openSession(COMPANION_SESSION_ID)
    say(text, { answering: { askId: ask.askId, question: ask.question } })
    return
  }
  // "Not an answer" was for this one message. The next one answers again.
  delete input.dataset.answering
  updateBarMode()
  const images = pending.map((item) => item.ref)
  for (const item of pending) URL.revokeObjectURL(item.preview)
  pending.length = 0
  drawPending()
  say(text, images.length > 0 ? { images } : {})
})

// ── The other two views ───────────────────────────────────────────────────
// Not overlays and not pages: the canvas showing something other than a
// conversation. An overlay was the old shape only because the old client could
// not have the canvas — a view switch is one less layer to reason about, and
// cannot end up stacked underneath another page.
//
// The input bar stays. Asking about what you are looking at should never
// require leaving it, which is what `placeOfView` carries into the turn.

/** What the owner is looking at, carried into the turn. Nothing when it is the conversation itself. */
function placeOfView() {
  const id = focused()
  return id === null || id === 'session' ? '' : `looking at ${titleOf(id)}`
}

/** The summons mark what is in focus. */
function markFoot() {
  const id = focused() ?? ''
  $('summon-threads').setAttribute('aria-current', String(!$('thread-picker').hidden))
  $('summon-explore').setAttribute('aria-current', String(id === 'explore' || id.startsWith('entity:') || id.startsWith('moment:')))
  $('summon-ledger').setAttribute('aria-current', String(id === 'engine'))
  $('summon-instruments').setAttribute('aria-current', String(MENU.includes(id) && id !== 'engine'))
}

// The Ledger button opens the Engine room on its cost tab.
$('summon-ledger').addEventListener('click', () => openCard('engine'))
$('summon-threads').addEventListener('click', () => openThreads(true))
$('summon-explore').addEventListener('click', () => openExplore())

// The Cards menu: the board's main cards by name, from the catalog.
const instrumentsMenu = $('instruments-menu')
const setInstrumentsMenu = (open) => {
  instrumentsMenu.hidden = !open
  $('summon-instruments').setAttribute('aria-expanded', String(open))
}
instrumentsMenu.replaceChildren(
  ...MENU.map((id) =>
    el('button', {
      type: 'button',
      class: 'menu-item',
      role: 'menuitem',
      text: cardOf(id)?.title ?? id,
      onclick: () => {
        setInstrumentsMenu(false)
        openCard(id)
      },
    }),
  ),
)
$('summon-instruments').addEventListener('click', () => setInstrumentsMenu(instrumentsMenu.hidden))

// ── When the board is looking ────────────────────────────────────────────
// One control, in the record, for every card at once. The presets set a span;
// the ruler beside them names a single day. Before this there were three
// unrelated mechanisms and "show me last week" had three different answers
// depending on which card you asked.
//
// Both halves write `board:span` and neither draws from its own memory: the
// record comes back as a board frame and THAT is what lights a chip. Gnomon can
// wind the span too, and when it does the owner's chips move with it.
{
  const SPANS = [
    ['today', 'Today'],
    ['7d', '7d'],
    ['14d', '14d'],
    ['30d', '30d'],
  ]
  const postSpan = (body) => fetch('/gnomon/api/board', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'span', ...body }) }).catch(() => {})

  const chips = new Map()
  const spanBar = $('span')
  for (const [label, text] of SPANS) {
    const chip = el('button', { type: 'button', class: 'span-chip', text, title: `Show the whole board ${label === 'today' ? 'today' : `over the last ${text}`}`, onclick: () => postSpan({ label }) })
    chips.set(label, chip)
    spanBar.append(chip)
  }

  const DAYS_BACK = 13
  const ymd = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  // The ruler's fourteen days end on the page's today, and are drawn again when
  // a tab left open overnight wakes on a new day (`rollDay` below).
  let base = null
  const labels = el('div', { class: 'sd-days' })
  const drawRuler = () => {
    base = new Date()
    base.setHours(12, 0, 0, 0)
    labels.replaceChildren()
    for (let i = -DAYS_BACK; i <= 0; i++) {
      const d = new Date(base)
      d.setDate(base.getDate() + i)
      labels.append(el('span', { class: `sd-day${i === 0 ? ' sd-day-today' : ''}`, text: d.toLocaleDateString(undefined, { weekday: 'narrow' }), title: ymd(d) }))
    }
  }
  drawRuler()
  const range = el('input', { class: 'sd-range', type: 'range', min: String(-DAYS_BACK), max: '0', step: '1', value: '0', 'aria-label': 'Which day the page shows' })
  $('ruler').replaceChildren(range, labels)

  const DAY_PARTS = [['today', 'Today'], ...TODAY_PARTS.filter(([id]) => id !== 'shelf' && id !== 'proposals')]
  let shown = null

  // The day parts still take an explicit date, so their titles can carry it and
  // so they are pinned rather than merely defaulted. Everything else on the
  // board follows the span, which the same gesture set.
  const drawDay = async (date, isToday) => {
    if (date === shown) return
    shown = date
    if (isToday) delete document.body.dataset.day
    else document.body.dataset.day = date
    for (const l of labels.children) l.classList.toggle('sd-day-shown', !isToday && l.title === date)
    const parts = await todayParts(loadQuestion, isToday ? null : date)
    if (shown !== date || !parts) return
    const d = new Date(`${date}T12:00:00`)
    for (const [id, title] of DAY_PARTS) if (has(id) && parts[id]) pane(id, { title: isToday ? title : `${title} · ${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`, node: parts[id] })
  }

  range.addEventListener('input', () => {
    const d = new Date(base)
    d.setDate(base.getDate() + Number(range.value))
    // Back to today is the preset, not a date: a date would still say today's
    // date tomorrow morning.
    void postSpan(Number(range.value) === 0 ? { label: 'today' } : { from: ymd(d) })
  })

  // The record answers. One listener for both hands and for Gnomon's.
  // A preset is read against today (span.js): "Today" set last night is this
  // morning, not yesterday. Only the ruler's day and a custom range keep dates.
  let lastSpan = null
  const onSpan = (stored, first) => {
    lastSpan = stored
    const span = liveSpan(stored, ymd(base))
    const label = span?.label ?? 'today'
    for (const [name, chip] of chips) chip.setAttribute('aria-pressed', String(name === label))
    const oneDay = span !== null && span.from === span.to
    const date = oneDay ? span.to : ymd(base)
    const isToday = date === ymd(base)
    // Keep the slider under the day it is showing, including when Gnomon moved it.
    if (oneDay) {
      const delta = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${ymd(base)}T12:00:00Z`)) / 86_400_000)
      if (delta >= -DAYS_BACK && delta <= 0) range.value = String(delta)
    } else range.value = '0'
    void drawDay(date, isToday)
    // Every reading on screen is now about a different time. Nothing in the
    // record moved, so `markStale` cannot say this; the question changed. Not
    // at boot: no card has read once yet, and this would be the stampede
    // `whenVisible` exists to prevent.
    if (first) return
    rereadAll()
    document.dispatchEvent(new CustomEvent('gnomon:beat'))
  }
  document.addEventListener('gnomon:span', (event) => {
    const { span, first } = event.detail ?? { span: null, first: false }
    onSpan(span ?? null, first)
  })
  // A tab open across midnight: on the next look (or the next beat, for a tab
  // in view), the ruler ends on the new day and every card reads it again.
  const rollDay = () => {
    if (document.visibilityState === 'hidden' || ymd(new Date()) === ymd(base)) return
    drawRuler()
    shown = null
    onSpan(lastSpan, false)
  }
  document.addEventListener('visibilitychange', rollDay)
  document.addEventListener('gnomon:beat', rollDay)
}

// ── The command bar ──────────────────────────────────────────────────────
// `/`, ⌘K or Find: every card, instrument and view by name, else a search.
const paletteItems = () => [
  { label: 'Today', group: 'Cards', run: () => focusPane('today') },
  ...MENU.map((id) => ({ label: cardOf(id).title, group: 'Cards', keywords: `${cardOf(id).keywords ?? ''} ${cardOf(id).question}`, run: () => openCard(id) })),
  { label: 'Threads', group: 'Views', run: () => openThreads(true) },
  { label: 'Settings', group: 'Views', run: () => $('summon-settings').click() },
  { label: 'Conversation', group: 'Views', run: () => $('ghost-toggle').click() },
  { label: `Paper · now ${THEME_LABEL[SETTINGS.paper] ?? 'Auto'} · switch`, group: 'Views', run: () => $('theme-toggle').click() },
  { label: `Card blur · now ${BLUR_LABEL[SETTINGS.blur] ?? 'Full'} · turn ${(SETTINGS.blur ?? 'full') === 'off' ? 'on' : 'off'}`, group: 'Views', run: toggleGlass },
]

// The one setting worth reaching for mid-thought, which is why it is in Find
// and not only in the card: a blur is re-sampled on every frame, so turning the
// glass off is also how a tired machine gets a cheap board back. It remembers
// what was on, so a Soft board comes back Soft rather than Full.
let lastGlass = 'full'
const toggleGlass = () => {
  const now = SETTINGS.blur ?? 'full'
  if (now !== 'off') lastGlass = now
  return setSetting({ blur: now === 'off' ? lastGlass : 'off' })
}
const openFind = () => openPalette(paletteItems(), (q) => openExplore(q))
document.addEventListener('gnomon:palette', openFind)
document.addEventListener('keydown', (e) => (e.metaKey || e.ctrlKey) && e.key === 'k' && (e.preventDefault(), openFind()))
// `/` opens Find, the way the foot advertises it — unless the owner is typing,
// in which case a slash is a slash.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
  const t = e.target
  if (t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return
  e.preventDefault()
  openFind()
})
$('summon-find').addEventListener('click', openFind)
document.addEventListener('click', (event) => {
  if (!instrumentsMenu.hidden && !$('instruments-host').contains(event.target)) setInstrumentsMenu(false)
})
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape' || instrumentsMenu.hidden) return
    event.stopImmediatePropagation()
    setInstrumentsMenu(false)
    $('summon-instruments').focus()
  },
  true,
)

// ── The model ─────────────────────────────────────────────────────────────
// Gnomon's own picker, not a native <select>: the owner needs to see WHICH
// ROUTE a model is reached over, because two routes can carry the same model
// id and only one of them holds a key. The button reads provider over model;
// the menu groups by provider, marks the current one, and opens upward.

/** The last listing, so the menu can redraw without a fetch. */
const models = { current: null, list: [], scope: 'default' }

function setModelButton(current) {
  $('model-provider').textContent = current?.providerName ?? current?.provider ?? ''
  $('model-name').textContent = current?.model ?? '…'
  // Only the full id, which the chip ellipsises. Repeating the provider and
  // "Click to change" made a native tooltip wide enough to cover the composer.
  modelPick.title = current?.model ?? ''
}

function renderModelMenu() {
  const { current, list } = models
  const groups = new Map()
  for (const m of list) {
    const key = m.provider
    if (!groups.has(key)) groups.set(key, { name: m.providerName ?? m.provider, items: [] })
    groups.get(key).items.push(m)
  }
  const nodes = []
  for (const [provider, group] of groups) {
    nodes.push(el('div', { class: 'model-group', text: group.name === provider ? provider : `${group.name} · ${provider}` }))
    for (const m of group.items) {
      const selected = current !== null && m.provider === current.provider && m.model === current.model
      nodes.push(
        el(
          'button',
          {
            type: 'button',
            class: 'model-opt',
            role: 'option',
            'aria-selected': String(selected),
            'data-provider': m.provider,
            'data-model': m.model,
            onclick: () => chooseModel(m),
          },
          [
            el('span', { class: 'model-opt-id', text: m.model }),
            m.description ? el('span', { class: 'model-opt-desc', text: m.description }) : null,
          ],
        ),
      )
    }
  }
  if (nodes.length === 0) nodes.push(el('div', { class: 'model-empty', text: 'No route can list a model right now.' }))
  modelMenu.replaceChildren(...nodes)
}

async function loadModels() {
  let body = null
  // With a thread open the chip shows THAT thread's model; on the board, the default.
  const session = state.view === 'session' && state.sessionId !== null ? `?session=${encodeURIComponent(state.sessionId)}` : ''
  try {
    body = await (await fetch(`/gnomon/api/models${session}`, { headers: { accept: 'application/json' } })).json()
  } catch {
    return
  }
  models.current = body.current ?? null
  models.list = body.models ?? []
  models.scope = body.scope ?? 'default'
  setModelButton(models.current)
  renderModelMenu()
}

function setModelMenu(open) {
  modelMenu.hidden = !open
  modelPick.setAttribute('aria-expanded', String(open))
  if (open) {
    renderModelMenu()
    const selected = modelMenu.querySelector('[aria-selected="true"]') ?? modelMenu.querySelector('.model-opt')
    selected?.focus()
    selected?.scrollIntoView({ block: 'nearest' })
  }
}

async function chooseModel(m) {
  setModelMenu(false)
  modelPick.focus()
  const previous = models.current
  // Optimistic: the button shows the choice at once, and the reload below
  // corrects it if the server disagreed.
  models.current = m
  setModelButton(m)
  // A thread open → THIS thread switches, from its next answer (J1.10). The
  // board → the default for new threads. One chip; the message says which.
  const thread = state.view === 'session' && state.sessionId !== null ? state.sessionId : null
  try {
    const res = await fetch('/gnomon/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model: m.model, ...(thread ? { sessionId: thread } : {}) }),
    })
    if (!res.ok) throw new Error(String(res.status))
  } catch {
    models.current = previous
    setModelButton(previous)
    loadModels()
    return
  }
  if (thread && (previous === null || previous.provider !== m.provider || previous.model !== m.model)) {
    apply({ type: 'error', message: `This thread now uses ${m.providerName ?? m.provider} · ${m.model} from its next answer. New threads keep the default.` })
  }
}

/**
 * How much this session may do without stopping to ask — dsh's permission
 * preset, reachable at last.
 *
 * Two rungs, because the deployment's preset table has two: ASK
 * (`workspace-write`) stops for the owner's nod before anything reaches past
 * the workspace, and AUTO (`danger-full-access`) does not. The destructive
 * backstop in sundial-actions runs under BOTH — rm -rf, sudo, dd, a curl piped
 * into a shell are refused whatever this says — so Auto turns off the prompt,
 * not the guard, and the label says so on hover rather than promising safety
 * it cannot give.
 *
 * Only shown in a session, and only once the server has said the preset service
 * is there: a switch that cannot switch anything is worse than no switch.
 */
const ASK_PRESET = 'workspace-write'
const AUTO_PRESET = 'danger-full-access'
const permChip = $('perm')
const permName = $('perm-name')
const permission = { current: null, names: [] }

function drawPermission() {
  const usable = permission.names.includes(ASK_PRESET) && permission.names.includes(AUTO_PRESET)
  permChip.hidden = !usable || state.sessionId === null
  if (permChip.hidden) return
  const auto = permission.current === AUTO_PRESET
  permChip.classList.toggle('is-auto', auto)
  permChip.setAttribute('aria-pressed', auto ? 'true' : 'false')
  permChip.title = auto
    ? 'Auto: Gnomon runs commands without asking. Destructive ones — rm -rf, sudo, dd, a piped curl, a force push — are still refused. Switch back to Ask.'
    : 'Ask: Gnomon stops for your nod before anything reaches past the workspace. Switch to Auto to let it run.'
  permName.textContent = auto ? 'Auto' : 'Ask'
}

async function loadPermission() {
  if (state.sessionId === null) {
    permission.current = null
    drawPermission()
    return
  }
  try {
    const body = await (await fetch(`/gnomon/api/permission?session=${encodeURIComponent(state.sessionId)}`, { headers: { accept: 'application/json' } })).json()
    permission.current = body.current ?? null
    permission.names = body.names ?? []
  } catch {
    permission.names = []
  }
  drawPermission()
}

permChip.addEventListener('click', async () => {
  const previous = permission.current
  const next = previous === AUTO_PRESET ? ASK_PRESET : AUTO_PRESET
  // Optimistic, like the model picker: the chip moves at once and the reload
  // below puts it back if the server disagreed.
  permission.current = next
  drawPermission()
  permChip.disabled = true
  try {
    const res = await fetch('/gnomon/api/permission', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, preset: next }),
    })
    if (!res.ok) throw new Error(String(res.status))
    permission.current = (await res.json()).current ?? next
  } catch {
    permission.current = previous
    apply({ type: 'error', message: 'That permission change did not take.' })
  }
  permChip.disabled = false
  drawPermission()
})

modelPick.addEventListener('click', () => setModelMenu(modelMenu.hidden))
// Close on a click anywhere else, and on Escape from anywhere inside.
document.addEventListener('pointerdown', (event) => {
  if (!modelMenu.hidden && !$('model').contains(event.target)) setModelMenu(false)
})
$('model').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modelMenu.hidden) {
    event.preventDefault()
    setModelMenu(false)
    modelPick.focus()
    return
  }
  if (modelMenu.hidden) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      setModelMenu(true)
    }
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const options = [...modelMenu.querySelectorAll('.model-opt')]
    if (options.length === 0) return
    const at = options.indexOf(document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = options[(at + step + options.length) % options.length]
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  }
})

// ── The live channel ──────────────────────────────────────────────────────
// Everything that is NOT a reply to something the owner said: what they are
// doing right now, what Gnomon decided to say unprompted, the question it is
// waiting on. One EventSource, reconnected by the browser on its own.
//
// This is the half of Gnomon that was invisible. The notice gate has been
// deciding when to speak all along, and speaking — into a session nobody had
// open. The words were fine; the room was empty.

let present = null
let lastSaid = null
/** The running job's plan, relayed from its child session. Keyed so a new job never wears the old one's steps. */
let workingSteps = { jobId: null, todos: [] }
/** The day's headline number, remembered so the strip can carry it after the block has folded. */
let dayObserved = null

/** `42` → `42 min`, `95` → `1h 35m`. */
const dur = (min) => (min === null || min === undefined ? '' : min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`)

/** False until Today has had its chance to appear: drawing the strip before that put it in the bar for two seconds, then moved it. */
let stripSited = false

function drawStrip() {
  if (present === null || !stripSited) return
  strip.hidden = false
  // The line lives under the brief when Today is on the page, else at the top of it.
  // `#world` only: a Today card the owner removed still has its frame, parked
  // and display:none, and the strip moved into it disappeared off the page.
  const home = document.querySelector('#world .pane[data-pane="today"] .brief-now') ?? $('strip-home')
  if (strip.parentElement !== home) home.append(strip)
  const now = present
  const parts = []

  // Lead with whichever is true of the owner: gone, or deep in something.
  const lead = el('span', { class: 'strip-now', 'data-idle': now.idle || null, 'data-flow': !now.idle && now.flowMin >= 5 ? '' : null }, [
    el('span', { class: 'dot' }),
    el('span', {
      text: now.idle
        ? 'Away'
        : now.app
          ? `${now.app}${now.project ? ` · ${now.project}` : ''}${now.momentMin !== null ? ` · ${dur(now.momentMin)}` : ''}`
          : 'Nothing observed yet',
    }),
  ])
  parts.push(lead)
  // The ears, always. Hearing is the one sensor that records people who never
  // agreed to it, so an open microphone has to SAY it is open — and the same
  // chip is how it gets closed, because a state you can see but not change is
  // a warning label, not a control.
  parts.push(hearingChip(now.hearing))
  // Judgement degraded (J0.9). Silent when Jev answers; said plainly when it does not.
  if (now.judging === 'local-fallback') parts.push(el('span', { class: 'strip-held', 'data-judging': 'local-fallback', title: 'Jev is not answering. The text model is judging in its place — slower, less calibrated; nothing above L2 acts on it.', text: 'judging on the text model' }))
  else if (now.judging === 'off') parts.push(el('span', { class: 'strip-held', 'data-judging': 'off', title: 'Nothing is judging. Rules are on their pre-Jev paths: template lines, the arithmetic gate, no rerank.', text: 'judging offline' }))
  if (!now.idle && now.flowMin >= 5) parts.push(el('span', { class: 'strip-day', text: `in focus ${dur(now.flowMin)}` }))
  if (now.switchesLastHour !== null && !now.idle) parts.push(el('span', { class: 'strip-day', text: `${now.switchesLastHour} switch${now.switchesLastHour === 1 ? '' : 'es'} this hour` }))
  if (now.branch) parts.push(el('span', { class: 'strip-day' }, [now.branch, now.commits > 0 ? ` · ${now.commits} commit${now.commits === 1 ? '' : 's'}` : '']))
  // The phone's word on where the owner is, when the desk cannot know.
  if (now.place) parts.push(el('span', { class: 'strip-day', title: `Reported by the paired phone since ${new Date(now.placeSince).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`, text: `at ${now.place}` }))
  // J3.1: last night, when Health sent it; the wake time alone otherwise.
  if (now.sleep) parts.push(el('span', { class: 'strip-day', title: `Slept ${new Date(now.sleep.from).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}–${new Date(now.sleep.to).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}, reported by Health over the paired phone`, text: `slept ${now.sleep.hours} h` }))
  else if (now.wokeAt) parts.push(el('span', { class: 'strip-day', title: 'Sleep end, reported by the paired phone', text: `woke ${new Date(now.wokeAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` }))
  // The day, once Today has folded into here. Filled from the block itself so
  // the two can never say different numbers. Only once Today has folded away:
  // while the block is on screen the number is already there, twice as large.
  if (dayObserved !== null && focused() !== 'today') {
    parts.push(el('span', { class: 'strip-day' }, [el('b', { text: dayObserved }), ' observed today']))
  }

  // Everything above is what IS (left); everything below asks something of
  // the owner or opens something (right), with the middle left empty.
  const rightFrom = parts.length

  // J2.1: three taps a day on how it is going. The filter's belief is graded
  // against them; nothing prices an interruption on it until that grade is in.
  if (now.self?.due && !now.idle) parts.push(selfReportChips())
  else if (now.self?.lastTap && now.self.lastAt && Date.now() - Date.parse(now.self.lastAt) < 30 * 60_000) parts.push(el('span', { class: 'strip-day', title: 'Your last word on how it is going. Gnomon grades its own read against it.', text: `you said ${now.self.lastTap}` }))
  // A tendency, shown as one: faint, and honest about being a guess.
  if (!now.idle && now.nextStep) parts.push(el('span', { class: 'strip-held', title: `Seen ${now.nextStep.support} times. Such forecasts held ${now.nextStep.reliability ?? 'how often is not measured yet'} — a tendency, not a rule.`, text: `usually ${now.nextStep.process} next` }))
  // What it noticed today — a button, because the number is an invitation to
  // go and see what those were, and the Unsaid tab is where that is answered.
  if ((now.noticedToday ?? 0) > 0 || now.held > 0) {
    const bits = []
    if (now.noticedToday > 0) bits.push(`${now.noticedToday} noticed today`)
    if (now.held > 0) bits.push(`${now.held} held`)
    parts.push(el('button', { type: 'button', class: 'strip-count', title: 'See what Gnomon said, held and dropped today', text: bits.join(' · '), onclick: () => openCard('voice') }))
  }

  parts[rightFrom]?.classList.add('strip-right')

  // The last thing Gnomon said is NOT here. It moved to the pinned seat in the
  // rail, which is the one place the conversation lives now — saying it in both
  // put the same sentence on screen twice, and the header copy was the one with
  // nowhere to go. `lastSaid` is still tracked: `drawCompanion` reads it.
  strip.replaceChildren(...parts)
  updateMood()
}

/**
 * One chip for ambient hearing: what the ears are doing, and the click that
 * changes it.
 *
 * Three readings, because there are three states worth telling apart. LISTENING
 * says why and until when — a meeting names itself, so the owner can see the
 * window was earned rather than guessed. EARS OFF is the hour after a manual
 * stop, when a meeting on the calendar will NOT wake it back up; that has to be
 * visible or the mute reads as the button having failed. LISTEN is the resting
 * state, and the whole reason this exists: the huddle nobody put in a calendar.
 */
/** "flow · meh · stuck" — the owner's own read, once every three hours or so. Settles into the word once recorded. */
function selfReportChips() {
  const wrap = el('span', { class: 'strip-self', title: 'How is it going? Your tap teaches Gnomon what its own read of you is worth — nothing acts on that read until it has earned it.' })
  wrap.append(el('span', { class: 'strip-self-ask', text: 'going?' }))
  for (const tap of ['flow', 'meh', 'stuck']) {
    wrap.append(
      el('button', {
        type: 'button',
        class: 'act act-small',
        text: tap,
        onclick: async () => {
          for (const b of wrap.querySelectorAll('button')) b.disabled = true
          const ok = await fetch('/gnomon/api/self-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tap }) }).then((r) => r.ok).catch(() => false)
          wrap.replaceChildren(el('span', { class: 'verdict-done', text: ok ? tap : 'not recorded' }))
        },
      }),
    )
  }
  return wrap
}

function hearingChip(hearing) {
  const on = hearing?.listening === true
  const muted = hearing?.muted === true
  const until = hearing?.until ? new Date(hearing.until) : null
  const clock = until && Number.isFinite(until.getTime()) ? until.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null
  const why =
    hearing?.reason === 'call'
      ? 'a call'
      : hearing?.reason === 'manual'
        ? 'as long as you asked'
        : (hearing?.title ?? 'a meeting')
  return el(
    'button',
    {
      type: 'button',
      class: `strip-ears${on ? ' is-on' : ''}${muted ? ' is-muted' : ''}`,
      'aria-pressed': on ? 'true' : 'false',
      title: on
        ? `Listening for ${why}${clock ? `, until ${clock}` : ''}. Stop, and nothing wakes it again for an hour.`
        : muted
          ? 'You stopped it. A meeting or a call will not wake it until the hour is up. Listen again for an hour.'
          : 'Not listening. Listen for an hour — for the huddle that is not in the calendar.',
      onclick: async (event) => {
        const button = event.currentTarget
        button.disabled = true
        await fetch('/gnomon/api/hearing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ listen: !on }) }).catch(() => {})
        // The route broadcasts a fresh `now`, which redraws the strip and
        // replaces this node; re-enabling is only for the request that failed.
        button.disabled = false
      },
    },
    [el('span', { class: 'dot' }), el('span', { text: on ? `Listening${clock ? ` · ${clock}` : ''}` : muted ? 'Ears off' : 'Listen' })],
  )
}

/** The gnomon's mood is a reading of the state, never set by hand. */
function updateMood() {
  gnomon.mood(
    openAsk !== null ? 'asking' : state.running ? (state.speaking ? 'speaking' : 'thinking') : input.value.trim() !== '' ? 'listening' : present?.idle ? 'away' : 'idle',
  )
}

/**
 * What Gnomon said on its own, drawn where the owner is.
 *
 * Not a turn — nobody asked — so it does not go inside one. It sits between
 * turns with its own head, the way a colleague leaning over would, and it
 * offers the two things worth doing with an interruption: answer it, or say it
 * was badly timed. Both are turns in the companion's own session, so the
 * proactive plugin's habituation sees them.
 */
/** Unprompted blocks that carry an open question, by askId — so they can settle. */
const unpromptedByAsk = new Map()

/**
 * Settle every block that asked `askId`: the acts go, a one-line outcome stays.
 * Called when the question closes from ANY side — the seat, the chat, expiry —
 * which is the whole point: one fact, reflected everywhere it was shown.
 */
function settleUnprompted(askId, outcome) {
  for (const block of unpromptedByAsk.get(askId) ?? []) {
    if (!block.isConnected || block.hasAttribute('data-settled')) continue
    block.setAttribute('data-settled', '')
    block.querySelector('.unprompted-acts')?.remove()
    block.append(el('div', { class: 'unprompted-outcome', text: outcome }))
  }
  unpromptedByAsk.delete(askId)
}

/**
 * A said that arrived while no session was on the canvas — the owner was on the
 * Ledger, or on Today before opening one. Held here and drawn into the next
 * session view, rather than dropped: the strip shows that Gnomon spoke, and a
 * strip that says "Gnomon spoke" with nowhere to read what it said is a tease.
 */
let unheard = null
const UNHEARD_MAX_AGE_MS = 3 * 60 * 60 * 1000

// Read-only, for looking at the client's mind from the console; never written to.
globalThis.gnomonDebug = () => ({ view: state.view, sessionId: state.sessionId, unheard })
/** For a hand test: pretend a job is running (or `null` to end it). */
globalThis.gnomonFakeJob = (job, todos = []) => {
  present = { ...(present ?? {}), working: job, queued: 0 }
  if (job) workingSteps = { jobId: job.jobId, todos }
  drawJob()
}

function replayUnheard() {
  if (unheard === null) return
  const frame = unheard
  unheard = null
  if (Date.now() - new Date(frame.at).getTime() > UNHEARD_MAX_AGE_MS) return
  drawUnprompted(frame)
}

function drawUnprompted(frame) {
  if (state.sessionId === null) {
    unheard = frame
    return
  }
  // In the conversation itself the words belong in the transcript, as a turn
  // of Gnomon's own — it is always open now, so what it says must land here.
  if (state.sessionId === COMPANION_SESSION_ID) {
    // Already drawn, delta by delta, by the session watch.
    if (state.heardLive) {
      state.heardLive = false
      if (typeof frame.askId === 'string' && frame.askId !== '') unpromptedByAsk.set(frame.askId, [...(unpromptedByAsk.get(frame.askId) ?? []), state.turn])
      return
    }
    apply({ type: 'turn' })
    apply({ type: 'say', text: frame.text })
    if (typeof frame.askId === 'string' && frame.askId !== '') unpromptedByAsk.set(frame.askId, [...(unpromptedByAsk.get(frame.askId) ?? []), state.turn])
    return
  }
  const body = el('div', { class: 'prose' })
  body.replaceChildren(renderMarkdown(frame.text))
  const when = new Date(frame.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const asking = typeof frame.askId === 'string' && frame.askId !== ''
  const block = el('section', { class: 'unprompted', 'data-ask': asking ? frame.askId : null }, [
    el('div', { class: 'unprompted-head' }, [el('span', { text: asking ? 'Gnomon asks' : 'Gnomon, unprompted' }), el('span', { class: 'unprompted-when', text: when })]),
    body,
    el('div', { class: 'unprompted-acts' }, [
      // A block that IS a question offers to answer it — in the seat below,
      // which is the one place an answer is recorded — rather than a Reply that
      // opens a second conversation about the same thing.
      asking
        ? el('button', {
            type: 'button',
            class: 'act',
            text: 'Answer',
            onclick: () => {
              input.dataset.answering = '1'
              input.value = ''
              autosize()
              input.focus({ preventScroll: true })
              updateBarMode()
            },
          })
        : el('button', { type: 'button', class: 'act', text: 'Reply', onclick: () => openSession(COMPANION_SESSION_ID) }),
      // The three verdicts that teach: "useful" raises the gate's confidence in
      // this kind of notice, "wrong" says the observation itself was false,
      // "not now" says the timing was wrong without disputing it. All three go
      // straight to the kernel as `feedback:verdict` — no model turn in
      // between, because a verdict is the owner's, not something to interpret.
      // (Not now used to be a chat turn the companion had to interpret into
      // the same signal; a tap that costs a model call is a tap nobody makes.)
      typeof frame.noticeKey === 'string' && frame.noticeKey !== ''
        ? verdictActs('notice', frame.noticeKey, {
            words: { useful: 'Marked useful.', 'not-now': 'Not now.', wrong: 'Marked wrong.' },
            onSettled: (verdict) => {
              for (const act of block.querySelectorAll('.act')) act.disabled = true
              if (verdict === 'not-now') block.remove()
            },
          })
        : el('button', {
            type: 'button',
            class: 'act',
            text: 'Not now',
            onclick: (event) => {
              event.currentTarget.disabled = true
              block.remove()
            },
          }),
    ]),
  ])
  canvas.querySelector('.empty')?.remove()
  stack().append(block)
  if (asking) unpromptedByAsk.set(frame.askId, [...(unpromptedByAsk.get(frame.askId) ?? []), block])
  follow()
}

function openLive() {
  const source = new EventSource('/gnomon/api/live')
  source.onmessage = (event) => {
    let frame = null
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    switch (frame.type) {
      case 'working':
        workingSteps = { jobId: frame.jobId, todos: Array.isArray(frame.todos) ? frame.todos : [] }
        drawJob()
        break
      case 'board':
        if (frame.board) applyBoard(frame.board)
        // The plan the owner edited comes back from the record; the model's next todo_write replaces it.
        if (frame.board?.plan) drawWorkPlan(frame.board.plan.steps)
        break
      case 'now':
        present = frame.now
        drawJob()
        if (present.lastSaid && lastSaid === null) lastSaid = { text: present.lastSaid, at: present.lastSaidAt }
        drawStrip()
        break
      case 'stale':
        // The record moved, and the frame says WHERE. `markStale` re-reads only
        // the cards on screen whose own reading is made of one of those tables;
        // this used to be every visible instrument on every 30-second pulse,
        // change or no change. Panes outside that registry (a lens) still take
        // the coarse beat, because a lens can read anything.
        markStale(frame.tables)
        document.dispatchEvent(new CustomEvent('gnomon:beat'))
        break
      case 'settings':
        // Changed here or in another tab: one place applies them.
        applySettings(frame.settings)
        break

      case 'ask':
        // The open question rides the live channel now; the poll is a fallback.
        if ((frame.open === null) !== (openAsk === null) || (frame.open !== null && frame.open.askId !== openAsk?.askId)) {
          openAsk = frame.open
          drawOpenAsk()
          drawWorkAsk(frame.open)
        }
        // Whatever this frame does NOT name is no longer open — answered in the
        // chat, in the seat, or expired — and every block that asked it settles.
        for (const askId of [...unpromptedByAsk.keys()]) {
          if (frame.open === null || frame.open.askId !== askId) settleUnprompted(askId, 'Answered.')
        }
        break
      case 'said':
        lastSaid = { text: frame.text, at: frame.at }
        drawStrip()
        drawCompanion()
        drawUnprompted(frame)
        break
      case 'noticed':
        // The observation itself, the moment it lands — before the model has
        // decided how to say it. The strip shows the fact; the words follow.
        lastSaid = { text: frame.text, at: frame.at }
        drawStrip()
        drawCompanion()
        break
      default:
        break
    }
  }
  // The browser reconnects an EventSource on its own after a restart. After the
  // session cookie ran out it never will, so ask which of the two it was.
  source.onerror = () => void checkSignedIn()
}

// ── Gnomon's own question ─────────────────────────────────────────────────
// packages/rules/src/owner-ask.ts has been able to ask the owner things for a
// while. Its first mouth was prose in a companion session, which meant the
// question only reached an owner who happened to be reading that session; its
// second was a card inside the Ask layer, which meant reaching a hotkey.
//
// Here it is structural: a seat in the shell grid, directly above the composer,
// on every view. There is at most one open question by construction and it
// expires after 24 hours, so it can simply sit there — and the composer beneath
// it IS the "something else", which is why that escape needs no card of its own.

const ASK_POLL_MS = 20_000
let openAsk = null

async function loadOpenAsk() {
  let next = null
  try {
    next = (await (await fetch('/gnomon/ask/open', { headers: { accept: 'application/json' } })).json())?.open ?? null
  } catch {
    // A failed poll is not an answered question. Hold what is on screen.
    return
  }
  if ((next === null) === (openAsk === null) && (next === null || next.askId === openAsk.askId)) return
  openAsk = next
  drawOpenAsk()
}

/**
 * Record an answer.
 *
 * Posts the same `ask:owner-answered` signal `gnomon_owner_answer` appends, so
 * a tap and a typed reply are one fact with one path through the reducer. The
 * seat clears optimistically: the fold is what makes it true, and leaving the
 * question up for twenty seconds would read as the tap not having worked.
 */
/**
 * UC1-X3: "Yes — tell me", "Moved — tell me when". A tap on one of these is
 * not the answer; it opens the box for it, and the words typed there answer
 * the same question.
 */
const tellsMore = (choice) => /— tell me( when)?$/i.test(choice)
function answerInComposer() {
  delete input.dataset.answering
  input.focus({ preventScroll: true })
  updateBarMode()
}

async function answerOpenAsk(text, { typed = false } = {}) {
  const ask = openAsk
  const answer = String(text ?? '').trim()
  if (ask === null || answer === '') return false
  for (const button of askSeat.querySelectorAll('button')) button.disabled = true
  try {
    await fetch('/gnomon/ask/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ askId: ask.askId, answer }),
    })
  } catch {
    // Nothing was recorded, so nothing should look recorded.
    drawOpenAsk()
    return false
  }
  settleUnprompted(ask.askId, `Answered: ${answer.length > 60 ? `${answer.slice(0, 59)}…` : answer}`)
  openAsk = null
  // The exchange moves up into the chat, and the seat leaves. A typed answer
  // is drawn by the turn that follows (as the owner's own said), so the block
  // carries the answer only when it was a tap.
  if (state.view === 'session') drawAsked(ask, typed ? null : answer)
  await leaveSeat()
  drawOpenAsk()
  return true
}

/** The seat sinks before it goes, so the eye can follow it up into the chat. */
function leaveSeat() {
  if (askSeat.hidden) return Promise.resolve()
  askSeat.setAttribute('data-leaving', '')
  return new Promise((resolve) => setTimeout(resolve, 220)).then(() => askSeat.removeAttribute('data-leaving'))
}

/**
 * The answered question, as a block in the chat. Not a turn — Gnomon asked,
 * the owner answered — so it sits between turns like an unprompted said, but
 * settled from the start: the question is a row that asks why it was asked,
 * and the foot offers to keep the answer or take it back.
 */
function drawAsked(ask, answer) {
  const when = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const loadQuestion = (question) => {
    input.dataset.answering = '0'
    input.value = question
    autosize()
    input.focus({ preventScroll: true })
    updateBarMode()
  }
  const block = el('section', { class: 'asked' }, [
    el('div', { class: 'asked-head' }, [el('span', { text: 'Gnomon asked' }), el('span', { class: 'asked-when', text: when })]),
    el('button', { type: 'button', class: 'asked-q row-ask', title: 'Ask why it asked', text: ask.question, onclick: () => loadQuestion(`Why did you ask me "${ask.question}"? What were you hoping to learn?`) }),
    ask.reason ? el('p', { class: 'asked-why', text: ask.reason }) : null,
    answer !== null ? el('div', { class: 'asked-a' }, [el('span', { class: 'asked-a-label', text: 'You' }), el('span', { text: answer })]) : null,
    el('div', { class: 'asked-foot' }, [
      el('button', { type: 'button', class: 'link', text: 'what did you keep?', onclick: () => loadQuestion('What did you keep from my answer just now?') }),
      el('button', { type: 'button', class: 'link', text: 'that was badly timed', onclick: () => loadQuestion('That question was badly timed. Ask me about meetings later in the day.') }),
    ]),
  ])
  state.turn = null
  state.prose = null
  stack().append(block)
  follow(true)
  return block
}

/**
 * Whether typing in the composer answers the open question. It does by default:
 * a question is on the screen and the owner replied, and asking them to first
 * declare "this is an answer" is a step nobody takes. `data-answering="0"` is
 * the owner having said "not an answer" for this message; it resets when the
 * question changes.
 */
function answeringNow() {
  return openAsk !== null && input.dataset.answering !== '0'
}

function drawOpenAsk() {
  delete input.dataset.answering
  if (openAsk === null) {
    askSeat.hidden = true
    askSeat.replaceChildren()
    updateBarMode()
    return
  }
  askSeat.hidden = false
  askSeat.replaceChildren(
    el('div', { class: 'ask-inner' }, [
      // A waiting ask has a turn paused on it: the owner should know Gnomon is
      // standing still, not merely curious.
      el('span', { class: 'ask-head', text: openAsk.waiting ? 'Gnomon asks, and waits' : 'Gnomon asks' }),
      el('p', { class: 'ask-q', text: openAsk.question }),
      el(
        'div',
        { class: 'ask-choices' },
        [
          ...openAsk.choices.map((choice) => el('button', { type: 'button', class: 'choice', text: choice, onclick: () => (tellsMore(choice) ? answerInComposer() : answerOpenAsk(choice)) })),
          el('button', {
            type: 'button',
            class: 'choice-own',
            text: openAsk.choices.length === 0 ? 'Answer below' : 'Something else',
            onclick: () => {
              // The composer is already the answer box; this only puts the
              // cursor in it. The choices are a shortcut and never a
              // constraint: a question whose real answer was not on the list is
              // exactly the question worth having asked.
              delete input.dataset.answering
              input.focus({ preventScroll: true })
              updateBarMode()
            },
          }),
        ],
      ),
      openAsk.reason ? el('p', { class: 'ask-why', text: openAsk.reason }) : null,
    ]),
  )
  updateBarMode()
}

/** Answering and asking are different acts, so the composer says which it is. */
function updateBarMode() {
  const answering = answeringNow()
  input.placeholder = state.running ? 'Taking too long? Say why, then Stop…' : answering ? 'Your answer…' : 'Talk to Gnomon…'
  send.textContent = state.running ? 'Stop' : answering ? 'Answer' : 'Say'
  send.title = state.running ? 'Stop this turn. Anything you have typed goes with it, so Gnomon knows what you wanted instead.' : ''
  const mode = $('bar-mode')
  mode.hidden = !answering
  if (answering) mode.querySelector('.bar-mode-text').textContent = `Answering: ${openAsk.question.length > 90 ? `${openAsk.question.slice(0, 89)}…` : openAsk.question}`
  if (answering) bar.setAttribute('data-answering', '')
  else bar.removeAttribute('data-answering')
}

// "Answer in the chat" on a Today or Left-for-you row: the conversation in
// front, the question in its seat, the cursor in the composer beneath it.
document.addEventListener('gnomon:answer', () => {
  showConversation()
  drawOpenAsk()
  input.focus({ preventScroll: true })
})

$('bar-mode-out').addEventListener('click', () => {
  // This one message is not an answer. The question stays open.
  input.dataset.answering = '0'
  input.focus({ preventScroll: true })
  updateBarMode()
})

// ── Paper ─────────────────────────────────────────────────────────────────
// The head's shortcut to one setting. It writes the same record the Settings
// card does, so the choice reaches every tab rather than this browser only.
const THEME_LABEL = { system: 'Auto', light: 'Light', dark: 'Dark' }

$('theme-toggle')?.addEventListener('click', () => {
  const next = nextPaper(SETTINGS.paper)
  fetch('/gnomon/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paper: next }) })
    .then((r) => (r.ok ? r.json() : null))
    .then((got) => got && applySettings(got))
    .catch(() => {})
})
$('summon-settings').addEventListener('click', () => {
  if (!has('settings')) pane('settings', { title: 'Settings', node: settingsNode() })
  focusPane('settings')
})

$('new-session').addEventListener('click', newSession)
$('select-toggle').addEventListener('click', () => setSelecting(!state.selecting))
$('archived-toggle').addEventListener('click', () => {
  state.showArchived = !state.showArchived
  state.picked.clear()
  $('act-delete').removeAttribute('data-arm')
  drawRail()
})
$('act-archive').addEventListener('click', () => archivePicked(!state.showArchived))
$('act-delete').addEventListener('click', deletePicked)
// Picking anything else disarms a pending delete.
rail.addEventListener('change', () => $('act-delete').removeAttribute('data-arm'))

onChange(markFoot)
markFoot()
setRunning(false)
loadSessions()
loadModels()
loadPermission()
// The conversation between the owner and Gnomon is ONE thread, and it is
// always open — a pinned card on the board beside the day.
// The settings first: the paper and whether anything may move are decided
// before the first frame is drawn, so nothing flashes the wrong way.
loadSettings()
openSession(COMPANION_SESSION_ID, { quiet: true })
  .then(showToday)
  .finally(() => {
    stripSited = true
    drawStrip()
  })
loadOpenAsk()
setInterval(loadOpenAsk, ASK_POLL_MS * 6)
openLive()
input.focus({ preventScroll: true })
