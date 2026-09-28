import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb } from '../db-client.js';
import { insertMoment, mergeMomentData, getMomentsForDate, getMomentsForProject, getMomentsByIds, touchMomentAccessBatch, getMomentCountsByProject, getLocationDayCounts, getMomentsMentioning } from './moments.js';

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
  return db;
}

describe('mergeMomentData', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('merges a patch into an existing moment without clobbering other data fields', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: ['index.ts'] }, importanceScore: 2, projectId: null });

    await mergeMomentData('m1', { intent: { status: 'done', text: 'Fixed a bug.', analyzedAt: '2026-01-01T00:06:00.000Z' } });

    const [moment] = await getMomentsForDate('2026-01-01');
    expect(moment.data).toEqual({
      processName: 'Code',
      windowTitles: ['index.ts'],
      intent: { status: 'done', text: 'Fixed a bug.', analyzedAt: '2026-01-01T00:06:00.000Z' },
    });
  });

  it('applying two separate patches (intent then narrative) keeps both', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 2, projectId: null });

    await mergeMomentData('m1', { intent: { status: 'done', text: 'intent text' } });
    await mergeMomentData('m1', { narrative: 'narrative text' });

    const [moment] = await getMomentsForDate('2026-01-01');
    expect(moment.data.intent).toEqual({ status: 'done', text: 'intent text' });
    expect(moment.data.narrative).toBe('narrative text');
  });

  it('is a no-op for a moment id that does not exist (e.g. pruned before the LLM call resolved)', async () => {
    await expect(mergeMomentData('does-not-exist', { intent: { status: 'done' } })).resolves.toBeUndefined();
  });
});

describe('getMomentsForProject', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('returns only moments for the given project, most recent first', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: '/x/gnomon' });
    await insertMoment({ id: 'm2', startTime: '2026-01-02T00:00:00.000Z', endTime: '2026-01-02T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: '/x/gnomon' });
    await insertMoment({ id: 'm3', startTime: '2026-01-03T00:00:00.000Z', endTime: '2026-01-03T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: '/x/other' });

    const rows = await getMomentsForProject('/x/gnomon');
    expect(rows.map((r) => r.id)).toEqual(['m2', 'm1']);
  });
});

describe('D2: getMomentsByIds / touchMomentAccessBatch', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('getMomentsByIds resolves exactly the requested ids, in one IN (...) query, ignoring unknown ids', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'm2', startTime: '2026-01-02T00:00:00.000Z', endTime: '2026-01-02T00:05:00.000Z', durationMs: 300_000, processName: 'Warp', data: { processName: 'Warp', windowTitles: [] }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'm3', startTime: '2026-01-03T00:00:00.000Z', endTime: '2026-01-03T00:05:00.000Z', durationMs: 300_000, processName: 'Slack', data: { processName: 'Slack', windowTitles: [] }, importanceScore: 1, projectId: null });

    const rows = await getMomentsByIds(['m1', 'm3', 'm-does-not-exist']);
    expect(rows.map((r) => r.id).sort()).toEqual(['m1', 'm3']);
  });

  it('getMomentsByIds returns [] for an empty id list without querying', async () => {
    expect(await getMomentsByIds([])).toEqual([]);
  });

  it('touchMomentAccessBatch sets the same accessedAt on every id in one UPDATE', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'm2', startTime: '2026-01-02T00:00:00.000Z', endTime: '2026-01-02T00:05:00.000Z', durationMs: 300_000, processName: 'Warp', data: { processName: 'Warp', windowTitles: [] }, importanceScore: 1, projectId: null });

    await touchMomentAccessBatch(['m1', 'm2'], '2026-06-01T00:00:00.000Z');

    const db = getDb();
    const rows = await db.all<{ last_accessed_at: string }>(sql`SELECT last_accessed_at FROM moments ORDER BY id`);
    expect(rows.map((r) => r.last_accessed_at)).toEqual(['2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z']);
  });

  it('touchMomentAccessBatch is a no-op for an empty id list', async () => {
    await expect(touchMomentAccessBatch([], '2026-06-01T00:00:00.000Z')).resolves.toBeUndefined();
  });
});

