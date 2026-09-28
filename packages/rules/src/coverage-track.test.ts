import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMITS_PER_FULL_HOUR, MAX_COVERAGE_BUCKETS, coverageBucket, coverageOver, coverageTrack, observedToday, recentCoverage } from './coverage-track.js';

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function activity(ts: string): SanitizedEvent {
  return { id: `i-${ts}`, type: 'input:activity', ts, payload: { keyCount: 0, mouseCount: 0 }, sanitized: true };
}

function utcState(): KernelState {
  const state = createInitialState('d1');
  return { ...state, config: { ...state.config, timezone: 'UTC' } };
}

/** Fill `hours` worth of buckets from `startHour`, each fully observed. */
function observed(hours: number, startHour = 0, day = '2026-03-10'): Record<string, number> {
  const map: Record<string, number> = {};
  for (let h = 0; h < hours; h += 1) map[`${day}T${String(startHour + h).padStart(2, '0')}`] = EMITS_PER_FULL_HOUR;
  return map;
}

describe('coverageBucket', () => {
  it('keys by local hour', () => {
    expect(coverageBucket('2026-03-10T14:37:00.000Z', 'UTC')).toBe('2026-03-10T14');
  });

  it('uses the owner zone, not UTC', () => {
    // 23:30 UTC is 00:30 the next day in Amsterdam — a different day AND hour.
    expect(coverageBucket('2026-03-10T23:30:00.000Z', 'Europe/Amsterdam')).toBe('2026-03-11T00');
  });

  it('renders midnight as 00, never 24', () => {
    // Some ICU builds format midnight as "24" under `hour12: false`, producing a key
    // that sorts after every real hour and loses the first hour of every day to
    // eviction. `hourCycle: 'h23'` is what prevents it.
    expect(coverageBucket('2026-03-10T00:15:00.000Z', 'UTC')).toBe('2026-03-10T00');
  });

  it('falls back to the UTC hour on an unusable zone rather than throwing', () => {
    expect(coverageBucket('2026-03-10T14:00:00.000Z', 'Not/AZone')).toBe('2026-03-10T14');
  });
});

