// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { checkSpec } from './spec.js'
import { nodusNode, rebind } from './card.js'
import { drawSceneSvg } from './render-scene-svg.js'
import { overlaps } from './labels.js'
import { bindPeopleScene, bindThreadsScene, bindWeekScene, bindWhereScene } from './bind.js'
import { digest, fallbackSteps, routeQuestions } from './storyboard.js'
import { focusOf } from './focus.js'
import { explodeOf, layoutScene } from './layout-scene.js'
import { build, createManager, route } from './orchestrate.js'
import { readView, VIEWS } from './views.js'
import { DAY, OPEN, PEOPLE, SCENES } from './fixture.test-data.js'

// No WebGL in jsdom: the loader refuses, as it would on a page without three.js.
vi.mock('./three-loader.js', () => ({ loadThree: () => Promise.reject(new Error('no three here')) }))

const scene = (name) => checkSpec(SCENES[name]).spec
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a scene card without WebGL', () => {
  it('says it is loading, then draws the flat scene with its doors, and the walk lights each step', async () => {
    const node = nodusNode(scene('system'))
    expect(node.querySelector('.nodus-plate').textContent).toBe('Loading the stage')
    await settle()
    const svg = node.querySelector('.nodus-plate svg.nd-scene')
    expect(svg).not.toBeNull()
    expect([...svg.querySelectorAll('[data-explore]')].map((d) => d.getAttribute('data-explore'))).toEqual(['search:rainbow'])
    expect(svg.outerHTML).not.toMatch(/fill="#|stroke="#|style=/)
    // The walk's first step was lit before the drawing landed, and is replayed on it: what it focuses and what it names.
    const lit = () => [...svg.querySelectorAll('.nd-glyph.nd-hot')].map((el) => el.getAttribute('data-id'))
    expect(lit()).toEqual(['sun', 'drop'])
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    expect(lit()).toEqual(['drop'])
    expect(svg.querySelector('.nd-link.nd-hot')).not.toBeNull()
    expect(node.querySelector('.nodus-scrub-row').hidden).toBe(true)
    expect(node.querySelector('.nodus-foot').textContent).toMatch(/^Drawn in Sketch · system · 5 parts/)
  })

  it('draws every archetype flat with its labels clear of each other', () => {
    for (const name of Object.keys(SCENES)) {
      const { node, layout } = drawSceneSvg(scene(name))
      expect(node.querySelectorAll('.nd-glyph')).toHaveLength(layout.nodes.length)
      const boxes = [...node.querySelectorAll('.nd-label-scene')].map((t) => ({ x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')) + 4, w: t.textContent.length * 7.6 + 8, h: 16 }))
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i], boxes[j]), `${name} ${i} ${j}`).toBe(false)
    }
  })

  it('keeps the walk over fresh scene rows while what it points at is still there', () => {
    const was = scene('fluid')
    const fresh = checkSpec({ ...SCENES.fluid, lanes: SCENES.fluid.lanes.map((l) => (l.id === 'evap' ? { ...l, value: 9 } : l)).filter((l) => l.id !== 'home'), steps: [] })
    const next = rebind(was, { ...fresh.spec, parts: undefined })
    expect(next.archetype).toBe('fluid')
    expect(next.steps.map((s) => s.say)).toEqual(was.steps.map((s) => s.say))
    expect(next.steps[2].focus).toEqual(['cond'])
    expect(next.lanes.find((l) => l.id === 'evap').value).toBe(9)
    expect(next.links.every((k) => k.kind === 'flow' && k.rate > 0)).toBe(true)
  })
})

const YESTERDAY = { ...DAY, date: '2026-03-08', projects: [{ name: 'puzzlebox-studio', minutes: 60 }, { name: 'tidewater', minutes: 120 }], noProjectMin: 30, meetings: [], breaks: [], coverage: { ...DAY.coverage, trackedMin: 210 } }
const walked = (skeleton, screen) => checkSpec({ ...skeleton, steps: fallbackSteps(skeleton, screen) })

