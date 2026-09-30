import { and, inArray, lt, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { appliedEffects, llmAudit, moments, signals } from '../schemas/db-schema.js';

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
 * lane Q (Q10): the short horizon for the two tables that grow fastest.
 * `llm_audit` keeps every prompt and response whole for the 180-day
 * retention: 165 MB over 33k rows on the live record. Past `olderThan` a row
 * keeps its metadata (purpose, model, tokens, latency, status, error) and
 * loses its text: `prompt` is NOT NULL, so it becomes ''. `applied_effects`
 * had no retention at all; a completed journal row older than `olderThan`
 * says nothing a boot replay can use, so it goes. Started, failed and
 * indeterminate rows stay: those are the ones a replay reads.
 */
export async function trimAuditBodies(olderThan: string): Promise<{ llmBodiesCleared: number; effectsDeleted: number }> {
  const db = getDb();
  const cleared = await db
    .update(llmAudit)
    .set({ prompt: '', responseContent: null })
    .where(and(lt(llmAudit.requestedAt, olderThan), sql`(${llmAudit.prompt} <> '' OR ${llmAudit.responseContent} IS NOT NULL)`));
  const journal = await db.delete(appliedEffects).where(and(lt(appliedEffects.appliedAt, olderThan), sql`${appliedEffects.status} = 'completed'`));
  return { llmBodiesCleared: cleared.rowsAffected, effectsDeleted: journal.rowsAffected };
}

/**
 * The short-horizon sweep: only `signals` of the given `signal_type`s older
 * than `olderThan`. Built for `screen:ocr`, whose raw text should not sit on
 * disk for the six months the rest of the log keeps (its moments keep the
 * derived topics and excerpt). Touches nothing else.
 *
 * `apps` narrows it to rows whose payload `processName` or `bundleId` contains
 * one of them (case-insensitive, the sensor's own substring test): the purge of
 * screens captured before an app joined the sensitive list. At most `limit`
 * rows a call, so a first purge over a large log is spread across days rather
 * than one long write lock; it deletes nothing once they are gone.
 *
 * `eventTypes` narrows a sweep to those `event_type`s (`audio:transcript`
 * without the headphone rows that share its `signal_type`).
 */
/**
 * W1 step 8: a deleted thread's `llm_audit` rows — every call the chat guard
 * reserved under that session (`llm:dispatched {callId, sessionId}`).
 */
export async function deleteLlmAuditOfSession(sessionId: string): Promise<number> {
  const result = await getDb().run(sql`
    DELETE FROM llm_audit WHERE id IN (
      SELECT json_extract(data, '$.callId') FROM signals
      WHERE signal_type = 'llm' AND event_type = 'dispatched' AND json_extract(data, '$.sessionId') = ${sessionId}
    )
  `);
  return result.rowsAffected;
}

export async function deleteSignalsOlderThan(
  olderThan: string,
  signalTypes: readonly string[],
  { apps = [], eventTypes, sessionId, limit = 5000 }: { apps?: readonly string[]; eventTypes?: readonly string[]; sessionId?: string; limit?: number } = {},
): Promise<number> {
  if (signalTypes.length === 0) return 0;
  const db = getDb();
  if (apps.length === 0) {
    const result = await db
      .delete(signals)
      .where(
        and(
          lt(signals.capturedAt, olderThan),
          inArray(signals.signalType, [...signalTypes]),
          eventTypes ? inArray(signals.eventType, [...eventTypes]) : undefined,
          sessionId !== undefined ? sql`json_extract(data, '$.sessionId') = ${sessionId}` : undefined,
        ),
      );
    return result.rowsAffected;
  }
  const who = sql`lower(coalesce(json_extract(data, '$.processName'), '') || ' ' || coalesce(json_extract(data, '$.bundleId'), ''))`;
  const match = sql.join(apps.map((app) => sql`${who} LIKE ${`%${app.toLowerCase()}%`}`), sql` OR `);
  const types = sql.join(signalTypes.map((t) => sql`${t}`), sql`, `);
  const result = await db.run(sql`
    DELETE FROM signals WHERE id IN (
      SELECT id FROM signals WHERE signal_type IN (${types}) AND captured_at < ${olderThan} AND (${match}) LIMIT ${limit}
    )
  `);
  return result.rowsAffected;
}
