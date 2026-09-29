import { desc, lt, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { kernelStateSnapshots } from '../schemas/db-schema.js';

export interface StoredSnapshot {
  id: string;
  createdAt: string;
  stateJson: string;
  logOffset: string;
}

// A§2.1 — one full-state row per minute, appended forever, is the largest
// table in the DB with only ever one row read back. `id` is a ULID (sorts
// lexically with insertion time) — ordering/pruning by it instead of
// `createdAt` also survives an NTP clock step backwards, which `createdAt`
// (a wall-clock string) does not.
const SNAPSHOT_RETENTION_COUNT = 10;

export async function insertSnapshot(input: { id: string; stateJson: string; logOffset: string }): Promise<void> {
  const db = getDb();
  // Insert + read-top-N + delete-older must be atomic: run concurrently with
  // another snapshot write, an interleaved insert between the read and the
  // delete would shift the cutoff and prune the wrong rows. Explicit
  // BEGIN IMMEDIATE/COMMIT on the one shared connection serializes the whole
  // retain-and-prune (drizzle's `.transaction()` opens a second connection,
  // which an in-memory DB can't share — hence the manual form used here).
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    await db.insert(kernelStateSnapshots).values({
      id: input.id,
      createdAt: new Date().toISOString(),
      stateJson: input.stateJson,
      logOffset: input.logOffset,
    });
    const kept = await db
      .select({ id: kernelStateSnapshots.id })
      .from(kernelStateSnapshots)
      .orderBy(desc(kernelStateSnapshots.id))
      .limit(SNAPSHOT_RETENTION_COUNT);
    if (kept.length === SNAPSHOT_RETENTION_COUNT) {
      const cutoffId = kept[kept.length - 1]!.id;
      await db.delete(kernelStateSnapshots).where(lt(kernelStateSnapshots.id, cutoffId));
    }
    await db.run(sql`COMMIT`);
  } catch (error) {
    await db.run(sql`ROLLBACK`);
    throw error;
  }
}

export async function getLatestSnapshot(): Promise<StoredSnapshot | null> {
  const db = getDb();
  const rows = await db.select().from(kernelStateSnapshots).orderBy(desc(kernelStateSnapshots.id)).limit(1);
  return rows[0] ?? null;
}
