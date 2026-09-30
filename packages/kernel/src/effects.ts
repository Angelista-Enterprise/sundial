// The effects a rule may ask for — the one union the executor holds exhaustive (`EFFECT_HANDLERS`, F7) — and the rows and payloads they carry. W4 step 13: out of types.ts, which re-exports it.
import type { ActionEffect } from './state/actions.js';
import type { ComposeWeekReviewEffect } from './state/briefs.js';
import type { Event } from '@sundial/helpers/sanitize-at-ingest.js';
import type { AskProposal, AudioContext, EntityKind, FactProvenance, FocusQuality, MomentKind, MomentRollup, PromiseTerms } from './types.js';

/**
 * The durable row. `activeDays` flattens to a COUNT here, unlike the in-state
 * list: the list exists so the rule can tell a repeat day from a new one, and
 * the table only ever needs the measure.
 */
export interface CommitmentRow {
  id: string;
  name: string;
  source: string;
  branch: string;
  projectId: string | null;
  projectName: string | null;
  openedAt: string;
  lastTouchedAt: string;
  touches: number;
  activeDays: number;
  closedAt: string | null;
  closedBecause: string | null;
  /** UC1: `PromiseTerms` as JSON; null on a branch thread. */
  promise?: PromiseTerms | null;
}

/**
 * Phase 2 scope: only the two effect types any rule actually produces this
 * phase. The rest of docs/design/03-effects-and-llm-policy.md's union
 * (ScheduleLLM, UpsertEntityFact, Embed, ...) lands in Phase 4/6 alongside
 * the rules that emit them — no speculative variants with nothing to test.
 */
export interface MomentRow {
  id: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  processName: string;
  /** `kind`/`focusScore`/`focusQuality` (docs/design/06, 07) exist here and not on `MomentRollup` itself — computed once at close time, meaningless on a still-open moment. */
  data: MomentRollup & { kind: MomentKind; focusScore: number; focusQuality: FocusQuality; audioContext?: AudioContext };
  /** §1's heuristic 1-10 importance, computed by `computeMomentImportance` (@sundial/memory) at write time — decayed by `memoryDecay` on `day:boundary`, never touched otherwise. */
  importanceScore: number;
  /** Phase 7 — persisted so `gnomon_project_status` (and any future project-scoped query) can filter moments by project; previously only lived in-memory on `state.moment.projectId`. */
  projectId: string | null;
}

/**
 * Minimal project-identity groundwork (not the WCS rule-learning system —
 * see docs/phase-3-implementation-plan.md's Wave 3a addendum). `id` is the
 * project's root path, assigned deterministically by the rule that emits
 * this effect — no DB read needed to know it.
 */
export interface ProjectRow {
  id: string;
  name: string;
  rootPath: string;
  organizationId: string | null;
}

/** The same purposes as `state.budgets.byPurpose`. Kept as an inline literal union rather than imported from `@sundial/llm` to keep the rules' type surface free of a package a pure `(state, event)` function has no business reaching into — `packages/kernel` does now depend on `@sundial/llm`, but only for the tool registry's `ToolDefinition`, which is a read-path concern. The two unions must be edited together. */
export type LlmPurpose = 'intent' | 'companion' | 'reflect' | 'extract' | 'journal' | 'ask' | 'refute' | 'goal' | 'transcript' | 'hand' | 'vision' | JudgementPurpose;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Phase 4 (docs/design/03-effects-and-llm-policy.md). The rule builds the
 * full prompt from already-sanitized state — the executor's LLM dispatch
 * only ever does presentation trimming, never a redaction decision (that
 * boundary is restated in the design doc specifically because it matters
 * here). `delayMs` lets a rule debounce a burst of triggers (e.g. several
 * `window:changed` events firing before a moment truly settles) without the
 * rule itself holding a timer — the executor owns the actual wait.
 */
export interface ScheduleLLMEffect {
  type: 'ScheduleLLM';
  purpose: LlmPurpose;
  /**
   * L3 (docs/audit/remediation-todo.md's standalone bug list) — nullable
   * because not every purpose has a real moment to attach to: `companion`
   * insights are about a cross-session pattern, not any one moment.
   * `companionInsight` used to pass `state.moment?.id ?? ''`, landing an
   * empty string in `llm_audit.momentId` (a real value that looks like a
   * valid foreign key but breaks any future join against `moments.id`) —
   * `null` says "no moment" unambiguously, matching what the DB column and
   * `runAuditedLlmCall`'s own option type already accepted.
   */
  momentId: string | null;
  delayMs: number;
  messages: ChatMessage[];
  /**
   * Retry lineage for a render a RULE re-asks for (J1.1c): `verifyLine`'s
   * second render is attempt 2, pointing at the first render's audit row, so
   * the Ledger's retry view and `retrySpendUsd` see it exactly as they see a
   * transport retry. `llm:result` carries `auditId` so the rule can set it.
   */
  attempt?: number;
  parentCallId?: string | null;
  /**
   * D5 (docs/audit/production-proposal-and-enhancements.md, addresses
   * A§5.1) — opaque passthrough, copied verbatim onto the eventual
   * `llm:result` event's payload (`apps/daemon/src/daemon/index.ts`'s
   * `performScheduledLlmCall`). `companionInsight` is the first user: the
   * anomaly's `kind` needs to survive the schedule -> executor -> result
   * round trip so `applyLlmResult` can tag `state.memory.recentInsights`
   * with it without a DB read. Deliberately not folded into `momentId`
   * (already flagged as misused for this in the standalone bug list — L3).
   */
  metadata?: Record<string, unknown>;
}

