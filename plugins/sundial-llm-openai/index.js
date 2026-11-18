// OpenAI-compatible adapter: chat-completions (SSE) → dsh StreamChunks. One
// route per provider: Gnomon's own (`openai`, from .env) and any in config.json's
// `llm.providers`.
// Structure follows @deepseek-ai/dsh-llm-deepseek (the reference adapter),
// simplified: no thinking/reasoning wire fields, no settings/credentials seam,
// connection facts come from plugin config + ~/.sundial/.env (process.env wins).
// Named exports only — a default export drops `inject`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
} from '@deepseek-ai/dsh-llm'
import { DEFAULT_PROVIDER, LEGACY_PROVIDER, ledgerModel, piAiProfiles, providerKeyEnv, providerLabel } from '@sundial/helpers/llm-providers.js'
import { judgedOf, PACE, paceSwitch, SLOW_LINE } from './pace.js'
import * as piAi from '@deepseek-ai/dsh-llm-pi-ai'
import { claudeBinary } from '@sundial/llm/index.js'
import { RuntimeAdapter } from './runtime-adapter.js'
import { trimSteps } from './task-trim.js'
import { createTaskEnd } from './task-end.js'
import { CALL_CAP_MS, slowStatus, stall, STALL_MS } from './stall.js'
import { taskOf as chatTask } from '@sundial/helpers/task-of.js'
import { answered, answerSentence, HELD, LONE_CURSOR, sayable } from '../sundial-tools/answer-only.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'
import { readSundialEnvFile } from '@sundial/helpers/sundial-env.js'

export { CALL_CAP_MS, HEDGE_LINES, SILENT_CODE, SILENT_LINE, slowLine, stall, STALL_MS } from './stall.js'

export const name = 'sundial-llm-openai'
export const inject = ['llm']

/** Gnomon's own route. */
export const PROVIDER = DEFAULT_PROVIDER

