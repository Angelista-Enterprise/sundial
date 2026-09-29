import { sqliteTable, text, integer, real, blob, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * The log (docs/design/01-events-and-log.md). Append-only — every sensor
 * event, sanitized at ingest, lands here. Everything derived (KernelState,
 * moments, baselines) is computed by folding this table through the kernel's
 * reduce(), starting in Phase 2. Schema is deliberately minimal in Phase 1:
 * just enough columns to store a SanitizedEvent and query it back.
 */
export const signals = sqliteTable(
  'signals',
  {
    id: text('id').primaryKey(),
    signalType: text('signal_type').notNull(),
    eventType: text('event_type').notNull(),
    sessionId: text('session_id'),
    data: text('data').notNull(), // JSON payload, already sanitized before insert
    capturedAt: text('captured_at').notNull(),
  },
  (table) => [
    index('idx_signals_type').on(table.signalType),
    index('idx_signals_captured').on(table.capturedAt),
    index('idx_signals_session').on(table.sessionId),
    // Every read of one stream over a window — `streamQuery` in
    // `queries/work-shape.ts` and its siblings — filters on all three of these
    // together. With only the single-column indexes above, SQLite took
    // `idx_signals_type` and scanned every `event` row (the bulk of 394k) to
    // test the other two: 760ms for one fourteen-day stream, and every
    // instrument on the board asks for several. As a covering index this is
    // 10ms, and the instruments' reads stopped being the boot cost.
    index('idx_signals_stream').on(table.signalType, table.eventType, table.capturedAt),
  ],
);

/**
 * Materialized view of closed activity sessions — single writer (the
 * `momentClose` rule's `WriteDB` effect, docs/design/02-state-and-reducer.md).
 * Phase 2 columns are deliberately minimal (process + rollup JSON only);
 * project/meeting/focus-quality fields arrive with their sensors in Phase 3.
 */
export const moments = sqliteTable(
  'moments',
  {
    id: text('id').primaryKey(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    durationMs: integer('duration_ms').notNull(),
    processName: text('process_name').notNull(),
    data: text('data').notNull(), // JSON MomentRollup
    // Phase 6b (docs/design/05-memory-and-knowledgebase.md §1/§5) —
    // importanceScore is a 1-10 heuristic set once at write time
    // (`computeMomentImportance`, @sundial/memory), decayed on `day:boundary`
    // by `memoryDecay`; `lastAccessedAt` is bumped whenever `gnomon search`
    // surfaces the row (an LRU-like signal), independent of decay.
    importanceScore: integer('importance_score').notNull().default(1),
    lastAccessedAt: text('last_accessed_at'),
    // Phase 7 — found missing while building `gnomon_project_status`: nothing
    // persisted `state.moment.projectId` (tracked in KernelState since Wave
    // 3a) into the row itself, so there was no way to query "moments for
    // project X" from the DB at all, only in-memory for the currently-open
    // moment. `momentClose` now includes it here.
    projectId: text('project_id'),
  },
  (table) => [index('idx_moments_start').on(table.startTime), index('idx_moments_project').on(table.projectId)],
);

/**
 * KernelState snapshots (decision #2, docs/design/00-overview.md). Boot
 * replay reads the latest row, then folds `signals` rows with
 * `id > log_offset` through reduce() to catch up — `log_offset` is the last
 * processed signal id (a ULID, sorts lexically — no separate counter needed).
 */
export const kernelStateSnapshots = sqliteTable(
  'kernel_state_snapshots',
  {
    id: text('id').primaryKey(),
    createdAt: text('created_at').notNull(),
    stateJson: text('state_json').notNull(),
    logOffset: text('log_offset').notNull(),
  },
  (table) => [index('idx_kernel_state_snapshots_created').on(table.createdAt)],
);

/**
 * Effect journal (A2, docs/audit/production-proposal-and-enhancements.md) —
 * one row per (event, effect index) already executed. Boot replay folds
 * every tail event through `reduce()` for state (cheap, pure), but the
 * executor consults this table before running any one of that event's
 * effects: a journaled index is skipped (it already ran, live, before a
 * crash the last snapshot didn't catch up to); an unjournaled index runs now
 * and is marked immediately after. This is what turns "replay re-executes
 * every effect in the tail" (real LLM calls, duplicate log appends, double
 * decay) into "replay re-executes only the one effect that was truly
 * in-flight when the process died." Not pruned by retention — it's only
 * ever consulted for the (small) tail since the last snapshot, so it can't
 * grow unbounded the way `kernel_state_snapshots` did; a future pass could
 * still prune rows older than the oldest snapshot if this ever needs it.
 *
 * `status` makes the journal two-phase, and the reason is the one effect class
 * that does not exist yet. Until 2026-07-29 a row was written only AFTER its
 * effect ran, which leaves exactly one hole: a process that dies between an
 * effect finishing and its journal row committing re-runs that effect once on
 * the next boot. For every effect in the union today that is a known, accepted
 * cost — a duplicate DB write against a deterministic id, or at worst one extra
 * LLM call. For an outward action it is a second email, a second door opening.
 * Recording intent BEFORE execution and completion after means replay can tell
 * "never started" from "started, outcome unknown", which is the distinction an
 * at-most-once effect needs and an at-least-once effect can ignore. See
 * `kernel/effect-delivery.ts` for which effects get which guarantee.
 */
export const appliedEffects = sqliteTable(
  'applied_effects',
  {
    eventId: text('event_id').notNull(),
    effectIndex: integer('effect_index').notNull(),
    appliedAt: text('applied_at').notNull(),
    /**
     * `started` — intent recorded, outcome unknown. `completed` — ran to
     * completion. `indeterminate` — found `started` on a later boot, and the
     * effect's own delivery guarantee forbade re-running it, so it was
     * abandoned rather than repeated. Kept as its own value, not folded into
     * `completed`, because "we do not know whether this happened" is a
     * different fact from "this happened" and an audit trail that conflates
     * them is worse than none.
     *
     * Defaults to `completed` for the sake of rows written before this column
     * existed, which is accurate: the old code only ever inserted after a
     * successful run. New writes always pass a status explicitly — the
     * write-after-success helper was removed rather than kept alongside, so no
     * caller can fall through to the default by forgetting.
     */
    status: text('status').notNull().default('completed'),
    // Observability's Triggers tab (docs/design/06-macos-ui-data-wiring.md) — "extend the
    // effect journal with rule names" rather than a separate rule_trigger_log table, since this
    // journal already writes exactly once per effect at the same point a rule name would be
    // known. Nullable: rows written before this migration have none, and stay that way forever
    // (not backfilled) — the Triggers tab just shows nothing for that historical tail.
    ruleName: text('rule_name'),
    eventType: text('event_type'),
    effectDetail: text('effect_detail'),
    /**
     * K0.5 — how many times this effect has THROWN, and the newest message.
     *
     * Deliberately a counter beside `status` rather than a fourth status
     * value, because a failure and an outcome are different facts and this
     * journal proved it by losing them: an effect that threw left `started`,
     * was re-run on the next boot (every variant is `at-least-once`) and was
     * stamped `completed` — so all 27,029 rows said `completed` and the one
     * surface able to report a failed side effect reported the opposite.
     * A count survives the later success, which is what makes "this worked on
     * the third try" sayable at all.
     *
     * `0` on a row written before this column means "never counted", NOT
     * "never failed". There is no backfill: a failure that healed left no
     * trace anywhere.
     */
    failures: integer('failures').notNull().default(0),
    lastError: text('last_error'),
    /**
     * K0.5 — for an `EmitEvent`, the id of the event it emitted.
     *
     * The edge the Trace card's call-trees needed and did not have.
     * `describeEffect` writes `EmitEvent <type>` and nothing else, so the chain
     * from one sensor reading through three internal hops could not be rebuilt
     * — and that chain is most of the traffic: 15,684 of the 20,839 events
     * Gnomon acted on it raised itself. The effect already carries the child's
     * derived id before dispatch, so this costs one field and no lookup.
     *
     * It is the id the executor INTENDED to ingest. An emit the ingest gate
     * deduped as an unchanged observation still records it, and the join
     * simply finds no rows — which is the truth about that hop.
     */
    emittedEventId: text('emitted_event_id'),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.effectIndex] })],
);

