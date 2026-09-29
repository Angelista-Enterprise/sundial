/**
 * Reading the procedural tier: what the owner usually does next.
 *
 * `routineLearn` folds repeated sequences of activity into `state.routines.learned`
 * and — by design — emits nothing and decides nothing. Until now nothing read the
 * table either: 64 routines learned on the owner's own machine, visible to no tool,
 * no route and no notice. This is the read side, kept pure so the rule, the tool,
 * and the presence line all ask the same question and get the same answer.
 *
 * Why a FORECAST and not a notice. Out of sample, a learned routine predicts the
 * next step about 27% of the time: 26.8% on a 70/30 holdout of thirteen days,
 * with the alternation guard in place. The 40.3% in the rule's header is the
 * figure from BEFORE that guard, inflated by alt-tab texture. That is worth *knowing* — "you usually open Warp after this" is a useful
 * thing for an assistant to have in hand — and it is not worth an *interruption*.
 * Priced honestly through the gate a departure would never clear the tonic bar, so
 * it is not offered as one. It is handed to the model as context and to the owner
 * as a line, and both are free to ignore it.
 */

export interface LearnedRoutine {
  steps: string[];
  support: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RoutineForecast {
  /** The step the owner usually takes next, as `process/class`. */
  expected: string;
  /** The process alone, for a sentence. */
  expectedProcess: string;
  /** The routine that predicts it. */
  routine: LearnedRoutine;
  /** How many of the trail's recent steps the routine matched. */
  matched: number;
}

/**
 * The step a routine predicts from the current trail, if any routine does.
 *
 * Longest match wins, then highest support: a four-step routine that fits the
 * last three steps knows more about this moment than a three-step one that fits
 * the last two. Routines below `minSupport` are ignored — one recurrence is a
 * coincidence, and the learner already refuses to store fewer than three.
 */
export function routineForecast(trail: readonly string[], learned: Record<string, LearnedRoutine>, minSupport = 5): RoutineForecast | null {
  let best: RoutineForecast | null = null;
  for (const routine of Object.values(learned)) {
    if (routine.support < minSupport || routine.steps.length < 2) continue;
    const prefix = routine.steps.slice(0, -1);
    if (prefix.length > trail.length) continue;
    const tail = trail.slice(-prefix.length);
    if (!prefix.every((step, i) => step === tail[i])) continue;
    const expected = routine.steps[routine.steps.length - 1];
    // The forecast is only interesting when it points somewhere the owner is not
    // already: a routine ending on the step they are on predicts nothing.
    if (expected === trail[trail.length - 1]) continue;
    const candidate: RoutineForecast = { expected, expectedProcess: expected.split('/')[0], routine, matched: prefix.length };
    if (
      best === null ||
      candidate.matched > best.matched ||
      (candidate.matched === best.matched && candidate.routine.support > best.routine.support)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The strongest routines, for telling the owner what the tier has learned. */
export function topRoutines(learned: Record<string, LearnedRoutine>, limit = 10): LearnedRoutine[] {
  return Object.values(learned)
    .sort((a, b) => b.support - a.support || a.steps.length - b.steps.length)
    .slice(0, limit);
}

/** `Claude/work > Warp/work > Google Chrome/work` → `Claude → Warp → Google Chrome`. */
export function routineLabel(routine: LearnedRoutine): string {
  return routine.steps.map((s) => s.split('/')[0]).join(' → ');
}
