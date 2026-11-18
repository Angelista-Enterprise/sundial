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

describe('flows in the chat tools (observatory §2)', () => {
  const step1 = { id: 'r1', title: 'R1', when: { type: 'shell:command' }, emit: 'custom:one', say: 'x', cooldownMin: 60 }
  const state = () => ({ watch: { rules: [step1, { id: 'r9', title: 'R9', when: { type: 'git:push' }, say: 'y', cooldownMin: 60 }], stats: { r1: { flow: { id: 'fl', title: 'Fl', step: 1 } } } } })
  it('a later step is adopted with its flow and held against the joint backtest of the steps before it', async () => {
    const appended = []
    const tested = []
    const [adopt] = watchTools(
      async (type, payload) => appended.push({ type, payload }),
      state,
      async (rule) => (tested.push(rule), Array.isArray(rule) ? { valid: true, days: 30, steps: [{ fired: 4, heard: 0 }, { fired: 2, heard: 1 }] } : { valid: true, rule, fired: 0, days: 30, gate: { phasic: 0, tonic: 0 } }),
    )
    const out = await adopt.execute({ rule: { title: 'R2', when: { type: 'custom:one' }, say: 'z' }, flow: { id: 'fl', title: 'Fl', step: 2 } })
    expect(tested[1].map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(appended).toEqual([{ type: 'rule:adopted', payload: { rule: expect.objectContaining({ id: 'r2' }), predicted: { fired: 2, days: 30, heard: 1 }, flow: { id: 'fl', title: 'Fl', step: 2 } } }])
    expect(out.predicted).toEqual({ fired: 2, days: 30, heard: 1 })
  })
  it('pause, resume and drop take one rule or a whole flow, one event per rule', async () => {
    const appended = []
    const tools = watchTools(async (type, payload) => appended.push([type, payload.id]), state, async () => ({}))
    const by = (name) => tools.find((t) => t.name === name)
    expect(await by('gnomon_pause_rule').execute({ flow: 'fl' })).toEqual({ paused: 'r1' })
    await by('gnomon_resume_rule').execute({ id: 'r9' })
    await by('gnomon_drop_rule').execute({ id: 'r9' })
    expect(appended).toEqual([['rule:paused', 'r1'], ['rule:resumed', 'r9'], ['rule:dropped', 'r9']])
    await expect(by('gnomon_pause_rule').execute({})).rejects.toThrow('name one rule')
    await expect(by('gnomon_pause_rule').execute({ flow: 'nope' })).rejects.toThrow('no flow "nope"')
  })
})

describe('a reach is adopted only when the action gate knows its tool (observatory §3)', () => {
  it('refuses an unmounted integration and takes a mounted one', async () => {
    const appended = []
    const reach = { title: 'Publish', when: { type: 'git:push' }, do: [{ reach: { tool: 'mcp__github__create_release', brief: 'Draft it' } }], say: 'x' }
    const tools = (integrations) => watchTools(async (type, payload) => appended.push(type), () => ({ watch: { rules: [] } }), async (rule) => ({ valid: true, rule, fired: 1, days: 30, gate: { phasic: 0, tonic: 1 } }), undefined, () => integrations)
    await expect(tools([])[0].execute({ rule: reach })).rejects.toThrow('not a tool the action gate knows')
    await tools([{ name: 'github' }])[0].execute({ rule: reach })
    expect(appended).toEqual(['rule:adopted'])
  })
})
