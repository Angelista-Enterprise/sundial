import { localHour } from '@sundial/helpers/local-day.js';
import type { Rule } from '@sundial/kernel/types.js';

/** Local-hour → circadian phase. Night gates heavy autonomous work; evening is the transition. Exported for direct (TZ-independent) unit testing. */
export function circadianPhase(hour: number): 'day' | 'evening' | 'night' {
  if (hour >= 22 || hour < 6) return 'night';
  if (hour >= 18) return 'evening';
  return 'day';
}

/** Drive-accumulator thresholds → mood buckets. Readout only — see `surpriseDrive` for accumulation. */
const MOOD_STIRRING_AT = 5;
const MOOD_RESTLESS_AT = 15;
export function moodFor(accumulatedImportance: number): 'settled' | 'stirring' | 'restless' {
  if (accumulatedImportance >= MOOD_RESTLESS_AT) return 'restless';
  if (accumulatedImportance >= MOOD_STIRRING_AT) return 'stirring';
  return 'settled';
}

/**
 * Phase 1 endogenous-life (docs/design/08-endogenous-life.md §3). Maintains the
 * derived `state.mind` readout on every `clock:tick`: the local-hour circadian
 * phase (used only to gate autonomous work, e.g. by `endogenousReflection`) and
 * a coarse `mood` projected from the surprise drive
 * (`memory.accumulatedImportance`).
 *
 * Pure readout — emits no effects, never writes the drive itself (that's
 * `surpriseDrive`'s job; mood is a projection, not an input, per D10). Placed
 * LAST in the manifest so it observes the drive AFTER same-tick consumers like
 * `endogenousReflection` have run. Returns state unchanged when neither derived
 * value moved, so it doesn't churn a fresh state object every tick.
 */
export const mindTrack: Rule = (state, event) => {
  if (event.type !== 'clock:tick') return { state, effects: [] };

  const circadian = circadianPhase(localHour(event.ts, state.config.timezone));
  const mood = moodFor(state.memory.accumulatedImportance);
  if (circadian === state.mind.circadian && mood === state.mind.mood) return { state, effects: [] };

  return { state: { ...state, mind: { ...state.mind, circadian, mood } }, effects: [] };
};
