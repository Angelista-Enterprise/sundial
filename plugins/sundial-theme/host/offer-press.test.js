// Round 4: the press on a notice's offer. The call is the one the gate kept, run through dsh's tool
// pipeline: here a stand-in pipeline that asks the real action gate first (as `tools/pre-execute` does),
// sends an ask to an approver that says no, and runs the tool only on an allow. Every value is made up.
import { describe, expect, it, vi } from 'vitest'
import { offerGist, offerOnGo, offerPress } from './api-writes.js'
import { callFacts, decideAction } from '../../sundial-actions/gate.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }

function rig(offers) {
  const asked = []
  const ran = []
  const appended = []
  const agent = { status: 'idle', session: { append: vi.fn((type, message) => appended.push(message)) }, inject: vi.fn() }
  const ctx = {
    gnomonKernel: { getState: () => ({ notices: { offers } }), appendSignal: vi.fn(async () => {}) },
    tools: {
      // As dsh: the gate first, an ask through the approver, the tool only when allowed.
      execute: vi.fn(async ({ name, arguments: args, agent: who }) => {
        const decision = decideAction({ toolName: name, args, preset: 'danger-full-access', actions, resolveActionPolicy, facts: callFacts({ toolName: name, args }) })
        if (decision.kind === 'ask') asked.push({ name, reason: decision.reason, agent: who })
        if (decision.kind !== 'allow') return { isError: true, error: { message: decision.kind === 'ask' ? `the user rejected tool "${name}"` : decision.reason } }
        ran.push({ name, args })
        return { isError: false, value: { lines: ['Planning with Mira Bakker, 14:10.', 'BOX-484 is still open.'] } }
      }),
    },
  }
  const agentFor = vi.fn(async () => agent)
  return { ctx, agentFor, agent, asked, ran, appended }
}

const prep = { tool: 'gnomon_brief', args: { kind: 'meeting', title: 'Planning' }, label: 'Open the prep', kind: 'meeting-prep', at: '2026-03-10T14:00:00.000Z' }

