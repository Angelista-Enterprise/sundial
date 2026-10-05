import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSundialHome } from '@sundial/helpers/config.js';

/**
 * What the owner asked each coding agent, and what it answered (2026-10-05).
 *
 * The fleet sees a session's state and its last 200 characters of prompt; it
 * cannot see the intent behind a day of commits, what an agent already tried
 * and dropped, or what a waiting session is actually blocked on. Every big
 * coding agent already writes its whole conversation to disk, so this sensor
 * tails those files directly rather than having a hook carry text. A hook
 * would only say "this session grew", and only Claude has one.
 *
 * Kept, per turn: the owner's typed prompt, the agent's FINAL reply to it, and
 * a tool use the owner rejected or a turn they interrupted. Never a tool's
 * input or output, never thinking, never an injected system or command block:
 * those are where pasted secrets and file contents live, and none of them is
 * intent. The text is capped and goes through the one redaction pass at ingest
 * as `text`, like every other free-text field, before anything is persisted.
 *
 * One reader per agent, each tolerant of records it does not know, because
 * none of these formats is a documented API:
 *
 * - Claude Code: `~/.claude/projects/<dir>/<sid>.jsonl`; a reply is an
 *   assistant record that ended its turn (`stop_reason: end_turn`).
 * - Codex CLI: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; `session_meta`
 *   carries cwd and branch, `task_complete.last_agent_message` the reply.
 * - Gemini CLI: `~/.gemini/tmp/<project>/chats/session-*.json(l)`; the folder's
 *   `.project_root` names the cwd. A legacy `.json` is rewritten whole, so its
 *   cursor counts messages rather than bytes.
 * - Copilot CLI: `~/.copilot/session-state/<sid>/events.jsonl`.
 * - Cursor: `~/.cursor/projects/<dir>/agent-transcripts/<sid>/<sid>.jsonl`; no
 *   timestamps and no cwd, so the time is the file's and the cwd is the
 *   folder name decoded against the disk.
 * - opencode: its SQLite store, read with `sqlite3 -readonly` like Mail's.
 *
 * Only Claude and Codex mark the end of a turn. For the others the newest
 * assistant text is held and logged as the reply once the owner prompts again
 * or the session has been quiet for `QUIET_MS`.
 *
 * Restarts: a byte (or message) cursor per file is kept in
 * `.daemon/agent-turns.json`, so a turn typed while Sundial was down is read
 * on the next boot (a held reply not yet logged is the one thing lost). A
 * file born after the cursor was written is read from its start. An older one
 * is tailed from its end, and its earlier turns are read once by `backfill`,
 * but only while it is in the window: a live session's first prompt is in the
 * record, a session that ended last month is not imported.
 */

export type AgentName = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'opencode';
export type TurnRole = 'prompt' | 'reply' | 'rejected';

export interface AgentTurnPayload {
  timestamp: string;
  agent: AgentName;
  /** First 8 characters of the session id, as the fleet and the hooks name a session. */
  session: string;
  sid: string;
  cwd: string | null;
  branch?: string;
  role: TurnRole;
  /** Capped; redacted at ingest. */
  text: string;
  /** For a rejection: the tool the owner said no to. */
  tool?: string;
}

export interface AgentTurnEvent {
  type: 'agent:turn';
  ts: string;
  payload: AgentTurnPayload;
}

/** Longest text kept from one turn. A prompt's p90 was 6 KB of pasted logs, a reply's 2 KB. */
export const TURN_CHARS = 2000;
/** A held reply with no turn-end marker is logged after the session is this quiet. */
export const QUIET_MS = 60_000;
/** Files last written longer ago than this are not polled. */
const WINDOW_MS = 6 * 60 * 60 * 1000;
/** Most bytes read from one file in one poll. A longer run is skipped, never half-parsed. */
const MAX_READ = 8 * 1024 * 1024;
/** Sundial's own Claude hands are Gnomon's work, not the owner's. */
const HANDS = `${path.sep}.daemon${path.sep}hands`;
/** Files backfilled per poll, and how much of each: the first prompt is at the start. */
const BACKFILL_FILES = 2;
const BACKFILL_BYTES = 16 * 1024 * 1024;
/** How far back the backfill reads, and how long a file's cursor is kept. */
const HISTORY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The transcripts of the Claude sessions running now, from Claude's own live
 * registry: a session can wait on the owner for hours without writing, so its
 * file falls out of the window, and its first prompt is what an audit needs.
 */
