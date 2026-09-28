/**
 * KernelRuntime — Gnomon's event-sourced kernel loop, packaged for the
 * DeepSeek Harness (dsh) process.
 *
 * ORIGIN: ported from `apps/daemon/src/daemon/index.ts` (the standalone
 * daemon), Phase 2 of PLAN.md. The fold pipeline (sanitize → append to the
 * `signals` log → `reduce()` over `RULE_MANIFEST` → execute effects), the
 * boot sequence (snapshot + log-tail replay), the two-phase effect journal,
 * the budget-checked LLM dispatchers, and the serialized event lane are all
 * copied faithfully from that file. What is deliberately NOT ported:
 *
 * - Sensors and their cross-wiring (`pollTick`, `crossWire`,
 *   `handleSensorEvent`) — Phase 3 re-attaches them as the `gnomon-sensors`
 *   plugin, feeding `appendSignal()`.
 * - The loopback HTTP read API and its deps — dsh's chat/tools replace it.
 * - The SSE event bus (`emitDaemonPushEvent`) — replaced by the `onChange`
 *   hook, which names the TABLES a fold wrote (see `tablesTouched`). The
 *   `gnomon-kernel` plugin forwards it as the Cordis event `gnomon/changed`
 *   and the theme's `/gnomon/api/live` relays it to every open tab.
 * - PID/started-at files — process lifetime belongs to dsh now. The device
 *   id file is still read/created (same `~/.sundial/.daemon/device-id`).
 *
 * The daemon's module-level `let state / lastSignalId / eventChain` become
 * instance fields so the runtime is a disposable service, not process state.
 */
import { momentEmbedText, momentModelTag } from '@sundial/helpers/moment-embed-text.js';
import { getSundialHome } from '@sundial/helpers/config.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createEventId, sanitizeAtIngestWithAudit, type Event } from '@sundial/helpers/index.js';
import { performAttachTranscript } from './attach-transcript.js';
import { loadSundialConfig, canonicalProjectName, type ResolvedSundialConfig } from '@sundial/helpers/sundial-config.js';
import { applyPrivacyConfig } from '@sundial/helpers/privacy-config.js';
import {
  decayKnowledgeScores,
  decayMomentScores,
  deleteRowsOlderThan,
  deleteSignalsOlderThan,
  getAllProjects,
  getKnowledgeEntriesSince,
  getAllMoments,
  getMomentsByIds,
  getMomentsSince,
  getSignalsInRange,
  updateGateDecisionFeatures,
  loadAliasNames,
  insertEmbedding,
  replaceEmbedding,
  insertEntityFact,
  insertGateDecision,
  insertKnowledgeEntry,
  retractKnowledgeEntry,
  getFactsForRefutation,
  getFactsForBeliefAudit,
  getWorldForHygiene,
  getMomentCountsByProjectAndProcess,
  getAllEntities,
  insertPrediction,
  listResolvedPredictions,
  upsertCommitment,
  upsertAskThread,
  upsertOwnerAsk,
  updateOwnerAsk,
  getAskVerdicts,
  getOldestUnharvestedOwnerAsk,
  insertMoment,
  insertSignal,
  getEffectJournalStatus,
  type EffectJournalStatus,
  markEffectStarted,
  markEffectCompleted,
  markEffectFailed,
  markEffectEmitted,
  markEffectIndeterminate,
  mergeMomentData,
  reembedStaleEmbeddings,
  reinforceEntityFact,
  decayCurrentFactConfidence,
  supersedeEntityFact,
  retractEntityFact,
  upsertEntity,
  upsertOrganization,
  upsertProject,
  mergeProjectRows,
  mergeEntityRows,
  resolveEntityAlias,
} from '@sundial/db/index.js';
import { NO_DIAGNOSIS, withPersona } from '@sundial/kernel/persona.js';
import { auditIdOf, BudgetExhaustedError, isLlmConfigured, LlmHttpError, runAuditedJudgement, runAuditedLlmCall, runToolLoop, systemOneBackend } from '@sundial/llm/index.js';
import { assembleJournalMarkdown } from '@sundial/kernel/daily-journal-prompt.js';
import { expandHomePath } from './sensor-runtime.js';
import { benchPacking, PACK_SIZE, rejudgeMoments, type PackBench, type RejudgeProgress } from './rejudge.js';
import { goalLabel, openGoals } from '@sundial/rules/goal-checkin.js';
import { hygieneContext, planHygiene } from '@sundial/rules/world-hygiene.js';
import { questionId } from '@sundial/rules/questions/index.js';
import { QUESTION_SETS } from '@sundial/rules/questions/registry.js';
import { THRESHOLD_MIN_N } from '@sundial/rules/judgement-track.js';
import { actionLevelOf, carriedOutOf, CLASSIFY_ACTION_QUESTIONS, classifyAction, VERIFY_ACTION_QUESTIONS, verifyAction, type ActionLevel } from '@sundial/rules/questions/classify-action.js';
import { MAX_GOAL_SLOTS, MAX_PROMISE_SLOTS } from '@sundial/rules/questions/moment-fanout.js';
import { repeatsRecent } from '@sundial/kernel/reflection-novelty.js';
import { computeEmbedding } from '@sundial/memory/index.js';
import { parseCompanionInsight } from '@sundial/rules/apply-llm-result.js';
import { MAX_EXTRACTED_FACTS_PER_PASS, parseExtractedFactCandidates } from '@sundial/rules/nightly-fact-extract.js';
import { ASK_HARVEST_DRAINED, ASK_HARVEST_DUE } from '@sundial/rules/ask-harvest.js';
import { auditFact } from '@sundial/rules/questions/audit-fact.js';
import { alignAlias, type AlignAliasInput } from '@sundial/rules/questions/align-alias.js';
import { projectEntityId } from '@sundial/rules/entity-extract.js';
import { rebuildAskClassGain } from '@sundial/rules/owner-ask.js';
import { TICKET_HORIZON_DAYS, TICKET_SOURCE_TYPES, ticketTrack } from '@sundial/rules/ticket-track.js';
import { slugifyEntityName } from '@sundial/rules/entity-extract.js';
import {
  canonicalizeConversationCandidate,
  conversationExtractionInstructions,
  formatTranscript,
  type ConversationSource,
} from '@sundial/rules/conversation-extract.js';
import { redactWithPolicy } from '@sundial/helpers/redact/redact-policy.js';
import {
  buildDailyContext,
  buildJournalMessages,
  buildProjectStatusContext,
  buildProjectStatusMessages,
  executeGnomonTool,
  gnomonToolDefinitions,
  createInitialState,
  hydrateSnapshot,
  loadLatestSnapshot,
  parseJournalResult,
  persistDailyJournal,
  effectDeliveryGuarantee,
  type DeliveryGuarantee,
  persistProjectStatus,
  reduce,
  replayTail,
  resolveDailyCaps,
  writeSnapshot,
  type AttributedEffect,
  type Effect,
  type KernelState,
  type ResolveAliasesEffect,
  type RunFactExtractionEffect,
  type RunConversationExtractionEffect,
  type RunRefutationEffect,
  type RunBeliefAuditEffect,
  type RunWorldHygieneEffect,
  type RunAliasAlignmentEffect,
  type RunJournalEffect,
  type RunGoalPlanEffect,
  type RunGoalTrialEffect,
  type RunReflectionEffect,
  type SanitizedEvent,
  type ScheduleLLMEffect,
  type JudgeEffect,
  type JudgeQuestion,
  type JudgementPurpose,
  type JudgementResultPayload,
  type TrialSplit,
  conditionerById,
  informationGain,
  splitAccepted,
} from '@sundial/kernel/index.js';
import { BACKFILL_MANIFEST, RULE_MANIFEST } from '@sundial/rules/index.js';
import { resolveAliases, type ResolvedAlias } from './resolve-aliases.js';
import { isUnchangedObservation, stateSignature } from '@sundial/kernel/state-signature.js';

const RETRY_MAX_ATTEMPTS = 3;
/** J4.1: a choice's lab operating point; the judge escalates an allow to an ask only above it. */
const ACTION_ESCALATE_DEFAULT_THRESHOLD = 0.7;
/** J4.2: below this `carried_out` the action is reported as unverified. */
const ACTION_VERIFY_DEFAULT_THRESHOLD = 0.5;
/** J2.3: judgements in flight during a belief-audit pass. */
const BELIEF_AUDIT_POOL = 8;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** A reflection is compared against the last week's before it is kept. */
const REFLECTION_NOVELTY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const REFLECTION_MAX_ITEMS = 50;
const REFLECTION_IMPORTANCE_SCORE = 6;
const MAX_PRIORITIES = 5;

const JOURNAL_MAX_TOKENS = 4000;
const JOURNAL_MAX_ROUNDS = 8;
const JOURNAL_REQUEST_TIMEOUT_MS = 180_000;
const JOURNAL_DEADLINE_MS = 600_000;

/**
 * Sixty, down from a hundred (2026-09-07). The nightly pass averaged 309 s a
 * call over the last month — the prompt carried a whole day's window titles and
 * the model read all of it before writing ten facts. The last sixty moments are
 * the afternoon and evening; the morning's facts had their chance yesterday.
 */
const FACT_EXTRACTION_MAX_MOMENTS = 60;
/** Fact extraction is long by nature; this is the ceiling, not the expectation. */
const FACT_EXTRACTION_TIMEOUT_MS = 240_000;
/** A reflection is a short answer to a short prompt; two minutes is generous. */
const REFLECTION_TIMEOUT_MS = 120_000;

/** Written to the log but never pushed to `pushEvent` subscribers (empty payload, once a minute). */
const QUIET_SIGNAL_TYPES = new Set(['clock']);

/** Same L2 note as the daemon: `ts` defaults to real ingest time; replay orders by ULID id, never by `ts`. */
export function toDaemonEvent(type: string, payload: Record<string, unknown>, ts: string = new Date().toISOString()): Event {
  return { id: createEventId(), type, ts, payload };
}

/** D5 — "top processes of the week," ranked by total tracked time. Ported verbatim. */
export function computeTopProcessesByDuration(moments: { processName: string; durationMs: number }[]): string[] {
  const totalsByProcess = new Map<string, number>();
  for (const moment of moments) totalsByProcess.set(moment.processName, (totalsByProcess.get(moment.processName) ?? 0) + moment.durationMs);
  return [...totalsByProcess.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PRIORITIES)
    .map(([processName]) => processName);
}

function projectLabel(projectId: string | null, projectsById: Map<string, string>): string {
  if (!projectId) return 'unattributed';
  return projectsById.get(projectId) ?? projectId;
}

function resolveProjectIdByName(name: string, projectsById: Map<string, string>, aliases: Record<string, string>): string | null {
  const target = canonicalProjectName(name, aliases);
  for (const [id, projectName] of projectsById) {
    if (canonicalProjectName(projectName, aliases) === target) return id;
  }
  return null;
}

/**
 * Longest run of speech carried on ONE evidence line. `momentRollup` caps a
 * moment's own excerpt at 600, and 60 moments of that is 36k characters of
 * transcript in a prompt whose other 60 lines are short — the speech would
 * drown the window-title evidence rather than join it. 240 matches the screen
 * excerpt's cap and keeps the whole pass in the same order of magnitude it had.
 */
const SPOKEN_EVIDENCE_CHARS = 240;

/**
 * The `said: "…"` clause on one evidence line — the tail of what was heard
 * while that moment was open.
 *
 * Why this exists at all: ambient hearing reached `moments` and stopped there.
 * Nothing read `spokenExcerpt`, so the single richest source of owner facts —
 * the owner's own words, and their colleagues' — fed neither the knowledge
 * graph nor retrieval, exactly the crossing `almanac/enhancements/conversation-memory`
 * describes as missing. Speech enters here rather than through a new rule
 * because this pass ALREADY reads the day's rollups and already funnels its
 * output through the ordinary `entity:fact-candidate` gate.
 *
 * It is quoted, and labelled `said`, on purpose. A window title is a thing the
 * machine observed; a transcript line is a thing whisper GUESSED, and this
 * corpus is bilingual Dutch/English where proper nouns come back mangled. The
 * prompt leans on that label to hold speech-only claims below the confidence
 * where a fact becomes expensive to unseat.
 */
export function spokenEvidence(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const said = raw.trim();
  if (said === '' || said === '[private]') return '';
  const tail = said.length > SPOKEN_EVIDENCE_CHARS ? said.slice(said.length - SPOKEN_EVIDENCE_CHARS) : said;
  return ` — said: "${tail.replace(/"/g, "'")}"`;
}

/** The `with: …` clause naming who was in a meeting, for one evidence line. Ported verbatim (see the daemon's long rationale comment). */
export function meetingAttendeeEvidence(raw: unknown, ownerAliases: string[]): string {
  if (!Array.isArray(raw) || raw.length === 0) return '';
  const owners = new Set(ownerAliases.map((a) => a.trim().toLowerCase()));
  const names = [
    ...new Set(
      raw
        .filter((a): a is string => typeof a === 'string')
        .map((a) => a.trim())
        .filter((a) => a.length > 0 && !owners.has(a.toLowerCase())),
    ),
  ];
  return names.length === 0 ? '' : ` — with: ${names.join(', ')}`;
}

