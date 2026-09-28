import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { anomalyZscore, computeZScore, unobservedGapMs } from './anomaly-zscore.js';
import { EMITS_PER_FULL_HOUR, coverageBucket } from './coverage-track.js';

// B5: anomalyZscore now buckets by the machine's *local* hour (`getHours()`,
// not `getUTCHours()`) — correct for the running daemon's real timezone,
// but it means this file's `...Z` (UTC) fixture timestamps only map onto
// the `hourOfDay` values asserted below if the test process's local
// timezone is also UTC. Pin it so these tests are deterministic regardless
// of which timezone the machine running them is actually set to.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('computeZScore', () => {
  it('returns null with fewer than 2 samples (not enough history)', () => {
    expect(computeZScore(50, [])).toBeNull();
    expect(computeZScore(50, [40])).toBeNull();
  });

  it('computes a real z-score against a stable baseline', () => {
    // mean=30, population stddev=0 -> spread floored at 1 -> z = (60-30)/1 = 30
    expect(computeZScore(60, [30, 30, 30])).toBe(30);
  });

  it('computes a normal (non-anomalous) z-score within typical variance', () => {
    const z = computeZScore(31, [30, 32, 28, 31, 29]);
    expect(Math.abs(z!)).toBeLessThan(2);
  });

  it('special-cases mean<=0: z=3 if observed>0, else 0', () => {
    expect(computeZScore(10, [0, 0])).toBe(3);
    expect(computeZScore(0, [0, 0])).toBe(0);
  });
});

function withMoment(state: KernelState, startTime: string, processName = 'Code'): KernelState {
  return { ...state, moment: { id: 'm1', sessionId: 's1', startTime, processName, projectId: null, rollup: { processName, windowTitles: [], shellCommandCount: 0, notableCommands: [], gitCommitCount: 0, gitBranch: null, calendarActive: false, typingEventCount: 0, inputEventCount: 0, activeMs: 0, lifeEvents: [], projectSource: null, projectConfidence: null, micActive: false, cameraActive: false, meetingTitle: null, meetingAttendees: [], screenTopics: [], screenExcerpt: null }, intent: { status: 'none' } } };
}

/**
 * Baseline samples seeded before an outlier is expected to emit.
 *
 * Was 3 until 2026-08-02, when `MIN_BASELINE_SAMPLES` went to 10. The old figure is
 * exactly the regime the deleted companion insights came from — z-scores of 2.04-2.95
 * against baselines of as few as two samples — so a test that still passed on 3
 * samples would be asserting the defect.
 */
const BASELINE_SEED = 12;

function windowEvent(ts: string): SanitizedEvent {
  return { id: 'e1', type: 'window:changed', ts, payload: { processName: 'Warp' }, sanitized: true };
}

