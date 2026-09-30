import { sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { signals, moments, knowledgeEntries, entities, entityFacts, memoryEmbeddings, ownerAsks } from '../schemas/db-schema.js';

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

/** W5 step 9: the counts behind the scorecard rows that need history (6, 7, 10, 12). */
export interface ScorecardCounts {
  /** Row 10: moments started since `since`, those whose `activeMs` exceeds the duration, those with an intent. */
  moments: { n: number; activeOver: number; withIntent: number };
  /** Row 6: the owner's verdicts on facts (useful / wrong), and on facts about the owner. */
  facts: { useful: number; wrong: number; ownerUseful: number; ownerWrong: number };
  /** Row 7: `wrong` verdicts on facts, and how many closed the fact within the hour. */
  refutations: { wrong: number; closedWithinHour: number };
  /** Row 12: hours since `since` with ≥ 30 input windows holding a key or a click, and of those, hours the window sensor spoke in. */
  busyHours: number;
  liveBusyHours: number;
  /** Row 8: resolved forecasts per kind — n, mean Brier, and the outcome's base rate. */
  forecasts: { kind: string; n: number; brier: number; base: number }[];
  /** Row 13 (W6 P5): answers to Gnomon's questions, and how many of them the harvest has read. */
  harvest: { answered: number; read: number };
}

export async function getScorecardCounts(since: string): Promise<ScorecardCounts> {
  const db = getDb();
  const [m] = await db.all<{ n: number; over: number; intent: number }>(sql`
    SELECT COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN json_extract(${moments.data}, '$.activeMs') > ${moments.durationMs} THEN 1 ELSE 0 END), 0) AS over,
           COALESCE(SUM(CASE WHEN json_extract(${moments.data}, '$.intent.text') IS NOT NULL AND json_extract(${moments.data}, '$.intent.text') != '' THEN 1 ELSE 0 END), 0) AS intent
      FROM ${moments} WHERE ${moments.startTime} >= ${since}`);
  const verdicts = await db.all<{ verdict: string; owner: number; n: number; closed: number }>(sql`
    SELECT json_extract(s.data, '$.verdict') AS verdict, (e.kind = 'owner') AS owner, COUNT(*) AS n,
           SUM(CASE WHEN f.valid_to IS NOT NULL AND f.superseded_by IS NULL AND julianday(f.valid_to) - julianday(s.captured_at) <= 1.0 / 24 THEN 1 ELSE 0 END) AS closed
      FROM ${signals} s
      JOIN ${entityFacts} f ON f.id = json_extract(s.data, '$.artifactId')
      JOIN ${entities} e ON e.id = f.entity_id
     WHERE s.signal_type = 'feedback' AND s.event_type = 'verdict' AND json_extract(s.data, '$.artifactKind') = 'entity_fact' AND s.captured_at >= ${since}
     GROUP BY 1, 2`);
  const [h] = await db.all<{ busy: number; live: number }>(sql`
    WITH h AS (
      SELECT strftime('%Y-%m-%dT%H', captured_at) AS hour,
             SUM(CASE WHEN signal_type = 'input' AND (json_extract(data, '$.keyDownCount') > 0 OR json_extract(data, '$.mouseClickCount') > 0) THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN signal_type = 'window' THEN 1 ELSE 0 END) AS windows
        FROM ${signals}
       WHERE captured_at >= ${since} AND ((signal_type = 'input' AND event_type = 'activity') OR (signal_type = 'window' AND event_type = 'changed'))
       GROUP BY hour)
    SELECT COALESCE(SUM(active >= 30), 0) AS busy, COALESCE(SUM(active >= 30 AND windows > 0), 0) AS live FROM h`);
  const forecasts = await db.all<{ kind: string; n: number; brier: number; base: number }>(sql`
    SELECT kind, COUNT(*) AS n, AVG((prior_prob - outcome) * (prior_prob - outcome)) AS brier, AVG(outcome) AS base
      FROM predictions WHERE resolved_at >= ${since} GROUP BY kind ORDER BY n DESC`);
  const [a] = await db.all<{ answered: number; read: number }>(sql`
    SELECT COUNT(*) AS answered, COALESCE(SUM(${ownerAsks.proposals} IS NOT NULL), 0) AS read
      FROM ${ownerAsks} WHERE ${ownerAsks.answer} IS NOT NULL AND ${ownerAsks.answeredAt} >= ${since}`);
  const sum = (pick: (r: { verdict: string; owner: number }) => boolean, f: 'n' | 'closed' = 'n') => verdicts.filter(pick).reduce((s, r) => s + (r[f] ?? 0), 0);
  return {
    moments: { n: m?.n ?? 0, activeOver: m?.over ?? 0, withIntent: m?.intent ?? 0 },
    facts: { useful: sum((r) => r.verdict === 'useful'), wrong: sum((r) => r.verdict === 'wrong'), ownerUseful: sum((r) => r.verdict === 'useful' && r.owner === 1), ownerWrong: sum((r) => r.verdict === 'wrong' && r.owner === 1) },
    refutations: { wrong: sum((r) => r.verdict === 'wrong'), closedWithinHour: sum((r) => r.verdict === 'wrong', 'closed') },
    busyHours: h?.busy ?? 0,
    liveBusyHours: h?.live ?? 0,
    forecasts,
    harvest: { answered: a?.answered ?? 0, read: a?.read ?? 0 },
  };
}
