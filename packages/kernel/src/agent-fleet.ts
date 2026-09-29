import type { AgentFleetEntry, AgentFleetState, AgentHook } from './types.js';

/**
 * Folders two or more live sessions share, in any state. A `waiting` session
 * counts: its turn ended, but its unsaved edits are still in the folder. Only
 * for `WAITING_HOLDS_MS`, though: the fleet keeps a transcript six hours, so a
 * session the owner quit would otherwise read as waiting all afternoon.
 *
 * One checkout, two agents: a build or a commit in one ships the other's
 * unsaved edits. It happened here (a `tsc` in one session published another's
 * uncommitted code to a restart), and it is common: 80 same-folder overlaps of
 * over a minute in 1,350 working turns in September 2026, 48 of them in one
 * repository. A worktree per session is the fix; saying so is this rule's job.
 */
export const WAITING_HOLDS_MS = 30 * 60_000;

export function sharedCheckouts(fleet: AgentFleetEntry[], now: string): { cwd: string; ids: string[] }[] {
  const byCwd = new Map<string, string[]>();
  for (const s of fleet) if (s.state !== 'waiting' || Date.parse(now) - Date.parse(s.since) <= WAITING_HOLDS_MS) byCwd.set(s.cwd, [...(byCwd.get(s.cwd) ?? []), s.id]);
  return [...byCwd].filter(([, ids]) => ids.length >= 2).map(([cwd, ids]) => ({ cwd, ids: ids.sort() }));
}

/**
 * What a Claude Code hook says a session's state is now, or `null` when it says
 * nothing about it; `'ended'` for a session that is gone (U3-F8).
 *
 * The notification types are Claude's own (`permission_prompt` blocked on an
 * approval, `elicitation_dialog` an MCP server asking, `agent_needs_input` a
 * background agent asking, `idle_prompt` / `agent_completed` a finished turn).
 */
export function hookState(hook: AgentHook): AgentFleetState | 'ended' | null {
  switch (hook.event) {
    case 'Notification':
      if (hook.detail === 'permission_prompt') return 'permission';
      if (hook.detail === 'idle_prompt' || hook.detail === 'agent_completed') return 'waiting';
      if (hook.detail === 'agent_needs_input' || hook.detail?.startsWith('elicitation_') === true) return 'question';
      return null;
    case 'Stop':
      return 'waiting';
    case 'StopFailure':
      return 'failed';
    case 'SessionEnd':
      return 'ended';
    case 'UserPromptSubmit':
    case 'SessionStart':
    case 'PreCompact':
    case 'PostToolUse':
      return 'working';
    default:
      return null;
  }
}

/**
 * The fleet with each session's last hook laid over it, when the hook is newer
 * than the entry's state. The same state keeps its `since` (an `idle_prompt` a
 * minute after `Stop` is the same wait, not a new one); a session a
 * `SessionEnd` closed is dropped. Pure.
 */
export function withHooks(fleet: AgentFleetEntry[], hooks: Record<string, AgentHook>): AgentFleetEntry[] {
  return fleet.flatMap((s) => {
    const hook = hooks[s.id];
    if (!hook || Date.parse(hook.at) < Date.parse(s.since)) return [s];
    const state = hookState(hook);
    if (state === 'ended') return [];
    if (state === null || state === s.state) return [s];
    const { error: _error, ...rest } = s;
    return [{ ...rest, state, since: hook.at, source: 'hook' as const, ...(state === 'failed' && hook.detail ? { error: hook.detail } : {}) }];
  });
}
