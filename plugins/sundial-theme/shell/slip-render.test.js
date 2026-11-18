// @vitest-environment jsdom
// @vitest-environment-options {"pretendToBeVisual": true}
// Set 3 R1: the slip drawn from a hidden conversation, state by state, as Sundial.app's panel shows it. The page is the
// real overlay.js booted over a minimal copy of index.html's composer, thread pill and model picker; the conversation is
// what app.js renders (turns, tool rows with their step frames, an approval card). Made-up values only.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountThreadPill } from './thread-pill.js'
import { el } from './surfaces.js'

const AT = '2026-11-15T10:42:08.000Z'
// The read as host/read-eye.js gives it (made up): the look's app, window and frame, the screen, the acted part and the ask's.
const LOOK = {
  key: 'look-7|act-7|',
  look: { id: 'look-7', at: AT, app: 'Finder', window: 'notes', frame: [40, 44, 700, 312] },
  screen: [0, 0, 1512, 982],
  acted: { role: 'AXMenuBarItem', label: 'File', area: 'menu bar', frame: [74, 3, 47, 18] },
  asked: { role: 'AXButton', label: 'Send', area: 'notes', frame: [600, 320, 72, 30] },
}
const SESSIONS = (now) => ({ sessions: [
  { id: 'gnomon-companion', title: '', lastPromptAt: new Date(now - 10_000).toISOString(), answer: 'The test on BOX-484 is green: 14 passed, 0 failed.' },
  { id: 'session-mira', title: 'Mira’s deck notes', lastPromptAt: new Date(now - 2 * 3600_000).toISOString(), answer: null },
  { id: 'session-box', title: 'BOX-484 test', lastPromptAt: new Date(now - 12 * 60_000).toISOString(), answer: 'Renamed notes.txt to notes-old.txt in Finder.' },
], picked: null })

const settle = () => new Promise((r) => setTimeout(r, 40))
/** Every URL the page fetched, what the Mac app was told about the composer, and what the next transcription hears. */
const CALLS = []
/** The body each call sent, beside CALLS. */
const BODIES = []
const COMPOSER = []
/** What the Mac app was told about the slip's own rect (the screen stage keeps clear of it). */
const SLIPS = []
const HEARD = { text: '', confidence: 0.95, language: 'en' }
/** The Ledger's day line the summon read carries (Set 4 R2), when a test sets one. */
const DAY = { line: null }
const q = (s) => document.querySelector(s)
const text = (s) => q(s)?.textContent ?? ''
const shown = (s) => Boolean(q(s)) && !q(s).hidden
const state = () => document.documentElement.dataset.ovState
const ghost = () => document.getElementById('ghost')

beforeAll(async () => {
  document.documentElement.setAttribute('data-overlay', 'slip')
  document.body.innerHTML = `<form id="bar"><textarea id="input" placeholder="Talk to Gnomon…"></textarea></form>
    <div class="model" id="model"><button type="button" class="model-pick" id="model-pick"><span class="model-provider" id="model-provider">openai</span><span class="model-name" id="model-name">flash-4</span></button><div class="model-menu" id="model-menu" hidden></div></div>
    <div class="model" id="thread" hidden><button type="button" class="model-pick" id="thread-pick" aria-expanded="false"><span class="model-provider">Thread</span><span class="model-name" id="thread-name">Gnomon</span></button><div class="model-menu" id="thread-menu" role="listbox" hidden></div></div>
    <div id="ghost"></div>`
  // app.js would answer the bar's submit; here it only must not navigate.
  document.getElementById('bar').addEventListener('submit', (e) => e.preventDefault())
  globalThis.ResizeObserver = class { observe() {} }
  globalThis.matchMedia = () => ({ matches: true })
  Element.prototype.scrollIntoView = () => {}
  globalThis.fetch = async (url, init) => (CALLS.push(String(url)), BODIES.push(init?.body ?? null), { ok: true, status: 200, json: async () => (String(url).startsWith('/gnomon/api/eye') ? LOOK : String(url).startsWith('/gnomon/summon') ? { line: 'You are back on BOX-484. The test is still red.', day: DAY.line } : String(url).startsWith('/gnomon/api/sessions') ? SESSIONS(Date.now()) : String(url).startsWith('/gnomon/api/transcribe') ? HEARD : String(url).startsWith('/gnomon/api/offer') ? { ran: true, said: 'pnpm test (exit 1); the export step failed after 38 s.' } : {}) })
  window.webkit = { messageHandlers: { composer: { postMessage: (on) => COMPOSER.push(on) }, focus: { postMessage() {} }, regions: { postMessage() {} }, slip: { postMessage: (r) => SLIPS.push(r) } } }
  mountThreadPill({ state: { sessionId: null }, el, $: (id) => document.getElementById(id), COMPANION_SESSION_ID: 'gnomon-companion', loadModels() {} })
  await import('./overlay.js')
  await settle()
})

