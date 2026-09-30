// W4 step 8: the Trust card's reads that are a pure function of the state and a clock. The
// route keeps only what needs the database (pipeline, embeddings, freshness, redaction,
// retractions, observed hours). Notice precision per kind is FOLDED now
// (`state.calibrated.noticeByKind`, by `calibrate`), so the gate reads the same numbers the card
// shows, and neither scans the log on a read.
import { localDate } from '@sundial/helpers/local-day.js';
import type { KernelState, NoticeDay } from '../types.js';

export interface KindTrust extends NoticeDay {
  kind: string;
  /** Delivered notices the owner judged (useful, wrong or not-now). */
  n: number;
}

/** Of the notices judged in the last `days` local days, how many were worth hearing — per kind, with n, and what else happened to them. */
export function noticesByKind(state: KernelState | null, now: number, days = 30): { n: number; useful: number; excluded: number; delivered: number; labelled: number; byKind: KindTrust[] } {
  const tz = state?.config?.timezone ?? 'UTC';
  const since = localDate(new Date(now - (days - 1) * 86_400_000).toISOString(), tz);
  const byKind: KindTrust[] = [];
  for (const [kind, perDay] of Object.entries(state?.calibrated?.noticeByKind ?? {})) {
    const row: KindTrust = { kind, n: 0, delivered: 0, labelled: 0, useful: 0, wrong: 0, notNow: 0, seen: 0, acted: 0, explored: 0 };
    for (const [day, d] of Object.entries(perDay)) {
      if (day < since) continue;
      for (const f of ['delivered', 'labelled', 'useful', 'wrong', 'notNow', 'seen', 'acted', 'explored'] as const) row[f] += d[f];
    }
    row.n = row.useful + row.wrong + row.notNow;
    if (row.n > 0 || row.delivered > 0) byKind.push(row);
  }
  byKind.sort((a, b) => b.n - a.n || b.delivered - a.delivered || a.kind.localeCompare(b.kind));
  const sum = (f: keyof NoticeDay | 'n') => byKind.reduce((s, r) => s + r[f], 0);
  return { n: sum('n'), useful: sum('useful'), excluded: 0, delivered: sum('delivered'), labelled: sum('labelled'), byKind };
}

/** J2.1's gate: the owner-state filter against the owner's own taps, and the days toward the fourteen it wants. */
export function perception(state: KernelState | null) {
  const o = state?.owner;
  const reports = Array.isArray(o?.selfReports) ? o.selfReports : [];
  const days = new Set(reports.map((r) => r.ts.slice(0, 10))).size;
  return { n: o?.brier?.n ?? 0, brier: o?.brier?.n ? o.brier.sum / o.brier.n : null, days, firstAt: o?.brier?.firstAt ?? null, target: { brier: 0.15, days: 14 }, inGateCost: state?.config?.experiments?.ownerStateInGateCost === true };
}

/** J5.4 / J5.2: every judged question with its threshold, the verdicts on it and its deciles; and how long the judge has been off its own model. */
export function judgementTrust(state: KernelState | null, now: number, catalog: { id: string; set: string; key: string; learnsAt?: number }[] = []) {
  const j = state?.judgement;
  const meta = new Map(catalog.map((q) => [q.id, q]));
  const questions = Object.entries(j?.questions ?? {}).map(([id, r]) => {
    const m = meta.get(id);
    return { id, set: m?.set ?? '?', key: m?.key ?? id, type: r.type, threshold: r.threshold, learned: r.n >= (m?.learnsAt ?? 20), n: r.n, hits: r.hits, bins: r.bins, lastVerdictAt: r.lastVerdictAt };
  });
  const degradedSince = j?.degradedSince ?? null;
  return { degraded: j?.degraded ?? 'none', degradedSince, degradedMs: (j?.degradedMs ?? 0) + (degradedSince ? Math.max(0, now - Date.parse(degradedSince)) : 0), questions, learnsAt: 20 };
}
