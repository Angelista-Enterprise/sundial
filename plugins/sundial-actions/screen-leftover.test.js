// S5R3 (doc 29, runs 248 and 249): a sheet another app holds that this chat did not open is said in the same task's tool answer.
// Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { openedTrack } from '../../packages/rules/src/opened-track.ts'
import { leftovers, sheetsIn } from './screen-leftover.js'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages'))
const ROW = lookForLog(LINE)
/** The window list of run 248 T20, made up: the Save panel TextEdit holds over draft.txt, while the look reads the browser. */
const WINDOWS = [
  { processName: 'Pages', windowTitle: 'Kestrel brief', frame: [22, 61, 1200, 1086], front: true },
  { processName: 'TextEdit', windowTitle: '', frame: [555, 265, 248, 59] },
  { processName: 'TextEdit', windowTitle: 'Save', frame: [141, 218, 880, 448] },
  { processName: 'TextEdit', windowTitle: 'draft.txt', frame: [253, 150, 656, 422] },
  { processName: '1Password', windowTitle: 'Save', frame: [0, 0, 400, 300] },
]
const LINE_TEXTEDIT = 'TextEdit has a sheet you did not open in front of "draft.txt". Leave it alone and mention it in your answer.'
const chat = (id) => ({ agent: { session: { id } } })
const stateWith = (more = {}) => ({ config: { experiments: {} }, marks: { now: [], guideTally: {} }, ...more })
/** The runtime's appendSignal, as far as this needs: a `screen:leftover-said` row folds through openedTrack into `state.opened`. */
const fold = (state, rows = []) => async (type, payload) => {
  rows.push({ type, payload })
  if (type === 'screen:leftover-said') state.opened = openedTrack(state, { type, payload, ts: new Date().toISOString() }).state.opened
}

/** The look tool over one fake app that answers every look with the sample row and `windows`. */
function look(state, windows = WINDOWS) {
  const rows = {}
  const send = (command) => {
    if (command.type !== 'look') return
    rows[command.id] = { ...ROW, id: command.id, screen: { windows } }
    state.marks.lastLook = { id: command.id, app: 'Pages', n: 4 }
  }
  return screenTools(fold(state), () => state, send, async (id) => rows[id] ?? null, async () => [])[4]
}

