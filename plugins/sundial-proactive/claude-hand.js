// The other pair of hands: a workbench job run by a vendor runtime on the owner's own login.
//
// Gnomon decides WHEN and WHAT (the `workbench` rule); this runs one job on the
// runtime port of @sundial/llm (`claude -p`, the Copilot SDK) instead of a dsh
// child, when `llm.roles.jobs` names a runtime source. The contract is the
// worker's own — read only — held by what the runtime is GIVEN rather than by
// what the prompt asks: Sundial's MCP server (read-only by construction), web
// search and fetch where the runtime has them, and no other tool. No shell, no
// edits; anything else is refused instead of prompting nobody.
//
// It runs from an empty folder under `.daemon/hands` with the install's own
// variables stripped, so neither a repository's CLAUDE.md nor the owner's hooks
// and instructions reach it, and nothing inside it can reach the live record.
// The owner's own plan pays for it; `jobs.maxUsdPerJob` caps one job where the
// runtime enforces a cap.
//
// A runtime child cannot call `gnomon_shelve` (MCP is read-only), so it answers
// in a JSON schema and the caller appends the signal. Named exports only.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runtimeToolNote } from '@sundial/kernel/persona.js'
import { claudeBinary, INSTALL_ENV, isInstallKey, jobEnv, runOnRuntimes } from '@sundial/llm/index.js'

export { INSTALL_ENV, isInstallKey, jobEnv }

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

/** `claude` on the owner's login-shell PATH, or the configured path. Null when absent. */
export const resolveClaude = (configured = null) => claudeBinary(configured)

/** What the runtime must know that the dsh worker's prompt assumes: its tool names, and how to report. */
export function handPreamble(job) {
  const lines = [
    `Your tools: ${runtimeToolNote()} web_search is WebSearch; web_fetch is WebFetch. There is no skill tool and no todo_write.`,
    'Wherever the text says to finish with gnomon_shelve or gnomon_work_done, answer in the JSON schema instead: outcome "shelved" with title, body and sources (and `rule` when the text asks for one), or outcome "nothing".',
  ]
  if (job.kind === 'owner-request') {
    try {
      lines.push('', 'The research-brief skill, which the text asks you to load:', readFileSync(SKILL, 'utf8').replace(/^---[\s\S]*?---\s*/, ''))
    } catch {}
  }
  return lines.join('\n')
}

/**
 * Run one job over the runtime candidates in order (`runOnRuntimes`: a limit
 * moves to the next). Resolves `{ ok, result?, error?, run, source, model }` —
 * never rejects, so the caller has one place to append the closing signal.
 * `onAttempt` / `onSettled` let the caller open and settle one audit row per attempt. `tools`: 'read' (Sundial's MCP and
 * the web), or 'none' for a rig chat's sandbox job (S4). `timeoutMs`: the job's own budget; without it the runtime's
 * three-minute default for a one-shot call cut every longer job (all 20 failed hand rows on the record ran 180 s or more).
 */
export async function runHand({ candidates, prompt, home, maxBudgetUsd, signal, timeoutMs, onAttempt, onSettled, tools = 'read' }) {
  try {
    const { source, model, run } = await runOnRuntimes(candidates, { cwd: `${home}/.daemon/hands`, prompt, tools, schema: HAND_SCHEMA, maxUsd: maxBudgetUsd, home, signal, timeoutMs }, onAttempt, onSettled)
    const result = run.structured
    if (run.error) return { ok: false, error: run.error.message, run, source, model }
    if (!result || (result.outcome !== 'shelved' && result.outcome !== 'nothing')) return { ok: false, error: `${source}: no structured result`, run, source, model }
    return { ok: true, result, run, source, model }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), run: null, source: candidates[0]?.source ?? null, model: candidates[0]?.model }
  }
}
