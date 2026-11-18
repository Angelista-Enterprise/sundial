import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { answeredLine, apply, CONNECT_MS, fallbackLine, NO_MODEL_LINE, noBackupLine, RIG_OFFLINE } from './index.js'
import { PACE, SLOW_LINE } from './pace.js'

/** A fake transport, no network: per host, refused at once, never answering (until aborted), or a one-word answer. */
const refused = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }))
const silent = (init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
const answers = (word) =>
  Promise.resolve(
    new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: word }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 }),
  )
const transport = (hosts) => vi.fn((url, init) => hosts[new URL(url).host](init))

/** Mount the plugin with fake routes; collect the rows it appends and the lines it says. */
function mount(config, db) {
  const routes = {}
  const rows = []
  const lines = []
  const ctx = {
    llm: { registerAdapter: (ids, adapter) => (routes[ids[0]] = adapter) },
    get: (name) => (name === 'gnomonKernel' ? { appendSignal: async (type, payload) => rows.push([type, payload]) } : name === 'gnomonDb' ? db : undefined),
    emit: (event, payload) => event === 'gnomon/llm-line' && lines.push(payload),
  }
  apply(ctx, { envFile: '/nonexistent/.env', runtimeRoutes: [], chatRoles: [], providers: [], ...config })
  return { routes, rows, lines }
}

const two = [
  { id: 'main', baseUrl: 'http://main', model: 'fast' },
  { id: 'backup', baseUrl: 'http://backup', model: 'slow' },
]

const chat = async (adapter, model, seen = []) => {
  let out = ''
  for await (const chunk of adapter.stream({ model, messages: [], sessionId: 'session-1' })) {
    seen.push(chunk)
    if (chunk.type === 'text-delta') out += chunk.text
  }
  return out
}

