// Round 3, the ladder: a plain act the owner said yes to k times in a row in one app stops asking there; a final always asks,
// a private app never earns. Every value is made up.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, decisionRecord, rungOf, UNKNOWN_SAY } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const press = (app, name, role = 'button') => ({ verb: 'press', app, thing: { role, name }, command: {} })
const state = (yes, app = 'TextEdit', earnAfter) => ({ config: { actions: { ...actions, ...(earnAfter ? { earnAfter } : {}) } }, autonomy: { levels: {}, granted: {}, lowered: {}, ladder: [{ tool: 'screen_act', app, yes, at: '2026-11-15T09:00:00.000Z' }] } })
/** As index.js decides: facts from the plans, the rung for the one app they are in. */
const decide = (plans, s, { preset = 'workspace-write', autonomy, ownerTurn = true, approvalOverride, acts = actions } = {}) => {
  const facts = callFacts({ toolName: 'screen_act', args: { steps: plans.map((p) => ({ app: p.app, label: p.thing.name })) }, plans })
  return decideAction({ toolName: 'screen_act', args: {}, preset, approvalOverride, actions: acts, resolveActionPolicy, autonomy, ownerTurn, earned: facts.app ? rungOf(s, 'screen_act', facts.app) : null, facts })
}

describe('callFacts app: the ladder key', () => {
  it('is the one app every planned step is in', () => {
    expect(callFacts({ toolName: 'screen_act', args: {}, plans: [press('TextEdit', 'Bold'), press('textedit', 'Italic')] }).app).toBe('TextEdit')
  })
  it('is null for two apps, no planned step, a keyboard entry alone, another tool, or a private app', () => {
    expect(callFacts({ toolName: 'screen_act', args: {}, plans: [press('TextEdit', 'Bold'), press('Finder', 'Open')] }).app).toBeNull()
    expect(callFacts({ toolName: 'screen_act', args: {}, plans: [] }).app).toBeNull()
    expect(callFacts({ toolName: 'screen_act', args: {}, plans: [{ verb: 'keyboard', app: 'TextEdit', thing: { role: 'text field', name: 'Body' } }] }).app).toBeNull()
    expect(callFacts({ toolName: 'web_act', args: {}, plans: [press('TextEdit', 'Bold')] }).app).toBeNull()
    expect(callFacts({ toolName: 'screen_act', args: {}, plans: [press('Messages', 'Info')] }).app).toBeNull()
  })
  it('a final\'s action:decided row holds no app; a plain act\'s holds it', () => {
    const row = (plans) => {
      const facts = callFacts({ toolName: 'screen_act', args: { steps: plans.map((p) => ({ app: p.app, label: p.thing.name })) }, plans })
      return decisionRecord({ name: 'screen_act', callId: 'call-1', args: {} }, { preset: 'workspace-write', facts }, { kind: 'ask', reason: 'Gnomon: asks.' })
    }
    const sent = row([press('Zen', 'Send')])
    expect(sent.inputs.facts).toMatchObject({ final: { kind: 'send' }, app: null })
    expect(JSON.stringify(sent)).not.toMatch(/Zen/)
    expect(row([press('Zen', 'Reload')]).inputs.facts).toMatchObject({ final: null, app: 'Zen' })
  })
})

describe('rungOf', () => {
  it('counts the yeses against k (config.actions.earnAfter, default 10)', () => {
    expect(rungOf(state(10), 'screen_act', 'textedit')).toEqual({ yes: 10, k: 10, app: 'textedit', earned: true })
    expect(rungOf(state(9), 'screen_act', 'TextEdit')).toMatchObject({ yes: 9, earned: false })
    expect(rungOf(state(10, 'TextEdit', 12), 'screen_act', 'TextEdit')).toMatchObject({ k: 12, earned: false })
    expect(rungOf(state(10), 'screen_act', 'Finder')).toMatchObject({ yes: 0, earned: false })
    expect(rungOf({}, 'screen_act', 'Finder')).toMatchObject({ yes: 0, k: 10 })
  })
  it('a private app has no rung at all', () => {
    expect(rungOf(state(50, 'Messages'), 'screen_act', 'Messages')).toBeNull()
  })
})

