import { describe, expect, it } from 'vitest';
import { addDays, driftSentence, EMPTY_DRIFT_DAY, heldTrends, mondayOf, wakingClock, weekdayOf, weeklyDrift, type DriftDay } from './drift.js';

/** A working day: an hour of input (360 windows), ending at `last` (waking minutes; 840 = 18:00). */
const day = (last: number, extra: Partial<DriftDay> = {}): DriftDay => ({ ...EMPTY_DRIFT_DAY, first: 300, last, active: 360, switches: 20, ...extra });

/** Seven days from a Monday, weekdays ending at `last`. */
function week(monday: string, last: number, extra: Partial<DriftDay> = {}): Record<string, DriftDay> {
  return Object.fromEntries(Array.from({ length: 7 }, (_, i) => [addDays(monday, i), day(last, extra)]));
}

describe('the calendar helpers', () => {
  it('finds the Monday, steps days and reads the weekday', () => {
    expect(mondayOf('2026-11-16')).toBe('2026-11-16');
    expect(mondayOf('2026-11-22')).toBe('2026-11-16');
    expect(addDays('2026-11-16', -7)).toBe('2026-11-09');
    expect(weekdayOf('2026-11-22')).toBe(0);
  });

  it('reads a waking minute as the wall clock, past midnight too', () => {
    expect(wakingClock(0)).toBe('04:00');
    expect(wakingClock(840)).toBe('18:00');
    expect(wakingClock(1260)).toBe('01:00');
  });
});

describe('weeklyDrift', () => {
  it('turns a full week into every metric with its n', () => {
    const days = week('2026-11-02', 840, { meetingMin: 30, late: 1 });
    const [w] = weeklyDrift(days);
    expect(w).toEqual({ week: '2026-11-02', present: 7, activeDays: 7, activeMin: 420, dayEnd: 840, dayEndN: 5, weekendMin: 120, meetingMin: 210, switchesPerDay: 20, lateCommits: 7 });
  });

  it('says nothing from a thin week: two days give no median and no totals', () => {
    const [w] = weeklyDrift({ '2026-11-16': day(840), '2026-11-17': day(900) });
    expect(w).toMatchObject({ present: 2, activeDays: 2, activeMin: 120, dayEnd: null, dayEndN: 2, weekendMin: null, meetingMin: null, switchesPerDay: null, lateCommits: null });
  });

  it('does not count a glance at the machine as a working day', () => {
    const days = { ...week('2026-11-02', 840), '2026-11-04': day(1200, { active: 30 }) };
    const [w] = weeklyDrift(days);
    expect(w!.activeDays).toBe(6);
    expect(w!.dayEnd).toBe(840);
  });
});

describe('heldTrends', () => {
  // Baseline weeks 2026-09-28 to 10-19 end at 18:00; the three before 11-16 end at 19:00.
  const days = {
    ...week('2026-09-28', 840),
    ...week('2026-10-05', 840),
    ...week('2026-10-12', 840),
    ...week('2026-10-19', 840),
    ...week('2026-10-26', 900),
    ...week('2026-11-02', 900),
    ...week('2026-11-09', 900),
  };

  it('raises a change that held three weeks beyond the baseline, and only that one', () => {
    const trends = heldTrends(weeklyDrift(days), '2026-11-16');
    expect(trends).toEqual([{ metric: 'dayEnd', direction: 'up', held: [{ week: '2026-10-26', value: 900 }, { week: '2026-11-02', value: 900 }, { week: '2026-11-09', value: 900 }], baseline: 840, baselineWeeks: 4 }]);
    expect(driftSentence(trends[0]!)).toBe('Your working day has ended later for 3 weeks in a row: 19:00, 19:00, 19:00, against 18:00 in the 4 weeks before.');
  });

  it('a change under the threshold, or one week back to normal, is no trend', () => {
    expect(heldTrends(weeklyDrift({ ...days, ...week('2026-11-02', 860) }), '2026-11-16')).toEqual([]);
    expect(heldTrends(weeklyDrift({ ...days, ...week('2026-11-02', 840) }), '2026-11-16')).toEqual([]);
  });

  it('needs three baseline weeks with a value', () => {
    const thin = Object.fromEntries(Object.entries(days).filter(([d]) => d >= '2026-10-12'));
    expect(heldTrends(weeklyDrift(thin), '2026-11-16')).toEqual([]);
  });
});
