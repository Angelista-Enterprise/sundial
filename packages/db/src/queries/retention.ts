import { and, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { llmAudit, moments, signals } from '../schemas/db-schema.js';

export interface RetentionPruneResult {
  signalsDeleted: number;
  momentsDeleted: number;
  embeddingsDeleted: number;
  llmAuditDeleted: number;
}

/**
 * Deletes `signals` older than `olderThan` (by `capturedAt`), `moments`
 * older than `olderThan` (by `startTime`), and — E2 (docs/audit/production-
 * proposal-and-enhancements.md, fixes A§6.4's "add a retention cap for
 * llm_audit") — `llm_audit` rows older than `olderThan` (by `requestedAt`).
 * Ported from WCS's scheduled privacy-pruner (`packages/core-plugins/src/
 * privacy-pruner/`), trimmed to the tables Gnomon actually has.
 * `knowledge_entries` is still deliberately NOT pruned by this: generated
 * insights/reflections are meant to persist as a knowledge base independent
 * of raw-signal retention. `llm_audit` no longer gets that same exemption —
 * it stores the full prompt/response text of every call (a real, growing
 * privacy surface per A§6.2/A§2.6, not a knowledge asset worth keeping
 * forever) and is exactly what `gnomon purge` (below) can also delete
 * on-demand for an arbitrary range.
 */
export async function deleteRowsOlderThan(olderThan: string): Promise<RetentionPruneResult> {
  const db = getDb();
  const [signalsResult, momentsResult, llmAuditResult] = await Promise.all([
    db.delete(signals).where(lt(signals.capturedAt, olderThan)),
    db.delete(moments).where(lt(moments.startTime, olderThan)),
    db.delete(llmAudit).where(lt(llmAudit.requestedAt, olderThan)),
  ]);
  // A§2.3 — embeddings are never deleted alongside the moment they point to;
  // this sweeps any left orphaned by the moment delete above (or by any
  // other path that ever removes a moment/knowledge entry).
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
  };
}

/**
 * The short-horizon sweep: only `signals` of the given `signal_type`s older
 * than `olderThan`. Built for `screen:ocr`, whose raw text should not sit on
 * disk for the six months the rest of the log keeps (its moments keep the
 * derived topics and excerpt). Touches nothing else.
 */
export async function deleteSignalsOlderThan(olderThan: string, signalTypes: readonly string[]): Promise<number> {
  if (signalTypes.length === 0) return 0;
  const db = getDb();
  const result = await db.delete(signals).where(and(lt(signals.capturedAt, olderThan), inArray(signals.signalType, [...signalTypes])));
  return result.rowsAffected;
}
