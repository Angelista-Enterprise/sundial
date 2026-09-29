import { wakingDate } from '@sundial/helpers/local-day.js';
import { EMPTY_FACT_TESTS, MIN_TESTS_FOR_BELIEF, TESTED_PREDICATES, noteSeen, resolveFactDay, testableFacts } from '@sundial/kernel/fact-tests.js';
import type { Effect, Rule } from '@sundial/kernel/types.js';
import type { FactCandidate } from './entity-extract.js';

/**
 * Memory that proves itself (use case 7). Scores each confirmed belief with a
 * testable prediction against the day that followed — see `fact-tests.ts` for
 * what each predicate predicts — and keeps the record in `state.factTests`.
 *
 * The day's observations for `usesTool` / `relatesToProject` are the same
 * `entity:fact-candidate` events `entityExtract` emits for every closed moment,
 * so this rule re-derives nothing. The owner's clock facts read the waking day
 * `driftTrack` folds.
 *
 * Belief moves only from `MIN_TESTS_FOR_BELIEF` outcomes on: a miss adds one to
 * `beta`, a hit adds one to `alpha` — except for the two predicates whose hits
 * are the very observations `contradictionCheck` already reinforces, which
 * would count every hit twice.
 */
export const factTestTrack: Rule = (state, event) => {
  const candidate = event.type === 'entity:fact-candidate' ? (event.payload as unknown as FactCandidate) : null;
  const observes = candidate !== null && (candidate.provenance ?? 'inference') === 'inference' && TESTED_PREDICATES[candidate.predicate as keyof typeof TESTED_PREDICATES] === 'set';
  if (event.type !== 'clock:tick' && !observes) return { state, effects: [] };

  const day = wakingDate(event.ts, state.config.timezone);
  let tests = state.factTests ?? EMPTY_FACT_TESTS;
  const effects: Effect[] = [];

  if (tests.day !== day) {
    const closing = tests.day;
    const resolved = resolveFactDay(tests, testableFacts(state.memory.factCursor), closing ? state.drift?.days[closing] : undefined, day);
    tests = resolved.tests;
    for (const o of resolved.outcomes) {
      if (o.priorN < MIN_TESTS_FOR_BELIEF) continue;
      if (o.right && TESTED_PREDICATES[o.predicate] === 'set') continue;
      effects.push({ type: 'ReinforceFact', factId: o.factId, delta: 1, ts: event.ts, side: o.right ? 'alpha' : 'beta' });
    }
  }

  if (observes) tests = noteSeen(tests, candidate!.entityId, candidate!.predicate, candidate!.object);
  if (tests === state.factTests) return { state, effects };
  return { state: { ...state, factTests: tests }, effects };
};
