import { deleteKnowledgeEntryByDedupeKey, insertEmbedding, insertKnowledgeEntry } from '@sundial/db/index.js';
import { createEventId } from '@sundial/helpers/index.js';
import { computeEmbedding } from '@sundial/memory/index.js';
import { assembleJournalMarkdown, type JournalResult } from './daily-journal-prompt.js';

/** Higher than a reflection (6) — a full day's journal is the most retrieval-worthy synthesized entry. */
export const JOURNAL_IMPORTANCE_SCORE = 7;
/** A project status is durable and retrieval-worthy, but a notch below the whole-day journal. */
export const PROJECT_STATUS_IMPORTANCE_SCORE = 6;

export interface PersistedJournal {
  id: string;
  inserted: boolean;
}

/**
 * The shared "write one journal-shaped knowledge entry (markdown `body` +
 * structured JSON) + its embedding" step behind both `persistDailyJournal` and
 * `persistProjectStatus`. Idempotent via `dedupeKey`; `overwrite` drops the
 * prior entry first so a regenerate isn't a no-op. Embeds only on a genuine new
 * insert. Kept in one place so the two callers differ only in kind/dedupeKey/
 * importance, not in how structure and embeddings are persisted.
 */
async function persistJournalEntry(opts: {
  kind: string;
  dedupeKey: string;
  title: string;
  result: JournalResult;
  importanceScore: number;
  ts: string;
  overwrite: boolean;
}): Promise<PersistedJournal> {
  if (opts.overwrite) await deleteKnowledgeEntryByDedupeKey(opts.dedupeKey);
  const id = createEventId();
  const inserted = await insertKnowledgeEntry({
    id,
    kind: opts.kind,
    title: opts.title,
    body: assembleJournalMarkdown(opts.result),
    // The structured form the UI renders as native sections; `body` stays the
    // markdown fallback for search/reflection/CLI and pre-structured entries.
    structured: JSON.stringify(opts.result),
    severity: null,
    dedupeKey: opts.dedupeKey,
    sourceEventId: null,
    createdAt: opts.ts,
    importanceScore: opts.importanceScore,
  });
  if (inserted) {
    const { vector, model } = await computeEmbedding(`${opts.result.tldr}. ${opts.result.narrative}`);
    await insertEmbedding({ id: createEventId(), refType: 'knowledge_entry', refId: id, model, vector, createdAt: opts.ts });
  }
  return { id, inserted };
}

/**
 * P5/P6 (docs/design/07) — write one `kind:'daily'` knowledge entry + its
 * embedding, called by BOTH the daemon's `performDailyJournalCall` and the
 * CLI's `gnomon journal`. Idempotent via `dedupeKey: daily:<date>` — one entry
 * per day, re-runnable; a re-run of an existing day inserts nothing (returns
 * `inserted: false`), matching the reflection pattern.
 */
export async function persistDailyJournal(date: string, ts: string, result: JournalResult, overwrite = false): Promise<PersistedJournal> {
  return persistJournalEntry({
    kind: 'daily',
    dedupeKey: `daily:${date}`,
    title: result.tldr,
    result,
    importanceScore: JOURNAL_IMPORTANCE_SCORE,
    ts,
    overwrite,
  });
}

/**
 * Write one `kind:'project-status'` knowledge entry + its embedding for a
 * project. Idempotent via `dedupeKey: project:<projectId>` — one rolling status
 * per project, overwritten on regenerate (the on-demand path always passes
 * `overwrite: true`). Same structured-body persistence as the daily journal, so
 * the UI renders it with the identical section renderer.
 */
export async function persistProjectStatus(projectId: string, ts: string, result: JournalResult, overwrite = false): Promise<PersistedJournal> {
  return persistJournalEntry({
    kind: 'project-status',
    dedupeKey: `project:${projectId}`,
    title: result.tldr,
    result,
    importanceScore: PROJECT_STATUS_IMPORTANCE_SCORE,
    ts,
    overwrite,
  });
}