/** One refutation the model claims to have made, as it comes back over the wire. */
interface RefutationVerdict {
  factId: string;
  refuted: boolean;
  correctedObject?: string;
  reason?: string;
}

/** Parses the skeptic's reply, discarding anything it cannot vouch for. Ported verbatim. */
export function parseRefutationVerdicts(content: string, knownFactIds: Set<string>): RefutationVerdict[] {
  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const out: RefutationVerdict[] = [];
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const factId = typeof r.factId === 'string' ? r.factId : '';
    if (!knownFactIds.has(factId) || seen.has(factId)) continue;
    if (r.refuted !== true) continue;
    seen.add(factId);
    out.push({
      factId,
      refuted: true,
      correctedObject: typeof r.correctedObject === 'string' && r.correctedObject.trim() !== '' ? r.correctedObject.trim() : undefined,
      reason: typeof r.reason === 'string' ? r.reason : undefined,
    });
  }
  return out;
}

/** A short, human-readable one-liner per effect (journal detail column). Ported verbatim. */
export function describeEffect(effect: Effect): string {
  switch (effect.type) {
    case 'WriteDB':
      return effect.table === 'moments'
        ? `WriteDB moment ${effect.row.id}`
        : effect.table === 'knowledge_entries'
          ? `WriteDB knowledge_entry ${effect.row.id}`
          : effect.table === 'ask_threads'
            ? `WriteDB ask_thread ${effect.row.id}`
            : effect.table === 'owner_asks'
              ? `WriteDB owner_ask ${effect.row.id}`
            : effect.table === 'commitments'
              ? `WriteDB commitment ${effect.row.id}`
              : effect.table === 'organizations'
                ? `WriteDB organization ${effect.row.id}`
                : `WriteDB project ${effect.row.id}`;
    case 'EmitEvent':
      return `EmitEvent ${effect.event.type}`;
    case 'ScheduleLLM':
      return `ScheduleLLM purpose=${effect.purpose}`;
    case 'Judge':
      return `Judge ${effect.questionSetId} purpose=${effect.purpose}${effect.momentId ? ` moment=${effect.momentId}` : ''}`;
    case 'AttachTranscript':
      return `AttachTranscript ${effect.askId} "${effect.title}"`;
    case 'RecordGateFeatures':
      return `RecordGateFeatures ${effect.noticeKey}`;
    case 'UpdateMomentData':
      return `UpdateMomentData ${effect.momentId}`;
    case 'UpdateOwnerAsk':
      return `UpdateOwnerAsk ${effect.askId} (${effect.patch.proposals?.length ?? 0} proposals)`;
    case 'UpsertEntityFact':
      return `UpsertEntityFact ${effect.entityId}.${effect.predicate}`;
    case 'SupersedeFact':
      return `SupersedeFact ${effect.factId}`;
    case 'RetractFact':
      return `RetractFact ${effect.factId} (${effect.reason})`;
    case 'RetractKnowledgeEntry':
      return `RetractKnowledgeEntry ${effect.entryId} (${effect.reason})`;
    case 'Embed':
      return `Embed ${effect.refType} ${effect.refId}`;
    case 'RunReflection':
      return 'RunReflection';
    case 'RunGoalTrial':
      return `RunGoalTrial ${effect.forecaster}:${effect.cell} on ${effect.variable}`;
    case 'RunFactExtraction':
      return 'RunFactExtraction';
    case 'ResolveAliases':
      return 'ResolveAliases';
    case 'RunRefutation':
      return `RunRefutation sample=${effect.sampleSize}`;
    case 'RunBeliefAudit':
      return 'RunBeliefAudit';
    case 'RunAliasAlignment':
      return 'RunAliasAlignment';
    case 'RunAskHarvestBackfill':
      return 'RunAskHarvestBackfill';
    case 'DecayScores':
      return `DecayScores factor=${effect.factor}`;
    case 'ReinforceFact':
      return `ReinforceFact ${effect.factId} +${effect.delta}`;
    case 'DecayFactConfidence':
      return `DecayFactConfidence factor=${effect.factor}`;
    case 'Notify':
      return `Notify ${effect.channel}`;
    case 'DeleteRows':
      return `DeleteRows olderThan=${effect.olderThan}${effect.signalTypes ? ` types=${effect.signalTypes.join(',')}` : ''}`;
    case 'RecordPrediction':
      return `RecordPrediction ${effect.kind}/${effect.forecaster} p=${effect.priorProb.toFixed(2)} outcome=${effect.outcome}`;
    case 'RecordGateDecision':
      return `RecordGateDecision ${effect.noticeKey} ${effect.channel} (${effect.reason})`;
    case 'MergeProject':
      return `MergeProject ${effect.from} -> ${effect.into}`;
    case 'MergeEntity':
      return `MergeEntity ${effect.from} -> ${effect.into}`;
    case 'RunGoalPlan':
      return `RunGoalPlan ${effect.goalId}`;
    case 'RunWorldHygiene':
      return 'RunWorldHygiene';
    default:
      return (effect as Effect).type;
  }
}

/** Journal-vs-guarantee replay policy. Ported verbatim (see the daemon's two-phase journal rationale). */
export function replayDecision(status: EffectJournalStatus | null, guarantee: DeliveryGuarantee): 'run' | 'skip' | 'abandon' {
  if (status === null) return 'run';
  if (status === 'completed') return 'skip';
  if (status === 'indeterminate') return 'skip';
  // `started` and `failed` (K0.5) are the same question and get the same
  // answer. Both mean the effect ran and its outcome is unknown — a throw says
  // nothing about how far it got, and neither does a process dying mid-effect.
  // So an at-least-once effect is retried (which is what already happened
  // before the failure was recorded at all) and an at-most-once one is
  // abandoned, because repeating something that leaves the machine is worse
  // than skipping it. Written as one branch rather than two, deliberately:
  // treating a recorded failure as MORE certain than a crash would be a claim
  // the record cannot support.
  return guarantee === 'at-most-once' ? 'abandon' : 'run';
}

/**
 * The slice of `KernelState` a live surface renders — cheap to stringify-compare.
 *
 * `workbench` belongs here because the Work card draws it. It was absent while
 * a 30-second pulse pushed the `now` frame anyway, and the absence only became
 * visible when frames went change-driven: opening, queueing or closing a job
 * then emitted nothing, so the card updated by accident — whenever some
 * unrelated slice happened to move. Two reads of it thirteen minutes apart
 * returned disjoint job sets during the 2026-09-17 audit, and the reader was
 * not at fault; it was reading live state while the card held a frozen frame.
 *
 * The rule this follows: a field a surface renders is a field that must make
 * the key move.
 */
function workingMemorySliceKey(s: KernelState): string {
  return JSON.stringify({ window: s.window, moment: s.moment, focusMode: s.focusMode, project: s.project, solicitation: s.feedback.solicitation, workbench: s.workbench });
}

/** Same generate-once-persist device id the daemon used (`$SUNDIAL_HOME/.daemon/device-id`). */
export function loadOrGenerateDeviceId(): string {
  const runtimeDir = path.join(getSundialHome(), '.daemon');
  const deviceIdFile = path.join(runtimeDir, 'device-id');
  if (fs.existsSync(deviceIdFile)) {
    const id = fs.readFileSync(deviceIdFile, 'utf-8').trim();
    if (id) return id;
  }
  if (!fs.existsSync(runtimeDir)) fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  fs.writeFileSync(deviceIdFile, id, { encoding: 'utf-8', mode: 0o600 });
  return id;
}

/**
 * The table(s) one effect writes — the entire granularity model of the live
 * channel.
 *
 * A table name IS the event name. It already exists, it cannot drift from the
 * schema, and a new effect that writes a new table adds one line here and
 * nothing anywhere else. The daemon's old four-variant push union
 * (`moment-closed` / `insight-created` / `state-changed` / `signal`) could not
 * say WHICH reading moved, so every open surface had to re-read everything.
 *
 * An effect that writes through another path (`EmitEvent` re-enters the
 * pipeline, `Run*` dispatch detached and announce from where they insert)
 * returns nothing, and over-announcing a table is harmless: a card re-reads,
 * sees the same reading, and does not redraw.
 */
export function tablesTouched(effect: Effect): readonly string[] {
  switch (effect.type) {
    case 'WriteDB':
      return [effect.table];
    case 'UpdateMomentData':
      return ['moments', 'memory_embeddings'];
    case 'UpdateOwnerAsk':
      return ['owner_asks'];
    case 'MergeProject':
      return ['projects', 'moments', 'commitments'];
    case 'MergeEntity':
      return ['entities', 'entity_facts', 'memory_embeddings'];
    case 'RunGoalPlan':
      return [];
    case 'UpsertEntityFact':
      return ['entities', 'entity_facts'];
    case 'SupersedeFact':
    case 'RetractFact':
    case 'ReinforceFact':
    case 'DecayFactConfidence':
      return ['entity_facts'];
    case 'AttachTranscript':
      return ['knowledge_entries', 'memory_embeddings'];
    case 'RecordGateFeatures':
      return ['gate_decisions'];
    case 'RetractKnowledgeEntry':
      return ['knowledge_entries'];
    case 'Embed':
      return ['memory_embeddings'];
    case 'DecayScores':
      return ['moments', 'knowledge_entries'];
    case 'DeleteRows':
      return ['signals', 'moments', 'memory_embeddings', 'llm_audit'];
    case 'RecordGateDecision':
      return ['gate_decisions'];
    case 'RecordPrediction':
      return ['predictions'];
    default:
      return [];
  }
}

/**
 * The pseudo-table for the folded `KernelState` itself — what a surface reads
 * when it asks the kernel rather than the database (the strip, the job, the
 * open question). It is not a real table, which is why it is spelled without
 * an underscore: nothing can mistake it for one.
 */
export const STATE_TABLE = 'state';

export interface KernelRuntimeOptions {
  /** Stable device id; use `loadOrGenerateDeviceId()` for the daemon-compatible one. */
  deviceId: string;
  /**
   * Delivery hook for the `Notify` effect. The daemon could only console.log
   * it; the harness's `gnomon-kernel` plugin forwards it as a Cordis event
   * (`gnomon/notice`) for the Phase 5 proactive plugin to subscribe to.
   */
  onNotify?: (payload: { channel: string; payload: unknown }) => void;
  /**
   * Live invalidation: the names of the tables a fold just wrote, coalesced
   * per tick. The harness's `gnomon-kernel` plugin forwards it as the Cordis
   * event `gnomon/changed`, which the theme's SSE channel relays to every open
   * tab. Unset means no live surface is watching, and nothing is computed.
   */
  onChange?: (tables: readonly string[]) => void;
  /** Injectable for tests; defaults to `loadSundialConfig()`. */
  config?: ResolvedSundialConfig;
  /** The Jev call a `Judge` performs. Injectable so a test can prove a replay never reaches it; defaults to `runAuditedJudgement`. */
  judge?: typeof runAuditedJudgement;
  /**
   * Where `RunConversationExtraction` reads the owner's chat turns. The
   * harness's `gnomon-kernel` plugin wraps dsh's `sessionQuery`; unset means the
   * pass is a no-op (a runtime with no session store has nothing to read).
   */
  conversationSource?: ConversationSource;
}

export interface RejudgeStatus extends RejudgeProgress {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  bench: PackBench | null;
}

export interface BootResult {
  /** The snapshot's log offset (signal ULID) the tail replay started after, or null on a cold start. */
  snapshotOffset: string | null;
  /** Number of tail signals folded after the snapshot. */
  tailLength: number;
}

export class KernelRuntime {
  private state: KernelState | null = null;
  private lastSignalId: string | null = null;
  /** Serialized event lane — strictly one `ingestAndApply` at a time, in arrival order. Ported verbatim. */
  private eventChain: Promise<unknown> = Promise.resolve();
  private effectiveDailyCaps = resolveDailyCaps();
  private readonly judge: typeof runAuditedJudgement;
  private stopped = false;
  /** Detached `setTimeout`s (LLM dispatch, retries). Cleared on shutdown so a disposed plugin never fires into closed state — the daemon relied on process exit for this. */
  private pendingTimers = new Set<NodeJS.Timeout>();
  private readonly deviceId: string;
  private readonly onNotify?: (payload: { channel: string; payload: unknown }) => void;
  private readonly onChange?: (tables: readonly string[]) => void;
  /** Tables written since the last flush; drained by `flushChange` one tick later. */
  private readonly changedTables = new Set<string>();
  private changeFlushScheduled = false;
  private readonly injectedConfig?: ResolvedSundialConfig;

  private readonly conversationSource: ConversationSource | undefined;

  constructor(options: KernelRuntimeOptions) {
    this.deviceId = options.deviceId;
    this.onNotify = options.onNotify;
    this.onChange = options.onChange;
    this.injectedConfig = options.config;
    this.conversationSource = options.conversationSource;
    this.judge = options.judge ?? runAuditedJudgement;
  }

  // -------------------------------------------------------------------------
  // Public service surface (`ctx.gnomonKernel`)
  // -------------------------------------------------------------------------

