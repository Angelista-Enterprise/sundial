// Set 2 Round 2 item 5: a route proven on the record replays by its goal shape, with no switch and no model step
// between its steps. Every value is made up.
import { readFileSync } from 'node:fs'
import { routeIdOf, routeKeyOf, routesOf } from '@sundial/helpers/screen-routes.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { describe, expect, it, vi } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { openedTrack } from '../../packages/rules/src/opened-track.ts'
import { callFacts, decideAction, finalOf } from './gate.js'
import { replayRows, routeByShape, routeReplay, shapeMatch } from './screen-pick.js'
import { screenAsk, screenTools } from './screen-tools.js'

const { type: _t, at: _a, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)

/** One clean run per session: press New Note, then type into Search. */
const run = (session, goal = 'new note', app = 'Pages', more = {}) => [
  { at: `2026-11-1${session.length}T09:00:00Z`, session, goal, processName: app, verb: 'press', role: 'button', screenText: ['New Note'], ok: true, changed: true, ...more },
  { at: `2026-11-1${session.length}T09:00:02Z`, session, goal, processName: app, verb: 'set-value', role: 'search field', screenText: ['Search'], typed: 5, ok: true, changed: true, ...more },
]
const THREE = [...run('s1'), ...run('s22'), ...run('s333')]

