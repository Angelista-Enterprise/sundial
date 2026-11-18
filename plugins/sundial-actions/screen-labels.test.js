// Fixed labels: a thing keeps its ref (e7@ab12, the tag of its app run) across looks while it shows. Made-up values.
import { describe, expect, it } from 'vitest'
import { callFacts } from './gate.js'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { createInitialState } from '../../packages/kernel/src/initial-state.ts'
import { markTrack } from '../../packages/rules/src/mark-track.ts'
import { again, carry, diff, format, listed, looksLikeRef, tagOf } from './screen-look.js'
import { actPlan, filledApp, planAll, screenTools } from './screen-tools.js'
/** The fold the screen tools write to (`screen:printed`, `screen:step` into `marks`, mark-track.ts), over a test's own state. */
const folding = (state) => async (type, payload) => { state.marks = markTrack(state, { id: type, type, ts: new Date(Date.now()).toISOString(), payload }).state.marks }

const el = (ref, role, label, y, more = {}) => ({ ref, role, sub: '', label, value: '', frame: [10, y, 200, 20], actions: ['AXPress'], settable: false, enabled: true, in: 'Home', ...more })
const look = (id, elements, more = {}) => ({ id, app: 'Spotify', window: 'Home', tag: 'ab12', menus: [], elements, ...more })
/** A look as the log holds it, for the planners. */
const row = (l) => lookForLog(l)

describe('fixed labels across looks (one app run)', () => {
  it('a thing prints the same label in every look of its run; a look with no tag tags by its id', () => {
    const one = look('look-1111', [el('e3', 'AXButton', 'Play', 900)])
    const two = look('look-2222', [el('e8', 'AXButton', 'Queue', 40), el('e3', 'AXButton', 'Play', 900)])
    expect(format(one)).toContain('e3@ab12 button "Play"')
    expect(format(two)).toContain('e3@ab12 button "Play"')
    expect(tagOf(one)).toBe('ab12')
    expect(tagOf({ id: 'look-1a2b3c4d' })).toBe('3c4d')
    expect(looksLikeRef('e3@a1b2c3') && looksLikeRef('e3@3c4d') && !looksLikeRef('e3@a1b2c3d4')).toBe(true)
  })

  it('what changed is said by label: rows alike that trade places are no change, a new thing appears by its own label', () => {
    const before = look('look-1111', [el('e4', 'AXRow', 'Add', 100), el('e5', 'AXRow', 'Add', 130), el('e6', 'AXTextField', 'Search', 40, { settable: true })])
    const after = look('look-2222', [el('e5', 'AXRow', 'Add', 100), el('e4', 'AXRow', 'Add', 130), el('e6', 'AXTextField', 'Search', 40, { settable: true, value: 'naima' }), el('e9', 'AXButton', 'Clear', 40)])
    expect(diff(before, after)).toBe('appeared: e9@ab12 button "Clear"\nchanged: e6@ab12 field "Search" = "naima"')
    // A look that repeats the last one prints only what it did not list before.
    const known = listed(before)
    expect(again(after, before, { query: 'clear', known }).text).toContain('Matching "clear", not listed before:\nin Home:\ne9@ab12 button "Clear"')
    expect(carry(before, after, 'e5')).toMatchObject({ ref: 'e5', frame: [10, 100, 200, 20] })
    expect(carry(before, look('look-3333', []), 'e5')).toBeNull()
  })

  it('the fold keeps the run\'s tag on its pointer to the look', () => {
    const { state } = markTrack(createInitialState('d1'), { id: 'ev-1', type: 'screen:looked', ts: '2026-03-10T09:00:00.000Z', payload: row(look('look-1111', [el('e3', 'AXButton', 'Play', 900)])) })
    expect(state.marks?.lastLook).toMatchObject({ id: 'look-1111', app: 'Spotify', tag: 'ab12' })
  })
})

