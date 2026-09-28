import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { deleteRowsOlderThan } from './retention.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE signals (
    id text PRIMARY KEY NOT NULL,
    signal_type text NOT NULL,
    event_type text NOT NULL,
    session_id text,
    data text NOT NULL,
    captured_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL,
    start_time text NOT NULL,
    end_time text NOT NULL,
    duration_ms integer NOT NULL,
    process_name text NOT NULL,
    data text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE knowledge_entries (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    structured text,
    dedupe_key text NOT NULL,
    created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    model text NOT NULL,
    vector blob NOT NULL,
    created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE llm_audit (
    id text PRIMARY KEY NOT NULL,
    moment_id text,
    purpose text NOT NULL,
    model text NOT NULL,
    prompt text NOT NULL,
    requested_at text NOT NULL,
    success integer NOT NULL DEFAULT 0
  )`);
  await db.run(sql`CREATE TABLE entity_facts (
    id text PRIMARY KEY NOT NULL,
    entity_id text NOT NULL,
    predicate text NOT NULL,
    object text NOT NULL,
    confidence integer NOT NULL,
    alpha real NOT NULL DEFAULT 1,
    beta real NOT NULL DEFAULT 1,
    valid_from text NOT NULL,
    valid_to text,
    superseded_by text,
    source_event_id text,
    created_at text NOT NULL,
    provenance text NOT NULL DEFAULT 'inference'
  )`);
  return db;
}

describe('deleteRowsOlderThan', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('deletes signals older than the cutoff, keeps newer ones', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s2', 'window', 'changed', '{}', '2026-06-01T00:00:00.000Z')`);

    const result = await deleteRowsOlderThan('2026-03-01T00:00:00.000Z');

    expect(result.signalsDeleted).toBe(1);
    const remaining = await db.all(sql`SELECT id FROM signals`);
    expect(remaining).toEqual([{ id: 's2' }]);
  });

  it('deletes moments older than the cutoff by startTime, keeps newer ones', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m2', '2026-06-01T00:00:00.000Z', '2026-06-01T00:05:00.000Z', 300000, 'Code', '{}')`);

    const result = await deleteRowsOlderThan('2026-03-01T00:00:00.000Z');

    expect(result.momentsDeleted).toBe(1);
    const remaining = await db.all(sql`SELECT id FROM moments`);
    expect(remaining).toEqual([{ id: 'm2' }]);
  });

  it('is a no-op (0 deleted) when nothing is older than the cutoff', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-06-01T00:00:00.000Z')`);

    const result = await deleteRowsOlderThan('2026-01-01T00:00:00.000Z');
    expect(result).toEqual({ signalsDeleted: 0, momentsDeleted: 0, embeddingsDeleted: 0, llmAuditDeleted: 0 });
  });

  it('E2: deletes llm_audit rows older than the cutoff by requestedAt, keeps newer ones', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO llm_audit (id, purpose, model, prompt, requested_at) VALUES ('l1', 'intent', 'test-model', 'p1', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO llm_audit (id, purpose, model, prompt, requested_at) VALUES ('l2', 'intent', 'test-model', 'p2', '2026-06-01T00:00:00.000Z')`);

    const result = await deleteRowsOlderThan('2026-03-01T00:00:00.000Z');

    expect(result.llmAuditDeleted).toBe(1);
    const remaining = await db.all(sql`SELECT id FROM llm_audit`);
    expect(remaining).toEqual([{ id: 'l2' }]);
  });

  it('deletes embeddings orphaned by the moment delete above, keeps embeddings for surviving moments/knowledge entries', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m2', '2026-06-01T00:00:00.000Z', '2026-06-01T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO knowledge_entries (id, kind, title, body, dedupe_key, created_at) VALUES ('k1', 'reflection', 't', 'b', 'dk1', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e1', 'moment', 'm1', 'local-hash-256-v1', '[]', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e2', 'moment', 'm2', 'local-hash-256-v1', '[]', '2026-06-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e3', 'knowledge_entry', 'k1', 'local-hash-256-v1', '[]', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e4', 'knowledge_entry', 'k-gone', 'local-hash-256-v1', '[]', '2026-01-01T00:00:00.000Z')`);

    const result = await deleteRowsOlderThan('2026-03-01T00:00:00.000Z');

    expect(result.momentsDeleted).toBe(1);
    expect(result.embeddingsDeleted).toBe(2);
    const remaining = await db.all(sql`SELECT id FROM memory_embeddings ORDER BY id`);
    expect(remaining).toEqual([{ id: 'e2' }, { id: 'e3' }]);
  });
});
