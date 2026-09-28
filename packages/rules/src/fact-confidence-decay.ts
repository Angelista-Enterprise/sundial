import type { Rule } from '@sundial/kernel/types.js';

/** Gentle — beliefs should fade over weeks, not days (importance decay is a faster 0.95). */
const FACT_CONFIDENCE_DECAY_FACTOR = 0.98;

/**
 * Phase 2a (docs/design/08-endogenous-life.md §5, decision D8). On
 * `day:boundary`, drifts every current fact's Beta certainty toward the prior —
 * the daily "certainty fades without reconfirmation" pass. Sibling of
 * `memoryDecay` (which decays moment/knowledge importance and explicitly
 * EXCLUDES entity_facts); this is the entity_facts *certainty* decay D8
 * authorizes — the record (object, validity window) is never touched, only the
 * posterior. Executor: `decayCurrentFactConfidence`.
 */
export const factConfidenceDecay: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };
  return { state, effects: [{ type: 'DecayFactConfidence', factor: FACT_CONFIDENCE_DECAY_FACTOR, ts: event.ts }] };
};