describe('acting on a label from an earlier look', () => {
  const older = row(look('look-1111', [el('e40', 'AXButton', 'Shuffle', 900)]))
  const newest = row(look('look-2222', [el('e3', 'AXButton', 'Play', 900)]))
  const notes = row(look('look-9999', [el('e1', 'AXButton', 'New Note', 40)], { app: 'Pages', window: 'Lunch', tag: 'cd34' }))
  const reader = (rows) => async (id, { field = 'id', ref } = {}) => [...rows].reverse().find((r) => (field === 'tag' ? r.tag === id && (!ref || r.elements.some((e) => e.ref === ref)) : r[field] === id)) ?? null
  const state = (last) => ({ config: { experiments: {} }, marks: { lastLook: { id: last.id, app: last.processName, n: 1, tag: last.tag } } })

  it('a label the newest look of its run does not list acts through that newest look, read from the older look that does', async () => {
    const plan = await actPlan({ ref: 'e40@ab12', action: 'press' }, state(newest), reader([older, newest]))
    expect(plan).toMatchObject({ verb: 'press', app: 'Spotify', line: 'Press "Shuffle" in Spotify', command: { look: 'look-2222', ref: 'e40', action: 'AXPress' } })
  })

  it('a label of another app acts through that app\'s newest look when the app is named; with no app, the wrong app, or gone, it is refused', async () => {
    const rows = reader([older, newest, notes])
    expect((await actPlan({ app: 'Spotify', ref: 'e3@ab12', action: 'press' }, state(notes), rows)).command).toEqual({ look: 'look-2222', ref: 'e3', action: 'AXPress' })
    expect((await actPlan({ ref: 'e3@ab12', action: 'press' }, state(notes), rows)).error).toBe('refused: e3@ab12 is a ref of Spotify, not of Pages: name the app, {app: "Spotify", ref: "e3@ab12"}')
    expect((await actPlan({ app: 'Pages', ref: 'e3@ab12', action: 'press' }, state(notes), rows)).error).toBe('refused: e3@ab12 is a ref of Spotify, not of Pages: look at Pages first')
    expect((await actPlan({ ref: 'e77@ab12', action: 'press' }, state(newest), rows)).error).toMatch(/^refused: e77@ab12 is in no recent look of Spotify: look again/)
  })

  it('a label read only in a look of another window of the app is refused, never acted on in this one', async () => {
    const otherWindow = row(look('look-1111', [el('e40', 'AXButton', 'Delete', 900)], { window: 'Draft' }))
    expect((await actPlan({ ref: 'e40@ab12', action: 'press' }, state(newest), reader([otherWindow, newest]))).error).toMatch(/^refused: e40@ab12 is in no recent look of Spotify: look again/)
  })

  it('rig run205 T12: a mark takes the caret line a look carries on a text area (c2), kept by the log as numbers and a frame', async () => {
    const caret = { line: 12, frame: [10, 410, 900, 18], ref: 'c2' }
    const doc = row(look('look-3333', [el('e2', 'AXTextArea', '', 100, { value: 'Lunch with Mira', settable: true, actions: [], caret })], { app: 'TextEdit', window: 'Brief Onyx.txt', tag: 'ef56' }))
    expect(doc.elements[0].caret).toEqual(caret)
    const state = { config: { experiments: {} }, marks: { now: [], lastLook: { id: doc.id, app: 'TextEdit', n: 1, tag: 'ef56' } } }
    const marks = []
    const placing = async (type, payload) => { if (type === 'screen:mark') marks.push(payload); state.marks.placed = [...(state.marks.placed ?? []), payload.id] }
    const mark = screenTools(placing, () => state, () => {}, reader([doc]))[0]
    expect(await mark.execute({ ref: 'c2@ef56' })).toMatch(/^Marked/)
    expect(marks[0].target).toEqual({ app: 'TextEdit', look: 'look-3333', ref: 'c2' })
    await expect(mark.execute({ ref: 'c9@ef56' })).rejects.toThrow(/in no recent look of TextEdit/)
  })

  it('a later step on one of several alike is found again by its label, never refused for its place', async () => {
    const alike = row(look('look-2222', [el('e1', 'AXButton', 'Play', 900), el('e4', 'AXRow', 'Add', 100), el('e5', 'AXRow', 'Add', 130)]))
    const out = await planAll({ steps: [{ ref: 'e1@ab12', action: 'press' }, { ref: 'e5@ab12', action: 'press' }] }, state(alike), reader([alike]))
    expect(out.error).toBeUndefined()
    expect(out.plans.map((p) => p.command)).toEqual([{ look: 'look-2222', ref: 'e1', action: 'AXPress' }, { look: 'look-2222', ref: 'e5', action: 'AXPress' }])
  })
})

