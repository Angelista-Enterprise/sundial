import { sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { signals, moments, knowledgeEntries, entities, entityFacts, memoryEmbeddings } from '../schemas/db-schema.js';

export interface MemoryTierCounts {
  /** Episodic tier — raw event log depth. */
  signals: number;
  /** Episodic tier — closed activity sessions. */
  moments: number;
  /** Reflective tier — companion insights + daily reflections. */
  knowledgeEntries: number;
  /** Core tier — durable identities. */
  entities: number;
  /** Core tier — subject-predicate-object facts (current + superseded). */
  entityFacts: number;
}

/**
 * Working Memory's four-tier row counts (docs/05-memory-and-knowledgebase.md,
 * docs/design/06-macos-ui-data-wiring.md) — five simple `COUNT(*)`s, one per
 * table, run together since the UI wants all four tiers on one screen.
 * Deliberately excludes the Working tier's count (whether a moment is
 * currently open) — that's live `KernelState`, not a table this package
 * queries.
 */
export async function getMemoryTierCounts(): Promise<MemoryTierCounts> {
  const db = getDb();
  const [[signalsRow], [momentsRow], [knowledgeRow], [entitiesRow], [factsRow]] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(signals),
    db.select({ count: sql<number>`count(*)` }).from(moments),
    db.select({ count: sql<number>`count(*)` }).from(knowledgeEntries),
    db.select({ count: sql<number>`count(*)` }).from(entities),
    db.select({ count: sql<number>`count(*)` }).from(entityFacts),
  ]);
  return {
    signals: signalsRow.count,
    moments: momentsRow.count,
    knowledgeEntries: knowledgeRow.count,
    entities: entitiesRow.count,
    entityFacts: factsRow.count,
  };
}

export interface PipelineCoverage {
  moments: number;
  /** Moments the intent LLM actually described (`data.intent.text` present) — the rest closed without analysis. */
  momentsWithIntent: number;
  /** Moments attributed to a project (`project_id` not null) — the rest are unattributed activity. */
  momentsWithProject: number;
}

/**
 * How complete the enrichment pipeline is over closed moments — the honest
 * "is the daemon actually understanding what it captured" tiles for
 * Observability Overview (mirrors WCS's `context-health`, minus the sprawl).
 * Both are `COUNT(*)`s over `moments`, one indexed on `project_id`.
 */
export async function getPipelineCoverage(): Promise<PipelineCoverage> {
  const db = getDb();
  const [[total], [withIntent], [withProject]] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(moments),
    db
      .select({ count: sql<number>`count(*)` })
      .from(moments)
      .where(sql`json_extract(${moments.data}, '$.intent.text') is not null and json_extract(${moments.data}, '$.intent.text') != ''`),
    db.select({ count: sql<number>`count(*)` }).from(moments).where(sql`${moments.projectId} is not null`),
  ]);
  return { moments: total.count, momentsWithIntent: withIntent.count, momentsWithProject: withProject.count };
}

export interface EmbeddingHealth {
  total: number;
  /** Most common embedding model in `memory_embeddings`, or null when there are no vectors yet. */
  model: string | null;
  /** True when the dominant model is the hashing-trick fallback (`local-hash-*`) rather than a real local model — semantic search is degraded to keyword overlap. */
  hashFallback: boolean;
}

/**
 * Which embedding scheme the stored vectors actually use — surfaces the
 * "semantic search degraded (hash fallback)" state the user should see when
 * the local embedding server was unreachable (docs/design/06-macos-ui-data-wiring.md).
 * `local-hash-*` is the hashing-trick fallback; `ollama-*` is a real model.
 */
export async function getEmbeddingHealth(): Promise<EmbeddingHealth> {
  const db = getDb();
  const rows = await db
    .select({ model: memoryEmbeddings.model, count: sql<number>`count(*)` })
    .from(memoryEmbeddings)
    .groupBy(memoryEmbeddings.model)
    .orderBy(sql`count(*) desc`);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const model = rows[0]?.model ?? null;
  return { total, model, hashFallback: model != null && /hash/i.test(model) };
}
