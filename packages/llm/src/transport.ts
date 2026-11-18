import { callRuntime } from './claude-code.js';
import { CLAUDE_SOURCE, getLlmConfig } from './config.js';
import { getModelPort } from './model-port.js';
import type { ChatCompletionMessage, ChatCompletionResult, LlmPurpose, ToolCall, ToolDefinition } from './types.js';
import type { LlmConfig } from './config.js';

/**
 * Fine for a moment-intent call on a five-line prompt. Not fine for the journal,
 * which sends a whole day and asks for 4,000 tokens back — that reliably runs
 * past a minute and aborted mid-generation. Callers that know they are asking
 * for something big pass their own via `opts.timeoutMs`.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A non-2xx response from the LLM endpoint, carrying the status and any
 * parsed `Retry-After` (ms) so a retry layer can be status-aware — retry a
 * 429/5xx (honoring `Retry-After`), give up immediately on a 4xx client error.
 */
export class LlmHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** `Retry-After` is either delta-seconds or an HTTP-date; return ms, or null if absent/unparseable. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

/**
 * Gnomon's `ChatCompletionMessage` -> the OpenAI wire shape.
 *
 * The wire format nests the function name and arguments one level deeper than
 * is pleasant to construct by hand, and a `role: 'tool'` message keys off
 * `tool_call_id`. Kept as a mapping at the boundary so the rest of the codebase
 * carries the flat `{ id, name, arguments }` shape.
 */
function toWireMessage(message: ChatCompletionMessage): Record<string, unknown> {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })),
    };
  }
  return { role: message.role, content: message.content };
}

/**
 * A raw `fetch` against a single OpenAI-compatible `/chat/completions`
 * endpoint — no SDK dependency, no multi-endpoint fallback loop (see
 * config.ts's comment on why). Ported from WCS's `callChatCompletionsWithFallback`
 * with the fallback/streaming/Ollama-extras machinery stripped out — none
 * of that has anywhere to route to with a single configured endpoint.
 *
 * `opts.tools` adds function calling. That stayed out of an SDK for the same
 * reason the rest of this file did: the wire protocol is one extra request
 * field and one extra response field, whereas an agent SDK (Mastra, the Vercel
 * AI SDK) owns the loop — and owning the loop means owning where the audit row
 * gets written, which `runAuditedLlmCall` deliberately keeps as the single
 * write path to `llm_audit`. The loop lives in `tool-loop.ts` instead, one
 * audited call per HTTP round-trip.
 */
export async function callChatCompletion(
  messages: ChatCompletionMessage[],
  opts: { purpose?: LlmPurpose; model?: string; maxTokens?: number; temperature?: number; tools?: ToolDefinition[]; toolChoice?: 'auto' | 'none'; timeoutMs?: number; config?: LlmConfig; reasoning?: 'none' | 'low' } = {},
): Promise<ChatCompletionResult> {
  // `opts.config`: the router's candidate for this attempt (`runAuditedLlmCall` walks the list); else the first.
  const config = opts.config ?? getLlmConfig(opts.purpose);
  if (!config) {
    throw new Error('No LLM endpoint configured — set SUNDIAL_LLM_BASE_URL, and SUNDIAL_LLM_MODEL for any endpoint other than TensorX.');
  }
  if (config.access === 'runtime') {
    return callRuntime(config.route === CLAUDE_SOURCE ? 'claude' : 'copilot', messages, { model: opts.model ?? config.model, withTools: Boolean(opts.tools?.length), timeoutMs: opts.timeoutMs ? Math.max(opts.timeoutMs, 120_000) : undefined });
  }
  // A protocol this fetch does not speak goes through the model port (dsh's adapters, in the harness).
  if (config.protocol !== 'openai-chat') {
    const port = getModelPort();
    if (!port) throw new Error(`The ${config.route} provider speaks ${config.protocol}, which only the running Sundial can reach (no model port in this process).`);
    return port.complete({ route: config.route, model: opts.model ?? config.model, messages, tools: opts.tools, maxTokens: opts.maxTokens, temperature: opts.temperature, timeoutMs: opts.timeoutMs });
  }

  const reasoning = opts.reasoning ?? 'none';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model ?? config.model,
        messages: messages.map(toWireMessage),
        // Reasoning tokens count against max_tokens: a model that must reason gets room for it on top.
        max_tokens: (opts.maxTokens ?? 1024) + (reasoning === 'none' ? 0 : 4096),
        temperature: opts.temperature ?? 0.3,
        // Every kernel purpose wants a short structured answer, not a think-aloud.
        // qwen/qwen3.8-flash-next reasons by default and, measured 2026-09-06,
        // spent all 1024 tokens reasoning and returned EMPTY content on a
        // five-line intent prompt. This is the OpenAI-standard switch; TensorX
        // honours it for qwen, and deepseek (which does not reason) ignores it.
        reasoning_effort: reasoning,
        ...(opts.tools && opts.tools.length > 0
          ? {
              tools: opts.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })),
              tool_choice: opts.toolChoice ?? 'auto',
            }
          : {}),
      }),
      signal: controller.signal,
    });

    const statusCode = response.status;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // A model that cannot stop reasoning (minimax/minimax-m3.1-flash on OpenRouter, 2026-11-17: 400 "Reasoning is
      // mandatory for this endpoint and cannot be disabled") refuses 'none': asked once more at 'low'.
      if (statusCode === 400 && reasoning === 'none' && /reasoning is mandatory/i.test(text)) return callChatCompletion(messages, { ...opts, config, reasoning: 'low' });
      throw new LlmHttpError(statusCode, parseRetryAfterMs(response.headers.get('retry-after')), `LLM endpoint returned ${statusCode}: ${text.slice(0, 500)}`);
    }

    const parsed = (await response.json()) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const choice = parsed.choices?.[0];
    const content = choice?.message?.content ?? '';
    // A call with no id or no name is unusable — it cannot be paired with a
    // result message — so it is dropped here rather than surfaced as a call the
    // loop would then fail to answer.
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? [])
      .filter((call): call is { id: string; function: { name: string; arguments?: string } } => Boolean(call.id && call.function?.name))
      .map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments ?? '{}' }));

    return {
      content,
      statusCode,
      promptTokens: parsed.usage?.prompt_tokens ?? null,
      completionTokens: parsed.usage?.completion_tokens ?? null,
      totalTokens: parsed.usage?.total_tokens ?? null,
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
    };
  } finally {
    clearTimeout(timeout);
  }
}