describe('run 129: two refusals screen_act would not have made', () => {
  const notes = row(look('look-5555', [el('e1', 'AXTextField', 'Title', 40, { settable: true })], { app: 'Pages', window: 'Lunch', tag: 'cd34' }))
  const readRow = async (id) => (id === notes.id ? notes : null)

  it('a typing step with no app is gated on the app screen_act fills in from this chat\'s last look; none filled, still refused', async () => {
    const state = { config: { experiments: {} }, marks: { now: [] } }
    const rows = {}
    const send = (command) => {
      if (command.type !== 'look') return
      rows[command.id] = { ...notes, id: command.id }
      state.marks.lastLook = { id: command.id, app: 'Pages', n: 1, tag: 'cd34' }
    }
    const look = screenTools(folding(state), () => state, send, async (id) => rows[id] ?? null)[4]
    await look.execute({ app: 'Pages' }, { agent: { session: { id: 'chat-a' } } })
    const step = Object.freeze({ action: 'type', value: 'Lunch with Mira' })
    const typing = (args, session) => callFacts({ toolName: 'screen_act', args, fill: (s) => filledApp(s, state, session) }).typing
    expect(filledApp(step, state, 'chat-a')).toBe('Pages')
    expect(typing(step, 'chat-a')).toBeNull()
    expect(typing(Object.freeze({ steps: Object.freeze([step]) }), 'chat-a')).toBeNull()
    expect(Object.isFrozen(step) && !('app' in step)).toBe(true)
    // Another chat, or a step with a url: nothing is filled, and the refusal stays.
    expect(typing(step, 'chat-b')).toBe('unnamed')
    expect(filledApp({ ...step, url: 'https://example.com' }, state, 'chat-a')).toBeUndefined()
    // Run 215 T28: the turn that looked has been answered since; the next task's step with no app is not filled from it.
    // An answer before the look (the turn before), or none, leaves it filled.
    const answered = (ms) => ({ ...state, conversation: { sessions: { 'chat-a': { turns: [{ by: 'owner', at: new Date(Date.now() - 60_000).toISOString() }, { by: 'gnomon', at: new Date(Date.now() + ms).toISOString() }] } } } })
    expect(filledApp(step, answered(1000), 'chat-a')).toBeUndefined()
    expect(typing(step, 'chat-a')).toBeNull()
    expect(filledApp(step, answered(-30_000), 'chat-a')).toBe('Pages')
  })

  it('steps sent as a JSON string of a list of steps run as the list; any other string is refused', async () => {
    const state = { config: { experiments: {} }, marks: { lastLook: { id: notes.id, app: 'Pages', n: 1, tag: 'cd34' } } }
    const steps = [{ role: 'text field', label: 'Title', action: 'set-value', value: 'Lunch' }, { action: 'key', value: 'return' }]
    const want = await planAll({ app: 'Pages', steps }, state, readRow)
    expect(want.error).toBeUndefined()
    for (const sent of [JSON.stringify(steps), JSON.stringify(JSON.stringify(steps))]) expect((await planAll({ app: 'Pages', steps: sent }, state, readRow)).line).toBe(want.line)
    for (const sent of ['x', '[1, 2]', '{"action": "key"}', '[{"action": "key", "value": "return"}']) expect((await planAll({ app: 'Pages', steps: sent }, state, readRow)).error).toMatch(/^invalid arguments: steps is a list/)
    // The gate reads the same list: a typing step inside the string is judged in its app.
    expect(callFacts({ toolName: 'screen_act', args: { steps: JSON.stringify([{ app: 'Mail', action: 'type', value: 'Hi' }]) } }).typing).toBe('private')
  })

  it('run 133: steps wrapped in one key are that list, or one step; two keys or the raw markup are refused', async () => {
    const state = { config: { experiments: {} }, marks: { lastLook: { id: notes.id, app: 'Pages', n: 1, tag: 'cd34' } } }
    const steps = [{ ref: 'e1@cd34', action: 'set-value', value: 'Lunch' }, { action: 'key', value: 'return' }]
    const plan = (sent) => planAll(Object.freeze({ app: 'Pages', steps: sent }), state, readRow)
    const want = await plan(steps)
    expect(want.error).toBeUndefined()
    for (const sent of [{ item: steps }, { items: steps }, JSON.stringify({ step: steps })]) expect((await plan(sent)).line).toBe(want.line)
    expect((await plan({ item: steps[0] })).line).toBe((await plan([steps[0]])).line)
    const refused = [{ a: steps, b: steps }, { item: 'x' }, ']<]minimax[>[<item>]<]minimax[>[<action>open]<]minimax[>[</action>']
    for (const sent of refused) expect((await plan(sent)).error).toMatch(/^invalid arguments: steps is a list/)
    expect(callFacts({ toolName: 'screen_act', args: { steps: { item: [{ app: 'Mail', action: 'type', value: 'Hi' }] } } }).typing).toBe('private')
  })

  it('a press or click by a role alone names no one thing: refused, never the first button (run 193 T14 pressed Zen\'s Back)', async () => {
    const none = async () => null
    for (const args of [{ app: 'Zen', action: 'press', role: 'button', value: 'Start order' }, { app: 'Zen', role: 'button' }, { app: 'Zen', action: 'click', role: 'link' }])
      expect((await actPlan(args, {}, none)).error, JSON.stringify(args)).toMatch(/^invalid arguments: .*a role alone names no one thing: give its words as label/)
    expect((await actPlan({ app: 'Zen', action: 'press', role: 'button', label: 'Start order' }, {}, none)).line).toBe('Press "Start order" in Zen')
    expect((await actPlan({ app: 'Zen', action: 'press', text: 'Start order' }, {}, none)).error).toBeUndefined()
  })

  it('run 193: a wrapper inside a wrapper, or the list inside a list, is that list (it ran as a bare open, six times)', async () => {
    const state = { config: { experiments: {} }, marks: { lastLook: { id: notes.id, app: 'Pages', n: 1, tag: 'cd34' } } }
    const steps = [{ ref: 'e1@cd34', action: 'set-value', value: 'Lunch' }, { action: 'key', value: 'return' }]
    const plan = (sent) => planAll(Object.freeze({ app: 'Pages', steps: sent }), state, readRow)
    const want = await plan(steps)
    for (const sent of [{ item: { item: steps } }, [steps], { item: [steps] }]) expect((await plan(sent)).line).toBe(want.line)
    expect((await plan({ item: { item: steps[0] } })).line).toBe((await plan([steps[0]])).line)
    expect(callFacts({ toolName: 'screen_act', args: { steps: { item: { item: { app: 'Mail', action: 'type', value: 'Hi' } } } } }).typing).toBe('private')
    expect((await plan([steps, steps])).error).toMatch(/^invalid arguments: steps is a list/)
  })
})
