import path from 'node:path';
import { z } from 'zod';
import { getAllSignalsInRange } from '@sundial/db/index.js';
import type { AgentFleetEntry } from '../types.js';
import { RESULT_BUDGET_CHARS, takeWithinBudget } from './evidence-tools.js';
import type { GnomonTool } from './registry.js';

/**
 * Every coding-agent session, in one call (2026-10-05).
 *
 * The first chat that asked for an agent audit had no tool for it, so the model
 * rebuilt the fleet by hand: `ps`, `ls ~/.claude/sessions`, `cat` of every
 * registry file, then `jq` over raw transcripts to learn their format — twelve
 * shell approvals in three minutes, and raw transcript text, tool output and
 * all, sent to the model past the one redaction pass. Everything it was after
 * is already in the record, scrubbed: the fleet (state, since, cost, PR), the
 * `agent:turn` log (every prompt, final reply and rejection, from every agent),
 * the report-only hooks (which files each session edited) and git (commits on
 * the session's branch, the dirty count). This joins them. Pure arithmetic in
 * `buildAgentSessions`; the handler only reads.
 */

export interface TurnRow {
  at: string;
  sid: string;
  session: string;
  agent: string;
  cwd: string | null;
  branch: string | null;
  role: 'prompt' | 'reply' | 'rejected';
  text: string;
  tool: string | null;
}

export interface AgentSessionsInput {
  now: string;
  fleet: AgentFleetEntry[];
  turns: TurnRow[];
  edits: { at: string; session: string; file: string }[];
  commits: { at: string; cwd: string; branch: string | null; line: string }[];
  status: { at: string; cwd: string; dirtyFiles: number }[];
  /** The first `agent:turn` in the whole log: before it, the record holds no prompt. */
  logStart: string | null;
}

/** A transcript-only session (any agent) counts while it had a turn this recently. */
export const SEEN_MS = 6 * 60 * 60 * 1000;
const TEXT = 120;
const REPLY = 130;
/**
 * One page holds the whole fleet: twelve live sessions measured 7.4k characters
 * with these caps, and an audit split over two calls is the inefficiency this
 * tool exists to remove. The rest of a session is one `id` call away.
 */
const LIST_BUDGET = 8_000;

const clip = (t: string, n: number) => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
/** Who the session waits on. A finished turn, a question, a plan, an approval, a failure: the owner. */
const waitsOn = (state: string | null) => (state === null ? 'unknown' : state === 'working' || state === 'tool' ? 'itself' : 'you');

