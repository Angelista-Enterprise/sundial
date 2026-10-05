import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every coding-agent session the owner has running, and what it waits on.
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
 * Three sources, in order of trust (U3-F4, F7):
 *
 * 1. Claude's own live registry, `~/.claude/sessions/<pid>.json`: one file per
 *    running session with `status` (busy / waiting / idle) and, while waiting,
 *    `waitingFor` (permission prompt, input needed, …). A session is live when
 *    its pid is alive; a pid from another pid domain cannot be probed, so there
 *    a fresh entry counts instead. `busy` holds while background subagents run,
 *    which a transcript reads as a finished turn (U3-F9).
 * 2. Background jobs, `~/.claude/jobs/<id>/state.json` (`claude --bg`).
 * 3. Transcripts, as a fallback for a session neither lists — windowed by the
 *    time of their last message, never by file mtime. Claude appends metadata
 *    records (cost, titles, modes) to OLD transcripts, which touches their mtime:
 *    on 2026-09-28 that made month-old sessions look "waiting" (U3-F2). When the
 *    registry exists, a transcript-only session is a process that has exited,
 *    so it is kept only while it was mid-turn a moment ago (a `-p` run).
 *
 * The transcript still adds what the registry lacks, from a bounded tail read:
 * the branch, which tool is pending (AskUserQuestion is a question, ExitPlanMode
 * a plan, anything else a tool, U3-F5), a final API error (U3-F6), the session's
 * cost (`cost-state`, U3-F27) and pull request (`pr-link`). The title and the
 * last prompt are copied too, capped, with the owner's consent, and since
 * 2026-10-05 the last finished reply: they are free
 * text, and pass the one redaction pass at ingest like every other field.
 * Nothing else from a message is ever copied out.
 */

export type AgentFleetState = 'working' | 'waiting' | 'tool' | 'question' | 'plan' | 'permission' | 'failed';
export type AgentFleetSource = 'registry' | 'job' | 'transcript';
export type AgentOrigin = 'desktop' | 'cli' | 'sdk' | 'bg' | 'other';

export interface AgentFleetSession {
  /** First 8 characters of the session id — stable, and enough to tell sessions apart. */
  id: string;
  /** The whole session id, for `claude --resume`. */
  sid?: string;
  cwd: string;
  branch: string | null;
  /**
   * `waiting`: the turn ended, the agent waits for a new prompt. `permission`: it
   * waits on an approval. `question` / `plan`: it asked the owner something, or
   * wants a plan approved. `tool`: a tool call has no result yet. `failed`: the
   * turn ended on an API error. `working`: mid-turn.
   */
  state: AgentFleetState;
  /** When the current state began — stable while it holds, so an unchanged fleet dedupes at ingest. */
  since: string;
  source: AgentFleetSource;
  origin: AgentOrigin;
  /** The session's name, as Claude shows it. Capped; redacted at ingest. */
  title?: string;
  /** The owner's last prompt in it. Capped; redacted at ingest. */
  lastPrompt?: string;
  /** The agent's last finished reply, so a waiting session says what it is waiting with. Capped; redacted at ingest. */
  lastReply?: string;
  /** List-price estimate from the transcript's `cost-state` record. */
  costUsd?: number;
  lines?: { added: number; removed: number };
  pr?: { number: number; url: string };
  /** The API error a failed turn ended on (`rate_limit`, `server_error`, …). */
  error?: string;
  /** The same tool call, input and all, failing this many times in a row at the end of the tail (U3-F33). Only from 3. */
  repeats?: number;
}

/** A session last written longer ago than this is not part of the fleet. */
export const FLEET_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A registry-busy session on one tool call this long is reported as `tool`. */
export const LONG_TOOL_MS = 2 * 60 * 1000;
/** A transcript-only session must have been mid-turn this recently to count. */
export const TRANSCRIPT_LIVE_MS = 30 * 60 * 1000;
/** Most sessions reported, newest first — applied AFTER the stale ones are dropped (U3-F3). */
export const MAX_FLEET = 12;
/** How much of a transcript's end is read. A turn's last records are always in it. */
const TAIL_BYTES = 256 * 1024;
const TITLE_CHARS = 80;
const PROMPT_CHARS = 200;
const REPLY_CHARS = 400;

