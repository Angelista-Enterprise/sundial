import { describe, expect, it } from 'vitest';
import { createInitialState as initialState } from '@sundial/kernel/initial-state.js';
import { hostTimeZone } from '@sundial/helpers/local-day.js';
import type { Effect, HourFragmentedPrediction, KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { FRAGMENTED_HOUR_SWITCHES, hourFragmentedForecast } from './hour-fragmented-forecast.js';

/** These fixtures are host-local instants, so the owner's zone is the host's here (M3: the rule reads `state.config.timezone`). */
const createInitialState = (id: string): KernelState => {
  const s = initialState(id);
  return { ...s, config: { ...s.config, timezone: hostTimeZone() } };
};

/** A local-time instant, so the rule's `getHours()` bucketing is what the test intends. */
function at(day: string, hour: number, minute = 0): string {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).toISOString();
}

let seq = 0;
function ev(type: string, ts: string): SanitizedEvent {
  seq += 1;
  return { id: `e${seq}`, type, ts, payload: {} } as unknown as SanitizedEvent;
}

const switchAt = (day: string, hour: number, minute = 0): SanitizedEvent => ev('event:context-switch', at(day, hour, minute));

/**
 * The three `input:activity` emits that promote an hour to active and open its
 * bet. Every scenario must do this before any switch in that hour can count —
 * which is the rule's whole population-alignment fix, so the tests spell it out
 * rather than hiding it in a helper that also emits switches.
 */
function activate(day: string, hour: number): SanitizedEvent[] {
  return [0, 1, 2].map((i) => ev('input:activity', at(day, hour, i)));
}

