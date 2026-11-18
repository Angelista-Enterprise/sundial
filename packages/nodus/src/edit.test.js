import { describe, expect, it } from 'vitest'
import { applyEdits, blueprintOf, parseEdits, repairMessages } from './edit.js'
import { checkSpec } from './spec.js'
import { BLUEPRINTS, blueprintSpec } from './storyboard.js'

const arm = () => checkSpec(blueprintSpec(BLUEPRINTS['show me a robot arm'], 'show me a robot arm')).spec

describe('steering by typed edits', () => {
  it('applies each kind of edit and checks the result again', () => {
    const out = applyEdits(arm(), [
      { op: 'add', part: { id: 'wrist', label: 'Wrist', on: 'fore', at: 'right', note: 'rolls 360 degrees', form: { shape: 'cylinder', size: 'xs' } } },
      { op: 'move', id: 'grip', on: 'wrist', at: 'right' },
      { op: 'note', id: 'base', note: 'bolted to the floor' },
      { op: 'label', id: 'fore', label: 'Forearm link' },
      { op: 'sketch', id: 'elbow', sketch: [[10, 10, 90, 10, 90, 90, 10, 90, 10, 10]] },
      { op: 'title', title: 'A six axis arm' },
    ])
    expect(out.ok).toBe(true)
    const by = new Map(out.spec.lanes.map((l) => [l.id, l]))
    expect(by.get('grip')).toMatchObject({ on: 'wrist', at: 'right' })
    expect(by.get('base').note).toBe('bolted to the floor')
    expect(by.get('elbow').sketch).toHaveLength(1)
    expect(out.spec.title).toBe('A six axis arm')
    expect(out.applied).toHaveLength(6)
  })

  it('drops a part with its links, focus and the parts standing on it, and says what it could not do', () => {
    const out = applyEdits(arm(), [{ op: 'drop', id: 'elbow' }, { op: 'label', id: 'nope', label: 'X' }, { op: 'fly' }])
    expect(out.spec.lanes.some((l) => l.id === 'elbow')).toBe(false)
    expect(out.spec.lanes.find((l) => l.id === 'fore').on).toBeUndefined()
    expect(out.spec.steps.every((st) => !st.focus.includes('elbow'))).toBe(true)
    expect(out.skipped.join(' ')).toMatch(/label nope: no part has that id/)
    expect(out.skipped.join(' ')).toMatch(/not an edit/)
  })

  it('leaves the spec handed in alone; reads edits out of a reply; shows the model no coordinates', () => {
    const before = arm()
    const copy = JSON.stringify(before)
    applyEdits(before, [{ op: 'drop', id: 'base' }])
    expect(JSON.stringify(before)).toBe(copy)
    expect(parseEdits('Sure: {"edits": [{"op": "drop", "id": "a"}]}')).toEqual([{ op: 'drop', id: 'a' }])
    expect(parseEdits('no json')).toEqual([])
    const bp = JSON.stringify(blueprintOf(before))
    expect(bp).not.toMatch(/"x":|"y":|"z":/)
    expect(repairMessages(before, 'the gripper is missing')[1].content).toMatch(/the gripper is missing/)
  })
})
