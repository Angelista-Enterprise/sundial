// lane E (#12): the night shift's hands, with a fake runner and a fake exec
// only. Nothing here starts tmux, git or Claude.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVING_MODES, assertWorktree, claudeArgs, createTmuxRunner, installNightShift, worktreeFor } from './night-shift.js'
import { jobEnv } from './claude-hand.js'

const HOME = '/Users/mira/.sundial'
const JOB = { id: 'job-01ABC', repo: '~/Projects/puzzlebox-studio', subject: 'Fix the retry test', brief: 'Make BOX-484 pass.' }
const ON = { enabled: true, maxUsdPerJob: 2, maxUsdPerNight: 5, maxJobsPerNight: 2, maxMinutes: 90 }

function fakeCtx(open = { id: JOB.id, status: 'starting' }) {
  const actors = new Map()
  const state = { nightShift: { open, queue: [] }, project: { known: { '~/Projects/puzzlebox-studio': { name: 'puzzlebox-studio' } } } }
  const ctx = {
    tools: { register: vi.fn() },
    gnomonKernel: { appendSignal: vi.fn(async () => {}), getState: () => state, registerActor: vi.fn((kind, actor) => (actors.set(kind, actor), () => actors.delete(kind))) },
  }
  // W3: the executor calls the `job` actor for StartJob / StopJob and folds what it returns.
  const job = () => actors.get('job')
  return { ctx, state, job }
}
const fakeRunner = () => ({
  start: vi.fn(() => ({ worktree: worktreeFor(HOME, 'ABC'), branch: 'night/ABC', base: 'a1b2c3' })),
  collect: vi.fn(() => ({ commits: 2, note: '2 files changed' })),
  stop: vi.fn(),
})
const quiet = { log: () => {}, warn: () => {} }

describe('night shift (#12): off by default', () => {
  it('off, it registers no tool, and a start reaches no runner: it is refused', async () => {
    for (const jobs of [undefined, { ...ON, enabled: false }]) {
      const { ctx, job } = fakeCtx()
      const runner = fakeRunner()
      installNightShift(ctx, { home: HOME, jobs, runner, ...quiet })
      await expect(job().start({ type: 'StartJob', job: JOB, folder: 'ABC' })).rejects.toThrow(/night shift is off/)
      expect(ctx.tools.register).not.toHaveBeenCalled()
      expect(runner.start).not.toHaveBeenCalled()
      expect(ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
    }
  })
})

describe('night shift (#12): switched off with a job under way', () => {
  it('still stops it, so the tmux session is not orphaned', async () => {
    const { ctx, job } = fakeCtx()
    const runner = fakeRunner()
    ctx.gnomonKernel.getState = () => ({ nightShift: { open: { ...JOB, status: 'stopping', worktree: worktreeFor(HOME, 'ABC'), base: 'a1b2c3' } } })
    installNightShift(ctx, { home: HOME, jobs: { ...ON, enabled: false }, runner, ...quiet })
    expect(await job().stop({ type: 'StopJob', jobId: JOB.id, outcome: 'stopped' })).toEqual({ commits: 2, note: '2 files changed' })
    expect(runner.stop).toHaveBeenCalledWith('ABC')
  })
})

describe('night shift (#12): on, with a fake runner', () => {
  it('starts through the runner and answers where; unregisters on dispose', async () => {
    const { ctx, job } = fakeCtx()
    const runner = fakeRunner()
    const dispose = installNightShift(ctx, { home: HOME, jobs: ON, runner, ...quiet })
    expect(ctx.tools.register.mock.calls.map(([t]) => t.name)).toEqual(['gnomon_night_job', 'gnomon_night_job_stop'])
    expect(await job().start({ type: 'StartJob', job: JOB, folder: 'ABC' })).toEqual({ worktree: worktreeFor(HOME, 'ABC'), branch: 'night/ABC', base: 'a1b2c3' })
    expect(runner.start).toHaveBeenCalledWith({ job: JOB, folder: 'ABC' })
    dispose()
    expect(job()).toBeUndefined()
  })

  it('a failed start throws, for the executor to fold as failed', async () => {
    const t = fakeCtx()
    const broken = { ...fakeRunner(), start: vi.fn(() => { throw new Error('not a git repository') }) }
    installNightShift(t.ctx, { home: HOME, jobs: ON, runner: broken, ...quiet })
    await expect(t.job().start({ type: 'StartJob', job: JOB, folder: 'ABC' })).rejects.toThrow('not a git repository')
  })

  it('a stop ends the session and collects the branch; one for no open job says so with null', async () => {
    const open = { id: JOB.id, status: 'finishing', worktree: '~/.sundial/night-shift/ABC', base: 'a1b2c3' }
    const { ctx, job } = fakeCtx(open)
    const runner = fakeRunner()
    installNightShift(ctx, { home: HOME, jobs: ON, runner, ...quiet })
    expect(await job().stop({ type: 'StopJob', jobId: JOB.id, outcome: 'done' })).toEqual({ commits: 2, note: '2 files changed' })
    expect(runner.stop).toHaveBeenCalledWith('ABC')
    expect(runner.collect).toHaveBeenCalledWith({ worktree: open.worktree, base: 'a1b2c3' })
    expect(await job().stop({ type: 'StopJob', jobId: 'job-other', outcome: 'stopped' })).toBeNull()
    expect(ctx.gnomonKernel.appendSignal).not.toHaveBeenCalled()
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
    for (const key of ['SUNDIAL_HOME', 'DSH_HOME', 'SUNDIAL_WEB_PORT', 'SUNDIAL_PHONE_PORT', 'SUNDIAL_CHROME_PORT', 'SUNDIAL_LABEL', 'DATABASE_URL']) expect(command).toContain(key)
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