const DEFAULT_ENV_FILE = path.join(process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial'), '.env')
const BASE_URL_ENV = 'SUNDIAL_LLM_BASE_URL'
const MODEL_ENV = 'SUNDIAL_LLM_MODEL'
const DEFAULT_API_KEY_ENV = 'SUNDIAL_LLM_API_KEY'
const DEFAULT_MODEL = 'z-ai/glm-5.3-flash'
/**
 * The window a model gets when nobody names it: config.json
 * `llm.contextWindows[model]` first, then what the provider's `/models` reports
 * (OpenRouter's `top_provider.context_length`), then plugin config
 * `contextWindow`, then this. A chat is compacted after its turn, well before
 * the window (sundial-actions/chat-notes.js), so a real window here only keeps
 * dsh's in-turn compaction out of the way.
 */
const DEFAULT_CONTEXT_WINDOW = 64_000
/** How long a `/models` report is used before it is asked again. */
const DISCOVERY_TTL_MS = 10 * 60_000

/**
 * dsh's reasoning effort → the OpenAI-standard `reasoning_effort` field.
 * `off` matters most: qwen/qwen3.8-flash-next reasons by default and, on a
 * short max_tokens, spends the whole budget reasoning and returns nothing.
 * Measured 2026-09-06: `reasoning_effort: "none"` switches it off on TensorX;
 * deepseek (no reasoning) ignores the field. Undefined leaves the model's own
 * default, because a chat turn may want the reasoning the client can show.
 */
export function reasoningField(effort) {
  if (effort === undefined) return {}
  if (effort === 'off') return { reasoning_effort: 'none' }
  return { reasoning_effort: effort }
}

// ---------------------------------------------------------------------------
// Env file (read by helpers' `readSundialEnvFile`, the one parser; values are
// NEVER logged anywhere). ~/.sundial/.env is the one env file, and existing
// process.env values win over file values.
// ---------------------------------------------------------------------------

/** Read one env var: process.env wins over the parsed env file. */
function envValue(fileEnv, key) {
  const ambient = process.env[key]
  if (ambient !== undefined && ambient.length > 0) return ambient
  const fromFile = fileEnv[key]
  return fromFile !== undefined && fromFile.length > 0 ? fromFile : undefined
}

// ---------------------------------------------------------------------------
// Serialize: harness GenerateOptions → OpenAI chat-completions request body.
// Same mapping as the reference adapter, minus DeepSeek thinking fields.
// ---------------------------------------------------------------------------

function flattenText(blocks) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/**
 * Images are allowed in USER content and nowhere else.
 *
 * This adapter refused every image outright until 2026-09-10, on the
 * assumption that the route's models were text-only. Measured against the live
 * endpoint that assumption was wrong: a 64x64 solid-red PNG sent as an
 * OpenAI `image_url` part came back correctly described as "Red" by
 * `qwen/qwen3.8-flash-next` (the default) and by `moonshotai/kimi-k3`.
 * `z-ai/glm-5.2` answered "Blue" — accepted the part and did not read it — so
 * a wrong answer is possible per model, and the refusal moves to where it is
 * still true rather than being deleted.
 *
 * System, assistant and tool content stay text-only: `ImageBlock`'s own doc
 * calls assistant-side images forward compatibility, and this route's models
 * emit text.
 */
function assertNoImage(blocks, role) {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      `The OpenAI-compatible adapter does not support image content in a ${role} message.`,
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * One user message's wire content: a plain string, or OpenAI content parts when
 * the message carries images.
 *
 * A string when there are no images, deliberately — every request this adapter
 * has ever sent used the string form, and switching all of them to the parts
 * form to serve the rare message with a picture in it would be a change to
 * every call rather than to the ones that need it.
 *
 * An image whose bytes could not be read is DROPPED with a marker in the text
 * rather than failing the turn: the owner asked a question and most of it is
 * answerable without the attachment.
 */
function serializeUserContent(message, imageData) {
  const text = flattenText(message.content)
  const images = message.content.filter((block) => block.type === 'image')
  if (images.length === 0) return text

  const parts = []
  if (text.length > 0) parts.push({ type: 'text', text })
  let missing = 0
  for (const block of images) {
    const url = imageData.get(block.attachment?.attachmentId)
    if (url === undefined) {
      missing += 1
      continue
    }
    parts.push({ type: 'image_url', image_url: { url } })
  }
  if (missing > 0) parts.unshift({ type: 'text', text: `[${missing} image${missing === 1 ? '' : 's'} could not be read and are not shown]` })
  return parts.length > 0 ? parts : text
}

function serializeAssistant(message) {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  const toolCalls = message.content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: text,
    // Thinking-mode passback (DeepSeek requirement): replay reasoning only on tool-call turns.
    ...(toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

export function serializeMessages(messages, imageData = new Map()) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') {
      assertNoImage(message.content, 'system')
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      assertNoImage(message.content, 'assistant')
      wire.push(serializeAssistant(message))
      continue
    }
    // dsh 0.2 (session format V4): a tool result is its own `tool` message, with
    // the call id on the message. An unanswered tool call is a 400 at the provider.
    if (message.role === 'tool') {
      assertNoImage(message.content, 'tool result')
      wire.push({ role: 'tool', tool_call_id: message.toolCallId, content: flattenText(message.content) || '(no output)' })
      continue
    }
    // dsh 0.2's `developer` role (an agent session change mid-conversation). The
    // OpenAI-compatible endpoints this route serves know `system`, not `developer`.
    if (message.role === 'developer') {
      assertNoImage(message.content, 'developer')
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    // Older logs (format V3) carried a tool result as a block inside a user message.
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    for (const result of toolResults) assertNoImage(result.content, 'tool result')
    const content = serializeUserContent(message, imageData)
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0 || Array.isArray(content)) {
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Background calls that write a short, known shape and gain nothing from
 * thinking first. On the reasoning default model they spent their budget
 * thinking: the thread namer returned nothing 76 times in 76 on 64 tokens, and
 * compaction used 6,072 of its 8,192 on the conversation it summarised. A
 * caller that asks for an effort still gets it.
 */
export const QUIET_PURPOSES = new Set(['session-title', 'compaction', 'chat-notes'])

/** dsh's own chat turn: a session and no purpose (the ledger files it as 'ask'). */
export const isChatTurn = (options) => options.sessionId !== undefined && options.purpose === undefined

/** The effort a request is sent with: the caller's; off for a quiet purpose; for a chat turn the owner's `llm.chatReasoning`; else the model's own. */
export const effortOf = (options, chat) => options.reasoningEffort ?? (QUIET_PURPOSES.has(options.purpose) ? 'off' : isChatTurn(options) ? chat : undefined)

/** `task`: Set 4 R1, this chat's task object (`state.tasks`, helpers `taskOf`); a chat turn's history is cut behind it (task-trim.js). */
export function serializeRequest(options, imageData = new Map(), chatReasoning, task = null) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(isChatTurn(options) ? trimSteps(options.messages, task) : options.messages, imageData))
  // The chat call right after a tool whose result is the reply (gnomon_pull_up) goes without tools (answer-only.js says why here).
  // Not tools plus tool_choice "none": an openai-compatible route may pass it on to a backend that ignores it, and a real
  // tool call then reopens the hunt; with no tools there is nothing to call, and markup printed instead is cut (saidOnly).
  const tools = (isChatTurn(options) && answered(options.messages) ? [] : options.tools)?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...reasoningField(effortOf(options, chatReasoning)),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

// ---------------------------------------------------------------------------
// SSE: raw byte stream → data payloads, `[DONE]` last (hand-rolled, no deps).
// ---------------------------------------------------------------------------

/** `signal` cancels the read: run 248 T18, a Stop must end a call whose body sends nothing, whatever the transport does with an abort. */
export async function* parseSse(stream, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = stream.getReader()
  const cancel = () => void reader.cancel(signal.reason).catch(() => {})
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, sep)
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '')
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data.length === 0) continue // comments / other fields
        yield data
        if (data === '[DONE]') return
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

// ---------------------------------------------------------------------------
// Translate: OpenAI SSE payloads → dsh StreamChunks. Copied from the reference
// adapter: one block per content/reasoning/tool index, indices in first-seen
// order; block-ends, usage, and finish all deferred to the [DONE] sentinel so
// usage always precedes finish and nothing follows finish.
// ---------------------------------------------------------------------------

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop':
      return { kind: 'stop' }
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/** Harness TokenUsage counts are DISJOINT: cache reads are subtracted from inputTokens. */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

function closeBlock(block, tools) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return {
        type: 'tool-call',
        id: ToolCallId(block.callId ?? ''),
        name: block.name ?? '',
        arguments: plainLists(block.text, tools?.find((t) => t?.function?.name === block.name)?.function?.parameters?.properties),
      }
  }
}

/**
 * Runs 207 to 210: the route sent a list argument as {"item": [...]}, {"item": "x"} or a list of {"item": "x"}, the
 * shape of an XML list. web_search refused every one and screen_act some: 3, 7, 9 and 6 calls a run went nowhere. An
 * argument the tool's schema leaves open to a list (`array`, or no type: dsh sends a `json` one so) that is an object
 * with the one key `item` is that list, and a list's `{item: x}` is x. Nothing deeper, never `values` (a route's map
 * of texts, which screen-pick reads itself: {"values": {"item": "crate"}} is a field named item), never an argument
 * the schema types otherwise or does not name, and text that is no object stays exactly as it came.
 */
const isItem = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'item' in v
const inner = (v) => (isItem(v) ? inner(v.item) : v)
const listOf = (v) => (Array.isArray(inner(v)) ? inner(v) : [inner(v)]).map(inner)
const listy = (props, k) => k !== 'values' && props?.[k] !== undefined && (props[k].type === undefined || [props[k].type].flat().includes('array'))
function plainLists(text, props) {
  const args = (() => { try { return JSON.parse(text) } catch { return null } })()
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return text
  const plain = JSON.stringify(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, listy(props, k) && (isItem(v) || Array.isArray(v)) ? (isItem(v) ? listOf(v) : v.map(inner)) : v])))
  return plain === JSON.stringify(args) ? text : plain
}

