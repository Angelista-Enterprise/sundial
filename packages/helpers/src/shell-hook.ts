import fs from 'node:fs';
import path from 'node:path';
import { getShellHookFilePath } from './sundial-paths.js';

/**
 * The one writer of `~/.sundial/.daemon/shell-events.jsonl`.
 *
 * `ShellCapture` (packages/sensors/src/shell) has always preferred this file
 * over history-file parsing, but nothing ever wrote it, so the preferred path
 * was dead and every shell answer came from `~/.zsh_history`. That fallback
 * cannot see:
 *
 *   - any command an agent ran (`bash -c` writes no interactive history),
 *   - a command's exit code, duration, or real cwd (history records none),
 *   - anything at all until the shell that ran it exits and flushes.
 *
 * Which is why the audit found ~15 agent commands missing from the lowest-level
 * record while the tool answered "did I run X" with confidence.
 *
 * Every producer of a command — the interactive shell hook, dsh's `bash` tool,
 * `gnomon_run_shell` — appends here, and the sensor stays the single reader.
 * That keeps ONE path into the `shell:command` signal rather than giving each
 * producer its own sensor, per the kernel's law.
 *
 * The wire shape is `ShellCapture`'s `HookEntry`, unchanged and deliberately
 * terse — this file is appended to on every command, so the key names are one
 * character each.
 */
export interface ShellHookEntry {
  /** The command line as run. */
  command: string;
  /** Working directory it ran in, when the producer knows it. */
  cwd?: string | null;
  /** Process exit code, when the producer waited for one. */
  exitCode?: number | null;
  /** Wall-clock duration in ms, when the producer measured it. */
  durationMs?: number | null;
  /** ISO timestamp; defaults to now. */
  timestamp?: string;
}

/** Serialize one entry to the terse on-disk shape (`c`ommand, `d`ir, `e`xit, `t`ime, `m`illis). */
export function encodeShellHookEntry(entry: ShellHookEntry): string {
  const wire: Record<string, unknown> = {
    c: entry.command,
    t: entry.timestamp ?? new Date().toISOString(),
  };
  if (entry.cwd !== undefined && entry.cwd !== null) wire.d = entry.cwd;
  if (typeof entry.exitCode === 'number') wire.e = entry.exitCode;
  if (typeof entry.durationMs === 'number' && entry.durationMs >= 0) wire.m = entry.durationMs;
  // One line, no embedded newline: the reader splits on '\n' and skips
  // anything that will not parse, so a multi-line command must not break the
  // line framing. JSON.stringify escapes newlines inside the string already.
  return `${JSON.stringify(wire)}\n`;
}

/**
 * Append one command to the hook file. Best-effort and never throws: a
 * telemetry write must not fail the command it is recording, and every caller
 * here is on a user-visible path (a tool result, a shell prompt).
 *
 * @param entry the command and whatever facts the producer has about it
 * @param hookFilePath override, for tests
 * @returns true when the line was written
 */
export function appendShellHookEntry(entry: ShellHookEntry, hookFilePath = getShellHookFilePath()): boolean {
  if (!entry.command || entry.command.trim().length === 0) return false;
  try {
    fs.mkdirSync(path.dirname(hookFilePath), { recursive: true });
    // The file holds every command the owner and their agents run — 0600 from
    // the moment it exists, not repaired later by whoever reads it first.
    fs.appendFileSync(hookFilePath, encodeShellHookEntry(entry), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
