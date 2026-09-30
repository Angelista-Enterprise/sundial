import { describe, it, expect } from 'vitest'
import { rulesView } from './rules-view.js'
import { validateWatchRule } from '@sundial/kernel/watch.js'

const rule = validateWatchRule({ title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}' }).rule
const now = '2026-10-15T12:00:00.000Z'

describe('rulesView — the rules card (U4-F20)', () => {
  it('lists an adopted rule with no fires against its backtest rate, and says so plainly', () => {
    const watch = { rules: [rule], stats: { 'ci-failed': { version: 1, adoptedAt: '2026-10-14T09:00:00.000Z', predicted: { fired: 5, days: 30 }, fires: 0, recent: [], verdicts: { useful: 0, wrong: 0, 'not-now': 0 } } } }
    const [r] = rulesView(watch, [], [{ ts: '2026-10-14T09:00:00.000Z', payload: { rule: { id: 'ci-failed' } } }], now)
    expect(r).toMatchObject({ id: 'ci-failed', words: 'git:pr-status where checkState is failure: each time, per number', paused: false, version: 1, fires: 0, lastFires: [], predicted: { fired: 5, days: 30 } })
    expect(r.line).toBe('v1 · 0 this week, backtest ~1.2 · no verdicts yet')
  })
  it('the gate\'s word on the last fires, newest first, verdicts with n, paused and versions', () => {
    const decisions = ['2026-10-10', '2026-10-11', '2026-10-12', '2026-10-13'].map((d, i) => ({ kind: 'watch:ci-failed', channel: ['phasic', 'tonic', 'suppressed', 'phasic'][i], reason: 'admitted', decidedAt: `${d}T10:00:00.000Z` }))
    const watch = { rules: [rule], paused: ['ci-failed'], stats: { 'ci-failed': { version: 2, adoptedAt: '2026-10-01T00:00:00.000Z', fires: 4, recent: [], verdicts: { useful: 2, wrong: 1, 'not-now': 0 } } } }
    const adoptions = [{ ts: '2026-09-20T00:00:00.000Z', payload: { rule: { id: 'ci-failed' } } }, { ts: '2026-10-01T00:00:00.000Z', payload: { rule: { id: 'ci-failed' } } }, { ts: '2026-10-02T00:00:00.000Z', payload: { rule: { id: 'other' } } }]
    const [r] = rulesView(watch, [...decisions, { kind: 'watch:other', channel: 'phasic', reason: 'admitted', decidedAt: now }], adoptions, now)
    expect(r.lastFires.map((f) => f.channel)).toEqual(['phasic', 'suppressed', 'tonic'])
    expect(r.versions).toEqual([{ version: 1, at: '2026-09-20T00:00:00.000Z' }, { version: 2, at: '2026-10-01T00:00:00.000Z' }])
    expect(r.line).toBe('v2 · paused · 0 this week · useful 2 · wrong 1 · not now 0 (n=3)')
  })
})
