import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { computeLocalEmbedding } from '@sundial/memory/index.js';
import { getDb, resetDb, insertMoment, insertEmbedding, upsertEntity, insertEntityFact, insertSnapshot } from '@sundial/db/index.js';
import { buildContext, buildContextWithTrace } from './context.js';
import { createInitialState } from './initial-state.js';

// Same rationale as scored-search.test.ts: buildContext calls scoredSearch
// under the hood, which embeds the query via computeEmbedding — pin it to
// the deterministic hash fallback so these tests don't depend on whether a
// real local embedding server happens to be reachable on the machine running them.
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
    last_accessed_at text
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
  await db.run(sql`CREATE TABLE kernel_state_snapshots (
    id text PRIMARY KEY NOT NULL,
    created_at text NOT NULL,
    state_json text NOT NULL,
    log_offset text NOT NULL
  )`);
  return db;
}

describe('buildContext (D3)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns an empty array when there is nothing to draw context from', async () => {
    expect(await buildContext('anything', { now: '2026-07-19T12:00:00.000Z' })).toEqual([]);
  });

  it('includes top-K scored search hits', async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-19T09:00:00.000Z',
      endTime: '2026-07-19T09:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['debugging the payment webhook'] },
      importanceScore: 5,
      projectId: null,
    });
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Code debugging the payment webhook'), createdAt: '2026-07-19T09:30:00.000Z' });

    const context = await buildContext('payment webhook', { now: '2026-07-19T09:31:00.000Z' });

    expect(context.some((line) => line.includes('payment webhook'))).toBe(true);
  });

  it("includes current facts for entities named in the query, even if no moment/knowledge embedding ranks the question highly", async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-07-19T09:00:00.000Z' });
    await insertEntityFact({
      id: 'f1',
      entityId: 'project:gnomon',
      predicate: 'primaryTool',
      object: 'Code',
      confidence: 70,
      validFrom: '2026-07-19T09:00:00.000Z',
      sourceEventId: 'src1',
      createdAt: '2026-07-19T09:00:00.000Z',
    });

    const context = await buildContext('what tool am I using on gnomon', { now: '2026-07-19T12:00:00.000Z' });

    expect(context).toContain('gnomon primaryTool Code');
  });

  it('does not surface a superseded fact via the query-token path (only currently-valid facts)', async () => {
    await upsertEntity({ id: 'project:gnomon', kind: 'project', canonicalName: 'gnomon', createdAt: '2026-07-19T09:00:00.000Z' });
    await insertEntityFact({
      id: 'f1',
      entityId: 'project:gnomon',
      predicate: 'primaryTool',
      object: 'Vim',
      confidence: 70,
      validFrom: '2026-07-18T09:00:00.000Z',
      sourceEventId: 'src1',
      createdAt: '2026-07-18T09:00:00.000Z',
    });
    const db = getDb();
    await db.run(sql`UPDATE entity_facts SET valid_to = '2026-07-19T00:00:00.000Z' WHERE id = 'f1'`);

    const context = await buildContext('gnomon', { now: '2026-07-19T12:00:00.000Z' });

    expect(context.some((line) => line.includes('Vim'))).toBe(false);
  });

  it("includes today's summary line when there are moments today", async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-19T09:00:00.000Z',
      endTime: '2026-07-19T09:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['unrelated task'] },
      importanceScore: 5,
      projectId: null,
    });

    const context = await buildContext('anything', { now: '2026-07-19T12:00:00.000Z' });

    expect(context.some((line) => line.startsWith('Today so far:') && line.includes('Code'))).toBe(true);
  });

  it("includes current context from the latest snapshot's active window/project", async () => {
    const state = createInitialState('device-1');
    state.window.active = { processName: 'Terminal', windowTitle: 'gnomon build', windowId: 'w1' };
    state.project.current = { id: 'project:gnomon', name: 'gnomon' };
    await insertSnapshot({ id: 'snap1', stateJson: JSON.stringify(state), logOffset: 'sig1' });

    const context = await buildContext('anything', { now: '2026-07-19T12:00:00.000Z' });

    expect(context.some((line) => line.includes('Right now: Terminal') && line.includes('gnomon build') && line.includes('project: gnomon'))).toBe(true);
  });
});

describe('buildContextWithTrace', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns the same lines buildContext would, plus a 3-step trace and the raw search hits', async () => {
    await insertMoment({
      id: 'm1',
      startTime: '2026-07-19T09:00:00.000Z',
      endTime: '2026-07-19T09:30:00.000Z',
      durationMs: 1_800_000,
      processName: 'Code',
      data: { processName: 'Code', windowTitles: ['debugging the payment webhook'] },
      importanceScore: 5,
      projectId: null,
    });
    await insertEmbedding({ id: 'e1', refType: 'moment', refId: 'm1', model: 'local-hash-256-v1', vector: computeLocalEmbedding('Code debugging the payment webhook'), createdAt: '2026-07-19T09:30:00.000Z' });

    const result = await buildContextWithTrace('payment webhook', { now: '2026-07-19T09:31:00.000Z' });

    expect(result.lines.some((line) => line.includes('payment webhook'))).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]).toMatchObject({ refType: 'moment', refId: 'm1' });
    expect(result.trace.map((step) => step.step)).toEqual(['scoredSearch', 'entityLookup', 'packContext']);
    for (const step of result.trace) {
      expect(step.ms).toBeGreaterThanOrEqual(0);
      expect(step.detail.length).toBeGreaterThan(0);
    }
  });

  it('reports zero hits/entities/facts honestly when there is nothing to draw context from', async () => {
    const result = await buildContextWithTrace('anything', { now: '2026-07-19T12:00:00.000Z' });

    expect(result.lines).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.trace).toEqual([
      { step: 'scoredSearch', ms: expect.any(Number), detail: '0 hits' },
      { step: 'entityLookup', ms: expect.any(Number), detail: '0 entities, 0 facts' },
      { step: 'packContext', ms: expect.any(Number), detail: '0 lines packed' },
    ]);
  });
});
