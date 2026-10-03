// The model reads tool times on the owner's clock: a due time in UTC was read as the local hour.
import { describe, it, expect } from 'vitest';
import { localIso, withLocalTimes } from './render.js';

describe('localIso', () => {
  it('writes a UTC instant as the wall clock with its offset, summer and winter', () => {
    expect(localIso('2026-09-30T19:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-09-30T21:00:00+02:00');
    expect(localIso('2026-12-01T23:30:00Z', 'Europe/Amsterdam')).toBe('2026-12-02T00:30:00+01:00');
    expect(localIso('2026-09-30T19:00:00Z', 'America/New_York')).toBe('2026-09-30T15:00:00-04:00');
    expect(localIso('2026-09-30T19:00:00Z', 'UTC')).toBe('2026-09-30T19:00:00+00:00');
  });
  it('keeps the instant: the local string parses back to the same time', () => {
    const ts = '2026-03-29T01:30:00.000Z'; // the night Amsterdam moves its clocks
    expect(Date.parse(localIso(ts, 'Europe/Amsterdam'))).toBe(Date.parse(ts));
  });
});

describe('withLocalTimes', () => {
  it('rewrites timestamps at any depth and leaves everything else as it was', () => {
    const value = { due: '2026-09-30T19:00:00.000Z', date: '2026-09-30', rows: [{ at: '2026-09-30T07:15:00Z', text: 'at 2026-09-30T07:15:00Z' }], n: 3, none: null };
    expect(withLocalTimes(value, 'Europe/Amsterdam')).toEqual({ due: '2026-09-30T21:00:00+02:00', date: '2026-09-30', rows: [{ at: '2026-09-30T09:15:00+02:00', text: 'at 2026-09-30T07:15:00Z' }], n: 3, none: null });
  });
});
