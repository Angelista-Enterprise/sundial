// The overlay: Sundial.app's summon panel over whatever the owner is doing (`/?overlay=slip`, overlay.css).
//
// The slip is a ticker: one row at rest (the thread, the line or the field, a two-line readout, one control slot)
// whose slots never move between states; only what there is to decide or read grows above it (an ask, an answer,
// the last steps), with a ruler edge on top that shows Gnomon's state. While Gnomon acts or asks, the locator
// (eye.js) says inside the slip where on the screen the act is and what it is on. On other apps: rings, step badges and tags on named
// things, and the ask tag before Gnomon acts on one. The Nodus sheet on the right when the newest turn is about a
// Nodus card. The board, the cards and their keys stay in the Sundial app.
//
// No state of its own. app.js boots as always, hidden; this file reads what it renders (the newest turn, its
// tool rows, an approval that waits; slip-read.js) and tells the Mac app where the page is solid, so every other
// click goes through to the app underneath. Inert without `data-overlay` on the root (index.html sets it).
import { mountLocator } from './eye.js'
import { askCard, askOf, asideText, chipText, clockOf, DAY_ASK, DAY_NONE, detailRows, doingOf, dur, evening, foldAside, HAND_LINE, lapsOf, queued, readFrames, readoutOf, runOf, shelfOf, slipOf, ticks, traceOf } from './slip-read.js'
import { onChange, titleOf } from './stage.js'
import { el } from './surfaces.js'
import { markSeen } from './verdicts.js'

export { askCard, askOf, chipText, doingOf, HAND_LINE, queued, runOf, slipOf, ticks, traceOf } from './slip-read.js'

/** 'slip' when the page query asks for the overlay (the old `1`, `board` and `figure` land here too), else null. */
export function overlayMode(search) {
  return /[?&]overlay=(1|board|figure|slip)(?:&|$)/.test(String(search ?? '')) ? 'slip' : null
}

/** The kinds the overlay shows as a sheet, in the order it prefers them. */
const FIGURES = ['nodus', 'lens']

/**
 * The card the sheet shows: a figure (a Nodus card, else a lens) that the
 * conversation named, by id or by its name in `names`. The one the newest
 * turn named last wins; else the newest Nodus card; else the newest lens.
 */
export function pickFigure(board, { said = '', thread = said, names = {} } = {}) {
  const named = (c, text) => text.includes(c.id) || (names[c.id] !== undefined && text.includes(names[c.id]))
  const eligible = Object.values(board?.cards ?? {}).filter((c) => FIGURES.includes(c.kind) && named(c, thread))
  // By id first: two cards can share a name (two drawings of one day), never an id.
  const last = (key) => eligible.filter((c) => key(c) && said.includes(key(c))).sort((a, b) => said.lastIndexOf(key(b)) - said.lastIndexOf(key(a)))[0]
  const spoken = last((c) => c.id) ?? last((c) => names[c.id])
  if (spoken) return spoken.id
  for (const kind of FIGURES) {
    const newest = eligible.filter((c) => c.kind === kind).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))[0]
    if (newest) return newest.id
  }
  return null
}

/** The solid parts of the page, as the Mac app hit-tests them: whole CSS pixels, `pad` wider, clipped, empty boxes dropped. */
export function regionsOf(rects, vw, vh, pad = 4) {
  return rects
    .map((r) => {
      const x = Math.max(0, Math.floor(r.left - pad))
      const y = Math.max(0, Math.floor(r.top - pad))
      return { x, y, w: Math.min(vw, Math.ceil(r.right + pad)) - x, h: Math.min(vh, Math.ceil(r.bottom + pad)) - y }
    })
    .filter((r) => r.w > 0 && r.h > 0)
}

/** "Xcode: Sundial.swift", the turn's place. Nothing for Sundial itself or an empty report. */
export function placeOf(info) {
  const app = String(info?.app ?? '').trim()
  const title = String(info?.title ?? '').trim()
  if (app === '' || app === 'Sundial') return ''
  return (title === '' || title === app ? app : `${app}: ${title}`).slice(0, 200)
}

/** Whether the slip goes to the top: a mark lies where it sits at the bottom (w by h, `gap` off the edge), and none at the top. */
export function slipUp(marks, w, h, vw, vh, gap = 36, pad = 12) {
  const at = (top) => [(vw - w) / 2 - pad, top - pad, (vw + w) / 2 + pad, top + h + pad]
  const hits = ([x0, y0, x1, y1]) => marks.some((m) => m.x < x1 && m.x + m.w > x0 && m.y < y1 && m.y + m.h > y0)
  return hits(at(vh - gap - h)) && !hits(at(gap))
}

/** Where the page takes a click: the slip, a tag, the sheet, the thread list open over the slip. */
export const SOLID = '.ov-slip, .ov-tag:not([hidden]), .pane[data-overlay-figure], .ov-slip #thread-menu:not([hidden]), .ov-slip .model-menu:not([hidden])'

/** Whether a scroller shows its end: the answer follows the end only while the owner is there. */
export const atEnd = (node, slack = 8) => node.scrollHeight - node.scrollTop - node.clientHeight <= slack

/** A copy of rendered prose for the slip: no second id on the page, no button that does nothing. */
export function copyOf(node) {
  const copy = node.cloneNode(true)
  for (const n of copy.querySelectorAll('button')) n.remove()
  for (const n of [copy, ...copy.querySelectorAll('[id]')]) n.removeAttribute('id')
  return copy
}

/** Set 2 R3: the newest open notice offer, as the hidden strip draws it (verdicts.js `offerChip`): its key and words, never its call. */
export function offerIn(doc) {
  // Not the field: a quiet summon keeps the place it offers on the composer as `data-offer` too.
  const chip = doc.querySelector('[data-offer]:not(#input)')
  const label = chip?.querySelector('button')?.textContent?.trim() ?? ''
  // The notice's own words when the strip knows them (`data-line`): the slip's line says what the button is for.
  return chip && label ? { noticeKey: chip.dataset.offer, label, ...(chip.dataset.line ? { line: chip.dataset.line } : {}) } : null
}