/**
 * Minimal identity groundwork for later WCS-style project/organization
 * tracking (rule-based auto-detection, confidence-scored candidates,
 * per-project settings) — NOT ported yet, deliberately deferred (needs
 * months of observation data to be worth building). This table exists so
 * "project" has a stable, durable id now rather than needing every already-
 * logged moment backfilled with one later. `id` is the root path itself —
 * already the natural unique key, and using it directly means `projectTrack`
 * (a pure rule, no I/O) never needs a DB round-trip to know a project's id.
 */
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(), // the project's root path
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    organizationId: text('organization_id'), // nullable — no org-assignment mechanism exists yet
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_projects_root_path').on(table.rootPath)],
);

/**
 * Every LLM call, one row, record-then-patch (Phase 4, docs/design/03-
 * effects-and-llm-policy.md) — the effect executor's `ScheduleLLM` dispatch
 * is the only write path. Deliberately simplified vs WCS's `llm_audit`:
 * dropped the multi-endpoint-fallback fields (`endpoint`/`cooldownMs`/
 * `consecutiveFailures`/`parentAuditId`) since Gnomon's `@sundial/llm`
 * transport is single-endpoint, not task-routed across several — those
 * fields had nothing to describe here. `momentId` replaces WCS's
 * `sessionId` (window-session concept Gnomon doesn't have).
 */
