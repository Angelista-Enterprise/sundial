import { describe, it, expect, beforeEach, vi } from 'vitest';
import { momentModelTag } from '@sundial/helpers/moment-embed-text.js';
import { sql } from 'drizzle-orm';
import { computeLocalEmbedding } from '@sundial/memory/index.js';
import { getDb, resetDb } from '../db-client.js';
import { insertMoment } from './moments.js';
import { getAllEmbeddings, insertEmbedding } from './embeddings.js';
import { insertEntityFact, supersedeEntityFact, upsertEntity } from './entities.js';
import { reembedStaleEmbeddings } from './embedding-backfill.js';

// Pin the embedding backend to the deterministic hash fallback so "current
// scheme" is a fixed, known tag (local-hash-256-v1) regardless of whether the
// machine running the test has a local model reachable.
vi.mock('@sundial/memory/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sundial/memory/index.js')>();
  return { ...actual, computeEmbedding: async (text: string) => ({ vector: actual.computeLocalEmbedding(text), model: actual.LOCAL_EMBEDDING_MODEL }) };
});

const CURRENT = 'local-hash-256-v1';
const STALE = 'local-minilm-384-v1';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL, start_time text NOT NULL, end_time text NOT NULL,
    duration_ms integer NOT NULL, process_name text NOT NULL, data text NOT NULL,
    importance_score integer NOT NULL DEFAULT 1, last_accessed_at text, project_id text
  )`);
  await db.run(sql`CREATE TABLE knowledge_entries (
    id text PRIMARY KEY NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL,
    structured text, severity text, dedupe_key text NOT NULL, source_event_id text,
    created_at text NOT NULL, importance_score integer NOT NULL DEFAULT 5, last_accessed_at text,
    retracted_at text
  )`);
  await db.run(sql`CREATE UNIQUE INDEX idx_knowledge_entries_dedupe ON knowledge_entries (dedupe_key)`);
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL, ref_type text NOT NULL, ref_id text NOT NULL,
    model text NOT NULL, vector blob NOT NULL, created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE entities (
    id text PRIMARY KEY NOT NULL, kind text NOT NULL, canonical_name text NOT NULL,
    aliases_json text NOT NULL DEFAULT '[]', created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE entity_facts (
    id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, predicate text NOT NULL, object text NOT NULL,
    confidence integer NOT NULL, alpha real NOT NULL DEFAULT 1, beta real NOT NULL DEFAULT 1,
    valid_from text NOT NULL, valid_to text, superseded_by text, source_event_id text, created_at text NOT NULL,
    provenance text NOT NULL DEFAULT 'inference'
  )`);
  return db;
}

async function addMoment(id: string) {
  await insertMoment({
    id,
    startTime: '2026-07-01T10:00:00.000Z',
    endTime: '2026-07-01T10:30:00.000Z',
    durationMs: 1_800_000,
    processName: 'Code',
    data: { processName: 'Code', windowTitles: [`task ${id}`] },
    importanceScore: 5,
    projectId: null,
  });
}

describe('reembedStaleEmbeddings', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('is a no-op when every embedding already matches the current scheme', async () => {
    await addMoment('m1');
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: momentModelTag(CURRENT), vector: computeLocalEmbedding('Code task m1'), createdAt: '2026-07-01T10:30:00.000Z' });

    const result = await reembedStaleEmbeddings();

    expect(result).toMatchObject({ currentModel: CURRENT, reembedded: 0, orphaned: 0, remaining: 0 });
  });

  it('re-embeds a stale-scheme row forward to the current scheme', async () => {
    await addMoment('m1');
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: STALE, vector: computeLocalEmbedding('Code task m1'), createdAt: '2026-07-01T10:30:00.000Z' });

    const result = await reembedStaleEmbeddings();

    expect(result).toMatchObject({ reembedded: 1, orphaned: 0, remaining: 0 });
    const [row] = await getAllEmbeddings();
    expect(row.model).toBe(momentModelTag(CURRENT));
  });

  it('re-embeds a moment built from an older version of its text, in the same vector space', async () => {
    await addMoment('m1');
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: CURRENT, vector: computeLocalEmbedding('Code task m1'), createdAt: '2026-07-01T10:30:00.000Z' });
    const result = await reembedStaleEmbeddings();
    expect(result).toMatchObject({ reembedded: 1 });
    expect((await getAllEmbeddings())[0].model).toBe(momentModelTag(CURRENT));
    expect(await reembedStaleEmbeddings()).toMatchObject({ reembedded: 0, remaining: 0 });
  });

  it('drops a stale row whose ref no longer resolves instead of re-embedding it', async () => {
    await insertEmbedding({ id: 'e-orphan', refType: 'moment', refId: 'm-gone', model: STALE, vector: computeLocalEmbedding('x'), createdAt: '2026-07-01T10:00:00.000Z' });

    const result = await reembedStaleEmbeddings();

    expect(result).toMatchObject({ reembedded: 0, orphaned: 1 });
    expect(await getAllEmbeddings()).toEqual([]);
  });

  it('drops a stale entity_fact row that has been superseded (no longer current knowledge)', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-07-01T09:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'project:gnomon', predicate: 'primaryTool', object: 'Code', confidence: 70, validFrom: '2026-07-01T09:00:00.000Z', sourceEventId: 'src1', createdAt: '2026-07-01T09:00:00.000Z' });
    await insertEmbedding({ id: 'e1', refType: 'entity_fact', refId: 'f1', model: STALE, vector: computeLocalEmbedding('gnomon primaryTool Code'), createdAt: '2026-07-01T09:00:00.000Z' });
    await supersedeEntityFact('f1', 'f2', '2026-07-02T09:00:00.000Z');

    const result = await reembedStaleEmbeddings();

    expect(result).toMatchObject({ reembedded: 0, orphaned: 1 });
    expect(await getAllEmbeddings()).toEqual([]);
  });

  it('processes at most `limit` rows per run and reports the remainder', async () => {
    for (let i = 0; i < 3; i++) {
      await addMoment(`m${i}`);
      await insertEmbedding({ id: `e${i}`, refType: 'moment', refId: `m${i}`, model: STALE, vector: computeLocalEmbedding(`Code task m${i}`), createdAt: '2026-07-01T10:30:00.000Z' });
    }

    const result = await reembedStaleEmbeddings(2);

    expect(result).toMatchObject({ reembedded: 2, remaining: 1 });
    const stillStale = (await getAllEmbeddings()).filter((e) => e.model === STALE);
    expect(stillStale).toHaveLength(1);
  });
});
