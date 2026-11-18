import { describe, it, expect, vi, afterEach } from 'vitest'
import { apply, OpenAICompatAdapter, hedge, SILENT_CODE, SILENT_LINE, stall } from './index.js'

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('aborted'))), { once: true })
  })

/** A fake model stream: its first token after `delay` ms, then a finish. Records the signal it was given. */
const fake = (delay, text, seen) =>
  async function* (signal) {
    seen.push(signal)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    await sleep(delay, signal)
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

const text = async (stream) => {
  let out = ''
  for await (const chunk of stream) if (chunk.type === 'text-delta') out += chunk.text
  return out
}

describe('hedge', () => {
  it('a first token before the hedge point: one request, no log', async () => {
    const seen = []
    const log = vi.fn()
    const starts = [fake(0, 'first', seen), fake(0, 'second', seen)]
    expect(await text(hedge((signal) => starts[seen.length](signal), { after: 50, log }))).toBe('first')
    expect(seen).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('a slow first: the second is sent, answers first and wins; the first is aborted', async () => {
    const seen = []
    const log = vi.fn()
    const starts = [fake(500, 'first', seen), fake(0, 'second', seen)]
    expect(await text(hedge((signal, hedging) => starts[hedging ? 1 : 0](signal), { after: 20, log }))).toBe('second')
    expect(seen).toHaveLength(2)
    expect(seen[0].aborted).toBe(true)
    expect(seen[1].aborted).toBe(false)
    expect(log).toHaveBeenCalledWith('hedged after 20 ms, winner second')
  })

  it('a slow first and a slower second: the first wins, the second is aborted, the finish says so', async () => {
    const seen = []
    const log = vi.fn()
    const starts = [fake(60, 'first', seen), fake(500, 'second', seen)]
    const chunks = []
    for await (const chunk of hedge((signal, hedging) => starts[hedging ? 1 : 0](signal), { after: 20, log })) chunks.push(chunk)
    expect(chunks.find((c) => c.type === 'text-delta').text).toBe('first')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, hedged: true, winner: 'first' })
    expect(seen.map((signal) => signal.aborted)).toEqual([false, true])
    expect(log).toHaveBeenCalledWith('hedged after 20 ms, winner first')
  })

  it("the caller's abort reaches both requests and ends the stream", async () => {
    const seen = []
    const caller = new AbortController()
    const starts = [fake(500, 'first', seen), fake(500, 'second', seen)]
    const done = text(hedge((signal, hedging) => starts[hedging ? 1 : 0](signal), { signal: caller.signal, after: 10 }))
    await sleep(30)
    caller.abort()
    await expect(done).rejects.toThrow(/aborted/)
    expect(seen.map((signal) => signal.aborted)).toEqual([true, true])
  })

  it('a failure before the hedge point is the call failing, not a reason to send it again', async () => {
    let calls = 0
    const start = async function* () {
      calls++
      throw new Error('400')
    }
    await expect(text(hedge(start, { after: 20 }))).rejects.toThrow('400')
    expect(calls).toBe(1)
  })
})

describe('the chat route hedges', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** An SSE response whose first token arrives after `delay` ms. */
  const slowSse = (delay, word) =>
    new Response(
      new ReadableStream({
        async start(controller) {
          if (delay) await sleep(delay)
          const enc = new TextEncoder()
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: word }, finish_reason: 'stop' }] })}\n\n`))
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      }),
      { status: 200 },
    )
  const adapter = (facts = { hedgeAfterMs: 20 }) => new OpenAICompatAdapter({ baseUrl: 'http://route', model: 'm', resolveApiKey: async () => 'k', ...facts })

  it('a 429 on the hedge is ignored: one try, and the first request still answers', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(80, 'first')).mockResolvedValue(new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await text(adapter().stream({ messages: [], sessionId: 's' }))).toBe('first')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.flat().join('\n')).toMatch(/hedged after 20 ms, winner first \(second failed: /)
    log.mockRestore()
  })

  it('the hedge carries its own session id, so the provider may route it elsewhere', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(500, 'first')).mockResolvedValue(slowSse(0, 'second'))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await text(adapter().stream({ messages: [], sessionId: 's' }))).toBe('second')
    expect(fetchMock.mock.calls.map(([, init]) => init.headers['x-gnomon-session-id'])).toEqual(['s', 's:hedge'])
    vi.restoreAllMocks()
  })

  describe('hedgeTo', () => {
    const routes = (backupRoute) => {
      const added = []
      apply({ llm: { registerAdapter: (ids, a) => added.push([ids[0], a]) } }, {
        envFile: '/nonexistent/.env',
        runtimeRoutes: [],
        providers: [
          { id: 'main', baseUrl: 'http://main', model: 'fast', hedgeTo: backupRoute, body: { provider: { sort: 'latency' }, model: 'evil', stream: false } },
          { id: 'backup', baseUrl: 'http://backup', model: 'slow' },
        ],
      })
      return Object.fromEntries(added)
    }
    const chat = async (adapter) => {
      const chunks = []
      for await (const chunk of adapter.stream({ model: 'fast', messages: [], sessionId: 's' })) chunks.push(chunk)
      return chunks
    }
    const sent = (fetchMock) => fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])

    it('the hedge goes to the named route with its model, and the finish names the winner', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(500, 'main')).mockResolvedValue(slowSse(0, 'backup'))
      vi.stubGlobal('fetch', fetchMock)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const { main } = routes('backup:vendor/other')
      main.facts.hedgeAfterMs = 20
      const chunks = await chat(main)
      expect(chunks.find((c) => c.type === 'text-delta').text).toBe('backup')
      // Filed under the route that answered, so it does not count toward main's pace (doc 31).
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', hedged: true, winner: 'backup:vendor/other', fellBack: { route: 'backup', model: 'vendor/other' } })
      const [[url1, body1], [url2, body2]] = sent(fetchMock)
      expect([url1, body1.model, body1.stream, body1.provider]).toEqual(['http://main/chat/completions', 'fast', true, { sort: 'latency' }])
      expect([url2, body2.model, body2.provider]).toEqual(['http://backup/chat/completions', 'vendor/other', undefined])
      expect(log.mock.calls.flat().join('\n')).toMatch(/hedged after 20 ms, winner backup:vendor\/other/)
      vi.restoreAllMocks()
    })

    it("a bare route hedges onto that route's own model; the first can still win", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(60, 'main')).mockResolvedValue(slowSse(500, 'backup'))
      vi.stubGlobal('fetch', fetchMock)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { main } = routes('backup')
      main.facts.hedgeAfterMs = 20
      const last = (await chat(main)).at(-1)
      expect(last).toMatchObject({ winner: 'main:fast' })
      expect(last.fellBack).toBeUndefined()
      expect(sent(fetchMock)[1][1].model).toBe('slow')
      vi.restoreAllMocks()
    })

    it('a route that does not exist: warned once, the hedge goes to the same route as before', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { main } = routes('nowhere:m')
      expect(main.backup).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)
      const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(500, 'first')).mockResolvedValue(slowSse(0, 'second'))
      vi.stubGlobal('fetch', fetchMock)
      main.facts.hedgeAfterMs = 20
      expect((await chat(main)).at(-1)).toMatchObject({ winner: 'second' })
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://main/chat/completions', 'http://main/chat/completions'])
      vi.restoreAllMocks()
    })
  })

  it('unset: hedged at the 8000 ms default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(60_000, 'first')).mockResolvedValue(slowSse(0, 'second'))
      vi.stubGlobal('fetch', fetchMock)
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const done = text(adapter({}).stream({ messages: [], sessionId: 's' }))
      await vi.advanceTimersByTimeAsync(7_999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await done).toBe('second')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  it('hedgeAfterMs 0: never hedged, however slow', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(80, 'only')).mockResolvedValue(slowSse(0, 'dup'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await text(adapter({ hedgeAfterMs: 0 }).stream({ messages: [], sessionId: 's' }))).toBe('only')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('run 209 T12: a chat turn never streams tool-call markup the model printed as text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(slowSse(0, '<tool_call> <invoke name="gnomon_call"><name>screen_look</name></invoke> </tool_call>')))
    const said = await text(adapter({ hedgeAfterMs: 0 }).stream({ messages: [], sessionId: 's' }))
    expect(said).not.toMatch(/tool_call|invoke/)
    expect(said).not.toBe('')
  })

  it('a background purpose is never hedged, however slow', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(slowSse(80, 'notes')).mockResolvedValue(slowSse(0, 'dup'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await text(adapter().stream({ messages: [], sessionId: 's', purpose: 'chat-notes' }))).toBe('notes')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a stalled chat stream', () => {
  /** A stream that starts with `head`, then stalls (until aborted) when `stalls`, else finishes with `word`. */
  const stub = (head, stalls, word, seen) =>
    async function* (signal) {
      seen.push(signal)
      for (const chunk of head) yield chunk
      if (stalls) await sleep(10_000, signal)
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: word }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  const thinking = [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'hm' },
  ]

  it('stalls before any text: aborted, the open reasoning closed, sent once more with blocks after it', async () => {
    const seen = []
    const log = vi.fn()
    const starts = [stub(thinking, true, 'lost', seen), stub(thinking, false, 'answer', seen)]
    const chunks = []
    for await (const chunk of stall((signal) => starts[seen.length](signal), { after: 20, log })) chunks.push(chunk)
    expect(seen).toHaveLength(2)
    expect(seen[0].aborted).toBe(true)
    expect(log).toHaveBeenCalledWith('stalled after 20 ms, retried')
    expect(chunks.find((c) => c.type === 'block-end')).toEqual({ type: 'block-end', index: 0, block: { type: 'reasoning', text: 'hm' } })
    expect(chunks.filter((c) => c.type === 'block-start').map((c) => c.index)).toEqual([0, 1, 2])
    expect(chunks.find((c) => c.type === 'text-delta')).toEqual({ type: 'text-delta', index: 2, text: 'answer' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, stalled: true })
  })

  it('stalls after text: cut, not resent (the text is said), and the turn ends with the line', async () => {
    const seen = []
    const say = vi.fn()
    const said = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'half' }]
    const chunks = []
    for await (const chunk of stall((signal) => stub(said, true, 'rest', seen)(signal), { after: 20, say })) chunks.push(chunk)
    expect(seen).toHaveLength(1)
    expect(seen[0].aborted).toBe(true)
    expect(say).toHaveBeenCalledWith(SILENT_LINE, true)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: SILENT_LINE, code: SILENT_CODE } } })
  })

  /** A stream with no chunk for `delay` ms (until aborted), then an answer. */
  const silent = (delay, word, seen) =>
    async function* (signal) {
      seen.push(signal)
      await sleep(delay, signal)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: word }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }

  it('no first byte in stallMs, hedge included: both aborted, the whole request resent once with its own hedge', async () => {
    const seen = []
    const log = vi.fn()
    const starts = [silent(10_000, 'lost', seen), silent(10_000, 'lost too', seen), silent(0, 'answer', seen)]
    const once = (signal) => hedge((s) => starts[seen.length](s), { signal, after: 10, log })
    const chunks = []
    for await (const chunk of stall(once, { after: 40, log })) chunks.push(chunk)
    expect(seen).toHaveLength(3)
    expect(seen[0].aborted && seen[1].aborted).toBe(true)
    expect(log).toHaveBeenCalledWith('no first byte after 40 ms, resent')
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['answer'])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, stalled: true })
  })

  it('a first chunk inside stallMs: one request, no log', async () => {
    const seen = []
    const log = vi.fn()
    expect(await text(stall((signal) => silent(5, 'answer', seen)(signal), { after: 40, log }))).toBe('answer')
    expect(seen).toHaveLength(1)
    expect(log).not.toHaveBeenCalled()
  })

  it('only one resend: a resend with no first byte is cut too, and the turn ends with the line', async () => {
    const seen = []
    const log = vi.fn()
    const say = vi.fn()
    const chunks = []
    for await (const chunk of stall((signal) => silent(10_000, 'never', seen)(signal), { after: 20, log, say })) chunks.push(chunk)
    expect(seen).toHaveLength(2)
    expect(seen.every((s) => s.aborted)).toBe(true)
    expect(log.mock.calls.flat()).toEqual(['no first byte after 20 ms, resent', 'stalled after 20 ms on the resend, ended'])
    expect(say).toHaveBeenCalledWith(SILENT_LINE, true)
    expect(chunks.at(-1).reason.failure.code).toBe(SILENT_CODE)
  })

  it('runs 247 to 249: a blank "\\n" then silence is resent on `retry`, the blank block closed and the answer numbered after it', async () => {
    const seen = []
    const blank = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: '\n' }]
    const chunks = []
    const retry = (signal) => stub([], false, 'from the backup', seen)(signal)
    for await (const chunk of stall((signal) => stub(blank, true, 'lost', seen)(signal), { after: 20, retry })) chunks.push(chunk)
    expect(seen).toHaveLength(2)
    expect(seen[0].aborted).toBe(true)
    expect(chunks.find((c) => c.type === 'block-end')).toEqual({ type: 'block-end', index: 0, block: { type: 'text', text: '\n' } })
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => [c.index, c.text])).toEqual([[0, '\n'], [2, 'from the backup']])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' }, stalled: true })
  })

  it('run 249 T21: words that drip past the cap end with the line, however steady', async () => {
    const seen = []
    const say = vi.fn()
    const drip = async function* (signal) {
      seen.push(signal)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      for (;;) {
        await sleep(10, signal)
        yield { type: 'text-delta', index: 0, text: 'at 500 Hz ' }
      }
    }
    const started = Date.now()
    const chunks = []
    for await (const chunk of stall(drip, { after: 40, cap: 80, say })) chunks.push(chunk)
    expect(Date.now() - started).toBeLessThan(500)
    expect(seen).toHaveLength(1)
    expect(seen[0].aborted).toBe(true)
    expect(say).toHaveBeenCalledWith(SILENT_LINE, true)
    expect(chunks.at(-1).reason.failure.code).toBe(SILENT_CODE)
  })

  it('stallMs 0: a stream with no first byte for a while is not resent', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      await sleep(80)
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'late' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatAdapter({ baseUrl: 'http://route', model: 'm', resolveApiKey: async () => 'k', hedgeAfterMs: 0, stallMs: 0 })
    expect(await text(adapter.stream({ messages: [], sessionId: 's' }))).toBe('late')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('stallMs 0: off, one request however long it stalls', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) =>
      new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder()
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hm' } }] })}\n\n`))
            await sleep(80)
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'late' }, finish_reason: 'stop' }] })}\n\n`))
            controller.enqueue(enc.encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const adapter = new OpenAICompatAdapter({ baseUrl: 'http://route', model: 'm', resolveApiKey: async () => 'k', hedgeAfterMs: 0, stallMs: 0 })
    expect(await text(adapter.stream({ messages: [], sessionId: 's' }))).toBe('late')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
