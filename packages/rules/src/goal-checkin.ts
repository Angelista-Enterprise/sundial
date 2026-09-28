import type { GoalProgressEntry, KernelState, Rule } from '@sundial/kernel/types.js';
import { deriveId } from '@sundial/helpers/derive-id.js';

/** Statuses that mean a goal is no longer live. */
const CLOSED_STATUSES = new Set(['done', 'dropped', 'abandoned', 'cancelled', 'canceled', 'completed', 'achieved']);

/** Open goals as the fold currently believes them: `goal:<slug>:status` cursor entries whose object is not a closed status. */
export function openGoals(factCursor: Record<string, { object: string | null } | undefined>): { entityId: string; name: string; status: string }[] {
  const out: { entityId: string; name: string; status: string }[] = [];
  for (const [key, entry] of Object.entries(factCursor)) {
    if (!key.startsWith('goal:') || !key.endsWith(':status')) continue;
    const object = entry?.object;
    if (typeof object !== 'string' || object === '') continue;
    // "done — easy to toggle, like Notion" is done: the status word leads, the owner's note follows a dash.
    if (CLOSED_STATUSES.has(object.trim().toLowerCase().split(/\s*[—–-]\s+/)[0])) continue;
    const entityId = key.slice(0, -':status'.length);
    out.push({ entityId, name: entityId.slice('goal:'.length).replace(/-/g, ' '), status: object });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A goal as the judge should read it (J2.7): its name, and the owner's own
 * words where the status carries them ("open — capture what is shared on
 * screen…"). A bare status word adds nothing and is left off.
 */
export function goalLabel(goal: { name: string; status: string }): string {
  const detail = goal.status.replace(/^(open|active|paused|in progress)\s*[—–-]\s*/i, '').trim();
  return /^[\w ]{1,12}$/.test(detail) ? goal.name : `${goal.name} — ${detail}`;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded per goal: the check-in cites a week, and twenty sessions is more than a week holds for one goal. */
const MAX_PROGRESS_PER_GOAL = 20;

/** The week's sessions the judge credited to a goal. */
export function weekProgress(entries: GoalProgressEntry[] | undefined, now: string): { sessions: number; minutes: number; momentIds: string[] } {
  const since = Date.parse(now) - WEEK_MS;
  const week = (entries ?? []).filter((e) => Date.parse(e.ts) >= since);
  return { sessions: week.length, minutes: week.reduce((sum, e) => sum + e.minutes, 0), momentIds: week.map((e) => e.momentId) };
}

/**
 * J2.7 — folds `goal:progress` into `state.goals.progress`. One entry per
 * moment the fan-out credited to a goal; the same moment twice (a replayed
 * result) is one entry.
 */
export const goalProgressTrack: Rule = (state, event) => {
  if (event.type !== 'goal:progress') return { state, effects: [] };
  const payload = event.payload as { goalId?: unknown; momentId?: unknown; p?: unknown; minutes?: unknown };
  if (typeof payload.goalId !== 'string' || typeof payload.momentId !== 'string' || typeof payload.p !== 'number') return { state, effects: [] };
  const existing = state.goals.progress[payload.goalId] ?? [];
  if (existing.some((e) => e.momentId === payload.momentId)) return { state, effects: [] };
  const entry: GoalProgressEntry = { momentId: payload.momentId, ts: event.ts, p: payload.p, minutes: typeof payload.minutes === 'number' ? payload.minutes : 0 };
  const goals: KernelState['goals'] = { ...state.goals, progress: { ...state.goals.progress, [payload.goalId]: [...existing, entry].slice(-MAX_PROGRESS_PER_GOAL) } };
  return { state: { ...state, goals }, effects: [] };
};

function localWeekday(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date(iso));
  }
}

/**
 * Once a week, on the first day boundary of Monday, ask the owner about their
 * open goals — which got time, which to pause or drop. Nothing here links a
 * day's work to a goal by itself (that is a later fold); the question is the
 * cheapest honest way to keep the goal tier alive, and the answer flows back
 * through the conversation pass as `status` assertions the owner made.
 *
 * Goals are read from `memory.factCursor`, the fold's own belief about
 * `goal:*:status`, not from the database — a rule reads state and an event.
 */
export const goalCheckin: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };
  if (localWeekday(event.ts, state.config.timezone) !== 'Monday') return { state, effects: [] };
  if (state.ownerAsk.open !== null) return { state, effects: [] };
  const goals = openGoals(state.memory.factCursor);
  if (goals.length === 0) return { state, effects: [] };

  const names = goals.slice(0, 6).map((goal) => goal.name);
  // J2.7: what the judge saw each goal get this week — sessions, not a guess.
  const cited = goals.slice(0, 6).map((goal) => ({ goal, week: weekProgress(state.goals.progress[goal.entityId], event.ts) }));
  const lines = cited.map(({ goal, week }) => (week.sessions === 0 ? `${goal.name} (no time seen)` : `${goal.name} (${week.sessions} session${week.sessions === 1 ? '' : 's'}, ${Math.round(week.minutes / 60) >= 1 ? `${Math.round(week.minutes / 60)} h` : `${week.minutes} min`})`));
  return {
    state,
    effects: [
      {
        type: 'EmitEvent',
        event: {
          id: deriveId(event.ts, event.id, 'goal-checkin'),
          type: 'ask:owner-opened',
          ts: event.ts,
          payload: {
            askId: `owner-ask:goals-${event.ts.slice(0, 10)}`,
            question: `New week. Your open goals: ${lines.join('; ')}. Which got real time last week, and should any be paused or dropped?`,
            reason: `${goals.length} open goal${goals.length === 1 ? '' : 's'} on record; session counts are what the judge credited to each goal this week`,
            choices: names.length >= 2 ? names.slice(0, 4) : [],
            // The moments behind each count, so the answer can be checked against the record.
            evidence: Object.fromEntries(cited.filter(({ week }) => week.sessions > 0).map(({ goal, week }) => [goal.entityId, week.momentIds])),
          },
        },
      },
    ],
  };
};