describe('anomalyZscore', () => {
  it('does nothing (just records the sample) when there is no moment open', () => {
    const state = createInitialState('d1');
    const { effects } = anomalyZscore(state, windowEvent('2026-01-01T10:00:00.000Z'));
    expect(effects).toEqual([]);
  });

  it('records samples without emitting until enough history exists', () => {
    let state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
    const { state: next, effects } = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z'));

    expect(effects).toEqual([]);
    expect(next.baselines.hourlyDurationsByKind['10']).toEqual([5]);
  });

  it('emits anomaly:detected once enough history shows a real outlier', () => {
    let state = createInitialState('d1');
    // Seed a stable baseline: several 5-minute sessions at hour 10.
    for (let i = 0; i < BASELINE_SEED; i++) {
      state = withMoment(state, '2026-01-01T10:00:00.000Z');
      state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
    }
    expect(state.baselines.hourlyDurationsByKind['10']).toHaveLength(BASELINE_SEED);

    // Now a wildly longer session in the same hour bucket.
    state = withMoment(state, '2026-01-02T10:00:00.000Z');
    const { effects } = anomalyZscore(state, windowEvent('2026-01-02T11:00:00.000Z'));

    expect(effects).toHaveLength(1);
    expect((effects[0] as any).event.type).toBe('anomaly:detected');
    expect((effects[0] as any).event.payload.kind).toBe('high-activity');
    expect((effects[0] as any).event.payload.hourOfDay).toBe(10);
  });

  it('does not re-emit for the same hour bucket on the same calendar date', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < BASELINE_SEED; i++) {
      state = withMoment(state, '2026-01-01T10:00:00.000Z');
      state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
    }
    state = withMoment(state, '2026-01-02T10:00:00.000Z');
    state = anomalyZscore(state, windowEvent('2026-01-02T11:00:00.000Z')).state;

    // Another outlier, same date, same hour bucket -> suppressed.
    state = withMoment(state, '2026-01-02T10:00:00.000Z');
    const { effects } = anomalyZscore(state, windowEvent('2026-01-02T11:30:00.000Z'));
    expect(effects).toEqual([]);
  });

  it('re-emits for the same hour bucket on a new calendar date', () => {
    let state = createInitialState('d1');
    for (let i = 0; i < BASELINE_SEED; i++) {
      state = withMoment(state, '2026-01-01T10:00:00.000Z');
      state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
    }
    state = withMoment(state, '2026-01-02T10:00:00.000Z');
    state = anomalyZscore(state, windowEvent('2026-01-02T11:00:00.000Z')).state;

    // A far more extreme outlier, since the prior date's outlier duration
    // is now itself part of the rolling baseline and shifted it upward.
    state = withMoment(state, '2026-01-03T10:00:00.000Z');
    const { effects } = anomalyZscore(state, windowEvent('2026-01-03T18:00:00.000Z'));
    expect(effects).toHaveLength(1);
  });

  it('D2-adjacent fix: a same-process title change does not record a sample or evaluate an anomaly (B1 append, not a real close)', () => {
    const state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
    const sameProcessEvent: SanitizedEvent = { id: 'e1', type: 'window:changed', ts: '2026-01-01T10:05:00.000Z', payload: { processName: 'Code' }, sanitized: true };

    const { state: next, effects } = anomalyZscore(state, sameProcessEvent);

    expect(effects).toEqual([]);
    expect(next.baselines.hourlyDurationsByKind['10']).toBeUndefined();
  });

  function clockTickEvent(ts: string): SanitizedEvent {
    return { id: `t-${ts}`, type: 'clock:tick', ts, payload: {}, sanitized: true };
  }

  describe('B5: local-hour bucketing', () => {
    it('buckets by the machine local hour, not a fixed UTC hour', () => {
      const originalTz = process.env.TZ;
      try {
        // New York is UTC-5 in January (no DST) — 10:00 UTC is 05:00 local.
        process.env.TZ = 'America/New_York';
        let state = createInitialState('d1');
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
        expect(state.baselines.hourlyDurationsByKind['5']).toEqual([5]);
        expect(state.baselines.hourlyDurationsByKind['10']).toBeUndefined();
      } finally {
        process.env.TZ = originalTz;
      }
    });
  });

  describe('B5: mid-session evaluation on clock:tick', () => {
    it('evaluates the currently-open moment on clock:tick and can emit an anomaly before it closes', () => {
      let state = createInitialState('d1');
      // Seed a stable ~5min baseline for hour 10 across several closed moments.
      for (let i = 0; i < BASELINE_SEED; i++) {
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
      }

      // A moment open since 10:00 is still going at 11:00 — a full hour, wildly longer than the 5min baseline.
      state = withMoment(state, '2026-01-02T10:00:00.000Z');
      const { effects } = anomalyZscore(state, clockTickEvent('2026-01-02T11:00:00.000Z'));

      expect(effects).toHaveLength(1);
      expect((effects[0] as any).event.payload.kind).toBe('high-activity');
    });

    it('does not record the in-progress duration as a baseline sample', () => {
      let state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
      const { state: next } = anomalyZscore(state, clockTickEvent('2026-01-01T10:45:00.000Z'));
      expect(next.baselines.hourlyDurationsByKind['10']).toBeUndefined();
    });

    it('is a no-op on clock:tick when no moment is open', () => {
      const state = createInitialState('d1');
      const { state: next, effects } = anomalyZscore(state, clockTickEvent('2026-01-01T10:00:00.000Z'));
      expect(next).toBe(state);
      expect(effects).toEqual([]);
    });

    it('a mid-session anomaly suppresses a duplicate when the same moment later closes still-anomalous, same day', () => {
      let state = createInitialState('d1');
      for (let i = 0; i < BASELINE_SEED; i++) {
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
      }

      state = withMoment(state, '2026-01-02T10:00:00.000Z');
      state = anomalyZscore(state, clockTickEvent('2026-01-02T11:00:00.000Z')).state;

      // The same still-open moment finally closes, later the same day — still anomalous, but already alerted.
      const { effects } = anomalyZscore(state, windowEvent('2026-01-02T12:00:00.000Z'));
      expect(effects).toEqual([]);
    });
  });

  describe('B5: minimum sample-duration floor', () => {
    it('does not sample or evaluate a moment under 1 minute', () => {
      let state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
      const { state: next, effects } = anomalyZscore(state, windowEvent('2026-01-01T10:00:30.000Z'));

      expect(effects).toEqual([]);
      expect(next.baselines.hourlyDurationsByKind['10']).toBeUndefined();
    });

    it('does sample right at the 1 minute floor', () => {
      let state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
      const { state: next } = anomalyZscore(state, windowEvent('2026-01-01T10:01:00.000Z'));
      expect(next.baselines.hourlyDurationsByKind['10']).toEqual([1]);
    });
  });

  describe('precision floors (2026-08-02, with the noticing gate)', () => {
    it('refuses to emit against a thin baseline however extreme the z-score', () => {
      let state = createInitialState('d1');
      // Three samples is what the deleted companion insights were built on; some ran
      // on two.
      for (let i = 0; i < 3; i++) {
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z')).state;
      }

      state = withMoment(state, '2026-01-02T10:00:00.000Z');
      const { effects } = anomalyZscore(state, windowEvent('2026-01-02T13:00:00.000Z'));
      expect(effects).toEqual([]);
    });

    it('refuses to emit a short observation even against a well-established baseline', () => {
      let state = createInitialState('d1');
      // A baseline of 30-second moments, so 6 minutes is a huge relative outlier —
      // and still not worth telling anyone about. This is the exact shape of every
      // insight the surface used to produce: "a 6.8-minute Chrome sprint".
      for (let i = 0; i < BASELINE_SEED; i++) {
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:01:00.000Z')).state;
      }

      state = withMoment(state, '2026-01-02T10:00:00.000Z');
      const { effects } = anomalyZscore(state, windowEvent('2026-01-02T10:06:48.000Z'));
      expect(effects).toEqual([]);
    });

    it('still emits when the baseline is solid and the observation is substantial', () => {
      let state = createInitialState('d1');
      for (let i = 0; i < BASELINE_SEED; i++) {
        state = withMoment(state, '2026-01-01T10:00:00.000Z');
        state = anomalyZscore(state, windowEvent('2026-01-01T10:01:00.000Z')).state;
      }

      state = withMoment(state, '2026-01-02T10:00:00.000Z');
      const { effects } = anomalyZscore(state, windowEvent('2026-01-02T10:40:00.000Z'));
      expect(effects).toHaveLength(1);
      expect((effects[0] as any).event.payload.observedMinutes).toBe(40);
    });

    it('keeps sampling the baseline even when it refuses to emit — the floors gate narration, not learning', () => {
      let state = withMoment(createInitialState('d1'), '2026-01-01T10:00:00.000Z');
      const { state: next } = anomalyZscore(state, windowEvent('2026-01-01T10:05:00.000Z'));
      expect(next.baselines.hourlyDurationsByKind['10']).toEqual([5]);
    });
  });

  describe('unobserved gaps are not dwell (2026-08-12 sleep incident)', () => {
    /** Fills every hour bucket in `[fromIso, toIso)` as fully watched, the way a running daemon would. */
    function observed(state: KernelState, fromIso: string, toIso: string): KernelState {
      const observedHours = { ...state.coverage.observedHours };
      for (let cursor = Date.parse(fromIso); cursor < Date.parse(toIso); cursor += 3_600_000) {
        observedHours[coverageBucket(new Date(cursor).toISOString(), state.config.timezone)] = EMITS_PER_FULL_HOUR;
      }
      return { ...state, coverage: { ...state.coverage, observedHours } };
    }

    /** A baseline of real 40-minute sessions at hour 19, each one fully observed. */
    function seededAtHour19(): KernelState {
      let state = createInitialState('d1');
      for (let i = 0; i < BASELINE_SEED; i++) {
        const day = String(i + 1).padStart(2, '0');
        state = observed(state, `2026-08-${day}T19:00:00.000Z`, `2026-08-${day}T20:00:00.000Z`);
        state = withMoment(state, `2026-08-${day}T19:00:00.000Z`, 'Google Chrome');
        state = anomalyZscore(state, windowEvent(`2026-08-${day}T19:40:00.000Z`)).state;
      }
      return state;
    }

    it('does not emit when the first tick after an overnight sleep spans unwatched hours', () => {
      // The incident, reproduced: a moment opened at 19:00 the previous evening is
      // still open when the machine wakes 21 hours later. The evening was watched;
      // the night was not. Raw elapsed would be 1266 minutes at z=772.
      let state = seededAtHour19();
      state = observed(state, '2026-08-12T17:00:00.000Z', '2026-08-12T20:00:00.000Z');
      state = withMoment(state, '2026-08-12T19:00:00.000Z', 'Google Chrome');

      const wakeTick = { id: 'tick-wake', type: 'clock:tick', ts: '2026-08-13T16:06:00.000Z', payload: {}, sanitized: true } as SanitizedEvent;
      const { state: next, effects } = anomalyZscore(state, wakeTick);

      expect(effects).toEqual([]);
      // And the poisoned duration must not have reached the baseline or spent the
      // hour's once-a-day dedup slot, or the fix would only move the damage.
      expect(next.baselines.hourlyDurationsByKind['19']).toHaveLength(BASELINE_SEED);
      expect(next.baselines.lastAnomalyByKind['19']).toBeUndefined();
    });

    it('still emits for a genuinely long session the daemon watched throughout', () => {
      let state = seededAtHour19();
      state = observed(state, '2026-08-12T19:00:00.000Z', '2026-08-12T23:00:00.000Z');
      state = withMoment(state, '2026-08-12T19:00:00.000Z', 'Google Chrome');

      const tick = { id: 'tick-late', type: 'clock:tick', ts: '2026-08-12T22:00:00.000Z', payload: {}, sanitized: true } as SanitizedEvent;
      const { effects } = anomalyZscore(state, tick);

      expect(effects).toHaveLength(1);
      expect((effects[0] as any).event.payload.observedMinutes).toBe(180);
    });

    it('reports null rather than a full gap when no observation record exists at all', () => {
      const state = createInitialState('d1');
      expect(unobservedGapMs(state, Date.parse('2026-08-12T19:00:00.000Z'), Date.parse('2026-08-13T16:00:00.000Z'))).toBeNull();
    });

    it('measures the unwatched remainder when a record does exist', () => {
      let state = createInitialState('d1');
      state = observed(state, '2026-08-12T19:00:00.000Z', '2026-08-12T20:00:00.000Z');
      const gap = unobservedGapMs(state, Date.parse('2026-08-12T19:00:00.000Z'), Date.parse('2026-08-12T21:00:00.000Z'));
      expect(gap).toBeCloseTo(3_600_000, -3);
    });
  });

  it('ignores non-window:changed, non-clock:tick events', () => {
    const state = createInitialState('d1');
    const event: SanitizedEvent = { id: 'e1', type: 'input:activity', ts: '2026-01-01T00:00:00.000Z', payload: {}, sanitized: true };
    const { state: next, effects } = anomalyZscore(state, event);
    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });
});
