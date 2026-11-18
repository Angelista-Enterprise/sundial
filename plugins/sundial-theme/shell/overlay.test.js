// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HAND_LINE, HINTS, PLACEHOLDERS, SOLID, askOf, chipText, atEnd, copyOf, doingOf, offerIn, offerRow, overlayMode, pickFigure, placeOf, pressOffer, queued, regionsOf, runOf, slipOf, slipUp, ticks, traceOf } from './overlay.js'
import { asideText, clock, DAY_ASK, detailRows, DROPPED_LINE, dur, endOf, evening, foldAside, lapsOf, readFrames, readoutOf, shelfOf } from './slip-read.js'
import { markSeen, offerChip } from './verdicts.js'
import { el } from './surfaces.js'
import { commandLine, finalAsk, finalOf, touchesLine } from '../../sundial-actions/gate.js'
import { screenTools } from '../../sundial-actions/screen-tools.js'
import { lookForLog } from '../../../packages/harness-runtime/src/app-channel.ts'

const card = (id, kind, at) => ({ id, kind, at, x: 0, y: 0, w: 640, h: 480, z: 0 })
const board = (cards, focus = null) => ({ cards: Object.fromEntries(cards.map((c) => [c.id, c])), focus })

describe('pickFigure', () => {
  const day = card('nodus:day', 'nodus', '2026-11-03T09:00:00Z')
  const week = card('nodus:week', 'nodus', '2026-11-03T09:30:00Z')
  const lens = card('lens:x', 'lens', '2026-11-03T09:40:00Z')
  const all = board([day, week, lens, card('chat', 'chat', '2026-11-03T09:50:00Z'), card('today', 'today', '2026-11-03T09:55:00Z')])

  it('floats nothing for a thread that put no figure on the board, however full the board is', () => {
    expect(pickFigure(all, { thread: '' })).toBeNull()
    expect(pickFigure(all, { thread: 'Nothing said yet.' })).toBeNull()
    expect(pickFigure(null)).toBeNull()
  })

  it('takes only figures this thread named: a switch to another thread swaps them', () => {
    expect(pickFigure(all, { thread: 'Reading a card nodus:day -> 4 results' })).toBe('nodus:day')
    expect(pickFigure(all, { thread: 'Drawn: nodus:week' })).toBe('nodus:week')
    expect(pickFigure(all, { thread: 'Your day is on the board: Where the time went', names: { 'nodus:day': 'Where the time went' } })).toBe('nodus:day')
  })

  it('prefers the thread\'s newest Nodus card, then its lens', () => {
    expect(pickFigure(all, { thread: 'nodus:day, lens:x, nodus:week' })).toBe('nodus:week')
    expect(pickFigure(all, { thread: 'lens:x' })).toBe('lens:x')
  })

  it('never floats a note or the conversation, even when the thread names them', () => {
    const b = board([day, card('note:cat-a1', 'note', '2026-11-03T09:50:00Z'), card('chat', 'chat', '2026-11-03T09:55:00Z')])
    expect(pickFigure(b, { thread: 'Left a comment on note:cat-a1 in chat' })).toBeNull()
    expect(pickFigure(b, { said: 'note:cat-a1', thread: 'nodus:day then note:cat-a1' })).toBe('nodus:day')
  })

  it('takes the card the newest turn named last, by id or by name, over a newer one', () => {
    const thread = 'nodus:week earlier; now nodus:day'
    expect(pickFigure(all, { said: 'Reading a card nodus:day -> 4 results', thread })).toBe('nodus:day')
    expect(pickFigure(all, { said: 'nodus:day, and then nodus:week', thread })).toBe('nodus:week')
    expect(pickFigure(all, { said: 'Your day: Where the time went', thread: 'nodus:week, Where the time went', names: { 'nodus:day': 'Where the time went' } })).toBe('nodus:day')
  })
})

describe('regionsOf', () => {
  it('pads, rounds outward, clips to the viewport and drops empty boxes', () => {
    const rects = [
      { left: 1000.4, top: 16, right: 1424.6, bottom: 884 },
      { left: 0, top: 0, right: 0, bottom: 0 },
      { left: -20, top: 850, right: 300, bottom: 950 },
    ]
    expect(regionsOf(rects, 1440, 900)).toEqual([
      { x: 996, y: 12, w: 433, h: 876 },
      { x: 0, y: 0, w: 4, h: 4 },
      { x: 0, y: 846, w: 304, h: 54 },
    ])
    expect(regionsOf([{ left: 0, top: 0, right: 0, bottom: 0 }], 1440, 900, 0)).toEqual([])
  })
})

describe('placeOf', () => {
  it('names the app and its window, and nothing for Sundial or an empty report', () => {
    expect(placeOf({ app: 'Xcode', title: 'Sundial.swift' })).toBe('Xcode: Sundial.swift')
    expect(placeOf({ app: 'Finder', title: '' })).toBe('Finder')
    expect(placeOf({ app: 'Sundial', title: 'Sundial' })).toBe('')
    expect(placeOf(null)).toBe('')
  })
})

describe('overlayMode', () => {
  it('reads the overlay from the query, the way index.html does; the old board and figure modes land on the slip', () => {
    for (const q of ['?overlay=slip', '?x=1&overlay=board', '?overlay=1', '?overlay=figure']) expect(overlayMode(q)).toBe('slip')
    expect(overlayMode('')).toBeNull()
    expect(overlayMode('?overlay=boards')).toBeNull()
    expect(readFileSync(join(__dirname, 'index.html'), 'utf8')).toContain('/[?&]overlay=(1|board|figure|slip)(&|$)/')
  })

  it('takes a click only on the slip, a tag and the sheet: never a board card', () => {
    expect(SOLID.split(',').map((x) => x.trim())).not.toContain('.pane')
  })
})

