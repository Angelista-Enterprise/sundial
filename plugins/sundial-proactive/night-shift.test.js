// lane E (#12): the night shift's hands, with a fake runner and a fake exec
// only. Nothing here starts tmux, git or Claude.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVING_MODES, NIGHT_SHIFT_CHANNEL, assertWorktree, claudeArgs, createTmuxRunner, installNightShift, worktreeFor } from './night-shift.js'
import { jobEnv } from './claude-hand.js'

const HOME = '/Users/mira/.sundial'
const JOB = { id: 'job-01ABC', repo: '~/Projects/puzzlebox-studio', subject: 'Fix the retry test', brief: 'Make BOX-484 pass.' }
const ON = { enabled: true, maxUsdPerJob: 2, maxUsdPerNight: 5, maxJobsPerNight: 2, maxMinutes: 90 }

function fakeCtx(open = { id: JOB.id, status: 'starting' }) {
  const handlers = []
  const state = { nightShift: { open, queue: [] }, project: { known: { '~/Projects/puzzlebox-studio': { name: 'puzzlebox-studio' } } } }
  const ctx = {
    tools: { register: vi.fn() },
    gnomonKernel: { appendSignal: vi.fn(async () => {}), getState: () => state },
    on: vi.fn((event, handler) => handlers.push([event, handler])),
  }
  const notice = async (payload) => {
    for (const [event, handler] of handlers) if (event === 'gnomon/notice') await handler({ channel: NIGHT_SHIFT_CHANNEL, payload })
  }
  return { ctx, state, notice }
}
const fakeRunner = () => ({
  start: vi.fn(() => ({ worktree: worktreeFor(HOME, 'ABC'), branch: 'night/ABC', base: 'a1b2c3' })),
  collect: vi.fn(() => ({ commits: 2, note: '2 files changed' })),
  stop: vi.fn(),
})
const quiet = { log: () => {}, warn: () => {} }

