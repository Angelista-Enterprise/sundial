import { z } from 'zod';
import { getAllSignalsInRange, type StoredSignal } from '@sundial/db/index.js';
import { CHANGE_TYPES, changesFrom } from '../changes.js';
import { RESULT_BUDGET_CHARS, takeWithinBudget } from './evidence-tools.js';
import type { GnomonTool } from './registry.js';

/**
 * The notices Gnomon already delivered, paged on time (2026-10-05).
 *
 * For a reader outside the harness (a Claude Code mod) that must be told when a
 * notice landed and has no push: it polls with `since`. Nothing here decides:
 * the gate chose each notice and its acts, the delivery plugin wrote
 * `notice:delivered`, and this reads those rows back. `channel` is the gate's
 * own acts said in one word; `agent` is a notice the gate chose to wake an
 * agent for (`turn`), the one kind a dedicated agent session may answer.
 * (Named `claude` until 2026-10-05; the mod reads both for one release.)
 * Pure arithmetic in `deliveredNotices`; the handler only reads.
 */

export interface DeliveredNotice {
  /** The `notice:delivered` row's id: unique, where the notice key recurs. */
  id: string;
  at: string;
  kind: string | null;
  text: string;
  channel: 'agent' | 'banner' | 'phone' | 'chat';
  acts: string[];
  seen: boolean;
}

/** How far back a delivered notice's candidate may lie: a deferred one waits, but never past its half-life. */
const CANDIDATE_LOOKBACK_MS = 2 * 86_400_000;
const TEXT_CHARS = 400;

export function channelOf(acts: readonly string[]): DeliveredNotice['channel'] {
  if (acts.includes('turn')) return 'agent';
  if (acts.includes('banner')) return 'banner';
  if (acts.includes('push')) return 'phone';
  return 'chat';
}

/**
 * Every delivered notice strictly after `since`, oldest first, joined to the
 * candidate that said it (the latest one with its key at or before delivery)
 * and to any `notice:seen` of its key after it.
 */
export function deliveredNotices(rows: readonly StoredSignal[], since: string): DeliveredNotice[] {
  const sorted = [...rows].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const said = new Map<string, { at: string; kind: string | null; text: string }>();
  const out: (DeliveredNotice & { key: string })[] = [];
  for (const r of sorted) {
    const type = `${r.signalType}:${r.eventType}`;
    if (type === 'notice:candidate' && typeof r.data.key === 'string') {
      said.set(r.data.key, { at: r.capturedAt, kind: typeof r.data.kind === 'string' ? r.data.kind : null, text: typeof r.data.observation === 'string' ? r.data.observation : '' });
    } else if (type === 'notice:delivered' && typeof r.data.noticeKey === 'string' && r.capturedAt > since && typeof r.data.sandbox !== 'string') {
      // S4: a line a rig chat's sandbox drew in its own thread (marked `sandbox`) is never one of the owner's notices.
      const acts = Array.isArray(r.data.acts) ? r.data.acts.filter((a): a is string => typeof a === 'string') : [];
      const from = said.get(r.data.noticeKey);
      out.push({ id: r.id, key: r.data.noticeKey, at: r.capturedAt, kind: from?.kind ?? null, text: (from?.text ?? '').slice(0, TEXT_CHARS), channel: channelOf(acts), acts, seen: false });
    } else if (type === 'notice:seen' && typeof r.data.noticeKey === 'string') {
      for (const n of out) if (n.key === r.data.noticeKey && n.at <= r.capturedAt) n.seen = true;
    }
  }
  return out.map(({ key: _, ...n }) => n);
}

/** How far before `since` the change rule reads for history: a break, a PR's last state, a first failure. */
const CHANGE_HISTORY_MS = 2 * 3_600_000;

export const NOTICE_TOOLS: GnomonTool[] = [
  {
    name: 'gnomon_changes',
    description:
      "What changed in the owner's context strictly after `since` (default: the last hour), oldest first: `project` (they moved to another project), `back` (back after 15+ minutes away), `meeting` (a meeting with others starts in 12 minutes), `pr` (a pull request's review or checks changed), `failing` (the same command failed again), `agent-blocked` (a coding agent now waits on the owner), `agent-task` (the owner started a new task with an agent). Each with `at` and a short `detail`. These are the moments to look again at what the owner needs. Poll with `since` set to the last `at` you have.",
    schema: {
      since: z.string().datetime().optional().describe('ISO instant; only changes after it. Default: one hour ago'),
      limit: z.number().int().min(1).max(50).optional().describe('Most changes to return (default 20)'),
    },
    readOnly: true,
    handler: async (args, env) => {
      const { since, limit } = args as { since?: string; limit?: number };
      const now = env.now.toISOString();
      const after = since ?? new Date(env.now.getTime() - 3_600_000).toISOString();
      const rows = await getAllSignalsInRange(new Date(Date.parse(after) - CHANGE_HISTORY_MS).toISOString(), now, CHANGE_TYPES);
      const all = changesFrom(rows, after, now);
      const { kept } = takeWithinBudget(all.slice(0, limit ?? 20), RESULT_BUDGET_CHARS - 300);
      return { since: after, total: all.length, changes: kept, ...(all.length > kept.length ? { nextSince: kept[kept.length - 1]?.at ?? after } : {}) };
    },
  },
  {
    name: 'gnomon_notices',
    description:
      "The notices Gnomon already decided to deliver, oldest first, strictly after `since` (default: the last 24 hours). Per notice: `id` (unique; the notice key recurs), `at`, `kind`, `text` (what Gnomon noticed), `channel` (`agent`: the gate chose to wake an agent to say it; `banner`: an interruption at the Mac; `phone`: pushed while away; `chat`: context only), the gate's raw `acts`, and `seen` (the owner marked it seen). Poll with `since` set to the last `at` you have; `nextSince` says where the next page starts. Literal from the record: it lists what was delivered, never what was held or suppressed.",
    schema: {
      since: z.string().datetime().optional().describe('ISO instant; only notices delivered after it. Default: 24 hours ago'),
      limit: z.number().int().min(1).max(50).optional().describe('Most notices to return (default 20)'),
    },
    readOnly: true,
    handler: async (args, env) => {
      const { since, limit } = args as { since?: string; limit?: number };
      const now = env.now.toISOString();
      const after = since ?? new Date(env.now.getTime() - 86_400_000).toISOString();
      const from = new Date(Date.parse(after) - CANDIDATE_LOOKBACK_MS).toISOString();
      const rows = await getAllSignalsInRange(from, now, ['notice:candidate', 'notice:delivered', 'notice:seen']);
      const all = deliveredNotices(rows, after);
      const { kept } = takeWithinBudget(all.slice(0, limit ?? 20), RESULT_BUDGET_CHARS - 300);
      const more = all.length - kept.length;
      return {
        since: after,
        total: all.length,
        notices: kept,
        ...(more > 0 ? { nextSince: kept[kept.length - 1]?.at ?? after, note: `${more} more after nextSince — call again with since: nextSince.` } : {}),
      };
    },
  },
];
