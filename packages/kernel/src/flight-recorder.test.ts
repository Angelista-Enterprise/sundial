import { describe, expect, it } from 'vitest';
import { buildTimeline, keepRow, postmortemDraft, type LogRow, type MomentRow } from './flight-recorder.js';

const TZ = 'UTC';
const REPO = '~/Projects/puzzlebox-studio';
const row = (id: string, type: string, ts: string, data: Record<string, unknown>): LogRow => ({ id, type, ts, data });
const at = (hhmm: string) => `2026-09-28T${hhmm}:00.000Z`;

/** 14:00–16:00 on puzzlebox: a failing test run, a fix, a push, CI red then green, a meeting, an agent, and another repo's noise. */
const rows: LogRow[] = [
  row('s1', 'shell:command', at('14:02'), { command: 'pnpm test', exitCode: 1, cwd: REPO }),
  row('s2', 'shell:command', at('14:05'), { command: 'pnpm test', exitCode: 1, cwd: REPO }),
  row('s3', 'shell:command', at('14:09'), { command: 'pnpm test', exitCode: 1, cwd: REPO }),
  row('f1', 'file:changed', at('14:10'), { projectRoot: REPO, changes: [{ relPath: 'src/login.ts' }] }),
  row('f2', 'file:changed', at('14:12'), { projectRoot: REPO, changes: [{ relPath: 'src/session.ts' }, { relPath: 'src/login.ts' }] }),
  row('s4', 'shell:command', at('14:20'), { command: 'pnpm test', exitCode: 0, cwd: REPO }),
  row('c1', 'git:commit', at('14:22'), { commitLine: 'BOX-484 fix the session refresh', branch: 'feat/BOX-484', cwd: REPO, filesChanged: 2 }),
  row('p1', 'git:push', at('14:23'), { branch: 'feat/BOX-484', cwd: REPO, remote: 'origin' }),
  row('r1', 'git:pr-status', at('14:30'), { number: 12, title: 'Fix session refresh', state: 'OPEN', checkState: 'failure', cwd: REPO, branch: 'feat/BOX-484' }),
  row('r2', 'git:pr-status', at('14:40'), { number: 12, title: 'Fix session refresh', state: 'OPEN', checkState: 'failure', cwd: REPO, branch: 'feat/BOX-484' }),
  row('r3', 'git:pr-status', at('15:10'), { number: 12, title: 'Fix session refresh', state: 'OPEN', checkState: 'success', cwd: REPO, branch: 'feat/BOX-484' }),
  row('k1', 'calendar:active', at('15:00'), { event: { eventId: 'e1', title: 'puzzlebox sync', startDate: at('15:00'), endDate: at('15:30'), attendees: '["Mira Bakker"]' } }),
  row('k2', 'calendar:active', at('15:05'), { event: { eventId: 'e1', title: 'puzzlebox sync', startDate: at('15:00'), endDate: at('15:30'), attendees: '["Mira Bakker"]' } }),
  row('i1', 'idle:start', at('15:31'), {}),
  row('i2', 'idle:end', at('15:45'), {}),
  row('a1', 'agent:fleet', at('15:50'), { sessions: [{ id: 'x', cwd: REPO, state: 'waiting', since: at('15:48'), title: 'Refresh tests' }, { id: 'y', cwd: REPO, state: 'working', since: at('15:40') }] }),
  row('a2', 'agent:fleet', at('15:51'), { sessions: [{ id: 'x', cwd: REPO, state: 'waiting', since: at('15:48'), title: 'Refresh tests' }] }),
  row('o1', 'shell:command', at('15:55'), { command: 'ls', exitCode: 0, cwd: '~/Projects/other-thing' }),
];
const moments: MomentRow[] = [
  { id: 'm1', start: at('14:00'), end: at('14:25'), projectId: REPO, process: 'Code', data: { intent: { text: 'fixing the session refresh' } } },
  { id: 'm2', start: at('14:26'), end: at('14:27'), projectId: REPO, process: 'Code', data: {} },
];

describe('buildTimeline', () => {
  const lines = buildTimeline(rows, moments, TZ, {});

  it('is one ordered story, oldest first, each line keeping its row id', () => {
    expect(lines[0]).toMatchObject({ at: '14:00', kind: 'focus', id: 'm1' });
    expect(lines.map((l) => l.ts)).toEqual([...lines.map((l) => l.ts)].sort());
    expect(lines.every((l) => typeof l.id === 'string' && l.id !== '')).toBe(true);
  });

  it('folds the same command run three times, and the file saves in a row', () => {
    expect(lines.find((l) => l.id === 's1')).toMatchObject({ text: '$ pnpm test (exit 1) in puzzlebox-studio', n: 3 });
    expect(lines.find((l) => l.id === 'f1')).toMatchObject({ text: 'edited 2 files in puzzlebox-studio: login.ts, session.ts', n: 2 });
  });

  it('says a PR only when it changes, a meeting once, an agent when it starts waiting', () => {
    expect(lines.filter((l) => l.kind === 'pr').map((l) => l.id)).toEqual(['r1', 'r3']);
    expect(lines.filter((l) => l.kind === 'meeting' && l.id.startsWith('k'))).toHaveLength(1);
    expect(lines.filter((l) => l.kind === 'agent')).toEqual([expect.objectContaining({ at: '15:48', text: 'agent Refresh tests: waiting for you' })]);
  });

  it('leaves a one-minute moment out', () => {
    expect(lines.some((l) => l.id === 'm2')).toBe(false);
  });

  it('filters by project and keeps the away lines that explain the gap', () => {
    const only = buildTimeline(rows, moments, TZ, { project: 'puzzlebox' });
    expect(only.some((l) => l.id === 'o1')).toBe(false);
    expect(only.some((l) => l.id === 'i1')).toBe(true);
    expect(only.some((l) => l.id === 'c1')).toBe(true);
  });

  it('filters by person', () => {
    expect(buildTimeline(rows, moments, TZ, { people: ['Mira Bakker'] }).map((l) => l.id)).toEqual(['k1']);
  });
});

describe('postmortemDraft', () => {
  const kept = rows.filter((r) => keepRow(r, { project: 'puzzlebox' }));
  const draft = postmortemDraft(kept, buildTimeline(kept, moments, TZ, { project: 'puzzlebox' }), TZ, 'puzzlebox, 14:00–16:00');

  it('names what failed, when it passed, and the red CI', () => {
    const text = draft.lines.join('\n');
    expect(text).toContain('`pnpm test` failed 3× from 14:02, passed at 14:20');
    expect(text).toContain('CI failed on PR #12 (first at 14:30)');
    expect(text).toContain('What resolved it: `pnpm test` green at 14:20');
    expect(text).toContain('For you to fill');
  });

  it('counts with n', () => {
    expect(draft.counts).toMatchObject({ commits: 1, pushes: 1, commands: 4, failed: 3, ciRed: 2, reverts: 0, forcePushes: 0, awayMin: 14, meetings: 1 });
  });

  it('says so when the window is empty', () => {
    expect(postmortemDraft([], [], TZ, 'x').lines[1]).toContain('Nothing in the record');
  });
});
