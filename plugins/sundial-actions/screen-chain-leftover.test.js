// A chain of steps answers with its last step's text. The "has a sheet you did not open" line is said once per chat, task and app,
// by the first look that sees the sheet: when that is an earlier step's after-look, the chain's answer must still carry it.
// Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { openedTrack } from '../../packages/rules/src/opened-track.ts'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages'))
const ROW = lookForLog(LINE)
const WINDOWS = [
  { processName: 'Pages', windowTitle: 'Kestrel brief', frame: [22, 61, 1200, 1086], front: true },
  { processName: 'TextEdit', windowTitle: 'Save', frame: [141, 218, 880, 448] },
  { processName: 'TextEdit', windowTitle: 'draft.txt', frame: [253, 150, 656, 422] },
]
const SAID = 'TextEdit has a sheet you did not open in front of "draft.txt". Leave it alone and mention it in your answer.'

describe('a chain keeps the leftover line an earlier step said', () => {
  it('said by step 1\'s after-look, the answer of a two-step chain carries it once', async () => {
    const looks = { [ROW.id]: ROW }
    const state = { config: { experiments: { screenAct: true } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', window: 'Lunch Thursday', n: 4 } }, window: { active: { processName: 'Pages', windowTitle: 'Lunch Thursday', windowId: 'w1' } } }
    let n = 0
    const send = (command) => {
      if (command.type === 'look') return void ((looks[command.id] = { ...ROW, id: command.id, screen: { windows: WINDOWS } }), (state.marks.lastLook = { id: command.id, app: 'Pages', n: 4 }))
      state.marks.lastAct = { id: command.id, outcome: 'performed' }
      const id = `look-after-${command.id}`
      looks[id] = { ...ROW, id, after: command.id, windowTitle: `Note ${++n}`, screen: { windows: WINDOWS } }
      state.marks.lastLook = { id, after: command.id, app: 'Pages', n: 4 }
    }
    // A said line goes on the record and folds (as the runtime does), so step 2's look does not say it again: step 1's text keeps it.
    const fold = async (type, payload) => void (type === 'screen:leftover-said' && (state.opened = openedTrack(state, { type, payload, ts: new Date().toISOString() }).state.opened))
    const [, , act] = screenTools(fold, () => state, send, async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null, async () => [])
    const out = await act.execute({ app: 'Pages', steps: [{ role: 'button', label: 'New Note', action: 'press' }, { role: 'button', label: 'New Note', action: 'press' }] }, { agent: { session: { id: 'chat-1' } } })
    expect(out.split(SAID)).toHaveLength(2)
  }, 15_000)
})
