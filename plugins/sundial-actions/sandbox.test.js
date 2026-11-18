// S4: the rig's sandbox at the gate and in the tools. In a rig chat with a live sandbox the daily tools run, and every row
// they write carries the chat's sessionId (so the fold files it in the sandbox, packages/rules sandbox.test.ts); in a rig chat
// with none they stay refused; in the owner's chat they run as the owner's, the rows as they were. What stays fenced in a
// rig chat stays refused with a sandbox. Every value is made up.
import { describe, expect, it, vi } from 'vitest'
import { askLoop } from '@sundial/helpers/loops.js'
import { repeatKey } from '@sundial/helpers/repeat-schedule.js'
import { sandboxOf } from '@sundial/helpers/sandbox.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { callFacts, decideAction, RIG_FENCED, SANDBOXED } from './gate.js'
import { internalTools } from './tools.js'
import { watchTools } from '../sundial-tools/watch-tools.js'
import { createDelivery } from '../sundial-proactive/delivery.js'

const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
const decide = (toolName, more = {}) => decideAction({ toolName, args: {}, preset: 'workspace-write', actions, resolveActionPolicy, facts: callFacts({ toolName, args: {} }), ...more })
const RIG = 'session-rig'
const OWN = 'session-own'
const empty = () => ({ loops: { open: [], recent: [] }, ownerAsk: { recent: [] }, drafts: { recent: [] }, commitments: { promises: [], recentClosed: [] }, workbench: { open: null, queue: [], repeats: {} }, watch: { rules: [] } })
const SPEC = { id: 'crate-watch', title: 'Crate watch', when: { type: 'window:changed', where: [{ field: 'processName', op: 'eq', value: 'Chess' }] }, say: 'Chess is open' }

describe('the gate: the sandboxed tools run in a rig chat with a sandbox, and only there', () => {
  it('each runs in a rig chat with a live sandbox; refused in a rig chat whose sandbox is gone; runs in the owner\'s chat', () => {
    for (const tool of SANDBOXED) {
      expect(decide(tool, { rig: true, sandbox: true }).kind, tool).toBe('allow')
      expect(decide(tool, { rig: true, sandbox: false }), tool).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^This is a test chat/) })
      expect(decide(tool, { rig: false }).kind, tool).toBe('allow')
    }
  })

  it('what stays fenced stays refused in a rig chat with a sandbox: a fact, a claim, an outcome, the shelf, the board, the calendar, the reminders', () => {
    const fenced = [...RIG_FENCED].filter((t) => !SANDBOXED.has(t))
    expect(fenced).toEqual(expect.arrayContaining(['gnomon_assert', 'gnomon_claim', 'gnomon_propose', 'gnomon_record_outcome', 'gnomon_notice_feedback', 'gnomon_shelve', 'gnomon_work_done', 'gnomon_board', 'gnomon_calendar_create', 'gnomon_reminder_create', 'gnomon_night_job', 'gnomon_reach_revoke']))
    for (const tool of fenced) expect(decide(tool, { rig: true, sandbox: true }), tool).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/^This is a test chat/) })
    expect(decide('gnomon_lens', { rig: true, sandbox: true, facts: { ...callFacts({ toolName: 'gnomon_lens', args: { action: 'place' } }) } }).kind).toBe('deny')
  })
})

/** The internal tools over `state`, called from `sessionId`; every appended row, and whether the fold would sandbox it. */
function tools(state, sessionId) {
  const sent = []
  const byName = Object.fromEntries(internalTools(async (type, payload) => sent.push({ type, payload }), () => state, { askWaitMs: 50, askPollMs: 5 }).map((t) => [t.name, t]))
  const exec = { agent: { session: { id: sessionId } } }
  const call = (name, args) => byName[name].execute(args, exec)
  return { sent, call, boxed: () => sent.map((r) => sandboxOf(state, r)) }
}
const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()
const ownerState = () => ({ ...empty(), rigSessions: { [RIG]: '2026-11-16T09:00:00.000Z' }, sandbox: { [RIG]: empty() } })

