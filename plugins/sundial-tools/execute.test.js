// Execute-path tests: the converted dsh tools run gnomon's real handlers
// against an in-memory db — the same test-db pattern packages/kernel and
// packages/db use (getDb('file::memory:') registers the module singleton the
// handlers reach through their own no-arg getDb() calls, which is exactly how
// they reach the sundial-db plugin's connection at runtime).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb, insertMoment, insertSnapshot, insertEmbedding } from '@sundial/db/index.js';
import { computeLocalEmbedding, LOCAL_EMBEDDING_MODEL } from '@sundial/memory/index.js';
import { ASK_TOOL_REGISTRY } from '@sundial/kernel/tools/index.js';
import { toDshTool } from './to-dsh-tool.js';
import { createHandleCache } from './handles.js';

// Pin the embedding backend to the deterministic hash fallback, same as
// packages/db/src/queries/scored-search.test.ts — these tests are about the
// tool plumbing, not about which embedding server happens to be reachable.
vi.mock('@sundial/memory/index.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    computeEmbedding: async (text) => ({ vector: actual.computeLocalEmbedding(text), model: actual.LOCAL_EMBEDDING_MODEL }),
  };
});

function dshTool(name, deps) {
  const tool = ASK_TOOL_REGISTRY.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no such gnomon tool: ${name}`);
  return toDshTool(tool, deps);
}

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL, start_time text NOT NULL, end_time text NOT NULL, duration_ms integer NOT NULL,
    process_name text NOT NULL, data text NOT NULL, importance_score integer NOT NULL DEFAULT 1, last_accessed_at text, project_id text
  )`);
  await db.run(sql`CREATE TABLE signals (
    id text PRIMARY KEY NOT NULL, signal_type text NOT NULL, event_type text NOT NULL, session_id text, data text NOT NULL, captured_at text NOT NULL
  )`);
  // `gnomon_today_summary` builds on `buildDailyContext`, which resolves project
  // display names — so this table is now part of the tool's read path.
  await db.run(sql`CREATE TABLE projects (
    id text PRIMARY KEY NOT NULL, name text NOT NULL, root_path text NOT NULL, organization_id text, created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE kernel_state_snapshots (
    id text PRIMARY KEY NOT NULL, created_at text NOT NULL, state_json text NOT NULL, log_offset text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE knowledge_entries (
    id text PRIMARY KEY NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL, structured text, severity text,
    dedupe_key text NOT NULL, source_event_id text, created_at text NOT NULL, importance_score integer NOT NULL DEFAULT 5,
    last_accessed_at text, retracted_at text
  )`);
  await db.run(sql`CREATE TABLE memory_embeddings (
    id text PRIMARY KEY NOT NULL, ref_type text NOT NULL, ref_id text NOT NULL, model text NOT NULL, vector blob NOT NULL, created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE entities (
    id text PRIMARY KEY NOT NULL, kind text NOT NULL, canonical_name text NOT NULL, aliases_json text NOT NULL DEFAULT '[]', created_at text NOT NULL
  )`);
  await db.run(sql`CREATE TABLE entity_facts (
    id text PRIMARY KEY NOT NULL, entity_id text NOT NULL, predicate text NOT NULL, object text NOT NULL, confidence integer NOT NULL,
    alpha real NOT NULL DEFAULT 1, beta real NOT NULL DEFAULT 1, valid_from text NOT NULL, valid_to text, superseded_by text,
    source_event_id text, created_at text NOT NULL, provenance text NOT NULL DEFAULT 'inference'
  )`);
  return db;
}

// Midday-UTC timestamps: the handlers read the owner timezone from the real
// ~/.sundial/config.json, and midday UTC lands on the same calendar day for
// any timezone within ±11 hours, so the tests are machine-independent.
const DAY = '2026-07-20';

async function momentAt(id, startHHMM, endHHMM, process, extras = {}) {
  await insertMoment({
    id,
    startTime: `${DAY}T${startHHMM}:00.000Z`,
    endTime: `${DAY}T${endHHMM}:00.000Z`,
    durationMs: 30 * 60 * 1000,
    processName: process,
    data: { processName: process, windowTitles: extras.windowTitles ?? [] },
    importanceScore: 5,
    projectId: extras.projectId ?? null,
  });
}

