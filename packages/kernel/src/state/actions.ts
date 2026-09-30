// lane E (#12): the night shift's jobs. W3: the executor's action effects and what they report into.
import type { ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import type { WorkJob } from '../types.js';

/** The night shift's switch and caps, resolved from `config.jobs`. See `SundialConfigFile.jobs`. */
export type NightJobsConfig = ResolvedSundialConfig['jobs'];

/**
 * `queued` → `starting` (the runner was asked) → `running` / `waiting` (the
 * fleet shows the session working, or waiting on the owner: a permission, a
 * question, a plan) → `finishing` / `stopping` (the runner was asked to collect
 * or to stop) → `done` / `failed` / `stopped`.
 */
export type NightJobStatus = 'queued' | 'starting' | 'running' | 'waiting' | 'finishing' | 'stopping' | 'done' | 'failed' | 'stopped';

export interface NightJob {
  id: string;
  /** The project root, as `state.project.known` keys it. The job never runs here: it runs in `worktree`. */
  repo: string;
  project: string;
  subject: string;
  brief: string;
  requestedAt: string;
  status: NightJobStatus;
  /** When the runner was asked to start it, and when it said it had. */
  openedAt?: string;
  startedAt?: string;
  /** Reported by the runner: the worktree Sundial made, its branch, and the commit it started from. */
  worktree?: string;
  branch?: string;
  base?: string;
  /** The fleet showed the session working at least once; a turn over before that is not the end. */
  seenWorking?: boolean;
  costUsd?: number;
  /** Why it was asked to stop: `owner`, `budget`, `time`, `switched-off`. */
  stopReason?: string;
  closedAt?: string;
  commits?: number;
  note?: string;
}

export interface NightShiftState {
  queue: NightJob[];
  open: NightJob | null;
  /** Closed jobs, newest last, bounded. */
  recent: NightJob[];
  /** The night the counters are for (the local date of the evening it began), and what it has used. */
  night: string | null;
  countTonight: number;
  spentUsdTonight: number;
}

/** W3: what the rejudge job (J2.6) is asked to do. */
export interface RejudgeOptions {
  all?: boolean;
  limit?: number;
  bench?: number;
  pack?: number;
  sinceDays?: number;
}

/** W3: the rejudge job as the fold holds it — `rejudge:requested` opens it, `rejudge:finished` closes it. */
export interface RejudgeState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  calls: number;
  failedCalls: number;
  error: string | null;
  /** A `bench` run's packing report instead of judgements. */
  bench: Record<string, unknown> | null;
  options: RejudgeOptions;
}

/** W3: run the rejudge job off the lane, a budget reservation per pack; it answers with `rejudge:finished`. */
export interface RunRejudgeEffect {
  type: 'RunRejudge';
  options: RejudgeOptions;
}

/**
 * W3: start a night job (the runner makes the worktree and the tmux session).
 * At-most-once: a replayed start with a `started` row is abandoned, never run
 * twice; `nightShift` fails the job at `RUNNER_REPLY_MS`. Answers `job:started`,
 * or `job:finished failed` when no runner is loaded or it refused.
 */
export interface StartJobEffect {
  type: 'StartJob';
  job: { id: string; repo: string; subject: string; brief: string };
  folder: string;
  maxMinutes: number;
}

/** W3: stop the open night job and collect what it left. At-least-once. Answers `job:finished` with `outcome`. */
export interface StopJobEffect {
  type: 'StopJob';
  jobId: string;
  outcome: 'done' | 'failed' | 'stopped';
  reason?: string;
}

/**
 * W3: run one work job as a subagent (or on the Claude hand). At-most-once, as
 * `StartJob`; `workbench` times it out at `JOB_TIMEOUT_MS`. Answers
 * `work:started {jobId, childId}`, or `work:closed failed` when refused; a
 * child that ends without reporting is closed `failed` when it ends.
 */
export interface StartSubagentEffect {
  type: 'StartSubagent';
  job: WorkJob;
}

/** W3: abort a running work job's child (the owner's Stop). At-least-once. Answers `work:closed failed`. */
export interface StopSubagentEffect {
  type: 'StopSubagent';
  jobId: string;
}

/** W3: the effects that act rather than record. */
export type ActionEffect = RunRejudgeEffect | StartJobEffect | StopJobEffect | StartSubagentEffect | StopSubagentEffect;

/** KernelState's Actions fields; `KernelState` extends this. */
export interface ActionsSlices {
  // lane E (#12)
  /**
   * The night shift: supervised Claude Code jobs, each in its own git worktree.
   * Single writer: `nightShift`. Optional: older snapshots predate it. Nothing
   * enters it, and nothing starts, while `config.jobs.enabled` is off.
   */
  nightShift?: NightShiftState;
}
