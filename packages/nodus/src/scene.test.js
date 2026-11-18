import { describe, expect, it } from 'vitest'
import { checkSpec } from './spec.js'
import { layoutScene } from './layout-scene.js'
import { solveArc } from './solve-arc.js'
import { solveFlow } from './solve-flow.js'
import { solveForce } from './solve-force.js'
import { MODULE, solveGears } from './solve-gears.js'
import { mulberry32, seedOf } from './rng.js'
import { frameFor, project, sphereOf, VIEWS } from './camera.js'
import { SCENES } from './fixture.test-data.js'
import { leaderPath } from './labels.js'
import { KIND_SAYS, blueprintSpec, fallbackSteps } from './storyboard.js'
import { layoutStages } from './render-rows.js'

const checked = (s) => checkSpec(s)
const lane = (id, kind, extra = {}) => ({ id, label: `Item ${id}`, kind, ...extra })
const scene = (archetype, lanes, links = [], extra = {}) => ({ v: 1, form: 'scene', archetype, title: `A ${archetype}`, lanes, links, steps: [{ focus: [lanes[0].id], say: `${lanes[0].label} first.` }], ...extra })

describe('the scene form', () => {
  it('passes every fixture blueprint as written, keeping kinds, states, rates and labels', () => {
    for (const s of Object.values(SCENES)) expect(checked(s).problems, s.archetype).toEqual([])
    const fluid = checked(SCENES.fluid).spec
    expect(fluid.links[0]).toEqual({ from: 'air', to: 'evap', kind: 'flow', rate: 2 })
    expect(fluid.lanes[1]).toMatchObject({ kind: 'tank', state: 'gas', value: 4 })
  })

  it('coerces an unknown kind to the archetype default and says so', () => {
    const out = checked(scene('fluid', [lane('a', 'source'), lane('b', 'bathtub')], [{ from: 'a', to: 'b', kind: 'flow' }]))
    expect(out.spec.lanes[1].kind).toBe('tank')
    expect(out.problems.join(' ')).toMatch(/b: kind "bathtub" is not a fluid kind.*drawn as tank/)
  })

  it('mechanism: teeth held to 6..120, a mesh only between gears, an odd ring of gears dropped as it would lock', () => {
    const out = checked(scene('mechanism', [lane('a', 'gear', { value: 3 }), lane('b', 'gear', { value: 400 }), lane('c', 'gear'), lane('s', 'shaft')], [
      { from: 'a', to: 'b', kind: 'mesh' }, { from: 'b', to: 'c', kind: 'mesh' }, { from: 'c', to: 'a', kind: 'mesh' }, { from: 'a', to: 's', kind: 'mesh' },
    ]))
    expect(out.spec.lanes.map((l) => l.value)).toEqual([6, 120, 12, undefined])
    expect(out.spec.links).toEqual([{ from: 'a', to: 'b', kind: 'mesh' }, { from: 'b', to: 'c', kind: 'mesh' }])
    expect(out.problems.join(' ')).toMatch(/c to a: this mesh closes an odd ring of gears, which would lock/)
    expect(out.problems.join(' ')).toMatch(/a to s: only a gear meshes with a gear/)
    // An even ring turns, so it stays.
    const even = checked(scene('mechanism', ['a', 'b', 'c', 'd'].map((id) => lane(id, 'gear')), [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([from, to]) => ({ from, to, kind: 'mesh' }))))
    expect(even.spec.links).toHaveLength(4)
  })

  it('fluid: a source is required and a rate is above zero', () => {
    const out = checked(scene('fluid', [lane('a', 'tank'), lane('b', 'sink')], [{ from: 'a', to: 'b', kind: 'flow', rate: 0 }]))
    expect(out.spec.lanes[0].kind).toBe('source')
    expect(out.spec.links[0].rate).toBe(1)
    expect(out.problems).toHaveLength(2)
  })

  it('orbital: one center (the heaviest), every body orbits, an orbit link reads outward in', () => {
    const out = checked(scene('orbital', [lane('a', 'body', { value: 5 }), lane('b', 'body', { value: 50 }), lane('m', 'moon')], [{ from: 'b', to: 'a', kind: 'orbit' }]))
    expect(out.spec.lanes.map((l) => l.kind)).toEqual(['body', 'center', 'moon'])
    expect(out.spec.links).toEqual([{ from: 'a', to: 'b', kind: 'orbit' }, { from: 'm', to: 'a', kind: 'orbit' }])
  })

  it('system: one sun and one ground at most; free scenes carry search doors only; caps on parts and links', () => {
    const out = checked(scene('system', [lane('s1', 'sun'), lane('s2', 'sun'), lane('g', 'ground', { door: 'entity:tidewater' }), lane('k', 'sphere', { door: 'search:light' })]))
    expect(out.spec.lanes.map((l) => l.kind)).toEqual(['sun', 'sphere', 'ground', 'sphere'])
    expect(out.spec.lanes[2].door).toBeUndefined()
    expect(out.spec.lanes[3].door).toBe('search:light')
    const big = checked(scene('system', Array.from({ length: 30 }, (_, i) => lane(`n${i}`, 'box')), Array.from({ length: 60 }, (_, i) => ({ from: `n${i % 20}`, to: `n${(i % 20) + 1}`, kind: 'touch' }))))
    expect(big.spec.lanes).toHaveLength(24)
    expect(big.spec.links).toHaveLength(48)
    // A bound scene (read from the record) keeps its entity doors.
    expect(checked(scene('system', [lane('g', 'ground', { door: 'entity:tidewater' })], [], { source: { view: 'where', args: {} } })).spec.lanes[0].door).toBe('entity:tidewater')
  })

  it('small-model habits: an observer that names no person is a box; gear teeth given as a ratio are scaled up', () => {
    const sys = checked(scene('system', [{ id: 'cam', label: 'Your camera', kind: 'observer' }, { id: 'you', label: 'You', kind: 'observer' }, { id: 'rider', label: 'The rider', kind: 'observer' }]))
    expect(sys.spec.lanes.map((l) => l.kind)).toEqual(['box', 'observer', 'observer'])
    expect(sys.problems.join(' ')).toMatch(/cam: an observer is a person and "Your camera" is not one; drawn as a box/)
    const gears = checked(scene('mechanism', [lane('ring', 'gear', { value: 3 }), lane('cog', 'gear', { value: 1 })], [{ from: 'ring', to: 'cog', kind: 'mesh' }]))
    expect(gears.spec.lanes.map((l) => l.value)).toEqual([48, 16])
    expect(gears.problems).toEqual([])
    // Every kind the prompt offers says what it is for, in a few words, or none at all.
    for (const [k, said] of Object.entries(KIND_SAYS)) expect(said.split(' ').length, k).toBeLessThan(9)
  })

  it('a free blueprint may be amounts (bars) or a sequence (stages), drawn as rows with a walk from the numbers', () => {
    const bars = checked(blueprintSpec({ archetype: 'bars', title: 'Savings after inflation', nodes: [{ id: 'now', label: 'Today', value: 1000, unit: 'EUR' }, { id: 'ten', label: 'In ten years', value: 744, unit: 'EUR', then: 1000 }], edges: [], steps: [] }))
    expect(bars.spec).toMatchObject({ form: 'bars', view: 'free' })
    expect(bars.spec.lanes[1]).toMatchObject({ value: 744, then: 1000, role: 'marker' })
    const stages = checked(blueprintSpec({ archetype: 'stages', title: 'A star', nodes: [{ id: 'cloud', label: 'Gas cloud', note: 'Gravity pulls the gas together', tags: ['gravity'] }, { id: 'main', label: 'Main sequence' }, { id: 'dwarf', label: 'White dwarf' }], edges: [], steps: [] }))
    expect(stages.spec.form).toBe('stages')
    expect(stages.spec.lanes[0].cells).toEqual(['gravity'])
    expect(fallbackSteps(stages.spec).map((st) => st.focus[0])).toEqual(['cloud', 'main', 'dwarf'])
    // Sides alternate on a wide plate; narrow, every stage stands to the right of the spine.
    expect(layoutStages(stages.spec, { width: 1000 }).stages.map((st) => st.right)).toEqual([true, false, true])
    expect(layoutStages(stages.spec, { width: 400 }).stages.every((st) => st.right)).toBe(true)
  })

  it('a leader leaves its label on a short shelf with a tick, then runs straight to the part', () => {
    expect(leaderPath({ side: 'left', leader: [[100, 50], [200, 80]] })).toBe('M104.0,47.0V53.0M104.0,50.0H118.0L200.0,80.0')
    expect(leaderPath({ side: 'top', leader: [[60, 20], [90, 120]] })).toBe('M57.0,20.0H63.0M60.0,20.0V34.0L90.0,120.0')
    expect(leaderPath({ side: 'inline', leader: [[10, 10], [10, 30]] }, 2)).toBe('M20.0,20.0L20.0,60.0')
  })

  it('leaves the four rows forms as they were', () => {
    const out = checked({ v: 1, form: 'graph', title: 'g', lanes: [{ id: 'a', label: 'Alpha', role: 'project', kind: 'gear' }, { id: 'b', label: 'Beta', role: 'person' }], links: [{ from: 'a', to: 'b', kind: 'mesh' }], steps: [{ focus: ['a'], say: 'Alpha first.' }] })
    expect(out.spec.links).toEqual([{ from: 'a', to: 'b' }])
    expect(out.spec.lanes[0].kind).toBeUndefined()
    expect(out.spec.archetype).toBeUndefined()
  })
})

