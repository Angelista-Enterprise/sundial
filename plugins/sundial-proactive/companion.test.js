// The companion's model on a new install whose only model is a saved provider. Made-up values only.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureCompanion } from './companion.js'

describe('ensureCompanion', () => {
  it('with no .env model, starts on the route llm.use.default names', async () => {
    const env = process.env.SUNDIAL_LLM_BASE_URL
    delete process.env.SUNDIAL_LLM_BASE_URL
    try {
      const create = vi.fn(async () => ({ agent: {}, dispose: () => {} }))
      const ctx = {
        agents: { get: () => undefined, create },
        agentDefaultModel: { currentSelection: () => ({ provider: 'openai', model: 'qwen/qwen3.8-flash-next' }) },
        gnomonKernel: { getState: () => ({ config: { llm: { providers: [{ id: 'p-puzzlebox', label: 'Puzzlebox', baseUrl: 'https://llm.example.org/v1', model: 'puzzle-7b' }], use: { default: 'p-puzzlebox' } } } }) },
      }
      await ensureCompanion(ctx, { home: mkdtempSync(join(tmpdir(), 'sundial-companion-')), cwd: '/tmp' })
      expect(create.mock.calls[0][0].agentOptions).toEqual({ provider: 'p-puzzlebox', model: 'puzzle-7b' })
    } finally {
      if (env !== undefined) process.env.SUNDIAL_LLM_BASE_URL = env
    }
  })
})
