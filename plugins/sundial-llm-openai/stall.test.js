import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { apply, fallbackLine, HEDGE_LINES, SILENT_CODE, SILENT_LINE } from './index.js'
import { slowStatus } from './stall.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sse = (delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

/** Runs 247 to 249 on the wire: one "\n" at once, then nothing until the request is aborted. */
const hung = (init) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse({ content: '\n' })))
          init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        },
      }),
      { status: 200 },
    ),
  )
const answers = (word, delay = 0) => sleep(delay).then(() => new Response(`${sse({ content: word })}data: [DONE]\n\n`, { status: 200 }))

function mount(providers, facts, { db, ...config } = {}) {
  const routes = {}
  const rows = []
  const lines = []
  apply(
    {
      llm: { registerAdapter: (ids, adapter) => (routes[ids[0]] = adapter) },
      get: (name) => (name === 'gnomonKernel' ? { appendSignal: async (type, payload) => rows.push([type, payload]) } : name === 'gnomonDb' ? db : undefined),
      emit: (event, payload) => event === 'gnomon/llm-line' && lines.push(payload.line),
    },
    { envFile: '/nonexistent/.env', runtimeRoutes: [], chatRoles: [], providers, ...config },
  )
  for (const adapter of Object.values(routes)) Object.assign(adapter.facts, facts)
  return { routes, rows, lines }
}
const two = [
  { id: 'main', baseUrl: 'http://main', model: 'fast', hedgeTo: 'backup' },
  { id: 'backup', baseUrl: 'http://backup', model: 'slow' },
]
const chat = async (adapter, model = 'fast') => {
  const chunks = []
  for await (const chunk of adapter.stream({ model, messages: [], sessionId: 'session-1' })) chunks.push(chunk)
  return chunks
}
const said = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

describe('a chat call that hangs after a blank token (runs 247 to 249)', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is cut after stallMs, its request aborted, and resent once on the backup route, filed under it', async () => {
    const signals = []
    const fetchMock = vi.fn((url, init) => (signals.push(init.signal), new URL(url).host === 'main' ? hung(init) : answers('from the backup')))
    vi.stubGlobal('fetch', fetchMock)
    const { routes, rows, lines } = mount(two, { hedgeAfterMs: 0, stallMs: 40 })
    const started = Date.now()
    const chunks = await chat(routes.main)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(said(chunks).trim()).toBe('from the backup')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://main/chat/completions', 'http://backup/chat/completions'])
    expect(signals[0].aborted).toBe(true)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', stalled: true, fellBack: { route: 'backup', model: 'slow' } })
    expect(rows).toContainEqual(['llm:fallback', { from: 'main', to: 'backup', reason: 'stalled', sessionId: 'session-1' }])
    expect(lines).toContain(fallbackLine('backup'))
  })

  it('the backup hangs too: the turn ends with the line and a code dsh does not retry, within the two stall windows', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => hung(init)))
    const { routes, lines } = mount(two, { hedgeAfterMs: 0, stallMs: 40 })
    const started = Date.now()
    const chunks = await chat(routes.main)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: SILENT_LINE, code: SILENT_CODE } } })
    expect(lines.at(-1)).toBe(SILENT_LINE)
  })
})

describe('a slow call shows its wait (owner, 2026-11-17)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('after `after` ms with no word: the wait line, again every few ms; the hedge names the backup; the first word says how long', async () => {
    const lines = []
    const status = slowStatus({ say: (line) => lines.push(line), after: 30, every: 30 })
    const chunks = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '\n' }
      await sleep(45)
      status.hedged('backup')
      await sleep(40)
      yield { type: 'text-delta', index: 0, text: 'here' }
      await sleep(10)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    for await (const _ of status.pass(chunks())) void _
    expect(lines).toEqual([
      'The model is slow, waiting… (0 s)',
      HEDGE_LINES.backup,
      'The model is slow, trying the backup model… (0 s)',
      'The model answered after 0 s.',
    ])
  })

  it('a call that answers in time says nothing', async () => {
    const lines = []
    const status = slowStatus({ say: (line) => lines.push(line), after: 50 })
    const chunks = async function* () {
      yield { type: 'text-delta', index: 0, text: 'quick' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    for await (const _ of status.pass(chunks())) void _
    await sleep(80)
    expect(lines).toEqual([])
  })

  it('on the chat route: a slow first token shows the wait, then the hedge, on the turn', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn((url) => (new URL(url).host === 'main' ? answers('late', 500) : answers('from the backup', 60))))
    const { routes, lines } = mount(two, { hedgeAfterMs: 40, stallMs: 0, slowStatusMs: 20 })
    expect(said(await chat(routes.main))).toBe('from the backup')
    expect(lines.slice(0, 2)).toEqual(['The model is slow, waiting… (0 s)', HEDGE_LINES.backup])
    expect(lines.at(-1)).toMatch(/^The model answered after \d+ s\.$/)
    vi.restoreAllMocks()
  })
})

