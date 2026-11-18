// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { modeSwitch } from './mode-switch.js'

const MODES = [{ id: 'auto', label: 'Auto', ready: true }, { id: 'sketch', label: 'Sketch', ready: true }, { id: 'studio', label: 'Studio', ready: true }, { id: 'atlas', label: 'Atlas', ready: false }]
const tick = () => new Promise((r) => setTimeout(r, 0))
const checked = (g) => g.querySelector('[aria-checked="true"]')?.dataset.mode

describe('the thread bar mode switch', () => {
  it('shows Auto pressed on a fresh thread from its first paint, before the server answers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const g = modeSwitch('fresh')
    expect(checked(g)).toBe('auto')
    expect([...g.querySelectorAll('[data-mode]')].map((b) => b.dataset.mode)).toEqual(['auto', 'sketch', 'studio', 'atlas', 'plate'])
  })
  afterEach(() => vi.unstubAllGlobals())
  it("marks a press only once the server kept it, and an older read never undoes it", async () => {
    let release
    const fetch = vi.fn((url, init) => {
      if (init?.method === 'POST') return new Promise((r) => (release = () => r({ ok: true, json: async () => ({ mode: 'studio', modes: MODES }) })))
      return Promise.resolve({ ok: true, json: async () => ({ mode: 'auto', modes: MODES }) })
    })
    vi.stubGlobal('fetch', fetch)
    const g = modeSwitch('t1')
    await tick()
    expect(checked(g)).toBe('auto')
    expect(g.querySelector('[data-mode="atlas"]').getAttribute('aria-disabled')).toBe('true')
    g.querySelector('[data-mode="studio"]').click()
    await tick()
    expect(checked(g)).toBe('auto')
    // The bar drawn again meanwhile (a thread frame): it shows what is known at once.
    const again = modeSwitch('t1')
    expect(checked(again)).toBe('auto')
    release()
    await tick()
    await tick()
    expect(checked(g)).toBe('studio')
    expect(checked(again)).toBe('studio')
    expect(checked(modeSwitch('t1'))).toBe('studio')
  })
})
