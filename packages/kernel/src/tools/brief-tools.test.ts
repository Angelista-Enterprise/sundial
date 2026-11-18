import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEFS } from '../briefs.js';
import { createInitialState } from '../initial-state.js';
import { toolEnv } from '../tool-env.js';
import { BRIEF_TOOLS } from './brief-tools.js';

const brief = BRIEF_TOOLS.find((t) => t.name === 'gnomon_brief')!;
const NOW = new Date('2026-11-18T09:00:00.000Z');

function state() {
  const s = createInitialState('d1');
  s.config.timezone = 'UTC';
  s.config.ownerAliases = ['Owner'];
  const event = (title: string, start: string, attendees: string[], isAllDay = false) => ({ title, start, end: new Date(Date.parse(start) + 30 * 60_000).toISOString(), attendees, isAllDay });
  s.schedule.upcoming = [
    event('Focus block', '2026-11-18T10:00:00.000Z', ['Owner']),
    event('Offsite', '2026-11-18T00:00:00.000Z', ['Owner', 'Mira Bakker'], true),
    event('Design review', '2026-11-18T11:00:00.000Z', ['Owner', 'Mira Bakker']),
    event('BOX planning', '2026-11-18T14:00:00.000Z', ['Owner', 'Rook Hallam']),
  ];
  return s;
}

describe('gnomon_brief', () => {
  it('says so when there is no state yet', async () => {
    expect(await brief.handler({ kind: 'standup' }, toolEnv(() => null, NOW))).toEqual({ unavailable: 'No kernel state has been written yet.' });
  });

  it('preps the next meeting with other people, skipping a solo block and an all-day event', async () => {
    const out = (await brief.handler({ kind: 'meeting' }, toolEnv(state, NOW))) as Record<string, any>;
    expect(out.meeting).toEqual({ title: 'Design review', start: '2026-11-18T11:00:00.000Z', end: '2026-11-18T11:30:00.000Z' });
    expect(out.lines[0]).toBe('Design review at 11:00 with Mira Bakker.');
  });

  it('finds a meeting by part of its title, and says when none matches', async () => {
    expect(((await brief.handler({ kind: 'meeting', title: 'box' }, toolEnv(state, NOW))) as Record<string, any>).meeting.title).toBe('BOX planning');
    expect(await brief.handler({ kind: 'meeting', title: 'retro' }, toolEnv(state, NOW))).toEqual({ none: 'No meeting with others whose title contains "retro" is on the calendar ahead.' });
  });

  it('gives the standup lines: no work day on the record, then today', async () => {
    const out = (await brief.handler({ kind: 'standup' }, toolEnv(state, NOW))) as Record<string, any>;
    expect(out).toEqual({ lines: ['No work on the record for the last few days.', 'Today: Focus block 10:00, Design review 11:00, BOX planning 14:00.'], lastWorkDay: null });
  });

  it("gives the week in review, marked when it is last week's", async () => {
    const s = state();
    expect(await brief.handler({ kind: 'week' }, toolEnv(() => s, NOW))).toEqual({ none: expect.stringMatching(/^No week in review has been composed yet/) });
    s.briefs = { ...EMPTY_BRIEFS, week: { from: '2026-11-16', to: '2026-11-22', lines: ['12 commits'], at: '2026-11-20T13:00:00.000Z' } };
    expect(await brief.handler({ kind: 'week' }, toolEnv(() => s, NOW))).toEqual(s.briefs!.week);
    s.briefs = { ...EMPTY_BRIEFS, week: { from: '2026-11-09', to: '2026-11-15', lines: ['9 commits'], at: '2026-11-13T13:00:00.000Z' } };
    expect(((await brief.handler({ kind: 'week' }, toolEnv(() => s, NOW))) as Record<string, any>).note).toBe("This is the review of the week of 2026-11-09; this week's is composed from Friday 13:00.");
  });
});
