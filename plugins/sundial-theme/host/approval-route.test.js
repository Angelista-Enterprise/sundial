// W3: every approval on the record — asked, and answered by the owner, the
// timeout or the asker withdrawing. Round 2: what is open is the fold's, so a
// restart keeps it. Through a fake ctx whose kernel folds approvals as the live
// one does (approval-track.ts); made-up values only.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalTrack } from '../../../packages/rules/src/approval-track.ts'
import { finalAsk } from '../../sundial-actions/gate.js'
import { mountShell } from './server.js'

/** One mounted shell over `state`; a second harness over the same state is the shell after a restart. */
function harness(state = { ownerAsk: { open: null } }, { signedIn = true, agents = { get: () => undefined } } = {}) {
  const routes = new Map()
  const handlers = new Map()
  const appendSignal = vi.fn(async (type, payload) => {
    Object.assign(state, approvalTrack(state, { id: type, type, ts: new Date(Date.now()).toISOString(), payload }).state)
  })
  const ctx = {
    webServer: { register: (route) => routes.set(route.path, route) },
    provide: vi.fn(),
    connection: { requestRejection: () => (signedIn ? undefined : 401) },
    effect: (fn) => fn(),
    on: (event, handler) => (handlers.set(event, handler), () => {}),
    get: () => undefined,
    agents,
    agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'test' }), saveSelection: vi.fn(async () => {}) },
    sessionQuery: { readSession: () => Promise.reject(new Error('none')) },
    gnomonKernel: { getState: () => state, appendSignal },
  }
  mountShell(ctx, { cwd: '/tmp', home: mkdtempSync(join(tmpdir(), 'sundial-approval-')) })
  const ask = (reason = 'Run npm test') => handlers.get('approval/request')({ agent: { session: { id: 'session-7f' } }, toolName: 'gnomon_run_shell', callId: 'call-3', reason }, () => 'fell-through')
  const recorded = (type) => appendSignal.mock.calls.filter(([t]) => t === type).map(([, p]) => p)
  return { routes, ask, recorded, state, handlers }
}

function call(route, { method = 'POST', url = route.path, body } = {}) {
  const req = Object.assign(new EventEmitter(), { method, url, headers: {} })
  req[Symbol.asyncIterator] = async function* () {
    yield JSON.stringify(body ?? {})
  }
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn() })
  return Promise.resolve(route.handler(req, res)).then(() => ({ status: res.writeHead.mock.calls[0]?.[0], body: res.end.mock.calls[0]?.[0] }))
}
const post = (route, body) => call(route, { body })
const json = async (pending) => JSON.parse((await pending).body)
/** A browser on a thread's watch: the frames it was sent so far. */
function open(routes, session) {
  const req = Object.assign(new EventEmitter(), { method: 'GET', url: `/gnomon/api/watch?id=${session}`, headers: {} })
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, writeHead: vi.fn(), write: vi.fn(), end: vi.fn() })
  void routes.get('/gnomon/api/watch').handler(req, res)
  return () => res.write.mock.calls.map(([chunk]) => String(chunk)).filter((c) => c.startsWith('data: ')).map((c) => JSON.parse(c.slice(6)))
}
const listed = (routes, session) => json(call(routes.get('/gnomon/api/approvals'), { method: 'GET', url: `/gnomon/api/approvals${session ? `?session=${session}` : ''}` }))

afterEach(() => vi.useRealTimers())

