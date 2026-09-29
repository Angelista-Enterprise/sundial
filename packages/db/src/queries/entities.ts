import { eq, and, getTableColumns, isNull, inArray, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { getDb } from '../db-client.js';
import { entities, entityFacts, memoryEmbeddings } from '../schemas/db-schema.js';

/**
 * L5 (docs/audit/remediation-todo.md's standalone bug list) — `%`/`_` are
 * SQLite `LIKE` wildcards; a raw name containing either (e.g. searching for
 * literally "50_percent" or "a%b") would match far more than intended, not
 * because of unescaped SQL (the value is still a parameterized bind, never
 * string-concatenated into the query) but because the wildcard *characters
 * themselves* pass through uninterpreted. Escaping them here — and pairing
 * with `ESCAPE '\'` at the call site — makes a literal `%`/`_` in `name`
 * match only that literal character.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface UpsertEntityInput {
  id: string;
  kind: string;
  canonicalName: string;
  createdAt: string;
}

export interface InsertEntityFactInput {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  validFrom: string;
  sourceEventId: string | null;
  createdAt: string;
  /** See `FactProvenance` (kernel/types.ts) — also picks the seed evidence weight below when `alpha`/`beta` aren't given explicitly. Defaults to `'inference'`, same as the column default, for callers that don't care about provenance. */
  provenance?: string;
  /** Phase 2a — Beta posterior evidence counts; default-seeded from `confidence`/`provenance` when omitted. */
  alpha?: number;
  beta?: number;
}

export interface StoredEntityFact {
  id: string;
  entityId: string;
  predicate: string;
  object: string;
  confidence: number;
  alpha: number;
  beta: number;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  sourceEventId: string | null;
  createdAt: string;
  provenance: string;
}

/** Default total Beta evidence count for an inferred fact — light enough that a single re-observation visibly moves the posterior. */
const INFERENCE_EVIDENCE_WEIGHT = 10;
/**
 * Provenance (almanac concepts/entity-facts-and-belief) — an owner assertion seeds a much heavier
 * evidence count so `decayCurrentFactConfidence`'s daily drift barely moves
 * it (decay is a multiplicative pull toward the uninformative (1,1) prior;
 * a bigger starting count takes proportionally longer to reach it), unlike
 * an inference's light seed which is meant to fade if never reconfirmed.
 */
const ASSERTION_EVIDENCE_WEIGHT = 40;
/** A fact extracted from something the owner said in chat: between an inference and a typed assertion. */
const CONVERSATION_EVIDENCE_WEIGHT = 20;

function evidenceWeightFor(provenance: string): number {
  if (provenance === 'assertion') return ASSERTION_EVIDENCE_WEIGHT;
  if (provenance === 'conversation') return CONVERSATION_EVIDENCE_WEIGHT;
  return INFERENCE_EVIDENCE_WEIGHT;
}

/**
 * Phase 2a (docs/design/08 §5, D7) — seed a Beta(alpha,beta) prior from an
 * initial 0-100 confidence so the derived mean round(100*alpha/(alpha+beta))
 * matches it (exact for the /10 heuristic seed values), with a light total
 * evidence count (~10) so a re-observation actually moves the posterior.
 */
export function seedBetaFromConfidence(confidence: number, evidenceWeight = INFERENCE_EVIDENCE_WEIGHT): { alpha: number; beta: number } {
  const c = Math.max(0, Math.min(100, confidence));
  return { alpha: Math.max(1, Math.round((c / 100) * evidenceWeight)), beta: Math.max(1, Math.round(((100 - c) / 100) * evidenceWeight)) };
}

/**
 * J2.4 `MergeEntity`: the survivor whose `aliases_json` holds `canonicalName`,
 * or null. The upsert path asks this before minting an entity, so a hashed
 * attendee the owner already named lands on the named person, not on a new
 * `person-<hash>` row. `aliases_json` is a JSON array of strings; the LIKE on
 * the quoted value is exact for a name without quotes, which a hash is.
 */
export async function resolveEntityAlias(canonicalName: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(sql`${entities.aliasesJson} like ${`%${JSON.stringify(canonicalName)}%`}`)
    .limit(1);
  return row?.id ?? null;
}

/**
 * Fold `from` into `into` (J2.4). Facts and embeddings move; the alias joins
 * the survivor's `aliases_json`; the `from` row goes, as `mergeProjectRows`
 * drops a merged project. Null when `into` does not exist — an exact name
 * with no named entity behind it is not a merge, and the caller says so.
 */
