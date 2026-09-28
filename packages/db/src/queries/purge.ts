import { and, gte, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { entityFacts, knowledgeEntries, llmAudit, moments, predictions, signals } from '../schemas/db-schema.js';

export interface PurgeRangeResult {
  signalsDeleted: number;
  momentsDeleted: number;
  embeddingsDeleted: number;
  llmAuditDeleted: number;
  knowledgeEntriesDeleted: number;
  entityFactsDeleted: number;
  predictionsDeleted: number;
}

/**
 * E2 (docs/audit/production-proposal-and-enhancements.md, fixes A§6.4) —
 * `gnomon purge --from --to`, the manual counterpart to the automatic daily
 * `retentionPrune`/`deleteRowsOlderThan`: an arbitrary user-chosen date
 * range instead of "everything older than the retention window." Distinct
 * from `dev db-reset` (full-wipe, dev-only) — this is meant for a real
 * "delete my last month" request against a live install.
 *
 * `entity_facts` is deleted via `sourceEventId` matching a signal actually
 * being purged, not by the fact's own `createdAt` — a fact's `createdAt`
 * closely tracks its sourcing signal in practice, but `sourceEventId` is
 * the real, direct provenance link, not an approximation of one. This is a
 * deliberate exception to core memory's usual "never destructively updated,
 * only superseded" rule (docs/design/05-memory-and-knowledgebase.md §4) —
 * that rule protects against *accidental* loss during normal operation; an
 * explicit user purge request is exactly the case it was never meant to
 * guard against. `knowledge_entries` (reflections/insights) purge by their
 * own `createdAt` directly, same as `signals`/`moments`/`llm_audit` — they
 * don't carry a `sourceEventId` chain back to a single purgeable signal the
 * way a fact-candidate does (a reflection's `sourceEventId` is `null`).
 *
 * `predictions` is purged here and deliberately NOT pruned by the daily
 * `deleteRowsOlderThan` — the opposite treatment from every other table, and
 * the point. Durability is what that table is FOR: A08 counts 100 resolutions
 * before it will report a calibration figure, and a retention sweep quietly
 * trimming the sample would recreate, more slowly, the unreachable ambition the
 * table was added to fix. A purge is a different thing — an explicit "delete
 * this date range" request, and a resolution row does say the owner was active
 * in a given hour on a given date. Privacy outranks the sample; a background
 * prune does not.
 */
export async function purgeDateRange(from: string, to: string): Promise<PurgeRangeResult> {
  const db = getDb();

  const purgedSignalIds = await db.select({ id: signals.id }).from(signals).where(and(gte(signals.capturedAt, from), lte(signals.capturedAt, to)));

  const [signalsResult, momentsResult, llmAuditResult, knowledgeEntriesResult, predictionsResult] = await Promise.all([
    db.delete(signals).where(and(gte(signals.capturedAt, from), lte(signals.capturedAt, to))),
    db.delete(moments).where(and(gte(moments.startTime, from), lte(moments.startTime, to))),
    db.delete(llmAudit).where(and(gte(llmAudit.requestedAt, from), lte(llmAudit.requestedAt, to))),
    db.delete(knowledgeEntries).where(and(gte(knowledgeEntries.createdAt, from), lte(knowledgeEntries.createdAt, to))),
    // By `resolvedAt`: the row is a record of an outcome observed at that
    // instant, which is the moment the range is really about.
    db.delete(predictions).where(and(gte(predictions.resolvedAt, from), lte(predictions.resolvedAt, to))),
  ]);

  let entityFactsDeleted = 0;
  const purgedIds = purgedSignalIds.map((row) => row.id);
  if (purgedIds.length > 0) {
    const entityFactsResult = await db.delete(entityFacts).where(inArray(entityFacts.sourceEventId, purgedIds));
    entityFactsDeleted = entityFactsResult.rowsAffected;
  }

  // Same orphan sweep as `deleteRowsOlderThan` (A§2.3) — a moment/knowledge
  // entry just deleted above leaves its embedding row behind otherwise.
  const embeddingsResult = await db.run(sql`
    DELETE FROM memory_embeddings
    WHERE (ref_type = 'moment' AND ref_id NOT IN (SELECT id FROM moments))
       OR (ref_type = 'knowledge_entry' AND ref_id NOT IN (SELECT id FROM knowledge_entries))
       OR (ref_type = 'entity_fact' AND ref_id NOT IN (SELECT id FROM entity_facts))
  `);

  return {
    signalsDeleted: signalsResult.rowsAffected,
    momentsDeleted: momentsResult.rowsAffected,
    embeddingsDeleted: embeddingsResult.rowsAffected,
    llmAuditDeleted: llmAuditResult.rowsAffected,
    knowledgeEntriesDeleted: knowledgeEntriesResult.rowsAffected,
    entityFactsDeleted,
    predictionsDeleted: predictionsResult.rowsAffected,
  };
}
