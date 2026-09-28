import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_UNCERTAINTY_GAPS, cellEntropy, excessLogLoss, expectedLogLoss, posteriorMean, uncertaintyMap } from './uncertainty-map.js';

const tick = (ts = '2026-08-02T10:00:00.000Z'): SanitizedEvent => ({ id: 't1', type: 'clock:tick', ts, payload: {}, sanitized: true });

function withTable(table: Record<number, { n: number; hits: number }>): KernelState {
  const base = createInitialState('d1');
  return { ...base, predictions: { ...base.predictions, hourlyDoneRate: table } };
}

describe('posteriorMean', () => {
  /** The `+1`s are the uninformative prior. A raw frequency would report 0.0 with total confidence on one observation. */
  it('never claims certainty from a single observation', () => {
    expect(posteriorMean(1, 0)).toBeCloseTo(1 / 3, 10);
    expect(posteriorMean(1, 1)).toBeCloseTo(2 / 3, 10);
  });

  it('converges on the observed rate as evidence accumulates', () => {
    expect(posteriorMean(1000, 500)).toBeCloseTo(0.5, 3);
    // Still biased toward the prior by ~0.0008 at n=1000 on a rare event, which
    // is the point of the prior rather than an error in it.
    expect(posteriorMean(1000, 100)).toBeCloseTo(0.1, 2);
  });

  it('is one half when nothing has been observed', () => {
    expect(posteriorMean(0, 0)).toBeCloseTo(0.5, 10);
  });
});

describe('expectedLogLoss', () => {
  it('is near zero when the forecaster bets what it believes and believes hard', () => {
    expect(expectedLogLoss(1000, 0, 0.02)).toBeLessThan(0.05);
  });

  /** A coin flip is genuinely expensive however well you bet it — that is the irreducible half. */
  it('is high for a cell the daemon believes is a coin flip', () => {
    expect(expectedLogLoss(100, 50, 0.5)).toBeGreaterThan(0.6);
  });

  /**
   * The case a variance measure cannot see, and the reason this metric replaced
   * one. Belief and bet have come apart: the cell is believed to fire half the
   * time and the forecaster is about to bet 2% against it.
   */
  it('is high when belief and bet disagree, even on a confident bet', () => {
    const confidentAndRight = expectedLogLoss(100, 2, 0.02);
    const confidentAndWrong = expectedLogLoss(100, 50, 0.02);
    expect(confidentAndWrong).toBeGreaterThan(confidentAndRight * 5);
  });

  it('stays finite at the extremes rather than returning Infinity', () => {
    expect(Number.isFinite(expectedLogLoss(10, 10, 0))).toBe(true);
    expect(Number.isFinite(expectedLogLoss(10, 0, 1))).toBe(true);
  });
});

describe('uncertaintyMap', () => {
  it('ignores everything that is not a tick', () => {
    const state = withTable({ 9: { n: 10, hits: 5 } });
    const { state: next, effects } = uncertaintyMap(state, { id: 'e', type: 'window:changed', ts: '2026-08-02T10:00:00.000Z', payload: {}, sanitized: true });

    expect(next).toBe(state);
    expect(effects).toEqual([]);
  });

  it('is a pure readout — never emits an effect', () => {
    const { effects } = uncertaintyMap(withTable({ 9: { n: 10, hits: 5 }, 17: { n: 12, hits: 9 } }), tick());
    expect(effects).toEqual([]);
  });

  /**
   * An hour never observed is an absence of behaviour, not uncertainty about
   * it. Letting those in would rank the small hours at the top of every list —
   * maximally unknown, and telling the reader nothing.
   */
  it('excludes hours with no observations at all', () => {
    const { state } = uncertaintyMap(withTable({ 3: { n: 0, hits: 0 }, 17: { n: 8, hits: 4 } }), tick());

    expect(state.mind.gaps.map((g) => g.cell)).toEqual(['17']);
  });

  it('ranks worst-expected-loss first and labels cells in the owner’s terms', () => {
    const { state } = uncertaintyMap(
      withTable({
        // Confidently and correctly "never the last hour".
        9: { n: 60, hits: 0 },
        // Genuinely unsettled.
        17: { n: 20, hits: 10 },
      }),
      tick(),
    );

    expect(state.mind.gaps[0]).toMatchObject({ cell: '17', label: '17:00', kind: 'day-ending', forecaster: 'hourly-rate' });
    expect(state.mind.gaps[0]!.expectedLoss).toBeGreaterThan(state.mind.gaps[1]!.expectedLoss);
  });

  it('keeps the list short enough to read', () => {
    const table: Record<number, { n: number; hits: number }> = {};
    for (let hour = 0; hour < 24; hour += 1) table[hour] = { n: 10, hits: hour % 5 };

    const { state } = uncertaintyMap(withTable(table), tick());

    expect(state.mind.gaps).toHaveLength(MAX_UNCERTAINTY_GAPS);
  });

  /** Returns the SAME object when nothing moved, so a quiet tick does not churn a fresh state every minute. */
  it('does not rebuild state when the ranking is unchanged', () => {
    const first = uncertaintyMap(withTable({ 17: { n: 20, hits: 10 } }), tick());
    const second = uncertaintyMap(first.state, tick('2026-08-02T10:01:00.000Z'));

    expect(second.state).toBe(first.state);
  });

  it('replaces gaps persisted without excessLoss even when no count moved — shape is identity too', () => {
    // The live failure this pins: a snapshot from before `excessLoss` existed
    // matches a fresh ranking on (cell, n, hits), so the unchanged-ranking
    // early-exit above kept the OLD objects and the new field could not reach
    // live state until a count happened to move — up to a day, during which
    // `researchGoals` read `undefined` off every gap and its migration
    // re-baselined goals to `undefined` in turn.
    const first = uncertaintyMap(withTable({ 17: { n: 20, hits: 10 } }), tick());
    const legacy = first.state.mind.gaps.map((gap) => {
      const { excessLoss: _dropped, ...rest } = gap;
      return rest as typeof gap;
    });
    const persisted: KernelState = { ...first.state, mind: { ...first.state.mind, gaps: legacy } };

    const { state } = uncertaintyMap(persisted, tick('2026-08-02T10:01:00.000Z'));

    expect(state).not.toBe(persisted);
    expect(typeof state.mind.gaps[0].excessLoss).toBe('number');
  });

  it('preserves the rest of state.mind, so it composes with mindTrack', () => {
    const base = withTable({ 17: { n: 20, hits: 10 } });
    const seeded: KernelState = { ...base, mind: { ...base.mind, mood: 'restless', circadian: 'night', lastEndogenousReflectionAt: '2026-08-01T23:00:00.000Z' } };

    const { state } = uncertaintyMap(seeded, tick());

    expect(state.mind.mood).toBe('restless');
    expect(state.mind.circadian).toBe('night');
    expect(state.mind.lastEndogenousReflectionAt).toBe('2026-08-01T23:00:00.000Z');
    expect(state.mind.gaps).not.toHaveLength(0);
  });

  it('is empty on a daemon that has learned nothing yet, rather than inventing gaps', () => {
    const { state } = uncertaintyMap(createInitialState('d1'), tick());
    expect(state.mind.gaps).toEqual([]);
  });
});

