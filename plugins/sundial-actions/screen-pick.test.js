import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { lookOf } from './screen-look.js'
import { JEV, KEYS, PICK_QUESTIONS, ROUTE_QUESTIONS, changesOf, fastSteps, keptGoal, pickIn, poolOf, requestOf, routeFor, routeReplay, spansOf, tier0 } from './screen-pick.js'
import { screenAsk, screenTools } from './screen-tools.js'

/** The sample look (doc 16, B2), made-up values: e1 button "New Note", e7 search field "Search" (focused), e9 a row, t1 text. */
// Notes is private by name since 2026-11-17 (privateAppName): the sample look is read as a Pages window.
const { type: _t, at: _a, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8').replace(/\bNotes\b/g, 'Pages'))
const ROW = lookForLog(LINE)
const LOOK = lookOf(ROW)
const button = (ref, label, more = {}) => ({ ref, role: 'AXButton', sub: '', label, value: '', frame: [Number(ref.slice(1)) * 40, 10, 30, 20], actions: ['AXPress'], settable: false, enabled: true, in: 'toolbar', ...more })
const withThings = (...things) => ({ ...LOOK, id: 'look-5e6f7a8b', elements: [...LOOK.elements, ...things] })
const answer = (key, p, didIt) => ({ target: { choice: key, probabilities: { [key]: p, none: 1 - p } }, ...(didIt === undefined ? {} : { did_it: { noul: didIt } }) })

describe('tier 0: code picks only one exact name', () => {
  it('role and label, or the label alone when only one thing has it, among the things that take the verb', () => {
    expect(tier0(LOOK.elements, 'New Note button', 'press')?.ref).toBe('e1')
    expect(tier0(LOOK.elements, 'button new note', undefined)?.ref).toBe('e1')
    expect(tier0(LOOK.elements, 'Search', 'set-value')?.ref).toBe('e7')
    expect(tier0(LOOK.elements, 'Search', 'press')).toBeNull()
    expect(tier0(LOOK.elements, 'the new note thing', 'press')).toBeNull()
    // Two alike: no pick, unless the role tells them apart.
    const two = withThings(button('e20', 'New Note'), { ...button('e21', 'New Note'), role: 'AXMenuItem' }).elements
    expect(tier0(two, 'New Note', 'press')).toBeNull()
    expect(tier0(two, 'New Note menu item', 'press')?.ref).toBe('e21')
  })
})

describe('the pool Jev would choose among', () => {
  it('the keyboard first, then what is new since the look before, then by the words; at most 16; no hidden names', () => {
    const before = withThings(...Array.from({ length: 20 }, (_, i) => button(`e${30 + i}`, `Tool ${i}`)))
    const now = { ...before, elements: [...before.elements, button('e60', 'Share'), button('e61', '[private]')] }
    const pool = poolOf(now, before, 'tool 3', undefined)
    expect(pool.map((e) => e.ref).slice(0, 3)).toEqual(['e7', 'e60', 'e33'])
    expect(pool).toHaveLength(KEYS)
    expect(pool.some((e) => e.ref === 'e61')).toBe(false)
  })

  it('what changed is told by role and label, never by value', () => {
    const after = { ...LOOK, window: 'New Note', elements: LOOK.elements.map((e) => (e.ref === 'e7' ? { ...e, value: 'Pages for BOX-484' } : e)) }
    const lines = changesOf(LOOK, after)
    expect(lines).toEqual(['window: now "New Note"', 'value changed: search field "Search"'])
    expect(lines.join('\n')).not.toMatch(/BOX-484/)
  })
})

describe('pickIn', () => {
  const run = (o) => {
    const signals = []
    const append = async (type, payload) => signals.push({ type, ...payload })
    return pickIn({ look: LOOK, before: null, verb: 'press', state: {}, appendSignal: append, ...o }).then((out) => ({ out, signals }))
  }

  it('tier 0 needs no judge, and every pick is logged by ref, never by value', async () => {
    const { out, signals } = await run({ find: 'New Note' })
    expect(out).toMatchObject({ tier: 0, p: 1, element: { ref: 'e1' } })
    expect(signals).toEqual([{ type: 'screen:picked', look: LOOK.id, ref: 'e1', tier: 0, p: 1, k: 1, qid: 'screen-pick:exact', acted: true, processName: 'Pages', role: 'button', screenText: ['New Note'] }])
  })

  it('no judge: a name that is not exact goes back to the chat model with the short look', async () => {
    const { out, signals } = await run({ find: 'the compose thing' })
    expect(out.miss).toMatch(/^no one thing here is named "the compose thing": act on a ref from this look\.\nRead off the screen/)
    expect(signals).toEqual([])
  })

  it('Jev acts only at the threshold, reads role, label, section and verbs, and its pick is logged either way', async () => {
    const judge = vi.fn(async () => answer('c2', 0.97))
    const { out, signals } = await run({ find: 'the first note in the list', judge })
    const [state, questions] = judge.mock.calls[0]
    expect(Object.keys(questions)).toEqual(['target'])
    expect(questions.target).toBe(PICK_QUESTIONS.target)
    expect(Object.keys(questions.target.criteria)).toHaveLength(KEYS + 1)
    expect(Object.values(state.candidates).every((c) => Object.keys(c).every((k) => ['role', 'label', 'section', 'verbs'].includes(k)))).toBe(true)
    expect(out).toMatchObject({ tier: 1, p: 0.97, element: { ref: state.candidates.c2 && LOOK.elements.find((e) => e.label === state.candidates.c2.label).ref } })
    expect(signals[0]).toMatchObject({ tier: 1, qid: 'screen-pick:target', acted: true })
    const low = await run({ find: 'the first note in the list', judge: async () => answer('c2', 0.8) })
    expect(low.out.miss).toMatch(/^not sure which thing is/)
    expect(low.signals[0]).toMatchObject({ tier: 1, p: 0.8, acted: false })
  })

  it('an outward word is never Jev\'s: not in the find, not on the thing it picked', async () => {
    const judge = vi.fn(async () => answer('c1', 0.99))
    expect((await run({ find: 'the send arrow', judge })).out.miss).toMatch(/reaches past the screen/)
    expect(judge).not.toHaveBeenCalled()
    const look = withThings(button('e40', 'Submit order'))
    const { out } = await run({ look, find: 'the big blue one', judge: async () => answer(`c${poolOf(look, null, 'the big blue one', 'press').findIndex((e) => e.ref === 'e40') + 1}`, 0.99) })
    expect(out.miss).toBeDefined()
  })

  it('did_it rides on the pick call; a confident no is a doubt', async () => {
    const judge = vi.fn(async () => answer('c1', 0.99, 0.1))
    const { out } = await run({ find: 'the first note', judge, carry: { because: 'Open the note', changes: ['window: now "x"'] } })
    expect(Object.keys(judge.mock.calls[0][1])).toEqual(['target', 'did_it'])
    expect(judge.mock.calls[0][0]).toMatchObject({ because: 'Open the note', changes: ['window: now "x"'] })
    expect(out.didIt).toBe(0.1)
  })
})

describe('fastSteps, the screen_act side', () => {
  const plan = (find, verb = 'press') => ({ verb, app: 'Pages', find, fast: { verb }, thing: { name: find }, because: `${verb} ${JSON.stringify(find)} in Pages`, line: '', command: { find, action: verb } })
  const hooks = (o = {}) => fastSteps({ getState: () => ({ marks: { lastLook: { id: ROW.id, app: 'Pages', n: 4 } } }), readLook: async (id) => (id === ROW.id ? ROW : null), appendSignal: async () => {}, look: async () => null, ...o })

  it('Jev is off as shipped: the bench missed the bar', () => {
    expect(JEV).toBe(false)
  })

  it('a find becomes a ref of the newest look; the line names the thing picked', async () => {
    const out = await hooks().resolve(plan('New Note button'))
    expect(out.plan.command).toEqual({ action: 'AXPress', look: ROW.id, ref: 'e1' })
    expect(out.plan.because).toBe('press "New Note" in Pages')
    expect(out.tier).toBe(0)
  })

  it('a private app or no look is a miss; with Jev off nothing is asked, not even did_it', async () => {
    const judge = vi.fn()
    const off = hooks({ judge, getState: () => ({ marks: { lastLook: { id: 'look-x', app: '[private]', refused: 'private app' } } }), look: async () => ({ id: 'look-y', app: 'Mail', refused: 'private app' }) })
    expect((await off.resolve({ ...plan('Send'), app: 'Mail' })).miss).toMatch(/no look of Mail/)
    expect(await hooks({ judge }).check({ id: ROW.id }, { id: ROW.id }, 'x')).toEqual({})
    expect(judge).not.toHaveBeenCalled()
  })

  it('a find that picks a menu item whose submenu is open is a miss (runs 42, 50, 57)', async () => {
    const item = (ref, label, within) => ({ ref, role: 'AXMenuItem', sub: '', screenText: [label, '', within], frame: [184, 45, 262, 24], actions: ['AXPress'], settable: false, enabled: true })
    const open = { ...ROW, screenText: ['View'], elements: [item('e1', 'Sort By', 'View'), item('e2', 'Size', 'Sort By')] }
    const out = await hooks({ readLook: async (id) => (id === ROW.id ? open : null) }).resolve(plan('Sort By menu item'))
    expect(out.miss).toMatch(/^refused: "View > Sort By" opens a submenu[^]*\{"app":"Pages","action":"pick-menu","value":"View > Sort By > Size"\}/)
  })

  it('a pick that lands on a final the find did not name is a miss: it was never asked as one (review 2026-11-15)', async () => {
    const row = lookForLog({ ...LINE, id: 'look-5e6f7a8c', elements: [...LINE.elements, button('e40', 'Remove')] })
    const key = `c${poolOf(lookOf(row), null, 'the first one', 'press').findIndex((e) => e.ref === 'e40') + 1}`
    const fast = hooks({ judge: vi.fn(async () => answer(key, 0.99)), jev: true, getState: () => ({ marks: { lastLook: { id: row.id, app: 'Pages', n: 5 } } }), readLook: async (id) => (id === row.id ? row : null) })
    expect((await fast.resolve(plan('the first one'))).miss).toMatch(/^refused: the thing picked for "the first one" is "Remove", a step that cannot be taken back/)
    // Named in the find, the gate asked about it: the pick goes ahead.
    expect((await fast.resolve(plan('Remove button'))).plan?.thing.name).toBe('Remove')
  })

  it('with Jev on, a doubt about the step before stops the next one', async () => {
    const judge = vi.fn(async () => answer('c1', 0.99, 0.05))
    const out = await hooks({ judge, jev: true }).resolve(plan('New Note'), { because: 'Open it', changes: ['window: now "x"'] })
    expect(out).toMatchObject({ doubt: true })
    expect(out.miss).toMatch(/^the step before ran, but/)
  })
})

describe('route replay (experiments.screenFastRoutes)', () => {
  const rows = [
    { at: '2026-03-10T09:00:00Z', session: 's1', goal: 'queue giant steps', processName: 'Spotify', verb: 'set-value', role: 'search field', screenText: ['Search'], typed: 11, ok: true, changed: true },
    { at: '2026-03-10T09:00:05Z', session: 's1', goal: 'queue giant steps', processName: 'Spotify', verb: 'show-menu', role: 'row', screenText: ['Giant Steps'], ok: true, changed: true },
    { at: '2026-03-10T09:00:09Z', session: 's1', goal: 'queue giant steps', processName: 'Spotify', verb: 'press', role: 'menu item', screenText: ['Add to queue'], ok: true, changed: true },
  ]
  const judgeFor = (spans, word, p = 0.97) => vi.fn(async (state) => ({ match: { choice: 'r1', probabilities: { r1: p } }, r1b1: { choice: Object.entries(state.spans).find(([, s]) => s === word)?.[0] ?? 'none', probabilities: { s1: p } } }))

  it('the route the request asks for, its blank filled from the owner\'s words, as the steps of one call', async () => {
    const judge = judgeFor(null, 'Naima')
    const out = await routeFor({ app: 'Spotify', request: 'can you queue Naima by Coltrane', rows, judge, state: {} })
    const [state, questions] = judge.mock.calls[0]
    expect(Object.keys(questions)).toEqual(['match', 'r1b1'])
    expect(questions.match).toBe(ROUTE_QUESTIONS.match)
    expect(state.routes).toEqual({ r1: 'queue <what was typed>' })
    expect(Object.values(state.spans)).not.toContain('queue')
    expect(out.goal).toBe('queue Naima')
    expect(out.steps).toEqual([{ action: 'set-value', role: 'search field', label: 'Search', value: 'Naima' }, { action: 'show-menu', role: 'row', label: 'Naima' }, { action: 'press', role: 'menu item', label: 'Add to queue' }])
  })

  it('below the threshold, in a private app, or with an outward word: no route', async () => {
    expect(await routeFor({ app: 'Spotify', request: 'queue Naima', rows, judge: judgeFor(null, 'Naima', 0.8), state: {} })).toBeNull()
    expect(await routeFor({ app: 'Messages', request: 'queue Naima', rows, judge: judgeFor(null, 'Naima'), state: {} })).toBeNull()
    const sending = rows.map((r, i) => (i === 2 ? { ...r, screenText: ['Send'] } : r))
    expect(await routeFor({ app: 'Spotify', request: 'queue Naima', rows: sending, judge: judgeFor(null, 'Naima'), state: {} })).toBeNull()
  })

  it('S5R1: a plain Return in a chat app, or a final word the gate knows (Archive, Share, Approve), is outward: no route', async () => {
    const chat = [rows[0], { ...rows[1], verb: 'key', key: 'return', role: 'text area', screenText: ['Message #general'] }].map((r) => ({ ...r, processName: 'Slack', goal: 'say giant steps' }))
    expect(await routeFor({ app: 'Slack', request: 'say Naima', rows: chat, judge: judgeFor(null, 'Naima'), state: {} })).toBeNull()
    // The same Return in a music app presses its search, and replays.
    const music = chat.map((r) => ({ ...r, processName: 'Spotify' }))
    expect(await routeFor({ app: 'Spotify', request: 'say Naima', rows: music, judge: judgeFor(null, 'Naima'), state: {} })).not.toBeNull()
    for (const word of ['Archive', 'Share', 'Approve', 'Leave channel', 'Merge pull request', 'Replace']) {
      const finals = rows.map((r, i) => (i === 2 ? { ...r, screenText: [word] } : r))
      expect(await routeFor({ app: 'Spotify', request: 'queue Naima', rows: finals, judge: judgeFor(null, 'Naima'), state: {} })).toBeNull()
    }
  })

  it('spans skip small words at the edges and the words the route already holds', () => {
    expect(spansOf('please queue Blue in Green, thanks', ['queue'])).toEqual(['Blue', 'Blue in Green', 'Green', 'thanks'])
  })

  it('the request is the owner\'s own last message, past context blocks; a notice-opened turn has none', () => {
    const own = { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'queue Naima' }] } }
    const block = { type: 'user/message', data: { source: { kind: 'user', form: 'place' }, content: 'Brought in' } }
    expect(requestOf([own, block])).toBe('queue Naima')
    expect(requestOf([own, { type: 'user/message', data: { source: { kind: 'notice' }, content: 'x' } }])).toBeNull()
  })
})

