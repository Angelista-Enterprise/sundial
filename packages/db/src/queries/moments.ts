import { and, eq, gte, inArray, lt, asc, desc, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { localDayRange, wakingDate, wakingMinute } from '@sundial/helpers/local-day.js';
import { moments } from '../schemas/db-schema.js';

export interface StoredMoment {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  processName: string;
  data: Record<string, unknown>;
  importanceScore: number;
  lastAccessedAt: string | null;
  projectId: string | null;
}

export interface InsertMomentInput {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  processName: string;
  data: Record<string, unknown>;
  importanceScore: number;
  projectId: string | null;
}

/**
 * Upsert, not a plain insert — moment ids are assigned deterministically
 * when a moment opens (see `momentClose`'s `openNewMoment`) and stay stable
 * through a crash. Snapshots are periodic (docs/design/00-overview.md
 * decision #2), so boot replay can legitimately re-run a `momentClose`
 * effect whose row was already committed live before the crash. Upserting
 * by primary key makes that idempotent — replaying the same close twice
 * overwrites the same row instead of colliding on the primary key or
 * duplicating it.
 */
export async function insertMoment(input: InsertMomentInput): Promise<void> {
  const db = getDb();
  const row = {
    id: input.id,
    startTime: input.startTime,
    endTime: input.endTime,
    durationMs: input.durationMs,
    processName: input.processName,
    data: JSON.stringify(input.data),
    importanceScore: input.importanceScore,
    projectId: input.projectId,
  };
  await db.insert(moments).values(row).onConflictDoUpdate({ target: moments.id, set: row });
}

/**
 * Merges `patch` into a moment's `data` JSON blob (read-modify-write) —
 * used by `momentAnalysisSchedule`'s result (B2, formerly a separate
 * `intentAnalyze`/`narrateOnClose` pair) to attach an LLM
 * result after the moment has already closed and its full row is no longer
 * held anywhere in `KernelState`. Same read-modify-write pattern already
 * accepted for `projectTrack`'s org-assignment gap (see that rule's doc
 * comment) — a rule can't do this itself (no I/O), so the effect executor
 * does it on the rule's behalf. A no-op (not an error) if the moment id
 * doesn't exist — the moment could have been pruned by retention (Phase 5)
 * between scheduling the LLM call and it resolving.
 */
export async function mergeMomentData(id: string, patch: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const [existing] = await db.select().from(moments).where(eq(moments.id, id));
  if (!existing) return;
  const data = { ...(JSON.parse(existing.data) as Record<string, unknown>), ...patch };
  await db.update(moments).set({ data: JSON.stringify(data) }).where(eq(moments.id, id));
}

/** Single moment by id — for `gnomon search`'s result display (resolving a `memory_embeddings` hit back to a readable row). */
export async function getMomentById(id: string): Promise<StoredMoment | null> {
  const db = getDb();
  const [row] = await db.select().from(moments).where(eq(moments.id, id));
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) as Record<string, unknown> };
}

/**
 * D2 (docs/audit/production-proposal-and-enhancements.md, fixes A§2.2) —
 * one `IN (...)` query for every `moment`-typed embedding hit `scoredSearch`
 * needs to resolve, instead of a `getMomentById` round-trip per row (N+1
 * across the whole embeddings table on every search).
 */
