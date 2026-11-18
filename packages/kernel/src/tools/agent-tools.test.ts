import { describe, expect, it } from 'vitest';
import type { AgentFleetEntry } from '../types.js';
import { buildAgentSessions, buildPullRequests, sessionTurns, type TurnRow } from './agent-tools.js';

const NOW = '2026-10-05T12:00:00.000Z';
const turn = (sid: string, at: string, role: TurnRow['role'], text: string, extra: Partial<TurnRow> = {}): TurnRow => ({ at, sid, session: sid.slice(0, 8), agent: 'claude', cwd: '~/puzzlebox-studio', branch: 'BOX-484-fix', role, text, tool: null, ...extra });
const fleet = (id: string, state: AgentFleetEntry['state'], since: string, extra: Partial<AgentFleetEntry> = {}): AgentFleetEntry => ({ id: id.slice(0, 8), sid: id, cwd: '~/puzzlebox-studio', branch: 'BOX-484-fix', state, since, ...extra });

describe('buildAgentSessions', () => {
  const A = 'aaaaaaaa-1111';
  const B = 'bbbbbbbb-2222';
  const input = {
    now: NOW,
    fleet: [fleet(A, 'working', '2026-10-05T11:50:00.000Z'), fleet(B, 'question', '2026-10-05T11:00:00.000Z', { title: 'Fix the DNS cache', costUsd: 3, branch: 'dns-fix' })],
    turns: [
      turn(B, '2026-10-05T09:00:00.000Z', 'prompt', 'find the DNS root cause', { branch: 'dns-fix' }),
      turn(B, '2026-10-05T10:00:00.000Z', 'rejected', 'no, not the router', { tool: 'Bash', branch: 'dns-fix' }),
      turn(B, '2026-10-05T10:30:00.000Z', 'prompt', 'try the resolver cache', { branch: 'dns-fix' }),
      turn(B, '2026-10-05T10:59:00.000Z', 'reply', 'Which resolver do you use?', { branch: 'dns-fix' }),
      turn(A, '2026-10-05T11:40:00.000Z', 'prompt', 'add the export button'),
      turn('cccccccc-codex', '2026-10-05T11:30:00.000Z', 'prompt', 'rename the module', { agent: 'codex', cwd: '~/other', branch: 'main' }),
      turn('dddddddd-old', '2026-10-04T20:00:00.000Z', 'prompt', 'yesterday', { agent: 'codex' }),
    ],
    edits: [{ at: '2026-10-05T09:30:00.000Z', session: 'bbbbbbbb', file: 'src/dns.ts' }, { at: '2026-10-05T09:31:00.000Z', session: 'bbbbbbbb', file: 'src/dns.ts' }],
    commits: [
      { at: '2026-10-05T09:45:00.000Z', cwd: '~/puzzlebox-studio', branch: 'dns-fix', line: 'abc1234 cache the last good answer' },
      { at: '2026-10-05T09:46:00.000Z', cwd: '~/elsewhere', branch: 'dns-fix', line: 'def5678 another repo' },
      { at: '2026-10-05T08:00:00.000Z', cwd: '~/puzzlebox-studio', branch: 'dns-fix', line: 'before it opened' },
    ],
    status: [{ at: '2026-10-05T11:55:00.000Z', cwd: '~/puzzlebox-studio', dirtyFiles: 2 }],
    logStart: '2026-10-05T08:00:00.000Z',
  };
  const out = buildAgentSessions(input);

  it('puts the session waiting on the owner first, with its ask, its dead end and its yield', () => {
    expect(out.map((s) => [s.id, s.waits])).toEqual([['bbbbbbbb', 'you'], ['aaaaaaaa', 'itself'], ['cccccccc', 'unknown']]);
    expect(out[0]).toMatchObject({
      title: 'Fix the DNS cache',
      firstPrompt: 'find the DNS root cause',
      lastPromptAt: '2026-10-05T10:30:00.000Z',
      lastReply: 'Which resolver do you use?',
      prompts: 2,
      rejected: [{ tool: 'Bash', said: 'no, not the router' }],
      edited: 1,
      commits: 1,
      lastCommit: 'abc1234 cache the last good answer',
      costUsd: 3,
      usdPerCommit: 3,
      dirtyFiles: 2,
    });
  });

  it('lists another agent from its recent turns, never one gone quiet for hours', () => {
    expect(out[2]).toMatchObject({ agent: 'codex', state: 'unknown', firstPrompt: 'rename the module', project: 'other' });
    expect(out.some((s) => s.id === 'dddddddd')).toBe(false);
  });

  it('one session in full, oldest first', () => {
    expect(sessionTurns(input.turns, 'bbbbbbbb').map((t) => t.role)).toEqual(['prompt', 'rejected', 'prompt', 'reply']);
  });
});

describe('buildPullRequests', () => {
  const row = (at: string, data: Record<string, unknown>) => ({ at, data: { url: `https://github.com/acme/puzzlebox-studio/pull/${data.number}`, ...data } });
  const now = '2026-03-09T12:00:00.000Z';

  it('keeps each PR once in its latest state, open first, and the size the search added', () => {
    const rows = [
      row('2026-03-09T09:00:00Z', { number: 484, title: 'BOX-484', branch: 'fix/BOX-484', state: 'OPEN', reviewState: 'pending', checkState: 'none', cwd: '/r/puzzlebox-studio' }),
      row('2026-03-09T09:05:00Z', { number: 484, repo: 'acme/puzzlebox-studio', base: 'develop', state: 'OPEN', reviewState: 'approved', checkState: 'success', additions: 8, deletions: 15, changedFiles: 2, createdAt: '2026-03-08T16:00:00Z' }),
      row('2026-03-07T09:00:00Z', { number: 470, title: 'BOX-470', state: 'MERGED' }),
      row('2026-02-20T09:00:00Z', { number: 400, title: 'old', state: 'MERGED' }),
    ];
    const open = buildPullRequests(rows, now);
    expect(open).toEqual([expect.objectContaining({ repo: 'acme/puzzlebox-studio', number: 484, title: 'BOX-484', branch: 'fix/BOX-484', base: 'develop', review: 'approved', checks: 'success', additions: 8, deletions: 15, files: 2, openedAt: '2026-03-08T16:00:00Z', lastSeen: '2026-03-09T09:05:00Z' })]);
    expect(buildPullRequests(rows, now, true).map((p) => [p.number, p.state])).toEqual([[484, 'OPEN'], [470, 'MERGED']]);
  });

  it('an OPEN not heard of for a day is unconfirmed, not open', () => {
    const rows = [row('2026-03-07T09:00:00Z', { number: 300, title: 'left behind', state: 'OPEN' })];
    expect(buildPullRequests(rows, now)).toEqual([]);
    expect(buildPullRequests(rows, now, true).map((p) => p.state)).toEqual(['UNCONFIRMED']);
  });
});
