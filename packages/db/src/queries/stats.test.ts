import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertSignal } from './signals.js';
import { insertMoment } from './moments.js';
import { insertKnowledgeEntry } from './knowledge-entries.js';
import { upsertEntity, insertEntityFact } from './entities.js';
import { insertEmbedding } from './embeddings.js';
import { getMemoryTierCounts, getPipelineCoverage, getEmbeddingHealth, getScorecardCounts } from './stats.js';

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

describe('getScorecardCounts (W5 step 9)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('counts moment integrity, fact verdicts (and the owner\'s), refutations closed within the hour, and busy hours', async () => {
    const db = getDb();
    await insertMoment({ id: 'm1', startTime: '2026-09-20T09:00:00.000Z', endTime: '2026-09-20T09:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { activeMs: 400_000, intent: { text: 'fixing BOX-484' } }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'm2', startTime: '2026-09-20T10:00:00.000Z', endTime: '2026-09-20T10:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { activeMs: 100_000 }, importanceScore: 1, projectId: null });
    await db.run(sql`INSERT INTO entities (id, kind, canonical_name, created_at) VALUES ('e-owner', 'owner', 'Mira Bakker', '2026-09-01'), ('e-p', 'project', 'puzzlebox-studio', '2026-09-01')`);
    const fact = (id: string, entity: string, validTo: string | null) => db.run(sql`INSERT INTO entity_facts (id, entity_id, predicate, object, confidence, valid_from, valid_to, created_at) VALUES (${id}, ${entity}, 'likes', 'tea', 60, '2026-09-01', ${validTo}, '2026-09-01')`);
    await fact('f1', 'e-owner', null);
    await fact('f2', 'e-p', '2026-09-20T12:30:00.000Z');
    await fact('f3', 'e-p', '2026-09-20T15:00:00.000Z');
    const verdict = (id: string, factId: string, v: string, at: string) => insertSignal({ id, signalType: 'feedback', eventType: 'verdict', data: { artifactKind: 'entity_fact', artifactId: factId, verdict: v }, capturedAt: at });
    await verdict('v1', 'f1', 'useful', '2026-09-20T11:00:00.000Z');
    await verdict('v2', 'f2', 'wrong', '2026-09-20T12:00:00.000Z');
    await verdict('v3', 'f3', 'wrong', '2026-09-20T12:00:00.000Z');
    for (let i = 0; i < 30; i++) await insertSignal({ id: `i${i}`, signalType: 'input', eventType: 'activity', data: { keyDownCount: 2 }, capturedAt: `2026-09-20T09:${String(i).padStart(2, '0')}:00.000Z` });
    await insertSignal({ id: 'w1', signalType: 'window', eventType: 'changed', data: {}, capturedAt: '2026-09-20T09:40:00.000Z' });
    for (let i = 0; i < 30; i++) await insertSignal({ id: `j${i}`, signalType: 'input', eventType: 'activity', data: { keyDownCount: 1 }, capturedAt: `2026-09-20T13:${String(i).padStart(2, '0')}:00.000Z` });
    await db.run(sql`CREATE TABLE predictions (id text PRIMARY KEY NOT NULL, kind text NOT NULL, forecaster text NOT NULL, created_at text NOT NULL, resolved_at text NOT NULL, prior_prob real NOT NULL, features text, outcome integer NOT NULL, surprise real NOT NULL, base_prob real)`);
    await db.run(sql`INSERT INTO predictions (id, kind, forecaster, created_at, resolved_at, prior_prob, outcome, surprise) VALUES ('p1', 'day-ending', 'f', '2026-09-20', '2026-09-20T10:00:00.000Z', 0.9, 1, 0), ('p2', 'day-ending', 'f', '2026-09-20', '2026-09-20T11:00:00.000Z', 0.1, 0, 0)`);
    await db.run(sql`CREATE TABLE owner_asks (id text PRIMARY KEY NOT NULL, question text NOT NULL, reason text, asked_at text NOT NULL, answer text, answered_at text, outcome text NOT NULL, proposals text)`);
    const c = await getScorecardCounts('2026-09-01T00:00:00.000Z');
    expect(c.moments).toEqual({ n: 2, activeOver: 1, withIntent: 1 });
    expect(c.facts).toEqual({ useful: 1, wrong: 2, ownerUseful: 1, ownerWrong: 0 });
    expect(c.refutations).toEqual({ wrong: 2, closedWithinHour: 1 });
    expect({ busy: c.busyHours, live: c.liveBusyHours }).toEqual({ busy: 2, live: 1 });
    expect(c.forecasts).toEqual([{ kind: 'day-ending', n: 2, brier: expect.closeTo(0.01, 10), base: 0.5 }]);
    // Row 13 (W6 P5): an answered question the harvest has read, one it has not, one never answered.
    await db.run(sql`INSERT INTO owner_asks (id, question, asked_at, answer, answered_at, outcome, proposals) VALUES ('a1', 'Who is Mira Bakker?', '2026-09-20', 'the BOX-484 lead', '2026-09-20T10:00:00.000Z', 'answered', '[]'), ('a2', 'Which repo?', '2026-09-20', 'puzzlebox-studio', '2026-09-20T11:00:00.000Z', 'answered', NULL), ('a3', 'q', '2026-09-20', NULL, NULL, 'expired', NULL)`);
    expect((await getScorecardCounts('2026-09-01T00:00:00.000Z')).harvest).toEqual({ answered: 2, read: 1 });
  });
});
