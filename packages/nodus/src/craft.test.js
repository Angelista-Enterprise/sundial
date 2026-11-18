// @vitest-environment jsdom
// The craft pass: labels named from the margin, sets pulled apart along one
// axis, the engraver's parts, panels under the figure, the week laid across
// the plate, and the free path (a blueprint of something in the world).
import { describe, expect, it, vi } from 'vitest'
import * as T from '../vendor/three.module.js'
import { bindHome, bindPeopleScene, bindSchedule, bindThreadsScene, bindWeekScene, bindWhereScene } from './bind.js'
import { panelsNode } from './card.js'
import { focusOf } from './focus.js'
import { createKit, silhouette } from './kit.js'
import { crosses, marginLabels } from './labels.js'
import { explodeOf, layoutScene } from './layout-scene.js'
import { build, buildFree, createManager, DAY_SCENE, route } from './orchestrate.js'
import { mulberry32 } from './rng.js'
import { drawSceneSvg } from './render-scene-svg.js'
import { ARCHETYPES, checkSpec } from './spec.js'
import { BLUEPRINTS, blueprintMessages, blueprintSpec, fallbackSteps, parseBlueprint } from './storyboard.js'
import { VIEWS } from './views.js'
import { DAY, HOME, OPEN, PEOPLE, PLATES, SCENES, TIMELINE } from './fixture.test-data.js'

const YESTERDAY = { ...DAY, date: '2026-03-08', projects: [{ name: 'puzzlebox-studio', minutes: 60 }, { name: 'tidewater', minutes: 120 }], noProjectMin: 30, meetings: [], breaks: [], coverage: { ...DAY.coverage, trackedMin: 210 } }
const scene = (input) => checkSpec(input).spec
const boxOf = (it, at) => ({ x0: at.x, y0: at.y, x1: at.x + it.w, y1: at.y + it.h })
const touch = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** A crowd of parts at random spots in the figure's rect, labels of random length. */
function crowd(seed, n) {
  const rnd = mulberry32(seed)
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: 200 + rnd() * 700, y: 30 + rnd() * 520, w: 40 + rnd() * 110, h: 15 }))
}

describe('labels named from the margin', () => {
  const plate = { inner: { x0: 180, y0: 20, x1: 920, y1: 560 }, w: 1100, h: 580 }

  it('packs every column with zero overlap and keeps every label off the figure, beside it or above and below', () => {
    for (let seed = 1; seed <= 40; seed++) {
      for (const wide of [false, true]) {
        const items = crowd(seed, 4 + (seed % 20))
        const out = marginLabels(items, plate, { wide })
        const boxes = out.map((at, i) => boxOf(items[i], at))
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i], boxes[j]), `seed ${seed} wide ${wide}: ${i} ${j}`).toBe(false)
        const figure = { x0: plate.inner.x0, y0: plate.inner.y0, x1: plate.inner.x1, y1: plate.inner.y1 }
        for (const [i, at] of out.entries()) {
          if (at.side === 'inline') continue
          expect(touch(boxes[i], figure), `seed ${seed}: ${at.id} on the figure`).toBe(false)
          expect(wide ? ['top', 'bottom'] : ['left', 'right']).toContain(at.side)
          // The leader ends on its part's anchor.
          expect(at.leader[1]).toEqual([items[i].x, items[i].y])
        }
      }
    }
  })

  it('untangles leaders: neighbours in a column whose leaders cross trade places', () => {
    let crossings = 0
    for (let seed = 1; seed <= 40; seed++) {
      const out = marginLabels(crowd(seed, 10), plate)
      for (const side of ['left', 'right']) {
        const col = out.filter((a) => a.side === side)
        for (let i = 0; i < col.length; i++) for (let j = i + 1; j < col.length; j++) crossings += crosses(col[i].leader, col[j].leader) ? 1 : 0
      }
    }
    expect(crossings).toBe(0)
  })

  it('keeps a label beside its part only when the part is alone in its region and the label touches no part', () => {
    const lone = marginLabels([{ id: 'a', x: 550, y: 300, w: 60, h: 15 }], plate, { discs: [{ x: 550, y: 300, r: 20 }] })
    expect(lone[0].side).toBe('inline')
    expect(lone[0].y + 15).toBeLessThan(300 - 20)
    const pair = marginLabels([{ id: 'a', x: 550, y: 300, w: 60, h: 15 }, { id: 'b', x: 600, y: 330, w: 60, h: 15 }], plate)
    expect(pair.map((a) => a.side)).not.toContain('inline')
  })

  it('draws the flat fallback with its labels in the margins, a leader and an anchor each', () => {
    for (const name of Object.keys(SCENES)) {
      const { node, layout } = drawSceneSvg(scene(SCENES[name]))
      expect(node.querySelectorAll('.nd-leader')).toHaveLength(layout.nodes.length)
      expect(node.querySelectorAll('.nd-anchor')).toHaveLength(layout.nodes.length)
      expect([...node.querySelectorAll('.nd-label-scene')].every((t) => ['left', 'right', 'top', 'bottom', 'inline'].includes(t.getAttribute('data-side')))).toBe(true)
    }
    // A day laid top to bottom names its rows above and below.
    const { node } = drawSceneSvg(bindWeekScene([YESTERDAY, DAY]))
    expect(new Set([...node.querySelectorAll('.nd-label-scene')].map((t) => t.getAttribute('data-side')))).toEqual(new Set(['top', 'bottom']))
  })
})

