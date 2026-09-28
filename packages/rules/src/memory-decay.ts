import type { Rule } from '@sundial/kernel/types.js';

/**
 * Reacts to `day:boundary` — decays `moments.importanceScore`/
 * `knowledge_entries.importanceScore` (retrieval weight only, never
 * deletion; that's still `retentionPrune`'s job on the same event).
 * Deliberately excludes `entity_facts`: §5 is explicit that core memory
 * never decays below a floor — it only changes via supersession.
 *
 * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6)
 * reads `state.config.decayFactor` instead of a hardcoded constant — see
 * `KernelState.config`'s doc comment. The default (`createInitialState`,
 * 0.95, ~5%/day) halves a score after roughly 2 weeks of no re-access, in
 * the same ballpark as `@sundial/memory`'s default recency half-life.
 */
export const memoryDecay: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };

  return { state, effects: [{ type: 'DecayScores', factor: state.config.decayFactor }] };
};
