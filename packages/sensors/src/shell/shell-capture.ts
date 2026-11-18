import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getShellHookFilePath } from '@sundial/helpers/sundial-paths.js';

export interface ShellCommandCapture {
  timestamp: string;
  command: string;
  cwd: string | null;
  exitCode: number | null;
  durationMs: number | null;
  /** Who typed it: the hook says; a history line is the owner's by definition (an agent's shell keeps no history). */
  actor: 'owner' | 'agent';
  /** Set 4 R1: the chat whose gnomon_run_shell ran it (hook entry `s`); absent for every other producer. */
  session?: string;
}

interface HistoryFile {
  path: string;
  type: 'zsh' | 'bash' | 'fish';
  lastOffset: number;
}

interface HookEntry {
  c: string;
  d: string;
  e: number;
  t: string;
  m?: number;
  a?: string;
  s?: string;
}

/** A history line this close after the same command from the hook is the same command, seen twice. */
const SAME_COMMAND_MS = 10_000;

/**
 * Ported from WCS's `ShellSensor` (plugins/shell/sensor.ts). Dropped: the
 * `file:extracted`-derived focus-workspace gate (`cwdMatchesFocusedWorkspace`)
 * — Gnomon has no LSP-integration signal to derive a "focused workspace"
 * from, and the gate is a no-op (returns true unconditionally) when that
 * input is absent anyway, so dropping it changes nothing observable.
 */
export class ShellCapture {
  private readonly homeDir: string;
  private readonly hookFilePath: string;
  private hookFileOffset = 0;
  private historyFile: HistoryFile | null = null;
  private inferredCwd: string | null = null;
  /** The hook's last commands, so the same command read from history is not a second one. */
  private recentHook: { command: string; atMs: number }[] = [];

  constructor(homeDir = process.env.HOME ?? os.homedir(), hookFilePath = getShellHookFilePath()) {
    this.homeDir = homeDir;
    this.hookFilePath = hookFilePath;
  }

  /**
   * Both sources, always. Until 2026-10-14 the hook file, once it existed, was
   * the only source for the rest of the process: a shell that did not load the
   * hook (the owner's ~/.zshrc never did; six days of lines came from shells
   * where it was sourced by hand) wrote history that nobody read, and the
   * stream was dead from 10-05 while the history file grew by 14-83 commands
   * a day. A file already on disk at boot is a backlog: seek past it.
   */
  init(): void {
    this.hookFileOffset = this.hookFileSize();
    if (this.hookFileOffset > 0) this.chmodHookFile();
    this.detectHistoryFile();
  }

  /**
   * Call on every poll tick. The hook file is read whatever is focused (each
   * entry carries its own cwd and actor); the history file only while a
   * terminal is, since a history line's only evidence of which shell typed it
   * is the focused window. A history command the hook reported moments
   * before is the same command and is dropped.
   */
  readNewCommands(focused = true): ShellCommandCapture[] {
    const hook = this.readHookFile();
    const now = Date.now();
    for (const h of hook) this.recentHook.push({ command: h.command, atMs: Date.parse(h.timestamp) || now });
    this.recentHook = this.recentHook.filter((h) => now - h.atMs <= SAME_COMMAND_MS * 6).slice(-50);
    if (!focused) return hook;
    const history = this.readHistoryFile().filter((c) => !this.recentHook.some((h) => h.command === c.command && Math.abs((Date.parse(c.timestamp) || now) - h.atMs) <= SAME_COMMAND_MS));
    return [...hook, ...history];
  }

  private hookFileSize(): number {
    try {
      return fs.statSync(this.hookFilePath).size;
    } catch {
      return 0;
    }
  }

  private chmodHookFile(): void {
    try {
      fs.chmodSync(this.hookFilePath, 0o600);
    } catch {
      // Foreign ownership or unsupported FS — best effort.
    }
  }

  /**
   * On regaining terminal focus, skip whatever accumulated in the history
   * file while unfocused; the hook file is never re-seeked (each entry already
   * carries its own cwd, so there's no "which window was this typed in"
   * ambiguity to skip).
   */
  reseekHistoryFileToNow(): void {
    if (!this.historyFile) return;
    try {
      this.historyFile.lastOffset = fs.statSync(this.historyFile.path).size;
    } catch {
      // File doesn't exist yet — leave offset as-is.
    }
  }

