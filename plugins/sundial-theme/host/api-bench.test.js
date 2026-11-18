// The bench ingest route: writes only on the bench install, only the bench's types. Made-up values only.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { mountBench } from './api-bench.js'

function mounted(refusal) {
  const routes = new Map()
  const appendSignal = vi.fn(async () => {})
  mountBench({ effect: (fn) => fn(), webServer: { register: (route) => routes.set(route.path, route) }, connection: { requestRejection: () => undefined }, gnomonKernel: { appendSignal } }, { refusal })
  const send = async (body) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/gnomon/api/bench/ingest', headers: {} })
    req[Symbol.asyncIterator] = async function* () {
      yield JSON.stringify(body)
    }
    const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(), end: vi.fn() })
    await routes.get('/gnomon/api/bench/ingest').handler(req, res)
    return { status: res.writeHead.mock.calls[0]?.[0], body: JSON.parse(res.end.mock.calls[0]?.[0] ?? '{}') }
  }
  return { send, appendSignal }
}

describe('POST /gnomon/api/bench/ingest', () => {
  it("writes nothing off the bench install (the owner's)", async () => {
    const { send, appendSignal } = mounted(() => 'this install runs as dev.sundial.agent, not dev.sundial.bench')
    const said = await send({ type: 'chat:owner', payload: { sessionId: 'session-b1', text: 'I moved to Delft last spring.' } })
    expect(said.status).toBe(403)
    expect(appendSignal).not.toHaveBeenCalled()
  })

  it('on the bench: a bench type with its own time; any other type is refused', async () => {
    const { send, appendSignal } = mounted(() => null)
    expect((await send({ type: 'chat:owner', payload: { sessionId: 'session-b1', text: 'I moved to Delft last spring.' }, ts: '2023-05-20T02:21:00Z' })).body).toEqual({ ingested: true, type: 'chat:owner', ts: '2023-05-20T02:21:00.000Z' })
    expect(appendSignal).toHaveBeenCalledWith('chat:owner', { sessionId: 'session-b1', text: 'I moved to Delft last spring.' }, '2023-05-20T02:21:00.000Z')
    expect((await send({ type: 'approval:answered', payload: {} })).status).toBe(400)
    expect((await send({ type: 'window:changed', payload: { processName: 'Code', windowTitle: 'CheckName.rb' } })).body).toEqual({ ingested: true, type: 'window:changed' })
    // LongMemEval's assistant turns, as Gnomon's replies: single-session-assistant asks what was said back.
    expect((await send({ type: 'chat:said', payload: { sessionId: 'session-b1', text: 'Try the Boulderhal Sloterdijk.' } })).body).toEqual({ ingested: true, type: 'chat:said' })
    expect(appendSignal).toHaveBeenCalledTimes(3)
  })
})
