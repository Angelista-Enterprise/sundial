import { describe, expect, it } from 'vitest';
import { createInitialState } from './initial-state.js';
import { dayLabel, othersIn, peopleText, weekReviewDue } from './briefs.js';

describe('briefs: people and days as the owner reads them', () => {
  it('never puts a hash or a room to the owner, and leaves the owner out', () => {
    const s = createInitialState('d');
    s.config.ownerAliases = ['pat'];
    s.memory.aliasNames = { 'person-0123456789': 'Bob Jansen' };
    const others = othersIn(s, ['Pat', 'Mira Bakker', 'person-0123456789', 'person-abcdefabcd', 'Floor-2 Library (12)']);
    expect(others).toEqual(['Mira Bakker', 'person-0123456789', 'person-abcdefabcd']);
    expect(peopleText(s, others)).toBe('Mira Bakker, Bob Jansen and 1 other');
    expect(peopleText(s, ['person-abcdefabcd'])).toBe('1 other');
  });

  it('names a day the way it is said, and puts the week on Today from Friday afternoon', () => {
    expect(dayLabel('2026-09-29', '2026-09-30')).toBe('Yesterday');
    expect(dayLabel('2026-09-25', '2026-09-28')).toBe('Friday');
    expect(dayLabel('2026-09-10', '2026-09-28')).toBe('2026-09-10');
    expect(weekReviewDue('2026-10-02T10:00:00.000Z', 'Europe/Amsterdam'), 'Friday 12:00').toBe(false);
    expect(weekReviewDue('2026-10-02T11:30:00.000Z', 'Europe/Amsterdam'), 'Friday 13:30').toBe(true);
    expect(weekReviewDue('2026-10-04T10:00:00.000Z', 'Europe/Amsterdam'), 'Sunday').toBe(true);
    expect(weekReviewDue('2026-10-05T10:00:00.000Z', 'Europe/Amsterdam'), 'Monday').toBe(false);
  });
});
