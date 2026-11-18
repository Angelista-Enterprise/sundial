// /gnomon/api/turn through a fake ctx (W1 step 4): the brief is asked for once,
// injected once, and the owner's words follow it. Made-up values only.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalTrack } from '../../../packages/rules/src/approval-track.ts'
import { mountShell } from './server.js'
import { DROPPED_LINE, newQuestion } from './api-sessions.js'

function harness({ state: more = {}, resume = false } = {}) {
  const routes = new Map()
  const handlers = new Map()
  const agent = { status: 'idle', inject: vi.fn(), followup: vi.fn() }
  const state = { ownerAsk: { open: null }, ...more }
  const brief = vi.fn(() => ({ briefId: 'brief-1', text: 'Right now: 263 commits not pushed yet.\nHow to reply: …', present: 'Right now: 263 commits not pushed yet.' }))
  const ctx = {
    webServer: { register: (route) => routes.set(route.path, route) },
    provide: vi.fn(),
    connection: { requestRejection: () => undefined },
    effect: (fn) => fn(),
    on: (event, handler) => (handlers.set(event, handler), () => {}),
    get: () => undefined,
    // `resume`: no live agent, so the shell resumes one and keeps the thread's model (`threadModels`), as after a restart.
    agents: resume ? { get: () => undefined, resume: async () => ({ agent }) } : { get: () => agent },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'test' }) },
    sessionQuery: { readSession: () => Promise.reject(new Error('none')) },
    // The approvals fold as the live kernel's do (approval-track.ts): the watchdog reads what is open there.
    gnomonKernel: { brief, getState: () => state, appendSignal: vi.fn(async (type, payload) => void Object.assign(state, approvalTrack(state, { id: type, type, ts: new Date(Date.now()).toISOString(), payload }).state)) },
  }
  mountShell(ctx, { cwd: '/tmp', home: mkdtempSync(join(tmpdir(), 'sundial-turn-')) })
  return { routes, agent, brief, handlers, ctx }
}

function post(route, body, headers = {}) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/turn', headers })
  req[Symbol.asyncIterator] = async function* () {
    yield JSON.stringify(body)
  }
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(function () { this.headersSent = true }), write: vi.fn(), end: vi.fn(function () { this.writableEnded = true }) })
  return { res, done: route.handler(req, res) }
}

