import { describe, expect, it } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { Effect, KernelState, SanitizedEvent, UpcomingEvent } from '@sundial/kernel/types.js';
import { briefClock } from './brief-clock.js';

let seq = 0;
const ev = (type: string, ts: string, payload: Record<string, unknown> = {}): SanitizedEvent => ({ id: `b${++seq}`, type, ts, payload: { timestamp: ts, ...payload }, sanitized: true });
const noticesOf = (effects: Effect[]) => effects.filter((e) => e.type === 'EmitEvent' && e.event.type === 'notice:candidate').map((e) => (e as { event: { payload: Record<string, unknown> } }).event.payload);
const fold = (state: KernelState, events: SanitizedEvent[]) => events.reduce((s, e) => briefClock(s, e).state, state);

// Wednesday 30 Sep 2026, Amsterdam (UTC+2). The standup is at 09:00 local = 07:00Z.
const STANDUP: UpcomingEvent = { title: 'Standup', start: '2026-09-30T07:00:00.000Z', end: '2026-09-30T07:15:00.000Z', attendees: ['pat', 'Mira Bakker', 'Bob Jansen', 'Floor-2 Library (12)'], isAllDay: false, recurring: true };
const REVIEW: UpcomingEvent = { title: 'BOX-484 review', start: '2026-09-30T12:00:00.000Z', end: '2026-09-30T12:45:00.000Z', attendees: ['pat', 'Mira Bakker'], isAllDay: false };

function base(): KernelState {
  const s = createInitialState('d');
  s.config.timezone = 'Europe/Amsterdam';
  s.config.ownerAliases = ['pat'];
  s.schedule.upcoming = [STANDUP, REVIEW];
  return s;
}

/** Tuesday's work, as the sensors report it. */
const TUESDAY = [
  ev('git:commit', '2026-09-29T09:00:00.000Z', { cwd: '/Users/x/Projects/puzzlebox-studio', branch: 'feat/box-484', commitLine: 'feat: hint borders (BOX-484)' }),
  ev('git:commit', '2026-09-29T10:00:00.000Z', { cwd: '/Users/x/Projects/puzzlebox-studio', branch: 'feat/box-484', commitLine: 'fix: borders' }),
  ev('git:commit', '2026-09-29T11:00:00.000Z', { cwd: '/Users/x/Projects/sundial', branch: 'main', commitLine: 'docs: notes' }),
  ev('git:pr-status', '2026-09-29T12:00:00.000Z', { cwd: '/Users/x/Projects/puzzlebox-studio', branch: 'feat/box-484', number: 12, title: 'Hint borders', state: 'OPEN' }),
  ev('git:pr-status', '2026-09-29T12:05:00.000Z', { cwd: '/Users/x/Projects/puzzlebox-studio', branch: 'feat/box-484', number: 12, title: 'Hint borders', state: 'OPEN' }),
  ev('git:pr-status', '2026-09-29T15:00:00.000Z', { cwd: '/Users/x/Projects/puzzlebox-studio', branch: 'feat/box-484', number: 12, title: 'Hint borders', state: 'MERGED' }),
  ev('agent:fleet', '2026-09-29T13:00:00.000Z', { sessions: [{ id: 'a1', cwd: '/Users/x/Projects/puzzlebox-studio', state: 'working' }, { id: 'a2', cwd: '/Users/x/Projects/puzzlebox-studio', state: 'waiting' }] }),
  ev('calendar:active', '2026-09-29T07:05:00.000Z', { event: { title: 'Standup', startDate: '2026-09-29T07:00:00.000Z', attendees: ['pat', 'Mira Bakker', 'Bob Jansen'] } }),
];

describe('briefClock folds what a standup reads back', () => {
  it('each day: commits and branches per project, a pull request once per state, tickets, working agent sessions, and who was met', () => {
    const s = fold(base(), TUESDAY);
    expect(s.briefs!.days['2026-09-29']).toEqual({
      commits: { 'puzzlebox-studio': { n: 2, branches: ['feat/box-484'] }, sundial: { n: 1, branches: ['main'] } },
      prs: { 'puzzlebox-studio#12': { number: 12, title: 'Hint borders', state: 'MERGED' } },
      tickets: ['BOX-484'],
      agents: { 'puzzlebox-studio': ['a1'] },
    });
    expect(s.briefs!.lastMet).toEqual({ 'Mira Bakker': { title: 'Standup', start: '2026-09-29T07:00:00.000Z' }, 'Bob Jansen': { title: 'Standup', start: '2026-09-29T07:00:00.000Z' } });
  });

  it('forgets days past the horizon at the day boundary', () => {
    const s = fold(base(), TUESDAY);
    const later = briefClock(s, ev('day:boundary', '2026-10-08T22:00:00.000Z')).state;
    expect(later.briefs!.days).toEqual({});
  });
});

