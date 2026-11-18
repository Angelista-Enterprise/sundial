// S4R2: text Gnomon set itself is not the owner's. A second set-value in the same chat (a typo fixed) goes without replace: true,
// and Sundial.app's `own` (the field still holds what Gnomon last set there) keeps it from being undone. Made-up values only.
// S5R1 (Fable M2): only in the same task, the owner's hand still since, by a real label and role, and at the length Gnomon set.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { markTrack } from '../../packages/rules/src/mark-track.ts'
import { mine } from './screen-own.js'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const AREA = { ref: 'e40', role: 'AXTextArea', sub: '', label: 'Draft', value: '', frame: [240, 120, 600, 300], actions: [], settable: true, enabled: true, in: 'Lunch Thursday' }
const TASKS = { c1: { id: 'task-1', at: '2026-11-16T09:00:00.000Z', session: 'c1' }, c2: { id: 'task-2', at: '2026-11-16T09:00:00.000Z', session: 'c2' } }
const row = (id, value) => lookForLog({ ...LINE, id, elements: [...LINE.elements, { ...AREA, value }] })

/** A fake Notes whose Draft starts empty; `answers[n]` is what the app adds to act n's answer (the fold reads it, as live). */
function tools(answers) {
  const sent = []
  const looks = { [LINE.id]: row(LINE.id, '') }
  let state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'Notes', windowTitle: 'Lunch Thursday', windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: LINE.id, app: 'Notes', window: 'Lunch Thursday', n: 5 } }, tasks: { ...TASKS } }
  const fold = (type, payload) => { state = markTrack(state, { id: `${type}-${Date.now()}`, type, ts: new Date().toISOString(), payload }).state }
  const send = (command) => {
    if (command.type !== 'act') return
    sent.push(command)
    fold('screen:acted', { id: command.id, outcome: 'performed', ...answers[sent.filter((c) => c.action !== 'undo').length - 1] })
    // The after-look holds the text the set-value put there.
    const id = `look-after-${command.id}`
    looks[id] = { ...row(id, command.value ?? ''), after: command.id }
    state.marks.lastLook = { id, after: command.id, app: 'Notes', window: 'Lunch Thursday', n: 5 }
  }
  const append = async (type, payload) => { if (type === 'screen:step') fold(type, payload) }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((r) => r[field] === id) ?? null
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [])
  return { act, sent, state: () => state }
}
const chat = (id) => ({ agent: { session: { id } } })
const draft = (value) => ({ app: 'Notes', role: 'text area', label: 'Draft', value })

