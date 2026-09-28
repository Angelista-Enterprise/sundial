// The board.
//
// One space, in depth. Every pane — the conversation, the day, an instrument,
// an entity, a figure Gnomon drew, a note it left — is a CARD with a place in
// the world (x, y, a size, and z: depth). The owner pans and zooms the camera,
// drags, resizes and removes; Gnomon does the same through `gnomon_board`.
// Both write the same `board:*` events through the kernel, so this file is a
// projection of `state.board` and never a second store: a drop is a POST, and
// what draws is whatever the live channel says the board is.
//
// Nothing is pinned: every card can go, and a card the owner removed stays
// gone across reloads. Only a FRESH board (no cards, no rows) seeds itself.
import { RETIRED, heirOf } from './cards.js'
import { el } from './surfaces.js'
import { icon } from './icons.js'
import { renderMarkdown } from './markdown.js'
import { lensNode, lensSpec } from './lens.js'
import { SETTINGS, settingsNode } from './settings.js'

const headers = { accept: 'application/json', 'content-type': 'application/json' }
const post = (body) => fetch('/gnomon/api/board', { method: 'POST', headers, body: JSON.stringify(body) }).catch(() => {})

/**
 * The stages a fresh board is born with, in the order you step through them.
 *
 * A plain vertical stack, and only the ORDER of `y` matters — the tiler
 * re-stacks every row from the top anyway. They used to carry a 2-D layout
 * (three rows sharing y = -420, two sharing y = 1180), and because a card
 * joins the row whose band holds it, overlapping bands sent Mood's card into
 * Kanban's row. Bands that do not overlap cannot be ambiguous.
 */
const SECTIONS = {
  today: { label: 'Today', x: 0, y: 0, w: 1200, h: 900, anchor: 'today' },
  // Where Gnomon works: the Work card per turn, and whatever it lays down while working.
  work: { label: 'Work', x: 0, y: 1000, w: 1200, h: 900, anchor: null },
  kanban: { label: 'Kanban', x: 0, y: 2000, w: 1700, h: 900, anchor: 'kanban' },
}
/**
 * The anchor card of each stage. Placed by the stage's NAME, never by x/y: a
 * coordinate has to be re-read against whatever the tiler did last, where a
 * name says which stage it belongs to and cannot drift.
 */
const DEFAULTS = {
  today: { id: 'today', kind: 'today', near: 'today', w: 1120, h: 800 },
  kanban: { id: 'kanban', kind: 'kanban', near: 'kanban', w: 1640, h: 800 },
  // The conversation lands beside Today, at a width that reads as a column.
  chat: { id: 'chat', kind: 'chat', near: 'today', w: 720, h: 800 },
}
const GAP = 12
export const ZOOM = [0.12, 1.8]

// ── Pure geometry ──────────────────────────────────────────────────────────

/** A camera that fits every rect, padded, never past 1:1 unless asked. */
export function fitCamera(rects, vw, vh, pad = 60, maxScale = 1) {
  if (rects.length === 0) return { x: 0, y: 0, s: 1 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  const s = Math.max(ZOOM[0], Math.min(maxScale, (vw - pad * 2) / (x1 - x0), (vh - pad * 2) / (y1 - y0)))
  return { x: (vw - (x1 - x0) * s) / 2 - x0 * s, y: (vh - (y1 - y0) * s) / 2 - y0 * s, s }
}

/** The first free place for a new card: to the right of everything, on the first row. (The rule places; this is the client's fallback for tests.) */
export function freeSpot(cards, w, h) {
  const all = Object.values(cards)
  if (all.length === 0) return { x: 0, y: 0 }
  const right = Math.max(...all.map((c) => c.x + c.w))
  return { x: right + GAP, y: 0, w, h }
}

/** Is at least `share` of the rect inside the viewport at this camera? */
export function visible(rect, cam, vw, vh, share = 0.6) {
  const x = rect.x * cam.s + cam.x
  const y = rect.y * cam.s + cam.y
  const w = rect.w * cam.s
  const h = rect.h * cam.s
  const ix = Math.max(0, Math.min(x + w, vw) - Math.max(x, 0))
  const iy = Math.max(0, Math.min(y + h, vh) - Math.max(y, 0))
  return (ix * iy) / (w * h) >= share
}

// ── State ──────────────────────────────────────────────────────────────────

const panes = new Map() // id → { id, title, frame, head, body, home, sticky, onFocus }
let board = { cards: {}, scenes: {}, sections: {}, focus: null, walk: null, updatedAt: null }
let cam = { x: 0, y: 0, s: 1 }
let seats = null
let ready = false
const queued = []
let focusedId = null
let top = 10
const selected = new Set()
const listeners = new Set()
let resolver = async () => null
let lastFocusAt = ''
let lastWalkAt = ''
let lastWalk = null
let lastNoticeAt = ''
/** A card to frame when the record next comes back: one just asked for, or one the owner moved by key. */
let follow = null

export const onChange = (fn) => listeners.add(fn)
export const focused = () => focusedId
export const has = (id) => panes.has(id) || id in board.cards
export const titleOf = (id) => panes.get(id)?.title ?? board.cards[id]?.text ?? id
/** What the record says this card is set to, or null. */
export const filtersOf = (id) => board.cards[id]?.filters ?? null
/** Every lens ever composed, by card id — including ones whose card is gone. */
export const lensShelf = () => board.lenses ?? {}
export const setResolver = (fn) => {
  resolver = fn
}
const notify = () => {
  document.body.dataset.focus = focusedId ?? ''
  // The front mark follows focus, in one place. A walk marks its own cards while it runs.
  if (seats) for (const f of seats.world.querySelectorAll('.pane')) f.toggleAttribute('data-front', f.dataset.pane === focusedId)
  for (const fn of listeners) fn({ focus: focusedId, cards: Object.keys(board.cards) })
}

// ── Mount ──────────────────────────────────────────────────────────────────

export async function mount({ board: viewport, world, tools, parked }) {
  seats = { viewport, world, tools, parked }
  drawTools()
  wireCamera()
  wireKeys()
  wireReframe()
  // Parallax: the plates lean a little with the pointer. Two numbers on the
  // board, read by the sheet; nothing else knows about it.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let raf = 0
    let lean = ''
    viewport.addEventListener('pointermove', (event) => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const r = viewport.getBoundingClientRect()
        // Two decimals, and only on a real change: these are inherited custom
        // properties, so every write re-styles every card on the board to tilt
        // three plates by a fraction of a degree.
        const px = ((event.clientX - r.left) / r.width - 0.5).toFixed(2)
        const py = ((event.clientY - r.top) / r.height - 0.5).toFixed(2)
        if (`${px} ${py}` === lean) return
        lean = `${px} ${py}`
        viewport.style.setProperty('--px', px)
        viewport.style.setProperty('--py', py)
      })
    })
  }
  try {
    const got = await (await fetch('/gnomon/api/board', { headers })).json()
    if (got && got.cards) board = got
  } catch {
    // The record could not be read: the defaults stand until it can.
  }
  ready = true
  applyBoard(board, { first: true })
  for (const id of queued) ensureCard(id)
}

// ── Panes (the frames) ─────────────────────────────────────────────────────

/** Register a pane's content. Ensures it has a card on the board. */
/** `park: true` registers the content without putting a card down; the card appears on the first focus. */
export function pane(id, { title, mark = null, node, home = null, sticky = false, onFocus = null, reading = '', park = false, near = null, text = null }) {
  let p = panes.get(id)
  if (p === undefined) {
    const head = el('div', { class: 'pane-head' }, [
      el('span', { class: 'pane-title' }),
      el('span', { class: 'pane-reading' }),
      el('span', { class: 'pane-acts' }, [
        el('button', { type: 'button', class: 'pane-act pane-say', title: 'Leave a remark on this card', 'aria-label': 'Remark', onclick: (e) => (e.stopPropagation(), openComment(id)) }),
        el('button', { type: 'button', class: 'pane-act pane-dock', title: 'Recede: push this card back into the depth', 'aria-label': 'Recede', onclick: (e) => (e.stopPropagation(), dockPane(id)) }),
        el('button', { type: 'button', class: 'pane-act pane-x', title: 'Remove from the board', 'aria-label': 'Remove', onclick: (e) => (e.stopPropagation(), dismissPane(id)) }),
      ]),
    ])
    const body = el('div', { class: 'pane-body' })
    const grip = el('div', { class: 'pane-resize', title: 'Resize' })
    // The owner's remark on this surface, under its head: what to fix, what
    // renders wrong. Part of the frame rather than the content, because it is
    // about the card, not in it.
    const remark = el('div', { class: 'pane-remark', hidden: true })
    const frame = el('article', { class: 'pane', 'data-pane': id, tabindex: '0' }, [head, remark, body, grip])
    wireCard(frame, head, grip, id)
    p = { id, frame, head, body, remark, home: null, sticky, onFocus: null, title }
    panes.set(id, p)
    seats.parked.append(frame)
  }
  p.title = title
  p.home = home
  p.onFocus = onFocus
  // A mark beside the name, never instead of it (see DESIGN.md, "The marks").
  // A card is recognised at a glance across a board of twenty; the word is
  // what says which one it is when two of them look alike.
  p.head.firstChild.replaceChildren(...(mark ? [icon(mark), el('span', { text: title })] : [el('span', { text: title })]))
  p.head.children[1].textContent = reading
  if (node && p.body.firstChild !== node) p.body.replaceChildren(node)
  p.near = near
  p.text = text
  if (park) return p
  if (!ready) queued.push(id)
  else ensureCard(id)
  return p
}
/** True when the record had no cards and no rows on first read: only then does registering a pane put a card down by itself. */
let fresh = false
/**
 * The rule: one card is always in focus — unless the owner stepped back to see
 * the whole board (Esc, ⌥F from a framed card, a row's name), which is fit-and-pan mode until the
 * next focus. When the focused card goes, focus moves to the most recently
 * visited card that is still there, else the first card of the first row.
 */
