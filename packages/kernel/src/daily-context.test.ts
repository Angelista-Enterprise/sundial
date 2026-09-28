import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, resetDb, insertMoment, insertSignal, upsertProject, insertKnowledgeEntry } from '@sundial/db/index.js';
import { buildDailyContext } from './daily-context.js';

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
  await db.run(sql`CREATE TABLE knowledge_entries (
    id text PRIMARY KEY NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL, structured text, severity text,
    dedupe_key text NOT NULL, source_event_id text, created_at text NOT NULL, importance_score integer NOT NULL DEFAULT 5, last_accessed_at text,
    retracted_at text
  )`);
  await db.run(sql`CREATE UNIQUE INDEX idx_ke_dedupe ON knowledge_entries (dedupe_key)`);
  await db.run(sql`CREATE TABLE projects (
    id text PRIMARY KEY NOT NULL, name text NOT NULL, root_path text NOT NULL, organization_id text, created_at text NOT NULL
  )`);
  return db;
}

const DAY = '2026-07-20';
function ts(hhmm: string): string {
  return `${DAY}T${hhmm}:00.000Z`;
}

interface MomentOpts {
  focusScore?: number;
  focusQuality?: 'deep' | 'steady' | 'shallow';
  kind?: string;
  projectId?: string | null;
  projectConfidence?: 'certain' | 'weak' | null;
  gitCommitCount?: number;
  gitBranch?: string | null;
  typingEventCount?: number;
  narrative?: string | null;
  intent?: string | null;
  micActive?: boolean;
  cameraActive?: boolean;
  calendarActive?: boolean;
  meetingTitle?: string | null;
  meetingAttendees?: string[];
  windowTitles?: string[];
  lifeEvents?: string[];
}

let counter = 0;
async function moment(startHHMM: string, endHHMM: string, process: string, o: MomentOpts = {}, day = DAY): Promise<void> {
  const start = `${day}T${startHHMM}:00.000Z`;
  const end = `${day}T${endHHMM}:00.000Z`;
  const data: Record<string, unknown> = {
    processName: process,
    windowTitles: o.windowTitles ?? [],
    shellCommandCount: 0,
    notableCommands: [],
    gitCommitCount: o.gitCommitCount ?? 0,
    gitBranch: o.gitBranch ?? null,
    calendarActive: o.calendarActive ?? false,
    typingEventCount: o.typingEventCount ?? 0,
    lifeEvents: o.lifeEvents ?? [],
    projectSource: o.projectId ? 'rule-match' : null,
    projectConfidence: o.projectConfidence ?? (o.projectId ? 'weak' : null),
    micActive: o.micActive ?? false,
    cameraActive: o.cameraActive ?? false,
    meetingTitle: o.meetingTitle ?? null,
    meetingAttendees: o.meetingAttendees ?? [],
    kind: o.kind ?? 'setup',
    focusScore: o.focusScore ?? 0,
    focusQuality: o.focusQuality ?? 'shallow',
  };
  if (o.narrative !== undefined) data.narrative = o.narrative;
  if (o.intent !== undefined) data.intent = { status: 'done', text: o.intent };
  await insertMoment({
    id: `m${counter++}`,
    startTime: start,
    endTime: end,
    durationMs: Date.parse(end) - Date.parse(start),
    processName: process,
    data,
    importanceScore: 1,
    projectId: o.projectId ?? null,
  });
}

