import type { Rule } from '@sundial/kernel/types.js';

/**
 * Reacts to `day:boundary` (already emitted by `clockTick`, Phase 2) —
 * once-daily is the right cadence for a prune, no separate timer needed.
 * Ported from WCS's scheduled privacy-pruner, trimmed to the two tables
 * Gnomon actually has (see `packages/db/src/queries/retention.ts`'s doc
 * comment). The rule only computes *when* to prune and the cutoff
 * timestamp — the executor performs the actual `DELETE`.
 *
 * C4 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.6)
 * reads `state.config.retentionDays` instead of a hardcoded constant — see
 * `KernelState.config`'s doc comment for why this lives in state (so the
 * rule stays pure) rather than a module-level config singleton. 180 days
 * (the default, `createInitialState`) is deliberately generous vs WCS's
 * 30-day default: Gnomon's positioning (a personal context/knowledgebase,
 * not just an activity logger) wants more history by default, not less.
 */
export const retentionPrune: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };

  const cutoff = new Date(Date.parse(event.ts) - state.config.retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Screen text goes sooner. Raw OCR is the highest-volume and most sensitive
  // thing in the log; its moments keep what it produced. Only when the short
  // horizon is actually shorter — otherwise the general prune already covers it.
  const screenDays = state.config.screenTextRetentionDays;
  const screenCutoff = new Date(Date.parse(event.ts) - screenDays * 24 * 60 * 60 * 1000).toISOString();
  const effects: ReturnType<Rule>['effects'] = [{ type: 'DeleteRows', olderThan: cutoff }];
  if (screenDays < state.config.retentionDays) effects.push({ type: 'DeleteRows', olderThan: screenCutoff, signalTypes: ['screen'] });

  return {
    state: { ...state, retention: { lastPrunedAt: event.ts } },
    effects,
  };
};
