// S6 (doc 30, runs 250 to 253): keys and typed text never reached the out-of-process Save panel; clicks, presses and set-value did.
// save-as and go-to-folder walk the panel by its sidebar and folder columns, with no key. Made-up values only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lookForLog } from '../../packages/harness-runtime/src/app-channel.ts'
import { finalOf, judgedPlans } from './gate-finals.js'
import { panelGo } from './screen-save.js'
import { planAll, screenTools } from './screen-tools.js'

const BASE = realpathSync(mkdtempSync(join(tmpdir(), 'gnomon-x-')))
const DIR = join(BASE, 'Testbox', 'Outbox')
mkdirSync(DIR, { recursive: true })
afterAll(() => rmSync(BASE, { recursive: true, force: true }))
const NAME = 'Brief Kestrel.txt'

/**
 * A Save panel over the folder tree on disk: its columns run from `top` down to the folder it shows (`at`), each listing the next
 * folder of DIR's path when it is on it, and a decoy, Juniper. The sidebar holds the start-up disk. `deaf`: folder cells a click
 * does not open. `stiff`: folder cells a single click does not open and a double-click does. `collapsed`: no columns until its
 * "show more options" is pressed.
 */
function panel({ top, at = top, collapsed = false, deaf = [], stiff = [] }) {
  const parts = DIR.split('/').filter(Boolean)
  const kids = (path) => [...(DIR.startsWith(path === '/' ? '/' : `${path}/`) ? [parts[path.split('/').filter(Boolean).length]] : []), 'Juniper']
  const s = { first: top, at, open: !collapsed, name: 'Untitled.txt', n: 0 }
  const chain = () => {
    const out = [s.first]
    while (out.at(-1) !== s.at) out.push(join(out.at(-1), s.at.slice(out.at(-1).length).split('/').filter(Boolean)[0]))
    return out
  }
  const look = (id = `look-${String(++s.n).padStart(8, '0')}`) => ({
    id, app: 'TextEdit', window: 'Brief Kestrel.txt', dialog: true, focused: 'e2', menus: [],
    elements: [
      { ref: 'e0', role: 'AXStaticText', label: '', value: 'Save As:', in: 'save', frame: [340, 180, 60, 18] },
      { ref: 'e2', role: 'AXTextField', label: '', value: s.name, in: 'save', settable: true, enabled: true, frame: [420, 180, 240, 22], actions: ['AXConfirm'] },
      { ref: 'e3', role: 'AXTextField', label: 'tag editor', value: '', in: 'save', settable: true, enabled: true, frame: [420, 210, 240, 22] },
      { ref: 'w1', role: 'AXPopUpButton', label: 'Where:', value: s.at === '/' ? 'Macintosh HD' : basename(s.at), in: 'save', enabled: true, frame: [420, 240, 200, 26], actions: ['AXPress'] },
      { ref: 's1', role: 'AXRow', sub: 'AXOutlineRow', label: 'Macintosh HD', in: 'sidebar', enabled: true, frame: [80, 500, 190, 32], actions: ['AXShowDefaultUI'] },
      ...(s.open
        ? chain().flatMap((path, i) => kids(path).map((name, k) => ({ ref: `c${i}-${name}`, role: 'AXTextField', label: '', value: name, in: 'column view', enabled: true, settable: true, frame: [100 * (i + 1), 300 + 22 * k, 80, 18], actions: ['AXOpen', 'AXConfirm'] })))
        : [{ ref: 'd1', role: 'AXDisclosureTriangle', label: 'show more options', value: '0', in: 'save', enabled: true, frame: [640, 240, 26, 26], actions: ['AXPress'] }]),
      { ref: 'e8', role: 'AXButton', label: 'Cancel', in: 'save', enabled: true, frame: [770, 560, 80, 26], actions: ['AXPress'] },
      { ref: 'e1', role: 'AXButton', label: 'Save', in: 'save', enabled: true, frame: [860, 560, 80, 26], actions: ['AXPress'] },
    ],
  })
  const act = ({ ref, action, value, count = 1 }) => {
    if (ref === 's1') Object.assign(s, { first: '/', at: '/' })
    else if (ref === 'd1') s.open = true
    else if (ref === 'e2' && action === 'set-value') s.name = value
    else if (/^c\d+-/.test(String(ref))) {
      const [, i, name] = /^c(\d+)-(.*)$/.exec(ref)
      if (!deaf.includes(name) && (count > 1 || !stiff.includes(name))) s.at = join(chain()[Number(i)], name)
    }
  }
  return { look, act, s }
}
/** panelGo on a fake panel: what it sent, and its answer. */
async function walk(w, given = { value: DIR, name: NAME }, signal) {
  const sent = []
  const out = await panelGo({ verb: 'panel-go', app: 'TextEdit', thing: { name: given.value }, command: {}, given }, { act: async (p) => (sent.push([p.verb, p.thing.name, p.command.action, p.unkept, ...(p.command.count ? [p.command.count] : [])]), w.act(p.command), {}), lookIn: async () => w.look(), signal })
  return { sent, out }
}

