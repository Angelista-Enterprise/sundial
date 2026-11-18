// Set 2 R2 item 2: a step with more after it whose change the fold already holds (a `window:changed` of its app) does not wait
// for its after-look; the last step always looks, a Send keeps its proof looks, a step with no such event still looks. Made-up values only.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { screenTools } from './screen-tools.js'

const { type: _type, at: _at, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)
const SENT = { ref: 'e20', role: 'AXStaticText', label: 'Message sent', value: '', frame: [600, 300, 120, 20], actions: [], settable: false, enabled: true, in: 'Notes' }

/** A fake Notes in front: every act performs and is followed by the app's after-look; `titled(command, n)` gives the window title the
 * window sensor reports after the n-th act (null: no `window:changed`). `rows` are the `screen:step` rows kept. */
function tools(titled = () => null, refuse = () => false, front = 'Notes', reason) {
  const rows = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: front, windowTitle: 'Lunch Thursday', windowId: 'w1' } }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Notes', window: 'Lunch Thursday', n: 4 } } }
  let n = 0
  const send = (command) => {
    if (command.type === 'look') {
      looks[command.id] = { ...ROW, id: command.id, elements: [...ROW.elements, SENT] }
      state.marks.lastLook = { id: command.id, app: 'Notes', n: 5 }
      return
    }
    if (refuse(n)) return void (n++, (state.marks.lastAct = { id: command.id, outcome: 'refused', reason: 'covered' }))
    const title = titled(command, n++)
    if (title) state.window = { active: { processName: 'Notes', windowTitle: title, windowId: 'w1' } }
    state.marks.lastAct = { id: command.id, outcome: 'performed', ...(reason ? { reason } : {}) }
    const id = `look-after-${command.id}`
    looks[id] = { ...ROW, id, after: command.id, windowTitle: 'From the look', elements: [...ROW.elements, SENT] }
    state.marks.lastLook = { id, after: command.id, app: 'Notes', n: 5 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const append = async (type, data) => { if (type === 'screen:step') rows.push(data) }
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [])
  return { act, rows }
}
const PRESS = { app: 'Notes', role: 'button', label: 'New Note', action: 'press' }
const chain = (...steps) => ({ app: 'Notes', goal: 'start a note', steps })

describe('an after-look only when the fold has not already said the window changed', () => {
  it('a step whose window:changed arrived skips its look: the row says looked false, the window from the event, the answer says so', async () => {
    const t = tools((_c, n) => (n === 0 ? 'New Note' : null))
    await t.act.execute(chain(PRESS, { action: 'key', value: 'cmd+c' }))
    expect(t.rows[0]).toMatchObject({ ok: true, changed: true, looked: false, then: { windowTitle: 'New Note' } })
    expect(t.rows[1].looked).toBeUndefined()
    // The skipped step's answer is the event's window, never a made-up screen: it shows when the next step is refused.
    const stopped = tools((_c, n) => (n === 0 ? 'New Note' : null), (n) => n === 1)
    await expect(stopped.act.execute(chain(PRESS, { ...PRESS, label: 'Search' }))).resolves.toMatch(/Window now: "New Note" \(from the window event: no look was taken after this step\)/)
  })

  it('a step with no such event still looks; a raise of an app not in front, with no look of it, is no change', async () => {
    const none = tools()
    await none.act.execute(chain(PRESS, { action: 'key', value: 'cmd+c' }))
    expect(none.rows.map((r) => r.looked)).toEqual([undefined, undefined])
    expect(none.rows[0].then).toEqual({ windowTitle: 'From the look' })
    // Sundial's slip in front: Notes coming forward with the title its last look had is the raise, not the step's change.
    const raised = tools(() => 'Lunch Thursday', undefined, 'Sundial')
    await raised.act.execute(chain(PRESS, { action: 'key', value: 'cmd+c' }))
    expect(raised.rows[0].looked).toBeUndefined()
    const retitled = tools((_c, n) => (n === 0 ? 'New Note' : null), undefined, 'Sundial')
    await retitled.act.execute(chain(PRESS, { action: 'key', value: 'cmd+c' }))
    expect(retitled.rows[0].looked).toBe(false)
  })

  it('the last step always looks, alone or at the end of a chain, even when its event arrived', async () => {
    const one = tools(() => 'New Note')
    expect(await one.act.execute({ target: { app: 'Notes', role: 'button', label: 'New Note' }, action: 'press' })).not.toMatch(/Window now/)
    expect(one.rows[0].looked).toBeUndefined()
    const two = tools((_c, n) => `Title ${n}`)
    await two.act.execute(chain(PRESS, { ...PRESS, label: 'Search' }))
    expect(two.rows.map((r) => r.looked)).toEqual([false, undefined])
  })

  it('a typing step looks (a new title there may be a rename), and a Send keeps its look and its proof', async () => {
    const typed = tools(() => 'Call Mira')
    await typed.act.execute(chain({ action: 'type', value: 'Call Mira' }, { action: 'key', value: 'return' }))
    expect(typed.rows[0].looked).toBeUndefined()
    const sent = tools(() => 'Sent')
    await sent.act.execute(chain({ app: 'Notes', role: 'button', label: 'Send', action: 'press' }, { action: 'key', value: 'cmd+c' }))
    expect(sent.rows[0]).toMatchObject({ proof: 'confirmed' })
    expect(sent.rows[0].looked).toBeUndefined()
  })

  it('doc 32 item 2 (run 261 T19): a press Sundial.app found done after an unknown AX answer ("unconfirmed") is done, and says so', async () => {
    const press = { target: { app: 'Notes', role: 'button', label: 'Save' }, action: 'press' }
    const unsure = await tools(undefined, undefined, 'Notes', 'unconfirmed').act.execute(press)
    expect(unsure).toMatch(/^Done[^\n]* The app answered the press with an error, but what was pressed is gone or its window changed[^\n]*do not press it again/)
    expect(unsure).not.toMatch(/slow to answer/)
    expect(await tools().act.execute(press)).not.toMatch(/answered the press with an error/)
  })
})
