/**
 * The signal streams nobody ever aggregated.
 *
 * Gnomon captures far more than it reports. Before this file, the sensors below
 * had written a combined ~7,000 rows into `signals` that no query, route, tool
 * or page had ever read: every switch between two pieces of work, every burst of
 * rapid window flipping, every interruption, every shell command and its exit
 * code, every commit and its churn. The moment pipeline consumed some of them to
 * decide a moment's boundaries and then dropped the detail on the floor.
 *
 * These are deliberately THIN readers, not analytics. Each one returns the
 * minimal projection of one stream over a UTC half-open range, and does no
 * bucketing, no rate arithmetic and no day arithmetic. That work belongs in
 * `@sundial/kernel/work-shape.js`, because it needs the owner's timezone to say
 * what "a day" or "an hour" is, and a timezone belongs to config rather than to
 * SQL (see `packages/helpers/src/local-day.ts` for why).
 *
 * Reading whole rows rather than aggregating in SQL is a sizing decision, not an
 * oversight: the widest of these streams is ~2,400 rows over three weeks, so the
 * cost of pulling them into memory is trivial next to the cost of writing a
 * `strftime`-based day bucket that would silently be a UTC day.
 */
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { signals } from '../schemas/db-schema.js';

/** `[from, to)` in UTC ISO — the shape every reader here takes, matching `localDayRange`'s output. */
export interface UtcRange {
  from: string;
  to: string;
}

/** One JSON field off `signals.data`, typed as text; callers coerce. */
function field(path: string) {
  return sql<string | null>`json_extract(${signals.data}, ${'$.' + path})`;
}

/** Rows of one `signal_type`/`event_type` stream in a range, oldest first. */
function streamQuery(signalType: string, eventType: string, range: UtcRange) {
  return and(eq(signals.signalType, signalType), eq(signals.eventType, eventType), gte(signals.capturedAt, range.from), lt(signals.capturedAt, range.to));
}

export interface ContextSwitchRow {
  ts: string;
  /** Project key moved AWAY from — null when the previous work was unattributed. */
  fromProject: string | null;
  /** Project key moved TO — null when the new work is unattributed. */
  toProject: string | null;
  fromProcess: string | null;
  toProcess: string | null;
}

/**
 * Every recorded switch between two pieces of work.
 *
 * `fromProject`/`toProject` are frequently null, and that is the single most
 * important thing to know before counting them: unattributed activity is common,
 * so `null → null` is NOT a same-project switch, it is two unknowns. The
 * analytic must treat it as neither, which is exactly the missingness trap
 * `guides/measure-forecast-skill` warns about — a feature that tracks whether a
 * value exists will outscore one that describes it.
 */
export async function getContextSwitchesBetween(range: UtcRange): Promise<ContextSwitchRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      ts: signals.capturedAt,
      fromProject: field('fromProject'),
      toProject: field('toProject'),
      fromProcess: field('fromProcess'),
      toProcess: field('toProcess'),
    })
    .from(signals)
    .where(streamQuery('event', 'context-switch', range))
    .orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({ ...row }));
}

export interface ThrashingRow {
  ts: string;
  /**
   * Raw `window:changed` events inside the burst's window.
   *
   * NOT a count of switches, despite the name, and that is why `flips` exists:
   * 56% of the record's `window:changed` events are one app re-titling its own
   * window, so this number counts a terminal running a build as intensity.
   * Kept unchanged so the 4,932 rows written before the fix still mean what
   * they meant.
   */
  switchCount: number;
  /**
   * Transitions between DIFFERENT apps inside the window — the corrected
   * measure, and the one the detector's threshold is set on.
   *
   * `null` on a row written before 2026-09-22, which is a thing a reader needs
   * to be able to tell: those rows come from a detector that fired on five
   * window events rather than nine app flips, and 935 of them involve exactly
   * one process.
   */
  flips: number | null;
  windowMs: number;
  /** Processes involved in the burst, as recorded. */
  processes: string[];
}