describe('decideAction under the ladder', () => {
  it('an earned plain act is allowed with its reason; one short of k still asks', () => {
    expect(decide([press('TextEdit', 'Bold')], state(10))).toEqual({ kind: 'allow', reason: 'earned: 10 yeses in a row in TextEdit', earned: true })
    expect(decide([press('TextEdit', 'Bold')], state(9))).toMatchObject({ kind: 'ask' })
  })
  it('a final in the same app still asks, earned or not', () => {
    expect(decide([press('TextEdit', "Don't Save")], state(50))).toMatchObject({ kind: 'ask' })
    expect(decide([press('TextEdit', 'Bold'), press('TextEdit', 'Delete')], state(50))).toMatchObject({ kind: 'ask' })
  })
  it('earned in one app is nothing in another', () => {
    expect(decide([press('Finder', 'Open')], state(50))).toMatchObject({ kind: 'ask' })
  })
  it('never loosens a deny, a notice turn, the owner\'s dial, or the owner\'s own "ask"', () => {
    expect(decide([press('TextEdit', 'Bold')], state(50), { preset: 'read-only' })).toMatchObject({ kind: 'deny' })
    expect(decide([press('TextEdit', 'Bold')], state(50), { ownerTurn: false })).toMatchObject({ kind: 'ask' })
    expect(decide([press('TextEdit', 'Bold')], state(50), { autonomy: 'notice' })).toMatchObject({ kind: 'ask' })
    expect(decide([press('TextEdit', 'Bold')], state(50), { approvalOverride: 'ask' })).toMatchObject({ kind: 'ask' })
    expect(decide([press('TextEdit', 'Bold')], state(50), { acts: { ...actions, outward: { default: 'auto', byTool: { screen_act: 'ask' } } } })).toMatchObject({ kind: 'ask' })
  })
  it('a private app never earns: the act is refused, whatever the ladder holds', () => {
    expect(decide([press('Messages', 'Info')], state(50, 'Messages'))).toMatchObject({ kind: 'deny' })
  })
})

describe('never earn on a button nobody knows (owner decision 2026-11-17)', () => {
  const facts = (plans) => callFacts({ toolName: 'screen_act', args: { steps: plans.map((p) => ({ app: p.app, label: p.thing.name })) }, plans })
  it('a press whose words are no final and no plain word holds no app: a yes on it never climbs the ladder', () => {
    expect(facts([press('TextEdit', 'Frobnicate')])).toMatchObject({ final: null, app: null, unknownButton: true })
    expect(facts([press('TextEdit', 'Bold'), press('TextEdit', 'Zap it')])).toMatchObject({ app: null, unknownButton: true })
    // A ref's name, or no words at all, is as unknown.
    expect(facts([press('TextEdit', 'e12')])).toMatchObject({ app: null, unknownButton: true })
    expect(facts([press('TextEdit', '')])).toMatchObject({ app: null, unknownButton: true })
    const row = decisionRecord({ name: 'screen_act', callId: 'call-1', args: {} }, { preset: 'workspace-write', facts: facts([press('TextEdit', 'Frobnicate')]) }, { kind: 'ask', reason: UNKNOWN_SAY })
    expect(row.inputs.facts.app).toBeNull()
  })
  it('known words in any language keep the app, and still earn', () => {
    for (const name of ['Bold', 'Vet', 'Fett', 'Annuleren', 'Export…']) expect(facts([press('TextEdit', name)]), name).toMatchObject({ app: 'TextEdit' })
    expect(facts([press('TextEdit', 'Bold')]).unknownButton).toBeUndefined()
    expect(decide([press('TextEdit', 'Vet')], state(10))).toMatchObject({ kind: 'allow', earned: true })
  })
  it('a row, a cell or a field is no button: its press is judged as before', () => {
    expect(facts([press('TextEdit', 'Frobnicate.txt', 'row')])).toMatchObject({ app: 'TextEdit' })
  })
  it('it always asks, in Auto and with the ladder full, with the line that says Gnomon does not know', () => {
    for (const opts of [{}, { preset: 'danger-full-access', autonomy: 'act' }, { preset: 'danger-full-access' }])
      expect(decide([press('TextEdit', 'Frobnicate')], state(50), opts), JSON.stringify(opts)).toEqual({ kind: 'ask', reason: UNKNOWN_SAY })
    expect(UNKNOWN_SAY).toMatch(/I do not know what this button does/)
  })
  it('without a plan it reads the steps: an unknown label asks, a known one does not mark it', () => {
    const args = (label) => ({ steps: [{ app: 'TextEdit', role: 'button', label }] })
    expect(callFacts({ toolName: 'screen_act', args: args('Frobnicate') }).unknownButton).toBe(true)
    expect(callFacts({ toolName: 'screen_act', args: args('OK') }).unknownButton).toBeUndefined()
    // Typing, a key and an open are no presses.
    expect(callFacts({ toolName: 'screen_act', args: { steps: [{ app: 'TextEdit', action: 'type', value: 'Frobnicate' }, { app: 'TextEdit', action: 'key', value: 'cmd+b' }, { app: 'Zen', url: 'https://example.test' }] } }).unknownButton).toBeUndefined()
  })
  it('a final keeps its own ask, and a refusal stays a refusal', () => {
    expect(decide([press('TextEdit', 'Frobnicate'), press('TextEdit', 'Verwijderen')], state(50)).reason).toMatch(/^Gnomon: this deletes/)
    expect(decide([press('Messages', 'Frobnicate')], state(50, 'Messages'))).toMatchObject({ kind: 'deny' })
    expect(decide([press('TextEdit', 'Frobnicate')], state(50), { preset: 'read-only' })).toMatchObject({ kind: 'deny' })
  })
})