describe('the set pulled apart, and the engraver\'s camera', () => {
  const building = scene(BLUEPRINTS['show me a lighthouse, exploded'] && blueprintSpec(BLUEPRINTS['show me a lighthouse, exploded']))

  it('lifts a building floor by floor along y, the lowest level staying put, the same way every time', () => {
    const L = layoutScene(building)
    expect(L.view).toBe('iso')
    const off = explodeOf(L)
    expect(JSON.stringify([...off])).toBe(JSON.stringify([...explodeOf(layoutScene(building))]))
    const floors = L.nodes.filter((n) => n.kind === 'stack')
    const lifts = floors.map((n) => off.get(n.id))
    expect(lifts.every((d) => d[0] === 0 && d[2] === 0)).toBe(true)
    for (let i = 1; i < lifts.length; i++) expect(lifts[i][1]).toBeGreaterThan(lifts[i - 1][1])
    expect(Math.min(...[...off.values()].map((d) => d[1]))).toBe(0)
  })

  it('pulls a fluid along its flow, a gear train along its shafts', () => {
    const fluid = layoutScene(scene(SCENES.fluid))
    const f = explodeOf(fluid)
    expect(fluid.axis).toBe('x')
    expect([...f.values()].every((d) => d[1] === 0 && d[2] === 0)).toBe(true)
    const gears = explodeOf(layoutScene(scene(SCENES.mechanism)))
    expect([...gears.values()].every((d) => d[0] === 0 && d[1] === 0)).toBe(true)
    expect(new Set([...gears.values()].map((d) => d[2])).size).toBe(gears.size)
  })

  it('looks at a machine and a building from the isometric corner, at a day of pipes face on', () => {
    expect(layoutScene(scene(SCENES.mechanism)).view).toBe('iso')
    expect(layoutScene(scene(SCENES.fluid)).view).toBe('iso')
    expect(layoutScene(scene(SCENES.orbital)).view).toBe('orbital')
    expect(layoutScene(bindWhereScene(DAY)).view).toBe('fluid')
  })

  it('keeps exploded on a scene spec only, and a step\'s explode on a scene step only', () => {
    expect(scene({ ...SCENES.system, exploded: true }).exploded).toBe(true)
    expect(scene({ ...SCENES.system, exploded: 'yes' }).exploded).toBeUndefined()
  })
})