/**
 * Bursts of rapid window flipping the moment pipeline already detected.
 *
 * Two numbers matter and they are different: how OFTEN the owner thrashed
 * (row count) and how HARD (`flips`). A day with one 25-flip burst and a day
 * with five 5-flip bursts sum the same and do not feel the same.
 */
export async function getThrashingBetween(range: UtcRange): Promise<ThrashingRow[]> {
  const db = getDb();
  const rows = await db
    .select({ ts: signals.capturedAt, switchCount: field('switchCount'), flips: field('flips'), windowMs: field('windowMs'), processes: sql<string | null>`json_extract(${signals.data}, '$.processes')` })
    .from(signals)
    .where(streamQuery('event', 'thrashing', range))
    .orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({
    ts: row.ts,
    switchCount: Number(row.switchCount ?? 0),
    // Absent, not zero. A pre-fix row has no `flips` and must not be read as a
    // burst with none — the two are different facts about the row.
    flips: row.flips === null || row.flips === undefined ? null : Number(row.flips),
    windowMs: Number(row.windowMs ?? 0),
    processes: parseStringArray(row.processes),
  }));
}

export interface InterruptionRow {
  ts: string;
  /** Why the moment pipeline called this an interruption (e.g. `notification`). */
  cause: string;
  /** The recorded detail — for a `notification` cause, the apps holding badges at that instant. */
  detail: string | null;
}

/**
 * Interruptions the moment pipeline recorded.
 *
 * Read `detail` narrowly. For `cause: 'notification'` it is the set of apps that
 * had a pending badge when the interruption was noticed — evidence of what was
 * clamouring, NOT proof of which app caused it. An analytic may rank those apps
 * as suspects; it may not call them causes, and the surface must not either.
 */
export async function getInterruptionsBetween(range: UtcRange): Promise<InterruptionRow[]> {
  const db = getDb();
  const rows = await db
    .select({ ts: signals.capturedAt, cause: field('cause'), detail: field('detail') })
    .from(signals)
    .where(streamQuery('event', 'interruption', range))
    .orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({ ts: row.ts, cause: row.cause ?? 'unknown', detail: row.detail }));
}

export interface ShellRunRow {
  ts: string;
  /** Already sanitized at ingest, like every stored value. */
  command: string;
  cwd: string | null;
  /** Process exit code. 0 is success; anything else the shell reported a failure. */
  exitCode: number | null;
  durationMs: number | null;
}

/**
 * Shell commands with their exit codes.
 *
 * The exit code is the reason this stream is worth reading at all: it is the only
 * place in the whole log where an action Gnomon observed carries a recorded
 * verdict on whether it WORKED. Everything else the sensors capture is activity
 * without an outcome.
 */
export async function getShellRunsBetween(range: UtcRange): Promise<ShellRunRow[]> {
  const db = getDb();
  const rows = await db
    .select({ ts: signals.capturedAt, command: field('command'), cwd: field('cwd'), exitCode: field('exitCode'), durationMs: field('durationMs') })
    .from(signals)
    .where(streamQuery('shell', 'command', range))
    .orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({
    ts: row.ts,
    command: row.command ?? '',
    cwd: row.cwd,
    exitCode: row.exitCode === null ? null : Number(row.exitCode),
    durationMs: row.durationMs === null ? null : Number(row.durationMs),
  }));
}

export interface CommitRow {
  ts: string;
  branch: string | null;
  cwd: string | null;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

/** Commits with their churn — the one unambiguous "work landed" marker in the log. */
export async function getCommitsBetween(range: UtcRange): Promise<CommitRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      ts: signals.capturedAt,
      branch: field('branch'),
      cwd: field('cwd'),
      insertions: field('insertions'),
      deletions: field('deletions'),
      filesChanged: field('filesChanged'),
    })
    .from(signals)
    .where(streamQuery('git', 'commit', range))
    .orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({
    ts: row.ts,
    branch: row.branch,
    cwd: row.cwd,
    insertions: Number(row.insertions ?? 0),
    deletions: Number(row.deletions ?? 0),
    filesChanged: Number(row.filesChanged ?? 0),
  }));
}