let panMode = false
function ensureFocus() {
  if (panMode || (focusedId !== null && focusedId in board.cards)) return
  const recent = lastVisited()
  const first = rowYs().length ? rowAt(rowYs()[0])[0] : undefined
  const next = recent ?? first?.id
  if (next) focusPane(next)
  else {
    focusedId = null
    notify()
  }
}

/**
 * The remark, as the record has it. A click on it opens the editor again, so
 * the line is its own affordance and the head's button is only for the first one.
 */
function drawRemark(id, comment) {
  const p = panes.get(id)
  if (p === undefined || p.remark === undefined) return
  p.remark.hidden = comment === null || comment === ''
  p.frame.toggleAttribute('data-remarked', !p.remark.hidden)
  if (p.remark.hidden) return
  if (p.remark.dataset.text === comment) return
  p.remark.dataset.text = comment
  p.remark.replaceChildren(el('button', { type: 'button', class: 'remark-text', title: 'Edit this remark', text: comment, onclick: () => openComment(id) }))
}

/**
 * Write, change or clear a remark. `prompt` on purpose: a remark is a rare,
 * one-line act, and an inline field would put an editor on every card head for
 * the sake of the few that ever carry one.
 */
function openComment(id) {
  const current = board.cards[id]?.comment ?? ''
  const next = prompt(`A remark on “${titleOf(id)}” — what to fix, what renders wrong. Empty clears it.`, current)
  if (next === null) return
  post({ action: 'place', id, comment: next.trim() })
}

export function setReading(id, text) {
  const p = panes.get(id)
  if (p) p.head.children[1].textContent = text
}

/**
 * A pane with no card yet asks the record for one. The RULE chooses the spot
 * (nearest free place to the wish, per-kind size floors), so the client never
 * guesses and two clients never disagree; the card draws when the `board`
 * frame comes back, a few milliseconds later.
 */
const asked = new Set()
/**
 * A fresh board is born with its stages, THEN its cards.
 *
 * In order, and awaited. Fired off together, the `place` posts raced the
 * `section` posts they depended on: a pane asking for `near: 'today'` before
 * the Today row existed had its wish resolve to nothing and landed in whatever
 * row was there, and the board came up as one giant stage holding everything.
 */
let seeding = null
/** Retired card ids already being replaced, so a burst of frames posts once. */
const retiring = new Set()
function seed() {
  seeding = (async () => {
    for (const [id, s] of Object.entries(SECTIONS)) await post({ action: 'section', id, ...s })
  })()
  for (const id of ['today', 'kanban']) ensureCard(id)
}
function ensureCard(id, { want = false } = {}) {
  if (id in board.cards) {
    place(id)
    return
  }
  // A pane registered at boot does not re-place a card the owner removed; a
  // pane the owner (or Gnomon) asks for now does.
  if (!want && !fresh) return
  if (asked.has(id)) return
  asked.add(id)
  // Every pane on a fresh board registers while the stages are still being
  // written, so the wish has to wait for the stage it names to exist.
  if (seeding !== null) void seeding.then(() => askFor(id))
  else askFor(id)
}
/** Ask the record for a place: in the stage this pane names, else where the owner is looking. */
function askFor(id) {
  const def = DEFAULTS[id]
  if (def) return void post({ action: 'place', id, kind: def.kind, near: def.near, w: def.w, h: def.h })
  const p = panes.get(id)
  const v = view()
  const wish = p?.near ? { near: p.near } : { x: Math.round((v.width / 2 - cam.x) / cam.s), y: Math.round((v.height / 2 - cam.y) / cam.s) }
  post({ action: 'place', id, kind: id.split(':')[0], ...wish, ...(p?.text ? { text: p.text } : {}) })
}

/** Put a card's frame where the board says. */
function place(id) {
  const card = board.cards[id]
  const p = panes.get(id)
  if (!card || !p) return
  if (p.frame.parentElement !== seats.world) seats.world.append(p.frame)
  const f = p.frame
  f.style.transform = `translate3d(${card.x}px, ${card.y}px, ${card.z}px)`
  f.style.width = `${card.w}px`
  f.style.height = `${card.h}px`
  f.style.setProperty('--depth', String(Math.max(0.35, 1 + card.z / 1400)))
  drawRemark(id, card.comment ?? null)
  f.dataset.by = card.by
  f.dataset.kind = card.kind
  f.toggleAttribute('data-back', card.z < -80)
}

/** A card leaving the board: its node goes home, or the frame is parked. */
function leave(id) {
  const p = panes.get(id)
  if (p === undefined) return
  if (p.home !== null && p.home.isConnected) {
    p.home.replaceWith(p.body.firstChild)
    p.frame.remove()
    panes.delete(id)
  } else seats.parked.append(p.frame)
  selected.delete(id)
  if (focusedId === id) focusedId = null
}

/** Build the pane for a card the record names but nobody has drawn yet. */
/**
 * What a card is set to, as chips in its head — a date, a tab, a query. Every
 * filter the card applies is shown, so the owner can see why it looks the way
 * it does, and clear it with one press (the same place event, filters null).
 */
function showFilters(id, card) {
  const p = panes.get(id)
  if (!p) return
  p.filtersKey = JSON.stringify(card?.filters ?? null)
  let strip = p.head.querySelector('.pane-filters')
  const entries = Object.entries(card?.filters ?? {})
  if (entries.length === 0) {
    strip?.remove()
    return
  }
  if (!strip) {
    strip = el('span', { class: 'pane-filters' })
    p.head.insertBefore(strip, p.head.lastChild)
  }
  strip.replaceChildren(
    ...entries.map(([k, v]) => el('span', { class: 'pane-filter', title: k }, [el('span', { text: v })])),
    el('button', { type: 'button', class: 'pane-filter-x', title: 'Clear what this card is set to', 'aria-label': 'Clear filters', text: '×', onclick: (e) => (e.stopPropagation(), post({ action: 'place', id, kind: card.kind, filters: null })) }),
  )
}

/** A card whose filters changed draws again with the new ones. */
async function refill(id, card) {
  const made = await resolver(id, card)
  if (made) pane(id, made)
  showFilters(id, card)
}

async function materialize(id, card) {
  if (panes.has(id)) return
  if (card.kind === 'note') {
    pane(id, { title: card.by === 'gnomon' ? 'Gnomon left a note' : 'Note', node: noteNode(id) })
    return
  }
  if (card.kind === 'web') {
    pane(id, { title: webTitle(id), node: webNode(id), reading: card.by === 'gnomon' ? 'placed by Gnomon' : '' })
    return
  }
  if (card.kind === 'browser') {
    pane(id, { title: 'Gnomon\'s browser', node: browserNode(id), reading: 'web task' })
    return
  }
  if (card.kind === 'settings') {
    pane(id, { title: 'Settings', node: settingsNode() })
    return
  }
  if (card.kind === 'lens') {
    // The spec is the card's text: a view Gnomon composed, drawn live (lens.js).
    const spec = lensSpec(card.text)
    pane(id, { title: spec?.title ?? 'Lens', node: spec ? lensNode(spec) : el('div', { class: 'none', text: 'This lens has no readable spec.' }), reading: 'lens' })
    return
  }
  const made = await resolver(id, card)
  if (made) pane(id, made)
  // A resolver may seat the pane ITSELF rather than hand one back — the
  // entity, moment and explore cards do, because they fill asynchronously from
  // a read tool and the pane has to exist while that read is in flight. The
  // fallback below used to overwrite those the instant they were seated, so an
  // entity card the record held drew "Nothing to show" over a pane that was
  // busy filling correctly. Ask the seats, not the record: `has()` cannot
  // answer this, because the card being IN the record is the reason we are here.
  else if (!panes.has(id)) {
    // A card the record has and nothing draws (a Work card before its first
    // tool call, a kind this client does not know) still takes its place in
    // the row — so it must be SEEN there, with its name and a remove act, not
    // left as an empty gap between two neighbours.
    pane(id, { title: card.text ?? id.split(':')[0], node: el('div', { class: 'none', text: `Nothing to show for this ${card.kind} card yet.` }), reading: card.by === 'gnomon' ? 'placed by Gnomon' : '' })
  }
  showFilters(id, card)
}

/**
 * A note reads as Markdown and edits as text: click the rendering to get the
 * field, leave the field to render again. Gnomon's explanations land here.
 */
