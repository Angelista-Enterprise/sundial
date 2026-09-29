// #11: the SessionStart context hook. Made-up values only; a throwaway HOME,
// CLAUDE_CONFIG_DIR and SUNDIAL_HOME. Nothing here reads the owner's files.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contextLines, gitOf, MAX_LINES, MAX_LINE_CHARS } from '../packages/sensors/claude-context.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLI = path.join(REPO, 'bin', 'sundial')
const HOOK = path.join(REPO, 'packages', 'sensors', 'claude-context.mjs')

let root
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sundial-ctx-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const HOME = '/Users/mira'
const ROOT = '~/Projects/puzzlebox-studio'
const snap = (over = {}) => ({
  at: '2026-09-29T11:59:00.000Z',
  tz: 'Europe/Amsterdam',
  known: { [ROOT]: { name: 'puzzlebox-studio', org: null, remote: null, branch: 'main' }, '~/Projects/other': { name: 'other', branch: null } },
  tickets: {
    'BOX-484': { id: 'BOX-484', stage: 'pr', pr: { number: 812, state: 'OPEN', reviewState: 'CHANGES_REQUESTED' } },
    'BOX-9': { id: 'BOX-9', stage: 'seen', pr: null },
  },
  lastFailure: { [`${ROOT}/web`]: { command: 'pnpm test', exitCode: 1, at: '2026-09-29T11:40:00.000Z' }, '~/Projects/other': { command: 'make', exitCode: 2, at: '2026-09-29T11:50:00.000Z' } },
  open: [
    { id: 'c1', name: 'draft', projectId: ROOT, promise: { direction: 'owner', counterparty: 'Mira Bakker', deliverable: 'the draft', due: '2026-10-01T12:00:00.000Z' } },
    { id: 'c2', name: 'deck', projectId: ROOT, promise: { direction: 'awaiting', counterparty: 'person-0a1b2c3d', deliverable: 'the deck', due: null } },
    { id: 'c3', name: 'box-484-retry', projectId: ROOT, branch: 'box-484-retry' },
  ],
  resume: { at: '2026-09-29T10:00:00.000Z', line: 'Back after 40 min — Fixing the retry test · puzzlebox-studio', pieces: { project: { id: ROOT, name: 'puzzlebox-studio' } } },
  fleet: [],
  ...over,
})
const at = (cwd, s = snap(), git = { root: cwd, branch: 'box-484-retry' }) => contextLines(s, cwd, { nowMs: NOW, home: HOME, git })

