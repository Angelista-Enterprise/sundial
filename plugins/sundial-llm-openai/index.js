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
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ToolCallId,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
} from '@deepseek-ai/dsh-llm'
import { DEFAULT_PROVIDER, LEGACY_PROVIDER, providerKeyEnv, providerLabel } from '@sundial/helpers/llm-providers.js'
import { loadSundialConfig } from '@sundial/helpers/sundial-config.js'

export const name = 'sundial-llm-openai'
export const inject = ['llm']

/** Gnomon's own route. */
export const PROVIDER = DEFAULT_PROVIDER

const DEFAULT_ENV_FILE = path.join(process.env.SUNDIAL_HOME || path.join(os.homedir(), '.sundial'), '.env')
const BASE_URL_ENV = 'SUNDIAL_LLM_BASE_URL'
const MODEL_ENV = 'SUNDIAL_LLM_MODEL'
const DEFAULT_API_KEY_ENV = 'SUNDIAL_LLM_API_KEY'
const DEFAULT_MODEL = 'qwen/qwen3.8-flash-next'
/**
 * The window this route DECLARES, not the model's: dsh compacts at 80% of it.
 * At 128k compaction began near 102k while a chat call averaged 41.6k prompt
 * tokens, history driving it (measured 2026-09-28). 64k starts it at ~51k.
 * Plugin config `contextWindow` overrides it.
 */
const DEFAULT_CONTEXT_WINDOW = 64_000

/**
 * The models the picker offers on this route. The default comes first. A
 * deployment can replace the list with plugin config `models`; a model that is
 * configured as the default but not listed is added at the front, so the
 * picker always contains what is running.
 */
/** TensorX's catalogue, kept for a deployment that lists it in plugin config `models`. */
export const TENSORX_MODELS = [
  { id: 'qwen/qwen3.8-flash-next', description: 'Qwen 3.8 flash — the default; fast, reasons before it answers' },
  { id: 'deepseek/deepseek-v4-flash-0731', description: 'DeepSeek V4 flash — cheap and fast; selectable, but nothing routes here by default' },
  { id: 'qwen/qwen3.8-2.4t-a95b', description: 'Qwen 3.8 2.4T — the large one; slow and priced accordingly' },
  { id: 'moonshotai/kimi-k3', description: 'Kimi K3' },
  { id: 'z-ai/glm-5.2', description: 'GLM 5.2' },
]

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
// Env file (tiny hand-rolled parser; values are NEVER logged anywhere).
// Mirrors packages/llm/src/config.ts + sundial-env.ts: ~/.sundial/.env is the
// one env file, and existing process.env values win over file values.
// ---------------------------------------------------------------------------

/** Parse KEY=VALUE lines; ignores comments/blank lines; strips one quote pair. */
export function parseEnvFile(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) out[key] = value
  }
  return out
}

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
export const QUIET_PURPOSES = new Set(['session-title', 'compaction'])

export function serializeRequest(options, imageData = new Map()) {
  const messages = []
  if (options.system !== undefined) messages.push({ role: 'system', content: options.system })
  messages.push(...serializeMessages(options.messages, imageData))
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...reasoningField(options.reasoningEffort ?? (QUIET_PURPOSES.has(options.purpose) ? 'off' : undefined)),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  }
}

// ---------------------------------------------------------------------------
// SSE: raw byte stream → data payloads, `[DONE]` last (hand-rolled, no deps).
// ---------------------------------------------------------------------------

export async function* parseSse(stream) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = stream.getReader()
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

function closeBlock(block) {
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
        arguments: block.text,
      }
  }
}

