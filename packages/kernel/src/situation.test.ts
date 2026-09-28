import { describe, expect, it } from 'vitest';
import { createInitialState } from './initial-state.js';
import { buildSituation, phaseOf } from './situation.js';

const NOW = Date.parse('2026-09-23T12:00:00.000Z');
const base = () => {
  const s = createInitialState('test');
  return {
    ...s,
    project: { ...s.project, current: { id: '~/Projects/acme/puzzlebox-studio', name: 'puzzlebox-studio' }, known: { '~/Projects/acme/puzzlebox-studio': { name: 'puzzlebox-studio' } } },
  } as unknown as typeof s;
};

describe('buildSituation (S1)', () => {
  it('says when the project is carried over rather than in front', () => {
    // A browser tab has no project. Showing the last attributed one as if it
    // were the present is how "puzzlebox-studio" sat beside a YouTube video.
    const s = buildSituation(base(), {}, NOW);
    expect(s.now.project?.name).toBe('puzzlebox-studio');
    expect(s.now.projectIsSticky).toBe(true);
  });

  it('takes the next TIMED event, and keeps all-day items as context', () => {
    const state = base();
    state.schedule = {
      ...state.schedule,
      upcoming: [
        { title: 'Noah middag vrij', start: '2026-09-22T22:00:00.000Z', end: '2026-09-23T21:59:59.000Z', attendees: [], isAllDay: true },
        { title: 'Planning', start: '2026-09-23T12:10:00.000Z', end: '2026-09-23T13:00:00.000Z', attendees: ['puzzlebox-team'], isAllDay: false },
      ],
    } as typeof state.schedule;
    const s = buildSituation(state, {}, NOW);
    expect(s.next).toEqual({ title: 'Planning', startsInMin: 10, with: ['puzzlebox-team'] });
    expect(s.todayAllDay, 'an afternoon off is not the next meeting').toEqual(['Noah middag vrij']);
  });

  it('knows a meeting under way from the calendar, and a call from the microphone', () => {
    const state = base();
    state.schedule = { ...state.schedule, upcoming: [{ title: 'Standup', start: '2026-09-23T11:50:00.000Z', end: '2026-09-23T12:20:00.000Z', attendees: [], isAllDay: false }] } as typeof state.schedule;
    expect(buildSituation(state, {}, NOW).you).toBe('in-a-meeting');
    state.av = { ...state.av, call: { app: 'Teams', kind: 'call', since: '2026-09-23T11:55:00.000Z', cameraEver: false } } as typeof state.av;
    expect(buildSituation(state, {}, NOW).you, 'a live call outranks the calendar').toBe('in-a-call');
  });

  it('lists only what is open on THIS project', () => {
    const state = base();
    state.commitments = {
      ...state.commitments,
      open: [
        { id: 'c1', name: 'ghweb-credit-line', projectId: '~/Projects/acme/puzzlebox-studio', lastTouchedAt: '2026-09-21T12:00:00.000Z' },
        { id: 'c2', name: 'ledger-failure-views', projectId: '~/Projects/sundial', lastTouchedAt: '2026-09-23T11:00:00.000Z' },
      ],
    } as unknown as typeof state.commitments;
    const s = buildSituation(state, {}, NOW);
    expect(s.openHere.commitments).toEqual([{ id: 'c1', name: 'ghweb-credit-line', quietDays: 2 }]);
  });
});

describe('phaseOf (S2)', () => {
  const at = (hhmmZ: string) => Date.parse(`2026-09-23T${hhmmZ}:00.000Z`);
  const state = () => {
    const s = base() as any;
    s.config = { ...s.config, timezone: 'UTC' };
    return s;
  };
  const cal = { inMeeting: false, nextInMin: null as number | null };

  it('reads the clock when nothing else is happening: morning, working, evening', () => {
    expect(phaseOf(state(), cal, at('08:00'))).toBe('morning');
    expect(phaseOf(state(), cal, at('14:00'))).toBe('working');
    expect(phaseOf(state(), cal, at('20:30'))).toBe('evening');
  });

  it('puts a meeting in ten minutes ahead of the time of day', () => {
    expect(phaseOf(state(), { inMeeting: false, nextInMin: 10 }, at('08:50'))).toBe('meeting-soon');
    expect(phaseOf(state(), { inMeeting: false, nextInMin: 40 }, at('08:50'))).toBe('morning');
  });

  it('knows a meeting just ended — unless hearing says the owner was not in it', () => {
    const s = state();
    s.meetings = { seen: { m: { title: 'Standup', start: '2026-09-23T09:00:00.000Z', end: '2026-09-23T09:30:00.000Z', attendees: ['team'], askedAt: null, listened: true, heard: 200 } } };
    expect(phaseOf(s, cal, at('09:40'))).toBe('meeting-ended');
    s.meetings.seen.m.heard = 3;
    expect(phaseOf(s, cal, at('09:40'))).toBe('morning');
  });

  it('tells a return from a break from a switch of project', () => {
    const s = state();
    s.moment = { ...(s.moment ?? {}), startTime: '2026-09-23T14:05:00.000Z', projectId: 'sundial', processName: 'Claude', rollup: { windowTitles: [] } };
    s.project = { ...s.project, lastClosedMoment: { projectId: 'sundial', confidence: 'certain', endedAt: '2026-09-23T13:30:00.000Z' } };
    expect(phaseOf(s, cal, at('14:08'))).toBe('back-from-break');
    s.project.lastClosedMoment = { projectId: 'puzzlebox', confidence: 'certain', endedAt: '2026-09-23T14:04:00.000Z' };
    expect(phaseOf(s, cal, at('14:08'))).toBe('switched-project');
    expect(phaseOf(s, cal, at('14:30'))).toBe('working');
  });

  it('carries the phase and its question on the situation', () => {
    const sit = buildSituation(state(), {}, at('20:00'));
    expect(sit.phase).toBe('evening');
    expect(sit.question).toBe('What did I do today?');
  });
});
