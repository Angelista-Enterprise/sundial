import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { purgeDateRange } from './purge.js';

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
  await db.run(sql`CREATE TABLE predictions (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    forecaster text NOT NULL,
    created_at text NOT NULL,
    resolved_at text NOT NULL,
    prior_prob real NOT NULL,
    features text,
    outcome integer NOT NULL,
    surprise real NOT NULL
  )`);
  return db;
}

describe('purgeDateRange', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  /**
   * `predictions` is the one table the daily retention prune deliberately skips
   * — durability is the point of it. A purge is the opposite case: an explicit
   * range delete, and a resolution row does say the owner was active in a given
   * hour on a given date. Leaving it behind would be a hole in the purge.
   */
  it('purges resolved predictions in range by resolvedAt, keeping ones outside it', async () => {
    const db = getDb();
    const cols = `(id, kind, forecaster, created_at, resolved_at, prior_prob, outcome, surprise)`;
    await db.run(sql`INSERT INTO predictions ${sql.raw(cols)} VALUES ('p1', 'day-ending', 'hourly-rate', '2026-01-05T17:00:00.000Z', '2026-01-05T18:00:00.000Z', 0.2, 0, 0.22)`);
    await db.run(sql`INSERT INTO predictions ${sql.raw(cols)} VALUES ('p2', 'day-ending', 'hourly-rate', '2026-06-01T17:00:00.000Z', '2026-06-01T18:00:00.000Z', 0.2, 1, 1.6)`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(result.predictionsDeleted).toBe(1);
    expect(await db.all(sql`SELECT id FROM predictions`)).toEqual([{ id: 'p2' }]);
  });

  it('deletes signals/moments/llm_audit/knowledge_entries within [from, to], keeps rows outside it', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-01-05T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s2', 'window', 'changed', '{}', '2026-06-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m1', '2026-01-05T00:00:00.000Z', '2026-01-05T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m2', '2026-06-01T00:00:00.000Z', '2026-06-01T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO llm_audit (id, purpose, model, prompt, requested_at) VALUES ('l1', 'intent', 'test-model', 'p1', '2026-01-05T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO llm_audit (id, purpose, model, prompt, requested_at) VALUES ('l2', 'intent', 'test-model', 'p2', '2026-06-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO knowledge_entries (id, kind, title, body, dedupe_key, created_at) VALUES ('k1', 'reflection', 't1', 'b1', 'dk1', '2026-01-05T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO knowledge_entries (id, kind, title, body, dedupe_key, created_at) VALUES ('k2', 'reflection', 't2', 'b2', 'dk2', '2026-06-01T00:00:00.000Z')`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(result.signalsDeleted).toBe(1);
    expect(result.momentsDeleted).toBe(1);
    expect(result.llmAuditDeleted).toBe(1);
    expect(result.knowledgeEntriesDeleted).toBe(1);
    expect(await db.all(sql`SELECT id FROM signals`)).toEqual([{ id: 's2' }]);
    expect(await db.all(sql`SELECT id FROM moments`)).toEqual([{ id: 'm2' }]);
    expect(await db.all(sql`SELECT id FROM llm_audit`)).toEqual([{ id: 'l2' }]);
    expect(await db.all(sql`SELECT id FROM knowledge_entries`)).toEqual([{ id: 'k2' }]);
  });

  it('deletes entity_facts whose sourceEventId matches a purged signal, keeps facts sourced from a surviving signal', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-01-05T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s2', 'window', 'changed', '{}', '2026-06-01T00:00:00.000Z')`);
    await db.run(
      sql`INSERT INTO entity_facts (id, entity_id, predicate, object, confidence, valid_from, source_event_id, created_at) VALUES ('f1', 'project:gnomon', 'primaryTool', 'Code', 70, '2026-01-05T00:00:00.000Z', 's1', '2026-01-05T00:00:00.000Z')`,
    );
    await db.run(
      sql`INSERT INTO entity_facts (id, entity_id, predicate, object, confidence, valid_from, source_event_id, created_at) VALUES ('f2', 'project:gnomon', 'primaryTool', 'Warp', 70, '2026-06-01T00:00:00.000Z', 's2', '2026-06-01T00:00:00.000Z')`,
    );
    // A fact with no sourceEventId at all (e.g. hypothetically null) must never match `IN (...)` and should survive.
    await db.run(
      sql`INSERT INTO entity_facts (id, entity_id, predicate, object, confidence, valid_from, source_event_id, created_at) VALUES ('f3', 'project:gnomon', 'deployedVia', 'docker', 80, '2026-01-05T00:00:00.000Z', NULL, '2026-01-05T00:00:00.000Z')`,
    );

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(result.entityFactsDeleted).toBe(1);
    const remaining = await db.all<{ id: string }>(sql`SELECT id FROM entity_facts ORDER BY id`);
    expect(remaining.map((r) => r.id)).toEqual(['f2', 'f3']);
  });

  it('sweeps embeddings orphaned by the purge, keeps embeddings for surviving moments/knowledge entries', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m1', '2026-01-05T00:00:00.000Z', '2026-01-05T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO moments (id, start_time, end_time, duration_ms, process_name, data) VALUES ('m2', '2026-06-01T00:00:00.000Z', '2026-06-01T00:05:00.000Z', 300000, 'Code', '{}')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e1', 'moment', 'm1', 'local-hash-256-v1', '[]', '2026-01-05T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('e2', 'moment', 'm2', 'local-hash-256-v1', '[]', '2026-06-01T00:00:00.000Z')`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(result.embeddingsDeleted).toBe(1);
    expect(await db.all(sql`SELECT id FROM memory_embeddings`)).toEqual([{ id: 'e2' }]);
  });

  it('sweeps an entity_fact embedding orphaned when its fact is purged', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'entity', 'fact-candidate', '{}', '2026-01-05T00:00:00.000Z')`);
    await db.run(
      sql`INSERT INTO entity_facts (id, entity_id, predicate, object, confidence, valid_from, source_event_id, created_at) VALUES ('f1', 'project:gnomon', 'primaryTool', 'Code', 70, '2026-01-05T00:00:00.000Z', 's1', '2026-01-05T00:00:00.000Z')`,
    );
    await db.run(sql`INSERT INTO memory_embeddings (id, ref_type, ref_id, model, vector, created_at) VALUES ('ef1', 'entity_fact', 'f1', 'local-hash-256-v1', '[]', '2026-01-05T00:00:00.000Z')`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');

    expect(result.entityFactsDeleted).toBe(1);
    expect(result.embeddingsDeleted).toBe(1);
    expect(await db.all(sql`SELECT id FROM memory_embeddings`)).toEqual([]);
  });

  it('is a no-op (all zero) for a range containing nothing', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-06-01T00:00:00.000Z')`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    expect(result).toEqual({
      signalsDeleted: 0,
      momentsDeleted: 0,
      embeddingsDeleted: 0,
      llmAuditDeleted: 0,
      knowledgeEntriesDeleted: 0,
      entityFactsDeleted: 0,
      predictionsDeleted: 0,
    });
  });

  it('is inclusive of both endpoints', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s1', 'window', 'changed', '{}', '2026-01-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('s2', 'window', 'changed', '{}', '2026-01-31T00:00:00.000Z')`);

    const result = await purgeDateRange('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
    expect(result.signalsDeleted).toBe(2);
    expect(await db.all(sql`SELECT id FROM signals`)).toEqual([]);
  });
});
