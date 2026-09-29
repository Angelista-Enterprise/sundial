import { computeEmbedding } from '@sundial/memory/index.js';
import { embeddingSpace, momentEmbedText, momentModelTag } from '@sundial/helpers/moment-embed-text.js';
import { deleteEmbeddingsByIds, getAllEmbeddings, updateEmbeddingVector, type StoredEmbedding } from './embeddings.js';
import { getEntityFactsWithEntityByIds } from './entities.js';
import { getKnowledgeEntriesByIds } from './knowledge-entries.js';
import { getMomentsByIds } from './moments.js';

/**
 * Fixes the third leg of the embedding-scheme and vector-lifecycle issue (now
 * `almanac/architecture/memory/embeddings-and-search.md`):
 * a corpus embedded partly under an old scheme (e.g. the hashing-trick fallback
 * used while the MiniLM model was still downloading on a first offline run) had
 * no path back to the current scheme — those rows just scored 0 forever (now:
 * are skipped, once `scoredSearch` gates on `model`). This re-embeds them.
 *
 * Run on the daily `day:boundary` maintenance beat (next to retention), bounded
 * to `limit` rows per run so a scheme change drains gradually rather than
 * re-embedding thousands of rows in one CPU spike. A no-op (one probe embed +
 * one table read) when every row already matches the current scheme.
 */
const BACKFILL_BATCH_LIMIT = 500;

export interface EmbeddingBackfillResult {
  currentModel: string;
  reembedded: number;
  orphaned: number;
  remaining: number;
}

/** Rebuilds the text a row would be embedded from, matching each ref type's original `Embed` effect. Returns null if the ref no longer resolves (or a fact has been superseded) — the row is a stale orphan and should be dropped. */
function textForEmbedding(
  e: StoredEmbedding,
  moments: Map<string, Awaited<ReturnType<typeof getMomentsByIds>>[number]>,
  knowledge: Map<string, Awaited<ReturnType<typeof getKnowledgeEntriesByIds>>[number]>,
  facts: Map<string, Awaited<ReturnType<typeof getEntityFactsWithEntityByIds>>[number]>,
): string | null {
  if (e.refType === 'moment') {
    const m = moments.get(e.refId);
    if (!m) return null;
    // The one builder `embeddingIndex` uses too, so the two cannot drift.
    return momentEmbedText(m.processName, m.data);
  }
  if (e.refType === 'knowledge_entry') {
    const k = knowledge.get(e.refId);
    if (!k) return null;
    return `${k.title}. ${k.body}`; // matches apply-llm-result.ts
  }
  if (e.refType === 'entity_fact') {
    const f = facts.get(e.refId);
    if (!f || f.validTo !== null) return null; // gone, or superseded → not current knowledge
    return `${f.canonicalName} ${f.predicate} ${f.object}`; // matches contradiction-check.ts
  }
  return null;
}

export async function reembedStaleEmbeddings(limit = BACKFILL_BATCH_LIMIT): Promise<EmbeddingBackfillResult> {
  const { model: currentModel } = await computeEmbedding('gnomon embedding scheme probe');
  const all = await getAllEmbeddings();
  // Stale: another vector space, or a moment embedded from an older version of
  // its text (no narrative, no screen) — `MOMENT_TEXT_TAG` says which.
  const stale = all.filter((e) => embeddingSpace(e.model) !== currentModel || (e.refType === 'moment' && e.model !== momentModelTag(currentModel)));
  if (stale.length === 0) return { currentModel, reembedded: 0, orphaned: 0, remaining: 0 };

  const batch = stale.slice(0, limit);
  const [moments, knowledge, facts] = await Promise.all([
    getMomentsByIds(batch.filter((e) => e.refType === 'moment').map((e) => e.refId)),
    getKnowledgeEntriesByIds(batch.filter((e) => e.refType === 'knowledge_entry').map((e) => e.refId)),
    getEntityFactsWithEntityByIds(batch.filter((e) => e.refType === 'entity_fact').map((e) => e.refId)),
  ]);
  const momentsById = new Map(moments.map((m) => [m.id, m]));
  const knowledgeById = new Map(knowledge.map((k) => [k.id, k]));
  const factsById = new Map(facts.map((f) => [f.id, f]));

  const orphanedIds: string[] = [];
  let reembedded = 0;
  for (const e of batch) {
    const text = textForEmbedding(e, momentsById, knowledgeById, factsById);
    if (text === null) {
      orphanedIds.push(e.id);
      continue;
    }
    const { vector, model } = await computeEmbedding(text);
    await updateEmbeddingVector(e.id, vector, e.refType === 'moment' ? momentModelTag(model) : model);
    reembedded++;
  }
  if (orphanedIds.length > 0) await deleteEmbeddingsByIds(orphanedIds);

  return { currentModel, reembedded, orphaned: orphanedIds.length, remaining: Math.max(0, stale.length - batch.length) };
}