describe('each sandboxed tool: in the rig chat its rows are the sandbox\'s, in the owner\'s chat they are the owner\'s', () => {
  const CALLS = [
    ['gnomon_schedule_wakeup', () => ({ at: inAnHour(), reason: 'check the release 7 deploy' })],
    ['gnomon_cancel_wakeup', () => ({ key: 'check-the-release-7-deploy' })],
    ['gnomon_track_promise', () => ({ what: 'the crate report', to: 'Ines Willow', due: 'Tuesday', words: 'I owe Ines Willow the crate report by Tuesday' })],
    ['gnomon_track_promise', () => ({ id: 'commitment:promise:chat-x', move_to: inAnHour() })],
    ['gnomon_draft', () => ({ kind: 'email', to: 'Pavel Onyx', subject: 'Crates', body: 'The amber crates arrive on Thursday.', evidence: ['the task'] })],
    ['gnomon_start_job', () => ({ subject: 'crate sum 7', brief: 'Work out 12 plus 30.' })],
    ['gnomon_start_job', () => ({ subject: 'crate list', brief: 'Check the crate list.', repeat: 'weekdays at 17:30' })],
    ['gnomon_ask_owner', () => ({ question: 'Which crate colour, amber, green or grey?', choices: ['amber', 'green', 'grey'] })],
  ]
  for (const [name, args] of CALLS) {
    it(`${name}: rig chat, the row carries its sessionId and is sandboxed; owner chat, unchanged and the owner's`, async () => {
      const rig = tools(ownerState(), RIG)
      await rig.call(name, args())
      expect(rig.sent).toHaveLength(1)
      expect(rig.sent[0].payload.sessionId).toBe(RIG)
      expect(rig.boxed()).toEqual([RIG])
      const own = tools(ownerState(), OWN)
      await own.call(name, args())
      expect(own.sent[0].payload).not.toHaveProperty('sessionId')
      expect(own.boxed()).toEqual([null])
    })
  }

  it('gnomon_stop_repeat and gnomon_owner_answer read the rig chat\'s sandbox, never the owner\'s: each side sees only its own', async () => {
    const state = ownerState()
    state.workbench.repeats = { [repeatKey('owner list')]: { subject: 'owner list', schedule: 'daily at 8' } }
    state.sandbox[RIG].workbench.repeats = { [repeatKey('crate list')]: { subject: 'crate list', schedule: 'weekdays at 17:30' } }
    state.loops.open = [askLoop({ askId: 'owner-ask:own1', question: 'Owner question?', reason: '', choices: [], ts: '2026-11-16T09:00:00.000Z' })]
    state.sandbox[RIG].loops.open = [askLoop({ askId: 'owner-ask:rig1', question: 'Which crate colour?', reason: '', choices: [], ts: '2026-11-16T09:00:00.000Z' })]
    const rig = tools(state, RIG)
    await expect(rig.call('gnomon_stop_repeat', { subject: 'owner list' })).rejects.toThrow(/no repeating job called "owner list"; the kept ones are "crate list"/)
    expect(await rig.call('gnomon_stop_repeat', { subject: 'crate list' })).toMatchObject({ stopped: 'crate list' })
    expect(await rig.call('gnomon_owner_answer', { askId: 'owner-ask:own1', answer: 'yes' })).toMatchObject({ recorded: false })
    expect(await rig.call('gnomon_owner_answer', { askId: 'owner-ask:rig1', answer: 'green' })).toMatchObject({ recorded: true })
    expect(rig.sent.map((r) => [r.type, r.payload.sessionId])).toEqual([['work:repeat-stopped', RIG], ['ask:owner-answered', RIG]])
    expect(await rig.call('gnomon_ask_owner', { question: 'Another?' })).toMatchObject({ asked: false, askId: 'owner-ask:rig1' })
    const own = tools(state, OWN)
    expect(await own.call('gnomon_owner_answer', { askId: 'owner-ask:own1', answer: 'yes' })).toMatchObject({ recorded: true })
    expect(own.sent[0].payload).not.toHaveProperty('sessionId')
    await expect(own.call('gnomon_stop_repeat', { subject: 'crate list' })).rejects.toThrow(/the kept ones are "owner list"/)
  })
})