/**
 * The purposes a `Judge` runs under (docs/jarvis/02). Jev's, apart from the
 * text model's, so a runaway fan-out cannot spend the journal's day. Mirrors
 * `JudgementPurpose` in `@sundial/llm/types.js`; kept here the way
 * `LlmPurpose` is, so a rule file imports one types module.
 */
export type JudgementPurpose = 'perceive' | 'classify' | 'rank' | 'judge' | 'audit' | 'forecast' | 'listen';

/** One question to Jev, as `callSystemOne` sends it (`@sundial/llm/systemone.js`). */
export interface JudgeQuestion {
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, string> | string[];
}

/**
 * A question set for Jev (docs/jarvis/02, "one effect, one event"). Mirrors
 * `ScheduleLLMEffect` → `llm:result`: a rule builds `state` and `questions`
 * obeying the ten laws of state and emits this; the executor performs it
 * through `runAuditedJudgement` and ingests a `judgement:result` event
 * `{ purpose, questionSetId, momentId, answers, model, latencyMs, metadata }`;
 * a consuming rule pattern-matches on `questionSetId`. The fold never calls
 * Jev. Journaled like every effect (`markEffectStarted`/`Completed`), so a
 * replay of a log that already holds the answer never asks again.
 */
export interface JudgeEffect {
  type: 'Judge';
  purpose: JudgementPurpose;
  /** Which registry set built these questions (`packages/rules/src/questions/`). */
  questionSetId: string;
  momentId: string | null;
  /** 0 for perception; `ANALYSIS_DELAY_MS` for a closing moment. */
  delayMs: number;
  /** Named fields, short, numbers as numbers, no derived verdicts — the lint (J0.6) checks the builders. */
  state: unknown;
  questions: Record<string, JudgeQuestion>;
  /** Opaque passthrough onto the `judgement:result` payload, as `ScheduleLLMEffect.metadata`. */
  metadata?: Record<string, unknown>;
}

