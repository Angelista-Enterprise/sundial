// lane E (#12): the night shift's hands.
//
// The `nightShift` rule (packages/rules/src/night-shift.ts) decides WHEN a job
// starts and watches it through the agent fleet; this file does the three
// things the rule asks over the `night-shift` Notify channel: start, finish
// (collect the result) and stop. Each reply is ONE signal (`job:started`,
// `job:finished`) the rule folds.
//
// OFF unless `jobs.enabled` is true in config.json, and the owner has not said
// yes (2026-09-29). Off, `installNightShift` registers no tool and ignores a
// `start`, so no notice, tool or replay can start a job. It still hears `stop`
// and `finish`, so a job started before the switch went off is stopped, not
// orphaned (a682569).
//
// What a job is, and is not:
//   - an interactive `claude` in a detached tmux session, in a git worktree
//     Sundial makes under `$SUNDIAL_HOME/night-shift/<id>` on a new branch.
//     Never in the project's own checkout (`assertWorktree`).
//   - Claude's `manual` permission mode with the project's settings only, so
//     neither the owner's allow rules nor Sundial approve anything. A tool that
//     needs a permission waits in the pane (`tmux attach -t sundial-night-<id>`),
//     and the fleet's `agent-permission` notice says so through the gate.
//   - `git push` refused. The result is a branch with commits, on the shelf.
//
// The runner is injectable; the tests use a fake one only. Named exports only.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { INSTALL_ENV, isInstallKey, jobEnv, resolveClaude } from './claude-hand.js'

/** MUST match `NIGHT_SHIFT_CHANNEL` in packages/rules/src/night-shift.ts (duplicated, not imported, like work.js's JOB_TIMEOUT_MS). */
export const NIGHT_SHIFT_CHANNEL = 'night-shift'
/** Claude permission modes that approve something by themselves. A job never gets one. */
export const APPROVING_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk']

const PLUGIN = 'sundial-proactive'
const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p)
const within = (p, root) => p === root || p.startsWith(`${root}${path.sep}`)

export const worktreeFor = (home, folder) => path.join(home, 'night-shift', folder)
export const tmuxSession = (folder) => `sundial-night-${folder}`

/** Throws unless `worktree` is Sundial's own folder for one job, and apart from the project's checkout. */
export function assertWorktree(repo, worktree, home) {
  const r = path.resolve(repo)
  const w = path.resolve(worktree)
  const base = path.resolve(home, 'night-shift')
  if (!within(w, base) || w === base) throw new Error(`refusing ${w}: a night job runs only in a folder of its own under ${base}`)
  if (within(w, r) || within(r, w)) throw new Error(`refusing ${w}: it overlaps the project's own checkout ${r}`)
}

/** What Claude is told. The owner's brief, inside the rules of the night. */
export function nightPrompt(job) {
  return [
    `You are working unattended on "${job.subject}" in a git worktree made for this job, on its own branch. Nobody is watching.`,
    'Work only inside this folder. Commit your work on the current branch in small commits with clear messages.',
    'Never push, never open a pull request, never merge, never delete branches or worktrees.',
    'When a step needs a permission, ask for it and wait: the owner answers in the morning.',
    'Finish with one last commit whose message says what changed, what is left, and how to check it.',
    '',
    `The owner's brief: ${job.brief}`,
  ].join('\n')
}

/** Claude's argv. `manual`: every permission is asked. `project` settings only: the owner's allow rules do not ride along. */
export function claudeArgs(job) {
  // `--disallowedTools` takes many values: `=` keeps it from swallowing the prompt.
  return ['--permission-mode', 'manual', '--setting-sources', 'project', '--disallowedTools=Bash(git push:*)', nightPrompt(job)]
}

/**
 * A tmux session takes the tmux SERVER's environment, which is whoever started
 * the server (Sundial.app, with the owner's SUNDIAL_HOME). `env -u` clears the
 * install's variables inside the pane whatever the server holds; `exec`'s own
 * env (`jobEnv`) covers a server this call starts.
 */
