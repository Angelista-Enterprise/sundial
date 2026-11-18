// A step that changed nothing in a dialog (run 219 T19) and a stale pick its pop-up already shows (run 222 T22). Made-up values.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { markTrack } from '../../packages/rules/src/mark-track.ts'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)
const LOOKED = { lastLook: { id: ROW.id, app: 'Notes', n: 4 } }
/** screen-tools.test.js's fake record, cut down: `answers[n]` is what the app says to the n-th act, `afters[n]` (else `after`) its after-look. */
function tools({ answer = null, answers = [], marks = {}, after = { windowTitle: 'New Note' }, afters = [] } = {}) {
  const signals = []
  const sent = []
  const rows = { [ROW.id]: ROW }
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, ...marks } }
  let latest = null
  const send = (command) => {
    sent.push(command)
    if (command.type === 'look') {
      rows[command.id] = { ...(latest ?? ROW), id: command.id, after: undefined }
      state.marks.lastLook = { id: command.id, app: 'Notes', n: 4 }
      return
    }
    const n = sent.filter((c) => c.type === 'act').length - 1
    const said = answers[n] ?? answer
    if (said) state.marks.lastAct = { id: command.id, ...said }
    if (said?.outcome !== 'performed') return
    const id = n === 0 ? 'look-after' : `look-after${n}-fter`
    latest = rows[id] = { ...ROW, id, after: command.id, ...(afters[n] ?? after) }
    state.marks.lastLook = { id, after: command.id, app: 'Notes', n: 4 }
  }
  const append = async (type, payload) => {
    signals.push({ type, ...payload })
    if (/^screen:(printed|step)$/.test(type)) state.marks = markTrack(state, { id: type, type, ts: new Date().toISOString(), payload }).state.marks
    if (payload.id) state.marks.placed = [...(state.marks.placed ?? []), payload.id]
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((row) => (field === 'tag' ? String(row.id).endsWith(id) : row[field] === id)) ?? null
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [])
  return { act, signals, sent }
}
const acts = (t) => t.sent.filter((c) => c.type === 'act').map((c) => c.ref ?? c.value ?? c.target?.label)

describe('a step the screen did not take', () => {
  it('a Return that changed nothing in a sheet presses its one plain default button by name (run 219 T19: the Save sheet takes no keys)', async () => {
    const button = (ref, label, x) => ({ ref, role: 'AXButton', sub: '', label, value: '', frame: [x, 478, 81, 26], actions: ['AXPress'], settable: false, enabled: true, in: 'save' })
    const field = { ref: 'e58', role: 'AXTextField', sub: '', label: '', value: 'notes copy.txt', frame: [524, 275, 232, 26], actions: ['AXConfirm'], settable: true, enabled: true, in: 'save' }
    const sheet = (buttons) => ({ windowTitle: '', dialog: true, elements: lookForLog({ ...LINE, elements: [field, ...buttons] }).elements })
    const both = [button('e64', 'Cancel', 652), button('e65', 'Save', 739)]
    const steps = [{ action: 'key', value: 'cmd+s' }, { action: 'key', value: 'return' }]
    const t = tools({ answer: { outcome: 'performed' }, marks: LOOKED, afters: [sheet(both), sheet(both), { windowTitle: 'notes copy.txt', dialog: false }] })
    const out = await t.act.execute({ app: 'Notes', goal: 'save a copy', steps })
    expect(acts(t)).toEqual(['cmd+s', 'return', 'e65'])
    expect(out.split('\n')[1]).toBe('2. Key in Notes: "return": done. Return changed nothing in the Notes dialog (keys do not reach it), so its "Save" button was pressed by name')
    expect(t.signals.filter((x) => x.type === 'screen:step').map((x) => [x.verb, x.key ?? x.screenText[0]])).toEqual([['key', 'cmd+s'], ['key', 'return'], ['press', 'Save']])
    // Never a final's button (the gate was shown only Return), never one of two plain ones, never outside a dialog.
    const not = [[button('e64', 'Cancel', 652), button('e66', "Don't Save", 560), button('e65', 'Delete', 739)], [button('e64', 'Open', 652), button('e65', 'Save', 739)]].map((b) => [sheet(b), sheet(b)])
    for (const afters of [...not, [{ ...sheet(both), dialog: false }, { ...sheet(both), dialog: false }]]) {
      const n = tools({ answer: { outcome: 'performed' }, marks: LOOKED, afters })
      await n.act.execute({ app: 'Notes', steps })
      expect(acts(n)).toEqual(['cmd+s', 'return'])
    }
  }, 15_000)

  it('a stale pick of the item its pop-up already shows is no refusal: the steps after it run (run 222 T22: the Submit never ran)', async () => {
    const form = (value) => ({ elements: lookForLog({ ...LINE, elements: [LINE.elements[0], { ref: 'e40', role: 'AXMenuItem', sub: '', label: 'Large', value: '', frame: [500, 300, 80, 20], actions: ['AXPress'], settable: false, enabled: true, in: 'menu' }, { ref: 'e41', role: 'AXPopUpButton', sub: '', label: '', value, frame: [500, 280, 80, 20], actions: ['AXPress'], settable: false, enabled: true, in: 'form' }] }).elements })
    const steps = [{ action: 'key', value: 'cmd+n' }, { action: 'press', role: 'menu item', label: 'Large' }, { role: 'button', label: 'New Note' }]
    const stale = { outcome: 'refused', reason: 'look again' }
    // The second try of a step by name (run 16) goes by its words; then the fresh look says Large is already chosen.
    for (const [value, sent] of [['Large', ['cmd+n', 'e40', 'Large', 'e1']], ['Small', ['cmd+n', 'e40', 'Large']]]) {
      const t = tools({ marks: LOOKED, answers: [{ outcome: 'performed' }, stale, stale, { outcome: 'performed' }], after: form(value) })
      const out = await t.act.execute({ app: 'Notes', steps }).catch((e) => e.message)
      expect(acts(t)).toEqual(sent)
      if (value === 'Large') expect(out.split('\n')[1]).toBe('2. Press "Large" in Notes: done. "Large" is already chosen in its pop-up: nothing was pressed')
      else expect(out).toMatch(/Stopped at step 2/)
    }
  })
})
