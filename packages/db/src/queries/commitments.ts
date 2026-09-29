import { asc, desc, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { commitments } from '../schemas/db-schema.js';

export interface CommitmentRowInput {
  id: string;
  name: string;
  source: string;
  branch: string;
  projectId: string | null;
  projectName: string | null;
  openedAt: string;
  lastTouchedAt: string;
  touches: number;
  activeDays: number;
  closedAt: string | null;
  closedBecause: string | null;
  /** UC1: a promise's terms; null on a branch thread. Stored as JSON. */
  promise?: object | null;
}

export type StoredCommitment = Omit<CommitmentRowInput, 'promise'> & { promise: Record<string, unknown> | null };

function parsePromise(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const stored = (rows: (typeof commitments.$inferSelect)[]): StoredCommitment[] => rows.map((row) => ({ ...row, promise: parsePromise(row.promise) }));

/**
 * Upsert by id.
 *
 * `openedAt` is deliberately NOT in the update set. A replay re-offers the row
 * from the same derived id, and the opening instant is the one field that must
 * never move — a thread that appears to have opened later than it did is a
 * thread whose whole span reads wrong. Everything else is a running total and
 * the latest write is the correct one.
 */
export async function upsertCommitment(input: CommitmentRowInput): Promise<void> {
  const row = { ...input, promise: input.promise ? JSON.stringify(input.promise) : null };
  await getDb()
    .insert(commitments)
    .values(row)
    .onConflictDoUpdate({
      target: commitments.id,
      set: {
        name: row.name,
        branch: row.branch,
        projectId: row.projectId,
        projectName: row.projectName,
        lastTouchedAt: row.lastTouchedAt,
        touches: row.touches,
        activeDays: row.activeDays,
        closedAt: row.closedAt,
        closedBecause: row.closedBecause,
        promise: row.promise,
      },
    });
}

/** Open threads, most recently touched first — the order a person would want to be reminded in. */
export async function getOpenCommitments(limit = 20): Promise<StoredCommitment[]> {
  return stored(await getDb().select().from(commitments).where(isNull(commitments.closedAt)).orderBy(desc(commitments.lastTouchedAt)).limit(limit));
}

/**
 * Threads that span more than one day — the ones A12 is actually about.
 *
 * A branch touched once for an afternoon is not "a piece of work I left last
 * week"; counting it would let the ambition be met by ordinary churn.
 */
export async function getMultiDayCommitments(limit = 50): Promise<StoredCommitment[]> {
  return stored(
    await getDb()
      .select()
      .from(commitments)
      .where(sql`${commitments.activeDays} > 1`)
      .orderBy(desc(commitments.activeDays), asc(commitments.openedAt))
      .limit(limit),
  );
}

/** UC1: every promise, open and closed, newest first — what reliability per person is counted from. */
export async function getPromises(limit = 500): Promise<StoredCommitment[]> {
  return stored(await getDb().select().from(commitments).where(sql`${commitments.promise} IS NOT NULL`).orderBy(desc(commitments.openedAt)).limit(limit));
}