// 24 parts per archetype, the cap, wired the way a busy blueprint would be.
const rnd = mulberry32(7)
const BIG = {
  system: scene('system', Array.from({ length: 24 }, (_, i) => lane(`p${i}`, ['sun', 'cloud', 'rain', 'ground', 'sphere', 'box', 'cone', 'prism'][i % 8], { value: 1 + (i % 5) })), Array.from({ length: 30 }, (_, i) => ({ from: `p${i % 24}`, to: `p${(i * 7 + 1) % 24}`, kind: 'ray' }))),
  orbital: scene('orbital', [lane('c', 'center', { value: 999 }), ...Array.from({ length: 15 }, (_, i) => lane(`b${i}`, 'body', { value: 1 + Math.floor(rnd() * 100) })), ...Array.from({ length: 8 }, (_, i) => lane(`m${i}`, 'moon'))], [...Array.from({ length: 15 }, (_, i) => ({ from: `b${i}`, to: 'c', kind: 'orbit' })), ...Array.from({ length: 8 }, (_, i) => ({ from: `m${i}`, to: `b${i % 3}`, kind: 'orbit' }))]),
  fluid: scene('fluid', [lane('s0', 'source'), lane('s1', 'source'), ...Array.from({ length: 22 }, (_, i) => lane(`t${i}`, ['tank', 'pump', 'valve', 'reservoir', 'sink'][i % 5], { value: 1 + i }))], [{ from: 's0', to: 't0', kind: 'flow', rate: 3 }, { from: 's1', to: 't1', kind: 'flow', rate: 1 }, ...Array.from({ length: 21 }, (_, i) => ({ from: `t${i}`, to: `t${i + 1}`, kind: 'flow', rate: 1 + (i % 4) })), { from: 't20', to: 't3', kind: 'flow', rate: 2 }, { from: 't15', to: 't7', kind: 'flow', rate: 2 }, { from: 't2', to: 't9', kind: 'flow', rate: 2 }]),
  mechanism: scene('mechanism', [...Array.from({ length: 20 }, (_, i) => lane(`g${i}`, 'gear', { value: 8 + ((i * 13) % 40), ...(i === 0 ? { state: 'driving' } : {}) })), lane('s', 'shaft'), lane('k', 'crank'), lane('l', 'lever'), lane('p', 'piston')], [...Array.from({ length: 19 }, (_, i) => ({ from: `g${i}`, to: `g${i + 1}`, kind: i % 6 === 5 ? 'belt' : 'mesh' })), { from: 'g3', to: 's', kind: 'push' }, { from: 's', to: 'k', kind: 'push' }, { from: 'k', to: 'p', kind: 'push' }, { from: 'g10', to: 'l', kind: 'push' }]),
}
const SOLVE = { system: (s) => solveArc(s.lanes, s.links), orbital: (s) => solveForce(s.lanes, s.links, seedOf(s)), fluid: (s) => solveFlow(s.lanes, s.links), mechanism: (s) => solveGears(s.lanes, s.links) }