export interface ActivityHourRow {
  /** Start of the UTC hour bucket, as an ISO instant the caller can localize. */
  ts: string;
  /**
   * True when at least one emit in the hour recorded DELIBERATE input — a key,
   * a click or a scroll.
   *
   * This distinction is the difference between a useful denominator and a
   * useless one, and it was found by shipping the useless one first. Counting
   * hours in which the daemon merely OBSERVED gives 24 on any day the lid stayed
   * open, because `input:activity` emits on a fixed ~10s cadence whether or not
   * anyone is there. Rates over that denominator make an idle overnight machine
   * look like a calm working day. Deliberate-input hours give 8–18 on a real
   * day, which is what a working day actually is.
   *
   * Mouse MOVEMENT is deliberately excluded: a cursor can drift from a bumped
   * desk, and the whole point of this flag is that it means a person.
   */
  active: boolean;
  /**
   * How many emits landed in this hour — the hour's own WEIGHT.
   *
   * The comment above is right about the denominator and stops one step short.
   * Counting deliberate-input HOURS fixed the rates and left both hour figures
   * as presence rather than duration: an hour with one emit and an hour with
   * 360 are eight minutes and sixty, and each was reported as "1 hour". On
   * 2026-09-19 that read 20 observed hours and 3 active where the log says 1.3
   * and 1.1. A full hour is `EMITS_PER_FULL_HOUR` of these, and the caller
   * clamps each hour's share at 1 — a burst cannot buy back an hour nobody was
   * there for.
   */
  emits: number;
}

/**
 * One row per UTC hour that holds any activity emit, flagged for whether a
 * person was actually there — ~24 rows a day instead of the ~3,700
 * `input:activity` rows a day really holds.
 *
 * Bucketed on the UTC hour (`substr`) rather than the local one, because a
 * timezone must not enter SQL. The caller maps each bucket to a local day and
 * hour. For every whole-hour zone that is exact. In a zone offset by a fraction
 * of an hour (`Asia/Kolkata`) a UTC bucket straddles two local hours and is
 * credited to the one its start falls in, so the count can differ by one at the
 * edges — a rounding difference in a denominator, not a wrong day.
 *
 * Both counts are returned rather than only the useful one, because their
 * DISAGREEMENT is itself a finding: hours observed with zero active hours is the
 * signature of a lost Input Monitoring grant (`gnomon doctor` reads the same
 * all-counters-zero condition), and a page that silently showed a rate of zero
 * there would report a broken sensor as a quiet day.
 */
export async function getActivityHours(range: UtcRange): Promise<ActivityHourRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      hour: sql<string>`substr(${signals.capturedAt}, 1, 13)`,
      // How many emits landed in the hour, NOT whether any did. `input:activity`
      // fires on a fixed ~10s cadence whenever the daemon is up, so the count
      // is elapsed watched time and the mere presence of a row is not: an hour
      // with one emit and an hour with 360 are eight minutes and sixty, and
      // reported as "1 hour" each they made `observedHours` a flat 24 on every
      // day of the record.
      emits: sql<number>`count(*)`,
      peak: sql<number>`max(
        coalesce(json_extract(${signals.data}, '$.keyDownCount'), 0)
        + coalesce(json_extract(${signals.data}, '$.mouseClickCount'), 0)
        + coalesce(json_extract(${signals.data}, '$.scrollCount'), 0)
      )`,
    })
    .from(signals)
    .where(streamQuery('input', 'activity', range))
    .groupBy(sql`substr(${signals.capturedAt}, 1, 13)`)
    .orderBy(sql`1`);
  return rows.map((row) => ({ ts: `${row.hour}:00:00.000Z`, active: Number(row.peak ?? 0) > 0, emits: Number(row.emits ?? 0) }));
}

/** `json_extract` hands back a JSON array as a string; a malformed one must not take the page down. */
function parseStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