export async function mergeEntityRows(from: string, into: string, alias: string): Promise<{ facts: number; embeddings: number } | null> {
  const db = getDb();
  if (from === into) return null;
  const [survivor] = await db.select().from(entities).where(eq(entities.id, into));
  if (!survivor) return null;
  const movedFacts = await db.update(entityFacts).set({ entityId: into }).where(eq(entityFacts.entityId, from));
  const movedEmbeddings = await db.update(memoryEmbeddings).set({ refId: into }).where(and(eq(memoryEmbeddings.refType, 'entity'), eq(memoryEmbeddings.refId, from)));
  const aliases = new Set<string>(JSON.parse(survivor.aliasesJson || '[]') as string[]);
  aliases.add(alias);
  await db.update(entities).set({ aliasesJson: JSON.stringify([...aliases]) }).where(eq(entities.id, into));
  await db.delete(entities).where(eq(entities.id, from));
  return { facts: movedFacts.rowsAffected ?? 0, embeddings: movedEmbeddings.rowsAffected ?? 0 };
}

/** Idempotent — same precedent as `upsertProject`: entity identity is deterministic, so a repeat candidate for the same id is a harmless no-op update. */
export async function upsertEntity(input: UpsertEntityInput): Promise<void> {
  const db = getDb();
  await db
    .insert(entities)
    .values(input)
    .onConflictDoUpdate({ target: entities.id, set: { kind: input.kind, canonicalName: input.canonicalName } });
}

export async function insertEntityFact(input: InsertEntityFactInput): Promise<void> {
  const db = getDb();
  const provenance = input.provenance ?? 'inference';
  const seeded =
    input.alpha !== undefined && input.beta !== undefined
      ? { alpha: input.alpha, beta: input.beta }
      : seedBetaFromConfidence(input.confidence, evidenceWeightFor(provenance));
  await db.insert(entityFacts).values({ ...input, provenance, alpha: seeded.alpha, beta: seeded.beta });
}

/** Sets `validTo`/`supersededBy` on the fact being replaced — never deletes or overwrites its `object`. */
export async function supersedeEntityFact(factId: string, supersededByFactId: string, validTo: string): Promise<void> {
  const db = getDb();
  await db.update(entityFacts).set({ validTo, supersededBy: supersededByFactId }).where(eq(entityFacts.id, factId));
}

/**
 * Closes a fact's validity with no replacement — the owner said it was wrong.
 *
 * `supersededBy` is left NULL DELIBERATELY, and that is what makes a retraction
 * distinguishable from a supersession in the timeline: `validTo` set with
 * `supersededBy` null is a combination no other writer produces. Every
 * currently-believed read already filters on `valid_to IS NULL`, so this removes
 * the fact from belief without any read path needing to know retraction exists;
 * every history read keeps the row, which is the point — a correction is itself
 * information (`concepts/entity-facts-and-belief`).
 *
 * `WHERE valid_to IS NULL` makes it a no-op against an already-closed fact rather
 * than reopening and re-closing one: retraction must never move a boundary an
 * earlier supersession set, and the effect is replayed at-least-once.
 */
export async function retractEntityFact(factId: string, validTo: string): Promise<void> {
  const db = getDb();
  await db
    .update(entityFacts)
    .set({ validTo })
    .where(and(eq(entityFacts.id, factId), isNull(entityFacts.validTo)));
}

/**
 * Phase 2a (docs/design/08 §5, D7) — supporting evidence: bump a fact's Beta
 * `alpha` by `delta` and recompute the derived `confidence` mean, in one
 * statement (references the pre-update `alpha`/`beta`). Called when a
 * confirmed fact is re-observed (`contradictionCheck` Case 1) and, later, on a
 * successful prediction it generated (Phase 2b). The record is untouched — only
 * the certainty moves.
 */
export async function reinforceEntityFact(factId: string, delta: number, side: 'alpha' | 'beta' = 'alpha'): Promise<void> {
  const db = getDb();
  if (side === 'beta') {
    // lane C: evidence against — a failed prediction (`factTestTrack`). Same record rule: only the certainty moves.
    await db.run(
      sql`UPDATE entity_facts
          SET beta = beta + ${delta},
              confidence = CAST(ROUND(100.0 * alpha / (alpha + beta + ${delta})) AS INTEGER)
          WHERE id = ${factId}`,
    );
    return;
  }
  await db.run(
    sql`UPDATE entity_facts
        SET alpha = alpha + ${delta},
            confidence = CAST(ROUND(100.0 * (alpha + ${delta}) / (alpha + ${delta} + beta)) AS INTEGER)
        WHERE id = ${factId}`,
  );
}