  /**
   * Boot: load the latest kernel_state_snapshot, overlay live config, replay
   * the signal tail. Ported from the daemon's `startDaemon()` minus sensors,
   * API server, and pid files. The caller runs migrations first (gnomon-db).
   */
  async boot(): Promise<BootResult> {
    const gnomonConfig = this.injectedConfig ?? loadSundialConfig();
    applyPrivacyConfig(gnomonConfig.privacy);
    this.effectiveDailyCaps = resolveDailyCaps(gnomonConfig.budgets);

    const snapshot = await loadLatestSnapshot();
    if (snapshot) {
      this.state = hydrateSnapshot(this.deviceId, snapshot.state);
      this.lastSignalId = snapshot.logOffset || null;
      console.log(`[sundial-kernel] loaded snapshot (offset ${this.lastSignalId ?? '<none>'})`);
    } else {
      this.state = createInitialState(this.deviceId);
      this.lastSignalId = null;
    }
    // `state.config` reflects config.json on disk *right now*, never a stale
    // snapshot — same deliberate exemption as the daemon.
    this.state = {
      ...this.state,
      config: {
        retentionDays: gnomonConfig.retentionDays,
        screenTextRetentionDays: gnomonConfig.ocr.retentionDays,
        decayFactor: gnomonConfig.decayFactor,
        projectRules: gnomonConfig.projectRules,
        sharedPlaces: gnomonConfig.sharedPlaces,
        projectAliases: gnomonConfig.projectAliases,
        orgByPath: gnomonConfig.orgByPath,
        locationLabels: gnomonConfig.locationLabels,
        ownerAliases: gnomonConfig.ownerAliases,
        timezone: gnomonConfig.timezone,
        refutationEnabled: gnomonConfig.refutationEnabled,
        leisureRules: gnomonConfig.leisureRules,
        experiments: gnomonConfig.experiments,

        vault: gnomonConfig.vault,
      },
    };

    // Who the hashed people are, read back from the DURABLE facts rather than
    // carried in the snapshot.
    //
    // `memory.aliasNames` is a fast lookup a pure rule can use, mirrored by
    // `contradictionCheck` at the moment it promotes a `knownAs` belief. That
    // makes it fold-derived, and fold-derived state only survives if every fold
    // that built it is either inside the snapshot or still in the replayed tail.
    // A name the owner gave last week is in neither: the snapshot that held it
    // has been superseded and the signal has long left the tail. So the mirror
    // came back EMPTY while the facts themselves sat in `entity_facts`, valid
    // and untouched.
    //
    // The consequence was not subtle. On 2026-09-09 this machine's snapshot had
    // `aliasNames: {}` against 18 live `knownAs` facts, so `peopleAsk` — which
    // skips an alias the mirror already names — asked the owner to identify
    // seven people it had already been told about, one of them recorded as
    // "Alex Morgan" on the owner's own authority. Every fix in that rule
    // (the daily cap, the class mute, the answerable phrasing) treats a symptom
    // of this line being absent.
    //
    // Beside the config overlay on purpose, and for the same reason: both are
    // truths that live outside the fold, and both must reflect what is true NOW
    // rather than what a snapshot happened to capture.
    this.state = { ...this.state, memory: { ...this.state.memory, aliasNames: await loadAliasNames() } };
    const knownAliases = Object.keys(this.state.memory.aliasNames).length;
    if (knownAliases > 0) console.log(`[sundial-kernel] rehydrated ${knownAliases} known name(s) for hashed attendees`);

    // And the owner's standing verdict on each KIND of question, for exactly the
    // same reason one line up. `ownerAsk.classGain` is fold-derived from
    // `feedback:verdict` signals, so a verdict pressed last week is in neither
    // the snapshot nor the replayed tail — and the one verdict this record holds
    // is from 2026-09-21, which would have left the consumer starting at zero on
    // the very machine whose owner had already pressed the button. Rebuilt from
    // the LOG rather than from a table because the log IS where a verdict lives.
    this.state = { ...this.state, ownerAsk: { ...this.state.ownerAsk, classGain: rebuildAskClassGain(await getAskVerdicts()) } };
    const quietedClasses = Object.keys(this.state.ownerAsk.classGain);
    if (quietedClasses.length > 0) console.log(`[sundial-kernel] rehydrated the owner's verdict on ${quietedClasses.length} question kind(s): ${quietedClasses.join(', ')}`);

    const snapshotOffset = this.lastSignalId;
    const tail = await replayTail(this.lastSignalId);
    if (tail.length > 0) {
      console.log(`[sundial-kernel] replaying ${tail.length} signal(s) since last snapshot...`);
      for (const event of tail) {
        await this.applyEvent(event);
      }
    }
    // Ticket threads are rebuilt from the log on every boot (~4 s over 125k rows,
    // measured 2026-09-28): a snapshot from before `ticketTrack`, or from an older
    // version of it, would otherwise keep a stale index for up to 30 days.
    await this.rebuildTickets();

    console.log(`[sundial-kernel] kernel booted (device ${this.deviceId})`);
    return { snapshotOffset, tailLength: tail.length };
  }