describe('contextLines (#11)', () => {
  it('says the project, the ticket its branch names, the promises, the failure and where the owner was', () => {
    const lines = at(`${HOME}/Projects/puzzlebox-studio/web`)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('Gnomon (Sundial) — project: puzzlebox-studio · branch box-484-retry · open ticket BOX-484 (pr, PR #812 changes requested)')
    expect(lines[1]).toMatch(/^Open promises on puzzlebox-studio: 2 — "the draft" \(you owe Mira Bakker, due Thu 1 Oct/)
    expect(lines[2]).toBe('Last failure here: `pnpm test` exited 1 at 13:40 and has not passed since')
    expect(lines[3]).toBe('Where the owner was (12:00): Back after 40 min — Fixing the retry test · puzzlebox-studio')
  })

  it('a worktree elsewhere counts through its main repository', () => {
    expect(at(`${HOME}/Projects/puzzlebox-wt`, snap(), { root: `${HOME}/Projects/puzzlebox-studio`, branch: 'x' })[0]).toContain('project: puzzlebox-studio')
  })

  it('prints nothing for a folder no project contains, a sibling with the same prefix, or a stale snapshot', () => {
    expect(at('/tmp/scratch', snap(), null)).toEqual([])
    expect(at(`${HOME}/Projects/puzzlebox-studio-old`, snap(), null)).toEqual([])
    expect(at(`${HOME}/Projects/puzzlebox-studio`, snap({ at: '2026-09-29T11:00:00.000Z' }))).toEqual([])
    expect(contextLines(null, '/x')).toEqual([])
  })

  it('never names a bare person hash, and keeps a seen-only ticket out', () => {
    const s = snap({ open: [snap().open[1]] })
    const lines = at(`${HOME}/Projects/puzzlebox-studio`, s, { root: `${HOME}/Projects/puzzlebox-studio`, branch: 'box-9-typo' })
    expect(lines[0]).not.toContain('BOX-9')
    expect(lines[1]).toBe('Open promises on puzzlebox-studio: 1 — "the deck" (owed to you)')
    expect(lines.join('\n')).not.toContain('person-')
  })

  it('a Claude session that stopped on an error is the failure when it is newer', () => {
    const s = snap({ fleet: [{ id: 'a1', cwd: `${ROOT}/web`, state: 'failed', since: '2026-09-29T11:45:00.000Z', error: 'rate_limit' }] })
    expect(at(`${HOME}/Projects/puzzlebox-studio`, s)[2]).toBe('Last failure here: a Claude session stopped on an error (rate_limit) at 13:45')
  })

  it('an old or other-project return line is left out; at most 5 lines, each clipped', () => {
    const s = snap({ resume: { ...snap().resume, at: '2026-09-28T20:00:00.000Z' }, known: { [ROOT]: { name: 'p'.repeat(400) } } })
    const lines = at(`${HOME}/Projects/puzzlebox-studio`, s)
    expect(lines.some((l) => l.startsWith('Where'))).toBe(false)
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES)
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(MAX_LINE_CHARS)
  })

  it('a ticket matches as a whole key only, and a nested project keeps its own failure', () => {
    const s = snap({ tickets: { 'BOX-4': { id: 'BOX-4', stage: 'pr', pr: null }, 'BOX-48': { id: 'BOX-48', stage: 'branch', pr: null } } })
    expect(at('/Users/mira/Projects/puzzlebox-studio', s, { root: '/Users/mira/Projects/puzzlebox-studio', branch: 'feat/box-48-retry' })[0]).toContain('open ticket BOX-48 (branch)')
    const nested = snap({ known: { ...snap().known, [`${ROOT}/web`]: { name: 'web', branch: null } } })
    const lines = at('/Users/mira/Projects/puzzlebox-studio', nested, { root: '/Users/mira/Projects/puzzlebox-studio', branch: 'main' })
    expect(lines.some((l) => l.startsWith('Last failure here'))).toBe(false)
  })

  it('gitOf reads a worktree .git file back to its main repository and branch', () => {
    const main = path.join(root, 'main')
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat/box-484\n')
    const wt = path.join(root, 'wt', 'src')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(root, 'wt', '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`)
    expect(gitOf(wt)).toEqual({ root: main, branch: 'feat/box-484' })
  })
})

// The CLI and the hook as Claude runs them.
function sundial(args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, SUNDIAL_LABEL: 'dev.sundial.vitest', ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const setup = () => {
  const home = path.join(root, 'home')
  const claude = path.join(home, '.claude')
  const data = path.join(root, 'sundial')
  fs.mkdirSync(claude, { recursive: true })
  fs.mkdirSync(path.join(data, '.daemon'), { recursive: true })
  const original = `${JSON.stringify({ permissions: { defaultMode: 'auto' }, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)}\n`
  fs.writeFileSync(path.join(claude, 'settings.json'), original)
  const env = { HOME: home, CLAUDE_CONFIG_DIR: claude, SUNDIAL_HOME: data }
  return { home, claude, data, original, env, settings: () => fs.readFileSync(path.join(claude, 'settings.json'), 'utf8') }
}

/** A throwaway sundial.db holding one kernel snapshot. */
function writeDb(data, state, createdAt) {
  const sql = `create table kernel_state_snapshots (id text primary key, created_at text not null, state_json text not null, log_offset text not null);
insert into kernel_state_snapshots values ('s1', '${createdAt}', '${JSON.stringify(state).replaceAll("'", "''")}', '0');`
  const r = spawnSync('sqlite3', [path.join(data, 'sundial.db')], { input: sql, encoding: 'utf8' })
  expect(r.status).toBe(0)
}

describe('sundial claude-context (#11)', () => {
  it('adds its one SessionStart entry idempotently, apart from the report-only hooks, and removes exactly it', () => {
    const t = setup()
    expect(sundial(['claude-hooks'], t.env).code).toBe(0)
    const reportOnly = t.settings()
    expect(sundial(['claude-context'], t.env).code).toBe(0)
    const once = t.settings()
    expect(sundial(['claude-context'], t.env).code).toBe(0)
    expect(t.settings()).toBe(once)
    const start = JSON.parse(once).hooks.SessionStart
    expect(start[0].hooks[0].command).toBe('echo mine')
    const ours = start.map((g) => g.hooks[0]).find((h) => h.command.includes('claude-context.mjs'))
    expect(ours).toMatchObject({ type: 'command', timeout: 2 })
    expect(ours.async).toBeUndefined()
    // The report-only refresh and removal leave the context hook alone, and back.
    expect(sundial(['claude-hooks'], t.env).code).toBe(0)
    const refreshed = t.settings()
    expect(refreshed).toContain('claude-context.mjs')
    expect(sundial(['claude-hooks'], t.env).code).toBe(0)
    expect(t.settings()).toBe(refreshed)
    expect(sundial(['claude-context', '--remove'], t.env).code).toBe(0)
    expect(t.settings()).toBe(reportOnly)
    expect(sundial(['claude-context'], t.env).code).toBe(0)
    expect(sundial(['claude-hooks', '--remove'], t.env).code).toBe(0)
    expect(sundial(['claude-context', '--remove'], t.env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
  })

  it('the hook prints the lines from a fresh snapshot, fast, and nothing when stale, switched off, or not SessionStart', () => {
    const t = setup()
    sundial(['claude-context'], t.env)
    const command = JSON.parse(t.settings()).hooks.SessionStart.map((g) => g.hooks[0]).find((h) => h.command.includes('claude-context.mjs')).command
    const repo = path.join(t.home, 'Projects', 'puzzlebox-studio')
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/box-484-retry\n')
    const state = { project: { known: { [repo]: { name: 'puzzlebox-studio', branch: 'main' } } }, tickets: snap().tickets, shell: {}, commitments: { open: [] }, resume: { last: null }, agent: {}, config: { timezone: 'UTC' } }
    const run = (input) => {
      const t0 = Date.now()
      const r = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, HOME: t.home } })
      return { ...r, ms: Date.now() - t0 }
    }
    const start = { session_id: 'abcdef12', hook_event_name: 'SessionStart', source: 'startup', cwd: repo }

    // No database: Sundial is not installed or not running.
    expect(run(start).stdout).toBe('')
    writeDb(t.data, state, new Date().toISOString())
    const r = run(start)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('Gnomon (Sundial) — project: puzzlebox-studio · branch box-484-retry · open ticket BOX-484 (pr, PR #812 changes requested)\n')
    expect(r.ms).toBeLessThan(1500) // the hook's own cap is 450 ms; this bounds spawn noise on a loaded test machine
    expect(run({ ...start, hook_event_name: 'Stop' }).stdout).toBe('')
    fs.writeFileSync(path.join(t.data, 'config.json'), JSON.stringify({ privacy: { claudeContext: false } }))
    expect(run(start).stdout).toBe('')
    fs.rmSync(path.join(t.data, 'config.json'))
    fs.rmSync(path.join(t.data, 'sundial.db'))
    writeDb(t.data, state, new Date(Date.now() - 3_600_000).toISOString())
    expect(run(start).stdout).toBe('')
    expect(spawnSync(process.execPath, [HOOK, t.data], { input: 'not json', encoding: 'utf8' }).stdout).toBe('')
  })

  it('a test install adds no context hook unless asked; uninstall takes it back out', () => {
    if (process.platform !== 'darwin') return
    const t = setup()
    const dir = path.join(root, 'sundial-install')
    const env = { ...t.env, SUNDIAL_HOME: dir }
    expect(sundial(['install', '--skip-build', '--no-launchagent', '--no-sidecars'], env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
    expect(sundial(['uninstall', '--yes'], env).code).toBe(0)
    expect(sundial(['install', '--skip-build', '--no-launchagent', '--no-sidecars', '--claude-context'], env).code).toBe(0)
    expect(t.settings()).toContain('claude-context.mjs')
    expect(t.settings()).not.toContain('claude-hook.mjs')
    expect(sundial(['uninstall'], env).out).toMatch(/Sundial's hooks in/)
    expect(sundial(['uninstall', '--yes'], env).code).toBe(0)
    expect(t.settings()).toBe(t.original)
  })
})