describe('the slip, drawn state by state from the hidden conversation', () => {
  it('still: the summon\'s one line in the field\'s place, the place offered as a chip, nothing above the row', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's1', app: 'Finder', title: 'notes' })
    await settle()
    expect(state()).toBe('still')
    expect(text('.ov-one-line')).toBe('You are back on BOX-484. The test is still red.')
    expect(q('.ov-glyph').dataset.mark).toBe('gn')
    expect(text('.ov-chip')).toBe('Add Finder: notes')
    expect(shown('.ov-hint')).toBe(false)
    // The ruler is the slip's constant top edge: still ticks at rest, so the slip never changes height for a state.
    expect(q('.ov-scale').hidden).toBe(false)
    expect(q('.ov-scale').dataset.mode).toBe('still')
    expect(text('#thread-name')).toBe('Gnomon')
    expect(q('.ov-tick').firstElementChild.className).toBe('ov-one')
    // Nothing is added at rest: no locator.
    expect(q('.ov-loc-row').hidden).toBe(true)
    expect(q('.ov-askloc').hidden).toBe(true)
  })

  it("the row's glyph never hides the rings on the screen: the marks keep their own class", async () => {
    // The rings are g.ov-mark in the marks layer; a rule that hid .ov-mark > * once took every ring off the screen.
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css.match(/\.ov-mark(?![-\w])[^{]*\{[^}]*display:\s*none/g) ?? []).toEqual([])
    window.sundialOverlay.marks([{ id: 'm1', x: 300, y: 200, w: 60, h: 24, shape: 'ring', step: 3, label: 'Send' }])
    await settle()
    expect(document.querySelectorAll('.ov-marks g.ov-mark rect')).toHaveLength(2)
    expect(document.querySelectorAll('.ov-glyph')).toHaveLength(1)
    window.sundialOverlay.marks([])
    await settle()
  })

  it('the Mac app is told the slip\'s own rect, apart from the tags and the sheet: the screen stage keeps clear of that alone', async () => {
    // jsdom lays nothing out: the slip is given its box (560 by 80, 36 off the bottom of jsdom's 1024 by 768), a tag one far from it.
    const slip = q('.ov-slip')
    const tag = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'ov-tag' }))
    slip.getClientRects = tag.getClientRects = () => [{}]
    slip.getBoundingClientRect = () => ({ left: 232, top: 652, right: 792, bottom: 732 })
    tag.getBoundingClientRect = () => ({ left: 100, top: 100, right: 300, bottom: 140 })
    window.sundialOverlay.marks([{ id: 'm2', x: 120, y: 100, w: 60, h: 24, shape: 'ring' }])
    await settle()
    expect(SLIPS.at(-1)).toEqual({ x: 228, y: 648, w: 568, h: 88 })
    tag.remove()
    delete slip.getClientRects
    delete slip.getBoundingClientRect
    window.sundialOverlay.marks([])
    await settle()
  })

  it('typing replaces the line', async () => {
    const input = q('#input')
    input.value = 'rename'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(q('.ov-one-line').hidden).toBe(true)
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(q('.ov-one-line').hidden).toBe(false)
  })

  it('listen: the ink wave and one line', async () => {
    window.sundialOverlay.hold(true)
    await settle()
    expect(state()).toBe('listen')
    expect(text('.ov-one-line')).toBe('Listening. Let go to send.')
    expect(q('.ov-scale').dataset.mode).toBe('listen')
    window.sundialOverlay.hold(false)
    await settle()
  })

  it('think: the owner\'s words in quotes, the ochre head running, the readout counting', async () => {
    document.body.dataset.running = 'true'
    const turn = el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'rename notes.txt in Finder' })])
    ghost().append(turn)
    await settle()
    expect(state()).toBe('think')
    expect(text('.ov-one-line')).toBe('“rename notes.txt in Finder”')
    expect(q('.ov-scale').dataset.mode).toBe('think')
    expect(text('.ov-ro b')).toBe('thinking')
    expect(q('.ov-glyph').dataset.mark).toBe('dot')
  })

  it('doing: the step line, the readout (step, app, time, model), Stop, the last steps, and the eye card with the same step', async () => {
    const turn = ghost().lastElementChild
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-main', title: 'screen_act' }), el('span', { class: 'tool-verb', text: 'Acting' }), el('span', { class: 'tool-arg', text: 'Finder' })])
    Object.assign(row, { _args: { app: 'Finder', action: 'pick-menu', value: 'File' }, _t0: performance.now() - 2_000 })
    Object.assign(row.dataset, { step: 'Open the File menu in Finder', steps: '7' })
    turn.append(row)
    await settle()
    expect(state()).toBe('doing')
    expect(text('.ov-one-line')).toBe('Open the File menu in Finder')
    expect(text('.ov-ro b')).toBe('step 7 · Finder')
    expect(text('.ov-ro .ov-stag')).toBe('7')
    expect(text('.ov-ro > span:last-child')).toMatch(/^0:0\d · model \d\.\d s$/)
    expect(shown('.ov-slot .ov-btn')).toBe(true)
    expect(q('#input').placeholder).toBe('')
    expect(shown('.ov-laps')).toBe(true)
    // The running step keeps its square and its clock; its words are the line just below, so they are not said twice.
    expect(text('.ov-laps li.now')).toMatch(/^7\d\.\d s…$/)
    await settle()
    // Where and what, inside the slip above the last steps: the step's square (the readout's), the part, its kind and area,
    // then the app, the window and where on the screen; the 72 px screen with the one ochre mark beside them.
    expect(q('.ov-loc-row').hidden).toBe(false)
    expect(q('.ov-loc-row').nextElementSibling).toBe(q('.ov-laps'))
    expect(text('.ov-loc-row .ov-stag')).toBe(text('.ov-ro .ov-stag'))
    expect(text('.ov-loc-what')).toBe('7File· menu in the menu bar')
    expect(text('.ov-loc-row p:last-child')).toBe('Finder · notes · top left of the screen')
    expect(q('.ov-loc-row svg.ov-loc').getAttribute('width')).toBe('72')
    expect(q('.ov-loc-row svg.ov-loc').querySelectorAll('rect.ov-loc-hit')).toHaveLength(1)
    const { SOLID } = await import('./overlay.js')
    expect(SOLID).not.toMatch(/ov-eye/)
    expect(document.querySelector('.ov-eye')).toBeNull()
  })

  it('ask: the kind and target, the gate\'s sentence, its detail rows, Do it and No; Enter with yes answers it', async () => {
    const turn = ghost().lastElementChild
    const yes = el('button', { text: 'Approve' })
    const no = el('button', { text: 'Reject' })
    let said = null
    yes.onclick = () => (said = 'yes')
    no.onclick = () => (said = 'no')
    const card = el('div', { class: 'approval' }, [el('span', { class: 'approval-tool', text: 'screen_act' }), el('div', { class: 'approval-acts' }, [yes, no])])
    card._ask = { id: 'a1', tool: 'screen_act', args: { app: 'Zen', role: 'button', label: 'Send', because: 'Mira Bakker asked for the result before noon' }, reason: 'Gnomon: this sends a mail or a message with "Send" in Zen (window "New message"), which cannot be taken back, so it asks you first. Press "Send" in Zen · To: test@example.com · final: send' }
    turn.append(card)
    await settle()
    expect(state()).toBe('ask')
    expect(shown('.ov-askb')).toBe(true)
    expect(text('.ov-kind')).toBe('Send')
    expect(text('.ov-where')).toBe('Send in Zen · final step')
    expect(text('.ov-askb .ov-ask-line')).toBe('This sends a mail or a message with "Send" in Zen (window "New message"), which cannot be taken back.')
    expect([...document.querySelectorAll('.ov-detail dt')].map((n) => n.textContent)).toEqual(['Step', 'To'])
    expect(text('.ov-askb .ov-said')).toBe("Gnomon's reason: Mira Bakker asked for the result before noon")
    expect(text('.ov-ro b')).toBe('waits for your yes')
    expect(text('.ov-ro .ov-stag')).toBe('8')
    expect(q('#input').placeholder).toBe('Type yes or no')
    expect(text('.ov-hint')).toBe('Enter')
    // The locator stands right of the sentence and marks where the yes will press; the doing row is gone.
    expect(q('.ov-askloc').hidden).toBe(false)
    expect(q('.ov-askhead').contains(q('.ov-askloc'))).toBe(true)
    expect(text('.ov-askloc figcaption')).toBe('Send · bottom right')
    // One line that never breaks mid-phrase: the label (which may give way) and the place (which stays whole) are two runs.
    expect([...q('.ov-askloc figcaption').children].map((n) => n.textContent)).toEqual(['Send', ' · bottom right'])
    expect(q('.ov-loc-row').hidden).toBe(true)
    // One control slot: while it asks, the slot is the Enter that answers, not Stop (Alt+. still stops).
    expect(shown('.ov-slot .ov-btn')).toBe(false)
    expect(shown('.ov-hint')).toBe(true)
    q('#input').value = 'yes'
    q('#bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(said).toBe('yes')
    q('.ov-askb .ov-acts .ov-btn:nth-child(2)').click()
    expect(said).toBe('no')
  })

  it('ask, ringed on screen: one line in the slip; the tag beside the ring carries the sentence and Do it', async () => {
    window.sundialOverlay.marks([{ id: 'ask:a1', x: 300, y: 200, w: 60, h: 24, shape: 'ring' }])
    await settle()
    expect(state()).toBe('ringed')
    expect(text('.ov-one-line')).toBe('Waits for your yes.')
    expect(shown('.ov-askb')).toBe(false)
    expect(text('.ov-tag.ov-ask .ov-ask-line')).toMatch(/^This sends a mail/)
    // The ring and its tag are the picture now: no locator in the slip, so three things at most are up at once.
    expect(q('.ov-askloc').hidden).toBe(true)
    expect(q('.ov-loc-row').hidden).toBe(true)
    ghost().lastElementChild.querySelector('.approval').dataset.settled = ''
    window.sundialOverlay.marks([])
    await settle()
  })

  it('answer: the reply whole above the field, answered-at in the readout, no locator', async () => {
    const turn = ghost().lastElementChild
    Object.assign(turn.querySelector('.tool'), { _result: 'ok', _ms: 300 })
    turn.append(el('div', { class: 'prose' }, [el('p', { text: 'The test on BOX-484 is green: 14 passed, 0 failed.' })]))
    document.body.dataset.running = 'false'
    await settle()
    expect(state()).toBe('answer')
    expect(shown('.ov-answer')).toBe(true)
    expect(text('.ov-answer .ov-line')).toBe('The test on BOX-484 is green: 14 passed, 0 failed.')
    expect(text('.ov-ro b')).toMatch(/^answered \d\d:\d\d$/)
    expect(text('.ov-ro > span:last-child')).toMatch(/^in \d\.\d s · model \d\.\d s$/)
    expect(q('#input').placeholder).toBe('Talk to Gnomon…')
    expect(q('.ov-loc-row').hidden).toBe(true)
  })

  it('guide: the step and its parts on the edge, esc ends it', async () => {
    window.sundialOverlay.marks([{ id: 'guide:g1', x: 300, y: 200, w: 60, h: 24, shape: 'ring', step: 2, of: 5 }])
    await settle()
    expect(state()).toBe('guide')
    expect(text('.ov-one-line')).toBe('Step 2 of 5. The ring moves when you do it.')
    expect(q('.ov-scale').dataset.mode).toBe('steps')
    expect(text('.ov-hint')).toBe('esc')
    window.sundialOverlay.marks([])
    await settle()
  })

  it('offer: the notice\'s own line and its one quiet button; a press shows what came back in its place', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's2' })
    // As the hidden strip draws it (verdicts.js offerChip): the notice's words ride on `data-line`.
    document.body.append(el('div', { 'data-offer': 'stuck:build', 'data-line': 'The puzzlebox-studio build is red since 09:40.' }, [el('button', { text: 'Show the failing run' })]))
    await settle()
    expect(state()).toBe('offer')
    expect(text('.ov-one-line')).toBe('The puzzlebox-studio build is red since 09:40.')
    expect(text('.ov-offer .ov-btn')).toBe('Show the failing run')
    q('.ov-offer .ov-btn').click()
    // The strip drops a taken offer: the line and the result stay.
    document.querySelector('[data-offer]').remove()
    await settle()
    expect(CALLS).toContain('/gnomon/api/offer')
    expect(q('.ov-offer .ov-btn')).toBeNull()
    expect(text('.ov-offer small')).toBe('pnpm test (exit 1); the export step failed after 38 s.')
    expect(q('.ov-offer small').title).toBe('Also in the conversation.')
    expect(state()).toBe('offer')
    expect(text('.ov-one-line')).toBe('The puzzlebox-studio build is red since 09:40.')
    window.sundialOverlay.summoned({ quiet: true, summonId: 's2b' })
    await settle()
    expect(shown('.ov-offer')).toBe(false)
  })

  it('offline: the breaker\'s own line once the turn ends with no answer', async () => {
    document.body.dataset.running = 'true'
    ghost().append(el('div', { class: 'turn' }, [el('div', { class: 'log-line', 'data-key': 'llm:hedge' }, [el('span', { class: 'log-line-label', text: 'The model is not answering, trying the backup.' })])]))
    await settle()
    expect(text('.ov-one-line')).toBe('The model is not answering, trying the backup.')
    document.body.dataset.running = 'false'
    await settle()
    expect(state()).toBe('stopped')
    expect(text('.ov-one-line')).toBe('The model is not answering, trying the backup.')
  })

  it("the owner's hand: pushed onto the running screen step's row, it says Gnomon waits above the row, and stays while the owner types in the slip", async () => {
    document.body.dataset.running = 'true'
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-main', title: 'screen_act' }), el('span', { class: 'tool-verb', text: 'Acting' })])
    Object.assign(row, { _args: { app: 'Finder' }, _t0: performance.now() - 1_000 })
    Object.assign(row.dataset, { step: 'Select notes.txt', steps: '2' })
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'tidy the notes folder' }), row]))
    await settle()
    expect(text('.ov-one-line')).toBe('Select notes.txt')
    expect(shown('.ov-waits')).toBe(false)
    // app.js marks the row from the host's push (a `step` frame with `hand`, owner-hand.js onHold): nothing is asked.
    row.setAttribute('data-hand', '')
    await settle()
    expect(state()).toBe('doing')
    expect(text('.ov-waits')).toBe('Waiting: your hands are on the keys.')
    expect(q('.ov-waits').classList.contains('hand')).toBe(true)
    // The step keeps its words in the row and its square in the readout.
    expect(text('.ov-one-line')).toBe('Select notes.txt')
    expect(text('.ov-ro .ov-stag')).toBe('2')
    // The owner types in the slip's own field: the field's line goes, the hand's line stays (it is above the row).
    q('#input').value = 'use the other folder'
    q('#input').dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    expect(q('.ov-one-line').hidden).toBe(true)
    expect(shown('.ov-waits')).toBe(true)
    expect(text('.ov-waits')).toBe('Waiting: your hands are on the keys.')
    q('#input').value = ''
    q('#input').dispatchEvent(new Event('input', { bubbles: true }))
    row.removeAttribute('data-hand')
    await settle()
    expect(shown('.ov-waits')).toBe(false)
    // A finished step's stale mark says nothing.
    row.setAttribute('data-hand', '')
    Object.assign(row, { _result: 'ok', _ms: 200 })
    document.body.dataset.nudge = 'done'
    await settle()
    expect(shown('.ov-waits')).toBe(false)
    // Push, not polling: the slip never asks the host about the hand.
    expect(CALLS.some((u) => u.startsWith('/gnomon/api/hand'))).toBe(false)
    document.body.dataset.running = 'false'
    await settle()
  })

  it('stopped: Alt+. stops it, and the line says where', async () => {
    document.body.dataset.running = 'true'
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-verb', text: 'Acting' })])
    Object.assign(row, { _args: { app: 'Finder' } })
    Object.assign(row.dataset, { step: 'Select notes.txt', steps: '4' })
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'tidy the notes folder' }), row]))
    await settle()
    expect(state()).toBe('doing')
    dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'Period', bubbles: true }))
    document.body.dataset.running = 'false'
    await settle()
    expect(state()).toBe('stopped')
    expect(text('.ov-one-line')).toBe('Stopped at step 4 in Finder.')
    expect(text('.ov-ro b')).toMatch(/^stopped \d\d:\d\d$/)
  })
})