function noteNode(id) {
  const field = el('textarea', { class: 'note-text', placeholder: 'Write here…', 'aria-label': 'Note', hidden: true })
  const view = el('div', { class: 'note-md', title: 'Click to edit' })
  const render = () => {
    const text = board.cards[id]?.text ?? ''
    view.replaceChildren(text.trim() === '' ? el('span', { class: 'none', text: 'Empty note — click to write.' }) : renderMarkdown(text))
    view.dataset.text = text
  }
  field.value = board.cards[id]?.text ?? ''
  field.addEventListener('change', () => post({ action: 'place', id, text: field.value }))
  field.addEventListener('blur', () => {
    field.hidden = true
    view.hidden = false
    render()
  })
  view.addEventListener('click', () => {
    field.value = board.cards[id]?.text ?? ''
    view.hidden = true
    field.hidden = false
    field.focus()
  })
  view.addEventListener('sync', render)
  render()
  return el('div', { class: 'note' }, [view, field])
}

const webUrl = (id) => id.slice(4)
/**
 * A page in Gnomon's own browser, live. The page streams in as Chrome repaints
 * it (`/gnomon/api/webview`), so a web task is watched as it happens, not read
 * as a row of screenshots. And it is the owner's to use: a click, a key, a
 * scroll on the picture goes to the page — which is how a login happens too,
 * right here, with no window of anything else. The card's text is the step
 * Gnomon just took. The picture is fitted whole into the card, never cropped.
 */
function browserNode(id) {
  const pageId = id.slice('browser:'.length)
  const step = el('p', { class: 'browser-step' })
  const address = el('span', { class: 'browser-url' })
  const status = el('span', { class: 'browser-status', text: 'connecting' })
  const shot = el('img', { class: 'browser-live', alt: 'The page, live in Gnomon\'s browser', draggable: 'false' })
  const view = el('div', { class: 'browser-view', tabindex: '0', 'aria-label': 'The page in Gnomon\'s browser. Click to use it; Escape to leave it.' }, [shot])
  let size = { width: 1280, height: 800 }

  // One input at a time, in order: a press must reach the page before its release.
  let queue = Promise.resolve()
  const post = (e) => {
    queue = queue.then(() => fetch('/gnomon/api/webinput', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pageId, ...e }) }).catch(() => {}))
  }
  const go = (type, text) => el('button', { type: 'button', class: 'link browser-go', text, onclick: () => post({ type }) })
  const head = el('div', { class: 'browser-head' }, [go('back', 'Back'), go('forward', 'Forward'), go('reload', 'Reload'), address, status])

  const sync = () => {
    const text = board.cards[id]?.text ?? ''
    step.textContent = text
    step.dataset.text = text
    step.hidden = text === ''
  }
  step.addEventListener('sync', sync)
  sync()

  let stream = null
  // The card was on the board and is gone: stop the page streaming. Checked on
  // a clock, because a still page sends no frame to check it on.
  let seen = false
  const watch = setInterval(() => {
    if (node.isConnected) seen = true
    else if (seen) {
      stream?.close()
      clearInterval(watch)
    }
  }, 3000)
  const open = () => {
    stream = new EventSource(`/gnomon/api/webview?page=${encodeURIComponent(pageId)}`)
    stream.onmessage = (event) => {
      const frame = JSON.parse(event.data)
      if (frame.type === 'frame') {
        shot.src = `data:image/jpeg;base64,${frame.data}`
        size = { width: frame.width, height: frame.height }
        status.textContent = 'live'
        node.dataset.state = 'live'
      } else if (frame.type === 'url') {
        address.textContent = frame.url
      } else if (frame.type === 'gone') {
        stream.close()
        clearInterval(watch)
        status.textContent = 'closed'
        node.dataset.state = 'gone'
        // A page lives only as long as Gnomon's server; a restart ends it.
        view.replaceChildren(el('p', { class: 'none browser-gone', text: 'This page is closed — Gnomon\'s browser was restarted. Ask Gnomon to open it again.' }))
      }
    }
    stream.onerror = () => {
      if (node.dataset.state === 'gone') return
      status.textContent = 'reconnecting'
    }
  }

  // The picture is letterboxed by `object-fit: contain`; a point on it maps to
  // the page by the fitted box, not the element's.
  const at = (event) => {
    const r = shot.getBoundingClientRect()
    const scale = Math.min(r.width / size.width, r.height / size.height)
    const left = r.left + (r.width - size.width * scale) / 2
    const top = r.top + (r.height - size.height * scale) / 2
    return { x: Math.round((event.clientX - left) / scale), y: Math.round((event.clientY - top) / scale) }
  }
  const mods = (e) => ({ alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })
  let held = false
  let lastMove = 0
  // Pointer events, stopped here: the board drags a card on pointerdown, and
  // that also cancels the mouse events a page press would otherwise make.
  let clicks = 0
  let lastDown = 0
  shot.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    e.stopPropagation()
    view.focus({ preventScroll: true })
    shot.setPointerCapture(e.pointerId)
    held = true
    clicks = Date.now() - lastDown < 400 ? clicks + 1 : 1
    lastDown = Date.now()
    post({ type: 'mousedown', ...at(e), clicks, ...mods(e) })
  })
  shot.addEventListener('pointerup', (e) => {
    e.stopPropagation()
    held = false
    post({ type: 'mouseup', ...at(e), clicks, ...mods(e) })
  })
  shot.addEventListener('pointermove', (e) => {
    if (Date.now() - lastMove < (held ? 30 : 120)) return
    lastMove = Date.now()
    post({ type: 'mousemove', ...at(e), held, ...mods(e) })
  })
  // The wheel scrolls the page, not the card around it.
  view.addEventListener('wheel', (e) => {
    e.preventDefault()
    e.stopPropagation()
    post({ type: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY })
  }, { passive: false })
  view.addEventListener('keydown', (e) => {
    // Escape hands the keyboard back to the board.
    if (e.key === 'Escape') return view.blur()
    e.stopPropagation()
    // ⌘V is left to the browser, so the paste event below carries the text.
    if (e.metaKey && e.key.toLowerCase() === 'v') return
    e.preventDefault()
    post({ type: 'key', key: e.key, code: e.code, ...mods(e) })
  })
  // Text that arrives without a key press — dictation, the emoji picker, an
  // input method — goes to the page too. Left alone, the browser handed it to
  // the chat's composer and a word meant for a site landed in the conversation.
  view.addEventListener('beforeinput', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.data) post({ type: 'paste', text: e.data })
  })
  view.addEventListener('paste', (e) => {
    e.preventDefault()
    post({ type: 'paste', text: e.clipboardData?.getData('text/plain') ?? '' })
  })

  const node = el('div', { class: 'browser', 'data-state': 'connecting' }, [head, step, view])
  // A timer, not a paint frame: a board in a background tab paints nothing.
  setTimeout(open, 0)
  return node
}

function webTitle(id) {
  try {
    return new URL(webUrl(id)).hostname.replace(/^www\./, '')
  } catch {
    return 'Web'
  }
}
/**
 * A page on the board: Gnomon's excerpt, the link, and a sandboxed frame that
 * tries to show the page itself. A site that refuses framing shows the
 * browser's own refusal inside the frame; the excerpt stays readable. Nothing
 * here fetches — the model fetched, the card shows.
 */