function liveClaudeFiles(home: string): string[] {
  const dir = path.join(home, '.claude', 'sessions');
  const projects = path.join(home, '.claude', 'projects');
  const sids = list(dir).flatMap((f) => {
    try {
      const sid = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { sessionId?: unknown }).sessionId;
      return typeof sid === 'string' ? [sid] : [];
    } catch {
      return [];
    }
  });
  const dirs = list(projects);
  return sids.flatMap((sid) => dirs.map((d) => path.join(projects, d, `${sid}.jsonl`)).filter((f) => fs.existsSync(f)).slice(0, 1));
}

/** Which agent wrote a transcript, by where it lives. */
const sourceOf = (file: string): AgentName | null =>
  file.includes(`${path.sep}.claude${path.sep}projects${path.sep}`) ? 'claude'
  : file.includes(`${path.sep}sessions${path.sep}`) && path.basename(file).startsWith('rollout-') ? 'codex'
  : file.includes(`${path.sep}.gemini${path.sep}`) ? 'gemini'
  : file.endsWith(`${path.sep}events.jsonl`) ? 'copilot'
  : file.includes(`${path.sep}agent-transcripts${path.sep}`) ? 'cursor'
  : null;

/** The parsed records of a file's first `bytes`, whole lines only. */
function readHead(file: string, bytes: number): Record<string, unknown>[] {
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, bytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}

const capText = (s: string): string => {
  const t = s.replace(/\r\n/g, '\n').trim();
  return t.length > TURN_CHARS ? `${t.slice(0, TURN_CHARS - 1)}…` : t;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && (c.type === undefined || c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') ? str(c.text) : ''))
    .filter((t) => t !== '' && !t.trimStart().startsWith('<'))
    .join('\n');
};
/** An injected block (`<command-name>`, `<system-reminder>`, `<task-notification>`), not something the owner typed. */
const injected = (t: string): boolean => /^\s*<[a-z][\w-]*>/i.test(t);

/** What a reader carries from one record to the next in a file. */
export interface FileCtx {
  sid: string;
  cwd: string | null;
  branch?: string;
  /** The last tool an agent called, so a rejection can name it. */
  lastTool?: string;
  /** Gemini upserts a message by id: a prompt already logged is not logged again. */
  seen?: Set<string>;
}

/** One reader's verdict on one record. `held`: a reply that waits for the turn to end. */
export type Found = { role: TurnRole; text: string; at?: string; tool?: string; held?: boolean };

export type RecordReader = (r: Record<string, unknown>, ctx: FileCtx) => Found[];

const REJECTED = "doesn't want to proceed with this tool use";

export const readClaude: RecordReader = (r, ctx) => {
  if (typeof r.sessionId === 'string') ctx.sid = r.sessionId;
  if (typeof r.cwd === 'string' && r.cwd !== '') ctx.cwd = r.cwd;
  if (typeof r.gitBranch === 'string' && r.gitBranch !== '') ctx.branch = r.gitBranch;
  if (r.isSidechain === true || r.isMeta === true || r.isCompactSummary === true || r.isApiErrorMessage === true) return [];
  const message = (r.message ?? {}) as Record<string, unknown>;
  const content = message.content;
  const at = str(r.timestamp) || undefined;
  if (r.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as Record<string, unknown>[]) if (c?.type === 'tool_use' && typeof c.name === 'string') ctx.lastTool = c.name;
    const text = textOf(content);
    return message.stop_reason === 'end_turn' && text.trim() !== '' ? [{ role: 'reply', text, at }] : [];
  }
  if (r.type !== 'user') return [];
  if (Array.isArray(content) && content.some((c) => (c as Record<string, unknown>)?.type === 'tool_result')) {
    const results = (content as Record<string, unknown>[]).filter((c) => c?.type === 'tool_result');
    const said = results.map((c) => textOf(c.content) || str(c.content)).find((t) => t.includes(REJECTED));
    if (said === undefined) return [];
    // "… the user said:\n<reason>" when the owner typed why.
    const reason = said.split(/the user said:\s*/i)[1] ?? '';
    return [{ role: 'rejected', text: reason, at, tool: ctx.lastTool }];
  }
  const text = textOf(content);
  if (text.trim() === '' || injected(text)) return [];
  if (text.startsWith('[Request interrupted by user')) return [{ role: 'rejected', text: '', at, tool: text.includes('tool use') ? ctx.lastTool : undefined }];
  return [{ role: 'prompt', text, at }];
};

