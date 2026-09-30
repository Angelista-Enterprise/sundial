// What Gnomon made on its own (the `workbench` rule's jobs, or something the owner asked to
// keep): `knowledge_entries` of kind `shelf` from the last 14 days, with the owner's latest
// verdict on each. "Not now" takes an item off Today; it stays in the record.
import { getKnowledgeEntriesSince, getSignalsInRange } from '@sundial/db/index.js';

export interface ShelfItem {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  verdict: string | null;
}

export async function readShelf({ now }: { now: number }): Promise<ShelfItem[]> {
  const since = new Date(now - 14 * 86_400_000).toISOString();
  const entries = (await getKnowledgeEntriesSince(since)).filter((entry) => entry.kind === 'shelf' && entry.retractedAt === null);
  // The latest `feedback:verdict` per item, from the log rather than `state.feedback.recent`
  // (a 50-entry ring that would forget a Keep from last week), so a refresh does not re-offer the buttons.
  const verdicts = new Map<string, string>();
  for (const signal of await getSignalsInRange(since, new Date(now + 60_000).toISOString(), 2000, ['feedback'])) {
    let data = signal.data as unknown;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    const d = data as { artifactKind?: unknown; artifactId?: unknown; verdict?: unknown } | null;
    if (d?.artifactKind !== 'knowledge_entry' || typeof d.artifactId !== 'string') continue;
    verdicts.set(d.artifactId, String(d.verdict));
  }
  return entries
    .filter((entry) => verdicts.get(entry.id) !== 'not-now')
    .map((entry) => ({ id: entry.id, title: entry.title, body: entry.body, createdAt: entry.createdAt, verdict: verdicts.get(entry.id) ?? null }));
}
