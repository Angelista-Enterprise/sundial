/**
 * The first-run back-fill: the owner's own commits and past meetings, read
 * once, on the owner's word, from `/setup`.
 *
 * A fresh record is empty, so the first question Gnomon can answer well comes
 * hours later. The history that would answer it is already on the Mac: git
 * knows what the owner committed, EventKit knows who they met. This reads that
 * history and writes it through the normal path — sanitize at ingest, the log,
 * the fold — at each event's REAL time, marked `backfill: true`, so the fold
 * sends it only to the rules that are true about the past (`BACKFILL_MANIFEST`).
 *
 * Nothing runs by itself. `planBackfill` only reads and counts; `runBackfill`
 * writes, and skips every commit and meeting the log already holds, so a
 * second run over a wider reach adds only what is new.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRecentSignals, getSignalsInRange } from '@sundial/db/index.js';
import { type CalendarEvent, readCalendarEvents } from '@sundial/sensors/calendar/calendar-capture.js';
import { canonicalizeRepoDir } from '@sundial/sensors/project/project-capture.js';
import { findEnvelopeIndex, mailSince } from '@sundial/sensors/mail/envelope-index.js';
import { sanitizeAtIngest } from '@sundial/helpers/sanitize-at-ingest.js';

const run = promisify(execFile);

/** Where code usually lives on a Mac. Only the ones that exist are offered. */
export const DEFAULT_ROOTS = ['~/Projects', '~/Developer', '~/code', '~/src', '~/dev', '~/repos', '~/work'];
export const MAX_DEPTH = 3;
export const MAX_REPOS = 300;
export const MAX_DAYS = 90;
const SKIP_DIRS = new Set(['node_modules', 'Library', 'vendor', 'Pods', 'dist', 'build']);

export interface BackfillOptions {
  roots: string[];
  gitDays: number;
  calendarDays: number;
  /** Mail from Mail.app's index: sender and subject only. 0 or absent reads none. */
  mailDays?: number;
}

export interface BackfillPlan {
  repos: { path: string; commits: number }[];
  commits: number;
  /** null when Calendar access is not granted (or the helper is off). */
  meetings: number | null;
  /** null when Mail.app has no index, or Full Disk Access is not granted. */
  mails: number | null;
}

export interface BackfillResult {
  repos: number;
  commits: number;
  meetings: number | null;
  mails: number | null;
  skipped: number;
}

interface Commit {
  ts: string;
  payload: Record<string, unknown>;
  key: string;
}
interface Meeting {
  ts: string;
  payload: Record<string, unknown>;
  key: string;
}

export const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);
export const tildify = (p: string) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
const clampDays = (n: number) => Math.max(0, Math.min(MAX_DAYS, Math.floor(Number.isFinite(n) ? n : 0)));

/** The default roots that exist on this Mac, as `~` paths. */
export async function existingDefaultRoots(): Promise<string[]> {
  const found: string[] = [];
  for (const root of DEFAULT_ROOTS) {
    const stat = await fs.stat(expandHome(root)).catch(() => null);
    if (stat?.isDirectory()) found.push(root);
  }
  return found;
}

/** Every git repository under `roots`, at most `MAX_DEPTH` folders down. A repo is not searched inside. */
export async function findRepos(roots: string[]): Promise<string[]> {
  const repos = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (repos.size >= MAX_REPOS) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((e) => e.name === '.git')) {
      repos.add(canonicalizeRepoDir(dir));
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await walk(path.join(dir, e.name), depth + 1);
    }
  };
  for (const root of roots) await walk(expandHome(root.trim()), 0);
  return [...repos].sort();
}

/**
 * The owner's own commits in one repo over the last `days` days, in the shape
 * the live git sensor writes (`commitLine` is `git log --oneline`'s). Only the
 * repo's own `user.email`: a cloned project's history is other people's work.
 */
