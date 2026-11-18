// S4 (Fable M5): the rules card's version history is the owner's adoptions only. Every value is made up.
import { describe, expect, it, vi } from 'vitest'

const rows = vi.hoisted(() => [])
vi.mock('@sundial/db/index.js', () => ({ getGateDecisionsBetween: async () => [], getSignalsInRange: async () => rows }))
const { readRules } = await import('./read-rules.js')

describe('readRules: an adoption with a sessionId or a sandbox mark is a rig chat\'s, never a version of the owner\'s rule', () => {
  it('the owner\'s adoption counts; a rig chat\'s of the same id, marked either way, does not', async () => {
    const rule = { id: 'crate-watch', title: 'Crate watch', when: { type: 'window:changed' }, say: 'x' }
    rows.push(
      { capturedAt: '2026-11-16T09:00:00.000Z', data: { rule } },
      { capturedAt: '2026-11-16T09:05:00.000Z', data: { rule, sessionId: 'session-rig' } },
      { capturedAt: '2026-11-16T09:06:00.000Z', data: { rule, sandbox: 'session-rig' } },
    )
    const { rules } = await readRules({ state: { watch: { rules: [rule], runtime: {} } }, now: Date.parse('2026-11-16T10:00:00.000Z') })
    expect(rules[0].versions).toEqual([{ version: 1, at: '2026-11-16T09:00:00.000Z' }])
  })
})
