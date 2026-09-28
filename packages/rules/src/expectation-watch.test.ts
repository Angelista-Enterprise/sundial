import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, NoticeCandidate, SanitizedEvent } from '@sundial/kernel/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMITS_PER_FULL_HOUR } from './coverage-track.js';
import { expectationLearn } from './expectation-learn.js';
import { expectationWatch } from './expectation-watch.js';
import { recordOccurrence } from './expectations.js';
import { DEFAULT_GATE_POLICY } from './notice-gate.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function tick(ts: string): SanitizedEvent {
  return { id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
}

function base(): KernelState {
  const s = createInitialState('d1');
  return { ...s, config: { ...s.config, timezone: 'UTC' } };
}

/** Fully observe every hour in `[from, to)`, so coverage never suppresses a test about something else. */
function withCoverage(state: KernelState, fromIso: string, toIso: string): KernelState {
  const observedHours: Record<string, number> = { ...state.coverage.observedHours };
  for (let cursor = Date.parse(fromIso); cursor < Date.parse(toIso); cursor += HOUR) {
    const d = new Date(cursor).toISOString();
    observedHours[`${d.slice(0, 10)}T${d.slice(11, 13)}`] = EMITS_PER_FULL_HOUR;
  }
  return { ...state, coverage: { ...state.coverage, observedHours } };
}

/** A `break` recurrence with `n` gaps of `gapMin`, last seen at `lastSeen`. */
function withBreakHistory(state: KernelState, gapMin: number, n: number, lastSeen: string): KernelState {
  let recurring = {};
  let cursor = Date.parse(lastSeen) - n * gapMin * MIN;
  recurring = recordOccurrence(recurring, 'break|any', 'break', 'any', new Date(cursor).toISOString(), 45 * MIN);
  for (let i = 0; i < n; i += 1) {
    cursor += gapMin * MIN;
    recurring = recordOccurrence(recurring, 'break|any', 'break', 'any', new Date(cursor).toISOString(), 45 * MIN);
  }
  return { ...state, expectations: { ...state.expectations, recurring } };
}

function candidates(effects: unknown[]): NoticeCandidate[] {
  return effects.map((e) => (e as { event: { payload: NoticeCandidate } }).event.payload);
}

