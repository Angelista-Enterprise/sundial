import { gte, inArray, isNull, lt, desc, and, eq, sql } from 'drizzle-orm';
import { localDayRange } from '@sundial/helpers/local-day.js';
import { getDb } from '../db-client.js';
import { knowledgeEntries } from '../schemas/db-schema.js';

export interface InsertKnowledgeEntryInput {
  id: string;
  kind: string;
  title: string;
  body: string;
  /** Stringified structured form (daily journals only) — see the schema comment. */
  structured?: string | null;
  severity: string | null;
  dedupeKey: string;
  sourceEventId: string | null;
  createdAt: string;
  importanceScore?: number;
}

export interface StoredKnowledgeEntry {
  id: string;
  kind: string;
  title: string;
  body: string;
  structured: string | null;
  severity: string | null;
  dedupeKey: string;
  sourceEventId: string | null;
  createdAt: string;
  importanceScore: number;
  lastAccessedAt: string | null;
  /** Set when the owner said this entry was wrong; null for every uncorrected entry. See `retractKnowledgeEntry`. */
  retractedAt: string | null;
}

/**
 * `onConflictDoNothing` on `dedupeKey` (a real unique index, not just an
 * app-level check) — a repeat insight is a harmless no-op, matching WCS's
 * upsert-or-skip semantics. Returns whether a new row was actually
 * inserted, so the caller (the effect executor) can tell a real new
 * insight from a silently-skipped repeat.
 */
export async function insertKnowledgeEntry(input: InsertKnowledgeEntryInput): Promise<boolean> {
  const db = getDb();
  const result = await db.insert(knowledgeEntries).values(input).onConflictDoNothing({ target: knowledgeEntries.dedupeKey });
  return result.rowsAffected > 0;
}

/**
 * The owner said this entry was wrong — stamp `retractedAt` and leave every
 * other column alone.
 *
 * Not a delete, for the reason `retractEntityFact` gives about facts: the row
 * is the record that Gnomon claimed this, and a correction is itself
 * information. What changes is retrievability — `scoredSearch` treats a
 * retracted entry the way it treats a superseded fact, sweeping its embedding
 * so the claim cannot be handed to a later question as evidence.
 *
 * `WHERE retracted_at IS NULL` makes a replay a no-op rather than moving the
 * timestamp of a retraction that already happened; the effect is delivered
 * at-least-once.
 */
export async function retractKnowledgeEntry(id: string, retractedAt: string): Promise<void> {
  const db = getDb();
  await db
    .update(knowledgeEntries)
    .set({ retractedAt })
    .where(and(eq(knowledgeEntries.id, id), isNull(knowledgeEntries.retractedAt)));
}

/** Single entry by id — for `gnomon search`'s result display. */
export async function getKnowledgeEntryById(id: string): Promise<StoredKnowledgeEntry | null> {
  const db = getDb();
  const [row] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, id));
  return row ?? null;
}

/**
 * P6 — single entry by its unique `dedupeKey` (e.g. `daily:2026-07-20`). The
 * daily journal's `createdAt` is the day-boundary timestamp (the *next* day),
 * so it can't be found by "created on date X"; its dedupeKey encodes the
 * logical date, so `GET /daily` looks it up this way.
 */
export async function getKnowledgeEntryByDedupeKey(dedupeKey: string): Promise<StoredKnowledgeEntry | null> {
  const db = getDb();
  const [row] = await db.select().from(knowledgeEntries).where(eq(knowledgeEntries.dedupeKey, dedupeKey));
  return row ?? null;
}

/**
 * P6 — delete the entry with this `dedupeKey`, returning whether one existed.
 * Backs the daily journal's regenerate (`gnomon journal --force` / the UI
 * button): the `dedupeKey daily:<date>` insert is a no-op on conflict, so an
 * overwrite deletes the old row first. The old row's embedding becomes orphaned
 * and is swept by `scoredSearch`/retention — no separate embedding delete.
 */