describe('slipOf', () => {
  it('says one thing at a time, in this order: listening, an ask, a guide, the work, the answer, the note', () => {
    expect(slipOf({ listening: true, ask: { line: 'x' } }).scale).toBe('listen')
    expect(slipOf({ ask: { line: 'Press Send on the reply to Mira Bakker.', ringed: false } })).toMatchObject({ ask: true, scale: 'one' })
    expect(slipOf({ ask: { line: 'x', ringed: true } })).toMatchObject({ line: 'Waits for your yes.' })
    expect(slipOf({ guide: { step: 2, of: 4 }, running: true }).line).toBe('Step 2 of 4. The ring moves when you do it.')
    expect(slipOf({ running: true, said: 'open BOX-484' })).toMatchObject({ scale: 'think', line: '“open BOX-484”', tone: 'heard' })
    expect(slipOf({ running: true, doing: 'Opening Mail' })).toMatchObject({ scale: 'think', line: 'Opening Mail' })
    expect(slipOf({ running: true, reply: 'Done.' }).scale).toBe('speak')
    expect(slipOf({ reply: 'Done.', note: 'n' })).toMatchObject({ scale: 'still', line: 'Done.' })
    expect(slipOf({ note: 'One thing waits.' }).line).toBe('One thing waits.')
  })

  it('a model that cannot be reached: its line is the work while the turn runs, and stays after it ends with no answer', () => {
    expect(slipOf({ running: true, doing: 'The model is not answering; trying the backup.' }).line).toBe('The model is not answering; trying the backup.')
    expect(slipOf({ model: 'No model is answering right now; try again in a minute.' })).toMatchObject({ scale: 'still', line: 'No model is answering right now; try again in a minute.' })
    expect(slipOf({ reply: 'Done.', model: 'x' }).line).toBe('Done.')
    expect(slipOf({ note: 'Nothing was heard.', model: 'x' }).line).toBe('Nothing was heard.')
  })

  it('holds the whole of a long answer: the slip scrolls, it does not cut', () => {
    const reply = `${'The build for puzzlebox-studio ran. '.repeat(20)}It passed.`
    expect(slipOf({ reply })).toEqual({ state: 'answer', scale: 'still', line: reply, tone: '', full: true })
    expect(slipOf({ running: true, doing: 'Opening Mail' }).full).toBeUndefined()
  })

  it('follows the end of the answer only while the owner is at it', () => {
    expect(atEnd({ scrollHeight: 900, scrollTop: 540, clientHeight: 360 })).toBe(true)
    expect(atEnd({ scrollHeight: 900, scrollTop: 535, clientHeight: 360 })).toBe(true)
    expect(atEnd({ scrollHeight: 900, scrollTop: 300, clientHeight: 360 })).toBe(false)
    expect(atEnd({ scrollHeight: 40, scrollTop: 0, clientHeight: 40 })).toBe(true)
  })
})

describe('while a turn runs', () => {
  it('a message typed meanwhile waits for the end of the turn, each one on its own line', () => {
    expect(queued('', '  open the puzzlebox vault ')).toBe('open the puzzlebox vault')
    expect(queued('open the puzzlebox vault', 'the other window')).toBe('open the puzzlebox vault\nthe other window')
    expect(queued('open it', '   ')).toBe('open it')
  })

  it('shows Stop the whole time, says it is still working after 20 s with the time, and what waits', () => {
    expect(runOf({ running: true, ms: 4_000 })).toEqual({ stop: true, still: '', waits: '' })
    expect(runOf({ running: true, ms: 42_000, waits: 'open the puzzlebox\nvault' })).toEqual({ stop: true, still: 'Still working, 42s.', waits: 'Sends when this is done: “open the puzzlebox vault”' })
    expect(runOf({ running: true, ms: 125_000 }).still).toBe('Still working, 2m 5s.')
    expect(runOf({ running: false, ms: 90_000 })).toEqual({ stop: false, still: '', waits: '' })
  })

  it('names the step it is on and the app once it is long', () => {
    expect(runOf({ running: true, ms: 42_000, steps: 4, app: 'Finder' }).still).toBe('Still working: step 4 in Finder, 42s.')
    expect(runOf({ running: true, ms: 42_000, steps: 1 }).still).toBe('Still working: step 1, 42s.')
    // Thinking with no step: nothing for the first minute, then the minutes and the way out (run202 T03: "thinking 5:04", nothing else).
    expect(runOf({ running: true, ms: 45_000, thinking: true }).still).toBe('')
    expect(runOf({ running: true, ms: 61_000, thinking: true }).still).toBe('Still thinking, 1 min, no step yet. ⌥. stops it.')
    expect(runOf({ running: true, ms: 5 * 60_000 + 4_000, thinking: true }).still).toBe('Still thinking, 5 min, no step yet. ⌥. stops it.')
    expect(runOf({ running: true, ms: 5 * 60_000, thinking: true, steps: 2 }).still).toBe('Still working: step 2, 5m 0s.')
    expect(runOf({ running: true, ms: 4_000, steps: 4, app: 'Finder' }).still).toBe('')
  })
})

describe('askOf', () => {
  it('rings the thing an act waits on: a target, a flat name, or a ref from a look; nothing to ring for an ask with neither', () => {
    expect(askOf({ target: '{"app":"Notes","label":"Title"}', because: ' Name the note ' }, 'screen_act')).toEqual({ target: { app: 'Notes', label: 'Title' }, line: 'Name the note', kind: 'Asks first', detail: 'Target: {"app":"Notes","label":"Title"}' })
    expect(askOf('{"ref":"e7","action":"press"}', 'screen_act')).toEqual({ target: { ref: 'e7' }, line: 'Gnomon wants to use screen_act.', kind: 'Asks first', detail: 'Ref: e7\nAction: press' })
    expect(askOf({ app: 'Notes', role: 'button', label: 'New Note' }, 'screen_act').target).toEqual({ app: 'Notes', role: 'button', label: 'New Note' })
    expect(askOf({ command: 'ls' }, 'Shell')).toEqual({ target: null, line: 'Gnomon wants to use Shell.', kind: 'Asks first', detail: 'Command: ls' })
    expect(askOf(undefined, 'Shell').target).toBeNull()
  })

  it('says the line the code made from the plan first, the model\'s own words second; the tool\'s name only when there is neither', () => {
    const args = { ref: 'e7@3c4d', action: 'type', value: 'See you Thursday', because: 'Answer Mira Bakker' }
    const made = 'type "See you Thursday" in Mail'
    expect(askOf(args, 'screen_act', made)).toMatchObject({ target: { ref: 'e7@3c4d' }, line: made, said: 'Answer Mira Bakker' })
    expect(askOf({ ...args, because: made }, 'screen_act', made).said).toBeUndefined()
    expect(askOf(args, 'screen_act', 'Gnomon: this reaches outside the Mac.')).toMatchObject({ target: { ref: 'e7@3c4d' }, line: 'Answer Mira Bakker', detail: 'Ref: e7@3c4d\nAction: type\nValue: See you Thursday' })
    expect(slipOf({ ask: askOf(args, 'screen_act', made) })).toMatchObject({ ask: true, line: made, said: 'Answer Mira Bakker' })
  })

  it('reads an act made through gnomon_call: the target and the words are one level in', () => {
    const act = { target: { app: 'Notes', label: 'Title' }, because: 'Name the note' }
    for (const args of [act, JSON.stringify(act)]) expect(askOf({ name: 'screen_act', args }, 'gnomon_call', 'press "Title" in Notes')).toMatchObject({ target: { app: 'Notes', label: 'Title' }, line: 'press "Title" in Notes', said: 'Name the note', detail: 'Target: {"app":"Notes","label":"Title"}' })
    expect(askOf(JSON.stringify({ name: 'screen_act', args: { ref: 'e1@3c4d' } }), 'gnomon_call').target).toEqual({ ref: 'e1@3c4d' })
    expect(askOf({ app: 'Notes', steps: [{ role: 'button', label: 'New Note', action: 'press' }, { action: 'key', value: 'return' }] }, 'screen_act').target).toEqual({ app: 'Notes', role: 'button', label: 'New Note' })
    expect(askOf({ steps: '[{"ref":"e1@3c4d"}]' }, 'screen_act').target).toEqual({ ref: 'e1@3c4d' })
  })
})