describe('the record as scenes', () => {
  it('every scene binder is checkSpec-clean with the walk from its own numbers, and the same rows bind the same scene', () => {
    const all = [bindWhereScene(DAY), bindWeekScene([YESTERDAY, DAY]), bindThreadsScene(OPEN), bindPeopleScene(PEOPLE)]
    for (const s of all) {
      const out = walked(s)
      expect(out.problems, s.view).toEqual([])
      expect(out.spec.source.args.as).toBe('scene')
      expect(out.spec.steps.length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(layoutScene(out.spec))).toBe(JSON.stringify(layoutScene(walked(s).spec)))
    }
  })

  it('where: the day pours its minutes into a tank per place, each pipe as wide as its minutes, the doors kept', () => {
    const s = bindWhereScene(DAY)
    expect(s.archetype).toBe('fluid')
    expect(s.lanes[0]).toMatchObject({ id: 'd:2026-03-09', kind: 'source', value: 422, door: 'day:2026-03-09' })
    expect(s.lanes.slice(1).map((l) => [l.id, l.kind, l.value])).toEqual([['p:puzzlebox-studio', 'tank', 140], ['elsewhere', 'reservoir', 117], ['meetings', 'tank', 75], ['p:tidewater', 'tank', 55], ['away', 'sink', 35]])
    expect(s.links.find((k) => k.to === 'p:puzzlebox-studio')).toEqual({ from: 'd:2026-03-09', to: 'p:puzzlebox-studio', kind: 'flow', rate: 140 })
    expect(s.lanes[1].door).toBe('entity:puzzlebox-studio')
    const steps = fallbackSteps(s)
    expect(steps[0]).toEqual({ focus: ['d:2026-03-09'], say: 'Mon 9 Mar poured 7 h 2 min into 5 places.' })
    expect(steps[1].say).toBe('puzzlebox-studio filled the most, 2 h 20 min, 33 percent.')
  })

  it('week: each day a source, the projects tanks, the widest flow named; time away is not poured', () => {
    const s = bindWeekScene([YESTERDAY, DAY])
    expect(s.lanes.filter((l) => l.kind === 'source').map((l) => l.id)).toEqual(['d:2026-03-08', 'd:2026-03-09'])
    expect(s.lanes.some((l) => l.id === 'away')).toBe(false)
    expect(s.lanes.find((l) => l.id === 'p:tidewater').value).toBe(175)
    expect(fallbackSteps(s).map((x) => x.say)).toContain('The widest flow ran from Mon 9 Mar into puzzlebox-studio, 2 h 20 min.')
  })

  it('threads: you at the center, projects round you as heavy as their threads, threads their moons, a promise a tie', () => {
    const s = bindThreadsScene(OPEN)
    const kind = Object.fromEntries(s.lanes.map((l) => [l.id, l.kind]))
    expect(kind).toMatchObject({ you: 'center', 'p:puzzlebox-studio': 'body', 'c:box-484': 'moon', 'c:tax-return': 'body', 'w:mira-bakker': 'body' })
    expect(s.lanes[1]).toMatchObject({ id: 'p:puzzlebox-studio', value: 7 })
    expect(s.links).toContainEqual({ from: 'c:box-484', to: 'p:puzzlebox-studio', kind: 'orbit' })
    expect(s.links).toContainEqual({ from: 'c:box-484', to: 'w:mira-bakker', kind: 'tie' })
    const says = fallbackSteps(s).map((x) => x.say)
    expect(says[0]).toBe('puzzlebox-studio weighs the most around You, 7 days.')
    expect(says).toContain('box-484 is tied to Mira Bakker.')
    expect(fallbackSteps(s).find((x) => x.explode)?.focus).toEqual(['p:puzzlebox-studio'])
  })

  it('people: named people only, as heavy as the meetings you shared', () => {
    const s = bindPeopleScene(PEOPLE)
    expect(s.lanes.map((l) => [l.label, l.value ?? null])).toEqual([['You', null], ['Mira Bakker', 4], ['Pat Doe', 1], ['Ida Sol', 0]])
    expect(s.title).toBe('Who you work with')
  })

  it('a view re-reads the shape it was drawn in: as scene from its recipe, rows otherwise', async () => {
    const read = vi.fn(async (tool) => ({ gnomon_today_summary: DAY, gnomon_open_commitments: OPEN, gnomon_people: PEOPLE })[tool])
    expect((await readView('where', { as: 'scene' }, read)).form).toBe('scene')
    expect((await readView('where', {}, read)).form).toBe('bars')
    expect((await readView('threads', { as: 'scene' }, read)).archetype).toBe('orbital')
    // Views with no scene binder stay rows whatever the args say.
    expect(Object.keys(VIEWS).filter((v) => VIEWS[v].scene)).toEqual(['where', 'week', 'threads', 'people'])
  })

  it('a step lights by a label’s own words: "Hour wheel" is not the belt wheel, "Mar" no day of the week', () => {
    const clock = checkSpec(SCENES.mechanism).spec
    expect([...focusOf(clock, { focus: [], say: 'The hour wheel turns slowly.' })]).toEqual(['big'])
    const week = bindWeekScene([YESTERDAY, DAY])
    expect([...focusOf(week, { focus: [], say: 'On 9 Mar the record ran long.' })]).toEqual([])
  })

  it('explode pulls the parts along their solver axes, the same way every time', () => {
    for (const name of Object.keys(SCENES)) {
      const L = layoutScene(checkSpec(SCENES[name]).spec)
      const a = explodeOf(L)
      expect([...a.values()].some((v) => v.some((x) => x !== 0)), name).toBe(true)
      expect(JSON.stringify([...a])).toBe(JSON.stringify([...explodeOf(L)]))
    }
    const fluid = explodeOf(layoutScene(checkSpec(SCENES.fluid).spec))
    expect([...fluid.values()].every((v) => v[2] === 0)).toBe(true)
  })
})

