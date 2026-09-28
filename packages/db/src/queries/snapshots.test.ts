import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertSnapshot, getLatestSnapshot } from './snapshots.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE kernel_state_snapshots (
    id text PRIMARY KEY NOT NULL,
    created_at text NOT NULL,
    state_json text NOT NULL,
    log_offset text NOT NULL
  )`);
  return db;
}

// ULIDs sort lexically with insertion time — these stand in for real ones,
// ordered s01 < s02 < ... so id-ordering behaves the same as it would live.
function id(n: number): string {
  return `s${String(n).padStart(2, '0')}`;
}

describe('insertSnapshot', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('keeps only the most recent 10 snapshots, pruned by id not createdAt', async () => {
    const db = getDb();
    for (let i = 1; i <= 12; i++) {
      await insertSnapshot({ id: id(i), stateJson: '{}', logOffset: `offset-${i}` });
    }

    const remaining = await db.all(sql`SELECT id FROM kernel_state_snapshots ORDER BY id`);
    expect(remaining).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({ id: id(n) })));
  });

  it('does not prune while at or under the retention count', async () => {
    const db = getDb();
    for (let i = 1; i <= 10; i++) {
      await insertSnapshot({ id: id(i), stateJson: '{}', logOffset: `offset-${i}` });
    }

    const remaining = await db.all(sql`SELECT id FROM kernel_state_snapshots`);
    expect(remaining).toHaveLength(10);
  });

  it('is resilient to a createdAt clock step backwards — id ordering still picks the true latest', async () => {
    await insertSnapshot({ id: id(1), stateJson: '{"n":1}', logOffset: 'offset-1' });
    const db = getDb();
    // Simulate an NTP correction: this row's wall-clock createdAt is earlier
    // than id(1)'s even though it was inserted after and has a greater id.
    await db.run(sql`INSERT INTO kernel_state_snapshots (id, created_at, state_json, log_offset)
      VALUES (${id(2)}, '2020-01-01T00:00:00.000Z', '{"n":2}', 'offset-2')`);

    const latest = await getLatestSnapshot();
    expect(latest?.id).toBe(id(2));
  });
});
