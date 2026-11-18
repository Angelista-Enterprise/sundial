import type { Rule } from '@sundial/kernel/types.js';

/**
 * A background shell job that finished (`shell:exited`), and per chat the last gnomon_run_shell (`shell:started`).
 *
 * Runs 13 and 14 spent 48% of their whole clock asleep: the model started a job, guessed how long it
 * would take, and slept in the shell. It guessed 39 seconds for a 24 second job, and 38 for an app that
 * appeared after 30. Nothing in the record said a job had ended, so there was nothing else it could do.
 *
 * This is the missing fact, and it is one line of state: the newest few jobs by id, with how they ended.
 * `gnomon_await` waits on it, so a wait ends when the job does instead of when the guess runs out.
 *
 * Bounded to the newest `JOBS_KEPT`: a wait only ever asks about a job started in the same turn.
 *
 * Set 2 R3: the chat's last call lived in a Map in sundial-actions, so a restart forgot a running job and
 * an empty `gnomon_await` after it waited on the front app instead. `shell:started` is one row per call
 * (the job it started, or `failed`), kept for the newest `SHELLS_KEPT` chats; running = in `shells`, not in `jobs`.
 */
export const JOBS_KEPT = 8;
export const SHELLS_KEPT = 20;

const newest = <T extends { at: string }>(rows: Record<string, T>, keep: number) =>
  Object.fromEntries(Object.entries(rows).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, keep));

export const shellJobs: Rule = (state, event) => {
  if (event.type === 'shell:started') {
    const p = event.payload as { session?: unknown; jobId?: unknown; failed?: unknown };
    const session = typeof p.session === 'string' ? p.session : '';
    const row = { at: event.ts, failed: p.failed === true, job: typeof p.jobId === 'string' && p.jobId !== '' ? p.jobId : null };
    return { state: { ...state, shells: newest({ ...state.shells, [session]: row }, SHELLS_KEPT) }, effects: [] };
  }
  if (event.type !== 'shell:exited') return { state, effects: [] };
  const payload = event.payload as { jobId?: unknown; exitCode?: unknown; lastLine?: unknown; ms?: unknown };
  const jobId = typeof payload.jobId === 'string' ? payload.jobId : '';
  if (!jobId) return { state, effects: [] };
  const job = {
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : -1,
    lastLine: typeof payload.lastLine === 'string' ? payload.lastLine.slice(0, 300) : '',
    at: event.ts,
    ms: typeof payload.ms === 'number' ? payload.ms : 0,
  };
  return { state: { ...state, jobs: newest({ ...state.jobs, [jobId]: job }, JOBS_KEPT) }, effects: [] };
};
