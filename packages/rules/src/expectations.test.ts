import type { Recurrence } from '@sundial/kernel/types.js';
import { describe, expect, it } from 'vitest';
import { FULL_EVIDENCE_OCCURRENCES, absenceSurprise, dayEndDriftPerDay, intervalSd, localMinutes, medianDayEndMinutes, precisionOf, recordDayEnd, recordOccurrence } from './expectations.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Feed a series of gaps (in minutes) through `recordOccurrence` and return the result. */
function withGaps(gapsMin: number[], start = Date.parse('2026-03-01T09:00:00.000Z')): Recurrence {
  let map = recordOccurrence({}, 'break|any', 'break', 'any', new Date(start).toISOString(), null);
  let cursor = start;
  for (const gap of gapsMin) {
    cursor += gap * MIN;
    map = recordOccurrence(map, 'break|any', 'break', 'any', new Date(cursor).toISOString(), null);
  }
  return map['break|any']!;
}

describe('recordOccurrence', () => {
  it('opens a recurrence with no interval knowledge and armed', () => {
    const r = withGaps([]);
    expect(r.intervalMs.n).toBe(0);
    expect(r.armed).toBe(true);
    expect(intervalSd(r)).toBe(Number.POSITIVE_INFINITY);
  });

  it('learns a mean gap', () => {
    const r = withGaps([90, 90, 90]);
    expect(r.intervalMs.n).toBe(3);
    expect(r.intervalMs.mean).toBeCloseTo(90 * MIN, 5);
  });

  it('learns spread through Welford without storing samples', () => {
    const r = withGaps([60, 120, 60, 120]);
    expect(r.intervalMs.mean).toBeCloseTo(90 * MIN, 5);
    // Sample sd of [60,120,60,120] minutes is ~34.64 min.
    expect(intervalSd(r) / MIN).toBeCloseTo(34.641, 2);
  });

  it('re-arms on every occurrence, which is what makes the absence check edge-triggered', () => {
    let map = recordOccurrence({}, 'break|any', 'break', 'any', '2026-03-01T09:00:00.000Z', null);
    map = { 'break|any': { ...map['break|any']!, armed: false } };
    map = recordOccurrence(map, 'break|any', 'break', 'any', '2026-03-01T10:30:00.000Z', null);
    expect(map['break|any']!.armed).toBe(true);
  });

  it('refuses to teach the interval a zero when replay hands it two events at one instant', () => {
    // A zero gap would collapse the mean toward nothing and make every later absence
    // look enormous — the failure mode a log repair can inject.
    let map = recordOccurrence({}, 'break|any', 'break', 'any', '2026-03-01T09:00:00.000Z', null);
    map = recordOccurrence(map, 'break|any', 'break', 'any', '2026-03-01T10:00:00.000Z', null);
    const before = map['break|any']!.intervalMs;
    map = recordOccurrence(map, 'break|any', 'break', 'any', '2026-03-01T10:00:00.000Z', null);
    expect(map['break|any']!.intervalMs).toEqual(before);
    expect(map['break|any']!.armed).toBe(true);
  });

  it('does not move the interval backwards on an out-of-order timestamp', () => {
    let map = recordOccurrence({}, 'break|any', 'break', 'any', '2026-03-01T12:00:00.000Z', null);
    map = recordOccurrence(map, 'break|any', 'break', 'any', '2026-03-01T09:00:00.000Z', null);
    expect(map['break|any']!.intervalMs.n).toBe(0);
  });
});

