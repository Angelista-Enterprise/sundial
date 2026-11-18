import { describe, expect, it, vi } from 'vitest'
import { createVisualize, screenOf, settleOrphans } from './visualize.js'
import { DAY } from '../../packages/nodus/src/fixture.test-data.js'

const walk = JSON.stringify({ title: 'A long build', steps: [{ focus: ['p:puzzlebox-studio'], say: 'puzzlebox-studio held most of your morning.' }, { focus: ['m:1'], say: 'Planning with Mira took the hour before lunch.' }] })

function kernel({ autonomy = 'act', reserve = 'call-1', judged = null } = {}) {
  return {
    getState: () => ({ settings: { autonomy } }),
    appendSignal: vi.fn(async () => {}),
    reserveLlmCall: vi.fn(async () => reserve),
    judgeNow: vi.fn(async () => judged),
  }
}

describe('gnomon_visualize', () => {
  it('places the card at once walked by the numbers, then swaps in the walk of the visualize call it reserved and audited', async () => {
    const k = kernel()
    const call = vi.fn(async () => ({ content: walk }))
    const emit = vi.fn()
    const execute = createVisualize({ kernel: k, read: async () => DAY, call, emit, now: () => 1_700_000_000_000 })
    const out = await execute({ ask: 'how did my day go' })
    // The live channel hears it at once: no reload between the tool and the card.
    expect(emit).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ done: true, id: 'nodus:loyw3v28', walkBy: "the numbers, Gnomon's walk on its way" })
    const [type, payload] = k.appendSignal.mock.calls[0]
    expect(type).toBe('board:place')
    expect(payload).toMatchObject({ id: 'nodus:loyw3v28', kind: 'nodus', by: 'gnomon' })
    expect(JSON.parse(payload.text).by).toMatchObject({ storyboard: 'fallback', pending: true })
    expect(k.appendSignal.mock.calls[1][0]).toBe('board:focus')
    // The model's walk lands on the same card, and the channel hears that too.
    const final = await execute.place.settled(out.id)
    expect(final.spec).toMatchObject({ headline: 'A long build', by: { storyboard: 'model' } })
    expect(k.reserveLlmCall).toHaveBeenCalledWith('visualize', { caller: 'gnomon_visualize' })
    expect(call.mock.calls[0][0]).toMatchObject({ purpose: 'visualize', callId: 'call-1', momentId: null, maxTokens: 600 })
    const [type2, swap] = k.appendSignal.mock.calls[2]
    expect(type2).toBe('board:place')
    expect(swap.id).toBe('nodus:loyw3v28')
    expect(JSON.parse(swap.text).steps).toHaveLength(2)
    expect(JSON.parse(swap.text).by.pending).toBeUndefined()
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('does not swap a walk onto a card the owner removed meanwhile', async () => {
    const k = kernel()
    k.getState = () => ({ settings: { autonomy: 'act' }, board: { cards: {} } })
    const execute = createVisualize({ kernel: k, read: async () => DAY, call: async () => ({ content: walk }) })
    const out = await execute({ ask: 'my day' })
    expect(await execute.place.settled(out.id)).toBeNull()
    expect(k.appendSignal.mock.calls.map((c) => c[0])).toEqual(['board:place', 'board:focus'])
  })

  it('takes the place of the card the route gate guessed in the same turn', async () => {
    const k = kernel()
    k.getState = () => ({ settings: { autonomy: 'act' }, board: { cards: { 'nodus:guess': {} } } })
    const execute = createVisualize({ kernel: k, read: async () => DAY, call: async () => ({ content: walk }), takeOver: (sid) => (sid === 's1' ? 'nodus:guess' : null) })
    await execute({ ask: 'my day', view: 'day' }, { agent: { session: { id: 's1' } } })
    expect(k.appendSignal.mock.calls.map((c) => c[0])).toEqual(['board:place', 'board:focus', 'board:remove'])
    expect(k.appendSignal.mock.calls[2][1]).toEqual({ id: 'nodus:guess', by: 'gnomon' })
  })

  it('walks from the numbers when the budget refuses, and never calls the model', async () => {
    const k = kernel({ reserve: null })
    const call = vi.fn()
    const execute = createVisualize({ kernel: k, read: async () => DAY, call })
    const out = await execute({ ask: 'my day' })
    expect((await execute.place.settled(out.id)).spec.by.storyboard).toBe('fallback')
    expect(call).not.toHaveBeenCalled()
  })

  it('asks Jev through judgeNow on the judge purpose', async () => {
    const k = kernel({ judged: { answers: { fits: { type: 'score', score: 2.4 } }, model: 'jev' } })
    const execute = createVisualize({ kernel: k, read: async () => DAY, call: async () => ({ content: walk }) })
    const out = (await execute.place.settled((await execute({ ask: 'my day' })).id)).spec.by
    // First the route (no view was named), then the walk's check.
    expect(k.judgeNow.mock.calls.map((c) => c[0].questionSetId)).toEqual(['nodus.route.v1', 'nodus.walk.v1'])
    expect(k.judgeNow.mock.calls[1][0]).toMatchObject({ purpose: 'judge', caller: 'gnomon_visualize' })
    expect(out.critic).toEqual({ fits: 2.4 })
  })

  it('previews without placing, even when staging is off, and refuses to place then', async () => {
    const k = kernel({ autonomy: 'suggest' })
    const execute = createVisualize({ kernel: k, read: async () => DAY, call: async () => ({ content: walk }) })
    expect((await execute({ ask: 'x', preview: 'true' })).spec.form).toBe('timeline')
    expect((await execute({ ask: 'x', preview: 'false' })).reason).toMatch(/board staging to "suggest"/)
    expect(k.appendSignal).not.toHaveBeenCalled()
  })

  it('refuses a malformed date before reading anything', async () => {
    const read = vi.fn()
    expect(await createVisualize({ kernel: kernel(), read, call: vi.fn() })({ ask: 'x', date: 'yesterday' })).toEqual({ done: false, reason: 'date is YYYY-MM-DD' })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the screen from the fold alone: the window, the moment’s project, the typed facts; nothing when idle', () => {
    const state = { moment: { projectId: '/Users/x/Projects/tidewater', processName: 'Code' }, window: { active: { processName: 'Code', windowTitle: 'tide.ts' } }, screen: { refs: ['TIDE-12', '#42'], facts: [{ kind: 'error', value: 'TypeError: x is undefined' }, { kind: 'file', value: 'tide.ts' }], kept: ['raw line never read'] } }
    expect(screenOf(state)).toEqual({ title: 'tide.ts', app: 'Code', project: 'tidewater', ticket: 'TIDE-12', pr: '#42', error: 'TypeError: x is undefined', file: 'tide.ts' })
    expect(screenOf({ ...state, moment: null })).toBeNull()
  })

  it('places both: the rows, then the scene of the same read beside them', async () => {
    const k = kernel()
    const read = vi.fn(async () => DAY)
    let t = 1_700_000_000_000
    const out = await createVisualize({ kernel: k, read, call: async () => null, now: () => (t += 1000) })({ ask: 'where did my time go', view: 'where', form: 'both' })
    expect(out.scene).toMatchObject({ form: 'scene', archetype: 'fluid' })
    const placed = k.appendSignal.mock.calls.filter((c) => c[0] === 'board:place').map((c) => c[1])
    expect(placed[1]).toMatchObject({ id: out.scene.id, near: out.id })
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('the thread mode memory', async () => {
  const { createThreadModes } = await import('./visualize.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  it('remembers each thread, Auto when none, across a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'nodus-modes-')), 'modes.json')
    const a = createThreadModes({ file })
    expect(a.get('t1')).toBe('auto')
    expect(a.set('t1', 'studio')).toBe(true)
    expect(a.set('t2', 'atlas')).toBe(true)
    expect(a.set('t3', 'paint')).toBe(false)
    expect(a.set('', 'studio')).toBe(false)
    const b = createThreadModes({ file })
    expect([b.get('t1'), b.get('t2'), b.get('t3')]).toEqual(['studio', 'atlas', 'auto'])
    b.set('t1', 'auto')
    expect(createThreadModes({ file }).get('t1')).toBe('auto')
  })
  it("the tool draws in the thread's mode; a mode Gnomon names holds only in Auto", async () => {
    const drawIn = vi.fn(async () => ({ ok: false, reason: 'x' }))
    const execute = createVisualize({ kernel: kernel(), read: async () => null, call: async () => ({}), manager: { drawIn }, modeFor: (id) => (id === 's1' ? 'atlas' : 'auto') })
    await execute({ ask: 'a heart' }, { agent: { session: { id: 's1' } } })
    await execute({ ask: 'a heart', mode: 'studio' }, { agent: { session: { id: 's1' } } })
    await execute({ ask: 'a heart', mode: 'studio' }, { agent: { session: { id: 's2' } } })
    await execute({ ask: 'a heart' }, { agent: { session: { id: 's2' } } })
    expect(drawIn.mock.calls.map((c) => c[0].mode)).toEqual(['atlas', 'atlas', 'studio', 'auto'])
  })
})

