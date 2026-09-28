import { runAuditedLlmCall } from './audited-call.js';
import type { ChatCompletionMessage, LlmPurpose, ToolCall, ToolDefinition } from './types.js';

/** Per-result and whole-run caps on tool output. A day of `gnomon_code_activity` for one project measures ~8KB, so 12KB leaves headroom for a genuinely large day without letting one call eat the context window. */
const DEFAULT_MAX_RESULT_BYTES = 12_000;
const DEFAULT_MAX_TOTAL_RESULT_BYTES = 36_000;
const DEFAULT_MAX_ROUNDS = 5;
/** Above the transport's own 60s per-request timeout, so a slow single call fails on its own terms rather than tripping this. */
const DEFAULT_DEADLINE_MS = 120_000;

/** What one tool call did, for the trace and the SSE progress frames. */
export interface ToolCallRecord {
  name: string;
  arguments: string;
  ok: boolean;
  ms: number;
  /** Set when the call failed — the same text the model was handed, so the trace and the model agree on what went wrong. */
  error?: string;
}

/** One HTTP round trip and the tool calls it produced. */
export interface ToolLoopRound {
  /** 1-based, matching how the trace reads to a person. */
  index: number;
  ms: number;
  auditId: string;
  calls: ToolCallRecord[];
}

export type ToolLoopStopReason = 'answered' | 'max-rounds' | 'budget' | 'deadline';

export interface ToolLoopResult {
  content: string;
  rounds: ToolLoopRound[];
  /** Distinct tool names in first-use order — what the durable ask thread records about HOW a question was answered. */
  toolsUsed: string[];
  stopReason: ToolLoopStopReason;
}

export interface ToolLoopOptions {
  purpose: LlmPurpose;
  momentId?: string | null;
  messages: ChatCompletionMessage[];
  tools: ToolDefinition[];
  /** Runs one tool. Throws on any failure; the loop turns the throw into a result the model reads. */
  execute: (name: string, args: unknown) => Promise<unknown>;
  maxRounds?: number;
  deadlineMs?: number;
  maxResultBytes?: number;
  maxTotalResultBytes?: number;
  maxTokens?: number;
  temperature?: number;
  /** Per-REQUEST abort passed to each round trip, distinct from `deadlineMs`, which bounds the whole run. */
  requestTimeoutMs?: number;
  /**
   * Called before every round trip. Throwing stops the loop and forces a final
   * answer from what has already been gathered.
   *
   * This is the seam the budget check hangs on. `/ask` used to check its cap
   * once per question and record one dispatch, which was correct when a
   * question was one call; a five-round answer against a once-checked cap
   * spends five calls the budget never saw.
   */
  beforeCall?: (roundIndex: number) => Promise<void>;
  onRound?: (round: ToolLoopRound) => void;
  /**
   * The caller's own acceptance test for the final content — for a caller that
   * needs a machine-readable reply rather than prose.
   *
   * When it rejects, the loop spends ONE more turn asking for the format again,
   * quoting nothing and adding no tools. This exists because of a real failure:
   * after six rounds of tool results the journal's model opened its reply with
   * "I have enough data to write the journal now. Let me synthesize what I've
   * gathered:" and wrote 5,894 characters of prose, having drifted out of the
   * strict-JSON instruction sitting far back in the context. The whole day's
   * research was then thrown away by a parser returning null.
   *
   * One retry, not a loop: if a model cannot produce the format when asked
   * directly with the format named, asking a third time is not going to help,
   * and the caller's null-handling is the honest floor.
   */
  validate?: (content: string) => boolean;
}