describe('the loss split (expectedLoss = entropy + excess)', () => {
  it('adds back up exactly, so the two can never drift apart', () => {
    for (const [n, hits, predicted] of [
      [20, 10, 0.2],
      [5, 1, 0.5],
      [100, 94, 0.9],
      [7, 3, 0.06],
    ] as const) {
      expect(cellEntropy(n, hits) + excessLogLoss(n, hits, predicted)).toBeCloseTo(expectedLogLoss(n, hits, predicted), 10);
    }
  });

  it('excess goes to zero when the forecaster bets exactly what the cell believes — that IS "learned"', () => {
    const n = 40;
    const hits = 18;
    expect(excessLogLoss(n, hits, posteriorMean(n, hits))).toBeCloseTo(0, 10);
  });

  it('entropy is a FLOOR no evidence removes — the reason the old criterion was unsatisfiable', () => {
    // A cell that really is a coin flip: watched 10 times or 1000, the total
    // loss cannot fall below ~0.69 nats, so a target set at 70% of the total
    // (~0.48) is unreachable. Only the excess can be retired.
    const wide = expectedLogLoss(10, 5, posteriorMean(10, 5));
    const deep = expectedLogLoss(1000, 500, posteriorMean(1000, 500));
    expect(deep).toBeGreaterThan(0.68);
    expect(deep).toBeCloseTo(wide, 1);
    expect(excessLogLoss(1000, 500, posteriorMean(1000, 500))).toBeCloseTo(0, 6);
  });

  it('ranks the other two forecasters’ cells beside the hourly ones', () => {
    const state = createInitialState('test-device');
    const seeded = {
      ...state,
      predictions: {
        ...state.predictions,
        hourlyDoneRate: { 9: { n: 20, hits: 1 } },
        fragmentation: { ...state.predictions.fragmentation, byPrevState: { 'prev-frag': { n: 12, hits: 6 }, 'prev-calm': { n: 40, hits: 3 } } },
        projectTouch: { ...state.predictions.projectTouch, byProject: { '~/x/alpha': { n: 10, hits: 5 }, 'named:beta': { n: 8, hits: 0 } } },
      },
    };
    const { state: next } = uncertaintyMap(seeded, { id: 't', type: 'clock:tick', ts: '2026-08-03T10:00:00.000Z', payload: {} } as never);
    const kinds = new Set(next.mind.gaps.map((gap) => gap.kind));
    expect(kinds.has('hour-fragmented')).toBe(true);
    expect(kinds.has('project-touched')).toBe(true);
    const frag = next.mind.gaps.find((gap) => gap.kind === 'hour-fragmented');
    expect(frag?.forecaster).toBe('prev-hour-lag');
    expect(frag?.label).toMatch(/hour after/);
    const proj = next.mind.gaps.find((gap) => gap.kind === 'project-touched');
    expect(proj?.label).toMatch(/alpha|beta/);
  });
});
