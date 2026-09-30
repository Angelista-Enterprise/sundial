// W3: every approval on the record — asked, and answered by the owner, the
// timeout or the asker withdrawing. Through a fake ctx; made-up values only.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountShell } from './server.js'

function harness() {
  const routes = new Map()
  const handlers = new Map()
  const appendSignal = vi.fn(async () => {})
  const ctx = {
    webServer: { register: (route) => routes.set(route.path, route) },
    provide: vi.fn(),
    connection: { requestRejection: () => undefined },
    effect: (fn) => fn(),
    on: (event, handler) => (handlers.set(event, handler), () => {}),
    get: () => undefined,
    agents: { get: () => undefined },
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'test' }) },
    sessionQuery: { readSession: () => Promise.reject(new Error('none')) },
    gnomonKernel: { getState: () => ({ ownerAsk: { open: null } }), appendSignal },
  }
  mountShell(ctx, { cwd: '/tmp', home: mkdtempSync(join(tmpdir(), 'sundial-approval-')) })
  const ask = () => handlers.get('approval/request')({ agent: { session: { id: 'session-7f' } }, toolName: 'gnomon_run_shell', callId: 'call-3' }, () => 'fell-through')
  const recorded = (type) => appendSignal.mock.calls.filter(([t]) => t === type).map(([, p]) => p)
  return { routes, ask, recorded }
}

function post(route, body) {
  const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/approve', headers: {} })
  req[Symbol.asyncIterator] = async function* () {
    yield JSON.stringify(body)
  }
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn() })
  return route.handler(req, res)
}

afterEach(() => vi.useRealTimers())

describe('approvals on the record (W3)', () => {
  it('asked, then answered by the owner', async () => {
    const { routes, ask, recorded } = harness()
    const answer = ask()
    const [asked] = recorded('approval:asked')
    expect(asked).toEqual({ approvalId: expect.stringMatching(/^approval-/), sessionId: 'session-7f', tool: 'gnomon_run_shell' })
    await post(routes.get('/gnomon/api/approve'), { id: asked.approvalId, outcome: 'allowed-once' })
    expect(await answer).toBe('allowed-once')
    expect(recorded('approval:answered')).toEqual([{ approvalId: asked.approvalId, sessionId: 'session-7f', tool: 'gnomon_run_shell', answer: 'allowed-once', by: 'owner' }])
  })

  it('an unanswered approval expires as rejected, by the timeout', async () => {
    vi.useFakeTimers()
    const { ask, recorded } = harness()
    const answer = ask()
    await vi.advanceTimersByTimeAsync(301_000)
    expect(await answer).toBe('rejected')
    expect(recorded('approval:answered')).toMatchObject([{ answer: 'rejected', by: 'timeout' }])
  })
})