export const readCodex: RecordReader = (r, ctx) => {
  const p = (r.payload ?? {}) as Record<string, unknown>;
  const at = str(r.timestamp) || undefined;
  if (r.type === 'session_meta') {
    ctx.sid = str(p.id) || ctx.sid;
    ctx.cwd = str(p.cwd) || ctx.cwd;
    const branch = str((p.git as Record<string, unknown> | undefined)?.branch);
    if (branch) ctx.branch = branch;
    return [];
  }
  if (r.type === 'turn_context') {
    ctx.cwd = str(p.cwd) || ctx.cwd;
    return [];
  }
  if (r.type === 'response_item' && p.type === 'function_call' && typeof p.name === 'string') ctx.lastTool = p.name;
  if (r.type !== 'event_msg') return [];
  if (p.type === 'user_message') {
    const text = str(p.message);
    return text.trim() === '' || injected(text) ? [] : [{ role: 'prompt', text, at }];
  }
  if (p.type === 'agent_message' && str(p.message).trim() !== '') return [{ role: 'reply', text: str(p.message), at, held: true }];
  if (p.type === 'task_complete' && str(p.last_agent_message).trim() !== '') return [{ role: 'reply', text: str(p.last_agent_message), at }];
  if (p.type === 'turn_aborted') return [{ role: 'rejected', text: '', at }];
  return [];
};

export const readGemini: RecordReader = (r, ctx) => {
  if (typeof r.sessionId === 'string') ctx.sid = r.sessionId;
  const at = str(r.timestamp) || undefined;
  if (Array.isArray(r.toolCalls)) for (const c of r.toolCalls as Record<string, unknown>[]) if (typeof c?.name === 'string') ctx.lastTool = c.name;
  const text = textOf(r.content);
  if (text.trim() === '') return [];
  if (r.type === 'user') {
    const id = str(r.id);
    if (id && ctx.seen?.has(id)) return [];
    if (id) (ctx.seen ??= new Set()).add(id);
    return injected(text) ? [] : [{ role: 'prompt', text, at }];
  }
  if (r.type === 'gemini') return [{ role: 'reply', text, at, held: true }];
  return [];
};

export const readCopilot: RecordReader = (r, ctx) => {
  const d = (r.data ?? {}) as Record<string, unknown>;
  const at = str(r.timestamp) || undefined;
  if (r.type === 'session.start') {
    const c = (d.context ?? d) as Record<string, unknown>;
    ctx.sid = str(d.sessionId) || ctx.sid;
    ctx.cwd = str(c.cwd) || ctx.cwd;
    if (str(c.branch)) ctx.branch = str(c.branch);
    return [];
  }
  if (r.type === 'tool.execution_start' && typeof d.toolName === 'string') ctx.lastTool = d.toolName;
  if (r.type === 'user.message') {
    const text = str(d.content).replace(/<current_datetime>[\s\S]*?<\/current_datetime>/g, '');
    return text.trim() === '' || injected(text) ? [] : [{ role: 'prompt', text, at }];
  }
  // A subagent's message rides in the same file; only the main conversation is the owner's.
  if (r.type === 'assistant.message' && !d.parentToolCallId && str(d.content).trim() !== '') return [{ role: 'reply', text: str(d.content), at, held: true }];
  if (r.type === 'abort') return [{ role: 'rejected', text: '', at }];
  return [];
};

export const readCursor: RecordReader = (r) => {
  const content = (r.message as Record<string, unknown> | undefined)?.content;
  const text = textOf(content);
  if (r.role === 'user') {
    // The typed words are wrapped in <user_query>, beside attached files and skills.
    const raw = Array.isArray(content) ? content.map((c) => str((c as Record<string, unknown>)?.text)).join('\n') : str(content);
    const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? (injected(raw) ? '' : raw);
    return query.trim() === '' ? [] : [{ role: 'prompt', text: query }];
  }
  if (r.role === 'assistant' && text.trim() !== '') return [{ role: 'reply', text, held: true }];
  return [];
};

