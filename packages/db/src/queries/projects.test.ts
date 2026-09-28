import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { upsertProject, getProjectByRootPath, getAllProjects } from './projects.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE projects (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    root_path text NOT NULL,
    organization_id text,
    created_at text NOT NULL
  )`);
  return db;
}

describe('upsertProject', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('re-detecting the same project (same root path) updates the row, not a duplicate', async () => {
    await upsertProject({ id: '/repo', name: 'repo', rootPath: '/repo' });
    await upsertProject({ id: '/repo', name: 'repo-renamed', rootPath: '/repo' });

    const all = await getAllProjects();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('repo-renamed');
  });

  it('getProjectByRootPath finds an upserted project', async () => {
    await upsertProject({ id: '/repo', name: 'repo', rootPath: '/repo' });

    const found = await getProjectByRootPath('/repo');

    expect(found?.id).toBe('/repo');
    expect(found?.organizationId).toBeNull();
  });

  it('returns null for a root path that was never detected', async () => {
    const found = await getProjectByRootPath('/never-seen');
    expect(found).toBeNull();
  });
});
