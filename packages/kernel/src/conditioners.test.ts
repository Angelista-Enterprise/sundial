import { describe, it, expect } from 'vitest';
import { CONDITIONERS, conditionerById, weekdayOf, armEntropy, informationGain, splitAccepted, MIN_ARM_N, type TrialSplit } from './conditioners.js';

const split = (when: [number, number], otherwise: [number, number], unknown = 0): TrialSplit => ({
  when: { n: when[0], hits: when[1] },
  otherwise: { n: otherwise[0], hits: otherwise[1] },
  unknown,
});

describe('weekdayOf', () => {
  it('is timezone-free — a date names the same weekday everywhere', () => {
    // 2026-08-16 is a Sunday; parsing via local Date would shift it in UTC-negative zones.
    expect(weekdayOf('2026-08-16')).toBe(0);
    expect(weekdayOf('2026-08-15')).toBe(6);
    expect(weekdayOf('2026-08-14')).toBe(5);
  });
});

describe('the conditioner menu', () => {
  it('weekend holds on Saturday and Sunday only', () => {
    const weekend = conditionerById('weekend');
    expect(weekend?.evaluate({ date: '2026-08-15', prevDayEndHour: null })).toBe(true);
    expect(weekend?.evaluate({ date: '2026-08-16', prevDayEndHour: null })).toBe(true);
    expect(weekend?.evaluate({ date: '2026-08-17', prevDayEndHour: null })).toBe(false);
  });

  it('prev-day-ran-late needs the previous day to be KNOWN — unknown is null, never an arm', () => {
    const late = conditionerById('prev-day-ran-late');
    expect(late?.evaluate({ date: '2026-08-16', prevDayEndHour: 23 })).toBe(true);
    expect(late?.evaluate({ date: '2026-08-16', prevDayEndHour: 22 })).toBe(true);
    expect(late?.evaluate({ date: '2026-08-16', prevDayEndHour: 18 })).toBe(false);
    // Absence of evidence must not masquerade as a pattern.
    expect(late?.evaluate({ date: '2026-08-16', prevDayEndHour: null })).toBeNull();
  });

  it('every conditioner id resolves through the registry lookup', () => {
    for (const conditioner of CONDITIONERS) {
      expect(conditionerById(conditioner.id)).toBe(conditioner);
    }
    expect(conditionerById('vibes')).toBeNull();
  });
});

describe('informationGain', () => {
  it('is zero when the arms have the same rate — a split that explains nothing', () => {
    expect(informationGain(split([10, 5], [10, 5]))).toBeCloseTo(0, 10);
  });

  it('CANNOT be produced by denominator growth — the failure the goal criterion was rebuilt to exclude', () => {
    // Same rates, ten times the samples: still zero. Gain requires the arms to differ.
    expect(informationGain(split([100, 50], [100, 50]))).toBeCloseTo(0, 10);
  });

  it('is the full pooled entropy when the split separates the outcomes perfectly', () => {
    const perfect = split([6, 6], [7, 0]);
    const pooled = armEntropy({ n: 13, hits: 6 });
    expect(informationGain(perfect)).toBeCloseTo(pooled, 10);
    expect(pooled).toBeGreaterThan(0.6); // near a coin flip — worth ~0.69 nats
  });
});

describe('splitAccepted — the MDL bar', () => {
  it('accepts the pattern the 06:00 goal exists for: endings explained by late nights', () => {
    // 13 samples: after late nights the day "ends" at 06:00 4/5 times; otherwise 0/8.
    const real = split([5, 4], [8, 0]);
    expect(splitAccepted(real)).toBe(true);
  });

  it('rejects a coincidental split at the same sample size', () => {
    // 7/6 arms with rates 0.43 vs 0.33 — the kind of wobble n=13 produces for free.
    expect(splitAccepted(split([7, 3], [6, 2]))).toBe(false);
  });

  it('refuses to judge before both arms have evidence, whatever the gain', () => {
    // Perfect separation, but one arm is thinner than MIN_ARM_N.
    const thin = split([MIN_ARM_N - 1, MIN_ARM_N - 1], [10, 0]);
    expect(splitAccepted(thin)).toBe(false);
  });

  it('scales honestly: the same weak effect that fails at n=13 can earn acceptance with enough samples', () => {
    const weakSmall = split([7, 4], [6, 1]);
    const weakLarge = split([70, 40], [60, 10]);
    expect(splitAccepted(weakSmall)).toBe(false);
    expect(splitAccepted(weakLarge)).toBe(true);
  });
});