export const llmAudit = sqliteTable(
  'llm_audit',
  {
    id: text('id').primaryKey(),
    momentId: text('moment_id'),
    purpose: text('purpose').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    requestedAt: text('requested_at').notNull(),
    respondedAt: text('responded_at'),
    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code'),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    responseContent: text('response_content'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    totalTokens: integer('total_tokens'),
    error: text('error'),
    /**
     * One of `LLM_ERROR_CLASSES`, decided at the call site from the error
     * object. NULL on a success and on every failure written before the column
     * existed — reads fall back to `classifyStoredLlmError` for those, and only
     * for those (see `@sundial/helpers/llm-error-class`).
     */
    errorClass: text('error_class'),
    /**
     * Prompt tokens the provider was handed on a call that failed — an
     * estimate from the sent prompt, since the response that would have
     * carried `usage` never arrived. NULL on a success, where `prompt_tokens`
     * is a measured count. Kept apart from it so the two are never summed as
     * if they were the same kind of number (see
     * `@sundial/helpers/llm-billed-tokens`).
     */
    billedPromptTokens: integer('billed_prompt_tokens'),
    /**
     * The part of `prompt_tokens` the provider served from its prefix cache.
     *
     * NOT a separate quantity to be summed with `prompt_tokens` — it is a
     * SUBSET of it, and the fresh half is the subtraction. Kept apart because
     * the two halves are priced an order of magnitude apart: on the live
     * record 85.5% of chat input was a cache read, and pricing all of it at
     * the input rate overstated the chat's input cost by 2.79x. Every
     * row written before this column existed reads NULL and is priced the old
     * way, so a historical number does not silently change shape.
     */
    cacheReadTokens: integer('cache_read_tokens'),
    /**
     * Which try this row is, 1 for the first. The retry layer
     * (`performScheduledLlmCall`) makes a NEW audit row per attempt, so before
     * this column a call that failed and a call that failed three times and
     * then answered were the same four rows with nothing joining them — the
     * "lost answers" question the ledger could not answer.
     */
    attempt: integer('attempt').notNull().default(1),
    /** The `llm_audit.id` of the attempt this one is retrying. NULL on a first attempt and on every row written before the column existed. */
    parentCallId: text('parent_call_id'),
  },
  (table) => [index('idx_llm_audit_requested').on(table.requestedAt), index('idx_llm_audit_purpose').on(table.purpose)],
);

/**
 * Phase 5's `companionInsight` output — a minimal version of WCS's
 * `knowledge_entries` (dropped: `metadata` JSON blob with workflow/mode/
 * facts/evidence, entity/fact linkage — that richer shape is Phase 6's
 * scope, once the temporal knowledge graph exists to link into). `dedupeKey`
 * has a real unique index (not just app-level checking) so a repeat insight
 * is a harmless no-op insert (`onConflictDoNothing`), not a read-then-write
 * race — same idempotent-upsert reasoning as `moments`/`projects`.
 */