/** The executor's answer to a `Judge`, as `judgement:result`'s payload. */
export interface JudgementResultPayload {
  purpose: JudgementPurpose;
  questionSetId: string;
  momentId: string | null;
  answers: Record<string, { type: string; choice?: string; score?: number; noul?: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, string> }>;
  model: string;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

/**
 * J1.6: Jev's reading of a notice, filed beside the gate's arithmetic on the
 * same `gate_decisions` row — logged, not used. Nothing branches on these
 * until J5.1 has a month of them and the owner's verdicts to fit against.
 * Numbers only: each field is a probability or a level plus its probability.
 */
export interface GateFeatures {
  speak_now: number | null;
  value: number | null;
  value_p: number | null;
  channel: string | null;
  channel_p: number | null;
  stale_soon: number | null;
  actionable: number | null;
  model: string;
  at: string;
}

export interface RecordGateFeaturesEffect {
  type: 'RecordGateFeatures';
  /** The `RecordGateDecision` row this sits beside — derived the same way, from the candidate event. */
  decisionId: string;
  noticeKey: string;
  features: GateFeatures;
}

/**
 * J1.5: the owner said "attach the transcript" to a question about a
 * meeting, and until this effect existed nothing did — the words were only
 * stored. The executor gathers what ambient hearing wrote down inside the
 * meeting's window (`audio:transcript` signals, then the moments' cleaned
 * excerpts as a fallback) and files it as a `meeting-transcript` knowledge
 * entry keyed by the ask, with the owner's own answer on top. Two keys: the
 * meeting is a calendar or AV row (`state.meetings.seen`), the instruction is
 * the owner's. Nothing on record → nothing written, and the log says so.
 */
export interface AttachTranscriptEffect {
  type: 'AttachTranscript';
  askId: string;
  title: string;
  start: string;
  end: string;
  /** Who was invited (alias-sanitized): in a 1:1 call, the far side of the transcript gets this name. */
  attendees?: string[];
  /** The owner's reply, filed above the transcript so the note reads as theirs. */
  answer: string;
  ts: string;
}

/**
 * Merges `patch` into a moment's `data` JSON column after it has already
 * closed (read-modify-write in the executor, not the rule — see
 * `packages/db/src/queries/moments.ts`'s `mergeMomentData` doc comment,
 * same accepted pattern as `projectTrack`'s org-assignment gap).
 */
export interface UpdateMomentDataEffect {
  type: 'UpdateMomentData';
  momentId: string;
  patch: Record<string, unknown>;
}

/**
 * Merges `patch` into an `owner_asks` row after it has closed — the same
 * division of labour `UpdateMomentData` has, and for the same reason: the row
 * is already written by the time a model has read it, so the update is a
 * read-modify-write in the executor and never in the rule.
 *
 * `proposals` is the only patchable column today. The question and when it was
 * asked are what actually happened and stay unwritable, exactly as
 * `upsertOwnerAsk` already refuses to rewrite them.
 */
export interface UpdateOwnerAskEffect {
  type: 'UpdateOwnerAsk';
  askId: string;
  patch: { proposals?: AskProposal[] };
}

/**
 * H4 — read the oldest answer no model has looked at yet.
 *
 * Same division of labour as `RunFactExtraction`: the rule says a sweep is due,
 * the executor does the DB read a pure rule structurally cannot — which answer
 * is next, and whether there are any left. It calls no model itself; it appends
 * `ask:harvest-due` carrying the row it found, and `askHarvest` builds the one
 * prompt both doors share. When there is nothing left it appends
 * `ask:harvest-drained` instead, which is what ends the sweep.
 */
export interface RunAskHarvestBackfillEffect {
  type: 'RunAskHarvestBackfill';
  ts: string;
}

/**
 * The delivery channel. The harness executor forwards this to the Cordis
 * event `gnomon/notice`; the `sundial-proactive` plugin injects it into the
 * companion agent (and wakes it for `phasic-notice`). The old daemon could
 * only console.log it.
 */
export interface NotifyEffect {
  type: 'Notify';
  channel: string;
  payload: Record<string, unknown>;
}

/**
 * Phase 5's `companionInsight` output. `dedupeKey` maps to a real unique DB
 * index (`packages/db/src/schemas/db-schema.ts`) — the executor's insert is
 * `onConflictDoNothing`, so a repeat insight is a harmless no-op, not
 * something this rule needs to check for itself (no DB read from a rule).
 */
export interface KnowledgeEntryRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  severity: string | null;
  dedupeKey: string;
  sourceEventId: string | null;
  createdAt: string;
  /** Omitted defaults to the schema's baseline (5); an anomaly-driven companion insight is already known-significant, so `companionInsight`'s write sets it higher. */
  importanceScore?: number;
}

/** One durable record of Gnomon asking the owner something. See `KernelState.ownerAsk`. */
export interface OwnerAskRow {
  id: string;
  question: string;
  /** Why the question was worth asking, in the model's words. Null when it gave none. */
  reason: string | null;
  askedAt: string;
  /** Null for an `expired` outcome — an unanswered question has no answer, and recording one would invent it. */
  answer: string | null;
  answeredAt: string | null;
  /** `answered` | `expired`. Silence is a real outcome, and the one that says the asking is miscalibrated. */
  outcome: string;
}

/**
 * Phase 5's `retentionPrune`. `olderThan` is an ISO timestamp, not a bare
 * day count — the rule computes the cutoff (it has `event.ts` in hand from
 * `day:boundary`), the executor just deletes anything before it. Scoped to
 * `signals`/`moments` only (see `packages/db/src/queries/retention.ts`'s
 * doc comment for why `llm_audit`/`knowledge_entries` aren't included).
 */
export interface DeleteRowsEffect {
  type: 'DeleteRows';
  olderThan: string;
  /**
   * When present, only `signals` rows of these `signal_type`s older than
   * `olderThan` go — the short-horizon sweep for screen text. Absent means the
   * general prune: signals, moments, llm_audit, orphaned embeddings.
   */
  signalTypes?: string[];
  /**
   * With `signalTypes`: only rows whose payload `processName`/`bundleId`
   * contains one of these — the purge of captures from an app that has since
   * joined the sensitive list. Bounded per run by the executor.
   */
  apps?: string[];
  /** With `signalTypes`: only these `event_type`s (`audio` + `transcript`). */
  eventTypes?: string[];
  /** W1: with `signalTypes`, only one thread's rows (`chat:forget`), and the `llm_audit` rows its calls were reserved under. */
  sessionId?: string;
  /** lane Q (Q10): instead of deleting, clear `llm_audit` text and prune completed `applied_effects` rows older than `olderThan`. */
  trim?: 'audit-bodies';
}

