import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The board asked for four routes twice at every boot, because two cards wanted
 * the same reading and neither knew about the other — and the harness is one
 * thread, so the second copy was pure queue. These are the two rules that stop
 * it, and the one rule that keeps the beat honest: a short memory, never a long
 * one, or an instrument would redraw a record that had already moved.
 */

// `read.js` opens an IntersectionObserver at import; jsdom is not in this
// project, so the module's own fallback path (no observer) is what runs here.
const load = async () => {
  vi.resetModules()
  return await import('./read.js')
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const ok = (value) => Promise.resolve({ ok: true, json: async () => value })

describe('read', () => {
  it('makes ONE request when two callers ask at the same moment', async () => {
    const fetchMock = vi.fn(() => ok({ n: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const { read } = await load()
    const [a, b] = await Promise.all([read('/gnomon/asks'), read('/gnomon/asks')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual({ n: 1 })
    expect(b).toEqual({ n: 1 })
  })

  it('serves a second ask from the short memory, and re-reads once it is stale', async () => {
    let n = 0
    const fetchMock = vi.fn(() => ok({ n: ++n }))
    vi.stubGlobal('fetch', fetchMock)
    const { read } = await load()

    expect(await read('/gnomon/day')).toEqual({ n: 1 })
    expect(await read('/gnomon/day')).toEqual({ n: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // The beat is thirty seconds; the memory must never outlive it.
    vi.advanceTimersByTime(2100)
    expect(await read('/gnomon/day')).toEqual({ n: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('names what is in flight, and says so again when nothing is', async () => {
    let settle
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => (settle = () => resolve({ ok: true, json: async () => ({}) })))),
    )
    const { read, onReading } = await load()
    const seen = []
    onReading((names) => seen.push(names))

    const pending = read('/gnomon/api/sessions?x=1')
    expect(seen.at(-1)).toEqual(['sessions'])
    settle()
    await pending
    expect(seen.at(-1)).toEqual([])
  })

  it('drops the memory of a route a changed table feeds, and keeps the rest', async () => {
    let n = 0
    const fetchMock = vi.fn(() => ok({ n: ++n }))
    vi.stubGlobal('fetch', fetchMock)
    const { read, markStale } = await load()

    expect(await read('/gnomon/memory')).toEqual({ n: 1 })
    expect(await read('/gnomon/ledger')).toEqual({ n: 2 })

    // A fact moved. `/gnomon/memory` is made of entity_facts; the ledger is
    // made of llm_audit and has no reason to be read again.
    markStale(['entity_facts'])
    expect(await read('/gnomon/memory')).toEqual({ n: 3 })
    expect(await read('/gnomon/ledger')).toEqual({ n: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ignores a change in a table no route is made of, and an empty frame', async () => {
    const fetchMock = vi.fn(() => ok({ n: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const { read, markStale } = await load()

    await read('/gnomon/memory')
    markStale(['effect_journal'])
    markStale([])
    markStale(undefined)
    await read('/gnomon/memory')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not remember a failure', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)
    const { read } = await load()
    await expect(read('/gnomon/trust')).rejects.toThrow('500')
    await expect(read('/gnomon/trust')).rejects.toThrow('500')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