/**
 * Phase 2a (docs/design/08 §5, D8 — "decay the certainty, never the record").
 * Decays every CURRENT fact's Beta counts toward the uninformative prior (1,1)
 * by `factor` (0<factor<1), then recomputes `confidence`. A fact reinforced
 * recently (high alpha/beta) barely moves; a stale, never-reconfirmed belief
 * drifts toward 50% ("I remember believing this — I'm no longer sure"). Never
 * touches `object`/`valid_from`/`valid_to` — the record and its timeline are
 * immutable. Two statements so the confidence recompute reads the decayed
 * alpha/beta.
 */
export async function decayCurrentFactConfidence(factor: number): Promise<void> {
  const db = getDb();
  await db.run(sql`UPDATE entity_facts SET alpha = 1 + (alpha - 1) * ${factor}, beta = 1 + (beta - 1) * ${factor} WHERE valid_to IS NULL`);
  await db.run(sql`UPDATE entity_facts SET confidence = CAST(ROUND(100.0 * alpha / (alpha + beta)) AS INTEGER) WHERE valid_to IS NULL`);
}

/** Full history for an entity, including superseded facts — ordered oldest-first so a supersession chain reads chronologically. */
/**
 * `limit`/`offset` default to "everything" (`Number.MAX_SAFE_INTEGER`/`0`) so every existing
 * caller (CLI, MCP) that just wants the full timeline keeps working unchanged — only the
 * daemon's `GET /entities/:id` route (paginating for the macOS UI) passes real values.
 */
export async function getEntityFactTimeline(entityId: string, limit = Number.MAX_SAFE_INTEGER, offset = 0): Promise<StoredEntityFact[]> {
  const db = getDb();
  return db.select().from(entityFacts).where(eq(entityFacts.entityId, entityId)).orderBy(entityFacts.validFrom).limit(limit).offset(offset);
}

/** Case-insensitive canonical-name lookup for `gnomon entity "<name>"` — resolves a free-text name to an entity id without requiring the caller to know it. */
/**
 * Entities matching a free-text name, by canonical name OR by a name currently
 * believed for them.
 *
 * The second half is the identity join, and it is done at the READ boundary on
 * purpose. A hashed attendee's entity is named for its hash and the human name
 * lives in a `knownAs` fact, so a canonical-name-only search could not find
 * `person-c205ca11f2` under "Alex Morgan" — and this function is what
 * `gnomon_entity_history` and the `/ask` context builder both use to turn a
 * question into candidates. On this record that hid 18 of 39 people from every
 * tool the model has: the record knew who they were and no lookup could reach
 * them by name.
 *
 * It also un-splits the five humans who exist twice — "Alex" (a natively-named
 * attendee) and `person-c205ca11f2` (`knownAs` "Alex Morgan") are one
 * person holding half the facts each. Both rows now come back from one query, so
 * a caller sees the whole person.
 *
 * Deliberately NOT a merge. `entity_facts` is append-only and never overwritten
 * (`almanac/decisions/fact-lifecycle-policy`); rewriting `entity_id` across two
 * entities would rewrite history to fix a lookup, and there is no merge path for
 * entities for exactly that reason. Joining the QUERY costs one extra scan and
 * loses nothing.
 */
export async function findEntitiesByName(name: string): Promise<{ id: string; kind: string; canonicalName: string; aliasesJson: string | null }[]> {
  const db = getDb();
  const pattern = `%${escapeLikePattern(name)}%`;
  // `aliasesJson` rides along for W4: the names a merge folded in are names the
  // entity still answers to — the calendar lists attendees by them.
  const columns = { id: entities.id, kind: entities.kind, canonicalName: entities.canonicalName, aliasesJson: entities.aliasesJson };

  const [byName, byBelief] = await Promise.all([
    db.select(columns).from(entities).where(sql`${entities.canonicalName} LIKE ${pattern} ESCAPE '\\'`),
    // Only CURRENT beliefs. A superseded name must not resurrect a person under
    // a name that was corrected — this record carries `person-c205ca11f2`
    // knownAs "Alexm" and, before that, knownAs "in which meeting where
    // they?", both superseded.
    db
      .selectDistinct(columns)
      .from(entities)
      .innerJoin(entityFacts, eq(entityFacts.entityId, entities.id))
      .where(and(eq(entityFacts.predicate, 'knownAs'), isNull(entityFacts.validTo), sql`${entityFacts.object} LIKE ${pattern} ESCAPE '\\'`)),
  ]);

  // One row per entity: a person can match on both halves at once.
  const found = new Map<string, { id: string; kind: string; canonicalName: string; aliasesJson: string | null }>();
  for (const row of [...byName, ...byBelief]) found.set(row.id, row);
  return Array.from(found.values());
}

