import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { ownerAsks } from '../schemas/db-schema.js';

/** One reading of an answer — `AskProposal` in `@sundial/kernel`, restated structurally so `@sundial/db` depends on nothing. */
export interface StoredAskProposal {
  entityKind: string;
  canonicalName: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface UpsertOwnerAskInput {
  id: string;
  question: string;
  reason: string | null;
  askedAt: string;
  answer: string | null;
  answeredAt: string | null;
  /** `answered` | `expired` — see the schema comment on `owner_asks.outcome`. */
  outcome: string;
}

export interface StoredOwnerAsk extends UpsertOwnerAskInput {
  /** `null` is "not looked at yet"; `[]` is "looked at, nothing there". The card draws those differently. */
  proposals: StoredAskProposal[] | null;
}

/**
 * Upsert by id rather than insert-or-skip.
 *
 * `ownerAsk` writes a row exactly once per question today — on the answer or on
 * the expiry, never both, since the two branches are mutually exclusive. Upsert
 * anyway because the effect executor guarantees at-least-once delivery for
 * `WriteDB`: a replay of the same fold must land on the same row rather than
 * failing on a primary-key conflict.
 *
 * Only the closing columns are updatable. The question and when it was asked are
 * what actually happened, and a later write must not be able to rewrite them.
 */
export async function upsertOwnerAsk(input: UpsertOwnerAskInput): Promise<void> {
  const db = getDb();
  await db
    .insert(ownerAsks)
    .values(input)
    .onConflictDoUpdate({
      target: ownerAsks.id,
      set: { answer: input.answer, answeredAt: input.answeredAt, outcome: input.outcome },
    });
}

/**
 * A stored `proposals` column, parsed.
 *
 * Unreadable JSON degrades to `null` — "not looked at yet" — rather than to
 * `[]`, because `[]` is a claim the model made and this would be inventing it.
 * The backfill then simply reads that answer again.
 */
function parseProposals(raw: unknown): StoredAskProposal[] | null {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredAskProposal[]) : null;
  } catch {
    return null;
  }
}

/** Most recent first — how well Gnomon's asking is landing, answered and ignored alike. */
export async function getRecentOwnerAsks(limit = 50): Promise<StoredOwnerAsk[]> {
  const db = getDb();
  const rows = await db.select().from(ownerAsks).orderBy(desc(ownerAsks.askedAt)).limit(limit);
  return rows.map((row) => ({ ...row, proposals: parseProposals(row.proposals) }));
}

/**
 * The read-modify-write half of `UpdateOwnerAsk`, kept out of the rule the same
 * way `mergeMomentData` is. Only `proposals` is patchable: the question and
 * when it was asked are what actually happened.
 */
export async function updateOwnerAsk(askId: string, patch: { proposals?: StoredAskProposal[] }): Promise<void> {
  if (patch.proposals === undefined) return;
  const db = getDb();
  await db.update(ownerAsks).set({ proposals: JSON.stringify(patch.proposals) }).where(eq(ownerAsks.id, askId));
}

/**
 * The oldest answered ask no model has read yet, or null when the backfill has
 * drained. `proposals IS NULL` is the cursor — see the schema comment — so the
 * sweep needs no stored position of its own and cannot lose its place across a
 * restart.
 *
 * An ask the owner judged `wrong` is skipped. If the question was wrong, its
 * answer is unlikely to hold a fact, and asking a model to find one anyway is
 * spending a call to argue with them. Read from the LOG rather than from
 * `state.feedback.recent`, which keeps only the last 50 verdicts — a bounded
 * ring that has rotated would silently let the skip lapse.
 */
export async function getOldestUnharvestedOwnerAsk(): Promise<StoredOwnerAsk | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(ownerAsks)
    .where(
      and(
        isNull(ownerAsks.proposals),
        isNotNull(ownerAsks.answer),
        sql`not exists (select 1 from signals s where s.signal_type = 'feedback'
          and json_extract(s.data, '$.artifactKind') = 'owner_ask'
          and json_extract(s.data, '$.artifactId') = ${ownerAsks.id}
          and json_extract(s.data, '$.verdict') = 'wrong')`,
      ),
    )
    .orderBy(asc(ownerAsks.answeredAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { ...row, proposals: null };
}

/** One verdict the owner gave a QUESTION, as the log holds it. */
export interface StoredAskVerdict {
  askId: string;
  verdict: string;
  at: string;
}

/**
 * Every verdict ever pressed on an ask, oldest first.
 *
 * Read at boot to rebuild `state.ownerAsk.classGain`, which is fold-derived and
 * therefore lost as soon as the fold that built it is older than both the
 * snapshot and the replayed tail — the same failure, and the same fix, as
 * `loadAliasNames`. The difference is where the truth lives: a name lives in
 * `entity_facts`, and a verdict lives in the log, which is equally durable and
 * is the thing a full replay would read anyway.
 *
 * Unbounded on purpose. There is one such row today and there will be a few
 * dozen in a year; capping it would silently drop the oldest, which is exactly
 * the half `habituatedGain` needs in order to have recovered.
 */
export async function getAskVerdicts(): Promise<StoredAskVerdict[]> {
  const db = getDb();
  const rows = await db.all<{ askId: string; verdict: string; at: string }>(
    sql`select json_extract(data, '$.artifactId') as askId,
               json_extract(data, '$.verdict') as verdict,
               captured_at as at
          from signals
         where signal_type = 'feedback'
           and json_extract(data, '$.artifactKind') = 'owner_ask'
      order by captured_at`,
  );
  return rows.filter((row) => typeof row.askId === 'string' && row.askId !== '' && typeof row.verdict === 'string');
}