export async function* translate(payloads) {
  let nextIndex = 0
  let textBlock
  let reasoningBlock
  const toolBlocks = new Map()
  const order = []
  let pendingFinish
  let pendingUsage

  function open(kind) {
    const block = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' }
      yield {
        type: 'finish',
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
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Statuses the route recovers from on its own, given a moment. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const RETRY_STATUS_ATTEMPTS = 3
const RETRY_BASE_MS = 700

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
   * What the provider says it serves (`GET {baseUrl}/models`, the OpenAI
   * standard), cached ten minutes. A provider that cannot list gives only the
   * configured model, so the picker is short rather than empty.
   */
  async discover() {
    if (this.facts.models) return this.facts.models
    const now = Date.now()
    if (this.discovered && now - this.discovered.at < 10 * 60_000) return this.discovered.models
    let models = []
    try {
      const key = await this.facts.resolveApiKey()
      const res = await fetch(`${this.facts.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) })
      const body = res.ok ? await res.json() : null
      models = Array.isArray(body?.data) ? body.data.filter((m) => typeof m?.id === 'string' && m.id !== '').map((m) => ({ id: m.id })) : []
    } catch {
      models = []
    }
    this.discovered = { at: now, models }
    return models
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

  resolveModel(provider, model, _signal) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: this.facts.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    })
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

  async *stream(options) {
    const apiKey = await this.facts.resolveApiKey()
    const body = serializeRequest(options, await this.resolveImages(options.messages))
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...attributionHeaders(),
      ...(options.sessionId !== undefined
        ? { 'x-gnomon-session-id': String(options.sessionId) }
        : {}),
    }
    // The route answers 503 "temporarily unavailable" while it swaps a model
    // in. dsh does not retry a step whose stream never opened — it closes the
    // turn with zero steps, and the owner sees an empty answer. Retry HERE,
    // before a single byte has streamed, where a repeat is still safe.
    // ponytail: fixed 3 tries, linear backoff; a real budget if it ever misses.
    let response
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${this.facts.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) {
          throw new LlmError(`${this.label} request aborted by caller`, 'ABORTED', { cause: error })
        }
        throw new LlmError(`${this.label} API request to ${this.facts.baseUrl} failed`, 'TRANSPORT', {
          cause: error,
        })
      }
      if (response.ok || attempt >= RETRY_STATUS_ATTEMPTS - 1 || !RETRY_STATUSES.has(response.status)) break
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * (attempt + 1)))
      if (options.signal?.aborted) throw new LlmError(`${this.label} request aborted by caller`, 'ABORTED')
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
      throw new LlmError(message, httpErrorCode(response.status), {
        status: response.status,
        ...(id ? { requestId: ProviderRequestId(id) } : {}),
      })
    }
    if (!response.body) throw new LlmError(`${this.label} API returned no response body`, 'EMPTY_RESPONSE')
    try {
      yield* translate(parseSse(response.body))
    } catch (error) {
      if (options.signal?.aborted) {
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
  let fileEnv = {}
  try {
    fileEnv = parseEnvFile(fs.readFileSync(envFile, 'utf8'))
  } catch {
    // Missing env file is valid — shell exports may carry everything.
  }
  // Lazy and optional: `attachments` is provided by `attachment-local`, and
  // resolving it at call time means this plugin still loads on a profile
  // without it (cordis would otherwise make it a service to WAIT for).
  const readImage = async (ref) => ctx.get?.('attachments')?.readImage(ref)
  const keyFor = (apiKeyEnv) => async () => {
    const raw = envValue(fileEnv, apiKeyEnv)
    if (raw !== undefined) return assertUsableApiKey(raw, 'sundial-llm-openai', apiKeyEnv)
    // Local OpenAI-compatible servers (Ollama, llama.cpp) accept any bearer.
    return 'gnomon-local'
  }

  // Gnomon's own model, from .env. `tensorx` is the route's name from before
  // v0.2: conversations recorded then still name it, so it stays an alias the
  // picker does not list.
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
    const adapter = new OpenAICompatAdapter({ baseUrl, model, resolveApiKey: keyFor(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV), models, readImage, contextWindow: config.contextWindow })
    ctx.llm.registerAdapter([PROVIDER, LEGACY_PROVIDER], adapter)
  }

  // More providers, from config.json: one route each, picked per conversation.
  const providers = config.providers ?? loadSundialConfig().llm.providers
  for (const p of providers) {
    try {
      const adapter = new OpenAICompatAdapter({ baseUrl: p.baseUrl, model: p.model, label: p.label, resolveApiKey: keyFor(providerKeyEnv(p.id)), readImage })
      ctx.llm.registerAdapter([p.id], adapter)
    } catch (error) {
      console.warn(`[sundial-llm-openai] provider ${p.id} not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