/** The tools over a fake record; `answers[n]` is what the app says to the nth act. */
function tools({ rows = THREE, state: extra = {}, answers = [], works = [], windows } = {}) {
  const signals = []
  const sent = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', n: 4 } }, ...extra }
  const send = (command) => {
    sent.push(command)
    if (command.type !== 'act') return
    const said = answers[sent.filter((c) => c.type === 'act').length - 1] ?? { outcome: 'performed' }
    state.marks.lastAct = { id: command.id, ...said }
    if (said.outcome !== 'performed') return
    looks[`look-after-${command.id}`] = { ...ROW, id: `look-after-${command.id}`, after: command.id, windowTitle: 'New Note', ...(windows ? { screen: { windows } } : {}) }
    state.marks.lastLook = { id: `look-after-${command.id}`, after: command.id, app: 'Pages', n: 4 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const judge = vi.fn()
  const route = routeReplay({ judge, readSteps: async (app) => rows.filter((r) => r.processName === app), readWorks: async () => works })
  // The runtime's appendSignal, as far as this needs: a `screen:leftover-said` row folds through openedTrack into `state.opened`.
  const append = async (type, payload) => {
    signals.push({ type, ...payload })
    if (type === 'screen:leftover-said') state.opened = openedTrack(state, { type, payload, ts: new Date().toISOString() }).state.opened
  }
  const [, , act] = screenTools(append, () => state, send, readRow, async () => [], { route })
  const ask = (args, session = 'own') => screenAsk('screen_act', args, state, readRow, route, [], session)
  const exec = (session = 'own') => ({ agent: { session: { id: session, snapshotEvents: () => [] } } })
  return { act, ask, exec, signals, sent, state, judge, route }
}

describe('route replay by goal shape (Set 2 R2), no switch', () => {
  it('the goal shape matches case and spacing aside, and gives the typed words', () => {
    expect(shapeMatch('new note', ' New  Note ')).toBe('')
    expect(shapeMatch('queue <what was typed>', 'Queue Blue Train')).toBe('Blue Train')
    expect(shapeMatch('queue <what was typed>', 'queue')).toBeNull()
    expect(shapeMatch('new note', 'new notes')).toBeNull()
  })

  it('a matching goal replays its plain steps in one call: the owner reads them, they run, and a row counts them', async () => {
    const t = tools()
    const args = { app: 'Pages', goal: 'New note', route: true, values: ['lunch'] }
    const asked = await t.ask(args)
    expect(asked.line).toBe('Press "New Note" in Pages; then set-value "Search" in Pages: "lunch"')
    expect(asked.replay).toEqual([{ action: 'press', role: 'button', label: 'New Note' }, { action: 'set-value', role: 'search field', label: 'Search', value: 'lunch' }])
    const out = await t.act.execute(args, t.exec())
    expect(out).toMatch(/^Replayed the route learned in Pages for "new note" \(3 clean runs before\), 2 steps\.\n1\. Press "New Note" in Pages: done\n2\. Set-value "Search" in Pages: "lunch": sent, but nothing on screen changed/)
    expect(t.sent.filter((c) => c.type === 'act')).toHaveLength(2)
    expect(t.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ processName: 'Pages', goal: 'new note', n: 3, steps: 2, ran: 2, stopped: false, session: 'own' })
    expect(t.judge).not.toHaveBeenCalled()
  })

  it('a route\'s typed words in its goal fill its first place; a missing text is asked for by its place', async () => {
    const song = (session, name) => [
      { at: `2026-11-1${session.length}T09:00:00Z`, session, goal: `queue ${name.toLowerCase()}`, processName: 'Spotify', verb: 'set-value', role: 'search field', screenText: ['Search'], typed: name.length, ok: true, changed: true },
      { at: `2026-11-1${session.length}T09:00:02Z`, session, goal: `queue ${name.toLowerCase()}`, processName: 'Spotify', verb: 'press', role: 'button', screenText: [`Play ${name}`], ok: true, changed: true },
    ]
    const rows = [...song('s1', 'Blue Train'), ...song('s22', 'Giant Steps'), ...song('s333', 'So What')]
    expect(routesOf(rows)[0]).toMatchObject({ goal: 'queue <what was typed>', n: 3 })
    expect(routeByShape({ app: 'Spotify', goal: 'queue Naima', rows })).toEqual({ steps: [{ action: 'set-value', role: 'search field', label: 'Search', value: 'Naima' }, { action: 'press', role: 'button', label: 'Play Naima' }], goal: 'queue Naima', key: 'queue <what was typed>', n: 3, by: 'goal' })
    const t = tools()
    expect((await t.ask({ app: 'Pages', goal: 'new note', route: true })).error).toBe('invalid arguments: the route for "new note" types in 1 place ("Search"): send "values": {"Search": "<its text>"}, one text each, taken from this task')
    // Set 5 2A: the miss lists the routes by id, name and place, never an earlier run's goal.
    const id = routeIdOf('Pages', routesOf(THREE)[0].steps)
    expect((await t.ask({ app: 'Pages', goal: 'open a list', route: true, values: ['x'] })).error).toBe(`no route learned in Pages replays for "open a list" (the routes that run here by id: ${id}: new note (Search), worked 3 times: press "New Note" > type Search): run one by its id with gnomon_skill {"app": "Pages", "route": "<id>", "values": {...}}, or look (screen_look), then act`)
  })

  it('no qualifying route, no replay: two clean runs are not enough, a routeWorks fact of the app is', async () => {
    const two = [...run('s1'), ...run('s22')]
    expect((await tools({ rows: two }).ask({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] })).error).toMatch(/^no route learned in Pages replays for "new note" \(the routes that run here by id: r\d{5}: new note \(Search\), worked 2 times: press "New Note" > type Search\): run one by its id with gnomon_skill/)
    const works = [routeKeyOf(routesOf(two)[0].steps)]
    expect(works).toEqual(['press button "New Note" > set-value search field "Search"'])
    expect((await tools({ rows: two, works }).ask({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] })).line).toMatch(/^Press "New Note" in Pages; then set-value/)
  })

  it('the rig\'s routes replay in the rig\'s chats only, never in the owner\'s', async () => {
    const rigSessions = { s1: '2026-11-15T08:00:00Z', s22: '2026-11-15T08:00:00Z', s333: '2026-11-15T08:00:00Z', 'rig-run': '2026-11-15T09:00:00Z' }
    const t = tools({ state: { rigSessions } })
    const args = { app: 'Pages', goal: 'new note', route: true, values: ['lunch'] }
    expect((await t.ask(args, 'own')).error).toMatch(/^no route learned in Pages replays/)
    expect((await t.ask(args, 'rig-run')).line).toMatch(/^Press "New Note" in Pages/)
    // A run on a rig test page is the rig's too, whatever its chat.
    const paged = [...run('s1', 'new note', 'Pages', { windowTitle: 'Testbox' }), ...run('s22'), ...run('s333')]
    expect(routeByShape({ app: 'Pages', goal: 'new note', values: ['x'], rows: replayRows(paged, {}, 'own') }).error).toMatch(/^no route learned/)
  })

  it('rigOnly (a skill\'s replay): a rig chat gets the rig\'s runs only, the owner\'s chat its own as before', () => {
    const state = { rigSessions: { 'rig-run': '2026-11-15T09:00:00Z' } }
    const rows = [...run('s1'), ...run('rig-run'), ...run('s22', 'new note', 'Pages', { windowTitle: 'Testbox' })]
    const sessions = (list) => [...new Set(list.map((r) => r.session))]
    expect(sessions(replayRows(rows, state, 'rig-run', { rigOnly: true }))).toEqual(['rig-run', 's22'])
    expect(sessions(replayRows(rows, state, 'rig-run'))).toEqual(['s1', 'rig-run', 's22'])
    expect(sessions(replayRows(rows, state, 'own', { rigOnly: true }))).toEqual(['s1'])
  })

  it('a private app is refused, whatever its record', async () => {
    const rows = [...run('s1', 'new note', 'Messages'), ...run('s22', 'new note', 'Messages'), ...run('s333', 'new note', 'Messages')]
    expect((await tools({ rows }).ask({ app: 'Messages', goal: 'new note', route: true, values: ['x'] })).error).toMatch(/^refused: Messages is a private app: no route replays there\. Tell the owner/)
  })

  it('a final in the route still asks, test mode and Auto included', async () => {
    const rows = ['s1', 's22', 's333'].map((session) => ({ at: `2026-11-1${session.length}T09:00:00Z`, session, goal: 'clear the list', processName: 'Pages', verb: 'press', role: 'button', screenText: ['Remove'], ok: true, changed: true }))
    const t = tools({ rows })
    const args = { app: 'Pages', goal: 'clear the list', route: true }
    const asked = await t.ask(args)
    expect(asked.replay).toEqual([{ action: 'press', role: 'button', label: 'Remove' }])
    expect(finalOf('screen_act', args, () => null, asked.plans)?.kind).toBe('delete')
    const actions = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }
    const facts = callFacts({ toolName: 'screen_act', args: { ...args, steps: asked.replay }, plans: asked.plans })
    expect(decideAction({ toolName: 'screen_act', args, preset: 'danger-full-access', actions, resolveActionPolicy, testMode: true, facts }).kind).toBe('ask')
  })

  it('runs 191 to 194 (T20): the goal as the record keeps it (cut at 60, lower case, an address as [email]) matches, and a first url step with no address left is left out', () => {
    // The record keeps a goal cut, lower-cased and redacted at ingest: "Kestrel 170" survives as "kes".
    const draft = (session) => ['open', 'focus', 'type', 'focus', 'type', 'press'].map((verb, i) => ({
      at: `2026-11-1${session.length}T09:00:0${i}Z`, session, goal: 'start a new message to [email] with the subject kes', processName: 'Zen', verb, ok: true, changed: true,
      ...[{ screenText: ['http://127.0.0.1:8793'] }, { role: 'text field', screenText: ['To'] }, { role: 'text field', screenText: ['To'], typed: 16 }, { role: 'text field', screenText: ['Subject'] }, { role: 'text field', screenText: ['Subject'], typed: 11 }, { role: 'button', screenText: ['Discard'] }][i],
    }))
    const rows = [...draft('s1'), ...draft('s22'), ...draft('s333')]
    const values = ['mira@example.org', 'Kestrel 170']
    const want = [{ action: 'focus', role: 'text field', label: 'To' }, { action: 'type', role: 'text field', label: 'To', value: 'mira@example.org' }, { action: 'focus', role: 'text field', label: 'Subject' }, { action: 'type', role: 'text field', label: 'Subject', value: 'Kestrel 170' }, { action: 'press', role: 'button', label: 'Discard' }]
    // Run 191: the model's own words for the task. Run 192: the goal as the brief printed it.
    for (const goal of ['Start a new message to mira@example.org with the subject Kestrel 170', 'start a new message to [email] with the subject kes'])
      expect(routeByShape({ app: 'Zen', goal, values, rows }), goal).toMatchObject({ steps: want, n: 3 })
    expect(routeByShape({ app: 'Zen', goal: 'Start a new message to mira@example.org with the subject Juniper 170', values, rows }).error).toMatch(/^no route learned/)
    // Run 207 T23: values one level too deep ({item: [...]}) were refused three times, then the task went by hand.
    const goal = 'start a new message to [email] with the subject kes'
    for (const sent of [{ item: values }, { item: { item: values } }, [values], JSON.stringify({ item: values })])
      expect(routeByShape({ app: 'Zen', goal, values: sent, rows }), JSON.stringify(sent)).toMatchObject({ steps: want, n: 3 })
    // Set 5 2A: values by the places' names, case aside, are read; a shape it cannot read says exactly what to send.
    expect(routeByShape({ app: 'Zen', goal, values: { to: values[0], subject: values[1] }, rows })).toMatchObject({ steps: want, by: 'goal' })
    expect(routeByShape({ app: 'Zen', goal, values: [['a'], ['b']], rows }).error).toBe('invalid arguments: the route for "start a new message to [email] with the subject kes": the values hold a list or an object inside a list: send one text per place, by name: "values": {"To": "<its text>", "Subject": "<its text>"}')
  })

  it('runs 218 to 226 (T27): a subject that shows in no later name is still the typed part, by its length, so three runs make one shape', () => {
    // The goal kept at 80 since run 218 holds each run's own subject; the subject (11 here) shows in no later step's name.
    const draft = (session, subject) => ['type', 'type', 'press'].map((verb, i) => ({
      at: `2026-11-1${session.length}T09:00:0${i}Z`, session, goal: `start a new message to [email] with the subject ${subject}, then`, processName: 'Zen', verb, ok: true, changed: true,
      ...[{ role: 'text field', screenText: ['To'], typed: 16 }, { role: 'text field', screenText: ['Subject'], typed: subject.length }, { role: 'button', screenText: ['Discard'] }][i],
    }))
    const rows = [...draft('s1', 'kestrel 214'), ...draft('s22', 'juniper 220'), ...draft('s333', 'kestrel 224')]
    expect(routesOf(rows)[0]).toMatchObject({ goal: 'start a new message to [email] with the subject <what was typed>, then', n: 3 })
    const want = [{ action: 'type', role: 'text field', label: 'To', value: 'mira@example.org' }, { action: 'type', role: 'text field', label: 'Subject', value: 'Kestrel 226' }, { action: 'press', role: 'button', label: 'Discard' }]
    // The model's own words, and the kept goal of an older run as the brief printed it; values one level deep, as run 226 sent them.
    for (const goal of ['Start a new message to mira@example.org with the subject Kestrel 226, then discard it without sending it', 'start a new message to [email] with the subject kestrel 224, then'])
      expect(routeByShape({ app: 'Zen', goal, values: [['mira@example.org', 'Kestrel 226']], rows }), goal).toMatchObject({ steps: want, n: 3 })
    // Words as long as a value but the same in every run are no typed part ("subject kes" is 11): only another run's goal tells.
    const same = ['s1', 's22', 's333'].flatMap((s) => draft(s, 'kes').map((r) => ({ ...r, goal: 'start a new message to [email] with the subject kes', ...(r.typed === 3 ? { typed: 11 } : {}) })))
    expect(routesOf(same)[0]).toMatchObject({ goal: 'start a new message to [email] with the subject kes', n: 3 })
    // One run alone keeps its words; "start a new" (11) around other words in another run's goal is no fit either.
    expect(routesOf(draft('s1', 'kestrel 214'))[0].goal).toBe('start a new message to [email] with the subject kestrel 214, then')
  })

  it('a refused step stops the replay and hands the rest back with what happened', async () => {
    const t = tools({ answers: [{ outcome: 'performed' }, { outcome: 'refused', reason: 'secure-field' }] })
    const out = await t.act.execute({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] }, t.exec())
    expect(out).toMatch(/^Replayed the route learned in Pages for "new note" \(3 clean runs before\), 2 steps\. It stopped at step 2: what happened is below\. The replay is over; go on yourself from the window as it is now\.\n1\. Press "New Note" in Pages: done\n2\. Set-value "Search" in Pages: "lunch": refused: secure-field/)
    expect(t.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ steps: 2, ran: 1, stopped: true })
    const first = tools({ answers: [{ outcome: 'refused', reason: 'secure-field' }] })
    await expect(first.act.execute({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] }, first.exec())).rejects.toThrow(/^Replayed the route learned in Pages for "new note" \(3 clean runs before\), 2 steps\. It stopped at step 1: .*\n1\. Press "New Note" in Pages: refused: secure-field/s)
    expect(first.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ ran: 0, stopped: true })
  })

  // Run 250 (doc 30, answer 3): the mess task's one call was a replay. Its first step's after-look listed TextEdit's Save sheet over
  // the draft and said the line, but a chain's answer keeps only its last step's text, and the last step's look found it said.
  it('run 250: a sheet another app holds, in the steps\' after-looks, is said once in the replay\'s answer', async () => {
    const windows = [
      { processName: 'Pages', windowTitle: 'New Note', frame: [22, 61, 1200, 1086], front: true },
      { processName: 'TextEdit', windowTitle: 'Save', frame: [141, 218, 880, 448] },
      { processName: 'TextEdit', windowTitle: 'draft.txt', frame: [253, 150, 656, 422] },
    ]
    const t = tools({ windows })
    const out = await t.act.execute({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] }, t.exec())
    expect(out.split('TextEdit has a sheet you did not open in front of "draft.txt". Leave it alone and mention it in your answer.')).toHaveLength(2)
    expect(t.signals.filter((s) => s.type === 'screen:leftover-said'), 'one row').toHaveLength(1)
    expect(await t.act.execute({ app: 'Pages', goal: 'new note', route: true, values: ['lunch'] }, t.exec()), 'once per task').not.toContain('TextEdit has a sheet')
  })
})

describe('Review S5R1 L4: a route that is neither true nor an id', () => {
  it('is refused with the shape to send, at the ask and at the run, never dropped into a plain call', async () => {
    for (const route of ['true', 'R12345', { id: 'r12345' }, 7]) {
      const t = tools()
      const said = /^invalid arguments: route is true \(the goal names the route\) or the route's id as "Worked here before" lists it \("r12345"\), not /
      expect((await t.ask({ app: 'Pages', goal: 'new note', route })).error).toMatch(said)
      await expect(t.act.execute({ app: 'Pages', goal: 'new note', route }, t.exec())).rejects.toThrow(said)
      expect(t.sent.filter((c) => c.type === 'act')).toEqual([])
    }
  })

  it('no route, false or an empty one is a plain call as before', async () => {
    for (const route of [undefined, null, false, '', ' ']) expect((await tools().ask({ app: 'Pages', goal: 'new note', route, steps: [{ action: 'press', label: 'New Note' }] })).error ?? '').not.toMatch(/route is true/)
  })
})
