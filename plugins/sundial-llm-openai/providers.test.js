import { describe, expect, it } from 'vitest'
import { apply, OpenAICompatAdapter } from './index.js'

function mount(config) {
  const routes = []
  apply({ llm: { registerAdapter: (ids, adapter) => routes.push({ ids, adapter }) } }, { envFile: '/nonexistent/.env', ...config })
  return routes
}

describe('routes', () => {
  it("registers Gnomon's model as openai, with tensorx as an alias, and one route per extra provider", () => {
    const routes = mount({
      baseUrl: 'http://127.0.0.1:11434/v1/',
      model: 'qwen3:8b',
      providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' }],
    })
    expect(routes.map((r) => r.ids)).toEqual([['openai', 'tensorx'], ['groq']])
    expect(routes[0].adapter.providerInfo('openai').name).toBe('Ollama on this Mac')
    expect(routes[1].adapter.providerInfo('groq').name).toBe('Groq')
  })

  it('boots without a model: no default route, extra providers still register', () => {
    const routes = mount({ providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' }] })
    expect(routes.map((r) => r.ids)).toEqual([['groq']])
  })

  it('lists what the provider serves, current model first, and falls back to the model alone', async () => {
    const realFetch = globalThis.fetch
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] }), { status: 200 })
      const listed = await new OpenAICompatAdapter({ baseUrl: 'http://x/v1', model: 'a', resolveApiKey: async () => 'k' }).listModels('openai')
      expect(listed.map((m) => m.id)).toEqual(['a', 'b'])
      globalThis.fetch = async () => {
        throw new Error('down')
      }
      const alone = await new OpenAICompatAdapter({ baseUrl: 'http://x/v1', model: 'm', resolveApiKey: async () => 'k' }).listModels('openai')
      expect(alone.map((m) => m.id)).toEqual(['m'])
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
