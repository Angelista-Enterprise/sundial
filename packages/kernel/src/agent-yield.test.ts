import { describe, expect, it } from 'vitest';
import { agentYield, agentYieldLine, projectOfCwd } from './agent-yield.js';

const fleet = (ts: string, sessions: Record<string, unknown>[], ended?: Record<string, unknown>[]) => ({ type: 'agent:fleet', ts, data: { sessions, ...(ended ? { ended } : {}) } });
const pr = (ts: string, branch: string, number: number, state: string) => ({ type: 'git:pr-status', ts, data: { cwd: '~/Projects/puzzlebox-studio', branch, number, state } });
const cwd = '~/Projects/puzzlebox-studio';

describe('agentYield', () => {
  it('counts sessions per project and week, their cost with its n, and which ended in a merged PR', () => {
    const rows = agentYield(
      [
        fleet('2026-09-28T09:00:00.000Z', [
          { id: 'aaaa0001', cwd, branch: 'feat/box-484' },
          { id: 'bbbb0002', cwd, branch: 'main' },
          { id: 'cccc0003', cwd, branch: 'fix/timeout' },
        ]),
        // The first session again, now with its full id and a cost: still one session.
        fleet('2026-09-28T10:00:00.000Z', [{ id: 'aaaa0001', sid: 'aaaa0001-full', cwd, branch: 'feat/box-484', costUsd: 3.2 }]),
        fleet('2026-09-28T12:00:00.000Z', [], [{ id: 'cccc0003', cwd, branch: 'fix/timeout', costUsd: 1.1, lastAt: '2026-09-28T11:00:00.000Z', pr: { number: 7, url: 'x' } }]),
        pr('2026-09-29T08:00:00.000Z', 'feat/box-484', 5, 'MERGED'),
        pr('2026-09-29T08:00:00.000Z', 'fix/timeout', 7, 'OPEN'),
      ],
      'UTC',
    );
    expect(rows).toEqual([{ week: '2026-09-28', project: 'puzzlebox-studio', sessions: 3, onBranch: 2, merged: 1, openPr: 1, costUsd: 4.3, costKnown: 2, branches: 2, branchesMerged: 1 }]);
    expect(agentYieldLine(rows[0]!)).toBe('Claude cost about $4 on puzzlebox-studio this week (cost known for 2 of 3 sessions); 1 of 3 sessions ended in a merged PR.');
  });

  it('gives branch-level yield from agent:session, which has no session ids, one row per week worked', () => {
    const rows = agentYield(
      [
        { type: 'agent:session', ts: '2026-09-14T09:00:00.000Z', data: { cwd, branch: 'feat/a' } },
        { type: 'agent:session', ts: '2026-09-22T09:00:00.000Z', data: { cwd, branch: 'feat/a' } },
        { type: 'agent:session', ts: '2026-09-22T10:00:00.000Z', data: { cwd, branch: 'main' } },
        pr('2026-09-23T08:00:00.000Z', 'feat/a', 9, 'MERGED'),
      ],
      'UTC',
    );
    expect(rows.map((r) => [r.week, r.sessions, r.branches, r.branchesMerged])).toEqual([
      ['2026-09-21', 0, 1, 1],
      ['2026-09-14', 0, 1, 1],
    ]);
    expect(agentYieldLine(rows[0]!, 'last week')).toBe('1 of 1 branches an agent worked on in puzzlebox-studio last week have merged.');
  });

  it('names a project by its checkout folder', () => {
    expect(projectOfCwd('~/Projects/q/puzzlebox-studio/')).toBe('puzzlebox-studio');
  });
});
