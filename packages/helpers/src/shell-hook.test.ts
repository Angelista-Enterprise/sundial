import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendShellHookEntry, encodeShellHookEntry } from './shell-hook.js';

let dir: string;
let hookFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-hook-'));
  hookFile = path.join(dir, 'nested', 'shell-events.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Read back what the sensor would read: one JSON object per line. */
function readEntries(): Record<string, unknown>[] {
  return fs
    .readFileSync(hookFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('encodeShellHookEntry', () => {
  it('writes the terse wire shape the sensor parses, one line, newline-terminated', () => {
    const line = encodeShellHookEntry({
      command: 'npm test',
      cwd: '/work',
      exitCode: 0,
      durationMs: 1200,
      timestamp: '2026-08-16T10:00:00.000Z',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({ c: 'npm test', d: '/work', e: 0, t: '2026-08-16T10:00:00.000Z', m: 1200 });
  });

  it('omits fields the producer does not know rather than writing nulls', () => {
    const parsed = JSON.parse(encodeShellHookEntry({ command: 'ls', cwd: null, exitCode: null, durationMs: null }));
    expect(parsed.c).toBe('ls');
    expect(parsed).not.toHaveProperty('d');
    expect(parsed).not.toHaveProperty('e');
    expect(parsed).not.toHaveProperty('m');
    expect(typeof parsed.t).toBe('string');
  });

  it('keeps a multi-line command on ONE line — the reader splits on newlines', () => {
    const line = encodeShellHookEntry({ command: 'echo one\necho two' });
    expect(line.split('\n').filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(line).c).toBe('echo one\necho two');
  });

  it('records a non-zero exit code, not just success', () => {
    expect(JSON.parse(encodeShellHookEntry({ command: 'false', exitCode: 1 })).e).toBe(1);
  });
});

describe('appendShellHookEntry', () => {
  it('creates the directory and file, and appends across calls', () => {
    expect(appendShellHookEntry({ command: 'first' }, hookFile)).toBe(true);
    expect(appendShellHookEntry({ command: 'second' }, hookFile)).toBe(true);

    const entries = readEntries();
    expect(entries.map((e) => e.c)).toEqual(['first', 'second']);
  });

  it('creates the file 0600 — it holds every command run on this machine', () => {
    appendShellHookEntry({ command: 'secret --token abc' }, hookFile);
    expect(fs.statSync(hookFile).mode & 0o777).toBe(0o600);
  });

  it('ignores an empty or whitespace-only command', () => {
    expect(appendShellHookEntry({ command: '' }, hookFile)).toBe(false);
    expect(appendShellHookEntry({ command: '   ' }, hookFile)).toBe(false);
    expect(fs.existsSync(hookFile)).toBe(false);
  });

  it('never throws on an unwritable path — telemetry must not fail the command', () => {
    expect(appendShellHookEntry({ command: 'ls' }, '/proc/nonexistent/shell-events.jsonl')).toBe(false);
  });
});