/** Deliberately a plain object rather than a thrown string, so a caller can tell "the model errored" from "the model was stopped". */
export class BudgetExhaustedError extends Error {
  constructor(message = 'LLM budget exhausted') {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * Serialize a tool result for the model, truncating loudly rather than quietly.
 *
 * A silently cut result is the worst outcome available here: the model reads a
 * plausible, complete-looking JSON object, answers from it with confidence, and
 * nothing anywhere records that half the rows were dropped. Returning an object
 * that SAYS it was truncated keeps the model able to narrow its own query, and
 * keeps the omission visible in the audit row.
 */
function serializeResult(value: unknown, maxBytes: number): string {
  const full = JSON.stringify(value ?? null);
  if (full.length <= maxBytes) return full;

  // An array-shaped result can be halved into something still valid and still
  // useful; anything else is reported as too large rather than cut mid-structure,
  // because a truncated JSON string is not a smaller answer, it is a broken one.
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let used = 0;
    for (const item of value) {
      const encoded = JSON.stringify(item);
      if (used + encoded.length > maxBytes * 0.8) break;
      kept.push(item);
      used += encoded.length;
    }
    return JSON.stringify({ truncated: true, note: `showing ${kept.length} of ${value.length} rows — narrow your query (add a date, a project, or a smaller limit) to see the rest`, rows: kept });
  }

  return JSON.stringify({
    truncated: true,
    note: `this result was ${full.length} bytes, over the ${maxBytes}-byte limit for one tool result — narrow your query (add a date, a project, or a smaller limit)`,
    preview: full.slice(0, Math.floor(maxBytes * 0.6)),
  });
}

/** A stable identity for "the same call again", so a model that stalls repeating itself is told so instead of burning the round budget. */
function callKey(call: ToolCall): string {
  return `${call.name}:${call.arguments}`;
}

/**
 * Said in the conversation, not just in `tool_choice`.
 *
 * A model that has spent five rounds calling tools has a strong prior that the
 * next thing it produces is another call, and `tool_choice: 'none'` only closes
 * the structured channel — it does not tell the model the gathering phase is
 * over. Saying so in a turn it can actually read is what changes the behaviour.
 */
const FINAL_ANSWER_INSTRUCTION =
  'Stop gathering and answer now, using only what the tool results above already contain. Do not request any more tools. If those results do not answer the question, say plainly what is missing.';

/**
 * The same instruction for a caller that needs a machine-readable reply.
 *
 * Kept separate because the prose wording actively breaks such a caller: telling
 * the journal to "answer in prose" at the end of its loop guarantees the reply
 * its own parser will reject, which is the failure the repair pass exists to
 * catch — no reason to cause it and then repair it.
 */
const FINAL_ANSWER_INSTRUCTION_STRUCTURED =
  'Stop gathering and answer now, using only what the tool results above already contain. Do not request any more tools. Reply in exactly the response format your instructions describe — the raw object only, no preamble and no markdown fences.';

/** Names the failure rather than restating the schema: the schema is already in the system prompt, and what went wrong is that the reply was prose. */
const FORMAT_REPAIR_INSTRUCTION =
  'That reply was not in the required format. Re-send the SAME content, formatted exactly as the response format described in your instructions — the raw object only, with no preamble, no explanation, and no markdown fences around it.';

/**
 * Tool-call markup that leaked into prose, cut off at the first marker.
 *
 * Observed for real: on the forced final turn, deepseek emitted
 * `<｜DSML｜tool_calls><｜DSML｜invoke name="gnomon_moment_detail">…` as ordinary
 * CONTENT — the model still wanted to call a tool, could not use the structured
 * channel, and wrote the call out in its own internal syntax instead. That
 * reached the owner as the answer.
 *
 * Omitting `tools` on the forced turn is the actual fix and this is the net
 * under it: models emit these markers in several dialects, a new one is a
 * provider update away, and the failure mode is showing a person raw markup
 * where their answer should be. Everything before the first marker is kept —
 * it is usually a real sentence — and a response that is nothing but markup
 * becomes empty, which the caller already handles as "no answer produced".
 */
const TOOL_MARKUP_PATTERNS = [/<｜/, /<\|[a-z_]*tool/i, /<tool_call>/i, /<function_calls>/i, /<invoke/i];

function stripLeakedToolMarkup(content: string): string {
  let cut = content.length;
  for (const pattern of TOOL_MARKUP_PATTERNS) {
    const match = pattern.exec(content);
    if (match && match.index < cut) cut = match.index;
  }
  return content.slice(0, cut).trim();
}

/**
 * A bounded, audited tool-calling loop over an OpenAI-compatible endpoint.
 *
 * This is the file `transport.ts` promises when it explains why Gnomon has no
 * agent SDK: an SDK owns the loop, and owning the loop means owning where the
 * audit row is written, which `runAuditedLlmCall` deliberately keeps as the
 * single write path to `llm_audit`. So the loop lives here, and every HTTP
 * round trip inside it is one ordinary audited call — the audit table stays a
 * complete record of what was sent and what came back, with no framework
 * batching several exchanges into one opaque entry.
 *
 * **Every failure is a tool result, never a throw.** A model that asked for a
 * tool that does not exist, sent arguments that do not parse, or hit a handler
 * that threw is told exactly that and gets to try again — which is the whole
 * difference between an agent that recovers and one that dies on a typo. The
 * only things that end a run are the round cap, the deadline, the budget, and
 * the model deciding it is finished.
 *
 * A run never ends by telling the owner it ran out of steps. When a bound is
 * hit, the loop makes one final call with `tool_choice: 'none'` — answer from
 * what you already have — because "I reached my tool limit" is an implementation
 * detail leaking into a personal assistant's reply.
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const maxTotalResultBytes = options.maxTotalResultBytes ?? DEFAULT_MAX_TOTAL_RESULT_BYTES;
  const knownTools = new Set(options.tools.map((tool) => tool.name));

  const messages: ChatCompletionMessage[] = [...options.messages];
  const rounds: ToolLoopRound[] = [];
  const toolsUsed: string[] = [];
  const seenCalls = new Set<string>();
  const startedAt = Date.now();
  let totalResultBytes = 0;

  /**
   * One re-ask when the caller's parser rejects the reply. Returns the original
   * content when there is no validator, when it already passes, or when the
   * retry itself fails — never worse than what came back the first time.
   */
  const repairFormat = async (content: string, roundIndex: number): Promise<string> => {
    if (!options.validate || options.validate(content)) return content;
    try {
      await options.beforeCall?.(roundIndex);
      // The rejected reply goes back as the assistant turn it was, so the model
      // reformats what it already wrote instead of researching the day again.
      messages.push({ role: 'assistant', content });
      const { result, ms } = await call(roundIndex, 'repair');
      rounds.push({ index: roundIndex, ms, auditId: result.auditId, calls: [] });
      options.onRound?.(rounds[rounds.length - 1]);
      const repaired = stripLeakedToolMarkup(result.content);
      return options.validate(repaired) ? repaired : content;
    } catch {
      return content;
    }
  };