describe('panelGo: the panel walked to the folder by clicks, no key', () => {
  it('the columns show the parent: a click on the folder, the name by set-value, each checked by a fresh look', async () => {
    const w = panel({ top: BASE, at: join(BASE, 'Testbox') })
    const { sent, out } = await walk(w)
    expect(sent).toEqual([['click', 'Outbox', 'click', true], ['set-value', 'Untitled.txt', 'set-value', true]])
    expect(out).toEqual({ same: false, text: '', note: `The TextEdit panel shows "Outbox", after a click on "Outbox", the name "${NAME}" set` })
    expect(w.s).toMatchObject({ at: DIR, name: NAME })
  })

  it('already there with the name: nothing sent', async () => {
    const w = panel({ top: join(BASE, 'Testbox'), at: DIR })
    w.s.name = NAME
    const { sent, out } = await walk(w)
    expect(sent).toEqual([])
    expect(out.note).toBe(`The TextEdit panel shows "Outbox" already, the name "${NAME}" set`)
  })

  it('the panel shows nothing of the path: its sidebar\'s start-up disk, then every folder down', async () => {
    const w = panel({ top: '/Juniper' })
    const { sent, out } = await walk(w, { value: DIR })
    expect(sent[0]).toEqual(['click', 'Macintosh HD', 'click', true])
    expect(sent.slice(1).map(([, name]) => name)).toEqual(DIR.split('/').filter(Boolean))
    expect(out.refused).toBeUndefined()
    expect(w.s.at).toBe(DIR)
  })

  it('a collapsed panel: its "show more options" pressed first', async () => {
    const w = panel({ top: BASE, at: join(BASE, 'Testbox'), collapsed: true })
    const { sent } = await walk(w)
    expect(sent[0]).toEqual(['press', 'show more options', 'AXPress', true])
    expect(w.s).toMatchObject({ at: DIR, name: NAME })
  })

  // Doc 32 (run 261 T21): a single click on a folder in the column browser selected it and opened nothing; a double-click opened it.
  it('doc 32: a click that does not open a folder is followed by a double-click, and the rest of the walk double-clicks', async () => {
    const w = panel({ top: '/Juniper', stiff: DIR.split('/').filter(Boolean).slice(1) })
    const { sent, out } = await walk(w)
    const [, first, ...rest] = DIR.split('/').filter(Boolean)
    expect(sent.slice(0, 4)).toEqual([['click', 'Macintosh HD', 'click', true], ['click', DIR.split('/')[1], 'click', true], ['click', first, 'click', true], ['click', first, 'click', true, 2]])
    expect(sent.slice(4, -1)).toEqual(rest.map((name) => ['click', name, 'click', true, 2]))
    expect(out.refused).toBeUndefined()
    expect(out.note).toContain(`then ${JSON.stringify(first)}, then ${JSON.stringify(first)} (a double-click), then ${JSON.stringify(rest[0])} (a double-click)`)
    expect(w.s).toMatchObject({ at: DIR, name: NAME })
  })

  it('stops with a line, and nothing after it runs: a click and a double-click that open nothing, no such folder, no panel, the owner\'s Stop', async () => {
    const deaf = await walk(panel({ top: BASE, at: join(BASE, 'Testbox'), deaf: ['Outbox'] }))
    expect(deaf.out).toEqual({ refused: `refused: the TextEdit panel did not get to ${JSON.stringify(DIR)}, so the file was not saved (a double-click on "Outbox" did not open it). No key was sent. Look at TextEdit and tell the owner; its Where pop-up may list the folder.`, reason: 'panel-folder' })
    expect(deaf.sent).toEqual([['click', 'Outbox', 'click', true], ['click', 'Outbox', 'click', true, 2]])
    expect((await walk(panel({ top: BASE }), { value: join(BASE, 'Nope') })).out.refused).toMatch(/\(there is no such folder on disk, and a save-as never makes one\)/)
    const shut = panel({ top: BASE })
    const none = await walk({ ...shut, look: () => ({ ...shut.look(), dialog: false }) })
    expect(none.out.refused).toMatch(/\(no Save or Open panel is in front\)/)
    const stopped = new AbortController()
    stopped.abort()
    const s = await walk(panel({ top: BASE, at: join(BASE, 'Testbox') }), undefined, stopped.signal)
    expect(s.out.refused).toMatch(/stopped: the owner stopped the turn/)
    expect(s.sent).toEqual([])
  })
})