/** Fold a list of events, returning the final state and every effect produced. */
function run(events: SanitizedEvent[], from: KernelState = createInitialState('test-device')): { state: KernelState; effects: Effect[] } {
  let state = from;
  const effects: Effect[] = [];
  for (const event of events) {
    const out = hourFragmentedForecast(state, event);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
}

/** An hour promoted to active, then `n` switches inside it. */
function switches(day: string, hour: number, n: number): SanitizedEvent[] {
  return [...activate(day, hour), ...Array.from({ length: n }, (_unused, i) => switchAt(day, hour, i + 3))];
}

const openBet = (state: KernelState): HourFragmentedPrediction | undefined =>
  state.predictions.open.find((p): p is HourFragmentedPrediction => p.kind === 'hour-fragmented');

describe('hourFragmentedForecast', () => {
  it('opens exactly one bet on the first switch of an hour, and only counts after that', () => {
    const { state, effects } = run(switches('2026-08-03', 9, 4));
    expect(state.predictions.open.filter((p) => p.kind === 'hour-fragmented')).toHaveLength(1);
    expect(state.predictions.fragmentation.current).toEqual({ day: '2026-08-03', hour: 9, switchesThisHour: 4 });
    // Nothing resolves until the hour closes.
    expect(effects).toEqual([]);
  });

  it('with no history it bets the uninformed rate, not a coin flip', () => {
    const { state } = run(activate('2026-08-03', 9));
    // The measured share of active hours that come apart — 0.5 would be the
    // wrong prior for a threshold question with a rare positive.
    expect(openBet(state)?.priorProb).toBeCloseTo(0.14, 5);
  });

  it('resolves a fragmented hour as a hit, from its own accumulated count', () => {
    // Ten switches in hour 9, then one in hour 10 to close hour 9.
    const { state, effects } = run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES), ...activate('2026-08-03', 10)]);
    const recorded = effects.filter((e) => e.type === 'RecordPrediction');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'hour-fragmented', forecaster: 'prev-hour-lag', outcome: 1, features: { hour: 9, prevState: 'prev-calm', switches: 10 } });
    expect(state.predictions.calibration['hour-fragmented']).toMatchObject({ n: 1, hits: 1 });
    expect(state.predictions.fragmentation.byPrevState['prev-calm']).toEqual({ n: 1, hits: 1 });
  });

  it('resolves a calm hour as a miss, one switch below the threshold', () => {
    const { state, effects } = run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES - 1), ...activate('2026-08-03', 10)]);
    expect(effects.filter((e) => e.type === 'RecordPrediction')[0]).toMatchObject({ outcome: 0, features: { switches: 9 } });
    expect(state.predictions.calibration['hour-fragmented']).toMatchObject({ n: 1, hits: 0 });
  });

  it('conditions the next bet on how the previous hour actually turned out', () => {
    // Hour 9 comes apart; the bet opened for hour 10 must sit in `prev-frag`.
    const { state } = run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES), ...activate('2026-08-03', 10)]);
    expect(state.predictions.fragmentation.prevFragmented).toBe(true);
    expect(openBet(state)?.prevState).toBe('prev-frag');
  });

  it('a calm previous hour puts the next bet in the other cell', () => {
    const { state } = run([...switches('2026-08-03', 9, 1), ...activate('2026-08-03', 10)]);
    expect(state.predictions.fragmentation.prevFragmented).toBe(false);
    expect(openBet(state)?.prevState).toBe('prev-calm');
  });

  it('learns: the prev-frag cell bets higher than prev-calm once evidence separates them', () => {
    // Contiguous RUNS, not alternating pairs. An earlier version of this test used
    // one fragmented hour followed by one calm hour, which gave each cell exactly
    // one hit and one miss — the scenario could not separate them no matter how
    // well the rule worked. Runs of three put two same-state transitions in each
    // cell against one transition hour, which is what a real morning looks like.
    const events: SanitizedEvent[] = [];
    for (const day of ['2026-08-03', '2026-08-04', '2026-08-05']) {
      for (const hour of [9, 10, 11]) events.push(...switches(day, hour, 12));
      for (const hour of [14, 15, 16]) events.push(...switches(day, hour, 1));
      events.push(ev('day:boundary', at(day, 23, 59)));
    }
    const { state } = run(events);
    const frag = state.predictions.fragmentation.byPrevState['prev-frag'];
    const calm = state.predictions.fragmentation.byPrevState['prev-calm'];
    expect(frag.n).toBeGreaterThan(0);
    expect(calm.n).toBeGreaterThan(0);
    // The whole point of the lag feature: the two cells must diverge.
    expect(frag.hits / frag.n).toBeGreaterThan(calm.hits / calm.n);
  });

  it('closes the final hour of a day on the day boundary, not on the next switch', () => {
    const { state, effects } = run([...switches('2026-08-03', 22, FRAGMENTED_HOUR_SWITCHES), ev('day:boundary', at('2026-08-03', 23, 59))]);
    expect(effects.filter((e) => e.type === 'RecordPrediction')).toHaveLength(1);
    expect(state.predictions.open.filter((p) => p.kind === 'hour-fragmented')).toHaveLength(0);
    expect(state.predictions.fragmentation.current).toBeNull();
  });

  it('does not carry the lag across a day boundary', () => {
    // Yesterday ended fragmented; today's first hour must not inherit that.
    const first = run([...switches('2026-08-03', 22, FRAGMENTED_HOUR_SWITCHES), ev('day:boundary', at('2026-08-03', 23, 59))]);
    expect(first.state.predictions.fragmentation.prevFragmented).toBe(true);
    const second = run(activate('2026-08-04', 9), first.state);
    expect(openBet(second.state)?.prevState).toBe('prev-calm');
  });

  it('resets the lag when a new day arrives without a boundary event', () => {
    // The laptop-closed-overnight case: no day:boundary ever fires.
    const first = run([...switches('2026-08-03', 22, FRAGMENTED_HOUR_SWITCHES)]);
    const second = run(activate('2026-08-04', 9), first.state);
    expect(openBet(second.state)?.prevState).toBe('prev-calm');
    // The previous day's hour still resolved — it just does not condition today.
    expect(second.effects.filter((e) => e.type === 'RecordPrediction')).toHaveLength(1);
  });

  it('feeds the shared surprise drive once it has skill on 50 resolutions, and not before (Q8)', () => {
    const before = createInitialState('test-device');
    expect(run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES), ...activate('2026-08-03', 10)]).state.memory.accumulatedImportance).toBe(0);
    const skilled = { ...before, predictions: { ...before.predictions, calibration: { 'hour-fragmented': { n: 100, hits: 20, brierSum: 10 } } } };
    const { state } = run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES), ...activate('2026-08-03', 10)], skilled);
    expect(state.memory.accumulatedImportance).toBeGreaterThan(before.memory.accumulatedImportance);
  });

  it('a surprising outcome carries more surprise than an expected one', () => {
    const hit = run([...switches('2026-08-03', 9, FRAGMENTED_HOUR_SWITCHES), ...activate('2026-08-03', 10)]);
    const miss = run([...switches('2026-08-03', 9, 1), ...activate('2026-08-03', 10)]);
    // The uninformed prior is 0.14, so crossing the threshold is the surprise.
    const hitSurprise = hit.state.predictions.recentResolved[0].surprise;
    const missSurprise = miss.state.predictions.recentResolved[0].surprise;
    expect(hitSurprise).toBeGreaterThan(missSurprise);
  });

  it('ignores every event type it does not own', () => {
    const start = createInitialState('test-device');
    for (const type of ['window:changed', 'clock:tick', 'git:commit', 'llm:result']) {
      const out = hourFragmentedForecast(start, ev(type, at('2026-08-03', 9)));
      expect(out.state).toBe(start);
      expect(out.effects).toEqual([]);
    }
  });

  it('is a no-op on a day boundary with nothing accumulating', () => {
    const start = createInitialState('test-device');
    const out = hourFragmentedForecast(start, ev('day:boundary', at('2026-08-03', 23, 59)));
    expect(out.state).toBe(start);
    expect(out.effects).toEqual([]);
  });
});