describe('a Stop during a hung model call (run 248 T18)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('ends the call within 2 s, its read cancelled, even when the body never heeds the abort', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cancelled = []
    // A body deaf to the request's abort: one "\n", then nothing, ever, unless the reader cancels it.
    const deaf = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode(sse({ content: '\n' }))),
            cancel: (why) => void cancelled.push(why),
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', vi.fn(deaf))
    const { routes } = mount(two, { hedgeAfterMs: 8000, stallMs: 20000 })
    const stop = new AbortController()
    const started = Date.now()
    const done = (async () => {
      for await (const _ of routes.main.stream({ model: 'fast', messages: [], sessionId: 'session-1', signal: stop.signal })) void _
    })()
    await sleep(100)
    stop.abort()
    await expect(done).rejects.toMatchObject({ code: 'ABORTED' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(cancelled).toHaveLength(1)
  })
})

/** Run 250 T04 and T19 on the wire: `first` deltas at once, then `thought` every 5 ms until the request is aborted. */
const thinking = (init, first, thought) =>
  Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder()
          for (const d of first) controller.enqueue(enc.encode(sse(d)))
          const timer = setInterval(() => controller.enqueue(enc.encode(sse(thought))), 5)
          init.signal?.addEventListener('abort', () => (clearInterval(timer), controller.error(new DOMException('aborted', 'AbortError'))), { once: true })
        },
      }),
      { status: 200 },
    ),
  )

describe('a hidden thought is not an answer (run 250, doc 30)', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('text the think-tag strip holds, past thinkMs: cut and resent once on the backup, though a chunk came every 5 ms', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => (new URL(url).host === 'main' ? thinking(init, [{ content: '\n<think>' }], { content: 'hmm ' }) : answers('from the backup'))))
    const { routes, rows } = mount(two, { hedgeAfterMs: 0, stallMs: 5000, thinkMs: 80 })
    const started = Date.now()
    const chunks = await chat(routes.main)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(said(chunks).trim()).toBe('from the backup')
    expect(said(chunks)).not.toMatch(/think|hmm|garbled/i)
    expect(rows).toContainEqual(['llm:fallback', { from: 'main', to: 'backup', reason: 'stalled', sessionId: 'session-1' }])
  })

  it('reasoning alone, past thinkMs: the same', async () => {
    vi.stubGlobal('fetch', vi.fn((url, init) => (new URL(url).host === 'main' ? thinking(init, [], { reasoning_content: 'hmm ' }) : answers('from the backup'))))
    const { routes } = mount(two, { hedgeAfterMs: 0, stallMs: 5000, thinkMs: 80 })
    const started = Date.now()
    expect(said(await chat(routes.main)).trim()).toBe('from the backup')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('a whole tool call, then a hidden thought (T04, T19): ended with the line at thinkMs, not at the cap', async () => {
    const call = { tool_calls: [{ index: 0, id: 'k1', function: { name: 'gnomon_skill', arguments: '{"name":"r1"}' } }] }
    vi.stubGlobal('fetch', vi.fn((_url, init) => thinking(init, [call, { content: '\n<think>' }], { content: 'hmm ' })))
    const { routes, lines } = mount(two, { hedgeAfterMs: 0, stallMs: 5000, thinkMs: 80, callCapMs: 60000 })
    const started = Date.now()
    const chunks = await chat(routes.main)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure: { message: SILENT_LINE, code: SILENT_CODE } } })
    expect(lines.at(-1)).toBe(SILENT_LINE)
  })

  it('a short thought, then the answer: no cut, the answer said without the thought', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            async start(controller) {
              const enc = new TextEncoder()
              controller.enqueue(enc.encode(sse({ content: '<think>' }) + sse({ content: 'a few' })))
              await sleep(40)
              controller.enqueue(enc.encode(`${sse({ content: ' thoughts</think>' })}${sse({ content: 'The answer.' })}data: [DONE]\n\n`))
              controller.close()
            },
          }),
          { status: 200 },
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { routes } = mount(two, { hedgeAfterMs: 0, stallMs: 5000, thinkMs: 80 })
    expect(said(await chat(routes.main))).toBe('The answer.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the slow status counts a held thought and reasoning as no word', async () => {
    const lines = []
    const status = slowStatus({ say: (line) => lines.push(line), after: 30, every: 1000 })
    const chunks = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '\n<think>' }
      for (let i = 0; i < 10; i++) {
        await sleep(5)
        yield { type: 'text-delta', index: 0, text: 'hmm ' }
      }
      yield { type: 'reasoning-delta', index: 1, text: 'more' }
      await sleep(10)
      yield { type: 'text-delta', index: 0, text: '</think>Here.' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    for await (const _ of status.pass(chunks())) void _
    expect(lines).toEqual(['The model is slow, waiting… (0 s)', 'The model answered after 0 s.'])
  })
})

