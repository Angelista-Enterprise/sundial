// Round 2 (B3): what Gnomon is doing right now, one view over the slices the log folds: the owner's task,
// the last look and act on the screen, the approvals it waits on and the last answers. Every surface that
// asks "what is it doing" reads this, so a restart (snapshot + log tail) gives every surface the same answer.
import type { StoredSignal } from '@sundial/db/index.js';
import { localDate, localDayRange } from '@sundial/helpers/local-day.js';
import type { ApprovalAnswer, ApprovalAsk, KernelState } from '../types.js';
import { allTasks } from '@sundial/helpers/task-of.js';
import { isRigSession } from './rig-session.js';

/** How long the shell holds an approval open before it answers `rejected` for the owner (host/server.js). */
export const APPROVAL_TTL_MS = 300_000;
/** When the fold closes an ask nobody answered, not even the shell's timer (it went down): a minute past the TTL, so the shell's own row comes first. */
export const APPROVAL_GONE_MS = APPROVAL_TTL_MS + 60_000;

/** The asks still open at `now`, oldest first; of one chat when `sessionId` is given. */
export function openApprovals(state: KernelState | null | undefined, now: number, sessionId?: string): ApprovalAsk[] {
  return (state?.approvals?.open ?? []).filter((a) => now - Date.parse(a.at) < APPROVAL_GONE_MS && (sessionId === undefined || a.sessionId === sessionId));
}

export interface Doing {
  task: KernelState['task'];
  look: NonNullable<KernelState['marks']>['lastLook'] | null;
  act: NonNullable<KernelState['marks']>['lastAct'] | null;
  asks: ApprovalAsk[];
  /** The last answers, newest last: at most 10. */
  allowed: ApprovalAnswer[];
}

/**
 * Set 5 R1: the owner's task, what "what is it doing" names: the newest task of the owner's own chats. `state.task` is the
 * newest of ANY chat, so a rig or sandbox chat's request would stand in for the owner's; those chats are left out here.
 */
export function ownerTask(state: KernelState | null | undefined): KernelState['task'] {
  const mine = Object.values(allTasks(state)).filter((t) => !isRigSession(state, t.session));
  return mine.reduce<KernelState['task']>((a, t) => (!a || t.at > a.at ? t : a), null);
}

export function readDoing(state: KernelState | null | undefined, now: number): Doing {
  return {
    task: ownerTask(state),
    look: state?.marks?.lastLook ?? null,
    act: state?.marks?.lastAct ?? null,
    asks: openApprovals(state, now),
    allowed: (state?.approvals?.recent ?? []).slice(-10),
  };
}

/** Round 5: the day in one line, for Today and the Ledger: the steps Gnomon took on screen, in how many apps, the asks, the owner's yeses. */
export interface DayCounts {
  steps: number;
  apps: number;
  asked: number;
  yes: number;
}
export interface DayDoing extends DayCounts {
  /** "Gnomon did 12 steps in 3 apps today, asked 4 times, you said yes 3.", or null on a day it did nothing and asked nothing. */
  line: string | null;
  /** Set 4 R2: one chat's own counts, only when asked for by id (`?session=` on the Ledger); a rig chat's included. */
  session?: DayCounts & { id: string };
}

/** The log rows the day's line counts. */
export const DAY_TYPES = ['screen:step', 'approval:asked', 'approval:answered'];
type Row = Pick<StoredSignal, 'signalType' | 'eventType' | 'data'>;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sessionOf = (r: Row) => r.data.session ?? r.data.sessionId;

/** Steps, apps, asks and yeses in `rows`; `yes` counts the allowed answers of whoever `by` admits. */
function countsOf(rows: readonly Row[], by: (who: unknown) => boolean): DayCounts {
  const of = (type: string) => rows.filter((r) => `${r.signalType}:${r.eventType}` === type);
  const steps = of('screen:step');
  const apps = new Set(steps.map((r) => String(r.data.processName ?? '').trim().toLowerCase()).filter(Boolean)).size;
  const yes = of('approval:answered').filter((r) => by(r.data.by) && String(r.data.answer ?? '').startsWith('allowed')).length;
  return { steps: steps.length, apps, asked: of('approval:asked').length, yes };
}

/**
 * Counts the day's rows of the owner's own chats: a rig session's steps and asks look exactly like the owner's, so they go.
 * Read from the log, not `state.approvals`: that slice keeps the last 50 answers, and a busy day can hold more.
 * Set 4 R2: `session` adds that one chat's counts (`session`), a rig chat's too, its yeses by whoever answered (the rig's
 * yes-clicker in a rig chat); the owner's counts and line are the same with or without it.
 */
export function dayDoing(state: KernelState | null | undefined, rows: readonly Row[], session?: string | null): DayDoing {
  const owner = countsOf(rows.filter((r) => !isRigSession(state, sessionOf(r))), (by) => by === 'owner');
  const line = owner.steps || owner.asked ? `Gnomon did ${plural(owner.steps, 'step')} in ${plural(owner.apps, 'app')} today, asked ${plural(owner.asked, 'time')}, you said yes ${owner.yes}.` : null;
  const one = typeof session === 'string' && session !== '' ? { session: { id: session, ...countsOf(rows.filter((r) => sessionOf(r) === session), () => true) } } : {};
  return { ...owner, line, ...one };
}

/** Today's line, by the owner's clock: the rows from local midnight to `now`. `rows` is the log query (db getAllSignalsInRange): rules import this module, so it never imports the db. */
export async function readDayDoing({ state, now, timeZone, rows, session = null }: { state: KernelState | null | undefined; now: number; timeZone: string; rows: (from: string, to: string, types: string[]) => Promise<Row[]>; session?: string | null }): Promise<DayDoing> {
  const { start } = localDayRange(localDate(new Date(now).toISOString(), timeZone), timeZone);
  return dayDoing(state, await rows(start, new Date(now + 5_000).toISOString(), DAY_TYPES), session);
}
