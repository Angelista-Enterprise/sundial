import { describe, expect, it } from 'vitest'
import { mountSlipSteps } from './slip-steps.js'

/** The two events the slip's steps listen to, the frames they push and the rows they log. Made-up values. */
function fake() {
  const on = {}
  const frames = []
  const signals = []
  const ctx = { effect: (fn) => fn(), on: (name, fn) => (on[name] = fn), gnomonKernel: { appendSignal: async (type, payload) => signals.push({ type, ...payload }) } }
  mountSlipSteps(ctx, (session, frame) => frames.push({ session, ...frame }))
  return { line: (payload) => on['gnomon/step-line'](payload), end: (id) => on['session/event']({ id }, { type: 'turn/end' }), frames, signals }
}

describe('the slip names a refused step (Set 4 R1, recovery named)', () => {
  it('a step that works shows its own words, as before', () => {
    const f = fake()
    f.line({ session: 's1', stepId: 'act-1', line: 'Open TextEdit', next: 'Open TextEdit' })
    expect(f.frames).toEqual([{ session: 's1', type: 'step', line: 'Open TextEdit', stepId: 'act-1' }])
    expect(f.signals).toEqual([])
  })

  it('a refusal is a line at once, built from the step\'s own words and the reason, logged overlay:line; the next step says what it does instead', () => {
    const f = fake()
    f.line({ session: 's1', stepId: 'act-1', line: 'Save the note', next: 'Save the note' })
    f.line({ session: 's1', stepId: 'act-1', refused: { reason: 'not-found', name: 'File > Save' } })
    expect(f.frames.at(-1)).toEqual({ session: 's1', type: 'step', line: 'Save the note: not found. Trying another way.', stepId: 'act-1' })
    f.line({ session: 's1', stepId: 'act-2', line: 'Press cmd+shift+s', next: 'Press cmd+shift+s' })
    expect(f.frames.at(-1)).toEqual({ session: 's1', type: 'step', line: 'Save the note: not found. Instead: Press cmd+shift+s.', stepId: 'act-2' })
    expect(f.signals).toEqual([
      { type: 'overlay:line', session: 's1', stepId: 'act-1', line: 'Save the note: not found. Trying another way.', refused: 'not-found' },
      { type: 'overlay:line', session: 's1', stepId: 'act-2', line: 'Save the note: not found. Instead: Press cmd+shift+s.', refused: 'not-found' },
    ])
    f.line({ session: 's1', stepId: 'act-3', line: 'Type Kestrel', next: 'Type Kestrel' })
    expect(f.frames.at(-1).line).toBe('Type Kestrel')
  })

  it('a refusal is recovered within its turn and its chat only', () => {
    const f = fake()
    f.line({ session: 's1', stepId: 'act-1', refused: { reason: 'covered', name: 'Sort By' } })
    f.line({ session: 's2', stepId: 'act-9', next: 'Open Notes' })
    expect(f.frames.at(-1).line).toBe('Open Notes')
    f.end('s1')
    f.line({ session: 's1', stepId: 'act-2', next: 'Open Finder' })
    expect(f.frames.at(-1).line).toBe('Open Finder')
    f.line({ next: 'no chat' })
    expect(f.frames).toHaveLength(3)
  })
})