/**
 * Phase 6 core memory (docs/design/05-memory-and-knowledgebase.md §4).
 * `factId` is generated by the rule proposing the fact (`contradictionCheck`),
 * not the executor — so the same rule can store it in
 * `state.memory.factCursor` for a future supersession without a DB
 * round-trip to learn what id the executor assigned. `entityKind`/
 * `canonicalName` let the executor upsert the parent `entities` row in the
 * same effect — a rule never needs to know whether the entity already
 * exists.
 */
export interface UpsertEntityFactEffect {
  type: 'UpsertEntityFact';
  factId: string;
  entityId: string;
  entityKind: EntityKind;
  canonicalName: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceEventId: string;
  ts: string;
  /** See `FactProvenance` — carried onto the stored row so a later reader can tell a corrected fact from a well-corroborated one. */
  provenance: FactProvenance;
}

/**
 * Zep-style fact invalidation (§4) — the executor sets `validTo`/
 * `supersededBy` on the old fact; it never deletes or overwrites `object`.
 * Always paired with a `UpsertEntityFactEffect` for the new fact in the same
 * rule's return value.
 */
export interface SupersedeFactEffect {
  type: 'SupersedeFact';
  factId: string;
  supersededByFactId: string;
  ts: string;
}

/**
 * Closes a fact's validity with NO replacement — "this is false", as distinct
 * from supersession's "this changed to that".
 *
 * ## Why this had to be its own effect
 *
 * `feedbackTrack` recorded the owner's `wrong` verdict and deliberately stopped
 * short of acting on it, naming the exact reason: supersession replaces a fact
 * with a different VALUE, and retraction has no replacement value to offer, so
 * there was no effect that could express it. The consequence was that the whole
 * feedback return path was write-only — `feedback:verdict`, `state.feedback`,
 * `POST /feedback`, `gnomon feedback` and the macOS verdict buttons all shipped,
 * and no rule read any of it. Correcting Gnomon changed nothing.
 *
 * ## How a retracted fact reads back
 *
 * That was the open question, and the answer needs no migration and no new
 * column: `validTo` set with `supersededBy` left NULL is already a distinct,
 * representable state, and it is the only combination the existing writers never
 * produce. So:
 *
 * - Every "what do I currently believe" path filters `valid_to IS NULL`, so a
 *   retracted fact leaves the owner's beliefs the moment this applies — which is
 *   the entire point, and it happens without touching a single read path.
 * - Every history path keeps it, with `supersededBy: null` marking it as
 *   retracted rather than replaced. "You used to believe X and I told you it was
 *   wrong" stays in the timeline, exactly as `concepts/entity-facts-and-belief`
 *   argues a correction should.
 *
 * The fact's row is never deleted or rewritten, same invariant supersession
 * holds (see `entities.ts`).
 */
export interface RetractFactEffect {
  type: 'RetractFact';
  factId: string;
  /** Why it was retracted, for the effect journal. Currently only ever an owner `wrong` verdict. */
  reason: string;
  ts: string;
}

/**
 * The owner said a knowledge entry was wrong — withdraw it from retrieval
 * without deleting what Gnomon said.
 *
 * The argument for this existing at all: an insight, a journal entry and a kept
 * answer are all indexed, and `scoredSearch` hands them to the next question as
 * evidence. So an uncorrected wrong entry does not merely sit there being
 * wrong — it gets cited, and Gnomon starts reasoning from its own mistake. That
 * is the failure `RedesignAskPage` names when it refuses to auto-remember an
 * answer, and until now the owner had no way to undo it once an entry existed.
 *
 * Retraction, not deletion, for the same reason `RetractFactEffect` gives: the
 * row is the record that Gnomon claimed this, and that record is worth keeping
 * even — especially — when the claim was false. `retracted_at` set is a state no
 * other writer produces, so it is unambiguous; the entry keeps its place in
 * history, and `scoredSearch` sweeps its embedding exactly as it sweeps a
 * superseded fact's, so the claim cannot come back as evidence.
 */
/**
 * UC1 (U1-F2): one promise pass over a whole meeting that just ended. The
 * executor gathers what hearing wrote down inside the window (the utterances,
 * speaker-labelled when the far side was heard, and any Meet captions), asks
 * the `extract` model for the promises in it, keeps those grounded in the
 * words, and ingests one `meeting:promises` — with an empty list when nothing
 * was heard or nothing was promised, so the fold learns the pass is done.
 * The transcript never enters the log.
 */
export interface RunMeetingPromisesEffect {
  type: 'RunMeetingPromises';
  meetingKey: string;
  title: string;
  start: string;
  end: string;
  /** The other people on the invite, as the log names them. */
  attendees: string[];
  ts: string;
}

