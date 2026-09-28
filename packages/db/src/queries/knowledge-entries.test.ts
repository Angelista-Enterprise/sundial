import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertKnowledgeEntry, getKnowledgeEntriesForDate, getKnowledgeEntriesByIds, touchKnowledgeAccessBatch, getKnowledgeEntryByDedupeKey, deleteKnowledgeEntryByDedupeKey } from './knowledge-entries.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE knowledge_entries (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    structured text,
    severity text,
    dedupe_key text NOT NULL,
    source_event_id text,
    created_at text NOT NULL,
    importance_score integer NOT NULL DEFAULT 5,
    last_accessed_at text,
    retracted_at text
  )`);
  await db.run(sql`CREATE UNIQUE INDEX idx_knowledge_entries_dedupe ON knowledge_entries (dedupe_key)`);
  return db;
}

function entry(overrides: Partial<Parameters<typeof insertKnowledgeEntry>[0]> = {}) {
  return {
    id: 'k1',
    kind: 'anomaly',
    title: 'Unusually high activity',
    body: 'You worked much later than usual.',
    severity: 'info',
    dedupeKey: 'anomaly:high-activity:22',
    sourceEventId: 'e1',
    createdAt: '2026-01-01T22:30:00.000Z',
    ...overrides,
  };
}

describe('insertKnowledgeEntry', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('inserts a new entry and reports it as new', async () => {
    const inserted = await insertKnowledgeEntry(entry());
    expect(inserted).toBe(true);

    const rows = await getKnowledgeEntriesForDate('2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Unusually high activity');
  });

  it('a repeat insert with the same dedupeKey is a harmless no-op, not an error', async () => {
    await insertKnowledgeEntry(entry({ id: 'k1' }));
    const insertedAgain = await insertKnowledgeEntry(entry({ id: 'k2' }));

    expect(insertedAgain).toBe(false);
    const rows = await getKnowledgeEntriesForDate('2026-01-01');
    expect(rows).toHaveLength(1);
  });

  it('a different dedupeKey inserts as a separate entry', async () => {
    await insertKnowledgeEntry(entry({ id: 'k1', dedupeKey: 'a' }));
    await insertKnowledgeEntry(entry({ id: 'k2', dedupeKey: 'b' }));

    const rows = await getKnowledgeEntriesForDate('2026-01-01');
    expect(rows).toHaveLength(2);
  });

  it('getKnowledgeEntriesForDate only returns entries from that date', async () => {
    await insertKnowledgeEntry(entry({ id: 'k1', createdAt: '2026-01-01T22:30:00.000Z' }));
    await insertKnowledgeEntry(entry({ id: 'k2', dedupeKey: 'other', createdAt: '2026-01-02T09:00:00.000Z' }));

    const rows = await getKnowledgeEntriesForDate('2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('k1');
  });

  /**
   * Same defect as `getSignalsForDate`, fixed in the same pass because
   * `buildDailyContext` calls both: one day-level query on a UTC boundary beside
   * another on a local one produces a context that disagrees with itself about
   * which day it is describing.
   */
  it('scopes the day to the owner timezone, so an entry written just after local midnight is on the later day', async () => {
    // 23:30Z on 12 Jan is 00:30 on the 13th in Amsterdam (+01:00 in winter).
    await insertKnowledgeEntry(entry({ id: 'justAfterMidnight', createdAt: '2026-01-12T23:30:00.000Z' }));

    expect((await getKnowledgeEntriesForDate('2026-01-13', 'Europe/Amsterdam')).map((row) => row.id)).toEqual(['justAfterMidnight']);
    expect(await getKnowledgeEntriesForDate('2026-01-12', 'Europe/Amsterdam')).toEqual([]);
    // Unchanged for a caller that passes no zone.
    expect((await getKnowledgeEntriesForDate('2026-01-12')).map((row) => row.id)).toEqual(['justAfterMidnight']);
  });
});

describe('D2: getKnowledgeEntriesByIds / touchKnowledgeAccessBatch', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('getKnowledgeEntriesByIds resolves exactly the requested ids in one IN (...) query, ignoring unknown ids', async () => {
    await insertKnowledgeEntry(entry({ id: 'k1', dedupeKey: 'a' }));
    await insertKnowledgeEntry(entry({ id: 'k2', dedupeKey: 'b' }));
    await insertKnowledgeEntry(entry({ id: 'k3', dedupeKey: 'c' }));

    const rows = await getKnowledgeEntriesByIds(['k1', 'k3', 'k-does-not-exist']);
    expect(rows.map((r) => r.id).sort()).toEqual(['k1', 'k3']);
  });

  it('getKnowledgeEntriesByIds returns [] for an empty id list without querying', async () => {
    expect(await getKnowledgeEntriesByIds([])).toEqual([]);
  });

  it('touchKnowledgeAccessBatch sets the same accessedAt on every id in one UPDATE', async () => {
    await insertKnowledgeEntry(entry({ id: 'k1', dedupeKey: 'a' }));
    await insertKnowledgeEntry(entry({ id: 'k2', dedupeKey: 'b' }));

    await touchKnowledgeAccessBatch(['k1', 'k2'], '2026-06-01T00:00:00.000Z');

    const db = getDb();
    const rows = await db.all<{ last_accessed_at: string }>(sql`SELECT last_accessed_at FROM knowledge_entries ORDER BY id`);
    expect(rows.map((r) => r.last_accessed_at)).toEqual(['2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
  });
});

describe('getKnowledgeEntryByDedupeKey / deleteKnowledgeEntryByDedupeKey (P6 regenerate)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('fetches an entry by its dedupeKey (how the daily journal is found, since createdAt is the next day)', async () => {
    await insertKnowledgeEntry(entry({ id: 'd1', kind: 'daily', dedupeKey: 'daily:2026-07-20', createdAt: '2026-07-21T00:00:01.000Z' }));
    const found = await getKnowledgeEntryByDedupeKey('daily:2026-07-20');
    expect(found?.id).toBe('d1');
    expect(await getKnowledgeEntryByDedupeKey('daily:2026-07-19')).toBeNull();
  });

  it('deletes by dedupeKey and reports whether one existed, enabling overwrite-regenerate', async () => {
    await insertKnowledgeEntry(entry({ id: 'd1', kind: 'daily', dedupeKey: 'daily:2026-07-20' }));
    expect(await deleteKnowledgeEntryByDedupeKey('daily:2026-07-20')).toBe(true);
    expect(await getKnowledgeEntryByDedupeKey('daily:2026-07-20')).toBeNull();
    // a fresh insert with the same dedupeKey now succeeds (was a no-op before delete)
    expect(await insertKnowledgeEntry(entry({ id: 'd2', kind: 'daily', dedupeKey: 'daily:2026-07-20', title: 'rewritten' }))).toBe(true);
    expect((await getKnowledgeEntryByDedupeKey('daily:2026-07-20'))?.title).toBe('rewritten');
  });

  it('returns false when deleting a dedupeKey that does not exist', async () => {
    expect(await deleteKnowledgeEntryByDedupeKey('daily:nope')).toBe(false);
  });
});