describe('expectationWatch — omission', () => {
  it('ignores everything but clock:tick', () => {
    const state = base();
    const { state: next, effects } = expectationWatch(state, { id: 'w', type: 'window:changed', ts: '2026-03-10T14:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('says nothing when it knows of no routine', () => {
    expect(expectationWatch(base(), tick('2026-03-10T14:00:00.000Z')).effects).toEqual([]);
  });

  it('emits an omission when a steady routine goes overdue', () => {
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-10T16:00:00.000Z');

    const { effects } = expectationWatch(state, tick('2026-03-10T15:00:00.000Z'));
    const [candidate] = candidates(effects);

    expect(candidate!.shape).toBe('omission');
    expect(candidate!.kind).toBe('absent:break');
    expect(candidate!.observation).toContain('without a break');
    expect(candidate!.precision).toBeGreaterThan(0.5);
    // Declared by the stream: a missed break is worth saying within the hour.
    expect(candidate!.valueHalfLifeMs).toBe(45 * MIN);
  });

  it('stays quiet while the routine is merely due, not overdue', () => {
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T14:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-10T16:00:00.000Z');
    expect(expectationWatch(state, tick('2026-03-10T15:20:00.000Z')).effects).toEqual([]);
  });

  it('refuses to claim an absence it did not observe', () => {
    // The hazard the whole coverage term exists for: over four live days the daemon
    // saw between 1.2 and 11.5 hours of a 24-hour day, and `enhancements/
    // presence-as-absence-ground-truth` is the standing note on it. Not watching and
    // not resting look identical from the log.
    const state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    expect(state.coverage.observedHours).toEqual({});
    expect(expectationWatch(state, tick('2026-03-10T15:00:00.000Z')).effects).toEqual([]);
  });

  it('refuses when a daemon outage covers most of the overdue window', () => {
    // A four-hour hole inside a six-hour "no break" window. Reporting here would be
    // the most embarrassing possible failure of an absence detector.
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-10T09:00:00.000Z', '2026-03-10T11:00:00.000Z');
    expect(expectationWatch(state, tick('2026-03-10T15:00:00.000Z')).effects).toEqual([]);
  });

  it('needs more than a handful of occurrences before it will speak', () => {
    let state = withBreakHistory(base(), 90, 3, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-10T16:00:00.000Z');
    expect(expectationWatch(state, tick('2026-03-10T15:00:00.000Z')).effects).toEqual([]);
  });

  it('is edge-triggered — one candidate per absence, not one per tick', () => {
    // Level-triggering here would emit 1,440 candidates a day for a single missing
    // break, each with its own log row and recursive reduce pass.
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-10T18:00:00.000Z');

    const first = expectationWatch(state, tick('2026-03-10T15:00:00.000Z'));
    expect(first.effects).toHaveLength(1);
    expect(first.state.expectations.recurring['break|any']!.armed).toBe(false);

    let after = first.state;
    for (let m = 1; m <= 30; m += 1) {
      const result = expectationWatch(after, tick(new Date(Date.parse('2026-03-10T15:00:00.000Z') + m * MIN).toISOString()));
      after = result.state;
      expect(result.effects).toEqual([]);
    }
  });

  it('re-arms when the occurrence next happens, so the next absence is announced', () => {
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-11T00:00:00.000Z');
    state = expectationWatch(state, tick('2026-03-10T15:00:00.000Z')).state;
    expect(state.expectations.recurring['break|any']!.armed).toBe(false);

    // A break actually happens.
    state = expectationLearn(state, { id: 'i1', type: 'idle:start', ts: '2026-03-10T15:30:00.000Z', payload: {}, sanitized: true }).state;
    expect(state.expectations.recurring['break|any']!.armed).toBe(true);

    const { effects } = expectationWatch(state, tick('2026-03-10T21:30:00.000Z'));
    expect(effects).toHaveLength(1);
  });

  it('carries the evidence a reader needs to weigh the claim', () => {
    let state = withBreakHistory(base(), 90, 20, '2026-03-10T09:00:00.000Z');
    state = withCoverage(state, '2026-03-09T00:00:00.000Z', '2026-03-10T16:00:00.000Z');
    const [candidate] = candidates(expectationWatch(state, tick('2026-03-10T15:00:00.000Z')).effects);

    expect(candidate!.evidence.some((e) => e.startsWith('usual gap'))).toBe(true);
    expect(candidate!.evidence).toContain('n=20');
    expect(candidate!.evidence.some((e) => e.startsWith('coverage'))).toBe(true);
  });
});

describe('expectationWatch — a declared expectation when there is too little to learn from', () => {
  /** `n` leisure occurrences `gapDays` apart, last seen `sinceDays` ago. */
  function withLeisure(n: number, gapDays: number, sinceDays: number): KernelState {
    const now = Date.parse('2026-03-10T14:00:00.000Z');
    const last = now - sinceDays * 24 * HOUR;
    let recurring = {};
    let cursor = last - n * gapDays * 24 * HOUR;
    recurring = recordOccurrence(recurring, 'leisure|any', 'leisure', 'any', new Date(cursor).toISOString(), null, 14 * 24 * HOUR, 3 * HOUR);
    for (let i = 0; i < n; i += 1) {
      cursor += gapDays * 24 * HOUR;
      recurring = recordOccurrence(recurring, 'leisure|any', 'leisure', 'any', new Date(cursor).toISOString(), null, 14 * 24 * HOUR, 3 * HOUR);
    }
    const state = withCoverage(base(), '2026-02-01T00:00:00.000Z', '2026-03-10T15:00:00.000Z');
    return { ...state, expectations: { ...state.expectations, recurring } };
  }

  it('speaks from a declared floor when it has only seen a few occurrences', () => {
    // The measured case: the `officer` persona logged three leisure sessions in sixty days,
    // under the six-occurrence learning floor, so the stream was permanently silent for
    // exactly the person the claim matters most for.
    const state = withLeisure(3, 5, 12);
    const candidate = candidates(expectationWatch(state, tick('2026-03-10T14:00:00.000Z')).effects).find((c) => c.kind === 'absent:leisure');

    expect(candidate).toBeDefined();
    expect(candidate!.evidence.some((e) => e.includes('declared, not learned'))).toBe(true);
  });

  it('labels a declared claim as declared, and prices it below a measured one', () => {
    const declared = candidates(expectationWatch(withLeisure(3, 5, 12), tick('2026-03-10T14:00:00.000Z')).effects).find((c) => c.kind === 'absent:leisure');
    const learned = candidates(expectationWatch(withLeisure(12, 2, 12), tick('2026-03-10T14:00:00.000Z')).effects).find((c) => c.kind === 'absent:leisure');

    expect(declared!.precision).toBeCloseTo(0.45, 2);
    // A declared floor carries no evidence about this owner's rhythm, so a well-sampled
    // measured interval must outrank it.
    expect(learned!.precision).toBeGreaterThan(declared!.precision);
  });

  it('will not assert a rhythm for something it has never seen at all', () => {
    // Zero observations means the absence is a statement about the sensor, not the owner.
    const state = withCoverage(base(), '2026-02-01T00:00:00.000Z', '2026-03-10T15:00:00.000Z');
    expect(candidates(expectationWatch(state, tick('2026-03-10T14:00:00.000Z')).effects).some((c) => c.kind === 'absent:leisure')).toBe(false);
  });

  it('stays quiet when a declared interval is merely due', () => {
    // Declared spread is a third of the interval, so a declared claim only fires well past
    // due — four days expected, three days elapsed.
    expect(candidates(expectationWatch(withLeisure(3, 5, 3), tick('2026-03-10T14:00:00.000Z')).effects).some((c) => c.kind === 'absent:leisure')).toBe(false);
  });
});

describe('expectationWatch — day end', () => {
  /** Twelve weekdays ending at 18:00, plus a partial today. */
  function withDayEnds(state: KernelState, minutesPerDay: number[], today: { day: string; minutes: number }): KernelState {
    // K0.6b — the series counts from 04:00, so a test that means "18:00" says 840.
    const dayEnd = minutesPerDay.map((minutes, i) => ({ day: `2026-02-${String(i + 1).padStart(2, '0')}`, minutes: minutes - 4 * 60, basis: 'waking' }));
    return { ...state, expectations: { ...state.expectations, dayEnd: [...dayEnd, today] } };
  }

  it('reports being well past a learned stop time', () => {
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, () => 18 * 60),
      { day: '2026-03-10', minutes: 22 * 60 },
    );
    const found = candidates(expectationWatch(state, tick('2026-03-10T22:40:00.000Z')).effects).find((c) => c.kind === 'day-runs-long');

    expect(found).toBeDefined();
    expect(found!.observation).toContain('18:00');
    // Decays fast: worth knowing at 22:40, worthless at breakfast.
    expect(found!.valueHalfLifeMs).toBe(90 * MIN);
  });

  it('stays quiet while still inside the normal spread', () => {
    // Forty minutes past an 18:00 median whose spread floors at 30 minutes. The
    // producer's own bar is 2x spread; anything marginal above it is emitted and then
    // weighed by `noticeGate`, which is the layer that owns "is this worth an
    // interruption" — so this asserts silence well inside the band rather than on the
    // boundary itself.
    const state = withDayEnds(base(), [1080, 1095, 1065, 1110, 1050, 1080, 1100, 1070, 1085, 1075, 1090, 1080], { day: '2026-03-10', minutes: 18 * 60 + 40 });
    expect(candidates(expectationWatch(state, tick('2026-03-10T18:40:00.000Z')).effects).some((c) => c.kind === 'day-runs-long')).toBe(false);
  });

  it('interrupts a very regular person an hour past their stop time', () => {
    // Someone who stops within about ten minutes every day, an hour late: surprise 2.0
    // (two spreads out) times precision 0.86 (twelve days of evidence) = 1.71, over the
    // interrupting bar of 1.6. For a rhythm this tight an hour is a real deviation, and
    // this is the notice the phasic channel exists for.
    //
    // It can interrupt at most once, because the key carries the date —
    // `day-runs-long:2026-03-10` habituates for the rest of the night.
    const state = withDayEnds(base(), [1080, 1095, 1065, 1110, 1050, 1080, 1100, 1070, 1085, 1075, 1090, 1080], { day: '2026-03-10', minutes: 19 * 60 });
    const found = candidates(expectationWatch(state, tick('2026-03-10T19:00:00.000Z')).effects).find((c) => c.kind === 'day-runs-long');

    expect(found).toBeDefined();
    expect(found!.surprise * found!.precision).toBeGreaterThan(DEFAULT_GATE_POLICY.phasicThreshold);
    expect(found!.key).toBe('day-runs-long:2026-03-10');
  });

  it('will not claim a late night on a machine left switched on', () => {
    // `input:activity` emits on a fixed cadence whenever the daemon is up, so only the
    // idle flag can say anyone is actually there. Without this the candidate fires
    // every night at the same hour on an open laptop.
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, () => 18 * 60),
      { day: '2026-03-10', minutes: 22 * 60 },
    );
    const idle: KernelState = { ...state, lifeEvent: { ...state.lifeEvent, idle: { consecutiveZeroWindows: 90, isIdle: true } } };
    expect(candidates(expectationWatch(idle, tick('2026-03-10T22:40:00.000Z')).effects).some((c) => c.kind === 'day-runs-long')).toBe(false);
  });

  it('does not let today vote on what normal is', () => {
    // A single 03:00 night must not raise the bar it is itself being measured against.
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, () => 18 * 60),
      { day: '2026-03-10', minutes: 3 * 60 },
    );
    const found = candidates(expectationWatch(state, tick('2026-03-10T23:30:00.000Z')).effects).find((c) => c.kind === 'day-runs-long');
    expect(found?.observation).toContain('18:00');
  });

  it('reports a drift that no single night would ever look surprising', () => {
    // Twenty minutes later each night for nine nights: not one of those nights is an
    // outlier, which is exactly why habituation-based detection cannot see it.
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, (_, i) => 18 * 60 + i * 20),
      { day: '2026-03-10', minutes: 18 * 60 },
    );
    const drift = candidates(expectationWatch(state, tick('2026-03-10T18:30:00.000Z')).effects).find((c) => c.kind === 'day-end-drift');

    expect(drift).toBeDefined();
    expect(drift!.shape).toBe('drift');
    expect(drift!.observation).toContain('later');
    // A slope reads the same whenever it is read, so it must never interrupt.
    expect(drift!.valueHalfLifeMs).toBeNull();
  });

  it('reports an earlier-ending drift too', () => {
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, (_, i) => 22 * 60 - i * 18),
      { day: '2026-03-10', minutes: 19 * 60 },
    );
    const drift = candidates(expectationWatch(state, tick('2026-03-10T19:30:00.000Z')).effects).find((c) => c.kind === 'day-end-drift');
    expect(drift!.observation).toContain('earlier');
  });

  it('ignores a flat series', () => {
    const state = withDayEnds(
      base(),
      Array.from({ length: 12 }, () => 18 * 60),
      { day: '2026-03-10', minutes: 18 * 60 },
    );
    expect(candidates(expectationWatch(state, tick('2026-03-10T18:30:00.000Z')).effects).some((c) => c.kind === 'day-end-drift')).toBe(false);
  });

  it('needs a week of days before it will claim anything about them', () => {
    const state = withDayEnds(base(), [1080, 1100, 1090], { day: '2026-03-10', minutes: 22 * 60 });
    expect(expectationWatch(state, tick('2026-03-10T22:40:00.000Z')).effects).toEqual([]);
  });
});

