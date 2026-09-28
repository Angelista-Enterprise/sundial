import type { Rule } from '@sundial/kernel/types.js';

interface MemoryPrioritiesPayload {
  top?: string[];
}

/**
 * D5 (docs/audit/production-proposal-and-enhancements.md, addresses A§5.1,
 * A§5.5) — "top entities/projects of the week," the first genuine loop from
 * memory back into perception. Reacts to the executor's synthetic
 * `memory:priorities` event (emitted by `performReflectionCall` in
 * `apps/daemon/src/daemon/index.ts`, which already reads the reflection
 * window's moments for its own summary and derives this from the same read
 * — no second query). A plain state-only fold, same shape as
 * `applyLlmResult`'s non-effect branches: the DB read a rule structurally
 * can't do already happened in the executor by the time this fires.
 *
 * `momentAnalysisSchedule`'s intent prompt includes `state.memory.priorities`
 * — the actual "loop back into perception" the proposal names, not just a
 * state update with no consumer.
 */
export const memoryPriorities: Rule = (state, event) => {
  if (event.type !== 'memory:priorities') return { state, effects: [] };

  const top = Array.isArray((event.payload as MemoryPrioritiesPayload).top) ? (event.payload as MemoryPrioritiesPayload).top! : [];

  return { state: { ...state, memory: { ...state.memory, priorities: top } }, effects: [] };
};