export async function deleteKnowledgeEntryByDedupeKey(dedupeKey: string): Promise<boolean> {
  const db = getDb();
  const result = await db.delete(knowledgeEntries).where(eq(knowledgeEntries.dedupeKey, dedupeKey));
  return result.rowsAffected > 0;
}

/**
 * D2 (docs/audit/production-proposal-and-enhancements.md, fixes A§2.2) —
 * one `IN (...)` query for every `knowledge_entry`-typed embedding hit
 * `scoredSearch` needs to resolve, instead of a `getKnowledgeEntryById`
 * round-trip per row.
 */
export async function getKnowledgeEntriesByIds(ids: string[]): Promise<StoredKnowledgeEntry[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  return db.select().from(knowledgeEntries).where(inArray(knowledgeEntries.id, ids));
}

/**
 * Entries created on `date` (YYYY-MM-DD) in `timeZone`, most recent first — for
 * `gnomon doctor`, `buildDailyContext`, and the `gnomon_anomalies` tool.
 *
 * The owner's day, not UTC's, per
 * `almanac/decisions/day-boundaries-use-owner-timezone`. Fixed alongside
 * `getSignalsForDate` rather than after it: `buildDailyContext` calls both, and
 * one day-level query on a UTC boundary beside another on a local one produces a
 * context that quietly disagrees with itself about which day it describes.
 *
 * Defaults to `'UTC'` for the same reason `getMomentsForDate` does — a query in
 * `@sundial/db` does not read the owner's configuration.
 */
export async function getKnowledgeEntriesForDate(date: string, timeZone = 'UTC'): Promise<StoredKnowledgeEntry[]> {
  const db = getDb();
  const { start, end } = localDayRange(date, timeZone);
  return db
    .select()
    .from(knowledgeEntries)
    .where(and(gte(knowledgeEntries.createdAt, start), lt(knowledgeEntries.createdAt, end)))
    .orderBy(desc(knowledgeEntries.createdAt));
}

/** Entries created at or after `since` (ISO timestamp), most recent first — feeds `memoryReflection`'s synthesis pass. */
export async function getKnowledgeEntriesSince(since: string): Promise<StoredKnowledgeEntry[]> {
  const db = getDb();
  return db.select().from(knowledgeEntries).where(gte(knowledgeEntries.createdAt, since)).orderBy(desc(knowledgeEntries.createdAt));
}

/**
 * Multiplies every entry's `importanceScore` by `factor` (§5's decay) —
 * reflection/companion-insight rows only; `entity_facts` (core memory) never
 * decay.
 *
 * The integer cast is gone for the same reason it is gone from
 * `decayMomentScores`: truncating each day collapsed low scores to the floor of
 * 1 in one step and pinned them there, instead of the intended two-week half
 * life. See that function for the measurement.
 */
export async function decayKnowledgeScores(factor: number): Promise<void> {
  const db = getDb();
  await db.run(sql`UPDATE knowledge_entries SET importance_score = MAX(1, importance_score * ${factor})`);
}

/** Bumps `lastAccessedAt` — an LRU-like signal for `gnomon search` hits, independent of decay. */
export async function touchKnowledgeAccess(id: string, accessedAt: string): Promise<void> {
  const db = getDb();
  await db.update(knowledgeEntries).set({ lastAccessedAt: accessedAt }).where(eq(knowledgeEntries.id, id));
}

/** D2 (fixes A§2.2) — one `UPDATE ... WHERE id IN (...)` for every knowledge-entry hit `scoredSearch` returns, instead of a `touchKnowledgeAccess` round-trip per hit. */
export async function touchKnowledgeAccessBatch(ids: string[], accessedAt: string): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.update(knowledgeEntries).set({ lastAccessedAt: accessedAt }).where(inArray(knowledgeEntries.id, ids));
}
