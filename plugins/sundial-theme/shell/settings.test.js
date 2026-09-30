// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { autonomyBlock, healthRows, nextPaper } from './settings.js'

describe('the paper toggle', () => {
  it('goes Auto → Dark → Light → Auto, so dark is one press from Auto (L7)', () => {
    expect(nextPaper('system')).toBe('dark')
    expect(nextPaper('dark')).toBe('light')
    expect(nextPaper('light')).toBe('system')
    expect(nextPaper(undefined)).toBe('dark')
  })
})

// lane H
const text = (nodes) => {
  // No hole in the list: replaceChildren prints a null as "null".
  expect(nodes.every(Boolean)).toBe(true)
  return nodes.map((n) => n.textContent).join(' | ')
}

describe('healthRows', () => {
  it('says all is well, and when the last push and copy were', () => {
    const now = new Date().toISOString()
    const out = text(healthRows({ troubles: [], push: { configured: true, lastOkAt: now, lastFailedAt: null, lastError: null }, lastBackup: new Date().toLocaleDateString('en-CA'), budgetsOutToday: [] }))
    expect(out).toMatch(/All reporting/)
    expect(out).toMatch(/Reached the phone just now/)
    expect(out).toMatch(/Daily copy of the record.*Last /)
    expect(out).not.toMatch(/Model budget/)
  })

  it('names what stands broken, a failed push and a spent budget', () => {
    const now = new Date().toISOString()
    const out = text(healthRows({ troubles: [{ key: 'input-grant', since: now, observation: 'Input Monitoring is off for Sundial.', said: true }], push: { configured: true, lastOkAt: null, lastFailedAt: now, lastError: 'timeout' }, lastBackup: null, budgetsOutToday: ['companion'] }))
    expect(out).toMatch(/Input Monitoring.*Input Monitoring is off for Sundial\..*Since just now/)
    expect(out).toMatch(/did not reach the phone \(timeout\)/)
    expect(out).toMatch(/None yet/)
    expect(out).toMatch(/Out: companion/)
  })
})

describe('what Gnomon may do alone (W5 step 10)', () => {
  it('shows each capability\'s level and numbers with n, Act pressable only once earned, and the folded rows', async () => {
    const data = {
      capabilities: [
        { capability: 'actions', level: 'ask', earned: false, granted: null, rows: 'row 11: verified 67% (n = 82), did not fail 90.8% (n = 1,085); needs 98% each at n ≥ 30' },
        { capability: 'notice:agent-waiting', level: 'ask', earned: true, granted: null, rows: 'row 4: 90% worth hearing, n = 31; needs 80% at n ≥ 30' },
      ],
      scorecard: [{ id: 4, metric: 'Notices judged worth hearing, per kind', value: '58.3% (n = 12, too small to trust)', target: '≥ 80%', meets: false }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => data })))
    const node = autonomyBlock()
    await new Promise((r) => setTimeout(r, 0))
    const rows = [...node.querySelectorAll('.set-row')].map((r) => r.textContent)
    expect(rows[0]).toMatch(/Commands and outward actions.*n = 82.*OffAskAct/)
    expect(rows[0]).toContain('a warning only: what you ask for runs as your Ask/Auto chip says')
    expect(rows[1]).toMatch(/Interrupt: agent-waiting.*n = 31/)
    expect(rows[1]).not.toContain('warning')
    const act = [...node.querySelectorAll('[role=radiogroup]')].map((g) => g.querySelector('button:last-child').disabled)
    expect(act).toEqual([true, false])
    expect(rows[2]).toMatch(/4\. Notices judged worth hearing.*n = 12, too small to trust.*Below target/)
    vi.unstubAllGlobals()
  })
})
