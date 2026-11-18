// Set 5 R2: the app notes `appNotes` mines from failed steps reach the model in the look of that app, with their n.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { screenTools } from './screen-tools.js'

/** The sample look (doc 16, B2) as the log holds it. Made-up values. */
// Notes is private by name since 2026-11-17 (privateAppName): the sample look is read as a Pages window.
const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages'))
const ROW = lookForLog(LINE)
const NOTE = { app: 'Pages', note: 'set-value popup is refused here (not-found); press pop up button worked after it', n: 3, lastAt: '2026-11-15T09:00:00Z' }

/** The look tool over one fake app that answers every look with the sample row. */
function look(state) {
  const rows = {}
  const send = (command) => {
    if (command.type !== 'look') return
    rows[command.id] = { ...ROW, id: command.id }
    state.marks.lastLook = { id: command.id, app: 'Pages', n: 4 }
  }
  const readRow = async (id) => rows[id] ?? null
  return screenTools(async () => {}, () => state, send, readRow, async () => [])[4]
}
const stateWith = (more = {}) => ({ config: { experiments: {} }, marks: { now: [], guideTally: {} }, appNotes: { open: {}, owner: { tally: {}, notes: [NOTE] }, rig: { tally: {}, notes: [] } }, ...more })
const chat = (id) => ({ agent: { session: { id } } })

describe('app notes in the look (Set 5 R2)', () => {
  it("prints the owner's notes for the app with their n in an owner chat, and not in a rig chat", async () => {
    expect(await look(stateWith()).execute({ app: 'Pages' }, chat('chat-1'))).toContain(`What this app did to your own steps before (n = tasks it was seen in):\n- ${NOTE.note} (n 3)`)
    expect(await look(stateWith({ rigSessions: { 'chat-rig': '2026-11-15T08:00:00Z' } })).execute({ app: 'Pages' }, chat('chat-rig'))).not.toContain('What this app did')
  })
})