describe('the manager, placing first and narrating later', () => {
  const walk = JSON.stringify({ title: 'Where it went', steps: [{ focus: ['p:puzzlebox-studio'], say: 'puzzlebox-studio took the most of your day.' }, { focus: ['meetings'], say: 'Meetings took an hour and a quarter.' }] })
  const read = () => vi.fn(async (tool) => ({ gnomon_today_summary: DAY, gnomon_open_commitments: OPEN, gnomon_people: PEOPLE })[tool])

  it('hands out the figure walked by the numbers before the model answers, then the model’s walk as later', async () => {
    let answer
    const complete = vi.fn(() => new Promise((r) => (answer = r)))
    const m = createManager({ read: read(), complete })
    const out = await m.draw({ ask: 'where did my time go', view: 'where' })
    expect(out.spec.by).toMatchObject({ storyboard: 'fallback', pending: true })
    expect(out.spec.by.ms.place).toBeGreaterThanOrEqual(0)
    expect(complete).toHaveBeenCalledTimes(1)
    answer(walk)
    const final = await out.later
    expect(final.spec.by.storyboard).toBe('model')
    expect(final.spec.by.pending).toBeUndefined()
    expect(final.spec.by.ms).toMatchObject({ route: expect.any(Number), read: expect.any(Number), storyboard: expect.any(Number) })
  })

  it('reuses a walk kept for the same figure within the hour, with no model call', async () => {
    const complete = vi.fn()
    const judge = vi.fn()
    const reuse = vi.fn((source) => (source.view === 'where' ? { at: '2026-03-09T09:00:00Z', title: 'Where it went', fits: 2.6, steps: JSON.parse(walk).steps } : null))
    const out = await build({ ask: 'where did the day go', view: 'where', args: {} }, { read: read(), complete, judge, reuse })
    expect(reuse).toHaveBeenCalledWith({ view: 'where', args: { date: '2026-03-09' } })
    expect(out.spec.by).toMatchObject({ storyboard: 'library', reused: '2026-03-09T09:00:00Z', critic: { fits: 2.6 } })
    expect(out.spec.headline).toBe('Where it went')
    expect(complete).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
    // A kept walk that no longer points at the rows is not reused.
    const stale = await build({ view: 'where' }, { read: read(), reuse: () => ({ at: 'x', steps: [{ focus: ['p:gone'], say: 'gone took it all.' }] }) })
    expect(stale.spec.by.storyboard).toBe('fallback')
  })

  it('keys a flight by view, form and args; both builds rows, then the scene from one shared read', async () => {
    const r = read()
    const m = createManager({ read: r })
    const out = await m.draw({ ask: 'where did my time go', view: 'where', form: 'both' })
    expect(out.spec.form).toBe('bars')
    const scene = await out.scene
    expect(scene.spec).toMatchObject({ form: 'scene', archetype: 'fluid' })
    expect(r).toHaveBeenCalledTimes(1)
    expect([...m.flights.keys()]).toEqual(['where|rows|{}', 'where|scene|{}'])
    // A view with no scene is rows whatever was asked.
    expect((await m.draw({ view: 'goals', form: 'scene' })).ok).toBe(false)
    expect([...m.flights.keys()]).not.toContain('goals|scene|{}')
  })

  it('routes an ask once: the tool naming the view the gate routed joins the gate’s scene, not a new rows figure', async () => {
    const judge = vi.fn(async ({ questions }) => (questions.view ? { view: { choice: 'where', probabilities: { where: 0.9, words: 0.01 } }, shape: { choice: 'scene' } } : null))
    const m = createManager({ read: read(), judge })
    await m.routeOnly('where did my time go')
    const gate = await m.draw({ ask: 'where did my time go', view: 'where', form: 'scene' })
    const tool = await m.draw({ ask: 'where did my time go', view: 'where' })
    expect(tool.spec).toBe(gate.spec)
    expect(judge.mock.calls.filter((c) => c[0].questions.view)).toHaveLength(1)
  })

  it('takes the shape from the route for a view with a scene; a day stays a day unless the tool asks for its scene', async () => {
    const judged = (view) => vi.fn(async () => ({ view: { choice: view, probabilities: { [view]: 0.7, words: 0.02 } }, shape: { choice: 'scene' } }))
    expect(await route('who am I tangled up with', judged('threads'))).toMatchObject({ view: 'threads', form: 'scene' })
    expect((await createManager({ read: async () => DAY, judge: judged('day') }).draw({ ask: 'how did today go' })).spec.form).toBe('timeline')
    expect((await createManager({ read: async () => DAY }).draw({ ask: 'today as a scene', view: 'day', form: 'scene' })).spec).toMatchObject({ view: 'where', form: 'scene' })
    expect((await createManager({ read: async () => ({ goals: [{ goal: 'Ship it', state: 'open' }] }), judge: judged('goals') }).draw({ ask: 'my goals as a picture' })).spec.form).toBe('table')
    expect(routeQuestions(VIEWS).shape.instructions).toMatch(/where, week, threads, people/)
  })

})