describe('approvals on the record (W3)', () => {
  it('asked, then answered by the owner', async () => {
    const { routes, ask, recorded } = harness()
    const answer = ask()
    const [asked] = recorded('approval:asked')
    expect(asked).toEqual({ approvalId: expect.stringMatching(/^approval-/), sessionId: 'session-7f', tool: 'gnomon_run_shell', callId: 'call-3', text: 'Run npm test' })
    await post(routes.get('/gnomon/api/approve'), { id: asked.approvalId, outcome: 'allowed-once', by: 'owner' })
    expect(await answer).toBe('allowed-once')
    expect(recorded('approval:answered')).toEqual([{ approvalId: asked.approvalId, sessionId: 'session-7f', tool: 'gnomon_run_shell', answer: 'allowed-once', by: 'owner' }])
  })

  it('who answered is what the caller says, owner or rig; a missing or strange by is unknown (Round 3: only the owner earns the ladder)', async () => {
    const { routes, ask, recorded } = harness()
    for (const [i, by] of ['owner', 'rig', undefined, 'someone'].entries()) {
      const answer = ask()
      await post(routes.get('/gnomon/api/approve'), { id: recorded('approval:asked')[i].approvalId, outcome: 'allowed-once', ...(by ? { by } : {}) })
      await answer
    }
    expect(recorded('approval:answered').map((r) => r.by)).toEqual(['owner', 'rig', 'unknown', 'unknown'])
  })

  it('a bench answer off the bench install is refused and the ask stays open (bench-guard.js)', async () => {
    const { routes, ask, recorded, state } = harness()
    void ask()
    const [asked] = recorded('approval:asked')
    const said = await call(routes.get('/gnomon/api/approve'), { body: { id: asked.approvalId, outcome: 'allowed-once', by: 'bench' } })
    expect(said.status).toBe(403)
    expect(JSON.parse(said.body)).toMatchObject({ answered: false, refused: expect.stringMatching(/not dev\.sundial\.bench/) })
    expect(recorded('approval:answered')).toEqual([])
    expect(state.approvals.open.map((a) => a.id)).toEqual([asked.approvalId])
  })

  it('on the bench install a bench answer settles the ask, by bench', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'bench-home-'))
    const bench = join(home, '.sundial-bench')
    mkdirSync(bench)
    for (const [file, marker] of [['.sundial-install.json', { tool: 'sundial', installId: 'x' }], ['bench.json', { bench: true }]]) writeFileSync(join(bench, file), JSON.stringify({ ...marker, home: bench, label: 'dev.sundial.bench' }))
    const was = { HOME: process.env.HOME, SUNDIAL_HOME: process.env.SUNDIAL_HOME, SUNDIAL_LABEL: process.env.SUNDIAL_LABEL }
    Object.assign(process.env, { HOME: home, SUNDIAL_HOME: bench, SUNDIAL_LABEL: 'dev.sundial.bench' })
    try {
      const { routes, ask, recorded } = harness()
      const answer = ask()
      await post(routes.get('/gnomon/api/approve'), { id: recorded('approval:asked')[0].approvalId, outcome: 'allowed-once', by: 'bench' })
      expect(await answer).toBe('allowed-once')
      expect(recorded('approval:answered').map((r) => r.by)).toEqual(['bench'])
    } finally {
      for (const [key, value] of Object.entries(was)) value === undefined ? delete process.env[key] : (process.env[key] = value)
    }
  })

  it('the web client answers as the owner', async () => {
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(new URL('../shell/app.js', import.meta.url), 'utf8')).toMatch(/JSON\.stringify\(\{ id: frame\.id, outcome, by: 'owner' \}\)/)
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

describe('the open approvals are the fold\'s (Round 2)', () => {
  it('a final\'s ask is recorded as its step line and kind: never its To, Path or Command; the frame keeps them for the owner', async () => {
    const t = harness()
    const frames = open(t.routes, 'session-7f')
    const mailed = finalAsk({ kind: 'send', via: 'screen', blind: false, to: ['mira@example.com'] }, { line: 'Press "Send" in Zen' })
    const shelled = finalAsk({ kind: 'delete', via: 'shell', blind: false }, { command: 'rm /tmp/box-484/a.log' })
    void t.ask(mailed)
    void t.ask(shelled)
    expect(t.recorded('approval:asked').map(({ text, kind }) => ({ text, kind }))).toEqual([{ text: 'Press "Send" in Zen', kind: 'send' }, { text: undefined, kind: 'delete' }])
    expect(JSON.stringify([t.recorded('approval:asked'), t.state.approvals])).not.toMatch(/mira@example|To:|Command:|Path:|box-484/)
    expect(frames().filter((f) => f.type === 'approval').map((f) => f.reason)).toEqual([mailed, shelled])
  })

  it('a live ask replayed to a browser that opens later carries the full reason; the record and the fold still hold no To or Command', async () => {
    const t = harness()
    const shelled = finalAsk({ kind: 'delete', via: 'shell', blind: false }, { command: 'rm /tmp/box-484/a.log' })
    const mailed = finalAsk({ kind: 'send', via: 'screen', blind: false, to: ['mira@example.com'] }, { line: 'Press "Send" in Zen' })
    void t.ask(shelled)
    void t.ask(mailed)
    const replayed = open(t.routes, 'session-7f')().filter((f) => f.type === 'approval').map((f) => f.reason)
    expect(replayed).toEqual([shelled, mailed])
    expect(replayed[0]).toMatch(/Command: rm \/tmp\/box-484\/a\.log/)
    expect(replayed[0]).toMatch(/final: delete$/)
    expect((await listed(t.routes, 'session-7f')).open.map((a) => a.reason)).toEqual([shelled, mailed])
    expect(JSON.stringify([t.recorded('approval:asked'), t.state.approvals])).not.toMatch(/mira@example|To:|Command:|Path:|box-484/)
    // After a restart there is no resolver and no reason in memory: the step line from the fold, as before.
    const after = harness(t.state)
    expect(open(after.routes, 'session-7f')().filter((f) => f.type === 'approval').map((f) => f.reason)).toEqual([null, 'Press "Send" in Zen'])
  })

  it('run 204 T01: a shell ask carries the call\'s whole command, as the owner\'s card shows it, live and replayed; never on the record', async () => {
    const t = harness()
    const frames = open(t.routes, 'session-7f')
    const command = `python3 - <<'EOF'\nimport urllib.parse, subprocess\n${'x = 1\n'.repeat(40)}subprocess.run(["open", "obsidian://new?vault=Notes&file=" + urllib.parse.quote("Gnomon job box-484")])\nEOF`
    const events = [{ type: 'tool/call', data: { callId: 'call-3', name: 'gnomon_run_shell', arguments: JSON.stringify({ command }) } }]
    const reason = `Gnomon: 'run_shell' runs behind your approval. · Command: ${command.slice(0, 200)}…`
    void t.handlers.get('approval/request')({ agent: { session: { id: 'session-7f', snapshotEvents: () => events } }, toolName: 'gnomon_run_shell', callId: 'call-3', reason }, () => 'fell-through')
    expect(frames().find((f) => f.type === 'approval')).toMatchObject({ reason, command })
    expect((await listed(t.routes, 'session-7f')).open[0].command).toBe(command)
    expect(open(t.routes, 'session-7f')().find((f) => f.type === 'approval').command).toBe(command)
    expect(JSON.stringify([t.recorded('approval:asked'), t.state.approvals])).not.toMatch(/box-484|urllib/)
    // A call with no command (a screen act), or none in the events: no command on the frame.
    void t.ask()
    expect((await listed(t.routes, 'session-7f')).open[1]).not.toHaveProperty('command')
  })

  it('GET /gnomon/api/approvals lists a thread\'s open asks, and drops one once answered', async () => {
    const { routes, ask, recorded } = harness()
    void ask()
    const [{ approvalId }] = recorded('approval:asked')
    expect(await listed(routes, 'session-7f')).toEqual({ open: [{ type: 'approval', id: approvalId, toolName: 'gnomon_run_shell', callId: 'call-3', reason: 'Run npm test' }] })
    expect(await listed(routes, 'session-other')).toEqual({ open: [] })
    expect((await listed(routes)).open).toHaveLength(1)
    await post(routes.get('/gnomon/api/approve'), { id: approvalId, outcome: 'rejected' })
    expect(await listed(routes, 'session-7f')).toEqual({ open: [] })
  })

  it('after a restart an open ask is still listed and can be answered; nothing runs, and the record closes it', async () => {
    const before = harness()
    void before.ask()
    const [{ approvalId }] = before.recorded('approval:asked')
    // The shell again over the same record: its resolvers are gone, the fold is not.
    const after = harness(before.state)
    expect((await listed(after.routes, 'session-7f')).open.map((a) => a.id)).toEqual([approvalId])
    const frames = open(after.routes, 'session-7f')
    expect(await json(post(after.routes.get('/gnomon/api/approve'), { id: approvalId, outcome: 'allowed-once', by: 'owner' }))).toEqual({ answered: true, outcome: 'allowed-once', ran: false })
    // The card closes and says nothing ran.
    expect(frames().filter((f) => f.type.startsWith('approval'))).toEqual([{ type: 'approval', id: approvalId, toolName: 'gnomon_run_shell', callId: 'call-3', reason: 'Run npm test', dead: true }, { type: 'approval-closed', id: approvalId, outcome: 'allowed-once', ran: false }])
    expect(after.recorded('approval:answered')).toEqual([{ approvalId, sessionId: 'session-7f', tool: 'gnomon_run_shell', answer: 'allowed-once', by: 'owner' }])
    expect(await listed(after.routes, 'session-7f')).toEqual({ open: [] })
    expect(await json(post(after.routes.get('/gnomon/api/approve'), { id: approvalId, outcome: 'allowed-once' }))).toEqual({ answered: false })
  })

  it('an ask the restart orphaned expires cleanly, by the fold\'s clock', async () => {
    vi.useFakeTimers()
    const before = harness()
    void before.ask()
    const after = harness(before.state)
    vi.advanceTimersByTime(361_000)
    expect(await listed(after.routes, 'session-7f')).toEqual({ open: [] })
  })

  it('the approvals view sits behind the fence', async () => {
    const { routes } = harness(undefined, { signedIn: false })
    const out = await call(routes.get('/gnomon/api/approvals'), { method: 'GET' })
    expect(out.status).toBe(401)
    expect(out.body).toMatch(/sign in/)
  })
})

describe('a model that cannot be reached (Set 2 R4)', () => {
  it('its line reaches the watching thread as one mark per call, failed when it is the end', () => {
    const t = harness()
    const frames = open(t.routes, 'session-7f')
    const say = t.handlers.get('gnomon/llm-line')
    say({ sessionId: 'session-7f', key: 'session-7f:1', line: 'The model is not answering; trying the backup.', failed: false })
    say({ sessionId: 'session-7f', key: 'session-7f:1', line: 'No model is answering right now; try again in a minute.', failed: true })
    say({ sessionId: 'session-other', key: 'x', line: 'not this thread', failed: false })
    expect(frames().filter((f) => f.type === 'mark')).toEqual([
      { type: 'mark', key: 'llm:session-7f:1', label: 'The model is not answering; trying the backup.', failed: false },
      { type: 'mark', key: 'llm:session-7f:1', label: 'No model is answering right now; try again in a minute.', failed: true },
    ])
  })
})

describe('a thread\'s model on the record', () => {
  it('setting a thread\'s model appends thread:model; the default does not', async () => {
    const agent = { status: 'idle' }
    const t = harness(undefined, { agents: { get: () => undefined, resume: async () => ({ agent }) } })
    await post(t.routes.get('/gnomon/api/model'), { sessionId: 'session-7f', provider: 'openai', model: 'test-2' })
    expect(t.recorded('thread:model')).toEqual([{ sessionId: 'session-7f', provider: 'openai', model: 'test-2' }])
    await post(t.routes.get('/gnomon/api/model'), { provider: 'openai', model: 'test-3' })
    expect(t.recorded('thread:model')).toHaveLength(1)
  })

  it('the rig says by: rig and its row carries rig: true; anything else carries nothing', async () => {
    const agent = { status: 'idle' }
    const t = harness(undefined, { agents: { get: () => undefined, resume: async () => ({ agent }) } })
    await post(t.routes.get('/gnomon/api/model'), { sessionId: 'session-rig', provider: 'openai', model: 'test-2', by: 'rig' })
    await post(t.routes.get('/gnomon/api/model'), { sessionId: 'session-own', provider: 'openai', model: 'test-2', by: 'owner' })
    expect(t.recorded('thread:model')).toEqual([
      { sessionId: 'session-rig', provider: 'openai', model: 'test-2', rig: true },
      { sessionId: 'session-own', provider: 'openai', model: 'test-2' },
    ])
  })
})
