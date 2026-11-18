import { describe, expect, it, vi } from 'vitest'
import { BUILD_LIMIT_MS, buildDown, chooseMode, CHOICES, guessMode, ladder, MODES, modeOf, MODE_IDS, pick, SWITCH, wrap } from './index.js'
import { createManager } from '../orchestrate.js'

describe('the mode registry', () => {
  it('holds sketch, studio, atlas and plate, each with the whole contract', () => {
    expect(MODE_IDS).toEqual(['sketch', 'studio', 'atlas', 'plate'])
    expect(CHOICES).toEqual(['auto', 'sketch', 'studio', 'atlas', 'plate'])
    for (const m of Object.values(MODES)) {
      for (const k of ['id', 'label', 'blurb', 'when']) expect(typeof m[k]).toBe('string')
      for (const k of ['build', 'draw', 'supports', 'ready']) expect(typeof m[k]).toBe('function')
    }
    expect(SWITCH.map((m) => m.label)).toEqual(['Auto', 'Sketch', 'Studio', 'Atlas', 'Plate'])
  })
  it('says no jargon to the owner', () => {
    const said = SWITCH.map((m) => `${m.label} ${m.blurb}`).join(' ') + Object.values(MODES).map((m) => m.when).join(' ')
    expect(said).not.toMatch(/archetype|blueprint|spec|\u2014/i)
  })
  it('keeps the record for Sketch', () => {
    expect(MODES.studio.supports('show my day', { view: 'day' })).toBe(false)
    expect(MODES.atlas.supports('show my day', { view: 'day' })).toBe(false)
    expect(MODES.studio.supports('how a heat pump works', { view: 'free' })).toBe(true)
  })
  it('wraps a product in the shape every reader takes, and knows it again', () => {
    const w = wrap({ mode: 'studio', product: { kind: 'program', code: 'x', steps: ['One.', { say: 'Two.', focus: ['a'] }], title: 'Heat pump' }, ask: 'how a heat pump works' })
    expect(w).toMatchObject({ v: 1, form: 'scene', mode: 'studio', title: 'Heat pump', lanes: [], parts: [], steps: [{ say: 'One.', focus: [] }, { say: 'Two.', focus: ['a'] }] })
    expect(w.by.storyboard).not.toBe('model')
    expect(modeOf(w)).toBe(w)
    expect(modeOf({ v: 1, form: 'scene', mode: 'sketch' })).toBe(null)
    expect(modeOf({ v: 1, form: 'timeline' })).toBe(null)
  })
})

describe('Auto', () => {
  it('draws the record in Sketch without asking Jev', async () => {
    const judge = vi.fn()
    expect(await chooseMode('show me my day', { route: { view: 'day' }, judge })).toEqual({ mode: 'sketch', by: 'record' })
    expect(judge).not.toHaveBeenCalled()
  })
  it("takes Jev's one typed choice for anything else", async () => {
    const judge = vi.fn(async ({ questions, set }) => {
      expect(Object.keys(questions.mode.criteria).sort()).toEqual(['atlas', 'sketch', 'studio'])
      expect(set).toBe('nodus.mode.v1')
      return { mode: { choice: 'atlas', confidence: 0.8 } }
    })
    expect(await chooseMode('the bicep and the layers under it', { route: { view: 'free' }, judge })).toEqual({ mode: 'atlas', by: 'jev', p: 0.8 })
  })
  it('guesses when Jev cannot say', async () => {
    expect(await chooseMode('the bicep and the layers under it', { route: { view: 'free' }, judge: async () => null })).toMatchObject({ mode: 'atlas', by: 'guess' })
    expect(guessMode('how a heat pump works', { view: 'free' })).toBe('studio')
    expect(guessMode('hello')).toBe('sketch')
  })
})