export const knowledgeEntries = sqliteTable(
  'knowledge_entries',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    // Optional JSON of the entry's structured form — currently only `kind:'daily'`
    // journals set it (a stringified `JournalResult`: tldr/narrative/noticed/
    // followups), so the UI can render sections natively instead of re-parsing
    // the markdown `body`. `body` stays the human-readable form for search,
    // reflection synthesis, and CLI display.
    structured: text('structured'),
    severity: text('severity'),
    dedupeKey: text('dedupe_key').notNull(),
    sourceEventId: text('source_event_id'),
    createdAt: text('created_at').notNull(),
    // Phase 6b, same reasoning as `moments.importanceScore`/`lastAccessedAt` above.
    importanceScore: integer('importance_score').notNull().default(5),
    lastAccessedAt: text('last_accessed_at'),
    /**
     * When the owner said this entry was wrong. NULL for every entry that has
     * not been corrected, which is nearly all of them.
     *
     * Deliberately a retraction rather than a delete, for the reason
     * `RetractFactEffect` gives about facts: the row is what the entry
     * *claimed*, and deleting it loses the record that Gnomon said it. A
     * retracted entry keeps its place in history and stops being retrievable —
     * `scoredSearch` treats it exactly as it treats a superseded fact, sweeping
     * its embedding so the claim can never come back as evidence for a later
     * answer.
     */
    retractedAt: text('retracted_at'),
  },
  (table) => [uniqueIndex('idx_knowledge_entries_dedupe').on(table.dedupeKey), index('idx_knowledge_entries_created').on(table.createdAt)],
);

/**
 * Ask threads — a materialized view of the `ask:answered`/`ask:remembered`
 * events in the log, with `askTrack` as its single writer (same relationship
 * `moments` has to `momentClose`). NOT the source of truth: the log is, and
 * this table is rebuildable from it.
 *
 * A thread lives here rather than in `KernelState` because an answer is
 * unbounded prose and `KernelState` is serialized whole into every snapshot;
 * `state.ask` keeps only the metadata a rule needs. It lives here rather than
 * in `llm_audit` (which already stores the prompt and response of the same
 * call) because an audit row is about a model call — one exists for a failed
 * call and none exists for an answer refused from the record — while a thread
 * is about a question the owner asked.
 *
 * `remembered` is the owner's decision to promote the answer into the
 * knowledgebase, and `rememberedEntryId` names the `knowledge_entries` row that
 * promotion created. A thread is history either way; only a remembered one is
 * retrievable memory. `sourceCount` is kept precisely so a later rule can
 * decide to promote a well-sourced answer on its own — the manual button is the
 * first version of that policy, not a replacement for it.
 */
export const askThreads = sqliteTable(
  'ask_threads',
  {
    id: text('id').primaryKey(),
    question: text('question').notNull(),
    answer: text('answer'),
    /** Why there is no answer, when there is none — the record not containing it is a real outcome, not an error. */
    reason: text('reason'),
    /** How many observed rows the answer was drawn from. The confidence the UI renders as observation dots. */
    sourceCount: integer('source_count').notNull().default(0),
    /** JSON `AskSource[]` — what was read, kept so a thread can still show its provenance after the fact. */
    sources: text('sources'),
    askedAt: text('asked_at').notNull(),
    /**
     * How many LLM round trips the tool loop took to answer.
     *
     * Stored on the thread rather than left to `llm_audit` because the audit
     * table has no thread id to join on — its one correlation column is
     * `moment_id`, and an asked question has no moment. Without these two
     * columns "which questions needed the most work" is unanswerable even
     * though every individual call is recorded.
     */
    rounds: integer('rounds').notNull().default(1),
    /** JSON `string[]` of the distinct tools that produced a result, in first-use order — how the question was answered, beside what the answer was. */
    toolsUsed: text('tools_used'),
    /**
     * JSON `Figure[]` — the typed visual fragments the assistant chose to draw
     * instead of writing another paragraph.
     *
     * Persisted, unlike the trace, because a figure is part of the answer
     * rather than a record of how it was produced: a thread reopened next week
     * has to show what it showed at the time. Re-composing it on read would
     * quietly redraw it against today's data, so a question about last Tuesday
     * would answer itself differently every time it was reopened.
     */
    figures: text('figures'),
    remembered: integer('remembered', { mode: 'boolean' }).notNull().default(false),
    rememberedAt: text('remembered_at'),
    rememberedEntryId: text('remembered_entry_id'),
    sourceEventId: text('source_event_id'),
  },
  (table) => [index('idx_ask_threads_asked').on(table.askedAt)],
);

/**
 * Questions GNOMON asked the OWNER — the mirror of `ask_threads`, which records
 * questions the owner asked Gnomon.
 *
 * A separate table rather than a reuse of `ask_threads` because that table's
 * shape is wrong in both directions: `rounds`, `sources`, `figures` and
 * `remembered` describe how an ANSWER was researched, and none of them means
 * anything for a one-line question waiting on a human. Overloading it would
 * leave four columns permanently null and make "how often does Gnomon get an
 * answer" a query nobody can write correctly.
 *
 * `outcome` carries `expired` rows on purpose. A table of only-answered
 * questions would report the asking as perfectly calibrated by construction;
 * the ignored ones are the entire signal about whether Gnomon asks well.
 */