describe('/gnomon/api/turn', () => {
  it('asks the kernel for one brief, injects it once, then sends the owner\'s words', async () => {
    const { routes, agent, brief } = harness()
    agent.followup.mockImplementation(function () {
      queueMicrotask(() => res.emit('close'))
    })
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'anything I forgot?', place: 'Today', answering: { askId: 'ask-1', question: 'Which client is BOX-484 for?' } })
    await done
    expect(brief).toHaveBeenCalledTimes(1)
    expect(brief.mock.calls[0][0]).toEqual({ sessionId: 'session-7f', cause: { kind: 'owner', askId: 'ask-1' }, place: 'Today', answering: 'Which client is BOX-484 for?', text: 'anything I forgot?' })
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.inject.mock.calls[0][0].content[0].text).toBe('Right now: 263 commits not pushed yet.\nHow to reply: …')
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('anything I forgot?')
  })

  it('words sent while the turn still runs (Set 2 R4) correct the task: a task:corrected row, the words once as steering, no second brief', async () => {
    const { routes, agent, ctx, brief } = harness()
    agent.status = 'running'
    agent.steer = vi.fn(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'no, I meant Juniper, not Kestrel' })
    await done
    const rows = ctx.gnomonKernel.appendSignal.mock.calls.filter(([type]) => type.startsWith('task:'))
    expect(rows).toEqual([['task:corrected', { session: 'session-7f', text: 'no, I meant Juniper, not Kestrel' }]])
    // The words reach the model once: no note repeating them, no second brief mid-turn.
    expect(agent.inject).not.toHaveBeenCalled()
    expect(brief).not.toHaveBeenCalled()
    expect(agent.steer.mock.calls[0][0].content[0].text).toBe('no, I meant Juniper, not Kestrel')
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('run 202: words sent while a stale turn still "runs" withdraw it and start a task of their own, never a steer into it', async () => {
    const { routes, agent, ctx } = harness()
    const t = Date.now() - 6 * 60_000
    agent.status = 'running'
    agent.session = { snapshotEvents: () => [{ type: 'turn/start', time: t, data: { turn: 7 } }, { type: 'tool/call', time: t, data: { callId: 'c1' } }, { type: 'approval/asked', time: t, data: { id: 'a1', callId: 'c1' } }, { type: 'approval/decided', time: t + 300_000, data: { id: 'a1', outcome: 'rejected' } }, { type: 'tool/result', time: t + 300_000, data: { message: { toolCallId: 'c1' } } }] }
    agent.cancel = vi.fn()
    agent.steer = vi.fn()
    agent.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'open the Testbox page' })
    await done
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'stale turn' }, { keepInbox: true })
    expect(agent.inject.mock.calls[0][0].content[0].text).toContain('sat 5 minutes with no step and was withdrawn')
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup.mock.calls[0][0].content[0].text).toBe('open the Testbox page')
    expect(ctx.gnomonKernel.appendSignal.mock.calls.filter(([type]) => type.startsWith('task:'))).toEqual([['task:started', { sessionId: 'session-7f', text: 'open the Testbox page', afterTurn: 7 }]])
  })

  it('a steer still queued from an earlier task is dropped when new words start a task', async () => {
    const { routes, agent } = harness()
    agent.inbox = { nextStep: [{ id: 'm1', source: { kind: 'user' } }, { id: 'm2', source: { kind: 'sundial-shell', form: 'notice' } }], remove: vi.fn() }
    agent.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'save it as Kestrel' })
    await done
    expect(agent.inbox.remove.mock.calls).toEqual([['m1']])
  })

  it('Review S5R1: a finish nudge queued before the owner\'s new words, or before a Stop, is dropped; other notices stay', async () => {
    const NUDGE = { kind: 'sundial-llm-openai', form: 'notice', summary: 'The task is not finished' }
    const inbox = () => ({ nextStep: [{ id: 'n1', source: NUDGE }, { id: 'm2', source: { kind: 'sundial-shell', form: 'notice' } }], nextTurn: [{ id: 'n2', source: NUDGE }], remove: vi.fn() })
    const { routes, agent } = harness()
    agent.inbox = inbox()
    agent.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'save it as Kestrel' })
    await done
    expect(agent.inbox.remove.mock.calls).toEqual([['n1'], ['n2']])
    // The Stop keeps the inbox (the owner's queued words), not the nudge.
    agent.inbox = inbox()
    agent.cancel = vi.fn()
    const stop = post(routes.get('/gnomon/api/stop'), { sessionId: 'session-7f' })
    await stop.done
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(agent.inbox.remove.mock.calls).toEqual([['n1'], ['n2']])
  })

  it('doc 29: every Stop writes who pressed it: the slip\'s button (a hand or a posted click), its key, the run bar, or another caller', async () => {
    const { routes, agent, ctx } = harness()
    agent.cancel = vi.fn()
    for (const [body, headers] of [
      [{ sessionId: 'session-7f', by: 'slip-button', press: 'hand' }, {}],
      [{ sessionId: 'session-7f', by: 'slip-key' }, {}],
      [{ sessionId: 'session-7f', by: 'bar', press: 'nonsense' }, {}],
      [{ sessionId: 'session-7f' }, { 'user-agent': 'node' }],
      [{ sessionId: 'session-7f', by: 'the owner, honest' }, {}],
    ]) await post(routes.get('/gnomon/api/stop'), body, headers).done
    expect(ctx.gnomonKernel.appendSignal.mock.calls.filter(([type]) => type === 'chat:stop').map(([, row]) => row)).toEqual([
      { sessionId: 'session-7f', by: 'slip-button', press: 'hand' },
      { sessionId: 'session-7f', by: 'slip-key' },
      { sessionId: 'session-7f', by: 'bar' },
      { sessionId: 'session-7f', by: 'api', agent: 'node' },
      { sessionId: 'session-7f', by: 'api', agent: '' },
    ])
    expect(agent.cancel).toHaveBeenCalledTimes(5)
  })

  it('words sent to an idle chat start a task and a turn of their own, with no correction note', async () => {
    const { routes, agent, ctx } = harness()
    agent.steer = vi.fn()
    agent.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'save it as Kestrel' })
    await done
    expect(ctx.gnomonKernel.appendSignal.mock.calls.filter(([type]) => type.startsWith('task:'))).toEqual([['task:started', { sessionId: 'session-7f', text: 'save it as Kestrel' }]])
    expect(agent.inject).toHaveBeenCalledTimes(1)
    expect(agent.steer).not.toHaveBeenCalled()
  })

  it('the rig picks one thread\'s model only: by rig with no sessionId is refused and never sets the owner\'s default', async () => {
    const { routes, ctx } = harness()
    ctx.agentDefaultModel.saveSelection = vi.fn(async () => {})
    for (const body of [{ by: 'rig', provider: 'openai', model: 'other' }, { by: 'rig', sessionId: '  ', provider: 'openai', model: 'other' }]) {
      const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/model', headers: {} })
      req[Symbol.asyncIterator] = async function* () {
        yield JSON.stringify(body)
      }
      const res = { headersSent: false, writableEnded: false, writeHead: vi.fn(), setHeader: vi.fn(), write: vi.fn(), end: vi.fn() }
      await routes.get('/gnomon/api/model').handler(req, res)
      const status = res.writeHead.mock.calls[0]?.[0] ?? res.statusCode
      expect(status, JSON.stringify(body)).toBe(400)
    }
    expect(ctx.agentDefaultModel.saveSelection).not.toHaveBeenCalled()
  })

  it('an approval the owner is slow on outlives the turn watchdog; the watchdog counts again once it is answered', async () => {
    vi.useFakeTimers()
    const { routes, handlers } = harness()
    const { res } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'run the tests' })
    await vi.advanceTimersByTimeAsync(0)
    const answer = handlers.get('approval/request')({ agent: { session: { id: 'session-7f' } }, toolName: 'gnomon_run_shell', callId: 'call-3' }, () => 'fell-through')
    const quiet = () => res.write.mock.calls.some(([chunk]) => String(chunk).includes('went quiet'))
    // 4 min 50 s: past the watchdog (240 s), inside the approval's 300 s. The client is still there to be asked.
    await vi.advanceTimersByTimeAsync(290_000)
    expect(quiet()).toBe(false)
    expect(res.end).not.toHaveBeenCalled()
    // Unanswered, it expires as rejected at 300 s; that close is a frame, and the watchdog runs from it.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(await answer).toBe('rejected')
    expect(quiet()).toBe(false)
    await vi.advanceTimersByTimeAsync(240_000)
    expect(quiet()).toBe(true)
  })
})

