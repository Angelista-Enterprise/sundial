import type { Rule } from '@sundial/kernel/types.js';

/** Each anomaly contributes at most this much to the drive (bounds one loud outlier's influence). */
const MAX_PER_ANOMALY = 5;
/** Hard cap on the accumulator (bounded state — the drive is "surprise since last reflection", not an unbounded counter). Exported so the forward model (Phase 2b) clamps prediction-error surprise to the same ceiling. */
export const MAX_ACCUMULATED = 60;

interface AnomalyPayload {
  zScore?: number;
}

/**
 * Phase 1 endogenous-life (docs/design/08-endogenous-life.md §2.2/§3, decision
 * D3). Routes the surprise `anomalyZscore` already computes into the drive
 * accumulator `state.memory.accumulatedImportance` — the field the original
 * design declared but never populated (it sat at 0 forever, the single wire
 * the earlier build stopped short of). Each `anomaly:detected` adds
 * `min(|zScore|, MAX_PER_ANOMALY)`, clamped to `MAX_ACCUMULATED`.
 *
 * The accumulator is CONSUMED (reset to 0) by `memoryReflection` (daily) and
 * `endogenousReflection` (drive-triggered early reflection). This is the
 * Phase-1 surprise signal, driven by the discrete `anomaly:detected` events
 * anomalyZscore emits at |z|≥2; continuous per-observation prediction-error
 * surprise arrives with the forward model (Phase 2b, log-loss scoring).
 *
 * Pure state write, no effects — one rule, one job (doc 00 "the law").
 */
export const surpriseDrive: Rule = (state, event) => {
  if (event.type !== 'anomaly:detected') return { state, effects: [] };

  const z = (event.payload as AnomalyPayload).zScore;
  if (typeof z !== 'number' || !Number.isFinite(z)) return { state, effects: [] };

  const contribution = Math.min(Math.abs(z), MAX_PER_ANOMALY);
  const next = Math.min(MAX_ACCUMULATED, state.memory.accumulatedImportance + contribution);
  if (next === state.memory.accumulatedImportance) return { state, effects: [] };

  return { state: { ...state, memory: { ...state.memory, accumulatedImportance: next } }, effects: [] };
};
