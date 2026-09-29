import { describe, expect, it } from 'vitest';
import { createInitialState } from './initial-state.js';
import { buildSituation, editTrail, phaseOf, restoreLinks } from './situation.js';

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

  it('offers unpushed commits only when recent and plausible (U2-F20)', () => {
    const state = base();
    const at = (since: string, ahead: number) => ({ '~/Projects/acme/puzzlebox-studio': { branch: 'main', ahead, since, updatedAt: since } });
    state.git = { ...state.git, unpushed: at('2026-09-22T12:00:00.000Z', 3) };
    expect(buildSituation(state, {}, NOW).openHere.unpushed).toEqual({ branch: 'main', ahead: 3 });
    state.git = { ...state.git, unpushed: at('2026-09-01T12:00:00.000Z', 3) };
    expect(buildSituation(state, {}, NOW).openHere.unpushed).toBeNull();
    state.git = { ...state.git, unpushed: at('2026-09-22T12:00:00.000Z', 900) };
    expect(buildSituation(state, {}, NOW).openHere.unpushed).toBeNull();
  });

  it('carries the last return line for an hour (U2-F8)', () => {
    const state = base();
    state.resume = { intents: {}, last: { at: '2026-09-23T11:30:00.000Z', trigger: 'break', awayMs: 40 * 60_000, key: 'return-from-break:2026-09-23', line: 'Back after 40 min — Fixing the retry test', pieces: {} } };
    expect(buildSituation(state, {}, NOW).resume?.line).toBe('Back after 40 min — Fixing the retry test');
    expect(buildSituation(state, {}, NOW + 31 * 60_000).resume).toBeNull();
  });

  it('offers a way back into each piece, as a link or an ask, never an action (U2-F30 F31 F32 F34)', () => {
    const links = restoreLinks(
      {
        file: { path: '~/code/puzzlebox/src/retry.ts', app: 'Code' },
        tab: { url: 'https://example.test/pull/812', title: 'Fix retry backoff' },
        agent: { id: 'abcd1234', sid: 'abcd1234-0000-4000-8000-000000000000', cwd: '~/code/puzzlebox', state: 'waiting', title: 'Fix retry backoff', lastPrompt: null, since: '2026-09-23T11:00:00.000Z' },
        failure: { command: 'pnpm test', exitCode: 1, cwd: '~/code/puzzlebox', at: '2026-09-23T11:00:00.000Z' },
      },
      '/Users/mira',
    );
    expect(links).toEqual([
      { piece: 'file', label: 'Open retry.ts', href: 'vscode://file/Users/mira/code/puzzlebox/src/retry.ts' },
      { piece: 'tab', label: 'Open “Fix retry backoff”', href: 'https://example.test/pull/812' },
      { piece: 'agent', label: 'Resume the Claude session “Fix retry backoff”', ask: 'Open a terminal in ~/code/puzzlebox and run: claude --resume abcd1234-0000-4000-8000-000000000000' },
      { piece: 'failure', label: 'Re-run `pnpm test`', ask: 'Re-run `pnpm test` in ~/code/puzzlebox and tell me if it passes.' },
    ]);
    expect(restoreLinks({ tab: { url: 'https://a.test/x', title: null }, tabs: { space: 'Work', tabs: [{ url: 'https://a.test/x', title: 'X' }, { url: 'https://a.test/y', title: null }] } }, null)).toEqual([
      { piece: 'tab', label: 'Open a.test/x', href: 'https://a.test/x' },
      { piece: 'tabs', label: 'Work: a.test/y', href: 'https://a.test/y' },
    ]);
    // No home, no editor link; an app with no URL scheme, none either.
    expect(restoreLinks({ file: { path: '~/a.ts', app: 'Code' } }, null)).toEqual([]);
    expect(restoreLinks({ file: { path: '/a.txt', app: 'TextEdit' } }, '/Users/mira')).toEqual([]);
  });

  it('the edit trail: one row per file on the project, symbols merged, last touched last (U2-F14 F40)', () => {
    const row = (at: string, projectRoot: string, edits: unknown[]) => ({ capturedAt: at, data: { projectRoot, edits } });
    const rows = [
      row('2026-09-23T11:00:00.000Z', '~/p', [{ file: 'src/retry.ts', symbols: ['classifySidecar'] }]),
      row('2026-09-23T11:05:00.000Z', '~/q', [{ file: 'other.ts', symbols: ['x'] }]),
      row('2026-09-23T11:10:00.000Z', '~/p', [{ file: 'src/gate.ts', symbols: [] }]),
      row('2026-09-23T11:20:00.000Z', '~/p', [{ file: 'src/retry.ts', symbols: ['retryBackoff', 'classifySidecar'] }]),
    ];
    expect(editTrail(rows, '~/p')).toEqual([
      { at: '2026-09-23T11:10:00.000Z', file: 'src/gate.ts', symbols: [] },
      { at: '2026-09-23T11:20:00.000Z', file: 'src/retry.ts', symbols: ['classifySidecar', 'retryBackoff'] },
    ]);
  });

  it('lists only what is open on THIS project', () => {
    const state = base();
    state.commitments = {
      ...state.commitments,
      open: [
        { id: 'c1', name: 'ghweb-credit-line', projectId: '~/Projects/acme/puzzlebox-studio', lastTouchedAt: '2026-09-21T12:00:00.000Z' },
        { id: 'c2', name: 'ledger-retry-views', projectId: '~/Projects/sundial', lastTouchedAt: '2026-09-23T11:00:00.000Z' },
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
