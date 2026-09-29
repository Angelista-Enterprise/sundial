import { describe, it, expect } from 'vitest'
import { watchTools } from './watch-tools.js'

const spec = { title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}' }

describe('gnomon_adopt_rule', () => {
  it('backtests the rule again and adopts it with the rate its live fires are held against', async () => {
    const appended = []
    const tested = []
    const [adopt] = watchTools(
      async (type, payload) => appended.push({ type, payload }),
      () => ({ watch: { rules: [] } }),
      async (rule) => (tested.push(rule), { valid: true, rule, fired: 5, days: 30, gate: { phasic: 2, tonic: 1 } }),
    )
    const out = await adopt.execute({ rule: spec })
    expect(tested).toHaveLength(1)
    expect(appended).toEqual([{ type: 'rule:adopted', payload: { rule: expect.objectContaining({ id: 'ci-failed', by: ['number'] }), predicted: { fired: 5, days: 30, heard: 3 } } }])
    expect(out).toMatchObject({ adopted: true, id: 'ci-failed', version: 1, predicted: { fired: 5, days: 30, heard: 3 } })
  })
  it('adopts nothing when the backtest cannot run', async () => {
    const appended = []
    const [adopt] = watchTools(async (t, p) => appended.push(p), () => ({ watch: { rules: [] } }), async () => ({ valid: false, error: 'no log' }))
    await expect(adopt.execute({ rule: spec })).rejects.toThrow('no log')
    expect(appended).toEqual([])
  })
})

describe('gnomon_export_rule (U4-F30)', () => {
  const state = () => ({ watch: { rules: [{ id: 'ci-failed', title: 'CI failed', when: { type: 'git:pr-status', where: [{ field: 'checkState', op: 'eq', value: 'failure' }] }, say: 'CI failed on #{number}', cooldownMin: 60 }] } })
  const exporter = (scan) => watchTools(async () => {}, state, async () => ({}), scan).find((t) => t.name === 'gnomon_export_rule')
  it('returns the blueprint only when the scan is clean', async () => {
    const seen = []
    const out = await exporter(async (text) => (seen.push(text), { clean: true })).execute({ id: 'ci-failed' })
    expect(out.blueprint.when.where[0].value).toBe('{input:checkState}')
    expect(seen[0]).not.toContain('failure')
  })
  it('refuses on a hit, and when there is no scan, without echoing the words', async () => {
    await expect(exporter(async () => ({ hits: 2 })).execute({ id: 'ci-failed' })).rejects.toThrow('found 2 private word(s)')
    await expect(exporter(async () => ({ unavailable: true })).execute({ id: 'ci-failed' })).rejects.toThrow('not available')
  })
})
