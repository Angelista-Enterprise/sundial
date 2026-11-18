import { describe, expect, it } from 'vitest'
import { dshModelPort, toDshMessage } from './dsh-model-port.js'

/** A fake `ctx.llm.stream` that records the request and plays the given chunks. */
function fakeLlm(chunks) {
  const asked = []
  return {
    asked,
    llm: {
      async *stream(options) {
        asked.push(options)
        for (const c of chunks) yield c
      },
    },
  }
}
const text = (t) => [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: t }, { type: 'block-end', index: 0, block: { type: 'text', text: t } }]

describe('the model port over dsh', () => {
  it('sends the system prompt apart, the rest as dsh messages, and reads text, usage and finish back flat', async () => {
    const { asked, llm } = fakeLlm([...text('BOX-484 is the ticket.'), { type: 'usage', usage: { inputTokens: 12, outputTokens: 5 } }, { type: 'finish', reason: { kind: 'stop' } }])
    const port = dshModelPort({ get: () => llm })
    const out = await port.complete({ route: 'anthropic-api', model: 'claude-sonnet-4-5', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Which ticket?' }], maxTokens: 64 })
    expect(out).toEqual({ content: 'BOX-484 is the ticket.', statusCode: 200, promptTokens: 12, completionTokens: 5, totalTokens: 17, toolCalls: [], finishReason: 'stop' })
    expect(asked[0]).toMatchObject({ provider: 'anthropic-api', model: 'claude-sonnet-4-5', system: 'Be brief.', maxTokens: 64 })
    expect(asked[0].messages.map((m) => m.role)).toEqual(['user'])
    expect(asked[0].messages[0].source).toEqual({ kind: 'user' })
  })

  it('carries a tool round trip both ways: a call back as tool_calls, a result in as a tool message', async () => {
    const { asked, llm } = fakeLlm([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'gnomon_tickets', argumentsDelta: '{"key":"BOX-484"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: 'gnomon_tickets', arguments: '{"key":"BOX-484"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    const port = dshModelPort({ get: () => llm })
    const out = await port.complete({
      route: 'r', model: 'm', tools: [{ name: 'gnomon_tickets', description: 'd', parameters: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'gnomon_tickets', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c0', content: '[]' },
      ],
    })
    expect(out.toolCalls).toEqual([{ id: 'c1', name: 'gnomon_tickets', arguments: '{"key":"BOX-484"}' }])
    expect(out.finishReason).toBe('tool_calls')
    expect(asked[0].tools).toEqual([{ name: 'gnomon_tickets', description: 'd', parameters: { type: 'object' } }])
    const [, assistant, result] = asked[0].messages
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toEqual([{ type: 'tool-call', id: 'c0', name: 'gnomon_tickets', arguments: '{}' }])
    expect(assistant.source).toMatchObject({ kind: 'model', provider: 'r', model: 'm' })
    expect(result).toMatchObject({ role: 'tool', toolCallId: 'c0', isError: false })
  })

  it('turns a provider failure into the status-aware error the retry layer reads, and a cut answer into length', async () => {
    const limited = dshModelPort({ get: () => fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { message: 'slow down', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 7000 } } }]).llm })
    await expect(limited.complete({ route: 'r', model: 'm', messages: [{ role: 'user', content: 'q' }] })).rejects.toMatchObject({ name: 'LlmHttpError', status: 429, retryAfterMs: 7000 })
    const cut = dshModelPort({ get: () => fakeLlm([...text('half'), { type: 'finish', reason: { kind: 'max-tokens' } }]).llm })
    expect((await cut.complete({ route: 'r', model: 'm', messages: [{ role: 'user', content: 'q' }] })).finishReason).toBe('length')
    await expect(dshModelPort({ get: () => undefined }).complete({ route: 'r', model: 'm', messages: [] })).rejects.toThrow(/No model service/)
  })

  it('toDshMessage: a tool result with no text is an empty result, not a crash', () => {
    expect(toDshMessage({ role: 'tool', toolCallId: 'c', content: '' }, { provider: 'r', model: 'm' })).toMatchObject({ role: 'tool', content: [] })
  })
})
