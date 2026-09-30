import { describe, expect, it } from 'vitest';
import { createInitialState } from './initial-state.js';
import { dayLabel, meetingPrepKey, othersIn, peopleText, todayBrief, visibleBrief, visibleWeek, weekReviewDue } from './briefs.js';

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

describe('visibleBrief: the brief Today shows, keyed as brief-clock raised it', () => {
  const at = Date.parse('2026-03-04T08:55:00Z');
  const withLatest = (latest: object, quiet: string[] = []) => {
    const s = createInitialState('d');
    return { ...s, config: { ...s.config, timezone: 'Europe/Amsterdam' }, settings: { ...s.settings, quiet }, briefs: { days: {}, prState: {}, lastMet: {}, done: {}, latest } } as never;
  };
  const standup = { kind: 'standup-draft', title: 'Daily', start: '2026-03-04T09:00:00Z', end: '2026-03-04T09:15:00Z', lines: ['x'], at: '2026-03-04T08:50:00Z' };
  it('carries the notice key until the meeting ends', () => {
    expect(visibleBrief(withLatest(standup), at)?.key).toBe('standup-draft:2026-03-04');
    expect(visibleBrief(withLatest({ ...standup, kind: 'meeting-prep' }), at)?.key).toBe(meetingPrepKey('Daily', standup.start));
    expect(visibleBrief(withLatest(standup), Date.parse(standup.end))).toBeNull();
  });
  it('is none when the owner turned briefs off', () => {
    expect(visibleBrief(withLatest(standup, ['briefs']), at)).toBeNull();
  });
});

describe('visibleWeek: this week, while it is due', () => {
  const s0 = createInitialState('d');
  const s = { ...s0, config: { ...s0.config, timezone: 'Europe/Amsterdam' }, briefs: { days: {}, prState: {}, lastMet: {}, done: {}, week: { from: '2026-09-28', to: '2026-10-02', lines: ['x'], at: '2026-10-02T11:30:00Z' } } } as never;
  it('shows on Friday afternoon and the weekend of its own week only', () => {
    expect(visibleWeek(s, Date.parse('2026-10-02T11:40:00Z'))?.from).toBe('2026-09-28');
    expect(visibleWeek(s, Date.parse('2026-10-04T18:00:00Z'))?.from).toBe('2026-09-28');
    expect(visibleWeek(s, Date.parse('2026-10-02T10:00:00Z'))).toBeNull();
    expect(visibleWeek(s, Date.parse('2026-10-09T12:00:00Z'))).toBeNull();
  });
});

describe('todayBrief: the brief card, as /gnomon/brief answers it', () => {
  it('is empty before the kernel boots', () => {
    expect(todayBrief(null, 0)).toEqual({ before: null, week: null });
  });
});
