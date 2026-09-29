import type { AgentFleetEntry, Effect, KernelState, NightJob, NightShiftState, Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { ownerIsAway } from './workbench.js';

// lane E (#12): the night shift. The rule decides WHEN a job starts, watches it
// through the agent fleet, and asks the runner (plugins/sundial-proactive/
// night-shift.js, over the Notify channel below) to start, collect or stop.
// It never approves anything: a job waiting on a permission stays waiting, and
// the fleet's own `agent-permission` notice is what speaks.

/** The Notify channel the runner listens on. */
export const NIGHT_SHIFT_CHANNEL = 'night-shift';
/** Jobs waiting for the night. A fourth is refused: that is a backlog, not a night. */
export const MAX_QUEUED_NIGHT_JOBS = 3;
export const MAX_RECENT_NIGHT_JOBS = 20;
/** The runner answers a start, collect or stop within this, or the job is closed `failed` and the slot is free. */
export const RUNNER_REPLY_MS = 10 * 60_000;
/** A night runs noon to noon: the job started at 23:00 and the one at 02:00 are one night's. */
const NIGHT_OFFSET_MS = 12 * 3_600_000;
const MAX_BRIEF_CHARS = 2000;

const OWNER_WAITS: AgentFleetEntry['state'][] = ['permission', 'question', 'plan'];
const EMPTY: NightShiftState = { queue: [], open: null, recent: [], night: null, countTonight: 0, spentUsdTonight: 0 };

const on = (state: KernelState): boolean => state.config.jobs?.enabled === true;
const nightOf = (ts: string, tz: string): string => localDate(new Date(Date.parse(ts) - NIGHT_OFFSET_MS).toISOString(), tz);
const short = (id: string): string => id.replace(/[^A-Za-z0-9]/g, '').slice(-12);

/** The folder a job's session runs in ends with this: the runner makes `<home>/night-shift/<short id>`. */
export const jobFolderTail = (id: string): string => `/night-shift/${short(id)}`;

function notify(payload: Record<string, unknown>): Effect {
  return { type: 'Notify', channel: NIGHT_SHIFT_CHANNEL, payload };
}

function put(state: KernelState, ns: NightShiftState): KernelState {
  return { ...state, nightShift: ns };
}

/** Close the open job: into `recent`, its cost counted against the night, and its result on the shelf. */
function close(state: KernelState, ns: NightShiftState, job: NightJob, status: 'done' | 'failed' | 'stopped', ts: string, eventId: string, extra: Partial<NightJob> = {}): ReturnType<Rule> {
  const closed: NightJob = { ...job, ...extra, status, closedAt: ts };
  const next: NightShiftState = { ...ns, open: null, recent: [...ns.recent, closed].slice(-MAX_RECENT_NIGHT_JOBS), spentUsdTonight: ns.spentUsdTonight + (closed.costUsd ?? 0) };
  const said = status === 'done' ? 'finished' : status === 'stopped' ? `stopped (${closed.stopReason ?? 'asked'})` : 'failed';
  const body = [
    `Night shift on ${closed.project}: ${said}.`,
    closed.note ? closed.note : null,
    closed.branch ? `Branch \`${closed.branch}\`${closed.commits !== undefined ? `, ${closed.commits} commit${closed.commits === 1 ? '' : 's'}` : ''}${closed.base ? ` since ${closed.base.slice(0, 8)}` : ''}. Nothing was pushed or merged.` : null,
    closed.worktree ? `Worktree: ${closed.worktree}. Review it there; \`claude --continue\` in that folder resumes the session.` : null,
    closed.costUsd !== undefined ? `Cost: $${closed.costUsd.toFixed(2)}.` : 'Cost: not reported by Claude.',
    '',
    `The brief: ${closed.brief}`,
  ].filter((l): l is string => l !== null).join('\n');
  return {
    state: put(state, next),
    effects: [
      {
        type: 'WriteDB',
        table: 'knowledge_entries',
        row: { id: deriveId(ts, eventId, 'night-shift', job.id), kind: 'shelf', title: `Night shift: ${closed.subject}`.slice(0, 140), body, severity: null, dedupeKey: `shelf:night:${job.id}`, sourceEventId: eventId, createdAt: ts, importanceScore: 6 },
      },
    ],
  };
}

/** Ask the runner to stop the open job, once. */
function stop(state: KernelState, ns: NightShiftState, job: NightJob, reason: string, ts: string): ReturnType<Rule> {
  if (job.status === 'stopping') return { state, effects: [] };
  return { state: put(state, { ...ns, open: { ...job, status: 'stopping', stopReason: reason, openedAt: ts } }), effects: [notify({ action: 'stop', jobId: job.id, reason })] };
}

/**
 * The night shift's one rule. `job:requested` queues (only while
 * `config.jobs.enabled`); a `clock:tick` while the owner is away, under the
 * night's caps, asks the runner to start the oldest; `job:started` /
 * `job:finished` are the runner's replies; `agent:fleet` samples say what the
 * session is doing, and its cost. Placed after `agentFleetTrack`, so the fleet
 * it reads is the one this sample just wrote.
 */
export const nightShift: Rule = (state, event) => {
  const ns: NightShiftState = { ...EMPTY, ...state.nightShift };
  const jobs = state.config.jobs;
  const open = ns.open;
  const payload = event.payload as Record<string, unknown>;
  const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;

  if (event.type === 'job:requested') {
    // Off means off: not queued, not remembered, nothing to start later.
    if (!on(state)) return { state, effects: [] };
    const repo = typeof payload.repo === 'string' ? payload.repo : '';
    const known = state.project.known[repo];
    const subject = typeof payload.subject === 'string' ? payload.subject.trim().slice(0, 140) : '';
    const brief = typeof payload.brief === 'string' ? payload.brief.trim().slice(0, MAX_BRIEF_CHARS) : '';
    if (!known || subject === '' || brief === '' || ns.queue.length >= MAX_QUEUED_NIGHT_JOBS) return { state, effects: [] };
    const job: NightJob = { id: deriveId(event.ts, event.id, 'night-shift'), repo, project: known.name, subject, brief, requestedAt: event.ts, status: 'queued' };
    return { state: put(state, { ...ns, queue: [...ns.queue, job] }), effects: [] };
  }

  if (event.type === 'job:stop-requested' && jobId) {
    if (open?.id === jobId) return stop(state, ns, open, 'owner', event.ts);
    const queued = ns.queue.find((j) => j.id === jobId);
    if (!queued) return { state, effects: [] };
    return { state: put(state, { ...ns, queue: ns.queue.filter((j) => j.id !== jobId), recent: [...ns.recent, { ...queued, status: 'stopped' as const, stopReason: 'owner', closedAt: event.ts }].slice(-MAX_RECENT_NIGHT_JOBS) }), effects: [] };
  }

  if (event.type === 'job:started' && open?.id === jobId && open.status === 'starting') {
    const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : undefined);
    return { state: put(state, { ...ns, open: { ...open, status: 'running', startedAt: event.ts, worktree: str('worktree'), branch: str('branch'), base: str('base') } }), effects: [] };
  }

  if (event.type === 'job:finished' && open?.id === jobId) {
    const outcome = payload.outcome === 'done' ? 'done' : payload.outcome === 'stopped' ? 'stopped' : 'failed';
    const extra: Partial<NightJob> = {};
    if (typeof payload.commits === 'number') extra.commits = payload.commits;
    if (typeof payload.costUsd === 'number') extra.costUsd = payload.costUsd;
    if (typeof payload.note === 'string' && payload.note.trim() !== '') extra.note = payload.note.trim().slice(0, 600);
    return close(state, ns, open, outcome, event.ts, event.id, extra);
  }

  if (event.type === 'agent:fleet' && open && (open.status === 'running' || open.status === 'waiting')) {
    const tail = jobFolderTail(open.id);
    const session = (state.agent.fleet ?? []).find((s) => s.cwd === open.worktree || s.cwd.endsWith(tail) || s.cwd.includes(`${tail}/`));
    if (!session) return { state, effects: [] };
    const job: NightJob = { ...open, ...(typeof session.costUsd === 'number' ? { costUsd: session.costUsd } : {}), seenWorking: open.seenWorking || session.state === 'working' || session.state === 'tool' };
    if (jobs && typeof job.costUsd === 'number' && job.costUsd >= jobs.maxUsdPerJob) return stop(state, { ...ns, open: job }, job, 'budget', event.ts);
    // The turn is over (or ended on an error): collect the result.
    if ((session.state === 'waiting' && job.seenWorking) || session.state === 'failed') {
      return { state: put(state, { ...ns, open: { ...job, status: 'finishing', openedAt: event.ts } }), effects: [notify({ action: 'finish', jobId: job.id, failed: session.state === 'failed' })] };
    }
    const status = OWNER_WAITS.includes(session.state) ? 'waiting' : 'running';
    return { state: put(state, { ...ns, open: { ...job, status } }), effects: [] };
  }

  if (event.type !== 'clock:tick') return { state, effects: [] };
  const now = Date.parse(event.ts);

  if (open) {
    // Switched off with a job under way: it stops.
    // Already stopping: fall through, so a runner that never answers still times out.
    if ((!on(state) || !jobs) && open.status !== 'stopping') return open.status === 'starting' ? close(state, ns, open, 'stopped', event.ts, event.id, { stopReason: 'switched-off' }) : stop(state, ns, open, 'switched-off', event.ts);
    const since = Date.parse(open.openedAt ?? open.requestedAt);
    // The runner did not answer: free the slot.
    if ((open.status === 'starting' || open.status === 'finishing' || open.status === 'stopping') && now - since > RUNNER_REPLY_MS) return close(state, ns, open, open.status === 'stopping' ? 'stopped' : 'failed', event.ts, event.id, { note: 'the runner did not answer' });
    if (jobs && (open.status === 'running' || open.status === 'waiting') && now - Date.parse(open.startedAt ?? event.ts) > jobs.maxMinutes * 60_000) return stop(state, ns, open, 'time', event.ts);
    return { state, effects: [] };
  }

  if (!on(state) || !jobs || ns.queue.length === 0 || !ownerIsAway(state)) return { state, effects: [] };
  const night = nightOf(event.ts, state.config.timezone);
  const tonight = ns.night === night ? ns : { ...ns, night, countTonight: 0, spentUsdTonight: 0 };
  if (tonight.countTonight >= jobs.maxJobsPerNight || tonight.spentUsdTonight >= jobs.maxUsdPerNight) return tonight === ns ? { state, effects: [] } : { state: put(state, tonight), effects: [] };
  const [job, ...rest] = tonight.queue;
  const starting: NightJob = { ...job, status: 'starting', openedAt: event.ts };
  return {
    state: put(state, { ...tonight, queue: rest, open: starting, countTonight: tonight.countTonight + 1 }),
    effects: [notify({ action: 'start', job: { id: job.id, repo: job.repo, subject: job.subject, brief: job.brief }, folder: short(job.id), maxMinutes: jobs.maxMinutes })],
  };
};
