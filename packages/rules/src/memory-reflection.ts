import type { Rule } from '@sundial/kernel/types.js';

/**
 * Reacts to `day:boundary` — same daily cadence `retentionPrune` already
 * uses. Deliberate simplification vs §2's full trigger model: the design
 * doc also wants an early trigger when `state.memory.accumulatedImportance`
 * crosses a threshold mid-day (a burst of significant moments). That needs
 * every rule that could contribute importance to actually increment this
 * field, which nothing does yet — wiring that up is deferred alongside the
 * rest of Phase 6b's harder half (see docs/plan.md). Scheduled-only is a
 * real, useful subset on its own: WCS's `knowledgeDaily` was schedule-only
 * too.
 *
 * `since` is `state.memory.lastReflectionAt` if set, else falls back to 24h
 * before `event.ts` — the first reflection pass ever has no prior boundary
 * to start from.
 */
export const memoryReflection: Rule = (state, event) => {
  if (event.type !== 'day:boundary') return { state, effects: [] };

  const since = state.memory.lastReflectionAt ?? new Date(Date.parse(event.ts) - 24 * 60 * 60 * 1000).toISOString();

  return {
    state: { ...state, memory: { ...state.memory, lastReflectionAt: event.ts, accumulatedImportance: 0 } },
    effects: [{ type: 'RunReflection', since, ts: event.ts }],
  };
};