describe('night shift (#12): off by default', () => {
  it('off, it registers no tool, and a start reaches no runner', async () => {
    for (const jobs of [undefined, { ...ON, enabled: false }]) {
      const { ctx, notice } = fakeCtx()
      const runner = fakeRunner()
      installNightShift(ctx, { home: HOME, jobs, runner, ...quiet })
      await notice({ action: 'start', job: JOB, folder: 'ABC' })
      expect(ctx.tools.register).not.toHaveBeenCalled()
      expect(runner.start).not.toHaveBeenCalled()
      expect(ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
    }
  })
})

describe('night shift (#12): switched off with a job under way', () => {
  it('still stops it, so the tmux session is not orphaned', async () => {
    const { ctx, notice } = fakeCtx()
    const runner = fakeRunner()
    ctx.gnomonKernel.getState = () => ({ nightShift: { open: { ...JOB, status: 'stopping', worktree: worktreeFor(HOME, 'ABC'), base: 'a1b2c3' } } })
    installNightShift(ctx, { home: HOME, jobs: { ...ON, enabled: false }, runner, ...quiet })
    await notice({ action: 'stop', jobId: JOB.id })
    expect(runner.stop).toHaveBeenCalledWith('ABC')
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('job:finished', expect.objectContaining({ jobId: JOB.id, outcome: 'stopped' }))
  })
})

describe('night shift (#12): on, with a fake runner', () => {
  it('starts once per job, even when the start is delivered twice, and reports where', async () => {
    const { ctx, notice } = fakeCtx()
    const runner = fakeRunner()
    installNightShift(ctx, { home: HOME, jobs: ON, runner, ...quiet })
    expect(ctx.tools.register.mock.calls.map(([t]) => t.name)).toEqual(['gnomon_night_job', 'gnomon_night_job_stop'])
    await notice({ action: 'start', job: JOB, folder: 'ABC' })
    await notice({ action: 'start', job: JOB, folder: 'ABC' })
    expect(runner.start).toHaveBeenCalledTimes(1)
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('job:started', { jobId: JOB.id, worktree: worktreeFor(HOME, 'ABC'), branch: 'night/ABC', base: 'a1b2c3' })
  })

  it('a start the rule is not waiting for is ignored; a failed start is reported as failed', async () => {
    const idle = fakeCtx(null)
    const runner = fakeRunner()
    installNightShift(idle.ctx, { home: HOME, jobs: ON, runner, ...quiet })
    await idle.notice({ action: 'start', job: JOB, folder: 'ABC' })
    expect(runner.start).not.toHaveBeenCalled()
    const t = fakeCtx()
    const broken = { ...fakeRunner(), start: vi.fn(() => { throw new Error('not a git repository') }) }
    installNightShift(t.ctx, { home: HOME, jobs: ON, runner: broken, ...quiet })
    await t.notice({ action: 'start', job: JOB, folder: 'ABC' })
    expect(t.ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('job:finished', { jobId: JOB.id, outcome: 'failed', note: 'could not start: not a git repository' })
  })

  it('finish and stop end the session, collect the branch, and report once', async () => {
    const open = { id: JOB.id, status: 'finishing', worktree: '~/.sundial/night-shift/ABC', base: 'a1b2c3' }
    for (const [action, outcome] of [['finish', 'done'], ['stop', 'stopped']]) {
      const { ctx, notice } = fakeCtx(open)
      const runner = fakeRunner()
      installNightShift(ctx, { home: HOME, jobs: ON, runner, ...quiet })
      await notice({ action, jobId: JOB.id })
      expect(runner.stop).toHaveBeenCalledWith('ABC')
      expect(runner.collect).toHaveBeenCalledWith({ worktree: open.worktree, base: 'a1b2c3' })
      expect(ctx.gnomonKernel.appendSignal.mock.calls).toEqual([['job:finished', { jobId: JOB.id, outcome, commits: 2, note: '2 files changed' }]])
    }
  })

  it('the request tool queues for a known project only', async () => {
    const { ctx } = fakeCtx()
    installNightShift(ctx, { home: HOME, jobs: ON, runner: fakeRunner(), ...quiet })
    const tool = ctx.tools.register.mock.calls[0][0]
    await expect(tool.execute({ project: 'nowhere', subject: 's', brief: 'b' })).rejects.toThrow(/no project called/)
    await tool.execute({ project: 'Puzzlebox-Studio', subject: 'Fix the retry test', brief: 'Make it pass.' })
    expect(ctx.gnomonKernel.appendSignal).toHaveBeenCalledWith('job:requested', { repo: '~/Projects/puzzlebox-studio', subject: 'Fix the retry test', brief: 'Make it pass.' })
  })
})

describe('night shift (#12): what a job is allowed', () => {
  it('never approves: manual mode, project settings only, no push', () => {
    const args = claudeArgs(JOB)
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'manual'])
    for (const mode of APPROVING_MODES) expect(args).not.toContain(mode)
    expect(args.join(' ')).not.toMatch(/dangerously|skip-permissions|--allowedTools|--permission-prompt-tool/)
    expect(args).toContain('--disallowedTools=Bash(git push:*)')
    // The prompt is its own last argument, never a value of a many-valued flag.
    expect(args.at(-2)).toMatch(/^--disallowedTools=/)
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project')
  })

  it('runs only in its own folder under the data folder, never in or around the checkout', () => {
    const repo = '/Users/mira/Projects/puzzlebox-studio'
    expect(() => assertWorktree(repo, worktreeFor(HOME, 'ABC'), HOME)).not.toThrow()
    expect(() => assertWorktree(repo, repo, HOME)).toThrow(/night-shift/)
    expect(() => assertWorktree(repo, `${repo}/.claude/worktrees/x`, HOME)).toThrow()
    expect(() => assertWorktree(repo, `${HOME}/night-shift`, HOME)).toThrow()
    expect(() => assertWorktree(`${HOME}/night-shift/ABC/inner`, worktreeFor(HOME, 'ABC'), HOME)).toThrow(/overlaps/)
  })

  it('the tmux runner makes a worktree on a new branch and starts Claude in it, with the job id in its env', () => {
    const calls = []
    const exec = (cmd, args) => {
      calls.push([cmd, ...args])
      return cmd === 'git' && args.includes('rev-parse') ? 'a1b2c3\n' : ''
    }
    const home = mkdtempSync(join(tmpdir(), 'night-'))
    const runner = createTmuxRunner({ home, claudePath: '/opt/claude', exec })
    const where = runner.start({ job: { ...JOB, repo: '/Users/mira/Projects/puzzlebox-studio' }, folder: 'ABC' })
    expect(where).toEqual({ worktree: `${home}/night-shift/ABC`, branch: 'night/ABC', base: 'a1b2c3' })
    expect(calls[1]).toEqual(['git', '-C', '/Users/mira/Projects/puzzlebox-studio', 'worktree', 'add', '-b', 'night/ABC', `${home}/night-shift/ABC`, 'a1b2c3'])
    expect(calls[2].slice(0, 9)).toEqual(['tmux', 'new-session', '-d', '-s', 'sundial-night-ABC', '-c', `${home}/night-shift/ABC`, '-e', `SUNDIAL_JOB_ID=${JOB.id}`])
    // The pane runs Claude through `env -u`, so the install's variables never reach it, whatever the tmux server holds.
    const command = calls[2].slice(9)
    expect(command[0]).toBe('/usr/bin/env')
    for (const key of ['SUNDIAL_HOME', 'DSH_HOME', 'SUNDIAL_WEB_PORT', 'SUNDIAL_PHONE_PORT', 'SUNDIAL_CHROME_PORT', 'SUNDIAL_LABEL', 'SUNDIAL_INTERNAL_TOKEN', 'DATABASE_URL']) expect(command).toContain(key)
    expect(command).not.toContain('SUNDIAL_JOB_ID')
    // Every `-u` names a key, and Claude comes right after the list.
    expect(command[command.indexOf('/opt/claude') - 2]).toBe('-u')
    runner.stop('ABC')
    expect(calls.at(-1)).toEqual(['tmux', 'kill-session', '-t', 'sundial-night-ABC'])
    rmSync(home, { recursive: true, force: true })
  })
})

