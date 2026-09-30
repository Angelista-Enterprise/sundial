import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ calls: [] }))
const row = (id, decidedAt, channel) => ({ id, noticeKey: `k:${id}`, kind: 'return-from-break', channel, reason: 'r', weight: 1, decidedAt })
vi.mock('@sundial/db/index.js', () => ({
  getGateDecisionsBetween: async (from, to) => {
    db.calls.push(['gate', from, to])
    return [row('a', '2026-03-01T08:00:00.000Z', 'tonic'), row('b', '2026-03-04T09:00:00.000Z', 'tonic')].filter((r) => r.decidedAt >= from && r.decidedAt < to)
  },
  getSignalsInRange: async (from, to, _limit, types) => {
    db.calls.push([types[0], from, to])
    return types[0] === 'notice:candidate' ? [{ capturedAt: '2026-03-04T09:00:00.000Z', data: { key: 'k:b', observation: 'Back after 40 min', evidence: [] } }] : []
  },
}))
vi.mock('@sundial/helpers/sundial-config.js', () => ({ loadSundialConfig: () => ({ timezone: 'UTC' }) }))

describe('readUnsaid', () => {
  it('reads the day with a ranged query and the words only from the first decision on', async () => {
    const { readUnsaid } = await import('./read-unsaid.js')
    const out = await readUnsaid({ state: null, now: Date.parse('2026-03-04T12:00:00Z'), date: '2026-03-04' })
    expect(out.counts).toEqual({ said: 1, held: 0, dropped: 0 })
    expect(out.said[0].observation).toBe('Back after 40 min')
    expect(out.decisions).toHaveLength(2)
    expect(db.calls).toContainEqual(['gate', '2026-03-04T00:00:00.000Z', '2026-03-05T00:00:00.000Z'])
    expect(db.calls.filter(([t]) => t !== 'gate').every(([, from]) => from === '2026-03-01T07:59:00.000Z')).toBe(true)
  })
})
