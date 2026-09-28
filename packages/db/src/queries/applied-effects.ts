import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { appliedEffects } from '../schemas/db-schema.js';

/**
 * `started` — intent recorded, outcome unknown. `completed` — ran to
 * completion. `indeterminate` — was found `started` on a later boot and its
 * delivery guarantee forbade a retry, so it was abandoned. `failed` — it threw
 * (K0.5); the `failures` counter beside it survives a later success, so a row
 * can read "completed, having failed twice". `null` from
 * `getEffectJournalStatus` means no row at all: never attempted.
 */
export type EffectJournalStatus = 'started' | 'completed' | 'indeterminate' | 'failed';

/**
 * The journal's verdict on one effect, or `null` if it was never attempted.
 *
 * Replaces the old boolean `isEffectApplied`. A boolean could only ever say
 * "there is a row", which conflated the two states that matter to an
 * irreversible effect: a row written before execution (outcome unknown) and a
 * row written after it (outcome known). See `kernel/effect-delivery.ts`.
 */
export async function getEffectJournalStatus(eventId: string, effectIndex: number): Promise<EffectJournalStatus | null> {
  const db = getDb();
  const rows = await db
    .select({ status: appliedEffects.status })
    .from(appliedEffects)
    .where(and(eq(appliedEffects.eventId, eventId), eq(appliedEffects.effectIndex, effectIndex)))
    .limit(1);
  return rows.length > 0 ? (rows[0].status as EffectJournalStatus) : null;
}

export interface MarkEffectAppliedTrigger {
  ruleName: string;
  eventType: string;
  effectDetail: string;
}

/**
 * Phase one: record the intent to run this effect, before it runs.
 *
 * `onConflictDoNothing` rather than an upsert, deliberately. If a row already
 * exists this effect has been attempted before and the existing row's status is
 * the fact worth keeping — overwriting a `completed` or `indeterminate` row back
 * to `started` would erase the very history the caller just consulted to decide
 * whether to run at all.
 *
 * `trigger` carries the Triggers-tab attribution and is written here rather than
 * on completion, so an effect that never completes is still attributable to the
 * rule that asked for it. That is the case an operator most wants to see.
 */
