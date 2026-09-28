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
}

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
  private useHookFile = false;
  private hookFileOffset = 0;
  private historyFile: HistoryFile | null = null;
  private inferredCwd: string | null = null;

  constructor(homeDir = process.env.HOME ?? os.homedir(), hookFilePath = getShellHookFilePath()) {
    this.homeDir = homeDir;
    this.hookFilePath = hookFilePath;
  }

  init(): void {
    if (fs.existsSync(this.hookFilePath)) {
      // A file already on disk at boot carries a backlog from before this
      // process — seek past it, exactly as the history path does.
      this.adoptHookFile(this.hookFileSize());
    } else {
      this.detectHistoryFile();
    }
  }

  /** Which source is live. The caller gates the history path on terminal focus and the hook path on nothing. */
  get usesHookFile(): boolean {
    return this.useHookFile;
  }

  /**
   * Switch to the hook file if it has appeared since the last check, and
   * report which source is live.
   *
   * The hook file is created by the first command anyone runs, which is
   * routinely AFTER the daemon booted. Without this a process that started on a
   * machine with no hook file would parse history for its whole lifetime and
   * ignore the better source sitting next to it.
   *
   * Separate from `readNewCommands` on purpose: the caller must be able to ask
   * "which source is this?" BEFORE it decides whether the focus gate applies.
   * Folding the check into the read made adoption unreachable — the history
   * path returns early when unfocused, so the check never ran.
   */
  refreshSource(): boolean {
    if (!this.useHookFile && fs.existsSync(this.hookFilePath)) {
      // It did not exist when we last looked, so everything in it is new —
      // start at zero rather than seeking past the very first command.
      this.adoptHookFile(0);
    }
    return this.useHookFile;
  }

  /** Call on every poll tick (the caller owns the focus gate for the history path). */
  readNewCommands(): ShellCommandCapture[] {
    return this.useHookFile ? this.readHookFile() : this.readHistoryFile();
  }

  private hookFileSize(): number {
    try {
      return fs.statSync(this.hookFilePath).size;
    } catch {
      return 0;
    }
  }

  private adoptHookFile(offset: number): void {
    this.useHookFile = true;
    this.hookFileOffset = offset;
    this.historyFile = null;
    try {
      fs.chmodSync(this.hookFilePath, 0o600);
    } catch {
      // Foreign ownership or unsupported FS — best effort.
    }
  }

  /**
   * On regaining terminal focus, skip whatever accumulated in the history
   * file while unfocused — only relevant to the history-file fallback path;
   * the hook file is never re-seeked (each entry already carries its own
   * cwd, so there's no "which window was this typed in" ambiguity to skip).
   */
  reseekHistoryFileToNow(): void {
    if (this.useHookFile || !this.historyFile) return;
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
          out.push({ timestamp: timestamp ?? new Date().toISOString(), command, cwd: this.inferredCwd, exitCode: null, durationMs: null });
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
