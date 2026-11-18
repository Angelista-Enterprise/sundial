import { describe, expect, it } from 'vitest'
import { createInitialState } from '@sundial/kernel/initial-state.js'
// The real fold, from its source: this plugin does not depend on @sundial/rules.
import { taskBoundary } from '../../packages/rules/src/task-boundary.ts'
import { FINISH_NUDGE } from '@sundial/helpers/task-of.js'
import { createTaskEnd } from './task-end.js'
import { SILENT_CODE, SILENT_LINE } from './stall.js'

/** A kernel that folds what it is given through taskBoundary, as appendSignal does; `rows` is what was written. */
function kernel() {
  const rows = []
  const k = { state: createInitialState('d'), rows, n: 0 }
  k.append = async (type, payload) => {
    rows.push([type, payload])
    k.n += 1
    k.state = taskBoundary(k.state, { id: `${type}-${k.n}`, type, ts: new Date(Date.parse('2026-11-16T09:00:00.000Z') + k.n * 1000).toISOString(), payload }).state
  }
  return k
}
/** The chat's own dsh log in the task's first turn: it began after the task, and its newest tool result is the refusal. */
const at = (s) => Date.parse('2026-11-16T09:00:00.000Z') + s * 1000
const result = (s, isError) => ({ type: 'tool/result', time: at(s), data: { message: { isError } } })
const OWN = [{ type: 'turn/start', time: at(1.5) }, result(2.5, false), result(3.5, true)]
const agent = (id, events = OWN) => ({ id, session: { id, snapshotEvents: () => events }, steered: [], steer(message) { this.steered.push(message) } })
const live = () => new AbortController().signal

async function refusedTask(k, session = 'main') {
  await k.append('task:started', { sessionId: session, text: 'tick gift wrap and submit' })
  await k.append('screen:step', { session, processName: 'Testbox', verb: 'press', screenText: ['Gift wrap'], ok: true })
  await k.append('screen:step', { session, processName: 'Testbox', verb: 'press', screenText: ['Submit'], ok: false, reason: 'not-found' })
}

describe('the finish nudge (plan 21, 2C): once per turn, never after a stop', () => {
  it('a turn ending with a refusal after the last thing done gets one more step, once; the next stop lets it close', async () => {
    const k = kernel()
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    await refusedTask(k)
    const a = agent('main')
    await hooks.stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toHaveLength(1)
    expect(a.steered[0].content).toEqual([{ type: 'text', text: FINISH_NUDGE }])
    expect(a.steered[0].source.kind).not.toBe('user')
    expect(k.rows.filter(([t]) => t === 'task:nudged')).toEqual([['task:nudged', { sessionId: 'main', turn: 1 }]])
    // The model refuses again and stops: the turn closes this time.
    await k.append('screen:step', { session: 'main', processName: 'Testbox', verb: 'press', screenText: ['Submit'], ok: false, reason: 'covered' })
    await hooks.stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toHaveLength(1)
  })

  it('never in a turn the owner stopped, never another chat\'s, never when the row could not be written', async () => {
    const k = kernel()
    await refusedTask(k)
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    const stopped = new AbortController()
    stopped.abort({ kind: 'user' })
    const a = agent('main')
    await hooks.stopping({ agent: a, turn: 1, signal: stopped.signal })
    await hooks.stopping({ agent: agent('other'), turn: 1, signal: live() })
    expect(a.steered).toEqual([])
    expect(k.rows.some(([t]) => t === 'task:nudged')).toBe(false)
    // A failed write: no fold, so no nudge (the fold is the once-guard).
    const broken = createTaskEnd({ getState: () => k.state, appendSignal: async () => { throw new Error('db down') } })
    await broken.stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toEqual([])
  })

  it('the owner\'s hands on the keys refused the last step: no nudge', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'submit the form' })
    await k.append('screen:step', { session: 'main', processName: 'Testbox', verb: 'press', screenText: ['Submit'], ok: false, reason: 'owner-hand' })
    const a = agent('main')
    await createTaskEnd({ getState: () => k.state, appendSignal: k.append }).stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toEqual([])
  })
})

