import type { LlmPurpose, Rule } from '@sundial/kernel/types.js';

interface LlmDispatchedPayload {
  purpose: LlmPurpose;
}

/**
 * Reacts to the executor's synthetic `llm:dispatched` event, emitted right
 * before `dispatchScheduleLLM`/`dispatchRunReflection` actually fire a call
 * (fixes A§1.3). Budget spends used to mutate the daemon's module-level
 * `state` directly in the executor — invisible to the log, unrecoverable
 * across a crash-restart loop, and not derivable by replay. The executor now
 * only ever *reads* `state.budgets`; this rule is the only writer, so a
 * spend is durable the same way every other state change is: it went
 * through `reduce()` as a logged event.
 */
export const budgetTrack: Rule = (state, event) => {
  // `llm:dispatched` spends a slot (+1); `llm:refunded` returns one (−1, floored
  // at 0) when a detached call turns out to be a no-op it couldn't cheaply
  // pre-check first — journal/project-status only learn there was nothing to
  // write after building their full context, so they spend, detach, and refund
  // if empty (see the daemon dispatchers). Both go through the log, so the
  // refund is as durable/replay-safe as the spend.
  if (event.type !== 'llm:dispatched' && event.type !== 'llm:refunded') return { state, effects: [] };

  const { purpose } = event.payload as unknown as LlmDispatchedPayload;
  // A purpose this state does not track. The log is append-only and outlives
  // the enum: `narrate` and `knowledge` were retired on 2026-09-10 and their
  // dispatch events are still in it, so a full replay reaches this line with a
  // key that no longer exists. Reading `.callsToday` off the missing entry
  // threw, which would take the whole fold down on a history the kernel is
  // supposed to be able to rebuild from at any time.
  const current = state.budgets.byPurpose[purpose];
  if (current === undefined) return { state, effects: [] };
  const callsToday = Math.max(0, current.callsToday + (event.type === 'llm:dispatched' ? 1 : -1));

  return {
    state: {
      ...state,
      budgets: { ...state.budgets, byPurpose: { ...state.budgets.byPurpose, [purpose]: { callsToday } } },
    },
    effects: [],
  };
};