  /**
   * `gather` is an ordinary round with tools on offer. `final` and `repair` both
   * close the tool channel and append one instruction — which instruction is the
   * whole difference, and getting it wrong is not cosmetic: a `final` turn that
   * says "answer in prose" to a caller whose parser wants JSON manufactures the
   * exact failure the repair pass then has to undo.
   */
  const instructionFor = (mode: 'final' | 'repair'): string => {
    if (mode === 'repair') return FORMAT_REPAIR_INSTRUCTION;
    return options.validate ? FINAL_ANSWER_INSTRUCTION_STRUCTURED : FINAL_ANSWER_INSTRUCTION;
  };

  const call = async (roundIndex: number, mode: 'gather' | 'final' | 'repair') => {
    const startedRound = Date.now();
    const forced = mode !== 'gather';
    const result = await runAuditedLlmCall({
      purpose: options.purpose,
      momentId: options.momentId ?? null,
      // A closing turn is sent with its instruction appended and NO tools at
      // all — see `finalAnswer` for why advertising them is what goes wrong.
      messages: forced ? [...messages, { role: 'user', content: instructionFor(mode) }] : messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeoutMs: options.requestTimeoutMs,
      tools: forced ? undefined : options.tools,
      toolChoice: undefined,
    });
    return { result, ms: Date.now() - startedRound, index: roundIndex };
  };

  /**
   * The one way this loop ends early: ask for prose, from what is already in
   * `messages`, with no further tools on offer.
   *
   * "No further tools" means the request carries no `tools` array at all, not
   * `tool_choice: 'none'` over a full tool list. The difference is not cosmetic.
   * Sending the schemas while forbidding their use leaves a model that has just
   * spent five rounds calling tools still primed to call one — and at least one
   * endpoint responds by writing the call out in its own internal syntax as
   * ordinary content, which then reaches the owner as their answer. Withholding
   * the schemas removes the temptation; `FINAL_ANSWER_INSTRUCTION` states the
   * same thing in a turn the model reads; `stripLeakedToolMarkup` is the net
   * under both.
   */
  const finalAnswer = async (roundIndex: number, stopReason: ToolLoopStopReason): Promise<ToolLoopResult> => {
    try {
      const { result, ms } = await call(roundIndex, 'final');
      rounds.push({ index: roundIndex, ms, auditId: result.auditId, calls: [] });
      options.onRound?.(rounds[rounds.length - 1]);
      const content = await repairFormat(stripLeakedToolMarkup(result.content), roundIndex + 1);
      return { content, rounds, toolsUsed, stopReason };
    } catch (error) {
      // The forced answer is itself a call, so it can fail on a budget that has
      // just run out. Returning what was gathered beats surfacing an exception
      // for a run that did real work.
      if (error instanceof BudgetExhaustedError) {
        return { content: '', rounds, toolsUsed, stopReason };
      }
      throw error;
    }
  };

