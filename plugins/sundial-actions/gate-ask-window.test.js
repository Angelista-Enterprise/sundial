// S5R2: the ask names the window of its ref. Run 226's Send ask named "Rig fixture: Order form", another window of the same
// browser that the app's last look had read, while the Send it pressed was in the mail window. Made-up values only.
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { finalAsk, finalOf, judgedPlans } from './gate.js'
import { lookOf } from './screen-look.js'
import { actPlan } from './screen-tools.js'

const SEND = { ref: 'e5', role: 'AXButton', sub: '', label: 'Send', value: '', frame: [600, 400, 60, 24], actions: ['AXPress'], settable: false, enabled: true }
const BOX = { ref: 'e6', role: 'AXTextArea', sub: '', label: 'Message #general', value: '', frame: [100, 400, 480, 24], actions: [], settable: true, enabled: true }
const MAIL = lookForLog({ id: 'look-0000a1b2', at: '2026-11-16T09:00:00.000Z', app: 'Zen', bundleId: 'app.zen-browser.zen', window: 'Testbox', frame: [0, 25, 1440, 875], focused: null, menus: ['File'], source: 'ax', truncated: false, elements: [SEND] })
const CHAT = lookForLog({ id: 'look-0000c3d4', at: '2026-11-16T09:00:00.000Z', app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap', window: 'general', frame: [0, 25, 1440, 875], focused: 'e6', menus: ['File'], source: 'ax', truncated: false, elements: [BOX, SEND] })
const readLook = async (id, { field = 'id' } = {}) => [MAIL, CHAT].find((r) => (field === 'tag' ? String(r.id).endsWith(id) : r[field] === id)) ?? null

describe('the ask names the window of its ref', () => {
  it('a ref press of Send names the window of the look that holds the ref, not the window the app\'s last look read', async () => {
    const state = { config: { experiments: {} }, marks: { lastLook: { id: MAIL.id, app: 'Zen', n: 1 } } }
    const args = { ref: 'e5@a1b2', action: 'press' }
    const plan = await actPlan(args, state, readLook)
    expect(plan).toMatchObject({ verb: 'press', app: 'Zen', inWindow: 'Testbox' })
    const final = { ...finalOf('screen_act', args, () => null, [plan]), window: 'Rig fixture: Order form' }
    expect(final).toMatchObject({ kind: 'send', app: 'Zen', refWindow: 'Testbox' })
    const ask = finalAsk(final, { line: plan.line, window: final.window })
    expect(ask).toMatch(/^Gnomon: this sends a mail or a message with "Send" in Zen \(window "Testbox"\)/)
    expect(ask).not.toMatch(/Order form/)
  })

  it('a Return in a chat box names the window of the look that has the keyboard', () => {
    const plans = judgedPlans([{ verb: 'key', app: 'Slack', thing: {}, command: { value: 'return' } }], lookOf(CHAT))
    const final = finalOf('screen_act', { app: 'Slack', action: 'key', value: 'return' }, () => null, plans)
    expect(final).toMatchObject({ kind: 'send', refWindow: 'general' })
    expect(finalAsk({ ...final, window: 'another' }, { window: 'another' })).toMatch(/in Slack \(window "general"\)/)
  })

  it('a step by name with no look behind it keeps the window the app\'s last look read', async () => {
    const plan = await actPlan({ app: 'Zen', role: 'button', label: 'Send', action: 'press' }, { config: { experiments: {} }, marks: {} }, readLook)
    expect(plan.inWindow).toBeUndefined()
    const final = { ...finalOf('screen_act', { app: 'Zen', role: 'button', label: 'Send' }, () => null, [plan]), window: 'Testbox' }
    expect(finalAsk(final, { window: final.window })).toMatch(/in Zen \(window "Testbox"\)/)
  })
})
