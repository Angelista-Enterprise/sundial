import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BACKFILL_MANIFEST } from '@sundial/rules/manifest.js';
import { findRepos, readCommits, readMeetings, runBackfill } from './backfill.js';
import { initializeDatabase, resetDb } from '@sundial/db/index.js';

const root = mkdtempSync(path.join(tmpdir(), 'sundial-backfill-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function repo(rel: string, email: string | null): string {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  git('init', '-q');
  if (email) git('config', 'user.email', email);
  git('config', 'user.name', 'Owner');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  git('add', '.');
  git('-c', 'user.email=owner@example.com', 'commit', '-qm', 'first: add a');
  writeFileSync(path.join(dir, 'b.txt'), 'x\n');
  git('add', '.');
  git('-c', 'user.email=someone@example.com', 'commit', '-qm', 'someone else');
  return dir;
}

describe('back-fill', () => {
  const mine = repo('code/mine', 'owner@example.com');
  repo('code/deep/a/b/c/too-deep', 'owner@example.com');
  mkdirSync(path.join(root, 'code/node_modules/pkg/.git'), { recursive: true });

  it('finds repos up to three folders down, not inside node_modules', async () => {
    const found = await findRepos([path.join(root, 'code')]);
    expect(found.map((p) => path.basename(p))).toEqual(['mine']);
  });

  it("reads only the repo's own user.email, at the commit's real time, marked backfill", async () => {
    const commits = await readCommits(mine, 30);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.payload).toMatchObject({ insertions: 2, deletions: 0, filesChanged: 1, cwd: mine, backfill: true });
    expect(String(commits[0]!.payload.commitLine)).toMatch(/^[0-9a-f]{7,} first: add a$/);
    expect(Date.now() - Date.parse(commits[0]!.ts)).toBeLessThan(60_000);
    expect(await readCommits(mine, 0)).toEqual([]);
  });

  it('keeps ended meetings the owner attended, and says null without Calendar access', async () => {
    const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const pastEnd = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const ev = (over: object) => ({ eventId: 'e', title: 't', startDate: past, endDate: pastEnd, isAllDay: false, attendees: [], ...over });
    const read = async () => ({
      timestamp: new Date().toISOString(),
      accessGranted: true,
      events: [ev({ eventId: 'kept' }), ev({ eventId: 'allday', isAllDay: true }), ev({ eventId: 'not-mine', isSelfAttendee: false }), ev({ eventId: 'running', endDate: future })],
    });
    const meetings = await readMeetings(7, read as never);
    expect(meetings?.map((m) => (m.payload.event as { eventId: string }).eventId)).toEqual(['kept']);
    expect(meetings?.[0]!.payload.backfill).toBe(true);
    expect(await readMeetings(7, (async () => ({ timestamp: '', accessGranted: false, events: [] })) as never)).toBeNull();
    expect(await readMeetings(7, (async () => null) as never)).toBeNull();
  });

  it('folds a back-filled event only through rules that are true about the past', () => {
    expect(BACKFILL_MANIFEST.map((r) => r.name)).toEqual(['entityExtract']);
  });

  it('W6 D7: a back-filled row keeps its real time as its ts and says when it was appended (observedAt)', async () => {
    const env = { ...process.env };
    process.env.DATABASE_URL = `file:${path.join(root, 'backfill.db')}`;
    resetDb();
    await initializeDatabase();
    try {
      const appended: { type: string; payload: Record<string, unknown>; ts?: string }[] = [];
      const before = new Date().toISOString();
      await runBackfill({ roots: [path.join(root, 'code')], gitDays: 30, calendarDays: 0, mailDays: 0 }, async (type, payload, ts) => void appended.push({ type, payload, ts }));
      const commit = appended.find((a) => a.type === 'git:commit')!;
      expect(commit.ts).toBe(commit.payload.timestamp);
      expect(String(commit.payload.observedAt) >= before).toBe(true);
      expect(commit.payload).toMatchObject({ backfill: true });
    } finally {
      resetDb();
      process.env = env;
    }
  });
});

