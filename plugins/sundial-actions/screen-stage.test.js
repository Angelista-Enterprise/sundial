import { describe, expect, it } from 'vitest'
import { SLOTS, screenStage, staged, turnEnded } from './screen-stage.js'

/** The stage after a list of apps is used, one per millisecond. */
const after = (apps) => apps.reduce((r, app, i) => staged(r.slots, app, 's1', i), { slots: [] })

describe('the screen stage (experiments.screenStage)', () => {
  it('one window takes the whole free screen, two sit side by side, three take a half and two quarters', () => {
    expect(staged([], 'Notes', 's1', 0).send).toEqual([{ type: 'place', app: 'Notes', slot: [0, 0, 1, 1] }])
    expect(after(['Notes', 'Safari']).send).toEqual([
      { type: 'place', app: 'Notes', slot: [0, 0, 0.5, 1] },
      { type: 'place', app: 'Safari', slot: [0.5, 0, 0.5, 1] },
    ])
    expect(after(['Notes', 'Safari', 'Mail']).send.map((c) => c.slot)).toEqual(SLOTS[2])
  })

  it('an app already on the stage keeps its slot and is placed there again, nothing else moves', () => {
    const r = staged(after(['Notes', 'Safari', 'Mail']).slots, 'Safari', 's1', 9)
    expect(r.slots.map((s) => s.app)).toEqual(['Notes', 'Safari', 'Mail'])
    expect(r.send).toEqual([{ type: 'place', app: 'Safari', slot: [0.5, 0, 0.5, 0.5] }])
  })

  it('never more than three: a fourth app replaces the one used longest ago, which goes back where it was', () => {
    // Notes was used again last, so Safari is the oldest.
    const r = after(['Notes', 'Safari', 'Mail', 'Notes', 'Finder'])
    expect(r.slots.map((s) => s.app)).toEqual(['Notes', 'Finder', 'Mail'])
    expect(r.send).toEqual([
      { type: 'unplace', app: 'Safari' },
      { type: 'place', app: 'Finder', slot: [0.5, 0, 0.5, 0.5] },
    ])
    expect(after(['Notes', 'Safari', 'Mail', 'Notes', 'Finder', 'Xcode', 'Music']).slots).toHaveLength(3)
  })

  it('off, nothing is placed and nothing is said', () => {
    const sent = []
    const stage = screenStage((c) => sent.push(c), () => false)
    expect(stage.settle(stage.use('Notes', 's1'), true)).toBe('')
    stage.end('s1')
    expect(sent).toEqual([])
    expect(stage.has('Notes')).toBe(false)
  })

  it('a slot is taken only when the app placed the window; a refused one is given back and the rest go back to their layout', () => {
    const sent = []
    const stage = screenStage((c) => sent.push(c), () => true)
    expect(stage.settle(stage.use('Notes', 's1'), true)).toMatch(/screen stage.*: Notes\.$/)
    expect(stage.settle(stage.use('Notes', 's1'), true)).toBe('')
    // A private app: the app placed nothing and refused the look.
    sent.length = 0
    expect(stage.settle(stage.use('Mail', 's1'), false)).toBe('')
    expect(stage.has('Mail')).toBe(false)
    expect(sent).toEqual([
      { type: 'place', app: 'Notes', slot: [0, 0, 0.5, 1] },
      { type: 'place', app: 'Mail', slot: [0.5, 0, 0.5, 1] },
      { type: 'place', app: 'Notes', slot: [0, 0, 1, 1] },
    ])
    // Nothing says (a refused act): the slot is kept, an unplace of a window never placed does nothing.
    stage.settle(stage.use('Safari', 's1'), undefined)
    expect(stage.has('Safari')).toBe(true)
    // An app already on the stage keeps its slot whatever its look says.
    stage.settle(stage.use('Notes', 's1'), false)
    expect(stage.has('Notes')).toBe(true)
    expect(stage.use(undefined, 's1')).toBe(null)
    // A window named by the call is the one placed.
    stage.use('Safari', 's1', 'Docs')
    expect(sent.at(-1)).toEqual({ type: 'place', app: 'Safari', slot: [0.5, 0, 0.5, 1], window: 'Docs' })
  })

  it('free puts one app back at once and drops its slot; an app not on the stage sends nothing (run 27)', () => {
    const sent = []
    const stage = screenStage((c) => sent.push(c), () => true)
    stage.settle(stage.use('Calculator', 's1'), true)
    stage.free('Calculator')
    expect(sent.at(-1)).toEqual({ type: 'unplace', app: 'Calculator' })
    expect(stage.has('Calculator')).toBe(false)
    const count = sent.length
    stage.free('Calculator')
    stage.end('s1')
    expect(sent).toHaveLength(count)
  })

  it('a turn end puts back only the windows that chat staged, a stopped turn too', () => {
    const sent = []
    const stage = screenStage((c) => sent.push(c), () => true)
    stage.settle(stage.use('Notes', 'chat-a'), true)
    stage.settle(stage.use('Safari', 'chat-b'), true)
    const hook = turnEnded(stage)
    // dsh appends turn/end in a finally: a stopped turn ends with reason aborted.
    hook({ id: 'chat-b' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'stopped' } } })
    expect(sent.at(-1)).toEqual({ type: 'unplace', app: 'Safari' })
    expect([stage.has('Notes'), stage.has('Safari')]).toEqual([true, false])
    hook({ id: 'chat-a' }, { type: 'assistant/message' })
    expect(stage.has('Notes')).toBe(true)
    hook({ id: 'chat-a' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'done' } } })
    expect(sent.at(-1)).toEqual({ type: 'unplace', app: 'Notes' })
    const count = sent.length
    hook({ id: 'chat-a' }, { type: 'turn/end', data: {} })
    expect(sent).toHaveLength(count)
  })
})