describe('briefClock speaks before meetings (lane B #22, #13)', () => {
  it('ten minutes before a standup: the three-line draft, once a day, as a plain interruption', () => {
    const s = fold(base(), TUESDAY);
    expect(noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T06:45:00.000Z')).effects), 'fifteen minutes out: not yet').toEqual([]);
    const out = briefClock(s, ev('clock:tick', '2026-09-30T06:51:00.000Z'));
    const [draft] = noticesOf(out.effects);
    expect(draft).toMatchObject({ kind: 'standup-draft', key: 'standup-draft:2026-09-30', plain: true, surprise: 1.7, valueHalfLifeMs: 600_000 });
    expect(draft!.observation).toBe(
      'Standup at 09:00 with Mira Bakker, Bob Jansen. Yesterday: 2 commits on puzzlebox-studio (feat/box-484), 1 on sundial (main); PR #12 merged; BOX-484. Agent sessions: 1 on puzzlebox-studio. Today: BOX-484 review 14:00.',
    );
    expect(out.state.briefs!.latest).toMatchObject({ kind: 'standup-draft', title: 'Standup' });
    expect(noticesOf(briefClock(out.state, ev('clock:tick', '2026-09-30T06:54:00.000Z')).effects), 'once').toEqual([]);
  });

  it('just deployed, with no earlier day folded, it stays quiet instead of saying "no work"', () => {
    expect(noticesOf(briefClock(base(), ev('clock:tick', '2026-09-30T06:51:00.000Z')).effects)).toEqual([]);
  });

  it('a standup is told by its shape: a long or an afternoon series is not one', () => {
    const s = base();
    s.schedule.upcoming = [{ ...STANDUP, end: '2026-09-30T08:30:00.000Z' }];
    expect(noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T06:51:00.000Z')).effects)).toEqual([]);
    s.schedule.upcoming = [{ ...STANDUP, recurring: false }];
    expect(noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T06:51:00.000Z')).effects), 'not a series, never met before, and nothing to prep').toEqual([]);
    const met = fold(base(), TUESDAY);
    met.schedule.upcoming = [{ ...STANDUP, recurring: false }];
    expect(noticesOf(briefClock(met, ev('clock:tick', '2026-09-30T06:51:00.000Z')).effects)[0], 'the same title met yesterday is a series').toMatchObject({ kind: 'standup-draft' });
  });

  it('ten minutes before another meeting: a prep in passing, only when the record holds something on those people', () => {
    const s = fold(base(), TUESDAY);
    s.briefs!.done['standup-draft:2026-09-30'] = '2026-09-30T06:51:00.000Z';
    expect(noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T11:51:00.000Z')).effects)).toEqual([]);
    s.tickets = { 'BOX-484': { id: 'BOX-484', firstSeen: '', lastSeen: '', days: [], sources: {}, stage: 'pr', commits: 2, pr: { number: 12, state: 'MERGED', reviewState: null } } };
    s.mail.recent = [{ from: 'Mira Bakker', subject: 'Border colours', at: '2026-09-29T16:00:00.000Z' }];
    const [prep] = noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T11:51:00.000Z')).effects);
    expect(prep).toMatchObject({ kind: 'meeting-prep', key: 'meeting-prep:BOX-484 review|2026-09-30T12:00:00.000Z', valueHalfLifeMs: null, plain: true });
    expect(prep!.observation).toBe('BOX-484 review at 14:00 with Mira Bakker. Last met: Standup, Yesterday. In play: BOX-484 (PR #12 merged). Mail: Mira Bakker “Border colours” (Yesterday).');
  });

  it('a kind the owner called wrong twice running goes quiet', () => {
    const s = fold(base(), TUESDAY);
    s.feedback.recent = ['2026-09-28', '2026-09-29'].map((d) => ({ artifactKind: 'notice' as const, artifactId: `standup-draft:${d}`, verdict: 'wrong' as const, solicited: false, note: null, ts: `${d}T08:00:00.000Z` }));
    expect(noticesOf(briefClock(s, ev('clock:tick', '2026-09-30T06:51:00.000Z')).effects)).toEqual([]);
  });
});