describe('the doing line is the step line (Set 2 R5)', () => {
  /** The tool row as app.js keeps the pushed `step` frame on it. Every step shape: sundial-actions/screen-voice.test.js. */
  const rowWith = (args, lines) => {
    const row = el('div', { class: 'tool' }, [el('span', { class: 'tool-verb', text: 'Acting' }), el('span', { class: 'tool-arg', text: 'Notes' })])
    row._args = args
    for (const line of lines) Object.assign(row.dataset, { step: line, steps: String(Number(row.dataset.steps ?? 0) + 1) })
    return row
  }

  /** screen_act over a fake app that performs every act and shows the same Pages window after it (screen-voice.test.js's). */
  const act = () => {
    const { type: _type, at: _at, ...line } = JSON.parse(readFileSync(join(__dirname, '../../sundial-actions/screen-look.fixture.json'), 'utf8').replace(/\bNotes\b/g, 'Pages'))
    const row = lookForLog(line)
    const [rows, said] = [{ [row.id]: row }, []]
    const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: row.id, app: 'Pages', n: 4 } } }
    const send = (c) => {
      const id = c.type === 'look' ? c.id : `look-after-${c.id}`
      if (c.type === 'act') state.marks.lastAct = { id: c.id, outcome: 'performed' }
      rows[id] = { ...row, id, ...(c.type === 'act' ? { after: c.id } : {}) }
      state.marks.lastLook = { id, app: 'Pages', n: 4, ...(c.type === 'act' ? { after: c.id } : {}) }
    }
    const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((r) => (field === 'tag' ? String(r.id).endsWith(id) : r[field] === id)) ?? null
    const [, , tool] = screenTools(async () => {}, () => state, send, readRow, async () => [], { say: (s) => said.push(s) })
    return { run: (args) => tool.execute(args, { agent: { session: { id: 'session-7f' } } }).catch(() => {}), said }
  }

  it('every step shape: the doing text is the words the voice gets (index.js emits them, server.js pushes `next`), its spoken line whenever it speaks', async () => {
    const shapes = [
      { target: { app: 'Pages' }, because: 'Open Pages' },
      { app: 'Pages', action: 'pick-menu', value: 'View > Sort By', because: 'Sort the notes' },
      { target: { app: 'Pages', role: 'button', label: 'New Note' }, action: 'press', because: 'Start a new note' },
      { target: { app: 'Pages', role: 'text field', label: 'Title' }, action: 'type', value: 'Call Mira Bakker', because: 'Type call mira bakker' },
      { target: { app: 'Pages', role: 'text field', label: 'Title' }, action: 'set-value', value: 'BOX-484', because: 'Name the note for the puzzlebox studio launch review' },
      { app: 'Pages', steps: [{ role: 'button', label: 'New Note', action: 'press', because: 'Start a new note' }, { action: 'key', value: 'return' }, { action: 'key', value: 'cmd+c' }] },
      { target: { app: 'Pages' }, action: 'key', value: 'escape', because: 'Close it' },
    ]
    const seen = []
    for (const args of shapes) {
      const t = act()
      await t.run(args)
      const lines = t.said.filter((o) => typeof o.next === 'string')
      const { doing, steps } = doingOf([rowWith(args, lines.map((o) => o.next))])
      expect(steps).toBe(lines.length)
      expect(doing, JSON.stringify(args)).toBe(lines.length ? lines.at(-1).next : 'Acting · Notes')
      for (const o of lines) if (o.line) expect(o.line).toBe(o.next)
      seen.push(doing)
    }
    // A chain shows its newest step that has words (cmd+c has none); an escape has none, so the call's verb stays.
    expect(seen).toEqual(['Open Pages', 'Sort the notes', 'Start a new note', 'type "Title" in Pages', 'set-value "Title" in Pages', 'key in Pages', 'Acting · Notes'])
  })

  it("counts the turn's steps across its calls and names the app of the newest", () => {
    const rows = [rowWith({ target: { app: 'Finder' } }, ['Open Finder', 'Sort the files']), rowWith({ command: 'ls' }, []), rowWith({ app: 'Notes', steps: [] }, ['Start a new note'])]
    expect(doingOf(rows)).toEqual({ doing: 'Start a new note', model: '', steps: 3, app: 'Notes' })
    expect(doingOf([rowWith({}, [])]).doing).toBe('Acting · Notes')
    expect(doingOf([])).toEqual({ doing: '', model: '', steps: 0, app: '' })
    // Set 2 R4: the model's own line, when it is the newest, is the doing line over the step before it; the step count stays.
    const backup = el('div', { class: 'log-line', 'data-key': 'llm:hedge' }, [el('span', { class: 'log-line-label', text: 'The model is not answering, trying the backup' })])
    expect(doingOf([...rows, backup])).toEqual({ doing: 'The model is not answering, trying the backup', model: 'The model is not answering, trying the backup', steps: 3, app: 'Notes' })
  })

  it("the approval names the final's kind and target, the steps and its recipients under it", () => {
    const reason = finalAsk(finalOf('screen_act', { app: 'Zen', role: 'button', label: 'Delete the message from Mira Bakker' }, undefined, []), { line: 'Press "Delete the message from Mira Bakker" in Zen', window: 'Testbox' })
    const ask = askOf({ app: 'Zen', role: 'button', label: 'Delete the message from Mira Bakker', because: 'Clear the inbox' }, 'screen_act', reason)
    expect(ask).toEqual({ target: { app: 'Zen', role: 'button', label: 'Delete the message from Mira Bakker' }, line: 'This deletes "the message from Mira Bakker" in Zen (window "Testbox"), which cannot be taken back.', kind: 'Delete', final: true, detail: 'Press "Delete the message from Mira Bakker" in Zen', said: 'Clear the inbox' })
    expect(slipOf({ ask })).toMatchObject({ ask: true, line: ask.line, detail: ask.detail, said: 'Clear the inbox' })
    const send = askOf({ app: 'Zen', role: 'button', label: 'Send' }, 'screen_act', 'Gnomon: this sends a mail or a message with "Send" in Zen, which cannot be taken back, so it asks you first. Press "Send" in Zen · To: mira@example.org · final: send')
    expect(send).toMatchObject({ line: 'This sends a mail or a message with "Send" in Zen, which cannot be taken back.', detail: 'Press "Send" in Zen\nTo: mira@example.org' })
    expect(askOf({ command: 'rm /tmp/box/old.log' }, 'Shell', finalAsk(finalOf('gnomon_run_shell', { command: 'rm /tmp/box/old.log' }), { command: 'rm /tmp/box/old.log' })).line).toMatch(/^This deletes "\/tmp\/box\/old\.log" from the shell, which cannot be taken back\.$/)
    expect(askOf({}, 'web_act', 'Gnomon: this submits a form with "Place order" on a web page, which cannot be taken back, so it asks you first. · final: submit')).toEqual({ target: null, line: 'This submits a form with "Place order" on a web page, which cannot be taken back.', kind: 'Submit', final: true })
  })
})

