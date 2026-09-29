// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { healthRows, nextPaper } from './settings.js'

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
