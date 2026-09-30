// The host has no build step either: a route file that throws while it mounts
// (a name used before it is defined, a missing export) takes every route with it,
// and only a live boot would show it. This mounts the whole plugin on a fake ctx.
import { describe, expect, it, vi } from 'vitest'

export function fakeCtx(state = null) {
  const routes = new Map()
  const any = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : any()), apply: () => any() })
  const ctx = new Proxy(
    { effect: (fn) => fn(), webServer: { register: (r) => routes.set(r.path, r) }, connection: { requestRejection: () => undefined }, gnomonKernel: { getState: () => state, appendSignal: vi.fn(async () => {}) } },
    { get: (t, k) => (k in t ? t[k] : any()) },
  )
  return { ctx, routes }
}

describe('the theme mounts', () => {
  it('registers every route without throwing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { apply } = await import('../index.js')
    const { ctx, routes } = fakeCtx()
    apply(ctx)
    const api = [...routes.keys()].filter((p) => p.startsWith('/gnomon/') && !p.startsWith('/gnomon/app/'))
    expect(api).toContain('/gnomon/situation')
    expect(api).toContain('/gnomon/api/turn')
    expect(api.length).toBeGreaterThan(70)
    // The browser gets its own folder only: host code is not an asset (W4 step 12).
    expect(routes.has('/gnomon/app/app.js')).toBe(true)
    expect(['/gnomon/app/server.js', '/gnomon/app/guard.js', '/gnomon/app/http.js'].filter((p) => routes.has(p))).toEqual([])
  })

  // W4 step 10: every route a card reader reads is a view, read in process (no loopback).
  it('serves every path the card readers read as a view', async () => {
    const { readFileSync } = await import('node:fs')
    const { INSTRUMENT_ROUTES } = await import('../shell/cards.js')
    const { READS } = await import('./http.js')
    const { apply } = await import('../index.js')
    apply(fakeCtx().ctx)
    const source = readFileSync(new URL('../../sundial-tools/card-readers.js', import.meta.url), 'utf8')
    const paths = [...source.matchAll(/read\(['`](\/gnomon\/[a-z/-]+)/g)].map((m) => m[1]).concat(Object.values(INSTRUMENT_ROUTES))
    expect(paths.length).toBeGreaterThan(15)
    expect(paths.filter((p) => !READS.has(p))).toEqual([])
  })
})