describe('execute path over the in-memory record', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  describe('gnomon_current_context', () => {
    it('reports the no-snapshot case as a note, not a throw', async () => {
      const value = await dshTool('gnomon_current_context').execute({}, undefined);
      expect(value.note).toContain('No snapshot yet');
    });

    it('answers from the latest snapshot, labelling the ambient pointer', async () => {
      // A partial persisted state: loadLatestSnapshot hydrates the rest
      // through hydrateSnapshot, exactly as it would for a real snapshot
      // written by an older kernel.
      const persisted = {
        device: { id: 'test-device' },
        window: {
          active: { app: 'Code', title: 'schema.js — sundial' },
          previous: null,
          attribution: { projectId: '/Users/o/sundial', source: 'window-locator', confidence: 'certain' },
        },
        project: { current: '/Users/o/sundial', org: null, known: ['/Users/o/sundial'] },
      };
      await insertSnapshot({ id: 's1', stateJson: JSON.stringify(persisted), logOffset: 'sig-001' });

      const value = await dshTool('gnomon_current_context').execute({}, undefined);
      expect(value.window.active.app).toBe('Code');
      expect(value.resolvedProject).toEqual({ projectId: '/Users/o/sundial', source: 'window-locator', confidence: 'certain' });
      expect(value.ambientProjectPointer.current).toBe('/Users/o/sundial');
      expect(value.ambientProjectPointer.note).toContain('Low-confidence fallback');
    });
  });

  describe('gnomon_today_summary', () => {
    it("returns the day's moments for an explicit date", async () => {
      await momentAt('m1', '10:00', '10:30', 'Code');
      await momentAt('m2', '11:00', '11:30', 'Safari');
      await insertMoment({
        id: 'm-other-day',
        startTime: '2026-07-01T12:00:00.000Z',
        endTime: '2026-07-01T12:30:00.000Z',
        durationMs: 30 * 60 * 1000,
        processName: 'Code',
        data: { processName: 'Code', windowTitles: [] },
        importanceScore: 5,
        projectId: null,
      });

      const value = await dshTool('gnomon_today_summary').execute({ date: DAY }, undefined);
      // A summary of the day, keyed by session id — not the `moments` rows. The
      // raw table was 479,384 characters on the live record.
      expect(value.sessions.map((session) => session.id).sort()).toEqual(['m1', 'm2']);
      expect(value.date).toBe(DAY);
    });

    it('renders as the same JSON text the old tool loop showed the model', async () => {
      await momentAt('m1', '10:00', '10:30', 'Code');
      const definition = dshTool('gnomon_today_summary');
      const value = await definition.execute({ date: DAY }, undefined);
      const blocks = definition.output.render({ date: DAY }, value);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].type).toBe('text');
      expect(blocks[0].text).toBe(JSON.stringify(value));
    });
  });

  describe('gnomon_semantic_search', () => {
    it('ranks a relevant moment above an irrelevant one', async () => {
      await momentAt('m1', '10:00', '10:30', 'Code', { windowTitles: ['debugging the payment webhook'] });
      await momentAt('m2', '14:00', '14:30', 'Spotify', { windowTitles: ['listening to music'] });
      await insertEmbedding({
        id: 'e1',
        refType: 'moment',
        refId: 'm1',
        model: LOCAL_EMBEDDING_MODEL,
        vector: computeLocalEmbedding('Code debugging the payment webhook'),
        createdAt: `${DAY}T10:30:00.000Z`,
      });
      await insertEmbedding({
        id: 'e2',
        refType: 'moment',
        refId: 'm2',
        model: LOCAL_EMBEDDING_MODEL,
        vector: computeLocalEmbedding('Spotify listening to music'),
        createdAt: `${DAY}T14:30:00.000Z`,
      });

      const value = await dshTool('gnomon_semantic_search').execute({ query: 'payment webhook', limit: 5 }, undefined);
      expect(value.length).toBeGreaterThan(0);
      expect(value[0].refId).toBe('m1');
    });

    it('returns an empty array when nothing is embedded yet', async () => {
      const value = await dshTool('gnomon_semantic_search').execute({ query: 'anything' }, undefined);
      expect(value).toEqual([]);
    });
  });

  describe('the two intercepted tools (ask.ts capture points)', () => {
    it('gnomon_show_view returns the canonical request AND fires onShowView', async () => {
      const seen = [];
      const definition = dshTool('gnomon_show_view', { onShowView: (shown) => seen.push(shown) });
      const value = await definition.execute({ altitude: 'today', because: 'test drive' }, undefined);
      expect(value.shown.altitude).toBe('today');
      expect(value.shown.because).toBe('test drive');
      expect(seen).toEqual([value.shown]);
    });

    it('gnomon_compose_figure fires onFigure for a real figure, not for a refusal', async () => {
      const figures = [];
      const definition = dshTool('gnomon_compose_figure', { onFigure: (figure) => figures.push(figure) });

      // census always composes (zero counts are a valid census)
      const census = await definition.execute({ kind: 'census' }, undefined);
      expect(census.kind).toBe('census');
      expect(figures).toHaveLength(1);

      // an entity that does not exist → { unavailable }, no capture
      const refusal = await definition.execute({ kind: 'graph-neighborhood', name: 'nobody' }, undefined);
      expect(refusal.unavailable).toContain('nobody');
      expect(figures).toHaveLength(1);
    });
  });

  describe('repeat calls for a finished day', () => {
    // The measured waste this closes: 31 byte-identical repeat calls inside one
    // live session, 104,495 characters of results that said what an earlier
    // copy already said. See handles.js for why the fix only ever APPENDS.
    const SESSION = { agent: { id: 'session-under-test' } };
    const LATER = '2026-07-21';

    it('runs the first call and hands back a handle for the second', async () => {
      const deps = { handles: createHandleCache(), today: () => LATER };
      const definition = dshTool('gnomon_today_summary', deps);

      const first = await definition.execute({ date: DAY }, SESSION);
      const second = await definition.execute({ date: DAY }, SESSION);

      expect(first.unchanged).toBeUndefined();
      expect(second.unchanged).toBe(true);
      expect(second.note).toContain('gnomon_today_summary');
      // The saving, stated as the property that matters.
      expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(first).length);
    });

    it('runs both calls when the day in question is still today', async () => {
      const deps = { handles: createHandleCache(), today: () => DAY };
      const definition = dshTool('gnomon_today_summary', deps);

      const first = await definition.execute({ date: DAY }, SESSION);
      const second = await definition.execute({ date: DAY }, SESSION);

      expect(first.unchanged).toBeUndefined();
      expect(second.unchanged).toBeUndefined();
    });

    it('runs every call when no handle cache is wired, which is the old behaviour', async () => {
      const definition = dshTool('gnomon_today_summary', {});
      const second = await definition.execute({ date: DAY }, SESSION);
      expect(second.unchanged).toBeUndefined();
    });

    it('does not stub a different page of the same day', async () => {
      const deps = { handles: createHandleCache(), today: () => LATER };
      const definition = dshTool('gnomon_today_summary', deps);

      await definition.execute({ date: DAY }, SESSION);
      const page2 = await definition.execute({ date: DAY, offset: 60 }, SESSION);
      expect(page2.unchanged).toBeUndefined();
    });

    it('keeps two sessions independent', async () => {
      const deps = { handles: createHandleCache(), today: () => LATER };
      const definition = dshTool('gnomon_today_summary', deps);

      await definition.execute({ date: DAY }, SESSION);
      const other = await definition.execute({ date: DAY }, { agent: { id: 'another-session' } });
      expect(other.unchanged).toBeUndefined();
    });

    it('never stubs a WRITE tool — a repeated write is a second write', async () => {
      const deps = { handles: createHandleCache(), today: () => LATER };
      const definition = dshTool('gnomon_show_view', deps);

      const first = await definition.execute({ altitude: 'today', because: 'a' }, SESSION);
      const second = await definition.execute({ altitude: 'today', because: 'a' }, SESSION);
      expect(first.shown).toBeDefined();
      expect(second.shown).toBeDefined();
      expect(second.unchanged).toBeUndefined();
    });
  });
});
