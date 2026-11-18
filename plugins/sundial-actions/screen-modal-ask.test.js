// S5R2: a step the leftover-sheet check would refuse (step(), leftModal) is refused before the ask, so the owner's yes is not
// spent on a call that cannot run. The gate (index.js `asked`) denies on the plan's error instead of asking. Made-up values only.
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { finalOf } from './gate.js'
import { screenAsk } from './screen-tools.js'

const SEND = { ref: 'e5', role: 'AXButton', sub: '', label: 'Send', value: '', frame: [600, 400, 60, 24], actions: ['AXPress'], settable: false, enabled: true }
const ROW = lookForLog({ id: 'look-0000e5f6', at: '2026-11-16T09:00:00.000Z', app: 'Mail', bundleId: 'com.example.mail', window: 'Lunch Thursday', frame: [0, 25, 1440, 875], focused: null, menus: ['File'], source: 'ax', truncated: false, elements: [SEND] })
const readLook = async (id, { field = 'id' } = {}) => (field === 'tag' ? String(ROW.id).endsWith(id) : ROW[field] === id) ? ROW : null

/** The gate's choice for a final, as index.js `asked` makes it: the plan's error is a deny, else the ask. */
const gate = (plan) => (plan.error ? { kind: 'deny', reason: plan.error } : { kind: 'ask', reason: plan.line })

function stateWith(sheet) {
  const fronts = sheet ? { Mail: { dialog: true, look: 'look-0000a0a0', at: new Date().toISOString(), window: 'Lunch Thursday' } } : {}
  return { config: { experiments: {} }, opened: { chats: {}, fronts }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Mail', n: 1 } } }
}

describe('a final in an app with a sheet this chat did not open', () => {
  const args = { app: 'Mail', role: 'button', label: 'Send', action: 'press' }

  it('raises no ask: the call is refused with the sheet line', async () => {
    const plan = await screenAsk('screen_act', args, stateWith(true), readLook, null, [], 'chat-1')
    expect(finalOf('screen_act', args, undefined, [plan])).toMatchObject({ kind: 'send', app: 'Mail' })
    expect(gate(plan)).toEqual({ kind: 'deny', reason: expect.stringMatching(/^refused: Mail has a sheet or dialog in front of "Lunch Thursday", and this task did not open it/) })
  })

  it('asks as before without the sheet', async () => {
    const plan = await screenAsk('screen_act', args, stateWith(false), readLook, null, [], 'chat-1')
    expect(gate(plan)).toMatchObject({ kind: 'ask' })
  })

  it('in a chain, refuses at the first step in that app; a step in the same app before it may show the sheet, so step() decides', async () => {
    const steps = [{ app: 'Mail', action: 'key', value: 'cmd+v' }, { app: 'Mail', role: 'button', label: 'Send', action: 'press' }]
    expect(gate(await screenAsk('screen_act', { steps }, stateWith(true), readLook, null, [], 'chat-1'))).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^refused: Mail has a sheet/) })
    const opened = [{ app: 'Mail' }, { app: 'Mail', role: 'button', label: 'Send', action: 'press' }]
    expect(gate(await screenAsk('screen_act', { steps: opened }, stateWith(true), readLook, null, [], 'chat-1'))).toMatchObject({ kind: 'ask' })
  })
})
