import { describe, expect, it } from 'vitest'
import { apply, OpenAICompatAdapter } from './index.js'

function mount(config) {
  const routes = []
  const mounted = []
  apply({ llm: { registerAdapter: (ids, adapter) => routes.push({ ids, adapter }) } }, { envFile: '/nonexistent/.env', mountPiAi: (plugin, options) => mounted.push({ plugin, options }), runtimeRoutes: [], ...config })
  routes.mounted = mounted
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

  it('hands a provider that speaks another protocol to one pi-ai instance, and keeps the rest', () => {
    const routes = mount({
      providers: [
        { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama', protocol: 'openai-chat' },
        { id: 'anthropic-api', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', protocol: 'anthropic-messages' },
      ],
    })
    expect(routes.map((r) => r.ids)).toEqual([['groq']])
    expect(routes.mounted).toHaveLength(1)
    expect(routes.mounted[0].plugin.name).toBe('llm-pi-ai')
    expect(routes.mounted[0].options).toEqual({ providers: { 'anthropic-api': { displayName: 'Anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com/v1', apiKeyEnv: 'SUNDIAL_LLM_KEY_ANTHROPIC_API', models: [{ id: 'claude-sonnet-4-5' }] } } })
    expect(mount({ providers: [{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama' }] }).mounted).toEqual([])
  })

  it('registers the vendor runtimes as chat routes when asked', () => {
    const routes = mount({ runtimeRoutes: ['claude', 'copilot'] })
    expect(routes.map((r) => r.ids)).toEqual([['claude'], ['copilot']])
    expect(routes[0].adapter.providerInfo('claude').name).toBe('Claude Code')
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
      const route = new OpenAICompatAdapter({ baseUrl: 'http://x/v1', model: 'm', resolveApiKey: async () => 'k' })
      expect((await route.listModels('openai')).map((m) => m.id)).toEqual(['m'])
      // A failed lookup is not kept: the next open of the picker asks again and gets the whole list.
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.3-flash' }] }), { status: 200 })
      expect((await route.listModels('openai')).map((m) => m.id)).toEqual(['m', 'z-ai/glm-5.3-flash'])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('declares the window config.json names, else the one the provider reports, else 64k', async () => {
    const realFetch = globalThis.fetch
    try {
      const facts = { baseUrl: 'http://x/v1', model: 'm', resolveApiKey: async () => 'k' }
      globalThis.fetch = async () => {
        throw new Error('down')
      }
      expect((await new OpenAICompatAdapter(facts).resolveModel('openai', 'm')).context.contextWindow).toBe(64_000)
      expect((await new OpenAICompatAdapter({ ...facts, contextWindow: 32_000 }).resolveModel('openai', 'm')).context.contextWindow).toBe(32_000)
      // OpenRouter: the provider that serves it can take less than the model's own window.
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'big', context_length: 1_048_575, top_provider: { context_length: 262_144 } }, { id: 'own', context_length: 131_072 }, { id: 'bare' }] }), { status: 200 })
      const route = new OpenAICompatAdapter({ ...facts, contextWindows: { own: 100_000 } })
      expect((await route.resolveModel('openai', 'big')).context.contextWindow).toBe(262_144)
      expect((await route.resolveModel('openai', 'own')).context.contextWindow).toBe(100_000)
      expect((await route.resolveModel('openai', 'bare')).context.contextWindow).toBe(64_000)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('asks the provider once, then answers from the report without waiting', async () => {
    const realFetch = globalThis.fetch
    let asked = 0
    try {
      globalThis.fetch = async () => {
        asked += 1
        return new Response(JSON.stringify({ data: [{ id: 'm', context_length: 200_000 }] }), { status: 200 })
      }
      const route = new OpenAICompatAdapter({ baseUrl: 'http://x/v1', model: 'm', resolveApiKey: async () => 'k' })
      await Promise.all([route.resolveModel('openai', 'm'), route.resolveModel('openai', 'm')])
      await route.resolveModel('openai', 'm')
      await route.listModels('openai')
      expect(asked).toBe(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