export const ownerAsks = sqliteTable(
  'owner_asks',
  {
    id: text('id').primaryKey(),
    question: text('question').notNull(),
    /** Why it was worth asking, in the model's own words. Null when it gave none. */
    reason: text('reason'),
    askedAt: text('asked_at').notNull(),
    /** Null for an `expired` row — an unanswered question has no answer, and storing one would invent it. */
    answer: text('answer'),
    answeredAt: text('answered_at'),
    /** `answered` | `expired`. */
    outcome: text('outcome').notNull(),
    /**
     * What a model read in the answer, filed BESIDE it — a JSON array of
     * `AskProposal` (`@sundial/kernel`). Never a fact: the owner pressing Keep
     * on the card is what writes one, the same way `transcript-clean` leaves
     * the raw capture the truth until they press Accept.
     *
     * Three states and the card needs all three. `NULL` is "not looked at
     * yet", which is also `askHarvestBackfill`'s cursor through the answers
     * that predate the rule; `[]` is "looked at, nothing there", which is what
     * most answers are; a non-empty array is a filled-in form.
     */
    proposals: text('proposals'),
  },
  (table) => [index('idx_owner_asks_asked').on(table.askedAt)],
);

/**
 * Phase 6 core memory (docs/design/05-memory-and-knowledgebase.md §4) —
 * durable identities the temporal knowledge graph attaches facts to. `id` is
 * deterministic (`${kind}:${slug(canonicalName)}`), assigned by the rule that
 * proposes a fact — same "no DB read needed to know an id" precedent as
 * `projects`. `aliasesJson` exists for future name-variant merging (e.g.
 * a short name vs a full email address for one person) — not populated yet, no merge logic
 * built this phase; deliberately not left out of the schema so it doesn't
 * need a later migration once that logic exists.
 */
export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // 'person' | 'project' | 'tool' | 'topic'
    canonicalName: text('canonical_name').notNull(),
    aliasesJson: text('aliases_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_entities_kind').on(table.kind)],
);

/**
 * Subject-predicate-object rows about an entity, each scoped to a validity
 * window (Zep-style fact invalidation, §4). A conflicting new observation
 * never overwrites a row — it sets `validTo`/`supersededBy` on the old one
 * and inserts a new row, so "who was I working with on this before Sam"
 * stays answerable. `id` is generated by the rule proposing the fact
 * (`contradictionCheck`), not the executor, so the rule can reference its own
 * candidate's id in `state.memory.factCursor` without a round-trip.
 */
export const entityFacts = sqliteTable(
  'entity_facts',
  {
    id: text('id').primaryKey(),
    entityId: text('entity_id').notNull(),
    predicate: text('predicate').notNull(),
    object: text('object').notNull(),
    confidence: integer('confidence').notNull(), // derived posterior mean, 0-100 (see alpha/beta) — kept as the read-path value
    // Phase 2a (docs/design/08 §5, decisions D7/D8) — Beta(alpha,beta) posterior
    // over this fact's truth. `confidence` is the derived mean
    // round(100*alpha/(alpha+beta)); alpha/beta are the evidence counts that
    // MOVE it: reinforced on re-observation (`reinforceEntityFact`) and decayed
    // toward the uninformative prior (1,1 → 50%) over time
    // (`decayCurrentFactConfidence`). D8: the *certainty* (alpha/beta/confidence)
    // fades or shifts; the *record* (object, valid_from/valid_to chain) never
    // changes. Seeded from the initial confidence on insert. Default (1,1) so a
    // pre-Phase-2a row hydrates to an uninformative prior.
    alpha: real('alpha').notNull().default(1),
    beta: real('beta').notNull().default(1),
    validFrom: text('valid_from').notNull(),
    validTo: text('valid_to'),
    supersededBy: text('superseded_by'),
    sourceEventId: text('source_event_id'),
    createdAt: text('created_at').notNull(),
    // Provenance (`almanac/concepts/entity-facts-and-belief.md`) — where this fact came from: 'inference'
    // (heuristic/LLM guess, the only thing that ever wrote this column before
    // this field existed, hence the default), 'assertion' (owner-authored,
    // superseded a confirmed fact on a single observation instead of waiting
    // for corroboration), or 'assistant' (reserved, unused today). Survives
    // onto the row so a reader can tell a corrected fact from a corroborated
    // one — gating the write isn't enough on its own.
    provenance: text('provenance').notNull().default('inference'),
  },
  (table) => [
    index('idx_entity_facts_entity').on(table.entityId),
    index('idx_entity_facts_valid_to').on(table.validTo),
    // `getEntityFactTimeline` orders by this column per-entity (the roster's paginated fact
    // history) — was unindexed before, so every page beyond the first still did a filtered
    // scan-then-sort over the whole entity's facts.
    index('idx_entity_facts_valid_from').on(table.validFrom),
  ],
);