describe('the thread head', () => {
  it('Alt+L opens the list upward: the companion, the side threads newest first with age, New thread, the model last', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    expect(q('#thread-menu').hidden).toBe(false)
    expect([...document.querySelectorAll('.thread-opt .thread-title')].map((n) => n.textContent)).toEqual(['Gnomoncompanion', 'BOX-484 test', 'Mira’s deck notes'])
    expect([...document.querySelectorAll('.thread-opt .thread-age')].map((n) => n.textContent)).toEqual(['now', '12 min', '2 h'])
    // Each thread's last answer, its first words on one line under the name; a thread with none shows no empty line.
    expect([...document.querySelectorAll('.thread-opt')].map((n) => n.querySelector('.thread-last')?.textContent ?? null)).toEqual(['The test on BOX-484 is green: 14 passed, 0 failed.', 'Renamed notes.txt to notes-old.txt in Finder.', null])
    expect(q('.thread-opt[aria-selected="true"] .thread-title').textContent).toBe('Gnomoncompanion')
    expect(text('.thread-new')).toBe('New thread⌥K')
    const last = q('#thread-menu').lastElementChild
    expect(last.className).toBe('thread-model')
    expect(last.querySelector('#model')).not.toBeNull()
    expect(text('.ov-hint')).toBe('esc')
    q('.thread-opt:nth-child(2)').click()
    await settle()
    expect(q('#thread-menu').hidden).toBe(true)
    expect(text('#thread-name')).toBe('BOX-484 test')
  })
})

