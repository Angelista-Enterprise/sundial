import type { Rule } from '@sundial/kernel/types.js';

/**
 * How many beliefs go up for refutation in one pass.
 *
 * Small on purpose. This is the only path in the system whose job is to make
 * core memory SMALLER, and a skeptic that gets through the whole fact table
 * every night is one whose false positives compound as fast as its true ones.
 * Five is also cheap enough that the pass never competes with the journal for
 * the day's budget.
 */
const SAMPLE_SIZE = 5;

/** At most one pass a day, even if the daemon is restarted or ticks oddly across a boundary. */
const MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/**
 * The adversarial half of core memory.
 *
 * Every other path into belief is corroborative. `entityExtract` proposes what
 * it saw, `contradictionCheck` promotes what recurred, `factConfidenceDecay`
 * lets the unreconfirmed drift toward uncertainty. Nothing has ever tried to
 * show a confirmed fact FALSE — so a belief that was wrong when it was written
 * does not get corrected, it fades slowly while still being read, and every
 * answer drawn from it inherits the error. That is the compounding-error risk
 * `decisions/assistant-as-an-event-source` names as the main consequence of
 * letting an assistant write back what it concludes.
 *
 * Gated the same way `endogenousReflection` gates its own autonomous work, and
 * for the same reason (D2/D11 — heavy background work happens while the owner
 * is away, never in the middle of their afternoon):
 *
 *  - circadian night only, so the model calls land when nothing is competing;
 *  - the owner must be idle;
 *  - at most one pass per `MIN_INTERVAL_MS`.
 *
 * **The skeptic gets no privileged write.** It does not lower a confidence and
 * it does not retract anything. A successful refutation becomes an ordinary
 * `entity:fact-candidate` for the NEGATION, carried by the executor through the
 * same `contradictionCheck` gate a sensor's observation goes through, with
 * `provenance: 'assistant'`. Belief stays replayable from evidence rather than
 * from whatever a model said one night, and `contradictionCheck` stays the
 * single writer.
 *
 * Rides `clock:tick` rather than `day:boundary`, unlike `nightlyFactExtract`.
 * The boundary fires at midnight whether or not the owner is at the desk, and
 * this pass wants the idle gate — which is a condition on a moment, not on a
 * date.
 */
export const nightlyRefutation: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };
  // On unless the owner turned it OFF (default flipped 2026-09-07, after the
  // owner marked twelve wrong facts by hand that a running skeptic exists to
  // catch). The destructive failure here is still a FALSE refutation, and
  // `measure-skeptic.ts` is still how that rate is established — the trade is
  // now deliberate rather than deferred. `refutationEnabled: false` in
  // ~/.sundial/config.json turns it back off.
  if (!state.config.refutationEnabled) return { state, effects: [] };
  if (state.mind.circadian !== 'night') return { state, effects: [] };
  if (!state.lifeEvent.idle.isIdle) return { state, effects: [] };

  const last = state.memory.lastRefutationAt;
  if (last !== null && Date.parse(event.ts) - Date.parse(last) < MIN_INTERVAL_MS) return { state, effects: [] };

  return {
    state: { ...state, memory: { ...state.memory, lastRefutationAt: event.ts } },
    effects: [{ type: 'RunRefutation', sampleSize: SAMPLE_SIZE, ts: event.ts }],
  };
};

export const REFUTATION_SAMPLE_SIZE = SAMPLE_SIZE;
export const REFUTATION_MIN_INTERVAL_MS = MIN_INTERVAL_MS;