/** Run 256 T21 (doc 31, answer 3): a fallback call ran 177 s of hidden thought with no stall watch, thought limit or cap. */
describe('every path of a chat call is watched (run 256 T21)', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
  const call = { tool_calls: [{ index: 0, id: 'k1', function: { name: 'gnomon_skill', arguments: '{"name":"r1"}' } }] }
  /** A tool call at once, then hidden thought every 5 ms, never an end. */
  const thinks = (init) => thinking(init, [call, { content: '\n<think>' }], { content: 'hmm ' })
  /** Shown words every 5 ms, never an end: only the cap ends it. */
  const drips = (init) => thinking(init, [], { content: 'word ' })
  const hosts = (map) => vi.fn((url, init) => map[new URL(url).host](init))
  const facts = { hedgeAfterMs: 0, stallMs: 5000, thinkMs: 80, callCapMs: 60000 }
  const SILENT_END = { type: 'finish', reason: { kind: 'error', failure: { message: SILENT_LINE, code: SILENT_CODE } } }
  const ended = async (adapter, model) => {
    const started = Date.now()
    const chunks = await chat(adapter, model)
    return { ms: Date.now() - started, last: chunks.at(-1) }
  }
  /** The pace switch's ledger: `main` at twice its usual pace, so the call goes to its backup (pace.js). */
  const slowLedger = () => {
    const now = Date.now(), at = (ms) => new Date(ms).toISOString()
    const rows = [...Array.from({ length: 30 }, (_, i) => [now - 3600_000 - i * 20_000, 34]), ...Array.from({ length: 8 }, (_, i) => [now - i * 20_000, 69])]
      .sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ requestedAt: at(t), latencyMs: p * 25, promptTokens: 25_000 }))
    return { queries: { getRoutePace: async (route) => (route === 'main' ? rows : []), getSignalsInRange: async () => [] } }
  }
  const paced = () => ({ db: slowLedger(), chatRoles: ['main', 'backup'] })
  const plain = two.map((p) => ({ ...p, hedgeTo: undefined }))

  it('the route itself: ended at thinkMs', { timeout: 3000 }, async () => {
    vi.stubGlobal('fetch', hosts({ main: thinks }))
    const { routes } = mount(plain, facts)
    const { ms, last } = await ended(routes.main)
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
  })

  it('the hedge: the backup it raced wins, then thinks: ended at thinkMs', { timeout: 3000 }, async () => {
    const silent = (init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    vi.stubGlobal('fetch', hosts({ main: silent, backup: thinks }))
    const { routes } = mount(two, { ...facts, hedgeAfterMs: 20 })
    const { ms, last } = await ended(routes.main)
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
  })

  it('the backup of a slow route (the pace switch): ended at thinkMs', { timeout: 3000 }, async () => {
    vi.stubGlobal('fetch', hosts({ main: drips, backup: thinks }))
    const { routes, rows } = mount(plain, facts, paced())
    const { ms, last } = await ended(routes.main)
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
    expect(rows.map(([type, p]) => [type, p.reason])).toContainEqual(['llm:fallback', 'slow'])
  })

  it('the fallback of a dead backup (run 256 T21): the route itself, ended at thinkMs', { timeout: 3000 }, async () => {
    const fetchMock = hosts({ main: thinks, backup: refused })
    vi.stubGlobal('fetch', fetchMock)
    const { routes, lines } = mount(plain, facts, paced())
    const { ms, last } = await ended(routes.main)
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).host)).toEqual(['backup', 'main'])
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
    expect(lines.at(-1)).toBe(SILENT_LINE)
  })

  it('the fallback of a dead backup: shown words past callCapMs end at the cap', { timeout: 3000 }, async () => {
    vi.stubGlobal('fetch', hosts({ main: drips, backup: refused }))
    const { routes } = mount(plain, { ...facts, callCapMs: 200 }, paced())
    const { ms, last } = await ended(routes.main)
    expect([ms >= 200 && ms < 1000, last]).toEqual([true, SILENT_END])
  })

  it('the backup of a dead route: ended at thinkMs', { timeout: 3000 }, async () => {
    vi.stubGlobal('fetch', hosts({ main: refused, backup: thinks }))
    const { routes } = mount(plain, facts, { chatRoles: ['main', 'backup'] })
    const { ms, last } = await ended(routes.main)
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
  })

  it('the backup of a dead route, silent after a blank token: cut at stallMs, resent once, ended', { timeout: 3000 }, async () => {
    const fetchMock = hosts({ main: refused, backup: hung })
    vi.stubGlobal('fetch', fetchMock)
    const { routes } = mount(plain, { ...facts, stallMs: 40 }, { chatRoles: ['main', 'backup'] })
    const { ms, last } = await ended(routes.main)
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).host)).toEqual(['main', 'backup', 'backup'])
  })

  it('doc 31: each firing is one llm:stalled row with its reason, so a bench can count the thought limit and the cap', { timeout: 3000 }, async () => {
    const stalled = (rows) => rows.filter(([type]) => type === 'llm:stalled').map(([, p]) => p)
    vi.stubGlobal('fetch', hosts({ main: thinks, backup: refused }))
    const thought = mount(plain, facts, paced())
    await chat(thought.routes.main)
    expect(stalled(thought.rows)).toEqual([{ route: 'backup', reason: 'thought', then: 'ended', limitMs: 80, sessionId: 'session-1' }])
    vi.stubGlobal('fetch', hosts({ main: drips, backup: refused }))
    const capped = mount(plain, { ...facts, callCapMs: 200 }, paced())
    await chat(capped.routes.main)
    expect(stalled(capped.rows)).toEqual([{ route: 'backup', reason: 'cap', then: 'ended', limitMs: 200, sessionId: 'session-1' }])
    vi.stubGlobal('fetch', hosts({ main: refused, backup: hung }))
    const silent = mount(plain, { ...facts, stallMs: 40 }, { chatRoles: ['main', 'backup'] })
    await chat(silent.routes.main)
    expect(stalled(silent.rows).map((p) => [p.route, p.reason, p.then, p.limitMs])).toEqual([['main', 'stall', 'resent', 40], ['main', 'stall', 'ended', 40]])
    vi.stubGlobal('fetch', hosts({ main: () => answers('quick') }))
    const quick = mount(plain, facts)
    await chat(quick.routes.main)
    expect(stalled(quick.rows)).toEqual([])
  })

  it("the rig's offline route: its fallback, Gnomon's own route, ended at thinkMs", { timeout: 3000 }, async () => {
    vi.stubGlobal('fetch', hosts({ '127.0.0.1:9': refused, own: thinks }))
    const { routes } = mount([], facts, { baseUrl: 'http://own', model: 'own-model', rigOffline: true })
    const { ms, last } = await ended(routes['rig-offline'], 'offline')
    expect([ms < 1000, last]).toEqual([true, SILENT_END])
  })
})
