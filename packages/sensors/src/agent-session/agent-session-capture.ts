import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the active coding-agent session is working.
 *
 * A Claude Code desktop window is the single largest unattributable surface
 * Gnomon has: measured on the live log, 277 consecutive `window:changed` events
 * carried `documentPath: null` and a window title of exactly `"Claude"`, worth
 * 86 moments and 141.8 minutes over two days — the owner's primary coding
 * surface, permanently `null`. The app exposes no AX document, no per-project
 * title, and (being an Electron app with its renderer accessibility off) no AX
 * subtree to read either.
 *
 * The locator exists somewhere else entirely: Claude Code writes a session
 * transcript per project under `~/.claude/projects/<encoded-cwd>/<session>.jsonl`,
 * and each record carries the session's own absolute `cwd` and `gitBranch`. That
 * is a genuine per-window locator, not an ambient guess — which is what lets the
 * attribution tier built on it claim `certain` confidence without reopening the
 * bug that `decisions/no-ambient-project-attribution` closed.
 *
 * The directory NAME is deliberately not parsed. Its encoding is lossy: every
 * `/` and `.` becomes `-`, and a directory can contain a literal `-`, so
 * `-Users-pat-Projects-acme-puzzlebox-studio` has no unambiguous inverse.
 * The `cwd` field inside the file is exact, so that is what is read.
 */

/** Only these two fields are ever read out of a transcript. Nothing else is parsed, retained, or emitted. */
export interface AgentSessionSnapshot {
  cwd: string;
  branch: string | null;
}

/**
 * How recently a session's transcript must have been written for that session to
 * count as ACTIVE.
 *
 * Without a bound, a Claude window opened for an unrelated conversation would
 * inherit whichever project was last coded in — ambient attribution by the back
 * door, and the exact failure this sensor is otherwise careful to avoid. Thirty
 * minutes is long enough to survive reading a long response without the session
 * going cold, and short enough that yesterday's work never stamps today's chat.
 */
const SESSION_ACTIVE_MS = 30 * 60 * 1000;

/** A transcript line is only inspected far enough to find the cwd; a session's cwd is fixed, so it is always in the opening records. */
const MAX_LINES_SCANNED = 40;
/** Bytes read from the start of a transcript to find those lines. */
export const LOCATOR_HEAD_BYTES = 64 * 1024;

/**
 * How much more recent the winning session must be than the newest session in
 * ANY other directory, for there to be a winner at all.
 *
 * "Most recently written transcript" is only a locator when one session is
 * running. The owner routinely runs two Claude Code sessions at once, and both
 * write while they work, so the naive rule flips between them constantly — 427
 * changes over two days in the recorded transcripts, which is the ambient
 * flicker `no-ambient-project-attribution` exists to refuse.
 *
 * A transcript can only be attributed to the focused window when it is clearly
 * the one being worked in; when two sessions are writing within a minute of each
 * other, which one the window is showing is genuinely unknowable from disk, and
 * the honest answer is none. Measured against the 100 historical Claude moments:
 * the naive rule attributes 98 with a 15.3% project-to-project flip rate, this
 * guard attributes 86 with 10.5% — trading 12 moments for a third fewer wrong
 * ones. Widening to 120s buys only 1 further point of flip rate for 2 more
 * moments, so the curve flattens here.
 */
const AMBIGUITY_MARGIN_MS = 60 * 1000;

function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The newest still-active transcript in each project directory.
 *
 * Grouped by directory rather than flattened, because the ambiguity test is
 * between SESSIONS IN DIFFERENT PROJECTS: two transcripts in one directory are
 * the same project resumed, and must not make each other ambiguous.
 */
function newestPerProject(root: string, now: number): { file: string; mtimeMs: number }[] {
  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(root);
  } catch {
    return []; // Claude Code not installed, or no sessions yet.
  }

  const newestByDir: { file: string; mtimeMs: number }[] = [];
  for (const dir of projectDirs) {
    const full = path.join(root, dir);
    let entries: string[];
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      entries = fs.readdirSync(full);
    } catch {
      continue;
    }
    let best: { file: string; mtimeMs: number } | null = null;
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = path.join(full, entry);
      try {
        const { mtimeMs } = fs.statSync(file);
        // Skip anything already cold — cheaper than reading it, and a stale
        // session must not win the "newest" race against no session at all.
        if (now - mtimeMs > SESSION_ACTIVE_MS) continue;
        if (!best || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
      } catch {
        // A session file deleted mid-scan.
      }
    }
    if (best) newestByDir.push(best);
  }
  return newestByDir.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * `cwd`/`gitBranch` from the opening records of a transcript.
 *
 * Reads a bounded prefix of the file and stops at the first record carrying a
 * `cwd`. Message content is never touched: the loop breaks as soon as the two
 * locator fields are known, and nothing else is copied out of the parsed record.
 */
export function readSessionLocator(file: string): AgentSessionSnapshot | null {
  let head: string;
  try {
    // Only the head: a transcript runs to tens of MB, and this is read every 15 s (U3-F11).
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(LOCATOR_HEAD_BYTES);
      head = buf.toString('utf-8', 0, fs.readSync(fd, buf, 0, LOCATOR_HEAD_BYTES, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = head.split('\n', MAX_LINES_SCANNED);
  for (const line of lines) {
    if (!line.includes('"cwd"')) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const cwd = record.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) continue;
    const branch = record.gitBranch;
    return { cwd, branch: typeof branch === 'string' && branch.length > 0 ? branch : null };
  }
  return null;
}

/** One project's most recent write, as the decision below sees it. `group` is any stable per-project key. */
export interface SessionCandidate {
  group: string;
  lastWriteMs: number;
}

/**
 * Which project's session is the focused agent window showing — the whole
 * decision, isolated from where the timings came from.
 *
 * Pure and I/O-free on purpose. The live sensor derives candidates from
 * transcript mtimes; the historical backfill derives them from the timestamps
 * inside the transcripts. Those are different inputs to the same question, and
 * if each re-implemented the ACTIVE window and the ambiguity margin the
 * backfilled history would silently stop matching what the daemon now records.
 */
export function pickActiveSession(candidates: SessionCandidate[], now: number): string | null {
  const active = candidates.filter((c) => now - c.lastWriteMs <= SESSION_ACTIVE_MS).sort((a, b) => b.lastWriteMs - a.lastWriteMs);
  const winner = active[0];
  if (!winner) return null;

  // A different project written to within the margin makes the focused window
  // unknowable — see AMBIGUITY_MARGIN_MS.
  const runnerUp = active.find((c) => c.group !== winner.group);
  if (runnerUp && winner.lastWriteMs - runnerUp.lastWriteMs < AMBIGUITY_MARGIN_MS) return null;

  return winner.group;
}

/**
 * The active coding-agent session's working directory, or null when no session
 * has been written to recently (or when two are ambiguous).
 *
 * `root`/`now` are injectable for tests only; the daemon calls this with neither.
 */
export function readAgentSession(now: number = Date.now(), root: string = claudeProjectsDir()): AgentSessionSnapshot | null {
  const active = newestPerProject(root, now);
  const winner = pickActiveSession(
    active.map((a) => ({ group: a.file, lastWriteMs: a.mtimeMs })),
    now,
  );
  return winner ? readSessionLocator(winner) : null;
}