const decoded = new Map<string, string | null>();
/**
 * Cursor (like Claude) names a project folder by its path with `/` turned into
 * `-`, which loses the hyphens that were already there. Walk the disk to find
 * the one real directory the name spells. Null when none exists.
 */
export function decodeDashedPath(name: string, exists: (p: string) => boolean = fs.existsSync): string | null {
  if (decoded.has(name)) return decoded.get(name)!;
  const parts = name.split('-').filter((s) => s !== '');
  const walk = (at: string, i: number): string | null => {
    if (i === parts.length) return at;
    for (let j = parts.length; j > i; j--) {
      const next = path.join(at, parts.slice(i, j).join('-'));
      if (exists(next)) {
        const done = walk(next, j);
        if (done) return done;
      }
    }
    return null;
  };
  const out = parts.length > 0 ? walk(path.sep, 0) : null;
  decoded.set(name, out);
  return out;
}

const list = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const mtimeOf = (file: string): number | null => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

interface Source {
  agent: AgentName;
  read: RecordReader;
  /** Every transcript file of this agent, with what is known before reading it. */
  files(home: string, now: number): { file: string; ctx: FileCtx }[];
}

const fresh = (file: string, now: number, window = WINDOW_MS) => {
  const m = mtimeOf(file);
  return m !== null && now - m <= window;
};
const stem = (file: string) => path.basename(file).replace(/\.jsonl?$/, '');

export const SOURCES: Source[] = [
  {
    agent: 'claude',
    read: readClaude,
    files: (home, now) => {
      const root = path.join(home, '.claude', 'projects');
      return list(root).flatMap((dir) =>
        list(path.join(root, dir))
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(root, dir, f))
          .filter((f) => fresh(f, now))
          .map((file) => ({ file, ctx: { sid: stem(file), cwd: null } })),
      );
    },
  },
  {
    agent: 'codex',
    read: readCodex,
    files: (home, now) => {
      const root = path.join(process.env.CODEX_HOME ?? path.join(home, '.codex'), 'sessions');
      const out: { file: string; ctx: FileCtx }[] = [];
      // YYYY/MM/DD folders: only days that can hold a file written inside the window.
      for (const y of list(root))
        for (const m of list(path.join(root, y)))
          for (const d of list(path.join(root, y, m))) {
            const dir = path.join(root, y, m, d);
            const m2 = mtimeOf(dir);
            if (m2 === null || now - m2 > 7 * 86_400_000) continue;
            for (const f of list(dir)) if (f.endsWith('.jsonl') && fresh(path.join(dir, f), now)) out.push({ file: path.join(dir, f), ctx: { sid: stem(f).replace(/^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, ''), cwd: null } });
          }
      return out;
    },
  },
  {
    agent: 'gemini',
    read: readGemini,
    files: (home, now) => {
      const root = path.join(home, '.gemini', 'tmp');
      return list(root).flatMap((dir) => {
        let cwd: string | null = null;
        try {
          cwd = fs.readFileSync(path.join(root, dir, '.project_root'), 'utf8').trim() || null;
        } catch {
          /* an older install names the folder by a hash only */
        }
        const chats = path.join(root, dir, 'chats');
        return list(chats)
          .filter((f) => /^session-.*\.jsonl?$/.test(f) && fresh(path.join(chats, f), now))
          .map((f) => ({ file: path.join(chats, f), ctx: { sid: stem(f), cwd } }));
      });
    },
  },
  {
    agent: 'copilot',
    read: readCopilot,
    files: (home, now) => {
      const root = path.join(process.env.COPILOT_HOME ?? path.join(home, '.copilot'), 'session-state');
      return list(root)
        .map((sid) => ({ sid, file: path.join(root, sid, 'events.jsonl') }))
        .filter(({ file }) => fresh(file, now))
        .map(({ sid, file }) => {
          let cwd: string | null = null;
          try {
            cwd = fs.readFileSync(path.join(root, sid, 'workspace.yaml'), 'utf8').match(/^cwd:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? null;
          } catch {
            /* session.start carries it too */
          }
          return { file, ctx: { sid, cwd } };
        });
    },
  },
  {
    agent: 'cursor',
    read: readCursor,
    files: (home, now) => {
      const root = path.join(home, '.cursor', 'projects');
      return list(root).flatMap((dir) => {
        const transcripts = path.join(root, dir, 'agent-transcripts');
        return list(transcripts)
          .map((sid) => ({ sid, file: path.join(transcripts, sid, `${sid}.jsonl`) }))
          .filter(({ file }) => fresh(file, now))
          .map(({ sid, file }) => ({ file, ctx: { sid, cwd: decodeDashedPath(dir) } }));
      });
    },
  },
];