describe('a leftover sheet in another app is said in the answer that saw it', () => {
  it('the look of another app lists TextEdit\'s Save panel over draft.txt: one line, once per task', async () => {
    const tool = look(stateWith())
    const first = await tool.execute({ app: 'Pages' }, chat('chat-1'))
    expect(first.split(LINE_TEXTEDIT)).toHaveLength(2)
    expect(await tool.execute({ app: 'Pages' }, chat('chat-1'))).not.toContain('sheet you did not open')
    // Another chat is told too.
    expect(await tool.execute({ app: 'Pages' }, chat('chat-2'))).toContain(LINE_TEXTEDIT)
  })

  it('nothing for a private app, for a sheet this chat opened, or with no panel in the list', async () => {
    expect(sheetsIn({ app: 'Pages', screen: { windows: WINDOWS } })).toEqual([{ app: 'TextEdit', window: 'draft.txt' }, { app: '1Password' }])
    expect(await look(stateWith()).execute({ app: 'Pages' }, chat('chat-1'))).not.toContain('1Password has a sheet')
    const own = stateWith({ opened: { chats: { 'chat-1': { at: '2026-11-17T09:00:00Z', items: [{ kind: 'sheet', app: 'TextEdit', label: 'Save sheet', window: 'draft.txt', at: '2026-11-17T09:00:00Z', step: 'act-1' }] } }, fronts: {} } })
    expect(await look(own).execute({ app: 'Pages' }, chat('chat-1'))).not.toContain('sheet you did not open')
    expect(await look(stateWith(), WINDOWS.filter((w) => w.windowTitle !== 'Save')).execute({ app: 'Pages' }, chat('chat-1'))).not.toContain('sheet you did not open')
  })

  it('an act\'s answer says it too, from its after-look\'s window list', async () => {
    const looks = { [ROW.id]: ROW }
    const state = stateWith({ config: { experiments: { screenAct: true } }, window: { active: { processName: 'Pages', windowTitle: 'Lunch Thursday', windowId: 'w1' } } })
    state.marks.lastLook = { id: ROW.id, app: 'Pages', window: 'Lunch Thursday', n: 4 }
    const send = (command) => {
      if (command.type === 'look') return void ((looks[command.id] = { ...ROW, id: command.id }), (state.marks.lastLook = { id: command.id, app: 'Pages', n: 4 }))
      state.marks.lastAct = { id: command.id, outcome: 'performed' }
      const id = `look-after-${command.id}`
      looks[id] = { ...ROW, id, after: command.id, windowTitle: 'New Note', screen: { windows: WINDOWS } }
      state.marks.lastLook = { id, after: command.id, app: 'Pages', n: 4 }
    }
    const [, , act] = screenTools(fold(state), () => state, send, async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null, async () => [])
    expect(await act.execute({ app: 'Pages', role: 'button', label: 'New Note', action: 'press' }, chat('chat-1'))).toContain(LINE_TEXTEDIT)
  })

  it('the fold\'s sighting (the sensor) is said too, in an app other than the one looked at; a new task says it again', () => {
    const now = Date.parse('2026-11-17T09:01:00Z')
    const state = stateWith({ opened: { chats: {}, fronts: {}, sensed: { TextEdit: { sheet: true, window: 'notes.txt', at: '2026-11-17T09:00:00Z' } } } })
    const say = leftovers(() => state, fold(state))
    expect(say({ app: 'TextEdit', screen: { windows: [] } }, 'chat-1', now)).toBe('')
    expect(say({ app: 'Pages', screen: { windows: [] } }, 'chat-1', now)).toBe('\nTextEdit has a sheet you did not open in front of "notes.txt". Leave it alone and mention it in your answer.')
    expect(say({ app: 'Pages', screen: { windows: [] } }, 'chat-1', now)).toBe('')
    state.tasks = { 'chat-1': { id: 'task-2', at: '2026-11-17T09:00:30Z', session: 'chat-1' } }
    expect(say({ app: 'Pages' }, 'chat-1', now)).toMatch(/^\nTextEdit has a sheet you did not open/)
  })

  it('what was said is on the record: after a restart (a fresh fold of the rows, a new instance) the same task does not say it again, a new task does', () => {
    const now = Date.parse('2026-11-17T09:01:00Z')
    const task = (id) => ({ 'chat-1': { id, at: '2026-11-17T09:00:30Z', session: 'chat-1' } })
    const before = stateWith({ tasks: task('task-1') })
    const rows = []
    expect(leftovers(() => before, fold(before, rows))({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now)).toBe(`\n${LINE_TEXTEDIT}`)
    expect(rows).toEqual([{ type: 'screen:leftover-said', payload: { session: 'chat-1', app: 'TextEdit', window: 'draft.txt', task: 'task-1' } }])
    const after = stateWith({ tasks: task('task-1') })
    for (const { type, payload } of rows) after.opened = openedTrack(after, { type, payload, ts: '2026-11-17T09:00:40Z' }).state.opened
    const again = []
    const say = leftovers(() => after, fold(after, again))
    expect(say({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now)).toBe('')
    expect(again).toEqual([])
    after.tasks = task('task-2')
    expect(say({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now)).toBe(`\n${LINE_TEXTEDIT}`)
  })

  // Runs 252 and 253 (doc 30, answer 3): the wall task earlier in the same chat had pressed cmd+s in a copy of its notes; that step's
  // after-look was replaced before its row, so its Save sheet went on record with no window. "No window on record" matched every
  // TextEdit sheet, and the draft's sheet the mess left was never said.
  const sheet = (more) => ({ kind: 'sheet', app: 'TextEdit', label: 'Save sheet', at: '2026-11-17T09:00:00Z', step: 'act-1', ...more })
  const ownState = (items, task = 'task-mess') => stateWith({ opened: { chats: { 'chat-1': { at: '2026-11-17T09:00:00Z', items } }, fronts: {} }, tasks: { 'chat-1': { id: task, at: '2026-11-17T09:00:30Z', session: 'chat-1' } } })
  const now = Date.parse('2026-11-17T09:01:00Z')

  it('runs 252, 253: a sheet this chat opened over another document, or with no window on record, does not hide the draft\'s', () => {
    for (const own of [sheet({ task: 'task-wall' }), sheet({ task: 'task-wall', window: 'Untitled (notes copy)' }), sheet({ task: 'task-mess', window: 'Untitled (notes copy)' })])
      expect(leftovers(() => ownState([own]))({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now)).toBe(`\n${LINE_TEXTEDIT}`)
  })

  it('a sheet this chat opened over that document is this task\'s own (nothing), or left open from an earlier task (said so)', () => {
    expect(leftovers(() => ownState([sheet({ task: 'task-mess', window: 'draft.txt' })]))({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now)).toBe('')
    expect(leftovers(() => ownState([sheet({ task: 'task-wall', window: 'draft.txt' })]))({ app: 'Pages', screen: { windows: WINDOWS } }, 'chat-1', now))
      .toBe('\nTextEdit has a sheet you left open in an earlier task in front of "draft.txt". Leave it alone and mention it in your answer.')
  })

  it('two sheets in one app: this task\'s own over its copy is not said, the draft\'s is; each sheet sits on the window under it', () => {
    // Made up after run 252's window list: front to back, each sheet just above its window, all of them overlapping.
    const windows = [
      { processName: 'Pages', windowTitle: 'Kestrel brief', frame: [22, 61, 1200, 1086], front: true },
      { processName: 'TextEdit', windowTitle: 'Save', frame: [286, 327, 880, 448] },
      { processName: 'TextEdit', windowTitle: 'draft.txt', frame: [398, 295, 656, 422] },
      { processName: 'TextEdit', windowTitle: 'Save', frame: [83, 160, 880, 448] },
      { processName: 'TextEdit', windowTitle: 'Untitled (notes copy)', frame: [195, 92, 656, 422] },
    ]
    expect(sheetsIn({ app: 'Pages', screen: { windows } })).toEqual([{ app: 'TextEdit', window: 'draft.txt' }, { app: 'TextEdit', window: 'Untitled (notes copy)' }])
    expect(leftovers(() => ownState([sheet({ task: 'task-mess', window: 'Untitled (notes copy)' })]))({ app: 'Pages', screen: { windows } }, 'chat-1', now)).toBe(`\n${LINE_TEXTEDIT}`)
  })
})