describe('the week, laid across the plate', () => {
  it('reads top to bottom, days in a row over places in a row, every place standing on one line, sized by its minutes', () => {
    const L = layoutScene(bindWeekScene([YESTERDAY, DAY]))
    expect(L.axis).toBe('y')
    const days = L.nodes.filter((n) => n.kind === 'source')
    const tanks = L.nodes.filter((n) => n.kind !== 'source')
    expect(Math.min(...days.map((n) => n.y))).toBeGreaterThan(Math.max(...tanks.map((n) => n.y)))
    const feet = new Set(tanks.map((n) => Math.round((n.y - n.r) * 1000)))
    expect(feet.size).toBe(1)
    const lanes = new Map(bindWeekScene([YESTERDAY, DAY]).lanes.map((l) => [l.id, l]))
    const tankR = tanks.filter((n) => n.kind === 'tank').sort((a, b) => lanes.get(b.id).value - lanes.get(a.id).value).map((n) => n.r)
    expect(tankR).toEqual([...tankR].sort((a, b) => b - a))
    // Every pipe: down, along its own track, down again: two elbows, axis-aligned runs.
    for (const e of L.edges) {
      expect(e.points).toHaveLength(4)
      for (let i = 0; i + 1 < e.points.length; i++) expect(e.points[i][0] === e.points[i + 1][0] || e.points[i][1] === e.points[i + 1][1]).toBe(true)
    }
    const tracks = new Map()
    for (const e of L.edges) tracks.set(e.from, [...(tracks.get(e.from) ?? []), e.points[1][1]])
    expect(new Set([...tracks.values()].map((ys) => ys[0])).size).toBe(tracks.size)
  })

  it('spreads the where scene as wide as its places, the day centred over them', () => {
    const L = layoutScene(bindWhereScene(DAY))
    const day = L.nodes.find((n) => n.kind === 'source')
    expect(L.axis).toBe('y')
    expect(day.x).toBe(0)
    expect(L.nodes.filter((n) => n !== day).every((n) => n.y < day.y)).toBe(true)
  })
})

describe('the engraver\'s parts', () => {
  const pal = Object.fromEntries(['ink', 'muted', 'faint', 'ochre', 'navy', 'page'].map((k) => [k, new T.Color('#333333')]))
  const positions = (kind, shape, seed) => {
    const made = createKit(T, pal, mulberry32(seed)).parts[kind]({ id: 'x', kind, shape, r: 1.2, x: 0, y: 0, z: 0 })
    const out = []
    made.node.traverse((o) => o.geometry?.attributes?.position && out.push(...o.geometry.attributes.position.array))
    return out
  }

  it('draws a field as a seeded cloud inside its silhouette: the same points for the same seed, others for another', () => {
    for (const shape of ['tree', 'cloud', 'crowd', 'forest']) {
      const a = positions('field', shape, 7)
      expect(a.length, shape).toBeGreaterThan(3000)
      expect(positions('field', shape, 7)).toEqual(a)
      expect(positions('field', shape, 8)).not.toEqual(a)
      const inside = silhouette(shape, 1.2)
      for (let i = 0; i < 300; i += 3) expect(inside(a[i], a[i + 1], a[i + 2])).toBe(true)
    }
  })

  it('draws a contour as stacked level lines, each higher one inside the one under it, the same every time', () => {
    for (const shape of ['hill', 'island']) {
      const a = positions('contour', shape, 3)
      expect(positions('contour', shape, 3)).toEqual(a)
    }
    const made = createKit(T, pal, mulberry32(3)).parts.contour({ kind: 'contour', shape: 'hill', r: 2, x: 0, y: 0, z: 0 })
    const rings = made.node.children.filter((o) => o.type === 'Line').map((o) => o.geometry.attributes.position.array)
    expect(rings.length).toBe(11)
    const reach = (arr) => Math.max(...Array.from({ length: arr.length / 3 }, (_, i) => Math.hypot(arr[i * 3], arr[i * 3 + 2])))
    for (let i = 1; i < rings.length; i++) expect(reach(rings[i])).toBeLessThan(reach(rings[i - 1]) + 1e-6)
  })

  it('stands a building\'s floors in one column, bottom first, with one footprint', () => {
    const L = layoutScene(building())
    const floors = L.nodes.filter((n) => n.kind === 'stack')
    expect(new Set(floors.map((n) => n.x)).size).toBe(1)
    expect(new Set(floors.map((n) => n.r)).size).toBe(1)
    for (let i = 1; i < floors.length; i++) expect(floors[i].y).toBeGreaterThan(floors[i - 1].y)
  })
  const building = () => scene(blueprintSpec(BLUEPRINTS['show me a lighthouse, exploded']))
})