/** Currently-valid (not superseded) facts for an entity — "what do I currently believe about X." */
export async function getCurrentEntityFacts(entityId: string): Promise<StoredEntityFact[]> {
  const db = getDb();
  return db
    .select()
    .from(entityFacts)
    .where(and(eq(entityFacts.entityId, entityId), isNull(entityFacts.validTo)))
    .orderBy(entityFacts.validFrom);
}

/** lane Q: currently-valid facts of one predicate on every entity of one kind — for a boot repair of a one-value predicate. */
export async function getCurrentFactsOfKind(kind: string, predicate: string): Promise<StoredEntityFact[]> {
  const db = getDb();
  return db
    .select(getTableColumns(entityFacts))
    .from(entityFacts)
    .innerJoin(entities, eq(entities.id, entityFacts.entityId))
    .where(and(eq(entities.kind, kind), eq(entityFacts.predicate, predicate), isNull(entityFacts.validTo)))
    .orderBy(entityFacts.validFrom);
}

/**
 * alias → the name currently believed for it, for every hashed person.
 *
 * The boot-time source of `KernelState.memory.aliasNames`. That map is a fast
 * lookup pure rules use in place of a query, mirrored by `contradictionCheck`
 * when it promotes a `knownAs` belief — which makes it fold-derived, and
 * fold-derived state is lost as soon as the fold that built it is older than
 * both the current snapshot and the replayed tail. On 2026-09-09 this machine
 * booted with an empty mirror against 18 valid `knownAs` facts, and `peopleAsk`
 * consequently asked the owner to name seven people it had already been told
 * about. Rehydrating from the facts is what makes the mirror true.
 *
 * Superseded and retracted rows are excluded by `validTo IS NULL`, so a
 * corrected name yields only the correction — the same "current belief" reading
 * `getCurrentEntityFacts` gives, batched across every person instead of one
 * query per entity.
 */
export async function loadAliasNames(): Promise<Record<string, string>> {
  const db = getDb();
  const rows = await db
    .select({ alias: entities.canonicalName, name: entityFacts.object })
    .from(entityFacts)
    .innerJoin(entities, eq(entityFacts.entityId, entities.id))
    .where(and(eq(entityFacts.predicate, 'knownAs'), isNull(entityFacts.validTo), eq(entities.kind, 'person')))
    .orderBy(entityFacts.validFrom);

  // Insertion order is `validFrom` ascending, so on the vanishingly unlikely
  // chance two un-superseded `knownAs` rows exist for one alias, the LATER one
  // wins — the same direction a fold would have resolved them.
  const named: Record<string, string> = {};
  // A hash merged into its named person (J2.4 `MergeEntity`) lives on as an
  // entry in the survivor's `aliases_json`; without this the fold would forget
  // it was ever named and `peopleAsk` would ask again.
  const merged = await db.select({ name: entities.canonicalName, aliases: entities.aliasesJson }).from(entities).where(and(eq(entities.kind, 'person'), ne(entities.aliasesJson, '[]')));
  for (const row of merged) {
    for (const alias of JSON.parse(row.aliases || '[]') as unknown[]) if (typeof alias === 'string' && alias !== '') named[alias] = row.name;
  }
  for (const row of rows) {
    if (typeof row.alias === 'string' && typeof row.name === 'string' && row.name !== '') named[row.alias] = row.name;
  }
  return named;
}

export interface EntityWithFactCount {
  id: string;
  kind: string;
  canonicalName: string;
  createdAt: string;
  factCount: number;
}

/**
 * The roster query the Entities List UI page needs (docs/design/06-macos-ui-data-wiring.md) —
 * didn't exist before this: every prior entity read path takes a name or id
 * and returns one entity. `factCount` is a `LEFT JOIN` + `GROUP BY`, not a
 * per-entity follow-up query, for the same reason `getEntityFactsWithEntityByIds`
 * batches instead of round-tripping per id.
 */