export interface RetractKnowledgeEntryEffect {
  type: 'RetractKnowledgeEntry';
  entryId: string;
  /** Why it was retracted, for the effect journal. Currently only ever an owner `wrong` verdict. */
  reason: string;
  ts: string;
}

/**
 * §6 — local embedding only (decision #5, docs/design/00-overview.md). The
 * rule hands over already-sanitized `text`; the executor computes the
 * vector (`packages/memory/src/local-embedding.ts`) and stores it. There is
 * no remote-embedding effect variant — adding one later would need to be a
 * deliberate, separately-reviewed decision, not a natural extension of this
 * one.
 */
export interface EmbedEffect {
  type: 'Embed';
  id: string;
  refType: 'moment' | 'knowledge_entry' | 'entity_fact';
  refId: string;
  text: string;
}

/**
 * Phase 6b's `memoryReflection` (docs/design/05-memory-and-knowledgebase.md
 * §2). Unlike `ScheduleLLM` (which schedules a call for a rule-named
 * `momentId`), the reflection LLM call needs to read a whole window of
 * moments/knowledge entries first to build its prompt — a DB read a pure
 * rule structurally can't do. Symmetric with how `dispatchScheduleLLM`
 * already does all I/O (budget check, retry, the call itself) outside the
 * rule layer: this effect just says "reflection is due, starting from
 * `since`" and the executor does everything else, same division of labor.
 */
export interface RunReflectionEffect {
  type: 'RunReflection';
  since: string;
  ts: string;
  /**
   * Phase 1 endogenous-life — `'daily'` (default/absent) is the `day:boundary`
   * reflection (`memoryReflection`), one per calendar day via a
   * `reflection:<date>` dedupeKey; `'endogenous'` is a drive-triggered early
   * reflection (`endogenousReflection`) that must persist ALONGSIDE the daily
   * one, so the executor gives it a distinct dedupeKey. See docs/design/08 §3.
   */
  reason?: 'daily' | 'endogenous';
}

/**
 * D3 (docs/audit/production-proposal-and-enhancements.md, fixes A§4.5) —
 * "wire the unused `extract` LLM purpose to a nightly pass over the day's
 * rollups proposing typed facts... as `entity:fact-candidate` events through
 * the normal pipeline." Same division of labor as `RunReflectionEffect`
 * (a DB read over a time window a pure rule can't do, so the rule just says
 * "extraction is due" and the executor does the read + call + emits the
 * resulting candidates as ordinary events, through `contradictionCheck`'s
 * usual promotion policy — never a direct `UpsertEntityFact`).
 */
/**
 * The nightly pass over the owner's own chat turns (`conversationFactExtract`).
 * Same division of labour as `RunFactExtraction`: the rule names the window,
 * the executor reads the window's `chat:owner` rows (W1: already sanitized),
 * calls the `extract` purpose, and re-enters every finding as an ordinary
 * `entity:fact-candidate` with `provenance: 'conversation'`.
 */
export interface RunConversationExtractionEffect {
  type: 'RunConversationExtraction';
  /** ISO — owner turns at or after this instant are read. */
  since: string;
  ts: string;
}

export interface RunFactExtractionEffect {
  type: 'RunFactExtraction';
  since: string;
  ts: string;
}

/**
 * "Work out who these hashed attendees are, from what is already on this
 * machine."
 *
 * `sanitizeAtIngest` turns a calendar attendee the calendar sent as a bare
 * address into a `person-<hash>` alias, and for a long time nothing could turn
 * that back into a name — so `peopleAsk` asked the OWNER, who cannot read a
 * hash either. Seven such questions went out on 2026-09-09 and all seven were
 * refused, one of them with "I dont know, we need to handle this in code".
 *
 * The alias is a hash, not a lock. Every colleague's address also appears in
 * places the machine can read directly — git commit authors in the known
 * project roots, notes in the vault — so hashing each candidate with
 * `aliasIfEmail` and comparing is an EXACT test of identity, needing no model
 * and no question. Measured on the live record before this effect existed, git
 * history alone matched 6 of the 25 aliases.
 *
 * An effect rather than rule code because it reads the filesystem AND the
 * entities table, and a rule may do neither. It carries no alias list on
 * purpose: `identity-resolve` is only a clock, and the executor finds every
 * person entity whose canonical name is a hash and which has no `knownAs`
 * belief. The first version had the rule enumerate them from
 * `state.meetings.seen` and that map holds only RECENT meetings, so the sweep
 * did nothing while 25 hashed people sat in the table.
 *
 * The executor emits one `entity:fact-candidate` per match, carrying ONLY the
 * resolved name — the address itself never enters the log, which is the entire
 * reason the alias exists.
 */
export interface ResolveAliasesEffect {
  type: 'ResolveAliases';
  ts: string;
}

