// Bench mode (lab/bench/agentdojo): a tool plugins/sundial-bench declares is judged by this gate, its final asks in every
// preset with the one ask format the bench answerer reads, and nothing can be declared off the bench install. Made-up values.
import { afterEach, describe, expect, it } from 'vitest'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { callFacts, decideAction, finalAsk, finalOf } from './gate.js'
import { DECLARED_TOOLS } from './gate-tools.js'
import { declareBenchTool } from './index.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, args, preset) => decideAction({ toolName, args, preset, actions, resolveActionPolicy, facts: callFacts({ toolName, args }) })
const onBench = () => null
const SEND = { recipients: ['mira.bakker@example.com'], subject: 'Lunch', body: 'See you at noon.' }

afterEach(() => DECLARED_TOOLS.clear())

describe('declareBenchTool', () => {
  it("refuses off the bench install: this test process is not the bench, and the owner's gate is left as it was", () => {
    expect(() => declareBenchTool('agentdojo_send_email', 'send')).toThrow(/only on the bench install/)
    expect(() => declareBenchTool('agentdojo_send_email', 'send', () => "this install's home is the owner's ~/.sundial")).toThrow(/owner's/)
    expect(DECLARED_TOOLS.size).toBe(0)
    expect(finalOf('agentdojo_send_email', SEND)).toBeNull()
    expect(decide('agentdojo_send_email', SEND, 'danger-full-access').kind).toBe('allow')
  })

  it("never redeclares one of Gnomon's own tools or a name twice", () => {
    expect(() => declareBenchTool('gnomon_run_shell', null, onBench)).toThrow(/already/)
    declareBenchTool('agentdojo_get_iban', null, onBench)
    expect(() => declareBenchTool('agentdojo_get_iban', 'transfer', onBench)).toThrow(/already/)
  })

  it('a declared final asks in every preset; a declared read asks nothing; the removal undoes it', () => {
    const undo = declareBenchTool('agentdojo_send_money', 'transfer', onBench)
    declareBenchTool('agentdojo_get_balance', null, onBench)
    const money = { recipient: 'GB29NWBK60161331926819', amount: 120, subject: 'Rent', date: '2026-11-01' }
    for (const preset of [undefined, 'workspace-write', 'danger-full-access', 'custom']) expect(decide('agentdojo_send_money', money, preset).kind).toBe('ask')
    expect(decide('agentdojo_get_balance', {}, 'workspace-write').kind).toBe('allow')
    expect(callFacts({ toolName: 'agentdojo_send_money', args: money }).final).toMatchObject({ kind: 'transfer', via: 'tool' })
    undo()
    expect(decide('agentdojo_send_money', money, 'danger-full-access').kind).toBe('allow')
  })

  it("a send's ask names its recipients and arguments, tagged as the answerer reads it", () => {
    declareBenchTool('agentdojo_send_email', 'send', onBench)
    const ask = finalAsk(finalOf('agentdojo_send_email', SEND))
    expect(ask).toMatch(/^Gnomon: this sends a mail or a message with "recipients: \[\\"mira\.bakker@example\.com\\"\]; subject: Lunch; body: See you at noon\.", which cannot be taken back, so it asks you first\./)
    expect(ask).toContain(' · To: mira.bakker@example.com · ')
    expect(ask.endsWith(' · final: send')).toBe(true)
  })
})
