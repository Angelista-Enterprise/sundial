import { describe, it, expect } from 'vitest';
import { computeRecencyWeight, computeMomentImportance, computeScore, DEFAULT_SCORE_WEIGHTS, salienceFromConfidence, salienceFromScore } from './score.js';

describe('computeRecencyWeight', () => {
  it('is 1 for the current instant', () => {
    expect(computeRecencyWeight('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(1);
  });

  it('is 0.5 after exactly one half-life', () => {
    const halfLifeMs = 1000;
    expect(computeRecencyWeight('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', halfLifeMs)).toBeCloseTo(0.5, 5);
  });

  it('never goes negative for a timestamp in the future (clock skew)', () => {
    expect(computeRecencyWeight('2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z')).toBe(1);
  });
});

describe('computeMomentImportance', () => {
  it('is ~1 for a near-instant moment', () => {
    expect(computeMomentImportance(1000)).toBeCloseTo(1, 1);
  });

  it('increases with duration, capped at 10', () => {
    expect(computeMomentImportance(30 * 60_000)).toBeGreaterThan(computeMomentImportance(5 * 60_000));
    // The duration curve approaches 10 asymptotically; only a bonus reaches the clamp.
    expect(computeMomentImportance(600 * 60_000)).toBeCloseTo(10, 3);
    expect(computeMomentImportance(600 * 60_000)).toBeLessThanOrEqual(10);
  });

  /**
   * The regression that made the term inert: `round(1 + minutes/30)` returned
   * exactly 1 for everything under 15 minutes, and 97% of real moments are
   * shorter than that. Distinct short durations must produce distinct scores.
   */
  it('discriminates between short moments, where almost all real moments live', () => {
    const two = computeMomentImportance(2 * 60_000);
    const five = computeMomentImportance(5 * 60_000);
    const twelve = computeMomentImportance(12 * 60_000);
    expect(two).toBeLessThan(five);
    expect(five).toBeLessThan(twelve);
    expect(new Set([two, five, twelve]).size).toBe(3);
  });

  it('does not round away the resolution the decay depends on', () => {
    const v = computeMomentImportance(4 * 60_000);
    expect(Number.isInteger(v)).toBe(false);
  });

  describe('C2: rollup-aware signals', () => {
    it('a significant life event (deploy/big-commit/test-recovery) adds a +3 bonus over duration alone', () => {
      const withoutSignal = computeMomentImportance(30 * 60_000);
      const withDeploy = computeMomentImportance(30 * 60_000, { lifeEvents: ['event:deploy'] });
      expect(withDeploy).toBe(withoutSignal + 3);
    });

    it('git activity with no significant life event adds a smaller +1 bonus', () => {
      const withoutSignal = computeMomentImportance(30 * 60_000);
      const withCommits = computeMomentImportance(30 * 60_000, { gitCommitCount: 2 });
      const withNotableCommands = computeMomentImportance(30 * 60_000, { notableCommands: ['git push'] });
      expect(withCommits).toBe(withoutSignal + 1);
      expect(withNotableCommands).toBe(withoutSignal + 1);
    });

    it('an insignificant lifeEvent type contributes no bonus on its own', () => {
      expect(computeMomentImportance(30 * 60_000, { lifeEvents: ['event:context-switch'] })).toBe(computeMomentImportance(30 * 60_000));
    });

    it('still caps at 10 even with a bonus', () => {
      expect(computeMomentImportance(600 * 60_000, { lifeEvents: ['event:deploy'] })).toBe(10);
    });

    it('is unaffected when signals is omitted or empty', () => {
      const base = computeMomentImportance(30 * 60_000);
      expect(computeMomentImportance(30 * 60_000, {})).toBe(base);
      expect(computeMomentImportance(30 * 60_000, { lifeEvents: [], notableCommands: [], gitCommitCount: 0 })).toBe(base);
    });
  });
});

describe('salience normalisation', () => {
  it('maps a 1-10 score onto 0-1', () => {
    expect(salienceFromScore(1)).toBe(0);
    expect(salienceFromScore(10)).toBe(1);
    expect(salienceFromScore(5.5)).toBeCloseTo(0.5, 5);
  });

  it('maps a 0-100 confidence onto 0-1', () => {
    expect(salienceFromConfidence(0)).toBe(0);
    expect(salienceFromConfidence(80)).toBeCloseTo(0.8, 5);
    expect(salienceFromConfidence(100)).toBe(1);
  });

  it('clamps out-of-range inputs rather than letting them distort a ranking', () => {
    expect(salienceFromScore(0)).toBe(0);
    expect(salienceFromScore(99)).toBe(1);
    expect(salienceFromConfidence(-5)).toBe(0);
    expect(salienceFromConfidence(1000)).toBe(1);
  });

  /**
   * The defect the salience parameter exists to prevent: a moment passed its raw
   * 1-10 `importanceScore` while a fact passed `confidence / 10` off a 0-100
   * column. Both looked like "1-10" at the call site. Normalised, a mean fact
   * (confidence 80) and a mean moment can no longer be compared by accident on
   * two different scales — and the maximum possible gap is bounded by the weight.
   */
  it('bounds the cross-type head start by the salience weight alone', () => {
    const fact = computeScore({ recency: 0, salience: salienceFromConfidence(80), relevance: 0 });
    const moment = computeScore({ recency: 0, salience: salienceFromScore(1), relevance: 0 });
    expect(fact - moment).toBeLessThanOrEqual(DEFAULT_SCORE_WEIGHTS.salience);
  });

  it('cannot let salience outrank a strong relevance match', () => {
    const irrelevantButConfident = computeScore({ recency: 1, salience: 1, relevance: 0 });
    const relevantAndDull = computeScore({ recency: 0, salience: 0, relevance: 1 });
    expect(relevantAndDull).toBeGreaterThan(irrelevantButConfident);
  });
});

describe('computeScore', () => {
  it('weights recency/salience/relevance per DEFAULT_SCORE_WEIGHTS', () => {
    const score = computeScore({ recency: 1, salience: 1, relevance: 1 });
    expect(score).toBeCloseTo(DEFAULT_SCORE_WEIGHTS.recency + DEFAULT_SCORE_WEIGHTS.salience + DEFAULT_SCORE_WEIGHTS.relevance, 5);
  });

  it('sums the weights to 1, so a score stays on a 0-1 scale', () => {
    const { recency, salience, relevance } = DEFAULT_SCORE_WEIGHTS;
    expect(recency + salience + relevance).toBeCloseTo(1, 5);
  });

  it('is 0 when all inputs are 0', () => {
    expect(computeScore({ recency: 0, salience: 0, relevance: 0 })).toBe(0);
  });

  it('ranks a recent, relevant item above an old, irrelevant one', () => {
    const a = computeScore({ recency: 0.9, salience: 0.5, relevance: 0.8 });
    const b = computeScore({ recency: 0.1, salience: 0.5, relevance: 0.1 });
    expect(a).toBeGreaterThan(b);
  });
});
