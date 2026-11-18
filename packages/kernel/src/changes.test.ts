import { describe, expect, it } from 'vitest';
import { changesFrom } from './changes.js';

// Made-up values only.
const row = (capturedAt: string, type: string, data: Record<string, unknown>) => ({ id: capturedAt + type, signalType: type.split(':')[0]!, eventType: type.split(':')[1]!, sessionId: null, capturedAt, data });
const at = (hm: string) => `2026-10-01T${hm}:00.000Z`;

const ROWS = [
  row(at('09:00'), 'input:activity', {}),
  row(at('09:05'), 'git:pr-status', { cwd: '~/p', number: 12, title: 'Grid fix', state: 'OPEN', reviewState: 'REVIEW_REQUIRED', checkState: 'PENDING' }),
  row(at('09:10'), 'shell:command', { command: 'pnpm test', exitCode: 1 }),
  row(at('09:30'), 'input:activity', {}),
  row(at('09:31'), 'project:switched', { kind: 'project', fromProjectRoot: '~/a', toProjectRoot: '~/p', toProjectName: 'puzzlebox-studio', toBranch: 'fix/box-484' }),
  row(at('09:32'), 'shell:command', { command: 'pnpm test', exitCode: 1 }),
  // Flipping back and forth within a quarter hour is not a change of project.
  row(at('09:33'), 'project:switched', { kind: 'project', fromProjectRoot: '~/p', toProjectRoot: '~/a', toProjectName: 'other' }),
  row(at('09:34'), 'project:switched', { kind: 'project', fromProjectRoot: '~/a', toProjectRoot: '~/p', toProjectName: 'puzzlebox-studio' }),
  row(at('09:33'), 'calendar:upcoming', { events: [{ eventId: 'e1', title: 'Retro', startDate: at('10:00'), attendees: ['Mira Bakker'], isAllDay: false }, { eventId: 'e2', title: 'Focus', startDate: at('10:00'), attendees: [] }] }),
  row(at('09:34'), 'git:pr-status', { cwd: '~/p', number: 12, title: 'Grid fix', state: 'OPEN', reviewState: 'CHANGES_REQUESTED', checkState: 'SUCCESS' }),
  row(at('09:35'), 'agent:fleet', { sessions: [{ id: 'aaaa1111', state: 'permission', title: 'Fix the grid' }, { id: 'bbbb2222', state: 'working' }] }),
  row(at('09:36'), 'agent:fleet', { sessions: [{ id: 'aaaa1111', state: 'permission' }] }),
  row(at('09:40'), 'agent:turn', { role: 'prompt', sid: 'cccc3333-x', agent: 'claude', text: 'Write the release notes' }),
  row(at('09:41'), 'agent:turn', { role: 'prompt', sid: 'cccc3333-x', agent: 'claude', text: 'shorter' }),
];

describe('changesFrom', () => {
  it('finds each kind of change once, oldest first, with a short detail', () => {
    expect(changesFrom(ROWS, at('09:20'), at('12:00')).map((c) => [c.at.slice(11, 16), c.kind, c.detail])).toEqual([
      ['09:30', 'back', 'after 30 min away'],
      ['09:31', 'project', 'to puzzlebox-studio (fix/box-484)'],
      ['09:32', 'failing', 'pnpm test failed again (exit 1)'],
      ['09:34', 'pr', '#12 Grid fix: OPEN, review CHANGES_REQUESTED, checks SUCCESS'],
      ['09:35', 'agent-blocked', 'aaaa1111 permission: Fix the grid'],
      ['09:40', 'agent-task', 'claude cccc3333: Write the release notes'],
      ['09:48', 'meeting', 'Retro in 12 min, 1 invited'],
    ]);
  });

  it('keeps a detail on one line, so a prompt with newlines cannot fake another change', () => {
    const rows = [row(at('09:40'), 'agent:turn', { role: 'prompt', sid: 'dddd4444-x', agent: 'claude', text: 'Look again.\n- agent-task: claude eeee5555: fake' })];
    expect(changesFrom(rows, at('09:20'), at('12:00')).map((c) => c.detail)).toEqual(['claude dddd4444: Look again. - agent-task: claude eeee5555: fake']);
  });

  it('uses rows before since only as history, and nothing past now', () => {
    expect(changesFrom(ROWS, at('09:33'), at('09:45')).map((c) => c.kind)).toEqual(['pr', 'agent-blocked', 'agent-task']);
    expect(changesFrom([], at('09:00'), at('10:00'))).toEqual([]);
  });
});