/**
 * Vectors for semantic retrieval (§6) — computed by a local, on-device
 * model only (decision #5, `CLAUDE.md`'s "embeddings stay local, no remote
 * path"). D1 (docs/audit/production-proposal-and-enhancements.md, fixes
 * A§5.4) stores `vector` as a BLOB (a packed `Float32Array`) instead of a
 * JSON-encoded float array — more compact and faster to (de)serialize,
 * independent of which embedding scheme produced it; `model` (e.g.
 * `local-hash-256-v1` vs `ollama-nomic-embed-text-v1`) is what lets
 * `cosineSimilarity` (`packages/memory/src/local-embedding.ts`) safely treat
 * differently-dimensioned vectors as simply not comparable (0 relevance)
 * rather than crashing, so old and new vectors can coexist in this table
 * across a model swap without a migration.
 */
export const memoryEmbeddings = sqliteTable(
  'memory_embeddings',
  {
    id: text('id').primaryKey(),
    refType: text('ref_type').notNull(), // 'moment' | 'knowledge_entry'
    refId: text('ref_id').notNull(),
    model: text('model').notNull(),
    vector: blob('vector', { mode: 'buffer' }).notNull(), // packed Float32Array
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_memory_embeddings_ref').on(table.refType, table.refId)],
);

/**
 * The commitment ledger — one row per piece of work spanning hours to weeks.
 *
 * The memory tier `decisions/assistant-as-an-event-source` named as the hole in
 * the four-tier model. `entities` already holds a `task` minted from the same
 * git branch (C13); this holds the THREAD — when it opened, how many times it
 * was returned to, how many distinct days it spanned, and whether it has gone
 * quiet. Identity matches the task entity's name derivation, so the ledger and
 * the knowledge graph can be read against each other.
 *
 * `id` is `commitment:<slug of the task name>`, so re-seeing a branch after a
 * restart or a replay updates one row rather than accumulating duplicates.
 */
export const commitments = sqliteTable(
  'commitments',
  {
    id: text('id').primaryKey(),
    /** `BOX-508`, or `redesign-and-tablet`. */
    name: text('name').notNull(),
    /** Only `git-branch` is wired. A column rather than an assumption, so a second source needs no migration. */
    source: text('source').notNull(),
    branch: text('branch').notNull(),
    projectId: text('project_id'),
    projectName: text('project_name'),
    openedAt: text('opened_at').notNull(),
    lastTouchedAt: text('last_touched_at').notNull(),
    /** Moments that carried this branch. */
    touches: integer('touches').notNull().default(0),
    /** Distinct LOCAL days seen — the measure of "spanning", as opposed to elapsed clock time. */
    activeDays: integer('active_days').notNull().default(1),
    closedAt: text('closed_at'),
    /** Why it closed: `went-quiet`, `seen-done`, `owner`, and (UC1) `kept`, `broken`, `dropped`. */
    closedBecause: text('closed_because'),
    /**
     * UC1: a promise's terms as JSON (`PromiseTerms`: direction, counterparty,
     * due and its kind, deliverable and key nouns, quote, evidence). NULL on a
     * branch thread, and on every row from before the column.
     */
    promise: text('promise'),
  },
  (table) => [index('idx_commitments_open').on(table.closedAt, table.lastTouchedAt), index('idx_commitments_project').on(table.projectId)],
);

/**
 * Every resolved prediction, durably — the forward model's fitness record.
 *
 * `KernelState.predictions.recentResolved` is a BOUNDED window (50 entries) and
 * was the only place a resolution was ever written down. That is right for a UI
 * strip and wrong for a measurement: ambition A08 ("when Gnomon says it is 70%
 * sure, it is right about 70% of the time") requires 100 resolutions before it
 * will report a calibration figure at all, and read the 50-entry window to count
 * them. The ambition was unreachable as built, and reported as merely behind.
 *
 * So the window stays what it is and this table becomes the system of record.
 * Snapshots truncate; rows do not.
 *
 * `id` is the OPEN prediction's own derived id, which makes the write idempotent
 * under boot replay for the same reason every other `at-least-once` effect is —
 * re-running produces the same row rather than a second one.
 *
 * `forecaster` is stored from the start even though only one exists. Two
 * forecasters competing on the SAME `kind` is the whole point of scoring them
 * separately, and a column added later cannot backfill which of them produced a
 * historical row.
 */
export const predictions = sqliteTable(
  'predictions',
  {
    id: text('id').primaryKey(),
    /** What was predicted, e.g. `day-ending`. */
    kind: text('kind').notNull(),
    /** Which forecaster produced the prior for this `kind`. */
    forecaster: text('forecaster').notNull(),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at').notNull(),
    priorProb: real('prior_prob').notNull(),
    /** JSON — the conditioning features the prior was formed from (e.g. `{"hour":17}`), so a later pass can re-fit without replaying. */
    features: text('features'),
    /** 1 = the predicted event happened. */
    outcome: integer('outcome').notNull(),
    /** −ln(p assigned to the actual outcome), in nats. */
    surprise: real('surprise').notNull(),
    /**
     * K0.3 — the target's base rate over every resolution BEFORE this one.
     *
     * The fair opponent for a skill figure. Nullable twice over: a target's
     * first resolution has no past to average, and rows written before this
     * column have none. A missing baseline is "no opponent" and never zero —
     * a zero would hand the forecaster an infinitely easy contest.
     */
    baseProb: real('base_prob'),
  },
  (table) => [index('idx_predictions_kind_resolved').on(table.kind, table.resolvedAt), index('idx_predictions_resolved').on(table.resolvedAt)],
);

/**
 * Every gate verdict, with its arithmetic — the durable half of the gate's
 * decision record (`almanac/architecture/rules/noticing-and-expectations.md`).
 *
 * The candidates themselves are already on disk (`signals` rows with
 * `signal_type='notice'`, `event_type='candidate'`); what was missing was the
 * gate's VERDICT on each: channel, weight, utility, reason, and the
 * surprise × precision × habituation × concern − cost breakdown, which
 * `noticeGate` computed in memory and threw away microseconds later. Written
 * by the effect executor from `RecordGateDecision` effects, never by the rule.
 *
 * `id` derives from the triggering event + candidate key, so a boot replay
 * offers the identical row (`onConflictDoNothing`) rather than a duplicate.
 */
export const gateDecisions = sqliteTable(
  'gate_decisions',
  {
    id: text('id').primaryKey(),
    /** The candidate's habituation key — joins back to the notice/candidate signal rows and to `feedback-track`'s not-now bump. */
    noticeKey: text('notice_key').notNull(),
    kind: text('kind').notNull(),
    /** tonic | phasic | suppressed | deferred. */
    channel: text('channel').notNull(),
    /** admitted | below-threshold | habituated | budget-spent | too-costly-now | owner-silent | owner-away | expired. */
    reason: text('reason').notNull(),
    weight: real('weight').notNull(),
    utility: real('utility').notNull(),
    surprise: real('surprise').notNull(),
    precision: real('precision').notNull(),
    /** habituatedGain at decision time: 1 = never said, → 0 as the key wears down. */
    habituation: real('habituation').notNull(),
    concern: real('concern').notNull(),
    interruptionCost: real('interruption_cost').notNull(),
    /**
     * K0.2 — the two bars this row was weighed against, as the owner's dial
     * left them. Nullable forever: rows written before this column cannot be
     * backfilled, because the dial's value at the time is not stored anywhere,
     * and a reader must draw them as unplaceable rather than against today's.
     */
    tonicBar: real('tonic_bar'),
    phasicBar: real('phasic_bar'),
    decidedAt: text('decided_at').notNull(),
    /** J1.6: Jev's reading of the notice as JSON (`GateFeatures`), written beside the arithmetic a beat later; NULL until it lands, and for every row from before. */
    features: text('features'),
  },
  (table) => [index('idx_gate_decisions_decided').on(table.decidedAt), index('idx_gate_decisions_key').on(table.noticeKey)],
);
