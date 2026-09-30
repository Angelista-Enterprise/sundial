import { capabilities, computeLevels } from '@sundial/kernel/autonomy.js';
import type { AutonomyLevel, KernelState, Rule } from '@sundial/kernel/types.js';

/*
 * W5 step 10: the single writer of `state.autonomy`. The owner's yes (`autonomy:granted
 * {capability}`) and the owner's ceiling (`autonomy:set {capability, level}`: `off` or `ask`
 * lowers it, `act` lifts the ceiling again) are folded as they come; the levels are recomputed
 * whenever an input to the scorecard rows they read can have moved. After `calibrate`, whose
 * numbers they read on the same event.
 */
const LEVELS = new Set<AutonomyLevel>(['off', 'ask', 'act']);
const RECOMPUTE = new Set(['autonomy:granted', 'autonomy:set', 'feedback:verdict', 'action:verified', 'action:performed', 'day:boundary', 'notice:candidate']);

export const autonomyTrack: Rule = (state, event) => {
  if (!RECOMPUTE.has(event.type)) return { state, effects: [] };
  const p = event.payload as { capability?: unknown; level?: unknown };
  const cap = typeof p.capability === 'string' ? p.capability : '';
  let a = state.autonomy ?? { levels: {}, granted: {}, lowered: {} };
  if (event.type === 'autonomy:granted' || event.type === 'autonomy:set') {
    if (cap === '' || !capabilities(state).includes(cap)) return { state, effects: [] };
    if (event.type === 'autonomy:granted') a = { ...a, granted: { ...a.granted, [cap]: event.ts } };
    else if (LEVELS.has(p.level as AutonomyLevel)) {
      const { [cap]: _, ...rest } = a.lowered;
      a = { ...a, lowered: p.level === 'act' ? rest : { ...rest, [cap]: p.level as AutonomyLevel } };
    } else return { state, effects: [] };
  } else if (event.type === 'notice:candidate' && typeof (event.payload as { kind?: unknown }).kind === 'string' && a.levels[`notice:${(event.payload as { kind: string }).kind}`]) return { state, effects: [] };
  const withA: KernelState = { ...state, autonomy: a };
  const levels = computeLevels(withA, event.ts);
  const same = a === state.autonomy && Object.keys(levels).length === Object.keys(a.levels).length && Object.entries(levels).every(([k, v]) => a.levels[k] === v);
  return same ? { state, effects: [] } : { state: { ...withA, autonomy: { ...a, levels } }, effects: [] };
};