export const unsetInstallEnv = (env = process.env) => ['/usr/bin/env', ...[...new Set([...INSTALL_ENV, ...Object.keys(env).filter(isInstallKey)])].flatMap((key) => ['-u', key])]

/** The tmux runner. `exec(cmd, args)` returns stdout and throws on a non-zero exit; injectable for the tests. */
export function createTmuxRunner({ home, claudePath, tmux = 'tmux', exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, env: jobEnv(), stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const git = (dir, ...args) => exec('git', ['-C', dir, ...args]).trim()
  return {
    start({ job, folder }) {
      const repo = expand(job.repo)
      const worktree = worktreeFor(home, folder)
      assertWorktree(repo, worktree, home)
      if (existsSync(worktree)) throw new Error(`${worktree} already exists`)
      const base = git(repo, 'rev-parse', 'HEAD')
      const branch = `night/${folder}`
      mkdirSync(path.dirname(worktree), { recursive: true })
      git(repo, 'worktree', 'add', '-b', branch, worktree, base)
      exec(tmux, ['new-session', '-d', '-s', tmuxSession(folder), '-c', worktree, '-e', `SUNDIAL_JOB_ID=${job.id}`, ...unsetInstallEnv(), claudePath, ...claudeArgs(job)])
      return { worktree, branch, base }
    },
    /** What the job left: commits since its base, their subjects, and whether anything is uncommitted. */
    collect({ worktree, base }) {
      const worktreeAbs = expand(worktree)
      const commits = Number(git(worktreeAbs, 'rev-list', '--count', `${base}..HEAD`)) || 0
      const subjects = commits > 0 ? git(worktreeAbs, 'log', '--format=%s', '-n', '5', `${base}..HEAD`).split('\n').filter(Boolean) : []
      const stat = commits > 0 ? git(worktreeAbs, 'diff', '--shortstat', `${base}..HEAD`) : ''
      const dirty = git(worktreeAbs, 'status', '--porcelain') !== ''
      return { commits, note: [stat, ...subjects.map((s) => `- ${s}`), dirty ? 'There are uncommitted changes in the worktree.' : null].filter(Boolean).join('\n') }
    },
    stop(folder) {
      try {
        exec(tmux, ['kill-session', '-t', tmuxSession(folder)])
      } catch {
        /* already gone */
      }
    },
  }
}

/** The request and stop tools. Registered only while the night shift is on. */
function nightTools(ctx) {
  const state = () => ctx.gnomonKernel.getState?.() ?? null
  return [
    defineTool({
      name: 'gnomon_night_job',
      description: 'Queue a coding job for the night shift: Claude Code works on it in a worktree of its own while the owner is away, and the branch lands on the shelf. Only when the owner asks for one. It never pushes, and every permission waits for the owner.',
      parameters: {
        project: { type: 'string', required: true, description: 'The project, by its name as Gnomon knows it.' },
        subject: { type: 'string', required: true, description: 'A few words the owner will recognise it by.' },
        brief: { type: 'string', required: true, description: 'The task in the owner\'s words: what done looks like, and any limits they gave.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { queued: { type: 'boolean' }, project: { type: 'string' } } },
        render: (_args, value) => [{ type: 'text', text: value.queued ? `Queued for the night shift on ${value.project}.` : 'Not queued.' }],
      },
      async execute(args) {
        const want = String(args.project ?? '').trim().toLowerCase()
        const known = state()?.project?.known ?? {}
        const repo = Object.keys(known).find((root) => known[root]?.name?.toLowerCase() === want || root.toLowerCase() === want)
        if (!repo) throw new Error(`no project called "${args.project}"; the known ones are ${Object.values(known).map((p) => p.name).join(', ')}`)
        if ((state()?.nightShift?.queue ?? []).length >= 3) throw new Error('three night jobs already wait; ask the owner which to drop')
        await ctx.gnomonKernel.appendSignal('job:requested', { repo, subject: String(args.subject ?? '').trim(), brief: String(args.brief ?? '').trim() })
        return { queued: true, project: known[repo].name }
      },
    }),
    defineTool({
      name: 'gnomon_night_job_stop',
      description: 'Stop a night-shift job, queued or running, by its id. The worktree and its commits stay.',
      parameters: { jobId: { type: 'string', required: true, description: 'The job id.' } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { asked: { type: 'boolean' } } },
        render: () => [{ type: 'text', text: 'Asked the night shift to stop it.' }],
      },
      async execute(args) {
        await ctx.gnomonKernel.appendSignal('job:stop-requested', { jobId: String(args.jobId ?? '').trim() })
        return { asked: true }
      },
    }),
  ]
}

/**
 * Wire the night shift, or do nothing when it is off. `runner` is injectable;
 * without one a tmux runner is built from the owner's `claude` and `tmux`.
 */
export function installNightShift(ctx, { home, jobs, runner = null, log = console.log, warn = console.warn, resolveClaudeFn = resolveClaude } = {}) {
  // Off still hears `stop`/`finish`: a job started before the switch went off must be stopped, not orphaned.
  let on = jobs?.enabled === true
  if (!on) log(`[${PLUGIN}] night shift is off (jobs.enabled is not true): no job can start`)
  if (runner === null) {
    const claudePath = on ? resolveClaudeFn(null) : null
    if (on && !claudePath) {
      warn(`[${PLUGIN}] night shift is on but no claude binary was found — it stays off`)
      on = false
    }
    runner = createTmuxRunner({ home, claudePath })
  }
  if (on) for (const tool of nightTools(ctx)) ctx.tools.register(tool)
  /** Starts already made, so a repeated Notify (delivery is at-least-once) never starts a job twice. */
  const started = new Set()
  const append = (type, payload) => ctx.gnomonKernel.appendSignal(type, payload).catch((e) => warn(`[${PLUGIN}] night shift: could not record ${type}: ${e instanceof Error ? e.message : String(e)}`))
  const openJob = (jobId) => {
    const open = ctx.gnomonKernel.getState?.()?.nightShift?.open
    return open && open.id === jobId ? open : null
  }
  const folderOf = (job) => (job?.worktree ? path.basename(job.worktree) : null)

  ctx.on('gnomon/notice', async (notice) => {
    if (notice?.channel !== NIGHT_SHIFT_CHANNEL) return
    const p = notice.payload ?? {}
    try {
      if (p.action === 'start') {
        if (!on) return
        const job = p.job
        if (!job?.id || started.has(job.id) || openJob(job.id)?.status !== 'starting') return
        started.add(job.id)
        let where
        try {
          where = runner.start({ job, folder: String(p.folder) })
        } catch (error) {
          await append('job:finished', { jobId: job.id, outcome: 'failed', note: `could not start: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) })
          return
        }
        log(`[${PLUGIN}] night job ${job.id} started in ${where.worktree}`)
        await append('job:started', { jobId: job.id, ...where })
        return
      }
      if (p.action === 'finish' || p.action === 'stop') {
        const job = openJob(p.jobId)
        const folder = folderOf(job)
        if (!job || !folder) return
        runner.stop(folder)
        let result = {}
        try {
          result = job.base ? runner.collect({ worktree: job.worktree, base: job.base }) : {}
        } catch (error) {
          result = { note: `could not read the result: ${error instanceof Error ? error.message : String(error)}` }
        }
        const outcome = p.action === 'stop' ? 'stopped' : p.failed ? 'failed' : 'done'
        await append('job:finished', { jobId: job.id, outcome, ...result })
      }
    } catch (error) {
      warn(`[${PLUGIN}] night shift: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (on) log(`[${PLUGIN}] night shift is ON: at most ${jobs.maxJobsPerNight} job(s) a night, ${jobs.maxMinutes} min and $${jobs.maxUsdPerJob} each`)
  return () => started.clear()
}