describe('panels docked under the figure', () => {
  it('keeps at most four, each with what it needs to be drawn', () => {
    const { spec } = checkSpec({ ...SCENES.system, panels: [{ label: 'A', kind: 'spark', series: [1] }, { label: 'B', kind: 'number', value: 3, unit: 'h' }, { label: 'C', kind: 'status', word: 'Calm' }, { label: 'D', kind: 'spark', series: [1, 2, 3] }, { label: 'E', kind: 'number', value: 'x' }, { label: 'F', kind: 'number', value: 1 }, { label: 'G', kind: 'number', value: 2 }] })
    expect(spec.panels.map((p) => p.label)).toEqual(['B', 'C', 'D', 'F'])
  })

  it('is filled by the scene binders from the numbers: the week by the day, people by meetings, threads by promises', () => {
    const week = bindWeekScene([YESTERDAY, DAY])
    expect(week.panels.find((p) => p.kind === 'spark').series).toEqual([210, 312])
    expect(bindPeopleScene(PEOPLE).panels.map((p) => p.label)).toContain('Meetings shared')
    expect(bindThreadsScene(OPEN).panels.find((p) => p.label === 'Open promises').value).toBe(1)
    expect(bindWhereScene(DAY).panels.find((p) => p.label === 'Most went to').word).toBe('puzzlebox-studio')
  })

  it('draws a sparkline, a number with its unit and a word, from tokens only', () => {
    const node = panelsNode(scene(bindWeekScene([YESTERDAY, DAY])))
    expect(node.querySelectorAll('.nd-panel')).toHaveLength(4)
    expect(node.querySelector('.nd-spark polyline').getAttribute('points').split(' ')).toHaveLength(2)
    expect(node.querySelector('.nd-panel-unit').textContent).toBe('h')
    expect(node.outerHTML).not.toMatch(/fill="#|stroke="#|style=/)
    expect(panelsNode(scene(SCENES.system))).toBeNull()
  })
})

describe('the free path: a blueprint of something in the world', () => {
  it('holds every worked blueprint the prompt shows to the checker', () => {
    for (const [ask, bp] of Object.entries(BLUEPRINTS)) expect(checkSpec(blueprintSpec(bp, ask)).problems, ask).toEqual([])
    const text = blueprintMessages('how does a lock work')[0].content
    for (const name of ['system', 'fluid', 'mechanism', 'orbital', 'stack', 'contour', 'field']) expect(text).toContain(name)
    expect(text).toMatch(/Never a position, a coordinate, a size in units, a colour, a camera/)
  })

  it('parses a blueprint and drops what a model may not say: a coordinate, a colour, a camera', () => {
    const bp = parseBlueprint(`Here: {"archetype": "fluid", "title": "Water", "camera": {"az": 1}, "nodes": [{"id": "a", "label": "Well", "kind": "source", "x": 3, "color": "#f00"}, {"id": "b", "label": "Tank", "kind": "tank", "value": 2}], "edges": [{"from": "a", "to": "b", "kind": "flow", "points": [[0,0]]}], "steps": [{"focus": ["a"], "say": "The well fills the tank.", "zoom": 2}]}`)
    expect(bp.nodes[0]).toEqual({ id: 'a', label: 'Well', kind: 'source' })
    expect(bp.edges[0]).toEqual({ from: 'a', to: 'b', kind: 'flow' })
    expect(bp.steps[0]).toEqual({ focus: ['a'], say: 'The well fills the tank.' })
    expect(bp).not.toHaveProperty('camera')
    expect(parseBlueprint('{"steps": []}')).toBeNull()
    expect(parseBlueprint('no json')).toBeNull()
  })

  it('repairs once from the checker\'s words, places the set walked by the numbers, then hands out the model\'s walk the critic passed', async () => {
    const bad = JSON.stringify({ archetype: 'mechanism', title: 'A winch', nodes: [{ id: 'drum', label: 'Drum', kind: 'barrel' }, { id: 'crank', label: 'Handle', kind: 'crank', door: 'entity:winch' }], edges: [{ from: 'crank', to: 'drum', kind: 'push' }], steps: [{ focus: ['crank'], say: 'The handle turns the drum.' }] })
    const good = JSON.stringify({ archetype: 'mechanism', title: 'A winch', nodes: [{ id: 'drum', label: 'Drum', kind: 'gear', value: 40 }, { id: 'pin', label: 'Pinion', kind: 'gear', value: 10, state: 'driving' }, { id: 'crank', label: 'Handle', kind: 'crank', door: 'search:winch' }], edges: [{ from: 'crank', to: 'pin', kind: 'push' }, { from: 'pin', to: 'drum', kind: 'mesh' }], steps: [{ focus: ['crank', 'pin'], say: 'The handle turns the pinion fast.' }, { focus: ['drum'], say: 'The drum turns slowly, with four times the force.' }] })
    const complete = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good)
    const judge = vi.fn(async () => ({ fits: { score: 2.4 }, s0: { noul: 0.9 }, s1: { noul: 0.8 } }))
    let placed = null
    const out = await buildFree({ ask: 'how does a winch work', archetype: 'mechanism' }, { complete, judge, early: (q) => (placed = q) })
    expect(complete).toHaveBeenCalledTimes(2)
    const repair = complete.mock.calls[1][0].at(-1).content
    expect(repair).toMatch(/kind "barrel" is not a mechanism kind/)
    expect(repair).toMatch(/may only carry a search: door/)
    expect(placed.spec.by.pending).toBe(true)
    expect(placed.spec.view).toBe('free')
    expect(placed.spec.source).toBeNull()
    expect(out.ok).toBe(true)
    expect(out.spec.by.storyboard).toBe('model')
    expect(out.spec.by.critic.fits).toBe(2.4)
    expect(out.spec.steps.map((s) => s.say)).toEqual(['The handle turns the pinion fast.', 'The drum turns slowly, with four times the force.'])
    expect(out.spec.lanes.find((l) => l.id === 'crank').door).toBe('search:winch')
    expect(out.spec.by.ms.blueprint).toBeTypeOf('number')
  })

  it('says why when no model answers, and never reads the record', async () => {
    expect((await buildFree({ ask: 'a rainbow' }, {})).ok).toBe(false)
    const read = vi.fn()
    const m = createManager({ read, complete: async () => JSON.stringify(BLUEPRINTS['what happens inside a raindrop']) })
    const out = await m.draw({ ask: 'inside a raindrop', view: 'free' })
    expect(out.ok).toBe(true)
    expect(out.spec.archetype).toBe('system')
    expect(read).not.toHaveBeenCalled()
  })

  it('routes something in the world to a free scene of the archetype Jev picked, and joins the build already in flight', async () => {
    const judge = vi.fn(async ({ questions }) => ({ view: { choice: 'scene_fluid', confidence: 0.8, probabilities: { scene_fluid: 0.8, words: 0.02 } } }))
    expect(await route('how does a heat pump work', judge)).toMatchObject({ view: 'free', archetype: 'fluid', form: 'scene' })
    expect(Object.keys(judge.mock.calls[0][0].questions.view.criteria)).toEqual(expect.arrayContaining(['scene_system', 'scene_orbital', 'scene_fluid', 'scene_mechanism']))
    const complete = vi.fn(async () => JSON.stringify(BLUEPRINTS['how does a heat pump work']))
    const m = createManager({ read: vi.fn(), complete, judge })
    const [a, b] = await Promise.all([m.draw({ ask: 'how does a heat pump work' }), m.draw({ ask: 'How does a heat pump work ', view: 'free' })])
    expect(a.spec.archetype).toBe('fluid')
    expect(b.spec.archetype).toBe('fluid')
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('turns a day into a scene (where its time went) only when Jev is sure of the shape', async () => {
    const judge = (scene) => async () => ({ view: { choice: 'day', confidence: 0.8 }, shape: { choice: 'scene', probabilities: { scene, rows: 1 - scene, both: 0 } } })
    expect((await route('how did my day go', judge(0.77))).form).toBeUndefined()
    expect((await route('show me today as a scene', judge(0.97))).form).toBe('scene')
    expect(DAY_SCENE).toBeGreaterThan(0.77)
    const m = createManager({ read: async (tool) => ({ gnomon_today_summary: DAY })[tool], judge: judge(0.97) })
    const out = await m.draw({ ask: 'show me today as a scene' })
    expect(out.spec.view).toBe('where')
    expect(out.spec.form).toBe('scene')
  })

  it('lights a scene\'s part by its whole word: rain is the rain shower, not the raindrop or the rainbow', () => {
    const s = scene({ v: 1, form: 'scene', archetype: 'system', title: 'Rain', lanes: [{ id: 'r', label: 'Rain shower', kind: 'rain' }, { id: 'd', label: 'Raindrop', kind: 'droplet' }, { id: 'b', label: 'Rainbow', kind: 'rainbow' }], links: [], steps: [{ focus: ['r'], say: 'The rain falls.' }] })
    expect([...focusOf(s, { focus: [], say: 'Sunlight needs rain in front of you.' })]).toEqual(['r'])
    expect([...focusOf(s, { focus: [], say: 'Each raindrop bends the light.' })]).toEqual(['d'])
  })
})

describe('three more idioms: a dial, a route, a floor plan', () => {
  const same = (name) => expect(JSON.stringify(layoutScene(scene(SCENES[name])))).toBe(JSON.stringify(layoutScene(scene(SCENES[name]))))

  it('puts a day round a dial: midnight at the top, clockwise, overlapping events on rings further out', () => {
    same('clock')
    const L = layoutScene(scene(SCENES.clock))
    const at = new Map(L.nodes.map((n) => [n.id, n]))
    expect(L.view).toBe('clock')
    // Noon is at the bottom of a day dial, so lunch sits below the middle.
    expect(at.get('lunch').y).toBeLessThan(0)
    expect(Math.abs(at.get('lunch').x)).toBeLessThan(0.5)
    expect(at.get('pair').arc.r0).toBeGreaterThan(at.get('review').arc.r0)
    expect(at.get('deep').arc.r0).toBe(at.get('lunch').arc.r0)
    // Sleep runs past midnight: its arc is the long way round, not backwards.
    expect(at.get('sleep').arc.a0 - at.get('sleep').arc.a1).toBeCloseTo((8 / 24) * Math.PI * 2, 2)
  })

  it('checks a clock: one dial, every part an hour on it, an event an end after its start', () => {
    const { spec, problems } = checkSpec({ ...SCENES.clock, lanes: [...SCENES.clock.lanes, { id: 'x', label: 'Odd', kind: 'event', start: 30 }, { id: 'face2', label: 'Second dial', kind: 'dial' }] })
    expect(problems.join(' ')).toMatch(/start is the hour it begins, 0 to 24/)
    expect(problems.join(' ')).toMatch(/a clock has one dial/)
    expect(spec.lanes.find((l) => l.id === 'x')).toMatchObject({ start: 0, end: 1 })
  })

  it('lays a route from above in the order its legs chain, each leg named at its middle, the same every time', () => {
    same('route')
    const L = layoutScene(scene(SCENES.route))
    expect(L.view).toBe('route')
    expect(L.nodes.filter((n) => n.kind !== 'leg').map((n) => n.id)).toEqual(['home', 'corner', 'station', 'change', 'office'])
    expect(L.edges).toHaveLength(4)
    expect(L.nodes.filter((n) => n.kind === 'leg').map((n) => n.label)).toEqual(['4 min walk', '8 min walk', '14 min train', '9 min train'])
    expect(L.nodes.every((n) => n.y === 0)).toBe(true)
    // With lat and lon on every stop, a map: north is up the plan (smaller z).
    const map = layoutScene(scene({ ...SCENES.route, lanes: SCENES.route.lanes.map((l, i) => ({ ...l, lat: 10 + i * 0.01, lon: 20 })) }))
    const stops = map.nodes.filter((n) => n.kind !== 'leg')
    for (let i = 1; i < stops.length; i++) expect(stops[i].z).toBeLessThan(stops[i - 1].z)
    expect(checkSpec({ ...SCENES.route, lanes: [{ id: 'a', label: 'A', kind: 'start', lat: 1 }] }).problems.join(' ')).toMatch(/lat and lon together/)
  })

  it('packs a plan\'s rooms into one rectangle by area, no gaps, each device inside its room', () => {
    same('plan')
    const L = layoutScene(scene(SCENES.plan))
    expect(L.view).toBe('iso')
    const rooms = L.nodes.filter((n) => n.kind === 'room')
    const area = rooms.reduce((n, r) => n + r.w * r.d, 0)
    const x0 = Math.min(...rooms.map((r) => r.x - r.w / 2))
    const x1 = Math.max(...rooms.map((r) => r.x + r.w / 2))
    const z0 = Math.min(...rooms.map((r) => r.z - r.d / 2))
    const z1 = Math.max(...rooms.map((r) => r.z + r.d / 2))
    expect(area).toBeCloseTo((x1 - x0) * (z1 - z0), 1)
    const living = rooms.find((r) => r.id === 'living')
    expect(living.w * living.d).toBeGreaterThan(Math.max(...rooms.filter((r) => r !== living).map((r) => r.w * r.d)))
    for (const d of L.nodes.filter((n) => n.kind === 'device')) {
      const r = rooms.find((x) => x.id === d.room)
      expect(Math.abs(d.x - r.x)).toBeLessThanOrEqual(r.w / 2)
      expect(Math.abs(d.z - r.z)).toBeLessThanOrEqual(r.d / 2)
    }
    const { problems, spec } = checkSpec({ ...SCENES.plan, links: [] })
    expect(problems.join(' ')).toMatch(/a device needs an in link to its room/)
    expect(spec.links.filter((k) => k.kind === 'in')).toHaveLength(5)
  })

  it('puts every kind of the three new idioms on a parts plate, so the spec sheet shows them', () => {
    for (const name of ['clock', 'route', 'plan']) {
      const kinds = new Set(checkSpec(PLATES[name]).spec.lanes.map((l) => l.kind))
      expect([...kinds].sort(), name).toEqual([...ARCHETYPES[name].kinds].sort())
      expect(PLATES[name].title).toMatch(/^Parts plate/)
    }
  })

  it('draws the hidden-line pass the same way every time: a dashed, depth-blind twin under every bold outline, a depth-only body behind it', () => {
    const pal = Object.fromEntries(['ink', 'muted', 'faint', 'ochre', 'navy', 'page'].map((k) => [k, new T.Color('#333333')]))
    const passes = () => {
      const kit = createKit(T, pal, mulberry32(7))
      const L = layoutScene(scene(PLATES.fluid))
      const out = []
      for (const n of L.nodes) {
        kit.parts[n.kind](n, { toward: new T.Vector3(1, 0, 0), center: () => new T.Vector3() }).node.traverse((o) => {
          if (o.userData.pass) out.push([n.id, o.userData.pass, o.type, o.material.type, o.material.depthTest, o.material.depthWrite, o.material.colorWrite, [...(o.geometry.attributes.position?.array ?? [])].slice(0, 9).map((v) => Math.round(v * 1000))])
        })
      }
      return out
    }
    const a = passes()
    expect(a).toEqual(passes())
    const hidden = a.filter((x) => x[1] === 'hidden')
    expect(hidden.length).toBeGreaterThan(5)
    expect(hidden.every((x) => x[3] === 'LineDashedMaterial' && x[4] === false)).toBe(true)
    expect(a.filter((x) => x[1] === 'nudge')).toHaveLength(hidden.length)
    const bodies = a.filter((x) => x[1] === 'occlude')
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    expect(bodies.every((x) => x[2] === 'Mesh' && x[5] === true && x[6] === false)).toBe(true)
  })

  it('draws each new kind with the kit, in tokens', () => {
    const pal = Object.fromEntries(['ink', 'muted', 'faint', 'ochre', 'navy', 'page'].map((k) => [k, new T.Color('#333333')]))
    const kit = createKit(T, pal, mulberry32(1))
    for (const name of ['clock', 'route', 'plan']) {
      const L = layoutScene(scene(SCENES[name]))
      for (const n of L.nodes) expect(kit.parts[n.kind], `${name} ${n.kind}`).toBeTypeOf('function')
      for (const n of L.nodes) expect(kit.parts[n.kind](n, { toward: new T.Vector3(), center: () => new T.Vector3() }).node).toBeTruthy()
    }
  })
})

describe('the day round the clock, and the home', () => {
  // DAY is Monday 9 March in Europe/Amsterdam (UTC+1): its meetings at 08:00 and 10:00 UTC are 09:00 and 11:00 on the dial.
  const day = { ...DAY, timeZone: 'Europe/Amsterdam' }
  const noon = Date.parse('2026-03-09T10:30:00Z')

  it('puts the day\'s meetings round a 24 hour dial, one each, with the hand at now and a door to the moment each was held in', () => {
    const skeleton = bindSchedule(day, TIMELINE, noon)
    const { spec, problems } = checkSpec({ ...skeleton, steps: fallbackSteps(skeleton) })
    expect(problems).toEqual([])
    expect(spec).toMatchObject({ form: 'scene', archetype: 'clock', view: 'schedule', source: { view: 'schedule', args: { date: '2026-03-09' } } })
    const meetings = spec.lanes.filter((l) => l.role === 'meeting')
    // The summary's two and the calendar's two later ones; the calendar's Standup and Planning are the same meetings, not new ones.
    expect(meetings.map((m) => [m.label, m.start, m.end])).toEqual([['Standup', 9, 9.25], ['Planning with Mira Bakker', 11, 12], ['Design review', 15, 16], ['Pairing', 15.5, 16.5]])
    expect(meetings.map((m) => m.state)).toEqual(['done', 'now', 'next', 'next'])
    expect(meetings.find((m) => m.label.startsWith('Planning')).door).toBe('moment:01M6AAAAAAAAAAAAAAAAAAAAM1')
    expect(meetings.find((m) => m.label === 'Pairing').door).toBe('search:Pairing')
    expect(spec.lanes.find((l) => l.kind === 'hand')).toMatchObject({ label: 'Now', start: 11.5 })
    expect(spec.lanes.find((l) => l.kind === 'dial').shape).toBe('day')
    expect(spec.links).toEqual([{ from: meetings[2].id, to: meetings[3].id, kind: 'clash' }])
    expect(spec.steps[0].say).toMatch(/^Planning with Mira Bakker is on now, at 11:00\./)
    expect(spec.steps.some((st) => /runs into Pairing/.test(st.say))).toBe(true)
    // Solved: every meeting an arc on the dial, the clashing two on different rings.
    const L = layoutScene(spec)
    const [a, b] = [meetings[2], meetings[3]].map((m) => L.nodes.find((n) => n.id === m.id).arc)
    expect(a.r0).not.toBe(b.r0)
  })

  it('a day that is not today has no hand and every meeting done; a day with no record is nothing', () => {
    const spec = bindSchedule(day, TIMELINE, Date.parse('2026-03-12T10:00:00Z'))
    expect(spec.lanes.some((l) => l.kind === 'hand')).toBe(false)
    expect(spec.lanes.filter((l) => l.role === 'meeting').every((m) => m.state === 'done')).toBe(true)
    expect(bindSchedule(null, TIMELINE)).toBeNull()
  })

  it('is a view the route gate can pick, read from the summary and the flight recorder', async () => {
    expect(VIEWS.schedule.about).toMatch(/round the clock/)
    const read = vi.fn(async (tool) => (tool === 'gnomon_timeline' ? TIMELINE : day))
    const skeleton = await VIEWS.schedule.read(read, { date: '2026-03-09' })
    expect(skeleton.archetype).toBe('clock')
    // The timeline narrowed at the source to the calendar's rows and the moments held in a meeting: two light reads, not the whole day.
    expect(read.mock.calls.map(([t, a]) => `${t}${a.contains ? ` ${a.contains}` : ''}`).sort()).toEqual(['gnomon_timeline meetingtitle', 'gnomon_timeline startdate', 'gnomon_today_summary'])
    expect(skeleton.lanes.filter((l) => l.role === 'meeting')).toHaveLength(4)
  })

  it('a home is a plan of Home Assistant\'s areas and entities, and until it is connected the view says so', async () => {
    const home = bindHome(HOME)
    const { spec, problems } = checkSpec({ ...home, steps: fallbackSteps(home) })
    expect(problems).toEqual([])
    expect(spec.lanes.filter((l) => l.kind === 'room').map((l) => [l.label, l.value])).toEqual([['Living room', 32], ['Kitchen', 14], ['Bedroom', 9], ['Hall', 12]])
    // The garage is no area the home names: its sensor is left out.
    expect(spec.lanes.filter((l) => l.kind === 'device').map((l) => [l.label, l.state])).toEqual([['Floor lamp', 'on'], ['Speaker', 'off'], ['Thermostat', 'on'], ['Front door', 'closed'], ['Night light', 'off']])
    expect(spec.links.every((k) => k.kind === 'in')).toBe(true)
    expect(bindHome(null)).toBeNull()
    expect(await VIEWS.home.read(vi.fn())).toBeNull()
    const out = await build({ ask: 'show me my home', view: 'home' }, { read: vi.fn() })
    expect(out).toEqual({ ok: false, reason: 'Home Assistant is not connected yet: there are no rooms or devices to draw.' })
  })
})
