// Plan 15 step 1: what became of each knock, per notice kind, from the log.
import { getAllSignalsInRange } from '@sundial/db/index.js';

export interface KnockRow {
  kind: string;
  knocks: number;
  go: number;
  declined: number;
  unanswered: number;
}

/** One row per notice kind over the last `days` days. The app's own go (`auto`, a knock that speaks at once) is not the owner's answer and is not counted. */
export async function readKnockStats({ now, days = 30 }: { now: number; days?: number }): Promise<{ days: number; knocks: number; go: number; rows: KnockRow[] }> {
  const signals = await getAllSignalsInRange(new Date(now - days * 86_400_000).toISOString(), new Date(now + 1).toISOString(), ['voice']);
  const kindOf = new Map<string, string>();
  const byKind = new Map<string, KnockRow>();
  for (const s of signals) {
    const type = `${s.signalType}:${s.eventType}`;
    const key = String(s.data.noticeKey ?? '');
    if (type === 'voice:knock') {
      const kind = String(s.data.kind ?? '');
      kindOf.set(key, kind);
      const row = byKind.get(kind) ?? { kind, knocks: 0, go: 0, declined: 0, unanswered: 0 };
      row.knocks += 1;
      byKind.set(kind, row);
      continue;
    }
    const row = byKind.get(kindOf.get(key) ?? '');
    if (!row) continue;
    if (type === 'voice:go' && s.data.auto !== true) row.go += 1;
    else if (type === 'voice:declined') row.declined += 1;
    else if (type === 'voice:unanswered') row.unanswered += 1;
  }
  const rows = [...byKind.values()].sort((a, b) => b.knocks - a.knocks || a.kind.localeCompare(b.kind));
  return { days, knocks: rows.reduce((n, r) => n + r.knocks, 0), go: rows.reduce((n, r) => n + r.go, 0), rows };
}