/** `limit`/`offset` default to "everything" — same reasoning as `getEntityFactTimeline` above; only the daemon's paginated `GET /entities` route passes real values. */
export async function getAllEntities(limit = Number.MAX_SAFE_INTEGER, offset = 0): Promise<EntityWithFactCount[]> {
  const db = getDb();
  return db
    .select({
      id: entities.id,
      kind: entities.kind,
      canonicalName: entities.canonicalName,
      createdAt: entities.createdAt,
      factCount: sql<number>`count(${entityFacts.id})`,
    })
    .from(entities)
    .leftJoin(entityFacts, eq(entityFacts.entityId, entities.id))
    .groupBy(entities.id)
    .orderBy(entities.canonicalName)
    .limit(limit)
    .offset(offset);
}

export interface StoredEntityFactWithEntity extends StoredEntityFact {
  canonicalName: string;
  entityKind: string;
}

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * `scoredSearch`'s batch-resolve for `entity_fact` embedding hits, same
 * `IN (...)` pattern D2 already uses for moments/knowledge entries. Joined
 * with `entities` because the fact row alone (`predicate`/`object`) doesn't
 * carry the human-readable name a search result needs to display.
 */
export async function getEntityFactsWithEntityByIds(ids: string[]): Promise<StoredEntityFactWithEntity[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: entityFacts.id,
      entityId: entityFacts.entityId,
      predicate: entityFacts.predicate,
      object: entityFacts.object,
      confidence: entityFacts.confidence,
      alpha: entityFacts.alpha,
      beta: entityFacts.beta,
      validFrom: entityFacts.validFrom,
      validTo: entityFacts.validTo,
      supersededBy: entityFacts.supersededBy,
      sourceEventId: entityFacts.sourceEventId,
      createdAt: entityFacts.createdAt,
      provenance: entityFacts.provenance,
      canonicalName: entities.canonicalName,
      entityKind: entities.kind,
    })
    .from(entityFacts)
    .innerJoin(entities, eq(entities.id, entityFacts.entityId))
    .where(inArray(entityFacts.id, ids));
}

/**
 * Every fact a given set of source events produced, current or superseded.
 *
 * The asks surface's one read of the other direction: a fact stores the event
 * it came from, so given the `ask:owner-answered` signals the card can say
 * which answers actually BECAME something. Superseded rows are kept on
 * purpose — the record's one auto-routed answer minted
 * `person-c205ca11f2 knownAs "in which meeting where they?"`, a counter-question
 * stored as a human's name, and a reading that hid it the moment the owner
 * corrected it would hide exactly the evidence that auto-routing was the
 * mistake.
 */
export async function getFactsBySourceEventIds(ids: string[]): Promise<StoredEntityFactWithEntity[]> {
  if (ids.length === 0) return [];
  const db = getDb();
  return db
    .select({
      id: entityFacts.id,
      entityId: entityFacts.entityId,
      predicate: entityFacts.predicate,
      object: entityFacts.object,
      confidence: entityFacts.confidence,
      alpha: entityFacts.alpha,
      beta: entityFacts.beta,
      validFrom: entityFacts.validFrom,
      validTo: entityFacts.validTo,
      supersededBy: entityFacts.supersededBy,
      sourceEventId: entityFacts.sourceEventId,
      createdAt: entityFacts.createdAt,
      provenance: entityFacts.provenance,
      canonicalName: entities.canonicalName,
      entityKind: entities.kind,
    })
    .from(entityFacts)
    .innerJoin(entities, eq(entities.id, entityFacts.entityId))
    .where(inArray(entityFacts.sourceEventId, ids));
}

export interface CurrentFactWithProof extends StoredEntityFact {
  /**
   * The activity moment the fact's source signal fell inside, when one can be
   * found — and `null` is the common, honest answer rather than a failure.
   */
  momentId: string | null;
  momentStart: string | null;
}