const cap = (s: unknown, n: number): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.replace(/\s+/g, ' ').trim();
  return t === '' ? undefined : t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const errorToken = (e: unknown): string | undefined => (typeof e === 'string' && /^[a-z_]{2,40}$/.test(e) ? e : undefined);

function strip<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

type Extras = Pick<AgentFleetSession, 'title' | 'lastPrompt' | 'lastReply' | 'costUsd' | 'lines' | 'pr' | 'repeats'>;
/** A pending call to one of these is a subagent at work, not a tool waiting on anything (U3-F9). */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** From this many identical failing calls in a row, the streak is reported. */
const REPEATS_FROM = 3;

/** What a transcript tail says, with no message text in it except the capped title and prompt. */
export interface TailSummary extends Extras {
  cwd: string;
  branch: string | null;
  state: AgentFleetState;
  since: string;
  /** The time of the last user/assistant record: the transcript's own clock, not its mtime. */
  lastAt: string;
  entrypoint: string | null;
  error?: string;
}

/**
 * One pass over the last lines of a transcript. Pure.
 *
 * - The last message is an assistant `tool_use` → `question` for AskUserQuestion,
 *   `plan` for ExitPlanMode, else `tool`; since that record.
 * - The last message is an API error → `failed`.
 * - The last message is an assistant turn that ended → `waiting`, since then.
 * - Anything else (a prompt or a tool result being worked on, a streaming
 *   record) → `working`, since the owner's last prompt.
 */
export function summarizeTail(lines: string[]): TailSummary | null {
  let last: { type: string; ts: string; stop: string | null; tools: string[]; apiError: string | null } | null = null;
  let promptAt: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let entrypoint: string | null = null;
  let named: string | undefined;
  let aiTitle: string | undefined;
  const meta: Extras = {};
  // The failing-call streak: compared in memory, never copied out.
  let lastCall: string | null = null;
  let pendingCall: string | null = null;
  let streak = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.type === 'custom-title' || r.type === 'agent-name') named = cap(r.customTitle ?? r.agentName, TITLE_CHARS) ?? named;
    else if (r.type === 'ai-title') aiTitle = cap(r.aiTitle, TITLE_CHARS) ?? aiTitle;
    else if (r.type === 'last-prompt') meta.lastPrompt = cap(r.lastPrompt, PROMPT_CHARS) ?? meta.lastPrompt;
    else if (r.type === 'cost-state') {
      if (typeof r.totalCostUSD === 'number') meta.costUsd = Math.round(r.totalCostUSD * 100) / 100;
      if (typeof r.totalLinesAdded === 'number' && typeof r.totalLinesRemoved === 'number') meta.lines = { added: r.totalLinesAdded, removed: r.totalLinesRemoved };
    } else if (r.type === 'pr-link') {
      if (typeof r.prNumber === 'number' && typeof r.prUrl === 'string') meta.pr = { number: r.prNumber, url: r.prUrl };
    }
    if (r.isSidechain === true || (r.type !== 'user' && r.type !== 'assistant') || typeof r.timestamp !== 'string') continue;
    if (typeof r.cwd === 'string' && r.cwd !== '') {
      cwd = r.cwd;
      branch = typeof r.gitBranch === 'string' && r.gitBranch !== '' ? r.gitBranch : null;
    }
    if (typeof r.entrypoint === 'string') entrypoint = r.entrypoint;
    const message = typeof r.message === 'object' && r.message !== null ? (r.message as Record<string, unknown>) : {};
    const content = Array.isArray(message.content) ? (message.content as { type?: unknown; name?: unknown }[]) : [];
    if (r.type === 'user' && !content.some((c) => c?.type === 'tool_result')) {
      promptAt = r.timestamp;
      lastCall = null;
      streak = 0;
    }
    if (r.type === 'assistant') {
      const call = content.filter((c) => c?.type === 'tool_use').map((c) => JSON.stringify([c.name, (c as { input?: unknown }).input]));
      if (call.length > 0) pendingCall = call.join('\n');
    } else if (pendingCall !== null && content.some((c) => c?.type === 'tool_result')) {
      const failed = content.some((c) => c?.type === 'tool_result' && (c as { is_error?: unknown }).is_error === true);
      streak = failed ? (pendingCall === lastCall ? streak + 1 : 1) : 0;
      lastCall = failed ? pendingCall : null;
      pendingCall = null;
    }
    if (r.type === 'assistant' && message.stop_reason === 'end_turn') {
      const said = content.filter((c) => c?.type === 'text').map((c) => (c as { text?: unknown }).text).filter((t): t is string => typeof t === 'string').join(' ');
      meta.lastReply = cap(said, REPLY_CHARS) ?? meta.lastReply;
    }
    last = {
      type: r.type,
      ts: r.timestamp,
      stop: typeof message.stop_reason === 'string' ? message.stop_reason : null,
      tools: content.filter((c) => c?.type === 'tool_use' && typeof c.name === 'string').map((c) => c.name as string),
      apiError: r.isApiErrorMessage === true ? (errorToken(r.error) ?? 'api_error') : null,
    };
  }
  if (!last || !cwd) return null;
  const base = { cwd, branch, lastAt: last.ts, entrypoint, ...strip({ ...meta, title: named ?? aiTitle, repeats: streak >= REPEATS_FROM ? streak : undefined }) };
  if (last.apiError) return { ...base, state: 'failed', since: last.ts, error: last.apiError };
  if (last.type === 'assistant' && last.stop === 'tool_use' && last.tools.every((t) => SUBAGENT_TOOLS.has(t))) return { ...base, state: 'working', since: promptAt ?? last.ts };
  if (last.type === 'assistant' && last.stop === 'tool_use') {
    const state = last.tools.includes('AskUserQuestion') ? 'question' : last.tools.includes('ExitPlanMode') ? 'plan' : 'tool';
    return { ...base, state, since: last.ts };
  }
  if (last.type === 'assistant' && last.stop !== null) return { ...base, state: 'waiting', since: last.ts };
  return { ...base, state: 'working', since: promptAt ?? last.ts };
}

