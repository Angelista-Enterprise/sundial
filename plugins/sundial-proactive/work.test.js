import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefSubagent, ensureWorkAgent, installWorkLoop, jobPrompt, markRigDelegate, SANDBOX_USD_PER_JOB, shelvePayload, WORK_SESSION_ID } from './work.js'

/**
 * A job used to be a `followup` on the one persistent `gnomon-work` agent, so
 * job N carried jobs 1..N-1 in its context — that transcript had grown to
 * 656 KB, the second-largest session on the machine — and nothing could stop a
 * running job: `JOB_TIMEOUT_MS` closed the rule-side record while the turn kept
 * going. These tests hold the two properties that fixed those, and the fallback
 * that keeps a subagent-less profile working.
 */

const JOB = { id: 'job-1', kind: 'meeting-brief', subject: 'Standup', reason: 'starts in 19 min', detail: { attendees: ['Alex'] } }

/** A ctx with just the seams `installWorkLoop` touches. */
function fakeCtx({ subagents, reserve = async () => 'call-1' } = {}) {
  const handlers = new Map()
  const actors = new Map()
  const agent = { id: 'gnomon-work', status: 'running', inject: vi.fn(), followup: vi.fn() }
  const audits = []
  return {
    ctx: {
      tools: { register: vi.fn(() => () => {}) },
      agents: { get: () => agent, create: vi.fn(), resume: vi.fn() },
      agentDefaultModel: { currentSelection: () => ({ provider: 'tensorx', model: 'qwen/qwen3.8-flash-next' }) },
      gnomonKernel: {
        appendSignal: vi.fn(async () => {}),
        registerActor: (kind, actor) => (actors.set(kind, actor), () => actors.delete(kind)),
        openLlmAudit: async (row) => (audits.push(row), { id: row.id, settle: async () => {} }),
      },
      on: (event, handler) => handlers.set(event, handler),
      get: (name) => (name === 'subagents' ? subagents : undefined),
    },
    agent,
    handlers,
    audits,
    actors,
    // W3: the executor calls the `subagent` actor for StartSubagent, with its in-lane budget gate.
    notice: (job) => actors.get('subagent').start({ type: 'StartSubagent', job }, { reserve }),
  }
}

/** A subagents service that records the request and lets the test settle the run. */
function fakeSubagents() {
  const calls = []
  let settle
  const service = {
    calls,
    start: vi.fn(async (provider, request) => {
      calls.push({ provider, request })
      return {
        id: 'child-1',
        result: new Promise((resolve) => {
          settle = resolve
        }),
        dispose: vi.fn(),
      }
    }),
    finish: (stopReason = 'end_turn') => settle?.({ stopReason, output: [] }),
  }
  return service
}

