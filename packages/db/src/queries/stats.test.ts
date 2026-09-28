import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertSignal } from './signals.js';
import { insertMoment } from './moments.js';
import { insertKnowledgeEntry } from './knowledge-entries.js';
import { upsertEntity, insertEntityFact } from './entities.js';
import { insertEmbedding } from './embeddings.js';
import { getMemoryTierCounts, getPipelineCoverage, getEmbeddingHealth } from './stats.js';

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
    data text NOT NULL,
    importance_score integer NOT NULL DEFAULT 1,
    last_accessed_at text,
    project_id text
  )`);
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
  await db.run(sql`CREATE TABLE entities (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    canonical_name text NOT NULL,
    aliases_json text NOT NULL DEFAULT '[]',
    created_at text NOT NULL
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

describe('getMemoryTierCounts', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('counts every table independently', async () => {
    await insertSignal({ id: 's1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:00:00.000Z' });
    await insertSignal({ id: 's2', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-01-01T00:01:00.000Z' });
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: {}, importanceScore: 1, projectId: null });
    await insertKnowledgeEntry({ id: 'k1', kind: 'reflection', title: 't', body: 'b', severity: null, dedupeKey: 'dk1', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Xcode', confidence: 91, validFrom: '2026-01-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-01-01T00:00:00.000Z' });

    const counts = await getMemoryTierCounts();

    expect(counts).toEqual({
      signals: 2,
      moments: 1,
      knowledgeEntries: 1,
      entities: 1,
      entityFacts: 1,
    });
  });

  it('returns all zeros for an empty database', async () => {
    expect(await getMemoryTierCounts()).toEqual({
      signals: 0,
      moments: 0,
      knowledgeEntries: 0,
      entities: 0,
      entityFacts: 0,
    });
  });
});

describe('getPipelineCoverage', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('counts moments with an LLM intent and with a project, out of the total', async () => {
    // has intent + project
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { intent: { text: 'refactoring the reducer' } }, importanceScore: 1, projectId: 'project:gnomon' });
    // project, no intent
    await insertMoment({ id: 'm2', startTime: '2026-01-01T00:06:00.000Z', endTime: '2026-01-01T00:08:00.000Z', durationMs: 120_000, processName: 'Code', data: {}, importanceScore: 1, projectId: 'project:gnomon' });
    // neither
    await insertMoment({ id: 'm3', startTime: '2026-01-01T00:09:00.000Z', endTime: '2026-01-01T00:10:00.000Z', durationMs: 60_000, processName: 'Safari', data: { intent: { text: '' } }, importanceScore: 1, projectId: null });

    expect(await getPipelineCoverage()).toEqual({ moments: 3, momentsWithIntent: 1, momentsWithProject: 2 });
  });

  it('returns zeros for an empty database', async () => {
    expect(await getPipelineCoverage()).toEqual({ moments: 0, momentsWithIntent: 0, momentsWithProject: 0 });
  });
});

describe('getEmbeddingHealth', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('flags the hashing-trick fallback as degraded', async () => {
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: [0.1], createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await getEmbeddingHealth()).toEqual({ total: 1, model: 'local-hash-256-v1', hashFallback: true });
  });

  it('reports a real local model as healthy', async () => {
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'ollama-nomic-embed-text-v1', vector: [0.1], createdAt: '2026-01-01T00:00:00.000Z' });
    await insertEmbedding({ id: 'e2', refType: 'moment', refId: 'm2', model: 'ollama-nomic-embed-text-v1', vector: [0.2], createdAt: '2026-01-01T00:01:00.000Z' });
    expect(await getEmbeddingHealth()).toEqual({ total: 2, model: 'ollama-nomic-embed-text-v1', hashFallback: false });
  });

  it('returns null model / not-degraded for an empty database', async () => {
    expect(await getEmbeddingHealth()).toEqual({ total: 0, model: null, hashFallback: false });
  });
});
