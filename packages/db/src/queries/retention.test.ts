import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { deleteRowsOlderThan, deleteSignalsOlderThan, trimAuditBodies } from './retention.js';

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

describe('deleteSignalsOlderThan — sensitive apps', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('deletes screens whose app name or bundle id matches, whatever the display language, and keeps the rest', async () => {
    const db = getDb();
    const row = (id: string, type: string, data: Record<string, unknown>) =>
      db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES (${id}, ${type}, 'ocr', ${JSON.stringify(data)}, '2026-07-01T00:00:00.000Z')`);
    await row('s1', 'screen', { processName: 'Wachtwoorden', bundleId: 'com.apple.Passwords' });
    await row('s2', 'screen', { processName: 'loginwindow', bundleId: null });
    await row('s3', 'screen', { processName: 'Code', bundleId: 'com.microsoft.VSCode' });
    await row('s4', 'window', { processName: 'loginwindow' });

    expect(await deleteSignalsOlderThan('2026-07-17T00:00:00.000Z', ['screen'], { apps: ['passwords', 'loginwindow'] })).toBe(2);
    expect(await db.all(sql`SELECT id FROM signals ORDER BY id`)).toEqual([{ id: 's3' }, { id: 's4' }]);
    // Idempotent: a second run finds nothing.
    expect(await deleteSignalsOlderThan('2026-07-17T00:00:00.000Z', ['screen'], { apps: ['passwords', 'loginwindow'] })).toBe(0);
  });
});

describe('deleteSignalsOlderThan — event types', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('sweeps only the named event types of a signal type', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('t1', 'audio', 'transcript', '{}', '2026-07-01T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('t2', 'audio', 'transcript', '{}', '2026-07-16T00:00:00.000Z')`);
    await db.run(sql`INSERT INTO signals (id, signal_type, event_type, data, captured_at) VALUES ('d1', 'audio', 'device-changed', '{}', '2026-07-01T00:00:00.000Z')`);
    expect(await deleteSignalsOlderThan('2026-07-10T00:00:00.000Z', ['audio'], { eventTypes: ['transcript'] })).toBe(1);
    expect(await db.all(sql`SELECT id FROM signals ORDER BY id`)).toEqual([{ id: 'd1' }, { id: 't2' }]);
  });
});

describe('trimAuditBodies (Q10)', () => {
  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run(sql`ALTER TABLE llm_audit ADD COLUMN response_content text`);
    await db.run(sql`CREATE TABLE applied_effects (event_id text NOT NULL, effect_index integer NOT NULL, applied_at text NOT NULL, status text DEFAULT 'completed' NOT NULL, PRIMARY KEY(event_id, effect_index))`);
  });

  it('clears old prompt and response text but keeps the row; deletes only old completed journal rows', async () => {
    const db = getDb();
    await db.run(sql`INSERT INTO llm_audit (id, purpose, model, prompt, requested_at, response_content) VALUES ('old', 'judge', 'm', 'a long prompt', '2026-08-01T00:00:00.000Z', 'an answer'), ('new', 'judge', 'm', 'a new prompt', '2026-09-20T00:00:00.000Z', 'x')`);
    await db.run(sql`INSERT INTO applied_effects (event_id, effect_index, applied_at, status) VALUES ('e1', 0, '2026-08-01T00:00:00.000Z', 'completed'), ('e2', 0, '2026-08-01T00:00:00.000Z', 'failed'), ('e3', 0, '2026-09-20T00:00:00.000Z', 'completed')`);
    expect(await trimAuditBodies('2026-09-01T00:00:00.000Z')).toEqual({ llmBodiesCleared: 1, effectsDeleted: 1 });
    expect(await db.all(sql`SELECT id, prompt, response_content AS response FROM llm_audit ORDER BY id`)).toEqual([
      { id: 'new', prompt: 'a new prompt', response: 'x' },
      { id: 'old', prompt: '', response: null },
    ]);
    expect(await db.all(sql`SELECT event_id AS id FROM applied_effects ORDER BY event_id`)).toEqual([{ id: 'e2' }, { id: 'e3' }]);
    // A second run finds nothing to clear.
    expect(await trimAuditBodies('2026-09-01T00:00:00.000Z')).toEqual({ llmBodiesCleared: 0, effectsDeleted: 0 });
  });
});