describe('an ask never outlives its settlement or its turn (the owner: "yes or no questions stay indefinitely")', () => {
  /** A turn that asks first, as app.js draws it: the card's buttons turn off on a press (app.js `answer`), and it is the turn's own. */
  const asking = (words = 'send the result to Mira Bakker') => {
    window.sundialOverlay.summoned({ quiet: true, summonId: `s-${Math.random()}` })
    document.body.dataset.running = 'true'
    const acts = el('div', { class: 'approval-acts' })
    const off = () => acts.querySelectorAll('button').forEach((b) => (b.disabled = true))
    acts.append(el('button', { text: 'Allow once', onclick: off }), el('button', { text: 'No', onclick: off }))
    const card = el('div', { class: 'approval' }, [el('span', { class: 'approval-tool', text: 'screen_act' }), acts])
    card._ask = { id: `a-${Math.random()}`, tool: 'screen_act', args: { app: 'Zen', role: 'button', label: 'Send' }, reason: 'Gnomon: this sends a mail or a message with "Send" in Zen, which cannot be taken back, so it asks you first. Press "Send" in Zen · To: test@example.com · final: send' }
    const turn = el('div', { class: 'turn' }, [el('p', { class: 'said', text: words }), card])
    ghost().append(turn)
    return { card, turn }
  }
  const asks = () => state() === 'ask' || state() === 'ringed' || shown('.ov-askb') || Boolean(q('.ov-tag.ov-ask'))

  it('answered from the slip (Do it, or a typed or spoken yes): gone the moment it is pressed, before any close comes back', async () => {
    const { card } = asking()
    await settle()
    expect(state()).toBe('ask')
    q('.ov-askb .ov-go').click()
    await settle()
    expect(asks()).toBe(false)
    card.dataset.settled = ''
    document.body.dataset.running = 'false'
    await settle()
  })

  it('answered anywhere else (the rig\'s yes-clicker, the board, a timeout): app.js marks it settled and the slip lets go', async () => {
    const { card } = asking()
    window.sundialOverlay.marks([{ id: `ask:${card._ask.id}`, x: 300, y: 200, w: 60, h: 24, shape: 'ring' }])
    await settle()
    expect(state()).toBe('ringed')
    card.dataset.settled = ''
    await settle()
    expect(asks()).toBe(false)
    window.sundialOverlay.marks([])
    document.body.dataset.running = 'false'
    await settle()
  })

  it('its turn ended with the close lost (a stopped turn, a stream that closed first): it never outlives its turn', async () => {
    const { turn } = asking()
    await settle()
    expect(state()).toBe('ask')
    turn.setAttribute('data-ended', '')
    document.body.dataset.running = 'false'
    await settle()
    expect(asks()).toBe(false)
    turn.querySelector('.approval').dataset.settled = ''
  })

  it('a newer turn began while an older card was never closed: the old ask is not the slip\'s any more', async () => {
    const { card } = asking()
    await settle()
    expect(state()).toBe('ask')
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'what is in notes' })]))
    await settle()
    expect(asks()).toBe(false)
    expect(state()).toBe('think')
    document.body.dataset.running = 'false'
    card.dataset.settled = ''
    await settle()
  })

  it('other words while it waits are the owner\'s no and their next instruction: the ask goes at once, the words go to the turn', async () => {
    const { card } = asking()
    await settle()
    const corrected = []
    const take = (e) => corrected.push(e.detail.text)
    document.addEventListener('gnomon:correct', take)
    q('#input').value = 'send it to the other address instead'
    q('#bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    document.removeEventListener('gnomon:correct', take)
    await settle()
    expect([...card.querySelectorAll('button')].every((b) => b.disabled)).toBe(true)
    expect(asks()).toBe(false)
    expect(corrected).toEqual(['send it to the other address instead'])
    // What the slip heard, until the turn shows a step: the owner's own new words, not the turn's first ones.
    expect(text('.ov-one-line')).toBe('“send it to the other address instead”')
    card.dataset.settled = ''
    document.body.dataset.running = 'false'
    await settle()
  })

  it('a card the host marked dead after a restart (no `_ask`) is never offered, and an older live card behind it is not dug up', async () => {
    const { card, turn } = asking()
    const dead = el('div', { class: 'approval' }, [el('div', { class: 'approval-acts' }, [el('button', { text: 'Allow once' })])])
    turn.append(dead)
    card.dataset.settled = ''
    await settle()
    expect(asks()).toBe(false)
    document.body.dataset.running = 'false'
    dead.dataset.settled = ''
    await settle()
  })
})