describe('copyOf', () => {
  it('copies an answer for the slip with no second id on the page and no button that does nothing', () => {
    const prose = document.createElement('div')
    prose.id = 'turn-1'
    prose.innerHTML = '<h3 id="plan">Plan</h3><pre><code>ls</code><button>Copy</button></pre>'
    const copy = copyOf(prose)
    expect(copy.outerHTML).toBe('<div><h3>Plan</h3><pre><code>ls</code></pre></div>')
    expect(prose.querySelector('button')).not.toBeNull()
  })
})

describe('ticks', () => {
  it('draws a guide as its parts: done in ink, the current one in ochre, a tall tick where each part starts', () => {
    const t = ticks('steps', 40, 2, 4)
    expect(t).toHaveLength(40)
    expect(t[0]).toEqual([13, 'you'])
    expect(t[10]).toEqual([13, 'g'])
    expect(t[15]).toEqual([7, 'g'])
    expect(t[25]).toEqual([4, ''])
    expect(ticks('one', 9).filter(([, c]) => c === 'g')).toHaveLength(1)
  })
})

describe('regionsOf, a board of cards', () => {
  it('keeps every card on screen, clips the ones half off it, and drops the ones off it', () => {
    const cards = Array.from({ length: 40 }, (_, i) => ({ left: -600 + i * 120, top: 100 + (i % 3) * 200, right: -600 + i * 120 + 100, bottom: 100 + (i % 3) * 200 + 150 }))
    const regions = regionsOf(cards, 1440, 900)
    expect(regions.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= 1440 && r.y + r.h <= 900)).toBe(true)
    // Cards wholly left of the screen (right edge + pad <= 0) are gone; the rest stay.
    expect(regions).toHaveLength(cards.filter((c) => c.right + 4 > 0 && c.left - 4 < 1440).length)
  })
})

describe('slipUp', () => {
  // The slip, 560 by 80, 36 off the bottom of a 1800 by 1130 screen: it spans x 620..1180, y 1014..1094.
  const up = (marks) => slipUp(marks, 560, 80, 1800, 1130)
  it('goes up for a mark under it (a play button at the bottom centre), and stays for one beside it', () => {
    expect(up([{ x: 887, y: 1070, w: 27, h: 27 }])).toBe(true)
    expect(up([{ x: 100, y: 1070, w: 27, h: 27 }])).toBe(false)
    expect(up([])).toBe(false)
  })
  it('stays down when the top is taken too', () => {
    expect(up([{ x: 887, y: 1070, w: 27, h: 27 }, { x: 880, y: 60, w: 40, h: 20 }])).toBe(false)
  })
})

describe('traceOf', () => {
  const row = (name, args, extra = {}) => ({ querySelector: () => ({ title: name }), hasAttribute: (a) => a === 'data-failed' && extra.failed === true, _args: args, ...extra })
  it('gives each call the model time before it, its steps and what came back, and thinks last', () => {
    const rows = [
      row('screen_act', { app: 'Notes', goal: 'new note', steps: [{ action: 'pick-menu', value: 'New Note' }, { action: 'key', value: 'return' }] }, { _t0: 3000, _ms: 1500, _result: 'Error: refused: not-found', failed: true }),
      row('screen_look', { app: 'Notes', query: 'title' }, { _t0: 6000, _ms: 900, _result: JSON.stringify('Read off the screen (data):\nNotes, window "Lunch": 4 things') }),
    ]
    const [head, act, look, thinking] = traceOf(rows, 1000, 9000, true)
    expect(head).toBe('2 calls · model 5.6 s · tools 2.4 s · 1 failed')
    expect(act).toMatchObject({ state: 'fail', time: '1.5 s', sub: 'model 2.0 s · screen_act · pick-menu "New Note" → key return' })
    expect(act.why).toMatch(/not-found/)
    expect(look).toMatchObject({ state: 'ok', sub: expect.stringMatching(/^model 1\.5 s · screen_look/), why: 'Notes, window "Lunch": 4 things' })
    expect(thinking).toMatchObject({ state: 'run', title: 'Thinking', time: '2.1 s' })
  })
  it('shows a running call as running, with no thinking line', () => {
    const items = traceOf([row('screen_look', { app: 'Mail' }, { _t0: 2000 })], 1000, 4500, true)
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ state: 'run', time: '2.5 s', why: null })
  })
  it('marks a tool that failed inside gnomon_call as failed, with its error', () => {
    const [, call] = traceOf([row('gnomon_call', { name: 'gnomon_run_shell', args: { command: 'ls' } }, { _t0: 2000, _ms: 10, _result: JSON.stringify({ error: 'the executor refused' }) })], 1000, 3000, false)
    expect(call).toMatchObject({ state: 'fail', why: 'failed: the executor refused' })
  })
  it('leaves the totals out for a turn drawn from the log, which has no times', () => {
    expect(traceOf([row('screen_look', { app: 'Mail' }, { _t0: null, _result: 'x' })], 0, 1, false)[0]).toBe('1 call')
  })
})