describe('getMomentCountsByProject', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('groups moment counts by project, including moments with no project', async () => {
    await insertMoment({ id: 'm1', startTime: '2026-01-01T00:00:00.000Z', endTime: '2026-01-01T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: '/x/gnomon' });
    await insertMoment({ id: 'm2', startTime: '2026-01-02T00:00:00.000Z', endTime: '2026-01-02T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: '/x/gnomon' });
    await insertMoment({ id: 'm3', startTime: '2026-01-03T00:00:00.000Z', endTime: '2026-01-03T00:05:00.000Z', durationMs: 300_000, processName: 'Code', data: { processName: 'Code', windowTitles: [] }, importanceScore: 1, projectId: null });

    const counts = await getMomentCountsByProject();

    expect(counts).toEqual(
      expect.arrayContaining([
        { projectId: '/x/gnomon', count: 2 },
        { projectId: null, count: 1 },
      ]),
    );
  });

  it('returns an empty array when there are no moments', async () => {
    expect(await getMomentCountsByProject()).toEqual([]);
  });
});

describe('getLocationDayCounts (Phase 5 #6)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  it('counts distinct days per location bucket, ignoring unlabeled moments', async () => {
    await insertMoment({ id: 'a1', startTime: '2026-01-01T09:00:00.000Z', endTime: '2026-01-01T10:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { location: 'office' }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'a2', startTime: '2026-01-01T11:00:00.000Z', endTime: '2026-01-01T12:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { location: 'office' }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'a3', startTime: '2026-01-02T09:00:00.000Z', endTime: '2026-01-02T10:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { location: 'office' }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'h1', startTime: '2026-01-03T09:00:00.000Z', endTime: '2026-01-03T10:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { location: 'home' }, importanceScore: 1, projectId: null });
    await insertMoment({ id: 'u1', startTime: '2026-01-04T09:00:00.000Z', endTime: '2026-01-04T10:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { processName: 'Code' }, importanceScore: 1, projectId: null });

    expect(await getLocationDayCounts('2026-01-01T00:00:00.000Z')).toEqual([
      { location: 'office', days: 2 },
      { location: 'home', days: 1 },
    ]);
  });

  it('honors the `from` cutoff', async () => {
    await insertMoment({ id: 'old', startTime: '2025-12-01T09:00:00.000Z', endTime: '2025-12-01T10:00:00.000Z', durationMs: 3_600_000, processName: 'Code', data: { location: 'office' }, importanceScore: 1, projectId: null });
    expect(await getLocationDayCounts('2026-01-01T00:00:00.000Z')).toEqual([]);
  });
});

describe('getMomentsMentioning (W4)', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  const put = (id: string, at: string, data: Record<string, unknown>) =>
    insertMoment({ id, startTime: at, endTime: at, durationMs: 60_000, processName: 'Arc', data: { processName: 'Arc', ...data }, importanceScore: 1, projectId: null });

  it('says WHERE a name appeared, newest first, and counts every hit', async () => {
    // The entity card asked the retriever and kept moment hits; a similarity
    // search on a person returns facts, so it said "No moments near it" about
    // someone named in thirteen. A meeting and a name on screen are different
    // evidence, so each hit carries which it was.
    await put('a', '2026-09-01T10:00:00.000Z', { meetingAttendees: ['Alexm', 'Pat Doe'] });
    await put('b', '2026-09-02T10:00:00.000Z', { screenExcerpt: 'comment by Alexm on BOX-484' });
    await put('c', '2026-09-03T10:00:00.000Z', { spokenExcerpt: 'we asked Alexm about it', intent: { text: 'Call with Alexm' } });
    const found = await getMomentsMentioning(['Alexm'], 2);
    expect(found.total).toBe(3);
    expect(found.byPlace).toEqual({ meeting: 1, screen: 1, said: 1, reading: 1 });
    expect(found.moments.map((m) => m.id), 'newest first, and the page is only the page').toEqual(['c', 'b']);
    expect(found.moments[0].where).toEqual(['said', 'reading']);
  });

  it('matches whole words only, and refuses names too short to mean anything', async () => {
    // "Alex" is not "Alexm", and a two-letter name matches everything.
    await put('a', '2026-09-01T10:00:00.000Z', { screenExcerpt: 'Alexm wrote' });
    expect((await getMomentsMentioning(['Alex'])).total).toBe(0);
    expect((await getMomentsMentioning(['An'])).total).toBe(0);
  });
});