  for (let roundIndex = 1; roundIndex <= maxRounds; roundIndex++) {
    try {
      await options.beforeCall?.(roundIndex);
    } catch (error) {
      if (!(error instanceof BudgetExhaustedError)) throw error;
      // Nothing gathered yet and no budget to gather with — there is no answer
      // to force, so report the stop rather than spending another call to say so.
      if (rounds.length === 0) return { content: '', rounds, toolsUsed, stopReason: 'budget' };
      return finalAnswer(roundIndex, 'budget');
    }

    const { result, ms } = await call(roundIndex, 'gather');

    if (result.toolCalls.length === 0) {
      rounds.push({ index: roundIndex, ms, auditId: result.auditId, calls: [] });
      options.onRound?.(rounds[rounds.length - 1]);
      // Stripped here too, not only on the forced turn: a model can trail a
      // half-written call onto the end of a genuine answer, and the marker is
      // never something the owner should be shown.
      const content = await repairFormat(stripLeakedToolMarkup(result.content), roundIndex + 1);
      return { content, rounds, toolsUsed, stopReason: 'answered' };
    }

    // Echoed back verbatim: the endpoint pairs each `role: 'tool'` message with
    // the call id from this turn, and a re-serialized approximation breaks that.
    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

    const calls: ToolCallRecord[] = [];
    for (const toolCall of result.toolCalls) {
      const callStarted = Date.now();
      let payload: string;
      let ok = true;
      let errorText: string | undefined;

      if (!knownTools.has(toolCall.name)) {
        ok = false;
        errorText = `no such tool: ${toolCall.name}`;
        payload = JSON.stringify({ error: errorText, availableTools: [...knownTools] });
      } else if (seenCalls.has(callKey(toolCall))) {
        // The most common way a loop stalls: the model re-issues an identical
        // call, reads the identical result, and re-issues it again. Saying so
        // explicitly is what breaks the cycle — a second identical result does not.
        ok = false;
        errorText = 'repeated an identical call';
        payload = JSON.stringify({
          error: `you already called ${toolCall.name} with these exact arguments and the result was the same. Call a different tool, change the arguments, or answer from what you have.`,
        });
      } else if (totalResultBytes >= maxTotalResultBytes) {
        ok = false;
        errorText = 'tool result budget exhausted';
        payload = JSON.stringify({ error: 'no room left for more tool output in this conversation — answer from what you already have.' });
      } else {
        seenCalls.add(callKey(toolCall));
        let args: unknown;
        try {
          args = toolCall.arguments.trim() === '' ? {} : JSON.parse(toolCall.arguments);
        } catch {
          ok = false;
          errorText = 'arguments were not valid JSON';
          args = undefined;
          payload = JSON.stringify({ error: 'arguments were not valid JSON', received: toolCall.arguments.slice(0, 400) });
        }

        if (ok) {
          try {
            const value = await options.execute(toolCall.name, args);
            payload = serializeResult(value, maxResultBytes);
          } catch (error) {
            ok = false;
            errorText = error instanceof Error ? error.message : String(error);
            payload = JSON.stringify({ error: errorText });
          }
        }
      }

      // `payload` is assigned on every branch above; the non-null assertion is
      // narrowing, not an assumption.
      const body = payload!;
      totalResultBytes += body.length;
      messages.push({ role: 'tool', content: body, toolCallId: toolCall.id });
      if (ok && !toolsUsed.includes(toolCall.name)) toolsUsed.push(toolCall.name);
      calls.push({ name: toolCall.name, arguments: toolCall.arguments, ok, ms: Date.now() - callStarted, ...(errorText ? { error: errorText } : {}) });
    }

    rounds.push({ index: roundIndex, ms, auditId: result.auditId, calls });
    options.onRound?.(rounds[rounds.length - 1]);

    if (Date.now() - startedAt > deadlineMs) return finalAnswer(roundIndex + 1, 'deadline');
  }

  return finalAnswer(maxRounds + 1, 'max-rounds');
}