/** The slip's offer row: the button while an offer is open and nothing else asks for the owner; once pressed, what became of it. */
export function offerRow(offer, { ask = false, listening = false, done = null } = {}) {
  if (ask || listening) return null
  if (done && (!offer || done.noticeKey === offer.noticeKey)) return { ...(offer?.line ? { line: offer.line } : {}), ...done, settled: true }
  return offer
}

/** A press from the slip names only the notice and the surface; the host runs the call the gate kept for it, so a final still asks. */
export async function pressOffer(noticeKey, post = fetch) {
  const res = await post('/gnomon/api/offer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ noticeKey, via: 'slip' }) }).catch(() => null)
  const body = res ? await res.json().catch(() => ({})) : {}
  // What came back, in place of the button (the host's one cut line); the whole of it is in the conversation.
  if (body.ran) return typeof body.said === 'string' && body.said.trim() ? { text: body.said.trim(), title: 'Also in the conversation.' } : { text: 'Done. The answer is in the conversation.' }
  // The owner's own no on the ask the press raised reads as theirs, not as dsh's "the user rejected tool".
  const no = /\brejected\b/.test(String(body.reason ?? ''))
  return { text: res?.status === 404 ? 'Gone: taken already, or too old.' : no ? 'Not run: you said no.' : 'Not run.', title: body.reason ?? body.unavailable ?? null }
}

/** The one key hint the slot shows per state (the words are its title), and the field's words while it is empty. */
export const HINTS = { still: ['⌥L', 'Threads'], offer: ['⌥L', 'Threads'], stopped: ['⌥L', 'Threads'], ask: ['Enter', 'Type yes or no, then Enter'], ringed: ['Enter', 'Type yes or no, then Enter'], answer: ['⌥L', 'Threads'], guide: ['esc', 'Ends the guide'], list: ['esc', 'Closes the list'], scroll: ['⌥↑↓', 'Scrolls the answer'] }
export const PLACEHOLDERS = { doing: 'Type to correct it', think: 'Type to correct it', ask: 'Type yes or no', ringed: 'Type yes or no' }

/** The model's own words under the gate's line: named as Gnomon's, so the two are never read as one. */
const saidLine = (said) => `Gnomon's reason: ${said}`

/** A yes or a no is the whole utterance: "ok but change the recipient first" is a correction, never an approval. */
export const YES = /^\s*(yes|yeah|yep|ja|jawel|do it|doe het|go|ok|okay)[.!]?\s*$/i
export const NO = /^\s*(no|nope|nee|stop|niet|don'?t)[.!]?\s*$/i

/** Write only what changed: every write is a mutation, and the page redraws on mutations. */
const set = (node, key, value) => node[key] !== value && (node[key] = value)
/** The ask's ring and the act's ring are Gnomon's own: never judged. */
const mine = (m) => m.id.startsWith('ask:') || m.id.startsWith('act:')
const gnMark = () => {
  const gn = el('span', { class: 'ov-gn', 'aria-hidden': 'true' })
  gn.innerHTML = '<svg viewBox="0 0 14 14"><path d="M1 13H13L1 2Z"/></svg>'
  return gn
}

function boot() {
  const root = document.documentElement
  // The ink follows the system appearance, not the app's paper: macOS knows what is behind the panel.
  const system = () => root.hasAttribute('data-theme') && root.removeAttribute('data-theme')
  new MutationObserver(system).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  system()
  const input = document.getElementById('input')
  const bar = document.getElementById('bar')
  const post = (body) => fetch('/gnomon/api/overlay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, summonId: input.dataset.summon }) }).catch(() => {})
  let keyName = '⌥Space'

  // ── The slip: the edge, what grows (the trace, the last steps, the ask, the answer, an offer), then the row ──
  const scale = el('div', { class: 'ov-scale', 'aria-hidden': 'true' })
  const trace = el('ol', { class: 'ov-trace', hidden: true, 'aria-label': 'What Gnomon is doing' })
  let traceOn = (() => { try { return localStorage.getItem('gnomon.trace') === '1' } catch { return false } })()
  const laps = el('ol', { class: 'ov-laps', hidden: true, 'aria-label': 'The last steps, with the model and tool time of each' })
  const askKind = el('span', { class: 'ov-kind' })
  const askWhere = el('span', { class: 'ov-where' })
  const askLine = el('p', { class: 'ov-ask-line', 'aria-live': 'polite' })
  const detail = el('dl', { class: 'ov-detail' })
  const why = el('p', { class: 'ov-said', hidden: true })
  const sayIt = el('small')
  const acts = el('div', { class: 'ov-acts' }, [el('button', { type: 'button', class: 'ov-btn ov-go', text: 'Do it', onclick: () => answer(true) }), el('button', { type: 'button', class: 'ov-btn', text: 'No', onclick: () => answer(false) }), sayIt])
  // Where and what (eye.js): beside two lines above the last steps while Gnomon acts; right of the gate's sentence on an ask.
  const loc = mountLocator()
  const askBox = el('div', { class: 'ov-askb', hidden: true, role: 'group', 'aria-label': 'Gnomon asks first' }, [gnMark(), el('div', {}, [el('div', { class: 'ov-askhead' }, [el('div', {}, [el('p', { class: 'ov-asks' }, [askKind, askWhere]), askLine]), loc.ask]), detail, why, acts])])
  const line = el('div', { class: 'ov-line', 'aria-live': 'polite' })
  const answerBox = el('div', { class: 'ov-answer', hidden: true }, [gnMark(), line])
  // A notice's one act: quiet, its outcome in place of it once pressed.
  const offerBox = el('div', { class: 'ov-offer', hidden: true, 'data-key': '' })
  let offerDone = null
  const waitsLine = el('p', { class: 'ov-waits', hidden: true })
  // Set 4 R2: a second question's answer, from its side thread, under the running task (or the task's answer) and never over it.
  const [asideQ, asideA] = [el('b'), el('span')]
  const asideBox = el('p', { class: 'ov-aside', hidden: true, 'aria-live': 'polite' }, [asideQ, asideA])
  const grown = el('div', { class: 'ov-grown' }, [trace, loc.doing, laps, askBox, answerBox, asideBox, offerBox, waitsLine])
  // The row. The field is the app's own composer; the line sits over it while it is empty, so typing replaces the line.
  const mark = el('span', { class: 'ov-glyph', 'aria-hidden': 'true' }, [gnMark(), el('i', { class: 'ov-dot' })])
  const one = el('span', { class: 'ov-one-line', 'aria-live': 'polite' })
  const field = el('div', { class: 'ov-field' }, [one])
  if (input) field.append(input)
  const roTag = el('span', { class: 'ov-stag', hidden: true })
  const roTop = el('b')
  const roBottom = el('span')
  const ro = el('div', { class: 'ov-ro' }, [el('span', { class: 'ov-ro-top' }, [roTag, roTop]), roBottom])
  const stopBtn = el('button', { type: 'button', class: 'ov-btn ov-sm', title: 'Stop (⌥.)', hidden: true, onclick: () => stop('slip-button') }, ['Stop', el('kbd', { text: '⌥.' })])
  const hintKbd = el('kbd', { class: 'ov-hint' })
  const chip = el('button', { type: 'button', class: 'ov-chip', hidden: true, onclick: () => togglePlace() })
  const slot = el('div', { class: 'ov-slot' }, [chip, stopBtn, hintKbd])
  // Which thread this goes to: the slip's title, its list upward (thread-pill.js), the model for the thread as its last line.
  const thread = document.getElementById('thread')
  if (thread) thread.hidden = false
  const threadMenu = document.getElementById('thread-menu')
  // Trace by click or Alt+T: one state, two inputs. A press keeps the field's focus (WebKit does not focus a clicked button,
  // so the field would blur with nothing in the slip taking the focus, and the keys would go back to the app below).
  const traceBtn = el('button', { type: 'button', class: 'ov-trace-btn', text: 'Trace', title: 'Show each step Gnomon takes (⌥T)', 'aria-pressed': String(traceOn), onmousedown: (e) => e.preventDefault(), onclick: () => setTrace(!traceOn) })
  const row = el('div', { class: 'ov-tick' }, [el('div', { class: 'ov-one' }, [mark, field]), thread, traceBtn, ro, slot])
  const slip = el('section', { class: 'ov-slip ov-paper', 'aria-label': 'Gnomon' }, [scale, grown, row])
  document.body.append(slip)

  // ── A long answer: it follows its end while the owner is at the end; ⌥↑ ⌥↓ and Page Up/Down scroll it from the field ──
  let lineKey = ''
  let lineHtml = []
  let lineTurn = null
  line.addEventListener('scroll', () => tick())
  input?.addEventListener('input', () => tick())
  slip.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyT') return void (e.preventDefault(), setTrace(!traceOn))
    const by = e.key === 'PageUp' ? -0.85 : e.key === 'PageDown' ? 0.85 : !e.altKey ? 0 : e.key === 'ArrowUp' ? -0.3 : e.key === 'ArrowDown' ? 0.3 : 0
    if (by === 0 || line.scrollHeight <= line.clientHeight) return
    e.preventDefault()
    line.scrollBy({ top: by * line.clientHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, true)

  let scaleKey = ''
  const drawScale = (mode, step, of) => {
    const n = Math.max(8, Math.floor((slip.offsetWidth - 24) / 6))
    const key = `${mode}:${n}:${step}:${of}`
    if (key === scaleKey) return
    scaleKey = key
    scale.dataset.mode = mode
    scale.replaceChildren(...ticks(mode, n, step, of).map(([h, c], i) => el('i', { class: c, style: `--s:${(h / 13).toFixed(3)};--i:${i}` })))
  }

  // ── What the conversation shows, and when the page saw a turn start and end (turns carry no clock of their own) ──
  let since = null
  let note = ''
  // The turn that was newest when the note was written: a newer turn that runs makes the note stale.
  let noteTurn = null
  const setNote = (line) => ((note = line), (noteTurn = lastTurn()))
  const times = new WeakMap()
  const lastTurn = () => [...document.querySelectorAll('#ghost .turn')].at(-1) ?? null
  const read = () => {
    const turn = lastTurn()
    const running = document.body.dataset.running === 'true'
    // The words just sent, before their turn is drawn: never the old turn's answer flashing back (run199 T21 0:08).
    if (running && sentWords.text && turn === sentWords.turn && !sentWords.running) return { running, said: sentWords.text }
    if (!turn || (turn === since && !running)) return { running }
    const rows = [...turn.querySelectorAll('.tool, .log-line[data-key^="llm:"]')]
    const prose = [...turn.querySelectorAll('.prose')]
    const tools = rows.filter((r) => r.matches('.tool'))
    return { running, turn, tools, shelf: shelfOf(tools.at(-1)), fail: turn.querySelector('.fail')?.textContent ?? '', said: (running && sentWords.running && sentWords.turn === turn && sentWords.text) || (turn.querySelector('.said')?.textContent?.trim() ?? ''), reply: prose.map((p) => p.textContent).join(' ').trim(), prose, ...doingOf(rows) }
  }
  const timesOf = (turn, running) => {
    if (!turn) return null
    const t = times.get(turn) ?? { t0: performance.now(), wall: Date.now(), end: null, endAt: null, seenRunning: running }
    if (running && !t.seenRunning) Object.assign(t, { t0: performance.now(), wall: Date.now(), seenRunning: true })
    if (!running && t.seenRunning && t.end === null) Object.assign(t, { end: performance.now(), endAt: Date.now() })
    times.set(turn, t)
    return t
  }

  // ── The trace (⌥T): every call of the turn as it happens, with the model's time before it. Hidden by default ──
  function setTrace(on) {
    traceOn = on
    try { localStorage.setItem('gnomon.trace', on ? '1' : '0') } catch {}
    traceBtn.setAttribute('aria-pressed', String(on))
    tick()
  }
  const drawTrace = (now, t, asking) => {
    set(trace, 'hidden', !traceOn || !now.turn)
    if (trace.hidden) return
    const end = atEnd(trace, 4)
    const items = traceOf(now.tools, t.t0, performance.now(), now.running, asking)
    // Redrawn only when a line changed: the slip updates on every mutation of the page.
    const key = JSON.stringify(items)
    if (trace.dataset.key === key) return
    trace.dataset.key = key
    const head = items.shift()
    trace.replaceChildren(el('li', { class: 'ov-trace-head', text: head }), ...items.map((i) => el('li', { 'data-state': i.state }, [el('i'), el('b', { text: i.title }), el('time', { text: i.time }), i.sub ? el('small', { text: i.sub }) : null, i.why ? el('span', { class: 'why', text: i.why }) : null])))
    if (end) trace.scrollTop = trace.scrollHeight
  }
  /** The last three steps with model and tool time; the newest carries the step's square. Redrawn only when a line changed. */
  const drawLaps = (list, said) => {
    // The running step's words are the slip's own line just under it: its row keeps the square and the clock, not the words twice.
    const rows = list.map((l) => [l.n === null ? '·' : String(l.n), l.now && l.title === said ? '' : l.title, l.model === null ? '' : `${dur(l.model)}${l.now ? '…' : ''}`, l.tool === null ? '' : dur(l.tool), l.now])
    const key = JSON.stringify(rows)
    if (laps.dataset.key === key) return
    laps.dataset.key = key
    laps.replaceChildren(el('li', { class: 'hd' }, [el('span'), el('span', { text: 'Last steps' }), el('span', { text: 'model' }), el('span', { text: 'tools' })]), ...rows.map(([n, title, model, tool, now]) => el('li', { class: now ? 'now' : null }, [el('span', { class: n === '·' ? 'ov-lap-mark' : null }, now && n !== '·' ? [el('span', { class: 'ov-stag', text: n })] : [n]), el('span', { text: title, title }), el('span', { text: model }), el('span', { text: tool })])))
  }

  // ── The ask: an approval that waits, drawn by app.js in the hidden turn ──
  const asked = new WeakMap()
  const waiting = () => {
    const card = askCard(lastTurn())
    const ask = card?._ask
    if (!ask) return null
    if (!asked.has(card)) asked.set(card, performance.now())
    return { card, id: ask.id, since: asked.get(card), ...askOf(ask.args, card.querySelector('.approval-tool')?.textContent ?? ask.tool, ask.reason) }
  }
  let ringing = null
  const ringAsk = (ask) => {
    const id = ask?.target ? ask.id : null
    if (id === ringing) return
    if (ringing) post({ type: 'ask-clear', id: ringing })
    ringing = id
    if (id) post({ type: 'ask-mark', id, target: ask.target })
  }
  function answer(ok) {
    const ask = waiting()
    ask?.card.querySelectorAll('.approval-acts button')[ok ? 0 : 1]?.click()
  }

  // ── While a turn runs: Enter sends the words into it as a correction (Set 2 R4; app.js would take them as a stop note), Stop or ⌥. stops it ──
  let waits = ''
  const sentWords = { text: '', turn: null, running: false }
  let stopping = false
  let stopped = null
  const isRunning = () => document.body.dataset.running === 'true'
  const take = () => {
    waits = queued(waits, input.value)
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  document.addEventListener('submit', (e) => {
    if (e.target !== bar || stopping) return
    const text = input.value.trim()
    // An ask that waits takes a typed yes or no as its answer, whether or not a turn runs (the watcher delivers asks too).
    if (waiting() && (YES.test(text) || NO.test(text))) {
      e.preventDefault()
      e.stopImmediatePropagation()
      input.value = ''
      return void answer(YES.test(text))
    }
    // Other words while it waits are the owner's no and their next instruction: the call stops waiting and the turn reads them. Left open,
    // the ask held every message behind it until its 5 minute timeout (run202: one ask stood through six tasks).
    if (text && waiting()) answer(false)
    // "What did you do today": the day's line from the Ledger's own read, on the still slip; no turn.
    if (!isRunning() && DAY_ASK.test(text)) return void (e.preventDefault(), e.stopImmediatePropagation(), (input.value = ''), daySaid())
    // What the slip says it heard until the turn shows it: a new message or a correction (run202 T03 kept the old turn's words).
    if (text) Object.assign(sentWords, { text, turn: lastTurn(), running: isRunning() })
    if (!isRunning()) return
    e.preventDefault()
    e.stopImmediatePropagation()
    // The task is on the shelf (still while its turn says its last line): the words start a fresh turn when it ends.
    if (root.dataset.ovState === 'still') return void (take(), update())
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (text) document.dispatchEvent(new CustomEvent('gnomon:correct', { detail: { text } }))
    update()
  }, true)
  // What it said goes on the record (overlay:day-said): no turn writes a chat:said for it (run 227 T32 waited for one).
  const daySaid = () => fetch('/gnomon/summon').then((r) => r.json()).then((s) => {
    const line = s?.day || DAY_NONE
    since = lastTurn()
    setNote(line)
    update()
    void post({ type: 'day-said', line })
  }).catch(() => {})
  // A second question went to a side thread (the host answers the correction with `x-gnomon-aside`, app.js hands its stream here).
  let aside = null
  document.addEventListener('gnomon:aside', (e) => ((aside = { q: e.detail.text, a: '', done: false }), void readFrames(e.detail.response, (f) => ((aside = foldAside(aside, f)), tick())), tick()))
  /** app.js's own Stop (the bar's submit while a turn runs), with the field empty: what was typed waits for the turn after. */
  function stop(by) {
    if (!isRunning()) return
    bar.dataset.stopBy = by
    const now = read()
    stopped = { turn: now.turn, steps: now.steps ?? 0, app: now.app ?? '', at: Date.now() }
    take()
    stopping = true
    try {
      bar.requestSubmit()
    } finally {
      stopping = false
      delete bar.dataset.stopBy
    }
    update()
  }
  addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'Period' && isRunning()) (e.preventDefault(), stop('slip-key'))
  }, true)
  const send = () => {
    if (!waits || isRunning()) return
    input.value = queued(waits, input.value)
    waits = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    bar.requestSubmit()
  }

  // ── Marks on the real screen (in the panel's CSS points), their tags, and "Right spot?" ──
  const SVG = 'http://www.w3.org/2000/svg'
  const layer = document.createElementNS(SVG, 'svg')
  layer.classList.add('ov-marks')
  layer.setAttribute('aria-hidden', 'true')
  const tags = el('div', { class: 'ov-tags' })
  document.body.append(layer, tags)
  const svg = (name, attrs, text) => {
    const node = document.createElementNS(SVG, name)
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
    if (text !== undefined) node.textContent = text
    return node
  }
  const PAD = 6
  const box = (m) => ({ x: m.x - PAD, y: m.y - PAD, w: m.w + PAD * 2, h: m.h + PAD * 2 })
  const drawMark = (m) => {
    const { x, y, w, h } = box(m)
    const g = svg('g', { class: `ov-mark ov-mark-${m.shape}${m.dashed ? ' ov-mark-dashed' : ''}` })
    if (m.shape === 'underline') g.append(svg('line', { x1: m.x, y1: m.y + m.h + 3, x2: m.x + m.w, y2: m.y + m.h + 3 }))
    else if (m.shape === 'bracket') g.append(svg('path', { d: `M${x + 8},${y} H${x} V${y + h} H${x + 8} M${x + w - 8},${y} H${x + w} V${y + h} H${x + w - 8}` }))
    else if (m.shape !== 'label') g.append(svg('rect', { x, y, width: w, height: h }))
    // The step's number sits above the ring; under it when the thing is at the top edge (a toolbar).
    const by = y - 24 < 0 ? y + h + 2 : y - 24
    if (m.step) g.append(svg('rect', { class: 'ov-mark-chip', x: x - 1, y: by, width: 22, height: 22 }), svg('text', { class: 'ov-mark-num', x: x + 10, y: by + 15.5, 'text-anchor': 'middle' }, String(m.step)))
    return g
  }
  /** A paper tag beside the thing: right of it when it fits, else below, with a short ochre leader. */
  const place = (tag, m) => {
    const { x, y, w, h } = box(m)
    const tw = tag.offsetWidth
    const th = tag.offsetHeight
    const right = x + w + 12 + tw <= innerWidth - 8
    set(tag.dataset, 'side', right ? 'right' : 'below')
    set(tag.style, 'left', `${right ? x + w + 12 : Math.max(8, Math.min(innerWidth - tw - 8, x))}px`)
    set(tag.style, 'top', `${right ? Math.max(8, Math.min(innerHeight - th - 8, y + h / 2 - th / 2)) : Math.min(innerHeight - th - 8, y + h + 12)}px`)
  }
  let shown = []
  let judging = 0
  const marks = (list, only, judge) => {
    if (only) root.dataset.ovMarksOnly = ''
    else delete root.dataset.ovMarksOnly
    const cleared = shown.filter((m) => !list.some((n) => n.id === m.id) && !mine(m))
    layer.replaceChildren(...list.map(drawMark))
    shown = list
    tags.replaceChildren()
    for (const m of list.filter((m) => m.label && !m.id.startsWith('ask:'))) {
      const tag = el('div', { class: 'ov-tag ov-paper' }, [el('span', { text: m.label })])
      tags.append(tag)
      place(tag, m)
    }
    update()
    pick()
    if (!judge || cleared.length === 0) return
    const near = cleared.at(-1)
    const judgeTag = el('div', { class: 'ov-tag ov-paper ov-judge', role: 'group', 'aria-label': 'Was the mark on the right thing?' })
    const say = (right) => {
      judgeTag.remove()
      for (const m of cleared) post({ type: 'mark-judged', id: m.id, right })
    }
    judgeTag.append(el('span', { text: 'Right spot?' }), el('button', { type: 'button', class: 'ov-btn', text: 'Yes', onclick: () => say(true) }), el('button', { type: 'button', class: 'ov-btn', text: 'No', onclick: () => say(false) }))
    tags.append(judgeTag)
    place(judgeTag, near)
    clearTimeout(judging)
    judging = setTimeout(() => judgeTag.remove(), 10_000)
  }
  /** The ask tag beside the ringed control: what will be done, Gnomon's reason under it, Do it and No. */
  let askTag = null
  const drawAskTag = (ask, m) => {
    if (!ask || !m) return void (askTag?.remove(), (askTag = null))
    if (askTag?.dataset.id !== ask.id) {
      askTag?.remove()
      askTag = el('div', { class: 'ov-tag ov-paper ov-ask', 'data-id': ask.id, role: 'group', 'aria-label': 'Gnomon asks first' }, [
        el('p', { class: 'ov-ask-line', text: ask.line }),
        ask.detail || ask.said ? el('p', { class: 'ov-said', text: [ask.detail, ask.said && saidLine(ask.said)].filter(Boolean).join('\n') }) : null,
        el('div', { class: 'ov-acts' }, [
          el('button', { type: 'button', class: 'ov-btn ov-go', text: 'Do it', onclick: () => answer(true) }),
          el('button', { type: 'button', class: 'ov-btn', text: 'No', onclick: () => answer(false) }),
          el('small', { text: `or hold ${keyName} and say yes` }),
        ]),
      ])
      document.body.append(askTag)
    }
    place(askTag, m)
  }

  // ── The Nodus sheet: the card the newest turn is about, pinned at the right ──
  let board = null
  const readBoard = async () => {
    try {
      board = await (await fetch('/gnomon/api/board', { headers: { accept: 'application/json' } })).json()
    } catch {}
  }
  let reading = 0
  onChange(() => {
    clearTimeout(reading)
    reading = setTimeout(readBoard, 150)
  })
  let figure = null
  const words = (n) => (n ? [n.textContent, ...[...n.querySelectorAll('[title]')].map((t) => t.title)].join('\n') : '')
  const pick = () => {
    const turn = lastTurn()
    const said = turn && turn !== since ? words(turn) : ''
    const names = Object.fromEntries(Object.keys(board?.cards ?? {}).map((id) => [id, titleOf(id)]).filter(([id, name]) => name && name !== id && name.length > 3))
    // On the screen the rings are the picture: no sheet beside them.
    const id = said && !shown.some((m) => !mine(m)) ? pickFigure(board, { said, names }) : null
    if (id === figure) return
    figure = id
    for (const f of document.querySelectorAll('.pane[data-overlay-figure]')) f.removeAttribute('data-overlay-figure')
    if (id) document.querySelector(`.pane[data-pane="${CSS.escape(id)}"]`)?.setAttribute('data-overlay-figure', '')
  }

  // ── The offer: drawn only when it changed, seen when on the slip, pressed through the strip's own route ──
  const drawOffer = (o) => {
    const key = o ? `${o.noticeKey}|${o.settled ? o.text : ''}` : ''
    if (offerBox.dataset.key === key) return
    offerBox.dataset.key = key
    offerBox.hidden = !o
    if (!o || o.settled) return void offerBox.replaceChildren(...(o ? [el('small', { text: o.text, title: o.title })] : []))
    const btn = el('button', { type: 'button', class: 'ov-btn ov-sm', text: o.label, title: 'From the notice. Anything that changes something still asks you first.', onclick: () => takeOffer(o) })
    offerBox.replaceChildren(btn)
    markSeen(btn, o.noticeKey, 'slip-offer')
  }
  const takeOffer = async ({ noticeKey, line }) => {
    // The notice's line stays the slip's line while it runs and after: the strip drops the offer once it is taken.
    offerDone = { noticeKey, line, text: 'Running…' }
    update()
    offerDone = { noticeKey, line, ...(await pressOffer(noticeKey)) }
    update()
  }

  // ── The answer: the app's own rendering, copied; paragraphs, lists and code stay what they are ──
  const drawAnswer = (s, now) => {
    const html = s.full ? now.prose.map((p) => p.innerHTML) : []
    const key = html.join('\n')
    // The end is followed while the answer streams and the owner is at it; an answer first shown whole starts at its top.
    const same = s.full && now.turn === lineTurn
    const follow = s.full && key !== lineKey && (same ? atEnd(line) : now.running)
    if (!s.full) line.replaceChildren()
    else if (key !== lineKey) {
      const old = same ? [...line.children] : []
      if (!same) line.replaceChildren()
      now.prose.forEach((p, i) => {
        if (old[i] && html[i] === lineHtml[i]) return
        old[i] ? old[i].replaceWith(copyOf(p)) : line.append(copyOf(p))
      })
      for (const gone of old.slice(html.length)) gone.remove()
      if (!same && !follow) line.scrollTop = 0
    }
    lineKey = key
    lineHtml = html
    lineTurn = s.full ? now.turn : null
    // Read aloud once, when the answer is whole: not on every frame of it.
    const busy = String(Boolean(s.full && now.running))
    if (line.getAttribute('aria-busy') !== busy) line.setAttribute('aria-busy', busy)
    if (follow) line.scrollTop = line.scrollHeight
    const long = s.full && line.scrollHeight > line.clientHeight + 1
    set(line.dataset, 'more', long ? [line.scrollTop > 0 && 'up', !atEnd(line, 1) && 'down'].filter(Boolean).join(' ') : '')
    return long
  }

  /** The ask's body in the slip: its kind and target, the gate's sentence, the detail rows, Gnomon's reason, Do it and No. */
  const drawAsk = (ask, s) => {
    set(askBox, 'hidden', s.state !== 'ask')
    if (askBox.hidden) return
    const t = ask.target
    set(askKind, 'textContent', ask.kind ?? 'Asks first')
    set(askWhere, 'textContent', [t?.label ? `${t.label}${t.app ? ` in ${t.app}` : ''}` : t?.app, ask.final && 'final step'].filter(Boolean).join(' · '))
    set(askLine, 'textContent', s.line)
    if (detail.dataset.key !== (s.detail ?? '')) {
      detail.dataset.key = s.detail ?? ''
      detail.replaceChildren(...detailRows(s.detail).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))
    }
    set(why, 'textContent', s.said ? saidLine(s.said) : '')
    set(why, 'hidden', !s.said)
    set(sayIt, 'textContent', `or type yes, or hold ${keyName} and say it`)
  }

  /** The readout slot: two lines and the step's square, from the state and the times the page saw. */
  const drawReadout = (s, now, t, ask) => {
    const pnow = performance.now()
    const lapList = now.turn && t ? lapsOf(now.tools, t.t0, pnow, now.running) : []
    const { laps: clockLaps, last } = now.turn && t ? clockOf(now.tools, t.t0, t.end ?? pnow) : { laps: [], last: 0 }
    const model = clockLaps.reduce((n, l) => n + l.think, 0) + Math.max(0, (t?.end ?? pnow) - last)
    const r = readoutOf(s.state, {
      steps: now.steps ?? 0,
      app: now.app ?? '',
      ms: t ? pnow - t.t0 : 0,
      think: lapList.at(-1)?.model ?? 0,
      waited: ask ? pnow - ask.since : 0,
      next: ask?.target ? (now.steps ?? 0) + 1 : null,
      answeredAt: t?.endAt ?? null,
      took: t?.end ? t.end - t.t0 : 0,
      model: t?.end && now.tools?.some((row) => row._t0 != null) ? model : 0,
      stoppedAt: stopped && stopped.turn === now.turn ? stopped.at : null,
      tool: Boolean(now.tools?.some((row) => row._result === undefined)),
    })
    set(ro, 'hidden', !r)
    set(roTop, 'textContent', r?.top ?? '')
    set(roBottom, 'textContent', r?.bottom ?? '')
    set(roTop, 'className', r?.wait ? 'g' : '')
    set(roTag, 'hidden', !r?.tag)
    set(roTag, 'textContent', r?.tag ? String(r.tag) : '')
    set(laps, 'hidden', s.state !== 'doing' || lapList.length === 0)
    if (!laps.hidden) drawLaps(lapList, s.doing?.line ?? s.line)
    return r
  }

  // ── One pass: the slip, the ask, the locator, the regions ──
  let clock = 0
  const update = () => {
    const ask = waiting()
    ringAsk(ask)
    const askMark = ask ? shown.find((m) => m.id === `ask:${ask.id}`) : null
    drawAskTag(ask, askMark)
    const guideMark = shown.find((m) => m.id.startsWith('guide:'))
    const now = read()
    // The summon's line is the moment it was summoned: once Gnomon works, the work says what is true.
    const t = timesOf(now.turn, now.running)
    if (note && t?.seenRunning && now.turn !== noteTurn) note = ''
    if (now.turn && t) drawTrace(now, t, Boolean(ask))
    else set(trace, 'hidden', true)
    const listening = root.dataset.ovListening !== undefined
    const offer = offerRow(offerIn(document), { ask: Boolean(ask), listening, done: offerDone })
    // The owner's hand holds the running screen step (owner-hand.js pushes it; app.js marks that screen_act's row `data-hand`).
    const hand = Boolean(now.running && now.tools?.some((row) => row._result === undefined && row.hasAttribute('data-hand')))
    const s = slipOf({ ...now, ms: t ? performance.now() - t.t0 : 0, listening, ask: ask && { line: ask.line, detail: ask.detail, said: ask.said, ringed: Boolean(askMark) }, guide: guideMark && { step: guideMark.step ?? 1, of: guideMark.of }, note, stopped: stopped && stopped.turn === now.turn && !now.running ? stopped : null, offer, hand, aside: aside?.q ?? '' })
    const listOpen = threadMenu ? !threadMenu.hidden : false
    set(root.dataset, 'ovState', s.state)
    drawAsk(ask, s)
    const long = drawAnswer(s, now)
    set(answerBox, 'hidden', !s.full)
    set(asideBox, 'hidden', !aside)
    set(asideQ, 'textContent', aside ? `and: ${aside.q}` : '')
    set(asideA, 'textContent', aside ? asideText(aside) : '')
    drawOffer(offer)
    const r = runOf({ running: now.running, waits, ms: t ? performance.now() - t.t0 : 0, steps: now.steps ?? 0, thinking: s.state === 'think' })
    // The thread head refused a switch (thread-pill.js): a turn runs or an ask waits, and its words belong to this thread.
    // The hand's line sits above the row, not over the field: it stays while the owner types in the slip itself.
    // A minute of thinking with no step says so, with the way out; the minutes move on the slip's own 1 s clock.
    const say = thread?.dataset.refused ? 'Finish or stop this turn first: the thread stays as it is.' : s.hand ? HAND_LINE : r.waits || (s.state === 'think' ? r.still : '')
    set(waitsLine, 'textContent', say)
    set(waitsLine, 'hidden', !say)
    set(waitsLine, 'className', say === HAND_LINE ? 'ov-waits hand' : 'ov-waits')
    // The row: the line over the empty field, or the field with its state's words; one mark; the readout; one control.
    const inLine = s.state !== 'ask' && s.state !== 'answer' && s.line !== ''
    set(one, 'textContent', inLine ? s.line : '')
    set(one, 'className', `ov-one-line${s.tone === 'heard' ? ' heard' : ''}`)
    set(one, 'hidden', !inLine || (input?.value ?? '') !== '')
    if (input) set(input, 'placeholder', inLine ? '' : PLACEHOLDERS[s.state] ?? 'Talk to Gnomon…')
    set(mark.dataset, 'mark', s.state === 'doing' || s.state === 'think' ? 'dot' : inLine && s.state !== 'listen' ? 'gn' : '')
    drawReadout(s, now, t, ask)
    const ms = t ? performance.now() - t.t0 : 0
    set(stopBtn, 'hidden', !now.running || s.shelf || (s.state === 'think' && ms < 1000) || s.state === 'ask' || s.state === 'ringed' || listOpen)
    const hint = listOpen ? HINTS.list : s.state === 'answer' && long ? HINTS.scroll : HINTS[s.state]
    set(chip, 'hidden', listOpen || !['still', 'offer'].includes(s.state) || (input.dataset.place ?? '') + (input.dataset.offer ?? '') === '')
    set(hintKbd, 'hidden', !stopBtn.hidden || !chip.hidden || !hint)
    set(hintKbd, 'textContent', hint?.[0] ?? '')
    set(hintKbd, 'title', hint?.[1] ?? '')
    clearTimeout(clock)
    if (now.running || ask) clock = setTimeout(tick, 1000)
    root.toggleAttribute('data-ov-running', now.running)
    if (waits && !now.running) queueMicrotask(send)
    drawScale(s.scale, guideMark?.step ?? 1, guideMark?.of ?? 1)
    root.toggleAttribute('data-ov-slip-up', slipUp(shown, slip.offsetWidth, slip.offsetHeight, innerWidth, innerHeight))
    // The locator: while Gnomon acts, beside its step's square; on an ask to act on the screen, where the yes will press.
    // Nothing at rest, and nothing while the real part is ringed on screen: the ring and its tag are the picture then.
    loc.show(s.state === 'doing' ? 'doing' : s.state === 'ask' && ask?.target ? 'ask' : null, { step: now.steps || null })
    report()
  }

  let sent = ''
  const report = () => {
    const rects = [...document.querySelectorAll(SOLID)].filter((n) => n.getClientRects().length > 0 && (root.dataset.ovMarksOnly === undefined || n.matches('.ov-tag'))).map((n) => n.getBoundingClientRect())
    const regions = regionsOf(rects, innerWidth, innerHeight)
    // The slip alone, apart from the tags and the sheet: the Mac app's screen stage keeps clear of it (ScreenLook stageFrame).
    const own = root.dataset.ovMarksOnly === undefined ? [...document.querySelectorAll('.ov-slip')].find((n) => n.getClientRects().length > 0) : null
    const slip = (own && regionsOf([own.getBoundingClientRect()], innerWidth, innerHeight)[0]) ?? null
    const json = JSON.stringify([regions, slip])
    if (json === sent) return
    sent = json
    window.webkit?.messageHandlers?.regions?.postMessage(regions)
    window.webkit?.messageHandlers?.slip?.postMessage(slip)
  }
  let frame = 0
  let picking = 0
  const tick = () => {
    // A turn's start and end are taken when the page changes, not on the next frame: a hidden panel draws no frames.
    timesOf(lastTurn(), isRunning())
    frame ||= requestAnimationFrame(() => ((frame = 0), update()))
    picking ||= setTimeout(() => ((picking = 0), pick()), 250)
  }
  new MutationObserver(tick).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
  for (const type of ['resize', 'transitionend', 'animationend']) addEventListener(type, tick)
  // The slip grows with what it holds: its region follows, or the wheel falls through to the app below.
  new ResizeObserver(tick).observe(slip)

  // Whether the field holds the cursor: with the pointer off the slip, the panel keeps the keyboard only while it does.
  const typing = (on) => window.webkit?.messageHandlers?.composer?.postMessage(on)
  // The whole slip counts, the thread list too (it draws outside the slip, but sits in it): focus moving from the field to a
  // list option is still typing here, and must not hand the keys back to the app below. On focusout the new owner is the relatedTarget.
  const ours = (node) => node instanceof Node && slip.contains(node)
  for (const type of ['focusin', 'focusout']) document.addEventListener(type, (e) => typing(ours(type === 'focusin' ? e.target : e.relatedTarget)))

  // ── The place: what the owner is looking at, offered as a chip they attach or drop ──
  let first = true
  const moved = (kind) => {
    if (!input.dataset.summon) return
    if (kind === 'place-added') return void post({ type: 'place-added' })
    if (first) (first = false), void post({ type: 'first-move', kind })
  }
  input?.addEventListener('input', () => moved('type'))
  addEventListener('pointerdown', (e) => !slip.contains(e.target) && !e.target.closest?.('.ov-tag') && moved('look'), true)
  const setPlace = (place) => {
    if (place === '') delete input.dataset.place
    else input.dataset.place = place
    const offer = input.dataset.offer ?? ''
    chip.classList.toggle('lit', place !== '')
    // Short enough for the chip, cut at a word; the whole place on hover.
    chip.textContent = place !== '' ? chipText(place, { lead: '' }) : chipText(offer, { tail: input.dataset.selected ? ' + selection' : '' })
    chip.title = place !== '' ? `${place}. Not about this` : `Add what you are looking at: ${offer}`
  }
  const togglePlace = () => {
    if (input.dataset.place) return setPlace('')
    setPlace(input.dataset.offer ?? '')
    moved('place-added')
  }

  // ── Hold to talk: the app records from key-down (the page's own mic took about a second to open, and every
  // dictation lost its first words), calls hold(true/false) for the listening state, and heard() with the WAV ──
  const UNSURE = 0.6
  const listening = (on) => {
    if (on) root.dataset.ovListening = ''
    else delete root.dataset.ovListening
    update()
  }
  // The key opens the slip the same way for a tap and for a hold: the app only knows which after 250 ms,
  // when it calls hold(true). So a summon that hears no hold by TAP_MS was a tap, by hand, and the panel
  // takes the keyboard. A hold, or a slip Gnomon opened itself, never asks: the app below keeps its keys.
  const TAP_MS = 320
  const tap = { timer: 0 }
  const byHand = () => {
    clearTimeout(tap.timer)
    tap.timer = setTimeout(() => {
      window.webkit?.messageHandlers?.focus?.postMessage(true)
      input?.focus({ preventScroll: true })
    }, TAP_MS)
  }
  const hold = (on) => {
    clearTimeout(tap.timer)
    listening(on)
  }
  /** The app's recording as base64 WAV, or null for a tap or a quiet room (whisper.cpp 1.9.x crashes on those). */
  const heard = async (b64) => {
    if (typeof b64 !== 'string' || b64 === '') return void (setNote('Nothing was heard.'), update())
    const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'audio/wav' })
    const got = await fetch('/gnomon/api/transcribe', { method: 'POST', headers: { 'content-type': blob.type }, body: blob }).then((r) => r.json()).catch(() => null)
    const text = typeof got?.text === 'string' ? got.text.trim() : ''
    if (text === '') return void (setNote(got?.unavailable ?? 'Nothing was heard.'), update())
    moved('talk')
    const sure = !(typeof got.confidence === 'number' && got.confidence < UNSURE)
    // An ask that waits takes a spoken yes or no as its answer, not as a new turn.
    if (sure && waiting() && (YES.test(text) || NO.test(text))) return answer(YES.test(text))
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (!sure || document.body.dataset.running === 'true') {
      // The words wait for Enter: the panel takes the keyboard so Enter lands here, not in the app below.
      window.webkit?.messageHandlers?.focus?.postMessage(true)
      return input.focus({ preventScroll: true })
    }
    input.dataset.spoken = JSON.stringify({ text, lang: got.language ?? null })
    bar?.requestSubmit()
  }

  /** Called by Sundial.app: on every summon, with the frontmost app; with the marks; while the key is held. */
  window.sundialOverlay = {
    marks: (list, only, judge) => void marks(Array.isArray(list) ? list : [], only === true, judge === true),
    hold: (on) => void hold(on),
    heard: (b64) => void heard(b64),
    summoned(info) {
      delete root.dataset.ovMarksOnly
      for (const k of ['summon', 'offer', 'selected']) delete input.dataset[k]
      offerDone = null
      if (aside?.done) aside = null
      if (typeof info?.keyName === 'string' && info.keyName !== '') keyName = info.keyName
      since = lastTurn()
      sentWords.text = ''
      note = ''
      figure = undefined
      pick()
      void readBoard()
      sent = ''
      if (!info?.quiet || typeof info.summonId !== 'string') {
        setPlace(placeOf(info))
        update()
        return input?.focus({ preventScroll: true })
      }
      // Quiet: no place until the owner attaches it. The cursor is in the field at once, which takes nothing
      // from the app below while the panel is not key; the keyboard itself follows only a tap (byHand).
      input?.focus({ preventScroll: true })
      byHand()
      first = true
      const offer = placeOf(info)
      const selected = typeof info.selected === 'string' ? info.selected.trim().slice(0, 2000) : ''
      Object.assign(input.dataset, { summon: info.summonId, ...(offer ? { offer } : {}), ...(offer && selected ? { selected } : {}) })
      setPlace('')
      update()
      const id = info.summonId
      fetch(`/gnomon/summon?id=${encodeURIComponent(id)}`, { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((s) => {
          // After 17:00 the still line is the day's (the Ledger's own line), else the summon's guess.
          const said = (evening(new Date()) && s?.day) || s?.line
          if (input.dataset.summon !== id || typeof said !== 'string') return
          setNote(said)
          update()
        })
        .catch(() => {})
    },
  }
  root.dataset.overlayReady = ''
  void readBoard()
  update()
}

if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-overlay')) boot()
