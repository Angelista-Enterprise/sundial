/**
 * Set 5 R1: the task of one chat, and how its turn ended. `state.task` is the newest request of any chat; `state.tasks`
 * keys each chat's own (taskBoundary folds both), so a side thread or a second chat no longer overwrites the main task.
 *
 * Plain structural types, so the plugins (which read the kernel's state as data) and the kernel read the same thing.
 */

export type TaskOutcome = 'done' | 'partial' | 'failed' | 'stopped';
export const TASK_OUTCOMES: ReadonlySet<string> = new Set<TaskOutcome>(['done', 'partial', 'failed', 'stopped']);

/** The line a turn gets, once per task, when it ends with its newest step refused and no final act (task-end.js). */
export const FINISH_NUDGE = 'The task is not finished. Go on from the window as it is, or say what stops you.';

/** Where the nudge comes from (task-end.js steers it with this source): a queued one is found by it. */
export const NUDGE_SOURCE = { kind: 'sundial-llm-openai', form: 'notice', summary: 'The task is not finished' } as const;

interface Queued { readonly id?: unknown; readonly source?: { readonly kind?: unknown; readonly summary?: unknown } | null }
/**
 * Review S5R1: a nudge steered in the instant before the owner pressed Stop, or sent new words, still waits in the chat's inbox and would
 * ride into the next turn. The Stop and the new /turn drop it (api-sessions.js), from both of dsh's lists.
 */
export function dropNudges(inbox: { readonly nextStep?: readonly Queued[]; readonly nextTurn?: readonly Queued[]; remove?: (id: string) => unknown } | null | undefined): void {
  for (const m of [...(inbox?.nextStep ?? []), ...(inbox?.nextTurn ?? [])])
    if (m?.source?.kind === NUDGE_SOURCE.kind && m.source.summary === NUDGE_SOURCE.summary && typeof m.id === 'string') inbox?.remove?.(m.id);
}

export interface TaskLike {
  id: string;
  at: string;
  session: string;
  said?: string;
  corrected?: { at: string; session: string; text: string };
  did?: string[];
  failed?: string[];
  open?: string[];
  newest?: 'did' | 'failed';
  guarded?: boolean;
  nudged?: string;
  ended?: { at: string; outcome: string };
  afterTurn?: number;
}
interface Asked { sessionId: string; kind: string; at?: string; answeredAt?: string; answer?: string }
export interface TaskHost<T extends TaskLike = TaskLike> {
  task?: T | null;
  tasks?: Record<string, T>;
  approvals?: { open?: readonly Asked[]; recent?: readonly Asked[] };
}

/**
 * Every chat's task. A snapshot from before Set 5 holds only `task`: it reads as that chat's (migrate on read), and the
 * rule writes the keyed shape from its first event on.
 */
export function allTasks<T extends TaskLike>(state: TaskHost<T> | null | undefined): Record<string, T> {
  const tasks = state?.tasks ?? {};
  const one = state?.task;
  return one && !tasks[one.session] ? { ...tasks, [one.session]: one } : tasks;
}

/** This chat's task, or null. Never another chat's. */
export function taskOf<T extends TaskLike>(state: TaskHost<T> | null | undefined, session: unknown): T | null {
  return typeof session === 'string' && session !== '' ? (allTasks(state)[session] ?? null) : null;
}

/** The owner stopped the act: their hands on the keys or the mouse, or their words mid-turn (owner-hand.js reasons). */
const BY_OWNER = /refused, (owner-hand|owner-moved|corrected)\b/;
const sinceTask = (task: TaskLike, a: Asked) => (a.answeredAt ?? a.at ?? '') >= task.at;

/**
 * Review S5R1 H2: the refusals the model can get past by itself (look again, pick another thing, wait for the app), the only ones
 * the nudge may follow. An allow-list: a reason not named here (the owner's own text, a private app, no access, a cut, a stop, a
 * refused shell command, a reason a later build adds) never gets "go on".
 */