/**
 * "Try to disprove some of what you believe."
 *
 * The adversarial half of core memory. Every other path into belief is
 * corroborative — `entityExtract` proposes what it saw, `contradictionCheck`
 * promotes what recurred, `factConfidenceDecay` lets the unreconfirmed drift
 * toward uncertainty. Nothing has ever tried to show a confirmed fact FALSE, so
 * a wrong belief that stops being observed does not get corrected, it just
 * fades slowly while still being read — which is the compounding-error worry
 * `decisions/assistant-as-an-event-source` records as this codebase's main risk
 * once an assistant starts writing back what it concludes.
 *
 * Same division of labour as `RunFactExtraction`: the rule names the moment and
 * the size of the pass, the executor picks the sample, calls the model
 * (purpose `refute`), and turns each successful refutation into an ordinary
 * `entity:fact-candidate` for the NEGATION.
 *
 * The skeptic gets no privileged write. A refutation enters through the same
 * gate a sensor's observation does and is subject to the same promotion policy
 * — `contradictionCheck` stays the single writer of belief. That is what keeps
 * belief replayable from evidence rather than from whatever a model said one
 * night.
 */
export interface RunRefutationEffect {
  type: 'RunRefutation';
  /** How many facts to put up for refutation this pass. */
  sampleSize: number;
  ts: string;
}

/**
 * J2.3 — the nightly belief audit. The rule says a pass is due; the executor
 * reads every live inferred fact (a pure rule cannot) and puts each one to
 * the judge as its own `audit-fact` judgement, `factId` in the metadata, so
 * `applyFactAudit` retracts by id. Replay never calls the network: the
 * `judgement:result`s are in the log.
 */
export interface RunBeliefAuditEffect {
  type: 'RunBeliefAudit';
  ts: string;
}

/**
 * J2.4 — the Jev leg of alias alignment. The rule (`nightlyAliasAlignment`)
 * has already done the exact leg in the fold; the executor reads the entity
 * table (a rule cannot), shortlists pairs of project and person entities, and
 * puts each pair to the judge as one `align-alias` judgement. Its answers
 * become SUGGESTIONS on the Trust surface (`applyAliasAlignment`), never a
 * merge — the owner's `projectAliases` is the key that merges.
 */
export interface RunAliasAlignmentEffect {
  type: 'RunAliasAlignment';
  ts: string;
}

/**
 * P5 (docs/design/07) — "the day-writer is due for `date`." Same division of
 * labor as `RunReflectionEffect`: the rule (`dailyJournal`, on `day:boundary`)
 * just names the day that ended; the executor (`performDailyJournalCall`) builds
 * the day's `DailyContext`, calls the LLM (purpose `journal`), and writes the
 * `kind: 'daily'` knowledge entry. A missed run is picked up by an on-demand
 * regenerate, so — like reflection — the background job gets no retry.
 */
export interface RunJournalEffect {
  type: 'RunJournal';
  date: string;
  ts: string;
  /** P6 — regenerate: delete the existing `daily:<date>` entry first so the (otherwise no-op) insert overwrites it. Default false (the midnight auto-run never clobbers a hand-regenerated day). */
  overwrite?: boolean;
}

/**
 * §5 — decays every row's `importanceScore` by `factor` (a multiplier, e.g.
 * 0.95). Deliberately excludes `entity_facts`: core memory is curated, not
 * raw, and only changes via supersession (§4), never silent fade-out.
 */
export interface DecayScoresEffect {
  type: 'DecayScores';
  factor: number;
}

/**
 * Phase 2a (docs/design/08-endogenous-life.md §5, decision D7) — supporting
 * evidence for a confirmed fact: the executor bumps its Beta `alpha` by `delta`
 * and recomputes the derived `confidence`. Emitted by `contradictionCheck` when
 * a confirmed fact is re-observed (and, from Phase 2b, on a successful
 * prediction it generated). The record (object, validity window) is never
 * touched — only the certainty moves.
 */
export interface ReinforceFactEffect {
  type: 'ReinforceFact';
  factId: string;
  delta: number;
  ts: string;
  /** lane C: `beta` is evidence AGAINST — a prediction the fact made that failed (`factTestTrack`). Absent means `alpha`. */
  side?: 'alpha' | 'beta';
}

/**
 * Phase 2a (docs/design/08-endogenous-life.md §5, decision D8 — "decay the
 * certainty, never the record"). On `day:boundary`, decays every CURRENT fact's
 * Beta counts toward the uninformative prior by `factor`, drifting stale,
 * unreconfirmed beliefs toward uncertainty without ever altering the fact's
 * object or validity window. The entity_facts analogue of `DecayScores` (which
 * deliberately excludes entity_facts).
 */
