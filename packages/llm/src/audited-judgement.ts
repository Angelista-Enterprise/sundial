import { createEventId } from '@sundial/helpers/event-id.js';
import { classifyLlmError } from '@sundial/helpers/llm-error-class.js';
import { estimateBilledPromptTokens } from '@sundial/helpers/llm-billed-tokens.js';
import { recordLlmAudit, updateLlmAudit } from '@sundial/db/index.js';
import { SYSTEMONE_DEFAULT_MODEL, callSystemOne, type SystemOneAnswer, type SystemOneQuestion } from './systemone.js';
import { callSystemOneLocal } from './systemone-local.js';
import { getLlmConfig } from './config.js';
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
   * `jev` (default) or `local` — the text model prompted for probabilities
   * (`systemone-local.ts`). A local row records the TEXT model's id, so the
   * Ledger prices it at that rate and a judgement purpose served by
   * `qwen/…` is the fallback mark.
   */
  backend?: 'jev' | 'local';
  /** Retry lineage, as `AuditedLlmCallOptions` carries it. */
  attempt?: number;
  parentCallId?: string | null;
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
export async function runAuditedJudgement(options: AuditedJudgementOptions): Promise<AuditedJudgementResult> {
  const backend = options.backend ?? 'jev';
  const bareModel = options.model ?? SYSTEMONE_DEFAULT_MODEL;
  const model = backend === 'local' ? (getLlmConfig()?.model ?? 'unconfigured') : `${SYSTEMONE_PROVIDER}/${bareModel}`;
  const auditId = createEventId();
  const prompt = JSON.stringify({ state: options.state, questions: options.questions });

  await recordLlmAudit({
    id: auditId,
    momentId: options.momentId,
    purpose: options.purpose,
    model,
    prompt,
    requestedAt: new Date().toISOString(),
    attempt: options.attempt ?? 1,
    parentCallId: options.parentCallId ?? null,
  });

  const start = Date.now();
  try {
    const result =
      backend === 'local'
        ? await callSystemOneLocal(options.state, options.questions, { timeoutMs: options.timeoutMs })
        : await callSystemOne(options.state, options.questions, { model: bareModel, timeoutMs: options.timeoutMs });
    const answered = Object.keys(result.answers).length;
    await updateLlmAudit(auditId, {
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
    return { auditId, answers: result.answers, model, latencyMs: result.latencyMs };
  } catch (error) {
    await updateLlmAudit(auditId, {
      respondedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      errorClass: classifyLlmError(error),
      billedPromptTokens: estimateBilledPromptTokens(prompt),
    });
    if (typeof error === 'object' && error !== null) (error as { auditId?: string }).auditId = auditId;
    throw error;
  }
}