const RECOVERABLE: ReadonlySet<string> = new Set([
  'not-found', 'look again', 'covered', 'slow', 'app-changed', 'not-responding', 'no-window', 'not-running', 'no-such-window', 'no-such-app',
  'no-such-tab', 'not-that-tab', 'ambiguous', 'ambiguous-tab', 'no-menu-item', 'submenu', 'not-picked', 'not-in-text', 'unknown-action',
  'unknown-key', 'focus-unknown', 'bad-click', 'rename-not-seen', 'no-rename-box',
]);
const REFUSED = ': refused, ';
/** A failed line (task-boundary.ts) the model may recover from: a step refused for a reason above, or a command that exited non-zero. */
export const recoverable = (line: string) => {
  const at = line.lastIndexOf(REFUSED);
  return at >= 0 ? RECOVERABLE.has(line.slice(at + REFUSED.length)) : !line.startsWith('look at ') && / exited -?\d+(: |$)/.test(line);
};

/** Review S5R1 H2: the owner said no to an ask of this chat since its task began, of any kind (a plain act and an egress too). */
const refusedSince = (state: TaskHost | null | undefined, task: TaskLike) =>
  (state?.approvals?.recent ?? []).some((a) => a.sessionId === task.session && a.answer === 'rejected' && sinceTask(task, a));

/** Whether a final (a send, a delete ...) was answered in this chat since its task began, or an ask still waits there. */
function finalSince(state: TaskHost | null | undefined, task: TaskLike): boolean {
  const mine = (a: Asked) => a.sessionId === task.session;
  return (state?.approvals?.open ?? []).some(mine) || (state?.approvals?.recent ?? []).some((a) => mine(a) && a.kind !== 'plain' && sinceTask(task, a));
}

/** The task's newest step was refused, the owner did not stop it, and no final act or ask came after its start. */
function leftUndone(state: TaskHost | null | undefined, task: TaskLike): boolean {
  return task.newest === 'failed' && !BY_OWNER.test(task.failed?.at(-1) ?? '') && !finalSince(state, task);
}

/** One event of a chat's own dsh log, as far as the nudge reads it. */
export interface ChatEvent {
  readonly type?: string;
  readonly time?: unknown;
  readonly data?: { readonly message?: { readonly isError?: unknown } | null; readonly turn?: unknown } | null;
}

/**
 * The newest turn number in a chat's dsh log (its newest `turn/start`), 0 for a log with none. The route that takes the owner's
 * words writes it on `task:started` as `afterTurn`: every turn of the chat numbered above it is that task's, every turn at or below
 * it began before. Undefined when there is no log to read, or its newest `turn/start` carries no number.
 */
export function lastTurn(events: readonly ChatEvent[] | null | undefined): number | undefined {
  if (!Array.isArray(events)) return undefined;
  const starts = events.filter((e: ChatEvent | undefined) => e?.type === 'turn/start');
  return starts.length === 0 ? 0 : turnOf(starts[starts.length - 1]);
}

/** A task from before `afterTurn` is bound by clock. The kernel stamps `task:started` when its lane folds it, a few ms after dsh's `turn/start`. */
const CLOCK_SLACK_MS = 5_000;
const turnOf = (e: ChatEvent | undefined) => (typeof e?.data?.turn === 'number' ? e.data.turn : undefined);

/**
 * Review S5R1 L2: the chat's task when the ending turn (`turn`, dsh's number on its `turn/start`) is that task's, else null. A turn
 * withdrawn as stale (api-sessions.js) can end after the next request's `task:started`: its end belongs to the task before.
 *
 * Bound by identity: a task with `afterTurn` owns every turn numbered above it. Bound by clock (`turn/start` before `task.at`),
 * every turn was refused, because dsh logs `turn/start` a few ms before the kernel stamps the row: no `task:ended` was written
 * from 2026-11-16 18:15Z on. A task from before `afterTurn` falls back to the clock, with CLOCK_SLACK_MS. A log with no
 * `turn/start` reads as the chat's task, as before.
 */