describe('screen_act with find (experiments.screenFast)', () => {
  function tools(experiments = { screenFast: true }, fast = {}) {
    const signals = []
    const sent = []
    const rows = { [ROW.id]: ROW }
    const state = { config: { experiments }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', n: 4 } } }
    const send = (command) => {
      sent.push(command)
      if (command.type !== 'act') return
      state.marks.lastAct = { id: command.id, outcome: 'performed' }
      rows[`look-after-${command.id}`] = { ...ROW, id: `look-after-${command.id}`, after: command.id, windowTitle: 'New Note' }
      state.marks.lastLook = { id: `look-after-${command.id}`, after: command.id, app: 'Pages', n: 4 }
    }
    const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((row) => row[field] === id) ?? null
    const [, , act] = screenTools(async (type, payload) => signals.push({ type, ...payload }), () => state, send, readRow, async () => [], fast)
    return { act, signals, sent, state, readRow }
  }

  it('the step acts on the ref code picked from the newest look, logs the pick, and the owner was asked with the find', async () => {
    const t = tools()
    expect(await screenAsk('screen_act', { app: 'Pages', find: 'New Note button', action: 'press' }, t.state, t.readRow)).toMatchObject({ line: 'Press "New Note button" in Pages' })
    const out = await t.act.execute({ app: 'Pages', find: 'New Note button', action: 'press', because: 'Start a note' })
    expect(t.sent[0]).toMatchObject({ type: 'act', look: ROW.id, ref: 'e1', action: 'AXPress', because: 'Start a note' })
    expect(t.signals.map((s) => s.type)).toEqual(['screen:picked', 'screen:step'])
    expect(t.signals[1]).toMatchObject({ verb: 'press', role: 'button', screenText: ['New Note'], ok: true })
    expect(out).toMatch(/^Done \(press\)/)
  })

  it('a name that is not exact comes back with the short look, and nothing is pressed', async () => {
    const t = tools()
    await expect(t.act.execute({ app: 'Pages', find: 'the compose thing', action: 'press' })).rejects.toThrow(/no one thing here is named "the compose thing": act on a ref from this look\.\nRead off the screen/)
    expect(t.sent.filter((c) => c.type === 'act')).toEqual([])
  })

  it('steps by find run in order, each on the newest look', async () => {
    const t = tools()
    const out = await t.act.execute({ app: 'Pages', steps: [{ find: 'New Note', action: 'press' }, { find: 'Search', action: 'set-value', value: 'lunch' }] })
    expect(t.sent.filter((c) => c.type === 'act').map((c) => [c.look, c.ref])).toEqual([[ROW.id, 'e1'], [`look-after-${t.sent[0].id}`, 'e7']])
    expect(out).toMatch(/^1\. Press "New Note" in Pages: done\n2\. Set-value "Search" in Pages: "lunch": /)
  })

  it('off: find is refused before the ask; route replay with no proven route and no switch asks Jev nothing', async () => {
    const t = tools({})
    expect((await screenAsk('screen_act', { app: 'Pages', find: 'New Note' }, t.state, t.readRow)).error).toMatch(/find is off \(experiments\.screenFast\)/)
    const judge = vi.fn()
    const route = routeReplay({ judge, readSteps: async () => [] })
    expect((await screenAsk('screen_act', { app: 'Pages', goal: 'new note', route: true }, t.state, t.readRow, route, [])).error).toMatch(/^no route learned in Pages replays for "new note": look/)
    expect(judge).not.toHaveBeenCalled()
  })

  it('a replayed route: the owner reads its steps, and the same steps run', async () => {
    const judge = vi.fn(async () => ({ match: { choice: 'r1', probabilities: { r1: 0.99 } } }))
    const rows = [{ at: '2026-03-10T09:00:00Z', session: 's1', goal: 'new note', processName: 'Pages', verb: 'press', role: 'button', screenText: ['New Note'], ok: true, changed: true }]
    const route = routeReplay({ judge, readSteps: async () => rows })
    const t = tools({ screenFastRoutes: true }, { route })
    const events = [{ type: 'user/message', data: { source: { kind: 'user' }, content: 'make me a new note' } }]
    expect(await screenAsk('screen_act', { app: 'Pages', route: true }, t.state, t.readRow, route, events, 's2')).toMatchObject({ line: 'Press "New Note" in Pages' })
    await t.act.execute({ app: 'Pages', route: true }, { agent: { session: { id: 's2', snapshotEvents: () => events } } })
    // The last look holds "New Note" once, so the by-name step runs as a press on its ref (acts by name go through the newest look).
    const sent = t.sent.filter((c) => c.type === 'act')[0]
    expect(sent.ref ?? sent.target?.label).toBeTruthy()
    expect(['press', 'AXPress']).toContain(sent.action)
    expect(judge).toHaveBeenCalledTimes(1)
  })
})

describe('keptGoal', () => {
  it('keeps 80 characters and never cuts a word in half (run 218 T27: "Skill run218" was kept as "ski")', () => {
    expect(keptGoal('  Start a new message to mira@example.org with the subject Skill run218  ')).toBe('start a new message to mira@example.org with the subject skill run218')
    const long = 'start a new message to mira.bakker@example.org with the subject Skill run218, then discard it'
    expect(keptGoal(long)).toBe('start a new message to mira.bakker@example.org with the subject skill run218,')
    expect(keptGoal('x'.repeat(90))).toBe('x'.repeat(80))
  })
})
