import type { Rule } from '@sundial/kernel/types.js';

interface AgentSessionPayload {
  cwd?: unknown;
  branch?: unknown;
}

/**
 * Sole writer of `state.agent.session` — where the active coding agent (Claude
 * Code) is working, read from its own session transcript by the
 * `agent-session` sensor.
 *
 * A `cwd` of `null` is a real observation, not a missing one: it means no
 * session transcript has been written to recently, so the agent is not working
 * anywhere right now. Clearing the slice on it is what stops a Claude window
 * from inheriting a project the owner walked away from hours ago — the whole
 * reason this is safe to treat as a `certain` locator in `resolveAttribution`
 * rather than as ambient context.
 */
export const agentSessionTrack: Rule = (state, event) => {
  if (event.type !== 'agent:session') return { state, effects: [] };

  const payload = event.payload as AgentSessionPayload;
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : null;
  const branch = typeof payload.branch === 'string' && payload.branch.length > 0 ? payload.branch : null;

  return {
    // Spread: the fleet and the nudge memory live in this slice too (U3-F1).
    state: { ...state, agent: { ...state.agent, session: cwd ? { cwd, branch } : null } },
    effects: [],
  };
};