describe('pressing a notice offer', () => {
  it('runs the stored call through the gate as the conversation, logs the go, and puts what it found in the conversation', async () => {
    const r = rig({ 'prep:planning': prep })
    // A page that names another tool is not heard: the press runs what the gate kept for that notice.
    expect(await offerPress(r.ctx, r.agentFor, { noticeKey: 'prep:planning', tool: 'bash', args: { command: 'echo hi' } })).toEqual({ ran: true, said: 'Planning with Mira Bakker, 14:10. BOX-484 is still open.' })
    expect(r.ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('notice:offer-taken', { noticeKey: 'prep:planning', kind: 'meeting-prep', tool: 'gnomon_brief' })
    expect(r.agentFor).toHaveBeenCalledWith('gnomon-companion')
    expect(r.ctx.tools.execute.mock.calls[0][0]).toMatchObject({ name: 'gnomon_brief', arguments: prep.args, agent: r.agent })
    expect(r.ran).toEqual([{ name: 'gnomon_brief', args: prep.args }])
    expect(r.appended[0].content[0].text).toBe('Follow-up: Open the prep: Planning with Mira Bakker, 14:10. BOX-484 is still open.')
  })

  it('a final still asks: the approver is asked, says no, nothing runs and nothing is said', async () => {
    const r = rig({ k: { tool: 'screen_act', args: { app: 'Zen', role: 'button', label: 'Send' }, label: 'Send it', kind: 'agent-waiting', at: prep.at } })
    const out = await offerPress(r.ctx, r.agentFor, { noticeKey: 'k' })
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0].reason).toMatch(/cannot be taken back, so it asks you first/)
    expect(out).toEqual({ ran: false, reason: 'the user rejected tool "screen_act"' })
    expect(r.ran).toEqual([])
    expect(r.appended).toEqual([])
  })

  it('a private app is refused without an ask', async () => {
    const r = rig({ k: { tool: 'screen_act', args: { app: 'Signal', action: 'raise' }, label: 'Open it', kind: 'agent-waiting', at: prep.at } })
    const out = await offerPress(r.ctx, r.agentFor, { noticeKey: 'k' })
    expect(out.ran).toBe(false)
    expect(out.reason).toMatch(/private app/)
    expect(r.asked).toEqual([])
    expect(r.ran).toEqual([])
  })

  it('an offer that is gone (taken, too old, never made) answers 404 and runs nothing', async () => {
    const r = rig({})
    expect(await offerPress(r.ctx, r.agentFor, { noticeKey: 'prep:planning' })).toEqual([404, { unavailable: 'That offer is gone: taken already, or too old.' }])
    expect(r.ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
    expect(r.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('a key every plain object has (__proto__, constructor) is no offer: 404, nothing appended, nothing run', async () => {
    const r = rig({ 'prep:planning': prep })
    for (const noticeKey of ['__proto__', 'constructor', 'toString']) expect((await offerPress(r.ctx, r.agentFor, { noticeKey }))[0]).toBe(404)
    expect(r.ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
    expect(r.ctx.tools.execute).not.toHaveBeenCalled()
  })

  it('the knock\'s spoken go (Notify offer-take) runs the same press: logged via knock, the stored call through the gate', async () => {
    const r = rig({ 'prep:planning': prep })
    const onGo = offerOnGo(r.ctx, r.agentFor)
    expect(onGo({ channel: 'phasic-notice', payload: { noticeKey: 'prep:planning' } })).toBeNull()
    expect(await onGo({ channel: 'offer-take', payload: { noticeKey: 'prep:planning', via: 'knock' } })).toMatchObject({ ran: true })
    expect(r.ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('notice:offer-taken', { noticeKey: 'prep:planning', kind: 'meeting-prep', tool: 'gnomon_brief', via: 'knock' })
    expect(r.ran).toEqual([{ name: 'gnomon_brief', args: prep.args }])
  })

  it('a final from the knock still asks the owner, and nothing runs on a no', async () => {
    const r = rig({ k: { tool: 'screen_act', args: { app: 'Zen', role: 'button', label: 'Send' }, label: 'Send it', kind: 'agent-waiting', at: prep.at } })
    expect(await offerOnGo(r.ctx, r.agentFor)({ channel: 'offer-take', payload: { noticeKey: 'k' } })).toEqual({ ran: false, reason: 'the user rejected tool "screen_act"' })
    expect(r.asked).toHaveLength(1)
    expect(r.asked[0].agent).toBe(r.agent)
    expect(r.ran).toEqual([])
  })

  it('the slip says so (via slip); any other via is not recorded', async () => {
    const r = rig({ 'prep:planning': prep, k2: prep })
    await offerPress(r.ctx, r.agentFor, { noticeKey: 'prep:planning', via: 'slip' })
    await offerPress(r.ctx, r.agentFor, { noticeKey: 'k2', via: 'anything' })
    expect(r.ctx.gnomonKernel.appendSignal.mock.calls.map((c) => c[1].via)).toEqual(['slip', undefined])
  })

  it('what came back rides the answer for the surface that pressed, one line cut at a word, never past 160', async () => {
    const r = rig({ 'prep:planning': prep })
    r.ctx.tools.execute = vi.fn(async () => ({ isError: false, value: { lines: ['BOX-484 is still open, and the puzzlebox-studio build went red at 09:40 on the same branch.', 'Mira Bakker asked for the result before noon; the last run failed in the export step after 38 s.'] } }))
    const { said } = await offerPress(r.ctx, r.agentFor, { noticeKey: 'prep:planning', via: 'slip' })
    expect(said.length).toBeLessThanOrEqual(160)
    expect(said).toMatch(/^BOX-484 is still open, .* the last run failed…$/)
  })

  it('a tool answer with no lines of its own (raw JSON) gives the surface no result line: it is in the conversation', async () => {
    const r = rig({ 'prep:planning': prep })
    r.ctx.tools.execute = async () => ({ isError: false, value: { rows: [{ id: 'r1' }], next: null } })
    expect(await offerPress(r.ctx, r.agentFor, { noticeKey: 'prep:planning', via: 'slip' })).toEqual({ ran: true })
    expect(r.appended[0].content[0].text).toMatch(/^Follow-up: Open the prep: \{"rows"/)
  })

  it('the gist: a brief by its lines, shell rows by command and exit, anything else cut', () => {
    expect(offerGist({ signals: [{ type: 'shell:command', data: { command: 'pnpm test', exitCode: 1 } }] })).toBe('pnpm test (exit 1)')
    expect(offerGist({ signals: [] })).toBe('Nothing on the record.')
    expect(offerGist({ none: 'No meeting with others is on the calendar ahead.' })).toBe('No meeting with others is on the calendar ahead.')
    expect(offerGist({ x: 'y'.repeat(900) })).toHaveLength(600)
  })
})