describe('the work loop', () => {
  it('runs each job as its own child of the persistent work agent', async () => {
    const subagents = fakeSubagents()
    const { ctx, agent, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(subagents.calls).toHaveLength(1))

    const { provider, request } = subagents.calls[0]
    expect(provider).toBe('spawn')
    // The persistent agent is the PARENT — dsh requires one, and a child
    // composes its tools from the parent's ctx, which is how `gnomon_shelve`
    // and `gnomon_work_done` reach the job.
    expect(request.parent).toBe(agent)
    expect(request.label).toContain('Standup')
    expect(request.signal).toBeInstanceOf(AbortSignal)

    // The brief still reaches the job: the same text `jobContext`/`jobPrompt`
    // built, so KIND_BRIEFS stays the one source for what a job is asked to do.
    const text = request.prompt.map((block) => block.text).join('\n')
    expect(text).toContain('Job id: job-1')
    expect(text).toContain('gnomon_shelve')

    // And nothing is spoken into the parent's own transcript any more.
    expect(agent.followup).not.toHaveBeenCalled()
    expect(agent.inject).not.toHaveBeenCalled()
  })

  it('can stop a job — the thing nothing could do before', async () => {
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    const dispose = installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(subagents.calls).toHaveLength(1))
    const { signal } = subagents.calls[0].request
    expect(signal.aborted).toBe(false)

    dispose()

    // A reload used to leave children running against a plugin that no longer
    // existed to receive their results.
    expect(signal.aborted).toBe(true)
  })

  it('answers the executor with the child and its completion; Stop aborts it', async () => {
    const subagents = fakeSubagents()
    const { ctx, notice, actors } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })
    const started = await notice(JOB)
    expect(started.childId).toBe('child-1')
    const { signal } = subagents.calls[0].request
    await actors.get('subagent').stop({ type: 'StopSubagent', jobId: JOB.id })
    expect(signal.aborted).toBe(true)
    subagents.finish('aborted')
    await started.done
    // The close is the executor's to fold now, not the plugin's.
    expect(ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
  })

  it("names each child's route (the chat's default now), never the work agent's stale one, and a failed child says why", async () => {
    // On the record the work agent's last request was weeks old: every child inherited that route and died on its 401
    // in 3 to 5 s, closed as "the worker ended without reporting" with nothing more. Made-up route names.
    const subagents = fakeSubagents()
    const { ctx, notice, handlers } = fakeCtx({ subagents })
    ctx.gnomonKernel.getState = () => ({ config: { llm: { providers: [{ id: 'cloud-a', model: 'vendor/flash-1' }], use: {}, roles: { chat: ['cloud-a:vendor/flash-1'] } } } })
    installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })
    const started = await notice(JOB)
    expect(subagents.calls[0].request.agentOptions).toEqual({ provider: 'cloud-a', model: 'vendor/flash-1' })
    handlers.get('session/event')({ id: 'child-1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'Invalid API key.', code: 'AUTH', status: 401 } } } })
    subagents.finish('error')
    expect(await started.done).toBe('error: AUTH 401: Invalid API key.')
  })

  it('falls back to the work agent when the profile has no subagent provider', async () => {
    const { ctx, agent, notice } = fakeCtx({ subagents: undefined })
    installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(agent.followup).toHaveBeenCalled())

    expect(agent.inject).toHaveBeenCalled()
  })

  it('does not hold the channel while a twenty-minute job runs', async () => {
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home: '/home', cwd: '/ws', log: () => {}, warn: () => {} })

    // Two notices, and the second must not be waiting on the first's result.
    await notice(JOB)
    await notice({ ...JOB, id: 'job-2', subject: 'Retro' })
    await vi.waitFor(() => expect(subagents.calls).toHaveLength(2))

    subagents.finish()
  })
})

/**
 * `llm.roles.jobs: ['claude']`: the job runs on the owner's Claude Code. What it is GIVEN is
 * the read-only contract, so the argv is pinned; the result comes back as a
 * schema answer and must land through the same two signals a dsh child uses.
 */
