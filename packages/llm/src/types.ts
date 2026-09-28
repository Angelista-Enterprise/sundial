/** One function call the model asked for, as the OpenAI wire format returns it. */
export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as the model emitted it — parsed by the loop, not here, so a malformed argument object is reported back to the model rather than thrown at the caller. */
  arguments: string;
}

export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Set on an assistant turn that requested tools; echoed back verbatim so the endpoint can pair each result with its call. */
  toolCalls?: ToolCall[];
  /** Set on a `role: 'tool'` turn — the id of the call this message answers. */
  toolCallId?: string;
}

/**
 * A tool as advertised to the model. `parameters` is a JSON Schema object;
 * `@sundial/kernel`'s tool registry derives it from the same zod schemas the MCP
 * server registers, so there is one definition per tool rather than two.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatCompletionResult {
  content: string;
  statusCode: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Empty unless the model requested tools. `content` is typically `''` in that case. */
  toolCalls: ToolCall[];
  finishReason: string | null;
}

/**
 * `refute` is the adversarial pass over core memory — see
 * `packages/rules/src/nightly-refutation.ts`. It is a separate purpose rather
 * than a second use of `extract` because the two want opposite things from a
 * model and opposite things from a budget: extraction runs once a night over a
 * day of evidence, refutation runs over a handful of already-held beliefs and
 * is the natural first candidate for a cheaper model.
 */
export type LlmPurpose = 'intent' | 'companion' | 'reflect' | 'extract' | 'journal' | 'ask' | 'refute' | 'goal' | 'transcript' | JudgementPurpose;

/**
 * The purposes a `Judge` effect runs under (docs/jarvis/02). Jev's, not the
 * text model's: a judgement is a probability vector over a structured state,
 * budgeted apart so a runaway fan-out cannot spend the journal's day.
 */
export type JudgementPurpose = 'perceive' | 'classify' | 'rank' | 'judge' | 'audit' | 'forecast' | 'listen';

export interface AuditedLlmCallOptions {
  purpose: LlmPurpose;
  momentId: string | null;
  messages: ChatCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Advertised to the model when non-empty. The caller executes whatever comes back; `runAuditedLlmCall` itself stays a single request/response. */
  tools?: ToolDefinition[];
  /** `'none'` forces prose on a turn that would otherwise keep calling tools — the tool loop's way of ending a run without telling the owner it gave up. */
  toolChoice?: 'auto' | 'none';
  /** Per-request abort, defaulting to 60s. The journal sends a whole day and asks for 4,000 tokens back, which runs past that. */
  timeoutMs?: number;
  /**
   * Retry lineage. The retry layer lives above this function
   * (`performScheduledLlmCall`) and makes a fresh audited call per attempt, so
   * without these two the ledger cannot tell a lost answer from a recovered
   * one. `attempt` is 1-based; `parentCallId` is the `auditId` of the attempt
   * being retried — read off `LlmCallError.auditId` on the failure that caused it.
   */
  attempt?: number;
  parentCallId?: string | null;
}

/**
 * The ledger row `runAuditedLlmCall` already wrote for the attempt that threw.
 *
 * Stamped onto the error it rethrows rather than wrapped in a new error class:
 * the retry layer branches on `error instanceof LlmHttpError` to decide whether
 * a failure is worth retrying at all, and a wrapper would silently turn every
 * client error into a retried one.
 */
export function auditIdOf(error: unknown): string | null {
  return typeof error === 'object' && error !== null && typeof (error as { auditId?: unknown }).auditId === 'string'
    ? (error as { auditId: string }).auditId
    : null;
}

export interface AuditedLlmCallResult {
  auditId: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}
