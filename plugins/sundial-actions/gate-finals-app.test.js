// S5R2: a final step with no app named takes the app screen_act fills in for it when every planned step goes to that one app
// (4 gate denies in runs 211-221); two apps, or no plan, and it is still refused. Made-up values only.
import { describe, expect, it } from 'vitest'
import { callFacts, decideAction, finalOf } from './gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
// `fill`: the app screen_act fills a step with no app in for (index.js filledApp), which the plans were made in.
const decide = (args, plans) => decideAction({ toolName: 'screen_act', args, preset: 'danger-full-access', actions, resolveActionPolicy, testMode: true, facts: callFacts({ toolName: 'screen_act', args, plans, fill: () => plans[0]?.app }) })
const press = (app, name) => ({ verb: 'press', app, thing: { role: 'button', name }, command: { target: { app, label: name }, action: 'press' } })
const type = (app, name) => ({ verb: 'type', app, thing: { role: 'text field', name }, command: { target: { app, label: name }, action: 'type', value: 'x' } })

describe('a final step with no app named', () => {
  const steps = [{ action: 'type', role: 'text field', label: 'Subject', value: 'Hello run 9' }, { action: 'press', role: 'button', label: 'Send' }]

  it('is judged in the one app every planned step goes to, and asks there', () => {
    const plans = [type('Zen', 'Subject'), press('Zen', 'Send')]
    expect(finalOf('screen_act', { steps }, () => null, plans)).toMatchObject({ kind: 'send', app: 'Zen' })
    expect(finalOf('screen_act', { steps }, () => null, plans).unnamed).toBeUndefined()
    expect(decide({ steps }, plans).kind).toBe('ask')
    // A submit on a form, the run 221 shape: a click and a press with no app anywhere.
    const form = [{ action: 'click', role: 'check box', label: 'Ready' }, { action: 'press', role: 'button', label: 'Submit' }]
    expect(decide({ steps: form }, [{ verb: 'click', app: 'Zen', thing: { role: 'check box', name: 'Ready' }, command: {} }, press('Zen', 'Submit')]).kind).toBe('ask')
  })

  it('is still refused with no plan, or when the steps go to two apps', () => {
    expect(finalOf('screen_act', { steps }, () => null, [])).toMatchObject({ unnamed: true })
    expect(decide({ steps }, []).reason).toMatch(/a Send with no app named/)
    const two = [type('TextEdit', 'Subject'), press('Zen', 'Send')]
    expect(finalOf('screen_act', { steps }, () => null, two)).toMatchObject({ unnamed: true })
    expect(decide({ steps }, two).kind).toBe('deny')
  })
})