describe('the screen as context', () => {
  const screen = { project: 'tidewater', app: 'Code', ticket: 'TIDE-12', error: 'TypeError: x is undefined' }

  it('goes into the route state and the digest, from the fold’s typed facts only', async () => {
    const judge = vi.fn(async () => null)
    await route('explain this', judge, screen)
    expect(judge.mock.calls[0][0].state.screen).toBe('On screen as they asked: project tidewater; app Code; ticket TIDE-12; error TypeError: x is undefined')
    expect(digest(bindWhereScene(DAY), 'where did my time go', screen)).toMatch(/On screen as they asked: project tidewater/)
    expect(digest(bindWhereScene(DAY), 'x')).not.toMatch(/On screen/)
  })

  it('scopes the walk from the numbers to the project on screen', () => {
    const steps = walked(bindWhereScene(DAY), screen).spec.steps
    expect(steps[1]).toEqual({ focus: ['p:tidewater'], say: 'tidewater, on your screen now, holds 55 min.' })
  })

  it('reaches the storyboard and the critic through the manager', async () => {
    const complete = vi.fn(async () => null)
    const m = createManager({ read: async () => DAY, complete, screen: () => screen })
    await (await m.draw({ ask: 'where did my time go', view: 'where' })).later
    expect(complete.mock.calls[0][0][1].content).toMatch(/ticket TIDE-12/)
  })
})

describe('a scene card and the hand on its camera', () => {
  const spec = () => walked(bindWhereScene(DAY)).spec
  const say = (node) => node.querySelector('.nodus-say').textContent

  it('says Reading while Gnomon’s walk is on its way, and fades it in over the walk from the numbers', async () => {
    vi.useFakeTimers()
    const first = { ...spec(), by: { storyboard: 'fallback', pending: true, ms: { place: 420 } } }
    const node = nodusNode(first)
    expect(node.querySelector('.nodus-state').textContent).toBe('Reading')
    expect(node.querySelector('.nodus-foot').textContent).toMatch(/where as fluid · 6 parts · walk by the numbers · placed in 0.4 s/)
    const model = { ...first, headline: 'A day poured out', steps: [{ focus: ['p:tidewater'], say: 'tidewater had the afternoon.' }, { focus: ['meetings'], say: 'Meetings took an hour.' }], by: { storyboard: 'model', critic: { fits: 2.5 }, ms: { total: 3100 } } }
    node.dispatchEvent(new CustomEvent('sync', { detail: JSON.stringify(model) }))
    expect(node.querySelector('.nodus-walk').classList.contains('nodus-swap')).toBe(true)
    vi.advanceTimersByTime(320)
    expect(node.querySelector('.nodus-walk').classList.contains('nodus-swap')).toBe(false)
    expect(say(node)).toBe('tidewater had the afternoon.')
    expect(node.querySelector('.nodus-state').textContent).toBe('Checked 2.5 of 3')
    expect(node.querySelector('.nodus-headline').textContent).toBe('A day poured out')
    expect(node.dataset.text).toContain('A day poured out')
    vi.useRealTimers()
  })

  it('pauses the walk while the hand holds the camera, resumes it on Next; a double click is the whole figure', async () => {
    vi.useFakeTimers()
    const node = nodusNode(spec())
    document.body.append(node)
    expect(node.dataset.step).toBe('0')
    node.querySelector('.nodus-plate').dispatchEvent(new CustomEvent('nodus:hold', { bubbles: true }))
    vi.advanceTimersByTime(20_000)
    expect(node.dataset.step).toBe('0')
    node.querySelector('.nodus-next').click()
    expect(node.dataset.step).toBe('1')
    vi.advanceTimersByTime(20_000)
    expect(Number(node.dataset.step)).toBeGreaterThan(1)
    node.querySelector('.nodus-plate').dispatchEvent(new CustomEvent('nodus:home', { bubbles: true }))
    expect(node.dataset.step).toBe('-1')
    node.remove()
    vi.useRealTimers()
  })
})