describe('recordOccurrence — what is not an interval', () => {
  const key = 'break|any';
  const record = (map: Record<string, Recurrence>, ts: string, maxGap = 12 * HOUR, minSession = 0): Record<string, Recurrence> => recordOccurrence(map, key, 'break', 'any', ts, null, maxGap, minSession);

  it('does not learn a gap beyond the stream horizon', () => {
    // An overnight gap in a break rhythm. Folding these in is what taught the stream a
    // 5.5-hour rhythm from one that is really every 75 minutes, which then made a
    // genuine six-hour stretch look perfectly normal.
    let map = record({}, '2026-03-10T09:00:00.000Z');
    map = record(map, '2026-03-10T10:30:00.000Z');
    const afterOneRealGap = map[key]!.intervalMs;

    map = record(map, '2026-03-11T09:00:00.000Z');
    expect(map[key]!.intervalMs).toEqual(afterOneRealGap);
    // The cursor still moves and the check re-arms — only the mean is protected.
    expect(map[key]!.lastSeenAt).toBe('2026-03-11T09:00:00.000Z');
    expect(map[key]!.armed).toBe(true);
  });

  it('treats occurrences inside a session as one occurrence', () => {
    // A leisure block emits a window change every few minutes; counting them raw measures
    // the gap between leisure WINDOWS instead of leisure SESSIONS.
    let map = record({}, '2026-03-10T20:00:00.000Z', 14 * 24 * HOUR, 3 * HOUR);
    map = record(map, '2026-03-10T20:04:00.000Z', 14 * 24 * HOUR, 3 * HOUR);
    map = record(map, '2026-03-10T20:09:00.000Z', 14 * 24 * HOUR, 3 * HOUR);
    expect(map[key]!.intervalMs.n).toBe(0);

    // The next evening is a genuinely new session.
    map = record(map, '2026-03-11T20:30:00.000Z', 14 * 24 * HOUR, 3 * HOUR);
    expect(map[key]!.intervalMs.n).toBe(1);
  });

  it('clears disarmedOn when the occurrence happens', () => {
    let map = record({}, '2026-03-10T09:00:00.000Z');
    map = { [key]: { ...map[key]!, armed: false, disarmedOn: '2026-03-10' } };
    map = record(map, '2026-03-10T10:30:00.000Z');
    expect(map[key]!.armed).toBe(true);
    expect(map[key]!.disarmedOn).toBeNull();
  });
});

describe('drift is measured over a trailing window', () => {
  it('sees a recent drift the full series would dilute away', () => {
    // The measured failure: a real 22 min/day drift over ten days averaged to 9.7 across a
    // 21-day history, under the 12-minute floor, so the detector stayed silent on exactly
    // what it was built for. Drift is by definition recent.
    const flat = Array.from({ length: 11 }, (_, i) => ({ day: `f${i}`, minutes: 18 * 60 }));
    const rising = Array.from({ length: 10 }, (_, i) => ({ day: `r${i}`, minutes: 18 * 60 + i * 22 }));
    const series = [...flat, ...rising];

    expect(dayEndDriftPerDay(series)).toBeGreaterThan(12);
    // The whole series, if it were used, would not clear the floor.
    const wholeSeriesSlope = (() => {
      const n = series.length;
      const meanX = (n - 1) / 2;
      const meanY = series.reduce((s, v) => s + v.minutes, 0) / n;
      let num = 0;
      let den = 0;
      for (let i = 0; i < n; i += 1) {
        num += (i - meanX) * (series[i]!.minutes - meanY);
        den += (i - meanX) ** 2;
      }
      return num / den;
    })();
    expect(wholeSeriesSlope).toBeLessThan(dayEndDriftPerDay(series));
  });
});

