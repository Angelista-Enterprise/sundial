import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb, insertMoment, upsertProject } from '@sundial/db/index.js';
import { buildProjectStatusContext } from './project-context.js';
import { serializeProjectStatusContext } from './project-status-prompt.js';

async function setupTestDb() {
  resetDb();
  const db = getDb('file::memory:');
  await db.run(sql`CREATE TABLE moments (
    id text PRIMARY KEY NOT NULL, start_time text NOT NULL, end_time text NOT NULL, duration_ms integer NOT NULL,
    process_name text NOT NULL, data text NOT NULL, importance_score integer NOT NULL DEFAULT 1, last_accessed_at text, project_id text
  )`);
  await db.run(sql`CREATE TABLE projects (
    id text PRIMARY KEY NOT NULL, name text NOT NULL, root_path text NOT NULL, organization_id text, created_at text NOT NULL
  )`);
  return db;
}

let counter = 0;
async function moment(
  startISO: string,
  endISO: string,
  process: string,
  o: { projectId?: string | null; focusScore?: number; focusQuality?: 'deep' | 'steady' | 'shallow'; kind?: string; gitCommitCount?: number; gitBranch?: string | null; narrative?: string | null; intent?: string | null } = {},
): Promise<void> {
  const data: Record<string, unknown> = {
    processName: process,
    windowTitles: [],
    notableCommands: [],
    gitCommitCount: o.gitCommitCount ?? 0,
    gitBranch: o.gitBranch ?? null,
    lifeEvents: [],
    kind: o.kind ?? 'setup',
    focusScore: o.focusScore ?? 0,
    focusQuality: o.focusQuality ?? 'shallow',
  };
  if (o.narrative !== undefined) data.narrative = o.narrative;
  if (o.intent !== undefined) data.intent = { status: 'done', text: o.intent };
  await insertMoment({
    id: `m${counter++}`,
    startTime: startISO,
    endTime: endISO,
    durationMs: Date.parse(endISO) - Date.parse(startISO),
    processName: process,
    data,
    importanceScore: 1,
    projectId: o.projectId ?? null,
  });
}

describe('buildProjectStatusContext', () => {
  beforeEach(async () => {
    await setupTestDb();
    counter = 0;
  });

  it('returns null for an unknown / empty project', async () => {
    expect(await buildProjectStatusContext('/p/nope')).toBeNull();
  });

  it('aggregates totals, commits, branches, phase mix, momentum, and recent narratives', async () => {
    await upsertProject({ id: '/p/gnomon', name: 'gnomon', rootPath: '/p/gnomon', organizationId: 'Acme' });
    // Two days of activity so momentum has two points and daysActive === 2.
    await moment('2026-07-19T09:00:00.000Z', '2026-07-19T11:00:00.000Z', 'Claude', { projectId: '/p/gnomon', focusScore: 0.9, focusQuality: 'deep', kind: 'focus', gitCommitCount: 2, gitBranch: 'main', narrative: 'Reworked the reducer.' });
    await moment('2026-07-20T10:00:00.000Z', '2026-07-20T10:30:00.000Z', 'Chrome', { projectId: '/p/gnomon', kind: 'browse', gitBranch: 'feat/x', intent: 'Reviewed a PR.' });

    const ctx = await buildProjectStatusContext('/p/gnomon');
    expect(ctx).not.toBeNull();
    expect(ctx!.name).toBe('gnomon');
    expect(ctx!.org).toBe('Acme');
    expect(ctx!.totalTrackedMin).toBe(150);
    expect(ctx!.momentCount).toBe(2);
    expect(ctx!.commits).toBe(2);
    expect(ctx!.branches).toEqual(['main', 'feat/x']);
    expect(ctx!.span.daysActive).toBe(2);
    expect(ctx!.phaseMix.focus).toBe(120);
    expect(ctx!.phaseMix.browse).toBe(30);
    expect(ctx!.focus.deepMin).toBe(120);
    expect(ctx!.momentum).toHaveLength(2);
    // Recent is newest-first: the browse moment's intent, then the focus moment's narrative.
    expect(ctx!.recent.map((r) => r.text)).toEqual(['Reviewed a PR.', 'Reworked the reducer.']);
  });

  it('serializes into a compact prompt log', async () => {
    await upsertProject({ id: '/p/gnomon', name: 'gnomon', rootPath: '/p/gnomon', organizationId: 'Acme' });
    await moment('2026-07-20T09:00:00.000Z', '2026-07-20T10:00:00.000Z', 'Claude', { projectId: '/p/gnomon', kind: 'focus', gitCommitCount: 1, gitBranch: 'main', narrative: 'Wired the API.' });

    const ctx = await buildProjectStatusContext('/p/gnomon');
    const text = serializeProjectStatusContext(ctx!);
    expect(text).toContain('PROJECT: gnomon · Acme');
    expect(text).toContain('GIT: 1 commit, branches main');
    expect(text).toContain('RECENT (newest first):');
    expect(text).toContain('Wired the API.');
  });
});
