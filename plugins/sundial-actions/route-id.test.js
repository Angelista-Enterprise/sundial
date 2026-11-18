// Set 5 2A: a route is known by a short stable id and named places, never by an earlier run's goal and values.
// Every value is made up.
import { readFileSync } from 'node:fs'
import { isRouteId, learned, routeIdOf, routeKeyOf, routeName, routesOf, slotsOf, stepCall } from '@sundial/helpers/screen-routes.js'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { keptKeys, routeById, routeReplay, slotValues } from './screen-pick.js'
import { screenAsk, screenTools } from './screen-tools.js'
import { skillTool } from './skill.js'

const { type: _t, at: _a, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog({ ...LINE, app: 'Zen' })

/** Runs 218 to 226 (T27), made up: each run's goal kept its own subject, as the record holds it after ingest. */
const draft = (session, subject) => ['type', 'type', 'type', 'press'].map((verb, i) => ({
  at: `2026-11-1${session.length}T09:00:0${i}Z`, session, goal: `start a new message to [email] with the subject ${subject}, then`, processName: 'Zen', verb, ok: true, changed: true,
  ...[{ role: 'text field', screenText: ['To'], typed: 16 }, { role: 'text field', screenText: ['Subject'], typed: subject.length }, { role: 'text area', screenText: ['Message'], typed: 9 }, { role: 'button', screenText: ['Discard'] }][i],
}))
const ROWS = [...draft('s1', 'kestrel 214'), ...draft('s22', 'juniper 220'), ...draft('s333', 'skill run224')]
const ID = routeIdOf('Zen', routesOf(ROWS)[0].steps)
const WANT = [
  { action: 'type', role: 'text field', label: 'To', value: 'mira@example.org' },
  { action: 'type', role: 'text field', label: 'Subject', value: 'Lantern 9' },
  { action: 'type', role: 'text area', label: 'Message', value: 'See you.' },
  { action: 'press', role: 'button', label: 'Discard' },
]

/** screen_act over a fake app that does every act, and the replay wired as index.js wires it. */
function tools(rows = ROWS) {
  const signals = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Zen', n: 4 } } }
  const send = (command) => {
    if (command.type !== 'act') return
    state.marks.lastAct = { id: command.id, outcome: 'performed' }
    looks[`look-after-${command.id}`] = { ...ROW, id: `look-after-${command.id}`, after: command.id, windowTitle: `Draft ${command.id}` }
    state.marks.lastLook = { id: `look-after-${command.id}`, after: command.id, app: 'Zen', n: 4 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const readSteps = async (app) => rows.filter((r) => r.processName === app)
  const appendSignal = async (type, payload) => signals.push({ type, ...payload })
  const route = routeReplay({ judge: async () => null, readSteps })
  const [, , act] = screenTools(appendSignal, () => state, send, readRow, async () => [], { route })
  const exec = { callId: 'c1', agent: { session: { id: 'own', snapshotEvents: () => [] } } }
  const calls = []
  const execute = async (req) => {
    calls.push(req)
    const plan = await screenAsk('screen_act', req.arguments, state, readRow, route, [], 'own')
    if (plan.error) return { isError: true, error: { message: plan.error } }
    return { content: [{ type: 'text', text: await act.execute(req.arguments, req) }] }
  }
  const skill = skillTool({ tools: { execute }, getState: () => state, readSteps, appendSignal })
  return { act, exec, signals, calls, skill, ask: (args) => screenAsk('screen_act', args, state, readRow, route, [], 'own') }
}

describe('route ids and named places (Set 5 2A)', () => {
  it('an id is the app and the steps, whatever the goal: stable across runs, other in another app', () => {
    expect(isRouteId(ID)).toBe(true)
    expect(routeIdOf('zen ', routesOf(draft('s1', 'kestrel 214'))[0].steps)).toBe(ID)
    expect(routeIdOf('Notes', routesOf(ROWS)[0].steps)).not.toBe(ID)
    expect(isRouteId('reset')).toBe(false)
    expect(slotsOf(routesOf(ROWS)[0].steps)).toEqual(['To', 'Subject', 'Message'])
    expect(slotsOf([{ verb: 'type', role: 'text area', screenText: ['Body'], typed: 3 }, { verb: 'key' }, { verb: 'type', role: 'text area', screenText: ['Body'], typed: 4 }, { verb: 'type', role: 'text field', screenText: [''], typed: 2 }])).toEqual(['Body', 'Body 2', 'text field'])
  })

  it('the list prints the id, a name and the places, and no value of any earlier run', () => {
    const text = learned(ROWS, 'Zen')
    expect(text.split('\n')[1]).toBe(`- ${ID}: start a new message (To, Subject, Message), worked 3 times: type To > type Subject > type Message > press "Discard"`)
    expect(text).toContain('gnomon_skill {"app":"Zen","route":"<id>","values":{"<place>":"<its text>"}}')
    expect(text).not.toMatch(/kestrel|juniper|run224|214|\[email\]|<what/i)
    // A goal that is all values, or none, is named by its first step.
    expect(routeName({ goal: 'compute 43 times 50 plus 450', steps: [] })).toBe('compute')
    expect(routeName({ goal: '[email] draft', steps: [{ verb: 'press', screenText: ['New Message'] }] })).toBe('press "New Message"')
    expect(routeName({ goal: null, steps: [{ verb: 'raise', screenText: ['Re: Lantern 9'] }] })).toBe('raise')
  })

  it('values by name fill the places in the route\'s order, case and wrappers aside; a list in order too', () => {
    const slots = ['To', 'Subject', 'Message']
    const by = { message: 'See you.', 'Subject:': 'Lantern 9', TO: 'mira@example.org' }
    expect(routeById({ app: 'Zen', id: ID, values: by, rows: ROWS })).toMatchObject({ steps: WANT, id: ID, name: 'start a new message', by: 'id', n: 3 })
    for (const sent of [{ values: by }, [by], JSON.stringify(by), ['mira@example.org', 'Lantern 9', 'See you.'], { item: ['mira@example.org', 'Lantern 9', 'See you.'] }])
      expect(slotValues(sent, slots), JSON.stringify(sent)).toEqual({ list: ['mira@example.org', 'Lantern 9', 'See you.'] })
    expect(slotValues({ text: 'Lantern 9' }, ['Search'])).toEqual({ list: ['Lantern 9'] })
  })

  it('a list or an object as one place\'s value, an unknown place or a missing one is refused, saying what to send', () => {
    const shape = '"values": {"To": "<its text>", "Subject": "<its text>", "Message": "<its text>"}'
    const err = (values) => routeById({ app: 'Zen', id: ID, values, rows: ROWS }).error
    expect(err({ To: ['mira@example.org'], Subject: 'x', Message: 'y' })).toBe(`invalid arguments: the route ${ID} (start a new message): the value of "To" is a list: send one text per place: ${shape}`)
    expect(err({ To: { address: 'mira@example.org' }, Subject: 'x', Message: 'y' })).toMatch(/the value of "To" is an object: send one text per place/)
    expect(err({ To: 'a', Cc: 'b', Subject: 'x', Message: 'y' })).toBe(`invalid arguments: the route ${ID} (start a new message): no place "Cc" in this route; its places: "To", "Subject", "Message": send ${shape}`)
    expect(err({ To: 'a', Subject: 'x' })).toBe(`invalid arguments: the route ${ID} (start a new message): no text for "Message": send ${shape}`)
    expect(err([['a', 'b'], ['c']])).toMatch(/the values hold a list or an object inside a list: send one text per place, by name/)
    expect(routeById({ app: 'Zen', id: 'r00000', values: {}, rows: ROWS }).error).toBe(`no route "r00000" in Zen (its routes: ${ID}: start a new message (To, Subject, Message), worked 3 times: type To > type Subject > type Message > press "Discard"): look (screen_look), then act`)
    expect(routeById({ app: 'Messages', id: ID, values: {}, rows: ROWS }).error).toMatch(/^refused: Messages is a private app/)
  })

  it('Review S5R1 L6: two routes that share an id are refused with both lines, so the model picks one by its goal', () => {
    // "Crate 199" and "Crate 230" in Zen hash to one id (found by search; made-up labels).
    const press = (session, label, i) => ({ at: `2026-11-1${i}T09:00:00Z`, session, goal: `press ${label.toLowerCase()}`, processName: 'Zen', verb: 'press', ok: true, changed: true, role: 'button', screenText: [label] })
    const rows = [press('s1', 'Crate 199', 1), press('s2', 'Crate 199', 2), press('s3', 'Crate 230', 3), press('s4', 'Crate 230', 4)]
    const [a, b] = routesOf(rows)
    const id = routeIdOf('Zen', a.steps)
    expect(routeIdOf('Zen', b.steps)).toBe(id)
    const { error } = routeById({ app: 'Zen', id, values: {}, rows })
    expect(error).toMatch(new RegExp(`^refused: two routes in Zen share the id ${id}: `))
    expect(error).toContain('press "Crate 199"')
    expect(error).toContain('press "Crate 230"')
    expect(error).toContain('"route":true,"goal":')
    // One of them alone still runs by its id.
    expect(routeById({ app: 'Zen', id, values: {}, rows: rows.slice(0, 2) })).toMatchObject({ steps: [{ action: 'press', role: 'button', label: 'Crate 199' }] })
  })

  it('Set 5 R1: by id a route replays after 2 clean runs, or as a routeWorks fact, or as a skill the owner kept; once is refused', () => {
    const once = draft('s1', 'kestrel 214')
    const twice = [...once, ...draft('s22', 'juniper 220')]
    const [r1] = routesOf(once)
    const id = routeIdOf('Zen', r1.steps)
    const values = ['mira@example.org', 'Lantern 9', 'See you.']
    expect(routeById({ app: 'Zen', id, values, rows: once }).error).toBe(`the route ${id} (start a new message) in Zen ran clean only once: by id it replays after 2 clean runs. Do its steps yourself this time, with this task's values (look, then act): ${id}: start a new message (To, Subject, Message), worked once: do its steps yourself, by id after 2 runs: type To > type Subject > type Message > press "Discard"`)
    expect(routeById({ app: 'Zen', id, values, rows: twice })).toMatchObject({ steps: WANT, n: 2 })
    expect(routeById({ app: 'Zen', id, values, rows: once, works: [routeKeyOf(r1.steps)] })).toMatchObject({ steps: WANT, n: 1 })
    expect(routeById({ app: 'Zen', id, values, rows: once, kept: [routeKeyOf(r1.steps)] })).toMatchObject({ steps: WANT, n: 1 })
    // Wired: screen_act and gnomon_skill read the chat's kept skills (the owner's in the owner's chat) and the app's facts.
    const state = { selfReview: { skills: { 'start a new message to [email] with the subject kestrel 214, then': { app: 'zen', routeKey: routeKeyOf(r1.steps) } } } }
    expect(keptKeys(state, 'own', 'Zen')).toEqual([routeKeyOf(r1.steps)])
    expect(keptKeys({ ...state, rigSessions: { own: 'x' } }, 'own', 'Zen')).toEqual([])
  })

  it('gnomon_skill {app, route, values} runs the steps as one screen_act, under the route\'s own goal, counted by id', async () => {
    const t = tools()
    const out = await t.skill.execute({ app: 'Zen', route: ID, values: { To: 'mira@example.org', Subject: 'Lantern 9', Message: 'See you.' } }, t.exec)
    expect(out).toMatch(new RegExp(`^Replayed the route ${ID} \\(start a new message\\) learned in Zen \\(3 clean runs before\\), 4 steps\\.`))
    expect(t.calls[0].arguments).toMatchObject({ app: 'Zen', steps: WANT, goal: 'start a new message to [email] with the subject Lantern 9, then' })
    expect(t.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ by: 'id', route: ID, steps: 4, ran: 4, stopped: false })
    await expect(t.skill.execute({ route: ID, values: {} }, t.exec)).rejects.toThrow(`invalid arguments: the route ${ID} needs the app it was learned in`)
  })

  it('screen_act {route: true} goes by id first; the sentence match is the fallback, and each replay row says which', async () => {
    const t = tools()
    const values = { To: 'mira@example.org', Subject: 'Lantern 9', Message: 'See you.' }
    expect((await t.ask({ app: 'Zen', route: true, goal: ID, values })).replay).toEqual(WANT)
    await t.act.execute({ app: 'Zen', route: true, goal: ID, values }, t.exec)
    await t.act.execute({ app: 'Zen', route: true, goal: 'Start a new message to mira@example.org with the subject Lantern 9, then', values: ['mira@example.org', 'Lantern 9', 'See you.'] }, t.exec)
    expect(t.signals.filter((s) => s.type === 'screen:replayed').map((s) => s.by)).toEqual(['id', 'goal'])
    // The run a replay by id sent is that route's own steps: it teaches nothing new, so no route is named by the id.
    const rows = [...ROWS, ...t.signals.filter((s) => s.type === 'screen:step').map((s, i) => ({ ...s, at: `2026-11-20T09:00:0${i}Z` }))]
    expect(routesOf(rows).map((r) => r.goal)).not.toContain(ID)
  })

  it('Set 5 R1: screen_act {route: "<id>"} replays it, its steps kept under the route\'s own goal (never the id), and the schema takes an id or true', async () => {
    const t = tools()
    const values = { To: 'mira@example.org', Subject: 'Lantern 9', Message: 'See you.' }
    for (const route of [ID, true]) expect(validateJsonSchemaValue(t.act.parameters, { app: 'Zen', route, goal: ID, values }, '')).toEqual([])
    expect((await t.ask({ app: 'Zen', route: ID, values })).replay).toEqual(WANT)
    expect(await t.act.execute({ app: 'Zen', route: ID, values }, t.exec)).toMatch(new RegExp(`^Replayed the route ${ID} \\(start a new message\\)`))
    await t.act.execute({ app: 'Zen', route: true, goal: ID, values }, t.exec)
    const goals = t.signals.filter((s) => s.type === 'screen:step').map((s) => s.goal)
    expect(goals).toHaveLength(8)
    expect(new Set(goals)).toEqual(new Set(['start a new message to [email] with the subject lantern 9, then']))
    expect(t.signals.filter((s) => s.type === 'screen:replayed').map((s) => [s.by, s.route])).toEqual([['id', ID], ['id', ID]])
    // So the replays count as a run of the route (two in one chat under one goal are one run): learned on, not dropped as an id's.
    const rows = [...ROWS, ...t.signals.filter((s) => s.type === 'screen:step').map((s, i) => ({ ...s, at: `2026-11-20T09:00:0${i}Z` }))]
    expect(routesOf(rows)[0]).toMatchObject({ n: 4 })
    // An id that names no route here is refused by id, with the routes the app has.
    await expect(t.act.execute({ app: 'Zen', route: 'r00000', values }, t.exec)).rejects.toThrow(/^no route "r00000" in Zen \(its routes: /)
  })
})

describe('a route as the list prints it and a replay sends it (S5R1)', () => {
  const rows = (verbs) => ['s1', 's22'].flatMap((session) => verbs.map((v, i) => ({ at: `2026-11-1${session.length}T09:00:0${i}Z`, session, goal: 'file the plan', processName: 'Zen', ok: true, changed: true, ...v })))
  it('review L5: a row, a cell or a menu item is named by its role, a button or a field by its words', () => {
    const r = rows([{ verb: 'press', role: 'row', screenText: ['Mira Bakker, Lunch Thursday'] }, { verb: 'press', role: 'cell', screenText: ['BOX-484'] }, { verb: 'pick-menu', screenText: ['File > Open Recent > kettle plan'] }, { verb: 'press', role: 'menu item', screenText: ['puzzlebox-studio'] }, { verb: 'press', role: 'button', screenText: ['Share'] }, { verb: 'focus', role: 'text field', screenText: ['Title'] }])
    const text = learned(r, 'Zen')
    expect(text.split('\n')[1]).toMatch(/: press row > press cell > pick-menu a menu item > press menu item > press "Share" > focus "Title"$/)
    expect(text).not.toMatch(/Mira|BOX-484|kettle|puzzlebox/)
  })
  it('gap 3: a learned key on a thing replays on that thing by its role and words; a bare key, a ref or a hidden name stays a bare key', () => {
    expect(stepCall({ verb: 'key', key: 'return', role: 'button', screenText: ['Send'] })).toEqual({ action: 'key', value: 'return', role: 'button', label: 'Send' })
    expect(stepCall({ verb: 'key', key: 'return', role: 'text area', screenText: ['Message #kettle-room'] })).toEqual({ action: 'key', value: 'return', role: 'text area', label: 'Message #kettle-room' })
    for (const row of [{ screenText: [''] }, { role: 'button', screenText: ['e31'] }, { role: 'button', screenText: ['[private]'] }, { screenText: ['Send'] }]) expect(stepCall({ verb: 'key', key: 'return', ...row })).toEqual({ action: 'key', value: 'return' })
  })
})