describe('Claude hands', () => {
  const home = mkdtempSync(join(tmpdir(), 'hands-'))

  /** A spawn that records argv and answers with `stdout` (or dies with `code`). */
  function fakeSpawn(stdout, code = 0) {
    const calls = []
    const fn = vi.fn((cmd, args, opts) => {
      const call = { cmd, args, opts, prompt: '' }
      calls.push(call)
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = { end: (s) => (call.prompt = s) }
      child.kill = () => {}
      setImmediate(() => {
        if (opts.signal?.aborted) return child.emit('close', null, 'SIGINT')
        child.stdout.emit('data', Buffer.from(stdout))
        child.emit('close', code, null)
      })
      return child
    })
    fn.calls = calls
    return fn
  }
  // One `stream-json` result line, as `claude -p --output-format stream-json` ends.
  const envelope = (structured) => `${JSON.stringify({ type: 'result', is_error: false, subtype: 'success', total_cost_usd: 0.1, usage: { input_tokens: 4, output_tokens: 20 }, structured_output: structured })}\n`
  const hands = { llm: { sources: { claude: { path: '/bin/claude' } }, roles: { jobs: ['claude'] } }, jobs: { maxUsdPerJob: 0.5 } }

  it('gives Claude only the read-only tools and Sundial\'s MCP', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(spawnFn.calls).toHaveLength(1))
    const { cmd, args, opts, prompt } = spawnFn.calls[0]
    const flag = (name) => args[args.indexOf(name) + 1]
    expect(cmd).toBe('/bin/claude')
    expect(args).toContain('--strict-mcp-config')
    expect(JSON.parse(flag('--mcp-config')).mcpServers.sundial.env.SUNDIAL_HOME).toBe(home)
    expect(flag('--tools')).toBe('WebSearch,WebFetch')
    expect(flag('--permission-mode')).toBe('dontAsk')
    expect(flag('--setting-sources')).toBe('project')
    expect(flag('--max-budget-usd')).toBe('0.5')
    expect(opts.cwd).toBe(`${home}/.daemon/hands`)
    // The child gets no install variables (hardening S1): its MCP server has its home in --mcp-config.
    expect(opts.env.SUNDIAL_HOME).toBeUndefined()
    expect(opts.env.DSH_HOME).toBeUndefined()
    expect(opts.env.PATH).toBe(process.env.PATH)
    expect(args).toContain('-p')
    expect(prompt).toContain('Job id: job-1')
    expect(args).not.toContain('--bare')
    // Not the dsh child.
    expect(subagents.calls).toHaveLength(0)
  })

  it('gives a hand job the job\'s own time, not the runtime\'s three-minute one-shot default', async () => {
    // On the record every failed hand ran 180 s or more and every kept one under a minute: the default cut them.
    const seen = []
    const runtime = { id: 'claude', async *run(job) { seen.push(job); yield { type: 'done', output: '', structured: { outcome: 'nothing' } } }, authStatus: async () => ({ ok: true, detail: '' }), listModels: async () => [] }
    const { ctx, notice } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, runtimes: { claude: runtime }, log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0].timeoutMs).toBeGreaterThan(10 * 60 * 1000)
    expect(seen[0].timeoutMs).toBeLessThan(20 * 60 * 1000)
  })

  it('the morning packet stays on the work agent\'s own cheap route, never a Claude hand, and is told to read no mail', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })

    await notice({ id: 'job-2', kind: 'day-packet', subject: 'the morning packet for 2026-11-16', reason: 'your first touch of the day', detail: { day: '2026-11-16', leftOut: 'Mail and Messages are left out.' } })
    await vi.waitFor(() => expect(subagents.calls).toHaveLength(1))
    expect(spawnFn.calls).toHaveLength(0)
    const prompt = JSON.stringify(subagents.calls[0])
    expect(prompt).toContain('gnomon_pull_requests')
    expect(prompt).toContain('no mail, no messages')
  })

  it('shelves a shelved answer under the job id', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'shelved', title: 'Standup prep', body: 'Alex owes the review.', sources: ['gnomon_people'] }))
    const onShelved = vi.fn()
    const { ctx, notice } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, onShelved, log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalled())
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:shelved', { title: 'Standup prep', body: 'Alex owes the review.', sources: ['gnomon_people'], jobId: 'job-1' })
    expect(onShelved).toHaveBeenCalledWith('Standup prep')
  })

  it('closes "nothing" as nothing, and bad output as failed', async () => {
    for (const [stdout, outcome] of [[envelope({ outcome: 'nothing' }), 'nothing'], ['not json', 'failed'], [`${JSON.stringify({ type: 'result', is_error: true, subtype: 'error_max_budget_usd' })}\n`, 'failed']]) {
      const { ctx, notice } = fakeCtx({})
      installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn: fakeSpawn(stdout, 1), log: () => {}, warn: () => {} })
      await notice(JOB)
      await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalled())
      expect(ctx.gnomonKernel.appendSignal.mock.calls[0][0]).toBe('work:closed')
      expect(ctx.gnomonKernel.appendSignal.mock.calls[0][1]).toMatchObject({ jobId: 'job-1', outcome })
    }
  })

  it('can be stopped', async () => {
    const spawnFn = vi.fn((cmd, args, opts) => {
      const child = new EventEmitter()
      opts.signal.addEventListener('abort', () => child.emit('close', null))
      return child
    })
    const { ctx, notice } = fakeCtx({})
    const dispose = installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await notice(JOB)
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalled())
    dispose()
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:closed', expect.objectContaining({ jobId: 'job-1', outcome: 'failed' })))
  })

  it('W3: reserves a hand call first — its id is the audit row\'s — and a spent budget refuses the job', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const { ctx, notice, audits } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await notice(JOB)
    expect(audits).toMatchObject([{ id: 'call-1', purpose: 'hand', model: 'claude/default', route: 'claude' }])
    const spent = fakeCtx({ reserve: async () => null })
    installWorkLoop(spent.ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await expect(spent.notice(JOB)).rejects.toThrow(/hand budget is spent/)
    expect(spent.audits).toEqual([])
  })

  it('a limit on the first runtime moves the job to the next, one audit row each, chained', async () => {
    const limited = { id: 'copilot', run: async function* () { yield { type: 'error', kind: 'limit', message: 'copilot: quota exhausted' } }, authStatus: async () => ({ ok: true, detail: '' }), listModels: async () => [] }
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const { ctx, notice, audits } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', llm: { sources: { claude: { path: '/bin/claude' } }, roles: { jobs: ['copilot:gpt-5', 'claude'] } }, jobs: { maxUsdPerJob: 0.5 }, resolveClaudeFn: (p) => p, spawnFn, runtimes: { copilot: limited }, log: () => {}, warn: () => {} })
    await notice(JOB)
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:closed', expect.objectContaining({ jobId: 'job-1', outcome: 'nothing' })))
    expect(audits).toMatchObject([{ id: 'call-1', purpose: 'hand', model: 'copilot/gpt-5', route: 'copilot', access: 'runtime', attempt: 1 }, { purpose: 'hand', model: 'claude/default', route: 'claude', attempt: 2, parentCallId: 'call-1' }])
    expect(spawnFn.calls).toHaveLength(1)
  })

  // S4 (Fable H1, H2, M4): a rig chat's sandbox job.
  const BOXED = { id: 'job-rig-1', kind: 'owner-request', subject: 'crate sum 7', reason: 'you asked', detail: { brief: 'Work out 12 plus 30.' }, sandbox: 'session-rig' }

  it('a sandbox job runs prompt-only: no MCP, no web, no tools, a $0.25 cap, never the owner\'s hand budget; its rows carry the mark and nothing is pushed', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'shelved', title: 'Crate sum', body: '42', sources: [] }))
    const reserve = vi.fn(async () => 'call-1')
    const onShelved = vi.fn()
    const { ctx, actors } = fakeCtx({ reserve })
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: (p) => p, spawnFn, onShelved, log: () => {}, warn: () => {} })
    await actors.get('subagent').start({ type: 'StartSubagent', job: BOXED }, { reserve })
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalled())
    const { args, prompt } = spawnFn.calls[0]
    const flag = (name) => args[args.indexOf(name) + 1]
    expect(JSON.parse(flag('--mcp-config'))).toEqual({ mcpServers: {} })
    expect(args).not.toContain('--allowedTools')
    expect(flag('--tools')).toBe('')
    expect(flag('--max-budget-usd')).toBe(String(SANDBOX_USD_PER_JOB))
    expect(SANDBOX_USD_PER_JOB).toBe(0.25)
    expect(prompt).toMatch(/This is a test chat's job: you have no tools at all/)
    expect(reserve).not.toHaveBeenCalled()
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:shelved', { title: 'Crate sum', body: '42', sources: [], jobId: 'job-rig-1', sandbox: 'session-rig' })
    expect(onShelved).not.toHaveBeenCalled()
  })

  it('a sandbox job with no runtime is refused, never a dsh child that would inherit every tool and the owner\'s brief', async () => {
    const subagents = fakeSubagents()
    const { ctx, actors } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', resolveClaudeFn: () => null, log: () => {}, warn: () => {} })
    await expect(actors.get('subagent').start({ type: 'StartSubagent', job: BOXED }, {})).rejects.toThrow('a sandbox job needs a runtime')
    expect(subagents.calls).toHaveLength(0)
  })

  it('gnomon_shelve and gnomon_work_done on a job a sandbox holds carry its mark and push nothing; on the owner\'s, as before', async () => {
    const onShelved = vi.fn()
    const { ctx } = fakeCtx({})
    ctx.gnomonKernel.getState = () => ({ rigSessions: { 'session-rig': 't' }, sandbox: { 'session-rig': { workbench: { open: { id: 'job-rig-1' }, queue: [], recent: [] } } }, workbench: { open: { id: 'job-own' }, queue: [], recent: [] } })
    installWorkLoop(ctx, { home, cwd: '/ws', onShelved, log: () => {}, warn: () => {} })
    const tool = (name) => ctx.tools.register.mock.calls.map(([t]) => t).find((t) => t.name === name)
    await tool('gnomon_shelve').execute({ jobId: 'job-rig-1', title: 'Crate sum', body: '42' })
    await tool('gnomon_work_done').execute({ jobId: 'job-rig-1' })
    await tool('gnomon_shelve').execute({ jobId: 'job-own', title: 'Owner', body: 'x' })
    expect(ctx.gnomonKernel.appendSignal.mock.calls.map(([type, p]) => [type, p.jobId, p.sandbox ?? null])).toEqual([['work:shelved', 'job-rig-1', 'session-rig'], ['work:closed', 'job-rig-1', 'session-rig'], ['work:shelved', 'job-own', null]])
    expect(onShelved.mock.calls).toEqual([['Owner']])
  })

  it('stays on dsh when no claude binary is found', async () => {
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', ...hands, resolveClaudeFn: () => null, log: () => {}, warn: () => {} })
    await notice(JOB)
    await vi.waitFor(() => expect(subagents.calls).toHaveLength(1))
  })
})

