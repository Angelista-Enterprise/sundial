import { describe, expect, it } from 'vitest'
import { finalOf, judgedPlans, unknownPress } from './gate-finals.js'
import { finalWord } from './final-words.js'
import { pointAct, pointFinal, pointOf, pointPlan, under } from './screen-point.js'
import { actPlan, planAll } from './screen-tools.js'

// Doc 27 section 3: a click at a point and a drag. Made-up values: a Finder window at [100, 50], 800 by 600 points.
const ROW = {
  id: 'look-p0int01',
  tag: 'ab12',
  processName: 'Finder',
  windowTitle: 'Testbox',
  frame: [100, 50, 800, 600],
  elements: [
    { ref: 'e1', role: 'AXRow', screenText: ['report.txt', '', 'Testbox'], frame: [120, 120, 400, 20], actions: ['AXPress'] },
    { ref: 'e2', role: 'AXRow', screenText: ['Outbox', '', 'Testbox'], frame: [120, 140, 400, 20], actions: ['AXPress'] },
    { ref: 'e3', role: 'AXButton', screenText: ['Delete', '', 'toolbar'], frame: [700, 60, 60, 24], actions: ['AXPress'] },
    { ref: 'e4', role: 'AXImage', screenText: ['', '', 'toolbar'], frame: [710, 62, 16, 16], actions: [] },
    { ref: 'e5', role: 'AXButton', screenText: ['Trash', '', 'sidebar'], frame: [110, 500, 80, 20], actions: ['AXPress'] },
    { ref: 'e6', role: 'AXGroup', screenText: ['', '', ''], frame: [100, 50, 800, 600], actions: [] },
  ],
}
const LAST = { id: ROW.id, app: 'Finder' }
const readLook = async (id) => (id === ROW.id ? ROW : null)
const state = { marks: { lastLook: LAST } }

