import type { AgentFleetEntry } from './types.js';

/**
 * Folders two or more sessions are working in at once (`working` or `tool`).
 *
 * One checkout, two agents: a build or a commit in one ships the other's
 * unsaved edits. It happened here (a `tsc` in one session published another's
 * uncommitted code to a restart), and it is common: 80 same-folder overlaps of
 * over a minute in 1,350 working turns in September 2026, 48 of them in one
 * repository. A worktree per session is the fix; saying so is this rule's job.
 */
export function sharedCheckouts(fleet: AgentFleetEntry[]): { cwd: string; ids: string[] }[] {
  const byCwd = new Map<string, string[]>();
  for (const s of fleet) if (s.state !== 'waiting') byCwd.set(s.cwd, [...(byCwd.get(s.cwd) ?? []), s.id]);
  return [...byCwd].filter(([, ids]) => ids.length >= 2).map(([cwd, ids]) => ({ cwd, ids: ids.sort() }));
}