describe('a helper the model starts is briefed once (W5)', () => {
  const setup = (parentSession) => {
    const child = { session: { header: { parentSession } }, inject: vi.fn() }
    const brief = vi.fn(async () => ({ text: 'Right now it is 10:00 on Tuesday. Mira Bakker works on puzzlebox-studio.', present: 'Right now: …' }))
    return { child, brief, ctx: { agents: { get: (id) => (id === 'child-1' ? child : undefined) }, gnomonKernel: { brief } } }
  }
  it('injects the brief into a model-started child, with no reply rules', async () => {
    const { child, brief, ctx } = setup('session-7f')
    expect(await briefSubagent(ctx, { id: 'child-1', local: true })).toBe(true)
    expect(brief).toHaveBeenCalledWith({ sessionId: 'child-1', cause: { kind: 'work' } })
    expect(child.inject).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(child.inject.mock.calls[0][0])).toContain('Mira Bakker works on puzzlebox-studio')
  })
  it('leaves Sundial\'s own jobs (briefed in their prompt) and remote children alone', async () => {
    const own = setup(WORK_SESSION_ID)
    expect(await briefSubagent(own.ctx, { id: 'child-1', local: true })).toBe(false)
    expect(own.child.inject).not.toHaveBeenCalled()
    const remote = setup('session-7f')
    expect(await briefSubagent(remote.ctx, { id: 'child-1', local: false })).toBe(false)
  })
})