describe('the offer in the slip (Set 2 R3)', () => {
  const offer = { noticeKey: 'stuck:build', label: 'Show the failing run', kind: 'stuck' }

  it('reads the offer the hidden strip drew, and nothing when there is none', () => {
    document.body.replaceChildren()
    expect(offerIn(document)).toBeNull()
    document.body.append(offerChip(offer))
    expect(offerIn(document)).toEqual({ noticeKey: 'stuck:build', label: 'Show the failing run' })
    document.body.replaceChildren()
    // The notice's own words, when the strip knows them, ride on the chip for the slip's line.
    document.body.append(offerChip({ ...offer, line: 'The puzzlebox-studio build is red since 09:40.' }))
    expect(offerIn(document)).toEqual({ noticeKey: 'stuck:build', label: 'Show the failing run', line: 'The puzzlebox-studio build is red since 09:40.' })
    document.body.replaceChildren()
  })

  it("the strip hands the snapshot's offer on as it is: its line is the notice's own, never guessed from what was said near it", () => {
    const app = readFileSync(join(__dirname, 'app.js'), 'utf8')
    expect(app).toMatch(/if \(now\.offer\) parts\.push\(offerChip\(now\.offer\)\)/)
    expect(app).not.toMatch(/offerLine/)
  })

  it('shows the button only while an offer exists and nothing else asks; once pressed, its outcome', () => {
    expect(offerRow(null)).toBeNull()
    expect(offerRow(offer)).toBe(offer)
    expect(offerRow(offer, { ask: true })).toBeNull()
    expect(offerRow(offer, { listening: true })).toBeNull()
    const done = { noticeKey: 'stuck:build', text: 'Gone: taken already, or too old.' }
    expect(offerRow(null, { done })).toEqual({ ...done, settled: true })
    expect(offerRow(offer, { done })).toEqual({ ...done, settled: true })
    // A newer offer replaces the settled one.
    expect(offerRow({ ...offer, noticeKey: 'stuck:other' }, { done })).toEqual({ ...offer, noticeKey: 'stuck:other' })
    // Settled, the notice's line stays: the press keeps it, and so does an offer still on the strip.
    expect(offerRow(null, { done: { ...done, line: 'The build is red.' } })).toMatchObject({ line: 'The build is red.', settled: true })
    expect(offerRow({ ...offer, line: 'The build is red.' }, { done })).toMatchObject({ line: 'The build is red.', text: done.text, settled: true })
  })

  it('a press posts the notice key and the surface to the strip\'s route, never the call', async () => {
    const calls = []
    const post = async (url, init) => (calls.push([url, init]), { status: 200, json: async () => ({ ran: true }) })
    expect(await pressOffer('stuck:build', post)).toEqual({ text: 'Done. The answer is in the conversation.' })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/gnomon/api/offer')
    expect(calls[0][1].method).toBe('POST')
    expect(JSON.parse(calls[0][1].body)).toEqual({ noticeKey: 'stuck:build', via: 'slip' })
    expect(await pressOffer('k', async () => ({ status: 404, json: async () => ({ unavailable: 'gone' }) }))).toEqual({ text: 'Gone: taken already, or too old.', title: 'gone' })
    expect(await pressOffer('k', async () => ({ status: 200, json: async () => ({ ran: false, reason: 'the user rejected tool "screen_act"' }) }))).toEqual({ text: 'Not run: you said no.', title: 'the user rejected tool "screen_act"' })
    // Any other reason keeps the plain words, the reason on hover.
    expect(await pressOffer('k', async () => ({ status: 200, json: async () => ({ ran: false, reason: 'refused: private app' }) }))).toEqual({ text: 'Not run.', title: 'refused: private app' })
    expect((await pressOffer('k', async () => { throw new Error('offline') })).text).toBe('Not run.')
    // What came back shows in place of the button; the whole is in the conversation.
    expect(await pressOffer('k', async () => ({ status: 200, json: async () => ({ ran: true, said: 'pnpm test (exit 1)' }) }))).toEqual({ text: 'pnpm test (exit 1)', title: 'Also in the conversation.' })
  })

  it('in the overlay only what is on the slip counts as seen: the hidden strip\'s chip sends nothing', () => {
    const sent = []
    const was = globalThis.fetch
    globalThis.fetch = async (url, init) => (sent.push(JSON.parse(init.body)), { ok: true })
    document.documentElement.dataset.overlay = 'slip'
    try {
      document.body.replaceChildren()
      document.body.append(offerChip({ ...offer, noticeKey: 'stuck:hidden' }))
      const slip = el('section', { class: 'ov-slip' })
      const btn = el('button', { text: offer.label })
      slip.append(btn)
      document.body.append(slip)
      markSeen(btn, 'stuck:slip', 'slip-offer')
      expect(sent).toEqual([{ artifactKind: 'notice', artifactId: 'stuck:slip', seen: true, surface: 'slip-offer' }])
    } finally {
      delete document.documentElement.dataset.overlay
      globalThis.fetch = was
      document.body.replaceChildren()
    }
  })
})