export async function readCommits(repo: string, days: number): Promise<Commit[]> {
  if (days <= 0) return [];
  const email = (await run('git', ['-C', repo, 'config', 'user.email']).catch(() => ({ stdout: '' }))).stdout.trim();
  if (email === '') return [];
  const { stdout } = await run('git', ['-C', repo, 'log', `--since=${days} days ago`, '--no-merges', `--author=${email}`, '--format=%x1e%h%x1f%aI%x1f%s', '--numstat'], {
    maxBuffer: 32 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const commits: Commit[] = [];
  for (const block of stdout.split('\x1e').slice(1)) {
    const [head, ...lines] = block.split('\n');
    const [hash, date, subject] = (head ?? '').split('\x1f');
    const ms = Date.parse(date ?? '');
    if (!hash || Number.isNaN(ms)) continue;
    let insertions = 0;
    let deletions = 0;
    let filesChanged = 0;
    for (const line of lines) {
      const m = /^(\d+)\s+(\d+)\s+/.exec(line);
      if (!m) continue;
      insertions += Number(m[1]);
      deletions += Number(m[2]);
      filesChanged++;
    }
    const ts = new Date(ms).toISOString();
    const commitLine = `${hash} ${subject ?? ''}`.trim();
    commits.push({ ts, key: hash, payload: { timestamp: ts, commitLine, branch: null, cwd: repo, insertions, deletions, filesChanged, backfill: true } });
  }
  return commits;
}

/** Meetings the owner attended that have ended, over the last `days` days. null = no Calendar access. */
export async function readMeetings(days: number, read = readCalendarEvents): Promise<Meeting[] | null> {
  if (days <= 0) return [];
  const output = await read(0, days);
  if (output === null || output.accessGranted === false) return null;
  const now = Date.now();
  return output.events
    .filter((ev: CalendarEvent) => !ev.isAllDay && ev.isSelfAttendee !== false && Date.parse(ev.endDate) < now)
    .map((ev: CalendarEvent) => {
      const ts = new Date(Date.parse(ev.startDate)).toISOString();
      return { ts, key: `${ev.eventId}|${ev.startDate}`, payload: { timestamp: ts, event: ev, backfill: true } };
    });
}

/**
 * A mail's identity in the log: arrival second and subject, compared in the
 * form the log stores — ingest hashes the sender and can rewrite the subject
 * ("Security alert for [email]"), and a raw subject would never match its row.
 */
const mailKey = (timestamp: unknown, subject: unknown) => `${String(timestamp ?? '').slice(0, 19)}|${String(subject ?? '')}`;

/** Received mail from Mail.app's own index, or null when it cannot be read. */
export async function readMails(days: number): Promise<Meeting[] | null> {
  if (days <= 0) return [];
  const file = findEnvelopeIndex();
  if (file === null) return null;
  try {
    const mails = await mailSince(file, Date.now() - days * 86_400_000, 20_000);
    return mails.map((m) => {
      const payload = { timestamp: m.timestamp, from: m.from, subject: m.subject, backfill: true };
      const stored = sanitizeAtIngest({ id: 'backfill', type: 'mail:received', ts: m.timestamp, payload }).payload;
      return { ts: m.timestamp, key: mailKey(stored.timestamp, stored.subject), payload };
    });
  } catch {
    return null;
  }
}

/** What the log already holds over the window, so a run never writes a commit or a meeting twice. */
async function recordedKeys(sinceMs: number): Promise<{ commits: Set<string>; meetings: Set<string>; mails: Set<string> }> {
  const from = new Date(sinceMs).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const [commitRows, meetingRows, mailRows] = await Promise.all([getSignalsInRange(from, to, 1_000_000, ['git:commit']), getSignalsInRange(from, to, 1_000_000, ['calendar:active']), getSignalsInRange(from, to, 1_000_000, ['mail:received'])]);
  const commits = new Set(commitRows.map((r) => String(r.data.commitLine ?? '').split(' ')[0]).filter(Boolean));
  const meetings = new Set(
    meetingRows.map((r) => {
      const ev = r.data.event as { eventId?: unknown; startDate?: unknown } | undefined;
      return `${String(ev?.eventId ?? '')}|${String(ev?.startDate ?? '')}`;
    }),
  );
  return { commits, meetings, mails: new Set(mailRows.map((r) => mailKey(r.data.timestamp, r.data.subject))) };
}

async function gather(opts: BackfillOptions) {
  const gitDays = clampDays(opts.gitDays);
  const calendarDays = clampDays(opts.calendarDays);
  const repos = await findRepos(opts.roots);
  const perRepo = await Promise.all(repos.map(async (repo) => ({ repo, commits: await readCommits(repo, gitDays) })));
  const meetings = await readMeetings(calendarDays);
  const mailDays = clampDays(opts.mailDays ?? 0);
  const mails = await readMails(mailDays);
  const days = Math.max(gitDays, calendarDays, mailDays);
  const seen = await recordedKeys(Date.now() - days * 86_400_000);
  const fresh = perRepo.map(({ repo, commits }) => ({ repo, commits: commits.filter((c) => !seen.commits.has(c.key)) }));
  const freshMeetings = meetings?.filter((m) => !seen.meetings.has(m.key)) ?? null;
  const freshMails = mails?.filter((m) => !seen.mails.has(m.key)) ?? null;
  const skipped = perRepo.reduce((n, r) => n + r.commits.length, 0) - fresh.reduce((n, r) => n + r.commits.length, 0) + ((meetings?.length ?? 0) - (freshMeetings?.length ?? 0)) + ((mails?.length ?? 0) - (freshMails?.length ?? 0));
  return { fresh, freshMeetings, freshMails, skipped };
}

/** Read and count, write nothing. Repos with nothing new are still listed, with 0. */
export async function planBackfill(opts: BackfillOptions): Promise<BackfillPlan> {
  const { fresh, freshMeetings, freshMails } = await gather(opts);
  return {
    mails: freshMails?.length ?? null,
    repos: fresh.map(({ repo, commits }) => ({ path: tildify(repo), commits: commits.length })),
    commits: fresh.reduce((n, r) => n + r.commits.length, 0),
    meetings: freshMeetings?.length ?? null,
  };
}

/**
 * Write it: every new commit and meeting, oldest first, then one
 * `backfill:run` row that says what was read. `append` is the kernel's own
 * `appendSignal`, so each row is sanitized, logged and folded like any other.
 */
export async function runBackfill(opts: BackfillOptions, append: (type: string, payload: Record<string, unknown>, ts?: string) => Promise<void>): Promise<BackfillResult> {
  const { fresh, freshMeetings, freshMails, skipped } = await gather(opts);
  const rows = [
    ...fresh.flatMap(({ commits }) => commits.map((c) => ({ type: 'git:commit', ...c }))),
    ...(freshMeetings ?? []).map((m) => ({ type: 'calendar:active', ...m })),
    ...(freshMails ?? []).map((m) => ({ type: 'mail:received', ...m })),
  ].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const row of rows) await append(row.type, row.payload, row.ts);
  const result: BackfillResult = {
    repos: fresh.filter((r) => r.commits.length > 0).length,
    commits: fresh.reduce((n, r) => n + r.commits.length, 0),
    meetings: freshMeetings?.length ?? null,
    mails: freshMails?.length ?? null,
    skipped,
  };
  await append('backfill:run', { roots: opts.roots.map((r) => tildify(expandHome(r.trim()))), gitDays: clampDays(opts.gitDays), calendarDays: clampDays(opts.calendarDays), mailDays: clampDays(opts.mailDays ?? 0), ...result });
  return result;
}

/** The last run, for the page: when, and what it wrote. */
export async function lastBackfill(): Promise<(BackfillResult & { at: string }) | null> {
  const [row] = await getRecentSignals(1, 'backfill');
  if (!row) return null;
  const d = row.data as Partial<BackfillResult>;
  return { at: row.capturedAt, repos: Number(d.repos ?? 0), commits: Number(d.commits ?? 0), meetings: typeof d.meetings === 'number' ? d.meetings : null, mails: typeof d.mails === 'number' ? d.mails : null, skipped: Number(d.skipped ?? 0) };
}