/** The transcript's view alone: where, and in which state since when. */
export function classifyTail(lines: string[]): Pick<TailSummary, 'cwd' | 'branch' | 'state' | 'since'> | null {
  const s = summarizeTail(lines);
  return s && { cwd: s.cwd, branch: s.branch, state: s.state, since: s.since };
}

function readTail(file: string): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
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

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const iso = (v: unknown): string | null => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** `kill(pid, 0)`: true when the process exists (EPERM: it exists, and is someone else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Who started a session (U3-F12): the desktop app, a terminal, a script, or Claude's background supervisor. */
export function originOf(entrypoint: string | null): AgentOrigin {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  if (entrypoint?.startsWith('sdk')) return 'sdk';
  return 'other';
}

/** A registry entry's own state: `waitingFor` names what it waits on; `idle` is a finished turn. */
export function registryState(status: unknown, waitingFor: unknown): AgentFleetState | null {
  if (status === 'busy') return 'working';
  if (status === 'idle') return 'waiting';
  if (status !== 'waiting') return null;
  return typeof waitingFor === 'string' && /permission|sandbox|worker/i.test(waitingFor) ? 'permission' : 'question';
}

/** A background job's state (the `claude agents --json` vocabulary). `stopped` is not in the fleet. */
export function jobState(state: unknown, detail: unknown): AgentFleetState | null {
  if (state === 'working') return 'working';
  if (state === 'blocked') return typeof detail === 'string' && /permission|approv/i.test(detail) ? 'permission' : 'question';
  if (state === 'done') return 'waiting';
  if (state === 'failed') return 'failed';
  return null;
}

/** The registry's state, refined by what only the transcript knows: a plan behind "input needed", a turn that died on an API error. */
function refine(own: AgentFleetState, tail: TailSummary | null, now: number): AgentFleetState {
  if (!tail) return own;
  if ((own === 'question' || own === 'working') && tail.state === 'plan') return 'plan';
  if (own === 'working' && tail.state === 'question') return 'question';
  // Busy on one tool call for minutes: the registry has ruled out an approval, so it may be stuck (U3-F32).
  // Shorter calls stay `working`, so a busy session does not flip state at every call.
  if (own === 'working' && tail.state === 'tool' && now - Date.parse(tail.since) >= LONG_TOOL_MS) return 'tool';
  if (own === 'waiting' && tail.state === 'failed') return 'failed';
  return own;
}

export interface FleetOptions {
  pidAlive?: (pid: number) => boolean;
  /** Sundial's own Claude hands (`.daemon/hands`) are Gnomon's work, not the owner's. */
  skip?: string;
}

/**
 * lane C (use case 19): a session that is no longer live but ended inside the
 * fleet window with a cost or a PR on record. Claude writes `cost-state` when a
 * session ends or resumes, which is after the live fleet has let it go, so
 * without this the log never holds a finished session's cost.
 */
export type EndedSession = Pick<AgentFleetSession, 'id' | 'sid' | 'cwd' | 'branch' | 'costUsd' | 'lines' | 'pr'> & { lastAt: string };

export interface FleetSample {
  sessions: AgentFleetSession[];
  /** Live sessions left out by `MAX_FLEET`. */
  truncated: number;
  /** Absent when empty, so an unchanged fleet stays the same payload. */
  ended?: EndedSession[];
}

/** The fleet, newest first. `claudeDir` is `~/.claude`; injectable for tests. */
export function readAgentFleet(now: number = Date.now(), claudeDir: string = path.join(os.homedir(), '.claude'), options: FleetOptions = {}): FleetSample {
  const alive = options.pidAlive ?? pidAlive;
  const skip = options.skip ?? `${path.sep}.daemon${path.sep}hands`;
  const projects = path.join(claudeDir, 'projects');
  const projectDirs = list(projects);
  const transcriptOf = (sessionId: string): string | null => {
    for (const dir of projectDirs) {
      const file = path.join(projects, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };
  const tailOf = (file: string | null): TailSummary | null => {
    try {
      return file ? summarizeTail(readTail(file)) : null;
    } catch {
      return null;
    }
  };
  const extras = (tail: TailSummary | null): Extras => (tail ? strip({ title: tail.title, lastPrompt: tail.lastPrompt, lastReply: tail.lastReply, costUsd: tail.costUsd, lines: tail.lines, pr: tail.pr, repeats: tail.repeats }) : {});
  const out = new Map<string, AgentFleetSession>();
  const ended: EndedSession[] = [];
  const add = (sessionId: string, s: AgentFleetSession) => {
    // The whole id rides along for `claude --resume` (U2-F32); it is a UUID, not content.
    if (!s.cwd.includes(skip)) out.set(sessionId, strip({ ...s, sid: sessionId }));
  };

  // 1. The live registry.
  const sessionsDir = path.join(claudeDir, 'sessions');
  const registryExists = fs.existsSync(sessionsDir);
  for (const entry of list(sessionsDir)) {
    if (!entry.endsWith('.json')) continue;
    const r = readJson(path.join(sessionsDir, entry));
    if (!r || typeof r.sessionId !== 'string' || typeof r.cwd !== 'string' || typeof r.pid !== 'number') continue;
    const updatedAt = iso(r.updatedAt) ?? iso(r.statusUpdatedAt);
    const probe = r.pidDomain === undefined || r.pidDomain === process.platform;
    if (!(probe ? alive(r.pid) : updatedAt !== null && now - Date.parse(updatedAt) <= FLEET_WINDOW_MS)) continue;
    const own = registryState(r.status, r.waitingFor);
    if (!own) continue;
    const tail = tailOf(transcriptOf(r.sessionId));
    const state = refine(own, tail, now);
    add(r.sessionId, {
      id: r.sessionId.slice(0, 8),
      cwd: r.cwd,
      branch: tail?.branch ?? null,
      state,
      since: (state === own ? (iso(r.statusUpdatedAt) ?? updatedAt) : tail?.since) ?? new Date(now).toISOString(),
      source: 'registry',
      origin: originOf(typeof r.entrypoint === 'string' ? r.entrypoint : null),
      ...extras(tail),
      title: cap(r.name, TITLE_CHARS) ?? tail?.title,
      error: state === 'failed' ? tail?.error : undefined,
    });
  }

  // 2. Background jobs. A job whose session the registry already has keeps the registry's state, labelled bg.
  const jobsDir = path.join(claudeDir, 'jobs');
  for (const entry of list(jobsDir)) {
    const j = readJson(path.join(jobsDir, entry, 'state.json'));
    if (!j || typeof j.sessionId !== 'string' || typeof j.cwd !== 'string') continue;
    const known = out.get(j.sessionId);
    if (known) {
      known.origin = 'bg';
      continue;
    }
    const updatedAt = iso(j.updatedAt);
    const state = jobState(j.state, j.detail);
    if (!updatedAt || !state || now - Date.parse(updatedAt) > FLEET_WINDOW_MS) continue;
    const tail = tailOf(transcriptOf(j.sessionId));
    add(j.sessionId, { id: j.sessionId.slice(0, 8), cwd: j.cwd, branch: tail?.branch ?? null, state, since: updatedAt, source: 'job', origin: 'bg', ...extras(tail), title: cap(j.name, TITLE_CHARS) ?? tail?.title });
  }

  // 3. Transcripts neither lists. The mtime only pre-filters (no record is newer than its file); the window is the record's own time.
  for (const dir of projectDirs) {
    for (const entry of list(path.join(projects, dir))) {
      if (!entry.endsWith('.jsonl')) continue;
      const sessionId = entry.slice(0, -'.jsonl'.length);
      if (out.has(sessionId)) continue;
      const file = path.join(projects, dir, entry);
      try {
        const { mtimeMs, size } = fs.statSync(file);
        if (now - mtimeMs > FLEET_WINDOW_MS || size === 0) continue;
      } catch {
        continue;
      }
      const tail = tailOf(file);
      if (!tail) continue;
      const age = now - Date.parse(tail.lastAt);
      // With a registry, a session missing from it has no process: only a turn cut off moments ago is still news.
      if (registryExists ? tail.state === 'waiting' || age > TRANSCRIPT_LIVE_MS : age > FLEET_WINDOW_MS) {
        if (age <= FLEET_WINDOW_MS && (tail.costUsd !== undefined || tail.pr) && !tail.cwd.includes(skip))
          ended.push(strip({ id: sessionId.slice(0, 8), sid: sessionId, cwd: tail.cwd, branch: tail.branch, lastAt: tail.lastAt, costUsd: tail.costUsd, lines: tail.lines, pr: tail.pr }));
        continue;
      }
      add(sessionId, { id: sessionId.slice(0, 8), cwd: tail.cwd, branch: tail.branch, state: tail.state, since: tail.since, source: 'transcript', origin: originOf(tail.entrypoint), ...extras(tail), error: tail.error });
    }
  }

  const ranked = [...out.values()].sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  const done = ended.sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_FLEET);
  return { sessions: ranked.slice(0, MAX_FLEET), truncated: Math.max(0, ranked.length - MAX_FLEET), ...(done.length > 0 ? { ended: done } : {}) };
}

type FleetEvent = { type: 'agent:fleet'; payload: { timestamp: string; sessions: AgentFleetSession[]; truncated?: number; ended?: EndedSession[] } };

/** Polled like `AgentSessionSensor`: self-gated, stateless beyond the rate limit; the dedupe lives in `state.observed`. */
export class AgentFleetSensor {
  private lastPollAt = 0;
  private last: FleetEvent | null = null;

  poll(now: number = Date.now()): FleetEvent {
    if (this.last && now - this.lastPollAt < 15_000) return this.last;
    this.lastPollAt = now;
    const { sessions, truncated, ended } = readAgentFleet(now);
    // Sorted by id so the same fleet is the same payload whatever order the files were written in.
    sessions.sort((a, b) => a.id.localeCompare(b.id));
    this.last = { type: 'agent:fleet', payload: { timestamp: new Date(now).toISOString(), sessions, ...(truncated > 0 ? { truncated } : {}), ...(ended ? { ended } : {}) } };
    return this.last;
  }
}