export async function* translate(payloads, tools) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage
  // Set 4 R1: the host the route says served the call (OpenRouter's `provider`), for the ledger.
  const served = {}

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block, tools) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
        ...(served.upstream ? { upstream: served.upstream } : {}),
        reason:
          reason.kind === 'stop' && order.length === 0
            ? {
                kind: 'error',
                failure: {
                  message: 'model returned a completed response with no content',
                  code: EMPTY_RESPONSE_CODE,
                },
              }
            : reason,
      }
      return
    }
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
    if (typeof chunk.provider === 'string' && chunk.provider) served.upstream = chunk.provider
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

/**
 * A chat turn's text as it may be said (answer-only.js `sayable`): nothing from the first tool-call markup or think tag on is streamed,
 * a tail that may open markup ("<", "]", "`") waits for the next delta, and the block's end carries the cleaned text (the
 * message dsh keeps and the owner is said). Run 209 T12 said "<tool_call> <invoke name=..." aloud.
 */
export async function* saidOnly(chunks, messages) {
  const texts = new Map()
  // Set 4 R1: after a worked pull-up the reply is its sentence (sayable), streamed whole at the model's first word.
  const line = answered(messages) ? answerSentence(messages) : null
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') {
      const b = texts.get(chunk.index) ?? { text: '', sent: 0 }
      texts.set(chunk.index, b)
      if (line) {
        if (b.sent === 0) yield { ...chunk, text: line }
        b.text = line
        b.sent = line.length
        continue
      }
      b.text += chunk.text
      const at = b.text.search(HELD)
      const open = b.text.slice(-24).search(/[<\]`][^<\]`]*$/)
      // Run 250 T19: a lone cursor ("█") waits; sayable drops it at the block's end.
      const safe = LONE_CURSOR.test(b.text) ? b.sent : at >= 0 ? at : open >= 0 ? b.text.length - Math.min(24, b.text.length) + open : b.text.length
      if (safe > b.sent) yield { ...chunk, text: b.text.slice(b.sent, safe) }
      b.sent = Math.max(b.sent, safe)
      continue
    }
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      const sent = (texts.get(chunk.index)?.text ?? '').slice(0, texts.get(chunk.index)?.sent ?? 0)
      const said = sayable(chunk.block.text, messages)
      if (said.length > sent.length && said.startsWith(sent)) yield { type: 'text-delta', index: chunk.index, text: said.slice(sent.length) }
      yield said === chunk.block.text ? chunk : { ...chunk, block: { ...chunk.block, text: said } }
      continue
    }
    // Run 219 T13: the call after a worked pull-up went with no tools, and a tool call came back all the same (the route reads
    // minimax's own call syntax), so a look ran and the model said no ring was visible. After an answering tool a tool call is
    // never made: it is the tool's sentence, said once, and the turn ends.
    if (line && (chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')) {
      if (chunk.type === 'block-start' && texts.size === 0) {
        texts.set(chunk.index, { text: line, sent: line.length })
        yield { type: 'block-start', index: chunk.index, blockType: 'text' }
        yield { type: 'text-delta', index: chunk.index, text: line }
      }
      if (chunk.type === 'block-end' && texts.has(chunk.index)) yield { type: 'block-end', index: chunk.index, block: { type: 'text', text: line } }
      continue
    }
    yield line && chunk.type === 'finish' && chunk.reason?.kind === 'tool-calls' ? { ...chunk, reason: { kind: 'stop' } } : chunk
  }
}

// ---------------------------------------------------------------------------
// Hedge: a chat call whose first token is late is sent once more.
// ---------------------------------------------------------------------------

/**
 * Live test run 3 (2026-11-12, glm-5.3-flash on TensorX): 7 of 75 chat calls took
 * 11.6 to 55.8 s, 183 of 432 s of model time, and prompt size did not explain it
 * (<30k tokens 5.6 s avg, >80k 6.1 s). A stall at the provider, not work: so the
 * same request again, raced. config.json `llm.hedgeAfterMs` overrides it; 0 is off.
 */
export const HEDGE_AFTER_MS = 8000

/** Chunks that prove the model is answering. */
const FIRST_TOKEN = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta'])

/**
 * Run `start(signal, hedging)` and, when it has no first token after `after` ms, run it a
 * second time; the first of the two to produce a token is the stream, the other is aborted.
 * Before the hedge a failure is the call's failure (a hedge is not a retry); after it a
 * failed attempt drops out (a 429 on the second keeps the first) and only both failing
 * throws, with the first one's error. The caller's signal aborts both. `names` label the
 * two in the log and the finish chunk.
 */
export async function* hedge(start, { signal, after, log = () => {}, names = ['first', 'second'] }) {
  const attempts = []
  const launch = (hedging) => {
    const controller = new AbortController()
    const forward = () => controller.abort(signal.reason)
    if (signal?.aborted) forward()
    else signal?.addEventListener('abort', forward, { once: true })
    const attempt = { controller, head: [], ended: false, iterator: start(controller.signal, hedging)[Symbol.asyncIterator](), release: () => signal?.removeEventListener('abort', forward) }
    attempt.first = (async () => {
      for (;;) {
        const step = await attempt.iterator.next()
        if (step.done) return ((attempt.ended = true), attempt)
        attempt.head.push(step.value)
        if (FIRST_TOKEN.has(step.value.type)) return attempt
      }
    })()
    attempts.push(attempt)
    return attempt
  }
  let winner
  try {
    const first = launch(false)
    let timer
    try {
      winner = await Promise.race([first.first, new Promise((resolve) => (timer = setTimeout(resolve, after, null)))])
    } finally {
      clearTimeout(timer)
    }
    // The finish chunk carries the outcome, for a listener that wants it.
    let tag = (chunk) => chunk
    if (winner === null) {
      const second = launch(true)
      const outcome = await new Promise((resolve) => {
        let failed = 0
        for (const attempt of attempts) attempt.first.then(resolve, (error) => ((attempt.error = error), ++failed === attempts.length && resolve(null)))
      })
      const name = outcome === first ? names[0] : outcome === second ? names[1] : null
      const why = outcome === first && second.error ? ` (second failed: ${(second.error?.message ?? String(second.error)).slice(0, 120)})` : ''
      log(`hedged after ${after} ms, winner ${name ?? 'none: both failed'}${why}`)
      if (outcome === null) await first.first
      winner = outcome
      tag = (chunk) => (chunk.type === 'finish' ? { ...chunk, hedged: true, winner: name } : chunk)
    }
    for (const chunk of winner.head) yield tag(chunk)
    if (!winner.ended) {
      for (;;) {
        const step = await winner.iterator.next()
        if (step.done) break
        yield tag(step.value)
      }
    }
  } finally {
    for (const attempt of attempts) {
      if (attempt !== winner) {
        attempt.controller.abort()
        attempt.first.catch(() => {})
      }
      attempt.iterator.return?.().catch(() => {})
      attempt.release()
    }
  }
}

