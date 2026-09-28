import { describe, it, expect } from 'vitest';
import { defaultMomentRollupExtras } from '@sundial/kernel/initial-state.js';
import type { MomentRollup } from '@sundial/kernel/types.js';
import { computeFocusScore, focusQuality } from './focus-score.js';

function rollup(overrides: Partial<MomentRollup> = {}): MomentRollup {
  return { processName: 'Code', windowTitles: [], ...defaultMomentRollupExtras, ...overrides };
}

const MIN = 60_000;

describe('computeFocusScore', () => {
  it('scores a long uninterrupted engaged moment as deep (the WCS deep-block case)', () => {
    // 120 min in one process, active typing, no disruptions → duration maxes out.
    const score = computeFocusScore(rollup({ typingEventCount: 500 }), 120 * MIN);
    expect(score).toBeGreaterThanOrEqual(0.7);
    expect(focusQuality(score)).toBe('deep');
  });

  it('scores a short engaged moment as shallow', () => {
    const score = computeFocusScore(rollup({ typingEventCount: 10 }), 3 * MIN);
    expect(score).toBeLessThan(0.4);
    expect(focusQuality(score)).toBe('shallow');
  });

  it('docks for within-moment thrashing/interruption', () => {
    const calm = computeFocusScore(rollup({ typingEventCount: 100 }), 20 * MIN);
    const thrashy = computeFocusScore(rollup({ typingEventCount: 100, lifeEvents: ['event:thrashing', 'event:interruption'] }), 20 * MIN);
    expect(thrashy).toBeLessThan(calm);
  });

  it('floors high for a confirmed focus-flow even on a shorter span', () => {
    const score = computeFocusScore(rollup({ lifeEvents: ['event:focus-flow'], typingEventCount: 50 }), 5 * MIN);
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it('a passive (no typing/commands) span scores below an engaged one of equal length', () => {
    const passive = computeFocusScore(rollup(), 10 * MIN);
    const engaged = computeFocusScore(rollup({ typingEventCount: 200 }), 10 * MIN);
    expect(engaged).toBeGreaterThan(passive);
  });

  it('clamps to [0,1]', () => {
    const s = computeFocusScore(rollup({ typingEventCount: 999, lifeEvents: ['event:focus-flow'] }), 999 * MIN);
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe('focusQuality buckets', () => {
  it('deep ≥ 0.7, steady ≥ 0.4, else shallow', () => {
    expect(focusQuality(0.7)).toBe('deep');
    expect(focusQuality(0.5)).toBe('steady');
    expect(focusQuality(0.39)).toBe('shallow');
  });
});