describe('the rule tools: a rig chat adopts, pauses, resumes and drops only its own rules', () => {
  const run = (state, sessionId) => {
    const sent = []
    const list = watchTools(async (type, payload) => sent.push({ type, payload }), () => state, async (rule) => ({ valid: true, rule, fired: 1, days: 30, gate: { phasic: 0, tonic: 1 } }), async () => ({ clean: true }), () => [])
    const by = Object.fromEntries(list.map((t) => [t.name, t]))
    return { sent, call: (name, args) => by[name].execute(args, { agent: { session: { id: sessionId } } }) }
  }
  it('the rig chat names its sandbox\'s rules, never the owner\'s, even under the same id; the owner\'s chat the other way', async () => {
    const state = ownerState()
    state.watch = { rules: [{ ...SPEC, title: 'Owner crate watch' }] }
    const rig = run(state, RIG)
    await expect(rig.call('gnomon_pause_rule', { id: 'crate-watch' })).rejects.toThrow(/no rules are adopted/)
    await rig.call('gnomon_adopt_rule', { rule: SPEC })
    state.sandbox[RIG].watch = { rules: [SPEC] }
    for (const op of ['pause', 'resume', 'drop']) await rig.call(`gnomon_${op}_rule`, { id: 'crate-watch' })
    expect(rig.sent.map((r) => [r.type, r.payload.sessionId, sandboxOf(state, r)])).toEqual(['rule:adopted', 'rule:paused', 'rule:resumed', 'rule:dropped'].map((t) => [t, RIG, RIG]))
    const own = run(state, OWN)
    await own.call('gnomon_pause_rule', { id: 'crate-watch' })
    expect(own.sent).toEqual([{ type: 'rule:paused', payload: { id: 'crate-watch' } }])
    expect(sandboxOf(state, own.sent[0])).toBeNull()
  })
})

describe('a sandbox line: its own rig thread only, never the owner\'s thread, the companion, ntfy or a banner', () => {
  const line = (payload) => ({ channel: 'sandbox-notice', payload: { noticeKey: 'wakeup:deploy:2026-11-16T09:03:00.000Z', kind: 'wakeup', observation: 'check the release 7 deploy', evidence: [], sessionId: RIG, sandbox: RIG, ...payload } })
  // `getThread` resumes or creates a chat's agent; a sandbox line must never call it (Fable M3), only `getLiveThread`.
  const harness = (thread) => {
    const record = vi.fn()
    const spies = { getCompanion: vi.fn(), notifyPhone: vi.fn(), notifyNative: vi.fn(), announce: vi.fn(), brief: vi.fn(), getThread: vi.fn(async () => ({ id: RIG, status: 'idle', inject: vi.fn(), session: { append: vi.fn() } })) }
    const getLiveThread = vi.fn((id) => (id === RIG ? thread : null))
    const delivery = createDelivery({ ...spies, getLiveThread, record, log: () => {}, warn: () => {} })
    return { delivery, record, spies, getThread: getLiveThread }
  }

  it('draws one line in the rig thread and records it marked; nothing else is touched', async () => {
    const thread = { id: RIG, status: 'idle', inject: vi.fn(), followup: vi.fn(), session: { append: vi.fn() } }
    const { delivery, record, spies, getThread } = harness(thread)
    expect(await delivery.deliver(line())).toEqual({ delivered: true, channel: 'sandbox-notice' })
    expect(getThread.mock.calls).toEqual([[RIG]])
    expect(thread.session.append).toHaveBeenCalledTimes(1)
    expect(thread.followup).not.toHaveBeenCalled()
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
    expect(record.mock.calls).toEqual([['notice:delivered', { noticeKey: 'wakeup:deploy:2026-11-16T09:03:00.000Z', sessionId: RIG, sandbox: RIG, kind: 'wakeup', acts: ['line'] }]])
  })

  it('a rig thread that is not live is never resumed or created for a line: a marked drop', async () => {
    const { delivery, record, spies } = harness(null)
    expect(await delivery.deliver(line())).toMatchObject({ delivered: false, reason: 'session-gone' })
    expect(spies.getThread).not.toHaveBeenCalled()
    expect(record.mock.calls).toEqual([['notice:dropped', expect.objectContaining({ sessionId: RIG, sandbox: RIG, reason: 'session-gone' })]])
    const disposed = harness({ id: RIG, status: 'disposed', session: { append: vi.fn() } })
    expect(await disposed.delivery.deliver(line())).toMatchObject({ delivered: false, reason: 'session-gone' })
  })

  it('a line with no rig thread, or one naming another thread than its sandbox, goes nowhere; a gone thread is a marked drop', async () => {
    const { delivery, record, spies } = harness(null)
    expect(await delivery.deliver(line({ sandbox: undefined }))).toMatchObject({ delivered: false })
    expect(await delivery.deliver(line({ sessionId: OWN }))).toMatchObject({ delivered: false })
    expect(await delivery.deliver(line({ sandbox: 'gnomon-companion', sessionId: 'gnomon-companion' }))).toMatchObject({ delivered: false })
    expect(await delivery.deliver(line())).toMatchObject({ delivered: false, reason: 'session-gone' })
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
    expect(record.mock.calls).toEqual([['notice:dropped', expect.objectContaining({ sessionId: RIG, sandbox: RIG, reason: 'session-gone' })]])
  })
})