  private detectHistoryFile(): void {
    const candidates: Array<{ path: string; type: 'zsh' | 'bash' | 'fish' }> = [
      { path: path.join(this.homeDir, '.zsh_history'), type: 'zsh' },
      { path: path.join(this.homeDir, '.bash_history'), type: 'bash' },
      { path: path.join(this.homeDir, '.local', 'share', 'fish', 'fish_history'), type: 'fish' },
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate.path)) {
        this.historyFile = { ...candidate, lastOffset: fs.statSync(candidate.path).size };
        return;
      }
    }
  }

  private readHookFile(): ShellCommandCapture[] {
    const out: ShellCommandCapture[] = [];
    try {
      const stat = fs.statSync(this.hookFilePath);
      if (stat.size <= this.hookFileOffset) return out;

      const fd = fs.openSync(this.hookFilePath, 'r');
      try {
        const bufferSize = stat.size - this.hookFileOffset;
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, this.hookFileOffset);
        this.hookFileOffset = stat.size;

        for (const line of buffer.toString('utf-8').split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line) as HookEntry;
            if (!entry.c) continue;
            out.push({
              timestamp: entry.t ?? new Date().toISOString(),
              command: entry.c,
              cwd: entry.d ?? null,
              exitCode: typeof entry.e === 'number' ? entry.e : null,
              durationMs: typeof entry.m === 'number' && entry.m >= 0 ? entry.m : null,
              actor: entry.a === 'agent' ? 'agent' : 'owner',
              ...(typeof entry.s === 'string' && entry.s !== '' ? { session: entry.s.slice(0, 120) } : {}),
            });
          } catch {
            // Malformed line — skip.
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Hook file read failed — ignore.
    }
    return out;
  }

  private readHistoryFile(): ShellCommandCapture[] {
    const out: ShellCommandCapture[] = [];
    if (!this.historyFile) return out;

    try {
      const stat = fs.statSync(this.historyFile.path);
      if (stat.size <= this.historyFile.lastOffset) return out;

      const fd = fs.openSync(this.historyFile.path, 'r');
      try {
        const bufferSize = stat.size - this.historyFile.lastOffset;
        const buffer = Buffer.alloc(bufferSize);
        fs.readSync(fd, buffer, 0, bufferSize, this.historyFile.lastOffset);
        this.historyFile.lastOffset = stat.size;

        for (const { command, timestamp } of this.parseHistory(buffer.toString('utf-8'), this.historyFile.type)) {
          this.inferredCwd = this.applyCdCommand(command, this.inferredCwd);
          // L2 (docs/audit/remediation-todo.md's standalone bug list) — use
          // the history format's own timestamp when the entry carries one
          // (zsh's `EXTENDED_HISTORY` start-time, bash's `#<epoch>` comment
          // line, fish's `when:` field); only fall back to "now" when the
          // format genuinely has no timestamp for that line (plain zsh/bash
          // history) — not unconditionally, which is what stamped every
          // command in a whole batch read with the same artificial instant.
          out.push({ timestamp: timestamp ?? new Date().toISOString(), command, cwd: this.inferredCwd, exitCode: null, durationMs: null, actor: 'owner' });
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // History file read failed — ignore.
    }
    return out;
  }

  private applyCdCommand(command: string, cwd: string | null): string | null {
    const trimmed = command.trim();
    const cdMatch = trimmed.match(/^(?:builtin\s+)?cd(?:\s+(.+))?$/);
    if (!cdMatch) return cwd;

    const target = cdMatch[1]?.trim();
    if (!target || target === '~') return this.homeDir;
    if (target === '-') return cwd;
    if (target.startsWith('/')) return target;
    if (target.startsWith('~/')) return path.join(this.homeDir, target.slice(2));
    if (cwd) return path.resolve(cwd, target);
    return null;
  }

  /**
   * L2 (docs/audit/remediation-todo.md's standalone bug list) — returns each
   * command's own real timestamp when the history format records one,
   * `null` when it genuinely doesn't (the caller falls back to "now" only
   * in that case, not unconditionally):
   * - zsh: `EXTENDED_HISTORY` format (`: <epoch>:<elapsed>;<command>`) — a
   *   very common default (oh-my-zsh and others enable it); a plain,
   *   non-extended line has no timestamp to recover.
   * - bash: the `#<epoch>` comment line `HISTTIMEFORMAT` writes immediately
   *   before a command, when that option is set; plain bash history has no
   *   timestamp to recover either.
   * - fish: the `when: <epoch>` field in each entry's multi-line block.
   */
  private parseHistory(content: string, type: 'zsh' | 'bash' | 'fish'): { command: string; timestamp: string | null }[] {
    const lines = content.split('\n').filter(Boolean);
    const entries: { command: string; timestamp: string | null }[] = [];

    if (type === 'zsh') {
      for (const line of lines) {
        const match = line.match(/^:\s*(\d+):\d+;(.+)$/);
        if (match) {
          entries.push({ command: match[2].trim(), timestamp: new Date(Number(match[1]) * 1000).toISOString() });
        } else if (!line.startsWith(':')) {
          entries.push({ command: line.trim(), timestamp: null });
        }
      }
      return entries;
    }

    if (type === 'bash') {
      let pendingTimestamp: string | null = null;
      for (const line of lines) {
        const tsMatch = line.match(/^#(\d+)$/);
        if (tsMatch) {
          pendingTimestamp = new Date(Number(tsMatch[1]) * 1000).toISOString();
          continue;
        }
        entries.push({ command: line.trim(), timestamp: pendingTimestamp });
        pendingTimestamp = null;
      }
      return entries;
    }

    // fish — each entry is a multi-line block: `- cmd: ...` followed by an
    // optional `  when: <epoch>` (and sometimes `  paths:`, ignored here).
    let pendingCommand: string | null = null;
    for (const line of lines) {
      const cmdMatch = line.match(/^- cmd:\s*(.+)$/);
      if (cmdMatch) {
        if (pendingCommand) entries.push({ command: pendingCommand, timestamp: null });
        pendingCommand = cmdMatch[1].trim();
        continue;
      }
      const whenMatch = pendingCommand ? line.match(/^\s*when:\s*(\d+)\s*$/) : null;
      if (whenMatch) {
        entries.push({ command: pendingCommand!, timestamp: new Date(Number(whenMatch[1]) * 1000).toISOString() });
        pendingCommand = null;
      }
    }
    if (pendingCommand) entries.push({ command: pendingCommand, timestamp: null });
    return entries;
  }
}
