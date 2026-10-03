import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { OpenAICompatAdapter } from './index.js'

/**
 * The route answers 503 "temporarily unavailable" while it swaps a model in.
 * dsh closes a turn whose step never opened with zero steps, so the owner sees
 * an empty answer and blames the model id. The adapter retries instead.
 */

const sse = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { status: 200 },
  )

const unavailable = () => new Response(JSON.stringify({ error: { message: 'The model is temporarily unavailable.' } }), { status: 503 })

const adapter = () => new OpenAICompatAdapter({ baseUrl: 'http://route', model: 'm', resolveApiKey: async () => 'k' })

const drain = async (stream) => {
  const seen = []
  for await (const event of stream) seen.push(event)
  return seen
}

// The backoff is real time (0.7 s, then 1.4 s); only setTimeout is faked, so fetch and the streams run as they are.
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Drains with the clock run forward, so each backoff sleep ends at once. */
const drainFast = async (stream) => {
  const done = drain(stream)
  done.catch(() => {})
  await vi.runAllTimersAsync()
  return done
}

describe('stream retries', () => {
  it('retries a 503 and succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(sse())
    vi.stubGlobal('fetch', fetchMock)
    await drainFast(adapter().stream({ messages: [] }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after three tries and says what the route said', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unavailable())
    vi.stubGlobal('fetch', fetchMock)
    await expect(drainFast(adapter().stream({ messages: [] }))).rejects.toThrow(/temporarily unavailable/)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 400 — a bad request stays bad', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(drain(adapter().stream({ messages: [] }))).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a model that cannot stop reasoning', () => {
  const refusal = () => new Response(JSON.stringify({ error: { message: 'Disabling thinking is not supported.' } }), { status: 400 })

  it('asks once more without reasoning_effort, and only for that refusal', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal()).mockResolvedValueOnce(sse())
    vi.stubGlobal('fetch', fetchMock)
    await drain(adapter().stream({ messages: [], purpose: 'session-title' }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe('none')
    expect('reasoning_effort' in JSON.parse(fetchMock.mock.calls[1][1].body)).toBe(false)
  })

  it('does not loop when the second answer is also a 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(refusal())
    vi.stubGlobal('fetch', fetchMock)
    await expect(drain(adapter().stream({ messages: [], purpose: 'session-title' }))).rejects.toThrow(/thinking/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
