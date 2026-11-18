import { describe, it, expect } from 'vitest';
import { createInitialState } from '@sundial/kernel/initial-state.js';
import type { KernelState, SanitizedEvent } from '@sundial/kernel/types.js';
import { MAX_TICKETS, ticketKeys, ticketTrack, TICKET_HORIZON_DAYS } from './ticket-track.js';

let seq = 0;
const day = (d: number, h = 10) => new Date(Date.UTC(2026, 8, 20 + d, h)).toISOString();
const ev = (type: string, payload: Record<string, unknown>, ts: string): SanitizedEvent => ({ id: `e${++seq}`, type, ts, payload, sanitized: true });
const fold = (events: SanitizedEvent[], state: KernelState = { ...createInitialState('d'), config: { ...createInitialState('d').config, timezone: 'Europe/Amsterdam' } }) =>
  events.reduce((s, e) => ticketTrack(s, e).state, state);

describe('ticketKeys', () => {
  it('takes tracker keys and leaves standards, rooms, clocks and zero alone', () => {
    expect(ticketKeys('BOX-538 Feedback · HQ-2-14 · HQ-3-02 · AUDIT-2026 · UTF-8 · ISO-8601 · PR-1234 · ZX12-3456 · BOX-0 · KIT-448')).toEqual(['BOX-538', 'KIT-448']);
  });
});

describe('ticketTrack', () => {
  it('stitches one ticket across senses and days, counting where it was seen', () => {
    const s = fold([
      ev('browser:tab', { title: 'BOX-538 Feedback modal - Jira', url: 'https://x.atlassian.net/browse/BOX-538' }, day(0)),
      ev('screen:ocr', { screenText: 'Aron: can you look at BOX-538?' }, day(1)),
      ev('window:changed', { windowTitle: 'BOX-538 - Jira' }, day(3)),
    ]);
    expect(s.tickets?.['BOX-538']).toMatchObject({ stage: 'seen', days: ['2026-09-20', '2026-09-21', '2026-09-23'], sources: { browser: 1, screen: 1, window: 1 }, firstSeen: day(0), lastSeen: day(3) });
  });

  it('a board listing many keys counts them as listed, not looked at', () => {
    const board = 'BOX-1 a BOX-2 b BOX-3 c BOX-4 d';
    const s = fold([ev('page:text', { title: 'BOX-2 · Jira', url: 'https://x/browse/BOX-2', text: board }, day(0)), ev('screen:ocr', { screenText: board }, day(1))]);
    expect(s.tickets?.['BOX-2']).toMatchObject({ days: ['2026-09-20'], sources: { page: 1, list: 1 } });
    expect(s.tickets?.['BOX-1']).toMatchObject({ days: [], sources: { list: 2 } });
  });

  it('moves the stage with a branch (any case), commits and the PR', () => {
    const s = fold([
      ev('git:status', { branch: 'claude/box-411-po-fixes', cwd: '~/p' }, day(0)),
      ev('git:commit', { commitLine: 'abc fix(BOX-411): header', branch: 'claude/box-411-po-fixes' }, day(0, 11)),
      ev('git:pr-status', { branch: 'claude/box-411-po-fixes', title: '[x] BOX-411 header', number: 12, state: 'OPEN', reviewState: 'approved' }, day(1)),
    ]);
    // The commit names the ticket twice (line and branch) but is one commit.
    expect(s.tickets?.['BOX-411']).toMatchObject({ stage: 'pr', commits: 1, pr: { number: 12, state: 'OPEN', reviewState: 'approved' } });
  });

  it('reads a merge commit as the PR merged', () => {
    const s = fold([
      ev('git:pr-status', { branch: 'feature/BOX-471', title: 'BOX-471: colours', number: 12, state: 'OPEN', reviewState: 'approved' }, day(0)),
      ev('git:commit', { commitLine: 'abc1234 Merge pull request #12 from acme/feature/BOX-471', branch: 'develop' }, day(2)),
    ]);
    expect(s.tickets?.['BOX-471']).toMatchObject({ stage: 'pr', pr: { number: 12, state: 'MERGED', reviewState: 'approved' } });
  });

  it('keeps a worked-on ticket when a board floods the list with ones only seen', () => {
    const work = [ev('git:commit', { commitLine: 'abc fix(BOX-526): accents', branch: 'feature/BOX-526' }, day(0))];
    const board = Array.from({ length: MAX_TICKETS + 5 }, (_, i) => ev('window:changed', { windowTitle: `ZZ-${i + 1}` }, day(1, 10 + (i % 10))));
    const s = fold([...work, ...board]);
    expect(Object.keys(s.tickets ?? {})).toHaveLength(MAX_TICKETS);
    expect(s.tickets?.['BOX-526']).toMatchObject({ stage: 'commit', commits: 1 });
  });

  it('a branch sampled again the same day is not a new sighting', () => {
    const s = fold([ev('git:status', { branch: 'feat/PL-9' }, day(0)), ev('git:status', { branch: 'feat/PL-9' }, day(0, 12)), ev('agent:fleet', { sessions: [{ branch: 'feat/PL-9' }] }, day(0, 13))]);
    expect(s.tickets?.['PL-9']?.sources).toEqual({ branch: 1 });
  });

  it('forgets a thread past the horizon on the day boundary', () => {
    const s = fold([ev('window:changed', { windowTitle: 'OLD-1' }, day(0)), ev('window:changed', { windowTitle: 'NEW-2' }, day(TICKET_HORIZON_DAYS)), ev('day:boundary', {}, day(TICKET_HORIZON_DAYS + 1))]);
    expect(Object.keys(s.tickets ?? {})).toEqual(['NEW-2']);
  });
});
