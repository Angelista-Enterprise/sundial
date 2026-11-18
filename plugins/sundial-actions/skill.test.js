// Set 2 Round 3 item 1: a skill the owner kept runs by its name, all its steps in one screen_act call through the gate.
// Every value is made up.
import { readFileSync } from 'node:fs'
import { routeIdOfKey, routeKeyOf, routesOf, skillLabel } from '@sundial/helpers/screen-routes.js'
import { resolveActionPolicy } from '@sundial/helpers/sundial-config.js'
import { describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { callFacts, decideAction, finalOf } from './gate.js'
import { routeBySkill } from './screen-pick.js'
import { screenAsk, screenTools } from './screen-tools.js'
import { skillTool } from './skill.js'

const { type: _t, at: _a, ...LINE } = JSON.parse(readFileSync(new URL('./screen-look.fixture.json', import.meta.url), 'utf8'))
const ROW = lookForLog(LINE)
const AUTO = { internal: { default: 'auto', byTool: {} }, outward: { default: 'auto', byTool: {} } }

/** One clean run per session: press New Note, then type into Search. */
const run = (session, app = 'Pages') => [
  { at: `2026-11-1${session.length}T09:00:00Z`, session, goal: 'new note', processName: app, verb: 'press', role: 'button', screenText: ['New Note'], ok: true, changed: true },
  { at: `2026-11-1${session.length}T09:00:02Z`, session, goal: 'new note', processName: app, verb: 'set-value', role: 'search field', screenText: ['Search'], typed: 5, ok: true, changed: true },
]
const NOTE = 'press button "New Note" > set-value search field "Search"'
const kept = (routeKey, app = 'Pages', more = {}) => ({ app, routeKey, at: '2026-11-14T09:00:00Z', ...more })

/**
 * The tool over a fake record and a fake dsh pipeline that gates screen_act as index.js does in test mode, under the
 * most open preset: a plain step runs unasked, a final asks (`asks`), and the owner's answer is `yes`.
 */
function rig({ rows = run('s1'), skills = { 'new note': kept(NOTE) }, state: extra = {}, answers = [], yes = true } = {}) {
  const signals = []
  const sent = []
  const asks = []
  const calls = []
  const looks = { [ROW.id]: ROW }
  const state = { config: { experiments: {} }, marks: { now: [], guideTally: {}, lastLook: { id: ROW.id, app: 'Pages', n: 4 } }, selfReview: { skills }, ...extra }
  const send = (command) => {
    sent.push(command)
    if (command.type !== 'act') return
    const said = answers[sent.filter((c) => c.type === 'act').length - 1] ?? { outcome: 'performed' }
    state.marks.lastAct = { id: command.id, ...said }
    if (said.outcome !== 'performed') return
    looks[`look-after-${command.id}`] = { ...ROW, id: `look-after-${command.id}`, after: command.id, windowTitle: 'New Note' }
    state.marks.lastLook = { id: `look-after-${command.id}`, after: command.id, app: 'Pages', n: 4 }
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(looks).findLast((row) => row[field] === id) ?? null
  const appendSignal = async (type, payload) => signals.push({ type, ...payload })
  const [, , act] = screenTools(appendSignal, () => state, send, readRow, async () => [], {})
  const execute = async (req) => {
    calls.push(req)
    const args = req.arguments
    const plan = await screenAsk('screen_act', args, state, readRow, null, [], req.agent.session.id)
    if (plan.error) return { isError: true, error: { message: plan.error } }
    const facts = callFacts({ toolName: 'screen_act', args, plans: plan.plans })
    const decision = decideAction({ toolName: 'screen_act', args, preset: 'danger-full-access', actions: AUTO, resolveActionPolicy, testMode: true, facts })
    if (decision.kind === 'ask' && !(facts.final === null && plan.line)) {
      asks.push(finalOf('screen_act', args, () => null, plan.plans)?.kind ?? 'plain')
      if (!yes) return { isError: true, error: { message: 'The owner said no.' } }
    }
    try {
      return { content: [{ type: 'text', text: await act.execute(args, req) }] }
    } catch (error) {
      return { isError: true, error: { message: error.message } }
    }
  }
  const tool = skillTool({ tools: { execute }, getState: () => state, readSteps: async (app) => rows.filter((r) => r.processName === app), appendSignal })
  const go = (args, session = 'own') => tool.execute(args, { callId: 'c1', agent: { session: { id: session, snapshotEvents: () => [] } } })
  return { go, signals, sent, asks, calls }
}

describe('gnomon_skill (Set 2 R3)', () => {
  it('a kept skill replays by name in one screen_act call, its blank filled, and the replayed row names it', async () => {
    const t = rig()
    const out = await t.go({ name: 'Run "New Note"', blanks: ['lunch'] })
    expect(out).toMatch(/^Ran the skill r\d{5} "new note" in Pages, 2 steps\.\n1\. Press "New Note" in Pages: done\n2\. Set-value "Search" in Pages: "lunch"/)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].arguments).toMatchObject({ app: 'Pages', goal: 'new note', steps: [{ action: 'press', role: 'button', label: 'New Note' }, { action: 'set-value', role: 'search field', label: 'Search', value: 'lunch' }] })
    expect(t.sent.filter((c) => c.type === 'act')).toHaveLength(2)
    expect(t.asks).toEqual([])
    expect(t.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ skill: expect.stringMatching(/^r\d{5} "new note"$/), processName: 'Pages', steps: 2, ran: 2, stopped: false, session: 'own' })
  })

  it('blanks fill the typing places and the typed words after them; a missing one is asked for by its place', async () => {
    const song = (session, name) => [
      { at: `2026-11-1${session.length}T09:00:00Z`, session, goal: `queue ${name.toLowerCase()}`, processName: 'Spotify', verb: 'set-value', role: 'search field', screenText: ['Search'], typed: name.length, ok: true, changed: true },
      { at: `2026-11-1${session.length}T09:00:02Z`, session, goal: `queue ${name.toLowerCase()}`, processName: 'Spotify', verb: 'press', role: 'button', screenText: [`Play ${name}`], ok: true, changed: true },
    ]
    const rows = song('s1', 'Blue Train')
    const routeKey = routeKeyOf(routesOf(rows)[0].steps)
    expect(routeBySkill({ app: 'Spotify', name: 'queue blue train', routeKey, values: ['Naima'], rows })).toEqual({ goal: 'queue Naima', key: 'queue <what was typed>', n: 1, by: 'skill', steps: [{ action: 'set-value', role: 'search field', label: 'Search', value: 'Naima' }, { action: 'press', role: 'button', label: 'Play Naima' }] })
    await expect(rig().go({ name: 'new note' })).rejects.toThrow('invalid arguments: the route for "new note" types in 1 place ("Search"): send "values": {"Search": "<its text>"}, one text each, taken from this task')
  })

  it('a final in a skill still asks in test mode under the most open preset, and a no stops it with nothing run', async () => {
    const rows = [{ at: '2026-11-14T09:00:00Z', session: 's1', goal: 'clear the list', processName: 'Pages', verb: 'press', role: 'button', screenText: ['Remove'], ok: true, changed: true }]
    const skills = { 'clear the list': kept('press button "Remove"') }
    const t = rig({ rows, skills })
    await t.go({ name: 'clear the list' })
    expect(t.asks).toEqual(['delete'])
    const no = rig({ rows, skills, yes: false })
    await expect(no.go({ name: 'clear the list' })).rejects.toThrow(/^Ran the skill r\d{5} "clear the list" in Pages, 1 step\. It stopped at step 1: .*\nThe owner said no\./s)
    expect(no.sent.filter((c) => c.type === 'act')).toEqual([])
    expect(no.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ skill: expect.stringMatching(/^r\d{5} "clear the list"$/), ran: 0, stopped: true })
  })

  it('a refused step stops the skill and hands the turn back with what happened', async () => {
    const t = rig({ answers: [{ outcome: 'performed' }, { outcome: 'refused', reason: 'secure-field' }] })
    const out = await t.go({ name: 'new note', blanks: ['lunch'] })
    expect(out).toMatch(/^Ran the skill r\d{5} "new note" in Pages, 2 steps\. It stopped at step 2: what happened is below\. The replay is over; go on yourself from the window as it is now\.\n1\. Press "New Note" in Pages: done\n2\. Set-value "Search" in Pages: "lunch": refused: secure-field/)
    expect(t.signals.find((s) => s.type === 'screen:replayed')).toMatchObject({ skill: expect.stringMatching(/^r\d{5} "new note"$/), ran: 1, stopped: true })
    const first = rig({ answers: [{ outcome: 'refused', reason: 'secure-field' }] })
    await expect(first.go({ name: 'new note', blanks: ['lunch'] })).rejects.toThrow(/It stopped at step 1: .*refused: secure-field/s)
  })

  it('an unknown name answers plainly with the kept names, or that none is kept', async () => {
    await expect(rig().go({ name: 'open mail' })).rejects.toThrow(/^No kept skill is called "open mail"\. The kept skills: r\d{5} "new note"\.$/)
    await expect(rig({ skills: {} }).go({ name: 'open mail' })).rejects.toThrow('No kept skill is called "open mail". The owner has kept no skill yet.')
  })

  it('a rig skill, or a route only the rig ran, is never offered in the owner\'s chat; a private app is refused', async () => {
    const rigSessions = { 'rig-run': '2026-11-15T08:00:00Z' }
    const t = rig({ rows: run('rig-run'), skills: { 'new note': kept(NOTE), 'rig chore': kept(NOTE, 'Pages', { rig: true }) }, state: { rigSessions } })
    await expect(t.go({ name: 'rig chore', blanks: ['x'] })).rejects.toThrow(/^No kept skill is called "rig chore"\. The kept skills: r\d{5} "new note"\.$/)
    expect(await t.go({ name: 'rig chore', blanks: ['x'] }, 'rig-run')).toMatch(/^Ran the skill r\d{5} "rig chore" in Pages/)
    // Symmetric: the rig's chat runs the rig's skills only, from the rig's own runs only.
    await expect(t.go({ name: 'new note', blanks: ['x'] }, 'rig-run')).rejects.toThrow(/^No kept skill is called "new note"\. The kept skills: r\d{5} "rig chore"\.$/)
    const ownRows = rig({ skills: { 'rig chore': kept(NOTE, 'Pages', { rig: true }) }, state: { rigSessions } })
    await expect(ownRows.go({ name: 'rig chore', blanks: ['x'] }, 'rig-run')).rejects.toThrow('the route of the skill "rig chore" is not in the record of Pages any more')
    const rigRows = rig({ rows: run('rig-run'), state: { rigSessions } })
    await expect(rigRows.go({ name: 'new note', blanks: ['x'] })).rejects.toThrow('the route of the skill "new note" is not in the record of Pages any more')
    const priv = rig({ rows: run('s1', 'Messages'), skills: { 'new note': kept(NOTE, 'Messages') } })
    await expect(priv.go({ name: 'new note', blanks: ['x'] })).rejects.toThrow(/^refused: Messages is a private app: no skill runs there\./)
    expect(priv.calls).toEqual([])
  })

  it('Set 5 R1: a kept skill is named by its id and clean name, never its old values, and runs by that id as name or route', async () => {
    const old = 'new note titled kestrel 214'
    const id = routeIdOfKey('Pages', NOTE)
    expect(skillLabel('Pages', old, NOTE)).toBe(`${id} "new note"`)
    expect(skillLabel('Pages', '[email] 214', NOTE)).toBe(id)
    const t = rig({ skills: { [old]: kept(NOTE) } })
    await expect(t.go({ name: 'open mail' })).rejects.toThrow(`The kept skills: ${id} "new note".`)
    expect(await t.go({ name: id, values: { Search: 'lunch' } })).toMatch(new RegExp(`^Ran the skill ${id} "new note" in Pages, 2 steps\\.`))
    expect(await t.go({ app: 'Pages', route: id, blanks: ['lunch'] })).toMatch(new RegExp(`^Ran the skill ${id} "new note"`))
    expect(t.signals.filter((s) => s.type === 'screen:replayed').map((s) => [s.by, s.skill])).toEqual([['skill', `${id} "new note"`], ['skill', `${id} "new note"`]])
    expect(JSON.stringify(t.calls)).not.toMatch(/kestrel|214/)
  })
})