// ---------------------------------------------------------------------------
// Offline: a chat route that cannot be reached falls to its backup at once.
// ---------------------------------------------------------------------------

/**
 * Set 2 R4: a chat request with no HTTP response in this long is unreachable (a blackholed host); a refused
 * connection or a DNS miss is unreachable at once. Then the backup, instead of the hedge and the stall's resend
 * waiting out a host that is not there. Two dead routes in a row are 14 s, inside the 15 s the owner is promised.
 */
export const CONNECT_MS = 7000
export const NO_MODEL_LINE = 'No model is answering right now; try again in a minute.'
/** Set 4 R2: the offline lines name the backup route, and whether it answered (the slip reads them, slip-read.js `endOf`). */
export const fallbackLine = (route) => `The model is not answering; trying the backup, ${route}.`
export const answeredLine = (route) => `The backup, ${route}, answered.`
export const noBackupLine = (route) => `No model is answering: the backup, ${route}, did not answer either. Try again in a minute.`
/** The route the rig points one thread at (`experiments.rigOffline`, off by default): a closed port, every call refused. */
export const RIG_OFFLINE = { id: 'rig-offline', model: 'offline', baseUrl: 'http://127.0.0.1:9' }

const reasonOf = (error) => {
  const code = error?.cause?.code ?? error?.code
  return code === 'ECONNREFUSED' ? 'refused' : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : 'unreachable'
}

/** `chunks` with `fellBack {route, model}` on their finish: the ledger files the call under `to`, the route that answered. */
export async function* filedUnder(to, chunks) {
  const fellBack = { route: to.route.split(':')[0], model: to.model }
  for await (const chunk of chunks) yield chunk.type === 'finish' ? { ...chunk, fellBack } : chunk
}

/** `to.start` as the backup: the turn says so, and its finish carries `fellBack {route, model}`, so the ledger files the call under the route that answered. */
export function onBackup(to, say) {
  const fellBack = { route: to.route.split(':')[0], model: to.model }
  say(fallbackLine(fellBack.route), false)
  return async function* (signal) {
    let heard = false
    for await (const chunk of to.start(signal)) {
      if (!heard) (heard = true), say(answeredLine(fellBack.route), false)
      yield chunk.type === 'finish' ? { ...chunk, fellBack } : chunk
    }
  }
}

/**
 * Run `start(signal)`; when it fails to reach its route before its first chunk (an error with `unreached`), write
 * `llm:failed {route, reason}`, then `llm:fallback {from, to}` and run `backup().start(signal)` the same way. With no
 * backup, or the backup unreachable too, `say` the honest line and throw a code dsh does not retry, so the turn ends.
 * The backup's finish carries `fellBack {route, model}`, so the ledger files the call under the route that answered
 * and the dead one's streak keeps counting toward its breaker.
 * `say(line, failed)` puts one line in the turn; `note(type, payload)` appends a row.
 */
