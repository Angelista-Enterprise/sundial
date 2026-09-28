import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every coding-agent session the owner has running, and whether it is waiting
 * for them.
 *
 * `agent:session` answers one question — which project is the focused Claude
 * window on — and deliberately says nothing when two sessions write at once.
 * But two at once is the normal case: measured over 2026-09-21..28, 37 Claude
 * Code sessions, two or more live in 585 ten-minute buckets and three or more in
 * 160. And a session that finished its turn sits idle until the owner comes
 * back: 388 waits in that week, median 2.6 min, but 114 longer than five
 * minutes and 51 longer than fifteen — while the owner was often in another
 * app. This sensor is the fleet view that makes those waits visible.
 *
 * What is read, and nothing else: each record's `type`, `timestamp`, `cwd`,
 * `gitBranch`, `isSidechain`, the assistant's `stop_reason`, and whether a user
 * record is a tool result. Message text is parsed (a line is JSON) but never
 * copied out.
 */

export type AgentFleetState = 'working' | 'waiting' | 'tool';

export interface AgentFleetSession {
  /** First 8 characters of the session id — stable, and enough to tell sessions apart. */
  id: string;
  cwd: string;
  branch: string | null;
  /** `waiting`: the turn ended, the agent waits for the owner. `tool`: a tool call has no result yet (running, or waiting on an approval). `working`: the agent is mid-turn. */
  state: AgentFleetState;
  /** When the current state began — stable while it holds, so an unchanged fleet dedupes at ingest. */
  since: string;
}

/** A session last written longer ago than this is not part of the fleet. */
export const FLEET_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Most sessions reported, newest first. */
export const MAX_FLEET = 12;
/** How much of a transcript's end is read. A turn's last records are always in it. */
const TAIL_BYTES = 256 * 1024;

interface TailRecord {
  type: 'user' | 'assistant';
  ts: string;
  stopReason: string | null;
  toolResult: boolean;
  cwd: string | null;
  branch: string | null;
}

function parseRecord(line: string): TailRecord | null {
  if (!line.includes('"timestamp"')) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (r.isSidechain === true || (r.type !== 'user' && r.type !== 'assistant') || typeof r.timestamp !== 'string') return null;
  const message = typeof r.message === 'object' && r.message !== null ? (r.message as Record<string, unknown>) : {};
  const content = message.content;
  return {
    type: r.type,
    ts: r.timestamp,
    stopReason: typeof message.stop_reason === 'string' ? message.stop_reason : null,
    toolResult: Array.isArray(content) && content.some((c) => typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'tool_result'),
    cwd: typeof r.cwd === 'string' && r.cwd !== '' ? r.cwd : null,
    branch: typeof r.gitBranch === 'string' && r.gitBranch !== '' ? r.gitBranch : null,
  };
}

/**
 * The state of one session from the last lines of its transcript. Pure.
 *
 * - The last record is an assistant turn that ended (`end_turn`, `stop_sequence`,
 *   `max_tokens`) → `waiting`, since that record.
 * - The last record is an assistant `tool_use` → `tool`, since that record.
 * - Anything else (a prompt or a tool result the agent is working on, a
 *   streaming assistant record) → `working`, since the owner's last prompt.
 */
export function classifyTail(lines: string[]): Omit<AgentFleetSession, 'id'> | null {
  const records = lines.map(parseRecord).filter((r): r is TailRecord => r !== null);
  const last = records[records.length - 1];
  if (!last) return null;
  const located = [...records].reverse().find((r) => r.cwd !== null);
  if (!located?.cwd) return null;
  const where = { cwd: located.cwd, branch: located.branch };
  if (last.type === 'assistant' && last.stopReason === 'tool_use') return { ...where, state: 'tool', since: last.ts };
  if (last.type === 'assistant' && last.stopReason !== null) return { ...where, state: 'waiting', since: last.ts };
  const prompt = [...records].reverse().find((r) => r.type === 'user' && !r.toolResult);
  return { ...where, state: 'working', since: prompt?.ts ?? last.ts };
}

function readTail(file: string, size: number): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    // The first line of a mid-file read is a fragment.
    return size > length ? lines.slice(1) : lines;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The fleet, newest first. `skip` drops sessions whose cwd contains it —
 * Sundial's own Claude hands (`.daemon/hands`) are Gnomon's work, not the owner's.
 */
export function readAgentFleet(now: number = Date.now(), root: string = path.join(os.homedir(), '.claude', 'projects'), skip = `${path.sep}.daemon${path.sep}hands`): AgentFleetSession[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const files: { file: string; mtimeMs: number; size: number }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(root, dir));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const file = path.join(root, dir, entry);
      try {
        const { mtimeMs, size } = fs.statSync(file);
        if (now - mtimeMs <= FLEET_WINDOW_MS && size > 0) files.push({ file, mtimeMs, size });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: AgentFleetSession[] = [];
  for (const { file, size } of files) {
    if (out.length >= MAX_FLEET) break;
    let session: Omit<AgentFleetSession, 'id'> | null;
    try {
      session = classifyTail(readTail(file, size));
    } catch {
      continue;
    }
    if (!session || session.cwd.includes(skip)) continue;
    out.push({ id: path.basename(file, '.jsonl').slice(0, 8), ...session });
  }
  return out;
}

/** Polled like `AgentSessionSensor`: self-gated, stateless beyond the rate limit; the dedupe lives in `state.observed`. */
export class AgentFleetSensor {
  private lastPollAt = 0;
  private last: { type: 'agent:fleet'; payload: { timestamp: string; sessions: AgentFleetSession[] } } | null = null;

  poll(now: number = Date.now()): { type: 'agent:fleet'; payload: { timestamp: string; sessions: AgentFleetSession[] } } {
    if (this.last && now - this.lastPollAt < 15_000) return this.last;
    this.lastPollAt = now;
    // Sorted by id so the same fleet is the same payload whatever order the files were written in.
    const sessions = readAgentFleet(now).sort((a, b) => a.id.localeCompare(b.id));
    this.last = { type: 'agent:fleet', payload: { timestamp: new Date(now).toISOString(), sessions } };
    return this.last;
  }
}