describe('the ladder', () => {
  it('steps down atlas, studio, sketch', () => {
    expect(ladder('atlas')).toEqual(['atlas', 'studio', 'sketch'])
    expect(ladder('studio')).toEqual(['studio', 'sketch'])
    expect(ladder('sketch')).toEqual(['sketch'])
    expect(ladder('plate')).toEqual(['plate', 'sketch'])
  })
  it('passes a mode that is not there, or fails, down to the next', async () => {
    const ready = { atlas: MODES.atlas.ready, studio: MODES.studio.ready, build: MODES.studio.build }
    MODES.atlas.ready = async () => false
    MODES.studio.ready = async () => true
    MODES.studio.build = async () => {
      throw new Error('the program did not run')
    }
    try {
      const sketch = vi.fn(async () => ({ ok: true, spec: { title: 'set' } }))
      const out = await buildDown({ mode: 'atlas' }, 'a heart', { route: { view: 'free' }, sketch })
      expect(out).toMatchObject({ ok: true, mode: 'sketch', tried: [{ mode: 'atlas', why: 'not ready' }, { mode: 'studio', why: 'the program did not run' }] })
      const none = await buildDown({ mode: 'studio' }, 'a heart', { route: { view: 'free' }, sketch: async () => ({ ok: false, reason: 'no model' }) })
      expect(none.ok).toBe(false)
      expect(none.reason).toMatch(/Studio: the program did not run; Sketch: no model/)
    } finally {
      Object.assign(MODES.atlas, { ready: ready.atlas })
      Object.assign(MODES.studio, { ready: ready.studio, build: ready.build })
    }
  })
})

describe('the manager draws in a mode', () => {
  const deps = () => ({ read: async () => null, judge: null, complete: null })
  it('places a card that says it is building, then swaps the figure in', async () => {
    const saved = { ready: MODES.studio.ready, build: MODES.studio.build }
    let finish
    MODES.studio.ready = async () => true
    MODES.studio.build = () => new Promise((r) => (finish = r))
    try {
      const m = createManager(deps())
      const out = await m.drawIn({ ask: 'how a heat pump works', mode: 'studio', view: 'free' })
      expect(out.spec).toMatchObject({ mode: 'studio', by: { pending: true } })
      finish({ kind: 'program', code: 'function scene(api) {}', steps: ['The compressor squeezes the gas.'], title: 'A heat pump' })
      const done = await out.later
      expect(done.spec).toMatchObject({ mode: 'studio', title: 'A heat pump', product: { kind: 'program' } })
      expect(done.spec.by.pending).toBeUndefined()
    } finally {
      Object.assign(MODES.studio, saved)
    }
  })
  it('keeps a record ask in Sketch whatever the thread chose', async () => {
    expect(await pick('atlas', 'where did the week go', { route: { view: 'week' } })).toEqual({ mode: 'sketch', by: 'record' })
    const build = vi.spyOn(MODES.atlas, 'build')
    await createManager(deps()).drawIn({ ask: 'where did the week go', mode: 'atlas', view: 'week' })
    expect(build).not.toHaveBeenCalled()
    build.mockRestore()
  })
  it('gives up on a build that never ends: Studio after 120 s, as words', async () => {
    vi.useFakeTimers()
    const saved = { ready: MODES.studio.ready, build: MODES.studio.build }
    MODES.studio.ready = async () => true
    MODES.studio.build = () => new Promise(() => {})
    try {
      const out = createManager(deps()).drawIn({ ask: 'how a heat pump works', mode: 'studio', view: 'free' })
      await vi.advanceTimersByTimeAsync(500)
      const placed = await out
      expect(placed.spec.by.pending).toBe(true)
      await vi.advanceTimersByTimeAsync(BUILD_LIMIT_MS.studio)
      expect((await placed.later).spec.by.failed).toMatch(/Studio took longer than 120 s/)
    } finally {
      Object.assign(MODES.studio, saved)
      vi.useRealTimers()
    }
  })
  it('hands a failure on as words, never no card', async () => {
    const saved = { ready: MODES.studio.ready, build: MODES.studio.build }
    MODES.studio.ready = async () => true
    MODES.studio.build = async () => null
    try {
      const out = await createManager(deps()).drawIn({ ask: 'how a heat pump works', mode: 'studio', view: 'free' })
      const done = out.later ? await out.later : out
      expect(done.spec.by.failed).toMatch(/Studio: nothing came back/)
    } finally {
      Object.assign(MODES.studio, saved)
    }
  })
})