interface Cursor {
  /** Bytes read, or for a whole-file `.json`, messages read. */
  offset: number;
  /** The read stopped inside an over-long line: drop up to the next newline. */
  skip?: boolean;
}
interface CursorFile {
  v?: 2;
  savedAt: number;
  files: Record<string, Cursor>;
  /** opencode: the newest message time read, epoch ms. */
  opencode?: number;
  /** Files whose turns before the time given (epoch ms) are still to be read once, by `backfill`. */
  backfill?: Record<string, number>;
}

/** Tails every agent's transcripts. `home` and `cursorPath` are injectable for tests. */
export class AgentTurnSensor {
  private lastPollAt = 0;
  private cursors: CursorFile;
  private readonly ctx = new Map<string, FileCtx>();
  private readonly held = new Map<string, { event: AgentTurnEvent; mtime: number }>();
  private readonly startedAt: number;
  private opencodeMtime = 0;

  constructor(
    private readonly options: { enabled?: boolean; home?: string; cursorPath?: string; opencodeDb?: string; now?: number } = {},
  ) {
    this.startedAt = options.now ?? Date.now();
    this.cursors = this.load();
  }

  private get home() {
    return this.options.home ?? os.homedir();
  }
  private get cursorPath() {
    return this.options.cursorPath ?? path.join(getSundialHome(), '.daemon', 'agent-turns.json');
  }

  private load(): CursorFile {
    try {
      const v = JSON.parse(fs.readFileSync(this.cursorPath, 'utf8')) as CursorFile & { v?: number };
      if (v && typeof v.savedAt === 'number' && v.files && typeof v.files === 'object') {
        // A cursor from before the backfill (2026-10-05): every file in it was first read
        // part-way when the cursor file was made, so that is when its history ends.
        if (v.v !== 2) {
          const made = fs.statSync(this.cursorPath).birthtimeMs;
          v.backfill = Object.fromEntries([...Object.keys(v.files), ...liveClaudeFiles(this.home)].map((f) => [f, made]));
        }
        return { ...v, v: 2 } as CursorFile;
      }
    } catch {
      /* first run */
    }
    // No cursor yet: a file first seen from here on is read part-way, and its history by the backfill.
    return { v: 2, savedAt: this.startedAt, files: {}, backfill: Object.fromEntries(liveClaudeFiles(this.home).map((f) => [f, this.startedAt])) } as CursorFile;
  }

  private save(now: number) {
    const dir = path.dirname(this.cursorPath);
    if (!fs.existsSync(dir)) return;
    // Kept a week, not the 6 h window: a session resumed after a quiet afternoon goes on from its offset, and is never backfilled twice.
    const files = Object.fromEntries(Object.entries(this.cursors.files).filter(([f]) => fresh(f, now, HISTORY_MS)));
    this.cursors = { ...this.cursors, savedAt: now, files };
    try {
      fs.writeFileSync(this.cursorPath, JSON.stringify(this.cursors), { mode: 0o600 });
    } catch {
      /* the next poll tries again */
    }
  }

  async poll(now: number = Date.now()): Promise<AgentTurnEvent[]> {
    if (this.options.enabled === false || now - this.lastPollAt < 15_000) return [];
    this.lastPollAt = now;
    const out: AgentTurnEvent[] = [];
    for (const source of SOURCES) {
      for (const { file, ctx } of source.files(this.home, now)) {
        try {
          out.push(...this.tail(source, file, ctx));
        } catch {
          /* one unreadable file never stops the others */
        }
      }
    }
    out.push(...this.backfill(now));
    out.push(...(await this.opencode(now)));
    // A held reply whose session went quiet is the reply.
    for (const [file, h] of this.held) {
      const m = mtimeOf(file) ?? h.mtime;
      if (now - m >= QUIET_MS) {
        out.push(h.event);
        this.held.delete(file);
      }
    }
    this.save(now);
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }

  private emit(agent: AgentName, ctx: FileCtx, f: Found, at: string): AgentTurnEvent | null {
    if (ctx.cwd?.includes(HANDS)) return null;
    const text = capText(f.text);
    if (text === '' && f.role !== 'rejected') return null;
    const payload: AgentTurnPayload = { timestamp: at, agent, session: ctx.sid.slice(0, 8), sid: ctx.sid, cwd: ctx.cwd, role: f.role, text };
    if (ctx.branch) payload.branch = ctx.branch;
    if (f.tool) payload.tool = f.tool;
    return { type: 'agent:turn', ts: at, payload };
  }

  private tail(source: Source, file: string, base: FileCtx): AgentTurnEvent[] {
    const stat = fs.statSync(file);
    let cursor = this.cursors.files[file];
    const ctx = this.ctx.get(file) ?? { ...base };
    this.ctx.set(file, ctx);
    const whole = file.endsWith('.json');
    if (!cursor) {
      // Created since the cursor was written: read it all. Older: from here on.
      const born = stat.birthtimeMs || stat.ctimeMs;
      // -1 for a whole-file .json: its message count is not known until it is parsed.
      const start = born >= this.cursors.savedAt ? 0 : whole ? -1 : stat.size;
      cursor = { offset: start };
      if (start !== 0) (this.cursors.backfill ??= {})[file] = Date.now();
      // Context (sid, cwd, branch) sits in a file's first records: read them once, emit nothing.
      if (start !== 0) this.prime(source, file, ctx);
    }
    const records: Record<string, unknown>[] = [];
    if (whole) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessionId?: unknown; messages?: unknown };
      const messages = Array.isArray(doc.messages) ? (doc.messages as Record<string, unknown>[]) : [];
      if (typeof doc.sessionId === 'string') ctx.sid = doc.sessionId;
      if (cursor.offset < 0 || cursor.offset > messages.length) cursor = { offset: messages.length };
      records.push(...messages.slice(cursor.offset));
      cursor.offset = messages.length;
    } else {
      if (stat.size < cursor.offset) cursor = { offset: 0 };
      if (stat.size > cursor.offset) {
        const length = Math.min(stat.size - cursor.offset, MAX_READ);
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(file, 'r');
        try {
          fs.readSync(fd, buf, 0, length, cursor.offset);
        } finally {
          fs.closeSync(fd);
        }
        // Inside an over-long line: everything up to its newline is dropped.
        const nl = cursor.skip ? buf.indexOf(0x0a) : -1;
        const start = cursor.skip ? (nl < 0 ? length : nl + 1) : 0;
        const end = buf.lastIndexOf(0x0a);
        if (end < start) {
          // No whole line. Still in (or newly at) a record bigger than a read, a tool's output: skip it. Else a half-written line waits.
          cursor = (cursor.skip && nl < 0) || length === MAX_READ ? { offset: cursor.offset + length, skip: true } : { offset: cursor.offset + start };
        } else {
          for (const line of buf.subarray(start, end + 1).toString('utf8').split('\n')) {
            if (!line.startsWith('{')) continue;
            try {
              records.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              /* a line this reader cannot parse is skipped */
            }
          }
          cursor = { offset: cursor.offset + end + 1 };
        }
      }
    }
    this.cursors.files[file] = cursor;
    const fileAt = new Date(stat.mtimeMs).toISOString();
    const out: AgentTurnEvent[] = [];
    for (const r of records) {
      for (const f of source.read(r, ctx)) {
        const at = f.at && !Number.isNaN(Date.parse(f.at)) ? new Date(f.at).toISOString() : fileAt;
        const event = this.emit(source.agent, ctx, f, at);
        if (!event) continue;
        if (f.role === 'reply' && f.held) {
          this.held.set(file, { event, mtime: stat.mtimeMs });
          continue;
        }
        // A prompt ends the turn before it: its held reply goes first. A final reply replaces it.
        const pending = this.held.get(file);
        this.held.delete(file);
        if (pending && f.role !== 'reply') out.push(pending.event);
        out.push(event);
      }
    }
    return out;
  }

  /**
   * The turns a file held before it was first read, for the sessions still in
   * the window: an audit of today's agents needs each one's FIRST prompt, and a
   * session opened yesterday had it before this sensor existed. A few files a
   * poll, the first 32 MB of each (the start is what is missing), only records
   * that carry their own time (so not Cursor's). Then the mark is dropped.
   */
  private backfill(now: number): AgentTurnEvent[] {
    const out: AgentTurnEvent[] = [];
    const queue = this.cursors.backfill ?? {};
    for (const [file, before] of Object.entries(queue).slice(0, BACKFILL_FILES)) {
      delete queue[file];
      const source = SOURCES.find((s) => s.agent === sourceOf(file));
      if (!source) continue;
      try {
        const whole = file.endsWith('.json');
        const records = whole ? ((JSON.parse(fs.readFileSync(file, 'utf8')) as { messages?: unknown }).messages as Record<string, unknown>[] | undefined) ?? [] : readHead(file, BACKFILL_BYTES);
        const ctx: FileCtx = { ...(this.ctx.get(file) ?? { sid: stem(file).replace(/^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, ''), cwd: null }) };
        delete ctx.lastTool;
        let held: AgentTurnEvent | null = null;
        for (const r of records) {
          for (const f of source.read(r, ctx)) {
            const at = f.at ? Date.parse(f.at) : NaN;
            // Only what the record never held: before the file was first read, inside the week.
            if (Number.isNaN(at) || at >= before || at < now - HISTORY_MS) continue;
            const event = this.emit(source.agent, ctx, f, new Date(at).toISOString());
            if (!event) continue;
            if (f.role === 'reply' && f.held) {
              held = event;
              continue;
            }
            if (held && f.role !== 'reply') out.push(held);
            held = null;
            out.push(event);
          }
        }
        if (held) out.push(held);
        // A file read only by the backfill is tailed from here when it grows again.
        this.cursors.files[file] ??= { offset: whole ? records.length : fs.statSync(file).size };
      } catch {
        /* a history that cannot be read stays unread */
      }
    }
    return out;
  }

  /** Read a file's head for its context only. */
  private prime(source: Source, file: string, ctx: FileCtx) {
    if (file.endsWith('.json')) return;
    let head: string;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = head.split('\n');
    lines.pop();
    for (const line of lines) {
      try {
        source.read(JSON.parse(line) as Record<string, unknown>, ctx);
      } catch {
        /* skip */
      }
    }
    delete ctx.lastTool;
  }

  /** opencode keeps its conversation in SQLite: messages newer than the cursor, with their text parts. */
  private async opencode(now: number): Promise<AgentTurnEvent[]> {
    const db = this.options.opencodeDb ?? path.join(this.home, '.local', 'share', 'opencode', 'opencode.db');
    const m = Math.max(mtimeOf(db) ?? 0, mtimeOf(`${db}-wal`) ?? 0);
    if (m === 0 || m === this.opencodeMtime || now - m > WINDOW_MS) return [];
    this.opencodeMtime = m;
    const since = this.cursors.opencode ?? this.cursors.savedAt;
    const sql = `select m.id, m.session_id sid, m.time_created at, s.directory cwd, json_extract(m.data,'$.role') role, json_extract(m.data,'$.finish') finish, (select group_concat(json_extract(p.data,'$.text'), char(10)) from part p where p.message_id = m.id and json_extract(p.data,'$.type') = 'text' and coalesce(json_extract(p.data,'$.synthetic'), 0) = 0) text from message m join session s on s.id = m.session_id where s.parent_id is null and m.time_created > ${Math.floor(since)} and (json_extract(m.data,'$.role') = 'user' or json_extract(m.data,'$.time.completed') is not null) order by m.time_created limit 200`;
    const rows = await new Promise<Record<string, unknown>[]>((resolve) =>
      execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
        try {
          resolve(error ? [] : (JSON.parse(String(stdout) || '[]') as Record<string, unknown>[]));
        } catch {
          resolve([]);
        }
      }),
    );
    const out: AgentTurnEvent[] = [];
    for (const r of rows) {
      const at = typeof r.at === 'number' ? r.at : 0;
      this.cursors.opencode = Math.max(this.cursors.opencode ?? 0, at);
      const text = str(r.text);
      // An assistant message that stopped to call a tool is not the reply.
      const role: TurnRole | null = r.role === 'user' ? (injected(text) ? null : 'prompt') : r.role === 'assistant' && (r.finish === 'stop' || r.finish === 'end_turn') ? 'reply' : null;
      if (!role) continue;
      const event = this.emit('opencode', { sid: str(r.sid), cwd: str(r.cwd) || null }, { role, text }, new Date(at).toISOString());
      if (event) out.push(event);
    }
    return out;
  }
}