describe('Set 4 R2: a second question while a task runs', () => {
  it('newQuestion: a question with no no, nothing pointing back and no subject word of the task; anything else steers', () => {
    const said = 'rename the 3 files in Testbox to report-1, report-2, report-3'
    expect(newQuestion('what is 14 percent of 380', said)).toBe(true)
    expect(newQuestion('wanneer begint de standup?', said)).toBe(true)
    for (const steer of ['no, call them draft instead', 'make it lowercase', 'what about the report files?', 'is that the Testbox folder?', 'how many files are left', 'stop']) expect(newQuestion(steer, said), steer).toBe(false)
  })

  function sideHarness({ rig = false } = {}) {
    const routes = new Map()
    const main = { status: 'running', inject: vi.fn(), followup: vi.fn(), steer: vi.fn(), cancel: vi.fn() }
    const side = { status: 'idle', inject: vi.fn(), followup: vi.fn(), steer: vi.fn() }
    const live = new Map([['session-7f', main]])
    const state = { ownerAsk: { open: null }, task: { id: 't1', at: new Date().toISOString(), session: 'session-7f', said: 'rename the 3 files in Testbox to report-1, report-2, report-3' }, ...(rig ? { rigSessions: { 'session-7f': '2026-11-16T10:00:00.000Z' } } : {}) }
    const ctx = {
      webServer: { register: (route) => routes.set(route.path, route) },
      provide: vi.fn(),
      connection: { requestRejection: () => undefined },
      effect: (fn) => fn(),
      on: () => () => {},
      get: () => undefined,
      agents: { get: (id) => live.get(id), create: async ({ sessionId }) => (live.set(sessionId, side), { agent: side }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'test' }) },
      sessionQuery: { readSession: () => Promise.reject(new Error('none')) },
      gnomonKernel: { brief: vi.fn(() => ({ briefId: 'b', text: 'Right now: nothing.', present: 'Right now: nothing.' })), getState: () => state, appendSignal: vi.fn(async () => {}) },
    }
    mountShell(ctx, { cwd: '/tmp', home: mkdtempSync(join(tmpdir(), 'sundial-side-')) })
    return { routes, main, side, live, ctx }
  }

  it('opens a side thread and runs there: the task is not steered or stopped, the stream says which thread, the record says aside', async () => {
    const { routes, main, side, live, ctx } = sideHarness()
    side.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'what is 14 percent of 380' })
    await done
    const id = [...live.keys()].find((k) => k !== 'session-7f')
    expect(id).toMatch(/^session-/)
    expect(main.steer).not.toHaveBeenCalled()
    expect(main.cancel).not.toHaveBeenCalled()
    expect(side.followup.mock.calls[0][0].content[0].text).toBe('what is 14 percent of 380')
    expect(res.writeHead.mock.calls[0][1]['x-gnomon-aside']).toBe(id)
    const rows = ctx.gnomonKernel.appendSignal.mock.calls
    // The running task keeps its task object: the side question is no `task:started`.
    expect(rows.filter(([type]) => type.startsWith('task:'))).toEqual([['task:aside', { sessionId: id, parent: 'session-7f', text: 'what is 14 percent of 380' }]])
    expect(rows.some(([type]) => type === 'thread:model')).toBe(false)
  })

  it("a rig chat's side thread is a rig chat too (thread:model rig), so it stays in the sandbox; a steer stays a steer", async () => {
    const { routes, main, side, ctx } = sideHarness({ rig: true })
    side.followup.mockImplementation(() => queueMicrotask(() => res.emit('close')))
    const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'what is 14 percent of 380' })
    await done
    expect(ctx.gnomonKernel.appendSignal.mock.calls.find(([type]) => type === 'thread:model')?.[1]).toMatchObject({ provider: 'openai', model: 'test', rig: true })
    main.steer.mockImplementation(() => queueMicrotask(() => again.res.emit('close')))
    const again = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'no, call them draft instead' })
    await again.done
    expect(main.steer.mock.calls[0][0].content[0].text).toBe('no, call them draft instead')
    expect(again.res.writeHead.mock.calls[0][1]['x-gnomon-aside']).toBeUndefined()
  })

  it('the 4 min watchdog withdraws a turn that sat still with no tool running, and says so in one line', async () => {
    vi.useFakeTimers()
    const { routes, agent } = harness()
    agent.cancel = vi.fn()
    const t = Date.now()
    agent.session = { snapshotEvents: () => [{ type: 'turn/start', time: t }] }
    const { res } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'run the tests' })
    await vi.advanceTimersByTimeAsync(0)
    agent.status = 'running'
    await vi.advanceTimersByTimeAsync(241_000)
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'stale turn' }, { keepInbox: true })
    expect(res.write.mock.calls.map(([c]) => String(c)).join('')).toContain(DROPPED_LINE)
    expect(DROPPED_LINE).toBe('I dropped that, ask again.')
  })
})