describe('precisionOf', () => {
  const solid = withGaps(Array.from({ length: FULL_EVIDENCE_OCCURRENCES }, () => 90));

  it('is 0 without enough samples to have a spread at all', () => {
    expect(precisionOf(withGaps([]), 1)).toBe(0);
  });

  it('rewards a tight interval seen often', () => {
    expect(precisionOf(solid, 1)).toBeGreaterThan(0.9);
  });

  it('discounts a ragged interval', () => {
    const ragged = withGaps([10, 300, 20, 400, 15, 250, 30, 500]);
    expect(precisionOf(ragged, 1)).toBeLessThan(precisionOf(solid, 1));
  });

  it('discounts thin evidence — the term that retires the deleted insights', () => {
    const thin = withGaps([90, 90]);
    // Two samples earns at most 2/20 of the evidence term, whatever the sharpness.
    expect(precisionOf(thin, 1)).toBeLessThanOrEqual(0.1);
  });

  it('scales with coverage, and collapses to 0 when nothing was observed', () => {
    expect(precisionOf(solid, 0.5)).toBeCloseTo(precisionOf(solid, 1) * 0.5, 5);
    expect(precisionOf(solid, 0)).toBe(0);
  });

  it('clamps a coverage outside 0..1', () => {
    expect(precisionOf(solid, 5)).toBe(precisionOf(solid, 1));
    expect(precisionOf(solid, -1)).toBe(0);
  });
});

describe('absenceSurprise', () => {
  it('is 0 at or under the usual gap', () => {
    expect(absenceSurprise(60 * MIN, 90 * MIN)).toBe(0);
    expect(absenceSurprise(90 * MIN, 90 * MIN)).toBe(0);
  });

  it('grows linearly in multiples of the usual gap', () => {
    expect(absenceSurprise(180 * MIN, 90 * MIN)).toBeCloseTo(1, 5);
    expect(absenceSurprise(270 * MIN, 90 * MIN)).toBeCloseTo(2, 5);
  });

  it('stays finite and interpretable at ten times the interval', () => {
    // A Gaussian tail would report hundreds of nats here and let one stale recurrence
    // dominate every ranking in the system.
    expect(absenceSurprise(900 * MIN, 90 * MIN)).toBeCloseTo(9, 5);
  });
});

