import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from './db-client.js';
import { resetAllData } from './db-migrate.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE projects (id text PRIMARY KEY NOT NULL, name text NOT NULL)`);
  await db.run(sql`CREATE TABLE moments (id text PRIMARY KEY NOT NULL, process_name text NOT NULL)`);
  // Simulates drizzle's own migration-tracking table — must survive a reset.
  await db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL)`);
  return db;
}

describe('resetAllData', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('empties every real table but keeps the schema (row count 0, table still exists)', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO projects (id, name) VALUES ('p1', 'test')`);
    await db.run(sql`INSERT INTO moments (id, process_name) VALUES ('m1', 'Code')`);

    const cleared = await resetAllData();

    expect(cleared.sort()).toEqual(['moments', 'projects']);
    const projects = await db.all(sql`SELECT * FROM projects`);
    const moments = await db.all(sql`SELECT * FROM moments`);
    expect(projects).toHaveLength(0);
    expect(moments).toHaveLength(0);
  });

  it("does not touch drizzle's own migration-tracking table", async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO __drizzle_migrations (id, hash) VALUES (1, 'abc')`);

    await resetAllData();

    const rows = await db.all(sql`SELECT * FROM __drizzle_migrations`);
    expect(rows).toHaveLength(1);
  });

  it('is a no-op (returns an empty list) against a DB with no data tables', async () => {
    resetDb();
    const db = getDb('file::memory:');
    await db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL)`);

    const cleared = await resetAllData();
    expect(cleared).toEqual([]);
  });
});
