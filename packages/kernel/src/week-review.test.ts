import { describe, expect, it } from 'vitest';
import type { StoredCommitment } from '@sundial/db/index.js';
import { createInitialState } from './initial-state.js';
import { composeWeekReview, weekDates, type WeekInput } from './week-review.js';

// Friday 2 October 2026, 15:00 in Amsterdam.
const NOW = '2026-10-02T13:00:00.000Z';
const row = (eventType: string, capturedAt: string, data: Record<string, unknown>) => ({ eventType, capturedAt, data });
const promise = (id: string, closedAt: string | null, closedBecause: string | null, extra: Record<string, unknown> = {}): StoredCommitment =>
  ({ id, name: id, source: 'meeting', branch: '', projectId: null, projectName: null, openedAt: '2026-09-28T08:00:00.000Z', lastTouchedAt: '2026-09-28T08:00:00.000Z', touches: 1, activeDays: 1, closedAt, closedBecause, promise: { counterparty: 'Mira Bakker', due: '2026-10-01T15:00:00.000Z', ...extra } }) as StoredCommitment;

function input(overrides: Partial<WeekInput> = {}): WeekInput {
  return {
    days: [
      { date: '2026-09-28', projects: [{ name: 'puzzlebox-studio', minutes: 240, commits: 5 }, { name: 'sundial', minutes: 60, commits: 12 }], noProjectMin: 45 },
      { date: '2026-09-29', projects: [{ name: 'puzzlebox-studio', minutes: 180, commits: 3 }], noProjectMin: 10 },
    ],
    prs: [
      row('pr-status', '2026-09-20T10:00:00.000Z', { cwd: '/x/puzzlebox-studio', number: 12, title: 'Hint borders', state: 'OPEN' }),
      row('pr-status', '2026-09-29T10:00:00.000Z', { cwd: '/x/puzzlebox-studio', number: 12, title: 'Hint borders', state: 'MERGED' }),
      row('pr-status', '2026-09-29T11:00:00.000Z', { cwd: '/x/puzzlebox-studio', number: 9, title: 'Old work', state: 'MERGED' }),
    ],
    mail: [
      row('received', '2026-09-29T09:00:00.000Z', { from: 'Mira Bakker', subject: 'Border colours', timestamp: '2026-09-29T09:00:00.000Z' }),
      row('received', '2026-09-30T09:00:00.000Z', { from: 'Bob Jansen', subject: 'Lunch?', timestamp: '2026-09-30T09:00:00.000Z' }),
      row('received', '2026-09-30T10:00:00.000Z', { from: 'Newsletter', subject: 'This week', timestamp: '2026-09-30T10:00:00.000Z' }),
      row('sent', '2026-09-30T12:00:00.000Z', { subject: 'Re: Lunch?', recipients: [{ to: 'Bob Jansen' }], timestamp: '2026-09-30T12:00:00.000Z' }),
    ],
    calendar: [row('active', '2026-09-28T07:00:00.000Z', { event: { title: 'Standup', attendees: ['pat', 'Mira Bakker', 'Bob Jansen'] } })],
    promises: [promise('p1', '2026-09-30T10:00:00.000Z', 'kept'), promise('p2', '2026-10-01T10:00:00.000Z', 'broken'), promise('p3', null, null), promise('p0', '2026-09-20T10:00:00.000Z', 'kept')],
    upcoming: [
      { title: 'Standup', startDate: '2026-10-05T07:00:00.000Z', endDate: '2026-10-05T07:15:00.000Z', attendees: ['pat', 'Mira Bakker'] },
      { title: 'Focus', startDate: '2026-10-05T09:00:00.000Z', endDate: '2026-10-05T11:00:00.000Z', attendees: [] },
      { title: 'This Friday', startDate: '2026-10-02T14:00:00.000Z', endDate: '2026-10-02T15:00:00.000Z', attendees: ['Mira Bakker'] },
    ],
    ...overrides,
  };
}

describe('the week in review (lane B #14)', () => {
  const state = createInitialState('d');
  state.config.timezone = 'Europe/Amsterdam';
  state.config.ownerAliases = ['pat'];

  it('runs Monday to today in the owner’s zone', () => {
    expect(weekDates(NOW, 'Europe/Amsterdam')).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(weekDates('2026-09-27T21:30:00.000Z', 'Europe/Amsterdam'), 'Sunday 23:30 is still the week before').toEqual(['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
  });

  it('says what shipped, where the time went, promises with their n, mail waiting and next week', () => {
    const review = composeWeekReview(input(), state, NOW);
    expect(review.merged, 'a pull request merged long ago is not this week’s').toEqual([{ project: 'puzzlebox-studio', number: 12, title: 'Hint borders' }]);
    expect(review.promises).toEqual({ closed: 2, kept: 1, broken: 1, dropped: 0, quiet: 0, open: 1, late: 1 });
    expect(review.mail.waiting.map((m) => m.who), 'answered mail and strangers are left out; someone a promise is with ranks first').toEqual(['Mira Bakker']);
    expect(review.lines).toEqual([
      'Shipped: 12 commits on sundial, 8 on puzzlebox-studio; PR #12 merged (Hint borders).',
      'Time: puzzlebox-studio 7h, sundial 1h, unattributed 55m.',
      'Promises: kept 1 of 2 closed (not kept 1, dropped 0, gone quiet 0); 1 open, 1 past due.',
      'Waiting on your reply: Mira Bakker “Border colours” (Tue).',
      'Next week: 2 meetings, 1 with others, 2.3h; first Mon 09:00 Standup.',
    ]);
  });

  it('does not guess at replies it cannot see', () => {
    const review = composeWeekReview(input({ mail: input().mail.filter((r) => r.eventType === 'received') }), state, NOW);
    expect(review.mail).toMatchObject({ sentVisible: false, waiting: [], fromPeople: 2 });
    expect(review.lines[3]).toBe('Mail: 2 from people you meet; sent mail is not on the record yet, so a reply cannot be matched.');
  });
});
