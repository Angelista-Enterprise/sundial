import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeLocalEmbedding } from '@sundial/memory/index.js';
import { getDb, resetDb } from '../db-client.js';
import { insertMoment } from './moments.js';
import { insertKnowledgeEntry } from './knowledge-entries.js';
import { insertEmbedding } from './embeddings.js';
import { insertEntityFact, supersedeEntityFact, upsertEntity } from './entities.js';
import { queryNames, scoredSearch } from './scored-search.js';

// D1 (docs/audit/production-proposal-and-enhancements.md, fixes A§5.4) —
// scoredSearch now embeds the query via `computeEmbedding`, which tries a
// real local embedding server before falling back to the hashing trick.
// These tests are about scoredSearch's SQL/ranking logic, not about which
// embedding backend produced a vector, so they pin it to the deterministic
// hash fallback — otherwise they'd be flaky depending on whether the
// machine running them happens to have a local embedding server reachable.
vi.mock('@sundial/memory/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sundial/memory/index.js')>();
  return { ...actual, computeEmbedding: async (text: string) => ({ vector: actual.computeLocalEmbedding(text), model: actual.LOCAL_EMBEDDING_MODEL }) };
});

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
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
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL,
    ref_type text NOT NULL,
    ref_id text NOT NULL,
    model text NOT NULL,
    vector blob NOT NULL,
    created_at text NOT NULL
  )`);
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
  return db;
}

describe('scoredSearch', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('ranks results by score, favoring a relevant hit over an irrelevant one, and bumps lastAccessedAt', async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['debugging the payment webhook'] },
      importanceScore: 5,
      projectId: null,
    });
    await insertMoment({
      id: 'm2',
      startTime: '2026-07-01T14:00:00.000Z',
      endTime: '2026-07-01T14:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Spotify',
      data: { processName: 'Spotify', windowTitles: ['listening to music'] },
      importanceScore: 5,
      projectId: null,
    });
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Code debugging the payment webhook'), createdAt: '2026-07-01T10:30:00.000Z' });
    await insertEmbedding({ id: 'e2', refType: 'moment', refId: 'm2', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Spotify listening to music'), createdAt: '2026-07-01T14:30:00.000Z' });

    const hits = await scoredSearch('payment webhook', 10, '2026-07-01T15:00:00.000Z');

    expect(hits[0].refId).toBe('m1');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);

    const db = getDb();
    const [row] = await db.all<{ last_accessed_at: string }>(sql`SELECT last_accessed_at FROM moments WHERE id = 'm1'`);
    expect(row.last_accessed_at).toBe('2026-07-01T15:00:00.000Z');
  });

  it('includes knowledge_entry hits alongside moments', async () => {
    await insertKnowledgeEntry({
      id: 'k1',
      kind: 'reflection',
      title: 'Payment webhook debugging',
      body: 'Spent the afternoon on the payment webhook.',
      severity: 'info',
      dedupeKey: 'reflection:2026-07-01',
      sourceEventId: null,
      createdAt: '2026-07-01T18:00:00.000Z',
    });
    await insertEmbedding({ id: 'e1', refType: 'knowledge_entry', refId: 'k1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Payment webhook debugging. Spent the afternoon on the payment webhook.'), createdAt: '2026-07-01T18:00:00.000Z' });

    const hits = await scoredSearch('payment webhook', 10, '2026-07-01T19:00:00.000Z');

    expect(hits).toHaveLength(1);
    expect(hits[0].refType).toBe('knowledge_entry');
    expect(hits[0].refId).toBe('k1');
  });

  it('returns an empty array when there are no embeddings yet', async () => {
    expect(await scoredSearch('anything', 10)).toEqual([]);
  });

  it('D2: deletes an orphaned embedding found during the scan (its moment no longer exists) instead of returning/keeping it', async () => {
    await insertEmbedding({ id: 'e-orphan', refType: 'moment', refId: 'm-gone', model: 'local-hash-256-v1', vector: computeLocalEmbedding('anything'), createdAt: '2026-07-01T10:00:00.000Z' });

    const hits = await scoredSearch('anything', 10);

    expect(hits).toEqual([]);
    const db = getDb();
    const remaining = await db.all(sql`SELECT id FROM memory_embeddings`);
    expect(remaining).toEqual([]);
  });

  it('D2: batch-touches lastAccessedAt for every ranked hit of both ref types in one pass', async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['payment webhook'] },
      importanceScore: 5,
      projectId: null,
    });
    await insertKnowledgeEntry({
      id: 'k1',
      kind: 'reflection',
      title: 'payment webhook',
      body: 'payment webhook notes',
      severity: 'info',
      dedupeKey: 'reflection:2026-07-01',
      sourceEventId: null,
      createdAt: '2026-07-01T18:00:00.000Z',
    });
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('payment webhook'), createdAt: '2026-07-01T10:30:00.000Z' });
    await insertEmbedding({ id: 'e2', refType: 'knowledge_entry', refId: 'k1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('payment webhook notes'), createdAt: '2026-07-01T18:00:00.000Z' });

    await scoredSearch('payment webhook', 10, '2026-07-02T00:00:00.000Z');

    const db = getDb();
    const [momentRow] = await db.all<{ last_accessed_at: string }>(sql`SELECT last_accessed_at FROM moments WHERE id = 'm1'`);
    const [entryRow] = await db.all<{ last_accessed_at: string }>(sql`SELECT last_accessed_at FROM knowledge_entries WHERE id = 'k1'`);
    expect(momentRow.last_accessed_at).toBe('2026-07-02T00:00:00.000Z');
    expect(entryRow.last_accessed_at).toBe('2026-07-02T00:00:00.000Z');
  });

  it('D3: includes a current entity_fact hit, joined with its entity for display text', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-07-01T09:00:00.000Z' });
    await insertEntityFact({
      id: 'f1',
      entityId: 'project:gnomon',
      predicate: 'primaryTool',
      object: 'Code',
      confidence: 70,
      validFrom: '2026-07-01T09:00:00.000Z',
      sourceEventId: 'src1',
      createdAt: '2026-07-01T09:00:00.000Z',
    });
    await insertEmbedding({ id: 'e1', refType: 'entity_fact', refId: 'f1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('gnomon primaryTool Code'), createdAt: '2026-07-01T09:00:00.000Z' });

    const hits = await scoredSearch('gnomon primaryTool Code', 10, '2026-07-01T12:00:00.000Z');

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ refType: 'entity_fact', refId: 'f1', text: 'gnomon primaryTool Code' });
  });

  it('D3: sweeps an entity_fact embedding whose fact has since been superseded, same as a genuinely orphaned ref', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-07-01T09:00:00.000Z' });
    await insertEntityFact({
      id: 'f1',
      entityId: 'project:gnomon',
      predicate: 'primaryTool',
      object: 'Code',
      confidence: 70,
      validFrom: '2026-07-01T09:00:00.000Z',
      sourceEventId: 'src1',
      createdAt: '2026-07-01T09:00:00.000Z',
    });
    await insertEmbedding({ id: 'e1', refType: 'entity_fact', refId: 'f1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('gnomon primaryTool Code'), createdAt: '2026-07-01T09:00:00.000Z' });
    await supersedeEntityFact('f1', 'f2', '2026-07-02T09:00:00.000Z');

    const hits = await scoredSearch('gnomon primaryTool Code', 10);

    expect(hits).toEqual([]);
    const db = getDb();
    const remaining = await db.all(sql`SELECT id FROM memory_embeddings`);
    expect(remaining).toEqual([]);
  });

  it('skips an embedding whose model tag differs from the query scheme, without sweeping it as an orphan', async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-01T10:00:00.000Z',
      endTime: '2026-07-01T10:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['payment webhook'] },
      importanceScore: 5,
      projectId: null,
    });
    // Same 256-dim vector the query produces, but tagged as a different
    // scheme — before the model gate this cross-compared and scored; now it
    // must be skipped. Its ref still resolves, so it is NOT deleted either.
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-minilm-384-v1', vector: computeLocalEmbedding('payment webhook'), createdAt: '2026-07-01T10:30:00.000Z' });

    const hits = await scoredSearch('payment webhook', 10);

    expect(hits).toEqual([]);
    const db = getDb();
    const remaining = await db.all(sql`SELECT id FROM memory_embeddings`);
    expect(remaining).toHaveLength(1);
  });

  it('fusion: a rare token the hash embedding cannot place is found by the lexical retriever', async () => {
    // Twenty decoy moments about unrelated prose, one carrying a ticket id in a page path.
    for (let i = 0; i < 20; i++) {
      const text = `Code reading about ${['gardens', 'weather', 'recipes', 'trains', 'music'][i % 5]} number ${i}`;
      await insertMoment({ id: `d${i}`, startTime: `2026-07-01T${String(8 + (i % 10)).padStart(2, '0')}:00:00.000Z`, endTime: `2026-07-01T${String(8 + (i % 10)).padStart(2, '0')}:20:00.000Z`, durationMs: 1_200_000, processName: 'Code', data: { processName: 'Code', windowTitles: [text] }, importanceScore: 5, projectId: null });
      await insertEmbedding({ id: `de${i}`, refType: 'moment', refId: `d${i}`, model: 'local-hash-256-v1', vector: computeLocalEmbedding(text), createdAt: '2026-07-01T10:20:00.000Z' });
    }
    await insertMoment({ id: 'target', startTime: '2026-07-01T19:00:00.000Z', endTime: '2026-07-01T19:30:00.000Z', durationMs: 1_800_000, processName: 'Google Chrome', data: { processName: 'Google Chrome', windowTitles: ['Pull request'], pages: ['github.com/acme/puzzles/pull/689'] }, importanceScore: 5, projectId: null });
    await insertEmbedding({ id: 'te', refType: 'moment', refId: 'target', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Google Chrome Pull request github.com/acme/puzzles/pull/689'), createdAt: '2026-07-01T19:30:00.000Z' });

    const fused = await scoredSearch('puzzles pull 689', 5, '2026-07-01T20:00:00.000Z');
    expect(fused[0].refId).toBe('target');
    // The page path rides in the search text, which is what the lexical pass matched on.
    expect(fused[0].text).toContain('github.com/acme/puzzles/pull/689');
  });

  it('fusion off ranks by the semantic score alone (the measurement baseline)', async () => {
    await insertMoment({ id: 'a', startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:30:00.000Z', durationMs: 1_800_000, processName: 'Code', data: { processName: 'Code', windowTitles: ['payment webhook'] }, importanceScore: 5, projectId: null });
    await insertEmbedding({ id: 'ea', refType: 'moment', refId: 'a', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Code payment webhook'), createdAt: '2026-07-01T10:30:00.000Z' });
    const [semantic] = await scoredSearch('payment webhook', 5, '2026-07-01T11:00:00.000Z', { fusion: false });
    const [fused] = await scoredSearch('payment webhook', 5, '2026-07-01T11:00:00.000Z');
    expect(semantic.refId).toBe('a');
    expect(fused.refId).toBe('a');
    // RRF scores are 1/(k+rank) sums, a different scale from the blended semantic score.
    expect(semantic.score).not.toBe(fused.score);
  });

  it('fusion: one hop out — a query naming a person also surfaces their other facts', async () => {
    await upsertEntity({ id: 'person:priya', kind: 'person', canonicalName: 'Priya', createdAt: '2026-07-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f1', entityId: 'person:priya', predicate: 'worksOn', object: 'gnomon', confidence: 80, validFrom: '2026-07-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-07-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'f2', entityId: 'person:priya', predicate: 'prefersReviewsBefore', object: 'noon', confidence: 70, validFrom: '2026-07-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-07-01T00:00:00.000Z' });
    await insertEmbedding({ id: 'ef1', refType: 'entity_fact', refId: 'f1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Priya worksOn gnomon'), createdAt: '2026-07-01T00:00:00.000Z' });
    await insertEmbedding({ id: 'ef2', refType: 'entity_fact', refId: 'f2', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Priya prefersReviewsBefore noon'), createdAt: '2026-07-01T00:00:00.000Z' });
    for (let i = 0; i < 10; i++) {
      const text = `unrelated moment about ${i} things`;
      await insertMoment({ id: `u${i}`, startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:10:00.000Z', durationMs: 600_000, processName: 'Code', data: { processName: 'Code', windowTitles: [text] }, importanceScore: 5, projectId: null });
      await insertEmbedding({ id: `ue${i}`, refType: 'moment', refId: `u${i}`, model: 'local-hash-256-v1', vector: computeLocalEmbedding(text), createdAt: '2026-07-01T10:10:00.000Z' });
    }
    const hits = await scoredSearch('Priya gnomon', 3, '2026-07-01T11:00:00.000Z');
    const ids = hits.map((h) => h.refId);
    expect(ids).toContain('f1');
    expect(ids).toContain('f2');
  });

  it('M5: a query naming an entity, by name or knownAs alias, ranks that entity first', async () => {
    await upsertEntity({ id: 'person:mira-bakker', kind: 'person', canonicalName: 'Mira Bakker', createdAt: '2026-07-01T00:00:00.000Z' });
    await upsertEntity({ id: 'person:person-0a1b2c3d4e', kind: 'person', canonicalName: 'person-0a1b2c3d4e', createdAt: '2026-07-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'mira', entityId: 'person:mira-bakker', predicate: 'worksOn', object: 'puzzlebox-studio', confidence: 60, validFrom: '2026-06-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-06-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'alias', entityId: 'person:person-0a1b2c3d4e', predicate: 'knownAs', object: 'Tess Puzzlewood', confidence: 100, validFrom: '2026-06-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-06-01T00:00:00.000Z' });
    await insertEntityFact({ id: 'met', entityId: 'person:person-0a1b2c3d4e', predicate: 'attendedMeetingWith', object: 'owner', confidence: 70, validFrom: '2026-06-01T00:00:00.000Z', sourceEventId: null, createdAt: '2026-06-01T00:00:00.000Z' });
    for (const id of ['mira', 'alias', 'met']) await insertEmbedding({ id: `e-${id}`, refType: 'entity_fact', refId: id, model: 'local-hash-256-v1', vector: computeLocalEmbedding(`fact ${id}`), createdAt: '2026-06-01T00:00:00.000Z' });
    // Decoys the embedding and BM25 both like better: recent, and full of the query's words.
    for (let i = 0; i < 12; i++) {
      const text = `who is Mira talking to about Bakker street ${i}`;
      await insertMoment({ id: `n${i}`, startTime: '2026-07-01T10:00:00.000Z', endTime: '2026-07-01T10:10:00.000Z', durationMs: 600_000, processName: 'Code', data: { processName: 'Code', windowTitles: [text] }, importanceScore: 9, projectId: null });
      await insertEmbedding({ id: `ne${i}`, refType: 'moment', refId: `n${i}`, model: 'local-hash-256-v1', vector: computeLocalEmbedding(`Code ${text}`), createdAt: '2026-07-01T10:10:00.000Z' });
    }
    expect((await scoredSearch('Mira Bakker', 5, '2026-07-01T11:00:00.000Z'))[0].refId).toBe('mira');
    const [first, second] = await scoredSearch('who is Tess Puzzlewood?', 5, '2026-07-01T11:00:00.000Z');
    expect([first.refId, second.refId].sort()).toEqual(['alias', 'met']);
  });

  it('M5: a one-word name names only a query that is exactly it; a longer name, a whole-word run', () => {
    expect(queryNames('  Mira? ', 'mira')).toBe(true);
    expect(queryNames('is Mira free today', 'Mira')).toBe(false);
    expect(queryNames('who is Mira Bakker?', 'Mira Bakker')).toBe(true);
    expect(queryNames('who is Mira Bakkerson', 'Mira Bakker')).toBe(false);
    expect(queryNames('ab', 'ab')).toBe(false);
  });

  it('respects the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await insertMoment({
        id: `m${i}`,
        startTime: `2026-07-0${i + 1}T10:00:00.000Z`,
        endTime: `2026-07-0${i + 1}T10:30:00.000Z`,
        durationMs: 1_800_000,
        processName: 'Code',
        data: { processName: 'Code', windowTitles: [`task ${i}`] },
        importanceScore: 5,
        projectId: null,
      });
      await insertEmbedding({ id: `e${i}`, refType: 'moment', refId: `m${i}`, model: 'local-hash-256-v1', vector: computeLocalEmbedding(`task ${i}`), createdAt: `2026-07-0${i + 1}T10:30:00.000Z` });
    }

    const hits = await scoredSearch('task', 2);
    expect(hits).toHaveLength(2);
  });
});
