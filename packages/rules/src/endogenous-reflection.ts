import type { Rule } from '@sundial/kernel/types.js';

/** Drive level at which surprise is worth reflecting on early, rather than waiting for midnight. */
const DRIVE_THRESHOLD = 15;
/** At most one endogenous reflection this often — keeps a bursty day from spawning a stream of them. */
const MIN_INTERVAL_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Phase 1 endogenous-life (docs/design/08-endogenous-life.md §3) — the deferred
 * early-reflection trigger the original design specified (doc 05 §2) but never
 * wired, because nothing populated `accumulatedImportance`. Now that
 * `surpriseDrive` feeds it, this is the system's first genuinely SPONTANEOUS,
 * self-initiated behavior: on a `clock:tick`, if accumulated surprise has
 * crossed `DRIVE_THRESHOLD`, reflect early instead of waiting for the daily
 * `day:boundary`.
 *
 * Gated to stay a pet, not a pest (decisions D2/D11):
 *  - only when the user is IDLE (`lifeEvent.idle.isIdle`) — never interrupt
 *    active work; heavy autonomous work happens while they're away;
 *  - rate-limited to once per `MIN_INTERVAL_MS`.
 *
 * Consuming the drive resets the accumulator to 0 and advances BOTH the shared
 * reflection cursor (`memory.lastReflectionAt`, so the next daily/endogenous
 * `since` window is correct) and the endogenous rate-limit cursor
 * (`mind.lastEndogenousReflectionAt`). Emits `RunReflection` with
 * `reason: 'endogenous'` so the executor gives it a distinct dedupeKey and it
 * persists alongside the daily reflection.
 *
 * Rides `clock:tick` — no hidden timer, ordinary event-sourced state (doc 00).
 */
export const endogenousReflection: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };
  if (state.memory.accumulatedImportance < DRIVE_THRESHOLD) return { state, effects: [] };
  if (!state.lifeEvent.idle.isIdle) return { state, effects: [] };

  const last = state.mind.lastEndogenousReflectionAt;
  if (last && Date.parse(event.ts) - Date.parse(last) < MIN_INTERVAL_MS) return { state, effects: [] };

  const since = state.memory.lastReflectionAt ?? new Date(Date.parse(event.ts) - DAY_MS).toISOString();

  return {
    state: {
      ...state,
      memory: { ...state.memory, accumulatedImportance: 0, lastReflectionAt: event.ts },
      mind: { ...state.mind, lastEndogenousReflectionAt: event.ts },
    },
    effects: [{ type: 'RunReflection', since, ts: event.ts, reason: 'endogenous' }],
  };
};