describe('the second naturalness pass (run202 T03, run200 T01)', () => {
  it('a minute of thinking with no step says so above the row, with the minutes and the way out, and the minutes move on', async () => {
    const real = performance.now.bind(performance)
    let ahead = 0
    performance.now = () => real() + ahead
    try {
      window.sundialOverlay.summoned({ quiet: true, summonId: 's-still' })
      document.body.dataset.running = 'true'
      ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'read the ledger and look it up' })]))
      await settle()
      expect(state()).toBe('think')
      expect(shown('.ov-waits')).toBe(false)
      ahead = 61_000
      document.body.dataset.nudge = 'still-1'
      await settle()
      expect(text('.ov-waits')).toBe('Still thinking, 1 min, no step yet. ⌥. stops it.')
      ahead = 5 * 60_000 + 4_000
      document.body.dataset.nudge = 'still-5'
      await settle()
      expect(text('.ov-waits')).toBe('Still thinking, 5 min, no step yet. ⌥. stops it.')
    } finally {
      performance.now = real
      document.body.dataset.running = 'false'
      await settle()
    }
  })

  it('the place chip shows the window name alone when the whole place does not fit, the whole place on hover', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-chip', app: 'Finder', title: 'Testbox-rename' })
    await settle()
    expect(text('.ov-chip')).toBe('Add Testbox-rename')
    expect(q('.ov-chip').title).toBe('Add what you are looking at: Finder: Testbox-rename')
  })

  it('a dead card, or one left in an ended turn, never holds the thread: Alt+L opens the list', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-busy' })
    document.body.dataset.running = 'false'
    const dead = el('div', { class: 'approval' }, [el('div', { class: 'approval-acts' }, [el('button', { text: 'Allow once' })])])
    const stale = el('div', { class: 'approval' }, [el('div', { class: 'approval-acts' }, [el('button', { text: 'Allow once' })])])
    stale._ask = { id: 'a-stale', tool: 'screen_act', args: {}, reason: 'Gnomon: x' }
    ghost().append(el('div', { class: 'turn', 'data-ended': '' }, [el('p', { class: 'said', text: 'old task' }), stale]), el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'after a restart' }), dead]))
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    expect(q('#thread-menu').hidden).toBe(false)
    expect(q('#thread').dataset.refused).toBeUndefined()
    q('#thread-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    dead.dataset.settled = ''
    stale.dataset.settled = ''
    await settle()
  })
})