export interface DecayFactConfidenceEffect {
  type: 'DecayFactConfidence';
  factor: number;
  ts: string;
}

/**
 * One resolved prediction, on its way to the durable `predictions` table.
 *
 * The fitness record used to live only in `predictions.recentResolved`, a
 * 50-entry window on a state object that gets snapshotted and truncated. A08
 * asks for 100 resolutions before it will report a calibration figure, so the
 * ambition could not be reached however long the daemon ran — see the table's
 * own doc comment in `packages/db/src/schemas/db-schema.ts`.
 *
 * A rule stays pure: `dayShapeForecast` folds the outcome into state AND returns
 * this, and the executor is the only thing that writes. `id` is the open
 * prediction's derived id, so a replayed effect offers the same row.
 */
/**
 * One project id folds into another, everywhere it is stored: `moments` and
 * `commitments` rows are re-pointed and the `projects` row for `from` is
 * deleted. Emitted by `projectTrack` when a real filesystem root is detected
 * for a name a synthetic `named:<project>` id was minted for earlier — the
 * split `attribution.ts`'s `findKnownByName` stops for NEW attributions but
 * could never repair in the rows already written. Idempotent: a replay
 * re-points nothing and deletes nothing.
 */
export interface MergeProjectEffect {
  type: 'MergeProject';
  from: string;
  into: string;
}

/**
 * J2.4's open half: fold one entity into another. `from` is a hashed attendee
 * (`person:person-<hash>`) whose live `knownAs` names `into` EXACTLY; the
 * executor re-points `entity_facts` and the entity's embeddings, records
 * `alias` (the hash's canonical name) in the survivor's `aliases_json` so the
 * upsert path never recreates the hash, and drops the `from` row. Never from a
 * judge's answer: exact matches only (docs/jarvis/05, two keys).
 */
/**
 * J5.3 — plan the week for an ACTIVE goal: the executor asks the tier-3 text
 * model for at most five steps, each marked internal or outward, and ingests
 * `goal:planned`. At-least-once: a repeat plan replaces the week's plan.
 */
export interface RunGoalPlanEffect {
  type: 'RunGoalPlan';
  goalId: string;
  goalName: string;
  /** Moments the fan-out credited to this goal lately — evidence for the planner, as ids. */
  progress: string[];
  ts: string;
}

/**
 * W2 — read the world model and plan what today's writer would refuse. The
 * executor does the DB read a pure rule cannot, runs the pure `planHygiene`, and
 * answers with one `world:hygiene` event carrying the plan; `applyWorldHygiene`
 * turns it into retractions and merges. No model is involved.
 */
export interface RunWorldHygieneEffect {
  type: 'RunWorldHygiene';
  ts: string;
}

export interface MergeEntityEffect {
  type: 'MergeEntity';
  from: string;
  into: string;
  alias: string;
  ts: string;
}

export interface RecordPredictionEffect {
  type: 'RecordPrediction';
  id: string;
  kind: string;
  forecaster: string;
  createdAt: string;
  resolvedAt: string;
  priorProb: number;
  /** The conditioning features the prior was formed from, so a later pass can re-fit without replaying the log. */
  features: Record<string, unknown> | null;
  outcome: 0 | 1;
  /** −ln(p assigned to the actual outcome), in nats — the same number folded into the surprise drive. */
  surprise: number;
  /**
   * The target's base rate over every resolution BEFORE this one — K0.3.
   *
   * The fair opponent. A skill figure against a constant fitted with hindsight
   * to the same bets it scores is an oracle, and the Calibration card had to
   * say so on its face; this is the running mean a forecaster could actually
   * have bet. Read off the calibration entry the rule is about to bump, so it
   * costs no new state and cannot disagree with the tally beside it.
   *
   * `null` on the first resolution of a target, which has no past to average,
   * and on every row written before this column. A reader must treat that as
   * "no opponent" rather than as zero.
   */
  baseProb: number | null;
}

/**
 * One gate verdict, on its way to the durable `gate_decisions` table
 * (`almanac/architecture/rules/noticing-and-expectations.md`).
 *
 * The gate computes channel, weight, utility and the five-term arithmetic for
 * every candidate and — before this effect existed — returned them in memory
 * only, throwing the "Unsaid" room's entire content away microseconds later.
 * The rule stays pure: `noticeGate` folds the decision into state exactly as
 * before AND returns this; the executor is the only writer.
 *
 * `id` is derived from the triggering event, so a boot replay offers the same
 * row (`onConflictDoNothing`) rather than a second one.
 */
