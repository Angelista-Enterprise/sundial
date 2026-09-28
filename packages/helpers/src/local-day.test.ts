import { describe, it, expect } from 'vitest';
import { hostTimeZone, localDate, localDayRange } from './local-day.js';

describe('localDate', () => {
  /**
   * The defect this exists to fix: 01:00 local on the 30th in Amsterdam is
   * 23:00 UTC on the 29th, and `ts.slice(0, 10)` filed it under the 29th.
   */
  it('files late-night local activity under the local date, not the UTC one', () => {
    expect(localDate('2026-07-29T23:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-07-30');
    expect('2026-07-29T23:00:00.000Z'.slice(0, 10)).toBe('2026-07-29');
  });

  it('agrees with UTC in the middle of the day', () => {
    expect(localDate('2026-07-29T12:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-07-29');
  });

  it('handles a zone behind UTC, where the shift runs the other way', () => {
    // 02:00 UTC on the 30th is still the evening of the 29th in New York.
    expect(localDate('2026-07-30T02:00:00.000Z', 'America/New_York')).toBe('2026-07-29');
  });

  it('is the identity for UTC', () => {
    expect(localDate('2026-07-29T23:00:00.000Z', 'UTC')).toBe('2026-07-29');
  });

  it('degrades to the UTC date on an unusable zone rather than throwing', () => {
    expect(localDate('2026-07-29T23:00:00.000Z', 'Not/AZone')).toBe('2026-07-29');
  });
});

describe('localDayRange', () => {
  it('spans a summer day in Amsterdam as 22:00Z to 22:00Z (UTC+2)', () => {
    const { start, end } = localDayRange('2026-07-29', 'Europe/Amsterdam');
    expect(start).toBe('2026-07-28T22:00:00.000Z');
    expect(end).toBe('2026-07-29T22:00:00.000Z');
  });

  it('spans a winter day as 23:00Z to 23:00Z (UTC+1)', () => {
    const { start, end } = localDayRange('2026-01-15', 'Europe/Amsterdam');
    expect(start).toBe('2026-01-14T23:00:00.000Z');
    expect(end).toBe('2026-01-15T23:00:00.000Z');
  });

  it('is exactly 24h on an ordinary day', () => {
    const { start, end } = localDayRange('2026-07-29', 'Europe/Amsterdam');
    expect(Date.parse(end) - Date.parse(start)).toBe(24 * 60 * 60 * 1000);
  });

  /**
   * The reason the conversion takes two passes. On a spring-forward day the local
   * day is 23 hours long; a single-pass conversion using the offset at naive
   * midnight lands an hour out and would silently drop an hour of the record.
   */
  it('is 23h on the spring-forward day', () => {
    const { start, end } = localDayRange('2026-03-29', 'Europe/Amsterdam');
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 60 * 60 * 1000);
  });

  it('is 25h on the autumn fall-back day', () => {
    const { start, end } = localDayRange('2026-10-25', 'Europe/Amsterdam');
    expect(Date.parse(end) - Date.parse(start)).toBe(25 * 60 * 60 * 1000);
  });

  it('matches the plain UTC window for UTC', () => {
    const { start, end } = localDayRange('2026-07-29', 'UTC');
    expect(start).toBe('2026-07-29T00:00:00.000Z');
    expect(end).toBe('2026-07-30T00:00:00.000Z');
  });

  it('round-trips: every instant in the range reports the same local date', () => {
    const date = '2026-07-29';
    const { start, end } = localDayRange(date, 'Europe/Amsterdam');
    expect(localDate(start, 'Europe/Amsterdam')).toBe(date);
    expect(localDate(new Date(Date.parse(end) - 1).toISOString(), 'Europe/Amsterdam')).toBe(date);
    // And the instant at `end` belongs to the NEXT day — the range is half-open.
    expect(localDate(end, 'Europe/Amsterdam')).toBe('2026-07-30');
  });
});

describe('hostTimeZone', () => {
  it('returns a usable IANA zone', () => {
    expect(localDate('2026-07-29T12:00:00.000Z', hostTimeZone())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