describe('coverageTrack', () => {
  it('counts input:activity emits into the local hour bucket', () => {
    let state = utcState();
    for (let i = 0; i < 3; i += 1) state = coverageTrack(state, activity(`2026-03-10T09:0${i}:00.000Z`)).state;
    expect(state.coverage.observedHours['2026-03-10T09']).toBe(3);
  });

  it('ignores every other event type', () => {
    const state = utcState();
    const { state: next } = coverageTrack(state, { id: 'w', type: 'window:changed', ts: '2026-03-10T09:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
  });

  it('evicts the oldest hours chronologically, not by insertion order', () => {
    // This map is written out of order whenever a replay crosses a gap, so eviction
    // has to sort rather than trust insertion order.
    let state = utcState();
    state = { ...state, coverage: { ...state.coverage, observedHours: { '2026-04-01T10': 5, '2026-01-01T10': 5, ...observed(MAX_COVERAGE_BUCKETS, 0, '2026-02-01') } } };
    state = coverageTrack(state, activity('2026-05-01T10:00:00.000Z')).state;

    expect(Object.keys(state.coverage.observedHours)).toHaveLength(MAX_COVERAGE_BUCKETS);
    expect(state.coverage.observedHours['2026-01-01T10']).toBeUndefined();
    expect(state.coverage.observedHours['2026-05-01T10']).toBe(1);
  });
});

describe('coverageOver', () => {
  it('is 1 when every spanned hour is fully observed', () => {
    const from = Date.parse('2026-03-10T01:00:00.000Z');
    const to = Date.parse('2026-03-10T04:00:00.000Z');
    expect(coverageOver(observed(6), from, to, 'UTC')).toBe(1);
  });

  it('is 0 when nothing was observed', () => {
    const from = Date.parse('2026-03-10T01:00:00.000Z');
    const to = Date.parse('2026-03-10T04:00:00.000Z');
    expect(coverageOver({}, from, to, 'UTC')).toBe(0);
  });

  it('only counts hours the window actually spans', () => {
    // A busy yesterday must not vouch for an unobserved today. Without the hour walk
    // this is the bug that would make every absence claim look well-founded.
    const from = Date.parse('2026-03-10T20:00:00.000Z');
    const to = Date.parse('2026-03-10T23:00:00.000Z');
    expect(coverageOver(observed(12, 0), from, to, 'UTC')).toBe(0);
  });

  it('scores a partly-observed hour proportionally', () => {
    const map = { '2026-03-10T05': EMITS_PER_FULL_HOUR / 2 };
    const from = Date.parse('2026-03-10T05:00:00.000Z');
    const to = Date.parse('2026-03-10T06:00:00.000Z');
    expect(coverageOver(map, from, to, 'UTC')).toBeCloseTo(0.5, 5);
  });

  it('caps a single hour at 1 however many emits landed in it', () => {
    const map = { '2026-03-10T05': EMITS_PER_FULL_HOUR * 10 };
    const from = Date.parse('2026-03-10T05:00:00.000Z');
    const to = Date.parse('2026-03-10T06:00:00.000Z');
    expect(coverageOver(map, from, to, 'UTC')).toBe(1);
  });

  it('weights by overlap when the window starts mid-hour', () => {
    // 05:30-07:00, with only hour 6 observed: half an hour unobserved, one observed.
    const map = { '2026-03-10T06': EMITS_PER_FULL_HOUR };
    const from = Date.parse('2026-03-10T05:30:00.000Z');
    const to = Date.parse('2026-03-10T07:00:00.000Z');
    expect(coverageOver(map, from, to, 'UTC')).toBeCloseTo(1 / 1.5, 5);
  });

  it('is 0 for an empty or inverted window rather than dividing by zero', () => {
    const at = Date.parse('2026-03-10T05:00:00.000Z');
    expect(coverageOver(observed(6), at, at, 'UTC')).toBe(0);
    expect(coverageOver(observed(6), at, at - 1000, 'UTC')).toBe(0);
  });
});

describe('observedToday', () => {
  const at = (day: string, hour: number): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;

  function withHours(counts: Record<number, number>, day = '2026-03-10'): KernelState {
    const state = utcState();
    const observedHours: Record<string, number> = {};
    for (const [hour, n] of Object.entries(counts)) observedHours[`${day}T${String(Number(hour)).padStart(2, '0')}`] = n;
    return { ...state, coverage: { ...state.coverage, observedHours } };
  }

  it('measures from the first observed hour of today, not midnight', () => {
    // Starting at midnight would dilute every claim with the small hours.
    const state = withHours({ 9: EMITS_PER_FULL_HOUR, 10: EMITS_PER_FULL_HOUR, 11: EMITS_PER_FULL_HOUR });
    const result = observedToday(state, at('2026-03-10', 12));
    expect(new Date(result.fromMs).toISOString()).toBe('2026-03-10T09:00:00.000Z');
    expect(result.coverage).toBe(1);
    expect(result.observedMs).toBe(3 * 3_600_000);
  });

  it('ignores yesterday entirely', () => {
    // The failure this frame fixes in one direction: a day with no break has its last
    // occurrence yesterday, and coverage across a night is near zero, so the strictest
    // floor in the table rejected the clearest case in the corpus.
    const state = utcState();
    const withBoth: KernelState = {
      ...state,
      coverage: { ...state.coverage, observedHours: { '2026-03-09T20': EMITS_PER_FULL_HOUR, '2026-03-09T21': EMITS_PER_FULL_HOUR, '2026-03-10T09': EMITS_PER_FULL_HOUR, '2026-03-10T10': EMITS_PER_FULL_HOUR } },
    };
    const result = observedToday(withBoth, at('2026-03-10', 11));
    expect(new Date(result.fromMs).toISOString()).toBe('2026-03-10T09:00:00.000Z');
    expect(result.observedMs).toBe(2 * 3_600_000);
  });

  it('discounts a mid-day outage rather than papering over it', () => {
    // The failure in the other direction: a four-hour hole in the middle of a day must not
    // support a claim about the whole day, however clean the recent hours look. Nine hours
    // elapsed, five observed.
    const state = withHours({ 9: EMITS_PER_FULL_HOUR, 14: EMITS_PER_FULL_HOUR, 15: EMITS_PER_FULL_HOUR, 16: EMITS_PER_FULL_HOUR, 17: EMITS_PER_FULL_HOUR });
    const result = observedToday(state, at('2026-03-10', 18));
    expect(result.coverage).toBeCloseTo(5 / 9, 5);
    expect(result.observedMs).toBeCloseTo(5 * 3_600_000, -3);
  });

  it('is zero before anything has been observed today', () => {
    const result = observedToday(utcState(), at('2026-03-10', 9));
    expect(result.coverage).toBe(0);
    expect(result.observedMs).toBe(0);
  });
});

describe('recentCoverage', () => {
  it('scores the trailing window ending at ts', () => {
    const state: KernelState = { ...utcState(), coverage: { ...utcState().coverage, observedHours: observed(4, 6) } };
    // 08:00 back three hours = 05:00-08:00; hours 6 and 7 observed, 5 not.
    expect(recentCoverage(state, '2026-03-10T08:00:00.000Z', 3 * 3_600_000)).toBeCloseTo(2 / 3, 5);
  });

  it('reproduces the live measurement that motivated the whole term', () => {
    // The daemon observed 1.2 hours on 2026-07-30 and 11.5 on 08-01. A claim spanning
    // a day like the first is mostly a claim about uptime.
    const thin: KernelState = { ...utcState(), coverage: { ...utcState().coverage, observedHours: { '2026-03-10T09': 419 } } };
    expect(recentCoverage(thin, '2026-03-11T00:00:00.000Z', 24 * 3_600_000)).toBeLessThan(0.06);
  });
});