function webNode(id) {
  const url = webUrl(id)
  const excerpt = el('div', { class: 'web-excerpt' })
  const stamp = el('span', { class: 'web-stamp' })
  const sync = () => {
    const card = board.cards[id]
    const text = card?.text ?? ''
    excerpt.replaceChildren(text ? renderMarkdown(text) : el('span', { class: 'none', text: 'No excerpt.' }))
    excerpt.dataset.text = text
    // Provenance: who put this here and when it was read. A page card is a
    // reading of a page at a moment, and the page can change under it.
    stamp.textContent = card?.at ? `${card.by === 'gnomon' ? 'read by Gnomon' : 'opened'} ${new Date(card.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : ''
  }
  excerpt.addEventListener('sync', sync)
  sync()

  // A page GNOMON placed is not loaded until the owner asks: its URL came from
  // a model that reads untrusted text, and loading it would send whatever the
  // URL carries to that site with no click at all. A page the owner opened loads.
  const frame = el('iframe', { class: 'web-frame', sandbox: '', referrerpolicy: 'no-referrer', loading: 'lazy', title: `Page: ${url}` })
  const hold = el('button', { type: 'button', class: 'web-hold board-act', text: `Load ${(() => { try { return new URL(url).hostname } catch { return 'the page' } })()}` })
  const wrap = el('div', { class: 'web' }, [
    // The site's own bar, visually apart from the excerpt: domain first, because
    // that is what says whether to trust the words under it.
    el('div', { class: 'web-head' }, [
      el('span', { class: 'web-domain', text: (() => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } })() }),
      stamp,
      el('a', { class: 'web-link door', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'open ↗' }),
    ]),
    excerpt,
    frame,
    hold,
    el('p', { class: 'web-refused', text: 'This site refuses to be shown inside another page. The excerpt above is the reading; open it to see the page.' }),
  ])

  // A framed page that a site declines leaves a blank rectangle and no error a
  // script can catch — the owner read that blankness as the card being broken.
  // Nothing can ask the frame what happened (it is cross-origin and sandboxed
  // to nothing), so this watches the one thing observable from outside: whether
  // a load ever arrives. No answer within the timeout is treated as a refusal,
  // which is what it looks like from here and what the owner should do about it.
  const settle = (state) => {
    if (wrap.dataset.frame === 'loading') wrap.dataset.frame = state
  }
  frame.addEventListener('load', () => settle('loaded'))
  frame.addEventListener('error', () => settle('refused'))
  const load = () => {
    wrap.dataset.frame = 'loading'
    frame.src = url
    setTimeout(() => settle('refused'), 6000)
  }
  hold.addEventListener('click', load)
  if (board.cards[id]?.by === 'gnomon') wrap.dataset.frame = 'held'
  else load()
  return wrap
}

// ── The board, applied ─────────────────────────────────────────────────────

export function applyBoard(next, { first = false } = {}) {
  // WHEN the board is looking at, before anything is drawn with it. Gnomon can
  // wind the span as the owner can, so this fires for both hands; the listener
  // is in app.js, because re-reading is the reader's business, not the stage's.
  const spanWas = board?.span ? `${board.span.from}|${board.span.to}` : ''
  const spanNow = next?.span ? `${next.span.from}|${next.span.to}` : ''
  board = next
  if (!board.sections) board.sections = {}
  // `first` fires too, so the chips light on the span the board woke up in —
  // with the flag, because the listener must NOT re-read every card at boot;
  // they have not read once yet.
  if (first || spanNow !== spanWas) document.dispatchEvent(new CustomEvent('gnomon:span', { detail: { span: next.span ?? null, first } }))
  for (const id of Object.keys(board.cards)) asked.delete(id)
  // A card folded into another (cards.js RETIRED) makes way for its heir, in
  // its place: through the record, once — the next frame no longer holds it.
  for (const old of Object.keys(RETIRED)) {
    const card = board.cards[old]
    if (!card || retiring.has(old)) continue
    retiring.add(old)
    const heir = heirOf(old)
    void (async () => {
      await post({ action: 'remove', id: old })
      if (!(heir.id in board.cards)) await post({ action: 'place', id: heir.id, kind: heir.id, x: card.x, y: card.y, ...(heir.filters ? { filters: heir.filters } : {}) })
    })()
  }
  // A FRESH board is born with its rows and anchors. A board with cards but no
  // rows is one the owner emptied on purpose: every row is theirs to remove.
  if (first) fresh = Object.keys(board.sections).length === 0 && Object.keys(board.cards).length === 0
  if (first && fresh) void seed()
  for (const id of [...panes.keys()]) if (!(id in board.cards) && !DEFAULTS[id]) leave(id)
  for (const [id, card] of Object.entries(board.cards)) {
    if (panes.has(id)) {
      place(id)
      // A pane drawn before the board arrived (Today's parts at boot) has no key yet: it was drawn unfiltered.
      if ((panes.get(id).filtersKey ?? 'null') !== JSON.stringify(card.filters ?? null)) void refill(id, card)
      const note = panes.get(id).body.querySelector('.note-text')
      if (note && note !== document.activeElement && note.value !== (card.text ?? '')) note.value = card.text ?? ''
      // The rendered text follows the record, unless the owner is mid-edit.
      if (!note || note.hidden) {
        for (const md of panes.get(id).body.querySelectorAll('.note-md, .web-excerpt')) if (md.dataset.text !== (card.text ?? '')) md.dispatchEvent(new Event('sync'))
      }
    } else materialize(id, card)
  }
  if (follow !== null && board.cards[follow]) {
    // A card that just landed, or one the owner moved by key: the camera goes to it.
    const id = follow
    follow = null
    focusPane(id)
  }
  if (!first) ensureFocus()
  if (board.focus && board.focus.at !== lastFocusAt && !first) {
    lastFocusAt = board.focus.at
    // Focus follows what Gnomon shows, so the rest of the page (the floating
    // conversation above all) knows the view left the card it was on. One card
    // frames like any focus; several fit together, the first one holding focus.
    const shown = board.focus.ids.filter((id) => id in board.cards)
    if (shown.length === 1) focusPane(shown[0])
    else {
      fitTo(board.focus.ids)
      if (shown.length > 0) {
        panMode = false
        focusedId = shown[0]
        visit(shown[0])
        notify()
      }
    }
    for (const id of board.focus.ids) panes.get(id)?.frame.toggleAttribute('data-front', true)
    // The words are in the chat (the tool call draws there); the board only points.
    mark(board.focus.ids)
  }
  // A notice Gnomon raised. Same shape as focus and walk: the record carries
  // the last one with its stamp, and a NEW stamp is what raises the row — so a
  // reload does not replay a notice the owner already read.
  // A notice's words, like a walk's, are drawn in the chat by the tool call
  // that raised it: the chat is Gnomon's one voice. The stamp is only kept.
  if (board.notice && board.notice.at !== lastNoticeAt && !first) lastNoticeAt = board.notice.at
  if (board.walk && board.walk.at !== lastWalkAt && !first) {
    lastWalkAt = board.walk.at
    // A walk that only grew (a live step) points at its newest step; a new walk at its first.
    const grown = lastWalk !== null && board.walk.steps.length > lastWalk.steps.length && lastWalk.steps.every((step, k) => step.text === board.walk.steps[k]?.text)
    const step = grown ? board.walk.steps.at(-1) : board.walk.steps[0]
    lastWalk = board.walk
    if (step) pointAt(step.ids)
  }
  if (first) {
    lastFocusAt = board.focus?.at ?? ''
    lastWalkAt = board.walk?.at ?? ''
    lastNoticeAt = board.notice?.at ?? ''
    // Land on the first card of the first row, at full height; an empty board shows itself whole.
    // A tick later, so the head and tools have their measured size. A timer,
    // not requestAnimationFrame: a tab opened in the background gets no frames
    // until it is looked at, and would sit with nothing in focus.
    setTimeout(() => {
      // Where this seat left off, if that card is still there; else the start.
      const back = lastVisited()
      const first = rowYs().length ? rowAt(rowYs()[0])[0] : undefined
      const to = back ?? first?.id
      // No glide on arrival. The camera starts at the origin and this is the
      // first thing that moves it, so an animated move reads as the page
      // sliding into place after it has already drawn — the owner watching
      // their board pan away from them for no reason.
      if (to) focusPane(to, { animate: false })
      else fitAll({ animate: false })
    }, 0)
  }
  drawTools()
  notify()
}

/** Frame the camera on a section. */
export function fitSection(id) {
  const s = board.sections?.[id]
  if (!s) return
  const v = view()
  setCamera(fitCamera([rowBox(s)], v.width, v.height, 24))
  panMode = true
  focusedId = null
  notify()
}

/**
 * The box a row draws: its own rect, grown to hold every card standing in it.
 * ponytail: the record keeps the row where the owner put it; resizing a card
 * only changes what it has to cover, so that is worked out here and not stored.
 */
function rowBox(s) {
  const pad = 16
  // Overlap, not centre: a card being resized grows past the stored rect, and
  // a centre test would drop it out of its own row halfway through the drag.
  const inside = Object.values(board.cards).filter((c) => c.x < s.x + s.w && c.x + c.w > s.x && c.y < s.y + s.h && c.y + c.h > s.y)
  if (inside.length === 0) return s
  const x = Math.min(s.x, ...inside.map((c) => c.x - pad))
  const y = Math.min(s.y, ...inside.map((c) => c.y - pad))
  return {
    x,
    y,
    w: Math.max(s.x + s.w, ...inside.map((c) => c.x + c.w + pad)) - x,
    h: Math.max(s.y + s.h, ...inside.map((c) => c.y + c.h + pad)) - y,
  }
}

// ── What Gnomon says about what you see ────────────────────────────────────
// A caption is a thin row that arrives on the board, gone after a while. A walk is steps
// the owner pages through: each fits some cards and says one thing. Both are
// Gnomon's voice, so they take the ochre rule.

/** How long a caption stands. The drain strip along its foot shows this running out. */
const CAPTION_MS = 5000
/** The band's apparent size, in SCREEN pixels. Its world size is derived from the camera. */
const CAPTION_H = 54
const CAPTION_GAP = 10

/**
 * A caption is a thin row that arrives on the board.
 *
 * Not a panel floating over it: it opens a band of space at the top of what
 * the owner is looking at, drops into it from above, and closes the space
 * behind it when it goes. The space is made by the CAMERA, not by moving any
 * card — a five-second notice must not write thirty card moves into the log,
 * and the record is the only thing that says where a card lives.
 *
 * It is a world object, so it belongs to the board and pans with it, but it is
 * SIZED from screen pixels through the camera's scale, so it reads the same at
 * any zoom. A notice that cannot be read has failed at the one thing it does.
 *
 * It is not a card, so `rowYs`/`neighbour` never see it: ⌥ arrows step over it
 * to the real rows. `placeBand` runs on every camera paint, so it stays where
 * the owner is looking for as long as it lives.
 */
let band = null
let captionTimer = 0

function placeBand() {
  if (band === null || seats === null) return
  const v = view()
  const { head } = insets(v)
  const s = cam.s
  band.node.style.transform = `translate(${(12 - cam.x) / s}px, ${(head + CAPTION_GAP - cam.y) / s}px)`
  band.node.style.width = `${Math.max(80, v.width - 24) / s}px`
  band.node.style.height = `${CAPTION_H / s}px`
  // Everything inside is written in these units, so the band's apparent size
  // and type do not change with the zoom.
  band.node.style.setProperty('--band', String(1 / s))
}

/**
 * Raise a notice.
 *
 * `ms: 0` stands until answered or dismissed, and shows no drain strip —
 * there is nothing running out. `actions` are the owner's replies: pressing one
 * closes the row and says that text to Gnomon in the owner's own voice, through
 * a `gnomon:say` event that app.js turns into an ordinary turn. The band does
 * not know what a session is, and does not need to.
 */
export function notice({ text, kind = 'say', actions = [] } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return
  document.dispatchEvent(new CustomEvent('gnomon:point', { detail: { text, kind, actions } }))
}


/**
 * Give the space back.
 *
 * The camera only returns if it is still where the band left it. If the owner
 * has panned, zoomed or framed a card since, that view is THEIRS — pulling it
 * back by 64 pixels because a notice expired would be the board moving under
 * their hand for a reason they cannot see.
 */
function closeBand({ instant = false } = {}) {
  if (band === null) return
  const { node, lift, camY } = band
  band = null
  clearTimeout(captionTimer)
  if (Math.abs(cam.y - camY) < 2) setCamera({ ...cam, y: cam.y - lift }, !instant)
  if (instant) return void node.remove()
  node.setAttribute('data-gone', '')
  setTimeout(() => node.remove(), 320)
}

/** When the owner last touched the board — a touch holds a light step that would otherwise go on by itself. */
let touchedAt = 0
const touch = () => {
  touchedAt = performance.now()
}
export const touchedSince = (t) => touchedAt > t

/**
 * Show the owner where Gnomon is pointing: frame the card (several fit
 * together), and edge them in ochre for a moment. A card Gnomon names that is
 * not on the board is put down first — a step that points at nothing used to
 * read "today is not on the board" and sit still.
 */
export function pointAt(ids) {
  const want = (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id !== '')
  const here = want.filter((id) => id in board.cards)
  for (const id of want) if (!(id in board.cards)) ensureCard(id, { want: true })
  if (here.length === 1) focusPane(here[0])
  else if (here.length > 1) {
    fitTo(here)
    panMode = false
    focusedId = here[0]
    visit(here[0])
    notify()
  } else if (want.length > 0) follow = want[0]
  mark(want)
}
/** The ochre edge on the cards being talked about; it fades on its own. */
const MARK_MS = 2400
function mark(ids) {
  for (const id of ids ?? []) {
    const frame = panes.get(id)?.frame
    if (!frame) continue
    frame.setAttribute('data-pointed', '')
    clearTimeout(frame._pointTimer)
    frame._pointTimer = setTimeout(() => frame.removeAttribute('data-pointed'), MARK_MS)
  }
}
/** The owner has caught up with a live walk: Gnomon's waiting step call returns. */
export const walkContinue = () => post({ action: 'continue' })

// ── Camera ─────────────────────────────────────────────────────────────────

/**
 * The camera writes ONCE per frame.
 *
 * A pan fires a pointermove per pointer report and a wheel event per notch —
 * several times the screen's refresh. Each old write set `--zoom` on the
 * board, which invalidates the opacity of EVERY card, and re-read the hint
 * node out of the DOM. So a drag across the board cost a full style pass per
 * event instead of per frame. Now the gesture only records where the camera
 * should be; this paints it.
 */
let camRaf = 0
let camAnimate = true
let hintNode = null
let lastScale = -1
let restTimer = 0
function paintCamera() {
  camRaf = 0
  seats.viewport.classList.toggle('no-anim', !camAnimate)
  seats.world.style.transform = `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.s})`
  // A live notice band keeps its place at the top of what the owner is looking
  // at, whatever the camera does — including the move that made room for it.
  placeBand()
  // Zoom does not change while panning, and these two are the expensive half.
  if (cam.s !== lastScale) {
    lastScale = cam.s
    seats.viewport.style.setProperty('--zoom', String(cam.s))
    if (hintNode === null || !hintNode.isConnected) hintNode = seats.tools.querySelector('.board-hint')
    if (hintNode) hintNode.textContent = hintText()
  }
  // Glass is the board's single hottest cost: a backdrop blur is re-sampled
  // every frame the camera moves, for a card that is sliding past anyway. It
  // is off while the camera travels and comes back when it rests.
  seats.viewport.classList.add('moving')
  clearTimeout(restTimer)
  restTimer = setTimeout(() => seats.viewport.classList.remove('moving'), camAnimate ? 560 : 140)
}
function setCamera(next, animate = true) {
  cam = { x: next.x, y: next.y, s: Math.max(ZOOM[0], Math.min(ZOOM[1], next.s)) }
  camAnimate = animate
  // A tab nobody is looking at gets no frames, so the first camera move of a
  // background boot would never land. Those are the un-animated ones.
  if (!animate && document.hidden) return void paintCamera()
  if (!camRaf) camRaf = requestAnimationFrame(paintCamera)
}
/** The viewport, minus the ghost when it is open: the camera fits into what the owner can see. */
const view = () => {
  const r = seats.viewport.getBoundingClientRect()
  // The conversation is a card now, so nothing covers the board's edge.
  const covered = 0
  return { left: r.left, top: r.top, width: Math.max(200, r.width - covered), height: r.height }
}
const hintText = () => `${Math.round(cam.s * 100)}% · two fingers step · ⌘ scroll zooms · ⌥ arrows focus · ⌥⇧ arrows move · ⌥R width · ⌥W close · ⌥F frame or back · ⌥C chat · Esc all`

export function fitAll({ animate = true } = {}) {
  const v = view()
  setCamera(fitCamera(Object.values(board.cards), v.width, v.height), animate)
  panMode = true
  focusedId = null
  notify()
}

/**
 * One card at the screen's full height, niri-style: the row's height becomes
 * the view's. A card wider than the screen sits at the left edge and the rest
 * is a pan away; a narrower one is centred.
 */
/** What floats over the board takes its share: the head above, the tools below. */
const insets = (v) => ({
  // The head is hidden on the board, so the strip standing in for it is what a
  // framed card has to keep clear of — measure whichever one is actually there.
  head: Math.max(
    document.querySelector('.head')?.offsetHeight ?? 0,
    seats.viewport.querySelector(':scope > .strip-home')?.getBoundingClientRect().bottom - v.top || 0,
  ),
  foot: seats.tools ? Math.max(0, v.height - (seats.tools.getBoundingClientRect().top - v.top)) : 0,
})

/**
 * The zoom a framed card gets: 1:1, and only ever less than that.
 *
 * Fitting on HEIGHT is what made framed text lie about its size — the same
 * card rendered at 86% on a short window and 110% on a tall one, and a glyph
 * drawn at 13px and painted at 11.2px is the soft, smeared text of 2026-09-16.
 * The card's body scrolls; its type does not. Width is the one thing still
 * allowed to scale it down, because a card running off the right edge reads as
 * broken, where a card running off the bottom reads as more to scroll.
 *
 * Shared, so `framed` agrees with `frameCard`.
 */
const fitScale = (card, v, pad) => Math.max(ZOOM[0], Math.min(1, (v.width - pad * 2) / card.w))
/**
 * Where a framed card sits. It is centred in the space it has — but a card
 * TALLER than that space is pinned to the top instead, so its head and the
 * first line of it are on screen. Centring an overlong card hides both ends.
 */
const framePos = (card, v, { head, foot }, pad, s) => ({
  x: Math.round(Math.max(pad, (v.width - card.w * s) / 2) - card.x * s),
  y: Math.round(head + pad + Math.max(0, (v.height - head - foot - pad * 2 - card.h * s) / 2) - card.y * s),
})

function frameCard(id, animate = true) {
  const card = board.cards[id]
  if (!card) return
  const v = view()
  const pad = 8
  const s = fitScale(card, v, pad)
  setCamera({ ...framePos(card, v, insets(v), pad, s), s }, animate)
}
/** Is this card already filling the view — i.e. would `frameCard` do nothing? */
function framed(id) {
  const card = board.cards[id]
  if (!card) return false
  const v = view()
  const want = fitScale(card, v, 8)
  const at = framePos(card, v, insets(v), 8, want)
  return Math.abs(cam.s - want) < 0.01 && Math.abs(cam.y - at.y) < 2
}

/**
 * The space the board has changed shape: whatever is in focus fills it again.
 *
 * The window resizing is one way. The chat is the other — it slides in over the
 * board's right edge, and `view()` already hands the camera the narrower space,
 * but nothing was asking the camera to use it. So opening the chat left the
 * card it covered sitting half under the panel.
 *
 * Called at the START of the slide, not at its end: the ghost's width is a
 * layout width and a transform does not change it, so the answer is already
 * right, and the card and the panel then travel together on one movement.
 */
let reframe = 0
export function refit() {
  if (focusedId === null) return
  // A timer, not `requestAnimationFrame`: a frame callback is throttled to
  // nothing while the window is not painting, and the refit would then sit
  // pending until the owner came back — which also blocked the NEXT one behind
  // its own guard. Resizing fires a burst and needs coalescing; a slide fires
  // once. A zero timeout covers both and does not depend on a frame.
  clearTimeout(reframe)
  reframe = setTimeout(() => {
    if (focusedId !== null && board.cards[focusedId]) frameCard(focusedId)
  }, 0)
}
function wireReframe() {
  window.addEventListener('resize', refit)
}

export function fitTo(ids, maxScale = 1) {
  const rects = ids.map((id) => board.cards[id]).filter(Boolean)
  if (rects.length === 0) return false
  const v = view()
  const { head, foot } = insets(v)
  const cam = fitCamera(rects, v.width, v.height - head - foot, 40, maxScale)
  setCamera({ ...cam, y: cam.y + head })
  return true
}

/**
 * One card along, in a direction. The keys and the trackpad both come here, so
 * a swipe and ⌥→ can never disagree about what "the next card" means.
 */
function step(dir) {
  const id = focusedId ?? [...selected][0] ?? null
  const card = id === null ? undefined : board.cards[id]
  // Nothing in focus yet: the first move lands on the first card of the first row.
  if (!card) {
    const first = rowAt(rowYs()[0] ?? 0)[0]
    return void (first && focusPane(first.id))
  }
  const other = neighbour(card, dir)
  if (!other) return
  // The lean is let go before the jump: the camera move is the animation.
  setPull(0, 0, 0)
  focusPane(other.id)
}

/**
 * A two-finger swipe steps card to card, the way a desktop steps between
 * spaces — one jump per gesture, never a free drift.
 *
 * A scroll inside a card and a step of the board are the same gesture, so one
 * of them has to give way. The rule every platform settled on is LATCHING:
 * whoever takes the first pixel of a gesture keeps the whole of it. A list that
 * reaches its end therefore holds the rest of that push — that is why scrolling
 * to the bottom does not throw you out of the card — and only a NEW push, made
 * from the end, reaches the board. Pull-to-refresh and Chrome's back-swipe both
 * work this way, and it is what `overscroll-behavior: contain` does for a plain
 * scroller.
 *
 * On a trackpad "a new push" cannot be read from the fingers, only inferred:
 * momentum after a flick only ever DECAYS, so a delta that grows again is a
 * hand that pushed again. That, plus a rest of `SWIPE_REST`, ends a gesture.
 */

/** Room left in this box the way the fingers are going. One pixel of slack for rounding. */
function roomOn(box, dx, dy) {
  if (box === null) return false
  const down = Math.abs(dy) >= Math.abs(dx)
  const [pos, size, client] = down ? [box.scrollTop, box.scrollHeight, box.clientHeight] : [box.scrollLeft, box.scrollWidth, box.clientWidth]
  if (size - client < 1) return false
  return (down ? dy : dx) > 0 ? pos < size - client - 1 : pos > 1
}

/** True once a card has taken this gesture: it keeps it until the gesture ends. */
let latched = false
let gestureMag = 0
let gestureIdle = 0
/** The fingers lifted (or pushed afresh): everything a gesture was holding is let go. */
function endGesture() {
  latched = false
  gestureMag = 0
  swipeX = 0
  swipeY = 0
  swipeSpent = false
  setPull(0, 0, 0)
}
/** Call for every wheel event that is not a zoom. True when this one starts a new push. */
function gestureTick(dx, dy) {
  const mag = Math.abs(dx) + Math.abs(dy)
  const fresh = mag > gestureMag * 1.5 && mag > 6
  clearTimeout(gestureIdle)
  gestureIdle = setTimeout(endGesture, SWIPE_REST)
  if (fresh) endGesture()
  gestureMag = mag
  return fresh
}

/**
 * The lean on the card you are about to leave. `t` is how far along the gesture
 * is, 0 to 1; the sheet spends it on the lean and on letting the card go quiet.
 * While `data-pull` is set the lean tracks the fingers with no transition; the
 * moment it comes off, the card springs home on its own curve.
 */
let pulled = null
const frameOf = (id) => (id === null ? null : (panes.get(id)?.frame ?? null))
function setPull(px, py, t) {
  const frame = frameOf(focusedId)
  if (pulled !== null && pulled !== frame) clearPull(pulled)
  pulled = frame
  if (frame === null) return
  if (t === 0) return void clearPull(frame)
  frame.dataset.pull = ''
  frame.style.setProperty('--pull-x', `${px}px`)
  frame.style.setProperty('--pull-y', `${py}px`)
  frame.style.setProperty('--pull-t', String(t))
}
/** Let the lean go. Removing `data-pull` is what plays the spring back to nothing. */
function clearPull(frame) {
  frame.removeAttribute('data-pull')
  frame.style.removeProperty('--pull-x')
  frame.style.removeProperty('--pull-y')
  frame.style.removeProperty('--pull-t')
}

const SWIPE_STEP = 80
const SWIPE_REST = 140
let swipeX = 0
let swipeY = 0
let swipeSpent = false
function swipeBy(dx, dy) {
  swipeX += dx
  swipeY += dy
  if (swipeSpent) return
  // The bigger axis wins outright: a swipe that drifts is still one direction.
  const flat = Math.abs(swipeX) >= Math.abs(swipeY)
  const reach = flat ? swipeX : swipeY
  // The card leans the way you are pushing, further the closer you get, so the
  // jump is something you watch arrive instead of something that happens to you.
  // Let go short of the edge and it springs back — the lean IS the warning.
  // Kept to a few pixels on purpose: at 26px it read as the card sliding away,
  // which is a second animation fighting the camera's own glide.
  const lean = -Math.sign(reach) * Math.min(6, Math.abs(reach) * 0.08)
  setPull(flat ? lean : 0, flat ? 0 : lean, Math.min(1, Math.abs(reach) / SWIPE_STEP))
  if (Math.abs(reach) < SWIPE_STEP) return
  swipeSpent = true
  swipeX = 0
  swipeY = 0
  step(flat ? (reach > 0 ? 'right' : 'left') : reach > 0 ? 'down' : 'up')
}

function wireCamera() {
  const vp = seats.viewport
  // ponytail: no drag-to-pan. The wheel pans, ⌘+wheel zooms, ⌥arrows focus.
  const onSpace = (t) => t === vp || t === seats.world
  vp.addEventListener('pointerdown', touch)
  vp.addEventListener('wheel', touch, { passive: true })
  vp.addEventListener(
    'wheel',
    (e) => {
      // Zoom is the owner's, wherever the pointer happens to be.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const v = view()
        const px = e.clientX - v.left
        const py = e.clientY - v.top
        const s = Math.max(ZOOM[0], Math.min(ZOOM[1], cam.s * Math.exp(-e.deltaY * 0.0022)))
        // Zoom about the pointer: the world point under it stays under it.
        const wx = (px - cam.x) / cam.s
        const wy = (py - cam.y) / cam.s
        return void setCamera({ x: px - wx * s, y: py - wy * s, s }, false)
      }
      gestureTick(e.deltaX, e.deltaY)
      // Latching: a card that can still scroll takes the gesture and keeps it
      // to the end of the push, so arriving at the bottom of a list never
      // throws you out of the card. Lift, push again, and the board answers.
      // The nearest scroller, which is not always the card's body: a drill (the
      // detail laid over a card) scrolls itself, and while one is open the body
      // under it is deliberately held still. Matching only `.pane-body` meant a
      // wheel inside an open drill found a box with no room and was spent
      // swiping to the next card instead of scrolling the list under the hand.
      // The chat card's transcript and thread list scroll inside a body that does not.
      // Any inner list that can still move (a Kanban column) takes it first; it
      // was not on the list above, so a wheel over a column swiped the board.
      const body = innerScroller(e.target, e.deltaX, e.deltaY) ?? e.target.closest('.drill, .ghost > .canvas, .thread-picker, .pane-body')
      if (body !== null) {
        if (roomOn(body, e.deltaX, e.deltaY)) {
          latched = true
          return
        }
        if (latched) return
      }
      e.preventDefault()
      swipeBy(e.deltaX, e.deltaY)
    },
    { passive: false },
  )
  vp.addEventListener('dblclick', (e) => onSpace(e.target) && fitAll())

}

/** The nearest element inside a card, below its body, that scrolls and has room to go this way. */
function innerScroller(target, dx, dy) {
  for (let n = target instanceof Element ? target : null; n && !n.matches('.pane-body, .drill, .pane'); n = n.parentElement) {
    const style = getComputedStyle(n)
    const scrolls = (/(auto|scroll)/.test(style.overflowY) && n.scrollHeight > n.clientHeight) || (/(auto|scroll)/.test(style.overflowX) && n.scrollWidth > n.clientWidth)
    if (scrolls && roomOn(n, dx, dy)) return n
  }
  return null
}

/** Zoom about the middle of the visible board. */
function zoomBy(factor) {
  const v = view()
  const px = v.width / 2
  const py = v.height / 2
  const s = Math.max(ZOOM[0], Math.min(ZOOM[1], cam.s * factor))
  const wx = (px - cam.x) / cam.s
  const wy = (py - cam.y) / cam.s
  setCamera({ x: px - wx * s, y: py - wy * s, s })
}

// ── Cards: drag, resize, select ────────────────────────────────────────────

/**
 * A card under the hand moves once per frame. It also no longer redraws the
 * rows: a row is drawn from `board.sections`, which a drag does not touch, so
 * rebuilding every row's DOM per pointer event was pure waste.
 */
let dragRaf = 0
function nudge(id) {
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0
    place(id)
    // The row a card stands in grows with it while the grip is still down —
    // waiting for the record to come back made the box look stuck.
    // ponytail: a full redraw of a handful of row boxes, once a frame. Diff
    // them if a board ever carries dozens of rows.
  })
}

function wireCard(frame, head, grip, id) {
  let drag = null
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.pane-act')) return
    const card = board.cards[id]
    if (!card) return
    drag = { x: e.clientX, y: e.clientY, ox: card.x, oy: card.y }
    head.setPointerCapture(e.pointerId)
    frame.classList.add('dragging')
    raise(id)
    if (e.shiftKey) toggleSelect(id)
    else if (!selected.has(id)) select(id)
  })
  head.addEventListener('pointermove', (e) => {
    if (drag === null) return
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) frame.setAttribute('data-dragged', '')
    const card = board.cards[id]
    card.x = drag.ox + (e.clientX - drag.x) / cam.s
    card.y = drag.oy + (e.clientY - drag.y) / cam.s
    nudge(id)
  })
  const drop = () => {
    if (drag === null) return
    drag = null
    frame.classList.remove('dragging')
    const card = board.cards[id]
    post({ action: 'move', id, x: Math.round(card.x), y: Math.round(card.y) })
    // The click that ends a drag is not a click on the card.
    setTimeout(() => frame.removeAttribute('data-dragged'), 0)
  }
  head.addEventListener('pointerup', drop)
  head.addEventListener('pointercancel', drop)
  head.addEventListener('dblclick', (e) => !e.target.closest('.pane-act') && focusPane(id))

  let size = null
  grip.addEventListener('pointerdown', (e) => {
    const card = board.cards[id]
    if (!card) return
    size = { x: e.clientX, y: e.clientY, w: card.w, h: card.h }
    grip.setPointerCapture(e.pointerId)
    frame.classList.add('dragging')
    e.stopPropagation()
  })
  grip.addEventListener('pointermove', (e) => {
    if (size === null) return
    const card = board.cards[id]
    card.w = Math.max(160, size.w + (e.clientX - size.x) / cam.s)
    card.h = Math.max(100, size.h + (e.clientY - size.y) / cam.s)
    nudge(id)
  })
  const grow = () => {
    if (size === null) return
    size = null
    frame.classList.remove('dragging')
    const card = board.cards[id]
    post({ action: 'move', id, w: Math.round(card.w), h: Math.round(card.h) })
  }
  grip.addEventListener('pointerup', grow)
  grip.addEventListener('pointercancel', grow)
  frame.addEventListener('focusin', () => raise(id))
  // A click on a card that is only partly in view frames it. A card already in
  // view is left alone, so working inside it never moves the camera.
  frame.addEventListener('click', (e) => {
    // A board link inside the card goes somewhere else: this click must not
    // then frame and focus the card it sat in, which pulled the camera
    // straight back ("2 wait for you" did nothing, 2026-09-24).
    if (e.target.closest('.pane-act, .pane-resize, .board-link') || frame.hasAttribute('data-dragged')) return
    const card = board.cards[id]
    const v = view()
    if (card && !visible(card, cam, v.width, v.height, 0.92)) fitTo([id])
    // A click is a visit like any other. It used to set `focusedId` behind the
    // trail's back, so the board remembered only where the KEYS had been —
    // which is why coming back from the whole board landed on a card the owner
    // had not touched in a while. It also leaves pan mode, for the same reason.
    panMode = false
    focusedId = id
    visit(id)
    raise(id)
    notify()
  })
}

/** In front: on top of the stack, and forward out of the depth if it had receded. */
function raise(id) {
  const p = panes.get(id)
  if (p) p.frame.style.zIndex = String(++top)
  const card = board.cards[id]
  if (card && card.z < 0) post({ action: 'move', id, z: 0 })
}
function select(id) {
  clearSelection()
  selected.add(id)
  panes.get(id)?.frame.setAttribute('data-selected', '')
  drawTools()
}
function toggleSelect(id) {
  if (selected.has(id)) {
    selected.delete(id)
    panes.get(id)?.frame.removeAttribute('data-selected')
  } else {
    selected.add(id)
    panes.get(id)?.frame.setAttribute('data-selected', '')
  }
  drawTools()
}
function clearSelection() {
  for (const id of selected) panes.get(id)?.frame.removeAttribute('data-selected')
  selected.clear()
  drawTools()
}

// ── The tools row ──────────────────────────────────────────────────────────

function drawTools() {
  if (!seats) return
  const n = selected.size
  const scenes = Object.keys(board.scenes)
  const act = (text, title, onclick, disabled = false) => el('button', { type: 'button', class: 'board-act', text, title, disabled, onclick })
  const sceneField = el('input', { class: 'board-field', placeholder: 'scene name', 'aria-label': 'Scene name', hidden: true })
  sceneField.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') sceneField.hidden = true
    if (e.key !== 'Enter' || sceneField.value.trim() === '') return
    post({ action: 'save', name: sceneField.value.trim() })
    sceneField.hidden = true
  })
  const loadMenu = el('div', { class: 'menu board-menu', role: 'menu', hidden: true }, [
    el('div', { class: 'menu-group', text: 'Scenes' }),
    ...scenes.map((name) => el('button', { type: 'button', class: 'menu-item', role: 'menuitem', text: name, onclick: () => (post({ action: 'load', name }), (loadMenu.hidden = true)) })),
    scenes.length ? null : el('div', { class: 'menu-item', text: 'none saved yet' }),
  ])
  seats.tools.replaceChildren(
    el('span', { class: 'board-hint', text: hintText() }),
    act('−', 'Zoom out', () => zoomBy(1 / 1.25)),
    act('+', 'Zoom in', () => zoomBy(1.25)),
    act('Fit', 'Fit everything into view (Esc)', fitAll),
    act('Arrange', 'Re-tile the rows', () => post({ action: 'arrange' })),
    clearAct(),
    act('Note', 'Leave a note on the board', () => {
      const v = view()
      const id = `note:${Date.now().toString(36)}`
      const x = Math.round((v.width / 2 - cam.x) / cam.s - 160)
      const y = Math.round((v.height / 2 - cam.y) / cam.s - 100)
      post({ action: 'place', id, kind: 'note', x, y, w: 320, h: 200, text: '' })
    }),
    act('Save', 'Save the cards as a scene', () => {
      sceneField.hidden = false
      sceneField.focus()
    }),
    sceneField,
    el('span', { class: 'menu-host' }, [act('Load', 'Bring a saved scene back', () => (loadMenu.hidden = !loadMenu.hidden)), loadMenu]),
  )
}

/**
 * Clear asks twice, on the same button: the second state names the count, so
 * the confirmation cannot be misread. Pinned cards stay, and the button says so.
 */
function clearAct() {
  const loose = Object.keys(board.cards).length
  const button = el('button', { type: 'button', class: 'board-act board-act-danger', text: 'Clear', title: 'Remove every card', disabled: loose === 0 })
  let timer = 0
  button.onclick = () => {
    if (!button.hasAttribute('data-arm')) {
      button.setAttribute('data-arm', '')
      button.textContent = `Clear ${loose}?`
      timer = setTimeout(() => {
        button.removeAttribute('data-arm')
        button.textContent = 'Clear'
      }, 4000)
      return
    }
    clearTimeout(timer)
    post({ action: 'clear' })
    clearSelection()
  }
  return button
}

// ── Rows, and the keys that walk them ──────────────────────────────────────
// The rule tiles the board like niri: sections are rows, a row's cards share
// one height and stand left to right. So a row is simply every card at one y.

/** A card the owner can actually see: registered, and standing in the world (a record-only card, like Work before its first tool call, is skipped by focus and the keys). */
const shown = (id) => panes.get(id)?.frame.parentElement === seats.world
const rowAt = (y) => Object.values(board.cards).filter((c) => c.y === y && shown(c.id)).sort((a, b) => a.x - b.x)
const rowYs = () => [...new Set(Object.values(board.cards).filter((c) => shown(c.id)).map((c) => c.y))].sort((a, b) => a - b)
const mid = (c) => c.x + c.w / 2
/** The card beside this one: left/right along its row; up/down the nearest by centre in the next row. */
function neighbour(card, dir) {
  if (dir === 'left' || dir === 'right') {
    const row = rowAt(card.y)
    return row[row.findIndex((c) => c.id === card.id) + (dir === 'right' ? 1 : -1)] ?? null
  }
  const ys = rowYs()
  const y = ys[ys.indexOf(card.y) + (dir === 'down' ? 1 : -1)]
  if (y === undefined) return null
  // A row remembers where the owner was in it. Leaving a row and coming back
  // should land where they left off, not on whatever happens to sit under the
  // pointer — the same courtesy a tabbed editor pays. Only a row never visited
  // falls back to the nearest card by centre.
  const remembered = lastVisited(y)
  if (remembered !== null) return board.cards[remembered]
  return rowAt(y).sort((a, b) => Math.abs(mid(a) - mid(card)) - Math.abs(mid(b) - mid(card)))[0] ?? null
}
/**
 * Where the owner has been, oldest first — card ids, not positions.
 *
 * Keyed by id on purpose: a row's `y` changes every time the board re-tiles
 * (closing a card reflows the rows), so a trail keyed by row position went
 * stale the moment it was most needed. Rows are read from each card's CURRENT
 * y when the trail is consulted, which cannot go stale.
 */
let visited = []
// Kept in this browser, not in the record: where one viewer left off is a
// property of the seat, not of the board, and two tabs must not fight over a
// shared cursor. A reload therefore opens where the owner actually was —
// row two, card five — instead of at the beginning.
const KEPT = 'gnomon-visited'
try {
  const kept = JSON.parse(localStorage.getItem(KEPT) ?? '[]')
  if (Array.isArray(kept)) visited = kept.filter((v) => typeof v === 'string').slice(-40)
} catch {
  // No storage, or nonsense in it: the board simply has no memory of this seat.
}
const visit = (id) => {
  visited = [...visited.filter((v) => v !== id), id].slice(-40)
  try {
    localStorage.setItem(KEPT, JSON.stringify(visited))
  } catch {}
}
/** The row's most recent card other than `skip` — where focus lands when `skip` is the one closing. */
const lastVisitedExcept = (skip, rowY) => {
  for (let i = visited.length - 1; i >= 0; i -= 1) {
    const card = board.cards[visited[i]]
    if (card === undefined || card.id === skip || !shown(card.id) || card.y !== rowY) continue
    return card.id
  }
  return null
}
/** The most recent card still on the board, optionally within one row. */
const lastVisited = (rowY = null) => {
  for (let i = visited.length - 1; i >= 0; i -= 1) {
    const card = board.cards[visited[i]]
    if (card === undefined || !shown(card.id)) continue
    if (rowY === null || card.y === rowY) return card.id
  }
  return null
}
/** Rows as the record knows them, top to bottom — including empty ones, which cards alone cannot show. */
const sections = () => Object.values(board.sections ?? {}).sort((a, b) => a.y - b.y)
const ROW_PAD = 18
/** Widths ⌥R cycles through, narrowest to widest. */
const WIDTHS = [480, 720, 960, 1280]
const DIRS = { ArrowLeft: 'left', KeyH: 'left', ArrowRight: 'right', KeyL: 'right', ArrowUp: 'up', KeyK: 'up', ArrowDown: 'down', KeyJ: 'down' }

function wireKeys() {
  document.addEventListener('keydown', (event) => {
    const field = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(event.target.tagName) ? event.target : null
    // Esc steps back to the whole board — also from an empty composer. It also
    // ends a peek, which is the way back that always exists: closing the
    // settings card while peeking would otherwise leave the whole screen a
    // whisper with the only switch gone.
    if (event.key === 'Escape' && (field === null || field.value === '')) {
      document.documentElement.removeAttribute('data-peek')
      fitAll()
    }
    if (field === null && (event.key === 'Backspace' || event.key === 'Delete') && selected.size > 0) {
      for (const id of [...selected]) dismissPane(id)
    }
    // ⌥ is the board's key (⌘ belongs to the browser, and ⌘⏎ to Raycast). The
    // composer usually holds focus, so an EMPTY field hands ⌥ to the board; a
    // field with text keeps ⌥ arrows for its own words. Codes, not keys: on a
    // Mac ⌥H types ˙ and ⌥⇧ arrows carry no letter at all.
    // ⌥C is the chat's key from anywhere — even mid-sentence in a field, where it
    // would only type a ç.
    if (event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyC') {
      event.preventDefault()
      document.getElementById('ghost-toggle')?.click()
      return
    }
    if (!event.altKey || event.metaKey || event.ctrlKey || (field !== null && field.value !== '')) return
    const id = focusedId ?? [...selected][0] ?? null
    const card = id === null ? undefined : board.cards[id]
    const dir = DIRS[event.code]
    if (dir) {
      event.preventDefault()
      // Plain arrows walk the board; the trackpad walks it through the same `step`.
      if (!card || !event.shiftKey) return void step(dir)
      const other = neighbour(card, dir)
      // ⇧: the card itself moves — past its neighbour, or into the row above or below.
      follow = id
      if (dir === 'left' || dir === 'right') {
        if (other) post({ action: 'move', id, x: other.x + (dir === 'right' ? 1 : -1) })
      } else {
        // Into the row above or below. Past the edge, a new row opens there, the
        // way niri opens a workspace — so rows never have to be made by hand.
        const rows = sections()
        const step = dir === 'down' ? 1 : -1
        const all = Object.values(board.cards)
        const newRow = (y) => post({ action: 'section', id: `row-${Date.now().toString(36)}`, label: `Row ${rows.length + 1}`, x: 0, y, w: 400, h: 200 })
        ;(async () => {
          if (rows.length === 0) {
            // Nameless so far: the cards' own row gets a name first, so there is a row to leave.
            const y0 = Math.min(...all.map((c) => c.y)) - ROW_PAD
            await newRow(y0)
            rows.push({ y: y0, h: Math.max(200, Math.max(...all.map((c) => c.h)) + ROW_PAD) })
          }
          const head = card.y + ROW_PAD
          const here = rows.findIndex((r) => head >= r.y && head <= r.y + r.h)
          let to = rows[here + step]
          if (!to) {
            const edge = step > 0 ? rows[rows.length - 1] : rows[0]
            const y = step > 0 ? edge.y + edge.h + GAP : edge.y - GAP - 200
            await newRow(y)
            to = { y }
          }
          follow = id
          post({ action: 'move', id, y: to.y + ROW_PAD })
        })()
      }
      return
    }
    if (event.code === 'KeyR' && card) {
      event.preventDefault()
      follow = id
      post({ action: 'move', id, w: WIDTHS.find((w) => w > card.w + 1) ?? WIDTHS[0] })
    }
    if (event.code === 'KeyW' && card) {
      event.preventDefault()
      dismissPane(id)
    }
    // ⌥F goes both ways: frame the card, and from a card already framed, step
    // back to the whole board; from the whole board it returns to the last card
    // visited. One key rather than a pair to remember apart — Esc still always
    // fits, for a way out that needs no aim.
    if (event.code === 'KeyF') {
      event.preventDefault()
      if (panMode || card === undefined) {
        const back = lastVisited()
        const first = rowYs().length ? rowAt(rowYs()[0])[0] : undefined
        const to = back ?? first?.id
        if (to) focusPane(to)
      } else if (framed(id)) fitAll()
      else frameCard(id)
    }
  })
}

// ── The API the app uses ───────────────────────────────────────────────────

/** Bring a pane into view: on the board if it is not, in front, and framed by the camera. */
export function focusPane(id, { ifHidden = false, animate = true } = {}) {
  if (!panes.has(id) && !(id in board.cards)) return
  if (panes.has(id) && !(id in board.cards)) ensureCard(id, { want: true })
  const card = board.cards[id]
  if (!card) {
    // Asked for, not landed yet: the board frame that brings it will frame it.
    follow = id
    return
  }
  raise(id)
  const v = view()
  if (!(ifHidden && visible(card, cam, v.width, v.height))) frameCard(id, animate)
  panMode = false
  focusedId = id
  visit(id)
  panes.get(id)?.onFocus?.()
  notify()
}

/** Push a card back into the depth; a second call brings it forward again. */
export function dockPane(id) {
  const card = board.cards[id]
  if (!card) return
  post({ action: 'move', id, z: card.z < -80 ? 0 : -260 })
}

/**
 * Who takes the focus when `card` goes.
 *
 * The card to its RIGHT, because a row reads left to right and the eye is
 * already there; else the one to its left. If the row empties, the row above,
 * at whichever card this seat was last on there, and only then the row below —
 * so closing the last card of a row walks back the way the owner came.
 */
function afterRemoving(card) {
  const row = rowAt(card.y)
  const at = row.findIndex((c) => c.id === card.id)
  if (at !== -1) {
    const right = row[at + 1]
    const left = row[at - 1]
    if (right) return right.id
    if (left) return left.id
  } else {
    // Not found where it claimed to be (a card mid-tile): anything else in the row.
    const other = row.find((c) => c.id !== card.id)
    if (other) return other.id
  }
  const ys = rowYs()
  const here = ys.indexOf(card.y)
  for (const y of [ys[here - 1], ys[here + 1]]) {
    if (y === undefined) continue
    const remembered = lastVisited(y)
    if (remembered !== null) return remembered
    const first = rowAt(y).find((c) => c.id !== card.id)
    if (first) return first.id
  }
  return null
}

/** Take a card off the board. Any card: nothing is pinned. */
export function dismissPane(id) {
  const card = board.cards[id]
  post({ action: 'remove', id })
  if (card) {
    // Read the neighbourhood BEFORE the card goes, while the positions that
    // stood around it are still true.
    const wasFocused = focusedId === id
    const next = wasFocused ? afterRemoving(card) : null
    visited = visited.filter((v) => v !== id)
    try {
      localStorage.setItem(KEPT, JSON.stringify(visited))
    } catch {}
    delete board.cards[id]
    leave(id)
    if (wasFocused) {
      focusedId = null
      // The board has not re-tiled yet — the record answers in a moment — so
      // frame the successor once it has, which is also what makes the camera
      // travel rather than cut.
      if (next !== null) follow = next
      else ensureFocus()
    }
    notify()
  } else leave(id)
}