describe('a chat route that cannot be reached', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('refused: falls to the next route in roles.chat at once, with llm:failed and llm:fallback, and says so in the turn', async () => {
    const fetchMock = transport({ main: refused, backup: () => answers('from backup') })
    vi.stubGlobal('fetch', fetchMock)
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] })
    const started = Date.now()
    const seen = []
    expect(await chat(routes.main, 'fast', seen)).toBe('from backup')
    // The ledger files it under the route that answered, so the dead one's streak keeps counting.
    expect(seen.at(-1)).toMatchObject({ type: 'finish', fellBack: { route: 'backup', model: 'slow' } })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://main/chat/completions', 'http://backup/chat/completions'])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('slow')
    expect(rows).toEqual([
      ['llm:failed', { route: 'main', reason: 'refused', errorClass: 'network', sessionId: 'session-1' }],
      ['llm:fallback', { from: 'main', to: 'backup:slow', sessionId: 'session-1' }],
    ])
    // Set 4 R2: the line names the backup route, then that it answered, on the same mark (one key per call).
    expect(lines).toEqual([{ sessionId: 'session-1', key: expect.stringMatching(/^session-1:/), line: 'The model is not answering; trying the backup, backup.', failed: false }, { sessionId: 'session-1', key: lines[0].key, line: 'The backup, backup, answered.', failed: false }])
    expect([fallbackLine('backup'), answeredLine('backup')]).toEqual(lines.map((l) => l.line))
  })

  it('no response at all: the backup (hedgeTo) is asked inside 10 s, not after the stall retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = transport({ main: silent, backup: () => answers('from backup') })
    vi.stubGlobal('fetch', fetchMock)
    const { routes, rows } = mount({ providers: [{ ...two[0], hedgeTo: 'backup' }, two[1]] })
    const done = chat(routes.main, 'fast')
    await vi.advanceTimersByTimeAsync(CONNECT_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await done).toBe('from backup')
    expect(CONNECT_MS).toBeLessThan(10_000)
    expect(rows.map(([type, p]) => [type, p.reason ?? p.to])).toEqual([['llm:failed', 'timeout'], ['llm:fallback', 'backup']])
  })

  it('no backup: the honest line inside 15 s, and an error dsh does not retry, so the turn ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', transport({ main: silent }))
    const { routes, rows, lines } = mount({ providers: two.slice(0, 1) })
    const done = chat(routes.main, 'fast').catch((error) => error)
    await vi.advanceTimersByTimeAsync(CONNECT_MS)
    const error = await done
    expect(CONNECT_MS).toBeLessThan(15_000)
    expect([error.message, error.code]).toEqual([NO_MODEL_LINE, 'UNREACHABLE'])
    expect(lines.map((l) => [l.line, l.failed])).toEqual([[NO_MODEL_LINE, true]])
    expect(rows.map(([type]) => type)).toEqual(['llm:failed'])
  })

  it('llm.connectMs gives a slow-but-healthy provider more time before the fallback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const fetchMock = transport({ main: silent, backup: () => answers('from backup') })
    vi.stubGlobal('fetch', fetchMock)
    const { routes } = mount({ providers: two, chatRoles: ['main', 'backup'], connectMs: 15_000 })
    Object.assign(routes.main.facts, { hedgeAfterMs: 0, stallMs: 0 }) // a self-hedge before 15 s would resend to the same host first
    const done = chat(routes.main, 'fast')
    await vi.advanceTimersByTimeAsync(CONNECT_MS + 1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15_000 - CONNECT_MS - 1000)
    expect(await done).toBe('from backup')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('the backup unreachable too: one line per call, the honest end over the fallback, both routes failed, inside 15 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('fetch', transport({ main: refused, backup: silent }))
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] })
    const done = chat(routes.main, 'fast').catch((error) => error)
    await vi.advanceTimersByTimeAsync(CONNECT_MS)
    expect((await done).code).toBe('UNREACHABLE')
    expect(rows.map(([type, p]) => [type, p.route ?? p.to])).toEqual([['llm:failed', 'main'], ['llm:fallback', 'backup:slow'], ['llm:failed', 'backup']])
    expect(lines.map((l) => l.line)).toEqual([fallbackLine('backup'), noBackupLine('backup')])
    expect(lines.at(-1).line).toBe('No model is answering: the backup, backup, did not answer either. Try again in a minute.')
    expect(new Set(lines.map((l) => l.key)).size).toBe(1)
  })

  it('a route that answers at all is reachable: a 400 is no fallback, the status path as before', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    const { routes, rows } = mount({ providers: two, chatRoles: ['main', 'backup'] })
    await expect(chat(routes.main, 'fast')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([])
  })

  it('a background purpose has no connect deadline and no fallback', async () => {
    vi.stubGlobal('fetch', transport({ main: refused, backup: () => answers('no') }))
    const { routes, rows } = mount({ providers: two, chatRoles: ['main', 'backup'] })
    const stream = routes.main.stream({ model: 'fast', messages: [], sessionId: 's', purpose: 'session-title' })
    await expect((async () => { for await (const _ of stream); })()).rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(rows).toEqual([])
  })

  it('the chat notes fall to the chat\'s backup like a turn does, and say nothing in the turn', async () => {
    vi.stubGlobal('fetch', transport({ main: refused, backup: () => answers('the notes') }))
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] })
    let out = ''
    for await (const chunk of routes.main.stream({ model: 'fast', messages: [], sessionId: 's', purpose: 'chat-notes' })) if (chunk.type === 'text-delta') out += chunk.text
    expect(out).toBe('the notes')
    expect(rows.map(([type, p]) => [type, p.route ?? p.to])).toEqual([['llm:failed', 'main'], ['llm:fallback', 'backup:slow']])
    expect(lines).toEqual([])
  })
})

describe('the rig route', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('exists only with experiments.rigOffline: a closed port that falls to Gnomon\'s own route', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const own = { baseUrl: 'http://own', model: 'own-model' }
    expect(Object.keys(mount(own).routes)).toEqual(['openai'])
    expect(Object.keys(mount({ ...own, rigOffline: false }).routes)).toEqual(['openai'])
    const { routes, rows } = mount({ ...own, rigOffline: true })
    expect(Object.keys(routes)).toEqual(['openai', RIG_OFFLINE.id])
    expect(RIG_OFFLINE).toEqual({ id: 'rig-offline', model: 'offline', baseUrl: 'http://127.0.0.1:9' })
    const fetchMock = transport({ '127.0.0.1:9': refused, own: () => answers('own answer') })
    vi.stubGlobal('fetch', fetchMock)
    expect(await chat(routes[RIG_OFFLINE.id], RIG_OFFLINE.model)).toBe('own answer')
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer rig-offline')
    expect(rows.map(([type, p]) => [type, p.route ?? p.to])).toEqual([['llm:failed', 'rig-offline'], ['llm:fallback', 'openai:own-model']])
  })
})

