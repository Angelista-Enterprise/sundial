import { recordObservation, stateSignature } from '@sundial/kernel/state-signature.js';
import type { Rule } from '@sundial/kernel/types.js';

/**
 * The single writer of `state.observed` — the durable memory that lets the daemon
 * drop a state observation identical to the last one it recorded.
 *
 * Deliberately a rule rather than a write from the ingest path, even though the
 * ingest path is what READS it. Only rules may change state
 * (concepts/event-sourced-kernel), and routing it through the fold buys the
 * property that makes this work at all: `state.observed` is snapshotted and
 * replayed like everything else, so the comparison survives a restart. That is the
 * entire point — every sensor already deduplicates in an instance field, and an
 * instance field is exactly what a new process does not have.
 *
 * The ordering is worth stating because it looks circular and is not. An event only
 * reaches `reduce()` if the daemon decided it was new; this rule then records it as
 * the value to compare the NEXT one against. So the gate reads the previous fold's
 * output, never its own.
 *
 * No effects, ever. This rule exists purely to remember.
 */
export const observedTrack: Rule = (state, event) => {
  const signature = stateSignature(event.type, event.payload as Record<string, unknown>);
  if (!signature) return { state, effects: [] };
  return { state: { ...state, observed: recordObservation(state.observed, signature) }, effects: [] };
};