describe('Enter shows what was just said (run199 T21 0:08: the last answer flashed back with a Stop beside it)', () => {
  it('between Enter and the new turn, the words just sent: never the summoned turn\'s old answer', async () => {
    document.body.dataset.running = 'false'
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'discard the draft' }), el('div', { class: 'prose' }, [el('p', { text: 'The draft was discarded without sending.' })])]))
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-enter' })
    await settle()
    q('#input').value = 'what is 19 times 12'
    q('#bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    // app.js marks the turn running at once and draws its turn a moment later.
    document.body.dataset.running = 'true'
    await settle()
    expect(state()).toBe('think')
    expect(shown('.ov-answer')).toBe(false)
    expect(text('.ov-one-line')).toBe('“what is 19 times 12”')
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'what is 19 times 12' })]))
    await settle()
    expect(text('.ov-one-line')).toBe('“what is 19 times 12”')
    document.body.dataset.running = 'false'
    await settle()
  })
})

describe('Set 4 R2: the slip carries a day', () => {
  const submit = (words) => {
    q('#input').value = words
    q('#bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  /** A turn's stream as the host sends it, fed one frame at a time by `push`. */
  const stream = () => {
    const queue = []
    let wake = null
    const push = (frame) => (queue.push(frame === null ? { done: true } : { done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`) }), wake?.())
    const read = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => (wake = () => ((wake = null), r(queue.shift())))))
    return { push, response: { body: { getReader: () => ({ read }) } } }
  }

  it('a second question while a task runs: the head shows both, its answer shows under the running task, which goes on', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-aside' })
    document.body.dataset.running = 'true'
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-main', title: 'screen_act' }), el('span', { class: 'tool-verb', text: 'Acting' })])
    Object.assign(row, { _args: { app: 'Finder' }, _t0: performance.now() - 1_000 })
    Object.assign(row.dataset, { step: 'Renaming 3 files', steps: '2' })
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'rename the 3 files in Testbox' }), row]))
    await settle()
    const { push, response } = stream()
    document.dispatchEvent(new CustomEvent('gnomon:aside', { detail: { text: 'what is 14 percent of 380', response } }))
    await settle()
    expect(state()).toBe('doing')
    expect(text('.ov-one-line')).toBe('Renaming 3 files · and: what is 14 percent of 380')
    expect(text('.ov-aside')).toBe('and: what is 14 percent of 380Working on it…')
    push({ type: 'text', delta: '14 percent of 380 is ' })
    push({ type: 'text', delta: '**53.2**.' })
    push({ type: 'done', reason: 'complete' })
    await settle()
    expect(text('.ov-aside span')).toBe('14 percent of 380 is 53.2.')
    // The running task is not stopped and not hidden: its step, its readout and Stop stay.
    expect(state()).toBe('doing')
    expect(text('.ov-ro b')).toBe('step 2 · Finder')
    expect(shown('.ov-slot .ov-btn')).toBe(true)
    push(null)
    document.body.dataset.running = 'false'
    await settle()
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-aside-2' })
    await settle()
    expect(shown('.ov-aside')).toBe(false)
  })

  it('a long job on the shelf: still, with the shelf line and no Stop, and the next words wait for a fresh turn, never a steer', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-shelf' })
    document.body.dataset.running = 'true'
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-main', title: 'gnomon_await' }), el('span', { class: 'tool-verb', text: 'Waiting' })])
    Object.assign(row, { _args: { job: 'job-7', seconds: 120 }, _t0: performance.now() - 500, _result: 'On the shelf: Waiting for the build, I will knock.\nThe job job-7 runs on.', _ms: 20 })
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'run the build' }), row]))
    await settle()
    expect(state()).toBe('still')
    expect(text('.ov-one-line')).toBe('Waiting for the build, I will knock.')
    expect(shown('.ov-slot .ov-btn')).toBe(false)
    const steered = []
    const listen = (e) => steered.push(e.detail.text)
    document.addEventListener('gnomon:correct', listen)
    submit('what time is it in Lisbon')
    await settle()
    document.removeEventListener('gnomon:correct', listen)
    expect(steered).toEqual([])
    expect(text('.ov-waits')).toBe('Sends when this is done: “what time is it in Lisbon”')
    document.body.dataset.running = 'false'
    await settle()
  })

  it('stopped, offline and withdrawn from one reader: a withdrawn turn says "I dropped that, ask again"', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-drop' })
    await settle()
    document.body.dataset.running = 'true'
    const turn = el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'tidy the notes folder' })])
    ghost().append(turn)
    await settle()
    // The host's watchdog withdrew it (api-sessions.js): its error line, then the turn ends.
    turn.append(el('div', { class: 'fail', text: 'I dropped that, ask again.' }))
    document.body.dataset.running = 'false'
    await settle()
    expect(state()).toBe('stopped')
    expect(text('.ov-one-line')).toBe('I dropped that, ask again.')
    ghost().append(el('div', { class: 'turn' }, [el('div', { class: 'log-line', 'data-key': 'llm:s1' }, [el('span', { class: 'log-line-label', text: 'No model is answering: the backup, backup, did not answer either. Try again in a minute.' })])]))
    await settle()
    expect(text('.ov-one-line')).toBe('No model is answering: the backup, backup, did not answer either. Try again in a minute.')
  })

  it('the evening line: summoned after 17:00 the still line is the day\'s, from the Ledger\'s read; before, the summon\'s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    DAY.line = 'Gnomon did 14 steps in 3 apps today, asked 2 times, you said yes 2.'
    try {
      document.body.dataset.running = 'false'
      vi.setSystemTime(new Date(2026, 10, 16, 18, 5))
      window.sundialOverlay.summoned({ quiet: true, summonId: 's-evening' })
      await settle()
      expect(state()).toBe('still')
      expect(text('.ov-one-line')).toBe(DAY.line)
      expect(CALLS.at(-1)).toBe('/gnomon/summon?id=s-evening')
      vi.setSystemTime(new Date(2026, 10, 16, 10, 5))
      window.sundialOverlay.summoned({ quiet: true, summonId: 's-morning' })
      await settle()
      expect(text('.ov-one-line')).toBe('You are back on BOX-484. The test is still red.')
      // "What did you do today" asked of the slip: the same line, one read, and no turn.
      const sent = []
      const count = () => sent.push(1)
      q('#bar').addEventListener('submit', count)
      submit('What did you do today?')
      await settle()
      q('#bar').removeEventListener('submit', count)
      expect(sent).toEqual([])
      expect(state()).toBe('still')
      expect(text('.ov-one-line')).toBe(DAY.line)
      // Run 227 T32: and what it said is on the record (overlay:day-said), the rig's answer: no turn writes a chat:said for it.
      expect(CALLS.slice(-2)).toEqual(['/gnomon/summon', '/gnomon/api/overlay'])
      expect(JSON.parse(BODIES.at(-1))).toEqual({ type: 'day-said', line: DAY.line, summonId: 's-morning' })
    } finally {
      DAY.line = null
      vi.useRealTimers()
    }
  })
})

describe('the review fixes (Fable, s3r1/slip-eye)', () => {
  /** A fresh turn that waits on a final: the approval card app.js draws, and which of its buttons was pressed. */
  const asking = (running) => {
    window.sundialOverlay.summoned({ quiet: true, summonId: `s-${Math.random()}` })
    document.body.dataset.running = String(running)
    const pressed = []
    const yes = el('button', { text: 'Approve', onclick: () => pressed.push('yes') })
    const no = el('button', { text: 'Reject', onclick: () => pressed.push('no') })
    const card = el('div', { class: 'approval' }, [el('span', { class: 'approval-tool', text: 'screen_act' }), el('div', { class: 'approval-acts' }, [yes, no])])
    card._ask = { id: `a-${Math.random()}`, tool: 'screen_act', args: { app: 'Zen', role: 'button', label: 'Send' }, reason: 'Gnomon: this sends a mail or a message with "Send" in Zen, which cannot be taken back, so it asks you first. Press "Send" in Zen · To: test@example.com · final: send' }
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'send the result to Mira Bakker' }), card]))
    return { card, pressed }
  }
  const submit = (words) => {
    q('#input').value = words
    q('#bar').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  }
  const done = (card) => {
    card.dataset.settled = ''
    document.body.dataset.running = 'false'
  }

  it('H2: a typed yes with more words is a correction, never an approval (it is the owner\'s no to the ask as put); a bare yes or no answers', async () => {
    const { YES, NO } = await import('./overlay.js')
    for (const words of ['ok but change the recipient first', 'Yes, after you fix the subject', 'no wait, use the other address', 'go ahead and add Mira Bakker too']) expect(YES.test(words) || NO.test(words), words).toBe(false)
    for (const words of ['yes', 'Yes.', ' ok ', 'do it!', 'Ja']) expect(YES.test(words), words).toBe(true)
    for (const words of ['no', 'No.', 'stop', "don't"]) expect(NO.test(words), words).toBe(true)
    const { card, pressed } = asking(true)
    await settle()
    const corrected = []
    const take = (e) => corrected.push(e.detail.text)
    document.addEventListener('gnomon:correct', take)
    submit('ok but change the recipient first')
    document.removeEventListener('gnomon:correct', take)
    // Never the yes. The act as asked is not what the owner wants: the ask gets their no, so the call stops waiting and the
    // turn reads the correction now (left open, it held the words up to the ask's 5 minute timeout).
    expect(pressed).toEqual(['no'])
    expect(corrected).toEqual(['ok but change the recipient first'])
    done(card)
    await settle()
    const again = asking(true)
    await settle()
    submit('yes')
    expect(again.pressed).toEqual(['yes'])
    done(again.card)
    await settle()
  })

  it('H2: a spoken "Yes, after you fix the subject" is words for the field, not an approval', async () => {
    const { card, pressed } = asking(true)
    await settle()
    HEARD.text = 'Yes, after you fix the subject'
    await window.sundialOverlay.heard('UklGRg==')
    await settle()
    expect(pressed).toEqual([])
    expect(q('#input').value).toBe('Yes, after you fix the subject')
    HEARD.text = 'yes'
    q('#input').value = ''
    await window.sundialOverlay.heard('UklGRg==')
    await settle()
    expect(pressed).toEqual(['yes'])
    done(card)
    await settle()
  })

  it('M1: an ask delivered while no turn runs takes a typed yes too, instead of sending "yes" as a message', async () => {
    const { card, pressed } = asking(false)
    await settle()
    expect(q('#input').placeholder).toBe('Type yes or no')
    const sent = []
    const app = () => sent.push(q('#input').value)
    q('#bar').addEventListener('submit', app)
    submit('yes')
    q('#bar').removeEventListener('submit', app)
    expect(pressed).toEqual(['yes'])
    expect(sent).toEqual([])
    done(card)
    await settle()
  })

  it('H1: focus anywhere in the slip (the thread list included) keeps the keys in the panel; leaving it gives them back', async () => {
    window.sundialOverlay.summoned({ quiet: true, summonId: 's-h1' })
    await settle()
    q('#input').focus()
    expect(COMPOSER.at(-1)).toBe(true)
    const from = COMPOSER.length
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    expect(q('#thread-menu').hidden).toBe(false)
    expect(q('#thread-menu').contains(document.activeElement)).toBe(true)
    expect(COMPOSER.slice(from)).not.toContain(false)
    // Esc in the list hands the focus to the field, not out of the panel.
    q('#thread-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(q('#thread-menu').hidden).toBe(true)
    expect(document.activeElement).toBe(q('#input'))
    expect(COMPOSER.slice(from)).not.toContain(false)
    q('#input').blur()
    expect(COMPOSER.at(-1)).toBe(false)
  })

  it("M2: Alt+L and Alt+K are the slip's alone: the board's own key handler never sees them", async () => {
    const board = []
    const keys = (e) => board.push(e.code)
    document.addEventListener('keydown', keys)
    q('#input').dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    document.removeEventListener('keydown', keys)
    expect(board).toEqual([])
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
  })

  it('H3: while a turn runs or an ask waits, the thread does not change: Alt+K, Alt+L and the list refuse, and the slip says why', async () => {
    const { card } = asking(true)
    await settle()
    const fresh = () => CALLS.filter((u) => u.startsWith('/gnomon/api/session/new')).length
    const before = fresh()
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyK', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    q('#thread-pick').click()
    await settle()
    expect(fresh()).toBe(before)
    expect(q('#thread-menu').hidden).toBe(true)
    expect(text('.ov-waits')).toBe('Finish or stop this turn first: the thread stays as it is.')
    expect(text('#thread-name')).toBe('BOX-484 test')
    // The turn ends but the ask still waits: still refused.
    document.body.dataset.running = 'false'
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    expect(q('#thread-menu').hidden).toBe(true)
    done(card)
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyL', bubbles: true }))
    await settle()
    expect(q('#thread-menu').hidden).toBe(false)
  })

  it("arrows walk the threads from the head (Up lands on the last one), and leave the model's options to app.js", async () => {
    q('#thread-pick').focus()
    q('#thread-pick').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement.className).toBe('thread-open')
    q('#model-pick').focus()
    q('#model-pick').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(q('#model-pick'))
    q('#thread-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
  })

  it('the trace (Alt+T) is redrawn only when a line changed, not on every update', async () => {
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-main', title: 'screen_look' })])
    Object.assign(row, { _args: { app: 'Finder' }, _t0: null, _result: 'Finder, window "notes": 4 things' })
    ghost().append(el('div', { class: 'turn' }, [el('p', { class: 'said', text: 'what is in notes' }), row]))
    await settle()
    q('.ov-slip').dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyT', bubbles: true }))
    await settle()
    const first = q('.ov-trace li:nth-child(2)')
    expect(first).not.toBeNull()
    document.body.dataset.nudge = '1'
    await settle()
    expect(q('.ov-trace li:nth-child(2)')).toBe(first)
    q('.ov-slip').dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyT', bubbles: true }))
    await settle()
  })

  it('Trace on the lower line: a click and Alt+T are one state; aria-pressed and localStorage follow; the field keeps the keys', async () => {
    const btn = q('.ov-tick .ov-trace-btn')
    expect(btn.textContent).toBe('Trace')
    expect(btn.previousElementSibling.id).toBe('thread')
    expect(btn.getAttribute('aria-pressed')).toBe('false')
    expect(q('.ov-trace').hidden).toBe(true)
    // A press never takes the focus from the field: the panel keeps the keyboard.
    q('#input').focus()
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    btn.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    btn.click()
    await settle()
    expect(document.activeElement).toBe(q('#input'))
    expect(COMPOSER.at(-1)).toBe(true)
    expect([btn.getAttribute('aria-pressed'), q('.ov-trace').hidden, localStorage.getItem('gnomon.trace')]).toEqual(['true', false, '1'])
    // Alt+T is the same switch: it turns off what the click turned on, and the button says so.
    q('.ov-slip').dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyT', bubbles: true }))
    await settle()
    expect([btn.getAttribute('aria-pressed'), q('.ov-trace').hidden, localStorage.getItem('gnomon.trace')]).toEqual(['false', true, '0'])
    q('.ov-slip').dispatchEvent(new KeyboardEvent('keydown', { altKey: true, code: 'KeyT', bubbles: true }))
    await settle()
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    btn.click()
    await settle()
    expect([btn.getAttribute('aria-pressed'), localStorage.getItem('gnomon.trace')]).toEqual(['false', '0'])
  })

  it('Trace survives a reload: a page booted with it on shows it pressed and open', async () => {
    localStorage.setItem('gnomon.trace', '1')
    // A second boot of the page, as after a reload: the module again, over the same document.
    await import('./overlay.js?reload')
    await settle()
    const slips = document.querySelectorAll('.ov-slip')
    const fresh = slips[slips.length - 1].querySelector('.ov-trace-btn')
    expect(fresh.getAttribute('aria-pressed')).toBe('true')
    expect(slips[slips.length - 1].querySelector('.ov-trace').hidden).toBe(false)
    localStorage.setItem('gnomon.trace', '0')
  })
})
