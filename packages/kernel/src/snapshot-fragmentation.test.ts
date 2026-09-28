import { describe, expect, it } from 'vitest';
import { createInitialState, hydrateSnapshot } from './initial-state.js';

/**
 * A snapshot written before the `hour-fragmented` forecaster existed must
 * hydrate with the new slice fully populated.
 *
 * `hourFragmentedForecast` dereferences `state.predictions.fragmentation.current`
 * unconditionally, so an absent slice would throw on the FIRST context switch
 * after a boot that replayed an old snapshot — and the live database holds ten
 * snapshots that predate the field. `deepMergeDefaults` is what makes this safe;
 * this test is what keeps it safe.
 */
describe('snapshot hydration for the fragmentation slice', () => {
  it('fills the whole slice when the snapshot predates it', () => {
    const legacy = createInitialState('dev') as unknown as Record<string, unknown>;
    const predictions = { ...(legacy.predictions as Record<string, unknown>) };
    delete predictions.fragmentation;

    const hydrated = hydrateSnapshot('dev', { ...legacy, predictions } as never);

    expect(hydrated.predictions.fragmentation).toEqual({
      current: null,
      emitsThisHour: 0,
      emitsKey: '',
      prevFragmented: null,
      prevDay: null,
      byPrevState: { 'prev-frag': { n: 0, hits: 0 }, 'prev-calm': { n: 0, hits: 0 } },
    });
  });

  it('keeps a snapshot that already has counts, and still fills a newly-added key', () => {
    const state = createInitialState('dev');
    const persisted = {
      ...state,
      predictions: {
        ...state.predictions,
        // A snapshot from the version before `prevDay` was added.
        fragmentation: { current: null, prevFragmented: true, byPrevState: { 'prev-frag': { n: 4, hits: 3 }, 'prev-calm': { n: 9, hits: 1 } } },
      },
    };

    const hydrated = hydrateSnapshot('dev', persisted as never);

    expect(hydrated.predictions.fragmentation.byPrevState['prev-frag']).toEqual({ n: 4, hits: 3 });
    expect(hydrated.predictions.fragmentation.prevFragmented).toBe(true);
    expect(hydrated.predictions.fragmentation.prevDay).toBeNull();
  });
});
