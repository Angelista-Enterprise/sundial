// The chat side of the ledger: every dsh model call, written to `llm_audit`.
//
// The kernel's effect calls go through `@sundial/llm`'s `runAuditedLlmCall`,
// which is record-then-patch against `llm_audit`. dsh's own model calls never
// touch that transport — they go adapter-direct (gnomon-llm-tensorx) — so
// until this module they left no ledger row at all, and the Ledger page's
// claim that it holds "every call Gnomon makes" was false for the one call
// the owner actually watches happen.
//
// This is the same record-then-patch shape as `runAuditedLlmCall`, expressed
// over the `llm/stream` waterfall instead of a request/response pair:
//
//   begin(options)  → INSERT the placeholder row before next() is called, so a
//                     crash mid-stream still leaves the attempt on the record
//                     (success: false, no response fields).
//   observe(chunk)  → accumulate text, tool calls, usage, and the finish
//                     reason as the stream passes through.
//   settle(error)   → UPDATE the row once, with latency, tokens, the response
//                     body, and success or the failure that ended it.
//
// It never throws: a ledger write that fails must not break the owner's chat.
// Every failure is logged and swallowed, and `begin` returns null so the
// caller's `observe`/`settle` become no-ops.
//
// Named exports only.
import { createEventId } from '@sundial/helpers/event-id.js';
import { classifyLlmError } from '@sundial/helpers/llm-error-class.js';
import { estimateBilledPromptTokens } from '@sundial/helpers/llm-billed-tokens.js';

/** dsh's ordinary conversation turn carries no `purpose`; it is the seat /ask held. */
export const DEFAULT_AUDIT_PURPOSE = 'ask';

/**
 * Bound on the stored prompt and response bodies.
 *
 * The effect path stores its prompts whole, and can: each background call is
 * a fresh, bounded prompt. A chat turn is not — the loop replays the entire
 * derived history plus every tool result on EVERY turn, so storing them whole
 * grows the table with the square of the conversation length. The ledger needs
 * the call's shape and cost, not a second verbatim copy of a transcript dsh
 * already keeps in its own session log.
 */
export const MAX_BODY_CHARS = 20_000;