/**
 * Every current belief, with the moment it was first seen in.
 *
 * S-D shipped without the link from a fact to what proved it, on the grounds
 * that the memory route carried `sourceEventId` and no moment join. Measured
 * before building this: `source_event_id` is a SIGNAL id and never a moment id
 * — 345 of 442 current facts name a signal, the other 97 name nothing because
 * 96 of them are the owner's own assertions, which were said in a conversation
 * and were never watched. So the join has to go through TIME: the moment whose
 * span contains that signal's `capturedAt`. 194 facts land in one; the rest
 * were captured at a moment boundary (which is what closes a moment and mints
 * the fact) or inside a sub-20s moment that was never written.
 *
 * It is therefore "where I first saw this", not "the moments that proved it":
 * a fact stores ONE source event and counts the rest in `alpha`. A fact seen
 * 232 times has 232 moments behind it and the record kept a pointer to one.
 *
 * Batched deliberately. Per-fact this is 442 round trips; as one correlated
 * subquery over `idx_moments_start` it measured 70ms on the live 6,980-moment
 * record.
 */
export async function getCurrentFactsWithProof(): Promise<CurrentFactWithProof[]> {
  const db = getDb();
  const rows = await db.all<CurrentFactWithProof>(sql`
    select f.id, f.entity_id as entityId, f.predicate, f.object, f.confidence,
           f.alpha, f.beta, f.valid_from as validFrom, f.valid_to as validTo,
           f.superseded_by as supersededBy, f.source_event_id as sourceEventId,
           f.created_at as createdAt, f.provenance,
           m.id as momentId, m.start_time as momentStart
    from entity_facts f
    left join signals s on s.id = f.source_event_id
    left join moments m on m.id = (
      select m2.id from moments m2
      where m2.start_time <= s.captured_at and m2.end_time >= s.captured_at
      order by m2.start_time desc limit 1
    )
    where f.valid_to is null
    order by f.valid_from
  `);
  return rows;
}

export interface EntityGraphEdge {
  factId: string;
  fromEntityId: string;
  toEntityId: string;
  predicate: string;
  confidence: number;
  superseded: boolean;
  /** See `FactProvenance` (kernel/types.ts). Carried so a reader can tell an edge the owner asserted from one the sensors merely corroborated — at the same `confidence` the two are otherwise identical. */
  provenance: string;
}

/**
 * Entities → Graph's edge derivation (docs/design/06-macos-ui-data-wiring.md § Entities → Graph)
 * — there's no `to_entity_id` column on `entity_facts` (`object` is a free-text string, e.g.
 * "Xcode" or "Priya Nair"), so an edge only exists where that string happens to match another
 * entity's `canonicalName` (case-insensitive exact match — not a substring `LIKE`, to avoid
 * spurious edges like "gnomon" matching inside "gnomon-cli"). Includes superseded facts (`superseded:
 * true`) so the graph can render them dashed, per the design note — this is the one read path
 * that wants the full history, not just current beliefs.
 */
export async function getEntityGraphEdges(): Promise<EntityGraphEdge[]> {
  const db = getDb();
  const target = alias(entities, 'target_entity');
  const rows = await db
    .select({
      factId: entityFacts.id,
      fromEntityId: entityFacts.entityId,
      toEntityId: target.id,
      predicate: entityFacts.predicate,
      confidence: entityFacts.confidence,
      validTo: entityFacts.validTo,
      provenance: entityFacts.provenance,
    })
    .from(entityFacts)
    .innerJoin(target, sql`lower(${target.canonicalName}) = lower(${entityFacts.object})`)
    .where(ne(target.id, entityFacts.entityId));

  return rows.map((row) => ({
    factId: row.factId,
    fromEntityId: row.fromEntityId,
    toEntityId: row.toEntityId,
    predicate: row.predicate,
    confidence: row.confidence,
    superseded: row.validTo !== null,
    provenance: row.provenance,
  }));
}

/**
 * Confirmed beliefs most worth putting up for refutation, worst first.
 *
 * "Worth" is confidence × staleness, and both halves matter. A high-confidence
 * fact is where an error does the most damage, because it is the one that gets
 * read and repeated. A stale one is where an error is most LIKELY, because
 * nothing has re-observed it since it was written — the corroborative path
 * cannot correct a belief the world stopped mentioning, which is exactly the
 * belief this pass exists to catch.
 *
 * Ordered rather than randomly sampled, deliberately. A random sample would
 * eventually cover the table too, but it spends most nights on beliefs that
 * were reconfirmed this morning, and the pass is small enough that where it
 * looks is most of what it is.
 *
 * Only CURRENT facts (`valid_to IS NULL`). A superseded fact is already
 * disbelieved and refuting it again would be work with no possible outcome.
 * Assertions are excluded outright: `provenance = 'assertion'` means the owner
 * said so, and a model second-guessing the owner is not skepticism.
 */