/** Set 4 R1: a route at over twice its own usual pace sends the next calls to its backup (pace.js), and says so once. */
describe('a chat route running slow', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const MIN = 60_000
  /** The ledger and the record the switch reads: 30 calls at 34 ms/k an hour ago, then 8 at `pace` up to now; `last` its newest switch row. */
  const ledger = (pace, last) => {
    const now = Date.now(), at = (ms) => new Date(ms).toISOString()
    const rows = [...Array.from({ length: 30 }, (_, i) => [now - 60 * MIN - i * 20_000, 34]), ...Array.from({ length: PACE.recent }, (_, i) => [now - i * 20_000, pace])]
      .sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ requestedAt: at(t), latencyMs: p * 25, promptTokens: 25_000 }))
    const asked = []
    return {
      asked,
      queries: {
        getRoutePace: async (...args) => (asked.push(args), args[0] === 'main' ? rows : []),
        getSignalsInRange: async () => (last ? [{ capturedAt: at(now - last.ago), data: { primary: 'main', reason: last.reason } }] : []),
      },
    }
  }

  it('slow: the call goes to the backup with llm:fallback reason slow, the quiet line, and the ledger files it there', async () => {
    const fetchMock = transport({ main: () => answers('from main'), backup: () => answers('from backup') })
    vi.stubGlobal('fetch', fetchMock)
    const db = ledger(69)
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    const seen = []
    expect(await chat(routes.main, 'fast', seen)).toBe('from backup')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://backup/chat/completions'])
    expect(seen.at(-1)).toMatchObject({ type: 'finish', fellBack: { route: 'backup', model: 'slow' } })
    expect(rows).toEqual([['llm:fallback', { from: 'main', to: 'backup:slow', reason: 'slow', primary: 'main', pace: 69, baseline: 34, sessionId: 'session-1' }]])
    expect(lines).toEqual([{ sessionId: 'session-1', key: expect.stringMatching(/^session-1:/), line: SLOW_LINE, failed: false }])
    // Its own calls, and the backup's newest (none here: a backup with no record is tried).
    expect(db.asked.map((a) => a.slice(0, 2))).toEqual([['main', 'main/fast'], ['backup', 'backup/slow']])
  })

  it('already switched: the backup again, said again on the slip (the owner sees who answers), nothing new written; usual pace, or no backup: the route itself', async () => {
    const fetchMock = transport({ main: () => answers('from main'), backup: () => answers('from backup') })
    vi.stubGlobal('fetch', fetchMock)
    const on = mount({ providers: two, chatRoles: ['main', 'backup'] }, ledger(69, { ago: MIN, reason: 'slow' }))
    expect(await chat(on.routes.main, 'fast')).toBe('from backup')
    expect(on.rows).toEqual([])
    expect(on.lines.map((l) => l.line)).toEqual([SLOW_LINE])
    const usual = mount({ providers: two, chatRoles: ['main', 'backup'] }, ledger(34))
    expect(await chat(usual.routes.main, 'fast')).toBe('from main')
    const alone = mount({ providers: two, chatRoles: [] }, ledger(69))
    expect(await chat(alone.routes.main, 'fast')).toBe('from main')
    expect([usual.rows, alone.rows]).toEqual([[], []])
  })

  it('reads the ledger once a turn: every step of it goes the same way, the switch written once and the line said each time', async () => {
    vi.stubGlobal('fetch', transport({ main: () => answers('from main'), backup: () => answers('from backup') }))
    const db = ledger(69)
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    const turn = (messages) => (async () => { let out = ''; for await (const c of routes.main.stream({ model: 'fast', messages, sessionId: 'session-1' })) if (c.type === 'text-delta') out += c.text; return out })()
    const owner = { role: 'user', content: [{ type: 'text', text: 'send the mail' }] }
    expect([await turn([owner]), await turn([owner, { role: 'assistant', content: [{ type: 'text', text: 'one step' }] }])]).toEqual(['from backup', 'from backup'])
    expect(db.asked).toHaveLength(2)
    expect(rows.map(([, p]) => p.reason)).toEqual(['slow'])
    expect(lines.map((l) => l.line)).toEqual([SLOW_LINE, SLOW_LINE])
    // The owner's next message is a new turn: read again.
    await turn([owner, owner])
    expect(db.asked).toHaveLength(4)
  })

  it('a probe is one call: the turn\'s next step reads the ledger again (run 214 T01 probed with all eight steps)', async () => {
    vi.stubGlobal('fetch', transport({ main: () => answers('from main'), backup: () => answers('from backup') }))
    // Switched three minutes ago, no call on the route since (its slow calls all came before): the next call probes it.
    const db = ledger(69, { ago: 3 * MIN, reason: 'slow' })
    const rows = await db.queries.getRoutePace('main')
    db.queries.getRoutePace = async (...args) => (db.asked.push(args), args[0] === 'main' ? rows.map((r) => ({ ...r, requestedAt: new Date(Date.parse(r.requestedAt) - 4 * MIN).toISOString() })) : [])
    db.asked.length = 0
    const { routes } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    const turn = (messages) => (async () => { let out = ''; for await (const c of routes.main.stream({ model: 'fast', messages, sessionId: 'session-1' })) if (c.type === 'text-delta') out += c.text; return out })()
    const owner = { role: 'user', content: [{ type: 'text', text: 'rename the files' }] }
    expect(await turn([owner])).toBe('from main')
    expect(db.asked).toHaveLength(2)
    await turn([owner, { role: 'assistant', content: [{ type: 'text', text: 'one step' }] }])
    expect(db.asked).toHaveLength(4)
  })

  it('the backup is asked as the route would be: a 503 is tried again', async () => {
    let n = 0
    const fetchMock = transport({ main: () => answers('from main'), backup: () => (n++ === 0 ? Promise.resolve(new Response('busy', { status: 503 })) : answers('from backup')) })
    vi.stubGlobal('fetch', fetchMock)
    const { routes } = mount({ providers: two, chatRoles: ['main', 'backup'] }, ledger(69))
    expect(await chat(routes.main, 'fast')).toBe('from backup')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['http://backup/chat/completions', 'http://backup/chat/completions'])
  })

  it('recovered: back on the route with llm:fallback reason recovered, said nowhere', async () => {
    vi.stubGlobal('fetch', transport({ main: () => answers('from main'), backup: () => answers('from backup') }))
    const db = ledger(34, { ago: 10 * MIN, reason: 'slow' })
    // The calls since the switch are the quick ones the probes made.
    const { routes, rows, lines } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    expect(await chat(routes.main, 'fast')).toBe('from main')
    expect(rows).toEqual([['llm:fallback', { from: 'backup:slow', to: 'main', reason: 'recovered', primary: 'main', pace: 34, baseline: 34, sessionId: 'session-1' }]])
    expect(lines).toEqual([])
  })

  it('doc 31: on the backup past backupMaxMs with slow probes, back on the route all the same, the row saying why', async () => {
    vi.stubGlobal('fetch', transport({ main: () => answers('from main'), backup: () => answers('from backup') }))
    const { routes, rows } = mount({ providers: two, chatRoles: ['main', 'backup'] }, ledger(69, { ago: PACE.backupMaxMs, reason: 'slow' }))
    expect(await chat(routes.main, 'fast')).toBe('from main')
    expect(rows).toEqual([['llm:fallback', expect.objectContaining({ from: 'backup:slow', to: 'main', reason: 'recovered', why: 'window', primary: 'main' })]])
  })

  it('doc 31: a long turn on the backup reads the ledger again after probeMs, so its own steps probe and come back', async () => {
    vi.stubGlobal('fetch', transport({ main: () => answers('from main'), backup: () => answers('from backup') }))
    const db = ledger(69, { ago: MIN, reason: 'slow' })
    const { routes } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    const owner = { role: 'user', content: [{ type: 'text', text: 'save the file' }] }
    const step = (n) => (async () => { let out = ''; for await (const c of routes.main.stream({ model: 'fast', messages: [owner, ...Array(n).fill({ role: 'assistant', content: [] })], sessionId: 'session-1' })) if (c.type === 'text-delta') out += c.text; return out })()
    expect(await step(0)).toBe('from backup')
    expect(await step(1)).toBe('from backup')
    expect(db.asked).toHaveLength(2)
    // Same turn, probeMs later, and the switch long enough ago: read again, and the window brings it back.
    routes.main.paceTurn.at -= PACE.probeMs
    db.queries.getSignalsInRange = async () => [{ capturedAt: new Date(Date.now() - PACE.backupMaxMs).toISOString(), data: { primary: 'main', reason: 'slow' } }]
    expect(await step(2)).toBe('from main')
    expect(db.asked).toHaveLength(4)
  })

  it('run 256 T21: a backup that cannot be reached ends the switch, with a recovered row, and the turn reads the ledger again', async () => {
    const fetchMock = transport({ main: () => answers('from main'), backup: refused })
    vi.stubGlobal('fetch', fetchMock)
    const db = ledger(69, { ago: MIN, reason: 'slow' })
    const { routes, rows } = mount({ providers: two, chatRoles: ['main', 'backup'] }, db)
    expect(await chat(routes.main, 'fast')).toBe('from main')
    expect(rows.map(([type, p]) => [type, p.reason ?? null, p.why ?? null])).toEqual([
      ['llm:failed', 'refused', null],
      ['llm:fallback', 'recovered', 'backup-down'],
      ['llm:fallback', null, null],
    ])
    expect(rows[1][1]).toMatchObject({ from: 'backup:slow', to: 'main', primary: 'main' })
    expect(routes.main.paceTurn).toBeNull()
  })
})
