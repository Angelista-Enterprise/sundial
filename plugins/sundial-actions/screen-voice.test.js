// Round 5 (NEXT 3.1): a screen step says its own line as it starts. screen-tools.js builds the line (`stepLine`) and
// hands it to the voice before the act goes; voice-turn.js says it in a spoken turn only. Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { privateApp } from './gate.js'
import { refusedOf, screenTools, stepLine } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)

/** The tools over a fake app that performs every act and shows the same Pages window after it; `order` is what went out, in turn. */
function tools(refuse = () => false) {
  const order = []
  const rows = { [ROW.id]: ROW }
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', n: 4 } } }
  const send = (command) => {
    order.push({ type: command.type, id: command.id })
    if (command.type === 'look') {
      rows[command.id] = { ...ROW, id: command.id }
      state.marks.lastLook = { id: command.id, app: 'Pages', n: 4 }
      return
    }
    if (refuse(command)) return void (state.marks.lastAct = { id: command.id, outcome: 'refused', reason: 'not-found' })
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    const id = `look-after-${command.id}`
    rows[id] = { ...ROW, id, after: command.id, windowTitle: 'New Note' }
    state.marks.lastLook = { id, after: command.id, app: 'Pages', n: 4 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((row) => (field === 'tag' ? String(row.id).endsWith(id) : row[field] === id)) ?? null
  const say = (line) => order.push({ type: 'say', ...line })
  const [, , act] = screenTools(async () => {}, () => state, send, readRow, async () => [], { say })
  return { act, order }
}
const chat = { agent: { session: { id: 'session-7f' } } }

describe("a step's spoken line (stepLine)", () => {
  it('a step that waits says its own because; a quick single press, a wait, a caret or copy key, an escape say nothing', () => {
    expect(stepLine({ verb: 'open', app: 'Finder', because: 'open Finder' }, 'Open Finder for the memo')).toBe('Open Finder for the memo')
    expect(stepLine({ verb: 'pick-menu', app: 'Finder', because: 'pick-menu "Sort By" in Finder' }, '')).toBe('pick-menu "Sort By" in Finder')
    expect(stepLine({ verb: 'press', app: 'Pages', because: 'press "New Note" in Pages' }, 'Press New Note', true)).toBe('Press New Note')
    expect(stepLine({ verb: 'press', app: 'Pages', because: 'press "New Note" in Pages' }, 'Press New Note')).toBeNull()
    for (const quick of [{ verb: 'wait' }, { verb: 'key', command: { value: 'cmd+c' } }, { verb: 'key', command: { value: 'down' } }, { verb: 'key', command: { value: 'escape' } }, { verb: 'press', unkept: true }])
      expect(stepLine({ app: 'Pages', because: 'x in Pages', ...quick }, 'Do it', true)).toBeNull()
  })

  it("never the typed value: a because that holds it gives way to the code's line, which never does; past 6 words too", () => {
    const typing = { verb: 'type', app: 'Pages', because: 'type "Title" in Pages', command: { value: 'Call Mira Bakker' } }
    expect(stepLine(typing, 'Type call mira bakker', true)).toBe('type "Title" in Pages')
    expect(stepLine(typing, 'Type the title', true)).toBe('Type the title')
    expect(stepLine({ verb: 'open', app: 'Zen', url: 'https://example.org/a', because: 'open https://example.org/a in Zen and then some more' }, 'Open the page with the puzzlebox studio release notes')).toBe('open https://example.org/a in Zen and then')
  })

  it('never a private app: not the one acted in, not one named in the line', () => {
    expect(privateApp('1Password')).toBe(true)
    expect(stepLine({ verb: 'open', app: '1Password', because: 'open 1Password' }, 'Open the vault')).toBeNull()
    expect(stepLine({ verb: 'open', app: 'Pages', because: 'open Pages' }, 'Copy it from 1Password')).toBeNull()
    expect(stepLine({ verb: 'open', app: 'Pages', because: 'open Pages' }, 'Open [private] in Pages')).toBeNull()
  })
})

describe('screen_act hands the line to the voice before the act goes', () => {
  it('each step of a chain: its own because, with the act id, ahead of its act', async () => {
    const t = tools()
    await t.act.execute({ app: 'Pages', steps: [{ app: 'Pages', role: 'button', label: 'New Note', action: 'press', because: 'Start a new note' }, { action: 'key', value: 'cmd+c' }] }, chat)
    const acts = t.order.filter((o) => o.type === 'act')
    expect(acts).toHaveLength(2)
    expect(t.order.filter((o) => o.type === 'say')).toEqual([{ type: 'say', session: 'session-7f', stepId: acts[0].id, line: 'Start a new note', next: 'Start a new note' }])
    expect(t.order.findIndex((o) => o.type === 'say')).toBeLessThan(t.order.findIndex((o) => o.id === acts[0].id))
  })

  it('a single quick press has no line of its own, only its words for a refusal before it; a call outside a chat says nothing', async () => {
    const t = tools()
    await t.act.execute({ target: { app: 'Pages', role: 'button', label: 'New Note' }, action: 'press', because: 'Start a new note' }, chat)
    await t.act.execute({ target: { app: 'Pages' }, because: 'Open Pages' })
    expect(t.order.filter((o) => o.type === 'say').map((o) => [o.line, o.next])).toEqual([[null, 'Start a new note']])
  })
})

// Set 2 R1 item 5: a refused act hands its own words to the voice (voice-turn.js holds them for the next step).
describe('a refused step hands the voice what it may say of itself (refusedOf)', () => {
  it("its thing's name and the reason; never the typed value, never a private app, never a step of Sundial's own", () => {
    expect(refusedOf({ verb: 'pick-menu', app: 'Finder', thing: { name: 'View > Sort By' } }, 'not-found')).toEqual({ reason: 'not-found', name: 'View > Sort By' })
    expect(refusedOf({ verb: 'type', app: 'Pages', thing: { name: 'Call Mira Bakker' }, command: { value: 'call mira bakker' } }, 'not-found')).toEqual({ reason: 'not-found', name: '' })
    expect(refusedOf({ verb: 'press', app: '1Password', thing: { name: 'Vault' } }, 'not-found')).toBeNull()
    expect(refusedOf({ verb: 'press', app: 'Pages', thing: { name: '[private]' } }, 'not-found')).toBeNull()
    expect(refusedOf({ verb: 'key', app: 'Pages', thing: { name: 'escape' }, unkept: true }, 'covered')).toBeNull()
  })

  it('screen_act: the refusal goes to the voice with the act id, after the step that was refused; outside a chat, nothing', async () => {
    const t = tools((c) => c.type === 'act')
    await expect(t.act.execute({ target: { app: 'Pages', role: 'button', label: 'New Note' }, action: 'press', because: 'Start a new note' }, chat)).rejects.toThrow(/refused: not-found/)
    const act = t.order.filter((o) => o.type === 'act').at(-1)
    expect(t.order.findLastIndex((o) => o.refused)).toBeGreaterThan(t.order.indexOf(act))
    expect(t.order.filter((o) => o.type === 'say').at(-1)).toEqual({ type: 'say', session: 'session-7f', stepId: act.id, refused: { reason: 'not-found', name: 'New Note' } })
    const typed = tools((c) => c.type === 'act')
    await typed.act.execute({ target: { app: 'Pages', role: 'button', label: 'New Note' }, action: 'press', because: 'Start a new note' }).catch(() => {})
    expect(typed.order.filter((o) => o.type === 'say')).toEqual([])
  })
})