export function taskOfTurn<T extends TaskLike>(state: TaskHost<T> | null | undefined, session: unknown, events: readonly ChatEvent[] | null | undefined, turn?: unknown): T | null {
  const task = taskOf(state, session);
  if (task === null) return null;
  if (typeof task.afterTurn === 'number' && typeof turn === 'number') return turn > task.afterTurn ? task : null;
  const starts = (events ?? []).filter((e) => e?.type === 'turn/start').reverse();
  const start = Number((starts.find((e) => turn !== undefined && turn !== null && e.data?.turn === turn) ?? starts[0])?.time);
  return Number.isFinite(start) && start < Date.parse(task.at) - CLOCK_SLACK_MS ? null : task;
}

/**
 * Review S5R1 H1: whether the running turn is the task's own, from the chat's log: a turn of the task began, and none of its turns
 * ended. A notice turn, a brought-in thread, any later turn of the chat is not: the task's own turn ended before it. By identity
 * (`afterTurn`), so the end of a stale turn the request withdrew does not count. A task from before it, by clock: no turn of the
 * chat ended since the task began. A `turn/end` with no number (by clock: no time) counts as the task's (no nudge).
 */
export function ownTurn(events: readonly ChatEvent[] | null | undefined, task: Pick<TaskLike, 'at' | 'afterTurn'>): boolean {
  const list = events ?? [];
  const after = task.afterTurn;
  if (typeof after === 'number')
    return list.some((e) => e?.type === 'turn/start' && (turnOf(e) ?? 0) > after) && !list.some((e) => e?.type === 'turn/end' && !((turnOf(e) ?? Infinity) <= after));
  const since = Date.parse(task.at);
  return Number.isFinite(since) && list.some((e) => e?.type === 'turn/start') && !list.some((e) => e?.type === 'turn/end' && !(Number(e.time) < since));
}

/** Review S5R1 M1: whether the running turn's newest tool result is an error. A clean shell run, a fetch or a file write after a refusal is not. */
export function lastToolFailed(events: readonly ChatEvent[] | null | undefined): boolean {
  const list = events ?? [];
  const types = list.map((e) => e?.type);
  const start = types.lastIndexOf('turn/start');
  const last = types.lastIndexOf('tool/result');
  return start >= 0 && last > start && list[last]?.data?.message?.isError === true;
}

/**
 * Set 5 R1: whether this chat's turn, about to end, gets the finish nudge: left undone, never nudged before in this task, and
 * never once the owner has spoken into it mid-turn (`corrected`): the owner leads then, not the nudge.
 *
 * Review S5R1: only in the task's own turn, before it ended (H1); only when every failed line of the task is one the model can
 * recover from and no ask of the task was refused (H2), and none was ever (`guarded`: the list keeps only the newest lines); only when the turn's newest tool result is an error (M1). `events`: the
 * chat's dsh log; none, no nudge.
 */
export function needsNudge(state: TaskHost | null | undefined, session: unknown, events: readonly ChatEvent[] | null | undefined): boolean {
  const task = taskOf(state, session);
  return (
    task !== null &&
    task.nudged === undefined &&
    task.ended === undefined &&
    task.corrected === undefined &&
    ownTurn(events, task) &&
    lastToolFailed(events) &&
    task.guarded !== true &&
    (task.failed ?? []).every(recoverable) &&
    !refusedSince(state, task) &&
    leftUndone(state, task)
  );
}

/**
 * How a chat's turn ended, from dsh's `turn/end` reason and the chat's task: `task:ended`'s outcome. `events`, the chat's log: a turn
 * whose newest tool result is not an error did not end on a refusal (Review S5R1 M1: a clean shell finish after a refused step).
 */
export function outcomeOf(state: TaskHost | null | undefined, session: unknown, reason: { kind?: unknown } | null | undefined, events?: readonly ChatEvent[] | null): TaskOutcome {
  if (reason?.kind === 'aborted') return 'stopped';
  if (reason?.kind === 'error' || reason?.kind === 'blocked') return 'failed';
  const task = taskOf(state, session);
  if (task === null) return 'done';
  if (BY_OWNER.test(task.failed?.at(-1) ?? '') && task.newest === 'failed') return 'stopped';
  if (leftUndone(state, task) && (events === undefined || events === null || lastToolFailed(events))) return (task.did?.length ?? 0) > 0 ? 'partial' : 'failed';
  return (task.open?.length ?? 0) > 0 ? 'partial' : 'done';
}