describe('a job never inherits the install (hardening S1)', () => {
  it('jobEnv drops the install variables and keeps the rest, the job id included', () => {
    const env = jobEnv({ SUNDIAL_HOME: '/Users/mira/.sundial', DSH_HOME: '/Users/mira/.sundial/dsh', SUNDIAL_WEB_PORT: '3080', SUNDIAL_PHONE_PORT: '8767', SUNDIAL_CHROME_PORT: '9222', SUNDIAL_LABEL: 'dev.sundial.daemon', SUNDIAL_JOB_ID: 'J1', PATH: '/usr/bin', HOME: '/Users/mira' })
    expect(env).toEqual({ SUNDIAL_JOB_ID: 'J1', PATH: '/usr/bin', HOME: '/Users/mira' })
  })

  it('the default tmux exec runs with that env', () => {
    // vitest sets SUNDIAL_HOME for every test run; a child of the job must not see it.
    expect(process.env.SUNDIAL_HOME).toBeTruthy()
    expect(jobEnv().SUNDIAL_HOME).toBeUndefined()
    // The guard-bypass token and any other install variable go too.
    expect(jobEnv({ SUNDIAL_INTERNAL_TOKEN: 't', SUNDIAL_APP: '1', DATABASE_URL: 'file:x', SUNDIAL_JOB_ID: 'J1' })).toEqual({ SUNDIAL_JOB_ID: 'J1' })
  })
})