export async function getFactsForRefutation(limit: number): Promise<StoredEntityFactWithEntity[]> {
  const db = getDb();
  const rows = await db.all<{
    id: string;
    entity_id: string;
    predicate: string;
    object: string;
    confidence: number;
    valid_from: string;
    valid_to: string | null;
    superseded_by: string | null;
    source_event_id: string | null;
    created_at: string;
    provenance: string;
    canonical_name: string;
    entity_kind: string;
  }>(sql`
    SELECT f.id, f.entity_id, f.predicate, f.object, f.confidence, f.valid_from, f.valid_to,
           f.superseded_by, f.source_event_id, f.created_at, f.provenance,
           e.canonical_name, e.kind AS entity_kind
    FROM entity_facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE f.valid_to IS NULL
      AND f.provenance <> 'assertion'
    ORDER BY f.confidence * (julianday('now') - julianday(f.valid_from)) DESC
    LIMIT ${limit}`);

  return rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    supersededBy: r.superseded_by,
    sourceEventId: r.source_event_id,
    createdAt: r.created_at,
    provenance: r.provenance,
    canonicalName: r.canonical_name,
    entityKind: r.entity_kind,
  })) as StoredEntityFactWithEntity[];
}

/**
 * J2.3 — every live fact the nightly belief audit puts to the judge: current
 * (`valid_to` null) and not an owner assertion (never retracted by a model, so
 * never sent). With the Beta counts, which the audit's state carries as
 * numbers. Ordered oldest-first so a budget cut falls on the newest.
 */
export async function getFactsForBeliefAudit(): Promise<StoredEntityFactWithEntity[]> {
  const db = getDb();
  const rows = await db.all<{
    id: string;
    entity_id: string;
    predicate: string;
    object: string;
    confidence: number;
    alpha: number;
    beta: number;
    valid_from: string;
    valid_to: string | null;
    superseded_by: string | null;
    source_event_id: string | null;
    created_at: string;
    provenance: string;
    canonical_name: string;
    entity_kind: string;
  }>(sql`
    SELECT f.id, f.entity_id, f.predicate, f.object, f.confidence, f.alpha, f.beta, f.valid_from, f.valid_to,
           f.superseded_by, f.source_event_id, f.created_at, f.provenance,
           e.canonical_name, e.kind AS entity_kind
    FROM entity_facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE f.valid_to IS NULL
      AND f.provenance <> 'assertion'
    ORDER BY f.valid_from ASC`);
  return rows.map((r) => ({
    id: r.id,
    entityId: r.entity_id,
    predicate: r.predicate,
    object: r.object,
    confidence: r.confidence,
    alpha: r.alpha,
    beta: r.beta,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    supersededBy: r.superseded_by,
    sourceEventId: r.source_event_id,
    createdAt: r.created_at,
    provenance: r.provenance,
    canonicalName: r.canonical_name,
    entityKind: r.entity_kind,
  }));
}

/** A retracted fact as the Trust surface shows it: closed without a successor, with the audit's answers when the audit closed it. */
export interface RetractedFactRow {
  id: string;
  canonicalName: string;
  entityKind: string;
  predicate: string;
  object: string;
  provenance: string;
  retractedAt: string;
  /** The `audit-fact` answers behind the retraction (is_false, is_artifact, still_current, usefulness), or null when an owner tap closed it. */
  audit: Record<string, number> | null;
}

/**
 * J2.3 — retractions with evidence. `valid_to` set and `superseded_by` null is
 * the state only a retraction produces (see `RetractFactEffect`); the evidence
 * is the audit's own `judgement:result` for that fact id, read back from the
 * log — the answers were never written anywhere else, and need not be.
 */
