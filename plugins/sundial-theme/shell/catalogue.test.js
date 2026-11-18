// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARCHETYPES, FORMS, checkSpec } from '@sundial/nodus/spec.js'
import { VIEWS } from '@sundial/nodus/views.js'
import { PLATES } from '@sundial/nodus/fixture.test-data.js'
import { addComment, catalogue, closeCatalogue, commentsFor, mountDemo, openCatalogue, sketchOf } from './catalogue.js'

const items = (id) => catalogue().find((s) => s.id === id).items

describe('the catalogue is read from the code that draws', () => {
  it('leads with what Gnomon can show, and folds the engine under the hood', () => {
    const sections = catalogue()
    expect(sections.filter((s) => !s.hood).map((s) => s.id)).toEqual(['modes', 'show'])
    expect(items('show').map((i) => i.title)).toEqual(['Timeline', 'Distribution', 'Flow', 'Exploded', 'Orbit', 'Particle field', 'Contour', 'Network', 'Table', 'Comparison', 'Map route', 'Radial clock', 'Floor plan', 'Gauge wall', 'Calendar grid'])
    for (const i of items('show')) expect(i.use, i.id).toBeTruthy()
  })

  it('draws the route, the clock and the plan, and keeps only the gauge wall and the calendar planned', () => {
    expect(items('show').filter((i) => i.planned).map((i) => i.title)).toEqual(['Gauge wall', 'Calendar grid'])
  })

  it('opens the parts on the spec sheet: one plate per archetype Nodus plates', async () => {
    const plate = items('parts').find((i) => i.id === 'part.plate')
    expect((await plate.demo()).map((s) => s.archetype)).toEqual(Object.keys(PLATES))
  })

  it('shows a planned idiom as a sketch, never as a figure that exists', () => {
    for (const i of items('show').filter((i) => i.planned)) {
      expect(i.demo, i.id).toBeUndefined()
      expect(sketchOf(i.sketch), i.id).toContain('<svg')
    }
  })

  it('gives every built idiom its own silhouette: no two demos are the same figure', async () => {
    const shapes = []
    for (const i of items('show').filter((i) => i.demo)) {
      const spec = await i.demo()
      shapes.push(spec.form === 'scene' ? `${spec.archetype}:${[...new Set(spec.lanes.map((l) => l.kind))].sort()}` : `${spec.form}:${spec.view}`)
    }
    expect(new Set(shapes).size).toBe(shapes.length)
  })

  it('lists every form, archetype, kit kind and view under the hood', () => {
    expect(items('forms').map((i) => i.title)).toEqual(FORMS)
    expect(items('archetypes').map((i) => i.title)).toEqual(Object.keys(ARCHETYPES))
    expect(items('parts').filter((i) => i.id !== 'part.plate').map((i) => i.id)).toEqual(Object.entries(ARCHETYPES).flatMap(([a, { kinds }]) => kinds.map((k) => `part.${a}.${k}`)))
    expect(items('views').map((i) => i.title)).toEqual(Object.keys(VIEWS))
    expect(items('views').map((i) => i.about.toLowerCase())).toEqual(Object.values(VIEWS).map((v) => `${v.about}.`.toLowerCase()))
  })

  it('gives every item a unique id and a line, with no em dash anywhere', () => {
    const all = catalogue().flatMap((s) => s.items)
    expect(new Set(all.map((i) => i.id)).size).toBe(all.length)
    for (const i of all) expect(i.about.trim(), i.id).not.toBe('')
    expect(JSON.stringify(catalogue())).not.toContain('\u2014')
  })

  it('draws every demo from made-up rows into a spec Nodus accepts as it is, with a walk', async () => {
    for (const item of catalogue().flatMap((s) => s.items).filter((i) => i.demo)) {
      const specs = [await item.demo()].flat()
      expect(specs.length, item.id).toBeGreaterThan(0)
      for (const spec of specs) {
        expect(spec, item.id).toBeTruthy()
        expect(checkSpec(spec).problems, item.id).toEqual([])
        expect(spec.steps.length, item.id).toBeGreaterThan(0)
      }
    }
  })
})

describe('the page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('mounts a demo the first time it comes into view, and the walk steps', async () => {
    let seen = null
    vi.stubGlobal('IntersectionObserver', class {
      constructor(fn) { seen = fn }
      observe() {}
      unobserve() {}
    })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ cards: {} }) })))
    document.body.innerHTML = '<aside id="ghost"></aside><div id="canvas"></div>'
    openCatalogue()
    expect(location.hash).toBe('#catalogue')
    expect(document.querySelector('#cat-hood').open).toBe(false)
    expect(document.querySelectorAll('.cat-planned svg').length).toBe(2)
    const slot = document.querySelector('.cat-demo[data-item^="idiom."]')
    expect(slot.querySelector('.nodus')).toBeNull()
    seen([{ isIntersecting: true, target: slot }])
    await vi.waitFor(() => expect(slot.querySelector('.nodus')).not.toBeNull())
    const nodus = slot.querySelector('.nodus')
    nodus.querySelector('.nodus-next').click()
    expect(nodus.dataset.step).not.toBe('-1')
    closeCatalogue()
    expect(location.hash).toBe('')
    expect(document.getElementById('catalogue').hidden).toBe(true)
  })

  it('says so when an item has nothing to draw', async () => {
    const slot = document.createElement('div')
    await mountDemo(slot, { demo: () => null })
    expect(slot.textContent).toContain('no demo yet')
  })
})

describe('comments are notes on the board', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists the notes bound to one item, newest first, and nothing else', () => {
    const board = {
      cards: {
        'note:a': { id: 'note:a', kind: 'note', text: 'older', filters: { catalogue: 'idiom.flow' }, at: '2026-03-09T08:00:00Z' },
        'note:b': { id: 'note:b', kind: 'note', text: 'newer', filters: { catalogue: 'idiom.flow' }, at: '2026-03-09T09:00:00Z' },
        'note:c': { id: 'note:c', kind: 'note', text: 'elsewhere', filters: { catalogue: 'idiom.table' }, at: '2026-03-09T10:00:00Z' },
        'note:d': { id: 'note:d', kind: 'note', text: 'a plain note', filters: null, at: '2026-03-09T10:00:00Z' },
        'note:e': { id: 'note:e', kind: 'note', text: '  ', filters: { catalogue: 'idiom.flow' }, at: '2026-03-09T11:00:00Z' },
      },
    }
    expect(commentsFor(board, 'idiom.flow').map((n) => n.text)).toEqual(['newer', 'older'])
    expect(commentsFor(null, 'idiom.flow')).toEqual([])
  })

  it('writes one board:place through the existing note path', async () => {
    const fetch = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetch)
    await addComment('idiom.flow', 'Steadier labels, please')
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('/gnomon/api/board')
    expect(JSON.parse(init.body)).toMatchObject({ action: 'place', kind: 'note', text: 'Steadier labels, please', filters: { catalogue: 'idiom.flow' } })
    expect(JSON.parse(init.body).id).toMatch(/^note:cat-/)
  })
})
