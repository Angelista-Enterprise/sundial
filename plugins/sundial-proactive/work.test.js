import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { briefSubagent, installWorkLoop, WORK_SESSION_ID } from './work.js'

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
 * `hands.claude`: the job runs on the owner's Claude Code. What it is GIVEN is
 * the read-only contract, so the argv is pinned; the result comes back as a
 * schema answer and must land through the same two signals a dsh child uses.
 */
describe('Claude hands', () => {
  const home = mkdtempSync(join(tmpdir(), 'hands-'))

  /** A spawn that records argv and answers with `stdout` (or dies with `code`). */
  function fakeSpawn(stdout, code = 0) {
    const calls = []
    const fn = vi.fn((cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => {
        if (opts.signal?.aborted) return child.emit('close', null)
        child.stdout.emit('data', stdout)
        child.emit('close', code)
      })
      return child
    })
    fn.calls = calls
    return fn
  }
  const envelope = (structured) => JSON.stringify({ is_error: false, subtype: 'success', total_cost_usd: 0.1, usage: { input_tokens: 4, output_tokens: 20 }, structured_output: structured })
  const hands = { claude: true, claudePath: '/bin/claude', maxBudgetUsd: 0.5 }

  it('gives Claude only the read-only tools and Sundial\'s MCP', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(spawnFn.calls).toHaveLength(1))
    const { cmd, args, opts } = spawnFn.calls[0]
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
    expect(flag('-p')).toContain('Job id: job-1')
    // Not the dsh child.
    expect(subagents.calls).toHaveLength(0)
  })

  it('shelves a shelved answer under the job id', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'shelved', title: 'Standup prep', body: 'Alex owes the review.', sources: ['gnomon_people'] }))
    const onShelved = vi.fn()
    const { ctx, notice } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn, onShelved, log: () => {}, warn: () => {} })

    await notice(JOB)
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalled())
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:shelved', { title: 'Standup prep', body: 'Alex owes the review.', sources: ['gnomon_people'], jobId: 'job-1' })
    expect(onShelved).toHaveBeenCalledWith('Standup prep')
  })

  it('closes "nothing" as nothing, and bad output as failed', async () => {
    for (const [stdout, outcome] of [[envelope({ outcome: 'nothing' }), 'nothing'], ['not json', 'failed'], [JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' }), 'failed']]) {
      const { ctx, notice } = fakeCtx({})
      installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn: fakeSpawn(stdout, 1), log: () => {}, warn: () => {} })
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
    const dispose = installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await notice(JOB)
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalled())
    dispose()
    await vi.waitFor(() => expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('work:closed', expect.objectContaining({ jobId: 'job-1', outcome: 'failed' })))
  })

  it('W3: reserves a hand call first — its id is the audit row\'s — and a spent budget refuses the job', async () => {
    const spawnFn = fakeSpawn(envelope({ outcome: 'nothing' }))
    const { ctx, notice, audits } = fakeCtx({})
    installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await notice(JOB)
    expect(audits).toMatchObject([{ id: 'call-1', purpose: 'hand', model: 'claude-code' }])
    const spent = fakeCtx({ reserve: async () => null })
    installWorkLoop(spent.ctx, { home, cwd: '/ws', hands, resolveClaudeFn: (p) => p, spawnFn, log: () => {}, warn: () => {} })
    await expect(spent.notice(JOB)).rejects.toThrow(/hand budget is spent/)
    expect(spent.audits).toEqual([])
  })

  it('stays on dsh when no claude binary is found', async () => {
    const subagents = fakeSubagents()
    const { ctx, notice } = fakeCtx({ subagents })
    installWorkLoop(ctx, { home, cwd: '/ws', hands, resolveClaudeFn: () => null, log: () => {}, warn: () => {} })
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