  /**
   * `state.tickets` from the log itself: `ticketTrack` alone, folded over the
   * horizon's ticket-bearing rows, in log order. The rule is pure, so this is
   * the same answer a full replay would give for that slice, at a fraction of it.
   */
  private async rebuildTickets(): Promise<void> {
    if (!this.state) return;
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - TICKET_HORIZON_DAYS * 86_400_000).toISOString();
    let folded: KernelState = { ...this.state, tickets: {} };
    const PAGE = 5000;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await getSignalsInRange(from, to, PAGE, [...TICKET_SOURCE_TYPES], offset);
      for (const row of rows) folded = ticketTrack(folded, { id: row.id, type: `${row.signalType}:${row.eventType}`, ts: row.capturedAt, payload: row.data, sanitized: true } as SanitizedEvent).state;
      if (rows.length < PAGE) break;
    }
    this.state = { ...this.state, tickets: folded.tickets ?? {} };
    console.log(`[sundial-kernel] rebuilt ${Object.keys(this.state.tickets ?? {}).length} ticket thread(s) from the last ${TICKET_HORIZON_DAYS} days`);
  }

  /** Append one signal through the full pipeline: sanitize → log → fold → effects. Serialized against every other event. */
  appendSignal(type: string, payload: Record<string, unknown>, ts?: string): Promise<void> {
    return this.serialized(() => this.ingestAndApply(toDaemonEvent(type, payload, ts)));
  }

  getState(): KernelState | null {
    return this.state;
  }

  /**
   * The daemon's `clockTickTick`: log a `clock:tick` (observation-continuity
   * ground truth) and write a snapshot. Snapshot cadence = every tick, exactly
   * as the daemon did (`writeSnapshot` after each tick, ~1/minute).
   */
  async tickClock(): Promise<void> {
    await this.serialized(async () => {
      await this.ingestAndApply(toDaemonEvent('clock:tick', {}));
      if (this.state) {
        await writeSnapshot(this.state, this.lastSignalId ?? '');
      }
    });
  }

  /**
   * Graceful shutdown, ported from `stopDaemon()`: stop accepting detached
   * work, drain the serialized lane, flush a final snapshot. Moment closing is
   * not forced here — the daemon never force-closed either; `momentClose`
   * reconciles the open moment against the last logged `clock:tick` on the
   * next boot (span reconciliation), which is exactly why ticks are logged.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    await this.eventChain;
    if (this.state) {
      await writeSnapshot(this.state, this.lastSignalId ?? '');
    }
    console.log('[sundial-kernel] shutdown: final snapshot flushed');
  }

  // -------------------------------------------------------------------------
  // Serialized event lane
  // -------------------------------------------------------------------------

  private serialized(fn: () => Promise<void>): Promise<void> {
    const result = this.eventChain.then(fn);
    this.eventChain = result.catch((error) => {
      console.error('[sundial-kernel] event processing failed:', error);
    });
    return result;
  }

  /** Detached timer that respects shutdown (replaces the daemon's bare `setTimeout`s). */
  /**
   * Announce that `tables` moved.
   *
   * Collected and flushed one tick later, so one folded event that writes a
   * moment, two facts and an embedding costs the surface ONE frame naming four
   * tables rather than four frames. `defer` (not a raw `setTimeout`) so a
   * shutdown mid-fold never fires into a disposed plugin.
   */
  private change(tables: readonly string[]): void {
    if (this.onChange === undefined || tables.length === 0) return;
    for (const table of tables) this.changedTables.add(table);
    if (this.changeFlushScheduled) return;
    this.changeFlushScheduled = true;
    this.defer(() => {
      this.changeFlushScheduled = false;
      const flushed = [...this.changedTables];
      this.changedTables.clear();
      if (flushed.length > 0) this.onChange?.(flushed);
    }, 0);
  }

  private defer(fn: () => void, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (!this.stopped) fn();
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  /** A6 — retries only the ingest, never re-invokes the model. Ported verbatim. */
  private async retryIngestEvent(event: Event, attempt = 0): Promise<void> {
    try {
      await this.serialized(() => this.ingestAndApply(event));
    } catch (error) {
      if (attempt + 1 >= RETRY_MAX_ATTEMPTS) {
        console.error(`[sundial-kernel] failed to ingest ${event.type} after ${RETRY_MAX_ATTEMPTS} attempts:`, error);
        return;
      }
      const backoffMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
      this.defer(() => void this.retryIngestEvent(event, attempt + 1), backoffMs);
    }
  }

  // -------------------------------------------------------------------------
  // Ingest pipeline (sanitize → dedupe → log → fold → effects)
  // -------------------------------------------------------------------------

  private async ingestAndApply(event: Event): Promise<void> {
    const { event: sanitized, redactions } = sanitizeAtIngestWithAudit(event);

    // Drop a STATE observation byte-identical to the last one recorded (see
    // the daemon's restart-dedupe rationale). Occurrences are never deduped.
    if (this.state) {
      const signature = stateSignature(sanitized.type, sanitized.payload);
      if (signature && isUnchangedObservation(this.state.observed, signature)) return;
    }

    const [signalType, eventType] = sanitized.type.split(':');
    await insertSignal({
      id: sanitized.id,
      signalType,
      eventType: eventType ?? '',
      data: sanitized.payload,
      capturedAt: sanitized.ts,
    });
    if (!QUIET_SIGNAL_TYPES.has(signalType)) this.change(['signals']);

    await this.applyEvent(sanitized);

    // P4 — queryable, per-property `privacy:redacted` audit signal. Ported verbatim.
    const redactedProperties = Object.keys(redactions);
    if (event.type !== 'privacy:redacted' && redactedProperties.length > 0) {
      const total = redactedProperties.reduce((sum, key) => sum + redactions[key], 0);
      await this.ingestAndApply({
        id: createEventId(),
        type: 'privacy:redacted',
        ts: sanitized.ts,
        payload: { properties: redactions, total, sourceType: sanitized.type },
      });
    }
  }

  private async applyEvent(event: SanitizedEvent): Promise<void> {
    if (!this.state) throw new Error('applyEvent called before state initialized');
    const before = workingMemorySliceKey(this.state);
    const result = reduce(this.state, event, event.payload.backfill === true ? BACKFILL_MANIFEST : RULE_MANIFEST);
    this.state = result.state;
    this.lastSignalId = event.id;
    if (workingMemorySliceKey(this.state) !== before) this.change([STATE_TABLE]);
    await this.executeEffects(event.id, event.type, result.effects);
  }

  // -------------------------------------------------------------------------
  // Effect executor (the single place side effects are performed)
  // -------------------------------------------------------------------------

  private async executeEffects(eventId: string, eventType: string, effects: AttributedEffect[]): Promise<void> {
    for (const [effectIndex, attributed] of effects.entries()) {
      const { effect, ruleName } = attributed;

      const decision = replayDecision(await getEffectJournalStatus(eventId, effectIndex), effectDeliveryGuarantee(effect));
      if (decision === 'skip') continue;
      if (decision === 'abandon') {
        await markEffectIndeterminate(eventId, effectIndex);
        console.error(
          `[sundial-kernel] ABANDONED at-most-once effect after crash: ${describeEffect(effect)} (rule=${ruleName}, event=${eventId}#${effectIndex}). ` +
            'It was in flight when a previous process died, so whether it took effect is unknown. Not retried, because repeating it is worse than skipping it.',
        );
        continue;
      }

      await markEffectStarted(eventId, effectIndex, { ruleName, eventType, effectDetail: describeEffect(effect) });

      // K0.5 — the journal learns to record a failure, and NOTHING ELSE
      // changes. The catch re-throws.
      //
      // That restraint is the whole design. Before this, an effect that threw
      // left its row `started`, aborted the rest of this event's effects, and
      // was re-run on the next boot — which stamped it `completed`. A failure
      // healed into a success, and all 27,029 rows of this journal said
      // `completed` while the one surface able to report a broken side effect
      // reported the opposite.
      //
      // Swallowing the error here would have fixed the record and changed the
      // system: the remaining effects of the event would run, on state a
      // half-applied effect may have left. Whether that is better is a real
      // question and not this item's. So the failure is counted, the message
      // kept, and the exception continues on exactly the path it took before.
      try {
        await this.performEffect(eventId, effectIndex, effect);
      } catch (error) {
        await markEffectFailed(eventId, effectIndex, error instanceof Error ? (error.stack ?? error.message) : String(error));
        console.error(`[sundial-kernel] effect FAILED: ${describeEffect(effect)} (rule=${ruleName}, event=${eventId}#${effectIndex}):`, error);
        throw error;
      }

      // The one place the live channel learns anything. Every branch of
      // `performEffect` is a write; `tablesTouched` names what it wrote, and
      // nothing else in this executor has to remember that a surface exists.
      this.change(tablesTouched(effect));

      await markEffectCompleted(eventId, effectIndex);
    }
  }

  /** Every branch that actually writes. Split out of `executeEffects` so the journal's catch wraps the work and not the bookkeeping. */
  private async performEffect(eventId: string, effectIndex: number, effect: Effect): Promise<void> {
      if (effect.type === 'WriteDB' && effect.table === 'moments') {
        await insertMoment({ ...effect.row, data: { ...effect.row.data } });
      } else if (effect.type === 'WriteDB' && effect.table === 'projects') {
        await upsertProject(effect.row);
      } else if (effect.type === 'WriteDB' && effect.table === 'organizations') {
        await upsertOrganization(effect.row);
      } else if (effect.type === 'MergeProject') {
        const moved = await mergeProjectRows(effect.from, effect.into);
        console.log(`[sundial-kernel] merged project ${effect.from} into ${effect.into} (${moved.moments} moments, ${moved.commitments} commitments)`);
      } else if (effect.type === 'WriteDB' && effect.table === 'knowledge_entries') {
        await insertKnowledgeEntry(effect.row);
      } else if (effect.type === 'WriteDB' && effect.table === 'commitments') {
        await upsertCommitment(effect.row);
      } else if (effect.type === 'WriteDB' && effect.table === 'ask_threads') {
        await upsertAskThread(effect.row);
      } else if (effect.type === 'WriteDB' && effect.table === 'owner_asks') {
        await upsertOwnerAsk(effect.row);
      } else if (effect.type === 'EmitEvent') {
        // K0.5 — the call-tree's edge, written before the child runs so it
        // survives the child throwing. This is the id the executor INTENDED to
        // ingest: an emit the ingest gate dedupes as an unchanged observation
        // still records it, and the join simply finds no rows, which is the
        // truth about that hop.
        await markEffectEmitted(eventId, effectIndex, effect.event.id);
        await this.ingestAndApply(effect.event);
      } else if (effect.type === 'ScheduleLLM') {
        await this.dispatchScheduleLLM(effect);
      } else if (effect.type === 'Judge') {
        await this.dispatchJudge(effect);
      } else if (effect.type === 'RecordGateFeatures') {
        const found = await updateGateDecisionFeatures(effect.decisionId, effect.features as unknown as Record<string, unknown>);
        if (!found) console.log(`[sundial-kernel] gate features for ${effect.noticeKey}: no decision row ${effect.decisionId} to sit beside`);
      } else if (effect.type === 'AttachTranscript') {
        await performAttachTranscript(effect, { getSignalsInRange, getMomentsSince, insertKnowledgeEntry, computeEmbedding, insertEmbedding, ownerAliases: this.state?.config.ownerAliases ?? [], log: console.log });
      } else if (effect.type === 'UpdateMomentData') {
        await mergeMomentData(effect.momentId, effect.patch);
        // The narrative lands minutes after the moment closed and was embedded
        // without it; it is the densest line a moment has, so the moment is
        // embedded again from its row, replacing the vector it had.
        if (typeof (effect.patch as { narrative?: unknown }).narrative === 'string') {
          const [row] = await getMomentsByIds([effect.momentId]);
          if (row) {
            const { vector, model } = await computeEmbedding(momentEmbedText(row.processName, row.data));
            await replaceEmbedding({ id: `embed:${effect.momentId}`, refType: 'moment', refId: effect.momentId, model: momentModelTag(model), vector, createdAt: new Date().toISOString() });
          }
        }
      } else if (effect.type === 'UpdateOwnerAsk') {
        await updateOwnerAsk(effect.askId, effect.patch);
      } else if (effect.type === 'Notify') {
        // The daemon could only console.log this. The harness forwards it to
        // the delivery hook (→ Cordis `gnomon/notice` event; Phase 5's
        // proactive plugin subscribes) AND keeps the log line.
        console.log(`[sundial-kernel] notify(${effect.channel}):`, effect.payload);
        this.onNotify?.({ channel: effect.channel, payload: effect.payload });
      } else if (effect.type === 'DeleteRows' && Array.isArray(effect.signalTypes)) {
        const deleted = await deleteSignalsOlderThan(effect.olderThan, effect.signalTypes);
        console.log(`[sundial-kernel] retention prune (${effect.signalTypes.join(',')}): deleted ${deleted} signals older than ${effect.olderThan}`);
      } else if (effect.type === 'DeleteRows') {
        const result = await deleteRowsOlderThan(effect.olderThan);
        console.log(
          `[sundial-kernel] retention prune: deleted ${result.signalsDeleted} signals, ${result.momentsDeleted} moments, ${result.embeddingsDeleted} orphaned embeddings, ${result.llmAuditDeleted} llm_audit rows older than ${effect.olderThan}`,
        );
        const backfill = await reembedStaleEmbeddings();
        if (backfill.reembedded > 0 || backfill.orphaned > 0) {
          console.log(
            `[sundial-kernel] embedding backfill: re-embedded ${backfill.reembedded} stale-scheme rows to ${backfill.currentModel}, dropped ${backfill.orphaned} orphans, ${backfill.remaining} remaining`,
          );
        }
      } else if (effect.type === 'MergeEntity') {
        const moved = await mergeEntityRows(effect.from, effect.into, effect.alias);
        if (moved) console.log(`[sundial-kernel] merged entity ${effect.from} into ${effect.into} (${moved.facts} facts, ${moved.embeddings} embeddings; alias ${effect.alias})`);
      } else if (effect.type === 'UpsertEntityFact') {
        // J2.4: an alias the owner already resolved lands on the survivor, so the
        // next attendee row for a merged hash does not recreate the hash entity.
        const survivor = effect.entityKind === 'person' ? await resolveEntityAlias(effect.canonicalName) : null;
        const entityId = survivor ?? effect.entityId;
        if (!survivor) await upsertEntity({ id: effect.entityId, kind: effect.entityKind, canonicalName: effect.canonicalName, createdAt: effect.ts });
        await insertEntityFact({
          id: effect.factId,
          entityId,
          predicate: effect.predicate,
          object: effect.object,
          confidence: effect.confidence,
          validFrom: effect.ts,
          sourceEventId: effect.sourceEventId,
          createdAt: effect.ts,
          provenance: effect.provenance,
        });
      } else if (effect.type === 'SupersedeFact') {
        await supersedeEntityFact(effect.factId, effect.supersededByFactId, effect.ts);
      } else if (effect.type === 'RetractFact') {
        await retractEntityFact(effect.factId, effect.ts);
      } else if (effect.type === 'RetractKnowledgeEntry') {
        await retractKnowledgeEntry(effect.entryId, effect.ts);
      } else if (effect.type === 'Embed') {
        const { vector, model } = await computeEmbedding(effect.text);
        // A moment's vector says which version of its text went in (see `momentEmbedText`).
        await insertEmbedding({ id: effect.id, refType: effect.refType, refId: effect.refId, model: effect.refType === 'moment' ? momentModelTag(model) : model, vector, createdAt: new Date().toISOString() });
      } else if (effect.type === 'RunGoalTrial') {
        this.dispatchRunGoalTrial(effect);
      } else if (effect.type === 'RunReflection') {
        await this.dispatchRunReflection(effect);
      } else if (effect.type === 'RunFactExtraction') {
        await this.dispatchRunFactExtraction(effect);
      } else if (effect.type === 'ResolveAliases') {
        await this.dispatchResolveAliases(effect);
      } else if (effect.type === 'RunConversationExtraction') {
        await this.dispatchRunConversationExtraction(effect);
      } else if (effect.type === 'RunRefutation') {
        await this.dispatchRunRefutation(effect);
      } else if (effect.type === 'RunBeliefAudit') {
        await this.dispatchRunBeliefAudit(effect);
      } else if (effect.type === 'RunAliasAlignment') {
        if (this.state && systemOneBackend() !== 'off') this.defer(() => void this.performAliasAlignment(effect), 0);
      } else if (effect.type === 'RunAskHarvestBackfill') {
        await this.dispatchRunAskHarvestBackfill();
      } else if (effect.type === 'RunJournal') {
        await this.dispatchRunJournal(effect);
      } else if (effect.type === 'RunGoalPlan') {
        await this.dispatchRunGoalPlan(effect);
      } else if (effect.type === 'RunWorldHygiene') {
        // W2 — deferred like the belief audit, so a nightly read never holds
        // up the fold that asked for it.
        this.defer(() => void this.performWorldHygiene(effect), 0);
      } else if (effect.type === 'DecayScores') {
        await Promise.all([decayMomentScores(effect.factor), decayKnowledgeScores(effect.factor)]);
      } else if (effect.type === 'ReinforceFact') {
        await reinforceEntityFact(effect.factId, effect.delta);
      } else if (effect.type === 'DecayFactConfidence') {
        await decayCurrentFactConfidence(effect.factor);
      } else if (effect.type === 'RecordGateDecision') {
        // unsaid-room-gate-decision-persistence: the gate's verdict + arithmetic,
        // written HERE (the executor) and never by the rule; the derived id +
        // onConflictDoNothing make boot replay offer the identical row.
        await insertGateDecision({
          id: effect.id,
          noticeKey: effect.noticeKey,
          kind: effect.kind,
          channel: effect.channel,
          reason: effect.reason,
          weight: effect.weight,
          utility: effect.utility,
          surprise: effect.surprise,
          precision: effect.precision,
          habituation: effect.habituation,
          concern: effect.concern,
          interruptionCost: effect.interruptionCost,
          // K0.2 — the bars the rule actually used, carried straight through.
          // Not re-derived here: the executor has no business knowing what
          // `noticeBias` does, and a second derivation is a second policy.
          tonicBar: effect.tonicBar,
          phasicBar: effect.phasicBar,
          decidedAt: effect.decidedAt,
        });
      } else if (effect.type === 'RecordPrediction') {
        await insertPrediction({
          id: effect.id,
          kind: effect.kind,
          forecaster: effect.forecaster,
          createdAt: effect.createdAt,
          resolvedAt: effect.resolvedAt,
          priorProb: effect.priorProb,
          features: effect.features,
          outcome: effect.outcome,
          surprise: effect.surprise,
          // K0.3 — the fair opponent, carried from the rule that knew it.
          baseProb: effect.baseProb,
        });
      }
  }

  // -------------------------------------------------------------------------
  // Budget-checked LLM dispatchers + detached performers (ported verbatim,
  // module `state`/`effectiveDailyCaps` reads becoming instance reads)
  // -------------------------------------------------------------------------

  private async performScheduledLlmCall(effect: ScheduleLLMEffect, attempt = Math.max(0, (effect.attempt ?? 1) - 1), parentCallId: string | null = effect.parentCallId ?? null): Promise<void> {
    let result: Awaited<ReturnType<typeof runAuditedLlmCall>>;
    try {
      result = await runAuditedLlmCall({
        purpose: effect.purpose,
        momentId: effect.momentId,
        messages: effect.messages,
        // `attempt` here counts from 0; the ledger column counts tries from 1.
        attempt: attempt + 1,
        parentCallId,
      });
    } catch (error) {
      const permanent = error instanceof LlmHttpError && error.status < 500 && error.status !== 429;
      if (permanent || attempt + 1 >= RETRY_MAX_ATTEMPTS) {
        console.error(
          `[sundial-kernel] LLM call failed ${permanent ? '(client error, not retried)' : 'permanently'} (purpose=${effect.purpose}, momentId=${effect.momentId}):`,
          error,
        );
        return;
      }
      const retryAfterMs = error instanceof LlmHttpError ? error.retryAfterMs : null;
      const backoffMs = retryAfterMs ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
      this.defer(() => void this.performScheduledLlmCall(effect, attempt + 1, auditIdOf(error)), backoffMs);
      return;
    }

    await this.retryIngestEvent(toDaemonEvent('llm:result', { purpose: effect.purpose, momentId: effect.momentId, text: result.content, auditId: result.auditId, metadata: effect.metadata }));
  }

  private async dispatchScheduleLLM(effect: ScheduleLLMEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose[effect.purpose];
    if (budget.callsToday >= this.effectiveDailyCaps[effect.purpose]) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=${effect.purpose} (${budget.callsToday}/${this.effectiveDailyCaps[effect.purpose]})`);
      return;
    }

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: effect.purpose }));

    this.defer(() => void this.performScheduledLlmCall(effect), effect.delayMs);
  }

  /**
   * A `Judge` effect (docs/jarvis/02): the same dispatch/perform split as
   * `ScheduleLLM`, against Jev. Public like `dispatchRunProjectStatus`, so
   * the rejudge job and a test can hand it an effect without a rule.
   *
   * Backend `off` (`SUNDIAL_SYSTEMONE_BACKEND`) drops every judgement here,
   * before the budget is spent; rules then fall back to their pre-Jev paths.
   */
  async dispatchJudge(effect: JudgeEffect): Promise<void> {
    if (!this.state) return;
    if (systemOneBackend() === 'off') {
      await this.markDegraded('off', true);
      return;
    }

    const budget = this.state.budgets.byPurpose[effect.purpose];
    const cap = this.effectiveDailyCaps[effect.purpose];
    if (budget.callsToday >= cap) {
      console.warn(`[sundial-kernel] judgement budget exhausted for purpose=${effect.purpose} (${budget.callsToday}/${cap})`);
      return;
    }

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: effect.purpose }));
    this.defer(() => void this.performJudgement(effect), effect.delayMs);
  }

  /**
   * `state.judgement.degraded` is written by the fold, from this event — the
   * executor only asks. `inLane` says where the caller stands: inside an
   * effect (dispatch, already on the serialized lane — ingest directly, as
   * `EmitEvent` does) or detached (a deferred perform — go through the lane).
   * Getting this wrong is a deadlock: the lane waits on the effect that waits
   * on the lane, and the first `off` judgement would have hung the fold.
   */
  private async markDegraded(mode: 'none' | 'local-fallback' | 'off', inLane: boolean): Promise<void> {
    if (this.state?.judgement.degraded === mode) return;
    const event = toDaemonEvent('judgement:degraded', { mode });
    if (inLane) await this.ingestAndApply(event);
    else await this.retryIngestEvent(event);
  }

  private rejudgeState: RejudgeStatus = { running: false, startedAt: null, finishedAt: null, total: 0, done: 0, calls: 0, failedCalls: 0, error: null, bench: null };

  /**
   * J5.4 — every question the registry can ask, by id, so a surface can name
   * a `state.judgement.questions` record ("moment-fanout · is_work") without
   * depending on the rules package itself. Built off each set's first sample,
   * the one `judgementTrack` reads ids from.
   */
  questionCatalog(): { id: string; set: string; key: string; type: string; learnsAt: number }[] {
    const out: { id: string; set: string; key: string; type: string; learnsAt: number }[] = [];
    for (const set of QUESTION_SETS) {
      const sample = set.samples()[0];
      if (!sample) continue;
      for (const [key, q] of Object.entries(set.build(...sample).questions)) out.push({ id: questionId(q), set: set.id, key, type: q.type, learnsAt: THRESHOLD_MIN_N });
    }
    return out;
  }

  /** A question's operating point: its record's threshold once learned (n ≥ 20), else the default given. */
  private thresholdFor(id: string, fallback: number): number {
    const record = this.state?.judgement.questions[id];
    return record && record.n >= THRESHOLD_MIN_N ? record.threshold : fallback;
  }

  /**
   * J4.1 — the judge's reading of a proposed tool call: which rung, how sure,
   * what is at stake. Not a key: the gate in `gnomon-actions` decides from
   * code first and may only TIGHTEN on this. Null when judging is off, over
   * budget or failing — the code decision then stands alone, as before.
   */
  async classifyAction(tool: string, args: unknown): Promise<{ level: ActionLevel; p: number; stakes: number | null; escalate: boolean } | null> {
    const built = classifyAction.build({ tool, args });
    const judged = await this.judgeNow({ purpose: 'classify', questionSetId: classifyAction.id, momentId: null, state: built.state, questions: built.questions });
    if (!judged) return null;
    const read = actionLevelOf(judged.answers);
    if (!read) return null;
    const threshold = this.thresholdFor(questionId(CLASSIFY_ACTION_QUESTIONS.level), ACTION_ESCALATE_DEFAULT_THRESHOLD);
    return { ...read, escalate: (read.level === 'outward' || read.level === 'internal_irreversible') && read.p >= threshold };
  }

  /**
   * J4.2 — after an L3+ action, did its result show it happened? Returns the
   * noul and whether it fell under the question's threshold (a failure worth a
   * notice). Null when judging is unavailable.
   */
  async verifyAction(tool: string, args: unknown, result: unknown): Promise<{ carriedOut: number; failed: boolean } | null> {
    const built = verifyAction.build({ tool, args, result });
    const judged = await this.judgeNow({ purpose: 'judge', questionSetId: verifyAction.id, momentId: null, state: built.state, questions: built.questions });
    if (!judged) return null;
    const carriedOut = carriedOutOf(judged.answers);
    if (carriedOut === null) return null;
    return { carriedOut, failed: carriedOut < this.thresholdFor(questionId(VERIFY_ACTION_QUESTIONS.carried_out), ACTION_VERIFY_DEFAULT_THRESHOLD) };
  }

  rejudgeStatus(): RejudgeStatus {
    return this.rejudgeState;
  }

  /**
   * J2.6 — the rejudge job, off the lane. Every stored moment without
   * `data.judgement` (or all of them with `all`) goes through `moment-fanout`
   * packed five to a call, sixteen in flight, each answer ingested as a
   * `judgement:result` the fold applies like a live close. `bench: n` judges
   * n moments singly AND packed and reports the agreement instead — the bench
   * the packing must pass before the job is trusted. Returns at once; poll
   * `rejudgeStatus()`. `pack` defaults to 1 for the job: the bench of
   * 2026-09-22 (40 moments) kept the `subject` pick 38/40 and the nouls within
   * 0.09 when packed five, but moved a score level on 13/40 of `depth` and
   * `worth`, and unpacked at sixteen in flight already fits the five-minute bound.
   */
  rejudge(opts: { all?: boolean; limit?: number; bench?: number; pack?: number; sinceDays?: number } = {}): RejudgeStatus {
    if (this.rejudgeState.running) return this.rejudgeState;
    const backend = systemOneBackend();
    if (backend === 'off') {
      this.rejudgeState = { ...this.rejudgeState, error: 'SUNDIAL_SYSTEMONE_BACKEND=off: nothing judges' };
      return this.rejudgeState;
    }
    this.rejudgeState = { running: true, startedAt: new Date().toISOString(), finishedAt: null, total: 0, done: 0, calls: 0, failedCalls: 0, error: null, bench: null };
    const deps = {
      judge: (o: Parameters<typeof runAuditedJudgement>[0]) => this.judge(o),
      ingest: (payload: JudgementResultPayload) => this.retryIngestEvent(toDaemonEvent('judgement:result', payload as unknown as Record<string, unknown>)),
      backend,
    };
    this.defer(() => {
      void (async () => {
        let rows = await getAllMoments();
        if (opts.sinceDays) {
          const cutoff = new Date(Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000).toISOString();
          rows = rows.filter((r) => r.startTime >= cutoff);
        }
        if (!opts.all) rows = rows.filter((r) => r.data.judgement === undefined);
        // J2.7: the goals open NOW, in the slot order the live close uses.
        const open = openGoals(this.state?.memory.factCursor ?? {}).slice(0, MAX_GOAL_SLOTS);
        const promises = (this.state?.commitments.open ?? []).filter((c) => c.source === 'speech').slice(0, MAX_PROMISE_SLOTS);
        const goals = { labels: open.map(goalLabel), ids: open.map((g) => g.entityId), promiseLabels: promises.map((c) => c.name), promiseIds: promises.map((c) => c.id) };
        if (opts.bench) {
          // Spread across history, not the newest n: a bench on one afternoon is a bench on one kind of day.
          const step = Math.max(1, Math.floor(rows.length / opts.bench));
          rows = rows.filter((_, i) => i % step === 0).slice(0, opts.bench);
          this.rejudgeState = { ...this.rejudgeState, total: rows.length };
          const bench = await benchPacking(rows, deps, opts.pack ?? PACK_SIZE);
          this.rejudgeState = { ...this.rejudgeState, running: false, finishedAt: new Date().toISOString(), done: bench.n, bench };
          return;
        }
        if (opts.limit) rows = rows.slice(-opts.limit);
        this.rejudgeState = { ...this.rejudgeState, total: rows.length };
        const progress = await rejudgeMoments(rows, deps, { packSize: opts.pack ?? 1, goals, onProgress: (p) => (this.rejudgeState = { ...this.rejudgeState, ...p }) });
        this.rejudgeState = { ...this.rejudgeState, ...progress, running: false, finishedAt: new Date().toISOString() };
      })().catch((error) => {
        this.rejudgeState = { ...this.rejudgeState, running: false, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) };
      });
    }, 0);
    return this.rejudgeState;
  }

  /**
   * A judgement a TOOL needs an answer to now, inside a turn (J1.3's rerank):
   * not an effect, so not journaled, but budgeted and audited like one. One
   * attempt on the configured backend; `off`, an exhausted budget or a
   * failure return null and the caller keeps its pre-Jev result. Runs outside
   * the event lane (a dsh tool call is not a fold), so the budget events go
   * through `retryIngestEvent`.
   */
  async judgeNow(options: { purpose: JudgementPurpose; questionSetId: string; momentId: string | null; state: unknown; questions: Record<string, JudgeQuestion> }): Promise<{ answers: JudgementResultPayload['answers']; model: string } | null> {
    if (!this.state) return null;
    const backend = systemOneBackend();
    if (backend === 'off') return null;
    const budget = this.state.budgets.byPurpose[options.purpose];
    if (budget.callsToday >= this.effectiveDailyCaps[options.purpose]) return null;
    await this.retryIngestEvent(toDaemonEvent('llm:dispatched', { purpose: options.purpose }));
    try {
      const result = await this.judge({ purpose: options.purpose, momentId: options.momentId, state: options.state, questions: options.questions, backend });
      return { answers: result.answers, model: result.model };
    } catch (error) {
      console.warn(`[sundial-kernel] judgeNow failed (set=${options.questionSetId}):`, error instanceof Error ? error.message : error);
      await this.retryIngestEvent(toDaemonEvent('llm:refunded', { purpose: options.purpose }));
      return null;
    }
  }

  /**
   * Jev first, `RETRY_MAX_ATTEMPTS` times, status-aware. Then the local
   * fallback ONCE, and the board learns Jev is down (`degraded:
   * local-fallback`). If that fails too, the slot is refunded and the mark
   * says `off`: rules fall back to their pre-Jev paths. A Jev success clears
   * the mark. `SUNDIAL_SYSTEMONE_BACKEND=local` starts on the fallback.
   */
  private async performJudgement(effect: JudgeEffect, attempt = 0, parentCallId: string | null = null): Promise<void> {
    const backend = systemOneBackend() === 'local' || attempt >= RETRY_MAX_ATTEMPTS ? 'local' : 'jev';
    let result: Awaited<ReturnType<typeof runAuditedJudgement>>;
    try {
      result = await this.judge({
        purpose: effect.purpose,
        momentId: effect.momentId,
        state: effect.state,
        questions: effect.questions,
        backend,
        attempt: attempt + 1,
        parentCallId,
      });
    } catch (error) {
      const permanent = error instanceof LlmHttpError && error.status < 500 && error.status !== 429;
      if (backend === 'local') {
        console.error(`[sundial-kernel] judgement failed on the local fallback too (set=${effect.questionSetId}, momentId=${effect.momentId}):`, error);
        await this.markDegraded('off', false);
        // The slot was spent on a call that answered nothing; give it back, as the text path does.
        await this.retryIngestEvent(toDaemonEvent('llm:refunded', { purpose: effect.purpose }));
        // The consuming rule learns the question went unanswered, with the
        // context it sent, so what waited on the judge can fall back rather than hang.
        await this.retryIngestEvent(toDaemonEvent('judgement:failed', { purpose: effect.purpose, questionSetId: effect.questionSetId, momentId: effect.momentId, ...(effect.metadata ? { metadata: effect.metadata } : {}) }));
        return;
      }
      if (permanent || attempt + 1 >= RETRY_MAX_ATTEMPTS) {
        console.warn(`[sundial-kernel] Jev failed ${permanent ? '(client error)' : `${attempt + 1} times`} (set=${effect.questionSetId}); switching this call to the local fallback:`, error instanceof Error ? error.message : error);
        await this.markDegraded('local-fallback', false);
        this.defer(() => void this.performJudgement(effect, RETRY_MAX_ATTEMPTS, auditIdOf(error)), 0);
        return;
      }
      const retryAfterMs = error instanceof LlmHttpError ? error.retryAfterMs : null;
      this.defer(() => void this.performJudgement(effect, attempt + 1, auditIdOf(error)), retryAfterMs ?? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt));
      return;
    }
    if (backend === 'jev') await this.markDegraded('none', false);
    else if (systemOneBackend() === 'local') await this.markDegraded('local-fallback', false);

    const payload: JudgementResultPayload = {
      purpose: effect.purpose,
      questionSetId: effect.questionSetId,
      momentId: effect.momentId,
      answers: result.answers,
      model: result.model,
      latencyMs: Math.round(result.latencyMs),
      ...(effect.metadata ? { metadata: effect.metadata } : {}),
    };
    await this.retryIngestEvent(toDaemonEvent('judgement:result', payload as unknown as Record<string, unknown>));
  }

  /**
   * J2.3 — the nightly belief audit. One `audit-fact` judgement per live
   * inferred fact, `factId` in the metadata; `applyFactAudit` retracts at the
   * learned threshold, everything else rides in the log for the Trust
   * surface. Runs off the lane with a small pool: Jev takes 16 in flight
   * without a 429, and ~360 facts at ~300 ms is under a minute. Each call is
   * budgeted under `audit` like any `Judge`; the pass stops at the cap.
   */
  private async dispatchRunBeliefAudit(effect: RunBeliefAuditEffect): Promise<void> {
    if (!this.state) return;
    if (systemOneBackend() === 'off') return;
    this.defer(() => void this.performBeliefAudit(effect), 0);
  }

  /**
   * W2 — read the world model, plan against today's validator, and hand the
   * plan back as ONE event. The plan is in the log, so every retraction and
   * merge it causes can be traced to this pass and its reason. An empty plan
   * appends nothing: a clean record is silent.
   */
  private async performWorldHygiene(effect: RunWorldHygieneEffect): Promise<void> {
    if (!this.state) return;
    const { entities, facts } = await getWorldForHygiene();
    const actions = planHygiene(entities, facts, hygieneContext(this.state));
    const retracts = actions.filter((a) => a.op === 'retract').length;
    console.log(`[sundial-kernel] world hygiene: ${retracts} retraction(s), ${actions.length - retracts} merge(s) over ${facts.length} fact(s)`);
    if (actions.length === 0) return;
    await this.appendSignal('world:hygiene', { timestamp: effect.ts, actions });
  }

  private async performBeliefAudit(effect: RunBeliefAuditEffect): Promise<void> {
    const facts = await getFactsForBeliefAudit();
    if (facts.length === 0) return;
    const now = Date.parse(effect.ts);
    // The entity→path map and the evidence behind every `project usesTool X`:
    // a project entity is keyed by the slug of the row's name, so every
    // `projects` row whose name slugs to the entity is one of its paths, and
    // the written moments under those paths are the sessions the belief can
    // point to. Read once per pass; two GROUP BYs, not one query per fact.
    const [projects, counts] = await Promise.all([getAllProjects(), getMomentCountsByProjectAndProcess()]);
    const pathsOf = new Map<string, Set<string>>();
    for (const project of projects) {
      const key = projectEntityId(project.name);
      pathsOf.set(key, (pathsOf.get(key) ?? new Set()).add(project.id));
    }
    const evidenceFor = (fact: (typeof facts)[number]) => {
      if (fact.entityKind !== 'project' || fact.predicate !== 'usesTool') return undefined;
      const paths = pathsOf.get(fact.entityId) ?? new Set<string>();
      let sessionsInProject = 0;
      let sessionsWithThisToolInProject = 0;
      let sessionsWithThisToolAnywhere = 0;
      for (const row of counts) {
        const inProject = paths.has(row.projectId);
        const thisTool = row.processName === fact.object;
        if (inProject) sessionsInProject += row.count;
        if (inProject && thisTool) sessionsWithThisToolInProject += row.count;
        if (thisTool) sessionsWithThisToolAnywhere += row.count;
      }
      return { sessionsInProject, sessionsWithThisToolInProject, sessionsWithThisToolAnywhere };
    };
    let next = 0;
    let sent = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const fact = facts[next];
        next += 1;
        if (!fact || !this.state) return;
        if (this.state.budgets.byPurpose.audit.callsToday >= this.effectiveDailyCaps.audit) {
          console.warn(`[sundial-kernel] belief audit stopped at the audit cap after ${sent} of ${facts.length} facts`);
          next = facts.length;
          return;
        }
        const built = auditFact.build({
          subject: fact.canonicalName,
          subjectKind: fact.entityKind,
          predicate: fact.predicate,
          object: fact.object,
          confidence: fact.confidence,
          provenance: fact.provenance,
          firstRecordedDaysAgo: Math.max(0, (now - Date.parse(fact.validFrom)) / 86_400_000),
          alpha: fact.alpha,
          beta: fact.beta,
          evidence: evidenceFor(fact),
        });
        sent += 1;
        await this.retryIngestEvent(toDaemonEvent('llm:dispatched', { purpose: 'audit' }));
        await this.performJudgement({
          type: 'Judge',
          purpose: 'audit',
          questionSetId: auditFact.id,
          momentId: null,
          delayMs: 0,
          state: built.state,
          questions: built.questions,
          // `artifactId` = the fact id: an `entity_fact` verdict grades these answers (J5.4).
          metadata: { factId: fact.id, artifactId: fact.id, provenance: fact.provenance, belief: `${fact.canonicalName} ${fact.predicate} ${fact.object}`.slice(0, 200) },
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BELIEF_AUDIT_POOL, facts.length) }, worker));
    console.log(`[sundial-kernel] belief audit: ${sent} of ${facts.length} live facts judged`);
  }

  /**
   * J2.4 — the judge leg of alias alignment. Project entities: every pair
   * (a dozen entities, under a hundred pairs). People: only pairs a cheap
   * test already links — a shared name token, a `knownAs` that names the
   * other, or one-word names two edits apart (Noah / Thomas) — because 71
   * people are 2,485 pairs and the judge's answer on two unrelated strangers
   * is not worth a call. Each pair is one `align-alias` judgement under the
   * `audit` cap; `applyAliasAlignment` files the answer as a suggestion.
   */
  private async performAliasAlignment(effect: RunAliasAlignmentEffect): Promise<void> {
    void effect;
    // The exact leg's row half, for rows the fold no longer knows. The rule
    // merges a synthetic `named:` root beside its real twin through
    // `project:merged` — but only for roots in `state.project.known`, and the
    // live table held `named:puzzlebox-studio` and `named:overture` with
    // their moments long after the fold had forgotten them (the first run of
    // the rule merged nothing). With no fold state to move, the effect
    // `projectTrack` would have emitted IS the whole merge, so it runs here.
    if (this.state) {
      const rows = await getAllProjects();
      const aliases = this.state.config.projectAliases;
      const known = this.state.project.known;
      const byCanonical = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = canonicalProjectName(row.name, aliases);
        byCanonical.set(key, [...(byCanonical.get(key) ?? []), row]);
      }
      for (const group of byCanonical.values()) {
        const real = group.filter((r) => !r.id.startsWith('named:'));
        if (real.length !== 1) continue;
        for (const from of group.filter((r) => r.id.startsWith('named:') && !(r.id in known))) {
          const moved = await mergeProjectRows(from.id, real[0]!.id);
          console.log(`[sundial-kernel] alias alignment: merged orphaned ${from.id} into ${real[0]!.id} (${moved.moments} moments, ${moved.commitments} commitments)`);
        }
      }
    }
    const [entities, knownAs] = await Promise.all([getAllEntities(), loadAliasNames()]);
    const tokens = (name: string): Set<string> => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !name.startsWith('person-')));
    const close = (a: string, b: string): boolean => {
      // One-word names within two edits: a spelling variant, not a stranger.
      if (a.includes(' ') || b.includes(' ') || Math.abs(a.length - b.length) > 2) return false;
      let edits = 0;
      const [x, y] = a.length >= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
      for (let i = 0, j = 0; i < x.length; i += 1) {
        if (x[i] === y[j]) j += 1;
        else if ((edits += 1) > 2) return false;
        else if (x.length === y.length) j += 1;
      }
      return true;
    };
    const linked = (a: string, b: string): boolean => {
      const ka = knownAs[a]?.toLowerCase() ?? null;
      const kb = knownAs[b]?.toLowerCase() ?? null;
      if (ka === b.toLowerCase() || kb === a.toLowerCase()) return true;
      const ta = new Set([...tokens(a), ...(ka ? tokens(ka) : [])]);
      const tb = new Set([...tokens(b), ...(kb ? tokens(kb) : [])]);
      for (const t of ta) if (tb.has(t)) return true;
      return close(a, b);
    };
    const pairs: AlignAliasInput[] = [];
    const meta: { kind: 'project' | 'person'; aId: string; a: string; bId: string; b: string }[] = [];
    for (const kind of ['project', 'person'] as const) {
      const list = entities.filter((e) => e.kind === kind);
      for (let i = 0; i < list.length; i += 1)
        for (let j = i + 1; j < list.length; j += 1) {
          const a = list[i]!;
          const b = list[j]!;
          if (kind === 'person' && !linked(a.canonicalName, b.canonicalName)) continue;
          pairs.push({ kind, nameA: a.canonicalName, nameB: b.canonicalName, alsoKnownAsA: knownAs[a.canonicalName] ?? null, alsoKnownAsB: knownAs[b.canonicalName] ?? null });
          meta.push({ kind, aId: a.id, a: a.canonicalName, bId: b.id, b: b.canonicalName });
        }
    }
    let next = 0;
    let sent = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= pairs.length || !this.state) return;
        if (this.state.budgets.byPurpose.audit.callsToday >= this.effectiveDailyCaps.audit) {
          console.warn(`[sundial-kernel] alias alignment stopped at the audit cap after ${sent} of ${pairs.length} pairs`);
          next = pairs.length;
          return;
        }
        const built = alignAlias.build(pairs[i]!);
        sent += 1;
        await this.retryIngestEvent(toDaemonEvent('llm:dispatched', { purpose: 'audit' }));
        await this.performJudgement({ type: 'Judge', purpose: 'audit', questionSetId: alignAlias.id, momentId: null, delayMs: 0, state: built.state, questions: built.questions, metadata: meta[i] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(BELIEF_AUDIT_POOL, pairs.length) }, worker));
    console.log(`[sundial-kernel] alias alignment: ${sent} of ${pairs.length} pairs judged`);
  }

  private async performReflectionCall(effect: RunReflectionEffect): Promise<void> {
    const [moments, knowledgeEntries] = await Promise.all([getMomentsSince(effect.since), getKnowledgeEntriesSince(effect.since)]);
    if (moments.length === 0 && knowledgeEntries.length === 0) return;

    const topProcesses = computeTopProcessesByDuration(moments);
    if (topProcesses.length > 0) {
      await this.retryIngestEvent(toDaemonEvent('memory:priorities', { top: topProcesses }));
    }

    const summaryLines = [
      ...moments.slice(-REFLECTION_MAX_ITEMS).map((m) => `- [${m.startTime}] ${m.processName} (${Math.round(m.durationMs / 60_000)}m)`),
      ...knowledgeEntries.slice(0, REFLECTION_MAX_ITEMS).map((k) => `- [${k.createdAt}] ${k.title}: ${k.body}`),
    ];

    try {
      const result = await runAuditedLlmCall({
        purpose: 'reflect',
        momentId: null,
        timeoutMs: REFLECTION_TIMEOUT_MS,
        messages: [
          {
            role: 'system',
            content: withPersona(
              NO_DIAGNOSIS,
              'You are synthesizing a short daily reflection over that record.',
              'Respond with STRICT JSON only, no markdown fencing, matching exactly: {"title": "...", "body": "...", "severity": "info"}. Title under 60 characters, body 2-4 sentences naming the most significant pattern(s), plain language.',
              // The input is moment rows and knowledge-entry titles — Gnomon's
              // own earlier output. Naming that keeps the reflection from
              // reading a written insight as a second, independent sighting of
              // the pattern it already describes.
              'The knowledge-entry lines below are notes you wrote earlier, not fresh observations. Do not treat a note about a pattern as further evidence of that pattern, and do not restate one you have already made.',
            ),
          },
          { role: 'user', content: summaryLines.join('\n') },
        ],
      });

      const insight = parseCompanionInsight(result.content);
      if (!insight) return;

      // Novelty, checked on the title the model produced: the same shape of day
      // yields the same reflection three days running, and a note that repeats
      // the last one is not a second finding. The call was already made — this
      // only decides whether the result is kept.
      const recentReflections = (await getKnowledgeEntriesSince(new Date(Date.parse(effect.ts) - REFLECTION_NOVELTY_WINDOW_MS).toISOString()))
        .filter((k) => k.kind === 'reflection' && k.createdAt < effect.ts)
        .map((k) => k.title);
      const repeated = repeatsRecent(insight.title, recentReflections);
      if (repeated !== null) {
        console.log(`[sundial-kernel] reflection not kept — repeats "${repeated}": "${insight.title}"`);
        return;
      }

      const entryId = createEventId();
      const inserted = await insertKnowledgeEntry({
        id: entryId,
        kind: 'reflection',
        title: insight.title,
        body: insight.body,
        severity: insight.severity,
        dedupeKey: effect.reason === 'endogenous' ? `reflection:endogenous:${effect.ts}` : `reflection:${effect.ts.slice(0, 10)}`,
        sourceEventId: null,
        createdAt: effect.ts,
        importanceScore: REFLECTION_IMPORTANCE_SCORE,
      });
      if (inserted) {
        const { vector, model } = await computeEmbedding(`${insight.title}. ${insight.body}`);
        await insertEmbedding({ id: createEventId(), refType: 'knowledge_entry', refId: entryId, model, vector, createdAt: effect.ts });
      }
    } catch (error) {
      console.error('[sundial-kernel] reflection LLM call failed:', error);
    }
  }

  /**
   * The closed half of propose-and-verify: backtest ONE pre-registered
   * conditioning variable against the forecaster's own recorded rows.
   *
   * Same dispatch/perform split as the LLM effects — the fold must not block
   * on a DB read — but with no model and no budget: the verdict is arithmetic
   * (`informationGain` + the MDL bar in `conditioners.ts`), and re-running it
   * recomputes the identical answer, which is what makes the effect safe
   * at-least-once.
   */
  private dispatchRunGoalTrial(effect: RunGoalTrialEffect): void {
    this.defer(() => void this.performGoalTrial(effect), 0);
  }

  private async performGoalTrial(effect: RunGoalTrialEffect): Promise<void> {
    try {
      const conditioner = conditionerById(effect.variable);
      if (conditioner === null) {
        console.warn(`[sundial-kernel] goal trial for unknown conditioner "${effect.variable}" — dropped`);
        return;
      }

      // The forecaster's own samples: one durable row per resolved bet, the
      // exact stream the live `hourlyDoneRate` counts came from. Using them
      // means the trial validates precisely what the forecaster would then
      // bet on — no proxy, no re-derivation from moments.
      const rows = await listResolvedPredictions({ kind: effect.predictionKind });
      const series = rows.filter((row) => row.forecaster === effect.forecaster && row.features !== null && String(row.features.hour) === effect.cell);

      // Host-local day, matching day-shape-forecast's own bucketing — the
      // comparability constants note in that file applies here too.
      const dayOf = (ts: string): string => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const prevDayOf = (date: string): string => {
        const [y, m, d] = date.split('-').map(Number);
        const prev = new Date(Date.UTC(y, m - 1, d - 1));
        return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
      };

      // Each day's last active hour, from the HIT rows across every cell of
      // this forecaster — the fact `prev-day-ran-late` conditions on.
      const endHourByDay = new Map<string, number>();
      for (const row of rows) {
        if (row.forecaster !== effect.forecaster || row.outcome !== 1 || row.features === null) continue;
        const hour = Number(row.features.hour);
        if (Number.isInteger(hour)) endHourByDay.set(dayOf(row.createdAt), hour);
      }

      const split: TrialSplit = { when: { n: 0, hits: 0 }, otherwise: { n: 0, hits: 0 }, unknown: 0 };
      for (const row of series) {
        const date = dayOf(row.createdAt);
        const value = conditioner.evaluate({ date, prevDayEndHour: endHourByDay.get(prevDayOf(date)) ?? null });
        if (value === null) {
          split.unknown += 1;
          continue;
        }
        const arm = value ? split.when : split.otherwise;
        arm.n += 1;
        arm.hits += row.outcome;
      }

      const gain = informationGain(split);
      const accepted = splitAccepted(split);
      console.log(
        `[sundial-kernel] goal trial ${effect.forecaster}:${effect.cell} on ${effect.variable}: when ${split.when.hits}/${split.when.n}, otherwise ${split.otherwise.hits}/${split.otherwise.n}, unknown ${split.unknown}, gain ${gain.toFixed(3)} nats → ${accepted ? 'ACCEPTED' : 'rejected'}`,
      );

      await this.retryIngestEvent(
        toDaemonEvent('goal:trial-result', {
          goalId: effect.goalId,
          cell: effect.cell,
          variable: effect.variable,
          accepted,
          gain: Math.round(gain * 10_000) / 10_000,
          arms: { when: split.when, otherwise: split.otherwise },
          unknown: split.unknown,
        }),
      );
    } catch (error) {
      console.error(`[sundial-kernel] goal trial failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async dispatchRunReflection(effect: RunReflectionEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose.reflect;
    if (budget.callsToday >= this.effectiveDailyCaps.reflect) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=reflect (${budget.callsToday}/${this.effectiveDailyCaps.reflect})`);
      return;
    }

    const [reflectMoments, reflectKnowledge] = await Promise.all([getMomentsSince(effect.since), getKnowledgeEntriesSince(effect.since)]);
    if (reflectMoments.length === 0 && reflectKnowledge.length === 0) return;

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'reflect' }));

    this.defer(() => void this.performReflectionCall(effect), 0);
  }

  private async performDailyJournalCall(effect: RunJournalEffect): Promise<void> {
    const aliases = this.state?.config.projectAliases ?? {};
    const ctx = await buildDailyContext(effect.date, { projectAliases: aliases, timeZone: this.state?.config.timezone ?? 'UTC' });
    if (ctx.coverage.trackedMin === 0) {
      await this.retryIngestEvent(toDaemonEvent('llm:refunded', { purpose: 'journal' }));
      return;
    }

    try {
      const result = await runToolLoop({
        purpose: 'journal',
        momentId: null,
        messages: buildJournalMessages(ctx),
        tools: gnomonToolDefinitions(),
        execute: (name, args) => executeGnomonTool(name, args),
        maxRounds: JOURNAL_MAX_ROUNDS,
        maxTokens: JOURNAL_MAX_TOKENS,
        requestTimeoutMs: JOURNAL_REQUEST_TIMEOUT_MS,
        deadlineMs: JOURNAL_DEADLINE_MS,
        validate: (content) => parseJournalResult(content) !== null,
        beforeCall: async (round) => {
          if (round === 1) return;
          const live = this.state?.budgets.byPurpose.journal;
          if (!live || live.callsToday >= this.effectiveDailyCaps.journal) throw new BudgetExhaustedError();
          await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'journal' }));
        },
      });

      const journal = parseJournalResult(result.content);
      if (!journal) {
        console.error('[sundial-kernel] daily journal reply was unparseable, skipping');
        return;
      }

      const { inserted } = await persistDailyJournal(effect.date, effect.ts, journal, effect.overwrite ?? false);
      if (inserted) this.change(['knowledge_entries']);
      // J3.5: the day's page into the vault the owner named — the sink half.
      // A file under `<vault>/Gnomon/`, overwritten on regenerate, nothing else touched.
      const vault = this.state?.config.vault;
      if (vault) {
        const dir = path.join(expandHomePath(vault), 'Gnomon');
        fs.mkdirSync(dir, { recursive: true });
        const page = `# ${effect.date}\n\n${journal.tldr}\n\n${assembleJournalMarkdown(journal)}\n\n---\n*Written by Gnomon from the day's record. The record, not this page, is the source.*\n`;
        fs.writeFileSync(path.join(dir, `${effect.date}.md`), page);
        console.log(`[sundial-kernel] journal page written to the vault: Gnomon/${effect.date}.md`);
      }
    } catch (error) {
      console.error('[sundial-kernel] daily journal LLM call failed:', error);
    }
  }

  /**
   * J5.3 — the week's plan for an ACTIVE goal, from the tier-3 text model
   * (purpose `goal`, a dozen a day). Strict JSON: at most five steps, each
   * internal (a job can do it with read tools and the shelf) or outward
   * (needs the owner). The fold does the rest (`goalPursuit`).
   */
  private async dispatchRunGoalPlan(effect: RunGoalPlanEffect): Promise<void> {
    if (!this.state || !isLlmConfigured()) return;
    const budget = this.state.budgets.byPurpose.goal;
    if (budget.callsToday >= this.effectiveDailyCaps.goal) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=goal (${budget.callsToday}/${this.effectiveDailyCaps.goal})`);
      return;
    }
    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'goal' }));
    this.defer(() => void this.performGoalPlan(effect), 0);
  }

  private async performGoalPlan(effect: RunGoalPlanEffect): Promise<void> {
    try {
      const recent = effect.progress.length > 0 ? await getMomentsByIds(effect.progress) : [];
      const evidence = recent.map((m) => `- ${m.startTime.slice(0, 16)} ${(m.data.intent as { text?: string } | undefined)?.text ?? m.processName}`).join('\n');
      const result = await runAuditedLlmCall({
        purpose: 'goal',
        momentId: null,
        maxTokens: 900,
        messages: [
          {
            role: 'system',
            content: withPersona(
              'You plan one week of work toward a goal the owner marked active.',
              'Respond with STRICT JSON only: {"steps":[{"text":"...","outward":false}]} — at most five steps. Each step is one concrete, checkable piece of work under two hours. "outward": true when the step needs the owner or reaches other people or services (sending, posting, buying, asking someone); false when a background agent with read-only tools over the owner\'s own record can do it and leave a written result. Internal steps are preferred; outward ones are put to the owner as proposals, never done for them. Order the steps so each can stand alone.',
            ),
          },
          { role: 'user', content: `GOAL: ${effect.goalName}\n\nRECENT SESSIONS CREDITED TO IT:\n${evidence || '(none yet)'}` },
        ],
      });
      const parsed = JSON.parse(result.content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')) as { steps?: unknown };
      if (!Array.isArray(parsed.steps)) throw new Error('no steps');
      await this.retryIngestEvent(toDaemonEvent('goal:planned', { goalId: effect.goalId, goalName: effect.goalName, steps: parsed.steps.slice(0, 5) }));
      console.log(`[sundial-kernel] goal plan for ${effect.goalId}: ${parsed.steps.length} step(s)`);
    } catch (error) {
      console.error('[sundial-kernel] goal plan failed:', error instanceof Error ? error.message : error);
      await this.retryIngestEvent(toDaemonEvent('llm:refunded', { purpose: 'goal' }));
    }
  }

  private async dispatchRunJournal(effect: RunJournalEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose.journal;
    if (budget.callsToday >= this.effectiveDailyCaps.journal) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=journal (${budget.callsToday}/${this.effectiveDailyCaps.journal})`);
      return;
    }

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'journal' }));

    this.defer(() => void this.performDailyJournalCall(effect), 0);
  }

  private async performProjectStatusCall(projectId: string, ts: string): Promise<void> {
    const aliases = this.state?.config.projectAliases ?? {};
    const ctx = await buildProjectStatusContext(projectId, { projectAliases: aliases });
    if (!ctx) {
      await this.retryIngestEvent(toDaemonEvent('llm:refunded', { purpose: 'journal' }));
      return;
    }

    try {
      const result = await runAuditedLlmCall({
        purpose: 'journal',
        momentId: null,
        messages: buildProjectStatusMessages(ctx),
        maxTokens: JOURNAL_MAX_TOKENS,
      });

      const status = parseJournalResult(result.content);
      if (!status) {
        console.error('[sundial-kernel] project-status reply was unparseable, skipping');
        return;
      }

      const { inserted } = await persistProjectStatus(projectId, ts, status, true);
      if (inserted) this.change(['knowledge_entries']);
    } catch (error) {
      console.error('[sundial-kernel] project-status LLM call failed:', error);
    }
  }

  /**
   * On-demand project status (was triggered by the daemon's HTTP API only —
   * no rule emits it). Kept public so a Phase 4 tool can trigger it.
   */
  async dispatchRunProjectStatus(projectId: string): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose.journal;
    if (budget.callsToday >= this.effectiveDailyCaps.journal) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=journal (${budget.callsToday}/${this.effectiveDailyCaps.journal})`);
      return;
    }

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'journal' }));

    this.defer(() => void this.performProjectStatusCall(projectId, new Date().toISOString()), 0);
  }

  private async performFactExtractionCall(effect: RunFactExtractionEffect): Promise<void> {
    const moments = await getMomentsSince(effect.since);
    if (moments.length === 0) return;

    const projects = await getAllProjects();
    const projectsById = new Map(projects.map((p) => [p.id, p.name] as const));
    const aliases = this.state?.config.projectAliases ?? {};

    const ownerAliases = this.state?.config.ownerAliases ?? [];
    const summaryLines = moments.slice(-FACT_EXTRACTION_MAX_MOMENTS).map((m) => {
      const windowTitles = (m.data.windowTitles as string[] | undefined)?.join(', ') ?? '';
      const attendees = meetingAttendeeEvidence(m.data.meetingAttendees, ownerAliases);
      const said = spokenEvidence(m.data.spokenExcerpt);
      return `- [${m.startTime}] (project: ${projectLabel(m.projectId, projectsById)}) ${m.processName}${windowTitles ? `: ${windowTitles}` : ''}${attendees}${said}`;
    });

    try {
      const result = await runAuditedLlmCall({
        purpose: 'extract',
        momentId: null,
        timeoutMs: FACT_EXTRACTION_TIMEOUT_MS,
        messages: [
          {
            role: 'system',
            content: withPersona(
              'You are extracting durable facts worth remembering from that record, into the temporal knowledge graph you keep about the owner. A fact you emit is never overwritten later, only superseded — so a wrong one costs three contradicting observations to unseat.',
              // `confidence` reaches the belief model as a prior. It was asked
              // for as a bare "1-100" with no scale, which invited the whole
              // range to sit at 80-95 regardless of how thin the evidence was,
              // and a decay-resistant posterior is exactly what a miscalibrated
              // prior is expensive in.
              'The "confidence" number is how sure you are, and it is used as a prior a later contradiction has to overcome — calibrate it. Above 80 means the log states this outright and repeatedly. 40-70 means it is a reasonable read of several lines. Below 40 means you are guessing, and a guess is better left out than recorded.',
              `Extract durable facts worth remembering from this personal activity log — topics worked on, tools adopted, collaborators. A "topic" is a SUBJECT the work was about (a feature, a system, a ticket, a document, a customer) — never an activity class such as email, chat, browsing, terminal, coding, notes, meetings, or the name of an app; those are how the work was done, and are already recorded elsewhere. Each line is tagged with the project it actually happened in ("project: ..."); NEVER combine evidence from lines tagged with different projects into one fact, and lines tagged "unattributed" have no reliable project — never invent one for a fact drawn only from those. For every "topic" or "tool" fact, also emit a paired fact with the SAME canonicalName, predicate "relatesToProject", and object set to the exact project tag (copied verbatim, never guessed) the evidence came from. Respond with STRICT JSON only, no markdown fencing: a JSON array of up to ${MAX_EXTRACTED_FACTS_PER_PASS} objects, each matching exactly {"entityKind": "person"|"project"|"tool"|"topic", "canonicalName": "...", "predicate": "...", "object": "...", "confidence": 1-100}. Use these predicate names where they fit — usesTool, worksOn, relatesToProject, collaboratesOn, deployedVia — rather than inventing a synonym, so the same relation stays one predicate across days. A line ending "— with: A, B" lists the people present for that activity: use those names verbatim as the canonicalName of a "person" fact with predicate "collaboratesOn" and the line's project tag as the object, and never invent a person who is not named that way. A line ending '— said: "..."' is speech heard in the room while that activity was open, transcribed by a machine from mixed Dutch and English — it is the best evidence of WHAT the work was about, and the worst evidence of exact wording. Read it for subjects, tools and decisions; never copy a name out of it verbatim as a canonicalName unless that same name also appears in a window title or a "with:" clause, because transcribed proper nouns are frequently wrong. Cap the confidence of any fact whose only evidence is a "said:" clause at 60, and never emit a "person" fact from speech alone. Only include facts with real, repeated evidence in the log below, not one-off mentions. Respond with an empty array [] if nothing is worth recording.`,
            ),
          },
          { role: 'user', content: summaryLines.join('\n') },
        ],
      });

      const candidates = parseExtractedFactCandidates(result.content);

      const projectIdByEntity = new Map<string, string>();
      const resolvedProjectIds = candidates.map((candidate) => {
        if (candidate.predicate !== 'relatesToProject') return null;
        const resolved = resolveProjectIdByName(candidate.object, projectsById, aliases);
        const entityId = `${candidate.entityKind}:${slugifyEntityName(candidate.canonicalName)}`;
        if (resolved && !projectIdByEntity.has(entityId)) projectIdByEntity.set(entityId, resolved);
        return resolved;
      });

      for (const [index, candidate] of candidates.entries()) {
        const eventId = createEventId();
        const entityId = `${candidate.entityKind}:${slugifyEntityName(candidate.canonicalName)}`;
        const projectId = candidate.predicate === 'relatesToProject' ? resolvedProjectIds[index] : projectIdByEntity.get(entityId) ?? null;
        await this.retryIngestEvent({
          id: eventId,
          type: 'entity:fact-candidate',
          ts: effect.ts,
          payload: {
            entityId,
            entityKind: candidate.entityKind,
            canonicalName: candidate.canonicalName,
            predicate: candidate.predicate,
            object: candidate.object,
            confidence: candidate.confidence,
            sourceEventId: eventId,
            projectId,
            provenance: 'inference',
          },
        });
      }
    } catch (error) {
      console.error('[sundial-kernel] fact extraction LLM call failed:', error);
    }
  }

  /**
   * Name the hashed calendar attendees from addresses already on this machine.
   *
   * The one place the resolution's I/O may happen: `identity-resolve` decides
   * which aliases and when, and a rule may not read the filesystem. Each match
   * re-enters as an ordinary `entity:fact-candidate`, so it travels the same
   * path a sensor's observation does and `contradictionCheck` governs it — this
   * method has no privileged write into core memory.
   *
   * `provenance: 'inference'` at `confidence: 100`. A hash match is proof, so
   * the confidence is not a hedge; `assertion` was the wrong label because that
   * means the OWNER said it, and this deliberately never asks them. The address
   * that produced the match is not carried on the event — only the name.
   *
   * Never throws into the fold: a resolver is an optimisation over asking, so a
   * failure must leave the alias unnamed for the next sweep rather than break
   * the tick that scheduled it.
   */
  private async dispatchResolveAliases(effect: ResolveAliasesEffect): Promise<void> {
    let resolved: ResolvedAlias[] = [];
    try {
      resolved = await resolveAliases();
    } catch (error) {
      console.warn('[sundial-kernel] alias resolution failed:', error);
      return;
    }
    if (resolved.length === 0) return;

    console.log(`[sundial-kernel] named ${resolved.length} hashed attendee(s) from local address sources`);
    for (const { alias, name } of resolved) {
      await this.ingestAndApply(
        toDaemonEvent(
          'entity:fact-candidate',
          {
            entityId: `person:${alias}`,
            entityKind: 'person',
            canonicalName: alias,
            predicate: 'knownAs',
            object: name,
            confidence: 100,
            provenance: 'inference',
            projectId: null,
          },
          effect.ts,
        ),
      );
    }
  }

  private async dispatchRunFactExtraction(effect: RunFactExtractionEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose.extract;
    if (budget.callsToday >= this.effectiveDailyCaps.extract) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=extract (${budget.callsToday}/${this.effectiveDailyCaps.extract})`);
      return;
    }

    const extractMoments = await getMomentsSince(effect.since);
    if (extractMoments.length === 0) return;

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'extract' }));

    this.defer(() => void this.performFactExtractionCall(effect), 0);
  }

  /**
   * The owner's chat turns → `entity:fact-candidate` with `provenance:
   * 'conversation'`. Owner turns only, redacted with the ingest policy before
   * they reach the model, and the transcript itself never lands in the log —
   * see `conversation-extract.ts` for the invariant and its reasons.
   */
  private async performConversationExtractionCall(effect: RunConversationExtractionEffect): Promise<void> {
    if (!this.conversationSource) return;
    const ownerAliases = this.state?.config.ownerAliases ?? [];
    const ownerName = ownerAliases[0];
    if (!ownerName) {
      console.warn('[sundial-kernel] conversation extraction skipped: no ownerAliases configured, so nothing can be filed under the owner');
      return;
    }

    const turns = (await this.conversationSource.readOwnerTurnsSince(effect.since)).map((turn) => ({ ...turn, text: redactWithPolicy(turn.text, 'egress') }));
    if (turns.length === 0) return;
    const transcript = formatTranscript(turns);
    if (transcript.trim() === '') return;

    try {
      const result = await runAuditedLlmCall({
        purpose: 'extract',
        momentId: null,
        messages: [
          { role: 'system', content: withPersona(conversationExtractionInstructions(ownerName)) },
          { role: 'user', content: transcript },
        ],
      });

      const candidates = parseExtractedFactCandidates(result.content);
      for (const raw of candidates) {
        const candidate = canonicalizeConversationCandidate(raw, ownerAliases);
        if (candidate === null) continue;
        const eventId = createEventId();
        const entityId = `${candidate.entityKind}:${slugifyEntityName(candidate.canonicalName)}`;
        await this.retryIngestEvent({
          id: eventId,
          type: 'entity:fact-candidate',
          ts: effect.ts,
          payload: {
            entityId,
            entityKind: candidate.entityKind,
            canonicalName: candidate.canonicalName,
            predicate: candidate.predicate,
            object: candidate.object,
            confidence: candidate.confidence,
            sourceEventId: eventId,
            projectId: null,
            provenance: 'conversation',
          },
        });
      }
      console.log(`[sundial-kernel] conversation extraction: ${turns.length} owner turn(s) since ${effect.since} → ${candidates.length} candidate(s)`);
    } catch (error) {
      console.error('[sundial-kernel] conversation extraction LLM call failed:', error);
    }
  }

  private async dispatchRunConversationExtraction(effect: RunConversationExtractionEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;
    if (!this.conversationSource) return;

    // Shares the `extract` purpose and its cap with the nightly moment pass:
    // one more call a night, same family of work, no five-place purpose plumbing.
    const budget = this.state.budgets.byPurpose.extract;
    if (budget.callsToday >= this.effectiveDailyCaps.extract) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=extract (${budget.callsToday}/${this.effectiveDailyCaps.extract}); conversation pass skipped`);
      return;
    }

    const turns = await this.conversationSource.readOwnerTurnsSince(effect.since);
    if (turns.length === 0) return;

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'extract', source: 'conversation' }));
    this.defer(() => void this.performConversationExtractionCall(effect), 0);
  }

  private async performRefutationCall(effect: RunRefutationEffect): Promise<void> {
    const facts = await getFactsForRefutation(effect.sampleSize);
    if (facts.length === 0) return;

    const numbered = facts
      .map(
        (f) =>
          `- factId=${f.id} :: "${f.canonicalName}" (${f.entityKind}) ${f.predicate} "${f.object}"  [confidence ${f.confidence}, first recorded ${f.validFrom.slice(0, 10)}]`,
      )
      .join('\n');

    try {
      const result = await runAuditedLlmCall({
        purpose: 'refute',
        momentId: null,
        messages: [
          {
            role: 'system',
            content: withPersona(
              'You are auditing your OWN knowledge base for beliefs that are WRONG. Each line below is a fact you currently believe about the owner, with the confidence you hold it at and when it was first recorded. You wrote all of them; none is a third party to defend or to distrust.',
              'For each one, decide whether it is actually false — not merely old, not merely uninteresting, not merely imprecise.',
              'LEAVING A FACT ALONE IS THE NORMAL ANSWER. Most of these are correct, and a wrong refutation damages the knowledge base more than a missed one, because it removes something true. Only refute when the fact is self-contradictory, internally impossible, or obviously a parsing artifact (a file path, a UI label, a placeholder, a fragment of a window title mistaken for a name).',
              'You are judging each line on its own text alone. You cannot see the activity it came from, so "I have no evidence for this" is not grounds to refute it — absence here is your blindness, not the fact being false.',
              'Respond with STRICT JSON only, no markdown fencing: an array of objects {"factId": "...", "refuted": true, "correctedObject": "...", "reason": "..."}. Include ONLY facts you are refuting; omit everything you are leaving alone. Use the factId verbatim from the line — never invent one. Set "correctedObject" only when the evidence supports a specific different value; leave it out when the fact is simply not true. Respond with [] if none of them should be refuted.',
            ),
          },
          { role: 'user', content: numbered },
        ],
      });

      const verdicts = parseRefutationVerdicts(result.content, new Set(facts.map((f) => f.id)));
      if (verdicts.length === 0) return;

      const byId = new Map(facts.map((f) => [f.id, f] as const));
      for (const verdict of verdicts) {
        const fact = byId.get(verdict.factId);
        if (!fact) continue;
        await this.retryIngestEvent({
          id: createEventId(),
          type: 'entity:fact-candidate',
          ts: effect.ts,
          payload: {
            entityId: fact.entityId,
            entityKind: fact.entityKind,
            canonicalName: fact.canonicalName,
            predicate: fact.predicate,
            object: verdict.correctedObject ?? `(refuted) ${fact.object}`,
            confidence: 55,
            sourceEventId: null,
            projectId: null,
            provenance: 'assistant',
          },
        });
        console.log(`[sundial-kernel] refute: proposed against ${fact.entityId}.${fact.predicate}="${fact.object}"${verdict.reason ? ` (${verdict.reason})` : ''}`);
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError || error instanceof LlmHttpError) {
        console.warn('[sundial-kernel] refutation pass failed:', error.message);
        return;
      }
      console.error('[sundial-kernel] refutation pass failed:', error);
    }
  }

  /**
   * H4 — the DB read a pure rule cannot do: which answer is next, and whether
   * there are any left.
   *
   * It calls no model. It appends `ask:harvest-due` carrying the row it found,
   * and `askHarvest` builds the one prompt both doors share — so the sweep and
   * the live path cannot drift into asking different questions. When there is
   * nothing left it appends `ask:harvest-drained`, which is what ends the
   * sweep; `askHarvestBackfill` folds it into `backfillDone`.
   */
  private async dispatchRunAskHarvestBackfill(): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    // Checked here rather than in the rule for the same reason
    // `dispatchRunConversationExtraction` checks it here: a pure rule cannot
    // see a budget the executor spends. The sweep simply waits an hour.
    const budget = this.state.budgets.byPurpose.extract;
    if (budget.callsToday >= this.effectiveDailyCaps.extract) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=extract (${budget.callsToday}/${this.effectiveDailyCaps.extract}); ask harvest backfill skipped`);
      return;
    }

    const next = await getOldestUnharvestedOwnerAsk();
    if (next === null || next.answer === null) {
      await this.ingestAndApply(toDaemonEvent(ASK_HARVEST_DRAINED, {}));
      console.log('[sundial-kernel] ask harvest backfill: nothing left to read');
      return;
    }

    await this.ingestAndApply(toDaemonEvent(ASK_HARVEST_DUE, { askId: next.id, question: next.question, answer: next.answer }));
  }

  private async dispatchRunRefutation(effect: RunRefutationEffect): Promise<void> {
    if (!this.state) return;
    if (!isLlmConfigured()) return;

    const budget = this.state.budgets.byPurpose.refute;
    if (budget.callsToday >= this.effectiveDailyCaps.refute) {
      console.warn(`[sundial-kernel] LLM budget exhausted for purpose=refute (${budget.callsToday}/${this.effectiveDailyCaps.refute})`);
      return;
    }

    const candidates = await getFactsForRefutation(effect.sampleSize);
    if (candidates.length === 0) return;

    await this.ingestAndApply(toDaemonEvent('llm:dispatched', { purpose: 'refute' }));

    this.defer(() => void this.performRefutationCall(effect), 0);
  }
}
