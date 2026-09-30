import { and, asc, count, desc, eq, gt, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { localDate, localDayRange } from '@sundial/helpers/local-day.js';
import { getDb } from '../db-client.js';
import { signals } from '../schemas/db-schema.js';

export interface StoredSignal {
  id: string;
  signalType: string;
  eventType: string;
  sessionId: string | null;
  data: Record<string, unknown>;
  capturedAt: string;
}

export interface InsertSignalInput {
  id: string;
  signalType: string;
  eventType: string;
  sessionId?: string | null;
  data: Record<string, unknown>;
  capturedAt: string;
}

export async function insertSignal(input: InsertSignalInput): Promise<void> {
  const db = getDb();
  await db.insert(signals).values({
    id: input.id,
    signalType: input.signalType,
    eventType: input.eventType,
    sessionId: input.sessionId ?? null,
    data: JSON.stringify(input.data),
    capturedAt: input.capturedAt,
  });
}

/** Whether the log already holds this id. An `EmitEvent` re-run by boot replay asks first: its child may already be logged. */
export async function signalExists(id: string): Promise<boolean> {
  const db = getDb();
  const rows = await db.select({ id: signals.id }).from(signals).where(eq(signals.id, id)).limit(1);
  return rows.length > 0;
}

/**
 * `signalType`, when given, filters before `limit` is applied — so `limit=50&signalType=git`
 * returns the 50 most recent `git` signals, not up to 50 filtered out of the last 50 overall.
 *
 * A LIST of types is accepted for the same reason one is: `gnomon_recent_activity`
 * wants the newest rows across the owner-evidence types, and taking the newest 20
 * of everything gave it `screen:ocr` and `input:activity` — the two
 * highest-volume sensors — instead of activity. `getSignalsInRange` could not
 * serve it because that one orders ASCENDING before limiting, which returns the
 * oldest rows of a window rather than the newest.
 */
export async function getRecentSignals(limit = 20, signalType?: string | readonly string[], offset = 0): Promise<StoredSignal[]> {
  const db = getDb();
  const query = db.select().from(signals);
  const types = typeof signalType === 'string' ? [signalType] : signalType;
  const filtered = types !== undefined && types.length > 0 ? query.where(types.length === 1 ? eq(signals.signalType, types[0]!) : inArray(signals.signalType, [...types])) : query;
  const rows = await filtered.orderBy(desc(signals.capturedAt)).limit(limit).offset(offset);
  return rows.map((row) => ({
    ...row,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

/**
 * P3 (docs/design/07) — signals captured on `date` (YYYY-MM-DD) in `timeZone`,
 * chronological, optionally filtered to one `signalType` (the prefix before `:`
 * in an event type — e.g. `search` for `search:performed`, `system` for
 * `system:power`/`system:sleep-wake`). Feeds `buildDailyContext`'s search list
 * (verbatim query text lives in the signal payload, not on the moment) and its
 * break-taxonomy overnight tagging (sleep/wake crossings). Bounded to a single
 * day, indexed on `captured_at` — not the whole log.
 *
 * The window is the OWNER's day, per
 * `almanac/decisions/day-boundaries-use-owner-timezone`. It used to be built as
 * `${date}T00:00:00.000Z`..`T23:59:59.999Z`, which is a UTC day — in Amsterdam
 * that starts at 02:00, so everything between midnight and 02:00 was filed under
 * the previous date. That mattered most where this function is used: the
 * overnight sleep/wake crossings that decide whether a gap was a break or a
 * night are exactly the events that land in those two hours.
 *
 * `timeZone` defaults to `'UTC'` rather than reading config, matching
 * `getMomentsForDate`'s existing shape — a query in `@sundial/db` has no business
 * loading the owner's configuration, and a default of UTC keeps the old
 * behaviour for any caller that has not been given a zone to pass.
 */
export async function getSignalsForDate(date: string, signalType?: string, timeZone = 'UTC'): Promise<StoredSignal[]> {
  const db = getDb();
  const { start, end } = localDayRange(date, timeZone);
  const dateWindow = and(gte(signals.capturedAt, start), lt(signals.capturedAt, end));
  const where = signalType ? and(dateWindow, eq(signals.signalType, signalType)) : dateWindow;
  const rows = await db.select().from(signals).where(where).orderBy(asc(signals.capturedAt));
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/**
 * Signals captured inside `[from, to)`, chronological — the evidence behind one
 * moment, which is a narrower question than `getSignalsForDate`'s whole day.
 *
 * Bounded by `limit` rather than unbounded: a long moment can contain thousands
 * of `input:activity` ticks, and the caller (Memory · Recorded's moment detail)
 * is reading them to show a person what happened, not to re-fold them. The
 * window is half-open at `to` so two adjacent moments cannot both claim the
 * signal captured exactly on their shared boundary.
 *
 * `signalTypes` narrows to an INCLUDE-list before the limit is applied, which
 * is the difference between "the first 200 rows of the window" and "the first
 * 200 rows you asked for". Without it a caller after the day's twelve shell
 * commands gets two hundred `input:activity` ticks instead, because those
 * outnumber everything else in the log by an order of magnitude. An empty or
 * omitted list means every type, preserving the original behavior.
 */
/** A plain, case-insensitive substring of the stored JSON — no LIKE wildcards to escape. */
const containing = (text?: string) => (text && text.trim() !== '' ? sql`instr(lower(${signals.data}), ${text.trim().toLowerCase()}) > 0` : undefined);

/** An include-list whose entries are a type (`audio`) or a type and its event (`audio:transcript`). */
const ofTypes = (list?: string[]) =>
  list && list.length > 0
    ? or(...list.map((t) => (t.includes(':') ? and(eq(signals.signalType, t.split(':')[0]!), eq(signals.eventType, t.slice(t.indexOf(':') + 1))) : eq(signals.signalType, t))))
    : undefined;

export async function getSignalsInRange(from: string, to: string, limit = 200, signalTypes?: string[], offset = 0, contains?: string): Promise<StoredSignal[]> {
  const db = getDb();
  const where = and(gte(signals.capturedAt, from), lt(signals.capturedAt, to), containing(contains), ofTypes(signalTypes));
  const base = db.select().from(signals).where(where).orderBy(asc(signals.capturedAt), asc(signals.id)).limit(limit);
  const rows = await (offset > 0 ? base.offset(offset) : base);
  return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
}

/** Every row in the range, read in pages, so a long window never silently drops its newest rows at a cap. */
export async function getAllSignalsInRange(from: string, to: string, signalTypes?: string[], contains?: string, page = 20_000): Promise<StoredSignal[]> {
  const out: StoredSignal[] = [];
  for (;;) {
    const rows = await getSignalsInRange(from, to, page, signalTypes, out.length, contains);
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

/**
 * How many rows `getSignalsInRange` would have to choose from, ignoring `limit`.
 *
 * A page without a total is a guess. A model handed 25 rows and no count cannot
 * tell a quiet day from a capped one, and the live record shows what it does
 * about that: it stops trusting the limit and asks for the maximum every time.
 * One indexed COUNT is what buys the small default page its honesty.
 */
export async function countSignalsInRange(from: string, to: string, signalTypes?: string[], contains?: string): Promise<number> {
  const db = getDb();
  const where = and(gte(signals.capturedAt, from), lt(signals.capturedAt, to), containing(contains), ofTypes(signalTypes));
  const [row] = await db.select({ n: count() }).from(signals).where(where);
  return row?.n ?? 0;
}

export interface SignalFreshness {
  signalType: string;
  eventType: string;
  lastCapturedAt: string;
}

/**
 * Observability Overview's "sensor health" tile (docs/design/06-macos-ui-data-wiring.md)
 * — the last time each distinct `signal_type`/`event_type` pair fired, so
 * the UI can flag a sensor that's gone quiet without any new "sensor
 * health" concept on the daemon side. `GROUP BY` + `MAX`, indexed on
 * `captured_at`, not a table scan per sensor.
 */
/** How much the record holds: row count and first/last capture. The setup page's proof that capture works. */
export async function getSignalTotals(): Promise<{ count: number; first: string | null; last: string | null }> {
  const [row] = await getDb()
    .select({ count: count(), first: sql<string | null>`min(${signals.capturedAt})`, last: sql<string | null>`max(${signals.capturedAt})` })
    .from(signals);
  return { count: row?.count ?? 0, first: row?.first ?? null, last: row?.last ?? null };
}

export async function getSignalFreshness(): Promise<SignalFreshness[]> {
  const db = getDb();
  return db
    .select({
      signalType: signals.signalType,
      eventType: signals.eventType,
      lastCapturedAt: sql<string>`max(${signals.capturedAt})`,
    })
    .from(signals)
    .groupBy(signals.signalType, signals.eventType)
    .orderBy(signals.signalType, signals.eventType);
}

/**
 * Rows written after `signalId`, in insertion order — Phase 2's
 * boot replay: fold these through reduce() to fast-forward state from the
 * last snapshot. `signalId` null means "replay everything" (no snapshot yet).
 */
export async function getSignalsAfter(signalId: string | null): Promise<StoredSignal[]> {
  const db = getDb();
  const query = db.select().from(signals);
  // Insertion order, which is the fold order. Ids do not sort that way: a
  // derived child's id carries its parent's millisecond, and plain ulid() is
  // random within one, so `id > offset` skipped rows written after a snapshot.
  // An offset row no longer in the log falls back to the id order.
  const [at] = signalId ? await db.select({ rowid: sql<number>`rowid` }).from(signals).where(eq(signals.id, signalId)) : [];
  const rows = await (at ? query.where(sql`rowid > ${at.rowid}`).orderBy(sql`rowid`) : signalId ? query.where(gt(signals.id, signalId)).orderBy(asc(signals.id)) : query.orderBy(sql`rowid`));
  return rows.map((row) => ({
    ...row,
    data: JSON.parse(row.data) as Record<string, unknown>,
  }));
}

/** One day of board traffic, by whose hand. */
export interface BoardTrafficRow {
  /** The owner-local day, or the card id, depending on the axis asked for. */
  key: string;
  /** Cards put on the board. */
  placed: number;
  /** Cards taken off it. */
  removed: number;
  /** Cards dragged or resized. */
  moved: number;
  /** Placed by Gnomon. */
  placedByGnomon: number;
  /** Placed by Gnomon and taken off by the owner within a minute — the sharpest measure of a card nobody wanted. */
  sweptWithin60s: number;
  /** How long the owner left a Gnomon card standing, in seconds, when they removed it at all. */
  medianKeptSeconds: number | null;
}

/**
 * What happened ON the board, as rows.
 *
 * Every change to the board is already a signal carrying `by` and `at`, so the
 * question "how well does Gnomon manage the owner's space" is answerable from
 * the record with nothing new written. The owner asked for it during the lens
 * audit, as self-audit instrumentation: Gnomon places cards, and until now
 * nothing measured whether the owner kept them.
 *
 * `sweptWithin60s` is the measure that matters. A card Gnomon placed and the
 * owner swept off inside a minute is a card Gnomon was wrong to place, and the
 * rate of those over a day says more than any count of placements.
 */
export async function getBoardTraffic(axis: 'day' | 'card', timeZone: string, since?: string): Promise<BoardTrafficRow[]> {
  const db = getDb();
  const where = since ? and(eq(signals.signalType, 'board'), gte(signals.capturedAt, since)) : eq(signals.signalType, 'board');
  const rows = await db.select({ eventType: signals.eventType, data: signals.data, capturedAt: signals.capturedAt }).from(signals).where(where).orderBy(asc(signals.capturedAt));

  /** id → when Gnomon last placed it, so a removal can be timed against the placement it answers. */
  const placedAt = new Map<string, number>();
  const buckets = new Map<string, { placed: number; removed: number; moved: number; placedByGnomon: number; sweptWithin60s: number; kept: number[] }>();
  const bucket = (key: string) => {
    let found = buckets.get(key);
    if (!found) {
      found = { placed: 0, removed: 0, moved: 0, placedByGnomon: 0, sweptWithin60s: 0, kept: [] };
      buckets.set(key, found);
    }
    return found;
  };

  for (const row of rows) {
    let payload: { id?: unknown; by?: unknown };
    try {
      payload = JSON.parse(row.data) as { id?: unknown; by?: unknown };
    } catch {
      continue;
    }
    const id = typeof payload.id === 'string' ? payload.id : null;
    const by = payload.by === 'gnomon' ? 'gnomon' : 'owner';
    const at = Date.parse(row.capturedAt);
    // A card's own row when asked by card; otherwise the day it happened on.
    const key = axis === 'card' ? (id ?? '(no card)') : localDate(row.capturedAt, timeZone);
    const into = bucket(key);

    if (row.eventType === 'place') {
      into.placed += 1;
      if (by === 'gnomon') {
        into.placedByGnomon += 1;
        if (id) placedAt.set(id, at);
      } else if (id) placedAt.delete(id);
    } else if (row.eventType === 'move') {
      into.moved += 1;
    } else if (row.eventType === 'remove') {
      into.removed += 1;
      const placed = id === null ? undefined : placedAt.get(id);
      if (placed !== undefined && by === 'owner') {
        const heldMs = at - placed;
        into.kept.push(Math.round(heldMs / 1000));
        if (heldMs <= 60_000) into.sweptWithin60s += 1;
        placedAt.delete(id!);
      }
    }
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  };

  return [...buckets.entries()]
    .map(([key, b]) => ({ key, placed: b.placed, removed: b.removed, moved: b.moved, placedByGnomon: b.placedByGnomon, sweptWithin60s: b.sweptWithin60s, medianKeptSeconds: median(b.kept) }))
    .sort((a, b) => (axis === 'day' ? b.key.localeCompare(a.key) : b.placed + b.moved - (a.placed + a.moved)));
}

/** One UTC hour of the log, and how full the heartbeat made it. */
export interface ObservedHour {
  /** `2026-09-22T14` — UTC, so the CALLER decides what a local day is. */
  hour: string;
  /** 0..1 — the share of that hour the daemon was actually watching. */
  share: number;
}

/**
 * How much of each hour Gnomon watched, over the whole log.
 *
 * **Why this is a query and not a read of `state.coverage.observedHours`.**
 * That field is capped at `MAX_COVERAGE_BUCKETS` — fifteen days — because it
 * rides in every kernel snapshot, and the cap is right for what the rules use
 * it for. It is wrong for a surface asking "what does a typical Wednesday look
 * like": fifteen days is two samples a weekday. The log holds 154k
 * `input:activity` rows over 54 days and answers in about 80ms, so the card
 * reads the log and leaves the bounded mirror to the fold.
 *
 * `input:activity` is the ONLY sensor that emits on a clock whatever happens
 * (a fixed ~10s window from the Swift helper), which is what makes its density
 * a measure of elapsed observed time rather than of how busy the owner was. A
 * fully-watched hour therefore holds about 360 emits, and each hour's share is
 * clamped to 1 — a burst cannot buy back an hour nobody was there for.
 *
 * **Hours, not days, and in UTC.** Grouping into local days here would mean a
 * fixed `+N hours` shift in SQL, which is wrong on both sides of a daylight
 * saving change; the caller has `localDate`, which is not. An hour is also the
 * grain the measurement actually has — a restart leaves an 82-93 second hole,
 * so anything finer would imply a precision the stream does not carry.
 *
 * An hour with no rows is ABSENT rather than zero. The daemon not running and
 * the daemon watching nothing are different claims, and a calendar that paints
 * them the same colour hides the only real health signal in this record.
 */
export async function getObservedHours(): Promise<ObservedHour[]> {
  const db = getDb();
  const rows =
    (await db.all<{ hour: string; n: number }>(sql`
      SELECT strftime('%Y-%m-%dT%H', ${signals.capturedAt}) AS hour, COUNT(*) AS n
      FROM ${signals}
      WHERE ${signals.signalType} = 'input' AND ${signals.eventType} = 'activity'
      GROUP BY hour ORDER BY hour`)) ?? [];
  return rows.map((row) => ({ hour: row.hour, share: Math.min(1, (row.n ?? 0) / 360) }));
}

export interface ToolCallRow {
  server: string | null;
  action: string;
  calls: number;
  failed: number;
  refused: number;
  lastAt: string;
}

/**
 * Every tool call Gnomon has made, grouped by what ran — the Reach card's
 * "last used and how often it went wrong", which had no data at all until
 * K0.1.
 *
 * `outcome IS NOT NULL` is the whole filter and it is the reason there is no
 * list of tools to skip. The gate writes one row per call carrying an
 * `outcome`; `run_shell` and `calendar_create` write their own DETAIL rows
 * (the command, the created event) carrying none, because only the tool can
 * see those. Counting the rows that have an outcome counts calls exactly once.
 *
 * Grouped in SQLite rather than folded in a route: this table is the whole
 * append-only log, and a tool call is a row that will keep arriving.
 */
export async function getToolCalls(): Promise<ToolCallRow[]> {
  const db = getDb();
  return db.all<ToolCallRow>(sql`
    SELECT json_extract(data, '$.server') AS server,
           coalesce(json_extract(data, '$.action'), json_extract(data, '$.tool')) AS action,
           count(*) AS calls,
           sum(CASE WHEN json_extract(data, '$.outcome') = 'failed' THEN 1 ELSE 0 END) AS failed,
           sum(CASE WHEN event_type = 'decided' OR json_extract(data, '$.outcome') = 'refused' THEN 1 ELSE 0 END) AS refused,
           max(captured_at) AS lastAt
      FROM signals
     WHERE signal_type = 'action'
       AND ((event_type = 'performed' AND json_extract(data, '$.outcome') IS NOT NULL)
         -- W3: a refusal is its gate verdict now; rows from before still carry outcome 'refused'.
         OR (event_type = 'decided' AND json_extract(data, '$.verdict') = 'deny'))
     GROUP BY 1, 2
     ORDER BY calls DESC
  `);
}
