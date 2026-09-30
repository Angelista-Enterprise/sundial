// /gnomon/api/turn through a fake ctx (W1 step 4): the brief is asked for once,
// injected once, and the owner's words follow it. Made-up values only.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountShell } from './server.js'

function harness() {
  const routes = new Map()
  const handlers = new Map()
  const agent = { status: 'idle', inject: vi.fn(), followup: vi.fn() }
  const brief = vi.fn(() => ({ briefId: 'brief-1', text: 'Right now: 263 commits not pushed yet.\nHow to reply: …', present: 'Right now: 263 commits not pushed yet.' }))
  const ctx = {
    webServer: { register: (route) => routes.set(route.path, route) },
    provide: vi.fn(),
    connection: { requestRejection: () => undefined },
    effect: (fn) => fn(),
    on: (event, handler) => (handlers.set(event, handler), () => {}),
    get: () => undefined,
    agents: { get: () => agent },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'test' }) },
    sessionQuery: { readSession: () => Promise.reject(new Error('none')) },
    gnomonKernel: { brief, getState: () => ({ ownerAsk: { open: null } }), appendSignal: vi.fn() },
  }
  mountShell(ctx, { cwd: '/tmp', home: mkdtempSync(join(tmpdir(), 'sundial-turn-')) })
  return { routes, agent, brief, handlers }
}

function post(route, body) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/turn', headers: {} })
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

afterEach(() => vi.useRealTimers())
