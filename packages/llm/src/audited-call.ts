import { createEventId } from '@sundial/helpers/event-id.js';
import { classifyLlmError } from '@sundial/helpers/llm-error-class.js';
import { estimateBilledPromptTokens } from '@sundial/helpers/llm-billed-tokens.js';
import { recordLlmAudit, updateLlmAudit } from '@sundial/db/index.js';
import { DEFAULT_PROVIDER, ledgerModel, providerLabel } from '@sundial/helpers/llm-providers.js';
import { reportLlmOutcome, statusOf } from './outcome.js';
import { getLlmConfig } from './config.js';
import { callChatCompletion } from './transport.js';
import type { AuditedLlmCallOptions, AuditedLlmCallResult } from './types.js';

/**
 * Record-then-patch, the single write path to `llm_audit` (docs/design/03-
 * effects-and-llm-policy.md) — ported from WCS's `runAuditedLlmCall`, with
 * the WCS-specific fields (`sessionId`, `schemaHint`, live-WS event emission,
 * Langfuse) dropped: no window-session concept, no Apple-FM schema
 * selection, no live UI to push to, no Langfuse UI to trace into. `momentId` is the one correlation id Gnomon actually has.
 */
export async function runAuditedLlmCall(options: AuditedLlmCallOptions): Promise<AuditedLlmCallResult> {
  // Asked per purpose (config.ts, `llm.use`) and recorded on the audit row, so
  // the ledger prices the call at the rate of the model that actually served it.
  const config = getLlmConfig(options.purpose);
  const model = config?.model ?? null;
  const route = config?.route ?? DEFAULT_PROVIDER;
  const auditId = createEventId();
  const requestedAt = new Date().toISOString();
  // A tool-requesting assistant turn has empty `content`; without the call
  // detail the audit row for that turn would read as a blank response and the
  // trail would not show which query the model chose to run.
  const prompt = options.messages
    .map((m) => {
      const calls = m.toolCalls?.length ? ` ${m.toolCalls.map((c) => `${c.name}(${c.arguments})`).join(' ')}` : '';
      return `[${m.role}]${calls} ${m.content}`;
    })
    .join('\n\n');

  await recordLlmAudit({
    id: auditId,
    momentId: options.momentId,
    purpose: options.purpose,
    // Namespaced when the endpoint is hosted and the id is bare, so the Ledger prices it (see `ledgerModel`).
    model: model === null ? 'unconfigured' : ledgerModel(model, route, config?.baseUrl),
    prompt,
    requestedAt,
    attempt: options.attempt ?? 1,
    parentCallId: options.parentCallId ?? null,
  });

  const start = Date.now();
  try {
    const result = await callChatCompletion(options.messages, {
      purpose: options.purpose,
      model: model ?? undefined,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      tools: options.tools,
      toolChoice: options.toolChoice,
      timeoutMs: options.timeoutMs,
    });

    // A turn that asked for tools is a success with no prose: judging success
    // on `content` alone would mark every tool-requesting turn as failed.
    const toolCallSummary = result.toolCalls.map((call) => `${call.name}(${call.arguments})`).join(' ');
    await updateLlmAudit(auditId, {
      respondedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      statusCode: result.statusCode,
      success: Boolean(result.content) || result.toolCalls.length > 0,
      responseContent: result.content || toolCallSummary,
      promptTokens: result.promptTokens ?? undefined,
      completionTokens: result.completionTokens ?? undefined,
      totalTokens: result.totalTokens ?? undefined,
    });

    reportLlmOutcome({ provider: route, label: providerLabel(config?.baseUrl ?? ''), ok: true, statusCode: result.statusCode ?? null });
    return { auditId, content: result.content, toolCalls: result.toolCalls, finishReason: result.finishReason };
  } catch (error) {
    // lane H (H3): the status the endpoint answered, when it answered at all.
    const statusCode = statusOf(error);
    reportLlmOutcome({ provider: route, label: providerLabel(config?.baseUrl ?? ''), ok: false, statusCode });
    await updateLlmAudit(auditId, {
      respondedAt: new Date().toISOString(),
      latencyMs: Date.now() - start,
      ...(statusCode !== null ? { statusCode } : {}),
      success: false,
      error: error instanceof Error ? error.message : String(error),
      // Here, where the error is still an object with a status and a cause —
      // not later, off the message string (see `@sundial/helpers/llm-error-class`).
      errorClass: classifyLlmError(error),
      // The upload happened whether or not an answer came back. Without this
      // the row reads as free and a week of failures costs nothing.
      billedPromptTokens: estimateBilledPromptTokens(prompt),
    });
    // The row this attempt wrote, carried out with the failure so the retry
    // layer can point its next row at it (`auditIdOf`). Stamped rather than
    // wrapped — see that helper for why.
    if (typeof error === 'object' && error !== null) (error as { auditId?: string }).auditId = auditId;
    throw error;
  }
}