describe('Review S5R1: the nudge is bound to the task\'s own turn, and to a turn that ends on an error', () => {
  it('H1: a Stopped turn ends the task: no nudge in it, and none in a notice turn of the same chat an hour later', async () => {
    const k = kernel()
    await refusedTask(k)
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    const log = [...OWN, { type: 'turn/end', time: at(5) }]
    hooks.ended({ id: 'main', snapshotEvents: () => log }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await Promise.resolve()
    expect(k.state.tasks.main.ended.outcome).toBe('stopped')
    // dsh skips the hook on a Stop; were it called with the turn's own log, the folded stop still holds it.
    const a = agent('main')
    await hooks.stopping({ agent: a, turn: 1, signal: live() })
    // The notice turn: its own refusal, but the task's turn ended before it began.
    const notice = agent('main', [...log, { type: 'turn/start', time: at(3600) }, result(3601, true)])
    await hooks.stopping({ agent: notice, turn: 2, signal: live() })
    expect([...a.steered, ...notice.steered]).toEqual([])
    expect(k.rows.some(([t]) => t === 'task:nudged')).toBe(false)
  })

  it('H1: a later turn of the chat, the task never ended in the fold (an error turn): no nudge', async () => {
    const k = kernel()
    await refusedTask(k)
    const later = agent('main', [...OWN, { type: 'turn/end', time: at(5) }, { type: 'turn/start', time: at(60) }, result(61, true)])
    await createTaskEnd({ getState: () => k.state, appendSignal: k.append }).stopping({ agent: later, turn: 2, signal: live() })
    expect(later.steered).toEqual([])
  })

  it('M1: a refused step, then the job done by a shell command (exit 0): no nudge, and the turn ends done, not failed', async () => {
    const k = kernel()
    await refusedTask(k)
    await k.append('shell:command', { session: 'main', command: 'mv a b', exitCode: 0 })
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    const log = [...OWN, result(6, false)]
    const a = agent('main', log)
    await hooks.stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toEqual([])
    hooks.ended({ id: 'main', snapshotEvents: () => [...log, { type: 'turn/end', time: at(7) }] }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await Promise.resolve()
    expect(k.state.tasks.main.ended.outcome).toBe('done')
  })

  it('H2: a refusal that kept the owner\'s text: no nudge', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'add a line to the note' })
    await k.append('screen:step', { session: 'main', processName: 'Notes', verb: 'set-value', screenText: ['Body'], ok: false, reason: 'replaced the owner\'s own text' })
    const a = agent('main')
    await createTaskEnd({ getState: () => k.state, appendSignal: k.append }).stopping({ agent: a, turn: 1, signal: live() })
    expect(a.steered).toEqual([])
  })
})

describe('Review S5R1 L2: task:ended is bound to the task that was current when its turn began', () => {
  it('a stale turn withdrawn by a new request ends after its task:started: no row, the new task is not marked stopped', async () => {
    const k = kernel()
    await refusedTask(k)
    // The route reads the chat's newest turn (3, the stale one) as the words arrive.
    await k.append('task:started', { sessionId: 'main', text: 'something else', afterTurn: 3 })
    const fresh = k.state.tasks.main
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    // The stale turn began at 1.5 s, before the new task (4 s); it ends now, aborted by the withdrawal.
    hooks.ended({ id: 'main', snapshotEvents: () => [{ type: 'turn/start', time: at(1.5), data: { turn: 3 } }, { type: 'turn/end', time: at(5), data: { turn: 3 } }] }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'hook' } } } })
    await Promise.resolve()
    expect(k.rows.some(([t]) => t === 'task:ended')).toBe(false)
    expect(k.state.tasks.main).toEqual(fresh)
    // The new task's own turn (began at 4.5 s) ends: its row carries the new task's id.
    hooks.ended({ id: 'main', snapshotEvents: () => [{ type: 'turn/start', time: at(1.5), data: { turn: 3 } }, { type: 'turn/start', time: at(4.5), data: { turn: 4 } }] }, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    await Promise.resolve()
    expect(k.rows.filter(([t]) => t === 'task:ended')).toEqual([['task:ended', { sessionId: 'main', taskId: fresh.id, outcome: 'done', turn: 4 }]])
    expect(k.state.tasks.main.ended.outcome).toBe('done')
  })
})

