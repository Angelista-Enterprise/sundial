import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGate } from './gate.js'
import { createLibrary } from './library.js'

const session = { id: 's1', header: {} }
const owner = (text) => ({ type: 'user/message', data: { text } })
const flush = () => new Promise((r) => setTimeout(r, 0))

function gate({ routed = { view: 'where', p: 0.8, words: 0.1 }, drawn = { ok: true, spec: { view: 'where', by: {} } }, canPlace = true } = {}) {
  const manager = { routeOnly: vi.fn(async () => routed), drawIn: vi.fn(() => Promise.resolve(drawn)) }
  const place = vi.fn(async () => 'nodus:a')
  const on = createGate({ manager, place, canPlace: () => canPlace, isOwner: () => true, textOf: (d) => d.text, log: () => {}, warn: () => {} })
  return { on, manager, place }
}

describe('the route gate', () => {
  it('starts the build Jev routes to while the turn runs, and places it as soon as it lands', async () => {
    const { on, manager, place } = gate()
    on(session, owner('where did my time go'))
    await flush()
    expect(manager.drawIn).toHaveBeenCalledWith({ ask: 'where did my time go', view: 'where', mode: 'auto' })
    expect(place).toHaveBeenCalledTimes(1)
  })

  it('asks for the shape the route chose, and places a both figure’s scene beside its rows', async () => {
    const scene = { ok: true, spec: { view: 'where', form: 'scene', by: {} } }
    const { on, manager, place } = gate({ routed: { view: 'where', p: 0.8, words: 0.1, form: 'both' }, drawn: { ok: true, spec: { view: 'where', form: 'bars', by: {} }, scene: Promise.resolve(scene) } })
    on(session, owner('where did my time go, and show me'))
    await flush()
    expect(manager.drawIn).toHaveBeenCalledWith({ ask: 'where did my time go, and show me', view: 'where', form: 'both', mode: 'auto' })
    expect(place.mock.calls[1]).toEqual([scene, { near: 'nodus:a' }])
    // Gnomon drawing the same view in its own words gets the same shape.
    expect(on.shapeFor('s1', 'where')).toBe('both')
    expect(on.shapeFor('s1', 'day')).toBeUndefined()
  })

  it("lends its build to Gnomon's draw of the same figure in the same mode, in any words", async () => {
    const { on } = gate()
    on(session, owner('where did my time go'))
    await flush()
    const out = await on.join('s1', { mode: 'auto' })
    expect(out.spec.view).toBe('where')
    expect(await on.join('s1', { view: 'where', mode: 'auto' })).toBe(out)
    expect(await on.join('s1', { view: 'week', mode: 'auto' })).toBeNull()
    expect(await on.join('s1', { mode: 'studio' })).toBeNull()
    expect(await on.join('s2', { mode: 'auto' })).toBeNull()
  })

  it('hands its card over once when Gnomon draws later in the same turn', async () => {
    const { on } = gate()
    on(session, owner('where did my time go'))
    await flush()
    expect(on.takeOver('s1')).toBe('nodus:a')
    expect(on.takeOver('s1')).toBeNull()
  })

  it('leaves the card to Gnomon when it drew first in the turn, even through gnomon_call', async () => {
    let land
    const { on, place } = gate({ drawn: new Promise((r) => (land = r)) })
    on(session, owner('my day'))
    on(session, { type: 'tool/call', data: { name: 'gnomon_call', arguments: '{"name":"gnomon_visualize"}' } })
    land({ ok: true, spec: { view: 'day', by: {} } })
    await flush()
    expect(place).not.toHaveBeenCalled()
  })

  it('draws nothing for words, for an unsure route, or when staging is off', async () => {
    for (const g of [gate({ routed: { view: null, p: 0.9, words: 0.9 } }), gate({ routed: { view: 'day', p: 0.3, words: 0.5 } }), gate({ routed: { view: 'threads', p: 0.29, words: 0.45 } }), gate({ canPlace: false })]) {
      g.on(session, owner('hello'))
      await flush()
      g.on(session, { type: 'turn/end', data: {} })
      await flush()
      expect(g.manager.drawIn).not.toHaveBeenCalled()
      expect(g.place).not.toHaveBeenCalled()
    }
  })

  it('draws a view Jev picked among many even at low confidence, when words are unlikely', async () => {
    const { on, place } = gate({ routed: { view: 'threads', p: 0.29, words: 0.05 } })
    on(session, owner('what am I in the middle of'))
    await flush()
    expect(place).toHaveBeenCalledTimes(1)
  })

  it('redraws its card as the view the answer reads, on the same id, once', async () => {
    const { on, manager, place } = gate({ routed: { view: 'threads', p: 0.81, words: 0.17 }, drawn: { ok: true, spec: { view: 'threads', by: {} } } })
    on(session, owner('how many PRs do I have open'))
    on(session, { type: 'tool/call', data: { name: 'gnomon_call', arguments: '{"name":"gnomon_pull_requests","args":{}}' } })
    await flush()
    await flush()
    expect(manager.drawIn).toHaveBeenLastCalledWith({ ask: 'how many PRs do I have open', view: 'prs', mode: 'auto' })
    expect(place).toHaveBeenLastCalledWith(expect.anything(), { id: 'nodus:a' })
    on(session, { type: 'tool/call', data: { name: 'gnomon_goals', arguments: '{}' } })
    await flush()
    expect(manager.drawIn).toHaveBeenCalledTimes(2)
  })

  it('keeps its card when the answer reads its own rows, or a read no view rests on', async () => {
    for (const tool of ['gnomon_open_commitments', 'gnomon_agent_sessions']) {
      const { on, manager, place } = gate({ routed: { view: 'threads', p: 0.8, words: 0.1 }, drawn: { ok: true, spec: { view: 'threads', by: {} } } })
      on(session, owner('what am I in the middle of'))
      on(session, { type: 'tool/call', data: { name: tool, arguments: '{}' } })
      await flush()
      await flush()
      expect(manager.drawIn).toHaveBeenCalledTimes(1)
      expect(place).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores a subagent’s session', async () => {
    const { on, manager } = gate()
    on({ id: 's2', header: { origin: 'subagent' } }, owner('my day'))
    await flush()
    expect(manager.routeOnly).not.toHaveBeenCalled()
  })
})

describe('the library', () => {
  // A stand-in embedding: a word-count vector over a tiny vocabulary, normalized.
  const VOCAB = ['where', 'time', 'went', 'day', 'cost', 'hours', 'go']
  const embed = async (text) => {
    const v = VOCAB.map((w) => (String(text).toLowerCase().includes(w) ? 1 : 0))
    const n = Math.hypot(...v) || 1
    return { vector: v.map((x) => x / n), model: 'test' }
  }
  const spec = (ask, fits, by = 'model') => ({ ask, view: 'where', title: 't', headline: 'h', steps: [{ say: `${ask} said` }], by: { storyboard: by, critic: { fits } } })

  it('keeps only walks the critic passed, and finds the nearest for a like ask, across a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nodus-lib-')), 'lib.jsonl')
    const lib = createLibrary({ file, embed })
    expect(await lib.keep(spec('where did my time go', 2.6))).toBe(true)
    expect(await lib.keep(spec('where did the day go', 1.2))).toBe(false)
    expect(await lib.keep(spec('where did the hours go', 2.9, 'fallback'))).toBe(false)
    expect(await lib.keep(spec('what did it cost', 2.5))).toBe(true)
    const again = createLibrary({ file, embed })
    expect(again.size()).toBe(2)
    expect(await again.like('where has the time gone', 'where')).toEqual([{ ask: 'where did my time go', steps: ['where did my time go said'] }])
    expect(await again.like('where has the time gone', 'day')).toEqual([])
  })

  it('reuses the walk kept for the very same figure within the hour, ids and all', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nodus-lib-')), 'lib.jsonl')
    const lib = createLibrary({ file, embed })
    const source = { view: 'where', args: { date: '2026-03-09', as: 'scene' } }
    await lib.keep({ ...spec('where did my time go', 2.6), source, steps: [{ focus: ['p:x'], say: 'x took it.' }] })
    const now = Date.now()
    expect(lib.reuse(source, now)).toMatchObject({ steps: [{ focus: ['p:x'], say: 'x took it.' }], fits: 2.6, title: 'h' })
    expect(createLibrary({ file, embed }).reuse(source, now)).not.toBeNull()
    expect(lib.reuse({ view: 'where', args: { date: '2026-03-09' } }, now)).toBeNull()
    expect(lib.reuse(source, now + 3_600_001)).toBeNull()
  })
})