export function buildAgentSessions(input: AgentSessionsInput) {
  const now = Date.parse(input.now);
  const bySid = new Map<string, TurnRow[]>();
  for (const t of input.turns) (bySid.get(t.sid) ?? bySid.set(t.sid, []).get(t.sid)!).push(t);
  const sessions = input.fleet.map((f) => ({ f, sid: f.sid ?? [...bySid.keys()].find((k) => k.startsWith(f.id)) ?? f.id }));
  // Sessions the fleet cannot see (Codex, Gemini, Copilot, Cursor, opencode): recent turns only, liveness unknown.
  for (const [sid, rows] of bySid) {
    if (sessions.some((s) => s.sid === sid)) continue;
    const last = rows[rows.length - 1]!;
    if (now - Date.parse(last.at) <= SEEN_MS) sessions.push({ f: null as unknown as AgentFleetEntry, sid });
  }
  const rows = sessions.map(({ f, sid }) => {
    const turns = (bySid.get(sid) ?? []).sort((a, b) => a.at.localeCompare(b.at));
    const prompts = turns.filter((t) => t.role === 'prompt');
    const replies = turns.filter((t) => t.role === 'reply');
    const last = turns[turns.length - 1];
    const cwd = f?.cwd ?? last?.cwd ?? null;
    const branch = f?.branch ?? last?.branch ?? null;
    const id = f?.id ?? sid.slice(0, 8);
    const openedAt = turns[0]?.at ?? null;
    const from = openedAt ?? f?.since ?? input.now;
    const files = [...new Set(input.edits.filter((e) => e.session === id && e.at >= from).map((e) => e.file))];
    const commits = cwd && branch ? input.commits.filter((c) => c.branch === branch && inside(c.cwd, cwd) && c.at >= from) : [];
    const dirty = cwd ? input.status.filter((s) => inside(s.cwd, cwd)).sort((a, b) => b.at.localeCompare(a.at))[0] : undefined;
    const lastPrompt = prompts[prompts.length - 1];
    const lastReply = replies[replies.length - 1]?.text ?? f?.lastReply;
    const state = f?.state ?? null;
    return {
      id,
      agent: last?.agent ?? 'claude',
      project: cwd ? path.basename(cwd) : null,
      branch,
      state: state ?? 'unknown',
      waits: waitsOn(state),
      since: f?.since ?? last?.at ?? null,
      ...(f?.title ? { title: f.title } : {}),
      openedAt,
      firstPrompt: prompts[0] ? clip(prompts[0].text, TEXT) : null,
      ...(lastPrompt && prompts.length > 1 ? { lastPromptAt: lastPrompt.at } : {}),
      ...(lastReply ? { lastReply: clip(lastReply, REPLY) } : {}),
      prompts: prompts.length,
      replies: replies.length,
      ...(turns.some((t) => t.role === 'rejected')
        ? { rejected: turns.filter((t) => t.role === 'rejected').slice(-3).map((t) => ({ at: t.at, ...(t.tool ? { tool: t.tool } : {}), ...(t.text ? { said: clip(t.text, 100) } : {}) })) }
        : {}),
      edited: files.length,
      commits: commits.length,
      ...(commits.length > 0 ? { lastCommit: clip(commits[commits.length - 1]!.line, 60) } : {}),
      ...(dirty ? { dirtyFiles: dirty.dirtyFiles } : {}),
      ...(f?.costUsd !== undefined ? { costUsd: f.costUsd } : {}),
      ...(f?.costUsd !== undefined && commits.length > 0 ? { usdPerCommit: Math.round((f.costUsd / commits.length) * 100) / 100 } : {}),
      ...(f?.lines ? { lines: f.lines } : {}),
      ...(f?.pr ? { pr: f.pr } : {}),
      ...(f?.error ? { error: f.error } : {}),
      ...(f?.repeats ? { repeats: f.repeats } : {}),
    };
  });
  // Waiting on the owner first, longest wait first; then the ones at work.
  rows.sort((a, b) => (a.waits === b.waits ? (a.since ?? '').localeCompare(b.since ?? '') : a.waits === 'you' ? -1 : b.waits === 'you' ? 1 : a.waits === 'itself' ? -1 : 1));
  return rows;
}