describe('the state table (Set 3 R1): every state names itself in one line, with its edge, its readout and its one hint', () => {
  // The times the page saw, made up: a turn that started 24 s ago, an answer at 11:43 that took 38 s.
  const at = new Date(2026, 10, 15, 11, 43, 0).getTime()
  const rows = [
    ['still', { note: 'You are back on BOX-484. The test is still red.' }, { scale: 'still', line: 'You are back on BOX-484. The test is still red.' }, { answeredAt: at, took: 38_000, steps: 9 }, ['answered 11:43', 'in 38 s · 9 steps'], '⌥L'],
    ['listen', { listening: true, running: true }, { scale: 'listen', line: 'Listening. Let go to send.' }, {}, null, undefined],
    ['think', { running: true, said: 'rename notes.txt in Finder' }, { scale: 'think', line: '“rename notes.txt in Finder”', tone: 'heard' }, { ms: 4_000 }, ['thinking', '0:04'], undefined],
    ['doing', { running: true, doing: 'Open the File menu in Finder', steps: 7, app: 'Finder', ms: 24_000 }, { scale: 'think', line: 'Open the File menu in Finder', doing: { line: 'Open the File menu in Finder', steps: 7, app: 'Finder', ms: 24_000 } }, { steps: 7, app: 'Finder', ms: 24_000, think: 4_000 }, ['step 7 · Finder', '0:24 · model 4.0 s'], undefined],
    ['ask', { running: true, ask: { line: 'This sends a mail or a message with "Send" in Zen, which cannot be taken back.', detail: 'Press "Send" in Zen\nTo: test@example.com', said: 'Mira Bakker asked for the result before noon' } }, { scale: 'one', ask: true, detail: 'Press "Send" in Zen\nTo: test@example.com' }, { waited: 6_000, next: 9 }, ['waits for your yes', '0:06 · step 9'], 'Enter'],
    ['ringed', { running: true, ask: { line: 'x', ringed: true } }, { scale: 'one', line: 'Waits for your yes.' }, { waited: 6_000, next: 9 }, ['waits for your yes', '0:06 · step 9'], 'Enter'],
    ['answer', { reply: 'The test on BOX-484 is green: 14 passed.' }, { scale: 'still', full: true }, { answeredAt: at, took: 38_000, model: 31_000 }, ['answered 11:43', 'in 38 s · model 31 s'], '⌥L'],
    ['guide', { running: true, guide: { step: 2, of: 5 } }, { scale: 'steps', line: 'Step 2 of 5. The ring moves when you do it.' }, {}, null, 'esc'],
    ['offer', { note: 'You are back on BOX-484.', offer: { noticeKey: 'stuck:build', label: 'Show the failing run', line: 'The puzzlebox-studio build is red since 09:40.' } }, { scale: 'still', line: 'The puzzlebox-studio build is red since 09:40.', offer: true }, { answeredAt: at, took: 38_000 }, ['answered 11:43', 'in 38 s'], '⌥L'],
    ['stopped', { stopped: { steps: 4, app: 'Finder' } }, { scale: 'still', line: 'Stopped at step 4 in Finder.' }, { stoppedAt: at, took: 24_000, steps: 4 }, ['stopped 11:43', 'after 0:24 · 4 steps'], '⌥L'],
  ]

  it.each(rows)('%s', (state, input, expected, times, readout, hint) => {
    expect(slipOf(input)).toMatchObject({ state, ...expected })
    const r = readoutOf(state, times)
    expect(r && [r.top, r.bottom]).toEqual(readout)
    expect(HINTS[state]?.[0]).toBe(hint)
  })

  it("an offer with no notice line of its own falls back to the summon's line", () => {
    expect(slipOf({ note: 'You are back on BOX-484.', offer: { noticeKey: 'k', label: 'Pull it up' } })).toMatchObject({ state: 'offer', line: 'You are back on BOX-484.' })
  })

  it("the owner's hand: flagged on the state, never in the line (the line sits over the field, HAND_LINE above the row)", () => {
    expect(HAND_LINE).toBe('Waiting: your hands are on the keys.')
    expect(slipOf({ running: true, doing: 'Select notes.txt', steps: 2, app: 'Finder', hand: true })).toMatchObject({ state: 'doing', line: 'Select notes.txt', hand: true, doing: { line: 'Select notes.txt', steps: 2 } })
    expect(slipOf({ running: true, said: 'tidy the notes folder', hand: true })).toMatchObject({ state: 'think', line: '“tidy the notes folder”', hand: true })
    expect(slipOf({ running: true, doing: 'Select notes.txt', steps: 2 }).line).toBe('Select notes.txt')
    // An ask or an answer outranks it.
    expect(slipOf({ running: true, hand: true, ask: { line: 'x', ringed: true } }).state).toBe('ringed')
    expect(slipOf({ running: false, hand: true, reply: 'Done.' }).state).toBe('answer')
  })

  it("offline: the breaker's own line once the turn ends with no answer, as a stopped state", () => {
    expect(slipOf({ model: 'The model is not answering, trying the backup.' })).toMatchObject({ state: 'stopped', line: 'The model is not answering, trying the backup.' })
  })

  it('the step square is the same number in the readout, the eye and the newest lap; an ask carries the step its yes takes', () => {
    expect(readoutOf('doing', { steps: 7, app: 'Finder' }).tag).toBe(7)
    expect(readoutOf('ask', { next: 9 })).toMatchObject({ tag: 9, wait: true })
    expect(readoutOf('ask', { waited: 3_000 })).toMatchObject({ top: 'waits for your yes', bottom: '0:03', tag: null })
    expect(readoutOf('answer', { answeredAt: null })).toBeNull()
  })

  it('a call that runs reads as working, not thinking (run200 T01: "thinking" through a 16 s wait)', () => {
    expect(readoutOf('think', { ms: 16_000, tool: true })).toMatchObject({ top: 'working', bottom: '0:16' })
    expect(readoutOf('think', { ms: 4_000 }).top).toBe('thinking')
  })

  it('while an ask waits the trace\'s last line is the wait, not "Thinking" (run201 T10: "Thinking 2m 50s" beside the ask)', () => {
    const asking = traceOf([], 0, 170_000, true, true)
    expect(asking.at(-1)).toMatchObject({ state: 'run', title: 'Waiting for your yes' })
    expect(traceOf([], 0, 4_000, true).at(-1)).toMatchObject({ title: 'Thinking' })
  })

  it('the field says what typing does in each state', () => {
    expect(PLACEHOLDERS).toMatchObject({ doing: 'Type to correct it', ask: 'Type yes or no' })
    expect(PLACEHOLDERS.still).toBeUndefined()
  })

  it('reads durations as the readout says them', () => {
    expect([dur(4_000), dur(38_000), dur(64_000), clock(24_000), clock(125_000)]).toEqual(['4.0 s', '38 s', '1:04', '0:24', '2:05'])
  })
})

describe('the last steps (lapsOf): the newest three, with the model and tool time of each', () => {
  const row = (step, steps, t0, ms, result = 'ok') => {
    const r = el('div', { class: 'tool' }, [el('span', { class: 'tool-verb', text: 'Acting' }), el('span', { class: 'tool-arg', text: 'Finder' })])
    if (step) Object.assign(r.dataset, { step, steps: String(steps) })
    return Object.assign(r, { _t0: t0, _ms: ms, _result: result })
  }
  it("numbers a call by the turn's step count once it stepped, and the running one has no tool time yet", () => {
    const rows = [row('Bring Finder to the front', 1, 2_000, 400), row('', 0, 5_000, 600), row('Select notes.txt', 2, 8_000, 400), Object.assign(row('Open the File menu in Finder', 1, 12_000, 0), { _result: undefined })]
    expect(lapsOf(rows, 0, 13_000, true)).toEqual([
      { n: null, title: 'Acting · Finder', model: 2_600, tool: 600, now: false },
      { n: 3, title: 'Select notes.txt', model: 2_400, tool: 400, now: false },
      { n: 4, title: 'Open the File menu in Finder', model: 3_600, tool: null, now: true },
    ])
  })
  it('a model that decides after the newest call is one more line, the running one', () => {
    const laps = lapsOf([row('Select notes.txt', 1, 1_000, 500)], 0, 4_000, true)
    expect(laps.at(-1)).toEqual({ n: null, title: 'Deciding the next step', model: 2_500, tool: null, now: true })
  })
})