describe('text Gnomon set itself', () => {
  it('a second set-value in the same chat goes, and is not undone when the app says own', async () => {
    const t = tools([{ replacedChars: 0 }, { replacedChars: 0, own: true }])
    expect(await t.act.execute(draft('Soup with Mira Bakkr'), chat('c1'))).toMatch(/^Done \(set-value\)/)
    expect(await t.act.execute(draft('Soup with Mira Bakker'), chat('c1'))).toMatch(/^Done \(set-value\)/)
    expect(t.sent.map((c) => c.action)).toEqual(['set-value', 'set-value'])
    // Another chat never set it: the field is the owner's there, refused before the act.
    await expect(t.act.execute(draft('x'), chat('c2'))).rejects.toThrow(/replaces ALL the text in "Draft"/)
  })

  it('the owner edited it since (the app says not own): put back and refused, as the owner\'s text', async () => {
    const t = tools([{ replacedChars: 0 }, { replacedChars: 20 }])
    await t.act.execute(draft('Soup with Mira Bakkr'), chat('c1'))
    await expect(t.act.execute(draft('Soup with Mira Bakker'), chat('c1'))).rejects.toThrow(/already held the owner's text/)
    expect(t.sent.map((c) => c.action)).toEqual(['set-value', 'set-value', 'undo'])
  })

  it('S5R1 (Fable M2): a new task in the chat makes the field the owner\'s again: refused before the act', async () => {
    const t = tools([{ replacedChars: 0 }, { replacedChars: 0, own: true }])
    await t.act.execute(draft('Soup with Mira Bakkr'), chat('c1'))
    t.state().tasks.c1 = { id: 'task-3', at: new Date().toISOString(), session: 'c1' }
    await expect(t.act.execute(draft('Soup with Mira Bakker'), chat('c1'))).rejects.toThrow(/replaces ALL the text in "Draft"/)
    expect(t.sent.map((c) => c.action)).toEqual(['set-value'])
  })

  it('S5R1 (Fable M2): the mark is stale after the owner\'s hand, at another length, by a ref alone or another role', () => {
    const set = { app: 'Notes', name: 'Draft', role: 'text area', at: '2026-11-16T10:00:00.000Z', task: 'task-1', chars: 20 }
    const state = { tasks: TASKS, marks: { chats: { c1: { set } } } }
    const area = { ...AREA, value: 'Soup with Mira Bakkr' }
    expect(mine(area, state, 'c1', 'Notes')).toBe(true)
    expect(mine(area, { ...state, lifeEvent: { idle: { ownerHandAt: '2026-11-16T10:00:05.000Z' } } }, 'c1', 'Notes'), 'the owner\'s hand since').toBe(false)
    expect(mine(area, { ...state, lifeEvent: { idle: { ownerHandAt: '2026-11-16T09:59:00.000Z' } } }, 'c1', 'Notes'), 'the owner\'s hand before').toBe(true)
    expect(mine({ ...area, value: 'Soup with Mira Bakkr, 2' }, state, 'c1', 'Notes'), 'another length').toBe(false)
    expect(mine({ ...area, value: 'Soup', chars: 20 }, state, 'c1', 'Notes'), 'a folded look: its real length').toBe(true)
    expect(mine({ ...area, label: '' }, { ...state, marks: { chats: { c1: { set: { ...set, name: 'e40' } } } } }, 'c1', 'Notes'), 'a ref alone').toBe(false)
    expect(mine({ ...area, role: 'AXTextField' }, state, 'c1', 'Notes'), 'another role').toBe(false)
    expect(mine(area, { ...state, marks: { chats: { c1: { set: { ...set, role: undefined } } } } }, 'c1', 'Notes'), 'no role kept').toBe(false)
    expect(mine(area, state, 'c1', 'Mail'), 'another app').toBe(false)
    expect(mine(area, state, 'c2', 'Notes'), 'another chat').toBe(false)
  })

  it('S5R1 (Fable M2): the fold keeps the task and the length it set, never the value, and a refused set-value drops it', () => {
    const at = (s) => `2026-11-16T10:00:0${s}.000Z`
    let state = { tasks: TASKS, marks: { now: [], guideTally: {} } }
    state = markTrack(state, { id: 's1', type: 'screen:step', ts: at(1), payload: { id: 'act-1', session: 'c1', processName: 'Notes', verb: 'set-value', role: 'text area', screenText: ['Draft'], typed: 20, ok: true } }).state
    expect(state.marks.chats.c1.set).toEqual({ app: 'Notes', name: 'Draft', role: 'text area', at: at(1), task: 'task-1', chars: 20 })
    state = markTrack(state, { id: 's2', type: 'screen:step', ts: at(2), payload: { id: 'act-2', session: 'c1', processName: 'Notes', verb: 'set-value', role: 'text area', screenText: ['Draft'], typed: 21, ok: false, reason: 'replaced the owner\'s own text' } }).state
    expect(state.marks.chats.c1.set).toBeUndefined()
  })
})

// Run 253 T19: two set-values sent replace as the string "true" were refused, and the name never went into the Save panel.
describe('replace as a string', () => {
  it('"true" replaces as true does, in one step and in a steps list, and is not put back; "false" is still refused', async () => {
    const t = tools([{ replacedChars: 0 }, { replacedChars: 20 }, { replacedChars: 12 }])
    await t.act.execute(draft('Soup with Mira Bakkr'), chat('c1'))
    expect(await t.act.execute({ ...draft('Soup at noon'), replace: 'true' }, chat('c2'))).toMatch(/^Done \(set-value\)/)
    expect(await t.act.execute({ app: 'Notes', steps: [{ role: 'text area', label: 'Draft', value: 'Soup at one', replace: 'TRUE' }] }, chat('c2'))).toMatch(/1\. .*: done/)
    expect(t.sent.map((c) => c.action)).toEqual(['set-value', 'set-value', 'set-value'])
    await expect(t.act.execute({ ...draft('x'), replace: 'false' }, chat('c3'))).rejects.toThrow(/replaces ALL the text in "Draft"/)
  })
})
