import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertEmbedding, getAllEmbeddings, deleteEmbeddingsByIds } from './embeddings.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    model text NOT NULL,
    vector blob NOT NULL,
    created_at text NOT NULL
  )`);
  return db;
}

describe('embeddings', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('insertEmbedding + getAllEmbeddings round-trips the vector as a real number array, not a JSON string', async () => {
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: [0.1, 0.2, 0.3], createdAt: '2026-01-01T00:00:00.000Z' });

    const rows = await getAllEmbeddings();
    expect(rows).toHaveLength(1);
    const { vector, ...rest } = rows[0];
    expect(rest).toEqual({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', createdAt: '2026-01-01T00:00:00.000Z' });
    // D1 (fixes A§5.4) — stored as a packed Float32Array (32-bit precision,
    // ~7 significant digits), not a JSON string of the original 64-bit
    // doubles, so exact equality isn't the right assertion here.
    expect(vector).toHaveLength(3);
    vector.forEach((v, i) => expect(v).toBeCloseTo([0.1, 0.2, 0.3][i], 6));
  });

  it('D1: reads a pre-migration row whose vector is still a JSON-text string (SQLite manifest typing — a schema change does not retroactively convert already-stored values)', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e-old', 'moment', 'm1', 'local-hash-256-v1', '[0.4,0.5,0.6]', '2026-01-01T00:00:00.000Z')`);

    const rows = await getAllEmbeddings();
    expect(rows).toEqual([{ id: 'e-old', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: [0.4, 0.5, 0.6], createdAt: '2026-01-01T00:00:00.000Z' }]);
  });

  describe('D2: deleteEmbeddingsByIds', () => {
    it('deletes exactly the given ids in one query, keeps the rest', async () => {
      await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: [1], createdAt: '2026-01-01T00:00:00.000Z' });
      await insertEmbedding({ id: 'e2', refType: 'moment', refId: 'm2', model: 'local-hash-256-v1', vector: [1], createdAt: '2026-01-01T00:00:00.000Z' });
      await insertEmbedding({ id: 'e3', refType: 'moment', refId: 'm3', model: 'local-hash-256-v1', vector: [1], createdAt: '2026-01-01T00:00:00.000Z' });

      const deleted = await deleteEmbeddingsByIds(['e1', 'e3']);

      expect(deleted).toBe(2);
      const remaining = await getAllEmbeddings();
      expect(remaining.map((r) => r.id)).toEqual(['e2']);
    });

    it('is a no-op (0 deleted, no query) for an empty id list', async () => {
      await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: [1], createdAt: '2026-01-01T00:00:00.000Z' });
      expect(await deleteEmbeddingsByIds([])).toBe(0);
      expect(await getAllEmbeddings()).toHaveLength(1);
    });
  });
});