// The plan and the gate. A plain document and a shown panel, as screen-save.test.js has them.
const STATE = { config: { experiments: { screenAct: true } }, marks: { now: [], guideTally: {} } }
const DOC = { id: 'look-0000d0c5', app: 'TextEdit', window: 'Brief Kestrel.txt', dialog: false, focused: 'e9', menus: ['TextEdit', 'File'], elements: [{ ref: 'e9', role: 'AXTextArea', label: '', value: 'Kestrel notes', frame: [0, 60, 800, 600], enabled: true, settable: true }] }
const SHOWN = { ...panel({ top: BASE, at: join(BASE, 'Testbox') }).look('look-0000beef') }
const seenAs = (look, more = {}) => [{ ...STATE, config: { experiments: { ...STATE.config.experiments, ...more } }, marks: { ...STATE.marks, lastLook: { id: look.id, app: look.app } } }, async () => lookForLog(look)]
const verbs = (plans) => plans.map((p) => [p.verb, p.thing.name])
const TO = join(DIR, NAME)

describe('save-as and go-to-folder send no key unless experiments.screenPanelKeys', () => {
  it('a panel in the look: panel-go, then Save; a plain document: open-panel first; go-to-folder: panel-go alone', async () => {
    const out = await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, ...seenAs(SHOWN))
    expect(verbs(out.plans)).toEqual([['panel-go', DIR], ['press', 'Save']])
    expect(out.plans[0]).toMatchObject({ line: `Go to ${JSON.stringify(DIR)} in the TextEdit panel by its sidebar and folder columns, and name the file "${NAME}"`, given: { value: DIR, name: NAME } })
    expect(out.plans[1].given.saveTo).toBe(TO)
    expect(verbs((await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, ...seenAs(DOC))).plans)).toEqual([['open-panel', 'Save panel'], ['panel-go', DIR], ['press', 'Save']])
    expect(verbs((await planAll({ app: 'TextEdit', steps: [{ action: 'go-to-folder', value: DIR }] }, ...seenAs(DOC))).plans)).toEqual([['panel-go', DIR]])
    // The flag brings the keys back.
    expect((await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: TO }] }, ...seenAs(SHOWN, { screenPanelKeys: true }))).plans[0].command.value).toBe('cmd+shift+g')
  })

  it('doc 31 (run 255 T21): a cmd+shift+g, path, Return chain sent to a shown panel is the walk, with no key and no ask', async () => {
    const chain = (type = 'type') => ({ app: 'TextEdit', steps: [{ action: 'set-value', ref: 'e2@beef', value: NAME, replace: true }, { action: 'key', value: 'cmd+shift+g' }, { action: type, ...(type === 'set-value' ? { ref: 'e2@beef' } : {}), value: DIR }, { action: 'key', value: 'return' }] })
    const out = await planAll(chain(), ...seenAs(SHOWN))
    expect(verbs(out.plans)).toEqual([['set-value', 'e2'], ['panel-go', DIR]])
    expect(finalOf('screen_act', chain(), undefined, judgedPlans(out.plans, SHOWN))).toBeNull()
    expect(verbs((await planAll({ app: 'TextEdit', steps: chain('set-value').steps.slice(1) }, ...seenAs(SHOWN))).plans)).toEqual([['panel-go', DIR]])
    // With the flag on, or no panel in the app's last look, the keys stay keys.
    expect(verbs((await planAll(chain(), ...seenAs(SHOWN, { screenPanelKeys: true }))).plans).map(([v]) => v)).toEqual(['set-value', 'key', 'key', 'type', 'key'])
    expect(verbs((await planAll({ app: 'TextEdit', steps: chain().steps.slice(1) }, ...seenAs(DOC))).plans).map(([v]) => v)).toEqual(['key', 'key', 'type', 'key'])
  })

  it('the gate: a new file is no final, in a shown panel or after open-panel; a file that is there asks as an overwrite', async () => {
    const judge = async (to, look) => {
      const { plans } = await planAll({ app: 'TextEdit', steps: [{ action: 'save-as', value: to }] }, ...seenAs(look))
      return finalOf('screen_act', { app: 'TextEdit', action: 'save-as', value: to }, undefined, judgedPlans(plans, look))
    }
    expect(await judge(TO, SHOWN)).toBeNull()
    expect(await judge(TO, DOC)).toBeNull()
    writeFileSync(join(DIR, 'Juniper.txt'), 'juniper')
    expect(await judge(join(DIR, 'Juniper.txt'), SHOWN)).toMatchObject({ kind: 'overwrite', what: `Save, over the file already at ${join(DIR, 'Juniper.txt')}` })
    expect(await judge(join(DIR, 'Juniper.txt'), DOC)).toMatchObject({ kind: 'overwrite' })
  })
})