describe('a card left building by a restart', () => {
  it('says at once it could not draw, with its ask kept for Retry; a drawn card is left alone', () => {
    const building = { v: 1, form: 'scene', mode: 'studio', ask: 'how a heat pump works', title: 'how a heat pump works', steps: [], lanes: [], parts: [], by: { storyboard: 'studio', pending: true } }
    const cards = { 'nodus:a': { kind: 'nodus', text: JSON.stringify(building) }, 'nodus:b': { kind: 'nodus', text: JSON.stringify({ ...building, by: {} }) }, note: { kind: 'note', text: 'x' } }
    const k = { getState: () => ({ board: { cards } }), appendSignal: vi.fn(async () => {}) }
    settleOrphans(k)
    expect(k.appendSignal).toHaveBeenCalledTimes(1)
    const [type, payload] = k.appendSignal.mock.calls[0]
    expect(type).toBe('board:place')
    const spec = JSON.parse(payload.text)
    expect(payload.id).toBe('nodus:a')
    expect(spec).toMatchObject({ mode: 'studio', ask: 'how a heat pump works', by: { failed: 'Sundial restarted while this was being built' } })
    expect(spec.by.pending).toBeUndefined()
  })
})

describe('one build per ask in a turn', () => {
  it("places the gate's build when it can join it, and builds nothing more", async () => {
    const k = kernel()
    const spec = { v: 1, form: 'scene', mode: 'studio', ask: 'heat pump', title: 'A heat pump', steps: [], lanes: [], parts: [], by: { pending: true } }
    const manager = { drawIn: vi.fn() }
    const place = vi.fn(async () => 'nodus:gate')
    const execute = createVisualize({ kernel: k, read: async () => null, call: vi.fn(), manager, place, join: async () => ({ ok: true, spec }), takeOver: () => 'nodus:gate' })
    const out = await execute({ ask: 'Explain how a heat pump moves heat' }, { agent: { session: { id: 's1' } } })
    expect(manager.drawIn).not.toHaveBeenCalled()
    expect(out).toMatchObject({ done: true, id: 'nodus:gate' })
    // The gate's card stays: nothing removed mid-build.
    expect(k.appendSignal).not.toHaveBeenCalledWith('board:remove', expect.anything())
  })
})
