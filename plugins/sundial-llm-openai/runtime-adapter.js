// The chat on a vendor runtime (step 5 of docs/provider-implementation.md): a dsh
// `LlmAdapter` over @sundial/llm's runtime port, one route per runtime source
// (`claude`: the owner's own Claude Code; `copilot`: their own GitHub Copilot).
//
// A turn is one job: Gnomon's persona rendered for the runtime (step 6: the
// same voice as dsh's system prompt, no dsh-only line, the runtime's own tool
// names) is the runtime's appended system prompt; dsh's own rendered system
// prompt is not sent. The conversation so far, the brief included, is
// flattened into the prompt with the brief's reply rules rendered the same
// way, and the runtime runs Sundial's READ tools itself over MCP —
// so the stream carries text and no tool-call deltas, and dsh ends the turn on
// the runtime's answer. Its tool calls show as a thinking frame, not as dsh
// tool calls. Writes queue for the owner in `.daemon/mcp-writes/` as today;
// dsh-only tools (the board, show_surface, the actions behind the gate) are not
// offered. Approvals come as each SDK reports them (decision 4: text and read
// tools first). A limit ends the turn with a 429 so the chat's fallback
// (host/server.js) moves the thread to the next chat source. Stateless for now:
// no vendor session is resumed; dsh's own compaction bounds the history.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { renderPersona, renderReplyRules } from '@sundial/kernel/persona.js'
import { REPLY_RULES } from '@sundial/kernel/turn-brief.js'
import { CLAUDE_MODELS, COPILOT_DEFAULT_MODEL, runtimeFor } from '@sundial/llm/index.js'

export const RUNTIME_ROUTES = {
  claude: { name: 'Claude Code', models: CLAUDE_MODELS, defaultModel: 'sonnet', kind: 'claude-cli' },
  copilot: { name: 'GitHub Copilot', models: [COPILOT_DEFAULT_MODEL, 'gpt-5'], defaultModel: COPILOT_DEFAULT_MODEL, kind: 'copilot-sdk' },
}

const RUNTIME_RULES = renderReplyRules('runtime')

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '')

/** dsh's messages → one prompt: the whole conversation, the last owner message on its own when it is all there is. */
export function flattenDsh(messages) {
  const rest = (messages ?? []).filter((m) => m.role !== 'system' && m.role !== 'developer')
  const parts = []
  for (const m of rest) {
    if (m.role === 'tool') {
      parts.push(`Tool result${m.isError ? ' (error)' : ''}:\n${textOf(m.content).slice(0, 4000)}`)
      continue
    }
    const text = textOf(m.content)
    const calls = Array.isArray(m.content) ? m.content.filter((b) => b?.type === 'tool-call').map((b) => `${b.name}(${b.arguments})`) : []
    if (!text && calls.length === 0) continue
    const who = m.role === 'assistant' ? 'Assistant' : m.source?.kind === 'user' ? 'User' : 'Context'
    parts.push(`${who}:\n${text}${calls.length > 0 ? `\n(called ${calls.join(', ')})` : ''}`)
  }
  if (rest.length === 1 && rest[0].role === 'user') return textOf(rest[0].content)
  return `${parts.join('\n\n')}\n\nAnswer as the assistant's next turn.`
}

export class RuntimeAdapter extends LlmAdapter {
  /**
   * @param source `claude` | `copilot`
   * @param facts `{ home, runtime? }`: the Sundial home for the MCP server; `runtime` overrides `runtimeFor(source)` in tests.
   */
  constructor(source, facts) {
    super()
    this.source = source
    this.facts = facts
    this.info = RUNTIME_ROUTES[source]
  }

  providerInfo(provider) {
    return { id: provider, name: this.info.name }
  }

  providerRetryPolicy() {
    // The runtime retries by itself; a second layer would double every wait.
    return { mode: 'none', maxRetries: 0 }
  }

  async listModels(provider) {
    const runtime = this.facts.runtime ?? runtimeFor(this.source)
    let models = this.info.models
    try {
      const listed = await runtime.listModels()
      if (listed.length > 0) models = listed
    } catch {
      // Not signed in, or no plan: offer the known names; a turn says what is wrong.
    }
    return models.map((id) => ({ provider, id, name: id, description: `On your own ${this.info.name}`, inputModalities: ['text'] }))
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200_000 } })
  }

  async *stream(options) {
    const runtime = this.facts.runtime ?? runtimeFor(this.source)
    const home = this.facts.home
    const job = {
      model: options.model || this.info.defaultModel,
      cwd: `${home}/.daemon/hands/chat`,
      system: renderPersona('runtime', this.info.kind),
      prompt: flattenDsh(options.messages).replaceAll(REPLY_RULES, RUNTIME_RULES),
      tools: 'read',
      home,
      signal: options.signal,
      timeoutMs: 300_000,
    }
    let text = null
    let thinking = null
    let next = 0
    let usage
    let error = null
    let output = ''
    for await (const e of runtime.run(job)) {
      if (e.type === 'text.delta') {
        if (text === null) {
          text = { index: next++, text: '' }
          yield { type: 'block-start', index: text.index, blockType: 'text' }
        }
        text.text += e.text
        yield { type: 'text-delta', index: text.index, text: e.text }
      } else if (e.type === 'tool.call') {
        // The runtime's own work, shown as thinking: it is not a dsh tool call and must not read as one.
        if (thinking === null) {
          thinking = { index: next++, text: '' }
          yield { type: 'block-start', index: thinking.index, blockType: 'reasoning' }
        }
        const line = `${e.name}(${e.arguments.slice(0, 200)})\n`
        thinking.text += line
        yield { type: 'reasoning-delta', index: thinking.index, text: line }
      } else if (e.type === 'usage') {
        usage = { inputTokens: e.promptTokens ?? 0, outputTokens: e.completionTokens ?? 0, ...(e.cacheReadTokens ? { cacheReadTokens: e.cacheReadTokens } : {}) }
      } else if (e.type === 'done') {
        output = e.output
      } else if (e.type === 'error') {
        error = e
      }
    }
    // A runtime that answers whole (a structured result, no partial text) still owes the text block.
    if (!error && text === null && output) {
      text = { index: next++, text: output }
      yield { type: 'block-start', index: text.index, blockType: 'text' }
      yield { type: 'text-delta', index: text.index, text: output }
    }
    if (thinking !== null) yield { type: 'block-end', index: thinking.index, block: { type: 'reasoning', text: thinking.text } }
    if (text !== null) yield { type: 'block-end', index: text.index, block: { type: 'text', text: text.text } }
    if (usage) yield { type: 'usage', usage }
    if (error) {
      const status = error.status ?? (error.kind === 'limit' ? 429 : error.kind === 'auth' ? 401 : 500)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: error.message, code: error.kind === 'limit' ? 'RATE_LIMIT' : error.kind === 'auth' ? 'AUTH' : 'RUNTIME', status } } }
      return
    }
    if (text === null) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `${this.info.name} answered with no text`, code: 'EMPTY_RESPONSE' } } }
      return
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
