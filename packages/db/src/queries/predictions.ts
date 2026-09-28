import { desc, gte, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { predictions } from '../schemas/db-schema.js';

export interface InsertPredictionInput {
  id: string;
  kind: string;
  forecaster: string;
  createdAt: string;
  resolvedAt: string;
  priorProb: number;
  features?: Record<string, unknown> | null;
  /** 1 = the predicted event happened. */
  outcome: 0 | 1;
  surprise: number;
  /** K0.3 — the target's base rate before this resolution. `null` = no opponent, never zero. */
  baseProb?: number | null;
}

export interface StoredPrediction {
  id: string;
  kind: string;
  forecaster: string;
  createdAt: string;
  resolvedAt: string;
  priorProb: number;
  features: Record<string, unknown> | null;
  outcome: 0 | 1;
  surprise: number;
}

/**
 * Records one resolution.
 *
 * `onConflictDoNothing` rather than an upsert: the row is keyed by the open
 * prediction's derived id, so a boot replay re-running the effect is offering
 * the identical row. Doing nothing is both cheaper and safer than overwriting —
 * an overwrite would let a later, differently-computed replay silently rewrite
 * history that A08 has already counted.
 */
export async function insertPrediction(input: InsertPredictionInput): Promise<void> {
  await getDb()
    .insert(predictions)
    .values({
      id: input.id,
      kind: input.kind,
      forecaster: input.forecaster,
      createdAt: input.createdAt,
      resolvedAt: input.resolvedAt,
      priorProb: input.priorProb,
      features: input.features == null ? null : JSON.stringify(input.features),
      outcome: input.outcome,
      surprise: input.surprise,
    })
    .onConflictDoNothing();
}

function hydrate(row: typeof predictions.$inferSelect): StoredPrediction {
  let features: Record<string, unknown> | null = null;
  try {
    features = row.features === null ? null : (JSON.parse(row.features) as Record<string, unknown>);
  } catch {
    features = null;
  }
  return {
    id: row.id,
    kind: row.kind,
    forecaster: row.forecaster,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    priorProb: row.priorProb,
    features,
    outcome: row.outcome === 1 ? 1 : 0,
    surprise: row.surprise,
  };
}

/**
 * Resolutions, newest first.
 *
 * `since` is an ISO instant compared against `resolvedAt`. A08 and the
 * evaluation harness both want "everything, or everything recent" rather than a
 * page, so there is no offset — the table is one row per resolution and stays
 * small next to `signals`.
 */
export async function listResolvedPredictions(opts: { kind?: string; since?: string; limit?: number } = {}): Promise<StoredPrediction[]> {
  const db = getDb();
  const conditions = [];
  if (opts.kind !== undefined) conditions.push(sql`${predictions.kind} = ${opts.kind}`);
  if (opts.since !== undefined) conditions.push(gte(predictions.resolvedAt, opts.since));

  const base = db.select().from(predictions);
  const filtered = conditions.length > 0 ? base.where(sql.join(conditions, sql` AND `)) : base;
  const ordered = filtered.orderBy(desc(predictions.resolvedAt));
  const rows = await (opts.limit === undefined ? ordered : ordered.limit(opts.limit));
  return rows.map(hydrate);
}

export interface PredictionTally {
  kind: string;
  forecaster: string;
  n: number;
  hits: number;
  /** Mean Brier score — lower is better. */
  brier: number;
  /**
   * K0.3 — the same three figures over ONLY the rows carrying a past-only
   * baseline, plus that baseline's own Brier.
   *
   * Two populations, kept apart on purpose. `brier` above is over every row;
   * `fairN`/`fairBrier` are over the rows that have an opponent, and
   * `baselineBrier` is what the opponent scored on those same rows. A skill
   * figure that divided the all-rows Brier by the baseline's would be two
   * different populations in one ratio — the exact fault the reliability bins
   * were rebuilt out of, where 500 rows were binned beside a tally of 1,649.
   */
  fairN: number;
  fairBrier: number | null;
  baselineBrier: number | null;
}

/**
 * Per-`(kind, forecaster)` counts, computed in SQL.
 *
 * Separate from `listResolvedPredictions` because the interesting question for
 * a calibration surface is "how many, and how good", and answering it by
 * loading every row to reduce over it in JS gets slower for no reason as the
 * record grows. Both readings exist because A08 needs the individual
 * `priorProb`s for its decile buckets and the Trust rail only needs the tally.
 */
export async function tallyPredictions(): Promise<PredictionTally[]> {
  const rows = await getDb().all<{ kind: string; forecaster: string; n: number; hits: number; brier: number; fairN: number; fairBrier: number | null; baselineBrier: number | null }>(sql`
    SELECT kind,
           forecaster,
           COUNT(*)                                        AS n,
           SUM(outcome)                                    AS hits,
           AVG((prior_prob - outcome) * (prior_prob - outcome)) AS brier,
           -- K0.3: the fair contest, over the rows that have an opponent.
           SUM(CASE WHEN base_prob IS NOT NULL THEN 1 ELSE 0 END)   AS fairN,
           AVG(CASE WHEN base_prob IS NOT NULL THEN (prior_prob - outcome) * (prior_prob - outcome) END) AS fairBrier,
           AVG(CASE WHEN base_prob IS NOT NULL THEN (base_prob  - outcome) * (base_prob  - outcome) END) AS baselineBrier
    FROM predictions
    GROUP BY kind, forecaster
    ORDER BY n DESC`);
  return rows.map((r) => ({
    kind: r.kind,
    forecaster: r.forecaster,
    n: r.n,
    hits: r.hits ?? 0,
    brier: r.brier ?? 0,
    fairN: r.fairN ?? 0,
    fairBrier: r.fairBrier ?? null,
    baselineBrier: r.baselineBrier ?? null,
  }));
}

/** One decile of claimed probability, for one (target, forecaster). */
export interface CalibrationBin {
  kind: string;
  forecaster: string;
  /** 0..9 — the tenth of the probability range the claim fell in. */
  decile: number;
  n: number;
  hits: number;
}

/**
 * Reliability bins, PER FORECASTER, over every resolved prediction.
 *
 * Two faults in the surface this replaces, and both were invisible because the
 * numbers looked reasonable.
 *
 * **It pooled three forecasters into one curve.** `day-ending` bets 910 times
 * at a 4.7% base rate, `hour-fragmented` 568 times at 20.8%, `project-touched`
 * 165 times at 37%. Averaged into one set of deciles, the result is not a
 * calibration curve for anything — it is three curves laid on top of each
 * other, and the shape it produces belongs to whichever forecaster bets most.
 * Calibration is a property OF a forecaster; there is no such thing as the
 * calibration of a card.
 *
 * **And it binned the most recent 500 rows while the tally beside it counted
 * all 1,649.** Two figures on one card, describing two different populations,
 * with nothing saying so. Aggregating in SQL removes both the truncation and
 * the 200KB of rows that made the truncation tempting.
 */
export async function getCalibrationBins(): Promise<CalibrationBin[]> {
  const rows = await getDb().all<{ kind: string; forecaster: string; decile: number; n: number; hits: number }>(sql`
    SELECT kind,
           forecaster,
           MIN(9, CAST(prior_prob * 10 AS INTEGER)) AS decile,
           COUNT(*)                                 AS n,
           SUM(outcome)                             AS hits
    FROM predictions
    WHERE outcome IS NOT NULL
    GROUP BY kind, forecaster, decile
    ORDER BY kind, forecaster, decile`);
  return rows.map((r) => ({ kind: r.kind, forecaster: r.forecaster, decile: r.decile, n: r.n, hits: r.hits ?? 0 }));
}