describe('a helper a rig chat starts is a rig chat (Fable L7)', () => {
  const setup = (parentSession, rigSessions = { 'session-rig': 't' }) => {
    const appendSignal = vi.fn(async () => {})
    const child = { session: { header: { parentSession } } }
    return { appendSignal, ctx: { agents: { get: () => child }, gnomonKernel: { appendSignal, getState: () => ({ rigSessions }) } } }
  }
  it('appends one thread:delegate naming the child and its rig parent; nothing for the owner\'s chat or a remote helper', async () => {
    const rig = setup('session-rig')
    expect(await markRigDelegate(rig.ctx, { id: 'child-1', local: true })).toBe(true)
    expect(rig.appendSignal.mock.calls).toEqual([['thread:delegate', { sessionId: 'child-1', parent: 'session-rig' }]])
    const own = setup('session-own')
    expect(await markRigDelegate(own.ctx, { id: 'child-2', local: true })).toBe(false)
    expect(await markRigDelegate(rig.ctx, { id: 'child-3', local: false })).toBe(false)
    expect(own.appendSignal).not.toHaveBeenCalled()
  })
})

describe('ensureWorkAgent', () => {
  it('creates the work session once when two jobs start in the same tick', async () => {
    const agent = { id: WORK_SESSION_ID, status: 'idle' }
    const create = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); return { agent } })
    const ctx = { agents: { get: () => undefined, create, resume: vi.fn() }, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, gnomonKernel: { getState: () => ({ config: { llm: {} } }) }, get: () => undefined }
    const home = mkdtempSync(join(tmpdir(), 'work-'))
    const [a, b] = await Promise.all([ensureWorkAgent(ctx, { home, cwd: home }), ensureWorkAgent(ctx, { home, cwd: home })])
    expect(create).toHaveBeenCalledTimes(1)
    expect(a.agent).toBe(agent)
    expect(b.agent).toBe(agent)
  })
})

describe('a self-review job (Round 5)', () => {
  it('carries its one proposal back on the shelve, as a rule-idea carries its rule', () => {
    expect(shelvePayload({ title: 'Spotify: drop a route', body: 'It kept failing.', jobId: 'j1', review: '{"kind":"drop-route","routeKey":"play the album"}' })).toMatchObject({ jobId: 'j1', review: { kind: 'drop-route', routeKey: 'play the album' } })
    expect(shelvePayload({ title: 't', body: 'b' }).review).toBeUndefined()
    const text = jobPrompt({ id: 'j1', kind: 'self-review', subject: 'Spotify', detail: { failures: '3', cluster: 'not-found' } }).content[0].text
    expect(text).toMatch(/exactly ONE fix/)
    expect(text).toMatch(/gnomon_look with id "routes"/)
  })

  it('a review of replies that claimed an act never run reads the chat rows and proposes a note, not a route', () => {
    const text = jobPrompt({ id: 'j2', kind: 'self-review', subject: 'Gnomon', detail: { failures: '3', cluster: 'unbacked-claim' } }).content[0].text
    expect(text).toMatch(/said an act was done 3 times with no act in the turn/)
    expect(text).toMatch(/"kind":"app-note"/)
    expect(text).not.toMatch(/routes/)
  })
})