export async function* offline(start, { signal, route, backup = () => undefined, note = () => {}, say = () => {} }) {
  async function* reach(go, name) {
    let quiet = true
    try {
      for await (const chunk of go(signal)) {
        quiet = false
        yield chunk
      }
    } catch (error) {
      if (!quiet || !error?.unreached || signal?.aborted) throw error
      note('llm:failed', { route: name, reason: error.unreached, errorClass: error.unreached === 'timeout' ? 'timeout' : 'network' })
      return error
    }
  }
  if (!(yield* reach(start, route))) return
  const to = backup()
  if (to) {
    note('llm:fallback', { from: route, to: to.route })
    if (!(yield* reach(onBackup(to, say), to.route.split(':')[0]))) return
  }
  say(to ? noBackupLine(to.route.split(':')[0]) : NO_MODEL_LINE, true)
  throw new LlmError(NO_MODEL_LINE, 'UNREACHABLE')
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Statuses the route recovers from on its own, given a moment. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const RETRY_STATUS_ATTEMPTS = 3
const RETRY_BASE_MS = 700

/** Does this 400 say the model cannot switch its reasoning off? Reads a clone; the body stays for the error path. */
async function refusesReasoningOff(response) {
  try {
    return /thinking|reasoning/i.test(String((await response.clone().json())?.error?.message ?? ''))
  } catch {
    return false
  }
}

/** A provider's "the prompt is longer than the window", so dsh's overflow guard compacts and retries. */
const CONTEXT_OVERFLOW = /context (length|window)|maximum context|prompt is too long|too many (input )?tokens/i

function httpErrorCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export class OpenAICompatAdapter extends LlmAdapter {
  /**
   * @param facts - { baseUrl, model, resolveApiKey } resolved by the plugin.
   * Optional facts let another plugin reuse this adapter for a different
   * OpenAI-compatible endpoint: `label` (provider display name + error
   * prefix), `models` (the list the picker offers: `{ id, description? }[]`,
   * the default model is added at the front when missing), `contextWindow`.
   */
  constructor(facts) {
    super()
    this.facts = facts
    this.label = facts.label ?? providerLabel(facts.baseUrl)
  }

  providerInfo(provider) {
    return { id: provider, name: this.label }
  }

  providerRetryPolicy(_provider) {
    return undefined // normal harness defaults
  }

  /**
   * Ask the provider what it serves (`GET {baseUrl}/models`, the OpenAI
   * standard), with each model's window when it says (OpenRouter:
   * `top_provider.context_length`, which can be smaller than the model's own
   * `context_length`; TensorX says nothing). One lookup at a time; never throws.
   * Only a real list is kept: a failed lookup (a cold DNS miss, a slow reply)
   * cached as empty hid every model but the default for ten minutes.
   */
  lookup() {
    this.looking ??= (async () => {
      try {
        const key = await this.facts.resolveApiKey()
        const res = await fetch(`${this.facts.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
        const body = res.ok ? await res.json() : null
        const listed = Array.isArray(body?.data) ? body.data.filter((m) => typeof m?.id === 'string' && m.id !== '') : []
        const windows = new Map()
        for (const m of listed) {
          const window = m.top_provider?.context_length ?? m.context_length
          if (Number.isInteger(window) && window > 0) windows.set(m.id, window)
        }
        if (listed.length > 0) this.discovered = { at: Date.now(), models: listed.map((m) => ({ id: m.id })), windows }
      } catch {
        /* the picker falls back to the configured model */
      } finally {
        this.looking = undefined
        this.lookedAt = Date.now()
      }
    })()
    return this.looking
  }

  /** What the provider serves, cached ten minutes; a provider that cannot list gives only the configured model. */
  async discover() {
    if (this.facts.models) return this.facts.models
    if (!this.discovered || Date.now() - this.discovered.at >= DISCOVERY_TTL_MS) await this.lookup()
    return this.discovered?.models ?? []
  }

  /** The route's catalogue, default first. */
  models(listedModels = this.facts.models ?? []) {
    const listed = listedModels.filter((m) => typeof m?.id === 'string' && m.id !== '')
    const current = listed.find((m) => m.id === this.facts.model)
    const rest = listed.filter((m) => m.id !== this.facts.model)
    return [current ?? { id: this.facts.model, description: `Served by ${this.label}` }, ...rest]
  }

  async listModels(provider) {
    return this.models(await this.discover()).map((m) => ({
      provider,
      id: m.id,
      name: m.id,
      description: m.description ?? `Served by ${this.label}`,
      inputModalities: ['text'],
    }))
  }

  /**
   * dsh asks this before every call, so it waits on the provider's report only
   * the first time; after that it uses the last one and refreshes it behind.
   */
  async resolveModel(provider, model, _signal) {
    if (this.lookedAt === undefined && !this.facts.models) await this.lookup()
    else if (!this.facts.models && Date.now() - this.lookedAt >= DISCOVERY_TTL_MS) void this.lookup()
    return {
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: this.facts.contextWindows?.[model] ?? this.discovered?.windows.get(model) ?? this.facts.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    }
  }

  /**
   * `attachmentId` → `data:` URI, for the image blocks in these messages.
   *
   * An `ImageBlock` carries a content-addressed REF, not bytes — the attachment
   * service owns the bytes so a transcript does not carry base64 for the life
   * of the session. The wire format needs the bytes, so they are read here, once
   * per request, and only for the refs actually present.
   *
   * Never throws: `serializeUserContent` drops an unreadable image with a
   * marker instead of failing a turn the rest of which is answerable.
   */
  async resolveImages(messages) {
    const refs = new Map()
    for (const message of messages ?? []) {
      if (message.role !== 'user') continue
      for (const block of message.content ?? []) {
        if (block.type === 'image' && block.attachment?.attachmentId !== undefined) refs.set(block.attachment.attachmentId, block.attachment)
      }
    }
    if (refs.size === 0) return new Map()

    const read = this.facts.readImage
    if (typeof read !== 'function') return new Map()
    const data = new Map()
    for (const [id, ref] of refs) {
      try {
        const stored = await read(ref)
        const bytes = stored?.data
        if (bytes === undefined) continue
        data.set(id, `data:${ref.mediaType};base64,${Buffer.from(bytes).toString('base64')}`)
      } catch {
        // Left out of the map; the serializer says so in the message.
      }
    }
    return data
  }

  /** One request's body and headers. A provider's `body` goes under the fields set here. */
  async prepare(options) {
    const apiKey = await this.facts.resolveApiKey()
    const body = { ...this.facts.body, ...serializeRequest(options, await this.resolveImages(options.messages), this.facts.chatReasoning, this.facts.taskOf?.(options.sessionId) ?? null) }
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      ...(options.sessionId !== undefined
        ? { 'x-gnomon-session-id': String(options.sessionId) }
        : {}),
    }
    return { body, headers }
  }

  /** One try at one request, for a route hedging or falling onto this one. */
  async *single(options, signal, tries = 1) {
    const { body, headers } = await this.prepare(options)
    yield* this.request(body, headers, signal, tries, this.facts.connectMs ?? CONNECT_MS)
  }

  /** Where a chat call that cannot reach this route goes: `hedgeTo`, else the next route `llm.roles.chat` lists after this one (its first, when this one is not listed). */
  fallbackFor(model) {
    if (this.backup) return this.backup
    const listed = (this.facts.chatRoles?.() ?? []).map((entry) => {
      const [route, named] = entry.split(/:(.*)/)
      const adapter = this.routes?.get(route)
      return adapter && { adapter, model: named || adapter.facts.model, route: `${route}:${named || adapter.facts.model}` }
    }).filter(Boolean)
    const at = listed.findIndex((c) => c.adapter === this && c.model === model)
    return listed.slice(at + 1).find((c) => c.adapter !== this)
  }

  /**
   * Set 4 R1: the backup this chat call goes to while the route runs at over twice its own usual pace (pace.js), else
   * null. The switch each way is one `llm:fallback` row (reason `slow`, `recovered`); the slow one says SLOW_LINE once.
   */
  async paced(options, note, say) {
    const via = this.fallbackFor(options.model)
    if (!via || !this.facts.pace) return null
    // One verdict a turn (keyed on the owner's message count): the three ledger reads took about 160 ms cold on the live
    // record (the two pace scans 92 and 66 ms, the switch row 1 ms), too much before every step.
    const turn = `${options.sessionId}:${(options.messages ?? []).filter((m) => m?.role === 'user').length}`
    // Doc 31: and again every probeMs inside a long turn, so a probe (and the switch back) is not only ever a turn's first call.
    if (this.paceTurn?.key !== turn || Date.now() - this.paceTurn.at >= PACE.probeMs) this.paceTurn = { key: turn, at: Date.now(), use: this.judgePace(options, via, note) }
    const use = await this.paceTurn.use
    // A probe is one call (pace.js `probeMs`), not the turn: run 214 T01 sent all eight of its steps to the slow route as the probe.
    // The next step reads the ledger again, and finds the probe there.
    if (use === 'probe' && this.paceTurn?.key === turn) this.paceTurn = null
    if (use !== 'backup') return null
    // Every call on the backup says so, as a dead route's fallback does: the owner always sees who answers.
    say(SLOW_LINE, false)
    return { route: via.route, model: via.model, start: (s) => via.adapter.single({ ...options, model: via.model }, s, RETRY_STATUS_ATTEMPTS) }
  }

  /** pace.js's verdict for this route now, writing the switch row when it is one; `primary` when nothing can be read. */
  async judgePace(options, via, note) {
    const theirs = via.route.split(':')[0]
    const read = await Promise.resolve(this.facts.pace(this.facts.id, ledgerModel(options.model, this.facts.id, this.facts.baseUrl), theirs, ledgerModel(via.model, theirs, via.adapter.facts.baseUrl))).catch(() => null)
    if (!read) return 'primary'
    const v = paceSwitch({ ...read, now: Date.now() })
    if (v.change === 'slow') note('llm:fallback', { from: this.facts.id, to: via.route, reason: 'slow', ...judgedOf(v, this.facts.id) })
    if (v.change === 'recovered') note('llm:fallback', { from: via.route, to: this.facts.id, reason: 'recovered', ...judgedOf(v, this.facts.id), ...(v.why && { why: v.why }) })
    return v.use
  }

  async *stream(options) {
    const { body, headers } = await this.prepare(options)
    const after = this.facts.hedgeAfterMs ?? HEDGE_AFTER_MS
    const connectMs = this.facts.connectMs ?? CONNECT_MS
    const fallback = () => {
      const to = this.fallbackFor(options.model)
      return to && { route: to.route, model: to.model, start: (s) => to.adapter.single({ ...options, model: to.model }, s) }
    }
    const note = (type, payload) => this.facts.tell?.({ type, payload: { ...payload, sessionId: String(options.sessionId) } })
    // A chat's notes (sundial-actions chat-notes.js) fall to the chat's backup too: a dead primary dropped them silently.
    if (options.purpose === 'chat-notes') return yield* offline((s) => this.request(body, headers, s, RETRY_STATUS_ATTEMPTS, connectMs), { signal: options.signal, route: this.facts.id, backup: fallback, note })
    if (!isChatTurn(options)) return yield* this.request(body, headers, options.signal)
    const log = (line) => console.log(`[sundial-llm-openai] ${this.label}: ${line}`)
    const key = `${options.sessionId}:${Date.now()}`
    const say = (line, failed) => (log(line), this.facts.tell?.({ line: { sessionId: String(options.sessionId), key, line, failed } }))
    // Set 4 R1: a slow route's calls go to its backup, filed under it; the slow route is that call's own backup.
    const stallMs = this.facts.stallMs ?? STALL_MS
    const cap = this.facts.callCapMs ?? CALL_CAP_MS
    const status = slowStatus({ say, after: this.facts.slowStatusMs })
    // Run 256 T21: the stall watch, the thought limit and the cap wrap the whole call, so a route that cannot be reached
    // and the backup it falls to are watched as one call: a fallback that streamed hidden thought for 177 s had none.
    // Doc 31: each time it fires, one `llm:stalled` row (reason stall, thought or cap), so a bench can count them.
    const guard = (start, retry, route = this.facts.id) => (stallMs > 0 ? stall(start, { signal: options.signal, after: stallMs, think: this.facts.thinkMs, retry, cap, log, say, fired: (f) => note('llm:stalled', { route, ...f }) }) : start(options.signal))
    const slow = await this.paced(options, note, say)
    if (slow) {
      const fellBack = { route: slow.route.split(':')[0], model: slow.model }
      const once = async function* (s) {
        for await (const chunk of slow.start(s)) yield chunk.type === 'finish' ? { ...chunk, fellBack } : chunk
      }
      // As the route itself is asked: its retries (in `single`) and the stall's resend, no hedge.
      // A backup that cannot be reached ends the switch (run 256 T21, 14:43): the next calls are not sent to it again first.
      const self = () => (note('llm:fallback', { from: slow.route, to: this.facts.id, reason: 'recovered', why: 'backup-down', primary: this.facts.id }), (this.paceTurn = null), { route: `${this.facts.id}:${options.model}`, model: options.model, start: (s) => this.request(body, headers, s, RETRY_STATUS_ATTEMPTS, connectMs) })
      return yield* saidOnly(status.pass(guard((s) => offline(once, { signal: s, route: fellBack.route, backup: self, note, say }), undefined, fellBack.route)), options.messages)
    }
    // A guess to measure in the log: a different session id lets the provider route the hedge to another backend.
    const hedgeHeaders = { ...headers, 'x-gnomon-session-id': `${options.sessionId}:hedge` }
    // The hedge does not retry a 429 or a 503: the first request is still there to wait on.
    // `hedgeTo` (set by apply): the hedge goes to that route, with its model, instead of this one again.
    const backup = this.backup
    // A hedge the backup wins is filed under the backup: under this route it counted toward this route's pace (doc 31).
    const second = (s) => (status.hedged(backup ? 'backup' : 'again'), backup ? filedUnder(backup, backup.adapter.single({ ...options, model: backup.model }, s)) : this.request(body, hedgeHeaders, s, 1, connectMs))
    const names = backup ? [`${this.facts.id}:${options.model}`, backup.route] : undefined
    const first = (s) => this.request(body, headers, s, RETRY_STATUS_ATTEMPTS, connectMs)
    const once = (signal) => (after > 0 ? hedge((s, hedging) => (hedging ? second(s) : first(s)), { signal, after, log, names }) : first(signal))
    // Runs 247 to 249: a stalled call's one resend goes to the backup route (hedgeTo, else the next chat route), filed under it.
    const resend = (signal) => {
      const to = fallback()
      if (!to) return once(signal)
      note('llm:fallback', { from: this.facts.id, to: to.route, reason: 'stalled' })
      status.hedged('backup')
      return onBackup(to, say)(signal)
    }
    // Set 2 R4: a route that cannot be reached falls to its backup now (looked up only then), and says so in the turn.
    yield* saidOnly(status.pass(guard((s) => offline(once, { signal: s, route: this.facts.id, backup: fallback, note, say }), resend)), options.messages)
  }

  /**
   * One request: open the stream (retrying a status the route recovers from), then translate it. With `connectMs`
   * (a chat turn), a request that is refused, misses DNS, or has no response in that long throws with `unreached`.
   */
  async *request(body, headers, signal, tries = RETRY_STATUS_ATTEMPTS, connectMs = 0) {
    // The route answers 503 "temporarily unavailable" while it swaps a model
    // in. dsh does not retry a step whose stream never opened — it closes the
    // turn with zero steps, and the owner sees an empty answer. Retry HERE,
    // before a single byte has streamed, where a repeat is still safe.
    // ponytail: fixed 3 tries, linear backoff; a real budget if it ever misses.
    let response
    for (let attempt = 0; ; attempt++) {
      const connect = new AbortController()
      const timer = connectMs > 0 ? setTimeout(() => connect.abort(), connectMs) : null
      try {
        response = await fetch(`${this.facts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timer === null ? signal : signal ? AbortSignal.any([signal, connect.signal]) : connect.signal,
        })
      } catch (error) {
        if (signal?.aborted) {
          throw new LlmError(`${this.label} request aborted by caller`, 'ABORTED', { cause: error })
        }
        if (connect.signal.aborted) throw Object.assign(new LlmError(`${this.label} sent no response in ${connectMs} ms`, 'TIMEOUT', { cause: error }), { unreached: 'timeout' })
        throw Object.assign(new LlmError(`${this.label} API request to ${this.facts.baseUrl} failed`, 'TRANSPORT', { cause: error }), connectMs > 0 ? { unreached: reasonOf(error) } : {})
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      // A reasoning model that cannot stop reasoning answers 400 "Disabling
      // thinking is not supported." to `reasoning_effort: "none"` (qwen3.8-2.4t
      // on TensorX, 2026-10-01: every thread title failed on it). Once, drop the
      // field and ask again: a quiet purpose would rather pay for thinking than
      // get nothing.
      if (response.status === 400 && 'reasoning_effort' in body && (await refusesReasoningOff(response))) {
        delete body.reasoning_effort
        continue
      }
      if (response.ok || attempt >= tries - 1 || !RETRY_STATUSES.has(response.status)) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * (attempt + 1)))
      if (signal?.aborted) throw new LlmError(`${this.label} request aborted by caller`, 'ABORTED')
    }
    if (!response.ok) {
      let message = `${this.label} API error (HTTP ${response.status})`
      try {
        const parsed = await response.json()
        if (parsed?.error?.message) message = parsed.error.message
      } catch {
        /* non-JSON error body */
      }
      const id = response.headers.get('x-request-id')
      const code = (response.status === 400 || response.status === 413) && CONTEXT_OVERFLOW.test(message) ? CONTEXT_WINDOW_EXCEEDED_CODE : httpErrorCode(response.status)
      throw new LlmError(message, code, {
        status: response.status,
        ...(id ? { requestId: ProviderRequestId(id) } : {}),
      })
    }
    if (!response.body) throw new LlmError(`${this.label} API returned no response body`, 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body, signal), body.tools)
    } catch (error) {
      if (signal?.aborted) {
        throw new LlmError(`${this.label} stream aborted by caller`, 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`${this.label} API stream from ${this.facts.baseUrl} failed`, 'TRANSPORT', {
        cause: error,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const envFile = config.envFile ?? DEFAULT_ENV_FILE
  // A missing env file is valid — shell exports may carry everything.
  const fileEnv = readSundialEnvFile(envFile)
  // Lazy and optional: `attachments` is provided by `attachment-local`, and
  // resolving it at call time means this plugin still loads on a profile
  // without it (cordis would otherwise make it a service to WAIT for).
  const readImage = async (ref) => ctx.get?.('attachments')?.readImage(ref)
  const { contextWindows, chatReasoning, hedgeAfterMs, stallMs, connectMs } = loadSundialConfig().llm
  // Set 2 R4: what a chat route that cannot be reached tells: a row on the record, and one line in its turn (the
  // theme pushes it to the slip and the web client). Read at call time, like `attachments`: nothing here waits on them.
  const tell = ({ type, payload, line }) => {
    try {
      if (type) void Promise.resolve(ctx.get?.('gnomonKernel')?.appendSignal(type, payload)).catch(() => {})
      if (line) ctx.emit?.('gnomon/llm-line', line)
    } catch {
      // Telling is never the call failing.
    }
  }
  const chatRoles = () => config.chatRoles ?? loadSundialConfig().llm.roles.chat ?? []
  // Set 4 R1: a chat route's pace evidence (pace.js), read at call time: its own answered calls and its newest switch row.
  const pace = async (route, model, backupRoute, backupModel) => {
    const q = ctx.get?.('gnomonDb')?.queries
    if (!q?.getRoutePace) return null
    const now = Date.now(), iso = (ms) => new Date(ms).toISOString()
    const calls = async (r, m, limit) => (await q.getRoutePace(r, m, iso(now - PACE.baseWindowMs), limit)).map((c) => ({ at: Date.parse(c.requestedAt), ms: c.latencyMs, pin: c.promptTokens, cached: c.cacheReadTokens }))
    const rows = await calls(route, model)
    const last = (await q.getSignalsInRange(iso(now - PACE.lookbackMs), iso(now + 1000), 200, ['llm:fallback'])).filter((r) => r.data?.primary === route && ['slow', 'recovered'].includes(r.data?.reason)).at(-1)
    return { rows, last: last ? { at: Date.parse(last.capturedAt), reason: last.data.reason } : null, backup: await calls(backupRoute, backupModel, PACE.backupCalls) }
  }
  // Set 4 R1: this chat's task object, read at call time like `tell`'s kernel (task-trim.js); another chat's task is never printed.
  const taskOf = (sessionId) => (sessionId === undefined ? null : chatTask(ctx.get?.('gnomonKernel')?.getState?.(), String(sessionId)))
  // Set 5 R1: how a chat's turn ended (`task:ended`), and the one finish nudge per task (task-end.js).
  const kernel = () => ctx.get?.('gnomonKernel')
  const taskEnd = createTaskEnd({ getState: () => kernel()?.getState?.(), appendSignal: (type, payload) => kernel()?.appendSignal(type, payload) })
  ctx.on?.('agent/turn-stopping', (payload) => taskEnd.stopping(payload))
  ctx.on?.('session/event', (session, event) => taskEnd.ended(session, event))
  const shared = { readImage, contextWindows, chatReasoning, hedgeAfterMs, stallMs, connectMs: config.connectMs ?? connectMs, tell, chatRoles, taskOf, pace }
  const keyFor = (apiKeyEnv) => async () => {
    const raw = envValue(fileEnv, apiKeyEnv)
    if (raw !== undefined) return assertUsableApiKey(raw, 'sundial-llm-openai', apiKeyEnv)
    // Local OpenAI-compatible servers (Ollama, llama.cpp) accept any bearer.
    return 'gnomon-local'
  }

  // Gnomon's own model, from .env. `tensorx` is the route's name from before
  // v0.2: conversations recorded then still name it, so it stays an alias the
  // picker does not list.
  const adapters = new Map()
  const baseUrlRaw = config.baseUrl ?? envValue(fileEnv, BASE_URL_ENV)
  if (baseUrlRaw === undefined) {
    // No model configured is a valid first run: Sundial records and shows the
    // day without one. The route stays unregistered, so a chat says it has no
    // model instead of the whole process refusing to boot.
    console.log(`[sundial-llm-openai] no model yet — set one on /setup, or ${BASE_URL_ENV} (and ${MODEL_ENV}) in ${envFile}`)
  } else {
    const models = Array.isArray(config.models) ? config.models.map((m) => (typeof m === 'string' ? { id: m } : m)) : undefined
    const baseUrl = baseUrlRaw.replace(/\/+$/, '')
    const model = config.model ?? envValue(fileEnv, MODEL_ENV) ?? DEFAULT_MODEL
    const adapter = new OpenAICompatAdapter({ id: PROVIDER, baseUrl, model, resolveApiKey: keyFor(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV), models, contextWindow: config.contextWindow, ...shared })
    ctx.llm.registerAdapter([PROVIDER, LEGACY_PROVIDER], adapter)
    adapters.set(PROVIDER, adapter)
  }

  // The vendor runtimes as chat routes (step 5): the owner's own Claude Code when its binary is
  // here, their own GitHub Copilot always (its picker list is empty without a plan, and a turn
  // says so). Tools reach them as Sundial's read tools over MCP; writes queue for the owner.
  const home = process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial')
  const runtimeRoutes = config.runtimeRoutes ?? (claudeBinary(loadSundialConfig().llm.sources?.claude?.path ?? null) ? ['claude', 'copilot'] : ['copilot'])
  for (const source of runtimeRoutes) {
    try {
      ctx.llm.registerAdapter([source], new RuntimeAdapter(source, { home }))
    } catch (error) {
      console.warn(`[sundial-llm-openai] runtime route ${source} not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // More providers, from config.json: one route each, picked per conversation.
  const providers = config.providers ?? loadSundialConfig().llm.providers
  // The ones this adapter does not speak (Anthropic messages, OpenAI responses) are one
  // dsh pi-ai instance, hand-declared route by route (`piAiProfiles`), mounted here so
  // every model route Sundial offers comes from one place. The profile patch keeps
  // dsh-base's own dormant pi-ai row off: two would collide on its discovery namespace.
  const spoken = piAiProfiles(providers)
  if (Object.keys(spoken).length > 0) {
    try {
      ;(config.mountPiAi ?? ((plugin, options) => ctx.plugin(plugin, options)))(piAi, { providers: spoken })
      console.log(`[sundial-llm-openai] pi-ai routes: ${Object.entries(spoken).map(([id, p]) => `${id} (${p.api})`).join(', ')}`)
    } catch (error) {
      console.warn(`[sundial-llm-openai] pi-ai routes not mounted: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const p of providers) {
    if (p.protocol && p.protocol !== 'openai-chat') continue
    try {
      const adapter = new OpenAICompatAdapter({ id: p.id, baseUrl: p.baseUrl, model: p.model, label: p.label, body: p.body, resolveApiKey: keyFor(providerKeyEnv(p.id)), ...shared })
      ctx.llm.registerAdapter([p.id], adapter)
      adapters.set(p.id, adapter)
    } catch (error) {
      console.warn(`[sundial-llm-openai] provider ${p.id} not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // `hedgeTo`, once every route exists. A route this adapter does not hold keeps today's self-hedge.
  for (const p of providers) {
    if (!p.hedgeTo || !adapters.has(p.id)) continue
    const [route, model] = p.hedgeTo.split(/:(.*)/)
    const backup = adapters.get(route)
    if (backup) adapters.get(p.id).backup = { adapter: backup, model: model || backup.facts.model, route: p.hedgeTo }
    else console.warn(`[sundial-llm-openai] provider ${p.id}: hedgeTo ${p.hedgeTo} is not a route here, hedging on itself`)
  }
  for (const adapter of adapters.values()) adapter.routes = adapters
  // Set 2 R4: the rig's unreachable route, only with `experiments.rigOffline`. The rig points one thread at it through
  // /gnomon/api/model; the owner's config is not touched. It sends no key, and falls to the chat's first route, else Gnomon's own.
  if (config.rigOffline ?? loadSundialConfig().experiments.rigOffline) {
    const rig = new OpenAICompatAdapter({ ...RIG_OFFLINE, label: 'Rig offline (closed port)', resolveApiKey: async () => 'rig-offline', ...shared })
    ctx.llm.registerAdapter([RIG_OFFLINE.id], rig)
    rig.routes = adapters
    const own = adapters.get(PROVIDER)
    rig.backup = rig.fallbackFor(RIG_OFFLINE.model) ?? (own && { adapter: own, model: own.facts.model, route: `${PROVIDER}:${own.facts.model}` })
    console.log(`[sundial-llm-openai] rig route ${RIG_OFFLINE.id} registered (experiments.rigOffline), backup ${rig.backup?.route ?? 'none'}`)
  }
}
