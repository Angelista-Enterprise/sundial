import { eq, desc, gte, inArray } from 'drizzle-orm';
import { getDb } from '../db-client.js';
import { llmAudit, moments } from '../schemas/db-schema.js';
import { localDate } from '@sundial/helpers/local-day.js';
import { classifyStoredLlmError, redactSecrets, type LlmErrorClass } from '@sundial/helpers/llm-error-class.js';

export interface RecordLlmAuditInput {
  id: string;
  momentId: string | null;
  purpose: string;
  model: string;
  prompt: string;
  requestedAt: string;
  /** 1 for a first try. A retry passes the try number and the id of the attempt it replaces, so a lost answer can be told from a recovered one. */
  attempt?: number;
  parentCallId?: string | null;
}

export interface UpdateLlmAuditInput {
  respondedAt: string;
  latencyMs: number;
  statusCode?: number;
  success: boolean;
  responseContent?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  error?: string;
  /** One of `LLM_ERROR_CLASSES`, decided by the caller from the error object it caught. Never derived here. */
  errorClass?: LlmErrorClass;
  /** Estimated prompt tokens uploaded on a call that died — see `estimateBilledPromptTokens`. Set on failure only. */
  billedPromptTokens?: number;
  /** The part of `promptTokens` served from the provider's prefix cache. A SUBSET of it, never an addition. */
  cacheReadTokens?: number;
}

/**
 * Record-then-patch (docs/design/03-effects-and-llm-policy.md): a placeholder
 * row is written before the network call so a crash mid-call still leaves an
 * audit trail (`success: false`, no response fields) instead of silently
 * losing the attempt.
 */
export async function recordLlmAudit(input: RecordLlmAuditInput): Promise<void> {
  const db = getDb();
  await db.insert(llmAudit).values({
    id: input.id,
    momentId: input.momentId,
    purpose: input.purpose,
    model: input.model,
    prompt: input.prompt,
    requestedAt: input.requestedAt,
    success: false,
    attempt: input.attempt ?? 1,
    parentCallId: input.parentCallId ?? null,
  });
}

export async function updateLlmAudit(id: string, patch: UpdateLlmAuditInput): Promise<void> {
  const db = getDb();
  await db
    .update(llmAudit)
    .set({
      respondedAt: patch.respondedAt,
      latencyMs: patch.latencyMs,
      statusCode: patch.statusCode ?? null,
      success: patch.success,
      responseContent: patch.responseContent ?? null,
      promptTokens: patch.promptTokens ?? null,
      completionTokens: patch.completionTokens ?? null,
      totalTokens: patch.totalTokens ?? null,
      // The one write path to the column, so the guard belongs here rather than
      // in each caller: an error message routinely names the endpoint it was
      // talking to, and an endpoint can carry a key.
      error: patch.error ? redactSecrets(patch.error) : null,
      errorClass: patch.errorClass ?? null,
      billedPromptTokens: patch.billedPromptTokens ?? null,
      cacheReadTokens: patch.cacheReadTokens ?? null,
    })
    .where(eq(llmAudit.id, id));
}

export interface LlmAuditSummary {
  id: string;
  momentId: string | null;
  purpose: string;
  model: string;
  requestedAt: string;
  respondedAt: string | null;
  latencyMs: number | null;
  statusCode: number | null;
  success: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  error: string | null;
  errorClass: string | null;
  attempt: number;
  parentCallId: string | null;
}

export interface StoredLlmAudit extends LlmAuditSummary {
  prompt: string;
  responseContent: string | null;
}

/**
 * The Observability "LLM calls" tab's list query (docs/design/06-macos-ui-data-wiring.md)
 * — didn't exist before this. Deliberately excludes `prompt`/`responseContent`:
 * those are the heaviest, and only privacy-sensitive, columns in the whole
 * schema (full call text). `getLlmAuditById` below fetches a single row's
 * bodies on demand, so a list of N calls never pulls N full prompt/response
 * pairs over the wire just to render a table.
 */
export async function getRecentLlmAudit(limit = 20, offset = 0): Promise<LlmAuditSummary[]> {
  const db = getDb();
  return db
    .select({
      id: llmAudit.id,
      momentId: llmAudit.momentId,
      purpose: llmAudit.purpose,
      model: llmAudit.model,
      requestedAt: llmAudit.requestedAt,
      respondedAt: llmAudit.respondedAt,
      latencyMs: llmAudit.latencyMs,
      statusCode: llmAudit.statusCode,
      success: llmAudit.success,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      totalTokens: llmAudit.totalTokens,
      error: llmAudit.error,
      errorClass: llmAudit.errorClass,
      attempt: llmAudit.attempt,
      parentCallId: llmAudit.parentCallId,
    })
    .from(llmAudit)
    .orderBy(desc(llmAudit.requestedAt))
    .limit(limit)
    .offset(offset);
}

