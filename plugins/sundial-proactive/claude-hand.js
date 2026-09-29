// The other pair of hands: a workbench job run by the local Claude Code CLI.
//
// Gnomon decides WHEN and WHAT (the `workbench` rule); this runs one job on
// `claude -p` instead of a dsh child, when the owner set `hands.claude`. The
// contract is the worker's own — read only — held here by what Claude is GIVEN
// rather than by what the prompt asks: Sundial's MCP server (read-only by
// construction), web search and fetch, and no other tool. No shell, no edits,
// `dontAsk` so anything else is refused instead of prompting nobody.
//
// It runs from an empty folder with `--setting-sources project`, so neither a
// repository's CLAUDE.md nor the owner's own hooks and instructions reach it.
// The owner's Claude login pays for it; `--max-budget-usd` caps one job.
//
// A Claude child cannot call `gnomon_shelve` (MCP is read-only), so it answers
// in a JSON schema and the caller appends the signal. Named exports only.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MCP_BIN = fileURLToPath(new URL('../../packages/mcp/bin/sundial-mcp.js', import.meta.url))
const SKILL = fileURLToPath(new URL('../sundial-tools/presets/gnomon/skills/research-brief/SKILL.md', import.meta.url))

export const HAND_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['shelved', 'nothing'] },
    title: { type: 'string' },
    body: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    rule: { type: 'object', description: 'Only for a rule-idea job: the tested watch rule.' },
  },
  required: ['outcome'],
}

/**
 * Which install a Sundial process belongs to, and what it can do there. A
 * job's child must never inherit any of it: Sundial.app sets SUNDIAL_HOME to
 * the owner's data folder, so a test run or a `sundial` call inside a job would
 * reach the live install, and SUNDIAL_INTERNAL_TOKEN passes the web guard. So
 * every SUNDIAL_* and DSH_* variable goes, and DATABASE_URL, except
 * SUNDIAL_JOB_ID. The MCP server gets its home explicitly (`handArgs`).
 */
export const isInstallKey = (key) => (/^(SUNDIAL|DSH)_/.test(key) && key !== 'SUNDIAL_JOB_ID') || key === 'DATABASE_URL'
/** The named ones, for a place that must list them (tmux's `env -u`); `jobEnv` strips by pattern. */
export const INSTALL_ENV = ['SUNDIAL_HOME', 'DSH_HOME', 'SUNDIAL_WEB_PORT', 'SUNDIAL_PHONE_PORT', 'SUNDIAL_CHROME_PORT', 'SUNDIAL_LABEL', 'SUNDIAL_INTERNAL_TOKEN', 'DATABASE_URL']

/** `env` without the install's variables. */
export function jobEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isInstallKey(key)))
}

/** `claude` on the owner's login-shell PATH — the app's own PATH rarely has /opt/homebrew/bin. Null when absent. */
export function resolveClaude(configured = null) {
  if (configured) return existsSync(configured) ? configured : null
  try {
    const found = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim()
    return found.startsWith('/') ? found : null
  } catch {
    return null
  }
}

/** What Claude must know that the dsh worker's prompt assumes: its tool names, and how to report. */
export function handPreamble(job) {
  const lines = [
    'Your tools: the gnomon_* tools named below are mcp__sundial__gnomon_* here; web_search is WebSearch; web_fetch is WebFetch. There is no skill tool and no todo_write.',
    'Wherever the text says to finish with gnomon_shelve or gnomon_work_done, answer in the JSON schema instead: outcome "shelved" with title, body and sources (and `rule` when the text asks for one), or outcome "nothing".',
  ]
  if (job.kind === 'owner-request') {
    try {
      lines.push('', 'The research-brief skill, which the text asks you to load:', readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\s*/, ''))
    } catch {}
  }
  return lines.join('\n')
}

/** The argv, kept apart so a test can read it. */
export function handArgs({ prompt, home, maxBudgetUsd }) {
  const mcp = { mcpServers: { sundial: { command: process.execPath, args: [MCP_BIN], env: { SUNDIAL_HOME: home } } } }
  return [
    '-p', prompt,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(HAND_SCHEMA),
    '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--tools', 'WebSearch,WebFetch',
    '--allowedTools', 'mcp__sundial__*,WebSearch,WebFetch',
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--max-budget-usd', String(maxBudgetUsd),
    '--no-session-persistence',
  ]
}

/**
 * Run one job. Resolves `{ ok, result?, error?, envelope? }` — never rejects,
 * so the caller has one place to append the closing signal.
 */
export function runClaudeHand({ prompt, home, claudePath, maxBudgetUsd, signal, spawnFn = spawn }) {
  const cwd = `${home}/.daemon/hands`
  mkdirSync(cwd, { recursive: true })
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawnFn(claudePath, handArgs({ prompt, home, maxBudgetUsd }), { cwd, signal, env: jobEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.stderr?.on('data', (chunk) => (err = (err + chunk).slice(-2000)))
    child.on('error', (error) => resolve({ ok: false, error: error.message }))
    child.on('close', (code) => {
      let envelope
      try {
        envelope = JSON.parse(out)
      } catch {
        resolve({ ok: false, error: `exit ${code}: ${(err || out).trim().slice(0, 300) || 'no output'}` })
        return
      }
      const result = envelope.structured_output
      if (envelope.is_error || !result || (result.outcome !== 'shelved' && result.outcome !== 'nothing')) {
        resolve({ ok: false, envelope, error: `claude: ${envelope.subtype ?? 'no structured result'}` })
        return
      }
      resolve({ ok: true, result, envelope })
    })
  })
}
