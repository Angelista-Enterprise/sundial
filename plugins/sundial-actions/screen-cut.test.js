// Fable M4 (S4): a text area a look read in part is never replaced by a set-value (spacing folded alone is no cut: ScreenLook.swift lookTextCut).
// S5R1 (Fable H3): nor one read whole whose spacing was folded (`folded`), unless it holds Gnomon's own text. Made-up values only.
import { describe, expect, it } from 'vitest'
import { line } from './screen-look.js'
import { actPlan } from './screen-tools.js'

describe('a cut text area', () => {

  it('Fable M4: a set-value replace on a text area read in part or folded is refused, by ref and by name', async () => {
    const row = { id: 'look-cut00001', processName: 'TextEdit', windowTitle: 'Draft', elements: [
      { ref: 'e1', role: 'AXTextArea', settable: true, actions: [], cut: 9000, screenText: ['Draft', 'Mira Bakker\nLunch Thursday', ''] },
    ] }
    const state = { config: { experiments: {} }, marks: { lastLook: { id: row.id, app: 'TextEdit' } } }
    const read = async (id) => (id === row.id ? row : null)
    expect((await actPlan({ ref: 'e1@0001', value: 'All new', replace: true }, state, read)).error).toMatch(/read in part.*9000 characters.*click and type/)
    expect((await actPlan({ app: 'TextEdit', role: 'text area', label: 'Draft', value: 'x', replace: true }, state, read, { byLook: true })).error).toMatch(/read in part/)
    expect((await actPlan({ ref: 'e1@0001', action: 'type', value: 'more' }, state, read)).error).toBeUndefined()
  })
})

describe('a folded text area (S5R1, Fable H3)', () => {
  const row = { id: 'look-fold0001', processName: 'Notes', windowTitle: 'Plan', elements: [
    { ref: 'e1', role: 'AXTextArea', settable: true, actions: [], folded: true, chars: 33, screenText: ['Plan', 'Lunch Thursday\n- soup\nMira Bakker', ''] },
  ] }
  const read = async (id) => (id === row.id ? row : null)
  const at = '2026-11-16T10:00:00.000Z'
  const base = { config: { experiments: {} }, marks: { lastLook: { id: row.id, app: 'Notes' } }, tasks: { c1: { id: 'task-1', at, session: 'c1' } } }

  it('is refused with or without replace, by ref and by name, and the look line says so', async () => {
    for (const args of [{ ref: 'e1@0001', value: 'All new' }, { ref: 'e1@0001', value: 'All new', replace: true }, { app: 'Notes', role: 'text area', label: 'Plan', value: 'x', replace: true }]) {
      expect((await actPlan(args, base, read, { session: 'c1' })).error).toMatch(/blank lines, indents.*33 characters.*click and type/)
    }
    expect((await actPlan({ ref: 'e1@0001', action: 'type', value: 'more' }, base, read, { session: 'c1' })).error).toBeUndefined()
    expect(line({ ref: 'e1', role: 'AXTextArea', settable: true, actions: [], folded: true, chars: 33, label: 'Plan', value: 'Lunch Thursday' })).toMatch(/blank lines and indents folded, 33 characters: edit by click and type, not set-value/)
  })

  it('goes when it is the field this chat last set, and asks the app to put back an owner\'s text even with replace', async () => {
    const set = { app: 'Notes', name: 'Plan', role: 'text area', at: '2026-11-16T10:01:00.000Z', task: 'task-1', chars: 33 }
    const mine = { ...base, marks: { ...base.marks, chats: { c1: { set } } } }
    const plan = await actPlan({ ref: 'e1@0001', value: 'Lunch Friday\n\n- soup', replace: true }, mine, read, { session: 'c1' })
    expect(plan.error).toBeUndefined()
    expect(plan.unlessReplace).toBe(true)
    // Another chat never set it: refused.
    expect((await actPlan({ ref: 'e1@0001', value: 'x', replace: true }, { ...mine, tasks: { c2: { id: 'task-2', at, session: 'c2' } } }, read, { session: 'c2' })).error).toMatch(/blank lines, indents/)
  })
})
