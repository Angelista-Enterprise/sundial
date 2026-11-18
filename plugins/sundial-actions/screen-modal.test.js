// Set 5 R2 (plan 21, 2E): a sheet left in front by an earlier task is said before any key goes to the app (run 215 typed an
// address into a leftover Save sheet). Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)

function tools(shown) {
  const sent = []
  const front = { dialog: true, look: ROW.id, at: new Date().toISOString(), window: 'Lunch Thursday' }
  const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'Notes', windowTitle: 'Lunch Thursday', windowId: 'w1' } }, opened: { chats: {}, fronts: { Notes: front } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Notes', window: 'Lunch Thursday', n: 5 }, ...(shown ? { chats: { '': { look: { id: ROW.id } } } } : {}) } }
  const send = (command) => {
    if (command.type !== 'act') return
    sent.push(command)
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    state.marks.lastLook = { id: `look-after-${command.id}`, after: command.id, app: 'Notes', n: 5 }
  }
  const readRow = async (id, { field = 'id' } = {}) => (ROW[field] === id ? ROW : field === 'after' ? { ...ROW, id: `look-after-${id}`, after: id } : null)
  const [, , act] = screenTools(async () => {}, () => state, send, readRow, async () => [])
  return { act, sent }
}

describe('a sheet in front that this task did not open', () => {
  it('refuses the key before it is sent, and names the sheet and the look to take', async () => {
    const t = tools(false)
    await expect(t.act.execute({ app: 'Notes', action: 'key', value: 'cmd+v' }, {})).rejects.toThrow(/^refused: Notes has a sheet or dialog in front of "Lunch Thursday", and this task did not open it: a key sent now goes into it\. screen_look Notes first/)
    expect(t.sent).toEqual([])
  })

  it('lets the key go once that look was printed in this chat', async () => {
    const t = tools(true)
    await t.act.execute({ app: 'Notes', action: 'key', value: 'cmd+v' }, {}).catch(() => {})
    expect(t.sent).toHaveLength(1)
  })
})