describe('expectationLearn', () => {
  it('learns the break stream from idle:start', () => {
    let state = base();
    state = expectationLearn(state, { id: 'i1', type: 'idle:start', ts: '2026-03-10T09:00:00.000Z', payload: {}, sanitized: true }).state;
    state = expectationLearn(state, { id: 'i2', type: 'idle:start', ts: '2026-03-10T10:30:00.000Z', payload: {}, sanitized: true }).state;

    const r = state.expectations.recurring['break|any'];
    expect(r!.intervalMs.n).toBe(1);
    expect(r!.intervalMs.mean).toBe(90 * MIN);
  });

  it('buckets weekday and weekend separately', () => {
    // Without this, a stream that stops at weekends learns a bimodal gap and reports
    // every Saturday as an absence.
    let state = base();
    // 2026-03-12 is a Thursday, 2026-03-14 a Saturday.
    state = expectationLearn(state, { id: 'f1', type: 'event:focus-flow', ts: '2026-03-12T10:00:00.000Z', payload: {}, sanitized: true }).state;
    state = expectationLearn(state, { id: 'f2', type: 'event:focus-flow', ts: '2026-03-14T10:00:00.000Z', payload: {}, sanitized: true }).state;

    expect(state.expectations.recurring['flow|weekday']).toBeDefined();
    expect(state.expectations.recurring['flow|weekend']).toBeDefined();
    expect(state.expectations.recurring['flow|weekday']!.intervalMs.n).toBe(0);
  });

  it('tracks the day-end phase series from activity, and only when the minute advances', () => {
    let state = base();
    state = expectationLearn(state, { id: 'a1', type: 'input:activity', ts: '2026-03-10T18:00:00.000Z', payload: {}, sanitized: true }).state;
    const afterFirst = state;
    state = expectationLearn(state, { id: 'a2', type: 'input:activity', ts: '2026-03-10T18:00:30.000Z', payload: {}, sanitized: true }).state;

    // Same minute: identical state object, so the densest event in the log costs no
    // allocation.
    expect(state).toBe(afterFirst);
    expect(state.expectations.dayEnd).toEqual([{ day: '2026-03-10', minutes: 14 * 60, basis: 'waking' }]);
  });

  it('does not key a repo stream when no project resolved', () => {
    // Roughly 78% of moments resolve to no project at all.
    const state = base();
    const { state: next } = expectationLearn(state, { id: 'w1', type: 'window:changed', ts: '2026-03-10T10:00:00.000Z', payload: { processName: 'Google Chrome', windowTitle: 'x' }, sanitized: true });
    expect(Object.keys(next.expectations.recurring).filter((k) => k.startsWith('repo:'))).toEqual([]);
  });

  it('keys a repo stream per project when one resolved', () => {
    const s = base();
    const state: KernelState = { ...s, project: { ...s.project, current: { id: 'proj-a', name: 'proj-a' } as never } };
    const { state: next } = expectationLearn(state, { id: 'w1', type: 'window:changed', ts: '2026-03-10T10:00:00.000Z', payload: { processName: 'Code', windowTitle: 'x' }, sanitized: true });
    expect(next.expectations.recurring['repo:proj-a|any']).toBeDefined();
  });

  it('returns the same state object when nothing matched', () => {
    const state = base();
    const { state: next } = expectationLearn(state, { id: 'g', type: 'git:commit', ts: '2026-03-10T10:00:00.000Z', payload: {}, sanitized: true });
    expect(next).toBe(state);
  });
});
