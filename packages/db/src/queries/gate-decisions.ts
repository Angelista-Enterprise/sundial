import { asc, eq, gte, lt, and } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { gateDecisions } from '../schemas/db-schema.js';

/** One gate verdict with its arithmetic, as the executor writes it (`RecordGateDecisionEffect`). */
export interface InsertGateDecisionInput {
  id: string;
  noticeKey: string;
  kind: string;
  channel: string;
  reason: string;
  weight: number;
  utility: number;
  surprise: number;
  precision: number;
  habituation: number;
  concern: number;
  interruptionCost: number;
  /**
   * K0.2 — the two bars this decision was weighed against, as the owner's dial
   * left them. `null` on every row written before the column existed, and
   * there is no honest backfill: `noticeBias` at the time of an old row is not
   * stored anywhere. A reader draws such a row as unplaceable rather than
   * against today's line.
   */
  tonicBar?: number | null;
  phasicBar?: number | null;
  decidedAt: string;
}

export type StoredGateDecision = InsertGateDecisionInput & { features?: string | null };

/**
 * J1.6: Jev's features onto the decision row they belong to. A row that does
 * not exist (the gate recorded nothing for this candidate) is left alone.
 * Idempotent: the same features write the same value.
 */
export async function updateGateDecisionFeatures(id: string, features: Record<string, unknown>): Promise<boolean> {
  const result = await getDb().update(gateDecisions).set({ features: JSON.stringify(features) }).where(eq(gateDecisions.id, id));
  return (result as { rowsAffected?: number }).rowsAffected !== 0;
}

/**
 * Records one gate verdict.
 *
 * `onConflictDoNothing`, same rationale as `insertPrediction`: the row is
 * keyed by an id derived from the triggering event + candidate key, so a boot
 * replay re-running the effect offers the identical row, and discarding the
 * second offer is safer than letting a replay overwrite counted history.
 */
export async function insertGateDecision(input: InsertGateDecisionInput): Promise<void> {
  await getDb().insert(gateDecisions).values(input).onConflictDoNothing();
}

/**
 * The day's verdicts in decision order — the read the Unsaid surface (and its
 * `GET /notices/decisions?day=` shape in the almanac page) draws from: said /
 * held / dropped rows with the expandable five-term arithmetic.
 *
 * `fromIso`/`toIso` are ISO-instant bounds on `decidedAt` (`[from, to)`), so a
 * caller can express "one local day" without this layer knowing the timezone.
 */
export async function getGateDecisionsBetween(fromIso: string, toIso: string): Promise<StoredGateDecision[]> {
  return getDb()
    .select()
    .from(gateDecisions)
    .where(and(gte(gateDecisions.decidedAt, fromIso), lt(gateDecisions.decidedAt, toIso)))
    .orderBy(asc(gateDecisions.decidedAt));
}
