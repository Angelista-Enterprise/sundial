import type { StoredSignal } from '@sundial/db/index.js';

/**
 * What changed in the owner's context: the moments an agent beside the owner should look again
 * (2026-10-05). The same rule `lab/curiosity/wakes.mjs` measured as W1: under it, a being with a
 * notebook chose to speak 1 to 2 times a day, no more than on a clock, and it follows the owner's
 * day instead of the hour. Pure over log rows; the rows before `since` only supply history (the
 * last input before a break, a PR's previous state, an earlier failure of the same command).
 */
export type ChangeKind = 'project' | 'back' | 'meeting' | 'pr' | 'failing' | 'agent-blocked' | 'agent-task';

export interface Change {
  at: string;
  kind: ChangeKind;
  detail: string;
}

export const CHANGE_TYPES = ['input:activity', 'project:switched', 'calendar:upcoming', 'git:pr-status', 'shell:command', 'agent:fleet', 'agent:turn'];

const MIN = 60_000;
const BREAK_MS = 15 * MIN;
const MEETING_LEAD_MS = 12 * MIN;
const FAIL_AGAIN_MS = 30 * MIN;
const NEW_TASK_QUIET_MS = 20 * MIN;
/** The owner flips between windows all day; a project change counts once per quarter hour, and only to a new project. */
const PROJECT_CALM_MS = 15 * MIN;
const BLOCKED = new Set(['permission', 'question', 'plan', 'failed']);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (raw: string, n: number) => { const s = raw.replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** Every change after `since` and up to `now`, oldest first. */
export function changesFrom(rows: readonly StoredSignal[], since: string, now: string): Change[] {
  const sorted = [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const out: Change[] = [];
  const push = (at: number | string, kind: ChangeKind, detail: string) => {
    const iso = typeof at === 'number' ? new Date(at).toISOString() : at;
    if (iso > since && iso <= now) out.push({ at: iso, kind, detail });
  };
  let lastInput: number | null = null;
  const pr = new Map<string, string>();
  const failed = new Map<string, number>();
  const blocked = new Map<string, boolean>();
  const lastAsk = new Map<string, number>();
  const meetings = new Map<string, { at: number; detail: string }>();
  let lastProject: { root: string; at: number } | null = null;

  for (const r of sorted) {
    const at = Date.parse(r.capturedAt);
    const d = r.data;
    switch (`${r.signalType}:${r.eventType}`) {
      case 'input:activity':
        if (lastInput !== null && at - lastInput >= BREAK_MS) push(at, 'back', `after ${Math.round((at - lastInput) / MIN)} min away`);
        lastInput = at;
        break;
      case 'project:switched':
        if (d.kind !== 'project' || !str(d.toProjectRoot) || d.toProjectRoot === d.fromProjectRoot) break;
        if (lastProject && (lastProject.root === d.toProjectRoot || at - lastProject.at < PROJECT_CALM_MS)) break;
        push(at, 'project', `to ${str(d.toProjectName) || str(d.toProjectRoot)}${str(d.toBranch) ? ` (${str(d.toBranch)})` : ''}`);
        lastProject = { root: str(d.toProjectRoot), at };
        break;
      case 'calendar:upcoming':
        for (const e of (Array.isArray(d.events) ? d.events : []) as Record<string, unknown>[]) {
          const attendees = Array.isArray(e.attendees) ? e.attendees.length : 0;
          if (e.isAllDay || attendees === 0) continue;
          const start = Date.parse(str(e.startDate));
          if (Number.isNaN(start)) continue;
          meetings.set(`${str(e.eventId)}|${str(e.startDate)}`, { at: start - MEETING_LEAD_MS, detail: `${clip(str(e.title), 80)} in 12 min, ${attendees} invited` });
        }
        break;
      case 'git:pr-status': {
        const key = `${str(d.cwd)}#${String(d.number)}`;
        const state = `${str(d.state)}|${str(d.reviewState)}|${str(d.checkState)}`;
        if (pr.has(key) && pr.get(key) !== state) push(at, 'pr', `#${String(d.number)} ${clip(str(d.title), 70)}: ${str(d.state)}, review ${str(d.reviewState) || '?'}, checks ${str(d.checkState) || '?'}`);
        pr.set(key, state);
        break;
      }
      case 'shell:command': {
        if (d.exitCode === 0) break;
        const cmd = clip(str(d.command), 60);
        const before = failed.get(cmd);
        if (before !== undefined && at - before < FAIL_AGAIN_MS) push(at, 'failing', `${cmd} failed again (exit ${String(d.exitCode)})`);
        failed.set(cmd, at);
        break;
      }
      case 'agent:fleet':
        for (const s of (Array.isArray(d.sessions) ? d.sessions : []) as Record<string, unknown>[]) {
          const id = str(s.id);
          const is = BLOCKED.has(str(s.state));
          if (is && !blocked.get(id)) push(at, 'agent-blocked', `${id} ${str(s.state)}${str(s.title) ? `: ${clip(str(s.title), 80)}` : ''}`);
          blocked.set(id, is);
        }
        break;
      case 'agent:turn': {
        if (d.role !== 'prompt') break;
        const sid = str(d.sid) || str(d.session);
        const before = lastAsk.get(sid);
        if (before === undefined || at - before > NEW_TASK_QUIET_MS) push(at, 'agent-task', `${str(d.agent) || 'agent'} ${sid.slice(0, 8)}: ${clip(str(d.text), 120)}`);
        lastAsk.set(sid, at);
        break;
      }
    }
  }
  for (const m of meetings.values()) push(m.at, 'meeting', m.detail);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