export async function markEffectStarted(eventId: string, effectIndex: number, trigger?: MarkEffectAppliedTrigger): Promise<void> {
  const db = getDb();
  await db
    .insert(appliedEffects)
    .values({
      eventId,
      effectIndex,
      appliedAt: new Date().toISOString(),
      status: 'started',
      ruleName: trigger?.ruleName ?? null,
      eventType: trigger?.eventType ?? null,
      effectDetail: trigger?.effectDetail ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Phase two: the effect ran to completion. Also re-stamps `appliedAt`, so the
 * Triggers tab orders by when an effect actually finished rather than when it
 * was merely begun.
 */
export async function markEffectCompleted(eventId: string, effectIndex: number): Promise<void> {
  await setEffectStatus(eventId, effectIndex, 'completed');
}

/**
 * The effect was found `started` on a later boot and its delivery guarantee
 * forbade re-running it. Recorded rather than left in `started`, so a stuck row
 * cannot be mistaken for one that is in flight right now, and so an operator can
 * find every effect whose outcome the system genuinely does not know.
 */
export async function markEffectIndeterminate(eventId: string, effectIndex: number): Promise<void> {
  await setEffectStatus(eventId, effectIndex, 'indeterminate');
}

/**
 * The effect THREW — K0.5.
 *
 * Counted rather than statused, and the distinction is the whole item. An
 * effect that throws leaves `started`; the next boot consults the delivery
 * guarantee, finds `at-least-once` (which every variant in the union is),
 * re-runs it and stamps it `completed`. A failure healed into a success, so
 * all 27,029 rows of this journal said `completed` and the one surface able to
 * report a failed side effect reported the opposite.
 *
 * A counter survives that. `failures` is incremented in SQL rather than read
 * and written back, so two attempts racing cannot lose one, and `markEffectCompleted`
 * does not touch it: a row reads "completed, having failed twice", which is
 * the fact an operator actually wants.
 *
 * `status` goes to `failed` as well, so a row that is STILL broken can be
 * found without arithmetic. The next successful attempt moves it to
 * `completed` and leaves the count behind.
 */
export async function markEffectFailed(eventId: string, effectIndex: number, message: string): Promise<void> {
  const db = getDb();
  await db
    .update(appliedEffects)
    .set({
      status: 'failed',
      lastError: message.slice(0, 2000),
      failures: sql`${appliedEffects.failures} + 1`,
      appliedAt: new Date().toISOString(),
    })
    .where(and(eq(appliedEffects.eventId, eventId), eq(appliedEffects.effectIndex, effectIndex)));
}

/**
 * The child event an `EmitEvent` raised — K0.5.
 *
 * Written beside the journal row rather than into `effect_detail`, because the
 * detail string is a rendered sentence and an id in it is a second copy of a
 * format (which the Trace card's moment parser already is, under a test).
 * A column joins.
 */
export async function markEffectEmitted(eventId: string, effectIndex: number, emittedEventId: string): Promise<void> {
  const db = getDb();
  await db
    .update(appliedEffects)
    .set({ emittedEventId })
    .where(and(eq(appliedEffects.eventId, eventId), eq(appliedEffects.effectIndex, effectIndex)));
}

async function setEffectStatus(eventId: string, effectIndex: number, status: EffectJournalStatus): Promise<void> {
  const db = getDb();
  await db
    .update(appliedEffects)
    .set({ status, appliedAt: new Date().toISOString() })
    .where(and(eq(appliedEffects.eventId, eventId), eq(appliedEffects.effectIndex, effectIndex)));
}

export interface RuleTrigger {
  eventId: string;
  effectIndex: number;
  appliedAt: string;
  ruleName: string;
  eventType: string;
  effectDetail: string;
  /** K0.5. `0` on a row from before the column: never counted, not never failed. */
  failures: number;
  lastError: string | null;
  /** K0.5 — the event this row's `EmitEvent` raised, which is the call-tree's edge. */
  emittedEventId: string | null;
}

/**
 * Observability's Triggers tab (docs/design/06-macos-ui-data-wiring.md) —
 * most-recent-first, and only rows that actually carry attribution
 * (`ruleName` non-null) since rows written before the migration that added
 * these columns have none and would otherwise show as blank entries.
 *
 * `appliedAt` is millisecond-resolution wall-clock time (`markEffectApplied`'s
 * own `new Date().toISOString()`) — two effects from the same event (or two
 * events processed back-to-back) can land in the same millisecond, so
 * `rowid` (SQLite's own monotonic insertion order) breaks ties instead of
 * leaving same-timestamp rows in an arbitrary order.
 */
export async function getRecentRuleTriggers(limit = 50, offset = 0): Promise<RuleTrigger[]> {
  const db = getDb();
  const rows = await db
    .select({
      eventId: appliedEffects.eventId,
      effectIndex: appliedEffects.effectIndex,
      appliedAt: appliedEffects.appliedAt,
      ruleName: appliedEffects.ruleName,
      eventType: appliedEffects.eventType,
      effectDetail: appliedEffects.effectDetail,
      failures: appliedEffects.failures,
      lastError: appliedEffects.lastError,
      emittedEventId: appliedEffects.emittedEventId,
    })
    .from(appliedEffects)
    .where(isNotNull(appliedEffects.ruleName))
    .orderBy(desc(appliedEffects.appliedAt), desc(sql`rowid`))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => ({
    eventId: row.eventId,
    effectIndex: row.effectIndex,
    appliedAt: row.appliedAt,
    ruleName: row.ruleName!,
    eventType: row.eventType!,
    effectDetail: row.effectDetail!,
    failures: row.failures ?? 0,
    lastError: row.lastError ?? null,
    emittedEventId: row.emittedEventId ?? null,
  }));
}

export interface EffectJournalCensus {
  /** Every row, ever. Nothing prunes this table. */
  total: number;
  events: number;
  firstAt: string | null;
  lastAt: string | null;
  /** `status` counted rather than assumed — see `traceCensus` in the Trace route for why all of them say one word. */
  byStatus: { status: string; count: number }[];
  /** K0.5 — rows that have thrown at least once, and how many throws in total. */
  failed: { rows: number; throws: number };
  /** K0.5 — how many rows carry the emit edge, so the card can say what fraction of the chain it can follow. */
  emitEdges: { withEdge: number; emits: number };
  /** The first token of `effect_detail`, which is the effect's variant name. */
  byKind: { kind: string; count: number }[];
  byRule: { rule: string; count: number; kinds: string }[];
  byEventType: { eventType: string; events: number; effects: number }[];
  byDay: { date: string; count: number; events: number }[];
}

/**
 * The whole journal, counted in SQLite rather than carried into JS.
 *
 * The Trace card is pinned to the whole journal — 27k rows and growing, since
 * nothing in the system ever deletes from this table (`deleteRowsOlderThan`
 * touches signals, moments, llm_audit and orphaned embeddings, and not this).
 * Pulling those rows out to count them in the route is about 3MB of JSON for
 * five numbers; five grouped scans of an indexed 27k-row table is a few
 * milliseconds.
 *
 * `byRule` carries its rule's effect KINDS as a comma-joined string because
 * that is what makes the ranking readable: a rule with 10,576 rows that only
 * ever patches a moment and a rule with 689 that spends model calls are not
 * the same kind of busy, and the count alone cannot tell them apart.
 */
export async function getEffectJournalCensus(): Promise<EffectJournalCensus> {
  const db = getDb();
  const kind = sql<string>`CASE WHEN instr(effect_detail, ' ') > 0 THEN substr(effect_detail, 1, instr(effect_detail, ' ') - 1) ELSE effect_detail END`;
  const [totals, byStatus, failed, emitEdges, byKind, byRule, byEventType, byDay] = await Promise.all([
    db.all<{ total: number; events: number; firstAt: string | null; lastAt: string | null }>(
      sql`SELECT count(*) AS total, count(DISTINCT event_id) AS events, min(applied_at) AS firstAt, max(applied_at) AS lastAt FROM applied_effects`,
    ),
    db.all<{ status: string; count: number }>(sql`SELECT status, count(*) AS count FROM applied_effects GROUP BY 1 ORDER BY 2 DESC`),
    db.all<{ rows: number; throws: number }>(sql`SELECT count(*) AS rows, coalesce(sum(failures), 0) AS throws FROM applied_effects WHERE failures > 0`),
    db.all<{ withEdge: number; emits: number }>(
      sql`SELECT count(emitted_event_id) AS withEdge, count(*) AS emits FROM applied_effects WHERE effect_detail LIKE 'EmitEvent %'`,
    ),
    db.all<{ kind: string; count: number }>(sql`SELECT ${kind} AS kind, count(*) AS count FROM applied_effects WHERE effect_detail IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`),
    db.all<{ rule: string; count: number; kinds: string }>(
      sql`SELECT rule_name AS rule, count(*) AS count, group_concat(DISTINCT ${kind}) AS kinds FROM applied_effects WHERE rule_name IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
    ),
    db.all<{ eventType: string; events: number; effects: number }>(
      sql`SELECT event_type AS eventType, count(DISTINCT event_id) AS events, count(*) AS effects FROM applied_effects WHERE event_type IS NOT NULL GROUP BY 1 ORDER BY 3 DESC`,
    ),
    db.all<{ date: string; count: number; events: number }>(
      sql`SELECT substr(applied_at, 1, 10) AS date, count(*) AS count, count(DISTINCT event_id) AS events FROM applied_effects GROUP BY 1 ORDER BY 1`,
    ),
  ]);
  const head = totals[0];
  return {
    total: head?.total ?? 0,
    events: head?.events ?? 0,
    firstAt: head?.firstAt ?? null,
    lastAt: head?.lastAt ?? null,
    byStatus,
    failed: { rows: failed[0]?.rows ?? 0, throws: failed[0]?.throws ?? 0 },
    emitEdges: { withEdge: emitEdges[0]?.withEdge ?? 0, emits: emitEdges[0]?.emits ?? 0 },
    byKind,
    byRule,
    byEventType,
    byDay,
  };
}

/**
 * Every effect of the given events, so a row on the Trace card can answer
 * "what ELSE did this one event cause".
 *
 * This is as much of the audit's requested call-tree as the record holds. A
 * true tree would need the edge from an `EmitEvent` effect to the event it
 * emitted, and `describeEffect` writes only `EmitEvent <type>` — the emitted
 * event's id is never journaled, so the chain from a sensor event through
 * three internal hops cannot be reconstructed. What CAN be is one level: the
 * siblings of a row, which is the fan-out of one event.
 */
export async function getEffectsForEvents(eventIds: readonly string[]): Promise<RuleTrigger[]> {
  if (eventIds.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      eventId: appliedEffects.eventId,
      effectIndex: appliedEffects.effectIndex,
      appliedAt: appliedEffects.appliedAt,
      ruleName: appliedEffects.ruleName,
      eventType: appliedEffects.eventType,
      effectDetail: appliedEffects.effectDetail,
      failures: appliedEffects.failures,
      lastError: appliedEffects.lastError,
      emittedEventId: appliedEffects.emittedEventId,
    })
    .from(appliedEffects)
    .where(inArray(appliedEffects.eventId, [...eventIds]))
    .orderBy(appliedEffects.eventId, appliedEffects.effectIndex);
  return rows.map((row) => ({
    eventId: row.eventId,
    effectIndex: row.effectIndex,
    appliedAt: row.appliedAt,
    ruleName: row.ruleName ?? '',
    eventType: row.eventType ?? '',
    effectDetail: row.effectDetail ?? '',
    failures: row.failures ?? 0,
    lastError: row.lastError ?? null,
    emittedEventId: row.emittedEventId ?? null,
  }));
}
