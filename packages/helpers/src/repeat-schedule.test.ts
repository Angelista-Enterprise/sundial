import { describe, it, expect } from 'vitest';
import { lastOccurrence, nextOccurrence, parseRepeat } from './repeat-schedule.js';

describe('parseRepeat', () => {
  it.each([
    ['every monday at 9am', { days: [1], hour: 9, minute: 0 }],
    ['weekdays at 17:30', { days: [1, 2, 3, 4, 5], hour: 17, minute: 30 }],
    ['daily at 8', { days: [0, 1, 2, 3, 4, 5, 6], hour: 8, minute: 0 }],
    ['every day at 12am', { days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0 }],
    ['every tuesday and thursday at 2pm', { days: [2, 4], hour: 14, minute: 0 }],
    ['on fridays', { days: [5], hour: 9, minute: 0 }],
    ['weekends at 10.15', { days: [0, 6], hour: 10, minute: 15 }],
  ])('reads %j', (text, expected) => {
    expect(parseRepeat(text)).toEqual(expected);
  });

  it.each(['every 2 hours', 'monthly', 'every funday at 9', 'daily at 25:00', ''])('refuses %j', (text) => {
    expect(parseRepeat(text)).toBeNull();
  });
});

describe('occurrences, in the owner zone', () => {
  const monday9 = parseRepeat('every monday at 9am')!;
  // 2026-09-28 is a Monday; Amsterdam is UTC+2 in September.
  it('the last one is the latest at or before now', () => {
    expect(lastOccurrence(monday9, '2026-09-28T07:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-09-28T07:00:00.000Z');
    expect(lastOccurrence(monday9, '2026-09-28T06:59:00.000Z', 'Europe/Amsterdam')).toBe('2026-09-21T07:00:00.000Z');
  });

  it('the next one is after now', () => {
    expect(nextOccurrence(monday9, '2026-09-26T10:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-09-28T07:00:00.000Z');
  });

  it('follows the clock across a DST change', () => {
    // 2026-10-25 Amsterdam goes back to UTC+1; the Monday after, 9am is 08:00Z.
    expect(nextOccurrence(monday9, '2026-10-26T00:00:00.000Z', 'Europe/Amsterdam')).toBe('2026-10-26T08:00:00.000Z');
  });
});