describe('the tools in a test chat say where things went, mint ids that never collide, and run one job at a time', () => {
  it('L6: a promise and a question minted in the same millisecond get different ids', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-16T09:00:00.000Z'))
    try {
      const a = tools(ownerState(), RIG)
      await a.call('gnomon_track_promise', { what: 'the report', to: 'Mira Bakker' })
      await a.call('gnomon_track_promise', { what: 'the samples', to: 'Mira Bakker' })
      const ids = a.sent.map((r) => r.payload.id)
      expect(ids[0]).not.toBe(ids[1])
      const q = (state) => tools(state, RIG).call('gnomon_ask_owner', { question: 'Which colour?' })
      const [x, y] = [await q(ownerState()), await q(ownerState())]
      expect(x.askId).not.toBe(y.askId)
      expect(x.askId).toMatch(/^owner-ask:[0-9a-z]+-[0-9a-f]{6}$/)
    } finally {
      now.mockRestore()
    }
  })

  it('L9: the draft, the job, the repeat and the rule say "this test chat" in a rig chat, and the owner\'s words in the owner\'s', async () => {
    const text = (name, value) => {
      const all = [...internalTools(async () => {}, () => ownerState()), ...watchTools(async () => {}, () => ownerState(), async () => ({}), async () => ({}), () => [])]
      return all.find((t) => t.name === name).output.render({}, value)[0].text
    }
    const rig = tools(ownerState(), RIG)
    const draft = await rig.call('gnomon_draft', { kind: 'note', subject: 'Crates', body: 'Thursday.' })
    expect(text('gnomon_draft', draft)).toMatch(/in this test chat, not on the owner.s Today/)
    expect(text('gnomon_draft', await tools(ownerState(), OWN).call('gnomon_draft', { kind: 'note', subject: 'Crates', body: 'Thursday.' }))).toMatch(/placed on the owner.s Today/)
    expect(text('gnomon_start_job', await rig.call('gnomon_start_job', { subject: 'crate sum', brief: 'Add.' }))).toMatch(/in this test chat.*never on the owner's shelf/)
    expect(text('gnomon_start_job', await tools(ownerState(), RIG).call('gnomon_start_job', { subject: 'crate list', brief: 'x', repeat: 'weekdays at 17:30' }))).toMatch(/in this test chat.*never runs/)
    const w = watchTools(async () => {}, () => ownerState(), async (rule) => ({ valid: true, rule, fired: 1, days: 30, gate: { phasic: 0, tonic: 1 } }), async () => ({}), () => []).find((t) => t.name === 'gnomon_adopt_rule')
    const adopted = await w.execute({ rule: SPEC }, { agent: { session: { id: RIG } } })
    expect(w.output.render({}, adopted)[0].text).toMatch(/in this test chat only.*never watches the owner's record/)
  })

  it('M4: a second job in a test chat while one is open or queued is refused; the owner\'s chat queues as before', async () => {
    const busy = ownerState()
    busy.sandbox[RIG].workbench.open = { id: 'job-1', subject: 'crate sum' }
    await expect(tools(busy, RIG).call('gnomon_start_job', { subject: 'another', brief: 'x' })).rejects.toThrow(/already has a job running \("crate sum"\)/)
    busy.workbench.open = { id: 'job-own', subject: 'owner job' }
    expect(await tools(busy, OWN).call('gnomon_start_job', { subject: 'another', brief: 'x' })).toMatchObject({ queued: true })
  })
})