describe('day-end phase series', () => {
  // K0.6b — minutes count from 04:00, so 18:30 is minute 870 of the waking day.
  const wm = (h: number, m = 0) => (h - 4) * 60 + m;

  it('keeps the latest activity per waking day', () => {
    let s = recordDayEnd([], '2026-03-10T09:00:00.000Z', 'UTC');
    s = recordDayEnd(s, '2026-03-10T18:30:00.000Z', 'UTC');
    s = recordDayEnd(s, '2026-03-10T17:00:00.000Z', 'UTC');
    expect(s).toEqual([{ day: '2026-03-10', minutes: wm(18, 30), basis: 'waking' }]);
  });

  it('keeps a night that runs past midnight on the evening it belongs to', () => {
    // The whole item. On the calendar day this recorded 23:50 for the 10th and
    // opened a NEW day at 00:00 — so the six `day-end-drift` notices Gnomon has
    // ever sent all report a stop between 23:23 and 23:59, over a record with
    // ten nights that ran past midnight, the latest to 03:08.
    let s = recordDayEnd([], '2026-03-10T23:50:00.000Z', 'UTC');
    s = recordDayEnd(s, '2026-03-11T02:00:00.000Z', 'UTC');
    expect(s).toHaveLength(1);
    expect(s[0]!.day).toBe('2026-03-10');
    expect(s[0]!.minutes, '02:00 is minute 1320 of a day that began at 04:00').toBe(wm(26));
  });

  it('drops samples recorded against the old midnight zero rather than converting them', () => {
    // The two zeros differ by 240 minutes, so a mixed series shows a four-hour
    // step that `dayEndDriftPerDay` would read as an enormous drift and
    // announce. Converting is not available: the offset is only constant for a
    // stop before midnight, and guessing which side an old sample fell on is
    // the invention this change removes. The window is 21 days; it refills.
    const legacy = [{ day: '2026-03-09', minutes: 1380 }];
    const s = recordDayEnd(legacy, '2026-03-10T18:00:00.000Z', 'UTC');
    expect(s).toEqual([{ day: '2026-03-10', minutes: wm(18), basis: 'waking' }]);
  });

  it('returns the identical array when the minute has not advanced', () => {
    // `expectationLearn` runs this on every `input:activity` (~360/hour), and relies on
    // reference equality to avoid allocating a fresh state object each time.
    const s = recordDayEnd([], '2026-03-10T09:00:00.000Z', 'UTC');
    expect(recordDayEnd(s, '2026-03-10T08:59:00.000Z', 'UTC')).toBe(s);
  });

  it('starts a new entry on a new local day', () => {
    let s = recordDayEnd([], '2026-03-10T18:00:00.000Z', 'UTC');
    s = recordDayEnd(s, '2026-03-11T10:00:00.000Z', 'UTC');
    expect(s.map((e) => e.day)).toEqual(['2026-03-10', '2026-03-11']);
  });

  it('bounds the series', () => {
    let s: { day: string; minutes: number; basis?: string }[] = [];
    for (let d = 1; d <= 30; d += 1) s = recordDayEnd(s, `2026-03-${String(d).padStart(2, '0')}T18:00:00.000Z`, 'UTC');
    expect(s).toHaveLength(21);
    expect(s[0]!.day).toBe('2026-03-10');
  });

  it('measures the median rather than the mean, so one all-nighter cannot move normal', () => {
    const week = [18 * 60, 18 * 60 + 15, 17 * 60 + 45, 18 * 60 + 30, 2 * 60 + 40, 18 * 60, 18 * 60 + 10].map((minutes, i) => ({ day: `d${i}`, minutes }));
    expect(medianDayEndMinutes(week)).toBe(18 * 60);
  });

  it('finds a real slope and ignores a flat series', () => {
    const drifting = Array.from({ length: 9 }, (_, i) => ({ day: `d${i}`, minutes: 18 * 60 + i * 20 }));
    expect(dayEndDriftPerDay(drifting)).toBeCloseTo(20, 5);

    const flat = Array.from({ length: 9 }, (_, i) => ({ day: `d${i}`, minutes: 18 * 60 }));
    expect(dayEndDriftPerDay(flat)).toBe(0);
  });

  it('reports a negative slope when days end earlier', () => {
    const earlier = Array.from({ length: 8 }, (_, i) => ({ day: `d${i}`, minutes: 22 * 60 - i * 15 }));
    expect(dayEndDriftPerDay(earlier)).toBeCloseTo(-15, 5);
  });

  it('reads local minutes in the owner zone', () => {
    expect(localMinutes('2026-03-10T23:30:00.000Z', 'UTC')).toBe(23 * 60 + 30);
    expect(localMinutes('2026-03-10T23:30:00.000Z', 'Europe/Amsterdam')).toBe(30);
  });
});

describe('interval drift', () => {
  it('picks up a stretching gap', () => {
    const r = withGaps([60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160]);
    expect(r.driftSamples).toBe(11);
    expect(r.driftPerDayMs).toBeGreaterThan(0);
  });

  it('stays near zero on a stable interval', () => {
    const r = withGaps(Array.from({ length: 12 }, () => 90));
    expect(Math.abs(r.driftPerDayMs)).toBeLessThan(2 * MIN);
  });

  it('does not report drift before there is a mean to compare against', () => {
    expect(withGaps([90]).driftPerDayMs).toBe(0);
  });
});

describe('a full absence scenario, end to end on the helpers', () => {
  it('a break stream that has been steady for two weeks and then stops', () => {
    // ~90 minutes between breaks, twenty times.
    const r = withGaps(Array.from({ length: 20 }, () => 90));
    const gap = 6 * HOUR;
    const overdueSd = (gap - r.intervalMs.mean) / intervalSd(r);

    expect(precisionOf(r, 0.9)).toBeGreaterThan(0.8);
    expect(absenceSurprise(gap, r.intervalMs.mean)).toBeCloseTo(3, 1);
    // A perfectly regular interval has near-zero spread, so any real overrun is many
    // standard deviations out — the floor exists for ragged streams, not this one.
    expect(overdueSd).toBeGreaterThan(2.5);
  });
});
