// The kernel's model port over dsh's adapters (`@sundial/llm` `ModelPort`).
//
// A kernel purpose on a provider the raw OpenAI-compatible fetch cannot speak to
// (an Anthropic-messages or OpenAI-responses route, served by dsh's pi-ai
// adapter) comes here: one `ctx.llm.stream` call, the same routes, credentials
// and retry the chat uses, assembled into the flat `ChatCompletionResult` the
// kernel's audited call and tool loop already read. The audit row is still
// written by `runAuditedLlmCall` (fence W3): this only answers the call.
// Named exports only.
import { BlockAssembler, ToolCallId, createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { LlmHttpError } from '@sundial/llm/index.js'

/** Gnomon's flat `ChatCompletionMessage` → dsh's message. The system prompt travels as the request's `system`. */
export function toDshMessage(message, { provider, model }) {
  if (message.role === 'system') return createSystemMessage(message.content)
  if (message.role === 'tool') return createToolResultMessage({ callId: ToolCallId(message.toolCallId ?? ''), content: message.content ? [{ type: 'text', text: message.content }] : [], isError: false })
  if (message.role === 'assistant') {
    const content = [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...(message.toolCalls ?? []).map((call) => ({ type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments })),
    ]
    return createAssistantMessage({ content, source: { provider, model } })
  }
  return createUserMessage({ content: [{ type: 'text', text: message.content }], source: { kind: 'user' } })
}

/** dsh's finish reason → the OpenAI word the kernel's callers compare against. */
const FINISH = { stop: 'stop', 'tool-calls': 'tool_calls', 'max-tokens': 'length' }

/**
 * @param ctx the kernel plugin's context; `llm` is read at call time, so the port is valid before dsh's adapters are up.
 */
export function dshModelPort(ctx) {
  return {
    async complete({ route, model, messages, tools, maxTokens, temperature, timeoutMs }) {
      const llm = ctx.get?.('llm') ?? ctx.llm
      if (!llm) throw new Error('No model service in this process yet.')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? 60_000)
      try {
        const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
        const assembler = new BlockAssembler()
        for await (const chunk of llm.stream({
          provider: route,
          model,
          ...(system ? { system } : {}),
          messages: messages.filter((m) => m.role !== 'system').map((m) => toDshMessage(m, { provider: route, model })),
          ...(tools && tools.length > 0 ? { tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}),
          maxTokens: maxTokens ?? 1024,
          temperature: temperature ?? 0.3,
          signal: controller.signal,
        })) assembler.push(chunk)
        const finish = assembler.finish
        if (finish.kind === 'error' || finish.kind === 'aborted') {
          const f = finish.failure ?? {}
          // The kernel's retry layer is status-aware (`LlmHttpError`): keep the status when the provider gave one.
          throw typeof f.status === 'number' ? new LlmHttpError(f.status, f.providerRetryAfterMs ?? null, `${route}: ${f.message ?? finish.kind}`) : new Error(`${route}: ${f.message ?? finish.kind}`)
        }
        const blocks = assembler.blocks()
        const usage = assembler.usage
        return {
          content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
          statusCode: 200,
          promptTokens: usage?.inputTokens ?? null,
          completionTokens: usage?.outputTokens ?? null,
          totalTokens: usage ? usage.inputTokens + usage.outputTokens : null,
          toolCalls: blocks.filter((b) => b.type === 'tool-call' && b.id && b.name).map((b) => ({ id: String(b.id), name: b.name, arguments: b.arguments || '{}' })),
          finishReason: FINISH[finish.kind] ?? finish.kind,
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
