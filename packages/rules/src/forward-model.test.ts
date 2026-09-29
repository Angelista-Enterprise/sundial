import { describe, it, expect } from 'vitest';
import { bumpCalibration, clampProb, hasSkill, PROB_EPS } from './forward-model.js';

/**
 * `predictionForecast`/`predictionResolve` and their tests lived here until the
 * `project-continuity` forecaster was retired on 2026-07-29 (see
 * `forward-model.ts` for the measurement that retired it). What remains is the
 * calibration machinery every forecaster shares, so this covers that directly
 * rather than through whichever forecaster happens to be live.
 */
describe('clampProb', () => {
  it('keeps log-loss finite at both extremes', () => {
    expect(clampProb(0)).toBe(PROB_EPS);
    expect(clampProb(1)).toBe(1 - PROB_EPS);
    expect(Number.isFinite(-Math.log(clampProb(0)))).toBe(true);
  });

  it('passes an ordinary probability through untouched', () => {
    expect(clampProb(0.42)).toBe(0.42);
  });
});

describe('bumpCalibration', () => {
  it('opens a fresh record for an unseen kind', () => {
    const cal = bumpCalibration({}, 'day-ending', 1, 0.75);
    expect(cal['day-ending']).toEqual({ n: 1, hits: 1, brierSum: (0.75 - 1) ** 2 });
  });

  it('accumulates n, hits and Brier sum across resolutions', () => {
    const first = bumpCalibration({}, 'day-ending', 1, 0.6);
    const second = bumpCalibration(first, 'day-ending', 0, 0.6);
    expect(second['day-ending']).toMatchObject({ n: 2, hits: 1 });
    expect(second['day-ending'].brierSum).toBeCloseTo((0.6 - 1) ** 2 + 0.6 ** 2, 10);
  });

  it('counts a miss without incrementing hits', () => {
    const cal = bumpCalibration({}, 'day-ending', 0, 0.9);
    expect(cal['day-ending']).toMatchObject({ n: 1, hits: 0 });
  });

  /**
   * The property that let `project-continuity` be retired without disturbing
   * `day-ending`'s accumulated record, and the reason `calibration` is keyed by
   * kind rather than pooled.
   */
  it('never touches another kind\'s record', () => {
    const existing = { 'day-ending': { n: 10, hits: 7, brierSum: 2.5 } };
    const cal = bumpCalibration(existing, 'some-future-forecaster', 1, 0.5);
    expect(cal['day-ending']).toEqual(existing['day-ending']);
    expect(cal['some-future-forecaster']).toMatchObject({ n: 1, hits: 1 });
  });

  it('does not mutate the record it is given', () => {
    const existing = { 'day-ending': { n: 1, hits: 1, brierSum: 0.1 } };
    bumpCalibration(existing, 'day-ending', 0, 0.5);
    expect(existing['day-ending']).toEqual({ n: 1, hits: 1, brierSum: 0.1 });
  });
});

describe('hasSkill (Q8)', () => {
  it('needs 50 resolutions and a Brier under the constant p(1 − p)', () => {
    // The live shapes, made up: a tournament base rate that bets its own mean does not beat it.
    expect(hasSkill({ t: { n: 58, hits: 41, brierSum: 14.45 } }, 't')).toBe(false);
    expect(hasSkill({ t: { n: 49, hits: 10, brierSum: 1 } }, 't')).toBe(false);
    expect(hasSkill({ t: { n: 742, hits: 193, brierSum: 124.7 } }, 't')).toBe(true);
    expect(hasSkill({ t: { n: 60, hits: 0, brierSum: 0 } }, 't')).toBe(false);
    expect(hasSkill({}, 't')).toBe(false);
  });
});