export async function getMomentsByIds(ids: string[]): Promise<StoredMoment[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db.select().from(moments).where(inArray(moments.id, ids));
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/** Moments starting on `date` (YYYY-MM-DD), chronological — for `gnomon summary`. */
/**
 * Moments belonging to a calendar date in `timeZone`.
 *
 * The window used to be built as `${date}T00:00:00.000Z` to `…T23:59:59.999Z`,
 * which is a UTC day. Stored timestamps ARE UTC, so the range still has to be
 * expressed in UTC — but its bounds are the instants of local midnight, which
 * `localDayRange` resolves (including the 23h and 25h DST days). `timeZone`
 * defaults to UTC so a caller that genuinely wants a UTC day, or has no config to
 * hand, gets exactly the previous behaviour.
 */
export async function getMomentsForDate(date: string, timeZone = 'UTC'): Promise<StoredMoment[]> {
  const db = getDb();
  const { start, end } = localDayRange(date, timeZone);
  const rows = await db
    .select()
    .from(moments)
    .where(and(gte(moments.startTime, start), lt(moments.startTime, end)))
    .orderBy(asc(moments.startTime));
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/** Moments starting at or after `since` (ISO timestamp), chronological — feeds `memoryReflection`'s synthesis pass. */
/** Every moment, oldest first — the rejudge job's input (J2.6). ~7,600 rows × ~2 KB is a one-shot read, not a query pattern. */
export async function getAllMoments(): Promise<StoredMoment[]> {
  const db = getDb();
  const rows = await db.select().from(moments).orderBy(asc(moments.startTime));
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/**
 * Moments starting in `[from, to)`, oldest first. With `needles`, only those
 * whose stored data holds one of them (case-insensitive substring) — the
 * "did I…?" and timeline reads, which want a window and a name, never a table.
 */
export async function getMomentsBetween(from: string, to: string, needles: string[] = [], limit = 2000): Promise<StoredMoment[]> {
  const usable = [...new Set(needles.map((n) => n.trim().toLowerCase()).filter((n) => n !== ''))];
  const hit = usable.length > 0 ? sql.join(usable.map((n) => sql`instr(lower(${moments.data}), ${n}) > 0`), sql` or `) : undefined;
  const rows = await getDb()
    .select()
    .from(moments)
    .where(and(gte(moments.startTime, from), lt(moments.startTime, to), hit ? sql`(${hit})` : undefined))
    .orderBy(asc(moments.startTime))
    .limit(limit);
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/** The newest moments first: the setup page's proof that capture works. */
export async function getLatestMoments(limit: number): Promise<StoredMoment[]> {
  const rows = await getDb().select().from(moments).orderBy(desc(moments.startTime)).limit(limit);
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

export async function getMomentsSince(since: string): Promise<StoredMoment[]> {
  const db = getDb();
  const rows = await db.select().from(moments).where(gte(moments.startTime, since)).orderBy(asc(moments.startTime));
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/**
 * Multiplies every moment's `importanceScore` by `factor` (§5's decay —
 * retrieval weight only, never deletion).
 *
 * The `CAST(… AS INTEGER)` this used to perform made the decay behave nothing
 * like its own design. The intent is a gentle fade — 0.95/day, halving an
 * unrevisited score in about two weeks — but truncating to an integer each day
 * turned that into a cliff at the bottom of the range: a score of 2 became
 * `CAST(1.9)` = 1 after a SINGLE day, a 50% drop, and `MAX(1, …)` then pinned it
 * there permanently. Because the floor is also the write-time default, the
 * result was a one-way ratchet with no way back up.
 *
 * Measured before the fix: no moment older than nine days had a score above 1,
 * across a corpus spanning three weeks — 3,542 of 3,571 moments sat at exactly
 * the floor, so the term ranked nothing.
 *
 * Dropping the cast keeps the multiplication lossless. SQLite's NUMERIC affinity
 * stores the fractional result even though the column is declared `integer()`,
 * because a value that cannot be narrowed without loss is kept as a REAL — so
 * this needs no schema migration.
 */
export async function decayMomentScores(factor: number): Promise<void> {
  const db = getDb();
  await db.run(sql`UPDATE moments SET importance_score = MAX(1, importance_score * ${factor})`);
}

/** Bumps `lastAccessedAt` — an LRU-like signal for `gnomon search` hits, independent of decay. */
export async function touchMomentAccess(id: string, accessedAt: string): Promise<void> {
  const db = getDb();
  await db.update(moments).set({ lastAccessedAt: accessedAt }).where(eq(moments.id, id));
}

/** D2 (fixes A§2.2) — one `UPDATE ... WHERE id IN (...)` for every moment hit `scoredSearch` returns, instead of a `touchMomentAccess` round-trip per hit. */
export async function touchMomentAccessBatch(ids: string[], accessedAt: string): Promise<void> {
  if (ids.length === 0) return;
  const db = getDb();
  await db.update(moments).set({ lastAccessedAt: accessedAt }).where(inArray(moments.id, ids));
}

/** Moments for a given project id, most recent first — backs the MCP `gnomon_project_status` tool (Phase 7). */
export async function getMomentsForProject(projectId: string, limit = 50): Promise<StoredMoment[]> {
  const db = getDb();
  const rows = await db.select().from(moments).where(eq(moments.projectId, projectId)).orderBy(desc(moments.startTime)).limit(limit);
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

export interface MomentCountByProject {
  projectId: string | null;
  count: number;
}

/** Sidebar's per-project moment count (docs/design/06-macos-ui-data-wiring.md) — one `GROUP BY`, not a `getMomentsForProject().length` per project in the workspace tree. `projectId: null` groups moments never attributed to a project. */
export async function getMomentCountsByProject(): Promise<MomentCountByProject[]> {
  const db = getDb();
  return db
    .select({
      projectId: moments.projectId,
      count: sql<number>`count(*)`,
    })
    .from(moments)
    .groupBy(moments.projectId);
}

export interface LocationDayCount {
  location: string;
  days: number;
}

/**
 * Phase 5 #6 — distinct days per location bucket since `from`, for `gnomon
 * location`'s "ROI by location" / office-day summary. A day counts for a bucket
 * if any moment that day carried that `data.location` (set at moment close from
 * the network fingerprint via `config.locationLabels`). Unlabeled moments
 * (`location` null) are excluded.
 */
export async function getLocationDayCounts(from: string): Promise<LocationDayCount[]> {
  const db = getDb();
  const rows = await db.all<{ location: string; days: number }>(sql`
    SELECT location, COUNT(DISTINCT day) AS days FROM (
      SELECT DISTINCT substr(start_time, 1, 10) AS day, json_extract(data, '$.location') AS location
      FROM moments
      WHERE start_time >= ${from} AND json_extract(data, '$.location') IS NOT NULL
    )
    GROUP BY location
    ORDER BY days DESC
  `);
  return rows.map((r) => ({ location: r.location, days: Number(r.days) }));
}

export interface MomentCountByProjectAndProcess {
  projectId: string;
  processName: string;
  count: number;
}

/**
 * J2.3 — the evidence behind a `project usesTool X` belief: how many written
 * moments of that project ran that process. One `GROUP BY` over the table,
 * read once per audit pass; the executor folds it onto the entity→path map.
 * Unattributed moments are excluded — they can vouch for no project.
 */
export async function getMomentCountsByProjectAndProcess(): Promise<MomentCountByProjectAndProcess[]> {
  const db = getDb();
  const rows = await db
    .select({ projectId: moments.projectId, processName: moments.processName, count: sql<number>`count(*)` })
    .from(moments)
    .where(sql`${moments.projectId} IS NOT NULL`)
    .groupBy(moments.projectId, moments.processName);
  return rows.filter((r): r is MomentCountByProjectAndProcess => r.projectId !== null);
}

/** One waking day's arc: when work started, when it stopped, and how much of it was active. */
export interface DayArc {
  /** The date the WAKING day began on — see `wakingDate`. Work at 00:30 on Tuesday belongs to Monday. */
  date: string;
  /** Minutes from 04:00, the waking day's start. Midnight is 1200; 02:00 the next morning is 1320. */
  firstMin: number;
  lastMin: number;
  /** Active minutes — the sum of the day's moment durations, not the span. */
  activeMin: number;
  moments: number;
}

/**
 * The shape of each waking day — first touch, last touch, and active minutes.
 *
 * **K0.6 moved this off the calendar day, and the record decided it.** Filed by
 * calendar date, seven of the record's forty-two days have their first moment
 * between 00:00 and 00:05 — not somebody who got up at four minutes past
 * twelve, but the previous evening continuing. So those seven claimed to start
 * at 00:03 while the evenings they belong to claimed to stop at 23:57, and both
 * ends of both days were wrong. The card met that as a heuristic —
 * `clippedStart`/`clippedEnd`, set when an end fell within five minutes of
 * midnight — which labelled a person working late as a day whose end the record
 * could not see, drew an open arrow on it, and excluded it from the typical
 * day. Read against `WAKING_DAY_START_HOUR` those same seven nights end at
 * 00:04, 00:16, 00:24, 00:33, 01:04, 01:23 and 02:00. Nothing is clipped,
 * nothing is unknowable, and the bedtime spread the audit asked for is a real
 * distribution rather than nine marks in the same place.
 *
 * **And the ends are taken from INSTANTS, not from clock strings.** This read
 * `MAX(time(end_time))`, the largest clock value in the group — so a day whose
 * last moment crossed midnight reported the largest time BEFORE it (23:57) and
 * dropped the true end entirely. Eight of the record's 7,797 moments cross
 * local midnight, and every one of them was silently lost this way. `MAX` over
 * the timestamp cannot make that mistake.
 *
 * **And each moment is put in its day in the owner's zone, one at a time.**
 * This took one constant UTC offset for the whole 28–90-day window (SQLite
 * has no timezone database), which is an hour wrong on the far side of a
 * daylight saving change: on 2026-10-25 every day before it in the window
 * would have moved its first and last touch by an hour. The rows are grouped
 * here instead, with `wakingDate`/`wakingMinute` in `timeZone`.
 */
export async function getDayArcs(fromIso: string, toIso: string, timeZone: string): Promise<DayArc[]> {
  const db = getDb();
  const rows =
    (await db.all<{ start: string; end: string; durationMs: number }>(sql`
      SELECT ${moments.startTime} AS start, ${moments.endTime} AS "end", ${moments.durationMs} AS durationMs
      FROM ${moments}
      WHERE ${moments.startTime} >= ${fromIso} AND ${moments.startTime} < ${toIso}`)) ?? [];
  // Bucketed by the START only, so every moment of one evening lands together
  // however late it runs; the ends are instants, so a day that crossed
  // midnight keeps its true end.
  const days = new Map<string, { first: string; last: string; activeMs: number; moments: number }>();
  for (const row of rows) {
    const date = wakingDate(row.start, timeZone);
    const day = days.get(date);
    if (!day) days.set(date, { first: row.start, last: row.end, activeMs: row.durationMs ?? 0, moments: 1 });
    else {
      if (Date.parse(row.start) < Date.parse(day.first)) day.first = row.start;
      if (Date.parse(row.end) > Date.parse(day.last)) day.last = row.end;
      day.activeMs += row.durationMs ?? 0;
      day.moments += 1;
    }
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({
      date,
      firstMin: wakingMinute(day.first, timeZone),
      lastMin: wakingMinute(day.last, timeZone),
      activeMin: Math.round(day.activeMs / 60_000),
      moments: day.moments,
    }));
}

/** Where a name showed up inside a moment — the four places a moment carries people and words. */
export type MentionPlace = 'meeting' | 'said' | 'screen' | 'reading';

export interface MomentMention {
  id: string;
  startTime: string;
  durationMs: number;
  intent: string | null;
  /** The app in front, for a moment the intent pass never summarised — the row's fallback, as everywhere else. */
  processName: string | null;
  where: MentionPlace[];
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * W4 — the moments a name appears in, looked up rather than searched for.
 *
 * The entity card asked the retriever for a person's name and kept only the
 * moment hits; a similarity search on a name returns facts, not moments, so the
 * filter left none and the card said "No moments near it" for Alex Morgan,
 * whose name is in 37. This reads the moments themselves.
 *
 * A name is matched on word boundaries, case-insensitively, in the four places a
 * moment carries it, and each hit says WHERE — because "in a meeting with Alex"
 * and "Alex's name was on screen" are different evidence, and the Alex card's
 * 37 turned out to be mostly the second (a Jira comment author in the OCR text).
 * Names shorter than three characters are not matched: they match everything.
 *
 * ponytail: a `LIKE` prefilter over `data` and a JS regex after, fine at ~8k
 * moments (a few ms). A name index is the upgrade if the record gets large.
 */
export async function getMomentsMentioning(names: string[], limit = 20): Promise<{ total: number; byPlace: Partial<Record<MentionPlace, number>>; moments: MomentMention[] }> {
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
  if (usable.length === 0) return { total: 0, byPlace: {}, moments: [] };
  const db = getDb();
  const likes = usable.map((n) => sql`${moments.data} like ${`%${n}%`}`);
  const rows = await db
    .select({ id: moments.id, startTime: moments.startTime, durationMs: moments.durationMs, data: moments.data })
    .from(moments)
    .where(sql.join(likes, sql` or `))
    .orderBy(desc(moments.startTime));
  const res = usable.map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, 'iu'));
  const hit = (text: unknown) => typeof text === 'string' && res.some((re) => re.test(text));
  const hits: MomentMention[] = [];
  for (const row of rows) {
    const d = (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>;
    const where: MentionPlace[] = [];
    if (Array.isArray(d.meetingAttendees) && d.meetingAttendees.some(hit)) where.push('meeting');
    if (hit(d.spokenExcerpt) || hit((d.spokenClean as { text?: unknown } | undefined)?.text)) where.push('said');
    if (hit(d.screenExcerpt) || hit(d.meetingTitle) || (Array.isArray(d.windowTitles) && d.windowTitles.some(hit))) where.push('screen');
    if (hit((d.intent as { text?: unknown } | undefined)?.text) || hit(d.narrative)) where.push('reading');
    if (where.length === 0) continue;
    hits.push({ id: row.id, startTime: row.startTime, durationMs: row.durationMs ?? 0, intent: ((d.intent as { text?: string } | undefined)?.text ?? null) as string | null, processName: typeof d.processName === 'string' ? d.processName : null, where });
  }
  // Counted over EVERY hit, not the page: the card's sentence is about all of them.
  const byPlace: Partial<Record<MentionPlace, number>> = {};
  for (const h of hits) for (const w of h.where) byPlace[w] = (byPlace[w] ?? 0) + 1;
  return { total: hits.length, byPlace, moments: hits.slice(0, limit) };
}

/**
 * S1 — where the owner left off on each recent project: the last CLOSED moment
 * on it that the intent pass summarised, newest project first. "Where did I
 * leave brilliant-hint-borders?" is one of the four questions the owner keeps
 * asking in chat; this is the answer, read rather than recalled by a model.
 *
 * Only summarised moments count, because an unsummarised one says "Arc, 1 min"
 * and that is not a place anyone left off. And only CERTAIN attributions — the
 * editor, the terminal, the coding agent. Measured: without that filter the
 * answer for puzzlebox-studio was "Watching YouTube video on OpenAI marketing",
 * a browser tab filed under the project as a weak guess because git had been
 * active nearby; a third of recent project moments are guesses of that kind. The project's own name comes from
 * the registry row, so it reads as the rest of the board names it.
 */
export async function getLeftOff(sinceIso: string, limit = 6): Promise<{ projectId: string; projectName: string; at: string; what: string }[]> {
  const db = getDb();
  // One pass with a window, not a correlated max(): the subquery re-scanned
  // every moment per row and took 2.2 s on 8k moments, blocking the server.
  // Restricting to `since` first is equivalent: a project whose latest certain
  // moment is older than `since` had no row in the window anyway.
  return db.all<{ projectId: string; projectName: string; at: string; what: string }>(sql`
    with q as (
      select project_id, start_time, json_extract(data, '$.intent.text') as what,
             row_number() over (partition by project_id order by start_time desc) as rn
        from moments
       where project_id is not null
         and start_time >= ${sinceIso}
         and json_extract(data, '$.intent.text') is not null
         and json_extract(data, '$.projectConfidence') = 'certain'
    )
    select q.project_id as projectId, coalesce(p.name, q.project_id) as projectName, q.start_time as at, q.what as what
      from q
      left join projects p on p.id = q.project_id
     where q.rn = 1
     order by q.start_time desc
     limit ${limit}
  `);
}

/**
 * The week-away digest (U2-F38): the last few intent lines on ONE project,
 * newest first, from its certain moments — what the owner was doing there
 * before they went away, in their own record's words. Consecutive duplicates
 * (one line re-rendered over several moments) collapse to one.
 */
export async function getProjectIntents(projectId: string, beforeIso: string, limit = 5): Promise<{ at: string; what: string }[]> {
  const rows = await getDb().all<{ at: string; what: string }>(sql`
    select start_time as at, json_extract(data, '$.intent.text') as what
      from moments
     where project_id = ${projectId}
       and start_time < ${beforeIso}
       and json_extract(data, '$.intent.text') is not null
       and json_extract(data, '$.projectConfidence') = 'certain'
     order by start_time desc
     limit ${limit * 4}
  `);
  return rows.filter((r, i) => i === 0 || r.what !== rows[i - 1].what).slice(0, limit);
}