describe('task:ended is bound by turn number, not by clock (no row was written from 2026-11-16 18:15Z on)', () => {
  // dsh logs the turn's `turn/start` a few ms before the kernel stamps `task:started` (task.at, here 09:00:01.000).
  const early = (turn) => [{ type: 'turn/start', time: at(1) - 3, data: { turn } }, { type: 'turn/end', time: at(9), data: { turn } }]
  const end = (turn) => ({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } })

  it('a turn that began 3 ms before its task:started ends: task:ended is written for that task', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'tick gift wrap', afterTurn: 0 })
    createTaskEnd({ getState: () => k.state, appendSignal: k.append }).ended({ id: 'main', snapshotEvents: () => early(1) }, end(1))
    await Promise.resolve()
    expect(k.rows.filter(([t]) => t === 'task:ended')).toEqual([['task:ended', { sessionId: 'main', taskId: k.state.tasks.main.id, outcome: 'done', turn: 1 }]])
    expect(k.state.tasks.main.ended.outcome).toBe('done')
  })

  it('a turn the 90 s cap ended (dsh reason error, SILENT_CODE) ends its task failed (run 250 T04)', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'send the mail', afterTurn: 0 })
    const capped = { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: SILENT_LINE, code: SILENT_CODE } } } }
    createTaskEnd({ getState: () => k.state, appendSignal: k.append }).ended({ id: 'main', snapshotEvents: () => early(1) }, capped)
    await Promise.resolve()
    expect(k.rows.filter(([t]) => t === 'task:ended')).toEqual([['task:ended', { sessionId: 'main', taskId: k.state.tasks.main.id, outcome: 'failed', turn: 1 }]])
  })

  it('a task from before afterTurn binds by clock with slack: a few ms early is its own, a stale turn minutes before is not', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'tick gift wrap' })
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    hooks.ended({ id: 'main', snapshotEvents: () => [{ type: 'turn/start', time: at(1) - 600_000, data: { turn: 3 } }] }, end(3))
    await Promise.resolve()
    expect(k.rows.some(([t]) => t === 'task:ended')).toBe(false)
    hooks.ended({ id: 'main', snapshotEvents: () => early(4) }, end(4))
    await Promise.resolve()
    expect(k.rows.filter(([t]) => t === 'task:ended')).toHaveLength(1)
  })

  it('the nudge reads the task\'s own turn by number: a turn that began early still gets it, a withdrawn stale turn\'s end does not block it', async () => {
    const k = kernel()
    await k.append('task:started', { sessionId: 'main', text: 'tick gift wrap and submit', afterTurn: 3 })
    await k.append('screen:step', { session: 'main', processName: 'Testbox', verb: 'press', screenText: ['Gift wrap'], ok: true })
    await k.append('screen:step', { session: 'main', processName: 'Testbox', verb: 'press', screenText: ['Submit'], ok: false, reason: 'not-found' })
    // The stale turn 3 ends (withdrawn) after the task began; turn 4 began 3 ms before task.at and is still running.
    const log = [{ type: 'turn/start', time: at(-600), data: { turn: 3 } }, { type: 'turn/end', time: at(2), data: { turn: 3 } }, { type: 'turn/start', time: at(1) - 3, data: { turn: 4 } }, result(2.5, false), result(3.5, true)]
    const a = agent('main', log)
    await createTaskEnd({ getState: () => k.state, appendSignal: k.append }).stopping({ agent: a, turn: 4, signal: live() })
    expect(a.steered).toHaveLength(1)
    // A later turn of the chat, after the task's own turn 4 ended: no nudge.
    const k2 = kernel()
    await k2.append('task:started', { sessionId: 'main', text: 'x', afterTurn: 3 })
    await k2.append('screen:step', { session: 'main', processName: 'Testbox', verb: 'press', screenText: ['Submit'], ok: false, reason: 'not-found' })
    const later = agent('main', [...log, { type: 'turn/end', time: at(5), data: { turn: 4 } }, { type: 'turn/start', time: at(60), data: { turn: 5 } }, result(61, true)])
    await createTaskEnd({ getState: () => k2.state, appendSignal: k2.append }).stopping({ agent: later, turn: 5, signal: live() })
    expect(later.steered).toEqual([])
  })
})

describe('task:ended on dsh\'s turn/end', () => {
  it('writes the outcome for a chat with a task, folded onto that task; nothing for a chat without one or another event', async () => {
    const k = kernel()
    await refusedTask(k)
    const hooks = createTaskEnd({ getState: () => k.state, appendSignal: k.append })
    hooks.ended({ id: 'main' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    hooks.ended({ id: 'main' }, { type: 'step/end', data: {} })
    hooks.ended({ id: 'no-task' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await Promise.resolve()
    expect(k.rows.filter(([t]) => t === 'task:ended')).toEqual([['task:ended', { sessionId: 'main', taskId: k.state.tasks.main.id, outcome: 'partial', turn: 2 }]])
    expect(k.state.tasks.main.ended.outcome).toBe('partial')
    hooks.ended({ id: 'main' }, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
    await Promise.resolve()
    expect(k.state.tasks.main.ended.outcome).toBe('stopped')
  })
})