export interface LlmAuditOverviewSummary {
  calls: number;
  failedCount: number;
  /** 0..1; `1` when there are no calls (nothing has failed). */
  successRate: number;
  /** Mean over calls that recorded a latency (skips timeouts with no `respondedAt`). */
  avgLatencyMs: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  /** Estimated USD cost from token usage × the model's rate (see `LLM_PRICING`). An estimate — local calls are $0, remote ones are priced at list price. */
  estimatedCostUsd: number;
  /** Calls served by a hosted provider (vendor-namespaced model id) — the only ones that can cost money. */
  remoteCalls: number;
  /** Calls served on-device by Ollama. Always $0, however large the token count. */
  localCalls: number;
  /** Tokens through remote models, prompt + completion. The number the spend is computed from. */
  remoteTokens: number;
  /** Tokens through local models. Free, and kept separate so a big local run can't read as spend. */
  localTokens: number;
  /** Estimated prompt tokens uploaded on calls that failed. Never part of `totalTokens` — one is measured, the other is not. */
  billedOnFailureTokens: number;
  /** What those uploads cost at the failed call's own model rate. The floor under "wasted money"; retry duplication is on top of it. */
  billedOnFailureUsd: number;
  /**
   * Spend on calls that only happened because an earlier one failed
   * (`attempt > 1`) — the same question asked and paid for twice. Zero before
   * L1, since nothing recorded which rows were retries.
   */
  retrySpendUsd: number;
  /** Wall clock spent inside calls that failed. Time the owner waited for nothing. */
  failedMs: number;
  /** When the most recent failure was requested — the answer to "is it failing NOW or did it fail on Tuesday". Null if nothing failed in the window. */
  lastFailureAt: string | null;
  /**
   * Stored error strings that are NOT already equal to their own redacted form
   * — i.e. rows still holding a credential in a URL. The healthy value is 0.
   *
   * This exists because of how the previous change went wrong. Classifying
   * failures by `errorClass` stopped the raw message being shown anywhere, and
   * a message nobody reads is not a message nobody stores: a key that leaked
   * into this column after the write-path guard (a new caller, a caller that
   * writes the row itself) would sit there permanently with nothing to surface
   * it. The invariant is checked against `redactUrlCredentials` rather than
   * against a second list of secret-looking parameter names, so the guard and
   * the detector can never disagree about what counts as a credential.
   */
  unredactedErrorCount: number;
}