describe('askOf over the gate reasons the rig recorded (runs 175 to 183, values made up): every ask names its kind and its target', () => {
  const shell = (command) => askOf({ command }, 'gnomon_run_shell', ["Gnomon: 'run_shell' runs behind your approval (the 'workspace-write' preset asks first).", touchesLine(command), commandLine(command)].filter(Boolean).join(' · '))
  const finals = [
    finalAsk({ kind: 'send', via: 'screen', app: 'Zen', what: 'Send', to: ['test@example.com'] }, { line: 'Press "Send" in Zen', window: 'New message' }),
    finalAsk({ kind: 'discard', via: 'screen', app: 'Zen', what: "Don't Save" }, { line: 'Press "Don\'t Save" in Zen', window: 'BOX-484 draft' }),
    finalAsk({ kind: 'discard', via: 'screen', app: 'Zen', what: 'Discard' }, { line: 'Focus "To" in Zen; then press "Discard" in Zen' }),
    finalAsk({ kind: 'submit', via: 'screen', app: 'Zen', what: 'Place order' }, { line: 'Press "Place order" in Zen', window: 'Order form run9' }),
    finalAsk({ kind: 'submit', via: 'screen', app: 'Zen', what: 'Submit' }, { line: 'Press "Submit" in Zen', window: 'puzzlebox-studio sign-up' }),
    finalAsk({ kind: 'final-unknown', via: 'screen', app: 'Finder', last: 'notes.txt', by: 'tab' }, { line: 'Press return in Finder' }),
    finalAsk({ kind: 'final-unknown', via: 'screen', app: 'Finder', by: 'cmd+shift+g' }, { line: 'Press return in Finder', window: 'Documents' }),
  ]

  it('a shell command behind the preset: the line says what it touches, the command stays under it', () => {
    const commands = [
      ['cat ~/Documents/Kestrel/notes-run9.md', /^This runs a shell command that reads "~\/Documents\/Kestrel\/notes-run9\.md"\.$/],
      ['ls ~/Projects/puzzlebox-studio/src', /^This runs a shell command that reads "~\/Projects\/puzzlebox-studio\/src"\.$/],
      ['open "obsidian://new?vault=Kestrel&name=BOX-484"', /^This runs a shell command that opens "obsidian:\/\/new/],
      ['tail -5 /tmp/gnomon-run9.log', /reads "\/tmp\/gnomon-run9\.log"/],
      ['echo done > /tmp/gnomon-job-run9.log', /writes "\/tmp\/gnomon-job-run9\.log"/],
      ["printf 'BOX-484' >> ~/Documents/Kestrel/BOX-484.md", /writes "~\/Documents\/Kestrel\/BOX-484\.md"/],
      ['head /Users/mira/Documents/deck.csv', /reads "[^"]*deck\.csv"/],
      ['cat /private/tmp/puzzlebox.txt', /reads "\/private\/tmp\/puzzlebox\.txt"/],
      ['diff ~/Documents/a.txt /private/tmp/b.txt', /reads "~\/Documents\/a\.txt", "\/private\/tmp\/b\.txt"/],
      ['open "obsidian://open?vault=Kestrel"', /opens "obsidian:\/\/open/],
      ['mdfind -name "BOX-484 notes"', /^This runs a shell command(?: that [a-z]+ "[^"]+"\.|: mdfind -name "BOX-484 notes"\.)$/],
    ]
    for (const [command, line] of commands) {
      const ask = shell(command)
      expect(ask.line, command).toMatch(line)
      expect(ask).toMatchObject({ kind: 'Shell command', detail: expect.stringContaining(`Command: ${command}`) })
      expect(ask.line).not.toMatch(/Gnomon wants to use/)
    }
  })

  it('a final: its kind, the control or the key, the app (and window); the step and the recipients under it', () => {
    const asks = finals.map((reason) => askOf({ app: 'Zen' }, 'screen_act', reason))
    for (const ask of asks) expect(ask.line).toMatch(/^This (sends|discards|submits|Return)\b.*\bin (Zen|Finder)\b.*\.$/)
    expect(asks.map((a) => a.kind)).toEqual(['Send', 'Discard', 'Discard', 'Submit', 'Submit', 'Return key', 'Return key'])
    expect(asks[0]).toMatchObject({ line: 'This sends a mail or a message with "Send" in Zen (window "New message"), which cannot be taken back.', detail: 'Press "Send" in Zen\nTo: test@example.com', final: true })
    expect(detailRows(asks[0].detail)).toEqual([['Step', 'Press "Send" in Zen'], ['To', 'test@example.com']])
    expect(asks[5].line).toBe('This Return in Finder lands on a part Gnomon cannot read for certain (the keyboard was last on "notes.txt", then tab moved it): what it presses may not be taken back.')
  })

  it("no gate reason falls back to the tool's name: an unknown one is read as the gate wrote it", () => {
    expect(askOf({}, 'gnomon_board', "Gnomon: 'gnomon_board' runs behind your approval (the 'workspace-write' preset asks first).").line).toBe('This uses gnomon_board.')
    expect(askOf({}, 'notes', "Gnomon: notes → create_note runs behind your approval (the 'workspace-write' preset asks before anything reaches your services).").line).toBe('This uses notes → create_note.')
    expect(askOf({}, 'web_fetch', 'Gnomon: the judge reads web_fetch as outward (p 0.81, stakes 2/3), so it stops for your nod.').line).toBe('The judge reads web_fetch as outward (p 0.81, stakes 2/3), so it stops for your nod.')
  })
})

describe("the place chip fits, cut at a word (run200 T01: 'Add Finder: Testbox-rena…')", () => {
  it('the whole place when it fits, else the window name alone, else cut at a word; never mid-word when a word boundary is near', () => {
    expect(chipText('Finder: notes')).toBe('Add Finder: notes')
    expect(chipText('Finder: Testbox-rename')).toBe('Add Testbox-rename')
    expect(chipText('Zen: Mira Bakker samples for the second batch')).toBe('Add Mira Bakker samples…')
    expect(chipText('Finder: notes', { tail: ' + selection' })).toBe('Add notes + selection')
    expect(chipText('Xcode: Sundial.swift', { lead: '' })).toBe('Xcode: Sundial.swift')
    for (const place of ['Finder: Testbox-rename', 'Zen: Mira Bakker samples for the second batch', 'Obsidian: puzzlebox-studio quarterly planning notes']) expect(chipText(place).length, place).toBeLessThanOrEqual(24)
  })
})

describe('the slip keeps its columns', () => {
  it("the mark's slot stays when empty, and what grows starts Gnomon's words where the row's line starts", () => {
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // Row: 14 px edge, 14 px mark, 9 px gap. Grown: the same 14 px edge, a 14 px mark column, 9 px gap; the offer and the waits line indent to it.
    expect(css).toMatch(/\.ov-glyph \{[^}]*width: 14px;/)
    expect(css).not.toMatch(/\.ov-glyph \{[^}]*display: contents/)
    expect(css).toMatch(/\.ov-tick \{[^}]*padding: 9px 12px 8px 14px;/)
    expect(css).toMatch(/\.ov-one \{[^}]*gap: 9px;/)
    expect(css).toMatch(/\.ov-grown \{ padding: 6px 12px 10px 14px; \}/)
    expect(css).toMatch(/\.ov-askb, \.ov-answer \{[^}]*grid-template-columns: 14px minmax\(0, 1fr\); column-gap: 9px;/)
    expect(css).toMatch(/\.ov-offer, \.ov-waits \{ padding-left: 23px; \}/)
  })
})

describe('the slip\'s sheet is tokens only', () => {
  it('names no colour of its own: every colour is a token from app.css', () => {
    const css = readFileSync(join(__dirname, 'overlay.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi) ?? []).toEqual([])
    expect((css.match(/border-radius:\s*([^;]+);/g) ?? []).filter((r) => !/:\s*(0|999px)\b/.test(r))).toEqual([])
  })
})

describe('Set 4 R2: the slip carries a day (slip-read.js)', () => {
  it('slipOf: a second question joins the head while the task runs, and leaves it once the task has an answer', () => {
    expect(slipOf({ running: true, doing: 'Renaming 3 files', steps: 2, aside: 'what is 14 percent of 380' })).toMatchObject({ state: 'doing', line: 'Renaming 3 files · and: what is 14 percent of 380', doing: { line: 'Renaming 3 files' } })
    expect(slipOf({ running: true, said: 'rename them', aside: 'what is 14 percent of 380' }).line).toBe('“rename them” · and: what is 14 percent of 380')
    expect(slipOf({ running: false, reply: 'Renamed.', aside: 'what is 14 percent of 380' }).line).toBe('Renamed.')
  })

  it('foldAside and asideText: the answer as it comes, an ask said as one, a quiet end said as one', () => {
    let a = { q: 'what is 14 percent of 380', a: '', done: false }
    expect(asideText(a)).toBe('Working on it…')
    a = [{ type: 'text', delta: '\n53.2' }, { type: 'tool' }, { type: 'text', delta: ' (**exactly**)' }].reduce(foldAside, a)
    expect(asideText(a)).toBe('53.2 (exactly)')
    expect(asideText(foldAside({ q: 'q', a: '', done: false }, { type: 'approval' }))).toBe('It asks first: open its thread (⌥L) to answer.')
    expect(asideText(foldAside({ q: 'q', a: '', done: false }, { type: 'done' }))).toBe('No answer came.')
  })

  it('readFrames: frames split anywhere across chunks, a bad one skipped, and a done at the end', async () => {
    const enc = new TextEncoder()
    const chunks = ['data: {"type":"text","de', 'lta":"53"}\n\ndata: {bad}\n\n', 'data: {"type":"text","delta":".2"}\n\n'].map((c) => ({ done: false, value: enc.encode(c) }))
    const got = []
    await readFrames({ body: { getReader: () => ({ read: async () => chunks.shift() ?? { done: true } }) } }, (f) => got.push(f))
    expect(got).toEqual([{ type: 'text', delta: '53' }, { type: 'text', delta: '.2' }, { type: 'done' }])
  })

  it('shelfOf and slipOf: a wait on the shelf makes the slip still with its line, running or not', () => {
    expect(shelfOf({ _result: 'On the shelf: Waiting for the build, I will knock.\nThe job job-7 runs on.' })).toBe('Waiting for the build, I will knock.')
    expect(shelfOf({ _result: 'The job job-7 finished after 24s with exit code 0.' })).toBe('')
    expect(shelfOf(undefined)).toBe('')
    expect(slipOf({ running: true, shelf: 'Waiting for the build, I will knock.', doing: 'Waiting' })).toMatchObject({ state: 'still', line: 'Waiting for the build, I will knock.', shelf: true })
  })

  it("endOf: stop, offline and withdrawn from one reader; the stopped line names step and app, the offline line is the route's own", () => {
    expect(endOf({ stopped: { steps: 4, app: 'Finder' } })).toBe('Stopped at step 4 in Finder.')
    expect(endOf({ stopped: { steps: 0 } })).toBe('Stopped.')
    expect(endOf({ model: 'The backup, tensorx, answered.' })).toBe('The backup, tensorx, answered.')
    // Quiet with a tool still running is not withdrawn: said as it is, never as dropped.
    expect(endOf({ fail: 'That turn went quiet. It may still be running: reopen the session to see.' })).toBe('That turn went quiet. It may still be running: reopen the session to see.')
    expect(endOf({ fail: 'An earlier turn was withdrawn.' })).toBe(DROPPED_LINE)
    expect(endOf({ fail: DROPPED_LINE })).toBe('I dropped that, ask again.')
    expect(slipOf({ fail: DROPPED_LINE })).toMatchObject({ state: 'stopped', line: 'I dropped that, ask again.' })
    expect(slipOf({ stopped: { steps: 4, app: 'Finder' } }).line).toBe('Stopped at step 4 in Finder.')
  })

  it('DAY_ASK and evening: the question the day line answers, and the hour it becomes the still line', () => {
    for (const ask of ['what did you do today?', 'What have you done today', 'so what did you do']) expect(DAY_ASK.test(ask), ask).toBe(true)
    for (const other of ['what did you do to notes.txt?', 'what did you do in Finder today', 'did you do the build']) expect(DAY_ASK.test(other), other).toBe(false)
    expect([evening(new Date(2026, 10, 16, 16, 59)), evening(new Date(2026, 10, 16, 17, 0))]).toEqual([false, true])
  })
})