/** One session's whole conversation, oldest first. */
export function sessionTurns(turns: TurnRow[], id: string) {
  return turns
    .filter((t) => t.sid === id || t.session === id || t.sid.startsWith(id))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((t) => ({ at: t.at, role: t.role, ...(t.tool ? { tool: t.tool } : {}), text: clip(t.text, 600) }));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const HISTORY_DAYS = 7;

export const AGENT_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_agent_sessions',
    description:
      "Every coding-agent session the owner has open, in ONE call — Claude Code from its live registry, and Codex, Gemini, Copilot, Cursor and opencode from their recent turns. Per session: `state` and `since`, `waits` (`you`: it finished, asked, wants a plan or an approval, or failed; `itself`: it is working), `title`, `firstPrompt` (what the owner asked for, in their words), `lastPromptAt`, `lastReply` (the agent's last finished answer), counts of prompts and replies, `rejected` (a tool use the owner said no to, or a turn they stopped, with what they said), how many files it `edited` (from the hooks), `commits` on its branch since it opened and the `lastCommit`, `dirtyFiles`, `costUsd` and `usdPerCommit` (Claude's own list-price estimate, written when a session ends or resumes, so often absent), `lines`, `pr`. Waiting-on-you comes first, longest wait first. Pass `id` (an 8-character session id) for that session's whole conversation, every prompt, reply and rejection in order, with the files it edited and every commit. Use this for \"what are my agents doing\", \"which session is blocked on me\", \"what did I ask that one\", \"which are safe to close\", \"are two of them on the same problem\". Use it INSTEAD of reading ~/.claude or any agent's files with the shell: those are raw transcripts, never scrubbed of secrets, and every read costs the owner an approval. Everything here is literal from the record; it holds no token counts, and no turn from before `logStart`.",
    schema: {
      id: z.string().min(4).optional().describe("One session's short id: its whole conversation instead of the list"),
      offset: z.number().int().min(0).optional().describe('The `nextOffset` of the previous page'),
    },
    readOnly: true,
    handler: async ({ id, offset }, env) => {
      const now = env.now.toISOString();
      const from = new Date(env.now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
      const state = await env.state();
      const [turnRows, rest, first] = await Promise.all([
        getAllSignalsInRange(from, now, ['agent:turn']),
        getAllSignalsInRange(from, now, ['agent:hook', 'git:commit', 'git:status']),
        getAllSignalsInRange('1970-01-01T00:00:00.000Z', now, ['agent:turn'], undefined, 1).catch(() => []),
      ]);
      const turns: TurnRow[] = turnRows.map((r) => ({
        at: r.capturedAt,
        sid: str(r.data.sid) ?? str(r.data.session) ?? '',
        session: str(r.data.session) ?? '',
        agent: str(r.data.agent) ?? 'unknown',
        cwd: str(r.data.cwd),
        branch: str(r.data.branch),
        role: r.data.role === 'reply' || r.data.role === 'rejected' ? r.data.role : 'prompt',
        text: str(r.data.text) ?? '',
        tool: str(r.data.tool),
      }));
      const start = Math.max(0, Math.floor((offset as number | undefined) ?? 0));
      const logStart = first[0]?.capturedAt ?? null;
      const edits: AgentSessionsInput['edits'] = [];
      const commits: AgentSessionsInput['commits'] = [];
      const status: AgentSessionsInput['status'] = [];
      for (const r of rest) {
        const d = r.data;
        const type = `${r.signalType}:${r.eventType}`;
        if (type === 'agent:hook' && d.event === 'PostToolUse' && str(d.file) && str(d.session)) edits.push({ at: r.capturedAt, session: str(d.session)!, file: str(d.file)! });
        else if (type === 'git:commit' && str(d.cwd)) commits.push({ at: r.capturedAt, cwd: str(d.cwd)!, branch: str(d.branch), line: str(d.commitLine) ?? '' });
        else if (type === 'git:status' && str(d.cwd) && typeof d.dirtyFiles === 'number') status.push({ at: r.capturedAt, cwd: str(d.cwd)!, dirtyFiles: d.dirtyFiles });
      }
      if (id) {
        const short = String(id).slice(0, 8);
        const mine = turns.filter((t) => t.sid.startsWith(short));
        const where = mine.find((t) => t.cwd)?.cwd ?? state?.agent?.fleet?.find((f) => f.id === short)?.cwd ?? null;
        const branch = [...mine].reverse().find((t) => t.branch)?.branch ?? null;
        const opened = mine[0]?.at ?? from;
        const all = sessionTurns(turns, short);
        const { kept } = takeWithinBudget(all.slice(start), RESULT_BUDGET_CHARS - 1200);
        const next = start + kept.length;
        return {
          id: short,
          cwd: where,
          branch,
          logStart,
          files: [...new Set(edits.filter((e) => e.session === short && e.at >= opened).map((e) => e.file))].slice(0, 20),
          commits: where && branch ? commits.filter((c) => c.branch === branch && (c.cwd === where || c.cwd.startsWith(`${where}/`) || where.startsWith(`${c.cwd}/`)) && c.at >= opened).map((c) => clip(c.line, 70)).slice(-10) : [],
          total: all.length,
          turns: kept,
          ...(next < all.length ? { nextOffset: next } : {}),
        };
      }
      const all = buildAgentSessions({ now, fleet: state?.agent?.fleet ?? [], turns, edits, commits, status, logStart });
      const { kept } = takeWithinBudget(all.slice(start), LIST_BUDGET);
      const next = start + kept.length;
      return {
        total: all.length,
        waitingOnYou: all.filter((s) => s.waits === 'you').length,
        logStart,
        sessions: kept,
        ...(next < all.length ? { nextOffset: next } : {}),
        note: 'Literal from the record. No token counts exist here; cost is Claude\'s own estimate when present. A firstPrompt of null means the session began before logStart.',
      };
    },
  },
];