export interface LlmAuditPurposeStat {
  purpose: string;
  calls: number;
  failedCount: number;
  avgLatencyMs: number;
  /**
   * The median and the slow tail, beside the mean.
   *
   * `companion` reads 323s average on the live record, which describes no call
   * that was ever made: a handful of minutes-long tool loops drag the mean
   * somewhere between the ordinary call and the worst one. p50 says what a call
   * is like; p95 says what the bad ones are like. The mean stays because
   * removing a number a reader has learned to look for is its own confusion.
   */
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface LlmAuditLatencyBucket {
  label: string;
  count: number;
}

/**
 * One of the nine `LLM_ERROR_CLASSES` + how many calls hit it. These sum to
 * `failedCount` for the same window, by construction: every failed row has a
 * class, either its own or the legacy one derived from its message.
 */
export interface LlmAuditFailureReason {
  reason: string;
  count: number;
}

export interface LlmAuditOverview {
  summary: LlmAuditOverviewSummary;
  byPurpose: LlmAuditPurposeStat[];
  latencyHistogram: LlmAuditLatencyBucket[];
  failureReasons: LlmAuditFailureReason[];
  /**
   * Remote models with no `LLM_PRICING` entry, with their token volume — the
   * cost estimate under-reports by whatever these actually cost. Empty is the
   * healthy state. Surfaced rather than swallowed because a missing price and a
   * free model both contribute $0, and only one of those is true.
   */
  unpricedRemoteModels: { model: string; totalTokens: number }[];
}

/** Where a call was served from. `local` never costs anything; `remote` is billed per token. */
export type LlmProvider = 'local' | 'remote';

/**
 * Provider of a recorded call, inferred from the model string's SHAPE rather
 * than from a stored column (`llm_audit` has no provider field, and adding one
 * would leave every pre-existing row unclassified).
 *
 * The shapes are unambiguous in practice: a hosted TensorX model is always
 * vendor-namespaced (`qwen/qwen3.8-27b`, `deepseek/deepseek-v4-flash-0731`,
 * `moonshotai/kimi-k3`), and an Ollama tag never is (`qwen3.8:27b-mlx`,
 * `gemma4:26b-mlx`, `qwen3.8-gnomon:latest`). This matters for cost: before it,
 * a free local `qwen3.8:27b-mlx` call substring-matched a paid `qwen` price
 * entry and was billed as if TensorX had served it.
 *
 * A hosted API that names its models bare (`gpt-5`, `deepseek-chat`) would
 * break the shape, so the writers namespace such an id by its route before it
 * is recorded (`ledgerModel` in @sundial/helpers/llm-providers): `openai/gpt-5`.
 * Rows written before that stay as they were.
 */
export function llmProvider(model: string | null): LlmProvider {
  return model?.includes('/') ? 'remote' : 'local';
}

/**
 * Per-1M-token list prices by model-name substring, for REMOTE models only —
 * `llmProvider` sends every local (Ollama) call to $0 before this table is
 * consulted, so no local tag can ever match a paid entry. First match wins, so
 * exact snapshot ids must precede shorter family prefixes. An unmatched remote
 * model contributes 0 and is reported in `unpricedRemoteModels` instead of
 * silently reading as free.
 *
 * Exported so every cost readout (the overview aggregation here, the per-day
 * buckets in `getLlmAuditDaily`, the per-model rollup in `getLlmAuditByModel`)
 * prices tokens through the ONE table — a second pricing list would drift the
 * moment either changed.
 */
export const LLM_PRICING: { match: string; inputPer1M: number; outputPer1M: number; cacheReadPer1M?: number }[] = [
  // TensorX list price for the pinned snapshot Gnomon now runs on. The bare
  // `deepseek` entry below is left at the old rate so audit rows recorded
  // before the switch keep the price they were charged at — and without a
  // `cacheReadPer1M`, so those old rows keep being priced exactly as they were.
  { match: 'deepseek-v4-flash-0731', inputPer1M: 0.25, outputPer1M: 0.3, cacheReadPer1M: 0.06 },
  { match: 'deepseek', inputPer1M: 0.27, outputPer1M: 1.1 },
  // TensorX list price for the model the dsh harness chat runs on. Matched on the
  // exact snapshot rather than a bare `qwen`: the other hosted qwen routes
  // (qwen/qwen3.8-27b, qwen/qwen3.5-122b-a10b, qwen/qwen3.5-9b,
  // qwen/qwen3-embedding-8b) are priced differently, and first-match-wins would
  // quietly charge all of them this rate. Until their rates are filled in here
  // they surface in `unpricedRemoteModels`, so their absence is visible in the
  // ledger instead of reading as free.
  // qwen/qwen3.8-flash-next: the default for chat and every kernel purpose but
  // `intent` since 2026-09-06. List price from app.tensorx.ai on 2026-09-07.
  { match: 'qwen3.8-flash-next', inputPer1M: 0.2, outputPer1M: 0.5, cacheReadPer1M: 0.05 },
  { match: 'qwen3.8-2.4t-a95b', inputPer1M: 2.5, outputPer1M: 6, cacheReadPer1M: 0.63 },
  // Priced ahead of use: nothing routes to kimi yet (one `SUNDIAL_LLM_MODEL`, no per-purpose
  // routing), so this only takes effect if the configured model is switched to it.
  { match: 'kimi-k3', inputPer1M: 3, outputPer1M: 15 },
  // TypeSafe's System One (Jev), recorded as `typesafe/jev-latest` by
  // `runAuditedJudgement` — the `/` is what makes it remote here; a bare
  // `jev-latest` would price as a free local tag. $42 per 1e9 input tokens,
  // output free (docs.typesafe.ai/models, 2026-09-21).
  { match: 'typesafe/', inputPer1M: 0.042, outputPer1M: 0 },
  { match: 'claude-opus', inputPer1M: 15, outputPer1M: 75, cacheReadPer1M: 1.5 },
  { match: 'claude-sonnet', inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3 },
  { match: 'claude-haiku', inputPer1M: 0.8, outputPer1M: 4, cacheReadPer1M: 0.08 },
  { match: 'gpt', inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 0.625 },
];

/**
 * What one call cost, at list price.
 *
 * `promptTokens` is the WHOLE billed input and `cacheReadTokens` is the part of
 * it the provider served from its prefix cache — a subset, never an addition,
 * so the fresh half is the subtraction. Passing the cache read is what stops a
 * long chat overstating its input cost by 2.79x: on the live record 85.5% of chat
 * input was cached, and the cached tier is a twentieth of the input tier.
 *
 * A model with no `cacheReadPer1M` prices its whole prompt at the input rate,
 * which is exactly what every caller did before this argument existed — so a
 * row from before the column, or a model whose cache tier is not filled in, is
 * estimated high rather than silently cheap.
 */
export function estimateCostUsd(model: string | null, promptTokens: number, completionTokens: number, cacheReadTokens = 0): number {
  if (llmProvider(model) === 'local') return 0;
  const rate = model ? LLM_PRICING.find((p) => model.toLowerCase().includes(p.match)) : undefined;
  if (!rate) return 0;
  // Clamped: a provider that reports more cached than billed input must not
  // turn into a negative fresh count and a discount.
  const cached = rate.cacheReadPer1M === undefined ? 0 : Math.max(0, Math.min(cacheReadTokens, promptTokens));
  const fresh = promptTokens - cached;
  return (
    (fresh / 1_000_000) * rate.inputPer1M +
    (cached / 1_000_000) * (rate.cacheReadPer1M ?? rate.inputPer1M) +
    (completionTokens / 1_000_000) * rate.outputPer1M
  );
}

/** True for a remote model with no `LLM_PRICING` entry — billed in reality, $0 in the estimate. */
function isUnpricedRemote(model: string | null): boolean {
  if (llmProvider(model) === 'local') return false;
  return !LLM_PRICING.some((p) => model!.toLowerCase().includes(p.match));
}

/**
 * The class a failed row is counted under.
 *
 * The stored class when there is one; `classifyStoredLlmError` only for rows
 * written before the column existed. What this replaced returned the first 48
 * characters of the message when nothing matched, which is how 68 of 294
 * failures came to report an endpoint URL as their "reason" — a value that
 * cannot be grouped, and that leaked the URL into every readout of the ledger.
 */
function failureClass(row: { errorClass: string | null; error: string | null }): string {
  return row.errorClass ?? classifyStoredLlmError(row.error);
}

/** Nearest-rank percentile over an unsorted sample. 0 for an empty one, same as the mean beside it. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

/** Fixed latency bands, mirroring WCS's histogram — order matters (the UI renders them left-to-right). */
const LATENCY_BUCKETS: { label: string; max: number }[] = [
  { label: '<100ms', max: 100 },
  { label: '100–500ms', max: 500 },
  { label: '0.5–2s', max: 2000 },
  { label: '2–10s', max: 10_000 },
  { label: '10s+', max: Infinity },
];

/**
 * Aggregates the `llm_audit` table for the Observability LLM tab's summary
 * tiles + graphs — token totals, success rate, mean latency, per-purpose
 * breakdown, and a latency histogram. `/llm-audit` (the list) deliberately
 * returns rows only; the UI shouldn't have to sum N pages client-side to show
 * "11.2k tokens today". Aggregates in JS over a single narrow projection (the
 * table is budget- and retention-bounded, so the row count is small).
 * `sinceIso` (optional) scopes to calls at/after an ISO timestamp; omitted =
 * all rows.
 */
export async function getLlmAuditOverview(sinceIso?: string): Promise<LlmAuditOverview> {
  const db = getDb();
  const base = db
    .select({
      purpose: llmAudit.purpose,
      model: llmAudit.model,
      requestedAt: llmAudit.requestedAt,
      attempt: llmAudit.attempt,
      latencyMs: llmAudit.latencyMs,
      totalTokens: llmAudit.totalTokens,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      success: llmAudit.success,
      error: llmAudit.error,
      errorClass: llmAudit.errorClass,
      billedPromptTokens: llmAudit.billedPromptTokens,
      cacheReadTokens: llmAudit.cacheReadTokens,
    })
    .from(llmAudit);
  const rows = await (sinceIso ? base.where(gte(llmAudit.requestedAt, sinceIso)) : base);

  const perPurpose = new Map<string, { calls: number; failedCount: number; latencySum: number; latencies: number[]; totalTokens: number; cost: number }>();
  const failures = new Map<string, number>();
  const unpriced = new Map<string, number>();
  const histogram = LATENCY_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
  let remoteCalls = 0;
  let localCalls = 0;
  let remoteTokens = 0;
  let localTokens = 0;
  let calls = 0;
  let failedCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCostUsd = 0;
  let billedOnFailureTokens = 0;
  let billedOnFailureUsd = 0;
  let retrySpendUsd = 0;
  let failedMs = 0;
  let lastFailureAt: string | null = null;
  let unredactedErrorCount = 0;

  for (const row of rows) {
    calls += 1;
    if (!row.success) {
      failedCount += 1;
      const reason = failureClass(row);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
      // Priced as input only: the upload is what the provider received.
      const billed = row.billedPromptTokens ?? 0;
      billedOnFailureTokens += billed;
      billedOnFailureUsd += estimateCostUsd(row.model, billed, 0);
      failedMs += row.latencyMs ?? 0;
      if (lastFailureAt === null || row.requestedAt > lastFailureAt) lastFailureAt = row.requestedAt;
      if (row.error && redactSecrets(row.error) !== row.error) unredactedErrorCount += 1;
    }
    // A retry is a question asked twice. Its whole cost is duplicate spend,
    // whether or not this try is the one that finally answered.
    if ((row.attempt ?? 1) > 1)
      retrySpendUsd += estimateCostUsd(row.model, (row.promptTokens ?? 0) + (row.billedPromptTokens ?? 0), row.completionTokens ?? 0, row.cacheReadTokens ?? 0);
    if (row.latencyMs != null) {
      latencySum += row.latencyMs;
      latencyCount += 1;
      const bucket = histogram[LATENCY_BUCKETS.findIndex((b) => row.latencyMs! < b.max)];
      if (bucket) bucket.count += 1;
    }
    const rowPrompt = row.promptTokens ?? 0;
    const rowCompletion = row.completionTokens ?? 0;
    const rowCost = estimateCostUsd(row.model, rowPrompt, rowCompletion, row.cacheReadTokens ?? 0);
    const rowTokens = row.totalTokens ?? 0;
    if (llmProvider(row.model) === 'remote') {
      remoteCalls += 1;
      remoteTokens += rowTokens;
      if (isUnpricedRemote(row.model)) unpriced.set(row.model, (unpriced.get(row.model) ?? 0) + rowTokens);
    } else {
      localCalls += 1;
      localTokens += rowTokens;
    }
    totalTokens += row.totalTokens ?? 0;
    promptTokens += rowPrompt;
    completionTokens += rowCompletion;
    estimatedCostUsd += rowCost;

    const agg = perPurpose.get(row.purpose) ?? { calls: 0, failedCount: 0, latencySum: 0, latencies: [], totalTokens: 0, cost: 0 };
    agg.calls += 1;
    if (!row.success) agg.failedCount += 1;
    if (row.latencyMs != null) {
      agg.latencySum += row.latencyMs;
      agg.latencies.push(row.latencyMs);
    }
    agg.totalTokens += row.totalTokens ?? 0;
    agg.cost += rowCost;
    perPurpose.set(row.purpose, agg);
  }

  const byPurpose: LlmAuditPurposeStat[] = [...perPurpose.entries()]
    .map(([purpose, a]) => ({
      purpose,
      calls: a.calls,
      failedCount: a.failedCount,
      avgLatencyMs: a.latencies.length > 0 ? Math.round(a.latencySum / a.latencies.length) : 0,
      p50LatencyMs: percentile(a.latencies, 0.5),
      p95LatencyMs: percentile(a.latencies, 0.95),
      totalTokens: a.totalTokens,
      estimatedCostUsd: a.cost,
    }))
    .sort((a, b) => b.calls - a.calls);

  const failureReasons: LlmAuditFailureReason[] = [...failures.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    summary: {
      calls,
      failedCount,
      successRate: calls > 0 ? (calls - failedCount) / calls : 1,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0,
      totalTokens,
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      remoteCalls,
      localCalls,
      remoteTokens,
      localTokens,
      billedOnFailureTokens,
      billedOnFailureUsd,
      retrySpendUsd,
      failedMs,
      lastFailureAt,
      unredactedErrorCount,
    },
    byPurpose,
    latencyHistogram: histogram,
    failureReasons,
    unpricedRemoteModels: [...unpriced.entries()]
      .map(([model, totalTokens]) => ({ model, totalTokens }))
      .sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

export interface LlmAuditDailyPoint {
  /** Owner-local calendar day (`YYYY-MM-DD`) — never a UTC slice of the instant. */
  date: string;
  calls: number;
  failedCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

/**
 * Per-owner-local-day rollup of `llm_audit` for the Observability trend graph.
 * Buckets in JS over one narrow projection (same reasoning as
 * `getLlmAuditOverview`: the table is retention-bounded, so the scan is small).
 * Days are `localDate(requestedAt, timeZone)` — an Amsterdam late-night call
 * lands on the owner's day, not UTC's (see `@sundial/helpers/local-day`). Days
 * with zero calls are ABSENT, not zero rows: an empty day and an unlogged day
 * are the same here, and the caller draws gaps rather than false zeros.
 * Returned in ascending date order. `sinceIso` (optional) scopes the scan.
 */
export async function getLlmAuditDaily(timeZone: string, sinceIso?: string): Promise<LlmAuditDailyPoint[]> {
  const db = getDb();
  const base = db
    .select({
      requestedAt: llmAudit.requestedAt,
      model: llmAudit.model,
      success: llmAudit.success,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      totalTokens: llmAudit.totalTokens,
      cacheReadTokens: llmAudit.cacheReadTokens,
    })
    .from(llmAudit);
  const rows = await (sinceIso ? base.where(gte(llmAudit.requestedAt, sinceIso)) : base);

  const byDay = new Map<string, LlmAuditDailyPoint>();
  for (const row of rows) {
    const date = localDate(row.requestedAt, timeZone);
    const point =
      byDay.get(date) ??
      ({ date, calls: 0, failedCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 } satisfies LlmAuditDailyPoint);
    point.calls += 1;
    if (!row.success) point.failedCount += 1;
    const prompt = row.promptTokens ?? 0;
    const completion = row.completionTokens ?? 0;
    point.promptTokens += prompt;
    point.completionTokens += completion;
    point.totalTokens += row.totalTokens ?? 0;
    // Cache reads priced as the summary prices them: without them the day line
    // read $0.82 under a header that said $0.38 for the same calls (2026-09-24).
    point.estimatedCostUsd += estimateCostUsd(row.model, prompt, completion, row.cacheReadTokens ?? 0);
    byDay.set(date, point);
  }

  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export interface LostAnswer {
  id: string;
  purpose: string;
  momentId: string | null;
  /**
   * Whether the moment this call was stamped with is actually stored.
   *
   * A moment's id is minted when it OPENS; `closeMoment` drops any moment under
   * twenty seconds without writing a row. So a perfectly valid `momentId` here
   * can point at a row that will never exist, and chasing one from this card
   * read as a broken reader during the 2026-09-17 audit. `absent` is the honest
   * answer — the pointer is real, the moment was never kept.
   */
  momentState: 'stored' | 'absent' | 'none';
  requestedAt: string;
  errorClass: string;
  /**
   * The stored message, as stored.
   *
   * Carried beside the class because the class REPLACED it in the card, and a
   * message that reaches no screen is a message nobody can notice is wrong —
   * which is how 93 rows kept an endpoint URL that every readout had stopped
   * mentioning. The class is what you count; this is what you read when the
   * count looks strange.
   */
  message: string | null;
  attempt: number;
  /**
   * The id of a later call that answered the same question, or null when
   * nothing did. THIS is the field the section exists for: a failed call and a
   * call that was retried and succeeded looked identical, so "did Gnomon ever
   * answer?" had no answer.
   */
  answeredBy: string | null;
}

/**
 * How long after a failure a success still counts as the same question.
 *
 * The retry layer backs off to at most 8s over three attempts, and a rule that
 * re-fires on the next event is a minute or two behind. Fifteen minutes is
 * generous to both and short enough that tomorrow's journal call is not
 * mistaken for today's recovered one.
 */
const ANSWERED_WITHIN_MS = 15 * 60_000;

/**
 * Failed calls, each marked with whether anything ever answered in its place.
 *
 * A retry carries `parent_call_id` (L1), so a recovered attempt is joined
 * directly. Rows from before that column — and calls re-made by a rule rather
 * than by the retry layer, which get no parent — fall back to the weaker
 * evidence: a later success with the same purpose and the same moment, close
 * enough in time to be the same question. That fallback can be wrong in
 * principle; a lost answer that reads as recovered is the failure mode, and it
 * is the one a reader can check, since `answeredBy` names the row to look at.
 */
export async function getLostAnswers(sinceIso?: string, limit = 50): Promise<LostAnswer[]> {
  const db = getDb();
  const base = db
    .select({
      id: llmAudit.id,
      purpose: llmAudit.purpose,
      momentId: llmAudit.momentId,
      requestedAt: llmAudit.requestedAt,
      success: llmAudit.success,
      error: llmAudit.error,
      errorClass: llmAudit.errorClass,
      attempt: llmAudit.attempt,
      parentCallId: llmAudit.parentCallId,
    })
    .from(llmAudit);
  const rows = await (sinceIso ? base.where(gte(llmAudit.requestedAt, sinceIso)) : base);

  const successes = rows.filter((row) => row.success).sort((a, b) => (a.requestedAt < b.requestedAt ? -1 : 1));
  const successById = new Map(successes.map((row) => [row.id, row]));
  // A success that is itself a retry answers the attempt it replaced, and that
  // one's parent, all the way back to the first try.
  const answeredByParent = new Map<string, string>();
  for (const row of successes) {
    let parent = row.parentCallId;
    while (parent && !answeredByParent.has(parent)) {
      answeredByParent.set(parent, row.id);
      parent = rows.find((r) => r.id === parent)?.parentCallId ?? null;
    }
  }

  const lost = rows
    .filter((row) => !row.success)
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1))
    .slice(0, limit);

  // Which of the moments these rows name were actually written. One query for
  // the page, not one per row.
  const wanted = [...new Set(lost.map((row) => row.momentId).filter((id): id is string => typeof id === 'string' && id !== ''))];
  const stored = wanted.length === 0 ? new Set<string>() : new Set((await db.select({ id: moments.id }).from(moments).where(inArray(moments.id, wanted))).map((m) => m.id));

  return lost
    .map((row) => {
      const byLineage = answeredByParent.get(row.id) ?? null;
      const byProximity =
        byLineage ??
        successes.find(
          (s) =>
            s.purpose === row.purpose &&
            s.momentId === row.momentId &&
            s.requestedAt > row.requestedAt &&
            Date.parse(s.requestedAt) - Date.parse(row.requestedAt) <= ANSWERED_WITHIN_MS,
        )?.id ??
        null;
      return {
        id: row.id,
        purpose: row.purpose,
        momentId: row.momentId,
        requestedAt: row.requestedAt,
        errorClass: failureClass(row),
        message: row.error,
        attempt: row.attempt,
        answeredBy: byProximity && successById.has(byProximity) ? byProximity : null,
        momentState: row.momentId ? (stored.has(row.momentId) ? ('stored' as const) : ('absent' as const)) : ('none' as const),
      };
    });
}

/** What one moment cost Gnomon to think about. */
export interface MomentCost {
  calls: number;
  failed: number;
  costUsd: number;
  /** Which parts of Gnomon spent it, so a surprising number says where to look. */
  purposes: string[];
}

/**
 * The thinking spent on ONE moment.
 *
 * The ledger has carried `momentId` on every row since it was written, so the
 * cost of a moment was always in the record and no surface ever showed it. The
 * audit called that the unmade accountability loop: a moment card that says
 * what the owner did, beside no statement of what Gnomon spent understanding
 * it. Zero calls is a real answer — most moments are never thought about — so
 * the caller decides whether to draw a nothing.
 */
export async function getMomentCost(momentId: string): Promise<MomentCost> {
  const db = getDb();
  const rows = await db
    .select({
      model: llmAudit.model,
      purpose: llmAudit.purpose,
      success: llmAudit.success,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      billedPromptTokens: llmAudit.billedPromptTokens,
      cacheReadTokens: llmAudit.cacheReadTokens,
    })
    .from(llmAudit)
    .where(eq(llmAudit.momentId, momentId));
  let costUsd = 0;
  let failed = 0;
  const purposes = new Set<string>();
  for (const row of rows) {
    // A failed call still uploaded a prompt; that is spend with nothing to show
    // for it, and leaving it out would make the honest number the flattering one.
    costUsd += estimateCostUsd(row.model, (row.promptTokens ?? 0) + (row.billedPromptTokens ?? 0), row.completionTokens ?? 0, row.cacheReadTokens ?? 0);
    if (!row.success) failed += 1;
    if (row.purpose) purposes.add(row.purpose);
  }
  return { calls: rows.length, failed, costUsd, purposes: [...purposes].sort() };
}

/** How `getLlmLedgerRows` buckets the window. */
export type LlmLedgerGroupBy = 'day' | 'purpose' | 'model' | 'errorClass';

export interface LlmLedgerRow {
  /** The owner-local date, purpose, model id, or error class this row is about. */
  key: string;
  calls: number;
  failed: number;
  tokens: number;
  /** Estimated prompt tokens uploaded by the failed calls in this bucket — spend with nothing to show for it. */
  billedOnFailureTokens: number;
  /**
   * The part of this bucket's input the provider served from its prefix cache.
   * A SUBSET of `tokens`, priced at a twentieth of the input rate, so a bucket
   * where this is most of the input costs far less than its token count reads.
   * 0 for rows written before the column existed.
   */
  cacheReadTokens: number;
  costUsd: number;
  /** Wall-clock spent inside this bucket's failed calls. The other half of what a failure costs. */
  failedMs: number;
}

/**
 * The ledger as ROWS, along whichever axis the question is about.
 *
 * The overview, the daily rollup and the per-model rollup each answer one fixed
 * question in one fixed shape, which is why a question like "cost per day, last
 * seven days" had to be assembled by hand from two of them. This is the same
 * arithmetic over one projection, with the grouping key chosen by the caller —
 * so a lens can card any of the four axes without a fourth query being written.
 *
 * `errorClass` buckets only the failures (a success has no class), so its rows
 * sum to `failedCount` rather than to `calls`.
 */
export async function getLlmLedgerRows(groupBy: LlmLedgerGroupBy, timeZone: string, sinceIso?: string): Promise<LlmLedgerRow[]> {
  const db = getDb();
  const base = db
    .select({
      requestedAt: llmAudit.requestedAt,
      purpose: llmAudit.purpose,
      model: llmAudit.model,
      success: llmAudit.success,
      error: llmAudit.error,
      errorClass: llmAudit.errorClass,
      latencyMs: llmAudit.latencyMs,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      totalTokens: llmAudit.totalTokens,
      billedPromptTokens: llmAudit.billedPromptTokens,
      cacheReadTokens: llmAudit.cacheReadTokens,
    })
    .from(llmAudit);
  const rows = await (sinceIso ? base.where(gte(llmAudit.requestedAt, sinceIso)) : base);

  const byKey = new Map<string, LlmLedgerRow>();
  for (const row of rows) {
    if (groupBy === 'errorClass' && row.success) continue;
    const key =
      groupBy === 'day' ? localDate(row.requestedAt, timeZone) : groupBy === 'purpose' ? row.purpose : groupBy === 'model' ? row.model : failureClass(row);
    const bucket = byKey.get(key) ?? { key, calls: 0, failed: 0, tokens: 0, billedOnFailureTokens: 0, cacheReadTokens: 0, costUsd: 0, failedMs: 0 };
    bucket.calls += 1;
    bucket.tokens += row.totalTokens ?? 0;
    bucket.cacheReadTokens += row.cacheReadTokens ?? 0;
    bucket.costUsd += estimateCostUsd(row.model, row.promptTokens ?? 0, row.completionTokens ?? 0, row.cacheReadTokens ?? 0);
    if (!row.success) {
      bucket.failed += 1;
      bucket.failedMs += row.latencyMs ?? 0;
      const billed = row.billedPromptTokens ?? 0;
      bucket.billedOnFailureTokens += billed;
      bucket.costUsd += estimateCostUsd(row.model, billed, 0);
    }
    byKey.set(key, bucket);
  }

  // A day axis reads newest first (the question is "what is it doing lately");
  // every other axis reads biggest first.
  return groupBy === 'day' ? [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : -1)) : [...byKey.values()].sort((a, b) => b.calls - a.calls);
}

export interface LlmAuditModelStat {
  model: string;
  /** `local` (Ollama, always $0) or `remote` (hosted, billed) — see `llmProvider`. */
  provider: LlmProvider;
  calls: number;
  totalTokens: number;
  estimatedCostUsd: number;
  /** Remote model with no price in `LLM_PRICING`: its `estimatedCostUsd` of 0 is a gap, not a fact. */
  unpriced: boolean;
}

/**
 * Per-model rollup for the Observability pricing block: which models the spend
 * went to, at list price. Sorted by token volume, biggest first. `sinceIso`
 * (optional) scopes the scan.
 */
export async function getLlmAuditByModel(sinceIso?: string): Promise<LlmAuditModelStat[]> {
  const db = getDb();
  const base = db
    .select({
      model: llmAudit.model,
      promptTokens: llmAudit.promptTokens,
      completionTokens: llmAudit.completionTokens,
      totalTokens: llmAudit.totalTokens,
      cacheReadTokens: llmAudit.cacheReadTokens,
    })
    .from(llmAudit);
  const rows = await (sinceIso ? base.where(gte(llmAudit.requestedAt, sinceIso)) : base);

  const byModel = new Map<string, LlmAuditModelStat>();
  for (const row of rows) {
    const stat =
      byModel.get(row.model) ??
      ({
        model: row.model,
        provider: llmProvider(row.model),
        calls: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        unpriced: isUnpricedRemote(row.model),
      } satisfies LlmAuditModelStat);
    stat.calls += 1;
    stat.totalTokens += row.totalTokens ?? 0;
    stat.estimatedCostUsd += estimateCostUsd(row.model, row.promptTokens ?? 0, row.completionTokens ?? 0, row.cacheReadTokens ?? 0);
    byModel.set(row.model, stat);
  }

  return [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}
