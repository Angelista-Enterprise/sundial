import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

/**
 * The companion's session id is STABLE, not random. dsh mints
 * `session-<uuid>` per run; this one is a constant so that every restart
 * rejoins the same transcript instead of leaving a graveyard of one-notice
 * sessions in the sidebar. `SessionId()` brands any string, so a readable
 * constant is as valid as a uuid.
 */
export const COMPANION_SESSION_ID = 'gnomon-companion'

/**
 * Marker recording that the companion session has been created at least once,
 * so a later boot knows to RESUME rather than CREATE.
 *
 * The marker is a hint, never the authority: `resume` is tried first whenever
 * the marker exists and falls back to `create` if the store has since lost the
 * session (a `dev db-reset`, a pruned store, a hand-deleted file). Losing the
 * marker costs one duplicate session, not data.
 */
function markerPath(home) {
  return `${home}/.daemon/companion-session.json`
}

function readMarker(home) {
  try {
    const raw = JSON.parse(readFileSync(markerPath(home), 'utf8'))
    return typeof raw?.sessionId === 'string' ? raw.sessionId : null
  } catch {
    return null
  }
}

function writeMarker(home, sessionId) {
  const path = markerPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ sessionId, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Find-or-create the one companion agent, in three tiers:
 *
 *  1. already live in this process (`agents.get`) — a re-apply under HMR must
 *     not build a second driver over the same session;
 *  2. persisted from an earlier boot (`agents.resume`) — the owner's history
 *     with the companion is the point of a *persistent* companion;
 *  3. brand new (`agents.create`).
 *
 * Returns `{ agent, dispose }`. `dispose` is undefined for tier 1, where this
 * plugin does not own the agent's lifetime and must not end it.
 */
export async function ensureCompanion(ctx, { home, cwd }) {
  const sessionId = SessionId(COMPANION_SESSION_ID)

  const live = ctx.agents.get(sessionId)
  if (live !== undefined) return { agent: live, dispose: undefined }

  const selection = ctx.agentDefaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  // Mirrors the headless runner: without this the session carries no model
  // selection, and the web UI's model picker has nothing to show or change.
  const setup = async (agentCtx) => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
    // The Gnomon preset (todo_write, skills); absent roster → as before.
    await ctx.get?.('agentPresets')?.mount(agentCtx, 'gnomon')
  }

  if (readMarker(home) !== null) {
    try {
      const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
      return { agent: handle.agent, dispose: handle.dispose, resumed: true }
    } catch (error) {
      // The store no longer has it. Fall through and build a fresh one rather
      // than leaving the owner with no companion at all.
      console.warn(`[sundial-proactive] could not resume the companion session, creating a new one: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd },
    agentOptions,
    setup,
  })
  writeMarker(home, COMPANION_SESSION_ID)
  return { agent: handle.agent, dispose: handle.dispose, resumed: false }
}
