/**
 * Agent cost and yield (use case 19): what the owner's coding agents cost per
 * project and week, and how many of their sessions ended in a merged PR.
 *
 * Pure, over rows the log already holds:
 * - `agent:fleet` — sessions with an id, their branch, and a cost when Claude
 *   recorded one (live `sessions[]`, and `ended[]` for the ones that finished).
 *   Present from the day the fleet sensor shipped.
 * - `agent:session` — which checkout and branch the focused agent worked on,
 *   with no session id. Older, so it gives branch-level yield further back.
 * - `git:pr-status` — each PR's state by checkout, branch and number.
 *
 * `costUsd` is Claude Code's own list-price estimate from its transcript, not a
 * bill, and it is written only when a session ends or resumes, so `costKnown`
 * says for how many sessions the sum stands.
 */
import { localDate } from '@sundial/helpers/local-day.js';

export interface YieldSignal {
  type: string;
  ts: string;
  data: Record<string, unknown>;
}

export interface AgentYieldRow {
  /** Monday of the owner-local week, `YYYY-MM-DD`. */
  week: string;
  project: string;
  /** Sessions with an id (fleet), by the week they were first seen. */
  sessions: number;
  /** Of those, on a branch other than the trunk, or with a PR of their own. */
  onBranch: number;
  merged: number;
  openPr: number;
  costUsd: number | null;
  costKnown: number;
  /** Distinct non-trunk branches an agent worked on THIS week (fleet and `agent:session`), and how many have merged by now. */
  branches: number;
  branchesMerged: number;
}

const TRUNK = /^(main|master|develop|dev|trunk|HEAD)$/;
const DAY_MS = 86_400_000;

function mondayOf(day: string): string {
  const ms = Date.parse(`${day}T12:00:00.000Z`);
  return new Date(ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

/** A checkout's name: its last path segment. */
export function projectOfCwd(cwd: string): string {
  return cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || cwd;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

interface SessionAcc {
  week: string;
  cwd: string;
  branch: string | null;
  cost: number | null;
  pr: number | null;
}

export function agentYield(rows: YieldSignal[], timeZone: string): AgentYieldRow[] {
  const merged = new Set<string>();
  const hasPr = new Set<string>();
  const sessions = new Map<string, SessionAcc>();
  const branches = new Map<string, { week: string; cwd: string; key: string }>(); // one per week it was worked in
  const weekOf = (ts: string) => mondayOf(localDate(ts, timeZone));
  const noteBranch = (cwd: string, branch: string | null, ts: string) => {
    if (!branch || TRUNK.test(branch)) return;
    const week = weekOf(ts);
    branches.set(`${week}|${cwd}|${branch}`, { week, cwd, key: `${cwd}|${branch}` });
  };
  const noteSession = (s: Record<string, unknown>, ts: string) => {
    // The short id: early fleet samples carry no `sid`, and one session must not count twice.
    const id = str(s.id) ?? str(s.sid)?.slice(0, 8) ?? null;
    const cwd = str(s.cwd);
    if (!id || !cwd) return;
    const prior = sessions.get(id);
    const branch = str(s.branch) ?? prior?.branch ?? null;
    const cost = typeof s.costUsd === 'number' ? Math.max(s.costUsd, prior?.cost ?? 0) : (prior?.cost ?? null);
    const pr = typeof (s.pr as { number?: unknown } | undefined)?.number === 'number' ? (s.pr as { number: number }).number : (prior?.pr ?? null);
    sessions.set(id, { week: prior?.week ?? weekOf(ts), cwd, branch, cost, pr });
    noteBranch(cwd, branch, ts);
  };

  for (const row of rows) {
    const d = row.data;
    if (row.type === 'git:pr-status') {
      const cwd = str(d.cwd);
      if (!cwd) continue;
      const keys = [str(d.branch) && `${cwd}|${d.branch}`, typeof d.number === 'number' && `${cwd}|#${d.number}`].filter((k): k is string => typeof k === 'string');
      for (const k of keys) {
        hasPr.add(k);
        if (d.state === 'MERGED') merged.add(k);
      }
    } else if (row.type === 'agent:fleet') {
      for (const s of Array.isArray(d.sessions) ? d.sessions : []) if (s && typeof s === 'object') noteSession(s as Record<string, unknown>, row.ts);
      for (const s of Array.isArray(d.ended) ? d.ended : []) if (s && typeof s === 'object') noteSession(s as Record<string, unknown>, str((s as Record<string, unknown>).lastAt) ?? row.ts);
    } else if (row.type === 'agent:session') {
      const cwd = str(d.cwd);
      if (cwd) noteBranch(cwd, str(d.branch), row.ts);
    }
  }

  const out = new Map<string, AgentYieldRow>();
  const at = (week: string, cwd: string) => {
    const project = projectOfCwd(cwd);
    const key = `${week}|${project}`;
    let r = out.get(key);
    if (!r) out.set(key, (r = { week, project, sessions: 0, onBranch: 0, merged: 0, openPr: 0, costUsd: null, costKnown: 0, branches: 0, branchesMerged: 0 }));
    return r;
  };
  for (const s of sessions.values()) {
    const r = at(s.week, s.cwd);
    r.sessions++;
    const keys = [s.branch && !TRUNK.test(s.branch) ? `${s.cwd}|${s.branch}` : null, s.pr !== null ? `${s.cwd}|#${s.pr}` : null].filter((k): k is string => k !== null);
    if (keys.length > 0) r.onBranch++;
    if (keys.some((k) => merged.has(k))) r.merged++;
    else if (keys.some((k) => hasPr.has(k))) r.openPr++;
    if (s.cost !== null) {
      r.costUsd = Math.round(((r.costUsd ?? 0) + s.cost) * 100) / 100;
      r.costKnown++;
    }
  }
  for (const b of branches.values()) {
    const r = at(b.week, b.cwd);
    r.branches++;
    if (merged.has(b.key)) r.branchesMerged++;
  }
  return [...out.values()].sort((a, b) => b.week.localeCompare(a.week) || b.sessions - a.sessions || b.branches - a.branches || a.project.localeCompare(b.project));
}

/** One line for a weekly view: "Claude cost $14 on puzzlebox-studio this week (cost known for 4 of 5 sessions); 3 of 5 sessions ended in a merged PR." */
export function agentYieldLine(r: AgentYieldRow, when = 'this week'): string {
  const parts: string[] = [];
  if (r.costUsd !== null) parts.push(`Claude cost about $${Math.round(r.costUsd)} on ${r.project} ${when} (cost known for ${r.costKnown} of ${r.sessions} sessions)`);
  else if (r.sessions > 0) parts.push(`Claude ran ${r.sessions} session${r.sessions === 1 ? '' : 's'} on ${r.project} ${when} (no cost on record yet)`);
  if (r.sessions > 0) parts.push(`${r.merged} of ${r.sessions} sessions ended in a merged PR`);
  else if (r.branches > 0) parts.push(`${r.branchesMerged} of ${r.branches} branches an agent worked on in ${r.project} ${when} have merged`);
  return parts.length === 0 ? '' : `${parts.join('; ')}.`;
}
