import { describe, expect, it } from 'vitest'
import { BLOCKS, checkForm, layoutForm } from './blocks.js'
import { checkSpec } from './spec.js'
import { layoutScene } from './layout-scene.js'
import { BLUEPRINTS, blueprintSpec } from './storyboard.js'
import { mulberry32 } from './rng.js'

const touching = (a, b, axis) => Math.abs(Math.abs(a.center[axis] - b.center[axis]) - (a.sides[axis] + b.sides[axis]) / 2) < 1e-2

describe('composable blocks', () => {
  it('checks a form: unknown shapes become boxes, sizes and counts are held, every fault said', () => {
    const problems = []
    const f = checkForm({ shape: 'blob', size: 'huge', parts: [{ shape: 'rod', at: 'sideways', count: 40 }, { shape: 'lens', size: [9, 0.01, 1] }] }, problems, 'cam.form')
    expect(f).toMatchObject({ shape: 'box', size: 'm', at: 'center', parts: [{ shape: 'rod', at: 'top', count: 12 }, { shape: 'lens', size: [3, 0.04, 1] }] })
    expect(problems.join(' ')).toMatch(/cam\.form: shape "blob" is not one of/)
    expect(problems.join(' ')).toMatch(/cam\.form\.parts\[0\]: at "sideways" is not one of .*put on top/)
  })

  it('lays a form out so each child touches its parent at its port, the whole sized to the radius', () => {
    const f = checkForm({ shape: 'box', size: [2, 1, 1], parts: [{ shape: 'cylinder', at: 'top', size: 's' }, { shape: 'rod', at: 'right', size: 'm' }, { shape: 'sphere', at: 'inside', size: 'xl' }] })
    const [box, cyl, rod, ball] = layoutForm(f, 1.5, mulberry32(1))
    expect(touching(box, cyl, 1)).toBe(true)
    // A long block on a side lies along that side's axis.
    expect(rod.axis).toBe('x')
    expect(rod.sides[0]).toBeGreaterThan(rod.sides[1])
    expect(touching(box, rod, 0)).toBe(true)
    // Inside: within its shell, drawn as an inner part.
    expect(ball.inner).toBe(true)
    for (const k of [0, 1, 2]) expect(ball.sides[k]).toBeLessThanOrEqual(box.sides[k] * 0.8 + 1e-6)
    const all = layoutForm(f, 1.5, mulberry32(1))
    const reach = Math.max(...[0, 1, 2].map((k) => Math.max(...all.map((p) => p.center[k] + p.sides[k] / 2)) - Math.min(...all.map((p) => p.center[k] - p.sides[k] / 2))))
    expect(reach).toBeCloseTo(3, 2)
  })

  it('repeats along a face, rings around, mirrors to the opposite port', () => {
    const f = checkForm({ shape: 'cylinder', size: 'l', parts: [{ shape: 'box', at: 'around', size: 'xs', count: 6 }, { shape: 'disc', at: 'top', size: 'xs', count: 3 }, { shape: 'panel', at: 'left', size: 's', mirror: true }] })
    const ps = layoutForm(f, 1, mulberry32(2))
    expect(ps.filter((p) => p.shape === 'box')).toHaveLength(6)
    expect(new Set(ps.filter((p) => p.shape === 'disc').map((p) => p.center[0])).size).toBe(3)
    const panels = ps.filter((p) => p.shape === 'panel')
    expect(panels[0].center[0]).toBeCloseTo(-panels[1].center[0], 3)
    expect(Object.keys(BLOCKS).length).toBeGreaterThanOrEqual(14)
  })

  it('an object: every part on another at its port, laid out as one tree so parts touch, one scale throughout', () => {
    const out = checkSpec(blueprintSpec(BLUEPRINTS['show me a robot arm'], 'show me a robot arm'))
    expect(out.problems).toEqual([])
    const L = layoutScene(out.spec)
    expect(L.view).toBe('object')
    const at = new Map(L.nodes.map((n) => [n.id, n]))
    // The shoulder stands above the base, the forearm to the right of the elbow, and each part carries its own primitives.
    expect(at.get('shoulder').y).toBeGreaterThan(at.get('base').y)
    expect(at.get('fore').x).toBeGreaterThan(at.get('elbow').x)
    for (const n of L.nodes) expect(n.placed.length).toBeGreaterThan(0)
    // Pulled apart: further out the further a part is from the body.
    expect(Math.hypot(...at.get('grip').drift)).toBeGreaterThan(Math.hypot(...at.get('shoulder').drift))
  })

  it('a form redraws a plain part only: a gear keeps the engine\'s own, solved to mesh with its train', () => {
    const spec = checkSpec({ v: 1, form: 'scene', archetype: 'mechanism', title: 'Gears', lanes: [{ id: 'a', label: 'Big gear', kind: 'gear', value: 48, form: { shape: 'box' } }, { id: 'b', label: 'Small gear', kind: 'gear', value: 16 }], links: [{ from: 'a', to: 'b', kind: 'mesh' }], steps: [{ focus: ['a'], say: 'The big gear drives.' }] }).spec
    expect(layoutScene(spec).nodes.every((n) => !n.form)).toBe(true)
    const sys = checkSpec({ v: 1, form: 'scene', archetype: 'system', title: 'Cam', lanes: [{ id: 'c', label: 'Camera', kind: 'box', form: { shape: 'box', parts: [{ shape: 'lens', at: 'front' }] } }], steps: [{ focus: ['c'], say: 'The camera sees.' }] }).spec
    expect(layoutScene(sys).nodes[0].form).toBeTruthy()
  })

  it('a part that names a missing or looping parent stands alone; an object with no body gets one', () => {
    const lanes = [{ id: 'a', label: 'A', kind: 'part', on: 'b' }, { id: 'b', label: 'B', kind: 'part', on: 'a' }, { id: 'c', label: 'C', kind: 'part', on: 'zz' }]
    const out = checkSpec({ v: 1, form: 'scene', archetype: 'object', title: 'Loop', lanes, steps: [{ focus: ['a'], say: 'A first.' }] })
    expect(out.problems.join(' ')).toMatch(/loops back to itself/)
    expect(out.problems.join(' ')).toMatch(/c: on "zz" is not a part/)
    expect(out.spec.lanes.some((l) => l.on === undefined)).toBe(true)
    expect(() => layoutScene(out.spec)).not.toThrow()
  })
})
