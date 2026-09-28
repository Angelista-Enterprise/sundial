import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ShellCapture } from './shell-capture.js';

let scratchDir: string;
const MISSING_HOOK_PATH = '/nonexistent/gnomon-shell-hook-test.jsonl';

/**
 * `ShellCapture.init()` seeks a detected history file to its CURRENT size —
 * only content appended *after* init counts as "new." So every test creates
 * the file empty first, inits, then appends the real content — matching
 * real startup behavior (a daemon starting up shouldn't replay a user's
 * entire existing shell history).
 */
function createEmptyHistory(fileName: string): string {
  const filePath = path.join(scratchDir, fileName);
  fs.writeFileSync(filePath, '');
  return filePath;
}

describe('ShellCapture (L2, docs/audit/remediation-todo.md standalone bug list)', () => {
  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnomon-shell-capture-test-'));
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it('uses zsh EXTENDED_HISTORY start-time as the real timestamp, not "now"', () => {
    const filePath = createEmptyHistory('.zsh_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, ': 1690000000:0;echo hello\n');

    const [entry] = capture.readNewCommands();
    expect(entry.command).toBe('echo hello');
    expect(entry.timestamp).toBe(new Date(1690000000 * 1000).toISOString());
  });

  it('falls back to "now" for a plain (non-extended) zsh history line, since it has no recoverable timestamp', () => {
    const filePath = createEmptyHistory('.zsh_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, 'echo hello\n');

    const before = Date.now();
    const [entry] = capture.readNewCommands();
    const after = Date.now();

    expect(entry.command).toBe('echo hello');
    const parsed = Date.parse(entry.timestamp);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('uses the bash #<epoch> comment line as the real timestamp when HISTTIMEFORMAT recorded one', () => {
    const filePath = createEmptyHistory('.bash_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, '#1690000000\necho hello\n');

    const [entry] = capture.readNewCommands();
    expect(entry.command).toBe('echo hello');
    expect(entry.timestamp).toBe(new Date(1690000000 * 1000).toISOString());
  });

  it('falls back to "now" for plain bash history with no #<epoch> comment', () => {
    const filePath = createEmptyHistory('.bash_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, 'echo hello\n');

    const [entry] = capture.readNewCommands();
    expect(entry.command).toBe('echo hello');
    expect(Date.parse(entry.timestamp)).not.toBeNaN();
  });

  it("uses fish's when: field as the real timestamp", () => {
    const fishDir = path.join(scratchDir, '.local', 'share', 'fish');
    fs.mkdirSync(fishDir, { recursive: true });
    const filePath = path.join(fishDir, 'fish_history');
    fs.writeFileSync(filePath, '');

    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, '- cmd: echo hello\n  when: 1690000000\n');

    const [entry] = capture.readNewCommands();
    expect(entry.command).toBe('echo hello');
    expect(entry.timestamp).toBe(new Date(1690000000 * 1000).toISOString());
  });

  it('does not batch-stamp multiple historical commands with the same "now" instant when timestamps are recoverable', () => {
    const filePath = createEmptyHistory('.zsh_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, ': 1690000000:0;first\n: 1690003600:0;second\n: 1690007200:0;third\n');

    const entries = capture.readNewCommands();
    expect(entries.map((e) => e.command)).toEqual(['first', 'second', 'third']);
    expect(entries.map((e) => e.timestamp)).toEqual([
      new Date(1690000000 * 1000).toISOString(),
      new Date(1690003600 * 1000).toISOString(),
      new Date(1690007200 * 1000).toISOString(),
    ]);
  });

  it('still infers cwd from a `cd` command interleaved with timestamped commands', () => {
    const filePath = createEmptyHistory('.zsh_history');
    const capture = new ShellCapture(scratchDir, MISSING_HOOK_PATH);
    capture.init();
    fs.appendFileSync(filePath, ': 1690000000:0;cd /tmp/project\n: 1690000010:0;git status\n');

    const entries = capture.readNewCommands();
    expect(entries[1].cwd).toBe('/tmp/project');
  });
});