/** Trim to the bound, marking the cut so a truncated body never reads as a short one. */
export function boundBody(text) {
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, MAX_BODY_CHARS)}\n… [${text.length - MAX_BODY_CHARS} more characters not recorded]`;
}

/** One content block → the text the ledger shows for it. Unknown block types degrade to a tag, never to nothing. */
function renderBlock(block) {
  switch (block?.type) {
    case 'text':
    case 'reasoning':
      return block.text ?? '';
    case 'tool-call':
      return `${block.name}(${block.arguments})`;
    case 'tool-result':
      return `→ ${(block.content ?? []).map(renderBlock).join('')}`;
    case 'image':
      return '[image]';
    default:
      return block?.type ? `[${block.type}]` : '';
  }
}

/**
 * GenerateOptions → the prompt text stored on the row.
 *
 * Same `[role] content` shape `runAuditedLlmCall` writes, so both halves of
 * the ledger read alike when a row is expanded. The system prompt is included:
 * it is most of what makes a chat turn cost what it costs.
 */
export function serializePrompt(options) {
  const parts = [];
  if (typeof options?.system === 'string' && options.system.length > 0) {
    parts.push(`[system] ${options.system}`);
  }
  for (const message of options?.messages ?? []) {
    parts.push(`[${message.role}] ${(message.content ?? []).map(renderBlock).join('')}`);
  }
  // When the body is cut, a digest goes first so the ledger can still size every block.
  const body = parts.join('\n\n');
  if (body.length <= MAX_BODY_CHARS) return body;
  const digest = parts.map((part) => `${(part.match(/^\[(\w+)\]/) ?? [, '?'])[1]} ${part.length}`).join(' · ');
  return boundBody(`[digest] ${digest}\n\n${body}`);
}

/**
 * The purpose the row is filed under.
 *
 * dsh sets `purpose` only on its auxiliary calls (compaction, session titles);
 * an ordinary conversation turn leaves it unset and is filed as 'ask' — the
 * purpose the Ledger already groups under "The conversation", and the one the
 * budget guard meters. Auxiliary calls keep their own name so the ledger can
 * say what the machinery around the chat costs instead of hiding it inside the
 * chat's own line.
 */
export function auditPurpose(options) {
  const purpose = options?.purpose;
  return typeof purpose === 'string' && purpose.length > 0 ? purpose : DEFAULT_AUDIT_PURPOSE;
}

/**
 * dsh's TokenUsage → the columns `llm_audit` holds.
 *
 * TokenUsage counts are DISJOINT (cache reads are subtracted out of
 * `inputTokens`), while `prompt_tokens` on the row is the whole billed input.
 * Adding the cache read back keeps a chat row the same shape as every effect
 * row — and `cacheReadTokens` then carries the split forward, so
 * `estimateCostUsd` can price the cached half at the cached rate.
 *
 * Keeping the split matters more here than anywhere else in the ledger: a chat
 * turn replays its whole history on every step, so the cached fraction is most
 * of the call. Measured on the live session log, 85.5% of chat input was a
 * cache read — and while this function was discarding that, the ledger's `ask`
 * line overstated the input side by 2.79x.
 *
 * Reported as 0 rather than omitted when the provider says nothing about its
 * cache: a missing column would be priced as fully fresh, which is the honest
 * default, and a zero says the same thing without the reader having to guess
 * whether the field was lost.
 */
export function mapUsageToColumns(usage) {
  if (!usage) return {};
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const promptTokens = (usage.inputTokens ?? 0) + cacheReadTokens;
  const completionTokens = usage.outputTokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, cacheReadTokens };
}

/**
 * A terminal finish reason → { success, error, errorClass }.
 *
 * A turn that asked for tools is a success with no prose. The class comes from
 * the finish reason's KIND where the kind already says what happened — an
 * `aborted` stream is a cancellation whatever its message reads — and from the
 * failure object otherwise. Either way it is settled here, at the call site,
 * and never re-derived from the stored string.
 */
function readFinish(reason) {
  switch (reason?.kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
      return { success: true, error: undefined, errorClass: undefined };
    case 'aborted':
      return { success: false, error: reason.failure?.message ?? 'aborted', errorClass: 'cancelled' };
    case 'error':
      return { success: false, error: reason.failure?.message ?? 'unknown provider failure', errorClass: classifyLlmError(reason.failure) };
    default:
      return { success: false, error: `unknown finish reason: ${String(reason?.kind)}`, errorClass: 'stream' };
  }
}

/**
 * Build the recorder.
 *
 * @param options.queries `@sundial/db`'s query module (recordLlmAudit/updateLlmAudit)
 * @param options.getMomentId () => the open moment's id or null — the one correlation id Gnomon has
 * @param options.newId id factory, overridable in tests
 * @param options.clock () => epoch ms, overridable in tests
 * @returns `begin(options)` → a per-call collector, or null when the row could not be opened
 */
export function createLlmAuditRecorder({ queries, getMomentId, newId = createEventId, clock = () => Date.now() }) {
  return async function begin(options) {
    const id = newId();
    const startedAt = clock();
    // Kept: `settle` prices a failed stream off the prompt that was sent.
    const prompt = serializePrompt(options);
    try {
      await queries.recordLlmAudit({
        id,
        momentId: getMomentId(),
        purpose: auditPurpose(options),
        // `model` is NOT NULL on the row and is the whole point of the chat
        // half of the ledger — it is how the owner sees which model answered.
        model: options?.model ?? 'unknown',
        prompt,
        requestedAt: new Date(startedAt).toISOString(),
      });
    } catch (error) {
      console.error('[sundial-tools] failed to open a ledger row for a chat call:', error);
      return null;
    }

    let text = '';
    const toolCalls = [];
    let usage;
    let finish;
    let settled = false;

    return {
      id,

      observe(chunk) {
        switch (chunk?.type) {
          case 'text-delta':
            text += chunk.text ?? '';
            break;
          case 'block-end':
            if (chunk.block?.type === 'tool-call') {
              toolCalls.push(`${chunk.block.name}(${chunk.block.arguments})`);
            }
            break;
          case 'usage':
            usage = chunk.usage;
            break;
          case 'finish':
            finish = chunk.reason;
            break;
          default:
            break;
        }
      },

      /**
       * Close the row. Called from the guard's `finally`, so it runs on a
       * thrown error and on an abandoned iterator too — the provider was
       * contacted either way, which is what the ledger records.
       *
       * @param thrown the error that ended the stream, if it ended by throwing
       */
      async settle(thrown) {
        if (settled) return; // a `finally` may run once; belt and braces
        settled = true;
        const outcome = finish
          ? readFinish(finish)
          : { success: false, error: 'stream ended without a finish chunk', errorClass: 'stream' };
        const error = thrown ? (thrown instanceof Error ? thrown.message : String(thrown)) : outcome.error;
        const errorClass = thrown ? classifyLlmError(thrown) : outcome.errorClass;
        const body = text || toolCalls.join(' ');
        // One clock read: `respondedAt` and `latencyMs` must describe the same
        // instant, or the row's own two time fields disagree.
        const endedAt = clock();
        const success = thrown ? false : outcome.success;
        const columns = mapUsageToColumns(usage);
        // A stream that died still uploaded its prompt. Prefer a usage chunk if
        // one arrived before the failure; estimate from the prompt otherwise.
        const billedPromptTokens = success ? undefined : columns.promptTokens || estimateBilledPromptTokens(prompt);
        try {
          await queries.updateLlmAudit(id, {
            respondedAt: new Date(endedAt).toISOString(),
            latencyMs: endedAt - startedAt,
            success,
            ...(body.length > 0 ? { responseContent: boundBody(body) } : {}),
            ...columns,
            ...(error ? { error } : {}),
            ...(errorClass ? { errorClass } : {}),
            ...(billedPromptTokens ? { billedPromptTokens } : {}),
          });
        } catch (writeError) {
          console.error('[sundial-tools] failed to close a ledger row for a chat call:', writeError);
        }
      },
    };
  };
}