describe('a click at a point and a drag (doc 27 section 3, items 2 and 8)', () => {
  it('reads a point and says which steps are point steps', () => {
    expect(pointOf([12.4, 30])).toEqual([12, 30])
    expect(pointOf({ x: 1, y: 2 })).toEqual([1, 2])
    expect([pointOf([1]), pointOf(['a', 2]), pointOf([NaN, 1]), pointOf(undefined)]).toEqual([null, null, null, null])
    expect(pointAct({ action: 'drag' }) && pointAct({ at: [1, 2] }) && pointAct({ at: [1, 2], action: 'click' })).toBe(true)
    expect(pointAct({ action: 'press', at: [1, 2] }) || pointAct({ ref: 'e1' })).toBe(false)
  })

  it('what lies under a point: the smallest thing, unless one round it carries a final\'s words; never the window or a group', () => {
    const look = { frame: ROW.frame, elements: ROW.elements.map(({ screenText: [label], ...e }) => ({ ...e, label })) }
    expect(under(look, [30, 75], finalWord)?.ref).toBe('e1')
    // The icon inside Delete is the Delete button.
    expect(under(look, [612, 15], finalWord)?.ref).toBe('e3')
    expect(under(look, [612, 15], () => null)?.ref).toBe('e4')
    expect(under(look, [400, 300], finalWord)).toBeNull()
  })

  it('plans a click at a point with the thing under it, a point outside the window refused', async () => {
    const plan = await pointPlan({ app: 'Finder', action: 'click', at: [30, 75] }, LAST, readLook, {}, finalWord)
    expect(plan).toMatchObject({ verb: 'click', point: true, app: 'Finder', thing: { name: 'report.txt' }, inWindow: 'Testbox', command: { look: ROW.id, action: 'click', at: [30, 75] } })
    expect(plan.line).toBe('Click at [30,75] on "report.txt" in Finder')
    expect((await pointPlan({ at: [400, 300] }, LAST, readLook, { count: 2 }, finalWord))).toMatchObject({ thing: { role: '', name: '' }, command: { at: [400, 300], count: 2 } })
    expect((await pointPlan({ at: [900, 10] }, LAST, readLook)).error).toMatch(/outside the window \(800 by 600 points\)/)
    expect((await pointPlan({ app: 'Mail', at: [1, 1] }, LAST, readLook)).error).toMatch(/last look is of Finder, not Mail/)
    expect((await pointPlan({ at: [1, 1] }, null, readLook)).error).toMatch(/needs a look first/)
    expect((await pointPlan({ at: [1, 1] }, LAST, readLook, { error: 'invalid arguments: bad click' })).error).toBe('invalid arguments: bad click')
  })

  it('plans a drag from a ref or a point to a ref or a point, judged by its drop target', async () => {
    expect(await pointPlan({ action: 'drag', ref: 'e1@ab12', to: 'e2' }, LAST, readLook, {}, finalWord)).toMatchObject({ verb: 'drag', thing: { name: 'Outbox' }, line: 'Drag "report.txt" onto "Outbox" in Finder', command: { look: ROW.id, action: 'drag', ref: 'e1', to: 'e2' } })
    expect(await pointPlan({ action: 'drag', at: [30, 75], to: [30, 95] }, LAST, readLook, {}, finalWord)).toMatchObject({ thing: { name: 'Outbox' }, command: { at: [30, 75], to: [30, 95] } })
    expect((await pointPlan({ action: 'drag', ref: 'e1@zz99', to: 'e2' }, LAST, readLook)).error).toMatch(/from another look/)
    expect((await pointPlan({ action: 'drag', ref: 'e1' }, LAST, readLook)).error).toMatch(/needs to/)
    expect((await pointPlan({ action: 'drag', ref: 'e1', to: 'e77' }, LAST, readLook)).error).toMatch(/no e77 in the last look/)
  })

  it('screen_act plans them through actPlan and planAll', async () => {
    expect(await actPlan({ app: 'Finder', action: 'drag', ref: 'e1', to: 'e5' }, state, readLook)).toMatchObject({ verb: 'drag', app: 'Finder', thing: { name: 'Trash' } })
    expect(await actPlan({ app: 'Finder', at: [612, 15] }, state, readLook)).toMatchObject({ verb: 'click', thing: { name: 'Delete' }, command: { at: [612, 15] } })
    expect(await actPlan({ app: 'Finder', at: [612, 15], button: 'right' }, state, readLook)).toMatchObject({ command: { at: [612, 15], button: 'right' } })
    const all = await planAll({ app: 'Finder', steps: [{ action: 'drag', ref: 'e1@ab12', to: 'e2' }, { at: [30, 75] }] }, state, readLook)
    expect(all.error).toBeUndefined()
    expect(all.plans.map((p) => p.verb)).toEqual(['drag', 'click'])
  })

  it('the gate: a drop on the Trash deletes, a final under the point asks as that final, no words is a final-unknown', async () => {
    const asked = async (args) => finalOf('screen_act', args, undefined, judgedPlans([await actPlan(args, state, readLook)], null))
    expect(await asked({ app: 'Finder', action: 'drag', ref: 'e1', to: 'e5' })).toMatchObject({ kind: 'delete', what: 'drop onto Trash', app: 'Finder' })
    expect(await asked({ app: 'Finder', action: 'drag', ref: 'e1', to: 'e2' })).toBeNull()
    expect(await asked({ app: 'Finder', action: 'drag', ref: 'e1', to: [400, 300] })).toMatchObject({ kind: 'final-unknown', why: 'what the drop lands on shows no words' })
    expect(await asked({ app: 'Finder', at: [612, 15] })).toMatchObject({ kind: 'delete', app: 'Finder' })
    expect(await asked({ app: 'Finder', at: [400, 300] })).toMatchObject({ kind: 'final-unknown', why: 'what lies under the point shows no words' })
    expect(await asked({ app: 'Finder', at: [30, 75] })).toBeNull()
    // A drag nobody planned is never let through as nothing.
    expect(finalOf('screen_act', { app: 'Finder', action: 'drag', ref: 'e1', to: 'e5' }, undefined, [])).toMatchObject({ kind: 'final-unknown' })
    // A point with nothing readable under it is also an unknown press.
    expect(unknownPress('screen_act', {}, [await actPlan({ app: 'Finder', at: [400, 300] }, state, readLook)])).toBe(true)
  })

  it('pointFinal on its own', () => {
    expect(pointFinal({ verb: 'drag', app: 'Finder', thing: { name: 'Prullenmand' } })).toEqual({ app: 'Finder', kind: 'delete', what: 'drop onto Prullenmand' })
    expect(pointFinal({ verb: 'click', app: 'Finder', thing: { role: 'button', name: 'OK' } })).toEqual({ app: 'Finder', role: 'button', label: 'OK' })
    expect(pointFinal({ verb: 'click', app: 'Finder', thing: { name: 'e7@ab12' } })).toMatchObject({ unknown: true })
    expect(pointFinal(undefined)).toMatchObject({ unknown: true })
  })
})
