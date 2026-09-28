import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAgentSession } from './agent-session-capture.js';

let root: string;
const NOW = Date.parse('2026-08-01T12:00:00Z');
const MINUTE = 60 * 1000;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-agent-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A transcript under an encoded project dir, written `ageMinutes` ago. */
function session(dirName: string, lines: unknown[], ageMinutes: number, file = 'session.jsonl'): void {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, file);
  fs.writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n'));
  const at = new Date(NOW - ageMinutes * MINUTE);
  fs.utimesSync(full, at, at);
}

describe('readAgentSession', () => {
  it('reads cwd and gitBranch from the newest active transcript', () => {
    session('-Users-x-Projects-app', [{ type: 'user', cwd: '/Users/x/Projects/app', gitBranch: 'main' }], 1);
    expect(readAgentSession(NOW, root)).toEqual({ cwd: '/Users/x/Projects/app', branch: 'main' });
  });

  it('picks the most recently written session across projects', () => {
    session('-Users-x-Projects-old', [{ cwd: '/Users/x/Projects/old', gitBranch: 'a' }], 10, 'a.jsonl');
    session('-Users-x-Projects-new', [{ cwd: '/Users/x/Projects/new', gitBranch: 'b' }], 1, 'b.jsonl');
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/new');
  });

  // Two concurrent sessions both write while they work; which one the focused
  // window is showing is not knowable from disk, so neither may be claimed.
  it('returns null when two projects were written to within the margin', () => {
    session('-Users-x-Projects-a', [{ cwd: '/Users/x/Projects/a' }], 1, 'a.jsonl');
    session('-Users-x-Projects-b', [{ cwd: '/Users/x/Projects/b' }], 1.5, 'b.jsonl');
    expect(readAgentSession(NOW, root)).toBeNull();
  });

  it('resolves once the runner-up falls outside the margin', () => {
    session('-Users-x-Projects-a', [{ cwd: '/Users/x/Projects/a' }], 1, 'a.jsonl');
    session('-Users-x-Projects-b', [{ cwd: '/Users/x/Projects/b' }], 3, 'b.jsonl');
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/a');
  });

  // Two transcripts in one directory are the same project resumed — they must
  // not make each other ambiguous.
  it('is not made ambiguous by a second session in the SAME project', () => {
    session('-Users-x-Projects-a', [{ cwd: '/Users/x/Projects/a' }], 1, 'first.jsonl');
    session('-Users-x-Projects-a', [{ cwd: '/Users/x/Projects/a' }], 1.2, 'second.jsonl');
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/a');
  });

  it('ignores a cold runner-up entirely when judging ambiguity', () => {
    session('-Users-x-Projects-a', [{ cwd: '/Users/x/Projects/a' }], 1, 'a.jsonl');
    session('-Users-x-Projects-b', [{ cwd: '/Users/x/Projects/b' }], 45, 'b.jsonl');
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/a');
  });

  // Without this bound a Claude window opened for an unrelated conversation
  // would inherit whichever project was last coded in — ambient attribution.
  it('ignores a session that has gone cold', () => {
    session('-Users-x-Projects-app', [{ cwd: '/Users/x/Projects/app' }], 31);
    expect(readAgentSession(NOW, root)).toBeNull();
  });

  it('does not let a cold session outrank no session at all', () => {
    session('-Users-x-Projects-cold', [{ cwd: '/Users/x/Projects/cold' }], 90, 'c.jsonl');
    expect(readAgentSession(NOW, root)).toBeNull();
  });

  // The directory name encoding is lossy — `/` and `.` both become `-`, and a
  // directory can contain a literal `-` — so only the cwd INSIDE the file is used.
  it('takes cwd from the record, not from the lossy directory name', () => {
    session('-Users-x-Projects-acme-puzzlebox-studio', [{ cwd: '/Users/x/Projects/acme/puzzlebox-studio' }], 1);
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/acme/puzzlebox-studio');
  });

  it('skips leading records until one carries a cwd', () => {
    session('-Users-x-Projects-app', [{ type: 'queue-operation', sessionId: 'abc' }, { type: 'summary' }, { type: 'user', cwd: '/Users/x/Projects/app' }], 1);
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/app');
  });

  it('reports a null branch when the record has none', () => {
    session('-Users-x-Projects-app', [{ cwd: '/Users/x/Projects/app' }], 1);
    expect(readAgentSession(NOW, root)).toEqual({ cwd: '/Users/x/Projects/app', branch: null });
  });

  it('returns null when Claude Code has never run', () => {
    expect(readAgentSession(NOW, path.join(root, 'nope'))).toBeNull();
  });

  it('tolerates a malformed transcript line', () => {
    const dir = path.join(root, '-Users-x-Projects-app');
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, 's.jsonl');
    fs.writeFileSync(full, `{"cwd": broken\n${JSON.stringify({ cwd: '/Users/x/Projects/app' })}`);
    const at = new Date(NOW - MINUTE);
    fs.utimesSync(full, at, at);
    expect(readAgentSession(NOW, root)?.cwd).toBe('/Users/x/Projects/app');
  });
});