describe('a paused route at the next turn (Set 2 R4)', () => {
  it("breaker open on a route with only hedgeTo: the next turn runs on that backup, not on 'paused'", async () => {
    const soon = new Date(Date.now() + 60_000).toISOString()
    const llm = { providers: [{ id: 'main', baseUrl: 'https://llm.example.org/v1', model: 'fast', hedgeTo: 'backup' }, { id: 'backup', baseUrl: 'https://backup.example.org/v1', model: 'slow' }], use: {}, roles: {} }
    const { routes, agent } = harness({ resume: true, state: { config: { llm }, reliability: { llm: { main: { streak: 10, openedAt: soon, openUntil: soon, days: [] } } } } })
    const model = routes.get('/gnomon/api/model')
    const send = (body) => {
      const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/model', headers: {} })
      req[Symbol.asyncIterator] = async function* () { yield JSON.stringify(body) }
      const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn() })
      return Promise.resolve(model.handler(req, res)).then(() => JSON.parse(res.end.mock.calls[0][0]))
    }
    expect((await send({ sessionId: 'session-7f', provider: 'main', model: 'fast' })).current).toMatchObject({ provider: 'main', model: 'fast' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const turn = async () => {
      const { res, done } = post(routes.get('/gnomon/api/turn'), { sessionId: 'session-7f', text: 'anything I forgot?' })
      agent.followup.mockImplementationOnce(() => queueMicrotask(() => res.emit('close')))
      await done
    }
    await turn()
    const moved = () => log.mock.calls.flat().filter((line) => String(line).includes('is paused; thread session-7f'))
    expect(moved()).toEqual(['[sundial-shell] main is paused; thread session-7f continues on backup/slow'])
    // The thread is on the backup now, which is open: the turn after moves nothing.
    await turn()
    expect(moved()).toHaveLength(1)
    log.mockRestore()
  })
})

afterEach(() => vi.useRealTimers())
