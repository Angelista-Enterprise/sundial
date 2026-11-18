import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { screenTools } from './screen-tools.js'

/** The sample look as the log holds it. Made-up values. */
const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))

/** screen_look over a fake record: the app answers each look with the sample row as `app`, and `active` is the window sensor's front window. */
function toolsWith(app, active, after = {}) {
  const rows = {}
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {} }, window: { active } }
  const send = (c) => {
    const id = c.type === 'look' ? c.id : `after-${c.id}`
    if (c.type !== 'look') state.marks.lastAct = { id: c.id, outcome: 'performed' }
    rows[id] = { ...lookForLog(LINE), id, processName: app, ...(c.type === 'look' ? {} : { after: c.id, ...after }) }
    state.marks.lastLook = { id, app, n: 4, ...(c.type === 'look' ? {} : { after: c.id }) }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((r) => r[field] === id) ?? null
  const [, , act, , look] = screenTools(async () => {}, () => state, send, readRow, async () => [], {})
  return { act, look }
}
const lookWith = (app, active) => toolsWith(app, active).look.execute({ app })
const front = (processName, documentPath, windowTitle = 'Lunch Thursday') => ({ processName, windowTitle, windowId: '1', documentPath })

describe('the look names the document (run 103 T06)', () => {
  it('a look of the app in front names the file its window has open, never for another app, a redacted path or a private app', async () => {
    expect((await lookWith('Pages', front('Pages', '~/Documents/lunch.txt'))).split('\n')[2]).toBe('document: ~/Documents/lunch.txt')
    expect(await lookWith('Pages', front('TextEdit', '~/Documents/lunch.txt'))).not.toContain('document:')
    expect(await lookWith('Pages', front('Pages', '[private]'))).not.toContain('document:')
    expect(await lookWith('Pages', front('Pages', null))).not.toContain('document:')
    expect(await lookWith('Pages', front('Pages', '~/Documents/lunch.txt', 'Another window'))).not.toContain('document:')
    await expect(lookWith('Messages', front('Messages', '~/a.txt'))).rejects.toThrow(/^refused: private app/)
  })

  it('the look after an act names it too, when the window changed and when the refs still hold', async () => {
    const changed = toolsWith('Pages', front('Pages', '~/Documents/lunch.txt', 'New Note'), { windowTitle: 'New Note' })
    expect(await changed.act.execute({ app: 'Pages', role: 'button', label: 'New Note' })).toContain('\ndocument: ~/Documents/lunch.txt\n')
    // The sensor still on the old window: its path is not this window's.
    const stale = toolsWith('Pages', front('Pages', '~/Documents/lunch.txt'), { windowTitle: 'New Note' })
    expect(await stale.act.execute({ app: 'Pages', role: 'button', label: 'New Note' })).not.toContain('document:')
    const held = toolsWith('Pages', front('Pages', '~/Documents/lunch.txt'))
    await held.look.execute({ app: 'Pages' })
    expect(await held.act.execute({ app: 'Pages', role: 'button', label: 'New Note' })).toMatch(/\ndocument: ~\/Documents\/lunch\.txt\n.*still hold/)
    const other = toolsWith('Pages', front('TextEdit', '~/Documents/lunch.txt'), { windowTitle: 'New Note' })
    expect(await other.act.execute({ app: 'Pages', role: 'button', label: 'New Note' })).not.toContain('document:')
  })
})