describe('buildDailyContext', () => {
  beforeEach(async () => {
    await setupTestDb();
    counter = 0;
  });

  it('computes coverage, project distribution, phase mix, and focus mix', async () => {
    await upsertProject({ id: '/p/gnomon', name: 'gnomon', rootPath: '/p/gnomon' });
    await moment('09:00', '11:00', 'Claude', { projectId: '/p/gnomon', focusScore: 0.9, focusQuality: 'deep', kind: 'focus', gitCommitCount: 2, gitBranch: 'main', projectConfidence: 'certain' });
    await moment('11:00', '11:30', 'Google Chrome', { kind: 'browse', focusQuality: 'shallow' });

    const ctx = await buildDailyContext(DAY);
    expect(ctx.coverage.trackedMin).toBe(150);
    expect(ctx.coverage.firstActivity).toBe(ts('09:00'));
    expect(ctx.coverage.lastActivity).toBe(ts('11:30'));
    expect(ctx.projects).toEqual([{ name: 'gnomon', minutes: 120, momentCount: 1, commits: 2, branches: ['main'], confidence: 'certain' }]);
    expect(ctx.noProjectMin).toBe(30);
    expect(ctx.phaseMix.focus).toBe(120);
    expect(ctx.phaseMix.browse).toBe(30);
    expect(ctx.focus.deepMin).toBe(120);
    expect(ctx.focus.shallowMin).toBe(30);
  });

  it('merges casing/alias variants into one project (WCS/wcs)', async () => {
    await upsertProject({ id: '/p/WCS', name: 'WCS', rootPath: '/p/WCS' });
    await moment('09:00', '10:00', 'Claude', { projectId: '/p/WCS' });
    await moment('10:00', '10:30', 'Chrome', { projectId: 'named:wcs' }); // rule-matched browser time
    const ctx = await buildDailyContext(DAY, { projectAliases: { WCS: 'wcs' } });
    expect(ctx.projects).toHaveLength(1);
    expect(ctx.projects[0].name).toBe('wcs');
    expect(ctx.projects[0].minutes).toBe(90);
  });

  it('detects a single long high-focus moment as a deep-work block (the WCS false-negative fix)', async () => {
    await moment('14:20', '16:20', 'Claude', { focusScore: 0.99, focusQuality: 'deep', projectId: '/p/gnomon' });
    const ctx = await buildDailyContext(DAY);
    expect(ctx.deepWorkBlocks).toHaveLength(1);
    expect(ctx.deepWorkBlocks[0].durationMin).toBe(120);
  });

  it('does not count a short high-focus moment as a deep-work block', async () => {
    await moment('09:00', '09:10', 'Claude', { focusScore: 0.9, focusQuality: 'deep' });
    const ctx = await buildDailyContext(DAY);
    expect(ctx.deepWorkBlocks).toHaveLength(0);
  });

  it('builds app-to-app flows from consecutive-moment transitions', async () => {
    await moment('09:00', '09:20', 'Chrome');
    await moment('09:20', '09:40', 'Claude');
    await moment('09:40', '10:00', 'Chrome');
    await moment('10:00', '10:20', 'Claude');
    const ctx = await buildDailyContext(DAY);
    const chromeToClaude = ctx.flows.find((f) => f.from === 'Chrome' && f.to === 'Claude');
    expect(chromeToClaude?.count).toBe(2);
  });

  it('recognizes a real meeting (calendar + attendees) but not a bare calendar event', async () => {
    await moment('09:49', '11:00', 'Google Chrome', { calendarActive: true, meetingAttendees: ['sam', 'ada'], meetingTitle: 'Standup', micActive: true });
    await moment('11:00', '11:30', 'Google Chrome', { calendarActive: true }); // all-day, no attendees → not a meeting
    const ctx = await buildDailyContext(DAY);
    expect(ctx.meetings).toHaveLength(1);
    expect(ctx.meetings[0]).toMatchObject({ title: 'Standup', attendees: ['sam', 'ada'], micOn: true });
  });

  it('reads verbatim search queries from signals, de-duped', async () => {
    await insertSignal({ id: 's1', signalType: 'search', eventType: 'performed', data: { query: 'kuromasu fill strategy', engine: 'google' }, capturedAt: ts('12:31') });
    await insertSignal({ id: 's2', signalType: 'search', eventType: 'performed', data: { query: 'kuromasu fill strategy', engine: 'google' }, capturedAt: ts('12:35') });
    await insertSignal({ id: 's3', signalType: 'search', eventType: 'performed', data: { query: 'planning poker', engine: 'google' }, capturedAt: ts('11:14') });
    const ctx = await buildDailyContext(DAY);
    // chronological: 11:14 before 12:31, and the 12:35 duplicate is dropped
    expect(ctx.searches.map((s) => s.query)).toEqual(['planning poker', 'kuromasu fill strategy']);
  });

  it('classifies breaks: overnight via sleep-wake crossing, lunch, micro', async () => {
    await moment('08:00', '08:30', 'Claude');
    await moment('12:30', '13:00', 'Claude'); // 4h gap → overnight-length, but really lunch-ish; mark by duration
    await moment('13:05', '13:30', 'Claude'); // 5min micro
    const ctx = await buildDailyContext(DAY);
    const kinds = ctx.breaks.map((b) => b.kind);
    // 08:30→12:30 is 240min → overnight bucket by duration; 13:00→13:05 is 5min → micro
    expect(kinds).toContain('overnight');
    expect(kinds).toContain('micro');
    expect(ctx.breaks.find((b) => b.durationMin === 5)?.adjacentApp).toBe('Claude');
  });

  it('tags a gap crossing a system:sleep-wake as overnight even if shorter than the duration floor', async () => {
    await moment('09:00', '09:30', 'Claude');
    await insertSignal({ id: 'sw1', signalType: 'system', eventType: 'sleep-wake', data: { kind: 'sleep' }, capturedAt: ts('09:45') });
    await moment('10:00', '10:30', 'Claude'); // 30min gap but a sleep happened in it
    const ctx = await buildDailyContext(DAY);
    expect(ctx.breaks.find((b) => b.durationMin === 30)?.kind).toBe('overnight');
  });

  it('surfaces today companion-insights as anomalies', async () => {
    await insertKnowledgeEntry({ id: 'k1', kind: 'companion-insight', title: 'Late-night session', body: 'Active at 2am.', severity: 'info', dedupeKey: 'companion:late', sourceEventId: null, createdAt: ts('02:10'), importanceScore: 8 });
    await insertKnowledgeEntry({ id: 'k2', kind: 'reflection', title: 'Daily reflection', body: 'x', severity: 'info', dedupeKey: 'reflection:2026-07-20', sourceEventId: null, createdAt: ts('23:59'), importanceScore: 6 });
    const ctx = await buildDailyContext(DAY);
    expect(ctx.anomalies).toEqual([{ severity: 'info', title: 'Late-night session', body: 'Active at 2am.' }]);
  });

  it('reports continuity for a project also worked yesterday', async () => {
    await upsertProject({ id: '/p/gnomon', name: 'gnomon', rootPath: '/p/gnomon' });
    await moment('09:00', '10:00', 'Claude', { projectId: '/p/gnomon' }, '2026-07-19');
    await moment('09:00', '10:00', 'Claude', { projectId: '/p/gnomon' }, DAY);
    const ctx = await buildDailyContext(DAY);
    expect(ctx.continuity).toEqual([{ project: 'gnomon', carriedFrom: '2026-07-19' }]);
  });

  it('carries narrative + intent onto timeline entries', async () => {
    await moment('09:00', '09:30', 'Claude', { narrative: 'Rebuilt the daemon on develop.', intent: 'rebuilding the daemon' });
    const ctx = await buildDailyContext(DAY);
    expect(ctx.timeline[0].narrative).toBe('Rebuilt the daemon on develop.');
    expect(ctx.timeline[0].intent).toBe('rebuilding the daemon');
  });

  it('aggregates privacy:redacted signals into a per-property redaction audit', async () => {
    await insertSignal({ id: 'p1', signalType: 'privacy', eventType: 'redacted', data: { properties: { windowTitle: 2, url: 1 }, total: 3 }, capturedAt: ts('09:00') });
    await insertSignal({ id: 'p2', signalType: 'privacy', eventType: 'redacted', data: { properties: { windowTitle: 1, cwd: 4 }, total: 5 }, capturedAt: ts('10:00') });
    const ctx = await buildDailyContext(DAY);
    expect(ctx.redactions.total).toBe(8);
    expect(ctx.redactions.byProperty).toEqual({ windowTitle: 3, url: 1, cwd: 4 });
  });

  it('returns empty-but-valid structure for a day with no activity', async () => {
    const ctx = await buildDailyContext(DAY);
    expect(ctx.coverage.trackedMin).toBe(0);
    expect(ctx.projects).toEqual([]);
    expect(ctx.timeline).toEqual([]);
    expect(ctx.meetings).toEqual([]);
  });
});
