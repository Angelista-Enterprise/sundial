// Round 2's restart test (B3): an open ask and an unconfirmed Send are rows in the log, so the state a
// restart builds (the last snapshot, then the log's tail folded through the whole manifest) still holds
// both: the ask is listed, and a second Send is refused. Made-up values only.
import { describe, expect, it } from 'vitest'
import { createInitialState, hydrateSnapshot } from '../../packages/kernel/src/initial-state.ts'
import { reduce } from '../../packages/kernel/src/reduce.ts'
import { openApprovals } from '../../packages/kernel/src/read/doing.ts'
import { RULE_MANIFEST } from '../../packages/rules/src/manifest.ts'
import { screenTools } from './screen-tools.js'

const fold = (state, events) => events.reduce((s, e) => reduce(s, e, RULE_MANIFEST).state, state)
/** The live config's screen switches (on unless the owner turns them off), overlaid on every boot as the runtime does. */
const live = (state) => ({ ...state, config: { ...state.config, experiments: { ...state.config.experiments, screenMarks: true, screenAct: true } } })
/** Boot as the runtime does it: the snapshot as it was written (JSON), hydrated, the live config overlaid, the tail folded. */
const boot = (snapshot, tail) => fold(live(hydrateSnapshot('device-1', JSON.parse(JSON.stringify(snapshot)))), tail)

function log() {
  const t = Date.now() - 20_000
  const ev = (n, type, payload) => ({ id: `e${n}`, type, ts: new Date(t + n * 1000).toISOString(), payload, sanitized: true })
  return [
    ev(1, 'clock:tick', {}),
    ev(2, 'action:decided', { tool: 'screen_act', callId: 'call-3', verdict: 'ask', reason: 'x', inputs: { facts: { final: { kind: 'send', via: 'screen', blind: false } } } }),
    ev(3, 'approval:asked', { approvalId: 'approval-1', sessionId: 'session-7f', tool: 'screen_act', callId: 'call-3', text: 'Press "Send" in Mail', kind: 'send' }),
    ev(4, 'approval:answered', { approvalId: 'approval-1', sessionId: 'session-7f', tool: 'screen_act', answer: 'allowed-once', by: 'owner' }),
    ev(5, 'screen:acted', { id: 'act-1', outcome: 'performed' }),
    ev(6, 'screen:step', { id: 'act-1', session: 'session-7f', processName: 'Mail', verb: 'press', screenText: ['Send'], ok: true, proof: 'unconfirmed' }),
    ev(7, 'approval:asked', { approvalId: 'approval-2', sessionId: 'session-7f', tool: 'screen_act', text: 'Press "Send" in Mail' }),
  ]
}

describe('the restart test (Round 2): what Gnomon is waiting on, and an unconfirmed Send, outlive the process', () => {
  const start = live(createInitialState('device-1'))
  const events = log()
  const cold = fold(start, events)

  it.each([
    ['a snapshot taken before the run, the whole run in the tail', 1],
    ['a snapshot taken mid-run, after the first ask', 3],
    ['a snapshot taken after every row', 7],
  ])('%s: the same open ask and the same unsent Send as a cold fold', (_name, cut) => {
    const restarted = boot(fold(start, events.slice(0, cut)), events.slice(cut))
    expect(restarted.approvals).toEqual(cold.approvals)
    expect(restarted.marks.unsent).toEqual(cold.marks.unsent)
    expect(openApprovals(restarted, Date.now(), 'session-7f')).toMatchObject([{ id: 'approval-2', line: 'Press "Send" in Mail' }])
    expect(restarted.approvals.recent).toMatchObject([{ id: 'approval-1', kind: 'send', answer: 'allowed-once' }])
    expect(restarted.marks.lastAct).toMatchObject({ id: 'act-1', proof: 'unconfirmed' })
  })

  it('a second Send after the restart is refused, from the folded state alone', async () => {
    const state = boot(fold(start, events.slice(0, 3)), events.slice(3))
    const sent = []
    const [, , act] = screenTools(async () => {}, () => state, (c) => sent.push(c), async () => null)
    await expect(act.execute({ app: 'Mail', label: 'Send' })).rejects.toThrow(/^refused: Send was pressed in Mail \d+ s ago and is not confirmed/)
    expect(sent).toEqual([])
  })
})

describe('a Send whose row the log refused (Fable\'s review of round 2)', () => {
  /** Mail answers every act performed; its after-look is private, so the Send is never confirmed. */
  const mail = (append) => {
    const state = live(createInitialState('device-1'))
    state.marks = { ...state.marks }
    const send = (c) => {
      if (c.type !== 'act') return
      state.marks.lastAct = { id: c.id, outcome: 'performed' }
      state.marks.lastLook = { id: `look-${c.id}`, after: c.id, app: 'Mail', n: 0, refused: 'private app' }
    }
    return screenTools(append, () => state, send, async () => null)[2]
  }

  it('is tried twice; refused both times, a second Send in that app is still refused', async () => {
    const tries = []
    const act = mail(async (type) => {
      if (type === 'screen:step') throw new Error(`disk full ${tries.push(type)}`)
    })
    expect(await act.execute({ app: 'Mail', label: 'Send' })).toMatch(/Send check: not confirmed/)
    expect(tries).toHaveLength(2)
    await expect(act.execute({ app: 'Mail', label: 'Send' })).rejects.toThrow(/^refused: Send was pressed in Mail \d+ s ago and is not confirmed/)
  })

  it('kept on the second try, nothing more is held; a plain step is tried once', async () => {
    const rows = []
    const act = mail(async (type, payload) => {
      if (type === 'screen:step') rows.push(payload)
      if (rows.length === 1) throw new Error('busy')
    })
    await act.execute({ app: 'Mail', label: 'Send' })
    expect(rows.map((r) => r.proof)).toEqual(['unconfirmed', 'unconfirmed'])
    const once = []
    await mail(async (type, payload) => {
      if (type === 'screen:step') throw new Error(`busy ${once.push(payload)}`)
    }).execute({ app: 'Mail', label: 'Archive' })
    expect(once).toHaveLength(1)
  })
})