/** screen_act over the fake panel, its last look the panel: each act goes to it, each look reads it. */
function saving(w) {
  const [sent, rows] = [[], {}]
  const state = { config: { experiments: { screenAct: true } }, window: { active: { processName: 'TextEdit', windowTitle: 'Brief Kestrel.txt', windowId: 'w1' } }, marks: { now: [], guideTally: {} } }
  const shown = (id, more = {}) => {
    rows[id] = { ...lookForLog(w.look(id)), ...more }
    state.marks.lastLook = { id, app: 'TextEdit', ...more }
  }
  shown('look-00000001')
  const send = (c) => {
    sent.push(c.type === 'act' ? [c.action, c.target?.label ?? c.value ?? c.ref].filter(Boolean).join(' ') : c.type)
    if (c.type === 'look') return shown(c.id)
    if (c.type !== 'act') return
    w.act(c)
    state.marks.lastAct = { id: c.id, outcome: 'performed' }
    shown(`look-after-${c.id}`, { after: c.id })
  }
  const readRow = async (id, { field = 'id' } = {}) => Object.values(rows).findLast((row) => row[field] === id) ?? null
  const [, , act] = screenTools(async () => {}, () => state, send, readRow, async () => [], { proofMs: 20 })
  return { sent, run: (args) => act.execute(args).then((v) => v, (e) => e.message) }
}

describe('screen_act: save-as in a shown panel', () => {
  it('a click down to the folder, the name by set-value, then Save: no key', async () => {
    const w = panel({ top: BASE, at: join(BASE, 'Testbox') })
    const t = saving(w)
    const out = await t.run({ app: 'TextEdit', action: 'save-as', value: TO })
    expect(t.sent.filter((s) => s !== 'look')).toEqual(['click c1-Outbox', `set-value ${NAME}`, 'AXPress e1'])
    expect(out).toMatch(new RegExp(`^1\\. Go to .* in the TextEdit panel by its sidebar and folder columns, and name the file "${NAME}": done\\. The TextEdit panel shows "Outbox", after a click on "Outbox", the name "${NAME}" set\\n2\\. `))
  }, 15_000)

  it('a folder that does not open: the chain stops before Save, and says so', async () => {
    const t = saving(panel({ top: BASE, at: join(BASE, 'Testbox'), deaf: ['Outbox'] }))
    const out = await t.run({ app: 'TextEdit', action: 'save-as', value: TO })
    expect(t.sent.filter((s) => s !== 'look')).toEqual(['click c1-Outbox', 'click c1-Outbox'])
    expect(out).toMatch(/: refused: the TextEdit panel did not get to .*, so the file was not saved \(a double-click on "Outbox" did not open it\)/)
    expect(out).toMatch(/Stopped at step 1: step 2 did not run\./)
  }, 15_000)
})
