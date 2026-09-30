// W4 step 6: the screen and the agent read one present. The route's answer and
// `gnomon_current_context`'s `situation` are the same object on the same state and instant.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCtx } from './mount.test.js'

vi.mock('@sundial/db/index.js', async (original) => ({
  ...(await original()),
  getLeftOff: async () => [{ projectId: '/code/puzzlebox', projectName: 'puzzlebox', at: '2026-03-04T08:00:00.000Z', what: 'Fixing the retry test' }],
  getProjectIntents: async () => [{ at: '2026-03-04T07:50:00.000Z', what: 'Retry backoff' }],
  getKnowledgeEntriesSince: async () => [{ id: 'k1', kind: 'shelf', title: 'A draft', body: 'b', createdAt: '2026-03-04T07:00:00.000Z', retractedAt: null }],
  getSignalsInRange: async (_from, _to, _limit, types) => (types?.includes('symbol') ? [{ capturedAt: '2026-03-04T08:40:00.000Z', data: { projectRoot: '/code/puzzlebox', edits: [{ file: 'src/retry.ts', symbols: ['backoff'] }] } }] : []),
}))

const NOW = Date.parse('2026-03-04T09:00:00.000Z')

afterEach(() => vi.useRealTimers())

describe('situation', () => {
  it('the route answers what the tool says', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const { createInitialState } = await import('@sundial/kernel/initial-state.js')
    const { TOOL_REGISTRY } = await import('@sundial/kernel/tools/index.js')
    const { executeTool } = await import('@sundial/kernel/tools/registry.js')
    const state = createInitialState('d')
    state.resume = { intents: {}, last: { at: '2026-03-04T08:50:00.000Z', trigger: 'project-return', awayMs: 3 * 86_400_000, key: 'k', line: 'Back on puzzlebox after 3 days', pieces: { project: { id: '/code/puzzlebox', name: 'puzzlebox' } } } }
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { apply } = await import('../index.js')
    const { ctx, routes } = fakeCtx(state)
    apply(ctx)
    let body = null
    await routes.get('/gnomon/situation').handler({ url: '/gnomon/situation', headers: {} }, { writeHead() {}, end: (text) => (body = JSON.parse(text)) })
    const tool = await executeTool(TOOL_REGISTRY, 'gnomon_current_context', {}, { now: new Date(NOW), state: async () => state })
    expect(body.resume.digest).toEqual([{ at: '2026-03-04T07:50:00.000Z', what: 'Retry backoff' }])
    expect(body.resume.trail.length).toBe(1)
    expect(body.waitingForYou.shelf).toBe(1)
    expect(JSON.parse(JSON.stringify(tool.situation))).toEqual(body)
  })
})
