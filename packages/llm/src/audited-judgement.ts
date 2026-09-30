import { classifyLlmError } from '@sundial/helpers/llm-error-class.js';
import { estimateBilledPromptTokens } from '@sundial/helpers/llm-billed-tokens.js';
import { openLlmAudit } from './audit.js';
import { SYSTEMONE_DEFAULT_MODEL, callSystemOne, type SystemOneAnswer, type SystemOneQuestion } from './systemone.js';
import { callSystemOneTextModel } from './systemone-text-model.js';
import { getLlmConfig } from './config.js';
import { DEFAULT_PROVIDER, providerLabel } from '@sundial/helpers/llm-providers.js';
import { reportLlmOutcome, statusOf } from './outcome.js';
import type { JudgementPurpose } from './types.js';

/** The provider prefix `llmProvider` reads as remote, so the Ledger prices the call. */
export const SYSTEMONE_PROVIDER = 'typesafe';

export interface AuditedJudgementOptions {
  purpose: JudgementPurpose;
  momentId: string | null;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  model?: string;
  timeoutMs?: number;
  /**
   * `jev` (default) or `text-model` — the configured text model prompted for
   * probabilities (`systemone-text-model.ts`). Such a row records the text model's id, so the
   * Ledger prices it at that rate and a judgement purpose served by
   * `qwen/…` is the fallback mark.
   */
  backend?: 'jev' | 'text-model';
  /** Retry lineage, as `AuditedLlmCallOptions` carries it. */
  attempt?: number;
  parentCallId?: string | null;
  /** W3: the reservation's id, used as the row's id (see `AuditedLlmCallOptions.callId`). */
  callId?: string;
}

export interface AuditedJudgementResult {
  auditId: string;
  answers: Record<string, SystemOneAnswer>;
  /** The audited id, `typesafe/<model>`. */
  model: string;
  latencyMs: number;
}

/**
 * One Jev call, written to `llm_audit` record-then-patch exactly as
 * `runAuditedLlmCall` writes a text call: same table, one more row shape. The
 * prompt column holds `{ state, questions }`, the response the answers, so a
 * judgement is as re-readable after the fact as a sentence is.
 *
 * The model id is recorded WITH its provider prefix — `typesafe/jev-latest` —
 * because `llmProvider` classifies by the `/` and a bare `jev-latest` would be
 * priced as a free local tag (`LLM_PRICING` has the `typesafe/` row).
 */
/** lane H: who answered a judgement, for `reportLlmOutcome`. */
const judgeProvider = (backend: 'jev' | 'text-model', purpose: JudgementPurpose) => {
  if (backend === 'jev') return { provider: 'jev', label: 'Jev' };
  const config = getLlmConfig(purpose);
  return { provider: config?.route ?? DEFAULT_PROVIDER, label: providerLabel(config?.baseUrl ?? '') };
};

export async function runAuditedJudgement(options: AuditedJudgementOptions): Promise<AuditedJudgementResult> {
  const backend = options.backend ?? 'jev';
  const bareModel = options.model ?? SYSTEMONE_DEFAULT_MODEL;
  const model = backend === 'text-model' ? (getLlmConfig(options.purpose)?.model ?? 'unconfigured') : `${SYSTEMONE_PROVIDER}/${bareModel}`;
  const prompt = JSON.stringify({ state: options.state, questions: options.questions });

  const audit = await openLlmAudit({
    ...(options.callId ? { id: options.callId } : {}),
    momentId: options.momentId,
    purpose: options.purpose,
    model,
    prompt,
    attempt: options.attempt ?? 1,
    parentCallId: options.parentCallId ?? null,
    route: judgeProvider(backend, options.purpose).provider,
  });

  const start = Date.now();
  try {
    const result =
      backend === 'text-model'
        ? await callSystemOneTextModel(options.state, options.questions, { purpose: options.purpose, timeoutMs: options.timeoutMs })
        : await callSystemOne(options.state, options.questions, { model: bareModel, timeoutMs: options.timeoutMs });
    const answered = Object.keys(result.answers).length;
    await audit.settle({
      respondedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      statusCode: result.statusCode,
      // Every question asked came back: a partial answer set is a failure the
      // consuming rule would otherwise read as "the model said nothing here".
      success: answered > 0 && answered === Object.keys(options.questions).length,
      responseContent: JSON.stringify(result.answers),
      promptTokens: result.inputTokens ?? undefined,
      completionTokens: result.outputTokens ?? undefined,
      totalTokens: result.inputTokens === null ? undefined : result.inputTokens + (result.outputTokens ?? 0),
    });
    reportLlmOutcome({ ...judgeProvider(backend, options.purpose), ok: true, statusCode: result.statusCode ?? null });
    return { auditId: audit.id, answers: result.answers, model, latencyMs: result.latencyMs };
  } catch (error) {
    // lane H (H3)
    const statusCode = statusOf(error);
    reportLlmOutcome({ ...judgeProvider(backend, options.purpose), ok: false, statusCode });
    await audit.settle({
      respondedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      ...(statusCode !== null ? { statusCode } : {}),
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorClass: classifyLlmError(error),
      retryAfterMs: (error as { retryAfterMs?: number | null } | null)?.retryAfterMs ?? null, // an `LlmHttpError`'s Retry-After
      billedPromptTokens: estimateBilledPromptTokens(prompt),
    });
    if (typeof error === 'object' && error !== null) (error as { auditId?: string }).auditId = audit.id;
    throw error;
  }
}