export interface RecordGateDecisionEffect {
  type: 'RecordGateDecision';
  id: string;
  /** The candidate's habituation key — the join back to the `notice`/`candidate` signal rows. */
  noticeKey: string;
  kind: string;
  /** 'tonic' | 'phasic' | 'suppressed' | 'deferred' (the rules package owns the union). */
  channel: string;
  /** 'admitted' | 'below-threshold' | 'habituated' | 'budget-spent' | 'too-costly-now' | 'owner-silent'. */
  reason: string;
  weight: number;
  utility: number;
  /** The five factors of `weight`/`utility`: surprise × precision × habituation × concern − cost. */
  surprise: number;
  precision: number;
  habituation: number;
  concern: number;
  interruptionCost: number;
  /**
   * The two bars this row was actually weighed against — K0.2.
   *
   * `noticeGate` scales BOTH thresholds by `2 ** noticeBias` before it weighs
   * anything, so the policy's shipped 0.55/1.6 are not the bars any given row
   * met: on a machine with the dial at −1 they are 0.275 and 0.8. Without them
   * stored, a decision cannot be placed against its own line ever again — the
   * Unsaid card drew today's bar across the whole record and 40 of its 171 rows
   * fell on the wrong side of it, countable and unresolvable.
   *
   * Written by the RULE rather than recomputed at read time, for the same
   * reason the five factors are: the bar is part of the decision, and a second
   * derivation of it on a surface is a second policy that agrees on the day it
   * is written. Rows written before this landed carry `null`, and every reader
   * must treat that as "not known" rather than as today's value.
   */
  tonicBar: number;
  phasicBar: number;
  /** When the gate ruled — the arrival event's ts, or the re-scoring tick's. */
  decidedAt: string;
}

/**
 * Backtest one research-goal hypothesis against the forecaster's own recorded
 * samples — the closed half of propose-and-verify.
 *
 * The executor reads the durable `predictions` rows for this cell (the exact
 * samples the live `hourlyDoneRate` counts came from, so the trial validates
 * precisely what the forecaster would then bet on), splits their outcomes on
 * the ONE proposed conditioner, and appends a `goal:trial-result` signal with
 * the arms, the information gain, and the MDL verdict. No model is consulted:
 * the proposal was the model's whole contribution, and only the pre-registered
 * variable is tested — testing the menu and keeping the best would be
 * multiple-comparisons fishing at n≈13.
 */
export interface RunGoalTrialEffect {
  type: 'RunGoalTrial';
  goalId: string;
  /** Prediction rows to read, e.g. kind 'day-ending' forecaster 'hourly-rate'. */
  predictionKind: string;
  forecaster: string;
  /** The cell under question, as the forecaster keys it (an hour, for day-ending). */
  cell: string;
  /** The pre-registered conditioner id (see `conditioners.ts`). */
  variable: string;
}

export type Effect =
  | { type: 'WriteDB'; table: 'moments'; row: MomentRow }
  | { type: 'WriteDB'; table: 'projects'; row: ProjectRow }
  | { type: 'WriteDB'; table: 'knowledge_entries'; row: KnowledgeEntryRow }
  | { type: 'WriteDB'; table: 'commitments'; row: CommitmentRow }
  | { type: 'WriteDB'; table: 'owner_asks'; row: OwnerAskRow }
  | { type: 'EmitEvent'; event: Event }
  | ScheduleLLMEffect
  | JudgeEffect
  | AttachTranscriptEffect
  | RecordGateFeaturesEffect
  | UpdateMomentDataEffect
  | UpdateOwnerAskEffect
  | RunAskHarvestBackfillEffect
  | NotifyEffect
  | DeleteRowsEffect
  | UpsertEntityFactEffect
  | SupersedeFactEffect
  | RetractFactEffect
  | RetractKnowledgeEntryEffect
  | EmbedEffect
  | RunFactExtractionEffect
  | ResolveAliasesEffect
  | RunConversationExtractionEffect
  | RunMeetingPromisesEffect
  | RunRefutationEffect
  | RunBeliefAuditEffect
  | RunAliasAlignmentEffect
  | RunReflectionEffect
  | RunGoalTrialEffect
  | RunJournalEffect
  | DecayScoresEffect
  | ReinforceFactEffect
  | DecayFactConfidenceEffect
  | RecordPredictionEffect
  | RecordGateDecisionEffect
  | MergeProjectEffect
  | MergeEntityEffect
  | RunWorldHygieneEffect
  | RunGoalPlanEffect
  | ComposeWeekReviewEffect
  | ActionEffect;

/**
 * `ruleName` is `Rule`'s own JS function name (`const momentClose: Rule = (state, event) => ...`
 * gets `.name === 'momentClose'` for free from ES2015 name inference on a const-bound function
 * expression) — attributed once here in `reduce()`, not by changing any individual rule's own
 * `{state, effects}` return shape. The Triggers tab's data source (docs/design/06-macos-ui-data-wiring.md).
 */
export interface AttributedEffect {
  ruleName: string;
  effect: Effect;
}