describe('the solvers', () => {
  it.each(Object.keys(SOLVE))('%s: the same blueprint solves to the same set, twice, in under 50 ms on 24 parts', (a) => {
    const spec = checked(BIG[a]).spec
    expect(spec.lanes).toHaveLength(24)
    SOLVE[a](spec) // warm
    const t0 = performance.now()
    const one = SOLVE[a](spec)
    const ms = performance.now() - t0
    expect(SOLVE[a](spec)).toEqual(one)
    expect(ms).toBeLessThan(50)
    expect(layoutScene(spec)).toEqual(layoutScene(spec))
    for (const n of one.nodes) expect([n.x, n.y, n.z, n.r].every(Number.isFinite), n.id).toBe(true)
  })

  it('gears never overlap: meshed gears touch at their pitch circles, every other pair keeps clear', () => {
    for (const s of [BIG.mechanism, SCENES.mechanism, scene('mechanism', ['a', 'b', 'c', 'd'].map((id, i) => lane(id, 'gear', { value: 10 + i * 6 })), [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([from, to]) => ({ from, to, kind: 'mesh' })))]) {
      const spec = checked(s).spec
      const { nodes } = solveGears(spec.lanes, spec.links)
      const mesh = new Set(spec.links.filter((k) => k.kind === 'mesh').flatMap((k) => [`${k.from}|${k.to}`, `${k.to}|${k.from}`]))
      const outer = (n) => n.r + (n.kind === 'gear' ? MODULE : 0)
      for (const a of nodes) {
        for (const b of nodes) {
          if (a.id >= b.id) continue
          const d = Math.hypot(a.x - b.x, a.y - b.y)
          if (mesh.has(`${a.id}|${b.id}`) && Math.abs(d - (a.r + b.r)) < 0.01) {
            expect(a.spin, `${a.id} and ${b.id} turn opposite ways`).toBe(-b.spin)
          } else expect(d, `${a.id} clear of ${b.id}`).toBeGreaterThanOrEqual(outer(a) + outer(b))
        }
      }
    }
  })

  it('every mesh of the fixtures and of a closed even ring is a real touch', () => {
    for (const s of [SCENES.mechanism, scene('mechanism', ['a', 'b', 'c', 'd'].map((id) => lane(id, 'gear', { value: 20 })), [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']].map(([from, to]) => ({ from, to, kind: 'mesh' })))]) {
      const spec = checked(s).spec
      const at = new Map(solveGears(spec.lanes, spec.links).nodes.map((n) => [n.id, n]))
      for (const k of spec.links.filter((x) => x.kind === 'mesh')) {
        const [a, b] = [at.get(k.from), at.get(k.to)]
        expect(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - (a.r + b.r)), `${k.from} meets ${k.to}`).toBeLessThan(0.01)
      }
    }
  })

  it('flow layering is a DAG: every flow pipe runs strictly right, the loop comes back as a return under the set', () => {
    for (const s of [SCENES.fluid, BIG.fluid]) {
      const spec = checked(s).spec
      const { nodes, edges, floor } = solveFlow(spec.lanes, spec.links)
      const at = new Map(nodes.map((n) => [n.id, n]))
      const flows = edges.filter((e) => e.kind === 'flow')
      expect(flows.length).toBeGreaterThan(0)
      for (const e of flows) expect(at.get(e.to).layer, `${e.from} to ${e.to}`).toBeGreaterThan(at.get(e.from).layer)
      const returns = edges.filter((e) => e.kind === 'return')
      expect(returns.length).toBeGreaterThan(0)
      for (const e of returns) expect(Math.min(...e.points.map((p) => p[1]))).toBeGreaterThan(floor)
    }
    // The heat pump's loop: the valve feeds the evaporator back.
    const hp = solveFlow(checked(SCENES.fluid).spec.lanes, checked(SCENES.fluid).spec.links)
    expect(hp.edges.find((e) => e.from === 'valve').kind).toBe('return')
  })

  it('orbital: no two parts closer than their sizes, rings in the blueprint\'s order, the outer slower', () => {
    for (const s of [SCENES.orbital, BIG.orbital]) {
      const spec = checked(s).spec
      const { nodes } = solveForce(spec.lanes, spec.links, seedOf(spec))
      const solid = nodes.filter((n) => n.kind !== 'ring')
      for (const a of solid) for (const b of solid) if (a.id < b.id) expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `${a.id} and ${b.id}`).toBeGreaterThan(a.r + b.r)
      const round = solid.filter((n) => n.around === solid[0].id).sort((a, b) => a.orbit - b.orbit)
      for (let i = 1; i < round.length; i++) expect(round[i].speed).toBeLessThan(round[i - 1].speed)
    }
    const sol = solveForce(checked(SCENES.orbital).spec.lanes, checked(SCENES.orbital).spec.links, 1)
    const orbit = (id) => sol.nodes.find((n) => n.id === id).orbit
    expect(orbit('mercury')).toBeLessThan(orbit('jupiter'))
  })

  it('a terrain with a picture takes it as its height, not as a picture part', () => {
    const spec = checkSpec({ v: 1, form: 'scene', archetype: 'system', title: 'Island', lanes: [{ id: 'land', label: 'Island', kind: 'contour', shape: 'island', image: '/lab/img/a.png' }], steps: [{ focus: ['land'], say: 'The island rises.' }] }).spec
    const [n] = layoutScene(spec).nodes
    expect(n.height).toBe('/lab/img/a.png')
    expect(n.image).toBeUndefined()
  })
})

describe('labels and the camera', () => {
  it('frames the whole when nothing is lit, and moves toward what is', () => {
    const L = layoutScene(checked(SCENES.orbital).spec)
    const all = sphereOf(L.nodes)
    const whole = frameFor([], L.nodes, VIEWS.orbital)
    expect(whole.radius).toBe(all.radius)
    // Centred on the set's box as the picture sees it (each part with its own reach, an orbit its ring): as far left as right, as far up as down.
    const balanced = (nodes, f, view) => {
      const reach = (k, sign) => Math.max(...nodes.map((n) => {
        const b = n.frame ?? { center: [n.x, n.y, n.z], radius: n.r }
        return sign * project(b.center.map((v, i) => v - f.center[i]), view)[k] + b.radius
      }))
      expect(reach('x', 1)).toBeCloseTo(reach('x', -1), 5)
      expect(reach('y', 1)).toBeCloseTo(reach('y', -1), 5)
    }
    balanced(L.nodes, whole, VIEWS.orbital)
    const earth = frameFor(L.nodes.filter((n) => n.id === 'earth'), L.nodes, VIEWS.orbital)
    expect(earth.radius).toBeLessThanOrEqual(all.radius)
    expect(earth.radius).toBeGreaterThanOrEqual(all.radius * 0.45)
    expect(earth.ry).toBeLessThanOrEqual(whole.ry)
    // A wide set is framed by its width: the gear train's height is well under its sphere.
    const gears = layoutScene(checked(SCENES.mechanism).spec)
    const g = frameFor([], gears.nodes, VIEWS.mechanism)
    expect(g.ry).toBeLessThan(g.radius * 0.8)
    balanced(gears.nodes, g, VIEWS.mechanism)
  })
})