export async function listRetractedFacts(limit: number): Promise<RetractedFactRow[]> {
  const db = getDb();
  const rows = await db.all<{ id: string; canonical_name: string; entity_kind: string; predicate: string; object: string; provenance: string; retracted_at: string; answers: string | null }>(sql`
    SELECT f.id, e.canonical_name, e.kind AS entity_kind, f.predicate, f.object, f.provenance, f.valid_to AS retracted_at,
           (SELECT json_extract(s.data, '$.answers') FROM signals s
             WHERE s.signal_type = 'judgement' AND s.event_type = 'result'
               AND json_extract(s.data, '$.questionSetId') = 'audit-fact'
               AND json_extract(s.data, '$.metadata.factId') = f.id
             ORDER BY s.captured_at DESC LIMIT 1) AS answers
    FROM entity_facts f
    JOIN entities e ON e.id = f.entity_id
    WHERE f.valid_to IS NOT NULL AND f.superseded_by IS NULL
    ORDER BY f.valid_to DESC
    LIMIT ${limit}`);
  return rows.map((r) => {
    let audit: Record<string, number> | null = null;
    if (r.answers) {
      try {
        const parsed = JSON.parse(r.answers) as Record<string, { noul?: number; score?: number }>;
        audit = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v.noul === 'number' ? v.noul : (v.score ?? 0)]));
      } catch {
        audit = null;
      }
    }
    return { id: r.id, canonicalName: r.canonical_name, entityKind: r.entity_kind, predicate: r.predicate, object: r.object, provenance: r.provenance, retractedAt: r.retracted_at, audit };
  });
}

/**
 * The newest current fact for a profile predicate — what the OWNER has said
 * about themselves, for a surface that must not invent it.
 *
 * Built for the bedtime band, and the rule it serves is DESIGN.md's: a surface
 * that reports a policy asks the policy. The audit asked for the band to be
 * drawn against "the 23:00 intent line", and the record's own answer is that
 * there is no such intent — the owner asserted on 12 September that there is
 * "no fixed bedtime — the hour is decided by momentum", superseding an earlier
 * ~22:00, with 23:00 named only as that one night's plan. A line drawn from
 * that would be a target the owner has explicitly disclaimed.
 *
 * Newest-first over `valid_to IS NULL`, because a profile attribute holds one
 * value and the record supersedes rather than overwrites.
 */
export async function getProfileFact(predicate: string): Promise<{ object: string; provenance: string; validFrom: string } | null> {
  const rows = await getDb().all<{ object: string; provenance: string; validFrom: string }>(sql`
    select object, provenance, valid_from as validFrom
      from entity_facts
     where predicate = ${predicate} and valid_to is null
     order by valid_from desc
     limit 1
  `);
  return rows[0] ?? null;
}

/**
 * Everything the W2 hygiene pass plans against: every entity, and every
 * CURRENT fact with the signal type it came from. Two reads, no per-fact
 * lookups — on the live record 226 entities and ~500 facts, a few milliseconds.
 * The `signal_type` join is what lets the planner find facts from a producer
 * that has since been retired, which nothing on the fact row itself records.
 */
export async function getWorldForHygiene(): Promise<{
  entities: { id: string; kind: string; canonicalName: string }[];
  facts: { id: string; entityId: string; predicate: string; object: string; confidence: number; provenance: string; createdAt: string; sourceType: string | null }[];
}> {
  const db = getDb();
  const [rows, factRows] = await Promise.all([
    db.all<{ id: string; kind: string; canonicalName: string }>(sql`select id, kind, canonical_name as canonicalName from entities`),
    db.all<{ id: string; entityId: string; predicate: string; object: string; confidence: number; provenance: string; createdAt: string; sourceType: string | null }>(sql`
      select f.id, f.entity_id as entityId, f.predicate, f.object, f.confidence, f.provenance, f.created_at as createdAt, s.signal_type as sourceType
        from entity_facts f left join signals s on s.id = f.source_event_id
       where f.valid_to is null
    `),
  ]);
  return { entities: rows, facts: factRows };
}

/**
 * M2 — current facts whose LATEST owner verdict is `wrong`. `feedbackTrack`
 * retracts at verdict time, but the verdicts before 2026-09-17 never landed
 * theirs; the log still holds them, so hygiene repairs from it. A later
 * `useful` on the same fact wins.
 */
export async function getCurrentFactIdsLastMarkedWrong(): Promise<string[]> {
  const rows = await getDb().all<{ id: string }>(sql`
    with verdicts as (
      select json_extract(data, '$.artifactId') as id, json_extract(data, '$.verdict') as verdict,
             row_number() over (partition by json_extract(data, '$.artifactId') order by captured_at desc, signals.rowid desc) as rn
        from signals
       where signal_type = 'feedback' and event_type = 'verdict' and json_extract(data, '$.artifactKind') = 'entity_fact'
    )
    select f.id from verdicts v join entity_facts f on f.id = v.id
     where v.rn = 1 and v.verdict = 'wrong' and f.valid_to is null
  `);
  return rows.map((r) => r.id);
}
