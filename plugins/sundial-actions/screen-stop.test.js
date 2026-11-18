// Set 4 R1 bench: the steps of one screen_act end early when the owner presses Stop (run 211 T18: four renames ran in the 4 s
// after it) or when a type left the keyboard in another field than the ref it was aimed at (run 213 T03: "To" went into the
// page's Quick find, then Send was pressed on an empty To). Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { lookOf, wentTo } from './screen-look.js'
import { screenTools } from './screen-tools.js'

// Notes is private by name since 2026-11-17 (privateAppName): the sample look is read as a Pages window.
const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages'))
const TO = { ref: 'e30', role: 'AXTextField', sub: '', label: 'To', value: '', frame: [240, 60, 300, 24], actions: [], settable: true, enabled: true, in: 'New message' }
// The look the call plans on holds a To field; the keyboard stays in Search (e7) after every act.
const ROW = lookForLog({ ...LINE, elements: [...LINE.elements, TO] })

/** A fake Pages; `onAct(n)` runs as act n is sent; `sent` counts the acts. */
function tools(onAct = () => {}) {
  const sent = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'Pages', windowTitle: 'Lunch Thursday', windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', window: 'Lunch Thursday', n: 5 } } }
  const send = (command) => {
    if (command.type !== 'act') return
    sent.push(command)
    onAct(sent.length)
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    const id = `look-after-${command.id}`
    looks[id] = { ...ROW, id, after: command.id }
    state.marks.lastLook = { id, after: command.id, app: 'Pages', n: 5 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const [, , act] = screenTools(async () => {}, () => state, send, readRow, async () => [])
  return { act, sent }
}
const tag = ROW.id.slice(-4)

describe('the steps of one call end early', () => {
  it('the owner\'s Stop (the call\'s abort signal) ends the chain at the next step (run 211 T18)', async () => {
    const stop = new AbortController()
    const t = tools((n) => n === 1 && stop.abort())
    const out = await t.act.execute({ app: 'Pages', steps: [{ action: 'press', role: 'button', label: 'New Note' }, { action: 'key', value: 'cmd+c' }, { action: 'key', value: 'cmd+v' }] }, { signal: stop.signal })
    expect(t.sent).toHaveLength(1)
    expect(out).toMatch(/\n2 more not run \(stopped: the owner stopped the turn\): look again, then go on\./)
  })

  it('a type aimed at the To field that left the keyboard in Search stops before the Send (run 213 T03)', async () => {
    const t = tools()
    const out = await t.act.execute({ app: 'Pages', steps: [{ ref: `e30@${tag}`, action: 'type', value: 'mira@example.org' }, { ref: `e1@${tag}`, action: 'press' }] })
    expect(t.sent).toHaveLength(1)
    expect(out).toMatch(/^1\. Type "To" in Pages: "mira@example\.org": [a-z]+\. The text went to the field with the keyboard: e7@\w{4} search field "Search"\. It was meant for "To"\.\n1 more not run \(stopped: the text went to another field than the one named\)/)
  })

  it('wentTo: strayed only for a type aimed at a ref whose field did not get the keyboard', () => {
    // As the act reads its after-look (screen-tools.js `read`): the look parsed from its row.
    const now = lookOf(ROW)
    const type = (ref, name) => ({ verb: 'type', thing: { name }, command: { value: 'x', ...(ref ? { ref } : {}) } })
    expect(wentTo(type('e30', 'To'), { now }).strayed).toBe(true)
    // The keyboard in the field it was aimed at, a field of the same words, a type by name (the app finds it), a set-value: no.
    expect(wentTo(type('e7', 'Search'), { now }).strayed).toBe(false)
    expect(wentTo(type('e31', 'Search notes'), { now }).strayed).toBe(false)
    expect(wentTo(type(null, 'To'), { now }).strayed).toBe(false)
    expect(wentTo({ ...type('e30', 'To'), verb: 'set-value' }, { now }).strayed).toBe(false)
  })

  it('Set 5 R1 (plan 2F): a call that starts just after a Stop runs no act, its first step neither, in a chain or alone', async () => {
    const stop = new AbortController()
    stop.abort()
    const chain = tools()
    await expect(chain.act.execute({ app: 'Pages', steps: [{ action: 'press', role: 'button', label: 'New Note' }, { action: 'key', value: 'cmd+c' }] }, { signal: stop.signal })).rejects.toThrow(/^2 more not run \(stopped: the owner stopped the turn\): look again, then go on\./)
    expect(chain.sent).toEqual([])
    const one = tools()
    await expect(one.act.execute({ app: 'Pages', action: 'press', role: 'button', label: 'New Note' }, { signal: stop.signal })).rejects.toThrow(/^refused: stopped: the owner stopped the turn, so this step did not run\./)
    expect(one.sent).toEqual([])
  })
})
